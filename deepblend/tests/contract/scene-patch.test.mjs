#!/usr/bin/env node
/**
 * M1 contract tests — ScenePatch v1 (`validateScenePatch`, `applyPatchToSpec`,
 * `buildOperationManifest`, `SCENE_OPERATION_NAMES`).
 *
 * Pure unit tests: no Blender, no subprocess, no network, no filesystem writes.
 * Every case is applied to the compiled product-turntable fixture, so the ops
 * are exercised against the document the M1 pipeline actually writes.
 *
 * The contract this file exists to defend:
 *
 *  1. **Purity.** `applyPatchToSpec` mutates NOTHING — not on success, and not
 *     when an operation fails halfway through. That property is what makes
 *     "失败不污染当前 Revision" (SPEC §13.2) structural rather than a promise the
 *     error path has to remember. Every case below is checked for it, including
 *     a patch whose SECOND operation fails after its first succeeded.
 *  2. **Atomicity.** The first failing operation aborts the whole patch with an
 *     anchored `patchIssue.code`, never a partial result.
 *  3. **Coverage of the declared vocabulary.** Every name in
 *     `SCENE_OPERATION_NAMES` is actually implemented — a declared-but-unhandled
 *     op would fall through to `PATCH_OPERATION_UNKNOWN` at runtime.
 *  4. **Audit records.** Each applied operation yields
 *     `{ op, target, summary, changedPaths }`, and the returned digests bracket
 *     the change, because `operation-manifest.json` (SPEC §8.4) is built from
 *     exactly these.
 *
 * Run standalone: `node deepblend/tests/contract/scene-patch.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  SCENE_OPERATION_NAMES,
  applyPatchToSpec,
  buildOperationManifest,
  compileSceneSpec,
  sceneSpecDigest,
  validateScenePatch,
  validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'

/** The compiled fixture spec: every default materialised, as a real patch expects. */
const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'product-turntable',
  'scene-spec.json',
)

// ---------------------------------------------------------------------------
// Harness — a `results` array, `[PASS]`/`[FAIL]` lines, a summary, and a
// non-zero exit. The counting form the M1 contract files were specified with,
// also used by `deepblend/tests/composition/*.e2e.mjs`; `run.mjs` only reads the
// exit code, so both styles coexist.
// ---------------------------------------------------------------------------

const results = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
}

