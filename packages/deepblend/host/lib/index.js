/**
 * @deepblend/dsh-blender-host
 *
 * The DeepBlend **Host service** (SPEC §5.1, §7.2).
 *
 * Owns the `blenderStudio` business facade that both the model-facing tool
 * package and the Web UI talk to. It is the only place in DeepBlend that knows
 * the ORDER of a revision commit; everything below it (`blenderRuntime`, the
 * stores) is a mechanism, and everything above it (the preset tools, the UI) is
 * a surface.
 *
 * WHY THE FACADE EXISTS — the SPEC's plane rule. `blender_scene_patch` must be a
 * *preset* row (it decides what the model sees), while the revision transaction,
 * the project store and the idempotency ledger belong to the *host* (they are
 * process-level and cross-session). One facade means the tool and the browser can
 * never disagree about what "current revision" means (SPEC §14.3).
 *
 * M1 implements the batch SceneSpec loop: create, read, patch, validate, preview,
 * restore. `startFinalRender` and `exportProject` still throw a stable
 * `UNSUPPORTED_ACTION` — a method that silently returned undefined would be a
 * capability the model could believe in and the runtime could not keep
 * (SPEC §11.1).
 *
 * Owner: DeepBlend Studio — M1
 * Plane: Host composition
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  BLENDER_SETTINGS_NAMESPACE,
  BlenderError,
  BlenderErrorCode,
  BlenderWarningCode,
  SCENE_PATCH_VERSION,
  compileSceneSpec,
  sceneSpecDigest,
  summarizeSceneSpec,
  toCanonicalJobRecord,
  toCanonicalProjectSummary,
  toCanonicalCapabilities,
  toCanonicalQAReport,
  toCanonicalRevisionSummary,
  validateSceneSpec,
  warning,
} from '@deepblend/dsh-blender-contracts'

import { ProjectStore, GENESIS_REVISION, parseRevisionId } from './project-store.js'
import { RevisionTransaction } from './revision-transaction.js'
import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { fileSha256, fileSize, isFile, removeTree, resolveInside } from './paths.js'

/** Service key registered into the Cordis context. */
export const BLENDER_STUDIO_SERVICE = 'blenderStudio'

/** The runtime service this facade consumes. */
const RUNTIME_SERVICE = 'blenderRuntime'

/**
 * Host-level configuration. Mirrors SPEC §17.
 *
 * Named `StudioConfig`, NOT `Config`. The class below declares `static Config`,
 * and a module-scope `Config` would be shadowed by that class field inside the
 * class body — so `static Config = Config` would read the field already being
 * initialized and throw a temporal-dead-zone ReferenceError during module
 * evaluation, taking the whole package down on import. That is exactly the bug
 * this naming avoids; it failed only at bundle-load time, never in the unit
 * tests, which is why the runtime install check caught it.
 */
export const StudioConfig = z.object({
  /** Directory holding DeepBlend projects. */
  projectsRoot: z.string(),
  /**
   * Workspace root that staging and provider scratch directories must stay
   * inside (SPEC §15.2). Must be the SAME root the provider is configured with,
   * or a staging path the host hands out would be one the provider refuses.
   */
  workspaceRoot: z.string(),
  /** Serve a cached capabilities document without re-probing during a page load. */
  serveCachedCapabilities: z.boolean().default(true),
  /** Refuse a preview whose sample count exceeds this, however it was asked for. */
  maxPreviewSamples: z.number().default(512),
})

export default class BlenderStudio extends Service {
  // A hard dependency: without a BlenderRuntime the facade has nothing to run,
  // so Cordis keeps this row `waiting` instead of failing at first call.
  static inject = [RUNTIME_SERVICE]

