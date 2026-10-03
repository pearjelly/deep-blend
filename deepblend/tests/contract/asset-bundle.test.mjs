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
import { BUNDLE_LOCK, verifyAssetBundle } from '../../../packages/deepblend/host/lib/asset-bundle.js';
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
    const studio = new Studio(ctx, StudioConfig({ workspaceRoot: out, projectsRoot: join(out, 'projects'), assetMaxBytes: maxBytes }));
    const created = await studio.transactions.createProject({ title: 'bundle', sceneSpec: defaultSceneSpec({ projectId: 'bundle', title: 'bundle' }), saveCheckpoint: false }), projectId = created.projectId;
    t.after(async () => { await ctx.fiber.dispose(); rmSync(out, { recursive: true, force: true }); });
    const source = join(out, 'source'), project = studio.store.projectDirectory(projectId);
    return { out, studio, projectId, project, source, ingest: args => studio.ingestAsset({ projectId, assetId: 'model', ...args }) };
}
function python(project, asset) {
    const script = "import sys,json;sys.path.insert(0,sys.argv[1]);from deepblend_asset_bundle import verify_asset_bundle;from deepblend_util import ActionError\nrequest=json.load(sys.stdin)\ntry: print(json.dumps({'ok':True,'manifest':verify_asset_bundle(request['project'],request['asset'])}))\nexcept ActionError as e: print(json.dumps({'ok':False,'code':e.code}))";
    const r = spawnSync('python3', ['-c', script, join(ROOT, 'packages/deepblend/provider-local/python')], { input: JSON.stringify({ project, asset }), encoding: 'utf8', timeout: 30000 });
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
        if (file === BUNDLE_LOCK) changed[changed.length - 1] = 32;
        else if (file === 'model.gltf') changed[bytes.indexOf(Buffer.from('\"scene\":0')) + 8] = 49;
        else changed[0] ^= 1;
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
