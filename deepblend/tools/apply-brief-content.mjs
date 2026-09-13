/**
 * Carry `watch-commercial` from the generated demo (r0018) to the scene the brief
 * actually asks for (r0023), through the REAL Host transaction.
 *
 *   node deepblend/tools/apply-brief-content.mjs            # apply
 *   node deepblend/tools/apply-brief-content.mjs --dry-run  # predict digests only
 *
 * WHY THIS EXISTS. `.deepblend/` is deliberately not committed, and the note in
 * `.gitignore` justifies that by saying the two things that make it reproducible
 * ARE committed: the fixture SceneSpec and `create-demo-project.mjs`. That was
 * true until M2's content was finished — the generator only reaches r0002, so the
 * five revisions that express SPEC.md:150 lived only in one uncommitted store and
 * would have been lost with it. This script restores the invariant the ignore file
 * claims.
 *
 * It is idempotent and self-verifying: every step asserts the SceneSpec digest that
 * the live store recorded when the revision was first committed, so a run that
 * silently diverges fails instead of committing something subtly different.
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const WORK = join(ROOT, '.deepblend')
const PROJECT = 'watch-commercial'
const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Where the Project Store lives. Overridable so the recorded digests can be
 * re-verified against a scratch copy of the store instead of the operator's own
 * project — the only honest way to test "this script reproduces r0019–r0023".
 */
const rootFlag = process.argv.indexOf('--projects-root')
const PROJECTS_ROOT = rootFlag >= 0 && process.argv[rootFlag + 1]
  ? resolve(process.argv[rootFlag + 1])
  : join(WORK, 'projects')

/** The base the recorded operations were computed against. */
const BASE_REVISION = 'r0018'

const HOLD_OUT = 450 // 15 s at 30 fps
const ORBIT_START = 30
const ORBIT_END = 390
const SEGMENTS = 24 // one 15-degree chord per segment: 0.85% radial error

/** Round the way the recorded revisions were rounded, so digests match. */
const R = value => Number(value.toFixed(9))

function orbitMath() {
  const step = (ORBIT_END - ORBIT_START) / SEGMENTS
  const frames = [1, ORBIT_START]
  for (let k = 1; k <= SEGMENTS; k += 1) frames.push(ORBIT_START + k * step)
  frames.push(HOLD_OUT)
  const thetaAt = f => (f <= ORBIT_START ? 0
    : f >= ORBIT_END ? 2 * Math.PI
      : ((f - ORBIT_START) / (ORBIT_END - ORBIT_START)) * 2 * Math.PI)
  return { frames, thetaAt }
}
const { frames: FRAMES, thetaAt: THETA_AT } = orbitMath()

/**
 * Rotation AND orbital translation.
 *
 * A part rotates about its OWN origin, so rotation alone spins every part in
 * place: at 90 degrees the case turns edge-on while the markers and the crown
 * stay where they were and read as detached debris. A rigid turntable therefore
 * also needs each off-axis part's position carried around the common (0, 0) axis
 * (ADR D42).
 */
function turntableOps(parts, { withShot = true } = {}) {
  const operations = [
    { op: 'project.frameRange.set', frameStart: 1, frameEnd: HOLD_OUT, fps: 30 },
  ]
  // r0023 was committed without re-asserting the shot range, and the operation
  // ledger is an audit record: reproducing the revision means reproducing what was
  // asked for, not only what it produced.
  if (withShot) {
    operations.push({ op: 'shot.set', shot: {
      id: 'shot-turntable',
      cameraId: 'camera-main',
      frameRange: [1, HOLD_OUT],
      description: 'Product turntable: one full orbit.',
    } })
  }
  for (const part of parts) {
    operations.push({ op: 'animation.track.set', track: {
      id: part.trackId,
      targetEntityId: part.id,
      property: 'rotationEuler.z',
      keyframes: FRAMES.map(f => ({ frame: f, value: R(THETA_AT(f)), interpolation: 'linear' })),
    } })
    if (part.x === 0 && part.y === 0) continue
    operations.push({ op: 'animation.track.set', track: {
      id: `${part.trackId}-orbit-x`,
      targetEntityId: part.id,
      property: 'location.x',
      keyframes: FRAMES.map(f => {
        const a = THETA_AT(f)
        return { frame: f, value: R(part.x * Math.cos(a) - part.y * Math.sin(a)), interpolation: 'linear' }
      }),
    } })
    operations.push({ op: 'animation.track.set', track: {
      id: `${part.trackId}-orbit-y`,
      targetEntityId: part.id,
      property: 'location.y',
      keyframes: FRAMES.map(f => {
        const a = THETA_AT(f)
        return { frame: f, value: R(part.x * Math.sin(a) + part.y * Math.cos(a)), interpolation: 'linear' }
      }),
    } })
  }
  return operations
}

