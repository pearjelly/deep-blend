import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, validateScenePatch } from '@deepblend/dsh-blender-contracts'

function triangleGlb(binBytes = 36, edit = () => {}) {
  const bin = Buffer.alloc(Math.ceil(binBytes / 4) * 4)
  ;[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => bin.writeFloatLE(value, index * 4))
  const document = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] }
  edit(document)
  const text = Buffer.from(JSON.stringify(document)), json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32)
  text.copy(json)
  const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8)
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + bin.length, 8)
  jsonHeader.writeUInt32LE(json.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4)
  binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jsonHeader, json, binHeader, bin])
}

async function setup(t, extraConfig = {}, runtime = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-asset-library-'))
  const ctx = new Context(); ctx.provide('blenderRuntime', runtime)
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'),
    reconcileOnStart: false, ...extraConfig }))
  const created = await studio.createProject({ title: 'Asset library test', saveCheckpoint: false })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectId = created.projectId
  return { root, ctx, studio, projectId, upload: (bytes = triangleGlb(), options = {}) => studio.uploadAsset({
    projectId, name: 'model.glb', mediaType: 'model/gltf-binary', stream: Readable.from([bytes]), ...options,
  }) }
}

function fileSnapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => [entry.name, entry.isDirectory() ? fileSnapshot(join(directory, entry.name))
      : readFileSync(join(directory, entry.name)).toString('base64')]))
}

// These are Host orchestration tests, not Blender subprocess cancellation tests.
// The controlled runtime owns its working directories just as the provider does;
// the Host must independently remove its staged assets/checkpoint/partial PNG.
function controlledPreviewRuntime(t, pauseAt) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-library-controlled-runtime-'))
  const calls = [], directories = [], png = encodePng(createImage(512, 384, [80, 100, 130, 255]))
  let compileCount = 0, pauseConsumed = false, release, enter
  const entered = new Promise(resolve => { enter = resolve })
  t.after(() => { release?.(Error('Test cleanup')); rmSync(root, { recursive: true, force: true }) })
  const pause = async (phase, request) => {
    if (phase !== pauseAt || pauseConsumed) return
    pauseConsumed = true
    let onAbort
    try {
      await new Promise((resolve, reject) => {
        release = error => error ? reject(error) : resolve()
        onAbort = () => reject(request.signal.reason)
        request.signal.addEventListener('abort', onAbort, { once: true })
        enter({ phase, request })
        if (request.signal.aborted) onAbort()
      })
    } finally { request.signal.removeEventListener('abort', onAbort) }
  }
  const workingDirectory = () => {
    const directory = mkdtempSync(join(root, 'request-')); directories.push(directory)
    return directory
  }
  const runtime = {
    async compileScene(request) {
      const phase = `compile-${++compileCount}`, directory = workingDirectory()
      calls.push({ phase, request })
      try {
        writeFileSync(join(directory, 'result.blend'), 'Synthetic partial checkpoint for Host orchestration')
        await pause(phase, request)
        await request.onWorkingDirectory({ directory })
        return { report: { validation: { ok: true }, sceneFingerprint: { totalPolygons: 4 }, objects: [
          { type: 'MESH', name: 'imported', deepblendId: 'asset-subject', partId: 'root/mesh',
            worldBounds: { min: [10, 20, 30], max: [12, 24, 36] }, boundsFrame: 1, renderVisible: true,
            uvMaps: [], evaluatedUvMaps: [], sourceMaterialSlots: [], materialSlots: [] },
        ] } }
      } finally { rmSync(directory, { recursive: true, force: true }) }
    },
    async renderPreview(request) {
      const directory = workingDirectory()
      calls.push({ phase: 'render', request })
      try {
        writeFileSync(join(directory, 'render.log'), 'Synthetic in-progress render')
        writeFileSync(request.outputPath, 'Incomplete PNG from controlled runtime')
        await pause('render', request)
        writeFileSync(request.outputPath, png)
        return { report: { width: 512, height: 384,
          renderConfig: { engine: 'CYCLES', samples: 16, resolution: [512, 384] } } }
      } finally { rmSync(directory, { recursive: true, force: true }) }
    },
  }
  return { runtime, calls, directories, entered, fail: error => release(error) }
}

