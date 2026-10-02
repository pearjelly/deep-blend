import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, sha256 } from '@deepblend/dsh-blender-contracts'
import { defaultSceneSpec } from '@deepblend/dsh-blender-host/revision-transaction'
import { diagnosticSpec } from '../../../packages/deepblend/host/lib/diagnostic-preview.js'

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
  const created = await studio.createProject({ title: 'Inspection', saveCheckpoint: false, sceneSpec: options.spec ?? base() })
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
  await f.studio.applyScenePatch({ projectId: f.projectId, baseRevision: 'r0001', saveCheckpoint: false, renderPreview: false,
    operations: [
      { op: 'asset.add', asset: { id: 'image-alias', type: 'png', path, sha256: sha256(bytes) } },
      { op: 'asset.add', asset: { id: 'model-alias', type: 'glb', path, sha256: sha256(bytes) } },
      { op: 'entity.add', entity: { id: 'imported', type: 'asset-instance', assetId: 'model-alias' } },
    ] })
  await assert.rejects(f.render({ revision: 'r0002' }), { code: 'ASSET_REQUEST_INVALID' })
  assert.equal(f.calls.length, 0)
  assert.deepEqual((await f.studio.listPreviewSets({ projectId: f.projectId })).revisions.find(row => row.revision === 'r0002').diagnostics, [])
})

test('pre-aborted request launches no runtime and creates no diagnostic output', async t => {
  const f = await setup(t), controller = new AbortController(); controller.abort()
  await assert.rejects(f.render({ signal: controller.signal }), { code: 'BLENDER_ABORTED' }); assert.equal(f.calls.length, 0); await emptyDiagnostics(f)
})
