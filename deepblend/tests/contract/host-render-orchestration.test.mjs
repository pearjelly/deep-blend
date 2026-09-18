#!/usr/bin/env node
/**
 * The host's render orchestration: what it does around a render, not what Blender does inside one.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `renderPreview` and `renderViews` are the two entry points that turn a revision into pixels, and
 * the composition suites drive them for real — which is exactly why 84 of their lines had never run:
 * a suite with a working Blender only ever sees the happy path. What was dark is everything AROUND
 * the render, and each of those lines is a decision someone downstream depends on:
 *
 *   - a revision whose spec defines no preview profile is a CODED refusal, not a crash;
 *   - the samples budget reduces a request and SAYS SO (a silently downsampled review is a review of
 *     a different image than the one that was asked for);
 *   - the subject of the shot is reported as a WARNING when it had to be guessed from several
 *     candidates, because "we picked the biggest thing" changes how a finding should be read;
 *   - a renderer that reports success without producing bytes is `RENDER_NO_OUTPUT`, not an empty
 *     preview;
 *   - a failed preview writes a FAILED JOB RECORD before it throws, so the operator can see what was
 *     attempted after the process is gone.
 *
 * The runtime is the seam (`ctx.blenderRuntime`), so it is a stub here: the host's own store is real,
 * the revisions are real (`saveCheckpoint:false` commits a spec-only revision without Blender), and
 * the PNGs the stub hands back are real PNGs because the host COMPOSES a contact sheet out of them.
 *
 * Run standalone: `node deepblend/tests/contract/host-render-orchestration.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
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

const VIEW_PNG = encodePng(createImage(16, 16, [180, 30, 30, 255]))

// ---------------------------------------------------------------------------
// A runtime the test drives, over a real store
// ---------------------------------------------------------------------------

const calls = { compileScene: 0, renderViews: 0, renderPreview: 0 }
const runtime = {
  async resolveEngineKey() {
    return { engine: 'BLENDER_EEVEE_NEXT', blenderEngine: 'BLENDER_EEVEE_NEXT', warning: null }
  },
  async compileScene(request) {
    calls.compileScene += 1
    // The provider's contract: the caller gets a window in which to move the artifact OUT of the
    // invocation directory, because the directory is removed when this returns.
    const directory = join(request.projectRoot, 'stub-compile')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'result.blend'), 'not really a blend file')
    request.onWorkingDirectory?.({ directory })
    return {
      report: { validation: { engine: 'BLENDER_EEVEE_NEXT' }, sceneFingerprint: { totalPolygons: 1200 } },
      envelope: { warnings: [], notices: [] },
    }
  },
  async renderViews(request) {
    calls.renderViews += 1
    const pngs = {}
    const views = (request.views ?? []).map(view => {
      pngs[view.id] = VIEW_PNG
      return {
        viewId: view.id, role: view.role, cameraId: view.cameraId, frame: view.frame,
        width: 16, height: 16, engine: 'BLENDER_EEVEE_NEXT',
        outputPath: `/nonexistent/scratch/${view.id}.png`,
      }
    })
    return { envelope: { warnings: [], notices: [] }, report: { views }, pngs }
  },
  async renderPreview(request) {
    calls.renderPreview += 1
    mkdirSync(join(request.outputPath, '..'), { recursive: true })
    writeFileSync(request.outputPath, VIEW_PNG)
    return { envelope: { warnings: [], notices: [] }, report: { frame: request.frame ?? 1 } }
  },
}

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-render-orchestration-'))
const ctx = new Context()
ctx.provide('blenderRuntime', runtime)
const studio = new BlenderStudio(ctx, StudioConfig({
  workspaceRoot,
  projectsRoot: join(workspaceRoot, 'projects'),
  maxPreviewSamples: 128,
}))

const productSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))

/** A spec whose subject must be GUESSED: no camera aims at an entity and nothing is tagged. */
function anonymousSpec(spec) {
  const copy = JSON.parse(JSON.stringify(spec))
  for (const entity of copy.entities ?? []) delete entity.tags
  for (const camera of copy.cameras ?? []) {
    if (camera.targetEntityId !== undefined) {
      delete camera.targetEntityId
      camera.targetPoint = [0, 0, 0]
    }
  }
  return copy
}

