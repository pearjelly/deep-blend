/** Browser bundle selection and Host HTTP boundary, without Blender or a browser. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import BlenderUiHost, { createHandlers } from '@deepblend/dsh-blender-ui'
import { buildSceneTree, compileSceneSpec, matchUiRoute, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'
import { environment, dshLocale, flush } from '../lib/locale-lifecycle.mjs'

const core = loadClientBundle().exports.workbench, clone = value => JSON.parse(JSON.stringify(value))
const limit = { maxBytes: 1000, bundleUpload: { maxFiles: 256, lifetimeMs: 900000, maxActive: 1 } }
const file = (path, size = 10, directory = true) => ({ name: path.split('/').at(-1), size, type: 'application/octet-stream', webkitRelativePath: directory ? `Selected folder/${path}` : '' })
const files = () => [file('models/cup.gltf'), file('data/mesh.bin'), file('textures/釉 色.png')]
const uploadId = 'upload-00000000-0000-0000-0000-000000000001'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const nodesOf = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []
const chooseFiles = (store, selected, name) => nodesOf(core.renderView({ state: store.getState(), actions: store.actions })).find(node => node.props['data-field'] === name).props.onChange({ target: { files: selected, value: 'selected' } })
async function until(store, predicate) {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(Error('UI did not settle')) }, 3000)
    const stop = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); stop(); resolve() } })
  })
}
async function client(t, options = {}) {
  const spec = compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/metal-lamp/scene-spec.json', import.meta.url)))).spec
  const projects = Object.fromEntries(['one', 'two'].map(id => [id, { revision: 'r0001', assets: [] }]))
  const calls = [], sessions = new Map()
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://local'), id = parsed.pathname.match(/projects\/([^/]+)/)?.[1] || parsed.searchParams.get('projectId') || 'one'
    const project = projects[id], suffix = parsed.pathname.split('/asset-uploads')[1]
    let payload
    if (suffix !== undefined) {
      const kind = suffix === '' ? 'create' : suffix.endsWith('/complete') ? 'complete' : suffix.endsWith('/cancel') ? 'cancel' : suffix.includes('/files/') ? 'file' : 'get'
      const request = { kind, id, init, body: kind === 'file' ? init.body : init.body ? JSON.parse(init.body) : undefined }
      calls.push(request); await options.before?.(request, sessions)
      if (kind === 'create') {
        payload = { projectId: id, uploadId, status: 'receiving', files: request.body.files.map((item, i) => ({ ...item, id: `file-${i}` })), receivedBytes: 0 }
        sessions.set(uploadId, payload)
      } else {
        const session = sessions.get(uploadId); assert.equal(session.projectId, id)
        if (kind === 'file') {
          assert.equal(init.headers['content-type'], 'application/octet-stream')
          const index = Number(suffix.split('-').at(-1)); session.receivedBytes += session.files[index].bytes
          payload = session
        } else if (kind === 'complete') {
          const asset = { id: 'uploaded-model', type: 'gltf', path: 'assets/bundles/pkg/models/cup.gltf', sha256: 'a'.repeat(64) }
          session.status = 'completed'; session.receipt = { projectId: id, uploadId, asset, unusedFiles: options.unused ? ['unused.txt'] : [] }
          project.assets.push({ asset, bytes: 10, originalName: 'models/cup.gltf', bundle: { totalBytes: 30, files: session.files }, inspection: null })
          payload = session
        } else if (kind === 'cancel') { if (session.status !== 'completed') session.status = 'cancelled'; payload = session }
        else payload = session
      }
      payload = clone(payload)
      await options.after?.(request, payload)
      payload = { ok: true, ...clone(payload) }
    } else if ((parsed.pathname.endsWith('/assets') && init.method === 'POST') || /\/assets\/[^/]+\/preview$/.test(parsed.pathname)) {
      const request = { kind: parsed.pathname.endsWith('/preview') ? 'preview' : 'single-file', id, init }
      calls.push(request); await options.before?.(request, sessions)
      payload = { ok: true }
    } else if (parsed.pathname.endsWith('/assets')) {
      const request = { kind: 'library', id, revision: parsed.searchParams.get('revision') }
      calls.push(request); await options.before?.(request, sessions)
      payload = { ok: true, route: 'project.assets.list', projectId: id, revision: project.revision, limits: limit, assets: project.assets }
    } else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', previews: { revisions: [] }, artifactBase: `/deepblend/artifacts/${id}/` }
    else { assert.notEqual(init.method, 'POST', `Unexpected scene write: ${url}`); payload = { ok: true, route: 'state', projects: [{ projectId: 'one' }, { projectId: 'two' }], selected: { project: { projectId: id }, currentRevision: project.revision, scene: buildSceneTree(spec, { revision: project.revision }), qa: { summary: 'No report' }, jobs: [], unfinishedJobs: [] } } }
    payload.hostApiVersion = HOST_API_VERSION
    return { ok: true, status: 200, json: async () => clone(payload), text: async () => JSON.stringify(payload) }
  }
  const env = options.standalone ? pickerEnvironment() : null
  const mounted = env ? await env.bundle.mountStandalone(env.root, { fetch, pollIdleMs: 100000, bundlePollMs: 5 }) : null
  const store = mounted?.store || core.createWorkbenchStore({ fetch, pollIdleMs: 100000, bundlePollMs: 5 }); t.after(() => mounted ? mounted.dispose() : store.stop())
  store.start(); await until(store, state => state.status === 'ok'); store.actions.setView('scene'); await store.actions.loadAssets()
  const nodes = () => nodesOf(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = name => nodes().find(node => node.props['data-field'] === name), action = name => nodes().find(node => node.props['data-action'] === name)
  const select = (selected = files(), mode = 'directory') => { chooseFiles(store, selected, mode === 'directory' ? 'asset-bundle-directory' : 'asset-bundle-files'); store.actions.setAssetBundleEntry(mode === 'directory' ? 'models/cup.gltf' : 'cup.gltf'); return selected }
  return { store, calls, projects, sessions, select, field, action, env, mounted }
}

test('bundle routes forward only declared member metadata and trusted request bytes', async () => {
  const calls = [], studio = Object.fromEntries(['createAssetUpload', 'getAssetUpload', 'uploadAssetFile', 'completeAssetUpload', 'cancelAssetUpload'].map(name => [name, async request => { calls.push({ name, request }); return {} }]))
  const handlers = createHandlers({ blenderStudio: studio }), signal = new AbortController().signal, stream = Readable.from(['original'])
  const extra = { stagingRoot: '/outside', sourceRoot: '/outside', sourcePath: '/outside', command: 'bad', assetId: 'chosen' }
  const ids = ['create', 'get', 'file', 'complete', 'cancel'], paths = ['', `/${uploadId}`, `/${uploadId}/files/file-0`, `/${uploadId}/complete`, `/${uploadId}/cancel`]
  for (let i = 0; i < ids.length; i++) {
    const route = `project.assetUploads.${ids[i]}`
    assert.equal(matchUiRoute(ids[i] === 'get' ? 'GET' : 'POST', `/deepblend/projects/one/asset-uploads${paths[i]}`).route.id, route)
    await handlers[route]({ params: { projectId: 'one', uploadId, fileId: 'file-0', ...extra }, body: { entrypoint: 'cup.gltf', files: [{ path: 'cup.gltf', bytes: 10, ...extra }], license: 'CC0', ...extra }, query: extra, request: stream, signal })
  }
  assert.deepEqual(calls.map(item => item.request), [
    { projectId: 'one', entrypoint: 'cup.gltf', files: [{ path: 'cup.gltf', bytes: 10 }], license: 'CC0', signal },
    { projectId: 'one', uploadId }, { projectId: 'one', uploadId, fileId: 'file-0', stream, signal },
    { projectId: 'one', uploadId, signal }, { projectId: 'one', uploadId },
  ])
})

test('member HTTP body bypasses JSON limits and disconnect aborts its stream with listener cleanup', async t => {
  const context = new Context(); t.after(() => context.fiber.dispose())
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7), request = Readable.from([bytes])
  Object.assign(request, { method: 'POST', url: `/deepblend/projects/one/asset-uploads/${uploadId}/files/file-0`, headers: { 'content-type': 'application/octet-stream' } })
  const response = Object.assign(new EventEmitter(), { setHeader() {}, end(body) { this.body = body; this.writableEnded = true } })
  let received
  context.provide('blenderStudio', { uploadAssetFile: async input => {
    received = input; const chunks = []; for await (const chunk of input.stream) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), bytes); response.emit('close'); assert.equal(input.signal.aborted, true); return {}
  } })
  await new BlenderUiHost(context, { serveRoute: false })._handle(request, response)
  assert.equal(received.stream, request); assert.equal(received.fileId, 'file-0')
  assert.equal(response.listenerCount('close'), 0); assert.equal(request.listenerCount('aborted'), 0)
})

test('selection retains directory paths and percent bytes, while multi-file selection never invents directories', () => {
  const selected = files(); selected.push(file('textures/100% finish.png', 0))
  const result = core.assetLibrary.selection(selected, 'directory', limit)
  assert.deepEqual(clone(result.files.map(item => item.path)), ['models/cup.gltf', 'data/mesh.bin', 'textures/釉 色.png', 'textures/100% finish.png'])
  assert.equal(result.entrypoint, ''); assert.equal(result.totalBytes, 30)
  const flat = core.assetLibrary.selection(selected, 'files', limit)
  assert.deepEqual(clone(flat.files.map(item => item.path)), ['cup.gltf', 'mesh.bin', '釉 色.png', '100% finish.png'])
  for (const bad of [[file('a.gltf'), file('A.gltf')], [file('cup.gltf'), file('é.png'), file('é.png')], [file('cup.gltf'), file('A/a.png'), file('a/b.png')], [file('cup.gltf'), file('../bad.png')], [file('cup.gltf'), file('NUL.png')], [file('cup.gltf'), file('a'), file('a/x')], [file('cup.gltf', 1001)]]) assert.throws(() => core.assetLibrary.selection(bad, 'directory', limit))
  assert.throws(() => core.assetLibrary.selection([file('cup.gltf', 1, false)], 'directory', limit), /browser did not provide folder-relative paths/)
  assert.throws(() => core.assetLibrary.selection([file('cup.gltf'), { ...file('img.png'), webkitRelativePath: 'Other/img.png' }], 'directory', limit), /browser did not provide folder-relative paths/)
})

test('real picker controls require an explicit entrypoint, upload original handles and only refresh the library', async t => {
  const { store, calls, projects, field, action } = await client(t, { unused: true })
  assert.equal(field('asset-bundle-files').props.multiple, true); assert.equal(field('asset-bundle-directory').props.webkitdirectory, '')
  const selected = files(), event = { target: { files: selected, value: 'selected' } }
  field('asset-bundle-directory').props.onChange(event)
  assert.equal(event.target.value, ''); assert.equal(action('asset-bundle-upload').props.disabled, true)
  assert.equal(calls.filter(item => item.kind === 'create').length, 0)
  field('asset-bundle-entrypoint').props.onChange({ target: { value: 'models/cup.gltf' } })
  field('asset-license').props.onChange({ target: { value: 'Artist permission' } })
  await action('asset-bundle-upload').props.onClick()
  const create = calls.find(item => item.kind === 'create')
  assert.equal(create.body.license, 'Artist permission'); assert.equal(create.body.entrypoint, 'models/cup.gltf')
  assert.deepEqual(create.body.files, selected.map(item => ({ path: item.webkitRelativePath.slice('Selected folder/'.length), bytes: item.size })))
  assert.deepEqual(calls.filter(item => item.kind === 'file').map(item => item.body), selected)
  assert.equal(projects.one.assets.length, 1); assert.equal(projects.one.revision, 'r0001'); assert.equal(store.getState().assetDrafts.one, undefined)
  assert.equal(store.getState().assetPreviews.one?.[core.assetLibrary.key(projects.one.assets[0].asset)], undefined)
  assert.equal(action('asset-use:uploaded-model').props.disabled, true); assert.equal(store.getState().assetBundleSelections.one, null)
  assert.match(store.getState().assetWork.one.message, /1/)
})

test('invalid selections and missing entrypoint produce no upload request', async t => {
  const { store, calls } = await client(t)
  chooseFiles(store, [file('cup.gltf', 1001)], 'asset-bundle-directory'); await store.actions.uploadAssetBundle()
  chooseFiles(store, files(), 'asset-bundle-directory'); await store.actions.uploadAssetBundle()
  assert.equal(calls.some(item => item.kind === 'create'), false); assert.ok(store.getState().assetWork.one.error)
})

test('late create after project switch cancels the origin session without uploading or touching the new draft', async t => {
  const entered = deferred(), release = deferred()
  const { store, calls, projects, sessions, select } = await client(t, { before: async request => { if (request.kind === 'create') { entered.resolve(); await release.promise } } })
  select(); const transfer = store.actions.uploadAssetBundle(); await entered.promise
  store.actions.selectProject('two'); await until(store, state => state.activeProjectId === 'two'); store.actions.updateBrief('goal', 'Keep this project')
  release.resolve(); await transfer
  assert.equal(sessions.get(uploadId).status, 'cancelled'); assert.equal(calls.some(item => item.kind === 'file'), false)
  assert.equal(calls.find(item => item.kind === 'cancel').id, 'one'); assert.equal(store.getState().briefDrafts.two.goal, 'Keep this project')
  assert.equal(projects.two.assets.length, 0); assert.equal(store.getState().assetWork.two, undefined)
})

test('cancel before create response preserves unavailable meaning and permits a new upload', async t => {
  const entered = deferred(), release = deferred()
  const { store, select, calls, projects, action } = await client(t, {
    before: async request => { if (request.kind === 'create') { entered.resolve(); await release.promise } },
    after: async (request, payload) => {
      if (request.kind === 'cancel') { payload.status = 'unavailable'; payload.reason = 'unknown-session'; delete payload.receipt }
    },
  })
  const selected = select(), transfer = store.actions.uploadAssetBundle(); await entered.promise
  await store.actions.cancelAsset()
  assert.equal(calls.filter(item => item.kind === 'cancel').length, 0, 'there is no remote ID before creation returns')
  release.resolve(); await transfer
  const work = store.getState().assetWork.one
  assert.match(work.error || work.message, /unavailable|无法继续/i)
  assert.doesNotMatch([work.error, work.message].filter(Boolean).join(' '), /cancelled|已取消/i)
  assert.equal(work.busy, null); assert.equal(work.bundleCleanup ?? false, false)
  assert.equal(calls.filter(item => item.kind === 'cancel').length, 1)
  assert.equal(calls.some(item => ['file', 'complete'].includes(item.kind)), false)
  assert.equal(projects.one.revision, 'r0001'); assert.equal(projects.one.assets.length, 0)
  assert.equal(action('asset-bundle-upload').props.disabled, false)
  await store.actions.uploadAssetBundle()
  assert.equal(calls.filter(item => item.kind === 'create').length, 2)
  assert.deepEqual(calls.filter(item => item.kind === 'file').map(item => item.init.body), selected)
  assert.equal(projects.one.assets.length, 1); assert.equal(projects.one.revision, 'r0001')
})

test('live progress reports Host bytes and cancel aborts transport and requests private session cleanup', async t => {
  const entered = deferred()
  const { store, select, calls, sessions } = await client(t, { before: async (request, live) => {
    if (request.kind === 'file') {
      live.get(uploadId).inFlightBytes = 4; entered.resolve()
      await new Promise((resolve, reject) => { request.init.signal.addEventListener('abort', () => reject(Error('transport aborted')), { once: true }) })
    }
  } })
  select(); const transfer = store.actions.uploadAssetBundle(); await entered.promise
  await until(store, state => state.assetWork.one.bundleProgress.receivedBytes === 4)
  await store.actions.cancelAsset(); await transfer
  assert.equal(calls.find(item => item.kind === 'file').init.signal.aborted, true)
  assert.equal(sessions.get(uploadId).status, 'cancelled'); assert.equal(calls.some(item => item.kind === 'complete'), false)
  assert.equal(store.getState().assetWork.one.busy, null); assert.equal(store.getState().assetDrafts.one, undefined)
})

test('lost complete response recovers committed receipt without another import or scene write', async t => {
  const { store, select, calls, projects } = await client(t, { after: async request => { if (request.kind === 'complete') throw Error('Response lost') } })
  select(); await store.actions.uploadAssetBundle()
  assert.equal(calls.filter(item => item.kind === 'complete').length, 1); assert.equal(calls.filter(item => item.kind === 'cancel').length, 1)
  assert.equal(projects.one.assets.length, 1); assert.equal(store.getState().assetLibraries.one.assets.length, 1)
  assert.equal(store.getState().assetWork.one.error, null); assert.equal(projects.one.revision, 'r0001')
})

test('late published receipt and library refresh remain on origin and use its current revision', async t => {
  const entered = deferred(), release = deferred()
  const { store, select, calls, projects } = await client(t, { after: async request => { if (request.kind === 'complete') { entered.resolve(); await release.promise } } })
  select(); const transfer = store.actions.uploadAssetBundle(); await entered.promise
  projects.one.revision = 'r0002'; store.actions.reload(); await until(store, state => state.currentRevision === 'r0002')
  release.resolve(); await transfer
  assert.equal(calls.filter(item => item.kind === 'library').at(-1).revision, 'r0002'); assert.equal(projects.one.revision, 'r0002')
})

test('dependency failure retains selection for correction; failed cleanup remains cancellable', async t => {
  let refuseCancel = true
  const { store, select, calls } = await client(t, { before: async request => {
    if (request.kind === 'file') throw Error('ASSET_SOURCE_NOT_FOUND: textures/paint.png')
    if (request.kind === 'cancel' && refuseCancel) throw Error('Disconnected')
  } })
  select(); await store.actions.uploadAssetBundle()
  assert.equal(store.getState().assetWork.one.bundleCleanup, true); assert.ok(store.getState().assetBundleSelections.one)
  const count = calls.length; await store.actions.uploadAssetBundle(); assert.equal(calls.length, count)
  refuseCancel = false; await store.actions.cancelAsset()
  assert.equal(store.getState().assetWork.one.bundleCleanup, false); assert.equal(store.getState().assetWork.one.error, null)
})

test('a member response from another project is refused and never reaches completion', async t => {
  const { store, select, calls } = await client(t, { after: async (request, payload) => { if (request.kind === 'file') return void (payload.projectId = 'two') } })
  select(); await store.actions.uploadAssetBundle()
  assert.equal(calls.some(item => item.kind === 'complete'), false)
  assert.equal(calls.filter(item => item.kind === 'file').length, 1)
  assert.ok(store.getState().assetWork.one.error); assert.equal(store.getState().assetDrafts.one, undefined)
})

test('a completed receipt for another project cannot be displayed as this project’s success', async t => {
  const { store, select } = await client(t, { after: async (request, payload) => { if (['complete', 'cancel'].includes(request.kind) && payload.receipt) payload.receipt.projectId = 'two' } })
  select(); await store.actions.uploadAssetBundle()
  assert.ok(store.getState().assetWork.one.error); assert.equal(store.getState().assetWork.one.message, null)
  assert.equal(store.getState().assetDrafts.one, undefined); assert.ok(store.getState().assetBundleSelections.one)
})

test('stopping the store aborts native file transport and cancels its session', async t => {
  const entered = deferred()
  const { store, select, sessions } = await client(t, { before: async request => {
    if (request.kind === 'file') {
      entered.resolve()
      await new Promise((resolve, reject) => request.init.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }))
    }
  } })
  select(); const transfer = store.actions.uploadAssetBundle(); await entered.promise
  store.stop(); await transfer
  assert.equal(sessions.get(uploadId).status, 'cancelled'); assert.equal(store.getState().assetDrafts.one, undefined)
})

test('published completion arriving after project switch only refreshes the originating library', async t => {
  const entered = deferred(), release = deferred()
  const { store, select, projects, calls } = await client(t, { after: async request => { if (request.kind === 'complete') { entered.resolve(); await release.promise } } })
  select(); const transfer = store.actions.uploadAssetBundle(); await entered.promise
  store.actions.selectProject('two'); await until(store, state => state.activeProjectId === 'two')
  store.actions.updateBrief('goal', 'Keep the new project draft'); release.resolve(); await transfer
  assert.equal(projects.one.assets.length, 1); assert.equal(projects.two.assets.length, 0)
  assert.equal(store.getState().assetLibraries.one.assets.length, 1); assert.equal(store.getState().assetLibraries.two, undefined)
  assert.equal(store.getState().briefDrafts.two.goal, 'Keep the new project draft'); assert.equal(store.getState().assetWork.two, undefined)
  assert.equal(calls.filter(item => item.kind === 'library').at(-1).id, 'one')
})

test('a late failed cancellation during the successful library refresh cannot lock future uploads', async t => {
  const refreshing = deferred(), libraryRelease = deferred(), cancelRelease = deferred()
  let holdLibrary = true
  const { store, select, projects, action } = await client(t, { before: async (request, sessions) => {
    if (request.kind === 'library' && sessions.get(uploadId)?.status === 'completed' && holdLibrary) {
      refreshing.resolve(); await libraryRelease.promise
    }
    if (request.kind === 'cancel') { await cancelRelease.promise; throw Error('Late cancel response lost') }
  } })
  select(); const transfer = store.actions.uploadAssetBundle(); await refreshing.promise
  assert.equal(action('asset-cancel'), undefined, 'a committed upload is no longer offered for cancellation while the library refreshes')
  const cancel = store.actions.cancelAsset()
  await new Promise(resolve => setImmediate(resolve))
  holdLibrary = false; libraryRelease.resolve(); await transfer
  cancelRelease.resolve(); await cancel
  assert.equal(projects.one.assets.length, 1)
  assert.equal(store.getState().assetWork.one.bundleCleanup ?? false, false)
  select(); assert.equal(action('asset-bundle-upload').props.disabled, false)
  await store.actions.uploadAssetBundle()
  assert.equal(projects.one.assets.length, 2)
})

for (const loseCancel of [true, false]) test(`a Host-confirmed unavailable session releases retry state (initial cancel loss: ${loseCancel})`, async t => {
  let firstMember = true, cancelAttempts = 0
  const { store, select, action, calls, projects } = await client(t, {
    before: async request => {
      if (request.kind === 'file' && firstMember) { firstMember = false; throw Error('Member connection lost') }
      if (request.kind === 'cancel' && ++cancelAttempts === 1 && loseCancel) throw Error('Cancel response lost')
    },
    after: async (request, payload) => {
      if (request.kind === 'cancel') { payload.status = 'unavailable'; payload.reason = 'unknown-session' }
    },
  })
  select(); await store.actions.uploadAssetBundle()
  if (loseCancel) {
    assert.equal(store.getState().assetWork.one.bundleCleanup, true)
    assert.equal(action('asset-bundle-upload').props.disabled, true)
    const before = calls.length; await store.actions.uploadAssetBundle(); assert.equal(calls.length, before)
    await store.actions.cancelAsset()
  }
  assert.equal(store.getState().assetWork.one.bundleCleanup, false)
  const notice = store.getState().assetWork.one.message || store.getState().assetWork.one.error
  assert.match(notice, /无法继续|unavailable/i)
  assert.doesNotMatch(notice, /已取消|cancelled/i)
  select(); await store.actions.uploadAssetBundle()
  assert.equal(projects.one.assets.length, 1)
})

test('a successful HTTP response without a terminal or unavailable cancellation result cannot unlock the upload', async t => {
  let validCancel = false
  const { store, select, action } = await client(t, {
    before: async request => { if (request.kind === 'file') throw Error('Member response lost') },
    after: async (request, payload) => {
      if (request.kind === 'cancel' && !validCancel) { payload.status = 'receiving'; delete payload.reason }
    },
  })
  select(); await store.actions.uploadAssetBundle()
  assert.equal(store.getState().assetWork.one.bundleCleanup, true)
  assert.equal(action('asset-bundle-upload').props.disabled, true)
  validCancel = true; await store.actions.cancelAsset()
  assert.equal(store.getState().assetWork.one.bundleCleanup, false)
})

for (const current of ['single-file', 'preview']) test(`pending old bundle cleanup does not steal cancellation from the current ${current}`, async t => {
  const started = deferred(); let online = false
  const { store, select, projects, calls } = await client(t, { before: async request => {
    if (request.kind === 'file') throw Error('Bundle transfer failed')
    if (request.kind === 'cancel' && !online) throw Error('Cleanup connection lost')
    if (request.kind === current) {
      started.resolve(request.init.signal)
      await new Promise((resolve, reject) => request.init.signal.addEventListener('abort', () => reject(Error('Current operation aborted')), { once: true }))
    }
  } })
  select(); await store.actions.uploadAssetBundle(); online = true
  const asset = { id: 'existing-model', type: 'glb', path: `assets/raw/${'b'.repeat(64)}.glb`, sha256: 'b'.repeat(64) }
  projects.one.assets.push({ asset, originalName: 'existing.glb', bytes: 10, inspection: null })
  await store.actions.loadAssets()
  const work = current === 'single-file' ? chooseFiles(store, [file('new.glb', 10, false)], 'asset-upload') : store.actions.previewAsset(core.assetLibrary.key(asset))
  const signal = await started.promise
  const previousCancelCount = calls.filter(item => item.kind === 'cancel').length
  await store.actions.cancelAsset()
  try {
    assert.equal(signal.aborted, true)
    assert.equal(calls.filter(item => item.kind === 'cancel').length, previousCancelCount)
  } finally { if (!signal.aborted) store.stop(); await work }
  assert.equal(store.getState().assetWork.one.bundleCleanup, true)
  await store.actions.cancelAsset()
  assert.equal(store.getState().assetWork.one.bundleCleanup, false)
})


// A CPU event/DOM recorder: it records actual mountStandalone calls, not browser
// picker behavior. The native late-FileList counterexample is retained privately.
function pickerEnvironment() {
  const env = environment(readFileSync(new URL('../../../packages/deepblend/ui/lib/client.js', import.meta.url), 'utf8'))
  const walk = node => [node, ...(node.children || []).flatMap(walk)]
  const enhance = node => {
    node.getAttribute = key => node.attrs[key] ?? null
    Object.defineProperty(node, 'type', { get: () => node.attrs.type })
    Object.defineProperty(node, 'isConnected', { get: () => walk(env.root).includes(node) })
    node.contains = other => walk(node).includes(other)
    return node
  }
  const create = env.doc.createElement.bind(env.doc)
  env.doc.createElement = tag => enhance(create(tag)); enhance(env.root)
  env.inputs = () => walk(env.root).filter(node => node.type === 'file')
  env.input = field => env.inputs().find(node => node.attrs['data-field'] === field)
  return env
}

for (const name of ['brief-upload', 'asset-upload', 'asset-bundle-files', 'asset-bundle-directory']) test(`${name}: obsolete actual view handlers cannot read FileList or alter another selection context`, async t => {
  const { store, calls, projects, field } = await client(t)
  const view = name === 'brief-upload' ? 'projects' : 'scene'
  store.actions.setView(view)
  const original = field(name).props
  const ignored = async props => {
    const state = JSON.stringify(store.getState()), requests = calls.length
    let reads = 0
    await props.onChange({ target: { get files() { reads++; return files() }, value: 'old choice' } })
    const unread = { get [Symbol.iterator]() { throw Error('obsolete action read file handles') } }
    for (const source of [props['data-file-context'], undefined]) {
      if (name === 'brief-upload') await store.actions.uploadReferences(unread, source)
      else if (name === 'asset-upload') await store.actions.uploadAsset(unread, source)
      else store.actions.selectAssetBundle(unread, name === 'asset-bundle-directory' ? 'directory' : 'files', source)
    }
    assert.equal(reads, 0, 'old event must be rejected before reading FileList')
    assert.equal(JSON.stringify(store.getState()), state, 'no new draft, error or selection')
    assert.equal(calls.length, requests, 'no request from obsolete event')
  }
  store.actions.selectProject('two'); await until(store, s => s.activeProjectId === 'two' && s.selected?.scene)
  await store.actions.loadAssets(); await ignored(original)
  store.actions.selectProject('one'); await until(store, s => s.activeProjectId === 'one' && s.selected?.scene)
  await ignored(original) // A -> B -> A must not resurrect the first picker.
  const beforeView = field(name).props
  store.actions.setView('jobs'); store.actions.setView(view); await ignored(beforeView)
  const beforeRevision = field(name).props
  projects.one.revision = 'r0002'; store.actions.reload(); await until(store, s => s.selected?.scene?.revision === 'r0002'); await ignored(beforeRevision)
  const beforeStop = field(name).props; store.stop(); await ignored(beforeStop)
})

test('standalone holds a same-source picker across refresh/locale and releases once after input or cancel', async t => {
  const { store, field, env } = await client(t, { standalone: true }), dsh = dshLocale(env); t.after(dsh.dispose)
  const old = env.input('asset-bundle-directory'), handler = field('asset-bundle-directory').props.onChange
  env.root.emit('click', { isTrusted: true, target: old })
  const draws = env.root.draws, snapshot = store.getState()
  store.actions.reload(); await until(store, s => s !== snapshot)
  dsh.locale.setLocale('zh'); await flush()
  assert.equal(env.root.draws, draws, 'refresh and language update retain the connected picker')
  assert.equal(env.input('asset-bundle-directory'), old)
  env.doc.emit('input', { target: old }); handler({ target: { files: files(), value: 'selected' } })
  env.doc.emit('change', { target: old }); await flush()
  assert.equal(env.root.draws, draws + 1, 'input/change flush latest state exactly once')
  assert.equal(store.getState().assetBundleSelections.one.files.length, 3)
  const next = env.input('asset-bundle-directory'); env.root.emit('click', { isTrusted: true, target: next })
  const afterInput = env.root.draws
  store.actions.setAssetLicense('second choice'); assert.equal(env.root.draws, afterInput)
  env.doc.emit('cancel', { target: next }); env.doc.emit('change', { target: next }); await flush()
  assert.equal(env.root.draws, afterInput + 1)
  const last = env.input('asset-bundle-directory'), finalDraws = env.root.draws
  env.root.emit('click', { isTrusted: false, target: last }); store.actions.setAssetLicense('synthetic click')
  assert.equal(env.root.draws, finalDraws + 1, 'untrusted click never holds the view')
  const pending = env.input('asset-bundle-directory'); env.root.emit('click', { isTrusted: true, target: pending })
  store.actions.setAssetLicense('new picker'); env.doc.emit('cancel', { target: pending })
  env.root.emit('click', { isTrusted: true, target: pending }); await flush()
  assert.equal(env.root.draws, finalDraws + 1, 'a queued terminal cannot finish a newer picker on the same node')
  env.doc.emit('cancel', { target: pending }); await flush()
  assert.equal(env.root.draws, finalDraws + 2)
})

test('standalone invalidates on context/disabled changes and old terminals cannot release a new picker', async t => {
  const entered = deferred(), release = deferred()
  const { store, env, mounted, field, select } = await client(t, { standalone: true, before: async request => { if (request.kind === 'create') { entered.resolve(); await release.promise } } })
  t.after(() => release.resolve())
  const old = env.input('asset-bundle-directory'); env.root.emit('click', { isTrusted: true, target: old })
  const beforeSwitch = env.root.draws
  store.actions.selectProject('two'); await until(store, s => s.activeProjectId === 'two' && s.selected?.scene); await store.actions.loadAssets()
  assert.ok(env.root.draws > beforeSwitch, 'a different project is rendered immediately')
  const current = env.input('asset-bundle-directory'); env.root.emit('click', { isTrusted: true, target: current })
  const draws = env.root.draws; store.actions.setAssetLicense('new source')
  for (const type of ['input', 'change', 'cancel']) env.doc.emit(type, { target: old })
  await flush(); assert.equal(env.root.draws, draws, 'old node terminal cannot release current picker')
  env.doc.emit('cancel', { target: current }); await flush()
  select(); const disabledHandler = field('asset-bundle-directory').props.onChange
  const picker = env.input('asset-bundle-directory'); env.root.emit('click', { isTrusted: true, target: picker })
  const beforeBusy = env.root.draws, operation = store.actions.uploadAssetBundle(); await entered.promise
  assert.ok(env.root.draws > beforeBusy, 'busy change is visible without waiting for the picker')
  assert.equal(env.input('asset-bundle-directory').disabled, true)
  let reads = 0; const event = { target: { get files() { reads++; return files() } } }
  disabledHandler(event); assert.equal(reads, 0)
  release.resolve(); await operation
  disabledHandler(event); assert.equal(reads, 0, 'ending busy must not revive invalidated picker')
  const last = env.input('asset-bundle-directory'); env.root.emit('click', { isTrusted: true, target: last })
  store.actions.setAssetLicense('dispose pending'); env.doc.emit('input', { target: last })
  mounted.dispose(); const disposed = env.root.draws; await flush()
  assert.equal(env.root.draws, disposed, 'queued finish cannot draw after dispose')
  for (const type of ['input', 'change', 'cancel']) assert.equal(env.doc.listeners.get(type)?.size || 0, 0)
  assert.equal(env.root.listeners.get('click')?.size || 0, 0)
})


test('native upload shutdown accepts an observed macOS zombie while rejecting replacement and live residuals', async () => {
  const source = readFileSync(new URL('../e2e/asset-bundle-upload.e2e.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('async function waitForOwnedExit('), end = source.indexOf('\nfunction retainHome()', start)
  assert.ok(start >= 0 && end > start)
  const observe = new Function(`${source.slice(start, end)}; return waitForOwnedExit`)()
  const owner = { pid: 42, start: 'Mon Oct 5 09:59:43 2026', command: '/owned/worker', stat: 'S' }
  const run = current => {
    let time = 0
    return observe({ rows: [owner] }, { timeoutMs: 2, pollMs: 1, now: () => time,
      pause: async ms => { time += ms }, read: () => ({ rows: current ? [current] : [] }) })
  }
  const zombie = await run({ ...owner, stat: 'Z', command: '<defunct>' })
  assert.deepEqual(zombie.remaining, [])
  assert.deepEqual(zombie.errors, [])
  assert.equal(zombie.firstObservedAllExitedAt, 0)
  assert.equal((await run({ ...owner, start: 'later', stat: 'Z', command: '<defunct>' })).errors.length, 1)
  assert.equal((await run({ ...owner, command: '/replaced/live-worker' })).errors.length, 1)
  const fallback = await run({ ...owner, command: '(worker)' })
  assert.equal(fallback.remaining.length, 1, 'Darwin name fallback is still alive, never exit evidence')
  assert.deepEqual(fallback.errors, [])
  assert.equal(fallback.firstObservedAllExitedAt, null)
  let tick = 0
  const eventualExit = await observe({ rows: [owner] }, { timeoutMs: 2, pollMs: 1, now: () => tick,
    pause: async ms => { tick += ms }, read: () => ({ rows: tick ? [] : [{ ...owner, command: '(worker)' }] }) })
  assert.deepEqual(eventualExit.errors, [])
  assert.equal(eventualExit.lastObservedAliveAt, 0)
  assert.equal(eventualExit.firstObservedAllExitedAt, 1)
  assert.equal((await run({ ...owner, command: '(foreign-name)' })).errors.length, 1)
  assert.equal((await run({ ...owner, command: '/foreign/worker' })).errors.length, 1)
  const live = await run(owner)
  assert.equal(live.remaining.length, 1)
  assert.equal(live.firstObservedAllExitedAt, null)
})
