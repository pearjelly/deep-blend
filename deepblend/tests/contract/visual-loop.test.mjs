#!/usr/bin/env node
/**
 * M2 contract test — VisualIssue, the deterministic scorer, and the loop controller.
 *
 * WHY THE LOOP IS TESTED WITH STUB PORTS
 * --------------------------------------
 * The M2 acceptance criteria split into two claims that must not be tested together:
 *
 *   "the model really sees the preview"       — one live test, with a real model
 *   "at most 5 rounds", "the score improves"  — deterministic, with stub ports
 *
 * A test that did both at once would take minutes, cost a model call per round, and
 * fail intermittently for reasons that have nothing to do with the loop. Worse, when
 * it failed it would not say WHICH claim broke. So the loop is exercised here through
 * the four ports it declares, with a reviewer whose answer the test dictates — which
 * also lets the test reproduce situations a cooperative model would never produce
 * (a fix that makes the score worse, a fix that never converges, a patch the scene
 * refuses).
 *
 * THE SCORER IS TESTED AGAINST HAND-BUILT MEASUREMENTS
 * ----------------------------------------------------
 * Not against a render. A render answers "what is the score of THIS scene"; these
 * tests answer "does this number of occluded pixels produce this finding and no
 * other", which is the property that has to hold for the score to mean anything.
 * A threshold that silently stopped firing would still pass a test written against
 * one fixture's score.
 *
 * Run standalone: `node deepblend/tests/contract/visual-loop.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'

import { describeIssueLines, describeLoopNotes, describeReviewNotes } from '@deepblend/dsh-blender-tool'
import {
  VISUAL_PASS_SCORE,
  issueFingerprint,
  quantise,
  runVisualLoop,
  scoreReview,
  scoreView,
  shouldHandOver,
  updateFingerprintCounters,
  validateFindings,
} from '@deepblend/dsh-blender-contracts'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

// ---------------------------------------------------------------------------
// Measurement builders — a view is a set of numbers, which is the whole point
// ---------------------------------------------------------------------------

/**
 * A view with one tracked object and a controlled luminance.
 *
 * Defaults are a deliberately WELL-FRAMED shot: coverage 0.25, dead centre, fully
 * visible, mid-grey. Each test then changes exactly one number, so a failure names
 * the rule that broke rather than "the score is 82".
 */
function view(overrides = {}) {
  const object = {
    id: 'subject',
    viewId: overrides.viewId ?? 'active-camera',
    visiblePixels: overrides.visiblePixels ?? 5000,
    silhouettePixels: overrides.silhouettePixels ?? 5000,
    visibleFraction: overrides.visibleFraction ?? 1,
    occludedFraction: overrides.occludedFraction ?? 0,
    frameCoverage: overrides.frameCoverage ?? 0.25,
    // Composition is scored against the silhouette; the two are equal unless a test
    // deliberately hides part of the subject.
    silhouetteCoverage: overrides.silhouetteCoverage ?? overrides.frameCoverage ?? 0.25,
    bbox: overrides.bbox ?? [0.25, 0.25, 0.75, 0.75],
    centroid: overrides.centroid ?? [0.5, 0.5],
    inFrame: overrides.inFrame ?? true,
    // Only when the caller asks for it: a subject with no region luminance is the older
    // measurement shape, and exposure then falls back to the frame.
    ...(overrides.subjectLuminance === undefined ? {} : {
      luminance: {
        mean: overrides.subjectLuminance,
        median: overrides.subjectLuminance,
        p05: overrides.subjectLuminance * 0.6,
        p95: overrides.subjectLuminance * 1.3,
        clippedDarkFraction: overrides.subjectClippedDark ?? 0,
        clippedBrightFraction: overrides.subjectClippedBright ?? 0,
        pixels: 5000,
      },
    }),
  }
  return {
    viewId: overrides.viewId ?? 'active-camera',
    role: 'active-camera',
    frame: 1,
    metrics: {
      width: 640,
      height: 360,
      luminance: {
        mean: overrides.mean ?? 0.45,
        median: 0.45,
        p05: 0.15,
        p95: 0.75,
        stdDev: 0.2,
        clippedDarkFraction: overrides.clippedDark ?? 0.01,
        clippedBrightFraction: overrides.clippedBright ?? 0.01,
        histogram: new Array(64).fill(100),
      },
      objects: overrides.objects ?? [object],
    },
  }
}

// ---- a clean shot ----------------------------------------------------------

const clean = scoreView(view())
check('a well-framed, lit, unoccluded shot scores full marks with no findings',
  clean.score === 100 && clean.issues.length === 0, { score: clean.score, issues: clean.issues.map(i => i.code) })

// ---- composition -----------------------------------------------------------

const offCentre = scoreView(view({ centroid: [0.5, 0.95] }))
check('an off-centre subject is reported as a composition finding',
  offCentre.issues.length === 1 && offCentre.issues[0].code === 'SUBJECT_OFF_CENTER' &&
  offCentre.issues[0].category === 'composition',
  offCentre.issues.map(issue => `${issue.code}/${issue.severity}`))
check('the composition finding names the object, the view and the numbers behind it',
  offCentre.issues[0].objectId === 'subject' && offCentre.issues[0].viewId === 'active-camera' &&
  offCentre.issues[0].measurements.centerOffset > 0.4 &&
  /0\.4[0-9][0-9] from the centre/.test(offCentre.issues[0].evidence),
  offCentre.issues[0].evidence)

check('the further off-centre, the more severe the finding',
  scoreView(view({ centroid: [0.62, 0.5] })).issues[0].severity === 'minor' &&
  scoreView(view({ centroid: [0.80, 0.5] })).issues[0].severity === 'major' &&
  scoreView(view({ centroid: [0.95, 0.5] })).issues[0].severity === 'critical',
  [
    scoreView(view({ centroid: [0.62, 0.5] })).issues[0]?.severity,
    scoreView(view({ centroid: [0.80, 0.5] })).issues[0]?.severity,
    scoreView(view({ centroid: [0.95, 0.5] })).issues[0]?.severity,
  ])
check('a subject just inside the centring tolerance produces no finding',
  scoreView(view({ centroid: [0.58, 0.5] })).issues.length === 0,
  scoreView(view({ centroid: [0.58, 0.5] })).issues.map(issue => issue.code))

check('a subject too small to read as the subject is reported',
  scoreView(view({ frameCoverage: 0.01, silhouetteCoverage: 0.01 })).issues[0].code === 'SUBJECT_TOO_SMALL')
