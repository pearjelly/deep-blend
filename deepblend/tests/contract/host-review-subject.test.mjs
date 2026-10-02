/** Real Host revisions, rendering orchestration, and loop identity; only Blender pixels are substituted. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig, buildReviewerPrompt } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, resolveSubject, sceneSpecDigest } from '@deepblend/dsh-blender-contracts'

const PNG = encodePng(createImage(24, 18, [70, 90, 130, 255]))
const source = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const dimensions = ['geometry', 'materials', 'lighting', 'goalFit']
function answer(review, improved = false) {
  const viewId = review.perView[0].viewId
  return { findings: [], operations: [], artistic: {
    dimensions: Object.fromEntries(dimensions.map(name => [name, { status: improved ? 'pass' : 'needs_work', viewId,
      confidence: 0.95, evidence: 'The visible edge highlight is continuous across the case.' }])),
    comparison: { verdict: improved ? 'improved' : 'unassessable', viewId, confidence: 0.95,
      evidence: 'The matching views show a softer transition along the edge.' },
  } }
}
async function setup(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-host-subject-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = [], control = { omit: false, offscreen: false }
  const runtime = {
    async resolveEngineKey() { return { blenderEngine: 'BLENDER_EEVEE_NEXT', warning: null } },
    async compileScene(request) {
      const directory = join(request.projectRoot, 'stub-compile')
      mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'result.blend'), 'stub checkpoint')
      request.onWorkingDirectory?.({ directory })
      return { report: { validation: { engine: 'BLENDER_EEVEE_NEXT' }, sceneFingerprint: { totalPolygons: 1200 } }, envelope: {} }
    },
    async renderViews(request) {
      calls.push(request)
      const views = request.views.map(view => ({ viewId: view.id, role: view.role, cameraId: view.cameraId, frame: view.frame,
        width: 24, height: 18, outputPath: `/scratch/${view.id}.png`, metrics: {
          objects: control.omit ? [] : request.track.map(id => ({ id, viewId: view.id,
            visiblePixels: control.offscreen ? 0 : 100, silhouettePixels: control.offscreen ? 0 : 100,
            inFrame: !control.offscreen, frameCoverage: control.offscreen ? 0 : 0.3,
            centroid: [0.5, 0.5], visibleFraction: control.offscreen ? 0 : 1, occludedFraction: 0,
          })),
          luminance: { mean: 0.4, p05: 0.1, p95: 0.7, clippedDarkFraction: 0, clippedBrightFraction: 0 },
        } }))
      return { envelope: {}, report: { views }, pngs: Object.fromEntries(views.map(view => [view.viewId, PNG])) }
    },
  }
  const ctx = new Context(); ctx.provide('blenderRuntime', runtime)
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const sceneSpec = structuredClone(source); mutate(sceneSpec)
  const created = await studio.createProject({ title: 'Review subject', sceneSpec, saveCheckpoint: true })
  const projectId = created.projectId
  const patch = async operations => studio.applyScenePatch({ projectId,
    baseRevision: studio.store.readRecord(projectId).currentRevision, operations, saveCheckpoint: true, renderPreview: false })
  return { studio, projectId, patch, calls, control }
}

test('saved explicit subject takes priority, joins explicit tracking, and persists in QA without moving cameras', async t => {
  const { studio, projectId, patch, calls } = await setup(t)
  const before = studio.store.readRevisionSpec(projectId, 'r0001')
  await patch([{ op: 'project.reviewSubject.set', entityId: 'watch-dial' }])
  const after = studio.store.readRevisionSpec(projectId, 'r0002')
  assert.deepEqual(after.cameras, before.cameras); assert.equal(sceneSpecDigest(after), sceneSpecDigest(before))
  const review = await studio.visualReview({ projectId, track: ['watch-body'] })
  assert.equal(review.subjectId, 'watch-dial'); assert.equal(review.subject.mode, 'explicit')
  assert.equal(review.subject.available, true); assert.ok(calls.at(-1).track.includes('watch-dial'))
  const stored = JSON.parse(readFileSync(join(studio.store.revisionDirectory(projectId, 'r0002'), 'visual-reviews/round-0.json'))).review
  assert.deepEqual(stored.subject, review.subject)
  assert.deepEqual((await studio.getQaRecord({ projectId })).review.subject, review.subject)
  await studio.restoreRevision({ projectId, revision: 'r0001', expectedCurrentRevision: 'r0002' })
  const restored = await studio.visualReview({ projectId })
  assert.equal(restored.subjectId, 'watch-body'); assert.equal(restored.subject.mode, 'automatic')
  assert.equal(resolveSubject(studio.store.readRevisionSpec(projectId, 'r0002')).id, 'watch-dial')
})

test('fixed subject survives a camera target change and is described to the reviewer', async t => {
  const { studio, projectId, patch } = await setup(t)
  await patch([{ op: 'camera.update', cameraId: 'camera-main', targetEntityId: 'watch-dial' }])
  const review = await studio.visualReview({ projectId, subjectId: 'watch-body' })
  assert.equal(review.subjectId, 'watch-body'); assert.equal(review.subject.mode, 'fixed'); assert.equal(review.subject.available, true)
  const prompt = buildReviewerPrompt(review, review.views)
  assert.match(prompt, /Keep this subject fixed/); assert.match(prompt, /project.reviewSubject.set/)
})

for (const [name, id] of [['null', null], ['missing ID', 'missing-object']]) {
  test(`fixed ${name} cannot fall back to the camera target or earn an artistic pass`, async t => {
    const { studio, projectId } = await setup(t)
    const review = await studio.visualReview({ projectId, subjectId: id, consultReviewer: true,
      reviewer: async ({ review }) => answer(review, true) })
    assert.equal(review.subjectId, id); assert.equal(review.subject.id, id)
    assert.equal(review.subject.available, false); assert.equal(review.pass, false); assert.equal(review.technicalPass, false)
    assert.equal(review.artistic.status, 'unassessable'); assert.equal(review.artistic.comparison.verdict, 'unassessable')
  })
}

test('hidden saved subject remains selected and stops the loop before a model call', async t => {
  const { studio, projectId, patch } = await setup(t)
  await patch([{ op: 'project.reviewSubject.set', entityId: 'watch-dial' }, { op: 'entity.visibility.set', entityId: 'watch-dial', visible: false }])
  let calls = 0
  const loop = await studio.visualLoop({ projectId, maxIterations: 1, reviewer: async () => { calls++; throw new Error('must not call') } })
  assert.equal(calls, 0); assert.equal(loop.stopReason, 'REVIEW_SUBJECT_UNAVAILABLE')
  assert.equal(loop.fixedSubjectId, 'watch-dial'); assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0002')
})

test('absent measurements cannot turn a numeric 100 into a passing review', async t => {
  const { studio, projectId, control } = await setup(t); control.omit = true
  const review = await studio.visualReview({ projectId, consultReviewer: true, reviewer: async ({ review }) => answer(review, true) })
  assert.equal(review.score, 100); assert.equal(review.technicalPass, false); assert.equal(review.pass, false)
  assert.equal(review.subject.available, false); assert.match(review.subject.reason, /no complete measurements/)
  assert.equal(review.artistic.status, 'unassessable')
})

test('measured zero coverage stays a measured composition defect, not a change of subject', async t => {
  const { studio, projectId, control } = await setup(t); control.offscreen = true
  const review = await studio.visualReview({ projectId })
  assert.equal(review.subjectId, 'watch-body'); assert.equal(review.subject.available, true)
  assert.ok(review.issues.some(issue => issue.objectId === 'watch-body')); assert.ok(review.score < 100)
})

test('Host loop keeps baseline identity across real revision changes and persists the fixed candidate', async t => {
  const { studio, projectId } = await setup(t)
  const seen = []
  const loop = await studio.visualLoop({ projectId, maxIterations: 1, reviewer: async ({ review, baselineReview }) => {
    seen.push(review.subject)
    const response = answer(review, Boolean(baselineReview))
    if (!baselineReview) response.operations = [{ op: 'camera.update', cameraId: 'camera-main', targetEntityId: 'watch-dial' }]
    return response
  } })
  assert.equal(loop.fixedSubjectId, 'watch-body'); assert.equal(seen.length, 2)
  assert.equal(seen[0].mode, 'automatic'); assert.equal(seen[1].mode, 'fixed'); assert.equal(seen[1].id, 'watch-body')
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0002')
  assert.equal(resolveSubject(studio.store.readRevisionSpec(projectId, 'r0002')).id, 'watch-dial')
  const dir = join(studio.store.revisionDirectory(projectId, 'r0002'), 'visual-reviews')
  const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir).find(file => /comparison.json$/.test(file))))).review
  assert.equal(saved.subject.id, 'watch-body'); assert.equal(saved.subject.mode, 'fixed')
})

test('candidate lost measurement triggers conditional restore without consulting the candidate model', async t => {
  const { studio, projectId, control } = await setup(t)
  let calls = 0
  const loop = await studio.visualLoop({ projectId, maxIterations: 1, reviewer: async ({ review }) => {
    calls++; control.omit = true
    return { ...answer(review), operations: [{ op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.3 }] }
  } })
  assert.equal(calls, 1); assert.equal(loop.stopReason, 'REVIEW_SUBJECT_UNAVAILABLE')
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  assert.equal(loop.rounds.at(-1).rolledBackTo, 'r0001')
})
