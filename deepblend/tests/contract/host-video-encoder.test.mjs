#!/usr/bin/env node
/**
 * The delivery encoder: what it does when ffmpeg is missing, fails, writes nothing, or writes an
 * empty file — and what a missing `subprocess` service means.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `encodeFrameSequence` and `probeVideo` are the only two places a delivery can be WRONG about what it
 * produced, and their failure branches were dark (49 lines): the real suite encodes a real video, and
 * a real ffmpeg that works cannot produce "exit 0 but no file", "an empty file", "output that is not
 * JSON", or "no video stream". Those states are what a mistyped path, a codec that declined, a disk
 * that filled, or a container ffprobe does not understand actually look like — and round 30 recorded
 * the version of this that shipped: a delivery that failed to encode while its record still said
 * "encoding".
 *
 * The seam is `ctx.get('subprocess')`, so it is a stub here: the encoder's own logic is real, the
 * files it stats are real files in a temp directory, and every branch is one object away.
 *
 * TWO RULES THIS FILE PINS, both of which the code argues for at length in its own comments:
 *
 *   - ffprobe's `nb_read_frames` (a MEASUREMENT, from `-count_frames`) wins over `nb_frames` (the
 *     container's CLAIM). A probe that trusted the container would agree with a file that is short.
 *   - the argv is passed as an ARRAY with no shell, so nothing in a path can become a command. The
 *     check for that asserts the array the stub received, field by field.
 *
 * Run standalone: `node deepblend/tests/contract/host-video-encoder.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { encodeFrameSequence, probeVideo } from '@deepblend/dsh-blender-host'

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

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-encoder-'))
const framesDirectory = join(scratch, 'frames')
writeFileSync(join(scratch, 'placeholder'), '')
const { mkdirSync } = await import('node:fs')
mkdirSync(framesDirectory, { recursive: true })

/** One spawned tool call, as `runTool` sees it. */
function spawnResult({ exitCode = 0, stdout = '', stderr = '', signal = null, throwOnSpawn = null, rejectDone = null, unreadableReaders = false }) {
  return {
    throwOnSpawn,
    handle: {
      // A GETTER, not an eagerly built promise: in the spawn-throws case nothing ever awaits it, and
      // an eager `Promise.reject` nobody handles takes the process down AFTER the summary has printed —
      // a test that reports 17/17 and then exits non-zero.
      get done() {
        if (throwOnSpawn !== null) return Promise.reject(new Error(throwOnSpawn))
        // A handle whose process was KILLED rejects `done` instead of resolving it: the deadline
        // expired, or the caller cancelled. That is a different event from a spawn that refused.
        if (rejectDone !== null) return Promise.reject(new Error(rejectDone))
        return Promise.resolve({ exitCode, signal })
      },
      collected: {
        stdout: unreadableReaders
          ? { readFrom() { throw new Error('the reader is gone') } }
          : { readFrom: () => ({ text: stdout }) },
        stderr: unreadableReaders
          ? { readFrom() { throw new Error('the reader is gone') } }
          : { readFrom: () => ({ text: stderr }) },
      },
    },
  }
}

const spawned = []
/** A `subprocess` service whose every call the test dictates. */
function subprocessService(plan) {
  return {
    async resolveExecutable(configured) {
      if (plan.unresolvable === true) throw new Error(`no executable named "${configured}"`)
      if (plan.executable !== undefined) return plan.executable
      // The real resolver trusts an ABSOLUTE request and searches PATH for a bare name (the rule
      // `contract/blender-executable-resolution.test.mjs` pins for Blender); a stub that prefixed
      // everything gave this file "/usr/local/bin//opt/ffmpeg/bin/ffmpeg" and was wrong, not the code.
      return configured !== undefined && configured.startsWith('/') ? configured : `/usr/local/bin/${configured ?? 'ffmpeg'}`
    },
    spawn(request) {
      spawned.push(request)
      const next = typeof plan.next === 'function' ? plan.next(request) : plan.next
      if (next.throwOnSpawn !== null) throw new Error(next.throwOnSpawn)
      return next.handle
    },
  }
}

function contextWith(subprocess) {
  const ctx = new Context()
  if (subprocess !== null) ctx.provide('subprocess', subprocess)
  return ctx
}

