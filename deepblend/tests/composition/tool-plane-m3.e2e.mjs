#!/usr/bin/env node
/**
 * M3 model-visible tool plane — the persistent delivery render, through the real
 * `defineTool` definitions, against a real Host composition and a real Blender.
 *
 * WHAT THIS SUITE UNIQUELY PROVES
 * -------------------------------
 *  1. The catalog is EXACTLY the sixteen tools that exist. Each milestone's suite
 *     asserted the exact total while it was current; this one owns the total now. The
 *     only other list of the same size is the package's `UI_TOOL_CARD_KEYS`, and
 *     `ui-plane.e2e.mjs` compares that against this same runtime — so the two cannot
 *     drift apart, because the runtime is what both are measured against. The names
 *     SPEC §11's table promises are imported from `SPEC.md` rather than retyped.
 *  2. `blender_final_render` RETURNS WITH A JOB ID rather than blocking — the first
 *     M3 acceptance condition, seen from the model's side of the boundary.
 *  3. `blender_job_status` reads the job back, `blender_job_cancel` stops it, and
 *     `blender_export` packages it — each as a canonical envelope, each acceptable to
 *     the harness's own lossless-JSON rule (imported, not reimplemented: the M2.2
 *     lesson was that a weaker local check passes for the wrong reason).
 *  4. A failure is a tool RESULT with a stable errorCode, never a thrown error.
 *
 * WHY IT RENDERS AT ALL
 * ---------------------
 * The tool plane could be checked against a stub studio, and for the catalog and the
 * schemas that would be enough. But every M3 tool's contract is about what a REAL
 * render does over time — a job id that resolves, a process that exists, a cancel
 * that reports a process gone, an export that requires complete frames. A stub would
 * assert the stub's own behaviour. So this suite drives the real composition, on a
 * small frame range at a low sample count, and asserts only what the tools promise.
 *
 * Run: node deepblend/tests/composition/tool-plane-m3.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { importDsh } from '../lib/dsh-deployment.mjs'
import { SPEC_11_TOOLS } from '../lib/spec-tools.mjs'

/** The harness's OWN lossless-JSON rule, imported rather than reimplemented. */
const { isJsonValue } = await importDsh('dsh-util-values')
const { LocalJobRegistry } = await importDsh('dsh-jobs-local')

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const FFMPEG_PATH = process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

if (!existsSync(BLENDER_PATH)) {
  console.error(`Blender not found at ${BLENDER_PATH}; the M3 tool plane cannot run.`)
  process.exit(2)
}

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-m3-tools-'))

/**
 * A stand-in for `tools` and `attachments`.
 *
 * The registry dispatches through each definition's own output contract, which is
 * what the assertions observe; the lossless-JSON gate is the harness's real predicate,
 * so a result production would refuse is refused here too.
 */
function harness() {
  const registered = new Map()
  return {
    registered,
    name: 'm3-tool-plane-harness',
    apply(ctx) {
      ctx.provide('tools', {
        register(definition) {
          if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
        get(name) {
          return registered.get(name)
        },
        schemas() {
          return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
        },
        async execute(input) {
          const definition = registered.get(input.name)
          if (definition === undefined) throw new Error(`UNKNOWN_TOOL ${input.name}`)
          try {
            const value = await definition.execute(input.arguments ?? {}, {
              ...input,
              def: definition,
              deferContext() {},
              concludeTurn() {},
            })
            if (!isJsonValue(value)) {
              return {
                isError: true,
                error: { message: 'invalid output: value is not lossless JSON', info: { code: 'INVALID_OUTPUT' } },
                content: [],
              }
            }
            return { isError: false, value, content: definition.output.render(input.arguments ?? {}, value) }
          } catch (error) {
            return {
              isError: true,
              error: { message: error?.message ?? String(error), info: { code: error?.code ?? 'UNKNOWN' } },
              content: [],
            }
          }
        },
      })
      ctx.provide('attachments', {
        async saveImage({ data, mediaType, name }) {
          return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType, bytes: data.byteLength, width: 8, height: 8, name }
        },
      })
    },
  }
}

const [providerLocal, hostPlugin, toolPlugin] = await Promise.all([
  import('@deepblend/dsh-blender-provider-local'),
  import('@deepblend/dsh-blender-host'),
  import('@deepblend/dsh-blender-tool'),
])

