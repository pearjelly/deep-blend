/** Real browser → private Blender preview → explicitly accepted, recoverable revision. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS||join(REPO_ROOT,'.deepblend/quality','motion-preview-ui-'+Date.now()))
if(existsSync(output))throw Error('Preserve existing motion evidence: '+output)
mkdirSync(output,{recursive:true})
const storeRoot=join(output,'store'),id='motion-preview-ui',checks=[]
const seconds=Number(process.env.DEEPBLEND_MOTION_SECONDS||1)
if(!Number.isInteger(seconds)||seconds<1||seconds>10)throw Error('Choose a motion test duration from 1 through 10 seconds')
const file=(...parts)=>join(storeRoot,'projects',id,...parts),read=(...parts)=>JSON.parse(readFileSync(file(...parts),'utf8'))
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const check=(name,condition,detail)=>{checks.push({name,ok:Boolean(condition),detail});console.log(`[${condition?'PASS':'FAIL'}] ${name}`);if(!condition)throw Error(name)}
const json=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
let server,browser,page,failure,shutdown
try{
 const rows=JSON.parse(await storePatch(storeRoot));rows.find(x=>x.id==='deepblend-blender-runtime').config.blenderPath=process.env.DEEPBLEND_BLENDER_PATH||join(REPO_ROOT,'.tools/Blender.app/Contents/MacOS/Blender')
 server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows)});const base=`http://127.0.0.1:${server.port}`
 async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)}),p=await r.json();if(!r.ok||!p.ok)throw Error(JSON.stringify(p));return p}
 const list=await fetch(base+'/deepblend/recipes').then(r=>r.json()),recipe=list.recipes.find(x=>x.id==='deepblend.metal-lamp');check('real local lamp recipe is available',Boolean(recipe))
 await post('/deepblend/projects',{projectId:id,title:'相机运动验证',recipe:{id:recipe.id,version:recipe.version,digest:recipe.digest},renderPreview:false})
 const state=await fetch(base+`/deepblend/state?projectId=${id}`).then(r=>r.json()),ids=state.selected.recipeParameters.placement.memberEntityIds.slice().sort()
 check('the source identifies the complete 23-part lamp',ids.length===23)
 await post(`/deepblend/projects/${id}/camera-fit`,{baseRevision:'r0001',entityIds:ids,cameraId:'hero',fittedCameraId:'fitted-for-motion',frame:24,margin:.06,renderPreview:false,idempotencyKey:'motion-e2e-fit'})
 const original=hash(file('revisions','r0002','scene.blend')),before=read('revisions','r0002','scene-spec.json'),count=readdirSync(file('revisions')).length
 browser=await Browser.launch({args:['--window-size=1440,1000']});page=await browser.newPage()
 await page.addInitScript(`window.__motionWrites=JSON.parse(sessionStorage.getItem('motion-writes')||'[]');window.__previewReceipt=null;const original=window.fetch;window.fetch=async(input,init)=>{const save=init?.method==='POST'&&/\\/motion-previews\\/[^/]+\\/save$/.test(String(input));const preview=init?.method==='POST'&&String(input).endsWith('/motion-previews');if(preview){const response=await original(input,init);window.__previewReceipt=await response.clone().json();return response}if(!save)return original(input,init);const entry={url:String(input),body:JSON.parse(init.body)};window.__motionWrites.push(entry);sessionStorage.setItem('motion-writes',JSON.stringify(window.__motionWrites));const response=await original(input,init);entry.receipt=await response.clone().json();if(!sessionStorage.getItem('motion-reply-dropped')){sessionStorage.setItem('motion-reply-dropped','1');throw Error('Explicit fixture: reply lost after commit')};return response}`)
 await page.goto(base+'/deepblend/workbench');await page.waitFor(`document.querySelector('[data-lighttable-revision="r0002"]')!==null`,60000);await page.click('[data-view-tab="jobs"]');await page.waitFor(`document.querySelector('[data-motion-editor]')!==null`,60000)
 await page.evaluate(`(()=>{const e=document.querySelector('[data-field="motion-camera"]');e.value='fitted-for-motion';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
 await page.fill('[data-field="motion-seconds"]',String(seconds))
 if(seconds>2)await clickWorkbenchControl(page,'[data-field="motion-extend"]')
 await page.evaluate(`(()=>{const e=document.querySelector('[data-field="motion-seconds"]');e.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-action="motion-whole-lamp"]').click()})()`)
 check('the product selects all 23 members and enables preview',await page.evaluate(`document.querySelectorAll('[data-field="motion-part"]:checked').length===23&&!document.querySelector('[data-action="motion-preview"]').disabled`))
 check('preview is started with a real pointer',(await clickWorkbenchControl(page,'[data-action="motion-preview"]')).via==='pointer')
 await page.waitFor(`document.querySelector('[data-motion-video]')!==null||document.querySelector('[data-motion-error]')!==null`,600000)
 const err=await page.evaluate(`document.querySelector('[data-motion-error]')?.innerText||null`);if(err)throw Error(err)
 await page.waitFor(`document.querySelector('[data-motion-video]')?.readyState>=2`,60000)
 const playback=await page.evaluate(`(()=>{const v=document.querySelector('[data-motion-video]');return {duration:v.duration,width:v.videoWidth,height:v.videoHeight,ready:v.readyState}})()`)
 check('the real browser decodes the complete requested preview',Math.abs(playback.duration-seconds)<.05&&playback.width===480&&playback.height>0,playback)
 const audit=await page.evaluate(`window.__previewReceipt?.preview?.frameAudit`)
 check('the preview reports and displays complete native frame audits',audit?.frameCount===seconds*24&&audit.frameEnd-audit.frameStart+1===seconds*24&&audit.scope==='evaluated-mesh-vertices'&&audit.savedAuditSupported===true&&await page.evaluate(`!!document.querySelector('[data-motion-full-frame-check]')&&!!document.querySelector('[data-motion-saved-frame-check]')`),audit)
 check('preview leaves the saved source and revision count untouched',hash(file('revisions','r0002','scene.blend'))===original&&readdirSync(file('revisions')).length===count)
 await page.screenshot(join(output,'preview.png'))
 check('acceptance is submitted with a real pointer',(await clickWorkbenchControl(page,'[data-action="motion-save"]')).via==='pointer')
 await page.waitFor(`sessionStorage.getItem('motion-reply-dropped')==='1'&&document.querySelector('[data-motion-error]')!==null`,240000)
 check('the lost reply still publishes exactly one revision',read('project.json').currentRevision==='r0003'&&readdirSync(file('revisions')).length===count+1)
 await page.reload();await page.waitFor(`document.querySelector('[data-lighttable-revision="r0003"]')!==null`,60000);await page.click('[data-view-tab="jobs"]');await page.waitFor(`document.querySelector('[data-action="motion-save"]')&&!document.querySelector('[data-action="motion-save"]').disabled`,60000)
 await new Promise(r=>setTimeout(r,1500));check('recovery is submitted by pointer',(await clickWorkbenchControl(page,'[data-action="motion-save"]')).via==='pointer')
 await page.waitFor(`window.__motionWrites.length===2&&document.querySelector('[data-motion-message]')!==null`,60000)
 const writes=await page.evaluate('window.__motionWrites');json('browser-writes.json',writes)
 check('recovery replays the same candidate and confirms the same saved revision',isDeepStrictEqual(writes[0].body,writes[1].body)&&writes[0].url===writes[1].url&&writes[1].receipt.saved.revision==='r0003'&&writes[1].receipt.saved.idempotentReplay===true&&readdirSync(file('revisions')).length===count+1,writes)
 const after=read('revisions','r0003','scene-spec.json'),camera=writes[1].receipt.saved.cameraId
 const motionReceipt=read('revisions','r0003','revision-manifest.json').motionCandidateReceipt,savedAudit=motionReceipt?.savedFrameAudit
 check('the saved revision binds full-frame audits to both preview and recompiled checkpoint',isDeepStrictEqual(motionReceipt?.previewFrameAudit,audit)&&savedAudit?.frameCount===seconds*24&&savedAudit?.checkpointSha256===hash(file('revisions','r0003','scene.blend'))&&savedAudit?.cameraId===camera&&isDeepStrictEqual(savedAudit?.entityIds,ids)&&isDeepStrictEqual(savedAudit?.assetInstanceIds,audit.assetInstanceIds)&&isDeepStrictEqual(savedAudit?.resolution,audit.resolution)&&isDeepStrictEqual(savedAudit?.pixelAspect,audit.pixelAspect),savedAudit)
 check('the original checkpoint and product entities remain unchanged',hash(file('revisions','r0002','scene.blend'))===original&&isDeepStrictEqual(before.entities,after.entities))
 check('the accepted revision adds one camera with three movement tracks',after.cameras.some(c=>c.id===camera)&&after.animationTracks.filter(t=>t.targetKind==='camera'&&t.targetEntityId===camera).length===3)
 await page.screenshot(join(output,'saved.png'))
}catch(error){failure=error;console.error(error.stack||String(error))}
finally{
 try{await browser?.close()}catch(error){failure??=error}
 try{shutdown=await server?.stop()}catch(error){failure??=error}
 json('result.json',{passed:!failure,checks,shutdown,error:failure?String(failure):null})
}
if(failure)process.exitCode=1
else console.log(`Motion preview UI acceptance: ${checks.length}/${checks.length} checks passed`)