/** A fresh compiled fixture. `compileSceneSpec` is pure, so this is the base document. */
function compiledFixture() {
  return compileSceneSpec(loadFixture()).spec
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Run `fn`, returning either its value or the error it threw. */
function caught(fn) {
  try {
    return { value: fn() }
  } catch (error) {
    return { error }
  }
}

/** The patch envelope every case is wrapped in, unless it overrides a field. */
const BASE_PATCH = Object.freeze({
  projectId: 'fixture-product-turntable',
  baseRevision: 'r0001',
  idempotencyKey: 'k-contract-0001',
})

function patchWith(operations, overrides = {}) {
  return { ...BASE_PATCH, operations, ...overrides }
}

/**
 * Apply `operations` to `options.spec` (a compiled fixture by default) while
 * snapshotting both the spec and the patch, so purity is asserted for every
 * single case rather than only where someone remembered.
 */
function runPatch(operations, options = {}) {
  const spec = options.spec ?? compiledFixture()
  const patch = patchWith(operations, options.overrides)
  const specBefore = JSON.stringify(spec)
  const patchBefore = JSON.stringify(patch)

  const outcome = caught(() => applyPatchToSpec(spec, patch))

  return {
    spec,
    patch,
    outcome,
    result: outcome.value,
    next: outcome.value?.spec,
    error: outcome.error,
    errorCode: outcome.error?.patchIssue?.code,
    specUnchanged: JSON.stringify(spec) === specBefore,
    patchUnchanged: JSON.stringify(patch) === patchBefore,
  }
}

/** Look one entity up in the returned spec. */
function entity(next, id) {
  return next.entities.find(candidate => candidate.id === id)
}

// ---------------------------------------------------------------------------
// validateScenePatch — structural rejection, before any project state is read
// ---------------------------------------------------------------------------

const validPatch = patchWith([{ op: 'entity.visibility.set', entityId: 'stage', visible: false }])
const validResult = validateScenePatch(validPatch)
check('a well-formed patch validates', validResult.ok === true, validResult.errors)
check('a valid patch reports the summary "valid"', validResult.summary === 'valid', validResult.summary)
check('a valid patch produces no errors', validResult.errors.length === 0, validResult.errors)

/** Assert a rejection: the right code, path, and schema keyword where relevant. */
function checkPatchRejection(label, patch, code, path, keyword) {
  const result = validateScenePatch(patch)
  const first = result.errors[0]
  check(
    `${label} is rejected with ${code} at ${path}${keyword !== undefined ? ` [${keyword}]` : ''}`,
    result.ok === false
      && first !== undefined
      && first.code === code
      && first.path === path
      && (keyword === undefined || first.message.includes(`[${keyword}]`)),
    { ok: result.ok, errors: result.errors, summary: result.summary },
  )
}

// `idempotencyKey` is OPTIONAL in the current schema: when the caller omits it,
// one is derived from {projectId, baseRevision, actor, stage, operations}, so an
// accidental retry is safe by default. A key that is *supplied* must still be a
// non-blank string.
checkPatchRejection(
  'an explicit idempotencyKey: undefined',
  { ...validPatch, idempotencyKey: undefined },
  'PATCH_SCHEMA_INVALID', 'idempotencyKey', 'type',
)
check(
  'omitting idempotencyKey entirely is accepted (one is derived downstream)',
  validateScenePatch({
    projectId: BASE_PATCH.projectId,
    baseRevision: BASE_PATCH.baseRevision,
    operations: validPatch.operations,
  }).ok === true,
)
checkPatchRejection(
  'an empty idempotencyKey string',
  patchWith(validPatch.operations, { idempotencyKey: '' }),
  'PATCH_SCHEMA_INVALID', 'idempotencyKey', 'minLength',
)
checkPatchRejection(
  'a whitespace-only idempotencyKey',
  patchWith(validPatch.operations, { idempotencyKey: '   ' }),
  'PATCH_IDEMPOTENCY_KEY_BLANK', 'idempotencyKey',
)
checkPatchRejection(
  'a baseRevision of "r12"',
  patchWith(validPatch.operations, { baseRevision: 'r12' }),
  'PATCH_SCHEMA_INVALID', 'baseRevision', 'pattern',
)
checkPatchRejection(
  'a baseRevision that is not a revision id at all',
  patchWith(validPatch.operations, { baseRevision: 'latest' }),
  'PATCH_SCHEMA_INVALID', 'baseRevision', 'pattern',
)
checkPatchRejection(
  'an empty operations list',
  patchWith([]),
  'PATCH_SCHEMA_INVALID', 'operations', 'minItems',
)
checkPatchRejection(
  'an unknown op name',
  patchWith([{ op: 'entity.explode', entityId: 'stage' }]),
  'PATCH_SCHEMA_INVALID', 'operations[0]', 'oneOf',
)
checkPatchRejection(
  'an entity.transform.update with no components',
  patchWith([{ op: 'entity.transform.update', entityId: 'watch-body' }]),
  'PATCH_OPERATION_EMPTY', 'operations[0]',
)
checkPatchRejection(
  'a light.update with no fields to change',
  patchWith([{ op: 'light.update', lightId: 'key-light' }]),
  'PATCH_OPERATION_EMPTY', 'operations[0]',
)
checkPatchRejection(
  'a camera.update with no fields to change',
  patchWith([{ op: 'camera.update', cameraId: 'camera-main' }]),
  'PATCH_OPERATION_EMPTY', 'operations[0]',
)
checkPatchRejection(
  'a camera.update naming both aim sources',
  patchWith([{ op: 'camera.update', cameraId: 'camera-main', targetEntityId: 'watch-body', targetPoint: [0, 0, 0] }]),
  'PATCH_CAMERA_TARGET_AMBIGUOUS', 'operations[0]',
)
checkPatchRejection(
  'an operation carrying an id that breaks the id grammar',
  patchWith([{ op: 'entity.visibility.set', entityId: '9bad id', visible: true }]),
  'PATCH_SCHEMA_INVALID', 'operations[0]', 'oneOf',
)
check(
  'the rejection summary names the failing path and message',
  validateScenePatch(patchWith([{ op: 'entity.transform.update', entityId: 'watch-body' }])).summary
    .startsWith('operations[0]: entity.transform.update must supply'),
  validateScenePatch(patchWith([{ op: 'entity.transform.update', entityId: 'watch-body' }])).summary,
)
check(
  'a baseRevision of the form r0001 is accepted',
  validateScenePatch(patchWith(validPatch.operations, { baseRevision: 'r0001' })).ok === true,
)
check(
  'a four-digit revision id is the minimum accepted form',
  validateScenePatch(patchWith(validPatch.operations, { baseRevision: 'r000' })).ok === false
    && validateScenePatch(patchWith(validPatch.operations, { baseRevision: 'r0000' })).ok === true,
)
// KNOWN IMPLEMENTATION DEAD CODE — see report: `PATCH_BASE_REVISION_INVALID` can
// never fire, because the JSON Schema `pattern` rejects every string that the
// semantic regex would reject, and validateScenePatch returns early on any
// structural error. This check pins that observation.
check(
  'KNOWN IMPLEMENTATION DEAD CODE: PATCH_BASE_REVISION_INVALID is unreachable',
  validateScenePatch(patchWith(validPatch.operations, { baseRevision: 'r12' })).errors
    .every(error => error.code !== 'PATCH_BASE_REVISION_INVALID'),
  validateScenePatch(patchWith(validPatch.operations, { baseRevision: 'r12' })).errors.map(error => error.code),
)

// ---------------------------------------------------------------------------
// Every declared operation — behaviour
// ---------------------------------------------------------------------------

/** Records which operation names a real patch exercised successfully. */
const exercisedOperations = new Set()

/** Apply a case that is expected to succeed, asserting uniformity first. */
function applied(label, operations, options) {
  const run = runPatch(operations, options)
  if (run.error !== undefined) {
    check(`${label} applies cleanly`, false, run.error.message)
    return run
  }
  for (const operation of operations) exercisedOperations.add(operation.op)
  return run
}

// ---- entity.transform.update ---------------------------------------------
const moved = applied('entity.transform.update', [
  { op: 'entity.transform.update', entityId: 'watch-body', location: [0.25, -0.75, 0.5] },
])
check(
  'entity.transform.update sets the supplied component exactly',
  JSON.stringify(entity(moved.next, 'watch-body').transform.location) === JSON.stringify([0.25, -0.75, 0.5]),
  entity(moved.next, 'watch-body').transform.location,
)
check(
  'entity.transform.update preserves the components it was not given',
  JSON.stringify(entity(moved.next, 'watch-body').transform.rotationEuler) === JSON.stringify([-1.5707963, 0, 0])
    && JSON.stringify(entity(moved.next, 'watch-body').transform.scale) === JSON.stringify([1, 0.185, 1]),
  entity(moved.next, 'watch-body').transform,
)
check(
  'entity.transform.update leaves every other entity untouched',
  JSON.stringify(moved.next.entities.filter(candidate => candidate.id !== 'watch-body'))
    === JSON.stringify(moved.spec.entities.filter(candidate => candidate.id !== 'watch-body')),
)
check(
  'entity.transform.update records the changed path',
  JSON.stringify(moved.result.operations[0].changedPaths) === JSON.stringify(['entities.watch-body.transform.location']),
  moved.result.operations[0].changedPaths,
)
check(
  'entity.transform.update changes the scene digest',
  moved.result.digestAfter !== moved.result.digestBefore,
)

const equalTransform = { location: [0, 0, 0.0185], rotationEuler: [-1.5707963, 0, 0], scale: [1, 0.185, 1] }
const noop = applied('entity.transform.update with identical values', [
  { op: 'entity.transform.update', entityId: 'watch-body', ...equalTransform },
])
check(
  'a no-op transform update reports no changed path',
  JSON.stringify(noop.result.operations[0].changedPaths) === JSON.stringify([]),
  noop.result.operations[0].changedPaths,
)
check(
  'a no-op transform update says the values already matched',
  noop.result.operations[0].summary.includes('already matched the requested values'),
  noop.result.operations[0].summary,
)
check(
  'a no-op transform update leaves digestAfter === digestBefore',
  noop.result.digestAfter === noop.result.digestBefore,
)
check(
  'a no-op transform update returns the same entities',
  JSON.stringify(noop.next.entities) === JSON.stringify(noop.spec.entities),
)
check(
  'a no-op transform update has the same scene digest as the input',
  sceneSpecDigest(noop.next) === sceneSpecDigest(noop.spec),
)

const partial = applied('entity.transform.update with a partially matching component', [
  { op: 'entity.transform.update', entityId: 'watch-body', location: [0, 0, 0.9] },
])
check(
  'a component that differs in one axis is replaced whole',
  JSON.stringify(entity(partial.next, 'watch-body').transform.location) === JSON.stringify([0, 0, 0.9]),
  entity(partial.next, 'watch-body').transform.location,
)

// ---- entity.visibility.set ----------------------------------------------
const hidden = applied('entity.visibility.set', [
  { op: 'entity.visibility.set', entityId: 'stage', visible: false },
])
check(
  'entity.visibility.set hides exactly the named entity',
  entity(hidden.next, 'stage').visible === false
    && hidden.next.entities.filter(candidate => candidate.visible === true).length === 3,
  hidden.next.entities.map(candidate => `${candidate.id}:${candidate.visible}`),
)
check(
  'entity.visibility.set records the visibility path',
  JSON.stringify(hidden.result.operations[0].changedPaths) === JSON.stringify(['entities.stage.visible']),
  hidden.result.operations[0].changedPaths,
)

// ---- entity.tags.set ----------------------------------------------------
//
// The operation exists because tags are LOAD-BEARING, not metadata: `environment`
// decides what may occlude the subject, `hero-product` marks it, and `subject-part`
// says an entity is part of the subject's own body. Until this existed, a mistagged
// scene could only be fixed by recreating the project — the same gap `role` had.
const tagged = applied('entity.tags.set', [
  { op: 'entity.tags.set', entityId: 'watch-body', tags: ['hero-product', 'subject-part'] },
])
check(
  'entity.tags.set replaces the whole tag list',
  JSON.stringify(entity(tagged.next, 'watch-body').tags) === JSON.stringify(['hero-product', 'subject-part']),
  entity(tagged.next, 'watch-body').tags,
)
check(
  'entity.tags.set records the tags path and reports what it replaced',
  JSON.stringify(tagged.result.operations[0].changedPaths) === JSON.stringify(['entities.watch-body.tags'])
    && /were/.test(tagged.result.operations[0].summary),
  tagged.result.operations[0].summary,
)
check(
  'entity.tags.set touches exactly one entity and leaves the rest byte-identical',
  JSON.stringify(tagged.next.entities.filter(candidate => candidate.id !== 'watch-body'))
  === JSON.stringify(compiledFixture().entities.filter(candidate => candidate.id !== 'watch-body')),
  tagged.next.entities.map(candidate => candidate.id),
)

const untagged = applied('entity.tags.set with an empty list', [
  { op: 'entity.tags.set', entityId: 'watch-body', tags: [] },
])
check(
  'an empty tag list REMOVES the key rather than storing tags: []',
  // Absent means "declares no intent"; an empty array would be a second way to say the
  // same thing, and two documents that mean the same thing must serialize identically
  // (D21, and the digest that follows from it).
  untagged.next.entities.find(candidate => candidate.id === 'watch-body').tags === undefined
    && !Object.prototype.hasOwnProperty.call(
      untagged.next.entities.find(candidate => candidate.id === 'watch-body'), 'tags',
    ),
  untagged.next.entities.find(candidate => candidate.id === 'watch-body'),
)

// ---- entity.add / entity.remove -----------------------------------------
const added = applied('entity.add', [{
  op: 'entity.add',
  entity: {
    id: 'backdrop',
    type: 'generator',
    generator: { shape: 'plane', size: 3 },
    materialId: 'stage-matte',
    transform: { location: [0, 1, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
  },
}])
check(
  'entity.add inserts the entity with its generator intact',
  added.next.entities.length === 5
    && JSON.stringify(entity(added.next, 'backdrop').generator) === JSON.stringify({ shape: 'plane', size: 3 }),
  added.next.entities.map(candidate => candidate.id),
)
check(
  'entity.add records the added entity path',
  JSON.stringify(added.result.operations[0].changedPaths) === JSON.stringify(['entities.backdrop']),
  added.result.operations[0].changedPaths,
)

const removed = applied('entity.remove after its animation track is removed', [
  { op: 'animation.track.remove', trackId: 'crown-turntable' },
  { op: 'entity.remove', entityId: 'watch-crown' },
])
check(
  'entity.remove drops the entity when its dependents are gone',
  removed.next.entities.length === 3 && entity(removed.next, 'watch-crown') === undefined,
  removed.next.entities.map(candidate => candidate.id),
)
check(
  'operations are applied in order, so dependent removal can precede it',
  removed.result.operations.length === 2
    && removed.result.operations[0].op === 'animation.track.remove'
    && removed.result.operations[1].op === 'entity.remove',
  removed.result.operations.map(operation => operation.op),
)

const roundTrip = applied('entity.add then entity.remove', [
  { op: 'entity.add', entity: { id: 'scratch', type: 'empty' } },
  { op: 'entity.remove', entityId: 'scratch' },
])
check(
  'adding and removing the same entity returns the original entity set',
  JSON.stringify(roundTrip.next.entities.map(candidate => candidate.id).sort())
    === JSON.stringify(roundTrip.spec.entities.map(candidate => candidate.id).sort()),
  roundTrip.next.entities.map(candidate => candidate.id),
)

// ---- entity.material.set -------------------------------------------------
const assigned = applied('entity.material.set', [
  { op: 'entity.material.set', entityId: 'stage', materialId: 'hero-steel' },
])
check(
  'entity.material.set assigns the named material',
  entity(assigned.next, 'stage').materialId === 'hero-steel',
  entity(assigned.next, 'stage').materialId,
)
check(
  'entity.material.set records the material path',
  JSON.stringify(assigned.result.operations[0].changedPaths) === JSON.stringify(['entities.stage.materialId']),
  assigned.result.operations[0].changedPaths,
)

const cleared = applied('entity.material.set with null', [
  { op: 'entity.material.set', entityId: 'stage', materialId: null },
])
check(
  'entity.material.set with null removes the materialId key entirely',
  Object.hasOwn(entity(cleared.next, 'stage'), 'materialId') === false,
  entity(cleared.next, 'stage'),
)
check(
  'a cleared material re-validates as the defaulted-material notice',
  validateSceneSpec(cleared.next).ok === true
    && validateSceneSpec(cleared.next).notices.some(notice => notice.code === 'SCENE_ENTITY_MATERIAL_DEFAULTED'),
  validateSceneSpec(cleared.next).notices.map(notice => notice.code),
)

// ---- material.add / material.parameter.update ----------------------------
const materialAdded = applied('material.add', [
  { op: 'material.add', material: { id: 'chrome', shader: 'glass', parameters: { roughness: 0.05, ior: 1.45 } } },
])
check(
  'material.add appends the material with its parameters',
  materialAdded.next.materials.length === 5
    && JSON.stringify(materialAdded.next.materials.find(material => material.id === 'chrome').parameters)
      === JSON.stringify({ roughness: 0.05, ior: 1.45 }),
  materialAdded.next.materials.map(material => material.id),
)
check(
  'material.add fills an empty parameter block when none is given',
  JSON.stringify(applied('material.add without parameters', [
    { op: 'material.add', material: { id: 'flat', shader: 'emission' } },
  ]).next.materials.find(material => material.id === 'flat').parameters) === '{}',
)

const parameterUpdated = applied('material.parameter.update', [
  { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.9 },
])
check(
  'material.parameter.update sets the named parameter',
  materialUpdatedValue(parameterUpdated.next, 'hero-steel', 'roughness') === 0.9,
  materialUpdatedValue(parameterUpdated.next, 'hero-steel', 'roughness'),
)
check(
  'material.parameter.update preserves the other parameters',
  materialUpdatedValue(parameterUpdated.next, 'hero-steel', 'metallic') === 0.9
    && JSON.stringify(materialUpdatedValue(parameterUpdated.next, 'hero-steel', 'baseColor'))
      === JSON.stringify([0.5, 0.525, 0.56, 1]),
  parameterUpdated.next.materials.find(material => material.id === 'hero-steel').parameters,
)
check(
  'material.parameter.update records the parameter path',
  JSON.stringify(parameterUpdated.result.operations[0].changedPaths)
    === JSON.stringify(['materials.hero-steel.parameters.roughness']),
  parameterUpdated.result.operations[0].changedPaths,
)

/** @returns {unknown} one material parameter from the returned spec. */
function materialUpdatedValue(next, id, parameter) {
  return next.materials.find(material => material.id === id).parameters[parameter]
}

// ---- light.add / light.update / light.remove -----------------------------
const lightAdded = applied('light.add', [{
  op: 'light.add',
  light: {
    id: 'kicker',
    type: 'spot',
    energy: 120,
    spotSize: 0.6,
    transform: { location: [1, 1, 1], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
  },
}])
check(
  'light.add inserts the light with its type and energy',
  lightAdded.next.lights.length === 4
    && lightAdded.next.lights.find(light => light.id === 'kicker').energy === 120
    && lightAdded.next.lights.find(light => light.id === 'kicker').type === 'spot',
  lightAdded.next.lights.map(light => light.id),
)

const lightSpec = compiledFixture()
lightSpec.lights[0].transform.rotationEuler = [0.1, 0.2, 0.3]
const lightUpdated = applied('light.update', [
  { op: 'light.update', lightId: 'key-light', energy: 120, transform: { location: [0.9, -1.2, 1] } },
], { spec: lightSpec })
check(
  'light.update sets the supplied scalar fields',
  lightUpdated.next.lights.find(light => light.id === 'key-light').energy === 120,
  lightUpdated.next.lights.find(light => light.id === 'key-light').energy,
)
check(
  'light.update merges the transform instead of replacing it',
  JSON.stringify(lightUpdated.next.lights.find(light => light.id === 'key-light').transform)
    === JSON.stringify({ location: [0.9, -1.2, 1], rotationEuler: [0.1, 0.2, 0.3], scale: [1, 1, 1] }),
  lightUpdated.next.lights.find(light => light.id === 'key-light').transform,
)
check(
  'light.update preserves fields it was not given',
  lightUpdated.next.lights.find(light => light.id === 'key-light').size === 0.9
    && JSON.stringify(lightUpdated.next.lights.find(light => light.id === 'key-light').color)
      === JSON.stringify([1, 0.97, 0.93, 1]),
  lightUpdated.next.lights.find(light => light.id === 'key-light'),
)

const lightRemoved = applied('light.remove', [{ op: 'light.remove', lightId: 'rim-light' }])
check(
  'light.remove drops exactly the named light',
  lightRemoved.next.lights.length === 2 && lightRemoved.next.lights.every(light => light.id !== 'rim-light'),
  lightRemoved.next.lights.map(light => light.id),
)

// ---- camera.add / camera.update / camera.remove --------------------------
const cameraAdded = applied('camera.add', [{
  op: 'camera.add',
  camera: {
    id: 'camera-detail',
    lens: 85,
    transform: { location: [0.1, -0.2, 0.1], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    targetEntityId: 'watch-dial',
  },
}])
check(
  'camera.add inserts the camera with its aim',
  cameraAdded.next.cameras.length === 3
    && cameraAdded.next.cameras.find(camera => camera.id === 'camera-detail').targetEntityId === 'watch-dial',
  cameraAdded.next.cameras.map(camera => camera.id),
)

const cameraUpdated = applied('camera.update', [
  { op: 'camera.update', cameraId: 'camera-main', lens: 85 },
])
check(
  'camera.update sets the supplied lens',
  cameraUpdated.next.cameras.find(camera => camera.id === 'camera-main').lens === 85,
  cameraUpdated.next.cameras.find(camera => camera.id === 'camera-main').lens,
)
check(
  'camera.update preserves the transform and clipping it was not given',
  JSON.stringify(cameraUpdated.next.cameras.find(camera => camera.id === 'camera-main').transform)
    === JSON.stringify({ location: [0, -0.5, 0.2], rotationEuler: [0, 0, 0], scale: [1, 1, 1] })
    && JSON.stringify(cameraUpdated.next.cameras.find(camera => camera.id === 'camera-main').clipping)
      === JSON.stringify([0.05, 100]),
  cameraUpdated.next.cameras.find(camera => camera.id === 'camera-main'),
)

const cameraRemoved = applied('camera.add then camera.remove', [
  { op: 'camera.add', camera: { id: 'camera-tmp' } },
  { op: 'camera.remove', cameraId: 'camera-tmp' },
])
check(
  'camera.remove drops an unused camera',
  cameraRemoved.next.cameras.length === 2 && cameraRemoved.next.cameras.every(camera => camera.id !== 'camera-tmp'),
  cameraRemoved.next.cameras.map(camera => camera.id),
)

// ---- animation.track.set / animation.track.remove ------------------------
const trackReplaced = applied('animation.track.set replacing an existing track', [{
  op: 'animation.track.set',
  track: {
    id: 'watch-turntable',
    targetEntityId: 'watch-body',
    property: 'rotationEuler.z',
    keyframes: [{ frame: 1, value: 0 }, { frame: 90, value: 6.28318531 }],
  },
}])
check(
  'animation.track.set replaces the keyframes of an existing track',
  trackReplaced.next.animationTracks.length === 3
    && trackReplaced.next.animationTracks.find(track => track.id === 'watch-turntable').keyframes.length === 2,
  trackReplaced.next.animationTracks.map(track => `${track.id}:${track.keyframes.length}`),
)
check(
  'animation.track.set says it replaced rather than added',
  trackReplaced.result.operations[0].summary.startsWith('replaced animation track "watch-turntable"'),
  trackReplaced.result.operations[0].summary,
)

const trackAdded = applied('animation.track.set adding a new track', [{
  op: 'animation.track.set',
  track: {
    id: 'crown-wobble',
    targetEntityId: 'watch-crown',
    property: 'location.y',
    keyframes: [{ frame: 1, value: 0 }, { frame: 20, value: 0.01 }],
  },
}])
check(
  'animation.track.set adds a track that did not exist',
  trackAdded.next.animationTracks.length === 4
    && trackAdded.result.operations[0].summary.startsWith('added animation track "crown-wobble"'),
  trackAdded.result.operations[0].summary,
)

const trackRemoved = applied('animation.track.remove', [
  { op: 'animation.track.remove', trackId: 'dial-turntable' },
])
check(
  'animation.track.remove drops exactly the named track',
  trackRemoved.next.animationTracks.length === 2
    && trackRemoved.next.animationTracks.every(track => track.id !== 'dial-turntable'),
  trackRemoved.next.animationTracks.map(track => track.id),
)

// ---- shot.set / shot.remove ---------------------------------------------
const shotReplaced = applied('shot.set replacing an existing shot', [
  { op: 'shot.set', shot: { id: 'shot-turntable', cameraId: 'camera-top', frameRange: [1, 45] } },
])
check(
  'shot.set re-points an existing shot at another camera',
  shotReplaced.next.shots.length === 1
    && shotReplaced.next.shots[0].cameraId === 'camera-top'
    && JSON.stringify(shotReplaced.next.shots[0].frameRange) === JSON.stringify([1, 45]),
  shotReplaced.next.shots,
)

const shotAdded = applied('shot.set adding a new shot', [
  { op: 'shot.set', shot: { id: 'shot-top', cameraId: 'camera-top', frameRange: [10, 40] } },
])
check(
  'shot.set adds a shot that did not exist',
  shotAdded.next.shots.length === 2
    && shotAdded.result.operations[0].summary.startsWith('added shot "shot-top" on camera "camera-top"'),
  shotAdded.result.operations[0].summary,
)

const shotRemoved = applied('shot.remove', [{ op: 'shot.remove', shotId: 'shot-turntable' }])
check(
  'shot.remove drops the named shot',
  shotRemoved.next.shots.length === 0,
  shotRemoved.next.shots,
)

// ---- project.frameRange.set / render.profile.set -------------------------
const frameRangeSet = applied('project.frameRange.set', [
  { op: 'project.frameRange.set', frameStart: 1, frameEnd: 120, fps: 24 },
])
check(
  'project.frameRange.set updates the frame range and fps',
  frameRangeSet.next.project.frameEnd === 120 && frameRangeSet.next.project.fps === 24,
  frameRangeSet.next.project,
)
check(
  'project.frameRange.set preserves the rest of the project block',
  frameRangeSet.next.project.id === 'fixture-product-turntable'
    && frameRangeSet.next.project.title === frameRangeSet.spec.project.title
    && frameRangeSet.next.project.aspectRatio === '16:9',
  frameRangeSet.next.project,
)
check(
  'project.frameRange.set records both frame paths',
  JSON.stringify(frameRangeSet.result.operations[0].changedPaths)
    === JSON.stringify(['project.frameStart', 'project.frameEnd']),
  frameRangeSet.result.operations[0].changedPaths,
)
// KNOWN DIGEST GAP — see report: the digest projection excludes the entire
// `project` block, so a pure frame-range change reports sceneChanged === false.
// This check pins the observed behaviour rather than the arguably-correct one.
check(
  'KNOWN DIGEST GAP: a frame-range change does not change the scene digest',
  frameRangeSet.result.digestAfter === frameRangeSet.result.digestBefore,
)

const profileSet = applied('render.profile.set on an existing profile', [{
  op: 'render.profile.set',
  profileName: 'preview',
  profile: { engine: 'eevee', resolution: [1280, 720], samples: 16 },
}])
check(
  'render.profile.set replaces engine, resolution and samples',
  profileSet.next.renderProfiles.preview.engine === 'eevee'
    && JSON.stringify(profileSet.next.renderProfiles.preview.resolution) === JSON.stringify([1280, 720])
    && profileSet.next.renderProfiles.preview.samples === 16,
  profileSet.next.renderProfiles.preview,
)
check(
  'render.profile.set preserves the profile fields it was not given',
  profileSet.next.renderProfiles.preview.filmTransparent === false
    && profileSet.next.renderProfiles.preview.maxSamplesBudget === 256,
  profileSet.next.renderProfiles.preview,
)
check(
  'render.profile.set leaves the other profile alone',
  JSON.stringify(profileSet.next.renderProfiles.final) === JSON.stringify(profileSet.spec.renderProfiles.final),
)

// ---------------------------------------------------------------------------
// Purity and open-item coverage — one valid patch per declared operation
// ---------------------------------------------------------------------------

/** One valid patch per operation name in the declared-vocabulary order. */
const PURE_CASES = [
  { op: 'entity.transform.update', operations: [{ op: 'entity.transform.update', entityId: 'watch-dial', location: [0, 0.01, 0] }] },
  { op: 'entity.visibility.set', operations: [{ op: 'entity.visibility.set', entityId: 'watch-dial', visible: false }] },
  { op: 'entity.add', operations: [{ op: 'entity.add', entity: { id: 'pure-box', type: 'generator', generator: { shape: 'cube' } } }] },
  { op: 'entity.remove', operations: [{ op: 'animation.track.remove', trackId: 'crown-turntable' }, { op: 'entity.remove', entityId: 'watch-crown' }] },
  { op: 'entity.material.set', operations: [{ op: 'entity.material.set', entityId: 'watch-dial', materialId: 'accent-signal' }] },
  { op: 'material.add', operations: [{ op: 'material.add', material: { id: 'pure-mat', shader: 'principled' } }] },
  { op: 'material.parameter.update', operations: [{ op: 'material.parameter.update', materialId: 'dial-glass', parameter: 'metallic', value: 0.2 }] },
  { op: 'light.add', operations: [{ op: 'light.add', light: { id: 'pure-light', type: 'area', energy: 10 } }] },
  { op: 'light.update', operations: [{ op: 'light.update', lightId: 'fill-light', energy: 30 }] },
  { op: 'light.remove', operations: [{ op: 'light.remove', lightId: 'fill-light' }] },
  { op: 'camera.add', operations: [{ op: 'camera.add', camera: { id: 'pure-camera', lens: 50 } }] },
  { op: 'camera.update', operations: [{ op: 'camera.update', cameraId: 'camera-top', lens: 35 }] },
  { op: 'camera.remove', operations: [{ op: 'camera.add', camera: { id: 'pure-camera' } }, { op: 'camera.remove', cameraId: 'pure-camera' }] },
  { op: 'animation.track.set', operations: [{ op: 'animation.track.set', track: { id: 'pure-track', targetEntityId: 'watch-dial', property: 'scale.x', keyframes: [{ frame: 1, value: 1 }, { frame: 60, value: 1.2 }] } }] },
  { op: 'animation.track.remove', operations: [{ op: 'animation.track.remove', trackId: 'watch-turntable' }] },
  { op: 'shot.set', operations: [{ op: 'shot.set', shot: { id: 'pure-shot', cameraId: 'camera-top', frameRange: [5, 25] } }] },
  { op: 'shot.remove', operations: [{ op: 'shot.remove', shotId: 'shot-turntable' }] },
  { op: 'project.frameRange.set', operations: [{ op: 'project.frameRange.set', frameStart: 5, frameEnd: 200 }] },
  { op: 'render.profile.set', operations: [{ op: 'render.profile.set', profileName: 'final', profile: { engine: 'cycles', resolution: [960, 540] } }] },
]

for (const pureCase of PURE_CASES) {
  const run = runPatch(pureCase.operations)
  check(
    `purity: ${pureCase.op} leaves the input spec byte-identical`,
    run.error === undefined && run.specUnchanged,
    run.error?.message,
  )
  check(
    `purity: ${pureCase.op} leaves the patch object untouched`,
    run.patchUnchanged,
  )
  check(
    `audit: ${pureCase.op} reports digestAfter as the digest of the returned spec`,
    run.error === undefined && run.result.digestAfter === sceneSpecDigest(run.next),
  )
  if (run.error === undefined) {
    for (const operation of pureCase.operations) exercisedOperations.add(operation.op)
  }
}

check('SCENE_OPERATION_NAMES is frozen', Object.isFrozen(SCENE_OPERATION_NAMES))
check(
  'SCENE_OPERATION_NAMES lists the 20 v1 operations in their documented order',
  SCENE_OPERATION_NAMES.length === 20
    && SCENE_OPERATION_NAMES[0] === 'entity.transform.update'
    && SCENE_OPERATION_NAMES[2] === 'entity.tags.set'
    && SCENE_OPERATION_NAMES[19] === 'render.profile.set',
  SCENE_OPERATION_NAMES,
)
check(
  'SCENE_OPERATION_NAMES has no duplicate entries',
  new Set(SCENE_OPERATION_NAMES).size === SCENE_OPERATION_NAMES.length,
)
check(
  'every declared operation name was exercised by a real patch above',
  SCENE_OPERATION_NAMES.every(name => exercisedOperations.has(name)),
  SCENE_OPERATION_NAMES.filter(name => !exercisedOperations.has(name)),
)

// ---------------------------------------------------------------------------
// Failure codes — atomic, anchored, and still pure
// ---------------------------------------------------------------------------

/** Every failure case: the operations, the expected code, and where it sits. */
const FAILURE_CASES = [
  { label: 'entity.transform.update against a missing entity', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'entity.transform.update', entityId: 'ghost', location: [0, 0, 0] }] },
  { label: 'entity.visibility.set against a missing entity', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'entity.visibility.set', entityId: 'ghost', visible: false }] },
  { label: 'entity.tags.set against a missing entity', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'entity.tags.set', entityId: 'ghost', tags: ['x'] }] },
  { label: 'entity.remove of a missing entity', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'entity.remove', entityId: 'ghost' }] },
  { label: 'entity.remove of an entity a camera targets', code: 'PATCH_TARGET_IN_USE', operations: [{ op: 'entity.remove', entityId: 'watch-body' }] },
  { label: 'entity.remove of an entity an animation track targets', code: 'PATCH_TARGET_IN_USE', operations: [{ op: 'entity.remove', entityId: 'watch-dial' }] },
  { label: 'entity.add of an id that already exists', code: 'PATCH_TARGET_EXISTS', operations: [{ op: 'entity.add', entity: { id: 'stage', type: 'empty' } }] },
  { label: 'entity.add referencing a material that does not exist', code: 'PATCH_REFERENCE_MISSING', operations: [{ op: 'entity.add', entity: { id: 'fresh', type: 'generator', generator: { shape: 'cube' }, materialId: 'ghost' } }] },
  { label: 'entity.material.set to a material that does not exist', code: 'PATCH_REFERENCE_MISSING', operations: [{ op: 'entity.material.set', entityId: 'stage', materialId: 'ghost' }] },
  { label: 'material.add of a material that already exists', code: 'PATCH_TARGET_EXISTS', operations: [{ op: 'material.add', material: { id: 'hero-steel', shader: 'principled' } }] },
  { label: 'material.parameter.update on a missing material', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'material.parameter.update', materialId: 'ghost', parameter: 'roughness', value: 0.5 }] },
  { label: 'light.add of a light that already exists', code: 'PATCH_TARGET_EXISTS', operations: [{ op: 'light.add', light: { id: 'key-light', type: 'area' } }] },
  { label: 'light.update on a missing light', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'light.update', lightId: 'ghost', energy: 1 }] },
  { label: 'light.remove of a missing light', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'light.remove', lightId: 'ghost' }] },
  { label: 'camera.add of a camera that already exists', code: 'PATCH_TARGET_EXISTS', operations: [{ op: 'camera.add', camera: { id: 'camera-main' } }] },
  { label: 'camera.add targeting a missing entity', code: 'PATCH_REFERENCE_MISSING', operations: [{ op: 'camera.add', camera: { id: 'camera-new', targetEntityId: 'ghost' } }] },
  { label: 'camera.update on a missing camera', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'camera.update', cameraId: 'ghost', lens: 35 }] },
  { label: 'camera.update targeting a missing entity', code: 'PATCH_REFERENCE_MISSING', operations: [{ op: 'camera.update', cameraId: 'camera-main', targetEntityId: 'ghost' }] },
  { label: 'camera.remove of a camera a shot uses', code: 'PATCH_TARGET_IN_USE', operations: [{ op: 'camera.remove', cameraId: 'camera-main' }] },
  { label: 'animation.track.set targeting a missing entity', code: 'PATCH_REFERENCE_MISSING', operations: [{ op: 'animation.track.set', track: { id: 'track-new', targetEntityId: 'ghost', property: 'location.x', keyframes: [{ frame: 1, value: 0 }, { frame: 2, value: 1 }] } }] },
  { label: 'animation.track.remove of a missing track', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'animation.track.remove', trackId: 'ghost' }] },
  { label: 'shot.set using a camera that does not exist', code: 'PATCH_REFERENCE_MISSING', operations: [{ op: 'shot.set', shot: { id: 'shot-new', cameraId: 'ghost' } }] },
  { label: 'shot.remove of a missing shot', code: 'PATCH_TARGET_MISSING', operations: [{ op: 'shot.remove', shotId: 'ghost' }] },
  { label: 'project.frameRange.set with an inverted range', code: 'PATCH_FRAME_RANGE_INVALID', operations: [{ op: 'project.frameRange.set', frameStart: 10, frameEnd: 5 }] },
  { label: 'an operation name this version does not implement', code: 'PATCH_OPERATION_UNKNOWN', operations: [{ op: 'scene.wipe' }] },
]

