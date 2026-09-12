/**
 * M0 regression guard — the stable error/warning code vocabulary.
 *
 * `BlenderErrorCode` and `BlenderWarningCode` are a **wire contract**: the model,
 * the tool result, the audit log and the settings card all branch on these exact
 * strings, and the settings/docs already quote them. Renaming, renumbering or
 * removing one silently breaks every consumer, so the M0 set is pinned here
 * literally. Adding a new code is allowed (it is additive and forward
 * compatible); changing or dropping one is not.
 *
 * Run standalone: `node deepblend/tests/contract/error-codes.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { BlenderErrorCode, BlenderWarningCode } from '@deepblend/dsh-blender-contracts'

/** The error codes shipped by M0, pinned key-for-key. */
export const M0_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'BLENDER_NOT_FOUND',
  EXECUTABLE_NOT_EXECUTABLE: 'BLENDER_EXECUTABLE_NOT_EXECUTABLE',
  EXECUTABLE_OUTSIDE_ALLOWLIST: 'BLENDER_EXECUTABLE_OUTSIDE_ALLOWLIST',
  SPAWN_FAILED: 'BLENDER_SPAWN_FAILED',
  NONZERO_EXIT: 'BLENDER_NONZERO_EXIT',
  TIMEOUT: 'BLENDER_TIMEOUT',
  ABORTED: 'BLENDER_ABORTED',
  RESULT_MISSING: 'BLENDER_RESULT_MISSING',
  RESULT_UNPARSEABLE: 'BLENDER_RESULT_UNPARSEABLE',
  SCRIPT_ERROR: 'BLENDER_SCRIPT_ERROR',
  PROTOCOL_VERSION_MISMATCH: 'BLENDER_PROTOCOL_VERSION_MISMATCH',
  UNSUPPORTED_ACTION: 'BLENDER_UNSUPPORTED_ACTION',
  CAPABILITY_PROBE_FAILED: 'BLENDER_CAPABILITY_PROBE_FAILED',
  BOOTSTRAP_MISSING: 'BLENDER_BOOTSTRAP_MISSING',
  ENGINE_UNAVAILABLE: 'BLENDER_ENGINE_UNAVAILABLE',
  RUNTIME_UNAVAILABLE: 'BLENDER_RUNTIME_UNAVAILABLE',
})

/** The warning codes shipped by M0, pinned key-for-key. */
export const M0_WARNING_CODES = Object.freeze({
  BLENDER_NOT_INSTALLED: 'BLENDER_NOT_INSTALLED',
  ENGINE_NOT_IN_STATIC_ENUM: 'ENGINE_NOT_IN_STATIC_ENUM',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  ENGINE_DOWNGRADED: 'ENGINE_DOWNGRADED',
  GPU_UNAVAILABLE: 'GPU_UNAVAILABLE',
  FORMAT_UNAVAILABLE: 'FORMAT_UNAVAILABLE',
  ADDON_ENABLE_FAILED: 'ADDON_ENABLE_FAILED',
  PROBE_WARNING: 'PROBE_WARNING',
  STALE_CAPABILITIES: 'STALE_CAPABILITIES',
})

const ERROR_CODE_PATTERN = /^BLENDER_[A-Z0-9_]+$/
const WARNING_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/

const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'blender',
  'capabilities.sample.json',
)

// ---------------------------------------------------------------------------
// Shape of the vocabulary
// ---------------------------------------------------------------------------

test('every BlenderErrorCode value is a BLENDER_ prefixed SCREAMING_SNAKE string', () => {
  const entries = Object.entries(BlenderErrorCode)
  assert.ok(entries.length > 0, 'BlenderErrorCode is empty')

  for (const [key, value] of entries) {
    assert.equal(typeof value, 'string', `${key} is not a string`)
    assert.match(value, ERROR_CODE_PATTERN, `${key} = "${value}" does not match ${ERROR_CODE_PATTERN}`)
    // The convention is `KEY: 'BLENDER_KEY'`; keep the two in lockstep.
    assert.equal(value, `BLENDER_${key}`, `${key} disagrees with its value "${value}"`)
  }
})

test('every BlenderWarningCode value is a SCREAMING_SNAKE string', () => {
  const entries = Object.entries(BlenderWarningCode)
  assert.ok(entries.length > 0, 'BlenderWarningCode is empty')

  for (const [key, value] of entries) {
    assert.equal(typeof value, 'string', `${key} is not a string`)
    assert.match(value, WARNING_CODE_PATTERN, `${key} = "${value}" does not match ${WARNING_CODE_PATTERN}`)
    assert.equal(value, key, `${key} disagrees with its value "${value}"`)
  }
})

test('neither code table contains a duplicate value', () => {
  const errorValues = Object.values(BlenderErrorCode)
  assert.equal(new Set(errorValues).size, errorValues.length, 'BlenderErrorCode has duplicate values')

  const warningValues = Object.values(BlenderWarningCode)
  assert.equal(new Set(warningValues).size, warningValues.length, 'BlenderWarningCode has duplicate values')
})

