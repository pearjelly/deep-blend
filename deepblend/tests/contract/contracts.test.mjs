/**
 * M0 contract tests — `@deepblend/dsh-blender-contracts`.
 *
 * These are pure unit tests: no Blender, no subprocess, no network. They pin the
 * wire vocabulary the model, the tool and the settings card all branch on, plus
 * the canonical projection used by both surfaces.
 *
 * About the fixture: `deepblend/fixtures/blender/capabilities.sample.json` is a
 * capture of the **output** of `toCanonicalCapabilities()` (the document the
 * `blender_capabilities` tool returns and `buildSettingsCard()` renders). To
 * exercise the projection itself, `providerProbeFromCanonical()` below inverts
 * that document back into the provider's `BlenderCapabilities` probe shape, and
 * the round trip is asserted to reproduce the fixture byte-for-byte. That keeps
 * both directions of the contract under test: a field renamed on either side
 * breaks this file.
 *
 * Run standalone: `node deepblend/tests/contract/contracts.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BLENDER_PROTOCOL_VERSION,
  CANDIDATE_RENDER_ENGINES,
  EXPECTED_EXPORT_FORMATS,
  EXPECTED_IMPORT_FORMATS,
  BlenderError,
  BlenderErrorCode,
  isBlenderError,
  toCanonicalCapabilities,
  warning,
} from '@deepblend/dsh-blender-contracts'

/** Resolved relative to this file, never an absolute path, so any cwd works. */
export const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'blender',
  'capabilities.sample.json',
)

/** @param {string} [path] */
export function loadFixture(path = FIXTURE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * The declared key order of `toCanonicalCapabilities()` output (SPEC §19.5:
 * deterministic serialization so transcripts and tests can diff cleanly).
 */
export const CANONICAL_KEYS = [
  'protocolVersion',
  'installed',
  'executable',
  'version',
  'versionTuple',
  'pythonVersion',
  'buildHash',
  'binaryPath',
  'engines',
  'bestAvailableEngine',
  'engineEnumItems',
  'gpu',
  'formats',
  'renderSmokeTest',
  'cyclesSmokeTest',
  'api',
  'hostPlatform',
  'warnings',
  'probedAt',
  'durationMs',
]

/**
 * Invert a canonical document back into the provider's `BlenderCapabilities`
 * probe shape.
 *
 * The provider (and `bootstrap.py` before it) speaks the *probe* vocabulary —
 * `renderEngines[].assignable`, `gpu.gpuDeviceNames`, `gpuAvailable`,
 * `importFormats`, `renderEngineEnumItems`. `toCanonicalCapabilities()` maps it
 * onto the *consumer* vocabulary. This helper is the exact inverse of that map,
 * so `toCanonicalCapabilities(providerProbeFromCanonical(fixture))` must equal
 * the fixture.
 *
 * @param {Record<string, any>} doc canonical capabilities
 * @returns {Record<string, any>} provider probe result
 */
export function providerProbeFromCanonical(doc) {
  return {
    protocolVersion: doc.protocolVersion,
    installed: doc.installed,
    executable: {
      requested: doc.executable.requested,
      resolved: doc.executable.resolved,
      found: doc.executable.found,
    },
    blenderVersion: doc.version,
    blenderVersionTuple: doc.versionTuple,
    pythonVersion: doc.pythonVersion,
    buildHash: doc.buildHash,
    binaryPath: doc.binaryPath,
    renderEngines: Object.fromEntries(
      Object.entries(doc.engines).map(([id, engine]) => [
        id,
        { assignable: engine.available, readback: engine.readback, error: engine.error },
      ]),
    ),
    bestAvailableEngine: doc.bestAvailableEngine,
    // The provider keeps the enum under its own probe-only name.
    renderEngineEnumItems: doc.engineEnumItems,
    gpu: {
      availableBackends: doc.gpu.backends,
      preferredBackend: doc.gpu.preferredBackend,
      gpuDeviceNames: doc.gpu.devices,
      cpuDeviceNames: doc.gpu.cpuDevices,
      backendSupport: doc.gpu.backendSupport,
    },
    // Derived by the provider from the GPU device list; canonical exposes it as
    // `gpu.available`.
    gpuAvailable: doc.gpu.available,
    exportFormats: doc.formats.export,
    importFormats: doc.formats.import,
    unavailableFormats: doc.formats.unavailable,
    renderSmokeTest: doc.renderSmokeTest,
    cyclesSmokeTest: doc.cyclesSmokeTest,
    textBlockApi: doc.api.textBlocks,
    frameApi: doc.api.frameRange,
    hostPlatform: doc.hostPlatform,
    warnings: doc.warnings,
    probedAt: doc.probedAt,
    durationMs: doc.durationMs,
    // Dropped by the projection: audit-only, never part of the canonical view.
    commandLine: null,
  }
}

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

test('the fixture is a canonical-capabilities document in the declared key order', () => {
  const fixture = loadFixture()
  assert.deepEqual(Object.keys(fixture), CANONICAL_KEYS)
  assert.deepEqual(Object.keys(fixture.executable), ['requested', 'resolved', 'found'])
  assert.deepEqual(
    Object.keys(fixture.gpu),
    ['available', 'backends', 'preferredBackend', 'devices', 'cpuDevices', 'backendSupport'],
  )
  assert.deepEqual(Object.keys(fixture.formats), ['import', 'export', 'unavailable'])
  assert.deepEqual(Object.keys(fixture.api), ['textBlocks', 'frameRange'])
  assert.equal(fixture.installed, true)
  assert.equal(typeof fixture.probedAt, 'number')
  assert.equal(typeof fixture.durationMs, 'number')
  assert.equal(fixture.hostPlatform, 'darwin')
})

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

test('BLENDER_PROTOCOL_VERSION is the pinned M0 wire version', () => {
  assert.equal(BLENDER_PROTOCOL_VERSION, 'deepblend.blender/v1')
  assert.equal(loadFixture().protocolVersion, BLENDER_PROTOCOL_VERSION)
})

// ---------------------------------------------------------------------------
// BlenderError
// ---------------------------------------------------------------------------

test('BlenderError carries name, code and message', () => {
  const error = new BlenderError(BlenderErrorCode.NOT_FOUND, 'no Blender here')

  assert.ok(error instanceof Error)
  assert.ok(error instanceof BlenderError)
  assert.equal(error.name, 'BlenderError')
  assert.equal(error.code, 'BLENDER_NOT_FOUND')
  assert.equal(error.message, 'no Blender here')
  // `detail` must be absent, not merely undefined, or JSON round trips differ.
  assert.equal('detail' in error, false)
})

test('BlenderError.toJSON() emits exactly { code, message } when no detail was supplied', () => {
  const error = new BlenderError(BlenderErrorCode.TIMEOUT, 'deadline exceeded')
  const json = error.toJSON()

  assert.deepEqual(json, { code: 'BLENDER_TIMEOUT', message: 'deadline exceeded' })
  assert.deepEqual(Object.keys(json), ['code', 'message'])
  // Must survive a real serialization (tool results / HTTP responses).
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: 'BLENDER_TIMEOUT', message: 'deadline exceeded' })
})

