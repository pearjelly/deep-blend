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
import { inspectProjectStorage, LOW_PROJECT_STORAGE_BYTES } from '../../../packages/deepblend/host/lib/storage-readiness.js'

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
  const project = await studio.transactions.createProject({ title: 'Render controls', sceneSpec: options.scene ?? source, saveCheckpoint: options.saveCheckpoint ?? true })
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

test('project storage observation reports low, measured and unknown without claiming a reservation', () => {
  const probe = bytes => inspectProjectStorage('/project-volume', { statfs: (path, options) => {
    assert.equal(path, '/project-volume'); assert.equal(options.bigint, true)
    return { bavail: BigInt(bytes), bsize: 1n }
  } })
  assert.equal(probe(LOW_PROJECT_STORAGE_BYTES - 1).status, 'low')
  assert.equal(probe(LOW_PROJECT_STORAGE_BYTES).status, 'observed')
  assert.equal(probe(0).availableBytes, 0)
  assert.deepEqual(Object.keys(probe(123)).sort(), ['availableBytes', 'observedAt', 'status'])
  for (const statfs of [() => { throw Error('no access') }, () => ({ bavail: -1n, bsize: 4096n }), () => ({ bavail: 1n, bsize: 0n }), () => ({ bavail: 1n << 62n, bsize: 4096n })]) {
    const result = inspectProjectStorage('/project-volume', { statfs })
    assert.equal(result.status, 'unverified'); assert.equal(result.availableBytes, null)
  }
})

test('the workbench shows a storage warning and never treats a measurement as a guarantee', async t => {
  const h = await harness(t)
  const inspect = () => {
    const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []
    return walk(core.renderView({ state: h.store.getState(), actions: h.store.actions })).find(node => node.props['data-project-storage'])
  }
  for (const sample of [{ status: 'low', availableBytes: 125 * 1024 ** 2 }, { status: 'observed', availableBytes: 20 * 1024 ** 3 }, { status: 'unverified', availableBytes: null }]) {
    h.studio.getProjectStorage = () => sample; h.store.actions.reload()
    await settle(() => h.store.getState().projectStorage?.status === sample.status)
    h.store.actions.setView('jobs')
    const notice = inspect(), text = JSON.stringify(notice)
    assert.equal(notice.props['data-project-storage'], sample.status === 'unverified' ? 'unknown' : sample.status)
    assert.match(text, /预留|reserved space/i)
    if (sample.status === 'low') assert.match(text, /2 GiB/)
  }
  h.studio.getProjectStorage = undefined; h.store.actions.reload()
  await settle(() => h.store.getState().projectStorage === null)
  assert.equal(inspect().props['data-project-storage'], 'unknown')
})

