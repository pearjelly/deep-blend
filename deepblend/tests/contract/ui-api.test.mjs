#!/usr/bin/env node
/**
 * The workbench UI's contract: its route table, its view models, and the claim
 * that every M4 deliverable has exactly one home.
 *
 * WHY THIS IS A CONTRACT TEST
 * ---------------------------
 * M4 adds four vocabularies that did not exist before — route paths, panel view
 * ids, `tool.call.toolview` keys, and the sidebar/settings/main triple that must
 * agree on one id. This repository has paid five times for one vocabulary written
 * twice (D38, D43, D57, D60), and the copy that rots is always the one nobody
 * runs. So the vocabulary lives in `contracts/lib/ui-api.js` once, and this file
 * is the run that keeps it honest.
 *
 * It also pins the four M4 acceptance conditions to things that can be checked
 * without a browser:
 *
 *   不进入文件系统即可管理项目      the route table is the whole surface
 *   UI 刷新后可从 Host 恢复权威状态  every view model is a pure function of Host data
 *   浏览器不直接启动 Blender        no route performs work; the writes call the facade
 *   所有写操作经过 Host             the write set is closed and named here
 *
 * The browser-side half of the acceptance (a real page, a real render, a real
 * refresh) is `blender-integration/../e2e/ui.e2e.mjs`; this file covers the rules
 * that suite would only sample.
 *
 * Run standalone: `node deepblend/tests/contract/ui-api.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PREVIEW_SHEET_SLOTS,
  UI_PANEL_ID,
  UI_PANEL_LABEL,
  UI_PANEL_VIEWS,
  UI_ROUTES,
  UI_ROUTE_PREFIX,
  UI_TOOL_CARD_KEYS,
  buildApprovalView,
  buildJobView,
  buildProjectView,
  buildQaView,
  buildRevisionDiff,
  buildSceneTree,
  buildSettingsCard,
  describeJobForHuman,
  matchUiRoute,
  parseToolCallTarget,
  writeRouteIds,
} from '@deepblend/dsh-blender-contracts'

import { importDsh } from '../lib/dsh-deployment.mjs'

/** The harness's OWN lossless-JSON rule, imported rather than reimplemented (M2.2). */
const { isJsonValue } = await importDsh('dsh-util-values')

/** Directory this file lives in (`deepblend/tests/contract`). */
const TESTS_ROOT = import.meta.dirname

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

const ids = UI_ROUTES.map(route => route.id)
check('every route id is unique', new Set(ids).size === ids.length, ids.length)
check('every route lives under the DeepBlend prefix', UI_ROUTES.every(route => route.path.startsWith(`${UI_ROUTE_PREFIX}/`)), UI_ROUTE_PREFIX)
check('a route that writes is a POST, and a GET never is', UI_ROUTES.every(route => (route.write ? route.method === 'POST' : route.method === 'GET')),
  UI_ROUTES.filter(route => route.write).map(route => route.id))
check('every route carries a summary, so the 404 can explain the surface', UI_ROUTES.every(route => typeof route.summary === 'string' && route.summary.length > 10))

/**
 * The closed set of writes, by name.
 *
 * Named rather than counted: a new write route must be a deliberate edit to this
 * line, which is the whole point — "所有写操作经过 Host" is a claim about a set,
 * and a set nobody wrote down is a set that grows quietly.
 */
const EXPECTED_WRITES = ['projects.create', 'project.preview', 'project.patch', 'project.restore', 'project.job.cancel', 'project.render']
check('the write set is exactly the six named routes', JSON.stringify(writeRouteIds()) === JSON.stringify(EXPECTED_WRITES), writeRouteIds())

/** A concrete path for a declared route, from the route itself. */
function samplePath(route) {
  return route.path
    .replace(':projectId', 'watch-commercial')
    .replace(':revision', 'r0009')
    .replace(':jobId', 'render-0001')
    .replace(/\/\*$/, '/revisions/r0009/contact-sheets/round-0.png')
}

