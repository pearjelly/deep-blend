import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sha256, sha256Canonical } from '../../../packages/deepblend/contracts/lib/canonical.js'
import { validateSceneSpec, requiredSceneFeatures, compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'
import { applyPatchToSpec, validateScenePatch } from '../../../packages/deepblend/contracts/lib/scene-patch.js'
import { validateRecipeManifest, validateRecipePackage, instantiateRecipe, instantiateRecipeLock, RECIPE_CAPABILITIES } from '../../../packages/deepblend/contracts/lib/recipe.js'
import { recipeGeometryParameters, planRecipeGeometryEdit } from '../../../packages/deepblend/contracts/lib/recipe-parameters.js'

const ids = ['longitudinal-slats', 'cross-slats']
function fixture() {
  const directory = new URL('../fixtures/walnut-trivet-v1.1/', import.meta.url)
  return { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))),
    sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
}
function bundle(defaultWidth = .0005) {
  const value = fixture(), spec = JSON.parse(value.sceneBytes)
  if (defaultWidth) spec.halfLaps[0].edgeWidth = defaultWidth
  value.sceneBytes = Buffer.from(JSON.stringify(spec))
  value.manifest.input.sha256 = sha256(value.sceneBytes)
  value.manifest.compatibility.capabilities.push('geometry.joinery.half_lap.edge_finish', 'recipe.half-lap-bindings')
  value.manifest.parameters.push({ id: 'edge-width', title: 'Edge width (mm)', type: 'number',
    default: defaultWidth*1000, minimum: 0, maximum: 1,
    bindings: [{ kind: 'half-lap', entityIds: ids, property: 'edgeWidth', multiplier: .001 }] })
  return value
}
function lockFor(value) {
  const result = instantiateRecipe(value)
  return { schemaVersion: 'deepblend.recipe-lock/v1', ...result.recipe,
    packageDigest: result.recipe.manifestSha256, manifest: structuredClone(value.manifest),
    values: result.values, sceneSource: value.sceneBytes.toString() }
}
function patch(spec, operation) {
  const document = { projectId: spec.project.id, baseRevision: 'r0001', operations: [operation] }
  const checked = validateScenePatch(document)
  assert.equal(checked.ok, true, checked.summary)
  return applyPatchToSpec(spec, document)
}
const setter = (pair, extra = {}) => ({ op: 'joint.halfLap.set', lowerEntityId: pair.lowerEntityId,
  upperEntityId: pair.upperEntityId, ...extra })

test('the exact 1.1 recipe and locked sources keep their original sharp edges', () => {
  const value = fixture()
  assert.equal(sha256(value.sceneBytes), '005f2e6a19a535730b022ab1338de1034e60c0cfb1d13bb846602673f4033a61')
  const result = instantiateRecipe(value), locked = instantiateRecipeLock(lockFor(value))
  assert.deepEqual(result.spec, locked.spec)
  assert.equal(result.spec.halfLaps[0].edgeWidth, undefined)
  assert.equal(requiredSceneFeatures(result.spec).includes('geometry.joinery.half_lap.edge_finish'), false)
  assert.equal(value.manifest.parameters.some(p => p.id === 'edge-width'), false)
  assert.throws(() => instantiateRecipeLock(lockFor(value), { 'edge-width': .5 }))
})

function currentRecipe() {
  const directory = new URL('../../recipes/walnut-trivet/', import.meta.url)
  return { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))),
    sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
}

test('the 1.2 gallery default finishes the original geometry with usable face UVs and its actual native preview', () => {
  const value = currentRecipe(), legacy = JSON.parse(fixture().sceneBytes), source = JSON.parse(value.sceneBytes)
  assert.equal(value.manifest.version, '1.2.0')
  assert.equal(validateRecipePackage(value).ok, true)
  assert.deepEqual(instantiateRecipe(value).spec, compileSceneSpec(source).spec)
  assert.equal(source.halfLaps[0].edgeWidth, .0005)
  const stripped = structuredClone(source)
  delete stripped.halfLaps[0].edgeWidth
  for (const entity of stripped.entities.filter(e => ids.includes(e.id))) {
    for (const uv of entity.generator.faceUvs) {
      const [a,b,c] = uv
      assert.ok(Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])) > 0)
    }
    delete entity.generator.faceUvs
  }
  assert.deepEqual(stripped, legacy)
  const provenance = JSON.parse(readFileSync(new URL('../../docs/validation/timber-edge-preview-1121.json', import.meta.url)))
  assert.equal(provenance.inputSha256, sha256(value.sceneBytes))
  assert.equal(provenance.packagedPng.sha256, sha256(value.previewBytes))
  assert.equal(provenance.nativeReadback.overlapCells, 0)
  assert.equal(provenance.nativeReadback.crossings, 12)
  assert.equal(Object.values(provenance.uvReadback).reduce((total,item) => total+item.degenerateUvTriangles,0), 0)
})

