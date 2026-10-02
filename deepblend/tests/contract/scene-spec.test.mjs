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
  entityBoundingRadius,
  sceneProjection,
  sceneSpecCanonicalText,
  sceneSpecDigest,
  sha256Canonical,
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

// ---------------------------------------------------------------------------
// 9. The semantic refusals a MODEL meets — every branch, and the words it reads
// ---------------------------------------------------------------------------

// WHY THIS SECTION EXISTS (round 39). The coverage reading showed every one of these branches dark:
// a model that writes an asset-instance without an assetId, both camera targets, a shot range that
// runs backwards, a keyframe out of its property's range or out of order, a material track animating
// a transform channel — none of those refusals had ever been produced by a test. They are the product's
// TEACHING surface (the message is what the model reads before rewriting the spec), so each case below
// asserts the code, the path, and that the message says what would fix it.

// AN ID THAT FAILS THE PATTERN NEVER REACHES THE SEMANTIC LAYER, and that is asserted rather than
// assumed: the JSON Schema's `pattern` is the same expression the validator uses
// (`^[a-zA-Z][a-zA-Z0-9._-]*$`, checked while writing this), so `SCENE_ID_INVALID` is DEFENSIVE — it
// fires only if the schema is ever relaxed. Pinning the behaviour here means loosening the schema turns
// this check red instead of quietly making the message below it dead.
{
  const shadowed = validateSceneSpec(fixtureWith(spec => { spec.entities[0].id = '-not-an-id' }))
  check('an id that fails the pattern is refused STRUCTURALLY, before any semantic rule can speak',
    shadowed.ok === false && shadowed.errors.length === 1 && shadowed.errors[0].code === 'SCENE_SCHEMA_INVALID',
    { codes: codes(shadowed.errors) })
}
checkSemantic('an asset-instance that names no asset', spec => {
  spec.entities[0] = { id: 'hero', type: 'asset-instance' }
}, 'SCENE_ENTITY_ASSET_REQUIRED', 'entities[0].assetId')
checkSemantic('an asset-instance that ALSO declares a generator', spec => {
  spec.entities[0] = { id: 'hero', type: 'asset-instance', assetId: 'watch', generator: { shape: 'cube', size: 1 } }
}, 'SCENE_ENTITY_GENERATOR_CONFLICT', 'entities[0].generator')
checkSemantic('a generator entity with no generator block', spec => { delete spec.entities[0].generator },
  'SCENE_ENTITY_GENERATOR_REQUIRED', 'entities[0].generator')
checkSemantic('an assetId on an entity that is not an asset-instance', spec => { spec.entities[0].assetId = 'watch' },
  'SCENE_ENTITY_ASSET_UNUSED', 'entities[0].assetId')
checkSemantic('a camera aiming at a point AND an entity', spec => { spec.cameras[0].targetPoint = [0, 0, 0] },
  'SCENE_CAMERA_TARGET_AMBIGUOUS', 'cameras[0]')
checkSemantic('a camera whose clip start is beyond its clip end', spec => { spec.cameras[0].clipping = [10, 1] },
  'SCENE_CAMERA_CLIPPING_INVALID', 'cameras[0].clipping')
checkSemantic('a shot whose frame range runs backwards', spec => { spec.shots[0].frameRange = [90, 1] },
  'SCENE_SHOT_FRAME_RANGE_INVALID', 'shots[0].frameRange')
checkSemantic('a material track animating a transform channel', spec => {
  spec.animationTracks[0].targetKind = 'material'
}, 'SCENE_ANIMATION_PROPERTY_INVALID', 'animationTracks[0].property')
checkSemantic('a keyframe below a property that cannot go negative', spec => {
  spec.animationTracks[0] = {
    id: 'ramp', targetKind: 'material', targetEntityId: 'stage-matte', property: 'emissionStrength',
    keyframes: [{ frame: 1, value: 0, interpolation: 'linear' }, { frame: 30, value: -1, interpolation: 'linear' }],
  }
}, 'SCENE_KEYFRAME_VALUE_OUT_OF_RANGE', 'animationTracks[0].keyframes[1].value')
checkSemantic('a keyframe above the unit range', spec => {
  spec.animationTracks[0] = {
    id: 'ramp', targetKind: 'material', targetEntityId: 'stage-matte', property: 'roughness',
    keyframes: [{ frame: 1, value: 0, interpolation: 'linear' }, { frame: 30, value: 2, interpolation: 'linear' }],
  }
}, 'SCENE_KEYFRAME_VALUE_OUT_OF_RANGE', 'animationTracks[0].keyframes[1].value')
checkSemantic('keyframes that do not strictly increase', spec => {
  spec.animationTracks[0].keyframes[2].frame = spec.animationTracks[0].keyframes[1].frame
}, 'SCENE_KEYFRAMES_UNORDERED', 'animationTracks[0].keyframes[2].frame')

// The messages are the part a model acts on, so two of them are pinned by what they must SAY.
{
  const negative = validateSceneSpec(fixtureWith(spec => {
    spec.animationTracks[0] = {
      id: 'ramp', targetKind: 'material', targetEntityId: 'stage-matte', property: 'emissionStrength',
      // Two keyframes, because the schema requires at least two — a single one is refused structurally
      // and this case would then be asserting nothing about the VALUE rule (measured while writing it).
      keyframes: [
        { frame: 1, value: 0, interpolation: 'linear' },
        { frame: 30, value: -2, interpolation: 'linear' },
      ],
    }
  }))
  const message = negative.errors.find(error => error.code === 'SCENE_KEYFRAME_VALUE_OUT_OF_RANGE')?.message ?? ''
  check('the negative-value refusal quotes the property and the value it saw',
    message.includes('emissionStrength') && message.includes('-2'), message)

  const wrongKind = validateSceneSpec(fixtureWith(spec => { spec.animationTracks[0].targetKind = 'material' }))
  const kindMessage = wrongKind.errors.find(error => error.code === 'SCENE_ANIMATION_PROPERTY_INVALID')?.message ?? ''
  check('the wrong-property refusal names the kind AND lists what that kind does support, so a fix needs no second lookup',
    kindMessage.includes('material') && kindMessage.includes('emissionStrength') && kindMessage.includes('roughness'),
    kindMessage)
}

