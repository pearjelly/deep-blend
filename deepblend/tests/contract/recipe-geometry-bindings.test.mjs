import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sha256, sha256Canonical } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'
import { instantiateRecipe, instantiateRecipeLock, validateRecipePackage, RECIPE_CAPABILITIES } from '../../../packages/deepblend/contracts/lib/recipe.js'
import { planRecipeGeometryEdit } from '../../../packages/deepblend/contracts/lib/recipe-parameters.js'
import { applyPatchToSpec, validateScenePatch } from '../../../packages/deepblend/contracts/lib/scene-patch.js'

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
function lockFor(value, values = {}) {
  const original = instantiateRecipe(value, values)
  return { schemaVersion: 'deepblend.recipe-lock/v1', ...original.recipe,
    packageDigest: sha256Canonical(value.manifest), manifest: structuredClone(value.manifest),
    values: original.values, sceneSource: value.sceneBytes.toString('utf8') }
}
function speaker() {
  const directory = new URL('../../recipes/modular-speaker/', import.meta.url)
  return { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))),
    sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
}
function applyPlan(spec, plan) {
  const patch = { projectId: spec.project.id, baseRevision: 'r0001', operations: plan.operations }
  const checked = validateScenePatch(patch)
  assert.equal(checked.ok, true, checked.summary)
  return compileSceneSpec(applyPatchToSpec(spec, patch).spec).spec
}
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

test('saved recipe inputs resolve after package removal without substituting current preview pixels', () => {
  const value = bundle(), lock = lockFor(value, { 'surface-roughness': .4 }), before = JSON.stringify(lock)
  assert.equal(Object.hasOwn(lock, 'previewBytes'), false)
  assert.deepEqual(instantiateRecipeLock(lock), instantiateRecipe(value, lock.values))
  const resized = instantiateRecipeLock(lock, { width: .3 })
  assert.deepEqual(resized, instantiateRecipe(value, { ...lock.values, width: .3 }))
  assert.equal(resized.values['surface-roughness'], .4)
  assert.equal(JSON.stringify(lock), before)
})

test('saved recipe locks refuse corrupted identity, input, resolved values and unsupported consumers', () => {
  for (const mutate of [
    lock => { lock.schemaVersion = 'unknown' },
    lock => { lock.id = 'different' },
    lock => { lock.version = '9.0.0' },
    lock => { lock.manifest.parameters.at(-1).maximum = .4 },
    lock => { lock.packageDigest = '0'.repeat(64) },
    lock => { lock.manifestSha256 = '0'.repeat(64) },
    lock => { lock.inputSha256 = '0'.repeat(64) },
    lock => { lock.previewSha256 = '0'.repeat(64) },
    lock => { lock.sceneSource += ' ' },
    lock => { lock.values.width = .3 },
    lock => { lock.valuesSha256 = '0'.repeat(64) },
    lock => { delete lock.values.width; lock.valuesSha256 = sha256Canonical(lock.values) },
  ]) {
    const lock = lockFor(bundle()); mutate(lock)
    assert.throws(() => instantiateRecipeLock(lock), undefined, JSON.stringify(lock.values))
  }
  const lock = lockFor(bundle())
  for (const changes of [{ width: .2 }, { width: '0.3' }, { unknown: 1 }, null]) {
    assert.throws(() => instantiateRecipeLock(lock, changes))
  }
  assert.throws(() => instantiateRecipeLock(lock, {}, {
    supportedCapabilities: RECIPE_CAPABILITIES.filter(capability => capability !== 'recipe.geometry-bindings'),
  }))
})

test('coherent locked hashes retain the full package scene restrictions and geometry checks', () => {
  const value = bundle(), scene = JSON.parse(value.sceneBytes)
  scene.entities.find(entity => entity.id === 'cabinet-shell').generator.dimensions[0] = -1
  const lock = lockFor(value)
  lock.sceneSource = JSON.stringify(scene); lock.inputSha256 = sha256(Buffer.from(lock.sceneSource))
  lock.manifest.input.sha256 = lock.inputSha256
  lock.manifestSha256 = lock.packageDigest = sha256Canonical(lock.manifest)
  assert.throws(() => instantiateRecipeLock(lock), error => error.code === 'RECIPE_SCENE_INVALID')
})

