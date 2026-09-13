/**
 * @deepblend/dsh-blender-contracts
 *
 * Service Definition and shared types for DeepBlend Studio (SPEC §5.1).
 *
 * This package is the frozen vocabulary shared by every other DeepBlend package:
 * the `BlenderRuntime` Service interface, the `BlenderStudio` facade interface,
 * the Blender bootstrap protocol envelope, stable error codes, and the
 * deepblend-specific artifact boundaries.
 *
 * It publishes NO service and registers NO tool — it is pure data, so it is safe
 * to consume from a Host composition, an Agent preset, or a Web Client half.
 *
 * Owner: DeepBlend Studio — M0
 */

/** Blender bootstrap protocol version. Bumped only on a breaking wire change. */
export const BLENDER_PROTOCOL_VERSION = 'deepblend.blender/v1'

/** SceneSpec schema version. Defined in M1; declared here so M0 can reference it. */
export const SCENE_SCHEMA_VERSION = 'deepblend.scene/v1'

/** ScenePatch document version. */
export const SCENE_PATCH_VERSION = 'deepblend.scene-patch/v1'

/** Revision manifest version written beside every revision directory. */
export const REVISION_MANIFEST_VERSION = 'deepblend.revision-manifest/v1'

/** Durable job record version (SPEC §9.3 result.json, §10.2). */
export const JOB_RECORD_VERSION = 'deepblend.job/v1'

/** Project record version. */
export const PROJECT_RECORD_VERSION = 'deepblend.project/v1'

/** Settings namespace owned by the DeepBlend host service. */
export const BLENDER_SETTINGS_NAMESPACE = 'deepblend'

/** Canonical telemetry/log scope marker used in warnings and logs. */
export const LOG_SCOPE = 'deepblend'

/**
 * Stable error codes (SPEC §11.1: "每个错误有稳定 errorCode").
 *
 * These are part of the wire contract with the model and the UI. Never renumber
 * or rename one; add a new code instead.
 */
