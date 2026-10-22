import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import yauzl from 'yauzl'
import { Context } from '@deepseek-ai/cordis'
import { PROJECT_RECORD_VERSION, sceneSpecDigest, specHash, sha256 } from '@deepblend/dsh-blender-contracts'
import BlenderUi, { assertSnapshotHttpRequest } from '@deepblend/dsh-blender-ui'
import { ProjectStore } from '../../../packages/deepblend/host/lib/project-store.js'
import { EditableSnapshots } from '../../../packages/deepblend/host/lib/editable-snapshots.js'
import { buildEditableSnapshotPlan } from '../../../packages/deepblend/host/lib/editable-snapshot-plan.js'
import { createEditableSnapshotArchive, openSnapshotFile, SnapshotArchiveError } from '../../../packages/deepblend/host/lib/editable-snapshot-archive.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytesFor = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const product = JSON.parse(await readFile(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const code = expected => error => error.code === expected
async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), typeof bytes === 'object' && !Buffer.isBuffer(bytes) ? bytesFor(bytes) : bytes)
}
async function fixture(t, options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'deepblend-editable-service-'))
  const projectsRoot = join(workspace, 'projects'), root = join(projectsRoot, 'demo')
  const store = new ProjectStore({ workspaceRoot: workspace, projectsRoot })
  const spec = structuredClone(product)
  spec.project.id = 'demo'; spec.assets = []
  const native = Buffer.alloc(options.nativeBytes ?? 1024 * 1024, 7)
  const writeRevision = async (revision = 'r0001') => {
    const specBytes = bytesFor(spec)
    await put(root, `revisions/${revision}/scene-spec.json`, specBytes)
    const manifest = { projectId: 'demo', revision, baseRevision: 'r0000', digest: sceneSpecDigest(spec), specHashAfter: specHash(spec),
      checkpoint: `revisions/${revision}/scene.blend`, checkpointBinding: { sourceDigest: sceneSpecDigest(spec), specHash: specHash(spec), bytes: native.length, sha256: hash(native) }, reviews: [] }
    await put(root, `revisions/${revision}/revision-manifest.json`, manifest)
    await put(root, `revisions/${revision}/validation.json`, { semantic: { ok: true }, technical: { ok: true } })
    await put(root, `revisions/${revision}/scene.blend`, native)
    return { manifest, specBytes }
  }
  await put(root, 'project.json', { schemaVersion: PROJECT_RECORD_VERSION, projectId: 'demo', currentRevision: 'r0001', revisionCount: 1, title: 'Snapshot fixture' })
  await writeRevision()
  const service = new EditableSnapshots(store, options.serviceOptions)
  t.after(async () => { await service.dispose(); await rm(workspace, { recursive: true, force: true }) })
  return { workspace, root, store, service, spec, native, writeRevision }
}
async function settle(service, result) {
  for (let count = 0; count < 2000; count++) {
    const status = await service.get({ projectId: result.projectId, exportId: result.exportId })
    if (status.state !== 'preparing') return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('snapshot did not settle')
}
async function rejectsPreparation(service, request, expected) {
  const status = await settle(service, await service.create(request))
  assert.equal(status.state, 'failed', JSON.stringify(status))
  assert.equal(status.error?.code, expected, JSON.stringify(status))
}
async function unpack(path) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true }), files = new Map()
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks = []
      for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk)
      files.set(entry.fileName, Buffer.concat(chunks))
    }
  } finally { zip.close() }
  return files
}

