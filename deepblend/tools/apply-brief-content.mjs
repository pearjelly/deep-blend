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
import { readFileSync } from 'node:fs'
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
  // ---------------------------------------------------------------------------
  // The three steps below exercise the capabilities that did NOT exist when the
  // revisions above were written (ADRs D43/D44). A mechanism nothing uses is a
  // defect by this repository's own rule, so the project stops working around them:
  // the background becomes the scene world, the dial ramps on its own material, and
  // the camera orbits instead of the product turning.
  // ---------------------------------------------------------------------------
  {
    label: 'r0024  the world is the background, not a plane',
    digest: '51f62906e0c342190b7e865a15ef50db22502821f0ad9a97dc9fc27ccf4ccbdd',
    note: 'The background is the scene world now, not a backdrop plane. r0019 could only make it black by zeroing the plane material, because the World was a constant inside the compiler and no operation could reach it.',
    operations: () => [
      { op: 'world.set', world: { color: [0, 0, 0, 1], strength: 0 } },
      // The plane existed to be the background. With the world doing that job it is an
      // invisible surface between the product and the environment the metal reflects.
      { op: 'entity.remove', entityId: 'backdrop' },
    ],
  },
  {
    label: 'r0025  the dial ramps on its own material',
    digest: 'f3d76072517ec284fd9b7e12c76d7fafd1406dae369eb44a0734a30f43821895',
    note: 'The dial lights up by ramping emissionStrength on dial-glass, which is what the brief asks for and what was inexpressible before: a track could only move entity transforms, so the screen had to be a disc that grew. The disc is removed with its tracks.',
    operations: () => [
      { op: 'animation.track.set', track: {
        id: 'dial-ramp', targetKind: 'material', targetEntityId: 'dial-glass', property: 'emissionStrength',
        keyframes: [
          { frame: 1, value: 0, interpolation: 'linear' },
          { frame: 300, value: 0, interpolation: 'linear' },
          { frame: 390, value: 2.4, interpolation: 'ease_in_out' },
          { frame: HOLD_OUT, value: 2.4, interpolation: 'linear' },
        ],
      } },
      // Tracks first: an entity an animation still targets cannot be removed, and that
      // refusal is the point.
      ...['dial-screen-scale-x', 'dial-screen-scale-y', 'dial-screen-scale-z',
        'dial-screen-orbit-x', 'dial-screen-orbit-y', 'dial-screen-turntable']
        .map(trackId => ({ op: 'animation.track.remove', trackId })),
      { op: 'entity.remove', entityId: 'dial-screen' },
    ],
  },
  {
    label: 'r0026  the camera orbits, the product stands still',
    digest: '950ff84c9ec2bc128efbaa5fcb6a288010f224584d7e0847f35a8644f793fde1',
    note: 'The brief asks for the camera to orbit the product. That is expressible now, so the product turntable is retired: the part motion goes and the hero camera orbits instead, which also keeps the lighting fixed relative to the product.',
    operations: () => {
      const turning = []
      for (const part of rotatingParts(MARKER_Y_AT_R0023)) {
        turning.push(part.trackId)
        if (part.x === 0 && part.y === 0) continue
        turning.push(`${part.trackId}-orbit-x`, `${part.trackId}-orbit-y`)
      }
      const operations = [
        // Removing a track restores the entity's AUTHORED rotation, and for two markers
        // the authored value is not what the track was rendering: the turntable had
        // overridden their `z` to 0, so it has to be authored explicitly or they would
        // swing a quarter turn the moment the track disappeared.
        { op: 'entity.transform.update', entityId: 'index-three', rotationEuler: [0, Math.PI / 2, 0] },
        { op: 'entity.transform.update', entityId: 'index-nine', rotationEuler: [0, Math.PI / 2, 0] },
        ...turning.map(trackId => ({ op: 'animation.track.remove', trackId })),
      ]
      // The camera orbits the radius it already sits at, so the framing is unchanged
      // and only the angle moves.
      const radius = 0.19
      const orbit = (property, valueAt) => ({ op: 'animation.track.set', track: {
        id: `camera-orbit-${property.replace('.', '-')}`,
        targetKind: 'camera',
        targetEntityId: 'camera-main',
        property,
        keyframes: FRAMES.map(frame => ({ frame, value: R(valueAt(THETA_AT(frame))), interpolation: 'linear' })),
      } })
      operations.push(orbit('location.x', angle => radius * Math.sin(angle)))
      operations.push(orbit('location.y', angle => -radius * Math.cos(angle)))
      operations.push(orbit('rotationEuler.z', angle => angle))
      return operations
    },
  },
  {
    label: 'r0027  rebalance the lights for an orbiting camera',
    digest: 'facab0061cfe50c616861026a80bbaa7125c2f2b2e8799f37f4560e4ed9d7d3a',
    note: 'Drop the rim light from 24 to 6. The backdrop plane at y=0.25 used to block it, so it was the strongest light in the scene and lit almost nothing; removing that plane in r0024 unblocked it, and because the camera now orbits a full turn, every fixed light eventually becomes a frontal key. At the sampled frame 151 the camera sits at y=+0.098 and the rim light blew out 21.6% of the subject pixels.',
    operations: () => [
      { op: 'light.update', lightId: 'rim-light', energy: 6 },
    ],
  },
  {
    label: 'r0028  spread the case highlight',
    digest: '3c40651108fab76f91b2a667fbd87e5b46d44b073cf1758b22963d137cf40753',
    note: 'Raise hero-steel roughness from 0.22 to 0.38 and ease the dial ramp to 1.9. At the sampled frame 151 the case is nearly edge-on and its mirror-like finish reflected a light straight back as a blown white strip covering 19% of the subject pixels; a brushed-steel watch is not a mirror. The dial ramp keeps its range but gains margin under the clipping limit.',
    operations: () => [
      { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.38 },
      { op: 'animation.track.set', track: {
        id: 'dial-ramp', targetKind: 'material', targetEntityId: 'dial-glass', property: 'emissionStrength',
        keyframes: [
          { frame: 1, value: 0, interpolation: 'linear' },
          { frame: 300, value: 0, interpolation: 'linear' },
          { frame: 390, value: 1.9, interpolation: 'ease_in_out' },
          { frame: HOLD_OUT, value: 1.9, interpolation: 'linear' },
        ],
      } },
    ],
  },
  {
    label: 'r0029  give the metal a diffuse base and calm the lights',
    digest: 'fa8ec014ddc1743eba15a19c28c6f18531c3457b73b6b62fb311e7779577b758',
    note: 'hero-steel metallic 0.94 -> 0.55 with roughness 0.25, key/fill/rim 11/4/6 -> 5/1.8/2.7, and the dial ramp eased to 1.4. A near-mirror metal under three large lights has a binary specular band: measured over the four sampled frames, the clipped fraction sat at 0.185-0.188 for every light scale down to 0.45 and only collapsed at 0.30, which would have left frames 1 and 300 at 0.19 - a hair above the 0.18 underexposure floor. Giving the surface a diffuse base instead keeps every frame mid-range with the clipping gone.',
    operations: () => [
      { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'metallic', value: 0.55 },
      { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.25 },
      { op: 'light.update', lightId: 'key-light', energy: 5 },
      { op: 'light.update', lightId: 'fill-light', energy: 1.8 },
      { op: 'light.update', lightId: 'rim-light', energy: 2.7 },
      { op: 'animation.track.set', track: {
        id: 'dial-ramp', targetKind: 'material', targetEntityId: 'dial-glass', property: 'emissionStrength',
        keyframes: [
          { frame: 1, value: 0, interpolation: 'linear' },
          { frame: 300, value: 0, interpolation: 'linear' },
          { frame: 390, value: 1.4, interpolation: 'ease_in_out' },
          { frame: HOLD_OUT, value: 1.4, interpolation: 'linear' },
        ],
      } },
    ],
  },
]

