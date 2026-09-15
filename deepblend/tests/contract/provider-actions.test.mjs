#!/usr/bin/env node
/**
 * The provider's action surface: what each Blender action refuses before it launches anything, and how
 * an engine key becomes the engine Blender will actually use.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Round 50 drove `runBootstrap`, the door every action goes through. What is left dark in this package
 * are the ten refusals at the TOP of the actions themselves — a missing checkpoint path, an empty frame
 * list, a view with no id, a SceneSpec path that is not a path — plus `resolveEngineKey`, which decides
 * which engine a render will really use, and the warnings a capability probe derives from a probe
 * result. None of them needs Blender: the refusals happen before the spawn, and the engine decision
 * reads a capabilities document the stub writes.
 *
 * THE THREE THAT ARE WORTH READING CAREFULLY:
 *
 *   - **an empty frame list is refused**, and the message says why: it "would report success while
 *     writing nothing". That is the difference between a delivery that is empty and one that is wrong.
 *   - **an engine that is not assignable is downgraded WITH a warning naming both engines**, and when
 *     nothing is assignable the refusal is `ENGINE_UNAVAILABLE` rather than a render that fails later.
 *     Blender 5.2.1's trap — an engine that is assignable but absent from the static enum — is warned
 *     about separately, because availability must be decided behaviorally (D1).
 *   - every refusal here is a CODE, because the caller is a model deciding what to do next.
 *
 * Run standalone: `node deepblend/tests/contract/provider-actions.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BlenderError, BlenderErrorCode, BLENDER_PROTOCOL_VERSION, CANDIDATE_RENDER_ENGINES,
  EXPECTED_EXPORT_FORMATS, EXPECTED_IMPORT_FORMATS,
} from '@deepblend/dsh-blender-contracts'
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

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-actions-'))
const blenderPath = join(workspaceRoot, 'fake-blender')
writeFileSync(blenderPath, '#!/bin/sh\nexit 0\n')
chmodSync(blenderPath, 0o755)
const resolvedBlenderPath = realpathSync(blenderPath)

const checkpointPath = join(workspaceRoot, 'scene.blend')
writeFileSync(checkpointPath, 'not really a blend file')
const specPath = join(workspaceRoot, 'scene-spec.json')
writeFileSync(specPath, '{}')
const jobDirectory = join(workspaceRoot, 'job')
const { mkdirSync } = await import('node:fs')
mkdirSync(jobDirectory, { recursive: true })

/**
 * A provider whose capabilities the test dictates, over a stub `subprocess`.
 *
 * `capabilities` is what bootstrap.py would report under `envelope.capabilities`; `undefined` means the
 * probe answers an empty document. Everything else about the provider is the real thing.
 */
