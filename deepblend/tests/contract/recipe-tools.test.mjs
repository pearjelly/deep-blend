import test from 'node:test'
import assert from 'node:assert/strict'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'
import { createHash } from 'node:crypto'

const selection = { id: 'deepblend.glass-ceramic', version: '1.0.0', digest: 'a'.repeat(64), parameters: { 'main-color': [0.1, 0.2, 0.3], exposure: 0.4 } }

test('committed previews attach once on create, patch and dimension save without rendering again', async () => {
  const source = readFileSync(new URL('../fixtures/obj-image-formats/paint.png', import.meta.url))
  const normalized = readFileSync(new URL('../fixtures/obj-image-formats/paint.jpg', import.meta.url))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const artifact = { kind: 'preview', cameraId: 'hero', frame: 24, sourceRevision: 'r0001',
    sourceDigest: 'b'.repeat(64), mime: 'image/png', width: 64, height: 64, bytes: source.length,
    sha256: hash(source), path: 'revisions/r0001/previews/hero.png' }
  const summary = { revision: 'r0001', digest: artifact.sourceDigest, checkpoint: 'revisions/r0001/scene.blend', previews: [artifact] }
  const reference = { attachmentId: 'sha256:' + hash(normalized), mediaType: 'image/jpeg', bytes: normalized.length, width: 64, height: 64 }
  let writes = 0, reads = 0, saves = 0, renderCalls = 0, override = null, abortRead = null
  const saved = () => { writes++; return { ...structuredClone(summary), previews: [structuredClone(override ?? artifact)] } }
  const studio = { recipeParameterEditingSupported: true,
    createProject: async () => ({ projectId: 'cup', title: 'Cup', revision: saved(), warnings: [] }),
    applyScenePatch: async () => saved(), updateRecipeParameters: async () => saved(),
    renderPreview: async () => { renderCalls++; throw new Error('No extra render allowed') },
    renderViews: async () => { renderCalls++; throw new Error('No extra inspection allowed') },
    readArtifact: async request => {
      reads++; assert.deepEqual(request, { projectId: 'cup', path: artifact.path }); abortRead?.abort()
      return { path: artifact.path, contentType: 'image/png', bytes: source, size: source.length }
    } }
  const attachments = { saveImage: async input => { saves++; assert.deepEqual(input.data, source); return { ...reference } },
    readImage: async ref => ({ ref, data: normalized }) }
  const llm = { listModels: async () => [{ id: 'text-only', inputModalities: ['text'] }] }
  const plane = await composeToolPlane({ studio, services: { attachments, llm }, expectAtLeast: 18, label: 'committed-preview' })
  const cases = [
    ['blender_project_create', { title: 'Cup', renderPreview: true }],
    ['blender_scene_patch', { projectId: 'cup', baseRevision: 'r0000', operations: [{ op: 'entity.transform.update', entityId: 'cup', location: [0, 0, 0] }], renderPreview: true }],
    ['blender_recipe_parameters', { action: 'save', projectId: 'cup', baseRevision: 'r0000', parameters: { height: 115 } }],
  ]
  try {
    for (const [name, args] of cases) {
      const tool = plane.registered.get(name), result = await tool.execute(args, {})
      assert.equal(result.ok, true); assert.equal(result.image.mediaType, 'image/jpeg')
      assert.equal(result.imageSource.sourceDigest, summary.digest); assert.match(result.text, /no extra render/)
      const count = saves, replay = JSON.parse(JSON.stringify(result))
      assert.equal(tool.output.render(args, replay).filter(block => block.type === 'image').length, 1)
      assert.equal(saves, count, 'replay must never persist again')
    }
    assert.equal(writes, 3); assert.equal(reads, 3); assert.equal(saves, 3); assert.equal(renderCalls, 0)
    for (const [name, args] of cases) await plane.registered.get(name).execute({ ...args, renderPreview: false }, {})
    assert.equal(reads, 3); assert.equal(saves, 3, 'explicit data-only writes attach nothing')
    const create = plane.registered.get('blender_project_create'), args = cases[0][1]
    for (const [mutate, expectedReads] of [[a => { a.sourceRevision = 'r0002' }, 0], [a => { a.sourceDigest = '0'.repeat(64) }, 0],
      [a => { a.path = 'revisions/r0001/previews/../hero.png' }, 0], [a => { a.sha256 = '0'.repeat(64) }, 1],
      [a => { a.width = 63 }, 1], [a => { a.bytes++ }, 1]]) {
      override = { ...artifact }; mutate(override)
      const beforeReads = reads, beforeSaves = saves
      const result = await create.execute(args, {})
      assert.equal(result.ok, true, 'an attachment failure must not disguise a committed creation')
      assert.equal(result.image, null); assert.match(result.text, /model has not seen this image/)
      assert.equal(reads - beforeReads, expectedReads, 'invalid receipt must stop before artifact access')
      assert.equal(saves, beforeSaves, 'unverified source bytes must never reach the attachment store')
    }
    override = null
    const textOnly = await create.execute(args, { agent: { session: { requestHeader: () => ({ config: { provider: 'text-provider', model: 'text-only' } }) } } })
    assert.equal(textOnly.image, null); assert.equal(textOnly.imageDelivery.deliveredToModel, false)
    assert.equal(create.output.render(args, textOnly).filter(block => block.type === 'image').length, 0)
    abortRead = new AbortController()
    const cancelled = await create.execute(args, { signal: abortRead.signal })
    assert.equal(cancelled.ok, false); assert.equal(cancelled.data.errorCode, 'BLENDER_ABORTED')
    assert.equal(renderCalls, 0); assert.equal(hash(source), artifact.sha256)
  } finally { await plane.ctx.fiber.dispose() }
})

