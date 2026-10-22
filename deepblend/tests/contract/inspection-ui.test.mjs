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
const nativeReceipt = (projectId, entityId, sourceRevision = 'r0001', frame = 1) => ({
  schemaVersion: 'deepblend.scene-geometry/v1', projectId, sourceRevision, sourceDigest: 'a'.repeat(64),
  sourceSpecHash: 'b'.repeat(64), sourceCheckpointSha256: 'd'.repeat(64), sourceUnchanged: true,
  frame, blenderVersion: 'fixture', limitations: ['World-axis spans only.'], objects: [{ entityId, type: 'MESH', available: true,
    worldBoundsMeters: { min: [0,0,0], max: [.1,.2,.3] }, worldAxisExtentMm: [100,200,300], scale: [1,1,1],
    worldMatrix: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]], vertexCount: 8, polygonCount: 6 }],
})
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
    if (init.method !== 'POST') await options.beforeGet?.({ id, path: parsed.pathname })
    let payload
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); calls.push({ id, path: parsed.pathname, body, signal: init.signal }); await options.beforePost?.({ id, body, signal: init.signal })
      if (options.fail) payload = { ok: false, error: { code: 'RENDER_NO_OUTPUT', message: 'Inspection failed.' } }
      else if (body.mode) {
        const artifact = { ...diagnostic(body.mode, body.revision), cameraId: body.views[0].cameraId, frame: body.views[0].frame, samples: body.samples }
        project.diagnostics.push(artifact); payload = { ok: true, preview: { mode: body.mode, revision: body.revision, sourceRevision: body.revision, sourceDigest: 'a'.repeat(64), artifacts: [artifact], views: [{ viewId: 'selected', cameraId: artifact.cameraId, frame: artifact.frame }], sheets: null } }
      } else payload = { ok: true, preview: { revision: project.revision, views: [], sheets: null } }
    } else if (parsed.pathname.endsWith('/scene') && parsed.searchParams.has('geometryEntityId')) {
      const entityId = parsed.searchParams.get('geometryEntityId'), revision = parsed.searchParams.get('revision'), frame = Number(parsed.searchParams.get('geometryFrame'))
      calls.push({ id, path: parsed.pathname, entityId, revision, frame, signal: init.signal })
      await options.beforeNative?.({ id, revision, frame, signal: init.signal })
      const receipt = nativeReceipt(id, entityId, revision, frame); options.alterNative?.(receipt)
      payload = { ok: true, route: 'project.scene', projectId: id, revision, digest: 'a'.repeat(64), geometryInspection: receipt }
    } else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', artifactBase: `/deepblend/artifacts/${id}/`, previews: { projectId: id, revisions: [{ revision: project.revision, previews: [{ kind: 'preview', path: 'product.png', sha256: 'c'.repeat(64) }], contactSheets: [], diagnostics: clone(project.diagnostics) }] } }
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

test('native measurement route binds a single selected part, saved revision, frame and cancellation', async () => {
  let input; const signal = new AbortController().signal, entityId = source.entities[0].id
  const handlers = createHandlers({ blenderStudio: { getScene: async (id, options) => { input = { id, options }; return {
    revision: options.revision, digest: 'a'.repeat(64), spec: source, geometryInspection: nativeReceipt(id, entityId, options.revision, options.geometry.frame),
  } } } })
  const result = await handlers['project.scene']({ params: { projectId: 'one' }, query: { revision: 'r0001', geometryEntityId: entityId, geometryFrame: '17' }, signal })
  assert.deepEqual(input.options.geometry, { entityIds: [entityId], frame: 17 }); assert.equal(input.options.signal, signal)
  assert.equal(result.geometryInspection.sourceRevision, 'r0001'); assert.deepEqual(result.geometryInspection.objects[0].worldAxisExtentMm, [100,200,300])
})

