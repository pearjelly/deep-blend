import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import {tmpdir} from 'node:os'
import { join, resolve } from 'node:path'
import {execFileSync} from 'node:child_process'
import { sha256, canonicalStringify } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { compileSceneSpec, validateSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'
import {decodePng} from '../../../packages/deepblend/contracts/lib/png.js'
import { RECIPE_CAPABILITIES, RecipeError, recipeCapabilitiesForScene, validateRecipeManifest, validateRecipePackage, instantiateRecipe } from '../../../packages/deepblend/contracts/lib/recipe.js'

const root = resolve(import.meta.dirname, '../../..')
const recipeRoot = join(root, 'deepblend/recipes')
const names = ['glass-ceramic', 'glazed-cup', 'metal-lamp', 'modular-speaker']
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

test('four self-contained product recipes have explicit licenses and verifiable PNG/SceneSpec bytes', () => {
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
    assert.equal(first.recipe.version, name==='glazed-cup' ? '3.0.0' : name==='metal-lamp' ? '2.0.0' : '1.0.0')
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

test('lamp color stays synchronized while independent finish controls preserve texture and anisotropy', () => {
  const bundle = load('metal-lamp'), base = instantiateRecipe(bundle)
  assert.ok(bundle.manifest.compatibility.capabilities.includes('material.anisotropy'))
  const edited = instantiateRecipe(bundle, { 'main-color': [0.25, 0.3, 0.4], 'spun-roughness': 0.31, 'brushed-roughness': 0.45 })
  for (const id of ['champagne-spun', 'champagne-brushed']) {
    const before = base.spec.materials.find(material => material.id === id)
    const after = edited.spec.materials.find(material => material.id === id)
    assert.deepEqual(after, { ...before, parameters: { ...before.parameters, baseColor: [0.25, 0.3, 0.4, 1], roughness: id === 'champagne-spun' ? 0.31 : 0.45 } })
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
    spec.entities.push({id:'combined-handled-cup',type:'generator',generator:{shape:'handled_cup',rootTension:2.5},materialId:spec.materials[0].id})
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

const historicalLamp = () => { const directory=join(root,'deepblend/tests/fixtures/metal-lamp-v1');return {manifest:JSON.parse(readFileSync(join(directory,'recipe.json'))),sceneBytes:readFileSync(join(directory,'scene-spec.json')),previewBytes:readFileSync(join(directory,'preview.png'))} }

test('lamp v2 preserves native benchmark defaults, UV grain and exact preview pixels with reproducible packaging', () => {
  const bundle=load('metal-lamp'),instance=instantiateRecipe(bundle),mat=id=>instance.spec.materials.find(m=>m.id===id)
  assert.equal(bundle.manifest.version,'2.0.0')
  assert.deepEqual(bundle.manifest.parameters.map(p=>p.id),['main-color','spun-roughness','brushed-roughness','exposure'])
  assert.equal(mat('champagne-spun').parameters.roughness,.28);assert.equal(mat('champagne-brushed').parameters.roughness,.39)
  assert.deepEqual(mat('champagne-spun').texture,{type:'noise',coordinates:'uv',uvMap:'UVMap',scale:1,detail:2,stretch:[.0001,800,1],bump:.006,roughnessVariation:.035,colorVariation:.012})
  assert.deepEqual(bundle.sceneBytes,readFileSync(join(root,'deepblend/benchmarks/metal-lamp/scene-spec.json')))
  const native=readFileSync(join(root,'deepblend/benchmarks/previews/metal-lamp-hero.png'))
  assert.deepEqual(decodePng(bundle.previewBytes),decodePng(native),'Metadata removal must preserve every decoded pixel')
  const imageChunks=bytes=>{const chunks=[];for(let offset=8;offset<bytes.length;){const end=offset+12+bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);if(['IHDR','IDAT','IEND'].includes(kind))chunks.push(bytes.subarray(offset,end));offset=end}return Buffer.concat(chunks)}
  assert.deepEqual(imageChunks(bundle.previewBytes),imageChunks(native),'Encoded image chunks must remain byte-identical')
  assert.equal(sha256(canonicalStringify(JSON.parse(bundle.sceneBytes))),JSON.parse(readFileSync(join(root,'deepblend/benchmarks/previews/manifest.json'))).images.find(p=>p.caseId==='metal-lamp').candidateInputSha256)
  assert.match(execFileSync(process.execPath,[join(root,'deepblend/tools/build-metal-lamp-recipe.mjs'),'--check'],{encoding:'utf8'}),/2\.0\.0 verified/)
})

test('lamp builder refuses changed source or native image before packaging unverified content', t => {
  const temporary=mkdtempSync(join(tmpdir(),'deepblend-lamp-source-'));t.after(()=>rmSync(temporary,{recursive:true,force:true}))
  for(const directory of ['deepblend/tools','deepblend/benchmarks','deepblend/recipes','packages/deepblend/contracts'])mkdirSync(join(temporary,directory),{recursive:true})
  cpSync(join(root,'packages/deepblend/contracts/lib'),join(temporary,'packages/deepblend/contracts/lib'),{recursive:true})
  cpSync(join(root,'packages/deepblend/contracts/package.json'),join(temporary,'packages/deepblend/contracts/package.json'))
  for(const name of ['metal-lamp','previews'])cpSync(join(root,'deepblend/benchmarks',name),join(temporary,'deepblend/benchmarks',name),{recursive:true})
  cpSync(join(root,'deepblend/recipes/metal-lamp'),join(temporary,'deepblend/recipes/metal-lamp'),{recursive:true})
  const tool=join(temporary,'deepblend/tools/build-metal-lamp-recipe.mjs');cpSync(join(root,'deepblend/tools/build-metal-lamp-recipe.mjs'),tool)
  const run=()=>execFileSync(process.execPath,[tool,'--check'],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
  assert.match(run(),/2\.0\.0 verified/)
  const input=join(temporary,'deepblend/benchmarks/metal-lamp/scene-spec.json'),before=readFileSync(input),scene=JSON.parse(before)
  scene.materials.find(m=>m.id==='champagne-spun').parameters.roughness=.33;writeFileSync(input,JSON.stringify(scene))
  assert.throws(run,error=>error.status===1&&String(error.stderr).includes('Benchmark source changed'))
  writeFileSync(input,before)
  const image=join(temporary,'deepblend/benchmarks/previews/metal-lamp-hero.png'),pixels=readFileSync(image);pixels[pixels.length-1]^=1;writeFileSync(image,pixels)
  assert.throws(run,error=>error.status===1&&String(error.stderr).includes('Native benchmark preview bytes changed'))
})

test('each lamp v2 roughness control changes only its intended finish and preserves the other default', () => {
  const bundle=load('metal-lamp'),base=instantiateRecipe(bundle)
  for(const [key,id]of[['spun-roughness','champagne-spun'],['brushed-roughness','champagne-brushed']]){
    const after=instantiateRecipe(bundle,{[key]:.46})
    const expected=structuredClone(base.spec);expected.materials.find(m=>m.id===id).parameters.roughness=.46
    assert.deepEqual(after.spec,expected)
  }
  assert.throws(()=>instantiateRecipe(bundle,{'surface-roughness':.39}),{code:'RECIPE_PARAMETER_UNKNOWN'})
})

test('historical lamp v1 source identity, coupled roughness semantics and Object grain remain usable', () => {
  const bundle=historicalLamp();assert.equal(bundle.manifest.version,'1.0.0')
  assert.equal(sha256(bundle.sceneBytes),'6896f467a2bea311f14435c5fd755a021867c686262ea71cac80d4198694d75d')
  assert.equal(sha256(bundle.previewBytes),'e961539a4d22bb78232569c38f66ee51b8ed5d5e352655f35bc4a2adaa9a69f6')
  assert.equal(validateRecipePackage(bundle).ok,true)
  const result=instantiateRecipe(bundle,{'surface-roughness':.45})
  for(const id of ['champagne-spun','champagne-brushed'])assert.equal(result.spec.materials.find(m=>m.id===id).parameters.roughness,.45)
  assert.equal(result.spec.materials.find(m=>m.id==='champagne-spun').texture.coordinates,undefined)
  assert.equal(result.recipe.version,'1.0.0')
})

test('UV recipe capability distinguishes Object surfaces and refuses consumers lacking UV support', () => {
  const bundle=load('metal-lamp'),old=historicalLamp(),withoutUv=RECIPE_CAPABILITIES.filter(c=>c!=='material.procedural.uv')
  assert(RECIPE_CAPABILITIES.includes('material.procedural.uv'))
  assert(recipeCapabilitiesForScene(JSON.parse(bundle.sceneBytes)).includes('material.procedural.uv'))
  assert.equal(recipeCapabilitiesForScene(JSON.parse(old.sceneBytes)).includes('material.procedural.uv'),false)
  assert.equal(validateRecipePackage(old,{supportedCapabilities:withoutUv}).ok,true)
  assert(errorCodes(validateRecipePackage(bundle,{supportedCapabilities:withoutUv})).includes('RECIPE_INCOMPATIBLE'))
  bundle.manifest.compatibility.capabilities=bundle.manifest.compatibility.capabilities.filter(c=>c!=='material.procedural.uv')
  refused(bundle,'RECIPE_CAPABILITY_UNDECLARED')
  const schema=JSON.parse(readFileSync(join(root,'deepblend/schemas/recipe.schema.json')))
  assert.equal(schema.properties.compatibility.properties.capabilities.maxItems,RECIPE_CAPABILITIES.length)
})

test('cup transition capability describes actual shape use and refuses unsupported authors', () => {
  const bundle=load('glazed-cup'),without=RECIPE_CAPABILITIES.filter(c=>c!=='geometry.handled_cup.tension')
  assert(RECIPE_CAPABILITIES.includes('geometry.handled_cup.tension'))
  replaceScene(bundle,spec=>{spec.entities.find(e=>e.id==='cup').generator.rootTension=1.5})
  bundle.manifest.compatibility.capabilities=recipeCapabilitiesForScene(JSON.parse(bundle.sceneBytes))
  assert.equal(validateRecipePackage(bundle).ok,true)
  assert.equal(validateRecipePackage(bundle,{supportedCapabilities:without}).ok,false)
  assert.throws(()=>instantiateRecipe(bundle,{}, {supportedCapabilities:without}),RecipeError)
  bundle.manifest.compatibility.capabilities=without.filter(c=>bundle.manifest.compatibility.capabilities.includes(c))
  refused(bundle,'RECIPE_CAPABILITY_UNDECLARED')
  const oldPath=join(root,'deepblend/tests/fixtures/glazed-cup-v1'),old={manifest:JSON.parse(readFileSync(join(oldPath,'recipe.json'))),sceneBytes:readFileSync(join(oldPath,'scene-spec.json')),previewBytes:readFileSync(join(oldPath,'preview.png'))}
  assert.equal(old.manifest.version,'1.0.0');assert.equal(validateRecipePackage(old,{supportedCapabilities:without}).ok,true)
  assert.equal(recipeCapabilitiesForScene(JSON.parse(old.sceneBytes)).includes('geometry.handled_cup.tension'),false)
  assert.equal(instantiateRecipe(old).spec.entities.find(e=>e.id==='cup').generator.rootTension,1)
  const schema=JSON.parse(readFileSync(join(root,'deepblend/schemas/recipe.schema.json'))),caps=schema.properties.compatibility.properties.capabilities
  assert.equal(caps.maxItems,caps.items.enum.length)
})

test('extended cup transitions require support and declaration beyond the original tension capability', () => {
  const bundle=load('glazed-cup'), supported=RECIPE_CAPABILITIES.filter(c=>c!=='geometry.handled_cup.tension.extended')
  assert.equal(bundle.manifest.version,'3.0.0')
  assert.equal(instantiateRecipe(bundle).spec.entities.find(e=>e.id==='cup').generator.rootTension,2.5)
  assert.equal(validateRecipePackage(bundle).ok,true)
  assert.equal(validateRecipePackage(bundle,{supportedCapabilities:supported}).ok,false)
  assert.throws(()=>instantiateRecipe(bundle,{}, {supportedCapabilities:supported}),RecipeError)
  bundle.manifest.compatibility.capabilities=bundle.manifest.compatibility.capabilities.filter(c=>c!=='geometry.handled_cup.tension.extended')
  refused(bundle,'RECIPE_CAPABILITY_UNDECLARED')
  for(const tension of [1,1.5,1.5001,2.5]){
    const source=JSON.parse(bundle.sceneBytes);source.entities.find(e=>e.id==='cup').generator.rootTension=tension
    assert.equal(recipeCapabilitiesForScene(source).includes('geometry.handled_cup.tension.extended'),tension>1.5)
  }
})

test('historical cup v2 retains its accepted input, preview and 1.5 transition on older consumers', () => {
  const directory=join(root,'deepblend/tests/fixtures/glazed-cup-v2'), old={manifest:JSON.parse(readFileSync(join(directory,'recipe.json'))),sceneBytes:readFileSync(join(directory,'scene-spec.json')),previewBytes:readFileSync(join(directory,'preview.png'))}
  const supported=RECIPE_CAPABILITIES.filter(c=>c!=='geometry.handled_cup.tension.extended')
  assert.equal(old.manifest.version,'2.0.0')
  assert.equal(sha256(old.sceneBytes),'7bf69996931787262aa7a1155d80149c8e2e2ee7041fd771884070c032ef80ca')
  assert.equal(sha256(old.previewBytes),'ce84a64b8bb3314c83b84f2f96c907fca7ee74cc24ad425c52df6cd915af197f')
  assert.equal(validateRecipePackage(old,{supportedCapabilities:supported}).ok,true)
  assert.equal(instantiateRecipe(old,{}, {supportedCapabilities:supported}).spec.entities.find(e=>e.id==='cup').generator.rootTension,1.5)
  assert.equal(recipeCapabilitiesForScene(JSON.parse(old.sceneBytes)).includes('geometry.handled_cup.tension.extended'),false)
})