test('freezes one explicit revision, original metadata and native bytes; retry/download do not retarget current', async t => {
  const f = await fixture(t)
  await put(f.root, 'chat-history.json', { secret: 'never included' })
  await put(f.root, 'revisions/r0001/request.json', { prompt: 'not included' })
  const result = await f.service.create({ projectId: 'demo', requestId: 'fixed-one', revision: 'r0001', expectedStoreIdentity: f.service.storeIdentity })
  const status = await settle(f.service, result)
  assert.equal(status.state, 'ready', JSON.stringify(status))
  assert.equal(status.revision, 'r0001')
  assert.match(status.downloadUrl, new RegExp(`storeIdentity=${f.service.storeIdentity}$`))
  const files = await unpack(join(f.root, 'exports', status.exportId, 'snapshot.zip'))
  assert.deepEqual(files.get('revisions/r0001/scene.blend'), f.native)
  assert.deepEqual(files.get('revisions/r0001/scene-spec.json'), bytesFor(f.spec))
  assert.equal(files.has('chat-history.json'), false); assert.equal(files.has('revisions/r0001/request.json'), false)
  assert.match(files.get('README.md').toString(), /not a complete project history/)
  const manifest = JSON.parse(files.get('snapshot-manifest.json'))
  assert.equal(manifest.guarantees.fullSelfContainmentVerified, false)
  assert.equal(manifest.guarantees.nativePackedImagesInspected, false)
  const before = await readFile(join(f.root, 'exports', status.exportId, 'snapshot.zip'))
  await f.writeRevision('r0002')
  await put(f.root, 'project.json', { ...f.store.readRecord('demo'), currentRevision: 'r0002', revisionCount: 2 })
  const resumed = new EditableSnapshots(f.store)
  assert.equal((await resumed.create({ projectId: 'demo', requestId: 'fixed-one', revision: 'r0001' })).state, 'ready')
  await assert.rejects(resumed.create({ projectId: 'demo', requestId: 'fixed-one', revision: 'r0002' }), code('SNAPSHOT_REQUEST_CONFLICT'))
  await assert.rejects(resumed.create({ projectId: 'demo', requestId: 'other', revision: 'r0001', expectedStoreIdentity: '0'.repeat(64) }), code('SNAPSHOT_STORE_CHANGED'))
  const download = await resumed.open({ projectId: 'demo', exportId: status.exportId, expectedStoreIdentity: status.storeIdentity })
  const received = []; for await (const chunk of download.stream) received.push(chunk)
  await download.close()
  assert.deepEqual(Buffer.concat(received), before)
  assert.equal((await resumed.cancel({ projectId: 'demo', exportId: status.exportId })).state, 'ready')
  await resumed.dispose()
})

test('uses the selected asset versions, excludes only absent observation files and retains shared texture aliases', async t => {
  const f = await fixture(t), texture = Buffer.from('texture-original'), old = Buffer.from('old-unused-declaration')
  f.spec.assets = [
    { id: 'observation', type: 'png', path: 'assets/observation.png', sha256: hash('observation') },
    { id: 'shared-reference', type: 'png', path: 'assets/texture.png', sha256: hash(texture) },
    { id: 'texture', type: 'png', path: 'assets/texture.png', sha256: hash(texture), license: { source: 'declared' } },
    { id: 'old', type: 'png', path: 'assets/old.png', sha256: hash(old) },
  ]
  f.spec.project.referenceImages = [{ assetId: 'observation' }, { assetId: 'shared-reference' }]
  f.spec.materials[0].images = { baseColor: { assetId: 'texture' } }
  await put(f.root, 'assets/texture.png', texture); await put(f.root, 'assets/old.png', old)
  await put(f.root, 'assets/manifest.json', { schemaVersion: 'deepblend.assets/v1', versions: [
    { assetId: 'texture', path: 'assets/texture.png', sha256: hash(texture), bytes: texture.length, license: 'old-license', source: { kind: 'local', path: '/private/source.png' } },
  ], assets: [{ assetId: 'texture', path: 'assets/new.png', sha256: hash('new'), license: 'new-license' }] })
  await f.writeRevision()
  const ready = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'assets', revision: 'r0001' }))
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  const files = await unpack(join(f.root, 'exports', ready.exportId, 'snapshot.zip'))
  assert.equal(files.has('assets/observation.png'), false)
  assert.deepEqual(files.get('assets/texture.png'), texture)
  assert.deepEqual(files.get('assets/old.png'), old)
  assert.equal(files.has('assets/manifest.json'), false)
  const manifest = JSON.parse(files.get('snapshot-manifest.json'))
  assert.deepEqual(manifest.excludedObservationAssets.map(a => a.assetId), ['observation'])
  assert.deepEqual(manifest.sharedObservationAssets.map(a => a.assetId), ['shared-reference'])
  const licenses = files.get('licenses.json').toString()
  assert.match(licenses, /old-license/); assert.doesNotMatch(licenses, /new-license|\/private\/source/)
})