test('an existing complete speaker resizes through ordinary patches and restores parameter state without cumulative drift', () => {
  const value = speaker(), lock = lockFor(value), initial = instantiateRecipe(value).spec
  const before = JSON.stringify({ lock, initial })
  const wider = planRecipeGeometryEdit(lock, initial, undefined, { 'cabinet-width-mm': 300 })
  const resized = applyPlan(initial, wider)
  assert.deepEqual(resized, instantiateRecipe(value, { 'cabinet-width-mm': 300 }).spec)
  assert.equal(resized.entities.length, 111)
  const next = planRecipeGeometryEdit(lock, resized, wider.parameterState, { 'cabinet-height-mm': 200 })
  assert.deepEqual(applyPlan(resized, next), instantiateRecipe(value, { 'cabinet-width-mm': 300, 'cabinet-height-mm': 200 }).spec)
  const back = planRecipeGeometryEdit(lock, resized, wider.parameterState, { 'cabinet-width-mm': 264 })
  assert.deepEqual(applyPlan(resized, back), initial)
  // Restoring the original revision also selects its original parameter state.
  assert.deepEqual(applyPlan(initial, planRecipeGeometryEdit(lock, initial, undefined, { 'cabinet-height-mm': 200 })),
    instantiateRecipe(value, { 'cabinet-height-mm': 200 }).spec)
  assert.equal(JSON.stringify({ lock, initial }), before)
})

test('existing assembly edits preserve independent materials, bevels, camera work and custom button timing', () => {
  const value = speaker(), lock = lockFor(value), current = instantiateRecipe(value).spec
  current.materials[0].parameters.roughness = .41
  current.entities.find(item => item.id === 'cabinet-shell').generator.bevel.segments = 7
  const hero = current.cameras.find(item => item.id === 'hero'); hero.lens += 5
  const press = current.animationTracks.find(track => track.targetEntityId === 'top-button' && track.property === 'location.z')
  press.keyframes[1].frame += 1; press.keyframes[1].value -= .001
  const original = structuredClone(current)
  const plan = planRecipeGeometryEdit(lock, current, undefined, { 'cabinet-width-mm': 300, 'cabinet-height-mm': 200 })
  const edited = applyPlan(current, plan)
  assert.deepEqual(edited.materials, original.materials)
  assert.deepEqual(edited.entities.find(item => item.id === 'cabinet-shell').modifiers,
    original.entities.find(item => item.id === 'cabinet-shell').modifiers)
  assert.deepEqual(edited.entities.find(item => item.id === 'cabinet-shell').generator.bevel,
    original.entities.find(item => item.id === 'cabinet-shell').generator.bevel)
  assert.deepEqual(edited.cameras.find(item => item.id === 'hero'), hero)
  assert.ok(plan.preservedCameraIds.includes('hero'))
  const movedPress = edited.animationTracks.find(track => track.id === press.id)
  assert.deepEqual(movedPress.keyframes.map(keyframe => keyframe.frame), press.keyframes.map(keyframe => keyframe.frame))
  const delta = edited.entities.find(item => item.id === 'top-button').transform.location[2]
    - original.entities.find(item => item.id === 'top-button').transform.location[2]
  movedPress.keyframes.forEach((keyframe, index) => assert.ok(Math.abs(keyframe.value - press.keyframes[index].value - delta) < 1e-12))
  assert.deepEqual(current, original)
})

test('manual controlled geometry, missing parts and inconsistent saved parameter state are refused before mutation', () => {
  const lock = lockFor(speaker())
  for (const mutate of [
    spec => { spec.entities.find(item => item.id === 'cabinet-shell').generator.dimensions[1] += .001 },
    spec => { spec.entities.find(item => item.id === 'cabinet-shell').transform.scale[0] *= 2 },
    spec => { spec.entities.find(item => item.id === 'driver-cone').transform.location[0] += .01 },
  ]) {
    const current = instantiateRecipeLock(lock).spec; mutate(current); const original = JSON.stringify(current)
    assert.throws(() => planRecipeGeometryEdit(lock, current, undefined, { 'cabinet-width-mm': 300 }),
      error => error.code === 'RECIPE_PARAMETER_CONFLICT')
    assert.equal(JSON.stringify(current), original)
  }
  const current = instantiateRecipeLock(lock).spec
  const valid = planRecipeGeometryEdit(lock, current, undefined, { 'cabinet-width-mm': 300 })
  assert.throws(() => planRecipeGeometryEdit(lock, current, valid.parameterState, { 'cabinet-height-mm': 200 }),
    error => error.code === 'RECIPE_PARAMETER_CONFLICT')
  assert.throws(() => planRecipeGeometryEdit(lock, current, undefined, { 'surface-roughness': .4 }))
  const corrupt = structuredClone(valid.parameterState); corrupt.valuesSha256 = '0'.repeat(64)
  assert.throws(() => planRecipeGeometryEdit(lock, current, corrupt, { 'cabinet-height-mm': 200 }),
    error => error.code === 'RECIPE_LOCK_INVALID')
  const missing = structuredClone(current)
  missing.entities = missing.entities.filter(item => item.id !== 'driver-cone')
  assert.throws(() => planRecipeGeometryEdit(lock, missing, undefined, { 'cabinet-width-mm': 300 }))
})

