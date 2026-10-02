import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyPatchToSpec, compileSceneSpec, resolveSubject, reviewInputsDigest, runVisualLoop,
  sceneSpecDigest, sha256Canonical, specHash, subjectParts, summarizeSceneSpec,
  validateArtisticReview, validateScenePatch, validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url), 'utf8'))
function scene() {
  const spec = structuredClone(fixture)
  spec.animationTracks = []
  spec.entities.push({ id: 'alternate', type: 'generator', generator: { shape: 'cube', size: .1 } })
  spec.entities.push({ id: 'pivot', type: 'empty' })
  return compileSceneSpec(spec).spec
}
const select = entityId => ({ op: 'project.reviewSubject.set', entityId })
const patch = operations => ({ projectId: fixture.project.id, baseRevision: 'r0001', operations })
function apply(spec, operations) {
  const request = patch(operations)
  assert.equal(validateScenePatch(request).ok, true, validateScenePatch(request).summary)
  return applyPatchToSpec(spec, request)
}

test('saved review subject compiles, summarizes, and overrides camera target without moving the camera', () => {
  const spec = scene(), cameras = structuredClone(spec.cameras)
  spec.project.reviewSubjectId = 'alternate'
  const compiled = compileSceneSpec(spec).spec
  const resolved = resolveSubject(compiled)
  assert.equal(resolved.id, 'alternate')
  assert.equal(resolved.mode, 'explicit')
  assert.equal(resolved.available, true)
  assert.equal(resolved.reason, null)
  assert.deepEqual(resolved.candidates, ['alternate'])
  assert.deepEqual(compiled.cameras, cameras)
  assert.equal(summarizeSceneSpec(compiled).project.reviewSubjectId, 'alternate')
})

for (const [label, id] of [['missing entity', 'absent'], ['empty object', 'pivot'], ['empty id', ''], ['null field', null]]) {
  test(`scene subject rejects ${label}`, () => {
    const spec = scene(); spec.project.reviewSubjectId = id
    assert.equal(validateSceneSpec(spec).ok, false)
  })
}
for (const operation of [{ op: 'project.reviewSubject.set' }, select(''), select(42)]) {
  test(`patch subject rejects malformed ${JSON.stringify(operation)}`, () => {
    assert.equal(validateScenePatch(patch([operation])).ok, false)
  })
}
for (const [id, code] of [['absent', 'PATCH_REFERENCE_MISSING'], ['pivot', 'PATCH_OPERATION_INVALID']]) {
  test(`subject patch rejects ${id} without mutating its input`, () => {
    const spec = scene(), before = structuredClone(spec)
    assert.throws(() => apply(spec, [select(id)]), error => error.patchIssue?.code === code)
    assert.deepEqual(spec, before)
  })
}

test('set and clear change only project identity; clearing restores the exact old document and digest', () => {
  const spec = scene(), request = [select('alternate')], before = structuredClone(spec)
  const changed = apply(spec, request)
  assert.deepEqual(spec, before)
  assert.deepEqual(request, [select('alternate')])
  assert.equal(changed.digestBefore, changed.digestAfter)
  assert.notEqual(changed.specHashBefore, changed.specHashAfter)
  assert.notEqual(reviewInputsDigest(changed.spec), reviewInputsDigest(spec))
  assert.deepEqual(changed.operations[0].changedPaths, ['project.reviewSubjectId'])
  const restored = apply(changed.spec, [select(null)]).spec
  assert.equal(Object.hasOwn(restored.project, 'reviewSubjectId'), false)
  assert.deepEqual(restored, spec)
  assert.equal(specHash(restored), specHash(spec))
  assert.equal(sceneSpecDigest(restored), sceneSpecDigest(spec))
  assert.equal(reviewInputsDigest(restored), reviewInputsDigest(spec))
})

test('legacy no-subject review digest remains byte-for-byte compatible with the old hash shape', () => {
  const spec = scene()
  assert.equal(reviewInputsDigest(spec), sha256Canonical({ goal: spec.project.goal ?? '', referenceImages: [] }))
  const changed = structuredClone(spec); changed.project.reviewSubjectId = 'alternate'
  assert.notEqual(reviewInputsDigest(changed), reviewInputsDigest(spec))
  assert.equal(summarizeSceneSpec(spec).project.reviewSubjectId, null)
})