export const BlenderErrorCode = Object.freeze({
  /** No Blender executable could be resolved from config or PATH. */
  NOT_FOUND: 'BLENDER_NOT_FOUND',
  /** A configured executable path exists but is not executable / is a directory. */
  EXECUTABLE_NOT_EXECUTABLE: 'BLENDER_EXECUTABLE_NOT_EXECUTABLE',
  /** A configured executable path escapes the allowlist (SPEC §15.2). */
  EXECUTABLE_OUTSIDE_ALLOWLIST: 'BLENDER_EXECUTABLE_OUTSIDE_ALLOWLIST',
  /** ctx.subprocess.spawn threw before a handle existed. */
  SPAWN_FAILED: 'BLENDER_SPAWN_FAILED',
  /** Blender exited with a non-zero code. */
  NONZERO_EXIT: 'BLENDER_NONZERO_EXIT',
  /** The probe exceeded its configured deadline. */
  TIMEOUT: 'BLENDER_TIMEOUT',
  /** The caller's AbortSignal fired. */
  ABORTED: 'BLENDER_ABORTED',
  /** bootstrap.py never wrote its result file. */
  RESULT_MISSING: 'BLENDER_RESULT_MISSING',
  /** The result file was not valid JSON. */
  RESULT_UNPARSEABLE: 'BLENDER_RESULT_UNPARSEABLE',
  /** bootstrap.py wrote a well-formed error envelope. */
  SCRIPT_ERROR: 'BLENDER_SCRIPT_ERROR',
  /** bootstrap.py reported a different protocolVersion. */
  PROTOCOL_VERSION_MISMATCH: 'BLENDER_PROTOCOL_VERSION_MISMATCH',
  /** bootstrap.py reported an action it does not implement. */
  UNSUPPORTED_ACTION: 'BLENDER_UNSUPPORTED_ACTION',
  /** The collection of capabilities threw unexpectedly inside Blender. */
  CAPABILITY_PROBE_FAILED: 'BLENDER_CAPABILITY_PROBE_FAILED',
  /** The configured bootstrap script is missing or unreadable. */
  BOOTSTRAP_MISSING: 'BLENDER_BOOTSTRAP_MISSING',
  /** A requested render engine is not available in this runtime (D1/D2). */
  ENGINE_UNAVAILABLE: 'BLENDER_ENGINE_UNAVAILABLE',
  /** Reserved: no Blender implementation was injected at all. */
  RUNTIME_UNAVAILABLE: 'BLENDER_RUNTIME_UNAVAILABLE',

  // ---- M1: project, revision and SceneSpec failures ------------------------
  //
  // These are grouped and named so the model can tell apart the three things a
  // failed write can mean: the input was wrong, the caller's view was stale, or
  // the machine failed. Only the middle one is worth retrying by re-reading.

  /** The project id does not exist in the project store. */
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  /** A project directory exists but its record is missing or unreadable. */
  PROJECT_CORRUPT: 'PROJECT_CORRUPT',
  /** A project with this id already exists. */
  PROJECT_EXISTS: 'PROJECT_EXISTS',
  /** A project id (or a derived slug) is not usable as a directory name. */
  PROJECT_ID_INVALID: 'PROJECT_ID_INVALID',

  /** The named revision does not exist in this project. */
  REVISION_NOT_FOUND: 'REVISION_NOT_FOUND',
  /** The SceneSpec stored in a revision is missing or no longer parses. */
  REVISION_CORRUPT: 'REVISION_CORRUPT',
  /** A checkpoint was required by the requested action but this revision has none. */
  REVISION_CHECKPOINT_MISSING: 'REVISION_CHECKPOINT_MISSING',

  /**
   * `baseRevision` is not the current revision. The caller read a stale view;
   * the write is refused rather than merged, because an implicit merge is how a
   * concurrent editor silently loses someone else's work (SPEC §8.5).
   */
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  /** No revision could be allocated (clock/sequence guard). */
  REVISION_ALLOCATION_FAILED: 'REVISION_ALLOCATION_FAILED',
  /** The requested revision id does not match the `r0001` grammar. */
  REVISION_ID_INVALID: 'REVISION_ID_INVALID',

  /** The SceneSpec failed structural or semantic validation. */
  SCENE_SPEC_INVALID: 'SCENE_SPEC_INVALID',
  /** The ScenePatch failed structural validation. */
  SCENE_PATCH_INVALID: 'SCENE_PATCH_INVALID',
  /** The ScenePatch was structurally fine but referenced something absent. */
  SCENE_PATCH_REJECTED: 'SCENE_PATCH_REJECTED',
  /** The compiled scene failed technical validation in Blender. */
  SCENE_VALIDATION_FAILED: 'SCENE_VALIDATION_FAILED',
  /** No camera could be selected for the requested preview. */
  SCENE_CAMERA_MISSING: 'SCENE_CAMERA_MISSING',

  /** A generated id, path or key would escape the workspace or project root. */
  PATH_OUTSIDE_WORKSPACE: 'PATH_OUTSIDE_WORKSPACE',
  /** A file name or id segment contained a separator or traversal. */
  PATH_SEGMENT_INVALID: 'PATH_SEGMENT_INVALID',

  /** A referenced asset file is not present in the project. */
  ASSET_MISSING: 'ASSET_MISSING',
  /** This Blender build cannot import the asset's format (D10). */
  ASSET_FORMAT_UNAVAILABLE: 'ASSET_FORMAT_UNAVAILABLE',
  /** The asset hash does not match the recorded sha256. */
  ASSET_HASH_MISMATCH: 'ASSET_HASH_MISMATCH',

  /** The requested render profile is not defined in the SceneSpec. */
  RENDER_PROFILE_MISSING: 'RENDER_PROFILE_MISSING',
  /** A render was refused because its estimated cost exceeds the configured budget. */
  RENDER_BUDGET_EXCEEDED: 'RENDER_BUDGET_EXCEEDED',
  /** Blender rendered but produced no image file. */
  RENDER_NO_OUTPUT: 'RENDER_NO_OUTPUT',

  // ---- M3: persistent render jobs, resumption, delivery -------------------

  /** No durable render job exists under that id in this project. */
  RENDER_JOB_NOT_FOUND: 'RENDER_JOB_NOT_FOUND',
  /** A render job already owns this project's delivery slot. */
  RENDER_JOB_CONFLICT: 'RENDER_JOB_CONFLICT',
  /** The render job is not in a state from which this operation is legal. */
  RENDER_JOB_STATE_INVALID: 'RENDER_JOB_STATE_INVALID',
  /** The requested frame range is empty, inverted, or outside the project's own. */
  RENDER_RANGE_INVALID: 'RENDER_RANGE_INVALID',
  /** A frame sequence finished without every frame of its range. */
  RENDER_FRAMES_INCOMPLETE: 'RENDER_FRAMES_INCOMPLETE',
  /** The encoder executable could not be resolved. */
  ENCODER_NOT_FOUND: 'ENCODER_NOT_FOUND',
  /** ffmpeg ran and failed. */
  ENCODE_FAILED: 'ENCODE_FAILED',
  /** The encoded file does not have the properties the manifest claims. */
  ENCODE_VERIFY_FAILED: 'ENCODE_VERIFY_FAILED',
  /** ffprobe could not be resolved or could not read the file. */
  PROBE_FAILED: 'PROBE_FAILED',
  /** A delivery was requested for a job that has not produced every frame. */
  DELIVERY_INCOMPLETE: 'DELIVERY_INCOMPLETE',
})