test('all eight declared size corners remain valid patches; out-of-range requests never change the current assembly', () => {
  const value = speaker(), lock = lockFor(value), current = instantiateRecipe(value).spec
  for (const width of [264, 340]) for (const depth of [138, 180]) for (const height of [162, 220]) {
    const values = { 'cabinet-width-mm': width, 'cabinet-depth-mm': depth, 'cabinet-height-mm': height }
    const plan = planRecipeGeometryEdit(lock, current, undefined, values)
    if (plan.operations.length) assert.deepEqual(applyPlan(current, plan), instantiateRecipe(value, values).spec)
    else assert.deepEqual(plan.parameterState.values, lock.values)
  }
  const original = JSON.stringify(current)
  for (const [id, number] of [['cabinet-width-mm', 263], ['cabinet-depth-mm', 181], ['cabinet-height-mm', 221]]) {
    assert.throws(() => planRecipeGeometryEdit(lock, current, undefined, { [id]: number }))
  }
  assert.equal(JSON.stringify(current), original)
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

function cupBundle() {
  const directory = new URL('../../recipes/glazed-cup/', import.meta.url)
  return { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))),
    sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
}

test('three cup dimensions instantiate jointly valid vessel and handle geometry, including all boundary combinations', () => {
  const bundle = cupBundle(), checked = validateRecipePackage(bundle)
  assert.equal(checked.ok, true, checked.summary)
  for (const height of [95, 115, 130]) for (const diameter of [72, 84, 96]) for (const wall of [3, 4, 5]) {
    const result = instantiateRecipe(bundle, { 'cup-height-mm': height, 'cup-outer-diameter-mm': diameter, 'cup-wall-mm': wall })
    const cup = result.spec.entities.find(e => e.id === 'cup').generator
    assert.ok(Math.abs(cup.height - height / 1000) < 1e-12)
    assert.ok(Math.abs(cup.radius - diameter / 2000) < 1e-12)
    assert.ok(Math.abs(cup.wallThickness - wall / 1000) < 1e-12)
    assert.ok(Math.abs(cup.handleLower - cup.height * 4 / 15) < 1e-12)
    assert.ok(Math.abs(cup.handleUpper - cup.height * 26 / 35) < 1e-12)
    assert.ok(Math.abs(cup.handleRadius - cup.radius * .1375) < 1e-12)
    assert.ok(Math.abs(cup.rootRadius - cup.radius * .225) < 1e-12)
    assert.ok(Math.abs(cup.rootLength - cup.radius * .15) < 1e-12)
  }
})