for (const failureCase of FAILURE_CASES) {
  const run = runPatch(failureCase.operations)
  check(
    `${failureCase.label} fails with ${failureCase.code}`,
    run.errorCode === failureCase.code,
    run.error === undefined ? 'no error thrown' : `${run.errorCode ?? run.error.name}: ${run.error.message}`,
  )
  check(
    `${failureCase.label} leaves the input spec byte-identical`,
    run.specUnchanged,
  )
}

const anchored = runPatch([{ op: 'entity.transform.update', entityId: 'ghost', location: [0, 0, 0] }])
check(
  'a failure carries patchIssue { code, path, message }',
  anchored.error?.patchIssue !== undefined
    && anchored.error.patchIssue.code === 'PATCH_TARGET_MISSING'
    && anchored.error.patchIssue.path === 'operations[0]'
    && anchored.error.patchIssue.message.includes('no entity "ghost" exists'),
  anchored.error?.patchIssue,
)
check(
  'the thrown error message names the failing operation index',
  anchored.error?.message.startsWith('operations[0] (PATCH_TARGET_MISSING):'),
  anchored.error?.message,
)
check(
  'a failure is a plain Error, so callers must read patchIssue rather than instanceof',
  anchored.error instanceof Error && anchored.error.patchIssue !== undefined,
)
check(
  'entity.remove names both classes of dependent in its message',
  runPatch([{ op: 'entity.remove', entityId: 'watch-body' }]).error?.message.includes('camera target and animation track'),
  runPatch([{ op: 'entity.remove', entityId: 'watch-body' }]).error?.message,
)
check(
  'entity.remove names the single dependent class when only one applies',
  runPatch([{ op: 'entity.remove', entityId: 'watch-dial' }]).error?.message.includes('still referenced by animation track'),
  runPatch([{ op: 'entity.remove', entityId: 'watch-dial' }]).error?.message,
)
check(
  'camera.remove names the shot that uses the camera',
  runPatch([{ op: 'camera.remove', cameraId: 'camera-main' }]).error?.patchIssue.message.includes('used by shot "shot-turntable"'),
  runPatch([{ op: 'camera.remove', cameraId: 'camera-main' }]).error?.patchIssue.message,
)

