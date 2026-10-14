import { BlenderError, BlenderErrorCode } from './index.js'

export const GEOMETRY_INSPECTION_VERSION = 'deepblend.geometry-inspection/v1'
export const SURFACE_INSPECTION_VERSION = 'deepblend.geometry-inspection/v2'
export const GEOMETRY_INSPECTION_LIMITS = Object.freeze({ entities: 8, checkpointBytes: 1024 ** 3, reportBytes: 64 * 1024 })
export const SURFACE_INSPECTION_LIMITS = Object.freeze({ samples: 8, vertices: 250_000, polygons: 250_000,
  searchDistanceMm: 500, chordDistanceMm: 100, separationDistanceMm: 100, epsilonMm: .0001 })

function refuse(message) {
  throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, `Geometry inspection: ${message}`)
}

export function validateGeometrySelection(request) {
  if (!Array.isArray(request?.entityIds) || request.entityIds.length < 1 || request.entityIds.length > GEOMETRY_INSPECTION_LIMITS.entities ||
      request.entityIds.some(id => typeof id !== 'string' || !id || id.trim() !== id || id.length > 128 || id.includes('\0')) ||
      new Set(request.entityIds).size !== request.entityIds.length) refuse('select 1–8 distinct non-empty entity IDs.')
  if (!Number.isSafeInteger(request.frame) || request.frame < 0 || request.frame > 1_000_000) refuse('an explicit integer frame from 0 to 1000000 is required.')
  if (typeof request.checkpointSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.checkpointSha256)) refuse('the expected checkpoint SHA256 is required.')
  if (request.surfaceSamples !== undefined) validateSurfaceSelection(request)
}

const vector3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
const length = v => Math.hypot(...v)
const subtract = (a, b) => a.map((v, i) => v - b[i])
const near = (a, b, tolerance = 1e-6) => length(subtract(a, b)) <= tolerance
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k))
const unit = v => v.map(x => x / length(v))
const unavailable = ['not-mesh', 'viewport-disabled', 'empty-or-invalid-geometry', 'geometry-budget-exceeded', 'unsupported-topology-or-winding']
const sourceFailures = [...unavailable, 'no-entry', 'entry-not-inward', 'no-opposite-surface', 'exit-not-outward', 'below-resolution']
const targetFailures = [...unavailable, 'no-target-entry', 'target-not-inward', 'source-surface-before-target', 'below-resolution']

export function validateSurfaceSelection(request) {
  const samples = request?.surfaceSamples
  if (!Array.isArray(request?.entityIds)) refuse('surface samples require an explicit entity selection.')
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > SURFACE_INSPECTION_LIMITS.samples ||
      new Set(samples.map(s => s?.sampleId)).size !== samples.length) refuse('select 1–8 distinct surface samples.')
  for (const sample of samples) {
    if (!only(sample, ['sampleId', 'entityId', 'targetEntityId', 'originMeters', 'direction', 'searchDistanceMm']) ||
        typeof sample.sampleId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(sample.sampleId) ||
        !request.entityIds.includes(sample.entityId) ||
        (sample.targetEntityId !== undefined && (!request.entityIds.includes(sample.targetEntityId) || sample.targetEntityId === sample.entityId)) ||
        !vector3(sample.originMeters) || sample.originMeters.some(x => Math.abs(x) > 1000) ||
        !vector3(sample.direction) || length(sample.direction) < 1e-12 || length(sample.direction) > 1e6 ||
        !Number.isFinite(sample.searchDistanceMm) || sample.searchDistanceMm < .01 || sample.searchDistanceMm > SURFACE_INSPECTION_LIMITS.searchDistanceMm) {
      refuse('surface samples require selected source/target IDs, finite world seeds/directions and explicit searchDistanceMm from 0.01 to 500; arbitrary fields are refused.')
    }
  }
}

