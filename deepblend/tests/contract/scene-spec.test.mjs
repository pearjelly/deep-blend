#!/usr/bin/env node
/**
 * M1 contract tests — SceneSpec v1 (`validateSceneSpec`, `compileSceneSpec`,
 * `sceneSpecDigest`, `summarizeSceneSpec`, `sceneSpecCanonicalText`).
 *
 * Pure unit tests: no Blender, no subprocess, no network, no filesystem writes.
 * The fixture `deepblend/fixtures/product-turntable/scene-spec.json` is the
 * document every mutation below is derived from, so the whole file tests the
 * real SceneSpec the M1 pipeline compiles.
 *
 * What is pinned here, and why it is a contract rather than an implementation
 * detail:
 *
 *  - the TWO validation layers are distinct (SPEC §13.2). A structural failure
 *    is always `SCENE_SCHEMA_INVALID` and names its JSON Schema keyword; a
 *    semantic failure has its own stable code. A caller branches on these, so a
 *    code that moves between layers is a breaking change.
 *  - a NOTICE never fails a validation. It records a decision the compiler made
 *    on the author's behalf, and it travels into the digest so the model can see
 *    what happened without a render.
 *  - `compileSceneSpec` is deterministic and PURE. Compiling must not write a
 *    single key back into the caller's document, which is what makes "失败不污染
 *    当前 Revision" (SPEC §13.2) hold for the whole revision machinery.
 *  - the digest answers "is the SCENE different?" — so it ignores the brief and
 *    is stable across key order, or two identical scenes would look like two
 *    revisions.
 *
 * Run standalone: `node deepblend/tests/contract/scene-spec.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BLENDER_ENGINE_BY_KEY,
  SCENE_ENGINES,
  SCENE_SCHEMA_VERSION,
  canonicalStringify,
  compileSceneSpec,
  sceneProjection,
  sceneSpecCanonicalText,
  sceneSpecDigest,
  summarizeSceneSpec,
  validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'

/** The one fixture this milestone compiles end to end. */
const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'product-turntable',
  'scene-spec.json',
)

/**
 * Golden digests of the checked-in fixture, recorded from a green run.
 *
 * They are pinned deliberately: the digest is the identity of a scene, so a
 * change to `canonical.js` or to the projection re-labels **every** revision
 * ever stored. Editing the fixture on purpose means updating these two values
 * on purpose — which is what happened in M2, when the fixture's two cameras were
 * given explicit `role`s so the shipped example of a scene is one whose views a
 * reviewer can name. Without roles the plan has to fall back to camera-id labels,
 * which is honest but is not what the product wants to teach.
 */
const FIXTURE_DIGEST = '5e56f6e1fbe608cc8ca74823792f71bf8bc2b1a1865066d56a0df6a4a6da7305'
const FIXTURE_COMPILED_DIGEST = '32b4a1da5de821637adc3fdbcc8cea7fb053bf5c70d1573c179cf6cb24ec61a4'

// ---------------------------------------------------------------------------
// Harness — a `results` array, `[PASS]`/`[FAIL]` lines, a summary, and a
// non-zero exit when anything failed. This is the counting form the M1 contract
// files were specified with, and it is the form `deepblend/tests/composition/
// *.e2e.mjs` already uses. (`contracts.test.mjs` instead uses node:test +
// assert/strict; the two styles coexist because `deepblend/tests/run.mjs` only
// reads each file's exit code.)
// ---------------------------------------------------------------------------

const results = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/** @returns {object} the parsed fixture */
function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
}

/** Deep copy through JSON, so no test can leak a mutation into another. */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** The fixture with `mutate` applied — every case starts from the same document. */
function fixtureWith(mutate) {
  const spec = loadFixture()
  mutate(spec)
  return spec
}

/** Run `fn`, returning either its value or the error it threw. */
function caught(fn) {
  try {
    return { value: fn() }
  } catch (error) {
    return { error }
  }
}

/** Issue codes, for compact failure details. */
function codes(issues) {
  return issues.map(issue => issue.code)
}

/** Does `issues` contain `code` at `path`? */
function has(issues, code, path) {
  return issues.some(issue => issue.code === code && (path === undefined || issue.path === path))
}

/** Recursively rebuild a value with every object's keys in reverse order. */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])]))
}

