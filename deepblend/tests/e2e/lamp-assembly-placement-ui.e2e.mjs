/** Real workbench placement/continuation through browser controls and public Host routes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', 'assembly-placement-ui-' + Date.now()))
if (existsSync(output)) throw Error('Preserve existing UI evidence: ' + output)
mkdirSync(output, { recursive: true })
const storeRoot = join(output, 'store'), id = 'lamp-assembly-ui', checks = [], preparations = [], startedAt = new Date().toISOString()
const blender = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const json = (name, value) => { const path = join(output, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); return path }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
const file = (projectId, ...parts) => join(storeRoot, 'projects', projectId, ...parts)
const read = (projectId, ...parts) => JSON.parse(readFileSync(file(projectId, ...parts)))
let server, browser, page, failure, shutdown
const protectedFiles = {}, freeze = (projectId, revision) => {
  for (const name of ['scene.blend', 'scene-spec.json', 'recipe-lock.json', 'recipe-parameters.json']) {
    const path = file(projectId, 'revisions', revision, name); if (existsSync(path)) protectedFiles[path] = hash(path)
  }
}
function native(label, requests) {
  const input = json(label + '-requests.json', requests), resultPath = join(output, label + '.json')
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python',
    join(REPO_ROOT, 'deepblend/tests/lib/inspect-assembly-placement.py'), '--', input, resultPath], { timeout: 180000, encoding: 'utf8', maxBuffer: 16*1024*1024 })
  writeFileSync(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  check(label + ' independent Blender reopening exited0', result.status === 0, { status: result.status, error: result.error?.message })
  return JSON.parse(readFileSync(resultPath)).records
}
async function select(field, value) {
  await page.evaluate(`(() => { const node=document.querySelector(${JSON.stringify(`[data-field="${field}"]`)}); if(!node)throw Error('Missing select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); })()`)
}
const planned = (() => { const a=35*Math.PI/180,c=Math.cos(a),s=Math.sin(a),x=.08,y=-.03
  return [[c,-s,0,x-c*x+s*y+.2],[s,c,0,y-s*x-c*y-.1],[0,0,1,.15],[0,0,0,1]] })()
try {
  const rows = JSON.parse(await storePatch(storeRoot))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  async function post(path, body) {
    const start = Date.now(), response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const payload = await response.json(); preparations.push({ path, body, durationMs: Date.now()-start, ok: payload.ok }); json('fixture-preparation.json', preparations)
    if (!response.ok || !payload.ok) throw Error(payload.error?.message || 'Fixture route failed')
    return payload
  }
  const list = await fetch(base + '/deepblend/recipes').then(response => response.json())
  const recipe = list.recipes.find(recipe => recipe.id === 'deepblend.metal-lamp')
  check('actual Host serves the current2.2 lamp recipe', recipe?.version === '2.2.0')
  async function prepare(projectId, diameter, preview) {
    await post('/deepblend/projects', { projectId, title: projectId, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest,
      ...(diameter ? { parameters: { 'shade-diameter-mm': diameter } } : {}) }, renderPreview: false })
    freeze(projectId, 'r0001')
    const spec = read(projectId, 'revisions/r0001/scene-spec.json')
    await post(`/deepblend/projects/${projectId}/patch`, { baseRevision: 'r0001', saveCheckpoint: true, renderPreview: preview,
      operations: [
        { op: 'material.parameter.update', materialId: 'champagne-spun', parameter: 'roughness', value: .517 },
        ...spec.animationTracks.filter(track => track.targetKind === 'camera').map(track => ({ op: 'animation.track.remove', trackId: track.id })),
        { op: 'camera.update', cameraId: 'hero', lens: 42 },
        { op: 'entity.add', entity: { id: 'task-ramp', type: 'generator', generator: { shape: 'plane', size: 4 }, materialId: 'dark-bronze',
          transform: { location: [0, 0, .08], rotationEuler: [0, -Math.atan(.08), 0] } } },
        { op: 'entity.add', entity: { id: 'unrelated-marker', type: 'generator', generator: { shape: 'cube', size: .03 }, materialId: 'dark-bronze', transform: { location: [-1, 0, .2] } } },
      ] })
    freeze(projectId, 'r0002')
  }
  await prepare('ui-reference250', 250, false); await prepare('ui-reference230', 230, false); await prepare(id, null, true)
  const source = read(id, 'revisions/r0002/scene-spec.json'), ids = source.entities.filter(entity => !['studio-floor', 'task-ramp', 'unrelated-marker'].includes(entity.id)).map(entity => entity.id).sort()
  const sourceInspection = { label: 'source', checkpoint: file(id, 'revisions/r0002/scene.blend'), ids, frame: 24, plane: [.08, .08] }
  const initial = native('independent-before-task', [{ ...sourceInspection, poseForGapMatrix: planned }])[0]
  const expected = structuredClone(planned); expected[2][3] += .0015-initial.plannedMinimumGapM
  json('independent-expected-transform-before-task.json', { sourceCheckpointSha256: hash(sourceInspection.checkpoint), planned, expected, clearanceMm: 1.5 })
  json('own-package-resolution.json', Object.fromEntries(['contracts', 'host', 'provider-local', 'tool', 'preset', 'ui', 'bundle'].map(name => [name,
    realpathSync(join(server.home, 'profiles/node_modules/@deepblend', `dsh-blender-${name}`))])))
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await page.addInitScript(`window.__placementWrites=JSON.parse(sessionStorage.getItem('deepblend-placement-writes')||'[]');const original=window.fetch;
    window.fetch=(input,init)=>{if(init?.method==='POST'){window.__placementWrites.push({url:String(input),body:JSON.parse(init.body)});sessionStorage.setItem('deepblend-placement-writes',JSON.stringify(window.__placementWrites))}return original(input,init)}`)
  await page.goto(base + '/deepblend/workbench')
  await page.waitFor(`document.querySelector('[data-field="lighttable-project"]')!==null`, 60000)
  await select('lighttable-project', id)
  await page.waitFor(`document.querySelector('[data-field="lighttable-project"]')?.value===${JSON.stringify(id)}&&document.querySelector('[data-lighttable-revision="r0002"]')!==null`, 45000)
  await page.click('[data-view-tab="scene"]')
  await page.waitFor(`document.querySelector('[data-placement-base-revision="r0002"]')!==null`, 45000)
  const supports = await page.evaluate(`Array.from(document.querySelector('[data-field="placement-support"]').options).map(option=>option.value)`)
  check('the actual form offers external supports and excludes every lamp member', supports.includes('task-ramp') && ids.every(id => !supports.includes(id)))
  await select('placement-support', 'task-ramp'); await page.fill('[data-field="placement-x"]', '200'); await page.fill('[data-field="placement-y"]', '-100')
  await page.fill('[data-field="placement-yaw"]', '361')
  check('invalid yaw blocks the real save and exposes an accessible error', await page.evaluate(`document.querySelector('[data-action="placement-save"]').disabled&&document.querySelector('[data-field="placement-yaw"]').getAttribute('aria-invalid')==='true'`))
  check('typing and rejected values send no writes', await page.evaluate('window.__placementWrites.length===0'))
  await page.fill('[data-field="placement-yaw"]', '35'); await page.fill('[data-field="placement-clearance"]', '1.5')
  await clickWorkbenchControl(page, '[data-field="placement-z"]')
  await page.fill('[data-field="placement-z"]', '150'); await page.fill('[data-field="placement-pivotX"]', '80'); await page.fill('[data-field="placement-pivotY"]', '-30')
  check('valid complete intent enables the real save', await page.evaluate(`!document.querySelector('[data-action="placement-save"]').disabled`))
  await page.evaluate(`(() => {const input=document.querySelector('[data-field="placement-z"]');const details=input.closest('details');details.querySelector('summary').click();return true})()`)
  await page.evaluate(`(() => {document.querySelector('[data-placement-editor]').scrollIntoView({block:'start',behavior:'instant'});return true})()`)
  await page.screenshot(join(output, 'desktop-form.png'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await page.evaluate(`(() => {document.querySelector('[data-placement-editor]').scrollIntoView({block:'start',behavior:'instant'});return true})()`)
  check('mobile placement controls fit the available width', await page.evaluate(`(() => {const r=document.querySelector('[data-placement-editor]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()`))
  await page.screenshot(join(output, 'mobile-form.png'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const start = Date.now(); check('one pointer submits the complete measured placement', (await page.click('[data-action="placement-save"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[data-field="compare-right"]')?.value==='r0003'`, 240000)
  json('placement-duration.json', { durationMs: Date.now()-start })
  const placed = read(id, 'revisions/r0003/scene-spec.json'), receipt = read(id, 'revisions/r0003/revision-manifest.json').surfacePlacementReceipt
  check('actual saved receipt and23 native proofs bind the exact selected support/frame/pose', receipt.schemaVersion === 'deepblend.assembly-placement-receipt/v1'
    && receipt.sourceRevision === 'r0002' && receipt.supportEntityId === 'task-ramp' && receipt.frame === 24 && receipt.clearanceMm === 1.5
    && isDeepStrictEqual(receipt.memberEntityIds, ids) && receipt.after.baselineVerification.members.length === 23)
  check('actual UI placement preserves saved photography, materials and unrelated marker', isDeepStrictEqual(placed.cameras, source.cameras)
    && isDeepStrictEqual(placed.lights, source.lights) && isDeepStrictEqual(placed.materials, source.materials)
    && isDeepStrictEqual(placed.entities.find(entity => entity.id === 'unrelated-marker'), source.entities.find(entity => entity.id === 'unrelated-marker')))
  await page.waitFor(`document.querySelector('[data-result-kind="assembly-placement"]')!==null`, 30000)
  check('the immediate comparison destination announces saved23 members/revision and framing reminder', await page.evaluate(`(() => {
    const node=document.querySelector('[data-result-kind="assembly-placement"]');return node.getAttribute('role')==='status'
      &&node.getAttribute('aria-live')==='polite'&&node.textContent.includes('23')&&node.textContent.includes('r0003')&&node.textContent.includes('构图')})()`))
  for (const mode of ['revisions', 'result']) {
    await page.click(`[data-compare-mode="${mode}"]`)
    for (const [name, width, height, mobile] of [['desktop',1440,1000,false],['mobile',390,844,true]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
      await page.evaluate(`(() => {document.querySelector('[data-result-kind="assembly-placement"]').scrollIntoView({block:'center',behavior:'instant'});return true})()`)
      check(name + ' ' + mode + ' completion is visible on the actual destination', await page.evaluate(`(() => {const node=document.querySelector('[data-result-kind="assembly-placement"]');const r=node.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()`))
      await page.screenshot(join(output, `${name}-placement-saved-${mode}.png`))
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  }
  freeze(id, 'r0003')
  await page.reload(); await page.waitFor(`document.querySelector('[data-lighttable-revision="r0003"]')!==null`, 45000)
  await page.click('[data-view-tab="scene"]'); await page.waitFor(`document.querySelector('[data-placement-base-revision="r0003"]')!==null`, 30000)
  check('reload restores saved placement and clears the relative movement draft', await page.evaluate(`document.querySelector('[data-field="placement-x"]').value==='0'&&document.querySelector('[data-field="placement-yaw"]').value==='0'`))
  for (const [diameter, revision] of [[250, 'r0004'], [230, 'r0005']]) {
    const baseRevision = diameter === 250 ? 'r0003' : 'r0004'
    await page.click('[data-view-tab="scene"]'); await page.waitFor(`document.querySelector('[data-assembly-base-revision="${baseRevision}"]')!==null`, 30000)
    await page.fill('[data-field="assembly-shade-diameter-mm"]', String(diameter))
    check('one pointer continues the placed assembly to' + diameter + 'mm', (await page.click('[data-action="assembly-save"]')).via === 'pointer')
    await page.waitFor(`document.querySelector('[data-field="compare-right"]')?.value===${JSON.stringify(revision)}`, 180000)
    freeze(id, revision)
  }
  const writes = await page.evaluate('window.__placementWrites')
  check('the actual browser workflow makes exactly1 whole-placement and2 dimension writes', writes.length === 3
    && writes[0].url.endsWith('/surface-placement') && writes.slice(1).every(write => write.url.endsWith('/recipe-parameters'))
    && writes[0].body.scope === 'recipe-assembly' && !Object.hasOwn(writes[0].body, 'operations'))
  json('browser-writes.json', writes)
  const requests = [sourceInspection]
  for (const [label, revision, referenceId] of [['placed', 'r0003', null], ['continued250', 'r0004', 'ui-reference250'], ['continued230', 'r0005', 'ui-reference230']]) {
    if (referenceId) requests.push({ ...sourceInspection, label: referenceId, checkpoint: file(referenceId, 'revisions/r0002/scene.blend') })
    requests.push({ ...sourceInspection, label, checkpoint: file(id, 'revisions', revision, 'scene.blend'), reference: referenceId || 'source', expectedMatrix: expected })
  }
  const results = native('independent-browser-results', requests)
  for (const label of ['placed', 'continued250', 'continued230']) {
    const result = results.find(result => result.label === label)
    check(label + ' actual23 native meshes match the independent pose/contact/same-size geometry and unchanged photography',
      result.memberCount === 23 && Object.values(result.maxVertexErrorsM).every(value => value < 2e-6)
      && Object.values(result.maxMatrixErrors).every(value => value < 2e-6) && result.allLocalGeometryEqual && result.allMaterialsEqual
      && result.photographyUnchanged && result.unrelatedUnchanged && result.checkpointUnchanged
      && Math.abs(result.minimumWholeLampVerticalGapM-.0015) < 2e-6 && result.insideSupportXYBounds)
  }
  await page.click('[data-compare-mode="result"]')
  await page.waitFor(`document.querySelector('[data-compare="current"] img')?.complete&&document.querySelector('[data-compare="current"] img')?.naturalWidth>0`, 45000)
  await page.evaluate(`(() => {document.querySelector('.db-body')?.scrollTo({top:0,behavior:'instant'});return true})()`)
  await page.screenshot(join(output, 'desktop-result.png'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await page.evaluate(`(() => {document.querySelector('.db-body')?.scrollTo({top:0,behavior:'instant'});return true})()`)
  await page.screenshot(join(output, 'mobile-result.png'))
  for (const revision of ['r0002', 'r0003', 'r0004', 'r0005']) {
    const previews = read(id, 'revisions', revision, 'revision-manifest.json').previews
    check(revision + ' actual preview is bound to its saved source and bytes', previews.length > 0 && previews.every(artifact => {
      const path = file(id, artifact.path); protectedFiles[path] ??= hash(path)
      return artifact.sourceRevision === revision && artifact.sha256 === hash(path) && artifact.frame === 24
    }))
  }
  check('all original source/native/recipe/state/preview files remain byte-identical', Object.entries(protectedFiles).every(([path, sha256]) => hash(path) === sha256))
  json('history-protection.json', protectedFiles)
} catch (error) { failure = { message: error.message, code: error.code, stack: error.stack }; console.error(error) }
finally {
  if (page) json('browser-console.json', page.consoleLog)
  if (server) writeFileSync(join(output, 'server.log'), server.output.join('').replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]'))
  try { if (browser) await browser.close() } catch (error) { failure ??= { message: error.message } }
  try { if (server) shutdown = await server.stop() } catch (error) { failure ??= { message: error.message } }
  json('summary.json', { startedAt, finishedAt: new Date().toISOString(), checks, failure, shutdown,
    scope: 'Actual isolated DSH/Chrome workbench operations and independent native verification; maintainer tasks, not an LLM evaluation or artistic/manufacturing certification.' })
  if (failure) process.exitCode = 1
}
