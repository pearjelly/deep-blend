import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, sha256, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { defaultSceneSpec } from '@deepblend/dsh-blender-host/revision-transaction'
import { diagnosticSpec } from '../../../packages/deepblend/host/lib/diagnostic-preview.js'
import { verifyAssetBundle, BUNDLE_LOCK } from '../../../packages/deepblend/host/lib/asset-bundle.js'
import { encodeGlb } from '../lib/glb.mjs'

const base = () => defaultSceneSpec({ projectId: 'inspection-test', title: 'Inspection contract' })
const matrix = () => [[1,0,0,0], [0,1,0,0], [0,0,1,0], [0,0,0,1]]
const cameraFacts = frame => ({ frame, matrixWorld: matrix(), type: 'PERSP', lens: 50, orthoScale: 6,
  sensorWidth: 36, sensorHeight: 24, sensorFit: 'AUTO', shift: [0,0], clip: [.1,100],
  dof: { enabled: false, focusDistance: 10, focusObject: null, focusSubtarget: null,
    apertureFstop: 5.6, apertureBlades: 0, apertureRotation: 0, apertureRatio: 1 } })

async function setup(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-diagnostic-contract-')), calls = []
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = {
    async compileScene(request) {
      calls.push({ phase: 'compile', request, spec: JSON.parse(readFileSync(request.sceneSpecPath)) })
      await options.compile?.(request)
      const directory = mkdtempSync(join(root, 'runtime-'))
      try {
        writeFileSync(join(directory, 'result.blend'), `derived ${calls.length}`)
        await request.onWorkingDirectory({ directory })
      } finally { rmSync(directory, { recursive: true, force: true }) }
      return { report: { validation: { ok: true }, sceneFingerprint: { totalPolygons: 6 } }, envelope: { warnings: [] } }
    },
    async renderViews(request) {
      calls.push({ phase: 'render', request })
      await options.render?.(request)
      const result = { report: { views: request.views.map(view => ({ viewId: view.id, cameraId: view.cameraId,
        frame: view.frame, width: request.width, height: request.height, engine: 'CYCLES', outputPath: `/discarded/${view.id}.png`,
        renderConfig: { engine: 'CYCLES', resolution: [request.width,request.height], samples: request.samples,
          exposure: 0, look: 'None', viewTransform: 'AgX', filmTransparent: false, resolutionPercentage: 100,
          fps: 24, frameStart: 1, frameEnd: 48 }, cameraFacts: cameraFacts(view.frame) })) },
      pngs: Object.fromEntries(request.views.map(view => [view.id, encodePng(createImage(request.width, request.height, [120,80,60,255]))])),
      envelope: { warnings: [] } }
      options.edit?.(result)
      return result
    },
  }
  const ctx = new Context(); ctx.provide('blenderRuntime', runtime)
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'),
    reconcileOnStart: false, maxPreviewSamples: 32 }))
  const created = await studio.createProject({ title: 'Inspection', saveCheckpoint: options.saveCheckpoint === true, sceneSpec: options.spec ?? base() })
  const projectId = created.projectId, project = studio.store.projectDirectory(projectId)
  const request = { projectId, revision: 'r0001', mode: 'clay', width: 32, height: 24, samples: 8,
    views: [{ id: 'selected', cameraId: 'camera-main', frame: 1 }] }
  const render = changes => ctx.blenderStudio.renderViews({ ...request, ...changes })
  return { root, ctx, studio, runtime, projectId, project, request, render, calls }
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString('base64')]))
}

function geometryReport(request) {
  return { report: { schemaVersion: 'deepblend.geometry-inspection/v1', checkpointSha256: request.checkpointSha256,
    checkpointUnchanged: true, frame: request.frame, blenderVersion: 'fixture', objects: request.entityIds.map(entityId => ({
      entityId, type: 'MESH', available: true, worldBoundsMeters: { min: [0,0,0], max: [.1,.2,.3] },
      worldAxisExtentMm: [100,200,300], worldMatrix: matrix(), scale: [1,1,1], vertexCount: 8, polygonCount: 6,
    })) } }
}

