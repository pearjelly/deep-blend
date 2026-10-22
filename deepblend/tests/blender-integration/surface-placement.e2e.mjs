/** Real Host placement, independently reopened geometry, and immutable revision evidence. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { BlenderErrorCode, decodePng } from '@deepblend/dsh-blender-contracts'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'

const ROOT = resolve(import.meta.dirname, '../../..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const output = resolve(process.env.DEEPBLEND_PLACEMENT_OUTPUT
  ?? join(ROOT, '.deepblend/quality', `surface-placement-${new Date().toISOString().replaceAll(':', '-')}`))
assert(!existsSync(output), `Preserve existing evidence: ${output}`)
mkdirSync(output, { recursive: true })
const sources = join(output, 'sources'), workspace = join(output, 'workspace')
mkdirSync(sources); mkdirSync(workspace)
const started = Date.now(), checks = [], calls = [], previews = [], inspections = [], receipts = [], protectedRevisions = new Map()
const FRAME = 12, CLEARANCE_MM = 1.5, TOLERANCE = .00002
let projectId, failure = null
const digest = value => createHash('sha256').update(value).digest('hex')
const fileHash = path => digest(readFileSync(path))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  assert(ok, `${name}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`)
}
function directoryHashes(directory) {
  const hashes = {}
  function walk(path, prefix = '') {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), key = prefix + name
      if (statSync(full).isDirectory()) walk(full, key + '/')
      else hashes[key] = fileHash(full)
    }
  }
  walk(directory)
  return hashes
}
function runPython(name, body, args) {
  const script = join(output, name + '.py')
  writeFileSync(script, body)
  const result = spawnSync(BLENDER, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(output, name + '.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  assert.equal(result.status, 0, `${name}: ${result.error?.message ?? result.stderr?.slice(-2000)}`)
}

// These small assets are authored by the test. No downloaded model, helper
// workspace, private fixture, or product placement code is used to build them.
const GENERATE = String.raw`
import bpy,json,sys,struct
from pathlib import Path
root=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
assembly=bpy.data.objects.new('assembly',None); bpy.context.scene.collection.objects.link(assembly)
assembly.location=(.3,-.15,.06); assembly.rotation_euler.z=.35
nested=bpy.data.objects.new('nested',None); bpy.context.scene.collection.objects.link(nested)
nested.parent=assembly; nested.location=(0,.1,.05); nested.scale=(1.2,.9,1.1)
materials=[]
for name,color,metal,roughness in [('source-red',(.65,.02,.01,1),0,.32),('source-brass',(.65,.35,.08,1),1,.21)]:
    material=bpy.data.materials.new(name)
    shader=material.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value=color
    shader.inputs['Metallic'].default_value=metal
    shader.inputs['Roughness'].default_value=roughness
    materials.append(material)
bpy.ops.mesh.primitive_cube_add(size=1)
body=bpy.context.object; body.name='body'; body.parent=nested; body.scale=(.5,.32,.22); body.location.z=.11
for material in materials: body.data.materials.append(material)
for face in body.data.polygons: face.material_index=face.index%2
bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=.095)
cap=bpy.context.object; cap.name='cap'; cap.parent=nested; cap.location=(.12,0,.31)
cap.data.materials.append(materials[1])
path=root/'nested-product.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB')
raw=path.read_bytes(); chunks=[]; offset=12
while offset<len(raw):
    length,kind=struct.unpack_from('<II',raw,offset); payload=raw[offset+8:offset+8+length]
    if kind==0x4e4f534a:
        doc=json.loads(payload)
        body_node=next(node for node in doc['nodes'] if node.get('name')=='body')
        primitives=doc['meshes'][body_node['mesh']]['primitives']; assert len(primitives)==2
        primitives[1].pop('material')
        for mesh in doc['meshes']:
            for primitive in mesh['primitives']:
                primitive['attributes']['TEXCOORD_1']=primitive['attributes']['TEXCOORD_0']
        payload=json.dumps(doc,separators=(',',':')).encode(); payload+=b' '*(-len(payload)%4)
    chunks.append(struct.pack('<II',len(payload),kind)+payload); offset+=8+length
binary=b''.join(chunks); path.write_bytes(struct.pack('<4sII',b'glTF',2,len(binary)+12)+binary)
bpy.ops.wm.read_factory_settings(use_empty=True)
# Four disconnected planar strips leave the complete central square empty.
vertices=[]; faces=[]
for x0,x1,y0,y1 in [(-1,-.5,-1,1),(.5,1,-1,1),(-.5,.5,-1,-.5),(-.5,.5,.5,1)]:
    start=len(vertices); vertices.extend([(x0,y0,0),(x1,y0,0),(x1,y1,0),(x0,y1,0)])
    faces.append(tuple(range(start,start+4)))
mesh=bpy.data.meshes.new('open-centre'); mesh.from_pydata(vertices,[],faces); mesh.update()
obj=bpy.data.objects.new('ring',mesh); bpy.context.scene.collection.objects.link(obj)
bpy.ops.export_scene.gltf(filepath=str(root/'hole-support.glb'),export_format='GLB')
`

// Independent oracle: for a finite affine plane covering the entire subject,
// z - (intercept + slope*x) is affine on every triangle, so its minimum occurs
// at a vertex. Reopen saved files in a new Blender process and inspect actual
// evaluated vertices. This intentionally imports no product geometry solver.
const INSPECT = String.raw`
import bpy,json,sys,hashlib
from pathlib import Path
requests,out=sys.argv[sys.argv.index('--')+1:]
def checksum(value): return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
def vector(value): return [float(v) for v in value]
def matrix(value): return [vector(row) for row in value]
results=[]
for request in json.loads(Path(requests).read_text()):
    bpy.ops.wm.open_mainfile(filepath=request['checkpoint'],load_ui=False,use_scripts=False)
    bpy.context.scene.frame_set(request['frame']); bpy.context.view_layer.update()
    graph=bpy.context.evaluated_depsgraph_get()
    def capture(entity_id):
        root=bpy.data.objects['db_entity__'+entity_id]
        pending=[root]; hierarchy=[]; parts=[]; points=[]
        while pending:
            obj=pending.pop(); pending.extend(sorted(obj.children,key=lambda child:child.name,reverse=True))
            # matrix_local re-inverts the parent world transform and acquires
            # float noise when its world Z changes. The saved basis plus parent
            # inverse are the authored local transform, with no such inversion.
            local=matrix(obj.matrix_basis)
            if obj==root: local[2][3]=0
            hierarchy.append({'name':obj.name,'type':obj.type,'parent':obj.parent.name if obj.parent else None,
                'localExceptRootZ':local,'parentInverse':matrix(obj.matrix_parent_inverse)})
            if obj.type!='MESH': continue
            materials=[]
            for slot in obj.material_slots:
                if slot.material is None: materials.append(None); continue
                shader=slot.material.node_tree.nodes.get('Principled BSDF'); values={}
                for key in ['Base Color','Metallic','Roughness','Alpha']:
                    value=shader.inputs[key].default_value
                    values[key]=vector(value) if hasattr(value,'__len__') else float(value)
                materials.append({'name':slot.material.name,'values':values})
            geometry={'vertices':[vector(v.co) for v in obj.data.vertices],
                'faces':[list(face.vertices) for face in obj.data.polygons],
                'faceMaterials':[face.material_index for face in obj.data.polygons],
                'uvMaps':[{'name':layer.name,'uv':[vector(loop.uv) for loop in layer.data]} for layer in obj.data.uv_layers]}
            evaluated=obj.evaluated_get(graph); mesh=evaluated.to_mesh()
            try: world=[vector(evaluated.matrix_world@vertex.co) for vertex in mesh.vertices]
            finally: evaluated.to_mesh_clear()
            points.extend(world)
            parts.append({'name':obj.name,'localGeometryHash':checksum(geometry),'materials':materials,
                'uvMapCount':len(obj.data.uv_layers),'worldVertices':world})
        return {'hierarchy':hierarchy,'parts':parts,'worldVertices':points}
    subject=capture(request['subject']); support=capture(request['support'])
    intercept,slope=request['plane']; xmin,xmax,ymin,ymax=request['domain']
    gaps=[z-intercept-slope*x for x,y,z in subject['worldVertices']]
    results.append({'label':request['label'],'frame':bpy.context.scene.frame_current,
        'subject':subject,'support':support,'minimumGapMeters':min(gaps),
        'entireSubjectInsidePlaneDomain':all(xmin-1e-6<=x<=xmax+1e-6 and ymin-1e-6<=y<=ymax+1e-6 for x,y,z in subject['worldVertices']),
        'supportPlaneMaxErrorMeters':max(abs(z-intercept-slope*x) for x,y,z in support['worldVertices'])})
Path(out).write_text(json.dumps(results,indent=2))
`

const ctx = new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin(Provider, ProviderConfig({ blenderPath: BLENDER, workspaceRoot: workspace, timeoutMs: 120_000 }))
ctx.plugin(Studio, { workspaceRoot: workspace, projectsRoot: join(workspace, 'projects'), maxPreviewSamples: 16 })
let studio, runtime
try {
  for (let n = 0; n < 300 && !(studio = ctx.get('blenderStudio')); n++) await new Promise(done => setTimeout(done, 10))
  runtime = ctx.get('blenderRuntime')
  assert(studio && runtime, 'Real Host/Provider services must activate')
  await studio.awaitReconciliation()
  for (const method of ['compileScene', 'renderPreview', 'inspectSurfacePlacement']) {
    const original = runtime[method].bind(runtime)
    runtime[method] = async request => {
      calls.push({ method, frame: request.frame ?? null, session: request.session ?? null })
      return original(request)
    }
  }
  runPython('generate-fixtures', GENERATE, [sources])
  const scene = defaultSceneSpec({ projectId: 'surface-placement-proof', title: 'Surface placement proof' })
  scene.project.aspectRatio = '4:3'
  const cube = (id, location, size = .4) => ({ id, type: 'generator', generator: { shape: 'cube', size },
    materialId: 'default-surface', transform: { location, rotationEuler: [0, 0, 0], scale: [1, 1, 1] } })
  scene.entities = [
    { ...cube('subject', [.15, -.1, 1.1], .6), transform: { location: [.15, -.1, 1.1], rotationEuler: [.1, .15, .2], scale: [1.2, .8, 1.1] } },
    { id: 'ramp', type: 'generator', generator: { shape: 'plane', size: 4 }, materialId: 'default-surface',
      transform: { location: [0, 0, .2], rotationEuler: [0, -Math.atan(.2), 0], scale: [1, 1, 1] } },
    cube('flat-subject', [-8, 0, 1]),
    { id: 'flat', type: 'generator', generator: { shape: 'plane', size: 4 }, materialId: 'default-surface', transform: { location: [-8, 0, .2] } },
    cube('no-overlap', [8, 0, 1]), cube('hole-probe', [6, 0, 1], .2), cube('animated', [10, 0, 1]),
    cube('dependent-subject', [12, 0, 1]),
    { ...cube('dependent-geometry', [12, 0, 1], .7), modifiers: [{ type: 'boolean', operation: 'difference', targetEntityId: 'dependent-subject' }] },
  ]
  scene.animationTracks = [{ id: 'animated-motion', targetEntityId: 'animated', property: 'location.z',
    keyframes: [{ frame: 1, value: 1 }, { frame: 48, value: 1.5 }] }]
  delete scene.cameras[0].targetEntityId
  scene.cameras[0].targetPoint = [.15, 0, .55]
  scene.cameras[0].transform.location = [2.8, -3.8, 2.8]
  scene.renderProfiles.preview = { engine: 'cycles', resolution: [512, 384], samples: 16, maxSamplesBudget: 16,
    filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 } }
  const created = await studio.createProject({ title: 'Surface placement proof', sceneSpec: scene, saveCheckpoint: true, renderPreview: false })
  projectId = created.projectId
  const project = studio.store.projectDirectory(projectId)
  const revisionDirectory = revision => studio.store.revisionDirectory(projectId, revision)
  const checkpoint = revision => studio.store.checkpointPath(projectId, revision)
  const protect = revision => protectedRevisions.set(revision, directoryHashes(revisionDirectory(revision)))
  function addInspection(label, revision, subject, support, plane = [.2, .2], domain = [-2 / Math.sqrt(1.04), 2 / Math.sqrt(1.04), -2, 2]) {
    inspections.push({ label, checkpoint: checkpoint(revision), frame: FRAME, subject, support, plane, domain })
  }
  function savePreview(label, preview) {
    const path = join(project, preview.path), png = decodePng(readFileSync(path))
    check(`${label}: saved preview is a byte-bound 512×384 PNG at frame 12`,
      png.width === 512 && png.height === 384 && preview.frame === FRAME && fileHash(path) === preview.sha256)
    const evidence = join(output, label + '.png')
    copyFileSync(path, evidence); previews.push({ label, path, evidence, sha256: preview.sha256, frame: preview.frame })
  }
  async function place(label, subject, support, renderPreview) {
    const baseRevision = studio.store.currentRevision(projectId), before = studio.store.readRevisionSpec(projectId, baseRevision)
    protect(baseRevision)
    const request = { projectId, baseRevision, subjectEntityId: subject, supportEntityId: support,
      frame: FRAME, clearanceMm: CLEARANCE_MM, renderPreview, cameraId: 'camera-main', idempotencyKey: label }
    const callCount = calls.length, saved = await studio.placeOnSurface(request), receipt = saved.surfacePlacementReceipt
    const expected = structuredClone(before)
    expected.entities.find(entity => entity.id === subject).transform.location[2] += receipt.translationMeters[2]
    check(`${label}: formal Host operation changes only the selected root world Z`,
      JSON.stringify(studio.store.readRevisionSpec(projectId, saved.revision)) === JSON.stringify(expected)
      && receipt.translationMeters[0] === 0 && receipt.translationMeters[1] === 0)
    const actual = calls.slice(callCount)
    check(`${label}: one checkpoint and optional same-frame preview publish atomically with the receipt`,
      studio.store.currentRevision(projectId) === saved.revision && existsSync(checkpoint(saved.revision))
      && receipt.frame === FRAME && receipt.sourceCheckpointSha256 === fileHash(checkpoint(baseRevision))
      && receipt.resultCheckpointSha256 === fileHash(checkpoint(saved.revision))
      && JSON.stringify(studio.store.readRevisionManifest(projectId, saved.revision).surfacePlacementReceipt) === JSON.stringify(receipt)
      && actual.filter(call => call.method === 'compileScene').length === 1
      && actual.filter(call => call.method === 'inspectSurfacePlacement').length === 2
      && actual.filter(call => call.method === 'renderPreview').length === Number(renderPreview)
      && actual.filter(call => call.method === 'renderPreview').every(call => call.frame === FRAME && call.session === false)
      && saved.previews.length === Number(renderPreview))
    if (renderPreview) savePreview(label + '-after', saved.previews[0])
    protect(saved.revision)
    receipts.push({ label, request, result: saved })
    return { request, saved, baseRevision }
  }

  const primitiveBefore = await studio.renderPreview({ projectId, revision: created.currentRevision, frame: FRAME, cameraId: 'camera-main' })
  savePreview('ramp-primitive-before', primitiveBefore.artifacts[0])
  const ramp = await place('ramp-primitive', 'subject', 'ramp', true)
  addInspection('ramp-before', ramp.baseRevision, 'subject', 'ramp')
  addInspection('ramp-after', ramp.saved.revision, 'subject', 'ramp')
  const flat = await place('flat-primitive', 'flat-subject', 'flat', false)
  addInspection('flat-before', flat.baseRevision, 'flat-subject', 'flat', [.2, 0], [-10, -6, -2, 2])
  addInspection('flat-after', flat.saved.revision, 'flat-subject', 'flat', [.2, 0], [-10, -6, -2, 2])

  const assets = []
  for (const name of ['nested-product.glb', 'hole-support.glb']) {
    const uploaded = await studio.uploadAsset({ projectId, name, mediaType: 'model/gltf-binary',
      stream: createReadStream(join(sources, name)), license: 'Original fixture authored by this test' })
    assets.push(uploaded.asset)
  }
  const assetHashes = assets.map(asset => [join(project, asset.path), asset.sha256])
  const imported = await studio.applyScenePatch({ projectId, baseRevision: flat.saved.revision, saveCheckpoint: true, renderPreview: false,
    operations: [{ op: 'entity.remove', entityId: 'subject' }, ...assets.map(asset => ({ op: 'asset.add', asset })),
      { op: 'entity.add', entity: { id: 'imported-product', type: 'asset-instance', assetId: assets[0].id,
        transform: { location: [.05, -.1, 1.2], rotationEuler: [.12, -.18, .45], scale: [1.3, .75, 1.1] } } },
      { op: 'entity.add', entity: { id: 'hole-support', type: 'asset-instance', assetId: assets[1].id, transform: { location: [6, 0, .2] } } }] })
  const importedBefore = await studio.renderPreview({ projectId, revision: imported.revision, frame: FRAME, cameraId: 'camera-main' })
  savePreview('nested-glb-before', importedBefore.artifacts[0])
  const nested = await place('nested-glb', 'imported-product', 'ramp', true)
  addInspection('nested-before', nested.baseRevision, 'imported-product', 'ramp')
  addInspection('nested-after', nested.saved.revision, 'imported-product', 'ramp')

  for (const [label, subject, support] of [
    ['hole has no actual supporting face', 'hole-probe', 'hole-support'],
    ['disjoint world XY', 'no-overlap', 'ramp'],
    ['animated selection', 'animated', 'ramp'],
    ['cross-object geometry dependency', 'dependent-subject', 'ramp'],
  ]) {
    const record = studio.store.readRecord(projectId), revisions = readdirSync(join(project, 'revisions')).sort(), count = calls.length
    let refusal
    try { await studio.placeOnSurface({ projectId, baseRevision: record.currentRevision,
      subjectEntityId: subject, supportEntityId: support, frame: FRAME, clearanceMm: CLEARANCE_MM }) }
    catch (error) { refusal = { code: error.code, message: error.message, detail: error.detail ?? error.details ?? null } }
    check(`${label}: refuses without publishing a revision or rendering`, refusal?.code === BlenderErrorCode.UNSUPPORTED_ACTION
      && JSON.stringify(studio.store.readRecord(projectId)) === JSON.stringify(record)
      && JSON.stringify(readdirSync(join(project, 'revisions')).sort()) === JSON.stringify(revisions)
      && calls.slice(count).every(call => call.method === 'inspectSurfacePlacement')
      && readdirSync(join(project, 'staging')).length === 0
      && !readdirSync(project).some(name => name.startsWith('.surface-placement-')), refusal)
  }

  const later = await studio.applyScenePatch({ projectId, baseRevision: nested.saved.revision, saveCheckpoint: false, renderPreview: false,
    operations: [{ op: 'entity.transform.update', entityId: 'no-overlap', location: [8, 0, 1.1] }] })
  const replayCalls = calls.length, recordBeforeReplay = studio.store.readRecord(projectId)
  const replay = await studio.placeOnSurface(nested.request)
  check('old-base logical intent replays after a later revision without native work or a new revision',
    replay.idempotentReplay === true && replay.revision === nested.saved.revision
    && JSON.stringify(replay.surfacePlacementReceipt) === JSON.stringify(nested.saved.surfacePlacementReceipt)
    && calls.length === replayCalls && studio.store.currentRevision(projectId) === later.revision
    && JSON.stringify(studio.store.readRecord(projectId)) === JSON.stringify(recordBeforeReplay))
  check('all prior checkpoint, scene, preview, manifest and imported source bytes remain unchanged',
    [...protectedRevisions].every(([revision, hashes]) => JSON.stringify(directoryHashes(revisionDirectory(revision))) === JSON.stringify(hashes))
    && assetHashes.every(([path, hash]) => fileHash(path) === hash))

  writeJson(join(output, 'independent-requests.json'), inspections)
  runPython('independent-reopen', INSPECT, [join(output, 'independent-requests.json'), join(output, 'independent-geometry.json')])
  const measured = JSON.parse(readFileSync(join(output, 'independent-geometry.json')))
  const signatures = entity => ({ hierarchy: entity.hierarchy,
    parts: entity.parts.map(({ worldVertices, ...part }) => part) })
  for (const name of ['ramp', 'flat', 'nested']) {
    const before = measured.find(row => row.label === name + '-before'), after = measured.find(row => row.label === name + '-after')
    const receipt = receipts.find(row => row.label === ({ ramp: 'ramp-primitive', flat: 'flat-primitive', nested: 'nested-glb' }[name])).result.surfacePlacementReceipt
    check(`${name}: independent native vertex/plane formula proves the 1.5 mm vertical gap over the whole subject`,
      after.frame === FRAME && after.entireSubjectInsidePlaneDomain && before.entireSubjectInsidePlaneDomain
      && after.supportPlaneMaxErrorMeters < TOLERANCE && before.supportPlaneMaxErrorMeters < TOLERANCE
      && Math.abs(after.minimumGapMeters - CLEARANCE_MM / 1000) < TOLERANCE
      && Math.abs(before.minimumGapMeters + receipt.translationMeters[2] - after.minimumGapMeters) < TOLERANCE,
      { beforeGapMeters: before.minimumGapMeters, afterGapMeters: after.minimumGapMeters })
    const oldVertices = before.subject.worldVertices, newVertices = after.subject.worldVertices
    check(`${name}: reopening proves every vertex moved rigidly in world Z and the support is unchanged`,
      oldVertices.length === newVertices.length && oldVertices.every((vertex, index) => vertex.every((value, axis) =>
        Math.abs(value + receipt.translationMeters[axis] - newVertices[index][axis]) < TOLERANCE))
      && JSON.stringify(before.support) === JSON.stringify(after.support))
    check(`${name}: root rotation/scale, nested local transforms, topology, UVs and materials remain unchanged`,
      JSON.stringify(signatures(before.subject)) === JSON.stringify(signatures(after.subject)))
  }
  const importedFacts = measured.find(row => row.label === 'nested-after').subject
  check('imported test actually includes multiple meshes, nested empties, two UV maps and authored PBR materials',
    importedFacts.parts.length === 2 && importedFacts.hierarchy.filter(row => row.type === 'EMPTY').length >= 3
    && importedFacts.parts.every(part => part.uvMapCount === 2)
    && importedFacts.parts.some(part => part.materials.some(material => material?.name === 'source-red'))
    && importedFacts.parts.some(part => part.materials.some(material => material?.name === 'source-brass')))
} catch (error) {
  failure = { message: error.message, code: error.code ?? null, detail: error.detail ?? error.details ?? null, stack: error.stack }
  console.error(error)
} finally {
  await ctx.stop?.()
  writeJson(join(output, 'report.json'), { status: failure ? 'failed' : 'technical-interaction-pass',
    projectId, durationMs: Date.now() - started, passed: checks.filter(check => check.ok).length, total: checks.length,
    checks, calls, previews, receipts, inspections, failure })
  console.log(`Surface-placement evidence: ${output}`)
}
if (failure) process.exitCode = 1
