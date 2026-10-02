/** Real Host upload → library → isolated preview → explicit scene insertion. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'

const ROOT = resolve(import.meta.dirname, '../../..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const output = resolve(process.env.DEEPBLEND_ASSET_LIBRARY_OUTPUT
  ?? join(ROOT, '.deepblend/quality', `asset-library-${new Date().toISOString().replaceAll(':', '-')}`))
if (existsSync(output)) throw new Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const sources = join(output, 'sources'), workspace = join(output, 'workspace')
mkdirSync(sources); mkdirSync(workspace)
const checks = [], previews = [], calls = []
let projectId, failure = null, stopped = false
const digest = value => createHash('sha256').update(value).digest('hex')
const fileHash = path => digest(readFileSync(path))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!ok) throw new Error(name)
}
function directoryHashes(directory) {
  const hashes = {}
  const walk = (path, prefix = '') => {
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
  if (result.status !== 0) throw new Error(`${name} failed (${result.status}): ${(result.stderr ?? result.error?.message ?? '').slice(-2000)}`)
}

// Authored locally by this test. The GLB has nested transforms, two meshes,
// authored PBR materials, an absent primitive material, and two UV attributes.
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
pixels=[]
for y in range(64):
    for x in range(128):
        pixels.extend([18,12,7,1] if 16<x<40 and 25<y<55 else [.04,.05,.08,1])
for extension,format_name in [('hdr','HDR'),('exr','OPEN_EXR')]:
    image=bpy.data.images.new('studio-'+extension,width=128,height=64,float_buffer=True)
    image.colorspace_settings.name='Linear Rec.709'; image.pixels[:]=pixels
    bpy.context.scene.render.image_settings.file_format=format_name
    image.save_render(str(root/('studio.'+extension)),scene=bpy.context.scene)
`

const INSPECT = String.raw`
import bpy,json,sys,hashlib
from pathlib import Path
mode,path,out=sys.argv[sys.argv.index('--')+1:]
if mode=='glb':
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
else: bpy.ops.wm.open_mainfile(filepath=path)
bpy.context.view_layer.update()
parts={}
def checksum(value): return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
for obj in bpy.context.scene.objects:
    if obj.type!='MESH' or (mode!='glb' and obj.get('deepblend_id')!='inserted-product'): continue
    materials=[]
    for slot in obj.material_slots:
        if slot.material is None: materials.append(None); continue
        shader=slot.material.node_tree.nodes.get('Principled BSDF')
        values={}
        for key in ['Base Color','Metallic','Roughness','Alpha']:
            value=shader.inputs[key].default_value
            values[key]=[round(v,5) for v in value] if hasattr(value,'__len__') else round(value,5)
        materials.append({'name':slot.material.name,'values':values})
    parts[obj.name]={'materials':materials,'vertices':len(obj.data.vertices),'polygons':len(obj.data.polygons),
        'faceMaterials':[face.material_index for face in obj.data.polygons],
        'worldVertices':sorted([round(v,5) for v in obj.matrix_world@vertex.co] for vertex in obj.data.vertices),
        'uvMaps':[{'name':layer.name,'digest':checksum([[round(v,5) for v in loop.uv] for loop in layer.data])} for layer in obj.data.uv_layers]}
Path(out).write_text(json.dumps(parts,indent=2))
`

runPython('generate-assets', GENERATE, [sources])
const { default: sharp } = await import('sharp')
const width = 640, height = 320, pixels = Buffer.alloc(width * height * 4)
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const at = (y * width + x) * 4
  pixels[at] = Math.round(x / width * 255)
  pixels[at + 1] = Math.round(y / height * 255)
  pixels[at + 2] = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 230 : 25
  pixels[at + 3] = x < 80 ? 150 : 255
}
await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(join(sources, 'texture.png'))
await sharp(pixels, { raw: { width, height, channels: 4 } }).flatten({ background: '#eeeeee' }).jpeg({ progressive: true }).toFile(join(sources, 'texture.jpeg'))
runPython('inspect-original', INSPECT, ['glb', join(sources, 'nested-product.glb'), join(output, 'original-model.json')])
const originalModel = JSON.parse(readFileSync(join(output, 'original-model.json')))

const ctx = new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin(Provider, ProviderConfig({ blenderPath: BLENDER, workspaceRoot: workspace, timeoutMs: 120_000 }))
ctx.plugin(Studio, { workspaceRoot: workspace, projectsRoot: join(workspace, 'projects'), maxPreviewSamples: 16 })
await new Promise(resolve => setTimeout(resolve, 250))
const studio = ctx.get('blenderStudio'), runtime = ctx.get('blenderRuntime')
if (!studio || !runtime) throw new Error('The real Host/Provider services did not activate.')
try {
  const scene = defaultSceneSpec({ projectId: 'asset-library-proof', title: 'Asset library integration' })
  scene.entities[0].generator = { shape: 'plane', size: 1.5 }
  scene.entities[0].transform.location = [0, 0, -.01]
  delete scene.cameras[0].targetEntityId
  scene.cameras[0].targetPoint = [.3, -.05, .2]
  scene.cameras[0].transform.location = [1.3, -1.5, 1]
  scene.renderProfiles.preview = { engine: 'cycles', resolution: [256, 192], samples: 8, maxSamplesBudget: 16,
    colorManagement: { viewTransform: 'AgX', exposure: 0 } }
  const created = await studio.createProject({ title: 'Asset library proof', sceneSpec: scene,
    saveCheckpoint: true, renderPreview: true })
  projectId = created.projectId
  const project = studio.store.projectDirectory(projectId)
  const revision = created.currentRevision
  const checkpoint = join(project, 'revisions', revision, 'scene.blend')
  const oldRecord = fileHash(join(project, 'project.json'))
  const oldRevision = directoryHashes(join(project, 'revisions', revision))
  const noSceneChange = () => fileHash(join(project, 'project.json')) === oldRecord
    && JSON.stringify(directoryHashes(join(project, 'revisions', revision))) === JSON.stringify(oldRevision)
    && studio.store.currentRevision(projectId) === revision
  check('initial project has a real checkpoint and preview to protect',
    existsSync(checkpoint) && created.revision.previews.length === 1)
  writeJson(join(output, 'before.json'), { projectId, revision, oldRecord, oldRevision })

  const declarations = [
    ['nested-product.glb', 'model/gltf-binary'], ['texture.png', 'image/png'], ['texture.jpeg', 'image/jpeg'],
    ['studio.hdr', 'image/vnd.radiance'], ['studio.exr', 'image/x-exr'],
  ]
  const uploaded = []
  for (const [name, mediaType] of declarations) {
    const result = await studio.uploadAsset({ projectId, name, mediaType,
      stream: createReadStream(join(sources, name)), license: 'Original fixture authored by this test' })
    uploaded.push(result)
    check(`${name}: streamed bytes were stored under their exact content hash`,
      result.asset.sha256 === fileHash(join(sources, name))
      && fileHash(join(project, result.asset.path)) === result.asset.sha256)
    check(`${name}: upload did not change the project or existing checkpoint/preview`, noSceneChange())
  }
  const library = await studio.listAssets({ projectId })
  check('library lists all five staged formats without declaring them in the scene',
    library.assets.length === 5 && library.assets.every(row => !row.declaredInRevision && row.preview === null))
  writeJson(join(output, 'uploaded.json'), { uploaded, library })

  // Exercise the real provider with kept-session routing enabled. If any Host
  // preview misses session:false, attempting to obtain a live session is fatal.
  // The provider routing contract separately proves omission uses that branch.
  const originalActions = runtime.config.sessionActions
  const originalKeptSession = runtime._keptSession
  runtime.config.sessionActions = ['compile_scene', 'render_preview']
  let liveSessionTouches = 0
  runtime._keptSession = async () => { liveSessionTouches++; throw new Error('Asset preview touched the live session') }
  const originalCompile = runtime.compileScene.bind(runtime), originalRender = runtime.renderPreview.bind(runtime)
  mkdirSync(join(output, 'isolated-checkpoints'))
  runtime.compileScene = async request => {
    const index = calls.length
    calls.push({ method: 'compileScene', session: request.session, jobId: request.jobId })
    const retain = request.onWorkingDirectory
    const result = await originalCompile({ ...request, onWorkingDirectory: async info => {
      copyFileSync(join(info.directory, 'result.blend'), join(output, 'isolated-checkpoints', `compile-${index}.blend`))
      await retain?.(info)
    } })
    writeJson(join(output, `compile-${index}.json`), result.report)
    return result
  }
  runtime.renderPreview = async request => {
    calls.push({ method: 'renderPreview', session: request.session, cameraId: request.cameraId,
      frame: request.frame, width: request.width, height: request.height, samples: request.samples })
    const result = await originalRender(request)
    writeJson(join(output, `render-${calls.length - 1}.json`), result.report)
    return result
  }
  try {
    for (const upload of uploaded) {
      const asset = upload.asset
      const result = await studio.previewAsset({ projectId, assetId: asset.id, sha256: asset.sha256 })
      previews.push(result)
      const artifact = await studio.readArtifact({ projectId, path: result.preview.path })
      const decoded = await sharp(artifact.bytes).raw().toBuffer({ resolveWithObject: true })
      const metadata = await sharp(artifact.bytes).metadata()
      check(`${asset.type}: preview is a real decoded PNG matching its receipt`, metadata.format === 'png'
        && metadata.width === result.preview.width && metadata.height === result.preview.height
        && digest(artifact.bytes) === result.preview.sha256 && decoded.data.length > 0)
      copyFileSync(join(project, result.preview.path), join(output, `preview-${asset.type}.png`))
      if (asset.type === 'glb') {
        check('GLB: real model inspection has both transformed mesh parts and measured bounds',
          result.inspection.kind === 'model' && result.inspection.parts.length === 2
          && result.inspection.parts.every(part => part.worldBounds && part.boundsFrame === 1 && part.assetSha256 === asset.sha256)
          && result.inspection.bounds.min[0] > -.2 && result.inspection.bounds.max[0] > .5)
        check('GLB: preview inventory preserves two UV channels and an empty original slot',
          result.inspection.parts.every(part => part.uvMaps.length === 2)
          && result.inspection.parts.some(part => part.sourceMaterialSlots.some(slot => slot.materialName === null)))
      } else if (['hdr', 'exr'].includes(asset.type)) {
        check(`${asset.type}: environment lighting preview is explicitly tone mapped at 512×384/16 spp`,
          result.inspection.kind === 'environment' && result.preview.toneMapped === true
          && result.preview.width === 512 && result.preview.height === 384
          && result.preview.renderConfig.samples === 16 && result.preview.renderConfig.engine === 'CYCLES')
        check(`${asset.type}: measured float source facts remain separate from the PNG derivative`,
          result.inspection.image.isFloat && result.inspection.image.width === 128 && result.inspection.image.height === 64
          && result.inspection.image.colorSpace === 'Linear Rec.709')
      } else {
        check(`${asset.type}: raster preview preserves aspect ratio and reports original dimensions`,
          result.inspection.kind === 'image' && result.inspection.image.width === 640 && result.inspection.image.height === 320
          && result.preview.width === 512 && result.preview.height === 256 && result.preview.toneMapped === false)
      }
      check(`${asset.type}: preview changed neither source bytes nor project revision artifacts`,
        fileHash(join(project, asset.path)) === asset.sha256 && noSceneChange())
    }
    check('Host sends session:false through every actual asset compile and render',
      calls.length === 7 && calls.every(call => call.session === false) && liveSessionTouches === 0, calls)
    const afterLibrary = await studio.listAssets({ projectId })
    check('library returns measured inspections and previews while assets remain undeclared',
      afterLibrary.assets.every(row => row.preview && row.inspection && !row.declaredInRevision))
    writeJson(join(output, 'previewed-library.json'), afterLibrary)

    const glb = uploaded[0].asset
    const raw = readFileSync(join(project, glb.path))
    try {
      writeFileSync(join(project, glb.path), Buffer.concat([raw, Buffer.from('tampered')]))
      let code
      try { await studio.previewAsset({ projectId, assetId: glb.id, sha256: glb.sha256 }) }
      catch (error) { code = error.code }
      check('a changed staged source is rejected instead of reusing its previous preview', code === BlenderErrorCode.ASSET_HASH_MISMATCH, code)
    } finally { writeFileSync(join(project, glb.path), raw) }
    const controller = new AbortController(); controller.abort()
    let cancelled = false
    try { await studio.previewAsset({ projectId, assetId: glb.id, sha256: glb.sha256, signal: controller.signal }) }
    catch (error) { cancelled = error.name === 'AbortError' || error.code === BlenderErrorCode.ABORTED }
    check('a cancelled request leaves no partial preview or scene write', cancelled && noSceneChange()
      && readdirSync(join(project, 'assets')).every(name => !name.startsWith('.preview-') && !name.startsWith('.upload-')))
  } finally {
    runtime.compileScene = originalCompile
    runtime.renderPreview = originalRender
    runtime.config.sessionActions = originalActions
    runtime._keptSession = originalKeptSession
  }

  const model = uploaded[0].asset
  const inserted = await studio.applyScenePatch({ projectId, baseRevision: revision, saveCheckpoint: true, renderPreview: false,
    operations: [{ op: 'asset.add', asset: model },
      { op: 'entity.add', entity: { id: 'inserted-product', type: 'asset-instance', assetId: model.id } }] })
  check('only explicit asset.add + entity.add creates the next revision', inserted.revision !== revision
    && studio.store.currentRevision(projectId) === inserted.revision)
  check('explicit insertion preserves every byte of the earlier revision',
    JSON.stringify(directoryHashes(join(project, 'revisions', revision))) === JSON.stringify(oldRevision))
  const insertedCheckpoint = join(project, 'revisions', inserted.revision, 'scene.blend')
  runPython('inspect-inserted', INSPECT, ['blend', insertedCheckpoint, join(output, 'inserted-model.json')])
  const insertedModel = JSON.parse(readFileSync(join(output, 'inserted-model.json')))
  check('saved inserted model preserves original materials, null slot, UVs, faces and nested world transforms',
    JSON.stringify(insertedModel) === JSON.stringify(originalModel), { parts: Object.keys(insertedModel) })
  const declared = await studio.listAssets({ projectId })
  check('the library marks only the explicitly inserted model as declared',
    declared.assets.filter(row => row.declaredInRevision).length === 1
    && declared.assets.find(row => row.asset.id === model.id).declaredInRevision)
  const insertedPreview = await studio.renderPreview({ projectId, revision: inserted.revision, cameraId: 'camera-main', frame: 1 })
  writeJson(join(output, 'inserted-preview.json'), insertedPreview)
  const currentScene = await studio.getScene(projectId)
  check('inserted scene keeps stable part selectors and exact pinned source identity',
    currentScene.assetParts.filter(part => part.entityId === 'inserted-product').length === 2
    && currentScene.assetParts.filter(part => part.entityId === 'inserted-product').every(part => part.assetSha256 === model.sha256))
  writeJson(join(output, 'inserted-library.json'), declared)
} catch (error) {
  failure = { message: error.message, code: error.code ?? null, detail: error.detail ?? null, stack: error.stack }
  console.error(error)
} finally {
  await ctx.stop?.()
  stopped = true
  writeJson(join(output, 'report.json'), { status: failure ? 'failed' : 'technical-interaction-pass',
    projectId, passed: checks.filter(check => check.ok).length, total: checks.length, checks, calls, previews,
    shutdown: { contextStopped: stopped }, failure })
}
console.log(`Asset library integration: ${checks.filter(check => check.ok).length}/${checks.length}; ${output}`)
if (failure) process.exitCode = 1
