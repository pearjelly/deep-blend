/** Portable data recipes. No filesystem, network, dynamic imports or code execution. */
import { inflateSync } from 'node:zlib'
import { sha256, sha256Canonical } from './canonical.js'
import { compileSchema } from './json-schema.js'
import { decodePng } from './png.js'
import { validateSceneSpec, compileSceneSpec } from './scene-spec.js'
import recipeSchema from './schemas/recipe.schema.json' with { type: 'json' }

export const RECIPE_SCHEMA_VERSION = 'deepblend.recipe/v1'
export const RECIPE_CAPABILITIES = Object.freeze([
  'geometry.primitive', 'geometry.lathe', 'geometry.curve', 'geometry.handled_cup', 'geometry.handled_cup.tension', 'geometry.modifiers',
  'material.principled', 'material.glass', 'material.emission', 'material.procedural', 'material.procedural.uv', 'material.anisotropy',
  'animation.transform', 'animation.material',
])
export const RECIPE_LIMITS = Object.freeze({ sceneBytes: 2 * 1024 * 1024, previewBytes: 4 * 1024 * 1024, previewPixels: 4 * 1024 * 1024 })
const structural = compileSchema(recipeSchema, { id: 'recipe.schema.json' })
const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const issue = (code, path, message) => ({ code, path, message })
const result = (errors, extra = {}) => ({ ok: errors.length === 0, errors, notices: [],
  summary: errors.length ? errors.map(error => `${error.path}: ${error.message}`).join('; ') : 'Recipe valid', ...extra })

export class RecipeError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'RecipeError'; this.code = code; this.details = details
  }
}

/** Capabilities describe what the input actually uses, rather than its author's claims. */
export function recipeCapabilitiesForScene(spec) {
  const used = new Set()
  for (const entity of spec.entities ?? []) {
    if (entity.type === 'generator') used.add(['lathe', 'curve', 'handled_cup'].includes(entity.generator.shape)
      ? `geometry.${entity.generator.shape}` : 'geometry.primitive')
    if (entity.modifiers?.length || entity.generator?.bevel) used.add('geometry.modifiers')
    if (entity.generator?.shape === 'handled_cup' && (entity.generator.rootTension ?? 1) !== 1) used.add('geometry.handled_cup.tension')
  }
  for (const material of spec.materials ?? []) {
    used.add(`material.${material.shader}`)
    if (material.texture) used.add('material.procedural')
    if (material.texture?.coordinates === 'uv') used.add('material.procedural.uv')
    if (material.tangent !== undefined || material.parameters?.anisotropic !== undefined || material.parameters?.anisotropicRotation !== undefined) used.add('material.anisotropy')
  }
  for (const track of spec.animationTracks ?? []) {
    used.add(track.targetKind === 'material' ? 'animation.material' : 'animation.transform')
    if (track.targetKind === 'material' && ['anisotropic', 'anisotropicRotation'].includes(track.property)) used.add('material.anisotropy')
  }
  return [...used].sort()
}

function parameterValueIssue(parameter, value, path) {
  if (parameter.type === 'color') {
    if (!Array.isArray(value) || value.length !== 3 || Array.from(value).some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
      return issue('RECIPE_PARAMETER_INVALID', path, 'Expected three scene-linear RGB channels in [0, 1]')
    }
  } else if (!Number.isFinite(value) || value < parameter.minimum || value > parameter.maximum) {
    return issue('RECIPE_PARAMETER_INVALID', path, `Expected a finite number in [${parameter.minimum}, ${parameter.maximum}]`)
  }
  return null
}

