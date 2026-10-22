import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { sha256, BlenderErrorCode, SURFACE_PLACEMENT_LIMITS } from '@deepblend/dsh-blender-contracts'

const fixture = new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)
const identity = location => [[1, 0, 0, location[0]], [0, 1, 0, location[1]], [0, 0, 1, location[2]], [0, 0, 0, 1]]

function nativeReport(input) {
  const spec = JSON.parse(readFileSync(input.checkpointPath, 'utf8')).spec
  const location = spec.entities.find(entity => entity.id === input.subjectEntityId).transform.location
  const bottom = location[2] - .1, top = .2, delta = top + input.clearanceMm / 1000 - bottom
  const object = (root, low, high) => ({ meshObjectCount: 1, vertexCount: 8, triangleCount: 12,
    rootWorldMatrix: identity(root), worldBoundsMeters: { min: [-1, -1, low], max: [1, 1, high] } })
  return { schemaVersion: 'deepblend.surface-placement/v1', axis: 'world-z', checkpointSha256: input.checkpointSha256,
    checkpointUnchanged: true, frame: input.frame, blenderVersion: '5.2.1', subjectEntityId: input.subjectEntityId,
    supportEntityId: input.supportEntityId, clearanceMm: input.clearanceMm, translationMeters: [0, 0, delta],
    subjectContactMeters: [.1, .2, bottom], supportContactMeters: [.1, .2, top], placedSubjectContactMeters: [.1, .2, bottom + delta],
    subjectTriangleIndex: 0, supportTriangleIndex: 0, statistics: { candidatePairs: 4 },
    subject: object(location, bottom, bottom + .2), support: object([0, 0, 0], 0, top),
    ...(input.baselineCheckpointPath ? { baselineVerification: { checkpointSha256: input.baselineCheckpointSha256,
      checkpointUnchanged: true, translationMeters: input.expectedTranslationMeters, subjectRigidTranslation: true,
      supportUnchanged: true, subjectMaxErrorMeters: 0, supportMaxErrorMeters: 0, toleranceMeters: SURFACE_PLACEMENT_LIMITS.toleranceMeters } } : {}) }
}

async function setup(t, { changeSpec } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-placement-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calls = { inspect: [], compile: [], preview: [] }, hooks = {}
  const runtime = {
    getCapabilities: async () => ({ installed: true, sceneFeatures: ['geometry.primitive.dimensions', 'geometry.modifier.subdivision'] }),
    compileScene: async input => {
      calls.compile.push(input)
      const spec = JSON.parse(readFileSync(input.sceneSpecPath, 'utf8'))
      const directory = join(dirname(input.sceneSpecPath), 'compiler'); mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'result.blend'), JSON.stringify({ spec }))
      input.onWorkingDirectory({ directory })
      await hooks.compile?.(input)
      return { report: { sceneFingerprint: { totalPolygons: 24 }, validation: { ok: true } }, envelope: {} }
    },
    inspectSurfacePlacement: async input => {
      calls.inspect.push(input)
      const report = nativeReport(input)
      await hooks.inspect?.(input, report)
      return { report, envelope: {} }
    },
    resolveEngineKey: async () => ({ warning: null, blenderEngine: 'BLENDER_EEVEE_NEXT' }),
    renderPreview: async input => {
      calls.preview.push(input); writeFileSync(input.outputPath, 'fixture-preview')
      const report = { frame: input.frame, cameraId: input.cameraId }
      await hooks.preview?.(input, report)
      return { report, envelope: {} }
    },
  }
  const context = new Context(); context.provide('blenderRuntime', runtime)
  const studio = new BlenderStudio(context, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const sceneSpec = JSON.parse(readFileSync(fixture, 'utf8'))
  sceneSpec.entities = sceneSpec.entities.filter(entity => ['watch-body', 'stage'].includes(entity.id))
  sceneSpec.entities.find(entity => entity.id === 'watch-body').transform.location = [.1, .2, 1]
  sceneSpec.animationTracks = []
  changeSpec?.(sceneSpec)
  const created = await studio.createProject({ title: 'Surface placement', sceneSpec, saveCheckpoint: true })
  const projectId = created.projectId
  const request = { projectId, baseRevision: 'r0001', subjectEntityId: 'watch-body', supportEntityId: 'stage', frame: 7 }
  return { root, studio, runtime, calls, hooks, request,
    origin: studio.store.revisionDirectory(projectId, 'r0001'), project: studio.store.projectDirectory(projectId) }
}

