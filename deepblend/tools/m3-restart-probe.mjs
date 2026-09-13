#!/usr/bin/env node
/**
 * M3 restart probe — the measurement that had to come BEFORE the Job Store.
 *
 * WHAT IS BEING MEASURED
 * ----------------------
 * Four of the five SPEC §20 M3 acceptance conditions cannot be proved by a unit
 * test, and the M2 session's own lesson was blunt: a mechanism that "looks right"
 * is regularly nothing at all when a real restart happens. So this probe exists to
 * answer three questions against a real Blender and a real kill -9, before a
 * single line of Persistent Job Store is written:
 *
 *   Q1  When the process that started a render is SIGKILLed, what actually
 *       survives? (The Blender child? The job's stdout? Anything at all?)
 *   Q2  From a FRESH process, using only what is on disk, can we say which job
 *       is unfinished, which frames are done, and which are missing?
 *   Q3  Does rendering exactly the missing set converge, and does it avoid
 *       re-rendering the frames that already exist?
 *
 * WHY IT IS SELF-DRIVING AND MULTI-PROCESS
 * ----------------------------------------
 * `restart` forks a child ("the Host"), waits until frames start landing, sends
 * it SIGKILL, and then runs the recovery as a THIRD process. The recovery is
 * therefore genuinely a fresh Node process reading a store it did not write —
 * not a fresh object in the process that still holds the handle, which is the
 * weaker thing that is easy to mistake for a restart.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No Job Store, no reconciler, no ctx.jobs projection: this file is the evidence
 * that shapes them. The only durable facts it uses are the ones the provider
 * writes as a by-product of rendering (`plan.json`, `process.json`,
 * `events.jsonl`) plus the frames themselves, and it computes the ledger itself
 * from the frames. When `host/lib/frame-ledger.js` exists, `recover` is re-run
 * with `--use-ledger-module` so the real module is shown to agree with the
 * evidence this probe produced.
 *
 * Usage:
 *   node deepblend/tools/m3-restart-probe.mjs restart [--frames 8] [--kill-at 3]
 *   node deepblend/tools/m3-restart-probe.mjs ledger-audit --job <name>
 *
 * Owner: DeepBlend Studio — M3
 */