test('BlenderError.toJSON() includes detail only when one was supplied', () => {
  const detail = { exitCode: 1, stdout: 'boom' }
  const withDetail = new BlenderError(BlenderErrorCode.NONZERO_EXIT, 'exited 1', { detail })

  assert.deepEqual(Object.keys(withDetail.toJSON()), ['code', 'message', 'detail'])
  assert.deepEqual(withDetail.toJSON(), {
    code: 'BLENDER_NONZERO_EXIT',
    message: 'exited 1',
    detail,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(withDetail)).detail, detail)

  // `undefined` is "not supplied" — the key must not appear.
  const explicitUndefined = new BlenderError(BlenderErrorCode.NONZERO_EXIT, 'exited 1', { detail: undefined })
  assert.equal('detail' in explicitUndefined.toJSON(), false)
  assert.equal('detail' in explicitUndefined, false)

  // `null` IS a supplied detail and must survive.
  const nullDetail = new BlenderError(BlenderErrorCode.NONZERO_EXIT, 'exited 1', { detail: null })
  assert.deepEqual(nullDetail.toJSON(), { code: 'BLENDER_NONZERO_EXIT', message: 'exited 1', detail: null })
})

// ---------------------------------------------------------------------------
// warning()
// ---------------------------------------------------------------------------

test('warning() emits { code, message } and omits detail when it is not supplied', () => {
  const bare = warning('GPU_UNAVAILABLE', 'no GPU')
  assert.deepEqual(bare, { code: 'GPU_UNAVAILABLE', message: 'no GPU' })
  assert.deepEqual(Object.keys(bare), ['code', 'message'])

  const explicitUndefined = warning('GPU_UNAVAILABLE', 'no GPU', undefined)
  assert.equal('detail' in explicitUndefined, false)

  const detailed = warning('FORMAT_UNAVAILABLE', 'no obj', { direction: 'import', format: 'obj' })
  assert.deepEqual(detailed, {
    code: 'FORMAT_UNAVAILABLE',
    message: 'no obj',
    detail: { direction: 'import', format: 'obj' },
  })
  assert.deepEqual(Object.keys(detailed), ['code', 'message', 'detail'])
})

