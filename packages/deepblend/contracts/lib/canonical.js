/**
 * Canonical JSON serialization and content hashing.
 *
 * The word "canonical" here is load-bearing (SPEC §11.1 "返回 Canonical JSON"):
 *
 *  - **Key order is significant and fixed** (sorted, recursively), because a
 *    revision digest, an idempotency record and a test fixture all hash the same
 *    document. Two structurally identical SceneSpecs that differ only in key
 *    insertion order MUST hash identically, or the same intent would look like
 *    two different revisions.
 *  - **Absent keys are omitted rather than emitted as `null`**, so "not set" has
 *    exactly one representation. `undefined` is never valid JSON and is dropped.
 *  - **No whitespace**, so the hash is over bytes and not over formatting.
 *
 * Owner: DeepBlend Studio — M1
 */

import { createHash } from 'node:crypto'

/**
 * Serialize a JSON value with recursively sorted object keys and no whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return JSON.stringify(sortValue(value))
}

/**
 * Pretty-print a JSON value with recursively sorted keys.
 *
 * Used for every document DeepBlend writes to disk. Sorted keys make a revision
 * diff between two SceneSpecs read as an actual change rather than as noise from
 * insertion order — which is the whole point of keeping the spec, not the
 * `.blend`, as the source of truth (SPEC §8.1).
 *
 * @param {unknown} value
 * @param {number} [indent]
 * @returns {string}
 */
export function canonicalPretty(value, indent = 2) {
  return JSON.stringify(sortValue(value), null, indent)
}

/**
 * Recursively rebuild a value with sorted keys, dropping `undefined`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortValue(value) {
  if (Array.isArray(value)) return value.map(entry => sortValue(entry))
  if (value === null || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const output = {}
  for (const key of Object.keys(value).sort()) {
    const member = /** @type {Record<string, unknown>} */ (value)[key]
    if (member === undefined) continue
    output[key] = sortValue(member)
  }
  return output
}

/**
 * SHA-256 of the canonical serialization, as lowercase hex.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex')
}

/**
 * SHA-256 of raw bytes or text.
 *
 * @param {Buffer|string} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Hex prefix length used when hashes appear inside identifiers. */
const SHORT_HASH_LENGTH = 16

/**
 * A short, file-name-safe digest used for cache keys and idempotency records.
 * Long enough that a collision would require a deliberate attack, short enough
 * to keep an on-disk path readable.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shortDigest(value) {
  return sha256Canonical(value).slice(0, SHORT_HASH_LENGTH)
}
