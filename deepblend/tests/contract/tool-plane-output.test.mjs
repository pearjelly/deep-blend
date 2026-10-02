#!/usr/bin/env node
/**
 * What the M1 tools hand the model and the operator when a call FAILS, and what card
 * they hand the UI plane for every call.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `composition/tool-plane-m1.e2e.mjs` drives these eight tools against a REAL host, and that
 * is the right test for "the tool reaches Blender and returns what the scene contains". It is
 * also why, for six rounds, the coverage reading had 51 dark lines in `tool/lib/tools.js`:
 * a suite that needs a working host can only ever produce calls that SUCCEED, so
 *
 *   - every `catch` block that turns a host failure into a stable `errorCode`,
 *   - every note that describes a state the happy path does not produce (a revision with no
 *     checkpoint, a read of a revision the project no longer points at, a validation with no
 *     technical report),
 *   - and every `presentCall` card title,
 *
 * had never been executed by anything. Those are exactly the paths a model meets when
 * something is wrong, which is when the temperature of the text matters most.
 *
 * So the host is a stub the test controls (`../lib/tool-plane-harness.mjs`), and every case
 * below makes one tool fail in one specific way or reach one specific state. No Blender, no
 * project on disk, no subprocess.
 *
 * THE PRESENTCALL CONTRACT IS READ FROM THE INSTALLED HARNESS, NOT REMEMBERED
 * -------------------------------------------------------------------------
 * `presentCall()` returns a `ToolCallView` whose `kind` is a CLOSED vocabulary owned by
 * `@deepseek-ai/dsh-tools` — `'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' |
 * 'fetch' | 'other'`. There is no runtime constant to import, so this file parses the
 * vocabulary out of that package's own `presentation.d.ts`. It is the pinned contract
 * (`tools/dsh-baseline.json`), and reading it is the only version of this check that cannot
 * rot into "we assert our own copy of someone else's list".
 *
 * That check found a real defect the moment it ran: six `presentCall`s in this package said
 * `kind: 'write'`, which is not in the vocabulary at all — the tool plane was describing its
 * own calls in a word the contract does not contain (D127).
 *
 * Run standalone: `node deepblend/tests/contract/tool-plane-output.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, HOST_API_VERSION, UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'

import { composeToolPlane } from '../lib/tool-plane-harness.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

/**
 * A code from the vocabulary, refusing to hand back `undefined`.
 *
 * WHY THIS EXISTS: the first version of the capability-probe case threw
 * `new BlenderError(BlenderErrorCode.BLENDER_NOT_FOUND, …)` — a key that does not exist (the
 * vocabulary spells it `NOT_FOUND`). Every assertion comparing a result's code to that constant
 * then passed by comparing `undefined` to `undefined`, and the only check that noticed was the
 * generic "no prose leaks a JavaScript value" one, which reported `errorCode: undefined`. A
 * comparison against a constant that might not exist is a comparison that can pass vacuously, so
 * the lookup itself is now the guard (D128).
 */
