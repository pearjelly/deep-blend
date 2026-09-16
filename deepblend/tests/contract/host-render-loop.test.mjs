#!/usr/bin/env node
/**
 * The render loop: what a Host does around a render nobody is watching.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `_launchRenderer` starts a renderer and hands the rest to `_driveRender`, which keeps the durable
 * record true while the process runs and then delivers. The M3 suites drive that end to end with a REAL
 * Blender, which means they only ever see the branches a healthy machine produces. What was dark is
 * everything around it: a composition with **no `jobs` service** (so the render has no harness
 * projection and must SAY so), a `jobs.start` that **throws** (the render is unaffected and the record
 * must say that too), a render **cancelled between the record write and the spawn** (the child exists
 * and must not be left behind), the child's journal (frames, failed frames, and a line that is not
 * JSON), a render cancelled mid-flight, and a failure that is classified.
 *
 * The runtime is the seam, so it is a stub: `startFrameSequence` returns a handle and writes the
 * journal exactly as the provider's child would, and `awaitFrameSequence` decides the outcome. The
 * store, the frames and the job records are real, and the delivery half uses the same stub subprocess
 * the encoder round uses.
 *
 * ONE BRANCH IS DEAD RATHER THAN DARK, and it is named here: the `.catch` on the background
 * `void this._driveRender(...)` call. `_driveRender` promises never to throw — its own catch settles
 * the record and survives a full disk — so the wrapper is a guard against a promise, not a path any
 * input reaches.
 *
 * Run standalone: `node deepblend/tests/contract/host-render-loop.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { ROOT } from '../../tools/workspace-layout.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BlenderErrorCode.${name} is not a code this build defines — the expectation would be undefined`)
  }
  return value
}

const productSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))
const [FRAME_WIDTH, FRAME_HEIGHT] = productSpec.renderProfiles.final.resolution
const framePng = encodePng(createImage(FRAME_WIDTH, FRAME_HEIGHT, [30, 90, 200, 255]))

const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(settle => setTimeout(settle, 20))
  }
  return false
}

/**
 * One render, start to finish, with every seam under the test's control.
 *
 * `plan` decides what the "renderer" does: the journal it writes, whether the file sequence starts at
 * all, what `awaitFrameSequence` answers, and whether the delivery's ffmpeg/ffprobe stub produces a
 * video that agrees with the job.
 */
