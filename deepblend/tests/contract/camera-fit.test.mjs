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


test('optional photography evidence refuses missing static proof and misbound light identities', () => {
  const q = { ...selection(), photography: { lightIds: ['key'], cameraMustBeStatic: true } }
  const r = nativeFitReport(q)
  assert.throws(() => verifyCameraFitReport(r, q), { code: 'SCENE_VALIDATION_FAILED' })
  r.photography = { schemaVersion: 'deepblend.photography-snapshot/v1', staticGeometry: true, staticLights: true,
    cameraStatic: true, cameraRotationEuler: [0, 0, 0], lights: [{ id: 'key', type: 'area', energy: 10, color: [1, .8, .6], size: .5,
      transform: { location: [1, 2, 3], rotationEuler: [0, 0, 0], scale: [1, 1, 1] } }] }
  assert.equal(verifyCameraFitReport(r, q), r)
  for (const mutate of [p => p.staticGeometry = false, p => p.staticLights = false, p => p.cameraStatic = false,
    p => p.lights[0].id = 'foreign', p => p.lights[0].energy = Infinity, p => p.lights[0].transform.scale[0] = 0,
    p => p.cameraRotationEuler = [0, 0], p => p.lights.push(p.lights[0])]) {
    const bad = structuredClone(r); mutate(bad.photography)
    assert.throws(() => verifyCameraFitReport(bad, q), { code: 'SCENE_VALIDATION_FAILED' })
  }
  const sampled = { ...q, photography: { ...q.photography, cameraMustBeStatic: false } }
  const movingSource = structuredClone(r); movingSource.photography.cameraStatic = false
  assert.equal(verifyCameraFitReport(movingSource, sampled), movingSource)
})

test('photography accepts 128 explicit members without raising the ordinary fit limit or accepting candidates', () => {
  const q = { ...selection(), assetInstanceIds: [], entityIds: Array.from({length:128}, (_,i) => 'member'+i),
    photography: { lightIds: [], cameraMustBeStatic: true } }
  assert.doesNotThrow(() => validateCameraFitSelection(q))
  assert.throws(() => validateCameraFitSelection({...q,entityIds:[...q.entityIds,'overflow']}), /1–128/)
  const ordinary = {...q}; delete ordinary.photography
  assert.throws(() => validateCameraFitSelection(ordinary), /1–64/)
  assert.throws(() => validateCameraFitSelection({...q,baselineCheckpointPath:'/old.blend',baselineCheckpointSha256:sha256('old')}), {code:'SCENE_PATCH_INVALID'})
})
