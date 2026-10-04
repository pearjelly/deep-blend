/** Packed public runner outside the checkout, using the maintained real provider connector. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const ROOT = resolve(import.meta.dirname, '../../..');
const out = resolve(process.env.DEEPBLEND_RUNTIME_CONFORMANCE_OUTPUT ?? join(ROOT, '.deepblend/quality', `runtime-conformance-${Date.now()}`));
const blender = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender');
assert(!existsSync(out), 'Fresh evidence directory required');
mkdirSync(out, { recursive: true });
const consumer = mkdtempSync(join(tmpdir(), 'deepblend-runtime-author-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
writeFileSync(join(out, 'consumer.json'), JSON.stringify({ consumer, blender }, null, 2));
const run = (command, args, cwd, timeout = 120000) => {
    const result = spawnSync(command, args, { cwd, env: { ...process.env, DEEPBLEND_BLENDER_PATH: blender }, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(out, `step-${run.index++}.log`), (result.stdout ?? '') + '\n' + (result.stderr ?? ''));
    assert.equal(result.status, 0, `Command failed: ${command}; ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result;
};
run.index = 0;
try {
    // Unknown profiles must be refused before resetting an existing Blender scene.
    const refusalScript = join(out, 'profile-refusal.py');
    writeFileSync(refusalScript, "import bpy,json,sys\nfrom pathlib import Path\nroot,out=sys.argv[sys.argv.index('--')+1:]\nsys.path.insert(0,str(Path(root)/'packages/deepblend/provider-local/python'))\nfrom deepblend_scene import build_scene\nfrom deepblend_util import ActionError\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name='profile-refusal-sentinel'\nbefore=sorted(obj.name for obj in bpy.data.objects)\nspec=json.loads((Path(root)/'deepblend/examples/runtime-author/scene-spec.json').read_text())\ntry:\n    build_scene(spec,{'profile':'missing-profile'},None)\nexcept ActionError as error:\n    assert error.code=='RENDER_PROFILE_MISSING'\nelse:\n    raise AssertionError('unknown profile accepted')\nassert sorted(obj.name for obj in bpy.data.objects)==before\nPath(out).write_text(json.dumps({'code':'RENDER_PROFILE_MISSING','liveSceneInventoryPreserved':True,'objects':before,'buildHash':bpy.app.build_hash.decode()}))\n");
    run(blender, ['--background', '--factory-startup', '--python', refusalScript, '--', ROOT, join(out, 'profile-refusal.json')], ROOT);
    const refusal = JSON.parse(readFileSync(join(out, 'profile-refusal.json')));
    assert.equal(refusal.code, 'RENDER_PROFILE_MISSING');
    assert.equal(refusal.liveSceneInventoryPreserved, true);
    const archiveDirectory = join(out, 'package');
    mkdirSync(archiveDirectory);
    run('npm', ['pack', './packages/deepblend/contracts', '--pack-destination', archiveDirectory], ROOT);
    const archive = join(archiveDirectory, readdirSync(archiveDirectory).find(file => file.endsWith('.tgz')));
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'deepblend-runtime-author-consumer', private: true, type: 'module' }));
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', archive], consumer);
    for (const file of ['conformance.mjs', 'run-conformance.mjs', 'scene-spec.json', 'verify-checkpoint.py'])
        cpSync(join(ROOT, 'deepblend/examples/runtime-author', file), join(consumer, file));
    // Connector dependencies belong to the real DSH runtime. The copied checker only imports installed public contracts.
    const connector = join(ROOT, 'deepblend/examples/runtime-author/local-factory.mjs');
    writeFileSync(join(consumer, 'factory.mjs'), `export {createRuntime} from ${JSON.stringify(pathToFileURL(connector).href)}\n`);
    const evidence = join(out, 'execution');
    run(process.execPath, [join(consumer, 'run-conformance.mjs'), join(consumer, 'factory.mjs'), evidence, blender], consumer, 600000);
    const report = JSON.parse(readFileSync(join(evidence, 'report.json')));
    assert.equal(report.status, 'passed');
    assert(report.checks.every(check => check.ok));
    assert.equal(report.sdk.version, JSON.parse(readFileSync(join(ROOT, 'packages/deepblend/contracts/package.json'))).version);
    for (const file of ['conformance.mjs', 'run-conformance.mjs', 'scene-spec.json', 'verify-checkpoint.py'])
        assert.equal(sha(readFileSync(join(consumer, file))), sha(readFileSync(join(ROOT, 'deepblend/examples/runtime-author', file))));
    writeFileSync(join(out, 'consumer.json'), JSON.stringify({ consumer, blender, archiveSha256: sha(readFileSync(archive)), connectorSha256: sha(readFileSync(connector)), checks: report.checks.length, profileRefusal: refusal,
        scope: 'Actual packed checker outside checkout; maintained connector uses public DSH/provider packages. No independent implementation/adoption claim.' }, null, 2));
    console.log(`Runtime conformance: ${report.checks.length + 1}/${report.checks.length + 1} checks passed`);
}
catch (error) {
    writeFileSync(join(out, 'failure.json'), JSON.stringify({ message: error.message }, null, 2));
    throw error;
}
