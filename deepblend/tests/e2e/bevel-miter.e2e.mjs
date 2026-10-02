#!/usr/bin/env node
/** Real modifier editor save/refresh using a curved bore and public SceneSpec.
 * Two equal-cost transaction previews; no model calls or artistic-pass claim.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const directory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `bevel-miter-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`))
const root = join(directory, 'store'), projectId = 'curved-bore', results = [], startedAt = new Date().toISOString()
mkdirSync(directory, { recursive: true })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const path = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(path(...parts)))
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok) throw new Error(name)
}
// Share the documented public fixture with provider regression. The only baseline
// change is omitting the optional field, which must retain the historical ARC default.
const sceneSpec = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/fixtures/curved-bore/scene-spec.json')))
delete sceneSpec.entities.find(entity => entity.id === 'body').modifiers[1].miterInner
const field = '[data-field="editor-modifier-1-miterInner"]'
let server, browser, page, url, shutdown, originals = {}, outcome = 'failed'
try {
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
  if (!existsSync(blenderPath)) throw new Error(`Blender not found at ${blenderPath}; set DEEPBLEND_BLENDER_PATH.`)
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = sceneSpec.renderProfiles.preview.samples
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`; url = `${base}/deepblend/workbench`
  const created = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, title: sceneSpec.project.title, sceneSpec, renderPreview: true }), signal: AbortSignal.timeout(180000) })
  if (!created.ok) throw new Error(`Fixture creation ${created.status}: ${await created.text()}`)
  const beforeSpec = read('revisions', 'r0001', 'scene-spec.json'), before = read('revisions', 'r0001', 'revision-manifest.json').previews.at(-1)
  originals = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend', before.path].map(file => [file, sha256(readFileSync(path(file)))]))
  copyFileSync(path(before.path), join(directory, 'before-arc.png'))
  check('the baseline is a real preview with miterInner still omitted', before.kind === 'preview' && !Object.hasOwn(beforeSpec.entities.find(entity => entity.id === 'body').modifiers[1], 'miterInner'))
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] }); page = await browser.newPage()
  await page.addInitScript(`window.__bevelWrites=[];const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method==='POST')window.__bevelWrites.push({url:String(input),body:JSON.parse(init.body)});return originalFetch(input,init)}`)
  await page.goto(url); await page.waitFor('document.querySelector(\'[data-brief-base-revision="r0001"]\')!==null', 45000)
  await page.click('[data-view-tab="scene"]'); await page.waitFor('document.querySelector(\'[data-action="select-entity:body"]\')!==null', 30000)
  await page.click('[data-action="select-entity:body"]'); await page.waitFor(`document.querySelector(${JSON.stringify(field)})!==null`, 30000)
  check('the native control displays arc while the complete stack draft is clean', await page.evaluate(`document.querySelector(${JSON.stringify(field)}).value==='arc' && document.querySelector('[data-editor-entity="body"]').dataset.editorDirty==='false' && document.querySelector('[data-action="editor-apply"]').disabled`))
  check('the generator bevel has no inner-corner control', await page.evaluate('document.querySelector("[data-field=editor-generator-bevel-miterInner]")===null'))
  await page.evaluate(`document.querySelector(${JSON.stringify(field)}).scrollIntoView({block:'center'})`); await page.screenshot(join(directory, '01-default-arc.png'))
  await page.evaluate(`(() => {const select=document.querySelector(${JSON.stringify(field)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'sharp');select.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  check('choosing sharp changes a draft without an automatic request', await page.evaluate(`document.querySelector(${JSON.stringify(field)}).value==='sharp' && document.querySelector('[data-editor-entity="body"]').dataset.editorDirty==='true' && window.__bevelWrites.length===0`))
  const click = await page.click('[data-action="editor-apply"]'); check('Apply and preview is reached through a real pointer', click.via === 'pointer')
  await page.waitFor('document.querySelector(\'[data-compare="right"] img[data-artifact-revision="r0002"]\')!==null', 180000)
  const afterSpec = read('revisions', 'r0002', 'scene-spec.json'), after = read('revisions', 'r0002', 'revision-manifest.json').previews.at(-1)
  const writes = await page.evaluate('window.__bevelWrites')
  writeFileSync(join(directory, 'requests.json'), JSON.stringify(writes, null, 2))
  check('the editor submits one pinned checkpoint transaction with a preview', writes.length === 1 && writes[0].url.endsWith('/patch')
    && writes[0].body.patch.baseRevision === 'r0001' && writes[0].body.patch.saveCheckpoint === true && writes[0].body.patch.renderPreview === true)
  const operations = writes[0].body.patch.operations
  const expectedStack = JSON.parse(JSON.stringify(beforeSpec.entities.find(entity => entity.id === 'body').modifiers))
  expectedStack[1].miterInner = 'sharp'
  check('only the intended stack field changes and operation ordering remains intact', operations.length === 1 && operations[0].op === 'entity.modifiers.set'
    && isDeepStrictEqual(operations[0].modifiers, expectedStack), operations)
  const cleared = JSON.parse(JSON.stringify(afterSpec)); delete cleared.entities.find(entity => entity.id === 'body').modifiers[1].miterInner
  check('generator bevel, geometry, transforms, materials, cameras and lights are otherwise identical', JSON.stringify(cleared) === JSON.stringify(beforeSpec))
  check('both previews have equal measured camera, frame and render configuration', ['cameraId', 'frame', 'width', 'height', 'samples', 'engine'].every(key => before[key] === after[key])
    && before.renderConfig && JSON.stringify(before.renderConfig) === JSON.stringify(after.renderConfig) && before.width === 480 && before.height === 360 && before.samples === 32,
    { before: { cameraId: before.cameraId, frame: before.frame, width: before.width, height: before.height, samples: before.samples }, after: { cameraId: after.cameraId, frame: after.frame, width: after.width, height: after.height, samples: after.samples } })
  copyFileSync(path(after.path), join(directory, 'after-sharp.png'))
  const a = decodePng(readFileSync(path(before.path))), b = decodePng(readFileSync(path(after.path)))
  let changedPixels = 0
  for (let index = 0; index < a.data.length; index += 4) if ([0, 1, 2].some(channel => a.data[index + channel] !== b.data[index + channel])) changedPixels += 1
  check('the public modifier change reaches actual rendered pixels', changedPixels > 0, { changedPixels, beforePixels: sha256(a.data), afterPixels: sha256(b.data) })
  await page.reload(); await page.waitFor('document.querySelector(\'[data-brief-base-revision="r0002"]\')!==null', 45000)
  await page.click('[data-view-tab="scene"]'); await page.waitFor('document.querySelector(\'[data-action="select-entity:body"]\')!==null', 30000)
  await page.click('[data-action="select-entity:body"]'); await page.waitFor(`document.querySelector(${JSON.stringify(field)})!==null`, 30000)
  check('refresh restores the saved sharp selection as a clean native control', await page.evaluate(`document.querySelector(${JSON.stringify(field)}).value==='sharp' && document.querySelector('[data-editor-entity="body"]').dataset.editorDirty==='false'`))
  await page.evaluate(`document.querySelector(${JSON.stringify(field)}).scrollIntoView({block:'center'})`); await page.screenshot(join(directory, '02-saved-sharp.png'))
  check('the original SceneSpec, checkpoint and preview remain byte-identical', Object.entries(originals).every(([file, digest]) => sha256(readFileSync(path(file))) === digest))
  check('the revision contains no model review or hidden review request', (read('revisions', 'r0002', 'revision-manifest.json').reviews || []).length === 0
    && writes.every(request => !/\/(review|autofix)$/.test(request.url)))
  outcome = 'passed'
} catch (error) {
  console.error(error); results.push({ name: 'unexpected failure', ok: false, detail: error.stack || String(error) })
  if (page) await page.screenshot(join(directory, 'failure.png')).catch(() => {})
} finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { outcome = 'failed'; results.push({ name: `${name} shutdown`, ok: false, detail: String(error) }) }
  }
  const report = { startedAt, completedAt: new Date().toISOString(), outcome, url, directory, root, projectId, originals, shutdown,
    results, passed: results.filter(result => result.ok).length, total: results.length,
    scope: 'Real public SceneSpec, native modifier editor, saved revision and equal-setting PNG change. No online model calls and no claim of universal blending or artistic approval.' }
  writeFileSync(join(directory, 'results.json'), JSON.stringify(report, null, 2))
  console.log(`Bevel miter UI: ${report.passed}/${report.total}; ${directory}`)
}
if (outcome !== 'passed') process.exitCode = 1
