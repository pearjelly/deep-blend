import { BlenderError, BlenderErrorCode } from './index.js'

export const CAMERA_FIT_VERSION = 'deepblend.camera-fit/v1'
export const CAMERA_FIT_LIMITS = Object.freeze({ entities: 64, meshes: 128, vertices: 2_000_000,
  checkpointBytes: 1024 ** 3, reportBytes: 256 * 1024, toleranceMeters: .00002 })
const only = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k))
const vector = (v, n = 3) => Array.isArray(v) && v.length === n && v.every(Number.isFinite)
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const id = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(v)
const integer = (v, a, b) => Number.isSafeInteger(v) && v >= a && v <= b
const positive = v => Number.isFinite(v) && v > 0
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = (message, code = BlenderErrorCode.SCENE_VALIDATION_FAILED) => { throw new BlenderError(code, `Camera fit: ${message}`) }

export function validateCameraFitSelection(request) {
  const invalid = message => fail(message, BlenderErrorCode.SCENE_PATCH_INVALID)
  if (!Array.isArray(request?.entityIds) || !integer(request.entityIds.length, 1, CAMERA_FIT_LIMITS.entities) ||
      !request.entityIds.every(id) || new Set(request.entityIds).size !== request.entityIds.length) invalid('select 1–64 distinct mesh entities or complete asset instances.')
  if (!Array.isArray(request.assetInstanceIds) || request.assetInstanceIds.some(x => !request.entityIds.includes(x)) ||
      new Set(request.assetInstanceIds).size !== request.assetInstanceIds.length) invalid('assetInstanceIds must name distinct selected asset roots.')
  if (!id(request.cameraId) || !id(request.fittedCameraId) || request.cameraId === request.fittedCameraId) invalid('select a source camera and a distinct new camera ID.')
  if (!integer(request.frame, 0, 1_000_000) || !Number.isFinite(request.margin) || request.margin < 0 || request.margin > .25 || !hash(request.checkpointSha256)) invalid('an explicit frame, margin from 0 to 0.25 and pinned checkpoint are required.')
  const baseline = request.baselineCheckpointPath !== undefined || request.baselineCheckpointSha256 !== undefined
  if (baseline && (typeof request.baselineCheckpointPath !== 'string' || !request.baselineCheckpointPath || !hash(request.baselineCheckpointSha256))) invalid('candidate verification requires both the baseline checkpoint path and SHA256.')
}

function optics(v) {
  return positive(v.lens) && positive(v.sensorWidth) && positive(v.sensorHeight) &&
    ['AUTO', 'HORIZONTAL', 'VERTICAL'].includes(v.sensorFit) && vector(v.shift, 2) &&
    vector(v.clipping, 2) && v.clipping[0] > 0 && v.clipping[1] > v.clipping[0] &&
    (v.fStop === undefined || positive(v.fStop))
}
const opticalKeys = ['lens', 'sensorWidth', 'sensorHeight', 'sensorFit', 'shift', 'clipping', 'fStop']