/** Hold, then grow, then hold. Scale keyframes are absolute values, never multipliers. */
function ramp(trackId, targetEntityId, property, from, to, start, end) {
  return { id: trackId, targetEntityId, property, keyframes: [
    { frame: 1, value: R(from), interpolation: 'linear' },
    { frame: start, value: R(from), interpolation: 'linear' },
    { frame: end, value: R(to), interpolation: 'ease_in_out' },
    { frame: HOLD_OUT, value: R(to), interpolation: 'linear' },
  ] }
}

/** Depth of the lit screen and of the markers it must sit behind (ADR D45). */
/**
 * Depth of the lit screen (ADR D45). r0021 committed it at -0.005, which is *inside*
 * the 4 mm dial cylinder; r0022 re-seats it in the 0.75 mm gap between the dial face
 * (-0.00625) and the marker fronts. The two values are separate on purpose.
 */
const SCREEN_Y_AT_R0021 = -0.005
const SCREEN_Y_AT_R0022 = -0.0066
/**
 * The markers sit on the dial face until r0023 moves them forward. Keeping this a
 * parameter is not tidiness: r0020 was committed with the markers still at
 * -0.00655, and reusing r0023's depth for it produces a different SceneSpec — which
 * the digest assertion below caught the first time this script was run.
 */
const MARKER_Y_AT_R0020 = -0.00655
const MARKER_Y_AT_R0023 = -0.0076

const rotatingParts = markerY => [
  { id: 'watch-body', trackId: 'watch-turntable', x: 0, y: 0 },
  { id: 'watch-dial', trackId: 'dial-turntable', x: 0, y: -0.00425 },
  { id: 'watch-crown', trackId: 'crown-turntable', x: 0.0235, y: 0 },
  { id: 'index-twelve', trackId: 'index-twelve-turntable', x: 0, y: markerY },
  { id: 'index-three', trackId: 'index-three-turntable', x: 0.012, y: markerY },
  { id: 'index-six', trackId: 'index-six-turntable', x: 0, y: markerY },
  { id: 'index-nine', trackId: 'index-nine-turntable', x: -0.012, y: markerY },
]

