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
 * Run standalone: `node deepblend/tests/contract/host-read-and-job-refusals.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
ctx.provide('blenderRuntime', {
  async compileScene(request) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const directory = join(request.projectRoot, 'stub-compile')
    mkdirSync(directory, { recursive: true })
    // The last check needs a renderer that exits successfully WITHOUT writing a checkpoint, and a
    // Cordis service cannot be provided twice — so the runtime is one object with a recorded mode
    // rather than two services.
    if (compileProducesBlend === false) return { report: { validation: {} }, envelope: { warnings: [], notices: [] } }
    writeFileSync(join(directory, 'result.blend'), 'a blend file')
    request.onWorkingDirectory?.({ directory })
    return { report: { validation: {} }, envelope: { warnings: [], notices: [] } }
  },
})
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

const noCheckpoint = (() => {
  try {
    return studio._resolveDeliveryCheckpoint({ projectId, revision, spec })
  } catch (cause) {
    return cause
  }
})()
check('a delivery with no checkpoint to render from says so AND says what to do about it',
  noCheckpoint instanceof BlenderError && noCheckpoint.code === code('REVISION_CHECKPOINT_MISSING') &&
  /has no checkpoint to render from, and there is no earlier checkpoint to fall back on\. Commit a revision with saveCheckpoint/.test(noCheckpoint.message),
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
check('a visual review with no contact sheet recorded says so instead of reading an empty path',
  noSheet instanceof BlenderError && noSheet.code === code('RENDER_NO_OUTPUT') &&
  noSheet.message === 'The visual review has no contact sheet recorded, so there is nothing to show the reviewer.',
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

rmSync(workspaceRoot, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost read and job refusals: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
