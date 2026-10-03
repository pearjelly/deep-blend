#!/usr/bin/env node
/** Native material editor: real draft, refusal/recovery, checkpoint and changed pixels. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {isDeepStrictEqual} from 'node:util'
import {decodePng} from '@deepblend/dsh-blender-contracts'
import {Browser} from '../../tools/browser-driver.mjs'
import {REPO_ROOT,startWeb,storePatch} from '../../tools/dsh-web-harness.mjs'
const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS||join(REPO_ROOT,'.deepblend','quality',`material-texture-ui-${new Date().toISOString().replace(/[:.]/g,'-')}`))
if(existsSync(output))throw Error(`Evidence directory already exists: ${output}`)
mkdirSync(output,{recursive:true})
const root=join(output,'store'),projectId='surface-grain',checks=[]
const path=(...parts)=>join(root,'projects',projectId,...parts)
const read=(...parts)=>JSON.parse(readFileSync(path(...parts)))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const field=key=>`[data-field="editor-texture-${key}"]`
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}${detail?` — ${JSON.stringify(detail)}`:''}`);if(!ok)throw Error(name)}
const json=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
let server,browser,page,failure,shutdown,original
try{
  const blenderPath=process.env.DEEPBLEND_BLENDER_PATH??join(REPO_ROOT,'.tools','Blender.app','Contents','MacOS','Blender')
  // Keep the historical Object material as the switch-to-UV fixture when gallery defaults evolve.
  const sceneSpec=JSON.parse(readFileSync(join(REPO_ROOT,'deepblend/tests/fixtures/metal-lamp-v1/scene-spec.json')))
  sceneSpec.renderProfiles.preview.resolution=[320,240];sceneSpec.renderProfiles.preview.samples=16
  const rows=JSON.parse(await storePatch(root));rows.find(x=>x.id==='deepblend-blender-runtime').config.blenderPath=blenderPath
  rows.find(x=>x.id==='deepblend-blender-host').config.maxPreviewSamples=16
  server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows),keepHome:false})
  const base=`http://127.0.0.1:${server.port}`,url=`${base}/deepblend/workbench`
  const created=await fetch(`${base}/deepblend/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId,title:'Surface grain',sceneSpec,renderPreview:true}),signal:AbortSignal.timeout(180000)})
  if(!created.ok)throw Error(`Create ${created.status}: ${await created.text()}`)
  const before=read('revisions','r0001','scene-spec.json'),beforePreview=read('revisions','r0001','revision-manifest.json').previews.at(-1)
  original=Object.fromEntries(['revisions/r0001/scene-spec.json','revisions/r0001/scene.blend',beforePreview.path].map(file=>[file,sha(readFileSync(path(file)))]))
  copyFileSync(path(beforePreview.path),join(output,'before.png'))
  browser=await Browser.launch({args:['--window-size=1440,1100']});page=await browser.newPage()
  await page.addInitScript(`window.__surfaceWrites=[];const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method==='POST')window.__surfaceWrites.push({url:String(input),body:JSON.parse(init.body)});return originalFetch(input,init)}`)
  await page.goto(url);await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null',45000)
  const selectEntity=async()=>{await page.click('[data-view-tab="scene"]');await page.waitFor(`document.querySelector(${JSON.stringify('[data-action="select-entity:shade-shell"]')})!==null`,30000);await page.click('[data-action="select-entity:shade-shell"]');await page.waitFor(`document.querySelector(${JSON.stringify(field('type'))})!==null`,30000)}
  const select=async(key,value)=>page.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(field(key))});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  const captureSurface=async(name)=>{
    await page.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(field('coordinates'))});input.focus();input.scrollIntoView({block:'center'})})()`)
    await page.waitFor(`(()=>{const r=document.querySelector(${JSON.stringify(field('coordinates'))}).getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`)
    await page.screenshot(join(output,name))
  }
  const fill=async(key,value)=>{await page.fill(field(key),String(value));await page.waitFor(`document.querySelector(${JSON.stringify(field(key))}).value===${JSON.stringify(String(value))}`)}
  await selectEntity()
  check('existing object texture displays without creating a draft change',await page.evaluate(`document.querySelector(${JSON.stringify(field('coordinates'))}).value==='object' && document.querySelector('[data-scene-editor]').dataset.editorDirty==='false'`))
  await select('coordinates','uv');await fill('uvMap','missing-surface-map')
  await fill('scale',1);await fill('stretch-x',.0001);await fill('stretch-y',800);await fill('stretch-z',1);await fill('bump',.006)
  check('surface controls create a local draft without posting',await page.evaluate('window.__surfaceWrites.length===0 && document.querySelector("[data-scene-editor]").dataset.editorDirty==="true"'))
  const clicked=await page.click('[data-action="editor-apply"]');check('the texture transaction is submitted by a real pointer',clicked.via==='pointer')
  await page.waitFor('document.body.textContent.includes("SCENE_VALIDATION_FAILED")',180000)
  check('missing native UV map retains current revision and the complete editable draft',read('project.json').currentRevision==='r0001' && await page.evaluate(`document.querySelector(${JSON.stringify(field('uvMap'))}).value==='missing-surface-map' && document.querySelector(${JSON.stringify(field('stretch-y'))}).value==='800' && !document.querySelector('[data-action="editor-apply"]').disabled`))
  check('a refused texture edit publishes no new revision',!existsSync(path('revisions','r0002','scene-spec.json')))
  await fill('uvMap','UVMap');await captureSurface('01-surface-draft.png')
  await page.click('[data-action="editor-apply"]');await page.waitFor('document.querySelector("[data-compare=right] img[data-artifact-revision=r0002]")!==null',180000)
  const writes=await page.evaluate('window.__surfaceWrites'),patch=writes.at(-1).body.patch
  json('requests.json',writes)
  check('correction retries one pinned checkpoint and preview against the original revision',writes.length===2 && patch.baseRevision==='r0001' && patch.saveCheckpoint===true && patch.renderPreview===true)
  check('local surface edit copies material and rebinds only the selected entity',isDeepStrictEqual(patch.operations.map(x=>x.op),['material.add','entity.material.set']) && patch.operations[1].entityId==='shade-shell')
  const after=read('revisions','r0002','scene-spec.json'),entity=after.entities.find(e=>e.id==='shade-shell'),material=after.materials.find(m=>m.id===entity.materialId)
  const originalMaterial=before.materials.find(m=>m.id==='champagne-spun'),expected={...originalMaterial.texture,coordinates:'uv',uvMap:'UVMap',scale:1,stretch:[.0001,800,1],bump:.006}
  check('saved surface definition retains all unedited texture and shader fields',isDeepStrictEqual(material,{...originalMaterial,id:material.id,texture:expected}))
  check('original shared materials and unrelated entities remain identical',before.materials.every(m=>isDeepStrictEqual(after.materials.find(x=>x.id===m.id),m)) && before.entities.every(e=>isDeepStrictEqual(after.entities.find(x=>x.id===e.id),e.id==='shade-shell'?{...e,materialId:material.id}:e)))
  check('geometry, lights and cameras keep their authored values',isDeepStrictEqual(after.lights,before.lights)&&isDeepStrictEqual(after.cameras,before.cameras)&&isDeepStrictEqual(entity.generator,before.entities.find(e=>e.id===entity.id).generator))
  const afterPreview=read('revisions','r0002','revision-manifest.json').previews.at(-1)
  check('comparison has identical measured render settings',isDeepStrictEqual(beforePreview.renderConfig,afterPreview.renderConfig)&&['cameraId','frame','width','height','samples','engine'].every(k=>beforePreview[k]===afterPreview[k])&&afterPreview.width===320&&afterPreview.height===240&&afterPreview.samples===16)
  copyFileSync(path(afterPreview.path),join(output,'after.png'))
  const a=decodePng(readFileSync(path(beforePreview.path))),b=decodePng(readFileSync(path(afterPreview.path)))
  let changed=0;for(let i=0;i<a.data.length;i+=4)if([0,1,2].some(c=>a.data[i+c]!==b.data[i+c]))changed++
  check('surface controls change actual Blender pixels',changed>0,{changedPixels:changed,beforePixels:sha(a.data),afterPixels:sha(b.data)})
  const script=join(output,'readback.py'),receipt=join(output,'native-readback.json')
  writeFileSync(script,`import bpy,json\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path('revisions','r0002','scene.blend'))})\nm=next(o for o in bpy.data.objects if o.get('deepblend_id')=='shade-shell').active_material\nn=m.node_tree.nodes\nuv=next(x for x in n if x.bl_idname=='ShaderNodeUVMap')\nmp=next(x for x in n if x.bl_idname=='ShaderNodeMapping')\nbump=next(x for x in n if x.bl_idname=='ShaderNodeBump')\njson.dump({'materialId':m.get('deepblend_id'),'uvMap':uv.uv_map,'mapping':list(mp.inputs['Scale'].default_value),'bump':bump.inputs['Strength'].default_value,'linked':any(l.from_node==uv and l.to_node==mp for l in m.node_tree.links)},open(${JSON.stringify(receipt)},'w'))\n`)
  writeFileSync(join(output,'native-readback.log'),execFileSync(blenderPath,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',script],{timeout:90000,maxBuffer:8*1024*1024}))
  const native=JSON.parse(readFileSync(receipt))
  check('independent Blender reopening finds the real UV graph, mapping and bump',native.materialId===material.id&&native.uvMap==='UVMap'&&native.linked&&native.mapping.every((v,i)=>Math.abs(v-[.0001,800,1][i])<1e-7)&&Math.abs(native.bump-.006)<1e-7,native)
  const pixelScript=join(output,'pixels.py'),pixelReceipt=join(output,'native-pixels.json')
  writeFileSync(pixelScript,`import bpy,json\ndef pixels(label):\n    bpy.context.scene.cycles.device='CPU'\n    bpy.context.scene.cycles.seed=0\n    file=${JSON.stringify(output)}+'/'+label+'.png'\n    bpy.context.scene.render.filepath=file\n    bpy.ops.render.render(write_still=True)\n    image=bpy.data.images.load(file,check_existing=False)\n    result=list(image.pixels[:])\n    bpy.data.images.remove(image)\n    return result\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path('revisions','r0001','scene.blend'))})\na=pixels('native-before')\ncontrol=pixels('native-control')\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path('revisions','r0002','scene.blend'))})\nb=pixels('native-after')\njson.dump({'controlIdentical':a==control,'changedPixels':sum(any(a[i+c]!=b[i+c]for c in range(3))for i in range(0,len(a),4))},open(${JSON.stringify(pixelReceipt)},'w'))\n`)
  writeFileSync(join(output,'native-pixels.log'),execFileSync(blenderPath,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',pixelScript],{timeout:90000,maxBuffer:8*1024*1024}))
  const pixels=JSON.parse(readFileSync(pixelReceipt))
  check('independent CPU renders reproduce the control and retain the texture pixel contribution',pixels.controlIdentical&&pixels.changedPixels>0,pixels)
  await page.reload();await page.waitFor('document.querySelector("[data-brief-base-revision=r0002]")!==null',45000);await selectEntity()
  check('refresh restores saved surface controls as a clean draft',await page.evaluate(`document.querySelector(${JSON.stringify(field('coordinates'))}).value==='uv' && document.querySelector(${JSON.stringify(field('uvMap'))}).value==='UVMap' && document.querySelector(${JSON.stringify(field('bump'))}).value==='0.006' && document.querySelector('[data-scene-editor]').dataset.editorDirty==='false' && window.__surfaceWrites.length===0`))
  await captureSurface('02-saved-surface.png')
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await page.evaluate(`document.querySelector(${JSON.stringify(field('coordinates'))}).scrollIntoView({block:'center'})`)
  check('surface controls remain inside the narrow screen',await page.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(field('coordinates'))}),r=input.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`))
  await page.screenshot(join(output,'03-narrow-surface.png'))
  check('old SceneSpec, native checkpoint and preview remain byte-identical',Object.entries(original).every(([file,digest])=>sha(readFileSync(path(file)))===digest))
  check('the workflow makes no hidden review or model request',writes.every(x=>x.url.endsWith('/patch')) && (read('revisions','r0002','revision-manifest.json').reviews||[]).length===0)
}catch(error){failure=error.stack||String(error);checks.push({name:'workflow completes without unexpected failure',ok:false,detail:failure});console.error(error);await page?.screenshot(join(output,'failure.png')).catch(()=>{})}
finally{
  for(const [name,close]of[['browser',()=>browser?.close()],['server',()=>server?.stop()]]){try{const result=await close();if(name==='server')shutdown=result}catch(error){failure??=String(error)}}
  json('report.json',{status:failure?'failed':'passed',checks,failure,shutdown,original,scope:'Real browser, Host and Blender; texture draft/refusal/recovery, saved native graph and equal-setting pixel change. No external artistic approval.'})
}
console.log(`Material surface editor: ${checks.filter(x=>x.ok).length}/${checks.length} checks passed; ${output}`)
if(failure)process.exitCode=1
