/** Resource refusals happen before native image allocation; metadata stays bounded. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { encodePng } from '@deepblend/dsh-blender-contracts';

const pythonRoot = resolve(import.meta.dirname, '../../../packages/deepblend/provider-local/python');
const inspectScript = String.raw`
import sys,json,io,base64
sys.path.insert(0,sys.argv[1])
from deepblend_image_headers import inspect_image_header
request=json.load(sys.stdin)
class Source(io.BytesIO):
 def __init__(self,data):super().__init__(data);self.total=0;self.largest=0
 def read(self,n=-1):
  assert n>=0,'unbounded read'
  self.largest=max(self.largest,n);data=super().read(n);self.total+=len(data);return data
source=Source(base64.b64decode(request['bytes']))
try:result={'ok':True,'facts':inspect_image_header(source)}
except ValueError as e:result={'ok':False,'error':str(e)}
result.update(readBytes=source.total,largestRead=source.largest);print(json.dumps(result))
`;
function python(script, input) {
  const result = spawnSync('python3', ['-c', script, pythonRoot], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const inspect = bytes => python(inspectScript, { bytes: bytes.toString('base64') });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width, height) {
  const data = Buffer.from(encodePng({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) }));
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  data.writeUInt32BE(crc32(data.subarray(12, 29)), 29);
  return data;
}
function jpeg(width, height, marker = 0xc0, metadata = Buffer.alloc(0)) {
  const app = Buffer.alloc(4); app[0] = 0xff; app[1] = 0xe1; app.writeUInt16BE(metadata.length + 2, 2);
  const frame = Buffer.from([0xff, marker, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, metadata, frame, Buffer.from([0xff, 0xda])]);
}
function attribute(name, type, bytes) {
  const size = Buffer.alloc(4); size.writeInt32LE(bytes.length);
  return Buffer.concat([Buffer.from(name + '\0' + type + '\0'), size, bytes]);
}
function exrPart(width, height, count = 3, extra = []) {
  const window = Buffer.alloc(16); window.writeInt32LE(width - 1, 8); window.writeInt32LE(height - 1, 12);
  const channels = [];
  for (let i = 0; i < count; i++) {
    const description = Buffer.alloc(16); description.writeInt32LE(1); description.writeInt32LE(1, 8); description.writeInt32LE(1, 12);
    channels.push(Buffer.from('c' + i + '\0'), description);
  }
  channels.push(Buffer.from([0]));
  return Buffer.concat([attribute('dataWindow', 'box2i', window), attribute('channels', 'chlist', Buffer.concat(channels)), ...extra, Buffer.from([0])]);
}
function exr(parts, flags = 0) {
  const start = Buffer.alloc(8); start.writeUInt32LE(20000630); start.writeUInt32LE(2 | flags, 4);
  return Buffer.concat([start, ...parts, ...(flags & 0x1000 ? [Buffer.from([0])] : [])]);
}

test('PNG accepts the documented side boundary and refuses larger or empty dimensions before payload reads', () => {
  const accepted = inspect(png(8192, 8192));
  assert.equal(accepted.ok, true); assert.equal(accepted.readBytes, 33);
  assert.equal(accepted.facts.decodedBytes, 1024 * 1024 * 1024);
  for (const [width, height] of [[8193, 1], [1, 8193], [0, 1], [1, 0], [0x7fffffff, 1]]) {
    const result = inspect(png(width, height)); assert.equal(result.ok, false); assert.match(result.error, /dimensions/); assert.equal(result.readBytes, 33);
  }
});

test('PNG corrupted or ambiguous size metadata never reaches the decoder', () => {
  for (const offset of [8, 12, 16, 24, 25, 26, 27, 28, 29]) {
    const bytes = png(4, 3); bytes[offset] ^= 0x80;
    assert.equal(inspect(bytes).ok, false, 'corruption at ' + offset);
  }
  for (const size of [0, 2, 8, 16, 32]) assert.equal(inspect(png(4, 3).subarray(0, size)).ok, false);
});

test('JPEG baseline and progressive sizes follow real frame markers after metadata, not extension or embedded marker text', () => {
  for (const marker of [0xc0, 0xc2]) {
    const bytes = jpeg(8192, 31, marker, Buffer.from([0xff, 0xc0, 0, 0, 0, 0]));
    const result = inspect(bytes); assert.equal(result.ok, true);
    assert.deepEqual(result.facts.parts[0], { width: 8192, height: 31, channels: 3, decodedBytes: 8192 * 31 * 16 });
    assert.equal(result.readBytes, bytes.length - 2);
  }
  assert.match(inspect(jpeg(8193, 1)).error, /dimensions/);
  assert.match(inspect(jpeg(1, 0)).error, /dimensions/);
  const bad = jpeg(1, 1); bad[15] = 0; assert.equal(inspect(bad).ok, false);
});

test('JPEG header scanning has a fixed byte budget even with legal maximum segment lengths', () => {
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(65533)]);
  const result = inspect(Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array(17).fill(segment), jpeg(1, 1).subarray(2)]));
  assert.equal(result.ok, false); assert.match(result.error, /metadata budget/);
  assert(result.readBytes <= 1024 * 1024); assert(result.largestRead <= 65533);
});

test('Radiance both axis orders and signs retain dimensions, while oversized, missing or repeated axes refuse', () => {
  const hdr = line => Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + line + '\nPIXELS');
  for (const line of ['-Y 8 +X 16', '+X 16 -Y 8']) {
    const result = inspect(hdr(line)); assert.equal(result.ok, true); assert.equal(result.facts.parts[0].width, 16); assert.equal(result.facts.parts[0].height, 8);
    assert.equal(result.readBytes, hdr(line).length - 6);
  }
  for (const line of ['-Y 8 +X 8193', '-X 16 +X 8', '-Y 0 +X 8']) assert.equal(inspect(hdr(line)).ok, false);
  assert.equal(inspect(Buffer.from('#?RGBE\n\n-Y 8 +X 16\n')).ok, false);
});

test('OpenEXR checks every multipart image and sums channel allocations before any pixels', () => {
  const bytes = exr([exrPart(16, 8), exrPart(8, 4, 6)], 0x1000), result = inspect(bytes);
  assert.equal(result.ok, true); assert.equal(result.facts.parts.length, 2); assert.equal(result.readBytes, bytes.length);
  assert.equal(result.facts.decodedBytes, 16 * 8 * 16 + 8 * 4 * 24);
  assert.match(inspect(exr([exrPart(16, 8), exrPart(8193, 1)], 0x1000)).error, /dimensions/);
  assert.match(inspect(exr([exrPart(8192, 8192), exrPart(1, 1)], 0x1000)).error, /decoded pixel budget/);
  assert.match(inspect(exr([exrPart(8192, 8192, 5)])).error, /decoded pixel budget/);
});

test('OpenEXR metadata, channels, names, deep samples and tile pyramids have explicit allocation bounds', () => {
  assert.equal(inspect(exr([exrPart(16, 8)], 0x800)).ok, false);
  assert.equal(inspect(exr([exrPart(16, 8)], 0x2000)).ok, false);
  assert.equal(inspect(exr([exrPart(16, 8, 65)])).ok, false);
  assert.equal(inspect(exr([exrPart(16, 8, 0)])).ok, false);
  const window = Buffer.alloc(16);
  assert.equal(inspect(exr([exrPart(16, 8, 3, [attribute('dataWindow', 'box2i', window)])])).ok, false);
  assert.equal(inspect(exr([exrPart(16, 8, 3, [attribute('a'.repeat(32), 'string', Buffer.from('x'))])])).ok, false);
  assert.equal(inspect(exr([exrPart(16, 8, 3, [attribute('a'.repeat(32), 'string', Buffer.from('x'))])], 0x400)).ok, true);
  const tiles = Buffer.from([16, 0, 0, 0, 16, 0, 0, 0, 2]);
  assert.match(inspect(exr([exrPart(8192, 8192, 3, [attribute('tiles', 'tiledesc', tiles)])], 0x200)).error, /decoded pixel budget/);
  assert.equal(inspect(exr(Array(257).fill(exrPart(1, 1)), 0x1000)).ok, false);
  const display = Buffer.alloc(16); display.writeInt32LE(8192, 8);
  assert.match(inspect(exr([exrPart(1, 1, 3, [attribute('displayWindow', 'box2i', display)])])).error, /dimensions/);
  const preview = Buffer.alloc(8); preview.writeUInt32LE(0xffffffff); preview.writeUInt32LE(0xffffffff, 4);
  assert.equal(inspect(exr([exrPart(1, 1, 3, [attribute('customPreview', 'preview', preview)])])).ok, false);
});

test('declared oversized maps refuse before calling Blender; failed loaded datablocks are removed', () => {
  const script = String.raw`
import sys,json,tempfile,base64,types
from pathlib import Path
sys.path.insert(0,sys.argv[1]);request=json.load(sys.stdin);calls=[];removed=[]
image=types.SimpleNamespace(size=[2,2],colorspace_settings=types.SimpleNamespace(name=''),pack=lambda:None)
def load(*args,**kwargs):calls.append(args);return image
sys.modules['bpy']=types.SimpleNamespace(data=types.SimpleNamespace(images=types.SimpleNamespace(load=load,remove=lambda i:removed.append(i))))
from deepblend_images import load_packed_image
from deepblend_util import ActionError
with tempfile.TemporaryDirectory() as directory:
 path=Path(directory)/'asset.png';path.write_bytes(base64.b64decode(request['bytes']))
 try:load_packed_image({'path':'asset.png','type':'png'},directory);result={'ok':True}
 except ActionError as e:result={'ok':False,'code':e.code,'error':str(e)}
result.update(loads=len(calls),removed=len(removed));print(json.dumps(result))
`;
  const over = python(script, { bytes: png(9000, 1).toString('base64') });
  assert.equal(over.code, 'ASSET_CONTENT_MISMATCH'); assert.equal(over.loads, 0); assert.equal(over.removed, 0);
  const mismatch = python(script, { bytes: png(4, 3).toString('base64') });
  assert.equal(mismatch.code, 'ASSET_CONTENT_MISMATCH'); assert.match(mismatch.error, /disagree/); assert.equal(mismatch.loads, 1); assert.equal(mismatch.removed, 1);
});

test('OpenEXR odd-sized mipmaps and ripmaps count each actual level with the declared rounding rule', () => {
  const tile = mode => Buffer.from([16, 0, 0, 0, 16, 0, 0, 0, mode]);
  for (const [width, height, mode, pixels] of [[9, 9, 18, 400], [9, 5, 17, 69], [9, 5, 1, 56]]) {
    const result = inspect(exr([exrPart(width, height, 3, [attribute('tiles', 'tiledesc', tile(mode))])], 0x200));
    assert.equal(result.ok, true); assert.equal(result.facts.decodedBytes, pixels * 16);
  }
  const invalid = tile(0); invalid.fill(0, 0, 4);
  assert.equal(inspect(exr([exrPart(9, 9, 3, [attribute('tiles', 'tiledesc', invalid)])], 0x200)).ok, false);
  assert.equal(inspect(exr([exrPart(9, 9, 3, [attribute('tiles', 'tiledesc', tile(0x21))])], 0x200)).ok, false);
});

test('scene budgets count separate color and data bindings of one file and include the environment', () => {
  const script = String.raw`
import sys,json,tempfile,base64,types
from pathlib import Path
sys.path.insert(0,sys.argv[1]);request=json.load(sys.stdin);sys.modules['bpy']=types.SimpleNamespace()
from deepblend_images import check_scene_image_budget
from deepblend_util import ActionError
with tempfile.TemporaryDirectory() as directory:
 (Path(directory)/'asset.png').write_bytes(base64.b64decode(request['bytes']))
 spec={'assets':[{'id':'image','path':'asset.png','type':'png'}],**request['spec']}
 try:result={'ok':True,'facts':check_scene_image_budget(spec,directory)}
 except ActionError as e:result={'ok':False,'code':e.code,'error':str(e)}
 print(json.dumps(result))
`;
  const binding = { assetId: 'image' }, bytes = png(8192, 8192).toString('base64');
  const single = python(script, { bytes, spec: { materials: [{ images: { baseColor: binding } }] } });
  assert.equal(single.ok, true); assert.equal(single.facts.bindings, 1); assert.equal(single.facts.decodedBytes, 1024 ** 3);
  for (const spec of [{ materials: [{ images: { baseColor: binding, roughness: binding } }] },
    { world: { environment: binding }, materials: [{ images: { baseColor: binding } }] }]) {
    const over = python(script, { bytes, spec }); assert.equal(over.code, 'ASSET_CONTENT_MISMATCH'); assert.match(over.error, /scene images exceed/);
  }
});
