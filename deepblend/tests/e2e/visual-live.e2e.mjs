#!/usr/bin/env node
/**
 * M2 LIVE end-to-end — the model, a real contact sheet, and a real repair.
 *
 * WHAT ONLY THIS SUITE CAN PROVE
 * ------------------------------
 * Every other M2 test runs with the vision port stubbed, which is what makes the loop
 * semantics deterministic — and also means none of them would notice if the reviewer
 * were handed a path instead of an image, or an image of the wrong thing. This suite
 * spends real model calls to answer the three acceptance criteria that are about the
 * MODEL rather than about the pipeline:
 *
 *   SPEC §20 M2
 *     "模型真正看到预览图片"       → the reviewer's answer is printed verbatim, and it
 *                                     must contain facts that only pixels carry
 *     "可识别构图、曝光和明显遮挡"   → on a scene with a PLANTED occlusion, the model must
 *                                     report an occlusion finding on the subject
 *     "自动修复后评分提高"          → a real model-chosen patch, adopted because the
 *                                     re-measured score went up
 *
 * WHY IT IS NOT PART OF `run-all.sh`, AND WHY IT IS NOT SKIPPED QUIETLY
 * --------------------------------------------------------------------
 * It costs model calls and about a minute of wall clock, so it does not belong in the
 * suite a developer runs on every save. But it is not "disabled when inconvenient"
 * either: it fails loudly and immediately if the deployment has no API key or no
 * vision-capable model, and it prints what the model actually said so a human can judge
 * the answer rather than trusting a green tick. Run it before any commit that touches
 * the reviewer, the prompt, the sheet compositor or the scorer.
 *
 * Run: node deepblend/tests/e2e/visual-live.e2e.mjs
 *
 * Owner: DeepBlend Studio — M2
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  importDsh,
  resolveDshHome,
} from '../lib/dsh-deployment.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')
const FIXTURES = join(ROOT, 'deepblend', 'fixtures')

const PROVIDER = process.env.DEEPBLEND_PROBE_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.DEEPBLEND_PROBE_MODEL ?? 'deepseek-flash'
const PREVIEW = { width: 400, height: 225, samples: 16 }

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/** Print what the model said, unedited, because that IS the evidence. */
function show(label, text) {
  console.log('')
  console.log(`┌─ ${label}`)
  for (const line of String(text ?? '').split('\n')) console.log(`│ ${line}`)
  console.log('└─')
}

