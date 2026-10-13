import { BlenderError, BlenderErrorCode } from './index.js'

export const GEOMETRY_INSPECTION_VERSION = 'deepblend.geometry-inspection/v1'
export const GEOMETRY_INSPECTION_LIMITS = Object.freeze({ entities: 8, checkpointBytes: 1024 ** 3, reportBytes: 64 * 1024 })

function refuse(message) {
  throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, `Geometry inspection: ${message}`)
}

export function validateGeometrySelection(request) {
  if (!Array.isArray(request?.entityIds) || request.entityIds.length < 1 || request.entityIds.length > GEOMETRY_INSPECTION_LIMITS.entities ||
      request.entityIds.some(id => typeof id !== 'string' || !id || id.trim() !== id || id.length > 128 || id.includes('\0')) ||
      new Set(request.entityIds).size !== request.entityIds.length) refuse('select 1–8 distinct non-empty entity IDs.')
  if (!Number.isSafeInteger(request.frame) || request.frame < 0 || request.frame > 1_000_000) refuse('an explicit integer frame from 0 to 1000000 is required.')
  if (typeof request.checkpointSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.checkpointSha256)) refuse('the expected checkpoint SHA256 is required.')
}

/** Verify measured values rather than trusting a successful process exit. */
export function verifyGeometryReport(report, request) {
  validateGeometrySelection(request)
  const allowed = (value, keys) => value && typeof value === 'object' && Object.keys(value).every(key => keys.includes(key))
  if (!report || Buffer.byteLength(JSON.stringify(report)) > GEOMETRY_INSPECTION_LIMITS.reportBytes ||
      report.schemaVersion !== GEOMETRY_INSPECTION_VERSION || report.checkpointSha256 !== request.checkpointSha256 ||
      report.frame !== request.frame || report.checkpointUnchanged !== true ||
      typeof report.blenderVersion !== 'string' || !report.blenderVersion ||
      !Array.isArray(report.objects) || report.objects.length !== request.entityIds.length ||
      !allowed(report, ['schemaVersion', 'checkpointSha256', 'checkpointUnchanged', 'frame', 'blenderVersion', 'objects'])) refuse('the report does not match the requested source, frame or selection.')
  const vector = (v, length) => Array.isArray(v) && v.length === length && v.every(Number.isFinite)
  for (const [index, object] of report.objects.entries()) {
    if (object?.entityId !== request.entityIds[index] || typeof object.type !== 'string' || !object.type) refuse('object identity differs from the selection.')
    const keys = object.available === false ? ['entityId', 'type', 'available', 'unavailableReason'] :
      ['entityId', 'type', 'available', 'worldBoundsMeters', 'worldAxisExtentMm', 'worldMatrix', 'scale', 'vertexCount', 'polygonCount']
    if (!allowed(object, keys)) refuse('unsupported measurement fields are not accepted; this protocol does not establish wall thickness or clearance.')
    if (object.available === false) {
      if (!['viewport-disabled', 'not-mesh', 'empty-or-invalid-geometry'].includes(object.unavailableReason) ||
          ['worldBoundsMeters', 'worldAxisExtentMm', 'worldMatrix', 'vertexCount', 'polygonCount', 'scale'].some(k => Object.hasOwn(object, k))) refuse('an unavailable object must not contain measurements.')
      continue
    }
    if (object.available !== true || object.type !== 'MESH' || !allowed(object.worldBoundsMeters, ['min', 'max']) || !vector(object.worldBoundsMeters?.min, 3) ||
        !vector(object.worldBoundsMeters?.max, 3) || !vector(object.worldAxisExtentMm, 3) || !vector(object.scale, 3) ||
        !Array.isArray(object.worldMatrix) || object.worldMatrix.length !== 4 || !object.worldMatrix.every(row => vector(row, 4)) ||
        !Number.isSafeInteger(object.vertexCount) || object.vertexCount <= 0 ||
        !Number.isSafeInteger(object.polygonCount) || object.polygonCount < 0) refuse('a measured object contains invalid or non-finite geometry facts.')
    for (let axis = 0; axis < 3; axis++) {
      const extent = (object.worldBoundsMeters.max[axis] - object.worldBoundsMeters.min[axis]) * 1000
      if (extent < 0 || Math.abs(extent - object.worldAxisExtentMm[axis]) > Math.max(1e-6, Math.abs(extent) * 1e-9)) refuse('axis extents disagree with the measured world bounds.')
    }
  }
  return report
}
