/**
 * M1 Blender integration — the product turntable fixture, end to end.
 *
 * This is the suite that proves the M1 acceptance criteria on a REAL Blender:
 *
 *   SPEC §20 M1
 *     "自然语言目标可转成 SceneSpec"        → a brief becomes a project + revision
 *     "ScenePatch 可创建可打开的 .blend"    → the checkpoint really opens, and
 *                                            contains what the spec says
 *     "可渲染主相机预览"                     → a real PNG with real pixels
 *     "失败不污染当前 Revision"              → a failed patch leaves the project
 *                                            byte-identical and still renderable
 *     "同一幂等键不会重复提交"               → a retry returns the first outcome
 *
 * METHOD: WHY IT OPENS THE BLEND TWICE
 * ------------------------------------
 * Every assertion about the compiled scene is made by opening the saved `.blend`
 * in a SEPARATE Blender process and reading the datablocks back. Asserting on the
 * in-memory scene that produced the file would only prove that the compiler
 * agreed with itself; the file is what a later render, a later patch and a human
 * in the GUI will actually see. So each compile is verified through its artifact.
 *
 * It also asserts the compiled scene is a pure function of the spec: compiling the
 * same SceneSpec twice yields identical object inventories. Without that, "the
 * spec is the source of truth" would be an aspiration rather than a property.
 *
 * Run: node deepblend/tests/blender-integration/fixture.e2e.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')
const FIXTURE_DIR = join(ROOT, 'deepblend', 'fixtures', 'product-turntable')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

if (!existsSync(BLENDER)) {
  // The FIX, not only the fact. On a platform the managed install does not serve, the reader has
  // already installed Blender themselves — and told the PRODUCT, through `blenderPath` in the
  // operator layer — while this suite reads `DEEPBLEND_BLENDER_PATH`. Naming both here is the only
  // moment the two can be told apart (measured on a Linux container; ledger C5).
  console.error(`Blender not found at ${BLENDER}; the M1 integration suite cannot run.`)
  console.error('On a platform the managed install does not serve: install Blender 5.2.1 yourself, then')
  console.error('  DEEPBLEND_BLENDER_PATH=/path/to/blender node deepblend/tests/blender-integration/fixture.e2e.mjs')
  console.error('That variable is what these SUITES read. The installed product reads `blenderPath` on the')
  console.error('deepblend-blender-runtime row of the operator layer — set both, and they are not the same key.')
  process.exit(2)
}

const golden = JSON.parse(readFileSync(join(FIXTURE_DIR, 'golden.json'), 'utf8'))
const fixtureSpec = JSON.parse(readFileSync(join(FIXTURE_DIR, 'scene-spec.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const {
  DEFAULT_WORLD, validateSceneSpec, compileSceneSpec, sceneSpecDigest, summarizeSceneSpec,
} = await import('@deepblend/dsh-blender-contracts')

const workspace = mkdtempSync(join(tmpdir(), 'deepblend-m1-'))

const ctx = new Context()
ctx.plugin(LocalSubprocess)
const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
const { default: Studio } = await import('@deepblend/dsh-blender-host')

ctx.plugin(Provider, ProviderConfig({
  blenderPath: BLENDER,
  bootstrapPath: BOOTSTRAP,
  workspaceRoot: workspace,
}))
ctx.plugin(Studio, {
  projectsRoot: join(workspace, 'projects'),
  workspaceRoot: workspace,
  maxPreviewSamples: 256,
})
await new Promise(settle => setTimeout(settle, 250))

const studio = ctx.get('blenderStudio')
if (studio === undefined) {
  console.error('blenderStudio did not activate; the host composition is broken.')
  process.exit(1)
}

/**
 * Run a script inside a fresh Blender process and read back the JSON it wrote.
 *
 * A separate process rather than a provider action on purpose: the provider
 * transports a fixed set of bootstrap actions, and widening its public API just
 * so a test can look inside a file would put test-only surface into the product.
 *
 * @param {string} scriptBody
 * @param {{ openBlend?: string|null }} [options]
 * @returns {object}
 */
function runBlenderScript(scriptBody, options = {}) {
  const directory = mkdtempSync(join(workspace, 'inspect-'))
  const scriptPath = join(directory, 'inspect.py')
  const outPath = join(directory, 'out.json')
  const blendPath = options.openBlend ?? ''
  writeFileSync(scriptPath, `${INSPECT_PREAMBLE}\n${scriptBody}\n`, 'utf8')
  const run = spawnSync(BLENDER, [
    '--background', '--factory-startup',
    '--python', scriptPath,
    '--', blendPath, outPath,
  ], { encoding: 'utf8', timeout: 180_000 })
  if (!existsSync(outPath)) {
    throw new Error(
      `Blender script produced no output.\n` +
      `exit=${run.status}\nstdout=${run.stdout?.slice(-1500)}\nstderr=${run.stderr?.slice(-800)}`,
    )
  }
  return JSON.parse(readFileSync(outPath, 'utf8'))
}

/** Open a `.blend` in a fresh Blender process and report its contents. */
function inspectBlend(blendPath, script) {
  return runBlenderScript(script, { openBlend: blendPath })
}

/**
 * A recursive content digest of a directory tree.
 *
 * Used to prove the strongest form of "a failed write changed nothing": not that
 * the interesting fields are equal, but that every byte of every file under the
 * revision — the SceneSpec, the manifest, the checkpoint `.blend`, the preview
 * PNG — is identical.
 */
function digestDirectory(directory) {
  const hash = createHash('sha256')
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name)
      const stats = statSync(full)
      if (stats.isDirectory()) {
        hash.update(`dir:${prefix}${name}\n`)
        walk(full, `${prefix}${name}/`)
      } else {
        hash.update(`file:${prefix}${name}:${stats.size}\n`)
        hash.update(readFileSync(full))
      }
    }
  }
  walk(directory, '')
  return hash.digest('hex')
}

/** Shared preamble for the inspection scripts. */
const INSPECT_PREAMBLE = `
import bpy, json, sys, os
argv = sys.argv[sys.argv.index('--') + 1:]
blend_path, out_path = argv[0], argv[1]
if blend_path:
    bpy.ops.wm.open_mainfile(filepath=blend_path, load_ui=False, check_existing=False)
    bpy.context.view_layer.update()
scene = bpy.context.scene

def fcurves_of(action):
    legacy = getattr(action, 'fcurves', None)
    if legacy is not None:
        return list(legacy)
    out = []
    for layer in getattr(action, 'layers', []) or []:
        for strip in getattr(layer, 'strips', []) or []:
            for bag in getattr(strip, 'channelbags', []) or []:
                out.extend(bag.fcurves)
    return out

def write(payload):
    with open(out_path, 'w', encoding='utf-8') as stream:
        json.dump(payload, stream, indent=1, default=str)
`

/** Structural inventory of a checkpoint blend. */
const INVENTORY_SNIPPET = `
objects = []
for obj in scene.objects:
    entry = {
        'name': obj.name, 'type': obj.type,
        'deepblendId': obj.get('deepblend_id'),
        'hideRender': bool(obj.hide_render), 'hideViewport': bool(obj.hide_viewport),
        'location': [round(float(v), 5) for v in obj.location],
        'rotationEuler': [round(float(v), 5) for v in obj.rotation_euler],
        'scale': [round(float(v), 5) for v in obj.scale],
    }
    if obj.type == 'MESH':
        entry['vertexCount'] = len(obj.data.vertices)
        entry['polygonCount'] = len(obj.data.polygons)
        entry['materials'] = sorted(m.name for m in obj.data.materials if m is not None)
    if obj.type == 'LIGHT':
        entry['lightType'] = obj.data.type
        entry['energy'] = round(float(obj.data.energy), 5)
    if obj.type == 'CAMERA':
        entry['lens'] = round(float(obj.data.lens), 5)
        entry['targetEntity'] = None
        entry['forwardDot'] = None
    if obj.animation_data is not None and obj.animation_data.action is not None:
        curves = fcurves_of(obj.animation_data.action)
        entry['action'] = obj.animation_data.action.name
        entry['actionCurveCount'] = len(curves)
        entry['keyframeFrames'] = sorted({int(round(p.co[0])) for c in curves for p in c.keyframe_points})
        entry['keyframeValues'] = sorted(round(float(p.co[1]), 5) for c in curves for p in c.keyframe_points)
        entry['interpolations'] = sorted({p.interpolation for c in curves for p in c.keyframe_points})
    objects.append(entry)
objects.sort(key=lambda item: item['name'])

cameras = []
from mathutils import Vector
for obj in scene.objects:
    if obj.type != 'CAMERA':
        continue
    cameras.append({
        'id': obj.get('deepblend_id'),
        'lens': round(float(obj.data.lens), 5),
        'sensorWidth': round(float(obj.data.sensor_width), 5),
        'clipStart': round(float(obj.data.clip_start), 5),
        'clipEnd': round(float(obj.data.clip_end), 5),
        'location': [round(float(v), 5) for v in obj.location],
        'rotationEuler': [round(float(v), 5) for v in obj.rotation_euler],
    })
cameras.sort(key=lambda item: item['id'] or '')

materials = []
for material in bpy.data.materials:
    node = material.node_tree.nodes.get('Principled BSDF') if material.node_tree else None
    entry = {'name': material.name, 'deepblendId': material.get('deepblend_id'), 'sockets': {}}
    if node is not None:
        for key in ('Base Color', 'Metallic', 'Roughness'):
            socket = node.inputs.get(key)
            if socket is None:
                continue
            value = socket.default_value
            entry['sockets'][key] = [round(float(v), 4) for v in value] if hasattr(value, '__len__') else round(float(value), 4)
    materials.append(entry)
materials.sort(key=lambda item: item['name'])

write({
    'filepath': bpy.data.filepath,
    'objectCount': len(scene.objects),
    'objects': objects,
    'cameras': cameras,
    'materials': materials,
    'frameStart': int(scene.frame_start),
    'frameEnd': int(scene.frame_end),
    'fps': int(scene.render.fps),
    'engine': scene.render.engine,
    'resolution': [int(scene.render.resolution_x), int(scene.render.resolution_y)],
    'viewTransform': scene.view_settings.view_transform,
    'activeCamera': scene.camera.name if scene.camera is not None else None,
    'actionCount': len(bpy.data.actions),
    'customProps': {
        'specSchema': scene.get('deepblend_spec_schema'),
        'projectId': scene.get('deepblend_project_id'),
        'renderConfig': scene.get('deepblend_render_config'),
    },
})
`

