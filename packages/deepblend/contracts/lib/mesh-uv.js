import { meshGeneratorIssues } from './mesh-geometry.js'

const subtract = (a, b) => a.map((value, axis) => value - b[axis])
const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0)
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = vector => {
  const length = Math.hypot(...vector)
  if (!(length > 0)) throw new Error('face has no stable projection direction')
  return vector.map(value => value / length)
}

/** Explicit corner UVs, leaving control geometry and legacy missing-UV behavior alone.
 * Each planar face starts at (0, 0); islands overlap intentionally for repeating
 * textures. One mesh-wide divisor retains aspect and relative texel density.
 */
export function projectMeshFaceUvs(generator, { quarterTurns = 0, scale = 1 } = {}) {
  if (generator?.shape !== 'mesh') throw new Error('UV projection requires a mesh generator')
  if (!Number.isInteger(quarterTurns) || quarterTurns < 0 || quarterTurns > 3
    || !Number.isFinite(scale) || scale < 0.0001 || scale > 10000) {
    throw new Error('UV projection needs quarterTurns 0–3 and scale 0.0001–10000')
  }
  const { vertices, faces } = generator
  const issues = meshGeneratorIssues({ vertices, faces })
  if (issues.length) throw new Error(issues[0])
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity]
  for (const vertex of vertices) for (let axis = 0; axis < 3; axis++) {
    low[axis] = Math.min(low[axis], vertex[axis])
    high[axis] = Math.max(high[axis], vertex[axis])
  }
  const size = Math.max(...high.map((value, axis) => value - low[axis]))
  return faces.map((face, index) => {
    const origin = vertices[face[0]], points = face.map(vertex => subtract(vertices[vertex], origin))
    let normal = [0, 0, 0]
    for (let corner = 1; corner < points.length - 1; corner++) {
      const area = cross(points[corner], points[corner + 1])
      normal = normal.map((value, axis) => value + area[axis])
    }
    normal = unit(normal)
    const span = Math.max(...points.map(point => Math.hypot(...point)))
    if (points.some(point => Math.abs(dot(point, normal)) > span * 1e-6)) {
      throw new Error(`mesh face ${index} is not planar; split it into planar faces before UV projection`)
    }
    let best = null
    for (let corner = 0; corner < points.length; corner++) {
      const edge = subtract(points[(corner + 1) % points.length], points[corner])
      const tangent = edge.map((value, axis) => value - normal[axis] * dot(edge, normal))
      const lengthSquared = dot(tangent, tangent)
      if (!(lengthSquared > 0)) continue
      let direction = unit(tangent)
      const axis = [0, 1, 2].sort((a, b) => Math.abs(direction[b]) - Math.abs(direction[a]) || a - b)[0]
      if (direction[axis] < 0) direction = direction.map(value => -value)
      direction = direction.map(value => value === 0 ? 0 : value)
      const rank = JSON.stringify(direction)
      if (best === null || lengthSquared > best.lengthSquared || lengthSquared === best.lengthSquared && rank < best.rank) {
        best = { lengthSquared, direction, rank }
      }
    }
    if (best === null) throw new Error(`mesh face ${index} has no stable edge`)
    const u = best.direction, v = unit(cross(normal, u))
    let coordinates = points.map(point => [dot(point, u) / size * scale, dot(point, v) / size * scale])
    for (let turn = 0; turn < quarterTurns; turn++) coordinates = coordinates.map(([x, y]) => [-y, x])
    const minimum = [0, 1].map(axis => Math.min(...coordinates.map(point => point[axis])))
    return coordinates.map(point => point.map((value, axis) => {
      const result = value - minimum[axis]
      if (!Number.isFinite(result)) throw new Error(`mesh face ${index} produced non-finite UVs`)
      return result === 0 ? 0 : result
    }))
  })
}
