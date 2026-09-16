#!/usr/bin/env node
/**
 * The two ends of a delivery that went wrong: cancelling a render, and refusing to publish a video
 * that does not match what the job claims it rendered.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two things stood out in the M3 leftovers, and both are about a record that must not lie:
 *
 *   1. `cancelJob` answers three different kinds of job — an M1 attempt log (nothing to cancel), a
 *      render job with a live handle in THIS process, and a render job whose process belongs to a
 *      previous Host — and the report distinguishes "the cancel was REQUESTED" from "the process was
 *      SIGNALLED" from "the process is GONE". Only the last is the acceptance condition, so it is
 *      measured rather than inferred. The LAST rung of that ladder — a pid that answers `kill(pid, 0)`
 *      and cannot be killed, escalated once and then reported as still there — is driven too, with a
 *      real zombie whose parent never reaps it, because a live renderer can never reach that rung:
 *      the rung below it already ends in SIGKILL.
 *   2. `_deliverJob` refuses to encode an incomplete frame set (encoding "whatever is there" is how a
 *      delivery silently ships 447 of 450 frames) and refuses to publish a video whose PROBED
 *      properties disagree with the job's own claims. Both leave the record saying `failed` with a
 *      code, because a delivery that lies about itself is worse than one that fails.
 *
 * The seams are the ones this session has been using: a real store and real PNG frames on disk, and a
 * stub `subprocess` for ffmpeg and ffprobe. No Blender, no ffmpeg, no network.
 *
 * Run standalone: `node deepblend/tests/contract/host-cancel-and-delivery.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig, checkProcessAlive } from '@deepblend/dsh-blender-host'
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

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-cancel-'))

const FRAME_SIZE = 256
const framePng = encodePng(createImage(FRAME_SIZE, FRAME_SIZE, [120, 200, 90, 255]))
/**
 * What ffprobe would print, in ffprobe's OWN shape.
 *
 * The first version of this stub wrote a made-up document (`fps`, `nbFrames`, `durationSeconds`) and the
 * probe found none of those fields — so the refusal it produced was about `fps: null` and a duration
 * mismatch instead of the frame count the case was about. The fixture has to speak the format it stands
 * in for: `avg_frame_rate`, `nb_read_frames`, `nb_frames`, and `format.duration`.
 */
let probedStream = {
  codec_name: 'h264',
  width: FRAME_SIZE,
  height: FRAME_SIZE,
  avg_frame_rate: '30/1',
  r_frame_rate: '30/1',
  nb_frames: '2',
  nb_read_frames: '2',
  duration: '0.066667',
}
let probedFormatDuration = '0.066667'

