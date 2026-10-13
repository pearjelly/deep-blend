import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateGeometrySelection, verifyGeometryReport } from '../../../packages/deepblend/contracts/lib/geometry-inspection.js'
import { HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

const query = () => ({ sampleId: 'rear-mid', entityId: 'wall', targetEntityId: 'liner',
  originMeters: [-.02, 0, 0], direction: [2, 0, 0], searchDistanceMm: 50 })
const request = () => ({ entityIds: ['wall', 'liner'], frame: 24, checkpointSha256: 'a'.repeat(64), surfaceSamples: [query()] })
const object = id => ({ entityId: id, type: 'MESH', available: true, worldBoundsMeters: { min: [-.01,-.02,-.02], max: [.01,.02,.02] },
  worldAxisExtentMm: [20,40,40], worldMatrix: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]], scale: [1,1,1], vertexCount: 8, polygonCount: 6 })
const sample = () => ({ ...query(), direction: [1,0,0], status: 'sampled', entryMeters: [-.001,0,0], exitMeters: [.001,0,0],
  inwardUnitNormal: [1,0,0], normalSurfaceChordMm: 2, gap: { status: 'sampled', targetEntryMeters: [.003,0,0], normalRaySeparationMm: 2 } })
const report = () => ({ schemaVersion: 'deepblend.geometry-inspection/v2', frame: 24, checkpointSha256: 'a'.repeat(64),
  checkpointUnchanged: true, blenderVersion: '5.2.1 LTS', objects: ['wall','liner'].map(object), surfaceSamples: [sample()] })
const refusal = e => e.code === 'BLENDER_SCRIPT_ERROR'

test('v2 preserves explicit samples and v1 keeps its old wire shape', () => {
  const r=report(); assert.equal(verifyGeometryReport(r,request()),r)
  const q=request(); delete q.surfaceSamples; delete r.surfaceSamples; r.schemaVersion='deepblend.geometry-inspection/v1'
  assert.equal(verifyGeometryReport(r,q),r)
  assert.throws(()=>verifyGeometryReport(report(),q),refusal)
  assert.throws(()=>verifyGeometryReport(r,request()),refusal)
})

for (const [name, change] of [
  ['empty samples', q=>q.surfaceSamples=[]], ['too many samples', q=>q.surfaceSamples=Array.from({length:9},(_,i)=>({...query(),sampleId:`s${i}`}))],
  ['duplicate samples', q=>q.surfaceSamples.push(query())], ['foreign source', q=>q.surfaceSamples[0].entityId='foreign'],
  ['foreign target', q=>q.surfaceSamples[0].targetEntityId='foreign'], ['same target', q=>q.surfaceSamples[0].targetEntityId='wall'],
  ['invalid sample name', q=>q.surfaceSamples[0].sampleId='../wall'], ['unknown code field', q=>q.surfaceSamples[0].script='bpy.ops.wm.save_as_mainfile()'],
  ['missing direction', q=>delete q.surfaceSamples[0].direction], ['zero direction', q=>q.surfaceSamples[0].direction=[0,0,0]],
  ['nonfinite origin', q=>q.surfaceSamples[0].originMeters[0]=NaN], ['far origin', q=>q.surfaceSamples[0].originMeters[0]=1001],
  ['unbounded search', q=>q.surfaceSamples[0].searchDistanceMm=501], ['zero search', q=>q.surfaceSamples[0].searchDistanceMm=0],
]) test(`surface request refuses ${name}`,()=>{const q=request();change(q);assert.throws(()=>validateGeometrySelection(q),refusal)})