test('local surface reads bind the same immutable revision and leave project history exact', async t => {
  const f=await setup(t,{saveCheckpoint:true}), entityId=base().entities[0].id
  const samples=[{sampleId:'local-mid',entityId,originMeters:[-.01,0,0],direction:[1,0,0],searchDistanceMm:50}]
  const before=snapshot(f.project)
  f.runtime.inspectGeometry=async request=>{
    assert.deepEqual(request.surfaceSamples,samples)
    const result=geometryReport(request);result.report.schemaVersion='deepblend.geometry-inspection/v2'
    result.report.surfaceSamples=[{...samples[0],status:'sampled',entryMeters:[0,0,0],exitMeters:[.002,0,0],inwardUnitNormal:[1,0,0],normalSurfaceChordMm:2}]
    return result
  }
  const result=await f.studio.getScene(f.projectId,{geometry:{entityIds:[entityId],frame:17,surfaceSamples:samples}})
  assert.equal(result.geometryInspection.schemaVersion,'deepblend.scene-geometry/v2')
  assert.equal(result.geometryInspection.surfaceSamples[0].normalSurfaceChordMm,2)
  assert.ok(result.geometryInspection.limitations.some(x=>/Other scene objects are not checked/.test(x)))
  assert.ok(result.geometryInspection.excludedMeasurements.includes('minimumClearance'))
  assert.deepEqual(snapshot(f.project),before)
})

test('old native runtimes refuse surface samples with an upgrade diagnosis',async t=>{
  const f=await setup(t,{saveCheckpoint:true}),entityId=base().entities[0].id
  f.runtime.inspectGeometry=async request=>geometryReport(request)
  const geometry={entityIds:[entityId],frame:1,surfaceSamples:[{sampleId:'mid',entityId,originMeters:[-.01,0,0],direction:[1,0,0],searchDistanceMm:50}]}
  await assert.rejects(f.studio.getScene(f.projectId,{geometry}),e=>e.code===BlenderErrorCode.RUNTIME_UNAVAILABLE && /upgrade/.test(e.message))
  delete geometry.surfaceSamples
  assert.equal((await f.studio.getScene(f.projectId,{geometry})).geometryInspection.schemaVersion,'deepblend.scene-geometry/v1')
})

test('native geometry reads the pinned checkpoint, preserves the revision and cleans private input', async t => {
  const f = await setup(t, { saveCheckpoint: true }), directory = join(f.project, 'revisions/r0001')
  const before = snapshot(f.project), selection = { entityIds: [base().entities[0].id], frame: 17 }
  let input
  f.runtime.inspectGeometry = async request => { input = request; return geometryReport(request) }
  const result = await f.studio.getScene(f.projectId, { geometry: selection })
  const manifest = JSON.parse(readFileSync(join(directory, 'revision-manifest.json')))
  assert.equal(result.geometryInspection.sourceCheckpointSha256, sha256(readFileSync(join(directory, 'scene.blend'))))
  assert.equal(result.geometryInspection.sourceCheckpointSha256, manifest.checkpointBinding.sha256)
  assert.equal(result.geometryInspection.sourceUnchanged, true)
  assert.ok(result.geometryInspection.excludedMeasurements.includes('shellToLinerClearance'))
  assert.ok(result.geometryInspection.limitations.some(text => text.includes('both bounds describe outer surfaces')))
  assert.equal(result.geometryInspection.frame, 17)
  assert.deepEqual(result.geometryInspection.objects[0].worldAxisExtentMm, [100,200,300])
  assert.notEqual(input.checkpointPath, join(directory, 'scene.blend'))
  assert.equal(existsSync(input.checkpointPath), false)
  assert.deepEqual(snapshot(f.project), before)
  assert.equal(f.calls.length, 1) // Only the initial compile, no measurement render or compile.
  const path = join(directory, 'revision-manifest.json'); delete manifest.checkpointBinding
  writeFileSync(path, JSON.stringify(manifest))
  assert.equal((await f.studio.getScene(f.projectId, { geometry: selection })).geometryInspection.sourceCheckpointSha256, input.checkpointSha256)
})