check('a subject that fills the frame is reported as cropped',
  scoreView(view({ frameCoverage: 0.8, silhouetteCoverage: 0.8 })).issues[0].code === 'SUBJECT_FILLS_FRAME')
check('an occluded subject is NOT also reported as too small, even though it covers less of the frame',
  // Two findings for one cause would send the reviewer to change the lens on a shot
  // whose problem is something standing in front of the subject.
  (() => {
    const scored = scoreView(view({ visiblePixels: 1250, visibleFraction: 0.25, occludedFraction: 0.75, frameCoverage: 0.06, silhouetteCoverage: 0.25 }))
    return scored.issues.length === 1 && scored.issues[0].code === 'SUBJECT_OCCLUDED'
  })(),
  scoreView(view({ visiblePixels: 1250, visibleFraction: 0.25, occludedFraction: 0.75, frameCoverage: 0.06, silhouetteCoverage: 0.25 })).issues.map(issue => issue.code))

// ---- occlusion -------------------------------------------------------------

const occluded = scoreView(view({ visibleFraction: 0.6, occludedFraction: 0.4, visiblePixels: 3000 }))
check('a partly hidden subject is reported as an occlusion finding',
  occluded.issues.length === 1 && occluded.issues[0].code === 'SUBJECT_OCCLUDED' &&
  occluded.issues[0].severity === 'major',
  occluded.issues.map(issue => `${issue.code}/${issue.severity}`))
check('an almost entirely hidden subject is critical, not major',
  scoreView(view({ visibleFraction: 0.1, occludedFraction: 0.9, visiblePixels: 500 })).issues[0].severity === 'critical')
check('occlusion is NOT reported for a subject that is visible enough',
  scoreView(view({ visibleFraction: 0.9, occludedFraction: 0.1 })).issues.length === 0)
check('a subject that is effectively absent is not also reported as occluded',
  // Both signals firing on one cause would double-charge the same defect.
  scoreView(view({ visibleFraction: 0, occludedFraction: 1, visiblePixels: 0, silhouettePixels: 100 }))
    .issues.every(issue => issue.code !== 'SUBJECT_OCCLUDED'))

// ---- exposure --------------------------------------------------------------

const dark = scoreView(view({ mean: 0.08, clippedDark: 0.12 }))
check('a dark frame is reported as underexposure with the measured numbers',
  dark.issues.length === 1 && dark.issues[0].code === 'FRAME_UNDEREXPOSED' &&
  dark.issues[0].objectId === null &&
  dark.issues[0].measurements.meanLuminance === 0.08,
  dark.issues.map(issue => issue.code))
check('a blown-out frame is reported as overexposure',
  scoreView(view({ mean: 0.9, clippedBright: 0.3 })).issues[0].code === 'FRAME_OVEREXPOSED')
check('a dark frame with clipped shadows is MORE severe than one that is merely dim',
  scoreView(view({ mean: 0.08, clippedDark: 0.12 })).issues[0].severity === 'critical' &&
  scoreView(view({ mean: 0.15, clippedDark: 0.01 })).issues[0].severity === 'major',
  [
    scoreView(view({ mean: 0.08, clippedDark: 0.12 })).issues[0].severity,
    scoreView(view({ mean: 0.15, clippedDark: 0.01 })).issues[0].severity,
  ])
check('a normally lit frame produces no exposure finding',
  scoreView(view({ mean: 0.45 })).issues.length === 0)

// ---- exposure is the PRODUCT's exposure, not the background's ---------------
//
// A product brief asks for a black background — it is the ordinary way to photograph a
// product, and SPEC.md:150 asks for exactly that. The frame's mean luminance then sits
// near zero however well the product is lit. Judging the frame reported a correctly lit
// watch as FRAME_UNDEREXPOSED and scored it 82; worse, the repair loop accepts only
// patches that RAISE the score, so it would have lightened the background to "fix" a
// scene that already matched the brief.

check('a correctly lit product on a black background is NOT reported as underexposed',
  scoreView(view({ mean: 0.03, clippedDark: 0.55, subjectLuminance: 0.46 })).issues.length === 0,
  scoreView(view({ mean: 0.03, clippedDark: 0.55, subjectLuminance: 0.46 })).issues.map(issue => issue.code))

check('the finding says which measurement it used, so the two cannot be confused',
  scoreView(view({ mean: 0.08, clippedDark: 0.12 })).issues[0].measurements.measuredOn === 'frame' &&
  scoreView(view({ mean: 0.03, clippedDark: 0.55, subjectLuminance: 0.02 })).issues[0]
    .measurements.measuredOn === 'subject',
  scoreView(view({ mean: 0.08, clippedDark: 0.12 })).issues[0].measurements)

check('a genuinely dark SUBJECT is still reported, and names the subject',
  (() => {
    const scored = scoreView(view({ mean: 0.03, clippedDark: 0.55, subjectLuminance: 0.02 }))
    return scored.issues.length === 1
      && scored.issues[0].code === 'FRAME_UNDEREXPOSED'
      && scored.issues[0].objectId === 'subject'
  })(),
  scoreView(view({ mean: 0.03, clippedDark: 0.55, subjectLuminance: 0.02 })).issues[0])

check('a blown-out product is reported even when the frame mean looks unremarkable',
  scoreView(view({ mean: 0.45, subjectLuminance: 0.99, subjectClippedBright: 0.4 }))
    .issues[0]?.code === 'FRAME_OVEREXPOSED',
  scoreView(view({ mean: 0.45, subjectLuminance: 0.99, subjectClippedBright: 0.4 })).issues.map(issue => issue.code))

// ---- the review-level score ------------------------------------------------

const review = scoreReview([
  view({ viewId: 'a', mean: 0.45 }),
  // A mean would have hidden this one behind the other three.
  view({ viewId: 'b', visibleFraction: 0.1, visiblePixels: 500 }),
  view({ viewId: 'c' }),
  view({ viewId: 'd' }),
], { subjectId: 'subject' })
check('a review scores as its WORST view, not its average',
  review.score === 82, { score: review.score, perView: review.perView })
check('the per-view scores are reported alongside the review score',
  review.perView.length === 4 && review.perView[1].score === 82)
check('the review pass threshold is the same constant the loop uses',
  VISUAL_PASS_SCORE === 90 && review.score < VISUAL_PASS_SCORE)

