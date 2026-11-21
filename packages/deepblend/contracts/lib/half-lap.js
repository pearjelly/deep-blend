/** Bounded finishing belongs to the joint, after its array/mirror control meshes. */
export const HALF_LAP_EDGE_FINISH_FEATURE = 'geometry.joinery.half_lap.edge_finish'
export const HALF_LAP_EDGE_MAX = 0.005
export const halfLapKey = ids => [...ids].sort().join(':')
export const findHalfLap = (spec, ids) => spec.halfLaps?.find(pair =>
  halfLapKey([pair.lowerEntityId, pair.upperEntityId]) === halfLapKey(ids))
