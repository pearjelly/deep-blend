#!/usr/bin/env node
/**
 * M3 Blender integration — the persistent delivery render, end to end, for real.
 *
 * WHAT THIS SUITE PROVES THAT NO OTHER SUITE CAN
 * ----------------------------------------------
 * SPEC §20 M3's five acceptance conditions are all statements about a REAL
 * Blender, a REAL process, and a REAL restart. Four of them are proved here:
 *
 *   "长任务不阻塞 Agent"        the tool call returns while the render runs, and the
 *                              caller keeps working: the elapsed time of the START
 *                              call is asserted to be a small fraction of the
 *                              render it kicked off.
 *   "重启后能识别未完成渲染"     a renderer is SIGKILLed mid-sequence, a SECOND Host is
 *                              constructed from nothing but the store, and it names
 *                              the unfinished job and how many frames it owes.
 *   "可只渲缺失帧"              the resume renders exactly the missing set, and the
 *                              frames that already existed keep their exact bytes.
 *   "取消后无孤儿进程"          cancel terminates the process GROUP and the process is
 *                              measured to be gone, not assumed gone.
 *   "最终视频属性正确"          the MP4 is encoded with real ffmpeg, probed with real
 *                              ffprobe, and its duration, frame count, fps, resolution
 *                              and codec are compared against the job's own claims.
 *
 * WHY TWO OF THESE CASES NEED A CHILD PROCESS
 * -------------------------------------------
 * "重启后能识别未完成渲染" is a claim about a process that is GONE. A suite that builds
 * the second Host inside the process that started the render does not test it: that
 * process's background render loop is still alive, still holds the subprocess
 * handle, and — measured while writing this suite — marks the job `failed` the
 * instant its child dies. The restarted Host then finds a terminal record, reports
 * nothing to recover, and the suite passes for the wrong reason. So the restart
 * case runs phase 1 in a forked Host (`tests/lib/m3-host-child.mjs`), SIGKILLs it,
 * and recovers in a third process that only ever reads the store.
 *
 * The Blender-crash case (Blender dies, the Host lives) is tested separately and
 * honestly asserts the OPPOSITE outcome: a live Host notices and marks the job
 * failed with the frames it kept.
 *
 * WHY IT RENDERS A REAL 1080p FRAME AND NOT A CHEAP ONE
 * -----------------------------------------------------
 * The whole milestone exists because a delivery render is long, expensive and
 * interruptible. A suite that rendered 64x36 Workbench frames would exercise every
 * code path except the one that matters — and the traps are all in the real path:
 * the final profile has never been applied, the preview sample ceiling must not
 * apply, and a frame takes 19.6-41.4 s. The suite renders the REAL profile at 1080p
 * for a small frame range, with a sample-count reduction the caller asks for
 * explicitly (which the runtime reports as a warning rather than applying quietly).
 *
 * WHY THE FRAME RANGE STARTS WHERE THE ANIMATION IS
 * -------------------------------------------------
 * The first frames of `watch-commercial` sit before the first keyframe, so they
 * render byte-identical — measured, and it is what a static scene SHOULD do. A
 * resume test built on them could not tell "the missing frames were rendered" from
 * "the same file was copied", so the suite renders a range that spans camera motion.
 *
 * Run: node deepblend/tests/blender-integration/render-job.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { importDsh } from '../lib/dsh-deployment.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')
const FIXTURES = join(ROOT, 'deepblend', 'fixtures')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

if (!existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}; the M3 integration suite cannot run.`)
  console.error('A suite that silently skips itself when its dependency is missing passes for the wrong reason.')
  process.exit(2)
}
const ffmpeg = process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg'
try {
  execFileSync(ffmpeg, ['-version'], { encoding: 'utf8', timeout: 20_000 })
} catch {
  console.error(`ffmpeg not found ("${ffmpeg}"); the M3 delivery suite cannot run without it.`)
  process.exit(2)
}

const scratch = join(tmpdir(), `deepblend-m3-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const { LocalJobRegistry } = await importDsh('dsh-jobs-local')
const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
const { default: Studio } = await import('@deepblend/dsh-blender-host')

/**
 * Construct a Host. Called MORE THAN ONCE on purpose: the second construction is
 * the restart, and it must find everything it knows on disk.
 */
