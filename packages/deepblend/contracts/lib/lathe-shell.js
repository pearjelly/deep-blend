/** Bounded paired lathe profiles: expand the rim while keeping the neck fixed. */
import { canonicalStringify } from './canonical.js'

const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const tangent = (points, index) => {
  const delta = sub(points[Math.min(points.length - 1, index + 1)], points[Math.max(0, index - 1)])
  const length = Math.hypot(...delta)
  if (!Number.isFinite(length) || length === 0) throw new TypeError('Paired profiles require distinct neighbouring points')
  return delta.map(value => value / length)
}
const rotate = (delta, before, after) => {
  const cosine = before[0] * after[0] + before[1] * after[1]
  const sine = before[0] * after[1] - before[1] * after[0]
  return [delta[0] * cosine - delta[1] * sine, delta[0] * sine + delta[1] * cosine]
}

export function latheShellTargets(binding) {
  return [binding.entityId, binding.linerEntityId].map(entityId => ({
    kind: 'generator', property: 'profile', entityId, latheShell: true,
  }))
}

/** The manifest supplies bounded correspondence, never executable expressions. */
export function deformLatheShell(spec, binding, delta) {
  const shell = spec.entities.find(entity => entity.id === binding.entityId)
  const liner = spec.entities.find(entity => entity.id === binding.linerEntityId)
  const count = binding.outerPointCount, start = binding.linerStart, liningCount = binding.linerPointCount
  const fail = message => { throw new TypeError(message) }
  if (!shell || !liner || shell === liner) fail('A shell binding requires distinct existing shell and liner entities')
  for (const entity of [shell, liner]) {
    if (entity.type !== 'generator' || entity.generator?.shape !== 'lathe' || entity.generator.closedProfile !== true) fail('Shell and liner must be closed lathe profiles')
    if ((entity.transform?.scale ?? [1, 1, 1]).some(value => value !== 1)) fail('Shell profiles require unit scale')
  }
  if (canonicalStringify(shell.transform) !== canonicalStringify(liner.transform)) fail('Shell and liner must share their authored transform')
  const profile = shell.generator.profile, lining = liner.generator.profile
  if (profile.length < 2 * count + 3 || lining.length !== 2 * liningCount || start + liningCount > count || start < 1) fail('Profile correspondence does not fit the shell and liner boundaries')
  const outer = profile.slice(0, count), inner = profile.slice(count, 2 * count).toReversed()
  const liningOuter = lining.slice(0, liningCount), liningInner = lining.slice(liningCount).toReversed()
  if (outer[0][1] !== binding.rimHeight || outer.at(-1)[1] < binding.neckAnchorHeight || binding.neckAnchorHeight <= binding.rimHeight) fail('The authored rim and neck heights must bound the expansion')
  outer.forEach((point, index) => {
    tangent(outer, index); tangent(inner, index)
    if (index && (point[1] <= outer[index - 1][1] || point[0] > outer[index - 1][0])) fail('Outer shell must rise monotonically toward its neck')
    if (inner[index][0] >= point[0]) fail('Inner boundary must sit inside the outer shell')
  })
  liningOuter.forEach((point, index) => {
    tangent(liningOuter, index)
    if (point[0] >= inner[index + start][0] || liningInner[index][0] >= point[0]) fail('Liner correspondence must preserve a positive gap and lining thickness')
  })
  if (!Number.isFinite(delta)) fail('Shell expansion must be finite')
  if (delta === 0) return { shell: structuredClone(profile), liner: structuredClone(lining) }
  const movedOuter = outer.map(([radius, height]) => {
    const t = Math.max(0, Math.min(1, (binding.neckAnchorHeight - height) / (binding.neckAnchorHeight - binding.rimHeight)))
    return [radius + delta * t * t * (3 - 2 * t), height]
  })
  const movedInner = inner.map((point, index) => add(movedOuter[index], rotate(sub(point, outer[index]), tangent(outer, index), tangent(movedOuter, index))))
  const movedLining = liningOuter.map((point, index) => add(movedInner[index + start], rotate(sub(point, inner[index + start]), tangent(inner, index + start), tangent(movedInner, index + start))))
  const movedLiningInner = liningInner.map((point, index) => add(movedLining[index], rotate(sub(point, liningOuter[index]), tangent(liningOuter, index), tangent(movedLining, index))))
  const result = {
    shell: [...movedOuter, ...movedInner.toReversed(), ...profile.slice(2 * count).map(([radius, height]) => [radius + delta, height])],
    liner: [...movedLining, ...movedLiningInner.toReversed()],
  }
  for (const points of Object.values(result)) if (points.some(point => point[0] <= 0 || point.some(value => !Number.isFinite(value)))) fail('The entire expansion must retain finite positive radii')
  return result
}