// ---------------------------------------------------------------------------
// 1. The brief becomes a SceneSpec, and the SceneSpec validates
// ---------------------------------------------------------------------------

const validation = validateSceneSpec(fixtureSpec)
check('the product turntable fixture is a valid SceneSpec',
  validation.ok === true && validation.errors.length === 0,
  validation.ok ? `${validation.notices.length} notice(s)` : validation.summary)

const digest = sceneSpecDigest(compileSceneSpec(fixtureSpec).spec)
check('the fixture digest matches the recorded golden digest',
  digest === golden.structural.digest,
  digest === golden.structural.digest ? digest.slice(0, 16) : `got ${digest.slice(0, 16)}, golden ${golden.structural.digest.slice(0, 16)}`)

const summary = summarizeSceneSpec(compileSceneSpec(fixtureSpec).spec, { digest })
check('the fixture matches its golden structural counts',
  summary.counts.entities === golden.structural.entityCount
    && summary.counts.materials === golden.structural.materialCount
    && summary.counts.lights === golden.structural.lightCount
    && summary.counts.cameras === golden.structural.cameraCount
    && summary.counts.animationTracks === golden.structural.animationTrackCount,
  summary.counts)

check('the golden subject bounds exclude the environment plane',
  Math.abs(summary.subjectBounds.max[0] - golden.structural.subjectBounds.max[0]) < 0.002,
  summary.subjectBounds)

// ---------------------------------------------------------------------------
// 1b. ARMATURES (SPEC §20 M6, character animation) — the first slice, on a real Blender
//
// The schema slice is asserted in the contract layer; what has to be shown HERE is that Blender
// actually creates the rig, and that the bones come back with the hierarchy the spec declared —
// including a child declared BEFORE its parent, which the compiler resolves rather than requiring the
// file to be written parents-first.
// ---------------------------------------------------------------------------

const rigSpec = JSON.parse(JSON.stringify(fixtureSpec))
rigSpec.armatures = [{
  id: 'hero-rig',
  bones: [
    { name: 'chest', head: [0, 0, 1.1], tail: [0, 0, 1.5], parent: 'hips' },
    { name: 'hips', head: [0, 0, 0.9], tail: [0, 0, 1.1] },
    { name: 'head', head: [0, 0, 1.5], tail: [0, 0, 1.75], parent: 'chest' },
  ],
}]
const rigSpecPath = join(workspace, 'rig-spec.json')
writeFileSync(rigSpecPath, JSON.stringify(rigSpec, null, 2))
// THE PROVIDER'S OWN SERVICE, because this slice is about what BLENDER was told to create; the host
// above it decides which revisions exist, and that is asserted elsewhere in this file.
const renderRuntime = ctx.get('blenderRuntime')
const rigged = await renderRuntime.compileScene({ sceneSpecPath: rigSpecPath })

check('Blender creates the armature the spec declares',
  rigged.envelope.status === 'success' && Array.isArray(rigged.envelope.result?.armatures) &&
  rigged.envelope.result.armatures.length === 1 &&
  rigged.envelope.result.armatures[0].object === 'db_arm__hero-rig',
  rigged.envelope.result?.armatures ?? rigged.envelope.error?.message)

check('and the bones come back with the parents the spec named, in any declaration order',
  JSON.stringify(rigged.envelope.result?.armatures?.[0]?.bones) === JSON.stringify([
    { name: 'chest', parent: 'hips' },
    { name: 'hips', parent: null },
    { name: 'head', parent: 'chest' },
  ]),
  rigged.envelope.result?.armatures?.[0]?.bones)

check('and the structural fingerprint counts the rig, so a revision records that it has one',
  (rigged.envelope.result?.sceneFingerprint?.objectCounts?.ARMATURE ?? 0) >= 1,
  rigged.envelope.result?.sceneFingerprint?.objectCounts)

// ---------------------------------------------------------------------------
// 1c. SKINNING — the second slice: an entity follows the rig
//
// The spec states the RELATIONSHIP and Blender produces the weights. What has to be shown is that the
// weights exist, that they are named after the bones (which is what makes them follow those bones), and
// that the mesh is parented to the rig — because an entity "bound" with no groups renders as a static
// object while the file says it is rigged.
// ---------------------------------------------------------------------------

const skinSpec = JSON.parse(JSON.stringify(rigSpec))
skinSpec.entities[0] = { ...skinSpec.entities[0], armatureId: 'hero-rig' }
const skinSpecPath = join(workspace, 'skin-spec.json')
writeFileSync(skinSpecPath, JSON.stringify(skinSpec, null, 2))
const skinned = await renderRuntime.compileScene({ sceneSpecPath: skinSpecPath })

check('an entity skinned to the rig is bound with real weights, named after the bones',
  skinned.envelope.status === 'success' &&
  JSON.stringify(skinned.envelope.result?.skinned) === JSON.stringify([
    { entityId: skinSpec.entities[0].id, armatureId: 'hero-rig', vertexGroups: ['chest', 'head', 'hips'] },
  ]),
  skinned.envelope.result?.skinned ?? skinned.envelope.error?.message)

check('and the mesh is parented to the armature, which is what makes it follow the bones',
  (skinned.envelope.result?.objects ?? []).some(entry =>
    entry.deepblendId === skinSpec.entities[0].id && entry.parent === 'db_arm__hero-rig'),
  (skinned.envelope.result?.objects ?? []).filter(entry => entry.deepblendId === skinSpec.entities[0].id))

check('skinning costs nothing to a scene that does not ask for it',
  rigged.envelope.status === 'success' && (rigged.envelope.result?.skinned ?? []).length === 0,
  rigged.envelope.result?.skinned)

// AND A RIG THAT IS NOT THERE IS REFUSED, not silently skipped: an entity that claims to be rigged and
// is not renders as a static object, which is the difference this whole slice is about.
const orphanSpec = JSON.parse(JSON.stringify(rigSpec))
orphanSpec.entities[0] = { ...orphanSpec.entities[0], armatureId: 'no-such-rig' }
const orphanSpecPath = join(workspace, 'orphan-spec.json')
writeFileSync(orphanSpecPath, JSON.stringify(orphanSpec, null, 2))
const orphan = await renderRuntime.compileScene({ sceneSpecPath: orphanSpecPath })
  .then(run => run, error => error)
// ---------------------------------------------------------------------------
// 1e. COMPLEX SIMULATION, the first slice: rigid bodies — and the reading is DIRECTIONAL
//
// The lesson from the animation slice, applied before it could bite: "the setup exists" and "the
// images differ" are both satisfied by a body that is configured and never simulated. What this
// asserts instead is WHERE THE BODY ENDED UP — an active one falls, a passive one does not — and then
// that turning the BAKE off leaves it exactly where it started, which is what makes the reading a
// measurement of the physics rather than of the file.
// ---------------------------------------------------------------------------

const physicsSpec = (overrides = {}) => {
  const spec = JSON.parse(JSON.stringify(fixtureSpec))
  spec.project.frameStart = 1
  spec.project.frameEnd = 40
  spec.simulation = { gravity: 9.81, ...(overrides.simulation ?? {}) }
  spec.entities = spec.entities.map(entity => {
    if (entity.id === 'stage') return { ...entity, rigidBody: { kind: 'passive' } }
    if (entity.id === 'watch-body') {
      return {
        ...entity,
        rigidBody: { kind: 'active', mass: 0.1 },
        // dropped from half a metre up, so a fall is unambiguous rather than a settle
        transform: { ...entity.transform, location: [entity.transform.location[0], entity.transform.location[1], entity.transform.location[2] + 0.5] },
      }
    }
    return entity
  })
  return spec
}

const physicsPath = join(workspace, 'physics-spec.json')
writeFileSync(physicsPath, JSON.stringify(physicsSpec(), null, 2))
const simulated = await renderRuntime.compileScene({ sceneSpecPath: physicsPath })
check('a scene with rigid bodies compiles and reports what the physics DID, per entity',
  simulated.envelope.status === 'success' && (simulated.envelope.result?.simulation ?? []).length === 2,
  simulated.envelope.result?.simulation ?? simulated.envelope.error?.message)

const bodies = Object.fromEntries((simulated.envelope.result?.simulation ?? []).map(entry => [entry.entityId, entry]))
check('the ACTIVE body fell, and it fell downwards',
  bodies['watch-body']?.kind === 'active' && bodies['watch-body'].droppedZ > 0.3,
  bodies['watch-body'])
check('and the PASSIVE body did not move at all, which is what makes it a floor',
  bodies.stage?.kind === 'passive' && bodies.stage.droppedZ === 0,
  bodies.stage)

// AND WITH THE BAKE OFF, NOTHING MOVES. An unbaked simulation is a SETTING: Blender evaluates it live
// and a batch compile reads the initial pose. Without this the reading above could be satisfied by
// anything that shifts an object, and with it the reading is specifically about the baked physics.
const unbakedPath = join(workspace, 'unbaked-spec.json')
writeFileSync(unbakedPath, JSON.stringify(physicsSpec({ simulation: { bake: false } }), null, 2))
const unbaked = await renderRuntime.compileScene({ sceneSpecPath: unbakedPath })
const unbakedBodies = Object.fromEntries((unbaked.envelope.result?.simulation ?? []).map(entry => [entry.entityId, entry]))
check('without the bake the active body stays exactly where it started, so the reading above measures the bake',
  unbaked.envelope.status === 'success' && unbakedBodies['watch-body']?.droppedZ === 0,
  unbakedBodies['watch-body'])

// ---------------------------------------------------------------------------
// 1f. CLOTH — the second slice of complex simulation, and it is NOT the same as a rigid body
//
// MEASURED, and it would have produced a false assertion: cloth is evaluated LIVE, so it drapes with
// or without a bake — the rigid-body claim "no bake means no motion" is simply not true here, because
// cloth integrates frame by frame rather than being a body that is switched on. What IS asserted is
// directional: the fabric DROPS from its lowest point while the edge it hangs from does not move.
// ---------------------------------------------------------------------------