function makeProvider({ capabilities = {}, unresolvable = false, spawned } = {}) {
  const ctx = new Context()
  ctx.provide('subprocess', {
    async resolveExecutable(requested) {
      if (unresolvable) throw new Error(`no executable named "${requested}"`)
      return requested
    },
    spawn(request) {
      spawned?.push(request)
      // A stub that spawns but writes nothing is refused by `runBootstrap` with RESULT_MISSING — which
      // is the guard doing its job: the process reported success and produced no answer. This one
      // writes the envelope where the provider asked for it, as bootstrap.py does.
      writeFileSync(
        request.argv[request.argv.indexOf('--result') + 1],
        JSON.stringify({ protocolVersion: BLENDER_PROTOCOL_VERSION, status: 'ok' }),
        'utf8',
      )
      return {
        get done() { return Promise.resolve({ exitCode: 0, signal: null }) },
        collected: {
          stdout: { readFrom: () => ({ text: '' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  })
  const provider = new LocalBlenderRuntime(ctx, ProviderConfig({ workspaceRoot, blenderPath }))
  // The probe's answer is written when the capability action runs, exactly as bootstrap.py does.
  const original = provider.runBootstrap.bind(provider)
  provider.runBootstrap = async (request, options) => {
    const run = await original(request, options)
    if (request?.action === 'get_capabilities') {
      run.envelope = { ...run.envelope, capabilities }
    }
    return run
  }
  return provider
}

// ---------------------------------------------------------------------------
// The refusals, which all happen before anything is launched
// ---------------------------------------------------------------------------

const refusals = [
  ['compileScene', { sceneSpecPath: '' }, 'SCENE_SPEC_INVALID', 'compileScene needs an absolute path to a SceneSpec document.'],
  ['renderPreview', {}, 'REVISION_CHECKPOINT_MISSING', 'renderPreview needs an absolute path to a .blend checkpoint.'],
  ['renderPreview', { checkpointPath }, 'RENDER_NO_OUTPUT', 'renderPreview needs an absolute output path.'],
  ['renderViews', {}, 'REVISION_CHECKPOINT_MISSING', 'renderViews needs an absolute path to a .blend checkpoint.'],
  ['startFrameSequence', {}, 'REVISION_CHECKPOINT_MISSING', 'startFrameSequence needs an absolute path to a .blend checkpoint.'],
  ['startFrameSequence', { checkpointPath, frames: [] }, 'SCRIPT_ERROR', 'startFrameSequence needs at least one frame to render; an empty frame list would report success while writing nothing.'],
  ['startFrameSequence', { checkpointPath, frames: [1], jobDirectory: '' }, 'SCRIPT_ERROR', 'startFrameSequence needs a persistent job directory to render into.'],
]

for (const [method, request, expected, message] of refusals) {
  const provider = makeProvider({ spawned: [] })
  const outcome = await provider[method](request).catch(cause => cause)
  check(`${method} refuses that request with ${expected}`,
    outcome instanceof BlenderError && outcome.code === code(expected) && outcome.message === message,
    outcome?.code === undefined ? outcome : `${outcome.code}: ${outcome.message}`)
}

const noCheckpointViews = await makeProvider().renderViews({ checkpointPath, views: [{ role: 'top' }] }).catch(cause => cause)
check('renderViews refuses a view with no id, because a plan whose cells cannot be named cannot be read back',
  noCheckpointViews instanceof BlenderError && noCheckpointViews.code === code('SCRIPT_ERROR') &&
  noCheckpointViews.message === 'every view in a render plan needs an id.',
  noCheckpointViews?.message ?? noCheckpointViews)

const noScript = new LocalBlenderRuntime(
  (() => { const ctx = new Context(); ctx.provide('subprocess', { async resolveExecutable(r) { return r }, spawn() { throw new Error('must not spawn') } }); return ctx })(),
  ProviderConfig({ workspaceRoot, blenderPath, bootstrapPath: join(workspaceRoot, 'absent.py') }),
)
const missingScript = await noScript.startFrameSequence({ checkpointPath, frames: [1], jobDirectory }).catch(cause => cause)
check('startFrameSequence refuses when bootstrap.py is not installed, before it resolves anything',
  missingScript instanceof BlenderError && missingScript.code === code('BOOTSTRAP_MISSING') &&
  missingScript.message === `bootstrap.py not found at ${join(workspaceRoot, 'absent.py')}.`,
  missingScript?.message ?? missingScript)

const noBlender = makeProvider({ unresolvable: true })
const unresolvable = await noBlender.startFrameSequence({ checkpointPath, frames: [1], jobDirectory }).catch(cause => cause)
check('startFrameSequence refuses when the executable cannot be resolved, keeping the resolver\'s code',
  unresolvable instanceof BlenderError && unresolvable.code === code('NOT_FOUND') &&
  /could not be resolved/.test(unresolvable.message),
  unresolvable?.code ?? unresolvable?.message)

// ---------------------------------------------------------------------------
// Which engine a render will really use
// ---------------------------------------------------------------------------

const unknownEngine = await makeProvider().resolveEngineKey('not-an-engine').catch(cause => cause)
check('an engine key that is not a SceneSpec engine is refused, listing the keys that are',
  unknownEngine instanceof BlenderError && unknownEngine.code === code('RENDER_PROFILE_MISSING') &&
  unknownEngine.message === '"not-an-engine" is not a SceneSpec render engine; expected one of eevee, cycles, workbench.',
  unknownEngine?.message ?? unknownEngine)

const absent = await makeProvider({ unresolvable: true }).resolveEngineKey('cycles')
check('a machine with no Blender resolves to NO engine and no downgrade, because there is nothing to downgrade from',
  absent.blenderEngine === null && absent.requested === 'CYCLES' && absent.downgraded === false && absent.warning === null,
  absent)

const assignable = await makeProvider({
  capabilities: { renderEngines: Object.fromEntries(CANDIDATE_RENDER_ENGINES.map(id => [id, { assignable: true, readback: 'CYCLES' }])) },
}).resolveEngineKey('cycles')
check('an engine this build can assign is used as asked, with no warning',
  assignable.blenderEngine === 'CYCLES' && assignable.downgraded === false && assignable.warning === null,
  assignable)

const downgraded = await makeProvider({
  capabilities: {
    renderEngines: Object.fromEntries(CANDIDATE_RENDER_ENGINES.map(id => [id, { assignable: id !== 'CYCLES', readback: null }])),
  },
}).resolveEngineKey('cycles')
check('an engine that is NOT assignable is downgraded, and the warning names both engines',
  downgraded.blenderEngine === 'BLENDER_EEVEE' && downgraded.requested === 'CYCLES' && downgraded.downgraded === true &&
  downgraded.warning?.code === 'ENGINE_DOWNGRADED' &&
  downgraded.warning.message === 'engine "cycles" (CYCLES) is not assignable in this Blender build; BLENDER_EEVEE will be used instead',
  downgraded.warning ?? downgraded)

const nothingAssignable = await makeProvider({
  capabilities: { renderEngines: Object.fromEntries(CANDIDATE_RENDER_ENGINES.map(id => [id, { assignable: false, readback: null }])) },
}).resolveEngineKey('cycles').catch(cause => cause)
check('a build where NOTHING is assignable refuses with ENGINE_UNAVAILABLE rather than rendering with a guess',
  nothingAssignable instanceof BlenderError && nothingAssignable.code === code('ENGINE_UNAVAILABLE') &&
  nothingAssignable.message === `none of ${CANDIDATE_RENDER_ENGINES.join(', ')} is assignable in this Blender build.`,
  nothingAssignable?.message ?? nothingAssignable)

// ---------------------------------------------------------------------------
// The warnings a probe result turns into
// ---------------------------------------------------------------------------

const probeWarnings = async capabilities => (await makeProvider({ capabilities }).getCapabilities()).warnings
const codesOf = warnings => warnings.map(entry => entry.code)

const empty = await probeWarnings({})
check('a build with no GPU says rendering will use the CPU, and a missing Cycles says what falls back',
  codesOf(empty).includes('GPU_UNAVAILABLE') && codesOf(empty).includes('ENGINE_UNAVAILABLE') &&
  empty.find(entry => entry.code === 'ENGINE_UNAVAILABLE').message.includes('render profiles requesting CYCLES will be downgraded'),
  codesOf(empty))

const withGpuAndCycles = await probeWarnings({
  renderEngines: Object.fromEntries(CANDIDATE_RENDER_ENGINES.map(id => [id, { assignable: true, readback: 'CYCLES' }])),
  gpuDevices: { gpuDeviceNames: ['Apple M1 Max'], availableBackends: ['METAL'] },
  importFormats: [...EXPECTED_IMPORT_FORMATS],
  exportFormats: [...EXPECTED_EXPORT_FORMATS],
})
check('a build with a GPU and every format reports no warning for them',
  !codesOf(withGpuAndCycles).includes('GPU_UNAVAILABLE') &&
  !codesOf(withGpuAndCycles).includes('ENGINE_UNAVAILABLE') &&
  !codesOf(withGpuAndCycles).includes('FORMAT_UNAVAILABLE'),
  codesOf(withGpuAndCycles))

const enumTrap = await probeWarnings({
  // `BLENDER_EEVEE` is assignable but NOT in the build's static enum — exactly the 5.2.1 trap. The
  // candidates are `CANDIDATE_RENDER_ENGINES`; an id outside that list is not probed at all.
  renderEngines: { CYCLES: { assignable: true, readback: 'CYCLES' }, BLENDER_EEVEE: { assignable: true, readback: 'EEVEE' } },
  renderEngineDiagnostics: { engineEnumItemsInformational: { identifiers: ['CYCLES'] } },
  gpuDevices: { gpuDeviceNames: ['Apple M1 Max'], availableBackends: ['METAL'] },
  importFormats: [...EXPECTED_IMPORT_FORMATS],
  exportFormats: [...EXPECTED_EXPORT_FORMATS],
})
check('the Blender 5.2.1 trap — assignable but missing from the static enum — is warned about by name',
  codesOf(enumTrap).includes('ENGINE_NOT_IN_STATIC_ENUM') &&
  enumTrap.find(entry => entry.code === 'ENGINE_NOT_IN_STATIC_ENUM').message.includes('Availability must be decided behaviorally'),
  codesOf(enumTrap))

const formats = await probeWarnings({
  renderEngines: Object.fromEntries(CANDIDATE_RENDER_ENGINES.map(id => [id, { assignable: true, readback: 'CYCLES' }])),
  gpuDevices: { gpuDeviceNames: ['Apple M1 Max'], availableBackends: ['METAL'] },
  importFormats: [],
  exportFormats: [],
})
check('every format this build cannot offer is reported per format, in both directions',
  formats.filter(entry => entry.code === 'FORMAT_UNAVAILABLE' && entry.detail?.direction === 'import').length === EXPECTED_IMPORT_FORMATS.length &&
  formats.filter(entry => entry.code === 'FORMAT_UNAVAILABLE' && entry.detail?.direction === 'export').length === EXPECTED_EXPORT_FORMATS.length &&
  formats.every(entry => entry.code !== 'FORMAT_UNAVAILABLE' || typeof entry.detail?.format === 'string'),
  formats.filter(entry => entry.code === 'FORMAT_UNAVAILABLE').map(entry => `${entry.detail.direction}:${entry.detail.format}`))

const reported = await probeWarnings({ warnings: ['the addon could not be enabled', ''] })
check('warnings bootstrap.py reports are passed through verbatim under one generic code, and a blank one is dropped',
  reported.filter(entry => entry.code === 'PROBE_WARNING').length === 1 &&
  reported.find(entry => entry.code === 'PROBE_WARNING').message === 'the addon could not be enabled',
  codesOf(reported))

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nProvider actions: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