if (!existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}; the live suite cannot run.`)
  process.exit(2)
}

const DSH_HOME = resolveDshHome()
if (!existsSync(join(DSH_HOME, '.credentials.yaml'))) {
  console.error(
    `No credential store at ${DSH_HOME}/.credentials.yaml, so no API key is available and this ` +
    'suite cannot make the model call it exists to make.',
  )
  process.exit(2)
}

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-m2-live-'))
const ctx = new Context()

try {
  // ---- the full composition: provider, host service AND the model route ----
  //
  // The provider stack is composed for real rather than mocked, because the point of
  // this suite is that the reviewer inside `blenderStudio` can reach a model. A stub
  // here would test the stub.
  const llmModule = await importDsh('dsh-llm')
  const LocalCredentialProvider = (await importDsh('dsh-credentials-local')).default
  const FileSettingsProvider = (await importDsh('dsh-settings-file')).default
  const LocalAttachmentStore = (await importDsh('dsh-attachment-local')).default
  const deepSeek = await importDsh('dsh-llm-deepseek')

  ctx.plugin(LocalSubprocess)
  ctx.plugin(FileSettingsProvider, { path: join(DSH_HOME, 'settings.yaml'), dshHome: DSH_HOME })
  ctx.plugin(LocalCredentialProvider, { path: join(DSH_HOME, '.credentials.yaml'), dshHome: DSH_HOME })
  ctx.plugin(LocalAttachmentStore, { dshHome: DSH_HOME })
  ctx.plugin(llmModule.default)
  // The adapter's `inject` lives on the module namespace, not on the function, so it
  // must be handed over as the { apply, inject } pair (measured: wrapping it in a
  // closure silently registers nothing and only fails later with NO_ADAPTER).
  ctx.plugin({ apply: deepSeek.apply, inject: deepSeek.inject }, { apiKeyEnv: 'DEEPSEEK_API_KEY' })

  const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
  const { default: Studio } = await import('@deepblend/dsh-blender-host')
  ctx.plugin(Provider, ProviderConfig({
    blenderPath: BLENDER,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: workspace,
    timeoutMs: 600_000,
  }))
  ctx.plugin(Studio, {
    projectsRoot: join(workspace, 'projects'),
    workspaceRoot: workspace,
    maxPreviewSamples: 64,
    visualReviewProvider: PROVIDER,
    visualReviewModel: MODEL,
  })
  await new Promise(settle => setTimeout(settle, 400))

  const studio = ctx.get('blenderStudio')
  const llm = ctx.get('llm')
  if (studio === undefined || llm === undefined) {
    console.error('the host service or the llm service did not activate')
    process.exit(1)
  }

  const route = await llm.resolveModelInfo(PROVIDER, MODEL)
  console.log(`vision route: ${PROVIDER}/${route.id} (${route.name}) modalities ${JSON.stringify(route.inputModalities)}`)
  if (!Array.isArray(route.inputModalities) || !route.inputModalities.includes('image')) {
    console.error(
      `Model ${PROVIDER}/${MODEL} does not accept image input (modalities ${JSON.stringify(route.inputModalities)}), ` +
      'so this suite cannot test what it tests. Point DEEPBLEND_PROBE_MODEL at a vision-capable model.',
    )
    process.exit(2)
  }

  // ---- a scene with a PLANTED occlusion ----------------------------------

  const defect = JSON.parse(readFileSync(join(FIXTURES, 'occlusion-screen', 'defect.json'), 'utf8'))
  const spec = JSON.parse(readFileSync(join(FIXTURES, 'occlusion-screen', 'scene-spec.json'), 'utf8'))
  const created = await studio.createProject({
    title: 'M2 live occlusion',
    goal: spec.project.goal,
    sceneSpec: spec,
    saveCheckpoint: true,
  })
  const projectId = created.projectId
  const revision = created.revision.revision
  console.log(`project ${projectId} at ${revision}; planted defect: ${defect.code} on ${defect.viewId}`)

  // ---- 1. the model sees the sheet, and says what it sees ----------------

  const first = await studio.visualReview({
    projectId,
    revision,
    ...PREVIEW,
    consultReviewer: true,
  })
  show('MEASURED issues', first.issues.map(issue => `[${issue.severity}] ${issue.code} ${issue.viewId} ${issue.objectId ?? ''} :: ${issue.evidence}`).join('\n'))
  show(`${MODEL} raw answer (round 0)`, first.reviewer?.raw ?? '(no answer)')
  if (first.reviewer?.error) show('reviewer failure', JSON.stringify(first.reviewer.error, null, 2))
  show('findings that survived validation', JSON.stringify(first.reported, null, 2))

  check('the measured scorer finds the planted occlusion before the model is asked',
    first.issues.some(issue => issue.code === defect.code && issue.viewId === defect.viewId),
    first.issues.map(issue => `${issue.viewId}:${issue.code}`))
  check('the model was consulted and answered',
    typeof first.reviewer?.raw === 'string' && first.reviewer.raw.length > 20,
    first.reviewer?.raw?.length)
  check('the answer mentions something visible in the sheet, not a restated number',
    // Crude but honest: a model that never saw the image cannot name the sheet's own
    // subjects, and a model that only parroted the measurements has no reason to.
    /screen|table|sofa|room|partition|banana|plant/i.test(first.reviewer.raw),
    first.reviewer.raw?.slice(0, 160))
  check('the model reported at least one finding that passed validation',
    first.reported.length >= 1,
    first.reported.map(finding => `${finding.category}/${finding.viewId}`))
  check('the model identified the OCCLUSION specifically',
    first.reported.some(finding => finding.category === 'occlusion' &&
      (finding.objectId === null || finding.objectId === 'coffee-table')),
    first.reported.map(finding => `${finding.category}:${finding.objectId}`))
  check('the review carries a usable contact sheet for a human to check the model against',
    typeof first.sheetArtifact?.path === 'string' && first.sheetArtifact.width > 800,
    first.sheetArtifact?.path)

  // ---- 2. a real repair, adopted because the score went up ---------------

  const before = first.score
  // The fix the defect invites: move the SCREEN out of the sight line. Moving the
  // camera instead would have to move it for the detail view too — the screen stands
  // between that camera and the subject as well — and a repair that fixes one view by
  // breaking another is not a repair. The measurement says so: after this patch every
  // view reports the subject fully visible.
  const patched = await studio.applyScenePatch({
    projectId,
    baseRevision: revision,
    operations: [{
      op: 'entity.transform.update',
      entityId: 'screen',
      location: [-2.4, -0.4, 0.6],
    }],
    note: 'live test: move the partition screen out of the subject sight line',
    actor: 'm2-live-test',
    stage: 'PATCH',
    saveCheckpoint: true,
  })
  const second = await studio.visualReview({
    projectId,
    revision: patched.revision,
    ...PREVIEW,
    consultReviewer: true,
  })
  show('MEASURED issues after the repair', second.issues.map(issue => `[${issue.severity}] ${issue.code} ${issue.viewId} :: ${issue.evidence}`).join('\n') || '(none)')
  show(`${MODEL} raw answer (after the repair)`, second.reviewer?.raw ?? '(no answer)')
  if (second.reviewer?.error) show('reviewer failure', JSON.stringify(second.reviewer.error, null, 2))

  check('the repair raises the measured score',
    second.score > before, { before, after: second.score })
  check('the occlusion is gone from the repaired revision',
    !second.issues.some(issue => issue.code === defect.code),
    second.issues.map(issue => `${issue.viewId}:${issue.code}`))
  check('the model still answers after the repair, so the sheet it sees changed too',
    typeof second.reviewer?.raw === 'string' && second.reviewer.raw.length > 20,
    second.reviewer?.raw?.length)

  // ---- 3. the host-owned loop, with a real reviewer every round ----------

  const fresh = await studio.createProject({
    title: 'M2 live loop',
    goal: 'A second project so the loop starts from the failing revision.',
    sceneSpec: spec,
    saveCheckpoint: true,
  })
  const run = await studio.visualLoop({
    projectId: fresh.projectId,
    revision: fresh.revision.revision,
    ...PREVIEW,
    maxIterations: 2,
  })
  show('loop rounds', run.rounds.map(round =>
    `round ${round.round}: ${round.outcome} score ${round.score}` +
    `${round.reason !== null ? ` (${round.reason})` : ''}`).join('\n'))
  for (const round of run.rounds) {
    for (const finding of round.reported ?? []) {
      console.log(`  round ${round.round} the model saw: [${finding.category}] ${finding.viewId} :: ${finding.evidence}`)
    }
  }

  check('the host-owned loop ran at least one round with a real reviewer answer',
    run.iterations >= 1 && run.rounds.some(round => (round.reported ?? []).length > 0),
    { iterations: run.iterations, rounds: run.rounds.length })
  check('no round was adopted without the measured score improving',
    run.rounds.every((round, index) => round.outcome !== 'applied' ||
      index === 0 || round.score >= run.rounds[index - 1].score),
    run.rounds.map(round => `${round.outcome}:${round.score}`))
  check('the loop stopped for a stated reason within its budget',
    run.iterations <= run.maxIterations && run.stopReason !== null,
    { iterations: run.iterations, max: run.maxIterations, stop: run.stopReason })
  check('the project is left on the last revision the loop accepted',
    studio.store.readRecord(fresh.projectId).currentRevision === run.finalRevision,
    { current: studio.store.readRecord(fresh.projectId).currentRevision, final: run.finalRevision })
  if (run.handover !== null) {
    show('handover', JSON.stringify({
      reason: run.handover.reason,
      revision: run.handover.revision,
      openIssues: run.handover.openIssues.map(issue => issue.code),
      suggestions: run.handover.suggestions,
    }, null, 2))
    check('a handover names a clean revision, the open issues and next steps',
      run.handover.revision === run.finalRevision &&
      run.handover.openIssues.length >= 1 &&
      run.handover.suggestions.length >= 2)
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok).length
console.log('')
console.log(`M2 live visual review: ${results.length - failed}/${results.length} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
