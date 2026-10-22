/** Compare canonical full-document hashes without treating missing history as evidence. */
const fullHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null

/**
 * Stored legacy booleans/statuses are deliberately ignored. No document is rewritten.
 * `specChanged` remains a conservative compatibility flag: true means not proven unchanged.
 * User-facing conclusions must use `specChangeStatus`, including its explicit unknown state.
 * These are canonical SceneSpec hashes, not file-byte SHA256 or render-only scene digests.
 * @param {{ specHashBefore?: string|null, specHashAfter?: string|null }} [hashes]
 * @returns {{ specChanged: boolean, specChangeStatus: 'changed'|'unchanged'|'unknown' }}
 */
export function specChangeAudit(hashes = {}) {
  const before = fullHash(hashes.specHashBefore), after = fullHash(hashes.specHashAfter)
  const specChangeStatus = before === null || after === null ? 'unknown' : before === after ? 'unchanged' : 'changed'
  return { specChanged: specChangeStatus !== 'unchanged', specChangeStatus }
}