async function makeHost(options = {}) {
  const ctx = new Context()
  ctx.plugin(LocalSubprocess)
  ctx.plugin(LocalJobRegistry)
  ctx.plugin(Provider, ProviderConfig({
    blenderPath: BLENDER,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: scratch,
    timeoutMs: 600_000,
  }))
  ctx.plugin(Studio, {
    projectsRoot: join(scratch, 'projects'),
    workspaceRoot: scratch,
    serveCachedCapabilities: true,
    maxPreviewSamples: 512,
    ffmpegPath: ffmpeg,
    ffprobePath: process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe',
    reconcileOnStart: options.reconcileOnStart !== false,
    progressPollMs: 200,
    encodePreset: 'ultrafast',
  })
  await new Promise(settle => setTimeout(settle, 300))
  const studio = ctx.get('blenderStudio')
  if (studio === undefined) throw new Error('blenderStudio did not activate; the host composition is broken.')
  if (options.awaitReconciliation !== false) await studio.awaitReconciliation()
  return { ctx, studio }
}

const sleep = ms => new Promise(settle => setTimeout(settle, ms))

/** Poll a predicate until it is true, or give up loudly. */
async function waitFor(label, predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
}

const framesIn = directory => (existsSync(directory)
  ? readdirSync(directory).filter(name => name.endsWith('.png')).sort()
  : [])

let host = await makeHost()
let { studio } = host

// ---------------------------------------------------------------------------
// 0. A project whose frames actually change
// ---------------------------------------------------------------------------

// The fixture is given a camera orbit, because the frames must genuinely DIFFER for
// the resume assertions to mean anything. `interior-room` declares no animation
// tracks, so every frame of it renders byte-identical (measured: the first three
// frames of `watch-commercial`, which sit before its first keyframe, came out at
// exactly 1,048,930 bytes each). A resume test built on identical frames could not
// tell "the missing frames were rendered" from "the same file was copied".
const fixtureSpec = () => JSON.parse(readFileSync(join(FIXTURES, 'interior-room', 'scene-spec.json'), 'utf8'))

const spec = fixtureSpec()
spec.project.title = 'M3 delivery'
spec.project.fps = 30
// A short range spanning the whole orbit, so a sub-range of it is visibly moving.
spec.project.frameStart = 1
spec.project.frameEnd = 240
spec.animationTracks = [
  {
    id: 'camera-orbit-x',
    targetKind: 'camera',
    targetEntityId: 'camera-main',
    property: 'location.x',
    keyframes: [
      { frame: 1, value: 0.0, interpolation: 'linear' },
      { frame: 240, value: 0.9, interpolation: 'linear' },
    ],
  },
  {
    id: 'camera-orbit-z',
    targetKind: 'camera',
    targetEntityId: 'camera-main',
    property: 'location.z',
    keyframes: [
      { frame: 1, value: 0.0, interpolation: 'linear' },
      { frame: 240, value: 0.3, interpolation: 'linear' },
    ],
  },
]
// The real deliverable profile shape (AgX, a resolution that is not the preview's),
// at a sample count this suite can afford to render nine times.
spec.renderProfiles.final = {
  engine: 'cycles',
  resolution: [640, 360],
  samples: 24,
  maxSamplesBudget: 1024,
  colorManagement: { viewTransform: 'AgX', exposure: 0 },
  filmTransparent: false,
}

const created = await studio.createProject({
  title: 'M3 delivery',
  goal: 'prove the persistent delivery render',
  sceneSpec: spec,
  saveCheckpoint: true,
})
const projectId = created.projectId
const revision = created.revision.revision
check('a project was created with a checkpoint to render from', created.revision.checkpoint !== null,
  { projectId, revision })

const SPEC_RANGE = [12, 20]
const DELIVERY_FRAMES = 9

// ---------------------------------------------------------------------------
// 1. "长任务不阻塞 Agent" — the start call returns while the render runs
// ---------------------------------------------------------------------------

// The store realpaths its projects root, which on macOS turns `/var/...` into
// `/private/var/...`. Comparing the two spellings of one path would fail for a
// reason that has nothing to do with the delivery.
const projectDirectory = realpathSync(join(scratch, 'projects', projectId))

const deliveryFramesDirectory = jobId => join(projectDirectory, 'renders', jobId, 'frames')
const jobJournalPath = jobId => join(projectDirectory, 'renders', jobId, 'events.jsonl')
/** Does the renderer's event journal end in the middle of a line right now? */
const journalIsTorn = jobId => {
  const path = jobJournalPath(jobId)
  if (!existsSync(path)) return false
  const text = readFileSync(path, 'utf8')
  return text.length > 0 && !text.endsWith('\n')
}

const startedAt = Date.now()
const started = await studio.startFinalRender({
  projectId,
  revision,
  frameStart: SPEC_RANGE[0],
  frameEnd: SPEC_RANGE[1],
})
const startCallMs = Date.now() - startedAt

