/** One complete pinned lamp, with a relative world pose followed by measured settling. */
import { BlenderError, BlenderErrorCode } from './index.js'
import { LAMP_ASSEMBLY_MANIFEST_SHA256 } from './lamp-placement.js'
import { instantiateRecipeLock } from './recipe.js'
import { planRecipeGeometryEdit } from './recipe-parameters.js'
import { canonicalStringify } from './canonical.js'
import { SURFACE_PLACEMENT_LIMITS, validateSurfacePlacementSelection,
  verifySurfacePlacementReport, verifyPlacementObject } from './surface-placement.js'

export const ASSEMBLY_PLACEMENT_VERSION = 'deepblend.assembly-placement/v1'
export const ASSEMBLY_PLACEMENT_BASIS_TOLERANCE = 1e-6
export const ASSEMBLY_PLACEMENT_UV_TOLERANCE = 1e-6
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key))
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value)
const refuse = (message, code = BlenderErrorCode.SCENE_PATCH_INVALID) => { throw new BlenderError(code, `Assembly placement: ${message}`) }
const near = (a, b, tolerance = 1e-9) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((value, index) => near(value, b[index], tolerance))
  : Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance

/** Millimetres, relative world translation, relative upright yaw, then world-Z settling. */
export function normalizeAssemblyPose(input = {}, defaultPivotMm = [0, 0, 0]) {
  if (!only(input, ['translationMm', 'yawDegrees', 'pivotMm'])) refuse('pose accepts translationMm, yawDegrees and pivotMm only.')
  const pose = { translationMm: input.translationMm === undefined ? [0, 0, 0] : input.translationMm,
    yawDegrees: input.yawDegrees === undefined ? 0 : input.yawDegrees,
    pivotMm: input.pivotMm === undefined ? defaultPivotMm : input.pivotMm }
  if (![pose.translationMm, pose.pivotMm].every(value => vector(value) && value.every(axis => Math.abs(axis) <= 1_000_000))
      || !Number.isFinite(pose.yawDegrees) || Math.abs(pose.yawDegrees) > 360) {
    refuse('pose requires finite 3-vectors within ±1000000 mm and a relative yaw within ±360 degrees.')
  }
  return structuredClone(pose)
}

export function assemblyPoseMatrixMeters(pose) {
  const { translationMm, yawDegrees, pivotMm } = normalizeAssemblyPose(pose)
  const angle = yawDegrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
  const [x, y] = pivotMm.map(value => value / 1000), [dx, dy, dz] = translationMm.map(value => value / 1000)
  return [[c, -s, 0, x - c * x + s * y + dx], [s, c, 0, y - s * x - c * y + dy],
    [0, 0, 1, dz], [0, 0, 0, 1]]
}

function uprightMatrix(matrix) {
  return Array.isArray(matrix) && matrix.length === 4 && matrix.every(row => Array.isArray(row) && row.length === 4
    && row.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6))
    && near(matrix[3], [0, 0, 0, 1]) && near(matrix[2].slice(0, 3), [0, 0, 1])
    && near([matrix[0][2], matrix[1][2]], [0, 0])
    && near(matrix[0][0], matrix[1][1]) && near(matrix[0][1], -matrix[1][0])
    && near(matrix[0][0] ** 2 + matrix[1][0] ** 2, 1)
}