test('includes locked glTF dependencies and rejects unlocked dependencies or changed lock members', async t => {
  const f = await fixture(t), image = Buffer.from('locked-image'), model = bytesFor({ asset: { version: '2.0' }, images: [{ uri: 'texture.png' }] })
  const lockBytes = bytesFor({ schemaVersion: 'deepblend.asset-bundle/v1', format: 'gltf', entrypoint: 'model.gltf',
    files: [{ path: 'model.gltf', bytes: model.length, sha256: hash(model) }, { path: 'texture.png', bytes: image.length, sha256: hash(image) }], totalBytes: model.length + image.length })
  const prefix = `assets/bundles/${hash(lockBytes)}`
  for (const [name, bytes] of [['model.gltf', model], ['texture.png', image], ['.deepblend-lock.json', lockBytes]]) await put(f.root, `${prefix}/${name}`, bytes)
  f.spec.assets = [{ id: 'model', type: 'gltf', path: `${prefix}/model.gltf`, sha256: hash(model) }]
  await f.writeRevision()
  const ready = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'bundle', revision: 'r0001' }))
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  const files = await unpack(join(f.root, 'exports', ready.exportId, 'snapshot.zip'))
  assert.deepEqual(files.get(`${prefix}/texture.png`), image)
  await put(f.root, `${prefix}/texture.png`, 'changed')
  await rejectsPreparation(f.service, { projectId: 'demo', requestId: 'bundle-changed', revision: 'r0001' }, 'ASSET_HASH_MISMATCH')
  f.spec.assets[0].path = 'assets/model.gltf'
  await put(f.root, 'assets/model.gltf', model); await f.writeRevision()
  await rejectsPreparation(f.service, { projectId: 'demo', requestId: 'unlocked', revision: 'r0001' }, 'ASSET_REQUEST_INVALID')
})

test('native producer fallback requires the exact successful revision job; unknown or conflicting binding is refused', async t => {
  const f = await fixture(t), path = 'revisions/r0001/revision-manifest.json'
  const { manifest } = await f.writeRevision()
  delete manifest.checkpointBinding; manifest.jobId = 'compile-one'
  await put(f.root, path, manifest)
  const job = { jobId: 'compile-one', projectId: 'demo', revision: 'r0001', status: 'succeeded', action: 'compile_scene',
    artifacts: [{ kind: 'blend', path: 'revisions/r0001/scene.blend', bytes: f.native.length, sha256: hash(f.native) }] }
  await put(f.root, 'jobs/compile-one.json', job)
  assert.equal((await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'producer', revision: 'r0001' }))).state, 'ready')
  await put(f.root, 'jobs/compile-one.json', { ...job, revision: 'r0002' })
  await rejectsPreparation(f.service, { projectId: 'demo', requestId: 'bad-producer', revision: 'r0001' }, 'SNAPSHOT_NATIVE_CONFLICT')
  await f.writeRevision()
  const current = JSON.parse(await readFile(join(f.root, path))); current.checkpointBinding.specHash = hash('different')
  await put(f.root, path, current)
  await rejectsPreparation(f.service, { projectId: 'demo', requestId: 'bad-binding', revision: 'r0001' }, 'SNAPSHOT_NATIVE_CONFLICT')
})