for (const [label, change, code] of [
  ['checkpoint tamper', f => writeFileSync(join(f.project, 'revisions/r0001/scene.blend'), 'changed'), 'SCENE_VALIDATION_FAILED'],
  ['manifest tamper', f => { const p = join(f.project, 'revisions/r0001/revision-manifest.json'); const m = JSON.parse(readFileSync(p)); m.digest = 'changed'; writeFileSync(p, JSON.stringify(m)) }, 'SCENE_VALIDATION_FAILED'],
  ['missing checkpoint', f => rmSync(join(f.project, 'revisions/r0001/scene.blend')), 'REVISION_CHECKPOINT_MISSING'],
  ['unsupported runtime', f => delete f.runtime.inspectGeometry, 'RUNTIME_UNAVAILABLE'],
]) test(`native geometry refuses ${label} before runtime`, async t => {
  const f = await setup(t, { saveCheckpoint: true }); let calls = 0
  f.runtime.inspectGeometry = async request => { calls++; return geometryReport(request) }; change(f)
  await assert.rejects(f.studio.getScene(f.projectId, { geometry: { entityIds: [base().entities[0].id], frame: 1 } }), { code: BlenderErrorCode[code] })
  assert.equal(calls, 0)
})

for (const [label, mutate] of [
  ['saved checkpoint', f => writeFileSync(join(f.project, 'revisions/r0001/scene.blend'), 'changed during evaluation')],
  ['removed checkpoint', f => rmSync(join(f.project, 'revisions/r0001/scene.blend'))],
  ['removed manifest', f => rmSync(join(f.project, 'revisions/r0001/revision-manifest.json'))],
  ['report frame', (f, result) => result.report.frame++],
  ['report bounds', (f, result) => result.report.objects[0].worldAxisExtentMm[0]++],
]) test(`native geometry accepts no result after changed ${label}`, async t => {
  const f = await setup(t, { saveCheckpoint: true }); let input
  f.runtime.inspectGeometry = async request => { input = request; const result = geometryReport(request); mutate(f, result); return result }
  await assert.rejects(f.studio.getScene(f.projectId, { geometry: { entityIds: [base().entities[0].id], frame: 1 } }), {
    code: label.startsWith('report') ? BlenderErrorCode.SCRIPT_ERROR : BlenderErrorCode.SCENE_VALIDATION_FAILED,
  })
  assert.equal(existsSync(input.checkpointPath), false)
})

test('native geometry rejects invalid selection and cancelled requests without invoking runtime', async t => {
  const f = await setup(t, { saveCheckpoint: true }); let calls = 0
  f.runtime.inspectGeometry = async request => { calls++; return geometryReport(request) }
  const id = base().entities[0].id
  for (const geometry of [{ entityIds: ['missing'], frame: 1 }, { entityIds: [id,id], frame: 1 }, { entityIds: [id], frame: 1.5 }]) {
    await assert.rejects(f.studio.getScene(f.projectId, { geometry }))
  }
  await assert.rejects(f.studio.getScene(f.projectId, { geometry: { entityIds: [id], frame: 1 }, signal: AbortSignal.abort() }), { code: 'BLENDER_ABORTED' })
  assert.equal(calls, 0)
})

test('native geometry cancellation during evaluation cleans the snapshot and forwards the signal', async t => {
  const f = await setup(t, { saveCheckpoint: true }), controller = new AbortController(); let input
  f.runtime.inspectGeometry = async request => { input = request; controller.abort(); return geometryReport(request) }
  await assert.rejects(f.studio.getScene(f.projectId, { geometry: { entityIds: [base().entities[0].id], frame: 1 }, signal: controller.signal }), { code: BlenderErrorCode.ABORTED })
  assert.equal(input.signal, controller.signal); assert.equal(existsSync(input.checkpointPath), false)
})

test('legacy native geometry requires an exact successful producer artifact', async t => {
  const f = await setup(t, { saveCheckpoint: true }), path = join(f.project, 'revisions/r0001/revision-manifest.json')
  const manifest = JSON.parse(readFileSync(path)); delete manifest.checkpointBinding; writeFileSync(path, JSON.stringify(manifest))
  const jobPath = f.studio.store.jobPath(f.projectId, manifest.jobId), job = JSON.parse(readFileSync(jobPath))
  let calls = 0; f.runtime.inspectGeometry = async request => { calls++; return geometryReport(request) }
  for (const changed of [{ ...job, status: 'failed' }, { ...job, revision: 'r0002' }, { ...job, artifacts: [] }]) {
    writeFileSync(jobPath, JSON.stringify(changed))
    await assert.rejects(f.studio.getScene(f.projectId, { geometry: { entityIds: [base().entities[0].id], frame: 1 } }), { code: BlenderErrorCode.UNSUPPORTED_ACTION })
  }
  assert.equal(calls, 0)
})
async function emptyDiagnostics(fixture) {
  assert.deepEqual((await fixture.studio.listPreviewSets({ projectId: fixture.projectId })).revisions[0].diagnostics, [])
  assert.equal(readdirSync(join(fixture.project, 'staging')).filter(name => name.startsWith('.diagnostic-')).length, 0)
}

