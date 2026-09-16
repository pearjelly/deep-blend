#!/usr/bin/env node
/**
 * The store's error paths: what the project store, the revision transaction and the render job store do
 * when the disk does not contain what a caller expects.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These are the refusals a person meets when something on disk is wrong — a project directory that was
 * never completed, a record written by another build, a revision whose spec is missing, an illegal job
 * transition, a patch that would produce an invalid scene. They were 125 dark lines across three files
 * because every suite that drives the store starts from a HEALTHY store: the happy path is what a
 * fixture naturally produces.
 *
 * Nothing here needs Blender or a subprocess. Each case writes the exact document that provokes the
 * branch — including the ones a correct writer would never produce (a `project.json` from a future
 * build, a revision directory with no spec), because "what does this build do with a store another
 * build wrote" is a question only an artificially broken store can answer.
 *
 * THE TWO THAT MATTER MOST:
 *
 *   - `unfinished()` reports a job whose record CANNOT BE READ as `{jobId, record: null}` rather than
 *     skipping it. A scan that silently drops what it cannot read says "nothing unfinished" for a
 *     directory that has an unfinished job in it — the one answer restart recovery must never give.
 *   - the render job store REFUSES an illegal status transition. Round 47 learned this by being
 *     refused: `recovering -> completed` is legal, `recovering -> succeeded` is not, and a record in a
 *     state no reader can act on is worse than an error.
 *
 * Run standalone: `node deepblend/tests/contract/store-error-paths.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, PROJECT_RECORD_VERSION } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, {
  ProjectStore, RenderJobStore, RevisionTransaction, formatRevisionId, parseRevisionId, StudioConfig,
} from '@deepblend/dsh-blender-host'
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

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-store-errors-'))
const projectsRoot = join(workspaceRoot, 'projects')
const store = new ProjectStore({ projectsRoot, workspaceRoot })
const productSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Revision ids: the formatter refuses what it cannot render
// ---------------------------------------------------------------------------

const badIds = [0, -1, 1.5, Number.NaN].map(value => {
  try {
    return formatRevisionId(value)
  } catch (cause) {
    return cause
  }
})
check('a revision number that cannot be an id is refused rather than padded into one',
  badIds.every(cause => cause instanceof BlenderError && cause.code === code('REVISION_ALLOCATION_FAILED') &&
    /^Invalid revision number /.test(cause.message)),
  badIds.map(cause => cause?.message))
// ---------------------------------------------------------------------------
// A project directory that is not a project
// ---------------------------------------------------------------------------

const incomplete = 'never-completed'
mkdirSync(join(projectsRoot, incomplete), { recursive: true })
const noRecord = (() => {
  try {
    return store.readRecord(incomplete)
  } catch (cause) {
    return cause
  }
})()
check('a project DIRECTORY with no record is reported as corrupt, and the message says it was never completed',
  noRecord instanceof BlenderError && noRecord.code === code('PROJECT_CORRUPT') &&
  /exists but has no project\.json; it was never completed\./.test(noRecord.message) &&
  noRecord.detail?.projectId === incomplete,
  noRecord?.message ?? noRecord)

const fromTheFuture = 'future-build'
store.createSkeleton(fromTheFuture)
store.writeRecord(fromTheFuture, {
  schemaVersion: 'deepblend.project/v99',
  projectId: fromTheFuture,
  title: 'from a later build',
  goal: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  currentRevision: null,
  revisionCount: 0,
})
const wrongVersion = (() => {
  try {
    return store.readRecord(fromTheFuture)
  } catch (cause) {
    return cause
  }
})()
check('a record written by ANOTHER build is refused by version, with both versions in the message',
  wrongVersion instanceof BlenderError && wrongVersion.code === code('PROJECT_CORRUPT') &&
  wrongVersion.message === `Project "${fromTheFuture}" records schemaVersion "deepblend.project/v99", expected "${PROJECT_RECORD_VERSION}".`,
  wrongVersion?.message ?? wrongVersion)

const healthy = await new RevisionTransaction({ store, runtime: {}, config: { maxMeshPolygons: 250_000 } })
  .createProject({ title: 'healthy', sceneSpec: productSpec, saveCheckpoint: false })

check('a project this build wrote reads back with its own schema version',
  store.readRecord(healthy.projectId).schemaVersion === PROJECT_RECORD_VERSION)

check('the id parser is SAFE — it answers null for anything that is not a revision id, genesis included',
  parseRevisionId('r0001') === 1 && parseRevisionId('r0000') === null && parseRevisionId('nope') === null,
  { r0001: parseRevisionId('r0001'), r0000: parseRevisionId('r0000'), nope: parseRevisionId('nope') })
const genesisSpec = (() => {
  try {
    return { read: store.readRevisionSpec(healthy.projectId, 'r0000') }
  } catch (cause) {
    return { code: cause.code, message: cause.message }
  }
})()
check('and the STORE is the place that refuses by name: reading the genesis sentinel is REVISION_ID_INVALID',
  genesisSpec.code === code('REVISION_ID_INVALID') &&
  genesisSpec.message === '"r0000" is not a revision id; expected the form r0001.',
  genesisSpec)


// ---------------------------------------------------------------------------
// A revision whose documents are missing
// ---------------------------------------------------------------------------

const absentRevision = (() => {
  try {
    return store.readRevisionSpec(healthy.projectId, 'r0099')
  } catch (cause) {
    return cause
  }
})()
check('an unknown revision is refused by id, and the message lists the revisions that DO exist',
  absentRevision instanceof BlenderError && absentRevision.code === code('REVISION_NOT_FOUND') &&
  absentRevision.message === `Project "${healthy.projectId}" has no revision r0099.` &&
  JSON.stringify(absentRevision.detail?.available) === JSON.stringify(['r0001']),
  absentRevision?.detail ?? absentRevision?.message)

// A revision directory that exists with no spec: the shape a half-written revision leaves behind.
const specPath = join(store.revisionDirectory(healthy.projectId, 'r0001'), 'scene-spec.json')
const specText = readFileSync(specPath, 'utf8')
rmSync(specPath)
const missingSpec = (() => {
  try {
    return store.readRevisionSpec(healthy.projectId, 'r0001')
  } catch (cause) {
    return cause
  }
})()
writeFileSync(specPath, specText)
check('a revision directory with no spec is REVISION_CORRUPT, which is a different problem from "no such revision"',
  missingSpec instanceof BlenderError && missingSpec.code === code('REVISION_CORRUPT') &&
  missingSpec.message === `Revision r0001 of "${healthy.projectId}" has no scene-spec.json.` &&
  missingSpec.detail?.projectId === healthy.projectId,
  missingSpec?.message ?? missingSpec)

const absentJob = (() => {
  try {
    return store.readJob(healthy.projectId, 'render-0099')
  } catch (cause) {
    return cause
  }
})()
check('an unknown job is refused by id in the ATTEMPT store, naming both ids',
  absentJob instanceof BlenderError && absentJob.code === code('PROJECT_NOT_FOUND') &&
  absentJob.message === `Project "${healthy.projectId}" has no job "render-0099".` &&
  absentJob.detail?.jobId === 'render-0099',
  absentJob?.message ?? absentJob)

const escaped = (() => {
  try {
    return store.assetPath(healthy.projectId, '../escape.glb')
  } catch (cause) {
    return cause
  }
})()
check('an asset path that leaves the project is refused by the path guard, not resolved',
  escaped instanceof BlenderError && /escape\.glb/.test(escaped.message),
  escaped?.message ?? escaped)
check('and an asset path INSIDE the project resolves under its own directory',
  store.assetPath(healthy.projectId, 'assets/raw/model.glb') ===
    join(store.projectDirectory(healthy.projectId), 'assets', 'raw', 'model.glb'))

// ---------------------------------------------------------------------------
// The transaction's own refusals
// ---------------------------------------------------------------------------

const transactions = new RevisionTransaction({ store, runtime: {}, config: { maxMeshPolygons: 250_000 } })
const refusals = [
  ['a project with no title', () => transactions.createProject({ title: '   ' }), 'PROJECT_ID_INVALID', 'A project needs a non-empty title.'],
  // An EXPLICIT id collides; a title does not, because `allocateProjectId` suffixes it (asserted below).
  ['a project id that is taken', () => transactions.createProject({ title: 'another', projectId: 'healthy' }), 'PROJECT_EXISTS', `A project named "healthy" already exists.`],
  ['a patch that is not well formed', () => transactions.applyScenePatch({ projectId: healthy.projectId, baseRevision: 'r0001', operations: [{ op: 'entity.nonsense' }] }), 'SCENE_PATCH_INVALID', null],
]
for (const [label, call, expected, message] of refusals) {
  const outcome = await call().catch(cause => cause)
  check(`${label} is refused with ${expected}`,
    outcome instanceof BlenderError && outcome.code === code(expected) &&
    (message === null ? /^The ScenePatch is not well formed:/.test(outcome.message) : outcome.message === message),
    outcome?.code === undefined ? outcome : `${outcome.code}: ${outcome.message.split('\n')[0]}`)
}

const suffixed = await transactions.createProject({ title: 'healthy', sceneSpec: productSpec, saveCheckpoint: false })
check('a TITLE that is already taken does not collide: it gets a numeric suffix instead of an error',
  suffixed.projectId === 'healthy-2',
  suffixed.projectId)

const invalidInitial = await transactions.createProject({
  title: 'invalid scene',
  sceneSpec: { ...productSpec, cameras: [] },
}).catch(cause => cause)
check('an initial SceneSpec that is not valid is refused with the summary, and no project is left behind',
  invalidInitial instanceof BlenderError && invalidInitial.code === code('SCENE_SPEC_INVALID') &&
  /^The initial SceneSpec for "invalid-scene" is not valid:/.test(invalidInitial.message) &&
  Array.isArray(invalidInitial.detail?.errors) &&
  !store.exists('invalid-scene'),
  invalidInitial?.message?.split('\n')[0] ?? invalidInitial)

const invalidPatch = await transactions.applyScenePatch({
  projectId: healthy.projectId,
  baseRevision: 'r0001',
  operations: [{ op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 5 }],
}).catch(cause => cause)
check('a patch that would produce an invalid scene is refused BEFORE a revision is created',
  invalidPatch instanceof BlenderError && invalidPatch.code === code('SCENE_SPEC_INVALID') &&
  /^Applying the patch would produce an invalid SceneSpec, so no revision was created:/.test(invalidPatch.message) &&
  store.readRecord(healthy.projectId).currentRevision === 'r0001',
  invalidPatch?.message?.split('\n')[0] ?? invalidPatch)

// ---------------------------------------------------------------------------
// A preview with no checkpoint to render from
// ---------------------------------------------------------------------------

/**
 * A runtime that compiles "successfully" but writes no `.blend`.
 *
 * A preview is rendered FROM a checkpoint, so asking for one on a revision whose compile produced no
 * checkpoint has no answer — and the refusal says exactly that. The first version of this case asked
 * for `renderPreview` on a spec-only revision, which is a DIFFERENT path (it compiles for the render);
 * this one produces the state the branch is about.
 */
