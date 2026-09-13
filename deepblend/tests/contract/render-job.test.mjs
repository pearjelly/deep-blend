#!/usr/bin/env node
/**
 * M3 contract test — the render job's vocabulary, the frame ledger, and the
 * delivery checks.
 *
 * WHY THE LEDGER IS TESTED WITH SYNTHETIC FRAMES
 * ----------------------------------------------
 * The M3 acceptance conditions that need a real Blender and a real kill are in
 * `blender-integration/render-job.e2e.mjs`. What is tested here is the DECISION
 * RULE those conditions depend on, and it is tested against frames whose bytes the
 * test controls, because that is the only way to produce the cases that matter:
 *
 *   - a file that exists and is empty,
 *   - a file that exists, starts with the PNG signature, and has no IEND because
 *     the writer was killed mid-flush,
 *   - a complete PNG of the wrong resolution,
 *   - a complete PNG at exactly the size floor.
 *
 * A test written against a real render can only produce frames that work. And the
 * rule being tested is precisely "which frames does the runtime still owe", where a
 * wrong answer is silent: too few and the delivery ships short, too many and a
 * three-hour render is repeated.
 *
 * THE OTHER HALF IS THE AGREEMENT WITH PYTHON
 * -------------------------------------------
 * `frameFileName` here must equal `frame_file_name` in `deepblend_frames.py`, byte
 * for byte, or every frame reads as missing. The naming was MEASURED on Blender
 * 5.2.1 (`frame_path()` predicts `frame_0001.png`, `write_still` writes
 * `frame_.png`), so the test pins the string rather than deriving it twice.
 *
 * Run standalone: `node deepblend/tests/contract/render-job.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DELIVERY_MANIFEST_VERSION,
  MIN_FRAME_BYTES,
  PROCESS_IDENTITY_VERSION,
  RENDER_JOB_STATUSES,
  RENDER_JOB_TERMINAL_STATUSES,
  RENDER_JOB_TYPES,
  RENDER_JOB_VERSION,
  canTransitionRenderJob,
  checkTransition,
  deliveryCompleteness,
  describeRenderJob,
  estimateRemaining,
  frameFileName,
  frameNumbers,
  inspectFrameBytes,
  inspectFrameSample,
  isTerminalRenderJobStatus,
  renderProgressPercent,
  resolveFrameLedger,
  verifyVideoProperties,
} from '@deepblend/dsh-blender-contracts'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')

// ---------------------------------------------------------------------------
// 1. A real PNG, built so the checks have something true to accept
// ---------------------------------------------------------------------------

/** A structurally valid PNG: signature, IHDR with the given size, filler, IEND. */
function makePng(width, height, fillerBytes = 600) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  const iend = Buffer.concat([Buffer.alloc(4), Buffer.from('IEND'), Buffer.from([0xae, 0x42, 0x60, 0x82])])
  return Buffer.concat([signature, ihdr, Buffer.alloc(fillerBytes), iend])
}

const good = makePng(1920, 1080)
check('a structurally valid PNG is accepted', inspectFrameBytes(good, { width: 1920, height: 1080 }).ok === true,
  inspectFrameBytes(good, { width: 1920, height: 1080 }))
check('a complete PNG of the wrong resolution is refused, and says both sizes',
  inspectFrameBytes(good, { width: 640, height: 360 }).reason === 'wrong-dimensions 1920x1080, expected 640x360',
  inspectFrameBytes(good, { width: 640, height: 360 }).reason)
check('the sample-based check and the whole-buffer check agree on a complete frame',
  JSON.stringify(inspectFrameSample({ size: good.length, header: good.subarray(0, 33), tail: good.subarray(good.length - 12) }, { width: 1920, height: 1080 })) ===
  JSON.stringify(inspectFrameBytes(good, { width: 1920, height: 1080 })))

