/** Rebuild the authored public SceneSpec pair; no Blender-specific geometry API. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateSceneSpec, compileSceneSpec } from '@deepblend/dsh-blender-contracts'

const directory = dirname(fileURLToPath(import.meta.url))
const round = value => Math.round(value * 1e8) / 1e8
const vector = values => values.map(round)
function cubic(a, b, c, d, count) {
  return Array.from({ length: count }, (_, index) => {
    const t = index / count, q = 1 - t
    return a.map((_, axis) => round(q ** 3 * a[axis] + 3 * q * q * t * b[axis] + 3 * q * t * t * c[axis] + t ** 3 * d[axis]))
  })
}
function aim(location, target) {
  const [x, y, z] = target.map((value, axis) => value - location[axis])
  return vector([Math.atan2(Math.hypot(x, y), -z), 0, Math.atan2(-x, y)])
}
function floorCable(nodes) {
  const points = []
  for (let index = 0; index < nodes.length - 1; index++) {
    const a = nodes[Math.max(0, index - 1)], b = nodes[index]
    const c = nodes[index + 1], d = nodes[Math.min(nodes.length - 1, index + 2)]
    for (let step = 0; step < 12; step++) {
      const t = step / 12
      const point = b.map((value, axis) => 0.5 * ((2 * value) + (-a[axis] + c[axis]) * t +
        (2 * a[axis] - 5 * value + 4 * c[axis] - d[axis]) * t * t +
        (-a[axis] + 3 * value - 3 * c[axis] + d[axis]) * t * t * t))
      point[2] = Math.max(0.0023, point[2])
      points.push(vector(point))
    }
  }
  return [...points, nodes.at(-1)]
}
const entities = []
function part(id, generator, materialId, location = [0, 0, 0], rotationEuler = [0, 0, 0], tags = []) {
  const entity = { id, type: 'generator', generator, materialId,
    transform: { location, rotationEuler, scale: [1, 1, 1] }, tags }
  entities.push(entity)
  return entity
}
function lathe(id, profile, material, location, extra = {}) {
  return part(id, { shape: 'lathe', profile, segments: 128, ...extra }, material, location)
}
function cylinder(id, radius, depth, material, location, rotation = [0, 0, 0], bevel = 0.0007) {
  return part(id, { shape: 'cylinder', radius, depth, segments: 96,
    ...(bevel ? { bevel: { width: bevel, segments: 5 } } : {}) }, material, location, rotation)
}

// A closed revolved boundary forms the actual shell and rolled opening; unit scale.
const outer = [
  ...cubic([0.104, 0.008], [0.102, 0.038], [0.074, 0.096], [0.035, 0.112], 32),
  ...cubic([0.035, 0.112], [0.026, 0.117], [0.017, 0.12], [0.01, 0.12], 12),
  [0.01, 0.12],
]
const inner = outer.map(([r, z]) => vector([r - 0.0016, z - 0.0016]))
const shadeProfile = [...outer, ...inner.toReversed(),
  [0.10255, 0.0043], [0.103, 0.0036], [0.1036, 0.0034], [0.1042, 0.0037],
  [0.1047, 0.0043], [0.1049, 0.0051], [0.10475, 0.0064]]
lathe('shade-shell', shadeProfile, 'champagne-spun', [0.045, 0, 0.31], { closedProfile: true }).tags = ['hero-product', 'continuous-hollow-shell']
// Separate thin enamel lining sits inside the metal, short of the rolled opening.
const liningOuter = inner.slice(3, -5).map(([r, z]) => vector([r - 0.00016, z]))
const liningInner = liningOuter.map(([r, z]) => vector([r - 0.00025, z]))
lathe('shade-enamel-lining', [...liningOuter, ...liningInner.toReversed()], 'warm-enamel', [0.045, 0, 0.31], { closedProfile: true })

lathe('weighted-base', [
  [0, 0.003], [0.04, 0.003], [0.09, 0.003], [0.098, 0.0034],
  [0.102, 0.0046], [0.104, 0.007], [0.1045, 0.01], [0.1044, 0.015],
  [0.1035, 0.019], [0.102, 0.022], [0.099, 0.024], [0.095, 0.025],
  [0.085, 0.0255], [0.04, 0.0255], [0, 0.0255],
], 'champagne-spun')
cylinder('base-felt-foot', 0.096, 0.003, 'graphite-rubber', [0, 0, 0.0015], [0, 0, 0], 0.0004)
lathe('base-lower-reveal', [[0.1041, 0.0072], [0.1046, 0.0072], [0.1047, 0.0082], [0.10425, 0.0082]], 'dark-bronze', [0, 0, 0], { closedProfile: true })
cylinder('mast-socket', 0.015, 0.013, 'dark-bronze', [-0.075, 0.025, 0.0298], [0, 0, 0], 0.0015)
cylinder('mast-socket-collar', 0.011, 0.004, 'polished-edge', [-0.075, 0.025, 0.037], [0, 0, 0], 0.0006)
cylinder('upright-mast', 0.007, 0.324, 'champagne-brushed', [-0.075, 0.025, 0.199], [0, 0, 0], 0.0005)
const sideways = [Math.PI / 2, 0, 0]
cylinder('hinge-body', 0.016, 0.024, 'dark-bronze', [-0.075, 0.025, 0.364], sideways, 0.0018)
cylinder('hinge-front-cap', 0.0128, 0.0026, 'champagne-spun', [-0.075, 0.0118, 0.364], sideways, 0.0006)
cylinder('hinge-rear-cap', 0.0128, 0.0026, 'champagne-spun', [-0.075, 0.0382, 0.364], sideways, 0.0006)
part('hinge-fine-ring', { shape: 'torus', majorRadius: 0.0095, minorRadius: 0.00055, segments: 96, ringCount: 16 }, 'polished-edge', [-0.075, 0.0102, 0.364], sideways)
cylinder('hinge-centre-pin', 0.003, 0.0018, 'dark-bronze', [-0.075, 0.0096, 0.364], sideways, 0.0004)
part('swept-upper-arm', { shape: 'curve', pathInterpolation: 'bezier', radius: 0.006, curveResolution: 32, bevelResolution: 10, capEnds: true,
  path: [[-0.075, 0.025, 0.364], [-0.062, 0.023, 0.396], [-0.014, 0.015, 0.434], [0.030, 0.004, 0.449], [0.045, 0, 0.444], [0.045, 0, 0.428]] }, 'champagne-brushed')
cylinder('shade-neck-collar', 0.012, 0.013, 'dark-bronze', [0.045, 0, 0.4315], [0, 0, 0], 0.001)
cylinder('shade-neck-rim', 0.0122, 0.002, 'polished-edge', [0.045, 0, 0.426], [0, 0, 0], 0.0005)
cylinder('bulb-socket', 0.009, 0.035, 'warm-enamel', [0.045, 0, 0.400], [0, 0, 0], 0.002)
part('opal-bulb', { shape: 'uv_sphere', radius: 0.021, segments: 96, ringCount: 48 }, 'opal-warm', [0.045, 0, 0.366])
cylinder('control-recess', 0.013, 0.001, 'dark-bronze', [0.035, -0.042, 0.0256], [0, 0, 0], 0.0004)
cylinder('dimmer-dial', 0.011, 0.006, 'champagne-spun', [0.035, -0.042, 0.029], [0, 0, 0], 0.0012)
part('dimmer-position-mark', { shape: 'curve', radius: 0.00045, path: [[0.035, -0.05, 0.0321], [0.035, -0.0465, 0.0321]], bevelResolution: 4, capEnds: true }, 'dark-bronze')
part('rear-cable-grommet', { shape: 'uv_sphere', radius: 0.0045, segments: 48, ringCount: 24 }, 'graphite-rubber', [-0.055, 0.087, 0.013])
part('fabric-power-cable', { shape: 'curve', radius: 0.0022, pathInterpolation: 'poly', curveResolution: 32, bevelResolution: 8, capEnds: true,
  path: floorCable([[-0.055, 0.087, 0.013], [-0.065, 0.114, 0.004], [-0.125, 0.154, 0.0023], [-0.122, 0.217, 0.0023], [-0.047, 0.255, 0.0023], [0.069, 0.251, 0.0023], [0.156, 0.222, 0.0023], [0.223, 0.251, 0.0023]]) }, 'woven-cable')
part('studio-floor', { shape: 'plane', size: 200 }, 'warm-stone', [0, 0, 0], [0, 0, 0], ['environment'])

const heroTarget = [0.014, 0.025, 0.228]
const poses = [1, 24, 48].map((frame, index) => {
  const angle = (-58 + index * -4) * Math.PI / 180
  const location = vector([heroTarget[0] + 1.3 * Math.cos(angle), heroTarget[1] + 1.3 * Math.sin(angle), 0.52])
  return { frame, location, rotation: aim(location, heroTarget) }
})
const cameras = [
  { id: 'hero', role: 'active-camera', lens: 65, sensorWidth: 36, clipping: [0.005, 250], transform: { location: poses[0].location }, targetPoint: heroTarget, fStop: 11 },
  { id: 'detail', role: 'detail', lens: 70, sensorWidth: 36, clipping: [0.005, 250], transform: { location: [0.31, -0.44, 0.1] }, targetPoint: [0.019, 0.008, 0.343], fStop: 16 },
  { id: 'reverse', role: 'three-quarter', lens: 58, sensorWidth: 36, clipping: [0.005, 250], transform: { location: [-0.75, 1.08, 0.585] }, targetPoint: [0.04, 0.07, 0.20], fStop: 11 },
]
const animationTracks = [['location.x', 'location', 0], ['location.y', 'location', 1], ['rotationEuler.x', 'rotation', 0], ['rotationEuler.z', 'rotation', 2]].map(([property, key, axis], index) => ({
  id: 'hero-orbit-' + index, targetKind: 'camera', targetEntityId: 'hero', property,
  keyframes: poses.map(pose => ({ frame: pose.frame, value: pose[key][axis], interpolation: 'linear' })),
}))
const area = (id, location, target, energy, size, color) => ({ id, type: 'area', energy, size, color, transform: { location, rotationEuler: aim(location, target) } })
const spec = {
  schemaVersion: 'deepblend.scene/v1',
  project: { id: 'metal-lamp', title: 'Arc No. 01 — champagne task light',
    goal: 'A restrained champagne-metal desk lamp photographed as a finished design object: a continuous spun shade with rolled opening and enamel interior, weighty rounded base, slender joined arm, fine brushed highlights and grounded cable. Warm neutral studio, no logos. The camera moves gently; the assembly remains fixed.',
    units: 'metric', fps: 24, frameStart: 1, frameEnd: 48, aspectRatio: '4:3', activeCamera: 'hero' },
  materials: [
    { id: 'champagne-spun', shader: 'principled', parameters: { baseColor: [0.63, 0.535, 0.415, 1], metallic: 1, roughness: 0.39, coatWeight: 0.025, anisotropic: 0.55, anisotropicRotation: 0 }, tangent: { mode: 'radial', axis: 'z' }, texture: { type: 'noise', scale: 1800, detail: 2, stretch: [1, 1, 0.028], bump: 0.002, roughnessVariation: 0.035, colorVariation: 0.012 } },
    { id: 'champagne-brushed', shader: 'principled', parameters: { baseColor: [0.63, 0.535, 0.415, 1], metallic: 1, roughness: 0.39, coatWeight: 0.025 }, texture: { type: 'noise', scale: 1800, detail: 2, stretch: [1, 1, 0.028], bump: 0.002, roughnessVariation: 0.035, colorVariation: 0.012 } },
    { id: 'polished-edge', shader: 'principled', parameters: { baseColor: [0.67, 0.59, 0.47, 1], metallic: 1, roughness: 0.19 } },
    { id: 'dark-bronze', shader: 'principled', parameters: { baseColor: [0.125, 0.098, 0.067, 1], metallic: 0.9, roughness: 0.32 } },
    { id: 'warm-enamel', shader: 'principled', parameters: { baseColor: [0.76, 0.715, 0.61, 1], metallic: 0, roughness: 0.3, coatWeight: 0.25 } },
    { id: 'opal-warm', shader: 'principled', parameters: { baseColor: [0.82, 0.765, 0.65, 1], roughness: 0.35, emissionColor: [1, 0.72, 0.38, 1], emissionStrength: 2.5 } },
    { id: 'graphite-rubber', shader: 'principled', parameters: { baseColor: [0.016, 0.019, 0.019, 1], roughness: 0.78 } },
    { id: 'woven-cable', shader: 'principled', parameters: { baseColor: [0.028, 0.027, 0.024, 1], roughness: 0.72 }, texture: { type: 'noise', scale: 2500, detail: 2, bump: 0.045, roughnessVariation: 0.07, colorVariation: 0.08 } },
    { id: 'warm-stone', shader: 'principled', parameters: { baseColor: [0.17, 0.155, 0.137, 1], roughness: 0.72 } },
  ],
  entities,
  lights: [
    area('large-key-softbox', [-0.44, -0.62, 0.85], [0.01, 0, 0.25], 22, 0.62, [1, 0.93, 0.83, 1]),
    area('rear-edge-softbox', [0.44, 0.42, 0.68], [0.045, 0, 0.34], 17, 0.4, [0.84, 0.90, 1, 1]),
    area('front-fill', [0.5, -0.52, 0.37], [0.01, 0, 0.25], 3.5, 0.5, [1, 0.94, 0.85, 1]),
    area('top-sheen', [-0.08, 0.09, 1.02], [0.02, 0, 0.35], 6, 0.42, [1, 0.97, 0.92, 1]),
    { id: 'bulb-practical', type: 'point', energy: 0.65, size: 0.006, color: [1, 0.73, 0.42, 1], transform: { location: [0.045, 0, 0.34] } },
  ],
  world: { color: [0.18, 0.19, 0.22, 1], strength: 0.24 }, cameras,
  shots: cameras.map(camera => ({ id: camera.id + '-shot', cameraId: camera.id, frameRange: [1, 48] })), animationTracks,
  renderProfiles: {
    preview: { engine: 'cycles', resolution: [768, 576], samples: 64, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 }, maxSamplesBudget: 128 },
    final: { engine: 'cycles', resolution: [1024, 768], samples: 128, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 }, maxSamplesBudget: 256 },
  }, assets: [],
}

const baseline = structuredClone(spec)
baseline.project.id = 'metal-lamp-baseline'
baseline.project.title = 'Arc No. 01 — geometry and finish ablation'
baseline.project.goal = 'A deliberately simplified ablation of the same authored lamp: fewer radial/profile samples, plain metal, and missing small trim. Camera, assembly positions, practical light, world, render profiles and exposure are identical. This is not a historical version.'
const omit = new Set(['base-lower-reveal', 'mast-socket-collar', 'hinge-fine-ring', 'hinge-centre-pin', 'shade-neck-rim', 'dimmer-position-mark'])
baseline.entities = baseline.entities.filter(entity => !omit.has(entity.id))
for (const entity of baseline.entities) {
  const generator = entity.generator
  if (generator.segments) generator.segments = 16
  if (generator.ringCount) generator.ringCount = 8
  delete generator.bevel
  if (generator.shape === 'curve') { generator.curveResolution = 4; generator.bevelResolution = 2 }
  if (entity.id === 'fabric-power-cable') generator.path = generator.path.filter((_, index) => index % 12 === 0)
  if (entity.id === 'shade-shell') generator.profile = [[0.104, 0.0034], [0.104, 0.012], [0.072, 0.094], [0.01, 0.12], [0.0084, 0.1184], [0.0704, 0.0924], [0.1024, 0.01], [0.1024, 0.0034]]
  if (entity.id === 'shade-enamel-lining') {
    const boundary = [liningOuter[0], liningOuter[20], liningOuter.at(-1)]
    generator.profile = [...boundary, ...boundary.toReversed().map(([r, z]) => vector([r - 0.00025, z]))]
  }
  if (entity.id === 'weighted-base') entity.generator = {
    shape: 'lathe', profile: [[0, 0.003], [0.1045, 0.003], [0.1045, 0.0255], [0, 0.0255]], segments: 16, capEnds: true,
  }
}
for (const material of baseline.materials) {
  delete material.texture
  delete material.tangent
  delete material.parameters.anisotropic
  delete material.parameters.anisotropicRotation
  if (['champagne-brushed', 'champagne-spun'].includes(material.id)) material.parameters = { baseColor: [0.63, 0.535, 0.415, 1], metallic: 1, roughness: 0.39 }
}
for (const field of ['cameras', 'shots', 'animationTracks', 'world', 'lights', 'renderProfiles']) assert.deepEqual(baseline[field], spec[field])
for (const entity of baseline.entities) assert.deepEqual(entity.transform, spec.entities.find(candidate => candidate.id === entity.id).transform, `${entity.id}: baseline transform differs`)
for (const [name, document] of [['scene-spec.json', spec], ['baseline-scene-spec.json', baseline]]) {
  const validation = validateSceneSpec(document)
  assert.equal(validation.ok, true, JSON.stringify(validation, null, 2))
  const compiled = compileSceneSpec(document)
  assert.equal(compiled.spec.cameras.length, 3)
  assert.equal(compiled.spec.project.frameEnd, 48)
  const text = JSON.stringify(document, null, 2) + '\n'
  if (process.argv.includes('--check')) assert.equal(readFileSync(join(directory, name), 'utf8'), text, `${name} differs from its deterministic builder`)
  else writeFileSync(join(directory, name), text)
  process.stdout.write(`${name}: valid; ${document.entities.length} entities, ${document.materials.length} materials, ${document.animationTracks.length} camera tracks; ${validation.notices.length} validation notices, ${compiled.notices.length} compile notices\n`)
}
