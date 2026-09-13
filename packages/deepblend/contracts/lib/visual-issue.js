/**
 * VisualIssue: the shared vocabulary for "what is wrong with this render", and the
 * deterministic scorer that turns measurements into a number (SPEC §12.3).
 *
 * THE SPLIT THIS FILE EXISTS TO ENFORCE (decision D30)
 * ----------------------------------------------------
 * There are two different claims in a visual review and they must not be confused:
 *
 *   the model JUDGES   "the subject is off-centre and the label is in shadow"
 *   the machine MEASURES  coverage 0.061, centroid (0.79, 0.42), p95 0.06
 *
 * Only the second is reproducible, and SPEC §12.3 requires "修改前后都保存评分和证据"
 * — so the SCORE comes from measurements and the model's job is to name what it
 * sees. A score the model reported about itself would make "自动修复后评分提高"
 * unfalsifiable, which is the same as not testing it.
 *
 * The consequence, stated plainly because it is a real limitation: a model can see
 * a genuine problem this scorer does not deduct for, and the loop will then be
 * unable to "improve" it. That is the correct failure direction — a wrong score
 * silently accepted is worse than a missed deduction reported as a lower score.
 *
 * Every finding carries its evidence inline. A deduction without the number that
 * caused it is an opinion with a number bolted on.
 *
 * THRESHOLDS ARE BEHAVIORAL (the D1/D9/D25 rule)
 * ----------------------------------------------
 * The constants below are not from documentation and were not guessed: each is set
 * from renders of the real fixtures, produced by `deepblend/tests/fixtures/*` and
 * recorded in `deepblend/docs/milestone-status.md`. When a threshold moves, the
 * fixture renders that justified it move with it.
 *
 * Owner: DeepBlend Studio — M2
 */

/** VisualIssue schema version. */
export const VISUAL_ISSUE_VERSION = 'deepblend.visual-issue/v1'

/** Visual review document version. */
export const VISUAL_REVIEW_VERSION = 'deepblend.visual-review/v1'

/** Issue categories. A closed set: an unknown category cannot be scored. */
export const VISUAL_ISSUE_CATEGORIES = Object.freeze([
  'composition',
  'exposure',
  'occlusion',
])

/**
 * The tag that says "this entity is part of the subject's own body".
 *
 * WHY THIS TAG HAS TO EXIST
 * -------------------------
 * A real watch exposed the limit of measuring occlusion without it. The dial stands
 * proud of the case, so the dial covers 56% of the case's silhouette — and every view
 * reported the case as occluded by its own face, scoring a CORRECT watch 10 points
 * below a watch whose dial was buried invisibly inside the case. Both readings were
 * arithmetically right and the ranking between them was backwards.
 *
 * The measurement cannot tell a product's own face from a wall: the two are the same
 * geometry. So the scene has to say it, exactly as `environment` says "this is
 * backdrop, not a participant". With this tag:
 *
 *   - a part in front of the subject is not an obstruction (it IS the subject);
 *   - a part that is itself invisible IS a defect, because a required component
 *     that cannot be seen is missing from the shot.
 *
 * `environment` and `subject-part` are the two ends of one axis — backdrop, body,
 * and (untagged) everything that can genuinely stand in the way.
 */
export const SUBJECT_PART_TAG = 'subject-part'

/**
 * Whether a measurement entry belongs to the subject's own body.
 *
 * Read from the measurement, not from the spec: the renderer knows which entities the
 * scene tagged and stamps each one, so the scorer never re-derives scene semantics
 * from a document it was not given.
 *
 * @param {object} object - one object entry from a view's measurements.
 * @returns {boolean}
 */
export function isSubjectPart(object) {
  return object?.part === true
}

/** Severity vocabulary, ordered by how much a finding is allowed to deduct. */
export const VISUAL_SEVERITIES = Object.freeze(['minor', 'major', 'critical'])

/** Deduction per severity, before per-rule weighting. */
const SEVERITY_POINTS = Object.freeze({ minor: 4, major: 10, critical: 18 })

/**
 * A perfect score. Below this the automated loop has something to fix; at or above
 * it the loop hands over instead of pretending there is work (see `shouldHandOver`).
 */
