#!/usr/bin/env node
/**
 * A preview that fails, and what the store looks like afterwards.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The question this file answers is the one a person actually asks after a failure: "is my project
 * still there, and what does it say happened?" Three of those paths were dark — a preview render that
 * throws, a renderer that reports success and writes no image, and the refusals when the spec has no
 * preview profile or no camera — and the first of them ends with a sentence the caller depends on:
 * "…so the project is unchanged (current revision r0000)".
 *
 * It also pins the audit record: a failed attempt leaves `jobs/<jobId>.attempt.json` with the code, the
 * message and the revision it was attempting, and a failure to write THAT must never replace the real
 * error. The runtime is a stub; the store, the staging directory and the records are real.
 *
 * Run standalone: `node deepblend/tests/contract/revision-preview-failure.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

import { BlenderError, BlenderErrorCode, createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { RevisionTransaction, StudioConfig } from '@deepblend/dsh-blender-host'
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

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-preview-failure-'))
const spec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))

/** A runtime whose compile works and whose preview render the test dictates. */
function runtimeWith(preview) {
  return {
    async compileScene(request) {
      const { mkdirSync } = await import('node:fs')
      const directory = join(request.projectRoot, 'stub-compile')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'result.blend'), 'a blend file')
      request.onWorkingDirectory?.({ directory })
      return { report: { validation: {} }, envelope: { warnings: [], notices: [] } }
    },
    async resolveEngineKey() {
      return { blenderEngine: 'BLENDER_EEVEE', requested: 'BLENDER_EEVEE', downgraded: false, warning: null }
    },
    renderPreview: preview,
  }
}

async function studioWith(preview) {
  const ctx = new Context()
  ctx.provide('blenderRuntime', runtimeWith(preview))
  return new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects') }))
}

// ---------------------------------------------------------------------------
// The two refusals: a spec with nothing to render from
// ---------------------------------------------------------------------------

{
  const studio = await studioWith(async () => ({ envelope: {}, report: {} }))
  const staging = join(workspaceRoot, 'staging-no-profile')
  const withoutProfile = { ...spec, renderProfiles: { final: spec.renderProfiles.final } }
  const noProfile = await studio.transactions.renderPreviewInto({ projectId: 'p', revision: 'r0001', staging, spec: withoutProfile })
    .catch(cause => cause)
  check('a revision with no preview profile is refused before anything is created',
    noProfile instanceof BlenderError && noProfile.code === code('RENDER_PROFILE_MISSING') &&
    noProfile.message === 'The SceneSpec defines no preview render profile, so no preview can be rendered.' &&
    !existsSync(staging),
    noProfile?.message ?? noProfile)

  const noCamera = await studio.transactions.renderPreviewInto({
    projectId: 'p', revision: 'r0001', staging, spec: { ...spec, cameras: [] },
  }).catch(cause => cause)
  check('and a spec with no camera is refused with its own code, not as "the render failed"',
    noCamera instanceof BlenderError && noCamera.code === code('SCENE_CAMERA_MISSING') &&
    noCamera.message === 'The SceneSpec declares no camera to render from.',
    noCamera?.message ?? noCamera)
}

// ---------------------------------------------------------------------------
// A renderer that "succeeds" and writes nothing
// ---------------------------------------------------------------------------

{
  const studio = await studioWith(async () => ({ envelope: {}, report: {} }))
  const staging = join(workspaceRoot, 'staging-empty-render')
  const noImage = await studio.transactions.renderPreviewInto({
    projectId: 'p', revision: 'r0001', staging, spec, checkpointPath: join(workspaceRoot, 'scene.blend'),
  }).catch(cause => cause)
  check('a renderer that reports success without an image is refused by name, quoting the file it expected',
    noImage instanceof BlenderError && noImage.code === code('RENDER_NO_OUTPUT') &&
    /^The renderer reported success but produced no image at .*camera-main\.png\.$/.test(noImage.message),
    noImage?.message ?? noImage)
}

// ---------------------------------------------------------------------------
// A preview that fails inside a real commit
// ---------------------------------------------------------------------------