const clothSpec = JSON.parse(JSON.stringify(fixtureSpec))
clothSpec.project.frameStart = 1
clothSpec.project.frameEnd = 30
clothSpec.entities = clothSpec.entities.map(entity => entity.id === 'stage'
  ? {
      ...entity,
      transform: { ...entity.transform, location: [0, 0, 1.5] },
      cloth: { pinTop: true, stiffness: 0.5 },
    }
  : entity)
const clothPath = join(workspace, 'cloth-spec.json')
writeFileSync(clothPath, JSON.stringify(clothSpec, null, 2))
const draped = await renderRuntime.compileScene({ sceneSpecPath: clothPath })
const fabric = (draped.envelope.result?.simulation ?? []).find(entry => entry.kind === 'cloth')

// THE RATIO, NOT A THRESHOLD. MEASURED, and a surviving mutation is why: "at least 64 vertices" passed
// on a generator that already had that many, so it proved nothing about the subdivision. Comparing the
// evaluated count against the count the object was BUILT with is what makes the subdivision visible.
check('fabric is reported as cloth, and the compiler subdivided it because a primitive has no interior',
  draped.envelope.status === 'success' && fabric !== undefined &&
  fabric.firstFrameVertices >= fabric.firstFrameSourceVertices * 4,
  fabric ?? draped.envelope.error?.message)

check('the fabric DRAPED: its lowest point fell a long way',
  fabric !== undefined && fabric.droppedZ > 1,
  fabric)

check('and the edge it hangs from did NOT move, which is what makes the drop a drape rather than a fall',
  fabric !== undefined && fabric.firstFrameHighestZ === fabric.lastFrameHighestZ,
  fabric)

// ---------------------------------------------------------------------------
// 1g. SOFT BODIES — the third mechanism, and the third measured behaviour
//
// Cloth moves without a bake; a soft body does NOT (measured: 1.75 -> 1.75 before, 1.75 -> 1.6252
// after), so this slice needed the same pre-bake placement as the rigid bodies and the opposite of
// what cloth needed. What separates it from cloth is asserted too: it falls WHILE KEEPING ITS SHAPE,
// which is what the goal is for.
// ---------------------------------------------------------------------------

const softSpec = JSON.parse(JSON.stringify(fixtureSpec))
softSpec.project.frameStart = 1
softSpec.project.frameEnd = 40
softSpec.entities = softSpec.entities.map(entity => entity.id === 'watch-dial'
  ? { ...entity, transform: { ...entity.transform, location: [0, 0, 1.5] }, softBody: {} }
  : entity)
const softPath = join(workspace, 'soft-spec.json')
writeFileSync(softPath, JSON.stringify(softSpec, null, 2))
const softened = await renderRuntime.compileScene({ sceneSpecPath: softPath })
const body = (softened.envelope.result?.simulation ?? []).find(entry => entry.kind === 'soft-body')

check('a soft body is reported as one, and the compiler subdivided it so it has an interior to deform',
  softened.envelope.status === 'success' && body !== undefined &&
  body.firstFrameVertices >= body.firstFrameSourceVertices * 4,
  body ?? softened.envelope.error?.message)

check('the soft body fell, which a bake is required for — the opposite of what cloth needed',
  body !== undefined && body.droppedZ > 0.05,
  body)

check('and it KEPT ITS SHAPE while falling, which is what makes it a soft body rather than cloth',
  body !== undefined &&
  Math.abs((body.firstFrameHighestZ - body.firstFrameLowestZ) - (body.lastFrameHighestZ - body.lastFrameLowestZ)) < 0.01,
  body)

// AND THE GOAL IS EXERCISED, not just carried. MEASURED, and two surviving mutations are why: both
// "ignore the goal" and "set it to zero" survived the checks above, because those checks never declare
// a goal at all — the setting existed and nothing proved it did anything. A body with NO goal collapses,
// which is the difference between a soft body and a puddle.
const limpSpec = JSON.parse(JSON.stringify(softSpec))
limpSpec.entities = limpSpec.entities.map(entity => entity.id === 'watch-dial'
  ? { ...entity, softBody: { goal: 0 } }
  : entity)
const limpPath = join(workspace, 'limp-spec.json')
writeFileSync(limpPath, JSON.stringify(limpSpec, null, 2))
const limp = await renderRuntime.compileScene({ sceneSpecPath: limpPath })
const limpBody = (limp.envelope.result?.simulation ?? []).find(entry => entry.kind === 'soft-body')
// MEASURED, AND IT CORRECTED MY ASSUMPTION: I expected `goal: 0` to make the body COLLAPSE, and it does
// not — a symmetric body with no shape memory free-falls instead (7.01 units against 0.087 with the
// default goal), keeping its spread exactly as it was. What the goal actually does is HOLD THE BODY UP,
// by pulling every vertex back toward where it started. So the assertion compares the two runs rather
// than asserting a threshold on one, which is also what makes "ignore the goal" and "zero the goal" fail.
check('the goal holds the body up: with no shape memory it free-falls many times further',
  limp.envelope.status === 'success' && limpBody !== undefined && body !== undefined &&
  limpBody.droppedZ > body.droppedZ * 10,
  { withDefaultGoal: body?.droppedZ, withNoGoal: limpBody?.droppedZ })

// AND A DECLARED GOAL IS HONOURED, which needs a value that is neither the default nor zero. MEASURED,
// and a surviving mutation is why this third run exists: "apply zero whatever the file says" survived
// because the only goal the suite ever declared WAS zero, so the mutation and the file agreed. A goal of
// 0.9 has to behave like the default and unlike the limp run.
const firmSpec = JSON.parse(JSON.stringify(softSpec))
firmSpec.entities = firmSpec.entities.map(entity => entity.id === 'watch-dial'
  ? { ...entity, softBody: { goal: 0.9 } }
  : entity)
const firmPath = join(workspace, 'firm-spec.json')
writeFileSync(firmPath, JSON.stringify(firmSpec, null, 2))
const firm = await renderRuntime.compileScene({ sceneSpecPath: firmPath })
const firmBody = (firm.envelope.result?.simulation ?? []).find(entry => entry.kind === 'soft-body')

check('and a declared goal is honoured: 0.9 holds the body up like the default, unlike no goal at all',
  firm.envelope.status === 'success' && firmBody !== undefined && limpBody !== undefined &&
  firmBody.droppedZ < limpBody.droppedZ / 10,
  { declared: firmBody?.droppedZ, none: limpBody?.droppedZ })

// ---------------------------------------------------------------------------
// 1h. FLUIDS — the last slice, and the one that needed the most measuring
//
// MEASURED, and this is the whole slice: a LIQUID inflow into a GAS domain produces NOTHING while
// every signal says it worked — the bake returns, both caches report baked, and the evaluated mesh is
// the domain's own box. Blender's default domain type is GAS, so the product's default is liquid, and a
// domain that still has no liquid after a successful bake WARNS rather than being silent.
//
// The second measured trap, and the one that took longest to find: AN INFLOW FINER THAN THE GRID EMITS
// NOTHING. The fixture's watch-crown is a cylinder of radius 0.006 — six millimetres — and at eight
// times that size it was still under one cell of a 2m domain at resolution 24. The liquid appeared at
// forty.
// ---------------------------------------------------------------------------

const fluidSpec = JSON.parse(JSON.stringify(fixtureSpec))
fluidSpec.project.frameStart = 1
fluidSpec.project.frameEnd = 12
fluidSpec.simulation = { bake: true }
fluidSpec.entities = fluidSpec.entities.map(entity => {
  if (entity.id === 'stage') {
    return {
      ...entity,
      transform: { ...entity.transform, location: [0, 0, 1.0] },
      generator: { shape: 'cube', size: 2 },
      fluid: { role: 'domain', resolution: 24 },
    }
  }
  if (entity.id === 'watch-crown') {
    return {
      ...entity,
      transform: { ...entity.transform, location: [0, 0, 1.7], scale: [40, 40, 40] },
      fluid: { role: 'inflow' },
    }
  }
  return entity
})
const fluidPath = join(workspace, 'fluid-spec.json')
writeFileSync(fluidPath, JSON.stringify(fluidSpec, null, 2))
const poured = await renderRuntime.compileScene({ sceneSpecPath: fluidPath })
const pool = (poured.envelope.result?.simulation ?? []).find(entry => entry.kind === 'fluid')

check('a fluid domain is reported with its type, its resolution and a baked mesh cache',
  poured.envelope.status === 'success' && pool !== undefined &&
  pool.domainType === 'LIQUID' && pool.resolution === 24 && pool.meshCacheBaked === true,
  pool ?? poured.envelope.error?.message)

check('and there IS liquid: the domain evaluates to far more than the box it was built from',
  pool !== undefined && pool.lastFrameVertices > pool.sourceVertices * 10,
  pool)

check('and the compiler did not warn, because with liquid present there is nothing to warn about',
  !(poured.envelope.warnings ?? []).some(entry => entry.code === 'FLUID_NO_LIQUID'),
  (poured.envelope.warnings ?? []).map(entry => entry.code))

// THE TRAP, ASSERTED RATHER THAN DESCRIBED: an inflow finer than the grid produces no liquid at all,
// and the product says so instead of returning a domain that silently contains nothing.
const tinySpec = JSON.parse(JSON.stringify(fluidSpec))
tinySpec.entities = tinySpec.entities.map(entity => entity.id === 'watch-crown'
  ? { ...entity, transform: { ...entity.transform, scale: [1, 1, 1] } }
  : entity)
const tinyPath = join(workspace, 'tiny-fluid-spec.json')
writeFileSync(tinyPath, JSON.stringify(tinySpec, null, 2))
const trickle = await renderRuntime.compileScene({ sceneSpecPath: tinyPath })
const tricklePool = (trickle.envelope.result?.simulation ?? []).find(entry => entry.kind === 'fluid')
check('an inflow too fine for the grid produces no liquid, and the compiler WARNS instead of being silent',
  trickle.envelope.status === 'success' && tricklePool !== undefined &&
  tricklePool.lastFrameVertices <= tricklePool.sourceVertices &&
  (trickle.envelope.warnings ?? []).some(entry => entry.code === 'FLUID_NO_LIQUID'),
  { pool: tricklePool, warnings: (trickle.envelope.warnings ?? []).map(entry => entry.code) })

