import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const core = loadClientBundle().exports.workbench
const identityA = 'a'.repeat(64), identityB = 'b'.repeat(64)
const json = value => JSON.parse(JSON.stringify(value))
const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload), arrayBuffer() { throw new Error('Archive bytes must not enter JavaScript') }, blob() { throw new Error('Archive bytes must not enter JavaScript') } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label = 'condition') { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end, `timed out waiting for ${label}`); await wait(2) } }
function memoryStorage() {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
}
const entry = store => Object.values(store.getState().editableSnapshots).find(item => item.handle?.storeIdentity === store.getState().storeIdentity && item.handle?.projectId === store.getState().activeProjectId)
const selectedEntry = store => store.getState().editableSnapshots[JSON.stringify([store.getState().projectsRoot, store.getState().storeIdentity, store.getState().activeProjectId])]
const nodes = tree => [tree, ...(tree?.children || []).flatMap(nodes)].filter(value => value && typeof value === 'object')
const render = store => { store.actions.setView('revisions'); return core.renderView({ state: store.getState(), actions: store.actions }) }
const action = (store, name) => nodes(render(store)).find(node => node.props?.['data-action'] === name)
const exportId = requestId => `snapshot-${createHash('sha256').update(requestId).digest('hex').slice(0, 40)}`
function fixture(options = {}) {
  const storage = options.storage ?? memoryStorage(), calls = [], exports = new Map()
  let root = '/projects/a', storeIdentity = identityA, project = 'demo', revision = 'r0002', handler = options.handler
  const jobs = [
    { jobId: 'old-movie', revisionId: 'r0001', status: 'completed', delivery: { videoPath: 'renders/old/video.mp4' } },
    { jobId: 'current-movie', revisionId: 'r0002', status: 'completed', delivery: { videoPath: 'renders/current/video.mp4' } },
    { jobId: 'running-movie', revisionId: 'r0001', status: 'running', delivery: { videoPath: 'renders/running/video.mp4' } },
    { jobId: 'still-frame', revisionId: 'r0001', status: 'completed', delivery: null },
  ]
  const state = () => ({ ok: true, route: 'state', hostApiVersion: 6, projectsRoot: root, storeIdentity,
    editableSnapshotProtocol: options.protocol === undefined ? 1 : options.protocol,
    editableSnapshotAvailability: options.availability ?? { available: true },
    projects: [{ projectId: 'demo' }, { projectId: 'other' }], selected: { project: { projectId: project, title: 'Test' }, currentRevision: revision,
      revisions: [{ revision: 'r0001', isCurrent: revision === 'r0001' }, { revision: 'r0002', isCurrent: revision === 'r0002' }], jobs, unfinishedJobs: [] } })
  const snapshot = (body, resultState = 'preparing') => {
    const handle = { requestId: body.requestId, exportId: exportId(body.requestId), projectId: project, revision: body.revision, videoJobId: body.videoJobId || null, storeIdentity: body.expectedStoreIdentity }
    const value = { ...handle, state: resultState, phase: 'copying', writtenBytes: 30, totalBytes: 100 }
    if (resultState === 'ready') Object.assign(value, { downloadUrl: `/deepblend/projects/${encodeURIComponent(project)}/editable-snapshots/${handle.exportId}/download?storeIdentity=${handle.storeIdentity}`, archive: { bytes: 100, sha256: 'd'.repeat(64) } })
    return value
  }
  const fetch = async (input, init = {}) => {
    const url = String(input), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body, signal: init.signal })
    if (url.includes('/editable-snapshots')) {
      assert.ok(!url.includes('/download'), 'binary download must use an anchor')
      const result = handler ? await handler({ url, method, body, signal: init.signal, snapshot, exports }) : null
      if (result) return result
      if (method === 'POST' && url.endsWith('/editable-snapshots')) { const value = snapshot(body); exports.set(value.exportId, value); return response({ ok: true, snapshot: value }) }
      const id = url.split('/editable-snapshots/')[1].split('/')[0], value = exports.get(id)
      if (!value) return response({ ok: false, error: { code: 'SNAPSHOT_NOT_FOUND' } }, 404)
      if (method === 'POST') { value.state = 'cancelled'; return response({ ok: true, snapshot: value }) }
      return response({ ok: true, snapshot: value })
    }
    if (url.startsWith('/deepblend/state')) { const query = new URL(url, 'http://localhost').searchParams; project = query.get('projectId') || project; return response(state()) }
    if (url.includes('/jobs')) return response({ ok: true, route: 'project.jobs', jobs, unfinished: [] })
    if (url.includes('/previews')) return response({ ok: true, route: 'project.previews', artifactBase: `/deepblend/artifacts/${project}/`, previews: { projectId: project, revisions: [] } })
    throw new Error(`Unexpected route ${url}`)
  }
  const store = core.createWorkbenchStore({ fetch, editableSnapshotStorage: storage, preferenceStorage: storage, creationDraftStorage: storage,
    pollLiveMs: 100000, pollIdleMs: 100000, editableSnapshotPollMs: options.pollMs ?? 100000, editableSnapshotTimeoutMs: options.timeoutMs ?? 1000 })
  return { store, calls, exports, storage, snapshot, setHandler: value => { handler = value }, switchRoot: (back = false) => { root = back ? '/projects/a' : '/projects/b'; storeIdentity = back ? identityA : identityB }, switchRevision: () => { revision = 'r0001' },
    async start() { store.start(); try { await until(() => store.getState().status === 'ok', 'initial load'); return store } catch (error) { store.stop(); throw error } } }
}
const snapshotCalls = f => f.calls.filter(call => call.url.includes('/editable-snapshots'))

