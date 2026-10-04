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
 * iteration cap, the repeated-issue stop, "only adopt evidenced improvements without
 * regression", and the handover package — be tested deterministically against a stub,
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
import { validateArtisticReview, artisticRegressed } from './artistic-review.js'
import { reviewInputsDigest } from './scene-spec.js'

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
 *   `({ projectId, revision, iteration, subjectId?, signal }) => VisualReview` — measures and scores.
 *   After the baseline, an own subjectId (including null) fixes what is measured.
 * @param {(request: object) => Promise<object>} input.patch
 *   `({ projectId, baseRevision, operations, note, actor, stage, idempotencyKey, saveCheckpoint, signal }) => RevisionSummary`
 * @param {(request: object) => Promise<object>} input.restore
 *   `({ projectId, revision, expectedCurrentRevision, reason }) => unknown` — rejects a concurrent current-revision change.
 * @param {(request: object) => Promise<{ findings: object[], operations: object[], note: string|null, detail: object|null }>} input.reviewer
 *   The vision port. Receives `{ review, baselineReview?, round, previousRounds, signal }`.
 *   Returns artistic dimension assessments and, for a candidate, a comparison judgment.
 * @param {(line: string) => void} [input.log]
 * @param {number} [input.maxIterations]
 * @param {number} [input.stopOnRepeatedIssueCount]
 * @param {number} [input.minConfidenceForAutoFix]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<object>} the run document: rounds, final score, open issues and
 *   a handover package whenever the loop stopped short of passing.
 */
