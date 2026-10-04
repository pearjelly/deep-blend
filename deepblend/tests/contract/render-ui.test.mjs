/** The shipped client, HTTP handler and real Host must agree on which scene to render. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createHandlers } from '@deepblend/dsh-blender-ui'
import { createImage, encodePng, matchUiRoute } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
const core = loadClientBundle().exports.workbench
const source = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? files(path) : [[path, createHash('sha256').update(readFileSync(path)).digest('hex')]]
})

async function settle(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'client or renderer did not settle')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function harness(t, options = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-render-ui-'))
  const renderer = [], posts = [], hostCalls = [], compiles = []
  // The only replacement is the Blender process boundary. Host profile resolution,
  // checkpoint selection, job persistence and the resumed frame ledger all run normally.
  const runtime = {
    async compileScene(request) {
      compiles.push(request)
      const directory = join(request.projectRoot, 'controlled-compile')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'result.blend'), 'controlled checkpoint')
      request.onWorkingDirectory?.({ directory })
      return { report: { validation: {}, sceneFingerprint: { totalPolygons: 1200 } }, envelope: { warnings: [], notices: [] } }
    },
    async startFrameSequence(request) {
      renderer.push(clone(request))
      mkdirSync(join(request.jobDirectory, 'frames'), { recursive: true })
      return { handle: { terminate() {} }, jobDirectory: request.jobDirectory,
        framesDirectory: join(request.jobDirectory, 'frames'), eventsPath: join(request.jobDirectory, 'events.jsonl'),
        processPath: join(request.jobDirectory, 'process.json') }
    },
    // Leave a resumable job without spending Blender or encoder time.
    async awaitFrameSequence() { return { envelope: { status: 'failed' }, exitCode: 1, signal: null, durationMs: 1 } },
  }
  const ctx = new Context(); ctx.provide('blenderRuntime', runtime)
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'),
    finalRenderProfile: options.defaultProfile ?? 'final', progressPollMs: 100000 }))
  for (const method of ['startFinalRender', 'resumeRenderJob']) {
    const original = studio[method].bind(studio)
    studio[method] = async request => { hostCalls.push({ method, request: clone(request) }); return original(request) }
  }
  const project = await studio.transactions.createProject({ title: 'Render controls', sceneSpec: source, saveCheckpoint: options.saveCheckpoint ?? true })
  const projectId = project.projectId, revision = project.revision.revision
  const handlers = createHandlers({ blenderStudio: studio })
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost'), method = init.method ?? 'GET'
    const route = matchUiRoute(method, parsed.pathname)
    assert.ok(route, `unknown client route ${method} ${parsed.pathname}`)
    const body = init.body ? JSON.parse(init.body) : {}
    if (method === 'POST') {
      posts.push({ projectId: route.params.projectId, body })
      await options.beforePost?.({ body, studio, projectId })
    }
    await options.beforeRead?.({ method, route })
    let payload
    try {
      payload = { ok: true, route: route.route.id, hostApiVersion: studio.hostApiVersion(),
        ...await handlers[route.route.id]({ params: route.params, query: Object.fromEntries(parsed.searchParams), body }) }
    } catch (error) { payload = { ok: false, error: { code: error.code, message: error.message } } }
    return { ok: payload.ok, status: payload.ok ? 200 : 400, json: async () => clone(payload), text: async () => JSON.stringify(payload) }
  }
  const store = core.createWorkbenchStore({ fetch, pollIdleMs: 100000, pollLiveMs: 100000 })
  t.after(async () => { store.stop(); await settle(() => studio._liveRenders.size === 0); rmSync(workspaceRoot, { recursive: true, force: true }) })
  store.start(); await settle(() => store.getState().status === 'ok')
  store.actions.setForm('frameStart', '2'); store.actions.setForm('frameEnd', '3')
  const record = () => studio.renderJobs.read(projectId, renderer.at(-1).jobId)
  const finished = () => settle(() => studio._liveRenders.size === 0)
  const advance = async () => studio.transactions.applyScenePatch({ projectId, baseRevision: revision, saveCheckpoint: false,
    operations: [{ op: 'render.profile.set', profileName: 'preview', profile: { resolution: [80, 60], samples: 19 } }] }, {})
  return { store, studio, handlers, projectId, revision, renderer, posts, hostCalls, compiles, record, finished, advance }
}

for (const profile of ['preview', 'final']) test(`the ${profile} selection reaches the renderer even when the Host default is different`, async t => {
  const h = await harness(t, { defaultProfile: profile === 'preview' ? 'final' : 'preview' })
  h.store.actions.setForm('profile', profile); await h.store.actions.startRender(); await h.finished()
  assert.equal(h.renderer.length, 1); assert.equal(h.renderer[0].profileName, profile)
  assert.deepEqual(h.renderer[0].profile, h.studio.store.readRevisionSpec(h.projectId, h.revision).renderProfiles[profile])
  assert.deepEqual(h.renderer[0].frames, [2, 3]); assert.equal(h.posts[0].body.profile, profile)
  assert.equal(h.hostCalls[0].request.profileName, profile); assert.equal(Object.hasOwn(h.hostCalls[0].request, 'profile'), false)
  assert.equal(h.record().profileName, profile); assert.deepEqual(h.record().renderConfig.resolution, source.renderProfiles[profile].resolution)
  assert.equal(h.record().renderConfig.samples, source.renderProfiles[profile].samples)
})

test('a concurrent scene edit cannot change the loaded revision submitted for rendering', async t => {
  const h = await harness(t, { beforePost: async ({ studio, projectId }) => {
    await studio.transactions.applyScenePatch({ projectId, baseRevision: 'r0001', saveCheckpoint: false,
      operations: [{ op: 'render.profile.set', profileName: 'final', profile: { resolution: [80, 60], samples: 19 } }] }, {})
  } })
  h.store.actions.setForm('profile', 'final'); await h.store.actions.startRender(); await h.finished()
  assert.equal(h.studio.store.readRecord(h.projectId).currentRevision, 'r0002')
  assert.equal(h.posts[0].body.revision, h.revision); assert.equal(h.record().revisionId, h.revision)
  assert.equal(h.renderer[0].checkpointPath, h.studio.store.checkpointPath(h.projectId, h.revision))
  assert.deepEqual(h.renderer[0].profile.resolution, source.renderProfiles.final.resolution)
  assert.equal(h.compiles.length, 1, 'rendering the loaded checkpoint must not compile the newer scene')
})

test('request inputs are captured before a subscriber switches project or changes the form', async t => {
  const h = await harness(t)
  const second = await h.studio.transactions.createProject({ title: 'Other project', sceneSpec: source, saveCheckpoint: true })
  h.store.actions.setForm('profile', 'preview')
  let switched = false
  const stop = h.store.subscribe(state => {
    if (state.busy.render && !switched) {
      switched = true; h.store.actions.selectProject(second.projectId); h.store.actions.setForm('profile', 'final')
    }
  })
  await h.store.actions.startRender(); stop(); await h.finished()
  assert.equal(h.posts[0].projectId, h.projectId); assert.equal(h.posts[0].body.revision, h.revision)
  assert.equal(h.renderer[0].profileName, 'preview'); assert.equal(h.record().projectId, h.projectId)
  await settle(() => h.store.getState().activeProjectId === second.projectId)
  assert.equal(h.store.getState().notices.jobs, null, 'another project must not announce this job as its own')
})

test('rendering waits for a project scene to load and refuses duplicate pending submissions', async t => {
  let release, hold = false; const pending = new Promise(resolve => { release = resolve })
  const h = await harness(t, { beforePost: () => hold ? pending : undefined })
  h.store.actions.selectProject(h.projectId)
  await h.store.actions.startRender(); assert.equal(h.posts.length, 0, 'no fallback to the current revision while loading')
  await settle(() => h.store.getState().activeProjectId === h.projectId)
  hold = true
  const first = h.store.actions.startRender()
  // Do not await the second call: the unfixed client would wait on the same held request.
  const second = h.store.actions.startRender(); const submitted = h.posts.length
  release(); await Promise.all([first, second]); await h.finished()
  assert.equal(submitted, 1, 'one click in flight cannot submit a second render')
})

test('resume keeps the job revision, profile and missing frames after the form and scene change', async t => {
  const h = await harness(t)
  h.store.actions.setForm('profile', 'preview'); await h.store.actions.startRender(); await h.finished()
  const original = h.record(), first = h.renderer[0]
  const png = encodePng(createImage(...first.profile.resolution, [30, 90, 200, 255]))
  const completeFrame = join(original.framesDirectory, 'frame_0002.png'); writeFileSync(completeFrame, png)
  await h.advance(); h.store.actions.reload(); await settle(() => h.store.getState().selected.scene.revision === 'r0002')
  h.store.actions.setForm('profile', 'final'); h.store.actions.setForm('frameStart', '9'); h.store.actions.setForm('frameEnd', '12')
  await h.store.actions.startRender(original.jobId); await h.finished()
  assert.deepEqual(h.posts[1].body, { resumeJobId: original.jobId })
  assert.deepEqual(h.hostCalls[1], { method: 'resumeRenderJob', request: { projectId: h.projectId, jobId: original.jobId } })
  assert.equal(h.record().revisionId, h.revision); assert.deepEqual(h.record().renderConfig, original.renderConfig)
  assert.equal(h.renderer[1].profileName, 'preview'); assert.deepEqual(h.renderer[1].profile, first.profile)
  assert.deepEqual(h.renderer[1].frames, [3]); assert.equal(h.renderer[1].checkpointPath, first.checkpointPath)
  assert.deepEqual(readFileSync(completeFrame), png, 'already completed frames remain byte-for-byte intact')
})

test('the resume HTTP route cannot replace a job configuration through extra form fields', async t => {
  const h = await harness(t)
  h.store.actions.setForm('profile', 'preview'); await h.store.actions.startRender(); await h.finished()
  const original = h.record()
  await h.handlers['project.render']({ params: { projectId: h.projectId }, body: { resumeJobId: original.jobId,
    revision: 'r9999', profile: 'final', frameStart: 40, frameEnd: 41, samples: 1 } })
  await h.finished()
  assert.deepEqual(h.hostCalls[1].request, { projectId: h.projectId, jobId: original.jobId })
  assert.equal(h.renderer[1].profile.samples, source.renderProfiles.preview.samples)
  assert.deepEqual(h.renderer[1].frames, [2, 3]); assert.equal(h.record().revisionId, h.revision)
})

test('an omitted HTTP profile retains the Host default, while an unknown explicit choice is refused', async t => {
  const h = await harness(t, { defaultProfile: 'preview' })
  await h.handlers['project.render']({ params: { projectId: h.projectId }, body: { revision: h.revision, frameStart: '2', frameEnd: '3' } })
  await h.finished(); assert.equal(h.renderer[0].profileName, 'preview')
  await assert.rejects(h.handlers['project.render']({ params: { projectId: h.projectId }, body: {
    revision: h.revision, frameStart: 2, frameEnd: 3, profile: 'missing-profile',
  } }), error => error.code === 'RENDER_PROFILE_MISSING')
  assert.equal(h.renderer.length, 1, 'an invalid explicit choice must not silently use the default')
})

test('resuming without an explicit sample override retains the samples actually used by the first attempt', async t => {
  const h = await harness(t)
  const job = await h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 3, samples: 12 })
  await h.finished(); assert.equal(h.record().renderConfig.samples, 12)
  await h.studio.resumeRenderJob({ projectId: h.projectId, jobId: job.jobId }); await h.finished()
  assert.equal(h.renderer[1].profile.samples, 12); assert.equal(h.record().renderConfig.samples, 12)
})

test('an older job without a recorded sample count falls back to its original revision profile', async t => {
  const h = await harness(t)
  const job = await h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 3, profileName: 'preview' })
  await h.finished()
  const original = h.record(), older = clone(original); delete older.renderConfig.samples
  h.studio.renderJobs.write(older, { previous: original })
  await h.advance(); await h.studio.resumeRenderJob({ projectId: h.projectId, jobId: job.jobId }); await h.finished()
  assert.equal(h.renderer[1].profile.samples, source.renderProfiles.preview.samples)
  assert.equal(h.record().revisionId, h.revision)
})

test('a reduced Host budget refuses default resumption before changing the job, frames or renderer', async t => {
  const h = await harness(t, { saveCheckpoint: false })
  const job = await h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 3, samples: 12 })
  await h.finished()
  // An older record may have no checkpointPath. Resolving this spec-only
  // revision would compile again, so refusal must happen before that boundary.
  const original = h.record(); delete original.checkpointPath
  const preserved = h.studio.renderJobs.write(original, { previous: h.record() })
  writeFileSync(join(original.framesDirectory, 'frame_0002.png'), encodePng(createImage(...original.renderConfig.resolution, [30, 90, 200, 255])))
  const before = files(h.studio.config.workspaceRoot), compiles = h.compiles.length
  h.studio.config.maxFinalSamples = 4
  for (const extra of [{}, { samples: null }]) {
    await assert.rejects(h.studio.resumeRenderJob({ projectId: h.projectId, jobId: job.jobId, ...extra }), error => {
      assert.equal(error.code, 'RENDER_BUDGET_EXCEEDED'); assert.match(error.message, /12.*4/)
      assert.match(error.message, /restore.*budget|raise.*budget/i); assert.match(error.message, /new.*job/i)
      assert.equal(error.detail.recordedSamples, 12); assert.equal(error.detail.availableSamples, 4)
      return true
    })
  }
  assert.equal(h.renderer.length, 1); assert.equal(h.compiles.length, compiles)
  assert.deepEqual(files(h.studio.config.workspaceRoot), before)
  assert.deepEqual(h.record(), preserved)
})

test('an explicit public Host sample override remains supported when resuming', async t => {
  const h = await harness(t)
  const job = await h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 3, samples: 12 })
  await h.finished(); h.studio.config.maxFinalSamples = 8
  await h.studio.resumeRenderJob({ projectId: h.projectId, jobId: job.jobId, samples: 7 }); await h.finished()
  assert.equal(h.renderer[1].profile.samples, 7)
  assert.deepEqual(h.renderer[1].frames, [2, 3]); assert.equal(h.record().revisionId, h.revision)
  // Recording per-attempt overrides is a separate known limitation; this case
  // protects the public override rather than promising a uniform historical job.
})