test('inspection accepts verified normalized attachments and refuses altered references or unreadable derivatives', async () => {
  const source = readFileSync(new URL('../fixtures/obj-image-formats/paint.png', import.meta.url))
  const normalized = readFileSync(new URL('../fixtures/obj-image-formats/paint.jpg', import.meta.url))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const artifact = { kind: 'diagnostic', mode: 'beauty', viewId: 'inspection', cameraId: 'hero', frame: 1,
    sourceRevision: 'r0001', sourceDigest: 'source', mime: 'image/png', width: 64, height: 64,
    bytes: source.length, sha256: hash(source), path: 'revisions/r0001/diagnostics/job/selected.png' }
  const data = { schemaVersion: 'deepblend.diagnostic/v1', projectId: 'cup', revision: 'r0001',
    sourceRevision: 'r0001', sourceDigest: 'source', mode: 'beauty', artifacts: [artifact] }
  const reference = { attachmentId: 'sha256:' + hash(normalized), mediaType: 'image/jpeg',
    bytes: normalized.length, width: 64, height: 64 }
  const attachments = { saveImage: async input => { assert.deepEqual(input.data, source); return { ...reference } },
    readImage: async ref => ({ ref, data: normalized }) }
  const studio = { hostApiVersion: () => 7, renderViews: async () => data,
    readArtifact: async () => ({ path: artifact.path, contentType: 'image/png', bytes: source, size: source.length }) }
  const plane = await composeToolPlane({ studio, services: { attachments }, expectAtLeast: 18, label: 'normalized-inspection' })
  const tool = plane.registered.get('blender_preview_render'), args = { projectId: 'cup', revision: 'r0001', mode: 'beauty', cameraId: 'hero', frame: 1 }
  try {
    const result = await tool.execute(args, {})
    assert.equal(result.ok, true); assert.equal(result.image.mediaType, 'image/jpeg')
    assert.deepEqual(result.data, data); assert.match(result.text, /attachment service normalization/)
    assert.equal(tool.output.render(args, JSON.parse(JSON.stringify(result))).filter(b => b.type === 'image').length, 1)
    for (const mutate of [
      ref => { ref.width = 65 }, ref => { ref.bytes++ }, ref => { ref.attachmentId = 'sha256:' + '0'.repeat(64) },
    ]) {
      attachments.saveImage = async () => { const ref = { ...reference }; mutate(ref); return ref }
      const rejected = await tool.execute(args, {})
      assert.equal(rejected.ok, true); assert.equal(rejected.image, null)
      assert.deepEqual(rejected.data, data); assert.match(rejected.text, /model cannot see it/)
    }
    attachments.saveImage = async () => ({ ...reference }); delete attachments.readImage
    const unreadable = await tool.execute(args, {})
    assert.equal(unreadable.image, null); assert.match(unreadable.text, /cannot be read back/)
  } finally { await plane.ctx.fiber.dispose() }
})

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


