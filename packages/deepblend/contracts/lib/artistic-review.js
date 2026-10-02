/** Model judgments stay separate from deterministic render measurements. */
export const ARTISTIC_DIMENSIONS = Object.freeze(['geometry', 'materials', 'lighting', 'goalFit'])

/** Validate evidence, confidence and the Host's actual reference image inventory.
 * Passing must account for every reference for that dimension; one evidenced
 * mismatch suffices for needs_work. Old callers without references remain valid.
 */
export function validateArtisticReview(raw, viewIds, minConfidence = 0.8, context = {}) {
  const dimensions = {}
  const problems = []
  const subjectUnavailable = context.subject?.available === false
  if (subjectUnavailable) problems.push(context.subject.reason ?? 'The review subject is unavailable.')
  // This is the Host's actual attachment inventory, not a list proposed by the model.
  const references = new Map((context.referenceImages ?? []).map(reference => [reference.id, reference]))
  const referenceEvidenceValid = (entry, dimension) => {
    const relevant = [...references.values()].filter(reference => reference.purposes?.includes(dimension))
    const ids = entry?.referenceIds
    if (ids === undefined) return relevant.length === 0 || entry?.status === 'unassessable'
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || !ids.every(id =>
      typeof id === 'string' && references.get(id)?.purposes?.includes(dimension))) return false
    if (entry?.status === 'unassessable' || relevant.length === 0) return true
    return entry?.status === 'pass' ? relevant.every(reference => ids.includes(reference.id)) : ids.length > 0
  }
  const evidenceValid = entry => entry && viewIds.has(entry.viewId) &&
    typeof entry.evidence === 'string' && entry.evidence.trim().length >= 8 &&
    entry.evidence.length <= 2000 && Number.isFinite(entry.confidence) &&
    entry.confidence >= minConfidence && entry.confidence <= 1
  for (const dimension of ARTISTIC_DIMENSIONS) {
    const entry = raw?.dimensions?.[dimension]
    const validReferences = referenceEvidenceValid(entry, dimension)
    const valid = evidenceValid(entry) && validReferences && ['pass', 'needs_work', 'unassessable'].includes(entry.status)
    if (!valid) problems.push(`${dimension}: ${validReferences ? 'missing, invalid or insufficiently confident evidence' : 'missing, unknown or inapplicable referenceIds'}`)
    dimensions[dimension] = valid && !(subjectUnavailable && entry.status === 'pass') ? {
      status: entry.status, viewId: entry.viewId, evidence: entry.evidence.trim(), confidence: entry.confidence,
      ...(entry.referenceIds === undefined ? {} : { referenceIds: [...entry.referenceIds] }),
    } : { status: 'unassessable', viewId: null, evidence: null, confidence: null }
  }
  const comparison = raw?.comparison
  const validComparison = evidenceValid(comparison) && ['improved', 'equivalent', 'regressed', 'unassessable'].includes(comparison.verdict)
  const statuses = Object.values(dimensions).map(entry => entry.status)
  return {
    status: statuses.every(status => status === 'pass') ? 'pass'
      : statuses.includes('needs_work') ? 'needs_work' : 'unassessable',
    dimensions,
    comparison: validComparison && !subjectUnavailable ? {
      verdict: comparison.verdict, viewId: comparison.viewId,
      evidence: comparison.evidence.trim(), confidence: comparison.confidence,
    } : { verdict: 'unassessable', viewId: null, evidence: null, confidence: null },
    problems,
  }
}

/** A newly failing dimension cannot be hidden by an optimistic overall comparison. */
export function artisticRegressed(before, after) {
  return after.comparison.verdict === 'regressed' || ARTISTIC_DIMENSIONS.some(dimension =>
    before.dimensions[dimension].status === 'pass' && after.dimensions[dimension].status === 'needs_work')
}