// A patch that fails HALFWAY is the case the purity guarantee exists for: the
// first operation already succeeded in the working copy when the second threw.
const halfway = runPatch([
  { op: 'entity.visibility.set', entityId: 'stage', visible: false },
  { op: 'entity.transform.update', entityId: 'ghost', location: [0, 0, 0] },
])
check(
  'a patch whose second operation fails still leaves the input spec untouched',
  halfway.specUnchanged && halfway.error !== undefined,
)
check(
  'the halfway failure is anchored on the failing operation, not the first',
  halfway.error?.patchIssue.path === 'operations[1]' && halfway.errorCode === 'PATCH_TARGET_MISSING',
  halfway.error?.patchIssue,
)
check(
  'the first operation is not visible anywhere in the caller document',
  JSON.stringify(halfway.spec) === JSON.stringify(compiledFixture()),
)

// ---------------------------------------------------------------------------
// Audit records and digests
// ---------------------------------------------------------------------------

const multi = applied('three sequential operations', [
  { op: 'entity.transform.update', entityId: 'watch-dial', location: [0, 0.01, 0.04] },
  { op: 'light.update', lightId: 'rim-light', energy: 60 },
  { op: 'camera.update', cameraId: 'camera-top', lens: 40 },
])
check(
  'operations[] holds one audit record per applied operation, in order',
  multi.result.operations.length === 3
    && JSON.stringify(multi.result.operations.map(record => record.op))
      === JSON.stringify(['entity.transform.update', 'light.update', 'camera.update']),
  multi.result.operations.map(record => record.op),
)
check(
  'every audit record has op, target, summary and changedPaths',
  multi.result.operations.every(record => typeof record.op === 'string'
    && typeof record.target === 'string'
    && typeof record.summary === 'string'
    && Array.isArray(record.changedPaths)),
  multi.result.operations,
)
check(
  'audit targets name the object that changed',
  JSON.stringify(multi.result.operations.map(record => record.target)) === JSON.stringify(['watch-dial', 'rim-light', 'camera-top']),
  multi.result.operations.map(record => record.target),
)
check(
  'digestBefore is the digest of the input spec',
  multi.result.digestBefore === sceneSpecDigest(multi.spec),
)
check(
  'digestAfter is the digest of the returned spec',
  multi.result.digestAfter === sceneSpecDigest(multi.next),
)
check(
  'both digests are lowercase 64-character hex',
  /^[0-9a-f]{64}$/.test(multi.result.digestBefore) && /^[0-9a-f]{64}$/.test(multi.result.digestAfter),
  { before: multi.result.digestBefore, after: multi.result.digestAfter },
)
check(
  're-applying an identical no-op patch yields the same digest',
  (() => {
    const again = applyPatchToSpec(multi.next, patchWith([
      { op: 'entity.transform.update', entityId: 'watch-dial', location: [0, 0.01, 0.04] },
      { op: 'light.update', lightId: 'rim-light', energy: 60 },
    ]))
    return again.digestAfter === again.digestBefore
  })(),
)