// A spec that is valid in every one of these respects must stay clean — the negative control for the
// whole section, without which every case above could be passing for the wrong reason.
{
  const clean = validateSceneSpec(fixtureWith(spec => {
    spec.animationTracks.push({
      id: 'dial-ramp', targetKind: 'material', targetEntityId: 'stage-matte', property: 'roughness',
      keyframes: [{ frame: 1, value: 0, interpolation: 'linear' }, { frame: 30, value: 0.5, interpolation: 'linear' }],
    })
    spec.cameras[0].clipping = [0.1, 100]
    spec.shots[0].frameRange = [1, 45]
  }))
  check('a spec with a legal material ramp, clipping and shot range is still valid — the negative control',
    clean.ok === true, { ok: clean.ok, errors: clean.errors.map(error => `${error.code}@${error.path}`) })
}

// ---------------------------------------------------------------------------
// The compiler's defaults, and the one branch the SCHEMA answers first
// ---------------------------------------------------------------------------
//
// A SceneSpec that names a generator this build does not know is not an error: the shape is passed through
// untouched for the Python side to refuse, and the ONLY thing the Node side may do with it is leave it alone.
// "Invent nothing" is the rule the whole file is built on, so the check asserts both halves — the shape
// arrives unchanged AND no default fields appeared beside it.

const oddShape = {
  ...compileSceneSpec(loadFixture()).spec,
  // `size: 7` rather than the schema's default, so that "nothing was added" and "nothing was OVERWRITTEN"
  // are the same assertion: a default branch that quietly filled in `size: 1` would pass on an input whose
  // size was already 1 (which is how the first version of this check let that mutation live).
  entities: [{ id: 'weird', type: 'generator', generator: { shape: 'dodecahedron', size: 7 }, transform: { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [2, 1, 1] } }],
}
const oddCompiled = compileSceneSpec(oddShape)
check('a generator shape this build does not know is passed through UNTOUCHED, with no fields invented or overwritten',
  JSON.stringify(oddCompiled.spec?.entities?.[0]?.generator) === JSON.stringify({ shape: 'dodecahedron', size: 7 }),
  oddCompiled.spec?.entities?.[0]?.generator)
// The bounding radius is what the visual review ranks subjects by (D46's defect was a cylinder scored as a
// sphere), so an unknown shape must fall back to a NAMED 1 rather than to 0 or to a guess: the scale is
// still applied, which is what makes the fallback defensible instead of arbitrary.
check('an unknown shape has a bounding radius of 1 × the largest scale, not 0 and not a guess',
  entityBoundingRadius({ generator: { shape: 'dodecahedron' }, transform: { scale: [2, 1, 1] } }) === 2 &&
  entityBoundingRadius({ generator: { shape: 'cube', size: 2 }, transform: { scale: [1, 1, 1] } }) === Math.sqrt(3),
  { unknown: entityBoundingRadius({ generator: { shape: 'dodecahedron' }, transform: { scale: [2, 1, 1] } }),
    cube: entityBoundingRadius({ generator: { shape: 'cube', size: 2 }, transform: { scale: [1, 1, 1] } }) })

// Every light type has a defensible default in watts, and the two that were never exercised are the ones a
// MOVEABLE rig uses: a point light and a spot. Unfilled, they would compile to `energy: undefined` and the
// renderer would receive a light with no intensity.
const rigged = {
  ...compileSceneSpec(loadFixture()).spec,
  lights: [
    { id: 'key-point', type: 'point', transform: { location: [1, 0, 2] } },
    { id: 'key-spot', type: 'spot', transform: { location: [0, 0, 3] } },
  ],
}
const riggedCompiled = compileSceneSpec(rigged)
check('a point light and a spot get their own default wattage instead of compiling with no energy',
  JSON.stringify(riggedCompiled.spec?.lights?.map(light => light.energy)) === JSON.stringify([100, 200]),
  riggedCompiled.spec?.lights?.map(light => light.energy))

// SHADOWED, AND NAMED RATHER THAN PRETENDED COVERED: the validator's `SCENE_ID_INVALID` check (a collection
// entry whose id does not match the id grammar) cannot fire, because the JSON schema rejects the same id
// first — measured on all seven collections (entities, materials, lights, cameras, shots, animationTracks,
// assets and render-profile names all answer SCENE_SCHEMA_INVALID). The check below therefore asserts the
// ORDER, which is the fact a reader needs; the branch itself is dead code the schema has made unreachable.
// AND THE COMMENT SAYS SEVEN COLLECTIONS WHILE THE CODE DROVE ONE. The sentence above was true when it was
// written (somebody measured all seven by hand) but the assertion only ever rigged `entities[0]` — a claim with
// seven sides and a check with one. This drives every collection the uniqueness pass walks, so a collection that
// stopped being schema-checked would show up here instead of in a sentence.
const collectionsWithIds = ['entities', 'materials', 'lights', 'cameras', 'shots', 'animationTracks', 'assets']
const grammarViolations = []
for (const collection of collectionsWithIds) {
  const rigged = compileSceneSpec(loadFixture()).spec
  // The fixture declares no assets, so one is injected rather than the collection being skipped: a collection
  // that is not driven is a side of this claim nobody checked, which is the whole reason the sentence above was
  // seven-sided while the code was one-sided.
  if (collection === 'assets' && (rigged.assets ?? []).length === 0) {
    rigged.assets = [{ id: 'rigged-asset', type: 'mesh', path: 'assets/rigged.glb', sha256: 'a'.repeat(64) }]
  }
  const entries = rigged[collection]
  if (!Array.isArray(entries) || entries.length === 0 || typeof entries[0]?.id !== 'string') {
    grammarViolations.push(`${collection}: the fixture has no entry with a string id to rig`)
    continue
  }
  entries[0].id = 'Bad Id!'
  const outcome = validateSceneSpec(rigged)
  const codes = outcome.errors.map(error => error.code)
  if (!codes.includes('SCENE_SCHEMA_INVALID') || codes.includes('SCENE_ID_INVALID')) {
    grammarViolations.push(`${collection}: ${outcome.errors.map(e => `${e.code}@${e.path}`).join(' ')}`)
  }
}
check('an id the grammar forbids is refused by the SCHEMA in EVERY collection, so the validator never fires',
  grammarViolations.length === 0, grammarViolations)

