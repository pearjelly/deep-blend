/** Recovery and source identity contracts; native/browser acceptance is separate. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecipeCatalog } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { buildSceneTree, planLampAssemblyPlacement, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { createHandlers } from '@deepblend/dsh-blender-ui'
import { loadClientBundle } from '../lib/client-bundle.mjs'
const clone = value => JSON.parse(JSON.stringify(value)), core = loadClientBundle().exports.workbench
const catalog = new RecipeCatalog(), recipe = catalog.list().recipes.find(item => item.id === 'deepblend.metal-lamp')
const { sceneSpec, lock } = catalog.instantiate({ id: recipe.id, version: recipe.version, digest: recipe.digest })
const plan = planLampAssemblyPlacement(lock, sceneSpec, undefined)
const nodesOf = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []
const storage = () => { const records = new Map(); return { records, getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) } }
async function settle(store, predicate) {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(Error('Camera fit fixture did not settle')) }, 3000)
    const stop = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); stop(); resolve() } })
  })
}
async function client(t, options = {}) {
  const projects = options.projects || { one: { revision: 'r0001' }, two: { revision: 'r0001' } }, calls = [], ledger = options.ledger || new Map()
  let commits = 0, projectsRoot = '/camera-fit-fixture'
  const saved = options.storage || storage()
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost'), id = parsed.pathname.match(/projects\/([^/]+)/)?.[1] || parsed.searchParams.get('projectId') || 'one'
    const project = projects[id]; let payload
    if (init.method === 'POST') {
      const body = JSON.parse(init.body), call = { id, path: parsed.pathname, body, signal: init.signal }; calls.push(call)
      await options.beforePost?.(call)
      if (options.postError) payload = { ok: false, error: { code: options.postError, message: 'Explicit fixture refusal' } }
      else {
        let result = ledger.get(body.idempotencyKey)
        if (!result) {
          commits++; project.revision = 'r0002'
          result = { revision: project.revision, cameraFitReceipt: {
            schemaVersion: 'deepblend.camera-fit-receipt/v1', sourceRevision: body.baseRevision, cameraId: body.cameraId,
            fittedCameraId: body.fittedCameraId, camera: { id: body.fittedCameraId }, entityIds: body.entityIds,
            frame: body.frame, margin: body.margin, sourceCheckpointSha256: 'a'.repeat(64), resultCheckpointSha256: 'b'.repeat(64),
            baselineVerification: { checkpointSha256: 'a'.repeat(64), checkpointUnchanged: true, selectedGeometryUnchanged: true, originalObjectsUnchanged: true, opticsAndRotationPreserved: true },
            members: body.entityIds.map(entityId => ({ entityId, projection: { containedInFrame: true, containedInClip: true } })) } }
          ledger.set(body.idempotencyKey, clone(result))
        }
        if (options.dropFirstReply && calls.length === 1) throw Error('Response lost after fixture commit')
        payload = { ok: true, revision: clone(result) }; options.alterReply?.(payload)
      }
    } else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', artifactBase: `/deepblend/artifacts/${id}/`, previews: { projectId: id, revisions: [] } }
    else {
      const spec = clone(sceneSpec)
      for (const result of ledger.values()) if (!spec.cameras.some(camera => camera.id === result.cameraFitReceipt.fittedCameraId)) {
        spec.cameras.push({ ...clone(spec.cameras[0]), id: result.cameraFitReceipt.fittedCameraId })
      }
      const scene = buildSceneTree(spec, { revision: project.revision, digest: 'a'.repeat(64) })
      payload = { ok: true, route: 'state', projectsRoot, cameraFitSupported: options.supported !== false, projects: [{ projectId: 'one' }, { projectId: 'two' }], selected: {
        project: { projectId: id, title: id }, currentRevision: project.revision, scene, jobs: [], unfinishedJobs: [], qa: {},
        recipeParameters: { projectId: id, revision: project.revision, available: true, conflicts: [], parameters: [],
          placement: options.noCompleteScope ? { available: false } : { available: true, subjectEntityId: plan.subjectEntityId, memberEntityIds: plan.memberEntityIds, defaultPose: plan.pose } } } }
    }
    payload.hostApiVersion = HOST_API_VERSION
    return { ok: payload.ok, status: payload.ok ? 200 : 409, json: async () => clone(payload), text: async () => JSON.stringify(payload) }
  }
  const store = core.createWorkbenchStore({ fetch, cameraFitStorage: saved, pollIdleMs: 100000 }); t.after(() => store.stop()); store.start()
  await settle(store, state => state.status === 'ok'); store.actions.setView('scene')
  const nodes = () => nodesOf(core.buildWorkbenchView(store.getState(), store.actions))
  const field = id => nodes().find(node => node.props['data-field'] === `fit-${id}`)
  const action = id => nodes().find(node => node.props['data-action'] === `fit-${id}`)
  const draft = () => store.getState().cameraFitDrafts[JSON.stringify([store.getState().projectsRoot, store.getState().activeProjectId])]
  return { store, projects, calls, field, action, nodes, draft, storage: saved, ledger, commits: () => commits, setRoot: value => { projectsRoot = value } }
}

test('one explicit save uses the full lamp selection, original camera, explicit frame and new camera identity', async t => {
  const f = await client(t)
  assert.equal(f.draft().entityIds.length, 23); assert.equal(f.action('save').props.disabled, false)
  assert.equal(f.calls.length, 0); f.store.actions.setCameraFitValue('marginPercent', '26')
  assert.equal(f.action('save').props.disabled, true); await f.store.actions.saveCameraFit(); assert.equal(f.calls.length, 0)
  f.store.actions.setCameraFitValue('marginPercent', '3'); f.store.actions.setCameraFitValue('frame', '24')
  await f.store.actions.saveCameraFit(); await settle(f.store, state => state.currentRevision === 'r0002' && !f.draft()?.attempt)
  assert.equal(f.calls.length, 1); const body = f.calls[0].body
  assert.equal(body.margin, .03); assert.equal(body.frame, 24); assert.equal(body.projectsRoot, '/camera-fit-fixture'); assert.equal(body.baseRevision, 'r0001')
  assert.deepEqual(body.entityIds, [...plan.memberEntityIds].sort()); assert.notEqual(body.cameraId, body.fittedCameraId)
  assert.equal(f.storage.records.size, 0); assert.equal(f.store.getState().view, 'preview')
  assert.equal(f.store.getState().photographyDrafts.one.cameraId, body.fittedCameraId)
  assert.ok(f.nodes().find(node => node.props['data-result-kind'] === 'camera-fit'))
})

test('a lost response freezes intent and retries exactly once without a second fixture commit', async t => {
  const f = await client(t, { dropFirstReply: true }); await f.store.actions.saveCameraFit()
  await settle(f.store, state => state.currentRevision === 'r0002')
  const captured = clone(f.draft().attempt); assert.ok(captured); assert.equal(f.field('cameraId').props.disabled, true)
  f.store.actions.setCameraFitValue('marginPercent', '10'); assert.equal(Number(f.draft().marginPercent), 3)
  f.store.actions.resetCameraFit(); assert.deepEqual(clone(f.draft().attempt), captured)
  await f.store.actions.saveCameraFit(); await settle(f.store, () => !f.draft()?.attempt)
  assert.deepEqual(f.calls[0].body, f.calls[1].body); assert.equal(f.commits(), 1)
})

test('page refresh restores an uncertain captured request without submitting and can replay after the revision advanced', async t => {
  const first = await client(t, { dropFirstReply: true }); await first.store.actions.saveCameraFit()
  const captured = clone(first.draft().attempt); first.store.stop()
  const refreshed = await client(t, { storage: first.storage, projects: first.projects, ledger: first.ledger })
  assert.equal(refreshed.calls.length, 0); assert.deepEqual(clone(refreshed.draft().attempt), captured)
  assert.equal(refreshed.action('save').props.disabled, false); await refreshed.store.actions.saveCameraFit()
  assert.deepEqual(refreshed.calls[0].body, captured); assert.equal(refreshed.commits(), 0)
  await settle(refreshed.store, () => !refreshed.draft()?.attempt); assert.equal(first.storage.records.size, 0)
})

test('known refusal permits edits; a mismatched committed receipt retains exact recovery intent', async t => {
  const rejected = await client(t, { postError: 'SCENE_VALIDATION_FAILED' }); await rejected.store.actions.saveCameraFit()
  assert.equal(rejected.draft().attempt, null); assert.equal(rejected.storage.records.size, 0); assert.equal(rejected.field('frame').props.disabled, false)
  for (const alterReply of [payload => { payload.revision.cameraFitReceipt.frame++ }, payload => { payload.revision.cameraFitReceipt.members[0].projection.containedInClip = false }, payload => { payload.revision.cameraFitReceipt.baselineVerification.originalObjectsUnchanged = false }]) {
    const wrong = await client(t, { alterReply }); await wrong.store.actions.saveCameraFit()
    assert.ok(wrong.draft().attempt); assert.equal(wrong.storage.records.size, 1); assert.equal(wrong.store.getState().view, 'scene')
  }
})

test('a changed revision retains edited intent until explicit reread; other unsaved edits block sending', async t => {
  const f = await client(t); f.store.actions.setCameraFitValue('frame', '12'); f.projects.one.revision = 'r0003'; f.store.actions.reload()
  await settle(f.store, state => state.currentRevision === 'r0003')
  assert.equal(f.draft().baseRevision, 'r0001'); assert.equal(f.action('save').props.disabled, true)
  await f.store.actions.saveCameraFit(); assert.equal(f.calls.length, 0)
  f.store.actions.resetCameraFit(); assert.equal(f.draft().baseRevision, 'r0003'); assert.equal(f.action('save').props.disabled, false)
  f.store.actions.updatePhotography('camera', ['lens'], 70)
  assert.equal(f.action('save').props.disabled, true); await f.store.actions.saveCameraFit(); assert.equal(f.calls.length, 0)
})

test('cancel aborts the captured request and retains refresh recovery', async t => {
  const f = await client(t, { beforePost: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('Cancelled fixture')), { once: true })) })
  const save = f.store.actions.saveCameraFit(); await settle(f.store, state => state.busy.editor)
  f.store.actions.cancelCameraFit(); await save
  assert.equal(f.calls[0].signal.aborted, true); assert.ok(f.draft().attempt); assert.equal(f.storage.records.size, 1); assert.equal(f.store.getState().busy.editor, false)
})

test('an uncertain retry waits while an unrelated save is running', async t => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const options = { dropFirstReply: true, beforePost: call => call.path.endsWith('/patch') ? gate : undefined }
  const f = await client(t, options); await f.store.actions.saveCameraFit()
  await settle(f.store, state => state.currentRevision === 'r0002'); assert.ok(f.draft().attempt)
  options.postError = 'SCENE_PATCH_REJECTED'
  f.store.actions.updatePhotography('camera', ['lens'], 70)
  const otherSave = f.store.actions.savePhotography(); await settle(f.store, state => state.busy.editor)
  assert.equal(f.action('save').props.disabled, true); await f.store.actions.saveCameraFit()
  assert.equal(f.calls.filter(call => call.path.endsWith('/camera-fit')).length, 1)
  assert.equal(f.store.getState().busy.editor, true)
  release(); await otherSave; assert.ok(f.draft().attempt)
})

test('late replies remain scoped to the captured project and project store', async t => {
  for (const switchStore of [false, true]) {
    let release; const gate = new Promise(resolve => { release = resolve })
    const f = await client(t, { beforePost: () => gate }); const save = f.store.actions.saveCameraFit()
    await settle(f.store, state => state.busy.editor)
    if (switchStore) { f.setRoot('/other-store'); f.store.actions.reload(); await settle(f.store, state => state.projectsRoot === '/other-store') }
    else { f.store.actions.selectProject('two'); await settle(f.store, state => state.activeProjectId === 'two') }
    release(); await save
    assert.equal(f.store.getState().view, 'scene'); assert.notEqual(f.store.getState().notices.preview?.kind, 'camera-fit')
  }
})

test('unsupported Hosts, empty selection, invalid persisted state and failed storage never submit', async t => {
  const old = await client(t, { supported: false }); assert.equal(old.action('save'), undefined); await old.store.actions.saveCameraFit(); assert.equal(old.calls.length, 0)
  const empty = await client(t, { noCompleteScope: true }); empty.store.actions.setCameraFitValue('entityIds', [])
  assert.equal(empty.action('save').props.disabled, true); await empty.store.actions.saveCameraFit(); assert.equal(empty.calls.length, 0)
  const broken = storage(); broken.setItem('deepblend.workbench.camera-fit.v1:["/camera-fit-fixture","one"]', '{bad')
  const bad = await client(t, { storage: broken }); assert.equal(bad.draft().storageError, true); await bad.store.actions.saveCameraFit(); assert.equal(bad.calls.length, 0)
  bad.store.actions.resetCameraFit(); assert.equal(bad.draft().storageError, false)
  const unavailable = await client(t, { storage: { getItem: () => null, setItem: () => { throw Error('No storage') }, removeItem() {} } })
  await unavailable.store.actions.saveCameraFit(); assert.equal(unavailable.calls.length, 0); assert.equal(unavailable.draft().storageError, true)
})

test('the public UI route delegates captured source/store/signal to Host and always requests a saved preview', async () => {
  let input; const signal = new AbortController().signal
  const handlers = createHandlers({ blenderStudio: { cameraFitSupported: true, fitCamera: request => { input = request; return { revision: 'r0002' } } } })
  const body = { projectId: 'wrong', projectsRoot: '/store', baseRevision: 'r0001', entityIds: ['lamp'], cameraId: 'hero', fittedCameraId: 'complete', frame: 24, margin: .03, idempotencyKey: 'key', renderPreview: false, unknown: 'host validates' }
  assert.deepEqual(await handlers['project.cameraFit']({ params: { projectId: 'one' }, body, signal }), { revision: { revision: 'r0002' } })
  assert.deepEqual(input, { ...body, projectId: 'one', renderPreview: true, signal })
  await assert.rejects(createHandlers({ blenderStudio: {} })['project.cameraFit']({ params: { projectId: 'one' }, body, signal }), /Update the Host/)
})