/** ffmpeg writes the file it was asked for; ffprobe answers with `probedDocument`. */
function subprocessStub() {
  return {
    async resolveExecutable(requested) {
      return requested
    },
    spawn(request) {
      const isProbe = request.argv.some(argument => String(argument).includes('ffprobe'))
      if (!isProbe) {
        const outputPath = request.argv[request.argv.length - 1]
        mkdirSync(join(outputPath, '..'), { recursive: true })
        writeFileSync(outputPath, Buffer.from('pretend this is an mp4'))
      }
      return {
        get done() { return Promise.resolve({ exitCode: 0, signal: null }) },
        collected: {
          stdout: { readFrom: () => ({ text: isProbe ? JSON.stringify({ streams: [probedStream], format: { duration: probedFormatDuration } }) : '' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
}

const studio = new BlenderStudio(
  (() => {
    const ctx = new Context()
    ctx.provide('blenderRuntime', {})
    ctx.provide('subprocess', subprocessStub())
    return ctx
  })(),
  StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects') }),
)

const project = await studio.transactions.createProject({
  title: 'cancel-fixture',
  // `ROOT`, not `process.cwd()`: the contract runner starts each file from its own directory, so a
  // path built from the cwd works when run by hand and fails under `run.mjs` (it did).
  sceneSpec: JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8')),
  saveCheckpoint: false,
})
const projectId = project.projectId

/** A render job record in the shape the store accepts. */
function jobRecord(jobId, overrides = {}) {
  return {
    projectId,
    jobId,
    type: 'final-render',
    status: 'running',
    revisionId: project.revision.revision,
    frameStart: 1,
    frameEnd: 2,
    expectedFrames: 2,
    completedFrames: [],
    missingFrames: [1, 2],
    corruptFrames: [],
    fps: 30,
    pid: null,
    attempt: 1,
    attemptToken: 'token-a',
    dshJobId: null,
    delivery: null,
    warnings: [],
    filePrefix: 'frame_',
    filePadding: 4,
    renderConfig: { resolution: [FRAME_SIZE, FRAME_SIZE], samples: 8, engine: 'BLENDER_EEVEE', viewTransform: 'AgX' },
    ...overrides,
  }
}

const framesDirectory = jobId => studio.renderJobs.framesDirectory(projectId, jobId)
function writeFrames(jobId, numbers) {
  mkdirSync(framesDirectory(jobId), { recursive: true })
  for (const number of numbers) {
    writeFileSync(join(framesDirectory(jobId), `frame_${String(number).padStart(4, '0')}.png`), framePng)
  }
}

// ---------------------------------------------------------------------------
// Cancelling: three kinds of job, and the difference between "signalled" and "gone"
// ---------------------------------------------------------------------------

studio.store.writeJob(projectId, {
  schemaVersion: 'deepblend.job/v1',
  jobId: 'apply_scene_patch-1',
  projectId,
  action: 'apply_scene_patch',
  revision: project.revision.revision,
  status: 'succeeded',
  errorCode: null,
  message: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 5,
  idempotencyKey: null,
  baseRevision: project.revision.revision,
  artifacts: [],
  warnings: [],
})

const attemptLog = await studio.cancelJob({ projectId, jobId: 'apply_scene_patch-1' })
check('an M1 attempt log has nothing to cancel, and the answer says so instead of pretending to try',
  attemptLog.kind === 'attempt-log' && attemptLog.cancelled === false && attemptLog.processGone === true &&
  attemptLog.reason === 'an M1 attempt log has no cancellable process; job is already succeeded',
  attemptLog)

studio.renderJobs.write(jobRecord('render-0001', { status: 'running', pid: null }))
let terminated = 0
let settled = 0
// The live entry a real render puts in `_liveRenders`: the provider's handle, and the `settle` that
// releases the DSH projection (cancelJob awaits it, so a caller that cancels and immediately resumes
// does not race its own previous attempt for the same frame files).
studio._liveRenders.set('render-0001', {
  handle: {
    terminate() { terminated += 1 },
    get done() { return Promise.resolve({ exitCode: null, signal: 'SIGTERM' }) },
  },
  settle: () => { settled += 1 },
  cancelled: false,
  cancelReason: null,
  dshJobId: null,
  output: '',
  attemptToken: 'token-a',
})

const cancelled = await studio.cancelJob({ projectId, jobId: 'render-0001', reason: 'the operator stopped it' })
check('a render with a live handle in THIS process is cancelled through the provider\'s own ladder',
  terminated === 1 && settled === 1 && cancelled.cancelled === true && cancelled.processGone === true &&
  cancelled.kind === 'render-job' &&
  cancelled.process?.via === 'subprocess-handle' &&
  /SIGTERM to the managed range, grace, then SIGKILL/.test(cancelled.process?.ladder ?? ''),
  cancelled.process ?? cancelled)
check('and the durable record says cancelled, with the reason a person gave',
  studio.renderJobs.read(projectId, 'render-0001').status === 'cancelled' &&
  studio.renderJobs.read(projectId, 'render-0001').message === 'cancelled: the operator stopped it',
  studio.renderJobs.read(projectId, 'render-0001').status)
studio._liveRenders.delete('render-0001')

studio.renderJobs.write(jobRecord('render-0002', { status: 'running', pid: null }))
studio._liveRenders.set('render-0002', {
  handle: { terminate() { throw new Error('the handle was already released') }, done: Promise.resolve({}) },
  settle: () => {},
  cancelled: false, cancelReason: null, dshJobId: null, output: '', attemptToken: 'token-a',
})
const handleFailed = await studio.cancelJob({ projectId, jobId: 'render-0002' })
check('a handle that throws while terminating is REPORTED, and the cancel still proceeds',
  handleFailed.cancelled === true &&
  handleFailed.process?.error === 'Error: the handle was already released' &&
  studio.renderJobs.read(projectId, 'render-0002').status === 'cancelled',
  handleFailed.process ?? handleFailed)
studio._liveRenders.delete('render-0002')

// A job whose process was started by a PREVIOUS Host: no handle here, only a pid.
const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })
await new Promise(resolve => setTimeout(resolve, 150))
studio.renderJobs.write(jobRecord('render-0003', { status: 'running', pid: sleeper.pid }))
const byPid = await studio.cancelJob({ projectId, jobId: 'render-0003' })
check('a render whose process belongs to a previous Host is signalled as a process GROUP and then MEASURED',
  byPid.cancelled === true && byPid.process?.via === 'process-group' &&
  byPid.processGone === true && byPid.process?.attempted === true &&
  byPid.process?.gone === true,
  byPid.process ?? byPid)
try { process.kill(-sleeper.pid, 'SIGKILL') } catch { /* already gone */ }
try { sleeper.kill('SIGKILL') } catch { /* already gone */ }

// ---------------------------------------------------------------------------
// The escalation: a pid that answers `kill(pid, 0)` and cannot be killed
// ---------------------------------------------------------------------------
//
// MEASURED AT LAST, and it needed a process that cannot die rather than a slow one: the escalation is
// the rung ABOVE `stopProcessGroup`, which already ends in SIGKILL, so a live renderer never reaches it.
// A ZOMBIE does — it has exited, its parent has not reaped it, `kill(pid, 0)` succeeds and no signal can
// change anything. The keeper below is a Node process that spawns a child and then blocks the thread
// forever (`Atomics.wait`, so it burns no CPU): a parent that never returns to its event loop never
// reaps, which is the whole trick, and the pid it reports on stdout is the zombie.
//
// The grace is configured to 200 ms for this case. With the default ten seconds per rung the only way to
// stand on this branch is to wait twenty of them — which is why it had never run, and why the bound is a
// configuration the operator owns (a "did the process die" question with a cost is not a constant).
const ZOMBIE_KEEPER = [
  "const { spawn } = require('child_process')",
  "const fs = require('fs')",
  "const child = spawn(process.execPath, ['-e', '0'])",
  'fs.writeSync(1, String(child.pid))',
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)',
].join(';')
const keeper = spawn(process.execPath, ['-e', ZOMBIE_KEEPER], { stdio: ['ignore', 'pipe', 'ignore'] })
const zombiePid = Number(await new Promise(resolve => {
  keeper.stdout.once('data', chunk => resolve(String(chunk).trim()))
}))
// The pid arrives while its process is still starting, so the fixture WAITS for the state the case is
// about instead of assuming it: `Z` is a process that has exited and whose parent has not reaped it.
const psState = () => execFileSync('ps', ['-o', 'stat=', '-p', String(zombiePid)], { encoding: 'utf8' }).trim()
const zombieState = await (async () => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = psState()
    if (state.startsWith('Z')) return state
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return psState()
})()
check('the fixture has a ZOMBIE before the cancel is asked for, because a killable pid cannot reach the escalation',
  zombieState.startsWith('Z'), { pid: zombiePid, state: zombieState })
const quick = new BlenderStudio(new Context(), StudioConfig({
  workspaceRoot,
  projectsRoot: join(workspaceRoot, 'projects'),
  reconcileOnStart: false,
  orphanGraceMs: 200,
}))
quick.renderJobs.write(jobRecord('render-0004', { status: 'running', pid: zombiePid }))
const escalationStartedMs = Date.now()
const unkillable = await quick.cancelJob({ projectId, jobId: 'render-0004', reason: 'the renderer is a zombie' })
const escalationMs = Date.now() - escalationStartedMs
check('a pid that cannot be killed is escalated ONCE and then reported as still there, never claimed gone',
  unkillable.cancelled === true && unkillable.processGone === false && unkillable.process?.gone === false &&
  unkillable.process?.escalated !== undefined && unkillable.process.escalated.kill !== null &&
  unkillable.process?.escalated?.gone === false && quick.renderJobs.read(projectId, 'render-0004').status === 'cancelled',
  { state: zombieState, process: unkillable.process, processGone: unkillable.processGone })
// The bound is the configuration, not a constant: two rungs at 200 ms each, where the default grace
// would spend twenty seconds on the same answer. The margin is deliberately huge (5 s against ~0.5 s
// measured, and ~20 s for the unbounded version) because this machine's load swings by an order of
// magnitude — a tight timing assertion here would be a flake, not a measurement.
check('and the time it spends on that question is the CONFIGURED grace, not a constant nobody can lower',
  escalationMs < 5_000, { escalationMs, configuredGraceMs: 200 })
// The reading is only evidence because the pid was a ZOMBIE: once its parent is killed the pid is gone
// immediately, so the "still alive" answer above was about a process that had already exited.
keeper.kill('SIGKILL')
const reaped = await (async () => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (checkProcessAlive(zombiePid).alive === false) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  return checkProcessAlive(zombiePid).alive === false
})()
check('and the pid was a zombie rather than a renderer: reaping its parent makes it answer `gone` at once',
  reaped, { pid: zombiePid, state: zombieState })

// ---------------------------------------------------------------------------
// Delivery: an incomplete frame set is not encoded
// ---------------------------------------------------------------------------

writeFrames('render-0004', [1]) // frame 2 is missing
studio.renderJobs.write(jobRecord('render-0004', { status: 'running' }))
const incomplete = await studio._deliverJob({
  record: studio.renderJobs.read(projectId, 'render-0004'),
  spec: studio.store.readRevisionSpec(projectId, project.revision.revision),
  reason: 'deliver',
})
const incompleteRecord = studio.renderJobs.read(projectId, 'render-0004')
check('a delivery with a missing frame refuses to encode, and says how many are absent and what to do',
  incomplete.status === 'failed' && incomplete.verified === false &&
  incomplete.message ===
    '1 of 2 frame(s) are not complete (1 absent, 0 incomplete), so there is nothing to encode yet. ' +
    'Continue with blender_final_render {resumeJobId: "render-0004"}.',
  incomplete.message)
check('and the job record carries the ledger it measured, so a reader sees WHICH frames are missing',
  incompleteRecord.status === 'failed' &&
  incompleteRecord.errorCode === code('RENDER_FRAMES_INCOMPLETE') &&
  JSON.stringify(incompleteRecord.completedFrames) === JSON.stringify([1]) &&
  JSON.stringify(incompleteRecord.missingFrames) === JSON.stringify([2]) &&
  JSON.stringify(incompleteRecord.corruptFrames) === JSON.stringify([]),
  { status: incompleteRecord.status, code: incompleteRecord.errorCode, missing: incompleteRecord.missingFrames })

writeFrames('render-0005', [1])
studio.renderJobs.write(jobRecord('render-0005', { status: 'running' }))
const exported = await studio._deliverJob({
  record: studio.renderJobs.read(projectId, 'render-0005'),
  spec: studio.store.readRevisionSpec(projectId, project.revision.revision),
  reason: 'export',
}).catch(cause => cause)
check('an EXPORT of an incomplete job is a coded refusal rather than a silent failure',
  exported instanceof BlenderError && exported.code === code('RENDER_FRAMES_INCOMPLETE') &&
  exported.detail?.present === 1 && JSON.stringify(exported.detail?.toRender) === JSON.stringify([2]),
  exported?.detail ?? exported?.message)

// ---------------------------------------------------------------------------
// Delivery: a video whose PROBED properties disagree with the job's claims
// ---------------------------------------------------------------------------

writeFrames('render-0006', [1, 2])
studio.renderJobs.write(jobRecord('render-0006', { status: 'running' }))
// Only the measured frame count disagrees now: `-count_frames` saw one frame where the job claims two.
probedStream = { ...probedStream, nb_read_frames: '1', nb_frames: '1' }
const lying = await studio._deliverJob({
  record: studio.renderJobs.read(projectId, 'render-0006'),
  spec: studio.store.readRevisionSpec(projectId, project.revision.revision),
  reason: 'deliver',
})
const lyingRecord = studio.renderJobs.read(projectId, 'render-0006')
check('a video whose frame count disagrees with the job is NOT published, and the message quotes both numbers',
  lying.status === 'failed' && lying.verified === false && lying.video === null &&
  /^the encoded video does not match the job's own claims: /.test(lying.message) &&
  /frameCount claimed 2 but probed 1/.test(lying.message),
  lying.message)
check('and the record keeps the attempt, its problems and a code, so the failure is diagnosable later',
  lyingRecord.status === 'failed' && lyingRecord.errorCode === code('ENCODE_VERIFY_FAILED') &&
  lyingRecord.delivery?.status === 'failed' && lyingRecord.delivery?.attempt === 1 &&
  lyingRecord.delivery?.problems?.some(problem => problem.field === 'frameCount') &&
  typeof lyingRecord.delivery?.videoPath === 'string',
  { code: lyingRecord.errorCode, delivery: lyingRecord.delivery?.status, problems: lyingRecord.delivery?.problems?.map(problem => problem.field) })
check('and nothing was published under output/: a rejected video does not become a delivery',
  !existsSync(join(studio.store.projectDirectory(projectId), 'output', 'delivery-manifest.json')),
  existsSync(join(studio.store.projectDirectory(projectId), 'output')))

writeFrames('render-0007', [1, 2])
studio.renderJobs.write(jobRecord('render-0007', { status: 'running' }))
const lyingExport = await studio._deliverJob({
  record: studio.renderJobs.read(projectId, 'render-0007'),
  spec: studio.store.readRevisionSpec(projectId, project.revision.revision),
  reason: 'export',
}).catch(cause => cause)
check('an EXPORT of a video that lies about itself THROWS, carrying the problems themselves',
  lyingExport instanceof BlenderError && lyingExport.code === code('ENCODE_VERIFY_FAILED') &&
  lyingExport.detail?.problems?.some(problem => problem.field === 'frameCount'),
  lyingExport?.detail ?? lyingExport?.message)
check('a job that was still running when its delivery failed is marked failed',
  studio.renderJobs.read(projectId, 'render-0007').status === 'failed',
  studio.renderJobs.read(projectId, 'render-0007').status)

// The other arm of that same line: a re-export of an ALREADY completed delivery must not re-open the
// job. `completed` has no outgoing transition on purpose, and a failed attempt is recorded in
// `delivery` — which is where a delivery attempt belongs.
writeFrames('render-0008', [1, 2])
studio.renderJobs.write(jobRecord('render-0008', { status: 'completed', delivery: { status: 'published', attempt: 1 } }))
const completedExport = await studio._deliverJob({
  record: studio.renderJobs.read(projectId, 'render-0008'),
  spec: studio.store.readRevisionSpec(projectId, project.revision.revision),
  reason: 'export',
}).catch(cause => cause)
const completedRecord = studio.renderJobs.read(projectId, 'render-0008')
check('a re-export that fails leaves the COMPLETED job completed, and records the failure on the attempt',
  completedExport instanceof BlenderError && completedExport.code === code('ENCODE_VERIFY_FAILED') &&
  completedRecord.status === 'completed' && completedRecord.delivery?.status === 'failed' &&
  completedRecord.errorCode === code('ENCODE_VERIFY_FAILED'),
  { status: completedRecord.status, delivery: completedRecord.delivery?.status, code: completedRecord.errorCode })

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost cancel + delivery: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
