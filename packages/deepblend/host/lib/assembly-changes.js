/** Describe saved object-origin moves and changed generators, not surface clearances. */
import { canonicalStringify } from '@deepblend/dsh-blender-contracts'
export function assemblyPlacementChanges(before, after, fromRevision, toRevision) {
  const previous = new Map(before.entities.map(entity => [entity.id, entity]))
  const groups = new Map()
  const generatorChangedEntityIds = []
  for (const entity of after.entities) {
    const original = previous.get(entity.id)
    if (!original) continue
    if (canonicalStringify(entity.generator) !== canonicalStringify(original.generator)) generatorChangedEntityIds.push(entity.id)
    const from = original.transform?.location ?? [0, 0, 0]
    const to = entity.transform?.location ?? [0, 0, 0]
    const deltaMm = to.map((value, axis) => Number(((value - from[axis]) * 1000).toFixed(9)))
    if (deltaMm.every(value => value === 0)) continue
    const key = JSON.stringify(deltaMm)
    if (!groups.has(key)) groups.set(key, { deltaMm, entityIds: [] })
    groups.get(key).entityIds.push(entity.id)
  }
  return { source: 'saved-scene-spec', coordinateField: 'entity.transform.location',
    fromRevision, toRevision, groups: [...groups.values()], generatorChangedEntityIds }
}