function assertUnpublished(s, originalRecord) {
  assert.deepEqual(s.studio.store.readRecord(s.request.projectId), originalRecord)
  assert.equal(existsSync(s.studio.store.revisionDirectory(s.request.projectId, 'r0002')), false)
  assert.deepEqual(readdirSync(join(s.project, 'staging')), [])
  assert.equal(readdirSync(s.project).some(name => name.startsWith('.surface-placement-')), false)
}

test('placement changes only subject Z, validates native baseline, previews the same frame and persists its receipt', async t => {
  const s = await setup(t)
  const before = s.studio.store.readRevisionSpec(s.request.projectId, 'r0001')
  const files = ['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(name => [name, readFileSync(join(s.origin, name))])
  assert.equal(s.studio.surfacePlacementSupported, true)
  const saved = await s.studio.placeOnSurface({ ...s.request, clearanceMm: 2 })
  assert.equal(saved.revision, 'r0002'); assert.equal(saved.idempotentReplay, false)
  assert.equal(saved.projectDirectory, s.project)
  assert.ok(existsSync(join(saved.projectDirectory, saved.checkpoint)))
  assert.ok(existsSync(join(saved.projectDirectory, saved.previews[0].path)))
  assert.equal(saved.idempotencyKeyDerived, true); assert.equal(saved.previews[0].frame, 7)
  const after = s.studio.store.readRevisionSpec(s.request.projectId, saved.revision)
  const expected = structuredClone(before)
  expected.entities.find(entity => entity.id === 'watch-body').transform.location[2] += saved.surfacePlacementReceipt.translationMeters[2]
  assert.deepEqual(after, expected)
  assert.equal(s.calls.compile.at(-1).session, false); assert.equal(s.calls.preview[0].session, false)
  assert.equal(s.calls.preview[0].frame, 7); assert.equal(s.calls.inspect.length, 2)
  assert.deepEqual(s.calls.inspect[1].expectedTranslationMeters, saved.surfacePlacementReceipt.translationMeters)
  assert.equal(s.calls.inspect[1].baselineCheckpointSha256, saved.surfacePlacementReceipt.sourceCheckpointSha256)
  assert.equal(saved.surfacePlacementReceipt.resultCheckpointSha256, sha256(readFileSync(join(s.studio.store.revisionDirectory(s.request.projectId, 'r0002'), 'scene.blend'))))
  assert.deepEqual(s.studio.store.readRevisionManifest(s.request.projectId, 'r0002').surfacePlacementReceipt, saved.surfacePlacementReceipt)
  for (const [name, bytes] of files) assert.deepEqual(readFileSync(join(s.origin, name)), bytes)
})

test('logical intent replays after the current revision advances and mismatched/cross-operation keys refuse before native work', async t => {
  const s = await setup(t), intent = { ...s.request, renderPreview: false, idempotencyKey: 'placement-1' }
  const saved = await s.studio.placeOnSurface(intent)
  await s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0002', saveCheckpoint: false,
    operations: [{ op: 'entity.transform.update', entityId: 'stage', location: [0, 0, -.1] }] })
  const count = s.calls.inspect.length, replay = await s.studio.placeOnSurface(intent)
  assert.equal(replay.idempotentReplay, true); assert.equal(replay.revision, saved.revision)
  assert.equal(replay.projectDirectory, s.project)
  assert.deepEqual(replay.surfacePlacementReceipt, saved.surfacePlacementReceipt); assert.equal(s.calls.inspect.length, count)
  await assert.rejects(s.studio.placeOnSurface({ ...intent, clearanceMm: 1 }), { code: 'SCENE_PATCH_REJECTED' })
  await assert.rejects(s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0003', idempotencyKey: intent.idempotencyKey,
    saveCheckpoint: false, operations: [{ op: 'entity.transform.update', entityId: 'stage', location: [0, 0, 0] }] }), { code: 'SCENE_PATCH_REJECTED' })
  await s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0003', idempotencyKey: 'ordinary', saveCheckpoint: false,
    operations: [{ op: 'entity.transform.update', entityId: 'stage', location: [0, 0, 0] }] })
  await assert.rejects(s.studio.placeOnSurface({ ...intent, baseRevision: 'r0004', idempotencyKey: 'ordinary' }), { code: 'SCENE_PATCH_REJECTED' })
  assert.equal(s.calls.inspect.length, count)
})

