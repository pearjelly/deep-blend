import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sha256, canonicalStringify } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { compileSceneSpec, validateSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'
import { RECIPE_CAPABILITIES, RecipeError, recipeCapabilitiesForScene, validateRecipeManifest, validateRecipePackage, instantiateRecipe } from '../../../packages/deepblend/contracts/lib/recipe.js'

const root = resolve(import.meta.dirname, '../../..')
const recipeRoot = join(root, 'deepblend/recipes')
const names = ['glass-ceramic', 'metal-lamp', 'modular-speaker']
function load(name = 'glass-ceramic') {
  const path = join(recipeRoot, name)
  return { manifest: JSON.parse(readFileSync(join(path, 'recipe.json'))),
    sceneBytes: readFileSync(join(path, 'scene-spec.json')), previewBytes: readFileSync(join(path, 'preview.png')) }
}
function replaceScene(bundle, edit) {
  const spec = JSON.parse(bundle.sceneBytes); edit(spec)
  bundle.sceneBytes = Buffer.from(JSON.stringify(spec))
  bundle.manifest.input.sha256 = sha256(bundle.sceneBytes)
  return bundle
}
const errorCodes = checked => checked.errors.map(error => error.code)
function refused(bundle, code) {
  const checked = validateRecipePackage(bundle)
  assert.equal(checked.ok, false)
  assert.ok(errorCodes(checked).includes(code), checked.summary)
  assert.throws(() => instantiateRecipe(bundle), error => error instanceof RecipeError && error.details.errors.some(issue => issue.code === code))
}

test('three self-contained product recipes have explicit licenses and verifiable PNG/SceneSpec bytes', () => {
  assert.deepEqual(readdirSync(recipeRoot).filter(name => names.includes(name)).sort(), names)
  for (const name of names) {
    const bundle = load(name), checked = validateRecipePackage(bundle)
    assert.equal(checked.ok, true, checked.summary)
    assert.equal(bundle.manifest.license, 'MIT')
    assert.ok(readFileSync(join(recipeRoot, name, 'LICENSE'), 'utf8').includes('MIT License'))
    assert.equal(bundle.manifest.input.sha256, sha256(bundle.sceneBytes))
    assert.equal(bundle.manifest.preview.sha256, sha256(bundle.previewBytes))
    assert.equal(checked.sceneSpec.assets.length, 0)
    let offset = 8
    while (offset < bundle.previewBytes.length) {
      const kind = bundle.previewBytes.toString('ascii', offset + 4, offset + 8)
      assert.ok(!['tEXt', 'iTXt', 'zTXt', 'tIME', 'eXIf'].includes(kind), 'Published previews must not carry local paths/time metadata')
      offset += 12 + bundle.previewBytes.readUInt32BE(offset)
    }
  }
})

test('schema mirror is byte identical and parameter surface is finite', () => {
  assert.equal(readFileSync(join(root, 'deepblend/schemas/recipe.schema.json'), 'utf8'),
    readFileSync(join(root, 'packages/deepblend/contracts/lib/schemas/recipe.schema.json'), 'utf8'))
  const schema = JSON.parse(readFileSync(join(root, 'deepblend/schemas/recipe.schema.json')))
  assert.equal(schema.properties.parameters.maxItems, 8)
  assert.equal(schema.additionalProperties, false)
})

test('defaults instantiate exactly the public compiled input, with deterministic provenance and no mutations', () => {
  for (const name of names) {
    const bundle = load(name), original = canonicalStringify(bundle.manifest), bytes = Buffer.from(bundle.sceneBytes)
    const first = instantiateRecipe(bundle), second = instantiateRecipe(bundle)
    assert.deepEqual(first, second)
    assert.deepEqual(first.spec, compileSceneSpec(JSON.parse(bundle.sceneBytes)).spec)
    assert.equal(validateSceneSpec(first.spec).ok, true)
    assert.equal(canonicalStringify(bundle.manifest), original)
    assert.deepEqual(bundle.sceneBytes, bytes)
    assert.match(first.recipe.manifestSha256, /^[a-f0-9]{64}$/)
    assert.equal(first.recipe.id, bundle.manifest.id)
    assert.equal(first.recipe.version, '1.0.0')
    assert.equal(first.recipe.inputSha256, sha256(bundle.sceneBytes))
  }
})

test('color/roughness/exposure alter only allowed slots, preserve alpha and geometry, and apply exposure to both profiles', () => {
  const bundle = load(), base = instantiateRecipe(bundle), materialId = bundle.manifest.parameters[0].bindings[0].materialId
  const values = { 'main-color': [0.3, 0.1, 0.2], 'surface-roughness': 0.35, exposure: 0.5 }
  const edited = instantiateRecipe(bundle, values)
  assert.deepEqual(edited.spec.entities, base.spec.entities)
  assert.deepEqual(edited.spec.cameras, base.spec.cameras)
  assert.deepEqual(edited.spec.lights, base.spec.lights)
  assert.deepEqual(edited.spec.animationTracks, base.spec.animationTracks)
  assert.deepEqual(edited.spec.materials.find(material => material.id === materialId).parameters.baseColor, [0.3, 0.1, 0.2, 1])
  assert.equal(edited.spec.materials.find(material => material.id === materialId).parameters.roughness, 0.35)
  for (const material of base.spec.materials.filter(material => material.id !== materialId)) assert.deepEqual(edited.spec.materials.find(item => item.id === material.id), material)
  for (const profile of ['preview', 'final']) assert.equal(edited.spec.renderProfiles[profile].colorManagement.exposure, 0.5)
  assert.deepEqual(values, { 'main-color': [0.3, 0.1, 0.2], 'surface-roughness': 0.35, exposure: 0.5 })
  assert.notEqual(edited.recipe.valuesSha256, base.recipe.valuesSha256)
  const alpha = replaceScene(load(), spec => { spec.materials.find(material => material.id === materialId).parameters.baseColor[3] = 0.4 })
  assert.equal(instantiateRecipe(alpha, values).spec.materials.find(material => material.id === materialId).parameters.baseColor[3], 0.4)
})

test('lamp main finish parameters stay synchronized across spun and brushed parts while preserving anisotropy', () => {
  const bundle = load('metal-lamp'), base = instantiateRecipe(bundle)
  assert.ok(bundle.manifest.compatibility.capabilities.includes('material.anisotropy'))
  const edited = instantiateRecipe(bundle, { 'main-color': [0.25, 0.3, 0.4], 'surface-roughness': 0.45 })
  for (const id of ['champagne-spun', 'champagne-brushed']) {
    const before = base.spec.materials.find(material => material.id === id)
    const after = edited.spec.materials.find(material => material.id === id)
    assert.deepEqual(after, { ...before, parameters: { ...before.parameters, baseColor: [0.25, 0.3, 0.4, 1], roughness: 0.45 } })
  }
  assert.deepEqual(edited.spec.entities, base.spec.entities)
  assert.equal(edited.spec.materials.find(material => material.id === 'champagne-spun').parameters.anisotropic, 0.55)
  assert.deepEqual(edited.spec.materials.find(material => material.id === 'champagne-spun').tangent, { mode: 'radial', axis: 'z' })
  for (const material of base.spec.materials.filter(material => !['champagne-spun', 'champagne-brushed'].includes(material.id))) {
    assert.deepEqual(edited.spec.materials.find(item => item.id === material.id), material)
  }
})

test('actual changed bytes fail even when author-provided filenames and hashes look plausible', () => {
  const scene = load(); scene.sceneBytes = Buffer.concat([scene.sceneBytes, Buffer.from(' ')])
  refused(scene, 'RECIPE_HASH_MISMATCH')
  const image = load(); image.previewBytes[image.previewBytes.length - 1] ^= 1
  refused(image, 'RECIPE_HASH_MISMATCH')
})

test('a newly hashed malformed scene or SVG masquerading as a PNG is still refused', () => {
  const bundle = load(); bundle.sceneBytes = Buffer.from('{broken')
  bundle.manifest.input.sha256 = sha256(bundle.sceneBytes)
  refused(bundle, 'RECIPE_INPUT_INVALID')
  const image = load(); image.previewBytes = Buffer.from('<svg onload="alert(1)"></svg>')
  image.manifest.preview.sha256 = sha256(image.previewBytes)
  refused(image, 'RECIPE_PREVIEW_INVALID')
  const checksum = load(); checksum.previewBytes[checksum.previewBytes.length - 1] ^= 1
  checksum.manifest.preview.sha256 = sha256(checksum.previewBytes)
  refused(checksum, 'RECIPE_PREVIEW_INVALID')
})

test('preview header cannot request an unbounded decode allocation', () => {
  const bundle = load(); bundle.previewBytes.writeUInt32BE(0x7fffffff, 16)
  // Keep the IHDR checksum valid so the test reaches the decompression bound.
  let crc = 0xffffffff
  for (let index = 12; index < 29; index++) {
    crc ^= bundle.previewBytes[index]
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  bundle.previewBytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29)
  bundle.manifest.preview.sha256 = sha256(bundle.previewBytes)
  refused(bundle, 'RECIPE_PREVIEW_INVALID')
  assert.match(validateRecipePackage(bundle).summary, /pixel limit/)
})

test('missing or blank licenses are refused rather than defaulted', () => {
  for (const value of [undefined, '', '   ']) {
    const bundle = load()
    if (value === undefined) delete bundle.manifest.license
    else bundle.manifest.license = value
    refused(bundle, 'RECIPE_MANIFEST_INVALID')
  }
})

test('paths are literal package members: traversal, absolute, URLs, and executable entries are refused', () => {
  for (const path of ['../scene-spec.json', '/tmp/scene-spec.json', 'https://example.com/scene.json', 'build.mjs']) {
    const bundle = load(); bundle.manifest.input.path = path
    refused(bundle, 'RECIPE_MANIFEST_INVALID')
  }
  const bundle = load(); bundle.manifest.preview.path = '../private.png'
  refused(bundle, 'RECIPE_MANIFEST_INVALID')
  const executable = load(); executable.manifest.script = 'build.mjs'
  refused(executable, 'RECIPE_MANIFEST_INVALID')
})

test('source references have no executable URL schemes or embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.com/x']) {
    const manifest = load().manifest; manifest.source.url = url
    assert.equal(validateRecipeManifest(manifest).ok, false)
  }
})

