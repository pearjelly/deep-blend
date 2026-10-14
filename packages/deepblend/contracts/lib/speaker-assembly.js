/** Recognize a rigidly translated, pinned speaker without changing its origin lock. */
const sources = new Set([
  'e760a69e9f79f626205655445f24a3f254a53942ed55128554129ad18a2148f3',
  '2810f8a9581d4fe48ef9581180168b087f798bd4400c86cd83a9f82b74acfae8',
])
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9

export function translatedSpeakerAssembly(lock, current, before, after) {
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
