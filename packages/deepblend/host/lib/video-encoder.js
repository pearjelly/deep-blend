/**
 * Video encoder — frame sequence in, verified MP4 out (SPEC §10.4).
 *
 * WHY ffmpeg AND NOT BLENDER'S OWN FFMPEG OUTPUT
 * ----------------------------------------------
 * SPEC §10.4 is explicit and the reason is the whole of M3: "不建议直接让 Blender
 * 一次输出不可恢复的视频文件作为唯一产物". A video written directly by the render
 * process cannot be resumed, cannot be inspected frame by frame, and cannot be
 * re-encoded without re-rendering. The frame sequence is the durable artifact;
 * the MP4 is derived from it, and deriving it is idempotent — re-running the
 * encoder on the same frames produces the same video without touching Blender.
 *
 * WHY THE ENCODE IS VERIFIED RATHER THAN TRUSTED
 * ----------------------------------------------
 * "最终视频属性正确" is an acceptance condition, so the claim and the measurement
 * are kept apart on purpose: ffmpeg is told what to produce, `ffprobe` reports
 * what the file IS, and `verifyVideoProperties` (contracts) is the only place the
 * two meet. An encoder that returned its own argv as proof would pass for a file
 * with the wrong duration.
 *
 * WHY `-count_frames`
 * -------------------
 * An MP4 header usually has no `nb_frames` for a stream, and a container that
 * says "30 frames" while holding 29 is exactly the failure this milestone is
 * meant to catch. `-count_frames` decodes and counts, so the number in the
 * manifest is a measurement.
 *
 * Owner: DeepBlend Studio — M3
 * Plane: Host composition
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, frameFileName } from '@deepblend/dsh-blender-contracts'

/** Grace given to a stuck ffmpeg before it is killed. */
const TERMINATE_GRACE_MS = 10_000

/** Seconds allowed for one encode or probe subprocess. */
const ENCODE_TIMEOUT_MS = 3_600_000
const PROBE_TIMEOUT_MS = 300_000

/** Cap on captured ffmpeg/ffprobe output before spilling. */
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_SPILL_BYTES = 32 * 1024 * 1024

/**
 * Encode a complete frame sequence into an H.264 MP4.
 *
 * The input pattern is `<framesDirectory>/frame_%04d.png` with `-start_number`
 * set to the first frame the job rendered. Frames are named by ABSOLUTE frame
 * number (frame_0030.png is project frame 30), so `-start_number` is what maps
 * the pattern onto the sequence; without it every delivery that does not begin at
 * frame 1 would encode nothing.
 *
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {string} input.ffmpegPath
 * @param {string} input.framesDirectory
 * @param {number} input.firstFrame
 * @param {number} input.frameCount
 * @param {number} input.fps
 * @param {string} input.outputPath
 * @param {string} [input.filePrefix]
 * @param {number} [input.filePadding]
 * @param {string} [input.crf]
 * @returns {Promise<{outputPath: string, bytes: number, argv: string[], durationMs: number, stderr: string}>}
 */
