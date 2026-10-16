/** Recognize a rigidly translated, pinned speaker without changing its origin lock. */
const sources = new Set([
  'e760a69e9f79f626205655445f24a3f254a53942ed55128554129ad18a2148f3',
  '2810f8a9581d4fe48ef9581180168b087f798bd4400c86cd83a9f82b74acfae8',
])
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9

function translatedOnly(lock, current, before, after) {
  if (!sources.has(lock.manifestSha256)) return { before, after }
  const parts = before.spec.entities.filter(entity => entity.id !== 'studio-floor')
  const anchor = parts.find(entity => entity.id === 'cabinet-shell')
  const actualAnchor = current.entities.find(entity => entity.id === anchor.id)
  if (!actualAnchor?.transform?.location) return { before, after }
  const offset = actualAnchor.transform.location.map((value, axis) => value - anchor.transform.location[axis])
  if (offset.every(value => close(value, 0))) return { before, after }
  // A partial move must remain a conflict, including axes without parameter bindings.
  if (!parts.every(original => {
    const actual = current.entities.find(entity => entity.id === original.id)
    return actual?.transform?.location && original.transform.location.every((value, axis) => close(actual.transform.location[axis], value + offset[axis]))
  })) return { before, after }
  const tracks = before.spec.animationTracks.filter(track => (track.targetKind ?? 'entity') === 'entity'
    && parts.some(entity => entity.id === track.targetEntityId) && /^location\.[xyz]$/.test(track.property))
  if (!tracks.every(original => {
    const actual = (current.animationTracks ?? []).find(track => track.id === original.id)
    const axis = ['x', 'y', 'z'].indexOf(original.property.at(-1))
    // The authored rest anchor must follow the assembly. Later press timing and
    // travel can be custom; the planner offsets those actual keys, never replaces them.
    return actual && actual.targetEntityId === original.targetEntityId && actual.property === original.property
      && (actual.targetKind ?? 'entity') === 'entity'
      && actual.keyframes[0]?.frame === original.keyframes[0].frame
      && close(actual.keyframes[0]?.value, original.keyframes[0].value + offset[axis])
  })) return { before, after }
  const translate = resolved => {
    const result = structuredClone(resolved)
    for (const entity of result.spec.entities) if (entity.id !== 'studio-floor') {
      entity.transform.location = entity.transform.location.map((value, axis) => value + offset[axis])
    }
    return result
  }
  return { before: translate(before), after: translate(after) }
}

// XYZ Euler matrices match Blender's intrinsic object rotations (Rz * Ry * Rx).
const rotation = ([x, y, z]) => {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  return [[cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx], [sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx], [-sy, cy*sx, cy*cx]]
}
const mul = (m, p) => m.map(row => row.reduce((sum, value, i) => sum + value*p[i], 0))
const transpose = m => m[0].map((_, i) => m.map(row => row[i]))
const product = (a, b) => a.map(row => transpose(b).map(column => row.reduce((s, v, i) => s + v*column[i], 0)))
const near = (a, b) => Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => near(v, b[i]))
  : Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= 1e-6

/** Recognize a complete pinned rigid pose; partial and scaled placements remain conflicts. */
export function translatedSpeakerAssembly(lock, current, before, after) {
  if (!sources.has(lock.manifestSha256)) return { before, after }
  const parts = before.spec.entities.filter(e => e.id !== 'studio-floor')
  const anchor = parts.find(e => e.id === 'cabinet-shell'), saved = current.entities.find(e => e.id === anchor?.id)
  if (!saved?.transform?.rotationEuler) return translatedOnly(lock, current, before, after)
  const matrix = product(rotation(saved.transform.rotationEuler), transpose(rotation(anchor.transform.rotationEuler)))
  // Retain the existing exact translation checks for identity orientation.
  if (near(matrix, [[1,0,0],[0,1,0],[0,0,1]])) return translatedOnly(lock, current, before, after)
  const point = p => mul(matrix, p.map((v, i) => v-anchor.transform.location[i])).map((v, i) => v+saved.transform.location[i])
  const actualParts = new Map(current.entities.map(e => [e.id, e]))
  if (!parts.every(original => {
    const actual = actualParts.get(original.id)
    return actual?.type === original.type && near(actual.transform?.location, point(original.transform.location))
      && near(rotation(actual.transform.rotationEuler), product(matrix, rotation(original.transform.rotationEuler)))
      && original.transform.scale.every((v, i) => close(v, actual.transform.scale[i]))
  })) return { before, after }
  // A rotated translation curve needs a world-space rest anchor on every moved axis.
  // Authored later keys/travel are preserved; absence of a coupled curve is unsafe.
  for (const original of before.spec.animationTracks ?? []) {
    if ((original.targetKind ?? 'entity') !== 'entity' || !actualParts.has(original.targetEntityId)
      || !parts.some(e => e.id === original.targetEntityId) || !/^location\.[xyz]$/.test(original.property)) continue
    const axis = ['x','y','z'].indexOf(original.property.at(-1))
    const originalPart = parts.find(e => e.id === original.targetEntityId)
    const rest = [...originalPart.transform.location]; rest[axis] = original.keyframes[0].value
    const expected = point(rest)
    for (let worldAxis = 0; worldAxis < 3; worldAxis++) {
      if (Math.abs(matrix[worldAxis][axis]) <= 1e-9) continue
      const candidates = (current.animationTracks ?? []).filter(t => (t.targetKind ?? 'entity') === 'entity'
        && t.targetEntityId === original.targetEntityId && t.property === `location.${['x','y','z'][worldAxis]}`)
      if (candidates.length !== 1 || candidates[0].keyframes[0]?.frame !== original.keyframes[0].frame
        || !near(candidates[0].keyframes[0]?.value, expected[worldAxis])) return { before, after }
    }
  }
  const posedBefore = structuredClone(before), posedAfter = structuredClone(after)
  for (const original of parts) {
    const actual = actualParts.get(original.id), next = posedAfter.spec.entities.find(e => e.id === original.id)
    const old = posedBefore.spec.entities.find(e => e.id === original.id)
    old.transform.location = [...actual.transform.location]
    old.transform.rotationEuler = [...actual.transform.rotationEuler]
    next.transform.location = mul(matrix, next.transform.location.map((v, i) => v-original.transform.location[i]))
      .map((v, i) => v+actual.transform.location[i])
    next.transform.rotationEuler = [...actual.transform.rotationEuler]
  }
  return { before: posedBefore, after: posedAfter, rigidPose: true }
}
