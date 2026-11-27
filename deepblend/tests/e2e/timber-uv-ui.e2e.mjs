#!/usr/bin/env node
/** Verify paired image attachment and UV editing on the locked 1.1 walnut-trivet in Chrome and Blender. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { decodePng, specHash } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch, fetchFromWebServer as fetch, authenticateWebPage } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `timber-uv-${Date.now()}`))
assert(!existsSync(output), output)
mkdirSync(output, { recursive: true })
const root = join(output, 'store'), id = 'paired-walnut-trivet', project = join(root, 'projects', id)
const members = ['longitudinal-slats', 'cross-slats']
const field = key => `[data-field="editor-uv-${key}"]`
const byAction = action => `[data-action="${action}"]`
const read = (...parts) => JSON.parse(readFileSync(join(project, ...parts)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const checks = []
const pass = name => { checks.push(name); console.log('[PASS]', name) }
const snapshot = () => Object.fromEntries(readdirSync(project, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => {
    const absolute = join(entry.parentPath, entry.name)
    return [absolute.slice(project.length + 1), sha(readFileSync(absolute))]
  }).sort(([a], [b]) => a.localeCompare(b)))
const element = selector => `document.querySelector(${JSON.stringify(selector)})`
let server, browser, page, failure, measurements
try {
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  const legacyRecipes = join(output, 'legacy-recipes')
  mkdirSync(legacyRecipes)
  cpSync(join(REPO_ROOT, 'deepblend', 'tests', 'fixtures', 'walnut-trivet-v1.1'),
    join(legacyRecipes, 'walnut-trivet'), { recursive: true })
  const host = rows.find(row => row.id === 'deepblend-blender-host').config
  host.maxPreviewSamples = 24
  host.recipeDirectories = [legacyRecipes]
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  const endpoint = `${base}/deepblend/projects/${id}`
  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
    return { status: response.status, data: await response.json() }
  }
  const catalog = await (await fetch(base + '/deepblend/recipes')).json()
  const recipe = catalog.recipes.find(value => value.id === 'deepblend.walnut-trivet' && value.version === '1.1.0')
  assert(recipe, JSON.stringify(catalog.errors))
  const created = await post(base + '/deepblend/projects', { projectId: id, title: '木条贴图 · Timber UV',
    recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, parameters: { 'slat-spacing': 64 } }, renderPreview: false })
  assert.equal(created.status, 200, JSON.stringify(created.data.error))

  // A deliberately high-contrast test image makes mapping on the side faces measurable.
  const edge = 64, colors = [[236, 188, 59], [31, 73, 120]], pixels = Buffer.alloc(edge * edge * 3)
  for (let y = 0; y < edge; y++) {
    for (let x = 0; x < edge; x++) {
      pixels.set(colors[(Math.floor(x / 8) + Math.floor(y / 8)) % 2], (y * edge + x) * 3)
    }
  }
  const png = await sharp(pixels, { raw: { width: edge, height: edge, channels: 3 } }).png().toBuffer()
  const roughnessPixels = Buffer.alloc(edge * edge)
  for (let index = 0; index < roughnessPixels.length; index++) roughnessPixels[index] = pixels[index * 3] === colors[0][0] ? 64 : 192
  const roughnessPng = await sharp(roughnessPixels, { raw: { width: edge, height: edge, channels: 1 } }).png().toBuffer()
  const seededAsset = await fetch(endpoint + '/assets?name=shared-uv-roughness.png', {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: roughnessPng, signal: AbortSignal.timeout(30_000),
  })
  const roughnessAsset = await seededAsset.json()
  assert.equal(seededAsset.status, 200, JSON.stringify(roughnessAsset.error))
  assert.equal(roughnessAsset.asset.sha256, sha(roughnessPng))
  const roughnessBinding = { assetId: roughnessAsset.asset.id, uvMap: 'UVMap', channel: 'r' }
  const differentiated = await post(endpoint + '/patch', { patch: { baseRevision: 'r0001', saveCheckpoint: true,
    renderPreview: true, operations: [
      { op: 'asset.add', asset: roughnessAsset.asset },
      { op: 'material.parameter.update', materialId: 'walnut-crosswise', parameter: 'roughness', value: .57 },
      { op: 'material.texture.set', materialId: 'walnut-crosswise', texture: null },
      { op: 'material.images.set', materialId: 'walnut-crosswise', images: { roughness: roughnessBinding } },
    ] } })
  assert.equal(differentiated.status, 200, JSON.stringify(differentiated.data.error))
  browser = await Browser.launch({ args: ['--window-size=1440,1100', '--accept-lang=en-US,en'] })
  page = await browser.newPage()
  await page.addInitScript(`window.uvRequests = []
    const originalFetch = window.fetch
    window.fetch = async (url, options) => {
      const relevant = options?.method === 'POST' && /\\/(patch|timber-uv-preview)$/.test(String(url))
      const item = relevant && { url: String(url), body: JSON.parse(options.body) }
      if (item) {
        window.uvRequests.push(item)
        options.signal?.addEventListener('abort', () => { item.aborted = true }, { once: true })
      }
      const result = await originalFetch(url, options)
      if (item) { item.status = result.status; item.reply = await result.clone().json() }
      return result
    }`)
  await authenticateWebPage(page, server)
  await page.goto(base + '/deepblend/workbench')
  await page.waitFor(`${element('[data-lighttable-revision="r0002"]')} !== null`, 45_000)
  await clickWorkbenchControl(page, '[data-view-tab="scene"]')
  const materialRevision = read('revisions', 'r0002', 'scene-spec.json')
  assert.notEqual(materialRevision.materials.find(m => m.id === 'walnut-crosswise').parameters.roughness,
    materialRevision.materials.find(m => m.id === 'walnut-lengthwise').parameters.roughness)

  const pointer = selector => clickWorkbenchControl(page, selector)
  const assetField = name => `[data-field="asset-${name}"]`
  async function choose(selector, value) {
    await page.waitFor(`${element(selector)} !== null`, 30_000)
    await page.evaluate(`(() => {
      const control = ${element(selector)}
      control.value = ${JSON.stringify(value)}
      control.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }

  await pointer(byAction('assets-open'))
  await page.waitFor(`${element(assetField('upload'))} !== null`, 30_000)
  const sourceName = 'wood-repeat-test.png', sourceImage = join(output, sourceName)
  writeFileSync(sourceImage, png)
  const { root: documentRoot } = await page.send('DOM.getDocument')
  const picker = await page.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: assetField('upload') })
  await page.send('DOM.setFileInputFiles', { nodeId: picker.nodeId, files: [sourceImage] })
  await page.waitFor(`Array.from(document.querySelectorAll('[data-asset-id]')).some(card => card.textContent.includes(${JSON.stringify(sourceName)}))`, 30_000)
  const library = await (await fetch(endpoint + '/assets')).json()
  const { asset } = library.assets.find(row => row.originalName === sourceName)
  assert.equal(asset.sha256, sha(png))
  const afterUpload = snapshot()
  const card = `[data-asset-id="${asset.id}"][data-asset-path="${asset.path}"]`
  await pointer(`${card} ${byAction('asset-preview:' + asset.id)}`)
  await page.waitFor(`${element(card + ' [data-asset-preview]')}?.naturalWidth > 0`, 30_000)
  const inspected = snapshot()
  await pointer(`${card} ${byAction('asset-use:' + asset.id)}`)
  await choose(assetField('target-entity'), members[0])
  const includePartner = assetField('include-timber-partner'), replaceTexture = assetField('replace-texture')
  const assetSave = byAction('asset-apply')
  assert.equal(await page.evaluate(`${element(includePartner)}.checked`), false)
  assert.match(await page.text(`label:has(${includePartner})`), /cross-slats/)
  await pointer(replaceTexture)
  await pointer(includePartner)
  assert.equal(await page.evaluate(`${element(replaceTexture)}.checked`), false)
  assert.equal(await page.evaluate(`${element(assetSave)}.disabled`), true)
  await choose(assetField('map-channel'), 'roughness')
  assert.equal(await page.count(includePartner), 0)
  await choose(assetField('map-channel'), 'baseColor')
  assert.equal(await page.evaluate(`${element(includePartner)}.checked`), false)
  await pointer(includePartner)
  await pointer(replaceTexture)
  assert.deepEqual(snapshot(), inspected)
  assert.equal(await page.evaluate('window.uvRequests.length'), 0)
  assert.equal(read('project.json').currentRevision, 'r0002')
  pass('the uploaded image is ready for both named groups only after explicit opt-in and replacement')

  for (const [name, width, height] of [['paired-material-desktop.png', 1440, 1100], ['paired-material-mobile.png', 390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`${element(includePartner)}.closest('label').scrollIntoView({ block: 'center' })`)
    const usable = await page.evaluate(`(() => {
      const label = ${element(includePartner)}.closest('label').getBoundingClientRect()
      const save = ${element(assetSave)}.getBoundingClientRect()
      return label.top >= 0 && label.left >= 0 && label.right <= innerWidth
        && save.top >= label.bottom && save.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth
    })()`)
    assert.equal(usable, true, name)
    await page.screenshot(join(output, name))
  }
  await pointer(assetSave)
  await page.waitFor(`${element('[data-lighttable-revision="r0003"]')} !== null`, 70_000)
  const applied = await page.evaluate('window.uvRequests[0]')
  assert.equal(applied.status, 200, JSON.stringify(applied.reply?.error))
  assert.equal(applied.body.patch.baseRevision, 'r0002')
  assert.deepEqual(applied.body.patch.operations.map(op => op.op),
    ['asset.add','material.add','entity.material.set','material.add','entity.material.set'])
  const appliedSpec = read('revisions', 'r0003', 'scene-spec.json')
  const bindingIds = members.map(id => appliedSpec.entities.find(entity => entity.id === id).materialId)
  assert.equal(new Set(bindingIds).size, 2)
  for (const [index, materialId] of bindingIds.entries()) {
    const entity = materialRevision.entities.find(entity => entity.id === members[index])
    const old = materialRevision.materials.find(material => material.id === entity.materialId)
    const next = appliedSpec.materials.find(material => material.id === materialId)
    assert.deepEqual(next.parameters, old.parameters)
    assert.equal(next.images.baseColor.assetId, asset.id)
    assert.deepEqual(next.images.roughness, old.images?.roughness)
    assert(!Object.hasOwn(next, 'texture'))
  }
  const byId = values => Object.fromEntries(values.map(value => [value.id, value]))
  assert.deepEqual(byId(appliedSpec.materials.filter(material => !bindingIds.includes(material.id))), byId(materialRevision.materials))
  const originalMaterialIds = new Map(materialRevision.entities.map(entity => [entity.id, entity.materialId]))
  const restoredEntities = appliedSpec.entities.map(entity => members.includes(entity.id)
    ? { ...entity, materialId: originalMaterialIds.get(entity.id) } : entity)
  assert.deepEqual(byId(restoredEntities), byId(materialRevision.entities))
  assert.deepEqual(appliedSpec.halfLaps, materialRevision.halfLaps)
  for (const [name,digest] of Object.entries(afterUpload)) {
    if (name.startsWith('revisions/')) assert.equal(sha(readFileSync(join(project,name))), digest, name)
  }
  pass('one real browser save attaches the same image to independent materials and keeps saved history')
  await pointer('[data-view-tab="scene"]')

  const beforeSpec = read('revisions', 'r0003', 'scene-spec.json')
  const savedLock = read('revisions', 'r0001', 'recipe-lock.json')
  assert.equal(savedLock.version, '1.1.0')
  const frame = beforeSpec.project.frameStart, cameraId = 'detail'
  async function fixedView(revision) {
    const { status, data } = await post(endpoint + '/preview', { revision, mode: 'beauty', samples: 24,
      views: [{ id: 'detail', cameraId, frame }] })
    assert.equal(status, 200, JSON.stringify(data.error))
    const artifact = data.preview.artifacts[0]
    return { artifact, png: readFileSync(join(project, artifact.path)) }
  }
  const before = await fixedView('r0003')
  writeFileSync(join(output, 'before.png'), before.png)
  const original = snapshot()
  const assertDraftDidNotWrite = () => assert.deepEqual(snapshot(), original)
  async function waitForScratch(expected) {
    const deadline = Date.now() + 15_000
    const present = () => readdirSync(join(root, 'tmp')).some(name => name.startsWith('timber-uv-'))
    while (present() !== expected && Date.now() < deadline) await delay(50)
    assert.equal(present(), expected, 'Blender preview scratch state')
  }

  await clickWorkbenchControl(page, byAction('select-entity:' + members[0]))
  await page.waitFor(`${element(field('project'))} !== null`, 30_000)
  assert.equal((await page.click(field('project'))).via, 'pointer')
  assert.equal(await page.evaluate(`${element(field('partner'))}.checked`), false)
  assert.equal((await page.click(field('partner'))).via, 'pointer')
  await page.evaluate(`(() => {
    const camera = ${element(field('camera'))}
    camera.value = 'detail'
    camera.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const previewAction = byAction('timber-uv-preview'), cancelAction = byAction('timber-uv-preview-cancel')
  const applyAction = byAction('editor-apply')
  assert.equal(await page.evaluate('window.uvRequests.length'), 1)
  pass('the second member is explicit and neither selection writes anything')

  assert.equal((await page.click(previewAction)).via, 'pointer')
  await page.waitFor(`${element(cancelAction)} !== null`, 20_000)
  await waitForScratch(true)
  assert.equal(await page.evaluate(`${element(applyAction)}.disabled`), true)
  assert.equal((await page.click(cancelAction)).via, 'pointer')
  assert.equal(await page.evaluate('window.uvRequests.find(item => item.url.endsWith("/timber-uv-preview")).aborted'), true)
  await waitForScratch(false)
  assertDraftDidNotWrite()
  pass('cancelling the actual workbench request retains the current revision and files')

  const render = async () => {
    assert.equal((await page.click(previewAction)).via, 'pointer')
    await page.waitFor(`document.querySelector('[data-timber-uv-preview="ready"] img')?.naturalWidth > 0
      || document.querySelector('[data-timber-uv-preview="error"]') !== null`, 70_000)
    const last = await page.evaluate('window.uvRequests.at(-1)')
    assert.equal(last.status, 200, JSON.stringify(last.reply?.error))
    return last
  }
  const first = await render()
  const receipt = first.reply.preview
  assert.equal(receipt.cameraId, cameraId)
  assert.equal(receipt.frame, frame)
  assert.deepEqual(receipt.entities, members)
  assert.equal(receipt.baseRevision, 'r0003')
  const incomplete = structuredClone(first.body)
  incomplete.patch.operations.pop()
  const refused = await post(endpoint + '/timber-uv-preview', incomplete)
  assert.equal(refused.data.error.code, 'SCENE_PATCH_INVALID')
  assertDraftDidNotWrite()
  pass('the paired draft renders through Blender with the saved detail camera and writes no project files')

  await page.fill(field('scale'), '2')
  assert.equal(await page.evaluate('document.querySelector("[data-timber-uv-preview]")?.dataset.timberUvPreview'), 'idle')
  const last = await render(), preview = last.reply.preview
  assert.notEqual(preview.candidateSpecHash, receipt.candidateSpecHash)
  const draftImage = Buffer.from(preview.image.pngBase64, 'base64')
  assert.equal(sha(draftImage), preview.image.sha256)
  const settings = item => [item.width, item.height, item.samples, item.engine]
  assert.deepEqual(settings(preview.image), settings(before.artifact))
  const aa = decodePng(before.png), bb = decodePng(draftImage)
  const changed = aa.data.reduce((total, channel, i) => total + Number(i % 4 !== 3 && Math.abs(channel - bb.data[i]) > 8), 0)
  assert(changed > 1000, changed)
  writeFileSync(join(output, 'draft.png'), draftImage)
  pass('editing repeats retires the old preview, and the equal-setting rendered texture measurably changes')

  for (const [name, width, height, theme] of [['desktop.png', 1440, 1100, 'dark'], ['mobile.png', 390, 844, 'light']]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await page.evaluate(`(() => {
      const theme = document.querySelector('[data-field="workbench-appearance"]')
      theme.value = ${JSON.stringify(theme)}
      theme.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-timber-uv-preview]').scrollIntoView({ block: 'center' })
    })()`)
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const fit = await page.evaluate(`(() => {
      const panel = document.querySelector('[data-timber-uv-preview]')
      const rect = panel.querySelector('img').getBoundingClientRect()
      const save = panel.querySelector('[data-action="editor-apply"]').getBoundingClientRect()
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
        && save.top >= rect.bottom && save.bottom <= innerHeight && document.querySelectorAll('[data-action="editor-apply"]').length === 1
    })()`)
    assert.equal(fit, true, name)
    await page.screenshot(join(output, name))
  }
  assert.equal((await page.click(applyAction)).via, 'pointer')
  await page.waitFor(`document.querySelector('[data-lighttable-revision="r0004"]') !== null`, 60_000)
  const writes = await page.evaluate('window.uvRequests.filter(item => item.url.endsWith("/patch") && item.body.patch.baseRevision === "r0003")')
  assert.equal(writes.length, 1)
  const request = writes[0].body
  assert.equal(request.expectedSpecHash, preview.candidateSpecHash)
  assert.deepEqual(request.patch, last.body.patch)
  assert.equal(request.patch.operations.length, 2)
  assert(request.patch.operations.every(op => op.op === 'entity.uv.project' && op.scale === 2))
  const saved = read('revisions', 'r0004', 'scene-spec.json')
  assert.equal(specHash(saved), preview.candidateSpecHash)
  const saveWithoutUv = structuredClone(saved)
  for (const entity of saveWithoutUv.entities.filter(e => members.includes(e.id))) {
    assert(entity.generator.faceUvs?.length > 0)
    delete entity.generator.faceUvs
  }
  assert.deepEqual(saveWithoutUv, beforeSpec)
  for (const [path, digest] of Object.entries(original)) {
    if (path !== 'project.json') assert.equal(sha(readFileSync(join(project, path))), digest, path)
  }
  pass('one browser save commits exactly both projections and preserves the original recipe lock and history')

  const after = await fixedView('r0004')
  assert.deepEqual(settings(after.artifact), settings(before.artifact))
  const savedImage = decodePng(after.png)
  assert.deepEqual(savedImage.data, bb.data)
  writeFileSync(join(output, 'saved.png'), after.png)
  const nativePath = join(output, 'native.json')
  writeFileSync(join(output, 'native.log'), execFileSync(blenderPath, ['--background', '--factory-startup', '--disable-autoexec',
    '--python-exit-code', '1', '--python', join(REPO_ROOT, 'deepblend/tests/lib/inspect-native-mesh-uv.py'), '--',
    join(project, 'revisions', 'r0003', 'scene.blend'), join(project, 'revisions', 'r0004', 'scene.blend'), nativePath, ...members],
  { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }))
  const native = JSON.parse(readFileSync(nativePath))
  measurements = { repair: members.map(member => ({ member, before: native.before.uvMaps[member][0].zeroAreaTriangleCount,
    after: native.after.uvMaps[member][0].zeroAreaTriangleCount })), changedChannelsOver8: changed, cameraId, frame, samples: preview.image.samples }
  pass('the saved detail render matches the draft pixels and independent Blender reopens confirm both UV repairs')

  const stale = await post(endpoint + '/timber-uv-preview', last.body)
  assert.equal(stale.status, 409, JSON.stringify(stale.data.error))
  assert.equal(stale.data.error.code, 'REVISION_CONFLICT')
  assert.equal(read('project.json').currentRevision, 'r0004')
  pass('a preview from an older base is refused after saving')

  const restored = await post(endpoint + '/restore', { revision: 'r0002', expectedCurrentRevision: 'r0004' })
  assert.equal(restored.status, 200, JSON.stringify(restored.data.error))
  assert.equal(read('project.json').currentRevision, 'r0002')
  await page.goto(base + '/deepblend/workbench')
  await page.waitFor(`${element('[data-lighttable-revision="r0002"]')} !== null`, 45_000)
  await pointer('[data-view-tab="scene"]')
  await pointer(byAction('assets-open'))
  await page.waitFor(`${element(card + ' [data-asset-preview]')}?.naturalWidth > 0`, 30_000)
  const restoredFiles = snapshot()
  await pointer(`${card} ${byAction('asset-use:' + asset.id)}`)
  await choose(assetField('target-entity'), members[0])
  await pointer(includePartner)
  await pointer(replaceTexture)
  const rebuild = assetField('rebuild-timber-uvs'), repeat = assetField('uv-repeats')
  assert.equal(await page.evaluate(`${element(rebuild)}.checked`), false)
  await pointer(rebuild)
  assert.match(await page.text('[data-asset-base-revision="r0002"]'), /Other images on the same UV layer will follow the new coordinates/)
  await page.fill(repeat, '0')
  const combinedAction = byAction('asset-timber-uv-preview'), combinedCancel = byAction('asset-timber-uv-preview-cancel')
  assert.equal(await page.evaluate(`${element(assetSave)}.disabled && ${element(combinedAction)}.disabled`), true)
  await page.fill(repeat, '2')
  await choose(assetField('uv-camera'), cameraId)
  await pointer(combinedAction)
  await page.waitFor(`${element(combinedCancel)} !== null`, 20_000)
  await waitForScratch(true)
  assert.equal(await page.evaluate(`${element(assetSave)}.disabled`), true)
  await pointer(combinedCancel)
  assert.equal(await page.evaluate('window.uvRequests.at(-1).aborted'), true)
  await waitForScratch(false)
  assert.deepEqual(snapshot(), restoredFiles)
  pass('the combined preview requires valid settings and cancels without changing the restored project')

  await pointer(combinedAction)
  await page.waitFor(`${element('[data-asset-timber-uv-preview="ready"] img')}?.naturalWidth > 0
    || ${element('[data-asset-timber-uv-preview="error"]')} !== null`, 70_000)
  const combined = await page.evaluate('window.uvRequests.at(-1)')
  assert.equal(combined.status, 200, JSON.stringify(combined.reply?.error))
  const combinedPreview = combined.reply.preview
  assert.equal(combinedPreview.baseRevision, 'r0002')
  assert.equal(combinedPreview.cameraId, cameraId)
  assert.equal(combinedPreview.frame, frame)
  assert.deepEqual(combinedPreview.entities, members)
  assert.deepEqual(settings(combinedPreview.image), settings(preview.image))
  const combinedImage = Buffer.from(combinedPreview.image.pngBase64, 'base64')
  assert.equal(sha(combinedImage), combinedPreview.image.sha256)
  assert.deepEqual(decodePng(combinedImage).data, savedImage.data)
  const missingTarget = structuredClone(combined.body.patch)
  missingTarget.operations.find(operation => operation.op === 'entity.material.set').entityId = 'missing-timber'
  const missing = await post(endpoint + '/patch', { patch: missingTarget })
  assert.equal(missing.status, 422, JSON.stringify(missing.data.error))
  assert.equal(missing.data.error.code, 'PATCH_TARGET_MISSING')
  assert.deepEqual(snapshot(), restoredFiles)
  pass('the combined draft matches the two-save render and a missing target leaves the project unchanged')

  await pointer(assetSave)
  await page.waitFor(`${element('[data-lighttable-revision="r0005"]')} !== null`, 70_000)
  const [compoundWrite, ...extraWrites] = await page.evaluate('window.uvRequests.filter(item => item.url.endsWith("/patch"))')
  assert.equal(extraWrites.length, 0)
  assert.equal(compoundWrite.status, 200, JSON.stringify(compoundWrite.reply?.error))
  assert.deepEqual(compoundWrite.body.patch, combined.body.patch)
  assert.equal(compoundWrite.body.expectedSpecHash, combinedPreview.candidateSpecHash)
  assert.equal(compoundWrite.body.expectedStoreIdentity, combinedPreview.storeIdentity)
  assert.deepEqual(compoundWrite.body.patch.operations.map(operation => operation.op),
    ['asset.add', 'material.add', 'entity.material.set', 'material.add', 'entity.material.set', 'entity.uv.project', 'entity.uv.project'])
  const compoundSpec = read('revisions', 'r0005', 'scene-spec.json')
  assert.equal(specHash(compoundSpec), combinedPreview.candidateSpecHash)
  function normalizeCopies(spec) {
    const normalized = structuredClone(spec)
    members.forEach((id, index) => {
      const entity = normalized.entities.find(item => item.id === id)
      const material = normalized.materials.find(item => item.id === entity.materialId)
      entity.materialId = material.id = `timber-copy-${index}`
    })
    return normalized
  }
  assert.deepEqual(normalizeCopies(compoundSpec), normalizeCopies(saved))
  const crossSlatsMaterialId = compoundSpec.entities.find(entity => entity.id === members[1]).materialId
  const crossSlatsMaterial = compoundSpec.materials.find(material => material.id === crossSlatsMaterialId)
  assert.deepEqual(crossSlatsMaterial.images.roughness, roughnessBinding)
  for (const [path, digest] of Object.entries(restoredFiles)) {
    if (path !== 'project.json') assert.equal(sha(readFileSync(join(project, path))), digest, path)
  }
  const compoundView = await fixedView('r0005')
  assert.deepEqual(settings(compoundView.artifact), settings(after.artifact))
  assert.deepEqual(decodePng(compoundView.png).data, savedImage.data)
  writeFileSync(join(output, 'combined-saved.png'), compoundView.png)
  measurements.combined = { baseRevision: 'r0002', savedRevision: 'r0005', saves: 1, separateSaves: 2, matchingPixels: true,
    sharedLayerRoughnessPreserved: true }
  pass('one asset-panel save reproduces the scene and fixed-camera pixels of the separate edits')
} catch (error) {
  failure = { message: error.message, stack: error.stack }
  await page?.screenshot(join(output, 'failure.png')).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await server?.stop()
  save('result.json', { status: failure ? 'failed' : 'passed', checks, failure, measurements })
}