/** Freeze a document and everything below it, so a write throws in strict mode. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const member of Object.values(value)) deepFreeze(member)
  return value
}

// ---------------------------------------------------------------------------
// The fixture is a valid SceneSpec
// ---------------------------------------------------------------------------

const fixture = loadFixture()
const fixtureValidation = validateSceneSpec(fixture)

check('the product-turntable fixture is a valid SceneSpec (ok === true)', fixtureValidation.ok === true, codes(fixtureValidation.errors))
check('the fixture produces zero errors', fixtureValidation.errors.length === 0, codes(fixtureValidation.errors))
check('a valid spec reports the summary "valid"', fixtureValidation.summary === 'valid', fixtureValidation.summary)
check(
  'the fixture declares the version this module understands',
  fixture.schemaVersion === SCENE_SCHEMA_VERSION && SCENE_SCHEMA_VERSION === 'deepblend.scene/v1',
  fixture.schemaVersion,
)
check(
  'the two fixture cameras are reported as rotation-ignored notices, not errors',
  fixtureValidation.notices.length === 2
    && fixtureValidation.notices.every(notice => notice.code === 'SCENE_CAMERA_ROTATION_IGNORED'),
  codes(fixtureValidation.notices),
)

// ---------------------------------------------------------------------------
// Structural layer — always SCENE_SCHEMA_INVALID, always naming its keyword
// ---------------------------------------------------------------------------

/** Assert a structural rejection: one error, the right path, the right keyword. */
function checkStructural(label, mutate, path, keyword) {
  const result = validateSceneSpec(fixtureWith(mutate))
  const first = result.errors[0]
  check(
    `${label} is rejected structurally at ${path} [${keyword}]`,
    result.ok === false
      && result.errors.length === 1
      && first.code === 'SCENE_SCHEMA_INVALID'
      && first.path === path
      && first.message.includes(`[${keyword}]`),
    { ok: result.ok, codes: codes(result.errors), path: first?.path, message: first?.message },
  )
}

checkStructural('a missing project', spec => { delete spec.project }, 'project', 'required')
checkStructural('an unknown root property', spec => { spec.extra = 1 }, 'extra', 'additionalProperties')
checkStructural('a bad schemaVersion', spec => { spec.schemaVersion = 'deepblend.scene/v2' }, 'schemaVersion', 'const')
checkStructural('a negative frameEnd', spec => { spec.project.frameEnd = -5 }, 'project.frameEnd', 'minimum')
checkStructural('a three-component resolution', spec => { spec.renderProfiles.preview.resolution = [640, 360, 1080] }, 'renderProfiles.preview.resolution', 'maxItems')
checkStructural('a bad entity.type', spec => { spec.entities[0].type = 'mesh' }, 'entities[0].type', 'enum')

check(
  'a two-component resolution is the required shape and is accepted',
  validateSceneSpec(fixtureWith(spec => { spec.renderProfiles.preview.resolution = [640, 360] })).ok === true,
)

// A malformed document short-circuits before the semantic layer, so a caller
// never has to triage semantic noise against an actual schema violation.
const malformed = validateSceneSpec(fixtureWith(spec => {
  spec.entities[1].id = 'stage'
  spec.unexpected = true
}))
check(
  'a structural failure short-circuits the semantic layer',
  malformed.ok === false
    && malformed.errors.every(error => error.code === 'SCENE_SCHEMA_INVALID')
    && !has(malformed.errors, 'SCENE_ID_DUPLICATE'),
  codes(malformed.errors),
)
check(
  'the structural summary lists every schema issue with its keyword',
  malformed.summary.includes('unexpected') && malformed.summary.includes('[additionalProperties]'),
  malformed.summary,
)

// ---------------------------------------------------------------------------
// Semantic layer — the rules a single-document schema cannot express
// ---------------------------------------------------------------------------

/** Assert a semantic rejection: the code is present at the expected path. */
function checkSemantic(label, mutate, code, path) {
  const result = validateSceneSpec(fixtureWith(mutate))
  check(
    `${label} is rejected with ${code} at ${path}`,
    result.ok === false && has(result.errors, code, path),
    { ok: result.ok, errors: result.errors.map(error => `${error.code}@${error.path}`) },
  )
}