test('missing frame, wrong project store and stale base refuse without native work', async t => {
  const s = await setup(t)
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, frame: undefined }), { code: 'SCENE_PATCH_INVALID' })
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, clearanceMm: null }), { code: 'SCENE_PATCH_INVALID' })
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, projectsRoot: s.project }), { code: 'REVISION_CONFLICT' })
  await assert.rejects(s.studio.placeOnSurface({ ...s.request, baseRevision: 'r0009' }), { code: 'REVISION_CONFLICT' })
  assert.equal(s.calls.inspect.length, 0)
})

test('selected animation and external geometry dependencies refuse without native work', async t => {
  for (const kind of ['animation', 'dependent']) {
    const s = await setup(t, { changeSpec: spec => {
      if (kind === 'animation') spec.animationTracks = [{ id: 'move', targetEntityId: 'watch-body', property: 'location.z', keyframes: [{ frame: 1, value: 1 }, { frame: 10, value: 2 }] }]
      else spec.entities.find(entity => entity.id === 'stage').modifiers = [{ type: 'boolean', operation: 'difference', targetEntityId: 'watch-body' }]
    } })
    await assert.rejects(s.studio.placeOnSurface(s.request), { code: BlenderErrorCode.UNSUPPORTED_ACTION })
    assert.equal(s.calls.inspect.length, 0)
  }
})

test('source, manifest, baseline and candidate drift are refused without a published revision', async t => {
  for (const attack of ['source', 'manifest', 'baseline', 'candidate']) {
    const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId)
    if (attack === 'source') s.hooks.compile = () => writeFileSync(join(s.origin, 'scene.blend'), 'external mutation')
    if (attack === 'manifest') s.hooks.preview = () => writeFileSync(join(s.origin, 'revision-manifest.json'), '{}')
    if (attack === 'baseline') s.hooks.inspect = input => { if (input.baselineCheckpointPath) writeFileSync(input.baselineCheckpointPath, 'changed') }
    if (attack === 'candidate') s.hooks.preview = input => writeFileSync(input.checkpointPath, 'changed')
    await assert.rejects(s.studio.placeOnSurface(s.request), { code: 'SCENE_VALIDATION_FAILED' })
    assertUnpublished(s, record)
  }
})

test('a scene description changed during compile, verification or preview cannot be published with a different native checkpoint', async t => {
  for (const phase of ['compile', 'verification', 'preview']) {
    const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId)
    const change = path => {
      const spec = JSON.parse(readFileSync(path, 'utf8'))
      spec.entities.find(entity => entity.id === s.request.subjectEntityId).transform.location[0] += 100
      writeFileSync(path, JSON.stringify(spec))
    }
    if (phase === 'compile') s.hooks.compile = input => change(input.sceneSpecPath)
    if (phase === 'verification') s.hooks.inspect = input => {
      if (input.baselineCheckpointPath) change(join(dirname(input.checkpointPath), 'scene-spec.json'))
    }
    if (phase === 'preview') s.hooks.preview = input => change(join(dirname(input.checkpointPath), 'scene-spec.json'))
    await assert.rejects(s.studio.placeOnSurface({ ...s.request, renderPreview: phase === 'preview' }), { code: 'SCENE_VALIDATION_FAILED' })
    assertUnpublished(s, record)
    assert.equal(s.studio.store.readRevisionSpec(s.request.projectId, 'r0001').entities.find(entity => entity.id === s.request.subjectEntityId).transform.location[0], .1)
  }
})

test('false rigid verification, residual gap, wrong preview frame and cancellation cannot commit', async t => {
  for (const attack of ['rigid', 'residual', 'frame', 'cancel']) {
    const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId), controller = new AbortController()
    if (attack === 'rigid') s.hooks.inspect = (input, report) => { if (input.baselineCheckpointPath) report.baselineVerification.subjectRigidTranslation = false }
    if (attack === 'residual') s.hooks.inspect = (input, report) => {
      if (input.baselineCheckpointPath) { report.subjectContactMeters[2] -= .001; report.translationMeters[2] += .001; report.subject.worldBoundsMeters.min[2] -= .001 }
    }
    if (attack === 'frame') s.hooks.preview = (input, report) => { report.frame += 1 }
    if (attack === 'cancel') s.hooks.preview = () => controller.abort()
    await assert.rejects(s.studio.placeOnSurface({ ...s.request, signal: controller.signal }), { code: attack === 'cancel' ? BlenderErrorCode.ABORTED : 'SCENE_VALIDATION_FAILED' })
    assertUnpublished(s, record)
  }
})