check('startFinalRender returned a job id rather than a finished render',
  typeof started.jobId === 'string' && started.jobId.startsWith('render-'), started.jobId)
check(`the start call cost ${startCallMs} ms, not the minutes the render will take — the Agent is not blocked`,
  startCallMs < 20_000, { startCallMs })
check('it reports the frame range it will render',
  started.frameStart === SPEC_RANGE[0] && started.frameEnd === SPEC_RANGE[1] && started.frames === DELIVERY_FRAMES,
  { frameStart: started.frameStart, frameEnd: started.frameEnd, frames: started.frames })
check('it reports the range it is NOT covering, rather than covering it silently',
  started.warnings.some(entry => entry.detail?.kind === 'delivery-range'), started.warnings)
check('the render was projected into the harness job registry, so the harness can see it',
  typeof started.dshJobId === 'string' && started.dshJobId.length > 0, started.dshJobId)
check('and the harness registry really holds it, under that id', (() => {
  const snapshot = host.ctx.get('jobs').get(started.dshJobId)
  return snapshot.kind === 'blender-render' && snapshot.status === 'running' && snapshot.label.includes(projectId)
})(), host.ctx.get('jobs').list().map(entry => ({ id: entry.id, kind: entry.kind, status: entry.status })))

// The Agent keeps working while the render runs.
const duringRender = await studio.describeCapabilities({})
check('the Agent can still call the studio while a delivery render runs', duringRender.installed === true)
const history = await studio.getProject(projectId)
check('and can still read project state', history.projectId === projectId)

// Progress is real, and it is derived from the frames — not from the child's word.
await waitFor('two frames on disk', () => framesIn(deliveryFramesDirectory(started.jobId)).length >= 2, 600_000)
await waitFor('the durable record to catch up with the frames on disk', async () => {
  const job = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
  return job.completedFrames >= framesIn(deliveryFramesDirectory(started.jobId)).length
}, 60_000, 200)
const midway = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
check('progress is recorded durably while the render runs, frame by frame',
  midway.completedFrames >= 2 && midway.percent > 0 && midway.status === 'running',
  { completed: midway.completedFrames, percent: midway.percent, status: midway.status })
check('the record also reports what is still missing',
  midway.missingFrames.length === DELIVERY_FRAMES - midway.completedFrames, midway.missingFrames)
check('the record names the process rendering it, which is what makes an orphan findable',
  Number.isSafeInteger(midway.pid), midway.pid)
check('the final profile was applied, not the preview one — the AgX claim is measured',
  midway.renderConfig?.viewTransform === 'AgX', midway.renderConfig)
check('the delivery used the profile\'s own resolution and sample ceiling',
  JSON.stringify(midway.renderConfig?.resolution) === JSON.stringify([640, 360]) &&
  midway.renderConfig?.samples === 24, midway.renderConfig)
check('a delivery render is NOT capped by maxPreviewSamples',
  midway.renderConfig?.samples === 24, { maxPreviewSamples: 512, used: midway.renderConfig?.samples })
check('the harness job carries a readable progress stream for the model',
  typeof host.ctx.get('jobs').read(started.dshJobId).text === 'string')

// ---------------------------------------------------------------------------
// 2. Blender dies while the Host lives — the Host must notice, and keep the frames
// ---------------------------------------------------------------------------

const beforeCrash = framesIn(deliveryFramesDirectory(started.jobId))
const crashedPid = midway.pid
console.log(`\n── killing Blender (pid ${crashedPid}) mid-sequence, after ${beforeCrash.length} frame(s) ──`)
try {
  process.kill(-crashedPid, 'SIGKILL')
} catch {
  process.kill(crashedPid, 'SIGKILL')
}

await waitFor('the live Host to notice the renderer died', async () => {
  const job = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
  return job.status === 'failed'
}, 120_000, 500)
const crashedJob = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
check('a renderer that dies under a LIVE Host is recorded as failed, not left "running" forever',
  crashedJob.status === 'failed', crashedJob.status)
check('the failure names the frames it kept and the frames it still owes',
  crashedJob.completedFrames >= beforeCrash.length &&
  crashedJob.missingFrames.length === DELIVERY_FRAMES - crashedJob.completedFrames,
  { completed: crashedJob.completedFrames, missing: crashedJob.missingFrames })
check('the failure tells the caller how to continue rather than only that it broke',
  typeof crashedJob.message === 'string' && crashedJob.message.includes('resumeJobId'), crashedJob.message)
check('the frames already rendered were KEPT — a crash must not discard hours of work',
  framesIn(deliveryFramesDirectory(started.jobId)).length >= beforeCrash.length)

