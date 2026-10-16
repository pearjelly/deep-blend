/** Endpoint origins from verified native reports; these are not surface clearances. */
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

const refuse = message => { throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, `Native assembly origins: ${message}`) }
const finite = values => {
  if (!values.every(Number.isFinite)) refuse('the derived origin/span values exceed the finite numeric range.')
  return values
}
const subtract = (a, b) => finite(a.map((value, axis) => value - b[axis]))
const subtractMm = (a, b) => finite(subtract(a, b).map(value => value * 1000))
const identity = report => ({ projectId: report.projectId, revision: report.sourceRevision,
  checkpointSha256: report.sourceCheckpointSha256, frame: report.frame })
const limitations = [
  'Offsets join evaluated native OBJECT ORIGINS in world XYZ axes, not surface points. They are not protrusion, contact, seating depth or clearance.',
  'World-axis offsets and spans change under rotation; they are not intrinsic dimensions or anchor-local coordinates.',
  'Only the selected parts, ordered pairs and explicit frame are measured. Unavailable parts have no numeric values, never zero.',
  'No whole-assembly attachment, collision absence, minimum clearance, manufacturing tolerance or artistic approval is established.',
]

export function validateAssemblyPairs(pairs, entityIds) {
  if (!Array.isArray(entityIds) || !Array.isArray(pairs) || pairs.length < 1 || pairs.length > 8) refuse('select 1–8 explicit ordered pairs within geometryEntityIds.')
  const ids = new Set()
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) ||
        Object.keys(pair).some(key => !['pairId', 'entityId', 'anchorEntityId'].includes(key)) ||
        typeof pair.pairId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(pair.pairId) || ids.has(pair.pairId) ||
        !entityIds.includes(pair.entityId) || !entityIds.includes(pair.anchorEntityId) || pair.entityId === pair.anchorEntityId) {
      refuse('each pair requires a distinct pairId and two different selected entity/anchor IDs; arbitrary fields are refused.')
    }
    ids.add(pair.pairId)
  }
}

function origin(object) {
  const matrix = object.worldMatrix
  if (!Array.isArray(matrix) || matrix.length !== 4 || matrix.some(row => !Array.isArray(row) || row.length !== 4 || row.some(value => !Number.isFinite(value))) ||
      matrix[3].some((value, axis) => value !== (axis === 3 ? 1 : 0))) refuse('the native world matrix is not finite affine geometry.')
  return matrix.slice(0, 3).map(row => row[3])
}

export function readAssemblyOrigins(report, pairs) {
  validateAssemblyPairs(pairs, report.objects.map(object => object.entityId))
  const objects = new Map(report.objects.map(object => [object.entityId, object]))
  return { schemaVersion: 'deepblend.assembly-origins/v1', source: identity(report), coordinateSystem: 'world',
    pairs: pairs.map(pair => {
      const entity = objects.get(pair.entityId), anchor = objects.get(pair.anchorEntityId)
      if (!entity.available || !anchor.available) return { ...pair, status: 'unavailable',
        unavailableParts: [entity, anchor].filter(object => !object.available).map(object => ({ entityId: object.entityId, reason: object.unavailableReason })) }
      const entityOriginMeters = origin(entity), anchorOriginMeters = origin(anchor)
      return { ...pair, status: 'measured', entityOriginMeters, anchorOriginMeters,
        worldOriginOffsetMm: subtractMm(entityOriginMeters, anchorOriginMeters) }
    }), limitations }
}

export function compareAssemblyOrigins(before, after) {
  if (before.source.projectId !== after.source.projectId || before.source.frame !== after.source.frame || before.pairs.length !== after.pairs.length) refuse('comparison requires the same project, frame and ordered pairs.')
  const pairs = after.pairs.map((current, index) => {
    const reference = before.pairs[index]
    if (['pairId', 'entityId', 'anchorEntityId'].some(key => reference[key] !== current[key])) refuse('comparison pair identities differ.')
    return { pairId: current.pairId, entityId: current.entityId, anchorEntityId: current.anchorEntityId,
      before: reference, after: current,
      ...(reference.status === 'measured' && current.status === 'measured' ? { worldOriginOffsetChangeMm: subtract(current.worldOriginOffsetMm, reference.worldOriginOffsetMm) } : {}) }
  })
  return { schemaVersion: 'deepblend.assembly-origin-comparison/v1', referenceSource: before.source, currentSource: after.source,
    pairs, comparedPairs: pairs.filter(pair => pair.worldOriginOffsetChangeMm !== undefined).length,
    limitations: ['Object-local changes compare each object own scaled evaluated mesh axes. Changed local geometry orientation can change these spans. They are not world distances or semantic body dimensions.', 'Changes are current minus reference; offset preservation does not establish surface contact or attachment correctness.', ...limitations] }
}

/** Inputs have already passed source/selection/frame and native report verification. */
export function compareGeometryReports(reference, current) {
  if (reference.projectId !== current.projectId || reference.frame !== current.frame || reference.objects.length !== current.objects.length) refuse('comparison requires the same project, frame and ordered entities.')
  const objects = current.objects.map((after, index) => {
    const before = reference.objects[index]
    if (before.entityId !== after.entityId) refuse('comparison entity identities differ.')
    const values = object => object.available ? { status: 'measured', worldAxisExtentMm: object.worldAxisExtentMm, worldOriginMeters: origin(object),
      ...(object.objectAxisStatus ? { objectAxisStatus: object.objectAxisStatus } : {}),
      ...(object.objectAxisExtentMm ? { objectAxisExtentMm: object.objectAxisExtentMm } : {}) } :
      { status: 'unavailable', reason: object.unavailableReason }
    const row = { entityId: after.entityId, before: values(before), after: values(after) }
    if (before.available && after.available) {
      if (before.objectAxisExtentMm && after.objectAxisExtentMm) row.objectAxisExtentChangeMm = subtract(after.objectAxisExtentMm, before.objectAxisExtentMm)
      row.worldAxisExtentChangeMm = subtract(after.worldAxisExtentMm, before.worldAxisExtentMm)
      row.worldOriginChangeMm = subtractMm(row.after.worldOriginMeters, row.before.worldOriginMeters)
    }
    return row
  })
  return { schemaVersion: 'deepblend.geometry-comparison/v1', referenceInspection: reference, currentSource: identity(current), objects,
    summary: { requestedEntities: objects.length, comparedEntities: objects.filter(object => object.worldAxisExtentChangeMm !== undefined).length },
    limitations: ['Object-local changes compare each object own scaled evaluated mesh axes. Changed local geometry orientation can change these spans. They are not world distances or semantic body dimensions.', 'Changes are current minus reference for the same selected native parts and frame; their cause is not established.', ...limitations] }
}
