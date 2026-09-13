/**
 * Render-job vocabulary — the durable, restart-survivable half of SPEC §10.
 *
 * WHY THIS IS A SEPARATE DOCUMENT TYPE FROM `deepblend.job/v1`
 * -----------------------------------------------------------
 * M1 already writes one `deepblend.job/v1` record per Blender action beneath
 * `<project>/jobs/`. That record is an ATTEMPT LOG: written once when the action
 * starts, once when it ends, and nothing in between, because every M1/M2 action
 * finishes inside the tool call that started it. Its schema mirrors to
 * `deepblend/schemas/job-result.schema.json` and 49 of them are already on disk in
 * the demo project.
 *
 * SPEC §10.2 describes a different object: a record with `attempt`, `pid`,
 * `completedFrames[]`, `jobDirectory`, `outputManifest` and the statuses
 * `queued | running | stopping | recovering | completed | failed | cancelled`.
 * Folding the two together would mean rewriting a mirrored schema, invalidating
 * the records already on disk, and asking one document to mean two things. So the
 * durable render job is its own type, in its own place:
 *
 *     <project>/jobs/<jobId>.json          attempt log     (unchanged, M1)
 *     <project>/renders/<jobId>/job.json   render job      (new, M3)
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ------------------------------------------
 * **The frames on disk are the authority for "what is done"; `completedFrames[]`
 * is a cache of that authority and may never overrule it.**
 *
 * That is not a stylistic preference — it is what the M3 restart probe measured.
 * After a `kill -9` of the process that started a render:
 *
 *   - the Blender child SURVIVED (detached process group), still writing into the
 *     very directory a recovery is about to describe;
 *   - `events.jsonl` was intact up to the last fsynced line, which is a fact about
 *     the journal and not about the frames;
 *   - a process killed mid-write leaves a file that EXISTS and is not a frame.
 *
 * So this module computes the ledger from the frames, and the host derives the
 * render set as `missing + corrupt`. The probe's own ledger implementation was
 * written first and this module reproduces it; `render-job.test.mjs` pins the
 * parts that must agree with `deepblend_frames.py` byte for byte.
 *
 * Owner: DeepBlend Studio — M3
 */

/** Document type of the durable render job record. */
export const RENDER_JOB_VERSION = 'deepblend.render-job/v1'
/** Document type of a provider invocation's frame plan. */
export const FRAME_PLAN_VERSION = 'deepblend.frame-plan/v1'
/** Document type written by the Blender child to claim its own pid. */
export const PROCESS_IDENTITY_VERSION = 'deepblend.process/v1'
/** Document type of the delivery manifest (SPEC §10.4, §20 M3). */
export const DELIVERY_MANIFEST_VERSION = 'deepblend.delivery-manifest/v1'

/**
 * Statuses a render job may hold (SPEC §10.2).
 *
 * `recovering` is the only one that exists purely for restart: a job that was
 * `running` when the process died is not yet failed — the frames it finished are
 * real, and the honest state is "being recovered", which a reader can act on.
 */
export const RENDER_JOB_STATUSES = Object.freeze([
  'queued',
  'running',
  'stopping',
  'recovering',
  'completed',
  'failed',
  'cancelled',
])

/**
 * Statuses in which nothing happens to a job on its own.
 *
 * This is the reconciler's filter, not a claim that the job can never move again:
 * a `failed` or `cancelled` job is deliberately re-openable by an explicit resume
 * (see {@link canTransitionRenderJob}). Read it as "no automatic work".
 */
export const RENDER_JOB_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled'])

/** What a render job produces. SPEC §10.2 fixes this vocabulary. */
export const RENDER_JOB_TYPES = Object.freeze(['preview', 'final-render', 'export'])