test('continuing cup dimensions preserves unbound material, root shape and placement; controlled edits or scaling refuse', () => {
  const bundle = cupBundle(), first = instantiateRecipe(bundle, { 'cup-height-mm': 115, 'cup-outer-diameter-mm': 84, 'cup-wall-mm': 4 })
  const lock = lockFor(bundle, first.values)
  const current = structuredClone(first.spec), cup = current.entities.find(e => e.id === 'cup')
  cup.generator.rootTension = 2; cup.generator.footRound = .0025
  cup.transform.location = [.1, .2, .3]
  current.materials.find(m => m.id === 'glaze').parameters.roughness = .31
  for (const camera of current.cameras) camera.lens += 1 // Independent photography stays protected.
  const plan = planRecipeGeometryEdit(lock, current, undefined, { 'cup-height-mm': 125 })
  assert.deepEqual(plan.changedParameters, ['cup-height-mm'])
  const patch = { projectId: current.project.id, baseRevision: 'r0001', operations: plan.operations }
  assert.equal(validateScenePatch(patch).ok, true)
  const after = applyPatchToSpec(current, patch).spec, generator = after.entities.find(e => e.id === 'cup').generator
  assert.ok(Math.abs(generator.height - .125) < 1e-12)
  assert.equal(generator.wallThickness, cup.generator.wallThickness)
  assert.equal(generator.radius, cup.generator.radius)
  assert.equal(generator.rootTension, 2); assert.equal(generator.footRound, .0025)
  assert.deepEqual(after.materials, current.materials)
  assert.deepEqual(after.entities.find(e => e.id === 'cup').transform, cup.transform)
  assert.deepEqual(after.cameras, current.cameras)
  const edited = structuredClone(current); edited.entities.find(e => e.id === 'cup').generator.radius += .001
  assert.throws(() => planRecipeGeometryEdit(lock, edited, undefined, { 'cup-height-mm': 125 }), e => e.code === 'RECIPE_PARAMETER_CONFLICT')
  const scaled = structuredClone(current); scaled.entities.find(e => e.id === 'cup').transform.scale = [1.1, 1, 1]
  assert.throws(() => planRecipeGeometryEdit(lock, scaled, undefined, { 'cup-height-mm': 125 }), e => e.code === 'RECIPE_PARAMETER_CONFLICT')
  assert.throws(() => instantiateRecipe(bundle, { 'cup-wall-mm': 99 }), e => e.code === 'RECIPE_PARAMETER_INVALID')
})

test('generator scalar bindings refuse undeclared consumers, unsafe properties, duplicate targets and non-vessel shapes', () => {
  const bundle = cupBundle()
  assert.equal(validateRecipePackage(bundle, { supportedCapabilities: RECIPE_CAPABILITIES.filter(c => c !== 'recipe.generator-bindings') }).ok, false)
  for (const corrupt of [
    b => { b.manifest.compatibility.capabilities = b.manifest.compatibility.capabilities.filter(c => c !== 'recipe.generator-bindings') },
    b => { b.manifest.parameters[0].bindings[0].property = '__proto__' },
    b => { b.manifest.parameters[0].bindings[0].multiplier = 0 },
    b => { b.manifest.parameters[0].bindings.push(structuredClone(b.manifest.parameters[0].bindings[0])) },
    b => { b.manifest.parameters[0].bindings[0].entityId = 'floor' },
  ]) { const bad = structuredClone(bundle); corrupt(bad); assert.equal(validateRecipePackage(bad).ok, false) }
})

const lampBundle = (historical = false) => {
  const directory = new URL(historical ? '../fixtures/metal-lamp-v2/' : '../../recipes/metal-lamp/', import.meta.url)
  return { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))), sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
}

test('paired lamp diameter control preserves exact authored default and historical v2 lock', () => {
  const current = lampBundle(), old = lampBundle(true), base = instantiateRecipe(current), historical = instantiateRecipe(old)
  assert.equal(current.manifest.version, '2.2.0'); assert.equal(old.manifest.version, '2.0.0')
  assert.equal(sha256(old.sceneBytes), '4a9ea6e09e757acf23dc01593a94a3a51776ec697f15853b1ba62f0ed9515f1f')
  assert.deepEqual(base.spec.entities, historical.spec.entities)
  assert.deepEqual(base.spec.materials, historical.spec.materials)
  assert.deepEqual(current.previewBytes, old.previewBytes)
  assert.deepEqual(instantiateRecipeLock(lockFor(old)).spec, historical.spec)
  assert.throws(() => instantiateRecipeLock(lockFor(old), { 'shade-diameter-mm': 230 }), { code: 'RECIPE_PARAMETER_UNKNOWN' })
  assert.deepEqual(base.spec.cameras.find(c => c.id === 'hero'), historical.spec.cameras.find(c => c.id === 'hero'))
  assert.equal(base.spec.cameras.find(c => c.id === 'liner-inspection').role, 'detail')
  assert.equal(base.spec.cameras.find(c => c.id === 'detail').role, undefined)
})

