#!/usr/bin/env node
/**
 * The host's render-job machinery: the delivery range a final render covers, and the recovery pass a
 * Host runs when it finds a render nobody is watching any more.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Both are host-level wrappers around logic that is already tested one layer down —
 * `frameNumbers`/`readFrameLedger` in the contracts, `reconcileRenderJob` in
 * `contract/render-reconciler.test.mjs` — and both wrappers were dark in the coverage reading
 * (48 lines). A wrapper is not automatically trivial: it is where a REFUSAL is turned into a code,
 * where a request is narrowed and the narrowing is REPORTED, and where one broken job must not stop
 * the pass over the others.
 *
 * The two rules worth stating, because both were dark:
 *
 *   - a delivery range that is not the project's own range says so, and a requested frame list that
 *     reaches outside it reports how many frames were DROPPED. Silence here produces a video whose
 *     length nobody can explain from the manifest.
 *   - the recovery pass catches a per-job failure and keeps going. Measured on a full volume
 *     (`tools/disk-full-probe.mjs`): recording a recovery means writing a record, and a record cannot
 *     be written to a disk with no room — so without that catch a Host whose volume is full would
 *     recover NOTHING, including the jobs of every other project on the same store.
 *
 * No Blender and no subprocess: the delivery range is a pure read of a SceneSpec, and the recovery
 * pass reads job records the test writes.
 *
 * Run standalone: `node deepblend/tests/contract/host-render-jobs.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { RenderJobStore, StudioConfig } from '@deepblend/dsh-blender-host'
import { ROOT } from '../../tools/workspace-layout.mjs'

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

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-render-jobs-'))
const ctx = new Context()
ctx.provide('blenderRuntime', {})
const studio = new BlenderStudio(ctx, StudioConfig({
  workspaceRoot,
  projectsRoot: join(workspaceRoot, 'projects'),
}))

const productSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))
const projectFrames = `${productSpec.project.frameStart}..${productSpec.project.frameEnd}`

// ---------------------------------------------------------------------------
// The delivery range
// ---------------------------------------------------------------------------

// Driven through the private method on purpose: the public entry point (`startFinalRender`) resolves
// the profile, takes the approval gate and SPAWNS BLENDER before it ever asks this question, so a
// contract test can only reach the range logic by calling it — with exactly the arguments the public
// path passes.
const rangeFor = request => studio._resolveDeliveryRange({ spec: productSpec, request })
/** The same call, with the refusal returned instead of thrown, so a check can assert on it. */
const rangeError = request => {
  try {
    return rangeFor(request)
  } catch (cause) {
    return cause
  }
}

const whole = rangeFor(undefined)
check('no request means the project\'s own range, with nothing to explain',
  whole.frames.length === productSpec.project.frameEnd - productSpec.project.frameStart + 1 &&
  whole.frames[0] === productSpec.project.frameStart &&
  whole.frames.at(-1) === productSpec.project.frameEnd &&
  whole.notices.length === 0,
  { frames: `${whole.frames[0]}..${whole.frames.at(-1)}`, count: whole.frames.length, notices: whole.notices })

const narrowed = rangeFor({ frameStart: 10, frameEnd: 20 })
check('an explicit range covers exactly those frames',
  narrowed.frames.length === 11 && narrowed.frames[0] === 10 && narrowed.frames.at(-1) === 20,
  narrowed.frames.length)
check('and a range that is NOT the project\'s own says so, because the manifest records both',
  narrowed.notices.length === 1 &&
  narrowed.notices[0] ===
    `this delivery covers frames 10..20, not the project's own range ${projectFrames}; the delivery manifest records both`,
  narrowed.notices)

const listed = rangeFor({ frames: [5, 3, 5, 200, 3] })
check('an explicit frame list is de-duplicated and sorted, so one frame is never encoded twice',
  JSON.stringify(listed.frames) === JSON.stringify([3, 5]),
  listed.frames)
check('frames outside the project\'s own range are DROPPED, and the count is reported',
  listed.notices.length === 1 &&
  listed.notices[0] === `1 requested frame(s) fall outside the project's own range ${projectFrames} and were dropped: 200`,
  listed.notices)

