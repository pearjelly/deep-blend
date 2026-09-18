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
 * LATER ROUNDS ADDED THE FAILURES AROUND THE BOOKKEEPING ITSELF, which is where the expensive defects
 * live: a job registry whose `attachController` throws (the render must not care, and the warning must
 * name THAT reason rather than "no `jobs` service is composed"), a renderer that exits nonzero with no
 * error document at all (classified from the exit code), a progress tick whose write fails (reported
 * once, and the render keeps going), the write that would record the failure failing too (the renderer
 * still stops, the failure is still said out loud, the record keeps the status it had), resuming a job
 * whose renderer is running in THIS Host, cancelling a job whose record another settler already
 * settled, and a cancel whose DSH projection refuses to be killed.
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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  let compileCount = 0
  const runtime = {
    async compileScene(request) {
      // Counted because a compile is a real Blender launch: a delivery that re-resolves its checkpoint instead of
      // reusing the one the render recorded pays for a SECOND one, and the cost is the point of the assertion.
      compileCount += 1
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
      //
      // The directory is recorded on the plan as well, because a test that wants a SECOND journal line
      // (to make a progress tick fail twice) has to append to the file the child is writing.
      plan.jobDirectory = request.jobDirectory
      // The checkpoint the renderer was actually told to open: the whole point of resolving one for a record
      // that predates the field is that a REAL path reaches the renderer, not `null`.
      plan.lastCheckpointPath = request.checkpointPath
      const framesDirectory = join(request.jobDirectory, 'frames')
      mkdirSync(framesDirectory, { recursive: true })
      for (const frame of plan.renderFrames ?? request.frames) {
        writeFileSync(join(framesDirectory, `frame_${String(frame).padStart(4, '0')}.png`), framePng)
      }
      writeFileSync(join(request.jobDirectory, 'events.jsonl'), plan.journal ?? '', 'utf8')
      // The identity document is what lets a later tick record the child's pid. A test that wants to
      // count PROGRESS failures separately from that pid write leaves it out.
      if (plan.writeProcessIdentity !== false) {
        writeFileSync(join(request.jobDirectory, 'process.json'), JSON.stringify({
          pid: process.pid, attemptToken: request.attemptToken, command: 'stub renderer',
        }), 'utf8')
      }
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
    // A test that patches the record store needs a Host that is not ALSO running its startup
    // reconciliation, which writes a reconciled record for the very render being measured.
    ...(plan.config ?? {}),
  }))
  return { studio, workspaceRoot, stdout, spawned, resolveOutcome, compiles: () => compileCount, dispose: () => rmSync(workspaceRoot, { recursive: true, force: true }) }
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
  // The record keeps the DISAGREEMENT itself, both numbers included: a reader who opens the job after the
  // process is gone has to be able to see what the verifier saw, not just that something failed. (The
  // sentence that names the problems as JSON belongs to `exportProject`'s answer, which is a DIFFERENT
  // message — `_deliverJob`'s own line here spells out each problem in words instead.)
  check('and the record keeps the disagreement with both numbers, so it outlives the process that found it',
    record.errorCode === code('ENCODE_VERIFY_FAILED') &&
    record.delivery?.problems?.some(problem => problem.field === 'frameCount' && problem.claimed === 2 && problem.probed === 1) &&
    /claimed 2 but probed 1/.test(record.message ?? ''),
    { code: record.errorCode, problems: record.delivery?.problems, message: record.message })
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
// A job registry that cannot attach, and a failure classification with no error document
// ---------------------------------------------------------------------------