// ---------------------------------------------------------------------------
// buildOperationManifest — the on-disk audit document (SPEC §8.4)
// ---------------------------------------------------------------------------

const manifest = buildOperationManifest({
  operations: multi.result.operations,
  request: {
    idempotencyKey: 'k-manifest-0001',
    actor: 'session-42',
    stage: 'visual_review',
    note: 'tightened the framing',
    saveCheckpoint: false,
    renderPreview: true,
  },
  revision: {
    revision: 'r0002',
    baseRevision: 'r0001',
    digestBefore: multi.result.digestBefore,
    digestAfter: multi.result.digestAfter,
  },
  notices: [{ severity: 'notice', code: 'SCENE_CAMERA_POSITION_DERIVED', path: 'cameras.camera-top.transform.location', message: 'derived' }],
})
check(
  'the manifest declares its schema version',
  manifest.schemaVersion === 'deepblend.operation-manifest/v1',
  manifest.schemaVersion,
)
check(
  'the manifest carries the revision pair and both digests',
  manifest.revision === 'r0002'
    && manifest.baseRevision === 'r0001'
    && manifest.digestBefore === multi.result.digestBefore
    && manifest.digestAfter === multi.result.digestAfter,
  manifest,
)
check('the manifest reports sceneChanged for a real change', manifest.sceneChanged === true)
check(
  'the manifest records the request verbatim',
  manifest.idempotencyKey === 'k-manifest-0001'
    && manifest.actor === 'session-42'
    && manifest.stage === 'visual_review'
    && manifest.note === 'tightened the framing',
  manifest,
)
check(
  'the manifest honours saveCheckpoint and renderPreview flags',
  manifest.savedCheckpoint === false && manifest.renderedPreview === true,
)
check(
  'the manifest counts and records the operations',
  manifest.operationCount === 3
    && JSON.stringify(manifest.operations) === JSON.stringify(multi.result.operations),
)
check('the manifest carries the validation notices through', manifest.notices.length === 1
  && manifest.notices[0].code === 'SCENE_CAMERA_POSITION_DERIVED')

