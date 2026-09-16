#!/usr/bin/env node
/**
 * M2 regression suite — the four defects a real visual-review session found.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE M2 SUITES
 * --------------------------------------------------
 * Every one of these defects was found by USING the product on a real project, not by
 * the 717 assertions that were already green. That is the whole point of the file: the
 * existing suites exercise the operations they were written for, and all four of these
 * bugs live on paths those suites never took — `camera.add`, an `entity.add` that omits
 * a shape's optional size, and a scene whose cameras declare no roles.
 *
 * So each case here reproduces the ORIGINAL SYMPTOM, not the fixed behaviour. If one of
 * these ever passes for the wrong reason — a NaN quietly becoming null, a crash
 * swallowed into an empty plan — the assertion is written against the symptom that a
 * user actually saw, so it goes red.
 *
 * THE FOUR DEFECTS
 * ----------------
 *  1. `applyScenePatch` stored the patch RESULT without resolving it, so a `camera.add`
 *     without a `transform` crashed `summarizeSceneSpec` mid-commit, and digest(stored)
 *     != digest(compile(stored)) — the property M1 exists to guarantee.
 *  2. A generator that omitted its shape's size field (both are optional in the schema)
 *     made `boundsOf` compute `undefined * n`. NaN becomes `null` in JSON, so the commit
 *     SUCCEEDED and the harness rejected its own result as "not lossless JSON" — a real
 *     user-visible error, thrown by a real user-visible call.
 *  3. `resolveSubjectId` took `entities.find(hero-product)`. Storage sorts collections by
 *     id, so "find" meant "alphabetically first", and a watch whose case, dial, crown and
 *     four indices were ALL tagged hero-product resolved its subject to `index-nine` — a
 *     2.5 mm marker. Two reviews then scored that marker and proposed scaling it 5x.
 *  4. `buildViewPlan` fell back to camera ARRAY POSITION for roles. Storage sorts, so a
 *     four-camera project got views labelled "top" and "detail" that were other cameras.
 *     The reviewer noticed the mismatch itself and declined to "fix" it.
 *
 * Run standalone: `node deepblend/tests/contract/patch-resolution.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  CAMERA_UPDATE_FIELDS,
  SUBJECT_PART_TAG,
  subjectParts as subjectPartsOf,
  trackedObjects,
  applyPatchToSpec,
  buildViewPlan,
  compileSceneSpec,
  resolveSubject,
  resolveSubjectId,
  sceneSpecDigest,
  scoreReview,
  summarizeSceneSpec,
  validateScenePatch,
  validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'
import { readFile } from 'node:fs/promises'

import { importDsh } from '../lib/dsh-deployment.mjs'

// The harness's own predicate, not a reimplementation of it.
const { isJsonValue } = await importDsh('dsh-util-values')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const fixtureSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
const base = compileSceneSpec(fixtureSpec).spec

/** Every non-finite number anywhere in a document, with its path. */
function nonFinite(value, path = '', found = []) {
  if (typeof value === 'number' && !Number.isFinite(value)) { found.push(`${path} = ${value}`); return found }
  if (value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) { value.forEach((entry, index) => nonFinite(entry, `${path}[${index}]`, found)); return found }
  for (const key of Object.keys(value)) nonFinite(value[key], path ? `${path}.${key}` : key, found)
  return found
}

/** Own keys whose value is `undefined` — the other thing a JSON round trip loses. */
function undefinedKeys(value, path = '', found = []) {
  if (value === undefined) { found.push(path); return found }
  if (value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) { value.forEach((entry, index) => undefinedKeys(entry, `${path}[${index}]`, found)); return found }
  for (const key of Object.keys(value)) undefinedKeys(value[key], path ? `${path}.${key}` : key, found)
  return found
}


// ---------------------------------------------------------------------------
// Scene shapes shared by the role/subject cases
// ---------------------------------------------------------------------------

