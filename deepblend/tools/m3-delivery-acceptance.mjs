#!/usr/bin/env node
/**
 * M3 acceptance — a real delivery of the real project, interrupted and resumed.
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT A TEST
 * ------------------------------------------
 * `deepblend/tests/blender-integration/render-job.e2e.mjs` proves the M3 behaviour on
 * a generated fixture at 640x360. This tool does the one thing a fixture cannot: it
 * produces the ACTUAL deliverable for `watch-commercial` at its own declared final
 * profile — 1920x1080, Cycles, AgX, 30 fps — and it does so across a REAL restart of
 * the Host, driven from the shell rather than from inside one process.
 *
 * It is a tool, not a suite, because it writes to the project's real store: its output
 * IS the delivery package, and re-running it re-renders. It is deliberately the only
 * place in this repository that renders a delivery into `.deepblend/`.
 *
 * THE SHAPE OF THE EVIDENCE
 * -------------------------
 *   run      forks `start`, waits for frames, SIGKILLs the Host, then runs `recover`
 *   start    builds a Host, starts a delivery render, records the job, idles
 *   recover  builds a NEW Host in a NEW process, reconciles, resumes the missing
 *            frames, waits for the delivery, and verifies the MP4 with ffprobe
 *
 * The kill is a `SIGKILL` of the Node process, so the Blender child survives it
 * (spawned detached) — the exact situation the reconciler exists for.
 *
 * Usage:
 *   node deepblend/tools/m3-delivery-acceptance.mjs run [--frames 30-89] [--kill-at 8]
 *   node deepblend/tools/m3-delivery-acceptance.mjs status
 *
 * Owner: DeepBlend Studio — M3
 */

import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { devStoreRoot } from './operator-layer.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const STORE = devStoreRoot(ROOT)
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')
const FFMPEG = process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg'
const FFPROBE = process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe'

