#!/usr/bin/env node
/**
 * What the three planes say when a DEPENDENCY IS MISSING or a value cannot be represented.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every one of these branches is a sentence a model or an operator reads on a machine that is not the
 * developer's: no attachment store (so the image cannot be shown), no approval service (so nobody can
 * be asked), a probe that failed, a route that answered the wrong code, a Blender that is not composed
 * at all. They are the answers a well-equipped machine never produces, which is why they were dark —
 * the suites that drive these planes all run with every dependency present.
 *
 * The three planes are exercised the way the product composes them:
 *
 *   - the TOOL plane's shared helpers, called directly (they are the boundary's own functions);
 *   - the four M3 tools through the tool harness with NO `blenderStudio` composed, which is a real
 *     deployment state: the host bundle is not installed and the model must be told exactly that;
 *   - the UI plane's error mapping and its settings card when the probe throws.
 *
 * MOVED, NOT DELIBERATELY UNCOVERED ANY MORE: this file used to say that the two `readRequestBody`
 * refusals (an oversized body, a body that is not a JSON object) and the HTTP-level wrap that turns an
 * unknown throw into `UI_REQUEST_FAILED` sit behind the dispatch, "which only the browser suite reaches".
 * That was a statement about the SUITE and not about the code: `composition/ui-plane.e2e.mjs` already
 * drives the registered handler with Node-shaped requests and responses, so all three have been asserted
 * there since round 80 — no browser and no server needed. The claim is kept here, corrected, because a
 * stale "cannot be reached" is how a branch stays untested for another twenty rounds.
 *
 * Run standalone: `node deepblend/tests/contract/dependency-absent-answers.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'

import { BlenderError, BlenderErrorCode, warning } from '@deepblend/dsh-blender-contracts'
import { canonicalData, losslessJson, persistImage, requestApproval } from '@deepblend/dsh-blender-tool'
import { CAPABILITIES_ROUTE, createHandlers, statusForError } from '@deepblend/dsh-blender-ui'

import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

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

// ---------------------------------------------------------------------------
// The tool plane: an image with nowhere to go
// ---------------------------------------------------------------------------

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])

const noStore = await persistImage(undefined, png, 'contact-sheet.png')
check('an image rendered on a host with no attachment store says WHERE it is instead of attaching nothing',
  noStore.image === null &&
  noStore.note === 'The rendered image could not be attached to this result because the host has no attachment store, ' +
    'so the model cannot see it here. Its path is in the payload; read it with a file-read tool instead.',
  noStore)
check('and it does not pretend to have saved anything', !('ref' in noStore) && !('bytes' in noStore), Object.keys(noStore))

const saved = await persistImage({
  async saveImage(input) {
    return { attachmentId: 'attachment-1', mediaType: input.mediaType, bytes: input.data.length, width: 640, height: 360, name: input.name }
  },
}, png, 'contact-sheet.png')
check('with a store, the same call returns a REFERENCE — ids and dimensions, never bytes',
  saved.note === null && saved.image?.attachmentId === 'attachment-1' &&
  saved.image?.bytes === png.length && saved.image?.width === 640 && saved.image?.height === 360 &&
  saved.image?.name === 'contact-sheet.png' && !('data' in (saved.image ?? {})),
  saved)

// ---------------------------------------------------------------------------
// The tool plane: a value the harness cannot carry
// ---------------------------------------------------------------------------

const repaired = losslessJson({
  rotation: -0,
  scale: [1, Number.NaN, Number.POSITIVE_INFINITY],
  missing: undefined,
  nested: { ok: 1 },
})
check('a value with no JSON representation is repaired rather than thrown away',
  repaired.value.rotation === 0 && repaired.value.scale[1] === null && repaired.value.scale[2] === null &&
  !('missing' in repaired.value) && repaired.value.nested.ok === 1,
  repaired.value)
check('and every repair is REPORTED with its path and its kind, so a producer can be found',
  repaired.repairs.length === 3 &&
  repaired.repairs.every(repair => typeof repair.path === 'string') &&
  JSON.stringify(repaired.repairs.map(repair => repair.kind).sort()) === JSON.stringify(['infinite', 'nan', 'undefined']),
  repaired.repairs)
check('negative zero is silently normalised (it is an arithmetic artefact, not a defect)',
  repaired.repairs.every(repair => repair.kind !== '-0') && repaired.value.rotation === 0)

const canonical = canonicalData({ value: Number.NaN }, warning)
check('the canonical payload carries ONE warning naming the count, the kinds and the first path',
  canonical.warnings.length === 1 && canonical.warnings[0].code === 'VALUE_NOT_REPRESENTABLE' &&
  canonical.warnings[0].detail?.count === 1 &&
  JSON.stringify(canonical.warnings[0].detail?.kinds) === JSON.stringify(['nan']) &&
  canonical.warnings[0].detail?.firstPath === 'value' &&
  /1 value\(s\) in this result had no JSON representation and were replaced \(nan\); the first was at "value"\./.test(canonical.warnings[0].message) &&
  /This is a defect in whatever produced the value, not in the request that returned it\./.test(canonical.warnings[0].message),
  canonical.warnings[0]?.message)
check('and a payload that needs no repair produces no warning at all',
  canonicalData({ value: 1 }, warning).warnings.length === 0)

// ---------------------------------------------------------------------------
// The tool plane: an approval nobody can be asked for
// ---------------------------------------------------------------------------

const ask = {
  toolName: 'blender_final_render',
  reason: 'a 900-frame delivery',
  refusal: 'Nothing was rendered.',
  refusalCode: 'RENDER_APPROVAL_REQUIRED',
  detail: { frames: 900 },
}
const noService = await requestApproval(new Context(), { agent: { id: 'a' } }, ask)
check('with no approval service composed, the refusal says there was nobody to ask',
  noService.granted === false && noService.refusal.data.outcome === 'unavailable' &&
  noService.refusal.data.errorCode === 'RENDER_APPROVAL_REQUIRED' &&
  noService.refusal.text.includes('This deployment composes no approval service, so there was no one to ask.') &&
  noService.refusal.text.includes('Nothing was rendered.'),
  noService.refusal.text)
check('and the caller\'s own detail rides along, so the refusal names the cost it was about',
  noService.refusal.data.frames === 900)

const noAgentCtx = new Context()
noAgentCtx.provide('approval', { async request() { return 'allowed-once' } })
const noAgent = await requestApproval(noAgentCtx, {}, ask)
check('a call with no agent identity is refused rather than approved: an unlogged grant is not a grant',
  noAgent.granted === false && noAgent.refusal.data.outcome === 'unavailable' &&
  noAgent.refusal.text.includes('This call carries no agent identity, and an approval must be logged against one.'),
  noAgent.refusal.text)
check('and a service that could not even record the question is treated as unavailable, not as a yes',
  (await requestApproval(
    (() => { const ctx = new Context(); ctx.provide('approval', { async request() { throw new Error('no turn is open') } }); return ctx })(),
    { agent: { id: 'a' } },
    ask,
  )).refusal.text.includes('The approval could not be requested: no turn is open'))
check('while an explicit grant is the only thing that approves',
  (await requestApproval(noAgentCtx, { agent: { id: 'a' } }, ask)).granted === true)

const rejectingCtx = new Context()
rejectingCtx.provide('approval', { async request() { return 'rejected' } })
const rejected = await requestApproval(rejectingCtx, { agent: { id: 'a' } }, ask)
check('and every outcome that is not "allowed-once" is a refusal, named by the outcome it was',
  rejected.granted === false && rejected.refusal.data.outcome === 'rejected' &&
  rejected.refusal.text.includes('The operator declined, cancelled, or the prompt was unavailable.'),
  rejected.refusal.data)

// ---------------------------------------------------------------------------
// The tool plane: no host bundle installed at all
// ---------------------------------------------------------------------------

// A REAL deployment state: the preset is installed and the host bundle is not, so `blenderStudio` is
// absent and every M3 tool must describe the deployment instead of throwing.
const { tools } = await composeToolPlane({ studio: undefined, label: 'no-host-harness', expectAtLeast: 16 })
const execute = async (name, args) => {
  const definition = tools.get(name)
  return definition === undefined ? { ok: false, text: '', error: `${name} not registered` } : definition.execute(args, { signal: undefined })
}

const unavailable = [
  ['blender_final_render', { projectId: 'p' }, 'Delivery render unavailable.'],
  ['blender_export', { projectId: 'p' }, 'Delivery export unavailable.'],
  ['blender_job_status', { projectId: 'p' }, 'Job status unavailable.'],
  ['blender_job_cancel', { projectId: 'p', jobId: 'render-0001' }, 'Job cancellation unavailable.'],
]
for (const [name, args, headline] of unavailable) {
  const result = await execute(name, args)
  check(`${name} without a composed host says the DEPLOYMENT is missing, not that the request was wrong`,
    result.ok === false && (result.text ?? '').startsWith(headline) &&
    /BLENDER_RUNTIME_UNAVAILABLE/.test(result.text ?? '') &&
    /Add "@deepblend\/dsh-blender-bundle" to the profile's dsh\.profile\.bundles and restart the profile\./.test(result.text ?? '') &&
    result.data?.code === code('RUNTIME_UNAVAILABLE') &&
    result.data?.detail?.missingService === 'blenderStudio',
    (result.text ?? '').split('\n').slice(0, 3))
}

// ---------------------------------------------------------------------------
// The UI plane: the error mapping, and a settings card when the probe fails
// ---------------------------------------------------------------------------

const statusCases = [
  ['PROJECT_NOT_FOUND', 404], ['REVISION_NOT_FOUND', 404], ['RENDER_JOB_NOT_FOUND', 404],
  ['ARTIFACT_NOT_FOUND', 404], ['UI_ROUTE_NOT_FOUND', 404],
  ['PATH_OUTSIDE_WORKSPACE', 400], ['SCENE_PATCH_INVALID', 400],
  ['RENDER_JOB_CONFLICT', 409],
]
for (const [name, expected] of statusCases) {
  check(`${name} becomes HTTP ${expected}`,
    statusForError(new BlenderError(code(name), 'because')) === expected,
    statusForError(new BlenderError(code(name), 'because')))
}
check('and a code the UI does not recognise is a 500, not a guess',
  statusForError(new BlenderError(code('SCRIPT_ERROR'), 'because')) === 500 &&
  statusForError(new BlenderError(code('ENCODE_FAILED'), 'because')) === 500)

const uiCtx = new Context()
uiCtx.provide('blenderStudio', { async describeCapabilities() { throw new Error('the probe could not start Blender') } })
const handlers = createHandlers(uiCtx)
const capabilities = await handlers.capabilities({ query: {} })
check('a failed probe is returned as a STRUCTURED error, so the settings card renders the reason',
  capabilities.card === null && capabilities.data === null &&
  capabilities.error.code === code('CAPABILITY_PROBE_FAILED') &&
  capabilities.error.message === 'the probe could not start Blender',
  capabilities.error)

const codedCtx = new Context()
codedCtx.provide('blenderStudio', { async describeCapabilities() { throw new BlenderError(code('NOT_FOUND'), 'no Blender at that path') } })
check('and a CODED probe failure keeps its own code rather than being relabelled',
  (await createHandlers(codedCtx).capabilities({ query: {} })).error.code === code('NOT_FOUND'))

// The route the browser keys on; the panel id is pinned by `contract/ui-api.test.mjs`, which owns the
// card and panel surface.
check('the settings route is the one the UI plane publishes',
  CAPABILITIES_ROUTE === '/deepblend/capabilities', CAPABILITIES_ROUTE)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nDependency-absent answers: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