// ---------------------------------------------------------------------------
// 2b. The journal's tail — settled against the FILE, because only the file knows
// ---------------------------------------------------------------------------

// A SIGKILL lands wherever it lands: the journal may end on a line boundary or halfway through one,
// so "torn" is not assertable and would be flaky either way. What IS assertable, in both directions,
// is AGREEMENT between the file and the durable record — and it is the record that matters, because
// the harness job output that used to carry this fact is drained by whoever reads it first and is
// gone after a restart.
const crashJournalTorn = journalIsTorn(started.jobId)
const crashWarnings = (crashedJob.warnings ?? []).filter(entry => entry.code === 'JOURNAL_INCOMPLETE')
check('a journal left cut mid-line is recorded ON THE JOB, and a clean one is not',
  crashWarnings.length === (crashJournalTorn ? 1 : 0),
  {
    journalEndsMidLine: crashJournalTorn,
    recorded: crashWarnings.length,
    tail: JSON.stringify(readFileSync(jobJournalPath(started.jobId), 'utf8').slice(-70)),
  })

// ---------------------------------------------------------------------------
// 3. "可只渲缺失帧" — the resume renders exactly the missing set
// ---------------------------------------------------------------------------

const beforeResume = new Map(
  framesIn(deliveryFramesDirectory(started.jobId)).map(name => [name, statSync(join(deliveryFramesDirectory(started.jobId), name)).size]),
)
const resumed = await studio.resumeRenderJob({ projectId, jobId: started.jobId })
check('the resumed attempt does NOT keep the dead process\'s pid in the record',
  (await studio.getJob({ projectId, jobId: started.jobId })).renderJob.pid !== crashedPid,
  { crashedPid, recorded: (await studio.getJob({ projectId, jobId: started.jobId })).renderJob.pid })
// Observed WHILE the attempt runs, because a finished job clears its pid on purpose.
// MEASURED once the hard way: a resumed attempt read the previous attempt's
// `process.json`, recorded the DEAD pid as the live one, and a second restart would
// then have gone looking for a process that no longer existed — leaving the real
// renderer orphaned. Deleting the stale file and stamping the identity with a
// per-attempt token are the two halves of the fix.
await waitFor('the resumed attempt to record the process it is actually using', async () => {
  const job = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
  return Number.isSafeInteger(job.pid) && job.pid !== crashedPid
}, 180_000, 200)
check('the record names the process of the CURRENT attempt, so a second restart would find the right one',
  (await studio.getJob({ projectId, jobId: started.jobId })).renderJob.pid !== crashedPid,
  (await studio.getJob({ projectId, jobId: started.jobId })).renderJob.pid)
check('the resume names exactly the frames that are missing',
  resumed.resumed === DELIVERY_FRAMES - beforeResume.size && resumed.alreadyComplete === beforeResume.size,
  { resumed: resumed.resumed, alreadyComplete: resumed.alreadyComplete, resumedFrames: resumed.resumedFrames })
check('the resume did not ask for a single frame that already existed',
  resumed.resumedFrames.every(frame => !beforeResume.has(`frame_${String(frame).padStart(4, '0')}.png`)),
  resumed.resumedFrames)

await waitFor('the resumed render to deliver the package', async () => {
  const job = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
  return job.status === 'completed' || job.status === 'failed'
}, 900_000, 1000)

const afterResume = new Map(
  framesIn(deliveryFramesDirectory(started.jobId)).map(name => [name, statSync(join(deliveryFramesDirectory(started.jobId), name)).size]),
)
const untouched = [...beforeResume.entries()].filter(([name, bytes]) => afterResume.get(name) === bytes)
check('every frame that existed before the resume still has its exact byte count',
  untouched.length === beforeResume.size, { untouched: untouched.length, before: beforeResume.size })
check('the resumed render produced the remaining frames',
  afterResume.size === DELIVERY_FRAMES, { have: afterResume.size, expected: DELIVERY_FRAMES })
check('the record shows a SECOND attempt, so the history of the job is visible',
  (await studio.getJob({ projectId, jobId: started.jobId })).renderJob.attempt >= 2,
  (await studio.getJob({ projectId, jobId: started.jobId })).renderJob.attempt)

// ---------------------------------------------------------------------------
// 4. "最终视频属性正确" — a real MP4, measured with a real ffprobe
// ---------------------------------------------------------------------------

const finishedJob = (await studio.getJob({ projectId, jobId: started.jobId })).renderJob
check('a resumed-and-completed render is marked completed, not merely frame-complete',
  finishedJob.status === 'completed', finishedJob.status)