test('unsupported capabilities and omitted actual capabilities are separate clear errors', () => {
  const bundle = load()
  assert.ok(errorCodes(validateRecipePackage(bundle, { supportedCapabilities: RECIPE_CAPABILITIES.filter(item => item !== 'material.glass') })).includes('RECIPE_INCOMPATIBLE'))
  bundle.manifest.compatibility.capabilities = bundle.manifest.compatibility.capabilities.filter(item => item !== 'material.glass')
  refused(bundle, 'RECIPE_CAPABILITY_UNDECLARED')
  const unknown = load(); unknown.manifest.compatibility.capabilities.push('python.execute')
  refused(unknown, 'RECIPE_MANIFEST_INVALID')
})

test('a valid recipe can combine every supported capability', () => {
  const bundle = replaceScene(load('metal-lamp'), spec => {
    spec.materials.push(
      { id: 'combined-glass', shader: 'glass', parameters: { baseColor: [1, 1, 1, 1], roughness: 0.1, ior: 1.45 } },
      { id: 'combined-emission', shader: 'emission', parameters: { emissionColor: [1, 0.5, 0.1, 1], emissionStrength: 1 } },
    )
    spec.entities.push({id:'combined-handled-cup',type:'generator',generator:{shape:'handled_cup'},materialId:spec.materials[0].id})
    const geometry = spec.entities.find(entity => entity.type === 'generator')
    for (const id of ['combined-glass', 'combined-emission']) {
      spec.entities.push({ ...structuredClone(geometry), id, materialId: id })
    }
    spec.animationTracks.push({ id: 'combined-emission-animation', targetKind: 'material', targetEntityId: 'combined-emission',
      property: 'emissionStrength', keyframes: [{ frame: 1, value: 1 }, { frame: 48, value: 2 }] })
  })
  const spec = JSON.parse(bundle.sceneBytes)
  assert.equal(validateSceneSpec(spec).ok, true)
  bundle.manifest.compatibility.capabilities = recipeCapabilitiesForScene(spec)
  assert.deepEqual(bundle.manifest.compatibility.capabilities, [...RECIPE_CAPABILITIES].sort())
  const checked = validateRecipePackage(bundle)
  assert.equal(checked.ok, true, checked.summary)
  assert.deepEqual(checked.notices, [])
  const instantiated = instantiateRecipe(bundle)
  assert.equal(validateSceneSpec(instantiated.spec).ok, true)
  assert.deepEqual(instantiated.notices, [])
  assert.deepEqual(instantiated.spec, compileSceneSpec(spec).spec)
})