test('lamp boundary and requested diameter move only the paired profiles and keep neck correspondence', () => {
  const bundle = lampBundle(), base = instantiateRecipe(bundle)
  assert.deepEqual(recipeGeometryParametersForTest(bundle), ['shade-diameter-mm'])
  for (const diameter of [180, 230, 250]) {
    const after = instantiateRecipe(bundle, { 'shade-diameter-mm': diameter })
    const entity = (spec, id) => spec.entities.find(e => e.id === id)
    const shell = entity(after.spec, 'shade-shell').generator.profile
    assert.ok(Math.abs(Math.max(...shell.map(p => p[0])) * 2000 - diameter) < 1e-6)
    assert.notDeepEqual(entity(after.spec, 'shade-enamel-lining').generator.profile, entity(base.spec, 'shade-enamel-lining').generator.profile)
    assert.deepEqual(shell.slice(40, 50), entity(base.spec, 'shade-shell').generator.profile.slice(40, 50))
    for (const original of base.spec.entities) if (!['shade-shell', 'shade-enamel-lining', ...(diameter > 230 ? bundle.manifest.parameters[0].bindings.slice(1).map(b=>b.entityId) : [])].includes(original.id)) assert.deepEqual(entity(after.spec, original.id), original)
    assert.deepEqual(after.spec.materials, base.spec.materials); assert.deepEqual(after.spec.cameras, base.spec.cameras)
  }
  assert.throws(() => instantiateRecipe(bundle, { 'shade-diameter-mm': 179.99 }), { code: 'RECIPE_PARAMETER_INVALID' })
  assert.throws(() => instantiateRecipe(bundle, { 'shade-diameter-mm': 250.01 }), { code: 'RECIPE_PARAMETER_INVALID' })
})

function recipeGeometryParametersForTest(bundle) {
  const lock = lockFor(bundle), base = instantiateRecipe(bundle)
  const plan = planRecipeGeometryEdit(lock, base.spec, undefined, { 'shade-diameter-mm': 230 })
  return plan.changedParameters
}

test('continued lamp diameter edits preserve independent style, photography and tessellation', () => {
  const bundle = lampBundle(), lock = lockFor(bundle), first = instantiateRecipe(bundle), original = structuredClone(first.spec)
  first.spec.materials[0].parameters.roughness = .51
  first.spec.cameras.find(c => c.id === 'hero').lens = 62
  first.spec.entities.find(e => e.id === 'shade-shell').generator.segments = 160
  const p1 = planRecipeGeometryEdit(lock, first.spec, undefined, { 'shade-diameter-mm': 230 })
  assert.equal(p1.operations.length, 2)
  const after = applyPlan(first.spec, p1)
  const p2 = planRecipeGeometryEdit(lock, after, p1.parameterState, { 'shade-diameter-mm': 250 })
  const next = applyPlan(after, p2)
  assert.deepEqual(next.materials, first.spec.materials); assert.deepEqual(next.cameras, first.spec.cameras)
  assert.equal(next.entities.find(e => e.id === 'shade-shell').generator.segments, 160)
  assert.deepEqual(next.entities.find(e => e.id === 'shade-shell').generator.profile, instantiateRecipe(bundle, { 'shade-diameter-mm': 250 }).spec.entities.find(e => e.id === 'shade-shell').generator.profile)
  assert.deepEqual(instantiateRecipeLock(lock).spec, original)
})

test('manual profile, alignment, closure or shape edits refuse a coupled lamp overwrite', () => {
  const bundle = lampBundle(), lock = lockFor(bundle)
  for (const edit of [
    e => { e.generator.profile[0][0] += .0001 },
    e => { e.transform.location[0] += .001 },
    e => { e.transform.scale[0] = 1.1 },
    e => { e.generator.closedProfile = false },
    e => { e.generator = { shape: 'cylinder', radius: .1, depth: .1, segments: 64 } },
  ]) for (const id of ['shade-shell', 'shade-enamel-lining']) {
    const spec = instantiateRecipe(bundle).spec; edit(spec.entities.find(e => e.id === id))
    assert.throws(() => planRecipeGeometryEdit(lock, spec, undefined, { 'shade-diameter-mm': 230 }), { code: 'RECIPE_PARAMETER_CONFLICT' })
  }
})