test('selected video must match completed job, exact original spec/native and immutable encoded bytes', async t => {
  const f = await fixture(t), video = Buffer.from('selected-mp4'), videoPath = 'renders/render-0001/encoded/render-0001.mp4'
  const { specBytes } = await f.writeRevision()
  const delivery = { jobId: 'render-0001', projectId: 'demo', revisionId: 'r0001', source: {
    sceneSpecDigest: sceneSpecDigest(f.spec), sceneSpec: { bytes: specBytes.length, sha256: hash(specBytes) }, checkpoint: { bytes: f.native.length, sha256: hash(f.native) } },
    video: { bytes: video.length, sha256: hash(video), verified: true, path: 'output/final.mp4' } }
  const job = { jobId: 'render-0001', projectId: 'demo', revisionId: 'r0001', status: 'completed', sceneSpecDigest: sceneSpecDigest(f.spec), delivery: delivery.video }
  await put(f.root, videoPath, video); await put(f.root, 'renders/render-0001/job.json', job)
  await put(f.root, 'renders/render-0001/manifest.json', delivery); await put(f.root, 'output/final.mp4', 'newer-video')
  const ready = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'video', revision: 'r0001', videoJobId: 'render-0001' }))
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  assert.deepEqual((await unpack(join(f.root, 'exports', ready.exportId, 'snapshot.zip'))).get(videoPath), video)
  delivery.source.sceneSpec.sha256 = hash('another spec with same projected digest')
  await put(f.root, 'renders/render-0001/manifest.json', delivery)
  await rejectsPreparation(f.service, { projectId: 'demo', requestId: 'wrong-video', revision: 'r0001', videoJobId: 'render-0001' }, 'SNAPSHOT_VIDEO_CONFLICT')
})

test('cancel closes payloads, preserves only small failure evidence and repeats the same fixed plan', async t => {
  let cancelOnce = true
  const f = await fixture(t, { serviceOptions: { archive: async options => {
    const controller = new AbortController()
    return createEditableSnapshotArchive({ ...options, signal: AbortSignal.any([options.signal, controller.signal]), onProgress(p) {
      options.onProgress(p)
      if (cancelOnce && p.phase === 'writing' && p.writtenBytes > 200000) { cancelOnce = false; controller.abort() }
    } })
  } } })
  const request = { projectId: 'demo', requestId: 'cancel-retry', revision: 'r0001' }
  const cancelled = await settle(f.service, await f.service.create(request))
  assert.equal(cancelled.state, 'cancelled', JSON.stringify(cancelled))
  assert.equal(cancelled.partialPayloadRemoved, true)
  assert.deepEqual(await readdir(join(f.root, cancelled.failureDirectory)), ['failed.json'])
  const originalManifest = await readFile(join(f.root, 'revisions/r0001/revision-manifest.json'))
  await put(f.root, 'revisions/r0001/revision-manifest.json', { changedIndexAfterPlan: true })
  const ready = await settle(f.service, await f.service.create(request))
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
  assert.equal(ready.exportId, cancelled.exportId)
  const files = await unpack(join(f.root, 'exports', ready.exportId, 'snapshot.zip'))
  assert.deepEqual(files.get('revisions/r0001/revision-manifest.json'), originalManifest)
})

test('persisted status cannot override fixed request identity; sources/paths remain guarded', async t => {
  const f = await fixture(t, { serviceOptions: { archive: async () => { throw new SnapshotArchiveError('SNAPSHOT_IO', 'fixture failure') } } })
  const result = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'status', revision: 'r0001' }))
  const path = `export-requests/${result.exportId}/status.json`
  await put(f.root, path, { ...result, projectId: 'other-project' })
  await assert.rejects(f.service.get({ projectId: 'demo', exportId: result.exportId }), code('SNAPSHOT_METADATA_INVALID'))
  await assert.rejects(f.service.create({ projectId: 'demo', requestId: 'bad', revision: 'current' }), code('SNAPSHOT_REQUEST_INVALID'))
  await assert.rejects(f.service.get({ projectId: 'demo', exportId: '../escape' }), code('SNAPSHOT_REQUEST_INVALID'))
  await rm(join(f.root, 'revisions/r0001/scene.blend'))
  await put(f.root, 'inside-native', f.native); await symlink('../../inside-native', join(f.root, 'revisions/r0001/scene.blend'))
  await rejectsPreparation(f.service, { projectId: 'demo', requestId: 'symlink', revision: 'r0001' }, 'SNAPSHOT_PATH_INVALID')
})