// AND THE DARK LINE ITSELF: `if (typeof id !== 'string') return` in the uniqueness pass. It is unreachable
// because the schema declares `$defs.id` as a string, so a NUMBER never reaches the semantic layer — the schema
// answers first. That is the property this asserts, on every collection, because "the schema covers it" is
// exactly the kind of claim that rots when a collection is added without the id reference.
const typeViolations = []
for (const collection of collectionsWithIds) {
  const rigged = compileSceneSpec(loadFixture()).spec
  if (collection === 'assets' && (rigged.assets ?? []).length === 0) {
    rigged.assets = [{ id: 'rigged-asset', type: 'mesh', path: 'assets/rigged.glb', sha256: 'a'.repeat(64) }]
  }
  const entries = rigged[collection]
  if (!Array.isArray(entries) || entries.length === 0) {
    typeViolations.push(`${collection}: nothing to rig`)
    continue
  }
  entries[0].id = 42
  const codes = validateSceneSpec(rigged).errors.map(error => error.code)
  if (!codes.includes('SCENE_SCHEMA_INVALID') || codes.includes('SCENE_ID_INVALID')) {
    typeViolations.push(`${collection}: ${codes.join(' ')}`)
  }
}
check('a NON-STRING id is refused by the schema in every collection, which is why that branch is dark',
  typeViolations.length === 0, typeViolations)

console.log('')
// ---------------------------------------------------------------------------
// ARMATURES (SPEC §20 M6, character animation) — the first slice
//
// The spec can declare a skeleton and the compiler creates it. WHAT THIS SLICE
// DOES NOT DO is bind a mesh to a bone or animate one; those are the next
// slices, and the schema says so where a reader looking for skinning will find
// it, rather than leaving them to discover it.
//
// The two functions answer different questions and this block needs both:
// `validateSceneSpec` decides whether a document is a legal SceneSpec (schema,
// then semantics) and `compileSceneSpec` produces the canonical form. A refusal
// belongs to the first; "it still compiles" belongs to the second.
// ---------------------------------------------------------------------------

const withArmature = (armatures) => {
  // THE FILE'S OWN FIXTURE CONSTANT, not a path built here: this suite already reads that fixture and
  // pins its digests, and a second way of finding the same file is how the two drift apart.
  const spec = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  if (armatures !== undefined) spec.armatures = armatures
  return spec
}

const bone = (overrides = {}) => ({ name: 'hips', head: [0, 0, 0], tail: [0, 0, 0.2], ...overrides })

check('a SceneSpec may declare an armature, and a minimal one is a legal spec',
  validateSceneSpec(withArmature([{ id: 'hero-rig', bones: [bone()] }])).ok === true,
  validateSceneSpec(withArmature([{ id: 'hero-rig', bones: [bone()] }])).errors)

check('an armature with NO bones is refused, because a rig that cannot move anything is silently useless',
  validateSceneSpec(withArmature([{ id: 'hero-rig', bones: [] }])).ok === false,
  'an armature with no bones was accepted')

check('a bone without a name is refused, because a parent names its child by that name',
  validateSceneSpec(withArmature([{ id: 'hero-rig', bones: [bone({ name: undefined })] }])).ok === false,
  'a bone with no name was accepted')

check('a bone without a tail is refused, because a bone with no direction is not a bone',
  validateSceneSpec(withArmature([{ id: 'hero-rig', bones: [bone({ tail: undefined })] }])).ok === false,
  'a bone with no tail was accepted')

check('and a scene with no armatures still compiles, so this slice costs nothing to scenes that have none',
  compileSceneSpec(withArmature(undefined)).spec !== undefined &&
  compileSceneSpec(withArmature([])).spec !== undefined,
  'a scene without armatures no longer compiles')

check('an armature survives canonicalisation, so the rig is part of what a revision commits',
  JSON.stringify(compileSceneSpec(withArmature([{ id: 'hero-rig', bones: [bone()] }])).spec.armatures) ===
  JSON.stringify([{ id: 'hero-rig', bones: [bone()] }]),
  compileSceneSpec(withArmature([{ id: 'hero-rig', bones: [bone()] }])).spec.armatures)

{
  // A FEATURE THAT IS PARTIALLY DONE HAS TO SAY SO WHERE A READER LOOKS. The armature description is
  // that place: somebody reading the schema to find out how to skin a mesh learns that they cannot yet.
  const schema = JSON.parse(readFileSync(
    resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
    'utf8',
  ))
  const description = schema.properties.armatures.description
  // RETIRED, AND WHY: this asserted that the schema said skinning was NOT done yet — a transitional
  // sentence, and a check that pins one has a lifetime. Character animation is complete as of the bone
  // slice, so that sentence is gone and this check with it. The check at the end of this file asserts
  // the completed state instead: that the schema says the item IS done and does not still claim otherwise.
  check('and the bone definition requires what a bone is: a name, a head and a tail',
    ['name', 'head', 'tail'].every(key => schema.$defs.bone.required.includes(key)),
    schema.$defs.bone.required)
}

// ---------------------------------------------------------------------------
// SKINNING — the second slice: an entity can be bound to an armature
//
// The relation is what the spec states ("this entity is skinned to that armature"),
// and the weights are Blender's own automatic answer to it. A weight table in the
// spec would be a hand-written copy of something Blender computes from the
// geometry, and the copy is the one that goes stale.
// ---------------------------------------------------------------------------