// With a checkpoint: this revision can be rendered as it stands.
const withCheckpoint = await studio.transactions.createProject({
  title: 'aimed', sceneSpec: productSpec, saveCheckpoint: true,
})
// Spec-only, and its subject has to be guessed from several candidates.
const anonymous = await studio.transactions.createProject({
  title: 'anonymous', sceneSpec: anonymousSpec(productSpec), saveCheckpoint: false,
})
const projectId = withCheckpoint.projectId
const first = withCheckpoint.revision.revision
const specOnly = await studio.transactions.applyScenePatch({
  projectId, baseRevision: first, saveCheckpoint: false,
  operations: [{ op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.4, 0.02] }],
}, {})
const second = specOnly.revision.revision

check('the fixture commits a revision WITH a checkpoint using the stub runtime, and one without',
  calls.compileScene === 1 && studio.store.checkpointPath(projectId, first) !== null &&
  studio.store.checkpointPath(projectId, second) === null,
  { compiles: calls.compileScene, first: studio.store.checkpointPath(projectId, first) !== null, second: studio.store.checkpointPath(projectId, second) !== null })

// ---------------------------------------------------------------------------
// A revision with no preview profile: a coded refusal from BOTH entry points
// ---------------------------------------------------------------------------

/**
 * A store whose revision spec has no `renderProfiles.preview`.
 *
 * The product's own schema requires both profiles, so this document cannot be produced by writing a
 * SceneSpec today — it is the shape an OLDER store can have on disk, and the guard exists for exactly
 * that. Producing the state is the only way to make the guard live instead of shadowed (D130).
 */
const trimmedProject = await studio.transactions.createProject({ title: 'trimmed', sceneSpec: productSpec, saveCheckpoint: false })
const trimmedRevision = trimmedProject.revision.revision
const trimmedSpecPath = join(studio.store.revisionDirectory(trimmedProject.projectId, trimmedRevision), 'scene-spec.json')
const trimmed = JSON.parse(readFileSync(trimmedSpecPath, 'utf8'))
delete trimmed.renderProfiles.preview
writeFileSync(trimmedSpecPath, `${JSON.stringify(trimmed, null, 2)}\n`)

const noProfileViews = await studio.renderViews({ projectId: trimmedProject.projectId }).catch(cause => cause)
check('renderViews refuses a revision with no preview profile, naming the revision',
  noProfileViews instanceof BlenderError && noProfileViews.code === code('RENDER_PROFILE_MISSING') &&
  noProfileViews.detail?.revision === trimmedRevision && /defines no preview render profile/.test(noProfileViews.message),
  noProfileViews?.detail ?? noProfileViews?.message)

const noProfilePreview = await studio.renderPreview({ projectId: trimmedProject.projectId }).catch(cause => cause)
check('renderPreview refuses the same state the same way, because both go through the profile',
  noProfilePreview instanceof BlenderError && noProfilePreview.code === code('RENDER_PROFILE_MISSING') &&
  noProfilePreview.detail?.revision === trimmedRevision,
  noProfilePreview?.code)
check('and neither refusal reached the runtime: a missing profile is decided before any Blender work',
  calls.renderViews === 0 && calls.renderPreview === 0,
  { renderViews: calls.renderViews, renderPreview: calls.renderPreview })

// ---------------------------------------------------------------------------
// renderViews: the decisions around the render
// ---------------------------------------------------------------------------

const named = await studio.renderViews({
  projectId,
  revision: second,
  views: [{ id: 'three-quarter', role: 'three-quarter', cameraId: 'camera-main', frame: 60 }],
})
check('an explicit view list is rendered as given, instead of the standard plan',
  named.views.length === 1 && named.views[0].viewId === 'three-quarter' &&
  named.subjectId === 'watch-body',
  named.views.map(view => view.viewId))