/** Warning codes surface on the successful path, where nothing threw. */
export const BlenderWarningCode = Object.freeze({
  /** Detection is unavailable; the caller is looking at a degraded result (D1). */
  BLENDER_NOT_INSTALLED: 'BLENDER_NOT_INSTALLED',
  /** A preferred engine IS reachable but is silently absent from the static enum (D1). */
  ENGINE_NOT_IN_STATIC_ENUM: 'ENGINE_NOT_IN_STATIC_ENUM',
  /** A configured/likely-required engine is genuinely unavailable (D2). */
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  /** A render profile was downgraded to a reachable engine (D2). */
  ENGINE_DOWNGRADED: 'ENGINE_DOWNGRADED',
  /** CPU-only: no GPU device was detected. */
  GPU_UNAVAILABLE: 'GPU_UNAVAILABLE',
  /** A format the product wants is not provided by this Blender build (SPEC §2.2 gap). */
  FORMAT_UNAVAILABLE: 'FORMAT_UNAVAILABLE',
  /** An add-on could not be enabled. */
  ADDON_ENABLE_FAILED: 'ADDON_ENABLE_FAILED',
  /** A warning passed through verbatim from bootstrap.py. */
  PROBE_WARNING: 'PROBE_WARNING',
  /** Result derived from a stale cache entry. */
  STALE_CAPABILITIES: 'STALE_CAPABILITIES',

  // ---- M1 ----------------------------------------------------------------

  /** A write succeeded but changed nothing (the same intent was already applied). */
  SCENE_PATCH_NO_CHANGE: 'SCENE_PATCH_NO_CHANGE',
  /** A render profile was downgraded to a reachable engine. */
  RENDER_ENGINE_DOWNGRADED: 'RENDER_ENGINE_DOWNGRADED',
  /** Preview rendered at a lower sample count than the profile asked for. */
  RENDER_SAMPLES_REDUCED: 'RENDER_SAMPLES_REDUCED',
  /** The compiler made a decision the author did not spell out (see notices). */
  SCENE_COMPILER_DECISION: 'SCENE_COMPILER_DECISION',
  /** A referenced asset is declared but its file has not been ingested yet. */
  SCENE_ASSET_NOT_INGESTED: 'SCENE_ASSET_NOT_INGESTED',
  /** An animation track targets a property whose keyframes were clamped or dropped. */
  SCENE_ANIMATION_KEYFRAMES_ADJUSTED: 'SCENE_ANIMATION_KEYFRAMES_ADJUSTED',

  // ---- M3 ----------------------------------------------------------------

  /**
   * A render could not be registered as a DSH background job, so it will not
   * appear in the harness job list. The render itself is unaffected and its
   * durable record is still authoritative — but the caller must be able to see
   * why the job it asked for is not where it expected it.
   */
  JOB_PROJECTION_UNAVAILABLE: 'JOB_PROJECTION_UNAVAILABLE',
  /** A delivery had to be verified against a claim the runtime could not re-derive. */
  DELIVERY_CLAIM_UNAVAILABLE: 'DELIVERY_CLAIM_UNAVAILABLE',
})