test('download verifies same FD, withholds final bytes on replacement, cancels prehash, and permits archive sizes beyond 16 GiB', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(4 * 1024 ** 2, 3), path = 'download-fixture.zip'
  await put(f.root, path, bytes)
  const expected = { bytes: bytes.length, sha256: hash(bytes) }
  const download = await openSnapshotFile(f.root, path, expected)
  let received = 0, changed = false
  await assert.rejects(async () => {
    for await (const chunk of download.stream) {
      received += chunk.length
      if (!changed) { changed = true; const fd = await open(join(f.root, path), 'r+'); await fd.write(Buffer.from('x'), 0, 1, bytes.length - 1); await fd.close() }
    }
  }, code('SNAPSHOT_ARCHIVE_MISMATCH'))
  assert.ok(received < bytes.length)
  await download.close()
  await put(f.root, path, bytes)
  const controller = new AbortController(), opening = openSnapshotFile(f.root, path, expected, { signal: controller.signal })
  controller.abort()
  await assert.rejects(opening, code('SNAPSHOT_CANCELLED'))
  await assert.rejects(openSnapshotFile(f.root, path, { bytes: 17 * 1024 ** 3, sha256: expected.sha256 }), code('SNAPSHOT_ARCHIVE_MISMATCH'))
})

test('request-scoped owner lease blocks another process, recovers only a dead owner, and does not claim project revision lock', async t => {
  const f = await fixture(t)
  const storeUrl = new URL('../../../packages/deepblend/host/lib/project-store.js', import.meta.url).href
  const serviceUrl = new URL('../../../packages/deepblend/host/lib/editable-snapshots.js', import.meta.url).href
  const script = `import { ProjectStore } from ${JSON.stringify(storeUrl)}; import { EditableSnapshots } from ${JSON.stringify(serviceUrl)};
    const store = new ProjectStore(JSON.parse(process.env.SNAPSHOT_STORE));
    const service = new EditableSnapshots(store, {archive: async () => { await new Promise(() => {}) }});
    const result = await service.create({projectId:'demo', requestId:'cross-process', revision:'r0001'});
    process.send(result); setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...process.env, SNAPSHOT_STORE: JSON.stringify({ projectsRoot: f.store.projectsRoot, workspaceRoot: f.store.workspaceRoot }) } })
  t.after(() => child.kill('SIGKILL'))
  const [result] = await once(child, 'message')
  await assert.rejects(f.service.create({ projectId: 'demo', requestId: 'cross-process', revision: 'r0001' }), code('SNAPSHOT_BUSY'))
  assert.equal((await f.service.get({ projectId: 'demo', exportId: result.exportId })).state, 'preparing')
  await assert.rejects(f.service.cancel({ projectId: 'demo', exportId: result.exportId }), code('SNAPSHOT_BUSY'))
  let revisionWriterEntered = false
  await f.store.withProjectWrite('demo', () => { revisionWriterEntered = true })
  assert.equal(revisionWriterEntered, true)
  child.kill('SIGKILL'); await once(child, 'exit')
  assert.equal((await f.service.get({ projectId: 'demo', exportId: result.exportId })).error.code, 'SNAPSHOT_INTERRUPTED')
  const ready = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'cross-process', revision: 'r0001' }))
  assert.equal(ready.state, 'ready', JSON.stringify(ready))
})

test('unknown writer ownership fails closed and stopping one facade does not cancel another owner', async t => {
  const f = await fixture(t, { serviceOptions: { archive: async () => { throw new SnapshotArchiveError('SNAPSHOT_IO', 'fixture failure') } } })
  const result = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'unknown-owner', revision: 'r0001' }))
  const directory = join(f.store.projectDirectory('demo'), 'export-requests', result.exportId)
  await put(f.workspace, `.revision-writers/${sha256(directory)}/owner.json`, { pid: process.pid, token: 'unknown-host', hostname: 'not-this-host' })
  assert.equal((await f.service.get({ projectId: 'demo', exportId: result.exportId })).error.code, 'SNAPSHOT_OWNER_UNVERIFIED')
  await assert.rejects(f.service.create({ projectId: 'demo', requestId: 'unknown-owner', revision: 'r0001' }), code('SNAPSHOT_BUSY'))
  let release
  const owner = new EditableSnapshots(f.store, { archive: options => new Promise((resolve, reject) => {
    release = () => reject(new SnapshotArchiveError('SNAPSHOT_CANCELLED', 'fixture complete'))
    options.signal.addEventListener('abort', release, { once: true })
  }) })
  t.after(() => owner.dispose())
  const started = await owner.create({ projectId: 'demo', requestId: 'other-owner', revision: 'r0001' })
  await f.service.dispose()
  assert.equal((await owner.get({ projectId: 'demo', exportId: started.exportId })).state, 'preparing')
  assert.equal((await owner.cancel({ projectId: 'demo', exportId: started.exportId })).state, 'cancelled')
})

test('new HTTP surface enforces local Host/Origin/JSON boundaries and streams an attachment; ranges do not open files', async t => {
  const f = await fixture(t), ready = await settle(f.service, await f.service.create({ projectId: 'demo', requestId: 'http', revision: 'r0001' }))
  const allowed = (remoteAddress, host, extra = {}) => ({ method: 'POST', socket: { remoteAddress }, headers: { host, 'content-type': 'application/json', ...extra } })
  for (const request of [allowed('127.0.0.1', 'localhost:3210'), allowed('::1', '[::1]:3210'), allowed('::ffff:127.0.0.1', '127.0.0.1:3210'),
    allowed('::ffff:7f00:1', '127.0.0.1:3210'), allowed('127.0.0.2', '127.0.0.2:3210', { origin: 'http://127.0.0.2:3210', 'sec-fetch-site': 'same-origin' })]) assert.doesNotThrow(() => assertSnapshotHttpRequest(request))
  for (const request of [allowed('10.1.2.3', '127.0.0.1:3210'), allowed('127.0.0.1', 'rebind.example:3210'),
    allowed('127.0.0.1', 'localhost:3210', { origin: 'https://localhost:3210' }), allowed('127.0.0.1', 'localhost:3210', { origin: 'http://localhost:9999' }),
    allowed('127.0.0.1', 'localhost:3210', { 'sec-fetch-site': 'cross-site' }), allowed('127.0.0.1', 'localhost:3210', { 'content-type': 'text/plain' })])
    assert.throws(() => assertSnapshotHttpRequest(request), code('SNAPSHOT_LOCAL_ONLY'))
  let opened = 0
  const ctx = new Context()
  ctx.provide('blenderStudio', {
    openEditableSnapshot: request => { opened++; return f.service.open(request) }, getEditableSnapshot: request => f.service.get(request),
    exportEditableSnapshot: request => f.service.create(request), cancelEditableSnapshot: request => f.service.cancel(request),
  })
  const ui = new BlenderUi(ctx, { serveRoute: false }), server = createServer((request, response) => ui._handle(request, response))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`, url = `${base}${ready.downloadUrl}`
  const range = await fetch(url, { headers: { range: 'bytes=0-10' } })
  assert.equal(range.status, 416); assert.equal(opened, 0)
  const cross = await fetch(`${base}/deepblend/projects/demo/editable-snapshots`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'cross', revision: 'r0001' }) })
  assert.equal(cross.status, 403)
  const response = await fetch(url)
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /^attachment; filename="snapshot-/)
  assert.equal(response.headers.get('content-type'), 'application/zip')
  const received = Buffer.from(await response.arrayBuffer())
  assert.equal(received.length, ready.archive.bytes); assert.equal(hash(received), ready.archive.sha256)
  const stale = await fetch(url.replace(ready.storeIdentity, '0'.repeat(64)))
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.code, 'SNAPSHOT_STORE_CHANGED')
})