check('and the PNG the runtime handed back is published as an artifact OF that revision',
  named.artifacts.some(artifact => artifact.kind === 'view' &&
    artifact.path === `revisions/${second}/previews/views/three-quarter.png`) &&
  existsSync(join(studio.store.revisionDirectory(projectId, second), 'previews', 'views', 'three-quarter.png')),
  named.artifacts.map(artifact => artifact.path))
check('the render is recorded as a job, so a later reader can see that it happened',
  named.job?.status === 'succeeded' && named.job?.action === 'render_views' && named.job?.revision === second,
  { status: named.job?.status, action: named.job?.action })
check('the contact sheet is composed from the rendered views, and its labels follow view order',
  named.previewSheets?.current?.kind === 'contact-sheet' &&
  JSON.stringify(named.previewSheets.current.views) === JSON.stringify(['three-quarter']),
  named.previewSheets?.current?.views)
// What makes the OTHER sentence in `renderPreview`'s provenance line unreachable: the resolved
// checkpoint is always replaced by the one compiled for the requested revision, so
// `resolvedCheckpoint.revision === revision` holds on every path. The branch that would say "the r0001
// checkpoint, because r0002 has none of its own" therefore cannot be produced — recorded here as a
// measurement (D125's shape) rather than left looking live.
check('a render reports the revision it OPENED, which is why the inherited-checkpoint sentence is dead code',
  named.checkpointRevision === second)

check('a render whose revision had no checkpoint of its own says which earlier one it was compiled against',
  named.warnings.some(entry => entry.message ===
    `revision ${second} has no checkpoint of its own; it was compiled from its SceneSpec for this render ` +
    `(the nearest earlier checkpoint is ${first})`),
  { checkpointRevision: named.checkpointRevision, warnings: named.warnings.map(entry => entry.message) })

const explicitTrack = await studio.renderViews({
  projectId, revision: second, track: ['watch-body'],
  views: [{ id: 'top', role: 'top', cameraId: 'camera-top', frame: 60 }],
})
check('an explicit tracked-object list is used instead of deriving it from the subject',
  JSON.stringify(explicitTrack.track) === JSON.stringify(['watch-body']),
  explicitTrack.track)

const budgeted = await studio.renderViews({
  projectId, revision: second, samples: 4096,
  views: [{ id: 'top', role: 'top', cameraId: 'camera-top', frame: 60 }],
})
check('a sample count above the budget is reduced, and the reduction is REPORTED rather than silent',
  budgeted.profile.samples === 128 &&
  budgeted.warnings.some(entry => entry.code === 'RENDER_SAMPLES_REDUCED' &&
    /reduced from 4096 to 128/.test(entry.message)),
  { samples: budgeted.profile.samples, warnings: budgeted.warnings.map(entry => entry.code) })

const guessed = await studio.renderViews({ projectId: anonymous.projectId })
check('a subject that had to be guessed from several candidates is reported as a warning',
  guessed.warnings.some(entry => /the subject was resolved to "\w+" because /.test(entry.message) &&
    Array.isArray(entry.detail?.candidates) && entry.detail.candidates.length > 1),
  guessed.warnings.map(entry => entry.message))
check('and that warning names the candidates, so the caller can overrule the guess',
  guessed.subjectId !== null && guessed.warnings.some(entry => entry.detail?.candidates?.includes(guessed.subjectId)),
  { subjectId: guessed.subjectId, warnings: guessed.warnings.map(entry => entry.detail?.candidates) })

// ---- a renderer that succeeds without bytes -------------------------------
const silentRuntime = runtime.renderViews
runtime.renderViews = async request => ({ envelope: {}, report: { views: (request.views ?? []).map(view => ({ viewId: view.id, outputPath: '/nonexistent.png' })) }, pngs: {} })
const noBytes = await studio.renderViews({
  projectId, revision: second, views: [{ id: 'top', role: 'top', cameraId: 'camera-top', frame: 60 }],
}).catch(cause => cause)
runtime.renderViews = silentRuntime
check('a renderer that reports success without readable bytes is RENDER_NO_OUTPUT, not an empty preview',
  noBytes instanceof BlenderError && noBytes.code === code('RENDER_NO_OUTPUT') &&
  noBytes.detail?.viewId === 'top',
  noBytes?.detail ?? noBytes?.message)

