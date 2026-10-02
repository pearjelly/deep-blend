/** Isolated asset compilation must never enter the user's kept Blender session. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalBlenderRuntime, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import { BLENDER_PROTOCOL_VERSION } from '@deepblend/dsh-blender-contracts'

for (const [method, action] of [['compileScene', 'compile_scene'], ['renderPreview', 'render_preview']]) {
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
          outputPath: join(scratch, 'preview.png'), ...(isolated ? { session: false } : {}) }
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