const noSubprocess = contextWith(null)
const missingService = await encodeFrameSequence({
  ctx: noSubprocess,
  framesDirectory,
  fps: 30,
  firstFrame: 1,
  frameCount: 1,
  outputPath: join(scratch, 'never.mp4'),
}).catch(cause => cause)
check('with no `subprocess` service the encoder refuses with a stable code instead of throwing a TypeError',
  missingService instanceof BlenderError && missingService.code === code('RUNTIME_UNAVAILABLE') &&
  /needs the `subprocess` service, which is not composed in this process, so ffmpeg cannot be started\./.test(missingService.message),
  missingService?.message ?? missingService)
check('and so does the prober, naming itself',
  (await probeVideo({ ctx: noSubprocess, path: join(scratch, 'v.mp4') }).catch(cause => cause))
    ?.message?.includes('so ffprobe cannot be started.'))

const unresolvable = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ unresolvable: true })),
  framesDirectory, fps: 30, firstFrame: 1, frameCount: 1, outputPath: join(scratch, 'never.mp4'),
}).catch(cause => cause)
check('an ffmpeg that cannot be resolved is ENCODER_NOT_FOUND, and the advice names the install command',
  unresolvable instanceof BlenderError && unresolvable.code === code('ENCODER_NOT_FOUND') &&
  /brew install ffmpeg/.test(unresolvable.message) &&
  /or an absolute path in the DeepBlend configuration/.test(unresolvable.message),
  unresolvable?.message ?? unresolvable)

// ---------------------------------------------------------------------------
// Encoding: the three ways a "successful" ffmpeg is still not a delivery
// ---------------------------------------------------------------------------

const failedOutput = join(scratch, 'failed.mp4')
const failed = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 1, stderr: 'Error: Invalid argument\nlast line of the log' }) })),
  framesDirectory, fps: 30, firstFrame: 1, frameCount: 2, outputPath: failedOutput,
}).catch(cause => cause)
check('a non-zero exit with no file is ENCODE_FAILED, and the message carries the tail of ffmpeg\'s own log',
  failed instanceof BlenderError && failed.code === code('ENCODE_FAILED') &&
  /ffmpeg failed to encode 2 frame\(s\) from /.test(failed.message) &&
  failed.message.includes('Error: Invalid argument') &&
  failed.detail?.exitCode === 1,
  failed?.message ?? failed)

const silentFailure = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 3, stderr: '' }) })),
  framesDirectory, fps: 30, firstFrame: 1, frameCount: 2, outputPath: join(scratch, 'silent.mp4'),
}).catch(cause => cause)
check('an ffmpeg that says nothing still produces a message naming its exit code',
  silentFailure instanceof BlenderError && /exit 3$/.test(silentFailure.message),
  silentFailure?.message)

const noFileOutput = join(scratch, 'missing.mp4')
const noFile = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 0 }) })),
  framesDirectory, fps: 30, firstFrame: 1, frameCount: 2, outputPath: noFileOutput,
}).catch(cause => cause)
check('exit 0 with no file is refused by name, because "the process was happy" is not "the file exists"',
  noFile instanceof BlenderError && noFile.code === code('ENCODE_FAILED') &&
  noFile.message === `ffmpeg reported exit 0 but wrote no file at ${noFileOutput}.`,
  noFile?.message ?? noFile)

const emptyOutput = join(scratch, 'empty.mp4')
writeFileSync(emptyOutput, '')
const empty = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 0 }) })),
  framesDirectory, fps: 30, firstFrame: 1, frameCount: 2, outputPath: emptyOutput,
}).catch(cause => cause)
check('an empty file is refused rather than published as a video with no frames in it',
  empty instanceof BlenderError && empty.code === code('ENCODE_FAILED') &&
  empty.message === `ffmpeg wrote an empty file at ${emptyOutput}.`,
  empty?.message ?? empty)

const goodOutput = join(scratch, 'delivery.mp4')
const goodBytes = Buffer.from('not really an mp4, but it has bytes')
writeFileSync(goodOutput, goodBytes)
spawned.length = 0
const configuredFfmpeg = '/opt/ffmpeg/bin/ffmpeg'
const encoded = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 0, stderr: 'frame= 2 fps=0.0' }) })),
  ffmpegPath: configuredFfmpeg,
  framesDirectory, fps: 30, firstFrame: 7, frameCount: 2, outputPath: goodOutput, crf: 20, preset: 'fast',
})
check('a real encode reports the file, its size, the argv it used and the log ffmpeg produced',
  encoded.outputPath === goodOutput && encoded.bytes === goodBytes.length &&
  encoded.stderr === 'frame= 2 fps=0.0' && encoded.argv[0] === configuredFfmpeg &&
  typeof encoded.durationMs === 'number',
  { bytes: encoded.bytes, executable: encoded.argv[0] })