// ---- a runtime that throws something unrecognized -------------------------
runtime.renderViews = async () => { throw new Error('the renderer died without a code') }
const wrapped = await studio.renderViews({
  projectId, revision: second, views: [{ id: 'top', role: 'top', cameraId: 'camera-top', frame: 60 }],
}).catch(cause => cause)
runtime.renderViews = silentRuntime
check('an unrecognized failure from the renderer becomes a coded SCRIPT_ERROR carrying its message',
  wrapped instanceof BlenderError && wrapped.code === code('SCRIPT_ERROR') &&
  wrapped.message === 'the renderer died without a code',
  wrapped?.code ?? wrapped?.message)
const wrappedJob = wrapped?.detail?.jobId === undefined
  ? null
  : await studio.getJob({ projectId, jobId: wrapped.detail.jobId }).catch(() => null)
check('and a failed view render leaves its own failed record, named by the error it throws',
  wrappedJob?.status === 'failed' && wrappedJob?.action === 'render_views' &&
  wrappedJob?.errorCode === code('SCRIPT_ERROR') && wrappedJob?.revision === second,
  wrappedJob ?? wrapped?.detail)

// A preview profile that names no sample count: then the renderer's own default is used, and the
// budget has nothing to reduce. This is the other arm of the ternary, and it is a state a spec can
// legitimately be in (the sample count is optional).
const samplelessProject = await studio.transactions.createProject({ title: 'sampleless', sceneSpec: productSpec, saveCheckpoint: false })
const samplelessSpecPath = join(studio.store.revisionDirectory(samplelessProject.projectId, samplelessProject.revision.revision), 'scene-spec.json')
const sampleless = JSON.parse(readFileSync(samplelessSpecPath, 'utf8'))
delete sampleless.renderProfiles.preview.samples
delete sampleless.renderProfiles.preview.maxSamplesBudget
writeFileSync(samplelessSpecPath, `${JSON.stringify(sampleless, null, 2)}\n`)

// `renderPreview`, not `renderViews`: the ternary this covers lives in the preview path, which
// computes its own ceiling. (The first version of this case called `renderViews` and left the line just
// as dark — the two methods look alike and are not the same code.)
let samplesSeenByRuntime
const samplingRuntime = runtime.renderPreview
runtime.renderPreview = async request => {
  samplesSeenByRuntime = request.samples
  return samplingRuntime(request)
}
const unbudgeted = await studio.renderPreview({ projectId: samplelessProject.projectId })
runtime.renderPreview = samplingRuntime
check('a profile that names no sample count asks the renderer for NOTHING, instead of inventing a budget',
  samplesSeenByRuntime === undefined &&
  // `null`, not undefined: the canonical record says "the renderer's report did not carry a sample
  // count" — the host does not substitute the budget it would have used.
  unbudgeted.profile.samples === null &&
  !unbudgeted.warnings.some(entry => entry.code === 'RENDER_SAMPLES_REDUCED'),
  { asked: samplesSeenByRuntime, reported: unbudgeted.profile.samples, warnings: unbudgeted.warnings.map(entry => entry.code) })

// ---------------------------------------------------------------------------
// renderPreview: the same decisions, plus the job record a failure must leave
// ---------------------------------------------------------------------------

const preview = await studio.renderPreview({ projectId, revision: second, cameraId: 'camera-main', frame: 60 })
// The preview's provenance line is a sentence a person reads, and the report it is built from is the
// renderer's. This case's stub reports NO size and NO engine — a report that omits them, which the
// provider does not, but which must not print "nullxnull" if it ever happens.
check('the preview says WHERE its pixels came from without inventing what the renderer did not report',
  preview.warnings.some(entry => entry.message ===
    `preview of revision ${second}: frame 60, size not reported, engine not reported`),
  preview.warnings.map(entry => entry.message))