export function verifySurfaceSamples(samples, request, objects) {
  validateSurfaceSelection(request)
  if (!Array.isArray(samples) || samples.length !== request.surfaceSamples.length) refuse('surface sample count differs from the request.')
  const point = v => vector3(v) && v.every(x => Math.abs(x) <= 1001)
  const distance = (a, b, measured, maximum) => Number.isFinite(measured) && measured > 2 * SURFACE_INSPECTION_LIMITS.epsilonMm &&
    measured <= maximum + .001 && Math.abs(length(subtract(a, b)) * 1000 - measured) <= .001
  const along = (a, b, direction, maximum) => {
    const delta = subtract(b, a), projection = delta.reduce((sum, v, i) => sum + v * direction[i], 0)
    return projection >= -1e-6 && projection <= maximum / 1000 + 1e-6 && near(delta, direction.map(x => x * projection))
  }
  for (const [i, result] of samples.entries()) {
    const q = request.surfaceSamples[i]
    if (!result || result.sampleId !== q.sampleId || result.entityId !== q.entityId || result.targetEntityId !== q.targetEntityId ||
        !vector3(result.originMeters) || !near(result.originMeters, q.originMeters, 0) || !vector3(result.direction) ||
        !near(result.direction, unit(q.direction), 1e-6) || result.searchDistanceMm !== q.searchDistanceMm) refuse('surface identity, seed or search distance differs from the request.')
    const base = ['sampleId', 'entityId', 'targetEntityId', 'originMeters', 'direction', 'searchDistanceMm', 'status']
    if (result.status !== 'sampled') {
      const object = objects.find(o => o.entityId === q.entityId)
      if (!sourceFailures.includes(result.status) || !only(result, base) ||
          (object?.available === false && result.status !== object.unavailableReason)) refuse('unavailable surface samples must not contain measurements or contradict object availability.')
      continue
    }
    if (!only(result, [...base, 'entryMeters', 'exitMeters', 'inwardUnitNormal', 'normalSurfaceChordMm', 'gap']) ||
        !point(result.entryMeters) || !point(result.exitMeters) || !vector3(result.inwardUnitNormal) ||
        Math.abs(length(result.inwardUnitNormal) - 1) > 1e-6 ||
        result.inwardUnitNormal.reduce((sum, v, axis) => sum + v * result.direction[axis], 0) <= 1e-6 ||
        !along(q.originMeters, result.entryMeters, result.direction, q.searchDistanceMm) ||
        !along(result.entryMeters, result.exitMeters, result.inwardUnitNormal, SURFACE_INSPECTION_LIMITS.chordDistanceMm) ||
        !distance(result.entryMeters, result.exitMeters, result.normalSurfaceChordMm, SURFACE_INSPECTION_LIMITS.chordDistanceMm) ||
        objects.find(o => o.entityId === q.entityId)?.available !== true) refuse('surface points, normal, distance or source availability disagree.')
    if (q.targetEntityId === undefined) {
      if (Object.hasOwn(result, 'gap')) refuse('an unrequested target separation is not accepted.')
    } else {
      const gap = result.gap
      if (gap?.status === 'sampled') {
        if (!only(gap, ['status', 'targetEntryMeters', 'normalRaySeparationMm']) || !point(gap.targetEntryMeters) ||
            !along(result.exitMeters, gap.targetEntryMeters, result.inwardUnitNormal, SURFACE_INSPECTION_LIMITS.separationDistanceMm) ||
            !distance(result.exitMeters, gap.targetEntryMeters, gap.normalRaySeparationMm, SURFACE_INSPECTION_LIMITS.separationDistanceMm) ||
            objects.find(o => o.entityId === q.targetEntityId)?.available !== true) refuse('target surface points or distance disagree.')
      } else if (!only(gap, ['status']) || !targetFailures.includes(gap.status) ||
        (objects.find(o => o.entityId === q.targetEntityId)?.available === false && gap.status !== objects.find(o => o.entityId === q.targetEntityId).unavailableReason)) refuse('unavailable target separations must not contain measurements or contradict object availability.')
    }
  }
  return samples
}

/** Verify measured values rather than trusting a successful process exit. */
export function verifyGeometryReport(report, request) {
  validateGeometrySelection(request)
  const allowed = (value, keys) => value && typeof value === 'object' && Object.keys(value).every(key => keys.includes(key))
  if (!report || Buffer.byteLength(JSON.stringify(report)) > GEOMETRY_INSPECTION_LIMITS.reportBytes ||
      report.schemaVersion !== (request.surfaceSamples === undefined ? GEOMETRY_INSPECTION_VERSION : SURFACE_INSPECTION_VERSION) || report.checkpointSha256 !== request.checkpointSha256 ||
      report.frame !== request.frame || report.checkpointUnchanged !== true ||
      typeof report.blenderVersion !== 'string' || !report.blenderVersion ||
      !Array.isArray(report.objects) || report.objects.length !== request.entityIds.length ||
      !allowed(report, ['schemaVersion', 'checkpointSha256', 'checkpointUnchanged', 'frame', 'blenderVersion', 'objects', ...(request.surfaceSamples === undefined ? [] : ['surfaceSamples'])])) refuse('the report does not match the requested source, frame or selection.')
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
  if (request.surfaceSamples !== undefined) verifySurfaceSamples(report.surfaceSamples, request, report.objects)
  return report
}
