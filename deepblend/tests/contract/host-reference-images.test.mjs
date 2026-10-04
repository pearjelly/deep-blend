/** Immutable reference bytes, actual multimodal attachments, and failure records across real Host revisions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, reviewInputsDigest, sceneSpecDigest } from '@deepblend/dsh-blender-contracts'

const PNG = encodePng(createImage(24, 18, [170, 80, 20, 255]))
const OTHER = encodePng(createImage(24, 18, [20, 90, 170, 255]))
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-host-references-'))
  const ctx = new Context(); ctx.provide('blenderRuntime', {})
  const saved = [], sent = []
  ctx.provide('attachments', { async saveImage(input) { saved.push(input); return { id: `image-${saved.length}`, mediaType: input.mediaType } } })
  ctx.provide('llm', { async *stream(input) { sent.push(input); yield { type: 'text-delta', text: '{"findings":[],"operations":[]}' } } })
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  const sceneSpec = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
  sceneSpec.project.goal = 'Original goal'
  const created = await studio.createProject({ title: 'Reference study', sceneSpec, saveCheckpoint: false })
  const projectId = created.projectId
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const upload = (data = PNG, name = 'study.png', mediaType = 'image/png') => studio.uploadReferenceImage({ projectId, name, mediaType, stream: Readable.from([data]) })
  const bind = async (uploaded, baseRevision = 'r0001', goal = 'Smooth ceramic with a restrained glaze') => {
    const reference = { id: 'reference-front', assetId: uploaded.asset.id, sha256: uploaded.asset.sha256, label: 'Finish and silhouette', purposes: ['geometry', 'materials'], notes: 'Match edge softness and glaze.' }
    const result = await studio.applyScenePatch({ projectId, baseRevision, operations: [
      { op: 'asset.add', asset: uploaded.asset }, { op: 'project.brief.set', goal, referenceImages: [reference] },
    ], saveCheckpoint: false, renderPreview: false })
    return { result, reference }
  }
  // Only the render seam is substituted; revisions, hashes, decoding and persisted review records are real.
  studio.renderViews = async request => ({ digest: sceneSpecDigest(studio.store.readRevisionSpec(projectId, request.revision)),
    views: [{ viewId: 'front', role: 'front', cameraId: 'camera-main', frame: 1, width: 24, height: 18, metrics: { objects: [{ id: 'watch-body', visiblePixels: 100, silhouettePixels: 100, inFrame: true, centroid: [0.5, 0.5], frameCoverage: 0.3, visibleFraction: 1 }], luminance: { mean: 0.4, p05: 0.1, p95: 0.7, clippedDarkFraction: 0, clippedBrightFraction: 0 } } }],
    pngs: { front: PNG }, warnings: [], subjectId: 'watch-body', profile: {}, track: [], checkpointRevision: null })
  return { studio, projectId, upload, bind, saved, sent, root }
}

test('upload validates and stores exact content without changing any revision', async t => {
  const { studio, projectId, upload } = await setup(t)
  const result = await upload()
  assert.match(result.asset.id, /^reference-/)
  assert.equal(result.asset.path, `assets/raw/${result.image.sha256}.png`)
  assert.deepEqual([result.image.width, result.image.height, result.image.mime, result.image.bytes], [24, 18, 'image/png', PNG.length])
  assert.ok(readFileSync(join(studio.store.projectDirectory(projectId), result.asset.path)).equals(PNG))
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
  assert.equal(studio.store.readRevisionSpec(projectId, 'r0001').project.referenceImages, undefined)
  assert.ok(!readdirSync(join(studio.store.projectDirectory(projectId), 'assets')).some(name => name.startsWith('.reference-upload-')))
})

test('references and goals follow the selected immutable revision, including after restore', async t => {
  const { studio, projectId, upload, bind } = await setup(t)
  const uploaded = await upload(); const { reference } = await bind(uploaded)
  const files = await studio.readReferenceImages({ projectId, revision: 'r0002' })
  assert.equal(files[0].id, reference.id); assert.ok(files[0].data.equals(PNG))
  assert.deepEqual(await studio.readReferenceImages({ projectId, revision: 'r0001' }), [])
  assert.equal((await studio.getProject(projectId)).goal, 'Smooth ceramic with a restrained glaze')
  assert.equal((await studio.listProjects()).projects[0].goal, 'Smooth ceramic with a restrained glaze')
  assert.equal((await studio.getProject(projectId, { revision: 'r0001' })).goal, 'Original goal')
  await studio.restoreRevision({ projectId, revision: 'r0001', expectedCurrentRevision: 'r0002' })
  assert.equal((await studio.listProjects()).projects[0].goal, 'Original goal')
  assert.ok((await studio.readReferenceImages({ projectId, revision: 'r0002' }))[0].data.equals(PNG))
})

test('reusing an ingestion alias cannot replace a revision reference', async t => {
  const { studio, projectId, upload, bind, root } = await setup(t)
  const uploaded = await upload(); await bind(uploaded)
  const path = join(root, 'replacement.png'); writeFileSync(path, OTHER)
  const replacement = await studio.ingestAsset({ projectId, sourcePath: path, assetId: uploaded.asset.id })
  assert.notEqual(replacement.sha256, uploaded.asset.sha256)
  assert.ok((await studio.readReferenceImages({ projectId, revision: 'r0002' }))[0].data.equals(PNG))
})

test('upload refuses malformed, mismatched, oversized and interrupted bodies without binding or staging residue', async t => {
  const { studio, projectId, upload } = await setup(t)
  await assert.rejects(upload(Buffer.from('not an image')), { code: 'ASSET_CONTENT_MISMATCH' })
  await assert.rejects(upload(PNG, 'photo.jpg', 'image/jpeg'), { code: 'ASSET_CONTENT_MISMATCH' })
  await assert.rejects(upload(Buffer.alloc(8 * 1024 * 1024 + 1)), { code: 'ASSET_TOO_LARGE' })
  await assert.rejects(upload(PNG, '../outside.png'), { code: 'PATH_SEGMENT_INVALID' })
  const stream = Readable.from((async function* () { yield PNG.subarray(0, 8); throw new Error('upload disconnected') })())
  await assert.rejects(studio.uploadReferenceImage({ projectId, name: 'partial.png', stream }), /upload disconnected/)
  assert.deepEqual(readdirSync(join(studio.store.projectDirectory(projectId), 'assets')), [])
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0001')
})

test('review sends the exact reference bytes alongside the rendered sheet and records their inventory', async t => {
  const { studio, projectId, upload, bind, saved, sent } = await setup(t)
  const uploaded = await upload(); const { reference } = await bind(uploaded)
  const review = await studio.visualReview({ projectId, revision: 'r0002', consultReviewer: true })
  assert.equal(review.reviewer.error, null)
  assert.equal(saved.length, 2); assert.ok(saved[1].data.equals(PNG))
  assert.equal(sent.length, 1); assert.equal(sent[0].messages[0].content.filter(item => item.type === 'image').length, 2)
  assert.match(sent[0].messages[0].content[0].text, /referenceIds/)
  assert.equal(review.referenceImages[0].id, reference.id)
  assert.equal(review.referenceImages[0].sha256, uploaded.asset.sha256)
  assert.equal(review.referenceImages[0].data, undefined)
  assert.equal(review.reviewInputsDigest, reviewInputsDigest(studio.store.readRevisionSpec(projectId, 'r0002')))
  assert.equal(review.artistic.status, 'unassessable')
  const persisted = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), review.reviewArtifact.path)))
  assert.deepEqual(persisted.review.referenceImages, review.referenceImages)
  assert.equal(JSON.stringify(persisted).includes('"type":"Buffer"'), false)
})

test('unreadable or tampered reference keeps render evidence and refuses any model call', async t => {
  const { studio, projectId, upload, bind, sent } = await setup(t)
  const uploaded = await upload(); await bind(uploaded)
  const path = join(studio.store.projectDirectory(projectId), uploaded.asset.path)
  writeFileSync(path, OTHER)
  const review = await studio.visualReview({ projectId, revision: 'r0002', consultReviewer: true })
  assert.equal(review.referenceInputError.code, 'ASSET_HASH_MISMATCH')
  assert.equal(review.reviewer.error.code, 'ASSET_HASH_MISMATCH')
  assert.equal(review.artistic.status, 'unassessable'); assert.equal(sent.length, 0)
  assert.ok(review.sheetArtifact.path); assert.equal(typeof review.technicalPass, 'boolean')
  rmSync(path)
  const missing = await studio.visualReview({ projectId, revision: 'r0002', consultReviewer: false, iteration: 1 })
  assert.equal(missing.referenceInputError.code, 'ASSET_SOURCE_NOT_FOUND')
  assert.equal(missing.artistic.status, 'unassessable')
})

test('the reviewer refuses dropped or altered attachments before any attachment save or model call', async t => {
  const { studio, projectId, upload, bind, saved, sent } = await setup(t)
  await bind(await upload())
  const review = await studio.visualReview({ projectId, revision: 'r0002', consultReviewer: false })
  const reviewer = studio.createVisualReviewer()
  await assert.rejects(reviewer({ review, sheetPng: PNG, views: [], referenceImages: [] }), { code: 'ASSET_HASH_MISMATCH' })
  const refs = await studio.readReferenceImages({ projectId, revision: 'r0002' }); refs[0].data = OTHER
  await assert.rejects(reviewer({ review, sheetPng: PNG, views: [], referenceImages: refs }), { code: 'ASSET_HASH_MISMATCH' })
  assert.equal(saved.length, 0); assert.equal(sent.length, 0)
})

test('comparison attaches candidate, baseline, then immutable references in the labeled order', async t => {
  const { studio, projectId, upload, bind, saved, sent } = await setup(t)
  await bind(await upload())
  const review = await studio.visualReview({ projectId, revision: 'r0002', consultReviewer: false })
  const references = await studio.readReferenceImages({ projectId, revision: 'r0002' })
  await studio.createVisualReviewer()({ review, sheetPng: OTHER, baselineSheetPng: PNG,
    baselineReview: { ...review, revision: 'r0001' }, referenceImages: references, views: review.views, iteration: 1 })
  assert.equal(saved.length, 3); assert.ok(saved[0].data.equals(OTHER)); assert.ok(saved[1].data.equals(PNG)); assert.ok(saved[2].data.equals(PNG))
  const content = sent[0].messages[0].content
  assert.equal(content[3].attachment.id, 'image-2'); assert.match(content[4].text, /reference-front/)
})

test('failed automatic review persists the attempted round and error before propagating it', async t => {
  const { studio, projectId, upload, bind } = await setup(t)
  await bind(await upload())
  await assert.rejects(studio.visualLoop({ projectId, revision: 'r0002', maxIterations: 1,
    reviewer: async () => { throw new Error('model timed out') } }), /model timed out/)
  const directory = join(studio.store.revisionDirectory(projectId, 'r0002'), 'visual-reviews')
  const file = readdirSync(directory).find(name => /^loop-.*-proposal\.json$/.test(name))
  assert.ok(file)
  const saved = JSON.parse(readFileSync(join(directory, file))).review
  assert.equal(saved.reviewer.error.message, 'model timed out')
  assert.equal(saved.artistic.status, 'unassessable')
  assert.equal(saved.referenceImages.length, 1)
  assert.equal(saved.reviewInputsDigest, reviewInputsDigest(studio.store.readRevisionSpec(projectId, 'r0002')))
  assert.equal(studio.store.readRecord(projectId).currentRevision, 'r0002')
  const qa = await studio.getQaRecord({ projectId, revision: 'r0002' })
  assert.equal(qa.review.reviewer.error.message, 'model timed out')
})

test('the real HTTP upload responds with structured errors for oversized bodies without closing the connection first', async t => {
  const { createServer } = await import('node:http')
  const { default: BlenderUiHost } = await import('@deepblend/dsh-blender-ui')
  const { studio, projectId } = await setup(t)
  const ctx = new Context(); let handler
  ctx.provide('blenderStudio', studio)
  ctx.provide('webServer', { register(entry) { handler = entry.handler; return () => {} } })
  new BlenderUiHost(ctx, { serveRoute: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof handler, 'function')
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/deepblend/projects/${projectId}/reference-images?name=study.png`
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.alloc(8 * 1024 * 1024 + 1), signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, 'ASSET_TOO_LARGE')
  const chunked = Readable.from((async function* () {
    for (let index = 0; index < 9; index += 1) yield Buffer.alloc(1024 * 1024)
    await new Promise(resolve => setTimeout(resolve, 100))
    yield Buffer.from('tail')
  })())
  const streaming = await fetch(url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: chunked,
    duplex: 'half', signal: AbortSignal.timeout(5000) })
  assert.equal(streaming.status, 413)
  assert.equal((await streaming.json()).error.code, 'ASSET_TOO_LARGE')
  const healthy = await fetch(url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG, signal: AbortSignal.timeout(5000) })
  assert.equal(healthy.status, 200); assert.equal((await healthy.json()).image.bytes, PNG.length)
})