test('the 16:9 preparation saves both profile dimensions and preserves source, quality and cameras', async t => {
  const fixture = clone(source)
  fixture.project.aspectRatio = '4:3'
  fixture.renderProfiles.preview.resolution = [768, 576]
  fixture.renderProfiles.final.resolution = [1024, 768]
  const h = await harness(t, { scene: fixture }), before = clone(h.studio.store.readRevisionSpec(h.projectId, h.revision))
  const actual = h.studio.applyScenePatch.bind(h.studio), calls = []
  h.studio.applyScenePatch = async patch => { calls.push(clone(patch)); return actual({ ...patch, renderPreview: false }) }
  const warning = () => {
    const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []
    return walk(core.renderView({ state: h.store.getState(), actions: h.store.actions })).find(node => node.props['data-render-aspect-warning'])
  }
  h.store.actions.setView('jobs')
  for (const preset of ['still-2560x1440', 'video-1920x1080']) {
    h.store.actions.setForm('stillPreset', preset)
    assert.equal(warning()?.props['data-render-aspect-warning'], 'mismatch')
  }
  const unknownState = clone(h.store.getState()); unknownState.selected.scene.renderProfiles = null
  const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []
  assert.equal(walk(core.renderView({ state: unknownState, actions: h.store.actions })).find(node => node.props['data-render-aspect-warning'])?.props['data-render-aspect-warning'], 'unknown')
  await h.store.actions.saveWideFrame()
  await settle(() => h.store.getState().selected?.scene?.revision !== h.revision)
  const saved = h.studio.store.readRevisionSpec(h.projectId, h.store.getState().currentRevision)
  assert.equal(calls.length, 1); assert.equal(calls[0].renderPreview, true)
  assert.deepEqual(calls[0].operations.map(op => op.op), ['render.profile.set', 'render.profile.set', 'project.aspectRatio.set'])
  assert.deepEqual(saved.renderProfiles.preview.resolution, [768, 432]); assert.deepEqual(saved.renderProfiles.final.resolution, [1024, 576])
  assert.equal(saved.project.aspectRatio, '16:9'); assert.deepEqual(saved.cameras, before.cameras); assert.deepEqual(saved.entities, before.entities)
  assert.equal(saved.renderProfiles.preview.samples, before.renderProfiles.preview.samples); assert.equal(saved.renderProfiles.final.samples, before.renderProfiles.final.samples)
  for (const name of ['preview', 'final']) {
    const original = clone(before.renderProfiles[name]), changed = clone(saved.renderProfiles[name])
    delete original.resolution; delete changed.resolution
    assert.deepEqual(changed, original, `${name} engine, samples, color and budget remain unchanged`)
  }
  for (const key of ['lights', 'materials', 'world', 'animationTracks', 'shots']) assert.deepEqual(saved[key], before[key], `${key} remains unchanged`)
  assert.deepEqual(h.studio.store.readRevisionSpec(h.projectId, h.revision), before)
  assert.equal(Object.values(h.store.getState().motionDrafts).find(draft => draft.projectId === h.projectId)?.baseRevision, h.store.getState().currentRevision)
  assert.equal(warning(), undefined, 'a matching saved 16:9 project no longer needs the mismatch warning')
})

test('16:9 preparation refuses a changed project store and is unavailable on an old Host', async t => {
  const fixture = clone(source); fixture.project.aspectRatio = '4:3'; fixture.renderProfiles.preview.resolution = [768, 576]; fixture.renderProfiles.final.resolution = [1024, 768]
  const h = await harness(t, { scene: fixture }), before = h.studio.store.readRecord(h.projectId).currentRevision
  await assert.rejects(h.handlers['project.patch']({ params: { projectId: h.projectId }, body: { expectedStoreIdentity: 'f'.repeat(64), patch: { baseRevision: before, operations: [{ op: 'project.aspectRatio.set', aspectRatio: '16:9' }] } } }), { code: 'REVISION_CONFLICT' })
  assert.equal(h.studio.store.readRecord(h.projectId).currentRevision, before)
  h.store.actions.setMotionValue('seconds', '4')
  await h.store.actions.saveWideFrame(); assert.equal(h.studio.store.readRecord(h.projectId).currentRevision, before)
  assert.equal(Object.values(h.store.getState().motionDrafts).find(draft => draft.projectId === h.projectId)?.seconds, '4')
  h.studio.deliveryAspectPresetSupported = false; h.store.actions.reload()
  await settle(() => !h.store.getState().deliveryAspectPresetSupported)
  await h.store.actions.saveWideFrame(); assert.equal(h.studio.store.readRecord(h.projectId).currentRevision, before)
})

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

