import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import { BLENDER_PROTOCOL_VERSION, BlenderErrorCode, sha256 } from '@deepblend/dsh-blender-contracts'
import { selection, nativeFitReport } from '../lib/camera-fit-fixture.mjs'

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'deepblend-fit-provider-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const workspace=join(root,'workspace');mkdirSync(workspace)
  const checkpointPath=join(workspace,'source.blend');writeFileSync(checkpointPath,'source')
  const runtime=new Provider(new Context(),ProviderConfig({workspaceRoot:workspace}))
  const request={...selection(),checkpointPath},calls=[],hooks={}
  runtime.runBootstrap=async(q,options)=>{
    calls.push({request:q,options})
    assert.equal(options.session,false);assert.equal(q.action,'inspect_camera_fit')
    assert.deepEqual(readFileSync(options.args[1]),Buffer.from('source'))
    assert.notEqual(options.args[1],checkpointPath)
    const result={exitCode:0,envelope:{protocolVersion:BLENDER_PROTOCOL_VERSION,status:'success',action:q.action,
      jobId:q.jobId,error:null,result:nativeFitReport(q.payload)}}
    await hooks.run?.(q,options,result)
    return result
  }
  return{root,workspace,runtime,request,calls,hooks}
}

test('native fit uses independent copied checkpoints, a fixed action and isolated batch',async t=>{
  const s=fixture(t),result=await s.runtime.inspectCameraFit(s.request)
  assert.equal(result.report.proposal.id,s.request.fittedCameraId)
  assert.equal(s.calls.length,1);assert.deepEqual(readFileSync(s.request.checkpointPath),Buffer.from('source'))
  const baseline=join(s.workspace,'baseline.blend');writeFileSync(baseline,'baseline')
  const request={...s.request,baselineCheckpointPath:baseline,baselineCheckpointSha256:sha256('baseline')}
  const verified=await s.runtime.inspectCameraFit(request)
  assert.equal(verified.report.baselineVerification.selectedGeometryUnchanged,true)
  assert.notEqual(s.calls.at(-1).request.payload.baselineCheckpointPath,baseline)
})

test('hash mismatch and out-of-workspace links refuse before bootstrap',async t=>{
  const s=fixture(t)
  await assert.rejects(s.runtime.inspectCameraFit({...s.request,checkpointSha256:sha256('different')}),{code:BlenderErrorCode.SCENE_VALIDATION_FAILED})
  const foreign=join(s.root,'foreign.blend');writeFileSync(foreign,'source')
  const link=join(s.workspace,'outside.blend');symlinkSync(foreign,link)
  await assert.rejects(s.runtime.inspectCameraFit({...s.request,checkpointPath:link}),{code:BlenderErrorCode.PATH_OUTSIDE_WORKSPACE})
  assert.equal(s.calls.length,0)
})

for(const [label,change]of [
  ['snapshot mutation',(_,opts)=>writeFileSync(opts.args[1],'modified')],
  ['nonzero process exit',(_,__,r)=>r.exitCode=1],
  ['wrong response action',(_,__,r)=>r.envelope.action='inspect_geometry'],
  ['wrong response job',(_,__,r)=>r.envelope.jobId='other-job'],
  ['partial report',(_,__,r)=>r.envelope.result.members=[]],
])test(`native fit rejects ${label} and retains its source`,async t=>{
  const s=fixture(t);s.hooks.run=change
  await assert.rejects(s.runtime.inspectCameraFit(s.request))
  assert.deepEqual(readFileSync(s.request.checkpointPath),Buffer.from('source'))
})

test('cancellation after a native response cannot return a successful report',async t=>{
  const s=fixture(t),controller=new AbortController()
  s.hooks.run=()=>controller.abort()
  await assert.rejects(s.runtime.inspectCameraFit({...s.request,signal:controller.signal}),{code:BlenderErrorCode.ABORTED})
})
