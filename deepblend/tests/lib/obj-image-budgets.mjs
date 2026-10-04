/** Public OBJ resource budgets and native readbacks for every accepted fixture. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defaultSceneSpec } from '@deepblend/dsh-blender-host';
import { encodePng } from '@deepblend/dsh-blender-contracts';
import { PRESERVE } from './imported-image-budgets.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const mesh = 'mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl painted\nf 1/1 2/2 3/3\n';
const material = file => 'newmtl painted\nPr .24\nPm .15\nmap_Kd ' + file + '\n';
const READBACK = String.raw`
import bpy,sys,json,hashlib,math
from pathlib import Path
checkpoint,image_path,entity,out=sys.argv[sys.argv.index('--')+1:]
file=Path(checkpoint);before=hashlib.sha256(file.read_bytes()).hexdigest();source=Path(image_path);raw=source.read_bytes()
original=bpy.data.images.load(str(source),check_existing=False);size=list(original.size);pixels=list(original.pixels[:]);assert size==[64,64] and original.has_data
digest=hashlib.sha256(json.dumps(pixels,separators=(',',':')).encode()).hexdigest();bpy.ops.wm.open_mainfile(filepath=checkpoint)
rows=[];meshes=[];root=bpy.data.objects['db_entity__'+entity]
for obj in bpy.context.scene.objects:
 if obj.type!='MESH' or not obj.data.uv_layers:continue
 parent=obj.parent
 while parent and parent!=root:parent=parent.parent
 if parent!=root:continue
 meshes.append({'vertices':len(obj.data.vertices),'faces':len(obj.data.polygons),'uv':[[list(loop.uv) for loop in layer.data] for layer in obj.data.uv_layers]})
 for slot in obj.material_slots:
  mat=slot.material
  if not mat or not mat.use_nodes:continue
  textures=[node for node in mat.node_tree.nodes if node.type=='TEX_IMAGE' and node.image]
  if not textures:continue
  shader=next(node for node in mat.node_tree.nodes if node.type=='BSDF_PRINCIPLED')
  assert shader.inputs['Base Color'].is_linked and abs(shader.inputs['Roughness'].default_value-.24)<1e-6 and abs(shader.inputs['Metallic'].default_value-.15)<1e-6
  for node in textures:
   image=node.image;assert list(image.size)==size and image.packed_file and image.has_data
   values=list(image.pixels[:]);assert all(math.isfinite(x) for x in values)
   assert hashlib.sha256(json.dumps(values,separators=(',',':')).encode()).hexdigest()==digest
   packed=bytes(image.packed_file.data);assert packed==raw
   rows.append({'size':size,'packedSha256':hashlib.sha256(packed).hexdigest(),'pixelsSha256':digest,'colorspace':image.colorspace_settings.name})
assert rows and len(meshes)==1 and meshes[0]['vertices']==3 and meshes[0]['faces']==1
assert meshes[0]['uv'][0]==[[0,0],[1,0],[0,1]] and hashlib.sha256(file.read_bytes()).hexdigest()==before
Path(out).write_text(json.dumps({'passed':True,'checkpointSha256':before,'sourceSha256':hashlib.sha256(raw).hexdigest(),'images':rows,'meshes':meshes,'nativeVersion':bpy.app.version_string,'buildHash':bpy.app.build_hash.decode()},indent=2)+'\n')
`;

export async function checkObjImageBudgets({ studio, output, root, python, check }) {
  mkdirSync(output);
  const fixtures = join(root, 'deepblend/tests/fixtures/obj-image-formats'), manifest = JSON.parse(readFileSync(join(fixtures, 'formats.json')));
  const spec = defaultSceneSpec({ projectId: 'obj-image-budget-proof', title: 'OBJ image budgets' });
  const created = await studio.createProject({ title: spec.project.title, sceneSpec: spec, saveCheckpoint: true });
  const projectId = created.projectId, project = studio.store.projectDirectory(projectId);
  const apply = operations => studio.applyScenePatch({ projectId, baseRevision: studio.store.currentRevision(projectId), operations });
  const ingest = async (name, files) => {
    const source = join(output, name); mkdirSync(source);
    for (const [file, bytes] of Object.entries(files)) writeFileSync(join(source, file), bytes);
    const receipt = await studio.ingestAsset({ projectId, sourceRoot: source, sourcePath: join(source, 'model.obj'), assetId: name, license: 'MIT' });
    save(join(output, name + '-ingest.json'), receipt);
    rmSync(source, { recursive: true });
    return { asset: { id: receipt.assetId, type: receipt.type, path: receipt.path, sha256: receipt.sha256 }, receipt };
  };
  const oversized = encodePng({ width: 9000, height: 1, data: Buffer.alloc(9000 * 4, 127) }), rows = [];
  let previous;
  const cases = manifest.images.map(row => ({ name: row.format.toLowerCase(), row, bytes: readFileSync(join(fixtures, row.file)), model: mesh, mtl: material(row.file) }));
  const pngRow = manifest.images.find(row => row.format === 'PNG');
  for (const name of ['unused-material', 'shadowed-map', 'implicit-library']) {
    let model = mesh, mtl = material(pngRow.file);
    if (name === 'unused-material') mtl += 'newmtl unused\nmap_Kd large.png\n';
    else if (name === 'shadowed-map') mtl = 'newmtl painted\nmap_Kd large.png\n' + material(pngRow.file);
    else model = mesh.replace('mtllib model.mtl\n', 'mtllib first.mtl\n');
    cases.push({ name, row: pngRow, bytes: readFileSync(join(fixtures, pngRow.file)), model, mtl, extra: { 'large.png': oversized, ...(name === 'implicit-library' ? { 'first.mtl': 'newmtl painted\nmap_Kd large.png\n' } : {}) } });
  }
  for (const name of ['repeated-library-alias', 'alias-basename-fallback']) {
    const libraries = name === 'repeated-library-alias' ? 'model.mtl\nmtllib middle.mtl\nmtllib ./model.mtl' : './model.mtl\nmtllib middle.mtl';
    cases.push({ name, row: pngRow, bytes: readFileSync(join(fixtures, pngRow.file)), model: mesh.replace('mtllib model.mtl', 'mtllib ' + libraries), mtl: material(pngRow.file), extra: { 'large.png': oversized, 'middle.mtl': 'newmtl painted\nmap_Kd large.png\n' } });
  }
  const avifRow = manifest.images.find(row => row.format === 'AVIF'), mismatch = Buffer.from(readFileSync(join(fixtures, avifRow.file))), extent = mismatch.indexOf('ispe');
  mismatch.writeUInt32BE(16, extent + 8); mismatch.writeUInt32BE(16, extent + 12);
  cases.push({ name: 'avif-container-smaller', row: avifRow, bytes: mismatch, model: mesh, mtl: material(avifRow.file) });
  for (const item of cases) {
    const name = 'obj-' + item.name, { asset, receipt } = await ingest(name, { 'model.obj': item.model, 'model.mtl': item.mtl, [item.row.file]: item.bytes, ...item.extra });
    if (manifest.images.some(row => row.format.toLowerCase() === item.name)) assert.equal(sha(item.bytes), item.row.sha256);
    const operations = previous ? [{ op: 'entity.remove', entityId: previous }, { op: 'asset.remove', assetId: previous }] : [];
    await apply([...operations, { op: 'asset.add', asset }, { op: 'entity.add', entity: { id: name, type: 'asset-instance', assetId: name } }]); previous = name;
    const revision = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', revision, 'scene.blend'), imagePath = join(project, 'assets/bundles', receipt.bundle.sha256, item.row.file), readback = join(output, name + '-readback.json');
    check('public ' + name + ' preserves locked source bytes after original source removal', sha(readFileSync(imagePath)) === sha(item.bytes));
    python(name + '-readback', READBACK, [checkpoint, imagePath, name, readback]);
    check('native ' + name + ' retains exact packed bytes, UV, PBR values and decoded pixels', JSON.parse(readFileSync(readback)).passed);
    rows.push({ name, revision, checkpoint, sourceSha256: sha(item.bytes), readback, bundleSha256: receipt.bundle.sha256 });
  }
  const revision = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', revision, 'scene.blend'), specPath = join(project, 'revisions', revision, 'scene-spec.json');
  const avifPath = join(output, 'coded-oversized.avif'), nativeAvif = join(output, 'coded-oversized-native.json');
  python('obj-oversized-avif-generate', String.raw`
import bpy,sys,json,struct,hashlib
from pathlib import Path
image_path,out=sys.argv[sys.argv.index('--')+1:];image=bpy.data.images.new('authored oversize',width=9000,height=1,alpha=True);image.pixels=[.2,.5,.1,1]*9000
scene=bpy.context.scene;scene.render.image_settings.file_format='AVIF';scene.render.image_settings.color_mode='RGBA';image.save_render(image_path,scene=scene)
file=Path(image_path);data=bytearray(file.read_bytes());offset=data.index(b'ispe');struct.pack_into('>II',data,offset+8,64,64);file.write_bytes(data)
loaded=bpy.data.images.load(image_path,check_existing=False);size=list(loaded.size);assert size[0]>=9000 and loaded.has_data
Path(out).write_text(json.dumps({'nativeSize':size,'containerSize':[64,64],'encodedSha256':hashlib.sha256(data).hexdigest(),'nativeVersion':bpy.app.version_string,'buildHash':bpy.app.build_hash.decode()},indent=2)+'\n')
`, [avifPath, nativeAvif]);
  const badAvif = await ingest('obj-hidden-avif', { 'model.obj': mesh, 'model.mtl': material(avifRow.file), [avifRow.file]: readFileSync(avifPath) });
  let avifRefusal; try { await apply([{ op: 'asset.add', asset: badAvif.asset }, { op: 'entity.add', entity: { id: badAvif.asset.id, type: 'asset-instance', assetId: badAvif.asset.id } }]); } catch (error) { avifRefusal = error; }
  check('public AVIF coded oversize refuses even when container properties claim 64 pixels', avifRefusal?.code === 'ASSET_CONTENT_MISMATCH' && studio.store.currentRevision(projectId) === revision);
  const avifRejected = JSON.parse(readFileSync(specPath)); avifRejected.assets.push(badAvif.asset); avifRejected.entities.push({ id: badAvif.asset.id, type: 'asset-instance', assetId: badAvif.asset.id });
  const avifRejectedPath = join(output, 'avif-rejected-spec.json'), avifPreserved = join(output, 'avif-preservation.json'); save(avifRejectedPath, avifRejected);
  python('obj-avif-preservation', PRESERVE, [root, project, avifRejectedPath, checkpoint, avifPreserved]);
  check('native hidden AVIF refusal preserves live objects and images before any model import', JSON.parse(readFileSync(avifPreserved)).passed);
  const aliasAsset = await ingest('obj-hidden-library-alias', { 'model.obj': mesh.replace('mtllib model.mtl', 'mtllib model.mtl\nmtllib middle.mtl\nmtllib ./model.mtl'), 'model.mtl': 'newmtl painted\nmap_Kd large.png\n', 'middle.mtl': material(pngRow.file), [pngRow.file]: readFileSync(join(fixtures, pngRow.file)), 'large.png': oversized });
  let aliasRefusal; try { await apply([{ op: 'asset.add', asset: aliasAsset.asset }, { op: 'entity.add', entity: { id: aliasAsset.asset.id, type: 'asset-instance', assetId: aliasAsset.asset.id } }]); } catch (error) { aliasRefusal = error; }
  check('public repeated MTL spelling refuses the actual last selected oversized image', aliasRefusal?.code === 'ASSET_CONTENT_MISMATCH' && studio.store.currentRevision(projectId) === revision);
  const aliasRejected = JSON.parse(readFileSync(specPath)); aliasRejected.assets.push(aliasAsset.asset); aliasRejected.entities.push({ id: aliasAsset.asset.id, type: 'asset-instance', assetId: aliasAsset.asset.id });
  const aliasRejectedPath = join(output, 'alias-rejected-spec.json'), aliasPreserved = join(output, 'alias-preservation.json'); save(aliasRejectedPath, aliasRejected);
  python('obj-alias-preservation', PRESERVE, [root, project, aliasRejectedPath, checkpoint, aliasPreserved]);
  check('native MTL alias oversize refuses before resetting objects or loading images', JSON.parse(readFileSync(aliasPreserved)).passed);
  const header = Buffer.from(readFileSync(join(fixtures, pngRow.file))); header.writeUInt32BE(8192, 16); header.writeUInt32BE(4096, 20);
  let crc = 0xffffffff; for (const byte of header.subarray(12, 29)) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } header.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  const { asset } = await ingest('obj-aggregate', { 'model.obj': mesh, 'model.mtl': material(pngRow.file), [pngRow.file]: header });
  const entities = [0, 1].map(index => ({ id: 'aggregate-' + index, type: 'asset-instance', assetId: asset.id })), before = sha(readFileSync(checkpoint)), specHash = sha(readFileSync(specPath));
  let refusal; try { await apply([{ op: 'asset.add', asset }, ...entities.map(entity => ({ op: 'entity.add', entity }))]); } catch (error) { refusal = error; }
  check('public repeated OBJ instances share the scene budget before publishing any revision', refusal?.code === 'ASSET_CONTENT_MISMATCH' && studio.store.currentRevision(projectId) === revision && sha(readFileSync(checkpoint)) === before && sha(readFileSync(specPath)) === specHash);
  const rejected = JSON.parse(readFileSync(specPath)); rejected.assets.push(asset); rejected.entities.push(...entities);
  const rejectedPath = join(output, 'aggregate-rejected-spec.json'), preservation = join(output, 'aggregate-preservation.json'); save(rejectedPath, rejected);
  python('obj-aggregate-preservation', PRESERVE, [root, project, rejectedPath, checkpoint, preservation]);
  check('native OBJ aggregate refusal retains live objects and images without loading its synthetic payload', JSON.parse(readFileSync(preservation)).passed);
  save(join(output, 'report.json'), { passed: true, rows, project, projectId, revision, alias: { code: aliasRefusal.code, preservation: aliasPreserved }, avif: { code: avifRefusal.code, native: nativeAvif, preservation: avifPreserved }, aggregate: { code: refusal.code, metadataOnly: true, checkpointSha256: before, preservation }, scope: 'Fifteen actual native accepted raster fixtures, selected OBJ map and MTL spelling compatibility, AVIF coded extent readback, and shared decoded image budgets. This does not bound decoder peak memory or prove every format variant.' });
}