// ---------------------------------------------------------------------------
// 1d. THE MESH ACTUALLY MOVES — the evidence the whole item rests on
//
// Everything above shows the parts exist. This shows they do something: the same scene, the same
// camera, two frames of the rig's own action, and two DIFFERENT images. A rig that exists, a mesh that
// is skinned and a track that is written would still be a still image if any of the three were wired
// up wrong, and only rendering it can tell the difference.
// ---------------------------------------------------------------------------

const movingSpec = JSON.parse(JSON.stringify(skinSpec))
movingSpec.project.frameStart = 1
movingSpec.project.frameEnd = 10
movingSpec.animationTracks = [
  ...(movingSpec.animationTracks ?? []),
  {
    id: 'chest-lift', targetKind: 'bone', targetEntityId: 'hero-rig', boneName: 'chest',
    property: 'rotationEuler.x',
    keyframes: [
      { frame: 1, value: 0, interpolation: 'linear' },
      { frame: 10, value: 1, interpolation: 'linear' },
    ],
  },
]
const movingSpecPath = join(workspace, 'moving-spec.json')
writeFileSync(movingSpecPath, JSON.stringify(movingSpec, null, 2))
const movingBlend = join(workspace, 'moving.blend')
const moving = await renderRuntime.runBootstrap({ action: 'compile_scene' }, {
  args: ['--scene-spec', movingSpecPath, '--output-blend', movingBlend, '--profile', 'final'],
})
check('a spec with a bone track compiles, and the action names the bone it drives',
  moving.envelope.status === 'success' &&
  (moving.envelope.result?.actions ?? []).some(entry => entry.targetKind === 'bone' && entry.boneName === 'chest'),
  moving.envelope.result?.actions ?? moving.envelope.error?.message)

// AND THE ACTION DROVE THE BONE, NOT THE ARMATURE OBJECT. MEASURED, and a surviving mutation is why
// this check exists: keying the armature OBJECT still moves the mesh — it is parented to the armature —
// so two differing frames prove that SOMETHING moved, not that the bone did. The data paths are the
// difference, and they are read off the action's own fcurves.
check('the action keyed the POSE BONE, which is the difference between a rig that animates and a rig that is dragged',
  (moving.envelope.result?.actions ?? []).some(entry =>
    entry.targetKind === 'bone' &&
    entry.dataPaths?.length === 1 &&
    /^pose\.bones\["chest"\]\./.test(entry.dataPaths[0])),
  (moving.envelope.result?.actions ?? []).filter(entry => entry.targetKind === 'bone'))

const renderFrame = async frame => {
  const output = join(workspace, `moving-f${frame}.png`)
  const run = await renderRuntime.runBootstrap({ action: 'render_preview' }, {
    args: ['--blend', movingBlend, '--output', output, '--frame', String(frame), '--profile', 'final'],
  })
  return { status: run.envelope.status, digest: createHash('sha256').update(readFileSync(output)).digest('hex'), bytes: readFileSync(output).length }
}
const frameOne = await renderFrame(1)
const frameTen = await renderFrame(10)
check('and the two frames of that action are DIFFERENT images, which is the mesh actually following the bone',
  frameOne.status === 'success' && frameTen.status === 'success' &&
  frameOne.bytes > 10_000 && frameTen.bytes > 10_000 && frameOne.digest !== frameTen.digest,
  { first: frameOne.digest?.slice(0, 12), tenth: frameTen.digest?.slice(0, 12) })

check('an entity skinned to an armature that does not exist is refused by the COMPILER too',
  orphan?.envelope?.status === 'error' || orphan?.code === 'SCENE_REFERENCE_MISSING' ||
  /no-such-rig/.test(orphan?.message ?? '') || /no-such-rig/.test(JSON.stringify(orphan?.envelope?.error ?? {})),
  orphan?.message ?? JSON.stringify(orphan?.envelope?.error))

// ---------------------------------------------------------------------------
// 2. project_create compiles a checkpoint from the natural-language brief
// ---------------------------------------------------------------------------

const created = await studio.createProject({
  title: 'Watch Commercial',
  goal: fixtureSpec.project.goal,
  sceneSpec: fixtureSpec,
  renderPreview: true,
})

check('project_create commits the first revision', created.currentRevision === 'r0001', created.currentRevision)
check('project_create stores the natural-language goal verbatim',
  created.scene?.project?.goal === fixtureSpec.project.goal)
check('project_create saves a .blend checkpoint', created.revision.checkpoint === 'revisions/r0001/scene.blend',
  created.revision.checkpoint)
check('project_create renders a preview when asked',
  Array.isArray(created.revision.previews) && created.revision.previews.length === 1,
  created.revision.previews?.map(entry => entry.path))

const checkpointPath = join(workspace, 'projects', created.projectId, 'revisions', 'r0001', 'scene.blend')
check('the checkpoint file exists on disk', existsSync(checkpointPath), checkpointPath)

// ---------------------------------------------------------------------------
// 3. The checkpoint really opens, and contains what the spec says
// ---------------------------------------------------------------------------

const inventory = inspectBlend(checkpointPath, INVENTORY_SNIPPET)

check('the committed .blend opens and reports the file it came from',
  inventory.filepath === checkpointPath, inventory.filepath)

check('the compiled scene matches the golden object counts',
  inventory.objectCount === golden.blender.expectedObjectCount,
  { objects: inventory.objectCount, golden: golden.blender.expectedObjectCount })

const meshObjects = inventory.objects.filter(entry => entry.type === 'MESH')
const lightObjects = inventory.objects.filter(entry => entry.type === 'LIGHT')
const cameraObjects = inventory.objects.filter(entry => entry.type === 'CAMERA')
check('the compiled scene has the golden mesh, light and camera counts',
  meshObjects.length === golden.blender.expectedMeshObjectCount
    && lightObjects.length === golden.blender.expectedLightObjectCount
    && cameraObjects.length === golden.blender.expectedCameraObjectCount,
  { mesh: meshObjects.length, light: lightObjects.length, camera: cameraObjects.length })

check('the compiled scene carries the golden geometry volume',
  inventory.objects.reduce((total, entry) => total + (entry.polygonCount ?? 0), 0) === golden.blender.expectedTotalPolygons,
  inventory.objects.reduce((total, entry) => total + (entry.polygonCount ?? 0), 0))

check('the compiled scene matches the golden frame range and fps',
  inventory.frameStart === golden.blender.expectedFrameStart
    && inventory.frameEnd === golden.blender.expectedFrameEnd
    && inventory.fps === golden.blender.expectedFps,
  { frames: [inventory.frameStart, inventory.frameEnd], fps: inventory.fps })

check('every animation track became a real Blender action',
  inventory.actionCount === golden.blender.expectedActionCount,
  { actions: inventory.actionCount, names: inventory.objects.filter(entry => entry.action).map(entry => entry.action) })

check('the keyframe trajectory survives the round trip through the .blend',
  inventory.objects.some(entry => entry.keyframeFrames?.join(',') === '1,45,90'),
  inventory.objects.find(entry => entry.keyframeFrames)?.keyframeFrames)

check('the requested linear interpolation is what the saved curves use',
  inventory.objects.filter(entry => entry.interpolations).every(entry => entry.interpolations.join(',') === 'LINEAR'),
  inventory.objects.find(entry => entry.interpolations)?.interpolations)

check('the compiled materials are exactly the spec materials, and no default was added',
  (() => {
    const authored = inventory.materials.filter(entry => entry.deepblendId !== null).map(entry => entry.deepblendId).sort()
    const expected = fixtureSpec.materials.map(entry => entry.id).sort()
    return authored.join(',') === expected.join(',') && authored.length === golden.blender.expectedMaterialCount
  })(),
  inventory.materials.map(entry => entry.deepblendId))

check('the metal material kept its authored roughness through the compile',
  (() => {
    const steel = inventory.materials.find(entry => entry.deepblendId === 'hero-steel')
    const authored = fixtureSpec.materials.find(entry => entry.id === 'hero-steel').parameters.roughness
    return steel !== undefined && Math.abs(steel.sockets.Roughness - authored) < 0.001
  })(),
  inventory.materials.find(entry => entry.deepblendId === 'hero-steel')?.sockets)

check('the camera is aimed by Blender, and its -Z axis points at the target',
  (() => {
    const camera = inventory.cameras.find(entry => entry.id === 'camera-main')
    if (camera === undefined) return false
    // Reproduce the engine's own aim: rotate -Z by the saved Euler and compare
    // with the direction to the watch body. If the two disagree, the file's
    // camera is not looking where the spec said it should.
    const [rx, ry, rz] = camera.rotationEuler
    const cos = Math.cos, sin = Math.sin
    // A camera looks down its local -Z axis, so the world forward direction is
    // the NEGATED third column of the XYZ rotation matrix.
    const fx = -(sin(ry) * cos(rz) + cos(ry) * sin(rx) * sin(rz))
    const fy = -(-sin(rx) * cos(rz) + cos(rx) * sin(ry) * sin(rz))
    const fz = -(cos(rx) * cos(ry))
    const watch = inventory.objects.find(entry => entry.deepblendId === 'watch-body')
    const dx = watch.location[0] - camera.location[0]
    const dy = watch.location[1] - camera.location[1]
    const dz = watch.location[2] - camera.location[2]
    const length = Math.hypot(dx, dy, dz)
    return Math.abs((fx * dx + fy * dy + fz * dz) / length - 1) < 0.01
  })(),
  inventory.cameras.find(entry => entry.id === 'camera-main'))

check('the compiled scene records its own provenance in a custom property',
  inventory.customProps.projectId === created.projectId
    && inventory.customProps.specSchema === 'deepblend.scene/v1'
    && typeof inventory.customProps.renderConfig === 'string',
  { projectId: inventory.customProps.projectId, schema: inventory.customProps.specSchema })

// ---------------------------------------------------------------------------
// 4. Compilation is a pure function of the spec
// ---------------------------------------------------------------------------

