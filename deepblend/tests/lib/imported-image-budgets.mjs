/** Actual public Host refusals, native scene preservation and packed image readback. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { encodePng } from '@deepblend/dsh-blender-contracts';
import { defaultSceneSpec } from '@deepblend/dsh-blender-host';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const dataUri = bytes => 'data:application/octet-stream;base64,' + bytes.toString('base64');
function document(bytes, kind, mimeType = 'image/png', imageName = 'paint.png') {
  const positions = Buffer.alloc(36), uv = Buffer.alloc(24); positions.writeFloatLE(.1, 12); positions.writeFloatLE(.1, 28); uv.writeFloatLE(1, 8); uv.writeFloatLE(1, 20);
  let binary = Buffer.concat([positions, uv]);
  const doc = { asset: { version: '2.0' }, buffers: [{ uri: dataUri(binary), byteLength: binary.length }], bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [.1, .1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }], images: [{ uri: imageName }], textures: [{ source: 0 }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: .15, roughnessFactor: .24 } }], meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 };
  const files = {};
  if (kind === 'external') files[imageName] = bytes;
  else if (kind === 'image-data') doc.images[0].uri = 'data:' + mimeType + ';base64,' + bytes.toString('base64');
  else {
    binary = Buffer.concat([binary, bytes]); doc.buffers[0].byteLength = binary.length; doc.bufferViews.push({ buffer: 0, byteOffset: 60, byteLength: bytes.length }); doc.images = [{ bufferView: 2, mimeType }];
    if (kind === 'buffer-data') doc.buffers[0].uri = dataUri(binary);
    else if (kind === 'buffer-file') { doc.buffers[0].uri = 'model.bin'; files['model.bin'] = binary; }
    else delete doc.buffers[0].uri;
  }
  if (kind === 'glb-bin') {
    let json = Buffer.from(JSON.stringify(doc)); json = Buffer.concat([json, Buffer.alloc((-json.length) & 3, 32)]); binary = Buffer.concat([binary, Buffer.alloc((-binary.length) & 3)]);
    const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    const payload = Buffer.concat([chunk(0x4e4f534a, json), chunk(0x004e4942, binary)]), h = Buffer.alloc(12); h.write('glTF'); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + payload.length, 8); files['model.glb'] = Buffer.concat([h, payload]);
  } else files['model.gltf'] = Buffer.from(JSON.stringify(doc));
  return files;
}
const READBACK = String.raw`
import bpy,sys,json,hashlib,math
from pathlib import Path
path,out=sys.argv[sys.argv.index('--')+1:];file=Path(path);before=hashlib.sha256(file.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=path)
rows=[]
for image in bpy.data.images:
 if image.source!='FILE':continue
 assert list(image.size)==[8,8] and image.packed_file and image.has_data and image.colorspace_settings.name=='sRGB'
 pixels=list(image.pixels[:]);assert all(math.isfinite(x) for x in pixels) and max(x for i,x in enumerate(pixels) if i%4!=3)>0.2
 rows.append({'name':image.name,'size':list(image.size),'packedBytes':len(image.packed_file.data),'packedSha256':hashlib.sha256(image.packed_file.data).hexdigest(),'colorspace':image.colorspace_settings.name})
materials=[]
for material in bpy.data.materials:
 if not material.use_nodes or not any(node.type=='TEX_IMAGE' for node in material.node_tree.nodes):continue
 shader=next(node for node in material.node_tree.nodes if node.type=='BSDF_PRINCIPLED')
 assert shader.inputs['Base Color'].is_linked and abs(shader.inputs['Roughness'].default_value-.24)<1e-6 and abs(shader.inputs['Metallic'].default_value-.15)<1e-6,'imported PBR parameters or image links changed'
 materials.append({'name':material.name,'roughness':shader.inputs['Roughness'].default_value,'metallic':shader.inputs['Metallic'].default_value,'baseColorLinked':True})
assert rows and materials and hashlib.sha256(file.read_bytes()).hexdigest()==before
Path(out).write_text(json.dumps({'passed':True,'sha256':before,'unchanged':True,'images':rows,'materials':materials,'nativeVersion':bpy.app.version_string},indent=2)+'\n')
`;
const PRESERVE = String.raw`
import sys,json,hashlib
from pathlib import Path
import bpy
root,project,specfile,checkpoint,out=sys.argv[sys.argv.index('--')+1:];sys.path.insert(0,str(Path(root)/'packages/deepblend/provider-local/python'))
import deepblend_scene as compiler
from deepblend_util import Guard,ActionError
file=Path(checkpoint);before_hash=hashlib.sha256(file.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=checkpoint)
before_objects=set(bpy.data.objects);before_images=set(bpy.data.images);calls=[]
def forbidden(*args):calls.append(args);raise AssertionError('resource refusal reached native model import')
compiler.import_asset_into_scene=forbidden
try:compiler.build_scene(json.loads(Path(specfile).read_text()),{'project_root':project,'profile':'preview'},Guard())
except ActionError as e:assert e.code=='ASSET_CONTENT_MISMATCH'
else:raise AssertionError('image budget accepted')
assert not calls and set(bpy.data.objects)==before_objects and set(bpy.data.images)==before_images,'image refusal cleared the current scene or allocated images'
assert hashlib.sha256(file.read_bytes()).hexdigest()==before_hash
Path(out).write_text(json.dumps({'passed':True,'code':'ASSET_CONTENT_MISMATCH','imports':len(calls),'objectsPreserved':True,'imagesPreserved':True,'checkpointSha256':before_hash},indent=2)+'\n')
`;
export async function checkImportedImageBudgets({ studio, output, root, python, check }) {
  mkdirSync(output); const spec = defaultSceneSpec({ projectId: 'imported-image-budget-proof', title: 'Imported image budgets' });
  const created = await studio.createProject({ title: spec.project.title, sceneSpec: spec, saveCheckpoint: true }), projectId = created.projectId, project = studio.store.projectDirectory(projectId);
  const declaration = item => ({ id: item.assetId, path: item.path, type: item.type, sha256: item.sha256 });
  const apply = operations => studio.applyScenePatch({ projectId, baseRevision: studio.store.currentRevision(projectId), operations });
  const ingest = async (name, files) => { const source = join(output, name); mkdirSync(source); for (const [file, bytes] of Object.entries(files)) writeFileSync(join(source, file), bytes); const entrypoint = existsSync(join(source, 'model.glb')) ? 'model.glb' : 'model.gltf'; const item = await studio.ingestAsset({ projectId, sourceRoot: source, sourcePath: join(source, entrypoint), assetId: name, license: 'MIT' }); save(join(output, name + '-ingest.json'), item); return declaration(item); };
  const small = encodePng({ width: 8, height: 8, data: Buffer.from(Array.from({ length: 64 }, (_, i) => i % 2 ? [20, 150, 90, 255] : [160, 40, 10, 255]).flat()) }), oversized = encodePng({ width: 9000, height: 1, data: Buffer.alloc(9000 * 4, 127) }), rows = [];
  for (const kind of ['external', 'image-data', 'buffer-data', 'buffer-file', 'glb-bin']) {
    const asset = await ingest('normal-' + kind, document(small, kind)); await apply([{ op: 'asset.add', asset }, { op: 'entity.add', entity: { id: asset.id, type: 'asset-instance', assetId: asset.id } }]);
    const revision = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', revision, 'scene.blend'), facts = join(output, kind + '-readback.json'); python('imported-' + kind + '-readback', READBACK, [checkpoint, facts]);
    check('normal ' + kind + ' texture is independently reopened packed at its actual dimensions', JSON.parse(readFileSync(facts)).passed);
    const bad = await ingest('oversized-' + kind, document(oversized, kind)), before = sha(readFileSync(checkpoint)), originalSpec = join(project, 'revisions', revision, 'scene-spec.json'), specHash = sha(readFileSync(originalSpec)); let error;
    try { await apply([{ op: 'asset.add', asset: bad }, { op: 'entity.add', entity: { id: bad.id, type: 'asset-instance', assetId: bad.id } }]); } catch (value) { error = value; }
    check('public ' + kind + ' oversize refusal retains the revision, checkpoint and source specification', error?.code === 'ASSET_CONTENT_MISMATCH' && studio.store.currentRevision(projectId) === revision && sha(readFileSync(checkpoint)) === before && sha(readFileSync(originalSpec)) === specHash);
    const rejected = JSON.parse(readFileSync(originalSpec)); rejected.assets.push(bad); rejected.entities.push({ id: bad.id, type: 'asset-instance', assetId: bad.id }); const rejectedSpec = join(output, kind + '-rejected-spec.json'), preserved = join(output, kind + '-preservation.json'); save(rejectedSpec, rejected); python('imported-' + kind + '-preservation', PRESERVE, [root, project, rejectedSpec, checkpoint, preserved]);
    check('native ' + kind + ' refusal occurs before reset or model import', JSON.parse(readFileSync(preserved)).passed);
    rows.push({ kind, revision, code: error.code, checkpointSha256: before, specSha256: specHash, oversizedSourceSha256: sha(oversized), readback: kind + '-readback.json', preservation: kind + '-preservation.json' });
  }
  const webpPath = join(output, 'native.webp'), oversizedWebp = join(output, 'oversized.webp');
  python('imported-webp-generate', String.raw`
import bpy,sys
for path,width,height in [(sys.argv[sys.argv.index('--')+1],8,8),(sys.argv[sys.argv.index('--')+2],9000,1)]:
 image=bpy.data.images.new('source',width=width,height=height);image.pixels=[.2,.5,.1,1]*(width*height);image.file_format='WEBP';image.filepath_raw=path;image.save()
`, [webpPath, oversizedWebp]);
  for (const fallback of [false, true]) {
    const files = document(small, 'external'), doc = JSON.parse(files['model.gltf']); doc.images.push({ uri: 'paint.webp', mimeType: 'image/webp' }); doc.textures[0].extensions = { EXT_texture_webp: { source: 1 } }; doc.extensionsUsed = ['EXT_texture_webp']; if (!fallback) delete doc.textures[0].source; files['paint.webp'] = readFileSync(fallback ? oversizedWebp : webpPath); files['model.gltf'] = Buffer.from(JSON.stringify(doc)); const asset = await ingest(fallback ? 'webp-fallback' : 'webp-only', files);
    await apply([{ op: 'asset.add', asset }, { op: 'entity.add', entity: { id: asset.id, type: 'asset-instance', assetId: asset.id } }]); const revision = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', revision, 'scene.blend'), facts = join(output, asset.id + '-readback.json'); python('imported-' + asset.id + '-readback', READBACK, [checkpoint, facts]); check('native ' + asset.id + ' source selection remains usable and packed', JSON.parse(readFileSync(facts)).passed);
  }
  const jpegPath = join(output, 'native.jpg'), oversizedJpeg = join(output, 'oversized.jpg');
  python('imported-jpeg-generate', String.raw`
import bpy,sys
for path,width,height in [(sys.argv[sys.argv.index('--')+1],8,8),(sys.argv[sys.argv.index('--')+2],9000,1)]:
 image=bpy.data.images.new('source',width=width,height=height);image.pixels=[.2,.5,.1,1]*(width*height);image.file_format='JPEG';image.filepath_raw=path;image.save()
`, [jpegPath, oversizedJpeg]);
  const jpegRows = [];
  for (const kind of ['external', 'glb-bin']) {
    const asset = await ingest('jpeg-' + kind, document(readFileSync(jpegPath), kind, 'image/jpeg', 'paint.jpg')); await apply([{ op: 'asset.add', asset }, { op: 'entity.add', entity: { id: asset.id, type: 'asset-instance', assetId: asset.id } }]); const revision = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', revision, 'scene.blend'), facts = join(output, asset.id + '-readback.json'); python('imported-' + asset.id + '-readback', READBACK, [checkpoint, facts]); check('native JPEG ' + kind + ' remains packed with actual sRGB pixels', JSON.parse(readFileSync(facts)).passed);
    const before = sha(readFileSync(checkpoint)), bad = await ingest('oversized-jpeg-' + kind, document(readFileSync(oversizedJpeg), kind, 'image/jpeg', 'paint.jpg')); let error; try { await apply([{ op: 'asset.add', asset: bad }, { op: 'entity.add', entity: { id: bad.id, type: 'asset-instance', assetId: bad.id } }]); } catch (value) { error = value; } check('public JPEG ' + kind + ' oversize refusal retains the saved revision', error?.code === 'ASSET_CONTENT_MISMATCH' && studio.store.currentRevision(projectId) === revision && sha(readFileSync(checkpoint)) === before); save(join(output, bad.id + '-refusal.json'), { code: error?.code, revision, checkpointSha256: before, sourceSha256: sha(readFileSync(oversizedJpeg)) });
    const rejected = JSON.parse(readFileSync(join(project, 'revisions', revision, 'scene-spec.json'))); rejected.assets.push(bad); rejected.entities.push({ id: bad.id, type: 'asset-instance', assetId: bad.id }); const rejectedSpec = join(output, bad.id + '-rejected-spec.json'), preserved = join(output, bad.id + '-preservation.json'); save(rejectedSpec, rejected); python('imported-' + bad.id + '-preservation', PRESERVE, [root, project, rejectedSpec, checkpoint, preserved]); check('native JPEG ' + kind + ' refuses before reset or any model import', JSON.parse(readFileSync(preserved)).passed); jpegRows.push({ kind, revision, checkpointSha256: before, readback: asset.id + '-readback.json', preservation: bad.id + '-preservation.json', rejectedSpec: bad.id + '-rejected-spec.json' });
  }
  const corrupted = Buffer.from(small); corrupted[corrupted.indexOf(Buffer.from('IDAT')) + 4] ^= 255;
  const corruptAsset = await ingest('corrupt-payload', document(corrupted, 'image-data')), beforeRevision = studio.store.currentRevision(projectId), beforeCheckpoint = join(project, 'revisions', beforeRevision, 'scene.blend'), beforeHash = sha(readFileSync(beforeCheckpoint)); let corruptError;
  try { await apply([{ op: 'asset.add', asset: corruptAsset }, { op: 'entity.add', entity: { id: corruptAsset.id, type: 'asset-instance', assetId: corruptAsset.id } }]); } catch (value) { corruptError = value; }
  check('native pixel corruption refuses despite a valid bounded image header', corruptError?.code === 'ASSET_CONTENT_MISMATCH');
  check('failed native image decoding keeps the saved revision and checkpoint unchanged', studio.store.currentRevision(projectId) === beforeRevision && sha(readFileSync(beforeCheckpoint)) === beforeHash);
  save(join(output, 'corrupt-payload-refusal.json'), { code: corruptError?.code, revision: beforeRevision, checkpointSha256: beforeHash, sourceSha256: sha(corrupted), validDimensions: [8, 8] });
  // This synthetic header has no large pixel payload; only refusal is allowed.
  const budget = Buffer.from(small); budget.writeUInt32BE(8192, 16); budget.writeUInt32BE(4096, 20); let crc = 0xffffffff; for (const byte of budget.subarray(12, 29)) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } budget.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  const asset = await ingest('aggregate-header', document(budget, 'image-data')), revision = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', revision, 'scene.blend'), before = sha(readFileSync(checkpoint)), currentSpec = JSON.parse(readFileSync(join(project, 'revisions', revision, 'scene-spec.json'))), entities = [0, 1].map(i => ({ id: 'aggregate-' + i, type: 'asset-instance', assetId: asset.id })); let refusal;
  try { await apply([{ op: 'asset.add', asset }, ...entities.map(entity => ({ op: 'entity.add', entity }))]); } catch (value) { refusal = value; }
  check('independent embedded instance estimates share the scene budget and refuse without publication', refusal?.code === 'ASSET_CONTENT_MISMATCH' && studio.store.currentRevision(projectId) === revision && sha(readFileSync(checkpoint)) === before);
  currentSpec.assets.push(asset); currentSpec.entities.push(...entities); const rejectedSpec = join(output, 'aggregate-rejected-spec.json'), preserved = join(output, 'aggregate-preservation.json'); save(rejectedSpec, currentSpec); python('imported-aggregate-preservation', PRESERVE, [root, project, rejectedSpec, checkpoint, preserved]); check('aggregate metadata-only refusal never decodes its payload or clears the scene', JSON.parse(readFileSync(preserved)).passed);
  save(join(output, 'report.json'), { passed: true, rows, webpSources: 2, jpegSources: 2, jpegRows, unselectedOversizedWebpSha256: sha(readFileSync(oversizedWebp)), corruptPayloadRefusal: 'corrupt-payload-refusal.json', aggregate: { metadataOnly: true, sha256: sha(budget), preservation: 'aggregate-preservation.json' }, project, revision, checkpoint, checkpointSha256: before, scope: 'Actual public Host and fixed native runtime, all five image transports, native source selection, packed checkpoint readback and scene-preserving header/aggregate refusals. Other model formats and global process peak memory remain separate work.' });
  assert.equal(rows.length, 5);
}