test('both code tables are frozen against runtime mutation', () => {
  assert.equal(Object.isFrozen(BlenderErrorCode), true)
  assert.equal(Object.isFrozen(BlenderWarningCode), true)

  // ESM is strict mode, so a write to a frozen property must throw rather than
  // silently no-op — a silent no-op would let a typo corrupt the contract.
  assert.throws(() => { BlenderErrorCode.NOT_FOUND = 'BLENDER_RENAMED' }, TypeError)
  assert.throws(() => { BlenderWarningCode.FORMAT_UNAVAILABLE = 'RENAMED' }, TypeError)
  assert.throws(() => { delete BlenderErrorCode.NOT_FOUND }, TypeError)

  // …and the values survived the attempts.
  assert.equal(BlenderErrorCode.NOT_FOUND, 'BLENDER_NOT_FOUND')
  assert.equal(BlenderWarningCode.FORMAT_UNAVAILABLE, 'FORMAT_UNAVAILABLE')
})

// ---------------------------------------------------------------------------
// The pinned M0 set
// ---------------------------------------------------------------------------

test('the shipped BlenderErrorCode object still matches the pinned M0 list', () => {
  for (const [key, value] of Object.entries(M0_ERROR_CODES)) {
    assert.ok(key in BlenderErrorCode, `BlenderErrorCode.${key} was removed or renamed`)
    assert.equal(
      BlenderErrorCode[key],
      value,
      `BlenderErrorCode.${key} was renamed from "${value}" to "${BlenderErrorCode[key]}" — ` +
        'these codes are a wire contract with the model and the UI.',
    )
  }

  const shipped = Object.values(BlenderErrorCode)
  for (const value of Object.values(M0_ERROR_CODES)) {
    assert.ok(shipped.includes(value), `error code ${value} is no longer exported`)
  }
  // Additive growth is expected in M1+; shrinkage or renames are not.
  assert.ok(
    shipped.length >= Object.values(M0_ERROR_CODES).length,
    'BlenderErrorCode shrank below the pinned M0 set',
  )
})

test('the shipped BlenderWarningCode object still matches the pinned M0 list', () => {
  for (const [key, value] of Object.entries(M0_WARNING_CODES)) {
    assert.ok(key in BlenderWarningCode, `BlenderWarningCode.${key} was removed or renamed`)
    assert.equal(
      BlenderWarningCode[key],
      value,
      `BlenderWarningCode.${key} was renamed from "${value}" to "${BlenderWarningCode[key]}"`,
    )
  }

  const shipped = Object.values(BlenderWarningCode)
  for (const value of Object.values(M0_WARNING_CODES)) {
    assert.ok(shipped.includes(value), `warning code ${value} is no longer exported`)
  }
  assert.ok(
    shipped.length >= Object.values(M0_WARNING_CODES).length,
    'BlenderWarningCode shrank below the pinned M0 set',
  )
})

test('the pinned lists are themselves unique and well formed', () => {
  const errorValues = Object.values(M0_ERROR_CODES)
  assert.equal(new Set(errorValues).size, errorValues.length, 'the pinned error list has duplicates')
  for (const value of errorValues) assert.match(value, ERROR_CODE_PATTERN)

  const warningValues = Object.values(M0_WARNING_CODES)
  assert.equal(new Set(warningValues).size, warningValues.length, 'the pinned warning list has duplicates')
  for (const value of warningValues) assert.match(value, WARNING_CODE_PATTERN)
})

test('the error and warning namespaces stay disjoint', () => {
  // Error codes are BLENDER_-prefixed, warning codes are not, and no string
  // appears in both tables — a caller can classify a bare code without guessing
  // which table it came from.
  const errorValues = Object.values(BlenderErrorCode)
  const warningValues = Object.values(BlenderWarningCode)

  const shared = errorValues.filter(value => warningValues.includes(value))
  assert.deepEqual(shared, [])

  // Key reuse across the two tables is intentional and safe: ENGINE_UNAVAILABLE
  // is both a hard error (D2, the engine genuinely cannot be used) and a
  // degraded-success warning, and the values differ.
  const sharedKeys = Object.keys(BlenderErrorCode).filter(key => key in BlenderWarningCode)
  assert.deepEqual(sharedKeys, ['ENGINE_UNAVAILABLE'])
  assert.equal(BlenderErrorCode.ENGINE_UNAVAILABLE, 'BLENDER_ENGINE_UNAVAILABLE')
  assert.equal(BlenderWarningCode.ENGINE_UNAVAILABLE, 'ENGINE_UNAVAILABLE')
})

// ---------------------------------------------------------------------------
// The fixture must only use codes that really exist
// ---------------------------------------------------------------------------

test('every warning code in the captured fixture is a declared BlenderWarningCode', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  const declared = new Set(Object.values(BlenderWarningCode))

  assert.ok(Array.isArray(fixture.warnings) && fixture.warnings.length > 0)
  for (const entry of fixture.warnings) {
    assert.ok(declared.has(entry.code), `fixture warning code "${entry.code}" is not in BlenderWarningCode`)
  }
})
