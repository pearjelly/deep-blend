import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileSceneSpec, validateSceneSpec, entityBoundingRadius } from '../../../packages/deepblend/contracts/lib/scene-spec.js'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
function scene(generator) {
  const spec = structuredClone(fixture)
  const entity = spec.entities.find(entity => entity.type === 'generator')
  entity.generator = generator
  entity.transform = { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }
  return { spec, id: entity.id }
}

test('box axis dimensions describe independent local width, depth and height without an invented scalar size', () => {
  for (const shape of ['cube', 'rounded_box']) {
    const { spec, id } = scene({ shape, dimensions: [.3, .138, .162], bevel: { width: .01, segments: 4 } })
    const original = structuredClone(spec)
    const valid = validateSceneSpec(spec)
    assert.equal(valid.ok, true, valid.summary)
    const compiled = compileSceneSpec(spec)
    const box = compiled.spec.entities.find(entity => entity.id === id)
    assert.deepEqual(box.generator.dimensions, [.3, .138, .162])
    assert.equal(box.generator.size, undefined)
    assert.ok(Math.abs(entityBoundingRadius(box) - Math.hypot(.3, .138, .162) / 2) < 1e-12)
    assert.deepEqual(spec, original)
  }
})

test('legacy box size keeps its established scalar interpretation and defaults', () => {
  for (const generator of [{ shape: 'cube' }, { shape: 'rounded_box', size: .264 }]) {
    const { spec, id } = scene(generator)
    assert.equal(validateSceneSpec(spec).ok, true)
    const compiled = compileSceneSpec(spec)
    const box = compiled.spec.entities.find(entity => entity.id === id)
    assert.equal(box.generator.size, generator.size ?? 2)
    assert.equal(box.generator.dimensions, undefined)
  }
})

test('a box cannot ambiguously declare both scalar size and axis dimensions', () => {
  for (const shape of ['cube', 'rounded_box']) assert.equal(validateSceneSpec(scene({ shape, size: .264, dimensions: [.3, .138, .162] }).spec).ok, false)
})

test('axis dimensions reject missing axes, non-finite values and non-positive lengths', () => {
  for (const dimensions of [[], [.3, .138], [.3, .138, .162, .1], [0, .1, .1], [-.3, .1, .1], [NaN, .1, .1], [Infinity, .1, .1], ['.3', .1, .1]]) {
    assert.equal(validateSceneSpec(scene({ shape: 'rounded_box', dimensions }).spec).ok, false)
  }
})

test('box axis dimensions do not silently change other generator vocabularies', () => {
  for (const shape of ['uv_sphere', 'cylinder', 'plane']) assert.equal(validateSceneSpec(scene({ shape, dimensions: [.3, .138, .162] }).spec).ok, false)
})
