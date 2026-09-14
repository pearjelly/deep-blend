#!/usr/bin/env node
/**
 * M2 model-visible tool plane.
 *
 * The M1 suite proved the seven batch tools end to end. M2 adds three more, and this
 * file exercises them through the real `defineTool` definitions against a real Host
 * composition and a real Blender.
 *
 * WHAT THIS SUITE UNIQUELY PROVES
 * -------------------------------
 *  1. Every M0+M1+M2 tool is registered, and every tool SPEC §11's table names is
 *     registered too. It deliberately does NOT assert the catalog's size — M3 added
 *     four more tools and `tool-plane-m3.e2e.mjs` owns the total, so a size assertion
 *     here would make every later milestone edit this file, and a check that is kept
 *     green by editing it is not a check. This header used to claim the catalog was
 *     "EXACTLY the ten tools that exist", which stopped being what the code did the
 *     day the eleventh tool arrived.
 *  2. `blender_visual_review` returns an IMAGE, and the image arrives through the
 *     tool's own `output.render` as a content block with a durable attachment
 *     reference. That is the M2 probe's finding turned into a regression test: the
 *     sheet must be a real image block, not a path the model is told to go read.
 *  3. `blender_preview_views` renders and measures WITHOUT spending a model call, and
 *     `blender_visual_autofix` runs the loop — both with their canonical envelopes.
 *  4. A failure is still a tool RESULT with a stable errorCode, never a thrown error.
 *
 * Run: node deepblend/tests/composition/tool-plane-m2.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { importDsh } from '../lib/dsh-deployment.mjs'
import { SPEC_11_TOOLS } from '../lib/spec-tools.mjs'

/**
 * THE HARNESS'S OWN LOSSLESS-JSON RULE, imported rather than reimplemented.
 *
 * `JSON.parse(JSON.stringify(value))` is NOT the same test, and this file used to
 * "check" payloads with exactly that: it silently turns `-0` into `0` and drops
 * `undefined`, so a tool result the real registry refuses looked perfectly fine here.
 * A real session found the consequence — an error reported on a successful commit —
 * while 843 assertions were green. Importing the actual predicate is the only way this
 * suite can fail the way production fails.
 */
const { isJsonValue } = await importDsh('dsh-util-values')

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
 * A stand-in for the two DSH seams these tools consume.
 *
 * The tool registry dispatches through each definition's own output contract, which is
 * what the assertions below observe; `attachments` records what a tool persisted, so
 * "the image really left `execute` and became a reference" is checkable without a
 * full attachment backend.
 */
const harness = (() => {
  const registered = new Map()
  const saved = []
  return {
    registered,
    saved,
    name: 'm2-tool-plane-harness',
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
            // The two-step materialization the real registry performs: the value is
            // snapshotted as lossless JSON, and the content comes from `render`.
            if (!isJsonValue(value)) {
              // Exactly what the real registry does: refuse the result, name the tool.
              return {
                isError: true,
                error: { message: `invalid output: value is not lossless JSON`, info: { code: 'INVALID_OUTPUT' } },
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
          const ref = {
            attachmentId: `sha256:${'a'.repeat(64)}`,
            mediaType,
            bytes: data.byteLength,
            width: 1656,
            height: 1046,
            name,
          }
          saved.push(ref)
          return ref
        },
        imageLimits: { maxImageBytes: 20_971_520, maxImagePixels: 64_000_000, mediaTypes: ['image/png'] },
        async readImageRequest(ref) {
          return { variantId: 'variant-1', attachment: ref, data: new Uint8Array(1), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, depth: 'uchar', space: 'srgb', hasAlpha: false }
        },
      })
      ctx.effect(() => () => saved.length = 0)
    },
  }
})()

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-toolplane-m2-'))
const root = new Context()
root.plugin(harness)

/** Call a tool and return its raw execution result. */
const call = (name, args) => root.get('tools').execute({
  callId: `m2-${name}`,
  name,
  arguments: args,
  signal: AbortSignal.timeout(1_800_000),
})