export const VISUAL_PASS_SCORE = 90

/** Coverage band a subject should occupy to read as the subject of a shot. */
const COVERAGE_MIN = 0.04
const COVERAGE_MAX = 0.60
/** Distance from the frame centre, in normalized units, below which a subject is centred. */
const CENTERED_TOLERANCE = 0.10
/** How far off-centre is worth the worst composition deduction. */
const CENTERED_MAX = 0.40
/** Below this visible fraction of its own silhouette, a subject is materially hidden. */
const OCCLUSION_MIN_VISIBLE = 0.75
/**
 * The same floor for an entity the scene declared part of the subject's own body.
 *
 * Lower on purpose. A product's parts are EXPECTED to overlap each other and the body
 * they sit on — a bezel around a dial, a crown against a case — so 0.75 would fire on
 * every correctly assembled object. What is not expected is a declared component that
 * is substantially or entirely absent, which is the defect this catches.
 */
const PART_VISIBLE_FLOOR = 0.5
/** Below this, a declared component is effectively not in the shot at all. */
const PART_VISIBLE_ABSENT = 0.15
/** Below this, it is effectively not in the shot. */
const OCCLUSION_CRITICAL_VISIBLE = 0.35
/** A declared part smaller than this on screen cannot be judged present or absent. */
const PART_SILHOUETTE_MIN_PIXELS = 200
/** Mean display luminance band. Below the floor, the frame reads dark; above the
 *  ceiling, it reads washed out. Both are measured luminance, not exposure stops. */
const LUMINANCE_MIN = 0.18
const LUMINANCE_MAX = 0.82
/** Fraction of pixels at the bottom of the range that makes a frame "clipped dark". */
const CLIPPED_DARK_MAX = 0.25
/** Fraction at the top that makes it "clipped bright". */
const CLIPPED_BRIGHT_MAX = 0.15

/**
 * @typedef {object} VisualIssue
 * @property {string} id - stable within one review.
 * @property {'composition'|'exposure'|'occlusion'} category
 * @property {'minor'|'major'|'critical'} severity
 * @property {string} code - the specific finding, e.g. `SUBJECT_OFF_CENTER`.
 * @property {string} viewId
 * @property {string|null} objectId
 * @property {string} evidence - prose a human can check against the sheet.
 * @property {Record<string, number|string>} measurements - the numbers behind it.
 * @property {number} confidence - 0..1.
 * @property {object[]} suggestedOperations - ScenePatch operations (may be empty).
 * @property {string} fingerprint - the repetition key (decision D31).
 */

/**
 * Quantise a measurement into a coarse bucket.
 *
 * This is what makes an issue fingerprint survive a partial fix: "luminance 0.31"
 * and "luminance 0.34" are the same problem and must collide, while "0.31" and
 * "0.72" must not. Precise values would let round 3 and round 4 describe one
 * problem as two, and the loop would then run to its iteration cap without ever
 * counting a repeat (decision D31).
 *
 * @param {number|null} value
 * @param {number[]} edges - ascending bucket boundaries.
 * @param {string[]} names - one name per bucket, length = edges.length + 1.
 * @returns {string}
 */
export function quantise(value, edges, names) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return names[names.length - 1]
  for (let index = 0; index < edges.length; index += 1) {
    if (value < edges[index]) return names[index]
  }
  return names[names.length - 1]
}

/** Bucket names for luminance, from dark to bright. */
export const LUMINANCE_BUCKETS = Object.freeze(['veryDark', 'dark', 'mid', 'bright', 'veryBright'])
const LUMINANCE_EDGES = Object.freeze([0.10, 0.25, 0.55, 0.85])

/** Bucket names for frame coverage, from tiny to filling. */
export const COVERAGE_BUCKETS = Object.freeze(['tiny', 'small', 'medium', 'large', 'huge'])
const COVERAGE_EDGES = Object.freeze([0.02, 0.06, 0.20, 0.55])

/** Bucket names for how far a subject sits from the frame centre. */
export const CENTERING_BUCKETS = Object.freeze(['centered', 'slightlyOff', 'off', 'farOff'])
const CENTERING_EDGES = Object.freeze([0.06, 0.15, 0.30])