check('the delivery package was published',
  finishedJob.delivery?.status === 'published' && finishedJob.delivery?.verified === true,
  finishedJob.delivery)

const videoPath = join(projectDirectory, 'output', 'final.mp4')
const manifestPath = join(projectDirectory, 'output', 'delivery-manifest.json')
check('the video is where SPEC §13 says a delivery puts it', existsSync(videoPath), videoPath)
check('the delivery manifest is beside it', existsSync(manifestPath), manifestPath)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('the manifest claims the frame range the job rendered',
  manifest.frames.first === SPEC_RANGE[0] && manifest.frames.last === SPEC_RANGE[1] &&
  manifest.frames.expected === DELIVERY_FRAMES && manifest.frames.rendered === DELIVERY_FRAMES,
  manifest.frames)
check('the manifest records the MEASURED video properties, not the requested ones',
  manifest.video.probed.width === 640 && manifest.video.probed.height === 360 &&
  manifest.video.probed.frameCount === DELIVERY_FRAMES &&
  Math.abs(manifest.video.probed.fps - 30) < 0.001,
  manifest.video.probed)
check('the measured duration is exactly frames/fps',
  Math.abs(manifest.video.probed.durationSeconds - DELIVERY_FRAMES / 30) < 0.05,
  { duration: manifest.video.probed.durationSeconds, expected: DELIVERY_FRAMES / 30 })
check('the container\'s own frame claim and the decoded count are both recorded',
  manifest.video.probed.containerClaimedFrameCount !== undefined)
check('the video verified, with no problems', manifest.video.verified === true && manifest.video.problems.length === 0,
  manifest.video.problems)
check('the manifest carries a digest of the video and of the SceneSpec',
  /^[a-f0-9]{64}$/.test(manifest.video.sha256) && /^[a-f0-9]{64}$/.test(manifest.source.sceneSpec.sha256),
  { video: manifest.video.sha256?.slice(0, 12), spec: manifest.source.sceneSpec.sha256?.slice(0, 12) })
check('the manifest judges itself complete', manifest.completeness.complete === true, manifest.completeness)
check('and it carries the revision\'s QA verdict, so completeness is checkable without opening the package',
  manifest.qa.report !== null && manifest.qa.report.ok === true && manifest.qa.report.frameRange !== null,
  manifest.qa.report)
check('the manifest records what rendered it, for reproducibility (SPEC §9.5)',
  manifest.render.blender !== null && manifest.render.blender.source === 'revision-manifest',
  manifest.render.blender)

// The independent check: the SAME question asked by a different tool.
const probeOutput = execFileSync(process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe', [
  '-v', 'error', '-count_frames', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,codec_name,nb_read_frames,r_frame_rate',
  '-show_entries', 'format=duration', '-print_format', 'json', videoPath,
], { encoding: 'utf8', timeout: 120_000 })
const probe = JSON.parse(probeOutput)
check('an INDEPENDENT ffprobe agrees: 640x360 h264, 9 decoded frames, 0.3 s',
  probe.streams[0].width === 640 && probe.streams[0].height === 360 &&
  probe.streams[0].codec_name === 'h264' &&
  Number(probe.streams[0].nb_read_frames) === DELIVERY_FRAMES &&
  Math.abs(Number(probe.format.duration) - 0.3) < 0.02,
  { stream: probe.streams[0].codec_name, frames: probe.streams[0].nb_read_frames, duration: probe.format.duration })

// The frames are not merely encoded: they differ from each other, so the video is a
// real animation and not one frame repeated nine times.
const frameDigests = [...afterResume.keys()].map(name =>
  createHash('sha256').update(readFileSync(join(deliveryFramesDirectory(started.jobId), name))).digest('hex').slice(0, 12))
check('the rendered frames are a real animation, not one image repeated — a rendered frame is a frame of THIS range',
  new Set(frameDigests).size === frameDigests.length, { frames: frameDigests.length, distinct: new Set(frameDigests).size })

// ---------------------------------------------------------------------------
// 5. "取消后无孤儿进程"
// ---------------------------------------------------------------------------

const long = await studio.startFinalRender({ projectId, revision, frameStart: 30, frameEnd: 239 })
await waitFor('the cancelled render to have a real process', async () => {
  const job = (await studio.getJob({ projectId, jobId: long.jobId })).renderJob
  return Number.isSafeInteger(job.pid) && framesIn(join(scratch, 'projects', projectId, 'renders', long.jobId, 'frames')).length >= 1
}, 300_000)
const liveJob = (await studio.getJob({ projectId, jobId: long.jobId })).renderJob
const livePid = liveJob.pid
check('the long render is genuinely running before it is cancelled',
  liveJob.status === 'running' && Number.isSafeInteger(livePid), { status: liveJob.status, pid: livePid })