test('clay transform preserves structure, background, tracks and original document; collision-safe material ID', () => {
  const source = base()
  source.materials.push({ id: 'inspection-clay', shader: 'principled', parameters: { roughness: .1 } })
  source.entities.push({ ...structuredClone(source.entities[0]), id: 'background', tags: ['environment'] })
  source.animationTracks = [{ id: 'animate-material', targetKind: 'material', targetEntityId: 'default-surface', property: 'roughness',
    keyframes: [{ frame: 1, value: .1 }, { frame: 48, value: .8 }] }]
  const before = structuredClone(source), transformed = diagnosticSpec(source, 'clay')
  assert.deepEqual(source, before)
  assert.equal(transformed.entities[0].materialId, 'inspection-clay-1')
  assert.equal(transformed.entities[1].materialId, 'default-surface')
  assert.deepEqual(transformed.entities[0].generator, diagnosticSpec(source, 'beauty').entities[0].generator)
  assert.deepEqual(transformed.animationTracks, diagnosticSpec(source, 'beauty').animationTracks)
})

test('beauty and clay publish distinct immutable sets without touching revision, checkpoint, QA, or default previews', async t => {
  const f = await setup(t), revision = join(f.project, 'revisions/r0001')
  writeFileSync(join(revision, 'scene.blend'), 'original checkpoint')
  mkdirSync(join(revision, 'previews'), { recursive: true }); writeFileSync(join(revision, 'previews/default.png'), 'existing preview')
  const before = snapshot(revision), projectBefore = readFileSync(join(f.project, 'project.json'))
  const material = await f.render({ mode: 'beauty' }), clay = await f.render(), again = await f.render()
  assert.notEqual(clay.artifacts[0].path, again.artifacts[0].path)
  assert.equal(clay.sourceCheckpointSha256, sha256('original checkpoint'))
  assert.notEqual(clay.sourceSpecHash, clay.derivedSpecHash)
  assert.equal(material.sourceSpecHash, material.derivedSpecHash)
  for (const result of [material,clay,again]) {
    assert.equal(result.execution.transport, 'batch')
    assert.equal(result.sourceRevision, 'r0001')
    assert.equal(result.artifacts[0].sha256, sha256((await f.studio.readArtifact({ projectId: f.projectId, path: result.artifacts[0].path })).bytes))
    assert.equal(result.artifacts[0].samples, 8)
    assert.equal(result.job.status, 'succeeded')
    assert.ok(existsSync(join(f.project, result.artifacts[0].resultPath)))
  }
  assert.ok(f.calls.every(call => call.request.session === false))
  assert.ok(f.calls.filter(call => call.phase === 'render').every(call => call.request.track.length === 0))
  const after = snapshot(revision); delete after.diagnostics
  assert.deepEqual(after, before); assert.deepEqual(readFileSync(join(f.project, 'project.json')), projectBefore)
  const sets = await f.studio.listPreviewSets({ projectId: f.projectId })
  assert.equal(sets.revisions[0].diagnostics.length, 3); assert.deepEqual(sets.revisions[0].previews, [])
  assert.deepEqual(readdirSync(join(f.project, 'staging')), [])
})

test('sample budget reduction is recorded and old selected revisions remain explicitly selected', async t => {
  const f = await setup(t)
  await f.studio.applyScenePatch({ projectId: f.projectId, baseRevision: 'r0001', saveCheckpoint: false, renderPreview: false,
    operations: [{ op: 'material.parameter.update', materialId: 'default-surface', parameter: 'roughness', value: .2 }] })
  const result = await f.render({ samples: 100 })
  assert.equal(result.sourceRevision, 'r0001'); assert.equal(result.artifacts[0].samples, 32)
  assert.equal(result.warnings[0].code, 'RENDER_SAMPLES_REDUCED')
  const sets = await f.studio.listPreviewSets({ projectId: f.projectId })
  assert.equal(sets.currentRevision, 'r0002'); assert.equal(sets.revisions.find(row => row.revision === 'r0002').diagnostics.length, 0)
})