  static Config = StudioConfig

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('z').infer<typeof StudioConfig>} config
   */
  constructor(ctx, config) {
    super(ctx, BLENDER_STUDIO_SERVICE)
    this.config = config
    /** In-flight probe, so N concurrent callers share one Blender launch. */
    this._inFlight = null

    this.store = new ProjectStore({ projectsRoot: config.projectsRoot, workspaceRoot: config.workspaceRoot })
    this.transactions = new RevisionTransaction({ store: this.store, runtime: this.runtime, config })
  }

  /** @type {Promise<import('@deepblend/dsh-blender-contracts').BlenderCapabilities>|null} */
  _inFlight

  /** @returns {import('@deepblend/dsh-blender-provider-local').default} */
  get runtime() {
    return this.ctx.blenderRuntime
  }

  // ---------------------------------------------------------------------------
  // Capabilities (M0)
  // ---------------------------------------------------------------------------

  /**
   * Report Blender capabilities.
   *
   * Concurrent callers are coalesced onto one probe: a Blender launch costs
   * ~1 s, and a page load plus a tool call arriving together must not launch
   * two processes (SPEC §16.4 concurrency discipline).
   *
   * @param {{ refresh?: boolean, signal?: AbortSignal }} [request]
   * @returns {Promise<import('@deepblend/dsh-blender-contracts').BlenderCapabilities>}
   */
  async getCapabilities(request = {}) {
    if (request.refresh === true) this.runtime.invalidateCapabilities()
    if (this._inFlight !== null) return this._inFlight

    const probe = (async () => {
      try {
        return await this.runtime.getCapabilities({
          refresh: request.refresh === true,
          ...request.signal !== undefined ? { signal: request.signal } : {},
        })
      } finally {
        this._inFlight = null
      }
    })()
    this._inFlight = probe
    return probe
  }

  /**
   * The canonical, stable-order view consumed by the model tool and the UI.
   *
   * One projection serves both surfaces so the browser can never disagree with
   * the tool about what Blender can do (SPEC §14.3 "Host 保存权威项目状态").
   *
   * @param {{ refresh?: boolean, signal?: AbortSignal }} [request]
   * @returns {Promise<Record<string, unknown>>}
   */
  async describeCapabilities(request = {}) {
    const capabilities = await this.getCapabilities(request)
    return toCanonicalCapabilities(capabilities)
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  /**
   * Create a project and commit its first revision.
   *
   * @param {object} request
   * @param {string} request.title
   * @param {string} [request.goal] - the natural-language brief, retained verbatim.
   * @param {object} [request.sceneSpec] - a full SceneSpec to seed the project with.
   * @param {string} [request.projectId]
   * @param {boolean} [request.saveCheckpoint]
   * @param {boolean} [request.renderPreview]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async createProject(request) {
    if (typeof request?.title !== 'string' || request.title.trim().length === 0) {
      throw new BlenderError(
        BlenderErrorCode.PROJECT_ID_INVALID,
        'createProject needs a title; it is both the human name and the source of the project id.',
      )
    }
    const outcome = await this.transactions.createProject(request)
    return {
      ...toCanonicalProjectSummary({
        record: outcome.record,
        revisionCount: outcome.record.revisionCount,
        sceneSummary: outcome.sceneSummary,
      }),
      revision: toCanonicalRevisionSummary({
        manifest: outcome.revision,
        checkpointPath: outcome.revision.checkpoint,
      }),
      job: toCanonicalJobRecord(outcome.job),
      warnings: outcome.warnings,
    }
  }

  /**
   * Read a project's summary and current revision digest.
   *
   * @param {string} projectId
   * @param {{ revision?: string }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async getProject(projectId, options = {}) {
    const record = this.store.readRecord(projectId)
    const revision = options.revision ?? record.currentRevision
    const spec = this.store.readRevisionSpec(projectId, revision)
    const digest = sceneSpecDigest(spec)
    return {
      ...toCanonicalProjectSummary({
        record,
        revisionCount: record.revisionCount ?? this.store.listRevisions(projectId).length,
        sceneSummary: summarizeSceneSpec(spec, {
          revision,
          revisionNumber: parseRevisionId(revision),
          digest,
        }),
      }),
      revisions: this.store.listRevisions(projectId).map(id => {
        const manifest = this.store.readRevisionManifest(projectId, id)
        return {
          revision: id,
          revisionNumber: parseRevisionId(id),
          createdAt: manifest?.createdAt ?? null,
          kind: manifest?.kind ?? null,
          summary: manifest?.summary ?? null,
          digest: manifest?.digest ?? null,
          checkpoint: this.store.checkpointPath(projectId, id) === null
            ? null
            : `revisions/${id}/scene.blend`,
          previews: (manifest?.previews ?? []).map(entry => entry.path),
          isCurrent: id === record.currentRevision,
        }
      }),
    }
  }

  // ---------------------------------------------------------------------------
  // Scene
  // ---------------------------------------------------------------------------

  /**
   * The compact `SceneDigest` of a revision (SPEC §7.2 `getScene`).
   *
   * Returns a DIGEST, not the document, by default. The SPEC's tool rule is
   * explicit: "FullSceneSpec 明确需要时才读取" (SPEC §18) — a model that reads the
   * whole spec on every turn spends its context on fields it is not changing.
   *
   * @param {string} projectId
   * @param {{ revision?: string, full?: boolean }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async getScene(projectId, options = {}) {
    const record = this.store.readRecord(projectId)
    const revision = options.revision ?? record.currentRevision
    const spec = this.store.readRevisionSpec(projectId, revision)
    const digest = sceneSpecDigest(spec)
    const summary = summarizeSceneSpec(spec, {
      revision,
      revisionNumber: parseRevisionId(revision),
      digest,
    })
    const manifest = this.store.readRevisionManifest(projectId, revision)
    return {
      ...summary,
      projectId,
      isCurrent: revision === record.currentRevision,
      checkpoint: this.store.checkpointPath(projectId, revision) === null ? null : `revisions/${revision}/scene.blend`,
      previews: (manifest?.previews ?? []).map(entry => ({
        cameraId: entry.cameraId,
        path: entry.path,
        frame: entry.frame,
        width: entry.width,
        height: entry.height,
      })),
      // Returned only on explicit request. The caller asked for the document;
      // withholding it would just force a second call.
      ...options.full === true ? { spec, compiledSpec: compileSceneSpec(spec).spec } : {},
    }
  }

  /**
   * Apply a ScenePatch as one atomic revision (SPEC §8.3, §13.2).
   *
   * @param {object} request - a ScenePatch v1 document, plus `signal`.
   * @returns {Promise<Record<string, unknown>>}
   */
  async applyScenePatch(request) {
    const { signal, ...patch } = request ?? {}
    if (typeof patch.idempotencyKey === 'string' && patch.idempotencyKey.length > 0) {
      // The caller supplied one, so remember that for the audit record rather
      // than letting the derived/explicit distinction be lost.
      patch.explicitIdempotencyKey = patch.idempotencyKey
    }
    const outcome = await this.transactions.applyScenePatch(
      { ...patch, projectId: patch.projectId },
      { signal },
    )
    return {
      ...toCanonicalRevisionSummary({
        manifest: outcome.revision,
        checkpointPath: outcome.revision.checkpoint,
      }),
      idempotentReplay: outcome.idempotentReplay === true,
      replayOf: outcome.replayOf ?? null,
      idempotencyKey: outcome.idempotencyKey,
      idempotencyKeyDerived: outcome.idempotencyKeyDerived === true,
      job: toCanonicalJobRecord(outcome.job),
      warnings: outcome.warnings,
      scene: outcome.sceneSummary,
    }
  }

  /**
   * Validate a revision (SPEC §7.2 `validateScene`).
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.revision]
   * @param {object} [request.patch] - additionally check whether this patch applies.
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async validateScene(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revision = request.revision ?? record.currentRevision
    const spec = this.store.readRevisionSpec(projectId, revision)
    const digest = sceneSpecDigest(spec)

    const semantic = validateSceneSpec(spec)
    const compiled = compileSceneSpec(spec)

    /** @type {object[]} */
    const notices = [...semantic.notices, ...compiled.notices]
    /** @type {object[]} */
    const errors = [...semantic.errors]

    if (request.patch !== undefined) {
      // "Will this patch apply?" is the question worth answering BEFORE a caller
      // spends a revision on it, so it is answered here using the same code path
      // the commit uses. A dry run that took a different route would be worthless.
      //
      // `projectId` is merged in from the request rather than demanded twice: the
      // caller already named the project, and requiring it inside the patch as
      // well is ceremony that only ever yields a confusing "projectId is missing"
      // on an otherwise correct patch.
      const dryRun = { projectId, ...request.patch }
      try {
        const { validateScenePatch, applyPatchToSpec } = await import('@deepblend/dsh-blender-contracts')
        const structural = validateScenePatch(dryRun)
        if (!structural.ok) {
          errors.push(...structural.errors.map(issue => ({
            severity: 'error', code: issue.code, path: issue.path,
            message: `the patch is not well formed — ${issue.message}`,
          })))
        } else if (dryRun.baseRevision !== revision) {
          errors.push({
            severity: 'error', code: BlenderErrorCode.REVISION_CONFLICT, path: 'baseRevision',
            message: `the patch targets ${dryRun.baseRevision} but revision ${revision} is being validated`,
          })
        } else {
          const applied = applyPatchToSpec(compiled.spec, dryRun)
          const after = validateSceneSpec(applied.spec)
          errors.push(...after.errors.map(issue => ({
            severity: 'error', code: issue.code, path: issue.path,
            message: `applying the patch — ${issue.message}`,
          })))
          notices.push(...applied.operations.map(record => ({
            severity: 'notice', code: 'PATCH_OPERATION_WOULD_APPLY', path: null, message: record.summary,
          })))
          if (after.ok) {
            notices.push({
              severity: 'notice', code: 'PATCH_WOULD_SUCCEED', path: null,
              message:
                `all ${applied.operations.length} operation(s) would apply cleanly against ${revision}; ` +
                `the scene digest would change from ${applied.digestBefore.slice(0, 16)} to ${applied.digestAfter.slice(0, 16)}`,
            })
          }
        }
      } catch (cause) {
        const issue = /** @type {any} */ (cause).patchIssue
        errors.push({
          severity: 'error',
          code: issue?.code ?? BlenderErrorCode.SCENE_PATCH_REJECTED,
          path: issue?.path ?? null,
          message: issue?.message ?? (cause instanceof Error ? cause.message : String(cause)),
        })
      }
    }

    const manifest = this.store.readRevisionManifest(projectId, revision)
    return toCanonicalQAReport({
      projectId,
      revision,
      digest,
      errors,
      notices,
      technical: manifest?.validation ?? null,
    })
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Render a preview of one revision and record it against that revision.
   *
   * Rendering does NOT create a revision: a preview is an observation of a
   * scene, not a change to it. It is written into the revision's own `previews/`
   * directory, which is why a revision's previews are immutable alongside it.
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.revision]
   * @param {string} [request.cameraId]
   * @param {number} [request.samples]
   * @param {number} [request.width]
   * @param {number} [request.height]
   * @param {number} [request.frame]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async renderPreview(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revision = request.revision ?? record.currentRevision
    const spec = this.store.readRevisionSpec(projectId, revision)
    const digest = sceneSpecDigest(spec)

    const profile = spec.renderProfiles?.preview
    if (profile === undefined) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_PROFILE_MISSING,
        `Revision ${revision} defines no preview render profile.`,
        { detail: { projectId, revision } },
      )
    }

    const requestedSamples = request.samples ?? profile.samples
    const sampleCeiling = Math.min(
      profile.maxSamplesBudget ?? this.config.maxPreviewSamples,
      this.config.maxPreviewSamples,
    )
    const effectiveSamples = requestedSamples === undefined
      ? undefined
      : Math.min(requestedSamples, sampleCeiling)
    /** @type {object[]} */
    const warnings = []
    if (effectiveSamples !== undefined && requestedSamples !== undefined && effectiveSamples < requestedSamples) {
      warnings.push(warning(
        BlenderWarningCode.RENDER_SAMPLES_REDUCED,
        `preview samples reduced from ${requestedSamples} to ${effectiveSamples} by the configured budget ` +
          `(profile budget ${profile.maxSamplesBudget ?? this.config.maxPreviewSamples}, host ceiling ${this.config.maxPreviewSamples})`,
        { requested: requestedSamples, used: effectiveSamples },
      ))
    }

    // A preview must render the scene the caller asked for. A checkpoint is
    // preferred when the revision has one; otherwise the revision is compiled
    // from its spec into a scratch directory first, because the spec — not a
    // .blend — is the source of truth (SPEC §8.1).
    const checkpoint = this.store.findCheckpointAtOrBefore(projectId, revision)
    let resolvedCheckpoint = checkpoint
    let compiledForThisRender = null

    const jobId = this.store.allocateJobId(projectId, 'render_preview')
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    this.store.writeJob(projectId, {
      schemaVersion: 'deepblend.job/v1',
      jobId,
      projectId,
      action: 'render_preview',
      revision,
      status: 'running',
      errorCode: null,
      message: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
      idempotencyKey: null,
      baseRevision: revision,
      artifacts: [],
      warnings,
    })

    try {
      if (resolvedCheckpoint === null || resolvedCheckpoint.revision !== revision) {
        compiledForThisRender = await this.compileRevisionForRender({
          projectId, revision, spec, jobId, signal: request.signal,
        })
        resolvedCheckpoint = compiledForThisRender
        if (checkpoint !== null && checkpoint.revision !== revision) {
          warnings.push(warning(
            BlenderWarningCode.SCENE_COMPILER_DECISION,
            `revision ${revision} has no checkpoint of its own; it was compiled from its SceneSpec for this render ` +
              `(the nearest earlier checkpoint is ${checkpoint.revision})`,
            { revision, nearestCheckpoint: checkpoint.revision },
          ))
        }
      }

      const staging = join(this.store.revisionDirectory(projectId, revision), '.render-staging')
      const engineInfo = await this.runtime.resolveEngineKey(profile.engine, { signal: request.signal })
      if (engineInfo.warning !== null) warnings.push(engineInfo.warning)

      const outputPath = join(staging, `${request.cameraId ?? spec.cameras?.[0]?.id ?? 'camera'}.png`)
      const run = await this.runtime.renderPreview({
        checkpointPath: resolvedCheckpoint.path,
        outputPath,
        cameraId: request.cameraId,
        engine: engineInfo.blenderEngine === null ? undefined : profile.engine,
        width: request.width ?? profile.resolution?.[0],
        height: request.height ?? profile.resolution?.[1],
        samples: effectiveSamples,
        frame: request.frame,
        jobId,
        signal: request.signal,
      })

      for (const entry of run.envelope.warnings ?? []) warnings.push(entry)
      for (const entry of run.envelope.notices ?? []) {
        warnings.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, entry.message, { code: entry.code }))
      }

      const report = run.report ?? {}
      if (!isFile(outputPath)) {
        throw new BlenderError(
          BlenderErrorCode.RENDER_NO_OUTPUT,
          'The Blender renderer reported success but wrote no image.',
          { detail: { outputPath, jobId } },
        )
      }

      // The image lives in the revision's previews/ from now on: a preview is an
      // artifact OF a revision, so a later revision cannot overwrite it.
      const revisionDirectory = this.store.revisionDirectory(projectId, revision)
      const previewsDir = join(revisionDirectory, 'previews')
      mkdirSync(previewsDir, { recursive: true })
      const filename = `frame${report.frame ?? 0}-${request.cameraId ?? spec.cameras?.[0]?.id ?? 'camera'}.png`
      const finalPath = resolveInside(
        this.store.projectDirectory(projectId),
        join(previewsDir, filename),
        'preview artifact',
      )
      renameSync(outputPath, finalPath)
      removeTree(staging)

      const artifact = {
        kind: 'preview',
        path: `revisions/${revision}/previews/${filename}`,
        cameraId: report.cameraId ?? request.cameraId ?? null,
        frame: report.frame ?? null,
        width: report.width ?? null,
        height: report.height ?? null,
        engine: report.engine ?? null,
        samples: report.renderConfig?.samples ?? null,
        bytes: fileSize(finalPath),
        sha256: fileSha256(finalPath),
        mime: 'image/png',
      }
      // What the caller is actually looking at. A preview is the one result whose
      // value depends on facts the numbers do not carry — which checkpoint it came
      // from, which frame, which engine — so all three are stated rather than
      // implied.
      //
      // The previous spelling of this line had a real defect, caught only by
      // rendering through the restarted live process: the provenance was built by
      // splicing a word into the middle of a sentence, so it produced
      // "rendered from the revisioncheckpoint" in every ORDINARY case (the
      // checkpoint is the requested revision) and read correctly only in the
      // rarer inherited-checkpoint case. It is now two whole sentences rather
      // than one assembled one.
      const checkpointSource = resolvedCheckpoint.revision === revision
        ? `revision ${revision}`
        : `the ${resolvedCheckpoint.revision} checkpoint, because revision ${revision} has none of its own`
      warnings.push(warning(
        BlenderWarningCode.SCENE_COMPILER_DECISION,
        `preview of ${checkpointSource}: frame ${artifact.frame}, ` +
          `${artifact.width}x${artifact.height}, engine ${artifact.engine}`,
      ))

      const job = this.store.writeJob(projectId, {
        schemaVersion: 'deepblend.job/v1',
        jobId,
        projectId,
        action: 'render_preview',
        revision,
        status: 'succeeded',
        errorCode: null,
        message: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        idempotencyKey: null,
        baseRevision: revision,
        artifacts: [artifact],
        warnings,
      })

      return {
        projectId,
        revision,
        digest,
        profile: {
          engine: profile.engine,
          blenderEngine: engineInfo.blenderEngine,
          resolution: [artifact.width ?? profile.resolution?.[0], artifact.height ?? profile.resolution?.[1]],
          samples: artifact.samples,
          filmTransparent: profile.filmTransparent === true,
        },
        artifacts: [artifact],
        warnings,
        job: toCanonicalJobRecord(job),
      }
    } catch (cause) {
      removeTree(join(this.store.revisionDirectory(projectId, revision), '.render-staging'))
      const failure = cause instanceof BlenderError
        ? cause
        : new BlenderError(
          BlenderErrorCode.SCRIPT_ERROR,
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        )
      this.store.writeJob(projectId, {
        schemaVersion: 'deepblend.job/v1',
        jobId,
        projectId,
        action: 'render_preview',
        revision,
        status: 'failed',
        errorCode: failure.code,
        message: failure.message,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        idempotencyKey: null,
        baseRevision: revision,
        artifacts: [],
        warnings,
      })
      throw failure
    } finally {
      if (compiledForThisRender !== null) removeTree(compiledForThisRender.directory)
    }
  }

  /**
   * Compile a revision from its SceneSpec into a scratch checkpoint.
   * @param {object} input
   * @returns {Promise<{ revision: string, path: string, directory: string }>}
   */
  async compileRevisionForRender(input) {
    const { projectId, revision, spec } = input
    const scratch = resolveInside(
      this.store.workspaceRoot,
      join(this.store.workspaceRoot, 'tmp', `render-${revision}-${Date.now().toString(36)}`),
      'render scratch directory',
    )
    const { writeFileSync } = await import('node:fs')
    mkdirSync(scratch, { recursive: true })
    const specPath = join(scratch, 'scene-spec.json')
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')

    let produced = null
    await this.runtime.compileScene({
      sceneSpecPath: specPath,
      projectRoot: this.store.projectDirectory(projectId),
      jobId: input.jobId,
      signal: input.signal,
      onWorkingDirectory: info => {
        const candidate = join(info.directory, 'result.blend')
        if (isFile(candidate)) produced = join(scratch, 'scene.blend')
      },
    })

    if (produced === null || !isFile(produced)) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CHECKPOINT_MISSING,
        `Revision ${revision} was compiled for rendering but produced no checkpoint.`,
      )
    }
    return { revision, path: produced, directory: scratch }
  }

  // ---------------------------------------------------------------------------
  // Revisions and jobs
  // ---------------------------------------------------------------------------

  /**
   * Move a project's current pointer to an existing revision.
   *
   * Restoration is a POINTER MOVE, not a new revision. The SPEC's revision model
   * is append-only: a "restore" that created a copy would double the storage for
   * no gain and, worse, would make the history a lie about what was committed.
   * The pointer move is recorded in the project record so the history is still
   * readable as a sequence of decisions.
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} request.revision
   * @returns {Promise<Record<string, unknown>>}
   */
  async restoreRevision(request) {
    const projectId = request?.projectId
    const target = request?.revision
    const record = this.store.readRecord(projectId)
    const directory = this.store.revisionDirectory(projectId, target)
    if (!isFile(join(directory, 'revision-manifest.json'))) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_NOT_FOUND,
        `Project "${projectId}" has no revision ${target}.`,
        { detail: { projectId, revision: target, available: this.store.listRevisions(projectId) } },
      )
    }
    if (target === record.currentRevision) {
      const manifest = this.store.readRevisionManifest(projectId, target)
      return {
        restored: false,
        reason: `${target} is already the current revision`,
        ...toCanonicalRevisionSummary({
          manifest: { ...manifest, isCurrent: true },
          checkpointPath: manifest.checkpoint ?? null,
        }),
      }
    }

    const manifest = this.store.readRevisionManifest(projectId, target)
    const nextRecord = {
      ...record,
      currentRevision: target,
      updatedAt: new Date().toISOString(),
      restorations: [
        ...(record.restorations ?? []),
        { from: record.currentRevision, to: target, at: new Date().toISOString() },
      ],
    }
    this.store.writeRecord(projectId, nextRecord)

    return {
      restored: true,
      from: record.currentRevision,
      ...toCanonicalRevisionSummary({
        manifest: { ...manifest, isCurrent: true },
        checkpointPath: this.store.checkpointPath(projectId, target) === null
          ? null
          : `revisions/${target}/scene.blend`,
      }),
    }
  }

  /** Read one durable job record. */
  async getJob(request) {
    const record = this.store.readJob(request?.projectId, request?.jobId)
    return toCanonicalJobRecord(record)
  }

  /**
   * Cancel a job.
   *
   * M1 runs every Blender action to completion inside the tool call that started
   * it, so there is no live process to cancel. Reporting that plainly is the
   * honest answer; the persistent, cancellable Job Store is M3 (SPEC §10).
   */
  async cancelJob(request) {
    const record = this.store.readJob(request?.projectId, request?.jobId)
    if (record.status === 'running') {
      throw new BlenderError(
        BlenderErrorCode.UNSUPPORTED_ACTION,
        `Job ${record.jobId} is recorded as running but M1 has no cancellable background job: ` +
          'every Blender action finishes within the tool call that started it. Cancellation lands with the ' +
          'persistent Job Store in M3.',
        { detail: { jobId: record.jobId, milestone: 'M3' } },
      )
    }
    return { jobId: record.jobId, status: record.status, cancelled: false, reason: `job is already ${record.status}` }
  }

  /**
   * Drop cached state after a settings change so a corrected `blenderPath`
   * takes effect without a restart (SPEC §17 "配置变化时安全重载").
   */
  reload() {
    this.runtime.invalidateCapabilities()
  }

  // ---------------------------------------------------------------------------
  // Declared-but-unimplemented M3+ surface (SPEC §7.2)
  //
  // Each of these exists so the package boundary is frozen now, and each throws
  // a stable code so no caller — model, UI or test — can mistake absence for
  // success (SPEC §11.1).
  // ---------------------------------------------------------------------------

  /** @returns {never} */
  _notImplemented(operation, milestone) {
    throw new BlenderError(
      BlenderErrorCode.UNSUPPORTED_ACTION,
      `blenderStudio.${operation} is not implemented in M1. ${milestone} delivers it; ` +
        'M1 delivers the batch SceneSpec loop (create, read, patch, validate, preview, restore).',
      { detail: { operation, milestone } },
    )
  }

  /** @returns {never} */
  startFinalRender() { return this._notImplemented('startFinalRender', 'M3') }
  /** @returns {never} */
  exportProject() { return this._notImplemented('exportProject', 'M3') }
}

/**
 * Settings namespace name re-exported for the UI half, which must not import the
 * host implementation merely to learn a string.
 */
export { BLENDER_SETTINGS_NAMESPACE }

/** Re-exported so the UI host half can render a project id without the store. */
export { GENESIS_REVISION }

/**
 * Store and transaction surface, re-exported for tests and for a future
 * migration/repair tool. Kept on the main entry rather than requiring callers to
 * reach into a subpath: these ARE the M1 host API, and a test that had to import
 * an internal module to exercise conflict handling would be testing something
 * other than what ships.
 */
export { ProjectStore, formatRevisionId, parseRevisionId } from './project-store.js'
export {
  RevisionTransaction,
  deriveIdempotencyKey,
  resolveIdempotencyKey,
  defaultSceneSpec,
} from './revision-transaction.js'