check('scoring only the declared subject leaves other objects alone',
  scoreReview([view({ objects: [
    { id: 'subject', viewId: 'a', visiblePixels: 5000, silhouettePixels: 5000, visibleFraction: 1, occludedFraction: 0, frameCoverage: 0.25, centroid: [0.5, 0.5], bbox: [0.25, 0.25, 0.75, 0.75], inFrame: true },
    { id: 'prop', viewId: 'a', visiblePixels: 100, silhouettePixels: 900, visibleFraction: 0.1, occludedFraction: 0.9, frameCoverage: 0.01, centroid: [0.9, 0.9], bbox: [0.8, 0.8, 1, 1], inFrame: false },
  ] })], { subjectId: 'subject' }).score === 100)

// ---- fingerprints ----------------------------------------------------------

check('a partially fixed problem keeps the same fingerprint',
  issueFingerprint({ category: 'exposure', code: 'FRAME_UNDEREXPOSED', objectId: null, buckets: [quantise(0.08, [0.10, 0.25, 0.55, 0.85], ['veryDark', 'dark', 'mid', 'bright', 'veryBright'])] }) ===
  issueFingerprint({ category: 'exposure', code: 'FRAME_UNDEREXPOSED', objectId: null, buckets: [quantise(0.09, [0.10, 0.25, 0.55, 0.85], ['veryDark', 'dark', 'mid', 'bright', 'veryBright'])] }))
check('two genuinely different problems get different fingerprints',
  issueFingerprint({ category: 'composition', code: 'SUBJECT_OFF_CENTER', objectId: 'a', buckets: ['farOff'] }) !==
  issueFingerprint({ category: 'composition', code: 'SUBJECT_OFF_CENTER', objectId: 'b', buckets: ['farOff'] }))

check('consecutive-repeat counters grow, and a finding that goes away resets',
  (() => {
    const counters = new Map()
    updateFingerprintCounters(counters, [{ fingerprint: 'x' }, { fingerprint: 'y' }])
    updateFingerprintCounters(counters, [{ fingerprint: 'x' }])
    const afterTwo = counters.get('x') === 2 && !counters.has('y')
    updateFingerprintCounters(counters, [])
    return afterTwo && counters.size === 0
  })())

// ---- handover decisions ----------------------------------------------------

check('a passing score stops the loop with PASSING_SCORE',
  shouldHandOver({ score: 95, iteration: 0, maxIterations: 5, fingerprints: new Map(), stopOnRepeatedIssueCount: 2 }).reason === 'PASSING_SCORE')
check('the iteration cap stops the loop with MAX_ITERATIONS',
  shouldHandOver({ score: 40, iteration: 5, maxIterations: 5, fingerprints: new Map(), stopOnRepeatedIssueCount: 2 }).reason === 'MAX_ITERATIONS')
check('a repeated finding stops the loop before the cap',
  shouldHandOver({ score: 40, iteration: 2, maxIterations: 5, fingerprints: new Map([['x', 2]]), stopOnRepeatedIssueCount: 2 }).reason === 'REPEATED_ISSUE')
check('a loop with iterations left and a fresh finding keeps going',
  shouldHandOver({ score: 40, iteration: 2, maxIterations: 5, fingerprints: new Map([['x', 1]]), stopOnRepeatedIssueCount: 2 }).stop === false)

// ---- findings validation ---------------------------------------------------

check('a finding for a view the review does not contain is discarded',
  validateFindings([{ category: 'composition', viewId: 'ghost', evidence: 'looks wrong to me' }],
    { viewIds: new Set(['a']), objectIds: new Set() }).rejected[0].reason === 'unknown viewId "ghost"')
check('a finding in an unknown category is discarded',
  validateFindings([{ category: 'vibes', viewId: 'a', evidence: 'it feels off' }],
    { viewIds: new Set(['a']), objectIds: new Set() }).rejected[0].reason === 'unknown category "vibes"')
check('a finding with no checkable evidence is discarded',
  validateFindings([{ category: 'exposure', viewId: 'a', evidence: 'dark' }],
    { viewIds: new Set(['a']), objectIds: new Set() }).rejected[0].reason === 'evidence is missing or too short to check')
check('a well-formed finding survives with its confidence, and a missing one defaults to 0.5',
  (() => {
    const { accepted } = validateFindings([
      { category: 'occlusion', viewId: 'a', objectId: 'subject', severity: 'major', confidence: 0.91, evidence: 'the left half of the subject is behind the screen' },
      { category: 'occlusion', viewId: 'a', evidence: 'something is in front of the subject' },
    ], { viewIds: new Set(['a']), objectIds: new Set(['subject']) })
    return accepted.length === 2 && accepted[0].confidence === 0.91 && accepted[1].confidence === 0.5
  })())
check('a finding that is not an array at all is reported, not silently dropped',
  validateFindings('looks fine', { viewIds: new Set(), objectIds: new Set() }).rejected.length === 1)
// The remaining two reasons a model finding is thrown away: it is not even an object, or it names a subject
// the review does not contain. Both are the same rule as the unknown view — a finding is a CLAIM ABOUT
// something that exists, and the second half of that sentence is checked here.
check('an entry that is not an object is rejected by name instead of being read for fields',
  (() => {
    const { accepted, rejected } = validateFindings(
      ['looks a bit dark to me', null, { category: 'exposure', viewId: 'a', evidence: 'the frame is underexposed' }],
      { viewIds: new Set(['a']), objectIds: new Set() },
    )
    return accepted.length === 1 && rejected.length === 2 &&
      rejected.every(entry => entry.reason === 'a finding must be an object')
  })())
check('a finding about a subject the review does not contain is rejected, naming the object id',
  (() => {
    const { accepted, rejected } = validateFindings(
      [{ category: 'occlusion', viewId: 'a', objectId: 'ghost-part', evidence: 'the dial is hidden behind the case' }],
      { viewIds: new Set(['a']), objectIds: new Set(['subject']) },
    )
    return accepted.length === 0 && rejected[0].reason === 'unknown objectId "ghost-part"'
  })())

