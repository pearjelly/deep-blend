import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import LocalBlenderRuntime from '@deepblend/dsh-blender-provider-local'
import { buildJobView, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import { beginFrameAttempt, readFrameProvenance, syncFrameProvenance } from '../../../packages/deepblend/host/lib/frame-provenance.js'
import { loadClientBundle } from '../lib/client-bundle.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

const read = path => JSON.parse(readFileSync(path))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const actual = samples => ({ engine: 'CYCLES', resolution: [256, 256], samples, resolutionPercentage: 100,
  filmTransparent: false, viewTransform: 'AgX', look: 'None', exposure: 0, fps: 30, fpsBase: 1, frameStart: 1, frameEnd: 90 })
const png = frame => encodePng(createImage(256, 256, [frame * 30, 90, 110, 255]))
const reader = text => ({ readFrom: () => ({ text }) })
const handle = (exitCode, stdout = '') => ({ done: Promise.resolve({ exitCode, signal: null }), async waitForExit() { return true }, terminate() {}, collected: { stdout: reader(stdout), stderr: reader('') } })
async function world(t, options = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-frame-sources-'))
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }))
  const calls = []
  let attempt = 0
  const ctx = new Context()
  const subprocess = {
    async resolveExecutable(name) { return name },
    spawn(request) {
      if (request.argv[0] === '/controlled/renderer') {
        attempt += 1
        const arg = flag => request.argv[request.argv.indexOf(flag) + 1]
        const plan = read(arg('--frames')); calls.push(plan)
        const frame = plan.frames[0], bytes = png(frame)
        writeFileSync(join(plan.outputDirectory, `frame_${String(frame).padStart(4, '0')}.png`), bytes)
        const config = actual(options.actualSamples ?? plan.profile.samples)
        const events = [
          { type: 'render_config', attemptToken: plan.attemptToken, renderConfig: config },
          { type: 'frame', frame, bytes: bytes.length, ms: 11, attemptToken: plan.attemptToken, sha256: sha(bytes) },
        ]
        writeFileSync(arg('--events'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
        const success = frame === 3
        writeFileSync(arg('--result'), JSON.stringify(success ? { status: 'success', result: { renderConfig: config, renderedFrames: [frame] } }
          : { status: 'error', result: null, error: { code: 'BLENDER_NONZERO_EXIT', message: 'controlled interruption' } }))
        if (options.hold) {
          let finish
          const done = new Promise(resolve => { finish = resolve })
          return { ...handle(0), done, terminate() { finish({ exitCode: null, signal: 'SIGTERM' }) } }
        }
        return handle(success ? 0 : 1)
      }
      if (request.argv[0].includes('ffprobe')) return handle(0, JSON.stringify({ streams: [{ codec_name: 'h264', width: 256, height: 256, avg_frame_rate: '30/1', nb_read_frames: String(options.frameCount ?? 3) }], format: { duration: String((options.frameCount ?? 3) / 30) } }))
      assert(request.argv[0].includes('ffmpeg')); writeFileSync(request.argv.at(-1), 'controlled encoded bytes'); return handle(0)
    },
  }
  const seam = { ctx: { subprocess }, config: { maxOutputBytes: 4096, maxSpillBytes: 4096 }, bootstrapPath: join(ROOT, 'packages/deepblend/provider-local/python/bootstrap.py'),
    async resolveBlenderExecutable() { return { error: null, resolved: '/controlled/renderer' } }, _readAll: LocalBlenderRuntime.prototype._readAll }
  ctx.provide('subprocess', subprocess)
  ctx.provide('blenderRuntime', {
    startFrameSequence: request => LocalBlenderRuntime.prototype.startFrameSequence.call(seam, request),
    awaitFrameSequence: run => LocalBlenderRuntime.prototype.awaitFrameSequence.call(seam, run),
  })
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'), reconcileOnStart: false }))
  const spec = read(join(ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json'))
  spec.renderProfiles.final = { engine: 'cycles', resolution: [256, 256], samples: 12 }
  const project = await studio.transactions.createProject({ title: 'frame-provenance', sceneSpec: spec, saveCheckpoint: false })
  const request = { projectId: project.projectId, jobId: 'render-0001' }
  const checkpointPath = join(workspaceRoot, 'checkpoint.blend'); writeFileSync(checkpointPath, 'controlled checkpoint')
  studio.renderJobs.write({ ...request, type: 'final-render', status: 'failed', revisionId: project.revision.revision,
    frameStart: 1, frameEnd: 3, expectedFrames: 3, completedFrames: [], missingFrames: [1, 2, 3], corruptFrames: [], fps: 30,
    attempt: 0, createdAt: Date.now(), finishedAt: null, pid: null, dshJobId: null, delivery: { status: 'failed', attempt: 0 }, warnings: [], filePrefix: 'frame_', filePadding: 4,
    profileName: 'final', cameraId: 'camera-main', sceneFrameRange: [1, 90], renderConfig: { engine: 'cycles', resolution: [256, 256], samples: 12 }, checkpointPath })
  const directory = studio.renderJobs.jobDirectory(request.projectId, request.jobId)
  const frames = studio.renderJobs.framesDirectory(request.projectId, request.jobId)
  mkdirSync(frames, { recursive: true })
  const record = () => studio.renderJobs.read(request.projectId, request.jobId)
  const resume = async samples => {
    const result = await studio.resumeRenderJob({ ...request, ...(samples == null ? {} : { samples }) })
    for (let n = 0; n < 200 && studio._liveRenders.has(`${request.projectId}/${request.jobId}`); n++) await new Promise(r => setTimeout(r, 5))
    assert.equal(studio._liveRenders.size, 0)
    return result
  }
  return { studio, request, directory, frames, record, resume, calls, workspaceRoot }
}

test('mixed resumed frames keep their actual samples through publication and the UI', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  assert.deepEqual(w.calls.map(p => [p.frames, p.profile.samples]), [[[1, 2, 3], 12], [[2, 3], 7], [[3], 12]])
  const manifest = read(join(w.directory, 'manifest.json'))
  assert.equal(w.record().renderConfig.samples, 12, 'the default for the next resume remains unchanged')
  assert.equal(manifest.render.config, null, 'mixed frames must not claim a uniform configuration')
  assert.equal(manifest.render.provenance.coverage, 'complete')
  assert.equal(manifest.render.provenance.configuration, 'mixed')
  assert.deepEqual(manifest.render.provenance.groups.map(g => [g.renderConfig.samples, g.frames]), [[12, [1, 3]], [7, [2]]])
  const job = (await w.studio.listJobs({ projectId: w.request.projectId })).jobs[0]
  assert.deepEqual(job.provenance, manifest.render.provenance)
  assert.deepEqual(buildJobView(job).provenanceDisplay.groups.map(g => [g.samples, g.frames]), [[12, '1, 3'], [7, '2']])
})

test('legacy complete frames are delivered with unknown provenance without applying a samples override', async t => {
  const w = await world(t)
  for (const frame of [1, 2, 3]) writeFileSync(join(w.frames, `frame_${String(frame).padStart(4, '0')}.png`), png(frame))
  await w.resume(7)
  assert.equal(w.calls.length, 0)
  const manifest = read(join(w.directory, 'manifest.json'))
  assert.equal(manifest.render.config, null)
  assert.deepEqual(manifest.render.provenance.unknownFrames, [1, 2, 3])
  assert.equal(manifest.render.provenance.coverage, 'unknown')
  assert.equal(buildJobView((await w.studio.listJobs({ projectId: w.request.projectId })).jobs[0]).provenanceDisplay.unknownCount, 3)
})


test('actual settings rather than either default or requested samples describe uniform frames', async t => {
  const w = await world(t, { actualSamples: 5 })
  await w.resume(); await w.resume(7); await w.resume()
  const manifest = read(join(w.directory, 'manifest.json'))
  assert.equal(manifest.render.provenance.configuration, 'uniform')
  assert.equal(manifest.render.config.samples, 5)
  assert.equal(manifest.render.defaultConfig.samples, 12)
  assert.deepEqual(manifest.render.provenance.sources.map(s => [s.requestedSamples, s.effectiveProfile.samples, s.renderConfig.samples]), [[12, 12, 5], [7, 7, 5], [12, 12, 5]])
})

function interruptedAttempt(w, options = {}) {
  const id = randomUUID(), record = w.record(), bytes = png(1)
  beginFrameAttempt(record, w.directory, { id, frames: [1, 2, 3], profile: { engine: 'cycles', samples: 12, resolution: [256, 256] }, cameraId: 'camera-main', checkpointPath: record.checkpointPath })
  writeFileSync(join(w.frames, 'frame_0001.png'), bytes)
  const events = [ { type: 'render_config', attemptToken: id, renderConfig: actual(12) },
    { type: 'frame', frame: 1, attemptToken: id, sha256: sha(bytes) } ]
  writeFileSync(join(w.directory, 'events.jsonl'), (options.events?.(events) ?? events).map(e => JSON.stringify(e)).join('\n') + (options.torn ? '' : '\n'))
  return { id, bytes }
}

test('a restarted Host absorbs the previous durable journal before the provider replaces it', async t => {
  const w = await world(t)
  // Disk state after a child completed frame 1 and the Host died before folding
  // its journal: no in-memory live entry and no bound frames in the source file.
  const prior = interruptedAttempt(w)
  assert.deepEqual(read(join(w.directory, 'frame-sources.json')).frames, {})
  await w.resume(7); await w.resume()
  const manifest = read(join(w.directory, 'manifest.json'))
  assert.deepEqual(manifest.render.provenance.groups.map(g => [g.renderConfig.samples, g.frames]), [[12, [1, 3]], [7, [2]]])
  assert.equal(manifest.render.provenance.frames[0].sourceId, prior.id)
  assert.equal(sha(readFileSync(join(w.frames, 'frame_0001.png'))), sha(prior.bytes))
})

for (const kind of ['torn completion', 'foreign token', 'missing configuration', 'frame before configuration', 'conflicting configuration']) {
  test(`an interrupted frame remains unknown with ${kind}`, async t => {
    const w = await world(t)
    interruptedAttempt(w, { torn: kind === 'torn completion', events: events => {
      if (kind === 'foreign token') events[1].attemptToken = randomUUID()
      if (kind === 'missing configuration') return [events[1]]
      if (kind === 'frame before configuration') return events.reverse()
      if (kind === 'conflicting configuration') events.push({ ...events[0], renderConfig: actual(2) })
      return events
    } })
    await w.resume(7); await w.resume()
    const provenance = read(join(w.directory, 'manifest.json')).render.provenance
    assert.deepEqual(provenance.unknownFrames, [1])
    assert.equal(provenance.coverage, 'partial')
    assert.equal(provenance.configuration, 'mixed')
  })
}

test('replacing a PNG invalidates only its binding in status and re-export', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const old = read(join(w.directory, 'manifest.json')).render.provenance
  writeFileSync(join(w.frames, 'frame_0002.png'), png(4))
  const status = (await w.studio.listJobs({ projectId: w.request.projectId })).jobs[0]
  assert.deepEqual(status.provenance.unknownFrames, [2])
  await w.studio.exportProject(w.request)
  const manifest = read(join(w.directory, 'manifest.json'))
  assert.equal(manifest.render.config, null)
  assert.deepEqual(manifest.render.provenance.unknownFrames, [2])
  assert.deepEqual(manifest.render.provenance.frames, old.frames.filter(f => f.frame !== 2))
})

test('source write failure preserves the old journal and refuses to spawn until it can be saved', async t => {
  const w = await world(t)
  interruptedAttempt(w)
  const source = join(w.directory, 'frame-sources.json'), saved = source + '.saved'
  renameSync(source, saved); mkdirSync(source)
  const journal = readFileSync(join(w.directory, 'events.jsonl'))
  await assert.rejects(w.resume(7), /directory|EISDIR/i)
  assert.equal(w.calls.length, 0)
  assert.deepEqual(readFileSync(join(w.directory, 'events.jsonl')), journal)
  assert.equal(w.studio._liveRenders.size, 0)
  rmSync(source, { recursive: true }); renameSync(saved, source)
  await w.resume(7); await w.resume()
  assert.equal(read(join(w.directory, 'manifest.json')).render.provenance.coverage, 'complete')
})

test('oversized or corrupt source data is unknown; oversized journal is retained before restart', async t => {
  const w = await world(t)
  interruptedAttempt(w)
  const journal = join(w.directory, 'events.jsonl')
  truncateSync(journal, 64 * 1024 * 1024)
  await assert.rejects(w.resume(7), /journal.*limit/)
  assert.equal(w.calls.length, 0)
  for (const contents of ['{', JSON.stringify({ schemaVersion: 'unknown' })]) {
    writeFileSync(join(w.directory, 'frame-sources.json'), contents)
    assert.deepEqual(readFrameProvenance(w.record(), w.directory).unknownFrames, [1])
  }
  truncateSync(join(w.directory, 'frame-sources.json'), 64 * 1024 * 1024)
  assert.equal(readFrameProvenance(w.record(), w.directory).uncheckedFrameCount, 3)
})

test('the workbench renders the same bounded provenance summary as its job API', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const job = buildJobView((await w.studio.listJobs({ projectId: w.request.projectId })).jobs[0])
  const core = loadClientBundle().exports.workbench
  const store = core.createWorkbenchStore({ fetch: async () => { throw Error('not used') } })
  const state = { ...store.getState(), status: 'ready', activeProjectId: w.request.projectId, view: 'jobs', jobs: [job] }
  const tree = core.buildWorkbenchView(state, store.actions)
  assert.match(JSON.stringify(tree), /data-job-provenance/)
  assert.match(JSON.stringify(tree), /Mixed configurations: CYCLES · 256×256 · samples 12 · frames 1, 3 \(2 total\); CYCLES · 256×256 · samples 7 · frames 2 \(1 total\)/)
  const large = buildJobView({ ...job, provenance: { configuration: 'mixed', groups: Array.from({ length: 30 }, (_, i) => ({ renderConfig: { samples: i + 1 }, frames: Array.from({ length: 10000 }, (_, j) => j * 2) })), unknownFrames: [], missingFrames: [] } })
  assert(JSON.stringify(large.provenanceDisplay).length < 1800)
  assert.equal(large.provenanceDisplay.groups.length, 8)
  assert.equal(large.provenanceDisplay.moreGroups, 22)
})


