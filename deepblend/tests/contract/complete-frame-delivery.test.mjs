import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import LocalBlenderRuntime from '@deepblend/dsh-blender-provider-local'
import { BlenderErrorCode, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const defer = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const pause = () => new Promise(resolve => setImmediate(resolve))
async function waitFor(predicate) {
  for (let n = 0; n < 200; n += 1) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)) }
  assert.fail('background delivery did not settle')
}
const png = encodePng(createImage(256, 256, [30, 70, 110, 255]))

async function fixture(t, options = {}) {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'deepblend-complete-delivery-')))
  const calls = []
  const started = { encode: defer(), probe: defer() }
  const release = { encode: defer(), probe: defer() }
  const requests = {}
  const ctx = new Context()
  ctx.provide('blenderRuntime', {
    async compileScene() { calls.push('compile'); throw Error('compile forbidden for complete frames') },
    async resolveEngineKey() { calls.push('engine'); throw Error('engine probe forbidden') },
    async startFrameSequence(request) {
      calls.push({ render: request.frames, samples: request.profile?.samples })
      if (!request.frames.length) return LocalBlenderRuntime.prototype.startFrameSequence.call({}, request)
      throw Error('missing frames reached renderer')
    },
    async awaitFrameSequence() { calls.push('await-render'); throw Error('await-render forbidden') },
    ...options.runtime,
  })
  ctx.provide('subprocess', {
    async resolveExecutable(requested) { if (options.resolveFailure && !requested.includes('ffprobe')) throw Error('controlled missing encoder'); return requested },
    spawn(request) {
      const phase = request.argv[0].includes('ffprobe') ? 'probe' : 'encode'
      calls.push(phase)
      requests[phase] = request
      if (phase === 'encode' && !options.skipEncodeWrite) writeFileSync(request.argv.at(-1), 'new encoded video')
      started[phase].resolve()
      const done = options.hold === phase && calls.filter(call => call === phase).length === 1 ? release[phase].promise : Promise.resolve({ exitCode: options.failure === phase ? 1 : 0, signal: null })
      return {
        done,
        async waitForExit() { await done; return options.rangeFailure !== true },
        terminate() { release[phase].resolve({ exitCode: null, signal: 'SIGTERM' }) },
        collected: {
          stdout: { readFrom: () => ({ text: phase === 'probe' ? JSON.stringify({ streams: [{ codec_name: 'h264', width: options.wrongSize ? 128 : 256, height: 256, avg_frame_rate: '30/1', nb_read_frames: '2' }], format: { duration: '0.066667' } }) : '' }) },
          stderr: { readFrom: () => ({ text: options.failure === phase ? 'controlled codec failure' : '' }) },
        },
      }
    },
  })
  if (options.jobs) ctx.provide('jobs', options.jobs)
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'), reconcileOnStart: false, maxFinalSamples: options.budget ?? 4096 }))
  const spec = JSON.parse(readFileSync(join(ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json')))
  const project = await studio.transactions.createProject({ title: 'complete-delivery', sceneSpec: spec, saveCheckpoint: false })
  const projectId = project.projectId
  const jobId = 'render-0001'
  const frames = studio.renderJobs.framesDirectory(projectId, jobId)
  mkdirSync(frames, { recursive: true })
  for (const frame of [1, 2]) if (frame !== options.missing) writeFileSync(join(frames, `frame_${String(frame).padStart(4, '0')}.png`), frame === options.corrupt ? Buffer.from('broken') : png)
  const scratch = join(workspaceRoot, 'tmp', 'render-fixture')
  if (options.scratch) { mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, 'scene.blend'), 'scratch') }
  studio.renderJobs.write({ projectId, jobId, type: 'final-render', status: options.status ?? 'failed', revisionId: project.revision.revision, frameStart: 1, frameEnd: 2, expectedFrames: 2, completedFrames: [], missingFrames: [1, 2], corruptFrames: [], fps: 30, attempt: 4, attemptToken: 'original-token', pid: null, dshJobId: null, delivery: { status: 'failed', attempt: 2 }, warnings: [], filePrefix: 'frame_', filePadding: 4, profileName: 'final', renderConfig: { resolution: [256, 256], samples: 12 }, renderDurationMs: 987, checkpointPath: options.scratch ? join(scratch, 'scene.blend') : options.checkpoint ? '/unused-checkpoint.blend' : null })
  const output = join(studio.store.projectDirectory(projectId), 'output')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'final.mp4'), 'old video')
  writeFileSync(join(output, 'delivery-manifest.json'), 'old manifest')
  const request = { projectId, jobId }
  const read = () => studio.renderJobs.read(projectId, jobId)
  t.after(async () => {
    for (const item of Object.values(release)) item.resolve({ exitCode: 0, signal: null })
    await pause()
    await pause()
    rmSync(workspaceRoot, { recursive: true, force: true })
  })
  return { studio, calls, request, read, output, scratch, frames, started, release, requests, workspaceRoot }
}