test('saved revision and completed same-revision video selection survive refresh and preserve authoring inputs', async t => {
  const f = fixture(), store = await f.start(); t.after(() => store.stop())
  assert.equal(selectedEntry(store).revision, 'r0002')
  store.actions.setForm('title', 'unsaved title'); store.actions.setForm('patch', '{"unsaved":true}')
  store.actions.setSnapshotRevision('r0001'); store.actions.setSnapshotVideo('running-movie')
  assert.equal(selectedEntry(store).videoJobId, null)
  const options = nodes(render(store)).find(node => node.props?.['data-field'] === 'snapshot-video').children.map(node => node.props.value)
  assert.deepEqual(json(options), ['', 'old-movie'])
  store.actions.setSnapshotVideo('old-movie'); f.switchRevision(); store.actions.reload(); await wait(10)
  assert.equal(selectedEntry(store).revision, 'r0001'); assert.equal(selectedEntry(store).videoJobId, 'old-movie')
  await store.actions.prepareEditableSnapshot()
  assert.equal(snapshotCalls(f)[0].body.revision, 'r0001'); assert.equal(snapshotCalls(f)[0].body.videoJobId, 'old-movie')
  assert.equal(store.getState().forms.title, 'unsaved title'); assert.equal(store.getState().forms.patch, '{"unsaved":true}')
})

test('double clicks create once; failed and cancelled retries reuse exactly the frozen request', async t => {
  let count = 0
  const f = fixture({ handler: ({ method, body, snapshot }) => method === 'POST' && body.requestId ? response({ ok: true, snapshot: snapshot(body, ++count === 1 ? 'failed' : 'cancelled') }) : null })
  const store = await f.start(); t.after(() => store.stop())
  await Promise.all([store.actions.prepareEditableSnapshot(), store.actions.prepareEditableSnapshot()])
  assert.equal(count, 1)
  const first = json(snapshotCalls(f)[0].body), handle = json(entry(store).handle)
  await store.actions.prepareEditableSnapshot(); await store.actions.prepareEditableSnapshot()
  assert.equal(count, 3); assert.deepEqual(snapshotCalls(f).map(call => call.body), [first, first, first]); assert.deepEqual(json(entry(store).handle), handle)
  store.actions.setSnapshotRevision('r0001'); assert.equal(count, 3)
  await store.actions.prepareEditableSnapshot()
  assert.equal(count, 4); assert.notEqual(snapshotCalls(f)[3].body.requestId, first.requestId)
})

test('refresh restores the stored handle with GET, including the fixed historical selection', async t => {
  const f = fixture(), first = await f.start(); first.actions.setSnapshotRevision('r0001'); first.actions.setSnapshotVideo('old-movie'); await first.actions.prepareEditableSnapshot(); const handle = json(entry(first).handle); first.stop()
  const second = fixture({ storage: f.storage, handler: ({ method }) => method === 'GET' ? response({ ok: true, snapshot: { ...handle, state: 'failed', error: { code: 'SNAPSHOT_INTERRUPTED' } } }) : null })
  const store = await second.start(); t.after(() => store.stop()); await until(() => entry(store)?.result?.state === 'failed')
  assert.equal(snapshotCalls(second).length, 1); assert.equal(snapshotCalls(second)[0].method, 'GET'); assert.equal(selectedEntry(store).revision, 'r0001')
  await store.actions.prepareEditableSnapshot(); assert.equal(snapshotCalls(second)[1].body.requestId, handle.requestId)
  const persisted = f.storage.getItem('deepblend.editable-snapshots/v1'); assert.ok(persisted.length < 4096); assert.ok(!persisted.includes('scene'))
})