const silentRuntime = {
  async compileScene(request) {
    request.onWorkingDirectory?.({ directory: request.projectRoot })
    return { report: { validation: {} }, envelope: { warnings: [], notices: [] } }
  },
}
const studio = new BlenderStudio(
  (() => { const ctx = new Context(); ctx.provide('blenderRuntime', silentRuntime); return ctx })(),
  StudioConfig({ workspaceRoot, projectsRoot }),
)
const noCheckpoint = await studio.transactions.createProject({
  title: 'preview without a checkpoint',
  sceneSpec: productSpec,
  saveCheckpoint: true,
  renderPreview: true,
}).catch(cause => cause)
check('a preview requested on a revision whose compile produced no checkpoint is refused by name',
  noCheckpoint instanceof BlenderError && noCheckpoint.code === code('REVISION_CHECKPOINT_MISSING') &&
  /^A preview was requested for r0001, but the compile produced no checkpoint to render from\.$/.test(noCheckpoint.message) &&
  noCheckpoint.detail?.projectId === 'preview-without-a-checkpoint',
  noCheckpoint?.message ?? noCheckpoint)
// What a failed FIRST commit leaves behind: the project record exists and points at the genesis
// sentinel, so the state is diagnosable — reading its revision is a coded refusal, not an empty scene.
const halfBuilt = store.readRecord('preview-without-a-checkpoint')
const halfBuiltSpec = (() => {
  try {
    return store.readRevisionSpec('preview-without-a-checkpoint', halfBuilt.currentRevision)
  } catch (cause) {
    return cause
  }
})()
check('a first commit that failed leaves a diagnosable state: the record points at genesis and reading it refuses',
  halfBuilt.currentRevision === 'r0000' &&
  halfBuiltSpec instanceof BlenderError &&
  Object.values(BlenderErrorCode).includes(halfBuiltSpec.code),
  { currentRevision: halfBuilt.currentRevision, reading: halfBuiltSpec?.code ?? 'read' })

