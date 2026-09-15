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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

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

// ---------------------------------------------------------------------------
// Failures: a host that throws must become a coded result, never a stack the model reads
// ---------------------------------------------------------------------------

const failures = [
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
check('a revision committed without a checkpoint says that it cannot be previewed yet',
  noCheckpoint.ok === true &&
  (noCheckpoint.text ?? '').includes('No checkpoint was saved, so this revision cannot be previewed until a later revision saves one.') &&
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

const passed = results.filter(entry => entry.ok).length
console.log(`\nM1 tool output contract: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
