import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sha256 } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'
import { instantiateRecipe, validateRecipePackage, RECIPE_CAPABILITIES } from '../../../packages/deepblend/contracts/lib/recipe.js'

function bundle() {
  const directory = new URL('../fixtures/modular-speaker-v1/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('recipe.json', directory)))
  const scene = JSON.parse(readFileSync(new URL('scene-spec.json', directory)))
  const shell = scene.entities.find(entity => entity.id === 'cabinet-shell')
  shell.generator.dimensions = [.264, .138, .162]; delete shell.generator.size
  shell.transform.scale = [1, 1, 1]
  manifest.compatibility.capabilities.push('geometry.primitive.dimensions', 'recipe.geometry-bindings')
  manifest.parameters.push({ id: 'width', title: 'Width', type: 'number', default: .264, minimum: .264, maximum: .34,
    bindings: [
      { kind: 'entity', entityId: shell.id, property: 'dimensions', axis: 'x', multiplier: 1 },
      { kind: 'entity', entityId: 'front-opening-tool', property: 'location', axis: 'x', multiplier: -.5 },
    ] })
  const sceneBytes = Buffer.from(JSON.stringify(scene)); manifest.input.sha256 = sha256(sceneBytes)
  return { manifest, sceneBytes, previewBytes: readFileSync(new URL('preview.png', directory)) }
}
const checked = value => validateRecipePackage(value)
const refused = (value, code = 'RECIPE_BINDING_INVALID') => {
  const result = checked(value); assert.equal(result.ok, false); assert.ok(result.errors.some(issue => issue.code === code), result.summary)
  assert.throws(() => instantiateRecipe(value))
}

test('linked dimensions and positions resolve deterministically from an unchanged input; defaults remain exact', () => {
  const value = bundle(), before = JSON.stringify(value), source = JSON.parse(value.sceneBytes)
  assert.equal(checked(value).ok, true, checked(value).summary)
  assert.deepEqual(instantiateRecipe(value).spec, compileSceneSpec(source).spec)
  const result = instantiateRecipe(value, { width: .3 })
  const expected = structuredClone(source)
  expected.entities.find(e => e.id === 'cabinet-shell').generator.dimensions[0] = .3
  expected.entities.find(e => e.id === 'front-opening-tool').transform.location[0] = (.3 - .264) * -.5
  assert.deepEqual(result.spec, compileSceneSpec(expected).spec)
  assert.deepEqual(result, instantiateRecipe(value, { width: .3 }))
  assert.equal(JSON.stringify(value), before)
})

test('geometry bindings require explicit declaration and consumer support', () => {
  const value = bundle()
  value.manifest.compatibility.capabilities = value.manifest.compatibility.capabilities.filter(c => c !== 'recipe.geometry-bindings')
  refused(value, 'RECIPE_CAPABILITY_UNDECLARED')
  const supportedCapabilities = RECIPE_CAPABILITIES.filter(c => c !== 'recipe.geometry-bindings')
  assert.equal(checked(bundle()).ok, true)
  assert.equal(validateRecipePackage(bundle(), { supportedCapabilities }).ok, false)
  assert.throws(() => instantiateRecipe(bundle(), {}, { supportedCapabilities }))
})

test('invalid targets, duplicate slots, animated locations and nonpositive range endpoints are refused', () => {
  for (const edit of [
    b => { b.entityId = 'missing' },
    b => { b.entityId = 'driver-cone' },
    b => { b.multiplier = 0 },
    b => { b.multiplier = -100 },
    b => { b.multiplier = Infinity },
    b => { b.property = 'scale' },
    b => { b.axis = '__proto__' },
    b => { b.offset = 1 },
  ]) {
    const value = bundle(); edit(value.manifest.parameters.at(-1).bindings[0]); assert.equal(checked(value).ok, false)
    assert.throws(() => instantiateRecipe(value))
  }
  const duplicate = bundle(); duplicate.manifest.parameters.at(-1).bindings.push(structuredClone(duplicate.manifest.parameters.at(-1).bindings[0])); refused(duplicate)
  const animated = bundle(); Object.assign(animated.manifest.parameters.at(-1).bindings[0], { entityId: 'top-button', property: 'location', axis: 'z' }); refused(animated)
  const color = bundle(); color.manifest.parameters[0].bindings.push(structuredClone(color.manifest.parameters.at(-1).bindings[0])); refused(color)
})

test('out-of-range edits fail before mutation and do not weaken existing material bindings', () => {
  const value = bundle(), original = Buffer.from(value.sceneBytes)
  for (const width of [.2, .35, NaN, Infinity, '0.3']) assert.throws(() => instantiateRecipe(value, { width }))
  const changed = instantiateRecipe(value, { width: .3, 'surface-roughness': .4 })
  const materialId = value.manifest.parameters.find(p => p.id === 'surface-roughness').bindings[0].materialId
  assert.equal(changed.spec.materials.find(m => m.id === materialId).parameters.roughness, .4)
  assert.deepEqual(value.sceneBytes, original)
})

test('an explicit animated location offset preserves the press trajectory and unrelated keyframes', () => {
  const value = bundle(), binding = value.manifest.parameters.at(-1).bindings[0]
  Object.assign(binding, { entityId: 'top-button', property: 'location', axis: 'z', offsetAnimation: true })
  assert.equal(checked(value).ok, true, checked(value).summary)
  const original = instantiateRecipe(value), changed = instantiateRecipe(value, { width: .3 })
  const delta = .3 - .264
  const oldTrack = original.spec.animationTracks.find(t => t.id === 'button-press')
  const newTrack = changed.spec.animationTracks.find(t => t.id === 'button-press')
  assert.deepEqual(newTrack, { ...oldTrack, keyframes: oldTrack.keyframes.map(k => ({ ...k, value: k.value + delta })) })
  assert.equal(changed.spec.entities.find(e => e.id === 'top-button').transform.location[2], original.spec.entities.find(e => e.id === 'top-button').transform.location[2] + delta)
  assert.ok(Math.abs((newTrack.keyframes[0].value - newTrack.keyframes[1].value) - .0007) < 1e-12)
  const bad = bundle(); bad.manifest.parameters.at(-1).bindings[0].offsetAnimation = true; refused(bad)
})

test('explicit camera coordinates follow a parameter while target conflicts, animation and duplicates are refused', () => {
  const value = bundle(), parameter = value.manifest.parameters.at(-1)
  parameter.bindings.push({ kind: 'camera', cameraId: 'hero', property: 'location', axis: 'x', multiplier: 2 })
  parameter.bindings.push({ kind: 'camera', cameraId: 'hero', property: 'targetPoint', axis: 'z', multiplier: .5 })
  const original = instantiateRecipe(value), changed = instantiateRecipe(value, { width: .3 })
  assert.equal(changed.spec.cameras[0].transform.location[0], original.spec.cameras[0].transform.location[0] + (.3 - .264) * 2)
  assert.equal(changed.spec.cameras[0].targetPoint[2], original.spec.cameras[0].targetPoint[2] + (.3 - .264) * .5)
  for (const edit of [
    v => { v.manifest.parameters.at(-1).bindings.at(-1).cameraId = 'missing' },
    v => { v.manifest.parameters.at(-1).bindings.push(structuredClone(v.manifest.parameters.at(-1).bindings.at(-1))) },
    v => { v.manifest.parameters.at(-1).bindings.at(-1).offsetAnimation = true },
  ]) { const bad = { ...value, manifest: structuredClone(value.manifest) }; edit(bad); assert.equal(checked(bad).ok, false); assert.throws(() => instantiateRecipe(bad)) }
  const animated = { ...value, manifest: structuredClone(value.manifest) }
  const scene = JSON.parse(animated.sceneBytes)
  scene.animationTracks.push({ id: 'animated-camera', targetKind: 'camera', targetEntityId: 'hero', property: 'location.x', keyframes: [{ frame: 1, value: .37 }, { frame: 48, value: .4 }] })
  animated.sceneBytes = Buffer.from(JSON.stringify(scene)); animated.manifest.input.sha256 = sha256(animated.sceneBytes)
  refused(animated)
  const overflowing = bundle()
  for (const id of ['camera-growth-a', 'camera-growth-b']) overflowing.manifest.parameters.push({ id, title: id,
    type: 'number', default: 0, minimum: 0, maximum: 1e308,
    bindings: [{ kind: 'camera', cameraId: 'hero', property: 'location', axis: 'x', multiplier: 1 }] })
  refused(overflowing)
})