test('removing a selected entity is rejected, while clear then remove is one legal atomic patch', () => {
  const spec = apply(scene(), [select('alternate')]).spec
  assert.throws(() => apply(spec, [{ op: 'entity.remove', entityId: 'alternate' }]), error => error.patchIssue?.code === 'PATCH_TARGET_IN_USE')
  const result = apply(spec, [select(null), { op: 'entity.remove', entityId: 'alternate' }]).spec
  assert.equal(result.entities.some(entity => entity.id === 'alternate'), false)
  assert.equal(Object.hasOwn(result.project, 'reviewSubjectId'), false)
  assert.equal(validateSceneSpec(result).ok, true)
  assert.throws(() => apply(spec, [{ op: 'entity.remove', entityId: 'alternate' }, select(null)]), error => error.patchIssue?.code === 'PATCH_TARGET_IN_USE')
})

test('adding an entity then selecting it uses the evolving patch document', () => {
  const result = apply(scene(), [
    { op: 'entity.add', entity: { id: 'new-product', type: 'generator', generator: { shape: 'cube' } } },
    select('new-product'),
  ]).spec
  assert.equal(result.project.reviewSubjectId, 'new-product')
  assert.equal(validateSceneSpec(result).ok, true)
})

test('hiding a selected entity preserves the binding and never silently selects another object', () => {
  const selected = apply(scene(), [select('alternate')]).spec
  const hidden = apply(selected, [{ op: 'entity.visibility.set', entityId: 'alternate', visible: false }]).spec
  assert.equal(validateSceneSpec(hidden).ok, true)
  const rebuilt = compileSceneSpec(hidden).spec
  assert.equal(rebuilt.project.reviewSubjectId, 'alternate')
  assert.equal(rebuilt.entities.find(entity => entity.id === 'alternate').visible, false)
  const resolved = resolveSubject(hidden)
  assert.equal(resolved.id, 'alternate'); assert.equal(resolved.mode, 'explicit')
  assert.equal(resolved.available, false); assert.match(resolved.reason, /hidden/)
  assert.equal(reviewInputsDigest(hidden), reviewInputsDigest(selected))
})

test('defensive resolution retains missing or empty explicit ids and records unavailability', () => {
  for (const [id, pattern] of [['absent', /does not exist/], ['pivot', /empty/]]) {
    const spec = scene(); spec.project.reviewSubjectId = id
    const result = resolveSubject(spec)
    assert.equal(result.id, id); assert.equal(result.available, false); assert.match(result.reason, pattern)
  }
})

test('automatic mode preserves camera target priority and records the absence of a subject', () => {
  const spec = scene(), active = spec.cameras.find(camera => camera.id === spec.project.activeCamera)
  assert.equal(resolveSubject(spec).mode, 'automatic')
  assert.equal(resolveSubject(spec).id, active.targetEntityId)
  const result = resolveSubject({ entities: [{ id: 'floor', type: 'generator', generator: { shape: 'cube' }, tags: ['environment'] }] })
  assert.equal(result.id, null); assert.equal(result.available, false); assert.equal(result.mode, 'automatic')
  assert.equal(typeof result.reason, 'string')
})

test('selection leaves subject-part membership intact and does not absorb independent subject products', () => {
  const spec = scene(), parts = subjectParts(spec)
  spec.entities.find(entity => entity.id === 'alternate').tags = ['subject']
  const result = apply(spec, [select('alternate')]).spec
  assert.deepEqual(subjectParts(result), parts)
  assert.equal(subjectParts(result).includes('alternate'), false)
})

test('the actual speaker can explicitly review its cabinet despite a longer tagged cable', () => {
  const spec = compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/modular-speaker/scene-spec.json', import.meta.url), 'utf8'))).spec
  const selected = apply(spec, [select('cabinet-shell')]).spec
  const cameras = structuredClone(selected.cameras)
  selected.entities.find(entity => entity.id === 'power-cable').transform.scale = [100, 100, 100]
  selected.entities.reverse()
  assert.equal(resolveSubject(selected).id, 'cabinet-shell')
  assert.deepEqual(selected.cameras, cameras)
})

function art(status = 'pass') {
  return { dimensions: Object.fromEntries(['geometry', 'materials', 'lighting', 'goalFit'].map(dimension => [dimension,
    { status, viewId: 'hero', evidence: 'The rendered product supports this judgment.', confidence: .95 }])),
  comparison: { verdict: 'improved', viewId: 'hero', evidence: 'The candidate has a clearer product silhouette.', confidence: .95 } }
}

