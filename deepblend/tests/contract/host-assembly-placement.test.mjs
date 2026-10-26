/** Transaction tests use an explicit JSON runtime double; native geometry is tested separately. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { requiredSceneFeatures, SURFACE_PLACEMENT_LIMITS, ASSEMBLY_PLACEMENT_BASIS_TOLERANCE,
  ASSEMBLY_PLACEMENT_UV_TOLERANCE } from '@deepblend/dsh-blender-contracts'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const multiply = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)))
function matrix(entity) {
  const [x, y, z] = entity.transform.rotationEuler, c = Math.cos, s = Math.sin
  const r = multiply(multiply([[c(z), -s(z), 0], [s(z), c(z), 0], [0, 0, 1]],
    [[c(y), 0, s(y)], [0, 1, 0], [-s(y), 0, c(y)]]), [[1, 0, 0], [0, c(x), -s(x)], [0, s(x), c(x)]])
  return [...r.map((row, i) => [...row, entity.transform.location[i]]), [0, 0, 0, 1]]
}
function nativeDouble(input) {
  const spec = JSON.parse(readFileSync(input.checkpointPath)).spec
  const angle = input.pose.yawDegrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle)
  const [px, py] = input.pose.pivotMm.map(value => value / 1000), [dx, dy, dz] = input.pose.translationMm.map(value => value / 1000)
  const poseMatrix = [[c, -s, 0, px-c*px+s*py+dx], [s, c, 0, py-s*px-c*py+dy], [0, 0, 1, dz], [0, 0, 0, 1]]
  const members = input.memberEntityIds.map(entityId => {
    const entity = spec.entities.find(entity => entity.id === entityId), world = multiply(poseMatrix, matrix(entity)), p = world.slice(0, 3).map(row => row[3])
    return { entityId, geometry: { meshObjectCount: 1, vertexCount: 3, triangleCount: 1, rootWorldMatrix: world,
      worldBoundsMeters: { min: [p[0]-.001, p[1]-.001, p[2]], max: [p[0]+.001, p[1]+.001, p[2]+.001] } } }
  })
  const contact = members.reduce((best, member, index) => member.geometry.worldBoundsMeters.min[2] < members[best].geometry.worldBoundsMeters.min[2] ? index : best, 0)
  const root = members[contact].geometry.rootWorldMatrix, point = root.slice(0, 3).map(row => row[3])
  const delta = input.clearanceMm / 1000 - point[2], result = structuredClone(poseMatrix); result[2][3] += delta
  const anchor = members.find(member => member.entityId === input.subjectEntityId)
  return { schemaVersion: 'deepblend.assembly-placement/v1', axis: 'world-z', checkpointSha256: input.checkpointSha256,
    checkpointUnchanged: true, frame: input.frame, blenderVersion: 'explicit-unit-runtime-double', subjectEntityId: input.subjectEntityId,
    memberEntityIds: input.memberEntityIds, supportEntityId: input.supportEntityId, clearanceMm: input.clearanceMm,
    pose: input.pose, poseMatrixMeters: poseMatrix, resultWorldMatrixMeters: result, members,
    translationMeters: [0, 0, delta], subjectContactMeters: point, supportContactMeters: [point[0], point[1], 0],
    placedSubjectContactMeters: [point[0], point[1], point[2]+delta], subjectContactEntityId: members[contact].entityId,
    subjectTriangleIndex: contact, supportTriangleIndex: 0, statistics: { candidatePairs: members.length },
    subject: { meshObjectCount: members.length, vertexCount: members.length*3, triangleCount: members.length,
      rootWorldMatrix: anchor.geometry.rootWorldMatrix, worldBoundsMeters: {
        min: [0, 1, 2].map(axis => Math.min(...members.map(member => member.geometry.worldBoundsMeters.min[axis]))),
        max: [0, 1, 2].map(axis => Math.max(...members.map(member => member.geometry.worldBoundsMeters.max[axis]))) } },
    support: { meshObjectCount: 1, vertexCount: 3, triangleCount: 1,
      rootWorldMatrix: matrix(spec.entities.find(entity => entity.id === input.supportEntityId)),
      worldBoundsMeters: { min: [-2, -2, 0], max: [2, 2, 0] } },
    ...(input.baselineCheckpointPath ? { baselineVerification: { checkpointSha256: input.baselineCheckpointSha256,
      checkpointUnchanged: true, worldMatrixMeters: input.expectedWorldMatrixMeters,
      members: input.memberEntityIds.map(entityId => ({ entityId, rigidTransform: true, maxVertexErrorMeters: 0,
        maxRootPositionErrorMeters: 0, maxRootBasisError: 0, maxUvError: 0 })), supportUnchanged: true, supportMaxErrorMeters: 0,
      toleranceMeters: SURFACE_PLACEMENT_LIMITS.toleranceMeters, basisTolerance: ASSEMBLY_PLACEMENT_BASIS_TOLERANCE,
      uvTolerance: ASSEMBLY_PLACEMENT_UV_TOLERANCE } } : {}) }
}

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-assembly-placement-')), ctx = new Context(), hooks = {}, calls = { inspect: [], compile: [], preview: [] }
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const runtime = {
    getCapabilities: async () => ({ installed: true, sceneFeatures: requiredSceneFeatures(JSON.parse(readFileSync(calls.compile.at(-1).sceneSpecPath))) }),
    compileScene: async input => {
      calls.compile.push(input); const spec = JSON.parse(readFileSync(input.sceneSpecPath))
      const directory = join(dirname(input.sceneSpecPath), 'compiler'); mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'result.blend'), JSON.stringify({ spec })); input.onWorkingDirectory({ directory })
      return { report: { sceneFingerprint: { totalPolygons: 1 }, validation: { ok: true } }, envelope: {} }
    },
    inspectAssemblyPlacement: async input => {
      calls.inspect.push(input); const report = nativeDouble(input); await hooks.inspect?.(input, report); return { report }
    },
    resolveEngineKey: async () => ({ warning: null, blenderEngine: 'CYCLES' }),
    renderPreview: async input => {
      calls.preview.push(input); writeFileSync(input.outputPath, 'unit-preview'); return { report: { frame: input.frame, cameraId: input.cameraId }, envelope: {} }
    },
  }
  // The capability double answers only fixed known features, independent of operation success.
  runtime.getCapabilities = async () => ({ installed: true, sceneFeatures: ['geometry.primitive.dimensions', 'geometry.modifier.subdivision', 'material.uv', 'material.tangent.radial', 'geometry.lathe.closed-profile'] })
  ctx.provide('blenderRuntime', runtime)
  const studio = new Studio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const recipe = studio.listRecipes().recipes.find(recipe => recipe.id === 'deepblend.metal-lamp')
  const made = await studio.createProject({ title: 'Complete lamp', recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest }, saveCheckpoint: true })
  const projectId = made.projectId, project = studio.store.projectDirectory(projectId), origin = studio.store.revisionDirectory(projectId, 'r0001')
  return { root, studio, runtime, hooks, calls, project, origin,
    request: { projectId, baseRevision: 'r0001', scope: 'recipe-assembly', subjectEntityId: 'weighted-base', supportEntityId: 'studio-floor', frame: 24,
      clearanceMm: 1.5, pose: { translationMm: [200, -100, 150], yawDegrees: 35, pivotMm: [80, -30, 0] }, renderPreview: false } }
}
function unpublished(s, record, next = 'r0002') {
  assert.deepEqual(s.studio.store.readRecord(s.request.projectId), record)
  assert.equal(existsSync(s.studio.store.revisionDirectory(s.request.projectId, next)), false)
  assert.deepEqual(readdirSync(join(s.project, 'staging')), [])
  assert.equal(readdirSync(s.project).some(name => name.startsWith('.surface-placement-')), false)
}

test('one complete save persists a bound23-member receipt, exposes scope, and replays after a later revision without native work', async t => {
  const s = await setup(t), history = ['scene-spec.json', 'scene.blend', 'recipe-lock.json'].map(name => [name, readFileSync(join(s.origin, name))])
  const source = await s.studio.getScene(s.request.projectId)
  assert.equal(source.assemblyPlacement.available, true); assert.equal(source.assemblyPlacement.memberCount, 23)
  const saved = await s.studio.placeOnSurface({ ...s.request, renderPreview: true, idempotencyKey: 'whole-lamp' })
  assert.equal(saved.revision, 'r0002'); assert.equal(saved.surfacePlacementReceipt.memberEntityIds.length, 23)
  assert.equal(saved.surfacePlacementReceipt.after.baselineVerification.members.length, 23)
  assert.equal(saved.surfacePlacementReceipt.sourceRevision, 'r0001'); assert.equal(saved.previews[0].frame, 24)
  assert.equal(s.calls.inspect.length, 2); assert.equal(s.calls.compile.length, 2); assert.equal(s.calls.preview.length, 1)
  assert.equal(s.calls.compile.at(-1).session, false)
  const placed = s.studio.store.readRevisionSpec(s.request.projectId, 'r0002'), original = s.studio.store.readRevisionSpec(s.request.projectId, 'r0001')
  assert.deepEqual(placed.cameras, original.cameras); assert.deepEqual(placed.lights, original.lights); assert.deepEqual(placed.materials, original.materials)
  assert.deepEqual(placed.entities.find(entity => entity.id === 'studio-floor'), original.entities.find(entity => entity.id === 'studio-floor'))
  assert.equal((await s.studio.getRecipeParameters(s.request.projectId)).placement.available, true)
  await s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0002', saveCheckpoint: false,
    operations: [{ op: 'material.parameter.update', materialId: 'champagne-spun', parameter: 'roughness', value: .517 }] })
  const counts = [s.calls.inspect.length, s.calls.compile.length, s.calls.preview.length]
  const replay = await s.studio.placeOnSurface({ ...s.request, renderPreview: true, idempotencyKey: 'whole-lamp' })
  assert.equal(replay.idempotentReplay, true); assert.equal(replay.revision, 'r0002')
  assert.deepEqual([s.calls.inspect.length, s.calls.compile.length, s.calls.preview.length], counts)
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, idempotencyKey: 'whole-lamp', clearanceMm: 2 }), { code: 'SCENE_PATCH_REJECTED' })
  for (const [name, bytes] of history) assert.deepEqual(readFileSync(join(s.origin, name)), bytes)
})

test('last-member native failure refuses the entire candidate and leaves source bytes/current revision intact', async t => {
  const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId), old = readFileSync(join(s.origin, 'scene.blend'))
  s.hooks.inspect = (input, report) => { if (input.baselineCheckpointPath) report.baselineVerification.members.at(-1).rigidTransform = false }
  await assert.rejects(s.studio.placeOnSurface(s.request), { code: 'SCENE_VALIDATION_FAILED' })
  unpublished(s, record); assert.deepEqual(readFileSync(join(s.origin, 'scene.blend')), old)
})

test('source and inherited recipe-lock changes during native measurement are refused before publication', async t => {
  const s = await setup(t)
  await s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0001', saveCheckpoint: true,
    operations: [{ op: 'material.parameter.update', materialId: 'champagne-spun', parameter: 'roughness', value: .4 }] })
  s.request.baseRevision = 'r0002'; const record = s.studio.store.readRecord(s.request.projectId)
  s.hooks.inspect = () => { const path = join(s.origin, 'recipe-lock.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n') }
  await assert.rejects(s.studio.placeOnSurface(s.request), { code: 'SCENE_VALIDATION_FAILED' })
  unpublished(s, record, 'r0003')
})

test('cancellation after native inspection publishes no revision or residual staging files', async t => {
  const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId), abort = new AbortController()
  s.hooks.inspect = () => abort.abort()
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, signal: abort.signal }), { code: 'BLENDER_ABORTED' })
  unpublished(s, record); assert.equal(s.calls.compile.length, 1)
})

test('concurrent complete-placement intents serialize and a stale second writer cannot move the lamp again', async t => {
  const s = await setup(t)
  const results = await Promise.allSettled([s.studio.placeOnSurface({ ...s.request, idempotencyKey: 'one' }), s.studio.placeOnSurface({ ...s.request, idempotencyKey: 'two' })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT')
  assert.equal(s.calls.inspect.length, 2); assert.equal(s.studio.store.readRecord(s.request.projectId).currentRevision, 'r0002')
})

test('partial assembly and internal support selections refuse before any native call', async t => {
  const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId)
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, supportEntityId: 'fabric-power-cable' }), { code: 'SCENE_PATCH_INVALID' })
  unpublished(s, record); assert.equal(s.calls.inspect.length, 0)
  await s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0001', saveCheckpoint: true,
    operations: [{ op: 'entity.remove', entityId: 'fabric-power-cable' }] })
  const partial = s.studio.store.readRecord(s.request.projectId)
  const description = await s.studio.getScene(s.request.projectId)
  assert.equal(description.assemblyPlacement.available, false)
  assert.equal(description.assemblyPlacement.error.code, 'RECIPE_PARAMETER_CONFLICT')
  assert.equal((await s.studio.getRecipeParameters(s.request.projectId)).placement.available, false)
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, baseRevision: 'r0002' }), { code: 'RECIPE_PARAMETER_CONFLICT' })
  unpublished(s, partial, 'r0003'); assert.equal(s.calls.inspect.length, 0)
})
