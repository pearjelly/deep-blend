#!/usr/bin/env node
/**
 * Native Host → ffmpeg → ffprobe acceptance for already-complete frames.
 * Two generated PNGs are the durable input; Blender is deliberately unavailable.
 * Runs in the full acceptance entry and Linux CI editing job.
 * Retains the isolated store, source hashes, process identities, failures and cleanup.
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const processEvents = [], observationErrors = [], observedScopes = new Set()
let observedIdentity, observerTimer, pendingObservation
const note = (event, detail = {}) => {
  // Observation failures must not throw from an AbortSignal listener or a
  // discarded promise branch, or replace the result being observed.
  try {
    processEvents.push({ at: new Date().toISOString(), event, ...detail })
    json('process-events.json', processEvents)
  } catch (error) { observationErrors.push({ event, error: String(error) }) }
}
const readCommand = (file, args) => new Promise(resolveRead => {
  const finish = (error, stdout = '', stderr = '') => resolveRead({ stdout: String(stdout), stderr: String(stderr),
    ...(error ? { error: String(error), code: error.code ?? null, signal: error.signal ?? null } : {}) })
  try { execFile(file, args, { encoding: 'utf8', timeout: 1500, maxBuffer: 128 * 1024 }, finish) }
  catch (error) { finish(error) }
})
async function collectProcesses(label) {
  const pids = [observedIdentity.wrapperPid, observedIdentity.encoderPid].filter(Number.isSafeInteger)
  const detail = { label, pids }
  if (process.platform === 'linux') {
    detail.cgroups = pids.map(pid => {
      try { return { pid, value: readFileSync(`/proc/${pid}/cgroup`, 'utf8') } }
      catch (error) { return { pid, error: error.code } }
    })
    for (const row of detail.cgroups) for (const unit of (row.value || '').match(/dsh-[^/\n]+\.scope/g) || []) observedScopes.add(unit)
  }
  // Read the small /proc identities before yielding to ps, so the first
  // snapshot can keep the owned scope even if cancellation removes its PIDs.
  detail.ps = await readCommand('ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,stat=,command='])
  if (process.platform === 'linux') {
    detail.scopes = await Promise.all([...observedScopes].map(async unit => ({ unit,
      state: await readCommand('systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,ControlGroup']) })))
  }
  note('process-snapshot', detail)
}
function observeProcesses(label) {
  if (!observedIdentity) return Promise.resolve()
  if (pendingObservation) { note('process-snapshot-busy', { label }); return pendingObservation }
  pendingObservation = collectProcesses(label).catch(error => note('process-snapshot-error', { label, error: String(error) }))
    .finally(() => { pendingObservation = undefined })
  return pendingObservation
}

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
  const entry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-subprocess-local')
  const sdkDirectory = dirname(entry), packagePath = join(sdkDirectory, '../package.json')
  json('runtime-identity.json', { platform: process.platform, arch: process.arch, node: process.version,
    subprocessEntry: entry, subprocessSha256: sha(entry), packageVersion: JSON.parse(readFileSync(packagePath)).version,
    packageSha256: sha(packagePath), modules: Object.fromEntries(readdirSync(sdkDirectory).filter(name => name.endsWith('.js'))
      .map(name => [name, sha(join(sdkDirectory, name))])) })
  if (typeof subprocess.selectContainmentMode === 'function') {
    const selectMode = subprocess.selectContainmentMode.bind(subprocess)
    subprocess.selectContainmentMode = (...args) => { const mode = selectMode(...args); note('containment-mode', { args, mode }); return mode }
  }

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
    const ordinal = handles.length + 1
    note('spawn-returned', { ordinal, argv, signalAborted: spec.signal?.aborted })
    spec.signal?.addEventListener('abort', () => { note('signal-aborted', { ordinal, reason: String(spec.signal.reason) }); void observeProcesses('signal-aborted') }, { once: true })
    handle.done.then(value => note('handle-done', { ordinal, value }), error => note('handle-done-rejected', { ordinal, error: String(error) }))
    const waitForExit = handle.waitForExit.bind(handle)
    let waitCallId = 0
    handle.waitForExit = (...args) => {
      const callId = ++waitCallId
      note('wait-for-exit-started', { ordinal, callId, signalAborted: args[0]?.aborted })
      const waiting = waitForExit(...args)
      waiting.then(value => note('wait-for-exit-resolved', { ordinal, callId, value }), error => note('wait-for-exit-rejected', { ordinal, callId, error: String(error) }))
      return waiting
    }

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
  const wrapperLog = join(output, 'paused-encoder-events.jsonl')
  writeFileSync(wrapper, `#!${process.execPath}
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
const record=(event,detail={})=>{
  try { appendFileSync(${JSON.stringify(wrapperLog)},JSON.stringify({at:new Date().toISOString(),wrapperPid:process.pid,event,...detail})+'\\n') }
  catch(error) { try { process.stderr.write('fixture observation failed: '+String(error)+'\\n') } catch {} }
}
const child=spawn(${JSON.stringify(ffmpeg)},process.argv.slice(2),{stdio:'inherit'})
child.on('exit',(code,signal)=>{record('child-exit',{encoderPid:child.pid,code,signal});process.exitCode=code??1})
child.on('close',(code,signal)=>record('child-close',{encoderPid:child.pid,code,signal}))
process.on('SIGTERM',()=>{
  const events=[{event:'wrapper-sigterm',at:new Date().toISOString()}]
  const send=signal=>{
    const at=new Date().toISOString()
    try { const sent=child.kill(signal);events.push({event:'child-signal-result',at,encoderPid:child.pid,signal,sent});return sent }
    catch(error) { events.push({event:'child-signal-error',at,encoderPid:child.pid,signal,error:String(error)});throw error }
  }
  // Keep the original CONT -> TERM calls adjacent; flush observations afterwards.
  try { send('SIGCONT');send('SIGTERM') } finally { for(const item of events)record(item.event,item) }
})
process.on('exit',code=>record('wrapper-exit',{code}))
if(!child.kill('SIGSTOP'))throw Error('fixture could not pause its own encoder')
record('child-sigstop-sent',{encoderPid:child.pid,argv:process.argv.slice(2)})
writeFileSync(${JSON.stringify(marker)},JSON.stringify({wrapperPid:process.pid,encoderPid:child.pid}))
record('marker-written',{encoderPid:child.pid})
`, { mode: 0o755 })
  studio.config.ffmpegPath = wrapper
  const protectedFiles = [job.delivery.videoPath, job.delivery.manifestPath]
  const oldHashes = protectedFiles.map(sha)
  const exported = studio.exportProject(request).then(value => {
    note('export-resolved', { value }); return { value }
  }, error => {
    note('export-rejected', { code: error.code, message: error.message, detail: error.detail ?? null, cause: String(error.cause ?? '') })
    return { error: { code: error.code, message: error.message } }
  })
  await waitFor('real encoder child identity', () => existsSync(marker))
  const identity = JSON.parse(readFileSync(marker))
  observedIdentity = identity
  observeProcesses('before-cancellation')
  observerTimer = setInterval(() => observeProcesses('during-cancellation'), 2000)
  await sleep(100)
  check('cancellation reaches a live native encoder', checkProcessAlive(identity.encoderPid).alive && checkProcessAlive(identity.encoderPid).command?.includes(output), identity)
  note('cancel-requested')
  const cancellation = studio.cancelJob(request)
  const boundedCancellation = bounded(cancellation, 'native cancellation')
  note('cancel-call-returned')
  const cancelled = await boundedCancellation
  note('cancel-returned', { cancelled })
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
  observeProcesses('before-cleanup')
  if (studio && request && (studio._liveRenders.has(`${request.projectId}/${request.jobId}`) || studio._deliveriesInFlight.size)) {
    try { cleanup.push(await bounded(studio.cancelJob(request), 'cleanup cancellation')) } catch (error) { cleanup.push({ error: String(error) }) }
  }
  for (const handle of handles) {
    try { handle.terminate(); await bounded(handle.done, 'reap child'); cleanup.push({ exited: await handle.waitForExit(AbortSignal.timeout(15000)) }) }
    catch (error) { cleanup.push({ error: String(error) }) }
  }
  if (cleanup.some(item => item.error || item.exited === false || item.processGone === false)) process.exitCode = 1
  clearInterval(observerTimer)
  await pendingObservation
  await observeProcesses('after-cleanup')
  json('report.json', { checks, failure, calls, cleanup, observationErrors, finishedAt: new Date().toISOString() })
  console.log(`Complete-frame native delivery: ${checks.filter(check => check.ok).length}/${checks.length} check(s) passed`)
}
