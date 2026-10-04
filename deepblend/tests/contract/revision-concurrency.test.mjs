/** Real Host/store/transactions, controlled asynchronous compiler and real Node writers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { sceneSpecDigest, sha256 } from '@deepblend/dsh-blender-contracts'

const childPath = fileURLToPath(new URL('../lib/revision-writer-child.mjs', import.meta.url))
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url), 'utf8'))
const patch = (projectId, baseRevision, lens, extra = {}) => ({ projectId, baseRevision,
  operations: [{ op: 'camera.update', cameraId: 'camera-main', lens }], ...extra })
const capture = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))

function harness(t) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-revision-writers-'))
  const calls = []
  const runtime = {
    async compileScene(request) {
      const spec = readFileSync(request.sceneSpecPath, 'utf8')
      const outcome = await new Promise(resolve => calls.push({ request, spec, finish: resolve }))
      if (outcome instanceof Error) throw outcome
      const directory = mkdtempSync(join(request.projectRoot, 'test-compiler-'))
      try {
        writeFileSync(join(directory, 'result.blend'), spec)
        request.onWorkingDirectory({ directory })
        return { report: { validation: { ok: true }, sceneFingerprint: { totalPolygons: 12 }, objects: outcome ?? [] }, envelope: {} }
      } finally { rmSync(directory, { recursive: true, force: true }) }
    },
  }
  const makeHost = () => {
    const ctx = new Context()
    ctx.provide('blenderRuntime', runtime)
    return new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'), reconcileOnStart: false }))
  }
  const studio = makeHost()
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }))
  const create = projectId => studio.createProject({ projectId, title: projectId, sceneSpec: fixture, saveCheckpoint: false })
  return { workspaceRoot, calls, studio, makeHost, create }
}

function child(t, args) {
  const process = fork(childPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = []
  const waiters = []
  let stderr = ''
  process.stderr.on('data', chunk => { stderr += chunk })
  process.on('message', message => {
    const index = waiters.findIndex(waiter => waiter.type === message.type)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
    else messages.push(message)
  })
  const exited = new Promise(resolve => process.once('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child exited ${code}/${signal}: ${stderr}`))
    resolve({ code, signal })
  }))
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL')
    await exited
  })
  return { process, exited, next(type) {
    const index = messages.findIndex(message => message.type === type)
    return index >= 0 ? Promise.resolve(messages.splice(index, 1)[0])
      : new Promise((resolve, reject) => waiters.push({ type, resolve, reject }))
  } }
}

test('overlapping async Host patches keep one spec, checkpoint and manifest together', async t => {
  const h = harness(t)
  await h.create('race')
  const first = capture(h.studio.applyScenePatch(patch('race', 'r0001', 40)))
  const second = capture(h.makeHost().applyScenePatch(patch('race', 'r0001', 50)))
  // Both promises are observed even if this assertion fails, so the test has no
  // unhandled rejection. Finish every compiler before inspecting the outcome.
  const started = h.calls.length
  for (const call of h.calls) call.finish()
  const [winner, loser] = await Promise.all([first, second])
  assert.equal(started, 1)
  assert.equal(winner.ok, true)
  assert.equal(loser.error?.code, 'REVISION_CONFLICT')
  const spec = h.studio.store.readRevisionSpec('race', 'r0002')
  const manifest = h.studio.store.readRevisionManifest('race', 'r0002')
  assert.equal(spec.cameras.find(camera => camera.id === 'camera-main').lens, 40)
  assert.equal(manifest.digest, sceneSpecDigest(spec))
  assert.equal(readFileSync(h.studio.store.checkpointPath('race', 'r0002'), 'utf8'), h.calls[0].spec)
  assert.deepEqual(h.studio.store.listRevisions('race'), ['r0001', 'r0002'])
  assert.deepEqual(readdirSync(join(h.studio.store.projectDirectory('race'), 'staging')), [])
  assert.match(dirname(h.calls[0].request.sceneSpecPath), /r0002-[0-9a-f-]{36}$/)
})

test('restore and staging sweep cannot intervene during an async patch', async t => {
  const h = harness(t)
  await h.create('restore')
  await h.studio.applyScenePatch(patch('restore', 'r0001', 45, { saveCheckpoint: false }))
  const pending = capture(h.studio.applyScenePatch(patch('restore', 'r0002', 50)))
  const blocked = await capture(h.makeHost().restoreRevision({ projectId: 'restore', revision: 'r0001' }))
  assert.equal(blocked.error?.code, 'REVISION_CONFLICT')
  assert.throws(() => h.makeHost().transactions.sweepStaging('restore'), { code: 'REVISION_CONFLICT' })
  assert.equal(existsSync(h.calls[0].request.sceneSpecPath), true)
  h.calls[0].finish()
  assert.equal((await pending).ok, true)
  const restored = await h.studio.restoreRevision({ projectId: 'restore', revision: 'r0001' })
  assert.equal(restored.from, 'r0003')
  await assert.rejects(h.studio.applyScenePatch(patch('restore', 'r0003', 60)), { code: 'REVISION_CONFLICT' })
  assert.equal(h.studio.store.currentRevision('restore'), 'r0001')
})

test('failed compile releases the writer and cannot remove the next candidate staging', async t => {
  const h = harness(t)
  await h.create('failed')
  const failed = capture(h.studio.applyScenePatch(patch('failed', 'r0001', 40)))
  const blocked = await capture(h.studio.applyScenePatch(patch('failed', 'r0001', 50)))
  assert.equal(blocked.error?.code, 'REVISION_CONFLICT')
  h.calls[0].finish(new Error('intentional compiler failure'))
  assert.equal((await failed).error?.code, 'BLENDER_SCRIPT_ERROR')
  assert.equal(h.studio.store.currentRevision('failed'), 'r0001')
  const retry = capture(h.studio.applyScenePatch(patch('failed', 'r0001', 50)))
  assert.notEqual(h.calls[0].request.sceneSpecPath, h.calls[1].request.sceneSpecPath)
  assert.equal(existsSync(h.calls[0].request.sceneSpecPath), false)
  assert.equal(existsSync(h.calls[1].request.sceneSpecPath), true)
  h.calls[1].finish()
  assert.equal((await retry).ok, true)
})

test('conditional restore refuses a stale editor and preserves later work and history', async t => {
  const h = harness(t)
  await h.create('conditional-restore')
  await h.studio.applyScenePatch(patch('conditional-restore', 'r0001', 45, { saveCheckpoint: false }))
  const before = h.studio.store.readRecord('conditional-restore')
  const later = h.studio.store.readRevisionSpec('conditional-restore', 'r0002')
  await assert.rejects(h.studio.restoreRevision({ projectId: 'conditional-restore', revision: 'r0001',
    expectedCurrentRevision: 'r0001' }), error => error.code === 'REVISION_CONFLICT' &&
      error.detail.currentRevision === 'r0002' && error.detail.expectedCurrentRevision === 'r0001')
  assert.deepEqual(h.studio.store.readRecord('conditional-restore'), before)
  const restored = await h.studio.restoreRevision({ projectId: 'conditional-restore', revision: 'r0001',
    expectedCurrentRevision: 'r0002' })
  assert.equal(restored.from, 'r0002')
  assert.equal(h.studio.store.currentRevision('conditional-restore'), 'r0001')
  assert.deepEqual(h.studio.store.listRevisions('conditional-restore'), ['r0001', 'r0002'])
  assert.deepEqual(h.studio.store.readRevisionSpec('conditional-restore', 'r0002'), later)
  assert.equal(h.studio.store.readRecord('conditional-restore').restorations.length, 1)
})

test('publication rechecks the persistent record, including restore away and back', async t => {
  const h = harness(t)
  await h.create('changed')
  const record = h.studio.store.readRecord('changed')
  const pending = capture(h.studio.applyScenePatch(patch('changed', 'r0001', 40)))
  // Simulate an uncoordinated external editor. The pointer is unchanged, but a
  // restore away and back has changed the persistent history during compilation.
  const external = { ...record, restorations: [{ from: 'r0001', to: 'r0000' }, { from: 'r0000', to: 'r0001' }] }
  h.studio.store.writeRecord('changed', external)
  h.calls[0].finish()
  assert.equal((await pending).error?.code, 'REVISION_CONFLICT')
  assert.deepEqual(h.studio.store.readRecord('changed'), external)
  assert.deepEqual(h.studio.store.listRevisions('changed'), ['r0001'])
  assert.deepEqual(readdirSync(join(h.studio.store.projectDirectory('changed'), 'staging')), [])
  const recovered = await h.studio.applyScenePatch(patch('changed', 'r0001', 55, { saveCheckpoint: false }))
  assert.equal(recovered.revision, 'r0002')
})

test('different projects compile concurrently and preserve their own asset part reports', async t => {
  const h = harness(t)
  await h.create('one'); await h.create('two')
  const one = capture(h.studio.applyScenePatch(patch('one', 'r0001', 40)))
  const two = capture(h.studio.applyScenePatch(patch('two', 'r0001', 50)))
  assert.equal(h.calls.length, 2)
  const materialSlots = [{ index: 0, materialName: 'steel', materialId: 'body' }]
  h.calls[0].finish([{ type: 'MESH', deepblendId: 'watch', partId: 'case', parentPartId: 'assembly', materialSlots }, { type: 'EMPTY', partId: 'root' }])
  h.calls[1].finish()
  assert.equal((await one).ok, true); assert.equal((await two).ok, true)
  assert.deepEqual(h.studio.store.readRevisionManifest('one', 'r0002').assetParts,
    [{ entityId: 'watch', partId: 'case', parentPartId: 'assembly', sourceMaterialSlots: [], materialSlots }])
  assert.deepEqual(h.studio.store.readRevisionManifest('two', 'r0002').assetParts, [])
})

test('compiled part inventory preserves source and effective slots; uncompiled revisions expose no stale inventory', async t => {
  const h = harness(t)
  await h.create('inventory')
  const sourcePath = join(h.workspaceRoot, 'assembly.obj')
  writeFileSync(sourcePath, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
  const ingested = await h.studio.ingestAsset({ projectId: 'inventory', sourcePath, assetId: 'assembly-source' })
  const pending = capture(h.studio.applyScenePatch({ projectId: 'inventory', baseRevision: 'r0001', operations: [
    { op: 'asset.add', asset: { id: ingested.assetId, type: ingested.type, path: ingested.path, sha256: ingested.sha256 } },
    { op: 'entity.add', entity: { id: 'assembly', type: 'asset-instance', assetId: ingested.assetId, materialId: 'hero-steel' } },
  ] }))
  const sourceMaterialSlots = [{ index: 0, materialName: 'original-body' }, { index: 1, materialName: null }]
  const materialSlots = [{ index: 0, materialName: 'steel', materialId: 'hero-steel' }]
  h.calls[0].finish([
    { type: 'MESH', deepblendId: 'assembly', partId: '/group/body', parentPartId: '/group', sourceMaterialSlots, materialSlots },
    { type: 'MESH', deepblendId: 'stage', materialSlots },
    { type: 'MESH', deepblendId: 'assembly', partId: '', materialSlots },
    { type: 'EMPTY', deepblendId: 'assembly', partId: '/group' },
  ])
  const committed = await pending
  assert.equal(committed.ok, true, committed.error?.message)
  const expectedPart = { entityId: 'assembly', partId: '/group/body', parentPartId: '/group', sourceMaterialSlots, materialSlots }
  assert.deepEqual(h.studio.store.readRevisionManifest('inventory', 'r0002').assetParts, [expectedPart])
  const compiled = await h.studio.getScene('inventory')
  assert.deepEqual(compiled.assetParts, [{ ...expectedPart, assetId: ingested.assetId, assetSha256: ingested.sha256, selectorVersion: 1 }])
  await h.studio.applyScenePatch(patch('inventory', 'r0002', 40, { saveCheckpoint: false }))
  assert.equal(h.calls.length, 1)
  assert.deepEqual(h.studio.store.readRevisionManifest('inventory', 'r0003').assetParts, [])
  assert.deepEqual((await h.studio.getScene('inventory')).assetParts, [])
  assert.deepEqual((await h.studio.getScene('inventory', { revision: 'r0002' })).assetParts, compiled.assetParts)
})

test('two real Node Host processes cannot patch or restore a project with a live writer', { timeout: 15000 }, async t => {
  const h = harness(t)
  await h.create('processes')
  const writer = child(t, [h.workspaceRoot, 'processes', 'hold'])
  const compiling = await writer.next('compiling')
  const contender = child(t, [h.workspaceRoot, 'processes', 'patch'])
  assert.equal((await contender.next('result')).code, 'REVISION_CONFLICT')
  const restorer = child(t, [h.workspaceRoot, 'processes', 'restore'])
  assert.equal((await restorer.next('result')).code, 'REVISION_CONFLICT')
  assert.equal(existsSync(compiling.sceneSpecPath), true)
  writer.process.send({ finish: true })
  assert.equal((await writer.next('result')).ok, true)
  await writer.exited
  assert.equal(h.studio.store.currentRevision('processes'), 'r0002')
  const after = child(t, [h.workspaceRoot, 'processes', 'restore', 'r0001'])
  assert.equal((await after.next('result')).ok, true)
})

test('a killed Node writer is recovered without publishing its abandoned candidate', { timeout: 15000 }, async t => {
  const h = harness(t)
  await h.create('crashed')
  const writer = child(t, [h.workspaceRoot, 'crashed', 'hold'])
  const compiling = await writer.next('compiling')
  writer.process.kill('SIGKILL')
  assert.equal((await writer.exited).signal, 'SIGKILL')
  assert.equal(h.studio.store.currentRevision('crashed'), 'r0001')
  const recovery = child(t, [h.workspaceRoot, 'crashed', 'patch'])
  assert.equal((await recovery.next('result')).ok, true)
  await recovery.exited
  assert.equal(existsSync(compiling.sceneSpecPath), false)
  assert.deepEqual(h.studio.store.listRevisions('crashed'), ['r0001', 'r0002'])
  assert.deepEqual(readdirSync(join(h.workspaceRoot, '.revision-writers')), [])
})

test('ambiguous leases and interrupted recovery guards fail closed', async t => {
  const h = harness(t)
  await h.create('ambiguous')
  const lock = join(h.workspaceRoot, '.revision-writers', sha256(h.studio.store.projectDirectory('ambiguous')))
  mkdirSync(lock)
  writeFileSync(join(lock, 'owner.json'), '{truncated')
  await assert.rejects(h.studio.applyScenePatch(patch('ambiguous', 'r0001', 40, { saveCheckpoint: false })), { code: 'REVISION_CONFLICT' })
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{truncated')
  rmSync(lock, { recursive: true })
  mkdirSync(`${lock}.recovery`)
  await assert.rejects(h.studio.restoreRevision({ projectId: 'ambiguous', revision: 'r0001' }), { code: 'REVISION_CONFLICT' })
  assert.equal(existsSync(`${lock}.recovery`), true)
  assert.deepEqual(h.studio.store.listRevisions('ambiguous'), ['r0001'])
})

for (const format of ['obj', 'usd']) for (const sameAlias of [false, true]) {
  test(`two Node ${format} publishers retain ${sameAlias ? 'both versions of one alias' : 'both distinct aliases'}`, { timeout: 15000 }, async t => {
    const h = harness(t)
    await h.create('assets')
    const firstPath = join(h.workspaceRoot, 'first.' + format)
    const secondPath = join(h.workspaceRoot, 'second.' + format)
    const mesh = size => format === 'obj' ? `v 0 0 0\nv ${size} 0 0\nv 0 ${size} 0\nf 1 2 3\n`
      : `#usda 1.0\ndef Mesh "Triangle" {\npoint3f[] points = [(0, 0, 0), (${size}, 0, 0), (0, ${size}, 0)]\nint[] faceVertexCounts = [3]\nint[] faceVertexIndices = [0, 1, 2]\n}\n`
    writeFileSync(firstPath, mesh(1))
    writeFileSync(secondPath, mesh(2))
    const releasePath = join(h.workspaceRoot, 'release-publication')
    const firstRequest = JSON.stringify({ sourcePath: firstPath, assetId: 'first' })
    const secondRequest = JSON.stringify({ sourcePath: secondPath, assetId: sameAlias ? 'first' : 'second' })
    const writer = child(t, [h.workspaceRoot, 'assets', 'asset-hold', firstRequest, releasePath])
    await writer.next('publishing')
    const raw = join(h.studio.store.projectDirectory('assets'), 'assets', format === 'obj' ? 'bundles' : 'raw')
    // The first copy completed before it acquired the publication lease.
    assert.equal(readdirSync(raw).filter(name => name.startsWith('.incoming-')).length, 1)
    const contender = child(t, [h.workspaceRoot, 'assets', 'asset', secondRequest])
    assert.equal((await contender.next('result')).code, 'REVISION_CONFLICT')
    await contender.exited
    // The busy caller removed its own private copy, leaving only the winner's.
    assert.equal(readdirSync(raw).filter(name => name.startsWith('.incoming-')).length, 1)
    assert.equal(readdirSync(raw).filter(name => !name.startsWith('.incoming-')).length, 0)
    writeFileSync(releasePath, '')
    const first = await writer.next('result')
    assert.equal(first.ok, true)
    await writer.exited
    const retried = child(t, [h.workspaceRoot, 'assets', 'asset', secondRequest])
    const second = await retried.next('result')
    assert.equal(second.ok, true)
    await retried.exited
    const manifest = JSON.parse(readFileSync(join(dirname(raw), 'manifest.json'), 'utf8'))
    assert.equal(manifest.assets.length, sameAlias ? 1 : 2)
    assert.equal(manifest.versions.length, 2)
    assert.deepEqual(new Set(manifest.versions.map(entry => entry.sha256)), new Set([first.sha256, second.sha256]))
    if (sameAlias) assert.equal(manifest.assets[0].sha256, second.sha256)
    assert.equal(readFileSync(join(h.studio.store.projectDirectory('assets'), first.path), 'utf8'), readFileSync(firstPath, 'utf8'))
    assert.equal(readFileSync(join(h.studio.store.projectDirectory('assets'), second.path), 'utf8'), readFileSync(secondPath, 'utf8'))
    assert.equal(readdirSync(raw).some(name => name.startsWith('.incoming-')), false)
    assert.deepEqual(readdirSync(join(h.workspaceRoot, '.revision-writers')), [])
  })
}

test('a slow download holds no project lock; busy remote publication cleans both scratch copies', { timeout: 15000 }, async t => {
  const h = harness(t)
  await h.create('remote')
  let releaseResponse
  let requested
  const received = new Promise(resolve => { requested = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write('v 0 0 0\nv 1 0 0\n')
    releaseResponse = () => response.end('v 0 1 0\nf 1 2 3\n')
    requested()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const sourceUrl = `http://127.0.0.1:${server.address().port}/remote.obj`
  const importer = child(t, [h.workspaceRoot, 'remote', 'asset', JSON.stringify({ sourceUrl, approved: true, assetId: 'remote-model' })])
  await received
  const changed = await h.studio.applyScenePatch(patch('remote', 'r0001', 45, { saveCheckpoint: false }))
  assert.equal(changed.revision, 'r0002')
  // Now hold the same project's revision writer until the completed download
  // attempts publication. The import must fail cleanly and be safe to retry.
  const pending = capture(h.studio.applyScenePatch(patch('remote', 'r0002', 50)))
  releaseResponse()
  assert.equal((await importer.next('result')).code, 'REVISION_CONFLICT')
  await importer.exited
  assert.deepEqual(readdirSync(join(h.workspaceRoot, 'tmp')), [])
  assert.deepEqual(readdirSync(join(h.studio.store.projectDirectory('remote'), 'assets', 'raw')), [])
  h.calls[0].finish()
  assert.equal((await pending).ok, true)
  const retry = capture(h.studio.ingestAsset({ projectId: 'remote', sourceUrl, approved: true, assetId: 'remote-model' }))
  // The HTTP server still gates each response, so wait for the second request.
  await new Promise(resolve => server.once('request', resolve))
  releaseResponse()
  const result = await retry
  assert.equal(result.ok, true)
  assert.equal(result.value.currentRevision, 'r0003')
  assert.deepEqual(readdirSync(join(h.workspaceRoot, 'tmp')), [])
})