const withRigAndSkin = (armatureId) => {
  const spec = withArmature([{ id: 'hero-rig', bones: [bone()] }])
  spec.entities = spec.entities.map((entity, index) =>
    index === 0 ? { ...entity, armatureId } : entity)
  return spec
}

check('an entity may name the armature it is skinned to',
  validateSceneSpec(withRigAndSkin('hero-rig')).ok === true,
  validateSceneSpec(withRigAndSkin('hero-rig')).errors)

check('and naming an armature the scene does not declare is refused, not ignored',
  validateSceneSpec(withRigAndSkin('no-such-rig')).ok === false,
  'an entity was skinned to an armature nobody declares, which would render static while claiming to be rigged')

// RETIRED TOO, for the same reason: it asserted the schema still NAMED what was missing ("animate a
// bone"), and nothing is missing now.

// ---------------------------------------------------------------------------
// BONE ANIMATION — the last slice: the rig moves, and so does its mesh
//
// A bone track targets the ARMATURE (the bones belong to it) and names the bone.
// Both halves are cross-references the schema cannot express: it can say the ids
// are strings, and only a lookup can say they name things the scene declares.
// ---------------------------------------------------------------------------

const withBoneTrack = (overrides) => {
  const spec = withRigAndSkin('hero-rig')
  spec.animationTracks = [
    ...(spec.animationTracks ?? []),
    {
      id: 'chest-lift', targetKind: 'bone', targetEntityId: 'hero-rig', boneName: 'hips',
      property: 'rotationEuler.x',
      keyframes: [{ frame: 1, value: 0, interpolation: 'linear' }, { frame: 10, value: 1, interpolation: 'linear' }],
      ...overrides,
    },
  ]
  return spec
}

check('an animation track may drive a bone of an armature',
  validateSceneSpec(withBoneTrack({})).ok === true,
  validateSceneSpec(withBoneTrack({})).errors)

check('a bone track that names no bone is refused, because it would animate nothing',
  validateSceneSpec(withBoneTrack({ boneName: undefined })).ok === false,
  'a bone track with no bone name was accepted')

check('a bone track naming a bone the armature does not have is refused',
  validateSceneSpec(withBoneTrack({ boneName: 'no-such-bone' })).ok === false,
  validateSceneSpec(withBoneTrack({ boneName: 'no-such-bone' })).errors)

check('a bone track targeting an armature nobody declares is refused too',
  validateSceneSpec(withBoneTrack({ targetEntityId: 'no-such-rig' })).ok === false,
  'a bone track pointed at an armature that does not exist')

check('and the schema says the whole item is done rather than leaving a stale "not yet"',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    const description = schema.properties.armatures.description
    return /ARE skinned|skinned to an armature/i.test(description) &&
      /animation tracks can drive a bone|can drive a bone/i.test(description) &&
      !/NOT DO YET/.test(description)
  })(),
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'), 'utf8')).properties.armatures.description.slice(0, 200))

// ---------------------------------------------------------------------------
// COMPLEX SIMULATION, the first slice: rigid bodies
//
// The spec says which things move and which things they hit; the compiler bakes
// the result into the checkpoint, because an unbaked simulation is a SETTING and a
// batch render of one shows the initial pose.
// ---------------------------------------------------------------------------

const withBodies = (bodies) => {
  const spec = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  spec.entities = spec.entities.map((entity, index) => ({ ...entity, ...(bodies[index] ?? {}) }))
  return spec
}

check('an entity may be an active body, and one may be what it lands on',
  validateSceneSpec(withBodies([{ rigidBody: { kind: 'passive' } }, { rigidBody: { kind: 'active', mass: 0.1 } }])).ok === true,
  validateSceneSpec(withBodies([{ rigidBody: { kind: 'passive' } }, { rigidBody: { kind: 'active', mass: 0.1 } }])).errors)

check('a body kind that is not active or passive is refused by the schema',
  validateSceneSpec(withBodies([{ rigidBody: { kind: 'ghost' } }])).ok === false,
  'a body kind the compiler has no answer for was accepted')

check('a mass of zero or less is refused, because a body with no mass is not a body',
  validateSceneSpec(withBodies([{ rigidBody: { kind: 'active', mass: 0 } }])).ok === false &&
  validateSceneSpec(withBodies([{ rigidBody: { kind: 'active', mass: -1 } }])).ok === false,
  'a non-positive mass was accepted')

check('the schema says what the simulation slice does AND does not do',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    // `entities` is an array whose items are a `$ref` to `$defs.entity`, so the field lives in the
    // definition rather than inline — reading through `items.properties` finds nothing.
    const description = schema.$defs.entity.properties.rigidBody.description
    return /rigid bodies/i.test(description) && /cloth|soft bodies|fluids/i.test(description) &&
      /bake/i.test(description)
  })(),
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'), 'utf8')).$defs.entity.properties.rigidBody.description.slice(0, 200))

// ---------------------------------------------------------------------------
// CLOTH — the second slice of complex simulation
//
// A different field from `rigidBody` because it is a different MECHANISM: a
// rigid body is a body type on the object, while cloth is a modifier that
// deforms the mesh. The spec says the relationship ("hang this"), and the
// compiler builds the vertex group Blender needs from the geometry.
// ---------------------------------------------------------------------------

const withCloth = (cloth) => {
  const spec = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  spec.entities = spec.entities.map((entity, index) => (index === 0 ? { ...entity, cloth } : entity))
  return spec
}

check('an entity may be simulated as fabric',
  validateSceneSpec(withCloth({ pinTop: true })).ok === true,
  validateSceneSpec(withCloth({ pinTop: true })).errors)

check('and cloth with no settings at all is legal, because every setting has a Blender default',
  validateSceneSpec(withCloth({})).ok === true,
  validateSceneSpec(withCloth({})).errors)

