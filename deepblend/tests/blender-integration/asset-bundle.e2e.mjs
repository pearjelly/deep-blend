/** Actual textured glTF → immutable resource bundle → Host compile/render → old revision rebuild. */
import { Context } from '@deepseek-ai/cordis';
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local';
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local';
import Studio, { defaultSceneSpec } from '@deepblend/dsh-blender-host';
import { decodePng, encodePng } from '@deepblend/dsh-blender-contracts';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const ROOT = resolve(import.meta.dirname, '../../..'), out = resolve(process.env.DEEPBLEND_ASSET_BUNDLE_OUTPUT ?? join(ROOT, '.deepblend/quality', `asset-bundle-${Date.now()}`)), blender = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender');
assert(!existsSync(out));
mkdirSync(out, { recursive: true });
const source = join(out, 'source'), workspace = join(out, 'workspace');
mkdirSync(source);
mkdirSync(workspace);
const checks = [], artifacts = [], calls = [], sha = b => createHash('sha256').update(b).digest('hex'), json = p => JSON.parse(readFileSync(p)), save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
let failure = null, project, projectId, ctx;
const check = (name, condition, detail) => { checks.push({ name, ok: !!condition, ...(detail === undefined ? {} : { detail }) }); assert(condition, name); };
function python(name, body, args) { const script = join(out, name + '.py'); writeFileSync(script, body); const r = spawnSync(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', script, '--', ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); writeFileSync(join(out, name + '.log'), (r.stdout ?? '') + '\n' + (r.stderr ?? '')); assert.equal(r.status, 0, `${name}: ${r.error?.message ?? ''}\n${r.stderr}`); }
const GENERATE = String.raw `
import bpy,sys,json
from pathlib import Path
root=Path(sys.argv[sys.argv.index('--')+1]);(root/'models').mkdir();(root/'textures').mkdir()
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
image=bpy.data.images.new('paint é',width=8,height=8,alpha=True)
colors=[]
for y in range(8):
 for x in range(8):colors.extend([.08,.58,.45,1] if (x//2+y//2)%2 else [.35,.1,.04,1])
image.pixels=colors;image.filepath_raw=str(root/'textures/paint é.png');image.file_format='PNG';image.save()
material=bpy.data.materials.new('authored ceramic');material.use_nodes=True
shader=material.node_tree.nodes.get('Principled BSDF');shader.inputs['Roughness'].default_value=.24;shader.inputs['Metallic'].default_value=.15
texture=material.node_tree.nodes.new('ShaderNodeTexImage');texture.image=image;material.node_tree.links.new(texture.outputs['Color'],shader.inputs['Base Color'])
parent=bpy.data.objects.new('authored parent',None);bpy.context.scene.collection.objects.link(parent);parent.location=(.02,.01,.03);parent.rotation_euler[2]=.15
bpy.ops.mesh.primitive_cube_add(size=.1,location=(0,0,.05));cube=bpy.context.object;cube.name='authored body';cube.parent=parent;cube.data.materials.append(material)
bpy.ops.export_scene.gltf(filepath=str(root/'models/product.gltf'),export_format='GLTF_SEPARATE',export_texture_dir='../textures')
(root/'build.json').write_text(json.dumps({'version':bpy.app.version_string,'buildHash':bpy.app.build_hash.decode()}))
`;
const INSPECT = String.raw `
import bpy,sys,json,hashlib
from pathlib import Path
kind,path,out=sys.argv[sys.argv.index('--')+1:]
if kind=='asset':
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=path)
else:bpy.ops.wm.open_mainfile(filepath=path)
bpy.context.view_layer.update();meshes=[];images=[]
for obj in bpy.context.scene.objects:
 if obj.type!='MESH':continue
 slots=[]
 for slot in obj.material_slots:
  material=slot.material;shader=material.node_tree.nodes.get('Principled BSDF');slots.append({'roughness':round(shader.inputs['Roughness'].default_value,6),'metallic':round(shader.inputs['Metallic'].default_value,6)})
  for node in material.node_tree.nodes:
   if node.type=='TEX_IMAGE' and node.image:
    image=node.image;pixels=[round(x,6) for x in image.pixels[:]]
    images.append({'size':list(image.size),'pixelsSha256':hashlib.sha256(json.dumps(pixels,separators=(',',':')).encode()).hexdigest(),'packed':bool(image.packed_file)})
 meshes.append({'vertices':sorted([[round(x,6) for x in obj.matrix_world@v.co] for v in obj.data.vertices]),'polygons':len(obj.data.polygons),'uv':[[[round(x,6) for x in loop.uv] for loop in layer.data] for layer in obj.data.uv_layers],'slots':slots})
Path(out).write_text(json.dumps({'meshes':meshes,'images':images,'buildHash':bpy.app.build_hash.decode()},indent=2))
`;
function image(file) { const bytes = readFileSync(file), png = decodePng(bytes); check('render has requested dimensions and nonconstant pixels', png.width === 256 && png.height === 192 && new Set(Array.from({ length: png.width * png.height }, (_, i) => png.data.subarray(i * 4, i * 4 + 3).toString('hex'))).size > 32); artifacts.push({ path: file, bytes: bytes.length, sha256: sha(bytes), width: png.width, height: png.height }); return png; }
const materialFacts = f => ({ ...f, images: f.images.map(({ packed, ...value }) => value), buildHash: undefined });
try {
    python('generate', GENERATE, [source]);
    const main = join(source, 'models/product.gltf'), document = json(main), uris = [...(document.buffers ?? []), ...(document.images ?? [])].map(x => x.uri).filter(Boolean);
    check('native authored glTF uses external binary and image resources', uris.some(u => u.endsWith('.bin')) && uris.some(u => u.includes('../textures/')), { uris });
    cpSync(source, join(out, 'authored-source'), { recursive: true });
    python('original', INSPECT, ['asset', main, join(out, 'original.json')]);
    const original = json(join(out, 'original.json'));
    check('independent original has real mesh UV, PBR values and texture pixels', original.meshes.length === 1 && original.meshes[0].polygons > 0 && original.meshes[0].uv.length > 0 && original.images.length > 0 && original.images[0].size[0] === 8);
    ctx = new Context();
    ctx.plugin(LocalSubprocess);
    ctx.plugin(Provider, ProviderConfig({ workspaceRoot: workspace, blenderPath: blender, timeoutMs: 120000 }));
    ctx.plugin(Studio, { workspaceRoot: workspace, projectsRoot: join(workspace, 'projects'), maxPreviewSamples: 16 });
    let studio, runtime;
    for (let i = 0; i < 100; i++) {
        studio = ctx.get('blenderStudio');
        runtime = ctx.get('blenderRuntime');
        if (studio && runtime)
            break;
        await new Promise(done => setTimeout(done, 20));
    }
    assert(studio && runtime);
    const spec = defaultSceneSpec({ projectId: 'bundle-proof', title: 'glTF bundle proof' });
    spec.cameras[0].transform.location = [.3, -.4, .24];
    delete spec.cameras[0].targetEntityId;
    spec.cameras[0].targetPoint = [.02, .01, .08];
    spec.renderProfiles.preview = { engine: 'cycles', resolution: [256, 192], samples: 8, maxSamplesBudget: 16, colorManagement: { viewTransform: 'AgX', exposure: 0 } };
    const created = await studio.createProject({ title: 'Bundle proof', sceneSpec: spec, saveCheckpoint: false });
    projectId = created.projectId;
    project = studio.store.projectDirectory(projectId);
    const first = await studio.ingestAsset({ projectId, sourcePath: main, sourceRoot: source, assetId: 'authored-model', license: 'MIT' });
    save(join(out, 'first-ingest.json'), first);
    check('resource snapshot contains every external member and preserves original main hash', first.bundle.files.length === 1 + new Set(uris).size && first.sha256 === sha(readFileSync(main)));
    const firstRoot = join(project, 'assets/bundles', first.bundle.sha256);
    check('all stored resource bytes match independently authored source', first.bundle.files.every(m => sha(readFileSync(join(firstRoot, m.path))) === sha(readFileSync(join(source, m.path)))));
    const declaration = r => ({ id: r.assetId, type: r.type, path: r.path, sha256: r.sha256 }), entity = { id: 'subject', type: 'asset-instance', assetId: first.assetId, transform: { location: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] }, tags: ['hero-product'] };
    const apply = async (operations) => { calls.push('applyScenePatch'); return studio.applyScenePatch({ projectId, baseRevision: studio.store.currentRevision(projectId), operations }); };
    await apply([{ op: 'entity.remove', entityId: 'subject' }, { op: 'asset.add', asset: declaration(first) }, { op: 'entity.add', entity }]);
    const old = studio.store.currentRevision(projectId), checkpoint = join(project, 'revisions', old, 'scene.blend'), checkpointHash = sha(readFileSync(checkpoint));
    copyFileSync(checkpoint, join(out, 'original-checkpoint.blend'));
    python('first-checkpoint', INSPECT, ['checkpoint', checkpoint, join(out, 'first-checkpoint.json')]);
    const firstFacts = json(join(out, 'first-checkpoint.json'));
    check('saved checkpoint embeds every used texture image', firstFacts.images.every(image => image.packed));
    check('saved checkpoint preserves original world mesh, UVs, PBR and texture pixels', JSON.stringify(materialFacts(firstFacts)) === JSON.stringify(materialFacts(original)));
    const before = await studio.renderPreview({ projectId, revision: old, cameraId: 'camera-main', frame: 1 });
    const beforePath = join(project, before.artifacts[0].path), beforeImage = image(beforePath);
    copyFileSync(beforePath, join(out, 'old-preview.png'));
    const texture = first.bundle.files.find(m => /\.png$/i.test(m.path));
    assert(texture);
    writeFileSync(join(source, texture.path), encodePng({ width: 8, height: 8, data: Buffer.from(Array.from({ length: 64 }, () => [220, 35, 20, 255]).flat()) }));
    const second = await studio.ingestAsset({ projectId, sourcePath: main, sourceRoot: source, assetId: first.assetId, license: 'MIT' });
    save(join(out, 'second-ingest.json'), second);
    check('texture-only update changes bundle identity while keeping main model bytes', second.sha256 === first.sha256 && second.path !== first.path);
    await apply([{ op: 'entity.remove', entityId: 'subject' }, { op: 'asset.remove', assetId: first.assetId }, { op: 'asset.add', asset: declaration(second) }, { op: 'entity.add', entity }]);
    const current = studio.store.currentRevision(projectId), newCheckpoint = join(project, 'revisions', current, 'scene.blend');
    python('second-checkpoint', INSPECT, ['checkpoint', newCheckpoint, join(out, 'second-checkpoint.json')]);
    const secondFacts = json(join(out, 'second-checkpoint.json'));
    check('new revision retains geometry and PBR while actual texture pixels change', JSON.stringify(firstFacts.meshes) === JSON.stringify(secondFacts.meshes) && firstFacts.images[0].pixelsSha256 !== secondFacts.images[0].pixelsSha256);
    const after = await studio.renderPreview({ projectId, revision: current, cameraId: 'camera-main', frame: 1 });
    const afterPath = join(project, after.artifacts[0].path), afterImage = image(afterPath);
    copyFileSync(afterPath, join(out, 'new-preview.png'));
    check('texture-only update changes actual rendered pixels', !beforeImage.data.every((v, i) => v === afterImage.data[i]));
    check('new revision leaves earlier saved checkpoint bytes unchanged', sha(readFileSync(checkpoint)) === checkpointHash);
    rmSync(source, { recursive: true });
    const parked = firstRoot + '.held';
    renameSync(firstRoot, parked);
    try {
        python('standalone-copy', INSPECT, ['checkpoint', join(out, 'original-checkpoint.blend'), join(out, 'standalone-copy.json')]);
        check('standalone checkpoint copy opens with exact embedded pixels while source and bundle are unavailable', JSON.stringify(json(join(out, 'standalone-copy.json'))) === JSON.stringify(firstFacts));
    }
    finally {
        renameSync(parked, firstRoot);
    }
    rmSync(checkpoint);
    const rebuilt = await studio.renderPreview({ projectId, revision: old, cameraId: 'camera-main', frame: 1 });
    const rebuiltPath = join(project, rebuilt.artifacts[0].path), rebuiltImage = image(rebuiltPath);
    copyFileSync(rebuiltPath, join(out, 'rebuilt-preview.png'));
    let error = 0;
    for (let i = 0; i < beforeImage.data.length; i++)
        error += Math.abs(beforeImage.data[i] - rebuiltImage.data[i]) / 255;
    error /= beforeImage.data.length;
    check('old revision rebuild uses locked original resources after source deletion and alias update', error <= .001, { meanPixelError: error, oldRevision: old, currentRevision: current });
    check('historical preview does not move the current revision', studio.store.currentRevision(projectId) === current);
    const changedBuffer = second.bundle.files.find(m => m.path.endsWith('.bin')), secondRoot = join(project, 'assets/bundles', second.bundle.sha256), bufferPath = join(secondRoot, changedBuffer.path), buffer = readFileSync(bufferPath), bad = Buffer.from(buffer);
    bad[0] ^= 1;
    writeFileSync(bufferPath, bad);
    let refused;
    try {
        await apply([{ op: 'entity.visibility.set', entityId: 'subject', visible: false }]);
    }
    catch (e) {
        refused = e;
    }
    check('unrelated public patch refuses changed buffer and preserves current revision', refused?.code === 'ASSET_HASH_MISMATCH' && studio.store.currentRevision(projectId) === current);
    const pythonRefusal = String.raw `
import bpy,sys,json
from pathlib import Path
root,project,specfile,out=sys.argv[sys.argv.index('--')+1:];sys.path.insert(0,str(Path(root)/'packages/deepblend/provider-local/python'))
from deepblend_scene import build_scene
from deepblend_util import ActionError,Guard
bpy.ops.mesh.primitive_cube_add();bpy.context.object.name='bundle-refusal-sentinel';before=sorted(o.name for o in bpy.data.objects)
try:build_scene(json.loads(Path(specfile).read_text()),{'project_root':project,'profile':'preview'},Guard())
except ActionError as e:assert e.code=='ASSET_HASH_MISMATCH'
else:raise AssertionError('changed buffer accepted')
assert sorted(o.name for o in bpy.data.objects)==before
Path(out).write_text(json.dumps({'code':'ASSET_HASH_MISMATCH','sceneInventoryPreserved':True,'buildHash':bpy.app.build_hash.decode()}))
`;
    python('compile-refusal', pythonRefusal, [ROOT, project, join(project, 'revisions', current, 'scene-spec.json'), join(out, 'compile-refusal.json')]);
    check('native compile refuses before clearing the live scene', json(join(out, 'compile-refusal.json')).sceneInventoryPreserved);
    writeFileSync(bufferPath, buffer);
    check('all snapshot files are restored to their locked bytes', second.bundle.files.every(m => sha(readFileSync(join(secondRoot, m.path))) === m.sha256));
    check('all bundle staging directories are removed', readdirSync(join(project, 'assets/bundles')).every(name => /^[a-f0-9]{64}$/.test(name)));
    save(join(out, 'identity.json'), { project, projectId, oldRevision: old, currentRevision: current, sourceBuild: json(join(out, 'authored-source/build.json')), runtimeBuild: (await runtime.getCapabilities()).buildHash, firstBundle: first.bundle.sha256, secondBundle: second.bundle.sha256 });
}
catch (error) {
    failure = { message: error.message, code: error.code ?? null };
    throw error;
}
finally {
    if (ctx)
        await ctx.fiber.dispose();
    save(join(out, 'report.json'), { checks, artifacts, calls, failure, scope: 'Maintained actual Host/provider and independently authored native glTF buffers/images. No independent adoption or complete dependency guarantees for other formats/extensions.' });
    if (!failure)
        console.log(`Asset bundles: ${checks.length}/${checks.length} checks passed`);
}
