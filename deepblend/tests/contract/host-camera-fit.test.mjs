import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { nativeFitReport } from '../lib/camera-fit-fixture.mjs'

async function setup(t, staticProducts = false) {
  const root=mkdtempSync(join(tmpdir(),'deepblend-camera-fit-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const calls={inspect:[],compile:[],preview:[]},hooks={}
  const runtime={
    getCapabilities:async()=>({installed:true,sceneFeatures:['geometry.primitive.dimensions','geometry.modifier.subdivision']}),
    compileScene:async input=>{
      calls.compile.push(input)
      const spec=JSON.parse(readFileSync(input.sceneSpecPath,'utf8'))
      const directory=join(dirname(input.sceneSpecPath),'compiler');mkdirSync(directory,{recursive:true})
      writeFileSync(join(directory,'result.blend'),JSON.stringify({spec}))
      input.onWorkingDirectory({directory});await hooks.compile?.(input)
      return{report:{sceneFingerprint:{totalPolygons:24},validation:{ok:true}},envelope:{}}
    },
    inspectCameraFit:async input=>{
      calls.inspect.push(input);const report=nativeFitReport(input)
      await hooks.inspect?.(input,report)
      return{report,envelope:{}}
    },
    resolveEngineKey:async()=>({warning:null,blenderEngine:'BLENDER_EEVEE_NEXT'}),
    renderPreview:async input=>{
      calls.preview.push(input);writeFileSync(input.outputPath,'fixture-preview');await hooks.preview?.(input)
      return{report:{frame:input.frame,cameraId:input.cameraId},envelope:{}}
    },
  }
  const context=new Context();context.provide('blenderRuntime',runtime)
  const studio=new Studio(context,StudioConfig({workspaceRoot:root,projectsRoot:join(root,'projects'),reconcileOnStart:false}))
  const sceneSpec=JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json',import.meta.url),'utf8'))
  // Retain animation and the source's authored, unsorted camera order.
  sceneSpec.cameras.reverse()
  if (staticProducts) sceneSpec.animationTracks = []
  const created=await studio.createProject({title:'Camera fit',sceneSpec,saveCheckpoint:true})
  const projectId=created.projectId
  return{root,studio,runtime,calls,hooks,request:{projectId,baseRevision:'r0001',entityIds:['watch-dial','watch-body'],
    cameraId:'camera-main',fittedCameraId:'complete-view',frame:7},
    origin:studio.store.revisionDirectory(projectId,'r0001'),project:studio.store.projectDirectory(projectId)}
}

function assertUnpublished(s,record) {
  assert.deepEqual(s.studio.store.readRecord(s.request.projectId),record)
  assert.equal(existsSync(s.studio.store.revisionDirectory(s.request.projectId,'r0002')),false)
  assert.deepEqual(readdirSync(join(s.project,'staging')),[])
  assert.equal(readdirSync(s.project).some(n=>n.startsWith('.camera-fit-')),false)
}

test('fit adds one static camera, preserves original arrays, saves native receipt and previews the same frame',async t=>{
  const s=await setup(t),before=s.studio.store.readRevisionSpec(s.request.projectId,'r0001')
  const files=['scene-spec.json','scene.blend','revision-manifest.json'].map(n=>[n,readFileSync(join(s.origin,n))])
  const result=await s.studio.fitCamera(s.request)
  assert.equal(result.revision,'r0002');assert.equal(result.idempotencyKeyDerived,true)
  const after=s.studio.store.readRevisionSpec(s.request.projectId,'r0002')
  assert.deepEqual(after,{...before,cameras:[...before.cameras,result.cameraFitReceipt.camera]})
  assert.deepEqual(s.calls.inspect[0].entityIds,['watch-body','watch-dial'])
  assert.equal(s.calls.compile.at(-1).session,false);assert.equal(s.calls.preview[0].session,false)
  assert.equal(s.calls.preview[0].frame,7);assert.equal(s.calls.preview[0].cameraId,'complete-view')
  assert.equal(s.calls.inspect.length,2);assert.equal(result.previews[0].cameraId,'complete-view')
  assert.deepEqual(s.studio.store.readRevisionManifest(s.request.projectId,'r0002').cameraFitReceipt,result.cameraFitReceipt)
  for(const [name,bytes]of files)assert.deepEqual(readFileSync(join(s.origin,name)),bytes)
})

test('logical fit retries replay after later edits; mismatched and cross-operation keys refuse before native work',async t=>{
  const s=await setup(t),request={...s.request,renderPreview:false,idempotencyKey:'fit-1'}
  const saved=await s.studio.fitCamera(request)
  await s.studio.applyScenePatch({projectId:s.request.projectId,baseRevision:'r0002',saveCheckpoint:false,
    operations:[{op:'entity.tags.set',entityId:'stage',tags:['later']}],idempotencyKey:'ordinary'})
  const count=s.calls.inspect.length,replay=await s.studio.fitCamera({...request,entityIds:[...request.entityIds].reverse()})
  assert.equal(replay.idempotentReplay,true);assert.equal(replay.revision,saved.revision)
  assert.deepEqual(replay.cameraFitReceipt,saved.cameraFitReceipt)
  assert.equal(s.studio.store.readRecord(s.request.projectId).currentRevision,'r0003')
  await assert.rejects(s.studio.fitCamera({...request,margin:.04}),{code:'SCENE_PATCH_REJECTED'})
  await assert.rejects(s.studio.applyScenePatch({projectId:s.request.projectId,baseRevision:'r0003',idempotencyKey:'fit-1',saveCheckpoint:false,
    operations:[{op:'entity.tags.set',entityId:'stage',tags:[]}]}),{code:'SCENE_PATCH_REJECTED'})
  await assert.rejects(s.studio.fitCamera({...request,baseRevision:'r0003',idempotencyKey:'ordinary'}),{code:'SCENE_PATCH_REJECTED'})
  assert.equal(s.calls.inspect.length,count)
})

test('invalid selection, stale revision, occupied camera and wrong store do not launch native work',async t=>{
  const s=await setup(t)
  for(const [change,code]of [[{frame:undefined},'SCENE_PATCH_INVALID'],[{margin:null},'SCENE_PATCH_INVALID'],
    [{entityIds:['foreign']},'SCENE_PATCH_INVALID'],[{fittedCameraId:'camera-top'},'SCENE_PATCH_INVALID'],
    [{baseRevision:'r0002'},'REVISION_CONFLICT'],[{projectsRoot:join(s.root,'other')},'REVISION_CONFLICT']]){
    await assert.rejects(s.studio.fitCamera({...s.request,...change}),{code})
  }
  assert.equal(s.calls.inspect.length,0)
})

for(const [label,inject]of [
  ['partial projection',s=>s.hooks.inspect=(q,r)=>{if(q.baselineCheckpointPath)r.members[0].projection.normalizedBounds.max[0]=1.1}],
  ['wrong compiled camera',s=>s.hooks.inspect=(q,r)=>{if(q.baselineCheckpointPath)r.camera.matrixWorld[0][3]+=1}],
  ['changed checkpoint',s=>s.hooks.inspect=q=>{if(q.baselineCheckpointPath)writeFileSync(q.checkpointPath,'modified')}],
  ['changed staged spec',s=>s.hooks.compile=q=>{const spec=JSON.parse(readFileSync(q.sceneSpecPath,'utf8'));spec.project.goal='External mutation';writeFileSync(q.sceneSpecPath,JSON.stringify(spec))}],
  ['cancellation after proposal',s=>{const c=new AbortController();s.request.signal=c.signal;s.hooks.inspect=q=>{if(!q.baselineCheckpointPath)c.abort()}}],
  ['cancellation after verification',s=>{const c=new AbortController();s.request.signal=c.signal;s.hooks.inspect=q=>{if(q.baselineCheckpointPath)c.abort()}}],
])test(`fit refuses ${label} without publishing its candidate`,async t=>{
  const s=await setup(t),record=s.studio.store.readRecord(s.request.projectId);inject(s)
  await assert.rejects(s.studio.fitCamera(s.request),e=>[BlenderErrorCode.SCENE_VALIDATION_FAILED,BlenderErrorCode.ABORTED].includes(e.code))
  assertUnpublished(s,record)
})

test('a changed project pointer during compilation refuses publication and retains the intervening record',async t=>{
  const s=await setup(t)
  s.hooks.compile=()=>{const record=s.studio.store.readRecord(s.request.projectId);record.title='External update';s.studio.store.writeRecord(s.request.projectId,record)}
  await assert.rejects(s.studio.fitCamera(s.request),{code:'REVISION_CONFLICT'})
  assert.equal(s.studio.store.readRecord(s.request.projectId).title,'External update')
  assert.equal(existsSync(s.studio.store.revisionDirectory(s.request.projectId,'r0002')),false)
})


async function photographySetup(t) {
  const s = await setup(t, true)
  const spec = s.studio.store.readRevisionSpec(s.request.projectId, 'r0001')
  const target = await s.studio.createProject({ title: 'Photography destination', sceneSpec: spec, saveCheckpoint: true })
  const source = await s.studio.getScene(s.request.projectId, { full: true })
  const destination = await s.studio.getScene(target.projectId, { full: true })
  const request = { projectId: target.projectId, baseRevision: 'r0001', expectedDigest: destination.digest,
    expectedStoreIdentity: s.studio.editableSnapshots.storeIdentity, entityIds: ['watch-body'], cameraId: 'camera-main', frame: 7,
    source: { projectId: source.projectId, revision: source.revision, digest: source.digest,
      entityIds: ['watch-body'], cameraId: 'camera-main', frame: 7 } }
  s.hooks.inspect = (input, report) => {
    if (!input.photography) return
    const destination = input.photography.cameraMustBeStatic
    if (destination) for (const member of report.members) member.worldBoundsMeters = { min: [3, 4, 0], max: [5, 6, 2] }
    report.photography = { schemaVersion: 'deepblend.photography-snapshot/v1', staticGeometry: true, staticLights: true,
      cameraStatic: true, cameraRotationEuler: [0, 0, 0], lights: input.photography.lightIds.map(id => ({ id, type: 'area', energy: 10,
        color: [1, .8, .6], size: .5, transform: { location: [1, 2, 3], rotationEuler: [0, 0, 0], scale: [1, 1, 1] } })) }
  }
  return { ...s, photography: request }
}

test('boundary photography planning reads exact saved native sources and returns an unsaved proportional rig', async t => {
  const s = await photographySetup(t), q = s.photography
  const before = s.studio.store.readRevisionSpec(q.projectId, q.baseRevision)
  const hashFiles = id => ['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(file => [join(s.studio.store.revisionDirectory(id, 'r0001'), file), readFileSync(join(s.studio.store.revisionDirectory(id, 'r0001'), file))])
  const originals = [...hashFiles(q.projectId), ...hashFiles(q.source.projectId)]
  const compileCount = s.calls.compile.length, previewCount = s.calls.preview.length
  const plan = await s.studio.planPhotographyReuse(q)
  assert.equal(plan.scale, 2)
  assert.deepEqual(plan.camera.transform.location, [4, 5, 4])
  assert.deepEqual(plan.camera.transform.rotationEuler, [0, 0, 0])
  assert.equal(plan.camera.targetPoint, undefined); assert.equal(plan.camera.targetEntityId, undefined)
  assert.equal(plan.camera.sensorWidth, before.cameras.find(c => c.id === q.cameraId).sensorWidth)
  assert.deepEqual(plan.lights[0].transform.location, [5, 8, 6])
  assert.equal(plan.lights[0].energy, 40); assert.equal(plan.lights[0].size, 1)
  assert.equal(plan.request.expectedDigest, q.expectedDigest)
  assert.equal(plan.provenance.sourceDigest, q.source.digest)
  assert.equal(s.calls.inspect.length, 2)
  assert.deepEqual(s.calls.inspect.map(c => c.photography.cameraMustBeStatic), [false, true])
  assert.equal(s.calls.compile.length, compileCount); assert.equal(s.calls.preview.length, previewCount)
  assert.equal(s.studio.store.readRecord(q.projectId).currentRevision, q.baseRevision)
  for (const [file, bytes] of originals) assert.deepEqual(readFileSync(file), bytes)
})

test('boundary photography refuses stale identities, bad membership and frames before native work', async t => {
  const s = await photographySetup(t), q = s.photography
  for (const change of [r => r.expectedDigest = '0'.repeat(64), r => r.expectedStoreIdentity = '0'.repeat(64),
    r => r.source.digest = '0'.repeat(64), r => r.source.frame = 99999, r => r.entityIds = ['missing'],
    r => r.entityIds = ['watch-body', 'watch-body'], r => r.cameraId = 'missing']) {
    const bad = structuredClone(q); change(bad)
    await assert.rejects(s.studio.planPhotographyReuse(bad))
    assert.equal(s.calls.inspect.length, 0)
  }
})

test('boundary photography refuses old runtimes, dynamic receipts and a changed destination after inspection', async t => {
  const s = await photographySetup(t), q = s.photography, normal = s.hooks.inspect
  s.hooks.inspect = () => {}
  await assert.rejects(s.studio.planPhotographyReuse(q), { code: 'SCENE_VALIDATION_FAILED' })
  s.hooks.inspect = (input, report) => { normal(input, report); report.photography.staticGeometry = false }
  await assert.rejects(s.studio.planPhotographyReuse(q), { code: 'SCENE_VALIDATION_FAILED' })
  s.hooks.inspect = async (input, report) => {
    normal(input, report)
    if (input.photography.cameraMustBeStatic) await s.studio.applyScenePatch({ projectId: q.projectId, baseRevision: q.baseRevision,
      saveCheckpoint: false, operations: [{ op: 'entity.tags.set', entityId: 'stage', tags: ['changed-during-read'] }] })
  }
  await assert.rejects(s.studio.planPhotographyReuse(q), { code: 'REVISION_CONFLICT' })
  assert.equal(s.studio.store.readRecord(q.projectId).currentRevision, 'r0002')
})
