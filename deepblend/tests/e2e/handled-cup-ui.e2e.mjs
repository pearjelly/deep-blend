/** Real browser + Host + Blender: shipped cup recipe creation, dimensions, edits, refusals and reload. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT,'.deepblend/quality',`cup-ui-${new Date().toISOString().replace(/[:.]/g,'-')}`))
if(existsSync(output))throw Error(`Evidence exists: ${output}`)
mkdirSync(output,{recursive:true})
const root=join(output,'store'), projectId='cup-ui', checks=[]
const json=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
const path=(...parts)=>join(root,'projects',projectId,...parts)
const read=(...parts)=>JSON.parse(readFileSync(path(...parts)))
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const field=key=>`[data-field="editor-generator-${key}"]`
function check(name,ok,detail){checks.push({name,ok,detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
let server,browser,page,base,failure=null,shutdown
try {
  const rows=JSON.parse(await storePatch(root))
  rows.find(r=>r.id==='deepblend-blender-runtime').config.blenderPath=process.env.DEEPBLEND_BLENDER_PATH??join(REPO_ROOT,'.tools/Blender.app/Contents/MacOS/Blender')
  rows.find(r=>r.id==='deepblend-blender-host').config.maxPreviewSamples=8
  server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows),keepHome:false});base=`http://127.0.0.1:${server.port}`
  browser=await Browser.launch({args:['--window-size=1440,1100']});page=await browser.newPage()
  await page.addInitScript(`window.__cupRequests=[];const original=window.fetch;window.fetch=(input,init)=>{let body;try{body=JSON.parse(init?.body)}catch{};window.__cupRequests.push({url:String(input),method:init?.method||'GET',body});return original(input,init)}`)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor(`document.querySelector('[data-action="select-recipe:deepblend.glazed-cup@1.0.0"]')!==null`,45_000)
  const card='[data-recipe="deepblend.glazed-cup"]'
  await page.waitFor(`(() => {const img=document.querySelector(${JSON.stringify(card+' img')});return img?.complete && img.naturalWidth===960 && img.naturalHeight===720})()`)
  check('gallery shows the shipped cup render and author/license', (await page.text(card)).includes('MIT') && (await page.text(card)).includes('青釉带把手杯'))
  await page.click('[data-action="select-recipe:deepblend.glazed-cup@1.0.0"]')
  await page.fill('[data-field="project-title"]',projectId)
  await page.fill('[data-field="recipe-surface-roughness"]','0.28')
  await page.fill('[data-field="recipe-exposure"]','0.2')
  const clicked=await page.click('[data-action="create-project"]')
  await page.waitFor('(() => {const img=document.querySelector("[data-compare=current] img");return img?.complete && img.naturalWidth===640 && img.naturalHeight===480})()',180_000)
  const writesAtCreation=await page.evaluate('window.__cupRequests.filter(x=>x.method==="POST")')
  check('pointer creation submits a pinned cup recipe and selected parameters',clicked.via==='pointer' && writesAtCreation.length===1 && writesAtCreation[0].body?.recipe?.id==='deepblend.glazed-cup' && /^[a-f0-9]{64}$/.test(writesAtCreation[0].body.recipe.digest) && writesAtCreation[0].body.recipe.parameters['surface-roughness']===.28 && writesAtCreation[0].body.sceneSpec===undefined)
  const initial=read('revisions/r0001/scene-spec.json'),lock=read('revisions/r0001/recipe-lock.json')
  check('saved recipe provenance and material/exposure match the UI selection',lock.id==='deepblend.glazed-cup' && lock.values['surface-roughness']===.28 && initial.materials.find(m=>m.id==='glaze').parameters.roughness===.28 && ['preview','final'].every(p=>initial.renderProfiles[p].colorManagement.exposure===.2))
  await page.waitFor('(() => {const img=document.querySelector("[data-compare=current] img");return img?.complete && img.naturalWidth===640 && img.naturalHeight===480})()',45_000)
  check('creation displays the actual cup preview at the recipe resolution',existsSync(path('revisions/r0001/scene.blend')))
  const original=Object.fromEntries(['scene.blend','scene-spec.json','recipe-lock.json','previews/hero.png'].map(file=>[file,sha(path('revisions/r0001',file))]))
  await page.screenshot(join(output,'recipe-created.png'))
  await page.evaluate('window.__cupRequests=[]')
  await page.click('[data-view-tab="scene"]')
  await page.click('[data-action="select-entity:cup"]')
  await page.waitFor('document.querySelector("[data-editor-entity=cup]")!==null')
  check('recipe dimensions and compact attachments display in millimetres with no accidental write',await page.evaluate(`document.querySelector(${JSON.stringify(field('height'))}).value==='105' && document.querySelector(${JSON.stringify(field('wallThickness'))}).value==='3' && document.querySelector(${JSON.stringify(field('rootRadius'))}).value==='9' && document.querySelector(${JSON.stringify(field('rootLength'))}).value==='6' && window.__cupRequests.every(x=>x.method!=='POST')`))
  check('cup editor labels and attachment guidance are visible',(await page.text('[data-editor-entity=cup]')).includes('带把手杯体')&&(await page.text('[data-editor-entity=cup]')).includes('检查实际网格'))
  await page.fill(field('height'),'110')
  check('typing a dimension keeps the saved revision',read('project.json').currentRevision==='r0001')
  await page.click('[data-action="editor-apply"]')
  await page.waitFor('document.querySelector("[data-field=compare-right]")?.value==="r0002"',180_000)
  await page.click('[data-view-tab="scene"]')
  await page.click('[data-action="select-entity:cup"]')
  await page.waitFor('document.querySelector("[data-editor-base-revision=r0002]")!==null',180_000)
  check('millimetre edit creates a real saved cup revision',read('revisions/r0002/scene-spec.json').entities.find(e=>e.id==='cup').generator.height===.11 && existsSync(path('revisions/r0002/scene.blend')))
  await page.evaluate('document.querySelector("[data-editor-entity=cup] details").open=true')
  await page.fill(field('segments'),'65')
  check('invalid segment multiples disable apply',await page.evaluate('document.querySelector("[data-action=editor-apply]").disabled && document.querySelector("[data-editor-errors]")!==null'))
  await page.fill(field('segments'),'192');await page.fill(field('rootLength'),'0.1')
  await page.click('[data-action="editor-apply"]')
  await page.waitFor('document.body.textContent.includes("SCENE_SPEC_INVALID")',180_000)
  check('unsupported coupled dimensions retain revision and editable draft',read('project.json').currentRevision==='r0002' && await page.evaluate(`document.querySelector(${JSON.stringify(field('rootLength'))}).value==='0.1'`))
  await page.screenshot(join(output,'rejected-dimension.png'))
  await page.reload();await page.waitFor('document.querySelector("[data-brief-base-revision=r0002]")!==null',45_000)
  await page.click('[data-view-tab="scene"]');await page.click('[data-action="select-entity:cup"]')
  await page.waitFor('document.querySelector("[data-editor-entity=cup]")!==null')
  check('reload restores the authoritative saved dimensions',await page.evaluate(`document.querySelector(${JSON.stringify(field('height'))}).value==='110'`))
  check('old scene, checkpoint and preview remain unchanged',Object.entries(original).every(([file,hash])=>sha(path('revisions/r0001',file))===hash))
  await page.screenshot(join(output,'cup-editor.png'))
  const writes=await page.evaluate('window.__cupRequests.filter(x=>x.method==="POST")')
  check('reload and object selection do not submit changes',writes.length===0)
  json('original-hashes.json',original)
}catch(error){failure=error.stack||String(error);console.error(error);await page?.screenshot(join(output,'failure.png')).catch(()=>{})}
finally {
  for(const [name,close]of [['browser',()=>browser?.close()],['server',()=>server?.stop()]]){
    try{const result=await close();if(name==='server')shutdown=result}catch(error){failure??=String(error);checks.push({name:`${name} cleanup`,ok:false,detail:String(error)})}
  }
  json('report.json',{status:failure?'failed':'passed',checks,failure,shutdown,scope:'Real Chrome, Host and Blender edits. Shipped recipe bytes with an operator eight-sample cap verify creation and edits; artistic approval and the continuous parameter domain remain unverified.'})
}
if(failure)process.exitCode=1
