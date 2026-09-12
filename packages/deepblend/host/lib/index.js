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
  buildViewPlan,
  buildVisualReview,
  compileSceneSpec,
  resolveSubjectId,
  sceneSpecDigest,
  scoreReview,
  summarizeSceneSpec,
  toCanonicalJobRecord,
  toCanonicalProjectSummary,
  toCanonicalCapabilities,
  toCanonicalQAReport,
  toCanonicalRevisionSummary,
  runVisualLoop,
  trackedObjects,
  validateFindings,
  validateSceneSpec,
  warning,
} from '@deepblend/dsh-blender-contracts'

import { ProjectStore, GENESIS_REVISION, parseRevisionId } from './project-store.js'
import { RevisionTransaction } from './revision-transaction.js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fileSha256, fileSize, isFile, removeTree, resolveInside, writeJsonAtomic } from './paths.js'

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

  // ---- M2: the visual loop (SPEC §12.3, §17 `agent`) ------------------------
  //
  // The three knobs SPEC §17 groups under `agent` live here because they bound a
  // HOST-owned loop: the iteration cap, the confidence floor below which a model
  // finding is not auto-applied, and how many consecutive rounds a repeated finding
  // is tolerated before the loop stops.

  /** Hard cap on visual fix rounds per run. SPEC §17 default is 5. */
  maxVisualIterations: z.number().default(5),
  /** Findings below this confidence are reported but never auto-applied. */
  minVisualConfidenceForAutoFix: z.number().default(0.8),
  /** Consecutive rounds an unchanged finding may recur before stopping. */
  stopOnRepeatedIssueCount: z.number().default(2),
  /** Provider route used by the built-in vision reviewer. */
  visualReviewProvider: z.string().default('deepseek-official'),
  /** Model used by the built-in vision reviewer. */
  visualReviewModel: z.string().default('deepseek-flash'),
  /**
   * Token budget for one reviewer call.
   *
   * MEASURED, and the reason this is a config field rather than a constant: with the
   * full reviewer prompt and a 2x2 sheet, `deepseek-flash` spent ~11 000 REASONING
   * tokens before emitting any text. At 2048 — a budget that looks generous for a
   * 600-character JSON answer — the stream ended with `max-tokens` and NO text, which
   * downstream is indistinguishable from "the model reviewed the sheet and found
   * nothing wrong". That silent approval is the failure mode this number exists to
   * prevent, and the size of it is a property of the model, not of this code.
   */
  visualReviewMaxTokens: z.number().default(24_000),
  /** Views in the standard plan, in reading order (SPEC §12.3). */
  visualReviewViews: z.array(z.string()).default(['active-camera', 'three-quarter', 'top', 'detail']),
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
    // NOTHING is added to `patch`. The ScenePatch schema is `additionalProperties:
    // false`, so annotating the document with a host-side flag rejected the patch as
    // malformed — and the rejection only appeared on the path where a caller supplied
    // its own idempotency key, which is precisely the path the visual loop uses. The
    // transaction derives "was the key explicit?" from the document itself
    // (`resolveIdempotencyKey`), so the flag was always redundant as well as harmful.
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

      // Record the new artifact in the revision's own manifest.
      //
      // Without this the manifest under-reports its own revision: it is written
      // once at commit time, so every preview rendered LATER left the
      // `previews` array listing only the ones that existed then. That made the
      // audit record disagree with the directory it describes — a caller asking
      // "what previews does r0002 have?" got one answer from the manifest and
      // three from the filesystem, and the manifest is the one that gets
      // persisted, copied into a delivery bundle, and read by the model.
      //
      // This is the one WRITE that may touch a published revision, and it is
      // deliberately an append-only amendment of the artifact index rather than a
      // change to the revision's content: the SceneSpec, the checkpoint, the
      // validation report and the manifest's identity/digest fields are all left
      // exactly as committed. A preview is produced BY a revision and is not part
      // of what that revision decided, which is why rendering does not create a
      // revision and why this amendment is not one either.
      const previews = this.store.recordRevisionPreview(projectId, revision, artifact)
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
        // The artifact just rendered, and — separately — every preview this
        // revision now has. Both are reported because a caller asking "what did I
        // just make?" and a caller asking "what does this revision have?" are
        // different questions, and conflating them is how the manifest drifted in
        // the first place.
        artifacts: [artifact],
        revisionPreviews: previews,
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
  // M2: multi-view preview and the visual review loop
  // ---------------------------------------------------------------------------

  /**
   * Render a plan of views for one revision and record the images against it.
   *
   * Rendering observes a scene, so — exactly like `renderPreview` — this creates no
   * revision. The images land in the revision's own `previews/views/` directory, and
   * the manifest's preview index is amended to list them (decision D28).
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.revision]
   * @param {object[]} [request.views] - explicit views; default is the standard plan.
   * @param {string[]} [request.track] - objects to measure by isolation.
   * @param {number} [request.frame]
   * @param {string} [request.engine]
   * @param {number} [request.width]
   * @param {number} [request.height]
   * @param {number} [request.samples]
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async renderViews(request) {
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

    const subjectId = resolveSubjectId(spec)
    const plan = Array.isArray(request.views) && request.views.length > 0
      ? request.views
      : buildViewPlan({
        spec,
        subjectId,
        frame: request.frame,
        roles: Array.isArray(request.roles) && request.roles.length > 0
          ? request.roles
          : this.config.visualReviewViews,
        maxViews: request.maxViews,
      })

    return this._renderViewPlan({
      projectId, revision, spec, digest, profile, plan, subjectId,
      track: request.track,
      engine: request.engine,
      width: request.width,
      height: request.height,
      samples: request.samples,
      signal: request.signal,
    })
  }

  /**
   * The mechanism behind {@link renderViews}: resolve a checkpoint, render the plan
   * in one Blender process, publish the PNGs into the revision, and return both the
   * artifacts and the per-view measurements that came out of the same process.
   *
   * Split from the public method because the visual loop renders the same plan for a
   * revision it has just committed, and the two must produce BYTE-IDENTICAL
   * artifact records — a review that named a different path than `renderViews` would
   * make the sheet and its images disagree about which file they describe.
   *
   * @param {object} input
   * @returns {Promise<{ views: object[], artifacts: object[], pngs: Record<string, Buffer>, warnings: object[], job: object, subjectId: string|null }>}
   */
  async _renderViewPlan(input) {
    const { projectId, revision, spec, digest, profile, plan, subjectId } = input
    /** @type {object[]} */
    const warnings = []

    const requestedSamples = input.samples ?? profile.samples
    const ceiling = Math.min(profile.maxSamplesBudget ?? this.config.maxPreviewSamples, this.config.maxPreviewSamples)
    const effectiveSamples = requestedSamples === undefined ? undefined : Math.min(requestedSamples, ceiling)
    if (effectiveSamples !== undefined && requestedSamples !== undefined && effectiveSamples < requestedSamples) {
      warnings.push(warning(
        BlenderWarningCode.RENDER_SAMPLES_REDUCED,
        `view samples reduced from ${requestedSamples} to ${effectiveSamples} by the configured budget`,
        { requested: requestedSamples, used: effectiveSamples },
      ))
    }

    const engineInfo = await this.runtime.resolveEngineKey(input.engine ?? profile.engine, { signal: input.signal })
    if (engineInfo.warning !== null) warnings.push(engineInfo.warning)

    const track = Array.isArray(input.track) && input.track.length > 0
      ? input.track
      : trackedObjects(spec, subjectId)

    const jobId = this.store.allocateJobId(projectId, 'render_views')
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    this.store.writeJob(projectId, {
      schemaVersion: 'deepblend.job/v1',
      jobId,
      projectId,
      action: 'render_views',
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

    const checkpoint = await this._resolveCheckpointForRender({ projectId, revision, spec, jobId, warnings, signal: input.signal })

    try {
      const run = await this.runtime.renderViews({
        checkpointPath: checkpoint.path,
        views: plan.map(view => ({
          id: view.id,
          role: view.role,
          cameraId: view.cameraId,
          frame: view.frame,
        })),
        track,
        engine: engineInfo.blenderEngine === null ? undefined : (input.engine ?? profile.engine),
        width: input.width ?? profile.resolution?.[0],
        height: input.height ?? profile.resolution?.[1],
        samples: effectiveSamples,
        jobId,
        signal: input.signal,
      })

      for (const entry of run.envelope.warnings ?? []) warnings.push(entry)
      for (const entry of run.envelope.notices ?? []) {
        warnings.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, entry.message, { code: entry.code }))
      }

      // Published in VIEW ORDER, and the measurement records keep that order too:
      // the contact sheet's left-to-right reading order is derived from it, and a
      // sheet whose labels disagree with the measurements is worse than a sheet with
      // no labels at all.
      const revisionDirectory = this.store.revisionDirectory(projectId, revision)
      const viewsDirectory = join(revisionDirectory, 'previews', 'views')
      mkdirSync(viewsDirectory, { recursive: true })

      const artifacts = []
      const measurements = []
      for (const entry of run.report.views ?? []) {
        if (typeof entry.outputPath !== 'string') continue
        const finalPath = resolveInside(
          this.store.projectDirectory(projectId),
          join(viewsDirectory, `${safeFileName(entry.viewId)}.png`),
          'view preview artifact',
        )
        const png = run.pngs[entry.viewId]
        if (!Buffer.isBuffer(png)) {
          throw new BlenderError(
            BlenderErrorCode.RENDER_NO_OUTPUT,
            `The Blender renderer reported success for view "${entry.viewId}" but its bytes could not be read.`,
            { detail: { viewId: entry.viewId, outputPath: entry.outputPath, jobId } },
          )
        }
        // The bytes are written by the HOST, not by Blender, so the file that gets
        // hashed is the file that gets published — Blender wrote into a scratch
        // directory that no longer exists by the time anyone reads this record.
        writeFileSync(finalPath, png)
        const relative = `revisions/${revision}/previews/views/${safeFileName(entry.viewId)}.png`
        const artifact = {
          kind: 'view',
          viewId: entry.viewId,
          role: entry.role ?? null,
          path: relative,
          cameraId: entry.cameraId ?? null,
          frame: entry.frame ?? null,
          width: entry.width ?? null,
          height: entry.height ?? null,
          engine: entry.engine ?? null,
          samples: effectiveSamples ?? null,
          bytes: png.length,
          sha256: fileSha256(finalPath),
          mime: 'image/png',
        }
        artifacts.push(artifact)
        measurements.push({
          viewId: entry.viewId,
          role: entry.role ?? null,
          cameraId: entry.cameraId ?? null,
          frame: entry.frame ?? null,
          width: entry.width ?? null,
          height: entry.height ?? null,
          engine: entry.engine ?? null,
          path: relative,
          caption: plan.find(view => view.id === entry.viewId)?.label ?? entry.viewId,
          purpose: plan.find(view => view.id === entry.viewId)?.purpose ?? null,
          metrics: entry.metrics ?? null,
        })
        this.store.recordRevisionPreview(projectId, revision, artifact)
      }

      const job = this.store.writeJob(projectId, {
        schemaVersion: 'deepblend.job/v1',
        jobId,
        projectId,
        action: 'render_views',
        revision,
        status: 'succeeded',
        errorCode: null,
        message: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        idempotencyKey: null,
        baseRevision: revision,
        artifacts,
        warnings,
      })

      return {
        views: measurements,
        artifacts,
        pngs: run.pngs,
        warnings,
        job: toCanonicalJobRecord(job),
        subjectId,
        digest,
        profile: {
          engine: profile.engine,
          blenderEngine: engineInfo.blenderEngine,
          resolution: [artifacts[0]?.width ?? profile.resolution?.[0], artifacts[0]?.height ?? profile.resolution?.[1]],
          samples: effectiveSamples,
        },
        track,
        durationMs: run.durationMs,
        checkpointRevision: checkpoint.revision,
      }
    } catch (cause) {
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
        action: 'render_views',
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
      if (checkpoint.compiled !== null) removeTree(checkpoint.compiled)
    }
  }

  /**
   * Resolve the `.blend` a render should open for one revision.
   *
   * A checkpoint is preferred when the revision has one; otherwise the revision is
   * compiled from its SceneSpec into a scratch directory, because the spec — not a
   * `.blend` — is the source of truth (SPEC §8.1). Compiling per render is slower,
   * so it is always REPORTED: a caller looking at an image must be able to tell
   * which scene state it came from.
   *
   * @param {object} input
   * @returns {Promise<{ revision: string, path: string, compiled: string|null }>}
   */
  async _resolveCheckpointForRender(input) {
    const { projectId, revision, spec, jobId, warnings } = input
    const checkpoint = this.store.findCheckpointAtOrBefore(projectId, revision)
    if (checkpoint !== null && checkpoint.revision === revision) {
      return { revision, path: checkpoint.path, compiled: null }
    }
    const compiled = await this.compileRevisionForRender({ projectId, revision, spec, jobId, signal: input.signal })
    if (checkpoint !== null && checkpoint.revision !== revision) {
      warnings.push(warning(
        BlenderWarningCode.SCENE_COMPILER_DECISION,
        `revision ${revision} has no checkpoint of its own; it was compiled from its SceneSpec for this render ` +
          `(the nearest earlier checkpoint is ${checkpoint.revision})`,
        { revision, nearestCheckpoint: checkpoint.revision },
      ))
    }
    return { revision, path: compiled.path, compiled: compiled.directory }
  }

  /**
   * Score a revision's views without rendering anything new.
   *
   * The scorer is pure, so this is the cheap half of a review: a caller that has
   * measurements — from an earlier `renderViews` call, or from a test fixture — can
   * find out what the product considers wrong without spending a render.
   *
   * @param {object} request
   * @param {object[]} request.views - measurement entries as `renderViews` returns.
   * @param {string|null} [request.subjectId]
   * @returns {{ score: number, issues: object[], perView: object[] }}
   */
  scoreVisualViews(request) {
    const views = Array.isArray(request?.views) ? request.views : []
    return scoreReview(views, { subjectId: request?.subjectId ?? null })
  }

  /**
   * One complete visual review of a revision: render, measure, compose a contact
   * sheet, score, and (unless disabled) ask the vision reviewer what it sees.
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.revision]
   * @param {string[]} [request.roles]
   * @param {boolean} [request.includeSheet] - compose and persist the sheet. Default true.
   * @param {boolean} [request.consultReviewer] - ask the vision reviewer. Default false:
   *   a review that only needs the measured score must not cost a model call.
   * @param {number} [request.iteration]
   * @param {object} [request.reviewer] - override the port (tests inject a stub).
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async visualReview(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revision = request.revision ?? record.currentRevision
    const iteration = Number.isInteger(request.iteration) ? request.iteration : 0

    const rendered = await this.renderViews({
      projectId,
      revision,
      roles: request.roles,
      frame: request.frame,
      width: request.width,
      height: request.height,
      samples: request.samples,
      track: request.track,
      engine: request.engine,
      signal: request.signal,
    })

    const sheetPath = `revisions/${revision}/contact-sheets/round-${iteration}.png`
    const built = buildVisualReview({
      projectId,
      revision,
      digest: rendered.digest,
      views: rendered.views,
      pngs: rendered.pngs,
      subjectId: rendered.subjectId,
      iteration,
      sheetPath,
    })

    // Persist the sheet into the revision and index it. The sheet is an artifact OF
    // this revision — it is what this exact scene state looked like — so a later
    // revision must not overwrite it, and the index has to say it exists.
    const revisionDirectory = this.store.revisionDirectory(projectId, revision)
    const sheetDirectory = join(revisionDirectory, 'contact-sheets')
    mkdirSync(sheetDirectory, { recursive: true })
    const sheetFile = resolveInside(
      this.store.projectDirectory(projectId),
      join(sheetDirectory, `round-${iteration}.png`),
      'contact sheet artifact',
    )
    writeFileSync(sheetFile, built.sheet.png)
    const sheetArtifact = {
      kind: 'contact-sheet',
      path: sheetPath,
      iteration,
      width: built.sheet.width,
      height: built.sheet.height,
      columns: built.sheet.columns,
      rows: built.sheet.rows,
      bytes: built.sheet.png.length,
      sha256: fileSha256(sheetFile),
      mime: 'image/png',
      views: built.sheet.placements.map(placement => placement.viewId),
    }

    const review = { ...built.review, warnings: rendered.warnings }

    if (request.consultReviewer === true) {
      const reviewer = typeof request.reviewer === 'function'
        ? request.reviewer
        : this.createVisualReviewer()
      // A failed reviewer does NOT fail the review. The render, the measurements, the
      // contact sheet and the score are all still there and all still true; the only
      // thing missing is a second opinion. Losing the sheet because a model call failed
      // would make the review strictly worse than useless — the caller would have paid
      // for four renders and received an error.
      try {
        const answer = await reviewer({
          review,
          sheetPng: built.sheet.png,
          views: rendered.views,
          iteration,
          signal: request.signal,
        })
        const context = {
          viewIds: new Set(review.perView.map(entry => entry.viewId)),
          objectIds: new Set(review.issues.map(issue => issue.objectId).filter(Boolean)),
        }
        const verified = validateFindings(answer?.findings, context)
        review.reported = verified.accepted
        review.rejected = verified.rejected
        review.reviewer = {
          model: answer?.model ?? null,
          provider: answer?.provider ?? null,
          note: typeof answer?.note === 'string' ? answer.note : null,
          proposedOperations: Array.isArray(answer?.operations) ? answer.operations.length : 0,
          raw: typeof answer?.raw === 'string' ? answer.raw : null,
          error: null,
        }
        review.suggestedOperations = Array.isArray(answer?.operations) ? answer.operations : []
      } catch (cause) {
        review.reported = []
        review.rejected = []
        review.suggestedOperations = []
        review.reviewer = {
          model: null,
          provider: null,
          note: null,
          proposedOperations: 0,
          raw: null,
          error: {
            code: cause instanceof BlenderError ? cause.code : BlenderErrorCode.RUNTIME_UNAVAILABLE,
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }
        review.warnings = [
          ...(review.warnings ?? []),
          warning(
            BlenderWarningCode.PROBE_WARNING,
            'the vision reviewer could not be consulted, so this review carries measurements and a sheet but no ' +
              `second opinion: ${review.reviewer.error.message}`,
            review.reviewer.error,
          ),
        ]
      }
    }

    const previews = this.store.recordRevisionArtifact(projectId, revision, 'contactSheets', sheetArtifact)
    const reviewArtifact = {
      kind: 'visual-review',
      path: `revisions/${revision}/visual-reviews/round-${iteration}.json`,
      iteration,
      score: review.score,
      pass: review.pass,
      issueCount: review.issues.length,
      at: new Date().toISOString(),
    }
    const reviewDirectory = join(revisionDirectory, 'visual-reviews')
    mkdirSync(reviewDirectory, { recursive: true })
    writeJsonAtomic(
      resolveInside(this.store.projectDirectory(projectId), join(reviewDirectory, `round-${iteration}.json`), 'visual review record'),
      { review, views: rendered.views },
    )
    const reviews = this.store.recordRevisionArtifact(projectId, revision, 'reviews', reviewArtifact)

    return {
      ...review,
      subjectId: rendered.subjectId,
      track: rendered.track,
      profile: rendered.profile,
      checkpointRevision: rendered.checkpointRevision,
      sheetArtifact,
      contactSheets: previews,
      reviews,
      views: rendered.views.map(view => ({
        viewId: view.viewId,
        role: view.role,
        cameraId: view.cameraId,
        frame: view.frame,
        width: view.width,
        height: view.height,
        path: view.path,
        purpose: view.purpose,
        caption: view.caption,
        objects: view.metrics?.objects ?? [],
        luminance: view.metrics?.luminance ?? null,
      })),
      job: rendered.job,
    }
  }

  /**
   * The built-in vision reviewer: one multimodal model call, parsed into findings
   * and proposed ScenePatch operations.
   *
   * Deliberately narrow. It builds a prompt from the review's own measurements plus
   * one image, streams one answer, and validates whatever comes back. Everything
   * expensive or stateful — the loop, the cap, the adoption decision — lives in
   * `visual-loop.js`, and everything about the model route lives here, so a
   * deployment that wants a different vision model changes one config value.
   *
   * @returns {(request: object) => Promise<{ findings: object[], operations: object[], note: string|null, model: string|null, provider: string|null, raw: string|null }>}
   */
  createVisualReviewer() {
    const provider = this.config.visualReviewProvider
    const model = this.config.visualReviewModel
    return async request => {
      const llm = this.ctx.get('llm')
      const attachments = this.ctx.get('attachments')
      if (llm === undefined || attachments === undefined) {
        throw new BlenderError(
          BlenderErrorCode.RUNTIME_UNAVAILABLE,
          'The vision reviewer needs the `llm` and `attachments` services, and at least one is not composed.',
          { detail: { llm: llm !== undefined, attachments: attachments !== undefined } },
        )
      }

      const ref = await attachments.saveImage({
        data: request.sheetPng,
        mediaType: 'image/png',
        name: `contact-sheet-${request.review.revision}-r${request.iteration}.png`,
      })

      // The message is built here rather than through `@deepseek-ai/dsh-llm`'s
      // `createMessage`. That helper adds nothing this call needs — a message IS
      // `{id, role, content, source}` — and importing it would make the host package
      // depend on the LLM package's internal layout, which is exactly what the
      // separate `llm` service seam exists to avoid. What the host depends on is the
      // SERVICE (`ctx.get('llm').stream`), and that dependency is one string.
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [
          { type: 'text', text: buildReviewerPrompt(request.review, request.views) },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'plugin', plugin: 'deepblend.visual-reviewer', form: 'notice', summary: 'contact sheet review' },
      }

      /** @type {object[]} */
      const chunks = []
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [message],
        // The budget must cover REASONING as well as the answer (see
        // `visualReviewMaxTokens`). The empty-answer guard below turns an exhausted
        // budget into a reported failure rather than a silent approval; this is what
        // stops it happening in the first place.
        maxTokens: this.config.visualReviewMaxTokens,
        signal: request.signal,
      })) {
        chunks.push(chunk)
      }
      const finish = chunks.find(chunk => chunk.type === 'finish')
      const usage = chunks.find(chunk => chunk.type === 'usage')
      const raw = chunks
        .filter(chunk => chunk.type === 'text-delta')
        .map(chunk => chunk.text)
        .join('')

      if (finish !== undefined && finish.reason?.kind === 'error') {
        throw new BlenderError(
          BlenderErrorCode.RUNTIME_UNAVAILABLE,
          `The vision reviewer's model call failed: ${finish.reason.failure?.message ?? 'unknown failure'}`,
          { detail: { code: finish.reason.failure?.code ?? null } },
        )
      }
      // An empty answer is a FAILURE, not a review with nothing to say. The two are
      // indistinguishable downstream — both yield zero findings — and the difference
      // matters: "the model looked and saw nothing wrong" is a result, while "the model
      // said nothing" means no review happened at all. Reporting the second as the first
      // would let a broken reviewer silently approve every scene it was shown.
      if (raw.trim().length === 0) {
        throw new BlenderError(
          BlenderErrorCode.RUNTIME_UNAVAILABLE,
          'The vision reviewer returned an empty answer, so no review took place. ' +
            `finish=${finish?.reason?.kind ?? 'none'}, chunks=${chunks.length}, ` +
            `types=${[...new Set(chunks.map(chunk => chunk.type))].join('/')}`,
          {
            detail: {
              finish: finish?.reason?.kind ?? null,
              failure: finish?.reason?.failure ?? null,
              chunkCount: chunks.length,
              usage: usage?.usage ?? null,
            },
          },
        )
      }

      const parsed = parseReviewerAnswer(raw)
      return { ...parsed, model, provider, raw }
    }
  }

  /**
   * Run the whole visual loop on a revision (SPEC §12.1).
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.revision]
   * @param {number} [request.maxIterations]
   * @param {number} [request.stopOnRepeatedIssueCount]
   * @param {number} [request.minConfidenceForAutoFix]
   * @param {boolean} [request.autoFix] - when false the loop measures and scores once
   *   and hands over immediately. That is the honest form of "review only": nothing
   *   has been fixed, so a reviewer call would only produce a proposal no one asked
   *   for. Default true.
   * @param {object} [request.reviewer] - override the vision port (tests inject a stub).
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async visualLoop(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revision = request.revision ?? record.currentRevision
    const reviewer = typeof request.reviewer === 'function' ? request.reviewer : this.createVisualReviewer()
    const autoFix = request.autoFix !== false

    const reviewPort = async ({ revision: target, iteration }) => this.visualReview({
      projectId,
      revision: target,
      iteration,
      consultReviewer: false,
      roles: request.roles,
      frame: request.frame,
      width: request.width,
      height: request.height,
      samples: request.samples,
      signal: request.signal,
    })

    const visionPort = async ({ review, round, previousRounds }) => {
      const answer = await reviewer({
        review,
        sheetPng: await this.readSheetPng(projectId, review),
        views: review.views ?? [],
        iteration: round,
        previousRounds,
        signal: request.signal,
      })
      return {
        findings: answer?.findings,
        operations: Array.isArray(answer?.operations) ? answer.operations : [],
        note: typeof answer?.note === 'string' ? answer.note : null,
        detail: { model: answer?.model ?? null, provider: answer?.provider ?? null, raw: answer?.raw ?? null },
      }
    }

    return runVisualLoop({
      projectId,
      revision,
      review: reviewPort,
      patch: patchRequest => this.applyScenePatch(patchRequest),
      restore: restoreRequest => this.restoreRevision({
        projectId: restoreRequest.projectId,
        revision: restoreRequest.revision,
      }),
      reviewer: visionPort,
      log: line => this.ctx.logger?.info?.(`[deepblend] ${line}`),
      maxIterations: autoFix ? (request.maxIterations ?? this.config.maxVisualIterations) : 0,
      stopOnRepeatedIssueCount: request.stopOnRepeatedIssueCount ?? this.config.stopOnRepeatedIssueCount,
      minConfidenceForAutoFix: request.minConfidenceForAutoFix ?? this.visualConfidence(),
      signal: request.signal,
    })
  }

  /**
   * Read a review's contact sheet back as bytes, so the reviewer port can be handed
   * an image rather than a path.
   *
   * The sheet is written to disk first because it is a real artifact OF the revision
   * (a human reviewing the run needs the same image the model saw), and reading it
   * back keeps one representation of it rather than two.
   *
   * @param {string} projectId
   * @param {object} review
   * @returns {Promise<Buffer>}
   */
  async readSheetPng(projectId, review) {
    const path = review?.sheet?.path
    if (typeof path !== 'string' || path.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_NO_OUTPUT,
        'The visual review has no contact sheet recorded, so there is nothing to show the reviewer.',
      )
    }
    const absolute = resolveInside(this.store.projectDirectory(projectId), join(this.store.projectDirectory(projectId), path), 'contact sheet')
    const { readFile } = await import('node:fs/promises')
    return readFile(absolute)
  }

  /** The confidence floor, clamped into [0, 1] so a bad config cannot disable review. */
  visualConfidence() {
    const value = this.config.minVisualConfidenceForAutoFix
    return typeof value === 'number' && value >= 0 && value <= 1 ? value : 0.8
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
      `blenderStudio.${operation} is not implemented yet. ${milestone} delivers it; ` +
        'the implemented surface is the batch SceneSpec loop and the M2 visual review loop.',
      { detail: { operation, milestone } },
    )
  }

  /** @returns {never} */
  startFinalRender() { return this._notImplemented('startFinalRender', 'M3') }
  /** @returns {never} */
  exportProject() { return this._notImplemented('exportProject', 'M3') }
}

