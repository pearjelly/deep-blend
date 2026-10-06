/** Real bounded streams and resource ingestion; no Blender or browser. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { Readable, PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { encodePng } from '@deepblend/dsh-blender-contracts'
import { AssetUploadSessions, validateUploadManifest } from '../../../packages/deepblend/host/lib/asset-uploads.js'
import { writeAssetUploadFixtures } from '../lib/asset-upload-fixtures.mjs'
import { BUNDLE_LOCK, verifyAssetBundle } from '../../../packages/deepblend/host/lib/asset-bundle.js'

const image = value => encodePng({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 4 }, () => [value, 100, 150, 255]).flat()) })
const sourceFiles = (format = 'gltf', color = 30) => format === 'obj' ? {
  'models/cup.obj': Buffer.from('mtllib ../materials/cup.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl glaze\nf 1/1 2/2 3/3\n'),
  'materials/cup.mtl': Buffer.from('newmtl glaze\nmap_Kd "../textures/paint é.png"\n'),
  'textures/paint é.png': image(color),
} : {
  'models/cup.gltf': Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: '../data/mesh.bin', byteLength: 12 }], images: [{ uri: '../textures/paint%20%C3%A9.png' }], scenes: [{}], scene: 0 })),
  'data/mesh.bin': Buffer.alloc(12, 1), 'textures/paint é.png': image(color),
}
const manifestOf = (files, entrypoint = Object.keys(files)[0]) => ({ entrypoint, files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length })) })
const snapshot = directory => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).map(entry => [entry.name,
  entry.isDirectory() ? snapshot(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString('base64')]))

async function setup(t, maxBytes = 1024 * 1024) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-sessions-')), ctx = new Context()
  ctx.provide('blenderRuntime', {})
  const studio = new Studio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), assetMaxBytes: maxBytes, reconcileOnStart: false }))
  const { projectId } = await studio.createProject({ title: 'Bundles', saveCheckpoint: false })
  const project = studio.store.projectDirectory(projectId)
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const create = (files = sourceFiles(), extra = {}) => studio.createAssetUpload({ projectId, ...manifestOf(files), ...extra })
  const send = (session, file, bytes) => studio.uploadAssetFile({ projectId, uploadId: session.uploadId, fileId: file.id, stream: Readable.from([bytes]) })
  const upload = async (files = sourceFiles(), extra = {}) => {
    const session = await create(files, extra)
    for (const file of session.files) await send(session, file, files[file.path])
    return studio.completeAssetUpload({ projectId, uploadId: session.uploadId })
  }
  return { root, ctx, studio, projectId, project, create, send, upload }
}

for (const format of ['gltf', 'obj']) test(`${format} upload preserves nested original resources and only registers an unchecked library asset`, async t => {
  const { studio, projectId, project, upload } = await setup(t)
  const files = sourceFiles(format), before = snapshot(join(project, 'revisions'))
  files['unused/readme.txt'] = Buffer.from('not part of the model')
  const completed = await upload(files, { license: 'Author permission' }), receipt = completed.receipt
  assert.equal(completed.status, 'completed')
  assert.equal(receipt.originalName, `models/cup.${format}`)
  assert.deepEqual(receipt.unusedFiles, ['unused/readme.txt'])
  assert.equal(receipt.receivedBytes, Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0))
  const asset = receipt.asset, bundle = verifyAssetBundle(project, asset)
  assert.equal(bundle.entrypoint, `models/cup.${format}`)
  for (const member of bundle.files) assert.deepEqual(readFileSync(join(project, 'assets/bundles', receipt.bundle.sha256, member.path)), files[member.path])
  assert.equal(receipt.storedBytes, bundle.totalBytes + readFileSync(join(project, 'assets/bundles', receipt.bundle.sha256, BUNDLE_LOCK)).length)
  assert.deepEqual(snapshot(join(project, 'revisions')), before)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  const library = await studio.listAssets({ projectId })
  assert.equal(library.assets.length, 1)
  assert.equal(library.assets[0].declaredInRevision, false)
  assert.equal(library.assets[0].inspection, null)
  assert.deepEqual(library.assets[0].asset.license, { source: 'Author permission' })
  assert.equal(library.assets[0].bundle.files.length, Object.keys(files).length - 1)
  const internal = studio._bundleUploads.sessions.get(completed.uploadId)
  assert.equal(existsSync(internal.directory), false)
  assert.equal(JSON.stringify(completed).includes(internal.directory), false)
})

test('changing only a texture registers another immutable package and preserves the first scene and bytes', async t => {
  const { upload, project } = await setup(t)
  const first = (await upload(sourceFiles('gltf', 30))).receipt
  const preserved = snapshot(join(project, 'assets/bundles', first.bundle.sha256))
  const next = (await upload(sourceFiles('gltf', 220))).receipt
  assert.equal(first.asset.sha256, next.asset.sha256)
  assert.notEqual(first.asset.path, next.asset.path)
  assert.deepEqual(snapshot(join(project, 'assets/bundles', first.bundle.sha256)), preserved)
})

test('unsafe manifests and unknown session/member identities are refused before any file is written', async t => {
  const { studio, projectId, create, root } = await setup(t)
  const sessionRoot = join(root, 'projects/.asset-uploads')
  const badPaths = ['../cup.gltf', '/cup.gltf', 'a\\cup.gltf', 'a//cup.gltf', './cup.gltf', '.deepblend-lock.json',
    'materials/.DEEPBLEND-lock.json', 'NUL.png', 'a/CON', 'COM¹.txt', 'cup.gltf ', 'a./cup.gltf', 'C:cup.gltf', 'a\x7f.png']
  for (const path of badPaths) await assert.rejects(create({ 'cup.gltf': Buffer.from('{}'), [path]: Buffer.from('x') }), { code: 'ASSET_REQUEST_INVALID' })
  for (const names of [['cup.gltf', 'CUP.gltf'], ['cup.gltf', 'é.png', 'é.png'], ['cup.gltf', 'a', 'a/b.png'], ['cup.gltf', 'A/a.png', 'a/b.png']]) {
    await assert.rejects(create(Object.fromEntries(names.map(name => [name, Buffer.from('{}')]))), { code: 'ASSET_REQUEST_INVALID' })
  }
  await assert.rejects(studio.getAssetUpload({ projectId, uploadId: '../../escape' }), { code: 'ASSET_REQUEST_INVALID' })
  await assert.rejects(studio.uploadAssetFile({ projectId, uploadId: 'upload-00000000-0000-0000-0000-000000000000', fileId: 'file-0', stream: Readable.from(['bad']) }), { code: 'ASSET_REQUEST_INVALID' })
  assert.equal(existsSync(sessionRoot), false)
  const session = await create(), before = snapshot(sessionRoot)
  await assert.rejects(studio.uploadAssetFile({ projectId, uploadId: session.uploadId, fileId: '../../escape', stream: Readable.from(['bad']) }), { code: 'ASSET_REQUEST_INVALID' })
  assert.deepEqual(snapshot(sessionRoot), before)
})

test('literal percent names are retained and manifest budgets include unused files and safe integer sizes', async t => {
  const { create } = await setup(t, 100)
  await assert.rejects(create({ 'cup.gltf': Buffer.alloc(60), 'unused.bin': Buffer.alloc(41) }), { code: 'ASSET_TOO_LARGE' })
  for (const bytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateUploadManifest({ entrypoint: 'cup.gltf', files: [{ path: 'cup.gltf', bytes }] }, 100), { code: 'ASSET_REQUEST_INVALID' })
  }
  const valid = validateUploadManifest({ entrypoint: 'cup.gltf', files: [{ path: 'cup.gltf', bytes: 1 }, { path: '%2e%2e.bin', bytes: 0 }] }, 100)
  assert.equal(valid.files[1].path, '%2e%2e.bin')
  assert.throws(() => validateUploadManifest({ entrypoint: 'cup.gltf', files: Array.from({ length: 257 }, (_, index) => ({ path: `m${index}.gltf`, bytes: 1 })) }, 10000), { code: 'ASSET_REQUEST_INVALID' })
})

test('a repeated completed member verifies the original bytes and a different retry cannot overwrite it', async t => {
  const { studio, projectId, create, send, project } = await setup(t)
  const files = sourceFiles(), session = await create(files), file = session.files[0]
  const first = await send(session, file, files[file.path]), repeat = await send(session, file, files[file.path])
  assert.equal(repeat.receivedBytes, first.receivedBytes)
  assert.equal(repeat.transferredBytes, first.transferredBytes * 2)
  assert.equal(repeat.files[0].sha256, first.files[0].sha256)
  const altered = Buffer.from(files[file.path]); altered[0] ^= 1
  await assert.rejects(send(session, file, altered), { code: 'ASSET_HASH_MISMATCH' })
  assert.equal((await studio.getAssetUpload({ projectId, uploadId: session.uploadId })).status, 'failed')
  assert.equal(existsSync(studio._bundleUploads.sessions.get(session.uploadId).directory), false)
  assert.equal(existsSync(join(project, 'assets/manifest.json')), false)
})

test('actual streamed lengths reject excess and short files and remove the entire failed session', async t => {
  const { studio, create, send } = await setup(t, 100)
  for (const bytes of [Buffer.alloc(11), Buffer.alloc(9)]) {
    const session = await create({ 'cup.gltf': Buffer.alloc(10) })
    await assert.rejects(send(session, session.files[0], bytes), error => ['ASSET_TOO_LARGE', 'ASSET_CONTENT_MISMATCH'].includes(error.code))
    const internal = studio._bundleUploads.sessions.get(session.uploadId)
    assert.equal(internal.transferredBytes, bytes.length)
    assert.equal(existsSync(internal.directory), false)
  }
})

test('status reports real bytes during transfer; cancellation joins the writer and cleans all private partials', async t => {
  const { studio, projectId, create, project } = await setup(t)
  const session = await create({ 'cup.gltf': Buffer.alloc(100) }), stream = new PassThrough()
  const transfer = studio.uploadAssetFile({ projectId, uploadId: session.uploadId, fileId: 'file-0', stream })
  const rejected = assert.rejects(transfer)
  stream.write(Buffer.alloc(40))
  await new Promise(resolve => setImmediate(resolve))
  const status = await studio.getAssetUpload({ projectId, uploadId: session.uploadId })
  assert.equal(status.receivedBytes, 0); assert.equal(status.inFlightBytes, 40)
  await assert.rejects(studio.completeAssetUpload({ projectId, uploadId: session.uploadId }), { code: 'ASSET_REQUEST_INVALID' })
  const cancelled = await studio.cancelAssetUpload({ projectId, uploadId: session.uploadId })
  await rejected
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(existsSync(studio._bundleUploads.sessions.get(session.uploadId).directory), false)
  assert.equal(existsSync(join(project, 'assets/manifest.json')), false)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
})

test('completed receipt survives response loss, repetition, cancellation and a new Host instance', async t => {
  const { studio, ctx, projectId, project, root, upload } = await setup(t)
  const real = studio._ingestAsset.bind(studio)
  studio._ingestAsset = async (...args) => { await real(...args); throw Error('Response lost after manifest write') }
  const completed = await upload(), manifest = readFileSync(join(project, 'assets/manifest.json'))
  const request = { projectId, uploadId: completed.uploadId }
  assert.deepEqual((await studio.completeAssetUpload(request)).receipt, completed.receipt)
  assert.deepEqual((await studio.cancelAssetUpload(request)).receipt, completed.receipt)
  assert.deepEqual(readFileSync(join(project, 'assets/manifest.json')), manifest)
  const other = new Context(); other.provide('blenderRuntime', {})
  const restarted = new Studio(other, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  t.after(() => other.fiber.dispose())
  assert.deepEqual((await restarted.getAssetUpload(request)).receipt, completed.receipt)
  assert.deepEqual((await restarted.completeAssetUpload(request)).receipt, completed.receipt)
  assert.deepEqual(readFileSync(join(project, 'assets/manifest.json')), manifest)
  assert.equal(JSON.parse(manifest).versions.length, 1)
})

for (const cause of ['restart', 'terminal eviction']) test(`cancellation reports an unavailable session after ${cause} without touching another owner or active upload`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-unavailable-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = { root: join(root, 'sessions'), maxBytes: 1000, readProject() {}, published() { return null }, ingest() {} }
  let manager = new AssetUploadSessions(config)
  t.after(() => manager.dispose())
  const create = () => manager.create({ projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.from('{}') }) })
  const old = await create(), request = { projectId: 'p', uploadId: old.uploadId }
  await manager.cancel(request) // Its response is lost to the client.
  if (cause === 'restart') { await manager.dispose(); manager = new AssetUploadSessions(config) }
  else for (let i = 0; i < 32; i++) { const item = await create(); await manager.cancel({ projectId: 'p', uploadId: item.uploadId }) }
  const active = await create(), foreign = join(config.root, 'unknown-owner')
  mkdirSync(foreign); writeFileSync(join(foreign, 'keep'), 'Unrelated private data')
  const before = snapshot(config.root)
  const result = await manager.cancel(request)
  assert.deepEqual(result, { projectId: 'p', uploadId: old.uploadId, status: 'unavailable', reason: 'unknown-session' })
  assert.deepEqual(snapshot(config.root), before)
  assert.equal((await manager.get({ projectId: 'p', uploadId: active.uploadId })).status, 'receiving')
  await assert.rejects(manager.cancel({ projectId: 'other', uploadId: active.uploadId }), { code: 'ASSET_REQUEST_INVALID' })
  assert.deepEqual(snapshot(config.root), before)
  rmSync(foreign, { recursive: true })
})

test('only one active session is admitted and files cannot cross project ownership', async t => {
  const { studio, projectId, create } = await setup(t)
  const session = await create(), other = await studio.createProject({ title: 'Other', saveCheckpoint: false })
  await assert.rejects(studio.createAssetUpload({ projectId: other.projectId, ...manifestOf(sourceFiles()) }), error => error.detail.reason === 'upload-busy')
  await assert.rejects(studio.uploadAssetFile({ projectId: other.projectId, uploadId: session.uploadId, fileId: 'file-0', stream: Readable.from(['x']) }), { code: 'ASSET_REQUEST_INVALID' })
  await studio.cancelAssetUpload({ projectId, uploadId: session.uploadId })
  assert.equal((await studio.createAssetUpload({ projectId: other.projectId, ...manifestOf(sourceFiles()) })).status, 'receiving')
})

test('missing cross-directory dependencies and bundle-plus-lock overflow keep the original revision and no asset', async t => {
  const valid = sourceFiles(), maxBytes = Object.values(valid).reduce((sum, bytes) => sum + bytes.length, 0) + 32
  const { studio, projectId, project, upload } = await setup(t, maxBytes)
  const files = sourceFiles(); delete files['textures/paint é.png']
  await assert.rejects(upload(files), { code: 'ASSET_SOURCE_NOT_FOUND' })
  await assert.rejects(upload(valid), { code: 'ASSET_TOO_LARGE' })
  assert.equal(existsSync(join(project, 'assets/manifest.json')), false)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  assert.ok([...studio._bundleUploads.sessions.values()].every(session => !existsSync(session.directory)))
  assert.equal(readdirSync(join(project, 'assets/bundles')).some(name => name.startsWith('.incoming-')), false)
})

test('a hard deadline aborts a stalled stream and dispose cleans live sessions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-deadline-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = new AssetUploadSessions({ root: join(root, 'sessions'), maxBytes: 1000, readProject() {}, published() { return null }, ingest() {}, lifetimeMs: 25 })
  const session = await manager.create({ projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(100) }) })
  const stream = new PassThrough(), transfer = manager.put({ projectId: 'p', uploadId: session.uploadId, fileId: 'file-0', stream })
  const rejected = assert.rejects(transfer)
  stream.write(Buffer.alloc(5))
  await new Promise(resolve => setTimeout(resolve, 50)); await rejected
  assert.equal((await manager.get({ projectId: 'p', uploadId: session.uploadId })).status, 'expired')
  assert.equal(existsSync(manager.sessions.get(session.uploadId).directory), false)
  const another = await manager.create({ projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(1) }) })
  await manager.dispose()
  assert.equal(existsSync(manager.sessions.get(another.uploadId).directory), false)
})

test('cleanup removes confirmed dead owners but refuses live, foreign or unknown ownership without deleting it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-owner-')), sessionsRoot = join(root, 'sessions')
  mkdirSync(sessionsRoot)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [token, owner] of Object.entries({ dead: { pid: 2147483647, hostname: hostname() }, live: { pid: process.pid, hostname: hostname() }, foreign: { pid: 2147483647, hostname: 'other-host' }, unknown: {} })) {
    mkdirSync(join(sessionsRoot, token))
    writeFileSync(join(sessionsRoot, token, 'owner.json'), JSON.stringify({ schemaVersion: 'deepblend.upload-owner/v1', token, ...owner }))
  }
  const manager = new AssetUploadSessions({ root: sessionsRoot, maxBytes: 1000, readProject() {}, published() { return null }, ingest() {} })
  t.after(() => manager.dispose())
  await assert.rejects(manager.create({ projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(1) }) }), error => error.detail.reason === 'upload-host-busy')
  assert.equal(existsSync(join(sessionsRoot, 'dead')), false)
  for (const token of ['live', 'foreign', 'unknown']) assert.equal(existsSync(join(sessionsRoot, token)), true)
  for (const token of ['live', 'foreign', 'unknown']) rmSync(join(sessionsRoot, token), { recursive: true })
  assert.equal((await manager.create({ projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(1) }) })).status, 'receiving')
})

test('concurrent complete joins one ingestion; all private bundle copies stay inside the session', async t => {
  const { studio, projectId, project, create, send } = await setup(t)
  const files = sourceFiles(), session = await create(files)
  for (const file of session.files) await send(session, file, files[file.path])
  let calls = 0, release, entered
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  const realIngest = studio._ingestAsset.bind(studio), realWrite = studio.store.withProjectWrite.bind(studio.store)
  studio.store.withProjectWrite = (id, callback) => {
    const directory = studio._bundleUploads.sessions.get(session.uploadId).directory
    assert.ok(readdirSync(directory).some(name => name.startsWith('.bundle-')))
    assert.equal(readdirSync(join(project, 'assets/bundles')).some(name => name.startsWith('.incoming-')), false)
    assert.equal(readdirSync(join(project, 'assets/raw')).some(name => name.startsWith('.incoming-')), false)
    return realWrite(id, callback)
  }
  studio._ingestAsset = async (...args) => { calls++; entered(); await gate; return realIngest(...args) }
  const request = { projectId, uploadId: session.uploadId }, first = studio.completeAssetUpload(request)
  await ready
  const second = studio.completeAssetUpload(request)
  await assert.rejects(send(session, session.files[0], files[session.files[0].path]), error => error.detail.reason === 'upload-busy')
  release()
  assert.deepEqual((await first).receipt, (await second).receipt)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(readFileSync(join(project, 'assets/manifest.json'))).versions.length, 1)
})

test('cancellation waits for completion work before cleanup and admission of another session', async t => {
  const { studio, projectId, project, create, send } = await setup(t)
  const files = sourceFiles(), session = await create(files)
  for (const file of session.files) await send(session, file, files[file.path])
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  const real = studio._ingestAsset.bind(studio)
  studio._ingestAsset = async (...args) => { entered(); await gate; return real(...args) }
  const transfer = studio.completeAssetUpload({ projectId, uploadId: session.uploadId }), rejected = assert.rejects(transfer)
  await ready
  const cancel = studio.cancelAssetUpload({ projectId, uploadId: session.uploadId })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(studio._bundleUploads.sessions.get(session.uploadId).status, 'cancelled')
  let admitted = false
  const next = create().then(value => { admitted = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(admitted, false)
  assert.equal(existsSync(studio._bundleUploads.sessions.get(session.uploadId).directory), true)
  release(); await rejected; await cancel
  const another = await next
  assert.equal(another.status, 'receiving')
  assert.equal(existsSync(studio._bundleUploads.sessions.get(session.uploadId).directory), false)
  assert.equal(existsSync(join(project, 'assets/manifest.json')), false)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
})

test('abort immediately before atomic publication removes staged bytes, while cancellation after publication returns the asset', async t => {
  const { studio, projectId, project, create, send } = await setup(t)
  const realWrite = studio.store.withProjectWrite.bind(studio.store), files = sourceFiles()
  const first = await create(files), controller = new AbortController()
  for (const file of first.files) await send(first, file, files[file.path])
  studio.store.withProjectWrite = (id, callback) => { controller.abort(); return realWrite(id, callback) }
  await assert.rejects(studio.completeAssetUpload({ projectId, uploadId: first.uploadId, signal: controller.signal }))
  assert.equal(existsSync(join(project, 'assets/manifest.json')), false)
  assert.deepEqual(readdirSync(join(project, 'assets/bundles')), [])
  studio.store.withProjectWrite = realWrite
  const second = await create(files)
  for (const file of second.files) await send(second, file, files[file.path])
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { entered = resolve })
  const real = studio._ingestAsset.bind(studio)
  studio._ingestAsset = async (...args) => { const result = await real(...args); entered(); await gate; return result }
  const transfer = studio.completeAssetUpload({ projectId, uploadId: second.uploadId })
  await ready
  const cancelled = await studio.cancelAssetUpload({ projectId, uploadId: second.uploadId })
  assert.equal(cancelled.status, 'completed')
  assert.equal(existsSync(join(project, cancelled.receipt.asset.path)), true)
  release(); assert.deepEqual((await transfer).receipt, cancelled.receipt)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
})

test('two managers sharing a projects root cannot each reserve a full budget', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-shared-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = { root, maxBytes: 100, readProject() {}, published() { return null }, ingest() {} }
  const one = new AssetUploadSessions(options), two = new AssetUploadSessions(options)
  t.after(async () => { await one.dispose(); await two.dispose() })
  const request = { projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(100) }) }
  const first = await one.create(request)
  await assert.rejects(two.create(request), error => error.detail.reason === 'upload-host-busy')
  await one.cancel({ projectId: 'p', uploadId: first.uploadId })
  assert.equal((await two.create(request)).status, 'receiving')
})

test('an oversized member is stopped while its source is still open, before the whole session budget is consumed', async t => {
  const { studio, projectId, create } = await setup(t, 1000)
  const session = await create({ 'cup.gltf': Buffer.alloc(10) }), stream = new PassThrough()
  const transfer = studio.uploadAssetFile({ projectId, uploadId: session.uploadId, fileId: 'file-0', stream })
  const observed = transfer.then(() => null, error => error)
  stream.write(Buffer.alloc(11))
  let timer
  try {
    const error = await Promise.race([observed, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error('The oversized stream kept reading beyond its declared member limit')), 500) })])
    assert.equal(error?.code, 'ASSET_TOO_LARGE')
    assert.equal(existsSync(studio._bundleUploads.sessions.get(session.uploadId).directory), false)
  } finally { clearTimeout(timer); stream.destroy(); await observed }
})

test('a disconnected member request is classified as cancelled and releases storage before explicit cancel retries', async t => {
  const { studio, projectId, create } = await setup(t)
  const session = await create({ 'cup.gltf': Buffer.alloc(100) }), stream = new PassThrough(), controller = new AbortController()
  const transfer = studio.uploadAssetFile({ projectId, uploadId: session.uploadId, fileId: 'file-0', stream, signal: controller.signal })
  const rejected = assert.rejects(transfer)
  stream.write(Buffer.alloc(4)); await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected
  assert.equal((await studio.getAssetUpload({ projectId, uploadId: session.uploadId })).status, 'cancelled')
  assert.equal((await studio.cancelAssetUpload({ projectId, uploadId: session.uploadId })).status, 'cancelled')
  assert.equal(existsSync(studio._bundleUploads.sessions.get(session.uploadId).directory), false)
})

test('a ledger failure after atomic publication cleans private work and keeps immutable bytes reusable without claiming registration', async t => {
  const { studio, projectId, project, upload } = await setup(t)
  // A directory at the ledger path deterministically refuses its atomic file
  // replacement, after the existing ingest has published content-addressed bytes.
  mkdirSync(join(project, 'assets/manifest.json'), { recursive: true })
  await assert.rejects(upload())
  const session = [...studio._bundleUploads.sessions.values()][0]
  assert.equal(session.status, 'failed'); assert.equal(existsSync(session.directory), false)
  assert.equal((await studio.listAssets({ projectId })).assets.length, 0)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  const content = snapshot(join(project, 'assets/bundles'))
  assert.equal(Object.keys(content).length, 1)
  rmSync(join(project, 'assets/manifest.json'), { recursive: true })
  const completed = await upload()
  assert.equal(completed.status, 'completed')
  assert.deepEqual(snapshot(join(project, 'assets/bundles')), content)
  assert.equal((await studio.listAssets({ projectId })).assets.length, 1)
})

for (const failure of ['owner-write', 'members-mkdir', 'partial-mkdir']) test(`initialization ${failure} failure removes only new owned paths and allows the next upload`, async t => {
  const fs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module')
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-init-')), sessionsRoot = join(root, 'sessions')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = new AssetUploadSessions({ root: sessionsRoot, maxBytes: 1000, readProject() {}, published() { return null }, ingest() {} })
  t.after(() => manager.dispose())
  const request = { projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(10) }) }
  const memberName = failure.split('-')[0], operation = failure === 'owner-write' ? 'writeFileSync' : 'mkdirSync'
  const original = fs.default[operation], writeOriginal = fs.default.writeFileSync
  let injected = false
  fs.default[operation] = function (path, ...args) {
    if (!injected && String(path).startsWith(sessionsRoot) && String(path).endsWith(failure === 'owner-write' ? '/owner.json' : `/${memberName}`)) {
      injected = true
      if (failure === 'owner-write') writeOriginal(path, '{"schemaVersion":', { flag: 'wx' }) // Simulate a partial write.
      throw Object.assign(Error(`Injected ${failure}`), { code: failure === 'owner-write' ? 'ENOSPC' : 'EIO' })
    }
    return original.call(this, path, ...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(manager.create(request), error => error.message === `Injected ${failure}`) }
  finally { fs.default[operation] = original; syncBuiltinESMExports() }
  assert.equal(injected, true)
  assert.deepEqual(readdirSync(sessionsRoot), [])
  assert.equal(manager.sessions.size, 0)
  const next = await manager.create(request)
  assert.equal(next.status, 'receiving')
  await manager.cancel({ projectId: 'p', uploadId: next.uploadId })
  assert.deepEqual(readdirSync(sessionsRoot), [])
  // An unrelated, previously unknown owner remains protected after recovery.
  mkdirSync(join(sessionsRoot, 'unknown-existing'))
  writeFileSync(join(sessionsRoot, 'unknown-existing/keep.txt'), 'preserve existing data')
  await assert.rejects(manager.create(request), error => error.detail.reason === 'upload-host-busy')
  assert.equal(readFileSync(join(sessionsRoot, 'unknown-existing/keep.txt'), 'utf8'), 'preserve existing data')
})

for (const scenario of ['foreign-owner-write', 'foreign-parent-on-mkdir', 'existing-session-directory']) test(`initialization rollback preserves ${scenario} and refuses to adopt it`, async t => {
  const fs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module')
  const root = mkdtempSync(join(tmpdir(), 'deepblend-upload-init-foreign-')), sessionsRoot = join(root, 'sessions')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = new AssetUploadSessions({ root: sessionsRoot, maxBytes: 1000, readProject() {}, published() { return null }, ingest() {} })
  const request = { projectId: 'p', ...manifestOf({ 'cup.gltf': Buffer.alloc(10) }) }
  const operation = scenario === 'foreign-owner-write' ? 'writeFileSync' : 'mkdirSync'
  const original = fs.default[operation], writeOriginal = fs.default.writeFileSync, mkdirOriginal = fs.default.mkdirSync
  let preserved, injected = false
  fs.default[operation] = function (path, ...args) {
    const text = String(path), matches = scenario === 'foreign-owner-write' ? text.endsWith('/owner.json')
      : scenario === 'foreign-parent-on-mkdir' ? text.endsWith('/members') : /\/upload-[^/]+$/.test(text)
    if (!injected && text.startsWith(sessionsRoot) && matches) {
      injected = true
      if (scenario === 'foreign-owner-write') {
        preserved = text; writeOriginal(preserved, '{"token":"foreign-owner"}')
      } else if (scenario === 'foreign-parent-on-mkdir') {
        writeOriginal(join(dirname(dirname(text)), 'owner.json'), '{"token":"foreign-owner"}')
        preserved = join(dirname(text), 'foreign.txt'); writeOriginal(preserved, 'existing unrelated session data')
      } else {
        mkdirOriginal(path); preserved = join(path, 'foreign.txt'); writeOriginal(preserved, 'existing unrelated session data')
      }
      throw Object.assign(Error('Injected foreign ownership'), { code: 'EIO' })
    }
    return original.call(this, path, ...args)
  }
  syncBuiltinESMExports()
  try { await assert.rejects(manager.create(request), /Injected foreign ownership/) }
  finally { fs.default[operation] = original; syncBuiltinESMExports() }
  assert.equal(injected, true)
  const before = snapshot(sessionsRoot)
  await assert.rejects(manager.create(request), error => error.detail.reason === 'upload-host-busy')
  await manager.dispose()
  assert.deepEqual(snapshot(sessionsRoot), before)
  assert.equal(readFileSync(preserved, 'utf8'), scenario !== 'foreign-owner-write' ? 'existing unrelated session data' : '{"token":"foreign-owner"}')
})


for (const fixture of ['gltf-first', 'obj', 'glb', 'flat']) test(`browser ${fixture} fixture ingests its real bytes and dependency closure without a renderer`, async t => {
  const w = await setup(t, 10 * 1024 * 1024)
  const sources = join(w.root, 'browser-fixtures')
  const entrypoints = writeAssetUploadFixtures(sources)
  const folder = join(sources, fixture)
  const files = Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const path = join(entry.parentPath ?? entry.path, entry.name)
      return [path.slice(folder.length + 1).split('\\').join('/'), readFileSync(path)]
    }))
  const before = snapshot(join(w.project, 'revisions'))
  const result = await w.upload(files, { entrypoint: entrypoints[fixture] })
  const bundle = verifyAssetBundle(w.project, result.receipt.asset)
  assert.equal(result.status, 'completed')
  assert.equal(bundle.entrypoint, entrypoints[fixture])
  assert.equal(result.receipt.asset.type, fixture === 'obj' ? 'obj' : fixture === 'glb' ? 'glb' : 'gltf')
  assert.equal(bundle.files.length, fixture === 'glb' ? 2 : 3)
  for (const member of bundle.files) assert.deepEqual(readFileSync(join(w.project, 'assets/bundles', result.receipt.bundle.sha256, member.path)), files[member.path])
  if (fixture === 'glb') {
    const glb = files[entrypoints[fixture]], jsonLength = glb.readUInt32LE(12)
    assert.equal(glb.toString('ascii', 0, 4), 'glTF')
    assert.equal(glb.readUInt32LE(8), glb.length)
    const doc = JSON.parse(glb.subarray(20, 20 + jsonLength).toString())
    assert.equal(doc.images[0].uri, '../textures/%E9%87%89%20%E8%89%B2.png')
    assert.equal(doc.bufferViews.length, 4)
    assert.equal(doc.buffers[0].uri, undefined)
    assert.equal(glb.readUInt32LE(24 + jsonLength), 0x004e4942)
  }
  assert.deepEqual(snapshot(join(w.project, 'revisions')), before)
  assert.equal((await w.studio.listAssets({ projectId: w.projectId })).assets[0].inspection, null)
})