export async function runVisualLoop(input) {
  const maxIterations = input.maxIterations === 0 ? 0 : positiveInteger(input.maxIterations, 5)
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
  const authoredInputsDigest = checkedReviewInputsDigest(currentReview)
  // Legacy measurement-only ports omitted both subject identity and scene context.
  // Real Host reviews carry these facts, so later rounds must prove the same subject.
  const subjectFixed = hasSubjectEvidence(currentReview)
  const fixedSubjectId = currentReview.subjectId ?? null
  const subjectEvidence = { sceneContext: currentReview.sceneContext != null, subject: currentReview.subject != null }
  const baselineSubjectError = subjectFixed ? reviewedSubjectIssue(currentReview, fixedSubjectId) : null
  let artistic = validateArtisticReview(null, new Set(), minConfidence, {
    subject: baselineSubjectError ? { available: false, reason: baselineSubjectError.message } : currentReview.subject,
  })
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
    reason: baselineSubjectError?.message ?? null,
    ...(subjectFixed ? { fixedSubjectId } : {}),
    newRevision: null,
    appliedPatch: null,
  })
  log(`baseline ${currentRevision}: score ${score}, ${currentReview.issues.length} measured issue(s)`)

  while (true) {
    if (baselineSubjectError) {
      handedOver = { reason: baselineSubjectError.reviewSubjectReason, iteration, score, revision: currentRevision }
      break
    }
    const decision = shouldHandOver({
      score,
      artisticPassed: artistic.status === 'pass',
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
    artistic = assessArtisticReview(vision.artistic, currentReview, minConfidence)
    seedFingerprintCounters(fingerprints, reviewIssues(currentReview, artistic))

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
      artisticBefore: artistic,
      reviewer: vision.detail ?? null,
      ...(subjectFixed ? { fixedSubjectId } : {}),
    }

    if (score >= VISUAL_PASS_SCORE && artistic.status === 'pass') {
      round.reason = 'PASSING_REVIEW'
      rounds.push(round)
      handedOver = { reason: 'PASSING_REVIEW', iteration, score, revision: currentRevision }
      break
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

    const subjectOperation = operations.find(operation => operation.op === 'project.reviewSubject.set' ||
      (subjectFixed && fixedSubjectId !== null && operation.entityId === fixedSubjectId &&
        (operation.op === 'entity.remove' || (operation.op === 'entity.visibility.set' && operation.visible === false))))
    if (subjectOperation) {
      round.outcome = 'rejected'
      round.reason = `REVIEW_SUBJECT_OPERATION_REFUSED: ${subjectOperation.op}`
      rounds.push(round)
      handedOver = { reason: 'REVIEW_SUBJECT_OPERATION_REFUSED', iteration, score, revision: currentRevision }
      break
    }

    // The model may improve the result, but cannot lower the authored target or
    // replace the reference it is being judged against. Refuse the entire proposal.
    const referenceAssets = new Set([
      ...(currentReview.sceneContext?.project?.referenceImages ?? []),
      ...(currentReview.referenceImages ?? []),
    ].map(reference => reference.assetId))
    const forbidden = operations.find(operation => operation.op === 'project.brief.set' ||
      (operation.op === 'asset.remove' && referenceAssets.has(operation.assetId)) ||
      (operation.op === 'asset.add' && referenceAssets.has(operation.asset?.id)))
    if (forbidden) {
      round.outcome = 'rejected'
      round.reason = `REVIEW_INPUT_OPERATION_REFUSED: ${forbidden.op}`
      rounds.push(round)
      handedOver = { reason: 'REVIEW_INPUT_OPERATION_REFUSED', iteration, score, revision: currentRevision }
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
      updateFingerprintCounters(fingerprints, reviewIssues(currentReview, artistic))
      continue
    }

    round.appliedPatch = { operations, note: vision.note ?? null }
    round.newRevision = summary.revision

    let after, afterVision, afterArtistic
    try {
      after = await input.review({
        projectId: input.projectId, revision: summary.revision, iteration, signal: input.signal,
        ...(subjectFixed ? { subjectId: fixedSubjectId } : {}),
      })
      if (checkedReviewInputsDigest(after) !== authoredInputsDigest) {
        throw reviewInputsChanged('The candidate changed the authored goal or visual reference inputs.')
      }
      if (subjectFixed) {
        const issue = reviewedSubjectIssue(after, fixedSubjectId, subjectEvidence)
        if (issue) throw issue
      }
      if (after.score >= score) {
        afterVision = await input.reviewer({
          review: after, baselineReview: currentReview, round: iteration,
          previousRounds: rounds.filter(entry => entry.outcome === 'applied' || entry.outcome === 'rejected'),
          signal: input.signal,
        })
        afterArtistic = assessArtisticReview(afterVision.artistic, after, minConfidence)
      }
    } catch (cause) {
      await input.restore({ projectId: input.projectId, revision: currentRevision,
        expectedCurrentRevision: summary.revision,
        reason: 'candidate review failed; keep the previously reviewed revision' })
      round.outcome = 'rejected'
      const reason = cause?.reviewSubjectReason ?? (cause?.reviewInputsChanged ? 'REVIEW_INPUTS_CHANGED' : 'REVIEW_FAILED')
      round.reason = `${reason}: ${cause instanceof Error ? cause.message : String(cause)}`
      round.rolledBackTo = currentRevision
      rounds.push(round)
      handedOver = { reason, iteration, score, revision: currentRevision }
      break
    }
    round.artisticAfter = afterArtistic ?? null
    round.comparisonReviewer = afterVision?.detail ?? null
    // Aggregate gains cannot hide a newly introduced major/critical defect.
    const severity = { minor: 1, major: 2, critical: 3 }
    const priorSeverity = new Map(currentReview.issues.map(issue =>
      [`${issue.viewId}|${issue.objectId ?? ''}|${issue.code}`, severity[issue.severity] ?? 0]))
    const worsenedIssue = after.issues.some(issue => (severity[issue.severity] ?? 0) >= 2 &&
      (severity[issue.severity] ?? 0) > (priorSeverity.get(`${issue.viewId}|${issue.objectId ?? ''}|${issue.code}`) ?? 0))
    const artRegression = afterArtistic && artisticRegressed(artistic, afterArtistic)
    const artImproved = afterArtistic?.comparison.verdict === 'improved'
    const comparisonSupported = ['improved', 'equivalent'].includes(afterArtistic?.comparison.verdict)

    if (after.score >= score && !worsenedIssue && !artRegression && comparisonSupported && (after.score > score || artImproved)) {
      const previousScore = score
      score = after.score
      currentRevision = summary.revision
      currentReview = after
      artistic = afterArtistic
      round.outcome = 'applied'
      round.reason = previousScore === score ? `artistic improvement; technical score unchanged (${score})` : `score ${previousScore} -> ${score}`
      rounds.push(round)
      updateFingerprintCounters(fingerprints, reviewIssues(after, artistic))
      if (artImproved) for (const key of fingerprints.keys()) {
        if (key.startsWith('artistic|')) fingerprints.set(key, 0)
      }
      log(`round ${iteration}: applied ${operations.length} operation(s), score ${previousScore} -> ${score} on ${currentRevision}`)
      continue
    }

    // Not an improvement. Keep the history, decline the pointer.
    await input.restore({
      projectId: input.projectId,
      revision: round.revision,
      expectedCurrentRevision: summary.revision,
      reason: `visual round ${iteration} declined: technical ${score} -> ${after.score}, artistic ${afterArtistic?.comparison.verdict ?? 'unassessable'}`,
    })
    round.outcome = 'rejected'
    round.reason = artRegression ? 'ARTISTIC_REGRESSION' : worsenedIssue ? 'TECHNICAL_ISSUE_REGRESSION'
      : after.score > score && !comparisonSupported ? 'ARTISTIC_COMPARISON_UNASSESSABLE' : `score did not improve (${score} -> ${after.score})`
    round.rolledBackTo = round.revision
    rounds.push(round)
    // The measured state is unchanged (the pointer went back), so the same
    // fingerprints are present again — which is exactly what makes a fix that
    // cannot work stop the loop instead of repeating until the cap.
    updateFingerprintCounters(fingerprints, reviewIssues(currentReview, artistic))
    log(`round ${iteration}: rejected — ${round.reason}; pointer restored to ${currentRevision}`)
  }

  // A handover is something a human has to pick up, so a run that PASSED has none.
  // Reporting one would tell a reader to take over work that is finished.
  const handover = handedOver === null || handedOver.reason === 'PASSING_REVIEW'
    ? null
    : { ...buildHandover({ handedOver, openIssues: currentReview.issues, rounds, review: currentReview }), artistic }

  return {
    projectId: input.projectId,
    startRevision: input.revision,
    finalRevision: currentRevision,
    subjectFixed,
    fixedSubjectId: subjectFixed ? fixedSubjectId : null,
    startScore: rounds[0].score,
    finalScore: score,
    technicalPassed: !baselineSubjectError && score >= VISUAL_PASS_SCORE,
    artistic,
    passed: !baselineSubjectError && score >= VISUAL_PASS_SCORE && artistic.status === 'pass',
    iterations: iteration,
    maxIterations,
    stopReason: handedOver?.reason ?? 'PASSING_REVIEW',
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
  for (const entity of review.sceneContext?.entities ?? []) ids.add(entity.id)
  for (const view of review.views ?? []) for (const object of view.objects ?? []) ids.add(object.id)
  for (const issue of review.issues ?? []) {
    if (issue.objectId) ids.add(issue.objectId)
  }
  return [...ids]
}

/** Repeated unresolved art dimensions count separately from measured issues. */
function reviewIssues(review, artistic) {
  return [...review.issues, ...Object.entries(artistic.dimensions)
    .filter(([, entry]) => entry.status === 'needs_work')
    .map(([dimension]) => ({ fingerprint: `artistic|${dimension}` }))]
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
      `The automated rounds tried ${attempted.length} change(s); ` +
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

function reviewInputsChanged(message) {
  return Object.assign(new Error(message), { reviewInputsChanged: true })
}

function hasSubjectEvidence(review) {
  return Object.hasOwn(review, 'subjectId') || review.subject !== undefined || review.sceneContext != null
}

function reviewedSubjectIssue(review, expectedId, required = {}) {
  const issue = (reason, message) => Object.assign(new Error(message), { reviewSubjectReason: reason })
  if ((required.sceneContext && review.sceneContext == null) || (required.subject && review.subject == null) ||
    !Object.hasOwn(review, 'subjectId') ||
    (review.subjectId !== null && (typeof review.subjectId !== 'string' || review.subjectId.length === 0)) ||
    review.subjectId !== expectedId ||
    (review.subject && (review.subject.id !== expectedId || typeof review.subject.available !== 'boolean'))) {
    return issue('REVIEW_SUBJECT_CHANGED', 'The review did not report the fixed subject identity.')
  }
  if (expectedId === null || review.subject?.available === false) {
    return issue('REVIEW_SUBJECT_UNAVAILABLE', review.subject?.reason ?? 'The fixed review subject is unavailable.')
  }
  if (review.sceneContext) {
    const entity = (review.sceneContext.entities ?? []).find(entry => entry.id === expectedId)
    if (!entity || entity.visible === false || entity.type === 'empty') {
      return issue('REVIEW_SUBJECT_UNAVAILABLE', `The fixed review subject "${expectedId}" is missing, hidden or empty in this revision.`)
    }
    const authored = review.sceneContext.project?.reviewSubjectId
    if (authored !== undefined && authored !== expectedId) {
      return issue('REVIEW_SUBJECT_CHANGED', 'The review subject disagrees with the explicitly saved subject.')
    }
  }
  return null
}

/** Old measurement-only ports have neither field; retain their null identity. */
function checkedReviewInputsDigest(review) {
  const computed = review.sceneContext ? reviewInputsDigest(review.sceneContext) : null
  const declared = review.reviewInputsDigest ?? null
  if (declared !== null && (!/^[a-f0-9]{64}$/.test(declared) || (computed !== null && declared !== computed))) {
    throw reviewInputsChanged('The review input digest does not match its authored scene context.')
  }
  if (computed === null && declared === null && (review.referenceImages ?? []).length > 0) {
    throw reviewInputsChanged('A visual review with references must record its review input digest.')
  }
  return computed ?? declared
}

function assessArtisticReview(raw, review, minConfidence) {
  const referenceImages = review.referenceImages ?? []
  const authored = review.sceneContext?.project?.referenceImages ?? []
  const supplied = new Map(referenceImages.map(reference => [reference.id, reference]))
  const missing = authored.some(reference => {
    const actual = supplied.get(reference.id)
    return !actual || actual.assetId !== reference.assetId || actual.sha256 !== reference.sha256 ||
      JSON.stringify([...(actual.purposes ?? [])].sort()) !== JSON.stringify([...reference.purposes].sort())
  }) || (review.sceneContext && referenceImages.length !== authored.length)
  const assessment = validateArtisticReview(missing ? null : raw,
    new Set(review.perView.map(entry => entry.viewId)), minConfidence, { referenceImages, subject: review.subject })
  if (missing) assessment.problems.push('The actual reference image inventory does not match the authored references.')
  return assessment
}

/** A positive integer option, with a default. */
function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/** A number in [0, 1], with a default. */
function numberInRange(value, fallback) {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback
}
