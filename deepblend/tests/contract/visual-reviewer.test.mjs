#!/usr/bin/env node
/**
 * The built-in vision reviewer: the prompt it sends, the answer it demands, and what it does when
 * the model says nothing.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `createVisualReviewer()` is the product's own model-facing component — it is what turns "a contact
 * sheet exists" into "a second opinion about the render". Everything the score cannot say passes
 * through it, and 55 of its lines had never been executed by any suite, because the only way to reach
 * them was a real model call on a real render. The REVIEW it consumes can be built from measurements
 * (that is what `contract/visual-loop.test.mjs` does), but the CALL itself cannot.
 *
 * So the two services the reviewer resolves per call — `llm` and `attachments` — are stubs here. That
 * makes every guard reachable and deterministic, and the guards are the point:
 *
 *   - a missing `llm` or `attachments` service is a coded refusal, not a TypeError;
 *   - a model call that FAILS is reported with the provider's own message;
 *   - **an empty answer is a FAILURE, not a review with nothing to say** — the two are
 *     indistinguishable downstream (both yield zero findings), and reporting the second as the first
 *     would let a broken reviewer silently approve every scene it was shown. That is the single most
 *     valuable check in this file.
 *
 * The prompt itself is asserted too: it is the only place the product tells a vision model what it is
 * looking at, which measurements are FACTS, and which findings will be thrown away. Two of its
 * branches (a review WITH measured issues, and an answer that is not valid JSON) were dark as well.
 *
 * Run standalone: `node deepblend/tests/contract/visual-reviewer.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig, buildReviewerPrompt, parseReviewerAnswer } from '@deepblend/dsh-blender-host'

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
// The host, with only the two seams the reviewer uses
// ---------------------------------------------------------------------------

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-reviewer-'))
const savedImages = []
const streamed = []

/** An `llm` service whose chunks the test dictates. */
function llmService(chunks) {
  return {
    stream(input) {
      streamed.push(input)
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const attachmentsService = {
  async saveImage(input) {
    savedImages.push(input)
    return { id: 'attachment-1', mediaType: input.mediaType, name: input.name }
  },
}

function studioWith({ llm = llmService([]), attachments = attachmentsService, config = {} } = {}) {
  const ctx = new Context()
  ctx.provide('blenderRuntime', {})
  if (llm !== null) ctx.provide('llm', llm)
  if (attachments !== null) ctx.provide('attachments', attachments)
  return new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'), ...config }))
}

// ---------------------------------------------------------------------------
// The review and the sheet the reviewer is handed
// ---------------------------------------------------------------------------

const sheetPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const issues = [
  {
    id: 'measured-1', category: 'occlusion', code: 'SUBJECT_OCCLUDED', severity: 'critical', viewId: 'three-quarter',
    objectId: 'watch-body', evidence: 'only 0.200 of "watch-body"\'s own silhouette survives in this view',
    measurements: {}, confidence: 1, suggestedOperations: [],
  },
  {
    id: 'measured-2', category: 'exposure', code: 'FRAME_UNDEREXPOSED', severity: 'major', viewId: 'front',
    objectId: null, evidence: 'the frame reads dark against the exposure floor', measurements: {}, confidence: 1,
    suggestedOperations: [],
  },
]

const review = {
  schemaVersion: 'deepblend.visual-review/v1',
  projectId: 'watch-commercial',
  revision: 'r0002',
  digest: 'sha256:2222',
  iteration: 1,
  score: 82,
  pass: false,
  perView: [{ viewId: 'three-quarter', score: 82 }, { viewId: 'front', score: 82 }],
  issues,
  viewCount: 2,
  subjectId: 'watch-body',
  sheet: {
    path: 'revisions/r0002/contact-sheets/round-1.png',
    width: 1280, height: 720, columns: 2, rows: 1,
    placements: [{ viewId: 'three-quarter', row: 0, column: 0 }, { viewId: 'front', row: 0, column: 1 }],
  },
}

const views = [
  {
    viewId: 'three-quarter', cameraId: 'camera-main', frame: 60, purpose: 'a 45-degree reading of the subject',
    luminance: { mean: 0.4, p05: 0.1, p95: 0.8, clippedDarkFraction: 0.01, clippedBrightFraction: 0.02 },
    objects: [{ id: 'watch-body', visiblePixels: 4000, silhouettePixels: 20000, bbox: [0.2, 0.2, 0.8, 0.8], centroid: [0.5, 0.5], inFrame: true }],
  },
  {
    viewId: 'front', cameraId: 'camera-front', frame: 60,
    luminance: { mean: 0.08, p05: 0.02, p95: 0.2, clippedDarkFraction: 0.3, clippedBrightFraction: 0 },
    objects: [],
  },
]

// ---------------------------------------------------------------------------
// The prompt: the only place the product teaches the model what it is looking at
// ---------------------------------------------------------------------------

const prompt = buildReviewerPrompt(review, views)
check('the prompt places every view on the sheet, by cell, so a finding can name one',
  prompt.includes('cell (row 1, column 1) = view "three-quarter", camera camera-main, frame 60 — a 45-degree reading of the subject') &&
  prompt.includes('cell (row 1, column 2) = view "front", camera camera-front, frame 60'),
  prompt.split('\n').filter(line => line.startsWith('  cell ')))
check('the prompt labels the measurements as FACTS, per view and per object',
  prompt.includes('Measurements taken from the rendered pixels (these are facts, not estimates):') &&
  prompt.includes('view "three-quarter": mean luminance 0.4, p05 0.1, p95 0.8, clipped dark 0.01, clipped bright 0.02') &&
  prompt.includes('object "watch-body": 4000 visible px of 20000 silhouette px, bbox [0.2,0.2,0.8,0.8], centroid [0.5,0.5], fully inside frame: true'))
check('a view with no tracked object contributes its luminance and nothing invented',
  prompt.includes('view "front": mean luminance 0.08') &&
  !prompt.includes('object "undefined"'))
check('the prompt tells the model that a finding naming an unknown view is DISCARDED',
  prompt.includes('A finding whose viewId is not one of the views above is DISCARDED, so name a real view.'))
check('the prompt lists the operations it may propose, and says an empty list is valid',
  prompt.includes('      camera.update {cameraId, lens?, transform?, targetEntityId?, targetPoint?}') &&
  prompt.includes('An empty list is a valid answer.'))
check('with measured issues the prompt lists them with their severity, view, object and evidence',
  prompt.includes('An automated scorer measured 2 problem(s) and scored this 82/100:') &&
  prompt.includes('  [critical] SUBJECT_OCCLUDED in view "three-quarter" on "watch-body": only 0.200 of "watch-body"\'s own silhouette survives in this view') &&
  prompt.includes('  [major] FRAME_UNDEREXPOSED in view "front": the frame reads dark against the exposure floor'),
  prompt.split('\n').filter(line => line.startsWith('  [')).slice(0, 3))
check('a clean review says "(none)" instead of printing an empty list',
  buildReviewerPrompt({ ...review, issues: [], score: 100 }, views).includes('An automated scorer measured 0 problem(s) and scored this 100/100:\n  (none)'))
// The prompt is allowed exactly ONE `null`, and it is not a leak: the JSON shape the model is told
// to answer in documents `"objectId"` as nullable. A check that simply banned the word would be
// asserting that the product may not describe its own format.
const nullLines = prompt.split('\n').filter(line => /null/.test(line))
check('the prompt leaks no JavaScript value, and its only `null` is the documented JSON value',
  !/undefined|NaN|\[object Object\]/.test(prompt) &&
  nullLines.length === 1 && nullLines[0].includes('"objectId": "<object id or null>"'),
  nullLines)

// ---------------------------------------------------------------------------
// The parser: models wrap JSON in prose and fences even when told not to
// ---------------------------------------------------------------------------

check('parseReviewerAnswer extracts JSON out of the prose and fences a model adds anyway',
  JSON.stringify(parseReviewerAnswer('Sure! Here it is:\n```json\n{"findings":[{"category":"occlusion"}],"operations":[],"note":"moved it"}\n```\nHope that helps.')) ===
  JSON.stringify({ findings: [{ category: 'occlusion' }], operations: [], note: 'moved it' }))
check('a reply with braces that are not valid JSON yields an empty review rather than a crash',
  JSON.stringify(parseReviewerAnswer('{"findings": [ {oops} ]}')) ===
  JSON.stringify({ findings: [], operations: [], note: null }))
check('a reply with no JSON at all yields an empty review, which the loop reads as "nothing to do"',
  JSON.stringify(parseReviewerAnswer('I could not see the sheet.')) ===
  JSON.stringify({ findings: [], operations: [], note: null }))
check('a JSON reply of the wrong shape still yields arrays and a null note',
  JSON.stringify(parseReviewerAnswer('{"findings": "lots", "operations": 3, "note": 7}')) ===
  JSON.stringify({ findings: [], operations: [], note: null }))

// ---------------------------------------------------------------------------
// The call: every guard, with the two services stubbed
// ---------------------------------------------------------------------------

const reviewerRequest = { review, sheetPng, views, iteration: 1, signal: undefined }

async function refusalFrom(studio) {
  try {
    await studio.createVisualReviewer()(reviewerRequest)
    return null
  } catch (cause) {
    return cause
  }
}

const noLlm = await refusalFrom(studioWith({ llm: null }))
const noAttachments = await refusalFrom(studioWith({ attachments: null }))
check('a reviewer composed without `llm` refuses with a stable code, naming which service is missing',
  noLlm instanceof BlenderError && noLlm.code === code('RUNTIME_UNAVAILABLE') &&
  noLlm.detail?.llm === false && noLlm.detail?.attachments === true,
  noLlm?.detail ?? noLlm?.message)
check('and so does one composed without `attachments`',
  noAttachments instanceof BlenderError && noAttachments.code === code('RUNTIME_UNAVAILABLE') &&
  noAttachments.detail?.llm === true && noAttachments.detail?.attachments === false,
  noAttachments?.detail ?? noAttachments?.message)

// ---- the happy path, and what it hands the model --------------------------
savedImages.length = 0
streamed.length = 0
const answer = '{"findings":[{"category":"occlusion","viewId":"three-quarter","objectId":"watch-body","severity":"critical","confidence":0.9,"evidence":"the dial is behind the case"}],"operations":[{"op":"entity.transform.update","entityId":"watch-body","location":[0,0,0]}],"note":"moved the body forward"}'
const success = await studioWith({
  llm: llmService([
    { type: 'text-delta', text: answer.slice(0, 40) },
    { type: 'text-delta', text: answer.slice(40) },
    { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]),
}).createVisualReviewer()(reviewerRequest)

check('a normal answer comes back as findings, operations and a note, with the model that produced it',
  success.findings.length === 1 && success.findings[0].category === 'occlusion' &&
  success.operations.length === 1 && success.operations[0].entityId === 'watch-body' &&
  success.note === 'moved the body forward' && success.model === 'deepseek-flash' && success.provider === 'deepseek-official',
  { findings: success.findings.length, operations: success.operations.length, note: success.note })
check('the raw answer is kept, so a review can be audited after the fact',
  success.raw === answer)
check('the sheet is persisted BEFORE the model is asked, at a name carrying the revision and the round',
  savedImages.length === 1 && savedImages[0].mediaType === 'image/png' &&
  savedImages[0].name === 'contact-sheet-r0002-r1.png' && Buffer.compare(savedImages[0].data, sheetPng) === 0,
  savedImages.map(entry => entry.name))
check('the model is sent one message holding the prompt AND the sheet, not the prompt alone',
  streamed.length === 1 && streamed[0].messages.length === 1 &&
  streamed[0].messages[0].content[0].type === 'text' &&
  streamed[0].messages[0].content[0].text === prompt &&
  streamed[0].messages[0].content[1].type === 'image' &&
  streamed[0].messages[0].content[1].attachment?.id === 'attachment-1',
  streamed[0]?.messages?.[0]?.content?.map(part => part.type))
check('the call carries the configured provider, model and token budget',
  streamed[0].provider === 'deepseek-official' && streamed[0].model === 'deepseek-flash' &&
  streamed[0].maxTokens === StudioConfig({ workspaceRoot }).visualReviewMaxTokens,
  { provider: streamed[0].provider, model: streamed[0].model, maxTokens: streamed[0].maxTokens })

// ---- the two failures the loop must never mistake for a quiet scene -------
const errored = await refusalFrom(studioWith({
  llm: llmService([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'the provider refused the request' } } }]),
}))
check('a model call that FAILS is reported with the provider\'s own message and a stable code',
  errored instanceof BlenderError && errored.code === code('RUNTIME_UNAVAILABLE') &&
  errored.message.includes('the provider refused the request') && errored.detail?.code === 'RATE_LIMIT',
  errored?.message)

const empty = await refusalFrom(studioWith({
  llm: llmService([{ type: 'usage', usage: { inputTokens: 1200, outputTokens: 24000 } }, { type: 'finish', reason: { kind: 'length' } }]),
}))
check('an EMPTY answer is a failure, not a review with nothing to say',
  empty instanceof BlenderError && empty.code === code('RUNTIME_UNAVAILABLE') &&
  empty.message.includes('returned an empty answer, so no review took place'),
  empty?.message)
check('and the empty-answer failure carries what the model route actually did, so it can be diagnosed',
  empty.detail?.finish === 'length' && empty.detail?.chunkCount === 2 &&
  empty.detail?.usage?.outputTokens === 24000 && empty.message.includes('finish=length, chunks=2, types=usage/finish'),
  empty?.detail)
check('whitespace is as empty as nothing: a reply of spaces does not become an approval',
  (await refusalFrom(studioWith({ llm: llmService([{ type: 'text-delta', text: '   \n  ' }, { type: 'finish', reason: { kind: 'stop' } }]) }))) !== null)

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nVisual reviewer contract: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