/**
 * The repetition key for one finding.
 *
 * @param {{ category: string, code: string, objectId?: string|null, buckets: string[] }} finding
 * @returns {string}
 */
export function issueFingerprint(finding) {
  return [finding.category, finding.code, finding.objectId ?? 'scene', ...finding.buckets].join('|')
}

/**
 * Score one view's measurements and report what is wrong with it.
 *
 * @param {object} view - one view entry from a render plan (`{ viewId, role, metrics }`).
 * @param {object} [options]
 * @param {string|null} [options.subjectId] - the object the shot is about; when
 *   omitted, every tracked object is scored.
 * @returns {{ score: number, issues: VisualIssue[] }}
 */
export function scoreView(view, options = {}) {
  const metrics = view?.metrics
  if (metrics === undefined || metrics === null) {
    return { score: 100, issues: [] }
  }
  const viewId = typeof view.viewId === 'string' ? view.viewId : 'view'

  const issues = []
  let score = 100
  const add = issue => {
    issues.push(issue)
    score -= SEVERITY_POINTS[issue.severity]
  }

  const exposure = assessExposure(metrics, viewId)
  if (exposure !== null) add(exposure)

  const objects = Array.isArray(metrics.objects) ? metrics.objects : []
  const subjects = options.subjectId === undefined || options.subjectId === null
    ? objects
    : objects.filter(entry => entry.id === options.subjectId)

  for (const object of subjects) {
    const composition = assessComposition(object)
    if (composition !== null) add(composition)
    const occlusion = assessOcclusion(object)
    if (occlusion !== null) add(occlusion)
  }

  // Declared components are NOT judged per view. A watch dial faces the viewer in three
  // of four standard views and is legitimately invisible in the top-down one, so a
  // per-view rule reports geometry as a defect. `scoreReview` judges them across the
  // whole review instead, where "invisible" can mean "invisible everywhere".

  // One bad view should not be hidden by averaging it against good ones: the sheet
  // is reviewed as a set, and the set is as good as its worst framing.
  return { score: Math.max(0, Math.min(100, score)), issues }
}

/**
 * Score a whole review from its per-view measurements.
 *
 * The reported score is the WORST view's score, not the mean. A mean would let one
 * unusable angle hide behind three fine ones, and the automated loop optimises the
 * number it is given — so the number has to be the one that represents whether the
 * animation is deliverable.
 *
 * @param {object[]} views
 * @param {object} [options]
 * @returns {{ score: number, issues: VisualIssue[], perView: { viewId: string, score: number }[] }}
 */
export function scoreReview(views, options = {}) {
  const perView = []
  const issues = []
  let worst = 100
  for (const view of views) {
    const scored = scoreView(view, options)
    perView.push({ viewId: view.viewId, score: scored.score })
    issues.push(...scored.issues)
    if (scored.score < worst) worst = scored.score
  }

  // ---- declared components, judged across the whole review ------------------
  //
  // THE GAP THIS CLOSES, in the words of the session that found it: a review "scored
  // 100/100 while the render shows no face at all, because the scorer has no metric for
  // a required component being completely hidden". The 36 mm dial sat entirely INSIDE
  // the case, measured 0.0 visible pixels in every view, and nothing looked at it —
  // because only the subject was judged, and the subject (the case) was framed fine.
  //
  // The bar is deliberately the weakest defensible one: a component has to be visible
  // in AT LEAST ONE view. Anything stronger reports a part that merely faces away from
  // one camera, and over-reporting is how a scorer stops being believed.
  const best = new Map()
  for (const view of views) {
    for (const object of view.metrics?.objects ?? []) {
      if (!isSubjectPart(object)) continue
      if (object.id === options.subjectId) continue
      const current = best.get(object.id)
      if (current === undefined || numberOr(object.visibleFraction, 1) > current.visibleFraction) {
        best.set(object.id, { object, visibleFraction: numberOr(object.visibleFraction, 1), viewId: view.viewId })
      }
    }
  }

  let reviewDeduction = 0
  for (const [objectId, entry] of best) {
    if (numberOr(entry.object.silhouettePixels, 0) < PART_SILHOUETTE_MIN_PIXELS) continue
    if (entry.visibleFraction >= PART_VISIBLE_ABSENT) continue
    const behind = Array.isArray(entry.object.occludedBy) ? entry.object.occludedBy : []
    const culprit = behind.length > 0 ? `, behind "${behind[0].entityId}"` : ''
    const issue = buildIssue({
      category: 'occlusion',
      code: 'SUBJECT_PART_HIDDEN',
      severity: 'critical',
      viewId: entry.viewId,
      objectId,
      evidence:
        `"${objectId}" is declared part of the subject, and the most visible it gets in any of the ` +
        `${views.length} views is ${format(entry.visibleFraction)}${culprit} — a required component of the ` +
        'product is not in the shot',
      measurements: {
        bestVisibleFraction: round(entry.visibleFraction),
        viewsChecked: views.length,
        silhouettePixels: numberOr(entry.object.silhouettePixels, 0),
        ...behind.length > 0 ? { occludedBy: behind[0].entityId } : {},
      },
      buckets: [quantise(entry.visibleFraction, [PART_VISIBLE_ABSENT], ['absent', 'present'])],
    })
    issues.push(issue)
    reviewDeduction += SEVERITY_POINTS[issue.severity]
  }

  return {
    score: Math.max(0, Math.min(100, worst - reviewDeduction)),
    issues,
    perView,
  }
}