for (const status of ['failed', 'cancelled', 'recovering', 'queued']) {
  test(`complete ${status} job resumes delivery without checkpoint, Blender, or sample budget`, async t => {
    const w = await fixture(t, { status, budget: 1, scratch: status === 'failed' })
    const result = await w.studio.resumeRenderJob({ ...w.request, samples: 99 })
    assert.equal(result.resumed, 0)
    assert.equal(result.alreadyComplete, 2)
    assert.deepEqual(result.resumedFrames, [])
    await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
    const record = w.read()
    assert.equal(record.status, 'completed')
    assert.equal(record.attempt, 4)
    assert.equal(record.attemptToken, 'original-token')
    assert.equal(record.renderDurationMs, 987)
    assert.equal(record.renderConfig.samples, 12)
    assert.equal(record.delivery.attempt, 3)
    assert.equal(record.delivery.status, 'published')
    assert.deepEqual(w.calls, ['encode', 'probe'])
    assert.deepEqual(record.completedFrames, [1, 2])
    assert.equal(record.pid, null)
    assert.equal(existsSync(w.scratch), false)
    assert.match(result.message, /samples.*not applied/i)
    await assert.rejects(w.studio.resumeRenderJob(w.request), { code: BlenderErrorCode.RENDER_JOB_STATE_INVALID })
  })
}

test('default complete resume bypasses reduced budget; missing and corrupt frames still obey it without changes', async t => {
  const complete = await fixture(t, { budget: 1 })
  await complete.studio.resumeRenderJob(complete.request)
  await waitFor(() => complete.read().status === 'completed')
  for (const option of [{ missing: 2 }, { corrupt: 2 }]) {
    const w = await fixture(t, { ...option, budget: 1 })
    const before = readFileSync(w.studio.renderJobs.recordPath(w.request.projectId, w.request.jobId))
    await assert.rejects(w.studio.resumeRenderJob(w.request), { code: BlenderErrorCode.RENDER_BUDGET_EXCEEDED })
    assert.deepEqual(readFileSync(w.studio.renderJobs.recordPath(w.request.projectId, w.request.jobId)), before)
    assert.deepEqual(w.calls, [])
  }
})