test('current gallery spacing and edge controls combine at their limits without changing photography or source bytes', () => {
  const value = currentRecipe(), before = JSON.stringify(value), base = instantiateRecipe(value).spec
  for (const spacing of [52,92]) for (const width of [0,1]) {
    const result = instantiateRecipe(value, { 'slat-spacing': spacing, 'edge-width': width })
    assert.equal(result.spec.halfLaps[0].edgeWidth ?? 0, width/1000)
    assert.equal(result.spec.entities.find(e => e.id === 'cross-slats').modifiers[0].offset[0], spacing/1000)
    assert.deepEqual(result.spec.materials, base.materials)
    assert.deepEqual(result.spec.cameras, base.cameras)
    assert.deepEqual(result.spec.lights, base.lights)
    assert.deepEqual(result, instantiateRecipe(value, { 'slat-spacing': spacing, 'edge-width': width }))
  }
  assert.equal(JSON.stringify(value), before)
})

test('continued current-gallery edits return to the same source without drift and retain independent joint roles', () => {
  const value = currentRecipe(), lock = lockFor(value), original = instantiateRecipe(value).spec
  original.halfLaps[0] = { lowerEntityId: ids[0], upperEntityId: ids[1], edgeWidth: .0005 }
  let spec = original, state
  for (const [spacing,width] of [[64,.75],[92,0],[78,.5]]) {
    const plan = planRecipeGeometryEdit(lock,spec,state,{'slat-spacing':spacing,'edge-width':width})
    spec = compileSceneSpec(applyPatchToSpec(spec,{projectId:spec.project.id,baseRevision:'r0001',operations:plan.operations}).spec).spec
    state = plan.parameterState
    assert.equal(spec.halfLaps[0].lowerEntityId,ids[0])
    assert.equal(spec.halfLaps[0].edgeWidth ?? 0,width/1000)
  }
  assert.deepEqual(spec,original)
})

test('width updates are idempotent, preserve role edits, and zero removes the optional field', () => {
  const original = instantiateRecipe(bundle()).spec, source = JSON.stringify(original), pair = original.halfLaps[0]
  const canonicalOrder = { ...original, halfLaps: [{ edgeWidth: .0005, lowerEntityId: pair.lowerEntityId, upperEntityId: pair.upperEntityId }] }
  assert.deepEqual(patch(canonicalOrder, setter(pair, { edgeWidth: .0005 })).operations[0].changedPaths, [])
  const swapped = patch(original, setter({ lowerEntityId: pair.upperEntityId, upperEntityId: pair.lowerEntityId })).spec
  assert.equal(swapped.halfLaps[0].edgeWidth, .0005)
  const changed = patch(swapped, setter(swapped.halfLaps[0], { edgeWidth: .001 })).spec
  assert.equal(changed.halfLaps[0].edgeWidth, .001)
  const disabled = patch(changed, setter(changed.halfLaps[0], { edgeWidth: 0 })).spec
  assert.equal(Object.hasOwn(disabled.halfLaps[0], 'edgeWidth'), false)
  assert.equal(requiredSceneFeatures(disabled).includes('geometry.joinery.half_lap.edge_finish'), false)
  assert.deepEqual(disabled.entities, original.entities)
  assert.equal(JSON.stringify(original), source)
})

for (const width of [-1, .0051, NaN, Infinity, '0.001', true, null]) test(`patch rejects invalid edge width ${String(width)}`, () => {
  const spec = instantiateRecipe(fixture()).spec
  const document = { projectId: spec.project.id, baseRevision: 'r0001', operations: [setter(spec.halfLaps[0], { edgeWidth: width })] }
  assert.equal(validateScenePatch(document).ok, false)
})

test('scene fields are positive and bounded, while omission leaves old scene hashes alone', () => {
  const spec = instantiateRecipe(fixture()).spec
  for (const width of [0, -.001, .0051, NaN, Infinity, true]) {
    const bad = structuredClone(spec); bad.halfLaps[0].edgeWidth = width
    assert.equal(validateSceneSpec(bad).ok, false)
  }
  const valid = structuredClone(spec); valid.halfLaps[0].edgeWidth = .005
  assert.equal(validateSceneSpec(valid).ok, true)
  assert.ok(requiredSceneFeatures(valid).includes('geometry.joinery.half_lap.edge_finish'))
})

