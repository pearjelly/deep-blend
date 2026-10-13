/** Isolated asset compilation must never enter the user's kept Blender session. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalBlenderRuntime, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import { BLENDER_PROTOCOL_VERSION, BlenderErrorCode, sha256 } from '@deepblend/dsh-blender-contracts'
import { verifyGeometryReport } from '../../../packages/deepblend/provider-local/lib/geometry-inspection.js'

const inspectionRequest = () => ({ entityIds: ['body'], frame: 24, checkpointSha256: sha256('native checkpoint') })
const inspectionReport = () => ({ schemaVersion: 'deepblend.geometry-inspection/v1',
  checkpointSha256: sha256('native checkpoint'), checkpointUnchanged: true, frame: 24, blenderVersion: '5.2.1',
  objects: [{ entityId: 'body', type: 'MESH', available: true, vertexCount: 8, polygonCount: 6,
    worldBoundsMeters: { min: [0,0,0], max: [.1,.2,.3] }, worldAxisExtentMm: [100,200,300],
    scale: [1,1,1], worldMatrix: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] }] })

for (const [name, edit] of [
  ['wrong native source', r => { r.checkpointSha256 = '0'.repeat(64) }],
  ['wrong frame', r => { r.frame = 1 }],
  ['wrong selected entity', r => { r.objects[0].entityId = 'another' }],
  ['missing object', r => { r.objects = [] }],
  ['non-finite transform', r => { r.objects[0].worldMatrix[0][0] = NaN }],
  ['incorrect unit conversion', r => { r.objects[0].worldAxisExtentMm[0] = .1 }],
  ['reversed bounds', r => { r.objects[0].worldBoundsMeters.min[0] = 1 }],
  ['invented hidden object dimensions', r => { r.objects[0].available = false; r.objects[0].unavailableReason = 'viewport-disabled' }],
  ['unbounded payload', r => { r.padding = 'x'.repeat(65536) }],
  ['invented wall thickness', r => { r.objects[0].wallThicknessMm = 2 }],
  ['invented assembly gap', r => { r.objects[0].clearanceMm = .15 }],
  ['invented nested gap', r => { r.objects[0].worldBoundsMeters.clearanceMm = .15 }],
  ['invented report-level thickness', r => { r.wallThicknessMm = 2 }],
]) test(`geometry receipt refuses ${name}`, () => {
  const report = inspectionReport(); edit(report)
  assert.throws(() => verifyGeometryReport(report, inspectionRequest()), error => error.code === 'BLENDER_SCRIPT_ERROR')
})

test('geometry receipt distinguishes world-axis extents and unavailable viewport geometry', () => {
  const report = inspectionReport()
  assert.equal(verifyGeometryReport(report, inspectionRequest()), report)
  report.objects = [{ entityId: 'body', type: 'MESH', available: false, unavailableReason: 'viewport-disabled' }]
  assert.equal(verifyGeometryReport(report, inspectionRequest()), report)
  assert.equal(Object.hasOwn(report.objects[0], 'worldAxisExtentMm'), false)
})

async function geometryRuntime(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'deepblend-geometry-contract-')), ctx = new Context()
  const runtime = new LocalBlenderRuntime(ctx, ProviderConfig({ workspaceRoot: scratch }))
  t.after(async () => { await ctx.fiber.dispose(); rmSync(scratch, { recursive: true, force: true }) })
  const source = join(scratch, 'scene.blend'); writeFileSync(source, 'native checkpoint')
  const request = { ...inspectionRequest(), checkpointPath: source }
  let calls = 0
  runtime._keptSession = async () => { throw Error('Must not enter a live Blender session') }
  runtime.runBootstrap = async (call, options) => {
    calls++
    assert.equal(call.action, 'inspect_geometry'); assert.equal(options.session, false)
    const snapshot = options.args[1]
    assert.notEqual(snapshot, source); assert.equal(readFileSync(snapshot, 'utf8'), 'native checkpoint')
    return { envelope: { result: inspectionReport() }, durationMs: 1, stdout: '', stderr: '' }
  }
  return { runtime, scratch, source, request, calls: () => calls }
}

test('geometry inspection uses a verified isolated snapshot and keeps original bytes', async t => {
  const f = await geometryRuntime(t), result = await f.runtime.inspectGeometry(f.request)
  assert.equal(result.report.frame, 24); assert.equal(f.calls(), 1)
  assert.equal(readFileSync(f.source, 'utf8'), 'native checkpoint')
  assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
})

for (const [name, edit] of [
  ['duplicate entities', r => { r.entityIds = ['body','body'] }],
  ['too many entities', r => { r.entityIds = Array.from({length:9}, (_,i) => `part${i}`) }],
  ['omitted frame', r => { delete r.frame }],
  ['fractional frame', r => { r.frame = 1.5 }],
  ['wrong checkpoint hash', r => { r.checkpointSha256 = '0'.repeat(64) }],
]) test(`geometry inspection refuses ${name} before Blender runs`, async t => {
  const f = await geometryRuntime(t); edit(f.request)
  await assert.rejects(f.runtime.inspectGeometry(f.request))
  assert.equal(f.calls(), 0); assert.equal(readFileSync(f.source, 'utf8'), 'native checkpoint')
})

test('geometry inspection refuses symlinks outside the runtime workspace', async t => {
  const f = await geometryRuntime(t), outside = mkdtempSync(join(tmpdir(), 'deepblend-geometry-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const foreign = join(outside, 'foreign.blend'); writeFileSync(foreign, 'native checkpoint')
  const link = join(f.scratch, 'outside.blend'); symlinkSync(foreign, link)
  await assert.rejects(f.runtime.inspectGeometry({ ...f.request, checkpointPath: link }), e => e.code === BlenderErrorCode.PATH_OUTSIDE_WORKSPACE)
  assert.equal(f.calls(), 0)
  f.runtime.workspaceRoot = join(f.scratch, 'missing-workspace')
  await assert.rejects(f.runtime.inspectGeometry(f.request), e => e.code === BlenderErrorCode.PATH_OUTSIDE_WORKSPACE)
})

test('geometry inspection rejects a correct-looking report if the source changed during execution', async t => {
  const f = await geometryRuntime(t), original = f.runtime.runBootstrap
  f.runtime.runBootstrap = async (...args) => { const result = await original(...args); writeFileSync(f.source, 'changed checkpoint'); return result }
  await assert.rejects(f.runtime.inspectGeometry(f.request), e => e.code === BlenderErrorCode.SCENE_VALIDATION_FAILED)
  assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
})

test('geometry inspection cancellation preserves stable abort semantics and removes private snapshots', async t => {
  const f = await geometryRuntime(t), controller = new AbortController(), original = f.runtime.runBootstrap
  f.runtime.runBootstrap = async (...args) => { const result = await original(...args); controller.abort(); return result }
  await assert.rejects(f.runtime.inspectGeometry({ ...f.request, signal: controller.signal }), e => e.code === 'BLENDER_ABORTED')
  assert.equal(readFileSync(f.source, 'utf8'), 'native checkpoint'); assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
  await assert.rejects(f.runtime.inspectGeometry({ ...f.request, signal: controller.signal }), e => e.code === 'BLENDER_ABORTED')
  assert.equal(f.calls(), 1)
})
import { ROOT } from '../../tools/workspace-layout.mjs'

for (const [method, action] of [['compileScene', 'compile_scene'], ['renderPreview', 'render_preview'], ['renderViews', 'render_views']]) {
  for (const isolated of [true, false]) {
    test(`${method}: ${isolated ? 'session:false uses batch and leaves the live session alone' : 'omission retains configured session routing'}`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'deepblend-isolated-preview-'))
      const spawned = []
      let attached = 0
      let sessionCalls = 0
      const liveScene = { document: 'user-unsaved-scene', changed: false }
      const ctx = new Context()
      ctx.provide('subprocess', {
        async resolveExecutable() { return process.execPath },
        spawn(request) {
          spawned.push(request)
          const document = JSON.parse(readFileSync(request.argv[request.argv.indexOf('--request') + 1], 'utf8'))
          assert.equal(document.action, action)
          assert.ok(request.argv.includes('--background'))
          assert.ok(request.argv.includes('--factory-startup'))
          writeFileSync(request.argv[request.argv.indexOf('--result') + 1], JSON.stringify({
            protocolVersion: BLENDER_PROTOCOL_VERSION, status: 'ok', result: { transport: 'batch' },
          }))
          return { done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } } }
        },
      })
      const runtime = new LocalBlenderRuntime(ctx, ProviderConfig({
        workspaceRoot: scratch, blenderPath: process.execPath, sessionActions: [action], sessionSocket: join(scratch, 'user-live.sock'),
      }))
      runtime._keptSession = async () => {
        attached++
        return { directory: scratch, run: async request => {
          sessionCalls++
          assert.equal(request.action, action)
          liveScene.changed = true
          return { protocolVersion: BLENDER_PROTOCOL_VERSION, status: 'ok', result: { transport: 'session' } }
        } }
      }
      runtime._touchSession = () => {}
      try {
        const request = { sceneSpecPath: join(scratch, 'scene.json'), checkpointPath: join(scratch, 'scene.blend'),
          outputPath: join(scratch, 'preview.png'), views: [{ id: 'selected', cameraId: 'hero', frame: 24 }],
          ...(isolated ? { session: false } : {}) }
        const result = await runtime[method](request)
        assert.equal(result.report.transport, isolated ? 'batch' : 'session')
        assert.equal(spawned.length, isolated ? 1 : 0)
        assert.equal(attached, isolated ? 0 : 1)
        assert.equal(sessionCalls, isolated ? 0 : 1)
        assert.deepEqual(liveScene, { document: 'user-unsaved-scene', changed: !isolated })
      } finally {
        await runtime.dispose()
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  }
}

for (const scenario of ['evaluated-camera', 'per-view-capture', 'orthographic-no-focus', 'geometry-session']) {
  test(`multi-view facts: ${scenario} (production Python with a controlled scene)`, () => {
    const python = [process.env.DEEPBLEND_PYTHON, 'python3', 'python'].filter(Boolean).find(command =>
      spawnSync(command, ['-c', 'import sys; assert sys.version_info.major == 3'], { stdio: 'ignore' }).status === 0)
    assert.ok(python, 'Python 3 is required for the provider report contract; set DEEPBLEND_PYTHON if needed')
    const result = spawnSync(python, [join(ROOT, 'deepblend/tests/lib/provider-view-facts.py'), scenario],
      { cwd: ROOT, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  })
}

for (const keepWorkingDirectory of [false, true]) {
  for (const outcome of ['success', 'no-callback', 'compile-error', 'abort', 'callback-error']) {
    test(`compileScene owns its output directory: ${outcome}, keepWorkingDirectory=${keepWorkingDirectory}`, async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'deepblend-compile-cleanup-'))
      const runtime = new LocalBlenderRuntime(new Context(), ProviderConfig({ workspaceRoot: scratch, keepWorkingDirectory }))
      const injected = outcome === 'abort' ? new DOMException('Cancelled while writing checkpoint', 'AbortError')
        : new Error(outcome)
      let directory, callbackConsumed = false
      runtime.runBootstrap = async (request, options) => {
        const output = options.args[options.args.indexOf('--output-blend') + 1]
        directory = dirname(output)
        writeFileSync(output, 'partial checkpoint')
        if (outcome === 'compile-error' || outcome === 'abort') throw injected
        return { envelope: { result: { outputBlend: output } }, durationMs: 0, stdout: '', stderr: '' }
      }
      try {
        const pending = runtime.compileScene({ sceneSpecPath: join(scratch, 'scene.json'), session: false,
          ...(outcome === 'no-callback' ? {} : { onWorkingDirectory: async info => {
            assert.equal(info.directory, directory)
            // Consumption may be asynchronous; cleanup must wait for it.
            await new Promise(resolve => setImmediate(resolve))
            assert.equal(readFileSync(join(info.directory, 'result.blend'), 'utf8'), 'partial checkpoint')
            callbackConsumed = true
            if (outcome === 'callback-error') throw injected
          } }) })
        if (['compile-error', 'abort', 'callback-error'].includes(outcome)) {
          await assert.rejects(pending, error => error === injected)
        } else await pending
        assert.equal(callbackConsumed, outcome === 'success' || outcome === 'callback-error')
        assert.equal(existsSync(directory), keepWorkingDirectory)
        if (keepWorkingDirectory) assert.equal(readFileSync(join(directory, 'result.blend'), 'utf8'), 'partial checkpoint')
      } finally {
        await runtime.dispose()
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  }
}