// ---- the exposure sentence when the MEAN is fine ---------------------------
//
// `assessExposure` has two doors, and only one of them had ever been walked through: a mean below the floor.
// The other one — a perfectly reasonable mean with too many pixels piled up at the bottom of the range — is
// the case a dark-but-lit product produces, and the sentence has to say THAT instead of claiming the mean
// crossed a line it did not. (The first version of this sentence did exactly that, which is why it is
// asserted word for word.)
const clippedOnly = scoreView(view({ mean: 0.2, clippedDark: 0.3 }))
check('an acceptable mean with too many dark pixels is reported as CLIPPING, not as an under-exposed mean',
  clippedOnly.issues.length === 1 && clippedOnly.issues[0].code === 'FRAME_UNDEREXPOSED' &&
  clippedOnly.issues[0].severity === 'major' &&
  clippedOnly.issues[0].evidence === 'exposure measured on the whole frame is too dark: mean display luminance 0.200 is ' +
    'acceptable, but 0.300 of those pixels sit at the bottom of the range (limit 0.25)' &&
  clippedOnly.issues[0].measurements.clippedDarkFraction === 0.3,
  clippedOnly.issues[0]?.evidence)

// ---------------------------------------------------------------------------
// The loop, through its ports
// ---------------------------------------------------------------------------

/**
 * A loop harness whose scoring the TEST controls.
 *
 * `scores` is the sequence a review returns, per revision. The reviewer is a stub
 * that proposes whatever the test says, so every branch — applied, rejected, refused,
 * no-proposal — is reachable deterministically.
 */
function harness(options) {
  const applied = []
  const restored = []
  const reviews = []
  const scores = new Map(Object.entries(options.scores ?? {}))
  let reviewCount = 0

  const review = async ({ revision }) => {
    reviewCount += 1
    const score = scores.get(revision) ?? 100
    const state = {
      projectId: 'p',
      revision,
      digest: `d-${revision}`,
      iteration: reviewCount,
      score,
      pass: score >= VISUAL_PASS_SCORE,
      perView: [{ viewId: 'active-camera', score }],
      issues: score >= VISUAL_PASS_SCORE ? [] : (options.issueFor?.(revision, score) ?? [{
        id: `measured-${revision}`,
        category: 'occlusion',
        code: 'SUBJECT_OCCLUDED',
        severity: 'major',
        viewId: 'active-camera',
        objectId: 'subject',
        evidence: `only ${score / 100} of the subject survives`,
        measurements: {},
        confidence: 1,
        suggestedOperations: [],
        fingerprint: `occlusion|SUBJECT_OCCLUDED|subject|partlyHidden`,
      }]),
      sheet: { path: `revisions/${revision}/contact-sheets/round-0.png`, placements: [{ viewId: 'active-camera', row: 0, column: 0, box: [0, 0, 1, 1] }] },
      reported: [],
      rejected: [],
      views: [{ viewId: 'active-camera', cameraId: 'camera-main', frame: 1, purpose: 'the shot', luminance: { mean: 0.4, p05: 0.1, p95: 0.8, clippedDarkFraction: 0, clippedBrightFraction: 0 }, objects: [] }],
    }
    reviews.push(state)
    return state
  }

  const patch = async request => {
    if (options.refusePatch === true) {
      const error = new Error('the screen cannot be moved there')
      error.code = 'SCENE_PATCH_REJECTED'
      throw error
    }
    applied.push(request)
    const revision = `r000${applied.length + 1}`
    if (options.scoreAfterPatch !== undefined) scores.set(revision, options.scoreAfterPatch(applied.length, request))
    return { revision, digest: `d-${revision}` }
  }

  const restore = async request => { restored.push(request) }

  const reviewer = async ({ round }) => {
    if (options.reviewer !== undefined) return options.reviewer({ round, applied: applied.length })
    return {
      findings: [{ category: 'occlusion', viewId: 'active-camera', objectId: 'subject', severity: 'major', confidence: 0.9, evidence: 'the screen covers the left half of the table' }],
      operations: [{ op: 'entity.transform.update', entityId: 'screen', location: [-2, -1, 0.5], confidence: 0.95 }],
      note: 'move the screen aside',
    }
  }

  return { review, patch, restore, reviewer, applied, restored, reviews }
}

// ---- a fix that improves the score ----------------------------------------

{
  const world = harness({
    scores: { r0001: 82 },
    scoreAfterPatch: () => 100,
  })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a fix that measurably improves the score is adopted and the loop passes',
    run.passed === true && run.finalScore === 100 && run.startScore === 82 &&
    run.finalRevision === 'r0002' && run.stopReason === 'PASSING_SCORE',
    { start: run.startScore, final: run.finalScore, stop: run.stopReason })
  check('the adopted revision is committed through the normal patch port',
    world.applied.length === 1 && world.applied[0].baseRevision === 'r0001' &&
    world.applied[0].operations[0].op === 'entity.transform.update' &&
    world.applied[0].saveCheckpoint === true)
  check('the adopted round records the score transition it caused',
    run.rounds.some(round => round.outcome === 'applied' && round.reason === 'score 82 -> 100'))
  check('no rollback happened for an improving fix', world.restored.length === 0)
  check('the model\'s own finding is kept as REPORTED, not mixed into the measured issues',
    run.rounds.find(round => round.outcome === 'applied').reported.length === 1 &&
    run.openIssues.every(issue => issue.id.startsWith('measured-')),
    run.openIssues.map(issue => issue.id))
}

// ---- a fix that does not improve the score --------------------------------

{
  const world = harness({
    scores: { r0001: 82 },
    // The reviewer's fix is real but measures no better — the case that makes an
    // automated loop dangerous if it adopts whatever it is told.
    scoreAfterPatch: () => 82,
  })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a fix that does not improve the score is rolled back, not adopted',
    run.finalRevision === 'r0001' && run.finalScore === 82 &&
    world.restored.length >= 1 &&
    run.rounds.filter(round => round.outcome === 'rejected').length >= 1,
    { final: run.finalRevision, restored: world.restored.length })
  check('a rejected round explains the score it failed to beat',
    /score did not improve \(82 -> 82\)/.test(run.rounds.find(round => round.outcome === 'rejected').reason),
    run.rounds.find(round => round.outcome === 'rejected').reason)
  // The baseline is an observation, so the rule counts FAILED ATTEMPTS: it stops after
  // two, rather than spending three more renders to reach the cap.
  check('a loop that never improves stops on the repeated finding, short of the cap',
    run.stopReason === 'REPEATED_ISSUE' && run.iterations === 2,
    { stop: run.stopReason, iterations: run.iterations })
  check('the baseline observation does NOT count as a failed attempt',
    // With the baseline counted, this loop would stop after a single wasted round —
    // before it ever tried the second thing it thought of.
    run.rounds.filter(entry => entry.outcome === 'rejected').length === 2,
    run.rounds.map(entry => entry.outcome))
  check('the history keeps the rejected revision even though the pointer went back',
    run.rounds.some(round => round.newRevision !== null && round.outcome === 'rejected'))
}