// The case a kill -9 between create() and finish() produces.
const torn = good.subarray(0, good.length - 40)
check('a frame with no IEND trailer is NOT a frame', inspectFrameBytes(torn).reason === 'unterminated',
  inspectFrameBytes(torn))
check('an empty file is reported as empty, not as truncated',
  inspectFrameBytes(Buffer.alloc(0)).reason === 'empty')
check(`a file under the ${MIN_FRAME_BYTES}-byte floor is truncated`,
  inspectFrameBytes(Buffer.alloc(MIN_FRAME_BYTES - 1)).reason === 'truncated')
check('a file that is not a PNG at all is refused by signature',
  inspectFrameBytes(Buffer.alloc(MIN_FRAME_BYTES + 100, 0x41)).reason === 'not-a-png')
check('a torn frame keeps the dimensions it did have, so the report is useful',
  inspectFrameBytes(torn).width === 1920 && inspectFrameBytes(torn).height === 1080)

// ---------------------------------------------------------------------------
// 2. The ledger: which frames are still owed
// ---------------------------------------------------------------------------

const observed = new Map([
  [1, { ok: true, bytes: 1048930 }],
  [2, { ok: false, reason: 'truncated', bytes: 200 }],
  // 3 is absent entirely.
  [4, { ok: true, bytes: 1048930 }],
])
const ledger = resolveFrameLedger({ expected: [1, 2, 3, 4, 5], observed })
check('the ledger separates present, corrupt and missing', JSON.stringify({
  present: ledger.present.map(entry => entry.frame),
  corrupt: ledger.corrupt.map(entry => entry.frame),
  missing: ledger.missing,
}) === JSON.stringify({ present: [1, 4], corrupt: [2], missing: [3, 5] }), ledger)
check('the render set is missing PLUS corrupt — a half-written frame is re-rendered, not kept',
  JSON.stringify([...ledger.toRender].sort((left, right) => left - right)) === JSON.stringify([2, 3, 5]),
  ledger.toRender)
check('a frame that is neither observed nor present is missing, never assumed done',
  resolveFrameLedger({ expected: [7], observed: new Map() }).missing[0] === 7)

// ---------------------------------------------------------------------------
// 3. The frame naming, pinned against the MEASURED Blender behaviour
// ---------------------------------------------------------------------------

check('frame naming pads to four digits', frameFileName(1) === 'frame_0001.png', frameFileName(1))
check('frame naming survives four digits and beyond',
  frameFileName(450) === 'frame_0450.png' && frameFileName(12345) === 'frame_12345.png',
  [frameFileName(450), frameFileName(12345)])
check('a non-default prefix and padding are honoured',
  frameFileName(7, 'shot_', 3) === 'shot_007.png', frameFileName(7, 'shot_', 3))

// The Python side is the other half of this contract. The naming helper lives in
// `deepblend_util.py` — the module that imports no bpy — precisely so this
// comparison can run in a plain CPython instead of costing a Blender launch. A
// naming rule checkable only by starting Blender is a rule nobody checks.
const pythonNaming = execFileSync('python3', ['-c', [
  'import json, sys',
  `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'packages', 'deepblend', 'provider-local', 'python'))})`,
  'from deepblend_util import frame_file_name',
  'print(json.dumps([frame_file_name(1), frame_file_name(450), frame_file_name(12345), frame_file_name(7, "shot_", 3)]))',
].join('\n')], { encoding: 'utf8' }).trim()
check('deepblend_util.py names frames identically to contracts',
  JSON.stringify(JSON.parse(pythonNaming)) ===
    JSON.stringify(['frame_0001.png', 'frame_0450.png', 'frame_12345.png', 'shot_007.png']),
  pythonNaming)

// ---------------------------------------------------------------------------
// 4. Frame ranges
// ---------------------------------------------------------------------------