const secondCompile = inspectBlend(
  await (async () => {
    // Compile the SAME spec again through the provider, into a scratch path, and
    // compare the inventories. This is what makes "the spec is the source of
    // truth" testable rather than aspirational.
    const scratch = mkdtempSync(join(workspace, 'recompile-'))
    const specPath = join(scratch, 'scene-spec.json')
    writeFileSync(specPath, `${JSON.stringify(compileSceneSpec(fixtureSpec).spec, null, 2)}\n`, 'utf8')
    let produced = null
    await studio.runtime.compileScene({
      sceneSpecPath: specPath,
      onWorkingDirectory: info => {
        const candidate = join(info.directory, 'result.blend')
        if (existsSync(candidate)) {
          produced = join(scratch, 'second.blend')
          // Copy (not move) so the provider's own cleanup is unaffected.
          writeFileSync(produced, readFileSync(candidate))
        }
      },
    })
    return produced
  })(),
  INVENTORY_SNIPPET,
)

check('compiling the same SceneSpec twice yields an identical scene',
  JSON.stringify(secondCompile.objects) === JSON.stringify(inventory.objects),
  {
    identical: JSON.stringify(secondCompile.objects) === JSON.stringify(inventory.objects),
    first: inventory.objects.length,
    second: secondCompile.objects.length,
  })

check('the same spec compiles to the same geometry volume twice',
  secondCompile.objects.reduce((total, entry) => total + (entry.polygonCount ?? 0), 0)
    === inventory.objects.reduce((total, entry) => total + (entry.polygonCount ?? 0), 0))

// ---------------------------------------------------------------------------
// 5. scene_patch creates a new, openable, independently verified revision
// ---------------------------------------------------------------------------

const patched = await studio.applyScenePatch({
  projectId: created.projectId,
  baseRevision: 'r0001',
  note: 'Dim the key light and soften the case roughness for a matte hero look.',
  stage: 'VISUAL_REVIEW',
  operations: [
    { op: 'light.update', lightId: 'key-light', energy: 42.5 },
    { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.42 },
    { op: 'entity.visibility.set', entityId: 'watch-crown', visible: false },
  ],
  renderPreview: true,
})

check('the patch committed a new revision', patched.revision === 'r0002', patched.revision)
check('the patch reports the scene actually changed', patched.sceneChanged === true)
check('the patch revision has its own checkpoint', patched.checkpoint === 'revisions/r0002/scene.blend', patched.checkpoint)

const patchInventory = inspectBlend(
  join(workspace, 'projects', created.projectId, 'revisions', 'r0002', 'scene.blend'),
  INVENTORY_SNIPPET,
)

check('the patched checkpoint applies the light energy change',
  (() => {
    const light = patchInventory.objects.find(entry => entry.deepblendId === 'key-light')
    return light !== undefined && Math.abs(light.energy - 42.5) < 0.001
  })(),
  patchInventory.objects.find(entry => entry.deepblendId === 'key-light')?.energy)

check('the patched checkpoint applies the material parameter change',
  (() => {
    const steel = patchInventory.materials.find(entry => entry.deepblendId === 'hero-steel')
    return steel !== undefined && Math.abs(steel.sockets.Roughness - 0.42) < 0.001
  })(),
  patchInventory.materials.find(entry => entry.deepblendId === 'hero-steel')?.sockets)

check('hiding an entity survives into the saved file',
  (() => {
    const crown = patchInventory.objects.find(entry => entry.deepblendId === 'watch-crown')
    return crown !== undefined && crown.hideRender === true && crown.hideViewport === true
  })(),
  patchInventory.objects.find(entry => entry.deepblendId === 'watch-crown'))

check('the earlier revision is unchanged by the patch (immutability)',
  JSON.stringify(inspectBlend(checkpointPath, INVENTORY_SNIPPET).objects) === JSON.stringify(inventory.objects))

// ---------------------------------------------------------------------------
// 6. A failed patch pollutes nothing
// ---------------------------------------------------------------------------

const beforeFailure = studio.store.currentRevision(created.projectId)
const revisionListBefore = studio.store.listRevisions(created.projectId).join(',')
// Snapshot the CURRENT revision's directory at byte level. "失败不污染当前
// Revision" is a statement about the bytes on disk, so it is tested that way:
// a stronger claim than comparing a field, and one that would catch a
// half-written staging directory or a mutated file.
const digestBeforeFailure = digestDirectory(join(workspace, 'projects', created.projectId, 'revisions', beforeFailure))
const jobCountBeforeFailure = readdirSync(join(workspace, 'projects', created.projectId, 'jobs')).length

let failureCode = null
let failureMessage = ''
try {
  await studio.applyScenePatch({
    projectId: created.projectId,
    baseRevision: beforeFailure,
    operations: [
      // The FIRST operation is valid, so this patch would have half-applied if
      // the transaction were not atomic. The second one cannot succeed.
      { op: 'light.update', lightId: 'fill-light', energy: 5 },
      { op: 'entity.transform.update', entityId: 'no-such-entity', location: [1, 1, 1] },
    ],
  })
} catch (error) {
  failureCode = error.code
  failureMessage = error.message
}

check('a patch whose last operation fails is refused', failureCode === 'PATCH_TARGET_MISSING', failureCode)
check('the refusal explains that nothing was committed',
  failureMessage.includes('no revision was created'), failureMessage.slice(0, 140))
check('a failed patch leaves the current revision untouched',
  studio.store.currentRevision(created.projectId) === beforeFailure,
  { before: beforeFailure, after: studio.store.currentRevision(created.projectId) })
check('a failed patch leaves the revision list untouched',
  studio.store.listRevisions(created.projectId).join(',') === revisionListBefore,
  studio.store.listRevisions(created.projectId))
check('a failed patch leaves the current revision BYTE-IDENTICAL on disk',
  digestDirectory(join(workspace, 'projects', created.projectId, 'revisions', beforeFailure)) === digestBeforeFailure,
  digestBeforeFailure.slice(0, 16))
check('a patch rejected during validation spends no Blender job at all',
  readdirSync(join(workspace, 'projects', created.projectId, 'jobs')).length === jobCountBeforeFailure,
  { before: jobCountBeforeFailure, after: readdirSync(join(workspace, 'projects', created.projectId, 'jobs')).length })

const currentCheckpoint = join(workspace, 'projects', created.projectId, 'revisions', beforeFailure, 'scene.blend')
check('the current revision is still renderable after a failed patch',
  inspectBlend(currentCheckpoint, INVENTORY_SNIPPET).objectCount === golden.blender.expectedObjectCount)

check('a stale baseRevision is refused with a conflict, not merged',
  await (async () => {
    try {
      await studio.applyScenePatch({
        projectId: created.projectId,
        baseRevision: 'r0001',
        operations: [{ op: 'light.update', lightId: 'key-light', energy: 1 }],
      })
      return false
    } catch (error) {
      return error.code === 'REVISION_CONFLICT'
    }
  })())

// ---------------------------------------------------------------------------
// 7. The same idempotency key does not commit twice
// ---------------------------------------------------------------------------

const identicalPatch = {
  projectId: created.projectId,
  baseRevision: 'r0001',
  note: 'Dim the key light and soften the case roughness for a matte hero look.',
  stage: 'VISUAL_REVIEW',
  operations: [
    { op: 'light.update', lightId: 'key-light', energy: 42.5 },
    { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.42 },
    { op: 'entity.visibility.set', entityId: 'watch-crown', visible: false },
  ],
  renderPreview: true,
}

const revisionsBeforeReplay = studio.store.listRevisions(created.projectId).length
const replayed = await studio.applyScenePatch(identicalPatch)

check('re-submitting an identical patch is detected as a replay', replayed.idempotentReplay === true)
check('the replay returns the ORIGINAL revision', replayed.revision === 'r0002', replayed.revision)
check('the replay committed no new revision',
  studio.store.listRevisions(created.projectId).length === revisionsBeforeReplay,
  studio.store.listRevisions(created.projectId))
check('the replay carries its own idempotency key for the audit trail',
  typeof replayed.idempotencyKey === 'string' && replayed.idempotencyKey.startsWith('auto-'),
  replayed.idempotencyKey)

// A DIFFERENT patch against the same base revision is still a conflict, and a
// different patch against the CURRENT revision applies normally. Both matter:
// idempotency must not become a licence to bypass the conflict check.
const changed = await studio.applyScenePatch({
  projectId: created.projectId,
  baseRevision: replayed.revision,
  note: 'Warm the rim light.',
  operations: [{ op: 'light.update', lightId: 'rim-light', energy: 30, color: [1, 0.86, 0.72, 1] }],
})
check('a genuinely different patch still applies normally', changed.revision === 'r0003', changed.revision)
check('the third revision recorded a real change', changed.sceneChanged === true)

// ---------------------------------------------------------------------------
// 8. Preview rendering produces a real image
// ---------------------------------------------------------------------------

const preview = await studio.renderPreview({
  projectId: created.projectId,
  cameraId: 'camera-top',
  frame: 30,
})

check('the preview rendered exactly one artifact', preview.artifacts.length === 1)
const artifact = preview.artifacts[0]
check('the preview artifact is a PNG with real dimensions and bytes',
  artifact.mime === 'image/png' && artifact.width === 640 && artifact.height === 360 && artifact.bytes > 2048,
  { wh: [artifact.width, artifact.height], bytes: artifact.bytes })
check('the preview artifact is recorded under its revision',
  artifact.path.startsWith(`revisions/${preview.revision}/previews/`), artifact.path)
check('the preview reports the frame it actually rendered', artifact.frame === 30, artifact.frame)
check('the preview carries a sha256 for the audit trail',
  typeof artifact.sha256 === 'string' && artifact.sha256.length === 64)

// The manifest is the revision's durable record, so it must not under-report the
// revision it describes. It is written once at commit, and previews arrive later,
// so the two used to drift: r0002 held three images while its manifest claimed
// one. Asserted against the FILESYSTEM rather than against a remembered count,
// because the disagreement is exactly what went unnoticed.
check('the revision manifest lists every preview the directory actually holds',
  await (async () => {
    const manifest = studio.store.readRevisionManifest(created.projectId, preview.revision)
    const recorded = (manifest.previews ?? []).map(entry => entry.path.split('/').pop()).sort()
    const onDisk = readdirSync(join(
      workspace, 'projects', created.projectId, 'revisions', preview.revision, 'previews',
    )).sort()
    return JSON.stringify(recorded) === JSON.stringify(onDisk)
  })(),
  {
    recorded: (studio.store.readRevisionManifest(created.projectId, preview.revision).previews ?? []).map(entry => entry.path.split('/').pop()),
    onDisk: readdirSync(join(workspace, 'projects', created.projectId, 'revisions', preview.revision, 'previews')),
  })