/**
 * Frame-wide exposure findings.
 *
 * @param {object} metrics
 * @param {string} viewId
 * @returns {VisualIssue|null}
 */
function assessExposure(metrics, viewId) {
  const luminance = metrics.luminance
  if (luminance === undefined || typeof luminance.mean !== 'number') return null

  const bucket = quantise(luminance.mean, LUMINANCE_EDGES, LUMINANCE_BUCKETS)
  const clippedDark = numberOr(luminance.clippedDarkFraction, 0)
  const clippedBright = numberOr(luminance.clippedBrightFraction, 0)

  if (luminance.mean < LUMINANCE_MIN || clippedDark > CLIPPED_DARK_MAX) {
    const severity = luminance.mean < LUMINANCE_MIN / 2 || clippedDark > CLIPPED_DARK_MAX * 2
      ? 'critical'
      : 'major'
    return buildIssue({
      category: 'exposure',
      code: 'FRAME_UNDEREXPOSED',
      severity,
      viewId,
      objectId: null,
      evidence:
        `the frame is dark: mean display luminance ${format(luminance.mean)} is below the ` +
        `${LUMINANCE_MIN} floor for a lit scene, and ${format(clippedDark)} of pixels sit at the ` +
        `bottom of the range`,
      measurements: {
        meanLuminance: round(luminance.mean),
        clippedDarkFraction: round(clippedDark),
        p05: round(numberOr(luminance.p05, 0)),
        p95: round(numberOr(luminance.p95, 0)),
      },
      buckets: [bucket],
    })
  }

  if (luminance.mean > LUMINANCE_MAX || clippedBright > CLIPPED_BRIGHT_MAX) {
    const severity = luminance.mean > (LUMINANCE_MAX + 1) / 2 || clippedBright > CLIPPED_BRIGHT_MAX * 2
      ? 'critical'
      : 'major'
    return buildIssue({
      category: 'exposure',
      code: 'FRAME_OVEREXPOSED',
      severity,
      viewId,
      objectId: null,
      evidence:
        `the frame is blown out: mean display luminance ${format(luminance.mean)} exceeds the ` +
        `${LUMINANCE_MAX} ceiling, and ${format(clippedBright)} of pixels are clipped at the top of ` +
        `the range`,
      measurements: {
        meanLuminance: round(luminance.mean),
        clippedBrightFraction: round(clippedBright),
        p05: round(numberOr(luminance.p05, 0)),
        p95: round(numberOr(luminance.p95, 0)),
      },
      buckets: [bucket],
    })
  }

  return null
}

/**
 * Where the subject sits in the frame, and how big it is.
 *
 * @param {object} object - one object entry from the view's measurements.
 * @returns {VisualIssue|null}
 */
