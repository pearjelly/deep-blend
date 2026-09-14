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
  resolveSubject,
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
  subjectParts,
  trackedObjects,
  validateFindings,
  validateSceneSpec,
  warning,
  // M4 — the preview pair the workbench compares
  PREVIEW_SHEET_SLOTS,
  composeContactSheet,
  // M3 — the persistent render job
  HOST_API_VERSION,
  RENDER_JOB_VERSION,
  describeRenderJob,
  estimateRemaining,
  frameFileName,
  frameNumbers,
  renderProgressPercent,
  verifyVideoProperties,
  // M5 — the two roots the host and the provider must agree on
  resolveProjectsRoot,
  resolveWorkspaceRoot,
  IMPORT_OPERATOR_BY_ASSET_TYPE,
  ASSET_HEAD_BYTES,
  assetContentVerdict,
  describeAssetContent,
} from '@deepblend/dsh-blender-contracts'

import { ProjectStore, GENESIS_REVISION, parseRevisionId } from './project-store.js'
import { RenderJobStore, UNFINISHED_STATUSES } from './render-job-store.js'
import { RevisionTransaction } from './revision-transaction.js'
import { inspectFrameSample, readFrameLedger, sampleFrame } from './frame-ledger.js'
import { JournalTail } from './render-journal.js'
import { checkProcessAlive, reconcileRenderJob, stopProcessGroup } from './render-reconciler.js'
import { encodeFrameSequence, encodedPath, probeVideo } from './video-encoder.js'
import { buildDeliveryManifest } from './delivery-manifest.js'
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'

import {
  fileSha256,
  fileSize,
  isFile,
  readJson,
  readJsonSafe,
  removeTree,
  requireSafeSegment,
  resolveInside,
  writeJsonAtomic,
} from './paths.js'

/** Service key registered into the Cordis context. */
export const BLENDER_STUDIO_SERVICE = 'blenderStudio'

/**
 * Content type of a project artifact, from its extension.
 *
 * A closed map rather than a library: the browser displays previews and reads
 * manifests, and anything else is served as bytes so a mistake cannot become a
 * script the UI is tricked into running.
 *
 * @param {string} path
 * @returns {string}
 */