test('status polling does not open PNGs to recompute frame hashes', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const original = fs.openSync
  const opened = []
  fs.openSync = (path, ...args) => { if (String(path).endsWith('.png')) opened.push(path); return original(path, ...args) }
  syncBuiltinESMExports()
  try {
    for (let n = 0; n < 5; n++) {
      const jobs = await w.studio.listJobs({ projectId: w.request.projectId })
      assert.equal(jobs.jobs[0].provenance.coverage, 'complete')
    }
    assert.deepEqual(opened, [])
  } finally { fs.openSync = original; syncBuiltinESMExports() }
})

test('a source record for another project cannot attribute this job frames', async t => {
  const w = await world(t)
  await w.resume()
  const path = join(w.directory, 'frame-sources.json'), sources = read(path)
  sources.projectId = 'unrelated-project'; writeFileSync(path, JSON.stringify(sources))
  const summary = syncFrameProvenance(w.record(), w.directory)
  assert.deepEqual(summary.unknownFrames, [1])
  assert.deepEqual(summary.sources, [])
})


test('a digest alone cannot attribute an incomplete PNG', async t => {
  const w = await world(t)
  interruptedAttempt(w)
  const path = join(w.frames, 'frame_0001.png'), truncated = png(1).subarray(0, 500)
  writeFileSync(path, truncated)
  const eventsPath = join(w.directory, 'events.jsonl')
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  events[1].sha256 = sha(truncated)
  writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n')
  assert.deepEqual(syncFrameProvenance(w.record(), w.directory).unknownFrames, [1])
})


