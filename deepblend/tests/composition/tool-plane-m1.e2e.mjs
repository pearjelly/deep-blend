/**
 * M1 model-visible tool plane.
 *
 * The M0 suite proved one tool (`blender_capabilities`) end to end. M1 added six
 * more, and this file exercises all of them through the real `defineTool`
 * definitions — argument parsing, the canonical envelope, the readable text and
 * the failure path — against a real Host composition and a real Blender.
 *
 * WHY THIS IS SEPARATE FROM THE HOST SUITE
 * ----------------------------------------
 * `blender-integration/fixture.e2e.mjs` drives `blenderStudio` directly, so it
 * proves the ENGINE. This proves the SURFACE the model actually talks to: tool
 * names, parameter names, the `ok`/`text`/`data` envelope, and — the part most
 * easily got wrong — that a tool failure comes back as a result with a stable
 * `errorCode` rather than as a thrown exception the model cannot branch on
 * (SPEC §11.1).
 *
 * Run: node deepblend/tests/composition/tool-plane-m1.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/**
 * A minimal stand-in for DSH's `tools` registry seam: it records registrations
 * and dispatches a call through the definition's own output contract, which is
 * all any assertion below observes. Only the three methods DeepBlend uses are
 * implemented, so the test stays about DeepBlend's behaviour.
 */
function toolRegistryStub() {
  const registered = new Map()
  return {
    name: 'tool-registry-stub',
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
    },
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-toolplane-m1-'))
const root = new Context()

/** Call a tool and return its canonical value. */
async function call(name, args) {
  const result = await root.get('tools').execute({
    callId: `m1-${name}`,
    name,
    arguments: args,
    signal: AbortSignal.timeout(300_000),
  })
  return result
}

try {
  root.plugin(toolRegistryStub())
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: BLENDER_PATH,
    bootstrapPath: join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
    workspaceRoot: join(workspace, 'runtime'),
    timeoutMs: 300_000,
    capabilitiesCacheMs: 60_000,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    projectsRoot: join(workspace, 'projects'),
    workspaceRoot: workspace,
    serveCachedCapabilities: true,
    maxPreviewSamples: 256,
  })
  root.plugin(await import('@deepblend/dsh-blender-tool'))

  await new Promise(settle => setTimeout(settle, 300))

  // ---- the catalog ------------------------------------------------------

/** Every tool SPEC §11's table names, in the order that table lists them. */
const SPEC_11_TOOLS = [
  'blender_capabilities',
  'blender_project_create',
  'blender_project_get',
  'blender_scene_get',
  'blender_scene_patch',
  'blender_asset_ingest',
  'blender_preview_render',
  'blender_scene_validate',
  'blender_final_render',
  'blender_export',
  'blender_revision_restore',
  'blender_job_status',
  'blender_job_cancel',
]

  const names = root.get('tools').schemas().map(entry => entry.name).sort()
  const expected = [
    'blender_capabilities',
    'blender_preview_render',
    'blender_project_create',
    'blender_project_get',
    'blender_scene_get',
    'blender_scene_patch',
    'blender_scene_validate',
  ]
  // The M1 tools must all be PRESENT. "Exactly these seven" was the M1 assertion and
  // it moved to `tool-plane-m2.e2e.mjs` the moment M2 added three more: a test that the
  // catalog never grows would fail on every future milestone for the right reason and
  // be deleted for the wrong one. What stays here is the part that is still M1's to
  // assert — that these seven exist and are usable — plus the rule that outlives every
  // milestone: nothing gets registered before its host service does.
  check('the preset plane registers every M1 tool',
    expected.every(name => names.includes(name)),
    names.filter(name => !expected.includes(name)))