checkSemantic('a duplicate entity id', spec => { spec.entities[1].id = 'stage' }, 'SCENE_ID_DUPLICATE', 'entities[1].id')
checkSemantic('an asset-instance entity with a dangling assetId', spec => {
  spec.entities[0] = { id: 'hero', type: 'asset-instance', assetId: 'nope' }
}, 'SCENE_REFERENCE_MISSING', 'entities[0].assetId')
checkSemantic('an entity naming a material that does not exist', spec => {
  spec.entities[1].materialId = 'ghost'
}, 'SCENE_REFERENCE_MISSING', 'entities[1].materialId')
checkSemantic('a camera whose targetEntityId does not exist', spec => {
  spec.cameras[0].targetEntityId = 'ghost'
}, 'SCENE_REFERENCE_MISSING', 'cameras[0].targetEntityId')
checkSemantic('a shot whose cameraId does not exist', spec => {
  spec.shots[0].cameraId = 'ghost'
}, 'SCENE_REFERENCE_MISSING', 'shots[0].cameraId')
checkSemantic('an animation track whose targetEntityId does not exist', spec => {
  spec.animationTracks[0].targetEntityId = 'ghost'
}, 'SCENE_REFERENCE_MISSING', 'animationTracks[0].targetEntityId')
checkSemantic('a frameEnd equal to frameStart', spec => { spec.project.frameEnd = 1 }, 'SCENE_FRAME_RANGE_INVALID', 'project.frameEnd')
checkSemantic('a camera with neither a location nor a target', spec => {
  delete spec.cameras[0].transform.location
  delete spec.cameras[0].targetEntityId
}, 'SCENE_CAMERA_UNPLACED', 'cameras[0]')
checkSemantic('a zero scale component', spec => { spec.entities[1].transform.scale = [1, 0, 1] }, 'SCENE_SCALE_DEGENERATE', 'entities[1].transform.scale[1]')
checkSemantic('an absolute asset path', spec => {
  spec.assets = [{ id: 'a', type: 'glb', path: '/etc/assets/watch.glb' }]
}, 'SCENE_ASSET_PATH_ABSOLUTE', 'assets[0].path')
checkSemantic('an asset path containing a ".." segment', spec => {
  spec.assets = [{ id: 'a', type: 'glb', path: 'assets/../../watch.glb' }]
}, 'SCENE_ASSET_PATH_TRAVERSAL', 'assets[0].path')

check(
  'a scene with nothing to render is refused', 
  (() => {
    const result = validateSceneSpec(fixtureWith(spec => {
      spec.entities = [{ id: 'marker', type: 'empty' }]
      spec.cameras[0].targetEntityId = 'marker'
      spec.cameras[1].targetEntityId = 'marker'
      spec.animationTracks = []
      spec.shots[0].cameraId = 'camera-main'
    }))
    return result.ok === false && has(result.errors, 'SCENE_HAS_NO_GEOMETRY', 'entities')
  })(),
)

// ---------------------------------------------------------------------------
// Notices — decisions, never failures
// ---------------------------------------------------------------------------

const noMaterial = validateSceneSpec(fixtureWith(spec => { delete spec.entities[1].materialId }))
check(
  'an entity without a materialId validates and raises SCENE_ENTITY_MATERIAL_DEFAULTED',
  noMaterial.ok === true
    && noMaterial.errors.length === 0
    && has(noMaterial.notices, 'SCENE_ENTITY_MATERIAL_DEFAULTED', 'entities[1]'),
  { ok: noMaterial.ok, errors: codes(noMaterial.errors), notices: codes(noMaterial.notices) },
)

// Both fixture cameras declare a target AND a rotationEuler; drop the rotation
// from one of them so the notice can be observed appearing and not appearing.
const withRotation = validateSceneSpec(fixtureWith(spec => {
  delete spec.cameras[1].transform.rotationEuler
}))
check(
  'a camera with both a target and a rotationEuler raises SCENE_CAMERA_ROTATION_IGNORED',
  withRotation.ok === true
    && has(withRotation.notices, 'SCENE_CAMERA_ROTATION_IGNORED', 'cameras[0].transform.rotationEuler'),
  codes(withRotation.notices),
)
check(
  'a camera with a target and no authored rotation is not reported as rotation-ignored',
  !has(withRotation.notices, 'SCENE_CAMERA_ROTATION_IGNORED', 'cameras[1].transform.rotationEuler'),
  codes(withRotation.notices),
)