test('cancellation releases live work when saving frame sources fails, and retains the journal for recovery', async t => {
  const w = await world(t, { hold: true })
  await w.studio.resumeRenderJob(w.request)
  const live = w.studio._liveRenders.get(`${w.request.projectId}/${w.request.jobId}`)
  assert(live)
  const source = join(w.directory, 'frame-sources.json'), saved = source + '.saved'
  renameSync(source, saved); mkdirSync(source)
  const journal = readFileSync(join(w.directory, 'events.jsonl'))
  const cancelled = await w.studio.cancelJob(w.request)
  await live.lifecycleDone
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.processGone, true)
  assert.equal(w.record().status, 'cancelled')
  assert.equal(w.studio._liveRenders.size, 0)
  assert.deepEqual(readFileSync(join(w.directory, 'events.jsonl')), journal)
  rmSync(source, { recursive: true }); renameSync(saved, source)
  assert.deepEqual(syncFrameProvenance(w.record(), w.directory).frames.map(binding => binding.frame), [1])
})


test('source persistence failure at publication preserves the previous official delivery bytes', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const previous = w.record().delivery
  const paths = [previous.videoPath, previous.manifestPath, previous.renderManifestPath]
  const bytes = paths.map(path => readFileSync(path))
  const source = join(w.directory, 'frame-sources.json'), saved = source + '.saved'
  renameSync(source, saved); mkdirSync(source)
  const journal = readFileSync(join(w.directory, 'events.jsonl'))
  await assert.rejects(w.studio.exportProject(w.request), /directory|EISDIR/i)
  assert.equal(w.record().status, 'completed')
  assert.equal(w.record().delivery.status, 'failed')
  assert.equal(w.studio._deliveriesInFlight.size, 0)
  paths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytes[index]))
  assert.deepEqual(readFileSync(join(w.directory, 'events.jsonl')), journal)
  rmSync(source, { recursive: true }); renameSync(saved, source)
  await w.studio.exportProject(w.request)
  assert.deepEqual(read(previous.manifestPath).render.provenance, read(previous.renderManifestPath).render.provenance)
  assert.equal(read(previous.manifestPath).render.provenance.coverage, 'complete')
})


