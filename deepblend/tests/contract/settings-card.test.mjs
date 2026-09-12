/**
 * M0 contract tests — the settings-card view model (`buildSettingsCard`).
 *
 * The card is what the operator actually reads, so its contract is: it renders
 * from canonical capabilities only, it never throws on a degraded or missing
 * payload, and it repeats engine availability exactly as the probe reported it
 * (a listed enum must never hide an assignable engine — D1).
 *
 * Pure unit tests: no Blender, no HTTP, no browser. `buildSettingsCard()` is a
 * pure function and is exercised directly.
 *
 * Run standalone: `node deepblend/tests/contract/settings-card.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BlenderWarningCode,
  CANDIDATE_RENDER_ENGINES,
  warning,
} from '@deepblend/dsh-blender-contracts'
import { buildSettingsCard } from '@deepblend/dsh-blender-ui'

/** Resolved relative to this file, never an absolute path, so any cwd works. */
const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'blender',
  'capabilities.sample.json',
)

/** The ready capture: Blender 5.2.1 LTS on Apple M5. */
const READY = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

/**
 * The canonical shape of a machine with no Blender at all — exactly what the
 * provider's `_absentCapabilities()` produces once projected.
 */
function absentCapabilities() {
  return {
    protocolVersion: 'deepblend.blender/v1',
    installed: false,
    executable: { requested: 'blender', resolved: null, found: false },
    version: null,
    versionTuple: null,
    pythonVersion: null,
    buildHash: null,
    binaryPath: null,
    engines: Object.fromEntries(
      CANDIDATE_RENDER_ENGINES.map(id => [id, { available: false, readback: null, error: 'Blender not installed' }]),
    ),
    bestAvailableEngine: null,
    engineEnumItems: [],
    gpu: {
      available: false,
      backends: [],
      preferredBackend: null,
      devices: [],
      cpuDevices: [],
      backendSupport: {},
    },
    formats: { import: [], export: [], unavailable: [] },
    renderSmokeTest: null,
    cyclesSmokeTest: null,
    api: { textBlocks: false, frameRange: false },
    hostPlatform: null,
    warnings: [
      warning(
        BlenderWarningCode.BLENDER_NOT_INSTALLED,
        'Blender executable could not be resolved from "blender".',
        { configuredPath: 'blender' },
      ),
    ],
    probedAt: 1787052400000,
    durationMs: 0,
  }
}

/**
 * Every card must be renderable: a `rows` array whose every entry carries a
 * non-empty string `label` and a string `value`.
 * @param {Record<string, any>} card
 */
function assertCardShape(card) {
  assert.ok(card && typeof card === 'object', 'card is not an object')
  assert.equal(typeof card.title, 'string')
  assert.equal(typeof card.status, 'string')
  assert.equal(typeof card.statusLabel, 'string')
  assert.ok(card.statusLabel.trim().length > 0, 'statusLabel is empty')
  assert.ok(Array.isArray(card.rows), 'card.rows is not an array')
  assert.ok(card.rows.length > 0, 'card.rows is empty')
  for (const row of card.rows) {
    assert.equal(typeof row.label, 'string', `row ${JSON.stringify(row)} has a non-string label`)
    assert.ok(row.label.trim().length > 0, 'a row has an empty label')
    assert.equal(typeof row.value, 'string', `row "${row.label}" has a non-string value`)
  }
  assert.ok(Array.isArray(card.warnings), 'card.warnings is not an array')
}

/** @param {Record<string, any>} card @param {string} needle */
function rowValue(card, needle) {
  const row = card.rows.find(entry => entry.label.includes(needle))
  assert.ok(row, `no card row whose label contains "${needle}"`)
  return row.value
}

// ---------------------------------------------------------------------------
// Ready machine
// ---------------------------------------------------------------------------

test('the ready fixture renders a ready card', () => {
  const card = buildSettingsCard(READY)

  assertCardShape(card)
  assert.equal(card.title, 'Blender')
  assert.equal(card.status, 'ready')
  assert.equal(card.statusLabel, '可用')
  assert.equal(card.probedAt, READY.probedAt)
})

test('the ready card carries the 版本 / 可用引擎 / GPU rows at minimum', () => {
  const card = buildSettingsCard(READY)
  const labels = card.rows.map(row => row.label)

  for (const required of ['版本', '可用引擎', 'GPU']) {
    assert.ok(
      labels.some(label => label.includes(required)),
      `no row label covers "${required}"; labels were ${JSON.stringify(labels)}`,
    )
  }

  assert.equal(rowValue(card, '版本'), '5.2.1 LTS')
  assert.equal(rowValue(card, '可用引擎'), 'BLENDER_EEVEE, CYCLES, BLENDER_WORKBENCH')
  assert.equal(rowValue(card, 'GPU'), 'Apple M5 (GPU - 10 cores) (METAL)')
  assert.equal(rowValue(card, '首选引擎'), 'CYCLES')
  assert.equal(rowValue(card, '可执行文件'), READY.executable.resolved)
  assert.equal(rowValue(card, '导入格式'), 'fbx, gltf')
  assert.equal(rowValue(card, '导出格式'), 'fbx, gltf')
})

