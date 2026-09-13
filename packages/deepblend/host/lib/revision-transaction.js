/**
 * Revision transaction — the atomic commit path (SPEC §13.2).
 *
 * ```
 * validate the patch
 *   → resolve the idempotency key            (a retry must not apply twice)
 *   → check baseRevision against current     (a stale write must not overwrite)
 *   → apply operations to the stored SceneSpec in memory
 *   → JSON-Schema + semantic validation
 *   → compile in Blender into staging/
 *   → technical validation of the compiled scene
 *   → write the revision manifest
 *   → atomic rename staging → revisions/<id>
 *   → move the current pointer
 *   → record the idempotency outcome
 * ```
 *
 * WHY NOTHING IS WRITTEN IN PLACE
 * -------------------------------
 * Every mutation happens either in memory or inside `<project>/staging/<rev>/`.
 * The revision directory appears, fully formed, from a single `rename`. So the
 * failure modes the SPEC cares about are structural rather than remembered:
 *
 *  - "失败不污染当前 Revision" holds because the current revision's directory is
 *    never opened for writing at all — not because an error handler cleans up.
 *  - "不产生半提交 Revision" holds because a directory that has not been renamed
 *    is not a revision.
 *  - A crash leaves at most a staging directory, which `sweepStaging()` removes
 *    and which no reader ever consults.
 *
 * ORDERING: THE POINTER MOVES LAST
 * --------------------------------
 * `project.json` is updated only after the revision directory is published. The
 * two writes are not one transaction, so one of them can be interrupted — and the
 * order decides which interruption is survivable. Publishing then failing to move
 * the pointer leaves an unreferenced but complete revision: visible, correct, and
 * one `restoreRevision` away from usable. Moving the pointer first would leave a
 * current revision that does not exist, which is unrecoverable.
 *
 * Owner: DeepBlend Studio — M1
 * Plane: Host composition
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  BlenderError,
  BlenderErrorCode,
  BlenderWarningCode,
  PROJECT_RECORD_VERSION,
  REVISION_MANIFEST_VERSION,
  SCENE_PATCH_VERSION,
  applyPatchToSpec,
  buildOperationManifest,
  compileSceneSpec,
  sceneSpecCanonicalText,
  sceneSpecDigest,
  shortDigest,
  specHash,
  summarizeSceneSpec,
  toCanonicalFailure,
  validateScenePatch,
  validateSceneSpec,
  warning,
} from '@deepblend/dsh-blender-contracts'
import { GENESIS_REVISION, parseRevisionId } from './project-store.js'
import {
  fileSha256,
  fileSize,
  isFile,
  publishDirectory,
  removeTree,
  writeFileAtomic,
  writeJsonAtomic,
} from './paths.js'

/**
 * Derive the idempotency key for a patch when the caller did not supply one.
 *
 * This is a deliberate departure from "require the caller to invent a key", and
 * it is a safety improvement rather than a convenience. A model retrying a tool
 * call it is unsure about is NORMAL behaviour, and a scheme that made identical
 * retries create duplicate revisions would punish exactly the cautious caller.
 *
 * The derived key covers the whole logical intent: the project, the revision the
 * patch was computed against, who asked, and every operation. So:
 *   - an identical retry produces the same key and returns the recorded outcome
 *     without re-applying anything (SPEC §20 M1 "同一幂等键不会重复提交");
 *   - a genuinely different patch produces a different key and applies normally,
 *     even against the same base revision;
 *   - the same operations against a LATER base revision also produce a different
 *     key, because they describe a different state and must not be conflated.
 *
 * A caller that wants to re-apply the same operations on purpose passes its own
 * `idempotencyKey` — which is also the only way to express that intent.
 *
 * @param {object} patch
 * @returns {string}
 */
export function deriveIdempotencyKey(patch) {
  return `auto-${shortDigest({
    projectId: patch.projectId,
    baseRevision: patch.baseRevision,
    actor: patch.actor ?? null,
    stage: patch.stage ?? null,
    operations: patch.operations,
  })}`
}

/**
 * Resolve a caller-supplied or derived idempotency key.
 * @param {object} patch
 * @returns {{ key: string, derived: boolean }}
 */
export function resolveIdempotencyKey(patch) {
  if (typeof patch.idempotencyKey === 'string' && patch.idempotencyKey.trim().length > 0) {
    return { key: patch.idempotencyKey, derived: false }
  }
  return { key: deriveIdempotencyKey(patch), derived: true }
}