// ---- the iteration cap -----------------------------------------------------

{
  // A different finding every round, so the repeated-issue rule never fires and the
  // cap is the only thing that can stop it. This is the "最多 5 轮" criterion.
  const world = harness({
    scores: { r0001: 30 },
    scoreAfterPatch: attempt => 30 + attempt,
    issueFor: (revision, score) => [{
      id: `measured-${revision}-${score}`,
      category: 'composition',
      code: `SUBJECT_OFF_CENTER_${score}`,
      severity: 'major',
      viewId: 'active-camera',
      objectId: 'subject',
      evidence: `round ${score} is off centre`,
      measurements: {},
      confidence: 1,
      suggestedOperations: [],
      fingerprint: `composition|SUBJECT_OFF_CENTER|subject|round-${score}`,
    }],
  })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a loop that keeps finding something new stops at exactly 5 iterations',
    run.iterations === 5 && run.stopReason === 'MAX_ITERATIONS' && world.applied.length === 5,
    { iterations: run.iterations, stop: run.stopReason, patches: world.applied.length })
  check('five rounds produced six scored states (a baseline plus one per round)',
    run.rounds.length === 6 && run.rounds[0].outcome === 'baseline',
    run.rounds.map(round => round.outcome))
  check('the score climbed monotonically across the adopted rounds',
    run.finalScore === 35 && run.rounds.map(round => round.score).join(',') === '30,30,31,32,33,34',
    run.rounds.map(round => round.score))
}

// ---- a patch the scene refuses ---------------------------------------------

{
  const world = harness({ scores: { r0001: 60 }, refusePatch: true })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a refused patch is recorded as a rejected round, not as a crash',
    run.rounds.some(round => round.outcome === 'rejected' && /PATCH_REFUSED/.test(round.reason)),
    run.rounds.map(round => round.reason))
  check('the loop still stops on its own when every patch is refused',
    run.finalRevision === 'r0001' && run.iterations === 2 && run.stopReason === 'REPEATED_ISSUE',
    { iterations: run.iterations, stop: run.stopReason })
}

// ---- the reviewer proposes nothing -----------------------------------------

{
  const world = harness({
    scores: { r0001: 70 },
    reviewer: () => ({ findings: [{ category: 'exposure', viewId: 'active-camera', severity: 'major', confidence: 0.9, evidence: 'the whole frame reads dark on the sheet' }], operations: [], note: null }),
  })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a reviewer with no fix stops the loop immediately and reports it',
    run.iterations === 1 && run.stopReason === 'NO_FIX_PROPOSED' && world.applied.length === 0,
    { iterations: run.iterations, stop: run.stopReason })
  check('the finding the model DID report is preserved even though it proposed no fix',
    run.rounds[1].reported.length === 1 && run.rounds[1].reported[0].category === 'exposure' &&
    run.rounds[1].reported[0].evidence.includes('dark'),
    run.rounds[1].reported)
}

// ---- low confidence --------------------------------------------------------

{
  const world = harness({
    scores: { r0001: 70 },
    reviewer: () => ({
      findings: [],
      operations: [{ op: 'light.update', lightId: 'key', energy: 500, confidence: 0.4 }],
      note: 'maybe brighter',
    }),
  })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5, minConfidenceForAutoFix: 0.8,
  })
  check('a below-confidence proposal is not applied, and the loop says so',
    run.stopReason === 'NO_CONFIDENT_FIX' && world.applied.length === 0,
    { stop: run.stopReason, applied: world.applied.length })
}

// ---- the handover package --------------------------------------------------

{
  const world = harness({ scores: { r0001: 45 }, scoreAfterPatch: () => 45 })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a loop that stops short of passing hands over with a reason and a revision',
    run.passed === false && run.handover !== null &&
    run.handover.reason === 'REPEATED_ISSUE' && run.handover.revision === 'r0001',
    run.handover)
  check('the handover names the open issues, so a human does not have to re-measure',
    run.handover.openIssues.length === 1 &&
    run.handover.openIssues[0].code === 'SUBJECT_OCCLUDED' &&
    run.handover.openIssues[0].measurements !== undefined,
    run.handover.openIssues.map(issue => issue.code))
  check('the handover lists the revisions that were tried and not adopted',
    run.handover.attemptedRevisions.length >= 1, run.handover.attemptedRevisions)
  check('the handover suggests something actionable rather than "check the logs"',
    run.handover.suggestions.length >= 2 &&
    run.handover.suggestions.some(line => /blender_scene_patch/.test(line)),
    run.handover.suggestions)
  check('the opened revision is never the polluted one',
    run.handover.revision === run.finalRevision && world.restored.every(entry => entry.revision === 'r0001'))
}

// ---- nothing to do ---------------------------------------------------------

{
  const world = harness({ scores: { r0001: 100 } })
  const run = await runVisualLoop({
    projectId: 'p', revision: 'r0001',
    review: world.review, patch: world.patch, restore: world.restore, reviewer: world.reviewer,
    maxIterations: 5,
  })
  check('a revision that already passes is not repaired, and no model call is spent',
    run.passed === true && run.iterations === 0 && world.applied.length === 0,
    { iterations: run.iterations, stop: run.stopReason })
  check('a run that passes reports NO handover, because there is nothing to hand over',
    run.handover === null, run.handover)
}

// ---------------------------------------------------------------------------
// The prose a model reads after a review
// ---------------------------------------------------------------------------

/**
 * Why this section exists when the loop above is already tested.
 *
 * `describeReviewNotes` is the text that becomes the `blender_visual_review` result — what a model
 * reads before it decides whether to touch the scene. It is branchier than it looks: seven
 * independent "is this part of the review present" questions, and every branch that needs a review
 * WITH findings was dark in the coverage reading until round 40, because reaching one for real takes
 * a render AND a vision-model call. So the review document below is composed from the REAL scorer
 * and the REAL findings validator, and only the prose is asserted.
 */