const allOutside = rangeError({ frames: [-5, 9999] })
check('a frame list that reaches outside the range ENTIRELY is refused, rather than producing an empty video',
  allOutside instanceof BlenderError && allOutside.code === code('RENDER_RANGE_INVALID') &&
  /every requested frame falls outside/.test(allOutside.message),
  allOutside?.message ?? allOutside)

const unusable = rangeError({ frames: ['later', null] })
check('a frame list with no usable numbers is refused instead of silently rendering nothing',
  unusable instanceof BlenderError && unusable.code === code('RENDER_RANGE_INVALID') &&
  /contains no usable frame numbers/.test(unusable.message) &&
  JSON.stringify(unusable.detail?.frames) === JSON.stringify(['later', null]),
  unusable?.message ?? unusable)
// `Number(null)` is 0, so a null used to become frame 0 and the refusal then named a frame the caller
// never wrote (the same shape as the `r0000` sentinel in `readRevisionPair`).
const nullFrame = rangeError({ frames: [null] })
check('a null in the frame list is not silently turned into frame 0',
  nullFrame instanceof BlenderError && /contains no usable frame numbers/.test(nullFrame.message) &&
  !/frame 0/.test(nullFrame.message) && !/falls outside/.test(nullFrame.message),
  nullFrame?.message ?? nullFrame)

const backwards = rangeError({ frameStart: 20, frameEnd: 10 })
check('a backwards range is refused, and the refusal names both ranges so the caller can see the mismatch',
  backwards instanceof BlenderError && backwards.code === code('RENDER_RANGE_INVALID') &&
  /the requested delivery range is invalid/.test(backwards.message) &&
  JSON.stringify(backwards.detail?.projectRange) === JSON.stringify([productSpec.project.frameStart, productSpec.project.frameEnd]),
  backwards?.detail ?? backwards?.message)

const brokenSpec = (() => {
  try {
    return studio._resolveDeliveryRange({
      spec: { ...productSpec, project: { ...productSpec.project, frameStart: 10, frameEnd: 1 } },
      request: undefined,
    })
  } catch (cause) {
    return cause
  }
})()
check('a SceneSpec whose own range is invalid is refused as a SPEC problem, not as a request problem',
  brokenSpec instanceof BlenderError && brokenSpec.code === code('RENDER_RANGE_INVALID') &&
  /the SceneSpec's own frame range is invalid/.test(brokenSpec.message) &&
  brokenSpec.detail?.frameStart === 10,
  brokenSpec?.detail ?? brokenSpec?.message)

// ---------------------------------------------------------------------------
// The recovery pass
// ---------------------------------------------------------------------------

/** A render job in the state a dead Host leaves behind. */
function runningRecord(projectId, jobId, overrides = {}) {
  return {
    projectId,
    jobId,
    type: 'final-render',
    status: 'running',
    revisionId: 'r0001',
    frameStart: 1,
    frameEnd: 3,
    expectedFrames: 3,
    completedFrames: [],
    missingFrames: [1, 2, 3],
    corruptFrames: [],
    fps: 30,
    pid: null,
    attempt: 1,
    attemptToken: 'token-a',
    dshJobId: null,
    delivery: null,
    warnings: [],
    filePrefix: 'frame_',
    filePadding: 4,
    renderConfig: { resolution: [320, 180], samples: 8, engine: 'cycles', viewTransform: 'AgX' },
    ...overrides,
  }
}

check('a store with no unfinished jobs reconciles to an empty finding list, not to a failure',
  (await studio.reconcileRenderJobs()).length === 0)

const projectA = await studio.transactions.createProject({ title: 'first', sceneSpec: productSpec, saveCheckpoint: false })
const projectB = await studio.transactions.createProject({ title: 'second', sceneSpec: productSpec, saveCheckpoint: false })
studio.renderJobs.write(runningRecord(projectA.projectId, 'render-0001'))
studio.renderJobs.write(runningRecord(projectB.projectId, 'render-0001'))