check('a negative mass and a stiffness outside 0 to 1 are refused',
  validateSceneSpec(withCloth({ mass: -1 })).ok === false &&
  validateSceneSpec(withCloth({ stiffness: 2 })).ok === false,
  'a cloth setting outside what the solver can use was accepted')

check('the schema says cloth and rigid bodies are different mechanisms, and names what is still missing',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    const description = schema.$defs.entity.properties.cloth.description
    return /different mechanism/i.test(description) && /soft bodies|fluids/i.test(description)
  })(),
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'), 'utf8')).$defs.entity.properties.cloth.description.slice(0, 200))

// ---------------------------------------------------------------------------
// SOFT BODIES — the third slice of complex simulation
//
// The third mechanism, and the third measured behaviour: cloth moves without a
// bake, a soft body does not, and a soft body REMEMBERS ITS SHAPE while it falls
// (`goal`), which is what separates it from cloth.
// ---------------------------------------------------------------------------

const withSoftBody = (softBody) => {
  const spec = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  spec.entities = spec.entities.map((entity, index) => (index === 0 ? { ...entity, softBody } : entity))
  return spec
}

check('an entity may be simulated as a soft body',
  validateSceneSpec(withSoftBody({})).ok === true,
  validateSceneSpec(withSoftBody({})).errors)

check('a goal outside 0 to 1 is refused, because it is a fraction of how much shape is remembered',
  validateSceneSpec(withSoftBody({ goal: 2 })).ok === false &&
  validateSceneSpec(withSoftBody({ goal: -0.5 })).ok === false,
  'a goal the solver cannot use was accepted')

check('the schema says a soft body is not cloth, and names fluids as the last thing missing',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    const description = schema.$defs.entity.properties.softBody.description
    return /not cloth|separates it from cloth|remembers its shape/i.test(description) && /fluid/i.test(description)
  })(),
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'), 'utf8')).$defs.entity.properties.softBody.description.slice(0, 200))

check('and the three mechanisms are three fields, so a file cannot say two things about one entity',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    const entity = schema.$defs.entity
    // `additionalProperties: false` is what makes them exclusive: an entity cannot carry a rigidBody
    // and a cloth and be two simulations at once without the file saying which one it meant.
    return entity.additionalProperties === false &&
      ['rigidBody', 'cloth', 'softBody'].every(key => entity.properties[key] !== undefined)
  })(),
  'the three simulation fields are not all present or the definition is no longer closed')

// ---------------------------------------------------------------------------
// FLUIDS — the last slice of complex simulation, and the only one that needs
// more than one entity: a domain and something flowing into it.
// ---------------------------------------------------------------------------

const withFluid = (entries) => {
  const spec = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  spec.entities = spec.entities.map((entity, index) => (entries[index] === undefined ? entity : { ...entity, fluid: entries[index] }))
  return spec
}

check('a domain and an inflow are both legal fluid roles',
  validateSceneSpec(withFluid([{ role: 'domain' }, { role: 'inflow' }])).ok === true,
  validateSceneSpec(withFluid([{ role: 'domain' }, { role: 'inflow' }])).errors)

check('a role the compiler has no answer for is refused by the schema',
  validateSceneSpec(withFluid([{ role: 'puddle' }])).ok === false,
  'a fluid role with no meaning was accepted')

check('a fluid entity with no role at all is refused, because the role is what says which half it is',
  validateSceneSpec(withFluid([{}])).ok === false,
  'a fluid entity without a role was accepted')

check('the schema states that the default domain type is liquid, and that Blender defaulting to gas is why',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    const description = schema.$defs.fluid.properties.domainType.description
    return /liquid/i.test(description) && /gas/i.test(description) && /nothing/i.test(description)
  })(),
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'), 'utf8')).$defs.fluid.properties.domainType.description.slice(0, 200))

check('and four mechanisms are four fields, all present on a closed entity definition',
  (() => {
    const schema = JSON.parse(readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas', 'scene-spec.schema.json'),
      'utf8',
    ))
    const entity = schema.$defs.entity
    return entity.additionalProperties === false &&
      ['rigidBody', 'cloth', 'softBody', 'fluid'].every(key => entity.properties[key] !== undefined)
  })(),
  'the four simulation fields are not all present, or the definition is no longer closed')

const latheSpec = fixtureWith(spec => {
  spec.entities[0].generator = { shape: 'lathe', profile: [[0, 0], [1, 0], [1, 2], [0, 2]] }
})
const latheCompiled = compileSceneSpec(latheSpec)
const vessel = compileSceneSpec(JSON.parse(readFileSync(resolve(import.meta.dirname,
  '..', '..', 'fixtures', 'ceramic-vessel', 'scene-spec.json'), 'utf8'))).spec
check('the ceramic vessel fixture compiles with a modeled inner wall and consistent preview/final color',
  vessel.entities[0].generator.profile.length > 20 &&
  vessel.renderProfiles.preview.colorManagement.viewTransform === vessel.renderProfiles.final.colorManagement.viewTransform)
check('lathe geometry validates and resolves reproducible quality defaults',
  latheCompiled.spec.entities[0].generator.segments === 96 &&
  latheCompiled.spec.entities[0].generator.capEnds === true)
check('lathe camera bounds include the full profile height and radius',
  Math.abs(entityBoundingRadius({ generator: latheCompiled.spec.entities[0].generator }) - Math.sqrt(5)) < 1e-10)
check('profile changes affect the scene digest',
  sceneSpecDigest(latheSpec) !== sceneSpecDigest({ ...latheSpec, entities: latheSpec.entities.map((e, i) =>
    i ? e : { ...e, generator: { ...e.generator, profile: [[0, 0], [1, 0], [1, 3], [0, 3]] } }) }))