test('a failed status read preserves the handle, stops polling, and explicit check recovers it', async t => {
  let failCheck = true
  const f = fixture({ pollMs: 10, handler: ({ method }) => { if (method === 'GET' && failCheck) throw new Error('offline'); return null } })
  const store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot(); const handle = json(entry(store).handle)
  await until(() => entry(store)?.issue); const count = snapshotCalls(f).length; await wait(35); assert.equal(snapshotCalls(f).length, count)
  assert.deepEqual(json(entry(store).handle), handle); assert.ok(action(store, 'snapshot-check'))
  failCheck = false; f.exports.get(handle.exportId).state = 'failed'; await store.actions.checkEditableSnapshot()
  assert.equal(entry(store).issue, null); assert.equal(entry(store).result.state, 'failed')
})

test('unknown POST outcome keeps its handle before fetching and can retry the same POST after a missing GET', async t => {
  const f = fixture({ handler: ({ method }) => { if (method === 'POST') throw new Error('connection lost'); return null } })
  const store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot(); const first = json(snapshotCalls(f)[0].body)
  assert.ok(f.storage.getItem('deepblend.editable-snapshots/v1')?.includes(first.requestId))
  await store.actions.checkEditableSnapshot(); assert.equal(entry(store).issue?.code, 'SNAPSHOT_NOT_FOUND')
  f.setHandler(null); await store.actions.prepareEditableSnapshot(); assert.deepEqual(snapshotCalls(f).at(-1).body, first)
})

test('hung fetch and hung JSON bodies are bounded, aborted, and retain a retry handle', async t => {
  for (const stage of ['fetch', 'body']) {
    const f = fixture({ timeoutMs: 20, handler: () => stage === 'fetch' ? new Promise(() => {}) : { ok: true, json: () => new Promise(() => {}) } })
    const store = await f.start(); t.after(() => store.stop()); const begin = Date.now(); const completed = await Promise.race([store.actions.prepareEditableSnapshot().then(() => true), wait(200).then(() => false)]); assert.equal(completed, true, 'control request must finish within its deadline')
    assert.ok(Date.now() - begin < 500); assert.equal(snapshotCalls(f)[0].signal.aborted, true); assert.ok(entry(store).issue); assert.ok(entry(store).handle); assert.equal(entry(store).busy.prepare, false)
  }
})

test('project and store switches ignore late replies and abort their local request without server cancellation', async t => {
  for (const switchKind of ['project', 'root']) {
    const pending = deferred(); let captured
    const f = fixture({ handler: request => { if (request.method === 'POST') { captured = request.snapshot(request.body, 'ready'); return pending.promise } return null } })
    const store = await f.start(); t.after(() => store.stop()); const preparing = store.actions.prepareEditableSnapshot(); await until(() => captured)
    if (switchKind === 'project') store.actions.selectProject('other'); else { f.switchRoot(); store.actions.reload() }
    await until(() => switchKind === 'project' ? store.getState().activeProjectId === 'other' : store.getState().storeIdentity === identityB)
    pending.resolve(response({ ok: true, snapshot: captured })); await preparing
    assert.equal(selectedEntry(store).handle, null); assert.equal(snapshotCalls(f)[0].signal.aborted, true)
    assert.ok(!snapshotCalls(f).some(call => call.url.endsWith('/cancel'))); assert.equal(action(store, 'snapshot-download'), undefined)
  }
})