for (const [label, change] of [
  ['missing revision',{ revision: undefined }], ['unknown mode',{ mode: 'final' }], ['no views',{ views: [] }],
  ['bad camera',{ views: [{ id: 'selected', cameraId: 'absent', frame: 1 }] }],
  ['fractional frame',{ views: [{ id: 'selected', cameraId: 'camera-main', frame: 1.5 }] }],
  ['outside range',{ views: [{ id: 'selected', cameraId: 'camera-main', frame: 49 }] }],
  ['unsafe ID',{ views: [{ id: '../bad', cameraId: 'camera-main', frame: 1 }] }],
  ['duplicate ID',{ views: [1,2].map(frame => ({ id: 'same', cameraId: 'camera-main', frame })) }],
  ['too many views',{ views: Array.from({ length: 9 }, (_,index) => ({ id: `view${index}`, cameraId: 'camera-main', frame: index + 1 })) }],
  ['resolution budget',{ width: 2049 }], ['zero samples',{ samples: 0 }], ['unsupported engine',{ engine: 'workbench' }],
]) test(`invalid inspection refuses before Blender: ${label}`, async t => {
  const f = await setup(t)
  await assert.rejects(f.render(change)); assert.equal(f.calls.length, 0); await emptyDiagnostics(f)
})

for (const phase of ['compile','render']) for (const cancellation of [false,true]) {
  test(`${phase} ${cancellation ? 'cancellation' : 'failure'} keeps the lock until unwind, cleans staging and permits retry`, async t => {
    let enter, release, first = true
    const entered = new Promise(resolve => { enter = resolve })
    const options = { [phase]: async request => {
      if (!first) return; first = false
      await new Promise((resolve,reject) => {
        release = reject; request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); enter()
      })
    } }
    const f = await setup(t, options), before = snapshot(join(f.project, 'revisions/r0001'))
    const controller = new AbortController(), promise = f.render({ signal: controller.signal })
    const rejected = assert.rejects(promise, cancellation ? { code: 'BLENDER_ABORTED' } : undefined)
    await entered
    await assert.rejects(f.render(), { code: 'RENDER_JOB_CONFLICT' })
    if (cancellation) controller.abort(); else release(Error('Synthetic runtime failure'))
    await rejected; await emptyDiagnostics(f)
    assert.deepEqual(snapshot(join(f.project, 'revisions/r0001')), before)
    await f.render(); assert.equal((await f.studio.listPreviewSets({ projectId: f.projectId })).revisions[0].diagnostics.length, 1)
  })
}

for (const [label, edit] of [
  ['missing second view', result => result.report.views.pop()],
  ['missing camera facts', result => delete result.report.views[1].cameraFacts],
  ['wrong frame', result => result.report.views[1].frame++],
  ['missing render facts', result => delete result.report.views[1].renderConfig],
  ['unrequested engine', result => { result.report.views[1].engine = 'BLENDER_WORKBENCH'; result.report.views[1].renderConfig.engine = 'BLENDER_WORKBENCH' }],
  ['missing exposure', result => delete result.report.views[1].renderConfig.exposure],
  ['missing sensor facts', result => delete result.report.views[1].cameraFacts.sensorWidth],
  ['missing DOF optics', result => delete result.report.views[1].cameraFacts.dof.apertureFstop],
  ['nonfinite focus transform', result => result.report.views[1].cameraFacts.dof.focusObject = { name: 'focus', entityId: null, matrixWorld: null }],
  ['wrong dimensions', result => result.report.views[1].width++],
  ['nonfinite matrix', result => result.report.views[1].cameraFacts.matrixWorld[0][0] = Infinity],
  ['missing bytes', result => delete result.pngs.second],
  ['corrupt PNG', result => result.pngs.second = Buffer.from('not actually PNG bytes')],
  ['PNG/report conflict', result => result.pngs.second = encodePng(createImage(2,2,[0,0,0,255]))],
]) test(`all-or-nothing publication: ${label}`, async t => {
  const f = await setup(t, { edit })
  await assert.rejects(f.render({ views: [...f.request.views,{ id: 'second', cameraId: 'camera-main', frame: 2 }] }))
  await emptyDiagnostics(f)
})

