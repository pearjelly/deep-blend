/** Real filesystem/HTTP ingestion and independent Python readback of managed glTF locks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Studio, { StudioConfig, defaultSceneSpec } from '@deepblend/dsh-blender-host';
import { encodePng } from '@deepblend/dsh-blender-contracts';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { encodeGlb } from '../lib/glb.mjs';
import { openSync, writeSync, ftruncateSync, closeSync } from 'node:fs';
import { BUNDLE_LOCK, verifyAssetBundle, verifyUnbundledGltfAsset, readGltfDocument, gltfResources, stageAssetBundle, assetPreviewVersion } from '../../../packages/deepblend/host/lib/asset-bundle.js';
const ROOT = resolve(import.meta.dirname, '../../..'), sha = b => createHash('sha256').update(b).digest('hex');
const json = p => JSON.parse(readFileSync(p));
function fixture(directory, { nested = false } = {}) {
    mkdirSync(directory, { recursive: true });
    const model = nested ? 'models/model.gltf' : 'model.gltf', parent = dirname(join(directory, model));
    mkdirSync(parent, { recursive: true });
    const image = encodePng({ width: 4, height: 4, data: Buffer.from(Array.from({ length: 16 }, () => [21, 146, 115, 255]).flat()) });
    const buffer = Buffer.alloc(12);
    buffer.writeFloatLE(.2);
    const uri = nested ? '../paint%20%C3%A9.png' : 'paint%20%C3%A9.png', bin = nested ? '../model.bin' : 'model.bin';
    writeFileSync(join(directory, 'paint é.png'), image);
    writeFileSync(join(directory, 'model.bin'), buffer);
    const doc = { asset: { version: '2.0' }, buffers: [{ uri: bin, byteLength: 12 }], images: [{ uri }], scenes: [{}], scene: 0 };
    writeFileSync(join(directory, model), JSON.stringify(doc));
    return { file: join(directory, model), doc, image, buffer, model };
}
async function setup(t, maxBytes = 64 * 1024 * 1024) {
    const out = mkdtempSync(join(tmpdir(), 'deepblend-bundle-contract-')), ctx = new Context();
    ctx.provide('blenderRuntime', {});
    mkdirSync(join(out, 'source'));
    const studio = new Studio(ctx, StudioConfig({ workspaceRoot: out, projectsRoot: join(out, 'projects'), assetMaxBytes: maxBytes }));
    const created = await studio.transactions.createProject({ title: 'bundle', sceneSpec: defaultSceneSpec({ projectId: 'bundle', title: 'bundle' }), saveCheckpoint: false }), projectId = created.projectId;
    t.after(async () => { await ctx.fiber.dispose(); rmSync(out, { recursive: true, force: true }); });
    const source = join(out, 'source'), project = studio.store.projectDirectory(projectId);
    return { out, studio, projectId, project, source, ingest: args => studio.ingestAsset({ projectId, assetId: 'model', ...args }) };
}
function python(project, asset, mode = 'bundle') {
    const script = String.raw `
import sys,json,builtins
sys.path.insert(0,sys.argv[1])
from deepblend_asset_bundle import verify_asset_bundle,verify_unbundled_gltf_asset,read_document,resources
from deepblend_util import ActionError
request=json.load(sys.stdin);read_bytes=0;original_open=builtins.open
class Spy:
 def __init__(self,file):self.file=file
 def __enter__(self):return self
 def __exit__(self,*args):self.file.close()
 def fileno(self):return self.file.fileno()
 def seek(self,*args):return self.file.seek(*args)
 def read(self,*args):
  global read_bytes
  data=self.file.read(*args);read_bytes+=len(data);return data
try:
 mode=request.get('mode','bundle')
 if mode=='document':
  builtins.open=lambda *args,**kwargs:Spy(original_open(*args,**kwargs))
  document,bin_bytes=read_document(request['asset']['path'],'glb');resources(document,'model.glb',bin_bytes)
  result={'binBytes':bin_bytes,'readBytes':read_bytes}
 elif mode=='unbundled':result=verify_unbundled_gltf_asset(request['project'],request['asset'])
 else:result=verify_asset_bundle(request['project'],request['asset'])
 print(json.dumps({'ok':True,'manifest':result}))
except ActionError as e:print(json.dumps({'ok':False,'code':e.code}))
`;
    const r = spawnSync('python3', ['-c', script, join(ROOT, 'packages/deepblend/provider-local/python')], { input: JSON.stringify({ project, asset, mode }), encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}
const declaration = r => ({ id: r.assetId, type: r.type, path: r.path, sha256: r.sha256 });
const bundleRoot = (project, result) => join(project, 'assets/bundles', result.bundle.sha256);
function forged(project, result, mutate) {
    const original = bundleRoot(project, result), manifest = json(join(original, BUNDLE_LOCK));
    mutate(manifest);
    const bytes = Buffer.from(JSON.stringify(manifest) + '\n'), hash = sha(bytes), target = join(project, 'assets/bundles', hash);
    cpSync(original, target, { recursive: true });
    writeFileSync(join(target, BUNDLE_LOCK), bytes);
    return { ...declaration(result), path: `assets/bundles/${hash}/${manifest.entrypoint}` };
}
test('glTF snapshots preserve exact model, buffer and percent-encoded image bytes', async (t) => {
    const f = await setup(t), source = fixture(f.source), result = await f.ingest({ sourcePath: source.file, license: 'MIT' }), asset = declaration(result);
    assert.equal(result.sha256, sha(readFileSync(source.file)));
    assert.equal(result.bundle.totalBytes, readFileSync(source.file).length + source.image.length + source.buffer.length);
    assert.deepEqual(result.bundle.files.map(x => x.path), ['model.bin', 'model.gltf', 'paint é.png']);
    for (const item of result.bundle.files)
        assert.deepEqual(readFileSync(join(bundleRoot(f.project, result), item.path)), readFileSync(join(f.source, item.path)));
    assert.equal(sha(readFileSync(join(bundleRoot(f.project, result), BUNDLE_LOCK))), result.bundle.sha256);
    const manifest = verifyAssetBundle(f.project, asset);
    assert.deepEqual(python(f.project, asset), { ok: true, manifest });
    assert(result.nextStep.includes(result.path));
    assert.equal(result.license, 'MIT');
    assert.equal(result.source.root, f.source);
});
test('changing only a dependency creates another immutable bundle and keeps old provenance', async (t) => {
    const f = await setup(t), source = fixture(f.source), first = await f.ingest({ sourcePath: source.file });
    writeFileSync(join(f.source, 'model.bin'), Buffer.alloc(12, 7));
    const second = await f.ingest({ sourcePath: source.file });
    assert.equal(first.sha256, second.sha256);
    assert.notEqual(first.path, second.path);
    assert.deepEqual(readFileSync(join(bundleRoot(f.project, first), 'model.bin')), source.buffer);
    rmSync(f.source, { recursive: true });
    assert(verifyAssetBundle(f.project, declaration(first)));
    assert(verifyAssetBundle(f.project, declaration(second)));
    const ledger = json(join(f.project, 'assets/manifest.json'));
    assert.equal(ledger.assets[0].path, second.path);
    assert(ledger.versions.some(v => v.path === first.path && v.bundle.sha256 === first.bundle.sha256));
});
test('concurrent aliases reuse complete bundles and leave no incoming directories', async (t) => {
    const f = await setup(t), source = fixture(f.source), results = await Promise.all(['left', 'right'].map(assetId => f.ingest({ sourcePath: source.file, assetId })));
    assert.equal(results[0].path, results[1].path);
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), [results[0].bundle.sha256]);
    assert.equal(json(join(f.project, 'assets/manifest.json')).assets.length, 2);
});
test('explicit sourceRoot preserves parent references while default roots and symlink escapes refuse', async (t) => {
    const f = await setup(t), source = fixture(f.source, { nested: true });
    await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_REQUEST_INVALID');
    const result = await f.ingest({ sourcePath: source.file, sourceRoot: f.source });
    assert(result.path.endsWith('/models/model.gltf'));
    assert(python(f.project, declaration(result)).ok);
    rmSync(join(f.source, 'model.bin'));
    writeFileSync(join(f.out, 'outside.bin'), source.buffer);
    symlinkSync(join(f.out, 'outside.bin'), join(f.source, 'model.bin'));
    await assert.rejects(f.ingest({ sourcePath: source.file, sourceRoot: f.source }), e => e.code === 'PATH_OUTSIDE_WORKSPACE');
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), [result.bundle.sha256]);
});
test('aggregate bytes, JSON size and member count limits refuse without publishing partial bundles', async (t) => {
    const f = await setup(t), source = fixture(f.source), main = readFileSync(source.file);
    f.studio.config.assetMaxBytes = main.length + source.image.length + source.buffer.length - 1;
    await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_TOO_LARGE');
    f.studio.config.assetMaxBytes = main.length + source.image.length + source.buffer.length;
    await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_TOO_LARGE');
    f.studio.config.assetMaxBytes = 64 * 1024 * 1024;
    writeFileSync(source.file, JSON.stringify({ asset: { version: '2.0' }, extras: 'x'.repeat(16 * 1024 * 1024) }));
    await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_TOO_LARGE');
    writeFileSync(source.file, JSON.stringify({ asset: { version: '2.0' }, images: Array.from({ length: 256 }, (_, i) => ({ uri: `image-${i}.png` })) }));
    await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_TOO_LARGE');
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), []);
});
test('changed main, buffer, image, lock and missing members refuse in both independent validators', async (t) => {
    const f = await setup(t), source = fixture(f.source), result = await f.ingest({ sourcePath: source.file }), asset = declaration(result), root = bundleRoot(f.project, result);
    for (const file of ['model.gltf', 'model.bin', 'paint é.png', BUNDLE_LOCK]) {
        const path = join(root, file), bytes = readFileSync(path);
        const changed = Buffer.from(bytes);
        if (file === BUNDLE_LOCK)
            changed[changed.length - 1] = 32;
        else if (file === 'model.gltf')
            changed[bytes.indexOf(Buffer.from('\"scene\":0')) + 8] = 49;
        else
            changed[0] ^= 1;
        writeFileSync(path, changed);
        assert.throws(() => verifyAssetBundle(f.project, asset), e => e.code === 'ASSET_HASH_MISMATCH');
        assert.equal(python(f.project, asset).code, 'ASSET_HASH_MISMATCH');
        writeFileSync(path, bytes);
    }
    rmSync(join(root, 'paint é.png'));
    assert.throws(() => verifyAssetBundle(f.project, asset), e => e.code === 'ASSET_MISSING');
    assert.equal(python(f.project, asset).code, 'ASSET_MISSING');
});
test('forged locks cannot omit a referenced image, duplicate members or falsify total size', async (t) => {
    const f = await setup(t), source = fixture(f.source), result = await f.ingest({ sourcePath: source.file });
    for (const [change, code] of [[m => m.files.push(m.files[0]), 'ASSET_REQUEST_INVALID'], [m => { m.files = m.files.filter(x => x.path !== 'paint é.png'); m.totalBytes = m.files.reduce((n, x) => n + x.bytes, 0); }, 'ASSET_REQUEST_INVALID'], [m => m.totalBytes++, 'ASSET_HASH_MISMATCH'], [m => { m.files[0].bytes++; m.totalBytes++; }, 'ASSET_HASH_MISMATCH'], [m => { m.extras = 'x'.repeat(1024 * 1024); }, 'ASSET_TOO_LARGE']]) {
        const asset = forged(f.project, result, change);
        assert.throws(() => verifyAssetBundle(f.project, asset), e => e.code === code);
        assert.equal(python(f.project, asset).code, code);
    }
});
test('unrelated scene patches refuse changed bundle dependencies without moving the current revision', async (t) => {
    const f = await setup(t), source = fixture(f.source), result = await f.ingest({ sourcePath: source.file });
    await f.studio.transactions.applyScenePatch({ projectId: f.projectId, baseRevision: 'r0001', operations: [{ op: 'asset.add', asset: declaration(result) }], saveCheckpoint: false });
    const before = f.studio.store.readRecord(f.projectId).currentRevision;
    writeFileSync(join(bundleRoot(f.project, result), 'model.bin'), Buffer.alloc(12, 9));
    await assert.rejects(f.studio.transactions.applyScenePatch({ projectId: f.projectId, baseRevision: before, operations: [{ op: 'entity.visibility.set', entityId: 'subject', visible: false }], saveCheckpoint: false }), e => e.code === 'ASSET_HASH_MISMATCH');
    assert.equal(f.studio.store.readRecord(f.projectId).currentRevision, before);
});
test('remote self-contained glTF keeps its original entry name and never fetches external dependency URLs', async (t) => {
    const f = await setup(t);
    let hits = 0, external = false;
    const server = createServer((request, response) => { hits++; response.end(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: external ? 'resource.bin' : 'data:application/octet-stream;base64,AAAA', byteLength: 3 }] })); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise(done => server.close(done)));
    const sourceUrl = `http://127.0.0.1:${server.address().port}/original.gltf`, first = await f.ingest({ sourceUrl, approved: true });
    assert(first.path.endsWith('/original.gltf'));
    assert(verifyAssetBundle(f.project, declaration(first)));
    external = true;
    await assert.rejects(f.ingest({ sourceUrl, approved: true }), e => e.code === 'ASSET_REQUEST_INVALID');
    assert.equal(hits, 2);
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), [first.bundle.sha256]);
});
test('missing resources, unsafe URIs, invalid JSON and pre-aborted ingestion keep original files and no published bundle', async (t) => {
    const f = await setup(t), source = fixture(f.source);
    for (const uri of ['missing.bin', 'https://example.invalid/buffer.bin', '%ZZ', '../outside.bin', 'model.bin?x=1', 'data:application/octet-stream,not-base64', 'data:application/octet-stream;base64,AAA']) {
        writeFileSync(source.file, JSON.stringify({ ...source.doc, buffers: [{ uri, byteLength: 12 }] }));
        await assert.rejects(f.ingest({ sourcePath: source.file }), e => ['ASSET_SOURCE_NOT_FOUND', 'ASSET_REQUEST_INVALID'].includes(e.code));
    }
    writeFileSync(source.file, '{"asset":');
    await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_CONTENT_MISMATCH');
    writeFileSync(source.file, JSON.stringify(source.doc));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.ingest({ sourcePath: source.file, signal: controller.signal }), e => e.name === 'AbortError');
    assert.deepEqual(readFileSync(join(f.source, 'model.bin')), source.buffer);
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), []);
});
function glbFixture(directory, { nested = false, embeddedBuffer = false } = {}) {
    const source = fixture(directory, { nested }), document = structuredClone(source.doc);
    if (embeddedBuffer)
        delete document.buffers[0].uri;
    const model = source.model.replace(/\.gltf$/, '.glb'), file = join(directory, model);
    writeFileSync(file, encodeGlb(document, embeddedBuffer ? source.buffer : null));
    return { ...source, file, model, doc: document };
}
const inspectGlb = file => { const data = readGltfDocument(file, { format: 'glb' }); gltfResources(data.document, 'model.glb', data.binBytes); return data; };
test('GLB snapshots preserve external buffers/images and embedded BIN plus external images', async (t) => {
    const f = await setup(t);
    for (const embeddedBuffer of [false, true]) {
        const dir = join(f.source, String(embeddedBuffer)), source = glbFixture(dir, { nested: true, embeddedBuffer });
        await assert.rejects(f.ingest({ sourcePath: source.file }), e => e.code === 'ASSET_REQUEST_INVALID');
        const result = await f.ingest({ sourcePath: source.file, sourceRoot: dir, assetId: `glb-${embeddedBuffer}`, license: 'MIT' });
        assert.equal(result.type, 'glb');
        assert.equal(result.bundle.format, 'glb');
        assert.equal(result.source.root, dir);
        assert.equal(result.sha256, sha(readFileSync(source.file)));
        const expected = embeddedBuffer ? ['models/model.glb', 'paint é.png'] : ['model.bin', 'models/model.glb', 'paint é.png'];
        assert.deepEqual(result.bundle.files.map(m => m.path), expected);
        for (const member of result.bundle.files)
            assert.deepEqual(readFileSync(join(bundleRoot(f.project, result), member.path)), readFileSync(join(dir, member.path)));
        assert.deepEqual(python(f.project, declaration(result)), { ok: true, manifest: verifyAssetBundle(f.project, declaration(result)) });
    }
});
test('GLB dependency-only updates and concurrent aliases preserve prior bundle bytes', async (t) => {
    const f = await setup(t), source = glbFixture(f.source), first = await f.ingest({ sourcePath: source.file });
    writeFileSync(join(f.source, 'model.bin'), Buffer.alloc(12, 42));
    const next = await Promise.all(['left', 'right'].map(assetId => f.ingest({ sourcePath: source.file, assetId })));
    assert.equal(first.sha256, next[0].sha256);
    assert.notEqual(first.path, next[0].path);
    assert.equal(next[0].path, next[1].path);
    assert.deepEqual(readFileSync(join(bundleRoot(f.project, first), 'model.bin')), source.buffer);
    rmSync(f.source, { recursive: true });
    assert(verifyAssetBundle(f.project, declaration(first)));
    assert(python(f.project, declaration(next[0])).ok);
    assert.equal(readdirSync(join(f.project, 'assets/bundles')).length, 2);
});
test('self-contained GLB stays byte-exact in raw storage including explicit type, BIN padding and unknown chunks', async (t) => {
    const f = await setup(t);
    const cases = [encodeGlb({ asset: { version: '2.0' } }), encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 5 }] }, Buffer.alloc(5)), encodeGlb({ asset: { version: '2.0' } }, null, [{ data: Buffer.from('future') }])];
    for (const [i, bytes] of cases.entries()) {
        const file = join(f.source, `source-${i}.data`);
        writeFileSync(file, bytes);
        const result = await f.ingest({ sourcePath: file, type: 'glb', sourceRoot: f.source, assetId: `raw-${i}` });
        assert.equal(result.path, `assets/raw/${sha(bytes)}.glb`);
        assert.equal(result.bundle, undefined);
        assert.deepEqual(readFileSync(join(f.project, result.path)), bytes);
        verifyUnbundledGltfAsset(f.project, declaration(result));
        assert(python(f.project, declaration(result), 'unbundled').ok);
        await f.studio.applyScenePatch({ projectId: f.projectId, baseRevision: f.studio.store.currentRevision(f.projectId), saveCheckpoint: false, operations: [{ op: 'asset.add', asset: declaration(result) }] });
    }
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), []);
});
test('malformed GLB headers, chunk order and embedded buffer declarations refuse in both readers', async (t) => {
    const f = await setup(t), good = encodeGlb({ asset: { version: '2.0' } }), edit = fn => { const b = Buffer.from(good); fn(b); return b; };
    const unalignedJson = Buffer.from(JSON.stringify({ asset: { version: '2.0' } })), unaligned = Buffer.concat([good.subarray(0, 20), unalignedJson]);
    unaligned.writeUInt32LE(unaligned.length, 8);
    unaligned.writeUInt32LE(unalignedJson.length, 12);
    const duplicateJson = encodeGlb({ asset: { version: '2.0' } }, null, [{ kind: 0x4e4f534a, data: Buffer.from(JSON.stringify({ asset: { version: '2.0' } })) }]);
    const nullDuplicateJson = encodeGlb(null, null, [{ kind: 0x4e4f534a, data: Buffer.from(JSON.stringify({ asset: { version: '2.0' } })) }]);
    const misplacedJson = encodeGlb('ignored', null, [{ kind: 0x4e4f534a, data: Buffer.from(JSON.stringify({ asset: { version: '2.0' } })) }]);
    misplacedJson.writeUInt32LE(0x12345678, 16);
    const cases = [misplacedJson, edit(b => b.write('fake')), nullDuplicateJson, unaligned, good.subarray(0, 12), edit(b => b.writeUInt32LE(1, 4)), edit(b => b.writeUInt32LE(b.length + 4, 8)), edit(b => b.writeUInt32LE(0x004e4942, 16)), edit(b => b.writeUInt32LE(1, 12)), duplicateJson,
        encodeGlb({ asset: { version: '1.0' } }), encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }),
        encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 9 }] }, Buffer.alloc(4)),
        encodeGlb({ asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }, { byteLength: 4 }] }, Buffer.alloc(4)),
        encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] }, null, [{}, { kind: 0x004e4942 }]),
        encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }] }, Buffer.alloc(0), [{ kind: 0x004e4942 }]),
        edit(b => { b[20] = 0xff; }), encodeGlb({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,AAA' }] })];
    for (const [i, bytes] of cases.entries()) {
        const file = join(f.source, `invalid-${i}.glb`);
        writeFileSync(file, bytes);
        assert.throws(() => inspectGlb(file), e => ['ASSET_CONTENT_MISMATCH', 'ASSET_REQUEST_INVALID'].includes(e.code), `Node case ${i}`);
        assert.equal(python('', { path: file }, 'document').ok, false, `Python case ${i}`);
        await assert.rejects(f.ingest({ sourcePath: file, assetId: `invalid-${i}` }));
        assert.deepEqual(readFileSync(file), bytes);
    }
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), []);
    assert.deepEqual(readdirSync(join(f.project, 'assets/raw')), []);
});
test('GLB JSON and chunk budgets use fixed independent limits in both readers', async (t) => {
    const f = await setup(t);
    for (const bytes of [encodeGlb({ asset: { version: '2.0' }, extras: 'x'.repeat(16 * 1024 * 1024) }), encodeGlb({ asset: { version: '2.0' } }, null, Array.from({ length: 1024 }, () => ({})))]) {
        const file = join(f.source, 'large.glb');
        writeFileSync(file, bytes);
        assert.throws(() => inspectGlb(file), e => e.code === 'ASSET_TOO_LARGE');
        assert.deepEqual(python('', { path: file }, 'document'), { ok: false, code: 'ASSET_TOO_LARGE' });
        await assert.rejects(f.ingest({ sourcePath: file }), e => e.code === 'ASSET_TOO_LARGE');
    }
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), []);
});
test('GLB metadata readers skip a 32 MiB BIN payload rather than collecting it in memory', async (t) => {
    const f = await setup(t), size = 32 * 1024 * 1024, file = join(f.source, 'sparse.glb');
    const initial = encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: size }] }, Buffer.alloc(0));
    initial.writeUInt32LE(initial.length + size, 8);
    initial.writeUInt32LE(size, initial.length - 8);
    const fd = openSync(file, 'wx');
    try {
        writeSync(fd, initial);
        ftruncateSync(fd, initial.length + size);
    }
    finally {
        closeSync(fd);
    }
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const {readGltfDocument}=await import(${JSON.stringify(join(ROOT, 'packages/deepblend/host/lib/asset-bundle.js'))});const original=fs.readSync;let bytes=0;fs.readSync=(...args)=>{const n=original(...args);bytes+=n;return n};syncBuiltinESMExports();const result=readGltfDocument(process.argv[1],{format:'glb'});console.log(JSON.stringify({bytes,binBytes:result.binBytes}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const measured = JSON.parse(result.stdout);
    assert.equal(measured.binBytes, size);
    assert(measured.bytes < 1024);
    const independent = python('', { path: file }, 'document');
    assert(independent.ok);
    assert.equal(independent.manifest.binBytes, size);
    assert(independent.manifest.readBytes < 1024);
});
test('GLB locked format and core resource closure cannot be forged into another profile', async (t) => {
    const f = await setup(t), source = glbFixture(f.source), result = await f.ingest({ sourcePath: source.file });
    for (const mutate of [m => { m.format = 'usd'; }, m => { delete m.format; }, m => { m.files = m.files.filter(x => x.path !== 'paint é.png'); m.totalBytes = m.files.reduce((n, x) => n + x.bytes, 0); }]) {
        const asset = forged(f.project, result, mutate);
        assert.throws(() => verifyAssetBundle(f.project, asset), e => e.code === 'ASSET_REQUEST_INVALID');
        assert.deepEqual(python(f.project, asset), { ok: false, code: 'ASSET_REQUEST_INVALID' });
    }
    const wrongType = { ...declaration(result), type: 'gltf' };
    assert.throws(() => verifyAssetBundle(f.project, wrongType));
    assert.equal(python(f.project, wrongType).ok, false);
});
test('legacy unlocked glTF/GLB resources refuse existing files before committing a revision', async (t) => {
    const f = await setup(t), legacy = join(f.project, 'legacy');
    mkdirSync(legacy);
    for (const type of ['gltf', 'glb']) {
        const doc = { asset: { version: '2.0' }, buffers: [{ uri: 'resource.bin', byteLength: 12 }] }, path = `legacy/model.${type}`;
        const bytes = type === 'glb' ? encodeGlb(doc) : Buffer.from(JSON.stringify(doc));
        writeFileSync(join(f.project, path), bytes);
        writeFileSync(join(legacy, 'resource.bin'), Buffer.alloc(12));
        const asset = { id: `legacy-${type}`, type, path, sha256: sha(bytes) };
        assert.throws(() => verifyUnbundledGltfAsset(f.project, asset), e => e.code === 'ASSET_REQUEST_INVALID');
        assert.deepEqual(python(f.project, asset, 'unbundled'), { ok: false, code: 'ASSET_REQUEST_INVALID' });
        const { sha256, ...unhashed } = asset;
        for (const declaration of [asset, unhashed]) {
            await assert.rejects(f.studio.applyScenePatch({ projectId: f.projectId, baseRevision: 'r0001', saveCheckpoint: false, operations: [{ op: 'asset.add', asset: declaration }] }), e => e.code === 'ASSET_REQUEST_INVALID');
            assert.equal(f.studio.store.currentRevision(f.projectId), 'r0001');
        }
        assert.deepEqual(readFileSync(join(f.project, path)), bytes);
    }
});
test('remote embedded GLB remains raw and remote external dependencies are never fetched', async (t) => {
    const f = await setup(t);
    let hits = 0, external = false;
    const server = createServer((request, response) => { hits++; response.end(encodeGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, ...(external ? { uri: 'resource.bin' } : {}) }] }, external ? null : Buffer.alloc(4))); });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    t.after(() => new Promise(done => server.close(done)));
    const sourceUrl = `http://127.0.0.1:${server.address().port}/original.glb`, first = await f.ingest({ sourceUrl, approved: true });
    assert.equal(first.path, `assets/raw/${first.sha256}.glb`);
    assert(first.bytes > 20);
    assert.equal(first.bundle, undefined);
    external = true;
    await assert.rejects(f.ingest({ sourceUrl, approved: true }), e => e.code === 'ASSET_REQUEST_INVALID');
    assert.equal(hits, 2);
    assert.deepEqual(readdirSync(join(f.project, 'assets/bundles')), []);
    assert.equal(readdirSync(join(f.project, 'assets/raw')).length, 1);
});

test('preview staging preserves complete glTF and both GLB resource layouts', async t => {
    const f = await setup(t);
    for (const kind of ['gltf', 'glb-external', 'glb-internal']) {
        const dir = join(f.source, kind), source = kind === 'gltf' ? fixture(dir, {nested:true}) : glbFixture(dir, {nested:true, embeddedBuffer:kind==='glb-internal'});
        const result = await f.ingest({sourcePath:source.file, sourceRoot:dir, assetId:kind}), asset = declaration(result), staging = join(f.out, 'preview-'+kind);
        assert.equal(await stageAssetBundle(f.project, staging, asset, {maxBytes:f.studio.config.assetMaxBytes}), true);
        assert.equal(assetPreviewVersion(asset), result.bundle.sha256);
        for (const member of [...result.bundle.files, {path:BUNDLE_LOCK}]) assert.deepEqual(readFileSync(join(staging,'assets/bundles',result.bundle.sha256,member.path)),readFileSync(join(bundleRoot(f.project,result),member.path)));
        assert.deepEqual(verifyAssetBundle(staging,asset), verifyAssetBundle(f.project,asset));
    }
});
test('preview staging rejects changed dependencies, aggregate overflow and pre-abort', async t => {
    const f = await setup(t), source = glbFixture(f.source), result = await f.ingest({sourcePath:source.file}), asset=declaration(result);
    await assert.rejects(stageAssetBundle(f.project, join(f.out,'overflow'), asset, {maxBytes:result.bundle.totalBytes}), {code:'ASSET_TOO_LARGE'});
    const controller=new AbortController();controller.abort();
    await assert.rejects(stageAssetBundle(f.project, join(f.out,'abort'), asset, {maxBytes:1e6,signal:controller.signal}), {name:'AbortError'});
    assert(!existsSync(join(f.out,'abort')));
    writeFileSync(join(bundleRoot(f.project,result),'model.bin'), Buffer.alloc(12,17));
    await assert.rejects(stageAssetBundle(f.project,join(f.out,'changed'),asset,{maxBytes:1e6}), {code:'ASSET_HASH_MISMATCH'});
    assert(!existsSync(join(f.out,'changed')));
});
test('Host preview refuses ambiguous dependency versions and separates cache identities', async t => {
    const f = await setup(t),source=glbFixture(f.source),first=await f.ingest({sourcePath:source.file});
    writeFileSync(join(f.source,'model.bin'),Buffer.alloc(12,27));
    const second=await f.ingest({sourcePath:source.file});
    await assert.rejects(f.studio.previewAsset({projectId:f.projectId,assetId:first.assetId,sha256:first.sha256}),{code:'ASSET_REQUEST_INVALID'});
    await assert.rejects(f.studio.previewAsset({projectId:f.projectId,assetId:first.assetId,sha256:first.sha256,assetPath:'unknown.glb'}),{code:'ASSET_SOURCE_NOT_FOUND'});
    for (const r of [first,second]) {
        const cache=join(f.project,'assets/previews',r.bundle.sha256,r.assetId);mkdirSync(cache,{recursive:true});
        writeFileSync(join(cache,'inspection.json'),JSON.stringify({assetId:r.assetId,sha256:r.sha256,assetPath:r.path,inspection:{kind:'model'},preview:{path:r.bundle.sha256}}));
    }
    let inventory=await f.studio.listAssets({projectId:f.projectId});
    assert.equal(inventory.assets.find(x=>x.asset.path===first.path).preview.path,first.bundle.sha256);
    assert.equal(inventory.assets.find(x=>x.asset.path===second.path).preview.path,second.bundle.sha256);
    writeFileSync(join(f.project,'assets/previews',first.bundle.sha256,first.assetId,'inspection.json'),JSON.stringify({assetId:first.assetId,sha256:first.sha256,assetPath:second.path,inspection:{kind:'model'},preview:{path:'wrong'}}));
    inventory=await f.studio.listAssets({projectId:f.projectId});
    assert.equal(inventory.assets.find(x=>x.asset.path===first.path).preview,null);
    assert.equal(f.studio.store.currentRevision(f.projectId),'r0001');
    assert(!readdirSync(join(f.project,'assets')).some(name=>name.startsWith('.preview-')));
});