test('compound profile binding refuses missing capabilities, invalid correspondence and overlapping controls', () => {
  const source = lampBundle()
  for (const change of [
    b => { b.manifest.compatibility.capabilities = b.manifest.compatibility.capabilities.filter(c => c !== 'recipe.lathe-shell-bindings') },
    b => { b.manifest.parameters[0].bindings[0].linerEntityId = 'shade-shell' },
    b => { b.manifest.parameters[0].bindings[0].outerPointCount = 46 },
    b => { b.manifest.parameters[0].bindings[0].linerStart = 44 },
    b => { b.manifest.parameters[0].bindings[0].neckAnchorHeight = .007 },
    b => { b.manifest.parameters[0].default = 210 },
    b => { const p = structuredClone(b.manifest.parameters[0]); p.id = 'overlapping'; b.manifest.parameters.push(p) },
  ]) {
    const altered = structuredClone(source); change(altered); assert.equal(validateRecipePackage(altered).ok, false)
  }
  assert.equal(validateRecipePackage(source, { supportedCapabilities: RECIPE_CAPABILITIES.filter(c => c !== 'recipe.lathe-shell-bindings') }).ok, false)
  assert.equal(validateRecipePackage(lampBundle(true), { supportedCapabilities: RECIPE_CAPABILITIES.filter(c => c !== 'recipe.lathe-shell-bindings') }).ok, true)
})

test('large lamp links every support by 11mm and roundtrips exactly without replacing hand finishes', () => {
 const bundle=lampBundle(),lock=lockFor(bundle),base=instantiateRecipe(bundle).spec
 base.materials[0].parameters.roughness=.517
 base.cameras[0].lens=61
 base.entities.find(e=>e.id==='swept-upper-arm').generator.segments=36
 const source=structuredClone(base),p=planRecipeGeometryEdit(lock,base,undefined,{'shade-diameter-mm':250}),after=applyPlan(base,p)
 for(const id of ['mast-socket','mast-socket-collar','upright-mast','hinge-body','hinge-front-cap','hinge-rear-cap','hinge-fine-ring','hinge-centre-pin']) {
  assert.ok(Math.abs(after.entities.find(e=>e.id===id).transform.location[0]-source.entities.find(e=>e.id===id).transform.location[0]+.011)<1e-12)
 }
 const arm=after.entities.find(e=>e.id==='swept-upper-arm');assert.equal(arm.generator.segments,36)
 assert.ok(Math.abs(arm.generator.path[0][0]+.086)<1e-12)
 assert.deepEqual(after.materials,source.materials);assert.deepEqual(after.cameras,source.cameras)
 const back=applyPlan(after,planRecipeGeometryEdit(lock,after,p.parameterState,{'shade-diameter-mm':209.8}))
 assert.deepEqual(back,source);assert.deepEqual(base,source)
})

test('pinned legacy 2.1 project repairs an existing250mm value once, retains lock and independent edits, and roundtrips', () => {
 const current=lampBundle(),old={...current}
 old.manifest=JSON.parse(readFileSync(new URL('../fixtures/metal-lamp-v21/recipe.json',import.meta.url)))
 const lock=lockFor(old,{'shade-diameter-mm':250}),source=instantiateRecipeLock(lock).spec,originalLock=JSON.stringify(lock)
 source.materials[0].parameters.roughness=.517;source.entities.find(e=>e.id==='swept-upper-arm').generator.segments=36
 const before=structuredClone(source),p=planRecipeGeometryEdit(lock,source,undefined,{'shade-diameter-mm':250}),after=applyPlan(source,p)
 assert.equal(p.parameterState.assemblyRepair,'metal-lamp-clearance/v1')
 assert.ok(Math.abs(after.entities.find(e=>e.id==='upright-mast').transform.location[0]+.086)<1e-12)
 assert.deepEqual(after.materials,before.materials);assert.equal(JSON.stringify(lock),originalLock)
 assert.equal(planRecipeGeometryEdit(lock,after,p.parameterState,{'shade-diameter-mm':250}).operations.length,0)
 const backPlan=planRecipeGeometryEdit(lock,after,p.parameterState,{'shade-diameter-mm':230}),back=applyPlan(after,backPlan)
 assert.deepEqual(back.entities.find(e=>e.id==='upright-mast'),before.entities.find(e=>e.id==='upright-mast'))
 assert.throws(()=>planRecipeGeometryEdit(lock,source,{...p.parameterState,assemblyRepair:'forged'},{}),{code:'RECIPE_LOCK_INVALID'})
})