test('native measurement route refuses partial input and old Hosts without invented values', async () => {
  let calls = 0; const handlers = createHandlers({ blenderStudio: { getScene: async () => { calls++; return { revision: 'r0001', digest: 'a'.repeat(64), spec: source } } } })
  for (const query of [{ geometryEntityId: 'cup' }, { revision: 'r0001', geometryEntityId: 'cup' }, { revision: 'r0001', geometryFrame: '1' },
    { revision: 'r0001', geometryEntityId: 'cup', geometryFrame: '1.5' }]) {
    await assert.rejects(handlers['project.scene']({ params: { projectId: 'one' }, query }))
  }
  assert.equal(calls, 0)
  await assert.rejects(handlers['project.scene']({ params: { projectId: 'one' }, query: { revision: 'r0001', geometryEntityId: 'cup', geometryFrame: '1' } }), { code: 'UI_HOST_API_STALE' })
})

test('native measurement route rejects wrong source and inconsistent measured bounds', async () => {
  for (const change of [r => r.sourceRevision = 'r0009', r => r.sourceUnchanged = false, r => r.frame = 2,
    r => r.objects[0].worldAxisExtentMm[0]++, r => r.sourceCheckpointSha256 = 'unbound']) {
    const entityId = source.entities[0].id, receipt = nativeReceipt('one', entityId); change(receipt)
    const handlers = createHandlers({ blenderStudio: { getScene: async () => ({ revision: 'r0001', digest: 'a'.repeat(64), spec: source, geometryInspection: receipt }) } })
    await assert.rejects(handlers['project.scene']({ params: { projectId: 'one' }, query: { revision: 'r0001', geometryEntityId: entityId, geometryFrame: '1' } }))
  }
})

test('one explicit native measurement displays saved dimensions without an edit or render', async t => {
  const f = await client(t); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  assert.equal(f.calls.length, 0); assert.ok(f.action('geometry-measure'))
  f.field('geometry-frame').props.onChange({ target: { value: '17' } })
  assert.equal(f.calls.length, 0)
  await f.store.actions.measureGeometry()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].frame, 17); assert.equal(f.calls[0].revision, 'r0001')
  const spans = f.nodes().find(n => n.props['data-native-spans']); assert.ok(spans)
  assert.ok(JSON.stringify(spans).includes('100 mm')); assert.ok(JSON.stringify(f.nodes()).includes('not establish wall thickness'))
  assert.equal(f.store.getState().selected.scene.revision, 'r0001')
  f.store.actions.setGeometryFrame(24); assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
})

test('native dimensions cannot silently follow a changed saved revision or project', async t => {
  const f = await client(t); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  await f.store.actions.measureGeometry(); assert.ok(f.nodes().some(n => n.props['data-native-spans']))
  f.projects.one.revision = 'r0002'; f.projects.one.scene = tree('r0002'); f.store.actions.reload()
  await settle(f.store, state => state.selected.scene.revision === 'r0002')
  assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
  f.store.actions.selectProject('two'); await settle(f.store, state => state.activeProjectId === 'two')
  f.store.actions.selectEditorEntity(source.entities[0].id); assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
})

for (const [name, alterNative] of [
  ['wrong revision', r => r.sourceRevision = 'r0009'], ['wrong frame', r => r.frame++], ['wrong part', r => r.objects[0].entityId = 'other'],
  ['unverified source', r => r.sourceUnchanged = false], ['invalid extent', r => r.objects[0].worldAxisExtentMm[0] = -1],
]) test(`native measurement UI refuses ${name}`, async t => {
  const f = await client(t, { alterNative }); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  await f.store.actions.measureGeometry(); assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
  assert.ok(f.nodes().some(n => n.props.role === 'alert'))
})

test('empty and invalid native frames remain drafts and prevent measuring', async t => {
  const f = await client(t); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  for (const value of ['', '1.5', '49']) {
    f.field('geometry-frame').props.onChange({ target: { value } })
    assert.equal(f.action('geometry-measure').props.disabled, true); await f.store.actions.measureGeometry()
  }
  assert.equal(f.calls.length, 0)
})

test('native measurement cancellation prevents late dimensions and keeps the saved scene', async t => {
  let enter, release
  const entered = new Promise(r => { enter = r }), finished = new Promise(r => { release = r })
  const f = await client(t, { beforeNative: async () => { enter(); await finished } }); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  const pending = f.store.actions.measureGeometry(); await entered
  assert.equal(f.action('geometry-measure').props.disabled, true)
  f.store.actions.cancelGeometry(); assert.equal(f.calls[0].signal.aborted, true); release(); await pending
  assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
  assert.equal(f.store.getState().selected.scene.revision, 'r0001'); assert.ok(f.nodes().some(n => n.props.role === 'alert'))
})