export function validateRecipeManifest(manifest, options = {}) {
  const errors = structural(manifest).map(error => issue('RECIPE_MANIFEST_INVALID', error.path, error.message))
  if (errors.length) return result(errors)
  if (RESERVED.has(manifest.id)) errors.push(issue('RECIPE_MANIFEST_INVALID', 'id', 'Reserved object keys are not recipe IDs'))
  for (const [path, value] of [['title', manifest.title], ['description', manifest.description], ['license', manifest.license], ['author.name', manifest.author.name]]) {
    if (!value.trim()) errors.push(issue('RECIPE_MANIFEST_INVALID', path, 'A non-empty declaration is required'))
  }
  for (const [path, address] of [['source.url', manifest.source.url], ['author.url', manifest.author.url]]) {
    if (address === undefined) continue
    try {
      const parsed = new URL(address)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error()
    } catch { errors.push(issue('RECIPE_MANIFEST_INVALID', path, 'Expected an HTTP(S) source reference without credentials; URLs are never fetched')) }
  }
  const supported = new Set(options.supportedCapabilities ?? RECIPE_CAPABILITIES)
  const declared = new Set()
  for (const capability of manifest.compatibility.capabilities) {
    if (declared.has(capability)) errors.push(issue('RECIPE_MANIFEST_INVALID', 'compatibility.capabilities', `Duplicate capability ${capability}`))
    declared.add(capability)
    if (!supported.has(capability)) errors.push(issue('RECIPE_INCOMPATIBLE', 'compatibility.capabilities', `Unsupported capability ${capability}`))
  }
  const ids = new Set(), targets = new Set()
  for (const parameter of manifest.parameters) {
    const path = `parameters.${parameter.id}`
    if (ids.has(parameter.id) || RESERVED.has(parameter.id)) errors.push(issue('RECIPE_PARAMETER_INVALID', path, 'Parameter IDs must be unique and must not be reserved object keys'))
    ids.add(parameter.id)
    if (parameter.type === 'number' && parameter.minimum > parameter.maximum) errors.push(issue('RECIPE_PARAMETER_INVALID', path, 'minimum must not exceed maximum'))
    const valueIssue = parameterValueIssue(parameter, parameter.default, `${path}.default`)
    if (valueIssue) errors.push(valueIssue)
    for (const binding of parameter.bindings) {
      const target = binding.kind === 'material' ? `material:${binding.materialId}:${binding.property}` : `render-profile:${binding.profile}:exposure`
      if (targets.has(target)) errors.push(issue('RECIPE_BINDING_INVALID', path, `Target ${target} is bound more than once`))
      targets.add(target)
      const color = binding.kind === 'material' && binding.property === 'baseColor'
      if ((parameter.type === 'color') !== color) errors.push(issue('RECIPE_BINDING_INVALID', path, 'Parameter type does not match the allowlisted property'))
      if (parameter.type === 'number') {
        const range = binding.kind === 'material' ? [0, 1] : [-10, 10]
        if (parameter.minimum < range[0] || parameter.maximum > range[1]) errors.push(issue('RECIPE_BINDING_INVALID', path, `Binding range must stay within [${range}]`))
      }
    }
  }
  return result(errors)
}

function asBytes(value, limit, path) {
  if (!(value instanceof Uint8Array) && typeof value !== 'string') throw new RecipeError('RECIPE_INPUT_INVALID', `${path}: expected bytes or UTF-8 text`)
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (!bytes.length || bytes.length > limit) throw new RecipeError('RECIPE_INPUT_INVALID', `${path}: byte count must be in [1, ${limit}]`)
  return bytes
}

// Bound PNG expansion before the shared decoder inflates it. A preview is data,
// but its declared hash alone must not grant it unbounded decompression memory.
const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function pngCrc(bytes, start, end) {
  let value = 0xffffffff
  for (let index = start; index < end; index++) value = PNG_CRC_TABLE[(value ^ bytes[index]) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function validatePreview(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Expected PNG bytes')
  let at = 8, width = 0, height = 0, channels = 0, ended = false
  const data = []
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new Error('Truncated PNG chunk')
    const size = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8), end = at + 8 + size
    if (end + 4 > bytes.length) throw new Error('Truncated PNG payload')
    if (pngCrc(bytes, at + 4, end) !== bytes.readUInt32BE(end)) throw new Error('PNG chunk checksum mismatch')
    if (at === 8 && kind !== 'IHDR') throw new Error('PNG must start with IHDR')
    if (kind === 'IHDR') {
      if (at !== 8 || size !== 13) throw new Error('Invalid PNG IHDR')
      width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12)
      const depth = bytes[at + 16], color = bytes[at + 17]
      if (depth !== 8 || ![2, 6].includes(color) || bytes[at + 18] || bytes[at + 19] || bytes[at + 20]) throw new Error('Preview must be a non-interlaced 8-bit RGB/RGBA PNG')
      channels = color === 6 ? 4 : 3
      if (!width || !height || width * height > RECIPE_LIMITS.previewPixels) throw new Error('Preview pixel limit exceeded')
    }
    if (kind === 'IDAT') data.push(bytes.subarray(at + 8, end))
    if (kind === 'IEND') {
      if (size !== 0 || end + 4 !== bytes.length) throw new Error('Invalid PNG end or trailing content')
      ended = true
    }
    at = end + 4
  }
  if (!ended || !data.length) throw new Error('PNG is missing image data or IEND')
  const expected = height * (1 + width * channels)
  if (inflateSync(Buffer.concat(data), { maxOutputLength: expected }).length !== expected) throw new Error('PNG scanline length differs from IHDR')
  decodePng(bytes)
}