test('generic upload accepts a self-contained GLB above 8 MiB and keeps source bytes and revision', async t => {
  const { studio, projectId, upload } = await setup(t)
  const originalSpec = readFileSync(join(studio.store.projectDirectory(projectId), 'revisions/r0001/scene-spec.json'))
  const bytes = triangleGlb(9 * 1024 * 1024)
  const result = await upload(bytes)
  assert.ok(result.bytes > 8 * 1024 * 1024)
  assert.equal(result.license, null)
  assert.equal(result.asset.license, undefined)
  assert.deepEqual(readFileSync(join(studio.store.projectDirectory(projectId), result.asset.path)), bytes)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  assert.deepEqual(readFileSync(join(studio.store.projectDirectory(projectId), 'revisions/r0001/scene-spec.json')), originalSpec)
  const list = await studio.listAssets({ projectId })
  assert.equal(list.limits.maxBytes, 1_073_741_824)
  assert.equal(list.assets.length, 1)
  assert.equal(list.assets[0].declaredInRevision, false)
  assert.equal(list.assets[0].inspection, null)
  const manifest = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), 'assets/manifest.json')))
  assert.deepEqual(manifest.assets[0].source, { kind: 'upload', name: 'model.glb' })
  assert.ok(!JSON.stringify(list).includes('.upload-'))
})

test('licence is carried only when supplied, and declaration is a separate revision patch', async t => {
  const { studio, projectId, upload } = await setup(t)
  const result = await upload(undefined, { license: 'Creator permission — internal project use' })
  assert.deepEqual(result.asset.license, { source: result.license })
  const declaredLicense = { ...result.asset.license, commercialUse: false, attribution: 'Example author' }
  await studio.applyScenePatch({ projectId, baseRevision: 'r0001', saveCheckpoint: false, renderPreview: false,
    operations: [{ op: 'asset.add', asset: { ...result.asset, license: declaredLicense } }] })
  assert.equal((await studio.listAssets({ projectId, revision: 'r0001' })).assets[0].declaredInRevision, false)
  const declared = (await studio.listAssets({ projectId, revision: 'r0002' })).assets[0]
  assert.equal(declared.declaredInRevision, true)
  assert.deepEqual(declared.asset.license, declaredLicense)
  assert.equal(declared.license, result.license)
  const longest = await upload(undefined, { license: 'x'.repeat(200) })
  assert.equal(validateScenePatch({ projectId, baseRevision: 'r0002',
    operations: [{ op: 'asset.add', asset: longest.asset }], saveCheckpoint: false, renderPreview: false }).ok, true)
  await assert.rejects(upload(undefined, { license: 'x'.repeat(201) }), { code: 'ASSET_REQUEST_INVALID' })
})

test('replaced ingestion aliases do not replace the exact asset declared by an older revision', async t => {
  const { studio, root, projectId, upload } = await setup(t)
  const result = await upload()
  await studio.applyScenePatch({ projectId, baseRevision: 'r0001', saveCheckpoint: false, renderPreview: false,
    operations: [{ op: 'asset.add', asset: result.asset }] })
  const replacementPath = join(root, 'replacement.glb')
  writeFileSync(replacementPath, triangleGlb(40))
  const replacement = await studio.ingestAsset({ projectId, sourcePath: replacementPath, assetId: result.asset.id })
  rmSync(replacementPath)
  const list = await studio.listAssets({ projectId, revision: 'r0002' })
  assert.equal(list.assets.length, 2)
  assert.equal(list.assets.find(row => row.asset.sha256 === result.asset.sha256).declaredInRevision, true)
  assert.equal(list.assets.find(row => row.asset.sha256 === replacement.sha256).declaredInRevision, false)
  assert.ok(!JSON.stringify(list).includes(replacementPath))
})