test('closing the workbench aborts native transport instead of adopting a late result', async t => {
  let enter, release
  const entered = new Promise(r => { enter = r }), finished = new Promise(r => { release = r })
  const f = await client(t, { beforeNative: async () => { enter(); await finished } }); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  const pending = f.store.actions.measureGeometry(); await entered; f.store.stop()
  assert.equal(f.calls[0].signal.aborted, true); release(); await pending
  assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
})

test('native measurements of a saved part do not apply an unsaved editor draft', async t => {
  const f = await client(t); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id)
  f.store.actions.updateEditor('transform', ['location', 0], .321)
  assert.ok(JSON.stringify(f.nodes()).includes('unapplied drafts are excluded'))
  await f.store.actions.measureGeometry()
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].revision, 'r0001')
  assert.equal(f.field('editor-location-x').props.value, 321)
})

test('unavailable native parts show a reason instead of dimensions', async t => {
  const f = await client(t, { alterNative: r => { r.objects = [{ entityId: r.objects[0].entityId, type: 'MESH', available: false, unavailableReason: 'viewport-disabled' }] } })
  f.store.actions.setView('scene'); f.store.actions.selectEditorEntity(source.entities[0].id); await f.store.actions.measureGeometry()
  assert.equal(f.nodes().some(n => n.props['data-native-spans']), false)
  assert.ok(JSON.stringify(f.nodes()).includes('disabled in the viewport'))
})

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

test('guide destinations reveal their actual tools and return from a historical image without writing', async t => {
  const { store, calls, action, nodes } = await client(t, { alterPayload: payload => {
    if (payload.previews) payload.previews.revisions.unshift({ revision: 'r0000', previews: [], contactSheets: [], diagnostics: [] })
    if (payload.selected) payload.selected.revisions = [{ revision: 'r0000' }, { revision: 'r0001' }]
    return payload
  } })
  const disclosure = id => nodes().find(node => node.props['data-disclosure'] && JSON.parse(node.props['data-disclosure']).at(-1) === id)
  const targets = { route: ['new:recipe-gallery'], parts: ['scene-outline'], form: ['inspection'], detail: ['inspection'], appearance: ['scene-outline', 'photography', 'assets'] }
  for (const [step, ids] of Object.entries(targets)) {
    action(`guide-${step}`).props.onClick()
    for (const id of ids) store.actions.setDisclosure(disclosure(id).props['data-disclosure'], false)
    action(`guide-${step}`).props.onClick()
    for (const id of ids) assert.equal(disclosure(id).props.open, true, `${step} opens ${id}`)
  }
  for (const step of ['form', 'detail']) {
    store.actions.selectLighttableResult('r0000')
    assert.equal(nodes().some(node => node.props['data-inspection-panel']), false, 'historical context has no current inspection tool')
    action(`guide-${step}`).props.onClick()
    assert.equal(store.getState().lighttableSelection, null)
    assert.equal(store.getState().currentRevision, 'r0001')
    assert.equal(disclosure('inspection').props.open, true)
    assert.ok(action('inspection-render'))
    assert.equal(store.getState().inspectionForms.one.mode, step === 'form' ? 'clay' : 'beauty')
  }
  store.actions.setView('scene')
  for (const [kind, id] of [['camera', source.cameras[0].id], ['light', source.lights[0].id]]) {
    store.actions.setDisclosure(disclosure('photography').props['data-disclosure'], false)
    store.actions.selectPhotography(kind, id)
    assert.equal(disclosure('photography').props.open, true, `${kind} selection opens the editor`)
  }
  assert.equal(calls.length, 0)
})