/**
 * The exact text the vision reviewer is asked to answer.
 *
 * Structure, and why each part is there:
 *
 *  1. What it is looking at, view by view, with the CELL each view occupies on the
 *     sheet. Without the layout, a model asked about "the top view" has to infer
 *     which tile that is, and a mislabelled finding produces a confident, wrong fix.
 *  2. The measurements, as prose. They are the score's own basis, so the model and
 *     the scorer argue about the same facts.
 *  3. A response contract: strict JSON, findings grounded in a named view, and
 *     operations limited to the vocabulary that actually exists. A free-form answer
 *     is unparseable; an unconstrained operation list would be a hole in the
 *     "no free-form edit" rule (SPEC §11.1).
 *
 * @param {object} review
 * @param {object[]} views
 * @returns {string}
 */
export function buildReviewerPrompt(review, views) {
  const lines = []
  lines.push('You are reviewing a rendered 3D scene for an animation pipeline. One contact sheet is attached:')
  lines.push('each cell is one view, in reading order left to right then top to bottom.')
  lines.push('')
  lines.push('Views on the sheet:')
  const placements = Array.isArray(review.sheet?.placements) ? review.sheet.placements : []
  for (const placement of placements) {
    const view = (views ?? []).find(entry => entry.viewId === placement.viewId)
    const purpose = view?.purpose ? ` — ${view.purpose}` : ''
    lines.push(
      `  cell (row ${placement.row + 1}, column ${placement.column + 1}) = view "${placement.viewId}"` +
      `, camera ${view?.cameraId ?? '?'}, frame ${view?.frame ?? '?'}${purpose}`,
    )
  }
  lines.push('')
  lines.push('Measurements taken from the rendered pixels (these are facts, not estimates):')
  for (const view of views ?? []) {
    const luminance = view.luminance
    if (luminance !== null && luminance !== undefined) {
      lines.push(
        `  view "${view.viewId}": mean luminance ${luminance.mean}, p05 ${luminance.p05}, p95 ${luminance.p95}, ` +
        `clipped dark ${luminance.clippedDarkFraction}, clipped bright ${luminance.clippedBrightFraction}`,
      )
    }
    for (const object of view.objects ?? []) {
      lines.push(
        `    object "${object.id}": ${object.visiblePixels} visible px of ${object.silhouettePixels} silhouette px` +
        `${Array.isArray(object.bbox) ? `, bbox ${JSON.stringify(object.bbox)}` : ''}` +
        `${Array.isArray(object.centroid) ? `, centroid ${JSON.stringify(object.centroid)}` : ''}` +
        `, fully inside frame: ${object.inFrame === true}`,
      )
    }
  }
  lines.push('')
  lines.push(`An automated scorer measured ${review.issues.length} problem(s) and scored this ${review.score}/100:`)
  if (review.issues.length === 0) {
    lines.push('  (none)')
  } else {
    for (const issue of review.issues) {
      lines.push(
        `  [${issue.severity}] ${issue.code} in view "${issue.viewId}"` +
        `${issue.objectId ? ` on "${issue.objectId}"` : ''}: ${issue.evidence}`,
      )
    }
  }
  lines.push('')
  lines.push('Answer with STRICT JSON only, no prose around it, in exactly this shape:')
  lines.push('{')
  lines.push('  "findings": [')
  lines.push('    { "category": "composition" | "exposure" | "occlusion",')
  lines.push('      "viewId": "<one of the view ids above>",')
  lines.push('      "objectId": "<object id or null>",')
  lines.push('      "severity": "minor" | "major" | "critical",')
  lines.push('      "confidence": 0.0-1.0,')
  lines.push('      "evidence": "<what you can see on the sheet that shows this>" }')
  lines.push('  ],')
  lines.push('  "operations": [ { "op": "<operation>", ... } ],')
  lines.push('  "note": "<one sentence on what you changed and why>"')
  lines.push('}')
  lines.push('')
  lines.push('Rules:')
  lines.push('  - Report only what the IMAGE shows. Do not restate a measurement; add what a number cannot say.')
  lines.push('  - A finding whose viewId is not one of the views above is DISCARDED, so name a real view.')
  lines.push('  - "operations" must use only these ScenePatch operations, and they are applied all-or-nothing:')
  lines.push('      entity.transform.update {entityId, location?, rotationEuler?, scale?}')
  lines.push('      entity.visibility.set {entityId, visible}')
  lines.push('      entity.material.set {entityId, materialId}')
  lines.push('      material.parameter.update {materialId, parameter, value}')
  lines.push('      light.update {lightId, energy?, color?, size?, transform?}')
  lines.push('      camera.update {cameraId, lens?, transform?, targetEntityId?, targetPoint?}')
  lines.push('      render.profile.set {profileName, profile}')
  lines.push('  - Prefer the SMALLEST change that fixes the largest problem. An empty list is a valid answer.')
  return lines.join('\n')
}

