import test from 'node:test'
import assert from 'node:assert/strict'
import { BlenderError } from '@deepblend/dsh-blender-contracts'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

const selection = { id: 'deepblend.glass-ceramic', version: '1.0.0', digest: 'a'.repeat(64), parameters: { 'main-color': [0.1, 0.2, 0.3], exposure: 0.4 } }

test('recipe_parameters reads without writes and sends one conditional semantic save to the Host', async () => {
  const calls = [], studio = { recipeParameterEditingSupported: true,
    getRecipeParameters(projectId, options) { calls.push({ read: projectId, options }); return { projectId, revision: 'r0002', available: true, parameters: [] } },
    updateRecipeParameters(request) { calls.push({ save: request }); return { revision: 'r0003', parameterState: { values: { width: 300 } } } }
  }
  const plane = await composeToolPlane({ studio, expectAtLeast: 18, label: 'recipe-parameters' })
  try {
    const tool = plane.registered.get('blender_recipe_parameters')
    assert.equal((await tool.execute({ projectId: 'speaker' })).ok, true)
    assert.equal(calls.length, 1); assert.equal(calls[0].read, 'speaker')
    const signal = new AbortController().signal
    const result = await tool.execute({ action: 'save', projectId: 'speaker', baseRevision: 'r0002', parameters: { width: 300 } }, { signal })
    assert.equal(result.ok, true); assert.equal(result.data.revision, 'r0003')
    assert.deepEqual(calls[1].save, { projectId: 'speaker', baseRevision: 'r0002', parameters: { width: 300 },
      idempotencyKey: undefined, saveCheckpoint: true, renderPreview: true, signal })
  } finally { await plane.ctx.stop?.() }
})

test('recipe_parameters refuses old Hosts and forwards controlled geometry conflicts', async () => {
  for (const studio of [{}, { recipeParameterEditingSupported: true,
    updateRecipeParameters() { throw new BlenderError('RECIPE_PARAMETER_CONFLICT', 'manual geometry changed') } }]) {
    const plane = await composeToolPlane({ studio, expectAtLeast: 18, label: 'recipe-parameters-refusal' })
    try { assert.equal((await plane.registered.get('blender_recipe_parameters').execute({ action: 'save', projectId: 'speaker', baseRevision: 'r0001', parameters: { width: 300 } })).ok, false) }
    finally { await plane.ctx.stop?.() }
  }
})
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

test('a compact model catalog still creates and resizes a real speaker with its exact full source lock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-compact-recipe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const context = new Context(); context.provide('blenderRuntime', {})
  const studio = new BlenderStudio(context, StudioConfig({ workspaceRoot: root,
    projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const catalog = studio.listRecipes(), before = JSON.stringify(catalog)
  const plane = await composeToolPlane({ studio, expectAtLeast: 18, label: 'compact-real-recipe' })
  t.after(() => plane.ctx.stop?.())
  const output = await plane.registered.get('blender_recipe_list').execute({})
  assert.equal(output.ok, true)
  assert.equal(output.data.recipes.length, catalog.recipes.length)
  assert.deepEqual(output.data.errors, catalog.errors)
  assert.equal(output.data.recipeSchemaVersion, catalog.recipeSchemaVersion)
  for (const recipe of output.data.recipes) {
    const original = catalog.recipes.find(item => item.id === recipe.id && item.version === recipe.version)
    for (const key of ['id', 'version', 'digest', 'title', 'description', 'author', 'license', 'source', 'previewUrl']) {
      assert.deepEqual(recipe[key], original[key], `${recipe.id}: ${key} must remain available`)
    }
    assert.equal(recipe.parameters.length, original.parameters.length)
    for (const parameter of recipe.parameters) {
      const originalParameter = original.parameters.find(item => item.id === parameter.id)
      assert.equal(Object.hasOwn(parameter, 'bindings'), false)
      for (const key of Object.keys(originalParameter).filter(key => key !== 'bindings')) {
        assert.deepEqual(parameter[key], originalParameter[key], `${parameter.id}: ${key} must remain available`)
      }
    }
  }
  assert.doesNotMatch(output.text, /"bindings"\s*:/)
  assert.ok(Buffer.byteLength(JSON.stringify(output)) < 20000, 'Model selection should not carry the internal assembly maps')
  const speaker = output.data.recipes.find(recipe => recipe.id === 'deepblend.modular-speaker')
  const selection = { id: speaker.id, version: speaker.version, digest: speaker.digest,
    parameters: { 'cabinet-width-mm': 300 } }
  const made = await plane.registered.get('blender_project_create').execute({ title: 'Compact speaker',
    recipe: selection, saveCheckpoint: false, renderPreview: false }, {})
  assert.equal(made.ok, true, made.text)
  const projectId = made.data.projectId
  const origin = studio.store.revisionDirectory(projectId, 'r0001')
  const source = readFileSync(join(origin, 'scene-spec.json')), lockBytes = readFileSync(join(origin, 'recipe-lock.json'))
  const lock = JSON.parse(lockBytes)
  assert.equal(lock.packageDigest, speaker.digest)
  assert.ok(lock.manifest.parameters.find(parameter => parameter.id === 'cabinet-width-mm').bindings.length > 100)
  const controls = await plane.registered.get('blender_recipe_parameters').execute({ projectId })
  assert.equal(controls.data.parameters.find(parameter => parameter.id === 'cabinet-width-mm').value, 300)
  const saved = await plane.registered.get('blender_recipe_parameters').execute({ action: 'save', projectId,
    baseRevision: controls.data.revision, parameters: { 'cabinet-width-mm': 340 }, saveCheckpoint: false,
    renderPreview: false, idempotencyKey: 'compact-resize' })
  assert.equal(saved.ok, true)
  assert.equal(saved.data.parameters.parameters.find(parameter => parameter.id === 'cabinet-width-mm').value, 340)
  const shell = studio.store.readRevisionSpec(projectId, saved.data.revision).entities.find(entity => entity.id === 'cabinet-shell')
  assert.ok(Math.abs(shell.generator.dimensions[0] * shell.transform.scale[0] - .34) < 1e-9)
  await assert.rejects(studio.createProject({ title: 'Invalid compact size', recipe: { ...selection,
    parameters: { 'cabinet-width-mm': 999 } }, saveCheckpoint: false }), { code: 'RECIPE_PARAMETER_INVALID' })
  assert.deepEqual(readFileSync(join(origin, 'scene-spec.json')), source)
  assert.deepEqual(readFileSync(join(origin, 'recipe-lock.json')), lockBytes)
  assert.equal(JSON.stringify(catalog), before)
  assert.deepEqual(studio.listRecipes(), catalog, 'Host and author SDK metadata must retain the full bindings')
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
