#!/usr/bin/env node
/**
 * `runBootstrap`: the one place every Blender invocation goes through, and the classification of
 * everything that can go wrong around it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every render, compile, probe and asset import in this product runs through this method, and 46 of
 * its lines had never been executed — because the suite that exercises them needs a real Blender, and
 * a real Blender that works produces exactly one of its branches. What was dark is the other nine:
 * a missing bootstrap script, an unresolvable executable, a spawn that throws, a DEADLINE, a caller
 * CANCELLATION, a process that dies without writing a result, a result that is not JSON, a result in
 * the wrong protocol version, and a result that reports an error. Each has its own stable code,
 * because each one tells the operator something different about what to fix.
 *
 * The seam is `ctx.subprocess`, so it is a stub: the provider's own logic is real, the working
 * directory is a real directory on disk, and the result document is a real file the stub writes.
 *
 * THE TWO CLASSIFICATIONS THAT MATTER MOST, and both are asserted here:
 *
 *   - a TIMEOUT is not a cancellation. `timedOut` requires OUR deadline to have fired and the
 *     caller's signal NOT to be aborted — the reverse would report a person's cancel as a machine
 *     problem, or a machine problem as the person's fault.
 *   - the result document is read only AFTER that classification, because a killed process may still
 *     have written a partial document, and a timeout must never be reported as a successful probe.
 *
 * Run standalone: `node deepblend/tests/contract/provider-bootstrap.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, BLENDER_PROTOCOL_VERSION } from '@deepblend/dsh-blender-contracts'
import LocalBlenderRuntime, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BlenderErrorCode.${name} is not a code this build defines — the expectation would be undefined`)
  }
  return value
}

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-bootstrap-'))

/**
 * A REAL executable file, because an absolute `blenderPath` is checked with `stat` before anything is
 * spawned — the first version of this file used `/opt/blender/Blender`, which does not exist here, and
 * the provider correctly refused with "Blender executable does not exist" before it ever reached the
 * spawn branch the case was about.
 */
const blenderPath = join(workspaceRoot, 'fake-blender')
writeFileSync(blenderPath, '#!/bin/sh\nexit 0\n')
chmodSync(blenderPath, 0o755)
// The provider reports the CANONICAL path (`realpath`), and on macOS `/var` realpaths to
// `/private/var` — round 38 learned this the same way: compare real paths, assert the real spelling.
const resolvedBlenderPath = realpathSync(blenderPath)

/**
 * A provider with a `subprocess` service the test dictates.
 *
 * `plan.spawn` receives the request the provider BUILT (argv, cwd, stdio, env, signal), so the checks
 * below can assert what the provider was about to run; nothing about the provider itself is faked.
 */
function makeProvider(plan = {}, config = {}) {
  const ctx = new Context()
  ctx.provide('subprocess', {
    async resolveExecutable(requested) {
      if (plan.unresolvable === true) throw new Error(`no executable named "${requested}"`)
      return plan.resolved ?? requested
    },
    spawn(request) {
      plan.spawnCalls?.push(request)
      if (plan.spawnThrows !== undefined) throw new Error(plan.spawnThrows)
      return plan.spawn(request)
    },
  })
  return new LocalBlenderRuntime(ctx, ProviderConfig({ workspaceRoot, blenderPath, ...config }))
}

/** The request the provider handed to `spawn`, kept per case so its `cwd` can be checked afterwards. */
let lastRequest = null

/**
 * A subprocess handle that ends the way the case says.
 *
 * `waitForAbort` is what makes the deadline and cancellation cases deterministic: `.done` resolves only
 * once the composed signal aborts, instead of the test sleeping and hoping.
 */
function handleFor({
  exitCode = 0, stdout = '', stderr = '', rejectDone = null, waitForAbort = false,
  result = undefined, resultText = undefined,
} = {}) {
  let request = null
  return {
    attach(value) { request = value },
    handle: {
      get done() {
        if (rejectDone !== null) return Promise.reject(new Error(rejectDone))
        if (waitForAbort) {
          return new Promise(resolve => {
            request.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
          })
        }
        return Promise.resolve({ exitCode, signal: null })
      },
      collected: {
        stdout: { readFrom: () => ({ text: stdout }) },
        stderr: { readFrom: () => ({ text: stderr }) },
      },
    },
    /** Write the result document into the path the provider chose, as bootstrap.py would. */
    writeResult(document) {
      const path = request.argv[request.argv.indexOf('--result') + 1]
      writeFileSync(path, document === undefined ? resultText : JSON.stringify(document, null, 2), 'utf8')
      return path
    },
    workingDirectory: () => request?.cwd,
  }
}

