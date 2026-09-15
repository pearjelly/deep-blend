#!/usr/bin/env node
/**
 * Executable-resolution contract — the five ways a configured Blender path can be wrong.
 *
 * WHY THIS EXISTS
 * ---------------
 * `_assertAllowed` decides whether a resolved path may be used at all, and four of its five answers are
 * refusals with their own error codes and their own advice. The coverage reading said every one of them
 * had never been executed: they are branches a machine reaches only when somebody's install is broken
 * in a specific way, which is exactly the state the error text exists for. Two of them are security
 * rules rather than diagnostics:
 *
 *   - a BARE name (resolved through PATH) must satisfy the allowlist, while an absolute request is
 *     trusted — the distinction SPEC §15.2 rests on;
 *   - a directory is not an executable, however plausible its name.
 *
 * The branches are driven through a STUB `subprocess` service, which is the seam the provider itself
 * uses (`ctx.subprocess.resolveExecutable`): a fake resolver returns whatever path a case needs, so
 * each refusal is produced by the rule rather than arranged on the machine. One branch is deliberately
 * NOT covered — "is not stat-able" needs `realpath` to succeed and `stat` to fail on the same path
 * microseconds later, which is a race no test can own.
 *
 * Run: node deepblend/tests/contract/blender-executable-resolution.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'

import ProviderPlugin from '@deepblend/dsh-blender-provider-local'

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-resolve-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

// The store realpaths its roots, and on macOS that turns `/var/...` into `/private/var/...`. A test
// comparing the two spellings of one path fails for a reason that has nothing to do with the rule —
// the M3 acceptance suite documents the same trap for the same reason.
const realFile = join(realpathSync(scratch), 'blender')
writeFileSync(realFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const realDirectory = join(realpathSync(scratch), 'Blender.app')
mkdirSync(realDirectory, { recursive: true })

/**
 * Compose the provider with a stubbed `subprocess` service.
 *
 * @param {{ resolve?: () => Promise<string>, throwWith?: Error, blenderPath?: string, allowlist?: string[] }} options
 */
async function runtimeWith(options) {
  const composed = new Context()
  composed.provide('subprocess', {
    async resolveExecutable() {
      if (options.throwWith !== undefined) throw options.throwWith
      return options.resolve()
    },
  })
  composed.plugin(ProviderPlugin, {
    blenderPath: options.blenderPath ?? realFile,
    bootstrapPath: join(scratch, 'bootstrap.py'),
    workspaceRoot: join(scratch, 'runtime'),
    timeoutMs: 5_000,
    executableAllowlist: options.allowlist ?? [],
  })
  await new Promise(settle => setTimeout(settle, 50))
  return composed.get('blenderRuntime')
}

test('a relative path is refused: nothing downstream can spawn it', async () => {
  const runtime = await runtimeWith({ resolve: async () => 'bin/blender' })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.resolved, null)
  assert.equal(resolved.error.code, 'BLENDER_NOT_FOUND')
  assert.match(resolved.error.message, /not absolute/)
})

test('a path that does not exist is refused with the path in the message', async () => {
  const runtime = await runtimeWith({ resolve: async () => join(scratch, 'gone', 'blender') })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.error.code, 'BLENDER_NOT_FOUND')
  assert.match(resolved.error.message, /does not exist/)
  // The message names the path as it was RESOLVED (not realpath'd): that is the string the operator
  // typed and the one they will go and look at.
  assert.ok(resolved.error.message.includes(join(scratch, 'gone', 'blender')))
})

test('a DIRECTORY is not an executable, however plausible its name', async () => {
  // The macOS managed install is a `.app` bundle, so a directory whose name ends in `Blender` is the
  // most likely wrong answer to "where is Blender?" — and it must be refused before anything spawns.
  const runtime = await runtimeWith({ resolve: async () => realDirectory, blenderPath: realDirectory })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.resolved, null)
  assert.equal(resolved.error.code, 'BLENDER_EXECUTABLE_NOT_EXECUTABLE')
  assert.match(resolved.error.message, /directory, not an executable/)
})

test('a bare name that resolves OUTSIDE the allowlist is refused — the security half', async () => {
  const runtime = await runtimeWith({ resolve: async () => realFile, blenderPath: 'blender' })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.resolved, null)
  assert.equal(resolved.error.code, 'BLENDER_EXECUTABLE_OUTSIDE_ALLOWLIST')
  assert.match(resolved.error.message, /outside the configured allowlist/)
  assert.match(resolved.error.message, /executableAllowlist/, 'the message must name the key to change')
})

test('the same file is ACCEPTED when the operator asked for it by absolute path', async () => {
  // The contrast that matters: policy depends on what was ASKED FOR, not on where the file is. An
  // absolute request is the operator's own decision (and the managed install arrives that way).
  const runtime = await runtimeWith({ resolve: async () => realFile, blenderPath: realFile })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.error, null)
  assert.equal(resolved.resolved, realFile, 'a trusted absolute path must resolve')
})

test('and it is accepted when the bare name resolves INSIDE the allowlist', async () => {
  const runtime = await runtimeWith({
    resolve: async () => realFile,
    blenderPath: 'blender',
    allowlist: [realpathSync(scratch)],
  })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.error, null)
  assert.equal(resolved.resolved, realFile)
})

test('a resolver that throws becomes data with advice, not a rejection', async () => {
  // The one branch that IS reachable on a working machine, kept here so the two halves stay in one
  // place: `resolveBlenderExecutable` never throws — M0 must be able to DESCRIBE a machine with no
  // Blender (SPEC §9.4), and the advice is what both readers show (round 35).
  const runtime = await runtimeWith({ throwWith: Object.assign(new Error('spawn blender ENOENT'), { code: 'ENOENT' }) })
  const resolved = await runtime.resolveBlenderExecutable()
  assert.equal(resolved.resolved, null)
  assert.equal(resolved.error.code, 'BLENDER_NOT_FOUND')
  assert.equal(typeof resolved.advice, 'string')
  assert.ok(resolved.advice.length > 0)
})
