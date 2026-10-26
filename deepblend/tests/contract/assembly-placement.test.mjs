import test from 'node:test'
import assert from 'node:assert/strict'
import { RecipeCatalog } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { normalizeSurfacePlacementRequest } from '../../../packages/deepblend/host/lib/surface-placement.js'
import { normalizeAssemblyPose, planLampAssemblyPlacement, planRecipeGeometryEdit, applyPatchToSpec,
  compileSceneSpec, validateAssemblyPlacementSelection, verifyAssemblyPlacementReport, sha256,
  ASSEMBLY_PLACEMENT_BASIS_TOLERANCE, ASSEMBLY_PLACEMENT_UV_TOLERANCE, SURFACE_PLACEMENT_LIMITS } from '@deepblend/dsh-blender-contracts'

function lamp() {
  const catalog = new RecipeCatalog(), item = catalog.list().recipes.find(item => item.id === 'deepblend.metal-lamp')
  return catalog.instantiate({ id: item.id, version: item.version, digest: item.digest })
}
const apply = (scene, operations) => compileSceneSpec(applyPatchToSpec(scene,
  { projectId: scene.project.id, baseRevision: 'r0001', operations }).spec).spec

test('one pinned complete lamp request plans all23 world transforms, preserves inputs, and remains resizeable', () => {
  const { lock, sceneSpec } = lamp(), scene = structuredClone(sceneSpec)
  scene.materials.find(material => material.id === 'champagne-spun').parameters.roughness = .517
  scene.cameras.find(camera => camera.id === 'hero').lens = 42
  const input = JSON.stringify({ lock, scene }), angle = 35 * Math.PI / 180
  const plan = planLampAssemblyPlacement(lock, scene, undefined,
    { translationMm: [200, -100, 150], yawDegrees: 35, pivotMm: [80, -30, 0] })
  assert.equal(plan.memberEntityIds.length, 23)
  assert.deepEqual(plan.memberEntityIds, [...plan.memberEntityIds].sort())
  assert.equal(plan.subjectEntityId, 'weighted-base')
  assert.equal(plan.memberEntityIds.includes('studio-floor'), false)
  assert.equal(plan.memberEntityIds.includes('fabric-power-cable'), true)
  const placed = apply(scene, plan.operations)
  for (const id of plan.memberEntityIds) {
    const original = scene.entities.find(entity => entity.id === id), actual = placed.entities.find(entity => entity.id === id)
    const [x, y, z] = original.transform.location
    const expected = [.08 + Math.cos(angle) * (x - .08) - Math.sin(angle) * (y + .03) + .2,
      -.03 + Math.sin(angle) * (x - .08) + Math.cos(angle) * (y + .03) - .1, z + .15]
    assert.ok(actual.transform.location.every((value, index) => Math.abs(value - expected[index]) < 1e-12), id)
    assert.deepEqual(actual.generator, original.generator)
    assert.deepEqual(actual.transform.scale, original.transform.scale)
  }
  assert.deepEqual(placed.cameras, scene.cameras); assert.deepEqual(placed.lights, scene.lights)
  assert.deepEqual(placed.materials, scene.materials)
  const first = planRecipeGeometryEdit(lock, placed, undefined, { 'shade-diameter-mm': 250 })
  const second = planRecipeGeometryEdit(lock, apply(placed, first.operations), first.parameterState, { 'shade-diameter-mm': 230 })
  assert.equal(second.parameterState.values['shade-diameter-mm'], 230)
  assert.equal(JSON.stringify({ lock, scene }), input)
})

test('omitted pivot follows the already placed base; static no-op still verifies every member', () => {
  const { lock, sceneSpec } = lamp()
  const translated = apply(sceneSpec, planLampAssemblyPlacement(lock, sceneSpec, undefined, { translationMm: [200, -100, 150] }).operations)
  const next = planLampAssemblyPlacement(lock, translated, undefined, { yawDegrees: 90 })
  assert.ok(next.pose.pivotMm.every((v, i) => Math.abs(v - [200, -100, 150][i]) < 1e-9))
  const anchor = next.operations.find(operation => operation.entityId === 'weighted-base')
  assert.ok(anchor.location.every((v, i) => Math.abs(v - [.2, -.1, .15][i]) < 1e-12))
  const broken = structuredClone(translated); broken.entities.find(entity => entity.id === 'fabric-power-cable').transform.location[0] += .01
  assert.throws(() => planLampAssemblyPlacement(lock, broken, undefined, {}), error => error.code === 'RECIPE_PARAMETER_CONFLICT')
})