/**
 * Which step a project at `digest` should continue from.
 *
 * Resumable rather than "r0018 or nothing": the later steps were added after the
 * project had already reached r0023, and a tool that can only replay the whole chain
 * would force a rebuild to add one revision. A step whose recorded digest IS the
 * current digest has been applied, so the next one is where to start.
 */
function firstPendingStep(currentDigest) {
  const at = STEPS.findIndex(step => step.digest !== null && step.digest === currentDigest)
  return at + 1
}

if (DRY_RUN) {
  // Validate offline, against the real spec, before anything touches the store. A dry
  // run that only counted operations would still let a schema error through.
  const { validateScenePatch, applyPatchToSpec } = await import('@deepblend/dsh-blender-contracts')
  const base = JSON.parse(readFileSync(join(WORK, 'projects', PROJECT, 'revisions', 'r0018', 'scene-spec.json'), 'utf8'))
  let spec = base
  let failed = 0
  for (const step of STEPS) {
    const operations = step.operations()
    const patch = { projectId: PROJECT, baseRevision: 'r0018', operations }
    const structural = validateScenePatch(patch)
    let detail = `${String(operations.length).padStart(2)} operations`
    if (!structural.ok) {
      detail += `  INVALID: ${structural.errors.map(error => `${error.code} ${error.path}`).join(', ')}`
      failed += 1
    } else {
      try {
        spec = applyPatchToSpec(spec, patch).spec
        detail += `  valid  digest ${step.digest === null ? '(not recorded yet)' : step.digest.slice(0, 16)}`
      } catch (cause) {
        detail += `  REFUSED: ${cause.patchIssue?.code ?? 'throw'} ${cause.message}`
        failed += 1
      }
    }
    console.log(`${step.label.padEnd(46)} ${detail}`)
  }
  console.log(failed === 0
    ? '\n(dry run: every step validates; nothing was written)'
    : `\n(dry run: ${failed} step(s) would fail)`)
  process.exit(failed === 0 ? 0 : 1)
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

// `getProject` reports the digest under `scene`, not `revision`: the revision is a
// string there, and reading `.revision.digest` off it silently yields undefined —
// which made the resume check refuse every project, for the wrong reason.
const start = firstPendingStep(project.scene?.digest)
if (start >= STEPS.length) {
  console.log('this project already carries every recorded step — nothing to do.')
  await ctx.stop?.()
  process.exit(0)
}
if (start === 0 && current !== BASE_REVISION) {
  console.log(
    `refusing to run: the chain starts from ${BASE_REVISION}, and this project is at ${current} ` +
    'with a digest that matches no recorded step. Rebuild it from the fixture, or restore the revision ' +
    'the chain expects.',
  )
  await ctx.stop?.()
  process.exit(1)
}
if (start > 0) console.log(`resuming from ${STEPS[start].label}`)

for (const step of STEPS.slice(start)) {
  const committed = await studio.applyScenePatch({
    projectId: PROJECT,
    baseRevision: current,
    operations: step.operations(),
    note: step.note,
  })
  const digest = committed.digest
  // A step with no recorded digest yet is the one being recorded right now; asserting
  // it would compare the fresh digest against the placeholder.
  const ok = step.digest === null || digest === step.digest
  console.log(`${step.label.padEnd(46)} ${committed.revision}  ${digest.slice(0, 16)}  ${step.digest === null ? 'digest recorded below' : ok ? 'digest OK' : 'DIGEST MISMATCH'}`)
  if (step.digest === null) console.log(`      record it: digest: '${digest}',`)
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