function assessComposition(object) {
  if (object.visiblePixels === 0) return null // fully hidden is an occlusion finding
  const centroid = object.centroid
  if (!Array.isArray(centroid) || centroid.length !== 2) return null

  const offsetX = centroid[0] - 0.5
  const offsetY = centroid[1] - 0.5
  const offset = Math.sqrt(offsetX * offsetX + offsetY * offsetY)
  const centering = quantise(offset, CENTERING_EDGES, CENTERING_BUCKETS)

  if (offset > CENTERED_TOLERANCE) {
    const severity = offset > CENTERED_MAX ? 'critical' : offset > (CENTERED_TOLERANCE + CENTERED_MAX) / 2 ? 'major' : 'minor'
    return buildIssue({
      category: 'composition',
      code: 'SUBJECT_OFF_CENTER',
      severity,
      viewId: object.viewId,
      objectId: object.id,
      evidence:
        `"${object.id}" sits at (${format(centroid[0])}, ${format(centroid[1])}) of the frame, ` +
        `${format(offset)} from the centre — outside the ${CENTERED_TOLERANCE} tolerance`,
      measurements: {
        centroidX: round(centroid[0]),
        centroidY: round(centroid[1]),
        centerOffset: round(offset),
        frameCoverage: round(numberOr(object.frameCoverage, 0)),
      },
      buckets: [centering],
    })
  }

  // COMPOSITION uses the SILHOUETTE coverage, not the visible coverage, and the
  // distinction matters: an occluder that hides half the subject also halves the
  // subject's visible share of the frame. Measured against visible pixels, a blocked
  // subject would additionally be reported as "too small to read as the subject" —
  // two findings for one cause, and the second one sends the reviewer to change the
  // lens on a shot whose problem is a wall.
  const coverage = numberOr(object.silhouetteCoverage, numberOr(object.frameCoverage, 0))
  const coverageBucket = quantise(coverage, COVERAGE_EDGES, COVERAGE_BUCKETS)
  if (coverage > 0 && coverage < COVERAGE_MIN) {
    return buildIssue({
      category: 'composition',
      code: 'SUBJECT_TOO_SMALL',
      severity: 'major',
      viewId: object.viewId,
      objectId: object.id,
      evidence:
        `"${object.id}" fills only ${format(coverage)} of the frame, below the ${COVERAGE_MIN} floor, ` +
        `so it does not read as the subject of the shot`,
      measurements: {
        frameCoverage: round(coverage),
        centroidX: round(centroid[0]),
        centroidY: round(centroid[1]),
        visiblePixels: object.visiblePixels,
      },
      buckets: [coverageBucket],
    })
  }

  if (coverage > COVERAGE_MAX) {
    return buildIssue({
      category: 'composition',
      code: 'SUBJECT_FILLS_FRAME',
      severity: 'major',
      viewId: object.viewId,
      objectId: object.id,
      evidence:
        `"${object.id}" fills ${format(coverage)} of the frame, above the ${COVERAGE_MAX} ceiling, ` +
        `so it is cropped rather than framed`,
      measurements: { frameCoverage: round(coverage), visiblePixels: object.visiblePixels },
      buckets: [coverageBucket],
    })
  }

  return null
}

/**
 * Whether another object is sitting in front of the subject.
 *
 * The measurement is the ratio of the subject's silhouette that survives to its
 * silhouette with nothing in the way — see `deepblend_views.py`. It is the one
 * occlusion reading in this system that is definitional rather than a brightness
 * heuristic.
 *
 * @param {object} object
 * @returns {VisualIssue|null}
 */
