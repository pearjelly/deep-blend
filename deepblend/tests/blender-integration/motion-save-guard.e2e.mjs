/** Native mutation at a nonrepresentative frame must not publish a motion revision. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'
import { MotionPreviews } from '../../../packages/deepblend/host/lib/motion-preview.js'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.deepblend/quality','motion-save-guard-'+Date.now())
assert(!existsSync(out));mkdirSync(out,{recursive:true})
const blender=process.env.DEEPBLEND_BLENDER_PATH||join(root,'.tools/Blender.app/Contents/MacOS/Blender'),workspace=join(out,'workspace'),ctx=new Context(),checks=[]
mkdirSync(workspace)
const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});console.log(`[${ok?'PASS':'FAIL'}] ${name}`);assert(ok,name)}
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const mutation=join(out,'mutate-candidate.py')
writeFileSync(mutation,String.raw`import bpy,sys
path=sys.argv[sys.argv.index('--')+1]
bpy.ops.wm.open_mainfile(filepath=path,load_ui=False,use_scripts=False)
scene=bpy.context.scene;obj=bpy.data.objects['db_entity__subject']
scene.frame_set(1);base=obj.location.x
for frame,value in [(1,base),(2,base+20),(3,base),(13,base),(24,base)]:
    obj.location.x=value;obj.keyframe_insert(data_path='location',index=0,frame=frame)
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=path)
`)
ctx.plugin(LocalSubprocess);ctx.plugin(Provider,{blenderPath:blender,workspaceRoot:workspace,timeoutMs:180000});ctx.plugin(Studio,{workspaceRoot:workspace,projectsRoot:join(workspace,'projects'),reconcileOnStart:false})
await new Promise(resolve=>setTimeout(resolve,150))
let service,failure
try{
 const studio=ctx.get('blenderStudio'),runtime=ctx.get('blenderRuntime'),id='save-guard',spec=defaultSceneSpec({projectId:id,title:'Motion save guard'})
 spec.project.activeCamera='camera-main';delete spec.cameras[0].targetEntityId;spec.cameras[0].targetPoint=[0,0,1];spec.cameras[0].transform.location=[8,-8,6];spec.cameras[0].lens=35
 await studio.createProject({projectId:id,title:'Motion save guard',sceneSpec:spec,renderPreview:false})
 const checkpoint=join(workspace,'projects',id,'revisions','r0001','scene.blend'),before=sha(checkpoint)
 service=new MotionPreviews({store:studio.store,runtime,ctx,config:studio.config,transactions:studio.transactions})
 const preview=await service.create({projectId:id,baseRevision:'r0001',projectsRoot:studio.store.projectsRoot,sourceCameraId:'camera-main',seconds:1,fraction:.01,direction:'backward',entityIds:['subject']})
 check('real preview checks all 24 frames without creating a revision',preview.frameAudit.frameCount===24&&studio.store.readRecord(id).currentRevision==='r0001'&&sha(checkpoint)===before)
 const original=runtime.compileScene.bind(runtime);let injected=false
 runtime.compileScene=async request=>{if(injected)return original(request);injected=true;const callback=request.onWorkingDirectory
  return original({...request,onWorkingDirectory:async info=>{const file=join(info.directory,'result.blend'),r=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',mutation,'--',file],{encoding:'utf8',timeout:120000});writeFileSync(join(out,'mutation.log'),(r.stdout||'')+(r.stderr||''));assert.equal(r.status,0,r.error?.message||r.stderr);await callback(info)}})}
 let caught
 try{await service.commit({projectId:id,id:preview.id,intentSha256:preview.intentSha256,projectsRoot:studio.store.projectsRoot})}catch(error){caught=error}
 check('the recompiled-only transient crop is detected by the saved frame audit',injected&&caught?.code==='MOTION_OUT_OF_FRAME',{code:caught?.code,message:caught?.message})
 check('failed save preserves the source and publishes no revision',studio.store.readRecord(id).currentRevision==='r0001'&&sha(checkpoint)===before&&readdirSync(join(workspace,'projects',id,'revisions')).length===1)
 runtime.compileScene=original
 const retry=await service.commit({projectId:id,id:preview.id,intentSha256:preview.intentSha256,projectsRoot:studio.store.projectsRoot})
 const manifest=studio.store.readRevisionManifest(id,retry.revision),saved=join(workspace,'projects',id,'revisions',retry.revision,'scene.blend')
 check('retry saves one revision with a 24-frame audit of its own checkpoint',retry.revision==='r0002'&&manifest.motionCandidateReceipt?.savedFrameAudit?.frameCount===24&&manifest.motionCandidateReceipt.savedFrameAudit.checkpointSha256===sha(saved))
 check('retry retains the original checkpoint',sha(checkpoint)===before)
}catch(error){failure=error;console.error(error.stack||String(error))}
finally{await service?.dispose();await ctx.stop?.();writeFileSync(join(out,'report.json'),JSON.stringify({passed:!failure,checks,error:failure?String(failure):null},null,2)+'\n')}
if(failure)process.exitCode=1
else console.log(`Motion save guard: ${checks.length}/${checks.length} checks passed; ${out}`)