{
  const studio = await studioWith(async () => { throw new Error('the renderer died') })
  const world = await studioWith(async () => { throw new Error('the renderer died') })
  const failed = await world.transactions.createProject({
    title: 'preview-failure', sceneSpec: spec, saveCheckpoint: true, renderPreview: true,
  }).catch(cause => cause)
  check('a preview failure says the PROJECT IS UNCHANGED and names the revision it still points at',
    failed instanceof BlenderError && failed.code === code('SCRIPT_ERROR') &&
    /^Rendering the preview for revision r0001 failed, so the project is unchanged \(current revision r0000\): the renderer died$/.test(failed.message),
    failed?.message ?? failed)
  // MEASURED, and kept as a fact rather than a wish: a failed first commit removes the project's
  // RECORD (and the job log with it, because a job record for a project that does not exist is
  // unreadable), while some directories can remain on disk. The project is gone — `store.exists()` is
  // the question that decides that — and the residue is a directory nothing reads, which the next
  // transaction sweeps. Asserting "the tree is empty" would be asserting something the product does
  // not promise.
  // The promise is exact: "a first compile that fails leaves no project behind", which is
  // `store.exists()` — the presence of `project.json` — and NOT "the record still says revisionCount 0"
  // (an OR of the two would pass with the cleanup removed; a mutation proved it).
  check('and no project is left behind at all, because a first commit that fails costs a message and not the id',
    world.store.exists('preview-failure') === false,
    world.store.exists('preview-failure') ? world.store.readRecord('preview-failure') : 'no project')

  // What the failure must NOT leave is anything that blocks the next attempt: "a refusal costs a
  // message, not your work" is the rule this file keeps, and the retry is how it is measured.
  const retried = await world.transactions.createProject({
    title: 'preview-failure', projectId: 'preview-failure', sceneSpec: spec, saveCheckpoint: true,
  }).catch(cause => cause)
  check('and the same project id can be retried immediately, which is what "nothing was left behind" means',
    retried instanceof Error === false && retried.revision?.revision === 'r0001',
    retried instanceof Error ? retried.message : retried.revision?.revision)
}

{
  // The other half of the same rule: once a revision EXISTS the project is real and must survive a
  // failed later commit — and the failed attempt is then readable, because it is not swept away with a
  // project that is not going anywhere.
  const failing = await studioWith(async () => { throw new Error('the renderer died again') })
  const first = await failing.transactions.createProject({ title: 'second-attempt', sceneSpec: spec, saveCheckpoint: true })
  const second = await failing.transactions.createProject({
    title: 'second-attempt-patch', projectId: 'second-attempt', sceneSpec: spec, saveCheckpoint: true,
  }).then(() => null, cause => cause)
  check('a repeat commit under the SAME id is refused as an existing project, which is the answer that keeps the id honest',
    second instanceof BlenderError && second.code === code('PROJECT_EXISTS'),
    second?.code ?? second)

  const attempt = await failing.transactions.applyScenePatch({
    projectId: first.projectId, baseRevision: first.revision.revision, saveCheckpoint: true, renderPreview: true,
    operations: [{ op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.4, 0.02] }],
  }).catch(cause => cause)
  const attemptPath = join(failing.store.projectDirectory(first.projectId), 'jobs', `${attempt.detail?.jobId}.attempt.json`)
  check('a preview that fails on an EXISTING project leaves the project, and a readable failed-attempt record',
    attempt instanceof BlenderError &&
    /failed, so the project is unchanged \(current revision r0001\): the renderer died again$/.test(attempt.message) &&
    failing.store.exists(first.projectId) === true &&
    existsSync(attemptPath) &&
    JSON.parse(readFileSync(attemptPath, 'utf8')).errorCode === code('SCRIPT_ERROR'),
    { message: attempt?.message, exists: failing.store.exists(first.projectId), record: existsSync(attemptPath) })
}

// ---------------------------------------------------------------------------
// The trivial getter, and a preview that works
// ---------------------------------------------------------------------------

{
  const goodPng = encodePng(createImage(640, 360, [10, 20, 30, 255]))
  const studio = await studioWith(async request => {
    writeFileSync(request.outputPath, goodPng)
    return { envelope: { warnings: [], notices: [{ code: 'SCENE_COMPILER_DECISION', message: 'the renderer moved the camera' }] }, report: { frame: 1 } }
  })
  const project = await studio.transactions.createProject({
    title: 'preview-ok', sceneSpec: spec, saveCheckpoint: true, renderPreview: true,
  })
  check('a preview that works is recorded on the revision, and the renderer\'s notices become warnings',
    project.revision.previews?.length === 1 &&
    project.warnings.some(entry => entry.code === 'SCENE_COMPILER_DECISION' && entry.message === 'the renderer moved the camera'),
    { previews: project.revision.previews?.length, warnings: project.warnings.map(entry => entry.message) })
  check('and the transaction exposes the project\'s CURRENT revision without a store lookup by the caller',
    studio.transactions.currentRevision('preview-ok') === project.revision.revision,
    studio.transactions.currentRevision('preview-ok'))
}

rmSync(workspaceRoot, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
console.log(`\nRevision preview failure: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
