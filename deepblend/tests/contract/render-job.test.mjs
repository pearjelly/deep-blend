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
 * `frameFileName` here must equal `frame_file_name` in `deepblend_util.py`, byte for
 * byte, or every frame reads as missing. The naming was MEASURED on Blender 5.2.1
 * (`frame_path()` predicts `frame_0001.png`, `write_still` writes `frame_.png`), so the
 * test pins the string rather than deriving it twice. That comparison is the one thing in
 * this layer that needs a Python 3 on PATH, and the file says so in a check of its own
 * rather than dying on `ENOENT` halfway through.
 *
 * Run standalone: `node deepblend/tests/contract/render-job.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { UNFINISHED_STATUSES } from '@deepblend/dsh-blender-host'
import { describeJobLines } from '@deepblend/dsh-blender-tool'

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
// 1d. The technical validation the host PROJECTS, against what Python emits
// ---------------------------------------------------------------------------
//
// The compile report's `validation` is written by `deepblend_validate.py`, and the revision manifest carries a
// projection of it (`technical.ok`, `.errors`, `.counts`, `.geometry`, `.frameRange`, `.fps`, `.engine`,
// `.activeCamera`, `.animatedObjects`, `.cameraParameters`). Every one of those reads is `?? null`-guarded, so
// a renamed field does not fail — it puts `null` in the manifest and the panel shows a revision whose technical
// validation is partly empty. The names are therefore held against the validator's own returned dictionary.
//
// The validator itself needs a live `bpy.context.scene`, so this tie is SOURCE-level: the keys of its `return`
// literal, read out of the file. The extraction is guarded — a pattern that stops matching would make the check
// pass over nothing, which is exactly the failure mode a source-level check has to defend against.
{
  const validator = readFileSync(
    join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_validate.py'), 'utf8',
  )
  // Bounded by the function itself: `validate_scene` contains nested helpers with their own `return {`, and the
  // first version of this slice started at one of THOSE — it found seven keys, none of them the report's, and
  // reported every projected field as missing. The body runs to the next top-level `def`.
  const bodyStart = validator.indexOf('def validate_scene')
  const nextDef = validator.indexOf('\ndef ', bodyStart + 10)
  const body = validator.slice(bodyStart, nextDef === -1 ? undefined : nextDef)
  const emitted = [...new Set([...body.matchAll(/^ {8}"([a-zA-Z][a-zA-Z0-9_]*)":/gm)].map(m => m[1]))]
  const transaction = readFileSync(
    join(ROOT, 'packages', 'deepblend', 'host', 'lib', 'revision-transaction.js'), 'utf8',
  )
  const projected = [...new Set([...transaction.matchAll(/technical\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(m => m[1]))]
  // The PAIRS matter, not just the reads: the projection writes `counts: technical.counts ?? null`, so a
  // renamed OUTPUT key keeps the read intact and the field silently disappears from the manifest under a name
  // nobody looks for. The mutation that does exactly that (`cameraParametersX: technical.cameraParameters`)
  // survived the read-only version of this check.
  const pairs = [...transaction.matchAll(/([a-zA-Z][a-zA-Z0-9_]*): technical\.([a-zA-Z][a-zA-Z0-9_]*) \?\? null/g)]
    .map(match => ({ key: match[1], reads: match[2] }))
  check('the validator\u2019s own extraction is not empty (a source-level check must be able to see its input)',
    emitted.length >= 5 && pairs.length >= 5, { emitted: emitted.length, pairs: pairs.length })
  check('every field the host projects out of the technical validation is one the validator emits',
    projected.length > 0 && projected.every(field => emitted.includes(field)),
    { pythonEmits: emitted, hostProjects: projected, missing: projected.filter(f => !emitted.includes(f)) })
  check('and every projected key is named after the field it reads, so a rename cannot hide a field',
    pairs.length > 0 && pairs.every(pair => pair.key === pair.reads),
    pairs.filter(pair => pair.key !== pair.reads))
}

// ---------------------------------------------------------------------------
// 1e. The procedural-texture vocabulary, across the language boundary
// ---------------------------------------------------------------------------
//
// `material.texture` is declared in the SceneSpec schema (`type: noise|wave|voronoi`) and built by the compiler
// (`deepblend_scene.py`'s `TEXTURE_PATTERN_NODES`). The compiler refuses a type it has no node for — the right
// behaviour — but nothing held the two lists against each other, so a type added to the schema alone would be a
// capability the schema promises and the compiler rejects, discovered only when somebody tried it. This is the
// same tie as the fingerprint and the envelope: the names are one fact with two copies.
//
// Read from the file rather than imported: `deepblend_scene.py` imports `bpy` at the top and cannot be loaded
// outside Blender, while the table is a literal a regex can read exactly.
{
  const schema = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'schemas', 'scene-spec.schema.json'), 'utf8'))
  const declared = schema.$defs.proceduralTexture?.properties?.type?.enum ?? []
  const compiler = readFileSync(
    join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'deepblend_scene.py'), 'utf8',
  )
  const table = /TEXTURE_PATTERN_NODES = \{([\s\S]*?)\n\}/.exec(compiler)?.[1] ?? ''
  const built = [...table.matchAll(/^\s{4}"([a-z]+)":/gm)].map(match => match[1])
  check('the texture types the schema declares are the ones the compiler can build, and no others',
    declared.length >= 3 && built.length >= 3 &&
    JSON.stringify([...declared].sort()) === JSON.stringify([...built].sort()),
    { schema: declared, compiler: built })
}

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
// `deepblend_util.py` — the module that imports no bpy — precisely so this comparison can
// run in a plain CPython instead of costing a Blender launch. A naming rule checkable only
// by starting Blender is a rule nobody checks.
//
// IT IS ALSO THE ONLY REASON THIS FILE NEEDS PYTHON, and that prerequisite used to be an
// uncaught `spawnSync python3 ENOENT`. The throw happened at check 15 of 60, so a machine
// without Python lost the 45 checks after it AND got a stack instead of a summary — the
// two failure shapes SPEC §9.4 bans for the product, in the file that checks the product.
// A missing prerequisite is a named result like any other failure, and it is a FAILURE
// rather than a skip: "the two languages agree" is precisely the claim that did not get
// verified. Found by running this layer in a Linux container for the first time
// (milestone-status.md §25); CI installs Python for the same reason.
const python = ['DEEPBLEND_PYTHON', 'python3', 'python']
  .map(name => (name === 'DEEPBLEND_PYTHON' ? process.env.DEEPBLEND_PYTHON : name))
  .filter(name => typeof name === 'string' && name.length > 0)
  .find(candidate => {
    try {
      const version = execFileSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return version === '3'
    } catch {
      return false
    }
  })

if (python === undefined) {
  check('a Python 3 interpreter is available for the cross-language frame-naming check', false,
    'none of $DEEPBLEND_PYTHON, python3 or python is a Python 3. Install Python 3, or point ' +
    '$DEEPBLEND_PYTHON at one: this file is in the layer CI runs, so that layer needs Python as well as Node.')
} else {
  const pythonNaming = execFileSync(python, ['-c', [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'packages', 'deepblend', 'provider-local', 'python'))})`,
    'from deepblend_util import frame_file_name',
    'print(json.dumps([frame_file_name(1), frame_file_name(450), frame_file_name(12345), frame_file_name(7, "shot_", 3)]))',
  ].join('\n')], { encoding: 'utf8' }).trim()
  check('deepblend_util.py names frames identically to contracts',
    JSON.stringify(JSON.parse(pythonNaming)) ===
      JSON.stringify(['frame_0001.png', 'frame_0450.png', 'frame_12345.png', 'shot_007.png']),
    `${pythonNaming} via ${python}`)
}

