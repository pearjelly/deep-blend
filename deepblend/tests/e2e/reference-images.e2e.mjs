#!/usr/bin/env node
/** Real PNG file input, revision save/reload and unavailable-reviewer handling.
 * Without arguments, creates an isolated Host and a checkpoint from the shipped
 * glass-ceramic recipe. Pass server-info.json to reuse an existing clean fixture.
 * No fake model response, image byte replacement, or visual improvement claim.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const infoPath = process.argv[2] ? resolve(process.argv[2]) : null
let info = infoPath ? JSON.parse(readFileSync(infoPath)) : null
const projectId = 'project', timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const directory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || (info
  ? join(info.root, `run-${timestamp}`)
  : join(REPO_ROOT, '.deepblend', 'quality', `reference-images-ui-${timestamp}`)))
mkdirSync(directory, { recursive: true })
const input = join(REPO_ROOT, 'deepblend/recipes/glass-ceramic/preview.png')
copyFileSync(input, join(directory, 'reference-product.png'))
const uploadFile = join(directory, 'reference-product.png')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const read = (...parts) => JSON.parse(readFileSync(join(info.root, 'projects', projectId, ...parts)))
let before, beforeSpec, originalPaths = [], originals = {}
const results = [], startedAt = new Date().toISOString()
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok) throw new Error(name)
}
let browser, page, server, shutdown, after, referenceId, outcome
try {
  if (!info) {
    const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
    if (!existsSync(blenderPath)) throw new Error(`Blender not found at ${blenderPath}; set DEEPBLEND_BLENDER_PATH. See deepblend/docs/dsh-baseline.md §5.`)
    const store = join(directory, 'store'), rows = JSON.parse(await storePatch(store))
    rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
    const host = rows.find(row => row.id === 'deepblend-blender-host')
    host.config.maxPreviewSamples = 16
    // Exercise the real model-availability preflight, without a network model call.
    host.config.visualReviewModel = 'deepblend-reference-ui-unavailable'
    server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
    const base = `http://127.0.0.1:${server.port}`
    info = { root: store, url: `${base}/deepblend/workbench`, port: server.port }
    writeFileSync(join(directory, 'server-info.json'), JSON.stringify(info, null, 2))
    const catalogResponse = await fetch(`${base}/deepblend/recipes`)
    const catalog = await catalogResponse.json()
    const recipe = catalog.recipes?.find(entry => entry.id === 'deepblend.glass-ceramic')
    check('the isolated Host exposes the validated glass-ceramic recipe', catalogResponse.ok && recipe?.digest?.length === 64)
    const created = await fetch(`${base}/deepblend/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title: projectId, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, parameters: {} }, renderPreview: false }),
      signal: AbortSignal.timeout(180000),
    })
    if (!created.ok) throw new Error(`Recipe fixture creation failed (${created.status}): ${await created.text()}`)
    const current = read('project.json').currentRevision
    check('fixture creation saves a real checkpoint without rendering a preview', current === 'r0001'
      && existsSync(join(store, 'projects', projectId, 'revisions', current, 'scene.blend'))
      && read('revisions', current, 'revision-manifest.json').previews.length === 0)
  }
  before = read('project.json').currentRevision
  originalPaths = ['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(path => join(info.root, 'projects', projectId, 'revisions', before, path))
  originals = Object.fromEntries(originalPaths.map(path => [path, sha256(readFileSync(path))]))
  beforeSpec = read('revisions', before, 'scene-spec.json')
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] })
  page = await browser.newPage()
  await page.addInitScript(`
    window.__referenceRequests = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      let body
      try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined } catch {}
      window.__referenceRequests.push({ url: String(input), method: init?.method || 'GET', body,
        bodyType: init?.body?.constructor?.name, fileBytes: init?.body instanceof File ? init.body.size : null,
        mediaType: init?.headers?.['content-type'] })
      return originalFetch(input, init)
    }
  `)
  await page.goto(info.url)
  await page.waitFor(`document.querySelector('[data-brief-project="${projectId}"][data-brief-base-revision="${before}"]') !== null`, 45000)
  check('the browser opens a real revision-backed brief editor', true, { url: info.url, before })
  check('the goal comes from the saved SceneSpec', await page.evaluate(`document.querySelector('[data-field="brief-goal"]').value`) === (beforeSpec.project.goal || ''))
  check('this isolated fixture starts without references', (beforeSpec.project.referenceImages || []).length === 0)
  await page.evaluate(`document.querySelector('[data-field="brief-upload"]').scrollIntoView({block:'center'})`)
  const { root } = await page.send('DOM.getDocument')
  const selected = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-field="brief-upload"]' })
  await page.send('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [uploadFile] })
  await page.waitFor('document.querySelectorAll("[data-reference-id]").length === 1', 30000)
  referenceId = await page.evaluate('document.querySelector("[data-reference-id]").dataset.referenceId')
  const posted = await page.evaluate('window.__referenceRequests.filter(request => request.method === "POST")')
  check('real browser file input uploads raw PNG bytes with its media type', posted.length === 1 && posted[0].bodyType === 'File' && posted[0].mediaType === 'image/png'
    && posted[0].fileBytes === readFileSync(uploadFile).length && posted[0].body === undefined, posted)
  check('upload stores a thumbnail without creating a revision', read('project.json').currentRevision === before)
  await page.waitFor('Array.from(document.querySelectorAll("[data-reference-id] img")).every(image => image.complete && image.naturalWidth > 0)')
  check('the uncommitted uploaded reference is served as a real decoded image', true)
  check('unsaved references disable model review', await page.evaluate('document.querySelector("[data-action=project-review]").disabled'))
  await page.click(`[data-field="reference-${referenceId}-geometry"]`)
  await page.click(`[data-field="reference-${referenceId}-lighting"]`)
  const notes = '参考瓶肩圆润曲线与陶瓷托盘的接触关系；灯光保持柔和。'
  const goal = '参考实拍式产品图制作玻璃香氛瓶与陶瓷托盘，保留清晰的玻璃厚度和真实接触关系。'
  await page.fill(`[data-field="reference-${referenceId}-notes"]`, notes)
  await page.fill('[data-field="brief-goal"]', goal)
  await page.evaluate('document.querySelector("[data-brief-project]").scrollIntoView({block:"start"})')
  await page.screenshot(join(directory, '01-uploaded-draft.png'))
  const saved = await page.click('[data-action="brief-save"]')
  check('Save brief is reachable by pointer', saved.via === 'pointer')
  await page.waitFor('document.querySelector("[data-brief-result]")?.textContent.includes("没有启动渲染")', 180000)
  await page.waitFor('document.querySelector("[data-brief-project]")?.dataset.briefDirty === "false"')
  after = read('project.json').currentRevision
  const spec = read('revisions', after, 'scene-spec.json'), manifest = read('revisions', after, 'revision-manifest.json')
  check('saving creates a new checkpointed revision without a preview render', after !== before && existsSync(join(info.root, 'projects', projectId, 'revisions', after, 'scene.blend')) && manifest.previews.length === 0, { after, previews: manifest.previews.length })
  check('the revision contains the goal, purposes, notes and input hash', spec.project.goal === goal && spec.project.referenceImages.length === 1
    && spec.project.referenceImages[0].notes === notes && spec.project.referenceImages[0].purposes.includes('geometry')
    && spec.project.referenceImages[0].purposes.includes('lighting') && spec.project.referenceImages[0].sha256 === sha256(readFileSync(uploadFile)), spec.project.referenceImages)
  const storedAsset = spec.assets.find(asset => asset.id === spec.project.referenceImages[0].assetId)
  check('the stored reference bytes match the real uploaded file', sha256(readFileSync(join(info.root, 'projects', projectId, storedAsset.path))) === sha256(readFileSync(uploadFile)))
  const beforeWrites = await page.evaluate('window.__referenceRequests.filter(request => request.method === "POST")')
  const patch = beforeWrites.find(request => request.url.endsWith('/patch'))?.body?.patch
  check('the UI submits asset.add and complete brief replacement in one pinned transaction', patch.baseRevision === before && patch.saveCheckpoint === true && patch.renderPreview === false
    && JSON.stringify(patch.operations.map(operation => operation.op)) === JSON.stringify(['asset.add', 'project.brief.set']))
  check('original revision spec, checkpoint and manifest remain byte-identical', originalPaths.every(path => sha256(readFileSync(path)) === originals[path]))
  await page.reload()
  await page.waitFor(`document.querySelector('[data-brief-base-revision="${after}"]') !== null`, 45000)
  await page.waitFor('document.querySelector("[data-reference-id] img")?.naturalWidth > 0')
  check('refresh restores the saved goal and annotation from Host', await page.evaluate(`document.querySelector('[data-field="brief-goal"]').value === ${JSON.stringify(goal)} && document.querySelector('[data-field="reference-${referenceId}-notes"]').value === ${JSON.stringify(notes)}`))
  check('the saved purpose checkboxes have correct native DOM state after refresh', await page.evaluate(`document.querySelector('[data-field="reference-${referenceId}-geometry"]').checked && document.querySelector('[data-field="reference-${referenceId}-lighting"]').checked`))
  await page.evaluate('document.querySelector("[data-brief-project]").scrollIntoView({block:"start"})')
  await page.screenshot(join(directory, '02-saved-after-refresh.png'))
  const review = await page.click('[data-action="project-review"]')
  check('explicit review is reachable by pointer', review.via === 'pointer')
  await page.waitFor('document.querySelector("[data-review-error]") !== null', 300000)
  const error = await page.text('[data-review-error]')
  check('unavailable visual reviewer is reported as an error, not a reference pass', typeof error === 'string' && error.length > 10, error)
  await page.waitFor(`document.querySelector('[data-reviewed-reference-id="${referenceId}"]') !== null`, 30000)
  check('QA shows the verified reference ID and a review input digest', await page.evaluate(`document.querySelector('[data-review-inputs-digest]').dataset.reviewInputsDigest.length === 64`))
  check('review failure does not show a success notice', await page.evaluate('document.querySelector("[data-review-result]") === null'))
  await page.evaluate('document.querySelector("[data-visual-actions]").scrollIntoView({block:"start"})')
  await page.screenshot(join(directory, '03-reviewer-unavailable.png'))
  const requests = await page.evaluate('window.__referenceRequests')
  writeFileSync(join(directory, 'requests-after-refresh.json'), JSON.stringify(requests, null, 2))
  const finalManifest = read('revisions', after, 'revision-manifest.json'), record = finalManifest.reviews.at(-1)
  const actualReview = JSON.parse(readFileSync(join(info.root, 'projects', projectId, record.path))).review
  check('the real review retains reference proof and unassessable art status with reviewer error', actualReview.referenceImages[0].id === referenceId
    && actualReview.reviewInputsDigest.length === 64 && actualReview.artistic.status === 'unassessable'
    && actualReview.reviewer.error?.code === 'VISUAL_REVIEW_MODEL_UNAVAILABLE',
    { score: actualReview.score, artistic: actualReview.artistic.status, reviewerError: actualReview.reviewer.error.code })
  check('reviewing does not change the current revision', read('project.json').currentRevision === after)
  check('the old revision remains byte-identical after review', originalPaths.every(path => sha256(readFileSync(path)) === originals[path]))
  copyFileSync(join(info.root, 'projects', projectId, record.path), join(directory, 'actual-review.json'))
  outcome = 'passed'
} catch (error) {
  outcome = 'failed'; results.push({ name: 'unexpected failure', ok: false, detail: error.stack || String(error) }); console.error(error)
  if (page) await page.screenshot(join(directory, 'failure.png')).catch(() => {})
} finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) {
      outcome = 'failed'; results.push({ name: `${name} shutdown`, ok: false, detail: String(error) })
    }
  }
  const report = { startedAt, completedAt: new Date().toISOString(), outcome, url: info?.url, root: info?.root, directory,
    projectId, before, after, referenceId, input: { path: uploadFile, sha256: sha256(readFileSync(uploadFile)) }, originals,
    fixture: infoPath ? { mode: 'existing-server', infoPath } : { mode: 'isolated-recipe', shutdown },
    results, passed: results.filter(result => result.ok).length, total: results.length,
    scope: 'Real file upload, persisted brief, immutable historical revision, rendered preview review with unavailable model. No visual improvement or human approval claim.' }
  writeFileSync(join(directory, 'results.json'), JSON.stringify(report, null, 2))
  console.log(`Reference-image UI: ${report.passed}/${report.total}; ${directory}`)
}
if (outcome !== 'passed') process.exitCode = 1