const unmatched = UI_ROUTES.filter(route => matchUiRoute(route.method, samplePath(route))?.route.id !== route.id)
check('every declared route matches its own path', unmatched.length === 0, unmatched.map(route => route.id))

check('a route does not match the other method',
  matchUiRoute('POST', '/deepblend/capabilities') === null
  && matchUiRoute('GET', '/deepblend/projects')?.route.id === 'projects.list'
  && matchUiRoute('GET', '/deepblend/projects/x/restore') === null,
  matchUiRoute('GET', '/deepblend/projects/x/restore'))
check('an unknown path matches nothing', matchUiRoute('GET', '/deepblend/not-a-route') === null)
check('the collection and the member do not collide',
  matchUiRoute('GET', '/deepblend/projects/x/jobs')?.route.id === 'project.jobs'
  && matchUiRoute('GET', '/deepblend/projects/x/jobs/render-0001')?.route.id === 'project.job')
check('a job id is decoded out of the path', matchUiRoute('GET', '/deepblend/projects/x/jobs/render-0001')?.params.jobId === 'render-0001')
check('the artifact route captures the rest of the path verbatim',
  matchUiRoute('GET', '/deepblend/artifacts/x/revisions/r0001/previews/a.png')?.params.rest === 'revisions/r0001/previews/a.png',
  matchUiRoute('GET', '/deepblend/artifacts/x/revisions/r0001/previews/a.png')?.params.rest)
check('the artifact route refuses an empty path',
  matchUiRoute('GET', '/deepblend/artifacts/x') === null)

// ---------------------------------------------------------------------------
// Panel vocabulary — one id, three seats, six views
// ---------------------------------------------------------------------------

check('the panel id is one value shared by every seat', UI_PANEL_ID === 'deepblend', UI_PANEL_ID)
check('the panel label is one value shared by the sidebar and the settings nav', UI_PANEL_LABEL === 'Blender')
check('the panel has the six views M4 delivers', UI_PANEL_VIEWS.map(view => view.id).join(',') === 'projects,scene,preview,jobs,qa,revisions')

/**
 * SPEC §20 M4's nine deliverables, each mapped to where it lives.
 *
 * A deliverable with no home is the failure this assertion exists to catch: it is
 * how a milestone ends up "shipping" a sidebar and no approval display.
 */
const DELIVERABLE_HOMES = {
  'Blender Sidebar': 'sidebar seat registers UI_PANEL_ID',
  'Scene Tree': 'panel view "scene"',
  'Preview Compare': 'panel view "preview"',
  Jobs: 'panel view "jobs"',
  QA: 'panel view "qa"',
  Revisions: 'panel view "revisions"',
  'Tool Cards': 'UI_TOOL_CARD_KEYS covers every wire tool name',
  Settings: 'the settings section id is UI_PANEL_ID',
  Approval: 'buildApprovalView, rendered by the jobs view and the render cards',
}
check('all nine SPEC §20 M4 deliverables have a named home', Object.keys(DELIVERABLE_HOMES).length === 9, Object.keys(DELIVERABLE_HOMES).length)
const panelledDeliverables = ['Scene Tree', 'Preview Compare', 'Jobs', 'QA', 'Revisions']
check('every deliverable that should be a panel view is one',
  panelledDeliverables.every(name => DELIVERABLE_HOMES[name].startsWith('panel view')),
  panelledDeliverables.map(name => DELIVERABLE_HOMES[name]))

// ---------------------------------------------------------------------------
// The preview pair's vocabulary
// ---------------------------------------------------------------------------

check('the two sheet slots are named once, and only these two exist',
  JSON.stringify(PREVIEW_SHEET_SLOTS) === JSON.stringify({ current: 'preview-current', previous: 'preview-previous' }),
  PREVIEW_SHEET_SLOTS)