export function planLampAssemblyPlacement(lock, currentSpec, parameterState, inputPose = {}) {
  if (lock?.manifestSha256 !== LAMP_ASSEMBLY_MANIFEST_SHA256) {
    refuse('whole-recipe placement requires the saved metal-lamp 2.2.0 origin.', BlenderErrorCode.UNSUPPORTED_ACTION)
  }
  // Also validates every member's complete static rigid pose and all controlled geometry,
  // including unchanged/no-op requests. It never overwrites an independent edit.
  planRecipeGeometryEdit(lock, currentSpec, parameterState, {})
  const origin = instantiateRecipeLock(lock), memberEntityIds = origin.spec.entities
    .filter(entity => entity.id !== 'studio-floor').map(entity => entity.id).sort()
  if (memberEntityIds.length !== 23 || new Set(memberEntityIds).size !== 23) {
    refuse('the pinned origin does not define exactly23 product members.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
  }
  const selected = new Set(memberEntityIds), anchor = currentSpec.entities.find(entity => entity.id === 'weighted-base')
  for (const entity of currentSpec.entities) {
    if ((entity.modifiers ?? []).some(modifier => selected.has(modifier.targetEntityId)
        || modifier.targetEntityIds?.some(value => selected.has(value)))) {
      refuse(`moving the lamp would affect a cross-entity geometry dependency on ${entity.id}.`, BlenderErrorCode.UNSUPPORTED_ACTION)
    }
  }
  if ((currentSpec.animationTracks ?? []).some(track => (track.targetKind ?? 'entity') === 'entity' && selected.has(track.targetEntityId))) {
    refuse('all lamp members must be static at the selected frame.', BlenderErrorCode.UNSUPPORTED_ACTION)
  }
  const pose = normalizeAssemblyPose(inputPose, (anchor.transform?.location ?? [0, 0, 0]).map(value => value * 1000))
  const poseMatrixMeters = assemblyPoseMatrixMeters(pose)
  const operations = memberEntityIds.map(entityId => {
    const entity = currentSpec.entities.find(value => value.id === entityId), p = entity.transform?.location ?? [0, 0, 0]
    const angles = entity.transform?.rotationEuler ?? [0, 0, 0]
    return { op: 'entity.transform.update', entityId,
      location: poseMatrixMeters.slice(0, 3).map(row => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]),
      rotationEuler: [angles[0], angles[1], angles[2] + pose.yawDegrees * Math.PI / 180] }
  })
  return { subjectEntityId: anchor.id, memberEntityIds, pose, poseMatrixMeters, operations }
}

export function validateAssemblyPlacementSelection(request) {
  validateSurfacePlacementSelection({ subjectEntityId: request?.subjectEntityId, supportEntityId: request?.supportEntityId,
    frame: request?.frame, clearanceMm: request?.clearanceMm, checkpointSha256: request?.checkpointSha256 })
  const ids = request.memberEntityIds
  if (!Array.isArray(ids) || !ids.length || ids.length > SURFACE_PLACEMENT_LIMITS.meshes
      || !ids.every(id) || new Set(ids).size !== ids.length || !ids.includes(request.subjectEntityId)
      || ids.includes(request.supportEntityId) || canonicalStringify(ids) !== canonicalStringify([...ids].sort())) {
    refuse('select the complete, sorted, distinct subject members, excluding the support.')
  }
  const pose = normalizeAssemblyPose(request.pose)
  if (canonicalStringify(pose) !== canonicalStringify(request.pose)) refuse('native measurement needs a fully resolved pose and pivot.')
  const fields = ['baselineCheckpointPath', 'baselineCheckpointSha256', 'expectedWorldMatrixMeters']
  if (fields.some(key => request[key] !== undefined) && (!fields.every(key => request[key] !== undefined)
      || typeof request.baselineCheckpointPath !== 'string' || !request.baselineCheckpointPath
      || !/^[a-f0-9]{64}$/.test(request.baselineCheckpointSha256 ?? '') || !uprightMatrix(request.expectedWorldMatrixMeters))) {
    refuse('candidate verification requires its exact baseline and one rigid upright world matrix.')
  }
}

