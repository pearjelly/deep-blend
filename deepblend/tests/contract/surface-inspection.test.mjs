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
  let options,transform=x=>x,comparisonFixture=false
  const requests=[]
  const host={hostApiVersion:()=>HOST_API_VERSION,getScene:async(id,input)=>{
    options=input;requests.push(input);const r=report(),revision=input.revision??'r0001',digest='source-digest-'+revision
    if(comparisonFixture) {
      r.surfaceSamples=input.geometry.surfaceSamples.map(q=>({...sample(),...q,direction:[1,0,0]}))
      if(revision==='r0002') {r.surfaceSamples[0].exitMeters=[0,0,0];r.surfaceSamples[0].normalSurfaceChordMm=1;r.surfaceSamples[0].gap.normalRaySeparationMm=3}
      r.surfaceSamples[1].gap={status:'no-target-entry'}
      if(revision==='r0003') {r.surfaceSamples[1].exitMeters=[.006,0,0];r.surfaceSamples[1].normalSurfaceChordMm=7}
    }
    return transform({projectId:id,revision,digest,isCurrent:false,entities:[{id:'catalogue',type:'mesh',location:[0,0,0]}],spec:{privateCatalogue:'x'.repeat(20000)},geometryInspection:{
      schemaVersion:'deepblend.scene-geometry/v2',projectId:id,sourceRevision:revision,sourceDigest:digest,
      sourceCheckpointSha256:r.checkpointSha256,sourceUnchanged:true,frame:24,blenderVersion:r.blenderVersion,objects:r.objects,surfaceSamples:r.surfaceSamples,
      limitations:['Local normal chords; not global minimum wall thickness or whole-assembly clearance.']}})
  }}
  const plane=await composeToolPlane({studio:host,label:'surface-output',expectAtLeast:18}),tool=plane.registered.get('blender_scene_get')
  const q=request(),args={projectId:'project',geometryEntityIds:q.entityIds,geometryFrame:q.frame,geometrySurfaceSamples:q.surfaceSamples}
  const signal=new AbortController().signal
  const result=await tool.execute(args,{signal});assert.equal(result.ok,true);assert.deepEqual(options.geometry.surfaceSamples,q.surfaceSamples);assert.equal(options.signal,signal)
  assert.equal(result.data.geometryInspection.surfaceSamples[0].normalSurfaceChordMm,2)
  assert.match(result.text,/not global minimum/)
  const compact=await tool.execute({...args,geometryOnly:true},{signal})
  assert.equal(compact.ok,true);assert.equal(compact.data.isCurrent,false)
  assert.deepEqual(Object.keys(compact.data).sort(),['digest','geometryInspection','isCurrent','projectId','revision'])
  assert.deepEqual(compact.data.geometryInspection,result.data.geometryInspection)
  assert.ok(compact.text.length<3000);assert.ok(!compact.text.includes('privateCatalogue'))
  assert.deepEqual(JSON.parse(compact.text.split('Canonical JSON:\n')[1]),compact.data)
  const ordinary=await tool.execute({...args,geometryOnly:false},{})
  assert.equal(ordinary.data.spec.privateCatalogue.length,20000)
  await assert.rejects(()=>tool.execute({...args,geometryOnly:'true'},{}),e=>e.code==='INVALID_ARGS')
  for (const invalid of [{projectId:'project',geometryOnly:true},{...args,geometryOnly:true,full:true}]) {
    const bad=await tool.execute(invalid,{});assert.equal(bad.ok,false);assert.equal(bad.data.errorCode,'BLENDER_SCRIPT_ERROR')
  }
  comparisonFixture=true
  const compareArgs={...args,revision:'r0003',geometryOnly:true,geometryCompareRevision:'r0002',geometrySurfaceSamples:[query(),{...query(),sampleId:'chord-only'}]}
  const compared=await tool.execute(compareArgs,{signal});assert.equal(compared.ok,true)
  const comparison=compared.data.geometryComparison
  assert.equal(comparison.referenceInspection.sourceRevision,'r0002')
  const {maxAbsoluteSeparationChangePercent,...totals}=comparison.summary
  assert.deepEqual(totals,{requestedSamples:2,comparedChords:2,comparedSeparations:1,maxAbsoluteChordChangeMm:5,maxAbsoluteChordChangePercent:250,maxAbsoluteSeparationChangeMm:1})
  assert.ok(Math.abs(maxAbsoluteSeparationChangePercent-100/3)<1e-10)
  assert.equal(comparison.samples[0].normalSurfaceChordChangePercent,100)
  assert.equal(comparison.samples[1].normalSurfaceChordChangePercent,250)
  assert.ok(Math.abs(comparison.samples[0].normalRaySeparationChangePercent+100/3)<1e-10)
  assert.equal(comparison.samples[0].normalSurfaceChordChangeMm,1);assert.equal(comparison.samples[0].normalRaySeparationChangeMm,-1)
  assert.equal(comparison.samples[1].normalSurfaceChordChangeMm,5);assert.equal(comparison.samples[1].after.targetStatus,'no-target-entry')
  assert.equal('normalRaySeparationChangeMm' in comparison.samples[1],false)
  assert.deepEqual(requests.slice(-2).map(r=>r.geometry.surfaceSamples),[compareArgs.geometrySurfaceSamples,compareArgs.geometrySurfaceSamples])
  assert.ok(requests.slice(-2).every(r=>r.signal===signal))
  transform=x=>{if(x.revision==='r0002')x.geometryInspection.surfaceSamples[0].gap.normalRaySeparationMm=0;return x}
  const forgedReference=await tool.execute(compareArgs,{});assert.equal(forgedReference.ok,false);assert.equal(forgedReference.data.errorCode,'BLENDER_SCRIPT_ERROR')
  transform=x=>{if(x.revision==='r0002'){x.revision='r0009';x.geometryInspection.sourceRevision='r0009'}return x}
  const wrongReference=await tool.execute(compareArgs,{});assert.equal(wrongReference.ok,false);assert.equal(wrongReference.data.errorCode,'BLENDER_RUNTIME_UNAVAILABLE')
  transform=x=>{x.geometryInspection.surfaceSamples=x.geometryInspection.surfaceSamples.map(s=>({...query(),sampleId:s.sampleId,direction:[1,0,0],status:'no-entry'}));return x}
  const unavailable=await tool.execute(compareArgs,{});assert.equal(unavailable.ok,true)
  assert.deepEqual(unavailable.data.geometryComparison.summary,{requestedSamples:2,comparedChords:0,comparedSeparations:0})
  for(const badArgs of [{...args,geometryCompareRevision:'../r0002'},{projectId:'project',geometryCompareRevision:'r0002'}]) {
    const invalid=await tool.execute(badArgs,{});assert.equal(invalid.ok,false);assert.equal(invalid.data.errorCode,'BLENDER_SCRIPT_ERROR')
  }
  comparisonFixture=false
  transform=x=>{x.geometryInspection.schemaVersion='deepblend.scene-geometry/v1';delete x.geometryInspection.surfaceSamples;return x}
  const old=await tool.execute({...args,geometryOnly:true},{});assert.equal(old.ok,false);assert.match(old.text,/Upgrade/)
  transform=x=>{x.geometryInspection.surfaceSamples[0].gap.normalRaySeparationMm=0;return x}
  const fake=await tool.execute({...args,geometryOnly:true},{});assert.equal(fake.ok,false);assert.equal(fake.data.errorCode,'BLENDER_SCRIPT_ERROR')
  const partial=await tool.execute({projectId:'project',geometrySurfaceSamples:q.surfaceSamples},{});assert.equal(partial.ok,false)
})