const STEPS = [
  {
    label: 'r0019  black background',
    digest: 'd6e48e0b6427772571e35f39874912d690b1a31d822ae1ce5b176f98b0e81bae',
    note: 'Black background for the SPEC 2.1 brief: albedo 0 kills the diffuse lobe and ior 1 kills the Fresnel specular sheen that left the near-black backdrop reading as mid-grey (measured 96,96,104).',
    operations: () => [
      { op: 'material.parameter.update', materialId: 'backdrop-matte', parameter: 'baseColor', value: [0, 0, 0, 1] },
      { op: 'material.parameter.update', materialId: 'backdrop-matte', parameter: 'ior', value: 1 },
      { op: 'material.parameter.update', materialId: 'stage-matte', parameter: 'baseColor', value: [0, 0, 0, 1] },
      { op: 'material.parameter.update', materialId: 'stage-matte', parameter: 'ior', value: 1 },
    ],
  },
  {
    label: 'r0020  15 s timeline and a real turntable',
    digest: '52a10dfeef50eceb84000b088d7ae8981d15980ab586ad7ad169d78ec2f8845a',
    note: '15 s timeline and a real turntable: each part keeps its rotation track and gains the orbital location tracks that carry it around the common axis, so the assembly stays rigid instead of disintegrating at 90/270 degrees.',
    operations: () => turntableOps(rotatingParts(MARKER_Y_AT_R0020)),
  },
  {
    label: 'r0021  dial lights up, brand mark closes',
    digest: 'b001e0c7fe03ea24d48e923d79c95ebc86e50fc58bea9ad5935ede30755d804e',
    note: 'Dial lights up progressively and the brand mark closes the shot. SceneSpec v1 animates entity transforms only, so the screen and the mark are emissive geometry that scales in rather than materials that ramp.',
    operations: () => {
      const operations = [
        { op: 'material.add', material: { id: 'dial-screen', shader: 'emission', parameters: {
          emissionColor: [0.22, 0.52, 0.95, 1], emissionStrength: 1.6 } } },
        { op: 'entity.add', entity: {
          id: 'dial-screen', type: 'generator', materialId: 'dial-screen',
          generator: { shape: 'cylinder', radius: 0.0165, depth: 0.0004, segments: 64 },
          transform: { location: [0, SCREEN_Y_AT_R0021, 0.021], rotationEuler: [Math.PI / 2, 0, 0], scale: [1, 1, 1] },
          tags: ['detail', 'screen', 'subject-part'] } },
        { op: 'material.add', material: { id: 'logo-emissive', shader: 'emission', parameters: {
          emissionColor: [0.78, 0.88, 1, 1], emissionStrength: 3 } } },
        { op: 'entity.add', entity: {
          id: 'logo-ring', type: 'generator', materialId: 'logo-emissive',
          generator: { shape: 'torus', majorRadius: 0.009, minorRadius: 0.0008, segments: 48, ringCount: 16 },
          transform: { location: [0, -0.0085, 0.021], rotationEuler: [Math.PI / 2, 0, 0], scale: [1, 1, 1] },
          tags: ['brand'] } },
        { op: 'entity.add', entity: {
          id: 'logo-hand', type: 'generator', materialId: 'logo-emissive',
          generator: { shape: 'cylinder', radius: 0.00045, depth: 0.009, segments: 24 },
          transform: { location: [0, -0.0085, 0.0235], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
          tags: ['brand'] } },
      ]
      for (const axis of ['x', 'y', 'z']) {
        operations.push({ op: 'animation.track.set', track: ramp(`dial-screen-scale-${axis}`, 'dial-screen', `scale.${axis}`, 0.001, 1, 300, 390) })
      }
      operations.push({ op: 'animation.track.set', track: {
        id: 'dial-screen-orbit-x', targetEntityId: 'dial-screen', property: 'location.x',
        keyframes: FRAMES.map(f => ({ frame: f, value: R(-SCREEN_Y_AT_R0021 * Math.sin(THETA_AT(f))), interpolation: 'linear' })) } })
      operations.push({ op: 'animation.track.set', track: {
        id: 'dial-screen-orbit-y', targetEntityId: 'dial-screen', property: 'location.y',
        keyframes: FRAMES.map(f => ({ frame: f, value: R(SCREEN_Y_AT_R0021 * Math.cos(THETA_AT(f))), interpolation: 'linear' })) } })
      operations.push({ op: 'animation.track.set', track: {
        id: 'dial-screen-turntable', targetEntityId: 'dial-screen', property: 'rotationEuler.z',
        keyframes: FRAMES.map(f => ({ frame: f, value: R(THETA_AT(f)), interpolation: 'linear' })) } })
      for (const [id, start, end] of [['index-twelve', 90, 150], ['index-three', 130, 190], ['index-six', 170, 230], ['index-nine', 210, 270]]) {
        operations.push({ op: 'animation.track.set', track: ramp(`${id}-ignite`, id, 'scale.z', 0.02, 2.6, start, end) })
      }
      for (const id of ['logo-ring', 'logo-hand']) {
        for (const axis of ['x', 'y', 'z']) {
          operations.push({ op: 'animation.track.set', track: ramp(`${id}-reveal-${axis}`, id, `scale.${axis}`, 0.001, 1, 405, 432) })
        }
      }
      return operations
    },
  },
  {
    label: 'r0022  re-seat the lit screen',
    digest: '7f33d649aa9a8db9f54341ba607db45dacb39bc137760933d9e2f0fffccbf2a7',
    note: 'Re-seat the lit dial screen at y=-0.0066. The dial is a 4 mm disc whose front face is at -0.00625, so the screen at -0.005 was buried inside it; the markers\' front faces are at -0.007, leaving a 0.75 mm gap for the screen.',
    operations: () => [
      { op: 'entity.transform.update', entityId: 'dial-screen', location: [0, SCREEN_Y_AT_R0022, 0.021] },
      { op: 'animation.track.set', track: {
        id: 'dial-screen-orbit-x', targetEntityId: 'dial-screen', property: 'location.x',
        keyframes: FRAMES.map(f => ({ frame: f, value: R(-SCREEN_Y_AT_R0022 * Math.sin(THETA_AT(f))), interpolation: 'linear' })) } },
      { op: 'animation.track.set', track: {
        id: 'dial-screen-orbit-y', targetEntityId: 'dial-screen', property: 'location.y',
        keyframes: FRAMES.map(f => ({ frame: f, value: R(SCREEN_Y_AT_R0022 * Math.cos(THETA_AT(f))), interpolation: 'linear' })) } },
    ],
  },
  {
    label: 'r0023  markers move in front of the screen',
    digest: '4d3c9a2505780265cb4e5a9b382f049053d8a8faab6032a2da5c2b2d06d69e12',
    note: 'Move the four index markers 1.05 mm forward, from y=-0.00655 to y=-0.0076. They are only 0.3 mm thick and sat directly on the dial face at y=-0.00625, so the lit screen had nowhere to go behind them and covered them instead.',
    operations: () => turntableOps(rotatingParts(MARKER_Y_AT_R0023).slice(3), { withShot: false }),
  },
]

if (DRY_RUN) {
  for (const step of STEPS) console.log(`${step.label.padEnd(46)} ${step.operations().length} operations -> ${step.digest.slice(0, 16)}`)
  console.log('\n(dry run: nothing was written; digests are the ones the live store recorded)')
  process.exit(0)
}

const ctx = new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
  blenderPath: join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender'),
  bootstrapPath: join(ROOT, 'packages/deepblend/provider-local/python/bootstrap.py'),
  workspaceRoot: WORK,
})
ctx.plugin((await import('@deepblend/dsh-blender-host')).default, {
  projectsRoot: PROJECTS_ROOT,
  workspaceRoot: WORK,
  serveCachedCapabilities: true,
  maxPreviewSamples: 512,
})
await new Promise(r => setTimeout(r, 250))