for (const [name, change] of [
  ['missing sample', r=>r.surfaceSamples=[]], ['another sample', r=>r.surfaceSamples[0].sampleId='other'],
  ['wrong source', r=>r.checkpointSha256='b'.repeat(64)], ['another frame', r=>r.frame=25],
  ['another seed', r=>r.surfaceSamples[0].originMeters[0]-=.01], ['another direction', r=>r.surfaceSamples[0].direction=[0,1,0]],
  ['wrong search limit', r=>r.surfaceSamples[0].searchDistanceMm=100], ['invented thickness', r=>r.surfaceSamples[0].normalSurfaceChordMm=3],
  ['invented gap', r=>r.surfaceSamples[0].gap.normalRaySeparationMm=.1], ['nonfinite point', r=>r.surfaceSamples[0].exitMeters[0]=Infinity],
  ['opposite normal', r=>r.surfaceSamples[0].inwardUnitNormal=[-1,0,0]], ['not unit normal', r=>r.surfaceSamples[0].inwardUnitNormal=[2,0,0]],
  ['sideways exit', r=>r.surfaceSamples[0].exitMeters[1]=.001], ['entry behind seed', r=>r.surfaceSamples[0].entryMeters[0]=-.021],
  ['entry beyond budget', r=>r.surfaceSamples[0].entryMeters[0]=.04], ['negative gap', r=>r.surfaceSamples[0].gap.normalRaySeparationMm=-1],
  ['target behind exit', r=>r.surfaceSamples[0].gap.targetEntryMeters[0]=0], ['target off normal', r=>r.surfaceSamples[0].gap.targetEntryMeters[1]=.001],
  ['fabricated global minimum', r=>r.minimumClearanceMm=.1], ['invented nested field', r=>r.surfaceSamples[0].minimumWallThicknessMm=2],
  ['false measured unavailable source', r=>r.objects[0]={entityId:'wall',type:'MESH',available:false,unavailableReason:'viewport-disabled'}],
  ['false measured unavailable target', r=>r.objects[1]={entityId:'liner',type:'MESH',available:false,unavailableReason:'viewport-disabled'}],
  ['unknown gap status', r=>r.surfaceSamples[0].gap={status:'success'}], ['unknown source status', r=>r.surfaceSamples[0]={...query(),direction:[1,0,0],status:'success'}],
]) test(`surface report refuses ${name}`,()=>{const r=report();change(r);assert.throws(()=>verifyGeometryReport(r,request()),refusal)})

test('misses, unsupported topology, overlap and occlusion never contain fake numeric measurements',()=>{
  for(const status of ['no-entry','entry-not-inward','unsupported-topology-or-winding','geometry-budget-exceeded','below-resolution']) {
    const r=report(); r.surfaceSamples[0]={...query(),direction:[1,0,0],status};verifyGeometryReport(r,request())
    r.surfaceSamples[0].normalSurfaceChordMm=0;assert.throws(()=>verifyGeometryReport(r,request()),refusal)
  }
  for(const status of ['no-target-entry','target-not-inward','source-surface-before-target','below-resolution']) {
    const r=report();r.surfaceSamples[0].gap={status};verifyGeometryReport(r,request())
    r.surfaceSamples[0].gap.normalRaySeparationMm=0;assert.throws(()=>verifyGeometryReport(r,request()),refusal)
  }
})

test('unrequested separation is refused and omitted target stays a chord-only sample',()=>{
  const r=report(),q=request();delete q.surfaceSamples[0].targetEntityId;delete r.surfaceSamples[0].targetEntityId
  assert.throws(()=>verifyGeometryReport(r,q),refusal);delete r.surfaceSamples[0].gap;verifyGeometryReport(r,q)
})

test('model tool returns explicit local evidence and refuses old or fabricated surface reports',async()=>{
  let options,transform=x=>x
  const host={hostApiVersion:()=>HOST_API_VERSION,getScene:async(id,input)=>{
    options=input;const r=report()
    return transform({projectId:id,revision:'r0001',digest:'source-digest',geometryInspection:{
      schemaVersion:'deepblend.scene-geometry/v2',projectId:id,sourceRevision:'r0001',sourceDigest:'source-digest',
      sourceCheckpointSha256:r.checkpointSha256,sourceUnchanged:true,frame:24,blenderVersion:r.blenderVersion,objects:r.objects,surfaceSamples:r.surfaceSamples,
      limitations:['Local normal chords; not global minimum wall thickness or whole-assembly clearance.']}})
  }}
  const plane=await composeToolPlane({studio:host,label:'surface-output',expectAtLeast:18}),tool=plane.registered.get('blender_scene_get')
  const q=request(),args={projectId:'project',geometryEntityIds:q.entityIds,geometryFrame:q.frame,geometrySurfaceSamples:q.surfaceSamples}
  const signal=new AbortController().signal
  const result=await tool.execute(args,{signal});assert.equal(result.ok,true);assert.deepEqual(options.geometry.surfaceSamples,q.surfaceSamples);assert.equal(options.signal,signal)
  assert.equal(result.data.geometryInspection.surfaceSamples[0].normalSurfaceChordMm,2)
  assert.match(result.text,/not global minimum/)
  transform=x=>{x.geometryInspection.schemaVersion='deepblend.scene-geometry/v1';delete x.geometryInspection.surfaceSamples;return x}
  const old=await tool.execute(args,{});assert.equal(old.ok,false);assert.match(old.text,/Upgrade/)
  transform=x=>{x.geometryInspection.surfaceSamples[0].gap.normalRaySeparationMm=0;return x}
  const fake=await tool.execute(args,{});assert.equal(fake.ok,false);assert.equal(fake.data.errorCode,'BLENDER_SCRIPT_ERROR')
  const partial=await tool.execute({projectId:'project',geometrySurfaceSamples:q.surfaceSamples},{});assert.equal(partial.ok,false)
})