test('the ready card lists CYCLES as available even though the engine enum lists only BLENDER_EEVEE (D1)', () => {
  const card = buildSettingsCard(READY)

  // The trap: the enum says one thing, behaviour says another. The card must
  // follow behaviour, otherwise the operator is told Cycles is missing.
  assert.deepEqual(READY.engineEnumItems, ['BLENDER_EEVEE'])
  const engines = rowValue(card, '可用引擎')
  assert.ok(engines.includes('CYCLES'), `可用引擎 row lost CYCLES: "${engines}"`)
  assert.ok(engines.includes('BLENDER_EEVEE'), `可用引擎 row lost BLENDER_EEVEE: "${engines}"`)
  assert.equal(rowValue(card, '首选引擎'), 'CYCLES')
})

test("the ready card's warnings mirror the fixture warnings' code and message", () => {
  const card = buildSettingsCard(READY)

  assert.deepEqual(
    card.warnings,
    READY.warnings.map(entry => ({ code: entry.code, message: entry.message })),
  )
  assert.equal(card.warnings.length, READY.warnings.length)
  for (const entry of card.warnings) {
    // The card view model is exactly two fields: no `detail` leaks into the UI.
    assert.deepEqual(Object.keys(entry), ['code', 'message'])
    assert.equal(typeof entry.code, 'string')
    assert.equal(typeof entry.message, 'string')
  }
  // The D1 warning must survive the projection.
  assert.ok(card.warnings.some(entry => entry.code === 'ENGINE_NOT_IN_STATIC_ENUM'))
})

test('an installed machine with no GPU device is still ready (CPU rendering)', () => {
  const cpuOnly = {
    ...READY,
    gpu: { ...READY.gpu, available: false, backends: [], preferredBackend: null, devices: [] },
  }
  const card = buildSettingsCard(cpuOnly)

  assertCardShape(card)
  assert.equal(card.status, 'ready')
  assert.equal(rowValue(card, 'GPU'), '未检测到（CPU 渲染）')
  // Engine availability is independent of the GPU.
  assert.equal(rowValue(card, '可用引擎'), 'BLENDER_EEVEE, CYCLES, BLENDER_WORKBENCH')
})

// ---------------------------------------------------------------------------
// No Blender
// ---------------------------------------------------------------------------

test('an absent-Blender payload renders a missing card without throwing', () => {
  /** @type {Record<string, any>} */
  let card
  assert.doesNotThrow(() => { card = buildSettingsCard(absentCapabilities()) })

  assertCardShape(card)
  assert.equal(card.status, 'missing')
  assert.equal(card.statusLabel, '未安装')
  assert.equal(rowValue(card, '可执行文件'), '未解析到')
  assert.equal(rowValue(card, '配置路径'), 'blender')
  assert.equal(rowValue(card, '可用引擎'), '无')
  assert.equal(rowValue(card, 'GPU'), '未检测到（CPU 渲染）')
  assert.equal(rowValue(card, '导入格式'), '无')
  assert.equal(rowValue(card, '导出格式'), '无')
  assert.equal(rowValue(card, '无头渲染自检'), '—')
  assert.deepEqual(card.warnings, [
    { code: BlenderWarningCode.BLENDER_NOT_INSTALLED, message: 'Blender executable could not be resolved from "blender".' },
  ])
})

test('defensive rendering: undefined, null, empty and partial payloads never throw', () => {
  const payloads = [
    undefined,
    null,
    {},
    { installed: false },
    { installed: false, engines: {}, gpu: {}, formats: {} },
    { engines: undefined, warnings: undefined },
  ]

  for (const payload of payloads) {
    const label = JSON.stringify(payload) ?? String(payload)
    /** @type {Record<string, any>} */
    let card
    assert.doesNotThrow(() => { card = buildSettingsCard(payload) }, `threw for ${label}`)

    assertCardShape(card)
    assert.equal(card.status, 'missing', `wrong status for ${label}`)
    assert.equal(card.statusLabel, '未安装', `wrong statusLabel for ${label}`)
    assert.deepEqual(card.warnings, [], `unexpected warnings for ${label}`)
    // No payload means no probe timestamp — never `undefined`.
    assert.equal(card.probedAt, null, `wrong probedAt for ${label}`)
    // Placeholder values must still be strings, or the renderer breaks.
    for (const required of ['版本', '可用引擎', 'GPU', '导入格式', '导出格式']) {
      assert.equal(typeof rowValue(card, required), 'string', `row "${required}" is not a string for ${label}`)
    }
  }

  // `undefined` and `{}` must be indistinguishable to the card.
  assert.deepEqual(buildSettingsCard(undefined), buildSettingsCard({}))
})