function option(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
const { default: Studio } = await import('@deepblend/dsh-blender-host')
const { LocalJobRegistry } = await import(
  join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-jobs-local', 'lib', 'index.js')
).catch(async () => {
  const { importDsh } = await import(join(ROOT, 'deepblend', 'tests', 'lib', 'dsh-deployment.mjs'))
  return importDsh('dsh-jobs-local')
})

/** Build a Host over the REAL store. Called in both the start and the recover process. */
async function makeHost() {
  const ctx = new Context()
  ctx.plugin(LocalSubprocess)
  ctx.plugin(LocalJobRegistry)
  ctx.plugin(Provider, ProviderConfig({
    blenderPath: BLENDER,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: STORE,
    timeoutMs: 600_000,
  }))
  ctx.plugin(Studio, {
    projectsRoot: join(STORE, 'projects'),
    workspaceRoot: STORE,
    serveCachedCapabilities: true,
    maxPreviewSamples: 512,
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    reconcileOnStart: true,
    progressPollMs: 1000,
  })
  await new Promise(settle => setTimeout(settle, 300))
  const studio = ctx.get('blenderStudio')
  if (studio === undefined) throw new Error('blenderStudio did not activate')
  return { ctx, studio }
}

const sleep = ms => new Promise(settle => setTimeout(settle, ms))
const framesIn = directory => (existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.png')).length : 0)

const PROJECT = process.env.DEEPBLEND_ACCEPTANCE_PROJECT ?? 'watch-commercial'
const REVISION = process.env.DEEPBLEND_ACCEPTANCE_REVISION ?? 'r0029'

/* -------------------------------------------------------------------------- */
/* start                                                                       */
/* -------------------------------------------------------------------------- */

async function commandStart(argv) {
  const [first, last] = (option(argv, 'frames', '30-89')).split('-').map(Number)
  const { studio } = await makeHost()
  try {
    const started = await studio.startFinalRender({ projectId: PROJECT, revision: REVISION, frameStart: first, frameEnd: last })
    const job = studio.renderJobs.read(PROJECT, started.jobId)
    say('ACCEPT_STARTED', {
      jobId: started.jobId,
      dshJobId: started.dshJobId,
      projectId: started.projectId,
      revision: started.revision,
      frameStart: started.frameStart,
      frameEnd: started.frameEnd,
      frames: started.frames,
      profile: studio.config.finalRenderProfile,
      jobDirectory: job.jobDirectory,
    })
  } catch (cause) {
    // A conflicting unfinished job is the most likely reason to get here, and the
    // useful answer is which job it is rather than a stack trace.
    say('ACCEPT_START_FAILED', { code: cause?.code ?? null, message: cause?.message ?? String(cause) })
    process.exitCode = 1
    return
  }
  setInterval(() => {}, 1000)
}

/* -------------------------------------------------------------------------- */
/* recover                                                                     */
/* -------------------------------------------------------------------------- */

async function commandRecover(argv) {
  const jobId = option(argv, 'job')
  const { studio } = await makeHost()

  console.log('\n── a NEW Host, in a NEW process, reading only the store ──')
  const findings = await studio.awaitReconciliation()
  say('reconciled', findings.map(entry => ({
    jobId: entry.jobId,
    previousStatus: entry.previousStatus,
    status: entry.status,
    process: entry.process,
    ledger: entry.ledger,
    notes: entry.notes,
  })))

  const target = jobId ?? findings.find(entry => entry.projectId === PROJECT)?.jobId
  if (target === undefined) {
    say('ACCEPT_RESULT', { ok: false, reason: 'no unfinished render job was found to recover' })
    process.exitCode = 1
    return
  }

  const record = studio.renderJobs.read(PROJECT, target)
  const expected = studio.renderJobs.expectedFrames(record)
  const present = expected.filter(frame => existsSync(join(record.framesDirectory, `frame_${String(frame).padStart(4, '0')}.png`)))
  say('before.resume', {
    jobId: target,
    status: record.status,
    expected: expected.length,
    present: present.length,
    missing: expected.length - present.length,
  })

  const resumed = await studio.resumeRenderJob({ projectId: PROJECT, jobId: target })
  say('resumed', { resumed: resumed.resumed, alreadyComplete: resumed.alreadyComplete, frames: resumed.resumedFrames.slice(0, 12) })

  // Wait for the delivery, reporting progress so a human watching the terminal can
  // see it moving rather than wondering whether it stalled.
  const deadline = Date.now() + 6 * 60 * 60 * 1000
  let lastPercent = -1
  while (Date.now() < deadline) {
    const job = (await studio.getJob({ projectId: PROJECT, jobId: target })).renderJob
    if (job.percent !== lastPercent) {
      lastPercent = job.percent
      console.log(`  progress: ${job.completedFrames}/${job.expectedFrames} (${job.percent}%) ${job.status}` +
        (job.estimatedRemainingMs ? ` ~${Math.round(job.estimatedRemainingMs / 60000)} min left` : ''))
    }
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break
    await sleep(5000)
  }

  const finished = (await studio.getJob({ projectId: PROJECT, jobId: target })).renderJob
  const projectDirectory = studio.store.projectDirectory(PROJECT)
  const videoPath = join(projectDirectory, 'output', 'final.mp4')
  const manifestPath = join(projectDirectory, 'output', 'delivery-manifest.json')

  let probe = null
  if (existsSync(videoPath)) {
    probe = JSON.parse(execFileSync(FFPROBE, [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name,nb_read_frames,r_frame_rate,pix_fmt',
      '-show_entries', 'format=duration,size,format_name', '-print_format', 'json', videoPath,
    ], { encoding: 'utf8', timeout: 300_000 }))
  }

  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  const ledger = finished.delivery?.status === 'published' ? studio._readJobLedger(
    studio.renderJobs.read(PROJECT, target), expected,
  ) : null

  say('ACCEPT_RESULT', {
    ok: finished.status === 'completed' && finished.delivery?.status === 'published',
    jobId: target,
    status: finished.status,
    delivery: finished.delivery ?? null,
    frames: {
      expected: finished.expectedFrames,
      rendered: finished.completedFrames,
      bytesOnDisk: ledger === null ? null : ledger.present.reduce((total, entry) => total + entry.bytes, 0),
    },
    video: probe === null ? null : {
      path: videoPath,
      bytes: statSync(videoPath).size,
      width: probe.streams[0].width,
      height: probe.streams[0].height,
      codec: probe.streams[0].codec_name,
      pixFmt: probe.streams[0].pix_fmt,
      frameCount: Number(probe.streams[0].nb_read_frames),
      fps: probe.streams[0].r_frame_rate,
      durationSeconds: Number(probe.format.duration),
      container: probe.format.format_name,
    },
    manifest: manifest === null ? null : {
      path: manifestPath,
      verified: manifest.video.verified,
      problems: manifest.video.problems,
      completeness: manifest.completeness,
      claimed: manifest.video.expected,
      probed: manifest.video.probed,
      videoSha256: manifest.video.sha256,
      sceneSpecSha256: manifest.source.sceneSpec.sha256,
    },
  })
  process.exitCode = finished.status === 'completed' ? 0 : 1
}

/* -------------------------------------------------------------------------- */
/* status                                                                      */
/* -------------------------------------------------------------------------- */

async function commandStatus() {
  const { studio } = await makeHost()
  await studio.awaitReconciliation()
  const listing = await studio.listJobs({ projectId: PROJECT })
  for (const job of listing.jobs) say('job', {
    jobId: job.jobId, status: job.status, attempt: job.attempt,
    frames: `${job.completedFrames}/${job.expectedFrames}`, percent: job.percent,
    pid: job.pid, delivery: job.delivery?.status ?? null, message: job.message,
  })
  const projectDirectory = studio.store.projectDirectory(PROJECT)
  for (const relative of ['output/final.mp4', 'output/delivery-manifest.json', 'renders/manifest.json']) {
    const path = join(projectDirectory, relative)
    say(`artifact ${relative}`, existsSync(path) ? `${statSync(path).size} bytes` : 'absent')
  }
}

/* -------------------------------------------------------------------------- */
/* run — the driver                                                            */
/* -------------------------------------------------------------------------- */

async function commandRun(argv) {
  const frames = option(argv, 'frames', '30-89')
  const killAt = Number(option(argv, 'kill-at', '8'))
  const [first] = frames.split('-').map(Number)

  console.log(`── phase 1: a Host in its own process starts a REAL delivery of ${PROJECT}/${REVISION} frames ${frames} ──`)
  const child = spawn(process.execPath, [import.meta.filename, 'start', '--frames', frames], { stdio: 'inherit' })

  console.log(`\n── phase 2: wait for ${killAt} frame(s), then SIGKILL the Host (its Blender survives) ──`)
  const deadline = Date.now() + 60 * 60 * 1000
  let landed = 0
  while (Date.now() < deadline) {
    // The job directory is not known to this process — the Host in the child process
    // minted it — so the count is taken from the newest render job on disk rather
    // than guessed from a path this process would have to predict.
    landed = newestJobFrames()
    if (landed >= killAt) break
    if (child.exitCode !== null) throw new Error(`the starting Host exited early with ${child.exitCode}`)
    await sleep(1000)
  }
  say('frames.at.kill', landed)
  child.kill('SIGKILL')
  await new Promise(resolveDone => child.once('exit', resolveDone))
  say('host.killed', { pid: child.pid, signal: 'SIGKILL' })

  console.log('\n── phase 3: recovery, resume and delivery, in a new process ──')
  const recovery = spawn(process.execPath, [import.meta.filename, 'recover'], { stdio: 'inherit' })
  const code = await new Promise(resolveDone => recovery.once('exit', resolveDone))
  process.exit(code ?? 1)
}

/** Frames present in the newest render job directory of the given frame range. */
function newestJobFrames() {
  const rendersRoot = join(STORE, 'projects', PROJECT, 'renders')
  if (!existsSync(rendersRoot)) return 0
  const jobs = readdirSync(rendersRoot).filter(name => /^render-\d+$/.test(name)).sort()
  if (jobs.length === 0) return 0
  return framesIn(join(rendersRoot, jobs[jobs.length - 1], 'frames'))
}

const commands = { run: commandRun, start: commandStart, recover: commandRecover, status: commandStatus }
const command = process.argv[2]
if (commands[command] === undefined) {
  console.error(`usage: m3-delivery-acceptance.mjs <${Object.keys(commands).join('|')}> [--frames A-B] [--kill-at N] [--job render-NNNN]`)
  process.exit(2)
}
await commands[command](process.argv.slice(3))