const inputAt = encoded.argv.indexOf('-i')
check('the argv is an ARRAY with no shell, and the frame pattern follows the job\'s own naming',
  Array.isArray(encoded.argv) && inputAt > 0 &&
  encoded.argv[inputAt + 1] === join(framesDirectory, 'frame_%04d.png') &&
  encoded.argv[encoded.argv.indexOf('-framerate') + 1] === '30' &&
  encoded.argv[encoded.argv.indexOf('-start_number') + 1] === '7' &&
  // `-framerate` and `-start_number` are INPUT options: they have to come before `-i`, or the
  // image2 demuxer never sees them and a delivery that does not begin at frame 1 encodes nothing.
  encoded.argv.indexOf('-framerate') < inputAt && encoded.argv.indexOf('-start_number') < inputAt &&
  // `-frames:v` is an OUTPUT option: before `-i` ffmpeg 8.0.1 refuses the whole command.
  encoded.argv.indexOf('-frames:v') > inputAt,
  { inputAt, framerate: encoded.argv.indexOf('-framerate'), framesV: encoded.argv.indexOf('-frames:v') })
check('and the process is spawned with a bounded stdout/stderr and a deadline, not with inherited pipes',
  spawned.length === 1 && spawned[0].cwd === framesDirectory &&
  spawned[0].stdio.stdout.maxBytes > 0 && spawned[0].stdio.stderr.spill.maxBytes > 0 &&
  typeof spawned[0].graceMs === 'number' && spawned[0].signal instanceof AbortSignal,
  { cwd: spawned[0]?.cwd, stdout: spawned[0]?.stdio?.stdout })

// ---- a spawn that throws ---------------------------------------------------
const spawnThrew = await encodeFrameSequence({
  ctx: contextWith(subprocessService({ next: spawnResult({ throwOnSpawn: 'EAGAIN: the process table is full' }) })),
  framesDirectory, fps: 30, firstFrame: 1, frameCount: 1, outputPath: join(scratch, 'never2.mp4'),
}).catch(cause => cause)
check('a spawn that throws propagates as-is, because it is not ffmpeg failing — it is this machine refusing',
  spawnThrew instanceof Error && !(spawnThrew instanceof BlenderError) &&
  spawnThrew.message === 'EAGAIN: the process table is full',
  spawnThrew?.message)

// ---------------------------------------------------------------------------
// Probing: the four ways ffprobe can fail to answer
// ---------------------------------------------------------------------------

const probed = await probeVideo({
  ctx: contextWith(subprocessService({
    next: spawnResult({
      exitCode: 0,
      stdout: JSON.stringify({
        streams: [{ codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', r_frame_rate: '30000/1001', nb_frames: '60', nb_read_frames: '58', duration: '2.0' }],
        format: { duration: '2.000000' },
      }),
    }),
  })),
  path: goodOutput,
})
check('a probe reports the MEASURED frame count, not the container\'s claim',
  probed.nbFrames === 58 && probed.nbReadFrames === 58 && probed.nbClaimedFrames === 60,
  { measured: probed.nbReadFrames, claimed: probed.nbClaimedFrames })
check('and it reports fps from the average rate when there is one, with the size and codec',
  probed.fps === 30 && probed.width === 1920 && probed.height === 1080 && probed.codec === 'h264' &&
  probed.durationSeconds === 2,
  { fps: probed.fps, width: probed.width, duration: probed.durationSeconds })

const probeFailed = await probeVideo({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 1, stderr: 'moov atom not found' }) })),
  path: goodOutput,
}).catch(cause => cause)
check('ffprobe failing to read the file is PROBE_FAILED, quoting what ffprobe said',
  probeFailed instanceof BlenderError && probeFailed.code === code('PROBE_FAILED') &&
  /ffprobe could not read /.test(probeFailed.message) && probeFailed.message.includes('moov atom not found'),
  probeFailed?.message)

const notJson = await probeVideo({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 0, stdout: 'ffprobe: command not found\n' }) })),
  path: goodOutput,
}).catch(cause => cause)
check('output that is not JSON is refused as a probe failure, keeping the first 2000 characters',
  notJson instanceof BlenderError && notJson.code === code('PROBE_FAILED') &&
  notJson.message === `ffprobe produced output that is not JSON for ${goodOutput}.` &&
  notJson.detail?.stdout === 'ffprobe: command not found\n',
  notJson?.detail ?? notJson?.message)

