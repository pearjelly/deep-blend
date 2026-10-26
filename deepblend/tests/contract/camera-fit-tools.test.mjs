import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

const request={projectId:'lamp',baseRevision:'r0003',entityIds:['base','cable','shade'],cameraId:'hero',fittedCameraId:'complete-view',frame:24}
const summary={revision:'r0004',digest:'a'.repeat(64),projectDirectory:'/projects/lamp',checkpoint:'revisions/r0004/scene.blend',previews:[],
  cameraFitReceipt:{sourceRevision:'r0003',entityIds:request.entityIds,cameraId:'hero',fittedCameraId:'complete-view',frame:24,margin:.03}}

test('fitted-view tool requires complete selection, both camera IDs and an explicit frame',async t=>{
  let writes=0
  const plane=await composeToolPlane({studio:{cameraFitSupported:true,fitCamera(){writes++;return summary}},expectAtLeast:20})
  t.after(()=>plane.ctx.fiber.dispose())
  const tool=plane.registered.get('blender_camera_fit');assert.ok(tool)
  assert.deepEqual(tool.parameters.required,Object.keys(request))
  assert.equal(Object.hasOwn(tool.parameters.properties,'saveCheckpoint'),false)
  for(const key of Object.keys(request)){
    const args={...request};delete args[key]
    await assert.rejects(tool.execute(args,{}),{code:'INVALID_ARGS'})
  }
  for(const changes of [{entityIds:'base'},{entityIds:[2]},{frame:1.5},{margin:'0.03'},{renderPreview:0}]){
    await assert.rejects(tool.execute({...request,...changes},{}),{code:'INVALID_ARGS'})
  }
  assert.equal(writes,0)
  assert.match(tool.description,/every scene\.assemblyPlacement\.memberEntityIds/)
  assert.match(tool.description,/preview render aspect/)
  assert.match(tool.description,/Original cameras/)
})

test('one semantic fit intent and signal reach the Host; exact replay receipt is retained',async t=>{
  const calls=[],studio={cameraFitSupported:true,fitCamera(input){calls.push(input);return structuredClone(summary)}}
  const plane=await composeToolPlane({studio,expectAtLeast:20});t.after(()=>plane.ctx.fiber.dispose())
  const tool=plane.registered.get('blender_camera_fit'),signal=new AbortController().signal
  const saved=await tool.execute(request,{signal})
  assert.equal(saved.ok,true);assert.deepEqual(saved.data,summary)
  assert.deepEqual(calls,[{...request,signal}]);assert.match(saved.text,/Saved fitted view "complete-view" in revision r0004/)
  assert.deepEqual(JSON.parse(saved.text.split('Canonical JSON:\n')[1]),summary)
  studio.fitCamera=input=>{calls.push(input);return{...structuredClone(summary),idempotentReplay:true}}
  const retry={...request,margin:.04,renderPreview:false,idempotencyKey:'fit-intent'}
  const replay=await tool.execute(retry,{signal})
  assert.deepEqual(calls[1],{...retry,signal});assert.equal(replay.data.idempotentReplay,true)
  assert.match(replay.text,/Reused fitted view/)
})

test('missing or older Host capabilities refuse fitted views before any mutation',async()=>{
  let writes=0
  for(const studio of [undefined,{}, {fitCamera(){writes++}},{cameraFitSupported:false,fitCamera(){writes++}},{cameraFitSupported:true}]){
    const plane=await composeToolPlane({studio,expectAtLeast:20})
    try{
      const result=await plane.registered.get('blender_camera_fit').execute(request,{})
      assert.equal(result.ok,false)
      assert.equal(result.data.errorCode??result.data.code,BlenderErrorCode.RUNTIME_UNAVAILABLE)
      assert.match(result.text,/[Rr]estart/)
    }finally{await plane.ctx.fiber.dispose()}
  }
  assert.equal(writes,0)
})

test('Host refusals preserve unknown input and never fall back to manual camera patches',async t=>{
  const calls=[],studio={cameraFitSupported:true,fitCamera(input){calls.push(input);throw new BlenderError('SCENE_PATCH_INVALID','Unknown field: saveCheckpoint')},
    applyScenePatch(){assert.fail('A refused native fit cannot become a guessed camera patch')}}
  const plane=await composeToolPlane({studio,expectAtLeast:20});t.after(()=>plane.ctx.fiber.dispose())
  const tool=plane.registered.get('blender_camera_fit')
  const invalid=await tool.execute({...request,saveCheckpoint:false},{})
  assert.equal(invalid.ok,false);assert.equal(calls[0].saveCheckpoint,false)
  for(const code of [BlenderErrorCode.REVISION_CONFLICT,BlenderErrorCode.ABORTED,'SCENE_VALIDATION_FAILED']){
    studio.fitCamera=()=>{throw new BlenderError(code,'Fitted view was not committed')}
    const failed=await tool.execute(request,{})
    assert.equal(failed.ok,false);assert.equal(failed.data.errorCode,code)
    assert.match(failed.text,/Fitted view was not committed/)
    if(code===BlenderErrorCode.REVISION_CONFLICT)assert.match(failed.text,/retry blender_camera_fit/)
  }
})

test('only the committed fitted preview is attached; attachment failure preserves saved work',async t=>{
  const bytes=readFileSync(new URL('../fixtures/obj-image-formats/paint.png',import.meta.url))
  const artifact={kind:'preview',cameraId:'complete-view',frame:24,sourceRevision:'r0004',sourceDigest:summary.digest,
    mime:'image/png',width:64,height:64,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),path:'revisions/r0004/previews/complete-view.png'}
  const receipt={...summary,previews:[artifact]};let writes=0,reads=0,attachments=0,failAttachment=false
  const studio={cameraFitSupported:true,fitCamera(){writes++;return structuredClone(receipt)},
    renderPreview(){assert.fail('A committed fit preview must never be rendered again')},
    readArtifact(input){reads++;assert.deepEqual(input,{projectId:'lamp',path:artifact.path});return{path:artifact.path,contentType:'image/png',size:bytes.length,bytes}}}
  const plane=await composeToolPlane({studio,expectAtLeast:20,services:{attachments:{saveImage(input){attachments++;assert.deepEqual(input.data,bytes);
    if(failAttachment)throw Error('Attachment service unavailable')
    return{attachmentId:'fit-preview',mediaType:'image/png',width:64,height:64,bytes:bytes.length}}}}})
  t.after(()=>plane.ctx.fiber.dispose());const tool=plane.registered.get('blender_camera_fit')
  const saved=await tool.execute(request,{})
  assert.equal(saved.ok,true);assert.equal(saved.image.attachmentId,'fit-preview')
  failAttachment=true;const unattached=await tool.execute(request,{})
  assert.equal(unattached.ok,true);assert.deepEqual(unattached.data,receipt)
  assert.match(unattached.text,/revision remains saved/)
  assert.equal(writes,2);assert.equal(reads,2);assert.equal(attachments,2)
})
