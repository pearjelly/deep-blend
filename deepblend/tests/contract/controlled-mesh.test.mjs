import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateSceneSpec, compileSceneSpec, requiredSceneFeatures, sceneSpecDigest } from '@deepblend/dsh-blender-contracts'
import { assertRuntimeSceneFeatures } from '../../../packages/deepblend/host/lib/runtime-scene-features.js'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const tetra = { shape: 'mesh', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
  faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] }
function scene(generator = tetra, modifiers) {
  const spec = structuredClone(fixture)
  const entity = spec.entities.find(e => e.type === 'generator')
  entity.generator = structuredClone(generator)
  if (modifiers) entity.modifiers = modifiers
  return spec
}
test('old projects retain their scene identity and require no new runtime feature', () => {
  assert.equal(sceneSpecDigest(fixture), '5e56f6e1fbe608cc8ca74823792f71bf8bc2b1a1865066d56a0df6a4a6da7305')
  assert.deepEqual(requiredSceneFeatures(fixture), [])
})
test('control geometry compiles without mutating authored winding, UV seams or unrelated entities', () => {
  const generator = { ...tetra, smooth: true, faceUvs: tetra.faces.map(() => [[0, 0], [1, 0], [0, 1]]) }
  const spec = scene(generator, [{ type: 'subdivision', levels: 2, boundaryMode: 'preserve-corners' }])
  const before = structuredClone(spec)
  assert.equal(validateSceneSpec(spec).ok, true)
  compileSceneSpec(spec)
  assert.deepEqual(spec, before)
  assert.deepEqual(requiredSceneFeatures(spec), ['geometry.procedural.mesh', 'geometry.modifier.subdivision'])
  assert.equal(validateSceneSpec(scene({ shape: 'mesh', vertices: tetra.vertices.slice(0, 3), faces: [[0, 1, 2]] })).ok, true,
    'open surfaces are valid; acceptance must inspect closure for the intended task')
})
test('bad topology and UV data fail before native compilation', () => {
  for (const generator of [
    { ...tetra, faces: [[0, 1, 4]] },
    { ...tetra, faces: [[0, 1, 1]] },
    { ...tetra, faces: [[0, 1, 2], [2, 1, 0]] },
    { ...tetra, vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], faces: [[0, 1, 2]] },
    { ...tetra, faceUvs: [[[0, 0], [1, 0]]] },
    { ...tetra, radius: 1 },
    { shape: 'cube', size: 1, vertices: tetra.vertices },
    { ...tetra, vertices: [[Infinity, 0, 0], ...tetra.vertices.slice(1)] },
    { ...tetra, vertices: Array.from({ length: 32769 }, () => [0, 0, 0]) },
  ]) assert.equal(validateSceneSpec(scene(generator)).ok, false, JSON.stringify(generator).slice(0, 200))
  for (const levels of [0, 4, 1.5]) assert.equal(validateSceneSpec(scene(tetra, [{ type: 'subdivision', levels }])).ok, false)
})
test('mesh and subdivision cannot silently run on an older provider', async () => {
  const spec = scene(tetra, [{ type: 'subdivision', levels: 1 }])
  for (const features of [[], ['geometry.procedural.mesh'], ['geometry.modifier.subdivision']]) {
    await assert.rejects(assertRuntimeSceneFeatures({ getCapabilities: async () => ({ installed: true, sceneFeatures: features }) }, spec),
      e => e.code === 'BLENDER_SCENE_FEATURE_UNSUPPORTED')
  }
  await assertRuntimeSceneFeatures({ getCapabilities: async () => ({ installed: true, sceneFeatures: requiredSceneFeatures(spec) }) }, spec)
})