test('returns a durable planning handle before asset work; duplicate controls, cancel and dispose cover planning', async t => {
  let entered, calls = 0, block = true
  const began = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, { serviceOptions: { planner: async options => {
    calls++
    if (!block) return buildEditableSnapshotPlan(options)
    await put(options.store.projectDirectory('demo'), `${options.temporaryDirectory}/0.json`, { partial: true })
    entered()
    await new Promise((resolve, reject) => {
      const abort = () => reject(new SnapshotArchiveError('SNAPSHOT_CANCELLED', 'planning cancelled'))
      options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort()
    })
  } } })
  const request = { projectId: 'demo', requestId: 'planning-control', revision: 'r0001' }
  const first = await f.service.create(request)
  assert.equal(first.state, 'preparing'); assert.equal(first.phase, 'planning'); assert.equal(first.planFrozen, false)
  await began
  assert.equal((await f.service.create(request)).exportId, first.exportId); assert.equal(calls, 1)
  await assert.rejects(f.service.create({ ...request, revision: 'r0002' }), code('SNAPSHOT_REQUEST_CONFLICT'))
  const cancelled = await f.service.cancel({ projectId: 'demo', exportId: first.exportId })
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.planFrozen, false)
  const pendingFiles = await readdir(join(f.root, 'export-requests', first.exportId))
  assert.deepEqual(pendingFiles.sort(), ['request.json', 'status.json'])
  block = false
  const ready = await settle(f.service, await f.service.create(request))
  assert.equal(ready.state, 'ready'); assert.equal(ready.planFrozen, true); assert.equal(calls, 2)

  let disposalEntered
  const disposalStarted = new Promise(resolve => { disposalEntered = resolve })
  const stopping = new EditableSnapshots(f.store, { planner: async ({ signal }) => {
    disposalEntered()
    await new Promise((resolve, reject) => {
      const abort = () => reject(new SnapshotArchiveError('SNAPSHOT_CANCELLED', 'disposed planner'))
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  }, archive: () => assert.fail('disposed planning must not launch an archive') })
  const started = await stopping.create({ ...request, requestId: 'dispose-planning' })
  await disposalStarted; await stopping.dispose()
  assert.equal((await stopping.get({ projectId: 'demo', exportId: started.exportId })).state, 'cancelled')
})