export async function encodeFrameSequence(input) {
  const executable = await resolveTool(input.ctx, input.ffmpegPath, 'ffmpeg', BlenderErrorCode.ENCODER_NOT_FOUND)
  const prefix = input.filePrefix ?? 'frame_'
  const padding = input.filePadding ?? 4
  // ffmpeg's pattern syntax is `%0Nd`; it is derived from the job's own naming so
  // a job that renders with different padding still encodes correctly.
  const pattern = join(input.framesDirectory, `${prefix}%0${padding}d.png`)

  const argv = [
    executable,
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    // `-framerate` and `-start_number` are INPUT options for the image2 demuxer, so
    // they belong before `-i`. Frames are named by ABSOLUTE frame number
    // (frame_0030.png is project frame 30), which is what `-start_number` maps onto
    // the pattern; without it a delivery that does not begin at frame 1 encodes
    // nothing.
    '-framerate', String(input.fps),
    '-start_number', String(input.firstFrame),
    '-i', pattern,
    '-an',
    '-c:v', 'libx264',
    '-preset', input.preset ?? 'medium',
    '-crf', String(input.crf ?? 18),
    // yuv420p is the chroma format every player and every browser accepts;
    // yuv444p produces a file that looks right in ffprobe and plays black in
    // QuickTime.
    '-pix_fmt', 'yuv420p',
    // `-frames:v` is an OUTPUT option and must follow `-i`. Measured the hard way:
    // placed before the input, ffmpeg 8.0.1 refuses the whole command with
    // "Option frames:v ... cannot be applied to input url ... Move this option
    // before the file it belongs to", and the delivery fails with ENCODE_FAILED.
    // It bounds the encode by the exact frame count rather than by "whatever
    // matches", so a stray frame from another attempt in the same directory cannot
    // be appended and make the video longer than the manifest claims.
    '-frames:v', String(input.frameCount),
    '-movflags', '+faststart',
    input.outputPath,
  ]

  const startedAt = Date.now()
  const run = await runTool(input.ctx, {
    argv,
    cwd: input.framesDirectory,
    timeoutMs: input.timeoutMs ?? ENCODE_TIMEOUT_MS,
  })
  const durationMs = Date.now() - startedAt

  if (run.exitCode !== 0 && !existsSync(input.outputPath)) {
    throw new BlenderError(
      BlenderErrorCode.ENCODE_FAILED,
      `ffmpeg failed to encode ${input.frameCount} frame(s) from ${pattern}: ${run.stderr.slice(-2000) || `exit ${run.exitCode}`}`,
      { detail: { exitCode: run.exitCode, argv, stderr: run.stderr.slice(-4000) } },
    )
  }
  if (!existsSync(input.outputPath)) {
    throw new BlenderError(
      BlenderErrorCode.ENCODE_FAILED,
      `ffmpeg reported exit ${run.exitCode} but wrote no file at ${input.outputPath}.`,
      { detail: { argv, stderr: run.stderr.slice(-4000) } },
    )
  }
  const bytes = statSync(input.outputPath).size
  if (bytes === 0) {
    throw new BlenderError(
      BlenderErrorCode.ENCODE_FAILED,
      `ffmpeg wrote an empty file at ${input.outputPath}.`,
      { detail: { argv } },
    )
  }
  return { outputPath: input.outputPath, bytes, argv, durationMs, stderr: run.stderr }
}

/**
 * Read a video's real properties with ffprobe.
 *
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {string} input.ffprobePath
 * @param {string} input.path
 * @returns {Promise<{durationSeconds: number|null, fps: number|null, width: number|null,
 *   height: number|null, nbFrames: number|null, codec: string|null, raw: object}>}
 */
export async function probeVideo(input) {
  const executable = await resolveTool(input.ctx, input.ffprobePath, 'ffprobe', BlenderErrorCode.PROBE_FAILED)
  const argv = [
    executable,
    '-hide_banner',
    '-loglevel', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,codec_name,nb_frames,nb_read_frames,duration',
    '-show_entries', 'format=duration',
    '-print_format', 'json',
    input.path,
  ]
  const run = await runTool(input.ctx, {
    argv,
    cwd: input.cwd ?? undefined,
    timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
  })
  if (run.exitCode !== 0) {
    throw new BlenderError(
      BlenderErrorCode.PROBE_FAILED,
      `ffprobe could not read ${input.path}: ${run.stderr.slice(-2000) || `exit ${run.exitCode}`}`,
      { detail: { argv, stderr: run.stderr.slice(-4000) } },
    )
  }

  let parsed
  try {
    parsed = JSON.parse(run.stdout)
  } catch (cause) {
    throw new BlenderError(
      BlenderErrorCode.PROBE_FAILED,
      `ffprobe produced output that is not JSON for ${input.path}.`,
      { cause, detail: { stdout: run.stdout.slice(0, 2000) } },
    )
  }

  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : undefined
  if (stream === undefined) {
    throw new BlenderError(
      BlenderErrorCode.PROBE_FAILED,
      `ffprobe found no video stream in ${input.path}.`,
      { detail: { raw: parsed } },
    )
  }

  // `nb_read_frames` is present because of `-count_frames` and is the measurement;
  // `nb_frames` is the container's own claim and is often absent. The measurement
  // wins when both exist — the whole point is not to take the container's word.
  const readFrames = integerOrNull(stream.nb_read_frames)
  const claimedFrames = integerOrNull(stream.nb_frames)
  const codec = typeof stream.codec_name === 'string' ? stream.codec_name : null

  return {
    durationSeconds: numberOrNull(parsed.format?.duration) ?? numberOrNull(stream.duration),
    fps: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate),
    width: integerOrNull(stream.width),
    height: integerOrNull(stream.height),
    nbFrames: readFrames ?? claimedFrames,
    nbReadFrames: readFrames,
    nbClaimedFrames: claimedFrames,
    codec,
    path: input.path,
    raw: { stream, format: parsed.format ?? null },
  }
}