test('manual support displacement and arm edits refuse atomically before any linked overwrite', () => {
 const bundle=lampBundle(),lock=lockFor(bundle)
 for(const mutate of [s=>s.entities.find(e=>e.id==='upright-mast').transform.location[0]+=.003,
 s=>s.entities.find(e=>e.id==='swept-upper-arm').generator.path[4][1]+=.003,
 s=>s.entities.find(e=>e.id==='swept-upper-arm').transform.rotationEuler=[0,.1,0]]) {
  const spec=instantiateRecipeLock(lock).spec;mutate(spec);const before=JSON.stringify(spec)
  assert.throws(()=>planRecipeGeometryEdit(lock,spec,undefined,{'shade-diameter-mm':250}),{code:'RECIPE_PARAMETER_CONFLICT'})
  assert.equal(JSON.stringify(spec),before)
 }
})

test('curve-point thresholds refuse undeclared support, unsafe indices, duplicate slots and out-of-range activation', () => {
 for(const mutate of [
 b=>{b.manifest.compatibility.capabilities=b.manifest.compatibility.capabilities.filter(c=>c!=='recipe.curve-point-bindings')},
 b=>{b.manifest.parameters[0].bindings.at(-1).pointIndex=127},
 b=>{b.manifest.parameters[0].bindings.at(-1).pointIndex=128},
 b=>{b.manifest.parameters[0].bindings.at(-1).inputFloor=260},
 b=>{b.manifest.parameters[0].bindings.at(-1).entityId='upright-mast'},
 b=>{b.manifest.parameters[0].bindings.push({...b.manifest.parameters[0].bindings.at(-1)})},
 ]){const b=lampBundle();mutate(b);assert.equal(validateRecipePackage(b).ok,false);assert.throws(()=>instantiateRecipe(b))}
})

function assertTranslatedGeometry(actual, expected) {
  const rounded = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'number' ? Math.round(v * 1e12) / 1e12 : v))
  assert.deepEqual(rounded(actual), rounded(expected))
}

function moveSpeaker(spec, offset) {
  const result = structuredClone(spec)
  for (const e of result.entities) if (e.id !== 'studio-floor') e.transform.location = e.transform.location.map((v, i) => v + offset[i])
  for (const t of result.animationTracks) if (/^location\.[xyz]$/.test(t.property)) {
    const axis = ['x', 'y', 'z'].indexOf(t.property.at(-1))
    for (const key of t.keyframes) key.value += offset[axis]
  }
  return result
}

test('a complete hand-translated speaker keeps placement, all 110 parts and animation through eight size corners and return', () => {
  for (const folder of ['../fixtures/modular-speaker-v2/', '../../recipes/modular-speaker/']) {
    const dir = new URL(folder, import.meta.url)
    const value = {manifest: JSON.parse(readFileSync(new URL('recipe.json', dir))), sceneBytes: readFileSync(new URL('scene-spec.json', dir)), previewBytes: readFileSync(new URL('preview.png', dir))}
    const lock = lockFor(value), offset = [.15, -.09, .02], current = moveSpeaker(instantiateRecipe(value).spec, offset)
    const protectedInputs = JSON.stringify({lock, current})
    for (const w of [264, 340]) for (const d of [138, 180]) for (const h of [162, 220]) {
      const values = {'cabinet-width-mm':w, 'cabinet-depth-mm':d, 'cabinet-height-mm':h}
      const plan = planRecipeGeometryEdit(lock, current, undefined, values), next = plan.operations.length ? applyPlan(current, plan) : current
      const expected = moveSpeaker(instantiateRecipe(value, values).spec, offset)
      assertTranslatedGeometry(next.entities, expected.entities)
      assertTranslatedGeometry(next.animationTracks, expected.animationTracks)
      const back = planRecipeGeometryEdit(lock, next, plan.parameterState, {'cabinet-width-mm':264,'cabinet-depth-mm':138,'cabinet-height-mm':162})
      assertTranslatedGeometry((back.operations.length ? applyPlan(next, back) : next).entities, current.entities)
      assertTranslatedGeometry((back.operations.length ? applyPlan(next, back) : next).animationTracks, current.animationTracks)
      assert.equal(planRecipeGeometryEdit(lock, next, plan.parameterState, values).operations.length, 0)
    }
    assert.equal(JSON.stringify({lock,current}), protectedInputs)
  }
})