test('anisotropy and its animation require their own declared capability without adding editable parameter slots', () => {
  const bundle = replaceScene(load(), spec => {
    const material = spec.materials.find(item => item.id === 'celadon-glaze')
    material.parameters.anisotropic = 0.35
    material.tangent = { mode: 'radial', axis: 'z' }
  })
  assert.ok(recipeCapabilitiesForScene(JSON.parse(bundle.sceneBytes)).includes('material.anisotropy'))
  refused(bundle, 'RECIPE_CAPABILITY_UNDECLARED')
  bundle.manifest.compatibility.capabilities.push('material.anisotropy')
  assert.equal(validateRecipePackage(bundle).ok, true)
  assert.ok(errorCodes(validateRecipePackage(bundle, { supportedCapabilities: RECIPE_CAPABILITIES.filter(item => item !== 'material.anisotropy') })).includes('RECIPE_INCOMPATIBLE'))
  assert.equal(instantiateRecipe(bundle).spec.materials.find(item => item.id === 'celadon-glaze').parameters.anisotropic, 0.35)

  const animated = replaceScene(bundle, spec => {
    delete spec.materials.find(item => item.id === 'celadon-glaze').parameters.anisotropic
    spec.animationTracks.push({ id: 'glaze-brushing', targetKind: 'material', targetEntityId: 'celadon-glaze', property: 'anisotropic',
      keyframes: [{ frame: 1, value: 0 }, { frame: 48, value: 0.3 }] })
  })
  animated.manifest.compatibility.capabilities.push('animation.material')
  assert.equal(validateRecipePackage(animated).ok, true)
  animated.manifest.compatibility.capabilities = animated.manifest.compatibility.capabilities.filter(item => item !== 'material.anisotropy')
  refused(animated, 'RECIPE_CAPABILITY_UNDECLARED')
  // A zero-valued track still declares a newer material property to the runtime.
  assert.ok(recipeCapabilitiesForScene({ animationTracks: [{ targetKind: 'material', property: 'anisotropicRotation' }] }).includes('material.anisotropy'))

  const binding = load(); binding.manifest.parameters[1].bindings[0].property = 'anisotropic'
  refused(binding, 'RECIPE_MANIFEST_INVALID')
})

