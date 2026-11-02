/** A standard textured GLB fixture through fitting, browser motion and native reopen. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { writeAssetUploadFixtures } from '../lib/asset-upload-fixtures.mjs'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT,startWeb,storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const out=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS||join(REPO_ROOT,'.deepblend/quality','imported-motion-ui-'+Date.now()))
if(existsSync(out))throw Error('Preserve existing evidence: '+out)
const workspace=join(out,'store'),sources=join(workspace,'sources'),id='imported-motion-ui',checks=[]
const seconds=Number(process.env.DEEPBLEND_MOTION_SECONDS||1)
if(!Number.isInteger(seconds)||seconds<1||seconds>10)throw Error('Choose a motion test duration from 1 through 10 seconds')
mkdirSync(sources,{recursive:true});writeAssetUploadFixtures(sources)
const main=join(sources,'glb','models','cup.glb'),texture=join(sources,'glb','textures','釉 色.png'),sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),sourceHashes=[sha(main),sha(texture)]
const path=(...parts)=>join(workspace,'projects',id,...parts),read=(...parts)=>JSON.parse(readFileSync(path(...parts),'utf8'))
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
const blender=process.env.DEEPBLEND_BLENDER_PATH||join(REPO_ROOT,'.tools/Blender.app/Contents/MacOS/Blender'),ctx=new Context()
ctx.plugin(LocalSubprocess);ctx.plugin(Provider,{blenderPath:blender,workspaceRoot:workspace,timeoutMs:180000});ctx.plugin(Studio,{workspaceRoot:workspace,projectsRoot:join(workspace,'projects'),reconcileOnStart:false})
await new Promise(r=>setTimeout(r,150))
let server,browser,page,failure,shutdown,setupStopped=false
try{
 const studio=ctx.get('blenderStudio'),spec=defaultSceneSpec({projectId:id,title:'Imported model motion'})
 await studio.createProject({projectId:id,title:'Imported model motion',sceneSpec:spec,renderPreview:false})
 const initial=sha(path('revisions','r0001','scene.blend'))
 await ctx.stop?.();setupStopped=true
 const rows=JSON.parse(await storePatch(workspace));rows.find(x=>x.id==='deepblend-blender-runtime').config.blenderPath=blender;rows.find(x=>x.id==='deepblend-blender-host').config.maxPreviewSamples=8
 server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows)});const base=`http://127.0.0.1:${server.port}`
 browser=await Browser.launch({args:['--window-size=1440,1000']});page=await browser.newPage()
 await page.addInitScript(`window.__motionRequests=[];window.__patches=[];window.__fitWrites=[];window.__fileSelections=[];document.addEventListener('input',e=>{if(e.target?.dataset?.field==='asset-bundle-directory')window.__fileSelections.push({trusted:e.isTrusted,files:Array.from(e.target.files||[]).map(f=>({path:f.webkitRelativePath,size:f.size}))})},true);const original=window.fetch;window.fetch=async(input,init)=>{if(init?.method==='POST'&&String(input).endsWith('/motion-previews'))window.__motionRequests.push(JSON.parse(init.body));if(init?.method==='POST'&&String(input).endsWith('/patch'))window.__patches.push(JSON.parse(init.body));if(init?.method==='POST'&&String(input).endsWith('/camera-fit'))window.__fitWrites.push(JSON.parse(init.body));return original(input,init)}`)
 await page.goto(base+'/deepblend/workbench');await page.waitFor(`document.querySelector('[data-lighttable-revision="r0001"]')!==null`,60000);await page.click('[data-view-tab="scene"]')
 await clickWorkbenchControl(page,'[data-action="assets-open"]');await page.waitFor(`document.querySelector('[data-asset-bundle-picker]')!==null`,60000)
 await page.send('Page.bringToFront');await page.waitFor('document.visibilityState === "visible"');await page.send('DOM.getDocument');await page.send('Page.setInterceptFileChooserDialog',{enabled:true})
 const opened=page._waitForEvent('Page.fileChooserOpened');let chooser
 try{check('the resource directory picker is opened by a real pointer',(await clickWorkbenchControl(page,'[data-field="asset-bundle-directory"]')).via==='pointer');chooser=await opened.promise}finally{opened.cancel()}
 const node=await page.send('DOM.resolveNode',{backendNodeId:chooser.backendNodeId})
 await page.send('DOM.setFileInputFiles',{objectId:node.object.objectId,files:[join(sources,'glb')]})
 await page.waitFor(`window.__fileSelections.length>0&&document.querySelector('[data-field="asset-bundle-entrypoint"]')!==null`,60000)
 const selection=await page.evaluate('window.__fileSelections[0]')
 check('native directory selection includes the model and its external texture',selection.trusted&&selection.files.some(f=>f.path==='glb/models/cup.glb')&&selection.files.some(f=>f.path==='glb/textures/釉 色.png'),selection)
 check('the user must choose an entrypoint before upload',await page.evaluate(`document.querySelector('[data-action="asset-bundle-upload"]').disabled`))
 const select='[data-field="asset-bundle-entrypoint"]',choices=await page.evaluate(`Array.from(document.querySelector(${JSON.stringify(select)}).options).map(o=>({value:o.value,label:o.label,disabled:o.disabled}))`)
 check('the directory offers one unambiguous model entrypoint',choices.filter(o=>o.value==='models/cup.glb'&&!o.disabled&&o.label.toLowerCase().startsWith('m')).length===1,choices)
 const tab=async()=>{for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,...(process.platform==='darwin'?{nativeVirtualKeyCode:48}:{}),text:'\t',unmodifiedText:'\t'})}
 for(let i=0;i<20&&!await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(select)})`);i++)await tab()
 check('native keyboard navigation reaches the model entrypoint',await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(select)})`))
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'m',code:'KeyM',windowsVirtualKeyCode:77,...(process.platform==='darwin'?{nativeVirtualKeyCode:46}:{}),text:'m',unmodifiedText:'m'})
 await page.waitFor(`document.querySelector(${JSON.stringify(select)})?.value==='models/cup.glb'`);await tab()
 check('the selected resource bundle is uploaded by a real pointer',(await clickWorkbenchControl(page,'[data-action="asset-bundle-upload"]')).via==='pointer')
 await page.waitFor(`document.querySelectorAll('[data-asset-id]').length===1&&!document.querySelector('[data-asset-bundle-progress]')`,60000)
 const inventoryResponse=await fetch(base+`/deepblend/projects/${id}/assets`),inventory=await inventoryResponse.json(),row=inventory.assets[0],assetId=row.asset.id
 const ledger=read('assets','manifest.json').assets.find(a=>a.assetId===assetId&&a.path===row.asset.path)
 check('the browser upload freezes the GLB and referenced texture without changing the scene',inventoryResponse.ok&&ledger?.bundle?.files.length===2&&ledger.bundle.files.every(f=>sha(join(sources,'glb',f.path))===sha(path('assets','bundles',ledger.bundle.sha256,f.path)))&&read('project.json').currentRevision==='r0001'&&sha(main)===sourceHashes[0]&&sha(texture)===sourceHashes[1])
 check('the uploaded model is inspected by a real pointer',(await clickWorkbenchControl(page,`[data-action="asset-preview:${assetId}"]`)).via==='pointer')
 await page.waitFor(`document.querySelector(${JSON.stringify(`[data-asset-id="${assetId}"] [data-asset-preview]`)})?.naturalWidth>0`,180000)
 await clickWorkbenchControl(page,`[data-action="asset-use:${assetId}"]`);await page.waitFor(`document.querySelector('[data-asset-draft="model"]')!==null`,60000)
 check('model placement defaults to preserving every existing object and subject',await page.evaluate(`document.querySelector('[data-field="asset-hide-existing"]').value===''&&!document.querySelector('[data-field="asset-make-subject"]').checked`))
 await page.fill('[data-field="asset-entity-id"]','imported-product')
 await page.evaluate(`(()=>{const e=document.querySelector('[data-field="asset-hide-existing"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'subject');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await clickWorkbenchControl(page,'[data-field="asset-make-subject"]')
 check('the explicitly chosen model placement is saved by pointer',(await clickWorkbenchControl(page,'[data-action="asset-apply"]')).via==='pointer')
 await page.waitFor(`document.querySelector('[data-compare="right"] img[data-artifact-revision="r0002"]')!==null`,240000)
 const placed=read('revisions','r0002','scene-spec.json'),patch=await page.evaluate('window.__patches[0].patch')
 check('only the chosen old object is hidden, the new subject is explicit and the original remains untouched',placed.entities.find(e=>e.id==='subject')?.visible===false&&placed.project.reviewSubjectId==='imported-product'&&sha(path('revisions','r0001','scene.blend'))===initial&&patch.operations.some(o=>o.op==='entity.visibility.set'&&o.entityId==='subject'&&o.visible===false)&&patch.operations.some(o=>o.op==='project.reviewSubject.set'&&o.entityId==='imported-product'))
 await page.click('[data-view-tab="scene"]');await clickWorkbenchControl(page,'[data-field="fit-frame"]');await page.fill('[data-field="fit-frame"]','1');await page.fill('[data-field="fit-marginPercent"]','10')
 check('the complete-view form selects the imported model rather than the hidden placeholder',await page.evaluate(`(()=>{const ids=Array.from(document.querySelectorAll('[data-field="fit-part"]:checked')).map(n=>n.dataset.entityId);return JSON.stringify(ids)===JSON.stringify(['imported-product'])&&!document.querySelector('[data-action="fit-save"]').disabled})()`))
 check('the fitted view is saved by a real pointer',(await clickWorkbenchControl(page,'[data-action="fit-save"]')).via==='pointer')
 await page.waitFor(`document.querySelector('[data-result-kind="camera-fit"]')!==null&&document.querySelector('[data-compare="current"] img')?.naturalWidth>0||document.querySelector('[data-camera-fit-error]')!==null`,240000)
 const fitError=await page.evaluate(`document.querySelector('[data-camera-fit-error]')?.innerText||null`);if(fitError)throw Error(fitError)
 const fit=await page.evaluate('window.__fitWrites[0]'),fittedId=fit.fittedCameraId
 const before=read('revisions','r0003','scene-spec.json'),source=path('revisions','r0003','scene.blend'),checkpoint=sha(source),order=before.cameras.map(c=>c.id)
 check('the fitted source has no target or focus distance and preserves the first-camera fallback',fit.baseRevision==='r0002'&&isDeepStrictEqual(fit.entityIds,['imported-product'])&&before.project.activeCamera===undefined&&before.cameras.find(c=>c.id===fittedId)?.focusDistance===undefined&&!before.cameras.find(c=>c.id===fittedId)?.targetPoint)
 await page.reload();await page.waitFor(`document.querySelector('[data-lighttable-revision="r0003"]')!==null`,60000);await page.click('[data-view-tab="jobs"]');await page.waitFor(`document.querySelector('[data-motion-editor]')!==null`,60000)
 await page.evaluate(`(()=>{const set=(field,value)=>{const el=document.querySelector('[data-field="'+field+'"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))};set('motion-camera',${JSON.stringify(fittedId)});set('motion-direction','backward')})()`)
 await page.fill('[data-field="motion-seconds"]',String(seconds));await page.fill('[data-field="motion-amount"]','3')
 if(seconds>2)await clickWorkbenchControl(page,'[data-field="motion-extend"]')
 const old='[data-field="motion-part"][data-entity-id="subject"]',model='[data-field="motion-part"][data-entity-id="imported-product"]'
 if(await page.evaluate(`document.querySelector(${JSON.stringify(old)})?.checked===true`))await clickWorkbenchControl(page,old)
 const alreadySelected=await page.evaluate(`document.querySelector(${JSON.stringify(model)})?.checked===true`)
 check('the imported model is selected as the complete subject',alreadySelected||(await clickWorkbenchControl(page,model)).via==='pointer')
 check('the chosen fitted camera and complete imported instance enable motion',await page.evaluate(`document.querySelector('[data-field="motion-camera"]').value===${JSON.stringify(fittedId)}&&document.querySelectorAll('[data-field="motion-part"]:checked').length===1&&!document.querySelector('[data-action="motion-preview"]').disabled`))
 check('motion preview is requested by a real pointer',(await clickWorkbenchControl(page,'[data-action="motion-preview"]')).via==='pointer')
 await page.waitFor(`document.querySelector('[data-motion-video]')||document.querySelector('[data-motion-error]')`,600000)
 const error=await page.evaluate(`document.querySelector('[data-motion-error]')?.innerText||null`);if(error)throw Error(error)
 try{await page.waitFor(`document.querySelector('[data-motion-video]')?.readyState>=2`,60000)}catch(cause){const player=await page.evaluate(`(()=>{const v=document.querySelector('[data-motion-video]');return {readyState:v?.readyState,networkState:v?.networkState,error:v?.error?{code:v.error.code,message:v.error.message}:null,src:v?.getAttribute('src'),currentSrc:v?.currentSrc}})()`);let status=null;try{status=(await fetch(new URL(player.src,base))).status}catch{};await page.screenshot(join(out,'playback-failure.png'));throw Error('Preview playback did not become ready: '+JSON.stringify({player,status,cause:String(cause)}))}
 const playback=await page.evaluate(`({duration:document.querySelector('[data-motion-video]').duration,src:document.querySelector('[data-motion-video]').getAttribute('src'),request:window.__motionRequests[0]})`)
 const response=await fetch(new URL(playback.src,base));if(!response.ok)throw Error('Preview download failed: '+response.status)
 writeFileSync(join(out,'imported-preview.mp4'),Buffer.from(await response.arrayBuffer()))
 check('the complete real preview uses only the imported instance',Math.abs(playback.duration-seconds)<.05&&isDeepStrictEqual(playback.request.entityIds,['imported-product'])&&playback.request.sourceCameraId===fittedId,playback)
 const probe=spawnSync('ffprobe',['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=width,height,r_frame_rate,nb_read_frames','-of','json',join(out,'imported-preview.mp4')],{encoding:'utf8',timeout:60000}),decoded=spawnSync('ffmpeg',['-v','error','-i',join(out,'imported-preview.mp4'),'-f','null','-'],{encoding:'utf8',timeout:60000})
 const video=probe.status===0?JSON.parse(probe.stdout).streams?.[0]:null
 check('independent tools verify the preview frame count, frame rate and complete decode',decoded.status===0&&video?.width===480&&video.height===270&&video.r_frame_rate==='24/1'&&Number(video.nb_read_frames)===seconds*24,video)
 const frame=join(out,'preview-middle.png'),grab=spawnSync('ffmpeg',['-v','error','-ss',String(seconds/2),'-i',join(out,'imported-preview.mp4'),'-frames:v','1',frame],{encoding:'utf8',timeout:60000});if(grab.status!==0)throw Error('Cannot extract the preview frame: '+grab.stderr)
 const pixels=decodePng(readFileSync(frame));let colored=0;for(let i=0;i<pixels.data.length;i+=4)if(pixels.data[i+2]>45&&pixels.data[i+2]>pixels.data[i]*1.3)colored++
 check('the fixture model is visibly colored rather than hidden inside the default cube',colored>1000,{coloredPixels:colored})
 check('preview retains the original source files and saved version',sha(source)===checkpoint&&read('project.json').currentRevision==='r0003'&&isDeepStrictEqual([sha(main),sha(texture)],sourceHashes))
 await page.screenshot(join(out,'preview.png'));check('explicit acceptance uses a real pointer',(await clickWorkbenchControl(page,'[data-action="motion-save"]')).via==='pointer')
 await page.waitFor(`document.querySelector('[data-motion-message]')||document.querySelector('[data-motion-error]')`,240000)
 const saveError=await page.evaluate(`document.querySelector('[data-motion-error]')?.innerText||null`);if(saveError)throw Error(saveError)
 const after=read('revisions','r0004','scene-spec.json'),manifest=read('revisions','r0004','revision-manifest.json'),audit=manifest.motionCandidateReceipt?.savedFrameAudit,saved=path('revisions','r0004','scene.blend')
 check('saved camera and frame audit preserve the implicit original camera order',after.project.activeCamera===undefined&&isDeepStrictEqual(after.cameras.map(c=>c.id),[...order,audit?.cameraId])&&audit?.frameCount===seconds*24&&isDeepStrictEqual(audit.entityIds,['imported-product'])&&isDeepStrictEqual(audit.assetInstanceIds,['imported-product'])&&audit.checkpointSha256===sha(saved))
 check('one saved revision keeps all imported scene entities and original resource files',read('project.json').currentRevision==='r0004'&&readdirSync(path('revisions')).length===4&&isDeepStrictEqual(before.entities,after.entities)&&sha(source)===checkpoint&&isDeepStrictEqual([sha(main),sha(texture)],sourceHashes))
 const inspect=join(out,'inspect.py'),native=join(out,'native.json');writeFileSync(inspect,`import bpy,json,sys\nfrom pathlib import Path\nblend,camera,out=sys.argv[sys.argv.index('--')+1:]\nbpy.ops.wm.open_mainfile(filepath=blend,load_ui=False,use_scripts=False)\nscene=bpy.context.scene\nobj=bpy.data.objects['db_camera__'+camera]\npositions=[]\nfor frame in [1,${seconds*24}]:\n scene.frame_set(frame);positions.append(list(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation))\nmeshes=[o for o in scene.objects if o.type=='MESH' and o.get('deepblend_id')=='imported-product']\nimages=[n.image for o in meshes for m in o.data.materials if m and m.use_nodes for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image]\nPath(out).write_text(json.dumps({'activeCamera':scene.camera.name if scene.camera else None,'positions':positions,'meshes':len(meshes),'uv':any(len(o.data.uv_layers)>0 for o in meshes),'packed':any(i.packed_file is not None for i in images)}))\n`)
 const nativeRun=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',inspect,'--',saved,audit.cameraId,native],{encoding:'utf8',timeout:120000});writeFileSync(join(out,'native.log'),(nativeRun.stdout||'')+(nativeRun.stderr||''));if(nativeRun.status!==0)throw Error('Native reopen failed: '+nativeRun.stderr)
 const facts=JSON.parse(readFileSync(native,'utf8'))
 check('independent Blender reopen retains the original camera, textured model and real motion',facts.activeCamera==='db_camera__camera-main'&&facts.meshes>0&&facts.uv&&facts.packed&&!isDeepStrictEqual(facts.positions[0],facts.positions[1]),facts)
}catch(error){failure=error;console.error(error.stack||String(error))}
finally{try{await browser?.close()}catch(error){failure??=error}try{shutdown=await server?.stop()}catch(error){failure??=error}if(!setupStopped)await ctx.stop?.();writeFileSync(join(out,'result.json'),JSON.stringify({passed:!failure,checks,shutdown,error:failure?String(failure):null},null,2)+'\n')}
if(failure)process.exitCode=1
else console.log(`Imported motion UI: ${checks.length}/${checks.length} checks passed; ${out}`)