test('ready wins both cancel/status reply orders, with the cancel request pinned to the store identity', async t => {
  for (const readyFirst of [true, false]) {
    const get = deferred(), cancel = deferred()
    const f = fixture(), store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot(); const handle = json(entry(store).handle)
    const ready = f.snapshot(snapshotCalls(f)[0].body, 'ready'), cancelled = { ...handle, state: 'cancelled' }
    f.setHandler(({ method }) => method === 'GET' ? get.promise : cancel.promise)
    const checking = store.actions.checkEditableSnapshot(), cancelling = store.actions.cancelEditableSnapshot()
    await until(() => snapshotCalls(f).length === 3)
    assert.deepEqual(snapshotCalls(f)[2].body, { expectedStoreIdentity: identityA })
    if (readyFirst) { get.resolve(response({ ok: true, snapshot: ready })); await checking; cancel.resolve(response({ ok: true, snapshot: cancelled })); await cancelling }
    else { cancel.resolve(response({ ok: true, snapshot: cancelled })); await cancelling; get.resolve(response({ ok: true, snapshot: ready })); await checking }
    assert.equal(entry(store).result.state, 'ready'); assert.equal(action(store, 'snapshot-download').props.href, ready.downloadUrl)
  }
})

test('wrong identity, external URL, unbound store URL, query injection and invalid archive metadata never produce a download link', async t => {
  const mutations = [value => ({ ...value, projectId: 'other' }), value => ({ ...value, revision: 'r0999' }), value => ({ ...value, videoJobId: 'wrong' }),
    value => ({ ...value, exportId: 'snapshot-'+ 'f'.repeat(40) }), value => ({ ...value, requestId: 'wrong' }), value => ({ ...value, storeIdentity: identityB }),
    value => ({ ...value, downloadUrl: 'https://example.com/file.zip' }), value => ({ ...value, downloadUrl: value.downloadUrl.split('?')[0] }),
    value => ({ ...value, downloadUrl: value.downloadUrl + '&extra=1' }), value => ({ ...value, archive: { bytes: -1, sha256: 'bad' } })]
  for (const mutate of mutations) {
    const f = fixture({ handler: ({ body, snapshot }) => response({ ok: true, snapshot: mutate(snapshot(body, 'ready')) }) })
    const store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot()
    assert.equal(entry(store).issue?.code, 'UI_SNAPSHOT_MISMATCH'); assert.equal(action(store, 'snapshot-download'), undefined)
  }
})

test('ready offers a plain attachment link; terminal states stop polling and clicking cannot claim completion', async t => {
  const f = fixture({ pollMs: 10, handler: ({ body, snapshot }) => response({ ok: true, snapshot: snapshot(body, 'ready') }) })
  const store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot(); const download = action(store, 'snapshot-download')
  assert.equal(download.tag, 'a'); assert.equal(download.props.download, true); assert.equal(download.props.onClick, undefined)
  assert.match(download.props.href, /\/download\?storeIdentity=a{64}$/); await wait(35); assert.equal(snapshotCalls(f).length, 1)
  await store.actions.prepareEditableSnapshot(); assert.equal(snapshotCalls(f).length, 1)
})

test('stop aborts control and polling but does not cancel the Host preparation', async () => {
  const pending = deferred(); let began = false
  const f = fixture({ handler: () => { began = true; return pending.promise } }), store = await f.start()
  const preparing = store.actions.prepareEditableSnapshot(); await until(() => began); store.stop(); await preparing
  assert.equal(snapshotCalls(f)[0].signal.aborted, true); assert.equal(snapshotCalls(f).length, 1)
})

test('unavailable storage falls back in memory, while unavailable capability prevents requests and explains recovery', async t => {
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() {} }
  const f = fixture({ storage: blocked }), store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot()
  assert.equal(entry(store).storageUnavailable, true); assert.ok(entry(store).handle)
  for (const options of [{ protocol: null }, { availability: { available: false, reason: 'local-only' } }]) {
    const f = fixture(options), store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot()
    assert.equal(snapshotCalls(f).length, 0); assert.equal(action(store, 'snapshot-prepare').props.disabled, true)
    assert.ok(nodes(render(store)).find(node => node.props?.['data-snapshot-unavailable']))
  }
})


test('returning to the same store cannot admit a reply from an earlier visit', async t => {
  const pending = deferred(); let late
  const f = fixture({ handler: ({ method, body, snapshot }) => { if (method === 'POST') { late = snapshot(body, 'ready'); return pending.promise } return null } })
  const store = await f.start(); t.after(() => store.stop()); const preparing = store.actions.prepareEditableSnapshot(); await until(() => late)
  f.switchRoot(); store.actions.reload(); await until(() => store.getState().storeIdentity === identityB)
  f.switchRoot(true); store.actions.reload(); await until(() => store.getState().storeIdentity === identityA && entry(store)?.issue)
  pending.resolve(response({ ok: true, snapshot: late })); await preparing
  assert.equal(action(store, 'snapshot-download'), undefined); assert.equal(entry(store).result, null)
})