test('known unavailable subject cannot receive artistic pass or an optimistic comparison', () => {
  const result = validateArtisticReview(art(), new Set(['hero']), .8,
    { subject: { id: 'alternate', available: false, reason: 'The subject is hidden.' } })
  assert.equal(result.status, 'unassessable')
  assert.equal(result.comparison.verdict, 'unassessable')
  assert.ok(Object.values(result.dimensions).every(entry => entry.status === 'unassessable'))
  assert.ok(result.problems.includes('The subject is hidden.'))
  assert.equal(validateArtisticReview(art('needs_work'), new Set(['hero']), .8,
    { subject: { available: false } }).status, 'needs_work')
  assert.equal(validateArtisticReview(art(), new Set(['hero'])).status, 'pass')
})

function loop(options = {}) {
  const specs = { r0001: scene(), r0002: scene() }
  for (const spec of Object.values(specs)) spec.project.reviewSubjectId = 'alternate'
  options.changeSpec?.(specs.r0002)
  const requests = [], patches = [], restores = [], model = []
  const input = {
    projectId: fixture.project.id, revision: 'r0001', maxIterations: 1,
    review: async request => {
      requests.push(request)
      const spec = specs[request.revision]
      const review = { projectId: fixture.project.id, revision: request.revision,
        score: request.revision === 'r0001' ? 80 : 100, issues: [], perView: [{ viewId: 'hero' }],
        views: [{ viewId: 'hero', objects: [{ id: 'alternate' }] }],
        subjectId: 'alternate', subject: resolveSubject(spec), sceneContext: spec,
        reviewInputsDigest: reviewInputsDigest(spec), referenceImages: [] }
      options.changeReview?.(review)
      return review
    },
    reviewer: async request => { model.push(request); return { findings: [], artistic: art(request.baselineReview ? 'pass' : 'needs_work'),
      operations: options.operations ?? [{ op: 'entity.transform.update', entityId: 'alternate', scale: [1.1, 1, 1] }] } },
    patch: async request => { patches.push(request); return { revision: 'r0002' } },
    restore: async request => { restores.push(request); if (options.restoreError) throw options.restoreError },
  }
  return { input, requests, patches, restores, model }
}

test('loop fixes the baseline subject in later review requests and records the fixed identity', async () => {
  const world = loop(), result = await runVisualLoop(world.input)
  assert.equal(result.passed, true)
  assert.equal(Object.hasOwn(world.requests[0], 'subjectId'), false)
  assert.equal(Object.hasOwn(world.requests[1], 'subjectId'), true)
  assert.equal(world.requests[1].subjectId, 'alternate')
  assert.equal(result.subjectFixed, true); assert.equal(result.fixedSubjectId, 'alternate')
  assert.ok(result.rounds.every(round => round.fixedSubjectId === 'alternate'))
})