/**
 * Legal transitions. Anything else is a bug in the caller, not a race to paper over.
 *
 * TWO DIFFERENT IDEAS THAT LOOK LIKE ONE
 * --------------------------------------
 * `isTerminalRenderJobStatus` answers "does anything happen to this job on its
 * own?" — it is what the reconciler scans by, and `completed`, `failed` and
 * `cancelled` all answer no.
 *
 * This table answers "may a caller move it?", and there the three differ. A
 * `completed` job is finished: its frames are rendered, its video is encoded and
 * verified, its package is published, and re-delivering it is `exportProject`,
 * which leaves the status alone. A `failed` or `cancelled` job is a job with
 * frames on disk and work left, and refusing to re-open it would mean a Blender
 * crash or a change of mind in hour three forces the whole 3.4-hour render to
 * start over — which is precisely what `attempt` exists to count.
 */
const TRANSITIONS = Object.freeze({
  // `recovering` is reachable from `queued` because a Host can be killed in the
  // window between writing the record and spawning the renderer, which leaves a
  // job that never rendered a single frame and that the reconciler must still be
  // able to describe. Omitting it made the reconciler throw on exactly the crash
  // it exists for.
  queued: Object.freeze(['running', 'stopping', 'recovering', 'failed', 'cancelled']),
  running: Object.freeze(['stopping', 'recovering', 'completed', 'failed', 'cancelled']),
  // `recovering` from `stopping`: a Host killed while cancelling leaves a job that
  // owes frames and carries a cancellation nobody is left to complete.
  stopping: Object.freeze(['cancelled', 'failed', 'completed', 'recovering']),
  recovering: Object.freeze(['running', 'completed', 'failed', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze(['recovering', 'running', 'cancelled']),
  cancelled: Object.freeze(['recovering', 'running']),
})

/** @param {string} status */
export function isTerminalRenderJobStatus(status) {
  return RENDER_JOB_TERMINAL_STATUSES.includes(status)
}

/**
 * Is `to` reachable from `from`?
 * @param {string} from
 * @param {string} to
 */
export function canTransitionRenderJob(from, to) {
  if (!RENDER_JOB_STATUSES.includes(from) || !RENDER_JOB_STATUSES.includes(to)) return false
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

/**
 * Assert a transition, so an illegal one is a named failure rather than a record
 * that quietly ends up in a state no reader can act on.
 * @param {string} from
 * @param {string} to
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkTransition(from, to) {
  if (canTransitionRenderJob(from, to)) return { ok: true, reason: null }
  return {
    ok: false,
    reason: `a render job cannot move from "${from}" to "${to}"`,
  }
}

/* -------------------------------------------------------------------------- */
/* Frame naming — the half that must agree with deepblend_frames.py            */
/* -------------------------------------------------------------------------- */

/** Default prefix and zero padding, matching the Python renderer. */
export const FRAME_FILE_PREFIX = 'frame_'
export const FRAME_FILE_PADDING = 4

/**
 * The file name one frame is written to.
 *
 * MEASURED, and the reason this is a shared function rather than a format string
 * at each call site: `scene.render.frame_path(frame=f)` PREDICTS
 * `<dir>/frame_0001.png` while `bpy.ops.render.render(write_still=True)` writes
 * `<dir>/frame_.png`. The Python renderer therefore sets the exact path itself,
 * and this side must produce the same string or every frame reads as missing.
 *
 * @param {number} frame
 * @param {string} [prefix]
 * @param {number} [padding]
 * @returns {string}
 */
export function frameFileName(frame, prefix = FRAME_FILE_PREFIX, padding = FRAME_FILE_PADDING) {
  return `${prefix}${String(frame).padStart(padding, '0')}.png`
}

/**
 * The frames of an inclusive range.
 *
 * A range is validated rather than trusted: an inverted range is a caller bug
 * that would otherwise render nothing and report success, which is exactly the
 * failure mode SPEC §11.1 forbids.
 *
 * @param {number} frameStart
 * @param {number} frameEnd
 * @returns {{frames: number[], error: string|null}}
 */
export function frameNumbers(frameStart, frameEnd) {
  if (!Number.isSafeInteger(frameStart) || !Number.isSafeInteger(frameEnd)) {
    return { frames: [], error: 'frame bounds must be integers' }
  }
  if (frameEnd < frameStart) {
    return {
      frames: [],
      error: `the frame range ${frameStart}..${frameEnd} is inverted, so it contains no frames`,
    }
  }
  const frames = []
  for (let frame = frameStart; frame <= frameEnd; frame += 1) frames.push(frame)
  return { frames, error: null }
}

/* -------------------------------------------------------------------------- */
/* The frame ledger                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A PNG is only a frame if it carries at least its signature and one chunk.
 * Mirrors `MIN_FRAME_BYTES` in `deepblend_frames.py`.
 */
export const MIN_FRAME_BYTES = 512

/**
 * Decide whether one candidate frame IS a frame, from a sample of its bytes.
 *
 * WHY A SAMPLE AND NOT THE WHOLE FILE
 * -----------------------------------
 * The ledger is rebuilt from disk on every recovery AND on every progress tick,
 * and a 450-frame delivery is ~424 MiB of PNG. Reading all of it to answer "which
 * frames are done" would cost more than the render it is describing. The four
 * facts that decide the question all live at the ends of the file — the PNG
 * signature and the IHDR dimensions in the first 33 bytes, the size, and the IEND
 * trailer — so a stat plus two small reads answers it, and the file's own bytes
 * still answer it rather than a cached list.
 *
 * `inspectFrameBytes` is the same rule applied to a buffer already in memory, and
 * exists so a test can pin the two against each other.
 *
 * @param {{size: number, header?: Uint8Array, tail?: Uint8Array}} sample
 * @param {{width?: number, height?: number}} [expected]
 * @returns {{ok: boolean, reason: string|null, width?: number, height?: number, bytes: number}}
 */
export function inspectFrameSample(sample, expected = {}) {
  const size = sample?.size ?? 0
  if (size < MIN_FRAME_BYTES) {
    return { ok: false, reason: size === 0 ? 'empty' : 'truncated', bytes: size }
  }
  const header = sample.header
  if (header === undefined || header.length < 24) {
    return { ok: false, reason: 'unreadable', bytes: size }
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let index = 0; index < signature.length; index += 1) {
    if (header[index] !== signature[index]) return { ok: false, reason: 'not-a-png', bytes: size }
  }
  const width = ((header[16] << 24) | (header[17] << 16) | (header[18] << 8) | header[19]) >>> 0
  const height = ((header[20] << 24) | (header[21] << 16) | (header[22] << 8) | header[23]) >>> 0
  if (width <= 0 || height <= 0) return { ok: false, reason: 'bad-dimensions', bytes: size }
  if (expected.width !== undefined && expected.height !== undefined &&
      (width !== expected.width || height !== expected.height)) {
    return {
      ok: false,
      reason: `wrong-dimensions ${width}x${height}, expected ${expected.width}x${expected.height}`,
      width, height, bytes: size,
    }
  }
  const tail = sample.tail
  // A killed process leaves a file with no IEND chunk. This is the cheap
  // structural end-of-file check; full decoding would cost more than the render.
  if (tail === undefined || tail.length < 8 ||
      tail[tail.length - 8] !== 0x49 || tail[tail.length - 7] !== 0x45 ||
      tail[tail.length - 6] !== 0x4e || tail[tail.length - 5] !== 0x44) {
    return { ok: false, reason: 'unterminated', width, height, bytes: size }
  }
  return { ok: true, reason: null, width, height, bytes: size }
}

/**
 * The same rule applied to a complete in-memory PNG.
 * @param {Uint8Array} bytes
 * @param {{width?: number, height?: number}} [expected]
 */
export function inspectFrameBytes(bytes, expected = {}) {
  const size = bytes?.length ?? 0
  return inspectFrameSample({
    size,
    header: size >= 24 ? bytes.subarray(0, 33) : undefined,
    tail: size >= 12 ? bytes.subarray(size - 12) : undefined,
  }, expected)
}

/**
 * Turn per-frame observations into the ledger the host acts on.
 *
 * `toRender` is the point of the whole module: it is the exact set the renderer
 * is handed, and it is `missing + corrupt` — a torn frame is re-rendered, not
 * accepted, and not double-counted.
 *
 * @param {object} input
 * @param {number[]} input.expected - every frame the job is responsible for.
 * @param {Map<number, {ok: boolean, reason?: string|null, bytes?: number}>} input.observed
 * @returns {{present: object[], corrupt: object[], missing: number[], toRender: number[]}}
 */
export function resolveFrameLedger(input) {
  const present = []
  const corrupt = []
  const missing = []
  for (const frame of input.expected) {
    const observation = input.observed.get(frame)
    if (observation === undefined) {
      missing.push(frame)
      continue
    }
    if (observation.ok === true) {
      present.push({ frame, bytes: observation.bytes ?? 0 })
      continue
    }
    corrupt.push({ frame, reason: observation.reason ?? 'unknown', bytes: observation.bytes ?? 0 })
  }
  return {
    present,
    corrupt,
    missing,
    toRender: [...missing, ...corrupt.map(entry => entry.frame)],
  }
}

/**
 * Progress as an integer percentage, for the DSH job projection and the UI.
 *
 * Counted in FRAMES, not in frames-times-bytes: a delivered frame is worth one
 * frame regardless of how well it compresses, and a progress bar that moves at a
 * different rate from the work is worse than none.
 *
 * @param {{expected: number, done: number}} input
 * @returns {number}
 */
export function renderProgressPercent(input) {
  if (!Number.isFinite(input.expected) || input.expected <= 0) return 0
  const ratio = Math.max(0, Math.min(1, input.done / input.expected))
  return Math.round(ratio * 100)
}

/**
 * The number of milliseconds a completed run implies per frame, and the estimate
 * remaining for the rest. Used for the model-readable status line only — nothing
 * schedules against it.
 *
 * @param {{perFrameMs: number[], remainingFrames: number}} input
 * @returns {{meanMsPerFrame: number|null, estimatedRemainingMs: number|null}}
 */
export function estimateRemaining(input) {
  const samples = input.perFrameMs.filter(value => Number.isFinite(value) && value > 0)
  if (samples.length === 0) return { meanMsPerFrame: null, estimatedRemainingMs: null }
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length
  return { meanMsPerFrame: mean, estimatedRemainingMs: Math.round(mean * input.remainingFrames) }
}

/* -------------------------------------------------------------------------- */
/* Delivery manifest and the video-property check (SPEC §10.4, §20 M3)          */
/* -------------------------------------------------------------------------- */

/**
 * Verify a probed video against the delivery manifest's own claims.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT AN ASSERTION INSIDE THE ENCODER
 * ------------------------------------------------------------------
 * "最终视频属性正确" is an acceptance condition, and the thing that makes it
 * checkable is that the CLAIM and the MEASUREMENT are separate inputs. The
 * encoder writes what it intended; `ffprobe` reports what the file is; this
 * function is the only place the two meet, and it returns every disagreement
 * rather than the first — a video that is wrong in two ways is two problems.
 *
 * Duration is compared with a tolerance because a container stores it as a
 * rational and 450/30 s is not exactly representable in every muxer.
 *
 * @param {object} input
 * @param {{frameStart: number, frameEnd: number, fps: number, width: number, height: number, frameCount: number}} input.claimed
 * @param {{durationSeconds: number|null, fps: number|null, width: number|null, height: number|null, nbFrames: number|null, codec: string|null}} input.probed
 * @param {number} [input.durationToleranceSeconds]
 * @returns {{ok: boolean, problems: object[]}}
 */
export function verifyVideoProperties(input) {
  const { claimed, probed } = input
  const tolerance = input.durationToleranceSeconds ?? 0.05
  const problems = []

  const expectedDuration = claimed.frameCount / claimed.fps
  if (probed.width !== claimed.width || probed.height !== claimed.height) {
    problems.push({
      field: 'resolution',
      claimed: `${claimed.width}x${claimed.height}`,
      probed: `${probed.width}x${probed.height}`,
    })
  }
  if (probed.fps === null || Math.abs(probed.fps - claimed.fps) > 0.001) {
    problems.push({ field: 'fps', claimed: claimed.fps, probed: probed.fps })
  }
  if (probed.nbFrames !== null && probed.nbFrames !== claimed.frameCount) {
    problems.push({ field: 'frameCount', claimed: claimed.frameCount, probed: probed.nbFrames })
  }
  if (probed.durationSeconds === null ||
      Math.abs(probed.durationSeconds - expectedDuration) > tolerance) {
    problems.push({
      field: 'durationSeconds',
      claimed: Number(expectedDuration.toFixed(6)),
      probed: probed.durationSeconds,
      tolerance,
    })
  }
  if (probed.codec === null || !/h264|hevc|av1|vp9/i.test(probed.codec)) {
    problems.push({ field: 'codec', claimed: 'h264 (or another delivery codec)', probed: probed.codec })
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Does a delivery manifest describe a complete delivery? (SPEC §20 M3
 * "最终包始终包含 SceneSpec、.blend、视频、Manifest 和 QA")
 *
 * Kept here so the tool, the UI and any future export path answer the same
 * question the same way — a second opinion about completeness is a second thing
 * that can be wrong.
 *
 * @param {object} manifest
 * @returns {{complete: boolean, missing: string[]}}
 */
export function deliveryCompleteness(manifest) {
  const missing = []
  const frames = manifest?.frames ?? {}
  // The source artifacts live under `source`, and QA under `qa.report`. Read from
  // the document that is actually written: an earlier version of this function
  // expected `manifest.sceneSpec` and reported every complete delivery as missing
  // its SceneSpec and checkpoint — a checker that disagrees with its own producer
  // is worse than no checker, because it is believed.
  const source = manifest?.source ?? {}
  const present = entry => entry !== undefined && entry !== null && entry.path !== undefined && entry.path !== null

  if (manifest?.video?.path === undefined || manifest?.video?.path === null) missing.push('video')
  if (!Number.isFinite(frames.rendered) || frames.rendered <= 0) missing.push('frames')
  if (Number.isFinite(frames.rendered) && Number.isFinite(frames.expected) && frames.rendered !== frames.expected) {
    missing.push(`frames-incomplete (${frames.rendered}/${frames.expected})`)
  }
  if (manifest?.video?.verified !== true) missing.push('video-unverified')
  if (!present(source.sceneSpec)) missing.push('scene-spec')
  if (!present(source.checkpoint)) missing.push('checkpoint')
  if (manifest?.qa?.report === undefined || manifest.qa.report === null) missing.push('qa')
  return { complete: missing.length === 0, missing }
}

/**
 * Render a render-job record as the compact line a model reads.
 *
 * @param {object} record
 * @returns {string}
 */
export function describeRenderJob(record) {
  const total = (record.frameEnd ?? 0) - (record.frameStart ?? 0) + 1
  const done = Array.isArray(record.completedFrames) ? record.completedFrames.length : 0
  const parts = [
    `${record.jobId} [${record.type}] ${record.status}`,
    `project ${record.projectId}`,
    `revision ${record.revisionId}`,
    `frames ${record.frameStart}..${record.frameEnd} (${done}/${total})`,
    `attempt ${record.attempt}`,
  ]
  if (record.pid !== undefined && record.pid !== null) parts.push(`pid ${record.pid}`)
  if (record.errorCode !== undefined && record.errorCode !== null) parts.push(`error ${record.errorCode}`)
  if (record.message !== undefined && record.message !== null) parts.push(record.message)
  return parts.join(' | ')
}
