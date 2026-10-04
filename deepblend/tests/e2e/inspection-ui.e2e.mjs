#!/usr/bin/env node
/** Real fixed-view inspection UI. Generates isolated beauty/clay artifacts from a
 * public recipe and verifies they never replace the saved scene/product preview.
 * No model calls. No quality-pass claim. All outputs live in a fresh directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
const directory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `inspection-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(directory)) throw new Error(`Evidence directory already exists: ${directory}`)
mkdirSync(directory, { recursive: true })
const root = join(directory, 'store'), projectId = 'inspection-ui', results = [], startedAt = new Date().toISOString()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const path = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(path(...parts)))
const json = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) { results.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); if (!ok) throw new Error(name) }
const sceneSpec = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/recipes/glass-ceramic/scene-spec.json')))
sceneSpec.project.id = projectId; sceneSpec.project.title = 'Fixed-view inspections'
sceneSpec.renderProfiles.preview = { ...sceneSpec.renderProfiles.preview, resolution: [256, 192], samples: 8, maxSamplesBudget: 8 }
const field = name => `[data-field="inspection-${name}"]`
let server, browser, page, base, url, shutdown, outcome = 'failed', originals = {}, artifacts = []
async function select(name, value) { await page.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(field(name))});if(!el)throw Error('missing inspection field');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`) }
async function previewList() { const response = await fetch(`${base}/deepblend/projects/${projectId}/previews`); if (!response.ok) throw Error(await response.text()); return (await response.json()).previews }
async function inspect(mode, cameraId, frame) {
  await select('mode', mode); await select('cameraId', cameraId); await page.fill(field('frame'), String(frame)); await page.fill(field('samples'), '8')
  const count = artifacts.length, clicked = await page.click('[data-action="inspection-render"]')
  await page.waitFor(`document.querySelectorAll('[data-inspection-artifact]').length===${count + 1} && !document.querySelector('[data-action="inspection-cancel"]')`, 180000)
  const current = (await previewList()).revisions.find(revision => revision.revision === 'r0001'), added = current.diagnostics.filter(item => !artifacts.some(existing => existing.path === item.path))
  if (added.length !== 1) throw Error(`Expected one newly published diagnostic; found ${added.length}`)
  const artifact = added[0]
  check(`${mode} ${cameraId}@${frame}: actual artifact identity matches the selected source`, clicked.via === 'pointer' && artifact.kind === 'diagnostic' && artifact.mode === mode && artifact.sourceRevision === 'r0001' && artifact.cameraId === cameraId && artifact.frame === frame && artifact.sha256 === sha(readFileSync(path(artifact.path))), artifact)
  await page.waitFor(`Array.from(document.querySelectorAll('[data-inspection-image]')).every(image=>image.complete&&image.naturalWidth>0)`, 30000)
  copyFileSync(path(artifact.path), join(directory, `${mode}-${cameraId}-${frame}.png`)); artifacts.push(artifact)
  check(`${mode} inspection does not move the project revision`, read('project.json').currentRevision === 'r0001')
  return artifact
}
try {
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  if (!existsSync(blenderPath)) throw new Error(`Set DEEPBLEND_BLENDER_PATH; Blender not found at ${blenderPath}`)
  const rows = JSON.parse(await storePatch(root)); rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false }); base = `http://127.0.0.1:${server.port}`; url = `${base}/deepblend/workbench`
  json('server-info.json', { root, url, port: server.port })
  const created = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, title: sceneSpec.project.title, sceneSpec, renderPreview: true }), signal: AbortSignal.timeout(180000) })
  if (!created.ok) throw new Error(`Fixture creation ${created.status}: ${await created.text()}`)
  const before = (await previewList()).revisions.find(revision => revision.revision === 'r0001'), product = before.previews.at(-1)
  originals = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend', product.path].map(file => [file, sha(readFileSync(path(file)))]))
  copyFileSync(path(product.path), join(directory, 'original-product-preview.png')); json('original-previews.json', before)
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] }); page = await browser.newPage()
  await page.addInitScript(`window.__inspectionRequests=[];const original=window.fetch;window.fetch=(input,init)=>{let body;try{body=typeof init?.body==='string'?JSON.parse(init.body):undefined}catch{};window.__inspectionRequests.push({url:String(input),method:init?.method||'GET',body});return original(input,init)}`)
  await page.goto(url); await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null', 45000)
  await page.click('[data-action="guide-form"]'); await page.waitFor('document.querySelector("[data-inspection-panel]")!==null')
  check('the creation guide opens clay controls with correct native selection and no write', await page.evaluate('document.querySelector("[data-field=inspection-mode]").value==="clay" && window.__inspectionRequests.every(request=>request.method!=="POST")'))
  check('the guide and gray-mode note do not claim quality approval', (await page.text('[data-creation-guide]')).includes('不会自动提交') && (await page.text('[data-inspection-panel]')).includes('不证明壁厚'))
  const beauty = await inspect('beauty', 'hero', 24), clay = await inspect('clay', 'hero', 24)
  check('beauty and clay carry the same measured camera, frame and render settings', beauty.frame === clay.frame && beauty.cameraId === clay.cameraId && isDeepStrictEqual(beauty.cameraFacts, clay.cameraFacts) && isDeepStrictEqual(beauty.renderConfig, clay.renderConfig), { beauty: beauty.renderConfig, clay: clay.renderConfig })
  const a = decodePng(readFileSync(path(beauty.path))), b = decodePng(readFileSync(path(clay.path))); let changedPixels = 0
  for (let index = 0; index < a.data.length; index += 4) if ([0, 1, 2].some(channel => a.data[index + channel] !== b.data[index + channel])) changedPixels++
  check('neutral clay changes actual pixels while keeping dimensions', a.width === b.width && a.height === b.height && changedPixels > 0, { changedPixels })
  await inspect('clay', 'detail', 48)
  const after = (await previewList()).revisions.find(revision => revision.revision === 'r0001')
  check('inspection adds only diagnostic artifacts and preserves ordinary previews/contact sheets', after.diagnostics.length === 3 && isDeepStrictEqual(after.previews, before.previews) && isDeepStrictEqual(after.contactSheets, before.contactSheets))
  check('the latest product image still points to the original beauty preview', await page.evaluate(`document.querySelector('[data-compare="current"] img')?.dataset.artifact===${JSON.stringify(product.path)}`))
  check('saved SceneSpec, source checkpoint and original product PNG remain byte-identical', Object.entries(originals).every(([file, hash]) => sha(readFileSync(path(file))) === hash))
  await page.evaluate('document.querySelector("[data-inspection-artifact]").scrollIntoView({block:"start"})'); await page.screenshot(join(directory, '01-independent-inspections.png'))
  json('requests-before-refresh.json', await page.evaluate('window.__inspectionRequests'))
  await page.reload(); await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null', 45000); await page.click('[data-view-tab="preview"]'); await page.waitFor('document.querySelectorAll("[data-inspection-artifact]").length===3 && Array.from(document.querySelectorAll("[data-inspection-image]")).every(image=>image.naturalWidth>0)', 30000)
  check('refresh restores all actual diagnostic artifacts without a new render', await page.evaluate('window.__inspectionRequests.every(request=>request.method!=="POST")'))
  await page.click('[data-action="guide-goal"]'); await page.fill('[data-field="brief-goal"]', 'Unsaved inspection guard')
  await page.click('[data-action="guide-form"]')
  check('unsaved goal blocks inspection instead of silently ignoring the draft', await page.evaluate('document.querySelector("[data-action=inspection-render]").disabled'))
  await page.click('[data-action="guide-goal"]'); await page.click('[data-action="brief-reset"]'); await page.click('[data-action="guide-detail"]')
  await select('cameraId', 'detail'); await page.fill(field('frame'), '48')
  check('the details guide keeps the chosen camera/frame and leaves execution explicit', await page.evaluate('document.querySelector("[data-field=inspection-mode]").value==="beauty" && document.querySelector("[data-field=inspection-cameraId]").value==="detail" && document.querySelector("[data-field=inspection-frame]").value==="48"'))
  const peer = await fetch(`${base}/deepblend/projects/${projectId}/patch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { projectId, baseRevision: 'r0001', saveCheckpoint: true, renderPreview: false, operations: [{ op: 'project.brief.set', goal: 'An explicit newer goal.', referenceImages: [] }] } }), signal: AbortSignal.timeout(180000) })
  if (!peer.ok) throw Error(await peer.text())
  await page.waitFor('document.querySelector("[data-inspection-panel]").dataset.inspectionSourceRevision==="r0002"', 30000)
  check('a newer revision does not overwrite inspection camera/frame inputs', await page.evaluate('document.querySelector("[data-field=inspection-cameraId]").value==="detail" && document.querySelector("[data-field=inspection-frame]").value==="48"'))
  await select('revision', 'r0001'); check('old inspection images keep their historical revision labels', await page.evaluate('Array.from(document.querySelectorAll("[data-inspection-artifact]")).every(card=>card.dataset.inspectionRevision==="r0001")') && (await page.text('[data-inspection-panel]')).includes('历史版本 r0001'))
  await select('mode', 'clay'); await page.click('[data-action="inspection-render"]'); await page.waitFor('document.querySelector("[data-action=inspection-cancel]")!==null'); await page.click('[data-action="inspection-cancel"]')
  await page.waitFor('document.querySelector("[data-inspection-error]")?.textContent.includes("取消")', 30000)
  check('browser cancellation remains an error result and creates no new diagnostic publication', (await previewList()).revisions.find(revision => revision.revision === 'r0002').diagnostics.length === 0 && await page.evaluate('document.querySelector("[data-inspection-result]")===null'))
  await page.evaluate('document.querySelector("[data-inspection-panel]").scrollIntoView({block:"start"})'); await page.screenshot(join(directory, '02-history-and-cancel.png'))
  check('the original saved scene/checkpoint/preview still remain unchanged after history and cancellation', Object.entries(originals).every(([file, hash]) => sha(readFileSync(path(file))) === hash))
  const requests = [...JSON.parse(readFileSync(join(directory, 'requests-before-refresh.json'))), ...await page.evaluate('window.__inspectionRequests')]
  check('all inspection writes pin revision/mode/camera/frame, without patches, final renders or model calls', requests.filter(request => request.method === 'POST').every(request => request.url.endsWith('/preview') && request.body.revision && ['beauty', 'clay'].includes(request.body.mode) && request.body.views.length === 1 && Number.isInteger(request.body.views[0].frame)))
  json('requests.json', requests); json('artifacts.json', artifacts); outcome = 'passed'
} catch (error) { console.error(error); results.push({ name: 'unexpected failure', ok: false, detail: error.stack || String(error) }); if (page) await page.screenshot(join(directory, 'failure.png')).catch(() => {}) }
finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { outcome = 'failed'; results.push({ name: `${name} shutdown`, ok: false, detail: String(error) }) }
  }
  const report = { startedAt, completedAt: new Date().toISOString(), outcome, directory, root, url, projectId, shutdown, originals, artifacts, results, passed: results.filter(result => result.ok).length, total: results.length,
    scope: 'Real browser and isolated inspection render evidence; no online model calls, no aesthetic approval, no claim that clay proves thickness or manifold geometry. Cancellation covers browser/HTTP behavior; provider process cleanup has separate integration coverage.' }
  json('results.json', report); console.log(`Inspection UI: ${report.passed}/${report.total}; ${directory}`)
}
if (outcome !== 'passed') process.exitCode = 1