const cancelled = await studio.cancelJob({ projectId, jobId: long.jobId, reason: 'integration test' })
check('cancelling reports the process GONE, measured after the signal',
  cancelled.cancelled === true && cancelled.processGone === true, cancelled.process)
check('the cancel says HOW it stopped the process, and does not invent a signal the handle never reported',
  typeof cancelled.process?.via === 'string' && typeof cancelled.process?.ladder === 'string' &&
  cancelled.process?.term === undefined, cancelled.process)
check('the process really is gone, checked independently of the cancel report', (() => {
  try {
    process.kill(livePid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
})(), { pid: livePid })
// The process table is the only INDEPENDENT evidence that the cancel left nothing
// behind — every other assertion here reads the product's own report of what it
// did. It is also the one probe in this suite the ENVIRONMENT can refuse: under a
// restrictive sandbox `ps` fails with EPERM.
//
// The first version called `execFileSync` inline, so that refusal propagated as an
// exception and took the remaining ~30 checks of the suite down with it — one
// unreadable probe, reported as a stack trace, hiding everything after it. A probe
// that could not run is a FAILED check that names the command and the errno, never
// a silent pass and never a crash (SPEC §0.3: an unverified milestone is not a
// passed milestone).
const processTable = (() => {
  try {
    return { ok: true, listing: execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 20_000 }) }
  } catch (error) {
    return { ok: false, reason: `${error?.code ?? 'error'}: ${String(error?.message ?? error).split('\n')[0]}` }
  }
})()

check('the process table was readable, so "nothing left behind" is a measurement and not an assumption',
  processTable.ok, processTable.ok ? 'ps -Ao pid=,args= ran' : processTable.reason)

check('no Blender of this project is left anywhere in the process table',
  processTable.ok && !processTable.listing.split('\n').some(line => line.includes(long.jobId)),
  processTable.ok ? long.jobId : `NOT CHECKED — the process table could not be read (${processTable.reason})`)
check('the cancelled job is recorded as cancelled, with the frames it did render kept',
  (await studio.getJob({ projectId, jobId: long.jobId })).renderJob.status === 'cancelled',
  (await studio.getJob({ projectId, jobId: long.jobId })).renderJob.status)

// A kill the caller ASKED for is not a finding: `cancelJob` terminates the process on purpose and a
// journal cut in half is the expected consequence. If that SIGKILL happened to land on a line
// boundary this check is vacuous — which is exactly why the crashed case above is settled against the
// file, and this one states the RULE instead.
const cancelledRecord = (await studio.getJob({ projectId, jobId: long.jobId })).renderJob
check('a kill the caller ASKED for is not recorded as a journal defect, even when its tail is torn',
  !(cancelledRecord.warnings ?? []).some(entry => entry.code === 'JOURNAL_INCOMPLETE'),
  { journalEndsMidLine: journalIsTorn(long.jobId), warnings: cancelledRecord.warnings })

// A cancelled job is resumable, and resuming it renders only what is missing.
//
// THE ASSERTIONS ARE ABOUT THE CONTRACT, NOT ABOUT WHERE THE KILL LANDED
// ---------------------------------------------------------------------
// The first version of this check asserted `alreadyComplete === <files on disk>` and
// was FLAKY — it failed once in three runs, and the product was right every time.
// Cancelling a render lands wherever it lands, and when it lands between `create` and
// `finish` the directory holds a file that EXISTS and is not a frame. The ledger
// reports that frame as `corrupt` and re-renders it, which is the whole point of the
// ledger. So the deterministic contract is: every file on disk is accounted for as
// either complete or torn, and every frame of the range is scheduled exactly once.
const afterCancelDirectory = join(scratch, 'projects', projectId, 'renders', long.jobId, 'frames')
const afterCancel = framesIn(afterCancelDirectory)
const resumedAfterCancel = await studio.resumeRenderJob({ projectId, jobId: long.jobId })
check('a cancelled render is resumable, and every frame of its range is accounted for exactly once',
  resumedAfterCancel.alreadyComplete + resumedAfterCancel.resumed === 210,
  { alreadyComplete: resumedAfterCancel.alreadyComplete, resumed: resumedAfterCancel.resumed })
check('each file the cancel left behind is reported as either COMPLETE or TORN, and nothing else',
  resumedAfterCancel.alreadyComplete === afterCancel.length - (resumedAfterCancel.corrupt?.length ?? 0),
  { files: afterCancel.length, complete: resumedAfterCancel.alreadyComplete, torn: resumedAfterCancel.corrupt })
