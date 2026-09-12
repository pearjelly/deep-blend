/**
 * The visual iteration controller (SPEC §12.1 PREVIEW → VISUAL_REVIEW → PATCH loop).
 *
 * WHAT THIS FILE IS ALLOWED TO KNOW
 * ---------------------------------
 * It knows nothing about Blender, files, Cordis or HTTP. Everything it does happens
 * through four injected ports:
 *
 *   review()    measure a revision and produce a scored VisualReview
 *   patch()     commit a ScenePatch and return the new revision
 *   restore()   move the current pointer back
 *   reviewer()  ask the vision model what it sees, and what it would change
 *
 * That boundary is not decoration. It is what lets the loop's SEMANTICS — the
 * iteration cap, the repeated-issue stop, "only adopt a change that improves the
 * score", and the handover package — be tested deterministically against a stub,
 * while "the model really sees the image" is tested once, live. Mixing those two
 * claims into one untestable blob is how a project ends up asserting only one of
 * them (decision D34).
 *
 * WHY A REJECTED FIX IS ROLLED BACK RATHER THAN LEFT IN PLACE
 * ----------------------------------------------------------
 * The revision history is append-only (M1), so the rejected revision stays on disk
 * and stays in the history — that is the audit trail. But the CURRENT POINTER is a
 * statement about which revision is the deliverable, and moving it to a revision
 * that measured worse would make the project worse while claiming progress. So: keep
 * the history, decline the pointer. The rollback is itself recorded, in the round
 * record and in the run document.
 *
 * WHICH PACKAGE THIS LIVES IN
 * --------------------------
 * `contracts`, beside the scorer and the sheet compositor, and not in the host
 * package that calls it. "Contracts" here means the project's own vocabulary and its
 * pure rules — `visual-issue.js` already holds the scoring rules by that reading — and
 * the loop controller is the rest of them: what may be adopted, when to stop, what a
 * handover contains. It imports nothing outside this package, which is what lets the
 * acceptance suite exercise it without a Blender, a Cordis context or a model.
 *
 * Owner: DeepBlend Studio — M2
 */

import {
  VISUAL_PASS_SCORE,
  seedFingerprintCounters,
  shouldHandOver,
  updateFingerprintCounters,
  validateFindings,
} from './visual-issue.js'

/**
 * @typedef {object} VisualReviewRound
 * @property {number} round - 1-based.
 * @property {string} revision - the revision reviewed in this round.
 * @property {number} score
 * @property {number} issueCount
 * @property {string[]} issueCodes
 * @property {object[]} reported - findings the vision model authored and that passed validation.
 * @property {object[]} rejectedFindings - findings the model authored that did not.
 * @property {string} outcome - one of `baseline`, `applied`, `rejected`, `stopped`, `handover`.
 * @property {string|null} reason
 * @property {string|null} newRevision
 * @property {object|null} appliedPatch
 * @property {string} [rolledBackTo] - set on a round whose revision was committed and
 *   then declined: the revision stays in the history, the current pointer went back.
 */

/**
 * Run the visual loop.
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.revision - the starting (current) revision.
 * @param {(request: object) => Promise<object>} input.review
 *   `({ projectId, revision, iteration, signal }) => VisualReview` — measures and scores.
 * @param {(request: object) => Promise<object>} input.patch
 *   `({ projectId, baseRevision, operations, note, actor, stage, idempotencyKey, saveCheckpoint, signal }) => RevisionSummary`
 * @param {(request: object) => Promise<object>} input.restore
 *   `({ projectId, revision, reason }) => unknown`
 * @param {(request: object) => Promise<{ findings: object[], operations: object[], note: string|null, detail: object|null }>} input.reviewer
 *   The vision port. Receives `{ review, round, previousRounds, signal }`.
 * @param {(line: string) => void} [input.log]
 * @param {number} [input.maxIterations]
 * @param {number} [input.stopOnRepeatedIssueCount]
 * @param {number} [input.minConfidenceForAutoFix]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<object>} the run document: rounds, final score, open issues and
 *   a handover package whenever the loop stopped short of passing.
 */