export function contentTypeForArtifact(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.json': return 'application/json; charset=utf-8'
    case '.txt':
    case '.log': return 'text/plain; charset=utf-8'
    case '.mp4': return 'video/mp4'
    default: return 'application/octet-stream'
  }
}

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
  /**
   * Directory holding DeepBlend projects. Unset, it is `<workspaceRoot>/projects`
   * (SPEC §13's `workspace/projects/…`), so overriding one root moves the other
   * with it instead of leaving the two disagreeing.
   */
  projectsRoot: z.string().default(''),
  /**
   * Workspace root that staging and provider scratch directories must stay
   * inside (SPEC §15.2). Must be the SAME root the provider is configured with,
   * or a staging path the host hands out would be one the provider refuses.
   *
   * Unset, it defaults to `<DSH_HOME>/deepblend` (SPEC §17). Both rows resolve it
   * through the same `resolveWorkspaceRoot`, which is what makes them agree.
   */
  workspaceRoot: z.string().default(''),
  /** Serve a cached capabilities document without re-probing during a page load. */
  serveCachedCapabilities: z.boolean().default(true),
  /** Refuse a preview whose sample count exceeds this, however it was asked for. */
  maxPreviewSamples: z.number().default(512),
  /**
   * Ceiling on one ingested asset, in bytes. SPEC §15's example is 1 GiB.
   *
   * Checked against the source BEFORE it is copied, and again while a remote one
   * streams, because a limit applied after the transfer is a description of what
   * already happened rather than a control on it.
   */
  assetMaxBytes: z.number().default(1_073_741_824),
  /**
   * Ceiling on the polygons one compiled scene may carry (SPEC §15.2 "Mesh 面数限制").
   *
   * THE COUNT IS MEASURED, NOT GUESSED AT: the provider's compile report already carries
   * `sceneFingerprint.totalPolygons` for the revision manifest, so this compares a number
   * that exists rather than estimating one from the SceneSpec. A scene over the ceiling is
   * refused with `SCENE_TOO_HEAVY`, before the revision is published.
   *
   * WHY IT IS NOT REDUNDANT WITH THE TIMEOUT. `timeoutMs` bounds ONE Blender invocation; a
   * scene five times heavier than intended usually finishes each invocation inside it and
   * then costs that much on every compile, every preview and every delivery render for the
   * rest of the project's life — including a three-hour final render nobody wants any more.
   * The two failures also read differently: a timeout says "try again or raise the
   * deadline", and this says "this asset brought 8,412,004 polygons".
   *
   * The default is generous on purpose. A product turntable is a few hundred polygons and
   * the golden fixture is 243; two million is the point at which a scene stops being a
   * product shot and becomes a scan, which is a decision an operator should make by raising
   * this number rather than by discovering it as a timeout.
   */
  maxMeshPolygons: z.number().default(2_000_000),

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

  // ---- M3: the persistent render job (SPEC §10, §17) ----------------------

  /**
   * The render profile a delivery uses.
   *
   * A NAME into the SceneSpec's own `renderProfiles`, not a copy of its settings:
   * the spec is the source of truth for how a project renders (SPEC §8.1), and a
   * second copy of "1920x1080 / 256 samples / AgX" in the Host composition is the
   * shape of defect this repository has already paid for four times (D38, D43).
   */
  finalRenderProfile: z.string().default('final'),
  /**
   * Ceiling on the samples a DELIVERY render may use.
   *
   * Separate from `maxPreviewSamples` on purpose. That one exists to stop the
   * model spending money on previews (SPEC §16.1/§16.2); applying it to a delivery
   * would silently rewrite `watch-commercial`'s 256 samples down to 512-capped —
   * except the reverse: it would cap a 256-spp delivery at 512 and change nothing,
   * while capping a legitimate 1024-spp delivery at 512 and changing everything.
   * The profile's own `maxSamplesBudget` is the intended ceiling (SPEC §17).
   */
  maxFinalSamples: z.number().default(4096),
  /** ffmpeg executable: an absolute path, or a bare PATH name. */
  ffmpegPath: z.string().default('ffmpeg'),
  /** ffprobe executable: an absolute path, or a bare PATH name. */
  ffprobePath: z.string().default('ffprobe'),
  /** x264 quality knob for the delivery encode. Lower is better and larger. */
  encodeCrf: z.number().default(18),
  /** x264 speed/size preset for the delivery encode. */
  encodePreset: z.string().default('medium'),
  /**
   * Delivery renders above this many frames require an approval the caller must
   * have obtained (SPEC §15.1 "高成本最终渲染达阈值审批", §17
   * `requireApprovalAboveFrames`). The Host records the requirement; the approval
   * itself belongs to the harness' approval plane (M5 wires the prompt).
   */
  requireApprovalAboveFrames: z.number().default(900),
  /**
   * How often a running render folds its journal into the recorded progress.
   *
   * One second against frames that take 19.6-41.4 s each: frequent enough that a
   * reader never sees a stale count, rare enough that the polling is invisible
   * beside the render it is describing.
   */
  progressPollMs: z.number().default(1000),
  /**
   * Run the restart reconciler when this Host is constructed (SPEC §10.3).
   *
   * On by default. Off only for a test that needs a clean slate, because a
   * reconciler that has to be remembered is a reconciler that will be forgotten —
   * and the one time it matters is the one time nobody remembers.
   */
  reconcileOnStart: z.boolean().default(true),
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

    // Resolved ONCE, here, and every consumer below uses these two values rather
    // than `config.*`. An unresolved `projectsRoot` must follow the resolved
    // `workspaceRoot`, or overriding one would leave the other pointing at a
    // different deployment's directory — and the provider, which resolves its own
    // copy through the same helper, would then refuse the host's staging paths.
    const workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot)
    const projectsRoot = resolveProjectsRoot(config.projectsRoot, workspaceRoot)
    this.workspaceRoot = workspaceRoot
    this.projectsRoot = projectsRoot

    this.store = new ProjectStore({ projectsRoot, workspaceRoot })
    this.transactions = new RevisionTransaction({ store: this.store, runtime: this.runtime, config })

    // ---- M3: the persistent render job (SPEC §10) --------------------------
    this.renderJobs = new RenderJobStore({
      projectDirectory: projectId => this.store.projectDirectory(projectId),
      workspaceRoot,
    })
    /** Live renders, keyed by render job id, so cancel can reach the handle. */
    this._liveRenders = new Map()
    /** The reconciliation pass, so a caller (or a test) can await the answer. */
    this._reconciliation = null
    /** Findings from the most recent pass, kept for the job surface. */
    this._recoveryFindings = []

    if (config.reconcileOnStart === true) this._kickReconciliation()
  }

  /** @type {Promise<import('@deepblend/dsh-blender-contracts').BlenderCapabilities>|null} */
  _inFlight

  /** @type {Map<string, object>} */
  _liveRenders

  /** @type {Promise<object[]>|null} */
  _reconciliation

  /** @type {object[]} */
  _recoveryFindings

  /** @returns {import('@deepblend/dsh-blender-provider-local').default} */
  get runtime() {
    return this.ctx.blenderRuntime
  }

  /**
   * The host API this service implements.
   *
   * A NUMBER, and the reason is a measurement: with M3's tools loaded against a
   * pre-M3 host, method probing detected `resumeRenderJob`/`listJobs` as missing but
   * saw `startFinalRender`/`exportProject` as present — because M1 implemented them
   * as stubs that throw. So `typeof` answered "fine" for the two entry points that
   * would have failed worst, and the guard would have covered four of six.
   *
   * @returns {number}
   */
  hostApiVersion() {
    return HOST_API_VERSION
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
    const compiledPath = join(scratch, 'scene.blend')
    await this.runtime.compileScene({
      sceneSpecPath: specPath,
      projectRoot: this.store.projectDirectory(projectId),
      jobId: input.jobId,
      signal: input.signal,
      // THIS CALLBACK IS A WINDOW, NOT A NOTIFICATION. The provider removes the
      // per-invocation directory as soon as it returns, so an artifact that matters
      // has to MOVE here — which is what the provider's own contract says
      // ("the caller must be able to move those bytes somewhere durable BEFORE the
      // directory is removed").
      //
      // This callback used to only CHECK for `result.blend` and record a destination
      // path, without ever writing it. `produced` then named a file nothing had
      // created, the `isFile(produced)` check below failed, and the whole
      // compile-for-render path threw `REVISION_CHECKPOINT_MISSING` — always, for
      // every revision. MEASURED by rendering a revision committed with
      // `saveCheckpoint:false` on a project whose previous revision HAD a checkpoint:
      // "Revision r0002 was compiled for rendering but produced no checkpoint."
      //
      // The visible consequence was that `saveCheckpoint:false` was a trap rather
      // than a fast path: the commit skipped the compile, and every later preview of
      // that revision was impossible — even though SceneSpec is the source of truth
      // (SPEC §8.1) and a `.blend` is by design a rebuildable artifact.
      onWorkingDirectory: info => {
        const candidate = join(info.directory, 'result.blend')
        if (!isFile(candidate)) return
        copyFileSync(candidate, compiledPath)
        produced = compiledPath
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

    const subject = resolveSubject(spec)
    const planned = Array.isArray(request.views) && request.views.length > 0
      ? { views: request.views, notices: [] }
      : buildViewPlan({
        spec,
        subjectId: subject.id,
        frame: request.frame,
        // The caller's roles are strict; the configured set is only a preference.
        roles: request.roles,
        preferredRoles: this.config.visualReviewViews,
        maxViews: request.maxViews,
      })

    // Why the subject is what it is, and what the plan could not cover, are both
    // warnings rather than silence: a review that quietly scored a 2.5 mm marker, or
    // that covered two views of four, reads downstream as a clean review of the shot.
    const warnings = []
    if (subject.candidates.length > 1) {
      warnings.push(warning(
        BlenderWarningCode.SCENE_COMPILER_DECISION,
        `the subject was resolved to "${subject.id}" because ${subject.source}`,
        { subjectId: subject.id, candidates: subject.candidates.slice(0, 8), source: subject.source },
      ))
    }
    for (const notice of planned.notices) {
      warnings.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, notice, { kind: 'view-plan' }))
    }

    return this._renderViewPlan({
      projectId, revision, spec, digest, profile, plan: planned.views, subjectId: subject.id,
      initialWarnings: warnings,
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
    // Warnings raised by the CALLER's own decisions (which subject, which views) come
    // first, so a reader sees "this review covers two views of four" before it sees
    // "samples were reduced".
    const warnings = [...(input.initialWarnings ?? [])]

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
    // Entities the scene declared part of the subject's own body. Sent to the renderer
    // because only a ray cast can tell what is in front of the subject, and only the
    // scene can say whether that thing IS the subject (see `_visibility`).
    const parts = subjectParts(spec)

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
        parts,
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
          // WHEN this was produced. A preview is an EMITTED artifact: rendering one
          // replaces the files at the same paths (D28), so without a timestamp the
          // only trace of "I just rendered this" is the sha changing — which a
          // human cannot see, and which a UI that keys its <img> on the path alone
          // does not even re-fetch. Recorded here rather than inferred by a reader.
          at: new Date().toISOString(),
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

      // ── one preview render = one sheet, and one generation kept back ──────
      //
      // Why the render composes a sheet at all: the individual views change on disk
      // but nothing in the panel displayed them, so a person who clicked render saw
      // "已渲染 7 个视角" and a screen identical to the one before (measured; §13.5B).
      // Why it keeps the PREVIOUS one: a preview replaces its own image, so without
      // a kept generation the panel can only ever show the present — and the
      // question a person has after a render is "what changed?".
      //
      // The sheet the REVIEW path writes (`contact-sheets/round-N.png`, the image the
      // model was shown) is deliberately untouched: it is evidence for a review, and
      // overwriting it would rewrite what a reviewer looked at.
      let previewSheets = null
      if (run.pngs !== undefined && run.pngs !== null && Object.keys(run.pngs).length > 0) {
        const directory = join(this.store.revisionDirectory(projectId, revision), 'contact-sheets')
        mkdirSync(directory, { recursive: true })
        const built = composeContactSheet({
          views: measurements
            .filter(view => Buffer.isBuffer(run.pngs[view.viewId]))
            .map(view => ({ viewId: view.viewId, label: view.caption ?? view.viewId, png: run.pngs[view.viewId] })),
          title: `${projectId} ${revision} preview ${new Date().toISOString()}`,
        })
        const currentFile = resolveInside(this.store.projectDirectory(projectId), join(directory, 'preview-current.png'), 'preview sheet')
        const previousFile = resolveInside(this.store.projectDirectory(projectId), join(directory, 'preview-previous.png'), 'previous preview sheet')

        // Rotate FIRST, then write the new one: the file that was current becomes the
        // comparison, and its digest is recomputed from the bytes that are now there
        // rather than carried over from the manifest.
        let previousArtifact = null
        if (isFile(currentFile)) {
          // WHEN the rotated sheet was produced is the previous render's time, not
          // this one's. Stamping `now` here made the pane claim a sheet rendered
          // minutes earlier was "渲染于 <this render's clock>" — measured in the real
          // GUI, where both panes read 07:11:58 while only one of them was rendered
          // then. The time comes from the artifact that is being rotated; a store
          // written before artifacts carried `at` falls back to now, which is wrong
          // by at most one render.
          const priorCurrent = (this.store.readRevisionManifest(projectId, revision)?.contactSheets ?? [])
            .find(entry => entry.slot === PREVIEW_SHEET_SLOTS.current)
          copyFileSync(currentFile, previousFile)
          previousArtifact = {
            kind: 'contact-sheet',
            slot: PREVIEW_SHEET_SLOTS.previous,
            path: `revisions/${revision}/contact-sheets/preview-previous.png`,
            iteration: null,
            width: built.width,
            height: built.height,
            columns: built.columns,
            rows: built.rows,
            bytes: fileSize(previousFile),
            sha256: fileSha256(previousFile),
            mime: 'image/png',
            views: built.placements.map(placement => placement.viewId),
            at: priorCurrent?.at ?? new Date().toISOString(),
          }
        }
        writeFileSync(currentFile, built.png)
        const currentArtifact = {
          kind: 'contact-sheet',
          slot: PREVIEW_SHEET_SLOTS.current,
          path: `revisions/${revision}/contact-sheets/preview-current.png`,
          iteration: null,
          width: built.width,
          height: built.height,
          columns: built.columns,
          rows: built.rows,
          bytes: built.png.length,
          sha256: fileSha256(currentFile),
          mime: 'image/png',
          views: built.placements.map(placement => placement.viewId),
          at: new Date().toISOString(),
        }
        if (previousArtifact !== null) this.store.recordRevisionArtifact(projectId, revision, 'contactSheets', previousArtifact)
        this.store.recordRevisionArtifact(projectId, revision, 'contactSheets', currentArtifact)
        previewSheets = { current: currentArtifact, previous: previousArtifact }
        artifacts.push(currentArtifact)
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
        // Named explicitly: the route that renders a preview reports which revision it
        // wrote into, and without this field it reported `null` — a message that read
        // "written into null's previews" while the panel's own label said r0029.
        revision,
        views: measurements,
        artifacts,
        previewSheets,
        pngs: run.pngs,
        warnings,
        job: toCanonicalJobRecord(job),
        subjectId,
        parts,
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
      at: new Date().toISOString(),
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
      // Which tracked entities the SCENE declared part of the subject's own body.
      // Surfaced because it changes how an occlusion finding should be read: a part in
      // front of the subject is the product, and a part invisible in every view is a
      // missing component. A reader that cannot see the declaration cannot tell those
      // apart from the measurement alone.
      parts: rendered.parts ?? [],
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

  // ---------------------------------------------------------------------------
  // Assets (SPEC §11 "导入用户资产": local automatic, network requires approval)
  // ---------------------------------------------------------------------------

  /**
   * Bring one file into a project's `assets/raw/` and describe it.
   *
   * WHY THE HOST OWNS THIS AND NOT THE TOOL
   * ---------------------------------------
   * Three of the four things that can go wrong here are policy, and policy belongs
   * where every caller passes:
   *
   *   - the DESTINATION is a path inside the project, so it goes through the same
   *     `resolveInside` guard as every other write (SPEC §15.2);
   *   - the SIZE is capped by `assetMaxBytes` (SPEC §15);
   *   - a REMOTE source needs a grant, and the host refuses one that arrives without
   *     it — the tool plane is simply the only place that can ask.
   *
   * The fourth, the format, is checked here for a fast, precise refusal and checked
   * again behaviourally by the compiler (D10): `hasattr` cannot tell whether an
   * importer works in this build, so the definitive answer is the one that comes from
   * trying it.
   *
   * This does NOT commit a revision. It puts bytes on disk and returns the descriptor
   * a `scene-patch` `asset.add` operation then declares — so the scene still changes
   * through exactly one path, and an ingest that is never declared leaves a file
   * nobody references rather than a scene nobody checked.
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.sourcePath] - absolute path to a local file
   * @param {string} [request.sourceUrl] - http(s) URL; requires `approved: true`
   * @param {string} [request.assetId] - defaults to a slug of the file name
   * @param {string} [request.type] - defaults to the extension
   * @param {boolean} [request.approved] - the caller's assertion that a person agreed
   * @param {AbortSignal} [request.signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  async ingestAsset(request) {
    const projectId = requireSafeSegment(request?.projectId, 'project id')
    const record = this.store.readRecord(projectId)

    const sourcePath = typeof request?.sourcePath === 'string' && request.sourcePath.length > 0
      ? request.sourcePath
      : null
    const sourceUrl = typeof request?.sourceUrl === 'string' && request.sourceUrl.length > 0
      ? request.sourceUrl
      : null
    if (sourcePath === null && sourceUrl === null) {
      throw new BlenderError(
        BlenderErrorCode.ASSET_SOURCE_NOT_FOUND,
        'ingestAsset needs either sourcePath (a local file) or sourceUrl (a remote one).',
      )
    }
    if (sourcePath !== null && sourceUrl !== null) {
      throw new BlenderError(
        BlenderErrorCode.ASSET_REQUEST_INVALID,
        'ingestAsset takes a local source or a remote one, not both.',
      )
    }

    // A remote source is the one that reaches off this machine, so it is the one that
    // needs a person. Refused BEFORE anything is fetched or written.
    if (sourceUrl !== null && request?.approved !== true) {
      throw new BlenderError(
        BlenderErrorCode.ASSET_APPROVAL_REQUIRED,
        `Importing ${sourceUrl} fetches bytes from the network, which needs approval (SPEC §11 ` +
          '"本地自动，网络需审批"). Nothing has been downloaded. Ask the operator, then re-issue with ' +
          'approved:true — or point at a local file with sourcePath, which needs no approval.',
        { detail: { projectId, sourceUrl, maxBytes: this.config.assetMaxBytes } },
      )
    }

    // ---- where it comes from ------------------------------------------------
    let staged = null
    let name = null
    if (sourcePath !== null) {
      const resolvedSource = resolve(sourcePath)
      let stats
      try {
        stats = statSync(resolvedSource)
      } catch {
        throw new BlenderError(
          BlenderErrorCode.ASSET_SOURCE_NOT_FOUND,
          `no file at ${resolvedSource}.`,
          { detail: { sourcePath: resolvedSource } },
        )
      }
      if (!stats.isFile()) {
        throw new BlenderError(
          BlenderErrorCode.ASSET_SOURCE_NOT_FOUND,
          `${resolvedSource} is not a regular file.`,
          { detail: { sourcePath: resolvedSource } },
        )
      }
      if (stats.size > this.config.assetMaxBytes) {
        throw new BlenderError(
          BlenderErrorCode.ASSET_TOO_LARGE,
          `${resolvedSource} is ${stats.size} bytes, above the configured assetMaxBytes of ` +
            `${this.config.assetMaxBytes} (SPEC §15).`,
          { detail: { sourcePath: resolvedSource, bytes: stats.size, maxBytes: this.config.assetMaxBytes } },
        )
      }
      staged = resolvedSource
      name = basename(resolvedSource)
    } else {
      staged = await this._fetchAssetToScratch(sourceUrl, request?.signal)
      name = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() ?? 'asset')
    }

    // ---- what it is ---------------------------------------------------------
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
    const type = typeof request?.type === 'string' && request.type.length > 0 ? request.type : extension
    if (!(type in IMPORT_OPERATOR_BY_ASSET_TYPE)) {
      throw new BlenderError(
        BlenderErrorCode.ASSET_FORMAT_UNAVAILABLE,
        `"${name}" is a ${type === '' ? 'file with no extension' : `.${type} file`}; this project can carry ` +
          `${Object.keys(IMPORT_OPERATOR_BY_ASSET_TYPE).join(', ')}.`,
        { detail: { name, type, supported: Object.keys(IMPORT_OPERATOR_BY_ASSET_TYPE) } },
      )
    }

    // ---- and what its BYTES are ---------------------------------------------
    //
    // SPEC §15.2 "MIME 与扩展名双重校验": the extension picked the import operator, and this
    // is the second half — 512 bytes read off the STAGED file, before anything is copied into
    // the project, so a refusal costs nothing and leaves nothing. It reads the head with
    // `readSync` rather than `readFileSync` because a legitimate asset can be a gigabyte.
    //
    // Only a POSITIVE contradiction is refused (see `contracts/lib/asset-content.js`): a
    // known signature for another format, a NUL in a format that must be text, or an empty
    // file. The alternative — a matcher sure enough to accept as well as refuse — is also a
    // matcher sure enough to reject somebody's legitimate model, and deciding what a file
    // really is stays Blender's job (D10).
    const head = readFileHead(staged, ASSET_HEAD_BYTES)
    if (assetContentVerdict(head, type) === 'contradicts') {
      const described = describeAssetContent(head)
      const looksLike = described.empty
        ? 'an empty file'
        : (described.signature?.label ?? 'binary content, not text')
      throw new BlenderError(
        BlenderErrorCode.ASSET_CONTENT_MISMATCH,
        `"${name}" is named as a .${type} file, but its first bytes are ${looksLike}. ` +
          'This is checked before the bytes are copied anywhere, so nothing was written. ' +
          'Rename the file if the extension is wrong, or pass sourcePath for the file that really holds the model.',
        { detail: { name, type, headBytes: head.length, signature: described.signature?.format ?? null, empty: described.empty } },
      )
    }

    const assetId = typeof request?.assetId === 'string' && request.assetId.length > 0
      ? request.assetId
      : (() => {
          // The file name without its extension, reduced to the id grammar. A name that
          // cannot become an id is not guessed at: the caller is told to pass one,
          // because a silently different id is how a scene ends up declaring an asset
          // nobody can find.
          const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
          return stem
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^[^a-zA-Z]+/, '')
            .replace(/[-._]+$/, '')
        })()
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(assetId)) {
      throw new BlenderError(
        BlenderErrorCode.PATH_SEGMENT_INVALID,
        `"${assetId}" cannot be an asset id: ids start with a letter and use letters, digits, ".", "_" and "-". ` +
          'Pass assetId explicitly.',
        { detail: { assetId, name } },
      )
    }

    // ---- where it goes ------------------------------------------------------
    //
    // `assets/raw/` keeps the ingested bytes distinguishable from anything a later
    // step derives from them (SPEC §13's tree has `raw/`, `normalized/` and
    // `textures/`), and it is the directory the SceneSpec's asset paths are written
    // against.
    const relativePath = `assets/raw/${requireSafeSegment(name, 'asset file name')}`
    const destination = resolveInside(
      this.store.projectDirectory(projectId),
      relativePath,
      'asset destination',
    )
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(staged, destination)

    const bytes = statSync(destination).size
    if (bytes > this.config.assetMaxBytes) {
      removeTree(destination)
      throw new BlenderError(
        BlenderErrorCode.ASSET_TOO_LARGE,
        `the ingested asset is ${bytes} bytes, above the configured assetMaxBytes of ${this.config.assetMaxBytes}.`,
        { detail: { bytes, maxBytes: this.config.assetMaxBytes } },
      )
    }
    const sha256 = fileSha256(destination)

    // The manifest is a ledger beside the bytes, not a second source of truth: a file
    // whose entry is missing is still usable, and an entry whose file is missing is
    // what `SCENE_ASSET_NOT_INGESTED` warns about. It is written after the copy so it
    // never describes something that is not there.
    const manifestPath = join(this.store.projectDirectory(projectId), 'assets', 'manifest.json')
    const manifest = readJsonSafe(manifestPath) ?? { schemaVersion: 'deepblend.assets/v1', assets: [] }
    const entry = {
      assetId,
      type,
      path: relativePath,
      sha256,
      bytes,
      source: sourceUrl !== null ? { kind: 'url', url: sourceUrl } : { kind: 'local', path: sourcePath },
      ingestedAt: new Date().toISOString(),
    }
    const assets = [...(manifest.assets ?? []).filter(candidate => candidate.assetId !== assetId), entry]
      .sort((left, right) => (left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0))
    writeJsonAtomic(manifestPath, { schemaVersion: 'deepblend.assets/v1', assets })

    return {
      projectId,
      assetId,
      type,
      path: relativePath,
      sha256,
      bytes,
      source: entry.source,
      manifestPath: 'assets/manifest.json',
      currentRevision: record.currentRevision,
      nextStep:
        `declare it with blender_scene_patch: {op: "asset.add", asset: {id: "${assetId}", type: "${type}", ` +
        `path: "${relativePath}", sha256: "${sha256}"}}`,
    }
  }

  /**
   * Fetch a remote asset into scratch space, with a byte cap enforced WHILE reading.
   *
   * The cap is applied to the stream rather than to `Content-Length`, because a header
   * is a claim and the bytes are the fact — a response that lies about its length, or
   * declares none and streams forever, must stop at the same place. The scratch file
   * is removed on every failure path: a half-downloaded asset is not an asset, and
   * leaving one behind would make the next attempt's "does it exist" answer wrong.
   *
   * @param {string} url
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>} absolute path to the fetched file
   */
  async _fetchAssetToScratch(url, signal) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new BlenderError(BlenderErrorCode.ASSET_FETCH_FAILED, `"${url}" is not a URL.`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BlenderError(
        BlenderErrorCode.ASSET_FETCH_FAILED,
        `"${parsed.protocol}" is not a protocol this will fetch; use http or https.`,
        { detail: { protocol: parsed.protocol } },
      )
    }

    const scratchDirectory = resolveInside(
      this.store.workspaceRoot,
      join(this.store.workspaceRoot, 'tmp', `asset-${randomUUID()}`),
      'asset scratch directory',
    )
    mkdirSync(scratchDirectory, { recursive: true })
    const target = join(scratchDirectory, 'download')

    try {
      const response = await fetch(parsed, { redirect: 'follow', signal })
      if (!response.ok) {
        throw new BlenderError(
          BlenderErrorCode.ASSET_FETCH_FAILED,
          `${url} answered HTTP ${response.status}.`,
          { detail: { url, status: response.status } },
        )
      }
      const chunks = []
      let received = 0
      for await (const chunk of response.body ?? []) {
        received += chunk.byteLength
        if (received > this.config.assetMaxBytes) {
          throw new BlenderError(
            BlenderErrorCode.ASSET_TOO_LARGE,
            `${url} exceeds the configured assetMaxBytes of ${this.config.assetMaxBytes}; the download was ` +
              'stopped rather than completed.',
            { detail: { url, received, maxBytes: this.config.assetMaxBytes } },
          )
        }
        chunks.push(chunk)
      }
      if (received === 0) {
        throw new BlenderError(BlenderErrorCode.ASSET_FETCH_FAILED, `${url} answered with no bytes.`)
      }
      writeFileSync(target, Buffer.concat(chunks))
      return target
    } catch (cause) {
      removeTree(scratchDirectory)
      if (cause instanceof BlenderError) throw cause
      throw new BlenderError(
        BlenderErrorCode.ASSET_FETCH_FAILED,
        `${url} could not be fetched: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause, detail: { url } },
      )
    }
  }

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

  // ---------------------------------------------------------------------------
  // M3: the persistent render job (SPEC §10)
  //
  // The two halves of a delivery live here: RENDERING a frame sequence (long,
  // resumable, cancellable) and DELIVERING it (encode, verify, publish, manifest).
  // `startFinalRender` runs both; `exportProject` runs the second half alone, from
  // frames that already exist.
  // ---------------------------------------------------------------------------

  /**
   * Start the restart reconciler without blocking composition.
   *
   * Deferred by one tick on purpose: the reconciler signs process groups and reads
   * directories, and a Host that is still mounting rows has no `subprocess`
   * service for a resume to use. The promise is kept so a caller can await the
   * answer rather than poll for it.
   */
  _kickReconciliation() {
    this._reconciliation = new Promise((resolvePass) => {
      setTimeout(() => {
        resolvePass(this.reconcileRenderJobs().catch((cause) => {
          // A reconciler that throws must not take the Host down with it: the
          // failure is recorded and the finding list stays empty, which reads as
          // "nothing was recovered" rather than as "nothing was checked".
          this._recoveryError = cause instanceof Error ? cause.message : String(cause)
          return []
        }))
      }, 0)
    })
  }

  /** Await the reconciliation pass that started with this Host. */
  async awaitReconciliation() {
    if (this._reconciliation === null) return []
    return this._reconciliation
  }

  /**
   * Reconcile every unfinished render job in every project (SPEC §10.3).
   *
   * @returns {Promise<object[]>} one finding per unfinished job.
   */
  async reconcileRenderJobs() {
    const unfinished = this.renderJobs.unfinishedAcross(this.store.listProjectIds())
    /** @type {object[]} */
    const findings = []
    for (const entry of unfinished) {
      const previous = entry.record
      findings.push(await reconcileRenderJob({
        store: this.renderJobs,
        readFrameLedger,
        projectId: entry.projectId,
        jobId: entry.jobId,
        record: previous,
        write: record => (previous === null
          ? this.renderJobs.write(record)
          : this.renderJobs.write(record, { previous })),
      }))
    }
    this._recoveryFindings = findings
    return findings
  }

  /** Findings from the most recent reconciliation pass. */
  get recoveryFindings() {
    return this._recoveryFindings
  }

  /**
   * Attach the DSH job controller, once, if the composition has a job registry.
   *
   * `jobs.start` refuses an owner no controller serves, and the DeepBlend render
   * is an UNOWNED job on purpose: the studio is one host-level service shared by
   * every session (SPEC §4.4), so a delivery started in one session must be
   * visible and cancellable from another. `attachController` is effect-scoped and
   * idempotent, so attaching more than once is harmless.
   */
  _attachJobController() {
    if (this._jobControllerAttached) return this.ctx.get('jobs') ?? null
    const jobs = this.ctx.get('jobs')
    if (jobs === undefined || typeof jobs.attachController !== 'function') return null
    try {
      this.ctx.effect(() => jobs.attachController('deepblend-render'))
      this._jobControllerAttached = true
    } catch (cause) {
      this.ctx.logger?.warn(`deepblend: could not attach the job controller: ${String(cause)}`)
      return null
    }
    return jobs
  }

  // ---------------------------------------------------------------------------
  // The job surface (SPEC §7.2, §11)
  // ---------------------------------------------------------------------------

  /**
   * Read one job, render job first.
   *
   * Two record types can answer to the same id, and a caller asking for `jobId`
   * should not have to know which store it came from: a render job is looked up in
   * `renders/`, and an M1 attempt log in `jobs/`. A render job wins because its id
   * namespace is disjoint (`render-NNNN`), and reporting the richer record is the
   * useful answer when a caller has both.
   *
   * @param {{ projectId: string, jobId: string }} request
   * @returns {Promise<object>}
   */
  async getJob(request) {
    const projectId = request?.projectId
    const jobId = request?.jobId
    // The project is checked FIRST, so a typo in a project id is reported as a
    // project problem. Falling through to "no such job" would send the caller
    // looking for a job id that was never the mistake.
    this.store.readRecord(projectId)
    const renderRecord = jobId !== undefined ? this.renderJobs.readSafe(projectId, jobId) : null
    if (renderRecord !== null) {
      return {
        ...toCanonicalJobRecord({
          schemaVersion: RENDER_JOB_VERSION,
          jobId: renderRecord.jobId,
          projectId: renderRecord.projectId,
          action: renderRecord.type,
          revision: renderRecord.revisionId,
          status: renderRecord.status,
          startedAt: new Date(renderRecord.createdAt).toISOString(),
          finishedAt: renderRecord.finishedAt === null ? null : new Date(renderRecord.finishedAt).toISOString(),
          durationMs: renderRecord.finishedAt === null ? null : renderRecord.finishedAt - renderRecord.createdAt,
          errorCode: renderRecord.errorCode ?? null,
          message: renderRecord.message ?? null,
        }),
        kind: 'render-job',
        renderJob: this._canonicalRenderJob(renderRecord),
      }
    }
    const attempt = this.store.readJobSafe(projectId, jobId)
    if (attempt !== null) return toCanonicalJobRecord(attempt)
    throw new BlenderError(
      BlenderErrorCode.RENDER_JOB_NOT_FOUND,
      `Project "${projectId}" has no job "${jobId}" in either store (render jobs under renders/, ` +
        'attempt logs under jobs/).',
      { detail: { projectId, jobId } },
    )
  }

  /**
   * List a project's jobs: render jobs first (newest last), then attempt logs.
   *
   * @param {{ projectId: string, limit?: number }} request
   * @returns {Promise<object>}
   */
  async listJobs(request) {
    const projectId = request?.projectId
    // An unknown project must not read as "a project with no jobs": the second is a
    // true statement about a real project, and a caller cannot tell them apart.
    this.store.readRecord(projectId)
    const records = this.renderJobs.list(projectId)
    const limit = Number.isSafeInteger(request?.limit) ? request.limit : records.length
    const selected = limit >= records.length ? records : records.slice(records.length - limit)
    return {
      projectId,
      jobs: selected.map(record => this._canonicalRenderJob(record)),
      unfinished: records.filter(record => !RenderJobStore.isTerminal(record)).map(record => record.jobId),
      recovery: this._recoveryFindings
        .filter(finding => finding.projectId === projectId)
        .map(finding => ({
          jobId: finding.jobId,
          status: finding.status,
          notes: finding.notes,
          ledger: finding.ledger,
          reconciledAt: finding.reconciledAt,
        })),
      recoveryError: this._recoveryError ?? null,
    }
  }

  // ---------------------------------------------------------------------------
  // M4 — the read plane the workbench UI is built on (SPEC §14.3, §14.4)
  //
  // These return DOMAIN data, not view models. The browser-facing projection
  // (`buildSceneTree`, `buildQaView`, …) lives in the UI package, so this facade
  // stays what the tools already consume and the two planes cannot drift into
  // two different definitions of "the current revision".
  //
  // They are also, deliberately, the ONLY things a UI route may call: every one
  // of them reads (or, for the M3 job methods, coordinates) — none of them
  // executes anything the browser chose.
  // ---------------------------------------------------------------------------

  /**
   * Every project in the store, most recently touched first.
   *
   * @returns {Promise<{ projects: object[], count: number, projectsRoot: string }>}
   */
  async listProjects() {
    const projects = this.store.listProjectIds().map(projectId => {
      const record = this.store.readRecord(projectId)
      const specs = record.currentRevision === null
        ? null
        : (() => {
          try {
            return summarizeSceneSpec(this.store.readRevisionSpec(projectId, record.currentRevision), {
              revision: record.currentRevision,
              revisionNumber: parseRevisionId(record.currentRevision),
            })
          } catch {
            // A project whose current revision cannot be read is still a project.
            // Dropping it from the list would make the UI silently lose work.
            return null
          }
        })()
      return {
        projectId,
        title: record.title,
        goal: record.goal ?? null,
        currentRevision: record.currentRevision,
        revisionCount: record.revisionCount ?? this.store.listRevisions(projectId).length,
        createdAt: record.createdAt ?? null,
        updatedAt: record.updatedAt ?? null,
        unreadable: specs === null && record.currentRevision !== null,
        scene: specs,
        jobs: this.renderJobs.list(projectId).map(job => ({
          jobId: job.jobId,
          type: job.type,
          status: job.status,
          revisionId: job.revisionId,
        })),
      }
    })
    projects.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    // The RESOLVED root, not the row's possibly-empty value: the workbench shows
    // this string to a user who is looking for their projects on disk.
    return { projects, count: projects.length, projectsRoot: this.projectsRoot }
  }

  /**
   * One revision in full: what it decided, what it emitted, and how it validated.
   *
   * @param {{ projectId: string, revision?: string }} request
   * @returns {Promise<object>}
   */
  async getRevisionDetail(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revision = request?.revision ?? record.currentRevision
    if (revision === null || revision === undefined) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_NOT_FOUND,
        `Project "${projectId}" has no revisions yet, so there is no revision to read.`,
        { detail: { projectId } },
      )
    }
    const manifest = this.store.readRevisionManifest(projectId, revision)
    if (manifest === null) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_NOT_FOUND,
        `Project "${projectId}" has no revision "${revision}".`,
        { detail: { projectId, revision } },
      )
    }
    const directory = this.store.revisionDirectory(projectId, revision)
    const spec = this.store.readRevisionSpec(projectId, revision)
    return {
      projectId,
      revision,
      isCurrent: revision === record.currentRevision,
      manifest,
      scene: summarizeSceneSpec(spec, {
        revision,
        revisionNumber: parseRevisionId(revision),
        digest: manifest.digest ?? sceneSpecDigest(spec),
      }),
      validation: readJson(join(directory, 'validation.json')),
      operations: readJson(join(directory, 'operation-manifest.json')),
      request: readJson(join(directory, 'request.json')),
      checkpoint: this.store.checkpointPath(projectId, revision) === null ? null : `revisions/${revision}/scene.blend`,
      previews: manifest.previews ?? [],
      contactSheets: manifest.contactSheets ?? [],
      reviews: manifest.reviews ?? [],
    }
  }

  /**
   * Two revisions' specs, for a structural diff.
   *
   * The diff itself is computed by the caller (the UI projects it with
   * `buildRevisionDiff`), so this stays a read of two documents rather than a
   * third definition of what "changed" means.
   *
   * @param {{ projectId: string, from?: string, to?: string }} request
   * @returns {Promise<object>}
   */
  async readRevisionPair(request) {
    const projectId = request?.projectId
    const detail = await this.getRevisionDetail({ projectId, revision: request?.to })
    const fromRevision = request?.from ?? detail.manifest.baseRevision ?? null
    if (fromRevision === null || fromRevision === undefined) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_NOT_FOUND,
        `Revision "${detail.revision}" records no base revision, so there is nothing to compare it against.`,
        { detail: { projectId, revision: detail.revision } },
      )
    }
    return {
      projectId,
      fromRevision,
      toRevision: detail.revision,
      from: this.store.readRevisionSpec(projectId, fromRevision),
      to: this.store.readRevisionSpec(projectId, detail.revision),
      fromManifest: this.store.readRevisionManifest(projectId, fromRevision),
      toManifest: detail.manifest,
    }
  }

  /**
   * The QA record of a revision: the stored technical validation plus the newest
   * visual review, both unmerged (they are different evidence — M2 §3).
   *
   * @param {{ projectId: string, revision?: string }} request
   * @returns {Promise<object>}
   */
  async getQaRecord(request) {
    const detail = await this.getRevisionDetail({ projectId: request?.projectId, revision: request?.revision })
    const reviews = Array.isArray(detail.reviews) ? detail.reviews : []
    const newest = reviews.length === 0
      ? null
      : reviews.reduce((best, entry) => ((entry?.iteration ?? 0) >= (best?.iteration ?? 0) ? entry : best), reviews[0])
    const directory = this.store.projectDirectory(detail.projectId)
    const record = newest?.path === undefined || newest?.path === null
      ? null
      : readJson(resolveInside(directory, newest.path, 'visual review record'))
    return {
      projectId: detail.projectId,
      revision: detail.revision,
      validation: detail.validation,
      review: record === null ? null : (record.review ?? null),
      reviewViews: record === null ? [] : (record.views ?? []),
      reviewArtifact: newest,
      reviewCount: reviews.length,
    }
  }

  /**
   * Every preview-ish artifact a project has emitted, grouped by revision.
   *
   * Preview Compare needs both ends of a comparison to be *renderable*, which
   * means the project-relative path is the important field here: the browser is
   * handed a route that serves that path, never the path itself as something to
   * open (SPEC §14.3).
   *
   * @param {{ projectId: string }} request
   * @returns {Promise<object>}
   */
  async listPreviewSets(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revisions = this.store.listRevisions(projectId).map(revision => {
      const manifest = this.store.readRevisionManifest(projectId, revision)
      return {
        revision,
        isCurrent: revision === record.currentRevision,
        createdAt: manifest?.createdAt ?? null,
        summary: manifest?.summary ?? null,
        digest: manifest?.digest ?? null,
        previews: manifest?.previews ?? [],
        contactSheets: manifest?.contactSheets ?? [],
        reviews: manifest?.reviews ?? [],
      }
    })
    return { projectId, currentRevision: record.currentRevision, revisions }
  }

  /**
   * Read one artifact of one project, for the browser to display.
   *
   * The path MUST be project-relative and resolve inside the project directory:
   * this is the one method a URL parameter reaches, so the path guard is the
   * security boundary (SPEC §15.2 "工作区路径边界", "软链接逃逸防护"). A project
   * id and a path are both required, and neither can escape.
   *
   * @param {{ projectId: string, path: string }} request
   * @returns {Promise<{ path: string, bytes: Buffer, contentType: string, size: number }>}
   */
  async readArtifact(request) {
    const projectId = request?.projectId
    const relative = request?.path
    if (typeof relative !== 'string' || relative.length === 0) {
      throw new BlenderError(BlenderErrorCode.PATH_OUTSIDE_WORKSPACE, 'readArtifact needs a project-relative path.', { detail: { projectId } })
    }
    if (isAbsolute(relative)) {
      throw new BlenderError(
        BlenderErrorCode.PATH_OUTSIDE_WORKSPACE,
        `"${relative}" is absolute; artifacts are addressed relative to the project directory (SPEC §14.3).`,
        { detail: { projectId, path: relative } },
      )
    }
    const directory = this.store.projectDirectory(projectId)
    const resolved = resolveInside(directory, relative, 'artifact path')
    if (!isFile(resolved)) {
      throw new BlenderError(BlenderErrorCode.ARTIFACT_NOT_FOUND, `There is no artifact at "${relative}" in project "${projectId}".`, {
        detail: { projectId, path: relative },
      })
    }
    const bytes = readFileSync(resolved)
    return {
      path: relative,
      bytes,
      contentType: contentTypeForArtifact(relative),
      size: bytes.byteLength,
    }
  }

  /**
   * Cancel a live render job, and prove the process is gone (SPEC §20 M3
   * "取消后无孤儿进程").
   *
   * The report distinguishes three things that are easy to conflate: the cancel was
   * REQUESTED, the process was SIGNALLED, and the process is GONE. Only the third
   * is the acceptance condition, so it is measured (`process.kill(-pid, 0)`) after
   * the signal rather than inferred from having sent one.
   *
   * @param {{ projectId: string, jobId: string, reason?: string }} request
   * @returns {Promise<object>}
   */
  async cancelJob(request) {
    const projectId = request?.projectId
    const jobId = request?.jobId
    const renderRecord = projectId !== undefined && jobId !== undefined
      ? this.renderJobs.readSafe(projectId, jobId)
      : null

    if (renderRecord === null) {
      // An M1 attempt log has no live process by construction.
      const record = this.store.readJob(projectId, jobId)
      return {
        jobId: record.jobId,
        kind: 'attempt-log',
        status: record.status,
        cancelled: false,
        reason: `an M1 attempt log has no cancellable process; job is already ${record.status}`,
        processGone: true,
      }
    }

    if (RenderJobStore.isTerminal(renderRecord)) {
      return {
        jobId,
        kind: 'render-job',
        status: renderRecord.status,
        cancelled: false,
        reason: `the render job is already ${renderRecord.status}`,
        processGone: true,
      }
    }

    const live = this._liveRenders.get(jobId)
    const reason = request?.reason ?? 'cancelled by a caller'

    // Stop the DSH projection first so the harness stops waiting on it and the
    // model sees `stopping` immediately; the process work follows.
    const dshJobId = live?.dshJobId ?? renderRecord.dshJobId ?? null
    if (dshJobId !== null) {
      const jobs = this.ctx.get('jobs')
      try {
        jobs?.kill(dshJobId, undefined, reason)
      } catch {
        // A projection that cannot be killed (already settled, or gone with a
        // previous Host) must not stop the process cancellation below.
      }
    }

    let processReport = { attempted: false }
    const pid = renderRecord.pid ?? null
    if (live !== undefined) {
      live.cancelled = true
      live.cancelReason = reason
      // `terminate()` is synchronous and idempotent, and it walks the provider's
      // documented ladder: SIGTERM to the process group, grace, SIGKILL.
      if (live.handle !== null) {
        try {
          live.handle.terminate()
          // The ladder is named, and the SIGNAL is deliberately not. `terminate()`
          // walks the provider's own tiers (SIGTERM to the managed range, a grace
          // period, then SIGKILL) and does not report which tier stopped the
          // process; naming one here would be a guess dressed as a measurement.
          // What IS measured is the thing the acceptance condition asks for: the
          // process is gone.
          processReport = {
            attempted: true,
            via: 'subprocess-handle',
            pid,
            ladder: "the provider's terminate(): SIGTERM to the managed range, grace, then SIGKILL",
          }
        } catch (cause) {
          processReport = { attempted: true, via: 'subprocess-handle', pid, error: String(cause) }
        }
      }
    } else if (pid !== null) {
      // No live handle in THIS process — the renderer was started by a previous
      // Host, or by a reconcile that has not adopted it. Signal the group directly
      // and verify, which is the same thing the reconciler does.
      processReport = { attempted: true, via: 'process-group', ...(await stopProcessGroup({ pid })) }
    }

    // Wait for the process to be REAPED, not merely signalled. MEASURED, and it is
    // the difference between a green test and a true one: immediately after
    // `terminate()`, `ps` still shows the pid as `(Blender)` — a zombie that has
    // exited but not yet been collected by this Node process — so `kill(pid, 0)`
    // SUCCEEDS and a liveness check taken too early reports a live renderer for a
    // process that is already dead. `handle.done` resolves after the child is
    // reaped, which is the fact the acceptance condition is actually about.
    if (live !== undefined && live.handle !== null) {
      await Promise.race([
        live.handle.done.catch(() => undefined),
        new Promise(resolveWait => setTimeout(resolveWait, 15_000)),
      ])
    }

    // Verify rather than assume. A cancel that reports success while the renderer
    // keeps writing frames is the exact failure the acceptance condition names.
    let processGone = true
    let after = null
    if (pid !== null) {
      after = checkProcessAlive(pid)
      processGone = after.alive === false
      if (processGone === false && live === undefined) {
        // A group that survived a direct signal is escalated once, then reported.
        const escalated = await stopProcessGroup({ pid })
        after = checkProcessAlive(pid)
        processGone = after.alive === false
        processReport = { ...processReport, escalated }
      }
    }

    const next = this.renderJobs.write({
      ...renderRecord,
      status: 'cancelled',
      cancelledAt: Date.now(),
      finishedAt: Date.now(),
      errorCode: null,
      message: `cancelled: ${reason}`,
    }, { previous: renderRecord })

    // Settle the live work so the DSH projection is released and the render loop
    // stops touching the record — and WAIT for it. Returning while the render loop
    // is still unwinding means a caller that cancels and immediately resumes races
    // its own previous attempt for the same frame files.
    if (live !== undefined && live.settle !== null) {
      live.settle({ status: 'killed', detail: reason })
      await this._awaitLiveGone(jobId, 15_000)
    }

    return {
      jobId,
      kind: 'render-job',
      status: next.status,
      cancelled: true,
      reason,
      process: { ...processReport, after, gone: processGone },
      processGone,
      completedFrames: next.completedFrames?.length ?? 0,
    }
  }

  /**
   * Start a delivery render (SPEC §7.2 `startFinalRender`, §20 M3).
   *
   * RETURNS AS SOON AS THE RENDERER IS RUNNING. It does not await the render, the
   * encode or the manifest — a 450-frame delivery is ~3.4 hours on this machine,
   * and the first acceptance condition is that a long task does not block the
   * Agent. What comes back is a job reference; what follows is a filesystem, a DSH
   * job whose output carries progress, and a durable record that survives the Host
   * being killed.
   *
   * @param {object} request
   * @param {string} request.projectId
   * @param {string} [request.revision]
   * @param {number} [request.frameStart]
   * @param {number} [request.frameEnd]
   * @param {string} [request.cameraId]
   * @param {string} [request.profileName]
   * @param {number} [request.samples]
   * @param {number[]} [request.frames]
   * @returns {Promise<object>}
   */
  async startFinalRender(request) {
    const projectId = request?.projectId
    const record = this.store.readRecord(projectId)
    const revision = request?.revision ?? record.currentRevision
    const spec = this.store.readRevisionSpec(projectId, revision)
    const profileName = request?.profileName ?? this.config.finalRenderProfile
    const profile = this._resolveRenderProfile(spec, profileName, revision)

    const range = this._resolveDeliveryRange({ spec, request })
    const frames = range.frames

    // An open project may hold only one delivery render at a time, and the check
    // comes before everything below for the same reason as the approval gate: a
    // refusal must not have allocated anything.
    const active = this._activeRenderJob(projectId)
    if (active !== null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_JOB_CONFLICT,
        `Project "${projectId}" already has ${active.jobId} in state "${active.status}" ` +
          `(${active.completedFrames?.length ?? 0}/${(active.frameEnd ?? 0) - (active.frameStart ?? 0) + 1} frames). ` +
          'Resume it with blender_final_render {resumeJobId}, or cancel it first: two renderers writing one ' +
          'project\'s frames would produce files neither can vouch for.',
        { detail: { projectId, activeJob: active.jobId, status: active.status } },
      )
    }

    // ── the approval gate (SPEC §15.1, architecture-decisions Q7) ────────────
    //
    // Above the configured threshold, a delivery render is REFUSED unless the
    // caller presents a grant. Until M5 this was only a warning attached after the
    // job had started, which is a description of the cost rather than a control on
    // it — and the panel said so out loud ("display-only") because saying nothing
    // would have implied a guarantee that did not exist.
    //
    // The refusal is where the enforcement belongs rather than in the tool: the
    // tool plane is not the only caller (the workbench starts renders too), and a
    // control that only one of two callers respects is not a control. What the tool
    // plane adds is the means to ANSWER it — it holds the agent and the open turn
    // that `ctx.approval.request` needs — so it asks and re-issues with the grant.
    //
    // `approved` is the caller's assertion that a person said yes. The host cannot
    // verify it, and the honest reading is that it is a deliberate act either way:
    // the model may only set it after `approval.request` returned `'allowed-once'`,
    // and a human clicking "render" in the panel has approved it by clicking.
    const approvalRequired = frames.length > this.config.requireApprovalAboveFrames
    if (approvalRequired && request?.approved !== true) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_APPROVAL_REQUIRED,
        `This delivery renders ${frames.length} frames, above the configured approval threshold of ` +
          `${this.config.requireApprovalAboveFrames} (SPEC §15.1). Nothing has been started. ` +
          'Ask the operator (the approval prompt in the workbench), then re-issue with approved:true — ' +
          'or render a smaller range first to check the scene.',
        {
          detail: {
            projectId,
            revision,
            frames: frames.length,
            threshold: this.config.requireApprovalAboveFrames,
            frameStart: frames[0] ?? null,
            frameEnd: frames[frames.length - 1] ?? null,
          },
        },
      )
    }

    const checkpoint = this._resolveDeliveryCheckpoint({ projectId, revision, spec })
    const cameraId = request?.cameraId ?? this._deliveryCameraId(spec)
    const requestedSamples = request?.samples ?? profile.samples
    const effective = this._deliverySamples(profile, requestedSamples, revision)

    const jobId = this.renderJobs.allocateJobId(projectId)
    const now = Date.now()
    /** @type {object[]} */
    const warnings = []
    for (const notice of range.notices) {
      warnings.push(warning(BlenderWarningCode.SCENE_COMPILER_DECISION, notice, { kind: 'delivery-range' }))
    }
    if (effective.warning !== null) warnings.push(effective.warning)
    if (approvalRequired) {
      // Reached only with a grant, because the gate above refuses otherwise. Recorded
      // as a fact about THIS job rather than as a standing note, so the workbench can
      // show that this particular render was approved and by which path.
      warnings.push(warning(
        BlenderWarningCode.SCENE_COMPILER_DECISION,
        `this delivery renders ${frames.length} frames, above the configured approval threshold of ` +
          `${this.config.requireApprovalAboveFrames} (SPEC §15.1 "高成本最终渲染达阈值审批"); ` +
          'the caller presented an approval before it was started',
        { frames: frames.length, threshold: this.config.requireApprovalAboveFrames, approval: 'granted' },
      ))
    }

    const created = this.renderJobs.write({
      schemaVersion: RENDER_JOB_VERSION,
      jobId,
      projectId,
      revisionId: revision,
      runId: null,
      type: 'final-render',
      status: 'queued',
      attempt: 0,
      pid: null,
      processGroupId: null,
      frameStart: frames[0],
      frameEnd: frames[frames.length - 1],
      expectedFrames: frames.length,
      completedFrames: [],
      missingFrames: frames,
      corruptFrames: [],
      framesDirectory: this.renderJobs.framesDirectory(projectId, jobId),
      jobDirectory: this.renderJobs.jobDirectory(projectId, jobId),
      filePrefix: 'frame_',
      filePadding: 4,
      fps: spec.project.fps,
      sceneFrameRange: [spec.project.frameStart, spec.project.frameEnd],
      profileName,
      renderConfig: null,
      cameraId,
      checkpointPath: checkpoint.path,
      sceneSpecDigest: sceneSpecDigest(spec),
      dshJobId: null,
      delivery: null,
      outputManifest: null,
      errorCode: null,
      message: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      warnings,
    })

    const launched = await this._launchRenderer({
      // `effective.profile`, NOT `profile`. MEASURED by
      // `composition/hardening.e2e.mjs`: this line used to pass the spec's profile,
      // so `_deliverySamples` computed the clamped sample count, pushed a warning
      // saying so, and then the renderer was handed the UNCLAMPED profile. Both
      // directions were wrong and only one of them was loud:
      //
      //   blender_final_render {samples: 100000}  ->  warning "reduced to 128",
      //                                               renderer told 8 (the profile's)
      //   blender_final_render {samples: 4}       ->  no warning at all,
      //                                               renderer told 8 — four times the
      //                                               cost the caller asked for, silently
      //
      // The resume path below already passed `effective.profile`; the start path did
      // not. The suite asserts what the renderer was handed, read from the `plan.json`
      // the provider writes before spawning, because the job record is what the HOST
      // believes and the plan is what the child was told.
      record: created, spec, profile: effective.profile, profileName, checkpoint, cameraId, frames, reason: 'start',
    })

    return {
      jobId,
      projectId,
      revision,
      type: 'final-render',
      // The projection's id is returned, not just stored: correlating a DeepBlend
      // render with the harness job list is how a caller finds the progress stream
      // and how a human finds it in the Jobs panel.
      dshJobId: launched.dshJobId,
      status: this.renderJobs.read(projectId, jobId).status,
      frameStart: frames[0],
      frameEnd: frames[frames.length - 1],
      frames: frames.length,
      warnings,
      message:
        `Delivery render of ${frames.length} frame(s) started for ${projectId}/${revision}. It runs in the ` +
        'background; poll it with blender_job_status. If the harness or Blender is interrupted, the frames ' +
        'already rendered are kept and blender_final_render {resumeJobId} continues from the missing ones.',
    }
  }

  /**
   * Continue an interrupted delivery render, rendering ONLY the frames that are
   * not already complete (SPEC §10.3 step 6, §20 M3 "可只渲缺失帧").
   *
   * The set to render comes from the frame LEDGER, never from the record's cached
   * `completedFrames`: the cache is written by a process that may have died, and a
   * frame file written by a process killed mid-write exists without being a frame.
   *
   * @param {{ projectId: string, jobId: string, frameStart?: number, frameEnd?: number, samples?: number }} request
   * @returns {Promise<object>}
   */
  async resumeRenderJob(request) {
    const projectId = request?.projectId
    const jobId = request?.jobId
    const record = this.renderJobs.read(projectId, jobId)

    // A failed or cancelled job IS resumable: its frames are on disk and its work
    // is unfinished, and refusing would mean a Blender crash in hour three costs
    // the whole render. Only a completed job is finished — re-delivering it is
    // `exportProject`, which does not need a renderer at all.
    if (record.status === 'completed') {
      throw new BlenderError(
        BlenderErrorCode.RENDER_JOB_STATE_INVALID,
        `Render job ${jobId} is completed; its delivery is already published. Use blender_export to ` +
          're-encode it, which spends no Blender time.',
        { detail: { jobId, status: record.status } },
      )
    }
    const live = this._liveRenders.get(jobId)
    if (live !== undefined && live.handle !== null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_JOB_CONFLICT,
        `Render job ${jobId} is already running in this Host.`,
        { detail: { jobId } },
      )
    }

    const spec = this.store.readRevisionSpec(projectId, record.revisionId)
    const profileName = record.profileName ?? this.config.finalRenderProfile
    const profile = this._resolveRenderProfile(spec, profileName, record.revisionId)
    const checkpoint = this._resolveDeliveryCheckpoint({ projectId, revision: record.revisionId, spec })

    const expected = this.renderJobs.expectedFrames(record)
    const ledger = readFrameLedger({
      framesDirectory: this.renderJobs.framesDirectory(projectId, jobId),
      expected,
      expectedSize: {
        width: record.renderConfig?.resolution?.[0],
        height: record.renderConfig?.resolution?.[1],
        prefix: record.filePrefix,
        padding: record.filePadding,
      },
    })

    const samples = request?.samples ?? profile.samples
    const effective = this._deliverySamples(profile, samples, record.revisionId)

    await this._launchRenderer({
      record: {
        ...record,
        completedFrames: ledger.present.map(entry => entry.frame),
        missingFrames: ledger.toRender,
        corruptFrames: ledger.corrupt,
        renderConfig: record.renderConfig ?? { resolution: profile.resolution, samples: effective.samples },
      },
      spec,
      profile: effective.profile,
      profileName,
      checkpoint,
      cameraId: record.cameraId ?? this._deliveryCameraId(spec),
      frames: ledger.toRender,
      reason: 'resume',
      expectedFrames: expected,
    })

    return {
      jobId,
      projectId,
      revision: record.revisionId,
      status: this.renderJobs.read(projectId, jobId).status,
      frameStart: record.frameStart,
      frameEnd: record.frameEnd,
      alreadyComplete: ledger.presentCount,
      resumed: ledger.toRender.length,
      resumedFrames: ledger.toRender,
      corrupt: ledger.corrupt.map(entry => ({ frame: entry.frame, reason: entry.reason })),
      warnings: [],
      message: ledger.toRender.length === 0
        ? 'Every frame is already present and complete; the job is finishing its delivery instead of re-rendering.'
        : `Resuming ${ledger.toRender.length} frame(s): ${ledger.missingCount} absent, ${ledger.corruptCount} incomplete.`,
    }
  }

  /**
   * Encode and publish a delivery from frames that already exist (SPEC §7.2
   * `exportProject`).
   *
   * WHY THIS IS SEPARATE FROM `startFinalRender`
   * --------------------------------------------
   * It spends no Blender time. Re-encoding after a settings change, re-publishing
   * a package whose manifest was lost, or producing the video for a render another
   * session finished are all real, and all of them would otherwise mean rendering
   * 450 frames again.
   *
   * @param {{ projectId: string, jobId?: string, revision?: string }} request
   * @returns {Promise<object>}
   */
  async exportProject(request) {
    const projectId = request?.projectId
    const record = request?.jobId !== undefined
      ? this.renderJobs.read(projectId, request.jobId)
      : this._newestDeliverableJob(projectId, request?.revision)

    if (record === null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_JOB_NOT_FOUND,
        `Project "${projectId}" has no render job to export. Start one with blender_final_render first.`,
        { detail: { projectId } },
      )
    }

    const spec = this.store.readRevisionSpec(projectId, record.revisionId)
    const delivery = await this._deliverJob({ record, spec, reason: 'export' })
    return {
      jobId: record.jobId,
      projectId,
      revision: record.revisionId,
      status: delivery.status,
      video: delivery.video,
      manifest: delivery.manifest,
      verified: delivery.verified,
      problems: delivery.problems,
      completeness: delivery.completeness,
      warnings: [],
      message: delivery.verified
        ? `Delivery package published: ${delivery.video?.path}. ` +
          `${delivery.video?.probed?.frameCount} frame(s), ${delivery.video?.probed?.durationSeconds}s, ` +
          `${delivery.video?.probed?.width}x${delivery.video?.probed?.height} @ ${delivery.video?.probed?.fps} fps.`
        : `Delivery encoded but its properties do not match the job's own claims: ${JSON.stringify(delivery.problems)}`,
    }
  }

  // ---------------------------------------------------------------------------
  // M3 internals
  // ---------------------------------------------------------------------------

  /** The render profile a delivery uses, or a stable refusal. */
  _resolveRenderProfile(spec, profileName, revision) {
    const profile = spec?.renderProfiles?.[profileName]
    if (profile === undefined) {
      const available = Object.keys(spec?.renderProfiles ?? {})
      throw new BlenderError(
        BlenderErrorCode.RENDER_PROFILE_MISSING,
        `Revision ${revision} declares no "${profileName}" render profile, so there is nothing to render a ` +
          `delivery with. Declared profiles: ${available.length > 0 ? available.join(', ') : 'none'}.`,
        { detail: { revision, requested: profileName, available } },
      )
    }
    return profile
  }

  /** The frame range a delivery covers, with the notices explaining any narrowing. */
  _resolveDeliveryRange(input) {
    const project = input.spec.project
    const { frames: projectFrames, error } = frameNumbers(project.frameStart, project.frameEnd)
    if (error !== null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_RANGE_INVALID,
        `the SceneSpec's own frame range is invalid: ${error}`,
        { detail: { frameStart: project.frameStart, frameEnd: project.frameEnd } },
      )
    }
    const notices = []
    if (Array.isArray(input.request?.frames) && input.request.frames.length > 0) {
      const requested = [...new Set(input.request.frames.map(Number))]
        .filter(frame => Number.isSafeInteger(frame))
        .sort((left, right) => left - right)
      const outside = requested.filter(frame => frame < project.frameStart || frame > project.frameEnd)
      if (requested.length === 0) {
        throw new BlenderError(
          BlenderErrorCode.RENDER_RANGE_INVALID,
          'the requested frame list contains no usable frame numbers',
          { detail: { frames: input.request.frames } },
        )
      }
      if (outside.length > 0) {
        notices.push(
          `${outside.length} requested frame(s) fall outside the project's own range ` +
          `${project.frameStart}..${project.frameEnd} and were dropped: ${outside.slice(0, 8).join(', ')}`,
        )
      }
      const kept = requested.filter(frame => frame >= project.frameStart && frame <= project.frameEnd)
      if (kept.length === 0) {
        throw new BlenderError(
          BlenderErrorCode.RENDER_RANGE_INVALID,
          `every requested frame falls outside the project's range ${project.frameStart}..${project.frameEnd}`,
          { detail: { frames: input.request.frames } },
        )
      }
      return { frames: kept, notices }
    }

    const start = input.request?.frameStart ?? project.frameStart
    const end = input.request?.frameEnd ?? project.frameEnd
    const { frames, error: rangeError } = frameNumbers(start, end)
    if (rangeError !== null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_RANGE_INVALID,
        `the requested delivery range is invalid: ${rangeError}`,
        { detail: { frameStart: start, frameEnd: end, projectRange: [project.frameStart, project.frameEnd] } },
      )
    }
    if (start !== project.frameStart || end !== project.frameEnd) {
      notices.push(
        `this delivery covers frames ${start}..${end}, not the project's own range ` +
        `${project.frameStart}..${project.frameEnd}; the delivery manifest records both`,
      )
    }
    return { frames, notices }
  }

  /**
   * The samples a delivery may use, and the warning when the ceiling bit.
   *
   * Deliberately NOT bounded by `maxPreviewSamples`: that ceiling exists to stop a
   * model spending money on previews, and applying it here would silently rewrite
   * a delivery's own profile — the M3 brief calls this out as the trap waiting in
   * the final-render path. The profile's `maxSamplesBudget` is the intended
   * ceiling, with `maxFinalSamples` as the operator's backstop.
   */
  _deliverySamples(profile, requested, revision) {
    const ceiling = Math.min(
      profile.maxSamplesBudget ?? this.config.maxFinalSamples,
      this.config.maxFinalSamples,
    )
    if (requested === undefined || requested === null) {
      return { samples: profile.samples ?? null, profile, warning: null }
    }
    const effective = Math.min(requested, ceiling)
    if (effective === requested) {
      return { samples: effective, profile: { ...profile, samples: effective }, warning: null }
    }
    return {
      samples: effective,
      profile: { ...profile, samples: effective },
      warning: warning(
        BlenderWarningCode.RENDER_SAMPLES_REDUCED,
        `delivery samples reduced from ${requested} to ${effective} by the profile budget ` +
          `(profile budget ${profile.maxSamplesBudget ?? this.config.maxFinalSamples}, host ceiling ` +
          `${this.config.maxFinalSamples}); the preview ceiling maxPreviewSamples=${this.config.maxPreviewSamples} ` +
          'deliberately does not apply to a delivery render',
        { requested, used: effective, revision },
      ),
    }
  }

  /** The checkpoint a delivery renders from, compiled if the revision has none. */
  _resolveDeliveryCheckpoint(input) {
    const checkpoint = this.store.findCheckpointAtOrBefore(input.projectId, input.revision)
    if (checkpoint === null) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CHECKPOINT_MISSING,
        `Revision ${input.revision} has no checkpoint to render from, and there is no earlier checkpoint to ` +
          'fall back on. Commit a revision with saveCheckpoint before rendering a delivery.',
        { detail: { projectId: input.projectId, revision: input.revision } },
      )
    }
    return checkpoint
  }

  /**
   * The camera a delivery renders from: the one the scene declares active, else
   * the first declared.
   *
   * Read from `cameras[].role` rather than from the compiled scene's
   * `activeCamera`, because the SceneSpec is the source of truth and the role is
   * the author's own statement (the same reasoning as D37 — an ordering fallback
   * is a guess, and the view plan already learned what guessing costs).
   */
  _deliveryCameraId(spec) {
    const cameras = Array.isArray(spec?.cameras) ? spec.cameras : []
    const active = cameras.find(camera => camera.role === 'active-camera')
    if (active !== undefined) return active.id
    if (cameras.length === 0) {
      throw new BlenderError(
        BlenderErrorCode.SCENE_CAMERA_MISSING,
        'this SceneSpec declares no camera, so there is nothing to render a delivery from.',
      )
    }
    return cameras[0].id
  }

  /** Wait, bounded, for a render loop to release its handle on a job. */
  async _awaitLiveGone(jobId, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this._liveRenders.has(jobId)) return true
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    return !this._liveRenders.has(jobId)
  }

  /** The non-terminal render job for a project, if any. */
  _activeRenderJob(projectId) {
    for (const record of this.renderJobs.list(projectId)) {
      if (UNFINISHED_STATUSES.includes(record.status)) return record
    }
    return null
  }

  /** The newest render job whose frames are complete, for `exportProject`. */
  _newestDeliverableJob(projectId, revision) {
    const candidates = this.renderJobs.list(projectId)
      .filter(record => revision === undefined || record.revisionId === revision)
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const record = candidates[index]
      if (record.delivery?.status === 'published') return record
      if (record.status === 'completed') return record
      const expected = record.expectedFrames ?? (record.frameEnd - record.frameStart + 1)
      if ((record.completedFrames?.length ?? 0) >= expected) return record
    }
    return candidates.length > 0 ? candidates[candidates.length - 1] : null
  }

  /**
   * Launch a renderer for a record and return once it is RUNNING.
   *
   * The record has already been written; everything below happens in the
   * background, and the returned promise resolves as soon as the child has been
   * spawned so a tool call can answer with a job id instead of a 3.4-hour wait.
   */
  async _launchRenderer(input) {
    const { record, profile, profileName, checkpoint } = input
    const projectId = record.projectId
    const jobId = record.jobId
    const frames = input.frames
    const jobs = this._attachJobController()

    /** @type {object} */
    const live = {
      jobId,
      cancelled: false,
      cancelReason: null,
      handle: null,
      run: null,
      dshJobId: null,
      output: '',
      verified: new Set(record.completedFrames ?? []),
      // Filled in below, from the profile actually being applied. Taking it from
      // `record.renderConfig` would be null on a FIRST attempt — the record that
      // carries it is written a few lines later — so the per-frame check would
      // verify existence and completeness but not dimensions, while the ledger
      // verifies all three. Two checks of different strength on the same question
      // is the shape of defect D57.
      expectedSize: { width: undefined, height: undefined },
      settle: null,
      done: null,
      journal: new JournalTail(join(this.renderJobs.jobDirectory(projectId, jobId), 'events.jsonl')),
      attemptToken: null,
      tornReported: false,
      startedAt: Date.now(),
    }

    const expected = input.expectedFrames ?? this.renderJobs.expectedFrames(record)
    const renderConfig = record.renderConfig ?? {
      resolution: profile.resolution,
      samples: profile.samples,
      engine: profile.engine,
      viewTransform: profile.colorManagement?.viewTransform ?? null,
      fps: record.fps,
    }
    live.expectedSize = { width: renderConfig.resolution?.[0], height: renderConfig.resolution?.[1] }

    let next = this.renderJobs.write({
      ...record,
      status: 'running',
      attempt: (record.attempt ?? 0) + 1,
      // The pid of the PREVIOUS attempt is dropped here, and this is a measured fix
      // rather than tidiness. Carrying it forward left a resumed job naming a
      // process that no longer exists: the record said `pid: 87209` while the
      // renderer actually writing frames was 87455. Everything that finds a
      // renderer by pid then looks at the wrong process — a second restart would
      // "stop" the dead one and leave the live one running forever, which is
      // exactly the orphan the acceptance condition forbids. It surfaced only in a
      // real 60-frame delivery that was killed and resumed; every short test had
      // finished before the second attempt began.
      pid: null,
      processGroupId: null,
      completedFrames: [...live.verified],
      missingFrames: expected.filter(frame => !live.verified.has(frame)),
      renderConfig,
      startedAt: record.startedAt ?? Date.now(),
      errorCode: null,
      message: input.reason === 'resume'
        ? `resumed: rendering ${frames.length} missing frame(s)`
        : `rendering ${frames.length} frame(s)`,
    }, { previous: record })

    this._liveRenders.set(jobId, live)

    // The DSH projection, when the composition has a job registry. Absence is
    // reported, never silent: a caller that asked for a background job and got an
    // unprojected one must be able to see why.
    if (jobs !== null) {
      live.done = new Promise((resolveDone) => { live.settle = resolveDone })
      try {
        live.dshJobId = jobs.start({
          kind: 'blender-render',
          label: `render ${projectId}/${record.revisionId} frames ${record.frameStart}..${record.frameEnd}`,
          run: () => ({
            cancel: (reason) => {
              if (live.cancelled) return
              live.cancelled = true
              live.cancelReason = typeof reason === 'string' && reason.length > 0 ? reason : 'cancelled'
              try {
                live.handle?.terminate()
              } catch {
                /* the settle path records what happened */
              }
            },
            done: live.done,
            readOutput: () => {
              const text = live.output
              live.output = ''
              return text
            },
          }),
        })
        next = this.renderJobs.write({ ...next, dshJobId: live.dshJobId }, { previous: next })
      } catch (cause) {
        live.settle = null
        live.done = null
        this.ctx.logger?.warn(`deepblend: render job ${jobId} could not be projected into ctx.jobs: ${String(cause)}`)
        next = this.renderJobs.write({
          ...next,
          warnings: [
            ...(next.warnings ?? []),
            warning(
              BlenderWarningCode.JOB_PROJECTION_UNAVAILABLE,
              `this render could not be registered as a DSH background job (${String(cause)}), so it will not ` +
                'appear in the harness job list. The render itself is unaffected and its durable record is ' +
                'still authoritative.',
              { jobId },
            ),
          ],
        }, { previous: next })
      }
    } else {
      next = this.renderJobs.write({
        ...next,
        warnings: [
          ...(next.warnings ?? []),
          warning(
            BlenderWarningCode.JOB_PROJECTION_UNAVAILABLE,
            'no `jobs` service is composed in this process, so this render has no DSH background-job ' +
              'projection; progress is still recorded durably and readable through blender_job_status.',
            { jobId },
          ),
        ],
      }, { previous: next })
    }

    // Spawn, then hand the rest to the background. `startFrameSequence` is the
    // only await here: it resolves once the child exists, which is what makes the
    // returned job id true rather than optimistic.
    const attemptToken = randomUUID()
    live.attemptToken = attemptToken
    const run = await this.runtime.startFrameSequence({
      checkpointPath: record.checkpointPath ?? checkpoint.path,
      frames,
      jobDirectory: this.renderJobs.jobDirectory(projectId, jobId),
      cameraId: input.cameraId,
      profileName,
      profile,
      frameRange: record.sceneFrameRange,
      jobId,
      attemptToken,
    })
    live.run = run
    live.handle = run.handle

    if (live.cancelled) {
      // Cancelled between the record write and the spawn: the child exists and
      // must not be left behind.
      try {
        run.handle.terminate()
      } catch {
        /* reported by the settle path */
      }
    }

    // Background completion. Nothing awaits this but the record and the DSH job.
    void this._driveRender({ live, run, record: next, expected, spec: input.spec, profile, profileName })

    return { jobId, dshJobId: live.dshJobId }
  }

  /**
   * The background half: watch the render, keep the record true, then deliver.
   *
   * Never throws — it settles the record and the DSH projection instead. A
   * background task that rejects has no caller to catch it, and an unhandled
   * rejection would take the Host down in the middle of a delivery.
   */
  async _driveRender(input) {
    const { live, run, expected, spec } = input
    const projectId = input.record.projectId
    const jobId = input.record.jobId
    let record = input.record

    let progressFailures = 0
    const tick = setInterval(() => {
      this._absorbProgress(live, run, projectId, jobId).catch((cause) => {
        progressFailures += 1
        // Reported ONCE, and the render is not stopped for it: a progress tick that
        // fails does not make the frames wrong, and killing a three-hour render over
        // a bookkeeping error would be far worse than a stale percentage. What it
        // must not do is disappear — a swallowed error is indistinguishable from a
        // tick that had nothing to do.
        if (progressFailures === 1) {
          this.ctx.logger?.warn(`deepblend: progress reporting for ${jobId} failed: ${String(cause)}`)
          this._appendOutput(live, `progress reporting failed: ${String(cause)}\n`)
        }
      })
    }, this.config.progressPollMs ?? 1000)
    // `unref` so a Host that is tearing down is not held open by a poller for a
    // render that has already been terminated.
    tick.unref?.()

    try {
      const outcome = await this.runtime.awaitFrameSequence(run)
      clearInterval(tick)
      await this._absorbProgress(live, run, projectId, jobId)

      // The frames are the authority for what happened, whatever the envelope says
      // — a killed process writes no envelope, and a successful one can still have
      // been lied to by a truncated frame.
      const ledger = this._readJobLedger(record, expected)

      if (live.cancelled) {
        const already = this.renderJobs.read(projectId, jobId)
        if (RenderJobStore.isTerminal(already)) {
          // `cancelJob` settled this record and is waiting for this loop to let go.
          // Writing again would be a second, possibly disagreeing, account of one
          // cancellation.
          this._appendOutput(live, `render job ${jobId} cancelled\n`)
          live.settle?.({ status: 'killed', detail: live.cancelReason ?? 'cancelled' })
          return
        }
        record = this.renderJobs.write({
          ...already,
          status: 'cancelled',
          pid: null,
          processGroupId: null,
          completedFrames: ledger.present.map(entry => entry.frame),
          missingFrames: ledger.toRender,
          cancelledAt: Date.now(),
          finishedAt: Date.now(),
          message: `cancelled: ${live.cancelReason ?? 'cancelled'}`,
        }, { previous: this.renderJobs.read(projectId, jobId) })
        this._appendOutput(live, `render job ${jobId} cancelled after ${ledger.presentCount} frame(s)\n`)
        live.settle?.({ status: 'killed', detail: `cancelled after ${ledger.presentCount} frame(s)` })
        return
      }

      const envelopeStatus = outcome.envelope?.status ?? null
      if (envelopeStatus !== 'success' && ledger.toRenderCount > 0) {
        const envelopeError = outcome.envelope?.error ?? null
        const errorCode = envelopeError?.code ?? (outcome.signal !== null
          ? BlenderErrorCode.ABORTED
          : BlenderErrorCode.NONZERO_EXIT)
        const current = this.renderJobs.read(projectId, jobId)
        record = this.renderJobs.write({
          ...current,
          status: 'failed',
          pid: null,
          processGroupId: null,
          completedFrames: ledger.present.map(entry => entry.frame),
          missingFrames: ledger.toRender,
          corruptFrames: ledger.corrupt,
          errorCode,
          message:
            `the renderer exited ${outcome.exitCode ?? 'without a code'} before every frame was written: ` +
            `${envelopeError?.message ?? 'no error document was produced'}; ${ledger.toRenderCount} frame(s) ` +
            `remain and can be resumed with blender_final_render {resumeJobId: "${jobId}"}`,
          finishedAt: Date.now(),
          renderDurationMs: outcome.durationMs,
        }, { previous: current })
        this._appendOutput(live, `render job ${jobId} failed: ${record.message}\n`)
        live.settle?.({ status: 'failed', detail: record.message })
        return
      }

      // Every frame is present AND complete. Now the delivery half.
      record = this.renderJobs.write({
        ...this.renderJobs.read(projectId, jobId),
        status: 'running',
        pid: null,
        processGroupId: null,
        completedFrames: ledger.present.map(entry => entry.frame),
        missingFrames: [],
        corruptFrames: [],
        renderDurationMs: outcome.durationMs,
        meanMsPerFrame: live.journal.frameDurations().length > 0
          ? Math.round(live.journal.frameDurations().reduce((total, value) => total + value, 0) /
              live.journal.frameDurations().length)
          : null,
        message: `${ledger.presentCount} frame(s) rendered; encoding`,
      }, { previous: this.renderJobs.read(projectId, jobId) })

      this._appendOutput(live, `all ${ledger.presentCount} frame(s) rendered; encoding the delivery\n`)
      const delivery = await this._deliverJob({ record, spec, reason: 'render' })

      if (delivery.status === 'completed') {
        this._appendOutput(
          live,
          `delivery published: ${delivery.video?.path} (${delivery.video?.probed?.frameCount} frames, ` +
          `${delivery.video?.probed?.durationSeconds}s, ${delivery.video?.probed?.width}x` +
          `${delivery.video?.probed?.height} @ ${delivery.video?.probed?.fps} fps)\n`,
        )
        live.settle?.({
          status: 'completed',
          detail: `${delivery.video?.probed?.frameCount} frame(s) delivered to ${delivery.video?.path}`,
        })
        return
      }
      live.settle?.({ status: 'failed', detail: delivery.message ?? 'the delivery did not complete' })
    } catch (cause) {
      clearInterval(tick)
      const message = cause instanceof Error ? cause.message : String(cause)
      const current = this.renderJobs.readSafe(projectId, jobId)
      if (current !== null && !RenderJobStore.isTerminal(current)) {
        this.renderJobs.write({
          ...current,
          status: 'failed',
          pid: null,
          processGroupId: null,
          errorCode: cause instanceof BlenderError ? cause.code : BlenderErrorCode.SCRIPT_ERROR,
          message,
          finishedAt: Date.now(),
        }, { previous: current })
      }
      this._appendOutput(live, `render job ${jobId} failed: ${message}\n`)
      live.settle?.({ status: 'failed', detail: message })
      this.ctx.logger?.warn(`deepblend: render job ${jobId} failed: ${message}`)
    } finally {
      clearInterval(tick)
      this._liveRenders.delete(jobId)
    }
  }

  /**
   * Fold the child's journal into the record, verifying every frame it claims.
   *
   * The claim is checked against the frame's BYTES before it counts: a journal line
   * says the renderer intended to write a frame, and the ledger is what decides
   * whether a frame is there. One verification per claimed frame — not a full
   * directory scan per tick, which on 450 frames would cost more than the render.
   */
  async _absorbProgress(live, run, projectId, jobId) {
    const fresh = live.journal.drain()
    let changed = fresh.some(event => event?.type === 'frame')
    for (const event of fresh) {
      if (event?.type === 'frame' && Number.isSafeInteger(event.frame)) {
        const sample = sampleFrame(join(this.renderJobs.framesDirectory(projectId, jobId), frameFileName(event.frame)))
        const verdict = inspectFrameSample(sample, live.expectedSize)
        if (verdict.ok) live.verified.add(event.frame)
      }
    }
    if (fresh.length > 0) {
      for (const event of fresh) {
        if (event?.type === 'frame') {
          this._appendOutput(live, `frame ${event.frame} rendered (${event.ms ?? '?'} ms)\n`)
        } else if (event?.type === 'frame_failed') {
          this._appendOutput(live, `frame ${event.frame} FAILED: ${event.error ?? event.verify?.reason ?? 'unknown'}\n`)
        } else if (event?.type === 'unparseable-line') {
          this._appendOutput(live, 'the render journal contained a complete but unparseable line — a defect in the writer, not a torn kill\n')
        }
      }
    }
    // A torn line is what a kill mid-write looks like, and it must be visible: it
    // means the journal is not a complete account of what the renderer did, which is
    // exactly why the ledger is built from the frames instead. Reported once.
    if (live.journal.tornLineSeen && live.tornReported !== true) {
      live.tornReported = true
      this._appendOutput(
        live,
        'the render journal was cut mid-line (a kill between write and flush); progress is counted from the ' +
        'frame files themselves, so the count is unaffected\n',
      )
    }

    // The pid arrives from the child, and only the child can supply it (measured:
    // `ctx.subprocess.spawn` exposes no pid). Recording it is what makes an orphan
    // findable after this Host dies.
    const current = this.renderJobs.readSafe(projectId, jobId)
    if (current === null) return
    if (current.pid === null && existsSync(run.processPath)) {
      try {
        const identity = readJson(run.processPath)
        // The token is required, not merely preferred. A resumed attempt runs in the
        // SAME job directory as the attempt it continues, so a leftover identity
        // document is the normal case rather than a rare one — and reading it would
        // record a dead process as the live one. Deleting the stale file is the
        // provider's job; refusing an identity that is not this attempt's is the
        // host's, so the two together make "the pid is current" a checked fact.
        const identityIsCurrent = identity?.attemptToken !== undefined &&
          identity.attemptToken !== null &&
          identity.attemptToken === live.attemptToken
        if (identityIsCurrent && Number.isSafeInteger(identity.pid)) {
          this.renderJobs.write({
            ...current,
            pid: identity.pid,
            processGroupId: identity.processGroupId ?? null,
            attemptToken: identity.attemptToken,
          }, { previous: current })
          changed = true
        }
      } catch {
        // Mid-write; the next tick re-reads it.
      }
    }

    if (changed) {
      const latest = this.renderJobs.readSafe(projectId, jobId)
      if (latest === null || RenderJobStore.isTerminal(latest)) return
      const completed = [...live.verified].sort((left, right) => left - right)
      const expectedCount = latest.expectedFrames ?? (latest.frameEnd - latest.frameStart + 1)
      const estimate = estimateRemaining({
        perFrameMs: live.journal.frameDurations(),
        remainingFrames: Math.max(0, expectedCount - completed.length),
      })
      this.renderJobs.write({
        ...latest,
        completedFrames: completed,
        missingFrames: this.renderJobs.expectedFrames(latest).filter(frame => !live.verified.has(frame)),
        percent: renderProgressPercent({ expected: expectedCount, done: completed.length }),
        meanMsPerFrame: estimate.meanMsPerFrame === null ? null : Math.round(estimate.meanMsPerFrame),
        estimatedRemainingMs: estimate.estimatedRemainingMs,
      }, { previous: latest })
    }
  }

  _appendOutput(live, text) {
    live.output += text
    // Bounded: a 450-frame render produces one line per frame, and an unbounded
    // buffer in a process that lives for hours is a leak with a friendly name.
    if (live.output.length > 256 * 1024) live.output = live.output.slice(-128 * 1024)
  }

  /** The ledger for a record's own frames, with its own expected size. */
  _readJobLedger(record, expected) {
    return readFrameLedger({
      framesDirectory: record.framesDirectory ?? this.renderJobs.framesDirectory(record.projectId, record.jobId),
      expected,
      expectedSize: {
        width: record.renderConfig?.resolution?.[0],
        height: record.renderConfig?.resolution?.[1],
        prefix: record.filePrefix,
        padding: record.filePadding,
      },
    })
  }

  /**
   * Encode, verify, publish, and write the delivery manifest.
   *
   * Refuses to encode an incomplete frame set. Encoding "whatever is there" is how
   * a delivery silently ships 447 of 450 frames: ffmpeg would happily produce a
   * shorter video and every property check downstream would agree with the wrong
   * number unless the expected count came from the job.
   */
  async _deliverJob(input) {
    const record = input.record
    const projectId = record.projectId
    const jobId = record.jobId
    const expected = this.renderJobs.expectedFrames(record)
    const ledger = this._readJobLedger(record, expected)
    const total = expected.length

    if (ledger.presentCount !== total) {
      const current = this.renderJobs.read(projectId, jobId)
      const message =
        `${total - ledger.presentCount} of ${total} frame(s) are not complete ` +
        `(${ledger.missingCount} absent, ${ledger.corruptCount} incomplete), so there is nothing to encode yet. ` +
        `Continue with blender_final_render {resumeJobId: "${jobId}"}.`
      // An EXPORT of an already-terminal job changes nothing. Writing `failed` over
      // a cancelled or failed record would be an illegal transition (and the store
      // is right to refuse it) — and it would also destroy the record of what the
      // job actually is, in order to report a fact the caller can already see.
      if (input.reason === 'export' || RenderJobStore.isTerminal(current.status)) {
        if (current.status !== 'completed') {
          const next = {
            ...current,
            completedFrames: ledger.present.map(entry => entry.frame),
            missingFrames: ledger.toRender,
            corruptFrames: ledger.corrupt,
          }
          this.renderJobs.write(next, { previous: current })
        }
        throw new BlenderError(BlenderErrorCode.RENDER_FRAMES_INCOMPLETE, message, {
          detail: { jobId, expected: total, present: ledger.presentCount, toRender: ledger.toRender },
        })
      }
      this.renderJobs.write({
        ...current,
        status: 'failed',
        completedFrames: ledger.present.map(entry => entry.frame),
        missingFrames: ledger.toRender,
        corruptFrames: ledger.corrupt,
        errorCode: BlenderErrorCode.RENDER_FRAMES_INCOMPLETE,
        message,
        finishedAt: Date.now(),
      }, { previous: current })
      return { status: 'failed', message, problems: [], verified: false }
    }

    // Re-delivering a COMPLETED job must not re-open it: `completed` has no
    // outgoing transition on purpose, and an export that briefly called a finished
    // delivery "running" would make every reader of the record see a regression.
    const current = this.renderJobs.read(projectId, jobId)
    const liveStatus = current.status === 'completed' ? 'completed' : 'running'
    this.renderJobs.write({
      ...current,
      status: liveStatus,
      delivery: { status: 'encoding', startedAt: Date.now(), attempt: (current.delivery?.attempt ?? 0) + 1 },
      message: `encoding ${total} frame(s) into MP4`,
    }, { previous: current })

    const jobDirectory = this.renderJobs.jobDirectory(projectId, jobId)
    const output = encodedPath(jobDirectory, jobId)
    mkdirSync(join(jobDirectory, 'encoded'), { recursive: true })

    const encode = await encodeFrameSequence({
      ctx: this.ctx,
      ffmpegPath: this.config.ffmpegPath,
      framesDirectory: record.framesDirectory ?? this.renderJobs.framesDirectory(projectId, jobId),
      firstFrame: record.frameStart,
      frameCount: total,
      fps: record.fps,
      outputPath: output,
      filePrefix: record.filePrefix,
      filePadding: record.filePadding,
      crf: this.config.encodeCrf,
      preset: this.config.encodePreset,
    })

    const probed = await probeVideo({ ctx: this.ctx, ffprobePath: this.config.ffprobePath, path: output })
    const sources = this._deliverySources(projectId, record.revisionId)
    const publishRoot = join(this.store.projectDirectory(projectId), 'output')
    mkdirSync(publishRoot, { recursive: true })
    const videoPath = join(publishRoot, 'final.mp4')
    const manifestPath = join(publishRoot, 'delivery-manifest.json')

    const verdict = verifyVideoProperties({
      claimed: {
        frameStart: record.frameStart,
        frameEnd: record.frameEnd,
        frameCount: total,
        fps: record.fps,
        width: record.renderConfig?.resolution?.[0],
        height: record.renderConfig?.resolution?.[1],
      },
      probed: {
        durationSeconds: probed.durationSeconds,
        fps: probed.fps,
        width: probed.width,
        height: probed.height,
        nbFrames: probed.nbFrames,
        codec: probed.codec,
      },
    })

    if (!verdict.ok) {
      const message =
        `the encoded video does not match the job's own claims: ${verdict.problems
          .map(problem => `${problem.field} claimed ${JSON.stringify(problem.claimed)} but probed ${JSON.stringify(problem.probed)}`)
          .join('; ')}`
      const before = this.renderJobs.read(projectId, jobId)
      this.renderJobs.write({
        ...before,
        // A re-export that fails leaves a completed delivery completed; the failure
        // belongs to the delivery attempt, which is where it is recorded.
        status: before.status === 'completed' ? 'completed' : 'failed',
        delivery: {
          status: 'failed',
          videoPath: output,
          problems: verdict.problems,
          attempt: before.delivery?.attempt ?? 1,
          completedAt: Date.now(),
        },
        errorCode: BlenderErrorCode.ENCODE_VERIFY_FAILED,
        message,
        finishedAt: Date.now(),
      }, { previous: before })
      if (input.reason === 'export') {
        throw new BlenderError(BlenderErrorCode.ENCODE_VERIFY_FAILED, message, { detail: { problems: verdict.problems } })
      }
      return { status: 'failed', message, problems: verdict.problems, verified: false, video: null }
    }

    // Publish FIRST, then describe what was published. The manifest carries a
    // sha256 of the video, and an earlier version hashed `output/final.mp4` before
    // copying it there — so every manifest recorded `video.sha256: null`, which is
    // a delivery that cannot be checked against its own bytes. Copying to a
    // temporary name and renaming keeps the publication atomic, so a reader never
    // sees a half-written `final.mp4`.
    copyFileSync(encode.outputPath, `${videoPath}.tmp`)
    renameSync(`${videoPath}.tmp`, videoPath)

    const manifest = buildDeliveryManifest({
      record: { ...record, framesDirectory: record.framesDirectory ?? this.renderJobs.framesDirectory(projectId, jobId) },
      ledger,
      probed,
      encode,
      publish: { videoPath, relativeTo: this.store.projectDirectory(projectId) },
      sources,
      qa: sources.qaSummary,
      runtimeIdentity: this._runtimeIdentity(projectId, record.revisionId),
    })

    writeJsonAtomic(join(jobDirectory, 'manifest.json'), manifest)
    this.renderJobs.write({
      ...this.renderJobs.read(projectId, jobId),
      durationSeconds: probed.durationSeconds,
      videoFrameCount: probed.nbFrames,
      fpsProbed: probed.fps,
      resolution: [probed.width, probed.height],
    }, { previous: this.renderJobs.read(projectId, jobId) })

    writeJsonAtomic(manifestPath, manifest)
    const renderManifestPath = join(jobDirectory, 'manifest.json')
    const recordManifestPath = join(this.store.projectDirectory(projectId), 'renders', 'manifest.json')
    writeJsonAtomic(recordManifestPath, manifest)

    const before = this.renderJobs.read(projectId, jobId)
    const delivered = this.renderJobs.write({
      ...before,
      status: 'completed',
      errorCode: null,
      outputManifest: recordManifestPath,
      delivery: {
        status: 'published',
        videoPath,
        manifestPath,
        renderManifestPath,
        bytes: encode.bytes,
        sha256: manifest.video.sha256,
        verified: true,
        problems: [],
        encodeDurationMs: encode.durationMs,
        completedAt: Date.now(),
      },
      percent: 100,
      finishedAt: Date.now(),
      errorCode: null,
      message: `delivered ${probed.nbFrames} frame(s) as ${probed.width}x${probed.height} ${probed.codec} @ ${probed.fps} fps`,
    }, { previous: before })

    return {
      status: 'completed',
      verified: true,
      problems: [],
      completeness: manifest.completeness,
      video: {
        path: videoPath,
        bytes: encode.bytes,
        sha256: manifest.video.sha256,
        probed: manifest.video.probed,
        expected: manifest.video.expected,
      },
      manifest: { path: manifestPath, renderManifestPath, recordManifest: delivered.outputManifest },
      message: delivered.message,
    }
  }

  /**
   * The SceneSpec, checkpoint and QA artifacts a delivery manifest references.
   *
   * The QA report is READ, not merely pointed at: SPEC §19.8 requires the final
   * package to contain QA, and the M3 brief's test for the manifest is that a reader
   * can judge completeness WITHOUT opening the package. A path alone fails that test
   * — the reader cannot tell a passing QA report from a missing one. The full
   * document is not embedded either: `cameraParameters` alone is thousands of bytes
   * describing geometry the manifest already digests, so what travels is the
   * verdict plus the counts that make it checkable.
   */
  _deliverySources(projectId, revision) {
    const revisionDirectory = this.store.revisionDirectory(projectId, revision)
    const qaPath = join(revisionDirectory, 'validation.json')
    const qaReport = readJson(qaPath)
    return {
      sceneSpec: join(revisionDirectory, 'scene-spec.json'),
      checkpoint: this.store.checkpointPath(projectId, revision),
      qa: qaPath,
      qaSummary: qaReport === null ? null : this._qaSummary(qaReport),
    }
  }

  /** The checkable part of a revision's QA report. */
  _qaSummary(report) {
    const technical = report?.technical ?? {}
    const semantic = report?.semantic ?? {}
    return {
      schemaVersion: report?.schemaVersion ?? null,
      revision: report?.revision ?? null,
      ok: technical.ok === true && semantic.ok !== false,
      technicalOk: technical.ok === true,
      semanticOk: semantic.ok !== false,
      errorCount: Array.isArray(technical.errors) ? technical.errors.length : null,
      counts: technical.counts ?? null,
      frameRange: technical.frameRange ?? null,
      fps: technical.fps ?? null,
      engine: technical.engine ?? null,
      activeCamera: technical.activeCamera ?? null,
      notices: Array.isArray(semantic.notices) ? semantic.notices.length : null,
    }
  }

  /**
   * Runtime identity for the manifest (SPEC §9.5): what rendered this, so the
   * delivery can be reproduced or explained without guessing.
   */
  _runtimeIdentity(projectId, revision) {
    // Read from the revision's own manifest rather than from a fresh probe: the
    // identity that matters for reproducing a delivery is the one recorded when
    // the checkpoint was compiled (SPEC §9.5), and re-probing would report
    // whatever Blender is installed NOW, which may be a different build.
    const manifest = this.store.readRevisionManifest(projectId, revision)
    const runtime = manifest?.runtime ?? null
    return {
      source: 'revision-manifest',
      blenderVersion: runtime?.blenderVersion ?? null,
      engine: runtime?.engine ?? manifest?.validation?.engine ?? null,
      requestedEngine: runtime?.requestedEngine ?? null,
      protocolVersion: runtime?.protocolVersion ?? null,
    }
  }

  /** The canonical render-job projection shared by `getJob` and `listJobs`. */
  _canonicalRenderJob(record) {
    const completed = Array.isArray(record.completedFrames) ? record.completedFrames : []
    const expected = record.expectedFrames ?? (record.frameEnd - record.frameStart + 1)
    return {
      jobId: record.jobId,
      projectId: record.projectId,
      revisionId: record.revisionId,
      type: record.type,
      status: record.status,
      attempt: record.attempt,
      dshJobId: record.dshJobId ?? null,
      pid: record.pid ?? null,
      frameStart: record.frameStart,
      frameEnd: record.frameEnd,
      expectedFrames: expected,
      completedFrames: completed.length,
      completedFrameList: completed,
      missingFrames: record.missingFrames ?? [],
      corruptFrames: record.corruptFrames ?? [],
      percent: record.percent ?? renderProgressPercent({ expected, done: completed.length }),
      meanMsPerFrame: record.meanMsPerFrame ?? null,
      estimatedRemainingMs: record.estimatedRemainingMs ?? null,
      fps: record.fps,
      profileName: record.profileName ?? null,
      renderConfig: record.renderConfig ?? null,
      framesDirectory: record.framesDirectory ?? null,
      delivery: record.delivery ?? null,
      outputManifest: record.outputManifest ?? null,
      errorCode: record.errorCode ?? null,
      message: record.message ?? null,
      // The warnings were already stored with the record; M4 surfaces them
      // because one of them IS the approval requirement (SPEC §15.1 "高成本最终
      // 渲染达阈值审批"). Recomputing that judgement in the UI from a threshold
      // would be a second opinion about a fact the job already recorded.
      warnings: record.warnings ?? [],
      recovery: this._recoveryFindings.find(finding => finding.jobId === record.jobId) ?? null,
      description: describeRenderJob({ ...record, completedFrames: completed }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
    }
  }
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

/**
 * M3 surface, re-exported on the same terms as the M1 store above.
 *
 * The frame ledger is deliberately reachable from outside the package: it is the
 * rule that decides whether a delivery ships short or a three-hour render is
 * repeated, and a rule that can only be exercised through a running Host is a rule
 * whose failure modes are only discovered in production. The contract suite drives
 * it directly against frames whose bytes it controls.
 */
export { readFrameLedger, framesOnDisk, sampleFrame } from './frame-ledger.js'
export { RenderJobStore, formatRenderJobId, UNFINISHED_STATUSES } from './render-job-store.js'
export {
  JournalTail,
} from './render-journal.js'
export {
  checkProcessAlive,
  identifyProcess,
  reconcileRenderJob,
  stopProcessGroup,
} from './render-reconciler.js'
export { encodeFrameSequence, probeVideo } from './video-encoder.js'
export { buildDeliveryManifest, relativeTo } from './delivery-manifest.js'

/**
 * The first `length` bytes of a file, without reading the rest of it.
 *
 * `readFileSync` would be the obvious call and the wrong one: an ingested asset is allowed to
 * be a gigabyte (SPEC §15's example ceiling), and the content check needs 512 bytes of it.
 *
 * @param {string} path
 * @param {number} length
 * @returns {Buffer}
 */
function readFileHead(path, length) {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(descriptor, buffer, 0, length, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(descriptor)
  }
}