/**
 * The host API version the packages in this build implement.
 *
 * WHY A NUMBER AND NOT A METHOD PROBE
 * -----------------------------------
 * A tool plane newer than the host plane is a REAL deployment state, not a
 * hypothetical: a Cordis service keeps the code it was constructed from, and Node's
 * ESM module cache is process-level, so replacing the packages on disk does not
 * replace the running `blenderStudio`. MEASURED while M3 was written — the `dsh web`
 * process then running had started five hours before the M3 commit.
 *
 * Probing for methods catches that state for `resumeRenderJob`, `listJobs` and
 * `reconcileRenderJobs` (they are simply absent), and MISSES it for
 * `startFinalRender` and `exportProject`, because M1 implemented those as stubs and
 * so `typeof` is `'function'` on both the old and the new host. The failure mode of
 * the probe is therefore the worst kind: it guards four entry points and silently
 * lets the other two through. A number answers the question the probe was trying to
 * answer.
 *
 * Bump this when the tool plane starts depending on a host method that did not exist
 * before. 3 is M3 (the persistent render job).
 */
export const HOST_API_VERSION = 3

/** Formats the product intends to support (SPEC §2.2). Used to emit warnings. */
export const EXPECTED_IMPORT_FORMATS = Object.freeze(['gltf', 'fbx', 'obj', 'usd'])
/** Formats the product intends to be able to export. */
export const EXPECTED_EXPORT_FORMATS = Object.freeze(['gltf', 'fbx', 'usd'])

/** Candidate render engines probed behaviorally. Never assume one exists (D1). */
export const CANDIDATE_RENDER_ENGINES = Object.freeze([
  'BLENDER_EEVEE',
  'CYCLES',
  'BLENDER_WORKBENCH',
])

/**
 * A typed, serializable DeepBlend failure.
 *
 * Carries a stable `code` from {@link BlenderErrorCode} so the model, the UI and
 * the audit log can branch on it without parsing prose.
 */
