#!/usr/bin/env node
/** Centered spacing and timber edge finishing through the real gallery, saved controls and editable ZIP. */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { decodePng, sha256 } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `trivet-spacing-${Date.now()}`))
if (existsSync(output)) throw Error('Use a fresh evidence directory')
mkdirSync(output, { recursive: true })
const store = join(output, 'store'), downloads = join(output, 'downloads'), measurements = [], checks = []
mkdirSync(downloads)
const blender = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const project = id => join(store, 'projects', id)
const file = (id, revision, name) => join(project(id), 'revisions', revision, name)
const read = path => JSON.parse(readFileSync(path))
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const field = name => `[data-field="${name}"]`
function check(name, ok, detail) {
  checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); assert(ok, name)
}
let server, browser, page, failure, shutdown, native, archive, protectedFiles
const click = selector => clickWorkbenchControl(page, selector)
async function saved(id, revision, spacing, edgeWidth) {
  await page.waitFor(`Array.from(document.querySelectorAll('[data-view="preview"] img[data-artifact]')).some(image => image.src.includes('/${id}/revisions/${revision}/'))`, 180000)
  const manifest = read(file(id, revision, 'revision-manifest.json')), preview = manifest.previews.at(-1)
  const bytes = readFileSync(join(project(id), preview.path))
  check(`${id}/${revision}: the committed source has its own decoded native preview`,
    read(join(project(id), 'project.json')).currentRevision === revision && preview.sourceRevision === revision
    && preview.sourceDigest === manifest.digest && preview.sha256 === sha256(bytes)
    && decodePng(bytes).data.length === preview.width * preview.height * 4)
  copyFileSync(join(project(id), preview.path), join(output, `${id}-${revision}.png`))
  check(`${id}/${revision}: the stored edge width matches the selected millimetres`,
    (read(file(id,revision,'scene-spec.json')).halfLaps[0].edgeWidth ?? 0) === edgeWidth/1000)
  measurements.push({ label: `${id}-${revision}`, spacing, edgeWidth, path: file(id, revision, 'scene.blend') })
  return manifest
}
async function controls(revision) {
  // The shell loads before its selected project; a visible tab may still be disabled.
  await page.waitFor(`document.querySelector('[data-view-tab="scene"]')?.disabled === false`, 30000)
  await click('[data-view-tab="scene"]')
  await page.waitFor(`document.querySelector('[data-assembly-base-revision="${revision}"]') !== null`, 30000)
}
try {
  const rows = JSON.parse(await storePatch(store))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.addInitScript(`window.__writes=[];const original=window.fetch;window.fetch=(url,init)=>{if(init?.method==='POST')window.__writes.push({url:String(url),body:JSON.parse(init.body)});return original(url,init)}`)
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
  await page.goto(base + '/deepblend/workbench')
  const choice = '[data-action="select-recipe:deepblend.walnut-trivet@1.2.0"]'
  await page.waitFor(`document.querySelector(${JSON.stringify(choice)}) !== null`, 45000)
  for (const [index, spacing] of [52, 92, 64].entries()) {
    const edgeWidth = [0,1,.5][index]
    if (index) await click('[data-action="new-work"]')
    await click(choice)
    check(`${spacing} mm: creation offers the authored 78 mm default`, Number(await page.evaluate(`document.querySelector(${JSON.stringify(field('recipe-slat-spacing'))}).value`)) === 78)
    check(`${spacing} mm: creation offers the 0.5 mm edge default`,Number(await page.evaluate(`document.querySelector(${JSON.stringify(field('recipe-edge-width'))}).value`))===.5)
    if (!index) {
      await page.fill(field('recipe-slat-spacing'), '51')
      check('an out-of-range creation is disabled before any project write', await page.evaluate(`document.querySelector('[data-action="create-project"]').disabled && window.__writes.length === 0`))
      await page.fill(field('recipe-slat-spacing'),'52')
      await page.fill(field('recipe-edge-width'),'1.1')
      check('an out-of-range creation edge width blocks a write',await page.evaluate(`document.querySelector('[data-action="create-project"]').disabled && window.__writes.length === 0`))
    }
    await page.fill(field('recipe-slat-spacing'), String(spacing))
    await page.fill(field('recipe-edge-width'), String(edgeWidth))
    const id = `trivet-spacing-${spacing}`
    await page.fill(field('project-title'), id)
    await click('[data-action="create-project"]')
    await saved(id, 'r0001', spacing, edgeWidth)
    const lock = read(file(id, 'r0001', 'recipe-lock.json'))
    check(`${spacing} mm: creation locks the selected version, input bytes and spacing`, lock.version === '1.2.0'
      && lock.values['slat-spacing'] === spacing && lock.values['edge-width'] === edgeWidth && sha256(lock.sceneSource) === lock.inputSha256)
  }
  const id = 'trivet-spacing-64'
  const first = read(file(id, 'r0001', 'revision-manifest.json'))
  protectedFiles = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend',
    'revisions/r0001/recipe-lock.json', 'revisions/r0001/revision-manifest.json', first.previews.at(-1).path]
    .map(path => [path, sha256(readFileSync(join(project(id), path)))]))
  let revision = 'r0001'
  for (const [index, spacing] of [92, 78, 64].entries()) {
    const edgeWidth = [1,0,.5][index]
    await controls(revision)
    if (!index) {
      await page.fill(field('assembly-slat-spacing'), '93')
      check('out-of-range saved spacing blocks a write', await page.evaluate(`document.querySelector('[data-action="assembly-save"]').disabled && window.__writes.filter(row=>row.url.endsWith('/recipe-parameters')).length === 0`))
      await page.fill(field('assembly-slat-spacing'),'92')
      await page.fill(field('assembly-edge-width'),'1.1')
      check('out-of-range saved edge width blocks a write',await page.evaluate(`document.querySelector('[data-action="assembly-save"]').disabled && window.__writes.filter(row=>row.url.endsWith('/recipe-parameters')).length === 0`))
    }
    await page.fill(field('assembly-slat-spacing'), String(spacing))
    await page.fill(field('assembly-edge-width'), String(edgeWidth))
    await click('[data-action="assembly-save"]')
    revision = `r000${index + 2}`
    const manifest = await saved(id, revision, spacing, edgeWidth), state = read(file(id, revision, 'recipe-parameters.json'))
    check(`${revision}: spacing is saved on the existing project with its original source lock`,
      state.values['slat-spacing'] === spacing && state.values['edge-width'] === edgeWidth && state.originRevision === 'r0001' && Boolean(manifest.recipeParameters))
  }
  assert.deepEqual(read(file(id, revision, 'scene-spec.json')), read(file(id, 'r0001', 'scene-spec.json')))
  check('returning to 64 mm has no cumulative geometry drift', true)
  await page.reload(); await controls(revision)
  check('refresh reads the actual saved spacing', Number(await page.evaluate(`document.querySelector(${JSON.stringify(field('assembly-slat-spacing'))}).value`)) === 64)
  check('refresh reads the actual saved edge width',Number(await page.evaluate(`document.querySelector(${JSON.stringify(field('assembly-edge-width'))}).value`))===.5)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await page.waitFor('innerWidth === 390', 10000)
  await page.evaluate(`document.querySelector(${JSON.stringify(field('assembly-slat-spacing'))}).scrollIntoView({block:'center'})`)
  check('the existing spacing controls fit a 390 px workbench', await page.evaluate('document.documentElement.scrollWidth === 390'))
  await page.screenshot(join(output, 'spacing-workbench-390px.png'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  await click('[data-view-tab="revisions"]')
  await page.waitFor(`document.querySelector('[data-field="snapshot-revision"]')?.value === '${revision}'`, 30000)
  await click('[data-action="snapshot-prepare"]')
  await page.waitFor(`document.querySelector('[data-action="snapshot-download"], [data-editable-snapshot="failed"]') !== null`, 60000)
  assert.equal(await page.count('[data-editable-snapshot="failed"]'), 0)
  await click('[data-action="snapshot-download"]')
  const deadline = Date.now() + 30000
  let name
  while (!name && Date.now() < deadline) {
    name = readdirSync(downloads).find(item => item.endsWith('.zip'))
    if (!name) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert(name, 'the browser must finish downloading the ZIP')
  const extracted = join(output, 'extracted')
  archive = JSON.parse(execFileSync('python3', ['-c', `import hashlib,json,sys,zipfile
from pathlib import Path
archive,extracted,source,revision=sys.argv[1:]
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 files=json.loads(z.read('file-manifest.json'))['files']
 assert set(z.namelist()) == {f['path'] for f in files} | {'file-manifest.json'}
 for f in files:
  data=z.read(f['path'])
  assert len(data)==f['bytes'] and hashlib.sha256(data).hexdigest()==f['sha256']
 for path in ['revisions/'+revision+'/scene.blend','revisions/'+revision+'/scene-spec.json','revisions/'+revision+'/recipe-parameters.json','revisions/r0001/recipe-lock.json']:
  assert z.read(path)==(Path(source)/path).read_bytes()
 manifest=json.loads(z.read('snapshot-manifest.json'))
 assert manifest['revision']==revision and manifest['assets']==[]
 assert all(not Path(p).is_absolute() and '..' not in Path(p).parts for p in z.namelist())
 z.extractall(extracted)
 print(json.dumps({'revision':revision,'filesVerified':len(files),'archiveSha256':hashlib.sha256(Path(archive).read_bytes()).hexdigest()}))
`, join(downloads, name), extracted, project(id), revision], { encoding: 'utf8', timeout: 30000 }))
  check('the browser-downloaded ZIP preserves every listed byte, selected checkpoint and parameter state', archive.revision === revision)
  measurements.push({ label: 'relocated-zip', spacing: 64, edgeWidth:.5, path: join(extracted, 'revisions', revision, 'scene.blend') })
  const log = execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
    '--python', join(REPO_ROOT, 'deepblend/tests/e2e/trivet-spacing-readback.py'), '--',
    '--edge-widths',...measurements.flatMap(item => [item.label, String(item.spacing),String(item.edgeWidth),item.path])], { encoding: 'utf8', timeout: 120000 })
  writeFileSync(join(output, 'native-readback.log'), log)
  native = JSON.parse(log.split('\n').find(line => line.startsWith('CENTERED_TRIVET ')).slice('CENTERED_TRIVET '.length))
  check('independent Blender reopening confirms centered spacing, seven closed solids, twelve crossings and no sampled overlap in all seven checkpoints',
    Object.keys(native).length === measurements.length && measurements.every(item => native[item.label].spacingMm === item.spacing
      && native[item.label].edgeWidthMm === item.edgeWidth && native[item.label].crossings === 12 && native[item.label].overlapCells === 0))
  const matrixOutput=join(output,'transformed-native-checks.json')
  const matrixLog=execFileSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1',
    '--python',join(REPO_ROOT,'deepblend/tests/blender-integration/timber-edge-finish-checks.py'),'--',
    join(REPO_ROOT,'deepblend/recipes/walnut-trivet/scene-spec.json'),matrixOutput],{encoding:'utf8',timeout:120000})
  writeFileSync(join(output,'transformed-native-checks.log'),matrixLog)
  const matrix=read(matrixOutput)
  check('native transformed normals match a baked reference and both failed and copied modifier results preserve atomic mesh ownership',
    matrix.status==='passed' && matrix.results.length===10)
  check('all original native files, scene data, source locks and previews remain byte-identical',
    Object.entries(protectedFiles).every(([path, hash]) => sha256(readFileSync(join(project(id), path))) === hash))
  json('ui-requests.json', await page.evaluate('window.__writes'))
  await page.screenshot(join(output, 'editable-download.png'))
} catch (error) {
  failure = error.stack || String(error); console.error(error)
  await page?.screenshot(join(output, 'failure.png')).catch(() => {})
  if (page) {
    json('failure-page.json', await page.evaluate('({ text:document.body.innerText, images:[...document.images].map(image=>image.src), writes:window.__writes })').catch(() => null))
  }
} finally {
  try { await browser?.close() } catch (error) { failure ??= String(error) }
  try { shutdown = await server?.stop() } catch (error) { failure ??= String(error) }
  json('report.json', { status: failure ? 'failed' : 'passed', checks, native, archive, measurements, protectedFiles, failure, shutdown,
    scope: 'Real browser creation and saved spacing edits, native closed-component and sampled joint measurements, immutable history and relocated editable ZIP. No model calls or manufacturing qualification.' })
}
console.log(`Trivet spacing UI: ${checks.filter(item => item.ok).length}/${checks.length} checks passed; ${output}`)
if (failure) process.exitCode = 1