for (const [label, change] of [
  ['missing cable', scene => { scene.entities = scene.entities.filter(entity => entity.id !== 'fabric-power-cable') }],
  ['individually moved unbound bulb', scene => { scene.entities.find(entity => entity.id === 'opal-bulb').transform.location[0] += .01 }],
  ['one scaled member', scene => { scene.entities.find(entity => entity.id === 'weighted-base').transform.scale = [1, 1, 1.1] }],
  ['independently changed controlled shell', scene => { scene.entities.find(entity => entity.id === 'shade-shell').generator.profile[0][0] += .001 }],
]) test(`complete assembly refuses ${label} without a partial plan`, () => {
  const { lock, sceneSpec } = lamp(), before = JSON.stringify(sceneSpec); change(sceneSpec)
  assert.throws(() => planLampAssemblyPlacement(lock, sceneSpec, undefined, {}), error => ['RECIPE_PARAMETER_CONFLICT', 'RECIPE_SCENE_INVALID'].includes(error.code))
  assert.notEqual(JSON.stringify(sceneSpec), before)
})

test('recipe provenance cannot be replaced by guessed entity names', () => {
  const { lock, sceneSpec } = lamp()
  assert.throws(() => planLampAssemblyPlacement({ ...lock, manifestSha256: '0'.repeat(64) }, sceneSpec, undefined, {}),
    error => error.code === 'BLENDER_UNSUPPORTED_ACTION')
})

for (const pose of [null, [], { translate: [1, 2, 3] }, { translationMm: null }, { yawDegrees: null },
  { translationMm: [1, 2] }, { translationMm: [true, 0, 0] }, { pivotMm: [0, 0, Infinity] },
  { translationMm: [1_000_001, 0, 0] }, { yawDegrees: 360.01 }, { yawDegrees: '35' }]) {
  test(`world pose rejects unsupported or ambiguous input ${JSON.stringify(pose)}`, () => {
    assert.throws(() => normalizeAssemblyPose(pose), error => error.code === 'SCENE_PATCH_INVALID')
  })
}

test('existing entity requests retain their shape; whole assembly scope is explicit and bounded', () => {
  const input = { projectId: 'lamp', baseRevision: 'r0002', subjectEntityId: 'weighted-base', supportEntityId: 'table', frame: 24 }
  const ordinary = normalizeSurfacePlacementRequest(input, '/store')
  assert.equal(Object.hasOwn(ordinary, 'scope'), false); assert.equal(Object.hasOwn(ordinary, 'pose'), false)
  assert.deepEqual(normalizeSurfacePlacementRequest({ ...input, scope: 'entity' }, '/store'), ordinary)
  const assembly = normalizeSurfacePlacementRequest({ ...input, scope: 'recipe-assembly', pose: { yawDegrees: 35 } }, '/store')
  assert.deepEqual(assembly.pose, { translationMm: [0, 0, 0], yawDegrees: 35 })
  for (const changes of [{ pose: {} }, { scope: 'selected-names' }, { scope: 'recipe-assembly', memberEntityIds: ['weighted-base'] }]) {
    assert.throws(() => normalizeSurfacePlacementRequest({ ...input, ...changes }, '/store'), error => error.code === 'SCENE_PATCH_INVALID')
  }
})

const identity = z => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, z], [0, 0, 0, 1]]
const geometry = z => ({ meshObjectCount: 1, vertexCount: 3, triangleCount: 1,
  rootWorldMatrix: identity(z), worldBoundsMeters: { min: [0, 0, z], max: [1, 1, z + .1] } })