test('acquiring a lease rereads a plan frozen by a previous owner; repeated review metadata is copied once', async t => {
  const f = await fixture(t)
  const path = 'revisions/r0001/visual-reviews/review.json'
  await put(f.root, path, { pass: true })
  const manifestPath = 'revisions/r0001/revision-manifest.json', manifest = JSON.parse(await readFile(join(f.root, manifestPath)))
  manifest.reviews = Array.from({ length: 20 }, () => ({ path }))
  await put(f.root, manifestPath, manifest)
  const request = { projectId: 'demo', requestId: 'stale-read', revision: 'r0001' }
  const ready = await settle(f.service, await f.service.create(request))
  const planPath = join(f.root, 'export-requests', ready.exportId, 'plan.json'), original = await readFile(planPath)
  const plan = JSON.parse(original)
  assert.equal(plan.files.filter(file => file.path === path).length, 1)
  assert.equal(plan.summary.sources.filter(file => file.path === path).length, 1)
  assert.ok(plan.generated.length < 10)
  const pending = JSON.parse(await readFile(join(f.root, 'export-requests', ready.exportId, 'request.json')))
  let replanned = 0, rearchived = 0, stale = true
  const resumed = new EditableSnapshots(f.store, { planner: () => { replanned++; assert.fail('must not replan') }, archive: () => { rearchived++; assert.fail('must not rearchive') } })
  const readPlan = resumed.readPlan.bind(resumed)
  resumed.readPlan = async (...args) => {
    if (stale) { stale = false; return { root: f.store.projectDirectory('demo'), plan: pending } }
    return readPlan(...args)
  }
  assert.equal((await settle(resumed, await resumed.create(request))).state, 'ready')
  await resumed.dispose()
  assert.equal(replanned, 0); assert.equal(rearchived, 0); assert.deepEqual(await readFile(planPath), original)
})