check('an inclusive range is every frame', JSON.stringify(frameNumbers(1, 4).frames) === JSON.stringify([1, 2, 3, 4]))
check('a single-frame range is one frame', JSON.stringify(frameNumbers(7, 7).frames) === JSON.stringify([7]))
check('an INVERTED range is an error, not an empty success',
  frameNumbers(9, 3).error !== null && frameNumbers(9, 3).frames.length === 0, frameNumbers(9, 3))
check('a non-integer bound is an error', frameNumbers(1.5, 9).error !== null)

// ---------------------------------------------------------------------------
// 5. The state machine
// ---------------------------------------------------------------------------

check('the SPEC §10.2 status vocabulary is exactly what is declared',
  JSON.stringify(RENDER_JOB_STATUSES) ===
    JSON.stringify(['queued', 'running', 'stopping', 'recovering', 'completed', 'failed', 'cancelled']),
  RENDER_JOB_STATUSES)
check('the SPEC §10.2 type vocabulary is exactly what is declared',
  JSON.stringify(RENDER_JOB_TYPES) === JSON.stringify(['preview', 'final-render', 'export']), RENDER_JOB_TYPES)
check('terminal statuses are exactly completed, failed and cancelled',
  JSON.stringify(RENDER_JOB_TERMINAL_STATUSES) === JSON.stringify(['completed', 'failed', 'cancelled']))
check('a COMPLETED job has no outgoing transition: its delivery is published',
  RENDER_JOB_STATUSES.filter(next => canTransitionRenderJob('completed', next)).length === 1 &&
  canTransitionRenderJob('completed', 'running') === false)
check('a FAILED job can be explicitly re-opened, because a crash must not cost the whole render',
  canTransitionRenderJob('failed', 'running') === true && canTransitionRenderJob('failed', 'recovering') === true)
check('a CANCELLED job can be explicitly re-opened too, for the same reason',
  canTransitionRenderJob('cancelled', 'running') === true)
check('"terminal" means no AUTOMATIC work, which is what the reconciler scans by',
  RENDER_JOB_TERMINAL_STATUSES.every(isTerminalRenderJobStatus) &&
  RENDER_JOB_STATUSES.filter(status => !isTerminalRenderJobStatus(status)).length === 4)
check('running -> recovering is legal, because that is what a restart produces',
  canTransitionRenderJob('running', 'recovering') === true)
check('recovering -> running is legal, because that is what a resume produces',
  canTransitionRenderJob('recovering', 'running') === true)
check('queued -> recovering is legal, because a Host can die before the first frame',
  canTransitionRenderJob('queued', 'recovering') === true)
check('an illegal transition explains itself', checkTransition('completed', 'running').reason !== null,
  checkTransition('completed', 'running').reason)
check('the record and manifest document types are versioned strings',
  RENDER_JOB_VERSION === 'deepblend.render-job/v1' &&
  PROCESS_IDENTITY_VERSION === 'deepblend.process/v1' &&
  DELIVERY_MANIFEST_VERSION === 'deepblend.delivery-manifest/v1')

// ---------------------------------------------------------------------------
// 6. Progress
// ---------------------------------------------------------------------------

check('progress is counted in frames', renderProgressPercent({ expected: 450, done: 225 }) === 50)
check('progress is 0 before anything is done, and never negative',
  renderProgressPercent({ expected: 450, done: 0 }) === 0 && renderProgressPercent({ expected: 450, done: -3 }) === 0)
check('progress never exceeds 100 even if the count does',
  renderProgressPercent({ expected: 10, done: 12 }) === 100)
check('progress of an empty range is 0 rather than a division by zero',
  renderProgressPercent({ expected: 0, done: 0 }) === 0)
const estimate = estimateRemaining({ perFrameMs: [1000, 3000], remainingFrames: 10 })
check('the remaining-time estimate uses the measured mean',
  estimate.meanMsPerFrame === 2000 && estimate.estimatedRemainingMs === 20000, estimate)
