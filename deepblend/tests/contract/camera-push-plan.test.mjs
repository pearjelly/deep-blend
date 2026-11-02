import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planPush,resolveMotionSpec } from '../../../packages/deepblend/host/lib/camera-push-plan.js'

function fixture() {
  const spec=JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json',import.meta.url)))
  const camera=spec.cameras.find(c=>c.id==='camera-top');delete camera.targetEntityId;camera.targetPoint=[0,0,0]
  return {spec,projectId:spec.project.id,baseRevision:'r0001',sourceCameraId:'camera-top',cameraId:'push-view',seconds:3,fraction:.1,direction:'forward'}
}
test('push adds a camera and three tracks without modifying the original scene',()=>{
  const input=fixture(),before=structuredClone(input.spec),plan=planPush(input)
  assert.deepEqual(input.spec,before);assert.deepEqual([plan.frameStart,plan.frameEnd,plan.fps],[1,90,30])
  assert.deepEqual(plan.patch.operations.map(o=>o.op),['camera.add','animation.track.set','animation.track.set','animation.track.set'])
  assert.deepEqual(plan.startPosition,[0,0,.9]);assert.ok(Math.abs(plan.endPosition[2]-.81)<1e-9)
  const backward=planPush({...input,direction:'backward'});assert.ok(Math.abs(backward.endPosition[2]-.99)<1e-9)
})
test('an expanded timeline requires consent and preserves existing frame start',()=>{
  const input=fixture();input.spec.project.frameEnd=60
  assert.throws(()=>planPush(input),{code:'RANGE_CONFIRMATION_REQUIRED'})
  assert.deepEqual(planPush({...input,allowRangeExtension:true}).patch.operations[0],{op:'project.frameRange.set',frameStart:1,frameEnd:90})
})
test('existing camera animation and entity-targeted cameras are refused',()=>{
  const input=fixture();input.spec.animationTracks.push({id:'old-camera',targetKind:'camera',targetEntityId:'camera-top',property:'location.x',keyframes:[{frame:1,value:0},{frame:90,value:1}]})
  assert.throws(()=>planPush(input),{code:'CAMERA_ANIMATED'})
  const targeted=fixture();targeted.spec.cameras.find(c=>c.id==='camera-top').targetEntityId='watch-body'
  assert.throws(()=>planPush(targeted),{code:'ENTITY_TARGET_UNSUPPORTED'})
})
test('unsafe identifiers, conflicting tracks and invalid motion are refused',()=>{
  const input=fixture()
  for(const update of [{cameraId:'../bad'},{cameraId:'camera-top'},{fraction:0},{fraction:.21},{seconds:0},{direction:'sideways'},{sourceCameraId:'missing'}])assert.throws(()=>planPush({...input,...update}))
  input.spec.animationTracks.push({id:'push-view-x',targetKind:'camera',targetEntityId:'camera-main',property:'location.x',keyframes:[{frame:1,value:0},{frame:90,value:1}]})
  assert.throws(()=>planPush(input),{code:'TRACK_EXISTS'})
})
test('implicit first-camera fallback is preserved even when camera IDs sort differently',()=>{const input=fixture();delete input.spec.project.activeCamera;input.spec.cameras.reverse();const before=input.spec.cameras.map(c=>c.id),plan=planPush(input),resolved=resolveMotionSpec(input.spec,plan.patch,plan.cameraOrder);assert.deepEqual(plan.cameraOrder,[...before,input.cameraId]);assert.deepEqual(resolved.cameras.map(c=>c.id),plan.cameraOrder);assert.equal(resolved.project.activeCamera,undefined);assert.deepEqual(input.spec.cameras.map(c=>c.id),before);assert.throws(()=>resolveMotionSpec(input.spec,plan.patch,[input.cameraId,...before.slice(0,1),before[0]]),{code:'RESULT_INVALID'});input.spec.project.activeCamera='nonexistent';assert.throws(()=>planPush(input),{code:'ACTIVE_CAMERA_UNCLEAR'})})
test('a free camera without depth of field uses a measured subject distance',()=>{const input=fixture(),camera=input.spec.cameras.find(c=>c.id==='camera-top');delete camera.targetPoint;delete camera.focusDistance;assert.throws(()=>planPush(input),{code:'CAMERA_INVALID'});const plan=planPush({...input,measuredReferenceDistance:5});assert.equal(plan.referenceDistance,5);assert.ok(Math.abs(Math.hypot(...plan.startPosition.map((v,i)=>v-plan.endPosition[i]))-.5)<1e-9)})