test('dependency parsing rejects pathname replacement after payload hash and honors locked implicit OBJ materials', async t => {
  const f = await fixture(t)
  const bundleUrl = new URL('../../../packages/deepblend/host/lib/asset-bundle.js', import.meta.url).href
  const verify = (asset, target, replacement, mode = 'replace') => {
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const root=process.argv[1], asset=JSON.parse(process.argv[2]), target=fs.realpathSync(process.argv[3]), replacement=process.argv[4], mode=process.argv[5];
      const opens=new Map(), open=fs.openSync, close=fs.closeSync, exists=fs.existsSync; let changed=false;
      fs.openSync=(path,...args)=>{const fd=open(path,...args);opens.set(fd,String(path));return fd};
      fs.closeSync=fd=>{const path=opens.get(fd);opens.delete(fd);close(fd);if(path===target&&!changed){changed=true;if(mode==='replace'){fs.renameSync(target,target+'.saved');fs.writeFileSync(target,Buffer.from(replacement,'base64'));}}};
      fs.existsSync=path=>mode==='implicit'&&changed&&String(path)===target?false:exists(path);
      syncBuiltinESMExports(); const {verifyAssetBundle}=await import(${JSON.stringify(bundleUrl)});
      try{verifyAssetBundle(root,asset,{verifyGraphBytes:true});console.log('UNSAFE_SUCCESS')}catch(error){console.log(error.code)}
      finally{if(changed&&mode==='replace'){fs.unlinkSync(target);fs.renameSync(target+'.saved',target)}}`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.root, JSON.stringify(asset), target, replacement.toString('base64'), mode], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim()
  }
  const gltf = bytesFor({ asset: { version: '2.0' }, images: [{ uri: 'missing.png' }] })
  const lock = bytesFor({ schemaVersion: 'deepblend.asset-bundle/v1', format: 'gltf', entrypoint: 'model.gltf', files: [{ path: 'model.gltf', bytes: gltf.length, sha256: hash(gltf) }], totalBytes: gltf.length })
  const prefix = `assets/bundles/${hash(lock)}`
  await put(f.root, `${prefix}/.deepblend-lock.json`, lock); await put(f.root, `${prefix}/model.gltf`, gltf)
  assert.equal(verify({ type: 'gltf', path: `${prefix}/model.gltf`, sha256: hash(gltf) }, join(f.root, prefix, 'model.gltf'), bytesFor({ asset: { version: '2.0' } })), 'ASSET_HASH_MISMATCH')
  const obj = Buffer.from('v 0 0 0\n'), mtl = Buffer.from('newmtl paint\nmap_Kd missing.png\n')
  const objLock = bytesFor({ schemaVersion: 'deepblend.asset-bundle/v1', format: 'obj', entrypoint: 'model.obj', files: [
    { path: 'model.obj', bytes: obj.length, sha256: hash(obj) }, { path: 'model.mtl', bytes: mtl.length, sha256: hash(mtl) }], totalBytes: obj.length + mtl.length })
  const objPrefix = `assets/bundles/${hash(objLock)}`
  for (const [name, bytes] of [['.deepblend-lock.json', objLock], ['model.obj', obj], ['model.mtl', mtl]]) await put(f.root, `${objPrefix}/${name}`, bytes)
  const asset = { type: 'obj', path: `${objPrefix}/model.obj`, sha256: hash(obj) }
  assert.equal(verify(asset, join(f.root, objPrefix, 'model.mtl'), Buffer.from('newmtl paint\n')), 'ASSET_HASH_MISMATCH')
  assert.equal(verify(asset, join(f.root, objPrefix, 'model.mtl'), Buffer.alloc(0), 'implicit'), 'ASSET_MISSING')
})