function assessOcclusion(object) {
  const visible = numberOr(object.visibleFraction, 1)
  if (visible >= OCCLUSION_MIN_VISIBLE) return null
  const silhouette = numberOr(object.silhouettePixels, 0)
  // A handful of surviving pixels out of a handful is not occlusion, it is an
  // object that is essentially absent from the shot — which the composition rules
  // already report, and reporting both would double-charge one cause.
  if (silhouette < 200) return null

  const severity = visible < OCCLUSION_CRITICAL_VISIBLE ? 'critical' : 'major'
  const covered = 1 - visible
  const behind = Array.isArray(object.occludedBy) ? object.occludedBy : []
  const culprit = behind.length > 0 ? `, mostly behind "${behind[0].entityId}"` : ''
  // The remedy is stated when it is knowable, because the alternative is a reader
  // concluding the score is wrong — which is exactly what happened on a real watch
  // whose own face covers its case.
  const hint = behind.length > 0
    ? ` If "${behind[0].entityId}" is part of the same object rather than something standing in the way, ` +
      `tag it "${SUBJECT_PART_TAG}" and it stops counting as an obstruction.`
    : ''
  return buildIssue({
    category: 'occlusion',
    code: 'SUBJECT_OCCLUDED',
    severity,
    viewId: object.viewId,
    objectId: object.id,
    evidence:
      `only ${format(visible)} of "${object.id}"'s own silhouette survives in this view ` +
      `(${format(covered)} is hidden)${culprit}, against a ${OCCLUSION_MIN_VISIBLE} visibility floor.${hint}`,
    measurements: {
      visibleFraction: round(visible),
      occludedFraction: round(covered),
      silhouettePixels: silhouette,
      visiblePixels: numberOr(object.visiblePixels, 0),
      ...behind.length > 0 ? { occludedBy: behind[0].entityId, occludedByFraction: behind[0].fraction } : {},
    },
    buckets: [
      quantise(visible, [OCCLUSION_CRITICAL_VISIBLE, OCCLUSION_MIN_VISIBLE], ['hidden', 'partlyHidden', 'visible']),
    ],
  })
}

/**
 * Assemble one issue with a stable id and fingerprint.
 * @param {object} input
 * @returns {VisualIssue}
 */
