/** Public Host calls in separate OS processes, with controlled PNG rendering. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { sha256, sceneSpecDigest, decodePng } from '@deepblend/dsh-blender-contracts'
import { withArtifactWriter } from '../../../packages/deepblend/host/lib/artifact-writer.js'

const helper = fileURLToPath(new URL('../lib/artifact-writer-child.mjs', import.meta.url))
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
function child(t, args) {
  const proc = fork(helper, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }), messages = [], waiters = []
  let stderr = ''
  proc.stderr.on('data', bytes => { stderr += bytes })
  proc.on('message', message => {
    messages.push(message)
    const index = waiters.findIndex(waiter => waiter.type === message.type)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
  })
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child ${code}/${signal}: ${stderr}`))
    resolve({ code, signal })
  }))
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); await exited })
  return { proc, messages, exited, next(type) {
    const message = messages.find(entry => entry.type === type)
    return message ? Promise.resolve(message) : new Promise((resolve, reject) => {
      waiters.push({ type, resolve, reject })
      setTimeout(() => reject(new Error(`child did not report ${type}: ${stderr}`)), 15_000).unref()
    })
  } }
}
async function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-artifact-writers-')), ctx = new Context()
  ctx.provide('blenderRuntime', { async compileScene(r) {
    const directory = join(r.projectRoot, 'compiler'); mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'result.blend'), 'controlled checkpoint'); r.onWorkingDirectory({ directory })
    return { envelope: {}, report: { validation: {}, sceneFingerprint: { totalPolygons: 1 } } }
  } })
  const studio = new Studio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const created = await studio.createProject({ projectId: 'race', title: 'race', sceneSpec: fixture, saveCheckpoint: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = name => join(root, 'projects/race', name), source = ['scene-spec.json', 'scene.blend'].map(name => file('revisions/r0001/' + name))
  return { root, studio, created, file, source, before: source.map(path => readFileSync(path)), release: join(root, 'release') }
}
function verify(h, result) {
  assert.equal(result.ok, true, result.message)
  const manifest = h.studio.store.readRevisionManifest('race', 'r0001')
  for (const artifact of result.artifacts) {
    assert.equal(sha256(readFileSync(h.file(artifact.path))), artifact.sha256)
    assert.ok([...manifest.previews, ...(manifest.contactSheets ?? [])].some(item => item.path === artifact.path && item.sha256 === artifact.sha256), 'successful artifact stays indexed')
    assert.equal(artifact.sourceDigest, sceneSpecDigest(h.studio.store.readRevisionSpec('race', 'r0001')))
  }
  assert.deepEqual(h.studio.store.readJobSafe('race', result.job.jobId).artifacts, result.artifacts)
  assert.deepEqual(h.source.map(path => readFileSync(path)), h.before)
}

test('independent Hosts allocate before either writes a job and both previews survive', async t => {
  const h = await harness(t), a = child(t, [h.root, 'race', 'allocation', '18', h.release]), b = child(t, [h.root, 'race', 'allocation', '22', h.release])
  await Promise.all([a.next('ready'), b.next('ready')]); a.proc.send('go'); b.proc.send('go')
  const ids = await Promise.all([a.next('allocated'), b.next('allocated')])
  writeFileSync(h.release, 'release')
  const results = await Promise.all([a.next('result'), b.next('result')])
  assert.notEqual(ids[0].pid, ids[1].pid); assert.notEqual(ids[0].jobId, ids[1].jobId)
  assert.notEqual(results[0].artifacts?.[0]?.path, results[1].artifacts?.[0]?.path)
  for (const result of results) verify(h, result)
  assert.equal(readdirSync(join(h.root, '.revision-writers')).length, 0)
})

test('a paused manifest reader cannot erase another Host successful preview', async t => {
  const h = await harness(t), a = child(t, [h.root, 'race', 'manifest-hold', '18', h.release]), b = child(t, [h.root, 'race', 'normal', '22', h.release])
  await Promise.all([a.next('ready'), b.next('ready')]); a.proc.send('go'); await a.next('manifest-read')
  b.proc.send('go'); await b.next('rendered'); await delay(100); writeFileSync(h.release, 'release')
  const results = await Promise.all([a.next('result'), b.next('result')])
  for (const result of results) verify(h, result)
})

test('two view publishers rotate matching sheets, view pixels and provenance under one lease', async t => {
  const h = await harness(t), a = child(t, [h.root, 'race', 'manifest-hold', '18', h.release, 'camera-main', '1', 'views']), b = child(t, [h.root, 'race', 'normal', '22', h.release, 'camera-main', '1', 'views'])
  await Promise.all([a.next('ready'), b.next('ready')]); a.proc.send('go'); await a.next('manifest-read')
  b.proc.send('go'); await b.next('rendered'); await delay(100)
  const viewRoot = h.file('revisions/r0001/previews/views'), pendingDirectories = readdirSync(viewRoot)
  assert.equal(pendingDirectories.length, 1, 'only the owning publisher has written view pixels')
  const pendingViewWidth = decodePng(readFileSync(join(viewRoot, pendingDirectories[0], 'hero.png'))).width
  writeFileSync(h.release, 'release')
  const [first, second] = await Promise.all([a.next('result'), b.next('result')])
  assert.equal(first.ok, true, first.message); assert.equal(pendingViewWidth, 18, 'second publisher cannot overwrite view bytes while the first owns publication'); verify(h, second)
  const manifest = h.studio.store.readRevisionManifest('race', 'r0001'), current = manifest.contactSheets.find(item => item.slot === 'preview-current'), previous = manifest.contactSheets.find(item => item.slot === 'preview-previous')
  assert.equal(current.jobId, second.job.jobId); assert.equal(previous.jobId, first.job.jobId)
  assert.equal(previous.sha256, first.artifacts.find(item => item.kind === 'contact-sheet').sha256)
  assert.equal(sha256(readFileSync(h.file(previous.path))), previous.sha256)
  const previousPng = decodePng(readFileSync(h.file(previous.path)))
  assert.equal(previous.width, previousPng.width); assert.equal(previous.height, previousPng.height)
  assert.equal(previous.at, first.artifacts.find(item => item.kind === 'contact-sheet').at)
})

test('unrelated callers in one process wait, while nested publication joins only its owning chain', async t => {
  const h = await harness(t), events = []; let release, entered
  const started = new Promise(resolve => { entered = resolve })
  const first = h.studio.store.withRevisionArtifacts('race', 'r0001', async () => {
    events.push('first'); entered(); await new Promise(resolve => { release = resolve })
    await h.studio.store.recordRevisionArtifact('race', 'r0001', 'reviews', { path: 'first.json' })
  })
  await started
  const second = h.studio.store.recordRevisionArtifact('race', 'r0001', 'reviews', { path: 'second.json' }).then(() => events.push('second'))
  await delay(30); assert.deepEqual(events, ['first']); release(); await Promise.all([first, second])
  assert.deepEqual(h.studio.store.readRevisionManifest('race', 'r0001').reviews.map(item => item.path), ['first.json', 'second.json'])
})

test('cancelled and timed-out publishers do not touch the manifest and the owner keeps its lease', async t => {
  const h = await harness(t), directory = h.studio.store.revisionDirectory('race', 'r0001'), manifest = h.file('revisions/r0001/revision-manifest.json'), before = readFileSync(manifest)
  let release, entered; const started = new Promise(resolve => { entered = resolve })
  const owner = withArtifactWriter(directory, h.root, async () => { entered(); await new Promise(resolve => { release = resolve }) })
  await started
  const controller = new AbortController(), cancelled = withArtifactWriter(directory, h.root, () => { throw Error('cancelled publisher ran') }, { signal: controller.signal })
  controller.abort(); await assert.rejects(cancelled, { code: 'BLENDER_ABORTED' })
  await assert.rejects(withArtifactWriter(directory, h.root, () => { throw Error('timed out publisher ran') }, { timeoutMs: 20 }), { code: 'REVISION_CONFLICT' })
  assert.deepEqual(readFileSync(manifest), before); assert.equal(readdirSync(join(h.root, '.revision-writers')).length, 1)
  release(); await owner; assert.equal(readdirSync(join(h.root, '.revision-writers')).length, 0)
})

test('a publisher action failure releases its lease and is never retried', async t => {
  const h = await harness(t); let calls = 0
  await assert.rejects(h.studio.store.withRevisionArtifacts('race', 'r0001', () => { calls++; throw Object.assign(new Error('action conflict'), { code: 'REVISION_CONFLICT' }) }, { timeoutMs: 20 }), { message: 'action conflict' })
  assert.equal(calls, 1); assert.equal(readdirSync(join(h.root, '.revision-writers')).length, 0)
  await h.studio.store.recordRevisionArtifact('race', 'r0001', 'reviews', { path: 'after-failure.json' })
  assert.equal(h.studio.store.readRevisionManifest('race', 'r0001').reviews[0].path, 'after-failure.json')
})