test('malformed GLB, external dependencies and contradictory media types leave no staged asset', async t => {
  const { studio, projectId, upload } = await setup(t)
  await assert.rejects(upload(triangleGlb().subarray(0, 40)), { code: 'ASSET_CONTENT_MISMATCH' })
  await assert.rejects(upload(triangleGlb(36, document => { document.images = [{ uri: '../texture.png' }] })),
    { code: 'ASSET_REQUEST_INVALID' })
  await assert.rejects(upload(triangleGlb(36, document => { document.buffers[0].uri = 'https://example.invalid/model.bin' })),
    { code: 'ASSET_REQUEST_INVALID' })
  await assert.rejects(upload(undefined, { mediaType: 'image/png' }), { code: 'ASSET_CONTENT_MISMATCH' })
  await assert.rejects(upload(undefined, { name: '../model.glb' }), { code: 'PATH_SEGMENT_INVALID' })
  assert.deepEqual((await studio.listAssets({ projectId })).assets, [])
  assert.deepEqual(readdirSync(join(studio.store.projectDirectory(projectId), 'assets')), [])
})

test('generic upload enforces the configured byte limit and cleans an interrupted stream', async t => {
  const { studio, projectId, upload } = await setup(t, { assetMaxBytes: 1024 })
  await assert.rejects(upload(triangleGlb(2048)), { code: 'ASSET_TOO_LARGE' })
  const stream = Readable.from((async function* () { yield triangleGlb().subarray(0, 12); throw Error('upload disconnected') })())
  await assert.rejects(upload(undefined, { stream }), /upload disconnected/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(upload(undefined, { signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual((await studio.listAssets({ projectId })).assets, [])
  assert.deepEqual(readdirSync(join(studio.store.projectDirectory(projectId), 'assets')), [])
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
})

test('raster preview decodes actual bytes, survives refresh and leaves the project scene unchanged', async t => {
  const { ctx, studio, projectId, upload } = await setup(t)
  const bytes = encodePng(createImage(32, 24, [40, 110, 170, 255]))
  const uploaded = await upload(bytes, { name: 'texture.png', mediaType: 'image/png' })
  const before = studio.store.readRevisionSpec(projectId, 'r0001')
  // Access through Cordis as the HTTP layer does; service methods receive its proxy.
  const result = await ctx.blenderStudio.previewAsset({ projectId, assetId: uploaded.asset.id, sha256: uploaded.asset.sha256 })
  assert.equal(result.inspection.kind, 'image')
  assert.deepEqual([result.inspection.image.width, result.inspection.image.height], [32, 24])
  assert.deepEqual([result.preview.width, result.preview.height], [32, 24])
  const image = await studio.readArtifact({ projectId, path: result.preview.path })
  assert.equal(image.contentType, 'image/png')
  const list = await studio.listAssets({ projectId })
  assert.deepEqual(list.assets[0].preview, result.preview)
  assert.deepEqual(list.assets[0].inspection, result.inspection)
  assert.deepEqual(studio.store.readRevisionSpec(projectId, 'r0001'), before)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  assert.ok(!readdirSync(join(studio.store.projectDirectory(projectId), 'assets')).some(name => name.startsWith('.preview-')))
  const again = await studio.previewAsset({ projectId, assetId: uploaded.asset.id, sha256: uploaded.asset.sha256 })
  assert.notEqual(again.preview.path, result.preview.path)
  assert.deepEqual((await studio.readArtifact({ projectId, path: result.preview.path })).bytes, image.bytes)
})

test('preview rejects mismatched source bytes and malformed images without publishing a thumbnail', async t => {
  const { studio, projectId, upload } = await setup(t)
  const uploaded = await upload()
  writeFileSync(join(studio.store.projectDirectory(projectId), uploaded.asset.path), triangleGlb(40))
  await assert.rejects(studio.previewAsset({ projectId, assetId: uploaded.asset.id, sha256: uploaded.asset.sha256 }),
    { code: 'ASSET_HASH_MISMATCH' })
  const broken = await upload(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), { name: 'truncated.png', mediaType: 'image/png' })
  await assert.rejects(studio.previewAsset({ projectId, assetId: broken.asset.id, sha256: broken.asset.sha256 }),
    { code: 'ASSET_CONTENT_MISMATCH' })
  assert.ok((await studio.listAssets({ projectId })).assets.every(row => row.preview === null && row.inspection === null))
  assert.ok(!readdirSync(join(studio.store.projectDirectory(projectId), 'assets')).some(name => name.startsWith('.preview-')))
})

test('model inspection and fitted preview request isolated batch sessions and retain original material declarations', async t => {
  const calls = [], png = encodePng(createImage(512, 384, [80, 100, 130, 255]))
  const temporary = []
  t.after(() => temporary.forEach(path => rmSync(path, { recursive: true, force: true })))
  const runtime = {
    async compileScene(request) {
      const spec = JSON.parse(readFileSync(request.sceneSpecPath))
      calls.push({ type: 'compile', request, spec })
      const directory = mkdtempSync(join(tmpdir(), 'deepblend-library-runtime-')); temporary.push(directory)
      writeFileSync(join(directory, 'result.blend'), 'Synthetic checkpoint for orchestration contract')
      await request.onWorkingDirectory({ directory })
      return { report: { validation: { ok: true }, sceneFingerprint: { totalPolygons: 4 }, objects: [
        { type: 'MESH', name: 'imported', deepblendId: 'asset-subject', partId: 'root/mesh', parentPartId: null,
          worldBounds: { min: [10, 20, 30], max: [12, 24, 36] }, boundsFrame: 1, renderVisible: true,
          uvMaps: [{ name: 'UVMap', activeRender: true, loopCount: 12, finite: true, source: 'mesh-data' }],
          evaluatedUvMaps: [], sourceMaterialSlots: [{ index: 0, materialName: 'Original' }],
          materialSlots: [{ index: 0, materialName: 'Original', materialId: null, usedPolygonCount: 4 }] },
      ] } }
    },
    async renderPreview(request) {
      calls.push({ type: 'render', request }); writeFileSync(request.outputPath, png)
      return { report: { width: 512, height: 384, renderConfig: { engine: 'CYCLES', samples: 16, resolution: [512, 384] } } }
    },
  }
  const { studio, projectId, upload } = await setup(t, {}, runtime)
  const uploaded = await upload()
  const result = await studio.previewAsset({ projectId, assetId: uploaded.asset.id, sha256: uploaded.asset.sha256 })
  assert.deepEqual(calls.map(call => call.type), ['compile', 'compile', 'render'])
  assert.ok(calls.every(call => call.request.session === false))
  for (const call of calls.filter(call => call.type === 'compile')) {
    assert.equal(call.spec.entities[0].materialId, undefined)
    assert.equal(call.spec.entities[0].materialBindings, undefined)
  }
  assert.deepEqual(calls[1].spec.cameras[0].targetPoint, [11, 22, 33])
  assert.deepEqual(result.inspection.dimensions, [2, 4, 6])
  assert.equal(result.inspection.parts[0].assetSha256, uploaded.asset.sha256)
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
})

test('cancelling an active raster decoder rejects without an uncaught stream error or host-process exit', () => {
  const helper = new URL('../../../packages/deepblend/host/lib/asset-library.js', import.meta.url).href
  const fixture = new URL('../../recipes/glass-ceramic/preview.png', import.meta.url).pathname
  const program = `
    import assert from 'node:assert/strict';
    import {mkdtempSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    const {previewRasterAsset}=await import(${JSON.stringify(helper)});
    const dir=mkdtempSync(join(tmpdir(),'deepblend-cancel-decoder-'));
    try {
      await previewRasterAsset(${JSON.stringify(fixture)},'png',join(dir,'warm.png'));
      const controller=new AbortController();
      const pending=previewRasterAsset(${JSON.stringify(fixture)},'png',join(dir,'cancel.png'),{signal:controller.signal});
      setImmediate(()=>controller.abort());
      await assert.rejects(pending,{name:'AbortError'});
      await new Promise(resolve=>setTimeout(resolve,30));
      process.stdout.write('decoder cancellation survived');
    } finally {rmSync(dir,{recursive:true,force:true});}
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 15_000 })
  assert.match(output, /decoder cancellation survived/)
})

for (const phase of ['compile-1', 'compile-2', 'render']) {
  for (const outcome of ['cancelled', 'failed']) {
    test(`${outcome} in-progress ${phase} rejects concurrent previews, cleans staging and permits retry without revision changes`,
      { timeout: 10_000 }, async t => {
        const controlled = controlledPreviewRuntime(t, phase)
        const { ctx, studio, projectId, upload } = await setup(t, {}, controlled.runtime)
        const uploaded = await upload(), project = studio.store.projectDirectory(projectId)
        const assets = join(project, 'assets')
        const originalAssets = fileSnapshot(assets)
        const originalRecord = readFileSync(join(project, 'project.json'))
        const originalRevisions = fileSnapshot(join(project, 'revisions'))
        const request = { projectId, assetId: uploaded.asset.id, sha256: uploaded.asset.sha256 }
        const controller = new AbortController()
        t.after(() => controller.abort())
        // Attach both handlers before driving cancellation/failure, so a fast
        // rejection cannot escape the test as an unhandled promise rejection.
        const pending = ctx.blenderStudio.previewAsset({ ...request, signal: controller.signal })
          .then(value => ({ value }), error => ({ error }))
        const entered = await controlled.entered
        assert.equal(entered.request.signal, controller.signal)
        assert.equal(entered.request.signal.aborted, false)
        assert.ok(controlled.calls.every(call => call.request.session === false))
        const staged = readdirSync(assets).filter(name => name.startsWith('.preview-'))
        assert.equal(staged.length, 1, 'the original request is still staged and in progress')
        if (phase !== 'compile-1') assert.ok(existsSync(join(assets, staged[0], 'preview.blend')),
          'a completed earlier compile has already copied a checkpoint into Host staging')
        if (phase === 'render') assert.ok(existsSync(join(assets, staged[0], 'preview.png')),
          'the failed/cancelled render has already produced partial output')

        const activeCalls = controlled.calls.length
        // A rejected competitor must not clear the original request's lock.
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(ctx.blenderStudio.previewAsset(request), error => {
            assert.equal(error.code, 'ASSET_REQUEST_INVALID')
            assert.match(error.message, /already running/)
            return true
          })
        }
        assert.equal(controlled.calls.length, activeCalls, 'competitors never reach the runtime')
        assert.ok(existsSync(join(assets, staged[0])), 'competitors do not clean the active request staging')

        const reason = outcome === 'cancelled' ? new DOMException('Cancel the active asset preview', 'AbortError')
          : Error(`Controlled ${phase} runtime failure`)
        if (outcome === 'cancelled') controller.abort(reason)
        else controlled.fail(reason)
        assert.equal((await pending).error, reason, 'the original runtime failure/abort reaches the caller')
        assert.deepEqual(fileSnapshot(assets), originalAssets, 'no staging or partial thumbnail was published')
        assert.deepEqual(readFileSync(join(project, 'project.json')), originalRecord)
        assert.deepEqual(fileSnapshot(join(project, 'revisions')), originalRevisions)
        assert.ok(controlled.directories.every(directory => !existsSync(directory)), 'runtime-owned request directories were cleaned')

        const retryController = new AbortController(), retryStart = controlled.calls.length
        const retry = await ctx.blenderStudio.previewAsset({ ...request, signal: retryController.signal })
        const retryCalls = controlled.calls.slice(retryStart)
        assert.equal(retryCalls.length, 3, 'retry completes both compile passes and the render')
        assert.ok(retryCalls.every(call => call.request.session === false && call.request.signal === retryController.signal))
        assert.deepEqual([retry.preview.width, retry.preview.height], [512, 384])
        assert.equal((await studio.readArtifact({ projectId, path: retry.preview.path })).contentType, 'image/png')
        assert.deepEqual((await studio.listAssets({ projectId })).assets[0].preview, retry.preview)
        assert.ok(!readdirSync(assets).some(name => name.startsWith('.preview-') || name.startsWith('.upload-')))
        assert.ok(controlled.directories.every(directory => !existsSync(directory)))
        assert.deepEqual(readFileSync(join(project, 'project.json')), originalRecord)
        assert.deepEqual(fileSnapshot(join(project, 'revisions')), originalRevisions)
        assert.deepEqual(readFileSync(join(project, uploaded.asset.path)), triangleGlb())
      })
  }
}
