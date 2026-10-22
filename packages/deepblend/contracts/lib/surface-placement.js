import { BlenderError, BlenderErrorCode } from './index.js'

export const SURFACE_PLACEMENT_VERSION = 'deepblend.surface-placement/v1'
export const SURFACE_PLACEMENT_LIMITS = Object.freeze({ meshes: 128, vertices: 2_000_000,
  triangles: 2_000_000, candidatePairs: 1_000_000, checkpointBytes: 1024 ** 3,
  reportBytes: 64 * 1024, toleranceMeters: .00002 })

const only = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k))
const vector = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(Number.isFinite)
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(v)
const integer = (v, low, high) => Number.isSafeInteger(v) && v >= low && v <= high
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon
const translation = v => vector(v) && v[0] === 0 && v[1] === 0
const refuse = (message, code = BlenderErrorCode.SCENE_VALIDATION_FAILED) => { throw new BlenderError(code, `Surface placement: ${message}`) }

/** A measurement is always tied to an explicit frame and exact native bytes. */
export function validateSurfacePlacementSelection(request) {
  const invalid = message => refuse(message, BlenderErrorCode.SCENE_PATCH_INVALID)
  if (!id(request?.subjectEntityId) || !id(request?.supportEntityId) || request.subjectEntityId === request.supportEntityId) invalid('select distinct subject and support entities.')
  if (!integer(request.frame, 0, 1_000_000)) invalid('an explicit integer frame from 0 to 1000000 is required.')
  if (!hash(request.checkpointSha256)) invalid('the expected checkpoint SHA256 is required.')
  const clearanceMm = request.clearanceMm === undefined ? 0 : request.clearanceMm
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0 || clearanceMm > 1000) invalid('clearanceMm must be between 0 and 1000.')
  const baseline = ['baselineCheckpointPath', 'baselineCheckpointSha256', 'expectedTranslationMeters'].map(k => request[k] !== undefined)
  if (baseline.some(Boolean) && (!baseline.every(Boolean) ||
      typeof request.baselineCheckpointPath !== 'string' || !request.baselineCheckpointPath ||
      !hash(request.baselineCheckpointSha256) || !translation(request.expectedTranslationMeters))) invalid('baseline verification requires a checkpoint path, SHA256 and a world-Z translation together.')
}

function verifyObject(value) {
  if (!only(value, ['meshObjectCount', 'vertexCount', 'triangleCount', 'rootWorldMatrix', 'worldBoundsMeters']) ||
      !integer(value.meshObjectCount, 1, SURFACE_PLACEMENT_LIMITS.meshes) ||
      !integer(value.vertexCount, 3, SURFACE_PLACEMENT_LIMITS.vertices) ||
      !integer(value.triangleCount, 1, SURFACE_PLACEMENT_LIMITS.triangles) ||
      !Array.isArray(value.rootWorldMatrix) || value.rootWorldMatrix.length !== 4 ||
      !value.rootWorldMatrix.every(row => vector(row, 4)) ||
      value.rootWorldMatrix.some(row => row.some(v => Math.abs(v) > 1e6)) ||
      value.rootWorldMatrix[3].some((v, i) => v !== (i === 3 ? 1 : 0)) ||
      !only(value.worldBoundsMeters, ['min', 'max']) ||
      !vector(value.worldBoundsMeters.min) || !vector(value.worldBoundsMeters.max) ||
      [...value.worldBoundsMeters.min, ...value.worldBoundsMeters.max].some(v => Math.abs(v) > 1e6) ||
      value.worldBoundsMeters.min.some((v, i) => v > value.worldBoundsMeters.max[i])) refuse('invalid native mesh counts, transform or bounds.')
}

/** Accept actual surface witnesses, never a successful exit or a claimed scalar alone. */
export function verifySurfacePlacementReport(report, request) {
  validateSurfacePlacementSelection(request)
  if (!only(report, ['schemaVersion', 'axis', 'checkpointSha256', 'checkpointUnchanged', 'frame', 'blenderVersion',
    'subjectEntityId', 'supportEntityId', 'clearanceMm', 'translationMeters', 'subjectContactMeters', 'supportContactMeters',
    'placedSubjectContactMeters', 'subjectTriangleIndex', 'supportTriangleIndex', 'statistics', 'subject', 'support',
    ...(request.baselineCheckpointPath === undefined ? [] : ['baselineVerification'])]) ||
      Buffer.byteLength(JSON.stringify(report)) > SURFACE_PLACEMENT_LIMITS.reportBytes ||
      report.schemaVersion !== SURFACE_PLACEMENT_VERSION || report.axis !== 'world-z' ||
      report.checkpointSha256 !== request.checkpointSha256 || report.checkpointUnchanged !== true ||
      report.frame !== request.frame || report.subjectEntityId !== request.subjectEntityId || report.supportEntityId !== request.supportEntityId ||
      report.clearanceMm !== (request.clearanceMm ?? 0) || typeof report.blenderVersion !== 'string' || !report.blenderVersion ||
      !translation(report.translationMeters) || !vector(report.subjectContactMeters) || !vector(report.supportContactMeters) || !vector(report.placedSubjectContactMeters) ||
      !only(report.statistics, ['candidatePairs']) || !integer(report.statistics.candidatePairs, 1, SURFACE_PLACEMENT_LIMITS.candidatePairs)) refuse('the report differs from the requested source, frame, selection or bounded protocol.')
  verifyObject(report.subject); verifyObject(report.support)
  if (!integer(report.subjectTriangleIndex, 0, report.subject.triangleCount - 1) ||
      !integer(report.supportTriangleIndex, 0, report.support.triangleCount - 1)) refuse('the contact triangle is outside the measured geometry.')
  const s = report.subjectContactMeters, t = report.supportContactMeters, p = report.placedSubjectContactMeters
  if (![0, 1].every(i => near(s[i], t[i])) || ![0, 1, 2].every(i => near(p[i], s[i] + report.translationMeters[i])) ||
      !near(p[2] - t[2], report.clearanceMm / 1000)) refuse('contact witnesses do not establish the requested vertical clearance.')
  for (const [point, object] of [[s, report.subject], [t, report.support]]) {
    if (point.some((v, i) => v < object.worldBoundsMeters.min[i] - 1e-6 || v > object.worldBoundsMeters.max[i] + 1e-6)) refuse('a contact witness is outside its native bounds.')
  }
  if (request.baselineCheckpointPath !== undefined) {
    const b = report.baselineVerification
    if (!only(b, ['checkpointSha256', 'checkpointUnchanged', 'translationMeters', 'subjectRigidTranslation', 'supportUnchanged',
      'subjectMaxErrorMeters', 'supportMaxErrorMeters', 'toleranceMeters']) || b.checkpointSha256 !== request.baselineCheckpointSha256 ||
        b.checkpointUnchanged !== true || b.subjectRigidTranslation !== true || b.supportUnchanged !== true ||
        !translation(b.translationMeters) || b.translationMeters.some((v, i) => v !== request.expectedTranslationMeters[i]) ||
        b.toleranceMeters !== SURFACE_PLACEMENT_LIMITS.toleranceMeters ||
        ![b.subjectMaxErrorMeters, b.supportMaxErrorMeters].every(v => Number.isFinite(v) && v >= 0 && v <= b.toleranceMeters)) refuse('candidate geometry does not verify the pinned baseline translation.')
  }
  return report
}
