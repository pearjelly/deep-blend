#!/usr/bin/env node
/** Real gallery selection, native UV defaults and immutable historical recipe projects. */
import {existsSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,copyFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {isDeepStrictEqual} from 'node:util'
import {decodePng,compileSceneSpec} from '@deepblend/dsh-blender-contracts'
import {Browser} from '../../tools/browser-driver.mjs'
import {REPO_ROOT,startWeb,storePatch} from '../../tools/dsh-web-harness.mjs'
const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS||join(REPO_ROOT,'.deepblend','quality',`recipe-version-ui-${new Date().toISOString().replace(/[:.]/g,'-')}`))
if(existsSync(output))throw Error(`Evidence directory already exists: ${output}`)
mkdirSync(output,{recursive:true})
const root=join(output,'store'),external=join(output,'recipes'),oldFolder=join(external,'historical')
cpSync(join(REPO_ROOT,'deepblend/tests/fixtures/metal-lamp-v1'),oldFolder,{recursive:true})
const checks=[],sha=b=>createHash('sha256').update(b).digest('hex')
const json=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
const check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)}
const path=(id,...parts)=>join(root,'projects',id,...parts)
const read=(id,...parts)=>JSON.parse(readFileSync(path(id,...parts)))
const choice=version=>`[data-action="select-recipe:deepblend.metal-lamp@${version}"]`
const field=id=>`[data-field="recipe-${id}"]`
let server,browser,page,failure,shutdown,original
try{
  const blenderPath=process.env.DEEPBLEND_BLENDER_PATH??join(REPO_ROOT,'.tools','Blender.app','Contents','MacOS','Blender')
  const rows=JSON.parse(await storePatch(root));rows.find(x=>x.id==='deepblend-blender-runtime').config.blenderPath=blenderPath
  const host=rows.find(x=>x.id==='deepblend-blender-host').config;host.maxPreviewSamples=8;host.recipeDirectories=[external]
  server=await startWeb({workspacePath:REPO_ROOT,patch:JSON.stringify(rows),keepHome:false})
  const base=`http://127.0.0.1:${server.port}`
  const list=await(await fetch(`${base}/deepblend/recipes`)).json()
  const recipes=list.recipes
  check('the actual Host lists both lamp versions without a duplicate conflict',recipes?.filter(r=>r.id==='deepblend.metal-lamp').length===2,{list})
  for(const version of ['1.0.0','2.0.0']){
    const item=recipes.find(r=>r.id==='deepblend.metal-lamp'&&r.version===version)
    const response=await fetch(base+item.previewUrl),bytes=Buffer.from(await response.arrayBuffer())
    const expected=readFileSync(join(version==='1.0.0'?oldFolder:join(REPO_ROOT,'deepblend/recipes/metal-lamp'),'preview.png'))
    check(`v${version} preview response preserves that package's exact bytes`,response.ok&&bytes.equals(expected))
  }
  browser=await Browser.launch({args:['--window-size=1440,1100']});page=await browser.newPage()
  await page.addInitScript(`window.__recipeWrites=[];const original=window.fetch;window.fetch=(input,init)=>{if(init?.method==='POST')window.__recipeWrites.push({url:String(input),body:JSON.parse(init.body)});return original(input,init)}`)
  await page.goto(`${base}/deepblend/workbench`);await page.waitFor(`document.querySelector(${JSON.stringify(choice('2.0.0'))})!==null`,45000)
  check('the real gallery offers separately selectable v1 and v2',await page.count(choice('1.0.0'))===1&&await page.count(choice('2.0.0'))===1)
  check('v2 is selected by a real pointer',(await page.click(choice('2.0.0'))).via==='pointer')
  await page.waitFor(`document.querySelector(${JSON.stringify(field('spun-roughness'))})!==null`)
  check('new default controls preserve the two authored finishes',await page.evaluate(`document.querySelector(${JSON.stringify(field('spun-roughness'))}).value==='0.28'&&document.querySelector(${JSON.stringify(field('brushed-roughness'))}).value==='0.39'&&document.querySelector(${JSON.stringify(field('surface-roughness'))})===null`))
  await page.fill('[data-field="project-title"]','gallery-v2')
  await page.waitFor('Array.from(document.querySelectorAll("[data-recipe] img")).every(img=>img.complete&&img.naturalWidth>0)')
  await page.evaluate(`document.querySelector(${JSON.stringify(field('spun-roughness'))}).scrollIntoView({block:'center'})`)
  await page.screenshot(join(output,'01-v2-gallery.png'))
  await page.click('[data-action="create-project"]')
  await page.waitFor('document.querySelector("[data-view=preview] img[data-artifact]")?.src.includes("/gallery-v2/")===true',180000)
  const current=read('gallery-v2','revisions','r0001','scene-spec.json'),expected=compileSceneSpec(JSON.parse(readFileSync(join(REPO_ROOT,'deepblend/recipes/metal-lamp/scene-spec.json')))).spec
  expected.project={...expected.project,id:'gallery-v2',title:'gallery-v2'}
  check('default browser creation saves the complete authored v2 scene',isDeepStrictEqual(current,expected))
  const manifest=read('gallery-v2','revisions','r0001','revision-manifest.json'),lock=read('gallery-v2','revisions','r0001',manifest.recipe.lockPath)
  check('v2 lock records exact source, capability, defaults and selected package',lock.version==='2.0.0'&&lock.values['spun-roughness']===.28&&lock.values['brushed-roughness']===.39&&lock.manifest.compatibility.capabilities.includes('material.procedural.uv')&&sha(lock.sceneSource)===lock.inputSha256)
  const preview=manifest.previews.at(-1)
  check('native gallery preview records the real reduced sample budget',preview.samples===8&&preview.width===expected.renderProfiles.preview.resolution[0]&&preview.height===expected.renderProfiles.preview.resolution[1]&&Boolean(preview.renderConfig))
  check('native gallery preview contains decoded image pixels',decodePng(readFileSync(path('gallery-v2',preview.path))).data.length===preview.width*preview.height*4)
  copyFileSync(path('gallery-v2',preview.path),join(output,'v2-native-preview.png'))
  const script=join(output,'readback.py'),receipt=join(output,'native-readback.json')
  writeFileSync(script,`import bpy,json\nbpy.ops.wm.open_mainfile(filepath=${JSON.stringify(path('gallery-v2','revisions','r0001','scene.blend'))})\nm=next(o for o in bpy.data.objects if o.get('deepblend_id')=='shade-shell').active_material\nn=m.node_tree.nodes\nu=next(x for x in n if x.bl_idname=='ShaderNodeUVMap')\np=next(x for x in n if x.bl_idname=='ShaderNodeMapping')\nb=next(x for x in n if x.bl_idname=='ShaderNodeBump')\nr=next(x for x in n if x.bl_idname=='ShaderNodeBsdfPrincipled').inputs['Roughness'].default_value\njson.dump({'uvMap':u.uv_map,'mapping':list(p.inputs['Scale'].default_value),'bump':b.inputs['Strength'].default_value,'roughness':r,'linked':any(l.from_node==u and l.to_node==p for l in m.node_tree.links)},open(${JSON.stringify(receipt)},'w'))\n`)
  writeFileSync(join(output,'native-readback.log'),execFileSync(blenderPath,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',script],{timeout:90000,maxBuffer:8*1024*1024}))
  const native=JSON.parse(readFileSync(receipt))
  check('independent Blender opening confirms real v2 UV grain and spun roughness',native.uvMap==='UVMap'&&native.linked&&native.mapping.every((v,i)=>Math.abs(v-[.0001,800,1][i])<1e-7)&&Math.abs(native.bump-.006)<1e-7&&Math.abs(native.roughness-.28)<1e-7,native)
  await page.click('[data-view-tab="projects"]');await page.click(choice('1.0.0'))
  await page.waitFor(`document.querySelector(${JSON.stringify(field('surface-roughness'))})!==null`)
  check('historical version retains its original coupled roughness control',await page.evaluate(`document.querySelector(${JSON.stringify(field('surface-roughness'))}).value==='0.39'&&document.querySelector(${JSON.stringify(field('spun-roughness'))})===null`))
  await page.fill(field('surface-roughness'),'.45');await page.fill('[data-field="project-title"]','gallery-v1')
  await page.click('[data-action="create-project"]');await page.waitFor('document.querySelector("[data-view=preview] img[data-artifact]")?.src.includes("/gallery-v1/")===true',180000)
  const oldManifest=read('gallery-v1','revisions','r0001','revision-manifest.json'),oldLock=read('gallery-v1','revisions','r0001',oldManifest.recipe.lockPath),oldSpec=read('gallery-v1','revisions','r0001','scene-spec.json')
  check('historical browser creation pins v1 and changes both original roughness targets',oldLock.version==='1.0.0'&&oldLock.values['surface-roughness']===.45&&['champagne-spun','champagne-brushed'].every(id=>oldSpec.materials.find(m=>m.id===id).parameters.roughness===.45)&&oldSpec.materials.find(m=>m.id==='champagne-spun').texture.coordinates===undefined)
  original=Object.fromEntries(['revisions/r0001/scene-spec.json','revisions/r0001/scene.blend',`revisions/r0001/${oldManifest.recipe.lockPath}`,oldManifest.previews.at(-1).path].map(file=>[file,sha(readFileSync(path('gallery-v1',file)))]))
  await page.click('[data-view-tab="projects"]');await page.click(choice('1.0.0'));rmSync(oldFolder,{recursive:true})
  await page.click('[data-action="reload"]');await page.waitFor(`document.querySelector(${JSON.stringify(choice('1.0.0'))})===null`)
  check('removing v1 disables its stale form instead of selecting v2',await page.evaluate(`document.querySelector('[data-action="create-project"]').disabled&&document.querySelector(${JSON.stringify(field('surface-roughness'))})!==null&&document.querySelector(${JSON.stringify(field('spun-roughness'))})===null`))
  const writes=await page.evaluate('window.__recipeWrites');json('requests.json',writes)
  check('the browser submits exactly two explicit versions with their complete parameter sets',writes.length===2&&writes[0].body.recipe.version==='2.0.0'&&writes[1].body.recipe.version==='1.0.0'&&Object.keys(writes[0].body.recipe.parameters).sort().join(',')==='brushed-roughness,exposure,main-color,spun-roughness')
  await page.screenshot(join(output,'02-stale-v1.png'))
  await page.click(choice('2.0.0'));await page.waitFor(`document.querySelector(${JSON.stringify(field('spun-roughness'))})!==null`)
  check('explicit selection of v2 resets to its own defaults and enables creation',await page.evaluate(`!document.querySelector('[data-action="create-project"]').disabled&&document.querySelector(${JSON.stringify(field('spun-roughness'))}).value==='0.28'`))
  check('removing the package preserves the old source, lock, checkpoint and preview bytes',Object.entries(original).every(([file,digest])=>sha(readFileSync(path('gallery-v1',file)))===digest))
  await page.reload();await page.waitFor(`document.querySelector(${JSON.stringify(choice('2.0.0'))})!==null`,45000)
  check('reload keeps the historical project while offering only the available lamp version',await page.count('[data-project="gallery-v1"]')===1&&await page.count(choice('1.0.0'))===0&&await page.count(choice('2.0.0'))===1)
  json('locks.json',{v1:oldLock,v2:lock});json('previews.json',{v1:oldManifest.previews.at(-1),v2:preview})
}catch(error){failure=error.stack||String(error);checks.push({name:'workflow completes without unexpected failure',ok:false,detail:failure});console.error(error);await page?.screenshot(join(output,'failure.png')).catch(()=>{})}
finally{
  for(const [name,close]of[['browser',()=>browser?.close()],['server',()=>server?.stop()]]){try{const result=await close();if(name==='server')shutdown=result}catch(error){failure??=String(error)}}
  json('report.json',{status:failure?'failed':'passed',checks,failure,shutdown,original,scope:'Actual browser, Host and Blender; distinct recipe versions, authored UV defaults, recorded preview budget, stale selection and immutable historical artifacts. External artwork review remains open.'})
}
console.log(`Recipe versions: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed; ${output}`)
if(failure)process.exitCode=1
