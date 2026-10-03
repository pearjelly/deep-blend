import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyPatchToSpec, compileSceneSpec, reviewInputsDigest, runVisualLoop,
  sceneSpecDigest, specHash, validateArtisticReview, validateScenePatch, validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'

const source = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url), 'utf8'))
const sha = 'a'.repeat(64), otherSha = 'b'.repeat(64)
const asset = { id: 'finish-photo', type: 'png', path: `assets/raw/${sha}.png`, sha256: sha }
const reference = { id: 'finish', assetId: asset.id, sha256: sha, label: 'Brushed metal finish', purposes: ['materials', 'goalFit'] }
function scene() {
  const spec = structuredClone(source)
  spec.project.goal = 'Match the brushed metal finish in the reference'
  spec.assets = [structuredClone(asset)]
  spec.project.referenceImages = [structuredClone(reference)]
  return spec
}
const patch = operations => ({ projectId: source.project.id, baseRevision: 'r0001', operations })
function apply(spec, operations) {
  const request = patch(operations)
  assert.equal(validateScenePatch(request).ok, true, validateScenePatch(request).summary)
  return applyPatchToSpec(compileSceneSpec(spec).spec, request)
}
const brief = (referenceImages = [], goal = '') => ({ op: 'project.brief.set', goal, referenceImages })

test('PNG and both JPEG extensions compile as reference assets without adding scene or material bindings', () => {
  for (const type of ['png', 'jpg', 'jpeg']) {
    const spec = scene(); spec.assets[0].type = type; spec.assets[0].path = `assets/raw/${sha}.${type}`
    assert.equal(validateSceneSpec(spec).ok, true, validateSceneSpec(spec).summary)
    const compiled = compileSceneSpec(spec).spec
    assert.deepEqual(compiled.project.referenceImages, spec.project.referenceImages)
    assert.deepEqual(compiled.materials, compileSceneSpec(source).spec.materials)
    assert.deepEqual(compiled.entities, compileSceneSpec(source).spec.entities)
  }
})

for (const [name, mutate] of [
  ['more than four images', s => { s.project.referenceImages = Array.from({ length: 5 }, (_, i) => ({ ...reference, id: `ref-${i}` })) }],
  ['duplicate reference ids', s => s.project.referenceImages.push({ ...reference })],
  ['duplicate purposes', s => { s.project.referenceImages[0].purposes = ['materials', 'materials'] }],
  ['missing purposes', s => { s.project.referenceImages[0].purposes = [] }],
  ['unknown purpose', s => { s.project.referenceImages[0].purposes = ['texture'] }],
  ['empty label', s => { s.project.referenceImages[0].label = '' }],
  ['oversized label', s => { s.project.referenceImages[0].label = 'x'.repeat(161) }],
  ['oversized notes', s => { s.project.referenceImages[0].notes = 'x'.repeat(1001) }],
  ['missing asset', s => { s.assets = [] }],
  ['model asset', s => { s.assets[0].type = 'glb'; s.assets[0].path = `assets/raw/${sha}.glb` }],
  ['HDR asset', s => { s.assets[0].type = 'hdr'; s.assets[0].path = `assets/raw/${sha}.hdr` }],
  ['unpinned asset', s => { delete s.assets[0].sha256 }],
  ['asset hash mismatch', s => { s.assets[0].sha256 = otherSha }],
  ['non-content-addressed path', s => { s.assets[0].path = 'assets/raw/photo.png' }],
  ['path hash mismatch', s => { s.assets[0].path = `assets/raw/${otherSha}.png` }],
  ['path type mismatch', s => { s.assets[0].path = `assets/raw/${sha}.jpeg` }],
  ['remote asset path', s => { s.assets[0].path = 'https://example.test/photo.png' }],
  ['reference URL property', s => { s.project.referenceImages[0].url = 'https://example.test/photo.png' }],
]) test(`reference validation rejects ${name}`, () => {
  const spec = scene(); mutate(spec)
  const verdict = validateSceneSpec(spec)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.errors.some(issue => issue.path.includes('referenceImages')), verdict.summary)
})

test('four references, maximum label/notes, and all distinct purposes are allowed', () => {
  const spec = scene()
  spec.project.referenceImages = Array.from({ length: 4 }, (_, i) => ({ ...reference, id: `ref-${i}`,
    label: 'x'.repeat(160), notes: 'x'.repeat(1000), purposes: ['geometry', 'materials', 'lighting', 'goalFit'] }))
  assert.equal(validateSceneSpec(spec).ok, true, validateSceneSpec(spec).summary)
})