export function verifyCameraFitReport(report, request) {
  validateCameraFitSelection(request)
  const candidate = request.baselineCheckpointPath !== undefined
  if (!only(report, ['schemaVersion', 'entityIds', 'assetInstanceIds', 'frame', 'cameraId', 'fittedCameraId', 'margin',
    'checkpointSha256', 'checkpointUnchanged', 'blenderVersion', 'members', 'view', 'camera', candidate ? 'baselineVerification' : 'proposal']) ||
      Buffer.byteLength(JSON.stringify(report)) > CAMERA_FIT_LIMITS.reportBytes || report.schemaVersion !== CAMERA_FIT_VERSION ||
      !same(report.entityIds, request.entityIds) || !same(report.assetInstanceIds, request.assetInstanceIds) ||
      report.frame !== request.frame || report.cameraId !== request.cameraId || report.fittedCameraId !== request.fittedCameraId ||
      report.margin !== request.margin || report.checkpointSha256 !== request.checkpointSha256 || report.checkpointUnchanged !== true ||
      typeof report.blenderVersion !== 'string' || !report.blenderVersion || !Array.isArray(report.members) || report.members.length !== request.entityIds.length) fail('the native report differs from the selected frame, source or complete selection.')
  const view = report.view, camera = report.camera
  if (!only(view, ['resolution', 'percentage', 'pixelAspect', 'activeCamera']) ||
      !(view.activeCamera === null || typeof view.activeCamera === 'string') || !vector(view.resolution, 2) ||
      !view.resolution.every(x => integer(x, 1, 16384)) || !integer(view.percentage, 1, 100) ||
      !vector(view.pixelAspect, 2) || !view.pixelAspect.every(positive) ||
      !only(camera, ['id', ...opticalKeys, 'matrixWorld', 'focusDistance', 'focusObject']) ||
      camera.id !== (candidate ? request.fittedCameraId : request.cameraId) || !optics(camera) || !positive(camera.focusDistance) ||
      !(camera.focusObject === null || typeof camera.focusObject === 'string') ||
      !Array.isArray(camera.matrixWorld) || camera.matrixWorld.length !== 4 || !camera.matrixWorld.every(row => vector(row, 4)) ||
      !same(camera.matrixWorld[3], [0, 0, 0, 1])) fail('missing or inconsistent native camera calibration.')
  let vertices = 0, meshes = 0
  for (const [i, member] of report.members.entries()) {
    if (!only(member, ['entityId', 'meshObjectCount', 'vertexCount', 'worldBoundsMeters', 'geometrySha256', 'projection']) ||
        member.entityId !== request.entityIds[i] || !integer(member.meshObjectCount, 1, CAMERA_FIT_LIMITS.meshes) ||
        !integer(member.vertexCount, 1, CAMERA_FIT_LIMITS.vertices) || !hash(member.geometrySha256) ||
        !only(member.worldBoundsMeters, ['min', 'max']) || !vector(member.worldBoundsMeters.min) || !vector(member.worldBoundsMeters.max) ||
        [...member.worldBoundsMeters.min, ...member.worldBoundsMeters.max].some(x => Math.abs(x) > 1e6) ||
        member.worldBoundsMeters.min.some((x, axis) => x > member.worldBoundsMeters.max[axis])) fail('invalid native member identity, counts or bounds.')
    vertices += member.vertexCount; meshes += member.meshObjectCount
    const p = member.projection
    if (!only(p, ['containedInClip', 'nearestDepthMeters', 'farthestDepthMeters', 'containedInFrame', 'normalizedBounds']) ||
        !Number.isFinite(p.nearestDepthMeters) || !Number.isFinite(p.farthestDepthMeters) || p.nearestDepthMeters > p.farthestDepthMeters ||
        p.containedInClip !== (p.nearestDepthMeters >= camera.clipping[0] && p.farthestDepthMeters <= camera.clipping[1]) ||
        typeof p.containedInFrame !== 'boolean') fail('invalid independent vertex projection.')
    if (p.nearestDepthMeters > 1e-8) {
      const b = p.normalizedBounds
      if (!only(b, ['min', 'max']) || !vector(b.min, 2) || !vector(b.max, 2) || b.min.some((x, axis) => x > b.max[axis]) ||
          p.containedInFrame !== b.min.every((x, axis) => x >= request.margin && b.max[axis] <= 1-request.margin)) fail('projection bounds do not establish the claimed margin.')
    } else if (p.normalizedBounds !== undefined || p.containedInFrame !== false) fail('vertices behind the camera cannot establish framing.')
    if (candidate && (!p.containedInFrame || !p.containedInClip)) fail('the compiled candidate does not contain every selected member.')
  }
  if (vertices > CAMERA_FIT_LIMITS.vertices || meshes > CAMERA_FIT_LIMITS.meshes) fail('the aggregate selection exceeds the native geometry budget.')
  if (candidate) {
    const b = report.baselineVerification
    if (!only(b, ['checkpointSha256', 'checkpointUnchanged', 'selectedGeometryUnchanged', 'originalObjectsUnchanged',
      'opticsAndRotationPreserved', 'maxVertexErrorMeters', 'toleranceMeters', 'originalObjectCount']) ||
        b.checkpointSha256 !== request.baselineCheckpointSha256 || b.checkpointUnchanged !== true ||
        b.selectedGeometryUnchanged !== true || b.originalObjectsUnchanged !== true || b.opticsAndRotationPreserved !== true ||
        b.toleranceMeters !== CAMERA_FIT_LIMITS.toleranceMeters || !Number.isFinite(b.maxVertexErrorMeters) ||
        b.maxVertexErrorMeters < 0 || b.maxVertexErrorMeters > b.toleranceMeters || !integer(b.originalObjectCount, 1, 100_000)) fail('the candidate does not verify its pinned native baseline.')
  } else {
    const p = report.proposal
    if (!only(p, ['id', 'role', ...opticalKeys, 'transform', 'focusDistance']) || p.id !== request.fittedCameraId || p.role !== 'detail' ||
        !optics(p) || opticalKeys.some(k => !same(p[k], camera[k])) ||
        !only(p.transform, ['location', 'rotationEuler', 'scale']) || !vector(p.transform.location) ||
        !vector(p.transform.rotationEuler) || !same(p.transform.scale, [1, 1, 1]) ||
        (p.fStop === undefined ? p.focusDistance !== undefined : !positive(p.focusDistance))) fail('the proposed static camera does not preserve the measured optics.')
  }
  return report
}