const mkCamera = (id, role, target) => ({
  id, role, targetEntityId: target, lens: 50, transform: { location: [0, 0, 5] },
})
const mkEntity = (id, size, tags = []) => ({
  id, type: 'generator', generator: { shape: 'rounded_box', size }, tags,
  transform: { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
})

/** The shape that produced the mislabelled review: four cameras, no roles, stored in
 *  the alphabetical order storage enforces. */
const ROLELESS = {
  project: { id: 'w' },
  cameras: [mkCamera('camera-detail'), mkCamera('camera-main'), mkCamera('camera-three-quarter'), mkCamera('camera-top')],
  entities: [mkEntity('watch-body', 0.44)],
}

/** A scene that declares everything, so it must plan cleanly and silently. */
const WITH_ROLES = {
  project: { id: 'r', activeCamera: 'camera-main' },
  cameras: [
    mkCamera('camera-main', 'active-camera', 'table'),
    mkCamera('camera-3q', 'three-quarter'),
    mkCamera('camera-top', 'top'),
    mkCamera('camera-detail', 'detail'),
  ],
  entities: [mkEntity('table', 0.5, ['hero-product'])],
}

const apply = operations => applyPatchToSpec(base, { projectId: 'p', baseRevision: 'r0001', operations })
/** What the transaction now does before it validates, digests and stores a result. */
const resolved = spec => compileSceneSpec(spec).spec

// ---------------------------------------------------------------------------
// 1. A camera added without a transform
// ---------------------------------------------------------------------------

{
  const applied = apply([{ op: 'camera.add', camera: { id: 'camera-extra', lens: 50, targetPoint: [0, 0, 0] } }])
  check('camera.add is accepted without a transform, because the schema does not require one',
    applied.spec.cameras.some(camera => camera.id === 'camera-extra'))

  const stored = resolved(applied.spec)
  const added = stored.cameras.find(camera => camera.id === 'camera-extra')
  check('the stored camera carries a materialised transform, not a missing one',
    added.transform !== undefined && Array.isArray(added.transform.location) &&
    Array.isArray(added.transform.rotationEuler) && Array.isArray(added.transform.scale),
    added.transform)

  let crashed = null
  try { summarizeSceneSpec(stored) } catch (cause) { crashed = cause.message }
  check('summarizing the revision after the patch does not throw (the original symptom)',
    crashed === null, crashed)

  check('digest(stored) equals digest(compile(stored)) — the M1 re-derivation property',
    sceneSpecDigest(stored) === sceneSpecDigest(compileSceneSpec(stored).spec),
    { stored: sceneSpecDigest(stored).slice(0, 16), recompiled: sceneSpecDigest(compileSceneSpec(stored).spec).slice(0, 16) })

  check('compiling twice changes nothing, so the fix cannot drift a digest on its own',
    JSON.stringify(compileSceneSpec(stored).spec) === JSON.stringify(stored))
}

// ---------------------------------------------------------------------------
// 2. A generator that omits its shape's optional size
// ---------------------------------------------------------------------------

for (const generator of [
  { shape: 'uv_sphere' },
  { shape: 'cube' },
  { shape: 'cylinder' },
  { shape: 'cone' },
  { shape: 'torus' },
  { shape: 'plane' },
]) {
  const applied = apply([{
    op: 'entity.add',
    entity: {
      id: 'bare',
      type: 'generator',
      generator,
      transform: { location: [0, 0, 2], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    },
  }])
  const stored = resolved(applied.spec)
  const summary = summarizeSceneSpec(stored)

  const bad = nonFinite(summary)
  check(`a bare "${generator.shape}" generator summarises with no non-finite number`,
    bad.length === 0, bad.slice(0, 4))

  // The exact user-visible symptom: JSON cannot represent NaN, so it becomes null, and
  // a value that changes under a JSON round trip is what the harness calls "not lossless
  // JSON" — an error reported on a call that had already succeeded.
  const text = JSON.stringify(summary)
  check(`a bare "${generator.shape}" generator survives a JSON round trip unchanged`,
    JSON.stringify(JSON.parse(text)) === text, text.length)

  check(`a bare "${generator.shape}" generator leaves no undefined-valued key`,
    undefinedKeys(summary).length === 0, undefinedKeys(summary).slice(0, 4))

  check(`a bare "${generator.shape}" generator still leaves the stored spec re-derivable`,
    sceneSpecDigest(stored) === sceneSpecDigest(compileSceneSpec(stored).spec))
}

// ---------------------------------------------------------------------------
// 3. The subject must not be chosen by alphabetical accident
// ---------------------------------------------------------------------------

{
  // The watch-commercial shape: seven hero-tagged entities, stored alphabetically so
  // `index-nine` sorts ahead of the case it belongs to.
  const mk = (id, size, tags = []) => ({
    id, type: 'generator', generator: { shape: 'rounded_box', size }, tags,
    transform: { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
  })
  const entities = [
    mk('index-nine', 0.025, ['hero-product']),
    mk('index-six', 0.025, ['hero-product']),
    mk('index-three', 0.025, ['hero-product']),
    mk('index-twelve', 0.025, ['hero-product']),
    mk('watch-dial', 0.36, ['hero-product']),
    mk('watch-body', 0.44, ['hero-product']),
  ]

  const withAim = {
    project: { id: 'w', activeCamera: 'camera-main' },
    cameras: [{ id: 'camera-main', role: 'active-camera', targetEntityId: 'watch-body', transform: { location: [0, 0, 0] } }],
    entities,
  }
  check('the subject is what the active camera aims at, when it aims at something',
    resolveSubjectId(withAim) === 'watch-body', resolveSubject(withAim))
  check('and the reason is reported rather than implied',
    /aims at it/.test(resolveSubject(withAim).source), resolveSubject(withAim).source)

  const noAim = { ...withAim, project: { id: 'w' }, cameras: [{ id: 'camera-main', transform: { location: [0, 0, 0] } }] }
  const ambiguous = resolveSubject(noAim)
  check('with no aim and several hero tags, the LARGEST is chosen, not the alphabetically first',
    ambiguous.id === 'watch-body', ambiguous)
  check('the ambiguity is visible in the result rather than silent',
    ambiguous.candidates.length === 6 && /ambiguous|largest/.test(ambiguous.source), ambiguous.source)
  check('the old rule would have picked index-nine — asserted so the regression is unmistakable',
    ['index-nine', 'index-six', 'index-three', 'index-twelve'].includes('index-nine') && ambiguous.id !== 'index-nine')

  // Storage order must not change the answer: that is the property, not the value.
  const shuffled = { ...noAim, entities: [...noAim.entities].reverse() }
  check('reversing the entity array does not change the subject',
    resolveSubjectId(shuffled) === ambiguous.id, { straight: ambiguous.id, reversed: resolveSubjectId(shuffled) })

  const oneHero = {
    ...noAim,
    entities: [mk('index-nine', 0.025, ['hero-product']), mk('watch-body', 0.44, [])],
  }
  check('a single hero tag still wins over size, because the author said so',
    resolveSubjectId(oneHero) === 'index-nine', resolveSubject(oneHero))
}

// ---------------------------------------------------------------------------
// 4. View roles must come from the scene, never from array position
// ---------------------------------------------------------------------------

// Every planned view carries a PURPOSE, and the reasons are what a reviewer reads when it decides what to
// look for: the active camera is not "another angle", it is what the animation is actually seen through.
{
  const plan = buildViewPlan({ spec: WITH_ROLES })
  const byRole = new Map(plan.views.map(view => [view.role, view.purpose]))
  check('the active-camera view says what it is FOR, not just that it exists',
    byRole.get('active-camera') === 'what the animation is actually seen through',
    [...byRole.entries()])
  // The generic fallback (`the scene's "x" view`) is what a MISSED standard role looks like, and the four
  // standard roles must all be answered by their own case rather than by it.
  check('every standard role has its own reason, and none of them falls through to the generic one',
    byRole.size === 4 && [...byRole.values()].every(purpose => !purpose.startsWith('the scene\'s "')) &&
    new Set(byRole.values()).size === 4,
    [...byRole.entries()])
}

{
  const plan = buildViewPlan({ spec: ROLELESS })
  check('a role-less scene produces one view per camera rather than inventing roles',
    plan.views.length === 4, plan.views.map(view => view.id))
  check('no view of a role-less scene CLAIMS a role it cannot prove',
    plan.views.every(view => view.role === null), plan.views.map(view => view.role))
  check('each view of a role-less scene is named after its own camera, which is a fact',
    plan.views.every(view => view.id === view.cameraId), plan.views.map(view => `${view.id}/${view.cameraId}`))
  check('the plan says why it could not do better, and how to fix it',
    plan.notices.some(line => /role/.test(line) && /active-camera/.test(line)), plan.notices)

  // The cap is what keeps a review affordable, and a scene with more cameras than the cap must SAY which
  // ones it left out — a plan that silently renders four of seven teaches the model that three cameras do
  // not exist.
  const capped = buildViewPlan({ spec: ROLELESS, maxViews: 2 })
  check('a role-less scene with more cameras than the cap names the ones it left out',
    capped.views.length === 2 &&
    capped.notices.some(line => line === 'the remaining 2 camera(s) were left out to keep the review affordable: camera-three-quarter, camera-top'),
    capped.notices.filter(line => line.includes('left out')))
  check('and the two it kept are the first two the scene declares, in declaration order',
    JSON.stringify(capped.views.map(view => view.cameraId)) === JSON.stringify(['camera-detail', 'camera-main']),
    capped.views.map(view => view.cameraId))

  // And an explicit request that cannot be honoured is refused, not answered with junk.
  const explicit = buildViewPlan({ spec: ROLELESS, roles: ['top'] })
  check('asking for a role no camera fills yields an empty plan, not a substitute',
    explicit.views.length === 0, explicit.views.map(view => view.id))
  check('and says which roles were requested and which cameras exist',
    explicit.notices.some(line => /top/.test(line) && /camera-detail/.test(line)), explicit.notices)

  // A scene that declares roles is unaffected, and gets no noise.
  const declared = buildViewPlan({ spec: WITH_ROLES })
  check('a scene that declares all four roles still yields the standard four views',
    declared.views.map(view => view.id).join(',') === 'active-camera,three-quarter,top,detail',
    declared.views.map(view => `${view.id}->${view.cameraId}`))
  check('a well-authored scene produces no plan notices at all',
    declared.notices.length === 0, declared.notices)

  // Reordering must not change a role-declaring plan, either.
  const shuffled = { ...WITH_ROLES, cameras: [...WITH_ROLES.cameras].reverse() }
  check('reversing the camera array does not change which camera fills which role',
    buildViewPlan({ spec: shuffled }).views.map(view => `${view.id}->${view.cameraId}`).join(',') ===
    declared.views.map(view => `${view.id}->${view.cameraId}`).join(','))
}

// ---------------------------------------------------------------------------
// 5. role must be SETTABLE, not merely readable
// ---------------------------------------------------------------------------

{
  check('a patch may set a camera role on add',
    validateScenePatch({
      projectId: 'p', baseRevision: 'r0001',
      operations: [{ op: 'camera.add', camera: { id: 'c', lens: 50, role: 'top' } }],
    }).ok)
  check('a patch may set a camera role on update',
    validateScenePatch({
      projectId: 'p', baseRevision: 'r0001',
      operations: [{ op: 'camera.update', cameraId: 'camera-main', role: 'three-quarter' }],
    }).ok)
  check('an unknown role is refused rather than stored',
    !validateScenePatch({
      projectId: 'p', baseRevision: 'r0001',
      operations: [{ op: 'camera.update', cameraId: 'camera-main', role: 'hero-angle' }],
    }).ok)

  const updated = apply([{ op: 'camera.update', cameraId: 'camera-main', role: 'active-camera' }])
  check('camera.update actually MERGES the role instead of reporting success and dropping it',
    updated.spec.cameras.find(camera => camera.id === 'camera-main').role === 'active-camera',
    updated.spec.cameras.find(camera => camera.id === 'camera-main')?.role)
  check('and the operation summary names the field it changed',
    /role/.test(updated.operations[0].summary), updated.operations[0].summary)

  // THE remedy a user of a role-less scene actually needs: name the roles by patch and
  // get the standard four-view plan. This is the end-to-end path, not the field's.
  let rolled = { ...ROLELESS }
  const assignments = {
    'camera-main': 'active-camera',
    'camera-three-quarter': 'three-quarter',
    'camera-top': 'top',
    'camera-detail': 'detail',
  }
  for (const [cameraId, role] of Object.entries(assignments)) {
    rolled = applyPatchToSpec(rolled, {
      projectId: 'p', baseRevision: 'r0001',
      operations: [{ op: 'camera.update', cameraId, role }],
    }).spec
  }
  const stored = resolved(rolled)
  const replanned = buildViewPlan({ spec: stored })
  check('roles assigned BY PATCH survive storage and rebuild the standard four-view plan',
    replanned.views.map(view => `${view.id}->${view.cameraId}`).join(',') ===
    'active-camera->camera-main,three-quarter->camera-three-quarter,top->camera-top,detail->camera-detail',
    replanned.views.map(view => `${view.id}->${view.cameraId}`))
  check('and that plan needs no notices, because nothing was left undetermined',
    replanned.notices.length === 0, replanned.notices)

  // Two cameras claiming one role must not silently drop the role from the plan.
  const doubled = resolved(applyPatchToSpec(resolved(WITH_ROLES), {
    projectId: 'p', baseRevision: 'r0001',
    operations: [{ op: 'camera.update', cameraId: 'camera-3q', role: 'detail' }],
  }).spec)
  check('when two cameras claim one role, the role is still filled rather than dropped',
    buildViewPlan({ spec: doubled }).views.some(view => view.id === 'detail'),
    buildViewPlan({ spec: doubled }).views.map(view => `${view.id}->${view.cameraId}`))
}

// ---------------------------------------------------------------------------
// 6. A legacy, unresolved document still reads correctly
// ---------------------------------------------------------------------------

{
  // Revisions are immutable, so any unresolved document written by earlier code is on
  // disk permanently. Repairing them is not an option; reading them is.
  const legacy = {
    ...fixtureSpec,
    cameras: [...fixtureSpec.cameras, { id: 'camera-legacy', lens: 50, targetPoint: [0, 0, 0] }],
    entities: [...fixtureSpec.entities, { id: 'legacy-bare', type: 'generator', generator: { shape: 'uv_sphere' } }],
  }
  let crashed = null
  let summary = null
  try { summary = summarizeSceneSpec(legacy) } catch (cause) { crashed = cause.message }
  check('an unresolved legacy document summarises instead of throwing',
    crashed === null && summary !== null, crashed)
  check('and carries no non-finite numbers, so it cannot be mistaken for real geometry',
    summary !== null && nonFinite(summary).length === 0, summary === null ? null : nonFinite(summary).slice(0, 4))
  check('the legacy camera is still reported, with its resolved position',
    summary !== null && summary.cameras.some(camera => camera.id === 'camera-legacy' && Number.isFinite(camera.location[0])))
  check('the digest reported for a legacy document is the DOCUMENT\'s, not the resolved projection\'s',
    summary !== null && summary.digest === sceneSpecDigest(legacy) &&
    summary.digest !== sceneSpecDigest(compileSceneSpec(legacy).spec),
    { reported: summary?.digest?.slice(0, 16), document: sceneSpecDigest(legacy).slice(0, 16) })

  check('the legacy document is still schema-valid, so this is a legal input, not a corrupt one',
    validateSceneSpec(legacy).ok, validateSceneSpec(legacy).summary)
}

// ---------------------------------------------------------------------------
// 6b. One vocabulary, three copies — assert they still agree
// ---------------------------------------------------------------------------

{
  // `camera.update`'s field list exists in the JSON Schema's `$defs.camera` (used by
  // `camera.add`), in the `camera.update` branch's own properties, and in the semantic
  // validator. Adding `role` to only two of them produced a rejection that named the
  // wrong problem, so the agreement is now a test rather than a hope.
  const schema = JSON.parse(await readFile(join(ROOT, 'deepblend', 'schemas', 'scene-patch.schema.json'), 'utf8'))
  const idAndLifecycle = new Set(['id', 'op', 'cameraId'])
  const asFields = keys => keys.filter(key => !idAndLifecycle.has(key)).sort()

  const addFields = asFields(Object.keys(schema['$defs'].camera.properties))
  let updateBranch = null
  for (const branch of schema['$defs'].operation.oneOf ?? []) {
    if (branch.properties?.op?.const === 'camera.update') { updateBranch = branch; break }
  }
  const updateFields = asFields(Object.keys(updateBranch.properties))

  check('the schema agrees with itself: camera.add and camera.update accept one field set',
    JSON.stringify(addFields) === JSON.stringify(updateFields),
    { add: addFields, update: updateFields })
  check('the semantic validator accepts exactly the fields the schema does',
    JSON.stringify(asFields([...CAMERA_UPDATE_FIELDS])) === JSON.stringify(updateFields),
    { validator: asFields([...CAMERA_UPDATE_FIELDS]), schema: updateFields })
  check('role is in that shared set, so it is settable by both operations',
    addFields.includes('role') && updateFields.includes('role'))
}

// ---------------------------------------------------------------------------
// 6c. A result must survive the harness's lossless-JSON rule
// ---------------------------------------------------------------------------

{
  // THE DEFECT THIS CATCHES, in the words of the session that hit it: "both
  // blender_scene_patch calls returned `invalid output: value is not lossless JSON`,
  // but both commits landed."
  //
  // The harness's rule (`dsh-util-values`) rejects `undefined`, non-finite numbers AND
  // NEGATIVE ZERO. Blender's Python writes `-0.0` for a rotation that is exactly zero,
  // Node parses it as `-0`, and JSON.stringify(-0) is "0" — so a number that means the
  // same thing on both sides makes the round trip "lossy" and the whole call is refused.
  // Reproduced before the fix at
  // `data.validation.cameraParameters[1].rotationEuler[1] = -0`.
  //
  // Why 843 assertions missed it: this suite's own snapshot used
  // `JSON.parse(JSON.stringify(x))`, which NORMALIZES -0 to 0. A check that is weaker
  // than the thing it checks cannot fail.

  check('the predicate really does reject -0 (so the tests below mean something)',
    !isJsonValue(-0) && isJsonValue(0) && !isJsonValue(NaN) && !isJsonValue(undefined))

  const { losslessJson } = await import('../../../packages/deepblend/tool/lib/shared.js')

  check('a payload carrying -0 from Blender is rejected by the raw rule',
    !isJsonValue({ validation: { cameraParameters: [{ rotationEuler: [0, -0, 0] }] } }))

  const cleaned = losslessJson({ validation: { cameraParameters: [{ rotationEuler: [0, -0, 0] }] } })
  check('the boundary turns it into something the harness accepts',
    isJsonValue(cleaned.value), cleaned.value)
  check('and -0 becomes 0, which is the same number and loses nothing',
    Object.is(cleaned.value.validation.cameraParameters[0].rotationEuler[1], 0) &&
    !Object.is(cleaned.value.validation.cameraParameters[0].rotationEuler[1], -0))
  check('-0 alone is not reported as a repair, because nothing was lost',
    cleaned.repairs.length === 0, cleaned.repairs)

  const withRubbish = losslessJson({ ok: true, missing: undefined, broken: NaN, huge: Infinity, fine: 3 })
  check('undefined keys are dropped and counted, not silently swallowed',
    isJsonValue(withRubbish.value) && withRubbish.value.missing === undefined &&
    withRubbish.repairs.some(repair => repair.kind === 'undefined' && repair.path === 'missing'),
    withRubbish.repairs)
  check('a non-finite number is replaced AND reported, because it means something computed nothing',
    withRubbish.value.broken === null && withRubbish.value.huge === null &&
    withRubbish.repairs.filter(repair => repair.kind !== 'undefined').length === 2,
    withRubbish.repairs)

  // The value that actually broke it, taken from the real project's stored technical
  // report: a camera rotation of exactly zero, written by Blender as -0.0.
  const realShape = {
    projectId: 'watch-commercial',
    revision: 'r0018',
    validation: { cameraParameters: [
      { id: 'camera-main', rotationEuler: [-0, 1.5708, -0] },
      { id: 'camera-top', rotationEuler: [0, -0, -0] },
    ] },
    scene: { bounds: { min: [-0.2426, -0.2426, -0], max: [0.2426, 0.2426, 0] } },
  }
  check('the real failing payload is now lossless',
    !isJsonValue(realShape) && isJsonValue(losslessJson(realShape).value))
}

// ---------------------------------------------------------------------------
// 6d. A product's own parts are not obstructions, and an absent part is a defect
// ---------------------------------------------------------------------------

{
  // The two readings that were inverted on a real watch:
  //   r0015  the dial sat INSIDE the case, invisible in every view  -> scored 100
  //   r0017  the dial stood proud and covers 56% of the case        -> scored  90
  // The measurement was right both times; the interpretation was backwards, because
  // nothing could say "this dial IS the watch".
  const aView = (objects, overrides = {}) => ({
    viewId: overrides.viewId ?? 'active-camera',
    metrics: {
      width: 400, height: 225,
      luminance: {
        mean: overrides.mean ?? 0.45, median: 0.45, p05: 0.15, p95: 0.75, stdDev: 0.2,
        clippedDarkFraction: 0.01, clippedBrightFraction: 0.01, histogram: new Array(64).fill(10),
      },
      objects,
    },
  })
  const body = (overrides = {}) => ({
    id: 'watch-body', viewId: 'active-camera',
    visiblePixels: 5000, silhouettePixels: 5000, visibleFraction: 1, occludedFraction: 0,
    frameCoverage: 0.25, silhouetteCoverage: 0.25, bbox: [0.25, 0.25, 0.75, 0.75],
    centroid: [0.5, 0.5], inFrame: true, occludedBy: [], part: false, ...overrides,
  })
  const dial = (overrides = {}) => ({
    id: 'watch-dial', viewId: 'active-camera',
    visiblePixels: 3000, silhouettePixels: 3000, visibleFraction: 1, occludedFraction: 0,
    frameCoverage: 0.12, silhouetteCoverage: 0.12, bbox: [0.3, 0.3, 0.7, 0.7],
    centroid: [0.5, 0.5], inFrame: true, occludedBy: [], part: true, ...overrides,
  })

  // r0017: the dial is in front of the case. The renderer excludes part-hits from the
  // case's occlusion count, so the case reads as fully visible — which is the truth.
  const proud = scoreReview([aView([body(), dial()])], { subjectId: 'watch-body' })
  check('a correct watch whose dial stands proud of its case is NOT reported as occluded',
    proud.issues.length === 0 && proud.score === 100, { score: proud.score, issues: proud.issues.map(i => i.code) })

  // r0015: the dial is buried. The case is fully visible (nothing is in front of it),
  // so the OLD rule had nothing to say — and the watch had no face.
  const buried = scoreReview([
    aView([
      body(),
      dial({ visiblePixels: 0, visibleFraction: 0, occludedFraction: 1, occludedBy: [{ entityId: 'watch-body', samples: 300, fraction: 1 }] }),
    ]),
  ], { subjectId: 'watch-body' })
  check('a watch whose dial is buried invisibly inside the case FAILS the review',
    buried.score < 90, { score: buried.score, issues: buried.issues.map(i => `${i.code}/${i.severity}`) })
  check('and the finding names the component that is missing, as a declared part',
    buried.issues.some(issue => issue.code === 'SUBJECT_PART_HIDDEN' && issue.objectId === 'watch-dial'),
    buried.issues.map(issue => `${issue.code}:${issue.objectId}`))
  check('a completely absent component is critical, not merely major',
    buried.issues.find(issue => issue.code === 'SUBJECT_PART_HIDDEN').severity === 'critical')
  check('the evidence names what it is behind, which is what a fix needs',
    /behind "watch-body"/.test(buried.issues.find(issue => issue.code === 'SUBJECT_PART_HIDDEN').evidence),
    buried.issues.find(issue => issue.code === 'SUBJECT_PART_HIDDEN').evidence)

  check('the ranking between the two is now the right way round',
    buried.score < proud.score, { correctWatch: proud.score, facelessWatch: buried.score })

  // A part that merely faces away from ONE camera is not a defect. A watch dial is on
  // the front face: the top-down view cannot see it, and neither can a view from behind.
  // The bar is "visible in at least one view", which is the weakest statement that is
  // still true of a component that is genuinely missing.
  const topside = [
    aView([body(), dial({ visibleFraction: 0, visiblePixels: 0, occludedBy: [{ entityId: 'watch-body', samples: 300, fraction: 1 }] })], { viewId: 'top' }),
    aView([body(), dial({ visibleFraction: 0.9, visiblePixels: 2700 })], { viewId: 'active-camera' }),
  ]
  check('a component visible in ONE view is not reported as missing, even if other views cannot see it',
    scoreReview(topside, { subjectId: 'watch-body' }).issues.length === 0,
    scoreReview(topside, { subjectId: 'watch-body' }).issues.map(i => `${i.code}:${i.viewId}`))
  const everywhereHidden = [
    aView([body(), dial({ visibleFraction: 0, visiblePixels: 0 })], { viewId: 'top' }),
    aView([body(), dial({ visibleFraction: 0.05, visiblePixels: 150 })], { viewId: 'active-camera' }),
  ]
  const absent = scoreReview(everywhereHidden, { subjectId: 'watch-body' })
  check('a component invisible in every view is reported exactly once for the whole review',
    absent.issues.filter(issue => issue.code === 'SUBJECT_PART_HIDDEN').length === 1,
    absent.issues.map(issue => `${issue.code}:${issue.viewId}`))
  check('and it is critical, because a required component is not in the shot at all',
    absent.issues.find(issue => issue.code === 'SUBJECT_PART_HIDDEN').severity === 'critical')

  // A part too small on screen cannot be judged present or absent.
  check('a component too small to judge is not reported as missing',
    scoreReview([aView([body(), dial({ silhouettePixels: 40, visiblePixels: 0, visibleFraction: 0 })])], { subjectId: 'watch-body' }).issues.length === 0)

  // THE INTERIOR ROOM MUST STILL FAIL: the screen is not part of the table.
  const room = scoreReview([
    aView([
      { ...body(), id: 'coffee-table', visiblePixels: 2000, visibleFraction: 0.55, occludedFraction: 0.45, occludedBy: [{ entityId: 'screen', samples: 90, fraction: 0.45 }], part: false },
      { ...dial(), id: 'screen', part: false },
    ]),
  ], { subjectId: 'coffee-table' })
  check('an untagged obstruction in front of the subject is STILL reported',
    room.issues.some(issue => issue.code === 'SUBJECT_OCCLUDED' && issue.objectId === 'coffee-table'),
    room.issues.map(issue => `${issue.code}:${issue.objectId}`))
  check('and its evidence names the obstruction and offers the tag as the remedy',
    /mostly behind "screen"/.test(room.issues.find(issue => issue.code === 'SUBJECT_OCCLUDED').evidence) &&
    new RegExp(SUBJECT_PART_TAG).test(room.issues.find(issue => issue.code === 'SUBJECT_OCCLUDED').evidence),
    room.issues.find(issue => issue.code === 'SUBJECT_OCCLUDED').evidence)

  // The tag is what declares a part, and it is carried by the fixture.
  const spec = JSON.parse(await readFile(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))
  const compiled = compileSceneSpec(spec).spec
  check('the shipped fixture declares its product parts, so the example shows the mechanism',
    JSON.stringify(subjectPartsOf(compiled)) === JSON.stringify(['watch-crown', 'watch-dial']),
    subjectPartsOf(compiled))
  check('declared parts are tracked even when they are too small to rank',
    trackedObjects(compiled, 'watch-body').includes('watch-crown'),
    trackedObjects(compiled, 'watch-body'))
}

// ---------------------------------------------------------------------------
// 7. The shipped fixture is the example, so it must be exemplary
// ---------------------------------------------------------------------------

{
  const fixture = JSON.parse(await readFile(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))
  const compiled = compileSceneSpec(fixture).spec
  const plan = buildViewPlan({ spec: compiled, subjectId: resolveSubjectId(compiled) })
  check('the shipped fixture declares camera roles, so the demo project is a good example',
    fixture.cameras.every(camera => typeof camera.role === 'string'),
    fixture.cameras.map(camera => `${camera.id}:${camera.role ?? null}`))
  check('the fixture names its active camera',
    typeof fixture.project.activeCamera === 'string', fixture.project.activeCamera)
  check('the fixture plans without warning about unfilled or undeclared roles',
    !plan.notices.some(line => /no camera in this scene declares/.test(line)), plan.notices)

  const other = JSON.parse(await readFile(join(ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
  check('the interior-room fixture declares all four roles too',
    other.cameras.map(camera => camera.role).join(',') === 'active-camera,three-quarter,top,detail',
    other.cameras.map(camera => camera.role))
}

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok).length
console.log('')
console.log(`Patch resolution + view planning regression: ${results.length - failed}/${results.length} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