check('no timing samples means no estimate, not a zero',
  estimateRemaining({ perFrameMs: [], remainingFrames: 10 }).estimatedRemainingMs === null)

// ---------------------------------------------------------------------------
// 7. Video properties — the "最终视频属性正确" check, as a pure function
// ---------------------------------------------------------------------------

const claimed = { frameStart: 1, frameEnd: 450, frameCount: 450, fps: 30, width: 1920, height: 1080 }
const correct = { durationSeconds: 15, fps: 30, width: 1920, height: 1080, nbFrames: 450, codec: 'h264' }
check('a correct video verifies', verifyVideoProperties({ claimed, probed: correct }).ok === true,
  verifyVideoProperties({ claimed, probed: correct }))

check('a video one frame short is caught by the decoded count',
  verifyVideoProperties({ claimed, probed: { ...correct, nbFrames: 449 } }).problems
    .some(problem => problem.field === 'frameCount'))
check('a video of the right length at the wrong resolution is caught',
  verifyVideoProperties({ claimed, probed: { ...correct, width: 1280 } }).problems
    .some(problem => problem.field === 'resolution'))
check('a 29.97 fps video is caught',
  verifyVideoProperties({ claimed, probed: { ...correct, fps: 29.970029 } }).problems
    .some(problem => problem.field === 'fps'))
check('a duration that disagrees with frames/fps is caught',
  verifyVideoProperties({ claimed, probed: { ...correct, durationSeconds: 14.5 } }).problems
    .some(problem => problem.field === 'durationSeconds'))
check('a container that could not be probed for duration is a problem, not a pass',
  verifyVideoProperties({ claimed, probed: { ...correct, durationSeconds: null } }).problems
    .some(problem => problem.field === 'durationSeconds'))
check('a codec no player accepts is caught',
  verifyVideoProperties({ claimed, probed: { ...correct, codec: 'prores' } }).problems
    .some(problem => problem.field === 'codec'))
check('a 30-frame clip claims 1.0 s and is verified against that, not against 15 s',
  verifyVideoProperties({
    claimed: { frameStart: 1, frameEnd: 30, frameCount: 30, fps: 30, width: 1920, height: 1080 },
    probed: { ...correct, durationSeconds: 1, nbFrames: 30 },
  }).ok === true)
check('EVERY disagreement is reported, not just the first',
  verifyVideoProperties({ claimed, probed: { durationSeconds: 14, fps: 25, width: 1280, height: 720, nbFrames: 400, codec: 'prores' } })
    .problems.length === 5)

// ---------------------------------------------------------------------------
// 8. Delivery completeness — "can a reader judge the package without opening it"
// ---------------------------------------------------------------------------

// The EXACT shape `buildDeliveryManifest` produces. An earlier version of this
// fixture used `manifest.sceneSpec` while the builder wrote `manifest.source.sceneSpec`,
// so the checker reported every complete delivery as missing its SceneSpec and
// checkpoint. A test fixture that does not match the producer hides exactly that.
const manifest = {
  video: { path: 'output/final.mp4', verified: true },
  frames: { expected: 450, rendered: 450 },
  source: {
    sceneSpec: { path: 'revisions/r0029/scene-spec.json' },
    checkpoint: { path: 'revisions/r0029/scene.blend' },
    qa: { path: 'revisions/r0029/validation.json' },
  },
  qa: { report: { ok: true } },
}
check('a complete package is complete', deliveryCompleteness(manifest).complete === true,
  deliveryCompleteness(manifest))
check('a package with no video is not complete',
  deliveryCompleteness({ ...manifest, video: {} }).missing.includes('video'))
check('a package whose video failed verification is not complete',
  deliveryCompleteness({ ...manifest, video: { path: 'x', verified: false } }).missing.includes('video-unverified'))
check('a package with 447 of 450 frames says exactly how many are owed',
  deliveryCompleteness({ ...manifest, frames: { expected: 450, rendered: 447 } }).missing
    .includes('frames-incomplete (447/450)'))