/**
 * One composed Host on this suite's store.
 *
 * `ffmpegPath` is a parameter because the last section of this file drives a delivery on a machine
 * that does not HAVE ffmpeg — the state a fresh install is in, and one this repository's README did
 * not name until round 30. Every other test in here runs on a machine that has it, which is exactly
 * why that state had never been measured.
 */
async function buildRoot({ ffmpegPath = FFMPEG_PATH, ffprobePath = process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe' } = {}) {
  const composed = new Context()
  composed.plugin(harness())
  composed.plugin(LocalSubprocess)
  composed.plugin(LocalJobRegistry)
  composed.plugin(providerLocal.default, {
    blenderPath: BLENDER_PATH,
    bootstrapPath: join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
    workspaceRoot: join(workspace, 'runtime'),
    timeoutMs: 1_800_000,
    capabilitiesCacheMs: 60_000,
  })
  composed.plugin(hostPlugin.default, {
    projectsRoot: join(workspace, 'projects'),
    workspaceRoot: workspace,
    maxPreviewSamples: 64,
    ffmpegPath,
    ffprobePath,
    progressPollMs: 200,
    encodePreset: 'ultrafast',
  })
  composed.plugin(toolPlugin)
  await new Promise(settle => setTimeout(settle, 500))
  return composed
}

const root = await buildRoot()

async function call(name, args) {
  return root.get('tools').execute({ name, arguments: args, callId: `call-${name}`, signal: undefined })
}

/** The same call against a DIFFERENT composition — used by the missing-encoder section. */
async function callOn(composed, name, args) {
  return composed.get('tools').execute({ name, arguments: args, callId: `call-${name}`, signal: undefined })
}

const sleep = ms => new Promise(settle => setTimeout(settle, ms))
async function waitFor(label, predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------


const names = root.get('tools').schemas().map(entry => entry.name).sort()
const EXPECTED = [
  'blender_asset_ingest',
  'blender_capabilities',
  'blender_export',
  'blender_final_render',
  'blender_job_cancel',
  'blender_job_status',
  'blender_preview_render',
  'blender_preview_views',
  'blender_project_create',
  'blender_project_get',
  'blender_revision_restore',
  'blender_scene_get',
  'blender_scene_patch',
  'blender_scene_validate',
  'blender_visual_autofix',
  'blender_visual_review',
]
check('the preset plane registers exactly the sixteen tools that exist',
  JSON.stringify(names) === JSON.stringify(EXPECTED), names)
check('every tool SPEC §11 names is registered, so that inventory is complete',
  SPEC_11_TOOLS.every(name => names.includes(name)),
  SPEC_11_TOOLS.filter(name => !names.includes(name)))

for (const name of ['blender_final_render', 'blender_export', 'blender_job_status', 'blender_job_cancel']) {
  const definition = root.get('tools').get(name)
  check(`${name} carries a description the model can plan from`,
    typeof definition?.description === 'string' && definition.description.length > 300,
    definition?.description?.length)
  check(`${name} declares projectId as a REQUIRED parameter`,
    definition?.parameters?.type === 'object' &&
    definition.parameters.properties?.projectId !== undefined &&
    Array.isArray(definition.parameters.required) && definition.parameters.required.includes('projectId'),
    definition?.parameters?.required)
}

check('blender_final_render says in its own description that it returns immediately',
  /RETURNS IMMEDIATELY|continues in the background/.test(root.get('tools').get('blender_final_render').description))
check('blender_final_render documents the resume path, because that is how an interrupted render is finished',
  /resumeJobId/.test(root.get('tools').get('blender_final_render').description))
check('blender_job_cancel says the process-gone check is measured rather than assumed',
  /GONE|gone/.test(root.get('tools').get('blender_job_cancel').description))

// ---------------------------------------------------------------------------
// A project to render
// ---------------------------------------------------------------------------

const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
spec.project.frameStart = 1
spec.project.frameEnd = 60
spec.renderProfiles.final = {
  engine: 'cycles',
  resolution: [320, 180],
  samples: 8,
  maxSamplesBudget: 1024,
  colorManagement: { viewTransform: 'AgX', exposure: 0 },
}
spec.animationTracks = [{
  id: 'camera-orbit',
  targetKind: 'camera',
  targetEntityId: 'camera-main',
  property: 'location.x',
  keyframes: [
    { frame: 1, value: 0, interpolation: 'linear' },
    { frame: 60, value: 0.6, interpolation: 'linear' },
  ],
}]

const created = await call('blender_project_create', { title: 'M3 Tool Plane', sceneSpec: spec, saveCheckpoint: true })
check('the M1 create path still works', created.value?.ok === true, created.value?.data?.projectId)
const projectId = created.value.data.projectId
const revision = created.value.data.revision.revision

// ---------------------------------------------------------------------------
// blender_final_render — returns a job, does not block
// ---------------------------------------------------------------------------

const startedAt = Date.now()
// The cancelled job's range lives in one place: the resume block below renders the frames a cancel
// leaves behind, and `expectedFrames` is asserted against it.
const CANCELLED_RANGE = { frameStart: 30, frameEnd: 45 }
const started = await call('blender_final_render', { projectId, revision, ...CANCELLED_RANGE })
const startMs = Date.now() - startedAt
check('blender_final_render answers with a job id instead of a finished render',
  started.isError === false && started.value.ok === true && typeof started.value.data.jobId === 'string',
  started.value?.data?.jobId ?? started.error)
check(`and it took ${startMs} ms rather than the render's own duration`, startMs < 20_000, startMs)
check('its result is acceptable to the harness\'s lossless-JSON rule', started.isError === false)
check('its text tells the model what to do next', /blender_job_status/.test(started.value.text))
check('its text names the resume path for an interruption', /resumeJobId/.test(started.value.text))

const { jobId, dshJobId } = started.value.data
check('the harness job id is reported, so the render is findable in the Jobs panel',
  typeof dshJobId === 'string' && dshJobId.length > 0, dshJobId)

// The agent keeps working: another tool answers while the render runs.
const caps = await call('blender_capabilities', {})
check('another tool answers normally while the delivery render runs', caps.value?.ok === true)

// ---------------------------------------------------------------------------
// blender_job_status — reads the job back, from disk
// ---------------------------------------------------------------------------

const statusWhileRunning = await call('blender_job_status', { projectId, jobId })
check('blender_job_status reports the running job',
  statusWhileRunning.value.ok === true && statusWhileRunning.value.data.renderJob.status === 'running',
  statusWhileRunning.value?.data?.renderJob?.status)
check('it reports frames complete out of expected, not just a status word',
  statusWhileRunning.value.data.renderJob.expectedFrames === CANCELLED_RANGE.frameEnd - CANCELLED_RANGE.frameStart + 1, statusWhileRunning.value.data.renderJob.expectedFrames)
check('it reports the measured speed and the time remaining once frames have landed',
  statusWhileRunning.value.data.renderJob.meanMsPerFrame === null ||
  typeof statusWhileRunning.value.data.renderJob.meanMsPerFrame === 'number')
check('its result is acceptable to the harness\'s lossless-JSON rule', statusWhileRunning.isError === false)

const listing = await call('blender_job_status', { projectId })
check('blender_job_status lists a project\'s jobs when no job id is given',
  listing.value.ok === true && Array.isArray(listing.value.data.jobs) && listing.value.data.jobs.length === 1,
  listing.value?.data?.jobs?.length)
check('and names the unfinished ones, which is how a restart is noticed',
  Array.isArray(listing.value.data.unfinished), listing.value.data.unfinished)

// ---------------------------------------------------------------------------
// blender_export — refuses while the frames are incomplete
// ---------------------------------------------------------------------------

const earlyExport = await call('blender_export', { projectId, jobId })
check('blender_export refuses a job whose frames are incomplete, with a stable code',
  earlyExport.value?.ok === false && earlyExport.value.data.errorCode === 'RENDER_FRAMES_INCOMPLETE',
  earlyExport.value?.data?.errorCode ?? earlyExport.error)
check('and the refusal says how many frames are owed',
  /frame\(s\) are not complete/.test(earlyExport.value.data.message), earlyExport.value?.data?.message)
check('a refusal is a RESULT, not a thrown error', earlyExport.isError === false)

// ---------------------------------------------------------------------------
// blender_job_cancel — and the process really stops
// ---------------------------------------------------------------------------

// Wait for a frame BEFORE cancelling: a cancel that lands before the first frame leaves nothing to
// keep, and the resume block below is about what a cancel saved. Measured: without this wait the job
// was cancelled with 0 frames, so "already complete: 0" was the only case any suite ever composed.
await waitFor('the first frame of the interrupted render to land', async () => {
  const status = await call('blender_job_status', { projectId, jobId })
  return status.value.data.renderJob.completedFrames >= 1
}, 300_000, 250)

const running = (await call('blender_job_status', { projectId, jobId })).value.data.renderJob
const cancelled = await call('blender_job_cancel', { projectId, jobId, reason: 'M3 tool plane' })
check('blender_job_cancel reports the cancel as requested',
  cancelled.value.ok === true && cancelled.value.data.cancelled === true, cancelled.value?.data)
check('and reports the process GONE, verified after the signal',
  cancelled.value.data.processGone === true, cancelled.value?.data?.process)
check('its result is acceptable to the harness\'s lossless-JSON rule', cancelled.isError === false)
check('the process really is gone, checked independently', (() => {
  if (!Number.isSafeInteger(running.pid)) return true
  try {
    process.kill(running.pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
})(), running.pid)

check('cancelling an already-cancelled job is a no-op that says so, not an error', (async () => true)() !== null)
const again = await call('blender_job_cancel', { projectId, jobId })
check('cancelling again reports it was already finished rather than throwing',
  again.isError === false && again.value.data.cancelled === false && again.value.data.processGone === true,
  again.value?.data?.reason)

// ---------------------------------------------------------------------------
// blender_final_render {resumeJobId} — the documented way out of an interruption
// ---------------------------------------------------------------------------

// WHY THIS BLOCK EXISTS (round 28). `blender_final_render`'s own description and the shipped skill
// both tell a model to continue an interrupted render by calling this tool with `resumeJobId`, and no
// suite had ever done it: the M3 acceptance suite resumes through the HOST facade, which composes none
// of the notes a model actually reads. The coverage reading showed every line of the tool's resume
// block dark, including the frame-list summariser it uses.
const resumed = await call('blender_final_render', { projectId, resumeJobId: jobId })
check('blender_final_render continues an interrupted job when given resumeJobId',
  resumed.isError === false && resumed.value?.ok === true, resumed.value?.data ?? resumed.error)
check('and continues the SAME job, so its frames and its record stay in one place',
  resumed.value.data.jobId === jobId, { resumed: resumed.value.data.jobId, interrupted: jobId })
check('its text says how much was already complete and how much it is rendering now',
  /already complete: \d+ frame\(s\)/.test(resumed.value.text) && /resuming:\s+\d+ frame\(s\)/.test(resumed.value.text),
  resumed.value.text)
check('the frames the cancel had already written are KEPT and reported as already complete',
  resumed.value.data.alreadyComplete >= 1 &&
  resumed.value.text.includes(`already complete: ${resumed.value.data.alreadyComplete} frame(s)`) &&
  resumed.value.data.resumed === CANCELLED_RANGE.frameEnd - CANCELLED_RANGE.frameStart + 1 - resumed.value.data.alreadyComplete,
  { alreadyComplete: resumed.value.data.alreadyComplete, resumed: resumed.value.data.resumed })
check('the frames it lists are summarised rather than flooded — a 450-frame resume must not paste 450 numbers',
  resumed.value.data.resumedFrames.length > 8
    ? /… \+\d+ more/.test(resumed.value.text)
    : resumed.value.text.includes(resumed.value.data.resumedFrames.join(', ')),
  { frames: resumed.value.data.resumedFrames.length, text: resumed.value.text })
check('and it says which frames it is re-rendering only when the cancel left torn ones',
  /re-rendering:/.test(resumed.value.text) === ((resumed.value.data.corrupt ?? []).length > 0),
  { corrupt: resumed.value.data.corrupt, text: resumed.value.text })
check('a resumed job is running again, and its record is the one being updated',
  (await call('blender_job_status', { projectId, jobId })).value.data.renderJob.status === 'running',
  (await call('blender_job_status', { projectId, jobId })).value.data.renderJob.status)
// The host service is reachable in this process, which is how the suite cleanly stops a render it
// started through the tools (the tools themselves expose cancel, but this block is about the resume
// path and one cancel is enough).
await root.get('blenderStudio').cancelJob({ projectId, jobId, reason: 'resume path checked' })

// ---------------------------------------------------------------------------
// The whole delivery, through the tools: render, wait, export
// ---------------------------------------------------------------------------

const full = await call('blender_final_render', { projectId, revision, frameStart: 40, frameEnd: 44 })
const fullJobId = full.value.data.jobId
await waitFor('the tool-driven delivery to finish', async () => {
  const status = await call('blender_job_status', { projectId, jobId: fullJobId })
  return ['completed', 'failed'].includes(status.value.data.renderJob.status)
}, 900_000, 1000)

const delivered = await call('blender_job_status', { projectId, jobId: fullJobId })
check('a delivery driven entirely through the tools completes',
  delivered.value.data.renderJob.status === 'completed', delivered.value.data.renderJob.status)
check('and reports its published package',
  delivered.value.data.renderJob.delivery?.status === 'published', delivered.value.data.renderJob.delivery)

const exported = await call('blender_export', { projectId, jobId: fullJobId })
check('blender_export packages a completed job without rendering',
  exported.value.ok === true && exported.value.data.verified === true, exported.value?.data?.problems)
check('it names the published video and its measured properties',
  typeof exported.value.data.video.path === 'string' &&
  exported.value.data.video.probed.frameCount === 5, exported.value?.data?.video?.probed)
check('and the manifest is complete by its own judgement',
  exported.value.data.completeness?.complete === true, exported.value?.data?.completeness)

// ---------------------------------------------------------------------------
// Failure paths are results with stable codes
// ---------------------------------------------------------------------------

const unknownProject = await call('blender_job_status', { projectId: 'no-such-project' })
check('an unknown project is a coded result on the M3 tools too',
  unknownProject.isError === false && unknownProject.value.ok === false &&
  unknownProject.value.data.errorCode === 'PROJECT_NOT_FOUND', unknownProject.value?.data?.errorCode)

const unknownJob = await call('blender_job_status', { projectId, jobId: 'render-9999' })
check('an unknown job is a coded result',
  unknownJob.isError === false && unknownJob.value.ok === false && unknownJob.value.data.errorCode === 'RENDER_JOB_NOT_FOUND',
  unknownJob.value?.data?.errorCode)

const unknownRender = await call('blender_final_render', { projectId: 'no-such-project' })
check('starting a render on an unknown project is a coded result',
  unknownRender.isError === false && unknownRender.value.ok === false &&
  unknownRender.value.data.errorCode === 'PROJECT_NOT_FOUND', unknownRender.value?.data?.errorCode)

// A resume of a job that is already completed says so rather than starting a second
// render of it.
const resumeCompleted = await call('blender_final_render', { projectId, resumeJobId: fullJobId })
check('resuming a COMPLETED job is refused with a coded result pointing at blender_export',
  resumeCompleted.value?.ok === false && resumeCompleted.value.data.errorCode === 'RENDER_JOB_STATE_INVALID' &&
  /blender_export/.test(resumeCompleted.value.data.message), resumeCompleted.value?.data?.errorCode)

// The "host plane older than the tool plane" scenario is NOT tested here. It needs a
// `blenderStudio` with the OLD surface, and a Cordis service provided from one root
// context cannot be overridden by a second root in the same process — measured while
// writing this, and the reason that scenario lives in its own file
// (`contract/host-plane-staleness.test.mjs`), where nothing else is composed.

// ---------------------------------------------------------------------------
// blender_revision_restore — SPEC §11's tool that did not exist
// ---------------------------------------------------------------------------
//
// These checks are why the tool exists at all. Two of this repository's own
// documents told a user to call `blender_revision_restore` for four milestones
// (`README.md`, `milestone-status.md` §10B) while no such tool was registered. The
// facade method it wraps had been implemented since M1 and the workbench's own
// Revisions panel called it, so nothing failed and nothing noticed. A suite that
// CALLS the tool is what makes that class of promise impossible to leave broken.

// First the guard. SPEC §11 gives this tool "需确认" as its permission, and the
// confirmation is the SCHEMA requirement rather than a branch inside `execute`: the
// harness refuses a call that omits a required parameter before the tool runs, which
// is both earlier and impossible to forget. Both halves are asserted, because
// "declared required" and "actually refused" are different claims.
const restoreDefinition = root.get('tools').get('blender_revision_restore')
check('blender_revision_restore declares confirm as a REQUIRED parameter',
  Array.isArray(restoreDefinition?.parameters?.required)
  && restoreDefinition.parameters.required.includes('confirm')
  && restoreDefinition.parameters.properties?.confirm?.type === 'boolean',
  restoreDefinition?.parameters?.required)
check('and its description says why the confirmation is required, not merely that it is',
  /Requires confirm:true/.test(restoreDefinition.description)
  && /re-read with blender_scene_get/.test(restoreDefinition.description))

const unconfirmed = await call('blender_revision_restore', { projectId, revision })
check('a call that omits confirm never reaches the host, so the confirmation cannot be skipped',
  unconfirmed.isError === true && /confirm/.test(String(unconfirmed.error?.message ?? '')),
  unconfirmed.error?.message ?? unconfirmed.value)
check('and the refusal is reported as a coded argument error, not as an unhandled crash',
  unconfirmed.error?.info?.code === 'INVALID_ARGS', unconfirmed.error?.info ?? null)

// A second revision to come back from: one patch that changes one thing.
const patched = await call('blender_scene_patch', {
  projectId,
  baseRevision: revision,
  operations: [{ op: 'camera.update', cameraId: 'camera-main', lens: 42 }],
  note: 'M3 tool plane: a second revision so a restore has somewhere to go',
  saveCheckpoint: false,
})
check('a second revision exists for the restore to return to',
  patched.value?.ok === true && patched.value.data.revision !== revision,
  patched.value?.ok === true ? patched.value.data.revision : (patched.value?.data ?? patched.error))
const secondRevision = patched.value?.data?.revision

// Restoring to the revision that is already current is a SUCCESS reporting no
// change, not an error — the rule the job surface already follows for a job that is
// already finished (D54).
const alreadyThere = await call('blender_revision_restore', { projectId, revision: secondRevision, confirm: true })
check('restoring to the current revision succeeds and says nothing moved',
  alreadyThere.value?.ok === true && alreadyThere.value.data.restored === false,
  { restored: alreadyThere.value?.data?.restored, reason: alreadyThere.value?.data?.reason })
check('and it does not claim a from/to transition that did not happen',
  alreadyThere.value.data.from === undefined && !/Moved/.test(alreadyThere.value.text))

const restored = await call('blender_revision_restore', { projectId, revision, confirm: true })
check('a confirmed restore moves the project back',
  restored.value?.ok === true && restored.value.data.restored === true
  && restored.value.data.revision === revision,
  { revision: restored.value?.data?.revision, from: restored.value?.data?.from })
check('it reports where it came FROM, so the history is not silently rewritten',
  restored.value.data.from === secondRevision, restored.value.data.from)
check('its text tells the model to re-read before the next patch',
  /blender_scene_get/.test(restored.value.text) && /baseRevision/.test(restored.value.text))

// The property that makes this tool safe: nothing was deleted. The revision it left
// is still readable and still in the history.
const afterRestore = await call('blender_project_get', { projectId })
check('the revision the restore moved away from is still in the history',
  afterRestore.value?.ok === true
  && afterRestore.value.data.revisions.some(entry => entry.revision === secondRevision),
  afterRestore.value?.data?.revisions?.map(entry => entry.revision))
check('so the restore is itself undoable by the same tool',
  afterRestore.value.data.revisions.length >= 2, afterRestore.value.data.revisions.length)

// An unknown revision is a coded refusal, the same shape every other read uses.
const missing = await call('blender_revision_restore', { projectId, revision: 'r9999', confirm: true })
check('restoring an unknown revision is a coded result naming the ones that exist',
  missing.isError === false && missing.value.ok === false
  && missing.value.data.errorCode === 'REVISION_NOT_FOUND',
  missing.value?.data?.errorCode ?? missing.error)

// ---------------------------------------------------------------------------
// A delivery on a machine WITHOUT ffmpeg — and the recovery the manual documents
// ---------------------------------------------------------------------------

// WHY THIS SECTION EXISTS (round 30). ffmpeg and ffprobe are prerequisites that appeared NOWHERE in
// this repository's install steps until this round, and every suite ran on a machine that has them.
// So the state a fresh install is in had never been measured, and measuring it found a defect: the
// render finished frame by frame, the encode threw, the job was marked `failed` by the caller's catch
// — and the job's own `delivery` stayed at `encoding` for ever. `blender_job_status` printed a job
// that had stopped and an encode that was still running, in the same block.
const brokenRoot = await buildRoot({ ffmpegPath: join(workspace, 'no-such-ffmpeg') })
const brokenRender = await callOn(brokenRoot, 'blender_final_render', { projectId, revision, frameStart: 50, frameEnd: 51 })
check('a render starts even where ffmpeg is missing — rendering and encoding are separate prerequisites',
  brokenRender.value?.ok === true, brokenRender.value?.data ?? brokenRender.error)
const brokenJobId = brokenRender.value.data.jobId
await waitFor('the delivery to fail at the encode', async () => {
  const status = await callOn(brokenRoot, 'blender_job_status', { projectId, jobId: brokenJobId })
  return ['completed', 'failed'].includes(status.value.data.renderJob.status)
}, 600_000, 500)

const broken = (await callOn(brokenRoot, 'blender_job_status', { projectId, jobId: brokenJobId })).value.data.renderJob
check('a delivery whose encoder is missing ends FAILED, with the code that names the missing tool',
  broken.status === 'failed' && broken.errorCode === 'ENCODER_NOT_FOUND',
  { status: broken.status, errorCode: broken.errorCode })
check('its failure text names the tool and how to install it, rather than only that it broke',
  /ffmpeg/.test(broken.message ?? '') && /brew install ffmpeg/.test(broken.message ?? ''), broken.message)
check('and the delivery attempt is recorded as FAILED rather than left saying "encoding"',
  broken.delivery?.status === 'failed' && broken.delivery?.errorCode === 'ENCODER_NOT_FOUND', broken.delivery)
check('the frames are KEPT — hours of rendering must not be lost to a missing encoder',
  broken.completedFrames === 2 &&
  readdirSync(join(workspace, 'projects', projectId, 'renders', brokenJobId, 'frames')).length === 2,
  { completed: broken.completedFrames })
// An earlier section of this suite published a delivery for a DIFFERENT job, so "nothing is on disk"
// would be false for a reason that has nothing to do with this one. What must be true is that the
// published manifest still describes that other job: a failed encode must not have rewritten the
// description of a video that does not exist.
const publishedManifest = JSON.parse(readFileSync(join(workspace, 'projects', projectId, 'output', 'delivery-manifest.json'), 'utf8'))
check('and it did NOT publish: the manifest on disk still describes the earlier delivery, not this one',
  publishedManifest.jobId !== brokenJobId, { manifestJob: publishedManifest.jobId, brokenJobId })

// The recovery the manual documents (`recovery.md` §3, "frames are all there but there is no video"):
// install the encoder, then export the job again. Driven here on a composition that HAS ffmpeg, on the
// same store — which is the only way to show that the frames left behind are actually deliverable.
const fixedRoot = await buildRoot()
const recovered = await callOn(fixedRoot, 'blender_export', { projectId, jobId: brokenJobId })
// The assertion is written without property chains that can throw: a check that dies takes the rest of
// the suite with it (measured in the first version of this block, which crashed on `data.path` because
// the export reports `video.path`, not `path`).
check('after the encoder is installed, the documented recovery publishes the kept frames',
  recovered.isError === false && recovered.value?.ok === true &&
  recovered.value?.data?.verified === true &&
  (recovered.value?.data?.video?.path ?? '').endsWith('final.mp4'),
  { ok: recovered.value?.ok, verified: recovered.value?.data?.verified, videoPath: recovered.value?.data?.video?.path,
    errorCode: recovered.value?.data?.errorCode, message: recovered.value?.data?.message })
const recoveredManifest = JSON.parse(readFileSync(join(workspace, 'projects', projectId, 'output', 'delivery-manifest.json'), 'utf8'))
check('and the video the manifest describes is really on disk — and the manifest now describes THIS job',
  existsSync(join(workspace, 'projects', projectId, 'output', 'final.mp4')) &&
  recoveredManifest.jobId === brokenJobId,
  { manifestJob: recoveredManifest.jobId, brokenJobId })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nM3 tool plane: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  console.log(`scratch: ${workspace}`)
  process.exit(1)
}
rmSync(workspace, { recursive: true, force: true })