const noLights = validateSceneSpec(fixtureWith(spec => { spec.lights = [] }))
check(
  'a lightless scene still validates but notifies SCENE_NO_LIGHTS',
  noLights.ok === true && has(noLights.notices, 'SCENE_NO_LIGHTS', 'lights'),
  codes(noLights.notices),
)

// ---------------------------------------------------------------------------
// compileSceneSpec — deterministic, pure, and it resolves the defaults
// ---------------------------------------------------------------------------

const first = compileSceneSpec(loadFixture())
const second = compileSceneSpec(loadFixture())
check(
  'compiling the same input twice gives deep-equal output',
  JSON.stringify(first.spec) === JSON.stringify(second.spec),
)
check(
  'the notice list is identical across compiles',
  JSON.stringify(first.notices) === JSON.stringify(second.notices),
  codes(first.notices),
)

const before = JSON.stringify(fixture)
compileSceneSpec(fixture)
check('compileSceneSpec leaves the input document byte-identical', JSON.stringify(fixture) === before)

const frozenInput = deepFreeze(loadFixture())
const frozenCompile = caught(() => compileSceneSpec(frozenInput))
check('compileSceneSpec does not write into a deep-frozen input', frozenCompile.error === undefined, frozenCompile.error?.message)
check(
  'a frozen input compiles to the same document as a mutable one',
  frozenCompile.value !== undefined && JSON.stringify(frozenCompile.value.spec) === JSON.stringify(first.spec),
)

const planeNoSize = compileSceneSpec(fixtureWith(spec => { delete spec.entities[0].generator.size })).spec
check(
  'a plane with no size gets the documented default size 2',
  planeNoSize.entities[0].generator.shape === 'plane' && planeNoSize.entities[0].generator.size === 2,
  planeNoSize.entities[0].generator,
)

const noTransform = compileSceneSpec(fixtureWith(spec => {
  delete spec.entities[1].transform
  delete spec.entities[1].locked
  delete spec.entities[1].tags
})).spec.entities.find(entity => entity.id === 'watch-body')
check(
  'a missing transform resolves to the identity transform',
  JSON.stringify(noTransform.transform) === JSON.stringify({ location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }),
  noTransform.transform,
)
check(
  'missing entity presentation fields resolve to visible / unlocked / untagged',
  noTransform.visible === true && noTransform.locked === false && JSON.stringify(noTransform.tags) === '[]',
  { visible: noTransform.visible, locked: noTransform.locked, tags: noTransform.tags },
)

const pruned = compileSceneSpec(fixtureWith(spec => {
  delete spec.materials[0].parameters
  delete spec.lights[0].energy
  delete spec.lights[0].color
})).spec
check(
  'a material without parameters gets an empty principled parameter block',
  pruned.materials[0].shader === 'principled' && JSON.stringify(pruned.materials[0].parameters) === '{}',
  pruned.materials[0],
)
check(
  'a light without energy or color gets the documented defaults',
  pruned.lights[0].energy === 500 && JSON.stringify(pruned.lights[0].color) === '[1,1,1]',
  { energy: pruned.lights[0].energy, color: pruned.lights[0].color },
)
check(
  'a sun light without energy defaults to 3 W',
  compileSceneSpec(fixtureWith(spec => { spec.lights[0].type = 'sun'; delete spec.lights[0].energy })).spec.lights[0].energy === 3,
)

// The camera solver: a target with no position is placed deterministically and
// says so; an authored position is honoured verbatim.
const derived = compileSceneSpec(fixtureWith(spec => { delete spec.cameras[0].transform.location }))
const derivedLocation = derived.spec.cameras[0].transform.location
check(
  'a camera with a target and no location is given a finite numeric location',
  Array.isArray(derivedLocation)
    && derivedLocation.length === 3
    && derivedLocation.every(component => Number.isFinite(component)),
  derivedLocation,
)
check(
  'the derived camera position is reported as SCENE_CAMERA_POSITION_DERIVED',
  has(derived.notices, 'SCENE_CAMERA_POSITION_DERIVED', 'cameras.camera-main.transform.location'),
  codes(derived.notices),
)
check(
  'the derived position is reproducible across compiles',
  JSON.stringify(compileSceneSpec(fixtureWith(spec => { delete spec.cameras[0].transform.location })).spec.cameras[0].transform.location)
    === JSON.stringify(derivedLocation),
  derivedLocation,
)
check(
  'a camera that declares its own location keeps it unchanged',
  JSON.stringify(first.spec.cameras[0].transform.location) === JSON.stringify([0, -0.5, 0.2])
    && !has(first.notices, 'SCENE_CAMERA_POSITION_DERIVED'),
  first.spec.cameras[0].transform.location,
)
check(
  'a compiled spec still satisfies validateSceneSpec',
  validateSceneSpec(first.spec).ok === true,
  codes(validateSceneSpec(first.spec).errors),
)
check(
  'the entity bounds carry the analytic radius the camera solver aims at',
  first.entityBounds['watch-body'] !== undefined
    && Number.isFinite(first.entityBounds['watch-body'].radius)
    && JSON.stringify(first.entityBounds['watch-body'].location) === JSON.stringify([0, 0, 0.0185]),
  first.entityBounds['watch-body'],
)