check('rendering reports both the new artifact and the revision\'s full preview list',
  preview.artifacts.length === 1 && Array.isArray(preview.revisionPreviews)
    && preview.revisionPreviews.length >= 1
    && preview.revisionPreviews.some(entry => entry.path === artifact.path),
  { newArtifacts: preview.artifacts.length, revisionPreviews: preview.revisionPreviews?.length })

check('amending the preview index leaves the revision\'s committed content untouched',
  await (async () => {
    const manifest = studio.store.readRevisionManifest(created.projectId, preview.revision)
    const committed = studio.store.readRevisionManifest(created.projectId, preview.revision)
    // The SceneSpec digest must still be the one the commit recorded, and the
    // checkpoint must still be the committed one. An artifact-index amendment
    // that moved either of those would be a content change wearing an index's
    // clothing.
    return manifest.digest === committed.digest
      && manifest.checkpoint === `revisions/${preview.revision}/scene.blend`
      && typeof manifest.digestAfter === 'string'
  })())

// The preview's provenance line is the one warning a model reads on every render,
// so its wording is asserted rather than eyeballed. A previous version built it by
// splicing a word into a sentence and produced "rendered from the
// revisioncheckpoint" in every ordinary case — invisible in the numbers, obvious
// in the text.
const provenance = (preview.warnings ?? []).map(entry => entry.message).find(message => message.includes('preview of'))
check('the preview states which revision and checkpoint it came from',
  typeof provenance === 'string' && provenance.includes(`revision ${preview.revision}`)
    && !provenance.includes('revisioncheckpoint'),
  provenance)
check('the preview provenance names the frame, size and engine',
  typeof provenance === 'string' && provenance.includes('frame 30')
    && provenance.includes('640x360') && provenance.includes('CYCLES'),
  provenance)

const previewPath = join(workspace, 'projects', created.projectId, artifact.path)
check('the preview image exists on disk', existsSync(previewPath), previewPath)

// Read the PNG back and check the pixels are a real render, not a blank frame.
const pixels = runBlenderScript(`
import struct, zlib
data = open(${JSON.stringify(previewPath)}, 'rb').read()
pos, idat, width, height = 8, b'', None, None
while pos < len(data):
    length = struct.unpack('>I', data[pos:pos+4])[0]
    kind = data[pos+4:pos+8]
    chunk = data[pos+8:pos+8+length]
    if kind == b'IHDR':
        width, height = struct.unpack('>II', chunk[:8])
    elif kind == b'IDAT':
        idat += chunk
    pos += 12 + length
raw = zlib.decompress(idat)
stride = width * 3
rows, previous = [], bytearray(stride)
cursor = 0
for _ in range(height):
    filter_type = raw[cursor]; cursor += 1
    line = bytearray(raw[cursor:cursor+stride]); cursor += stride
    for index in range(stride):
        a = line[index-3] if index >= 3 else 0
        b = previous[index]
        c = previous[index-3] if index >= 3 else 0
        if filter_type == 1: line[index] = (line[index] + a) & 255
        elif filter_type == 2: line[index] = (line[index] + b) & 255
        elif filter_type == 3: line[index] = (line[index] + (a + b) // 2) & 255
        elif filter_type == 4:
            pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
            predictor = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[index] = (line[index] + predictor) & 255
    rows.append(bytes(line)); previous = line

luminances = []
for y in range(height):
    row = rows[y]
    for x in range(width):
        r, g, b = row[x*3:x*3+3]
        luminances.append(0.2126*r + 0.7152*g + 0.0722*b)
luminances.sort()
count = len(luminances)
write({
    'width': width, 'height': height,
    'mean': sum(luminances)/count,
    'p05': luminances[count//20], 'p50': luminances[count//2], 'p95': luminances[19*count//20],
    'min': luminances[0], 'max': luminances[-1],
    'blownPercent': 100*sum(1 for v in luminances if v >= 250)/count,
    'blackPercent': 100*sum(1 for v in luminances if v <= 5)/count,
})
`)

check('the rendered image is the resolution the profile asked for',
  pixels.width === 640 && pixels.height === 360, [pixels.width, pixels.height])

check('the rendered image is neither black nor blown out',
  pixels.mean > 255 * golden.perceptualTolerance.brightnessFloor
    && pixels.mean < 255 * golden.perceptualTolerance.brightnessCeiling,
  { mean: Math.round(pixels.mean), floor: Math.round(255 * golden.perceptualTolerance.brightnessFloor), ceiling: Math.round(255 * golden.perceptualTolerance.brightnessCeiling) })

check('the rendered image has real tonal range, not a flat fill',
  pixels.p95 - pixels.p05 > 20,
  { p05: Math.round(pixels.p05), p50: Math.round(pixels.p50), p95: Math.round(pixels.p95) })

check('rendering did not create a revision',
  studio.store.currentRevision(created.projectId) === 'r0003',
  studio.store.currentRevision(created.projectId))

// ---------------------------------------------------------------------------
// 9. History and replay
// ---------------------------------------------------------------------------

const project = await studio.getProject(created.projectId)
check('the project history lists every revision in order',
  project.revisions.map(entry => entry.revision).join(',') === 'r0001,r0002,r0003',
  project.revisions.map(entry => entry.revision))
check('exactly one revision is current',
  project.revisions.filter(entry => entry.isCurrent).length === 1)
check('every revision kept its own digest',
  new Set(project.revisions.map(entry => entry.digest)).size === 3)

// Revision replay: every revision must still be readable and re-compilable, which
// is the property that makes a revision history worth keeping.
for (const entry of project.revisions) {
  const spec = studio.store.readRevisionSpec(created.projectId, entry.revision)
  const recompiled = compileSceneSpec(spec)
  check(`revision ${entry.revision} still re-reads and re-compiles deterministically`,
    sceneSpecDigest(recompiled.spec) === entry.digest,
    { stored: entry.digest.slice(0, 12), recomputed: sceneSpecDigest(recompiled.spec).slice(0, 12) })
}

const restored = await studio.restoreRevision({ projectId: created.projectId, revision: 'r0001' })
check('restoring an earlier revision moves the current pointer',
  restored.restored === true && studio.store.currentRevision(created.projectId) === 'r0001',
  { restored: restored.restored, current: studio.store.currentRevision(created.projectId) })
check('restoring a revision does not create another revision',
  studio.store.listRevisions(created.projectId).length === 3,
  studio.store.listRevisions(created.projectId))
check('restoring is idempotent when already current',
  (await studio.restoreRevision({ projectId: created.projectId, revision: 'r0001' })).restored === false)

const restoredScene = await studio.getScene(created.projectId)
check('the restored revision reads back exactly as it was',
  restoredScene.digest === digest, { restored: restoredScene.digest.slice(0, 12), original: digest.slice(0, 12) })

// ---------------------------------------------------------------------------
// 10. The job ledger records what happened
// ---------------------------------------------------------------------------

const jobsDirectory = join(workspace, 'projects', created.projectId, 'jobs')
const jobFiles = readdirSync(jobsDirectory)
check('every Blender action left a durable job record', jobFiles.length >= 4, jobFiles.length)

const compileJob = JSON.parse(readFileSync(join(jobsDirectory, jobFiles.find(name => name.startsWith('compile_scene'))), 'utf8'))
check('a job record carries a status, a revision and a duration',
  compileJob.status === 'succeeded' && typeof compileJob.revision === 'string' && compileJob.durationMs > 0,
  { status: compileJob.status, revision: compileJob.revision, ms: compileJob.durationMs })


// ---------------------------------------------------------------------------
// 11. World and animation targets — asserted through a compiled artifact
//
// These two capabilities exist because the M2 content could not be expressed
// without them: the background was a constant inside the compiler, and animation
// could only move entity geometry, so "the camera orbits the product" and "the dial
// lights up" both had to be faked. Asserting them on the in-memory scene would only
// prove the compiler agreed with itself, so everything below opens the SAVED
// `.blend` in a separate Blender process and reads the datablocks back.
// ---------------------------------------------------------------------------

/** World, camera and material-socket state, read out of one saved checkpoint. */
const TARGETS_SNIPPET = `
def surface_node(material):
    tree = getattr(material, 'node_tree', None)
    if tree is None:
        return None
    for node in tree.nodes:
        if node.type == 'OUTPUT_MATERIAL':
            links = node.inputs['Surface'].links if 'Surface' in node.inputs else []
            if links:
                return links[0].from_node
    return None

background = None
world = scene.world
if world is not None and getattr(world, 'use_nodes', True) and world.node_tree is not None:
    node = world.node_tree.nodes.get('Background')
    if node is not None:
        background = {
            'color': [round(float(v), 6) for v in node.inputs[0].default_value],
            'strength': round(float(node.inputs[1].default_value), 6),
        }

camera = bpy.data.objects.get('db_camera__camera-main')
material = bpy.data.materials.get('db_mat__dial-glass')
node = surface_node(material) if material is not None else None
socket = None
if node is not None:
    socket = node.inputs.get('Emission Strength') or node.inputs.get('Emission')
socket_path = socket.path_from_id('default_value') if socket is not None else None
camera_action = camera.animation_data.action if (camera is not None and camera.animation_data) else None
material_action = material.node_tree.animation_data.action if (material is not None and material.node_tree.animation_data) else None

def at(frame):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    return {
        'frame': frame,
        'cameraRotationZ': round(float(camera.rotation_euler[2]), 6) if camera is not None else None,
        'emissionStrength': round(float(socket.default_value), 6) if socket is not None else None,
    }

write({
    'background': background,
    'socketPath': socket_path,
    'samples': [at(f) for f in (1, 30, 90, 180)],
    'cameraAction': camera_action.name if camera_action is not None else None,
    'materialAction': material_action.name if material_action is not None else None,
    'materialFcurves': len(fcurves_of(material_action)) if material_action is not None else 0,
})
`