/**
 * Resolve an external tool, preferring an absolute configured path.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} configured
 * @param {string} label
 * @param {string} code
 * @returns {Promise<string>}
 */
async function resolveTool(ctx, configured, label, code) {
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    throw new BlenderError(
      BlenderErrorCode.RUNTIME_UNAVAILABLE,
      `Encoding a delivery needs the \`subprocess\` service, which is not composed in this process, ` +
        `so ${label} cannot be started.`,
    )
  }
  try {
    return await subprocess.resolveExecutable(configured, { PATH: process.env.PATH ?? '' })
  } catch (cause) {
    throw new BlenderError(
      code,
      `${label} could not be resolved from "${configured}". A delivery render needs it on PATH ` +
        `(macOS: \`brew install ffmpeg\`) or an absolute path in the DeepBlend configuration.`,
      { cause },
    )
  }
}

/**
 * Run one subprocess to completion through `ctx.subprocess` (SPEC §9.2).
 *
 * The argv array is passed verbatim: no shell is involved, so nothing in a path
 * can become a command.
 */
async function runTool(ctx, spec) {
  const subprocess = ctx.get('subprocess')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? ENCODE_TIMEOUT_MS)
  let handle
  try {
    handle = subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
        stderr: { maxBytes: MAX_OUTPUT_BYTES, spill: { maxBytes: MAX_SPILL_BYTES } },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal: controller.signal,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
      },
    })
  } catch (cause) {
    // A spawn that throws must not leave its deadline armed: the timer would keep
    // the event loop alive for the full timeout after the caller has already seen
    // the failure.
    clearTimeout(timer)
    throw cause
  }

  let outcome = null
  let failure = null
  try {
    outcome = await handle.done
  } catch (cause) {
    failure = cause
  } finally {
    // Disarmed only once the process has actually exited. Clearing it right after
    // `spawn` returned would cancel the deadline before the work started, so a
    // hung ffmpeg would wait forever instead of being killed.
    clearTimeout(timer)
  }
  const read = (reader) => {
    if (reader === undefined || reader === null) return ''
    try {
      return reader.readFrom(0).text ?? ''
    } catch {
      return ''
    }
  }
  return {
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    stdout: read(handle.collected?.stdout),
    stderr: read(handle.collected?.stderr) || (failure !== null ? String(failure) : ''),
  }
}

function numberOrNull(value) {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

function integerOrNull(value) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null
}

/** `"30/1"` -> 30, `"30000/1001"` -> 29.970029… */
function parseRational(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const parts = value.split('/')
  const numerator = Number.parseFloat(parts[0])
  const denominator = parts.length > 1 ? Number.parseFloat(parts[1]) : 1
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  return numerator / denominator
}

/**
 * Where a job's encoded video is written before it is published.
 * @param {string} jobDirectory
 * @param {string} jobId
 */
export function encodedPath(jobDirectory, jobId) {
  return join(jobDirectory, 'encoded', `${jobId}.mp4`)
}

/** The expected frame file for one frame of a job. */
export { frameFileName }