test('unknown parameters, invalid types, NaN, Infinity and out-of-range values cannot be silently coerced', () => {
  for (const values of [{ geometry: 'cube' }, { exposure: 1.01 }, { exposure: NaN }, { exposure: Infinity }, { exposure: '0' },
    { 'main-color': [1, 0, 0, 0.5] }, { 'main-color': [-0.1, 0, 0] }, { 'main-color': '#ff0000' }, { 'main-color': new Array(3) },
    JSON.parse('{"__proto__":{"polluted":true}}'), null, [], Object.create({ exposure: 0.5 })]) {
    assert.throws(() => instantiateRecipe(load(), values), error => error instanceof RecipeError && error.code.startsWith('RECIPE_PARAMETER_'))
  }
  assert.equal({}.polluted, undefined)
})

test('arbitrary JSON pointers, transform bindings and shader parameters are not extension hooks', () => {
  for (const binding of [{ path: '/entities/0/transform/scale', value: [5, 5, 5] },
    { kind: 'entity', entityId: 'bottle', property: 'scale' },
    { kind: 'material', materialId: 'clear-glass', property: 'transmissionWeight' }]) {
    const bundle = load(); bundle.manifest.parameters[0].bindings = [binding]
    refused(bundle, 'RECIPE_MANIFEST_INVALID')
  }
})