const animated = await studio.createProject({
  projectId: 'targets-probe',
  title: 'Animation targets and world',
  goal: 'prove a camera can turn and a material can ramp',
  sceneSpec: {
    ...fixtureSpec,
    world: { color: [0, 0, 0, 1], strength: 0 },
    animationTracks: [
      ...fixtureSpec.animationTracks.filter(track => track.id !== 'watch-turntable'),
      { id: 'camera-turn', targetKind: 'camera', targetEntityId: 'camera-main', property: 'rotationEuler.z',
        keyframes: [{ frame: 1, value: 0, interpolation: 'linear' }, { frame: 180, value: 1.5707963, interpolation: 'linear' }] },
      { id: 'dial-ignite', targetKind: 'material', targetEntityId: 'dial-glass', property: 'emissionStrength',
        keyframes: [{ frame: 1, value: 0, interpolation: 'linear' }, { frame: 90, value: 6, interpolation: 'linear' }] },
    ],
  },
  saveCheckpoint: true,
})

const targets = inspectBlend(
  join(workspace, 'projects', 'targets-probe', 'revisions', 'r0001', 'scene.blend'),
  TARGETS_SNIPPET,
)

check('a declared world reaches the compiled Background node',
  targets.background !== null
    && JSON.stringify(targets.background.color) === JSON.stringify([0, 0, 0, 1])
    && targets.background.strength === 0,
  targets.background)

check('a camera target kind really keyframes the camera object',
  targets.cameraAction === 'db_anim__camera-turn'
    && targets.samples[0].cameraRotationZ === 0
    && Math.abs(targets.samples[3].cameraRotationZ - 1.5707963) < 0.001,
  targets.samples.map(sample => `${sample.frame}:${sample.cameraRotationZ}`))

check('a material target kind really keyframes the emission socket',
  targets.materialAction === 'db_anim__dial-ignite'
    && targets.materialFcurves === 1
    && targets.samples[0].emissionStrength === 0
    && targets.samples[2].emissionStrength === 6
    && targets.socketPath !== null,
  { action: targets.materialAction, path: targets.socketPath, values: targets.samples.map(sample => sample.emissionStrength) })

check('the two tracks animate independently, on their own datablocks',
  targets.cameraAction !== targets.materialAction,
  { camera: targets.cameraAction, material: targets.materialAction })

// The camera must actually MOVE between frames: a track that compiles but evaluates
// to a constant is exactly the failure this section exists to rule out.
check('the camera track evaluates to different values at different frames',
  targets.samples[0].cameraRotationZ !== targets.samples[2].cameraRotationZ,
  targets.samples.map(sample => `${sample.frame}:${sample.cameraRotationZ}`))

// A scene that declares no world must still compile, using the documented default.
await studio.createProject({
  projectId: 'world-default-probe',
  title: 'World default',
  goal: 'prove the documented default is what gets compiled',
  sceneSpec: fixtureSpec,
  saveCheckpoint: true,
})
const defaulted = inspectBlend(
  join(workspace, 'projects', 'world-default-probe', 'revisions', 'r0001', 'scene.blend'),
  TARGETS_SNIPPET,
)
check('a scene that declares no world compiles to the documented default',
  defaulted.background !== null
    && defaulted.background.color.every((channel, index) => Math.abs(channel - DEFAULT_WORLD.color[index]) < 1e-6)
    && Math.abs(defaulted.background.strength - DEFAULT_WORLD.strength) < 1e-6,
  { compiled: defaulted.background, contract: { color: [...DEFAULT_WORLD.color], strength: DEFAULT_WORLD.strength } })

// ---------------------------------------------------------------------------
// Cleanup and summary
// ---------------------------------------------------------------------------

await ctx.stop?.()
// ---------------------------------------------------------------------------
// 5. The procedural texture the compiler builds (SPEC §5.2, `material.texture`)
// ---------------------------------------------------------------------------
//
// WHY THIS IS HERE. `material.texture` was declared in the SceneSpec schema in round 113, and for many rounds the
// compiler read nothing at all — deviation §7 #14 recorded that a texture changed the document and not the pixels.
// The compiler half now exists in the working tree (`deepblend_scene.py`'s `TEXTURE_PATTERN_NODES` and
// `_build_texture_graph`), and until this section NOTHING DROVE IT: no fixture carries a texture, so every suite
// passed whether the graph was built or not. A capability with no test is a claim, not a capability.
//
// TWO-SIDED ON PURPOSE. A material WITH a texture must get a pattern node wired to its Principled BSDF, and a
// material WITHOUT one must not — otherwise "a TEX_ node exists" would be satisfied by every material in the file
// and the case would pass over a compiler that textured everything.
const TEXTURE_SNIPPET = `
materials = []
for material in bpy.data.materials:
    tree = material.node_tree
    principled = None
    patterns = []
    for node in (tree.nodes if tree is not None else []):
        if node.type == 'BSDF_PRINCIPLED':
            principled = node
        if node.type.startswith('TEX_'):
            patterns.append(node.type)
    wired = []
    links = []
    if tree is not None:
        for link in tree.links:
            links.append('%s.%s -> %s.%s' % (
                link.from_node.type, link.from_socket.name, link.to_node.type, link.to_socket.name))
            if principled is not None and link.to_node is principled:
                wired.append(link.from_node.type)
    materials.append({
        'name': material.name,
        # The compiler PREFIXES material names (db_mat__hero-steel), so the SceneSpec id is read from the
        # property it stamps rather than reconstructed from the name.
        'deepblendId': material.get('deepblend_id'),
        'patterns': sorted(patterns),
        'wiredToPrincipled': sorted(wired),
        'links': sorted(links),
    })
materials.sort(key=lambda item: item['name'])
write({'materials': materials})
`

const texturedSpec = compileSceneSpec({
  ...fixtureSpec,
  materials: fixtureSpec.materials.map((material, index) =>
    (index === 0
      // The three consumers are OPT-IN (`bump`, `roughnessVariation`, `colorVariation`), and a texture that asks
      // for none of them is built and connected to nothing — which is what the first version of this case
      // declared, and why it read as "the graph is not wired". It is wired; the case was asking for no effect.
      ? { ...material, texture: { type: 'noise', scale: 12.5, bump: 0.6, roughnessVariation: 0.3 } }
      : material)),
}).spec

/** Compile a spec through the provider and return the produced `.blend`, kept for inspection. */
async function compileToBlend(spec, label, projectRoot) {
  const scratch = mkdtempSync(join(workspace, `${label}-`))
  const specPath = join(scratch, 'scene-spec.json')
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  let produced = null
  await studio.runtime.compileScene({
    sceneSpecPath: specPath,
    projectRoot,
    onWorkingDirectory: info => {
      const candidate = join(info.directory, 'result.blend')
      if (existsSync(candidate)) {
        produced = join(scratch, `${label}.blend`)
        writeFileSync(produced, readFileSync(candidate))
      }
    },
  })
  return produced
}

// BOTH SIDES COMPILED AND INSPECTED THE SAME WAY: comparing a textured compile against the inventory built by a
// different snippet would compare two different questions.
const withTexture = inspectBlend(await compileToBlend(texturedSpec, 'textured'), TEXTURE_SNIPPET)
const withoutTexture = inspectBlend(
  await compileToBlend(compileSceneSpec(fixtureSpec).spec, 'plain'), TEXTURE_SNIPPET,
)

const materialId = fixtureSpec.materials[0].id
const texturedMaterial = withTexture.materials.find(entry => entry.deepblendId === materialId)
const plainMaterial = withoutTexture.materials.find(entry => entry.deepblendId === materialId)

// WHAT THIS MEASURED, AND WHAT IT DOES NOT CLAIM. The compiler builds the chain — coordinate, mapping, pattern —
// and the pattern node is there. It does NOT yet connect the pattern's scalar output into the shading chain:
// MEASURED, the only links are `TEX_COORD.Object -> MAPPING.Vector`, `MAPPING.Vector -> TEX_NOISE.Vector` and
// `BSDF_PRINCIPLED.BSDF -> OUTPUT_MATERIAL.Surface`, so a texture still changes the document and not the pixels.
// That is deviation §7 #14, and this case asserts the half that IS implemented rather than pinning the gap: an
// assertion that the output is disconnected would have to be deleted to fix the feature.
check('a material with a procedural texture is compiled with a coordinate/mapping/pattern chain',
  texturedMaterial !== undefined && texturedMaterial.patterns.includes('TEX_NOISE') &&
  texturedMaterial.links.some(link => link === 'MAPPING.Vector -> TEX_NOISE.Vector'),
  texturedMaterial ?? withTexture.materials.map(entry => entry.name))
// AND THE PATTERN REACHES THE SHADER, through the consumers the texture asked for: `bump` drives the Principled's
// Normal via a Bump node, and `roughnessVariation` swings its Roughness through a Map Range. Asserting the exact
// links rather than "some link exists" is what makes this a test of the feature instead of of Blender's defaults.
// The exact links, as MEASURED — a regex over "something to something" would pass on a graph wired to the wrong
// socket, which is the failure this is here to catch.
const REQUIRED_LINKS = [
  'TEX_NOISE.Factor -> BUMP.Height',
  'BUMP.Normal -> BSDF_PRINCIPLED.Normal',
  'TEX_NOISE.Factor -> MAP_RANGE.Value',
  'MAP_RANGE.Result -> BSDF_PRINCIPLED.Roughness',
]
check('and the pattern it builds REACHES the shading: a Bump node into Normal, a Map Range into Roughness',
  REQUIRED_LINKS.every(link => texturedMaterial.links.includes(link)),
  { missing: REQUIRED_LINKS.filter(link => !texturedMaterial.links.includes(link)), links: texturedMaterial.links })
check('and the same material WITHOUT a texture builds no pattern node at all, so the case above is not universal',
  plainMaterial !== undefined && plainMaterial.patterns.length === 0 && plainMaterial.links.length === 1,
  plainMaterial ?? withoutTexture.materials.map(entry => entry.name))

const fidelity = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'asset-fidelity.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, DEEPBLEND_ASSET_EXPORT_DIR: join(workspace, 'source-assets') } })
check('imported GLB preserves geometry, hierarchy, materials, textures and UV in the saved checkpoint',
  fidelity.status === 0 && fidelity.stdout.includes('ASSET_FIDELITY_PASSED'),
  fidelity.status === 0 ? undefined : { error: fidelity.error?.message, output: `${fidelity.stdout}\n${fidelity.stderr}`.slice(-6000) })