function reviewDocument({
  views,
  subjectId = 'subject',
  parts = [],
  reviewerError = null,
  omittedReviewer = false,
  findings = null,
  operations = [],
}) {
  const scored = scoreReview(views, { subjectId })
  const context = {
    viewIds: new Set(scored.perView.map(entry => entry.viewId)),
    objectIds: new Set(scored.issues.map(issue => issue.objectId).filter(Boolean)),
  }
  const verified = findings === null
    ? { accepted: [], rejected: [] }
    : validateFindings(findings, context)
  const document = {
    revision: 'r0001',
    checkpointRevision: 'r0000',
    score: scored.score,
    pass: scored.score >= VISUAL_PASS_SCORE,
    subjectId,
    parts,
    issues: scored.issues,
    reported: verified.accepted,
    rejected: verified.rejected,
    suggestedOperations: operations,
  }
  // A host that never consulted a reviewer omits the field entirely, which is a different code path
  // from one that tried and failed (`data.reviewer?.error` is `undefined`, not `null`).
  if (!omittedReviewer) document.reviewer = { error: reviewerError }
  return document
}

/** The index of the first line that starts with `prefix`, or -1. */
const lineIndex = (notes, prefix) => notes.findIndex(line => line.startsWith(prefix))

// A review that does NOT pass, and the three issues it must report: an occlusion that names the
// object it measured, a framing problem on the same object, and a frame-level exposure finding with
// NO object at all.
const blockedViews = [
  view({ viewId: 'three-quarter', visibleFraction: 0.2, occludedFraction: 0.8 }),
  view({ viewId: 'top', frameCoverage: 0.02, silhouetteCoverage: 0.02 }),
  view({ viewId: 'front', mean: 0.05 }),
]
const cleanViews = [view()]

const findings = [
  { category: 'composition', viewId: 'three-quarter', evidence: 'the subject sits too close to the left edge of the frame', confidence: 0.7 },
  { category: 'exposure', viewId: 'front', objectId: 'subject', evidence: 'the dial reads as a flat grey disc with no specular highlight' },
  { category: 'nonsense', viewId: 'top', evidence: 'this category is not in the closed set' },
  { category: 'occlusion', viewId: 'ghost-view', evidence: 'this view was never rendered' },
]
const operations = [{ op: 'setCamera', cameraId: 'front' }, { op: 'setLighting', lightId: 'key' }]

const blocked = reviewDocument({ views: blockedViews, findings, operations, parts: ['watch-dial'] })
const blockedNotes = describeReviewNotes(blocked)

// ---- the header ------------------------------------------------------------

check('the fixture is not vacuous: the review really does fail, and it really has measured issues',
  blocked.score < VISUAL_PASS_SCORE && blocked.issues.length === 3,
  { score: blocked.score, codes: blocked.issues.map(issue => issue.code) })
check('the header gives the revision, the checkpoint it was rendered from, and the verdict',
  blockedNotes[0] === 'Revision: r0001  (rendered from r0000)' &&
  blockedNotes[1] === `Score:    ${blocked.score}/100 — does NOT pass the delivery threshold`,
  blockedNotes.slice(0, 2))
check('a review that passes says PASSES',
  describeReviewNotes(reviewDocument({ views: cleanViews }))[1].includes('PASSES'))
check('a subject that was never tagged reads as "(none tagged)", not as null',
  describeReviewNotes(reviewDocument({ views: cleanViews, subjectId: null }))[2] === 'Subject:  (none tagged)')
check('declared subject parts are listed WITH the reason they are exempt from the occlusion rule',
  blockedNotes[3].includes('watch-dial') && blockedNotes[3].includes('ARE the subject'),
  blockedNotes[3])
check('with no declared parts the header says only the subject is judged for occlusion',
  describeReviewNotes(reviewDocument({ views: cleanViews })).some(line =>
    line.startsWith('Parts:') && line.includes('(none declared; only the subject is judged for occlusion)')))

// ---- the measured issues ---------------------------------------------------

check('a review with no measured issues says "(none)" instead of printing an empty list',
  describeReviewNotes(reviewDocument({ views: cleanViews })).includes('  (none)') &&
  lineIndex(describeReviewNotes(reviewDocument({ views: cleanViews })), '  [') === -1)
check('every measured issue reaches the model with its severity, code, view and the number behind it',
  blocked.issues.every(issue => {
    const index = lineIndex(blockedNotes, `  [${issue.severity}] ${issue.code} in view "${issue.viewId}"`)
    return index !== -1 && blockedNotes[index + 1] === `      ${issue.evidence}`
  }),
  blocked.issues.map(issue => issue.code))
check('an issue about a named object says which object, and a frame-level issue names none',
  blockedNotes.some(line => line.includes('SUBJECT_OCCLUDED') && line.endsWith('on "subject"')) &&
  !blockedNotes.find(line => line.includes('FRAME_UNDEREXPOSED')).includes(' on "'),
  blockedNotes.filter(line => line.startsWith('  [')))

// ---- a reviewer that could not be consulted --------------------------------

const reviewerDown = reviewDocument({
  views: blockedViews,
  reviewerError: { code: 'RUNTIME_UNAVAILABLE', message: 'the vision route returned 503' },
})
const reviewerDownNotes = describeReviewNotes(reviewerDown)

check('a reviewer that could not be consulted is stated, with its code and message',
  reviewerDownNotes.some(line => line.includes('[RUNTIME_UNAVAILABLE] the vision route returned 503')))
check('that warning comes BEFORE the findings section, so the empty list is not read as "nothing to see"',
  lineIndex(reviewerDownNotes, 'The vision reviewer could NOT be consulted') <
  lineIndex(reviewerDownNotes, 'What the vision model reported seeing on the sheet:'))
check('with no reviewer available the reported section says why it is empty',
  reviewerDownNotes.includes('  (no reviewer was available)') &&
  !reviewerDownNotes.includes('  (nothing that survived validation)'))
check('a review document with no reviewer field at all behaves like one whose reviewer errored',
  describeReviewNotes(reviewDocument({ views: blockedViews, omittedReviewer: true })).includes('  (nothing that survived validation)'))

// ---- what the vision model reported ---------------------------------------

check('a reported finding carries its confidence, the object when it named one, and its evidence',
  blocked.reported.length === 2 && blocked.reported.every(finding => {
    const index = blockedNotes.indexOf(
      `  [${finding.severity}] ${finding.category} in view "${finding.viewId}"` +
      `${finding.objectId ? ` on "${finding.objectId}"` : ''} (confidence ${finding.confidence})`,
    )
    return index !== -1 && blockedNotes[index + 1] === `      ${finding.evidence}`
  }),
  blockedNotes.filter(line => line.startsWith('  [')))
