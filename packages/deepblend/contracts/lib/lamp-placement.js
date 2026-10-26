/** Continue the complete pinned 2.2 lamp after a static translation and upright yaw. */
import { RecipeError } from './recipe.js'

export const LAMP_ASSEMBLY_MANIFEST_SHA256 = '0d59d5340acc9334fbc9787a51fe1dc66fae39631534d581281770013e59c0b5'
const near = (a, b) => Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((value, index) => near(value, b[index]))
  : Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9
// SceneSpec uses XYZ Euler radians, so the object matrix is Rz * Ry * Rx.
const rotation = ([x, y, z]) => {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  return [[cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx], [sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx], [-sy, cy*sx, cy*cx]]
}
const transpose = matrix => matrix[0].map((_, axis) => matrix.map(row => row[axis]))
const multiply = (matrix, point) => matrix.map(row => row.reduce((sum, value, axis) => sum + value*point[axis], 0))
const product = (a, b) => a.map(row => transpose(b).map(column => row.reduce((sum, value, axis) => sum + value*column[axis], 0)))
const transform = entity => ({ location: entity.transform?.location ?? [0, 0, 0],
  rotationEuler: entity.transform?.rotationEuler ?? [0, 0, 0], scale: entity.transform?.scale ?? [1, 1, 1] })
const refuse = conflicts => {
  throw new RecipeError('RECIPE_PARAMETER_CONFLICT',
    'Lamp parts must retain one complete, upright, unscaled static placement before resizing', { conflicts })
}

export function placedLampAssembly(lock, current, before, after) {
  if (lock.manifestSha256 !== LAMP_ASSEMBLY_MANIFEST_SHA256) return { before, after }
  current = structuredClone(current)
  const parts = before.spec.entities.filter(entity => entity.id !== 'studio-floor')
  const actualParts = new Map(current.entities.map(entity => [entity.id, entity]))
  // Valid SceneSpecs may omit transform defaults; saved Host revisions include them.
  // Give the existing binding checks the same values we validate without mutating input.
  for (const original of parts) {
    const actual = actualParts.get(original.id)
    if (actual) actual.transform = structuredClone(transform(actual))
  }
  const anchor = parts.find(entity => entity.id === 'weighted-base'), actualAnchor = actualParts.get(anchor.id)
  if (!actualAnchor) refuse([{ entityId: anchor.id, property: 'entity', expected: 'present', actual: 'missing' }])
  const origin = transform(anchor), saved = transform(actualAnchor)
  const matrix = product(rotation(saved.rotationEuler), transpose(rotation(origin.rotationEuler)))
  // A product of rotation matrices is proper. Its Z basis must remain upright.
  if (!near(multiply(matrix, [0, 0, 1]), [0, 0, 1])) {
    refuse([{ entityId: anchor.id, property: 'upright-placement', expected: [0, 0, 1], actual: multiply(matrix, [0, 0, 1]) }])
  }
  // The fixed base absorbs any original rotation pivot as well as XYZ translation.
  const point = location => multiply(matrix, location.map((value, axis) => value - origin.location[axis]))
    .map((value, axis) => value + saved.location[axis])
  const conflicts = []
  for (const original of parts) {
    const actual = actualParts.get(original.id)
    const conflict = (property, expected, value) => conflicts.push({ entityId: original.id, property, expected, actual: value })
    if (!actual) { conflict('entity', 'present', 'missing'); continue }
    if (actual.type !== original.type) conflict('type', original.type, actual.type)
    if (actual.generator?.shape !== original.generator?.shape) conflict('shape', original.generator?.shape, actual.generator?.shape)
    const expected = transform(original), placed = transform(actual)
    if (!near(placed.location, point(expected.location))) conflict('location', point(expected.location), placed.location)
    const expectedRotation = product(matrix, rotation(expected.rotationEuler)), actualRotation = rotation(placed.rotationEuler)
    if (!near(actualRotation, expectedRotation)) conflict('rotation', expectedRotation, actualRotation)
    if (!near(placed.scale, [1, 1, 1])) conflict('scale', [1, 1, 1], placed.scale)
    for (const field of ['armatureId', 'rigidBody', 'cloth', 'softBody', 'fluid']) {
      if (actual[field] !== undefined) conflict(field, 'absent on static lamp parts', actual[field])
    }
  }
  const memberIds = new Set(parts.map(entity => entity.id))
  for (const track of current.animationTracks ?? []) {
    if ((track.targetKind ?? 'entity') === 'entity' && memberIds.has(track.targetEntityId)
        && /^(location|rotationEuler|scale)\.[xyz]$/.test(track.property)) {
      conflicts.push({ entityId: track.targetEntityId, property: 'animated-placement',
        expected: 'static transform', actual: { trackId: track.id, property: track.property } })
    }
  }
  // Known source + invalid assembly must refuse, including unbound parts and no-op requests.
  if (conflicts.length) refuse(conflicts)
  const posedBefore = structuredClone(before), posedAfter = structuredClone(after)
  for (const original of parts) {
    const actual = actualParts.get(original.id)
    // Keep exact saved transforms for the existing shell/path alignment checks.
    posedBefore.spec.entities.find(entity => entity.id === original.id).transform = structuredClone(actual.transform)
    const next = posedAfter.spec.entities.find(entity => entity.id === original.id)
    const location = point(next.transform.location)
    next.transform = { ...structuredClone(actual.transform), location }
  }
  // Generator paths remain local; only object locations use the placement matrix.
  return { current, before: posedBefore, after: posedAfter, rigidPose: true }
}