function harness(plan = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-render-loop-'))
  const stdout = []
  const spawned = []
  let resolveOutcome = null
  const outcome = new Promise(resolve => { resolveOutcome = resolve })

  const runtime = {
    async compileScene(request) {
      const directory = join(request.projectRoot, 'stub-compile')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'result.blend'), 'a blend file, honest')
      request.onWorkingDirectory?.({ directory })
      return { report: { validation: {} }, envelope: { warnings: [], notices: [] } }
    },
    async startFrameSequence(request) {
      // The child's own artifacts: the frames it rendered, the journal it appends to, and the identity
      // document it writes. The FRAMES have to be written here rather than in the fixture: the job id
      // (and with it the frames directory) is allocated by `startFinalRender`, and a fixture that
      // guessed it also made the product allocate a different one.
      const framesDirectory = join(request.jobDirectory, 'frames')
      mkdirSync(framesDirectory, { recursive: true })
      for (const frame of plan.renderFrames ?? request.frames) {
        writeFileSync(join(framesDirectory, `frame_${String(frame).padStart(4, '0')}.png`), framePng)
      }
      writeFileSync(join(request.jobDirectory, 'events.jsonl'), plan.journal ?? '', 'utf8')
      writeFileSync(join(request.jobDirectory, 'process.json'), JSON.stringify({
        pid: process.pid, attemptToken: request.attemptToken, command: 'stub renderer',
      }), 'utf8')
      return {
        handle: {
          terminate() {
            stdout.push('terminated')
            if (plan.terminateThrows === true) throw new Error('the handle was already released')
          },
          get done() { return Promise.resolve({ exitCode: plan.exitCode ?? 0, signal: null }) },
        },
        jobDirectory: request.jobDirectory,
        framesDirectory: join(request.jobDirectory, 'frames'),
        requestPath: join(request.jobDirectory, 'request.json'),
        planPath: join(request.jobDirectory, 'plan.json'),
        resultPath: join(request.jobDirectory, 'result.json'),
        eventsPath: join(request.jobDirectory, 'events.jsonl'),
        processPath: join(request.jobDirectory, 'process.json'),
        argv: ['/stub/blender'],
        startedAt: Date.now(),
        executable: '/stub/blender',
      }
    },
    async awaitFrameSequence() {
      if (plan.outcomeThrows !== undefined) throw plan.outcomeThrows
      return plan.holdUntilCancel === true ? outcome : (plan.outcome ?? { envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 12 })
    },
  }

  const ctx = new Context()
  ctx.provide('blenderRuntime', runtime)
  ctx.provide('subprocess', {
    async resolveExecutable(requested) { return requested },
    spawn(request) {
      spawned.push(request)
      const isProbe = request.argv.some(argument => String(argument).includes('ffprobe'))
      if (!isProbe) writeFileSync(request.argv[request.argv.length - 1], Buffer.from('a pretend mp4'))
      const stream = { codec_name: 'h264', width: FRAME_WIDTH, height: FRAME_HEIGHT, avg_frame_rate: '30/1', r_frame_rate: '30/1', nb_frames: '2', nb_read_frames: plan.probedFrames ?? '2', duration: '0.066667' }
      return {
        get done() { return Promise.resolve({ exitCode: 0, signal: null }) },
        collected: {
          stdout: { readFrom: () => ({ text: isProbe ? JSON.stringify({ streams: [stream], format: { duration: '0.066667' } }) : '' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  })
  if (plan.jobs !== undefined) ctx.provide('jobs', plan.jobs)
  if (plan.logger !== undefined) ctx.provide('logger', plan.logger)

  const studio = new BlenderStudio(ctx, StudioConfig({
    workspaceRoot,
    projectsRoot: join(workspaceRoot, 'projects'),
    progressPollMs: plan.progressPollMs ?? 20,
  }))
  return { studio, workspaceRoot, stdout, spawned, resolveOutcome, dispose: () => rmSync(workspaceRoot, { recursive: true, force: true }) }
}

/** A project with a real checkpoint, two frames on disk, and a job ready to run. */
async function fixture(plan) {
  const world = harness(plan)
  const project = await world.studio.transactions.createProject({
    title: 'render-loop', sceneSpec: productSpec, saveCheckpoint: true,
  })
  const projectId = project.projectId
  const revision = project.revision.revision
  // Neither the job record nor the frames are written here: the record would make this fixture an
  // "active render" (`startFinalRender` then refuses with RENDER_JOB_CONFLICT, which is the
  // single-renderer rule doing its job), and the frames belong to a job id the product allocates.
  return { ...world, projectId, revision }
}

// ---------------------------------------------------------------------------
// No jobs service: the render still runs, and says what is missing
// ---------------------------------------------------------------------------

{
  const world = await fixture({})
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const settled = await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a render in a composition with no `jobs` service still runs, and records why it is not in the job list',
    started.dshJobId === null && settled && record.status === 'completed' &&
    record.warnings.some(entry => entry.code === 'JOB_PROJECTION_UNAVAILABLE' &&
      entry.message === 'no `jobs` service is composed in this process, so this render has no DSH background-job ' +
        'projection; progress is still recorded durably and readable through blender_job_status.'),
    { dshJobId: started.dshJobId, status: record.status, warnings: record.warnings.map(entry => entry.code) })
  world.dispose()
}

// ---------------------------------------------------------------------------
// A jobs service that refuses to project: the render is unaffected
// ---------------------------------------------------------------------------

{
  const world = await fixture({
    jobs: { attachController: () => () => {}, start() { throw new Error('no controller serves owner "deepblend"') } },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a `jobs.start` that throws does NOT fail the render: the record carries the warning instead',
    started.dshJobId === null && record.status === 'completed' &&
    record.warnings.some(entry => entry.code === 'JOB_PROJECTION_UNAVAILABLE' &&
      entry.message === 'this render could not be registered as a DSH background job (Error: no controller serves owner "deepblend"), ' +
        'so it will not appear in the harness job list. The render itself is unaffected and its durable record is ' +
        'still authoritative.'),
    record.warnings.map(entry => entry.message))
  world.dispose()
}

// ---------------------------------------------------------------------------
// A working projection: the handle the harness gets, and what it can do
// ---------------------------------------------------------------------------

{
  let cancelEarly = false
  let runHandle = null
  let dshJobId = null
  const world = await fixture({
    journal: '{"type":"frame","frame":1,"ms":5}\n{"type":"frame","frame":2,"ms":7}\n',
    jobs: {
      attachController: () => () => {},
      start(request) {
        runHandle = request.run()
        dshJobId = 'dsh-job-1'
        if (cancelEarly) runHandle.cancel('the operator changed their mind')
        return dshJobId
      },
    },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  const output = runHandle?.readOutput() ?? ''
  check('with a `jobs` service the render is projected, and the id lands on the durable record',
    started.dshJobId === 'dsh-job-1' && record.dshJobId === 'dsh-job-1' && record.status === 'completed',
    { started: started.dshJobId, record: record.dshJobId, status: record.status })
  check('the harness can read the render\'s output, and reading it DRAINS it (one reader, one delivery)',
    output.includes('frame 1 rendered (5 ms)') && output.includes('frame 2 rendered (7 ms)') &&
    output.includes('all 2 frame(s) rendered; encoding the delivery') &&
    runHandle.readOutput() === '',
    output.split('\n').filter(Boolean).slice(0, 3))
  world.dispose()
}

// ---------------------------------------------------------------------------
// Cancelled between the record write and the spawn
// ---------------------------------------------------------------------------

{
  let cancelEarly = true
  let runHandle = null
  const world = await fixture({
    terminateThrows: true,
    jobs: {
      attachController: () => () => {},
      start(request) {
        runHandle = request.run()
        runHandle.cancel('cancelled before the renderer existed')
        return 'dsh-job-2'
      },
    },
  })
  const world2 = world
  const started2 = await world2.studio.startFinalRender({ projectId: world2.projectId, revision: world2.revision, frames: [1, 2] })
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(world2.studio.renderJobs.readSafe(world2.projectId, started2.jobId)?.status))
  const record = world2.studio.renderJobs.read(world2.projectId, started2.jobId)
  check('a render cancelled between the record write and the spawn still TERMINATES the child it just started',
    world2.stdout.includes('terminated'), world2.stdout)
  check('and a handle that refuses a second terminate does not break the cancel path',
    record.status === 'cancelled' && /^cancelled: /.test(record.message ?? ''),
    { status: record.status, message: record.message })
  world.dispose()
}

// ---------------------------------------------------------------------------
// The child's journal: what the model is told about frames it cannot see
// ---------------------------------------------------------------------------

{
  const world = await fixture({
    journal: '{"type":"frame","frame":1,"ms":5}\n' +
      '{"type":"frame_failed","frame":2,"error":"the frame was truncated"}\n' +
      'this line is not json at all\n' +
      '{"type":"frame","frame":2,"ms":9}\n',
    jobs: { attachController: () => () => {}, start: request => { world.runHandle = request.run(); return 'dsh-job-3' } },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const output = world.runHandle?.readOutput() ?? ''
  check('the journal is folded into the render\'s output, including a frame that FAILED',
    output.includes('frame 1 rendered (5 ms)') &&
    output.includes('frame 2 FAILED: the frame was truncated'),
    output.split('\n').filter(Boolean))
  check('and a journal line that is not JSON is reported as a WRITER defect, not as a torn kill',
    output.includes('the render journal contained a complete but unparseable line — a defect in the writer, not a torn kill'),
    output.split('\n').filter(line => line.includes('unparseable')))
  world.dispose()
}

{
  // A journal whose last line never finished: the writer stopped, nothing was cancelled, and the
  // renderer did not exit cleanly. That is what a kill between the write and the flush leaves behind.
  const base = '{"type":"frame","frame":1,"ms":5}\n{"type":"fra'
  const world = await fixture({
    journal: base,
    renderFrames: [1],
    outcome: { envelope: { status: 'error', error: { code: 'BLENDER_SCRIPT_ERROR', message: 'killed' } }, exitCode: 137, signal: null, durationMs: 30 },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status === 'failed')
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a render killed with frames still owed is failed, naming the frames and the resume hint',
    record.status === 'failed' && record.errorCode === code('SCRIPT_ERROR') &&
    /1 frame\(s\) remain and can be resumed with blender_final_render \{resumeJobId: "render-0001"\}/.test(record.message ?? '') &&
    JSON.stringify(record.missingFrames) === JSON.stringify([2]),
    { status: record.status, code: record.errorCode, message: record.message })
  world.dispose()
}

// ---------------------------------------------------------------------------
// A delivery that disagrees with the job, and a full disk
// ---------------------------------------------------------------------------

{
  const world = await fixture({ probedFrames: '1' })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a video that disagrees with the job fails the DELIVERY, and the record keeps the job failed',
    record.status === 'failed' && record.delivery?.status === 'failed' &&
    record.delivery?.problems?.some(problem => problem.field === 'frameCount'),
    { status: record.status, delivery: record.delivery?.status, problems: record.delivery?.problems?.map(problem => problem.field) })
  world.dispose()
}

{
  // `isStorageExhausted` reads the error ITSELF: an ENOSPC wrapped as somebody's `cause` is a
  // different question, and the first version of this case asked that one.
  const exhausted = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
  const world = await fixture({ outcomeThrows: exhausted })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status === 'failed')
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a full disk is classified as DISK_FULL rather than as a generic script error',
    record.status === 'failed' && record.errorCode === code('DISK_FULL'),
    { status: record.status, code: record.errorCode })
  check('and the renderer is terminated on the way out, because a Host that gives up is not allowed to leave one running',
    world.stdout.includes('terminated'), world.stdout)
  world.dispose()
}

// ---------------------------------------------------------------------------
// Resuming a job that is mid-render, and a cancellation that settled first
// ---------------------------------------------------------------------------

{
  // `holdUntilCancel` parks the render inside `awaitFrameSequence`, so the live handle is non-null and
  // stays non-null until this test lets go. That is the state `resumeRenderJob` has to refuse: a second
  // renderer for one job would write the same frame files twice.
  const world = await fixture({ holdUntilCancel: true })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const conflict = await world.studio.resumeRenderJob({ projectId: world.projectId, jobId: started.jobId }).catch(cause => cause)
  check('resuming a job whose renderer is running in THIS Host is refused by name rather than raced',
    conflict instanceof BlenderError && conflict.code === code('RENDER_JOB_CONFLICT') &&
    conflict.message === `Render job ${started.jobId} is already running in this Host.` &&
    conflict.detail?.jobId === started.jobId,
    conflict?.message ?? conflict)
  world.resolveOutcome({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 12 })
  const settled = await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  check('and the render that refused to be resumed still finishes on its own',
    settled && world.studio.renderJobs.read(world.projectId, started.jobId).status === 'completed',
    world.studio.renderJobs.read(world.projectId, started.jobId).status)
  world.dispose()
}

{
  // TWO SETTLERS, ONE CANCELLATION. `cancelJob` writes the terminal record and the render loop settles
  // the record it is driving; whichever arrives second must not write a second, possibly disagreeing,
  // account. Which one arrives second is a race, so it is ARRANGED here instead of gambled: the record
  // is settled as `cancelJob` settles it and the live flag is set as `cancelJob` sets it, and only then
  // does the renderer report success.
  const world = await fixture({
    holdUntilCancel: true,
    jobs: { attachController: () => () => {}, start: request => { world.runHandle = request.run(); return 'dsh-job-cancel' } },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const live = world.studio._liveRenders.get(started.jobId)
  live.cancelled = true
  live.cancelReason = 'the operator closed the laptop'
  const preSettled = world.studio.renderJobs.write({
    ...world.studio.renderJobs.read(world.projectId, started.jobId),
    status: 'cancelled', cancelledAt: Date.now(), finishedAt: Date.now(), errorCode: null,
    message: 'cancelled: the operator closed the laptop',
  }, { previous: world.studio.renderJobs.read(world.projectId, started.jobId) })
  world.resolveOutcome({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 40 })
  let output = ''
  await waitFor(() => {
    output += world.runHandle?.readOutput() ?? ''
    return world.studio._liveRenders.has(started.jobId) === false
  })
  const after = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a cancellation that already settled the record is not rewritten when the renderer then reports success',
    after.status === 'cancelled' && after.message === preSettled.message &&
    JSON.stringify(after.completedFrames) === JSON.stringify(preSettled.completedFrames),
    { status: after.status, message: after.message, completedFrames: after.completedFrames })
  check('and the loop still says out loud that the render it was driving was cancelled',
    output.includes(`render job ${started.jobId} cancelled`), output.split('\n').filter(Boolean))
  const again = await world.studio.cancelJob({ projectId: world.projectId, jobId: started.jobId })
  check('cancelling an already cancelled job answers as a no-op, and still reports the process gone',
    again.cancelled === false && again.processGone === true && again.reason === 'the render job is already cancelled',
    again)
  // The frames this cancelled render wrote are complete, so resuming it is not a re-render: the honest
  // answer is that there is nothing left to walk. It is a real state a model reaches by cancelling a
  // render whose frames had all landed.
  const resume = await world.studio.resumeRenderJob({ projectId: world.projectId, jobId: started.jobId })
  check('resuming a cancelled job whose frames all landed says there is nothing left to render',
    resume.resumed === 0 && resume.alreadyComplete === 2 &&
    resume.message === 'Every frame is already present and complete; the job is finishing its delivery instead of re-rendering.',
    { resumed: resume.resumed, alreadyComplete: resume.alreadyComplete, message: resume.message })
  world.dispose()
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost render loop: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