test('asset copies are rehashed, deduplicated, and never retained with diagnostic images', async t => {
  const f = await setup(t), bytes = encodePng(createImage(2,2,[20,30,40,255])), path = `assets/raw/${sha256(bytes)}.png`
  mkdirSync(join(f.project, 'assets/raw'), { recursive: true }); writeFileSync(join(f.project, path), bytes)
  await f.studio.applyScenePatch({ projectId: f.projectId, baseRevision: 'r0001', saveCheckpoint: false, renderPreview: false,
    operations: ['first','second'].map(id => ({ op: 'asset.add', asset: { id, type: 'png', path, sha256: sha256(bytes) } })) })
  const result = await f.render({ revision: 'r0002' })
  assert.equal(result.sourceAssets.length, 2)
  assert.deepEqual(readFileSync(join(f.project, path)), bytes)
  const files = readdirSync(join(f.project, 'revisions/r0002/diagnostics', result.job.jobId))
  assert.deepEqual(files.sort(), ['derived-scene-spec.json','result.json','selected.png'])
  writeFileSync(join(f.project, path), Buffer.from('tampered source'))
  await assert.rejects(f.render({ revision: 'r0002' }), { code: 'ASSET_HASH_MISMATCH' })
})

test('cached physics refuses both modes instead of silently re-baking', () => {
  for (const key of ['rigidBody','cloth','softBody','fluid']) for (const mode of ['beauty','clay']) {
    const spec = base(); spec.entities[0][key] = {}
    assert.throws(() => diagnosticSpec(spec, mode), { code: 'BLENDER_UNSUPPORTED_ACTION' })
  }
})

test('an earlier image alias cannot bypass a GLB external-dependency check on the same copied path', async t => {
  const document = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/external.bin', byteLength: 12 }] }))
  const json = Buffer.alloc(Math.ceil(document.length / 4) * 4, 32); document.copy(json)
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2,4); header.writeUInt32LE(20 + json.length,8)
  header.writeUInt32LE(json.length,12); header.writeUInt32LE(0x4e4f534a,16)
  const bytes = Buffer.concat([header,json]), f = await setup(t), path = 'assets/raw/alias.png'
  mkdirSync(join(f.project, 'assets/raw'), { recursive: true }); writeFileSync(join(f.project,path),bytes)
  // Inject an existing legacy revision so this exercises the independent inspection
  // guard; new patch submission already refuses this declaration.
  const legacy=f.studio.store.readRevisionSpec(f.projectId,'r0001')
  legacy.assets=[{id:'image-alias',type:'png',path,sha256:sha256(bytes)},{id:'model-alias',type:'glb',path,sha256:sha256(bytes)}]
  legacy.entities.push({id:'imported',type:'asset-instance',assetId:'model-alias'})
  writeFileSync(join(f.project,'revisions/r0001/scene-spec.json'),JSON.stringify(legacy))
  await assert.rejects(f.render({ revision: 'r0001' }), { code: 'ASSET_REQUEST_INVALID' })
  assert.equal(f.calls.length, 0)
  assert.deepEqual((await f.studio.listPreviewSets({ projectId: f.projectId })).revisions.find(row => row.revision === 'r0001').diagnostics, [])
})

test('pre-aborted request launches no runtime and creates no diagnostic output', async t => {
  const f = await setup(t), controller = new AbortController(); controller.abort()
  await assert.rejects(f.render({ signal: controller.signal }), { code: 'BLENDER_ABORTED' }); assert.equal(f.calls.length, 0); await emptyDiagnostics(f)
})

