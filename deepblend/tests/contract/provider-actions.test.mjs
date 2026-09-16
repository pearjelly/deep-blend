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
 * AND THE ENDS OF A RENDER, which the M3 acceptance only ever sees from a healthy machine: a spawn that
 * throws (`SPAWN_FAILED`, naming the executable that was never started), a child that dies without leaving
 * a usable result document and captured no output at all (reported as DATA — `envelope: null`, empty
 * streams, the rejection kept — because the caller has to fold all three into one job record), the
 * capability cache and what `dispose()` does to it, and a diagnostics document of the wrong SHAPE, where
 * the rule is "answer an empty list" rather than letting a string decide `gpuAvailable`.
 *
 * Run standalone: `node deepblend/tests/contract/provider-actions.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
mkdirSync(jobDirectory, { recursive: true })

/**
 * A provider whose capabilities the test dictates, over a stub `subprocess`.
 *
 * `capabilities` is what bootstrap.py would report under `envelope.capabilities`; `undefined` means the
 * probe answers an empty document. Everything else about the provider is the real thing.
 */
function makeProvider({
  capabilities = {}, unresolvable = false, spawned, spawnThrows,
  doneRejects, resultText, withCollected = true, writeProcessIdentity = true,
} = {}) {
  const ctx = new Context()
  ctx.provide('subprocess', {
    async resolveExecutable(requested) {
      if (unresolvable) throw new Error(`no executable named "${requested}"`)
      return requested
    },
    spawn(request) {
      spawned?.push(request)
      if (spawnThrows !== undefined) throw new Error(spawnThrows)
      // A stub that spawns but writes nothing is refused by `runBootstrap` with RESULT_MISSING — which
      // is the guard doing its job: the process reported success and produced no answer. This one
      // writes the envelope where the provider asked for it, as bootstrap.py does.
      writeFileSync(
        request.argv[request.argv.indexOf('--result') + 1],
        resultText ?? JSON.stringify({ protocolVersion: BLENDER_PROTOCOL_VERSION, status: 'ok' }),
        'utf8',
      )
      if (writeProcessIdentity === false) {
        // The stub writes an identity document by default (`writeProcessIdentity: false` is how a case opts
        // out). It must not THROW when the path is a directory: one case deliberately puts a non-empty
        // directory where the file belongs, which is the shape the provider's own best-effort clear refuses.
        try {
          rmSync(join(request.jobDirectory, 'process.json'), { force: true })
        } catch {
          /* the case that needs this is the one where it cannot be removed */
        }
      }
      return {
        get done() {
          return doneRejects === undefined
            ? Promise.resolve({ exitCode: 0, signal: null })
            : Promise.reject(new Error(doneRejects))
        },
        // `withCollected: false` is a handle that captured NOTHING — no readers at all, which is what a
        // stub (or a spawn that failed after handing back a handle) looks like.
        collected: withCollected
          ? {
              stdout: { readFrom: () => ({ text: '' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            }
          : undefined,
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
// Two stale/partial states a resumed render really meets
// ---------------------------------------------------------------------------

// A RESUMED attempt must not inherit the previous one's files, and the clearing of them is best-effort: a
// `process.json` that cannot be removed (here a non-empty DIRECTORY standing where the file belongs — the one
// shape `rmSync(..., { force: true })` refuses without `recursive`) must not refuse the render. The ledger is
// derived from the frames, so a stale identity document is a diagnostic problem, not a correctness one.
{
  const staleDirectory = join(jobDirectory, 'process.json')
  mkdirSync(staleDirectory, { recursive: true })
  writeFileSync(join(staleDirectory, 'still-here.txt'), 'not a file the provider can unlink', 'utf8')
  const provider = makeProvider({ writeProcessIdentity: false, spawned: [] })
  const run = await provider.startFrameSequence({
    checkpointPath, frames: [1], jobDirectory, jobId: 'stale-process-identity',
  }).catch(cause => cause)
  const survived = run?.handle !== undefined && run?.jobDirectory === jobDirectory
  rmSync(staleDirectory, { recursive: true, force: true })
  check('a stale identity document that cannot be cleared does not refuse the render',
    survived, run instanceof BlenderError ? `${run.code}: ${run.message}` : Object.keys(run ?? {}).slice(0, 4))
}

// A render report may name a view whose bytes cannot be read back (a file removed between the render and the
// read, or a path the renderer never wrote). The other views must survive: discarding the whole plan would
// throw away the views that DID render, and the report already says which one is missing.
{
  const presentView = join(workspaceRoot, 'view-present.png')
  writeFileSync(presentView, 'the bytes of one view', 'utf8')
  const provider = makeProvider({
    spawned: [],
    resultText: JSON.stringify({
      protocolVersion: BLENDER_PROTOCOL_VERSION,
      status: 'ok',
      result: {
        views: [
          { viewId: 'present', outputPath: presentView },
          { viewId: 'missing', outputPath: join(workspaceRoot, 'never-written.png') },
        ],
      },
    }),
  })
  const rendered = await provider.renderViews({
    checkpointPath, views: [{ id: 'present', role: 'three-quarter' }, { id: 'missing', role: 'top' }], jobDirectory,
  }).catch(cause => cause)
  check('a view whose bytes cannot be read is skipped, and the views that DID render survive',
    rendered?.pngs?.present?.toString('utf8') === 'the bytes of one view' &&
    rendered.pngs.missing === undefined && rendered.report.views.length === 2,
    rendered instanceof BlenderError ? `${rendered.code}: ${rendered.message}` : Object.keys(rendered?.pngs ?? {}))
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

// ---------------------------------------------------------------------------
// A resolver that answers "no path, no error" — the port's own contract
// ---------------------------------------------------------------------------
//
// `resolveBlenderExecutable` documents `{ resolved: string|null, requested, error: BlenderError|null }` and
// does not promise that the two are linked. Both entry points therefore carry the same defensive sentence:
// "no path AND no error" is refused with a NAMED code rather than by dereferencing `null` somewhere later.
// The real method never produces it (its catch always builds an error), which is why this is driven through
// the port itself — the same technique as injecting a store or a reviewer, and the only way to stand on a
// branch whose whole job is to survive an answer the current implementation does not give.
const inconsistent = makeProvider({ spawned: [] })
inconsistent.resolveBlenderExecutable = async () => ({ resolved: null, requested: 'blender', error: null })
const unresolvedBootstrap = await inconsistent.runBootstrap({ action: 'probe' }).catch(cause => cause)
const unresolvedFrames = await inconsistent
  .startFrameSequence({ checkpointPath, frames: [1], jobDirectory, jobId: 'no-path' })
  .catch(cause => cause)
check('both entry points refuse "no path and no error" by name instead of dereferencing nothing',
  unresolvedBootstrap instanceof BlenderError && unresolvedBootstrap.code === code('NOT_FOUND') &&
  unresolvedBootstrap.message === 'Blender executable could not be resolved from "blender".' &&
  unresolvedFrames instanceof BlenderError && unresolvedFrames.code === code('NOT_FOUND') &&
  unresolvedFrames.message === 'Blender executable could not be resolved from "blender".',
  { bootstrap: unresolvedBootstrap?.message, frames: unresolvedFrames?.message })

// ---------------------------------------------------------------------------
// A spawn that never happens, a child that dies silently, and the cache
// ---------------------------------------------------------------------------

const refusedSpawn = makeProvider({ spawnThrows: 'ENOMEM: cannot allocate the process', spawned: [] })
const spawnFailure = await refusedSpawn
  .startFrameSequence({ checkpointPath, frames: [1], jobDirectory, jobId: 'spawn-failure' })
  .catch(cause => cause)
check('a spawn that throws becomes SPAWN_FAILED, naming the executable that was never started',
  spawnFailure instanceof BlenderError && spawnFailure.code === code('SPAWN_FAILED') &&
  spawnFailure.message === `Failed to spawn Blender at ${resolvedBlenderPath}.` &&
  String(spawnFailure.cause?.message ?? '') === 'ENOMEM: cannot allocate the process',
  { code: spawnFailure?.code, message: spawnFailure?.message })

// A child that dies without leaving a usable document AND captured no output: what the Host has to fold
// into a job record afterwards. Three facts at once — the rejection is data, the unreadable result is
// "no envelope" rather than a parse error, and missing readers answer empty rather than throwing.
const silent = makeProvider({
  doneRejects: 'the child was killed before it reported',
  resultText: 'this is not json at all',
  withCollected: false,
  spawned: [],
})
const silentRun = await silent.startFrameSequence({ checkpointPath, frames: [1], jobDirectory, jobId: 'silent-child' })
const silentOutcome = await silent.awaitFrameSequence(silentRun)
check('a child that dies silently is reported as data: no envelope, no output, and the failure kept',
  silentOutcome.envelope === null && silentOutcome.exitCode === null && silentOutcome.signal === null &&
  silentOutcome.stdout === '' && silentOutcome.stderr === '' &&
  String(silentOutcome.spawnFailure?.message ?? '') === 'the child was killed before it reported',
  { envelope: silentOutcome.envelope, exitCode: silentOutcome.exitCode, spawnFailure: String(silentOutcome.spawnFailure?.message ?? null) })

// The capability cache is what keeps a probe from launching Blender on every tool call, and `dispose()`
// is how a Host that is going away drops it. Both directions are measured by counting spawns.
const probeSpawns = []
const cached = makeProvider({ spawned: probeSpawns })
const firstProbe = await cached.getCapabilities({ refresh: true })
const afterFirstProbe = probeSpawns.length
await cached.getCapabilities({})
const afterCachedRead = probeSpawns.length
cached.dispose()
const afterDispose = await cached.getCapabilities({})
check('a probed capability is served from the cache, and dispose() empties it so the next call probes again',
  afterFirstProbe === 1 && afterCachedRead === 1 && probeSpawns.length === 2 &&
  afterDispose.probedAt >= firstProbe.probedAt && afterDispose.installed === true,
  { spawnsAfterFirstProbe: afterFirstProbe, spawnsAfterCachedRead: afterCachedRead, spawnsAfterDispose: probeSpawns.length })

// A diagnostics document of the wrong SHAPE is a real possibility across Blender builds. The rule is
// "answer an empty list", never "pass the nonsense through": a string where a device list belongs would
// otherwise reach `gpuAvailable`, and "has a GPU" would be decided by the truthiness of a word.
const oddShape = makeProvider({
  capabilities: {
    gpuDevices: { availableBackends: 'gpu', gpuDeviceNames: 'Apple M1 Max', cpuDeviceNames: 8 },
    renderEngineDiagnostics: { engineEnumItemsInformational: { identifiers: 'CYCLES' } },
  },
})
const oddCapabilities = await oddShape.getCapabilities({ refresh: true })
check('a diagnostics document of the wrong shape answers empty lists instead of passing the nonsense through',
  oddCapabilities.gpu.gpuDeviceNames.length === 0 && oddCapabilities.gpu.cpuDeviceNames.length === 0 &&
  oddCapabilities.gpu.availableBackends.length === 0 && oddCapabilities.renderEngineEnumItems.length === 0 &&
  oddCapabilities.gpuAvailable === false,
  { gpu: oddCapabilities.gpu, enumItems: oddCapabilities.renderEngineEnumItems, gpuAvailable: oddCapabilities.gpuAvailable })

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