/** Run one case: a provider whose stub writes the result the case wants, and the outcome. */
async function runCase(caseHandle, { config = {}, request = { action: 'probe' }, options = {}, onSpawn } = {}) {
  const plan = {
    spawn: spawned => {
      caseHandle.attach(spawned)
      lastRequest = spawned
      onSpawn?.(caseHandle, spawned)
      return caseHandle.handle
    },
  }
  const provider = makeProvider(plan, config)
  const outcome = await provider.runBootstrap(request, options).catch(cause => cause)
  return { outcome, directory: caseHandle.workingDirectory() }
}

// ---------------------------------------------------------------------------
// The refusals that happen before anything is spawned
// ---------------------------------------------------------------------------

const noAction = await makeProvider({}).runBootstrap({}).catch(cause => cause)
check('a bootstrap call with no action is refused by name, before anything is resolved',
  noAction instanceof BlenderError && noAction.code === code('UNSUPPORTED_ACTION') &&
  noAction.message === 'A bootstrap action name is required.',
  noAction?.message ?? noAction)

const missingBootstrap = await makeProvider({}, { bootstrapPath: join(workspaceRoot, 'not-here.py') })
  .runBootstrap({ action: 'probe' }).catch(cause => cause)
check('a bootstrap script that is not installed is BOOTSTRAP_MISSING, naming the path it looked at',
  missingBootstrap instanceof BlenderError && missingBootstrap.code === code('BOOTSTRAP_MISSING') &&
  missingBootstrap.message === `bootstrap.py not found at ${join(workspaceRoot, 'not-here.py')}.`,
  missingBootstrap?.message ?? missingBootstrap)

const unresolvable = await makeProvider({ unresolvable: true }).runBootstrap({ action: 'probe' }).catch(cause => cause)
check('an executable that cannot be resolved keeps the code the resolver chose, not a generic failure',
  unresolvable instanceof BlenderError && unresolvable.code === code('NOT_FOUND') &&
  /could not be resolved/.test(unresolvable.message),
  unresolvable?.code ?? unresolvable?.message)

// ---------------------------------------------------------------------------
// The spawn itself
// ---------------------------------------------------------------------------

const spawnFailed = await makeProvider({ spawnThrows: 'ENOMEM: cannot allocate the process' })
  .runBootstrap({ action: 'probe' }).catch(cause => cause)
check('a spawn that throws is SPAWN_FAILED naming the executable, with the cause kept',
  spawnFailed instanceof BlenderError && spawnFailed.code === code('SPAWN_FAILED') &&
  spawnFailed.message === `Failed to spawn Blender at ${resolvedBlenderPath}.` && spawnFailed.cause !== undefined,
  spawnFailed?.message ?? spawnFailed)

// ---------------------------------------------------------------------------
// The two ways a run ends early, which must not be confused with each other
// ---------------------------------------------------------------------------

const timed = await runCase(
  handleFor({ waitForAbort: true, stderr: 'the renderer was mid-frame' }),
  { config: { timeoutMs: 60 } },
)
check('a deadline that fires is TIMEOUT, quoting the deadline and the tail of what the process said',
  timed.outcome instanceof BlenderError && timed.outcome.code === code('TIMEOUT') &&
  timed.outcome.message === 'Blender bootstrap exceeded its 60 ms deadline.' &&
  timed.outcome.detail?.stderr === 'the renderer was mid-frame',
  timed.outcome?.message ?? timed.outcome)
check('and the per-invocation working directory is removed on that path',
  timed.directory !== undefined && !existsSync(timed.directory), timed.directory)

const abortController = new AbortController()
const abortPromise = runCase(handleFor({ waitForAbort: true }), {
  config: { timeoutMs: 60_000 },
  options: { signal: abortController.signal },
})
setTimeout(() => abortController.abort(), 20)
const aborted = await abortPromise
check('a CALLER cancellation is ABORTED, not TIMEOUT — the machine is fine and the person changed their mind',
  aborted.outcome instanceof BlenderError && aborted.outcome.code === code('ABORTED') &&
  aborted.outcome.message === 'Blender bootstrap was cancelled by the caller.',
  aborted.outcome?.code ?? aborted.outcome?.message)

const died = await runCase(handleFor({ rejectDone: 'the process was killed by the OOM killer' }))
check('a process that fails to START (its `done` rejects) is SPAWN_FAILED, not a nonzero exit',
  died.outcome instanceof BlenderError && died.outcome.code === code('SPAWN_FAILED') &&
  died.outcome.message === 'Blender bootstrap process failed to start.' && died.outcome.cause !== undefined,
  died.outcome?.message ?? died.outcome)

// ---------------------------------------------------------------------------
// The result document
// ---------------------------------------------------------------------------