for (const phase of ['encode', 'probe']) {
  test(`cancel during ${phase} waits for exit and prevents publication, then permits retry`, async t => {
    const w = await fixture(t, { hold: phase, scratch: true })
    await w.studio.resumeRenderJob(w.request)
    await w.started[phase].promise
    let settled = false
    const cancellation = w.studio.cancelJob(w.request).then(result => { settled = true; return result })
    await pause()
    assert.equal(w.requests[phase].signal.aborted, true)
    assert.equal(settled, false, 'sending abort is not proof of process exit')
    assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
    w.release[phase].resolve({ exitCode: null, signal: 'SIGTERM' })
    const result = await cancellation
    assert.equal(result.processGone, true)
    assert.equal(result.cancelled, true)
    assert.equal(w.read().status, 'cancelled')
    assert.equal(w.read().delivery.status, 'cancelled')
    assert.equal(w.read().attempt, 4)
    assert.equal(w.read().delivery.attempt, 3)
    assert.equal(w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`), false)
    assert.equal(w.studio._deliveriesInFlight.size, 0)
    assert.equal(readFileSync(join(w.output, 'delivery-manifest.json'), 'utf8'), 'old manifest')
    assert.equal(existsSync(w.scratch), true)
    await w.studio.resumeRenderJob(w.request)
    await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
    assert.equal(w.read().status, 'completed')
    assert.equal(w.read().delivery.attempt, 4)
  })
}

test('two resumes and export serialize at the actual same-job delivery lock', async t => {
  const w = await fixture(t, { hold: 'encode' })
  const first = w.studio.resumeRenderJob(w.request)
  const second = w.studio.resumeRenderJob(w.request)
  await first
  await assert.rejects(second, { code: BlenderErrorCode.RENDER_JOB_CONFLICT })
  await assert.rejects(w.studio.exportProject(w.request), { code: BlenderErrorCode.EXPORT_IN_PROGRESS })
  assert.deepEqual(w.calls, ['encode'])
  assert.equal(w.read().delivery.attempt, 3)
  w.release.encode.resolve({ exitCode: 0, signal: null })
  await waitFor(() => w.read().status === 'completed')
})

test('an export in progress blocks resume before any mutation', async t => {
  const w = await fixture(t, { hold: 'probe' })
  const exported = w.studio.exportProject(w.request)
  await w.started.probe.promise
  const before = w.read()
  await assert.rejects(w.studio.resumeRenderJob(w.request), { code: BlenderErrorCode.EXPORT_IN_PROGRESS })
  assert.deepEqual(w.read(), before)
  w.release.probe.resolve({ exitCode: 0, signal: null })
  assert.equal((await exported).verified, true)
})

test('cancel after completed publication is a no-op and completed export remains supported', async t => {
  const w = await fixture(t)
  await w.studio.resumeRenderJob(w.request)
  await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
  const before = w.read()
  const video = readFileSync(join(w.output, 'final.mp4'))
  const cancelled = await w.studio.cancelJob(w.request)
  assert.equal(cancelled.cancelled, false)
  assert.equal(cancelled.processGone, true)
  assert.deepEqual(w.read(), before)
  assert.deepEqual(readFileSync(join(w.output, 'final.mp4')), video)
  const exported = await w.studio.exportProject(w.request)
  assert.equal(exported.verified, true)
  assert.equal(w.read().delivery.attempt, 4)
})

test('probe verification failure settles background job and releases lock without publishing', async t => {
  const w = await fixture(t, { wrongSize: true, scratch: true })
  await w.studio.resumeRenderJob(w.request)
  await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
  assert.equal(w.read().status, 'failed')
  assert.equal(w.read().delivery.status, 'failed')
  assert.equal(w.read().errorCode, BlenderErrorCode.ENCODE_VERIFY_FAILED)
  assert.equal(w.studio._deliveriesInFlight.size, 0)
  assert.equal(existsSync(w.scratch), true)
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
})

test('stopping or failed reconciliation refuses before changing frames or job', async t => {
  for (const cause of ['stopping', 'orphan-survived', 'recovery-error']) {
    const w = await fixture(t, { status: cause === 'stopping' ? 'stopping' : 'running' })
    if (cause === 'orphan-survived') w.studio._reconciliation = Promise.resolve([{ ...w.request, status: cause }])
    if (cause === 'recovery-error') { w.studio._recoveryError = 'controlled disk failure'; w.studio._reconciliation = Promise.resolve([]) }
    const before = w.read()
    await assert.rejects(w.studio.resumeRenderJob(w.request), { code: BlenderErrorCode.RENDER_JOB_STATE_INVALID })
    assert.deepEqual(w.read(), before)
    assert.deepEqual(w.calls, [])
  }
})


test('explicit samples still applies only to missing frames and does not replace stored defaults', async t => {
  for (const samples of [undefined, 7]) {
    const w = await fixture(t, { missing: 2, checkpoint: true })
    await assert.rejects(w.studio.resumeRenderJob({ ...w.request, ...(samples === undefined ? {} : { samples }) }), /missing frames reached renderer/)
    assert.deepEqual(w.calls, [{ render: [2], samples: samples ?? 12 }])
    assert.equal(w.read().renderConfig.samples, 12)
  }
})

test('missing encoder and failed probe settle failure and retain recovery scratch', async t => {
  for (const option of [{ resolveFailure: true, code: BlenderErrorCode.ENCODER_NOT_FOUND }, { failure: 'probe', code: BlenderErrorCode.PROBE_FAILED }]) {
    const w = await fixture(t, { ...option, scratch: true })
    await w.studio.resumeRenderJob(w.request)
    await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
    assert.equal(w.read().status, 'failed')
    assert.equal(w.read().delivery.status, 'failed')
    assert.equal(w.read().delivery.attempt, 3)
    assert.equal(w.read().errorCode, option.code)
    assert.equal(w.studio._deliveriesInFlight.size, 0)
    assert.equal(existsSync(w.scratch), true)
    assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
  }
})

test('cancel a completed job re-export before publication without erasing its previous delivery', async t => {
  const w = await fixture(t, { status: 'completed', hold: 'probe' })
  const exported = w.studio.exportProject(w.request)
  const rejection = assert.rejects(exported, { code: BlenderErrorCode.ABORTED })
  await w.started.probe.promise
  const cancel = w.studio.cancelJob(w.request)
  await pause()
  assert.equal(w.requests.probe.signal.aborted, true)
  w.release.probe.resolve({ exitCode: null, signal: 'SIGTERM' })
  const result = await cancel
  await rejection
  assert.equal(result.cancelled, true)
  assert.equal(result.processGone, true)
  assert.equal(w.read().status, 'completed')
  assert.equal(w.read().delivery.status, 'cancelled')
  assert.equal(w.read().delivery.attempt, 3)
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
  assert.equal(readFileSync(join(w.output, 'delivery-manifest.json'), 'utf8'), 'old manifest')
})

test('projection cancellation before spawn and during probe uses the same lifecycle', async t => {
  for (const early of [true, false]) {
    let handle
    const w = await fixture(t, { hold: 'probe', jobs: {
      attachController: () => () => {},
      start(request) { handle = request.run(); if (early) handle.cancel('early stop'); return 'dsh-delivery' },
    } })
    await w.studio.resumeRenderJob(w.request)
    if (!early) {
      await w.started.probe.promise
      handle.cancel('stop during probe')
      await pause()
      assert.equal(w.requests.probe.signal.aborted, true)
      w.release.probe.resolve({ exitCode: null, signal: 'SIGTERM' })
    }
    assert.equal((await handle.done).status, 'killed')
    await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
    assert.equal(w.read().status, 'cancelled')
    assert.equal(w.read().dshJobId, 'dsh-delivery')
    assert.deepEqual(w.calls, early ? [] : ['encode', 'probe'])
    assert.equal(w.studio._deliveriesInFlight.size, 0)
  }
})

test('publication bookkeeping failure is durable and retryable without an unhandled background rejection', async t => {
  const w = await fixture(t, { scratch: true })
  const write = w.studio.renderJobs.write.bind(w.studio.renderJobs)
  let failed = false
  w.studio.renderJobs.write = (record, options) => {
    if (record.status === 'completed' && !failed) { failed = true; throw Object.assign(Error('controlled ENOSPC'), { code: 'ENOSPC' }) }
    return write(record, options)
  }
  await w.studio.resumeRenderJob(w.request)
  await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
  assert.equal(w.read().status, 'failed')
  assert.equal(w.read().errorCode, BlenderErrorCode.DISK_FULL)
  assert.equal(w.read().delivery.status, 'failed')
  assert.equal(w.studio._deliveriesInFlight.size, 0)
  assert.equal(existsSync(w.scratch), true)
  // Publication consists of separate atomic files; retry repairs the complete set.
  await w.studio.resumeRenderJob(w.request)
  await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
  assert.equal(w.read().status, 'completed')
  assert.equal(w.read().delivery.attempt, 4)
})

test('inconclusive process cleanup cannot claim successful cancellation or free the encoder lock', async t => {
  let projection
  const w = await fixture(t, { hold: 'encode', rangeFailure: true, jobs: {
    attachController: () => () => {}, start(request) { projection = request.run(); return 'uncertain-delivery' },
  } })
  await w.studio.resumeRenderJob(w.request)
  await w.started.encode.promise
  const cancelled = w.studio.cancelJob(w.request)
  await pause()
  w.release.encode.resolve({ exitCode: null, signal: 'SIGTERM' })
  const result = await cancelled
  assert.equal(result.processGone, false)
  assert.equal(result.cancelled, false)
  assert.equal((await projection.done).status, 'failed')
  assert.equal(w.read().status, 'stopping')
  assert.equal(w.read().delivery.status, 'failed')
  assert.equal(w.studio._deliveriesInFlight.size, 1)
  await assert.rejects(w.studio.exportProject(w.request), { code: BlenderErrorCode.EXPORT_IN_PROGRESS })
  await assert.rejects(w.studio.resumeRenderJob(w.request), { code: BlenderErrorCode.EXPORT_IN_PROGRESS })
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
})


test('cancellation after successful probe but before the synchronous publish commit wins', async t => {
  const w = await fixture(t)
  const sources = w.studio._deliverySources.bind(w.studio)
  let cancellation
  w.studio._deliverySources = (...args) => {
    const result = sources(...args)
    cancellation = w.studio.cancelJob(w.request)
    return result
  }
  await w.studio.resumeRenderJob(w.request)
  await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
  assert.equal((await cancellation).cancelled, true)
  assert.equal(w.read().status, 'cancelled')
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
  assert.equal(readFileSync(join(w.output, 'delivery-manifest.json'), 'utf8'), 'old manifest')
})


test('cancellation observing the completed publish commit cannot undo its success', async t => {
  const w = await fixture(t)
  const write = w.studio.renderJobs.write.bind(w.studio.renderJobs)
  let cancellation
  w.studio.renderJobs.write = (record, options) => {
    const written = write(record, options)
    if (record.status === 'completed') cancellation = w.studio.cancelJob(w.request)
    return written
  }
  await w.studio.resumeRenderJob(w.request)
  await waitFor(() => !w.studio._liveRenders.has(`${w.request.projectId}/${w.request.jobId}`))
  const result = await cancellation
  assert.equal(result.cancelled, false)
  assert.equal(result.processGone, true)
  assert.equal(w.read().status, 'completed')
  assert.equal(w.read().delivery.status, 'published')
  assert.equal(w.read().delivery.attempt, 3)
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'new encoded video')
  assert.equal(JSON.parse(readFileSync(join(w.output, 'delivery-manifest.json'))).video.verified, true)
})

test('a projection bookkeeping write failure settles the new delivery registration before returning', async t => {
  const w = await fixture(t)
  const write = w.studio.renderJobs.write.bind(w.studio.renderJobs)
  let failed = false
  w.studio.renderJobs.write = (record, options) => {
    if (!failed && record.warnings?.some(warning => warning.code === 'JOB_PROJECTION_UNAVAILABLE')) {
      failed = true
      throw Object.assign(Error('controlled projection ENOSPC'), { code: 'ENOSPC' })
    }
    return write(record, options)
  }
  await assert.rejects(w.studio.resumeRenderJob(w.request), { code: BlenderErrorCode.DISK_FULL })
  assert.equal(w.read().status, 'failed')
  assert.equal(w.read().errorCode, BlenderErrorCode.DISK_FULL)
  assert.equal(w.read().attempt, 4)
  assert.equal(w.read().delivery.attempt, 2)
  assert.deepEqual(w.calls, [])
  assert.equal(w.studio._liveRenders.size, 0)
  assert.equal(w.studio._deliveriesInFlight.size, 0)
})


test('cancelling a completed project export never cancels or waits for another project with the same job id', async t => {
  const renderer = defer()
  let rendererRequest, rendererTerminations = 0
  const w = await fixture(t, { status: 'completed', hold: 'encode', runtime: {
    async startFrameSequence(request) {
      rendererRequest = request
      return {
        handle: { done: renderer.promise, terminate() { rendererTerminations += 1 } },
        processPath: join(request.jobDirectory, 'process.json'),
      }
    },
    async awaitFrameSequence() { return renderer.promise },
  } })
  const second = await w.studio.transactions.createProject({
    title: 'independent-render', sceneSpec: w.studio.store.readRevisionSpec(w.request.projectId, w.read().revisionId), saveCheckpoint: false,
  })
  const other = { projectId: second.projectId, jobId: w.request.jobId }
  assert.notEqual(other.projectId, w.request.projectId)
  const otherFrames = w.studio.renderJobs.framesDirectory(other.projectId, other.jobId)
  mkdirSync(otherFrames, { recursive: true })
  writeFileSync(join(otherFrames, 'frame_0001.png'), png)
  w.studio.renderJobs.write({ ...w.read(), ...other, status: 'failed', revisionId: second.revision.revision,
    checkpointPath: '/controlled-other-project.blend', completedFrames: [1], missingFrames: [2], delivery: { status: 'failed', attempt: 0 } })
  await w.studio.resumeRenderJob(other)
  assert.deepEqual(rendererRequest.frames, [2])
  const otherBefore = w.studio.renderJobs.read(other.projectId, other.jobId)
  const exported = w.studio.exportProject(w.request).then(value => ({ value }), error => ({ error }))
  await w.started.encode.promise
  let cancellationFinished = false
  const cancellation = w.studio.cancelJob(w.request).then(result => { cancellationFinished = true; return result })
  await pause()
  assert.equal(w.requests.encode.signal.aborted, true)
  w.release.encode.resolve({ exitCode: null, signal: 'SIGTERM' })
  await exported
  // The unrelated renderer is deliberately still unresolved. Record whether A
  // settles now, then finish B even on the old failure path to leave no work live.
  for (let n = 0; n < 20 && !cancellationFinished; n += 1) await new Promise(resolve => setTimeout(resolve, 5))
  const finishedBeforeOtherRenderer = cancellationFinished
  const otherDuring = w.studio.renderJobs.read(other.projectId, other.jobId)
  writeFileSync(join(otherFrames, 'frame_0002.png'), png)
  renderer.resolve({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 12 })
  const cancelled = await cancellation
  await waitFor(() => ['completed', 'cancelled', 'failed'].includes(w.studio.renderJobs.read(other.projectId, other.jobId).status))
  const otherAfter = w.studio.renderJobs.read(other.projectId, other.jobId)
  assert.deepEqual({ finishedBeforeOtherRenderer, otherStatus: otherAfter.status, rendererTerminations },
    { finishedBeforeOtherRenderer: true, otherStatus: 'completed', rendererTerminations: 0 })
  assert.deepEqual(otherDuring, otherBefore, 'cancelling A must not rewrite B while B is running')
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.processGone, true)
  assert.equal((await exported).error?.code, BlenderErrorCode.ABORTED)
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
  assert.equal(readFileSync(join(w.output, 'delivery-manifest.json'), 'utf8'), 'old manifest')
})

test('finishing a complete-frame delivery leaves another project renderer live and independently cancellable', async t => {
  const renderer = defer()
  let rendererTerminations = 0
  const stopped = { envelope: null, exitCode: null, signal: 'SIGTERM', durationMs: 12 }
  const w = await fixture(t, { runtime: {
    async startFrameSequence(request) {
      return { handle: { done: renderer.promise, terminate() { rendererTerminations += 1; renderer.resolve(stopped) } },
        processPath: join(request.jobDirectory, 'process.json') }
    },
    async awaitFrameSequence() { return renderer.promise },
  } })
  const second = await w.studio.transactions.createProject({
    title: 'still-rendering', sceneSpec: w.studio.store.readRevisionSpec(w.request.projectId, w.read().revisionId), saveCheckpoint: false,
  })
  const other = { projectId: second.projectId, jobId: w.request.jobId }
  const otherFrames = w.studio.renderJobs.framesDirectory(other.projectId, other.jobId)
  mkdirSync(otherFrames, { recursive: true })
  writeFileSync(join(otherFrames, 'frame_0001.png'), png)
  w.studio.renderJobs.write({ ...w.read(), ...other, status: 'failed', revisionId: second.revision.revision,
    checkpointPath: '/controlled-other-project.blend', completedFrames: [1], missingFrames: [2] })
  try {
    await w.studio.resumeRenderJob(other)
    const delivered = await w.studio.resumeRenderJob(w.request)
    assert.equal(delivered.resumed, 0)
    await waitFor(() => w.read().status === 'completed')
    assert.equal(w.studio.renderJobs.read(other.projectId, other.jobId).status, 'running')
    await assert.rejects(w.studio.resumeRenderJob(other), { code: BlenderErrorCode.RENDER_JOB_CONFLICT })
    const cancelled = await w.studio.cancelJob(other)
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.processGone, true)
    assert.equal(rendererTerminations, 1)
    assert.equal(w.studio.renderJobs.read(other.projectId, other.jobId).status, 'cancelled')
    assert.equal(w.read().status, 'completed')
    assert.equal(w.studio._liveRenders.size, 0)
    assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'new encoded video')
  } finally {
    renderer.resolve(stopped)
    await pause(); await pause()
  }
})


for (const missingFrame of [false, true]) {
  test(`registered projection settles when its first durable id write fails (${missingFrame ? 'render' : 'delivery'})`, async t => {
    let projected
    const w = await fixture(t, { ...(missingFrame ? { missing: 2, checkpoint: true } : {}), jobs: {
      attachController: () => () => {},
      start(request) { projected = request.run(); return 'registered-before-write' },
    } })
    const write = w.studio.renderJobs.write.bind(w.studio.renderJobs)
    let injected = false
    w.studio.renderJobs.write = (record, options) => {
      if (!injected && record.dshJobId === 'registered-before-write') {
        injected = true
        throw Object.assign(Error('controlled registered-id ENOSPC'), { code: 'ENOSPC' })
      }
      return write(record, options)
    }
    const outcome = await w.studio.resumeRenderJob(w.request).then(value => ({ value }), error => ({ error }))
    await pause(); await pause()
    const projection = await Promise.race([projected.done,
      new Promise(resolve => setTimeout(() => resolve({ status: 'still-pending' }), 100))])
    assert.deepEqual({ code: outcome.error?.code ?? null, projection: projection.status },
      { code: BlenderErrorCode.DISK_FULL, projection: 'failed' })
    assert.equal(w.read().status, 'failed')
    assert.equal(w.read().dshJobId, 'registered-before-write')
    assert.equal(w.read().warnings.some(warning => warning.code === 'JOB_PROJECTION_UNAVAILABLE'), false)
    assert.deepEqual(w.calls, [])
    assert.equal(w.studio._liveRenders.size, 0)
    assert.equal(w.studio._deliveriesInFlight.size, 0)
  })
}

test('a failed re-encode cannot probe or publish an earlier encoded file', async t => {
  const w = await fixture(t, { status: 'completed', failure: 'encode', skipEncodeWrite: true })
  const encodedDirectory = join(w.studio.renderJobs.jobDirectory(w.request.projectId, w.request.jobId), 'encoded')
  mkdirSync(encodedDirectory, { recursive: true })
  writeFileSync(join(encodedDirectory, `${w.request.jobId}.mp4`), 'earlier encoded output')
  await assert.rejects(w.studio.exportProject(w.request), { code: BlenderErrorCode.ENCODE_FAILED })
  assert.deepEqual(w.calls, ['encode'], 'failed encoding must not use a successful probe of old bytes')
  assert.equal(w.read().status, 'completed')
  assert.equal(w.read().delivery.status, 'failed')
  assert.equal(w.read().errorCode, BlenderErrorCode.ENCODE_FAILED)
  assert.equal(readFileSync(join(w.output, 'final.mp4'), 'utf8'), 'old video')
  assert.equal(readFileSync(join(w.output, 'delivery-manifest.json'), 'utf8'), 'old manifest')
  assert.equal(w.studio._deliveriesInFlight.size, 0)
})
