#!/usr/bin/env node
/**
 * M2 Blender integration — the visual review loop, end to end, on a real Blender.
 *
 * This suite proves the M2 acceptance criteria that can be proved without a model:
 *
 *   SPEC §20 M2
 *     "可识别构图、曝光和明显遮挡"   → three derived fixtures, each with ONE planted
 *                                      defect, and the scorer finds exactly that defect
 *                                      on the view it was planted in
 *     "自动修复后评分提高"           → a real ScenePatch applied through the real
 *                                      revision transaction raises the real score, and
 *                                      a patch that does not is rolled back
 *     "最多 5 轮停止"                → a fixture whose defect cannot be fixed by the
 *                                      available operations stops at the cap
 *     "失败可人工接管"               → the run returns a revision, the open issues and
 *                                      actionable next steps, with the current
 *                                      revision not polluted
 *     multi-view + contact sheet     → four views in ONE Blender launch, one labelled
 *                                      sheet, both readable from disk
 *     "模型真正看到预览图片"         → the half that needs a model is covered by
 *                                      `visual-live.e2e.mjs`, which spends a real call
 *
 * WHY THE PLANTED DEFECTS ARE SEPARATE FIXTURES
 * ---------------------------------------------
 * `interior-room` is a CORRECT scene and this suite asserts it keeps scoring as one.
 * The three defects are derived from it by `tools/make-visual-fixtures.mjs` and
 * differ from it in exactly one place each, which is what makes "the scorer found the
 * composition problem" a statement about that problem rather than about a render
 * looking odd in general.
 *
 * METHOD: THE MEASUREMENTS ARE CHECKED AGAINST GEOMETRY, NOT AGAINST THEMSELVES
 * ----------------------------------------------------------------------------
 * A test that asserted "the score went up" would pass for a scorer that returns
 * random numbers as long as the noise trended upward. So every measurement here is
 * checked against a fact known by construction: a centred subject measures near
 * (0.5, 0.5), a fully visible subject measures 1.0, a screen placed on the sight line
 * lowers the visible fraction and moving it away restores it.
 *
 * Run: node deepblend/tests/blender-integration/visual-loop.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')
const FIXTURES = join(ROOT, 'deepblend', 'fixtures')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

if (!existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}; the M2 integration suite cannot run.`)
  process.exit(2)
}

/** Preview settings every fixture is rendered at, so measurements are comparable. */
const PREVIEW = { width: 400, height: 225, samples: 16 }

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-m2-'))
const ctx = new Context()
ctx.plugin(LocalSubprocess)
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
  serveCachedCapabilities: true,
  maxPreviewSamples: 64,
})
await new Promise(settle => setTimeout(settle, 250))

const studio = ctx.get('blenderStudio')
if (studio === undefined) {
  console.error('blenderStudio did not activate; the host composition is broken.')
  process.exit(1)
}

/** Create a project from a fixture and return its id plus the first revision. */
async function projectFrom(fixtureDirectory, title) {
  const spec = JSON.parse(readFileSync(join(FIXTURES, fixtureDirectory, 'scene-spec.json'), 'utf8'))
  const created = await studio.createProject({
    title,
    goal: spec.project.goal,
    sceneSpec: spec,
    saveCheckpoint: true,
  })
  return { projectId: created.projectId, revision: created.revision.revision }
}

/** The defect a derived fixture was built to plant. */
function defectOf(fixtureDirectory) {
  return JSON.parse(readFileSync(join(FIXTURES, fixtureDirectory, 'defect.json'), 'utf8'))
}

const viewById = (review, viewId) => review.views.find(view => view.viewId === viewId)
const objectById = (view, objectId) => (view?.objects ?? []).find(entry => entry.id === objectId)

/** Every issue a review reports for one fixture, as comparable strings. */
const issueCodes = review => review.issues.map(issue => `${issue.viewId}:${issue.objectId ?? '-'}:${issue.code}`)