/**
 * Parse the reviewer's answer out of whatever the model actually produced.
 *
 * Models wrap JSON in prose or fences even when told not to, so the first `{` to the
 * last `}` is extracted rather than trusting the whole reply. A reply that genuinely
 * contains no JSON yields empty findings and no operations — a review with no
 * proposal, which the loop treats as "nothing to do" rather than as a crash.
 *
 * @param {string} raw
 * @returns {{ findings: object[], operations: object[], note: string|null }}
 */
export function parseReviewerAnswer(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { findings: [], operations: [], note: null }
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { findings: [], operations: [], note: null }
  }
  if (parsed === null || typeof parsed !== 'object') return { findings: [], operations: [], note: null }
  return {
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    operations: Array.isArray(parsed.operations) ? parsed.operations : [],
    note: typeof parsed.note === 'string' ? parsed.note : null,
  }
}

/**
 * A file-name-safe form of a view id.
 *
 * View ids come from a view plan, which a caller may supply, and they become file
 * names inside a published revision. Anything that could traverse or separate is
 * replaced rather than rejected: a view id is a label, and refusing a whole review
 * over a stray slash would be a worse trade than a normalised file name — but the
 * normalisation must happen, because the alternative is writing outside the
 * revision directory (SPEC §15.2).
 *
 * @param {string} viewId
 * @returns {string}
 */
function safeFileName(viewId) {
  const cleaned = String(viewId).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 96) : 'view'
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