const defaultManifest = buildOperationManifest({
  operations: [],
  request: { idempotencyKey: 'k-manifest-0002' },
  revision: { revision: 'r0003', baseRevision: 'r0002', digestBefore: 'same', digestAfter: 'same' },
  notices: [],
})
check(
  'an unset actor, stage and note become null rather than undefined',
  defaultManifest.actor === null && defaultManifest.stage === null && defaultManifest.note === null,
  defaultManifest,
)
check(
  'a checkpoint is saved by default and a preview is not rendered by default',
  defaultManifest.savedCheckpoint === true && defaultManifest.renderedPreview === false,
)
check(
  'an unchanged scene reports sceneChanged === false',
  defaultManifest.sceneChanged === false && defaultManifest.operationCount === 0,
)
check(
  'the manifest key set is exactly the documented one',
  JSON.stringify(Object.keys(manifest)) === JSON.stringify([
    'schemaVersion', 'revision', 'baseRevision', 'digestBefore', 'digestAfter',
    'specHashBefore', 'specHashAfter', 'sceneChanged', 'specChanged',
    'idempotencyKey', 'actor', 'stage', 'note', 'savedCheckpoint', 'renderedPreview',
    'operationCount', 'operations', 'notices',
  ]),
  Object.keys(manifest),
)
check(
  'every manifest field survives a JSON round trip',
  JSON.stringify(JSON.parse(JSON.stringify(manifest))) === JSON.stringify(manifest),
)