/** Validate a native union-of-meshes witness and a proof for every saved member. */
export function verifyAssemblyPlacementReport(report, request) {
  validateAssemblyPlacementSelection(request)
  const fail = message => refuse(message, BlenderErrorCode.SCENE_VALIDATION_FAILED)
  const keys = ['schemaVersion', 'axis', 'checkpointSha256', 'checkpointUnchanged', 'frame', 'blenderVersion',
    'subjectEntityId', 'supportEntityId', 'clearanceMm', 'translationMeters', 'subjectContactMeters', 'supportContactMeters',
    'placedSubjectContactMeters', 'subjectTriangleIndex', 'supportTriangleIndex', 'statistics', 'subject', 'support',
    'memberEntityIds', 'members', 'pose', 'poseMatrixMeters', 'resultWorldMatrixMeters', 'subjectContactEntityId',
    ...(request.baselineCheckpointPath === undefined ? [] : ['baselineVerification'])]
  if (!only(report, keys) || report.schemaVersion !== ASSEMBLY_PLACEMENT_VERSION
      || Buffer.byteLength(JSON.stringify(report)) > 256 * 1024
      || canonicalStringify(report.memberEntityIds) !== canonicalStringify(request.memberEntityIds)
      || canonicalStringify(report.pose) !== canonicalStringify(request.pose)
      || !near(report.poseMatrixMeters, assemblyPoseMatrixMeters(request.pose), 1e-12)) fail('the native report does not bind the complete requested assembly and pose.')
  // Keep the existing contact, source, finite geometry and vertical gap checks.
  const pairKeys = keys.filter(key => !['members', 'memberEntityIds', 'pose', 'poseMatrixMeters', 'resultWorldMatrixMeters',
    'subjectContactEntityId', 'baselineVerification'].includes(key))
  const pair = Object.fromEntries(pairKeys.map(key => [key, report[key]]))
  pair.schemaVersion = 'deepblend.surface-placement/v1'
  verifySurfacePlacementReport(pair, { subjectEntityId: request.subjectEntityId, supportEntityId: request.supportEntityId,
    checkpointSha256: request.checkpointSha256, frame: request.frame, clearanceMm: request.clearanceMm })
  const expectedResult = assemblyPoseMatrixMeters(request.pose); expectedResult[2][3] += report.translationMeters[2]
  if (!uprightMatrix(report.resultWorldMatrixMeters) || !near(report.resultWorldMatrixMeters, expectedResult, 1e-12)
      || !Array.isArray(report.members) || report.members.length !== request.memberEntityIds.length) fail('invalid complete result transform or member set.')
  const totals = { meshObjectCount: 0, vertexCount: 0, triangleCount: 0 }, low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity]
  let triangleOffset = 0, contactMember = null
  for (const [index, member] of report.members.entries()) {
    if (!only(member, ['entityId', 'geometry']) || member.entityId !== request.memberEntityIds[index]) fail('native member identity/order differs from the pinned selection.')
    verifyPlacementObject(member.geometry)
    for (const key of Object.keys(totals)) totals[key] += member.geometry[key]
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], member.geometry.worldBoundsMeters.min[axis])
      high[axis] = Math.max(high[axis], member.geometry.worldBoundsMeters.max[axis])
    }
    if (report.subjectTriangleIndex >= triangleOffset && report.subjectTriangleIndex < triangleOffset + member.geometry.triangleCount) contactMember = member.entityId
    triangleOffset += member.geometry.triangleCount
  }
  const anchor = report.members.find(member => member.entityId === request.subjectEntityId)
  if (Object.keys(totals).some(key => report.subject[key] !== totals[key])
      || !near(report.subject.worldBoundsMeters.min, low) || !near(report.subject.worldBoundsMeters.max, high)
      || !near(report.subject.rootWorldMatrix, anchor.geometry.rootWorldMatrix)
      || report.subjectContactEntityId !== contactMember) fail('aggregate geometry omits or misidentifies a selected native member.')
  if (request.baselineCheckpointPath !== undefined) {
    const proof = report.baselineVerification
    if (!only(proof, ['checkpointSha256', 'checkpointUnchanged', 'worldMatrixMeters', 'members', 'supportUnchanged',
      'supportMaxErrorMeters', 'toleranceMeters', 'basisTolerance', 'uvTolerance']) || proof.checkpointSha256 !== request.baselineCheckpointSha256
        || proof.checkpointUnchanged !== true || proof.supportUnchanged !== true
        || !near(proof.worldMatrixMeters, request.expectedWorldMatrixMeters, 1e-12)
        || proof.toleranceMeters !== SURFACE_PLACEMENT_LIMITS.toleranceMeters || proof.basisTolerance !== ASSEMBLY_PLACEMENT_BASIS_TOLERANCE
        || proof.uvTolerance !== ASSEMBLY_PLACEMENT_UV_TOLERANCE
        || !Number.isFinite(proof.supportMaxErrorMeters) || proof.supportMaxErrorMeters < 0 || proof.supportMaxErrorMeters > proof.toleranceMeters
        || !Array.isArray(proof.members) || proof.members.length !== request.memberEntityIds.length) fail('missing or invalid complete baseline verification.')
    for (const [index, member] of proof.members.entries()) {
      if (!only(member, ['entityId', 'rigidTransform', 'maxVertexErrorMeters', 'maxRootPositionErrorMeters', 'maxRootBasisError', 'maxUvError'])
          || member.entityId !== request.memberEntityIds[index] || member.rigidTransform !== true
          || ![member.maxVertexErrorMeters, member.maxRootPositionErrorMeters].every(value => Number.isFinite(value) && value >= 0 && value <= proof.toleranceMeters)
          || !Number.isFinite(member.maxRootBasisError) || member.maxRootBasisError < 0 || member.maxRootBasisError > proof.basisTolerance
          || !Number.isFinite(member.maxUvError) || member.maxUvError < 0 || member.maxUvError > proof.uvTolerance) fail('one or more native members did not follow the complete rigid transform.')
    }
  }
  return report
}
