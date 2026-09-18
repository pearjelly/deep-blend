/**
 * What a URL looks like after it has been through this product's messages and records.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §15.2's "日志脱敏" was half done and the table said so (`milestone-status.md` §7 #10): no secret
 * ever reaches a child process (the environment whitelist), but nothing filtered what this plugin
 * itself WRITES. And what it wrote, in five places, was the asset URL verbatim — including into the
 * job record and into the approval prompt an operator reads. A presigned URL
 * (`…?X-Amz-Signature=…`) or a URL carrying an API token is the ordinary way a model is handed a
 * model file, so "the URL is not a secret" is a claim the product cannot make.
 *
 * THE RULE, AND WHY IT DROPS RATHER THAN MASKS
 * -------------------------------------------
 * Credentials, the query string and the fragment are REMOVED, and the removal is SAID in the text:
 * a reader has to be able to tell `https://host/a.glb` from `https://host/a.glb?token=…` that was
 * cleaned, because the second one may behave differently on a retry. Masking individual parameter
 * values would need a list of parameter names to trust, and that list is exactly the thing that
 * rots: a signature parameter nobody thought of is a leak, while a dropped query is at worst a
 * less useful message.
 *
 * A string that is not a URL at all cannot be parsed, so it cannot be cleaned — it is truncated
 * instead. That is not redaction and does not pretend to be: it bounds what a record can accumulate
 * from an arbitrary string, and the caller that passed a non-URL has already seen it.
 *
 * Owner: DeepBlend Studio — M5
 */

/** How much of an unparseable source is kept. Long enough to recognise, short enough to bound a record. */
const UNPARSEABLE_LIMIT = 120

/**
 * A URL with its credentials, query string and fragment removed, saying what was removed.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function redactUrl(raw) {
  const text = typeof raw === 'string' ? raw : String(raw)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return text.length > UNPARSEABLE_LIMIT ? `${text.slice(0, UNPARSEABLE_LIMIT)}…` : text
  }
  const removed = []
  if (parsed.username !== '' || parsed.password !== '') removed.push('credentials')
  if (parsed.search !== '') removed.push('query')
  if (parsed.hash !== '') removed.push('fragment')
  const clean = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  if (removed.length === 0) return clean
  return `${clean} (${removed.join(' and ')} removed)`
}