check('a reported finding that named no object omits the clause rather than printing "on null"',
  blockedNotes.includes('  [major] composition in view "three-quarter" (confidence 0.7)'))
const survived = reviewDocument({ views: blockedViews, findings: findings.slice(0, 2) })
check('a review whose findings all survived validation does not claim anything was discarded',
  survived.reported.length === 2 && survived.rejected.length === 0 &&
  !describeReviewNotes(survived).some(line => line.startsWith('Discarded findings')))

// ---- what was thrown away, and what was proposed ---------------------------

check('discarded findings are named as discarded, counted, and each carries the reason it was refused',
  blocked.rejected.length === 2 &&
  blockedNotes.includes('Discarded findings (2) — they named something the review does not contain:') &&
  blocked.rejected.every(entry => blockedNotes.includes(`  - ${entry.reason}`)),
  blocked.rejected.map(entry => entry.reason))
check('proposed ScenePatch operations are counted, and both ways to apply them are named',
  blockedNotes.includes('The reviewer proposed 2 ScenePatch operation(s); apply them with') &&
  blockedNotes.includes('blender_scene_patch if you agree, or run blender_visual_autofix to let the host try them.'))
check('a review with no proposal says nothing at all about patching',
  !describeReviewNotes(reviewDocument({ views: cleanViews })).some(line => line.includes('ScenePatch')))

// ---- the builder itself ----------------------------------------------------

check('the builder is pure: it does not mutate the review it is handed, and two calls agree',
  JSON.stringify(describeReviewNotes(blocked)) === JSON.stringify(blockedNotes) &&
  blocked.issues.length === 3 && blocked.reported.length === 2 && blocked.rejected.length === 2)
check('no line leaks a JavaScript value into the prose',
  !blockedNotes.some(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)) &&
  !reviewerDownNotes.some(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)) &&
  !describeReviewNotes(reviewDocument({ views: cleanViews, subjectId: null })).some(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)),
  blockedNotes.filter(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)))

// ---------------------------------------------------------------------------
// The prose a model reads after an automated repair loop
// ---------------------------------------------------------------------------

/**
 * `describeLoopNotes` is the third of the three model-facing blocks in the tool plane, and this one
 * is fed a REAL loop result: the two runs below come out of `runVisualLoop` through the harness above,
 * so the round outcomes, the open issues and the handover in the notes are the ones the loop actually
 * produced rather than a hand-written imitation of them.
 */
const cappedWorld = harness({
  scores: { r0001: 30 },
  scoreAfterPatch: attempt => 30 + attempt,
  issueFor: (revision, score) => [{
    id: `measured-${revision}-${score}`,
    category: 'composition',
    code: `SUBJECT_OFF_CENTER_${score}`,
    severity: 'major',
    viewId: 'active-camera',
    objectId: 'subject',
    evidence: `round ${score} is off centre`,
    measurements: {},
    confidence: 1,
    suggestedOperations: [],
    fingerprint: `composition|SUBJECT_OFF_CENTER|subject|round-${score}`,
  }],
})
const cappedRun = await runVisualLoop({
  projectId: 'p', revision: 'r0001',
  review: cappedWorld.review, patch: cappedWorld.patch, restore: cappedWorld.restore, reviewer: cappedWorld.reviewer,
  maxIterations: 5,
})
const cappedNotes = describeLoopNotes(cappedRun)

const passingWorld = harness({ scores: { r0001: 100 } })
const passingRun = await runVisualLoop({
  projectId: 'p', revision: 'r0001',
  review: passingWorld.review, patch: passingWorld.patch, restore: passingWorld.restore, reviewer: passingWorld.reviewer,
  maxIterations: 5,
})
const passingNotes = describeLoopNotes(passingRun)

// ---- the header ------------------------------------------------------------

check('the header gives the score it started from and reached, and the verdict',
  cappedNotes[0] === `Score:    ${cappedRun.startScore} -> ${cappedRun.finalScore}  (still below the threshold)` &&
  passingNotes[0] === `Score:    ${passingRun.startScore} -> ${passingRun.finalScore}  (PASSES)`,
  [cappedNotes[0], passingNotes[0]])
check('the header gives the revisions, the rounds spent out of the cap, and why it stopped',
  cappedNotes[1] === `Revision: ${cappedRun.startRevision} -> ${cappedRun.finalRevision}` &&
  cappedNotes[2] === `Rounds:   ${cappedRun.iterations} of ${cappedRun.maxIterations} used` &&
  cappedNotes[3] === `Stopped:  ${cappedRun.stopReason}`,
  cappedNotes.slice(1, 4))

// ---- the round log ---------------------------------------------------------

const expectedRoundLines = cappedRun.rounds.flatMap(round => [
  `  round ${round.round}: ${round.outcome}${round.newRevision !== null ? ` -> ${round.newRevision}` : ''} — score ${round.score}` +
  `${round.reason !== null ? `, ${round.reason}` : ''}`,
  ...(round.reported ?? []).map(finding => `      saw: [${finding.category}] ${finding.evidence}`),
])
check('every round is reported, including the ones that changed nothing',
  cappedRun.rounds.length === 6 && cappedNotes.slice(6, 6 + expectedRoundLines.length).join('\n') === expectedRoundLines.join('\n'),
  cappedNotes.slice(6, 12))
check('the log names the round that did NOT produce a new revision, rather than printing "-> null"',
  cappedRun.rounds.some(round => round.newRevision === null) &&
  cappedNotes.some(line => line.startsWith('  round ') && !line.includes(' -> null')) &&
  cappedNotes.some(line => line.includes(' -> r0002')),
  cappedNotes.filter(line => line.startsWith('  round ')))
check('a round that saw something says what the model saw, in the round it saw it',
  cappedRun.rounds.reduce((total, round) => total + (round.reported ?? []).length, 0) > 0 &&
  cappedNotes.filter(line => line.startsWith('      saw: ')).length ===
  cappedRun.rounds.reduce((total, round) => total + (round.reported ?? []).length, 0),
  cappedNotes.filter(line => line.startsWith('      saw: ')))

// ---- what is still open, and the handover ----------------------------------

check('the open issues are listed under a header, with the same two lines the review uses',
  cappedRun.openIssues.length > 0 && cappedNotes.includes('Still open:') &&
  cappedRun.openIssues.every(issue => {
    const pair = describeIssueLines(issue)
    const index = cappedNotes.indexOf(pair[0])
    return index !== -1 && cappedNotes[index + 1] === pair[1]
  }),
  cappedRun.openIssues.map(issue => issue.code))