// ---------------------------------------------------------------------------
// 1c. The result envelope's field names, across the language boundary
// ---------------------------------------------------------------------------
//
// Every action's answer travels as this document: `bootstrap.py` writes it, the provider parses it, and the host
// reads `envelope.warnings`, `envelope.notices`, `envelope.result`, `envelope.status` and `envelope.capabilities`
// out of it. The version is checked at runtime (`protocolVersion`), which catches a WHOLE-document change but not
// a renamed FIELD: an envelope that keeps its version and renames `notices` would leave the host reading
// `undefined` and reporting a render with no warnings — silence that looks like success. So the names are held
// against each other here, the same way the compile report's fingerprint is.
if (python !== undefined) {
  const envelopeKeys = JSON.parse(execFileSync(python, ['-c', [
    'import json, sys, types',
    'for name in ("bpy", "mathutils"):',
    '    module = types.ModuleType(name); module.ops = types.SimpleNamespace(); module.data = types.SimpleNamespace()',
    '    sys.modules[name] = module',
    'sys.modules["mathutils"].Vector = lambda *a, **k: None',
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'packages', 'deepblend', 'provider-local', 'python'))})`,
    'from bootstrap import build_envelope',
    'ok = build_envelope("job-1", "render_preview", {"views": []}, None, [], [])',
    'bad = build_envelope("job-1", "render_preview", None, {"code": "X", "message": "y"}, [], [])',
    'print(json.dumps({"ok": sorted(ok.keys()), "error": sorted(bad.keys()), "errorInner": sorted(bad["error"].keys())}))',
  ].join('\n')], { encoding: 'utf8' }).trim())
  const readerSources = [
    readFileSync(join(ROOT, 'packages', 'deepblend', 'provider-local', 'lib', 'index.js'), 'utf8'),
    readFileSync(join(ROOT, 'packages', 'deepblend', 'host', 'lib', 'index.js'), 'utf8'),
  ].join('\n')
  const envelopeReads = [...new Set([...readerSources.matchAll(/envelope\??\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(m => m[1]))]
  const emitted = new Set([...envelopeKeys.ok, ...envelopeKeys.error])
  check('the result envelope carries every field the host and provider read out of it',
    envelopeReads.length > 0 && envelopeReads.every(field => emitted.has(field)),
    { pythonEmits: envelopeKeys.ok, hostReads: envelopeReads,
      missing: envelopeReads.filter(field => !emitted.has(field)) })
  check('the error envelope carries the code and message the provider turns into a coded failure',
    envelopeKeys.errorInner.includes('code') && envelopeKeys.errorInner.includes('message'),
    envelopeKeys.errorInner)
}

// ---------------------------------------------------------------------------
// 1b. The compile report's field names, across the language boundary
// ---------------------------------------------------------------------------
//
// The host's polygon guard reads `sceneFingerprint.totalPolygons` out of the provider's compile report, and the
// report is built by Python (`bootstrap.py`'s `scene_fingerprint`). A renamed field on either side would make
// the guard compare `undefined` — a check that passes by not running, which is how a five-times-too-heavy scene
// gets committed. The field names are therefore held against each other here, and the host refuses a report
// that does not carry the count (`BLENDER_PROTOCOL_VERSION_MISMATCH`), so neither side can drift silently.
if (python !== undefined) {
  const fingerprintKeys = JSON.parse(execFileSync(python, ['-c', [
    'import json, sys, types',
    'for name in ("bpy", "mathutils"):',
    '    module = types.ModuleType(name); module.ops = types.SimpleNamespace(); module.data = types.SimpleNamespace()',
    '    sys.modules[name] = module',
    'sys.modules["mathutils"].Vector = lambda *a, **k: None',
    `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'packages', 'deepblend', 'provider-local', 'python'))})`,
    'from bootstrap import scene_fingerprint',
    'print(json.dumps(sorted(scene_fingerprint({"schemaVersion": "deepblend.scene/v1"}, [{"type": "mesh", "vertexCount": 8, "polygonCount": 6}]).keys())))',
  ].join('\n')], { encoding: 'utf8' }).trim())
  const hostSource = readFileSync(join(ROOT, 'packages', 'deepblend', 'host', 'lib', 'revision-transaction.js'), 'utf8')
  const readFields = [...new Set([...hostSource.matchAll(/sceneFingerprint\??\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(match => match[1]))]
  check('the compile report carries every field the host reads out of its fingerprint',
    readFields.length > 0 && readFields.every(field => fingerprintKeys.includes(field)),
    { pythonEmits: fingerprintKeys, hostReads: readFields })
}

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
// THE FOURTH COPY, AND IT LIVES IN A BROWSER BUNDLE. `ui/lib/client.js` decides a job's tone with its own
// hand-written list of the live statuses (`status === 'queued' || 'running' || 'stopping' || 'recovering'`) and
// falls back to `muted` for anything it does not recognise — so a status added to the vocabulary would render
// as a greyed-out job with no complaint from anywhere. It cannot be DERIVED: that file is a self-registering
// CJS factory the shell loads as a script, with no top-level imports (its only `require` is React), so the
// contracts are not reachable from it. A source-level check is the honest tie — the same conclusion the
// unreachable `readPixel` branch reached in round 109 — and it is written as an equality, not a subset, so a
// status the client INVENTED would fail too.
{
  const client = readFileSync(join(ROOT, 'packages', 'deepblend', 'ui', 'lib', 'client.js'), 'utf8')
  const liveLine = client.split('\n').find(line => line.includes("return 'live'")) ?? ''
  const liveInClient = [...liveLine.matchAll(/status === '([a-z]+)'/g)].map(match => match[1]).sort()
  const liveInContracts = RENDER_JOB_STATUSES.filter(status => !RENDER_JOB_TERMINAL_STATUSES.includes(status)).sort()
  check('the browser bundle\u2019s idea of a LIVE job is the vocabulary\u2019s complement of terminal, exactly',
    liveInClient.length > 0 && JSON.stringify(liveInClient) === JSON.stringify(liveInContracts),
    { inClient: liveInClient, inContracts: liveInContracts })
}

// AND THE HOST'S "STILL LIVE" LIST IS THE COMPLEMENT OF TERMINAL, not a fifth hand-written copy of it. The
// consequence is not cosmetic: `_activeRenderJob` uses this list to decide whether a project already has a
// delivery render, so a status missing from it hands the delivery slot to a second renderer writing into the
// same frames directory. It is computed from the vocabulary now; this is the assertion that keeps it computed
// (a mutation that puts the hand-written list back is invisible without it — measured).
{
  const live = RENDER_JOB_STATUSES.filter(status => !RENDER_JOB_TERMINAL_STATUSES.includes(status))
  check('the host\u2019s UNFINISHED_STATUSES is exactly the vocabulary minus the terminal statuses',
    JSON.stringify([...UNFINISHED_STATUSES]) === JSON.stringify(live),
    { store: [...UNFINISHED_STATUSES], vocabulary: live })
}

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
// 9b. The block a model reads when it asks about a job — warnings included
// ---------------------------------------------------------------------------

const reportedJob = {
  jobId: 'render-0001', projectId: 'watch-commercial', revisionId: 'r0029', status: 'failed',
  completedFrames: 30, expectedFrames: 450, percent: 7, frameStart: 1, frameEnd: 450,
  pid: null, meanMsPerFrame: null, estimatedRemainingMs: null, corruptFrames: [], errorCode: null,
  message: 'the renderer exited before every frame was written',
}
const plainLines = describeJobLines(reportedJob)
check('a job with no warnings prints no warning line — the negative control for the check below',
  !plainLines.some(entry => entry.startsWith('warning:')), plainLines)

const warnedLines = describeJobLines({
  ...reportedJob,
  warnings: [
    { code: 'JOB_PROJECTION_UNAVAILABLE', message: 'this render is not in the harness job list' },
    { code: 'JOURNAL_INCOMPLETE', message: 'an attempt was cut off mid-line in its event journal' },
  ],
})
check('every warning on the record reaches the reader, with its code',
  warnedLines.filter(entry => entry.startsWith('warning:  [')).length === 2 &&
  warnedLines.some(entry => entry.includes('[JOURNAL_INCOMPLETE]')) &&
  warnedLines.some(entry => entry.includes('[JOB_PROJECTION_UNAVAILABLE]')), warnedLines)
check('and the job\'s own numbers still come first, because a warning changes none of them',
  warnedLines[0].startsWith('job:') && warnedLines.indexOf(warnedLines.find(entry => entry.startsWith('warning:'))) >
  warnedLines.indexOf(warnedLines.find(entry => entry.startsWith('frames:'))), warnedLines)
check('a job whose warnings field is absent entirely is not a crash, and prints no line',
  (() => {
    const { warnings, ...withoutWarnings } = reportedJob
    const lines = describeJobLines(withoutWarnings)
    return Array.isArray(lines) && !lines.some(entry => entry.startsWith('warning:'))
  })())

// ---------------------------------------------------------------------------
// 9c. The block a model reads AFTER a failure — the states it exists for
// ---------------------------------------------------------------------------

// WHY THIS SECTION IS SEPARATE FROM 9b. The coverage reading (round 28) showed every line of the
// failure branches in `describeJobLines` still dark after four milestones: no suite had ever composed
// this block with a job that FAILED, that was found unfinished, or that had a published delivery —
// the tool-plane suites see a running job and a completed one, and nothing else. This is the text a
// model reads to decide what to do next, and it is the only place `corruptFrames`, `errorCode`,
// `delivery` and `recovery` reach a reader at all.

const failedJob = {
  ...reportedJob,
  errorCode: 'BLENDER_NONZERO_EXIT',
  corruptFrames: [
    { frame: 31, reason: 'unterminated' },
    { frame: 32, reason: 'wrong-dimensions 1920x1080, expected 1280x720' },
  ],
}
const failedLines = describeJobLines(failedJob)
check('a failed job tells the reader which frames are incomplete, and WHY each one is',
  failedLines.some(entry => entry.includes('incomplete frames:') && entry.includes('31 (unterminated)') &&
    entry.includes('32 (wrong-dimensions 1920x1080, expected 1280x720)')), failedLines)
check('and it names the coded reason it stopped, not just the word "failed"',
  failedLines.some(entry => entry.includes('errorCode: BLENDER_NONZERO_EXIT')), failedLines)

const manyCorrupt = describeJobLines({
  ...failedJob,
  corruptFrames: Array.from({ length: 11 }, (unused, index) => ({ frame: 100 + index, reason: 'truncated' })),
})
check('a long list of incomplete frames is truncated rather than flooded into the result',
  manyCorrupt.some(entry => entry.includes('+3 more')), manyCorrupt.find(entry => entry.includes('incomplete frames:')))

const deliveredJob = describeJobLines({
  ...reportedJob,
  status: 'completed',
  delivery: { status: 'published', videoPath: 'output/final.mp4' },
})
check('a job with a published delivery says where the video is',
  deliveredJob.some(entry => entry.includes('delivery: published -> output/final.mp4')), deliveredJob)

const recoveredJob = describeJobLines({
  ...reportedJob,
  status: 'recovering',
  recovery: { notes: ['the orphaned renderer was stopped', 'the ledger was rebuilt from 3 frame(s)'] },
})
check('a job found unfinished after a restart explains itself, note by note',
  recoveredJob.some(entry => entry.startsWith('recovery:')) &&
  recoveredJob.some(entry => entry.trim() === '- the orphaned renderer was stopped') &&
  recoveredJob.some(entry => entry.trim() === '- the ledger was rebuilt from 3 frame(s)'), recoveredJob)

const timedJob = describeJobLines({
  ...reportedJob,
  status: 'running',
  pid: 81187,
  meanMsPerFrame: 4200,
  estimatedRemainingMs: null,
})
check('a job that has measured its speed but not yet its remaining time says "unknown", not "null"',
  timedJob.some(entry => entry.startsWith('speed:') && entry.includes('4.2 s/frame') && entry.includes('~unknown remaining')), timedJob)

const noRecoveryNotes = describeJobLines({ ...reportedJob, recovery: { notes: [] } })
check('a recovery with no notes still says what happened, and prints no empty bullets',
  noRecoveryNotes.some(entry => entry.startsWith('recovery:')) &&
  !noRecoveryNotes.some(entry => entry.trim() === '-'), noRecoveryNotes)

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

  // THE OTHER HALF OF WHAT THIS FILE'S HEADER CLAIMS. It says "the parts that must agree with
  // `deepblend_frames.py` byte for byte" are pinned — and what WAS pinned (above) is the frame NAMING, against
  // `deepblend_util`. The two CLASSIFIERS were never held against each other: Python's `verify_frame` and this
  // host's `readFrameLedger` independently decide whether a file on disk is a frame, and a disagreement would
  // mean a render that Python considers finished is one the host keeps re-rendering (or the reverse, which is
  // worse: a delivery built from a frame nobody verified). They run here on the same four cases.
  if (python !== undefined) {
    const pythonVerdicts = JSON.parse(execFileSync(python, ['-c', [
      'import json, sys, types',
      // `deepblend_frames` imports Blender's modules at the top, and the classifier itself needs neither:
      // stubbing them is what lets the SAME file be exercised outside Blender, which is the point of the check.
      'for name in ("bpy", "mathutils"):',
      '    module = types.ModuleType(name); module.ops = types.SimpleNamespace(); module.data = types.SimpleNamespace()',
      '    sys.modules[name] = module',
      'sys.modules["mathutils"].Vector = lambda *a, **k: None',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'packages', 'deepblend', 'provider-local', 'python'))})`,
      'from deepblend_frames import verify_frame',
      `print(json.dumps({frame: verify_frame(${JSON.stringify(join(framesDirectory, 'frame_'))} + '%04d.png' % frame, 1920, 1080) for frame in (1, 2, 3, 4)}))`,
    ].join('\n')], { encoding: 'utf8' }).trim())
    const jsVerdict = (frame) => {
      if (diskLedger.present.some(entry => entry.frame === frame)) return 'present'
      if (diskLedger.corrupt.some(entry => entry.frame === frame)) return 'corrupt'
      return 'missing'
    }
    const disagreements = [1, 2, 3, 4].filter(frame =>
      (pythonVerdicts[frame].ok === true) !== (jsVerdict(frame) === 'present'))
    check('deepblend_frames.py and the host ledger AGREE, file by file, about what is a frame',
      disagreements.length === 0 &&
      pythonVerdicts[2].reason === 'unterminated' && pythonVerdicts[3].reason === 'truncated' &&
      pythonVerdicts[4].reason === 'missing',
      { python: pythonVerdicts, js: [1, 2, 3, 4].map(frame => `${frame}:${jsVerdict(frame)}`), disagreements })
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 11. An entry whose bytes cannot be read is CORRUPT, never MISSING
// ---------------------------------------------------------------------------

