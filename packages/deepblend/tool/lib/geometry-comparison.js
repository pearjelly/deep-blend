/** Compare two already verified reports for the same explicit surface selection. */
export function compareSurfaceReports(reference, current) {
  const chords = [], separations = []
  const samples = current.surfaceSamples.map((after, i) => {
    const before = reference.surfaceSamples[i]
    const values = sample => ({ status: sample.status,
      ...(sample.status === 'sampled' ? { normalSurfaceChordMm: sample.normalSurfaceChordMm } : {}),
      ...(sample.gap ? { targetStatus: sample.gap.status,
        ...(sample.gap.status === 'sampled' ? { normalRaySeparationMm: sample.gap.normalRaySeparationMm } : {}) } : {}) })
    const change = { sampleId: after.sampleId, entityId: after.entityId,
      ...(after.targetEntityId ? { targetEntityId: after.targetEntityId } : {}), before: values(before), after: values(after) }
    if (before.status === 'sampled' && after.status === 'sampled') {
      change.normalSurfaceChordChangeMm = after.normalSurfaceChordMm - before.normalSurfaceChordMm
      chords.push(Math.abs(change.normalSurfaceChordChangeMm))
    }
    if (before.gap?.status === 'sampled' && after.gap?.status === 'sampled') {
      change.normalRaySeparationChangeMm = after.gap.normalRaySeparationMm - before.gap.normalRaySeparationMm
      separations.push(Math.abs(change.normalRaySeparationChangeMm))
    }
    return change
  })
  return { schemaVersion: 'deepblend.surface-comparison/v1', referenceInspection: reference, samples,
    summary: { requestedSamples: samples.length, comparedChords: chords.length, comparedSeparations: separations.length,
      ...(chords.length ? { maxAbsoluteChordChangeMm: Math.max(...chords) } : {}),
      ...(separations.length ? { maxAbsoluteSeparationChangeMm: Math.max(...separations) } : {}) },
    limitations: [
      'Changes are current minus reference for identical explicit world seeds, parts and frame. These are not necessarily the same material points.',
      'Maxima cover every comparable requested sample, including chord-only samples. Unavailable pairs have no numeric change and are not zero.',
      'Observed changes do not establish their cause, a global minimum, manufacturing tolerance, symmetry, collision absence or artistic approval.',
    ] }
}