test('brief-only changes preserve sceneDigest while specHash and reviewInputsDigest change', () => {
  const spec = scene(), changed = structuredClone(spec)
  changed.project.goal = 'A distinct finish'
  changed.project.referenceImages[0].notes = 'Match only the edge highlight'
  assert.equal(sceneSpecDigest(spec), sceneSpecDigest(changed))
  assert.notEqual(specHash(spec), specHash(changed))
  assert.notEqual(reviewInputsDigest(spec), reviewInputsDigest(changed))
})

test('review input digest normalizes optional fields and reference/purpose order without mutating input', () => {
  const a = scene()
  a.project.referenceImages.push({ ...reference, id: 'second', purposes: ['lighting', 'geometry'] })
  const before = JSON.stringify(a), b = structuredClone(a)
  b.project.referenceImages.reverse()
  for (const ref of b.project.referenceImages) { ref.purposes.reverse(); ref.notes = '' }
  assert.equal(reviewInputsDigest(a), reviewInputsDigest(b))
  assert.equal(JSON.stringify(a), before)
  assert.equal(reviewInputsDigest({}), reviewInputsDigest({ project: { goal: '', referenceImages: [] } }))
})

test('review input digest binds resolved asset content and metadata, excluding unrelated scene edits', () => {
  const spec = scene(), original = reviewInputsDigest(spec)
  for (const [key, value] of [['sha256', otherSha], ['path', `assets/raw/${otherSha}.png`], ['type', 'jpeg']]) {
    const changed = structuredClone(spec); changed.assets[0][key] = value
    assert.notEqual(reviewInputsDigest(changed), original, key)
  }
  const changed = structuredClone(spec)
  changed.entities[0].visible = false
  changed.assets.push({ ...asset, id: 'unrelated', sha256: otherSha, path: `assets/raw/${otherSha}.png` })
  changed.project.title = 'Different title'
  assert.equal(reviewInputsDigest(changed), original)
})

test('brief.set requires both fields, enforces local uniqueness and keeps the goal length limit', () => {
  for (const operation of [
    { op: 'project.brief.set', goal: '' }, { op: 'project.brief.set', referenceImages: [] },
    brief([], 'x'.repeat(2001)), brief([reference, reference]),
    brief([{ ...reference, purposes: ['materials', 'materials'] }]),
  ]) assert.equal(validateScenePatch(patch([operation])).ok, false)
  assert.equal(validateScenePatch(patch([brief([], 'x'.repeat(2000))])).ok, true)
})

test('asset.add followed by brief.set is atomic, clones references and preserves unrelated fields', () => {
  const spec = structuredClone(source), refs = [structuredClone(reference)], before = JSON.stringify(spec)
  const result = apply(spec, [{ op: 'asset.add', asset }, brief(refs, 'New target')])
  assert.equal(validateSceneSpec(result.spec).ok, true)
  assert.equal(result.spec.project.fps, spec.project.fps)
  refs[0].purposes.push('lighting')
  assert.deepEqual(result.spec.project.referenceImages[0].purposes, ['materials', 'goalFit'])
  assert.equal(JSON.stringify(spec), before)
  assert.deepEqual(result.operations[1].changedPaths, ['project.goal', 'project.referenceImages'])
})

test('brief.set refuses unresolved or mismatched references without mutating the source', () => {
  const spec = scene(), before = JSON.stringify(spec)
  for (const invalid of [{ ...reference, assetId: 'absent' }, { ...reference, sha256: otherSha }]) {
    assert.throws(() => apply(spec, [brief([invalid])]), error =>
      ['PATCH_REFERENCE_MISSING', 'PATCH_OPERATION_INVALID'].includes(error.patchIssue?.code))
  }
  assert.equal(JSON.stringify(spec), before)
})

test('asset.remove refuses referenced bytes until the same patch clears the brief first', () => {
  const spec = scene()
  assert.throws(() => apply(spec, [{ op: 'asset.remove', assetId: asset.id }, brief()]),
    error => error.patchIssue?.code === 'PATCH_TARGET_IN_USE')
  const result = apply(spec, [brief(), { op: 'asset.remove', assetId: asset.id }])
  assert.equal(result.spec.project.goal, '')
  assert.deepEqual(result.spec.project.referenceImages, [])
  assert.equal(result.spec.assets?.length ?? 0, 0)
  assert.equal(validateSceneSpec(result.spec).ok, true)
})