for (const generator of [
  { shape: 'lathe' },
  { shape: 'lathe', profile: [[-1, 0], [1, 2]] },
  { shape: 'lathe', profile: [[1, 0], [1, 0], [1, 2]] },
  { shape: 'lathe', profile: [[0, 0], [0, 2]] },
  { shape: 'lathe', profile: [[1, 0], [2, 0]] },
  { shape: 'lathe', profile: [[1, 0], [1, 2], [1, 1]] },
  { shape: 'lathe', profile: [[1, 0], [2, 2], [1, 2], [2, 0]] },
  { shape: 'lathe', closedProfile: true, profile: [[1, 0], [2, 2], [1, 0]] },
  { shape: 'cube', profile: [[1, 0], [1, 2]] },
]) {
  const rejected = fixtureWith(spec => { spec.entities[0].generator = generator })
  check(`invalid profile is refused before Blender: ${JSON.stringify(generator)}`,
    validateSceneSpec(rejected).errors.some(error => error.code === 'SCENE_GENERATOR_PROFILE_INVALID'))
}

const curveSpec = fixtureWith(spec => {
  spec.entities[0].generator = { shape: 'curve', path: [[0, 0, 0], [1, 0, 2]], radius: 0.05 }
})
const curveCompiled = compileSceneSpec(curveSpec).spec.entities[0].generator
check('curve defaults preserve authored points, radius and capped polyline geometry',
  curveCompiled.pathInterpolation === 'poly' && curveCompiled.capEnds === true && curveCompiled.radius === 0.05)
check('curve bounds include the swept section',
  Math.abs(entityBoundingRadius({ generator: curveCompiled }) - Math.sqrt(5) - 0.05) < 1e-10)
for (const generator of [
  { shape: 'curve' },
  { shape: 'curve', path: [[0, 0, 0], [0, 0, 0]] },
  { shape: 'curve', path: [[0, 0, 0], [1, 0, 0], [0, 0, 0]] },
  { shape: 'curve', pathClosed: true, path: [[0, 0, 0], [1, 0, 0]] },
  { shape: 'curve', pathClosed: true, path: [[0, 0, 0], [1, 0, 1], [0, 0, 0]] },
  { shape: 'cube', path: [[0, 0, 0], [1, 0, 0]] },
]) {
  check(`invalid curve path is refused: ${JSON.stringify(generator)}`,
    validateSceneSpec(fixtureWith(spec => { spec.entities[0].generator = generator })).errors
      .some(error => error.code === 'SCENE_GENERATOR_PATH_INVALID'))
}

// Modeling stacks must reject dangling/cyclic dependencies before Blender runs.
const modifierSpec = fixtureWith(spec => {
  spec.entities[0].modifiers = [
    { type: 'solidify', thickness: 0.02 },
    { type: 'mirror', axis: 'x' },
    { type: 'array', count: 3, offset: [2, 0, 0] },
    { type: 'boolean', operation: 'union', targetEntityId: spec.entities[1].id },
    { type: 'bevel', width: 0.003, segments: 6, angle: 30 },
  ]
})
check('ordered modeling stacks validate and survive compilation',
  compileSceneSpec(modifierSpec).spec.entities[0].modifiers.length === 5)
const legacyBevelSpec = fixtureWith(spec => {
  spec.entities[0].modifiers = [{ type: 'bevel', width: 0.003, segments: 6, angle: 30 }]
})
const legacyBevelBefore = JSON.stringify(legacyBevelSpec)
const legacyBevelCompiled = compileSceneSpec(legacyBevelSpec).spec
const bevelSchema = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../schemas/scene-spec.schema.json'), 'utf8'))
  .$defs.modelModifier.oneOf.find(branch => branch.properties.type.const === 'bevel')
check('bevel modifier declares arc as its backward-compatible default', bevelSchema.properties.miterInner.default === 'arc')
check('compiling an omitted inner miter preserves the old document and does not materialize a new field',
  !Object.hasOwn(legacyBevelCompiled.entities[0].modifiers[0], 'miterInner') && JSON.stringify(legacyBevelSpec) === legacyBevelBefore)
check('legacy bevel compiled geometry and whole-document hashes remain unchanged',
  sceneSpecDigest(legacyBevelCompiled) === '53e07f9b62018e1c8965cc2088fe5f9840688e0a9818e209cfc8370106db72bd' &&
  sha256Canonical(legacyBevelCompiled) === '88857b895a56197693cf3a524361c72302c1a3231b693c37b20ecc9765208f27')
const innerMiterCompiled = {}
for (const miterInner of ['arc', 'sharp']) {
  const authored = clone(legacyBevelSpec)
  authored.entities[0].modifiers[0].miterInner = miterInner
  check(`bevel modifier accepts explicit ${miterInner} inner corners`, validateSceneSpec(authored).ok)
  innerMiterCompiled[miterInner] = compileSceneSpec(authored).spec
  check(`compilation preserves the explicit ${miterInner} setting and complete modifier stack`,
    JSON.stringify(innerMiterCompiled[miterInner].entities[0].modifiers) === JSON.stringify(authored.entities[0].modifiers))
}
check('changing the inner miter changes both geometric identity and the document hash',
  sceneSpecDigest(innerMiterCompiled.arc) !== sceneSpecDigest(innerMiterCompiled.sharp) &&
  sha256Canonical(innerMiterCompiled.arc) !== sha256Canonical(innerMiterCompiled.sharp))
