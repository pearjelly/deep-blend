/** Author the public SceneSpecs. No Blender API, generated mesh or external asset. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { validateSceneSpec, compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'

const round = value => Number(value.toFixed(8))
const clone = value => structuredClone(value)

// Cubic cross-section segments keep tangents continuous without subdivision
// changing wall thickness. The resulting points are ordinary SceneSpec data.
function profile(start) {
  const points = [start]
  return {
    line(point) { points.push(point); return this },
    cubic(a, b, end, steps = 8) {
      const start = points.at(-1)
      for (let step = 1; step <= steps; step++) {
        const t = step / steps, u = 1 - t
        points.push([0, 1].map(axis => round(u ** 3 * start[axis] +
          3 * u ** 2 * t * a[axis] + 3 * u * t ** 2 * b[axis] + t ** 3 * end[axis])))
      }
      return this
    },
    finish() { assert(points.length <= 128); return points },
  }
}

const bottle = profile([0, 0])
  .line([0.027, 0])
  .cubic([0.032, 0], [0.035, 0.0025], [0.035, 0.008])
  .cubic([0.035, 0.034], [0.0352, 0.064], [0.0345, 0.080], 10)
  .cubic([0.0340, 0.098], [0.017, 0.107], [0.017, 0.124], 16)
  .line([0.017, 0.137])
  .cubic([0.017, 0.1385], [0.0185, 0.1385], [0.0185, 0.140], 5)
  .line([0.0185, 0.1422])
  .cubic([0.0185, 0.1442], [0.0173, 0.145], [0.0157, 0.145], 6)
  .cubic([0.0141, 0.145], [0.0128, 0.1442], [0.0128, 0.1422], 6)
  .line([0.0128, 0.124])
  .cubic([0.0128, 0.106], [0.0304, 0.096], [0.0308, 0.079], 16)
  .cubic([0.0314, 0.060], [0.0312, 0.032], [0.031, 0.013], 10)
  .cubic([0.031, 0.009], [0.028, 0.008], [0.024, 0.008], 8)
  .line([0, 0.008]).finish()

// This single closed solid includes a raised foot ring: its centre underside
// is 4.5 mm above the floor, while the narrow 82–88 mm ring makes contact.
const tray = profile([0, 0.0045])
  .line([0.080, 0.0045])
  .cubic([0.0815, 0.0045], [0.082, 0.0035], [0.082, 0.002], 4)
  .cubic([0.082, 0.0005], [0.0825, 0], [0.084, 0], 4)
  .line([0.086, 0])
  .cubic([0.0875, 0], [0.088, 0.0005], [0.088, 0.002], 4)
  .cubic([0.088, 0.0035], [0.0885, 0.0045], [0.090, 0.0045], 4)
  .line([0.104, 0.0045])
  .cubic([0.113, 0.0045], [0.120, 0.011], [0.120, 0.017], 10)
  .cubic([0.120, 0.0195], [0.1185, 0.021], [0.116, 0.021], 6)
  .cubic([0.1135, 0.021], [0.113, 0.018], [0.110, 0.016], 6)
  .cubic([0.104, 0.0115], [0.097, 0.010], [0.090, 0.010], 8)
  .line([0, 0.010]).finish()

const collar = profile([0.01705, 0])
  .line([0.0186, 0])
  .cubic([0.0193, 0], [0.0195, 0.0003], [0.0195, 0.001], 4)
  .line([0.0195, 0.0022])
  .cubic([0.0195, 0.0025], [0.0191, 0.0025], [0.0191, 0.0028], 3)
  .line([0.0191, 0.0034])
  .cubic([0.0191, 0.0037], [0.0195, 0.0037], [0.0195, 0.0040], 3)
  .line([0.0195, 0.0075])
  .cubic([0.0195, 0.0082], [0.0193, 0.0085], [0.0186, 0.0085], 4)
  .line([0.01705, 0.0085]).finish()

// Cap is open below. Its raised metal rim surrounds a separate ceramic inset.
const cap = profile([0, 0.0218])
  .line([0.0168, 0.0218])
  .cubic([0.0173, 0.0218], [0.0170, 0.0234], [0.0176, 0.0236], 4)
  .cubic([0.0195, 0.0243], [0.021, 0.0235], [0.021, 0.0215], 6)
  .line([0.021, 0.003])
  .cubic([0.021, 0.001], [0.0209, 0], [0.0203, 0], 6)
  .line([0.0196, 0])
  .line([0.0196, 0.014])
  .cubic([0.0196, 0.0155], [0.0188, 0.016], [0.0175, 0.016], 4)
  .line([0, 0.016]).finish()

const inset = profile([0, 0])
  .line([0.0158, 0])
  .cubic([0.0164, 0], [0.0166, 0.0003], [0.0166, 0.0008], 4)
  .cubic([0.0166, 0.0015], [0.013, 0.002], [0.009, 0.002], 6)
  .line([0, 0.002]).finish()

const lathe = (points, segments = 192, closedProfile = false) => ({
  shape: 'lathe', profile: points, segments, closedProfile, capEnds: false,
})
const entity = (id, generator, materialId, location, tags) => ({
  id, type: 'generator', generator, materialId,
  transform: { location, rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, tags,
})

// Blender area lights emit along local -Z. Rz(z) Rx(x) maps that vector to
// target - location. No hidden orientation overrides are needed by a renderer.
function area(id, location, target, energy, size, color) {
  const direction = target.map((value, axis) => value - location[axis])
  const length = Math.hypot(...direction)
  return { id, type: 'area', energy, size, color, transform: {
    location,
    rotationEuler: [round(Math.acos(-direction[2] / length)), 0,
      round(Math.atan2(-direction[0], direction[1]))],
  } }
}

const heroLocation = [0.30, -0.43, 0.30]
const heroTarget = [-0.002, 0, 0.057]
const spec = {
  schemaVersion: 'deepblend.scene/v1',
  project: {
    id: 'glass-ceramic', title: '澄湾 · Empty glass fragrance bottle and ceramic tray',
    goal: 'An original empty 145 mm glass bottle with a continuous 3.6–4.2 mm wall, 8 mm base, rounded shoulder and open lip; champagne metal neck sleeve and a detached ceramic-inset cap resting on a 240 mm glazed tray with an integral foot ring. Bright soft studio photography must reveal the hollow glass and true contacts. No liquid, labels or external assets.',
    units: 'metric', fps: 24, frameStart: 1, frameEnd: 48, aspectRatio: '4:3', activeCamera: 'hero',
  },
  materials: [
    { id: 'clear-glass', shader: 'glass', parameters: {
      baseColor: [0.98, 0.995, 0.985, 1], roughness: 0.022, metallic: 0,
      transmissionWeight: 1, ior: 1.46, alpha: 1,
    } },
    { id: 'celadon-glaze', shader: 'principled', parameters: {
      baseColor: [0.18, 0.30, 0.265, 1], roughness: 0.20, metallic: 0,
      coatWeight: 0.30, ior: 1.48,
    }, texture: {
      type: 'noise', scale: 900, detail: 2, bump: 0.0007,
      roughnessVariation: 0.022, colorVariation: 0.012,
    } },
    { id: 'champagne-metal', shader: 'principled', parameters: {
      baseColor: [0.61, 0.42, 0.21, 1], metallic: 0.90, roughness: 0.27,
    }, texture: {
      type: 'noise', scale: 1250, detail: 2, stretch: [1, 1, 3],
      bump: 0.00015, roughnessVariation: 0.025, colorVariation: 0.008,
    } },
    { id: 'warm-paper', shader: 'principled', parameters: {
      baseColor: [0.64, 0.63, 0.58, 1], roughness: 0.82,
    } },
  ],
  entities: [
    entity('bottle', lathe(bottle), 'clear-glass', [-0.033, 0.014, 0.010], ['subject', 'empty', 'closed-thick-wall']),
    entity('tray', lathe(tray), 'celadon-glaze', [0, 0, 0], ['subject', 'integral-foot-ring']),
    entity('neck-sleeve', lathe(collar, 160, true), 'champagne-metal', [-0.033, 0.014, 0.136], ['subject', 'independent-part']),
    entity('cap', lathe(cap, 160), 'champagne-metal', [0.059, -0.028, 0.010], ['subject', 'detached-cap', 'open-underneath']),
    entity('cap-inset', lathe(inset, 128), 'celadon-glaze', [0.059, -0.028, 0.0318], ['subject', 'independent-part']),
    entity('floor', { shape: 'plane', size: 200 }, 'warm-paper', [0, 0, -0.00001], ['environment', 'studio']),
  ],
  lights: [
    area('key-softbox', [-0.30, -0.38, 0.48], [0, 0, 0.07], 15, 0.45, [1, 0.95, 0.88]),
    area('fill-softbox', [0.36, -0.06, 0.30], [0, 0, 0.07], 7, 0.32, [0.90, 0.95, 1]),
    area('back-softbox', [0.03, 0.38, 0.40], [-0.025, 0.01, 0.08], 18, 0.40, [1, 1, 1]),
    area('top-softbox', [-0.10, 0.02, 0.63], [0, 0, 0.03], 8, 0.38, [1, 0.98, 0.94]),
  ],
  cameras: [
    { id: 'hero', role: 'active-camera', lens: 62, sensorWidth: 36, clipping: [0.005, 100],
      transform: { location: heroLocation }, targetPoint: heroTarget },
    { id: 'detail', role: 'detail', lens: 82, sensorWidth: 36, clipping: [0.005, 100],
      transform: { location: [0.155, -0.250, 0.236] }, targetPoint: [-0.025, 0.014, 0.116] },
    { id: 'reverse', role: 'three-quarter', lens: 62, sensorWidth: 36, clipping: [0.005, 100],
      transform: { location: [-0.31, 0.40, 0.22] }, targetPoint: [0, 0, 0.058] },
  ],
  shots: [
    { id: 'hero-shot', cameraId: 'hero', frameRange: [1, 48], description: 'Full assembly, open mouth, detached cap and ceramic tray; restrained optical-axis dolly.' },
    { id: 'detail-shot', cameraId: 'detail', frameRange: [1, 48], description: 'Bottle lip, inner wall, stepped sleeve and smooth shoulder; intentionally crops the tray.' },
    { id: 'reverse-shot', cameraId: 'reverse', frameRange: [1, 48], description: 'Opposite three-quarter view checks glass silhouette, tray rim and cap seating.' },
  ],
  animationTracks: ['x', 'y', 'z'].map((axis, index) => ({
    id: `hero-dolly-${axis}`, targetKind: 'camera', targetEntityId: 'hero', property: `location.${axis}`,
    keyframes: [[1, 1], [24, 0.99], [48, 0.98]].map(([frame, factor]) => ({
      frame, value: round(heroTarget[index] + (heroLocation[index] - heroTarget[index]) * factor), interpolation: 'linear',
    })),
  })),
  renderProfiles: {
    preview: { engine: 'cycles', resolution: [768, 576], samples: 64, filmTransparent: false,
      colorManagement: { viewTransform: 'AgX', exposure: 0 }, maxSamplesBudget: 64 },
    final: { engine: 'cycles', resolution: [1024, 768], samples: 128, filmTransparent: false,
      colorManagement: { viewTransform: 'AgX', exposure: 0 }, maxSamplesBudget: 128 },
  },
  assets: [],
  world: { color: [0.64, 0.70, 0.72, 1], strength: 0.45 },
}

const baseline = clone(spec)
baseline.project.id = 'glass-ceramic-ablation'
baseline.project.title = '澄湾 · Synthetic geometry/material ablation (not a historical result)'
baseline.project.goal = 'A deliberately simplified controlled ablation of the companion original SceneSpec. Same cameras, lights, exposure, environment, object placements and camera motion; angular low-detail profiles, no foot ring, flat scalar surfaces. This is not an output captured from an older DeepBlend version.'
const simpleProfiles = {
  bottle: [[0, 0], [0.035, 0], [0.035, 0.080], [0.017, 0.124], [0.017, 0.145], [0.0128, 0.145], [0.0128, 0.124], [0.031, 0.079], [0.031, 0.008], [0, 0.008]],
  tray: [[0, 0], [0.104, 0], [0.120, 0.010], [0.120, 0.021], [0.110, 0.021], [0.090, 0.010], [0, 0.010]],
  'neck-sleeve': [[0.01705, 0], [0.0195, 0], [0.0195, 0.0085], [0.01705, 0.0085]],
  cap: [[0, 0.0218], [0.017, 0.0218], [0.017, 0.024], [0.021, 0.024], [0.021, 0], [0.0196, 0], [0.0196, 0.016], [0, 0.016]],
  'cap-inset': [[0, 0], [0.0166, 0], [0.0166, 0.002], [0, 0.002]],
}
for (const item of baseline.entities) {
  if (simpleProfiles[item.id]) item.generator = lathe(simpleProfiles[item.id], 48, item.id === 'neck-sleeve')
  if (item.id !== 'floor') item.tags = ['subject', 'synthetic-ablation']
}
for (const material of baseline.materials) {
  delete material.texture
  if (material.id === 'celadon-glaze') material.parameters.coatWeight = 0
  // Preserve material identities and transmission while removing fine finish.
  if (material.id === 'clear-glass') material.parameters.roughness = 0.12
  if (material.id === 'celadon-glaze') material.parameters.roughness = 0.40
  if (material.id === 'champagne-metal') material.parameters.roughness = 0.40
}

for (const key of ['cameras', 'lights', 'world', 'shots', 'animationTracks', 'renderProfiles', 'assets']) {
  assert.deepEqual(baseline[key], spec[key], `ablation changed ${key}`)
}
assert.deepEqual(baseline.entities.map(({ id, transform }) => ({ id, transform })),
  spec.entities.map(({ id, transform }) => ({ id, transform })))
assert.deepEqual(baseline.entities.at(-1), spec.entities.at(-1), 'ablation changed the studio floor')

for (const [name, document] of [['scene-spec.json', spec], ['baseline-scene-spec.json', baseline]]) {
  const checked = validateSceneSpec(document)
  assert.equal(checked.ok, true, JSON.stringify(checked.errors, null, 2))
  const compiled = compileSceneSpec(document)
  assert.equal(validateSceneSpec(compiled.spec).ok, true, `${name}: resolved spec is invalid`)
  assert.equal(compiled.notices.length, 0, JSON.stringify(compiled.notices))
  await writeFile(new URL(name, import.meta.url), `${JSON.stringify(document, null, 2)}\n`)
  console.log(`${name}: validate + compile PASS; ${document.entities.length} entities; ${document.cameras.length} cameras; ${document.animationTracks.length} tracks; ${checked.notices.length} notices`)
}

// Integrating pi*r^2 dz around an ordered cross section subtracts the cavity.
// The polygonal revolution differs only by sin(2*pi/N)/(2*pi/N). A 3% window
// deliberately tolerates that approximation while rejecting a filled bottle.
function volumeOf(points, closed = false) {
  const loop = closed ? [...points, points[0]] : points
  return Math.abs(loop.slice(1).reduce((sum, [radius, height], index) => {
    const [previousRadius, previousHeight] = loop[index]
    return sum + Math.PI * (height - previousHeight) *
      (radius ** 2 + radius * previousRadius + previousRadius ** 2) / 3
  }, 0))
}
const subjects = spec.entities.filter(item => !item.tags.includes('environment'))
const glassVolume = volumeOf(bottle)
const geometryChecks = {
  closedEntities: subjects.map(item => item.id),
  dimensions: subjects.flatMap(item => {
    const points = item.generator.profile
    const diameter = 2 * Math.max(...points.map(point => point[0]))
    const height = Math.max(...points.map(point => point[1])) - Math.min(...points.map(point => point[1]))
    return [diameter, diameter, height].map((size, axis) => ({
      entityId: item.id, axis, min: round(size - 0.00015), max: round(size + 0.00015),
    }))
  }),
  volumes: [{ entityId: 'bottle', min: glassVolume * 0.97, max: glassVolume * 1.03 }],
  notes: [
    'Units: metres for dimensions, cubic metres for volumes. World-space extents; every authored subject scale is one.',
    'All five subject parts are closed solids, including the hollow glass shell, tray foot ring, open-bottom cap, ceramic inset and annular neck sleeve. The environment floor is deliberately excluded.',
    `The empty glass shell has an analytic piecewise-linear revolution volume of ${glassVolume.toExponential(9)} m^3 (${(glassVolume * 1e6).toFixed(3)} mL). The cavity is subtracted by the inner profile; the range allows 3% for numeric/polygon differences.`,
    'Dimensions allow ±0.15 mm around authored profile bounds. These checks complement image review; they do not establish surface beauty or collision freedom.',
  ],
}
await writeFile(new URL('geometry-checks.json', import.meta.url), `${JSON.stringify(geometryChecks, null, 2)}\n`)
console.log(`Written to ${fileURLToPath(new URL('.', import.meta.url))}`)
