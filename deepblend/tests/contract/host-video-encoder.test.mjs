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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
