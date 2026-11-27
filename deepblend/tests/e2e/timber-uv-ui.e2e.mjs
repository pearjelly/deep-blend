#!/usr/bin/env node
/** Verify paired texture editing on the locked 1.1 walnut-trivet recipe in Chrome and Blender. */
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
  const hash = sha(png), assetId = 'timber-test-checker', assetPath = `assets/raw/${hash}.png`
  mkdirSync(join(project, 'assets', 'raw'), { recursive: true })
  writeFileSync(join(project, assetPath), png)
  const materials = ['walnut-lengthwise', 'walnut-crosswise']
  const seeded = await post(endpoint + '/patch', { patch: { baseRevision: 'r0001', saveCheckpoint: true, renderPreview: true,
    operations: [{ op: 'asset.add', asset: { id: assetId, type: 'png', path: assetPath, sha256: hash } },
      ...materials.flatMap(materialId => [{ op: 'material.texture.set', materialId, texture: null },
        { op: 'material.images.set', materialId, images: { baseColor: { assetId } } }])] } })
  assert.equal(seeded.status, 200, JSON.stringify(seeded.data.error))
  const beforeSpec = read('revisions', 'r0002', 'scene-spec.json')
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
  const before = await fixedView('r0002')
  writeFileSync(join(output, 'before.png'), before.png)
  const original = snapshot()
  const assertDraftDidNotWrite = () => assert.deepEqual(snapshot(), original)
  async function waitForScratch(expected) {
    const deadline = Date.now() + 15_000
    const present = () => readdirSync(join(root, 'tmp')).some(name => name.startsWith('timber-uv-'))
    while (present() !== expected && Date.now() < deadline) await delay(50)
    assert.equal(present(), expected, 'Blender preview scratch state')
  }

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
  assert.equal(await page.evaluate('window.uvRequests.length'), 0)
  pass('the second member is explicit and neither selection writes anything')

  assert.equal((await page.click(previewAction)).via, 'pointer')
  await page.waitFor(`${element(cancelAction)} !== null`, 20_000)
  await waitForScratch(true)
  assert.equal(await page.evaluate(`${element(applyAction)}.disabled`), true)
  assert.equal((await page.click(cancelAction)).via, 'pointer')
  assert.equal(await page.evaluate('window.uvRequests[0].aborted'), true)
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
  assert.equal(receipt.baseRevision, 'r0002')
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
  await page.waitFor(`document.querySelector('[data-lighttable-revision="r0003"]') !== null`, 60_000)
  const writes = await page.evaluate('window.uvRequests.filter(item => item.url.endsWith("/patch"))')
  assert.equal(writes.length, 1)
  const request = writes[0].body
  assert.equal(request.expectedSpecHash, preview.candidateSpecHash)
  assert.deepEqual(request.patch, last.body.patch)
  assert.equal(request.patch.operations.length, 2)
  assert(request.patch.operations.every(op => op.op === 'entity.uv.project' && op.scale === 2))
  const saved = read('revisions', 'r0003', 'scene-spec.json')
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

  const after = await fixedView('r0003')
  assert.deepEqual(settings(after.artifact), settings(before.artifact))
  const savedImage = decodePng(after.png)
  assert.deepEqual(savedImage.data, bb.data)
  writeFileSync(join(output, 'saved.png'), after.png)
  const nativePath = join(output, 'native.json')
  writeFileSync(join(output, 'native.log'), execFileSync(blenderPath, ['--background', '--factory-startup', '--disable-autoexec',
    '--python-exit-code', '1', '--python', join(REPO_ROOT, 'deepblend/tests/lib/inspect-native-mesh-uv.py'), '--',
    join(project, 'revisions', 'r0002', 'scene.blend'), join(project, 'revisions', 'r0003', 'scene.blend'), nativePath, ...members],
  { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }))
  const native = JSON.parse(readFileSync(nativePath))
  measurements = { repair: members.map(member => ({ member, before: native.before.uvMaps[member][0].zeroAreaTriangleCount,
    after: native.after.uvMaps[member][0].zeroAreaTriangleCount })), changedChannelsOver8: changed, cameraId, frame, samples: preview.image.samples }
  pass('the saved detail render matches the draft pixels and independent Blender reopens confirm both UV repairs')

  const stale = await post(endpoint + '/timber-uv-preview', last.body)
  assert.equal(stale.status, 409, JSON.stringify(stale.data.error))
  assert.equal(stale.data.error.code, 'REVISION_CONFLICT')
  assert.equal(read('project.json').currentRevision, 'r0003')
  pass('a preview from an older base is refused after saving')
} catch (error) {
  failure = { message: error.message, stack: error.stack }
  await page?.screenshot(join(output, 'failure.png')).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await server?.stop()
  save('result.json', { status: failure ? 'failed' : 'passed', checks, failure, measurements })
}