test('all declared assets stay pinned even when the changed asset is not selected', async t => {
  const bytes = Buffer.from('unused image fixture'), hash = sha256(bytes), relative = `assets/raw/${hash}.png`
  for (const phase of ['before', 'during-preview']) {
    const s = await setup(t, { changeSpec: spec => { spec.assets = [{ id: 'unselected-image', type: 'png', path: relative, sha256: hash }] } })
    const assetPath = join(s.project, relative); mkdirSync(dirname(assetPath), { recursive: true }); writeFileSync(assetPath, bytes)
    const record = s.studio.store.readRecord(s.request.projectId)
    if (phase === 'before') writeFileSync(assetPath, 'changed')
    else s.hooks.preview = () => writeFileSync(assetPath, 'changed')
    await assert.rejects(s.studio.placeOnSurface(s.request), { code: BlenderErrorCode.ASSET_HASH_MISMATCH })
    assertUnpublished(s, record)
    if (phase === 'before') assert.equal(s.calls.inspect.length, 0)
  }
})

test('ordinary evaluated modifiers and a subject-targeted camera remain supported', async t => {
  const s = await setup(t, { changeSpec: spec => {
    spec.entities.find(entity => entity.id === 'watch-body').modifiers = [{ type: 'bevel', width: .002, segments: 2 }, { type: 'subdivision', levels: 1 }]
    const camera = spec.cameras[0]; delete camera.targetPoint; camera.targetEntityId = 'watch-body'
  } })
  const saved = await s.studio.placeOnSurface({ ...s.request, renderPreview: false })
  assert.equal(saved.revision, 'r0002')
  const previous = s.studio.store.readRevisionSpec(s.request.projectId, 'r0001')
  const next = s.studio.store.readRevisionSpec(s.request.projectId, saved.revision)
  assert.deepEqual(next.entities.find(entity => entity.id === 'watch-body').modifiers, previous.entities.find(entity => entity.id === 'watch-body').modifiers)
  assert.deepEqual(next.cameras[0].transform.location, previous.cameras[0].transform.location)
  assert.equal(next.cameras[0].targetEntityId, 'watch-body')
})

test('the single writer lease spans native planning, compile, preview and publication', async t => {
  const s = await setup(t)
  let competing = 0
  const attemptCompetingWrite = async () => {
    await assert.rejects(s.studio.applyScenePatch({ projectId: s.request.projectId, baseRevision: 'r0001', saveCheckpoint: false,
      operations: [{ op: 'entity.transform.update', entityId: 'stage', location: [0, 0, -.1] }] }), { code: 'REVISION_CONFLICT' })
    competing += 1
  }
  s.hooks.inspect = attemptCompetingWrite; s.hooks.compile = attemptCompetingWrite; s.hooks.preview = attemptCompetingWrite
  const saved = await s.studio.placeOnSurface(s.request)
  assert.equal(competing, 4); assert.equal(saved.revision, 'r0002')
})

test('missing checkpoint, parent/world-origin mismatch and provider geometry budget refusal do not publish', async t => {
  for (const attack of ['missing', 'origin', 'budget']) {
    const s = await setup(t), record = s.studio.store.readRecord(s.request.projectId)
    if (attack === 'missing') rmSync(join(s.origin, 'scene.blend'))
    if (attack === 'origin') s.hooks.inspect = (input, report) => { report.subject.rootWorldMatrix[2][3] += 1 }
    if (attack === 'budget') s.hooks.inspect = (input, report) => { report.statistics.candidatePairs = SURFACE_PLACEMENT_LIMITS.candidatePairs + 1 }
    await assert.rejects(s.studio.placeOnSurface(s.request), { code: attack === 'missing' ? BlenderErrorCode.REVISION_CHECKPOINT_MISSING : attack === 'origin' ? BlenderErrorCode.UNSUPPORTED_ACTION : BlenderErrorCode.SCENE_VALIDATION_FAILED })
    assertUnpublished(s, record)
  }
})