// Why a directory: it is the one name whose `stat` succeeds and whose bytes cannot be
// read (`openSync` on a directory succeeds on POSIX, `readSync` fails with EISDIR), so
// it is the only way to reach `sampleFrame`'s unreadable branch with a real filesystem
// and no permissions tricks — `chmod 000` is defeated by running as root, which CI does.
//
// MEASURED, and the reason for the filler files: a directory's `stat` size is an inode
// detail, 64 bytes for an empty one on APFS and ~40 on tmpfs, both below
// MIN_FRAME_BYTES (512) — so an empty directory would take the `truncated` branch and
// never reach the unreadable one. Filling it past 512 bytes takes the branch the render
// path actually produces (a frame replaced by something unreadable).
const unreadableScratch = mkdtempSync(join(tmpdir(), 'deepblend-m3-unreadable-'))
try {
  const framesDirectory = join(unreadableScratch, 'frames')
  const squatter = join(framesDirectory, 'frame_0004.png')
  mkdirSync(squatter, { recursive: true })
  for (let index = 0; index < 64; index += 1) writeFileSync(join(squatter, `filler-${index}`), 'x')

  const { readFrameLedger, framesOnDisk, sampleFrame } = await import('@deepblend/dsh-blender-host')

  const sample = sampleFrame(squatter)
  check('a name whose bytes cannot be read still reports that it EXISTS',
    sample.exists === true && sample.size > 0, sample)
  check('and says so by having no header, rather than by pretending it read one',
    sample.header === undefined && sample.tail === undefined, sample)

  const unreadableLedger = readFrameLedger({
    framesDirectory,
    expected: [4, 5],
    expectedSize: { width: 1920, height: 1080 },
  })
  check('a frame whose name is occupied but unreadable is CORRUPT, not MISSING',
    JSON.stringify(unreadableLedger.corrupt.map(entry => entry.frame)) === '[4]' &&
    JSON.stringify(unreadableLedger.missing) === '[5]',
  { corrupt: unreadableLedger.corrupt, missing: unreadableLedger.missing })
  check('and the reason names the read failure rather than blaming the frame\'s bytes',
    unreadableLedger.corrupt[0]?.reason === 'unreadable', unreadableLedger.corrupt[0])
  check('so it is scheduled for re-render like any other unusable frame',
    JSON.stringify([...unreadableLedger.toRender].sort((left, right) => left - right)) === JSON.stringify([4, 5]),
    unreadableLedger.toRender)
  check('and a directory is NOT reported as a frame present on disk, which is what a reader checks first',
    JSON.stringify(framesOnDisk(framesDirectory)) === '[]', framesOnDisk(framesDirectory))
  check('a frames directory that does not exist yet reads as no frames, not as a failure',
    JSON.stringify(framesOnDisk(join(unreadableScratch, 'never-created'))) === '[]')
} finally {
  rmSync(unreadableScratch, { recursive: true, force: true })
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