const missingDoc = await runCase(handleFor({ exitCode: 0, stderr: 'Segmentation fault' }))
check('exit 0 without a result document is RESULT_MISSING, and the message carries stderr',
  missingDoc.outcome instanceof BlenderError && missingDoc.outcome.code === code('RESULT_MISSING') &&
  /exited with code 0 without writing a result document/.test(missingDoc.outcome.message) &&
  missingDoc.outcome.message.includes('Segmentation fault') && missingDoc.outcome.detail?.exitCode === 0,
  missingDoc.outcome?.message ?? missingDoc.outcome)

const nonzero = await runCase(handleFor({ exitCode: 139, stderr: 'the renderer crashed' }))
check('a nonzero exit without a result document is NONZERO_EXIT, which is a different code',
  nonzero.outcome instanceof BlenderError && nonzero.outcome.code === code('NONZERO_EXIT') &&
  nonzero.outcome.detail?.exitCode === 139,
  nonzero.outcome?.code ?? nonzero.outcome?.message)

const unparseable = await runCase(handleFor({ resultText: 'not json at all' }), {
  onSpawn: handle => handle.writeResult(),
})
check('a result document that is not JSON is RESULT_UNPARSEABLE, with the parse failure as the cause',
  unparseable.outcome instanceof BlenderError && unparseable.outcome.code === code('RESULT_UNPARSEABLE') &&
  unparseable.outcome.cause !== undefined,
  unparseable.outcome?.message ?? unparseable.outcome)

const mismatch = await runCase(handleFor(), {
  onSpawn: handle => handle.writeResult({ protocolVersion: 'deepblend.blender/v0', status: 'ok' }),
})
check('a result in another protocol version is refused with BOTH versions in the message',
  mismatch.outcome instanceof BlenderError && mismatch.outcome.code === code('PROTOCOL_VERSION_MISMATCH') &&
  mismatch.outcome.message === 'bootstrap.py reported protocolVersion "deepblend.blender/v0", expected "deepblend.blender/v1".',
  mismatch.outcome?.message ?? mismatch.outcome)

/**
 * The codes bootstrap.py actually reports, and where each one lives in the contract space.
 *
 * These four are not invented for the test: `SCENE_VALIDATION_FAILED` appears at 27 sites in
 * `python/`, `REVISION_CHECKPOINT_MISSING` at 5, `SCENE_CAMERA_MISSING` at 3, and
 * `UNSUPPORTED_ACTION` at 5. The first three are DOMAIN codes whose contract spelling has no
 * `BLENDER_` prefix — and the normaliser used to prefix them anyway, so the product's most common
 * bootstrap failure reached the model as `BLENDER_SCENE_VALIDATION_FAILED`, a code that does not exist.
 */
const bootstrapCodes = [
  ['UNSUPPORTED_ACTION', 'UNSUPPORTED_ACTION', 'the Blender family keeps its prefix'],
  ['SCENE_VALIDATION_FAILED', 'SCENE_VALIDATION_FAILED', 'a domain code stays unprefixed'],
  ['REVISION_CHECKPOINT_MISSING', 'REVISION_CHECKPOINT_MISSING', 'and so does this one'],
  ['SCENE_CAMERA_MISSING', 'SCENE_CAMERA_MISSING', 'and this one'],
]
const producedCodes = []
for (const [reported, expected, why] of bootstrapCodes) {
  const outcome = await runCase(handleFor(), {
    request: { action: 'validate' },
    onSpawn: handle => handle.writeResult({
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      status: 'error',
      error: { code: reported, message: `bootstrap.py said ${reported}` },
    }),
  })
  producedCodes.push(outcome.outcome?.code)
  check(`an envelope reporting ${reported} becomes the contract's own code (${why})`,
    outcome.outcome instanceof BlenderError && outcome.outcome.code === code(expected) &&
    outcome.outcome.message === `bootstrap.py said ${reported}`,
    outcome.outcome?.code ?? outcome.outcome?.message)
}

const unknownCode = await runCase(handleFor(), {
  onSpawn: handle => handle.writeResult({
    protocolVersion: BLENDER_PROTOCOL_VERSION,
    status: 'error',
    error: { code: 'NOT_A_CODE_THIS_BUILD_KNOWS', message: 'something new happened' },
  }),
})
check('an error code this build does not know becomes SCRIPT_ERROR, not an invented code',
  unknownCode.outcome instanceof BlenderError &&
  unknownCode.outcome.code === code('SCRIPT_ERROR') &&
  unknownCode.outcome.message === 'something new happened',
  unknownCode.outcome?.code ?? unknownCode.outcome?.message)