function buildIssue(input) {
  const measurements = {}
  for (const [key, value] of Object.entries(input.measurements ?? {})) {
    if (value !== undefined && value !== null) measurements[key] = value
  }
  const issue = {
    category: input.category,
    code: input.code,
    severity: input.severity,
    viewId: input.viewId ?? null,
    objectId: input.objectId ?? null,
    evidence: input.evidence,
    measurements,
    confidence: 1,
    suggestedOperations: [],
  }
  issue.fingerprint = issueFingerprint({
    category: issue.category,
    code: issue.code,
    objectId: issue.objectId,
    buckets: input.buckets ?? [],
  })
  issue.id = `measured-${issue.fingerprint.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  return issue
}

/** Coerce a possibly-absent measurement into a number. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Six decimals: comparable across rounds, short enough to read. */
function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null
}

/** Fixed three-decimal formatting, so evidence text is stable across rounds. */
function format(value) {
  const number = numberOr(value, 0)
  return number.toFixed(3)
}

/**
 * Record the findings of a state the loop has observed but not yet acted on.
 *
 * Identical bookkeeping to {@link updateFingerprintCounters} except that it seeds each
 * counter at its CURRENT value instead of incrementing. The two are separate
 * functions rather than one with a flag, because "this problem is present" and "a fix
 * for this problem failed" are different facts and the whole point of the repeat rule
 * is that only the second one means the loop is not working.
 *
 * @param {Map<string, number>} counters - mutated in place.
 * @param {VisualIssue[]} issues
 */
export function seedFingerprintCounters(counters, issues) {
  const seen = new Set()
  for (const issue of issues) {
    if (typeof issue.fingerprint !== 'string') continue
    seen.add(issue.fingerprint)
    if (!counters.has(issue.fingerprint)) counters.set(issue.fingerprint, 0)
  }
  for (const fingerprint of [...counters.keys()]) {
    if (!seen.has(fingerprint)) counters.delete(fingerprint)
  }
}

/**
 * Validate a model-authored finding against the measurements it claims to describe.
 *
 * A vision model is asked what it sees; it answers in this shape. Everything it
 * asserts is checked here, because the alternative is trusting prose from a system
 * that cannot be asked to reproduce itself. A finding survives only when the view it
 * names exists and its category is one of the closed set.
 *
 * @param {unknown} raw
 * @param {{ viewIds: Set<string>, objectIds: Set<string> }} context
 * @returns {{ accepted: object[], rejected: { finding: unknown, reason: string }[] }}
 */
export function validateFindings(raw, context) {
  const accepted = []
  const rejected = []
  const list = Array.isArray(raw) ? raw : []
  if (!Array.isArray(raw)) {
    rejected.push({ finding: raw, reason: 'findings must be an array' })
    return { accepted, rejected }
  }

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      rejected.push({ finding: entry, reason: 'a finding must be an object' })
      continue
    }
    const category = entry.category
    if (!VISUAL_ISSUE_CATEGORIES.includes(category)) {
      rejected.push({ finding: entry, reason: `unknown category "${String(category)}"` })
      continue
    }
    const viewId = entry.viewId
    if (typeof viewId !== 'string' || !context.viewIds.has(viewId)) {
      rejected.push({ finding: entry, reason: `unknown viewId "${String(viewId)}"` })
      continue
    }
    const objectId = entry.objectId === undefined || entry.objectId === null ? null : String(entry.objectId)
    if (objectId !== null && context.objectIds.size > 0 && !context.objectIds.has(objectId)) {
      rejected.push({ finding: entry, reason: `unknown objectId "${objectId}"` })
      continue
    }
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : ''
    if (evidence.length < 8) {
      // Evidence is the whole reason a model finding is worth keeping: without it
      // the review is an assertion, and an assertion cannot be audited later.
      rejected.push({ finding: entry, reason: 'evidence is missing or too short to check' })
      continue
    }
    const confidence = typeof entry.confidence === 'number' && entry.confidence >= 0 && entry.confidence <= 1
      ? entry.confidence
      : 0.5
    accepted.push({
      category,
      code: typeof entry.code === 'string' && entry.code.length > 0 ? entry.code : `${String(category).toUpperCase()}_REPORTED`,
      severity: VISUAL_SEVERITIES.includes(entry.severity) ? entry.severity : 'major',
      viewId,
      objectId,
      evidence,
      measurements: {},
      confidence,
      suggestedOperations: Array.isArray(entry.suggestedOperations) ? entry.suggestedOperations : [],
    })
  }
  return { accepted, rejected }
}

/**
 * Decide whether the automated loop may keep trying.
 *
 * Three ways to stop, and each one exists because the alternative is a loop that
 * spends money to make things worse:
 *
 *  - the score is already passing — there is no measured problem to improve;
 *  - the iteration cap is reached (SPEC §12.3 "达到最大迭代数后进入人工审查");
 *  - the same fingerprint has repeated `stopOnRepeatedIssueCount` times, which is
 *    the structural form of "同一问题两轮未改善则停止自动迭代".
 *
 * @param {object} input
 * @param {number} input.score
 * @param {number} input.iteration
 * @param {number} input.maxIterations
 * @param {Map<string, number>} input.fingerprints - fingerprint -> consecutive count
 * @param {number} input.stopOnRepeatedIssueCount
 * @returns {{ stop: boolean, reason: string|null }}
 */
export function shouldHandOver(input) {
  if (input.score >= VISUAL_PASS_SCORE) {
    return { stop: true, reason: 'PASSING_SCORE' }
  }
  if (input.iteration >= input.maxIterations) {
    return { stop: true, reason: 'MAX_ITERATIONS' }
  }
  for (const [fingerprint, count] of input.fingerprints) {
    if (count >= input.stopOnRepeatedIssueCount) {
      return { stop: true, reason: 'REPEATED_ISSUE', fingerprint }
    }
  }
  return { stop: false, reason: null }
}

/**
 * Update the consecutive-repeat counters for one round's findings.
 *
 * "Consecutive" is the load-bearing word: a finding that vanishes and comes back is
 * a different situation from one that never went away, and only the second means
 * the fix is not working.
 *
 * @param {Map<string, number>} counters - mutated in place.
 * @param {VisualIssue[]} issues - this round's findings.
 */
export function updateFingerprintCounters(counters, issues) {
  const seen = new Set()
  for (const issue of issues) {
    if (typeof issue.fingerprint !== 'string') continue
    seen.add(issue.fingerprint)
    counters.set(issue.fingerprint, (counters.get(issue.fingerprint) ?? 0) + 1)
  }
  for (const fingerprint of [...counters.keys()]) {
    if (!seen.has(fingerprint)) counters.delete(fingerprint)
  }
}