export async function runVisualLoop(input) {
  const maxIterations = positiveInteger(input.maxIterations, 5)
  const stopOnRepeatedIssueCount = positiveInteger(input.stopOnRepeatedIssueCount, 2)
  const minConfidence = numberInRange(input.minConfidenceForAutoFix, 0.8)
  const log = typeof input.log === 'function' ? input.log : () => {}

  /** @type {VisualReviewRound[]} */
  const rounds = []
  /** @type {Map<string, number>} */
  const fingerprints = new Map()

  let currentRevision = input.revision
  let iteration = 0
  let handedOver = null

  /** The latest measured state. Replaced (never mutated) when a round is adopted. */
  let currentReview = await input.review({
    projectId: input.projectId,
    revision: currentRevision,
    iteration,
    signal: input.signal,
  })
  let score = currentReview.score
  // The baseline is an OBSERVATION, not an attempt, so it seeds the counters at zero
  // rather than one. Counting it would make "the same issue recurred twice" true
  // after a single failed fix — and the loop would then stop before trying the second
  // thing it thought of, which is the opposite of what SPEC §12.3 asks for. The rule
  // is about a problem that survives REPEATED FIX ATTEMPTS.
  seedFingerprintCounters(fingerprints, currentReview.issues)
  rounds.push({
    round: 0,
    revision: currentRevision,
    score,
    issueCount: currentReview.issues.length,
    issueCodes: currentReview.issues.map(issue => issue.code),
    reported: [],
    rejectedFindings: [],
    outcome: 'baseline',
    reason: null,
    newRevision: null,
    appliedPatch: null,
  })
  log(`baseline ${currentRevision}: score ${score}, ${currentReview.issues.length} measured issue(s)`)

  while (true) {
    const decision = shouldHandOver({
      score,
      iteration,
      maxIterations,
      fingerprints,
      stopOnRepeatedIssueCount,
    })
    if (decision.stop) {
      handedOver = {
        reason: decision.reason,
        fingerprint: decision.fingerprint ?? null,
        iteration,
        score,
        revision: currentRevision,
      }
      log(`stopping after ${iteration} iteration(s): ${decision.reason}`)
      break
    }

    iteration += 1
    const vision = await input.reviewer({
      review: currentReview,
      round: iteration,
      previousRounds: rounds.filter(round => round.outcome === 'applied' || round.outcome === 'rejected'),
      signal: input.signal,
    })

    // The model's findings are validated against the review it was shown, and the
    // ones that survive are kept as the round's `reported` list. They are NOT added
    // to the review's `issues`: the score must stay a function of measurements
    // (D30), so a finding only the model can see is evidence for a human, never for
    // the scorer.
    const context = {
      viewIds: new Set(currentReview.perView.map(entry => entry.viewId)),
      objectIds: new Set(objectIdsOf(currentReview)),
    }
    const validated = validateFindings(vision.findings, context)

    const candidates = (vision.operations ?? []).filter(operation => {
      const confidence = typeof operation?.confidence === 'number' ? operation.confidence : 1
      return confidence >= minConfidence
    })

    /** @type {VisualReviewRound} */
    const round = {
      round: iteration,
      revision: currentRevision,
      score,
      issueCount: currentReview.issues.length,
      issueCodes: currentReview.issues.map(issue => issue.code),
      reported: validated.accepted,
      rejectedFindings: validated.rejected,
      outcome: 'stopped',
      reason: null,
      newRevision: null,
      appliedPatch: null,
    }

    if (candidates.length === 0) {
      round.reason = (vision.operations ?? []).length > 0 ? 'NO_CONFIDENT_FIX' : 'NO_FIX_PROPOSED'
      rounds.push(round)
      handedOver = { reason: round.reason, fingerprint: null, iteration, score, revision: currentRevision }
      log(`round ${iteration}: the reviewer proposed no usable change (${round.reason})`)
      break
    }

    const operations = candidates.flatMap(operation => normaliseOperation(operation))
    if (operations.length === 0) {
      round.reason = 'NO_FIX_PROPOSED'
      rounds.push(round)
      handedOver = { reason: round.reason, fingerprint: null, iteration, score, revision: currentRevision }
      break
    }

    let summary
    try {
      summary = await input.patch({
        projectId: input.projectId,
        baseRevision: currentRevision,
        operations,
        note: vision.note ?? `visual review round ${iteration}`,
        actor: 'deepblend.visual-loop',
        stage: 'VISUAL_REVIEW',
        // A deterministic key: the same operations against the same base revision
        // are the same intent, so a retry after a crash replays instead of
        // committing twice (M1's idempotency semantics, for free).
        idempotencyKey: `visual-${input.projectId}-${currentRevision}-${iteration}`,
        saveCheckpoint: true,
        signal: input.signal,
      })
    } catch (cause) {
      // A refused patch is not a crash: it is the reviewer having proposed
      // something the scene will not accept, which is information. Record it and
      // keep going — the next round sees the failure in `previousRounds`.
      round.outcome = 'rejected'
      round.reason = `PATCH_REFUSED: ${cause instanceof Error ? cause.message : String(cause)}`
      rounds.push(round)
      // ...but the measured state is unchanged, so the same findings are present
      // again and this round has to count towards the repeated-issue rule. Without
      // this, a scene that refuses every proposal would run to the iteration cap
      // instead of recognising what is happening after the second refusal.
      updateFingerprintCounters(fingerprints, currentReview.issues)
      continue
    }

    round.appliedPatch = { operations, note: vision.note ?? null }
    round.newRevision = summary.revision

    const after = await input.review({
      projectId: input.projectId,
      revision: summary.revision,
      iteration,
      signal: input.signal,
    })

    if (after.score > score) {
      const previousScore = score
      score = after.score
      currentRevision = summary.revision
      currentReview = after
      round.outcome = 'applied'
      round.reason = `score ${previousScore} -> ${score}`
      rounds.push(round)
      updateFingerprintCounters(fingerprints, after.issues)
      log(`round ${iteration}: applied ${operations.length} operation(s), score ${previousScore} -> ${score} on ${currentRevision}`)
      continue
    }

    // Not an improvement. Keep the history, decline the pointer.
    await input.restore({
      projectId: input.projectId,
      revision: round.revision,
      reason: `visual round ${iteration} measured ${after.score}, not better than ${score}`,
    })
    round.outcome = 'rejected'
    round.reason = `score did not improve (${score} -> ${after.score})`
    round.rolledBackTo = round.revision
    rounds.push(round)
    // The measured state is unchanged (the pointer went back), so the same
    // fingerprints are present again — which is exactly what makes a fix that
    // cannot work stop the loop instead of repeating until the cap.
    updateFingerprintCounters(fingerprints, currentReview.issues)
    log(`round ${iteration}: rejected — score did not improve (${score} -> ${after.score}); pointer restored to ${currentRevision}`)
  }

  // A handover is something a human has to pick up, so a run that PASSED has none.
  // Reporting one would tell a reader to take over work that is finished.
  const handover = handedOver === null || handedOver.reason === 'PASSING_SCORE'
    ? null
    : buildHandover({ handedOver, openIssues: currentReview.issues, rounds, review: currentReview })

  return {
    projectId: input.projectId,
    startRevision: input.revision,
    finalRevision: currentRevision,
    startScore: rounds[0].score,
    finalScore: score,
    passed: score >= VISUAL_PASS_SCORE,
    iterations: iteration,
    maxIterations,
    stopReason: handedOver?.reason ?? 'PASSING_SCORE',
    rounds,
    openIssues: currentReview.issues,
    sheet: currentReview.sheet ?? null,
    handover,
  }
}

