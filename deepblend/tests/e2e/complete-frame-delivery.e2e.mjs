#!/usr/bin/env node
/**
 * Native Host → ffmpeg → ffprobe acceptance for already-complete frames.
 * Two generated PNGs are the durable input; Blender is deliberately unavailable.
 * This standalone preparation is not wired into run-all/CI until native review.
 * Retains the isolated store, source hashes, process identities, failures and cleanup.
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import BlenderStudio, { StudioConfig, checkProcessAlive } from '@deepblend/dsh-blender-host'
import { BlenderErrorCode, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const evidence = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(ROOT, '.deepblend/quality', `complete-frame-native-${Date.now()}`))
if (existsSync(evidence)) throw Error(`Evidence directory already exists: ${evidence}`)
mkdirSync(evidence, { recursive: true })
const output = realpathSync(evidence)
const workspaceRoot = join(output, 'store')
const checks = [], handles = [], cleanup = [], calls = []
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
async function bounded(promise, label, timeout = 20000) {
  let timer
  try { return await Promise.race([promise, new Promise((resolveWait, reject) => {
    timer = setTimeout(() => reject(Error(`${label} exceeded ${timeout}ms`)), timeout)
  })]) } finally { clearTimeout(timer) }
}
async function waitFor(label, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (predicate()) return; await sleep(25) }
  throw Error(`${label} exceeded ${timeout}ms`)
}
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`)
}
const ctx = new Context()
let studio, request, failure
try {
  ctx.plugin(LocalSubprocess)
  await waitFor('subprocess composition', () => ctx.get('subprocess') !== undefined)
  const subprocess = ctx.get('subprocess')
  const ffmpeg = await subprocess.resolveExecutable(process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg', { PATH: process.env.PATH ?? '' })
  const ffprobe = await subprocess.resolveExecutable(process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe', { PATH: process.env.PATH ?? '' })
  const spawn = subprocess.spawn.bind(subprocess)
  subprocess.spawn = spec => {
    // Keep this standalone acceptance small even beside another native suite.
    const argv = [...spec.argv]
    if (argv.includes('-i')) {
      argv.splice(argv.indexOf('-i'), 0, '-threads', '1')
      argv.splice(1, 0, '-filter_threads', '1')
    }
    argv.splice(argv.length - 1, 0, '-threads', '1')
    calls.push(argv)
    const handle = spawn({ ...spec, argv })
    handles.push(handle)
    return handle
  }
  let forbiddenCalls = 0
  const forbidden = async () => { forbiddenCalls += 1; throw Error('complete frames must not call Blender') }
  ctx.provide('blenderRuntime', { compileScene: forbidden, startFrameSequence: forbidden, awaitFrameSequence: forbidden, resolveEngineKey: forbidden })
  studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'), reconcileOnStart: false,
    ffmpegPath: ffmpeg, ffprobePath: ffprobe, maxFinalSamples: 1, encodePreset: 'ultrafast' }))
  const sceneSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json')))
  const project = await studio.transactions.createProject({ title: 'complete-native', sceneSpec, saveCheckpoint: false })
  request = { projectId: project.projectId, jobId: 'render-0001' }
  const frames = studio.renderJobs.framesDirectory(request.projectId, request.jobId)
  mkdirSync(frames, { recursive: true })
  for (const frame of [1, 2]) writeFileSync(join(frames, `frame_000${frame}.png`), encodePng(createImage(256, 192, [frame * 50, 70, 110, 255])))
  const beforeFrames = [1, 2].map(frame => sha(join(frames, `frame_000${frame}.png`)))
  studio.renderJobs.write({ ...request, type: 'final-render', status: 'failed', revisionId: project.revision.revision,
    frameStart: 1, frameEnd: 2, expectedFrames: 2, completedFrames: [], missingFrames: [1, 2], corruptFrames: [], fps: 30,
    attempt: 2, attemptToken: 'original-native-frames', renderDurationMs: 123, pid: null, dshJobId: null, warnings: [],
    profileName: 'final', filePrefix: 'frame_', filePadding: 4, checkpointPath: null,
    renderConfig: { resolution: [256, 192], samples: 128 }, delivery: { status: 'failed', attempt: 1 } })
  const sourcePaths = ['packages/deepblend/host/lib/index.js', 'packages/deepblend/host/lib/video-encoder.js']
  json('source.json', Object.fromEntries(sourcePaths.map(path => [path, sha(join(ROOT, path))])))
  json('before.json', studio.renderJobs.read(request.projectId, request.jobId))
  const receipt = await studio.resumeRenderJob(request)
  check('complete frames register a background delivery immediately', receipt.resumed === 0 && receipt.alreadyComplete === 2, receipt)
  await waitFor('verified native delivery', () => !studio._liveRenders.has(`${request.projectId}/${request.jobId}`))
  const job = studio.renderJobs.read(request.projectId, request.jobId)
  const manifest = JSON.parse(readFileSync(job.delivery.manifestPath))
  json('after.json', job)
  check('native ffmpeg and ffprobe produced a verified two-frame delivery', job.status === 'completed' && manifest.video.verified === true
    && manifest.video.probed.frameCount === 2 && manifest.video.probed.width === 256 && manifest.video.probed.height === 192, manifest.video)
  check('no checkpoint, Blender or sampling budget is needed', forbiddenCalls === 0 && job.renderConfig.samples === 128, { forbiddenCalls, samples: job.renderConfig.samples })
  check('render history is unchanged and only delivery attempt increases', job.attempt === 2 && job.attemptToken === 'original-native-frames'
    && job.renderDurationMs === 123 && job.delivery.attempt === 2, job)
  check('durable frame bytes remain unchanged', JSON.stringify(beforeFrames) === JSON.stringify([1, 2].map(frame => sha(join(frames, `frame_000${frame}.png`)))))

  // Pause only the child this fixture just created. Two tiny frames can finish
  // before a rate-limit observation; SIGSTOP gives cancellation a real, known
  // process to terminate without increasing the render or encoding workload.
  const marker = join(output, 'paused-encoder.json')
  const wrapper = join(output, 'paused-ffmpeg.mjs')
  writeFileSync(wrapper, `#!${process.execPath}\nimport { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nconst child=spawn(${JSON.stringify(ffmpeg)},process.argv.slice(2),{stdio:'inherit'})\nchild.on('exit',(code,signal)=>{process.exitCode=code??1})\nprocess.on('SIGTERM',()=>{child.kill('SIGCONT');child.kill('SIGTERM')})\nif(!child.kill('SIGSTOP'))throw Error('fixture could not pause its own encoder')\nwriteFileSync(${JSON.stringify(marker)},JSON.stringify({wrapperPid:process.pid,encoderPid:child.pid}))\n`, { mode: 0o755 })
  studio.config.ffmpegPath = wrapper
  const protectedFiles = [job.delivery.videoPath, job.delivery.manifestPath]
  const oldHashes = protectedFiles.map(sha)
  const exported = studio.exportProject(request).then(value => ({ value }), error => ({ error: { code: error.code, message: error.message } }))
  await waitFor('real encoder child identity', () => existsSync(marker))
  const identity = JSON.parse(readFileSync(marker))
  await sleep(100)
  check('cancellation reaches a live native encoder', checkProcessAlive(identity.encoderPid).alive && checkProcessAlive(identity.encoderPid).command?.includes(output), identity)
  const cancelled = await bounded(studio.cancelJob(request), 'native cancellation')
  const result = await exported
  json('cancellation.json', { identity, cancelled, result })
  check('cancel waits for the native process range to exit', cancelled.cancelled && cancelled.processGone
    && !checkProcessAlive(identity.wrapperPid).alive && !checkProcessAlive(identity.encoderPid).alive, cancelled)
  check('the interrupted re-export reports cancellation and preserves prior publication', result.error?.code === BlenderErrorCode.ABORTED
    && JSON.stringify(protectedFiles.map(sha)) === JSON.stringify(oldHashes), result)
  check('the completed job remains completed after cancelling its new delivery attempt', studio.renderJobs.read(request.projectId, request.jobId).status === 'completed')
} catch (cause) {
  failure = { code: cause?.code ?? null, message: cause?.message ?? String(cause), stack: cause?.stack ?? null }
  console.error(failure.message)
  process.exitCode = 1
} finally {
  if (studio && request && (studio._liveRenders.has(`${request.projectId}/${request.jobId}`) || studio._deliveriesInFlight.size)) {
    try { cleanup.push(await bounded(studio.cancelJob(request), 'cleanup cancellation')) } catch (error) { cleanup.push({ error: String(error) }) }
  }
  for (const handle of handles) {
    try { handle.terminate(); await bounded(handle.done, 'reap child'); cleanup.push({ exited: await handle.waitForExit(AbortSignal.timeout(15000)) }) }
    catch (error) { cleanup.push({ error: String(error) }) }
  }
  if (cleanup.some(item => item.error || item.exited === false || item.processGone === false)) process.exitCode = 1
  json('report.json', { checks, failure, calls, cleanup, finishedAt: new Date().toISOString() })
  console.log(`Complete-frame native delivery: ${checks.filter(check => check.ok).length}/${checks.length} check(s) passed`)
}