const studio = ctx.get('blenderStudio')
const project = await studio.getProject(PROJECT)
let current = project.currentRevision
console.log(`${PROJECT} is at ${current}`)

if (current !== BASE_REVISION) {
  const already = STEPS.some(step => step.digest === project.revision?.digest)
  console.log(already
    ? 'this project already carries the brief content — nothing to do.'
    : `refusing to run: the recorded operations were computed against ${BASE_REVISION}, and this project is at ${current}.`)
  await ctx.stop?.()
  process.exit(already ? 0 : 1)
}

for (const step of STEPS) {
  const committed = await studio.applyScenePatch({
    projectId: PROJECT,
    baseRevision: current,
    operations: step.operations(),
    note: step.note,
  })
  const digest = committed.digest
  const ok = digest === step.digest
  console.log(`${step.label.padEnd(46)} ${committed.revision}  ${digest.slice(0, 16)}  ${ok ? 'digest OK' : 'DIGEST MISMATCH'}`)
  if (!ok) {
    console.error(`\nexpected ${step.digest}\n     got ${digest}`)
    console.error('The store no longer reproduces the recorded content. Stopping rather than continuing on a diverged base.')
    await ctx.stop?.()
    process.exit(1)
  }
  current = committed.revision
}

console.log(`\n${PROJECT} is now at ${current}: 15 s, black background, product turntable, dial lighting up, brand mark.`)
console.log('Render it with blender_visual_review, or roll back with blender_revision_restore.')

await ctx.stop?.()