for (const action of ['resume', 'export']) {
  test(`complete legacy long job can ${action} without changing bounded provenance evidence`, async t => {
    const count = 100001, w = await world(t, { frameCount: count })
    w.studio.renderJobs.write({ ...w.record(), frameEnd: count, expectedFrames: count })
    // Controlled ledger seam: verifies the Host route for a pre-existing long
    // complete job without writing 100001 PNG fixtures or invoking a codec.
    w.studio._readJobLedger = (_record, expected) => {
      assert.equal(expected.length, count)
      return { present: expected.map(frame => ({ frame, bytes: 777 })), presentCount: count,
        missing: [], corrupt: [], toRender: [], missingCount: 0, corruptCount: 0, toRenderCount: 0 }
    }
    const source = join(w.directory, 'frame-sources.json'), events = join(w.directory, 'events.jsonl')
    writeFileSync(source, 'original source evidence'); writeFileSync(events, 'original journal evidence\n')
    if (action === 'resume') await w.resume(7)
    else await w.studio.exportProject(w.request)
    assert.equal(w.record().delivery.status, 'published')
    assert.equal(w.calls.length, 0, 'complete long jobs must not launch a renderer')
    const provenance = read(join(w.directory, 'manifest.json')).render.provenance
    assert.equal(provenance.coverage, 'unknown')
    assert.equal(provenance.limited, true)
    assert.equal(provenance.uncheckedFrameCount, count)
    assert.equal(provenance.knownFrameCount, 0)
    assert.equal(readFileSync(source, 'utf8'), 'original source evidence')
    assert.equal(readFileSync(events, 'utf8'), 'original journal evidence\n')
    assert.throws(() => beginFrameAttempt(w.record(), w.directory, { id: randomUUID(), frames: [1], profile: { samples: 7 } }), /100000/)
    assert.equal(readFileSync(events, 'utf8'), 'original journal evidence\n', 'strict startup must retain the journal')
  })
}

