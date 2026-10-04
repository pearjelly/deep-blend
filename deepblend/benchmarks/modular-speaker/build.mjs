#!/usr/bin/env node
/** Rebuild the two public SceneSpecs. No Blender API, assets or hidden geometry. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { validateSceneSpec, compileSceneSpec } from '../../../packages/deepblend/contracts/lib/scene-spec.js'

const OUT = import.meta.dirname
const round = value => Math.round(value * 1e9) / 1e9
const clean = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'number' ? round(item) : item))
const entities = []
const FRONT = [Math.PI / 2, 0, 0]
const REAR = [-Math.PI / 2, 0, 0]
const materials = [
  material('shell-porcelain', [0.66, 0.62, 0.52, 1], 0.31, 0, { scale: 1500, detail: 2, bump: 0.00005, roughnessVariation: 0.035, colorVariation: 0.012 }),
  material('graphite', [0.028, 0.035, 0.040, 1], 0.4, 0.12, { scale: 1800, detail: 2, bump: 0.00004, roughnessVariation: 0.035 }),
  material('woven-sand', [0.24, 0.20, 0.145, 1], 0.79, 0, { scale: 2700, detail: 2, bump: 0.000025, roughnessVariation: 0.08 }),
  material('woven-shadow', [0.12, 0.098, 0.070, 1], 0.85),
  material('anodized-champagne', [0.53, 0.35, 0.17, 1], 0.27, 0.84, { scale: 2200, detail: 1, bump: 0.000012, roughnessVariation: 0.035 }),
  material('bright-edge', [0.59, 0.63, 0.65, 1], 0.2, 0.94),
  material('rubber', [0.009, 0.013, 0.016, 1], 0.76),
  material('cone-paper', [0.022, 0.024, 0.025, 1], 0.89),
  material('ink', [0.74, 0.68, 0.53, 1], 0.63),
  material('status-amber', [0.8, 0.19, 0.025, 1], 0.23, 0, null, { emissionColor: [1, 0.27, 0.035, 1], emissionStrength: 0.8 }),
  material('floor', [0.155, 0.18, 0.185, 1], 0.75),
]
function material(id, baseColor, roughness, metallic = 0, texture, extra = {}) {
  return { id, shader: 'principled', parameters: { baseColor, roughness, metallic, ...extra }, ...(texture ? { texture: { type: 'noise', ...texture } } : {}) }
}
function mesh(id, generator, materialId, location, rotationEuler = [0, 0, 0], scale = [1, 1, 1], extra = {}) {
  const entity = { id, type: 'generator', generator, materialId, transform: { location, rotationEuler, scale }, tags: ['hero-product'], ...extra }
  entities.push(entity)
  return entity
}
// Cube scaling is explicit: array offsets below are LOCAL distances before this scale.
function box(id, dimensions, location, materialId, radius = 0.004, segments = 6, extra = {}) {
  const size = dimensions[0]
  return mesh(id, { shape: radius ? 'rounded_box' : 'cube', size, ...(radius ? { bevel: { width: radius, segments } } : {}) }, materialId, location, [0, 0, 0], dimensions.map(n => n / size), extra)
}
function cylinder(id, radius, depth, location, materialId, rotation = FRONT, segments = 64, extra = {}) {
  return mesh(id, { shape: 'cylinder', radius, depth, segments }, materialId, location, rotation, [1, 1, 1], extra)
}
function lathe(id, profile, location, materialId, rotation = FRONT, segments = 96, closed = false, extra = {}) {
  return mesh(id, { shape: 'lathe', profile, segments, closedProfile: closed, capEnds: !closed }, materialId, location, rotation, [1, 1, 1], extra)
}
function ring(id, inner, outer, depth, location, materialId, rotation = FRONT, segments = 96) {
  const edge = Math.min(0.00045, (outer - inner) / 4, depth / 4)
  return lathe(id, [[inner, 0], [outer-edge, 0], [outer, edge], [outer, depth-edge], [outer-edge, depth], [inner+edge, depth], [inner, depth-edge]], location, materialId, rotation, segments, true)
}
function curve(id, path, radius, materialId, extra = {}) {
  return mesh(id, { shape: 'curve', path, radius, pathInterpolation: 'poly', curveResolution: 1, bevelResolution: 1, capEnds: true }, materialId, [0, 0, 0], [0, 0, 0], [1, 1, 1], extra)
}
const difference = id => ({ type: 'boolean', operation: 'difference', targetEntityId: id })
const intersect = id => ({ type: 'boolean', operation: 'intersect', targetEntityId: id })

// A real open cabinet: a 9 mm side-wall allowance, separate front lip, face plate and rear service opening.
box('shell-cavity-tool', [0.246, 0.115, 0.144], [0, 0, 0.095], 'rubber', 0.027, 10, { visible: false })
box('front-opening-tool', [0.213, 0.060, 0.120], [0, -0.070, 0.095], 'rubber', 0.023, 8, { visible: false })
box('rear-service-tool', [0.210, 0.046, 0.121], [0, 0.069, 0.095], 'rubber', 0.014, 8, { visible: false })
box('cabinet-shell', [0.264, 0.138, 0.162], [0, 0, 0.095], 'shell-porcelain', 0.032, 12, {
  modifiers: [difference('shell-cavity-tool'), difference('front-opening-tool'), difference('rear-service-tool')],
})
cylinder('front-driver-tool', 0.0555, 0.018, [-0.048, -0.071, 0.099], 'rubber', FRONT, 96, { visible: false })
box('front-baffle', [0.248, 0.006, 0.146], [0, -0.0705, 0.095], 'graphite', 0.025, 10, { modifiers: [difference('front-driver-tool')] })
box('front-gasket', [0.251, 0.0015, 0.149], [0, -0.067, 0.095], 'rubber', 0.025, 8, { modifiers: [difference('front-driver-tool')] })

// The cone remains behind a physically open weave; it must read as depth, not a printed circle.
lathe('driver-cone', [[0, 0.003], [0.010, 0.003], [0.020, 0.004], [0.037, 0.010], [0.049, 0.016], [0.053, 0.018], [0.054, 0.017], [0.054, 0.015], [0.048, 0.013], [0.021, 0.001], [0, 0]], [-0.048, -0.046, 0.099], 'cone-paper')
lathe('driver-dust-dome', [[0, 0.006], [0.004, 0.0058], [0.009, 0.0048], [0.013, 0.0030], [0.016, 0], [0.016, -0.001], [0, -0.001]], [-0.048, -0.057, 0.099], 'cone-paper')
ring('grille-gasket', 0.0535, 0.0615, 0.0025, [-0.048, -0.0733, 0.099], 'rubber')
ring('grille-metal-rim', 0.0538, 0.0605, 0.0055, [-0.048, -0.075, 0.099], 'anodized-champagne')
ring('grille-highlight-lip', 0.0534, 0.0541, 0.0008, [-0.048, -0.0799, 0.099], 'bright-edge')
cylinder('weave-boundary-tool', 0.05375, 0.009, [-0.048, -0.079, 0.099], 'rubber', FRONT, 96, { visible: false })

// 1.8 mm pitch, 0.64 mm yarn diameter. Alternating warp depth produces actual over/under crossings.
// These curves already use world-oriented local coordinates and unit scale; array offsets are literal metres.
const pitch = 0.0018, half = 0.0567, rows = 64
for (let phase = 0; phase < 2; phase++) {
  const path = Array.from({ length: rows }, (_, index) => [
    -0.048 - half + index * pitch,
    -0.079 + (index % 2 === phase ? 0.00070 : -0.00070),
    0.099 - half + phase * pitch,
  ])
  curve(`grille-warp-${phase}`, path, 0.00032, 'woven-sand', {
    modifiers: [{ type: 'array', count: 32, offset: [0, 0, 2 * pitch] }, intersect('weave-boundary-tool')],
  })
}
curve('grille-weft', [[-0.048-half, -0.079, 0.099-half], [-0.048-half, -0.079, 0.099+half]], 0.00032, 'woven-shadow', {
  modifiers: [{ type: 'array', count: 64, offset: [pitch, 0, 0] }, intersect('weave-boundary-tool')],
})

// The control assembly is a separate inset serviceable module, with a visible gasket and machined dial.
box('control-module-gasket', [0.0765, 0.0016, 0.124], [0.077, -0.0741, 0.096], 'rubber', 0.006, 6)
box('control-module', [0.0742, 0.003, 0.1215], [0.077, -0.0757, 0.096], 'graphite', 0.0058, 6)
ring('dial-seat', 0.019, 0.026, 0.002, [0.077, -0.0775, 0.112], 'rubber')
ring('dial-metal-seat', 0.020, 0.024, 0.0020, [0.077, -0.0784, 0.112], 'bright-edge')
lathe('volume-knob', [[0, 0], [0.019, 0], [0.021, 0.0007], [0.022, 0.0020], [0.022, 0.012], [0.0217, 0.0134], [0.0207, 0.0144], [0.0198, 0.0148], [0.001, 0.0148], [0, 0.0148]], [0.077, -0.079, 0.112], 'anodized-champagne', FRONT, 96)
ring('dial-face-inlay', 0.0181, 0.01855, 0.00018, [0.077, -0.09385, 0.112], 'bright-edge', FRONT, 96)
for (let index = 0; index < 44; index++) {
  const angle = index * 2 * Math.PI / 44
  const x = 0.077 + 0.02195 * Math.cos(angle), z = 0.112 + 0.02195 * Math.sin(angle)
  curve(`dial-knurl-${index.toString().padStart(2, '0')}`, [[x, -0.0818, z], [x, -0.0905, z]], 0.00029, 'bright-edge')
}
curve('dial-index', [[0.077, -0.0941, 0.125], [0.077, -0.0941, 0.130]], 0.00042, 'rubber')
for (let index = 0; index < 11; index++) {
  const angle = (225 - index * 27) * Math.PI / 180
  const r = index % 5 === 0 ? 0.0292 : 0.0307
  curve(`scale-tick-${index.toString().padStart(2, '0')}`, [r, 0.0326].map(radius => [0.077 + radius * Math.cos(angle), -0.0775, 0.112 + radius * Math.sin(angle)]), 0.00033, 'ink')
}
// Two input keys and three indicator lenses. The middle lit point remains subordinate to the dial.
for (const [index, x] of [[0, 0.061], [1, 0.092]]) {
  ring(`input-key-seat-${index}`, 0.0040, 0.0052, 0.001, [x, -0.0774, 0.056], 'rubber', FRONT, 48)
  lathe(`input-key-${index}`, [[0, 0], [0.0041, 0], [0.0041, 0.0017], [0.0038, 0.0021], [0, 0.0021]], [x, -0.078, 0.056], 'anodized-champagne', FRONT, 48)
}
for (let index = 0; index < 3; index++) {
  cylinder(`status-lens-${index}`, 0.00115, 0.0005, [0.069 + 0.008 * index, -0.07755, 0.041], index === 1 ? 'status-amber' : 'rubber', FRONT, 24)
}
ring('top-button-gasket', 0.0063, 0.0076, 0.001, [0.071, -0.010, 0.175], 'rubber', [0, 0, 0], 48)
lathe('top-button', [[0, 0], [0.0062, 0], [0.0062, 0.0026], [0.0057, 0.0032], [0, 0.0032]], [0.071, -0.010, 0.175], 'anodized-champagne', [0, 0, 0], 64)

// Rear service plate, real ventilation slots, captive fasteners and recessed input socket.
const vent = box('rear-vent-tool', [0.0038, 0.020, 0.019], [-0.072, 0.068, 0.111], 'rubber', 0.0017, 4, { visible: false })
vent.modifiers = [{ type: 'array', count: 9, offset: [0.018, 0, 0] }]
box('rear-panel-gasket', [0.207, 0.002, 0.118], [0, 0.064, 0.095], 'rubber', 0.013, 8, { modifiers: [difference('rear-vent-tool')] })
box('rear-service-panel', [0.204, 0.004, 0.114], [0, 0.067, 0.095], 'graphite', 0.012, 8, { modifiers: [difference('rear-vent-tool')] })
for (const x of [-0.087, 0.087]) for (const z of [0.052, 0.138]) {
  const suffix = `${x < 0 ? 'l' : 'r'}-${z < 0.1 ? 'b' : 't'}`
  const slot = box(`screw-slot-tool-${suffix}`, [0.0031, 0.0016, 0.00065], [x, 0.07095, z], 'rubber', 0, 1, { visible: false })
  lathe(`rear-screw-${suffix}`, [[0, 0], [0.0025, 0], [0.0027, 0.0008], [0.0025, 0.0015], [0, 0.0015]], [x, 0.0695, z], 'bright-edge', REAR, 32, false, { modifiers: [difference(slot.id)] })
}
ring('input-jack-rim', 0.0036, 0.0060, 0.0030, [-0.045, 0.0692, 0.066], 'anodized-champagne', REAR, 64)
cylinder('input-jack-dark', 0.0036, 0.0005, [-0.045, 0.0693, 0.066], 'rubber', REAR, 48)
ring('power-socket-grommet', 0.0032, 0.0055, 0.003, [0.045, 0.0692, 0.066], 'rubber', REAR, 64)
cylinder('power-plug', 0.0034, 0.011, [0.045, 0.079, 0.066], 'graphite', REAR, 48)
curve('power-cable', [[0.045, 0.085, 0.066], [0.045, 0.099, 0.065], [0.053, 0.123, 0.053], [0.071, 0.140, 0.028], [0.098, 0.143, 0.008], [0.127, 0.144, 0.0024], [0.165, 0.167, 0.0024]], 0.0023, 'rubber')
entities.at(-1).generator.pathInterpolation = 'bezier'
entities.at(-1).generator.curveResolution = 8
entities.at(-1).generator.bevelResolution = 3
// Small debossed identification bars; no invented brand or unreadable microtext.
for (let index = 0; index < 3; index++) box(`rear-label-rule-${index}`, [0.030 - index * 0.006, 0.00025, 0.00065], [0, 0.0693, 0.060 - index * 0.004], 'ink', 0)

for (const x of [-0.085, 0.085]) for (const y of [-0.047, 0.047]) {
  lathe(`foot-${x < 0 ? 'l' : 'r'}-${y < 0 ? 'f' : 'b'}`, [[0, 0], [0.0135, 0], [0.016, 0.0015], [0.017, 0.004], [0.017, 0.009], [0.0155, 0.0145], [0, 0.0145]], [x, y, 0], 'rubber', [0, 0, 0], 48)
}
mesh('studio-floor', { shape: 'plane', size: 4 }, 'floor', [0, 0, -0.0001], [0, 0, 0], [1, 1, 1], { tags: ['environment'], locked: true })

function aim(from, at) {
  const d = from.map((n, i) => n - at[i])
  return [Math.atan2(Math.hypot(d[0], d[1]), d[2]), 0, Math.atan2(d[0], -d[1])]
}
function area(id, location, energy, size, color, target = [0, 0, 0.085]) {
  return { id, type: 'area', energy, size, color, transform: { location, rotationEuler: aim(location, target) } }
}
const scene = clean({
  schemaVersion: 'deepblend.scene/v1',
  project: { id: 'benchmark-modular-speaker', title: 'Cairn 264 — modular desktop speaker', goal: 'Original 264 mm desktop speaker with a rounded serviceable cabinet, physically woven grille, machined controls and restrained studio lighting.', units: 'metric', fps: 24, frameStart: 1, frameEnd: 48, aspectRatio: '4:3', activeCamera: 'hero' },
  world: { color: [0.10, 0.13, 0.16, 1], strength: 0.22 },
  assets: [], materials, entities,
  lights: [
    area('key-softbox', [-0.28, -0.34, 0.48], 8.5, 0.34, [1, 0.91, 0.80, 1]),
    area('fill-softbox', [0.32, -0.25, 0.26], 2.8, 0.30, [0.77, 0.86, 1, 1]),
    area('rear-strip', [0.12, 0.32, 0.43], 11.5, 0.23, [1, 0.95, 0.86, 1]),
    area('rear-corner-fill', [-0.35, 0.25, 0.30], 1, 0.40, [0.90, 0.95, 1, 1], [0, 0, 0.09]),
  ],
  cameras: [
    { id: 'hero', role: 'active-camera', lens: 62, sensorWidth: 36, clipping: [0.001, 100], transform: { location: [0.37, -0.61, 0.32] }, targetPoint: [0, 0, 0.085] },
    { id: 'detail', role: 'detail', lens: 70, sensorWidth: 36, clipping: [0.001, 100], transform: { location: [0.15, -0.35, 0.19] }, targetPoint: [0.035, -0.072, 0.105] },
    { id: 'reverse', role: 'three-quarter', lens: 62, sensorWidth: 36, clipping: [0.001, 100], transform: { location: [-0.35, 0.56, 0.29] }, targetPoint: [0.01, 0.025, 0.085] },
    { id: 'motion-detail', role: 'detail', lens: 85, sensorWidth: 36, clipping: [0.001, 100], transform: { location: [0.102, -0.074, 0.217] }, targetPoint: [0.071, -0.010, 0.1766] },
  ],
  shots: [{ id: 'hero-shot', cameraId: 'hero', frameRange: [1, 48], description: 'Locked product study; the top button makes a 0.7 mm press and returns while every other component remains assembled.' }],
  animationTracks: [{ id: 'button-press', targetEntityId: 'top-button', property: 'location.z', keyframes: [{ frame: 1, value: 0.175, interpolation: 'linear' }, { frame: 24, value: 0.1743, interpolation: 'linear' }, { frame: 48, value: 0.175, interpolation: 'linear' }] }],
  renderProfiles: {
    preview: { engine: 'cycles', resolution: [768, 576], samples: 64, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 }, maxSamplesBudget: 128 },
    final: { engine: 'cycles', resolution: [1024, 768], samples: 128, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 }, maxSamplesBudget: 256 },
  },
})

// A simultaneous ablation, NOT a previous release. Layout, animation, cameras and illumination stay fixed.
const baseline = structuredClone(scene)
baseline.project.title = 'Cairn 264 — geometry and material ablation'
baseline.project.goal = 'Controlled simplification of this benchmark, not a historical version: same transforms, cameras, lighting and exposure; coarse geometry and uniform product material.'
baseline.materials = baseline.materials.map(entry => entry.id === 'floor' ? entry : material(entry.id, [0.25, 0.25, 0.25, 1], 0.52))
for (const entity of baseline.entities) {
  delete entity.modifiers
  // Keep this assembly opening: a solid box otherwise shares the rear panel's outer face.
  if (entity.id === 'cabinet-shell') entity.modifiers = [difference('rear-service-tool')]
  delete entity.generator.bevel
  if (entity.generator.shape === 'rounded_box') entity.generator.shape = 'cube'
  if (entity.generator.shape === 'lathe') {
    const profile = entity.generator.profile
    const z = profile.map(point => point[1]), r = Math.max(...profile.map(point => point[0]))
    entity.generator = { shape: 'lathe', segments: 16, capEnds: true, profile: [[0, Math.min(...z)], [r, Math.min(...z)], [r, Math.max(...z)], [0, Math.max(...z)]] }
  }
  if (entity.id.startsWith('grille-warp') || entity.id === 'grille-weft' || entity.id.startsWith('dial-knurl') || entity.id.startsWith('scale-tick') || entity.id === 'grille-highlight-lip' || entity.id === 'dial-face-inlay') entity.visible = false
}
baseline.entities.push({ id: 'grille-ablation-disc', type: 'generator', generator: { shape: 'cylinder', radius: 0.05375, depth: 0.001, segments: 32 }, materialId: 'woven-sand', transform: { location: [-0.048, -0.079, 0.099], rotationEuler: FRONT, scale: [1, 1, 1] }, tags: ['hero-product', 'ablation'] })

for (const [name, document] of [['scene-spec.json', scene], ['baseline-scene-spec.json', clean(baseline)]]) {
  const checked = validateSceneSpec(document)
  assert.equal(checked.ok, true, `${name}: ${JSON.stringify(checked.errors, null, 2)}`)
  const compiled = compileSceneSpec(document)
  assert.equal(compiled.spec.entities.length, document.entities.length)
  const text = `${JSON.stringify(document, null, 2)}\n`
  if (process.argv.includes('--check')) assert.equal(readFileSync(join(OUT, name), 'utf8'), text, `${name} differs from its deterministic builder`)
  else writeFileSync(join(OUT, name), text)
  console.log(`${name}: validate=true; compile=true; entities=${document.entities.length}; materials=${document.materials.length}; notices=${checked.notices.length}`)
}
assert.deepEqual(scene.cameras, baseline.cameras)
assert.deepEqual(scene.lights, baseline.lights)
assert.deepEqual(scene.world, baseline.world)
assert.deepEqual(scene.renderProfiles, baseline.renderProfiles)
assert.deepEqual(scene.animationTracks, baseline.animationTracks)
assert.deepEqual(scene.shots, baseline.shots)
for (const entity of scene.entities) assert.deepEqual(entity.transform, baseline.entities.find(item => item.id === entity.id).transform)
assert.equal(scene.animationTracks.length, 1)
assert.equal(scene.animationTracks[0].targetEntityId, 'top-button')
console.log('Ablation cameras, transforms, light, exposure and motion: identical. Only top-button moves, 0.7 mm maximum.')
