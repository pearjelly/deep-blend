/** Continue the pinned cup's default camera rig in its saved object pose. */
import { canonicalStringify } from './canonical.js'
import { compileSceneSpec } from './scene-spec.js'

const source = 'db9859743b99e6f18329c7e7b10d67879f1a8b0a0d2174ba0a074eb0cede7971'
const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v - b[i]) <= 1e-9)
const rotation = ([x, y, z]) => {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  return [[cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx], [sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx], [-sy, cy*sx, cy*cx]]
}
const multiply = (m, p) => m.map(row => row.reduce((s, v, i) => s + v*p[i], 0))
const transpose = m => m[0].map((_, i) => m.map(row => row[i]))

export function placedCupCameras(lock, current, before, after) {
  if (lock.manifestSha256 !== source) return { before, after }
  current = compileSceneSpec(current).spec
  const anchor = before.spec.entities.find(e => e.id === 'cup'), actual = current.entities.find(e => e.id === 'cup')
  if (!actual || actual.type !== anchor.type || actual.generator?.shape !== anchor.generator.shape ||
      !near(actual.transform.scale, anchor.transform.scale)) return { before, after }
  const origin = anchor.transform.location, destination = actual.transform.location
  const originalRotation = rotation(anchor.transform.rotationEuler), currentRotation = rotation(actual.transform.rotationEuler)
  const point = p => multiply(currentRotation, multiply(transpose(originalRotation), p.map((v, i) => v-origin[i]))).map((v, i) => v+destination[i])
  const move = camera => {
    const result = structuredClone(camera)
    result.transform.location = point(camera.transform.location)
    if (camera.targetPoint) result.targetPoint = point(camera.targetPoint)
    return result
  }
  const sameRigCamera = (expected, saved) => {
    if (!saved || !near(expected.transform.location, saved.transform.location) ||
        !near(expected.targetPoint, saved.targetPoint)) return false
    const stripPoints = camera => {
      const copy = structuredClone(camera); delete copy.transform.location; delete copy.targetPoint; return copy
    }
    return canonicalStringify(stripPoints(expected)) === canonicalStringify(stripPoints(saved))
  }
  const result = { before: structuredClone(before), after: structuredClone(after), protectedCameraIds: [] }
  for (const camera of before.spec.cameras) {
    if (current.animationTracks.some(track => track.targetKind === 'camera' && track.targetEntityId === camera.id)) {
      result.protectedCameraIds.push(camera.id); continue
    }
    const saved = current.cameras.find(c => c.id === camera.id)
    if (!sameRigCamera(move(camera), saved)) continue
    // Only coordinates in a recognized default rig may follow dimensions.
    // Keep every other authored camera field and all unrelated scene data intact.
    result.before.spec.cameras.find(c => c.id === camera.id).transform = structuredClone(saved.transform)
    result.before.spec.cameras.find(c => c.id === camera.id).targetPoint = structuredClone(saved.targetPoint)
    const target = result.after.spec.cameras.find(c => c.id === camera.id)
    const moved = move(target)
    if (![...moved.transform.location, ...moved.targetPoint].every(Number.isFinite)) return { before, after }
    target.transform.location = moved.transform.location; target.targetPoint = moved.targetPoint
  }
  return result
}
