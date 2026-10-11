import test from 'node:test'
import assert from 'node:assert/strict'
import { assertRuntimeSceneFeatures } from '../../../packages/deepblend/host/lib/runtime-scene-features.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { statusForError } from '@deepblend/dsh-blender-ui'

const axisScene = { entities: [{ id: 'box', type: 'generator', generator: { shape: 'rounded_box', dimensions: [.3, .138, .162] } }] }
test('legacy geometry does not add a capability probe or change its runtime requirements', async () => {
  let calls = 0
  await assertRuntimeSceneFeatures({ getCapabilities() { calls++; throw Error('Unexpected probe') } },
    { entities: [{ type: 'generator', generator: { shape: 'cube', size: .264 } }] })
  assert.equal(calls, 0)
})
test('an older or unspecified runtime cannot silently reinterpret axis dimensions', async () => {
  assert.equal(statusForError({ code: 'BLENDER_SCENE_FEATURE_UNSUPPORTED' }), 409)
  for (const runtime of [{}, { getCapabilities: async () => ({ installed: true }) }, { getCapabilities: async () => ({ installed: true, sceneFeatures: [] }) }]) {
    await assert.rejects(assertRuntimeSceneFeatures(runtime, axisScene), error =>
      error.code === 'BLENDER_SCENE_FEATURE_UNSUPPORTED' && error.message.includes('geometry.primitive.dimensions'))
  }
})
test('a runtime explicitly advertising the required compiler feature is accepted', async () => {
  await assertRuntimeSceneFeatures({ getCapabilities: async () => ({ installed: true, sceneFeatures: ['geometry.primitive.dimensions'] }) }, axisScene)
})
test('missing Blender and interrupted capability reads keep their distinct failure reasons', async () => {
  await assert.rejects(assertRuntimeSceneFeatures({ getCapabilities: async () => ({ installed: false }) }, axisScene), e => e.code === 'BLENDER_NOT_FOUND')
  const controller = new AbortController(), reason = Error('stop before capability read')
  controller.abort(reason)
  let called = false
  await assert.rejects(assertRuntimeSceneFeatures({ getCapabilities() { called = true } }, axisScene, { signal: controller.signal }), e => e === reason)
  assert.equal(called, false)
})
test('a stopped request cannot use a late successful capability result', async () => {
  const controller = new AbortController(), reason = Error('stop while reading capabilities')
  await assert.rejects(assertRuntimeSceneFeatures({ async getCapabilities() {
    controller.abort(reason)
    return { installed: true, sceneFeatures: ['geometry.primitive.dimensions'] }
  } }, axisScene, { signal: controller.signal }), e => e === reason)
})

test('a real Host transaction refuses unsupported dimensions before compile and retains the current revision', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-feature-transaction-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let compiled = 0
  const context = new Context()
  context.provide('blenderRuntime', { getCapabilities: async () => ({ installed: true }), compileScene() { compiled++; throw Error('Unsupported scene reached compile') } })
  const studio = new BlenderStudio(context, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const spec = JSON.parse(readFileSync(new URL('../../recipes/modular-speaker/scene-spec.json', import.meta.url)))
  const created = await studio.createProject({ title: 'feature-rollback', sceneSpec: spec, saveCheckpoint: false, renderPreview: false })
  const before = studio.store.readRecord(created.projectId)
  const oldScene = studio.store.readRevisionSpec(created.projectId, 'r0001')
  await assert.rejects(studio.applyScenePatch({
    projectId: created.projectId, baseRevision: 'r0001', saveCheckpoint: true, renderPreview: false,
    operations: [{ op: 'entity.generator.set', entityId: 'cabinet-shell', generator: { shape: 'rounded_box', dimensions: [.3, .138, .162], bevel: { width: .01, segments: 4 } } }],
  }), e => e.code === 'BLENDER_SCENE_FEATURE_UNSUPPORTED')
  assert.equal(compiled, 0)
  assert.deepEqual(studio.store.readRecord(created.projectId), before)
  assert.deepEqual(studio.store.readRevisionSpec(created.projectId, 'r0001'), oldScene)
  assert.equal(studio.store.listRevisions(created.projectId).length, 1)
})