/**
 * The revision transaction runner.
 *
 * One instance per `blenderStudio` service; it holds no state of its own beyond
 * the stores and the runtime it was built with, so a second project cannot leak
 * into the first.
 */
export class RevisionTransaction {
  /**
   * @param {object} options
   * @param {import('./project-store.js').ProjectStore} options.store
   * @param {object} options.runtime - the `blenderRuntime` service.
   * @param {{ compileTimeoutMs?: number, projectsRoot: string }} options.config
   */
  constructor({ store, runtime, config }) {
    this.store = store
    this.runtime = runtime
    this.config = config
  }

  /** The store's own account of what is current; never cached here. */
  currentRevision(projectId) {
    return this.store.currentRevision(projectId)
  }

  /**
   * Remove abandoned staging directories.
   *
   * Called before each transaction rather than on a timer: a staging directory
   * can only be abandoned by a process that died, and the next transaction is
   * exactly when we know we are alive and it is stale.
   *
   * @param {string} projectId
   * @param {string} [keep] - a staging directory to preserve (this transaction's).
   */
  sweepStaging(projectId, keep) {
    const staging = join(this.store.projectDirectory(projectId), 'staging')
    if (!existsSync(staging)) return
    for (const entry of readdirSafe(staging)) {
      if (entry === keep) continue
      removeTree(join(staging, entry))
    }
  }

  /**
   * Create a project by committing its first revision.
   *
   * `project_create` is not a separate kind of operation: a project without a
   * revision would be a directory with no scene, and every read path would then
   * need a special case for it. Committing r0001 immediately means the invariant
   * "a project has a current revision" holds from the moment it is visible.
   *
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.goal]
   * @param {object} [input.sceneSpec] - a full SceneSpec to seed the project with.
   * @param {string} [input.projectId] - an explicit id; derived from the title otherwise.
   * @param {boolean} [input.saveCheckpoint]
   * @param {boolean} [input.renderPreview]
   * @param {string} [input.jobId]
   * @param {AbortSignal} [input.signal]
   * @returns {Promise<{ projectId: string, record: object, revision: object, job: object, warnings: object[] }>}
   */
  async createProject(input) {
    const title = String(input.title ?? '').trim()
    if (title.length === 0) {
      throw new BlenderError(BlenderErrorCode.PROJECT_ID_INVALID, 'A project needs a non-empty title.')
    }

    const projectId = input.projectId ?? this.store.allocateProjectId(title)
    if (this.store.exists(projectId)) {
      throw new BlenderError(
        BlenderErrorCode.PROJECT_EXISTS,
        `A project named "${projectId}" already exists.`,
        { detail: { projectId } },
      )
    }

    const seeded = input.sceneSpec ?? defaultSceneSpec({ projectId, title, goal: input.goal })
    const identified = {
      ...seeded,
      project: { ...seeded.project, id: projectId, title, ...input.goal !== undefined ? { goal: input.goal } : {} },
    }

    const validation = validateSceneSpec(identified)
    if (!validation.ok) {
      throw new BlenderError(
        BlenderErrorCode.SCENE_SPEC_INVALID,
        `The initial SceneSpec for "${projectId}" is not valid:\n${validation.summary}`,
        { detail: { errors: validation.errors, notices: validation.notices } },
      )
    }

    // RESOLVE BEFORE STORING. This is not cosmetic: the first revision is the
    // spec every later revision is a delta from, so if it were stored unresolved
    // while its digest was computed from the resolved form, every read-back would
    // re-derive a DIFFERENT digest and the revision history would look corrupted.
    // That was a real bug here — `revision r0001 still re-reads and re-compiles
    // deterministically` in fixture.e2e.mjs is the guard that caught it.
    //
    // Resolving is idempotent (it only materialises documented defaults and aims
    // targeted cameras), so a spec that already went through it is unaffected.
    const compiled = compileSceneSpec(identified)

    this.store.ensureRoot()
    this.store.createSkeleton(projectId)

    const now = new Date().toISOString()
    this.store.writeRecord(projectId, {
      schemaVersion: PROJECT_RECORD_VERSION,
      projectId,
      title,
      goal: input.goal ?? null,
      createdAt: now,
      updatedAt: now,
      currentRevision: GENESIS_REVISION,
      revisionCount: 0,
      runtimeProtocolVersion: 'deepblend.blender/v1',
      projectsRoot: this.store.projectsRoot,
    })

    const outcome = await this.commit({
      projectId,
      baseRevision: GENESIS_REVISION,
      operations: [],
      spec: compiled.spec,
      specHashBefore: null,
      specHashAfter: specHash(compiled.spec),
      kind: 'project_create',
      summary: `Initialise project "${title}"`,
      actor: input.actor ?? null,
      stage: 'BRIEF',
      note: input.goal ?? null,
      notices: [...validation.notices, ...compiled.notices],
      saveCheckpoint: input.saveCheckpoint !== false,
      renderPreview: input.renderPreview === true,
      jobId: input.jobId,
      signal: input.signal,
    })

    return { projectId, ...outcome }
  }