test('dangling, duplicate, mismatched and competing bindings fail before instantiation', () => {
  const missing = load(); missing.manifest.parameters[0].bindings[0].materialId = 'missing'
  refused(missing, 'RECIPE_BINDING_INVALID')
  const duplicate = load(); duplicate.manifest.parameters[0].bindings.push(duplicate.manifest.parameters[0].bindings[0])
  refused(duplicate, 'RECIPE_BINDING_INVALID')
  const mismatch = load(); mismatch.manifest.parameters[0].bindings[0].property = 'roughness'
  refused(mismatch, 'RECIPE_BINDING_INVALID')
  const animation = replaceScene(load(), spec => spec.animationTracks.push({ id: 'glaze-roughness', targetKind: 'material', targetEntityId: 'celadon-glaze', property: 'roughness', keyframes: [{ frame: 1, value: 0.2 }, { frame: 48, value: 0.3 }] }))
  animation.manifest.compatibility.capabilities.push('animation.material')
  refused(animation, 'RECIPE_BINDING_INVALID')
})

test('defaults must match the preview input; widened unsafe property ranges are rejected', () => {
  const defaults = load(); defaults.manifest.parameters[0].default = [0.1, 0.2, 0.3]
  refused(defaults, 'RECIPE_BINDING_INVALID')
  const range = load(); range.manifest.parameters[1].maximum = 3
  refused(range, 'RECIPE_BINDING_INVALID')
  const inverted = load(); inverted.manifest.parameters[1].minimum = 0.8
  refused(inverted, 'RECIPE_PARAMETER_INVALID')
})

test('parameter IDs must be unique, and reserved keys cannot become output object properties', () => {
  const duplicate = load(); duplicate.manifest.parameters.push(structuredClone(duplicate.manifest.parameters[0]))
  refused(duplicate, 'RECIPE_PARAMETER_INVALID')
  const reserved = load(); reserved.manifest.parameters[0].id = 'constructor'
  refused(reserved, 'RECIPE_PARAMETER_INVALID')
})

test('assets and physics require a future recipe contract, even when they are valid SceneSpec', () => {
  const assets = replaceScene(load(), spec => spec.assets.push({ id: 'external', type: 'glb', path: 'asset.glb' }))
  refused(assets, 'RECIPE_INPUT_UNSUPPORTED')
  const simulation = replaceScene(load(), spec => { spec.simulation = { bake: false } })
  refused(simulation, 'RECIPE_INPUT_UNSUPPORTED')
})

test('invalid SceneSpec and missing content return structured errors without Blender', () => {
  const invalid = replaceScene(load(), spec => { spec.entities[0].materialId = 'missing' })
  refused(invalid, 'RECIPE_SCENE_INVALID')
  const missing = load(); delete missing.previewBytes
  refused(missing, 'RECIPE_INPUT_INVALID')
  assert.equal(validateRecipePackage(undefined).ok, false)
})