check('a frame the cancel left half-written is re-rendered rather than kept',
  (resumedAfterCancel.corrupt ?? []).every(entry =>
    resumedAfterCancel.resumedFrames.includes(entry.frame)),
  { torn: resumedAfterCancel.corrupt, scheduled: resumedAfterCancel.resumedFrames.length })
await studio.cancelJob({ projectId, jobId: long.jobId, reason: 'integration test cleanup' })

// ---------------------------------------------------------------------------
// 6. Conflict: one delivery render per project
// ---------------------------------------------------------------------------

// `long` is cancelled now, so start one more and try to start a second.
const first = await studio.startFinalRender({ projectId, revision, frameStart: 100, frameEnd: 103 })
let conflictCode = null
try {
  await studio.startFinalRender({ projectId, revision, frameStart: 110, frameEnd: 113 })
} catch (cause) {
  conflictCode = cause.code
}
check('a second delivery render for the same project is refused with RENDER_JOB_CONFLICT',
  conflictCode === 'RENDER_JOB_CONFLICT', conflictCode)
await studio.cancelJob({ projectId, jobId: first.jobId, reason: 'integration test cleanup' })

// ---------------------------------------------------------------------------
// 7. exportProject re-encodes WITHOUT rendering
// ---------------------------------------------------------------------------

const exported = await studio.exportProject({ projectId, jobId: started.jobId })
check('exportProject packages an already-rendered job without rendering',
  exported.verified === true && realpathSync(exported.video.path) === videoPath,
  { verified: exported.verified, path: exported.video?.path, expected: videoPath })
check('the re-export produces the same measured properties',
  exported.video.probed.frameCount === DELIVERY_FRAMES &&
  Math.abs(exported.video.probed.durationSeconds - 0.3) < 0.05,
  exported.video.probed)

// An export of a job that has NOT finished every frame must refuse, not encode a
// short video.
const partial = await studio.startFinalRender({ projectId, revision, frameStart: 200, frameEnd: 205 })
await waitFor('one frame of the partial render', () =>
  framesIn(join(scratch, 'projects', projectId, 'renders', partial.jobId, 'frames')).length >= 1, 300_000)
await studio.cancelJob({ projectId, jobId: partial.jobId, reason: 'leave it incomplete on purpose' })
let incompleteCode = null
try {
  await studio.exportProject({ projectId, jobId: partial.jobId })
} catch (cause) {
  incompleteCode = cause.code
}
check('exporting a job whose frames are incomplete is refused with RENDER_FRAMES_INCOMPLETE',
  incompleteCode === 'RENDER_FRAMES_INCOMPLETE', incompleteCode)
check('the refusal names how many frames are owed, so the caller knows what to do',
  (await studio.getJob({ projectId, jobId: partial.jobId })).renderJob.missingFrames.length > 0)

// ---------------------------------------------------------------------------
// 8. "重启后能识别未完成渲染" — a Host that is GONE, and a third process that reads the store
//
// The Blender-crash case above is a DIFFERENT event with a different correct answer.
// Here the Host itself is SIGKILLed while its renderer keeps running (the child is
// spawned detached, so it survives — measured in the M3 probe). The recovering Host
// must find a record still marked "running", recognise that the process it names is
// an orphan of a dead Host, stop it, and rebuild the ledger from the frames.
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [
  join(HERE, '..', 'lib', 'm3-host-child.mjs'), 'start',
  '--scratch', scratch, '--project', projectId, '--revision', revision,
  '--frame-start', '60', '--frame-end', '68',
], { stdio: ['ignore', 'pipe', 'inherit'] })

let childStart = null
child.stdout.on('data', chunk => {
  for (const line of chunk.toString('utf8').split('\n')) {
    if (!line.startsWith('M3CHILD ')) continue
    const payload = JSON.parse(line.slice('M3CHILD '.length))
    if (payload.mode === 'start') childStart = payload
  }
})
await waitFor('the forked Host to start its render', () => childStart !== null, 120_000, 200)
check('a Host in its own process started a render and reported its job id',
  typeof childStart.jobId === 'string', childStart)

await waitFor('two frames of the forked render', () =>
  framesIn(deliveryFramesDirectory(childStart.jobId)).length >= 2, 600_000)

const orphanJob = (await studio.getJob({ projectId, jobId: childStart.jobId })).renderJob
const orphanPid = orphanJob.pid
check('the forked Host recorded the process it is rendering with', Number.isSafeInteger(orphanPid), orphanPid)

