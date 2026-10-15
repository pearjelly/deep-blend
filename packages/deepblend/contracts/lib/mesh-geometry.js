/** Bounded, declarative control meshes. No expressions or executable code. */
export const MESH_FIELDS = Object.freeze(['vertices', 'faces', 'faceUvs', 'smooth'])
export const MESH_MAX_VERTICES = 32768
export const MESH_MAX_FACES = 32768
export const MESH_MAX_CORNERS = 131072

export function meshGeneratorIssues(generator) {
  const issues = [], vertices = generator.vertices, faces = generator.faces
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > MESH_MAX_VERTICES) {
    issues.push('mesh requires 3 to 32768 local-space vertices')
    return issues
  }
  if (vertices.some(point => !Array.isArray(point) || point.length !== 3 ||
    point.some(value => !Number.isFinite(value) || Math.abs(value) > 1e6))) {
    issues.push('mesh vertices require three finite local coordinates within ±1000000')
    return issues
  }
  if (!Array.isArray(faces) || faces.length < 1 || faces.length > MESH_MAX_FACES) {
    issues.push('mesh requires 1 to 32768 indexed faces')
    return issues
  }
  if (faces.reduce((sum, face) => sum + (face?.length ?? 0), 0) > MESH_MAX_CORNERS) {
    issues.push('mesh exceeds the 131072 face-corner budget')
    return issues
  }
  const seen = new Set()
  for (const [index, face] of faces.entries()) {
    if (!Array.isArray(face) || face.length < 3 || face.length > 32 ||
      face.some(vertex => !Number.isInteger(vertex) || vertex < 0 || vertex >= vertices.length) ||
      new Set(face).size !== face.length) {
      issues.push(`mesh face ${index} needs 3 to 32 distinct in-range vertex indices`)
      continue
    }
    const key = [...face].sort((a, b) => a - b).join(',')
    if (seen.has(key)) issues.push(`mesh face ${index} duplicates an existing face`)
    seen.add(key)
    const origin = vertices[face[0]], normal = [0, 0, 0]
    let scaleSquared = 0
    const points = face.map(vertex => vertices[vertex].map((value, axis) => value - origin[axis]))
    for (const point of points) scaleSquared = Math.max(scaleSquared, point.reduce((sum, value) => sum + value * value, 0))
    for (let corner = 1; corner < points.length - 1; corner++) {
      const a = points[corner], b = points[corner + 1]
      normal[0] += a[1] * b[2] - a[2] * b[1]
      normal[1] += a[2] * b[0] - a[0] * b[2]
      normal[2] += a[0] * b[1] - a[1] * b[0]
    }
    if (Math.hypot(...normal) <= scaleSquared * 1e-12) issues.push(`mesh face ${index} has zero or unstable area`)
  }
  if (generator.faceUvs !== undefined) {
    if (!Array.isArray(generator.faceUvs) || generator.faceUvs.length !== faces.length ||
      generator.faceUvs.some((corners, index) => !Array.isArray(corners) || !Array.isArray(faces[index]) || corners.length !== faces[index].length ||
        corners.some(uv => !Array.isArray(uv) || uv.length !== 2 || uv.some(value => !Number.isFinite(value))))) {
      issues.push('mesh faceUvs must supply one finite UV pair for every face corner')
    }
  }
  return issues
}
