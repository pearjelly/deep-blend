/** Dimensions are local scene units; mesh validity is checked again in Blender. */
export const HANDLED_CUP_FIELDS = ['height', 'wallThickness', 'baseThickness', 'footRound', 'handleRadius',
  'handleLower', 'handleUpper', 'rootRadius', 'rootLength', 'sectionSegments', 'handleSegments', 'rootSegments', 'wallRows']

export function resolveHandledCup(spec = {}) {
  const radius = spec.radius ?? .04
  const height = spec.height ?? radius * 2.625
  const wallThickness = spec.wallThickness ?? radius * .075
  const baseThickness = spec.baseThickness ?? radius * .125
  return { ...spec, radius, height, wallThickness, baseThickness,
    footRound: spec.footRound ?? Math.min(wallThickness, baseThickness * .8),
    handleRadius: spec.handleRadius ?? radius * .1375,
    handleLower: spec.handleLower ?? height * (4 / 15),
    handleUpper: spec.handleUpper ?? height * (26 / 35),
    rootRadius: spec.rootRadius ?? radius * .2625, rootLength: spec.rootLength ?? radius * .2,
    segments: spec.segments ?? 192, sectionSegments: spec.sectionSegments ?? 96,
    handleSegments: spec.handleSegments ?? 96, rootSegments: spec.rootSegments ?? 32, wallRows: spec.wallRows ?? 40 }
}

export function handledCupIssues(spec) {
  const inputFields = ['radius', 'segments', ...HANDLED_CUP_FIELDS]
  for (const key of inputFields) if (spec[key] !== undefined &&
      (typeof spec[key] !== 'number' || !Number.isFinite(spec[key]) || spec[key] <= 0)) {
    return [`${key} must be a finite positive number`]
  }
  const p = resolveHandledCup(spec)
  const errors = []
  const within = (value, low, high) => value >= low - 1e-12 && value <= high + 1e-12
  const ratios = [
    ['radius', p.radius, .02, .08], ['height/radius', p.height / p.radius, 1.8, 4],
    ['wallThickness/radius', p.wallThickness / p.radius, .025, .15],
    ['baseThickness/radius', p.baseThickness / p.radius, .05, .25],
    ['handleRadius/radius', p.handleRadius / p.radius, .05, .2],
    ['rootRadius/radius', p.rootRadius / p.radius, .12, .35],
    ['rootRadius/handleRadius', p.rootRadius / p.handleRadius, 1.4, 3],
    ['rootLength/rootRadius', p.rootLength / p.rootRadius, .4, 1.2],
    ['footRound/radius', p.footRound / p.radius, .01, .15],
  ]
  for (const [name, value, low, high] of ratios) if (!Number.isFinite(value) || !within(value, low, high)) {
    errors.push(`${name} must be within ${low}–${high}`)
  }
  const gap = (p.handleUpper - p.handleLower) / 2
  if (gap <= 0 || p.rootLength / gap > .8 + 1e-12) errors.push('handleUpper must exceed handleLower; rootLength/half-gap must be <=0.8')
  if (gap + p.radius * 1e-12 < Math.max(1.1 * p.rootRadius, 2 * p.handleRadius)) errors.push('attachment half-gap must be >=1.1*rootRadius and >=2*handleRadius')
  if (p.handleLower - p.rootRadius + p.radius * 1e-12 < p.footRound + .01 * p.radius) errors.push('lower root footprint must clear the rounded foot by 0.01*radius')
  if (p.handleUpper + p.rootRadius > p.height - p.wallThickness / 2 - .01 * p.radius + p.radius * 1e-12) errors.push('upper root footprint must clear the rounded lip by 0.01*radius')
  for (const [key, low, high, multiple] of [['segments',64,256,4], ['sectionSegments',32,96,4],
    ['handleSegments',24,128,4], ['rootSegments',8,48,1], ['wallRows',16,64,1]]) {
    if (!Number.isInteger(p[key]) || p[key] < low || p[key] > high || p[key] % multiple) errors.push(`${key} must be an integer within ${low}–${high}, divisible by ${multiple}`)
  }
  if (p.footRound > Math.min(p.wallThickness, p.baseThickness * .8) + p.radius * 1e-12) errors.push('footRound must not exceed wallThickness or 0.8*baseThickness')
  return errors
}
