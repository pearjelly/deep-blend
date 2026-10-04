/** Resource gates inspect real texture bytes in every glTF storage form. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { encodePng } from '@deepblend/dsh-blender-contracts';

const pythonRoot = resolve(import.meta.dirname, '../../../packages/deepblend/provider-local/python');
const script = String.raw`
import sys,json,tempfile,base64,builtins,types,io
from pathlib import Path
sys.path.insert(0,sys.argv[1]);request=json.load(sys.stdin)
from deepblend_gltf_images import inspect_gltf_images,DataSlice
from deepblend_image_headers import inspect_image_header
from deepblend_util import ActionError
reads=0;decoded=0;original_open=builtins.open;original_decode=base64.b64decode
class Spy:
 def __init__(self,source):self.source=source
 def __enter__(self):return self
 def __exit__(self,*args):self.source.close()
 def fileno(self):return self.source.fileno()
 def seek(self,*args):return self.source.seek(*args)
 def read(self,count):
  global reads
  assert count>=0,'unbounded read';data=self.source.read(count);reads+=len(data);return data
def decode(*args,**kwargs):
 global decoded
 value=original_decode(*args,**kwargs);decoded+=len(value);return value
with tempfile.TemporaryDirectory() as directory:
 for name,value in request.get('files',{}).items():
  path=Path(directory)/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(original_decode(value))
 builtins.open=lambda *args,**kwargs:Spy(original_open(*args,**kwargs));base64.b64decode=decode
 try:
  mode=request.get('mode','model')
  if mode=='image':facts=inspect_image_header(io.BytesIO(original_decode(request['bytes'])))
  elif mode=='slice':
   data=DataSlice(request['uri'],request['offset'],request['length']);facts={'hex':data.read(request['length']).hex()}
  elif mode=='scene':
   sys.modules['bpy']=types.SimpleNamespace();from deepblend_images import check_scene_image_budget
   facts=check_scene_image_budget(request['spec'],directory)
  else:facts=inspect_gltf_images(directory,request['asset'])
  result={'ok':True,'facts':facts}
 except (ActionError,ValueError) as e:result={'ok':False,'code':getattr(e,'code',None),'error':str(e)}
 result.update(readBytes=reads,decodedBytes=decoded);print(json.dumps(result))
`;
function python(input) {
  const result = spawnSync('python3', ['-c', script, pythonRoot], { input: JSON.stringify(input), encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const b64 = bytes => bytes.toString('base64');
const uri = bytes => 'data:application/octet-stream;base64,' + b64(bytes);
function crc(bytes) { let c = 0xffffffff; for (const x of bytes) { c ^= x; for (let n = 0; n < 8; n++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function png(width = 4, height = 3) {
  const bytes = Buffer.from(encodePng({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }));
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes.writeUInt32BE(crc(bytes.subarray(12, 29)), 29); return bytes;
}
function glb(document, binary) {
  let json = Buffer.from(JSON.stringify(document)); json = Buffer.concat([json, Buffer.alloc((-json.length) & 3, 32)]);
  const chunk = (type, bytes) => { const header = Buffer.alloc(8); header.writeUInt32LE(bytes.length); header.writeUInt32LE(type, 4); return Buffer.concat([header, bytes]); };
  const chunks = [chunk(0x4e4f534a, json)]; if (binary) chunks.push(chunk(0x004e4942, Buffer.concat([binary, Buffer.alloc((-binary.length) & 3)])));
  const payload = Buffer.concat(chunks), header = Buffer.alloc(12); header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(payload.length + 12, 8); return Buffer.concat([header, payload]);
}
function fixture(kind = 'external', bytes = png(), offset = 7) {
  const doc = { asset: { version: '2.0' }, images: [{ uri: 'paint.png' }], textures: [{ source: 0 }] }, files = {}, binary = Buffer.concat([Buffer.alloc(offset, 89), bytes]); let path = 'model.gltf';
  if (kind === 'external') files['paint.png'] = b64(bytes);
  else if (kind === 'image-data') doc.images[0].uri = 'data:image/png;base64,' + b64(bytes);
  else {
    doc.images = [{ bufferView: 0, mimeType: 'image/png' }]; doc.bufferViews = [{ buffer: 0, byteOffset: offset, byteLength: bytes.length }]; doc.buffers = [{ byteLength: binary.length }];
    if (kind === 'buffer-data') doc.buffers[0].uri = uri(binary);
    else if (kind === 'buffer-file') { doc.buffers[0].uri = 'model.bin'; files['model.bin'] = b64(binary); }
    else path = 'model.glb';
  }
  const request = { files, asset: { path, type: path.endsWith('.glb') ? 'glb' : 'gltf' } };
  const save = () => { files[request.asset.path] = b64(request.asset.type === 'glb' ? glb(doc, binary) : Buffer.from(JSON.stringify(doc))); return request; };
  return { doc, binary, request, save };
}
const transports = ['external', 'image-data', 'buffer-data', 'buffer-file', 'glb-bin'];
test('all five texture transports inspect actual dimensions and decoded allocation', () => {
  for (const kind of transports) { const result = python(fixture(kind).save()); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.facts.images, 1); assert.equal(result.facts.decodedBytes, 4 * 3 * 16); assert.equal(result.facts.facts[0].headerBytes, 33); }
});
test('every texture transport refuses the actual oversize header', () => {
  for (const kind of transports) { const result = python(fixture(kind, png(9000, 1)).save()); assert.equal(result.code, 'ASSET_CONTENT_MISMATCH'); assert.match(result.error, /dimensions/); }
});
test('nested relative and percent-encoded resources stay inside the asset root', () => {
  const f = fixture(); f.request.asset.path = 'models/model.gltf'; f.doc.images[0].uri = '../paint%20%C3%A9.png'; f.request.files['paint é.png'] = f.request.files['paint.png'];
  assert.equal(python(f.save()).ok, true);
  for (const path of ['../../escape.png', '../%2Fescape.png', 'https://example.invalid/a.png']) { f.doc.images[0].uri = path; assert.equal(python(f.save()).ok, false); }
});
test('image view bounds, resource indices and buffer lengths refuse before image reads', () => {
  for (const kind of ['buffer-file', 'buffer-data', 'glb-bin']) for (const change of [f => f.doc.bufferViews[0].byteOffset = -1, f => f.doc.bufferViews[0].byteLength++, f => f.doc.bufferViews[0].buffer = false, f => f.doc.images[0].bufferView = 9, f => f.doc.buffers[0].byteLength--, f => f.doc.buffers[0].byteLength += kind === 'glb-bin' ? 4 : 1, f => f.doc.bufferViews[0].byteStride = 4]) {
    const f = fixture(kind); change(f); const result = python(f.save()); assert.equal(result.ok, false, JSON.stringify(result)); assert(['ASSET_CONTENT_MISMATCH', 'ASSET_REQUEST_INVALID'].includes(result.code), JSON.stringify(result));
  }
});
test('a short image view cannot borrow a complete header from following buffer bytes', () => {
  const f = fixture('buffer-file'); f.doc.bufferViews[0].byteLength = 20; const result = python(f.save()); assert.equal(result.code, 'ASSET_CONTENT_MISMATCH'); assert.match(result.error, /truncated/);
});
test('base64 slices decode only needed quartets even at unaligned offsets', () => {
  const bytes = Buffer.from(Array.from({ length: 123 }, (_, i) => i));
  for (let offset = 0; offset < 9; offset++) { const result = python({ mode: 'slice', uri: uri(bytes), offset, length: 17 }); assert.equal(result.ok, true); assert.equal(result.facts.hex, bytes.subarray(offset, offset + 17).toString('hex')); assert(result.decodedBytes <= 21); }
  for (const [offset, length] of [[-1, 4], [120, 4], [124, 0]]) assert.equal(python({ mode: 'slice', uri: uri(bytes), offset, length }).ok, false);
});
test('small image headers near the end of large data URI buffers do not decode the whole buffer', () => {
  const f = fixture('buffer-data', png(), 2 * 1024 * 1024 + 1), result = python(f.save()); assert.equal(result.ok, true); assert(result.decodedBytes <= 48, JSON.stringify(result));
});
test('GLB image reads seek to the exact BIN view instead of loading its payload', () => {
  const f = fixture('glb-bin', png(), 2 * 1024 * 1024 + 1), result = python(f.save()); assert.equal(result.ok, true); assert(result.readBytes < 1024, JSON.stringify(result)); assert.equal(result.decodedBytes, 0);
});
test('external BIN views read only their image header', () => {
  const f = fixture('buffer-file', png(), 2 * 1024 * 1024 + 2), result = python(f.save()); assert.equal(result.ok, true); assert(result.readBytes < 1024, JSON.stringify(result));
});
test('repeated texture references reuse one image inside an imported model', () => {
  const f = fixture(); f.doc.textures.push({ source: 0 }); const result = python(f.save()); assert.equal(result.facts.images, 1); assert.equal(result.facts.decodedBytes, 192);
});
function scene(f, instances = 1, extra = {}) { return { ...f.save(), mode: 'scene', spec: { assets: [{ id: 'model', ...f.request.asset }], entities: Array.from({ length: instances }, (_, i) => ({ id: 'object-' + i, type: 'asset-instance', assetId: 'model' })), ...extra } }; }
test('scene estimates count repeated imports independently while caching header facts', () => {
  const f = fixture('image-data'), single = python(scene(f)), repeated = python(scene(f, 2)); assert.equal(repeated.facts.importedImages, 2); assert.equal(repeated.facts.decodedBytes, single.facts.decodedBytes * 2); assert.equal(repeated.decodedBytes, single.decodedBytes);
});
test('repeated embedded imports enforce the inclusive 1 GiB scene allocation boundary', () => {
  const f = fixture('image-data', png(8192, 8192)); assert.equal(python(scene(f)).ok, true); const result = python(scene(f, 2)); assert.equal(result.code, 'ASSET_CONTENT_MISMATCH'); assert.match(result.error, /scene images exceed/);
});
test('imported and explicit environment allocations share the same scene budget', () => {
  const f = fixture('image-data', png(8192, 8192)); f.request.files['environment.png'] = b64(png()); const input = scene(f); input.spec.assets.push({ id: 'environment', type: 'png', path: 'environment.png' }); input.spec.world = { environment: { assetId: 'environment' } }; const result = python(input); assert.equal(result.code, 'ASSET_CONTENT_MISMATCH'); assert.match(result.error, /scene images exceed/);
});
test('pinned native source choice preserves core images and unselected WebP or BasisU fallbacks', () => {
  const f = fixture(); f.doc.images.push({ uri: 'ignored.webp', mimeType: 'image/webp' }, { uri: 'ignored.ktx2', mimeType: 'image/ktx2' }); f.doc.textures[0].extensions = { EXT_texture_webp: { source: 1 }, KHR_texture_basisu: { source: 2 } }; const core = python(f.save()); assert.equal(core.ok, true, JSON.stringify(core)); assert.equal(core.facts.images, 1);
  f.doc.textures = [{ extensions: { KHR_texture_basisu: { source: 2 } } }]; const basis = python(f.save()); assert.equal(basis.ok, true, JSON.stringify(basis)); assert.equal(basis.facts.images, 0);
});
test('invalid image source indices, dual storage and declared media mismatches refuse', () => {
  for (const change of [f => f.doc.textures[0].source = false, f => f.doc.textures[0].source = true, f => f.doc.textures[0].source = 99, f => f.doc.images[0].bufferView = 0, f => f.doc.images[0].mimeType = 'image/jpeg']) { const f = fixture(); change(f); assert.equal(python(f.save()).code, 'ASSET_CONTENT_MISMATCH'); }
});
function webp(kind, width, height, flags = 0) {
  let data;
  if (kind === 'VP8L') { data = Buffer.alloc(5); data[0] = 0x2f; data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1); }
  else if (kind === 'VP8 ') { data = Buffer.from([0x10, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0]); data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8); }
  else { data = Buffer.alloc(10); data[0] = flags; data.writeUIntLE(width - 1, 4, 3); data.writeUIntLE(height - 1, 7, 3); }
  const header = Buffer.alloc(20); header.write('RIFF'); header.writeUInt32LE(12 + data.length + data.length % 2, 4); header.write('WEBP', 8); header.write(kind, 12); header.writeUInt32LE(data.length, 16); return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
test('WebP lossless, lossy and extended headers use their actual independent dimensions', () => {
  for (const kind of ['VP8L', 'VP8 ', 'VP8X']) { const result = python({ mode: 'image', bytes: b64(webp(kind, 8192, 3)) }); assert.equal(result.ok, true); assert.equal(result.facts.parts[0].width, 8192); assert.equal(result.facts.parts[0].height, 3); assert.equal(python({ mode: 'image', bytes: b64(webp(kind, 9000, 1)) }).ok, false); }
});
test('WebP animated, reserved, truncated and escaping chunks never reach native decoding', () => {
  const valid = webp('VP8X', 8, 5), escaped = Buffer.from(valid); escaped.writeUInt32LE(1000, 16); const shortContainer = Buffer.from(valid); shortContainer.writeUInt32LE(20, 4); const lossless = webp('VP8L', 4, 3); lossless[20] = 0;
  const metadata = Buffer.alloc(1024 * 1024 + 8); metadata.write('ICCP'); metadata.writeUInt32LE(1024 * 1024, 4); const over = Buffer.concat([valid.subarray(0, 12), metadata, valid.subarray(12)]); over.writeUInt32LE(over.length - 8, 4);
  for (const bytes of [webp('VP8X', 8, 5, 2), webp('VP8X', 8, 5, 0x80), valid.subarray(0, 25), escaped, shortContainer, lossless, over]) assert.equal(python({ mode: 'image', bytes: b64(bytes) }).ok, false);
});
test('WebP-only extension sources are inspected while core fallback dimensions remain authoritative', () => {
  const f = fixture(); f.doc.images = [{ uri: 'paint.webp', mimeType: 'image/webp' }]; f.doc.textures = [{ extensions: { EXT_texture_webp: { source: 0 } } }]; f.request.files['paint.webp'] = b64(webp('VP8L', 4, 3)); assert.equal(python(f.save()).facts.decodedBytes, 192); f.request.files['paint.webp'] = b64(webp('VP8L', 9000, 1)); assert.equal(python(f.save()).code, 'ASSET_CONTENT_MISMATCH');
});