const viewIds = new Set(['hero'])
function artistic(status = 'pass', verdict = 'equivalent') {
  return {
    dimensions: Object.fromEntries(['geometry', 'materials', 'lighting', 'goalFit'].map(dimension => [dimension,
      { status, viewId: 'hero', confidence: .95, evidence: `The visible ${dimension} is consistent with the authored target`,
        ...(['materials', 'goalFit'].includes(dimension) ? { referenceIds: ['finish'] } : {}) }])),
    comparison: { verdict, viewId: 'hero', confidence: .95, evidence: 'The candidate has a clearer rounded silhouette than the baseline' },
  }
}
const referenceContext = { referenceImages: [reference] }

test('artistic assessment retains validated reference ids and allows no-reference legacy calls', () => {
  const raw = artistic(), result = validateArtisticReview(raw, viewIds, .8, referenceContext)
  assert.equal(result.status, 'pass')
  assert.deepEqual(result.dimensions.materials.referenceIds, ['finish'])
  raw.dimensions.materials.referenceIds.push('mutated')
  assert.deepEqual(result.dimensions.materials.referenceIds, ['finish'])
  const legacy = artistic()
  for (const entry of Object.values(legacy.dimensions)) delete entry.referenceIds
  assert.equal(validateArtisticReview(legacy, viewIds).status, 'pass')
})

for (const [name, ids] of [['missing', undefined], ['empty', []], ['invented', ['not-attached']],
  ['duplicate', ['finish', 'finish']], ['wrong type', 'finish']]) {
  test(`artistic assessment refuses ${name} reference evidence on a required dimension`, () => {
    const raw = artistic(); raw.dimensions.materials.referenceIds = ids
    const result = validateArtisticReview(raw, viewIds, .8, referenceContext)
    assert.equal(result.dimensions.materials.status, 'unassessable')
    assert.equal(result.dimensions.geometry.status, 'pass')
    assert.notEqual(result.status, 'pass')
  })
}

test('a reference can support only its authored purposes and only when actually supplied', () => {
  const raw = artistic(); raw.dimensions.geometry.referenceIds = ['finish']
  assert.equal(validateArtisticReview(raw, viewIds, .8, referenceContext).dimensions.geometry.status, 'unassessable')
  assert.equal(validateArtisticReview(artistic(), viewIds).dimensions.materials.status, 'unassessable')
})

test('an explicitly unassessable referenced dimension may omit a claim to reference evidence', () => {
  const raw = artistic(); raw.dimensions.materials.status = 'unassessable'; delete raw.dimensions.materials.referenceIds
  const result = validateArtisticReview(raw, viewIds, .8, referenceContext)
  assert.equal(result.dimensions.materials.status, 'unassessable')
  assert.ok(!result.problems.some(message => message.startsWith('materials:')))
})

test('a passing dimension must cover every applicable reference rather than selecting only the best match', () => {
  const context = { referenceImages: [reference, { ...reference, id: 'second-finish', purposes: ['materials'] }] }
  const raw = artistic()
  assert.equal(validateArtisticReview(raw, viewIds, .8, context).dimensions.materials.status, 'unassessable')
  raw.dimensions.materials.referenceIds.push('second-finish')
  const result = validateArtisticReview(raw, viewIds, .8, context)
  assert.equal(result.status, 'pass')
  assert.deepEqual(result.dimensions.materials.referenceIds, ['finish', 'second-finish'])
})

test('one evidenced mismatch is enough for needs_work with multiple applicable references', () => {
  const context = { referenceImages: [reference, { ...reference, id: 'second-finish', purposes: ['materials'] }] }
  const raw = artistic(); raw.dimensions.materials.status = 'needs_work'
  assert.equal(validateArtisticReview(raw, viewIds, .8, context).dimensions.materials.status, 'needs_work')
  raw.dimensions.materials.status = 'unassessable'; delete raw.dimensions.materials.referenceIds
  assert.equal(validateArtisticReview(raw, viewIds, .8, context).problems.length, 0)
})