export class BlenderError extends Error {
  /**
   * @param {string} code - a {@link BlenderErrorCode} value.
   * @param {string} message - human-readable, safe to show to the model.
   * @param {{ detail?: unknown, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'BlenderError'
    this.code = code
    if (options.detail !== undefined) this.detail = options.detail
  }

  /** Canonical JSON form for tool results and API responses. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.detail !== undefined ? { detail: this.detail } : {},
    }
  }
}

/** Narrowing helper for callers that receive unknown thrown values. */
export function isBlenderError(value) {
  return value instanceof BlenderError
}

/**
 * Build a warning entry. Warnings never throw; they degrade a successful result.
 * @param {string} code - a {@link BlenderWarningCode} value.
 * @param {string} message - human-readable explanation.
 * @param {Record<string, unknown>} [detail]
 */
export function warning(code, message, detail) {
  return { code, message, ...detail !== undefined ? { detail } : {} }
}

/**
 * @typedef {object} BlenderExecutableReport
 * @property {string} requested - exactly what the operator configured.
 * @property {string|null} resolved - canonical absolute path actually used, or null.
 * @property {boolean} found - whether a usable executable was resolved.
 */

/**
 * @typedef {object} BlenderEngineProbe
 * @property {boolean} assignable - whether assigning the identifier actually took effect.
 * @property {string|null} readback - what `scene.render.engine` read back as.
 * @property {string|null} error - exception text when the probe threw.
 */

/**
 * One GPU compute backend's support status.
 *
 * An unsupported backend *raises* on assignment rather than returning an empty
 * device list (`TypeError: enum "OPTIX" not found in ('NONE', 'METAL')`), so
 * `supported: false` is a normal, expected outcome — never a probe failure.
 *
 * @typedef {object} BlenderGpuBackend
 * @property {boolean} supported
 * @property {string[]} gpuDevices
 * @property {string[]} cpuDevices
 * @property {string|null} error
 */

/**
 * The GPU report produced by `bootstrap.py`, normalised by the provider.
 *
 * @typedef {object} BlenderGpuReport
 * @property {string[]} availableBackends - backends that reported at least one GPU device.
 * @property {string|null} preferredBackend
 * @property {string[]} gpuDeviceNames - flattened GPU device names across available backends.
 * @property {string[]} cpuDeviceNames
 * @property {Record<string, BlenderGpuBackend>} backendSupport
 */

/**
 * @typedef {object} BlenderRenderSmokeTest
 * @property {boolean} attempted
 * @property {string|null} engine
 * @property {boolean} ok
 * @property {number} bytes
 * @property {string|null} error
 */

/**
 * The behavioral capability report produced by `bootstrap.py` (D1).
 *
 * `renderEngines` is deliberately a *behavioral* probe result rather than the
 * static `engine` enum: on Blender 5.2.1 the enum reports only `BLENDER_EEVEE`
 * even though assigning `CYCLES` succeeds. `renderEngineEnumItems` is retained
 * as an informational diagnostic and must never be used to gate availability.
 *
 * @typedef {object} BlenderCapabilities
 * @property {string} protocolVersion
 * @property {boolean} installed
 * @property {BlenderExecutableReport} executable
 * @property {string|null} blenderVersion
 * @property {number[]|null} blenderVersionTuple
 * @property {string|null} pythonVersion
 * @property {string|null} buildHash
 * @property {string|null} binaryPath
 * @property {Record<string, BlenderEngineProbe>} renderEngines
 * @property {string|null} bestAvailableEngine - preferred engine per the probe's own ordering.
 * @property {string[]} renderEngineEnumItems - diagnostic only (D1).
 * @property {BlenderGpuReport} gpu
 * @property {boolean} gpuAvailable
 * @property {string[]} exportFormats
 * @property {string[]} importFormats
 * @property {string[]} unavailableFormats - attribute-present but unregistered operators.
 * @property {BlenderRenderSmokeTest|null} renderSmokeTest
 * @property {BlenderRenderSmokeTest|null} cyclesSmokeTest
 * @property {boolean} textBlockApi
 * @property {boolean} frameApi
 * @property {string|null} hostPlatform
 * @property {{ code: string, message: string, detail?: unknown }[]} warnings
 * @property {number} probedAt - epoch ms.
 * @property {number} durationMs
 * @property {string|null} commandLine - for audit; never contains secrets.
 */

/**
 * The Blender execution seam (SPEC §7.1).
 *
 * Implementations own process launch, protocol framing and result validation.
 * They hold NO business state machine — orchestration belongs to
 * `BlenderOrchestrator` and persistence to the project/revision stores.
 *
 * M0 implements `getCapabilities` and the shared `runBootstrap` transport.
 * The remaining methods are declared here as the frozen target shape and are
 * implemented in M1+. Calling an unimplemented one throws
 * `BlenderErrorCode.UNSUPPORTED_ACTION`, never silently succeeds.
 *
 * @typedef {object} BlenderRuntime
 * @property {(signal?: AbortSignal) => Promise<BlenderCapabilities>} getCapabilities
 * @property {(request: BlenderBootstrapRequest, options?: { signal?: AbortSignal }) => Promise<BlenderBootstrapEnvelope>} runBootstrap
 * @property {() => void} dispose
 */

/**
 * @typedef {object} BlenderBootstrapRequest
 * @property {string} action - bootstrap action name, e.g. `get_capabilities`.
 * @property {Record<string, unknown>} [payload] - action-specific fields.
 * @property {string} [jobId] - correlation id for logs and the result envelope.
 */

/**
 * The envelope `bootstrap.py` writes to its result file.
 *
 * @typedef {object} BlenderBootstrapEnvelope
 * @property {'success'|'error'} status
 * @property {string} protocolVersion
 * @property {string|null} jobId
 * @property {BlenderCapabilities|null} capabilities
 * @property {{ code: string, message: string }|null} error
 * @property {string[]} warnings
 */

/**
 * The model- and UI-facing business facade (SPEC §7.2).
 *
 * M0 implements `getCapabilities` only. Everything else is the frozen M1+ target
 * and throws `UNSUPPORTED_ACTION` until implemented, so the model can never
 * believe a not-yet-built capability worked.
 *
 * @typedef {object} BlenderStudio
 * @property {(request?: { refresh?: boolean }) => Promise<BlenderCapabilities>} getCapabilities
 */

/**
 * Project a raw capabilities object into the canonical, stable-order JSON that
 * the tool returns and the UI renders.
 *
 * Key order is fixed so transcripts diff cleanly and tests can compare output
 * (SPEC §19.5 golden scenes rely on deterministic serialization).
 *
 * @param {BlenderCapabilities} capabilities
 * @returns {Record<string, unknown>}
 */
export function toCanonicalCapabilities(capabilities) {
  return {
    protocolVersion: capabilities.protocolVersion,
    installed: capabilities.installed,
    executable: {
      requested: capabilities.executable.requested,
      resolved: capabilities.executable.resolved,
      found: capabilities.executable.found,
    },
    version: capabilities.blenderVersion,
    versionTuple: capabilities.blenderVersionTuple,
    pythonVersion: capabilities.pythonVersion,
    buildHash: capabilities.buildHash,
    binaryPath: capabilities.binaryPath,
    // Behavioral availability — the only field a caller may branch on (D1).
    engines: Object.fromEntries(
      Object.entries(capabilities.renderEngines).map(([id, probe]) => [
        id,
        { available: probe.assignable, readback: probe.readback, error: probe.error },
      ]),
    ),
    bestAvailableEngine: capabilities.bestAvailableEngine,
    // Diagnostic only. Present so operators can see the enum lie for themselves.
    engineEnumItems: capabilities.renderEngineEnumItems,
    gpu: {
      available: capabilities.gpuAvailable,
      backends: capabilities.gpu.availableBackends,
      preferredBackend: capabilities.gpu.preferredBackend,
      devices: capabilities.gpu.gpuDeviceNames,
      cpuDevices: capabilities.gpu.cpuDeviceNames,
      backendSupport: capabilities.gpu.backendSupport,
    },
    formats: {
      import: capabilities.importFormats,
      export: capabilities.exportFormats,
      // Attribute-present but unregistered operators: the trap that makes
      // `hasattr(bpy.ops.export_scene, 'obj')` an unsafe availability test.
      unavailable: capabilities.unavailableFormats,
    },
    renderSmokeTest: capabilities.renderSmokeTest,
    cyclesSmokeTest: capabilities.cyclesSmokeTest,
    api: {
      textBlocks: capabilities.textBlockApi,
      frameRange: capabilities.frameApi,
    },
    hostPlatform: capabilities.hostPlatform,
    warnings: capabilities.warnings,
    probedAt: capabilities.probedAt,
    durationMs: capabilities.durationMs,
  }
}

// ---------------------------------------------------------------------------
// M1 surface
//
// The M0 section above is frozen. Everything this milestone added lives in its
// own module and is re-exported here, so every consumer keeps importing exactly
// one package name (SPEC §5.1: contracts is the shared vocabulary) and the
// dependency graph stays acyclic.
// ---------------------------------------------------------------------------

export {
  canonicalStringify,
  canonicalPretty,
  sortValue,
  sha256,
  sha256Canonical,
  shortDigest,
} from './canonical.js'

export {
  SchemaDefinitionError,
  compileSchema,
  compileSchemaText,
  formatIssues,
} from './json-schema.js'

export {
  DEFAULT_WORLD,
  ANIMATION_TARGET_KINDS,
  ANIMATION_PROPERTIES,
  ANIMATION_PROPERTIES_BY_KIND,
  TRANSFORM_ANIMATION_PROPERTIES,
  MATERIAL_ANIMATION_PROPERTIES,
  collectionForKind,
  collectionNameForKind,
  SCENE_ENGINES,
  BLENDER_ENGINE_BY_KEY,
  IMPORT_OPERATOR_BY_ASSET_TYPE,
  validateSceneSpec,
  compileSceneSpec,
  entityBoundingRadius,
  sceneProjection,
  sceneSpecDigest,
  specHash,
  summarizeSceneSpec,
  sceneSpecCanonicalText,
} from './scene-spec.js'

export {
  CAMERA_UPDATE_FIELDS,
  SCENE_OPERATION_NAMES,
  validateScenePatch,
  applyPatchToSpec,
  buildOperationManifest,
} from './scene-patch.js'

export {
  toCanonicalProjectSummary,
  toCanonicalRevisionSummary,
  toCanonicalPreviewArtifact,
  toCanonicalPreviewResult,
  toCanonicalQAReport,
  toCanonicalJobRecord,
  toCanonicalFailure,
} from './projections.js'

// ---------------------------------------------------------------------------
// M2 surface
//
// The visual loop's vocabulary: how a render is measured into a score, what a
// finding is, and how repeated findings are detected. Kept in its own module for
// the same reason as the M1 block above.
// ---------------------------------------------------------------------------

export {
  VISUAL_ISSUE_VERSION,
  VISUAL_REVIEW_VERSION,
  VISUAL_ISSUE_CATEGORIES,
  VISUAL_SEVERITIES,
  VISUAL_PASS_SCORE,
  SUBJECT_PART_TAG,
  isSubjectPart,
  LUMINANCE_BUCKETS,
  COVERAGE_BUCKETS,
  CENTERING_BUCKETS,
  quantise,
  issueFingerprint,
  scoreView,
  scoreReview,
  validateFindings,
  seedFingerprintCounters,
  shouldHandOver,
  updateFingerprintCounters,
} from './visual-issue.js'

export {
  decodePng,
  encodePng,
  createImage,
  fillRect,
  blendInto,
} from './png.js'

export {
  GLYPH_WIDTH,
  GLYPH_HEIGHT,
  textWidth,
  drawText,
} from './bitmap-font.js'

export {
  CAPTION_BAND_COLOR,
  composeContactSheet,
  viewCaption,
} from './contact-sheet.js'

export {
  runVisualLoop,
} from './visual-loop.js'

// ---------------------------------------------------------------------------
// M3 surface
//
// The persistent render job: the durable record's vocabulary, the frame ledger
// that decides what still has to be rendered, and the delivery manifest's own
// completeness and video-property checks. Pure, like the M1/M2 blocks above, so
// the acceptance suite can exercise a restart's decision rules with no Blender
// and no ffmpeg present.
// ---------------------------------------------------------------------------

export {
  RENDER_JOB_VERSION,
  FRAME_PLAN_VERSION,
  PROCESS_IDENTITY_VERSION,
  DELIVERY_MANIFEST_VERSION,
  RENDER_JOB_STATUSES,
  RENDER_JOB_TERMINAL_STATUSES,
  RENDER_JOB_TYPES,
  FRAME_FILE_PREFIX,
  FRAME_FILE_PADDING,
  MIN_FRAME_BYTES,
  isTerminalRenderJobStatus,
  canTransitionRenderJob,
  checkTransition,
  frameFileName,
  frameNumbers,
  inspectFrameSample,
  inspectFrameBytes,
  resolveFrameLedger,
  renderProgressPercent,
  estimateRemaining,
  verifyVideoProperties,
  deliveryCompleteness,
  describeRenderJob,
} from './render-job.js'

export {
  VIEW_ROLES,
  buildViewPlan,
  trackedObjects,
  subjectParts,
  resolveSubject,
  resolveSubjectId,
  buildVisualReview,
  describeMeasurements,
} from './visual-composition.js'