import { execFileSync, spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')
const PROJECTS = join(ROOT, '.deepblend', 'projects')

const PROJECT_ID = process.env.DEEPBLEND_PROBE_PROJECT ?? 'watch-commercial'
const PROJECT_ROOT = join(PROJECTS, PROJECT_ID)
const REVISION = process.env.DEEPBLEND_PROBE_REVISION ?? 'r0029'
/** The probe's job directory. Named, not timestamped, so a `recover` can find it. */
const JOB_NAME = process.env.DEEPBLEND_PROBE_JOB ?? 'probe-m3-restart'

/** A frame is only "done" if it is a complete PNG, not merely a file. */
const MIN_FRAME_BYTES = 512
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function say(label, value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  console.log(`${label}: ${rendered}`)
}

function frameFileName(frame, prefix = 'frame_', padding = 4) {
  return `${prefix}${String(frame).padStart(padding, '0')}.png`
}

/**
 * The probe's own copy of the frame ledger, written from first principles.
 *
 * This is the part the Job Store will own, and it is here first for one reason:
 * the probe must be able to describe what is on disk WITHOUT the facility whose
 * design it is meant to inform. Four facts are read off each candidate frame —
 * the PNG signature, the IHDR dimensions, a size floor, and the IEND tail — for
 * the same reason `deepblend_frames.verify_frame` does: a process killed while
 * writing leaves a file that exists and is not a frame.
 */
export function probeLedger(framesDirectory, frames, expected = {}) {
  const present = []
  const missing = []
  const corrupt = []
  for (const frame of frames) {
    const path = join(framesDirectory, frameFileName(frame))
    if (!existsSync(path)) {
      missing.push(frame)
      continue
    }
    const verdict = inspectFrame(path, expected)
    if (verdict.ok) present.push({ frame, bytes: verdict.bytes, width: verdict.width, height: verdict.height })
    else corrupt.push({ frame, reason: verdict.reason, bytes: verdict.bytes ?? 0 })
  }
  return { present, missing, corrupt }
}

function inspectFrame(path, expected = {}) {
  let size
  try {
    size = statSync(path).size
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (size < MIN_FRAME_BYTES) return { ok: false, reason: 'truncated', bytes: size }
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return { ok: false, reason: 'unreadable', bytes: size }
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: 'not-a-png', bytes: size }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width <= 0 || height <= 0) return { ok: false, reason: 'bad-dimensions', bytes: size }
  if (expected.width !== undefined && (width !== expected.width || height !== expected.height)) {
    return { ok: false, reason: `wrong-dimensions ${width}x${height}`, bytes: size }
  }
  if (buffer.subarray(buffer.length - 8, buffer.length - 4).toString('latin1') !== 'IEND') {
    return { ok: false, reason: 'unterminated', bytes: size }
  }
  return { ok: true, bytes: size, width, height }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Everything the probe needs to know about the project, read from the store. */
function readProjectFacts() {
  const spec = readJson(join(PROJECT_ROOT, 'revisions', REVISION, 'scene-spec.json'))
  const finalProfile = spec.renderProfiles?.final
  if (finalProfile === undefined) {
    throw new Error(`revision ${REVISION} declares no "final" render profile; cannot probe a delivery render`)
  }
  const cameras = spec.cameras ?? []
  const camera = cameras.find(entry => entry.role === 'active-camera') ?? cameras[0]
  if (camera === undefined) throw new Error(`revision ${REVISION} declares no cameras`)
  return {
    spec,
    finalProfile,
    cameraId: camera.id,
    frameStart: spec.project.frameStart,
    frameEnd: spec.project.frameEnd,
    fps: spec.project.fps,
    checkpoint: join(PROJECT_ROOT, 'revisions', REVISION, 'scene.blend'),
  }
}

function jobDirectory() {
  return join(PROJECT_ROOT, 'renders', JOB_NAME)
}

async function makeProvider() {
  if (!existsSync(BLENDER)) throw new Error(`Blender not found at ${BLENDER}`)
  const ctx = new Context()
  ctx.plugin(LocalSubprocess)
  const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
  ctx.plugin(Provider, ProviderConfig({
    blenderPath: BLENDER,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: join(ROOT, '.deepblend'),
    timeoutMs: 600_000,
  }))
  await new Promise(resolveReady => setTimeout(resolveReady, 250))
  const provider = ctx.get('blenderRuntime')
  if (provider === undefined) throw new Error('the provider did not publish blenderRuntime')
  return { ctx, provider }
}

/* -------------------------------------------------------------------------- */
/* start — "the Host", which is about to be killed                             */
/* -------------------------------------------------------------------------- */

async function commandStart(argv) {
  const frameCount = Number(option(argv, 'frames') ?? 8)
  const facts = readProjectFacts()
  const frames = []
  for (let frame = facts.frameStart; frame < facts.frameStart + frameCount; frame += 1) frames.push(frame)

  const directory = jobDirectory()
  mkdirSync(join(directory, 'frames'), { recursive: true })

  // The probe's minimal durable marker: exactly the fields a recovery needs, and
  // nothing that presumes the shape the real Job Store will take.
  const markerPath = join(directory, 'probe-job.json')
  const marker = {
    schemaVersion: 'deepblend.probe-job/v1',
    jobId: JOB_NAME,
    projectId: PROJECT_ID,
    revision: REVISION,
    status: 'running',
    frames,
    pid: null,
    processGroupId: null,
    frameStart: facts.frameStart,
    frameEnd: facts.frameEnd,
    fps: facts.fps,
    checkpoint: facts.checkpoint,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8')

  const { provider } = await makeProvider()
  const run = await provider.startFrameSequence({
    checkpointPath: facts.checkpoint,
    frames,
    jobDirectory: directory,
    cameraId: facts.cameraId,
    profileName: 'final',
    profile: facts.finalProfile,
    frameRange: [facts.frameStart, facts.frameEnd],
    jobId: JOB_NAME,
  })

  // The pid is written BY THE CHILD (measured: `ctx.subprocess.spawn` returns a
  // handle with no pid field), so the Host waits for it and copies it into the
  // durable marker. This wait is the whole reason an orphan is findable later.
  const identity = await waitForProcessIdentity(run.processPath, 30_000)
  if (identity === null) {
    say('WARNING', 'the child never wrote process.json within 30 s; the pid cannot be recorded')
  } else {
    marker.pid = identity.pid
    marker.processGroupId = identity.processGroupId
    writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8')
    say('child.pid', identity.pid)
    say('child.processGroupId', identity.processGroupId)
  }

  say('jobDirectory', directory)
  say('frames.requested', frames)
  console.log('PROBE_STARTED')

  const outcome = await provider.awaitFrameSequence(run)
  marker.status = outcome.envelope?.status === 'success' ? 'completed' : 'failed'
  marker.finishedAt = new Date().toISOString()
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8')
  say('start.exited', { exitCode: outcome.exitCode, status: outcome.envelope?.status ?? null })
  process.exit(0)
}

async function waitForProcessIdentity(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return readJson(path)
      } catch {
        /* mid-write; retry */
      }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* recover — a FRESH process, reading only what survived                        */
/* -------------------------------------------------------------------------- */

async function commandRecover(argv) {
  const facts = readProjectFacts()
  const directory = jobDirectory()
  const markerPath = join(directory, 'probe-job.json')
  if (!existsSync(markerPath)) throw new Error(`no probe job at ${markerPath}; run "restart" first`)
  const marker = readJson(markerPath)

  console.log('\n── recovery, in a fresh process ──')
  say('marker.status', marker.status)
  say('marker.frames', marker.frames)
  say('marker.pid', marker.pid)

  const probeFrames = readdirSync(join(directory, 'frames')).filter(name => name.endsWith('.png')).sort()
  say('frames.on.disk.before', probeFrames)

  // Q1: what survived the SIGKILL?
  const identity = existsSync(join(directory, 'process.json')) ? readJson(join(directory, 'process.json')) : null
  const liveness = identity === null
    ? { alive: false, reason: 'the child never recorded a pid' }
    : checkProcessAlive(identity.pid)
  say('orphan.identity.document', identity === null ? null : { pid: identity.pid, pgid: identity.processGroupId })
  say('orphan.alive', liveness)

  const events = readEvents(join(directory, 'events.jsonl'))
  say('journal.lines', events.length)
  say('journal.types', [...new Set(events.map(entry => entry.type))])
  say('journal.frames', events.filter(entry => entry.type === 'frame').map(entry => entry.frame))

  // The orphan is stopped BEFORE the ledger is read. A live renderer is still
  // writing into the very directory the ledger is about to describe, so reading
  // first would produce an answer that is already stale.
  let stopReport = { attempted: false }
  if (liveness.alive === true) {
    stopReport = await stopOrphan(identity.pid)
    say('orphan.stopped', stopReport)
  }

  // Q2: from the frames on disk alone.
  const expected = {
    width: facts.finalProfile.resolution[0],
    height: facts.finalProfile.resolution[1],
  }
  const ledger = probeLedger(join(directory, 'frames'), marker.frames, expected)
  say('ledger.expected.size', `${expected.width}x${expected.height}`)
  say('ledger.present', ledger.present.map(entry => entry.frame))
  say('ledger.corrupt', ledger.corrupt)
  say('ledger.missing', ledger.missing)

  if (ledger.missing.length === 0) {
    console.log('PROBE_CONVERGED (nothing was left to render)')
    return
  }

  // Q3: render exactly the missing set, in the same directory.
  const before = new Map(ledger.present.map(entry => [entry.frame, entry.bytes]))
  const { provider } = await makeProvider()
  const run = await provider.startFrameSequence({
    checkpointPath: marker.checkpoint ?? facts.checkpoint,
    frames: ledger.missing,
    jobDirectory: directory,
    cameraId: facts.cameraId,
    profileName: 'final',
    profile: facts.finalProfile,
    frameRange: [facts.frameStart, facts.frameEnd],
    jobId: JOB_NAME,
  })
  say('resume.rendering', ledger.missing)
  const outcome = await provider.awaitFrameSequence(run)
  say('resume.exit', { exitCode: outcome.exitCode, status: outcome.envelope?.status ?? null })
  const rendered = outcome.envelope?.result?.renderedFrames ?? []
  say('resume.rendered', rendered)

  // The two assertions that make "only the missing frames" a fact rather than a
  // claim: the resumed process rendered exactly the missing set, and every frame
  // that already existed still has its original bytes.
  const reRendered = rendered.filter(frame => before.has(frame))
  const untouched = [...before.entries()].filter(([frame, bytes]) => {
    try {
      return statSync(join(directory, 'frames', frameFileName(frame))).size === bytes
    } catch {
      return false
    }
  })
  say('assert.rendered.equals.missing', JSON.stringify([...rendered].sort()) === JSON.stringify([...ledger.missing].sort()))
  say('assert.nothing.re-rendered', reRendered.length === 0)
  say('assert.existing.frames.untouched', `${untouched.length}/${before.size}`)

  const finalLedger = probeLedger(join(directory, 'frames'), marker.frames, expected)
  say('ledger.after.present', finalLedger.present.map(entry => entry.frame))
  say('ledger.after.missing', finalLedger.missing)
  say('ledger.after.corrupt', finalLedger.corrupt.map(entry => entry.frame))

  const converged = finalLedger.missing.length === 0 && finalLedger.corrupt.length === 0
  console.log(converged ? 'PROBE_CONVERGED' : 'PROBE_DID_NOT_CONVERGE')
  process.exitCode = converged ? 0 : 1
}

function readEvents(path) {
  if (!existsSync(path)) return []
  const entries = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // A line torn by the kill. Recording it as torn is the honest answer; a
      // journal that pretends it parsed is worse than one that admits a gap.
      entries.push({ type: 'torn-line' })
    }
  }
  return entries
}