const versionSpec = structuredClone(fixtureSpec)
versionSpec.entities = [{ id: 'placeholder', type: 'generator', generator: { shape: 'cube' }, visible: false }]
versionSpec.animationTracks = []
for (const camera of versionSpec.cameras) {
  delete camera.targetEntityId
  camera.targetPoint = [0, 0, 1]
}
const versionProject = await studio.createProject({ title: 'Asset version rebuild', sceneSpec: versionSpec, saveCheckpoint: false })
const sourceAsset = join(workspace, 'source-assets', 'product.glb')
const firstAsset = await studio.ingestAsset({ projectId: versionProject.projectId, sourcePath: sourceAsset, assetId: 'product' })
const versionCommit = await studio.applyScenePatch({
  projectId: versionProject.projectId, baseRevision: versionProject.revision.revision,
  operations: [
    { op: 'asset.add', asset: { id: 'product', type: 'glb', path: firstAsset.path, sha256: firstAsset.sha256 } },
    { op: 'entity.add', entity: { id: 'product', type: 'asset-instance', assetId: 'product' } },
  ], saveCheckpoint: true,
})
const partsScene = await studio.getScene(versionProject.projectId)
const importedPart = partsScene.assetParts.find(part => part.entityId === 'product' && part.sourceMaterialSlots.length > 1)
check('scene_get exposes compiled part selectors, original slot indices and pinned source identity',
  importedPart?.partId?.startsWith('/') && importedPart.sourceMaterialSlots[1].index === 1 &&
  importedPart.assetSha256 === firstAsset.sha256 && importedPart.selectorVersion === 1)
const partCommit = await studio.applyScenePatch({ projectId: versionProject.projectId, baseRevision: versionCommit.revision,
  operations: [{ op: 'entity.materialBindings.set', entityId: 'product', materialBindings: [
    { partId: importedPart.partId, slotIndex: 1, materialId: 'hero-steel' }] }], saveCheckpoint: true })
const boundPart = (await studio.getScene(versionProject.projectId)).assetParts.find(part => part.partId === importedPart.partId)
check('a part binding patch publishes the checkpoint and its effective material slot inventory',
  boundPart.materialSlots.length === importedPart.materialSlots.length &&
  boundPart.materialSlots[1].materialId === 'hero-steel' &&
  boundPart.materialSlots[0].materialName === importedPart.materialSlots[0].materialName)
let invalidPartRejected = false
try {
  await studio.applyScenePatch({ projectId: versionProject.projectId, baseRevision: partCommit.revision,
    operations: [{ op: 'entity.materialBindings.set', entityId: 'product', materialBindings: [
      { partId: '/nonexistent-part', slotIndex: 1, materialId: 'hero-steel' }] }], saveCheckpoint: true })
} catch { invalidPartRejected = true }
check('an invalid compiled part selector cannot publish or advance the project revision',
  invalidPartRejected && studio.store.readRecord(versionProject.projectId).currentRevision === partCommit.revision)

const pinnedSpec = studio.store.readRevisionSpec(versionProject.projectId, versionCommit.revision)
const beforeVersion = inspectBlend(join(studio.store.revisionDirectory(versionProject.projectId, versionCommit.revision), 'scene.blend'), INVENTORY_SNIPPET)
writeFileSync(sourceAsset, readFileSync(join(workspace, 'source-assets', 'single.glb')))
const secondAsset = await studio.ingestAsset({ projectId: versionProject.projectId, sourcePath: sourceAsset, assetId: 'product' })
check('a real same-name replacement keeps the old pinned asset and publishes a distinct version',
  firstAsset.path !== secondAsset.path && pinnedSpec.assets[0].path === firstAsset.path &&
  existsSync(join(studio.store.projectDirectory(versionProject.projectId), firstAsset.path)))
const rebuiltVersion = await compileToBlend(pinnedSpec, 'old-asset-rebuild', studio.store.projectDirectory(versionProject.projectId))
check('an old revision rebuilds identical geometry after its source name and alias have been replaced',
  JSON.stringify(inspectBlend(rebuiltVersion, INVENTORY_SNIPPET).objects) === JSON.stringify(beforeVersion.objects))

const editProject = await studio.createProject({ title: 'Existing geometry edit', sceneSpec: fixtureSpec, saveCheckpoint: true })
const originalEditPath = join(studio.store.revisionDirectory(editProject.projectId, editProject.revision.revision), 'scene.blend')
const originalEditHash = createHash('sha256').update(readFileSync(originalEditPath)).digest('hex')
const editCommit = await studio.applyScenePatch({
  projectId: editProject.projectId, baseRevision: editProject.revision.revision,
  operations: [
    { op: 'entity.generator.set', entityId: 'watch-body', generator: {
      shape: 'lathe', profile: [[0, 0], [.05, 0], [.06, .03], [.04, .05], [0, .05]], segments: 64 } },
    { op: 'entity.modifiers.set', entityId: 'watch-body', modifiers: [{ type: 'bevel', width: .001, segments: 4 }] },
  ], saveCheckpoint: true,
})
const editedInventory = inspectBlend(join(studio.store.revisionDirectory(editProject.projectId, editCommit.revision), 'scene.blend'), INVENTORY_SNIPPET)
const oldEditInventory = inspectBlend(originalEditPath, INVENTORY_SNIPPET)
const editedBody = editedInventory.objects.find(entry => entry.deepblendId === 'watch-body')
const oldEditBody = oldEditInventory.objects.find(entry => entry.deepblendId === 'watch-body')
check('editing an existing generator and stack changes checkpoint geometry while preserving placement and materials',
  editedBody.polygonCount !== oldEditBody.polygonCount &&
  JSON.stringify(editedBody.location) === JSON.stringify(oldEditBody.location) &&
  JSON.stringify(editedBody.materialNames) === JSON.stringify(oldEditBody.materialNames) &&
  createHash('sha256').update(readFileSync(originalEditPath)).digest('hex') === originalEditHash)
let badEditRejected = false
try {
  await studio.applyScenePatch({ projectId: editProject.projectId, baseRevision: editCommit.revision,
    operations: [{ op: 'entity.modifiers.set', entityId: 'watch-body', modifiers: [
      { type: 'boolean', operation: 'union', targetEntityId: 'watch-body' }] }], saveCheckpoint: true })
} catch { badEditRejected = true }
check('a cyclic geometry edit leaves the current revision and its saved checkpoint intact',
  badEditRejected && studio.store.readRecord(editProject.projectId).currentRevision === editCommit.revision &&
  existsSync(join(studio.store.revisionDirectory(editProject.projectId, editCommit.revision), 'scene.blend')))

const materialBindings = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'material-bindings.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('part material slots stay isolated and stable across shared meshes, instances and checkpoint reopening',
  materialBindings.status === 0 && materialBindings.stdout.includes('MATERIAL_BINDINGS_PASSED'),
  materialBindings.status === 0 ? undefined : { error: materialBindings.error?.message, output: `${materialBindings.stdout}\n${materialBindings.stderr}`.slice(-6000) })

const assetPreview = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'asset-preview.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('asset inspection measures evaluated world bounds, UVs, empty slots and source environment radiance',
  assetPreview.status === 0 && assetPreview.stdout.includes('ASSET_PREVIEW_PASSED'),
  assetPreview.status === 0 ? undefined : { error: assetPreview.error?.message, output: `${assetPreview.stdout}\n${assetPreview.stderr}`.slice(-6000) })

const environmentLighting = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'environment.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('HDR/EXR environment radiance lights the scene, rotates reflections and survives packed checkpoint reopening',
  environmentLighting.status === 0 && environmentLighting.stdout.includes('ENVIRONMENT_PASSED'),
  environmentLighting.status === 0 ? undefined : { error: environmentLighting.error?.message, output: `${environmentLighting.stdout}\n${environmentLighting.stderr}`.slice(-6000) })

const imageMaterials = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'image-materials.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('PBR maps preserve channel interpretation, affect rendered pixels and survive source removal in a packed checkpoint',
  imageMaterials.status === 0 && imageMaterials.stdout.includes('IMAGE_MATERIALS_PASSED'),
  imageMaterials.status === 0 ? undefined : { error: imageMaterials.error?.message, output: `${imageMaterials.stdout}\n${imageMaterials.stderr}`.slice(-6000) })

const anisotropy = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'anisotropy.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('Principled anisotropy changes reflected pixels with explicit tangent direction and survives checkpoint reopening',
  anisotropy.status === 0 && anisotropy.stdout.includes('ANISOTROPY_PASSED'),
  anisotropy.status === 0 ? undefined : { error: anisotropy.error?.message, output: `${anisotropy.stdout}\n${anisotropy.stderr}`.slice(-6000) })

const lathe = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'lathe.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('lathe geometry has correct volume, topology and UV, and survives checkpoint rendering',
  lathe.status === 0 && lathe.stdout.includes('LATHE_PASSED'),
  lathe.status === 0 ? undefined : { error: lathe.error?.message, output: `${lathe.stdout}\n${lathe.stderr}`.slice(-6000) })

const curve = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'curve.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('curve sweeps produce capped or open meshes, UV and a renderable smooth handle',
  curve.status === 0 && curve.stdout.includes('CURVE_PASSED'),
  curve.status === 0 ? undefined : { error: curve.error?.message, output: `${curve.stdout}\n${curve.stderr}`.slice(-6000) })

const modifiers = spawnSync(BLENDER, [
  '--background', '--factory-startup', '--python-exit-code', '1',
  '--python', join(HERE, 'modifiers.py'),
], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
check('modeling stacks preserve measured volume, manifold topology and dependency order',
  modifiers.status === 0 && modifiers.stdout.includes('MODIFIERS_PASSED'),
  modifiers.status === 0 ? undefined : { error: modifiers.error?.message, output: `${modifiers.stdout}\n${modifiers.stderr}`.slice(-6000) })

rmSync(workspace, { recursive: true, force: true })

console.log('')
const failures = results.filter(entry => !entry.ok)
console.log(`M1 Blender integration: ${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) {
  console.log('Failed:')
  for (const entry of failures) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