/**
 * Every object id named anywhere in a review, measured or reported.
 *
 * The set is the validation context for the model's findings: an object the review
 * never measured is still legitimate to talk about IF the review mentions it (a
 * finding may name a second object as the thing in the way), so the context is
 * everything the review knows rather than only the subject.
 *
 * @param {object} review
 * @returns {string[]}
 */
function objectIdsOf(review) {
  const ids = new Set()
  for (const issue of review.issues ?? []) {
    if (issue.objectId) ids.add(issue.objectId)
  }
  return [...ids]
}

/**
 * The package a human needs to take over (SPEC §20 M2 "失败可人工接管").
 *
 * Three things, and each one answers a different question a person asks when they
 * open the project: WHERE is the work (a revision that is not polluted), WHAT is
 * still wrong (the measured issues, with the numbers), and WHAT TO DO NEXT
 * (concrete operations and views, not "adjust the lighting").
 *
 * @param {object} input
 * @returns {object}
 */
function buildHandover(input) {
  const { handedOver, openIssues, rounds, review } = input
  const investigatedViews = [...new Set(openIssues.map(issue => issue.viewId).filter(Boolean))]
  const attempted = rounds.filter(round => round.appliedPatch !== null)

  const suggestions = []
  if (openIssues.length > 0) {
    suggestions.push(
      `Look at the ${openIssues.length} open issue(s) below with ` +
      `${review.sheet?.path ?? 'the contact sheet'} open; the measurements name the view and the object.`,
    )
  }
  for (const viewId of investigatedViews) suggestions.push(`Re-render view "${viewId}" alone at full resolution before editing.`)
  if (attempted.length > 0) {
    suggestions.push(
      `The automated rounds tried ${attempted.length} change(s) and none improved the measured score; ` +
      'the review rounds below record exactly what each one was.',
    )
  }
  if (handedOver.reason === 'REPEATED_ISSUE') {
    suggestions.push(
      `The same finding recurred without improving (${handedOver.fingerprint ?? 'see rounds'}), ` +
      'so the loop stopped rather than spending another render on it.',
    )
  }
  suggestions.push(
    'Edit the scene with blender_scene_patch, or open the checkpoint in Blender and re-sync the scene summary afterwards.',
  )

  return {
    reason: handedOver.reason,
    iteration: handedOver.iteration,
    score: handedOver.score,
    /** The revision to work from: whatever the loop last accepted, current pointer included. */
    revision: handedOver.revision,
    /** Where the failing revision still lives, so a human can inspect what was tried. */
    attemptedRevisions: attempted.map(round => round.newRevision).filter(revision => revision !== null),
    openIssues,
    views: investigatedViews,
    suggestions,
  }
}

/**
 * Coerce one proposed operation into a ScenePatch operation.
 *
 * The reviewer may hand back either a bare operation or one wrapped with a
 * confidence score, because the prompt asks for the latter and models are
 * inconsistent about honouring a shape. Accepting both is cheaper than a retry, and
 * the wrapper is dropped here so nothing downstream has to know about it.
 *
 * @param {object} proposed
 * @returns {object[]}
 */
function normaliseOperation(proposed) {
  if (proposed === null || typeof proposed !== 'object') return []
  const operation = 'op' in proposed ? proposed : proposed.operation
  if (operation === null || typeof operation !== 'object' || typeof operation.op !== 'string') return []
  return [operation]
}

/** A positive integer option, with a default. */
function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** A number in [0, 1], with a default. */
function numberInRange(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback
}
