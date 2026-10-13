import {Context} from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '../../../packages/deepblend/provider-local/lib/index.js'
import Studio, {StudioConfig} from '../../../packages/deepblend/host/lib/index.js'
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=resolve(import.meta.dirname,'../../..')
const output=resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(root,'.deepblend/quality','lamp-dimensions-'+Date.now())),nativeRoot=output
if(existsSync(output))throw Error('Evidence exists');mkdirSync(output,{recursive:true})
const blender=process.env.DEEPBLEND_BLENDER_PATH || join(root,'.tools/Blender.app/Contents/MacOS/Blender')
const json=(n,v)=>writeFileSync(join(output,n),JSON.stringify(v,null,2)+'\n'),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const ctx=new Context();ctx.plugin(LocalSubprocess);ctx.plugin(Provider,{blenderPath:blender,bootstrapPath:join(root,'packages/deepblend/provider-local/python/bootstrap.py'),workspaceRoot:nativeRoot,timeoutMs:300000})
const checks=[],check=(name,ok,detail)=>{checks.push({name,ok,detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);if(!ok)throw Error(name)};let failure,studio
const inspectScript=join(root,'deepblend/tests/lib/inspect-native-lamp.py')
function inspect(checkpoint,label){
 const name=label+'-geometry.json',r=spawnSync(blender,['--background','--factory-startup','--python-exit-code','1','--python',inspectScript,'--',checkpoint,join(output,name)],{encoding:'utf8',timeout:120000})
 writeFileSync(join(output,name+'.log'),(r.stdout??'')+(r.stderr??''));check(label+' independent native reopening',r.status===0)
 const geometry=JSON.parse(readFileSync(join(output,name)));return {geometry,normal:{samples:geometry.normalWallSamples}}
}

try{
 await new Promise(r=>setTimeout(r,100));check('actual source provider is active',Boolean(ctx.get('blenderRuntime')))
 studio=new Studio(ctx,StudioConfig({workspaceRoot:nativeRoot,projectsRoot:join(nativeRoot,'store'),reconcileOnStart:false,maxPreviewSamples:64}))
 const recipe=studio.listRecipes().recipes.find(r=>r.id==='deepblend.metal-lamp');check('actual shipped Host catalog exposes lamp2.1',recipe?.version==='2.1.0')
 let baseline,target,original
 for(const diameter of [209.8,180,230,250]){
  const id='lamp-'+String(diameter).replace('.','-'),made=await studio.createProject({projectId:id,title:'Native lamp '+diameter,recipe:{id:recipe.id,version:recipe.version,digest:recipe.digest,parameters:{'shade-diameter-mm':diameter}},saveCheckpoint:true,renderPreview:false})
  const revision=studio.store.readRecord(id).currentRevision;json(id+'-create-receipt.json',{newCreation:made,observedRevision:revision,reusedOriginalDefault:made===null});const rev=studio.store.revisionDirectory(id,revision),checkpoint=join(rev,'scene.blend'),facts=inspect(checkpoint,id)
  check(id+' whole product fits the native hero camera',facts.geometry.projectedBounds[0][2]>0&&[0,1].every(axis=>facts.geometry.projectedBounds[0][axis]>=.01&&facts.geometry.projectedBounds[1][axis]<=.99))
  check(id+' actual shade diameter and unit scale',facts.geometry.parts['shade-shell'].dimensionsMm.slice(0,2).every(x=>Math.abs(x-diameter)<.03)&&facts.geometry.parts['shade-shell'].scale.every(x=>x===1))
  check(id+' shell and liner closed connected positive', ['shade-shell','shade-enamel-lining'].every(part=>facts.geometry.parts[part].components===1&&facts.geometry.parts[part].nonManifoldEdges===0&&facts.geometry.parts[part].signedVolume>0))
  if(!baseline)baseline=facts
  check(id+' normal wall and liner gap samples remain close to actual baseline',facts.normal.samples.every((s,i)=>Math.abs(s.normalWallThicknessMm-baseline.normal.samples[i].normalWallThicknessMm)<.03&&s.normalShellLinerGapMm!==null&&Math.abs(s.normalShellLinerGapMm-baseline.normal.samples[i].normalShellLinerGapMm)<.01))
  check(id+' neck arm bulb hinge actual bounds preserved',['shade-neck-collar','shade-neck-rim','swept-upper-arm','opal-bulb','hinge-body'].every(part=>JSON.stringify(facts.geometry.parts[part].worldBounds)===JSON.stringify(baseline.geometry.parts[part].worldBounds)))
  const controls=await studio.getRecipeParameters(id);check(id+' Host control reports actual saved value',controls.available&&controls.parameters.find(p=>p.id==='shade-diameter-mm')?.value===diameter)
  if(diameter===230){target={id,revision,rev,checkpoint};original=Object.fromEntries(['scene.blend','scene-spec.json','recipe-lock.json'].map(n=>[join(rev,n),hash(join(rev,n))]));json('target.json',target)}
 }
 const changed=await studio.updateRecipeParameters({projectId:target.id,baseRevision:target.revision,parameters:{'shade-diameter-mm':220},saveCheckpoint:true,renderPreview:false,idempotencyKey:'native-lamp-continue220'})
 const continuedRevision=studio.store.readRecord(target.id).currentRevision;const nextCheckpoint=join(studio.store.revisionDirectory(target.id,continuedRevision),'scene.blend'),facts=inspect(nextCheckpoint,'lamp-continued220')
 check('continued whole product fits native hero camera',facts.geometry.projectedBounds[0][2]>0&&[0,1].every(axis=>facts.geometry.projectedBounds[0][axis]>=.01&&facts.geometry.projectedBounds[1][axis]<=.99))
 check('actual continued native reaches220mm',facts.geometry.parts['shade-shell'].dimensionsMm.slice(0,2).every(x=>Math.abs(x-220)<.03))
 check('actual continuation preserves original native source and locked recipe bytes',Object.entries(original).every(([p,h])=>hash(p)===h))
 const preview=await studio.renderPreview({projectId:target.id,revision:continuedRevision,cameraId:'liner-inspection',frame:24,width:768,height:576,samples:64});json('liner-preview.json',preview)
 const image=preview.artifacts.find(a=>a.cameraId==='liner-inspection'&&a.frame===24&&a.sourceRevision===continuedRevision),imagePath=image&&join(studio.store.projectDirectory(target.id),image.path)
 check('saved liner image has actual source digest SHA256 and768x576PNG pixels',Boolean(image&&existsSync(imagePath)&&image.sourceDigest===preview.digest&&hash(imagePath)===image.sha256&&readFileSync(imagePath).readUInt32BE(16)===768&&readFileSync(imagePath).readUInt32BE(20)===576))
 json('continuation.json',{projectId:target.id,baseRevision:target.revision,revision:continuedRevision,checkpoint:nextCheckpoint})
}catch(e){failure=e.stack||String(e);console.error(e)}finally{try{await ctx.fiber.dispose()}catch(e){failure??=String(e)};console.log(`Native lamp dimensions: ${checks.filter(c=>c.ok).length}/${checks.length} check(s) passed`);json('report.json',{status:failure?'failed':'passed',checks,failure,scope:'Actual source Host catalog, public create/update transactions, real native Blender and three normal-ray samples. Maintainer direct flow, not real NL task, minimum wall/manufacturing or artistic approval.'})}
if(failure)process.exitCode=1