function loopHarness(options = {}) {
  const patches = [], restores = [], reviewerInputs = [], specs = { r0001: scene(), r0002: scene() }
  options.changeCandidate?.(specs.r0002)
  const input = {
    projectId: source.project.id, revision: 'r0001', maxIterations: 1,
    review: async ({ revision }) => {
      const result = { revision, projectId: source.project.id, subjectId: 'watch-body', score: revision === 'r0001' ? 80 : 100,
        issues: [], perView: [{ viewId: 'hero' }], views: [{ viewId: 'hero', objects: [] }],
        sceneContext: specs[revision], referenceImages: structuredClone(specs[revision].project.referenceImages),
        reviewInputsDigest: reviewInputsDigest(specs[revision]) }
      options.changeReview?.(result)
      return result
    },
    reviewer: async request => {
      reviewerInputs.push(request)
      return { findings: [], artistic: artistic(request.baselineReview ? 'pass' : 'needs_work', 'improved'),
        operations: options.operations ?? [{ op: 'material.parameter.update', materialId: 'case-metal', parameter: 'roughness', value: .3 }] }
    },
    patch: async request => { patches.push(request); return { revision: 'r0002' } },
    restore: async request => { restores.push(request); if (options.restoreError) throw options.restoreError },
  }
  return { input, patches, restores, reviewerInputs }
}

test('loop accepts a scene improvement with the same fixed review inputs', async () => {
  const world = loopHarness(), result = await runVisualLoop(world.input)
  assert.equal(result.finalRevision, 'r0002'); assert.equal(result.passed, true)
  assert.equal(world.restores.length, 0)
})

for (const operation of [brief(), { op: 'asset.remove', assetId: asset.id }, { op: 'asset.add', asset: { ...asset, sha256: otherSha } }]) {
  test(`loop refuses ${operation.op} that changes the evaluation target before committing`, async () => {
    const world = loopHarness({ operations: [{ operation, confidence: .99 }] })
    const result = await runVisualLoop(world.input)
    assert.equal(result.finalRevision, 'r0001'); assert.equal(world.patches.length, 0); assert.equal(world.restores.length, 0)
    assert.equal(result.handover.reason, 'REVIEW_INPUT_OPERATION_REFUSED')
  })
}

for (const [name, changeCandidate, changeReview] of [
  ['goal', s => { s.project.goal = 'An easier target' }],
  ['reference notes', s => { s.project.referenceImages[0].notes = 'Ignore finish defects' }],
  ['resolved asset', s => { s.assets[0].path = `assets/raw/${otherSha}.png` }],
  ['claimed digest', undefined, r => { if (r.revision === 'r0002') r.reviewInputsDigest = otherSha }],
  ['missing input identity', undefined, r => { if (r.revision === 'r0002') { delete r.reviewInputsDigest; delete r.sceneContext; r.referenceImages = [] } }],
]) test(`loop conditionally rolls back changed ${name} before accepting an optimistic model comparison`, async () => {
  const world = loopHarness({ changeCandidate, changeReview }), result = await runVisualLoop(world.input)
  assert.equal(result.finalRevision, 'r0001'); assert.equal(result.handover.reason, 'REVIEW_INPUTS_CHANGED')
  assert.equal(world.reviewerInputs.length, 1)
  assert.equal(world.restores[0].revision, 'r0001'); assert.equal(world.restores[0].expectedCurrentRevision, 'r0002')
})

test('input-change rollback conflict propagates and never retries an unconditional restore', async () => {
  const conflict = Object.assign(new Error('another editor moved to r0003'), { code: 'REVISION_CONFLICT' })
  const world = loopHarness({ changeCandidate: s => { s.project.goal = 'Changed target' }, restoreError: conflict })
  await assert.rejects(runVisualLoop(world.input), error => error === conflict)
  assert.equal(world.restores.length, 1)
  assert.equal(world.restores[0].expectedCurrentRevision, 'r0002')
})

test('missing actual attachments cannot pass despite authored references and valid model reference IDs', async () => {
  const world = loopHarness({ changeReview: review => { review.referenceImages = [] } })
  const result = await runVisualLoop(world.input)
  assert.equal(result.passed, false); assert.equal(result.finalRevision, 'r0001')
  assert.equal(result.artistic.status, 'unassessable')
  assert.ok(result.artistic.problems.some(message => message.includes('inventory')))
})