// ---------------------------------------------------------------------------
// The render job store: an illegal transition, an unknown job, an unreadable record
// ---------------------------------------------------------------------------

const jobs = new RenderJobStore({
  projectDirectory: projectId => store.projectDirectory(projectId),
  workspaceRoot,
})
const baseJob = {
  projectId: healthy.projectId,
  jobId: 'render-0001',
  type: 'final-render',
  status: 'completed',
  revisionId: 'r0001',
  frameStart: 1,
  frameEnd: 2,
  expectedFrames: 2,
  completedFrames: [1, 2],
  missingFrames: [],
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
  renderConfig: { resolution: [256, 256], samples: 8 },
}
jobs.write(baseJob)
const illegal = (() => {
  try {
    return jobs.write({ ...baseJob, status: 'running' }, { previous: jobs.read(healthy.projectId, 'render-0001') })
  } catch (cause) {
    return cause
  }
})()
check('a terminal job cannot go back to running, and the refusal says what the transition was',
  illegal instanceof BlenderError && illegal.code === code('RENDER_JOB_STATE_INVALID') &&
  illegal.detail?.from === 'completed' && illegal.detail?.to === 'running' &&
  illegal.detail?.jobId === 'render-0001' &&
  /\(job render-0001\)$/.test(illegal.message),
  illegal?.message ?? illegal)