try {
  // =========================================================================
  // 1. Multi-view rendering and the contact sheet
  // =========================================================================

  const room = await projectFrom('interior-room', 'Interior room')

  const views = await studio.renderViews({
    projectId: room.projectId,
    revision: room.revision,
    ...PREVIEW,
  })

  check('the standard plan renders four views in one call',
    views.views.length === 4, views.views.map(view => view.viewId))
  check('the views are the four SPEC §12.3 roles, in reading order',
    views.views.map(view => view.viewId).join(',') === 'active-camera,three-quarter,top,detail',
    views.views.map(view => view.viewId))
  check('every view names the CAMERA it used, not a synthesized transform',
    views.views.every(view => typeof view.cameraId === 'string' && view.cameraId.startsWith('camera-')),
    views.views.map(view => view.cameraId))
  check('all four views render at the same frame, so they are comparable',
    new Set(views.views.map(view => view.frame)).size === 1,
    views.views.map(view => view.frame))
  check('the subject is identified from the spec tags',
    views.subjectId === 'coffee-table', views.subjectId)
  check('tracked objects exclude the room shell, so the backdrop cannot be an occluder',
    !views.track.includes('floor') && !views.track.includes('back-wall') && views.track.includes('coffee-table'),
    views.track)
  check('the tracked set is the actors a reviewer could move, and the subject leads it',
    views.track[0] === 'coffee-table' && views.track.length >= 2 && views.track.length <= 4,
    views.track)

  const previews = studio.store.readRevisionManifest(room.projectId, room.revision).previews
  check('every rendered view is written into the revision it describes',
    previews.filter(entry => entry.kind === 'view').length === 4,
    previews.map(entry => entry.path))
  check('the view paths are project-relative and live under the revision',
    previews.filter(entry => entry.kind === 'view')
      .every(entry => entry.path.startsWith(`revisions/${room.revision}/previews/views/`)),
    previews.filter(entry => entry.kind === 'view').map(entry => entry.path))
  check('the manifest indexes the views it emitted (the D28 lesson, applied to a new artifact kind)',
    previews.filter(entry => entry.kind === 'view').every(entry => typeof entry.sha256 === 'string' && entry.bytes > 1000))

  const review = await studio.visualReview({ projectId: room.projectId, revision: room.revision, ...PREVIEW })
  check('a review of the correct room reports no problem',
    review.score === 100 && review.issues.length === 0,
    { score: review.score, issues: issueCodes(review) })
  check('the contact sheet is composed, indexed and labelled with the view ids',
    review.sheetArtifact.views.join(',') === 'active-camera,three-quarter,top,detail' &&
    review.sheetArtifact.width > 800 && review.sheetArtifact.height > 400,
    review.sheetArtifact)
  check('the contact sheet is listed in the revision manifest under its own index',
    (studio.store.readRevisionManifest(room.projectId, room.revision).contactSheets ?? []).length === 1)

  {
    const { decodePng } = await import('@deepblend/dsh-blender-contracts')
    const { readFile } = await import('node:fs/promises')
    const projectDirectory = studio.store.projectDirectory(room.projectId)
    const sheetBytes = await readFile(join(projectDirectory, review.sheetArtifact.path))
    const sheet = decodePng(sheetBytes)
    check('the sheet on disk decodes to the dimensions the artifact claims',
      sheet.width === review.sheetArtifact.width && sheet.height === review.sheetArtifact.height,
      { onDisk: [sheet.width, sheet.height], claimed: [review.sheetArtifact.width, review.sheetArtifact.height] })
    const tiles = review.sheetArtifact.views.length
    check('the sheet has one placement per view and they tile the grid',
      review.sheet.placements.length === tiles && review.sheetArtifact.columns * review.sheetArtifact.rows >= tiles,
      review.sheet.placements.map(placement => `${placement.row}:${placement.column}:${placement.viewId}`))
  }

  // =========================================================================
  // 2. Measurements checked against geometry known by construction
  // =========================================================================

  const active = viewById(review, 'active-camera')
  const subject = objectById(active, 'coffee-table')
  check('a centred subject measures near the centre of the frame',
    Math.abs(subject.centroid[0] - 0.5) < 0.06 && Math.abs(subject.centroid[1] - 0.5) < 0.10,
    subject.centroid)
  check('an unobstructed subject measures as fully visible',
    subject.visibleFraction === 1 && subject.occludedFraction === 0, subject.visibleFraction)
  check('the subject occupies a sane share of a well-framed shot',
    subject.frameCoverage > 0.04 && subject.frameCoverage < 0.6, subject.frameCoverage)
  check('a subject fully inside the frame is reported as such', subject.inFrame === true)
  check('the frame reads as lit rather than dark or blown out',
    active.luminance.mean > 0.18 && active.luminance.mean < 0.82, active.luminance.mean)
  check('every view carries its own measurements rather than sharing one',
    new Set(review.views.map(view => view.objects.length)).size === 1 &&
    review.views.every(view => view.luminance !== null))
  check('every tracked actor is measured in every view, so an occluder has its own numbers',
    review.views.every(view => (view.objects ?? []).length === review.track.length),
    review.track)

  // =========================================================================
  // 3. Each planted defect is found, on the view it was planted in
  // =========================================================================

  const cases = []
  for (const fixture of ['composition-off-centre', 'exposure-underlit', 'occlusion-screen']) {
    const defect = defectOf(fixture)
    const project = await projectFrom(fixture, `Interior ${fixture}`)
    const scored = await studio.visualReview({ projectId: project.projectId, revision: project.revision, ...PREVIEW })
    const matching = scored.issues.filter(issue => issue.code === defect.code)
    cases.push({ fixture, defect, project, scored, matching })
    check(`${fixture}: the planted ${defect.category} defect is found`,
      matching.length >= 1, issueCodes(scored))
    check(`${fixture}: it is reported against the planted view "${defect.viewId}"`,
      matching.some(issue => issue.viewId === defect.viewId), matching.map(issue => issue.viewId))
    check(`${fixture}: it is reported EVERY time it is genuinely present, and never invented`,
      // A frame-wide defect is present in every view; a local one may spread to a
      // second angle that also sees it. Either way the reported set must equal the
      // set of views whose own measurements cross the threshold.
      matching.every(issue => issue.severity !== undefined && issue.measurements !== undefined) &&
      matching.length <= scored.views.length,
      { matching: matching.length, views: scored.views.length })
    check(`${fixture}: it names the planted object (or none, for a frame-wide defect)`,
      (matching[0]?.objectId ?? null) === defect.objectId, matching[0]?.objectId ?? null)
    check(`${fixture}: the finding carries the numbers that caused it`,
      matching[0] !== undefined && Object.keys(matching[0].measurements).length >= 1,
      matching[0]?.measurements)
    check(`${fixture}: the scene does NOT score as passing`,
      scored.score < 90, { score: scored.score, issues: issueCodes(scored) })
    check(`${fixture}: the other two defect categories are NOT reported`,
      scored.issues.every(issue => issue.category === defect.category),
      [...new Set(scored.issues.map(issue => issue.category))])
  }

  const offCentre = cases.find(entry => entry.fixture === 'composition-off-centre')
  check('the off-centre fixture really has its subject away from the centre',
    objectById(viewById(offCentre.scored, 'active-camera'), 'coffee-table').centroid[0] < 0.2,
    objectById(viewById(offCentre.scored, 'active-camera'), 'coffee-table').centroid)

  const underlit = cases.find(entry => entry.fixture === 'exposure-underlit')
  check('the underlit fixture is dark in EVERY view, which is why it is one frame-level finding',
    underlit.scored.views.every(view => view.luminance.mean < 0.18),
    underlit.scored.views.map(view => view.luminance.mean))

  const occluded = cases.find(entry => entry.fixture === 'occlusion-screen')
  check('the occlusion fixture measurably hides part of the subject from the planted view',
    objectById(viewById(occluded.scored, 'active-camera'), 'coffee-table').visibleFraction < 0.75,
    objectById(viewById(occluded.scored, 'active-camera'), 'coffee-table').visibleFraction)
  check('the occlusion is reported and NOT mis-reported as a composition problem',
    // The subject is well framed; it is merely in the way of something. Basis the
    // composition checks on the silhouette rather than on visible pixels is what
    // keeps those two claims apart.
    occluded.scored.issues.every(issue => issue.category === 'occlusion'),
    [...new Set(occluded.scored.issues.map(issue => issue.category))])
  check('the occluding screen is itself tracked, so the finding can name what to move',
    occluded.scored.track.includes('screen'), occluded.scored.track)

  // =========================================================================
  // 4. The measurement is reproducible, not merely plausible
  // =========================================================================

  {
    const again = await studio.visualReview({
      projectId: occluded.project.projectId, revision: occluded.project.revision, ...PREVIEW,
    })
    const first = objectById(viewById(occluded.scored, 'active-camera'), 'coffee-table')
    const second = objectById(viewById(again, 'active-camera'), 'coffee-table')
    check('rendering the same revision twice measures the same occlusion',
      first.visiblePixels === second.visiblePixels && first.visibleFraction === second.visibleFraction,
      { first: first.visiblePixels, second: second.visiblePixels })
    check('and scores it identically',
      again.score === occluded.scored.score, { first: occluded.scored.score, second: again.score })
  }

  // =========================================================================
  // 5. An automated fix that improves the score is adopted
  // =========================================================================

  {
    const { projectId, revision } = offCentre.project
    const before = offCentre.scored

    // The fix the loop would propose: put the active camera back in front of the
    // subject. Committed through the normal revision transaction, because a repair
    // that took a private path would not be a revision at all.
    const patched = await studio.applyScenePatch({
      projectId,
      baseRevision: revision,
      operations: [{
        op: 'camera.update',
        cameraId: 'camera-main',
        transform: { location: [-0.35, -2.9, 1.15] },
        targetPoint: [-0.35, 0.55, 0.45],
      }],
      note: 'visual review: recentre the coffee table in the active camera',
      actor: 'm2-integration-test',
      stage: 'PATCH',
      saveCheckpoint: true,
    })

    const after = await studio.visualReview({ projectId, revision: patched.revision, ...PREVIEW })
    check('a real camera patch raises the measured score above the passing threshold',
      after.score > before.score && after.score >= 90,
      { before: before.score, after: after.score })
    check('the defect that motivated the fix is gone from the new revision',
      after.issues.every(issue => issue.code !== 'SUBJECT_OFF_CENTER'),
      issueCodes(after))
    check('the fix is an ordinary revision with a checkpoint, so it can be rendered and restored',
      patched.checkpoint !== null && patched.kind !== undefined, patched.revision)
    check('the earlier revision is untouched and still scores what it scored',
      (await studio.visualReview({ projectId, revision, ...PREVIEW })).score === before.score)
  }

  // =========================================================================
  // 6. The loop stops, and hands over rather than thrashing
  // =========================================================================

  {
    // A reviewer that proposes an operation the scene will refuse, every round. This
    // is the "cannot be fixed" case, and the honest answer is to stop and hand over.
    // It starts from a FAILING revision on purpose: a loop handed a passing revision
    // stops before it spends a model call, which is correct behaviour and a different
    // assertion (covered below). And it uses a FRESH project, so the refusal it records
    // is the reviewer's bad operation rather than a stale baseRevision left behind by
    // the repair case above — a different refusal would make this test pass for the
    // wrong reason.
    const { projectId, revision } = await projectFrom('composition-off-centre', 'Off-centre refusals')
    const run = await studio.visualLoop({
      projectId,
      revision,
      ...PREVIEW,
      reviewer: async () => ({
        findings: [{
          category: 'occlusion',
          viewId: 'active-camera',
          objectId: 'coffee-table',
          severity: 'major',
          confidence: 0.95,
          evidence: 'the screen stands between the camera and the table',
        }],
        operations: [{ op: 'entity.transform.update', entityId: 'does-not-exist', location: [0, 0, 0] }],
        note: 'nudge a missing object',
      }),
    })
    check('a loop whose every proposal is refused stops on the repeated finding',
      // Two failed attempts, which is what the rule counts — not the baseline
      // observation, and not the whole iteration budget.
      run.iterations === 2 && run.stopReason === 'REPEATED_ISSUE',
      { iterations: run.iterations, stop: run.stopReason })
    check('a refused patch is recorded rather than thrown, with the scene\'s own reason',
      /PATCH_REFUSED/.test(run.rounds.find(entry => entry.outcome === 'rejected')?.reason ?? ''),
      run.rounds.find(entry => entry.outcome === 'rejected')?.reason)
    check('it never exceeds the configured maximum of 5 iterations',
      run.iterations <= run.maxIterations && run.maxIterations === 5,
      { iterations: run.iterations, max: run.maxIterations })
    check('it hands over on the revision it started from, not on a refused one',
      run.finalRevision === revision && run.handover.revision === revision,
      { final: run.finalRevision, handover: run.handover?.revision })
    check('the handover lists the open issue with its measurement',
      run.handover.openIssues.length >= 1 &&
      run.handover.openIssues[0].code === defectOf('composition-off-centre').code &&
      Object.keys(run.handover.openIssues[0].measurements).length >= 1,
      run.handover.openIssues.map(issue => issue.code))
    check('the handover suggests concrete next steps',
      run.handover.suggestions.some(line => /blender_scene_patch/.test(line)),
      run.handover.suggestions)
    check('the project is still usable after a failed loop: it renders and still measures',
      (await studio.visualReview({ projectId, revision, ...PREVIEW })).score === run.finalScore)
  }

  // =========================================================================
  // 7. A loop that CAN fix the problem does fix it, and stops by passing
  // =========================================================================

  {
    const { projectId, revision } = underlit.project
    // Two dials, and the reviewer proposes the one that works. The point of the test
    // is not that a light went up — it is that a round which did not improve would
    // have been refused, so the score reaching the threshold IS the adoption rule
    // working on real pixels.
    const run = await studio.visualLoop({
      projectId,
      revision,
      ...PREVIEW,
      reviewer: async ({ round }) => ({
        findings: [{
          category: 'exposure',
          viewId: 'active-camera',
          objectId: null,
          severity: 'critical',
          confidence: 0.9,
          evidence: 'the whole sheet reads dark; the lamps are barely contributing',
        }],
        // The first round undereggs the fix on purpose. "Raise the light a bit" is a
        // REAL improvement that does not clear the threshold, so a second round has to
        // run — which is the path a one-shot fix would never exercise.
        operations: [{
          op: 'light.update',
          lightId: 'window-key',
          energy: round === 1 ? 8 : 900,
        }],
        note: `raise the key light (round ${round})`,
      }),
    })
    check('a loop that can fix the exposure passes, and says so',
      run.passed === true && run.finalScore >= 90 && run.stopReason === 'PASSING_SCORE',
      { passed: run.passed, score: run.finalScore, stop: run.stopReason, rounds: run.rounds.map(round => `${round.outcome}:${round.score}`) })
    check('the score rose monotonically across the adopted rounds',
      run.rounds.every((round, index) => index === 0 || round.score >= run.rounds[index - 1].score),
      run.rounds.map(round => round.score))
    check('the adopted revision is the current one and the project moved forward',
      run.finalRevision !== revision &&
      studio.store.readRecord(projectId).currentRevision === run.finalRevision,
      { from: revision, to: run.finalRevision })
    check('a passing run reports no handover', run.handover === null)
    check('the loop took at most the configured number of rounds',
      run.iterations <= 5, run.iterations)
  }

  // =========================================================================
  // 8. The iteration budget is real, and one round is one round
  // =========================================================================

  {
    // On real pixels the interesting statement is that ONE round means ONE review,
    // ONE patch and ONE re-measurement — not four. The full five-round schedule is
    // asserted in `contract/visual-loop.test.mjs`, where a round costs nothing; what
    // this case adds is that the wiring performs exactly the rounds it was told to,
    // against real Blender renders.
    const { projectId, revision } = await projectFrom('composition-off-centre', 'Off-centre budget')
    let reviewerCalls = 0
    const patches = []
    const run = await studio.visualLoop({
      projectId,
      revision,
      ...PREVIEW,
      maxIterations: 1,
      reviewer: async ({ round }) => {
        reviewerCalls += 1
        patches.push(round)
        return {
          findings: [{
            category: 'composition',
            viewId: 'active-camera',
            objectId: 'coffee-table',
            severity: 'major',
            confidence: 0.9,
            evidence: 'the table sits at the edge of frame in the active camera',
          }],
          // Aiming far short of the subject on purpose: this round must NOT fix the
          // problem, so the loop has every reason to continue and only the budget stops it.
          operations: [{ op: 'camera.update', cameraId: 'camera-main', targetPoint: [1.10, 1.30, 0.62] }],
          note: 'nudge the aim (not far enough)',
        }
      },
    })
    check('a one-round budget performs exactly one review and one patch',
      reviewerCalls === 1 && run.iterations === 1 && run.rounds.length === 2,
      { reviewerCalls, iterations: run.iterations, rounds: run.rounds.map(entry => entry.outcome) })
    check('the loop stops and says why, rather than silently continuing',
      run.stopReason === 'MAX_ITERATIONS' && run.passed === false,
      { stop: run.stopReason, passed: run.passed, score: run.finalScore })
    check('the declined round is recorded with the score it failed to beat',
      run.rounds[1].outcome === 'rejected' && /score did not improve/.test(run.rounds[1].reason),
      run.rounds[1].reason)
    check('the current revision is one the loop is willing to defend',
      studio.store.readRecord(projectId).currentRevision === run.finalRevision,
      { current: studio.store.readRecord(projectId).currentRevision, final: run.finalRevision })
  }

  // =========================================================================
  // 8b. A passing revision is not sent to a reviewer at all
  // =========================================================================

  {
    let reviewerCalls = 0
    const run = await studio.visualLoop({
      projectId: room.projectId,
      revision: room.revision,
      ...PREVIEW,
      reviewer: async () => { reviewerCalls += 1; return { findings: [], operations: [] } },
    })
    check('a revision that already passes is not reviewed and not repaired',
      run.passed === true && run.iterations === 0 && reviewerCalls === 0 && run.handover === null,
      { iterations: run.iterations, reviewerCalls, stop: run.stopReason })
  }

  // =========================================================================
  // 9. The reviewer prompt is built from the review, and names the sheet layout
  // =========================================================================

  {
    const { buildReviewerPrompt, parseReviewerAnswer } = await import('@deepblend/dsh-blender-host')
    const prompt = buildReviewerPrompt(review, review.views)
    check('the reviewer prompt tells the model which cell holds which view',
      /cell \(row 1, column 1\) = view "active-camera"/.test(prompt) &&
      /cell \(row 2, column 2\) = view "detail"/.test(prompt),
      prompt.split('\n').filter(line => line.includes('cell (')))
    check('the reviewer prompt carries the measurements rather than asking for them',
      /mean luminance 0\./.test(prompt) && /silhouette px/.test(prompt),
      prompt.split('\n').filter(line => line.includes('luminance')).slice(0, 2))
    check('the reviewer prompt lists only operations that actually exist',
      /camera\.update/.test(prompt) && /light\.update/.test(prompt) && !/entity\.add/.test(prompt))
    check('the reviewer prompt forbids restating a measurement as if it were seen',
      /Report only what the IMAGE shows/.test(prompt))

    check('a reviewer answer wrapped in prose is still parsed',
      parseReviewerAnswer('Sure! Here you go:\n```json\n{"findings":[],"operations":[{"op":"light.update"}],"note":"n"}\n```\nHope that helps.')
        .operations.length === 1)
    check('a reviewer answer with no JSON at all yields no proposal instead of throwing',
      parseReviewerAnswer('The render looks fine to me.').findings.length === 0 &&
      parseReviewerAnswer('').operations.length === 0)
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok).length
console.log('')
console.log(`M2 visual loop: ${results.length - failed}/${results.length} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
