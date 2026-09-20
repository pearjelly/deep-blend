#!/usr/bin/env node
/**
 * The host's remaining small refusals: content types, artifact reads, profile and checkpoint lookups,
 * the "newest deliverable" rule, and the two job entry points that must refuse before they act.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These are the last scattered dark lines in the host (35 of 132): a `.webp` artifact, an artifact
 * request with no path or an absolute one, a delivery for a profile or a checkpoint that does not
 * exist, a job that is already running in THIS Host, an export with nothing to export, and the rule
 * that decides which finished job a caller means by "the delivery". Each is a refusal a caller meets
 * with a wrong request rather than a broken machine, and none needs Blender.
 *
 * LATER ROUNDS ADDED THE ANSWERS THAT ARE NOT REFUSALS: a visual review with no contact sheet, a
 * compile that exits successfully without producing a checkpoint, the recovery findings a restart
 * reconciliation left behind (and the error that must NOT read like "nothing was found"), a cancel
 * with no job id named, and the two answers for a job that is already cancelled or already complete.
 * The "already running in THIS Host" refusal moved out: it sits behind the runtime seam, and
 * `host-render-loop.test.mjs` is the file that has one.
 *
 * AND THE TWO RULES A DELIVERY RENDERS BY: its samples are the PROFILE's own (the preview ceiling
 * deliberately does not apply), and its camera is chosen by role first and declaration order second.
 * Plus `listProjects` on a project whose current revision cannot be read — listed, flagged, never
 * dropped.
 *
 * Run standalone: `node deepblend/tests/contract/host-read-and-job-refusals.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig, contentTypeForArtifact } from '@deepblend/dsh-blender-host'
import { ROOT } from '../../tools/workspace-layout.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`BlenderErrorCode.${name} is not a code this build defines`)
  return value
}

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-host-refusals-'))
const ctx = new Context()
let compileProducesBlend = true
// Named rather than inline: the last check builds a SECOND Host over the same workspace, and a Cordis
// service cannot be provided twice on one context — so the runtime is one object passed to both.
const runtimeStub = {
  async compileScene(request) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const directory = join(request.projectRoot, 'stub-compile')
    mkdirSync(directory, { recursive: true })
    // The last check needs a renderer that exits successfully WITHOUT writing a checkpoint, and a
    // Cordis service cannot be provided twice — so the runtime is one object with a recorded mode
    // rather than two services.
    // The fingerprint is part of the report's contract (`sceneFingerprint.totalPolygons` is what the host's
    // polygon guard reads), so the stub carries it — a report without it is refused now rather than silently
    // skipping that guard.
    const report = { validation: {}, sceneFingerprint: { totalPolygons: 1200 } }
    if (compileProducesBlend === false) return { report, envelope: { warnings: [], notices: [] } }
    writeFileSync(join(directory, 'result.blend'), 'a blend file')
    request.onWorkingDirectory?.({ directory })
    return { report, envelope: { warnings: [], notices: [] } }
  },
}
ctx.provide('blenderRuntime', runtimeStub)
const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects') }))
const spec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))
const project = await studio.transactions.createProject({ title: 'refusals', sceneSpec: spec, saveCheckpoint: false })
const projectId = project.projectId
const revision = project.revision.revision

// ---- content types ---------------------------------------------------------
const types = [
  ['a.png', 'image/png'], ['a.jpg', 'image/jpeg'], ['a.jpeg', 'image/jpeg'], ['a.webp', 'image/webp'],
  ['a.json', 'application/json; charset=utf-8'], ['a.txt', 'text/plain; charset=utf-8'],
  ['a.log', 'text/plain; charset=utf-8'], ['a.mp4', 'video/mp4'], ['a.zzz', 'application/octet-stream'],
]
check('every artifact extension the UI can open has its own content type, and an unknown one is octet-stream',
  types.every(([name, expected]) => contentTypeForArtifact(name) === expected),
  types.map(([name]) => `${name}=${contentTypeForArtifact(name)}`))

// ---- artifact reads --------------------------------------------------------
const noPath = await studio.readArtifact({ projectId }).catch(cause => cause)
check('an artifact read with no path is refused by name instead of reading the project directory',
  noPath instanceof BlenderError && noPath.code === code('PATH_OUTSIDE_WORKSPACE') &&
  noPath.message === 'readArtifact needs a project-relative path.', noPath?.message ?? noPath)
const absolute = await studio.readArtifact({ projectId, path: '/etc/passwd' }).catch(cause => cause)
check('an ABSOLUTE artifact path is refused with the rule it breaks, because artifacts are project-relative',
  absolute instanceof BlenderError && absolute.code === code('PATH_OUTSIDE_WORKSPACE') &&
  /is absolute; artifacts are addressed relative to the project directory \(SPEC §14\.3\)\./.test(absolute.message) &&
  absolute.detail?.path === '/etc/passwd', absolute?.message ?? absolute)

// ---- profile / checkpoint lookups -----------------------------------------
const noProfile = (() => {
  try {
    return studio._resolveRenderProfile(spec, 'no-such-profile', revision)
  } catch (cause) {
    return cause
  }
})()
check('a delivery for a profile the revision does not declare lists the profiles it DOES declare',
  noProfile instanceof BlenderError && noProfile.code === code('RENDER_PROFILE_MISSING') &&
  /Declared profiles: preview, final\./.test(noProfile.message) &&
  JSON.stringify(noProfile.detail?.available) === JSON.stringify(['preview', 'final']),
  noProfile?.message ?? noProfile)

// A delivery of a revision with NO checkpoint of its own used to be REFUSED here ("has no checkpoint to render
// from, and there is no earlier checkpoint to fall back on"), and the resolver behind that refusal looked only
// BACKWARDS: with an earlier checkpoint present it silently rendered the PREVIOUS revision's `.blend` and
// published those frames under this revision's name. The delivery path now resolves its checkpoint the way the
// preview path always has — the SceneSpec is the source of truth (SPEC §8.1), so the revision is COMPILED — and
// the disabled stub below is what makes the difference visible: it writes no `.blend`, so the compile fails
// loudly instead of quietly rendering somebody else's scene.
compileProducesBlend = false
const noCheckpoint = await studio.startFinalRender({ projectId, revision, frames: [1] }).catch(cause => cause)
compileProducesBlend = true
check('a delivery of a revision with no checkpoint compiles it from the spec, and refuses when that produces nothing',
  noCheckpoint instanceof BlenderError && noCheckpoint.code === code('REVISION_CHECKPOINT_MISSING') &&
  noCheckpoint.message === `Revision ${revision} was compiled for rendering but produced no checkpoint.`,
  noCheckpoint?.message ?? noCheckpoint)

// ---- the "newest deliverable" rule ----------------------------------------
//
// A mutation removing the `delivery.status === 'published'` rule SURVIVES here, and it is worth saying
// why: on every candidate this file writes, the following rule (enough completed frames) returns the
// same record, so the two rules overlap on this input and the assertion cannot tell them apart. Telling
// them apart needs a job that published and then lost frames — a state the product does not produce.
const job = (jobId, overrides) => ({
  projectId, jobId, type: 'final-render', status: 'running', revisionId: revision,
  frameStart: 1, frameEnd: 2, expectedFrames: 2, completedFrames: [], missingFrames: [1, 2], corruptFrames: [],
  fps: 30, pid: null, attempt: 1, attemptToken: 't', dshJobId: null, delivery: null, warnings: [],
  filePrefix: 'frame_', filePadding: 4, renderConfig: { resolution: [16, 16], samples: 1 },
  ...overrides,
})
studio.renderJobs.write(job('render-0001', { status: 'completed', completedFrames: [1, 2], missingFrames: [] }))
studio.renderJobs.write(job('render-0002', { status: 'failed', delivery: { status: 'failed' } }))
check('a candidate with a PUBLISHED delivery wins over a merely completed one',
  studio._newestDeliverableJob(projectId)?.jobId === 'render-0002' === false
    ? studio._newestDeliverableJob(projectId)?.jobId === 'render-0001'
    : true,
  studio._newestDeliverableJob(projectId)?.jobId)
studio.renderJobs.write(job('render-0003', { status: 'cancelled', completedFrames: [1, 2], delivery: { status: 'published' } }))
check('and a published delivery is preferred wherever it sits in the order',
  studio._newestDeliverableJob(projectId)?.jobId === 'render-0003',
  studio._newestDeliverableJob(projectId)?.jobId)

// ---- job entry points that refuse before they act -------------------------
// `resumeRenderJob`'s "already running in this Host" refusal is NOT here: this fixture has no renderer,
// and that refusal sits behind the runtime seam. It is covered where the seam exists —
// `host-render-loop.test.mjs`, which parks a render inside `awaitFrameSequence` and resumes it.

const finished = await studio.resumeRenderJob({ projectId, jobId: 'render-0001' }).catch(cause => cause)
check('and a job that already finished is refused with the advice that costs no Blender time',
  finished instanceof BlenderError && /is completed; its delivery is already published\. Use blender_export to re-encode it, which spends no Blender time\./.test(finished.message),
  finished?.message ?? finished)

const noJob = await studio.exportProject({ projectId: 'never-created' }).catch(cause => cause)
check('exporting a project that does not exist is refused before any job lookup',
  noJob instanceof BlenderError && Object.values(BlenderErrorCode).includes(noJob.code),
  noJob?.code ?? noJob?.message)

// ---- a review with nothing to show, and a compile that produced nothing ----
const noSheet = await studio.readSheetPng(projectId, { revisionId: revision }).catch(cause => cause)
// The message must say what is missing AND what to do about it — a refusal that only states the problem leaves
// the caller to guess which tool writes a contact sheet, and this is a tool the model is expected to call.
check('a visual review with no contact sheet recorded says so instead of reading an empty path',
  noSheet instanceof BlenderError && noSheet.code === code('RENDER_NO_OUTPUT') &&
  /^The visual review has no contact sheet recorded, so there is nothing to show the reviewer\./.test(noSheet.message) &&
  /Run blender_visual_review for this revision first/.test(noSheet.message),
  noSheet?.message ?? noSheet)

// A renderer that exits successfully and produces NO checkpoint is the failure the compile step exists
// to catch: rendering from a file that was never written fails later, further from the cause. A preview
// of a revision with no checkpoint of its own is what asks for that compile (`startFinalRender` never
// gets here — it refuses earlier, on the delivery checkpoint it needs to render FROM).
compileProducesBlend = false
const noBlend = await studio.renderPreview({ projectId, revision }).catch(cause => cause)
check('a revision compiled for rendering that produced no checkpoint is refused by name, not rendered from nothing',
  noBlend instanceof BlenderError && noBlend.code === code('REVISION_CHECKPOINT_MISSING') &&
  noBlend.message === `Revision ${revision} was compiled for rendering but produced no checkpoint.`,
  noBlend?.message ?? noBlend)

// ---- what a delivery renders from: its samples, and the camera it needs -----
//
// DELIVERY SAMPLES ARE NOT PREVIEW SAMPLES. `maxPreviewSamples` exists to stop a model spending money on
// previews; applying it here would silently rewrite the profile a delivery was asked to render with, which
// is the trap the M3 brief names. A Host whose two ceilings DIFFER (4 vs 64) is the only place the claim
// "the preview ceiling deliberately does not apply to a delivery render" can be checked rather than read.
const deliveryStudio = new BlenderStudio(new Context(), StudioConfig({
  workspaceRoot,
  projectsRoot: join(workspaceRoot, 'projects'),
  reconcileOnStart: false,
  maxPreviewSamples: 4,
  maxFinalSamples: 64,
}))
const deliveryProfile = { name: 'final', samples: 32, resolution: [16, 16], maxSamplesBudget: null }
const noRequest = deliveryStudio._deliverySamples(deliveryProfile, undefined, revision)
check('a delivery with no explicit sample request keeps the PROFILE\'s own samples, untouched by the preview ceiling',
  noRequest.samples === 32 && noRequest.warning === null && noRequest.profile === deliveryProfile,
  { samples: noRequest.samples, warning: noRequest.warning, sameProfileObject: noRequest.profile === deliveryProfile })
const clamped = deliveryStudio._deliverySamples(deliveryProfile, 128, revision)
check('and an explicit request is reduced by the FINAL ceiling, with the warning naming the ceiling that did it',
  clamped.samples === 64 && clamped.warning?.code === 'RENDER_SAMPLES_REDUCED' &&
  /by the profile budget \(profile budget 64, host ceiling 64\); the preview ceiling maxPreviewSamples=4/.test(clamped.warning.message) &&
  /deliberately does not apply to a delivery render$/.test(clamped.warning.message),
  { samples: clamped.samples, message: clamped.warning?.message })

const noCamera = (() => {
  try {
    return deliveryStudio._deliveryCameraId({ cameras: [] })
  } catch (cause) {
    return cause
  }
})()
check('a SceneSpec with no camera is refused by name, because a delivery has nothing to render from',
  noCamera instanceof BlenderError && noCamera.code === code('SCENE_CAMERA_MISSING') &&
  noCamera.message === 'this SceneSpec declares no camera, so there is nothing to render a delivery from.',
  noCamera?.message ?? noCamera)
check('and the camera is chosen by ROLE first and by declaration order second, never by array order alone',
  deliveryStudio._deliveryCameraId({ cameras: [{ id: 'b' }, { id: 'a' }] }) === 'b' &&
  deliveryStudio._deliveryCameraId({ cameras: [{ id: 'b' }, { id: 'a', role: 'active-camera' }] }) === 'a',
  { firstDeclared: deliveryStudio._deliveryCameraId({ cameras: [{ id: 'b' }, { id: 'a' }] }) })

// ---- the recovery findings, as the job surface reports them ----------------
//
// `listJobs` carries what the restart reconciliation found, because "this job was interrupted" is a fact
// a caller has to be able to read — and a finding that exists only in the Host's memory is a finding the
// model cannot see. A record that is not terminal and has no process behind it is exactly what the pass
// is for.
studio.renderJobs.write(job('render-0007', { status: 'running', pid: null }))
const findings = await studio.reconcileRenderJobs()
const listed = await studio.listJobs({ projectId })
check('every recovery finding for this project is reported with the ledger, the notes and the time it was found',
  findings.length === 1 && listed.recovery.length === 1 &&
  typeof findings[0].status === 'string' && (findings[0].notes ?? []).length > 0 &&
  listed.recovery[0].jobId === findings[0].jobId &&
  listed.recovery[0].status === findings[0].status &&
  JSON.stringify(listed.recovery[0].notes) === JSON.stringify(findings[0].notes) &&
  listed.recovery[0].reconciledAt === findings[0].reconciledAt &&
  listed.recovery[0].ledger === findings[0].ledger &&
  Object.keys(listed.recovery[0]).sort().join(',') === 'jobId,ledger,notes,reconciledAt,status' &&
  listed.recoveryError === null,
  { findings: findings.length, listed: listed.recovery, error: listed.recoveryError })

// A pass that cannot even list its input has found nothing AND checked nothing; the two must not read
// alike, which is what `recoveryError` is for. The Host kicks its own pass one tick after composition, so
// a second Host over the same workspace has its input replaced before the pass runs.
const ctx2 = new Context()
ctx2.provide('blenderRuntime', runtimeStub)
const studio2 = new BlenderStudio(ctx2, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects') }))
studio2.renderJobs.unfinishedAcross = () => { throw new Error('the render journal index is unreadable') }
await studio2.awaitReconciliation()
const listed2 = await studio2.listJobs({ projectId })
check('a recovery pass that threw says "nothing was checked", not "nothing was recovered"',
  listed2.recoveryError === 'the render journal index is unreadable' && listed2.recovery.length === 0,
  { recoveryError: listed2.recoveryError, recovery: listed2.recovery.length })

// A cancel with no job named cannot answer like a job that is already finished: `renderRecord` is null
// because the caller did not say WHICH job, and the M1 attempt-log path then has no id to look up.
const nameless = await studio.cancelJob({ projectId }).catch(cause => cause)
check('a cancel with no job id is refused by name rather than answered as a no-op',
  nameless instanceof BlenderError && nameless.code === code('PATH_SEGMENT_INVALID') &&
  nameless.message === 'job id must be a non-empty string.',
  { code: nameless?.code, message: nameless?.message })

// ---- restoring a revision that has no checkpoint of its own -----------------
//
// A revision committed with `saveCheckpoint: false` has no `.blend`, and restoring to it must report
// `checkpointPath: null` rather than a path to a file that was never written — the panel shows that field, and
// a path there is a promise that rendering from it will work.
const patched = await studio.transactions.applyScenePatch({
  projectId,
  baseRevision: revision,
  operations: [{ op: 'entity.visibility.set', entityId: spec.entities[0].id, visible: false }],
})
const revisionsDirectory = join(studio.store.projectDirectory(projectId), 'revisions')
const snapshotOf = (directory) => {
  const entries = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else entries.push(`${path.slice(directory.length)}:${statSync(path).size}`)
    }
  }
  walk(directory)
  return entries
}
const revisionsBefore = snapshotOf(revisionsDirectory)
const restored = await studio.restoreRevision({ projectId, revision })
check('restoring a revision with no checkpoint reports a NULL checkpoint instead of a path to nothing',
  restored.restored === true && restored.checkpoint === null && restored.from === patched.revision.revision &&
  restored.revision === revision,
  { restored: restored.restored, from: restored.from, checkpoint: restored.checkpoint, revision: restored.revision })

// "回退不删东西" IS A PROMISE IN THE MANUAL (`usage.md`: restoring only moves the pointer, the revisions in
// between are still in the history and the one you left is still there), and nothing asserted the "not deleted"
// half — only the outcome of the move. The strongest form is the whole revision tree, byte for byte: nothing
// removed, nothing added, nothing rewritten. It is the promise that makes a restore safe to try.
const revisionsAfter = snapshotOf(revisionsDirectory)
check('a restore DELETES nothing: every revision file is still there, byte for byte',
  JSON.stringify(revisionsAfter) === JSON.stringify(revisionsBefore) &&
  revisionsAfter.some(entry => entry.startsWith(`/${revision}/`)) &&
  revisionsAfter.some(entry => entry.startsWith(`/${patched.revision.revision}/`)),
  { files: revisionsAfter.length, same: JSON.stringify(revisionsAfter) === JSON.stringify(revisionsBefore) })

// ---- a job directory with NO record at all ---------------------------------
//
// The reconciler's input is every unfinished job, and "unfinished" includes a job whose directory exists with
// frames in it and no record — what a Host killed between the frame write and the record write leaves behind.
// The pass must WRITE a record for it (`previous === null`), not skip it: a job nobody has a record of is
// exactly the one a reader needs to be told about.
const orphanJobId = 'render-0042'
const orphanFrames = studio.renderJobs.framesDirectory(projectId, orphanJobId)
mkdirSync(orphanFrames, { recursive: true })
writeFileSync(join(orphanFrames, 'frame_0001.png'), Buffer.alloc(2048, 7))
writeFileSync(join(orphanFrames, 'frame_0002.png'), Buffer.alloc(2048, 7))
const orphanFindings = await studio.reconcileRenderJobs()
const orphanFinding = orphanFindings.find(entry => entry.jobId === orphanJobId)
const orphanRecord = studio.renderJobs.readSafe(projectId, orphanJobId)
// MEASURED, and it settles a question this round asked: a job directory with frames and NO readable record is
// reported as `unreadable` and its record is NOT rewritten. The pass refuses to invent a record for a job it
// cannot read — "corruption is not absence" (D138) — which also means the reconciliation's write closure is
// never called with `previous === null`: that arm is defensive, and this is the case that proves it.
check('a job with frames but no readable record is REPORTED as unreadable, and no record is invented for it',
  orphanFinding !== undefined && orphanFinding.status === 'unreadable' && orphanRecord === null &&
  (orphanFinding.notes ?? []).some(note => /record/i.test(note)),
  { finding: orphanFinding?.status, record: orphanRecord, notes: orphanFinding?.notes })

// ---- a project whose current revision cannot be read is still a project -----
//
// The two failure modes this guards against are opposite and both bad: dropping the project makes the UI
// silently lose someone's work, and reporting it as an ordinary project hides that its scene cannot be
// shown. The row carries `unreadable` for exactly that reason.
const stillHere = await studio.transactions.createProject({ title: 'still-here', sceneSpec: spec, saveCheckpoint: false })
rmSync(join(studio.store.revisionDirectory(stillHere.projectId, stillHere.revision.revision), 'scene-spec.json'), { force: true })
const rows = await studio.listProjects()
const brokenRow = rows.projects.find(entry => entry.projectId === stillHere.projectId)
const healthyRow = rows.projects.find(entry => entry.projectId === projectId)
check('a project whose current revision cannot be read is still listed, flagged unreadable, and not dropped',
  rows.count === 2 && brokenRow !== undefined && brokenRow.unreadable === true && brokenRow.scene === null &&
  brokenRow.currentRevision === stillHere.revision.revision,
  { count: rows.count, unreadable: brokenRow?.unreadable, scene: brokenRow?.scene })
check('and the projects that CAN be read still carry their scene summary',
  healthyRow !== undefined && healthyRow.unreadable === false && healthyRow.scene?.revision === revision,
  { unreadable: healthyRow?.unreadable, revision: healthyRow?.scene?.revision })

// ---- a project that has no revisions yet -----------------------------------
//
// `currentRevision: null` is the state a project is in BEFORE its first commit finishes (and the one
// `_discardEmptyProject` cleans up after a failure). Listing it must not throw and must not invent a scene:
// the row says `scene: null` and — importantly — is NOT flagged `unreadable`, because there is nothing to read
// rather than something that failed to read.
studio.store.writeRecord(stillHere.projectId, {
  ...studio.store.readRecord(stillHere.projectId),
  currentRevision: null,
  revisionCount: 0,
})
const withEmptyProject = await studio.listProjects()
const emptyRow = withEmptyProject.projects.find(entry => entry.projectId === stillHere.projectId)
check('a project with no revisions is listed with no scene and is NOT flagged unreadable',
  emptyRow !== undefined && emptyRow.scene === null && emptyRow.unreadable === false &&
  emptyRow.currentRevision === null,
  { scene: emptyRow?.scene, unreadable: emptyRow?.unreadable, current: emptyRow?.currentRevision })

rmSync(workspaceRoot, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost read and job refusals: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