// ---------------------------------------------------------------------------
// sceneSpecDigest — the identity of a scene, not of a brief
// ---------------------------------------------------------------------------

const retitled = fixtureWith(spec => {
  spec.project.title = 'A completely different brief'
  spec.project.goal = 'Reworded by the operator.'
})
check(
  'two specs differing only in project.title/goal share one digest',
  sceneSpecDigest(fixture) === sceneSpecDigest(retitled),
  { before: sceneSpecDigest(fixture), after: sceneSpecDigest(retitled) },
)
check(
  'the digest projection excludes the whole project block',
  !Object.hasOwn(sceneProjection(fixture), 'project'),
  Object.keys(sceneProjection(fixture)),
)
check(
  'a moved entity changes the digest',
  sceneSpecDigest(fixture) !== sceneSpecDigest(fixtureWith(spec => { spec.entities[1].transform.location = [9, 9, 9] })),
)
check('the digest is a 64-character lowercase hex string', /^[0-9a-f]{64}$/.test(sceneSpecDigest(fixture)), sceneSpecDigest(fixture))
check('the fixture digest is the recorded golden value', sceneSpecDigest(fixture) === FIXTURE_DIGEST, sceneSpecDigest(fixture))
check(
  'the compiled fixture digest is the recorded golden value',
  sceneSpecDigest(first.spec) === FIXTURE_COMPILED_DIGEST,
  sceneSpecDigest(first.spec),
)
check(
  'the digest is stable across key reordering of the input',
  sceneSpecDigest(fixture) === sceneSpecDigest(reverseKeys(fixture)),
)
check(
  'a reordered projection is the same projection up to key order',
  canonicalStringify(sceneProjection(reverseKeys(fixture))) === canonicalStringify(sceneProjection(fixture)),
)

// ---------------------------------------------------------------------------
// sceneSpecCanonicalText — the on-disk form
// ---------------------------------------------------------------------------

const canonicalText = sceneSpecCanonicalText(fixture)
check('the canonical text is newline-terminated', canonicalText.endsWith('}\n'), JSON.stringify(canonicalText.slice(-3)))
check(
  'the canonical text parses back to the same document',
  canonicalStringify(JSON.parse(canonicalText)) === canonicalStringify(fixture),
)
check(
  'the canonical text writes keys in sorted order',
  canonicalText.indexOf('"cameras"') < canonicalText.indexOf('"entities"')
    && canonicalText.indexOf('"entities"') < canonicalText.indexOf('"materials"'),
)

// ---------------------------------------------------------------------------
// summarizeSceneSpec — the compact view handed to the model
// ---------------------------------------------------------------------------