test('recipe edge controls resolve default, zero and limits from the immutable source', () => {
  const value = bundle(), before = JSON.stringify(value), lock = lockFor(value)
  assert.equal(validateRecipePackage(value).ok, true)
  assert.ok(recipeGeometryParameters(value.manifest).some(p => p.id === 'edge-width'))
  for (const width of [0, .25, .5, 1]) {
    const result = instantiateRecipeLock(lock, { 'edge-width': width })
    assert.equal(result.spec.halfLaps[0].edgeWidth ?? 0, width/1000)
    assert.deepEqual(result, instantiateRecipeLock(lock, { 'edge-width': width }))
  }
  assert.equal(JSON.stringify(value), before)
  assert.equal(instantiateRecipe(bundle(0), { 'edge-width': .5 }).spec.halfLaps[0].edgeWidth, .0005)
})

test('pair bindings reject aliasing, missing pairs, excess ranges and undeclared consumer capabilities', () => {
  const duplicate = bundle(); duplicate.manifest.parameters.at(-1).bindings.push({ ...duplicate.manifest.parameters.at(-1).bindings[0], entityIds: [...ids].reverse() })
  assert.equal(validateRecipeManifest(duplicate.manifest).ok, false)
  const same = bundle(); same.manifest.parameters.at(-1).bindings[0].entityIds = [ids[0], ids[0]]
  assert.equal(validateRecipeManifest(same.manifest).ok, false)
  for (const mutate of [
    b => { b.manifest.parameters.at(-1).bindings[0].entityIds = ['missing', ids[1]] },
    b => { b.manifest.parameters.at(-1).bindings[0].property = 'lowerEntityId' },
    b => { b.manifest.parameters.at(-1).bindings[0].multiplier = 0 },
    b => { b.manifest.parameters.at(-1).maximum = 6 },
    b => { b.manifest.parameters.at(-1).minimum = -1 },
    b => { b.manifest.compatibility.capabilities = b.manifest.compatibility.capabilities.filter(x => x !== 'recipe.half-lap-bindings') },
  ]) {
    const invalid = bundle(); mutate(invalid)
    assert.equal(validateRecipePackage(invalid).ok, false)
    assert.throws(() => instantiateRecipe(invalid))
  }
  assert.equal(validateRecipePackage(bundle(), { supportedCapabilities: RECIPE_CAPABILITIES.filter(x => x !== 'geometry.joinery.half_lap.edge_finish') }).ok, false)
})

test('continued width edits preserve independent roles, materials and photography', () => {
  const value = bundle(), lock = lockFor(value), current = instantiateRecipe(value).spec
  current.halfLaps[0] = { lowerEntityId: ids[0], upperEntityId: ids[1], edgeWidth: .0005 }
  current.materials[0].parameters.roughness = .6
  current.cameras[0].lens = 64
  const before = JSON.stringify(current)
  const plan = planRecipeGeometryEdit(lock, current, undefined, { 'edge-width': .75 })
  assert.deepEqual(plan.operations, [{ op: 'joint.halfLap.set', lowerEntityId: ids[0], upperEntityId: ids[1], edgeWidth: .00075 }])
  const applied = patch(current, plan.operations[0]).spec
  assert.equal(applied.halfLaps[0].edgeWidth, .00075)
  assert.deepEqual(applied.materials, current.materials)
  assert.deepEqual(applied.cameras, current.cameras)
  assert.equal(JSON.stringify(current), before)
  const clear = planRecipeGeometryEdit(lock, applied, plan.parameterState, { 'edge-width': 0 })
  assert.equal(patch(applied, clear.operations[0]).spec.halfLaps[0].edgeWidth, undefined)
})

test('independently changed widths or joint membership refuse prefab edits without overwriting them', () => {
  const value = bundle(), lock = lockFor(value)
  for (const mutate of [s => { s.halfLaps[0].edgeWidth = .0008 }, s => { delete s.halfLaps }]) {
    const spec = instantiateRecipe(value).spec; mutate(spec); const before = JSON.stringify(spec)
    assert.throws(() => planRecipeGeometryEdit(lock, spec, undefined, { 'edge-width': 1 }), e => e.code === 'RECIPE_PARAMETER_CONFLICT')
    assert.equal(JSON.stringify(spec), before)
  }
})
