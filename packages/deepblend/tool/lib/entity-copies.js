import { BlenderError, BlenderErrorCode, sceneSpecDigest, sha256Canonical } from '@deepblend/dsh-blender-contracts'

const validId = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Expand bounded saved-data references into the ordinary atomic patch protocol. */
export async function expandEntityCopies(studio, args) {
  const invalid = message => { throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, message) }
  const offset = args.entityCopyOffset
  if (offset !== undefined && (args.entityCopies === undefined || !Array.isArray(offset) || offset.length !== 3 ||
      !offset.every(value => typeof value === 'number' && Number.isFinite(value)))) {
    invalid('entityCopyOffset requires entityCopies and three finite world-metre translation components.')
  }
  if (args.entityCopies === undefined) return { operations: args.operations, copies: [] }
  if (!Array.isArray(args.entityCopies) || args.entityCopies.length < 1 || args.entityCopies.length > 16) {
    invalid('entityCopies must contain 1–16 explicit saved entity copies.')
  }
  if (args.operations.length + args.entityCopies.length > 500) invalid('Expanded patch exceeds the 500-operation limit.')
  const ids = new Set()
  for (const copy of args.entityCopies) {
    if (!plain(copy) || Object.keys(copy).some(k => !['sourceEntityId', 'newEntityId', 'transform'].includes(k)) ||
        !validId(copy.sourceEntityId) || !validId(copy.newEntityId) || ids.has(copy.newEntityId)) {
      invalid('Each copy requires a saved sourceEntityId and distinct newEntityId; only transform may also be supplied.')
    }
    ids.add(copy.newEntityId)
    if (offset !== undefined && copy.transform?.location !== undefined) invalid('entityCopyOffset cannot be combined with a copy absolute location override.')
    if (copy.transform !== undefined && (!plain(copy.transform) || Object.keys(copy.transform).some(k =>
      !['location', 'rotationEuler', 'scale'].includes(k) || !Array.isArray(copy.transform[k]) ||
      copy.transform[k].length !== 3 || !copy.transform[k].every(v => typeof v === 'number' && Number.isFinite(v))))) {
      invalid('Copy transform must contain only finite three-number location, rotationEuler or scale components.')
    }
  }
  const data = await studio.getScene(args.projectId, { revision: args.baseRevision, full: true })
  if (!data?.spec || !Array.isArray(data.spec.entities) || data.projectId !== args.projectId ||
      data.revision !== args.baseRevision || data.digest !== sceneSpecDigest(data.spec)) {
    throw new BlenderError(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'Host did not return the matching saved source revision for entity copies.')
  }
  const sources = new Map(data.spec.entities.map(entity => [entity.id, entity]))
  const additions = [], copies = []
  for (const copy of args.entityCopies) {
    const source = sources.get(copy.sourceEntityId)
    if (!source || sources.has(copy.newEntityId)) {
      throw new BlenderError(BlenderErrorCode.SCENE_PATCH_REJECTED, 'Copy source must exist in baseRevision and newEntityId must not already exist.')
    }
    const entity = structuredClone(source)
    entity.id = copy.newEntityId
    if (copy.transform !== undefined) entity.transform = { ...entity.transform, ...structuredClone(copy.transform) }
    if (offset !== undefined) {
      const location = (source.transform?.location ?? [0, 0, 0]).map((value, index) => value + offset[index])
      if (!location.every(Number.isFinite)) invalid('entityCopyOffset produced a non-finite position.')
      entity.transform = { ...entity.transform, location }
    }
    additions.push({ op: 'entity.add', entity })
    copies.push({ sourceRevision: data.revision, sourceDigest: data.digest, sourceEntityId: source.id,
      sourceEntitySha256: sha256Canonical(source), newEntityId: entity.id })
  }
  // New entities are available to ordinary operations in this same atomic patch.
  return { operations: [...additions, ...args.operations], copies }
}