function bindingsAgainstScene(manifest, spec) {
  const errors = []
  for (const parameter of manifest.parameters) for (const binding of parameter.bindings) {
    const path = `parameters.${parameter.id}.bindings`
    if (binding.kind === 'material') {
      const material = spec.materials?.find(item => item.id === binding.materialId)
      if (!material || !['principled', 'glass'].includes(material.shader) || material.parameters?.[binding.property] === undefined) {
        errors.push(issue('RECIPE_BINDING_INVALID', path, `Material ${binding.materialId} must explicitly declare ${binding.property} on principled/glass`))
      } else {
        const current = parameter.type === 'color' ? material.parameters.baseColor.slice(0, 3) : material.parameters[binding.property]
        if (JSON.stringify(current) !== JSON.stringify(parameter.default)) errors.push(issue('RECIPE_BINDING_INVALID', path, 'Parameter default must match the input scene property'))
      }
      if (spec.animationTracks?.some(track => track.targetKind === 'material' && track.targetEntityId === binding.materialId &&
        (track.property === binding.property || track.property.startsWith(`${binding.property}.`)))) {
        errors.push(issue('RECIPE_BINDING_INVALID', path, 'A parameter must not compete with animation on the same material property'))
      }
    } else if (spec.renderProfiles?.[binding.profile]?.colorManagement?.exposure !== parameter.default) {
      errors.push(issue('RECIPE_BINDING_INVALID', path, `Profile ${binding.profile} must explicitly declare exposure equal to the parameter default`))
    }
  }
  return errors
}

/** Hash actual loaded bytes; the manifest is a claim, never a verification receipt. */
export function validateRecipePackage(bundle, options = {}) {
  const checked = validateRecipeManifest(bundle?.manifest, options)
  if (!checked.ok) return checked
  const { manifest } = bundle
  const errors = []
  let sceneSpec
  try {
    const sceneBytes = asBytes(bundle.sceneBytes, RECIPE_LIMITS.sceneBytes, 'input')
    const previewBytes = asBytes(bundle.previewBytes, RECIPE_LIMITS.previewBytes, 'preview')
    if (sha256(sceneBytes) !== manifest.input.sha256) errors.push(issue('RECIPE_HASH_MISMATCH', 'input.sha256', 'Loaded SceneSpec bytes differ from the declared hash'))
    if (sha256(previewBytes) !== manifest.preview.sha256) errors.push(issue('RECIPE_HASH_MISMATCH', 'preview.sha256', 'Loaded preview bytes differ from the declared hash'))
    if (errors.length) return result(errors)
    try { validatePreview(previewBytes) } catch (error) { return result([issue('RECIPE_PREVIEW_INVALID', 'preview', error.message)]) }
    try { sceneSpec = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sceneBytes)) }
    catch { return result([issue('RECIPE_INPUT_INVALID', 'input', 'SceneSpec must be valid UTF-8 JSON')]) }
    const scene = validateSceneSpec(sceneSpec)
    if (!scene.ok) return result(scene.errors.map(error => issue('RECIPE_SCENE_INVALID', `input.${error.path}`, error.message)))
    if (sceneSpec.assets?.length || sceneSpec.entities.some(entity => entity.type === 'asset-instance') ||
        sceneSpec.materials?.some(material => material.images) || sceneSpec.world?.environment ||
        sceneSpec.armatures?.length || sceneSpec.simulation ||
        sceneSpec.entities.some(entity => entity.rigidBody || entity.cloth || entity.softBody || entity.fluid || entity.armatureId) ||
        sceneSpec.animationTracks?.some(track => track.targetKind === 'bone')) {
      errors.push(issue('RECIPE_INPUT_UNSUPPORTED', 'input', 'Recipe v1 supports self-contained procedural scenes without files, rigs or simulations'))
    }
    const declared = new Set(manifest.compatibility.capabilities)
    for (const capability of recipeCapabilitiesForScene(sceneSpec)) {
      if (!declared.has(capability)) errors.push(issue('RECIPE_CAPABILITY_UNDECLARED', 'compatibility.capabilities', `Scene uses undeclared capability ${capability}`))
    }
    errors.push(...bindingsAgainstScene(manifest, sceneSpec))
    if (errors.length) return result(errors)
    const compiled = compileSceneSpec(sceneSpec)
    const compiledCheck = validateSceneSpec(compiled.spec)
    if (!compiledCheck.ok) return result(compiledCheck.errors.map(error => issue('RECIPE_SCENE_INVALID', error.path, error.message)))
    return result([], { sceneSpec, notices: [...scene.notices, ...compiled.notices] })
  } catch (error) { return result([issue(error.code ?? 'RECIPE_INPUT_INVALID', 'input', error.message)]) }
}