try {
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: BLENDER_PATH,
    bootstrapPath: join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
    workspaceRoot: join(workspace, 'runtime'),
    timeoutMs: 1_800_000,
    capabilitiesCacheMs: 60_000,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    projectsRoot: join(workspace, 'projects'),
    workspaceRoot: workspace,
    serveCachedCapabilities: true,
    maxPreviewSamples: 64,
  })
  root.plugin(await import('@deepblend/dsh-blender-tool'))

  await new Promise(settle => setTimeout(settle, 400))

  // ---- the catalog -------------------------------------------------------

  /**
   * The names in this suite's own envelope. SPEC §11's inventory is imported, not
   * retyped: two copies of the same thirteen names is two things to keep in step
   * with `SPEC.md`, and neither copy could tell if the table itself changed.
   */
  const names = root.get('tools').schemas().map(entry => entry.name).sort()
  const expected = [
    'blender_capabilities',
    'blender_preview_render',
    'blender_preview_views',
    'blender_project_create',
    'blender_project_get',
    'blender_scene_get',
    'blender_scene_patch',
    'blender_scene_validate',
    'blender_visual_autofix',
    'blender_visual_review',
  ]
  // This suite owns the M0+M1+M2 tools, not the catalog's SIZE. M3 added four more and
  // `tool-plane-m3.e2e.mjs` asserts the total, so re-asserting a total here would make
  // every later milestone edit this file — and a check satisfied by being edited is not
  // a check. What stays this suite's business is that all ten of its own tools are
  // registered, and that the SPEC §11 inventory the product promises is a subset of
  // what the model can actually call.
  check('every M0+M1+M2 tool is registered',
    expected.every(name => names.includes(name)), names)
  check('every tool SPEC §11 names is registered, so that inventory is complete',
    SPEC_11_TOOLS.every(name => names.includes(name)),
    SPEC_11_TOOLS.filter(name => !names.includes(name)))

  for (const name of ['blender_preview_views', 'blender_visual_review', 'blender_visual_autofix']) {
    const definition = root.get('tools').get(name)
    check(`${name} carries a description the model can plan from`,
      typeof definition?.description === 'string' && definition.description.length > 200,
      definition?.description?.length)
    check(`${name} declares a parameters object`, typeof definition?.parameters === 'object')
  }

  check('blender_visual_review declares the image field its result carries',
    // The validator would not strip an undeclared field, but declaring it makes the
    // shape checkable at call time (M2 probe §7.2.1).
    root.get('tools').get('blender_visual_review').output.schema.properties.image !== undefined)
  check('blender_visual_review\'s render emits an image block, so the model sees the sheet',
    (() => {
      const definition = root.get('tools').get('blender_visual_review')
      const blocks = definition.output.render({}, {
        ok: true,
        text: 'x',
        data: {},
        image: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 4, height: 3 },
      })
      return Array.isArray(blocks) && blocks.length === 2 && blocks[1].type === 'image' &&
        blocks[1].attachment.attachmentId === 'sha256:abc'
    })())
  check('the image block is omitted rather than emitted as null when there is no image',
    (() => {
      const blocks = root.get('tools').get('blender_visual_review').output.render({}, { ok: false, text: 'x', data: {}, image: null })
      return blocks.length === 1 && blocks[0].type === 'text'
    })())

  // ---- fixtures ----------------------------------------------------------

  const roomSpec = JSON.parse(readFileSync(
    join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8',
  ))
  const offCentreSpec = JSON.parse(readFileSync(
    join(PROJECT_ROOT, 'deepblend', 'fixtures', 'composition-off-centre', 'scene-spec.json'), 'utf8',
  ))

  const created = await call('blender_project_create', {
    title: 'M2 Tool Plane Room',
    goal: 'Prove the M2 tool plane drives a real project.',
    sceneSpec: roomSpec,
    saveCheckpoint: true,
  })
  // NOTE: the registry stub above refuses any result that fails the harness's real
  // lossless-JSON predicate, so every tool call in this file is also a test of the tool
  // boundary. That is deliberate: the assertion lives in the harness rather than in a
  // line someone can delete.
  check('the M1 create path still works alongside the M2 tools',
    created.value?.ok === true && typeof created.value?.data?.projectId === 'string',
    created.value?.data?.projectId)
  const roomId = created.value.data.projectId

  const broken = await call('blender_project_create', {
    title: 'M2 Tool Plane Off Centre',
    goal: 'A scene with a planted composition defect.',
    sceneSpec: offCentreSpec,
    saveCheckpoint: true,
  })
  const brokenId = broken.value.data.projectId

  // ---- scene_patch, whose result is what actually broke -------------------
  //
  // The defect a real session hit: `blender_scene_patch` reported
  // "invalid output: value is not lossless JSON" on a SUCCESSFUL commit, because
  // Blender writes `-0.0` for a zero rotation and the harness's rule rejects negative
  // zero. The registry stub above enforces that rule with the harness's own predicate,
  // so this call is the regression test — and it exercised the failure before the
  // boundary fix.
  const patched = await call('blender_scene_patch', {
    projectId: roomId,
    baseRevision: created.value.data.revision.revision,
    saveCheckpoint: true,
    note: 'exercise the patch result through the real lossless-JSON rule',
    operations: [
      { op: 'light.update', lightId: 'window-key', energy: 430 },
      { op: 'entity.tags.set', entityId: 'coffee-table', tags: ['hero-product', 'subject-part'] },
    ],
  })
  check('a committed patch passes the harness lossless-JSON rule on its RESULT',
    patched.isError === false && patched.value?.ok === true &&
    typeof patched.value?.data?.revision === 'string',
    patched.isError === true ? patched.error : patched.value?.data?.revision)
  check('the technical report a patch returns is part of that result, -0 and all',
    patched.value?.data?.validation !== undefined || patched.value?.data?.scene !== undefined,
    Object.keys(patched.value?.data ?? {}).slice(0, 8))
  check('entity.tags.set committed through the tool, so the tag mechanism is reachable from the model',
    // `subject-part` decides what may occlude the subject; a tag no operation can set
    // would make the whole mechanism unusable on an existing project.
    patched.value?.ok === true)

  // ---- preview_views -----------------------------------------------------

  const preview = await call('blender_preview_views', { projectId: roomId, width: 400, height: 225, samples: 16 })
  if (preview.value?.ok !== true) console.log('   preview_views failure:', JSON.stringify(preview.value?.data ?? preview))
  check('blender_preview_views renders the standard plan and reports it',
    preview.value?.ok === true && preview.value?.data?.views?.length === 4,
    preview.value?.data?.views?.map(view => view.viewId))
  check('blender_preview_views text names every view and its camera',
    preview.value.text.includes('active-camera') && preview.value.text.includes('camera-detail'),
    preview.value.text.split('\n').filter(line => line.includes('revisions/')).length)
  check('blender_preview_views reports the measured score without a model call',
    preview.value.data.score === 100 && preview.value.text.includes('Measured score: 100/100'),
    preview.value.data.score)
  check('blender_preview_views returns no image, because it is the cheap observation',
    preview.content.length === 1 && preview.content[0].type === 'text')
  check('blender_preview_views did not persist an attachment',
    (harness.saved ?? []).length === 0, harness.saved.length)

  // ---- visual_review -----------------------------------------------------

  const reviewed = await call('blender_visual_review', { projectId: roomId, width: 400, height: 225, samples: 16 })
  check('blender_visual_review returns a scored review',
    reviewed.value?.ok === true && reviewed.value.data.score === 100 && reviewed.value.data.issues.length === 0,
    { score: reviewed.value?.data?.score })
  check('blender_visual_review returns the sheet to the MODEL as an image block',
    reviewed.content.length === 2 && reviewed.content[1].type === 'image' &&
    typeof reviewed.content[1].attachment.attachmentId === 'string',
    reviewed.content.map(block => block.type))
  check('the image reference carries dimensions and a byte count, and no pixel data',
    // The transcript stores references; bytes that leaked into a tool value would also
    // break the lossless-JSON snapshot the real registry performs.
    reviewed.content[1]?.attachment?.bytes > 1000 &&
    reviewed.content[1]?.attachment?.width > 800 &&
    reviewed.content[1]?.attachment?.attachmentId?.startsWith('sha256:'),
    reviewed.content[1]?.attachment)
  check('the tool persisted the sheet through the attachment service',
    (harness.saved ?? []).length === 1 && harness.saved[0].mediaType === 'image/png',
    harness.saved.length)
  check('blender_visual_review text reports the measured issues and the model findings separately',
    reviewed.value.text.includes('Measured issues:') && reviewed.value.text.includes('What the vision model reported seeing'))
  check('blender_visual_review names the sheet path for a human',
    reviewed.value.text.includes('Contact sheet: revisions/'))

  check('a review whose reviewer failed still returns the measurements, the sheet and the reason',
    // This harness composes no `llm`, so the built-in reviewer cannot run. Losing the
    // whole review over that would mean paying for four renders and receiving an error.
    reviewed.value.data.reviewer.error !== null &&
    reviewed.value.data.reviewer.error !== undefined &&
    reviewed.value.data.reviewer.error.code !== undefined &&
    reviewed.value.text.includes('could NOT be consulted'),
    reviewed.value.data.reviewer)

  // ---- visual_autofix ----------------------------------------------------

  const fixed = await call('blender_visual_autofix', {
    projectId: brokenId,
    maxIterations: 1,
  })
  check('blender_visual_autofix reports the loop as a coded failure without a reviewer, not a crash',
    fixed.isError === false && fixed.value?.ok === false && fixed.value?.data?.errorCode !== undefined,
    fixed.value?.data?.errorCode)

  const scene = await call('blender_scene_get', { projectId: roomId })
  check('the M2 tools left the project usable by the M1 tools',
    scene.value?.ok === true && scene.value.data.cameras.length === 4,
    scene.value?.data?.digest?.slice(0, 12))
  check('scene_get now reports each camera\'s role, so the view plan is explainable',
    scene.value.data.cameras.every(camera => typeof camera.role === 'string'),
    scene.value.data.cameras.map(camera => `${camera.id}:${camera.role}`))

  // ---- failure paths -----------------------------------------------------

  const missing = await call('blender_preview_views', { projectId: 'no-such-project' })
  check('an unknown project is a coded result on the M2 tools too',
    missing.isError === false && missing.value?.ok === false && missing.value?.data?.errorCode === 'PROJECT_NOT_FOUND',
    missing.value?.data?.errorCode)

  const badRoles = await call('blender_preview_views', {
    projectId: roomId, roles: ['nonexistent-role'], width: 200, height: 113, samples: 8,
  })
  check('a view role no camera fills produces a coded failure rather than an empty success',
    badRoles.isError === false && badRoles.value?.ok === false,
    { ok: badRoles.value?.ok, code: badRoles.value?.data?.errorCode })
} finally {
  const { rmSync } = await import('node:fs')
  rmSync(workspace, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok).length
console.log('')
console.log(`M2 tool plane: ${results.length - failed}/${results.length} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