// ---------------------------------------------------------------------------
// Regression tests for defects found while writing this file
// ---------------------------------------------------------------------------

// REGRESSION TESTS for three defects found while this file was written. Each was
// green-as-a-bug before the fix; each is now a red-on-regression assertion of the
// CORRECT behaviour. They are kept together and named for the defect, because the
// value of a regression test is that it says what went wrong.

// Defect 1 — `camera.update` could not switch a camera's aim source. It deleted
// the stale key from `patchFields`, which can never hold it, so the merged camera
// carried BOTH `targetEntityId` and `targetPoint` and the applied result then
// failed SceneSpec validation with SCENE_CAMERA_TARGET_AMBIGUOUS — a patch that
// reported success and produced an invalid document.
const aimSwitched = runPatch([{ op: 'camera.update', cameraId: 'camera-main', targetPoint: [0, 0, 0.1] }])
const switchedCamera = aimSwitched.next.cameras.find(camera => camera.id === 'camera-main')
check(
  'regression: camera.update to a targetPoint clears the old targetEntityId',
  switchedCamera.targetEntityId === undefined
    && JSON.stringify(switchedCamera.targetPoint) === JSON.stringify([0, 0, 0.1]),
  switchedCamera,
)
check(
  'regression: an aim-switched camera still produces a VALID SceneSpec',
  validateSceneSpec(aimSwitched.next).ok === true,
  validateSceneSpec(aimSwitched.next).errors,
)
check(
  'regression: the aim switch is recorded in the audit trail',
  aimSwitched.result.operations[0].summary.includes('cleared targetEntityId')
    && aimSwitched.result.operations[0].changedPaths.includes('cameras.camera-main.targetEntityId'),
  aimSwitched.result.operations[0],
)

