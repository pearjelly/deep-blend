#!/usr/bin/env node
/** Real gallery dimensions, native assembly output and immutable historical source. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { ensureWorkbenchCaptureReady } from '../../tools/docs-capture-visibility.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `linked-speaker-${Date.now()}`))
if (existsSync(output)) throw Error(`Evidence already exists: ${output}`)
mkdirSync(output, { recursive: true })
const root = join(output, 'store'), external = join(output, 'recipes')
cpSync(join(REPO_ROOT, 'deepblend/tests/fixtures/modular-speaker-v1'), join(external, 'historical'), { recursive: true })
const checks = [], sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
const path = (id, ...parts) => join(root, 'projects', id, ...parts)
const read = (id, ...parts) => JSON.parse(readFileSync(path(id, ...parts)))
const choice = version => `[data-action="select-recipe:deepblend.modular-speaker@${version}"]`
const field = id => `[data-field="recipe-${id}"]`
let server, browser, page, failure, shutdown, original
try {
  const blender = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blender
  const host = rows.find(row => row.id === 'deepblend-blender-host').config
  host.maxPreviewSamples = 8; host.recipeDirectories = [external]
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  const catalog = await (await fetch(base + '/deepblend/recipes')).json()
  check('actual Host offers separate original and linked speaker versions', catalog.recipes.filter(r => r.id === 'deepblend.modular-speaker').length === 2)
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.addInitScript(`window.__writes=[];const original=window.fetch;window.fetch=(url,init)=>{if(init?.method==='POST')window.__writes.push({url:String(url),body:JSON.parse(init.body)});return original(url,init)}`)
  await page.goto(base + '/deepblend/workbench'); await page.waitFor(`document.querySelector(${JSON.stringify(choice('1.0.0'))})!==null`, 45000)
  await page.click(choice('1.0.0'))
  check('original version keeps its original appearance controls', await page.count(field('cabinet-width-mm')) === 0 && await page.count(field('surface-roughness')) === 1)
  await page.fill('[data-field="project-title"]', 'legacy-speaker')
  await page.click('[data-action="create-project"]')
  await page.waitFor('document.querySelector("[data-view=preview] img[data-artifact]")?.src.includes("/legacy-speaker/")===true', 180000)
  const old = read('legacy-speaker', 'revisions/r0001/revision-manifest.json')
  original = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend', `revisions/r0001/${old.recipe.lockPath}`, old.previews.at(-1).path].map(file => [file, sha(readFileSync(path('legacy-speaker', file)))]))
  await page.click('[data-view-tab="projects"]'); await page.click(choice('2.1.0'))
  check('linked version shows three authored millimetre defaults', await page.evaluate(`['cabinet-width-mm','cabinet-depth-mm','cabinet-height-mm'].every((id,i)=>Number(document.querySelector('[data-field="recipe-'+id+'"]').value)===[264,138,162][i])`))
  await page.fill(field('cabinet-depth-mm'), '100')
  check('unsupported dimensions disable creation before any new request', await page.evaluate(`document.querySelector('[data-action="create-project"]').disabled&&window.__writes.filter(r=>r.url==='/deepblend/projects').length===1`))
  await page.fill(field('cabinet-depth-mm'), '138'); await page.fill(field('cabinet-width-mm'), '300')
  await page.fill('[data-field="project-title"]', 'linked-width')
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(output, '01-dimension-inputs.png'))
  check('one explicit creation click is a real pointer event', (await page.click('[data-action="create-project"]')).via === 'pointer')
  await page.waitFor('document.querySelector("[data-view=preview] img[data-artifact]")?.src.includes("/linked-width/")===true', 180000)
  const manifest = read('linked-width', 'revisions/r0001/revision-manifest.json')
  const lock = read('linked-width', 'revisions/r0001', manifest.recipe.lockPath)
  const spec = read('linked-width', 'revisions/r0001/scene-spec.json'), preview = manifest.previews.at(-1)
  check('creation pins the selected dimensions and exact input bytes', lock.version === '2.1.0' && lock.values['cabinet-width-mm'] === 300 && lock.values['cabinet-depth-mm'] === 138 && lock.values['cabinet-height-mm'] === 162 && sha(lock.sceneSource) === lock.inputSha256)
  check('the created scene retains the complete assembly and preview evidence', spec.entities.length === 111 && preview.sourceRevision === 'r0001' && preview.sourceDigest === manifest.digest && preview.cameraId === 'hero' && preview.samples <= 8 && Boolean(preview.renderConfig))
  const pixels = readFileSync(path('linked-width', preview.path))
  check('native creation produces a decoded rendered image', decodePng(pixels).data.length === preview.width * preview.height * 4)
  copyFileSync(path('linked-width', preview.path), join(output, '02-native-preview.png'))
  const script = join(output, 'readback.py'), receipt = join(output, 'native-readback.json')
  writeFileSync(script, `import bpy,json\nfrom mathutils import Matrix\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path('linked-width', 'revisions/r0001/scene.blend'))})\nbpy.context.scene.frame_set(1)\nbpy.context.view_layer.update()\ndg=bpy.context.evaluated_depsgraph_get()\ndef bounds(id):\n o=bpy.data.objects['db_entity__'+id];e=o.evaluated_get(dg);m=e.to_mesh();t=Matrix.LocRotScale(o.location,o.rotation_euler.to_quaternion(),o.scale) if o.hide_viewport else e.matrix_world\n try:\n  p=[t@v.co for v in m.vertices];return [[min(v[i] for v in p),max(v[i] for v in p)] for i in range(3)]\n finally:e.to_mesh_clear()\ns=bounds('cabinet-shell');c=bounds('shell-cavity-tool')\njson.dump({'dimensions':[b-a for a,b in s],'gap':[((s[i][1]-s[i][0])-(c[i][1]-c[i][0]))/2 for i in range(3)],'bottomZ':s[2][0],'entities':len([o for o in bpy.data.objects if o.name.startswith('db_entity__')])},open(${JSON.stringify(receipt)},'w'))\n`)
  writeFileSync(join(output, 'native-readback.log'), execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 }))
  const native = JSON.parse(readFileSync(receipt))
  check('independent native reopening confirms 300 × 138 × 162 mm and preserved flat bounds gaps', native.entities === 111 && native.dimensions.every((v, i) => Math.abs(v - [.3, .138, .162][i]) < 1e-6) && native.gap.every((v, i) => Math.abs(v - [.009, .0115, .009][i]) < 1e-6) && Math.abs(native.bottomZ - .014) < 1e-6, native)
  check('new linked creation preserves every protected original project artifact', Object.entries(original).every(([file, digest]) => sha(readFileSync(path('legacy-speaker', file))) === digest))
  const writes = await page.evaluate('window.__writes'); json('requests.json', writes)
  check('only the two explicit creations were submitted', writes.filter(r => r.url === '/deepblend/projects').length === 2)
  json('recipe-lock.json', lock); json('preview.json', preview); json('catalog.json', catalog)
  await page.screenshot(join(output, '03-result.png'))
} catch (error) { failure = error.stack || String(error); console.error(error); await page?.screenshot(join(output, 'failure.png')).catch(() => {}) }
finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { failure ??= String(error) }
  }
  json('report.json', { status: failure ? 'failed' : 'passed', checks, failure, shutdown, original,
    scope: 'Actual browser creation through DSH Host and Blender, original package compatibility, bounded dimensions, independent saved-file readback and historical artifact protection. Creation controls only; existing assembly editing, minimum wall, natural-language Agent success and external quality review are separate.' })
}
console.log(`Linked speaker UI: ${checks.filter(c => c.ok).length}/${checks.length} checks passed; ${output}`)
if (failure) process.exitCode = 1
