/** Resolve saved recipe provenance using the selected revision's own ancestry. */
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { BlenderError, instantiateRecipeLock, sha256Canonical } from '@deepblend/dsh-blender-contracts'

const fail = message => { throw new BlenderError('RECIPE_LOCK_INVALID', message) }
function readBounded(path, limit) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) fail('Stored recipe metadata exceeds its limit or is not a file')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0, read
    do { read = readSync(fd, bytes, length, bytes.length - length, null); length += read } while (read && length < bytes.length)
    if (length > limit) fail('Stored recipe metadata grew beyond its limit')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
  } catch (error) {
    if (error instanceof BlenderError) throw error
    fail('Stored recipe metadata cannot be decoded')
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function readRecipeContext(store, projectId, revision) {
  const visited = new Set()
  let cursor = revision, state = null, stateRevision = null
  while (cursor !== 'r0000') {
    if (visited.has(cursor) || visited.size >= 4096) fail('Recipe revision ancestry is cyclic or exceeds its limit')
    visited.add(cursor)
    const manifest = store.readRevisionManifest(projectId, cursor)
    if (!manifest || manifest.revision !== cursor) fail('Recipe revision ancestry contains an invalid manifest')
    if (state === null && manifest.recipeParameters) {
      if (manifest.recipeParameters.statePath !== 'recipe-parameters.json') fail('Unexpected recipe parameter state path')
      state = readBounded(join(store.revisionDirectory(projectId, cursor), 'recipe-parameters.json'), 65536)
      if (sha256Canonical(state) !== manifest.recipeParameters.stateSha256) fail('Recipe parameter state differs from its saved hash')
      stateRevision = cursor
    }
    if (manifest.recipe) {
      if (manifest.recipe.lockPath !== 'recipe-lock.json') fail('Unexpected recipe origin path')
      const lock = readBounded(join(store.revisionDirectory(projectId, cursor), 'recipe-lock.json'), 8 * 1024 * 1024)
      if (lock.id !== manifest.recipe.id || lock.version !== manifest.recipe.version
          || lock.packageDigest !== manifest.recipe.packageDigest) fail('Recipe origin differs from its revision reference')
      try { instantiateRecipeLock(lock) }
      catch (error) { throw new BlenderError(error.code ?? 'RECIPE_LOCK_INVALID', error.message, { detail: error.details }) }
      if (state !== null && (state.schemaVersion !== 'deepblend.recipe-parameters/v1'
          || state.originRevision !== cursor || state.manifestSha256 !== lock.manifestSha256)) {
        fail('Saved parameters belong to a different recipe origin')
      }
      if (state !== null) {
        try { instantiateRecipeLock({ ...lock, values: state.values, valuesSha256: state.valuesSha256 }) }
        catch (error) { throw new BlenderError(error.code ?? 'RECIPE_LOCK_INVALID', error.message, { detail: error.details }) }
      }
      return { originRevision: cursor, lock, state, stateRevision }
    }
    const base = manifest.baseRevision
    if (typeof base !== 'string' || !/^r[0-9]{4,}$/.test(base)
        || Number(base.slice(1)) >= Number(cursor.slice(1))) fail('Recipe ancestry must refer to an earlier revision')
    cursor = base
  }
  if (state !== null) fail('Saved parameters have no recipe origin')
  return null
}