/** Return a fresh resolved SceneSpec; only explicit scalar/color slots can change. */
export function instantiateRecipe(bundle, values = {}, options = {}) {
  const checked = validateRecipePackage(bundle, options)
  if (!checked.ok) throw new RecipeError(checked.errors[0].code, checked.summary, { errors: checked.errors })
  if (!plain(values)) throw new RecipeError('RECIPE_PARAMETER_INVALID', 'Parameter values must be a plain object')
  const { manifest } = bundle
  const known = new Set(manifest.parameters.map(parameter => parameter.id))
  const errors = Object.keys(values).filter(key => !known.has(key) || RESERVED.has(key))
    .map(key => issue('RECIPE_PARAMETER_UNKNOWN', `values.${key}`, 'Unknown parameter'))
  const resolvedValues = {}
  for (const parameter of manifest.parameters) {
    const value = Object.hasOwn(values, parameter.id) ? values[parameter.id] : parameter.default
    const valueIssue = parameterValueIssue(parameter, value, `values.${parameter.id}`)
    if (valueIssue) errors.push(valueIssue)
    else resolvedValues[parameter.id] = structuredClone(value)
  }
  if (errors.length) throw new RecipeError(errors[0].code, errors.map(error => error.message).join('; '), { errors })
  const spec = structuredClone(checked.sceneSpec)
  for (const parameter of manifest.parameters) for (const binding of parameter.bindings) {
    const value = resolvedValues[parameter.id]
    if (binding.kind === 'material') {
      const material = spec.materials.find(item => item.id === binding.materialId)
      material.parameters[binding.property] = parameter.type === 'color'
        ? [...value, material.parameters.baseColor[3] ?? 1] : value
    } else spec.renderProfiles[binding.profile].colorManagement.exposure = value
  }
  const validation = validateSceneSpec(spec)
  if (!validation.ok) throw new RecipeError('RECIPE_SCENE_INVALID', validation.summary, { errors: validation.errors })
  const compiled = compileSceneSpec(spec)
  const finalCheck = validateSceneSpec(compiled.spec)
  if (!finalCheck.ok) throw new RecipeError('RECIPE_SCENE_INVALID', finalCheck.summary, { errors: finalCheck.errors })
  return { spec: compiled.spec, values: resolvedValues, notices: [...validation.notices, ...compiled.notices],
    recipe: { id: manifest.id, version: manifest.version, manifestSha256: sha256Canonical(manifest),
      inputSha256: manifest.input.sha256, previewSha256: manifest.preview.sha256, valuesSha256: sha256Canonical(resolvedValues) } }
}