check('a preview renders, publishes the image into the revision, and reports which revision it wrote into',
  preview.revision === second &&
  preview.artifacts.some(entry => entry.path === `revisions/${second}/previews/frame60-camera-main.png`) &&
  preview.revisionPreviews.some(entry => entry.path === `revisions/${second}/previews/frame60-camera-main.png`) &&
  existsSync(join(studio.store.revisionDirectory(projectId, second), 'previews', 'frame60-camera-main.png')),
  { revision: preview.revision, artifacts: preview.artifacts.map(entry => entry.path) })
check('and it records the render as a succeeded job too',
  preview.job?.status === 'succeeded' && preview.job?.action === 'render_preview',
  { status: preview.job?.status, action: preview.job?.action })
check('the staging directory a preview renders into is gone afterwards, so nothing is republished twice',
  !existsSync(join(studio.store.revisionDirectory(projectId, second), '.render-staging')))

/**
 * A preview stub that behaves like a renderer: it either WRITES the image or it does not.
 *
 * The first version of the notices case forgot to write it, and the host answered RENDER_NO_OUTPUT —
 * which is the guard doing its job, not a test failure to work around. The stub is a parameterised
 * one now so each case differs in exactly one way.
 */
const previewStub = ({ writeImage = true, envelope = {}, report = {} } = {}) => async request => {
  if (writeImage) {
    mkdirSync(join(request.outputPath, '..'), { recursive: true })
    writeFileSync(request.outputPath, VIEW_PNG)
  }
  return { envelope, report: { frame: request.frame ?? 1, ...report } }
}

runtime.renderPreview = previewStub({
  envelope: { notices: [{ code: 'RENDER_NOTICE', message: 'the renderer moved the camera to fit the subject' }] },
  report: { width: 16, height: 16, engine: 'BLENDER_EEVEE_NEXT' },
})
const noticed = await studio.renderPreview({ projectId, revision: second, cameraId: 'camera-main', frame: 60 })
check('when the report DOES carry them, the same line states what was measured',
  noticed.warnings.some(entry => entry.message ===
    `preview of revision ${second}: frame 60, 16x16, engine BLENDER_EEVEE_NEXT`),
  noticed.warnings.map(entry => entry.message))
check('notices from the renderer reach the caller as warnings, so a decision is not lost',
  noticed.warnings.some(entry => entry.message === 'the renderer moved the camera to fit the subject'),
  noticed.warnings.map(entry => entry.message))

runtime.renderPreview = previewStub({ writeImage: false })
const noImage = await studio.renderPreview({ projectId, revision: second, cameraId: 'camera-main', frame: 60 }).catch(cause => cause)
check('a preview that reports success without writing an image is RENDER_NO_OUTPUT',
  noImage instanceof BlenderError && noImage.code === code('RENDER_NO_OUTPUT') &&
  noImage.detail?.outputPath !== undefined,
  noImage?.detail ?? noImage?.message)

runtime.renderPreview = async () => { throw new Error('the preview process was killed') }
const failed = await studio.renderPreview({ projectId, revision: second, cameraId: 'camera-main', frame: 60 }).catch(cause => cause)
// Through the id the FAILURE carries, because that is the only handle a caller has: this record is an
// attempt log under `jobs/`, and `listJobs` lists render jobs under `renders/`. Writing this check is
// what found that the record was unreachable — the error named the failure and not the record.
const failedJob = failed?.detail?.jobId === undefined
  ? null
  : await studio.getJob({ projectId, jobId: failed.detail.jobId }).catch(() => null)
check('a failed preview leaves a FAILED JOB RECORD, and the error names it so it can be read back',
  failedJob !== null && failedJob.jobId === failed.detail.jobId &&
  failedJob.status === 'failed' && failedJob.errorCode === code('SCRIPT_ERROR') &&
  failedJob.message === 'the preview process was killed' && failedJob.revision === second,
  failedJob ?? { detail: failed?.detail, message: failed?.message })
check('the failed call reaches the runtime once and reports no success anywhere in the job list',
  !(await studio.listJobs({ projectId })).jobs.some(job => job.jobId === failed.detail?.jobId),
  (await studio.listJobs({ projectId })).jobs.map(job => `${job.action}:${job.status}`))