const unknownJob = (() => {
  try {
    return jobs.read(healthy.projectId, 'render-0099')
  } catch (cause) {
    return cause
  }
})()
check('reading a render job that does not exist is refused by id in the RENDER store, naming both ids',
  unknownJob instanceof BlenderError && unknownJob.code === code('RENDER_JOB_NOT_FOUND') &&
  unknownJob.message === `Project "${healthy.projectId}" has no render job "render-0099".`,
  unknownJob?.message ?? unknownJob)

// A job directory whose record is ABSENT. That is the only way `readSafe` answers null: a record that
// exists but is corrupt THROWS, on purpose ("Refusing to treat corruption as absence"), so the scan
// cannot mistake corruption for absence either.
mkdirSync(jobs.jobDirectory(healthy.projectId, 'render-0002'), { recursive: true })
jobs.write({
  ...baseJob,
  jobId: 'render-0003',
  status: 'running',
})
const unfinished = jobs.unfinished(healthy.projectId)
check('a job whose record cannot be read is SURFACED as unreadable rather than skipped',
  unfinished.some(entry => entry.jobId === 'render-0002' && entry.record === null) &&
  unfinished.some(entry => entry.jobId === 'render-0003' && entry.record !== null) &&
  !unfinished.some(entry => entry.jobId === 'render-0001'),
  unfinished.map(entry => `${entry.jobId}:${entry.record === null ? 'unreadable' : entry.record.status}`))

const badRange = (() => {
  try {
    return jobs.expectedFrames({ ...baseJob, jobId: 'render-0004', frameStart: 10, frameEnd: 1 })
  } catch (cause) {
    return cause
  }
})()
// The corrupt-record case, next to the absent one: it must NOT be reported as "nothing unfinished".
mkdirSync(jobs.jobDirectory(healthy.projectId, 'render-0005'), { recursive: true })
writeFileSync(jobs.recordPath(healthy.projectId, 'render-0005'), '{ this is not json', 'utf8')
const corruptScan = (() => {
  try {
    return jobs.unfinished(healthy.projectId)
  } catch (cause) {
    return cause
  }
})()
check('a CORRUPT record makes the scan refuse rather than report a job it cannot read as unchanged',
  corruptScan instanceof BlenderError && corruptScan.code === code('REVISION_CORRUPT') &&
  /Refusing to treat corruption as absence\./.test(corruptScan.message),
  corruptScan?.message ?? corruptScan)

check('a job whose own frame range is backwards is refused when its frames are listed, quoting the range',
  badRange instanceof BlenderError && badRange.code === code('RENDER_RANGE_INVALID') &&
  /^render job render-0004 has /.test(badRange.message) &&
  badRange.detail?.frameStart === 10 && badRange.detail?.frameEnd === 1,
  badRange?.message ?? badRange)

check('a job with a forward range lists every frame it owes, inclusive',
  JSON.stringify(jobs.expectedFrames({ ...baseJob, frameStart: 7, frameEnd: 9 })) === JSON.stringify([7, 8, 9]))

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The store's OWN guards: the ones that keep a broken input from becoming a throw
// ---------------------------------------------------------------------------

// `exists()` is asked about ids that came from a request, so it must answer false for an id that cannot even
// be turned into a path — a `PATH_SEGMENT_INVALID` thrown at the caller would turn "does this exist?" into a
// crash. The contrast is in the same check: a real project still answers true.
const realProject = await new RevisionTransaction({ store, runtime: {}, config: { maxMeshPolygons: 250_000 } })
  .createProject({ title: 'exists-probe', sceneSpec: productSpec, saveCheckpoint: false })
