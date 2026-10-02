/** Local, data-only recipe packages. Only operator-configured directories are read. */
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlenderError, canonicalStringify, sha256, validateRecipePackage, instantiateRecipe, RECIPE_LIMITS, RECIPE_SCHEMA_VERSION } from '@deepblend/dsh-blender-contracts'

export const BUILTIN_RECIPES = fileURLToPath(new URL('../recipes/', import.meta.url))
const fail = (code, message) => { throw new BlenderError(code, message) }
const identity = manifest => `${manifest.id}@${manifest.version}`
const limits = { 'recipe.json': 65536, 'scene-spec.json': RECIPE_LIMITS.sceneBytes, 'preview.png': RECIPE_LIMITS.previewBytes }

function readBounded(path, limit) {
  if (lstatSync(path).isSymbolicLink()) fail('RECIPE_PATH_INVALID', 'Recipe files cannot be symbolic links')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) fail('RECIPE_SIZE_LIMIT', 'Recipe file exceeds its byte limit or is not a regular file')
    const bytes = Buffer.alloc(limit + 1)
    let length = 0, read = 0
    do { read = readSync(fd, bytes, length, bytes.length - length, null); length += read } while (read && length < bytes.length)
    if (length > limit) fail('RECIPE_SIZE_LIMIT', 'Recipe file grew beyond its byte limit')
    return Buffer.from(bytes.subarray(0, length))
  } finally { closeSync(fd) }
}

export class RecipeCatalog {
  constructor({ directories = [], builtinRoot = BUILTIN_RECIPES } = {}) {
    if (directories.length > 32) fail('RECIPE_CATALOG_LIMIT', 'At most 32 recipe directories may be configured')
    this.roots = [...new Set([builtinRoot, ...directories].map(path => resolve(path)))]
    this.cache = new Map()
  }

  _read(directory, fresh = false) {
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail('RECIPE_PATH_INVALID', 'Recipe packages must be real directories')
    const real = realpathSync(directory)
    if (dirname(real) !== realpathSync(dirname(directory))) fail('RECIPE_PATH_INVALID', 'Recipe directory escapes its registered root')
    const signature = Object.keys(limits).map(name => {
      const stat = lstatSync(join(real, name), { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink()) fail('RECIPE_PATH_INVALID', 'Recipe files must be regular files')
      return `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    }).join('|')
    const cached = this.cache.get(real)
    if (!fresh && cached?.signature === signature) return cached
    const manifestBytes = readBounded(join(real, 'recipe.json'), limits['recipe.json'])
    const bundle = { manifest: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)),
      sceneBytes: readBounded(join(real, 'scene-spec.json'), limits['scene-spec.json']),
      previewBytes: readBounded(join(real, 'preview.png'), limits['preview.png']) }
    const check = validateRecipePackage(bundle)
    if (!check.ok) fail(check.errors[0].code, check.summary)
    const digest = sha256(canonicalStringify(bundle.manifest))
    const { id, version, title, description, author, license, source, parameters } = bundle.manifest
    const value = { signature, directory: real, bundle, digest,
      summary: { id, version, title, description, author, license, source, parameters, digest,
        previewUrl: `/deepblend/recipes/${encodeURIComponent(id)}/${encodeURIComponent(version)}/preview?digest=${digest}` } }
    value.byteLength = manifestBytes.length + bundle.sceneBytes.length + bundle.previewBytes.length
    this.cache.delete(real)
    this.cache.set(real, value)
    let cachedBytes = [...this.cache.values()].reduce((sum, item) => sum + item.byteLength, 0)
    for (const [key, item] of this.cache) {
      if (cachedBytes <= 64 * 1024 * 1024) break
      this.cache.delete(key); cachedBytes -= item.byteLength
    }
    return value
  }

  _scan() {
    const entries = new Map(), conflicts = new Set(), errors = []
    let count = 0
    const seenRoots = new Set()
    for (const root of this.roots) {
      try {
        const realRoot = realpathSync(root)
        if (seenRoots.has(realRoot)) continue
        seenRoots.add(realRoot)
        for (const folder of readdirSync(realRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!folder.isDirectory() && !folder.isSymbolicLink()) continue
          if (++count > 200) fail('RECIPE_CATALOG_LIMIT', 'At most 200 recipe packages may be registered')
          try {
            const entry = this._read(join(realRoot, folder.name)), key = identity(entry.bundle.manifest)
            if (entries.has(key) || conflicts.has(key)) {
              entries.delete(key); conflicts.add(key)
              fail('RECIPE_ID_CONFLICT', `More than one package declares ${key}; neither can be selected`)
            }
            entries.set(key, { directory: entry.directory, summary: entry.summary })
          } catch (error) { errors.push({ package: folder.name, code: error.code ?? 'RECIPE_PACKAGE_INVALID', message: error.message }) }
        }
      } catch (error) { errors.push({ code: error.code ?? 'RECIPE_DIRECTORY_INVALID', message: error.message }) }
    }
    const active = new Set([...entries.values()].map(entry => entry.directory))
    for (const key of this.cache.keys()) if (!active.has(key)) this.cache.delete(key)
    return { entries, errors }
  }

  list() {
    const { entries, errors } = this._scan()
    return { recipeSchemaVersion: RECIPE_SCHEMA_VERSION, recipes: [...entries.values()].map(entry => structuredClone(entry.summary)), errors }
  }

  get(request) {
    if (!request || typeof request.id !== 'string' || typeof request.version !== 'string' || !/^[a-f0-9]{64}$/.test(request.digest ?? '')) {
      fail('RECIPE_REQUEST_INVALID', 'Select a recipe with its id, version and digest')
    }
    const entry = this._scan().entries.get(`${request.id}@${request.version}`)
    if (!entry) fail('RECIPE_NOT_FOUND', 'The selected recipe is unavailable; refresh the catalog')
    // Recheck actual bytes at the write/preview boundary, even when listing used a cache.
    const current = this._read(entry.directory, true)
    if (current.digest !== request.digest) fail('RECIPE_CHANGED', 'The recipe changed; refresh the catalog before creating a project')
    return current
  }

  instantiate(request) {
    const entry = this.get(request)
    let result
    try { result = instantiateRecipe(entry.bundle, request.parameters === undefined ? {} : request.parameters) }
    catch (error) { throw new BlenderError(error.code ?? 'RECIPE_PARAMETER_INVALID', error.message, { detail: error.details }) }
    return { sceneSpec: result.spec, lock: {
      schemaVersion: 'deepblend.recipe-lock/v1', ...result.recipe, packageDigest: entry.digest,
      manifest: entry.bundle.manifest, values: result.values,
      // Exact bytes make the declared input hash verifiable after the local recipe is removed.
      sceneSource: entry.bundle.sceneBytes.toString('utf8'),
    } }
  }

  preview(request) {
    const { bundle } = this.get(request)
    return { bytes: bundle.previewBytes, contentType: 'image/png', size: bundle.previewBytes.length }
  }
}