producedCodes.push(unknownCode.outcome?.code)

check('every code the normaliser produced here is a code the contract defines',
  // One per bootstrap code, plus the unknown one that must fall back to SCRIPT_ERROR.
  producedCodes.length === bootstrapCodes.length + 1 &&
  producedCodes.every(entry => Object.values(BlenderErrorCode).includes(entry)),
  producedCodes)

// ---------------------------------------------------------------------------
// A run that works, and the window it gives the caller
// ---------------------------------------------------------------------------

const order = []
let directoryStillThereInHook = false
let hookEnvelope = null
let requestDocumentInWindow = null
const successCase = handleFor({ stdout: 'blender said this', stderr: 'a warning from blender' })
const success = await runCase(successCase, {
  request: { action: 'compile_scene', jobId: 'render-0007', payload: { profile: 'preview' } },
  options: {
    prepareDirectory: async ({ directory }) => { order.push(['prepare', existsSync(join(directory, 'request.json'))]) },
    onWorkingDirectory: async ({ directory, envelope }) => {
      order.push(['window', existsSync(directory)])
      directoryStillThereInHook = existsSync(directory)
      hookEnvelope = envelope
      requestDocumentInWindow = JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'))
    },
  },
  onSpawn: handle => handle.writeResult({
    protocolVersion: BLENDER_PROTOCOL_VERSION,
    status: 'ok',
    action: 'compile_scene',
    result: { checkpoint: 'scene.blend' },
  }),
})

check('a successful bootstrap returns the envelope, both streams, the exit code and how long it took',
  success.outcome?.envelope?.result?.checkpoint === 'scene.blend' &&
  success.outcome.stdout === 'blender said this' && success.outcome.stderr === 'a warning from blender' &&
  success.outcome.exitCode === 0 && typeof success.outcome.durationMs === 'number' &&
  typeof success.outcome.workingDirectory === 'string',
  { exitCode: success.outcome?.exitCode, envelope: success.outcome?.envelope?.action })
check('the caller\'s window into the working directory is opened BEFORE the cleanup, with the envelope in hand',
  directoryStillThereInHook === true && hookEnvelope?.status === 'ok',
  { directoryStillThereInHook, status: hookEnvelope?.status })
check('`prepareDirectory` runs BEFORE the request document exists, which is what a view plan needs',
  JSON.stringify(order[0]) === JSON.stringify(['prepare', false]) &&
  JSON.stringify(order[1]) === JSON.stringify(['window', true]),
  order)
check('and the request document it wrote carries the protocol version, the action, the caller\'s job id and its payload',
  requestDocumentInWindow?.protocolVersion === BLENDER_PROTOCOL_VERSION &&
  requestDocumentInWindow?.action === 'compile_scene' &&
  requestDocumentInWindow?.jobId === 'render-0007' &&
  requestDocumentInWindow?.payload?.profile === 'preview',
  requestDocumentInWindow)
check('the working directory is gone once the call returns',
  success.outcome?.workingDirectory !== undefined && !existsSync(success.outcome.workingDirectory),
  success.outcome?.workingDirectory)

const keptCase = handleFor()
const kept = await runCase(keptCase, {
  config: { keepWorkingDirectory: true },
  onSpawn: handle => handle.writeResult({ protocolVersion: BLENDER_PROTOCOL_VERSION, status: 'ok' }),
})
check('an operator who asked to KEEP the working directory still has it afterwards',
  kept.outcome?.workingDirectory !== undefined && existsSync(kept.outcome.workingDirectory),
  kept.outcome?.workingDirectory)
if (kept.outcome?.workingDirectory !== undefined) rmSync(kept.outcome.workingDirectory, { recursive: true, force: true })

// The argv is the product's statement about how Blender is invoked (SPEC §9.2: an array, no shell).
check('the argv is an array that runs Blender headless with the factory startup and the bootstrap script',
  Array.isArray(lastRequest?.argv) &&
  lastRequest.argv[0] === resolvedBlenderPath &&
  JSON.stringify(lastRequest.argv.slice(1, 4)) === JSON.stringify(['--background', '--factory-startup', '--python']) &&
  lastRequest.argv[4].endsWith(join('python', 'bootstrap.py')) &&
  // `--` ends Blender's own options, so everything after it belongs to the script.
  lastRequest.argv[5] === '--' &&
  lastRequest.argv.includes('--request') && lastRequest.argv.includes('--result') &&
  lastRequest.argv[lastRequest.argv.indexOf('--request') + 1].endsWith('request.json') &&
  lastRequest.argv[lastRequest.argv.indexOf('--result') + 1].endsWith('result.json'),
  lastRequest?.argv)

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nProvider bootstrap: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
