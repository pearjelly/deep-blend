/** Fixed-view inspection controls preserve scene state and artifact categories. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import BlenderUiHost, { createHandlers } from '@deepblend/dsh-blender-ui'
import { buildSceneTree, compileSceneSpec } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'
const clone = value => JSON.parse(JSON.stringify(value)), core = loadClientBundle().exports.workbench
const source = compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/glass-ceramic/scene-spec.json', import.meta.url)))).spec
const tree = (revision = 'r0001') => buildSceneTree(source, { revision, digest: 'a'.repeat(64) })
const nodesOf = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []
const diagnostic = (mode = 'clay', revision = 'r0001') => ({ kind: 'diagnostic', mime: 'image/png', mode, sourceRevision: revision, sourceDigest: 'a'.repeat(64), transformationVersion: 'inspection-v1', path: `diagnostics/${mode}-${revision}.png`, sha256: 'b'.repeat(64), cameraId: 'hero', frame: 24, width: 512, height: 384, engine: 'CYCLES', samples: 16, at: '2026-10-03T00:00:00Z' })
async function settle(store, predicate) {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => { const timeout = setTimeout(() => { stop(); reject(Error('store did not settle')) }, 2000); const stop = store.subscribe(state => { if (predicate(state)) { clearTimeout(timeout); stop(); resolve() } }) })
}
async function client(t, options = {}) {
  const projects = { one: { revision: 'r0001', scene: tree(), diagnostics: [] }, two: { revision: 'r0001', scene: tree(), diagnostics: [] } }, calls = []
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost'), id = parsed.pathname.match(/projects\/([^/]+)/)?.[1] || parsed.searchParams.get('projectId') || 'one', project = projects[id]
    let payload
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); calls.push({ id, path: parsed.pathname, body, signal: init.signal }); await options.beforePost?.({ id, body, signal: init.signal })
      if (options.fail) payload = { ok: false, error: { code: 'RENDER_NO_OUTPUT', message: 'Inspection failed.' } }
      else if (body.mode) {
        const artifact = { ...diagnostic(body.mode, body.revision), cameraId: body.views[0].cameraId, frame: body.views[0].frame, samples: body.samples }
        project.diagnostics.push(artifact); payload = { ok: true, preview: { mode: body.mode, revision: body.revision, sourceRevision: body.revision, sourceDigest: 'a'.repeat(64), artifacts: [artifact], views: [{ viewId: 'selected', cameraId: artifact.cameraId, frame: artifact.frame }], sheets: null } }
      } else payload = { ok: true, preview: { revision: project.revision, views: [], sheets: null } }
    } else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', artifactBase: `/deepblend/artifacts/${id}/`, previews: { revisions: [{ revision: project.revision, previews: [{ kind: 'preview', path: 'product.png', sha256: 'c'.repeat(64) }], contactSheets: [], diagnostics: clone(project.diagnostics) }] } }
    else payload = { ok: true, route: 'state', projects: [{ projectId: 'one' }, { projectId: 'two' }], selected: { project: { projectId: id, title: id }, currentRevision: project.revision, scene: clone(project.scene), qa: { summary: 'Controlled fixture' }, jobs: [], unfinishedJobs: [] } }
    if (options.alterPayload) payload = options.alterPayload(payload)
    payload.hostApiVersion = 6
    return { ok: payload.ok, status: payload.ok ? 200 : 500, json: async () => clone(payload), text: async () => JSON.stringify(payload) }
  }
  const store = core.createWorkbenchStore({ fetch, pollIdleMs: 100000 }); t.after(() => store.stop()); store.start(); await settle(store, state => state.status === 'ok'); store.actions.setView('preview')
  const nodes = () => nodesOf(core.buildWorkbenchView(store.getState(), store.actions)), view = () => nodesOf(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = name => nodes().find(node => node.props['data-field'] === name), action = name => nodes().find(node => node.props['data-action'] === name)
  return { store, projects, calls, nodes, view, field, action }
}

test('inspection route pins the revision, strips unknown view fields, and passes cancellation without exposing bytes', async () => {
  const calls = [], signal = new AbortController().signal
  const handlers = createHandlers({ blenderStudio: { hostApiVersion: () => 6, renderViews: async input => { calls.push(input); return { revision: 'r0001', mode: 'clay', sourceRevision: 'r0001', sourceDigest: 'a'.repeat(64), artifacts: [diagnostic()], views: [], pngs: { a: Buffer.alloc(20) } } } } })
  const result = await handlers['project.preview']({ params: { projectId: 'one' }, body: { revision: 'r0001', mode: 'clay', views: [{ id: 'selected', cameraId: 'hero', frame: 24, path: '/private', command: 'bad' }], samples: 16 }, signal })
  assert.equal(calls[0].mode, 'clay'); assert.equal(calls[0].revision, 'r0001'); assert.equal(calls[0].signal, signal)
  assert.deepEqual(calls[0].views, [{ id: 'selected', cameraId: 'hero', frame: 24 }]); assert.equal(result.preview.mode, 'clay'); assert.equal(result.preview.sourceRevision, 'r0001'); assert.equal(JSON.stringify(result).includes('pngs'), false)
})

test('legacy multi-view calls remain available without requiring inspection API capabilities', async () => {
  let input; const handlers = createHandlers({ blenderStudio: { renderViews: async request => { input = request; return { artifacts: [], views: [] } } } })
  await handlers['project.preview']({ params: { projectId: 'one' }, body: {} })
  assert.equal(Object.hasOwn(input, 'mode'), false); assert.equal(Object.hasOwn(input, 'views'), false)
})

test('explicit mode refuses old or unknown Host capabilities, missing revisions and invalid modes', async () => {
  for (const version of [undefined, 5]) {
    const handlers = createHandlers({ blenderStudio: { ...(version === undefined ? {} : { hostApiVersion: () => version }), renderViews() { throw Error('must not call') } } })
    await assert.rejects(handlers['project.preview']({ params: { projectId: 'one' }, body: { revision: 'r0001', mode: 'clay' } }), error => error.code === 'UI_HOST_API_STALE')
  }
  const handlers = createHandlers({ blenderStudio: { hostApiVersion: () => 6, renderViews() { throw Error('must not call') } } })
  for (const body of [{ mode: 'clay' }, { revision: 'r0001', mode: 'wireframe' }]) await assert.rejects(handlers['project.preview']({ params: { projectId: 'one' }, body }))
})

test('closing an inspection response aborts actual Host work and releases listeners', async () => {
  const request = Readable.from([Buffer.from(JSON.stringify({ revision: 'r0001', mode: 'clay' }))]); Object.assign(request, { method: 'POST', url: '/deepblend/projects/one/preview', headers: { 'content-type': 'application/json' } })
  const response = Object.assign(new EventEmitter(), { setHeader() {}, end() { this.writableEnded = true } }); let signal
  const context = new Context(); context.provide('blenderStudio', { hostApiVersion: () => 6, renderViews: async input => { signal = input.signal; response.emit('close'); return { artifacts: [], views: [] } } })
  await new BlenderUiHost(context, { serveRoute: false })._handle(request, response)
  assert.equal(signal.aborted, true); assert.equal(response.listenerCount('close'), 0); assert.equal(request.listenerCount('aborted'), 0)
})

test('native camera, frame, mode and sample controls remain drafts until an explicit inspection', async t => {
  const { store, field, calls, action } = await client(t)
  assert.equal(field('inspection-cameraId').props.value, source.project.activeCamera); assert.equal(field('inspection-mode').props.value, 'beauty')
  field('inspection-cameraId').props.onChange({ target: { value: 'detail' } }); field('inspection-frame').props.onChange({ target: { value: '24' } }); field('inspection-mode').props.onChange({ target: { value: 'clay' } }); field('inspection-samples').props.onChange({ target: { value: '8' } })
  assert.equal(calls.length, 0); assert.equal(action('inspection-render').props.disabled, false)
  await store.actions.renderInspection(); assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body, { revision: 'r0001', mode: 'clay', views: [{ id: 'selected', cameraId: 'detail', frame: 24 }], samples: 8 })
})

test('invalid cameras, frames and samples disable and refuse inspection', async t => {
  const { store, calls, action } = await client(t)
  for (const [key, value] of [['cameraId', 'missing'], ['frame', 0], ['frame', 1.5], ['frame', 49], ['samples', 0], ['samples', 513], ['mode', 'wireframe']]) {
    const original = core.inspection.form(store.getState())[key]; store.actions.setInspection(key, value); assert.equal(action('inspection-render').props.disabled, true); await store.actions.renderInspection(); store.actions.setInspection(key, original)
  }
  assert.equal(calls.length, 0)
})

test('each project retains its inspection controls across polls and project switches', async t => {
  const { store, field } = await client(t); store.actions.setInspection('frame', 24); store.actions.setInspection('mode', 'clay'); store.actions.reload(); await settle(store, state => state.inspectionForms.one?.frame === 24)
  store.actions.selectProject('two'); await settle(store, state => state.activeProjectId === 'two'); assert.equal(field('inspection-mode').props.value, 'beauty')
  store.actions.setInspection('frame', 48); store.actions.selectProject('one'); await settle(store, state => state.activeProjectId === 'one')
  assert.equal(field('inspection-frame').props.value, 24); assert.equal(field('inspection-mode').props.value, 'clay'); assert.equal(store.getState().inspectionForms.two.frame, 48)
})

test('a newly saved revision never rewrites a camera or frame input; deleted camera is visibly invalid', async t => {
  const { store, projects, field, action } = await client(t); store.actions.setInspection('cameraId', 'detail'); store.actions.setInspection('frame', 24)
  projects.one.revision = 'r0002'; projects.one.scene = tree('r0002'); projects.one.scene.nodes.cameras = projects.one.scene.nodes.cameras.filter(camera => camera.id !== 'detail')
  store.actions.reload(); await settle(store, state => state.selected.scene.revision === 'r0002')
  assert.equal(field('inspection-cameraId').props.value, 'detail'); assert.equal(field('inspection-frame').props.value, 24); assert.equal(action('inspection-render').props.disabled, true)
})

test('unsaved brief, object and advanced patch drafts block inspection without implicit saving', async t => {
  const { store, calls, action } = await client(t)
  store.actions.updateBrief('goal', 'Uncommitted goal'); assert.equal(action('inspection-render').props.disabled, true); await store.actions.renderInspection()
  store.actions.resetBrief(); store.actions.selectEditorEntity('bottle'); store.actions.updateEditor('transform', ['location', 0], .012); await store.actions.renderInspection()
  store.actions.resetEditor(); store.actions.setForm('patch', '{"operations":[]}'); await store.actions.renderInspection(); assert.equal(calls.length, 0)
})

test('diagnostic beauty and clay artifacts stay separate from the latest product image and editing comparisons', async t => {
  const { store, projects, view } = await client(t); projects.one.diagnostics.push(diagnostic('beauty'), { ...diagnostic('clay'), at: '2026-10-03T00:01:00Z' }); store.actions.reload()
  await settle(store, state => state.previews.revisions[0].diagnostics.length === 2)
  const nodes = view(), cards = nodes.filter(node => node.props['data-inspection-artifact'])
  assert.equal(cards.length, 2); assert.deepEqual(cards.map(node => node.props['data-inspection-mode']), ['clay', 'beauty'])
  const current = nodes.find(node => node.props['data-artifact-slot'] !== undefined && node.props['data-artifact'] === 'product.png')
  assert.ok(current); assert.equal(store.getState().editorComparison, null); assert.equal(store.getState().compareMode, 'result')
  assert.match(JSON.stringify(nodes), /不证明壁厚|does not prove thickness/)
})

test('failed inspections preserve all controls and never publish a success notice', async t => {
  const { store, field } = await client(t, { fail: true }); store.actions.setInspection('frame', 24); store.actions.setInspection('mode', 'clay'); await store.actions.renderInspection()
  assert.equal(field('inspection-frame').props.value, 24); assert.equal(field('inspection-mode').props.value, 'clay'); assert.match(store.getState().inspectionWork.one.error, /RENDER_NO_OUTPUT/); assert.equal(store.getState().inspectionWork.one.result, null)
})

test('cancellation reaches fetch and a late response cannot announce success', async t => {
  let finish, entered; const entering = new Promise(resolve => { entered = resolve }), pending = new Promise(resolve => { finish = resolve })
  const { store, calls } = await client(t, { beforePost: async () => { entered(); await pending } }); const operation = store.actions.renderInspection(); await entering
  store.actions.cancelInspection(); assert.equal(calls[0].signal.aborted, true); finish(); await operation
  assert.equal(store.getState().inspectionWork.one.result, null); assert.match(store.getState().inspectionWork.one.error, /取消|cancelled/)
})

test('late inspection success remains attached to its original project and never switches another view', async t => {
  let finish, entered; const entering = new Promise(resolve => { entered = resolve }), pending = new Promise(resolve => { finish = resolve })
  const { store } = await client(t, { beforePost: async () => { entered(); await pending } }); const operation = store.actions.renderInspection(); await entering
  store.actions.selectProject('two'); await settle(store, state => state.activeProjectId === 'two'); store.actions.setView('scene'); store.actions.setInspection('frame', 48)
  finish(); await operation; assert.equal(store.getState().activeProjectId, 'two'); assert.equal(store.getState().view, 'scene'); assert.equal(store.getState().inspectionWork.two, undefined); assert.equal(store.getState().inspectionForms.two.frame, 48); assert.equal(store.getState().inspectionWork.one.result.revision, 'r0001')
})

test('disposing the workbench aborts inspection transport', async t => {
  let finish, entered; const entering = new Promise(resolve => { entered = resolve }), pending = new Promise(resolve => { finish = resolve })
  const { store, calls } = await client(t, { beforePost: async () => { entered(); await pending } }); const operation = store.actions.renderInspection(); await entering
  store.stop(); assert.equal(calls[0].signal.aborted, true); finish(); await operation
})

test('creation guide jumps to existing controls without writes, automatic rendering or completion flags', async t => {
  const { store, calls, action, nodes } = await client(t)
  for (const [step, expected] of [['goal', 'projects'], ['route', 'projects'], ['parts', 'scene'], ['form', 'preview'], ['detail', 'preview'], ['appearance', 'scene'], ['delivery', 'jobs']]) { action(`guide-${step}`).props.onClick(); assert.equal(store.getState().view, expected) }
  assert.equal(calls.length, 0); assert.equal(store.getState().inspectionForms.one.mode, 'beauty'); assert.equal(Object.hasOwn(store.getState(), 'completedSteps'), false)
  assert.match(JSON.stringify(nodes()), /不会自动提交|do not submit/)
})


test('mismatched receipts cannot be shown as a successful inspection', async t => {
  for (const mutation of [payload => { payload.preview.mode = 'beauty' }, payload => { payload.preview.sourceRevision = 'r9999' }, payload => { payload.preview.artifacts[0].cameraId = 'wrong-camera' }, payload => { payload.preview.artifacts[0].frame = 999 }]) {
    const { store } = await client(t, { alterPayload: payload => { if (payload.preview) mutation(payload); return payload } })
    store.actions.setInspection('mode', 'clay'); await store.actions.renderInspection()
    assert.equal(store.getState().inspectionWork.one.result, null); assert.match(store.getState().inspectionWork.one.error, /回执|receipt/)
  }
})
