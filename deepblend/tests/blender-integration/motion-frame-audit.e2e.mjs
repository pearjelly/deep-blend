/** Real Blender catches a transient crop missed by the three representative frames. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '@deepblend/dsh-blender-provider-local'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.deepblend/quality','motion-frame-audit-'+Date.now())
assert(!existsSync(out));mkdirSync(out,{recursive:true})
const blender=process.env.DEEPBLEND_BLENDER_PATH||join(root,'.tools/Blender.app/Contents/MacOS/Blender')
const fixture=spawnSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',join(import.meta.dirname,'motion-frame-audit-fixture.py'),'--',out],{encoding:'utf8',timeout:120000})
writeFileSync(join(out,'fixture.log'),(fixture.stdout||'')+(fixture.stderr||''));assert.equal(fixture.status,0,fixture.error?.message||fixture.stderr)
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex'),ctx=new Context(),checks=[]
const check=(name,value)=>{checks.push({name,ok:Boolean(value)});console.log(`[${value?'PASS':'FAIL'}] ${name}`);assert(value,name)}
ctx.plugin(LocalSubprocess);ctx.plugin(Provider,{blenderPath:blender,workspaceRoot:out,timeoutMs:120000})
await new Promise(resolve=>setTimeout(resolve,150))
let failure
try{
 const runtime=ctx.get('blenderRuntime'),frames=[1,2,3,4,5],audit={entityIds:['product'],assetInstanceIds:[]}
 async function render(name,source,selectedFrames=frames,inspection=audit,auditOnly=false){
  const checkpoint=join(out,source),before=sha(checkpoint)
  const run=await runtime.startFrameSequence({checkpointPath:checkpoint,frames:selectedFrames,jobDirectory:join(out,name),cameraId:'hero',profileName:'motion-preview',profile:{engine:'cycles',resolution:[64,64],samples:1,filmTransparent:false},frameRange:[1,5],jobId:name,...(inspection===null?{}:{motionFrameAudit:inspection}),...(auditOnly?{motionFrameAuditOnly:true}:{})})
  const result=await runtime.awaitFrameSequence(run)
  writeFileSync(join(out,name+'-result.json'),JSON.stringify(result.envelope,null,2)+'\n')
  check(name+' leaves its native source unchanged',sha(checkpoint)===before)
  return {result,files:readdirSync(run.framesDirectory).sort()}
 }
 const good=await render('good','in-frame.blend')
 check('complete preview reports all five inspected frames',good.result.exitCode===0&&good.result.envelope?.status==='success'&&JSON.stringify(good.result.envelope.result.motionFrameAudit?.frames)===JSON.stringify(frames)&&good.files.length===5)
 const geometry=JSON.parse(readFileSync(join(out,'loose-geometry.json'),'utf8'))
 check('independent native projection proves loose bounds but fully visible vertices',geometry.boundsOutside&&geometry.verticesInside)
 const loose=await render('loose','loose-bounds.blend')
 check('a loose bounding box does not reject the in-frame triangular mesh',loose.result.exitCode===0&&loose.result.envelope?.status==='success'&&loose.files.length===5)
 const sampled=await render('representative','briefly-out.blend',[1,3,5])
 check('the same briefly moving object fits all three representative frames',sampled.result.exitCode===0&&sampled.result.envelope?.status==='success'&&sampled.files.length===3)
 const bad=await render('transient','briefly-out.blend')
 check('the full check refuses the transient crop at frame 2',bad.result.envelope?.error?.code==='MOTION_OUT_OF_FRAME'&&bad.result.envelope.error.detail?.frame===2&&bad.files.length===1)
 const saved=await render('saved-check','in-frame.blend',frames,audit,true)
 check('a saved candidate is checked in full without rendering image files',saved.result.exitCode===0&&saved.result.envelope?.result?.renderKind==='motion-frame-audit'&&JSON.stringify(saved.result.envelope.result.motionFrameAudit.frames)===JSON.stringify(frames)&&saved.files.length===0)
 const savedBad=await render('saved-transient','briefly-out.blend',frames,audit,true)
 check('saved candidate inspection rejects transient clipping before publishing',savedBad.result.envelope?.error?.code==='MOTION_OUT_OF_FRAME'&&savedBad.result.envelope.error.detail?.frame===2&&savedBad.files.length===0)
 const missing=await render('audit-without-selection','in-frame.blend',frames,null,true)
 check('audit-only mode without a complete selection fails closed',missing.result.envelope?.error?.code==='MOTION_FRAME_UNVERIFIABLE'&&missing.files.length===0)
 const malformed=await render('malformed','in-frame.blend',frames,{entityIds:['product','product'],assetInstanceIds:[]})
 check('a duplicate selection is refused before rendering',malformed.result.envelope?.error?.code==='MOTION_FRAME_UNVERIFIABLE'&&malformed.files.length===0)
 const legacy=await render('legacy','in-frame.blend',[1],null)
 check('ordinary renders do not require or claim a motion audit',legacy.result.exitCode===0&&legacy.result.envelope?.status==='success'&&legacy.result.envelope.result.motionFrameAudit===undefined&&legacy.files.length===1)
}catch(error){failure=error;console.error(error.stack||String(error))}
finally{await ctx.stop?.();writeFileSync(join(out,'report.json'),JSON.stringify({passed:!failure,checks,error:failure?String(failure):null},null,2)+'\n')}
if(failure)process.exitCode=1
else console.log(`Motion frame audit: ${checks.length}/${checks.length} checks passed; ${out}`)
