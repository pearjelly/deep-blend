/**
 * Canonical JSON projections for the M1 tool and UI surface.
 *
 * Every model-facing and browser-facing payload is built HERE, once, from the
 * same functions. That is the SPEC §14.3 rule made structural: "浏览器状态不是
 * 权威状态" is easy to honour when there is exactly one projection to disagree
 * with, and impossible to honour when each surface formats its own answers.
 *
 * Each projection is a pure function of stored state — no clocks, no paths that
 * the caller cannot see, no live Cordis objects. Only leaf values are copied, so
 * a projection can never leak a Host reference into a tool result.
 *
 * Owner: DeepBlend Studio — M1
 */

/**
 * @typedef {object} JobReference
 * @property {string} jobId
 * @property {string} action
 * @property {'running'|'succeeded'|'failed'} status
 * @property {string} projectId
 * @property {string|null} revision
 */

/**
 * The compact project summary handed to the model and the UI.
 *
 * @param {object} input
 * @param {object} input.record - the stored project record.
 * @param {number} input.revisionCount
 * @param {Record<string, unknown>|null} [input.sceneSummary] - a SceneDigest, when known.
 * @returns {Record<string, unknown>}
 */
export function toCanonicalProjectSummary({ record, revisionCount, sceneSummary = null }) {
  return {
    projectId: record.projectId,
    title: record.title,
    goal: record.goal ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    currentRevision: record.currentRevision,
    revisionCount,
    projectsRoot: record.projectsRoot ?? null,
    scene: sceneSummary,
  }
}

/**
 * The revision summary returned by a successful write or restore (SPEC §7.2
 * `RevisionSummary`).
 *
 * @param {object} input
 * @param {object} input.manifest - `revision-manifest.json`.
 * @param {string} [input.checkpointPath] - project-relative, present only when a
 *   checkpoint exists.
 * @returns {Record<string, unknown>}
 */
export function toCanonicalRevisionSummary({ manifest, checkpointPath = null }) {
  return {
    revision: manifest.revision,
    revisionNumber: manifest.revisionNumber,
    baseRevision: manifest.baseRevision ?? null,
    createdAt: manifest.createdAt,
    kind: manifest.kind,
    digest: manifest.digest,
    specHash: manifest.specHashAfter ?? null,
    summary: manifest.summary ?? null,
    actor: manifest.actor ?? null,
    stage: manifest.stage ?? null,
    idempotencyKey: manifest.idempotencyKey ?? null,
    sceneChanged: manifest.digestBefore !== manifest.digestAfter,
    specChanged: manifest.specChanged === true,
    checkpoint: checkpointPath,
    previews: manifest.previews ?? [],
    validation: manifest.validation ?? null,
    isCurrent: manifest.isCurrent === true,
  }
}

/**
 * A single rendered image reference. Paths are PROJECT-relative so a manifest
 * survives the workspace being moved (SPEC §13.1: the session stores paths and
 * hashes, never the bytes).
 *
 * @param {object} artifact
 * @returns {Record<string, unknown>}
 */
export function toCanonicalPreviewArtifact(artifact) {
  return {
    kind: artifact.kind,
    path: artifact.path,
    cameraId: artifact.cameraId ?? null,
    frame: artifact.frame ?? null,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
    engine: artifact.engine ?? null,
    samples: artifact.samples ?? null,
    bytes: artifact.bytes ?? null,
    sha256: artifact.sha256 ?? null,
    mime: artifact.mime ?? null,
  }
}

/**
 * The preview render result (SPEC §7.1 `PreviewRenderResult`).
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.revision
 * @param {string} input.digest
 * @param {object} input.profile - the render profile actually used.
 * @param {object[]} input.artifacts
 * @param {object[]} [input.warnings]
 * @param {object} [input.job]
 * @returns {Record<string, unknown>}
 */
export function toCanonicalPreviewResult({ projectId, revision, digest, profile, artifacts, warnings = [], job = null }) {
  return {
    projectId,
    revision,
    digest,
    profile: {
      engine: profile.engine,
      blenderEngine: profile.blenderEngine,
      resolution: profile.resolution,
      samples: profile.samples,
      filmTransparent: profile.filmTransparent === true,
    },
    artifacts: artifacts.map(toCanonicalPreviewArtifact),
    warnings,
    job,
  }
}

/**
 * Normalize one validation finding.
 *
 * @param {object} issue
 * @returns {Record<string, unknown>}
 */
function toCanonicalIssue(issue) {
  return {
    severity: issue.severity ?? 'error',
    code: issue.code,
    path: issue.path ?? null,
    message: issue.message,
    detail: issue.detail ?? null,
  }
}

/**
 * The QA report returned by `validateScene` (SPEC §7.2 `QAReport`).
 *
 * `ok` means "no error-severity finding"; notices are expected and are reported
 * rather than suppressed, because a notice is the compiler telling the caller
 * which decision it made on their behalf.
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.revision
 * @param {string} input.digest
 * @param {object[]} input.errors
 * @param {object[]} input.notices
 * @param {object|null} [input.technical] - Blender-side technical report.
 * @param {object|null} [input.job]
 * @returns {Record<string, unknown>}
 */
export function toCanonicalQAReport({ projectId, revision, digest, errors, notices, technical = null, job = null }) {
  return {
    projectId,
    revision,
    digest,
    ok: errors.length === 0,
    errorCount: errors.length,
    noticeCount: notices.length,
    errors: errors.map(toCanonicalIssue),
    notices: notices.map(toCanonicalIssue),
    technical,
    job,
  }
}

/**
 * The stored job record (SPEC §9.3 / §10.2).
 *
 * @param {object} record
 * @returns {Record<string, unknown>}
 */
export function toCanonicalJobRecord(record) {
  return {
    jobId: record.jobId,
    projectId: record.projectId,
    action: record.action,
    status: record.status,
    revision: record.revision ?? null,
    errorCode: record.errorCode ?? null,
    message: record.message ?? null,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    durationMs: record.durationMs ?? null,
    idempotencyKey: record.idempotencyKey ?? null,
    baseRevision: record.baseRevision ?? null,
    artifacts: (record.artifacts ?? []).map(toCanonicalPreviewArtifact),
  }
}

/**
 * Project a thrown value into the canonical error envelope every tool returns.
 *
 * @param {unknown} cause
 * @param {{ isBlenderError: (value: unknown) => boolean, fallbackCode: string }} options
 * @returns {{ code: string, message: string, detail: unknown, stack: string|null }}
 */
export function toCanonicalFailure(cause, options) {
  const error = /** @type {any} */ (cause)
  if (options.isBlenderError(cause)) {
    return {
      code: error.code,
      message: error.message,
      detail: error.detail ?? null,
      stack: null,
    }
  }
  if (error?.patchIssue !== undefined) {
    return {
      code: error.patchIssue.code,
      message: error.patchIssue.message,
      detail: { path: error.patchIssue.path },
      stack: null,
    }
  }
  return {
    code: options.fallbackCode,
    message: error instanceof Error ? error.message : String(cause),
    detail: null,
    // A stack is included ONLY for an unrecognized failure: it is the one case
    // where the caller cannot branch on a code and the trace is the whole value.
    stack: error instanceof Error ? (error.stack ?? null) : null,
  }
}