/**
 * Is the process group recorded by that pid still alive?
 *
 * macOS is the platform with the WEAKEST containment in this runtime — measured
 * from `dsh-subprocess-local`: on darwin `selectContainmentMode()` returns
 * `fallback`, whose own warning says "descendants that escape the process group
 * or direct-parent tree are not guaranteed to terminate". The group is what it
 * does give us, because `spawn` uses `detached: true`, so a kill against `-pid`
 * reaches the leader and everything that stayed in its group.
 */
function checkProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false, reason: 'invalid pid' }
  let groupAlive = false
  let leaderAlive = false
  try {
    process.kill(-pid, 0)
    groupAlive = true
  } catch (error) {
    groupAlive = error.code === 'EPERM'
  }
  try {
    process.kill(pid, 0)
    leaderAlive = true
  } catch (error) {
    leaderAlive = error.code === 'EPERM'
  }
  let command = null
  try {
    command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim()
  } catch {
    command = null
  }
  return { alive: groupAlive || leaderAlive, groupAlive, leaderAlive, command }
}

/** Signal the orphan's process group, TERM then KILL, and confirm it is gone. */
async function stopOrphan(pid, graceMs = 10_000) {
  const report = { attempted: true, pid, term: null, kill: null, gone: false }
  const signal = (name) => {
    try {
      process.kill(-pid, name)
      return 'signalled-group'
    } catch (error) {
      try {
        process.kill(pid, name)
        return `signalled-pid (group failed: ${error.code})`
      } catch (inner) {
        return `failed: ${inner.code}`
      }
    }
  }
  report.term = signal('SIGTERM')
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && checkProcessAlive(pid).alive) {
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  if (checkProcessAlive(pid).alive) {
    report.kill = signal('SIGKILL')
    const killDeadline = Date.now() + graceMs
    while (Date.now() < killDeadline && checkProcessAlive(pid).alive) {
      await new Promise(resolveWait => setTimeout(resolveWait, 200))
    }
  }
  const after = checkProcessAlive(pid)
  report.gone = after.alive === false
  report.after = after
  return report
}