for (const modifier of [
  { type: 'bevel', width: 0.01, miterInner: 'patch' },
  { type: 'bevel', width: 0.01, miterInner: 'ARC' },
  { type: 'bevel', width: 0.01, miterInner: null },
  { type: 'bevel', width: 0.01, miterInner: 0 },
  { type: 'solidify', thickness: 0.01, miterInner: 'sharp' },
  { type: 'mirror', axis: 'x', miterInner: 'sharp' },
  { type: 'array', count: 2, offset: [1, 0, 0], miterInner: 'sharp' },
  { type: 'boolean', operation: 'difference', targetEntityId: legacyBevelSpec.entities[1].id, miterInner: 'sharp' },
  { type: 'bevel', width: 0.01, miterOuter: 'sharp' },
]) {
  check(`inner miter vocabulary stays strict and modifier-specific: ${JSON.stringify(modifier)}`,
    validateSceneSpec(fixtureWith(spec => { spec.entities[0].modifiers = [modifier] })).errors
      .some(error => error.code === 'SCENE_SCHEMA_INVALID'))
}
for (const generator of [
  { shape: 'rounded_box', bevel: { width: 0.01, miterInner: 'sharp' } },
  { shape: 'cube', miterInner: 'sharp' },
]) {
  check(`generator does not accept modifier inner miter fields: ${JSON.stringify(generator)}`,
    validateSceneSpec(fixtureWith(spec => { spec.entities[0].generator = generator })).errors
      .some(error => error.code === 'SCENE_SCHEMA_INVALID'))
}
const curvedBoreSpec = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/curved-bore/scene-spec.json'), 'utf8'))
const curvedBoreCompiled = compileSceneSpec(curvedBoreSpec)
const curvedBoreBody = curvedBoreCompiled.spec.entities.find(entity => entity.id === 'body')
const curvedBoreAuthoredBody = curvedBoreSpec.entities.find(entity => entity.id === 'body')
check('the public curved-bore fixture validates and compiles without notices',
  validateSceneSpec(curvedBoreSpec).ok && curvedBoreCompiled.notices.length === 0)
check('curved-bore compilation preserves the authored geometry and ordered Boolean/bevel stack',
  JSON.stringify(curvedBoreBody.generator) === JSON.stringify(curvedBoreAuthoredBody.generator) &&
  JSON.stringify(curvedBoreBody.modifiers) === JSON.stringify(curvedBoreAuthoredBody.modifiers) &&
  curvedBoreCompiled.spec.entities.find(entity => entity.id === 'bore-tool').visible === false)
check('the public fixture binds its body and applies sharp only to the bevel modifier',
  curvedBoreCompiled.spec.project.reviewSubjectId === 'body' &&
  curvedBoreBody.modifiers.find(modifier => modifier.type === 'bevel').miterInner === 'sharp' &&
  !Object.hasOwn(curvedBoreBody.generator, 'miterInner') && !Object.hasOwn(curvedBoreBody.generator.bevel, 'miterInner'))
for (const modifier of [
  { type: 'solidify', thickness: 0 },
  { type: 'bevel', width: 0 },
  { type: 'bevel', width: -1 },
  { type: 'bevel', width: 0.01, segments: 17 },
  { type: 'bevel', width: 0.01, angle: 181 },
  { type: 'array', count: 2, offset: [0, 0, 0] },
  { type: 'boolean', operation: 'union', targetEntityId: 'missing-operand' },
  { type: 'mirror', axis: 'w' },
  { type: 'array', count: 65, offset: [1, 0, 0] },
]) {
  check(`invalid modeling operation is refused: ${JSON.stringify(modifier)}`,
    validateSceneSpec(fixtureWith(spec => { spec.entities[0].modifiers = [modifier] })).errors.length > 0)
}
check('boolean dependency cycles are refused', validateSceneSpec(fixtureWith(spec => {
  spec.entities[0].modifiers = [{ type: 'boolean', operation: 'union', targetEntityId: spec.entities[1].id }]
  spec.entities[1].modifiers = [{ type: 'boolean', operation: 'union', targetEntityId: spec.entities[0].id }]
})).errors.some(error => error.code === 'SCENE_MODIFIER_CYCLE'))
const framing = order => compileSceneSpec(fixtureWith(spec => {
  spec.entities[0].transform = { location: [0, 0, 0] }
  spec.entities[1].transform = { location: [100, 0, 0] }
  const union = { type: 'boolean', operation: 'union', targetEntityId: spec.entities[1].id }
  const array = { type: 'array', count: 3, offset: [10, 0, 0] }
  spec.entities[0].modifiers = order ? [union, array] : [array, union]
  spec.cameras[0].targetEntityId = spec.entities[0].id
  delete spec.cameras[0].transform
})).spec.cameras[0].transform.location
check('auto framing expands arrays applied after distant boolean unions',
  Math.hypot(...framing(true)) > Math.hypot(...framing(false)))

const imageSpec = fixtureWith(spec => {
  spec.assets = [{ id: 'map', type: 'png', path: 'assets/raw/map.png' }]
  spec.materials[0].images = { baseColor: { assetId: 'map' }, roughness: { assetId: 'map', channel: 'g' }, normal: { assetId: 'map', strength: .5 } }
})
check('PBR image bindings validate and survive scene compilation', validateSceneSpec(imageSpec).ok &&
  compileSceneSpec(imageSpec).spec.materials[0].images.roughness.channel === 'g')
for (const [label, change] of [
  ['missing image', spec => { spec.materials[0].images.baseColor.assetId = 'missing' }],
  ['model as texture', spec => { spec.assets[0].type = 'glb' }],
  ['scalar strength', spec => { spec.materials[0].images.roughness.strength = .4 }],
  ['normal channel', spec => { spec.materials[0].images.normal.channel = 'g' }],
  ['conflicting procedural map', spec => { spec.materials[0].texture = { type: 'noise', scale: 3 } }],
  ['image mesh instance', spec => { spec.entities.push({ id: 'image-mesh', type: 'asset-instance', assetId: 'map' }) }],
]) {
  const invalid = structuredClone(imageSpec); change(invalid)
  check(`PBR maps reject ${label}`, !validateSceneSpec(invalid).ok)
}

const environmentSpec = fixtureWith(spec => {
  spec.assets = [{ id: 'studio-env', type: 'exr', path: 'assets/raw/studio.exr' }]
  spec.world = { strength: 1.5, environment: { assetId: 'studio-env', rotation: 1.57 } }
})
check('an EXR environment validates and survives scene compilation and summary',
  validateSceneSpec(environmentSpec).ok && compileSceneSpec(environmentSpec).spec.world.environment.rotation === 1.57 &&
  summarizeSceneSpec(environmentSpec).world.environment.assetId === 'studio-env')