check('a package with no QA is not complete',
  deliveryCompleteness({ ...manifest, qa: {} }).missing.includes('qa'))
check('a package whose SceneSpec the builder did not record is not complete',
  deliveryCompleteness({ ...manifest, source: { ...manifest.source, sceneSpec: { path: null } } }).missing.includes('scene-spec'))
check('a package whose checkpoint the builder did not record is not complete',
  deliveryCompleteness({ ...manifest, source: { ...manifest.source, checkpoint: { path: null } } }).missing.includes('checkpoint'))
const emptyPackage = { video: {}, frames: {}, source: {}, qa: {} }
check('every missing piece is listed, not just the first',
  JSON.stringify(deliveryCompleteness(emptyPackage).missing) ===
    JSON.stringify(['video', 'frames', 'video-unverified', 'scene-spec', 'checkpoint', 'qa']),
  deliveryCompleteness(emptyPackage).missing)
const noFrameCounts = { video: { path: 'x', verified: true }, frames: {}, source: { sceneSpec: { path: 'a' }, checkpoint: { path: 'b' } }, qa: { report: {} } }
check('a package that reports no frame counts at all is called out as "frames", not as a count mismatch',
  deliveryCompleteness(noFrameCounts).missing.includes('frames') &&
  !deliveryCompleteness(noFrameCounts).missing.some(entry => entry.startsWith('frames-incomplete')))

// ---------------------------------------------------------------------------
// 9. The model-readable line
// ---------------------------------------------------------------------------

const line = describeRenderJob({
  jobId: 'render-0001', type: 'final-render', status: 'recovering', projectId: 'watch-commercial',
  revisionId: 'r0029', frameStart: 1, frameEnd: 450, completedFrames: [1, 2, 3], attempt: 2, pid: 81187,
})
check('a render job reads as one line naming job, status, range and progress',
  line.includes('render-0001') && line.includes('recovering') && line.includes('1..450') &&
  line.includes('(3/450)') && line.includes('attempt 2') && line.includes('pid 81187'), line)

// ---------------------------------------------------------------------------
// 10. The host's ledger reads a real directory, and calls a torn frame missing
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-m3-ledger-'))
try {
  const framesDirectory = join(scratch, 'frames')
  mkdirSync(framesDirectory, { recursive: true })
  writeFileSync(join(framesDirectory, 'frame_0001.png'), good)
  writeFileSync(join(framesDirectory, 'frame_0002.png'), torn)
  writeFileSync(join(framesDirectory, 'frame_0003.png'), Buffer.alloc(10))
  writeFileSync(join(framesDirectory, 'not-a-frame.png'), good)

  const { readFrameLedger, framesOnDisk } = await import('@deepblend/dsh-blender-host')
  const diskLedger = readFrameLedger({
    framesDirectory,
    expected: [1, 2, 3, 4],
    expectedSize: { width: 1920, height: 1080 },
  })
  check('the host ledger reads a real directory and reports what is owed',
    JSON.stringify({ present: diskLedger.present.map(entry => entry.frame), corrupt: diskLedger.corrupt.map(entry => entry.frame), missing: diskLedger.missing }) ===
    JSON.stringify({ present: [1], corrupt: [2, 3], missing: [4] }), diskLedger)
  check('the render set from the host ledger is missing plus corrupt',
    JSON.stringify([...diskLedger.toRender].sort((left, right) => left - right)) === JSON.stringify([2, 3, 4]),
  diskLedger.toRender)
  check('a file named like a frame but not one of this job\'s frames is not counted as present',
    diskLedger.presentCount === 1)
  check('the on-disk listing is diagnostic only, and does include the stray file',
    JSON.stringify(framesOnDisk(framesDirectory)) === JSON.stringify([1, 2, 3]), framesOnDisk(framesDirectory))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nM3 render job contract: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