test('the shipped lighttable reserves measured image dimensions before decoding without inventing legacy pixels', async t => {
  for (const dimensions of [{ width: 256, height: 192 }, { width: 1200, height: 1800 }, {}, { width: 256 }, { width: 0, height: 192 }]) {
    const { nodes } = await client(t, { alterPayload: payload => {
      if (payload.previews) Object.assign(payload.previews.revisions[0].previews[0], dimensions)
      return payload
    } })
    const image = nodes().find(node => node.props.className === 'db-result-image')
    const measured = dimensions.width > 0 && dimensions.height > 0
    assert.equal(image.props.width, measured ? dimensions.width : undefined)
    assert.equal(image.props.height, measured ? dimensions.height : undefined)
    assert.equal(image.props.style.aspectRatio, measured ? `${dimensions.width} / ${dimensions.height}` : undefined)
    assert.equal(image.props.style.width === 'auto', !measured)
    assert.equal(image.props.style.height, 'auto')
    assert.equal(image.props.style.maxWidth, '100%')
  }
})

test('a creation without an automatic render retains its confirmation on the selected project brief', async t => {
  const { store } = await client(t)
  const state = store.getState(), message = 'Created the saved project without rendering'
  for (const projectId of ['one', 'two']) {
    const view = core.buildWorkbenchView({ ...state, view: 'projects', projectTask: 'brief',
      notices: { ...state.notices, projects: { kind: 'creation', projectId, ok: true, message } } }, store.actions)
    assert.equal(JSON.stringify(view).includes(message), projectId === state.activeProjectId)
  }
})

test('scene save feedback remains visible with no object selected and all tool disclosures closed', async t => {
  const { store } = await client(t), message = 'REVISION_CONFLICT: Saved source changed'
  const state = { ...store.getState(), view: 'scene', editorEntityId: null, disclosures: {},
    notices: { ...store.getState().notices, scene: { ok: false, message } } }
  const visible = node => !node || typeof node !== 'object' ? []
    : [node, ...(node.tag === 'details' && !node.props.open ? [] : (node.children || []).flatMap(visible))]
  const root = core.buildWorkbenchView(state, store.actions)
  assert.equal(nodesOf(root).filter(node => node.props['data-result'] === 'error').length, 1)
  assert.equal(visible(root).filter(node => node.props['data-result'] === 'error').length, 1)
  assert.match(JSON.stringify(visible(root).find(node => node.props['data-result'] === 'error')), /REVISION_CONFLICT/)
})

test('selecting an existing project shows its loading state until the new source arrives', async t => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const { store, nodes, field, calls } = await client(t, { beforeGet: async ({ id, path }) => {
    if (id === 'two' && path.endsWith('/previews')) { entered(); await held }
  } })
  store.actions.beginNewWork()
  const select = nodes().find(node => node.props['data-action'] === 'select-project:two')
  select.props.onClick(); await waiting
  assert.equal(store.getState().activeProjectId, null, 'a pending source cannot authorize edits')
  assert.equal(store.getState().view, 'preview')
  assert.equal(field('lighttable-project').props.value, 'two')
  const loading = nodes().find(node => node.props['data-preview-state'] === 'loading')
  assert.equal(loading.props['aria-busy'], 'true')
  assert.ok(JSON.stringify(loading).includes('two'))
  assert.equal(nodes().some(node => node.props.className === 'db-result-image'), false)
  assert.equal(nodes().some(node => node.props['data-action'] === 'create-project'), false)
  assert.equal(field('nav-scene').props.disabled, true)
  release(); await settle(store, state => state.activeProjectId === 'two')
  assert.equal(nodes().some(node => node.props['data-preview-state'] === 'loading'), false)
  assert.ok(nodes().some(node => node.props.className === 'db-result-image'))
  assert.equal(field('nav-scene').props.disabled, false)
  assert.equal(calls.length, 0)
})


test('mismatched receipts cannot be shown as a successful inspection', async t => {
  for (const mutation of [payload => { payload.preview.mode = 'beauty' }, payload => { payload.preview.sourceRevision = 'r9999' }, payload => { payload.preview.artifacts[0].cameraId = 'wrong-camera' }, payload => { payload.preview.artifacts[0].frame = 999 }]) {
    const { store } = await client(t, { alterPayload: payload => { if (payload.preview) mutation(payload); return payload } })
    store.actions.setInspection('mode', 'clay'); await store.actions.renderInspection()
    assert.equal(store.getState().inspectionWork.one.result, null); assert.match(store.getState().inspectionWork.one.error, /回执|receipt/)
  }
})