const noStream = await probeVideo({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 0, stdout: JSON.stringify({ format: { duration: '1.0' } }) }) })),
  path: goodOutput,
}).catch(cause => cause)
check('a container with no video stream is refused, and the raw answer is kept for a reader',
  noStream instanceof BlenderError && noStream.code === code('PROBE_FAILED') &&
  /ffprobe found no video stream in /.test(noStream.message) &&
  noStream.detail?.raw?.format?.duration === '1.0',
  noStream?.detail ?? noStream?.message)

// A process that was KILLED: `done` rejects, so there is no exit code at all, and the failure text
// has to come from the rejection — otherwise the refusal says "exit null" and tells the operator
// nothing about what happened.
const killed = await probeVideo({
  ctx: contextWith(subprocessService({ next: spawnResult({ rejectDone: 'the render was killed after the deadline' }) })),
  path: goodOutput,
}).catch(cause => cause)
check('a process that was killed rather than exiting puts the reason in the refusal, not "exit null"',
  killed instanceof BlenderError && killed.code === code('PROBE_FAILED') &&
  killed.message.includes('the render was killed after the deadline') &&
  !/exit null/.test(killed.message),
  killed?.message)

const unreadable = await probeVideo({
  ctx: contextWith(subprocessService({ next: spawnResult({ exitCode: 1, unreadableReaders: true }) })),
  path: goodOutput,
}).catch(cause => cause)
check('a collected-output reader that throws does not replace the refusal: the message falls back to the exit code',
  unreadable instanceof BlenderError && unreadable.code === code('PROBE_FAILED') &&
  /exit 1$/.test(unreadable.message),
  unreadable?.message)

// Cancellation must wait for both the command outcome and the provider's managed
// range. A leftover MP4 or successful ffprobe JSON cannot turn a cancelled run
// into a delivery. These handles are controlled independently, without processes.
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const validProbeOutput = JSON.stringify({ streams: [{ codec_name: 'h264', width: 320, height: 180,
  avg_frame_rate: '30/1', nb_read_frames: '2' }], format: { duration: '0.066667' } })
const invokeTool = (kind, ctx, options = {}) => kind === 'encode'
  ? encodeFrameSequence({ ctx, framesDirectory, firstFrame: 1, frameCount: 2, fps: 30, outputPath: goodOutput, ...options })
  : probeVideo({ ctx, path: goodOutput, ...options })