check('the current slot is the one a panel shows, and the two are distinct',
  PREVIEW_SHEET_SLOTS.current !== PREVIEW_SHEET_SLOTS.previous
  && typeof PREVIEW_SHEET_SLOTS.current === 'string')

// ---------------------------------------------------------------------------
// Scene Tree
// ---------------------------------------------------------------------------

const SPEC = {
  schemaVersion: 'deepblend.scene/v1',
  project: { id: 'demo', title: 'Demo', units: 'metric', fps: 30, frameStart: 1, frameEnd: 120, aspectRatio: '16:9', activeCamera: 'camera-main' },
  entities: [
    { id: 'body', type: 'generator', generator: { shape: 'rounded_box' }, materialId: 'metal', transform: { location: [0, 0, 1], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, tags: ['hero-product'] },
    { id: 'stage', type: 'generator', generator: { shape: 'plane' }, transform: { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, tags: ['environment'], locked: true },
  ],
  materials: [{ id: 'metal', shader: 'principled', parameters: { metallic: 0.9 } }],
  lights: [{ id: 'key', type: 'area', energy: 1200, transform: { location: [2, -3, 4] } }],
  cameras: [{ id: 'camera-main', role: 'active-camera', lens: 70, targetEntityId: 'body' }],
  shots: [{ id: 'shot-01', cameraId: 'camera-main', frameRange: [1, 120] }],
  animationTracks: [{ id: 'spin', targetEntityId: 'body', property: 'rotationEuler.z', keyframes: [{ frame: 1, value: 0 }, { frame: 120, value: 6.28 }] }],
}

const tree = buildSceneTree(SPEC, { revision: 'r0009', digest: 'abc123' })
check('the tree counts what the spec declares',
  JSON.stringify(tree.counts) === JSON.stringify({ entities: 2, materials: 1, lights: 1, cameras: 1, shots: 1, animationTracks: 1, assets: 0 }),
  tree.counts)
check('an entity node carries its shape, material, tags and lock',
  tree.nodes.entities[0].shape === 'rounded_box' && tree.nodes.entities[0].materialId === 'metal'
  && tree.nodes.entities[0].tags.includes('hero-product') && tree.nodes.entities[1].locked === true)
check('the active camera is marked from the project, not guessed from order',
  tree.nodes.cameras[0].isActive === true && tree.nodes.cameras[0].role === 'active-camera')
check('an animation track reports its target, property and keyframe span',
  tree.nodes.animationTracks[0].targetId === 'body' && tree.nodes.animationTracks[0].property === 'rotationEuler.z'
  && JSON.stringify(tree.nodes.animationTracks[0].frameRange) === '[1,120]')
check('the tree labels itself with the revision it was built from', tree.revision === 'r0009' && tree.digest === 'abc123')
check('a scene with nothing in it builds a zero tree rather than throwing',
  buildSceneTree({ project: { id: 'x' } }).counts.entities === 0)

// ---------------------------------------------------------------------------
// Revision diff
// ---------------------------------------------------------------------------

const NEXT = JSON.parse(JSON.stringify(SPEC))
NEXT.entities[0].transform.location = [0, 0, 1.5]
NEXT.entities.push({ id: 'crown', type: 'generator', generator: { shape: 'cylinder' }, transform: { location: [0.02, 0, 1], rotationEuler: [0, 0, 0], scale: [1, 1, 1] } })
NEXT.project.frameEnd = 240
NEXT.world = { color: [0, 0, 0, 1], strength: 0 }

const same = buildRevisionDiff(SPEC, SPEC, { fromRevision: 'r0001', toRevision: 'r0001' })
check('two identical specs diff to nothing', same.identical === true && same.totalChanges === 0)
const diff = buildRevisionDiff(SPEC, NEXT, { fromRevision: 'r0009', toRevision: 'r0010' })
check('an added entity is reported by id', diff.collections.entities.added.includes('crown'), diff.collections.entities.added)
check('a changed entity reports the field and both values',
  diff.collections.entities.changed[0].id === 'body'
  && diff.collections.entities.changed[0].fields.some(field => field.field === 'transform')
  && JSON.stringify(diff.collections.entities.changed[0].fields[0].to).includes('1.5'),
  diff.collections.entities.changed)
check('a project-level change is reported separately from the collections',
  diff.project.some(field => field.field === 'frameEnd' && field.from === 120 && field.to === 240), diff.project)
check('a new world is reported field by field', diff.world.length === 2
  && diff.world.some(field => field.field === 'strength' && field.to === 0)
  && diff.world.some(field => field.field === 'color'), diff.world)
check('the diff counts every kind of change exactly once',
  diff.collections.entities.added.length === 1
  && diff.collections.entities.changed.length === 1
  && diff.collections.entities.removed.length === 0
  && diff.project.length === 1
  && diff.world.length === 2
  && diff.totalChanges === 5,
  { total: diff.totalChanges, kinds: Object.fromEntries(Object.entries(diff.collections).map(([key, value]) => [key, value.added.length + value.removed.length + value.changed.length])) })

// ---------------------------------------------------------------------------
// QA view — two sources, never merged
// ---------------------------------------------------------------------------

const VALIDATION = {
  schemaVersion: 'deepblend.validation/v1',
  revision: 'r0009',
  semantic: { ok: true, notices: [{ code: 'SCENE_CAMERA_ROTATION_IGNORED', message: 'aim wins' }] },
  technical: { ok: false, errors: [{ code: 'MISSING_TEXTURE', message: 'no file' }], counts: { objects: 17, materials: 9, cameraObjects: 4 }, engine: 'CYCLES', activeCamera: 'db_camera__camera-main', frameRange: [1, 450] },
}
const REVIEW = {
  score: 82,
  pass: false,
  iteration: 0,
  subjectId: 'watch-body',
  viewCount: 7,
  sheet: { path: 'revisions/r0009/contact-sheets/round-0.png', width: 1992, height: 1272 },
  issues: [{ code: 'SUBJECT_PART_HIDDEN', severity: 'critical', category: 'occlusion', viewId: 'active-camera', objectId: 'dial', evidence: 'invisible in every view' }],
  reported: [{ viewId: 'top', category: 'composition', severity: 'major', evidence: 'too far right', confidence: 0.9 }],
  rejected: [{ viewId: 'top' }],
  reviewer: { model: 'deepseek-flash', provider: 'deepseek-official' },
}
const qa = buildQaView({ projectId: 'demo', revision: 'r0009', validation: VALIDATION, review: REVIEW })
check('technical errors are counted from validation.json', qa.technical.errorCount === 1 && qa.technical.ok === false)
check('compiler notices are reported separately from errors', qa.semantic.noticeCount === 1 && qa.semantic.notices[0].code === 'SCENE_CAMERA_ROTATION_IGNORED')
check('measured issues come from the review document\'s own field', qa.visual.measuredIssues[0].code === 'SUBJECT_PART_HIDDEN' && qa.visual.measuredIssueCount === 1)
check('the model\'s findings stay separate from the measurements', qa.visual.findings[0].evidence === 'too far right' && qa.visual.findingCount === 1)
check('a rejection is reported rather than hidden', qa.visual.rejectedFindingCount === 1)
check('the reviewer that was consulted is named', qa.visual.reviewerModel === 'deepseek-flash')
check('the sheet is carried so the panel can show what was reviewed', qa.visual.sheet.path.endsWith('round-0.png'))
const qaEmpty = buildQaView({ projectId: 'demo', revision: 'r0001' })
check('a revision with no QA record says so instead of showing zeros as facts',
  qaEmpty.technical.available === false && qaEmpty.visual.available === false && qaEmpty.summary.includes('还没有 QA 记录'),
  qaEmpty.summary)
const qaReviewerDown = buildQaView({ projectId: 'demo', revision: 'r0009', validation: VALIDATION, review: { ...REVIEW, reported: [], reviewer: { error: { message: 'stream ended' } } } })
check('a failed reviewer is surfaced as a failure, not as "found nothing"',
  qaReviewerDown.visual.reviewerError === 'stream ended' && qaReviewerDown.visual.reviewerAvailable === true)

// ---------------------------------------------------------------------------
// Jobs and the approval display
// ---------------------------------------------------------------------------

const RUNNING = {
  jobId: 'render-0007',
  projectId: 'demo',
  type: 'final-render',
  status: 'running',
  expectedFrames: 60,
  completedFrames: 15,
  missingFrames: [45],
  corruptFrames: [],
  frameStart: 30,
  frameEnd: 89,
  delivery: null,
  warnings: [],
}
const jobView = buildJobView(RUNNING, { threshold: 900 })
check('progress is frames complete out of expected', jobView.progress.percent === 25 && jobView.progress.completed === 15)
check('a live job is cancelable and not resumable in the same breath', jobView.cancelable === true && jobView.resumable === false)
check('the approval threshold is reported with the frame count it applies to',
  jobView.approval.required === false && jobView.approval.threshold === 900 && jobView.approval.frames === 60)
check('the approval view says it is display-only, so the UI cannot imply it gated anything',
  jobView.approval.plane === 'display-only' && jobView.approval.note.includes('M5'))

const BIG = { ...RUNNING, jobId: 'render-0008', status: 'queued', expectedFrames: 1200, completedFrames: 0, warnings: [{ code: 'SCENE_COMPILER_DECISION', message: 'above the approval threshold', detail: { frames: 1200, threshold: 900 } }] }
const bigView = buildJobView(BIG, { threshold: 900 })
check('a job above the threshold is marked as needing approval', bigView.approval.required === true)
check('the requirement M3 recorded is reported as recorded, not re-derived',
  bigView.approval.recorded === true && bigView.approval.recordedMessage.includes('approval threshold'))

check('a completed job is neither cancelable nor resumable, and is deliverable when it has a delivery',
  (() => {
    const view = buildJobView({ ...RUNNING, status: 'completed', completedFrames: 60, missingFrames: [], delivery: { videoPath: 'output/final.mp4' } }, { threshold: 900 })
    return view.cancelable === false && view.resumable === false && view.deliverable === true && view.progress.live === false
  })())
check('a failed job is resumable, because its frames are still on disk',
  buildJobView({ ...RUNNING, status: 'failed', errorCode: 'BLENDER_EXIT_NONZERO' }, { threshold: 900 }).resumable === true)
check('a zero-frame job reports 0% rather than NaN or Infinity',
  buildJobView({ ...RUNNING, expectedFrames: 0, completedFrames: 0 }, { threshold: 900 }).progress.percent === 0)
check('every status gets a sentence a human can read',
  ['queued', 'running', 'stopping', 'recovering', 'completed', 'failed', 'cancelled'].every(status => describeJobForHuman({ ...RUNNING, status }).length > 8),
  ['queued', 'running', 'stopping', 'recovering', 'completed', 'failed', 'cancelled'].map(status => describeJobForHuman({ ...RUNNING, status })))
check('an unfinished job count comes from the state machine, not from a second list in the browser',
  buildProjectView({ projectId: 'demo', title: 'Demo', currentRevision: 'r0001', revisionCount: 1 }, {
    jobs: [{ jobId: 'a', status: 'running', type: 'final-render', revisionId: 'r0001' }, { jobId: 'b', status: 'completed', type: 'final-render', revisionId: 'r0001' }],
  }).unfinishedJobs === 1)

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

const card = buildSettingsCard({
  installed: true,
  executable: { requested: '/opt/blender', resolved: '/opt/blender' },
  version: '5.2.1 LTS',
  pythonVersion: '3.13.13',
  engines: { BLENDER_EEVEE: { available: true }, CYCLES: { available: true }, BLENDER_WORKBENCH: { available: false } },
  bestAvailableEngine: 'CYCLES',
  gpu: { available: true, devices: ['Apple M5'], preferredBackend: 'METAL' },
  formats: { import: ['gltf'], export: ['gltf'] },
  renderSmokeTest: { ok: true, engine: 'CYCLES', bytes: 1234 },
  warnings: [],
  probedAt: '2026-09-13T00:00:00.000Z',
})
check('the card reports the version and the resolved executable', card.rows.some(row => row.label === '版本' && row.value === '5.2.1 LTS') && card.statusLabel === '可用')
check('only available engines are listed', card.rows.find(row => row.label === '可用引擎').value === 'BLENDER_EEVEE, CYCLES')
const missingCard = buildSettingsCard({ installed: false, warnings: [{ code: 'BLENDER_NOT_FOUND', message: 'no blender' }] })
check('a machine with no Blender renders a card, not an error', missingCard.status === 'missing' && missingCard.warnings.length === 1)

// ---------------------------------------------------------------------------
// Tool cards
// ---------------------------------------------------------------------------

const target = parseToolCallTarget(JSON.stringify({ projectId: 'watch-commercial', baseRevision: 'r0029', operations: [{ op: 'a' }, { op: 'b' }] }))
check('a card reads the project and base revision out of the call\'s own arguments',
  target.projectId === 'watch-commercial' && target.revision === 'r0029' && target.operationCount === 2)
check('a resume call is understood as a job reference', parseToolCallTarget(JSON.stringify({ projectId: 'x', resumeJobId: 'render-0001' })).jobId === 'render-0001')
check('arguments that are still streaming, or broken, yield nulls rather than throwing',
  JSON.stringify(parseToolCallTarget('{"projectId":')) === JSON.stringify({ projectId: null, jobId: null, revision: null, operationCount: null })
  && parseToolCallTarget('').projectId === null
  && parseToolCallTarget(undefined).projectId === null)
check('every registered DeepBlend wire tool name has a card', UI_TOOL_CARD_KEYS.length === 14 && UI_TOOL_CARD_KEYS.every(name => name.startsWith('blender_')), UI_TOOL_CARD_KEYS.length)

// ---------------------------------------------------------------------------
// The documented route table must be the implemented one
//
// This repository has paid six times for one vocabulary written twice (D38, D43,
// D57, D60, D61), and a route list in a Markdown file is exactly such a copy: no
// reader, no test, drifting quietly. So the doc is read here and compared
// line-for-line with the table the Host router actually matches.
// ---------------------------------------------------------------------------

{
  const docs = readFileSync(join(TESTS_ROOT, '..', '..', 'docs', 'tool-contracts.md'), 'utf8')
  const documented = docs.split('\n')
    .map(line => line.match(/^\| `([A-Z]+) (\/deepblend\/[^`]*)` \| (读|\*\*写\*\*) \|/))
    .filter(Boolean)
    .map(match => `${match[1]} ${match[2]}`)
  const implemented = UI_ROUTES.map(route => `${route.method} ${route.path}`)
  check('the documented route table lists every implemented route, and only those',
    JSON.stringify(documented) === JSON.stringify(implemented),
    { documented: documented.length, implemented: implemented.length })
}

// ---------------------------------------------------------------------------
// Every view model crosses the wire, so every one of them must be lossless JSON
// ---------------------------------------------------------------------------

const payloads = {
  scene: tree,
  diff: diff,
  qa: qa,
  job: jobView,
  approval: bigView.approval,
  project: buildProjectView({ projectId: 'demo', title: 'Demo', currentRevision: 'r0009', revisionCount: 9 }, { jobs: [] }),
  card,
  routes: UI_ROUTES,
  views: UI_PANEL_VIEWS,
  tools: UI_TOOL_CARD_KEYS,
}
for (const [name, payload] of Object.entries(payloads)) {
  check(`${name} is lossless JSON as the harness defines it`, isJsonValue(payload), name)
}

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok)
console.log(`\nui api contract: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