  /**
   * Apply a ScenePatch as one atomic revision.
   *
   * @param {object} patch - a ScenePatch v1 document.
   * @param {{ jobId?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<object>}
   */
  async applyScenePatch(patch, options = {}) {
    const structural = validateScenePatch(patch)
    if (!structural.ok) {
      throw new BlenderError(
        BlenderErrorCode.SCENE_PATCH_INVALID,
        `The ScenePatch is not well formed:\n${structural.summary}`,
        { detail: { errors: structural.errors } },
      )
    }

    const projectId = patch.projectId
    const record = this.store.readRecord(projectId)
    const { key, derived } = resolveIdempotencyKey(patch)

    // ---------------------------------------------------------------------
    // ORDER MATTERS HERE: idempotency is checked BEFORE the conflict check.
    //
    // A caller that retries a patch it is unsure about is behaving well, and a
    // retry usually arrives AFTER the first attempt succeeded — which means the
    // project has already moved past the patch's `baseRevision`. Checking
    // conflict first would answer that retry with REVISION_CONFLICT, and the
    // caller's only move would be to re-read and re-apply, producing the exact
    // duplicate revision the idempotency key exists to prevent.
    //
    // Asking "have I already done exactly this?" first makes the retry return
    // its own earlier outcome, which is the honest answer: the work is done, and
    // here is what it produced.
    // ---------------------------------------------------------------------
    const recorded = this.store.readIdempotencyRecord(projectId, key)
    if (recorded !== null) {
      return {
        ...recorded.outcome,
        idempotentReplay: true,
        idempotencyKey: key,
        idempotencyKeyDerived: derived,
        warnings: [warning(
          BlenderWarningCode.SCENE_COMPILER_DECISION,
          `this exact patch was already applied as ${recorded.outcome.revision?.revision ?? recorded.outcome.revision} ` +
            `at ${recorded.recordedAt}; the recorded outcome was returned and nothing was committed again`,
          { revision: recorded.outcome.revision?.revision ?? recorded.outcome.revision, recordedAt: recorded.recordedAt },
        )],
        replayOf: recorded.outcome.revision?.revision ?? recorded.outcome.revision,
      }
    }

    // ---- conflict: a stale view is refused, never merged -------------------
    if (patch.baseRevision !== record.currentRevision) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CONFLICT,
        `The patch was computed against ${patch.baseRevision} but "${projectId}" is at ${record.currentRevision}. ` +
          'Read the scene again and re-apply against the current revision — this revision is refused rather than merged, ' +
          'because merging silently would discard whatever changed in between.',
        {
          detail: {
            projectId,
            baseRevision: patch.baseRevision,
            currentRevision: record.currentRevision,
            hint: 'call blender_scene_get, then re-issue the patch with the returned revision as baseRevision',
          },
        },
      )
    }

    const baseSpec = this.store.readRevisionSpec(projectId, record.currentRevision)
    const compiled = compileSceneSpec(baseSpec)

    // ---- apply in memory ---------------------------------------------------
    /** @type {object} */
    let nextSpec
    /** @type {object[]} */
    let operationRecords
    let digestBefore
    let digestAfter
    let specHashBefore
    let specHashAfter
    try {
      const applied = applyPatchToSpec(compiled.spec, patch)
      nextSpec = applied.spec
      operationRecords = applied.operations
      digestBefore = applied.digestBefore
      digestAfter = applied.digestAfter
      specHashBefore = applied.specHashBefore
      specHashAfter = applied.specHashAfter
    } catch (cause) {
      const failure = toCanonicalFailure(cause, { isBlenderError: value => value instanceof BlenderError, fallbackCode: 'SCENE_PATCH_REJECTED' })
      throw new BlenderError(
        failure.code === 'SCENE_PATCH_REJECTED' ? BlenderErrorCode.SCENE_PATCH_REJECTED : failure.code,
        `The patch was rejected and no revision was created: ${failure.message}`,
        { detail: { projectId, baseRevision: patch.baseRevision, path: failure.detail?.path ?? null } },
      )
    }

    // ---- resolve the RESULT before anything reads it -----------------------
    //
    // The base was compiled above, but the patch result was not — and every `*.add`
    // operation inserts the caller's object verbatim. So a patch could store a
    // document that no other part of the system is prepared to read:
    //
    //   `camera.add` without `transform`  → `summarizeSceneSpec` threw a TypeError on
    //     `camera.transform.location`, taking the whole commit response down with it.
    //   `entity.add` with a generator that omits its shape's size field — legal, both
    //     are optional — left `boundsOf` computing `undefined * n` = NaN, and a NaN
    //     reaches the model as `null` because that is what JSON does to it. The tool
    //     call SUCCEEDED and the harness rejected its own result as "not lossless
    //     JSON", which is precisely the symptom of a NaN.
    //   And the property M1 exists to guarantee — digest(stored) == digest(compile
    //     (stored)), so a revision can always be re-read and re-derived — was false
    //     for every revision with an added object.
    //
    // Compiling here is the same fix M1 applied to `createProject` (decision D19),
    // for the same reason: whoever writes the document owns resolving it, because a
    // reader that has to guess is a reader that will guess differently.
    //
    // Compilation materialises DOCUMENTED defaults only, and is idempotent, so a
    // patch that adds nothing new is unaffected — the digest of an unrelated change
    // does not move.
    const resolved = compileSceneSpec(nextSpec)
    nextSpec = resolved.spec
    digestAfter = sceneSpecDigest(nextSpec)
    specHashAfter = specHash(nextSpec)

    const validation = validateSceneSpec(nextSpec)
    if (!validation.ok) {
      throw new BlenderError(
        BlenderErrorCode.SCENE_SPEC_INVALID,
        `Applying the patch would produce an invalid SceneSpec, so no revision was created:\n${validation.summary}`,
        { detail: { errors: validation.errors, notices: validation.notices } },
      )
    }

    const summary = patch.note ?? describeOperations(operationRecords)
    const outcome = await this.commit({
      projectId,
      baseRevision: patch.baseRevision,
      operations: patch.operations,
      spec: nextSpec,
      kind: 'scene_patch',
      summary,
      actor: patch.actor ?? null,
      stage: patch.stage ?? null,
      note: patch.note ?? null,
      saveCheckpoint: patch.saveCheckpoint !== false,
      renderPreview: patch.renderPreview === true,
      digestBefore,
      digestAfter,
      operationRecords,
      notices: [...validation.notices, ...compiled.notices, ...resolved.notices],
      derivedIdempotencyKey: derived,
      jobId: options.jobId,
      signal: options.signal,
    })

    this.store.writeIdempotencyRecord(projectId, key, {
      // The FULL outcome, not a pointer to it. A replay must be able to answer
      // exactly as the original call did — same revision, same previews, same
      // warnings — without re-deriving anything, because re-deriving is how a
      // "replay" quietly becomes a second apply.
      outcome: {
        projectId,
        revision: outcome.revision,
        revisionNumber: outcome.revision.revisionNumber,
        digest: outcome.revision.digest,
        summary,
        job: outcome.job,
        warnings: outcome.warnings,
        sceneSummary: outcome.sceneSummary,
      },
      kind: 'scene_patch',
    })

    return { ...outcome, idempotentReplay: false, idempotencyKey: key, idempotencyKeyDerived: derived }
  }

  /**
   * The shared commit path used by both `createProject` and `applyScenePatch`.
   *
   * @param {object} plan
   * @returns {Promise<{ revision: object, job: object, warnings: object[], sceneSummary: object }>}
   */
  async commit(plan) {
    const { projectId } = plan
    const record = this.store.readRecord(projectId)
    const revision = this.store.nextRevisionId(projectId)
    const revisionNumber = /** @type {number} */ (parseRevisionId(revision))

    this.sweepStaging(projectId)
    const staging = join(this.store.projectDirectory(projectId), 'staging', revision)
    removeTree(staging)
    mkdirSync(staging, { recursive: true })

    const jobId = plan.jobId ?? this.store.allocateJobId(projectId, plan.kind === 'project_create' ? 'compile_scene' : 'apply_scene_patch')
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    /** @type {object[]} */
    const warnings = []
    for (const notice of plan.notices ?? []) {
      if (notice.severity === 'notice') {
        warnings.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, notice.message, { code: notice.code, path: notice.path }))
      }
    }

    const writeJob = (fields) => {
      const job = {
        schemaVersion: 'deepblend.job/v1',
        jobId,
        projectId,
        action: plan.kind === 'project_create' ? 'compile_scene' : 'apply_scene_patch',
        revision: fields.revision ?? null,
        status: fields.status,
        errorCode: fields.errorCode ?? null,
        message: fields.message ?? null,
        startedAt,
        finishedAt: fields.status === 'running' ? null : new Date().toISOString(),
        durationMs: fields.status === 'running' ? null : Date.now() - startedMs,
        idempotencyKey: plan.derivedIdempotencyKey === false ? (plan.explicitIdempotencyKey ?? null) : null,
        baseRevision: plan.baseRevision,
        artifacts: fields.artifacts ?? [],
        warnings,
      }
      this.store.writeJob(projectId, job)
      return job
    }

    writeJob({ status: 'running' })
    if (!plan.saveCheckpoint && !plan.renderPreview) {
      // Nothing needs Blender. Committing a spec-only revision is a legitimate
      // and useful operation — a scene edit that has not been rendered yet — and
      // spending a Blender launch on it would be pure cost.
      warnings.push(warning(
        BlenderWarningCode.SCENE_COMPILER_DECISION,
        'no checkpoint and no preview were requested, so this revision stores the SceneSpec only; ' +
          'there is no .blend to open until a later revision or an explicit compile',
      ))
    }

    let compileReport = null
    let technical = null
    /** @type {object[]} */
    const artifacts = []

    if (plan.saveCheckpoint || plan.renderPreview) {
      const specPath = join(staging, 'scene-spec.json')
      writeFileAtomic(specPath, sceneSpecCanonicalText(plan.spec))
      const checkpointStaging = join(staging, 'scene.blend')

      try {
        const run = await this.runtime.compileScene({
          sceneSpecPath: specPath,
          profile: plan.spec.renderProfiles?.preview === undefined ? undefined : 'preview',
          projectRoot: this.store.projectDirectory(projectId),
          jobId,
          signal: plan.signal,
          onWorkingDirectory: info => {
            const produced = join(info.directory, 'result.blend')
            if (isFile(produced)) {
              // Same filesystem (both are inside the project's staging tree), so
              // this rename is atomic and cannot half-copy a large file.
              renameSync(produced, checkpointStaging)
            }
          },
        })
        compileReport = run.report
        technical = run.report?.validation ?? null
        for (const entry of run.envelope.warnings ?? []) warnings.push(entry)
        for (const entry of run.envelope.notices ?? []) {
          warnings.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, entry.message, { code: entry.code }))
        }
      } catch (cause) {
        const failure = toCanonicalFailure(cause, {
          isBlenderError: value => value instanceof BlenderError,
          fallbackCode: 'BLENDER_SCRIPT_ERROR',
        })
        removeTree(staging)
        const job = writeJob({
          status: 'failed',
          revision: null,
          errorCode: failure.code,
          message: failure.message,
        })
        this.recordFailedAttempt(projectId, { revision, baseRevision: plan.baseRevision, job, failure, plan })
        throw new BlenderError(
          failure.code === 'BLENDER_SCRIPT_ERROR' ? BlenderErrorCode.SCRIPT_ERROR : failure.code,
          `Compiling revision ${revision} failed, so the project is unchanged (current revision ${record.currentRevision}): ${failure.message}`,
          { detail: { projectId, revision, jobId: job.jobId, path: failure.detail?.path ?? null, artifacts: job.artifacts } },
        )
      }

      if (isFile(checkpointStaging)) {
        artifacts.push({
          kind: 'blend',
          path: `revisions/${revision}/scene.blend`,
          bytes: statSync(checkpointStaging).size,
          sha256: fileSha256(checkpointStaging),
          mime: 'application/x-blender',
        })
      }
    } else {
      writeFileAtomic(join(staging, 'scene-spec.json'), sceneSpecCanonicalText(plan.spec))
    }

    // ---- optional preview, rendered from the checkpoint just produced -------
    /** @type {object[]} */
    const previews = []
    if (plan.renderPreview) {
      const checkpointStaging = join(staging, 'scene.blend')
      if (!isFile(checkpointStaging)) {
        throw new BlenderError(
          BlenderErrorCode.REVISION_CHECKPOINT_MISSING,
          `A preview was requested for ${revision}, but the compile produced no checkpoint to render from.`,
          { detail: { projectId, revision, jobId } },
        )
      }
      try {
        previews.push(await this.renderPreviewInto({
          projectId, revision, jobId, staging,
          spec: plan.spec,
          checkpointPath: checkpointStaging,
          cameraId: plan.cameraId,
          signal: plan.signal,
          warnings,
        }))
      } catch (cause) {
        const failure = toCanonicalFailure(cause, {
          isBlenderError: value => value instanceof BlenderError,
          fallbackCode: 'BLENDER_SCRIPT_ERROR',
        })
        removeTree(staging)
        const job = writeJob({ status: 'failed', revision: null, errorCode: failure.code, message: failure.message })
        this.recordFailedAttempt(projectId, { revision, baseRevision: plan.baseRevision, job, failure, plan })
        throw new BlenderError(
          failure.code === 'BLENDER_SCRIPT_ERROR' ? BlenderErrorCode.SCRIPT_ERROR : failure.code,
          `Rendering the preview for revision ${revision} failed, so the project is unchanged ` +
            `(current revision ${record.currentRevision}): ${failure.message}`,
          { detail: { projectId, revision, jobId: job.jobId } },
        )
      }
    }

    for (const preview of previews) artifacts.push(preview.artifact)

    // ---- write the revision's own documents --------------------------------
    const digest = digestAfter(plan, warnings)
    const sceneSummary = summarizeSceneSpec(plan.spec, { revision, revisionNumber, digest })
    const manifest = {
      schemaVersion: REVISION_MANIFEST_VERSION,
      revision,
      revisionNumber,
      projectId,
      title: record.title,
      baseRevision: plan.baseRevision,
      kind: plan.kind,
      createdAt: new Date().toISOString(),
      digest,
      digestBefore: plan.digestBefore ?? digest,
      digestAfter: digest,
      specHashBefore: plan.specHashBefore ?? null,
      specHashAfter: plan.specHashAfter ?? specHash(plan.spec),
      // `sceneChanged` answers "did the geometry, lighting and animation change?"
      // — the question a render cache must ask. `specChanged` answers "did the
      // stored document change at all?", which is also true for a frame-range or
      // render-profile edit. Both are in the manifest because they are different
      // questions and a caller may need either.
      sceneChanged: (plan.digestBefore ?? digest) !== digest,
      specChanged: plan.specHashBefore === null || plan.specHashBefore === undefined
        ? true
        : plan.specHashBefore !== (plan.specHashAfter ?? specHash(plan.spec)),
      summary: plan.summary,
      actor: plan.actor ?? null,
      stage: plan.stage ?? null,
      note: plan.note ?? null,
      sceneSpecVersion: plan.spec.schemaVersion,
      counts: sceneSummary.counts,
      subjectBounds: sceneSummary.subjectBounds,
      project: sceneSummary.project,
      validation: technical === null ? null : {
        ok: technical.ok !== false,
        errorCount: (technical.errors ?? []).length,
        counts: technical.counts ?? null,
        geometry: technical.geometry ?? null,
        frameRange: technical.frameRange ?? null,
        fps: technical.fps ?? null,
        engine: technical.engine ?? null,
        activeCamera: technical.activeCamera ?? null,
        animatedObjects: technical.animatedObjects ?? null,
        cameraParameters: technical.cameraParameters ?? null,
      },
      renderConfig: compileReport?.renderConfig ?? null,
      sceneFingerprint: compileReport?.sceneFingerprint ?? null,
      checkpoint: isFile(join(staging, 'scene.blend')) ? `revisions/${revision}/scene.blend` : null,
      previews: previews.map(entry => entry.artifact),
      jobId,
      runtime: {
        blenderVersion: null,
        engine: compileReport?.engine ?? null,
        requestedEngine: compileReport?.requestedEngine ?? null,
        protocolVersion: 'deepblend.blender/v1',
      },
    }

    if (plan.kind === 'scene_patch') {
      writeJsonAtomic(join(staging, 'operation-manifest.json'), buildOperationManifest({
        operations: plan.operationRecords ?? [],
        request: plan.operations === undefined ? {} : {
          idempotencyKey: plan.derivedIdempotencyKey === false ? '<caller-supplied>' : '<derived>',
          actor: plan.actor,
          stage: plan.stage,
          note: plan.note,
          saveCheckpoint: plan.saveCheckpoint,
          renderPreview: plan.renderPreview,
        },
        revision: {
          revision,
          baseRevision: plan.baseRevision,
          digestBefore: manifest.digestBefore,
          digestAfter: manifest.digestAfter,
          specHashBefore: manifest.specHashBefore,
          specHashAfter: manifest.specHashAfter,
        },
        notices: plan.notices ?? [],
      }))
      writeJsonAtomic(join(staging, 'request.json'), {
        schemaVersion: SCENE_PATCH_VERSION,
        ...plan.operations === undefined ? {} : { operations: plan.operations },
        baseRevision: plan.baseRevision,
        saveCheckpoint: plan.saveCheckpoint,
        renderPreview: plan.renderPreview,
        actor: plan.actor ?? null,
        stage: plan.stage ?? null,
        note: plan.note ?? null,
      })
    } else {
      writeJsonAtomic(join(staging, 'request.json'), {
        kind: 'project_create',
        title: record.title,
        goal: record.goal,
        baseRevision: GENESIS_REVISION,
      })
    }

    writeJsonAtomic(join(staging, 'validation.json'), {
      schemaVersion: 'deepblend.validation/v1',
      revision,
      semantic: { ok: true, notices: plan.notices ?? [] },
      technical,
    })

    // The manifest is written LAST inside staging: while it is absent, the
    // directory is definitionally incomplete, which is the marker a future
    // recovery sweep would use to identify an abandoned staging directory.
    writeJsonAtomic(join(staging, 'revision-manifest.json'), manifest)

    // ---- publish -----------------------------------------------------------
    const finalPath = this.store.revisionDirectory(projectId, revision)
    publishDirectory(staging, finalPath)

    const nextRecord = {
      ...record,
      currentRevision: revision,
      revisionCount: (record.revisionCount ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      specHash: manifest.specHashAfter,
    }
    this.store.writeRecord(projectId, nextRecord)

    const job = writeJob({
      status: 'succeeded',
      revision,
      artifacts: artifacts.map(entry => ({ ...entry, path: entry.path })),
    })

    return {
      revision: { ...manifest, isCurrent: true },
      record: nextRecord,
      job,
      warnings,
      sceneSummary,
      technical,
    }
  }

  /**
   * Render one preview into a revision's staging `previews/` directory.
   * @param {object} input
   * @returns {Promise<{ artifact: object, report: object }>}
   */
  async renderPreviewInto(input) {
    const { projectId, revision, staging, spec } = input
    const profile = spec.renderProfiles?.preview
    if (profile === undefined) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_PROFILE_MISSING,
        'The SceneSpec defines no preview render profile, so no preview can be rendered.',
      )
    }

    const cameraId = input.cameraId ?? spec.cameras?.[0]?.id
    if (cameraId === undefined) {
      throw new BlenderError(BlenderErrorCode.SCENE_CAMERA_MISSING, 'The SceneSpec declares no camera to render from.')
    }

    const engineInfo = await this.runtime.resolveEngineKey(profile.engine, { signal: input.signal })
    if (engineInfo.warning !== null) input.warnings?.push(engineInfo.warning)

    const previewsDir = join(staging, 'previews')
    mkdirSync(previewsDir, { recursive: true })
    const filename = `${cameraId}.png`
    const outputPath = join(previewsDir, filename)

    const run = await this.runtime.renderPreview({
      checkpointPath: input.checkpointPath,
      outputPath,
      cameraId,
      engine: engineInfo.blenderEngine === null ? undefined : profile.engine,
      width: profile.resolution?.[0],
      height: profile.resolution?.[1],
      samples: profile.samples,
      jobId: input.jobId,
      signal: input.signal,
    })

    for (const entry of run.envelope.warnings ?? []) input.warnings?.push(entry)
    for (const entry of run.envelope.notices ?? []) {
      input.warnings?.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, entry.message, { code: entry.code }))
    }

    const report = run.report ?? {}
    const bytes = fileSize(outputPath)
    if (bytes === null || bytes === 0) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_NO_OUTPUT,
        `The renderer reported success but produced no image at ${filename}.`,
      )
    }

    return {
      report,
      artifact: {
        kind: 'preview',
        path: `revisions/${revision}/previews/${filename}`,
        cameraId,
        frame: report.frame ?? null,
        width: report.width ?? null,
        height: report.height ?? null,
        engine: report.engine ?? profile.engine,
        samples: report.renderConfig?.samples ?? profile.samples ?? null,
        bytes,
        sha256: fileSha256(outputPath),
        mime: 'image/png',
      },
    }
  }

  /**
   * Record a failed attempt so a failure is auditable without being a revision.
   *
   * Written to `jobs/`, NOT to `revisions/`: a failure must be visible and must
   * never look like a version of the project.
   */
  recordFailedAttempt(projectId, input) {
    try {
      writeJsonAtomic(
        join(this.store.projectDirectory(projectId), 'jobs', `${input.job.jobId}.attempt.json`),
        {
          schemaVersion: 'deepblend.failed-attempt/v1',
          projectId,
          attemptedRevision: input.revision,
          baseRevision: input.baseRevision,
          jobId: input.job.jobId,
          errorCode: input.failure.code,
          message: input.failure.message,
          at: new Date().toISOString(),
          operations: input.plan.operations ?? null,
          summary: input.plan.summary ?? null,
        },
      )
    } catch {
      // Losing the audit record must not replace the real error the caller sees.
    }
  }
}

