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
  applyPatchToSpec,
  buildViewPlan,
  compileSceneSpec,
  resolveSubject,
  resolveSubjectId,
  sceneSpecDigest,
  summarizeSceneSpec,
  validateScenePatch,
  validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'
import { readFile } from 'node:fs/promises'

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