async function measureStatusIO(run) {
  const originals = Object.fromEntries(['statSync', 'openSync', 'readSync', 'readFileSync', 'closeSync'].map(key => [key, fs[key]]))
  const descriptors = new Set(), cost = { pngStats: 0, sourceOpens: 0, sourceReads: 0, sourceBytes: 0 }
  fs.statSync = (path, ...args) => { if (String(path).endsWith('.png')) cost.pngStats++; return originals.statSync(path, ...args) }
  fs.openSync = (path, ...args) => {
    const source = String(path).endsWith('frame-sources.json')
    if (source) cost.sourceOpens++
    const fd = originals.openSync(path, ...args); if (source) descriptors.add(fd); return fd
  }
  fs.readSync = (fd, ...args) => { const n = originals.readSync(fd, ...args); if (descriptors.has(fd)) { cost.sourceReads++; cost.sourceBytes += n }; return n }
  fs.readFileSync = (path, ...args) => {
    const bytes = originals.readFileSync(path, ...args)
    if (String(path).endsWith('frame-sources.json')) cost.sourceBytes += Buffer.byteLength(bytes)
    return bytes
  }
  fs.closeSync = fd => { descriptors.delete(fd); return originals.closeSync(fd) }
  syncBuiltinESMExports()
  try { return { value: await run(), cost } }
  finally { Object.assign(fs, originals); syncBuiltinESMExports() }
}