/** readdir that tolerates absence. */
function readdirSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

/** A readable one-line description of what a patch did. */
function describeOperations(records) {
  if (records.length === 0) return 'No operations.'
  if (records.length === 1) return records[0].summary
  return `${records.length} operations: ${records.map(record => record.summary).join('; ')}`
}

/** Digest helper kept separate so the manifest reads as data, not as computation. */
function digestAfter(plan, _warnings) {
  return sceneSpecDigest(plan.spec)
}

/**
 * The SceneSpec a `project_create` starts from when the caller supplied none.
 *
 * Deliberately minimal and deliberately VALID: one cube, one camera, one light,
 * both render profiles. A brand-new project must be renderable immediately, or
 * the first thing every caller does is repair the scaffold — and a scaffold that
 * needs repairing is a worse starting point than no scaffold at all.
 *
 * @param {{ projectId: string, title: string, goal?: string }} input
 * @returns {object}
 */
export function defaultSceneSpec({ projectId, title, goal }) {
  return {
    schemaVersion: 'deepblend.scene/v1',
    project: {
      id: projectId,
      title,
      ...goal !== undefined ? { goal } : {},
      units: 'metric',
      fps: 24,
      frameStart: 1,
      frameEnd: 48,
      aspectRatio: '16:9',
    },
    materials: [
      { id: 'default-surface', shader: 'principled', parameters: { baseColor: [0.62, 0.62, 0.64, 1], metallic: 0.0, roughness: 0.5 } },
    ],
    entities: [
      {
        id: 'subject',
        type: 'generator',
        generator: { shape: 'cube', size: 2 },
        materialId: 'default-surface',
        transform: { location: [0, 0, 1], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        tags: ['hero-product'],
      },
    ],
    lights: [
      {
        id: 'key-light',
        type: 'area',
        transform: { location: [2.5, -3, 4], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        energy: 400,
        color: [1, 1, 1],
        size: 2,
      },
    ],
    cameras: [
      {
        id: 'camera-main',
        lens: 50,
        sensorWidth: 36,
        clipping: [0.1, 100],
        transform: { location: [4.2, -4.2, 3.4], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        targetEntityId: 'subject',
      },
    ],
    shots: [{ id: 'shot-01', cameraId: 'camera-main', frameRange: [1, 48], description: 'Default framing of the subject.' }],
    animationTracks: [],
    renderProfiles: {
      preview: {
        engine: 'cycles',
        resolution: [640, 360],
        samples: 48,
        filmTransparent: false,
        colorManagement: { viewTransform: 'Standard' },
        maxSamplesBudget: 256,
      },
      final: {
        engine: 'cycles',
        resolution: [1920, 1080],
        samples: 256,
        filmTransparent: false,
        colorManagement: { viewTransform: 'AgX' },
        maxSamplesBudget: 1024,
      },
    },
  }
}