for (const type of ['glb', 'obj']) {
  const invalid = structuredClone(environmentSpec); invalid.assets[0].type = type
  check(`environment rejects ${type} geometry assets`, !validateSceneSpec(invalid).ok)
}
const missingEnvironment = structuredClone(environmentSpec); missingEnvironment.assets = []
check('environment rejects a missing asset', !validateSceneSpec(missingEnvironment).ok)


const bindingSpec = fixtureWith(spec => {
  spec.assets = [{ id: 'assembly', type: 'glb', path: 'assets/raw/assembly.glb' }]
  spec.entities.push({ id: 'assembly', type: 'asset-instance', assetId: 'assembly', materialBindings: [
    { partId: '/body', materialId: 'hero-steel' }, { partId: '/body', slotIndex: 1, materialId: 'stage-matte' }] })
})
check('part-wide and slot-specific bindings coexist and survive compilation and summary', validateSceneSpec(bindingSpec).ok &&
  compileSceneSpec(bindingSpec).spec.entities.at(-1).materialBindings.length === 2 &&
  summarizeSceneSpec(bindingSpec).entities.at(-1).materialBindings[1].slotIndex === 1)
for (const [label, change] of [
  ['wrong entity type', spec => { spec.entities[0].materialBindings = [] }],
  ['missing material', spec => { spec.entities.at(-1).materialBindings[0].materialId = 'absent' }],
  ['duplicate part', spec => { spec.entities.at(-1).materialBindings.push(spec.entities.at(-1).materialBindings[0]) }],
  ['negative slot', spec => { spec.entities.at(-1).materialBindings[1].slotIndex = -1 }],
  ['non-path selector', spec => { spec.entities.at(-1).materialBindings[0].partId = 'body' }],
]) {
  const invalid = structuredClone(bindingSpec); change(invalid)
  check(`part bindings reject ${label}`, !validateSceneSpec(invalid).ok)
}

// Actual anisotropic reflection has an explicit tangent; zero remains a disable state.
const anisotropySpec = fixtureWith(spec => {
  const material = spec.materials.find(entry => entry.id === 'hero-steel')
  material.parameters.anisotropic = 0.8
  material.parameters.anisotropicRotation = 0.25
  material.tangent = { mode: 'radial', axis: 'z' }
})
check('Principled anisotropy compiles and remains discoverable with its direction', validateSceneSpec(anisotropySpec).ok &&
  compileSceneSpec(anisotropySpec).spec.materials.find(entry => entry.id === 'hero-steel').parameters.anisotropic === 0.8 &&
  summarizeSceneSpec(anisotropySpec).materials.find(entry => entry.id === 'hero-steel').tangent.axis === 'z')
const uvAnisotropy = structuredClone(anisotropySpec)
uvAnisotropy.materials.find(entry => entry.id === 'hero-steel').tangent = { mode: 'uv', uvMap: 'BrushedUV' }
check('named UV direction is legal and changes the scene digest', validateSceneSpec(uvAnisotropy).ok &&
  sceneSpecDigest(uvAnisotropy) !== sceneSpecDigest(anisotropySpec))
for (const [label, change] of [
  ['missing tangent', material => { delete material.tangent }],
  ['emission material', material => { material.shader = 'emission' }],
  ['negative strength', material => { material.parameters.anisotropic = -0.1 }],
  ['strength above one', material => { material.parameters.anisotropic = 1.1 }],
  ['rotation in radians rather than turns', material => { material.parameters.anisotropicRotation = Math.PI }],
  ['UV without name', material => { material.tangent = { mode: 'uv' } }],
  ['empty UV name', material => { material.tangent = { mode: 'uv', uvMap: '' } }],
  ['radial without axis', material => { material.tangent = { mode: 'radial' } }],
  ['invented axis', material => { material.tangent = { mode: 'radial', axis: 'world-z' } }],
  ['mixed direction modes', material => { material.tangent = { mode: 'uv', uvMap: 'UVMap', axis: 'z' } }],
]) {
  const bad = structuredClone(anisotropySpec); change(bad.materials.find(entry => entry.id === 'hero-steel'))
  check(`anisotropy rejects ${label}`, !validateSceneSpec(bad).ok)
}
const disabledAnisotropy = structuredClone(anisotropySpec)
const disabledMaterial = disabledAnisotropy.materials.find(entry => entry.id === 'hero-steel')
disabledMaterial.parameters.anisotropic = 0; disabledMaterial.parameters.anisotropicRotation = 0; delete disabledMaterial.tangent
check('zero anisotropy and rotation need no tangent', validateSceneSpec(disabledAnisotropy).ok)
for (const property of ['anisotropic', 'anisotropicRotation']) {
  const animated = structuredClone(anisotropySpec)
  animated.animationTracks.push({ id: 'animate-' + property, targetKind: 'material', targetEntityId: 'hero-steel', property,
    keyframes: [{ frame: 1, value: 0 }, { frame: 24, value: 0.75 }, { frame: 48, value: 0 }] })
  check(`material ${property} animation is supported`, validateSceneSpec(animated).ok)
  const invalid = structuredClone(animated); invalid.animationTracks.at(-1).keyframes[1].value = 1.5
  check(`${property} animation cannot exceed one`, validateSceneSpec(invalid).errors.some(error => error.code === 'SCENE_KEYFRAME_VALUE_OUT_OF_RANGE'))
  const noDirection = structuredClone(disabledAnisotropy); noDirection.animationTracks.push(animated.animationTracks.at(-1))
  check(`animation enabling ${property} requires direction before rendering`, !validateSceneSpec(noDirection).ok)
}

console.log(`scene-spec contract: ${results.length - failures}/${results.length} check(s) passed`)
if (failures > 0) {
  console.log('Failed checks:')
  for (const result of results) if (!result.ok) console.log(`  - ${result.name}`)
}
process.exit(failures > 0 ? 1 : 0)