for (const kind of ['encode', 'probe']) {
  const preAborted = new AbortController()
  preAborted.abort(new Error('already cancelled'))
  let resolutions = 0, preSpawns = 0
  const pre = await invokeTool(kind, contextWith({
    async resolveExecutable() { resolutions++; return '/controlled/tool' },
    spawn() { preSpawns++; return spawnResult({ stdout: validProbeOutput }).handle },
  }), { signal: preAborted.signal }).catch(cause => cause)
  check(`${kind}: pre-cancelled work neither resolves nor spawns an executable`,
    pre?.code === code('ABORTED') && resolutions === 0 && preSpawns === 0,
    { code: pre?.code, resolutions, spawns: preSpawns })

  const resolving = deferred(), resolved = deferred(), lookupController = new AbortController()
  let lookupSignal, lookupSpawns = 0
  const lookup = invokeTool(kind, contextWith({
    async resolveExecutable(configured, env, signal) { lookupSignal = signal; resolving.resolve(); return resolved.promise },
    spawn() { lookupSpawns++; return spawnResult({ stdout: validProbeOutput }).handle },
  }), { signal: lookupController.signal }).catch(cause => cause)
  await resolving.promise
  lookupController.abort(new Error('cancel during lookup'))
  resolved.resolve('/controlled/tool')
  const lookupResult = await lookup
  check(`${kind}: cancellation during executable lookup reaches the resolver and prevents spawn`,
    lookupSignal === lookupController.signal && lookupResult?.code === code('ABORTED') && lookupSpawns === 0,
    { code: lookupResult?.code, spawns: lookupSpawns })

  const rejectingController = new AbortController()
  const lookupRejected = await invokeTool(kind, contextWith({
    async resolveExecutable() { rejectingController.abort(); throw new Error('lookup aborted') },
  }), { signal: rejectingController.signal }).catch(cause => cause)
  check(`${kind}: an aborted lookup is cancellation, not a missing executable`, lookupRejected?.code === code('ABORTED'))

  const started = deferred(), direct = deferred(), range = deferred(), controller = new AbortController()
  let specification, rangeSignal, settled = false, waits = 0
  const running = invokeTool(kind, contextWith(subprocessService({ next(request) {
    specification = request; started.resolve()
    return { throwOnSpawn: null, handle: {
      done: direct.promise,
      waitForExit(signal) { waits++; rangeSignal = signal; return range.promise },
      collected: { stdout: { readFrom: () => ({ text: validProbeOutput }) } },
    } }
  } })), { signal: controller.signal, timeoutMs: 1000 }).then(value => { settled = true; return value }, cause => { settled = true; return cause })
  await started.promise
  controller.abort(new Error('cancel active delivery'))
  await nextTurn()
  check(`${kind}: external cancellation reaches the running process without returning before exit`, specification.signal.aborted && !settled)
  if (kind === 'encode') direct.resolve({ exitCode: 0, signal: null })
  else direct.reject(new Error('provider stopped during cancellation'))
  await nextTurn()
  check(`${kind}: direct process exit alone does not finish cancellation`, waits === 1 && !settled)
  check(`${kind}: range reaping does not reuse the cancelled signal`, waits === 1 && rangeSignal?.aborted !== true)
  range.resolve(true)
  const cancelled = await running
  check(`${kind}: cancelled work refuses existing output after the managed range exits`,
    cancelled?.code === code('ABORTED') && cancelled.detail?.processGone === true)

  const deadlineHit = deferred(), timeoutRange = deferred()
  let timeoutSettled = false
  const timed = invokeTool(kind, contextWith(subprocessService({ next(request) {
    request.signal.addEventListener('abort', () => deadlineHit.resolve(), { once: true })
    return { throwOnSpawn: null, handle: {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      waitForExit: () => timeoutRange.promise,
      collected: { stdout: { readFrom: () => ({ text: validProbeOutput }) } },
    } }
  } })), { timeoutMs: 10 }).then(value => { timeoutSettled = true; return value }, cause => { timeoutSettled = true; return cause })
  // Bound the negative control too: the old implementation disarms its timer as
  // soon as `done` resolves, so no abort event will arrive from it.
  let fallback
  const hit = await Promise.race([deadlineHit.promise.then(() => true), new Promise(resolve => { fallback = setTimeout(() => resolve(false), 100) })])
  clearTimeout(fallback)
  check(`${kind}: the deadline remains armed until managed work exits`, hit && !timeoutSettled)
  timeoutRange.resolve(true)
  const timeoutResult = await timed
  check(`${kind}: a timed-out tool refuses existing output with a stable deadline code`, timeoutResult?.code === code('TIMEOUT'))

  for (const rejected of [false, true]) {
    const unconfirmed = await invokeTool(kind, contextWith(subprocessService({ next: {
      throwOnSpawn: null,
      handle: { done: Promise.resolve({ exitCode: 0, signal: null }),
        waitForExit: () => rejected ? Promise.reject(new Error('process range cannot be observed')) : Promise.resolve(false),
        collected: { stdout: { readFrom: () => ({ text: validProbeOutput }) } },
      },
    } }))).catch(cause => cause)
    check(`${kind}: ${rejected ? 'failed' : 'incomplete'} range observation cannot become successful output`,
      unconfirmed?.code === code(kind === 'encode' ? 'ENCODE_FAILED' : 'PROBE_FAILED') && unconfirmed.detail?.processGone === false)
  }

  let finishedSignal
  await invokeTool(kind, contextWith(subprocessService({ next(request) {
    finishedSignal = request.signal
    return { throwOnSpawn: null, handle: { ...spawnResult({ stdout: validProbeOutput }).handle,
      waitForExit: async () => true } }
  } })), { timeoutMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 20))
  check(`${kind}: a finished process has no later deadline firing`, !finishedSignal.aborted)
}

// An earlier successful attempt may have left bytes at this same encoded path.
// Exit failure is still failure; these cases must not be treated as fresh output.
for (const [label, result] of [
  ['nonzero exit', { exitCode: 1, stderr: 'encoder failed before opening output' }],
  ['unknown exit', { exitCode: null, signal: 'SIGTERM' }],
  ['rejected outcome', { rejectDone: new Error('provider could not report the command outcome') }],
]) {
  const rejected = await invokeTool('encode', contextWith(subprocessService({ next: spawnResult(result) })))
    .catch(cause => cause)
  check(`an earlier output cannot turn ${label} into a successful encode`,
    rejected?.code === code('ENCODE_FAILED') && readFileSync(goodOutput).equals(goodBytes),
    { code: rejected?.code ?? null, message: rejected?.message ?? null })
}

rmSync(scratch, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nVideo encoder: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