check('exists() answers false for an id that cannot be a path, and true for a project that exists',
  store.exists('..') === false && store.exists('') === false && store.exists(realProject.projectId) === true,
  { traversal: store.exists('..'), empty: store.exists(''), real: store.exists(realProject.projectId) })

// A job id is allocated from the jobs that exist, and a project with NO jobs directory counts from zero
// rather than throwing on the missing directory. (`createProject` writes an attempt log, so the first id a
// real project ever gets is 002 — this is the branch for a project whose jobs were never recorded, which is
// why it is driven through the allocator itself rather than by arranging an older store.)
const firstJobId = store.allocateJobId('a-project-with-no-jobs-directory', 'render_preview')
check('a project with no jobs directory allocates its first job id from zero instead of failing',
  /^render_preview-\d{14}-001$/.test(firstJobId), firstJobId)

// A revision directory with no manifest did not finish publishing: recording an artifact into it must not
// invent a manifest, and must still hand the caller back the artifact it recorded.
const unpublished = store.revisionDirectory(realProject.projectId, 'r0002')
mkdirSync(unpublished, { recursive: true })
const recorded = store.recordRevisionArtifact(realProject.projectId, 'r0002', 'previews', {
  kind: 'preview', path: 'revisions/r0002/previews/a.png', at: new Date().toISOString(),
})
check('an artifact recorded into a revision with no manifest is returned, and no manifest is invented',
  recorded.length === 1 && recorded[0].path === 'revisions/r0002/previews/a.png' &&
  !existsSync(join(unpublished, 'revision-manifest.json')),
  { recorded: recorded.length, manifest: existsSync(join(unpublished, 'revision-manifest.json')) })

// An idempotency key that hashes to a file holding a DIFFERENT key means a collision or a copied file. The
// safe answer is "no record" — never "reuse that outcome", which is how a retry gets a stranger's answer.
const collided = join(store.projectDirectory(realProject.projectId), 'operations')
mkdirSync(collided, { recursive: true })
writeFileSync(store.idempotencyPath(realProject.projectId, 'the-key-i-asked-for'), JSON.stringify({
  idempotencyKey: 'somebody-elses-key', outcome: { status: 'applied' },
}), 'utf8')
check('an idempotency record holding a different key reads as NO record rather than as a reusable outcome',
  store.readIdempotencyRecord(realProject.projectId, 'the-key-i-asked-for') === null &&
  store.readIdempotencyRecord(realProject.projectId, 'never-written') === null,
  store.readIdempotencyRecord(realProject.projectId, 'the-key-i-asked-for'))

// A title that cannot be made unique is refused rather than looping forever: 1000 attempts, then a coded
// error. `exists` is replaced for this case on purpose — creating a thousand projects to prove it would
// prove the same thing much more slowly.
const exhausted = new ProjectStore({ projectsRoot, workspaceRoot })
let attempts = 0
exhausted.exists = () => { attempts += 1; return true }
const noId = (() => {
  try {
    return exhausted.allocateProjectId('watch commercial')
  } catch (cause) {
    return cause
  }
})()
// The NUMBER OF ATTEMPTS is asserted as well as the sentence that names it: a message that says "after 1000
// attempts" while the loop gave up after one is a sentence nobody can trust, and the first version of this
// check could not tell the two apart.
check('a title whose ids are all taken is refused by name, and the sentence matches the attempts it made',
  noId instanceof BlenderError && noId.code === code('PROJECT_EXISTS') && attempts === 1000 &&
  noId.message === 'Could not allocate an unused project id derived from "watch commercial" after 1000 attempts.',
  { attempts, message: noId?.message ?? noId })

// NAMED, NOT PRETENDED COVERED: the `catch {}` around the derived index write (`#refreshIndex`) is not
// reachable from a test without a seam. The write is `writeFileAtomic`, and the only cheap way to fail it —
// a directory standing where `projects.json` belongs — fails the READ first (`readJson` throws its own
// "Could not read …" before the write is ever attempted, MEASURED here). A read-only projects root would
// fail the project directory alongside it, and the index cannot be redirected. So the promise this branch
// keeps ("a successful project write is not failed by a cache") has no driver in this layer; it is recorded
// here rather than left looking covered.

const passed = results.filter(entry => entry.ok).length
console.log(`\nStore error paths: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