for (const count of [1000, 100000]) {
  test(`status for ${count} frames defers provenance within a fixed I/O budget`, async t => {
    const w = await world(t)
    w.studio.renderJobs.write({ ...w.record(), frameEnd: count, expectedFrames: count })
    const { value, cost } = await measureStatusIO(() => w.studio.getJob(w.request))
    assert(cost.pngStats <= 256, `status issued ${cost.pngStats} PNG stat calls`)
    assert(cost.sourceOpens <= 16)
    assert(cost.sourceReads <= 16)
    assert(cost.sourceBytes <= 256 * 1024)
    const summary = value.renderJob.provenance
    assert.equal(summary.limited, true)
    assert.equal(summary.uncheckedFrameCount, count)
    assert.equal(summary.unknownFrameCount, 0, 'uninspected does not assert unknown source on a present file')
    assert.equal(summary.missingFrameCount, 0, 'uninspected does not assert missing files')
    assert.deepEqual(summary.frames, [])
  })
}

test('one list request shares the provenance I/O budget across small jobs', async t => {
  const w = await world(t)
  const first = w.record()
  for (let i = 2; i <= 100; i++) w.studio.renderJobs.write({ ...first, jobId: `render-${String(i).padStart(4, '0')}` })
  const { value, cost } = await measureStatusIO(() => w.studio.listJobs({ projectId: w.request.projectId }))
  assert.equal(value.jobs.length, 100)
  assert(cost.pngStats <= 256, `one list issued ${cost.pngStats} PNG stat calls`)
  assert(cost.sourceOpens <= 16, `one list opened ${cost.sourceOpens} source documents`)
  assert(cost.sourceReads <= 16)
  assert(cost.sourceBytes <= 256 * 1024)
  assert(value.jobs.some(job => job.provenance.limited === true))
})

test('status metadata budget defers reading, without declaring saved valid source evidence corrupt', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const path = join(w.directory, 'frame-sources.json'), doc = read(path)
  doc.padding = 'x'.repeat(300 * 1024)
  writeFileSync(path, JSON.stringify(doc))
  const original = readFileSync(path)
  const { value, cost } = await measureStatusIO(() => w.studio.getJob(w.request))
  assert(cost.sourceBytes <= 256 * 1024, `status read ${cost.sourceBytes} metadata bytes`)
  const summary = value.renderJob.provenance
  assert.equal(summary.limited, true)
  assert.equal(summary.uncheckedFrameCount, 3)
  assert.equal(summary.unknownFrameCount, 0)
  assert.deepEqual(readFileSync(path), original)
  assert.equal(syncFrameProvenance(w.record(), w.directory).coverage, 'complete', 'full boundary still checks known PNG digests')
  const core = loadClientBundle().exports.workbench
  const store = core.createWorkbenchStore({ fetch: async () => { throw Error('unused') } })
  const tree = core.buildWorkbenchView({ ...store.getState(), status: 'ready', activeProjectId: w.request.projectId,
    view: 'jobs', jobs: [buildJobView(value.renderJob)] }, store.actions)
  assert.match(JSON.stringify(tree), /3 frames not rechecked in this status read/)
})

for (const oversized of ['source', 'journal']) {
  test(`publication can defer an oversized ${oversized} without clearing evidence needed by a future renderer`, async t => {
    const w = await world(t)
    await w.resume(); await w.resume(7); await w.resume()
    const source = join(w.directory, 'frame-sources.json'), journal = join(w.directory, 'events.jsonl')
    truncateSync(oversized === 'source' ? source : journal, (oversized === 'source' ? 16 : 32) * 1024 * 1024 + 1)
    const sourceHash = sha(readFileSync(source)), journalHash = sha(readFileSync(journal))
    await w.studio.exportProject(w.request)
    const manifest = read(join(w.directory, 'manifest.json'))
    assert.equal(w.record().delivery.status, 'published')
    assert.equal(manifest.render.config, null)
    assert.equal(manifest.render.provenance.limited, true)
    assert.equal(manifest.render.provenance.uncheckedFrameCount, 3)
    assert.throws(() => beginFrameAttempt(w.record(), w.directory, { id: randomUUID(), frames: [1], profile: { samples: 7 } }), /budget|limit/)
    assert.equal(sha(readFileSync(source)), sourceHash)
    assert.equal(sha(readFileSync(journal)), journalHash)
  })
}

