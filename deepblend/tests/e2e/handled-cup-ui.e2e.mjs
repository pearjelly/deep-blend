/** Real browser + Host + Blender: default cup dimensions, edits, refusals and reload. */
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
  const spec=JSON.parse(readFileSync(join(REPO_ROOT,'deepblend/fixtures/handled-cup/scene-spec.json')))
  spec.project.id=projectId;spec.project.title='Cup editor'
  spec.renderProfiles.preview={...spec.renderProfiles.preview,resolution:[256,192],samples:8,maxSamplesBudget:8}
  const rows=JSON.parse(await storePatch(root))
  rows.find(r=>r.id==='deepblend-blender-runtime').config.blenderPath=process.env.DEEPBLEND_BLENDER_PATH??join(REPO_ROOT,'.tools/Blender.app/Contents/MacOS/Blender')
  rows.find(r=>r.id==='deepblend-blender-host').config.maxPreviewSamples=8
  server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows),keepHome:false});base=`http://127.0.0.1:${server.port}`
  const created=await fetch(`${base}/deepblend/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId,title:spec.project.title,sceneSpec:spec,renderPreview:true}),signal:AbortSignal.timeout(180_000)})
  if(!created.ok)throw Error(await created.text())
  const original=Object.fromEntries(['scene.blend','scene-spec.json','previews/hero.png'].map(file=>[file,sha(path('revisions/r0001',file))]))
  browser=await Browser.launch({args:['--window-size=1440,1100']});page=await browser.newPage()
  await page.addInitScript(`window.__cupRequests=[];const original=window.fetch;window.fetch=(input,init)=>{let body;try{body=JSON.parse(init?.body)}catch{};window.__cupRequests.push({url:String(input),method:init?.method||'GET',body});return original(input,init)}`)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null',45_000)
  await page.click('[data-view-tab="scene"]')
  await page.click('[data-action="select-entity:cup"]')
  await page.waitFor('document.querySelector("[data-editor-entity=cup]")!==null')
  check('default dimensions display in millimetres with no accidental write',await page.evaluate(`document.querySelector(${JSON.stringify(field('height'))}).value==='105' && document.querySelector(${JSON.stringify(field('wallThickness'))}).value==='3' && window.__cupRequests.every(x=>x.method!=='POST')`))
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
  json('report.json',{status:failure?'failed':'passed',checks,failure,shutdown,scope:'Real Chrome, Host and Blender edits. Eight-sample previews verify function; artistic approval and the continuous parameter domain remain unverified.'})
}
if(failure)process.exitCode=1