const findings = await studio.reconcileRenderJobs()
check('every unfinished job in every project is reconciled in one pass',
  findings.length === 2 &&
  findings.every(finding => finding.jobId === 'render-0001') &&
  new Set(findings.map(finding => finding.projectId)).size === 2,
  findings.map(finding => `${finding.projectId}/${finding.jobId}: ${finding.status}`))
check('and the pass hangs its findings on the instance, which is what the job surface reports',
  studio.recoveryFindings.length === 2 && studio.recoveryFindings === findings,
  studio.recoveryFindings.map(finding => finding.status))
check('a reconciled job reads as `recovering`, which is a DELIBERATE state: nobody is watching it and it can be resumed',
  studio.renderJobs.unfinishedAcross(studio.store.listProjectIds())
    .every(entry => entry.record.status === 'recovering') &&
  findings.every(finding => finding.status === 'recovering'),
  studio.renderJobs.unfinishedAcross(studio.store.listProjectIds()).map(entry => entry.record.status))
check('and reconciling it again is idempotent, because it stays visible until someone resumes it',
  (await studio.reconcileRenderJobs()).every(finding => finding.status === 'recovering'))

// ---- one unwritable job must not stop the pass ----------------------------
// A `recovering` job stays unfinished ON PURPOSE (someone may resume it), so the earlier two are
// closed here: this pass must see exactly the two jobs the case is about, or "the first write fails"
// lands on whichever job the store happens to list first.
// `cancelled` is one of the four states a `recovering` job may legally move to (the store refuses the
// others, and this test learned the table by being refused): nothing is running and nobody will resume it.
for (const entry of studio.renderJobs.unfinishedAcross(studio.store.listProjectIds())) {
  studio.renderJobs.write({ ...entry.record, status: 'cancelled' }, { previous: entry.record })
}
const projectC = await studio.transactions.createProject({ title: 'third', sceneSpec: productSpec, saveCheckpoint: false })
const projectD = await studio.transactions.createProject({ title: 'fourth', sceneSpec: productSpec, saveCheckpoint: false })
studio.renderJobs.write(runningRecord(projectC.projectId, 'render-0001'))
studio.renderJobs.write(runningRecord(projectD.projectId, 'render-0001'))

const writable = studio.renderJobs.write.bind(studio.renderJobs)
let writes = 0
studio.renderJobs.write = record => {
  writes += 1
  // The FIRST job of the pass is the one that cannot be recorded, exactly as a full volume behaves:
  // the failure is a property of the machine, not of a particular job.
  if (writes === 1) {
    const error = new Error('ENOSPC: no space left on device')
    error.code = 'ENOSPC'
    throw error
  }
  return writable(record)
}
const afterFailure = await studio.reconcileRenderJobs()
studio.renderJobs.write = writable

check('a job whose recovery cannot be WRITTEN is reported as unwritable instead of throwing',
  afterFailure.length === 2 &&
  afterFailure.filter(finding => finding.status === 'unwritable').length === 1 &&
  afterFailure.find(finding => finding.status === 'unwritable')?.notes?.[0]?.includes('ENOSPC'),
  afterFailure.map(finding => `${finding.jobId}: ${finding.status}`))
check('and the pass still reconciles the OTHER job, which is the whole point of catching it',
  afterFailure.filter(finding => finding.status !== 'unwritable').length === 1)
const unwritable = afterFailure.find(finding => finding.status === 'unwritable')
check('the unwritable job keeps its previous status on disk, because nothing could record an answer',
  studio.renderJobs.readSafe(unwritable.projectId, unwritable.jobId)?.status === 'running',
  studio.renderJobs.readSafe(unwritable.projectId, unwritable.jobId)?.status)

check('the finding shape is the one the job surface publishes, in both directions',
  afterFailure.every(finding =>
    finding.schemaVersion === 'deepblend.render-recovery/v1' &&
    typeof finding.reconciledAt === 'string' &&
    'previousStatus' in finding && 'process' in finding && 'ledger' in finding),
  Object.keys(afterFailure[0] ?? {}))

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost render jobs: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