function evidence(baseline = false) {
  const pose = normalizeAssemblyPose(), members = [{ entityId: 'cable', geometry: geometry(3) }, { entityId: 'weighted-base', geometry: geometry(4) }]
  const request = { checkpointPath: '/candidate.blend', checkpointSha256: sha256('candidate'), subjectEntityId: 'weighted-base',
    memberEntityIds: ['cable', 'weighted-base'], supportEntityId: 'ramp', frame: 24, clearanceMm: 2, pose,
    ...(baseline ? { baselineCheckpointPath: '/baseline.blend', baselineCheckpointSha256: sha256('baseline'), expectedWorldMatrixMeters: identity(-1.998) } : {}) }
  const report = { schemaVersion: 'deepblend.assembly-placement/v1', axis: 'world-z', checkpointSha256: request.checkpointSha256,
    checkpointUnchanged: true, frame: 24, blenderVersion: '5.2.1', subjectEntityId: request.subjectEntityId, memberEntityIds: request.memberEntityIds,
    supportEntityId: 'ramp', clearanceMm: 2, translationMeters: [0, 0, -1.998], subjectContactMeters: [0, 0, 3],
    supportContactMeters: [0, 0, 1], placedSubjectContactMeters: [0, 0, 1.002], subjectTriangleIndex: 0, supportTriangleIndex: 0,
    subjectContactEntityId: 'cable', statistics: { candidatePairs: 2 }, pose, poseMatrixMeters: identity(0), resultWorldMatrixMeters: identity(-1.998),
    members, subject: { ...geometry(4), meshObjectCount: 2, vertexCount: 6, triangleCount: 2, worldBoundsMeters: { min: [0, 0, 3], max: [1, 1, 4.1] } }, support: geometry(1),
    ...(baseline ? { baselineVerification: { checkpointSha256: request.baselineCheckpointSha256, checkpointUnchanged: true,
      worldMatrixMeters: request.expectedWorldMatrixMeters, members: request.memberEntityIds.map(entityId => ({ entityId, rigidTransform: true,
        maxVertexErrorMeters: 1e-7, maxRootPositionErrorMeters: 1e-7, maxRootBasisError: 1e-8, maxUvError: 0 })), supportUnchanged: true,
      supportMaxErrorMeters: 0, toleranceMeters: SURFACE_PLACEMENT_LIMITS.toleranceMeters, basisTolerance: ASSEMBLY_PLACEMENT_BASIS_TOLERANCE,
      uvTolerance: ASSEMBLY_PLACEMENT_UV_TOLERANCE } } : {}) }
  return { request, report }
}

test('native evidence binds complete membership, contact owner, aggregate counts and one rigid pose', () => {
  for (const baseline of [false, true]) { const { request, report } = evidence(baseline); assert.equal(verifyAssemblyPlacementReport(report, request), report) }
})

for (const [label, change] of [
  ['missing final native member', r => { r.members.pop() }],
  ['reordered native members', r => { r.members.reverse() }],
  ['changed member selection', r => { r.memberEntityIds = ['weighted-base'] }],
  ['base-only union counts', r => { r.subject.meshObjectCount = 1 }],
  ['base-only union bounds', r => { r.subject.worldBoundsMeters.min[2] = 4 }],
  ['false base contact owner', r => { r.subjectContactEntityId = 'weighted-base' }],
  ['unrequested pivot', r => { r.pose.pivotMm[0] = 10 }],
  ['wrong rigid result', r => { r.resultWorldMatrixMeters[0][3] = .1 }],
  ['unverified native source', r => { r.checkpointUnchanged = false }],
  ['unsupported stability claim', r => { r.physicallyStable = true }],
  ['missing last candidate proof', r => { r.baselineVerification.members.pop() }],
  ['unmoved last member', r => { r.baselineVerification.members[1].rigidTransform = false }],
  ['candidate geometry drift', r => { r.baselineVerification.members[1].maxVertexErrorMeters = .001 }],
  ['candidate basis drift', r => { r.baselineVerification.members[1].maxRootBasisError = .001 }],
  ['candidate UV drift', r => { r.baselineVerification.members[1].maxUvError = .001 }],
  ['support moved', r => { r.baselineVerification.supportUnchanged = false }],
  ['wrong baseline', r => { r.baselineVerification.checkpointSha256 = sha256('wrong') }],
]) test(`complete native proof rejects ${label}`, () => {
  const { request, report } = evidence(true), altered = structuredClone(report); change(altered)
  assert.throws(() => verifyAssemblyPlacementReport(altered, request), error => error.code === 'SCENE_VALIDATION_FAILED')
})

test('candidate verification cannot substitute a shear or partial baseline selection', () => {
  const { request } = evidence(true); request.expectedWorldMatrixMeters[0][1] = .1
  assert.throws(() => validateAssemblyPlacementSelection(request), error => error.code === 'SCENE_PATCH_INVALID')
  delete request.expectedWorldMatrixMeters
  assert.throws(() => validateAssemblyPlacementSelection(request), error => error.code === 'SCENE_PATCH_INVALID')
})