test('fixed diagnostics stage complete glTF/GLB bundles once for repeated aliases', async t => {
  for (const format of ['gltf','glb','obj']) {
    let model, compiled
    const f=await setup(t,{compile:request=>{
      const input=JSON.parse(readFileSync(request.sceneSpecPath));compiled=input.assets
      for (const asset of input.assets) {
        const lock=verifyAssetBundle(request.projectRoot,asset)
        assert.equal(lock.files.length,3)
        for (const member of [...lock.files,{path:BUNDLE_LOCK}]) assert.deepEqual(readFileSync(join(request.projectRoot,'assets/bundles',model.bundle.sha256,member.path)),readFileSync(join(f.project,'assets/bundles',model.bundle.sha256,member.path)))
      }
    }})
    const source=join(f.root,'source');mkdirSync(source);writeFileSync(join(source,'model.bin'),Buffer.alloc(12));writeFileSync(join(source,'paint.png'),encodePng(createImage(2,2,[12,145,36,255])))
    const doc={asset:{version:'2.0'},buffers:[{uri:'model.bin',byteLength:12}],images:[{uri:'paint.png'}]}
    const file=join(source,'model.'+format)
    if (format==='obj') { writeFileSync(file,'mtllib paint.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');writeFileSync(join(source,'paint.mtl'),'newmtl paint\nmap_Kd paint.png\n') }
    else writeFileSync(file,format==='gltf'?JSON.stringify(doc):encodeGlb(doc))
    model=await f.studio.ingestAsset({projectId:f.projectId,sourcePath:file,assetId:'model'})
    const declaration={id:'model',type:format,path:model.path,sha256:model.sha256}
    await f.studio.applyScenePatch({projectId:f.projectId,baseRevision:'r0001',saveCheckpoint:false,operations:[{op:'asset.add',asset:declaration},{op:'asset.add',asset:{...declaration,id:'alias'}}]})
    const before=snapshot(join(f.project,'assets/bundles')),result=await f.render({revision:'r0002'})
    assert.equal(compiled.length,2);assert.equal(result.sourceAssets.length,2);assert.deepEqual(snapshot(join(f.project,'assets/bundles')),before)
    assert(!readdirSync(join(f.project,'staging')).some(n=>n.startsWith('.diagnostic-')))
  }
})

test('whole asset bounds cannot expand an ordinary entity and missing framing cameras are refused before runtime', async t => {
  const f = await setup(t, { saveCheckpoint: true }), entityId = base().entities[0].id
  let calls = 0
  f.runtime.inspectGeometry = async request => { calls++; return geometryReport(request) }
  const before = snapshot(f.project)
  for (const geometry of [
    { entityIds: [entityId], frame: 1, assetInstanceIds: [entityId] },
    { entityIds: [entityId], frame: 1, cameraId: 'missing-camera' },
  ]) await assert.rejects(f.studio.getScene(f.projectId, { geometry }), { code: BlenderErrorCode.SCENE_SPEC_INVALID })
  assert.equal(calls, 0)
  assert.deepEqual(snapshot(f.project), before)
})

test('explicit native framing refuses an old runtime, keeps revision bytes and returns only the requested frame', async t => {
  const f = await setup(t, { saveCheckpoint: true }), entityId = base().entities[0].id
  const geometry = { entityIds: [entityId], frame: 17, cameraId: 'camera-main', cameraMargin: .1 }
  const before = snapshot(f.project)
  f.runtime.inspectGeometry = async request => geometryReport(request)
  await assert.rejects(f.studio.getScene(f.projectId, { geometry }), { code: BlenderErrorCode.RUNTIME_UNAVAILABLE })
  f.runtime.inspectGeometry = async request => {
    assert.equal(request.cameraId, geometry.cameraId); assert.equal(request.cameraMargin, .1)
    const result = geometryReport(request)
    result.report.schemaVersion = 'deepblend.geometry-inspection/v4'
    result.report.camera = { id: 'camera-main', type: 'PERSP', margin: .1, clipStartMeters: .1, clipEndMeters: 100 }
    result.report.objects[0].cameraProjection = { status: 'measured', nearestDepthMeters: 4, farthestDepthMeters: 5,
      containedInClip: true, normalizedBounds: { min: [.2,.2], max: [.8,.8] }, containedInFrame: true }
    return result
  }
  const result = await f.studio.getScene(f.projectId, { geometry })
  assert.equal(result.geometryInspection.schemaVersion, 'deepblend.scene-geometry/v4')
  assert.equal(result.geometryInspection.frame, 17)
  assert.equal(result.geometryInspection.camera.margin, .1)
  assert.ok(result.geometryInspection.limitations.some(text => text.includes('ONE reported frame')))
  assert.deepEqual(snapshot(f.project), before)
})