check('every tool SPEC §11 names is registered, so that inventory is complete',
  SPEC_11_TOOLS.every(name => names.includes(name)),
  SPEC_11_TOOLS.filter(name => !names.includes(name)))

  for (const name of expected) {
    const definition = root.get('tools').get(name)
    check(`${name} carries a description the model can plan from`,
      typeof definition?.description === 'string' && definition.description.length > 120,
      definition?.description?.length)
    check(`${name} declares a parameters object`, typeof definition?.parameters === 'object')
  }

  check('blender_scene_patch documents every operation it accepts',
    (() => {
      const text = root.get('tools').get('blender_scene_patch').description
      return text.includes('entity.transform.update') && text.includes('render.profile.set')
        && text.includes('animation.track.set')
    })())

  // ---- the M1 loop, through the tools -----------------------------------
  const fixture = JSON.parse(readFileSync(
    join(PROJECT_ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8',
  ))

  const created = await call('blender_project_create', {
    title: 'Tool Plane Turntable',
    goal: 'Prove the model-visible tool plane drives a real project.',
    sceneSpec: fixture,
    saveCheckpoint: true,
  })
  check('blender_project_create succeeds and returns the canonical envelope',
    created.isError === false && created.value?.ok === true
      && typeof created.value?.data?.projectId === 'string'
      && typeof created.value?.data?.revision?.revision === 'string',
    { ok: created.value?.ok, projectId: created.value?.data?.projectId })
  check('blender_project_create text is readable and carries Canonical JSON',
    created.value.text.includes('Canonical JSON:') && created.value.text.includes('Created project'))

  const projectId = created.value.data.projectId
  const revision1 = created.value.data.revision.revision

  const scene = await call('blender_scene_get', { projectId })
  check('blender_scene_get returns a digest, not the whole document',
    scene.value?.ok === true && scene.value?.data?.digest !== undefined
      && scene.value?.data?.spec === undefined,
    { ok: scene.value?.ok, digest: scene.value?.data?.digest?.slice(0, 12) })
  check('blender_scene_get names every entity in its text',
    scene.value.text.includes('watch-body') && scene.value.text.includes('camera-main')
      && scene.value.text.includes('Entities:'))
  check('blender_scene_get offers the full document only on request',
    (await call('blender_scene_get', { projectId, full: true })).value?.data?.spec?.schemaVersion === 'deepblend.scene/v1')

  const project = await call('blender_project_get', { projectId })
  check('blender_project_get lists the revision history in its text',
    project.value?.ok === true && project.value.text.includes(revision1))

  // A failed patch must come back as a RESULT with a code, never as a throw.
  const rejected = await call('blender_scene_patch', {
    projectId,
    baseRevision: revision1,
    operations: [{ op: 'entity.transform.update', entityId: 'ghost', location: [1, 1, 1] }],
  })
  check('a rejected patch is a tool RESULT, not a thrown error',
    rejected.isError === false && rejected.value?.ok === false, { isError: rejected.isError, ok: rejected.value?.ok })
  check('a rejected patch reports a stable errorCode',
    rejected.value?.data?.errorCode === 'PATCH_TARGET_MISSING', rejected.value?.data?.errorCode)
  check('a rejected patch explains that the project is unchanged',
    rejected.value.text.includes('no revision was created'), rejected.value.text.slice(0, 120))

  // The dry-run tool must predict that rejection without committing anything.
  const dryRun = await call('blender_scene_validate', {
    projectId,
    patch: {
      baseRevision: revision1,
      operations: [{ op: 'entity.remove', entityId: 'watch-body' }],
    },
  })
  check('blender_scene_validate dry-runs a patch and predicts the failure',
    dryRun.value?.ok === true && dryRun.value?.data?.ok === false
      && dryRun.value.data.errors.some(issue => issue.code === 'PATCH_TARGET_IN_USE'),
    dryRun.value?.data?.errors?.map(issue => issue.code))
  check('the dry run committed nothing',
    (await call('blender_project_get', { projectId })).value.data.currentRevision === revision1)

  const patched = await call('blender_scene_patch', {
    projectId,
    baseRevision: revision1,
    note: 'Warm the rim light and flatten the stage for a softer look.',
    stage: 'VISUAL_REVIEW',
    operations: [
      { op: 'light.update', lightId: 'rim-light', energy: 34, color: [1, 0.88, 0.74, 1] },
      { op: 'material.parameter.update', materialId: 'stage-matte', parameter: 'roughness', value: 0.95 },
    ],
    renderPreview: true,
  })
  check('blender_scene_patch commits a revision and reports it',
    patched.value?.ok === true && patched.value?.data?.revision === 'r0002',
    patched.value?.data?.revision)
  check('blender_scene_patch reports the checkpoint and the preview it produced',
    patched.value.data.checkpoint === 'revisions/r0002/scene.blend'
      && patched.value.data.previews.length === 1,
    { checkpoint: patched.value.data.checkpoint, previews: patched.value.data.previews.length })
  check('blender_scene_patch echoes the note into the revision history',
    patched.value.data.summary.includes('Warm the rim light'))
  check('blender_scene_patch text surfaces the compiler decisions',
    patched.value.text.includes('Warnings (') || patched.value.text.includes('Canonical JSON:'))

  // The same patch again: the idempotency guard, seen from the model's side.
  const replayed = await call('blender_scene_patch', {
    projectId,
    baseRevision: revision1,
    note: 'Warm the rim light and flatten the stage for a softer look.',
    stage: 'VISUAL_REVIEW',
    operations: [
      { op: 'light.update', lightId: 'rim-light', energy: 34, color: [1, 0.88, 0.74, 1] },
      { op: 'material.parameter.update', materialId: 'stage-matte', parameter: 'roughness', value: 0.95 },
    ],
    renderPreview: true,
  })
  check('re-submitting the same patch is explained to the model as a replay',
    replayed.value?.ok === true && replayed.value?.data?.idempotentReplay === true
      && replayed.value.text.includes('had already been applied'),
    { replay: replayed.value?.data?.idempotentReplay })

  const preview = await call('blender_preview_render', { projectId, cameraId: 'camera-top', frame: 45 })
  check('blender_preview_render renders an image and names its path',
    preview.value?.ok === true && preview.value?.data?.artifacts?.length === 1
      && preview.value.data.artifacts[0].path.startsWith('revisions/r0002/previews/'),
    preview.value?.data?.artifacts?.[0]?.path)
  check('blender_preview_render reports the engine and dimensions in its text',
    preview.value.text.includes('640') && preview.value.text.includes('CYCLES'))

  const validation = await call('blender_scene_validate', { projectId })
  check('blender_scene_validate reports a healthy revision as valid',
    validation.value?.ok === true && validation.value?.data?.ok === true,
    { errors: validation.value?.data?.errorCount, notices: validation.value?.data?.noticeCount })
  check('blender_scene_validate includes the technical report from the commit',
    validation.value.data.technical !== null
      && validation.value.data.technical.counts?.meshObjects === 4,
    validation.value?.data?.technical?.counts)

  // ---- a revision with NO checkpoint of its own -----------------------------
  //
  // `saveCheckpoint:false` is the fast path: the commit stores the SceneSpec and skips
  // the Blender compile. The revision then has no `.blend`, and the FIRST render of it
  // has to compile one — which is the whole reason SceneSpec, not `.blend`, is the
  // source of truth (SPEC §8.1).
  //
  // That path was DEAD. `compileRevisionForRender` checked for the provider's
  // `result.blend` and recorded a destination path WITHOUT EVER WRITING IT, while the
  // provider deletes the working directory as soon as the callback returns — so the
  // check that followed always failed with `REVISION_CHECKPOINT_MISSING`, for every
  // revision, always. Nothing noticed because every other suite commits with
  // `saveCheckpoint:true`. MEASURED before the fix: "Revision r0002 was compiled for
  // rendering but produced no checkpoint."
  const noCheckpoint = await call('blender_scene_patch', {
    projectId,
    baseRevision: 'r0002',
    operations: [{ op: 'camera.update', cameraId: 'camera-top', lens: 52 }],
    note: 'M1 tool plane: a revision with no checkpoint of its own',
    saveCheckpoint: false,
  })
  check('a patch can commit a revision without a checkpoint',
    noCheckpoint.value?.ok === true && noCheckpoint.value.data.revision === 'r0003',
    noCheckpoint.value?.data?.revision ?? noCheckpoint.error)

  const compiledPreview = await call('blender_preview_render', { projectId, revision: 'r0003', cameraId: 'camera-top', frame: 45 })
  check('and that revision can still be previewed: the render compiles a .blend from its SceneSpec',
    compiledPreview.value?.ok === true && compiledPreview.value?.data?.artifacts?.length === 1,
    compiledPreview.value?.data?.errorCode ?? compiledPreview.value?.data?.artifacts?.[0]?.path)
  check('the compiled preview is recorded against the revision it was compiled FROM',
    compiledPreview.value?.data?.artifacts?.[0]?.path?.startsWith('revisions/r0003/previews/'),
    compiledPreview.value?.data?.artifacts?.[0]?.path)

  // ---- failure paths that must never throw ------------------------------
  const unknownProject = await call('blender_scene_get', { projectId: 'no-such-project' })
  check('reading an unknown project is a coded result, not a crash',
    unknownProject.isError === false && unknownProject.value?.ok === false
      && unknownProject.value?.data?.errorCode === 'PROJECT_NOT_FOUND',
    unknownProject.value?.data?.errorCode)

  const emptyPatch = await call('blender_scene_patch', {
    projectId, baseRevision: revision1, operations: [],
  })
  check('an empty operations array is refused with the supported list',
    emptyPatch.value?.ok === false && emptyPatch.value?.data?.errorCode === 'SCENE_PATCH_INVALID'
      && emptyPatch.value.text.includes('entity.transform.update'),
    emptyPatch.value?.data?.errorCode)

  const stale = await call('blender_scene_patch', {
    projectId,
    baseRevision: revision1,
    operations: [{ op: 'light.update', lightId: 'key-light', energy: 3 }],
  })
  check('a stale baseRevision is refused with an actionable conflict code',
    stale.value?.ok === false && stale.value?.data?.errorCode === 'REVISION_CONFLICT',
    stale.value?.data?.errorCode)
  check('the conflict text tells the model exactly what to do next',
    stale.value.text.includes('blender_scene_get'), stale.value.text.slice(-200))
} catch (error) {
  check('the M1 tool plane completed without an unexpected throw', false, error?.stack ?? String(error))
} finally {
  await root.stop?.()
  rmSync(workspace, { recursive: true, force: true })
}

console.log('')
const failures = results.filter(entry => !entry.ok)
console.log(`M1 tool plane: ${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) {
  console.log('Failed checks:')
  for (const entry of failures) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