test('remembered requests stay within twenty bounded identity records without retaining scene content', async t => {
  const storage = memoryStorage(), records = []
  for (let i = 0; i < 20; i++) {
    const requestId = `old-${i}`
    records.push({ key: JSON.stringify(['/other-root', identityA, `project-${i}`]), handle: { requestId, exportId: exportId(requestId), projectId: `project-${i}`, revision: 'r0001', videoJobId: null, storeIdentity: identityA }, savedAt: '2026-10-22T00:00:00Z' })
  }
  storage.setItem('deepblend.editable-snapshots/v1', JSON.stringify(records))
  const f = fixture({ storage }), store = await f.start(); t.after(() => store.stop()); store.actions.setForm('patch', '{"privateSceneDraft":true}'); await store.actions.prepareEditableSnapshot()
  const raw = storage.getItem('deepblend.editable-snapshots/v1'), saved = JSON.parse(raw)
  assert.equal(saved.length, 20); assert.equal(saved.at(-1).handle.projectId, 'demo'); assert.equal(saved.some(record => record.handle.requestId === 'old-0'), false)
  assert.ok(raw.length < 81920); assert.ok(!raw.includes('privateSceneDraft'))
})

test('tampered remembered export identifiers are rejected before any control request', async t => {
  const storage = memoryStorage(), requestId = 'remembered-copy'
  storage.setItem('deepblend.editable-snapshots/v1', JSON.stringify([{ key: JSON.stringify(['/projects/a', identityA, 'demo']), handle: {
    requestId, exportId: 'snapshot-' + 'e'.repeat(40), projectId: 'demo', revision: 'r0001', videoJobId: null, storeIdentity: identityA } }]))
  const f = fixture({ storage }), store = await f.start(); t.after(() => store.stop()); await until(() => entry(store)?.issue)
  assert.equal(entry(store).issue?.code, 'UI_SNAPSHOT_MISMATCH'); assert.equal(snapshotCalls(f).length, 0)
})

test('a stale preparing read cannot restart polling after cancellation', async t => {
  const get = deferred(), f = fixture(), store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot()
  const handle = json(entry(store).handle)
  f.setHandler(({ method }) => method === 'GET' ? get.promise : response({ ok: true, snapshot: { ...handle, state: 'cancelled' } }))
  const checking = store.actions.checkEditableSnapshot(); await store.actions.cancelEditableSnapshot()
  get.resolve(response({ ok: true, snapshot: { ...handle, state: 'preparing' } })); await checking
  assert.equal(entry(store).result.state, 'cancelled')
})


test('verification bytes include manifest overhead and are not presented as a source-byte percentage', async t => {
  const f = fixture({ handler: ({ body, snapshot }) => response({ ok: true, snapshot: { ...snapshot(body), phase: 'verifying', verifiedBytes: 120, totalBytes: 100 } }) })
  const store = await f.start(); t.after(() => store.stop()); await store.actions.prepareEditableSnapshot()
  const card = nodes(render(store)).find(node => node.props?.['data-editable-snapshot'])
  assert.equal(nodes(card).some(node => node.props?.['data-progress']), false)
  assert.ok(JSON.stringify(card).includes('Verified 120 B'))
  assert.equal(action(store, 'snapshot-download'), undefined)
})


test('an uncertain recheck of a remembered ready copy can retry the same request', async t => {
  const f = fixture({ handler: ({ body, snapshot }) => response({ ok: true, snapshot: snapshot(body, 'ready') }) }), store = await f.start()
  t.after(() => store.stop()); await store.actions.prepareEditableSnapshot(); const first = json(snapshotCalls(f)[0].body)
  f.setHandler(({ method }) => { if (method === 'GET') throw new Error('lost connection'); return null })
  store.actions.selectProject('other'); await until(() => store.getState().activeProjectId === 'other')
  store.actions.selectProject('demo'); await until(() => store.getState().activeProjectId === 'demo' && entry(store)?.issue)
  assert.equal(action(store, 'snapshot-download'), undefined); assert.equal(action(store, 'snapshot-prepare').props.disabled, false)
  await store.actions.prepareEditableSnapshot()
  assert.deepEqual(snapshotCalls(f).at(-1).body, first); assert.equal(entry(store).result.state, 'preparing')
})