/* -------------------------------------------------------------------------- */
/* restart — the driver: fork, kill -9, recover                                */
/* -------------------------------------------------------------------------- */

async function commandRestart(argv) {
  const frameCount = Number(option(argv, 'frames') ?? 8)
  const killAt = Number(option(argv, 'kill-at') ?? 3)
  const directory = jobDirectory()
  rmSync(directory, { recursive: true, force: true })

  console.log('── phase 1: a Host starts a delivery render ──')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--frames', String(frameCount)], {
    stdio: 'inherit',
  })

  console.log(`\n── phase 2: wait for ${killAt} frame(s), then SIGKILL the Host ──`)
  const framesDirectory = join(directory, 'frames')
  const deadline = Date.now() + 20 * 60_000
  let landed = 0
  while (Date.now() < deadline) {
    landed = existsSync(framesDirectory)
      ? readdirSync(framesDirectory).filter(name => name.endsWith('.png')).length
      : 0
    if (landed >= killAt) break
    if (child.exitCode !== null) throw new Error(`the Host exited early with ${child.exitCode}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  say('frames.present.at.kill', landed)
  child.kill('SIGKILL')
  await new Promise(resolveDone => child.once('exit', resolveDone))
  say('host.killed', { pid: child.pid, signal: 'SIGKILL' })

  console.log('\n── phase 3: recovery ──')
  const recovery = spawn(process.execPath, [fileURLToPath(import.meta.url), 'recover'], { stdio: 'inherit' })
  const code = await new Promise(resolveDone => recovery.once('exit', resolveDone))
  process.exit(code ?? 1)
}

function fileURLToPath(url) {
  return url.startsWith('file:') ? new URL(url).pathname : url
}

/** Re-derive a previous probe run's ledger without touching anything. */
async function commandLedgerAudit() {
  const facts = readProjectFacts()
  const directory = jobDirectory()
  const marker = readJson(join(directory, 'probe-job.json'))
  const ledger = probeLedger(join(directory, 'frames'), marker.frames, {
    width: facts.finalProfile.resolution[0],
    height: facts.finalProfile.resolution[1],
  })
  say('job', directory)
  say('present', ledger.present.map(entry => entry.frame))
  say('corrupt', ledger.corrupt)
  say('missing', ledger.missing)
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const command = process.argv[2]
const rest = process.argv.slice(3)
const commands = {
  start: commandStart,
  recover: commandRecover,
  restart: commandRestart,
  'ledger-audit': commandLedgerAudit,
}
if (commands[command] === undefined) {
  console.error(`usage: m3-restart-probe.mjs <${Object.keys(commands).join('|')}> [options]`)
  process.exit(2)
}
await commands[command](rest)