check('and it still throws the coded error, so the caller branches on a code and not on a stack',
  failed instanceof BlenderError && failed.code === code('SCRIPT_ERROR'),
  failed?.code)
check('the failed render leaves no half-written artifact behind',
  !existsSync(join(studio.store.revisionDirectory(projectId, second), '.render-staging')))

runtime.renderPreview = previewStub()

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// A whole review round: the reviewer port, and what is kept of its answer
// ---------------------------------------------------------------------------
//
// `visualReview` is the M2 loop's entry point: render the views, measure them, compose and persist the
// contact sheet, score, and — only when asked — consult the vision reviewer. Its doc says the port is
// injectable "for tests", and that is what makes the interesting half drivable: not the render, but what
// the product DOES with an answer, including the parts it refuses to believe. A finding that names a view
// the render never produced must be REJECTED rather than counted, because a reviewer's word is only worth
// as much as the evidence under it.

const reviewedProject = await studio.transactions.createProject({
  title: 'review-round', sceneSpec: productSpec, saveCheckpoint: true,
})
// THIS REVIEW RUNS FIRST, and that is the point: it is round 0, so the revision's artifact index holds
// [round 0, round 2] in that order. A QA record that returned `reviews[0]` would answer with the OLDER round —
// and the first version of this case reviewed round 2 first, which made the two implementations
// indistinguishable (the mutation survived it).
//
// The default is "do not spend a model call", and the way to check a promise about NOT doing something is
// a port that would fail loudly if it were consulted.
let consultedByDefault = false
const unconsulted = await studio.visualReview({
  projectId: reviewedProject.projectId,
  reviewer: async () => { consultedByDefault = true; throw new Error('the reviewer must not be called') },
})
// (its assertion waits until round 2 has been rendered, so the two scores can be compared)

let consulted = null
const reviewRound = await studio.visualReview({
  projectId: reviewedProject.projectId,
  iteration: 2,
  consultReviewer: true,
  reviewer: async request => {
    consulted = request
    const firstView = request.review.perView[0]?.viewId ?? 'none'
    return {
      model: 'stub-vision', provider: 'stub-provider', note: 'the subject is centred',
      raw: 'the model said so',
      findings: [
        { category: 'composition', viewId: firstView, severity: 'major', evidence: 'the backdrop is clipped at the left edge' },
        { category: 'composition', viewId: 'no-such-view', severity: 'critical', evidence: 'a view that was never rendered' },
      ],
      operations: [{ op: 'camera.update', cameraId: 'x', patch: {} }],
    }
  },
})
check('the reviewer port is handed the review, the sheet BYTES, the views and the iteration',
  consulted !== null && Buffer.isBuffer(consulted.sheetPng) &&
  consulted.sheetPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
  Array.isArray(consulted.views) && consulted.views.length === reviewRound.perView.length &&
  consulted.iteration === 2 && consulted.review.score === reviewRound.score,
  { views: consulted?.views?.length, iteration: consulted?.iteration, sheetBytes: consulted?.sheetPng?.length })
check('a finding that names a view the render never produced is REJECTED with its reason, and the rest are kept',
  reviewRound.reported.length === 1 && reviewRound.reported[0].viewId === consulted.review.perView[0].viewId &&
  reviewRound.reported[0].code === 'COMPOSITION_REPORTED' && reviewRound.rejected.length === 1 &&
  reviewRound.rejected[0].reason === 'unknown viewId "no-such-view"',
  { reported: reviewRound.reported.map(entry => entry.viewId), rejected: reviewRound.rejected.map(entry => entry.reason) })
check('a review that was not asked for a second opinion does not consult the reviewer at all',
  consultedByDefault === false && unconsulted.reviewer === undefined && unconsulted.score === reviewRound.score,
  { consultedByDefault, reviewer: unconsulted.reviewer ?? null, round0: unconsulted.score, round2: reviewRound.score })