test('the still preset is job-scoped, pins one revision and survives a failed render and resume', async t => {
  const h = await harness(t)
  const originalSpec = clone(h.studio.store.readRevisionSpec(h.projectId, h.revision))
  h.store.actions.setForm('profile', 'final'); h.store.actions.setForm('frameEnd', '2')
  h.store.actions.setForm('stillPreset', 'still-2560x1440')
  await h.store.actions.startRender(); await h.finished()
  const original = h.record()
  assert.equal(h.posts[0].body.stillPreset, 'still-2560x1440')
  assert.equal(original.stillPreset, 'still-2560x1440'); assert.equal(original.revisionId, h.revision)
  assert.deepEqual(original.renderConfig.resolution, [2560, 1440]); assert.deepEqual(h.renderer[0].profile.resolution, [2560, 1440])
  assert.equal(h.renderer[0].profile.samples, originalSpec.renderProfiles.final.samples)
  assert.deepEqual(h.studio.store.readRevisionSpec(h.projectId, h.revision), originalSpec)
  await h.advance(); h.store.actions.reload(); await settle(() => h.store.getState().selected.scene.revision === 'r0002')
  h.store.actions.setForm('stillPreset', ''); h.store.actions.setForm('profile', 'preview')
  await h.store.actions.startRender(original.jobId); await h.finished()
  assert.deepEqual(h.posts[1].body, { resumeJobId: original.jobId })
  assert.equal(h.record().revisionId, h.revision); assert.deepEqual(h.renderer[1].profile.resolution, [2560, 1440])
  assert.deepEqual(h.renderer[1].frames, [2]); assert.equal(h.renderer[1].checkpointPath, h.renderer[0].checkpointPath)
})

test('unknown and multi-frame still presets fail before allocating jobs or rendering', async t => {
  const h = await harness(t)
  for (const request of [
    { frameStart: 2, frameEnd: 3, stillPreset: 'still-2560x1440' },
    { frameStart: 2, frameEnd: 2, stillPreset: 'unknown' },
  ]) await assert.rejects(h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, ...request }), error => error.code === 'RENDER_RANGE_INVALID')
  assert.equal(h.renderer.length, 0); assert.equal(h.studio.renderJobs.list(h.projectId).length, 0)
  h.store.actions.setForm('stillPreset', 'still-2560x1440'); await h.store.actions.startRender()
  assert.equal(h.posts.length, 0, 'the client reports the invalid frame range without a request')
  const oldHandlers = createHandlers({ blenderStudio: { startFinalRender: () => assert.fail('an older Host must not silently ignore a preset') } })
  await assert.rejects(oldHandlers['project.render']({ params: { projectId: h.projectId }, body: { stillPreset: 'still-2560x1440' } }), error => error.code === 'UI_HOST_API_STALE')
})

test('a preset that disagrees with the recorded dimensions cannot be resumed', async t => {
  const h = await harness(t)
  const job = await h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 2, stillPreset: 'still-2560x1440' })
  await h.finished(); const old = h.record(), changed = clone(old); changed.renderConfig.resolution = [1920, 1080]
  h.studio.renderJobs.write(changed, { previous: old })
  await assert.rejects(h.studio.resumeRenderJob({ projectId: h.projectId, jobId: job.jobId }), error => error.code === 'RENDER_JOB_STATE_INVALID')
  assert.equal(h.renderer.length, 1)
})

test('the 1080p video preset preserves the scene frame rate and resumes the original job settings', async t => {
  const h = await harness(t), originalSpec = clone(h.studio.store.readRevisionSpec(h.projectId, h.revision))
  h.store.actions.setForm('profile', 'final'); h.store.actions.setForm('stillPreset', 'video-1920x1080')
  await h.store.actions.startRender(); await h.finished()
  const original = h.record()
  assert.equal(h.posts[0].body.videoPreset, 'video-1920x1080'); assert.equal(h.posts[0].body.stillPreset, undefined)
  assert.deepEqual(original.renderConfig.resolution, [1920, 1080]); assert.equal(original.fps, originalSpec.project.fps)
  assert.deepEqual(h.renderer[0].profile.resolution, [1920, 1080]); assert.equal(h.renderer[0].profile.samples, originalSpec.renderProfiles.final.samples)
  assert.deepEqual(h.studio.store.readRevisionSpec(h.projectId, h.revision), originalSpec)
  await h.advance(); h.store.actions.setForm('stillPreset', ''); h.store.actions.setForm('profile', 'preview')
  await h.store.actions.startRender(original.jobId); await h.finished()
  assert.deepEqual(h.posts[1].body, { resumeJobId: original.jobId }); assert.equal(h.record().revisionId, h.revision)
  assert.deepEqual(h.renderer[1].profile.resolution, [1920, 1080]); assert.equal(h.renderer[1].checkpointPath, h.renderer[0].checkpointPath)
})

