import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { validateAssemblyPairs, readAssemblyOrigins, compareAssemblyOrigins, compareGeometryReports } from '../../../packages/deepblend/tool/lib/assembly-origins.js'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

const pairs = () => [{ pairId: 'knob-seat', entityId: 'knob', anchorEntityId: 'seat' }]
const object = (id, location = [.15,-.09,.02], extent = [20,40,40]) => ({ entityId:id,type:'MESH',available:true,
  worldBoundsMeters:{min:[0,0,0],max:extent.map(value=>value/1000)},worldAxisExtentMm:extent,
  worldMatrix:[[1,0,0,location[0]],[0,1,0,location[1]],[0,0,1,location[2]],[0,0,0,1]],scale:[1,1,1],vertexCount:8,polygonCount:6 })
const report = (revision='r0002') => ({schemaVersion:'deepblend.scene-geometry/v1',projectId:'project',sourceRevision:revision,
  sourceDigest:`digest-${revision}`,sourceCheckpointSha256:(revision==='r0001'?'a':'b').repeat(64),sourceUnchanged:true,
  frame:26,blenderVersion:'5.2.1 LTS',objects:[object('knob',[.245,-.175,.037]),object('seat',[.245,-.1744,.037])],limitations:['Measured saved native objects only.']})
const refuse = e => e.code === 'BLENDER_SCRIPT_ERROR'
const near = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`)

test('ordered native origin offsets use world matrix translations; bounds, SceneSpec and scaled axes are not substituted',()=>{
  const r=report();r.objects[0].worldMatrix[0][0]=7;r.objects[0].scale=[7,1,1]
  const receipt=readAssemblyOrigins(r,pairs());assert.equal(receipt.source.revision,'r0002');assert.equal(receipt.source.frame,26)
  assert.equal(receipt.source.checkpointSha256,'b'.repeat(64));assert.equal(receipt.coordinateSystem,'world')
  assert.deepEqual(receipt.pairs[0].entityOriginMeters,[.245,-.175,.037]);near(receipt.pairs[0].worldOriginOffsetMm[1],-.6)
  assert.deepEqual(receipt.pairs[0].worldOriginOffsetMm.filter((_,i)=>i!==1),[0,0])
  assert.match(receipt.limitations.join(' '),/OBJECT ORIGINS.*not surface/)
  const reverse=readAssemblyOrigins(r,[{pairId:'reverse',entityId:'seat',anchorEntityId:'knob'}]);near(reverse.pairs[0].worldOriginOffsetMm[1],.6)
})

test('world XYZ offsets rotate with the assembly and are never mislabeled as intrinsic or local dimensions',()=>{
  const r=report();for(const o of r.objects){const m=o.worldMatrix,[x,y]=[m[0][3],m[1][3]];m[0][3]=-y;m[1][3]=x}
  const pair=readAssemblyOrigins(r,pairs()).pairs[0];near(pair.worldOriginOffsetMm[0],.6);near(pair.worldOriginOffsetMm[1],0)
})

for(const [label,change]of [
 ['empty',p=>p.splice(0)],['nine',p=>{while(p.length<9)p.push({...p[0],pairId:'p'+p.length})}],
 ['duplicate name',p=>p.push({...p[0]})],['foreign endpoint',p=>p[0].entityId='other'],['foreign anchor',p=>p[0].anchorEntityId='other'],
 ['same endpoint',p=>p[0].anchorEntityId='knob'],['bad name',p=>p[0].pairId='../p'],['unknown field',p=>p[0].clearanceMm=0],
])test(`pair selection refuses ${label}`,()=>{const p=pairs();change(p);assert.throws(()=>validateAssemblyPairs(p,['knob','seat']),refuse)})

test('unavailable endpoints and unavailable comparisons have no fabricated zero offset or zero change',()=>{
  const before=report('r0001'),after=report();after.objects[1]={entityId:'seat',type:'MESH',available:false,unavailableReason:'viewport-disabled'}
  const measured=readAssemblyOrigins(before,pairs()),unavailable=readAssemblyOrigins(after,pairs())
  assert.equal(unavailable.pairs[0].status,'unavailable');assert.deepEqual(unavailable.pairs[0].unavailableParts,[{entityId:'seat',reason:'viewport-disabled'}])
  assert.equal('worldOriginOffsetMm'in unavailable.pairs[0],false)
  const comparison=compareAssemblyOrigins(measured,unavailable);assert.equal(comparison.comparedPairs,0)
  assert.equal('worldOriginOffsetChangeMm'in comparison.pairs[0],false)
  const geometry=compareGeometryReports(before,after);assert.equal(geometry.summary.comparedEntities,1)
  assert.equal('worldAxisExtentChangeMm'in geometry.objects[1],false);assert.equal('worldOriginChangeMm'in geometry.objects[1],false)
})

test('changed dimensions and pair offsets are current minus reference, with original reports unchanged',()=>{
  const before=report('r0001'),after=report();before.objects[0]=object('knob',[.245,-.17,.037],[10,30,40])
  const original=JSON.stringify([before,after]),geometry=compareGeometryReports(before,after)
  assert.deepEqual(geometry.objects[0].worldAxisExtentChangeMm,[10,10,0]);near(geometry.objects[0].worldOriginChangeMm[1],-5)
  const pairsChange=compareAssemblyOrigins(readAssemblyOrigins(before,pairs()),readAssemblyOrigins(after,pairs()))
  near(pairsChange.pairs[0].worldOriginOffsetChangeMm[1],-5);assert.equal(pairsChange.comparedPairs,1)
  assert.equal(JSON.stringify([before,after]),original)
  const wrong=report();wrong.frame=27;assert.throws(()=>compareGeometryReports(before,wrong),refuse)
  wrong.frame=26;wrong.objects.reverse();assert.throws(()=>compareGeometryReports(before,wrong),refuse)
  const swapped=readAssemblyOrigins(after,[{pairId:'knob-seat',entityId:'seat',anchorEntityId:'knob'}]);assert.throws(()=>compareAssemblyOrigins(readAssemblyOrigins(before,pairs()),swapped),refuse)
})

test('nonfinite or non-affine matrices cannot produce origin evidence',()=>{
  for(const change of [r=>r.objects[0].worldMatrix[0][3]=NaN,r=>r.objects[0].worldMatrix[3][0]=1]) {
    const r=report();change(r);assert.throws(()=>readAssemblyOrigins(r,pairs()),refuse);assert.throws(()=>compareGeometryReports(report('r0001'),r),refuse)
  }
})

test('model can compare ordinary native saved revisions and receive ordered pair evidence without surface seeds or catalogue',async()=>{
  const requests=[];let transform=x=>x
  const host={hostApiVersion:()=>HOST_API_VERSION,getScene:async(id,input)=>{
    requests.push(input);const revision=input.revision??'r0002',inspection=report(revision)
    if(revision==='r0001')inspection.objects[0]=object('knob',[.245,-.17,.037],[10,30,40])
    return transform({projectId:id,revision,digest:inspection.sourceDigest,isCurrent:revision==='r0002',
      entities:[{id:'catalogue',type:'mesh',location:[0,0,0]}],spec:{privateCatalogue:'x'.repeat(20000)},...(input.geometry ? { geometryInspection:inspection } : {})})
  }}
  const plane=await composeToolPlane({studio:host,label:'assembly-origin-output',expectAtLeast:18}),tool=plane.registered.get('blender_scene_get')
  const args={projectId:'project',revision:'r0002',geometryEntityIds:['knob','seat'],geometryFrame:26,geometryOnly:true,
    geometryAssemblyPairs:pairs(),geometryCompareRevision:'r0001'},signal=new AbortController().signal
  const result=await tool.execute(args,{signal});assert.equal(result.ok,true)
  assert.deepEqual(requests.map(r=>r.revision),['r0002','r0001']);assert.ok(requests.every(r=>r.signal===signal))
  assert.ok(requests.every(r=>!Object.hasOwn(r.geometry,'surfaceSamples')))
  const comparison=result.data.geometryComparison;assert.equal(comparison.schemaVersion,'deepblend.geometry-comparison/v1')
  assert.deepEqual(comparison.objects[0].worldAxisExtentChangeMm,[10,10,0]);near(comparison.objects[0].worldOriginChangeMm[1],-5)
  near(comparison.assemblyOriginComparison.pairs[0].worldOriginOffsetChangeMm[1],-5)
  assert.equal(result.data.geometryAssemblyOrigins.source.revision,'r0002');assert.equal(result.data.geometryAssemblyOrigins.source.frame,26)
  assert.equal('entities'in result.data,false);assert.equal(result.text.includes('privateCatalogue'),false)
  assert.deepEqual(JSON.parse(result.text.split('Canonical JSON:\n')[1]),result.data)
  assert.match(result.text,/not surface|not protrusion/)
  const count=requests.length
  for(const bad of [{projectId:'project',geometryAssemblyPairs:pairs()}, {...args,geometryCompareRevision:'../r0001'},
    {...args,geometryAssemblyPairs:[{pairId:'p',entityId:'knob',anchorEntityId:'unknown'}]}]) {
    const rejected=await tool.execute(bad,{});assert.equal(rejected.ok,false);assert.equal(rejected.data.errorCode,'BLENDER_SCRIPT_ERROR')
  }
  assert.equal(requests.length,count)
  transform=x=>{if(x.revision==='r0001')x.geometryInspection.sourceCheckpointSha256='invalid';return x}
  const forged=await tool.execute(args,{});assert.equal(forged.ok,false);assert.equal(forged.data.errorCode,'BLENDER_SCRIPT_ERROR')
  transform=x=>{if(x.revision==='r0001'){x.revision='r0009';x.geometryInspection.sourceRevision='r0009'}return x}
  const wrong=await tool.execute(args,{});assert.equal(wrong.ok,false);assert.equal(wrong.data.errorCode,'BLENDER_RUNTIME_UNAVAILABLE')
  transform=x=>{if(x.revision==='r0001')x.geometryInspection.frame=27;return x}
  const frame=await tool.execute(args,{});assert.equal(frame.ok,false);assert.equal(frame.data.errorCode,'BLENDER_RUNTIME_UNAVAILABLE')
  transform=x=>x
  const ordinary=await tool.execute({projectId:'project'},{});assert.equal(ordinary.ok,true)
  assert.equal('geometryAssemblyOrigins'in ordinary.data,false);assert.equal('geometryComparison'in ordinary.data,false)
})


test('finite inputs whose subtraction or millimeter conversion overflow are refused before JSON can turn them into measured nulls',()=>{
  const huge=report();huge.objects[0].worldMatrix[0][3]=1e308
  assert.throws(()=>readAssemblyOrigins(huge,pairs()),refuse)
  assert.throws(()=>compareGeometryReports(report('r0001'),huge),refuse)
  const before=readAssemblyOrigins(report('r0001'),pairs()),after=readAssemblyOrigins(report(),pairs())
  before.pairs[0].worldOriginOffsetMm[0]=Number.MAX_VALUE
  after.pairs[0].worldOriginOffsetMm[0]=-Number.MAX_VALUE
  assert.throws(()=>compareAssemblyOrigins(before,after),refuse)
})