// The mirror direction: a camera holding a targetPoint, patched to an entity.
const mirrorSpec = compiledFixture()
const mirrorSet = runPatch(
  [{ op: 'camera.update', cameraId: 'camera-main', targetPoint: [1, 1, 1] }],
  { spec: mirrorSpec },
)
const mirrorSwitched = runPatch(
  [{ op: 'camera.update', cameraId: 'camera-main', targetEntityId: 'watch-dial' }],
  { spec: mirrorSet.next },
)
const mirrorCamera = mirrorSwitched.next.cameras.find(camera => camera.id === 'camera-main')
check(
  'regression: camera.update to a targetEntityId clears the old targetPoint',
  mirrorCamera.targetPoint === undefined && mirrorCamera.targetEntityId === 'watch-dial',
  mirrorCamera,
)
check(
  'regression: the mirror switch also leaves a valid SceneSpec',
  validateSceneSpec(mirrorSwitched.next).ok === true,
  validateSceneSpec(mirrorSwitched.next).errors,
)

// Defect 2 — `render.profile.set` mishandled a profile with no `resolution`:
// on an existing profile it left an own `resolution: undefined` key (which reads
// as success and then fails validation), and on a NEW profile name it threw a
// bare TypeError while formatting its own summary — a failure with no
// `patchIssue`, so the tool layer could not map it to a stable error code.
const profileWithoutResolution = runPatch([{
  op: 'render.profile.set',
  profileName: 'final',
  profile: { engine: 'eevee', samples: 16 },
}])
check(
  'regression: a profile patch with no resolution KEEPS the existing resolution',
  JSON.stringify(profileWithoutResolution.next.renderProfiles.final.resolution)
    === JSON.stringify(compiledFixture().renderProfiles.final.resolution),
  profileWithoutResolution.next.renderProfiles.final,
)
check(
  'regression: the patched spec still validates after a resolution-less profile patch',
  validateSceneSpec(profileWithoutResolution.next).ok === true,
  validateSceneSpec(profileWithoutResolution.next).errors,
)
check(
  'regression: the summary states that the resolution was kept',
  profileWithoutResolution.result.operations[0].summary.includes('kept its resolution'),
  profileWithoutResolution.result.operations[0].summary,
)

const newProfileSpec = compiledFixture()
delete newProfileSpec.renderProfiles.final
const newProfileWithoutResolution = runPatch([{
  op: 'render.profile.set',
  profileName: 'final',
  profile: { engine: 'eevee', samples: 16 },
}], { spec: newProfileSpec })
check(
  'regression: defining a NEW profile without a resolution is a structured refusal',
  newProfileWithoutResolution.errorCode === 'PATCH_PROFILE_UNRESOLVED_RESOLUTION'
    && newProfileWithoutResolution.error?.patchIssue?.code === 'PATCH_PROFILE_UNRESOLVED_RESOLUTION',
  {
    errorCode: newProfileWithoutResolution.errorCode,
    patchIssue: newProfileWithoutResolution.error?.patchIssue?.code,
    isTypeError: newProfileWithoutResolution.error instanceof TypeError,
  },
)
check(
  'regression: that refusal leaves the input spec unchanged',
  newProfileWithoutResolution.specUnchanged === true,
  newProfileWithoutResolution.specUnchanged,
)
check(
  'regression: defining a new profile WITH a resolution still works',
  (() => {
    const ok = runPatch([{
      op: 'render.profile.set',
      profileName: 'final',
      profile: { engine: 'eevee', samples: 16, resolution: [1280, 720] },
    }], { spec: (() => { const copy = compiledFixture(); delete copy.renderProfiles.final; return copy })() })
    return ok.next.renderProfiles.final.resolution.join('x') === '1280x720'
      && validateSceneSpec(ok.next).ok === true
  })(),
)

// Defect 3 — a frame-range-only revision reported `sceneChanged: false`, because
// the scene DIGEST deliberately excludes the project block. That is right for
// "is the geometry the same?" and wrong as the only changed/unchanged verdict, so
// the whole-document `specHash` now rides alongside it.
const frameRangePatch = runPatch([{ op: 'project.frameRange.set', frameStart: 1, frameEnd: 120 }])
check(
  'regression: a frame-range change is visible in the whole-document spec hash',
  frameRangePatch.result.specHashBefore !== frameRangePatch.result.specHashAfter,
  { before: frameRangePatch.result.specHashBefore?.slice(0, 12), after: frameRangePatch.result.specHashAfter?.slice(0, 12) },
)
check(
  'regression: the scene digest is UNCHANGED by a frame-range-only edit (by design)',
  frameRangePatch.result.digestBefore === frameRangePatch.result.digestAfter,
  { before: frameRangePatch.result.digestBefore.slice(0, 12), after: frameRangePatch.result.digestAfter.slice(0, 12) },
)
check(
  'regression: an empty patch leaves BOTH verdicts unchanged',
  (() => {
    const noop = runPatch([{ op: 'project.frameRange.set', frameStart: compiledFixture().project.frameStart, frameEnd: compiledFixture().project.frameEnd }])
    return noop.result.specHashBefore === noop.result.specHashAfter && noop.result.digestBefore === noop.result.digestAfter
  })(),
)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`scene-patch contract: ${results.length - failures}/${results.length} check(s) passed`)
if (failures > 0) {
  console.log('Failed checks:')
  for (const result of results) if (!result.ok) console.log(`  - ${result.name}`)
}
process.exit(failures > 0 ? 1 : 0)