{
  // `attachController` is the registry's own handshake, and it can throw (a composition whose
  // controller comes from a service that is not up yet). The render must not care — and the warning
  // must not tell the model that no `jobs` service is composed, because there is one.
  const world = await fixture({
    jobs: { attachController() { throw new Error('the job registry is not accepting controllers yet') } },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const settled = await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a job registry whose controller refuses to attach does not fail the render, and the record names THAT reason',
    started.dshJobId === null && settled && record.status === 'completed' &&
    record.warnings.some(entry => entry.code === 'JOB_PROJECTION_UNAVAILABLE' &&
      entry.message === 'this render could not be registered as a DSH background job (the job controller could not ' +
        'be attached: the job registry is not accepting controllers yet), so it will not appear in the harness job ' +
        'list. The render itself is unaffected and its durable record is still authoritative.'),
    { dshJobId: started.dshJobId, status: record.status, warnings: record.warnings.map(entry => entry.message) })
  world.dispose()
}

{
  // No error document at all, a nonzero exit, and frames still owed: the code has to be classified from
  // what IS there (a death by exit code) rather than from a document the renderer never wrote.
  const world = await fixture({
    journal: '{"type":"frame","frame":1,"ms":5}\n',
    renderFrames: [1],
    outcome: { envelope: { status: 'error', error: null }, exitCode: 1, signal: null, durationMs: 30 },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status === 'failed')
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a renderer that exits nonzero with no error document is classified NONZERO_EXIT, and the message says so',
    record.status === 'failed' && record.errorCode === code('NONZERO_EXIT') &&
    record.message === 'the renderer exited 1 before every frame was written: no error document was produced; ' +
      `1 frame(s) remain and can be resumed with blender_final_render {resumeJobId: "${started.jobId}"}`,
    { code: record.errorCode, message: record.message })
  world.dispose()
}

// ---------------------------------------------------------------------------
// Bookkeeping that fails: a progress tick, and the failure record itself
// ---------------------------------------------------------------------------

{
  // A progress tick that fails must not stop the render, and it must be said ONCE: a swallowed error is
  // indistinguishable from a tick with nothing to do, and one line per tick would bury the render.
  // Two failures are arranged (a second journal line, so the second tick has something to write) and the
  // count of failed writes is measured, so "reported once" is a claim with evidence rather than a hope.
  const plan = {
    progressPollMs: 20,
    holdUntilCancel: true,
    // No identity document: the pid write is swallowed by its own `catch` ("mid-write; the next tick
    // re-reads it"), so leaving it in would let ONE tick fail twice and make `failedWrites >= 2` true
    // before a second PROGRESS failure had happened — which is how the first version of this check
    // passed without ever exercising the "reported once" guard.
    writeProcessIdentity: false,
    config: { reconcileOnStart: false },
    journal: '{"type":"frame","frame":1,"ms":5}\n',
    jobs: { attachController: () => () => {}, start: request => { world.runHandle = request.run(); return 'dsh-job-progress' } },
  }
  const world = await fixture(plan)
  // The render is parked inside `awaitFrameSequence`, so the poller is the only thing running and its
  // writes are the only ones this patch can affect. It is installed AFTER `startFinalRender` because
  // that call writes the job's own record first: a patch installed before it fails the render before
  // anything can be measured.
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const store = world.studio.renderJobs
  const realWrite = store.write.bind(store)
  let failing = true
  // Counted by CALL SITE, not by total: the first version counted every failed write, and a
  // reconciliation record written by the Host itself made the count reach two before a second progress
  // tick had failed — so the check passed without ever exercising the guard it was written for.
  let progressWritesFailed = 0
  store.write = (...args) => {
    if (failing) {
      if ((new Error('write').stack ?? '').includes('_absorbProgress')) progressWritesFailed += 1
      throw new Error('ENOSPC: no space left on device')
    }
    return realWrite(...args)
  }
  let output = ''
  const sawFirstFailure = await waitFor(() => {
    output += world.runHandle?.readOutput() ?? ''
    return output.includes('progress reporting failed:')
  })
  appendFileSync(join(plan.jobDirectory, 'events.jsonl'), '{"type":"frame","frame":2,"ms":7}\n')
  const sawSecondFailure = await waitFor(() => progressWritesFailed >= 2)
  world.output = output
  check('a progress tick that cannot write the record is reported, and the render keeps going',
    sawFirstFailure && sawSecondFailure && progressWritesFailed === 2 &&
    world.output.includes('progress reporting failed: Error: ENOSPC: no space left on device') &&
    world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status === 'running',
    { progressWritesFailed, lines: world.output.split('\n').filter(line => line.includes('progress reporting')) })
  // The count is taken AFTER the render is over, and that is the point: sampled the moment the second
  // write failed, the second report may not have been appended yet — which is exactly how the first
  // version of this check passed with the "report it once" guard deleted.
  failing = false
  world.resolveOutcome({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 12 })
  const finished = await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  world.output = (world.output ?? '') + (world.runHandle?.readOutput() ?? '')
  check('and two failed writes are reported ONCE, because one line per tick would bury the render',
    progressWritesFailed === 2 && (world.output.match(/progress reporting failed:/g) ?? []).length === 1,
    { progressWritesFailed, lines: world.output.split('\n').filter(line => line.includes('progress reporting')) })
  check('and the render that lost its bookkeeping still finishes and delivers',
    finished && world.studio.renderJobs.read(world.projectId, started.jobId).status === 'completed',
    world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status)
  world.dispose()
}

{
  // THE CASE THE DOC COMMENT ON `_driveRender` IS ABOUT. A full disk is exactly when the record cannot
  // be written, so the record must not be the thing that fails: the renderer is stopped, the failure is
  // said out loud on the job's output, and the live job is settled. The record keeps its previous status,
  // which is the honest state — nothing here can record an answer.
  const world = await fixture({
    progressPollMs: 10_000,
    holdUntilCancel: true,
    journal: '{"type":"frame","frame":1,"ms":5}\n',
    renderFrames: [1],
    jobs: { attachController: () => () => {}, start: request => { world.runHandle = request.run(); return 'dsh-job-unwritable' } },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const store = world.studio.renderJobs
  const realWrite = store.write.bind(store)
  store.write = () => { throw new Error('ENOSPC: no space left on device') }
  world.resolveOutcome({ envelope: { status: 'error', error: { code: 'BLENDER_SCRIPT_ERROR', message: 'killed' } }, exitCode: 137, signal: null, durationMs: 30 })
  const said = await waitFor(() => {
    world.output = (world.output ?? '') + (world.runHandle?.readOutput() ?? '')
    return world.output.includes(`render job ${started.jobId} failed:`)
  })
  const left = world.studio.renderJobs.readSafe(world.projectId, started.jobId)
  // The FULL-DISK story, and the order it happens in: the tick's own write fails first (the frame that
  // just landed cannot be recorded), that failure reaches the driver's catch, `isStorageExhausted` calls it
  // DISK_FULL, and then the write that would RECORD the failure fails too. What is left is the process
  // stopped, the harness told, and a record that still says what it said before.
  check('a failure that cannot be recorded is still said out loud, and the live job is settled anyway',
    said && world.output.includes(`render job ${started.jobId} failed: ENOSPC: no space left on device`) &&
    world.stdout.includes('terminated'),
    world.output?.split('\n').filter(Boolean))
  check('and the record keeps the status it had, because nothing could record the failure',
    left !== null && left.status === 'running' && left.errorCode === null && world.studio._liveRenders.has(started.jobId) === false,
    { status: left?.status, errorCode: left?.errorCode, live: world.studio._liveRenders.has(started.jobId) })
  store.write = realWrite
  world.dispose()
}

{
  // `cancelJob` kills the DSH projection FIRST, and a projection that refuses to be killed (already
  // settled, or gone with a previous Host) must not stop the process cancellation.
  const world = await fixture({
    holdUntilCancel: true,
    jobs: {
      attachController: () => () => {},
      start: request => { world.runHandle = request.run(); return 'dsh-job-kill-refused' },
      kill() { throw new Error('the projection is already gone') },
    },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  const cancelling = world.studio.cancelJob({ projectId: world.projectId, jobId: started.jobId, reason: 'the operator went home' })
  world.resolveOutcome({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 40 })
  const report = await cancelling
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a projection that refuses to be killed does not stop the process cancellation',
    report.cancelled === true && report.processGone === true && report.process?.via === 'subprocess-handle' &&
    record.status === 'cancelled' && record.message === 'cancelled: the operator went home' && world.stdout.includes('terminated'),
    { report, status: record.status, stdout: world.stdout })
  world.dispose()
}

// NAMED, NOT PRETENDED COVERED: `_appendOutput` is a string concatenation with a cap, and its own `try/catch`
// ("the journal lives on the same volume the frames do") cannot be made to throw from a test: `live.output +=
// text` on a string property has no failure mode short of running out of memory. It is a belt for the day the
// buffer becomes a file, and it is written down rather than left looking covered.

// ---------------------------------------------------------------------------
// A delivery that was COMPILED for this render, and says so
// ---------------------------------------------------------------------------
//
// The preview path has one copy of this sentence and the delivery path has another; the delivery one is the
// more consequential, because a delivery that silently rendered from an EARLIER revision's `.blend` would be a
// delivery of the wrong scene. The fixture project is created WITH a checkpoint, so `r0002` — committed without
// one — has to be compiled, and the warning names the checkpoint it did not use.
{
  const world = await fixture({ probedFrames: '1' })
  const second = await world.studio.transactions.applyScenePatch({
    projectId: world.projectId,
    baseRevision: world.revision,
    operations: [{ op: 'entity.visibility.set', entityId: productSpec.entities[0].id, visible: false }],
    saveCheckpoint: false,
  })
  // The patch itself compiles once (the commit validates and digests the document it stores), so the render's
  // own launches are counted as a DELTA: one for the checkpoint this render needs, and none for the encode.
  const compilesBeforeRender = world.compiles()
  const started = await world.studio.startFinalRender({
    projectId: world.projectId, revision: second.revision.revision, frames: [1],
  })
  await waitFor(() => world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status === 'completed')
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a DELIVERY of a revision with no checkpoint says which earlier checkpoint it was compiled instead of',
    record.status === 'completed' && record.warnings.some(entry => entry.code === 'SCENE_COMPILER_DECISION' &&
      entry.message === `revision ${second.revision.revision} has no checkpoint of its own; it was compiled from its ` +
        `SceneSpec for this render (the nearest earlier checkpoint is ${world.revision})`),
    { status: record.status, message: record.message, warnings: record.warnings.map(entry => entry.message) })
  // AND THE FRAMES CAME FROM THAT COMPILE, not from the checkpoint it named as a fallback. This is the assertion
  // that the defect would have failed: the old resolver returned the EARLIER revision's `.blend`, so the delivery
  // published the previous scene under this revision's name — and the manifest is where that choice is recorded.
  const earlierCheckpoint = world.studio.store.checkpointPath(world.projectId, world.revision)
  check('and the record names the checkpoint it really rendered from — the COMPILE, not the earlier revision’s',
    typeof record.checkpointPath === 'string' && record.checkpointPath !== earlierCheckpoint &&
    /tmp[\\/]render-/.test(record.checkpointPath),
    { renderedFrom: record.checkpointPath, earlier: earlierCheckpoint })
  // The manifest records NO checkpoint for a compiled render (`path: null`), and that is deliberate: the compile
  // lives in a scratch directory that is removed after the render, so naming it would be a path a reader could
  // follow to nothing. The immutable source of truth for this delivery is the SceneSpec, which IS recorded —
  // with its digest, which is what makes "these frames were rendered from this scene document" checkable.
  const manifestPath = join(world.studio.store.projectDirectory(world.projectId), 'output', 'delivery-manifest.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  check('and the delivery launched the compiler ONCE: the encode reuses the checkpoint the render recorded',
    world.compiles() - compilesBeforeRender === 1,
    { launches: world.compiles() - compilesBeforeRender })
  check('and the manifest points at the SceneSpec it compiled rather than at a scratch file that is already gone',
    manifest !== null && manifest.source?.checkpoint?.path === null &&
    manifest.source?.sceneSpec?.path === `revisions/${second.revision.revision}/scene-spec.json` &&
    typeof manifest.source?.sceneSpecDigest === 'string',
    { checkpoint: manifest?.source?.checkpoint, sceneSpec: manifest?.source?.sceneSpec?.path })
  world.dispose()
}

// ---------------------------------------------------------------------------
// Resuming a render that was COMPILED: it must render the same scene
// ---------------------------------------------------------------------------
//
// A resumed attempt continues the frames of the render it resumes, so it has to open the SAME `.blend` — the one
// that render compiled, not a fresh compile of the revision's spec (which would be a second Blender launch for
// the same answer) and not the earlier revision's checkpoint (which would be a different scene). The record
// carries that path, and this case is what makes the preference observable: the compile counter must not move.
{
  const world = await fixture({ holdUntilCancel: true, progressPollMs: 10_000, renderFrames: [1] })
  const second = await world.studio.transactions.applyScenePatch({
    projectId: world.projectId,
    baseRevision: world.revision,
    operations: [{ op: 'entity.visibility.set', entityId: productSpec.entities[0].id, visible: false }],
    saveCheckpoint: false,
  })
  const compilesBefore = world.compiles()
  const started = await world.studio.startFinalRender({
    projectId: world.projectId, revision: second.revision.revision, frames: [1, 2],
  })
  const afterStart = world.compiles()
  const cancelling = world.studio.cancelJob({ projectId: world.projectId, jobId: started.jobId, reason: 'stop for the resume case' })
  world.resolveOutcome({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 30 })
  await cancelling
  const cancelled = world.studio.renderJobs.read(world.projectId, started.jobId)
  const resumed = await world.studio.resumeRenderJob({ projectId: world.projectId, jobId: started.jobId })
  await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const afterResume = world.compiles()
  check('resuming a compiled render reuses the checkpoint that render recorded, without compiling again',
    cancelled.status === 'cancelled' && resumed.resumed === 1 && afterStart - compilesBefore === 1 &&
    afterResume === afterStart,
    { launchesForStart: afterStart - compilesBefore, launchesForResume: afterResume - afterStart, resumed: resumed.resumed })
  world.dispose()
}

// ---------------------------------------------------------------------------
// Resuming a job whose record predates `checkpointPath`
// ---------------------------------------------------------------------------
//
// The field was added when the delivery path learned to compile; a record written before it (or by a Host that
// predates the change) has none, and the resume must still work: it resolves a checkpoint for itself. That is
// the `else` arm, and without a case like this one it is code nobody runs — which is exactly what the coverage
// reading said about it before this case existed.
{
  const plan = {}
  const world = await fixture(plan)
  const framesDirectory = world.studio.renderJobs.framesDirectory(world.projectId, 'render-0009')
  mkdirSync(framesDirectory, { recursive: true })
  // ONE frame of two: the resume has work to do, so it really launches a renderer — and the project HAS a
  // checkpoint (the fixture commits one), so the resolution needs no compile. The `else` arm is what runs.
  writeFileSync(join(framesDirectory, 'frame_0001.png'), framePng)
  world.studio.renderJobs.write({
    projectId: world.projectId, jobId: 'render-0009', type: 'final-render', status: 'cancelled',
    revisionId: world.revision, frameStart: 1, frameEnd: 2, expectedFrames: 2,
    completedFrames: [], missingFrames: [1, 2], corruptFrames: [], fps: 30, pid: null,
    attempt: 1, attemptToken: 'token-a', dshJobId: null, delivery: null, warnings: [],
    filePrefix: 'frame_', filePadding: 4, renderConfig: { resolution: [1920, 1080], samples: 8 },
  })
  const compilesBefore = world.compiles()
  const resumed = await world.studio.resumeRenderJob({ projectId: world.projectId, jobId: 'render-0009' })
  await waitFor(() => ['completed', 'failed'].includes(world.studio.renderJobs.readSafe(world.projectId, 'render-0009')?.status))
  check('a job record with NO checkpointPath still resumes: a REAL checkpoint is resolved and handed over',
    resumed.resumed === 1 && world.compiles() - compilesBefore === 0 &&
    plan.lastCheckpointPath === world.studio.store.checkpointPath(world.projectId, world.revision) &&
    world.studio.renderJobs.read(world.projectId, 'render-0009').status === 'completed',
    { resumed: resumed.resumed, handedOver: plan.lastCheckpointPath, expected: world.studio.store.checkpointPath(world.projectId, world.revision) })
  world.dispose()
}

// ---------------------------------------------------------------------------
// Two cancels/terminations whose HANDLE refuses to die quietly
// ---------------------------------------------------------------------------
//
// `terminate()` is the provider's own ladder and it can throw (an already-released handle). Both call sites that
// reach for it swallow that on purpose, and each has a different reason: the DSH cancel path must not let a
// projection failure escape into the harness, and the failure path must not let a dead handle replace the
// failure it was cleaning up after.

{
  // The harness cancels the run AFTER the renderer exists, and the handle refuses to be terminated. The cancel
  // is still a cancel: the record settles, the output says so, and nothing is thrown at the caller.
  let lateHandle = null
  const world = await fixture({
    terminateThrows: true,
    holdUntilCancel: true,
    jobs: { attachController: () => () => {}, start: request => { lateHandle = request.run(); return 'dsh-job-late-cancel' } },
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  lateHandle.cancel('the operator stopped it from the harness')
  world.resolveOutcome({ envelope: { status: 'success' }, exitCode: 0, signal: null, durationMs: 40 })
  const settled = await waitFor(() => ['cancelled', 'failed', 'completed'].includes(world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status))
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a DSH cancel whose handle refuses to be terminated still settles the job, without throwing at the harness',
    settled && record.status === 'cancelled' && record.message === 'cancelled: the operator stopped it from the harness' &&
    world.stdout.includes('terminated'),
    { status: record.status, message: record.message })
  world.dispose()
}

{
  // A render that FAILS while its handle refuses to be terminated: the failure classification is what the
  // caller needs, so the dead handle must not replace it. The renderer is still stopped (the fixture records
  // the attempt) and the record keeps the real error.
  const world = await fixture({
    terminateThrows: true,
    outcomeThrows: Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
  })
  const started = await world.studio.startFinalRender({ projectId: world.projectId, revision: world.revision, frames: [1, 2] })
  await waitFor(() => world.studio.renderJobs.readSafe(world.projectId, started.jobId)?.status === 'failed')
  const record = world.studio.renderJobs.read(world.projectId, started.jobId)
  check('a failure path whose handle refuses to be terminated still records the REAL failure',
    record.status === 'failed' && record.errorCode === code('DISK_FULL') && world.stdout.includes('terminated'),
    { status: record.status, code: record.errorCode, stdout: world.stdout })
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
