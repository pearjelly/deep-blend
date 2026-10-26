import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateCameraFitSelection, verifyCameraFitReport, sha256, validateSceneSpec,
  applyPatchToSpec, compileSceneSpec } from '@deepblend/dsh-blender-contracts'
import { readFileSync } from 'node:fs'
import { selection, nativeFitReport } from '../lib/camera-fit-fixture.mjs'

test('a native fitted view binds complete members, frame, calibration and checkpoint', () => {
  const q = selection(), report = nativeFitReport(q)
  assert.equal(verifyCameraFitReport(report, q), report)
  const candidate = { ...q, checkpointSha256: sha256('candidate'), baselineCheckpointPath: '/baseline.blend', baselineCheckpointSha256: q.checkpointSha256 }
  assert.equal(verifyCameraFitReport(nativeFitReport(candidate), candidate).baselineVerification.originalObjectsUnchanged, true)
})

for (const [label, change] of [
  ['implicit frame', q=>delete q.frame], ['duplicate members', q=>q.entityIds.push('body')],
  ['empty selection', q=>q.entityIds=[]], ['excessive members', q=>q.entityIds=Array.from({length:65},(_,i)=>'body'+i)],
  ['same camera ID', q=>q.fittedCameraId=q.cameraId], ['foreign asset root', q=>q.assetInstanceIds=['foreign']],
  ['missing checkpoint identity', q=>delete q.checkpointSha256], ['negative margin', q=>q.margin=-.01],
  ['unbounded margin', q=>q.margin=.26], ['null margin', q=>q.margin=null],
  ['partial native baseline', q=>q.baselineCheckpointPath='/baseline.blend'],
]) test(`fitted-view request refuses ${label}`, () => {
  const q=selection(); change(q)
  assert.throws(()=>validateCameraFitSelection(q),{code:'SCENE_PATCH_INVALID'})
})

for (const [label, change] of [
  ['wrong frame', r=>r.frame++], ['wrong checkpoint', r=>r.checkpointSha256=sha256('other')],
  ['missing member', r=>r.members=[]], ['wrong member', r=>r.members[0].entityId='foreign'],
  ['changed native source', r=>r.checkpointUnchanged=false], ['unmeasured geometry', r=>delete r.members[0].geometrySha256],
  ['aggregate mesh budget', r=>r.members[0].meshObjectCount=129], ['aggregate vertex budget', r=>r.members[0].vertexCount=2_000_001],
  ['false margin claim', r=>r.members[0].projection.normalizedBounds.min[0]=.02],
  ['false clip claim', r=>r.members[0].projection.nearestDepthMeters=-1],
  ['missing projection', r=>delete r.members[0].projection], ['unknown artistic approval', r=>r.artisticQuality='approved'],
  ['changed lens', r=>r.proposal.lens=60], ['aimed camera copy', r=>r.proposal.targetPoint=[0,0,0]],
  ['scaled copied camera', r=>r.proposal.transform.scale=[2,2,2]], ['missing focus', r=>delete r.proposal.focusDistance],
  ['missing pixel aspect', r=>delete r.view.pixelAspect], ['invalid render size', r=>r.view.resolution=[0,768]],
  ['nonaffine camera matrix', r=>r.camera.matrixWorld[3][0]=1],
]) test(`fitted-view proof refuses ${label}`, () => {
  const q=selection(), r=nativeFitReport(q);change(r)
  assert.throws(()=>verifyCameraFitReport(r,q),{code:'SCENE_VALIDATION_FAILED'})
})

for (const [label, change] of [
  ['missing baseline',r=>delete r.baselineVerification], ['changed geometry',r=>r.baselineVerification.selectedGeometryUnchanged=false],
  ['changed originals',r=>r.baselineVerification.originalObjectsUnchanged=false], ['excessive vertex error',r=>r.baselineVerification.maxVertexErrorMeters=.001],
  ['clipped candidate',r=>{r.members[0].projection.containedInClip=false;r.members[0].projection.farthestDepthMeters=101}],
]) test(`compiled fitted view refuses ${label}`, () => {
  const q={...selection(),baselineCheckpointPath:'/baseline.blend',baselineCheckpointSha256:sha256('baseline')}
  const r=nativeFitReport(q);change(r)
  assert.throws(()=>verifyCameraFitReport(r,q),{code:'SCENE_VALIDATION_FAILED'})
})

test('saved optics and explicit focus survive add, compile and camera update without altering aim', () => {
  const spec=compileSceneSpec(JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json',import.meta.url)))).spec
  const original=structuredClone(spec.cameras)
  const camera={...nativeFitReport(selection()).proposal,sensorFit:'VERTICAL',sensorHeight:32,shift:[.6,-.3],focusDistance:.8}
  const add=applyPatchToSpec(spec,{projectId:spec.project.id,baseRevision:'r0001',operations:[{op:'camera.add',camera}]})
  const next=compileSceneSpec(add.spec).spec
  assert.equal(validateSceneSpec(next).ok,true)
  assert.deepEqual(next.cameras.find(c=>c.id===camera.id),camera)
  for(const old of original)assert.deepEqual(next.cameras.find(c=>c.id===old.id),old)
  const update=applyPatchToSpec(next,{projectId:spec.project.id,baseRevision:'r0002',operations:[{op:'camera.update',cameraId:camera.id,focusDistance:1.4,shift:[-.2,.1],sensorFit:'HORIZONTAL',sensorHeight:28}]})
  const changed=update.spec.cameras.find(c=>c.id===camera.id)
  assert.equal(changed.focusDistance,1.4);assert.equal(changed.sensorFit,'HORIZONTAL');assert.equal(changed.sensorHeight,28)
  assert.deepEqual(changed.shift,[-.2,.1]);assert.deepEqual(changed.transform,camera.transform)
})

test('analytic fit is checked by an independent projection over shifted, deep and random clouds', () => {
  const run=spawnSync('python3',['-B',fileURLToPath(new URL('../lib/test-product-framing.py',import.meta.url))],{encoding:'utf8'})
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr)
  assert.match(run.stderr,/Ran 10 tests/)
})