test('translated speaker resizing preserves hand materials, bevel, weaving, camera, new entities and custom press timing', () => {
  const value = speaker(), lock = lockFor(value), current = moveSpeaker(instantiateRecipe(value).spec, [.15,-.09,.02])
  current.materials[0].parameters.roughness = .43
  current.entities.find(e => e.id==='cabinet-shell').generator.bevel.segments = 7
  current.entities.find(e => e.id==='grille-warp-0').generator.curveResolution = 6
  current.cameras[0].lens += 8
  const extra = structuredClone(current.entities.find(e=>e.id==='studio-floor')); extra.id='hand-display-plinth'; current.entities.push(extra)
  const press = current.animationTracks.find(t=>t.id==='button-press'); press.keyframes[1].frame += 2; press.keyframes[1].value -= .001
  const original = structuredClone(current), plan = planRecipeGeometryEdit(lock, current, undefined, {'cabinet-height-mm':220})
  const next = applyPlan(current, plan)
  assert.deepEqual(next.materials,current.materials)
  assert.deepEqual(next.cameras[0],current.cameras[0])
  for (const id of ['hand-display-plinth','studio-floor']) assert.deepEqual(next.entities.find(e=>e.id===id),current.entities.find(e=>e.id===id))
  assert.deepEqual(next.entities.find(e=>e.id==='cabinet-shell').generator.bevel,current.entities.find(e=>e.id==='cabinet-shell').generator.bevel)
  assert.equal(next.entities.find(e=>e.id==='grille-warp-0').generator.curveResolution,6)
  const updated = next.animationTracks.find(t=>t.id==='button-press')
  assert.deepEqual(updated.keyframes.map(k=>k.frame),press.keyframes.map(k=>k.frame))
  updated.keyframes.forEach((k,i)=>assert.ok(Math.abs(k.value-press.keyframes[i].value-.058)<1e-12))
  assert.deepEqual(current,original)
})

test('partial placement, detached unbound axes, missing animation shift and unknown sources cannot gain a translation exemption', () => {
  const value = speaker(), lock = lockFor(value)
  for (const mutate of [
    s=>{s.entities.find(e=>e.id==='power-plug').transform.location[0]+=.001},
    s=>{s.entities.find(e=>e.id==='cabinet-shell').transform.location[0]+=.001},
    s=>{s.animationTracks.find(t=>t.id==='button-press').keyframes[0].value-=.02},
    s=>{s.entities=s.entities.filter(e=>e.id!=='power-plug')},
  ]) {
    const current = moveSpeaker(instantiateRecipe(value).spec,[.15,-.09,.02]); mutate(current); const before=JSON.stringify(current)
    assert.throws(()=>planRecipeGeometryEdit(lock,current,undefined,{'cabinet-width-mm':340}), e=>e.code==='RECIPE_PARAMETER_CONFLICT'||e.code==='RECIPE_SCENE_INVALID')
    assert.equal(JSON.stringify(current),before)
  }
  const custom = {...value,manifest:structuredClone(value.manifest)}; custom.manifest.description += ' custom'; const customLock=lockFor(custom)
  assert.throws(()=>planRecipeGeometryEdit(customLock,moveSpeaker(instantiateRecipe(custom).spec,[.15,-.09,.02]),undefined,{'cabinet-width-mm':340}),{code:'RECIPE_PARAMETER_CONFLICT'})
})

test('rotating or replacing dimension-controlled geometry refuses a world-size mismatch before any mutation', () => {
  const value=speaker(),lock=lockFor(value)
  for(const id of ['cabinet-shell','shell-cavity-tool','front-baffle','rear-service-panel']) for(const edit of [
    e=>{e.transform.rotationEuler[2]=Math.PI/2},
    e=>{e.generator.shape='cube';delete e.generator.bevel},
  ]){
    const current=instantiateRecipe(value).spec; edit(current.entities.find(e=>e.id===id));const before=JSON.stringify(current)
    assert.throws(()=>planRecipeGeometryEdit(lock,current,undefined,{'cabinet-width-mm':340}),e=>e.code==='RECIPE_PARAMETER_CONFLICT'&&e.details.conflicts.some(c=>c.property==='dimension-alignment'))
    assert.equal(JSON.stringify(current),before)
  }
})
