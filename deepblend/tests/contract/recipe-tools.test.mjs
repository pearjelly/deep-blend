import test from 'node:test'
import assert from 'node:assert/strict'
import { BlenderError } from '@deepblend/dsh-blender-contracts'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

const selection = { id: 'deepblend.glass-ceramic', version: '1.0.0', digest: 'a'.repeat(64), parameters: { 'main-color': [0.1, 0.2, 0.3], exposure: 0.4 } }
function created() {
  return { projectId: 'recipe-test', title: 'Recipe test', revision: { revision: 'r0001', digest: 'b'.repeat(64), checkpoint: null, previews: [] }, warnings: [] }
}

test('recipe_list only calls listRecipes and returns catalog metadata plus rejected-package errors', async () => {
  let reads = 0, writes = 0
  const catalog = { recipes: [{ id: selection.id, version: selection.version, digest: selection.digest,
    title: 'Glass', license: 'MIT', parameters: [{ id: 'exposure', type: 'number', minimum: -1, maximum: 1, default: 0 }] }],
  errors: [{ package: 'invalid', code: 'RECIPE_HASH_MISMATCH', message: 'Content changed' }] }
  const plane = await composeToolPlane({ studio: { listRecipes() { reads++; return catalog }, createProject() { writes++; throw new Error('Unexpected create') } }, expectAtLeast: 17, label: 'recipe-list' })
  try {
    const tool = plane.registered.get('blender_recipe_list')
    assert.ok(tool)
    assert.deepEqual(tool.parameters.properties, {})
    const output = await tool.execute({}, {})
    assert.equal(reads, 1); assert.equal(writes, 0)
    assert.equal(output.ok, true)
    assert.deepEqual(output.data, catalog)
    assert.match(output.text, /RECIPE_HASH_MISMATCH/)
    assert.equal(tool.presentCall({}).kind, 'read')
  } finally { await plane.ctx.stop?.() }
})

test('project_create forwards the exact recipe selection/overrides to the Host and keeps render controls', async () => {
  let request
  const plane = await composeToolPlane({ studio: { createProject(input) { request = input; return created() } }, expectAtLeast: 17, label: 'recipe-create' })
  try {
    const signal = new AbortController().signal
    const result = await plane.registered.get('blender_project_create').execute({ title: 'Recipe test', recipe: selection, saveCheckpoint: false, renderPreview: true }, { signal })
    assert.equal(result.ok, true)
    assert.deepEqual(request.recipe, selection)
    assert.equal(request.saveCheckpoint, false)
    assert.equal(request.renderPreview, true)
    assert.equal(request.signal, signal)
    assert.equal(Object.hasOwn(request, 'sceneSpec'), false)
  } finally { await plane.ctx.stop?.() }
})

test('recipe and sceneSpec cannot both reach a write, and incomplete recipe identity fails argument validation', async () => {
  let calls = 0
  const plane = await composeToolPlane({ studio: { createProject() { calls++; return created() } }, expectAtLeast: 17, label: 'recipe-mutual-exclusion' })
  try {
    const tool = plane.registered.get('blender_project_create')
    const result = await tool.execute({ title: 'Recipe test', recipe: selection, sceneSpec: {} }, {})
    assert.equal(result.ok, false)
    assert.equal(result.data.errorCode, 'RECIPE_REQUEST_INVALID')
    assert.equal(calls, 0)
    await assert.rejects(tool.execute({ title: 'Recipe test', recipe: { id: selection.id, version: selection.version } }, {}))
    await assert.rejects(tool.execute({ title: 'Recipe test', recipe: { ...selection, parameters: null } }, {}))
    assert.equal(calls, 0)
  } finally { await plane.ctx.stop?.() }
})

test('stale selection and catalog failures retain clear Host error codes', async () => {
  const plane = await composeToolPlane({ studio: {
    createProject() { throw new BlenderError('RECIPE_CHANGED', 'Refresh the catalog') },
    listRecipes() { throw new BlenderError('RECIPE_DIRECTORY_INVALID', 'Unreadable local directory') },
  }, expectAtLeast: 17, label: 'recipe-refusal' })
  try {
    const stale = await plane.registered.get('blender_project_create').execute({ title: 'Recipe test', recipe: selection }, {})
    assert.equal(stale.ok, false); assert.equal(stale.data.errorCode, 'RECIPE_CHANGED')
    const list = await plane.registered.get('blender_recipe_list').execute({}, {})
    assert.equal(list.ok, false); assert.equal(list.data.errorCode, 'RECIPE_DIRECTORY_INVALID')
  } finally { await plane.ctx.stop?.() }
})

test('recipe discovery without a Host reports unavailable and performs no filesystem fallback', async () => {
  const plane = await composeToolPlane({ studio: undefined, expectAtLeast: 17, label: 'recipe-no-host' })
  try {
    const output = await plane.registered.get('blender_recipe_list').execute({}, {})
    assert.equal(output.ok, false)
    assert.equal(output.data.code, 'BLENDER_RUNTIME_UNAVAILABLE')
  } finally { await plane.ctx.stop?.() }
})