test('an automatically resolved baseline stays fixed when candidate tags, sizes and camera target change', async () => {
  const world = loop({ changeReview: r => {
    delete r.sceneContext.project.reviewSubjectId
    const active = r.sceneContext.cameras.find(camera => camera.id === r.sceneContext.project.activeCamera)
    active.targetEntityId = r.revision === 'r0001' ? 'alternate' : 'watch-body'
    if (r.revision === 'r0002') {
      r.sceneContext.entities.find(entity => entity.id === 'watch-body').transform.scale = [10, 10, 10]
      r.sceneContext.entities.find(entity => entity.id === 'alternate').tags = []
      assert.equal(resolveSubject(r.sceneContext).id, 'watch-body')
    }
    r.subject = { id: 'alternate', mode: r.revision === 'r0001' ? 'automatic' : 'fixed',
      source: 'baseline identity', candidates: ['alternate'], available: true, reason: null }
    r.reviewInputsDigest = reviewInputsDigest(r.sceneContext)
  } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.passed, true); assert.equal(result.fixedSubjectId, 'alternate')
  assert.equal(world.requests[1].subjectId, 'alternate')
})

test('an available offscreen subject remains a measurable failure, not a missing-subject stop', async () => {
  const world = loop({ changeReview: r => {
    r.views[0].objects[0] = { id: 'alternate', visiblePixels: 0, silhouettePixels: 0 }
    if (r.revision === 'r0002') r.score = 70
  } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.passed, false)
  assert.equal(result.finalRevision, 'r0001')
  assert.match(result.rounds[1].reason, /score did not improve/)
  assert.equal(world.model.length, 1)
  assert.equal(world.restores[0].expectedCurrentRevision, 'r0002')
})

for (const operation of [select('watch-body'), select(null),
  { op: 'entity.remove', entityId: 'alternate' }, { op: 'entity.visibility.set', entityId: 'alternate', visible: false }]) {
  test(`model operation cannot change the fixed subject: ${JSON.stringify(operation)}`, async () => {
    const world = loop({ operations: [operation] }), result = await runVisualLoop(world.input)
    assert.equal(result.stopReason, 'REVIEW_SUBJECT_OPERATION_REFUSED')
    assert.equal(world.patches.length, 0); assert.equal(world.restores.length, 0)
  })
}

for (const [name, mutate, reason] of [
  ['different reported id', r => { r.subjectId = 'watch-body' }, 'REVIEW_SUBJECT_CHANGED'],
  ['missing reported id', r => { delete r.subjectId }, 'REVIEW_SUBJECT_CHANGED'],
  ['different subject detail', r => { r.subject.id = 'watch-body' }, 'REVIEW_SUBJECT_CHANGED'],
  ['missing subject detail', r => { delete r.subject }, 'REVIEW_SUBJECT_CHANGED'],
  ['missing scene context', r => { delete r.sceneContext }, 'REVIEW_SUBJECT_CHANGED'],
  ['missing entity', r => { r.sceneContext.entities = r.sceneContext.entities.filter(e => e.id !== 'alternate') }, 'REVIEW_SUBJECT_UNAVAILABLE'],
  ['hidden entity', r => { r.sceneContext.entities.find(e => e.id === 'alternate').visible = false }, 'REVIEW_SUBJECT_UNAVAILABLE'],
  ['empty entity', r => { r.sceneContext.entities.find(e => e.id === 'alternate').type = 'empty' }, 'REVIEW_SUBJECT_UNAVAILABLE'],
  ['missing measurements', r => { r.subject.available = false; r.subject.reason = 'measurement-missing' }, 'REVIEW_SUBJECT_UNAVAILABLE'],
]) {
  test(`candidate ${name} is rejected before artistic comparison and rolls back conditionally`, async () => {
    const world = loop({ changeReview: r => { if (r.revision === 'r0002') mutate(r) } })
    const result = await runVisualLoop(world.input)
    assert.equal(result.finalRevision, 'r0001'); assert.equal(result.stopReason, reason)
    assert.equal(world.model.length, 1)
    assert.equal(world.restores.length, 1)
    assert.equal(world.restores[0].revision, 'r0001')
    assert.equal(world.restores[0].expectedCurrentRevision, 'r0002')
  })
}

test('subject-change rollback conflict is propagated without an unconditional retry', async () => {
  const conflict = new Error('another editor moved the current pointer')
  const world = loop({ restoreError: conflict, changeReview: r => { if (r.revision === 'r0002') r.subjectId = 'watch-body' } })
  await assert.rejects(runVisualLoop(world.input), error => error === conflict)
  assert.equal(world.restores.length, 1)
  assert.equal(world.restores[0].expectedCurrentRevision, 'r0002')
})

test('known unavailable baseline never calls the model or patches and cannot pass on a score of 100', async () => {
  const world = loop({ changeReview: r => { r.score = 100; r.subject.available = false; r.subject.reason = 'measurement-missing' } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.stopReason, 'REVIEW_SUBJECT_UNAVAILABLE')
  assert.equal(result.passed, false); assert.equal(result.technicalPassed, false)
  assert.equal(world.model.length, 0); assert.equal(world.patches.length, 0)
})

test('known null baseline remains fixed null and cannot silently fall back to another subject', async () => {
  const world = loop({ changeReview: r => { r.subjectId = null; r.subject = { id: null, available: false, reason: 'No subject.' } } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.subjectFixed, true); assert.equal(result.fixedSubjectId, null)
  assert.equal(result.stopReason, 'REVIEW_SUBJECT_UNAVAILABLE')
  assert.equal(world.requests.length, 1)
})

test('a scene-backed baseline must report its actual subject id', async () => {
  const world = loop({ changeReview: r => { delete r.subjectId } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.stopReason, 'REVIEW_SUBJECT_CHANGED')
  assert.equal(world.patches.length, 0)
})

test('legacy ports without subject or scene context retain compatibility without invented subject identity', async () => {
  const world = loop({ changeReview: r => {
    delete r.sceneContext; delete r.reviewInputsDigest; delete r.subjectId; delete r.subject
  } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.passed, true); assert.equal(result.subjectFixed, false)
  assert.ok(world.requests.every(request => !Object.hasOwn(request, 'subjectId')))
})
