import { BlenderError, BlenderErrorCode, sceneSpecDigest, sha256, sha256Canonical } from '@deepblend/dsh-blender-contracts'

/** A bounded projection of saved entity data, never a filesystem reader. */
export async function readEntitySource(studio, args) {
  const invalid = message => { throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, message) }
  if (typeof args.sourceEntityId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(args.sourceEntityId)) {
    invalid('sourceEntityId must be one saved entity ID (1–64 characters).')
  }
  const offset = args.sourceOffset === undefined ? 0 : args.sourceOffset
  const limit = args.sourceLimit === undefined ? 2048 : args.sourceLimit
  if (!Number.isSafeInteger(offset) || offset < 0) invalid('sourceOffset must be a non-negative safe integer.')
  if (!Number.isInteger(limit) || limit < 1 || limit > 2048) invalid('sourceLimit must be an integer from 1 to 2048.')
  if (offset > 0 && args.revision === undefined) invalid('Subsequent source chunks require the revision returned by the first chunk.')
  if (args.full === true || Object.keys(args).some(key => key.startsWith('geometry') && args[key] !== undefined)) {
    invalid('Entity source chunks cannot be combined with full:true or geometry options.')
  }
  const data = await studio.getScene(args.projectId, { ...(args.revision === undefined ? {} : { revision: args.revision }), full: true })
  if (!data?.spec || !Array.isArray(data.spec.entities) || !/^r\d{4,}$/.test(data.revision ?? '') ||
      data.projectId !== args.projectId || (args.revision !== undefined && data.revision !== args.revision) ||
      data.digest !== sceneSpecDigest(data.spec)) {
    throw new BlenderError(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'Host did not return a matching saved SceneSpec for bounded entity source reading.')
  }
  const matches = data.spec.entities.filter(entity => entity.id === args.sourceEntityId)
  if (matches.length !== 1) invalid('sourceEntityId must identify exactly one entity in the selected saved revision.')
  const source = JSON.stringify(matches[0])
  if (offset > source.length) invalid('sourceOffset exceeds the entity source length.')
  let end = Math.min(source.length, offset + limit)
  // Escaped controls can cost six output characters each. Keep the rendered
  // response safely below the preset's 8192-character spill threshold.
  while (JSON.stringify(source.slice(offset, end)).length > 4096) end--
  return { projectId: args.projectId, revision: data.revision, digest: data.digest, isCurrent: data.isCurrent,
    documentSha256: sha256Canonical(data.spec), entityId: args.sourceEntityId, entityJsonSha256: sha256(source),
    serialization: 'compact JSON; offsets are UTF-16 code units', totalChars: source.length,
    sourceOffset: offset, sourceLength: end - offset, nextOffset: end < source.length ? end : null,
    sourceText: source.slice(offset, end) }
}