test('every fixture warning is a well-formed { code, message } entry', () => {
  const { warnings } = loadFixture()
  assert.ok(Array.isArray(warnings) && warnings.length > 0)
  for (const entry of warnings) {
    assert.equal(typeof entry.code, 'string')
    assert.equal(typeof entry.message, 'string')
    assert.ok(entry.message.length > 0, `warning ${entry.code} has an empty message`)
  }
})

// ---------------------------------------------------------------------------
// toCanonicalCapabilities()
// ---------------------------------------------------------------------------

test('toCanonicalCapabilities() round-trips the captured fixture exactly', () => {
  const fixture = loadFixture()
  const canonical = toCanonicalCapabilities(providerProbeFromCanonical(fixture))

  assert.deepEqual(canonical, fixture)
  // Double insurance on the deterministic-serialization contract.
  assert.equal(JSON.stringify(canonical, null, 2), JSON.stringify(fixture, null, 2))
})

test('toCanonicalCapabilities() returns the declared keys in the declared order', () => {
  const canonical = toCanonicalCapabilities(providerProbeFromCanonical(loadFixture()))
  assert.deepEqual(Object.keys(canonical), CANONICAL_KEYS)

  // Nested objects are projections too; their order is part of the contract.
  assert.deepEqual(Object.keys(canonical.executable), ['requested', 'resolved', 'found'])
  assert.deepEqual(
    Object.keys(canonical.gpu),
    ['available', 'backends', 'preferredBackend', 'devices', 'cpuDevices', 'backendSupport'],
  )
  assert.deepEqual(Object.keys(canonical.formats), ['import', 'export', 'unavailable'])
  assert.deepEqual(Object.keys(canonical.api), ['textBlocks', 'frameRange'])
  assert.deepEqual(Object.keys(canonical.engines.BLENDER_EEVEE), ['available', 'readback', 'error'])
})

test('engines are derived from renderEngines by mapping assignable -> available', () => {
  const probe = providerProbeFromCanonical(loadFixture())
  const canonical = toCanonicalCapabilities(probe)

  assert.deepEqual(Object.keys(canonical.engines), CANDIDATE_RENDER_ENGINES)
  for (const id of CANDIDATE_RENDER_ENGINES) {
    assert.deepEqual(canonical.engines[id], {
      available: probe.renderEngines[id].assignable,
      readback: probe.renderEngines[id].readback,
      error: probe.renderEngines[id].error,
    })
  }

  // The probe field name must not leak into the canonical view.
  assert.equal('assignable' in canonical.engines.CYCLES, false)
  assert.equal(canonical.engines.CYCLES.available, true)
  assert.equal(canonical.engines.CYCLES.readback, 'CYCLES')
  assert.equal(canonical.engines.CYCLES.error, null)

  // An unavailable engine keeps the probe's error text rather than dropping it.
  const unavailable = toCanonicalCapabilities({
    ...probe,
    renderEngines: {
      ...probe.renderEngines,
      CYCLES: { assignable: false, readback: null, error: 'RuntimeError: engine refused' },
    },
  })
  assert.deepEqual(unavailable.engines.CYCLES, {
    available: false,
    readback: null,
    error: 'RuntimeError: engine refused',
  })
})

test('engineEnumItems is diagnostic and must not gate availability (D1)', () => {
  const canonical = toCanonicalCapabilities(providerProbeFromCanonical(loadFixture()))

  // The enum on this Blender build lists EEVEE only…
  assert.ok(Array.isArray(canonical.engineEnumItems))
  assert.deepEqual(canonical.engineEnumItems, ['BLENDER_EEVEE'])
  // …yet Cycles is genuinely assignable, which is the whole point of D1.
  assert.equal(canonical.engines.CYCLES.available, true)
  assert.equal(canonical.engineEnumItems.includes('CYCLES'), false)
  assert.equal(canonical.bestAvailableEngine, 'CYCLES')
  // Workbench is absent from the enum too but is assignable on this build.
  assert.equal(canonical.engines.BLENDER_WORKBENCH.available, true)
  assert.equal(canonical.engineEnumItems.includes('BLENDER_WORKBENCH'), false)
})