test('incompatible, unknown, stale and tampered video presets never silently render or resume', async t => {
  const h = await harness(t)
  for (const extra of [{ videoPreset: 'unknown' }, { videoPreset: 'video-1920x1080', deliveryKind: 'still', frameEnd: 2 },
    { videoPreset: 'video-1920x1080', stillPreset: 'still-2560x1440', frameEnd: 2 }])
    await assert.rejects(h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 3, ...extra }), error => error.code === 'RENDER_RANGE_INVALID')
  assert.equal(h.renderer.length, 0)
  const oldHandlers = createHandlers({ blenderStudio: { startFinalRender: () => assert.fail('old Host cannot ignore a video preset') } })
  await assert.rejects(oldHandlers['project.render']({ params: { projectId: h.projectId }, body: { videoPreset: 'video-1920x1080' } }), error => error.code === 'UI_HOST_API_STALE')
  h.store.actions.setForm('stillPreset', 'video-1920x1080'); h.store.actions.setForm('deliveryKind', 'still')
  await h.store.actions.startRender(); assert.equal(h.posts.length, 0)
  const job = await h.studio.startFinalRender({ projectId: h.projectId, revision: h.revision, frameStart: 2, frameEnd: 3, videoPreset: 'video-1920x1080' })
  await h.finished(); const old = h.record(), changed = clone(old); changed.renderConfig.resolution = [960, 720]
  h.studio.renderJobs.write(changed, { previous: old })
  await assert.rejects(h.studio.resumeRenderJob({ projectId: h.projectId, jobId: job.jobId }), error => error.code === 'RENDER_JOB_STATE_INVALID')
  assert.equal(h.renderer.length, 1)
})

test('image delivery is explicit, single frame and remains bound on resume', async t => {
  const h = await harness(t)
  h.store.actions.setForm('deliveryKind', 'still'); await h.store.actions.startRender()
  assert.equal(h.posts.length, 0, 'multi-frame image selection is refused in the workbench')
  h.store.actions.setForm('frameEnd', '2'); await h.store.actions.startRender(); await h.finished()
  const original = h.record(); assert.equal(h.posts[0].body.deliveryKind, 'still'); assert.equal(original.deliveryKind, 'still')
  h.store.actions.setForm('deliveryKind', ''); await h.store.actions.startRender(original.jobId); await h.finished()
  assert.deepEqual(h.posts[1].body, { resumeJobId: original.jobId }); assert.equal(h.record().deliveryKind, 'still')
  await assert.rejects(h.studio.exportProject({ projectId: h.projectId, jobId: original.jobId }), error => error.code === 'RENDER_JOB_STATE_INVALID')
  await assert.rejects(h.studio.exportProject({ projectId: h.projectId }), error => error.code === 'RENDER_JOB_NOT_FOUND', 'automatic video export must not choose an image job')
  const oldHandlers = createHandlers({ blenderStudio: { startFinalRender: () => assert.fail('old Host must not encode a silently downgraded image request') } })
  await assert.rejects(oldHandlers['project.render']({ params: { projectId: h.projectId }, body: { deliveryKind: 'still' } }), error => error.code === 'UI_HOST_API_STALE')
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
  const secondProject = await h.studio.transactions.createProject({ title: 'Loading project', sceneSpec: source, saveCheckpoint: true })
  h.store.actions.selectProject(secondProject.projectId)
  await h.store.actions.startRender(); assert.equal(h.posts.length, 0, 'no fallback to the previous project revision while loading')
  await settle(() => h.store.getState().activeProjectId === secondProject.projectId)
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
