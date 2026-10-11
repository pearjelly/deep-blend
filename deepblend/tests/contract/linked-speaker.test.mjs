import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createLinkedSpeakerBundle } from '../../tools/lib/linked-speaker-recipe.mjs'
import { instantiateRecipe, validateRecipePackage } from '../../../packages/deepblend/contracts/lib/recipe.js'
import { compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'

const directory = new URL('../../recipes/modular-speaker/', import.meta.url)
const source = { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))),
  sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
const bundle = createLinkedSpeakerBundle(source)
const entity = (spec, id) => spec.entities.find(e => e.id === id)
const dimensions = (spec, id) => entity(spec, id).generator.dimensions.map((value, axis) => value * entity(spec, id).transform.scale[axis])
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`)

test('speaker controls retain all 111 parts and the default authored transforms, modifiers and animation', () => {
  const before = JSON.stringify(source), spec = instantiateRecipe(bundle).spec, old = compileSceneSpec(JSON.parse(source.sceneBytes)).spec
  assert.equal(validateRecipePackage(bundle).ok, true)
  assert.equal(spec.entities.length, 111)
  for (const input of old.entities) {
    const next = entity(spec, input.id)
    assert.deepEqual(next.transform, input.transform)
    assert.deepEqual(next.modifiers, input.modifiers)
    if (next.generator?.dimensions) assert.deepEqual(next.generator.dimensions, [input.generator.size, input.generator.size, input.generator.size])
    else assert.deepEqual(next.generator, input.generator)
  }
  assert.deepEqual(spec.animationTracks, old.animationTracks)
  assert.deepEqual(spec.materials, old.materials)
  assert.equal(JSON.stringify(source), before)
})

test('normal and maximum controls retain shell/cavity gaps, bottom height and fixed component sizes', () => {
  const base = instantiateRecipe(bundle).spec
  for (const [w, d, h] of [[300, 138, 162], [300, 150, 180], [340, 180, 220]]) {
    const spec = instantiateRecipe(bundle, { 'cabinet-width-mm': w, 'cabinet-depth-mm': d, 'cabinet-height-mm': h }).spec
    const shell = dimensions(spec, 'cabinet-shell'), cavity = dimensions(spec, 'shell-cavity-tool')
    for (let axis = 0; axis < 3; axis++) { close(shell[axis], [w, d, h][axis] / 1000); close(shell[axis] - cavity[axis], dimensions(base, 'cabinet-shell')[axis] - dimensions(base, 'shell-cavity-tool')[axis]) }
    close(entity(spec, 'cabinet-shell').transform.location[2] - shell[2] / 2, entity(base, 'cabinet-shell').transform.location[2] - dimensions(base, 'cabinet-shell')[2] / 2)
    assert.deepEqual(entity(spec, 'volume-knob').generator, entity(base, 'volume-knob').generator)
    assert.deepEqual(entity(spec, 'driver-cone').generator, entity(base, 'driver-cone').generator)
    assert.deepEqual(entity(spec, 'grille-warp-0').modifiers, entity(base, 'grille-warp-0').modifiers)
    close(entity(spec, 'volume-knob').transform.location[0] - entity(base, 'volume-knob').transform.location[0], (w - 264) / 2000)
    close(entity(spec, 'driver-cone').transform.location[0] - entity(base, 'driver-cone').transform.location[0], -(w - 264) / 2000)
    const track = spec.animationTracks.find(t => t.id === 'button-press')
    close(track.keyframes[0].value - track.keyframes[1].value, .0007)
    close(track.keyframes[0].value, .175 + (h - 162) / 1000)
  }
})

test('unsupported shrinking and excessive growth are rejected with the source intact', () => {
  const before = JSON.stringify(source)
  for (const values of [{ 'cabinet-width-mm': 263 }, { 'cabinet-depth-mm': 181 }, { 'cabinet-height-mm': 221 }, { 'cabinet-height-mm': 100 }]) assert.throws(() => instantiateRecipe(bundle, values))
  assert.equal(JSON.stringify(source), before)
})