const summary = summarizeSceneSpec(first.spec)
check(
  'the summary counts every collection of the fixture',
  JSON.stringify(summary.counts) === JSON.stringify({
    assets: 0, entities: 4, materials: 4, lights: 3, cameras: 2, shots: 1, animationTracks: 3,
  }),
  summary.counts,
)
check(
  'the summary carries the project framing facts',
  summary.project.id === 'fixture-product-turntable'
    && summary.project.fps === 30
    && summary.project.frameStart === 1
    && summary.project.frameEnd === 90
    && summary.project.aspectRatio === '16:9'
    && summary.project.units === 'metric',
  summary.project,
)
check(
  'the summary digest is the compiled spec digest',
  summary.digest === FIXTURE_COMPILED_DIGEST && typeof summary.digest === 'string',
  summary.digest,
)
check(
  'the scene bounds include the 6 m environment plane',
  JSON.stringify(summary.bounds) === JSON.stringify({ min: [-4.2426, -4.2426, -4.2426], max: [4.2426, 4.2426, 4.2426] }),
  summary.bounds,
)
check(
  'subjectBounds excludes the entity tagged "environment"',
  JSON.stringify(summary.subjectBounds) === JSON.stringify({ min: [-0.1732, -0.1732, -0.1547], max: [0.1732, 0.1732, 0.1917] }),
  summary.subjectBounds,
)
check(
  'subjectBounds is strictly inside the environment-only scene bounds',
  summary.subjectBounds.min[0] > summary.bounds.min[0] && summary.subjectBounds.max[2] < summary.bounds.max[2],
)
check(
  'a scene whose entities are all environment has no subject bounds',
  (() => {
    const allEnvironment = summarizeSceneSpec(compileSceneSpec(fixtureWith(spec => {
      for (const entity of spec.entities) entity.tags = ['environment']
    })).spec)
    return allEnvironment.subjectBounds === null
  })(),
)
check(
  'the summary lists one entry per entity with material, location and flags',
  summary.entities.length === 4
    && summary.entities[0].id === 'stage'
    && summary.entities[0].shape === 'plane'
    && summary.entities[0].materialId === 'stage-matte'
    && summary.entities[0].locked === true
    && JSON.stringify(summary.entities[0].tags) === '["environment"]',
  summary.entities[0],
)
check(
  'the summary reports the camera aim and lens',
  summary.cameras.length === 2
    && summary.cameras[0].id === 'camera-main'
    && summary.cameras[0].lens === 70
    && summary.cameras[0].targetEntityId === 'watch-body'
    && summary.cameras[0].targetPoint === null,
  summary.cameras[0],
)
check(
  'the summary reduces an animation track to its keyframe count and frame range',
  JSON.stringify(summary.animationTracks[0]) === JSON.stringify({
    id: 'watch-turntable', targetEntityId: 'watch-body', property: 'rotationEuler.z', keyframeCount: 3, frameRange: [1, 90],
  }),
  summary.animationTracks[0],
)
check(
  'the summary passes the render profiles through unchanged',
  JSON.stringify(summary.renderProfiles) === JSON.stringify(first.spec.renderProfiles),
)
check(
  'revision and revisionNumber default to null',
  summary.revision === null && summary.revisionNumber === null,
  { revision: summary.revision, revisionNumber: summary.revisionNumber },
)
check(
  'an explicit revision context overrides the defaults',
  summarizeSceneSpec(first.spec, { revision: 'r0007', revisionNumber: 7 }).revision === 'r0007'
    && summarizeSceneSpec(first.spec, { revision: 'r0007', revisionNumber: 7 }).revisionNumber === 7,
)
check(
  'a supplied digest overrides the computed one',
  summarizeSceneSpec(first.spec, { digest: 'deadbeef' }).digest === 'deadbeef',
)

// ---------------------------------------------------------------------------
// The frozen vocabulary
// ---------------------------------------------------------------------------

check('SCENE_ENGINES is frozen and lists the three render engines', Object.isFrozen(SCENE_ENGINES)
  && JSON.stringify(SCENE_ENGINES) === JSON.stringify(['eevee', 'cycles', 'workbench']), SCENE_ENGINES)
check(
  'every SCENE_ENGINES key maps to a Blender engine identifier',
  SCENE_ENGINES.every(key => typeof BLENDER_ENGINE_BY_KEY[key] === 'string')
    && BLENDER_ENGINE_BY_KEY.cycles === 'CYCLES'
    && BLENDER_ENGINE_BY_KEY.eevee === 'BLENDER_EEVEE'
    && BLENDER_ENGINE_BY_KEY.workbench === 'BLENDER_WORKBENCH',
  BLENDER_ENGINE_BY_KEY,
)
check(
  'the fixture only uses engines from SCENE_ENGINES',
  Object.values(first.spec.renderProfiles).every(profile => SCENE_ENGINES.includes(profile.engine)),
  Object.values(first.spec.renderProfiles).map(profile => profile.engine),
)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`scene-spec contract: ${results.length - failures}/${results.length} check(s) passed`)
if (failures > 0) {
  console.log('Failed checks:')
  for (const result of results) if (!result.ok) console.log(`  - ${result.name}`)
}
process.exit(failures > 0 ? 1 : 0)
