/** Saved native calibration, complete imported hierarchy and atomic refusal evidence. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(process.env.DEEPBLEND_CAMERA_FIT_OUTPUT || join(root, '.deepblend/quality', 'camera-fit-' + Date.now()))
assert(!existsSync(output), 'Preserve existing camera-fit evidence: ' + output); mkdirSync(output, { recursive: true })
const blender = process.env.DEEPBLEND_BLENDER_PATH || join(root, '.tools/Blender.app/Contents/MacOS/Blender')
const json = (name, value) => { const path = join(output, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); return path }
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const checks = [], calls = [], receipts = [], oracleRequests = [], history = {}, startedAt = new Date().toISOString()
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); assert(ok, name) }
function python(label, body, args = []) {
  const script = join(output, label + '.py'); writeFileSync(script, body)
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(join(output, label + '.log'), (result.stdout || '') + (result.stderr || ''))
  assert.equal(result.status, 0, label + ': ' + (result.error?.message || result.stderr)); return result
}
function protect(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) protect(path); else history[path] = sha(path)
  }
}
const generate = String.raw`
import bpy,sys
from pathlib import Path
path=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
root=bpy.data.objects.new('product-root',None);bpy.context.scene.collection.objects.link(root)
root.location=(.2,-.1,.3);root.rotation_euler.z=.4
nested=bpy.data.objects.new('nested-parts',None);bpy.context.scene.collection.objects.link(nested)
nested.parent=root;nested.location=(0,.2,.1);nested.scale=(1.2,.8,1.1)
bpy.ops.mesh.primitive_cube_add(size=.6);body=bpy.context.object;body.name='body';body.parent=nested;body.location.z=.3
bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=.18);cap=bpy.context.object;cap.name='cap';cap.parent=nested;cap.location=(.1,0,.8)
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB')
`
// This oracle imports no DeepBlend Python helper or fit formula. Blender's own
// projector evaluates every saved vertex; baseline preservation is read afresh.
const oracle = String.raw`
import bpy,sys,json,math
from pathlib import Path
from bpy_extras.object_utils import world_to_camera_view
requests,out=sys.argv[sys.argv.index('--')+1:]
def matrix(value):return [[float(v) for v in row] for row in value]
def near(a,b):
    if isinstance(a,(int,float)) and isinstance(b,(int,float)):return abs(a-b)<=.00002
    if isinstance(a,list) and isinstance(b,list):return len(a)==len(b) and all(near(x,y) for x,y in zip(a,b))
    if isinstance(a,dict) and isinstance(b,dict):return a.keys()==b.keys() and all(near(a[k],b[k]) for k in a)
    return a==b
def capture(path,request,camera_id):
    bpy.ops.wm.open_mainfile(filepath=path,load_ui=False,use_scripts=False)
    scene=bpy.context.scene;scene.frame_set(request['frame']);bpy.context.view_layer.update();graph=bpy.context.evaluated_depsgraph_get()
    camera=bpy.data.objects['db_camera__'+camera_id].evaluated_get(graph)
    facts={};selected=[];mesh_count=0
    for obj in scene.objects:
        evaluated=obj.evaluated_get(graph)
        fact={'type':obj.type,'parent':obj.parent.name if obj.parent else None,'matrix':matrix(evaluated.matrix_world),'hideRender':obj.hide_render}
        if obj.type=='MESH':
            mesh=evaluated.to_mesh()
            try:
                fact['geometry']={'vertices':[[float(v) for v in p.co] for p in mesh.vertices],'faces':[list(p.vertices) for p in mesh.polygons],
                    'uv':[[[float(v) for v in p.uv] for p in layer.data] for layer in mesh.uv_layers],
                    'slots':[slot.material.name if slot.material else None for slot in obj.material_slots]}
            finally:evaluated.to_mesh_clear()
        if obj.type=='CAMERA':
            d=obj.data;fact['optics']={'lens':d.lens,'sensorWidth':d.sensor_width,'sensorHeight':d.sensor_height,'sensorFit':d.sensor_fit,
                'shift':[d.shift_x,d.shift_y],'clip':[d.clip_start,d.clip_end],'dof':d.dof.use_dof,'fStop':d.dof.aperture_fstop,'focus':d.dof.focus_distance}
        facts[obj.name]=fact
    for entity_id in request['entityIds']:
        root=bpy.data.objects['db_entity__'+entity_id];pending=[root];points=[]
        while pending:
            obj=pending.pop();pending.extend(obj.children)
            if obj.type!='MESH':continue
            mesh_count+=1;evaluated=obj.evaluated_get(graph);mesh=evaluated.to_mesh()
            try:
                for vertex in mesh.vertices:
                    world=evaluated.matrix_world@vertex.co
                    p=world_to_camera_view(scene,camera,world)
                    points.append({'world':[float(v) for v in world],'projection':[float(v) for v in p]})
            finally:evaluated.to_mesh_clear()
        selected.append({'id':entity_id,'points':points})
    return {'facts':facts,'selected':selected,'meshes':mesh_count,'rotation':matrix(camera.matrix_world.normalized().to_3x3()),
        'optics':facts[camera.original.name]['optics'],'view':[scene.render.resolution_x,scene.render.resolution_y,scene.render.resolution_percentage]}
results=[]
for request in json.loads(Path(requests).read_text()):
    before=capture(request['baseline'],request,request['cameraId']);after=capture(request['candidate'],request,request['fittedCameraId'])
    new=after['facts'].pop('db_camera__'+request['fittedCameraId'])
    points=[p['projection'] for member in after['selected'] for p in member['points']]
    geometry=all(a['id']==b['id'] and len(a['points'])==len(b['points']) and all(near(p['world'],q['world']) for p,q in zip(a['points'],b['points'])) for a,b in zip(before['selected'],after['selected']))
    old_optics={k:v for k,v in before['optics'].items() if k!='focus'};new_optics={k:v for k,v in after['optics'].items() if k!='focus'}
    near_clip,far_clip=after['optics']['clip'];margin=request['margin']
    results.append({'label':request['label'],'memberCount':len(after['selected']),'meshCount':after['meshes'],'vertexCount':len(points),
        'allVerticesInside':all(margin<=p[0]<=1-margin and margin<=p[1]<=1-margin and near_clip<=p[2]<=far_clip for p in points),
        'projectionBounds':{'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]},
        'selectedWorldGeometryUnchanged':geometry,'allOriginalObjectsUnchanged':near(before['facts'],after['facts']),
        'sourceOpticsAndRollPreserved':near(old_optics,new_optics) and near(before['rotation'],after['rotation']),
        'view':after['view'],'newFocusDistance':after['optics']['focus']})
Path(out).write_text(json.dumps(results,indent=2))
`
const ctx = new Context(); ctx.plugin(LocalSubprocess)
ctx.plugin(Provider, { blenderPath: blender, workspaceRoot: output, timeoutMs: 180000 })
ctx.plugin(Studio, { workspaceRoot: output, projectsRoot: join(output, 'projects'), reconcileOnStart: false, maxPreviewSamples: 8 })
let failure, studio, runtime
try {
  await new Promise(resolve => setTimeout(resolve, 100)); studio = ctx.get('blenderStudio'); runtime = ctx.get('blenderRuntime')
  assert(studio && runtime)
  for (const method of ['compileScene', 'inspectCameraFit', 'renderPreview']) {
    const original = runtime[method].bind(runtime)
    runtime[method] = input => { calls.push({ method, frame: input.frame, session: input.session, candidate: input.baselineCheckpointPath !== undefined }); return original(input) }
  }
  python('generate-nested-product', generate, [join(output, 'nested-product.glb')])
  let last
  for (const [label, resolution] of [['portrait', [384, 512]], ['landscape', [512, 384]]]) {
    const scene = defaultSceneSpec({ projectId: 'calibrated-' + label, title: 'Calibrated complete view ' + label })
    scene.project.aspectRatio = label === 'portrait' ? '3:4' : '4:3'
    scene.entities = [
      { id: 'peg', type: 'generator', generator: { shape: 'cube', size: .4 }, materialId: 'default-surface', transform: { location: [5.8, 3, 1], rotationEuler: [.2, .1, .3], scale: [1.2, .7, 1.4] } },
      { id: 'hidden-peg', type: 'generator', generator: { shape: 'cube', size: .2 }, materialId: 'default-surface', visible: false, transform: { location: [8, 3, 1] } },
      { id: 'unrelated-marker', type: 'generator', generator: { shape: 'cube', size: .1 }, materialId: 'default-surface', transform: { location: [-2, 0, .2] } },
    ]
    scene.cameras = [
      { id: 'vertical-shift-roll', lens: 85, sensorWidth: 36, sensorHeight: 32, sensorFit: 'VERTICAL', shift: [.75, -.3], clipping: [.1, 1000], fStop: 5.6, focusDistance: 1.8, transform: { location: [0, 0, .5], rotationEuler: [1.1, .2, .4] } },
      { id: 'horizontal-shift-roll', lens: 35, sensorWidth: 32, sensorHeight: 24, sensorFit: 'HORIZONTAL', shift: [-.23, .15], clipping: [.05, 1000], transform: { location: [-.2, 0, .3], rotationEuler: [.8, -.5, -.7] } },
      { id: 'too-short-clipping', lens: 85, clipping: [.01, .1], transform: { location: [0, 0, .5], rotationEuler: [1.1, .2, .4] } },
    ]
    scene.shots = [{ id: 'original-shot', cameraId: 'vertical-shift-roll', frameRange: [1, 48] }]
    scene.animationTracks = [{ id: 'camera-roll', targetKind: 'camera', targetEntityId: 'vertical-shift-roll', property: 'rotationEuler.z', keyframes: [{ frame: 1, value: .2 }, { frame: 48, value: .6 }] }]
    scene.renderProfiles.preview = { engine: 'cycles', resolution, samples: 8, maxSamplesBudget: 8, filmTransparent: false, colorManagement: { viewTransform: 'AgX' } }
    const created = await studio.createProject({ title: scene.project.title, sceneSpec: scene, saveCheckpoint: true, renderPreview: false })
    const id = created.projectId, project = studio.store.projectDirectory(id)
    const upload = await studio.uploadAsset({ projectId: id, name: 'nested-product.glb', mediaType: 'model/gltf-binary', stream: createReadStream(join(output, 'nested-product.glb')), license: 'Original fixture authored by this test' })
    const imported = await studio.applyScenePatch({ projectId: id, baseRevision: created.currentRevision, saveCheckpoint: true, renderPreview: false, operations: [
      { op: 'asset.add', asset: upload.asset }, { op: 'entity.add', entity: { id: 'imported-product', type: 'asset-instance', assetId: upload.asset.id, transform: { location: [6, 3, 1], rotationEuler: [.12, -.18, .45], scale: [1.3, .75, 1.1] } } },
    ] })
    protect(studio.store.revisionDirectory(id, created.currentRevision)); protect(studio.store.revisionDirectory(id, imported.revision)); protect(join(project, 'assets'))
    for (const cameraId of ['vertical-shift-roll', 'horizontal-shift-roll']) {
      const baseRevision = studio.store.currentRevision(id), before = studio.store.readRevisionSpec(id, baseRevision), start = calls.length
      const request = { projectId: id, baseRevision, entityIds: ['imported-product', 'peg'], cameraId, fittedCameraId: 'fit-' + cameraId, frame: 12, margin: .03, renderPreview: label === 'portrait' && cameraId === 'vertical-shift-roll', idempotencyKey: label + '-' + cameraId }
      const result = await studio.fitCamera(request), after = studio.store.readRevisionSpec(id, result.revision)
      check(label + ' ' + cameraId + ': only one static camera is added, preserving every original field', isDeepStrictEqual(before, { ...after, cameras: after.cameras.filter(camera => camera.id !== request.fittedCameraId) }))
      check(label + ' ' + cameraId + ': complete imported hierarchy and generated mesh are independently fitted', result.cameraFitReceipt.members.length === 2
        && result.cameraFitReceipt.members.find(member => member.entityId === 'imported-product').meshObjectCount === 2
        && result.cameraFitReceipt.members.every(member => member.projection.containedInFrame && member.projection.containedInClip))
      const actual = calls.slice(start)
      check(label + ' ' + cameraId + ': one isolated compile, two native inspections and only the requested preview', actual.filter(call => call.method === 'compileScene').length === 1
        && actual.filter(call => call.method === 'inspectCameraFit').length === 2 && actual.filter(call => call.method === 'renderPreview').length === Number(request.renderPreview)
        && actual.filter(call => call.method === 'renderPreview').every(call => call.frame === 12 && call.session === false))
      oracleRequests.push({ label: label + '-' + cameraId, baseline: studio.store.checkpointPath(id, baseRevision), candidate: studio.store.checkpointPath(id, result.revision), ...request })
      receipts.push({ request, result }); protect(studio.store.revisionDirectory(id, result.revision)); last = { id, project, result, request }
    }
    for (const [kind, changes, code] of [
      ['far clip cannot contain complete selection', { cameraId: 'too-short-clipping', entityIds: ['imported-product', 'peg'] }, 'SCENE_VALIDATION_FAILED'],
      ['hidden selected member cannot be omitted', { cameraId: 'horizontal-shift-roll', entityIds: ['hidden-peg', 'imported-product'] }, 'BLENDER_UNSUPPORTED_ACTION'],
    ]) {
      const record = studio.store.readRecord(id), revisions = readdirSync(join(project, 'revisions')), start = calls.length
      let refusal
      try { await studio.fitCamera({ projectId: id, baseRevision: record.currentRevision, ...changes, fittedCameraId: 'refused-view', frame: 12, margin: .03, renderPreview: true, idempotencyKey: label + '-' + code }) }
      catch (error) { refusal = { code: error.code, message: error.message } }
      check(label + ': ' + kind + ' is atomic and renders nothing', refusal?.code === code && isDeepStrictEqual(record, studio.store.readRecord(id))
        && isDeepStrictEqual(revisions, readdirSync(join(project, 'revisions'))) && calls.slice(start).every(call => call.method === 'inspectCameraFit')
        && readdirSync(join(project, 'staging')).length === 0)
      receipts.push({ refusal, changes })
    }
  }
  const record = studio.store.readRecord(last.id), revisions = readdirSync(join(last.project, 'revisions')), originalCompile = runtime.compileScene.bind(runtime)
  let mutated = false; const start = calls.length
  runtime.compileScene = input => originalCompile({ ...input, onWorkingDirectory: async info => {
    const path = join(info.directory, 'result.blend')
    python('mutate-actual-candidate', `import bpy,sys\np=sys.argv[sys.argv.index('--')+1]\nbpy.ops.wm.open_mainfile(filepath=p,load_ui=False,use_scripts=False)\nbpy.data.objects['db_camera__faulty-view'].location.x+=50\nbpy.context.view_layer.update()\nbpy.ops.wm.save_as_mainfile(filepath=p,check_existing=False)\n`, [path])
    copyFileSync(path, join(output, 'refused-actual-camera-candidate.blend')); mutated = true
    await input.onWorkingDirectory?.(info)
  } })
  let refusal
  try { await studio.fitCamera({ ...last.request, baseRevision: record.currentRevision, fittedCameraId: 'faulty-view', renderPreview: true, idempotencyKey: 'actual-candidate-fault' }) }
  catch (error) { refusal = { code: error.code, message: error.message } }
  finally { runtime.compileScene = originalCompile }
  json('actual-candidate-refusal.json', refusal)
  check('an actually displaced compiled fitted camera reaches native verification and is refused before preview/publication', mutated && refusal?.code === 'SCENE_VALIDATION_FAILED'
    && calls.slice(start).filter(call => call.method === 'inspectCameraFit').length === 2 && !calls.slice(start).some(call => call.method === 'renderPreview')
    && isDeepStrictEqual(record, studio.store.readRecord(last.id)) && isDeepStrictEqual(revisions, readdirSync(join(last.project, 'revisions')))
    && readdirSync(join(last.project, 'staging')).length === 0 && !readdirSync(last.project).some(name => name.startsWith('.camera-fit-')))
  const requests = json('independent-requests.json', oracleRequests), oracleResult = join(output, 'independent-projection.json')
  python('independent-native-reopen', oracle, [requests, oracleResult])
  for (const row of JSON.parse(readFileSync(oracleResult))) check(row.label + ': separate native projector verifies complete geometry, original objects and calibrated roll/optics', row.memberCount === 2 && row.meshCount === 3 && row.vertexCount > 100
    && row.allVerticesInside && row.selectedWorldGeometryUnchanged && row.allOriginalObjectsUnchanged && row.sourceOpticsAndRollPreserved && row.newFocusDistance > 0, row)
  check('all prior native/spec/recipe/preview/manifest and imported asset bytes remain exact', Object.entries(history).every(([path, hash]) => sha(path) === hash))
  json('protected-history.json', history); json('calls.json', calls); json('receipts.json', receipts)
} catch (error) { failure = { code: error.code, message: error.message, stack: error.stack }; json('failure.json', failure); console.error(error) }
finally {
  try { await ctx.fiber.dispose() } catch (error) { failure ??= { message: error.message } }
  json('summary.json', { status: failure ? 'failed' : 'passed', startedAt, finishedAt: new Date().toISOString(), checks, failure,
    scope: 'Actual Host/provider portrait+landscape calibrated source cameras, roll animation, large lens shifts, two-mesh nested imported instance plus generated member, native far-clip/hidden-member and actual corrupted-candidate refusal. Separate Blender projector reads every saved vertex. Maintainer acceptance, no paid model or artistic claim.' })
  process.exitCode = failure ? 1 : 0
}