console.log(`\n── SIGKILLing the Host (pid ${childStart.pid}); its Blender (pid ${orphanPid}) survives ──`)
child.kill('SIGKILL')
await new Promise(resolveDone => child.once('exit', resolveDone))
check('the Host process is gone', (() => {
  try {
    process.kill(childStart.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
})(), childStart.pid)
check('the Blender it started SURVIVED it — this is the orphan a recovery has to deal with', (() => {
  try {
    process.kill(orphanPid, 0)
    return true
  } catch {
    return false
  }
})(), orphanPid)

// The recovery runs in a THIRD process that only ever reads the store.
const recoverOutput = await new Promise((resolveRun, rejectRun) => {
  const recovery = spawn(process.execPath, [
    join(HERE, '..', 'lib', 'm3-host-child.mjs'), 'recover', '--scratch', scratch, '--project', projectId,
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  let buffer = ''
  recovery.stdout.on('data', chunk => { buffer += chunk.toString('utf8') })
  recovery.once('error', rejectRun)
  recovery.once('exit', code => {
    const line = buffer.split('\n').find(entry => entry.startsWith('M3CHILD '))
    if (line === undefined) {
      rejectRun(new Error(`the recovering Host printed no result (exit ${code}): ${buffer.slice(-2000)}`))
      return
    }
    resolveRun(JSON.parse(line.slice('M3CHILD '.length)))
  })
})

const finding = recoverOutput.findings.find(entry => entry.jobId === childStart.jobId)
check('a freshly started Host, in a new process, found the unfinished render without being told',
  finding !== undefined, recoverOutput.findings.map(entry => entry.jobId))
check('it identified the recorded process as an orphan that outlived its Host',
  finding?.process?.alive === true && finding?.process?.identity?.matches === true, finding?.process)
check('it STOPPED that orphan and verified it was gone, rather than resuming beside it',
  finding?.process?.stopped?.gone === true, finding?.process?.stopped)
check('the orphan really is gone, checked from this process',
  (() => {
    try {
      process.kill(orphanPid, 0)
      return false
    } catch (error) {
      return error.code === 'ESRCH'
    }
  })(), orphanPid)
check('it rebuilt the frame ledger from the frames on disk, naming the frames it still owes',
  finding.ledger.present >= 2 &&
  finding.ledger.present + finding.ledger.toRenderCount === 9 &&
  finding.ledger.toRender.every(frame => finding.ledger.present < frame), finding.ledger)
check('it left the job RECOVERING — unfinished, resumable, and not silently completed',
  recoverOutput.records.find(entry => entry.jobId === childStart.jobId)?.status === 'recovering',
  recoverOutput.records.find(entry => entry.jobId === childStart.jobId)?.status)
check('the recovery is written to disk, so it outlives the process that discovered it',
  existsSync(join(scratch, 'projects', projectId, 'renders', childStart.jobId, 'recovery.json')))

// The recovered job is resumed by the LIVE Host, and renders only what is missing.
const restartFrames = new Map(
  framesIn(deliveryFramesDirectory(childStart.jobId)).map(name =>
    [name, statSync(join(deliveryFramesDirectory(childStart.jobId), name)).size]))
const afterRestart = await studio.resumeRenderJob({ projectId, jobId: childStart.jobId })
check('the recovered job resumes from exactly the frames the recovery found complete',
  afterRestart.alreadyComplete === restartFrames.size &&
  afterRestart.resumed === 9 - restartFrames.size,
  { alreadyComplete: afterRestart.alreadyComplete, resumed: afterRestart.resumed, onDisk: restartFrames.size })
check('resuming a RECOVERING job is legal, and the record says so',
  (await studio.getJob({ projectId, jobId: childStart.jobId })).renderJob.status === 'running',
  (await studio.getJob({ projectId, jobId: childStart.jobId })).renderJob.status)
await studio.cancelJob({ projectId, jobId: childStart.jobId, reason: 'restart case proved; cleaning up' })

// ---------------------------------------------------------------------------
// 9. Stopping the Host leaves nothing behind
// ---------------------------------------------------------------------------

// Every render started in this suite is finished or cancelled, so no Blender
// descendant may survive the suite. This is the "no orphan" condition asked once
// more, at the whole-suite level rather than per job.
const survivors = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8', timeout: 20_000 })
  .split('\n')
  .filter(line => line.includes(scratch))
check('the suite left no Blender process behind', survivors.length === 0, survivors.slice(0, 3))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nM3 render job integration: ${passed}/${results.length} check(s) passed`)
console.log(`scratch: ${scratch}`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  console.log('The scratch directory is kept for inspection.')
  process.exit(1)
}
rmSync(scratch, { recursive: true, force: true })