test('gpu.available is true for the fixture and gpu.devices is a flat array of strings', () => {
  const canonical = toCanonicalCapabilities(providerProbeFromCanonical(loadFixture()))

  assert.equal(canonical.gpu.available, true)
  assert.ok(Array.isArray(canonical.gpu.devices))
  assert.ok(canonical.gpu.devices.length > 0)
  for (const device of canonical.gpu.devices) assert.equal(typeof device, 'string')
  assert.deepEqual(canonical.gpu.devices, ['Apple M5 (GPU - 10 cores)'])
  assert.deepEqual(canonical.gpu.backends, ['METAL'])
  assert.equal(canonical.gpu.preferredBackend, 'METAL')
  assert.deepEqual(canonical.gpu.cpuDevices, ['Apple M5'])
  // An unsupported backend is a normal result carrying an error, not a failure.
  assert.equal(canonical.gpu.backendSupport.METAL.supported, true)
  assert.equal(canonical.gpu.backendSupport.CUDA.supported, false)
  assert.equal(typeof canonical.gpu.backendSupport.CUDA.error, 'string')
})

test('formats.unavailable reports the attribute-present-but-unregistered formats', () => {
  const canonical = toCanonicalCapabilities(providerProbeFromCanonical(loadFixture()))

  assert.ok(Array.isArray(canonical.formats.unavailable))
  assert.ok(canonical.formats.unavailable.includes('obj'))
  assert.ok(canonical.formats.unavailable.includes('usd'))
  for (const format of canonical.formats.unavailable) assert.equal(typeof format, 'string')

  // Availability is reported as data, never inferred from the unregistered list.
  assert.deepEqual(canonical.formats.import, ['fbx', 'gltf'])
  assert.deepEqual(canonical.formats.export, ['fbx', 'gltf'])
  // The product wants OBJ/USD import and USD export; this build cannot do it.
  for (const format of EXPECTED_IMPORT_FORMATS) {
    if (!canonical.formats.import.includes(format)) {
      assert.ok(canonical.formats.unavailable.includes(format), `${format} missing from unavailable`)
    }
  }
  for (const format of EXPECTED_EXPORT_FORMATS) {
    if (!canonical.formats.export.includes(format)) {
      assert.ok(canonical.formats.unavailable.includes(format), `${format} missing from unavailable`)
    }
  }
})

test('toCanonicalCapabilities() is deterministic and does not mutate its input', () => {
  const probe = providerProbeFromCanonical(loadFixture())
  const snapshot = JSON.parse(JSON.stringify(probe))

  const first = toCanonicalCapabilities(probe)
  const second = toCanonicalCapabilities(probe)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.deepEqual(first, second)

  // Same input rebuilt from a fresh read of the file: still identical.
  const third = toCanonicalCapabilities(providerProbeFromCanonical(loadFixture()))
  assert.equal(JSON.stringify(third), JSON.stringify(first))

  // A pure projection must not write back into the probe result.
  assert.deepEqual(probe, snapshot)
})

test('the candidate engine list is frozen and matches the captured probe', () => {
  assert.ok(Object.isFrozen(CANDIDATE_RENDER_ENGINES))
  assert.ok(Object.isFrozen(EXPECTED_IMPORT_FORMATS))
  assert.ok(Object.isFrozen(EXPECTED_EXPORT_FORMATS))
  assert.deepEqual(CANDIDATE_RENDER_ENGINES, ['BLENDER_EEVEE', 'CYCLES', 'BLENDER_WORKBENCH'])
  assert.deepEqual(
    Object.keys(loadFixture().engines),
    [...CANDIDATE_RENDER_ENGINES],
  )
})

test('isBlenderError narrows a thrown value without trusting its shape', () => {
  // The helper exists because callers catch `unknown`: a plain Error, a string, a `null` and an object that
  // merely LOOKS like a BlenderError (a code and a message, copied by a serialization boundary) are all
  // things that reach a catch block. Only the real class may pass, because the code path that follows reads
  // `patchIssue` and `detail` off it.
  const real = new BlenderError(BlenderErrorCode.NOT_FOUND, 'no blender')
  const impostor = { name: 'BlenderError', code: 'BLENDER_NOT_FOUND', message: 'no blender', detail: null }
  assert.equal(isBlenderError(real), true)
  for (const value of [new Error('plain'), 'a string', null, undefined, impostor]) {
    assert.equal(isBlenderError(value), false, `${String(value)} must not narrow to a BlenderError`)
  }
})
