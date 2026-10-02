/** Asset UI uses immutable staged bytes, public patches and cancellable Host routes. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import BlenderUiHost, { createHandlers, statusForError } from '@deepblend/dsh-blender-ui'
import { BlenderError, buildSceneTree, compileSceneSpec, applyPatchToSpec, validateScenePatch, validateSceneSpec, UI_ROUTES, matchUiRoute, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const clone = value => JSON.parse(JSON.stringify(value))
const core = loadClientBundle().exports.workbench, assets = core.assetLibrary
const sha = 'a'.repeat(64), glbSha = 'b'.repeat(64)
const entry = (type = 'png', extra = {}) => ({ asset: { id: `uploaded-${type}`, type, path: `assets/raw/${type === 'glb' ? glbSha : sha}.${type}`, sha256: type === 'glb' ? glbSha : sha },
  originalName: `My source.${type}`, bytes: 10 * 1024 * 1024, license: null, declaredInRevision: false, inspection: null, ...extra })
const kind = type => type === 'glb' ? 'model' : ['hdr', 'exr'].includes(type) ? 'environment' : 'image'
const inspected = item => ({ kind: kind(item.asset.type), warnings: [], ...(item.asset.type === 'glb' ? { dimensions: [.1, .2, .3], parts: [] } : {}) })
const source = () => compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/metal-lamp/scene-spec.json', import.meta.url)))).spec
const scene = (spec, revision = 'r0001', assetParts = []) => buildSceneTree(spec, { revision, assetParts })
function draft(type = 'png', spec = source(), assetParts = []) {
  const item = entry(type); return { spec, item, value: assets.createDraft(scene(spec, 'r0001', assetParts), 'one', item, inspected(item), 'shade-shell') }
}
function apply(spec, value) {
  const patch = clone(assets.buildPatch(value)); assert.equal(validateScenePatch(patch).ok, true, validateScenePatch(patch).summary)
  const result = applyPatchToSpec(spec, patch).spec; assert.equal(validateSceneSpec(result).ok, true, validateSceneSpec(result).summary)
  return { patch, spec: result }
}
const nodesOf = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []
async function waitFor(store, predicate) {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('asset UI did not settle')) }, 3000)
    const stop = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); stop(); resolve() } })
  })
}
const limits = { maxBytes: 1073741824, maxImagePixels: 67108864, maxImageEdge: 8192, previewWidth: 384, previewHeight: 288 }
const preview = item => ({ path: `assets/previews/${item.asset.sha256}/preview.png`, mime: 'image/png', width: 384, height: 288, sha256: 'c'.repeat(64), toneMapped: ['hdr', 'exr'].includes(item.asset.type) })
async function client(t, options = {}) {
  const projects = Object.fromEntries(['one', 'two'].map(id => [id, { spec: source(), revision: 'r0001', assets: [] }]))
  if (options.seed) projects.one.assets = clone(options.seed)
  const calls = []; let failure = null
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost'), id = parsed.pathname.match(/projects\/([^/]+)/)?.[1] || parsed.searchParams.get('projectId') || 'one'
    const project = projects[id]; let payload
    if (init.method === 'POST') {
      const raw = parsed.pathname.endsWith('/assets'), body = raw ? init.body : JSON.parse(init.body)
      calls.push({ id, path: parsed.pathname, query: parsed.searchParams, body, headers: init.headers, signal: init.signal })
      await options.beforePost?.({ id, raw, body, signal: init.signal, path: parsed.pathname })
      if (failure) payload = { ok: false, error: failure }
      else if (raw) {
        const added = entry(body.name.split('.').at(-1).toLowerCase(), { license: parsed.searchParams.get('license') || null })
        project.assets.push(added); payload = { ok: true, projectId: id, currentRevision: project.revision, ...clone(added) }
      } else if (/\/assets\/[^/]+\/preview$/.test(parsed.pathname)) {
        const assetId = parsed.pathname.split('/').at(-2), found = project.assets.find(item => item.asset.id === assetId)
        assert.equal(body.sha256, found.asset.sha256); found.inspection = inspected(found); found.preview = preview(found)
        payload = { ok: true, projectId: id, assetId, sha256: found.asset.sha256, inspection: found.inspection, preview: found.preview }
      } else if (parsed.pathname.endsWith('/patch')) {
        assert.equal(body.patch.baseRevision, project.revision); assert.equal(validateScenePatch(body.patch).ok, true, validateScenePatch(body.patch).summary)
        project.spec = applyPatchToSpec(project.spec, body.patch).spec; assert.equal(validateSceneSpec(project.spec).ok, true, validateSceneSpec(project.spec).summary)
        project.revision = `r${String(Number(project.revision.slice(1)) + 1).padStart(4, '0')}`
        payload = { ok: true, revision: { revision: project.revision, previews: [] } }
      } else payload = { ok: true }
    } else if (parsed.pathname.endsWith('/assets')) payload = { ok: true, route: 'project.assets.list', projectId: id, revision: parsed.searchParams.get('revision'), limits, assets: clone(project.assets) }
    else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', previews: { revisions: [] }, artifactBase: `/deepblend/artifacts/${id}/` }
    else payload = { ok: true, route: 'state', projects: [{ projectId: 'one' }, { projectId: 'two' }], selected: { project: { projectId: id }, currentRevision: project.revision, scene: scene(project.spec, project.revision), jobs: [], unfinishedJobs: [] } }
    payload.hostApiVersion = HOST_API_VERSION
    return { ok: payload.ok, status: payload.ok ? 200 : 409, json: async () => clone(payload), text: async () => JSON.stringify(payload) }
  }
  const store = core.createWorkbenchStore({ fetch, pollIdleMs: 100000 }); t.after(() => store.stop()); store.start(); await waitFor(store, state => state.status === 'ok')
  store.actions.setView('scene'); store.actions.selectEditorEntity('shade-shell')
  const nodes = () => nodesOf(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = id => nodes().find(node => node.props['data-field'] === id), action = id => nodes().find(node => node.props['data-action'] === id)
  const ready = async (type = 'png') => {
    await store.actions.loadAssets(); await store.actions.uploadAsset([{ name: `sample.${type}`, type: type === 'png' ? 'image/png' : '', size: 10 * 1024 * 1024 }])
    const item = projects.one.assets.at(-1); await store.actions.previewAsset(assets.key(item.asset)); store.actions.chooseAsset(assets.key(item.asset)); return item
  }
  return { store, calls, projects, nodes, field, action, ready, fail: error => { failure = error } }
}

test('asset routes are closed; Host inputs omit arbitrary paths, commands and render parameters', async () => {
  const calls = [], handlers = createHandlers({ blenderStudio: { listAssets: async input => { calls.push(input); return {} }, uploadAsset: async input => { calls.push(input); return {} }, previewAsset: async input => { calls.push(input); return {} } } })
  for (const [id, method, path] of [['project.assets.list', 'GET', '/assets'], ['project.assets.upload', 'POST', '/assets'], ['project.assets.preview', 'POST', '/assets/a/preview']]) {
    assert.equal(matchUiRoute(method, `/deepblend/projects/one${path}`).route.id, id); assert.equal(UI_ROUTES.find(route => route.id === id).write, method === 'POST')
  }
  const signal = new AbortController().signal
  await handlers['project.assets.list']({ params: { projectId: 'one' }, query: { revision: 'r0001', sourcePath: '/private' } })
  await handlers['project.assets.preview']({ params: { projectId: 'one', assetId: 'a' }, body: { sha256: sha, path: '/private', width: 99999, command: 'bad' }, signal })
  assert.deepEqual(calls, [{ projectId: 'one', revision: 'r0001' }, { projectId: 'one', assetId: 'a', sha256: sha, signal }])
})

test('generic raw upload exceeds reference/JSON limits and passes the actual stream, license and cancellation signal', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 7), request = Readable.from([bytes])
  Object.assign(request, { method: 'POST', url: '/deepblend/projects/one/assets?name=source.glb&license=CC0', headers: { 'content-type': 'application/octet-stream' } })
  const context = new Context(); let received
  context.provide('blenderStudio', { uploadAsset: async input => { received = input; const chunks = []; for await (const chunk of input.stream) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), bytes); return { asset: entry('glb').asset } } })
  const host = new BlenderUiHost(context, { serveRoute: false }), response = Object.assign(new EventEmitter(), { setHeader() {}, end(body) { this.body = body; this.writableEnded = true } })
  await host._handle(request, response)
  assert.equal(response.statusCode, 200); assert.equal(received.stream, request); assert.equal(received.license, 'CC0'); assert.equal(received.signal.aborted, false)
  assert.equal(request.listenerCount('aborted'), 0); assert.equal(response.listenerCount('close'), 0); assert.ok(response.body.length < 1500)
})

test('a disconnected preview aborts Host work and removes request listeners', async () => {
  const request = Readable.from([Buffer.from(JSON.stringify({ sha256: sha }))]); Object.assign(request, { method: 'POST', url: '/deepblend/projects/one/assets/a/preview', headers: { 'content-type': 'application/json' } })
  const response = Object.assign(new EventEmitter(), { setHeader() {}, end() { this.writableEnded = true } })
  const context = new Context(); let signal
  context.provide('blenderStudio', { previewAsset: async input => { signal = input.signal; response.emit('close'); assert.equal(signal.aborted, true); return {} } })
  await new BlenderUiHost(context, { serveRoute: false })._handle(request, response)
  assert.equal(signal.aborted, true); assert.equal(response.listenerCount('close'), 0); assert.equal(request.listenerCount('aborted'), 0)
})

test('asset failures have actionable status codes', () => {
  for (const [code, status] of Object.entries({ ASSET_TOO_LARGE: 413, ASSET_CONTENT_MISMATCH: 415, ASSET_FORMAT_UNAVAILABLE: 415, ASSET_HASH_MISMATCH: 409, SCENE_VALIDATION_FAILED: 422 })) assert.equal(statusForError(new BlenderError(code, 'Controlled error')), status)
})

test('GLB placement preserves original materials and camera, with one atomic checkpoint/preview transaction', () => {
  const { spec, value } = draft('glb'), before = clone(spec); value.location = [.1, .2, .3]; value.scale = 2
  const result = apply(spec, value), model = result.spec.entities.find(item => item.id === value.newEntityId)
  assert.deepEqual(result.patch.operations.map(op => op.op), ['asset.add', 'entity.add']); assert.equal(model.materialId, undefined); assert.equal(model.materialBindings, undefined)
  assert.deepEqual(model.transform.scale, [2, 2, 2]); assert.equal(result.patch.saveCheckpoint, true); assert.equal(result.patch.renderPreview, true)
  assert.deepEqual(result.spec.cameras, before.cameras); assert.deepEqual(result.spec.materials, before.materials); assert.deepEqual(spec, before)
})

test('asset licenses are carried only when explicitly supplied; alias changes never rewrite old declarations', () => {
  const { spec, value } = draft('glb'); assert.equal(assets.buildPatch(value).operations[0].asset.license, undefined)
  value.entry.license = 'CC BY 4.0: Original Author'; assert.deepEqual(clone(assets.buildPatch(value).operations[0].asset.license), { source: value.entry.license })
  value.scene.nodes.assets.push({ ...value.entry.asset, sha256: sha }); assert.throws(() => assets.buildPatch(value), /identity changed/)
})

test('local image binding preserves alpha, anisotropy, tangents, other maps and the selected map UV transform', () => {
  const spec = source(), material = spec.materials.find(item => item.id === 'champagne-spun'); material.parameters.baseColor[3] = .37; delete material.texture
  spec.assets.push(entry('jpeg').asset); material.images = { roughness: { assetId: 'uploaded-jpeg', channel: 'g', scale: [2, 3, 4], offset: [.1, .2, .3], uvMap: 'Detail' }, normal: { assetId: 'uploaded-jpeg', strength: .4 } }
  const { value } = draft('png', spec); value.channel = 'roughness'; value.binding = clone(material.images.roughness)
  const { spec: next } = apply(spec, value), added = next.materials.find(item => item.id === value.newMaterialId)
  assert.deepEqual(added.parameters, material.parameters); assert.deepEqual(added.tangent, material.tangent)
  assert.deepEqual(added.images.normal, material.images.normal); assert.deepEqual(added.images.roughness, { ...material.images.roughness, assetId: 'uploaded-png' })
  assert.deepEqual(next.materials.find(item => item.id === material.id), material); assert.equal(next.entities.find(item => item.id === 'weighted-base').materialId, material.id)
})

test('shared image binding preserves full map configuration and never clones or rebinds entities', () => {
  const { spec, value } = draft(); value.scope = 'shared'; value.replaceTexture = true; value.channel = 'metallic'; value.binding = { channel: 'b' }
  const { patch, spec: next } = apply(spec, value)
  assert.deepEqual(patch.operations.map(op => op.op), ['asset.add', 'material.texture.set', 'material.images.set']); assert.deepEqual(next.entities, spec.entities)
  assert.deepEqual(next.materials.find(item => item.id === 'champagne-spun').tangent, spec.materials.find(item => item.id === 'champagne-spun').tangent)
})

test('procedural texture replacement requires an explicit choice and retains unrelated material fields', () => {
  const spec = source(), material = spec.materials.find(item => item.id === 'champagne-spun'); material.texture = { pattern: 'noise', scale: 5, detail: 2, roughness: .6, colorA: [.1, .1, .1, 1], colorB: [.9, .9, .9, 1] }
  const { value } = draft('png', spec); assert.throws(() => assets.buildPatch(value), /explicitly replaced/)
  value.replaceTexture = true; value.scope = 'shared'; const { patch, spec: next } = apply(spec, value)
  assert.deepEqual(patch.operations.map(op => op.op), ['asset.add', 'material.texture.set', 'material.images.set']); assert.equal(next.materials.find(item => item.id === material.id).texture, undefined)
})

function imported() {
  const spec = source(); spec.assets.push(entry('glb').asset); spec.entities.push({ id: 'imported', type: 'asset-instance', assetId: 'uploaded-glb' })
  const part = { entityId: 'imported', partId: '/Body', parentPartId: null, assetId: 'uploaded-glb', assetSha256: glbSha, selectorVersion: 1,
    sourceMaterialSlots: [{ index: 0, materialName: 'Original' }, { index: 1, materialName: 'Trim' }], materialSlots: [{ index: 0, materialName: 'Paint', materialId: null }] }
  const { value } = draft('png', spec, [part]); value.entityId = 'imported'; value.target = 'slot'; value.partId = '/Body'; value.slotIndex = '1'; return { spec, value }
}

test('native GLB material replacement is explicit and uses source slots even after effective slots collapse', () => {
  const { spec, value } = imported(); assert.throws(() => assets.buildPatch(value), /Native nodes|原生/)
  value.newMaterial = true; const { patch } = apply(spec, value)
  assert.deepEqual(patch.operations.at(-1), { op: 'entity.materialBindings.set', entityId: 'imported', materialBindings: [{ partId: '/Body', slotIndex: 1, materialId: value.newMaterialId }] })
})

test('part/slot replacement retains existing bindings and refuses stale selectors or invented slots', () => {
  const { spec, value } = imported(); value.newMaterial = true
  const original = value.scene.nodes.entities.find(item => item.id === 'imported'); original.materialBindings = [{ partId: '/Body', materialId: 'champagne-spun' }, { partId: '/Other', slotIndex: 0, materialId: 'champagne-spun' }]
  assert.equal(assets.buildPatch(value).operations.at(-1).materialBindings.length, 3)
  value.slotIndex = '2'; assert.throws(() => assets.buildPatch(value), /source slot/); value.slotIndex = '1'
  original.assetParts[0].assetSha256 = sha; assert.throws(() => assets.buildPatch(value), /source part inventory/)
})

test('material animation cannot disappear through local copying or be hidden by replacing its driven channel', () => {
  const { value } = draft(); value.scene.nodes.animationTracks = [{ targetKind: 'material', targetId: 'champagne-spun', property: 'metallic' }]
  assert.throws(() => assets.buildPatch(value), /animation|动画/)
  value.scope = 'shared'; value.replaceTexture = true; assert.doesNotThrow(() => assets.buildPatch(value)); value.channel = 'metallic'; assert.throws(() => assets.buildPatch(value), /animated|动画/)
})

test('HDR and EXR use original assets in a merged world, preserving color and the camera', () => {
  for (const type of ['hdr', 'exr']) {
    const { spec, value } = draft(type); value.rotation = Math.PI / 2
    const { patch, spec: next } = apply(spec, value); assert.deepEqual(patch.operations.map(op => op.op), ['asset.add', 'world.set'])
    assert.deepEqual(next.world.color, spec.world.color); assert.equal(next.world.strength, spec.world.strength); assert.equal(next.world.environment.assetId, `uploaded-${type}`); assert.deepEqual(next.cameras, spec.cameras)
  }
})

test('invalid placement, binding and inspection values cannot form an operation', () => {
  for (const mutate of [d => { d.scale = 0 }, d => { d.location[0] = Infinity }, d => { d.newEntityId = '../bad' }, d => { d.inspection.kind = 'image' }]) { const { value } = draft('glb'); mutate(value); assert.throws(() => assets.buildPatch(value)) }
  for (const mutate of [d => { d.channel = 'displacement' }, d => { d.binding = { strength: 2 } }, d => { d.binding = { scale: [1, null, 1] } }]) { const { value } = draft(); mutate(value); assert.throws(() => assets.buildPatch(value)) }
})

test('opening inventory makes no writes; browser upload follows dynamic 1 GiB limits and does not inspect or create a revision', async t => {
  const { store, calls, projects, nodes } = await client(t); await store.actions.loadAssets(); assert.equal(calls.length, 0)
  store.actions.setAssetLicense('Original author supplied license')
  const file = { name: 'source.glb', type: '', size: 10 * 1024 * 1024 }; await store.actions.uploadAsset([file])
  assert.equal(calls.length, 1); assert.equal(calls[0].body, file); assert.equal(calls[0].headers['content-type'], 'application/octet-stream'); assert.equal(calls[0].query.get('license'), 'Original author supplied license')
  assert.equal(projects.one.revision, 'r0001'); assert.equal(store.getState().assetDrafts.one, undefined); assert.match(JSON.stringify(nodes()), /1,?024 MiB/)
  await store.actions.uploadAsset([{ ...file, size: limits.maxBytes + 1 }]); assert.equal(calls.length, 1)
})

test('inspection is explicit and hash-pinned; reload recovers its thumbnail without another render', async t => {
  const { store, calls, projects, nodes } = await client(t); await store.actions.loadAssets(); await store.actions.uploadAsset([{ name: 'source.hdr', size: 100, type: '' }])
  const item = projects.one.assets[0]; store.actions.chooseAsset(assets.key(item.asset)); assert.equal(store.getState().assetDrafts.one, undefined)
  await store.actions.previewAsset(assets.key(item.asset)); assert.deepEqual(calls.at(-1).body, { sha256: sha }); assert.equal(projects.one.revision, 'r0001')
  const count = calls.length; await store.actions.loadAssets(); assert.equal(calls.length, count)
  assert.ok(nodes().some(node => node.props['data-asset-preview'] === item.asset.id)); assert.match(JSON.stringify(nodes()), /tone-mapped|色调映射/)
  store.actions.chooseAsset(assets.key(item.asset)); assert.equal(store.getState().assetDrafts.one.kind, 'environment')
})

test('a fresh client rebuilds inspected previews from Host inventory', async t => {
  const item = entry('glb'); item.inspection = inspected(item); item.preview = preview(item)
  const { store, nodes, calls } = await client(t, { seed: [item] }); await store.actions.loadAssets()
  assert.ok(nodes().some(node => node.props['data-asset-preview'] === item.asset.id)); store.actions.chooseAsset(assets.key(item.asset)); assert.equal(store.getState().assetDrafts.one.kind, 'model'); assert.equal(calls.length, 0)
})

test('actual controls use millimetres/degrees and apply only after an explicit click', async t => {
  const { store, field, calls, projects, ready } = await client(t); await ready('glb'); const count = calls.length
  field('asset-location-x').props.onChange({ target: { value: '125' } }); field('asset-rotationEuler-z').props.onChange({ target: { value: '90' } })
  assert.equal(calls.length, count); const id = store.getState().assetDrafts.one.newEntityId; await store.actions.applyAsset(); await waitFor(store, state => state.currentRevision === 'r0002')
  const model = projects.one.spec.entities.find(item => item.id === id); assert.equal(model.transform.location[0], .125); assert.equal(model.transform.rotationEuler[2], Math.PI / 2)
  assert.equal(store.getState().assetDrafts.one, undefined); assert.equal(store.getState().editorComparison.before, 'r0001'); assert.equal(store.getState().editorComparison.after, 'r0002')
})

test('material controls preserve anisotropy and select scalar channel without replacing other targets', async t => {
  const { store, field, ready, projects } = await client(t); await ready()
  field('asset-map-channel').props.onChange({ target: { value: 'roughness' } }); field('asset-scalar-channel').props.onChange({ target: { value: 'g' } })
  field('asset-uv-map').props.onChange({ target: { value: 'UVMap' } }); field('asset-replace-texture').props.onChange({ target: { checked: true } }); const id = store.getState().assetDrafts.one.newMaterialId; await store.actions.applyAsset()
  const added = projects.one.spec.materials.find(item => item.id === id); assert.equal(added.images.roughness.channel, 'g'); assert.equal(added.images.roughness.uvMap, 'UVMap'); assert.equal(added.parameters.anisotropic, .55)
  assert.equal(projects.one.spec.entities.find(item => item.id === 'weighted-base').materialId, 'champagne-spun')
})

test('polling detects conflicts without overwriting draft inputs or publishing against a stale revision', async t => {
  const { store, projects, calls, ready, action } = await client(t); await ready('glb'); store.actions.updateAsset('scale', 2)
  projects.one.revision = 'r0002'; store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0002')
  const count = calls.length; assert.equal(action('asset-apply').props.disabled, true); await store.actions.applyAsset(); assert.equal(calls.length, count)
  assert.equal(store.getState().assetDrafts.one.scale, 2); assert.equal(store.getState().assetDrafts.one.baseRevision, 'r0001')
  store.actions.discardAsset(); assert.equal(store.getState().assetDrafts.one, undefined)
})

test('a rejected apply retains the complete draft and stable material identity', async t => {
  const { store, ready, fail, projects } = await client(t); await ready(); store.actions.updateAsset('replaceTexture', true); const before = clone(store.getState().assetDrafts.one)
  fail({ code: 'SCENE_VALIDATION_FAILED', message: 'Missing UV map' }); await store.actions.applyAsset()
  assert.deepEqual(clone(store.getState().assetDrafts.one), before); assert.equal(projects.one.revision, 'r0001'); assert.match(store.getState().assetWork.one.error, /Missing UV/)
})

test('late uploads and previews remain attached to their originating project', async t => {
  for (const pauseKind of ['upload', 'preview']) {
    let finish, entered; const enteredPromise = new Promise(resolve => { entered = resolve }), blocked = new Promise(resolve => { finish = resolve })
    const { store, projects } = await client(t, { seed: [entry('glb')], beforePost: async request => { if ((pauseKind === 'upload') === request.raw) { entered(); await blocked } } })
    await store.actions.loadAssets(); const operation = pauseKind === 'upload' ? store.actions.uploadAsset([{ name: 'new.png', type: 'image/png', size: 10 }]) : store.actions.previewAsset(assets.key(projects.one.assets[0].asset))
    await enteredPromise; store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two'); store.actions.updateBrief('goal', 'Keep project two'); finish(); await operation
    assert.equal(store.getState().activeProjectId, 'two'); assert.equal(store.getState().briefDrafts.two.goal, 'Keep project two'); assert.equal(store.getState().assetDrafts.two, undefined); assert.equal(projects.two.assets.length, 0)
    assert.equal(store.getState().assetLibraries.two, undefined)
  }
})

test('cancellation reaches transport and never stages a draft or commits a revision', async t => {
  let entered; const enteredPromise = new Promise(resolve => { entered = resolve })
  const { store, calls, projects } = await client(t, { beforePost: request => new Promise((resolve, reject) => { entered(); request.signal.addEventListener('abort', () => reject(new Error('Cancelled by test')), { once: true }) }) })
  await store.actions.loadAssets(); const operation = store.actions.uploadAsset([{ name: 'large.glb', type: '', size: 90000000 }]); await enteredPromise; store.actions.cancelAsset(); await operation
  assert.equal(calls[0].signal.aborted, true); assert.equal(projects.one.assets.length, 0); assert.equal(projects.one.revision, 'r0001'); assert.equal(store.getState().assetDrafts.one, undefined); assert.match(store.getState().assetWork.one.error, /Cancelled|取消/)
})

test('asset drafts block reviewer calls only in their own project', async t => {
  const { store, calls, ready } = await client(t); await ready('glb'); const count = calls.length; await store.actions.runVisual('review'); assert.equal(calls.length, count)
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two'); await store.actions.runVisual('review'); assert.equal(calls.length, count + 1)
  store.actions.selectProject('one'); await waitFor(store, state => state.activeProjectId === 'one'); assert.equal(store.getState().assetDrafts.one.kind, 'model')
})

test('license length uses the SceneSpec boundary before any upload, without truncation', async t => {
  const { store, calls, field } = await client(t); await store.actions.loadAssets()
  assert.equal(field('asset-license').props.maxLength, 200)
  store.actions.setAssetLicense('x'.repeat(201)); await store.actions.uploadAsset([{ name: 'image.png', type: 'image/png', size: 2 }]); assert.equal(calls.length, 0)
  assert.equal(store.getState().assetLicenses.one.length, 201)
})

test('failed reinspection removes the old usable preview and cannot be confused with current success', async t => {
  const item = entry('glb'); item.inspection = inspected(item); item.preview = preview(item)
  const { store, action, fail, projects } = await client(t, { seed: [item] }); await store.actions.loadAssets()
  assert.equal(action('asset-use:uploaded-glb').props.disabled, false)
  fail({ code: 'ASSET_HASH_MISMATCH', message: 'Stored bytes changed' }); await store.actions.previewAsset(assets.key(item.asset))
  assert.equal(action('asset-use:uploaded-glb').props.disabled, true); assert.equal(store.getState().assetPreviews.one[assets.key(item.asset)], undefined)
  assert.equal(projects.one.revision, 'r0001'); assert.match(store.getState().assetWork.one.error, /ASSET_HASH_MISMATCH/)
})

test('preview cancellation and store disposal both signal in-flight work without retaining a result', async t => {
  for (const cancel of ['cancelAsset', 'stop']) {
    const item = entry('glb'); let entered; const entering = new Promise(resolve => { entered = resolve })
    const { store, projects, calls } = await client(t, { seed: [item], beforePost: request => new Promise((resolve, reject) => {
      entered(); request.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    }) })
    await store.actions.loadAssets(); const operation = store.actions.previewAsset(assets.key(item.asset)); await entering
    if (cancel === 'stop') store.stop(); else store.actions.cancelAsset()
    await operation; assert.equal(calls[0].signal.aborted, true); assert.equal(projects.one.revision, 'r0001'); assert.equal(store.getState().assetPreviews.one[assets.key(item.asset)], undefined)
  }
})

test('a late successful commit preserves the other project’s new asset draft and selected view', async t => {
  let finish, entered; const entering = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { finish = resolve })
  const { store, projects, ready } = await client(t, { beforePost: async request => { if (request.path.endsWith('/patch')) { entered(); await held } } })
  await ready('glb'); const saving = store.actions.applyAsset(); await entering
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two')
  const second = entry('hdr'); second.inspection = inspected(second); second.preview = preview(second); projects.two.assets.push(second)
  await store.actions.loadAssets(); store.actions.chooseAsset(assets.key(second.asset)); store.actions.updateAsset('strength', .42)
  finish(); await saving
  assert.equal(store.getState().activeProjectId, 'two'); assert.equal(store.getState().view, 'scene'); assert.equal(store.getState().assetDrafts.two.strength, .42)
  assert.equal(store.getState().assetDrafts.one, undefined); assert.equal(projects.one.revision, 'r0002'); assert.equal(projects.two.revision, 'r0001')
})

test('mapping controls update the selected channel without leaking normal-only fields', async t => {
  const { store, ready, field } = await client(t); await ready()
  field('asset-map-channel').props.onChange({ target: { value: 'normal' } }); field('asset-normal-strength').props.onChange({ target: { value: '0.3' } })
  field('asset-map-scale-u').props.onChange({ target: { value: '2.5' } }); assert.equal(store.getState().assetDrafts.one.binding.scale[0], 2.5)
  field('asset-map-channel').props.onChange({ target: { value: 'roughness' } }); assert.equal(store.getState().assetDrafts.one.binding.strength, undefined); assert.equal(store.getState().assetDrafts.one.binding.scale, undefined)
  assert.equal(field('asset-scalar-channel').props.value, 'r'); assert.equal(field('asset-normal-strength'), undefined)
})

test('discarding a draft preserves staged bytes and creates no asset-remove operation', async t => {
  const { store, ready, calls, projects } = await client(t); await ready('glb'); const count = calls.length
  store.actions.discardAsset(); assert.equal(calls.length, count); assert.equal(projects.one.assets.length, 1); assert.equal(projects.one.revision, 'r0001')
})


test('older numeric Host APIs are stale even with the correct route; future versions and legacy missing version retain their policy', async t => {
  for (const version of [4, 5, 6, 7, undefined]) {
    const payload = { ok: true, route: 'state', ...(version === undefined ? {} : { hostApiVersion: version }), projects: [], selected: null }
    const store = core.createWorkbenchStore({ fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) }) })
    t.after(() => store.stop())
    const result = await store.readRoute('/deepblend/state', 'state')
    assert.equal(result.status, version < 6 ? 'stale' : 'ok')
    if (version < 6) { assert.equal(result.error.code, 'UI_HOST_API_STALE'); assert.ok(result.error.message.includes(`hostApiVersion=${version}`)); assert.match(result.error.message, /6/) }
  }
})


test('new asset routes reject an old running service instead of advertising capabilities it does not have', async () => {
  for (const service of [{ hostApiVersion: () => 4 }, { hostApiVersion: () => 4, listAssets() { throw Error('must not call') }, uploadAsset() { throw Error('must not call') }, previewAsset() { throw Error('must not call') } }]) {
    const handlers = createHandlers({ blenderStudio: service })
    for (const route of ['project.assets.list', 'project.assets.upload', 'project.assets.preview']) {
      await assert.rejects(handlers[route]({ params: { projectId: 'one', assetId: 'a' }, query: {}, body: { sha256: sha }, request: {} }), error => error.code === 'UI_HOST_API_STALE' && statusForError(error) === 503)
    }
  }
})


test('a tone-mapped GLB preview never claims to be an environment lighting example and dimensions remain readable', async t => {
  const item = entry('glb', { bytes: 2048 }); item.inspection = { ...inspected(item), dimensions: [.159999996, .16, .160000002] }; item.preview = { ...preview(item), toneMapped: true }
  const { store, nodes } = await client(t, { seed: [item] }); await store.actions.loadAssets()
  const text = JSON.stringify(nodes())
  assert.doesNotMatch(text, /环境照明效果示例/)
  assert.match(text, /0.16 × 0.16 × 0.16/); assert.match(text, /2 KiB/)
})