test('multiview preview attaches saved sheet once, preserves render results on corrupt receipt, and respects text-only routes', async () => {
  const bytes = readFileSync(new URL('../fixtures/obj-image-formats/paint.png', import.meta.url))
  const sha = data => createHash('sha256').update(data).digest('hex')
  const artifact = { kind: 'contact-sheet', slot: 'preview-current', sourceRevision: 'r0001', sourceDigest: 'b'.repeat(64),
    mime: 'image/png', width: 64, height: 64, bytes: bytes.length, sha256: sha(bytes), views: ['detail'],
    path: 'revisions/r0001/contact-sheets/preview-current.png' }
  const receipt = { revision: 'r0001', digest: 'b'.repeat(64), views: [{ viewId: 'detail', cameraId: 'liner-inspection', frame: 24 }],
    profile: { engine: 'cycles' }, previewSheets: { current: artifact }, pngs: { detail: Buffer.from(bytes) } }
  let renders = 0, reads = 0, saves = 0, reviews = 0, source = receipt, readBytes = bytes
  const host = { hostApiVersion: () => 6, renderViews: async () => { renders++; return structuredClone(source) },
    scoreVisualViews: () => ({ score: 90, issues: [] }),
    visualReview: () => { reviews++; throw new Error('additional review forbidden') },
    readArtifact: async request => { reads++; return { path: request.path, contentType: 'image/png', size: readBytes.length, bytes: readBytes } } }
  const store = { saveImage: async input => { saves++; assert.deepEqual(input.data, bytes); return { attachmentId: 'sheet1', mediaType: 'image/png', width: 64, height: 64, bytes: bytes.length } } }
  const plane = await composeToolPlane({ studio: host, services: { attachments: store, llm: { listModels: async () => [{ id: 'text', inputModalities: ['text'] }] } }, label: 'multiview-sheet' })
  const args = { projectId: 'lamp', revision: 'r0001' }, tool = plane.tools.get('blender_preview_views')
  try {
    const good = await tool.execute(args, {})
    assert.equal(good.ok, true); assert.equal(good.image.attachmentId, 'sheet1')
    assert.equal(tool.output.render(args, good).filter(c => c.type === 'image').length, 1)
    assert.deepEqual([renders, reads, saves, reviews], [1, 1, 1, 0])
    assert.equal(good.imageSource.sha256, artifact.sha256)
    assert.equal(Object.hasOwn(good.data, 'pngs'), false, 'raw image buffers must not become model text')
    assert.equal(good.text.includes('\"pngs\"'), false)
    tool.output.render(args, good); assert.deepEqual([renders, reads, saves, reviews], [1, 1, 1, 0], 'replay cannot perform IO')
    const text = await tool.execute(args, { agent: { session: { requestHeader: () => ({ config: { provider: 'test', model: 'text' } }) } } })
    assert.equal(text.image, null); assert.match(text.text, /model has not seen these pixels/)
    for (const change of [a => { a.sha256 = 'c'.repeat(64) }, a => { a.width = 65 }, a => { a.sourceDigest = 'c'.repeat(64) }, a => { a.path = '../outside.png' }, a => { a.slot = 'preview-previous' }]) {
      source = structuredClone(receipt); change(source.previewSheets.current)
      const failedAttachment = await tool.execute(args, {})
      assert.equal(failedAttachment.ok, true); assert.equal(failedAttachment.image, null)
      assert.match(failedAttachment.text, /rendered views remain saved/)
    }
    source = receipt; readBytes = Buffer.from(bytes); readBytes[30] ^= 1
    const corrupt = await tool.execute(args, {}); assert.equal(corrupt.ok, true); assert.equal(corrupt.image, null)
    readBytes = bytes
    const cancelled = new AbortController(); cancelled.abort()
    const aborted = await tool.execute(args, { signal: cancelled.signal }); assert.equal(aborted.ok, false); assert.equal(aborted.data.errorCode, BlenderErrorCode.ABORTED)
    assert.equal(reviews, 0)
  } finally { await plane.ctx.stop?.() }
})
