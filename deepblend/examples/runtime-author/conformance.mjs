/** Copyable execution checks against the public BlenderRuntime seam. */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseSceneSpec, compileSceneSpec, BLENDER_PROTOCOL_VERSION, BlenderErrorCode } from '@deepblend/dsh-blender-contracts/sdk';
import { decodePng } from '@deepblend/dsh-blender-contracts';
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const RUNTIME_METHODS = ['getCapabilities', 'invalidateCapabilities', 'resolveEngineKey', 'compileScene', 'renderPreview', 'renderViews', 'startFrameSequence', 'awaitFrameSequence', 'dispose'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const finite = n => typeof n === 'number' && Number.isFinite(n);
export async function runConformance({ createRuntime, outputDirectory, blenderPath, deadlineMs = 90000 }) {
    const out = resolve(outputDirectory);
    assert(!existsSync(out), 'Evidence directory already exists');
    mkdirSync(out, { recursive: true });
    const startedAt = Date.now();
    const report = { schemaVersion: 'deepblend.runtime-conformance/v1', profile: 'cycles-fixture/v1', status: 'running', startedAt: new Date(startedAt).toISOString(), deadlineMs, checks: [], calls: [], artifacts: [],
        scope: { checked: 'Finite fixture execution, independent checkpoint readback/reference pixels, handoff, views, failure, cancellation and partial frame resume.',
            unverified: ['Independent adoption', 'Artistic quality', 'Other engines, file formats and all scenes/parameter combinations', 'Remote worker recovery and arbitrary deployment compatibility', 'Cleanup of resources not observable through the adapter lifecycle'] }, node: process.version,
        sdk: { version: require('@deepblend/dsh-blender-contracts/package.json').version, entrySha256: hash(readFileSync(require.resolve('@deepblend/dsh-blender-contracts/sdk'))) } };
    let live = null, absent = null, activeRun = null;
    const record = (name, detail) => { report.checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); save(); };
    const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const bounded = async (name, fn) => {
        const controller = new AbortController();
        let timer;
        const pending = Promise.resolve().then(() => fn(controller.signal));
        try {
            return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error(`${name} exceeded ${deadlineMs} ms; completion and cleanup are unverified`)); }, deadlineMs); })]);
        }
        finally {
            clearTimeout(timer);
        }
    };
    const call = async (runtime, method, args) => { report.calls.push({ method }); return bounded(method, signal => typeof args === 'string' ? runtime[method](args, { signal }) : runtime[method]({ ...args, signal })); };
    const envelope = (value, action) => { assert.equal(value?.protocolVersion, BLENDER_PROTOCOL_VERSION); assert.equal(value.action, action); assert.equal(value.status, 'success'); assert.equal(value.error, null); assert(value.result && typeof value.result === 'object'); };
    const action = (value, kind) => { envelope(value?.envelope, kind); assert.deepEqual(value.report, value.envelope.result); assert(finite(value.durationMs) && value.durationMs >= 0); };
    const png = (path, bytes, expected = {}) => {
        const decoded = decodePng(bytes);
        assert.equal(decoded.width, expected.width ?? 160);
        assert.equal(decoded.height, expected.height ?? 120);
        const colors = new Set();
        for (let n = 0; n < decoded.data.length; n += 4) {
            assert.equal(decoded.data[n + 3], 255);
            colors.add(decoded.data.subarray(n, n + 3).toString('hex'));
        }
        assert(colors.size > 32, 'Blank or nearly constant image');
        writeFileSync(path, bytes);
        report.artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes), width: decoded.width, height: decoded.height });
        return decoded;
    };
    const refuse = async (name, fn, codes) => { let error; try {
        await fn();
    }
    catch (e) {
        error = e;
    } assert(error, `${name} accepted invalid input`); assert(codes.includes(error.code), `${name} returned unexpected code ${error.code}`); record(name, { code: error.code }); };
    try {
        save();
        assert.equal(typeof createRuntime, 'function');
        assert.equal(typeof blenderPath, 'string');
        assert(finite(deadlineMs) && deadlineMs >= 1000 && deadlineMs <= 300000);
        for (const file of ['scene-spec.json', 'conformance.mjs', 'verify-checkpoint.py']) {
            const bytes = readFileSync(join(HERE, file));
            copyFileSync(join(HERE, file), join(out, file));
            (report.sources ??= []).push({ file, sha256: hash(bytes) });
        }
        const spec = compileSceneSpec(parseSceneSpec(JSON.parse(readFileSync(join(HERE, 'scene-spec.json'))))).spec;
        const input = join(out, 'resolved-scene.json');
        writeFileSync(input, JSON.stringify(spec));
        const inputHash = hash(readFileSync(input));
        live = await bounded('createRuntime', signal => createRuntime({ workspaceRoot: join(out, 'runtime'), scenario: 'installed', signal }));
        assert(live?.runtime && typeof live.close === 'function', 'Factory must provide runtime and async close');
        const runtime = live.runtime;
        for (const method of RUNTIME_METHODS)
            assert.equal(typeof runtime[method], 'function', `Missing ${method}`);
        const caps = await call(runtime, 'getCapabilities', { refresh: true });
        assert.equal(caps.installed, true);
        assert.equal(caps.protocolVersion, BLENDER_PROTOCOL_VERSION);
        assert(caps.blenderVersion && caps.buildHash);
        assert(Object.values(caps.renderEngines).some(p => p.assignable));
        assert(caps.cyclesSmokeTest?.ok, 'Cycles behavior probe did not pass');
        report.capabilities = caps;
        record('measured installed capabilities');
        runtime.invalidateCapabilities();
        report.calls.push({ method: 'invalidateCapabilities' });
        const refreshed = await call(runtime, 'getCapabilities', { refresh: true });
        assert.equal(refreshed.installed, true);
        record('capabilities remain valid after invalidation');
        const engine = await call(runtime, 'resolveEngineKey', 'cycles');
        assert.equal(engine.blenderEngine, 'CYCLES');
        assert.equal(engine.downgraded, false);
        record('Cycles key resolves without downgrade');
        absent = await bounded('unavailable factory', signal => createRuntime({ workspaceRoot: join(out, 'unavailable'), scenario: 'unavailable', signal }));
        assert(absent?.runtime && typeof absent.close === 'function');
        const missing = await call(absent.runtime, 'getCapabilities', { refresh: true });
        assert.equal(missing.installed, false);
        assert(missing.warnings?.length > 0 || missing.executable?.advice);
        record('missing executable reports installed false and advice');
        const missingEngine = await call(absent.runtime, 'resolveEngineKey', 'cycles');
        assert.equal(missingEngine.blenderEngine, null);
        assert.equal(missingEngine.requested, 'CYCLES');
        assert.equal(missingEngine.downgraded, false);
        record('unavailable executable does not invent a resolved engine');
        await refuse('unknown engine key is refused', () => call(runtime, 'resolveEngineKey', 'missing-engine'), [BlenderErrorCode.RENDER_PROFILE_MISSING]);
        const cancelledProbe = new AbortController();
        cancelledProbe.abort();
        await refuse('cached capability request respects cancellation', () => runtime.getCapabilities({ signal: cancelledProbe.signal }), [BlenderErrorCode.ABORTED]);
        const checkpoint = join(out, 'scene.blend');
        let handedDirectory = null, callbackFinished = false;
        const compiled = await call(runtime, 'compileScene', { sceneSpecPath: input, projectRoot: out, profile: 'preview', session: false, jobId: 'conformance-compile', onWorkingDirectory: async ({ directory, envelope: value }) => {
                envelope(value, 'compile_scene');
                handedDirectory = directory;
                assert(existsSync(join(directory, 'result.blend')));
                await sleep(50);
                copyFileSync(join(directory, 'result.blend'), checkpoint);
                callbackFinished = true;
            } });
        action(compiled, 'compile_scene');
        assert(callbackFinished, 'Compile did not await artifact handoff');
        assert(compiled.report.validation.ok);
        assert(compiled.report.sceneFingerprint.totalPolygons > 0);
        assert(!existsSync(handedDirectory), 'Provider scratch survives successful batch compilation');
        record('compile awaits saved checkpoint handoff and clears scratch');
        const checkpointHash = hash(readFileSync(checkpoint));
        writeFileSync(join(out, 'compile-receipt.json'), JSON.stringify(compiled, null, 2));
        let failedDirectory = null;
        await assert.rejects(() => call(runtime, 'compileScene', { sceneSpecPath: input, projectRoot: out, session: false, onWorkingDirectory: async ({ directory }) => { failedDirectory = directory; throw Error('consumer handoff refusal'); } }), /consumer handoff refusal/);
        assert(failedDirectory && !existsSync(failedDirectory));
        record('consumer handoff failure clears provider scratch');
        const previewPath = join(out, 'preview.png');
        const preview = await call(runtime, 'renderPreview', { checkpointPath: checkpoint, outputPath: previewPath, cameraId: 'hero', frame: 1, engine: 'cycles', width: 160, height: 120, samples: 8, session: false });
        action(preview, 'render_preview');
        const previewBytes = readFileSync(previewPath);
        assert.equal(preview.report.bytes, previewBytes.length);
        assert.equal(preview.report.frame, 1);
        assert.equal(preview.report.cameraId, 'hero');
        assert.equal(preview.report.width, 160);
        assert.equal(preview.report.height, 120);
        assert.equal(preview.report.engine, 'CYCLES');
        png(previewPath, previewBytes);
        writeFileSync(join(out, 'preview-receipt.json'), JSON.stringify(preview, null, 2));
        record('preview actual PNG agrees with request and receipt');
        const plan = [{ id: 'early', cameraId: 'hero', frame: 1 }, { id: 'late', cameraId: 'hero', frame: 3 }];
        const views = await call(runtime, 'renderViews', { checkpointPath: checkpoint, views: plan, track: ['body'], parts: [], engine: 'cycles', width: 160, height: 120, samples: 8, session: false });
        envelope(views.envelope, 'render_views');
        assert.deepEqual(views.report, views.envelope.result);
        assert.deepEqual(views.report.views.map(v => v.viewId), plan.map(v => v.id));
        assert.deepEqual(Object.keys(views.pngs).sort(), ['early', 'late']);
        for (let i = 0; i < plan.length; i++) {
            const expected = plan[i], view = views.report.views[i], bytes = views.pngs[expected.id];
            assert(Buffer.isBuffer(bytes));
            assert.equal(view.bytes, bytes.length);
            assert.equal(view.cameraId, expected.cameraId);
            assert.equal(view.frame, expected.frame);
            assert.equal(view.width, 160);
            assert.equal(view.height, 120);
            assert.equal(view.engine, 'CYCLES');
            assert.deepEqual(view.renderConfig.resolution, [160, 120]);
            assert.equal(view.renderConfig.samples, 8);
            assert.equal(view.renderConfig.viewTransform, 'AgX');
            assert.equal(view.renderConfig.exposure, .25);
            assert.equal(view.cameraFacts.frame, expected.frame);
            assert(view.cameraFacts.matrixWorld.flat().every(finite));
            assert.equal(view.cameraFacts.matrixWorld.length, 4);
            const measured = view.metrics.objects.find(o => o.id === 'body');
            assert(measured && measured.visiblePixels > 0 && measured.silhouettePixels >= measured.visiblePixels);
            png(join(out, expected.id + '.png'), bytes);
        }
        assert.notDeepEqual(decodePng(views.pngs.early).data, decodePng(views.pngs.late).data, 'Animated fixture renders identical pixels');
        writeFileSync(join(out, 'views-receipt.json'), JSON.stringify({ ...views, pngs: undefined }, null, 2));
        record('ordered measured views survive scratch cleanup and show actual animation');
        const verifier = spawnSync(blenderPath, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', join(out, 'verify-checkpoint.py'), '--', checkpoint, join(out, 'checkpoint-verification.json'), join(out, 'reference.png')], { encoding: 'utf8', timeout: deadlineMs, maxBuffer: 8 * 1024 * 1024 });
        writeFileSync(join(out, 'verification.log'), (verifier.stdout ?? '') + '\n' + (verifier.stderr ?? ''));
        assert.equal(verifier.status, 0, 'Independent checkpoint verification failed');
        const facts = JSON.parse(readFileSync(join(out, 'checkpoint-verification.json')));
        assert.equal(facts.polygons, compiled.report.sceneFingerprint.totalPolygons);
        report.independentVerifier = { ...facts, executable: blenderPath };
        record('independent Blender reopens measured geometry, material and three poses');
        for (let i = 0; i < plan.length; i++) {
            const actual = views.report.views[i].cameraFacts.matrixWorld.flat(), expected = facts.poses.find(p => p.frame === plan[i].frame).cameraMatrix.flat();
            assert.equal(actual.length, 16);
            assert(actual.every((v, n) => Math.abs(v - expected[n]) < 1e-6));
        }
        record('per-view camera matrices match independent checkpoint readback');
        const reference = png(join(out, 'reference.png'), readFileSync(join(out, 'reference.png'))), actual = decodePng(previewBytes);
        let sum = 0, squares = 0, count = 0;
        for (let y = facts.roi[1]; y < facts.roi[3]; y++)
            for (let x = facts.roi[0]; x < facts.roi[2]; x++)
                for (let c = 0; c < 3; c++) {
                    const delta = Math.abs(actual.data[(y * 160 + x) * 4 + c] - reference.data[(y * 160 + x) * 4 + c]) / 255;
                    sum += delta;
                    squares += delta * delta;
                    count++;
                }
        assert(count > 100);
        const agreement = { roi: facts.roi, meanError: sum / count, rmse: Math.sqrt(squares / count), meanLimit: .05, rmseLimit: .08 };
        assert(agreement.meanError <= .05 && agreement.rmse <= .08, 'Preview differs from independently rendered checkpoint');
        record('preview agrees with independent native reference pixels', agreement);
        await refuse('unknown render profile is refused', () => call(runtime, 'compileScene', { sceneSpecPath: input, projectRoot: out, profile: 'missing-profile', session: false }), [BlenderErrorCode.RENDER_PROFILE_MISSING]);
        await refuse('missing checkpoint is refused', () => call(runtime, 'renderPreview', { checkpointPath: join(out, 'missing.blend'), outputPath: join(out, 'missing.png'), session: false }), [BlenderErrorCode.REVISION_CHECKPOINT_MISSING, BlenderErrorCode.SCRIPT_ERROR]);
        assert(!existsSync(join(out, 'missing.png')));
        await refuse('empty view plan is refused', () => call(runtime, 'renderViews', { checkpointPath: checkpoint, views: [], session: false }), [BlenderErrorCode.SCRIPT_ERROR]);
        await refuse('empty frame sequence is refused', () => call(runtime, 'startFrameSequence', { checkpointPath: checkpoint, frames: [], jobDirectory: join(out, 'empty-job') }), [BlenderErrorCode.SCRIPT_ERROR]);
        const abort = new AbortController();
        abort.abort();
        await refuse('pre-aborted compile is refused', () => bounded('aborted compile', () => runtime.compileScene({ sceneSpecPath: input, projectRoot: out, session: false, signal: abort.signal })), [BlenderErrorCode.ABORTED]);
        await refuse('pre-aborted preview is refused', () => bounded('aborted preview', () => runtime.renderPreview({ checkpointPath: checkpoint, outputPath: join(out, 'aborted.png'), session: false, signal: abort.signal })), [BlenderErrorCode.ABORTED]);
        assert(!existsSync(join(out, 'aborted.png')));
        await refuse('pre-aborted views are refused', () => bounded('aborted views', () => runtime.renderViews({ checkpointPath: checkpoint, views: plan, session: false, signal: abort.signal })), [BlenderErrorCode.ABORTED]);
        const frames = [1, 3], job = join(out, 'sequence');
        activeRun = await call(runtime, 'startFrameSequence', { checkpointPath: checkpoint, jobDirectory: job, frames, frameRange: [1, 3], cameraId: 'hero', profileName: 'final', profile: spec.renderProfiles.final, filePrefix: 'test_', padding: 3, jobId: 'conformance-sequence' });
        assert(activeRun.handle?.done && typeof activeRun.handle.terminate === 'function');
        assert.equal(resolve(activeRun.jobDirectory), job);
        const outcome = await bounded('complete sequence', () => runtime.awaitFrameSequence(activeRun));
        report.calls.push({ method: 'awaitFrameSequence' });
        await activeRun.handle.done;
        activeRun = null;
        assert.equal(outcome.exitCode, 0);
        assert.equal(outcome.spawnFailure, null);
        envelope(outcome.envelope, 'render_frames');
        assert.deepEqual(outcome.envelope.result.renderedFrames, frames);
        for (const frame of frames)
            png(join(job, 'frames', `test_${String(frame).padStart(3, '0')}.png`), readFileSync(join(job, 'frames', `test_${String(frame).padStart(3, '0')}.png`)));
        assert.deepEqual(readdirSync(join(job, 'frames')).sort(), ['test_001.png', 'test_003.png']);
        writeFileSync(join(out, 'sequence-outcome.json'), JSON.stringify(outcome, null, 2));
        record('noncontiguous frame plan writes exact durable frames and reaches terminal success');
        const partialJob = join(out, 'partial-sequence'), partialFrames = Array.from({ length: 12 }, (_, i) => i + 1), profile = { ...spec.renderProfiles.final, resolution: [320, 240], samples: 16 };
        activeRun = await call(runtime, 'startFrameSequence', { checkpointPath: checkpoint, jobDirectory: partialJob, frames: partialFrames, frameRange: [1, 12], cameraId: 'hero', profileName: 'final', profile, filePrefix: 'resume_', padding: 3, jobId: 'conformance-cancel' });
        let settled = false;
        activeRun.handle.done.then(() => { settled = true; }, () => { settled = true; });
        const first = join(partialJob, 'frames', 'resume_001.png');
        const start = Date.now();
        while (true) {
            if (existsSync(first)) {
                try {
                    decodePng(readFileSync(first));
                    break;
                }
                catch { }
            }
            assert(!settled, 'Sequence finished before partial cancellation could be tested');
            assert(Date.now() - start < deadlineMs, 'No complete first frame before cancellation deadline');
            await sleep(20);
        }
        assert(!settled);
        const firstHash = hash(readFileSync(first));
        activeRun.handle.terminate();
        activeRun.handle.terminate();
        const cancelled = await bounded('cancelled sequence terminal wait', () => runtime.awaitFrameSequence(activeRun));
        await activeRun.handle.done;
        activeRun = null;
        assert(cancelled.exitCode !== 0 || cancelled.signal !== null);
        assert(!(cancelled.envelope?.status === 'success' && cancelled.envelope.result?.renderedCount === 12));
        assert.equal(hash(readFileSync(first)), firstHash);
        writeFileSync(join(out, 'cancelled-outcome.json'), JSON.stringify(cancelled, null, 2));
        record('termination is idempotent, awaited and preserves complete partial frame');
        const retained = {};
        const missingFrames = [];
        for (const frame of partialFrames) {
            const path = join(partialJob, 'frames', `resume_${String(frame).padStart(3, '0')}.png`);
            try {
                decodePng(readFileSync(path));
                retained[path] = hash(readFileSync(path));
            }
            catch {
                missingFrames.push(frame);
            }
        }
        assert(missingFrames.length > 0);
        activeRun = await call(runtime, 'startFrameSequence', { checkpointPath: checkpoint, jobDirectory: partialJob, frames: missingFrames, frameRange: [1, 12], cameraId: 'hero', profileName: 'final', profile, filePrefix: 'resume_', padding: 3, jobId: 'conformance-resume' });
        const resumed = await bounded('resume partial sequence', () => runtime.awaitFrameSequence(activeRun));
        await activeRun.handle.done;
        activeRun = null;
        assert.equal(resumed.exitCode, 0);
        envelope(resumed.envelope, 'render_frames');
        assert.deepEqual(resumed.envelope.result.renderedFrames, missingFrames);
        for (const [path, digest] of Object.entries(retained))
            assert.equal(hash(readFileSync(path)), digest);
        for (const frame of partialFrames) {
            const path = join(partialJob, 'frames', `resume_${String(frame).padStart(3, '0')}.png`);
            png(path, readFileSync(path), { width: 320, height: 240 });
        }
        writeFileSync(join(out, 'resumed-outcome.json'), JSON.stringify(resumed, null, 2));
        record('resume renders missing frames without changing retained complete bytes', { retained: Object.keys(retained).length, rendered: missingFrames.length });
        assert.equal(hash(readFileSync(input)), inputHash);
        assert.equal(hash(readFileSync(checkpoint)), checkpointHash);
        record('input and original checkpoint remain byte-identical');
        runtime.dispose();
        report.calls.push({ method: 'dispose' });
        absent.runtime.dispose();
        record('runtime lightweight disposal completes');
        assert(RUNTIME_METHODS.every(m => report.calls.some(c => c.method === m)));
        report.status = 'passed';
    }
    catch (error) {
        report.status = 'failed';
        report.failure = { message: error.message, code: error.code ?? null };
        if (error.cleanupFailure)
            report.cleanupFailure = error.cleanupFailure;
        report.checks.push({ name: 'conformance execution', ok: false, detail: report.failure });
    }
    finally {
        if (activeRun) {
            try {
                activeRun.handle.terminate();
                await bounded('failed run cleanup', () => activeRun.handle.done);
            }
            catch (error) {
                report.status = 'failed';
                report.cleanupFailure = error.message;
            }
        }
        for (const [name, instance] of [['installed', live], ['unavailable', absent]])
            if (instance?.close) {
                try {
                    await bounded(`${name} factory close`, () => instance.close());
                    record(`${name} factory lifecycle closes`);
                }
                catch (error) {
                    report.status = 'failed';
                    report.cleanupFailure = error.message;
                }
            }
        report.finishedAt = new Date().toISOString();
        report.durationMs = Date.now() - startedAt;
        save();
    }
    return report;
}
