import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createLinkedSpeakerBundle } from '../../tools/lib/linked-speaker-recipe.mjs'
import { instantiateRecipe, validateRecipePackage, RECIPE_CAPABILITIES } from '../../../packages/deepblend/contracts/lib/recipe.js'
import { compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'
import { instantiateRecipeLock } from '../../../packages/deepblend/contracts/lib/recipe.js'
import { RecipeCatalog } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { createSmoothSpeakerBundle } from '../../tools/lib/smooth-speaker-recipe.mjs'

const directory = new URL('../fixtures/modular-speaker-v1/', import.meta.url)
const source = { manifest: JSON.parse(readFileSync(new URL('recipe.json', directory))),
  sceneBytes: readFileSync(new URL('scene-spec.json', directory)), previewBytes: readFileSync(new URL('preview.png', directory)) }
const bundle = createLinkedSpeakerBundle(source)
const entity = (spec, id) => spec.entities.find(e => e.id === id)
const dimensions = (spec, id) => entity(spec, id).generator.dimensions.map((value, axis) => value * entity(spec, id).transform.scale[axis])
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`)

test('the historical assembly remains reproducible and legacy consumers retain the original recipe', () => {
  const folder = new URL('../fixtures/modular-speaker-v2/', import.meta.url)
  assert.deepEqual(JSON.parse(readFileSync(new URL('recipe.json', folder))), bundle.manifest)
  assert.deepEqual(readFileSync(new URL('scene-spec.json', folder)), bundle.sceneBytes)
  assert.deepEqual(readFileSync(new URL('preview.png', folder)), source.previewBytes)
  assert.match(execFileSync(process.execPath, [new URL('../../tools/build-modular-speaker-recipe.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' }), /2\.1\.0 verified/)
  const supportedCapabilities = RECIPE_CAPABILITIES.filter(c => !['recipe.geometry-bindings', 'geometry.primitive.dimensions'].includes(c))
  assert.equal(validateRecipePackage(source, { supportedCapabilities }).ok, true)
  assert.equal(instantiateRecipe(source, {}, { supportedCapabilities }).recipe.version, '1.0.0')
  assert.equal(validateRecipePackage(bundle, { supportedCapabilities }).ok, false)
  for (const field of ['sceneBytes', 'previewBytes']) {
    const altered = { ...source, [field]: Buffer.concat([source[field], Buffer.from(' ')]) }
    assert.throws(() => createLinkedSpeakerBundle(altered), /exact reviewed/)
  }
})

test('the current speaker changes only the two warp bends and keeps all bounded assembly controls', () => {
  const folder = new URL('../../recipes/modular-speaker/', import.meta.url)
  const current = { manifest: JSON.parse(readFileSync(new URL('recipe.json', folder))),
    sceneBytes: readFileSync(new URL('scene-spec.json', folder)), previewBytes: readFileSync(new URL('preview.png', folder)) }
  assert.deepEqual(current, createSmoothSpeakerBundle(bundle, current.previewBytes))
  assert.equal(current.manifest.version, '2.1.0')
  assert.deepEqual(current.manifest.parameters, bundle.manifest.parameters)
  for (const values of [{}, { 'cabinet-width-mm': 300 },
    { 'cabinet-width-mm': 340, 'cabinet-depth-mm': 180, 'cabinet-height-mm': 220 }]) {
    const old = instantiateRecipe(bundle, values).spec, next = instantiateRecipe(current, values).spec
    for (const id of ['grille-warp-0', 'grille-warp-1']) {
      const warp = entity(next, id), original = entity(old, id)
      assert.equal(warp.generator.pathInterpolation, 'bezier')
      assert.equal(warp.generator.curveResolution, 4)
      assert.equal(warp.generator.bevelDepth, original.generator.bevelDepth)
      warp.generator = original.generator
    }
    assert.deepEqual(next, old, 'Sizes, trim, parts, materials, cameras and animation must stay intact')
  }
})

test('a saved 2.0.0 speaker remains editable after the installed catalog advances to 2.1.0', t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-speaker-upgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(new URL('../fixtures/modular-speaker-v2/', import.meta.url), join(root, 'speaker'), { recursive: true })
  const catalog = new RecipeCatalog({ builtinRoot: root }), entry = catalog.list().recipes[0]
  const request = { id: entry.id, version: entry.version, digest: entry.digest }
  const saved = catalog.instantiate(request), original = JSON.stringify(saved.lock)
  rmSync(join(root, 'speaker'), { recursive: true })
  cpSync(new URL('../../recipes/modular-speaker/', import.meta.url), join(root, 'speaker'), { recursive: true })
  assert.deepEqual(catalog.list().errors, [])
  assert.equal(catalog.list().recipes[0].version, '2.1.0')
  assert.throws(() => catalog.instantiate(request), { code: 'RECIPE_NOT_FOUND' })
  const replay = instantiateRecipeLock(saved.lock, { 'cabinet-width-mm': 300 })
  assert.equal(replay.recipe.version, '2.0.0')
  assert.equal(entity(replay.spec, 'grille-warp-0').generator.pathInterpolation, 'poly')
  close(dimensions(replay.spec, 'cabinet-shell')[0], .3)
  assert.equal(JSON.stringify(saved.lock), original)
})

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

test('the control detail camera keeps its original offset and aim relative to the moving knob', () => {
  const base = instantiateRecipe(bundle).spec
  for (const values of [{ 'cabinet-width-mm': 300 }, { 'cabinet-width-mm': 340, 'cabinet-depth-mm': 180, 'cabinet-height-mm': 220 }]) {
    const next = instantiateRecipe(bundle, values).spec
    const oldCamera = base.cameras.find(c => c.id === 'detail'), camera = next.cameras.find(c => c.id === 'detail')
    for (let axis = 0; axis < 3; axis++) for (const position of ['location', 'targetPoint']) {
      const oldVector = position === 'location' ? oldCamera.transform.location : oldCamera.targetPoint
      const vector = position === 'location' ? camera.transform.location : camera.targetPoint
      close(vector[axis] - entity(next, 'volume-knob').transform.location[axis], oldVector[axis] - entity(base, 'volume-knob').transform.location[axis])
    }
    assert.equal(camera.lens, oldCamera.lens)
  }
})