check('a loop that passes lists no open issues, because it has none',
  passingRun.openIssues.length === 0 && !passingNotes.includes('Still open:'))
check('the handover names the reason, the revision to work from, and the ones that were tried',
  cappedNotes.includes('HUMAN/SESSION HANDOVER — the loop stopped short of passing:') &&
  cappedNotes.includes(`  reason:   ${cappedRun.handover.reason}`) &&
  cappedNotes.includes(`  work from: ${cappedRun.handover.revision}`) &&
  cappedNotes.includes(`  tried:     ${cappedRun.handover.attemptedRevisions.join(', ')} (kept in the history, not adopted)`),
  cappedRun.handover)
check('the handover carries the next steps the loop decided on, one line each',
  cappedRun.handover.suggestions.length > 0 &&
  cappedRun.handover.suggestions.every(suggestion => cappedNotes.includes(`    - ${suggestion}`)) &&
  cappedNotes.filter(line => line.startsWith('    - ')).length === cappedRun.handover.suggestions.length)
check('a loop that reached a passing score reports NO handover, because there is nothing to hand over',
  passingRun.handover === null && !passingNotes.some(line => line.includes('HUMAN/SESSION HANDOVER')))

// ---- the shared issue line -------------------------------------------------

check('one measured issue is two lines: the finding, then the evidence behind it',
  JSON.stringify(describeIssueLines({ severity: 'critical', code: 'SUBJECT_OCCLUDED', viewId: 'top', objectId: 'watch-body', evidence: 'only 0.200 survives' })) ===
  JSON.stringify(['  [critical] SUBJECT_OCCLUDED in view "top" on "watch-body"', '      only 0.200 survives']))
check('an issue about no particular object omits the clause rather than printing "on null"',
  describeIssueLines({ severity: 'major', code: 'FRAME_UNDEREXPOSED', viewId: 'front', objectId: null, evidence: 'the frame is dark' })[0] ===
  '  [major] FRAME_UNDEREXPOSED in view "front"')

// ---- the builder itself ----------------------------------------------------

check('the loop builder is pure and two calls agree',
  JSON.stringify(describeLoopNotes(cappedRun)) === JSON.stringify(cappedNotes) &&
  cappedRun.rounds.length === 6 && cappedRun.openIssues.length > 0)
check('no line of the loop report leaks a JavaScript value into the prose',
  !cappedNotes.some(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)) &&
  !passingNotes.some(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)),
  cappedNotes.filter(line => /undefined|\bnull\b|NaN|\[object Object\]/.test(line)))

// ---------------------------------------------------------------------------
// The text the tool actually assembles
// ---------------------------------------------------------------------------

/**
 * The builder's output is not the model's input: the tool appends its own tail to it. Round 40 is the
 * revision that needed this check — extracting the handover block into `describeLoopNotes` left the
 * block BEHIND in `blender_visual_autofix`, so the builder produced it and the tool appended it again.
 * A real run would have shown the same handover twice, and no check in this file could see it, because
 * nothing here executed the tool. It was found by a mutation run whose anchor turned out to appear
 * twice; this section makes the next one fail on its own.
 */
const toolHarness = new Context()
const registeredTools = new Map()
// What the stubbed host will answer with next: the failing run first, then a passing one.
let loopAnswer = cappedRun
toolHarness.plugin({
  name: 'visual-tool-harness',
  apply(ctx) {
    ctx.provide('tools', {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => registeredTools.delete(definition.name)
      },
      get: name => registeredTools.get(name),
      schemas: () => [],
      execute: async () => { throw new Error('this harness calls the definition directly') },
    })
    // The loop is stubbed with the run the harness above already produced, so the assembled text is
    // built from a real result without a render, a model call or a project on disk.
    ctx.provide('blenderStudio', { visualLoop: async () => loopAnswer })
  },
})
toolHarness.plugin(await import('@deepblend/dsh-blender-tool'))
for (let attempt = 0; attempt < 40 && !registeredTools.has('blender_visual_autofix'); attempt += 1) {
  await new Promise(settle => setTimeout(settle, 25))
}

const autofix = registeredTools.get('blender_visual_autofix')
const autofixResult = autofix === undefined
  ? { ok: false, text: '', error: 'blender_visual_autofix was never registered' }
  : await autofix.execute({ projectId: 'p' }, { signal: undefined })
const autofixText = autofixResult.text ?? ''
const occurrences = needle => autofixText.split(needle).length - 1

check('the tool runs against a stub host and reports the loop it was handed',
  autofixResult.ok === true && autofixText.startsWith(`Visual repair stopped at ${cappedRun.finalScore}/100 on ${cappedRun.finalRevision}; it needs a human decision.`),
  autofixResult.error ?? autofixText.split('\n')[0])
check('the handover the builder produced reaches the model exactly ONCE',
  occurrences('HUMAN/SESSION HANDOVER') === 1 && occurrences('Still open:') === 1,
  { handover: occurrences('HUMAN/SESSION HANDOVER'), stillOpen: occurrences('Still open:') })
check('the next steps are listed once each, not once per copy of the block',
  autofixText.split('\n').filter(line => line.startsWith('    - ')).length === cappedRun.handover.suggestions.length,
  autofixText.split('\n').filter(line => line.startsWith('    - ')).length)
loopAnswer = passingRun
const passingResult = await (registeredTools.get('blender_visual_autofix') ?? { execute: async () => ({ ok: false, text: '' }) })
  .execute({ projectId: 'p' }, { signal: undefined })
check('a run that passes says which revision reached which score, and carries no handover at all',
  passingResult.ok === true &&
  passingResult.text.startsWith(`Visual repair reached ${passingRun.finalScore}/100 on ${passingRun.finalRevision}.`) &&
  passingResult.text.includes(`Score:    ${passingRun.startScore} -> ${passingRun.finalScore}  (PASSES)`) &&
  !passingResult.text.includes('HUMAN/SESSION HANDOVER'),
  passingResult.text?.split('\n')[0])

check('every line the builder produced survives into the tool text, in order',
  describeLoopNotes(cappedRun).every((line, index, all) => {
    const at = autofixText.indexOf(all.slice(0, index + 1).join('\n'))
    return at !== -1
  }))

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok).length
console.log('')
console.log(`VisualIssue + loop contract: ${results.length - failed}/${results.length} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
