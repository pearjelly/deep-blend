/** Real Cordis Host: fixed-frame beauty/clay inspection without modifying source artifacts. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { BlenderErrorCode, sceneSpecDigest, specHash } from '@deepblend/dsh-blender-contracts'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'

const ROOT = resolve(import.meta.dirname, '../../..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const output = resolve(process.env.DEEPBLEND_DIAGNOSTIC_OUTPUT
  ?? join(ROOT, '.deepblend/quality', `diagnostic-preview-${new Date().toISOString().replaceAll(':', '-')}`))
if (!existsSync(BLENDER)) throw new Error(`Set DEEPBLEND_BLENDER_PATH to an installed Blender executable: ${BLENDER}`)
if (existsSync(output)) throw new Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const sources = join(output, 'sources'), workspace = join(output, 'workspace')
mkdirSync(sources); mkdirSync(workspace); mkdirSync(join(output, 'derived'))
const checks = [], calls = [], images = [], frameNumbers = [1, 24, 48]
let failure = null, projectId, revision, stopped = false, activeMode = null
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = path => sha(readFileSync(path))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!ok) throw new Error(name)
}
function directoryHashes(directory) {
  const hashes = {}
  const walk = (path, prefix = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name), key = prefix + entry.name
      if (entry.isDirectory()) walk(full, key + '/')
      else hashes[key] = fileHash(full)
    }
  }
  if (existsSync(directory)) walk(directory)
  return hashes
}
function almostEqual(a, b, tolerance = 1e-6) {
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < tolerance
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => almostEqual(value, b[i], tolerance))
  return a === b
}
function runPython(name, body, args) {
  const script = join(output, name + '.py')
  writeFileSync(script, body)
  const result = spawnSync(BLENDER, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(output, name + '.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  if (result.status !== 0) throw new Error(`${name} failed (${result.status}): ${(result.stderr ?? result.error?.message ?? '').slice(-2000)}`)
}

// Local asset authoring only. The actual project and both inspection variants
// are created exclusively through the public Host and SceneSpec compiler.
const GENERATE = String.raw`
import bpy,sys
from pathlib import Path
root=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
materials=[]
for name,color,metal in [('source-red',(.65,.025,.018,1),0),('source-blue',(.02,.14,.6,1),.6)]:
    material=bpy.data.materials.new(name)
    shader=material.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value=color
    shader.inputs['Metallic'].default_value=metal
    shader.inputs['Roughness'].default_value=.28
    materials.append(material)
bpy.ops.mesh.primitive_cube_add(size=1)
body=bpy.context.object; body.name='two-slot-body'; body.scale=(.52,.42,.55); body.location.z=.3
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
for material in materials: body.data.materials.append(material)
for polygon in body.data.polygons: polygon.material_index=polygon.index%2
bevel=body.modifiers.new('edge-radius','BEVEL'); bevel.width=.035; bevel.segments=3
bpy.context.view_layer.objects.active=body
bpy.ops.object.modifier_apply(modifier=bevel.name)
bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,radius=.14)
cap=bpy.context.object; cap.name='blue-cap'; cap.location=(0,0,.68)
cap.data.materials.append(materials[1])
for polygon in cap.data.polygons: polygon.use_smooth=True
bpy.ops.export_scene.gltf(filepath=str(root/'two-slot-product.glb'),export_format='GLB')
`

// Reopen durable checkpoints in a separate Blender process. Geometry hashes
// deliberately exclude material indices; material layout is inspected separately.
const INSPECT = String.raw`
import bpy,json,sys,hashlib
from pathlib import Path
paths,out=sys.argv[sys.argv.index('--')+1:]
result={}
def hash_value(value): return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()
def matrix(value): return [[float(v) for v in row] for row in value]
def face_loop(face):
    # Independent UV-sphere builds can reorder polygons and rotate each loop's
    # starting index. Preserve winding and connectivity, not incidental ordering.
    vertices=list(face.vertices)
    return min(vertices[index:]+vertices[:index] for index in range(len(vertices)))
for label,path in json.loads(paths).items():
    bpy.ops.wm.open_mainfile(filepath=path,load_ui=False)
    scene=bpy.context.scene; frames={}
    for frame in [1,24,48]:
        scene.frame_set(frame); graph=bpy.context.evaluated_depsgraph_get()
        objects={}
        for obj in scene.objects:
            entity=obj.get('deepblend_id')
            if obj.type!='MESH' or obj.get('deepblend_kind')!='entity': continue
            evaluated=obj.evaluated_get(graph); mesh=evaluated.to_mesh()
            try:
                geometry={'vertices':[[round(float(v),7) for v in evaluated.matrix_world@vertex.co] for vertex in mesh.vertices],
                          'polygons':sorted(face_loop(face) for face in mesh.polygons)}
                materials=[]
                for slot in obj.material_slots:
                    material=slot.material
                    shader=next((node for node in material.node_tree.nodes if node.type=='BSDF_PRINCIPLED'),None) if material else None
                    materials.append(None if shader is None else {'name':material.name,'id':material.get('deepblend_id'),
                        'baseColor':[float(v) for v in shader.inputs['Base Color'].default_value],
                        'roughness':float(shader.inputs['Roughness'].default_value),
                        'metallic':float(shader.inputs['Metallic'].default_value)})
                objects[obj.name]={'entityId':entity,'type':obj.type,'vertices':len(mesh.vertices),'polygons':len(mesh.polygons),
                    'geometrySha256':hash_value(geometry),'materials':materials,'hidden':bool(obj.hide_render)}
            finally: evaluated.to_mesh_clear()
        camera=scene.camera.evaluated_get(graph); data=camera.data
        frames[str(frame)]={'objects':objects,'camera':{'matrixWorld':matrix(camera.matrix_world),'lens':float(data.lens),
            'type':data.type,'sensorWidth':float(data.sensor_width),'clip':[float(data.clip_start),float(data.clip_end)],
            'dofEnabled':bool(data.dof.use_dof),'apertureFstop':float(data.dof.aperture_fstop),
            'focusDistance':float(data.dof.focus_distance)}}
    result[label]={'blenderVersion':bpy.app.version_string,'frames':frames}
Path(out).write_text(json.dumps(result,indent=2))
`

const ctx = new Context()
try {
  runPython('generate-assets', GENERATE, [sources])
  ctx.plugin(LocalSubprocess)
  ctx.plugin(Provider, ProviderConfig({ blenderPath: BLENDER, workspaceRoot: workspace, timeoutMs: 120_000 }))
  ctx.plugin(Studio, { workspaceRoot: workspace, projectsRoot: join(workspace, 'projects'), maxPreviewSamples: 8 })
  await new Promise(resolve => setTimeout(resolve, 250))
  const studio = ctx.get('blenderStudio'), runtime = ctx.get('blenderRuntime')
  check('real Cordis Host and local Provider activate', Boolean(studio && runtime))
  const spec = defaultSceneSpec({ projectId: 'diagnostic-proof', title: 'Fixed-frame inspection proof' })
  spec.project.activeCamera = 'hero'
  spec.materials = [{ id: 'shared-green', shader: 'principled', parameters: { baseColor: [.055, .32, .16, 1], roughness: .32 } }]
  spec.entities = [
    { id: 'floor', type: 'generator', generator: { shape: 'cube', size: 1 }, tags: ['environment'],
      materialId: 'shared-green', transform: { location: [0, 0, -.06], scale: [4, 4, .1] } },
    { id: 'sphere', type: 'generator', generator: { shape: 'uv_sphere', radius: .23, segments: 32, ringCount: 16 },
      materialId: 'shared-green', transform: { location: [.7, 0, .23] }, tags: ['subject'] },
    { id: 'swept-curve', type: 'generator', materialId: 'shared-green', generator: {
      shape: 'curve', radius: .035, pathInterpolation: 'bezier', curveResolution: 16, bevelResolution: 4,
      path: [[-.8, 0, .06], [-.8, 0, .48], [-.6, 0, .7], [-.38, 0, .52]] } },
  ]
  spec.cameras = [{ id: 'hero', lens: 58, sensorWidth: 36, clipping: [.02, 100], fStop: 8,
    transform: { location: [2.5, -4, 2.25] }, targetPoint: [0, 0, .3] }]
  spec.shots = [{ id: 'inspection-shot', cameraId: 'hero', frameRange: [1, 48] }]
  spec.animationTracks = [{ id: 'camera-drift', targetKind: 'camera', targetEntityId: 'hero', property: 'location.x',
    keyframes: [{ frame: 1, value: 2.5, interpolation: 'linear' }, { frame: 24, value: 2.3, interpolation: 'linear' },
      { frame: 48, value: 2.1, interpolation: 'linear' }] }]
  spec.lights = [{ id: 'softbox', type: 'area', energy: 350, size: 3,
    transform: { location: [0, -1, 3.5], rotationEuler: [0, 0, 0] }, color: [1, .96, .9] }]
  spec.world = { color: [.1, .12, .16, 1], strength: .5 }
  spec.renderProfiles.preview = { engine: 'cycles', resolution: [320, 240], samples: 8, maxSamplesBudget: 8,
    filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: .25 } }
  spec.renderProfiles.final = structuredClone(spec.renderProfiles.preview)
  const created = await studio.createProject({ title: spec.project.title, sceneSpec: spec, saveCheckpoint: true, renderPreview: true })
  projectId = created.projectId
  const project = studio.store.projectDirectory(projectId)
  const upload = await studio.uploadAsset({ projectId, name: 'two-slot-product.glb', mediaType: 'model/gltf-binary',
    stream: createReadStream(join(sources, 'two-slot-product.glb')), license: 'Original local fixture' })
  const added = await studio.applyScenePatch({ projectId, baseRevision: created.currentRevision, saveCheckpoint: true, renderPreview: true,
    operations: [{ op: 'asset.add', asset: upload.asset },
      { op: 'entity.add', entity: { id: 'imported-product', type: 'asset-instance', assetId: upload.asset.id, tags: ['subject'] } }] })
  revision = added.revision
  const revisionDirectory = studio.store.revisionDirectory(projectId, revision)
  const sourceSpec = studio.store.readRevisionSpec(projectId, revision)
  const protectedRecord = fileHash(join(project, 'project.json'))
  const protectedRevision = directoryHashes(revisionDirectory)
  const protectedEarlier = directoryHashes(studio.store.revisionDirectory(projectId, created.currentRevision))
  const protectedAssets = directoryHashes(join(project, 'assets'))
  const protectedCurrent = () => fileHash(join(project, 'project.json')) === protectedRecord
    && Object.entries(protectedRevision).every(([path, hash]) => fileHash(join(revisionDirectory, path)) === hash)
    && JSON.stringify(directoryHashes(studio.store.revisionDirectory(projectId, created.currentRevision))) === JSON.stringify(protectedEarlier)
    && JSON.stringify(directoryHashes(join(project, 'assets'))) === JSON.stringify(protectedAssets)
    && studio.store.currentRevision(projectId) === revision
  const beforeSets = await studio.listPreviewSets({ projectId })
  const beforeRow = beforeSets.revisions.find(row => row.revision === revision)
  check('source revision has checkpoint, immutable GLB and a beauty preview to protect',
    existsSync(join(revisionDirectory, 'scene.blend')) && beforeRow.previews.length > 0
    && upload.asset.sha256 === fileHash(join(project, upload.asset.path)))
  writeJson(join(output, 'before.json'), { projectId, revision, protectedRecord, protectedRevision, protectedAssets, protectedEarlier })

  const originalCompile = runtime.compileScene.bind(runtime), originalRender = runtime.renderViews.bind(runtime)
  const originalActions = runtime.config.sessionActions, originalSession = runtime._keptSession
  let sessionTouches = 0
  runtime.config.sessionActions = ['compile_scene', 'render_views']
  runtime._keptSession = async () => { sessionTouches++; throw new Error('Inspection touched a kept/live session') }
  runtime.compileScene = async request => {
    const mode = activeMode
    calls.push({ method: 'compileScene', session: request.session, mode, jobId: request.jobId })
    const callback = request.onWorkingDirectory
    const compiled = await originalCompile({ ...request, onWorkingDirectory: async info => {
      copyFileSync(join(info.directory, 'result.blend'), join(output, 'derived', `${mode}.blend`))
      await callback?.(info)
    } })
    writeJson(join(output, 'derived', `${mode}-compile.json`), compiled.report)
    return compiled
  }
  runtime.renderViews = async request => {
    // This one negative case deliberately sends an invalid engine to the real
    // Python renderer after the Host has compiled a valid isolated scene.
    const failureInjection = activeMode === 'failed-engine' ? 'invalid-provider-engine' : null
    calls.push({ method: 'renderViews', session: request.session, mode: activeMode, views: request.views, failureInjection })
    const rendered = await originalRender(failureInjection ? { ...request, engine: 'not-an-engine' } : request)
    writeJson(join(output, 'derived', `${activeMode}-views.json`), rendered.report)
    return rendered
  }
  const request = { projectId, revision, views: frameNumbers.map(frame => ({ id: `frame-${frame}`, cameraId: 'hero', frame })),
    width: 320, height: 240, samples: 8 }
  const modes = {}
  const { default: sharp } = await import('sharp')
  try {
    for (const mode of ['beauty', 'clay']) {
      activeMode = mode
      const result = modes[mode] = await studio.renderViews({ ...request, mode })
      writeJson(join(output, `${mode}-result.json`), result)
      check(`${mode}: three fixed views publish as isolated diagnostics`, result.artifacts.length === 3
        && result.artifacts.every(item => item.kind === 'diagnostic' && item.mode === mode && item.sourceRevision === revision))
      check(`${mode}: source hashes and declared assets identify the untouched revision`, result.sourceDigest === sceneSpecDigest(sourceSpec)
        && result.sourceSpecHash === specHash(sourceSpec) && result.sourceSpecSha256 === protectedRevision['scene-spec.json']
        && result.sourceCheckpointSha256 === protectedRevision['scene.blend']
        && result.sourceAssets.length === 1 && result.sourceAssets[0].sha256 === upload.asset.sha256)
      check(`${mode}: source record, all old revision files, asset bytes and beauty previews remain identical`, protectedCurrent())
      for (const artifact of result.artifacts) {
        const bytes = (await studio.readArtifact({ projectId, path: artifact.path })).bytes
        const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        const stats = await sharp(bytes).stats()
        check(`${mode}/${artifact.frame}: real PNG and measured render facts agree`, sha(bytes) === artifact.sha256
          && raw.info.width === 320 && raw.info.height === 240 && artifact.width === 320 && artifact.height === 240
          && artifact.samples === 8 && artifact.engine === 'CYCLES' && artifact.cameraId === 'hero'
          && artifact.cameraFacts.frame === artifact.frame && artifact.renderConfig.samples === 8
          && artifact.renderConfig.exposure === .25 && artifact.renderConfig.resolutionPercentage === 100
          && artifact.cameraFacts.dof.enabled && Math.abs(artifact.cameraFacts.dof.apertureFstop - 8) < 1e-6
          && stats.channels.slice(0, 3).some(channel => channel.stdev > 5))
        const path = `${mode}-${artifact.frame}.png`
        writeFileSync(join(output, path), bytes)
        images.push({ mode, frame: artifact.frame, path, pixelSha256: sha(raw.data), sha256: sha(bytes) })
      }
    }
    check('both compile and render bypass configured kept/live sessions', sessionTouches === 0
      && calls.length === 4 && calls.every(call => call.session === false))
    for (const mode of ['beauty', 'clay']) check(`${mode}: all three animated frames have distinct pixels and camera poses`,
      new Set(images.filter(image => image.mode === mode).map(image => image.pixelSha256)).size === 3
      && new Set(modes[mode].artifacts.map(artifact => JSON.stringify(artifact.cameraFacts.matrixWorld))).size === 3)
    for (let index = 0; index < 3; index++) {
      const beauty = modes.beauty.artifacts[index], clay = modes.clay.artifacts[index]
      check(`frame ${beauty.frame}: beauty and clay retain identical actual camera and photography settings`,
        JSON.stringify(beauty.cameraFacts) === JSON.stringify(clay.cameraFacts)
        && JSON.stringify(beauty.renderConfig) === JSON.stringify(clay.renderConfig))
      check(`frame ${beauty.frame}: grey material removal changes actual pixels`,
        images.find(image => image.mode === 'beauty' && image.frame === beauty.frame).pixelSha256
        !== images.find(image => image.mode === 'clay' && image.frame === beauty.frame).pixelSha256)
    }
    const published = (await studio.listPreviewSets({ projectId })).revisions.find(row => row.revision === revision)
    check('diagnostics are separate from default previews, contact sheets and QA reviews', published.diagnostics.length === 6
      && JSON.stringify(published.previews) === JSON.stringify(beforeRow.previews)
      && JSON.stringify(published.contactSheets) === JSON.stringify(beforeRow.contactSheets)
      && JSON.stringify(published.reviews) === JSON.stringify(beforeRow.reviews))
    const publishedHashes = directoryHashes(join(revisionDirectory, 'diagnostics'))
    const controller = new AbortController(); controller.abort()
    const beforeCancelCalls = calls.length
    let cancelled = null
    try { await studio.renderViews({ ...request, mode: 'clay', signal: controller.signal }) } catch (error) { cancelled = error }
    check('pre-cancelled request performs no runtime work and publishes nothing', Boolean(cancelled)
      && calls.length === beforeCancelCalls && JSON.stringify(directoryHashes(join(revisionDirectory, 'diagnostics'))) === JSON.stringify(publishedHashes))
    activeMode = 'failed-engine'
    let rejected = null
    try { await studio.renderViews({ ...request, mode: 'clay' }) } catch (error) { rejected = error }
    check('real Blender render failure after successful compilation publishes no partial set',
      rejected?.code === BlenderErrorCode.ENGINE_UNAVAILABLE && existsSync(join(output, 'derived/failed-engine.blend'))
      && JSON.stringify(directoryHashes(join(revisionDirectory, 'diagnostics'))) === JSON.stringify(publishedHashes),
      { code: rejected?.code, message: rejected?.message })
    check('failure and cancellation clean staging and preserve all protected bytes', protectedCurrent()
      && (!existsSync(join(project, 'staging')) || readdirSync(join(project, 'staging')).every(name => !name.startsWith('.diagnostic-'))))
  } finally {
    runtime.compileScene = originalCompile; runtime.renderViews = originalRender
    runtime.config.sessionActions = originalActions; runtime._keptSession = originalSession
  }

  runPython('inspect-checkpoints', INSPECT, [JSON.stringify({ source: join(revisionDirectory, 'scene.blend'),
    beauty: join(output, 'derived/beauty.blend'), clay: join(output, 'derived/clay.blend') }), join(output, 'checkpoint-inspection.json')])
  const inspection = json(join(output, 'checkpoint-inspection.json'))
  for (const frame of frameNumbers) {
    const source = inspection.source.frames[frame], beauty = inspection.beauty.frames[frame], clay = inspection.clay.frames[frame]
    const geometry = pose => Object.fromEntries(Object.entries(pose.objects).map(([name, object]) => [name, object.geometrySha256]))
    check(`frame ${frame}: independent checkpoint reopen finds identical evaluated geometry in all three variants`,
      JSON.stringify(geometry(source)) === JSON.stringify(geometry(beauty)) && JSON.stringify(geometry(source)) === JSON.stringify(geometry(clay)))
    for (const mode of ['beauty', 'clay']) {
      const camera = inspection[mode].frames[frame].camera
      const reported = modes[mode].artifacts.find(item => item.frame === frame).cameraFacts
      check(`${mode}/${frame}: independently reopened camera matches actual report optics and pose`,
        almostEqual(camera.matrixWorld, reported.matrixWorld) && almostEqual(camera.lens, reported.lens)
        && almostEqual(camera.sensorWidth, reported.sensorWidth) && almostEqual(camera.clip, reported.clip)
        && camera.type === reported.type && camera.dofEnabled === reported.dof.enabled
        && almostEqual(camera.apertureFstop, reported.dof.apertureFstop) && almostEqual(camera.focusDistance, reported.dof.focusDistance))
    }
  }
  const sourceObjects = Object.values(inspection.source.frames[1].objects)
  const clayObjects = Object.values(inspection.clay.frames[1].objects)
  const imported = sourceObjects.filter(object => object.entityId === 'imported-product')
  check('source GLB really contains an imported mesh with multiple source material slots',
    imported.length >= 2 && imported.some(object => object.materials.length >= 2)
    && imported.flatMap(object => object.materials).some(material => material?.baseColor[0] > .5))
  check('clay replaces every imported slot and swept/generated surface with the fixed opaque grey material',
    clayObjects.filter(object => object.entityId !== 'floor').every(object => object.materials.length > 0
      && object.materials.every(material => material && almostEqual(material.baseColor, [.35, .35, .35, 1])
        && almostEqual(material.roughness, .62) && almostEqual(material.metallic, 0)))
    && clayObjects.some(object => object.entityId === 'swept-curve' && object.vertices > 100))
  const sourceFloor = sourceObjects.find(object => object.entityId === 'floor'), sourceSphere = sourceObjects.find(object => object.entityId === 'sphere')
  const clayFloor = clayObjects.find(object => object.entityId === 'floor')
  check('environment keeps its source material even when a replaced subject shares it',
    sourceFloor.materials[0].name === sourceSphere.materials[0].name
    && JSON.stringify(sourceFloor.materials) === JSON.stringify(clayFloor.materials))
  check('beauty rebuild retains original imported and shared material layouts',
    JSON.stringify(inspection.source.frames[1].objects) === JSON.stringify(inspection.beauty.frames[1].objects))
  const montage = await sharp({ create: { width: 640, height: 720, channels: 4, background: '#20242a' } })
    .composite(frameNumbers.flatMap((frame, row) => ['beauty', 'clay'].map((mode, column) => ({
      input: join(output, `${mode}-${frame}.png`), left: column * 320, top: row * 240,
    })))).png().toBuffer()
  writeFileSync(join(output, 'beauty-clay-frames.png'), montage)
  writeFileSync(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Diagnostic preview evidence</title>
    <style>body{background:#171c22;color:#eef1f5;font:16px sans-serif;padding:24px}img{max-width:100%;height:auto}</style>
    <h1>Beauty / opaque clay — same fixed cameras</h1><p>Left: beauty. Right: clay. Rows: frames 1, 24, 48. Cycles 320×240, 8 samples, AgX, exposure +0.25.</p>
    <p>The green environment retains its original material. Imported red/blue slots and generated objects become grey.</p>
    <img src="beauty-clay-frames.png" alt="Beauty and clay comparison at three frames"><p>See report.json and checkpoint-inspection.json for provenance and independent geometry/material readings.</p>`)

  // The documented second engine must produce measured EEVEE facts, rather
  // than silently falling back to the Cycles engine stored in the checkpoint.
  const beforeEevee = directoryHashes(join(revisionDirectory, 'diagnostics'))
  const eevee = await studio.renderViews({ ...request, mode: 'clay', engine: 'eevee',
    views: [{ id: 'eevee-24', cameraId: 'hero', frame: 24 }] })
  writeJson(join(output, 'eevee-result.json'), eevee)
  const eeveeArtifact = eevee.artifacts[0]
  check('explicit EEVEE override reports the actual engine, samples and fixed frame', eevee.artifacts.length === 1
    && eeveeArtifact.kind === 'diagnostic' && eeveeArtifact.mode === 'clay' && eeveeArtifact.sourceRevision === revision
    && eeveeArtifact.engine === 'BLENDER_EEVEE' && eeveeArtifact.samples === 8
    && eeveeArtifact.renderConfig.engine === 'BLENDER_EEVEE' && eeveeArtifact.renderConfig.samples === 8
    && eeveeArtifact.renderConfig.exposure === .25 && eeveeArtifact.cameraId === 'hero'
    && eeveeArtifact.frame === 24 && eeveeArtifact.cameraFacts.frame === 24)
  const eeveeBytes = (await studio.readArtifact({ projectId, path: eeveeArtifact.path })).bytes
  const eeveePixels = await sharp(eeveeBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const eeveeStats = await sharp(eeveeBytes).stats()
  check('EEVEE inspection produces a nonuniform decoded PNG matching the published receipt',
    sha(eeveeBytes) === eeveeArtifact.sha256 && eeveePixels.info.width === 320 && eeveePixels.info.height === 240
    && eeveeStats.channels.slice(0, 3).some(channel => channel.stdev > 5))
  writeFileSync(join(output, 'eevee-clay-24.png'), eeveeBytes)
  images.push({ mode: 'clay', engine: 'BLENDER_EEVEE', frame: 24, path: 'eevee-clay-24.png',
    pixelSha256: sha(eeveePixels.data), sha256: sha(eeveeBytes) })
  const afterEevee = (await studio.listPreviewSets({ projectId })).revisions.find(row => row.revision === revision)
  check('EEVEE preserves source files, existing diagnostics and default finished previews', protectedCurrent()
    && Object.entries(beforeEevee).every(([path, hash]) => fileHash(join(revisionDirectory, 'diagnostics', path)) === hash)
    && afterEevee.diagnostics.length === 7 && JSON.stringify(afterEevee.previews) === JSON.stringify(beforeRow.previews)
    && JSON.stringify(afterEevee.contactSheets) === JSON.stringify(beforeRow.contactSheets)
    && JSON.stringify(afterEevee.reviews) === JSON.stringify(beforeRow.reviews))
} catch (error) {
  failure = { message: error.message, code: error.code ?? null, detail: error.detail ?? null, stack: error.stack }
  console.error(error)
} finally {
  await ctx.stop?.(); stopped = true
  writeJson(join(output, 'report.json'), { status: failure ? 'failed' : 'technical-diagnostic-pass', projectId, revision,
    passed: checks.filter(check => check.ok).length, total: checks.length, checks, calls, images,
    scope: { frames: frameNumbers, importedAsset: 'self-contained two-slot GLB',
      nativeCurve: 'Not claimed: the accepted GLB route is mesh-only; the public swept-curve generator is tested as a mesh.',
      artisticApproval: false }, shutdown: { contextStopped: stopped }, failure })
}
console.log(`Diagnostic preview integration: ${checks.filter(check => check.ok).length}/${checks.length}; ${output}`)
if (failure) process.exitCode = 1
