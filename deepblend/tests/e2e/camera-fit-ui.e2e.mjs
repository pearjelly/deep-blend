/** One real native save, browser response loss/refresh/replay, and saved geometry evidence. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', 'camera-fit-ui-' + Date.now()))
if (existsSync(output)) throw Error('Preserve existing camera fit evidence: ' + output)
mkdirSync(output, { recursive: true })
const review = process.env.DEEPBLEND_UI_REVIEW_DIR ? resolve(process.env.DEEPBLEND_UI_REVIEW_DIR) : null
if (review) mkdirSync(review, { recursive: true })
const storeRoot = join(output, 'store'), id = 'complete-view-ui', checks = [], preparations = [], protectedFiles = {}
const startedAt = new Date().toISOString(), blender = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const json = (name, value) => { const path = join(output, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); return path }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
const file = (...parts) => join(storeRoot, 'projects', id, ...parts)
const read = (...parts) => JSON.parse(readFileSync(file(...parts)))
function protect(revision) {
  for (const name of ['scene.blend', 'scene-spec.json', 'revision-manifest.json', 'recipe-lock.json', 'recipe-parameters.json']) {
    const path = file('revisions', revision, name); if (existsSync(path)) protectedFiles[path] = hash(path)
  }
}
let server, browser, page, failure, shutdown
try {
  const rows = JSON.parse(await storePatch(storeRoot))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  async function post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const payload = await response.json(); preparations.push({ path, body, ok: payload.ok }); json('preparation.json', preparations)
    if (!response.ok || !payload.ok) throw Error(payload.error?.message || 'Fixture route failed')
    return payload
  }
  const list = await fetch(base + '/deepblend/recipes').then(response => response.json())
  const recipe = list.recipes.find(recipe => recipe.id === 'deepblend.metal-lamp')
  check('actual candidate Host serves lamp2.2', recipe?.version === '2.2.0')
  await post('/deepblend/projects', { projectId: id, title: '完整取景 · 已摆放台灯', recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest }, renderPreview: false })
  protect('r0001')
  await post(`/deepblend/projects/${id}/patch`, { baseRevision: 'r0001', saveCheckpoint: true, renderPreview: false, operations: [
    { op: 'entity.add', entity: { id: 'fit-support', type: 'generator', generator: { shape: 'cube', size: 1 }, materialId: 'dark-bronze', transform: { location: [0, 0, .04], scale: [4, 4, .08] } } },
    { op: 'entity.add', entity: { id: 'unrelated-marker', type: 'generator', generator: { shape: 'cube', size: .03 }, materialId: 'dark-bronze', transform: { location: [-1, 0, .2] } } },
  ] })
  protect('r0002')
  await post(`/deepblend/projects/${id}/surface-placement`, { baseRevision: 'r0002', scope: 'recipe-assembly', subjectEntityId: 'weighted-base', supportEntityId: 'fit-support',
    frame: 24, clearanceMm: 1.5, pose: { translationMm: [1000, 200, 150], yawDegrees: 35 }, renderPreview: true, idempotencyKey: 'ui-fit-placement' })
  protect('r0003'); const before = read('revisions/r0003/scene-spec.json')
  check('the ordinary source retains all4 hero animation tracks', before.animationTracks.filter(track => track.targetKind === 'camera').length === 4)
  const state = await fetch(base + `/deepblend/state?projectId=${id}`).then(response => response.json())
  const ids = state.selected.recipeParameters.placement.memberEntityIds.slice().sort()
  check('the actual UI capability and complete23 scope are served', state.cameraFitSupported === true && ids.length === 23)

  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await page.addInitScript(`window.__fitWrites=JSON.parse(sessionStorage.getItem('deepblend-fit-writes')||'[]');const original=window.fetch;
    window.fetch=async(input,init)=>{const fit=init?.method==='POST'&&String(input).endsWith('/camera-fit');if(fit){window.__fitWrites.push({url:String(input),body:JSON.parse(init.body)});sessionStorage.setItem('deepblend-fit-writes',JSON.stringify(window.__fitWrites))}
    const response=await original(input,init);if(fit&&!sessionStorage.getItem('deepblend-fit-reply-dropped')){await response.clone().json();sessionStorage.setItem('deepblend-fit-reply-dropped','1');throw Error('Explicit acceptance fixture: reply lost after Host completed')};return response}`)
  await page.goto(base + '/deepblend/workbench')
  await page.waitFor(`document.querySelector('[data-lighttable-revision="r0003"]')!==null`, 60000)
  await page.click('[data-view-tab="scene"]'); await clickWorkbenchControl(page, '[data-field="fit-frame"]')
  check('the actual form defaults to all23 parts and no external supports', await page.evaluate(`(() => {const checked=Array.from(document.querySelectorAll('[data-field="fit-part"]')).filter(n=>n.checked).map(n=>n.getAttribute('data-entity-id')).sort();return JSON.stringify(checked)===${JSON.stringify(JSON.stringify(ids))}})()`))
  await page.fill('[data-field="fit-frame"]', '24')
  check('editing sends no write and enables exactly the explicit save', await page.evaluate(`window.__fitWrites.length===0&&!document.querySelector('[data-action="fit-save"]').disabled`))
  // One batched desktop/mobile inspection includes the ready form and saved result.
  for (const [name, width, height, mobile] of [['desktop',1440,1000,false],['mobile',390,844,true]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    await page.evaluate(`(() => {document.activeElement?.blur();document.querySelector('[data-camera-fit-editor]').scrollIntoView({block:'start',behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
    check(name + ' complete-view controls fit the available width', await page.evaluate(`(() => {const r=document.querySelector('[data-camera-fit-editor]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&!document.querySelector('[data-action="fit-save"]').disabled})()`))
    await page.screenshot(join(output, name + '-form.png'))
    if (review) copyFileSync(join(output, name + '-form.png'), join(review, name + '.png'))
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  check('one pointer submits the captured complete view', (await clickWorkbenchControl(page, '[data-action="fit-save"]')).via === 'pointer')
  await page.waitFor(`sessionStorage.getItem('deepblend-fit-reply-dropped')==='1'&&document.querySelector('[data-camera-fit-error]')!==null`, 240000)
  const capture = await page.evaluate('window.__fitWrites[0]')
  check('actual Host committed r4 before the intentionally lost response', read('project.json').currentRevision === 'r0004')
  check('uncertain intent is frozen and exposes exact retry', await page.evaluate(`document.querySelector('[data-field="fit-frame"]').disabled&&!document.querySelector('[data-action="fit-save"]').disabled`))
  await page.reload(); await page.waitFor(`document.querySelector('[data-lighttable-revision="r0004"]')!==null`, 60000)
  await page.click('[data-view-tab="scene"]'); await page.waitFor(`document.querySelector('[data-camera-fit-editor]')!==null`, 30000)
  await clickWorkbenchControl(page, '[data-field="fit-frame"]')
  check('page refresh sends no write and restores the same immutable request', await page.evaluate(`window.__fitWrites.length===1&&document.querySelector('[data-field="fit-frame"]').disabled&&!document.querySelector('[data-action="fit-save"]').disabled`))
  await clickWorkbenchControl(page, '[data-action="fit-save"]')
  await page.waitFor(`document.querySelector('[data-result-kind="camera-fit"]')!==null&&document.querySelector('[data-compare="current"] img')?.naturalWidth>0`, 60000)
  const writes = await page.evaluate('window.__fitWrites'); json('browser-writes.json', writes)
  check('the retry is byte-equivalent logical intent and creates only one new revision', writes.length === 2 && isDeepStrictEqual(writes[0], writes[1])
    && read('project.json').currentRevision === 'r0004' && read('project.json').revisionCount === 4)
  const after = read('revisions/r0004/scene-spec.json'), receipt = read('revisions/r0004/revision-manifest.json').cameraFitReceipt
  check('saved spec adds only the new static camera, preserving original array order and animation', isDeepStrictEqual(before, { ...after, cameras: after.cameras.filter(camera => camera.id !== capture.body.fittedCameraId) }))
  check('saved receipt pins source/candidate and independent complete23 margin+clip proofs', receipt.sourceRevision === 'r0003' && receipt.frame === 24
    && receipt.fittedCameraId === capture.body.fittedCameraId && receipt.members.length === 23 && receipt.members.every(member => member.projection.containedInFrame && member.projection.containedInClip)
    && receipt.sourceCheckpointSha256 === hash(file('revisions/r0003/scene.blend')) && receipt.resultCheckpointSha256 === hash(file('revisions/r0004/scene.blend')))
  check('the shown saved image belongs to the new fitted camera and revision', await page.evaluate(`(() => {const n=document.querySelector('[data-compare="current"] img');return n.getAttribute('data-artifact-revision')==='r0004'&&n.naturalWidth>0})()`))
  for (const [name, width, height, mobile] of [['desktop',1440,1000,false],['mobile',390,844,true]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    await page.evaluate(`(() => {document.activeElement?.blur();document.querySelector('.db-body')?.scrollTo({top:0,behavior:'instant'});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`)
    await page.screenshot(join(output, name + '-result.png'))
    if (review) copyFileSync(join(output, name + '-result.png'), join(review, name + '-result.png'))
  }
  const probeInput = json('reopen-request.json', { entityIds: ids, assetInstanceIds: [], frame: 24, cameraId: 'hero', fittedCameraId: receipt.fittedCameraId,
    margin: .03, checkpointSha256: receipt.resultCheckpointSha256, baselineCheckpointPath: file('revisions/r0003/scene.blend'), baselineCheckpointSha256: receipt.sourceCheckpointSha256 })
  const probeOutput = join(output, 'reopened-saved-report.json'), probe = join(output, 'reopen.py')
  writeFileSync(probe, `import sys,json\nsys.path.insert(0,${JSON.stringify(join(REPO_ROOT,'packages/deepblend/provider-local/python'))})\nfrom deepblend_product_framing import inspect_camera_fit\npayload=json.load(open(${JSON.stringify(probeInput)}))\nreport,_,_=inspect_camera_fit({'payload':payload},{'blend':${JSON.stringify(file('revisions/r0004/scene.blend'))}})\njson.dump(report,open(${JSON.stringify(probeOutput)},'w'),indent=2)\n`)
  const reopened = spawnSync(blender, ['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',probe], { encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024 })
  writeFileSync(join(output,'reopen.log'), (reopened.stdout || '') + (reopened.stderr || ''))
  check('a separate Blender process reopens and independently verifies the saved candidate', reopened.status === 0, { status: reopened.status, error: reopened.error?.message })
  const report = JSON.parse(readFileSync(probeOutput))
  check('saved native recheck contains every member and preserves the pinned geometry and photography', report.members.length === 23
    && report.members.every(member => member.projection.containedInFrame && member.projection.containedInClip)
    && report.baselineVerification.selectedGeometryUnchanged && report.baselineVerification.originalObjectsUnchanged && report.baselineVerification.opticsAndRotationPreserved)
  check('all protected prior revision files remain byte-exact', Object.entries(protectedFiles).every(([path, expected]) => hash(path) === expected))
  json('protected-history.json', protectedFiles); json('saved-receipt.json', receipt)
} catch (error) { failure = { message: error.message, code: error.code, stack: error.stack }; json('failure.json', failure); console.error(error) }
finally {
  if (page) json('browser-console.json', page.consoleLog)
  try { if (browser) await browser.close() } catch (error) { failure ??= { message: error.message } }
  try { if (server) shutdown = await server.stop() } catch (error) { failure ??= { message: error.message } }
  json('summary.json', { status: failure ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), checks, failure, shutdown,
    scope: 'Actual candidate UI/Host/native complete23 animated lamp; one static fitted camera with response-loss refresh/replay. No model, broad regression, CI or release claim.' })
  process.exitCode = failure ? 1 : 0
}