function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BlenderErrorCode.${name} is not a code this build defines — the expectation would be undefined`)
  }
  return value
}

/**
 * The M3 host: the four tools that run, watch, cancel and export a DELIVERY render.
 *
 * WHY A SECOND STUB RATHER THAN ONE BIGGER ONE. The stub above exists for the M1 tools, and it has no
 * notion of a render job at all — which is exactly why the M3 tools' failure and empty-state text had never
 * been executed by anything in this layer: the composition suite that drives them needs a real Blender host
 * and therefore only ever reaches success. These four tools are where a model learns what happened to hours
 * of machine time, so their sentences are asserted here, on a host the test dictates.
 */
function stubRenderHost(overrides = {}) {
  const job = {
    jobId: 'render-0001', projectId: 'watch-commercial', revisionId: 'r0002', type: 'final-render',
    status: 'running', frameStart: 30, frameEnd: 89, expectedFrames: 60, completedFrames: [30, 31],
    missingFrames: [45], corruptFrames: [], fps: 30, delivery: null, warnings: [],
  }
  return {
    // The staleness handshake every M3 tool performs before it calls anything (`hostPlaneIsCurrent`): a stub
    // without it is read as a host from before the upgrade, which is a diagnosis rather than a bypass.
    hostApiVersion: () => HOST_API_VERSION,
    listJobs: async () => ({ projectId: 'watch-commercial', jobs: [job], unfinished: ['render-0001'], recovery: [], recoveryError: null }),
    getJob: async () => ({ renderJob: job }),
    resumeRenderJob: async () => ({
      jobId: 'render-0001', projectId: 'watch-commercial', revision: 'r0002',
      alreadyComplete: 2, resumed: 1, resumedFrames: [45], corrupt: [], warnings: [],
    }),
    startFinalRender: async () => ({ jobId: 'render-0002', dshJobId: null, projectId: 'watch-commercial', revision: 'r0002' }),
    exportProject: async () => ({ projectId: 'watch-commercial', revision: 'r0002', verified: true, video: { path: 'output/final.mp4' }, problems: [] }),
    cancelJob: async () => ({ jobId: 'render-0001', status: 'cancelled', cancelled: true, reason: 'asked', processGone: true, completedFrames: 2, process: { term: 'signalled-group' } }),
    ...overrides,
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

// ---------------------------------------------------------------------------
// The host, as a set of handlers the test swaps per case
// ---------------------------------------------------------------------------

/** Every method the M1 tools call. A case replaces one of them with a thrower. */
function stubStudio() {
  return {
    listRecipes: () => ({ recipes: [], errors: [] }),
    createProject: async () => ({
      projectId: 'watch-commercial',
      title: 'Watch commercial',
      revision: { revision: 'r0001', digest: 'sha256:1111', kind: 'initial', checkpoint: '/store/r0001/scene.blend', previews: [] },
      warnings: [],
    }),
    getProject: async () => ({
      projectId: 'watch-commercial',
      title: 'Watch commercial',
      currentRevision: 'r0002',
      revisionCount: 2,
      scene: { counts: { entities: 4, materials: 4, lights: 1, cameras: 1 }, project: { frameStart: 1, frameEnd: 120, fps: 24 } },
      revisions: [
        { revision: 'r0001', kind: 'initial', checkpoint: '/store/r0001/scene.blend', previews: [], isCurrent: false, summary: 'the scaffold' },
        { revision: 'r0002', kind: 'patch', checkpoint: null, previews: [{ path: 'preview.png' }], isCurrent: true, summary: null },
      ],
    }),
    getScene: async () => ({ revision: 'r0001', digest: 'sha256:1111' }),
    applyScenePatch: async () => ({ revision: 'r0002', digest: 'sha256:2222', summary: 'moved the camera', checkpoint: '/store/r0002/scene.blend', previews: [], scene: { counts: { entities: 4 } }, warnings: [] }),
    renderPreview: async () => ({ path: 'revisions/r0001/preview.png' }),
    validateScene: async () => ({
      revision: 'r0001',
      ok: true,
      digest: 'sha256:1111',
      technical: null,
      errorCount: 0,
      noticeCount: 0,
      errors: [],
      notices: [],
    }),
    restoreRevision: async () => ({ projectId: 'watch-commercial', currentRevision: 'r0001' }),
    ingestAsset: async () => ({ assetId: 'watch-body', path: 'assets/watch-body.glb' }),
  }
}

const studio = stubStudio()
const { registered } = await composeToolPlane({ studio, label: 'm1-tool-output', expectAtLeast: 16 })
const execute = async (name, args) => {
  const definition = registered.get(name)
  if (definition === undefined) return { ok: false, text: '', error: `${name} is not registered` }
  return definition.execute(args, { signal: undefined })
}
const present = (name, args) => {
  const definition = registered.get(name)
  if (definition === undefined || typeof definition.presentCall !== 'function') return undefined
  return definition.presentCall(args)
}

const M1_TOOLS = [
  'blender_recipe_list',
  'blender_project_create', 'blender_project_get', 'blender_scene_get', 'blender_scene_patch',
  'blender_preview_render', 'blender_scene_validate', 'blender_revision_restore', 'blender_asset_ingest',
]

/**
 * The fewest arguments each tool's OWN schema accepts.
 *
 * `defineTool` validates arguments before `execute` and before `presentCall`, and it answers
 * `undefined` (or throws `ToolArgsError`) when they are wrong — which is a real contract, not an
 * obstacle: the first draft of this file passed `{ projectId }` to everything and got `undefined`
 * cards for the three tools that also require a revision, a patch or a source. So the arguments
 * live in one table here, and a check below proves the table still covers every required property
 * of every registered tool.
 */
const MINIMAL_ARGS = {
  blender_recipe_list: {},
  blender_capabilities: {},
  blender_project_create: { title: 'watch commercial' },
  blender_project_get: { projectId: 'watch-commercial' },
  blender_scene_get: { projectId: 'watch-commercial' },
  blender_scene_patch: { projectId: 'watch-commercial', baseRevision: 'r0001', operations: [{ op: 'entity.transform.update' }] },
  blender_preview_render: { projectId: 'watch-commercial' },
  blender_scene_validate: { projectId: 'watch-commercial' },
  blender_revision_restore: { projectId: 'watch-commercial', revision: 'r0001', confirm: true },
  blender_asset_ingest: { projectId: 'watch-commercial', sourcePath: 'assets/watch.glb' },
  blender_preview_views: { projectId: 'watch-commercial' },
  blender_visual_review: { projectId: 'watch-commercial' },
  blender_visual_autofix: { projectId: 'watch-commercial' },
  blender_final_render: { projectId: 'watch-commercial' },
  blender_export: { projectId: 'watch-commercial' },
  blender_job_status: { projectId: 'watch-commercial' },
  blender_job_cancel: { projectId: 'watch-commercial', jobId: 'render-0001' },
}

check('the arguments this file passes cover every required property of every registered tool',
  [...registered].every(([name, definition]) =>
    (definition.parameters.required ?? []).every(key => MINIMAL_ARGS[name] !== undefined && key in MINIMAL_ARGS[name])),
  [...registered].filter(([name, definition]) =>
    (definition.parameters.required ?? []).some(key => !(key in (MINIMAL_ARGS[name] ?? {}))))
    .map(([name, definition]) => `${name} needs ${(definition.parameters.required ?? []).join(', ')}`))

// ---------------------------------------------------------------------------
// The card contract: read the vocabulary from the harness that owns it
// ---------------------------------------------------------------------------

const presentationTypes = readFileSync(
  join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'presentation.d.ts'),
  'utf8',
)
const vocabularyMatch = presentationTypes.match(/export type ToolCallKind =([^;]+);/)
const KIND_VOCABULARY = vocabularyMatch === null
  ? []
  : [...vocabularyMatch[1].matchAll(/'([a-z]+)'/g)].map(entry => entry[1])

const DEPENDED_ON_CODES = ['CAPABILITY_PROBE_FAILED', 'NOT_FOUND', 'REVISION_CONFLICT']
check('every error code this file compares against is a code this build really defines',
  DEPENDED_ON_CODES.every(name => Object.values(BlenderErrorCode).includes(code(name))),
  DEPENDED_ON_CODES.map(name => `${name} = ${code(name)}`))
check('the kind vocabulary was read from the installed harness rather than remembered',
  KIND_VOCABULARY.length >= 6 && KIND_VOCABULARY.includes('other') && KIND_VOCABULARY.includes('edit'),
  KIND_VOCABULARY)

check('every M1 tool declares a presentCall',
  M1_TOOLS.every(name => typeof registered.get(name)?.presentCall === 'function'),
  M1_TOOLS.filter(name => typeof registered.get(name)?.presentCall !== 'function'))

// Each row is one tool's title for one set of args, including the branches inside the title.
const titleCases = [
  ['blender_recipe_list', {}, 'List product recipes', 'read'],
  // Every branch inside a title, not just the first one.
  ['blender_capabilities', {}, 'Check Blender capabilities', 'read'],
  ['blender_capabilities', { refresh: true }, 'Re-probe Blender capabilities', 'other'],
  ['blender_project_create', {}, 'Create project "watch commercial"', 'edit'],
  ['blender_project_create', { title: '' }, 'Create project ""', 'edit'],
  ['blender_project_get', {}, 'Read project "watch-commercial"', 'read'],
  ['blender_scene_get', { full: true }, 'Read full scene of "watch-commercial"', 'read'],
  ['blender_scene_get', {}, 'Read scene of "watch-commercial"', 'read'],
  ['blender_scene_patch', { operations: [{ op: 'entity.transform.update' }, { op: 'light.update' }] }, 'Patch scene of "watch-commercial" (2 ops)', 'edit'],
  ['blender_scene_patch', {}, 'Patch scene of "watch-commercial" (1 ops)', 'edit'],
  ['blender_preview_render', { cameraId: 'camera-main' }, 'Render preview of "watch-commercial" from camera-main', 'other'],
  ['blender_preview_render', {}, 'Render preview of "watch-commercial"', 'other'],
  ['blender_scene_validate', {}, 'Validate "watch-commercial"', 'read'],
  ['blender_scene_validate', { patch: { baseRevision: 'r0001', operations: [{ op: 'entity.transform.update' }] } }, 'Dry-run a patch against "watch-commercial"', 'read'],
  ['blender_revision_restore', {}, 'Restore "watch-commercial" to r0001', 'edit'],
  ['blender_asset_ingest', {}, 'Ingest asset "assets/watch.glb"', 'edit'],
  ['blender_asset_ingest', { sourcePath: undefined, sourceUrl: 'https://example.com/watch.glb' }, 'Ingest asset from https://example.com/watch.glb', 'edit'],
  ['blender_preview_views', {}, 'Render the standard views of "watch-commercial"', 'other'],
  ['blender_preview_views', { roles: ['three-quarter', 'top'] }, 'Render 2 views of "watch-commercial"', 'other'],
  ['blender_visual_review', {}, 'Review "watch-commercial" visually', 'read'],
  ['blender_visual_autofix', {}, 'Auto-fix visuals of "watch-commercial"', 'edit'],
  ['blender_final_render', {}, 'Render delivery for "watch-commercial"', 'edit'],
  ['blender_final_render', { resumeJobId: 'render-0001' }, 'Resume delivery render render-0001', 'edit'],
  ['blender_export', {}, 'Package the delivery for "watch-commercial"', 'edit'],
  ['blender_job_status', {}, 'List jobs of "watch-commercial"', 'read'],
  ['blender_job_status', { jobId: 'render-0001' }, 'Read job render-0001', 'read'],
  ['blender_job_cancel', {}, 'Cancel job render-0001', 'edit'],
]

// The merge drops `undefined` values, exactly as the tools' own `definedFields` does: an own
// key set to `undefined` is a WRONG TYPE to the argument schema, not an omitted argument.
const argsFor = (name, overrides) => Object.fromEntries(
  Object.entries({ ...MINIMAL_ARGS[name], ...overrides }).filter(([, value]) => value !== undefined),
)

for (const [name, overrides, title, kind] of titleCases) {
  const card = present(name, argsFor(name, overrides))
  check(`${name} titles this call "${title}"`, card?.title === title && card?.kind === kind, card)
}

// One title branch is UNREACHABLE, and that is measured rather than assumed: `title` is a
// required parameter, so DSH drops the card for a call without it, and the `?? 'project'`
// fallback inside the title can only ever be shadowed by the schema (the round-39 pattern).
check('the "project" fallback in the project_create title is shadowed by the schema, and cannot be reached',
  registered.get('blender_project_create').parameters.required.includes('title') &&
  present('blender_project_create', {}) === undefined &&
  present('blender_project_create', { title: '' }).title === 'Create project ""')

check('every card these tools answer with is a generic card whose kind is a word the harness defines',
  titleCases.every(([name, overrides]) => {
    const card = present(name, argsFor(name, overrides))
    return card !== undefined && card.card === 'generic' && typeof card.title === 'string' && card.title.length > 0 &&
      KIND_VOCABULARY.includes(card.kind)
  }),
  titleCases.filter(([name, overrides]) => {
    const card = present(name, argsFor(name, overrides))
    return card === undefined || !KIND_VOCABULARY.includes(card.kind)
  }).map(([name, overrides]) => `${name}: ${JSON.stringify(present(name, argsFor(name, overrides)))}`))

// `presentCall` is display-only, and DSH softens it: it answers `undefined` for args that do
// not satisfy the tool's own schema instead of throwing, because presentation may replay
// logged args from an older schema. Both halves of that are pinned here — a card is either a
// real card or nothing at all, never a half-built title.
check('a card asked for args its own schema refuses is dropped, not thrown on and not half-built',
  present('blender_project_create', { projectId: 'watch-commercial' }) === undefined &&
  present('blender_scene_patch', { projectId: 'watch-commercial' }) === undefined &&
  present('blender_revision_restore', { projectId: 'watch-commercial' }) === undefined &&
  present('blender_project_create', { projectId: 42, title: null }) === undefined)

// Restore confirmation and current-pointer conditions must survive the real DSH wrapper.
{
  const restore = registered.get('blender_revision_restore')
  check('restore declares the optional current-revision condition and explains where to read it',
    restore.parameters.properties.expectedCurrentRevision?.type === 'string'
    && !restore.parameters.required.includes('expectedCurrentRevision')
    && /blender_project_get/.test(restore.description) && /currentRevision/.test(restore.description))
  const original = studio.restoreRevision, requests = []
  studio.restoreRevision = async input => {
    requests.push(input)
    if (input.expectedCurrentRevision !== undefined && input.expectedCurrentRevision !== 'r0002') {
      throw new BlenderError(code('REVISION_CONFLICT'), 'The current revision changed.',
        { detail: { expectedCurrentRevision: input.expectedCurrentRevision, currentRevision: 'r0002' } })
    }
    return { projectId: input.projectId, revision: input.revision, from: 'r0002', restored: true }
  }
  try {
    const declined = await execute('blender_revision_restore', argsFor('blender_revision_restore', { confirm: false }))
    check('explicit false confirmation returns a coded refusal without calling the Host',
      declined.ok === false && declined.data?.errorCode === 'REVISION_RESTORE_CONFIRMATION_REQUIRED'
      && requests.length === 0, declined.data)
    let missingError
    try { await execute('blender_revision_restore', argsFor('blender_revision_restore', { confirm: undefined })) }
    catch (error) { missingError = error }
    check('missing confirmation is rejected by the actual DSH wrapper before the Host',
      missingError?.code === 'INVALID_ARGS' && requests.length === 0, missingError?.message)

    const protectedRestore = await execute('blender_revision_restore', argsFor('blender_revision_restore', { expectedCurrentRevision: 'r0002' }))
    check('a confirmed restore forwards the exact expected revision to the Host without forwarding confirmation',
      protectedRestore.ok === true && JSON.stringify(requests[0]) === JSON.stringify({
        projectId: 'watch-commercial', revision: 'r0001', expectedCurrentRevision: 'r0002',
      }), requests[0])
    const legacy = await execute('blender_revision_restore', MINIMAL_ARGS.blender_revision_restore)
    check('older confirmed restore calls still omit the optional current-revision condition',
      legacy.ok === true && !Object.hasOwn(requests[1], 'expectedCurrentRevision'), requests[1])
    const stale = await execute('blender_revision_restore', argsFor('blender_revision_restore', { expectedCurrentRevision: 'r0000' }))
    check('a conditional restore preserves the Host conflict code and expected/current evidence',
      stale.ok === false && stale.data?.errorCode === code('REVISION_CONFLICT')
      && stale.data.detail.expectedCurrentRevision === 'r0000' && stale.data.detail.currentRevision === 'r0002', stale.data)
    check('restore conflicts ask for a fresh project read and review before another restore',
      /blender_project_get/.test(stale.text) && /review the intervening changes/.test(stale.text)
      && /expectedCurrentRevision/.test(stale.text) && !/re-issue the patch/.test(stale.text))
  } finally { studio.restoreRevision = original }
}

// ---------------------------------------------------------------------------
// Failures: a host that throws must become a coded result, never a stack the model reads
// ---------------------------------------------------------------------------

const failures = [
  ['blender_recipe_list', 'listRecipes', 'RECIPE_LIST_FAILED'],
  ['blender_project_create', 'createProject', 'PROJECT_CREATE_FAILED'],
  ['blender_project_get', 'getProject', 'PROJECT_READ_FAILED'],
  ['blender_scene_get', 'getScene', 'SCENE_READ_FAILED'],
  ['blender_scene_patch', 'applyScenePatch', 'SCENE_PATCH_FAILED'],
  ['blender_preview_render', 'renderPreview', 'PREVIEW_RENDER_FAILED'],
  ['blender_scene_validate', 'validateScene', 'SCENE_VALIDATE_FAILED'],
]

for (const [name, method, code] of failures) {
  const original = studio[method]
  studio[method] = async () => { throw new Error(`${method} exploded with no code of its own`) }
  const result = await execute(name, MINIMAL_ARGS[name])
  studio[method] = original
  check(`${name} turns an unrecognized host failure into ${code}`,
    result.ok === false && result.data?.errorCode === code && typeof result.data?.message === 'string' && result.data.message.length > 0,
    result.data ?? result.error)
  check(`${name} says the failure has no stable code, so a reader knows it is a bug and not a refusal`,
    /no stable code/.test(result.text ?? '') && (result.text ?? '').startsWith('DeepBlend call failed.\nerrorCode: ' + code),
    (result.text ?? '').split('\n').slice(0, 3))
}

// A coded failure keeps its own code: the tool's fallback is for failures that have none.
studio.applyScenePatch = async () => {
  throw new BlenderError(code('REVISION_CONFLICT'), 'the scene changed since r0001', { detail: { baseRevision: 'r0001' } })
}
const conflict = await execute('blender_scene_patch', MINIMAL_ARGS.blender_scene_patch)
check('a coded failure keeps its own code, and the tool does not overwrite it with its fallback',
  conflict.ok === false && conflict.data?.errorCode === code('REVISION_CONFLICT'),
  conflict.data)
check('a coded failure carries its detail through to the model',
  /detail:/.test(conflict.text ?? '') && /r0001/.test(conflict.text ?? ''))
check('and a revision conflict tells the model what to do about it',
  /Call blender_scene_get, then re-issue the patch with the revision it returns\./.test(conflict.text ?? ''))

// The two failures that are NOT the shared `renderFailure` shape: each of these tools builds its
// own result, so each needs its own case (and each was dark for the same reason as the six above).

studio.describeCapabilities = async () => { throw new Error('the probe could not start Blender') }
const probeFailed = await execute('blender_capabilities', MINIMAL_ARGS.blender_capabilities)
check('a capability probe that throws becomes CAPABILITY_PROBE_FAILED, with the cause as the message',
  probeFailed.ok === false && probeFailed.data?.errorCode === code('CAPABILITY_PROBE_FAILED') &&
  probeFailed.data.message === 'the probe could not start Blender',
  probeFailed.data ?? probeFailed.error)
check('and its text names the code, so a model reads the same diagnosis the canonical result carries',
  (probeFailed.text ?? '').startsWith(
    `Blender capability probe failed.\nerrorCode: ${code('CAPABILITY_PROBE_FAILED')}\nmessage:   the probe could not start Blender`,
  ),
  (probeFailed.text ?? '').split('\n').slice(0, 3))

studio.describeCapabilities = async () => {
  throw new BlenderError(code('NOT_FOUND'), 'no Blender at the configured path', { detail: { configured: '/nope/Blender' } })
}
const probeCoded = await execute('blender_capabilities', MINIMAL_ARGS.blender_capabilities)
check('a coded probe failure keeps its own code and carries its detail into the text',
  probeCoded.data?.errorCode === code('NOT_FOUND') &&
  /detail:    \{"configured":"\/nope\/Blender"\}/.test(probeCoded.text ?? ''),
  probeCoded.data)

studio.describeCapabilities = async () => ({ installed: true, hostApiVersion: 4 })
studio.visualReview = async () => { throw new Error('the render died before the sheet existed') }
const reviewFailed = await execute('blender_visual_review', MINIMAL_ARGS.blender_visual_review)
check('a visual review that throws becomes VISUAL_REVIEW_FAILED with no image, not with a stale one',
  reviewFailed.ok === false && reviewFailed.data?.errorCode === 'VISUAL_REVIEW_FAILED' &&
  reviewFailed.image === null && /no stable code/.test(reviewFailed.text ?? ''),
  reviewFailed.data ?? reviewFailed.error)

// ---------------------------------------------------------------------------
// The notes only some states produce
// ---------------------------------------------------------------------------

studio.createProject = async () => ({
  projectId: 'watch-commercial',
  title: 'Watch commercial',
  revision: { revision: 'r0001', digest: 'sha256:1111', kind: 'initial', checkpoint: null, previews: [] },
  warnings: [{ code: 'SCENE_COMPILER_DECISION', message: 'the camera was aimed at the subject automatically' }],
})
const noCheckpoint = await execute('blender_project_create', { ...MINIMAL_ARGS.blender_project_create, saveCheckpoint: false })
check('a revision committed without a checkpoint explains lazy compilation on its first preview',
  noCheckpoint.ok === true &&
  (noCheckpoint.text ?? '').includes('No checkpoint was saved. The first preview will compile this revision lazily.') &&
  !noCheckpoint.text.includes('checkpoint saved'),
  (noCheckpoint.text ?? '').split('\n').slice(0, 6))
check('compiler decisions made on the model\'s behalf are listed with their messages',
  (noCheckpoint.text ?? '').includes('Compiler notes (these describe decisions made on your behalf):') &&
  (noCheckpoint.text ?? '').includes('  - the camera was aimed at the subject automatically'))

const readOld = await execute('blender_project_get', { ...MINIMAL_ARGS.blender_project_get, revision: 'r0001' })
check('reading a revision the project no longer points at says so, and says where it still points',
  readOld.ok === true &&
  (readOld.text ?? '').includes('Read revision r0001; the project still points at r0002.') &&
  (readOld.text ?? '').includes('r0001  initial, checkpoint saved <- current') === false &&
  (readOld.text ?? '').includes('r0002  patch (no checkpoint) (1 preview) <- current'),
  (readOld.text ?? '').split('\n').filter(line => line.trim().startsWith('r000')))

check('a validation with no recorded technical report says why it is missing',
  (await execute('blender_scene_validate', MINIMAL_ARGS.blender_scene_validate)).text
    .includes('Technical: this revision has no recorded technical report (it was committed without a checkpoint).'))

// ---------------------------------------------------------------------------
// Hygiene: none of it may leak a JavaScript value into prose a model reads
// ---------------------------------------------------------------------------

/**
 * The PROSE, not the canonical JSON.
 *
 * Every tool result ends with a `Canonical JSON:` block, and `null` there is data — the fixture
 * genuinely has a revision with `checkpoint: null`. What must never carry a leaked value is the
 * part a model reads as sentences, which is everything before that block.
 */
const prose = text => (text ?? '').split('\nCanonical JSON:')[0]
const produced = [noCheckpoint.text, readOld.text, conflict.text, probeFailed.text, probeCoded.text, reviewFailed.text]
check('no prose these paths produce leaks undefined, null or NaN into sentences',
  produced.every(text => !/undefined|\bnull\b|NaN|\[object Object\]/.test(prose(text))),
  produced.map(text => prose(text).split('\n').find(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)))
    .filter(Boolean))
const canonical = text => {
  const start = (text ?? '').indexOf('Canonical JSON:')
  if (start === -1) return undefined
  try {
    return JSON.parse(text.slice(start + 'Canonical JSON:'.length))
  } catch {
    return undefined
  }
}
check('a successful result embeds its canonical JSON, so a caller never has to parse prose',
  [noCheckpoint.text, readOld.text].every(text => typeof canonical(text) === 'object' && canonical(text) !== null),
  [noCheckpoint.text, readOld.text].map(text => typeof canonical(text)))
// The other half of the same contract, and it is deliberately asymmetric: a FAILURE carries its
// canonical part as the result's own `data` (which is what a caller branches on) and puts only the
// code and the message in the prose. Asserting "every text has a JSON block" would have been wrong.
check('a failed result carries its canonical part as data, and says so in prose instead of embedding JSON',
  conflict.data?.errorCode === code('REVISION_CONFLICT') &&
  canonical(conflict.text) === undefined &&
  /^DeepBlend call failed\.\nerrorCode: REVISION_CONFLICT/.test(conflict.text ?? ''))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHAT THE MODEL IS TOLD ABOUT A RENDER: the four M3 tools, state by state
// ---------------------------------------------------------------------------

const renderHost = stubRenderHost()
const renderPlane = await composeToolPlane({ studio: renderHost, label: 'm3-tool-output', expectAtLeast: 16 })
const runRenderTool = async (name, args) => {
  const definition = renderPlane.registered.get(name)
  if (definition === undefined) return { ok: false, text: '', error: `${name} is not registered` }
  return definition.execute(args, { signal: undefined })
}

// An empty job list is a TRUE statement about a real project, and the tool has to say what to do next
// rather than print an empty list and let the model guess.
const emptyPlane = await composeToolPlane({
  studio: stubRenderHost({
    listJobs: async () => ({ projectId: 'watch-commercial', jobs: [], unfinished: [], recovery: [], recoveryError: null }),
  }),
  label: 'm3-tool-empty',
  expectAtLeast: 16,
})
const emptyJobs = await emptyPlane.registered.get('blender_job_status').execute({ projectId: 'watch-commercial' }, { signal: undefined })
check('a project with no render jobs is told so, with the tool that starts one',
  emptyJobs.ok !== false && emptyJobs.text.includes('This project has no render jobs yet. Start one with blender_final_render.'),
  emptyJobs.text?.split('\n').slice(0, 3))

const unfinished = await runRenderTool('blender_job_status', { projectId: 'watch-commercial' })
check('an unfinished job is named with the tool that continues it, instead of only being listed',
  unfinished.ok !== false && unfinished.text.includes('Unfinished: render-0001 — continue with blender_final_render {resumeJobId}.'),
  unfinished.text?.split('\n').filter(line => line.includes('Unfinished')))

// The reconciler's own failure rides on the SAME answer: "nothing was recovered" and "nothing was checked"
// must not read alike, and the second one is the difference between a quiet project and a broken index.
// Round 67 gave this field a real producer; this is the sentence the model reads because of it.
const brokenRecoveryPlane = await composeToolPlane({
  studio: stubRenderHost({
    listJobs: async () => ({
      projectId: 'watch-commercial', jobs: [], unfinished: [], recovery: [],
      recoveryError: 'the render journal index is unreadable',
    }),
  }),
  label: 'm3-tool-recovery',
  expectAtLeast: 16,
})
const brokenRecovery = await brokenRecoveryPlane.registered.get('blender_job_status').execute({ projectId: 'watch-commercial' }, { signal: undefined })
check('a job list whose reconciliation could not READ says so, and does not read as an empty project',
  brokenRecovery.ok !== false &&
  brokenRecovery.text.includes('Restart reconciliation reported an error: the render journal index is unreadable') &&
  brokenRecovery.text.includes('This project has no render jobs yet.'),
  brokenRecovery.text?.split('\n').filter(line => line.includes('reconciliation') || line.includes('no render jobs')))

// A resume where some frames are INCOMPLETE says which frames and why: "resuming 1 frame" alone would hide
// that one of them is being re-rendered because its bytes were short.
const resumableHost = stubRenderHost({
  resumeRenderJob: async () => ({
    jobId: 'render-0001', projectId: 'watch-commercial', revision: 'r0002',
    alreadyComplete: 2, resumed: 1, resumedFrames: [45], warnings: [],
    corrupt: [{ frame: 45, reason: 'byte count below the floor' }],
  }),
})
const resumePlane = await composeToolPlane({ studio: resumableHost, label: 'm3-tool-resume', expectAtLeast: 16 })
const resumed = await resumePlane.registered.get('blender_final_render').execute({ projectId: 'watch-commercial', resumeJobId: 'render-0001' }, { signal: undefined })
check('a resume that has to re-render an incomplete frame says which frame and why',
  resumed.ok !== false && resumed.text.includes('re-rendering:     1 incomplete frame(s): 45 (byte count below the floor)'),
  resumed.text?.split('\n').filter(line => line.includes('re-rendering')))

// The approval gate: the host refuses, the PLANE answers the refusal, and the reason it shows names the
// threshold it crossed — a refusal that says "not allowed" without the number is unanswerable.
const approvalHost = stubRenderHost({
  startFinalRender: async () => {
    throw new BlenderError(BlenderErrorCode.RENDER_APPROVAL_REQUIRED, 'Render job render-0002 needs an approval grant before it starts.', {
      detail: { frames: 1200, threshold: 900, frameStart: 1, frameEnd: 1200 },
    })
  },
})
let asked = null
const approvalPlane = await composeToolPlane({
  studio: approvalHost,
  label: 'm3-tool-approval',
  expectAtLeast: 16,
  services: {
    approval: {
      async request(request) {
        asked = request
        return 'rejected'
      },
    },
  },
})
const gated = await approvalPlane.registered.get('blender_final_render').execute(
  { projectId: 'watch-commercial' },
  { signal: undefined, agent: { id: 'contract-test-agent' }, callId: 'call-1' },
)
// The prompt is the other half: what the OPERATOR reads before saying yes or no. It names the frame
// count, the range and the threshold it is about to cross, plus the measured cost per frame — the numbers
// a person needs to answer, not a request to trust the tool.
check('an over-threshold render asks the operator, naming the cost it is about to spend',
  asked !== null && asked.toolName === 'blender_final_render' && asked.agent?.id === 'contract-test-agent' &&
  asked.reason.includes('Start a DELIVERY render of 1200 frame(s) (1..1200), above the configured approval threshold of 900.') &&
  asked.reason.includes('19.6-41.4 s per frame at 1920x1080 / Cycles / 256 samples') &&
  // AND THE ARITHMETIC IS DONE FOR THE READER (ledger C17). The sentence used to end at "hours of
  // machine time", which is true and useless: the person deciding has to multiply the frame count by
  // the rate themselves, and the frame count is the thing they chose.
  /about \d+(\.\d+)? (minutes|hours) to \d+(\.\d+)? (minutes|hours) of machine time/.test(asked.reason),
  asked?.reason?.split('. ').slice(0, 2))
check('and a declined approval leaves the model with the number it crossed and what was NOT started',
  gated.ok === false && /Nothing was started — no job, no frames\./.test(gated.text) &&
  /above the threshold of 900\./.test(gated.text) && gated.data?.errorCode === 'RENDER_APPROVAL_REFUSED' &&
  gated.data?.outcome === 'rejected' && gated.data?.threshold === 900,
  { code: gated.data?.errorCode, outcome: gated.data?.outcome, text: gated.text?.split('\n').slice(0, 3) })

// THE REVISION IS PART OF WHAT IS BEING APPROVED, and the re-issue is pinned to it. The refusal computed its
// frame plan for one revision; the schema documents `revision` as optional ("defaults to the project's current
// revision"), so re-issuing the same request after a human took time to answer could render a DIFFERENT revision
// — a patch landing in between is enough. The prompt says which revision, and the retry carries it.
let askedWithRevision = null
let reissuedWith = null
const revisionedPlane = await composeToolPlane({
  studio: stubRenderHost({
    startFinalRender: async request => {
      if (request?.approved !== true) {
        throw new BlenderError(BlenderErrorCode.RENDER_APPROVAL_REQUIRED, 'needs a grant', {
          detail: { frames: 1200, threshold: 900, frameStart: 1, frameEnd: 1200, revision: 'r0007' },
        })
      }
      reissuedWith = request
      return {
        jobId: 'render-0003', projectId: 'watch-commercial', revision: 'r0007', frames: 1200,
        frameStart: 1, frameEnd: 1200, warnings: [],
      }
    },
  }),
  label: 'm3-tool-approval-revision',
  expectAtLeast: 16,
  services: {
    approval: {
      async request(request) {
        askedWithRevision = request
        return 'allowed-once'
      },
    },
  },
})
await revisionedPlane.registered.get('blender_final_render').execute(
  { projectId: 'watch-commercial' },
  { signal: undefined, agent: { id: 'contract-test-agent' }, callId: 'call-2' },
)
// The operator sees the REASON: `requestApproval` sends `{ agent, toolName, callId, reason, signal }` and no
// structured detail (the detail is what the refusal's `data` carries back to the model), so the revision has to
// be in the sentence — which is where a person reads it anyway.
check('the approval prompt names the REVISION whose frames are being approved',
  askedWithRevision !== null && /of revision r0007, above the configured approval threshold of 900/.test(askedWithRevision.reason),
  askedWithRevision?.reason?.slice(0, 100))
check('and the granted retry renders THAT revision, not whatever the project points at by then',
  reissuedWith?.approved === true && reissuedWith?.revision === 'r0007',
  { approved: reissuedWith?.approved, revision: reissuedWith?.revision })

// The same prompt when the host reports a frame COUNT but no range: the sentence must drop the range rather
// than print "undefined..undefined" — this is the last line of the file's approval text, and the one a host
// that only counts frames would produce.
let askedWithoutRange = null
const countedOnlyPlane = await composeToolPlane({
  studio: stubRenderHost({
    startFinalRender: async () => {
      throw new BlenderError(BlenderErrorCode.RENDER_APPROVAL_REQUIRED, 'needs a grant', { detail: { frames: 1200, threshold: 900 } })
    },
  }),
  label: 'm3-tool-approval-no-range',
  expectAtLeast: 16,
  services: { approval: { async request(request) { askedWithoutRange = request; return 'allowed-once' } } },
})
const countedOnly = await countedOnlyPlane.registered.get('blender_final_render').execute(
  { projectId: 'watch-commercial' },
  { signal: undefined, agent: { id: 'contract-test-agent' }, callId: 'call-2' },
)
check('an approval prompt with a frame count but no range omits the range instead of printing undefined',
  askedWithoutRange !== null && countedOnly !== undefined &&
  askedWithoutRange.reason.startsWith('Start a DELIVERY render of 1200 frame(s), above the configured approval threshold of 900.') &&
  !askedWithoutRange.reason.includes('undefined'),
  askedWithoutRange?.reason?.split('Measured cost')[0])

// An export that ENCODED but could not publish is the one outcome where the video exists and must not be
// called a delivery: the tool says exactly that, and hands back the problems that made it refuse.
const unverifiedHost = stubRenderHost({
  exportProject: async () => ({
    projectId: 'watch-commercial', revision: 'r0002', verified: false,
    problems: [{ field: 'frameCount', claimed: 60, probed: 59 }],
    video: { path: 'output/final.mp4' },
  }),
})
const unverifiedPlane = await composeToolPlane({ studio: unverifiedHost, label: 'm3-tool-export', expectAtLeast: 16 })
const unverified = await unverifiedPlane.registered.get('blender_export').execute({ projectId: 'watch-commercial' }, { signal: undefined })
check('an export that encoded but did not verify says NOT published, and shows the disagreement',
  unverified.ok === false && unverified.text.startsWith('Delivery encoded but NOT published: its properties disagree with the job\'s own claims.') &&
  unverified.text.includes('"claimed": 60') && unverified.text.includes('"probed": 59'),
  unverified.text?.split('\n').slice(0, 2))

// A cancel that fails for a reason nobody classified is still a coded failure: the model gets a stable code
// and the message, never a stack.
const brokenCancel = stubRenderHost({
  cancelJob: async () => { throw new Error('the process table is unreadable') },
})
const cancelPlane = await composeToolPlane({ studio: brokenCancel, label: 'm3-tool-cancel', expectAtLeast: 16 })
const cancelFailure = await cancelPlane.registered.get('blender_job_cancel').execute({ projectId: 'watch-commercial', jobId: 'render-0001' }, { signal: undefined })
check('a cancel that throws an unclassified error becomes BLENDER_SCRIPT_ERROR with the message, not a stack',
  cancelFailure.ok === false && cancelFailure.data?.errorCode === code('SCRIPT_ERROR') &&
  cancelFailure.text.includes('the process table is unreadable'),
  { code: cancelFailure.data?.errorCode, text: cancelFailure.text?.split('\n')[0] })

// ---------------------------------------------------------------------------
// Every tool is INVOKED by at least one test, not merely named
// ---------------------------------------------------------------------------
//
// A tool that ships with no test is a surface nobody has driven — the "copy nobody runs" rule one level up. The
// detector below is deliberately generous (the suites use `callTool(registry, name, …)`, `call(name, …)` and
// `tools.get(name).execute(…)`) AND guarded: it asserts that it can see a tool known to be driven, because a
// pattern set that silently stops matching would make this check pass over nothing. That guard is not
// hypothetical — writing this by hand twice missed a shape: `callTool(registry, 'blender_asset_ingest', …)` in
// the M5 assets suite matched none of the first three patterns I tried, and the first version of this
// measurement reported a fully-driven tool as never invoked.
{
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.mjs')) files.push(path)
    }
  }
  walk('deepblend/tests')
  const sources = files.map(file => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }))
  const invokedBy = name => sources
    .filter(({ text }) => text.includes(`'${name}'`) && (
      text.includes('callTool(') || text.includes(`call('${name}'`) || text.includes(`get('${name}').execute`)
    ))
    .map(({ file }) => file)

  check('the invocation detector can see a tool that is definitely invoked (so it cannot pass over nothing)',
    invokedBy('blender_asset_ingest').length > 0, invokedBy('blender_asset_ingest'))

  const untested = UI_TOOL_CARD_KEYS.filter(name => invokedBy(name).length === 0)
  check('every registered tool is INVOKED by some test, not merely listed in a roster',
    untested.length === 0, untested)
}

// Independent inspections use the real DSH definition and its output contract.
{
  const args = { projectId: 'product', revision: 'r0003', cameraId: 'camera-detail', frame: 24, mode: 'clay', samples: 8, width: 1, height: 1 }
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifact = { kind: 'diagnostic', mode: 'clay', sourceRevision: 'r0003', sourceDigest: 'digest',
    viewId: 'inspection', cameraId: args.cameraId, frame: 24, width: 1, height: 1,
    bytes: bytes.length, sha256, mime: 'image/png', path: 'revisions/r0003/diagnostics/job/selected.png' }
  const receipt = { schemaVersion: 'deepblend.diagnostic/v1', projectId: 'product', revision: 'r0003',
    sourceRevision: 'r0003', sourceDigest: 'digest', mode: 'clay', artifacts: [artifact],
    limitations: ['Imported shader displacement may change rendered geometry.'], warnings: [] }
  let renderCalls = 0, readCalls = 0, saveCalls = 0, edits = 0, forwarded
  const attachmentStore = {
    async saveImage(input) {
      saveCalls++
      if (!input.data.equals(bytes)) throw new Error('wrong image bytes')
      return { attachmentId: 'inspection-1', mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1, name: input.name }
    },
  }
  const save = attachmentStore.saveImage
  const host = {
    hostApiVersion: () => 6,
    renderViews: async request => { renderCalls++; forwarded = request; return structuredClone(receipt) },
    readArtifact: async request => { readCalls++; return { path: request.path, contentType: 'image/png', bytes, size: bytes.length } },
    renderPreview: async request => ({ revision: 'r0003', profile: { engine: 'cycles' }, artifacts: [], request }),
    scoreVisualViews: () => { edits++; throw new Error('unexpected scoring') },
    visualReview: () => { edits++; throw new Error('unexpected review') },
    visualLoop: () => { edits++; throw new Error('unexpected loop') },
    applyScenePatch: () => { edits++; throw new Error('unexpected patch') },
    restoreRevision: () => { edits++; throw new Error('unexpected restore') },
  }
  const plane = await composeToolPlane({ studio: host, services: { attachments: attachmentStore }, label: 'inspection-output', expectAtLeast: 16 })
  const tool = plane.tools.get('blender_preview_render')
  const run = (input = args, signal) => plane.tools.execute({ name: 'blender_preview_render', arguments: input, callId: 'inspection', signal })
  const good = await run()
  check('fixed-view inspection routes to Host renderViews and attaches its verified PNG',
    good.isError === false && good.value?.ok === true && good.content.filter(block => block.type === 'image').length === 1 &&
    good.value.image?.attachmentId === 'inspection-1' && renderCalls === 1 && readCalls === 1 && saveCalls === 1)
  check('the inspection forwards exactly one explicit view, dimensions, samples and mode',
    JSON.stringify(forwarded) === JSON.stringify({ projectId: 'product', revision: 'r0003', mode: 'clay', width: 1, height: 1, samples: 8,
      views: [{ id: 'inspection', cameraId: 'camera-detail', frame: 24 }] }), forwarded)
  check('inspection data preserves provenance and limitations without image bytes or scores',
    JSON.stringify(good.value.data) === JSON.stringify(receipt) && !JSON.stringify(good.value).includes('"type":"Buffer"') &&
    /rebuilt from SceneSpec/.test(good.value.text) && /does not establish technical or artistic approval/.test(good.value.text))
  const snapshot = JSON.parse(JSON.stringify(good.value))
  check('actual DSH output validator accepts an attached inspection but refuses malformed image references',
    validateJsonSchemaValue(tool.output.schema, snapshot).length === 0 &&
    validateJsonSchemaValue(tool.output.schema, { ...snapshot, image: { attachmentId: 'bad' } }).length > 0)
  const beforeReplay = [renderCalls, readCalls, saveCalls]
  const replay = tool.output.render(args, snapshot)
  check('cold inspection replay emits the saved image reference with zero IO',
    JSON.stringify(replay) === JSON.stringify(good.content) && JSON.stringify(beforeReplay) === JSON.stringify([renderCalls, readCalls, saveCalls]))
  check('inspection presenter binds mode, revision, camera and frame',
    tool.presentCall(args)?.title === 'Render clay inspection of "product" · r0003 · camera-detail · frame 24' && tool.presentCall(args).kind === 'other')
  const badMode = await run({ ...args, mode: 'solid' })
  check('DSH rejects invalid inspection mode before invoking the Host', badMode.isError === true && renderCalls === 1)
  for (const key of ['revision', 'cameraId', 'frame']) {
    const incomplete = { ...args }; delete incomplete[key]
    const result = await run(incomplete)
    check(`inspection without explicit ${key} is refused before Host or attachment IO`,
      result.value?.data?.errorCode === 'RENDER_RANGE_INVALID' && renderCalls === 1 && readCalls === 1 && saveCalls === 1)
  }
  const render = host.renderViews, read = host.readArtifact
  const wrongReceipts = [
    ['mode', d => { d.mode = 'beauty' }], ['revision', d => { d.revision = 'r0004' }],
    ['source revision', d => { d.sourceRevision = 'r0004' }], ['project', d => { d.projectId = 'other' }],
    ['missing artifact', d => { d.artifacts = [] }], ['camera', d => { d.artifacts[0].cameraId = 'other' }],
    ['frame', d => { d.artifacts[0].frame = 1 }], ['artifact mode', d => { d.artifacts[0].mode = 'beauty' }],
    ['artifact digest', d => { d.artifacts[0].sourceDigest = 'other' }],
    ['image path', d => { d.artifacts[0].path = 'revisions/r0004/diagnostics/job/selected.png' }],
    ['traversing image path', d => { d.artifacts[0].path = 'revisions/r0003/diagnostics/../previews/selected.png' }],
  ]
  for (const [label, change] of wrongReceipts) {
    host.renderViews = async () => { const data = structuredClone(receipt); change(data); return data }
    const count = saveCalls
    const result = await run()
    check(`inspection rejects wrong ${label} without attaching a stale image`,
      result.value?.ok === false && result.value.data.errorCode === 'BLENDER_SCRIPT_ERROR' && saveCalls === count && result.content.every(b => b.type !== 'image'))
  }
  host.renderViews = render
  for (const [label, change] of [
    ['SHA', d => { d.bytes = Buffer.alloc(bytes.length) }], ['byte count', d => { d.size-- }],
    ['content type', d => { d.contentType = 'text/plain' }], ['path', d => { d.path = 'other.png' }],
  ]) {
    host.readArtifact = async request => { const data = await read(request); change(data); return data }
    const count = saveCalls, result = await run()
    check(`inspection verifies read artifact ${label} before attachment`, result.value?.ok === false && saveCalls === count)
  }
  host.readArtifact = async () => { throw new BlenderError(code('ARTIFACT_NOT_FOUND'), 'missing inspection') }
  check('missing inspection artifact retains its stable Host error code', (await run()).value?.data?.errorCode === code('ARTIFACT_NOT_FOUND'))
  host.readArtifact = read
  const controller = new AbortController(); controller.abort()
  const beforeAbort = [renderCalls, readCalls, saveCalls]
  const cancelled = await run(args, controller.signal)
  check('pre-cancelled inspection performs no Host or attachment IO', cancelled.value?.data?.errorCode === code('ABORTED') &&
    JSON.stringify(beforeAbort) === JSON.stringify([renderCalls, readCalls, saveCalls]))
  host.renderViews = async () => { throw new BlenderError(code('ABORTED'), 'render cancelled') }
  check('in-flight Host cancellation remains BLENDER_ABORTED', (await run()).value?.data?.errorCode === code('ABORTED'))
  host.renderViews = render
  for (const stage of ['render', 'read', 'save']) {
    const cancel = new AbortController(), count = saveCalls
    if (stage === 'render') host.renderViews = async request => { const d = await render(request); cancel.abort(); return d }
    if (stage === 'read') host.readArtifact = async request => { const d = await read(request); cancel.abort(); return d }
    if (stage === 'save') attachmentStore.saveImage = async input => { const d = await save(input); cancel.abort(); return d }
    const result = await run(args, cancel.signal)
    check(`cancellation after ${stage} does not emit an image or claim diagnostic deletion`,
      result.value?.data?.errorCode === code('ABORTED') && result.content.every(b => b.type !== 'image') &&
      /may remain/.test(result.value.text) && saveCalls === count + (stage === 'save' ? 1 : 0))
    host.renderViews = render; host.readArtifact = read; attachmentStore.saveImage = save
  }
  for (const [label, saver] of [
    ['absent', undefined], ['failed', async () => { throw new Error('store offline') }],
    ['invalid reference', async () => ({ attachmentId: 'bad', mediaType: 'image/png', bytes: bytes.length, width: 2, height: 1 })],
    ['missing attachment id', async () => ({ mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1 })],
  ]) {
    attachmentStore.saveImage = saver
    const count = renderCalls, result = await run()
    check(`attachment store ${label} keeps completed inspection data and clearly reports no image`,
      result.value?.ok === true && result.value.image === null && validateJsonSchemaValue(tool.output.schema, result.value).length === 0 && result.content.every(b => b.type !== 'image') &&
      /model cannot see it/.test(result.value.text) && renderCalls === count + 1 && JSON.stringify(result.value.data) === JSON.stringify(receipt))
  }
  attachmentStore.saveImage = save
  for (const version of [6, 7]) {
    host.hostApiVersion = () => version
    check(`Host API ${version} supports explicit inspections`, (await run()).value?.ok === true)
  }
  host.hostApiVersion = () => 5
  const { mode, ...legacyArgs } = args
  const legacy = await run(legacyArgs)
  check('omitting mode preserves normal preview on an older Host without an attachment', legacy.value?.ok === true &&
    !('image' in legacy.value) && legacy.content.length === 1 && legacy.value.data.request.revision === 'r0003' &&
    tool.presentCall(legacyArgs).title === 'Render preview of "product" from camera-detail')
  check('inspections never invoke scoring, review, automatic edits or restore', edits === 0)
}

const passed = results.filter(entry => entry.ok).length
console.log(`\nM1 tool output contract: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