check('what the reviewer SAID is kept as its own record, with the model, the note and the operations counted',
  reviewRound.reviewer?.model === 'stub-vision' && reviewRound.reviewer?.provider === 'stub-provider' &&
  reviewRound.reviewer?.note === 'the subject is centred' && reviewRound.reviewer?.raw === 'the model said so' &&
  reviewRound.reviewer?.proposedOperations === 1 && reviewRound.reviewer?.error === null &&
  reviewRound.suggestedOperations.length === 1,
  reviewRound.reviewer)

// The sheet is an artifact OF the revision — it is what THIS scene state looked like — so it is written
// into the revision and indexed there, and the review record lands beside it.
const revisionDirectory = studio.store.revisionDirectory(reviewedProject.projectId, reviewedProject.revision.revision)
check('the sheet and the review record are persisted under the revision they belong to',
  existsSync(join(revisionDirectory, 'contact-sheets', 'round-2.png')) &&
  existsSync(join(revisionDirectory, 'visual-reviews', 'round-2.json')) &&
  existsSync(join(revisionDirectory, 'contact-sheets', 'round-0.png')),
  { round2Sheet: existsSync(join(revisionDirectory, 'contact-sheets', 'round-2.png')), round0Sheet: existsSync(join(revisionDirectory, 'contact-sheets', 'round-0.png')) })

// ---------------------------------------------------------------------------
// The QA record picks the NEWEST review, and a preview says where its checkpoint came from
// ---------------------------------------------------------------------------
//
// Two reviews of one revision is the normal case — the loop renders a round, patches, renders another — and the
// QA record is supposed to answer "how does this revision look NOW". It therefore has to select by ITERATION
// rather than by whatever order the artifact index happens to list, and then read that record from disk.
const qaRecord = await studio.getQaRecord({ projectId: reviewedProject.projectId, revision: reviewedProject.revision.revision })
check('the QA record carries the NEWEST round of a revision that was reviewed twice',
  qaRecord.review !== null && qaRecord.review?.iteration === 2 &&
  qaRecord.review?.score === reviewRound.score,
  { iteration: qaRecord.review?.iteration, score: qaRecord.review?.score, expected: reviewRound.score })
check('and it reports the review’s own record rather than a summary built from the artifact index',
  Array.isArray(qaRecord.review?.perView) && qaRecord.review.perView.length > 0 &&
  qaRecord.review?.reported !== undefined,
  Object.keys(qaRecord.review ?? {}))

// A revision with no checkpoint of its own is COMPILED for the render, and when an earlier revision HAS one the
// warning has to say which one it fell back to — that sentence is the only place a reader learns that the
// pixels came from a spec compiled now rather than from the `.blend` the revision was committed with.
const previewProject = await studio.transactions.createProject({
  title: 'compiled-for-preview', sceneSpec: productSpec, saveCheckpoint: true,
})
const secondRevision = await studio.transactions.applyScenePatch({
  projectId: previewProject.projectId,
  baseRevision: previewProject.revision.revision,
  operations: [{ op: 'entity.visibility.set', entityId: productSpec.entities[0].id, visible: false }],
  saveCheckpoint: false,
})
const compiledPreview = await studio.renderPreview({
  projectId: previewProject.projectId, revision: secondRevision.revision.revision,
})
// The provenance sentence itself is asserted, not only the compiler warning: it is the line whose earlier
// version spliced a word into the middle and printed "rendered from the revisioncheckpoint" in the ordinary
// case, and it is now one whole sentence with no unreachable second arm.
check('the preview’s own provenance line names the revision it rendered, as one whole sentence',
  compiledPreview.warnings.some(entry => entry.code === 'SCENE_COMPILER_DECISION' &&
    entry.message === `revision ${secondRevision.revision.revision} has no checkpoint of its own; it was compiled from its ` +
      `SceneSpec for this render (the nearest earlier checkpoint is ${previewProject.revision.revision})`),
  compiledPreview.warnings.some(entry => entry.message === `preview of revision ${secondRevision.revision.revision}: ` +
    'frame 1, size not reported, engine not reported') &&
  !compiledPreview.warnings.some(entry => entry.message.includes('revisioncheckpoint')),
  compiledPreview.warnings.map(entry => entry.message))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost render orchestration: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