test('the list metadata byte allowance is shared, while a separate getJob has its own allowance', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const first = w.record(), second = { ...first, jobId: 'render-0002', framesDirectory: w.frames }
  w.studio.renderJobs.write(second)
  const data = read(join(w.directory, 'frame-sources.json'))
  data.padding = 'x'.repeat(200 * 1024)
  writeFileSync(join(w.directory, 'frame-sources.json'), JSON.stringify(data))
  writeFileSync(join(w.studio.renderJobs.jobDirectory(second.projectId, second.jobId), 'frame-sources.json'), JSON.stringify({ ...data, jobId: second.jobId }))
  const listed = await measureStatusIO(() => w.studio.listJobs({ projectId: first.projectId }))
  assert(listed.cost.sourceBytes <= 256 * 1024, `list read ${listed.cost.sourceBytes} source bytes`)
  assert.equal(listed.value.jobs.filter(job => job.provenance.coverage === 'complete').length, 1)
  const deferred = listed.value.jobs.find(job => job.provenance.limited)
  assert.equal(deferred.provenance.uncheckedFrameCount, 3)
  const single = await measureStatusIO(() => w.studio.getJob({ projectId: first.projectId, jobId: deferred.jobId }))
  assert(single.cost.sourceBytes <= 256 * 1024)
  assert.equal(single.value.renderJob.provenance.coverage, 'complete')
})

test('a status-deferred job still gets full PNG hash verification at publication', async t => {
  const count = 300, w = await world(t, { frameCount: count })
  w.studio.renderJobs.write({ ...w.record(), frameEnd: count, expectedFrames: count })
  const token = randomUUID(), frames = Array.from({ length: count }, (_, i) => i + 1)
  beginFrameAttempt(w.record(), w.directory, { id: token, frames, profile: { engine: 'cycles', samples: 12, resolution: [256, 256] }, checkpointPath: w.record().checkpointPath })
  const bytes = png(1), digest = sha(bytes)
  for (const frame of frames) writeFileSync(join(w.frames, `frame_${String(frame).padStart(4, '0')}.png`), bytes)
  const events = [{ type: 'render_config', attemptToken: token, renderConfig: actual(12) },
    ...frames.map(frame => ({ type: 'frame', frame, attemptToken: token, sha256: digest }))]
  writeFileSync(join(w.directory, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n')
  assert.equal(syncFrameProvenance(w.record(), w.directory).knownFrameCount, count)
  const status = await measureStatusIO(() => w.studio.getJob(w.request))
  assert.equal(status.value.renderJob.provenance.uncheckedFrameCount, count)
  assert.equal(status.value.renderJob.provenance.knownFrameCount, 0)
  assert.equal(status.cost.pngStats, 0)
  writeFileSync(join(w.frames, 'frame_0280.png'), png(4))
  await w.studio.exportProject(w.request)
  const provenance = read(join(w.directory, 'manifest.json')).render.provenance
  assert.equal(provenance.limited, undefined)
  assert.equal(provenance.knownFrameCount, 299)
  assert.deepEqual(provenance.unknownFrames, [280], 'status deferral must not bypass publication digests')
})

test('short source reads exhaust the status call allowance without classifying the file as corrupt', async t => {
  const w = await world(t)
  await w.resume(); await w.resume(7); await w.resume()
  const path = join(w.directory, 'frame-sources.json'), before = readFileSync(path)
  const original = fs.readSync
  fs.readSync = (fd, buffer, offset, length, position) => original(fd, buffer, offset, Math.min(length, 1), position)
  syncBuiltinESMExports()
  try {
    const { value, cost } = await measureStatusIO(() => w.studio.getJob(w.request))
    assert(cost.sourceReads <= 16, `status issued ${cost.sourceReads} source read calls`)
    assert.equal(value.renderJob.provenance.uncheckedFrameCount, 3)
    assert.equal(value.renderJob.provenance.unknownFrameCount, 0)
    assert.deepEqual(readFileSync(path), before)
  } finally { fs.readSync = original; syncBuiltinESMExports() }
})
