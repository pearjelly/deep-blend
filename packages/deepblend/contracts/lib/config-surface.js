/**
 * Which config keys a row actually reads — the check that turns a silent no-op into a startup error.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §17 illustrates the configuration as a NESTED document:
 *
 *     { "finalRender": { "requireApprovalAboveFrames": 900 }, "security": { "assetMaxBytes": … } }
 *
 * and the implementation reads FLAT keys (`requireApprovalAboveFrames`, `assetMaxBytes`, …), because
 * each key belongs to the package that enforces it rather than to a group. MEASURED before this
 * module existed: Schemastery accepts the nested document, keeps `finalRender` as an unknown property,
 * and reports nothing — so an operator who follows the spec gets a deployment where the approval
 * threshold is whatever the DEFAULT was, with no error anywhere. The key is not ignored loudly; it is
 * ignored silently, which is the only failure mode this repository treats as unacceptable in a
 * configuration.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not reject a key for having the wrong TYPE or VALUE — the schema already does that, with a
 * better message than this could write. It answers one question only: does this row read this name at
 * all?
 *
 * Owner: DeepBlend Studio — M5
 */

/**
 * The top-level keys a schema declares.
 *
 * Read from `toJSON()` rather than from the builder: the same shape the bundle validator and the
 * settings card use, so there is one description of a row's surface rather than a second one here.
 *
 * @param {{toJSON: () => object}} schema
 * @returns {string[]}
 */
export function declaredConfigKeys(schema) {
  const json = schema.toJSON()
  // `dict` sits on the ROOT node, which is `refs[uid]` as soon as the schema has any refs at all — a
  // schema of scalars with defaults has them, so reading `json.dict` alone found nothing and this check
  // declared every key unknown. MEASURED against `StudioConfig`: `{uid: 47, refs: {…, 47: {dict: {…}}}}`.
  const dict = json?.refs?.[json.uid]?.dict ?? json?.dict ?? {}
  return Object.keys(dict).sort()
}

/**
 * A message naming every key this row does not read, or `null` when there are none.
 *
 * The known keys are listed in full rather than counted: this runs once, at composition, and the
 * operator reading it is looking for the name they meant to type.
 *
 * @param {{toJSON: () => object}} schema
 * @param {object} config - the row's config as the loader passed it
 * @param {string} label - the row id, so the error says which row is wrong
 * @returns {string|null}
 */
export function describeUnknownConfigKeys(schema, config, label) {
  const known = declaredConfigKeys(schema)
  const knownSet = new Set(known)
  const given = config !== null && typeof config === 'object' ? Object.keys(config) : []
  const unknown = given.filter(key => !knownSet.has(key))
  if (unknown.length === 0) return null
  return (
    `${label} does not read ${unknown.map(key => `"${key}"`).join(', ')}. ` +
    `It reads: ${known.join(', ')}. ` +
    'Note that a key with the wrong shape is NOT rejected by the schema — a nested object like SPEC §17\u2019s ' +
    '`finalRender: {…}` is accepted and simply never read, so this check is what makes that loud. ' +
    // THE MOST LIKELY CAUSE IS NOT A TYPO, and the message has to say so: an operator layer is GENERATED from
    // the bundle (`npm run plugin:install`), so a bundle that dropped a key leaves every existing layer
    // carrying it — and this refusal then fires at the next restart, which is a long way from the edit that
    // caused it. MEASURED: exactly that happened in this repository when `serveCachedCapabilities` was
    // deleted, and the only thing that surfaced it was `npm run plugin:check` being run by hand.
    'If this config came from a generated operator layer, the layer is stale rather than wrong: ' +
    'run `npm run plugin:install` to regenerate it from the bundle, then restart the profile. ' +
    'See `deepblend/docs/install.md` for the SPEC §17 name \u2192 real name table.'
  )
}

/**
 * Throw when a row's config carries a key the row does not read.
 *
 * @param {{toJSON: () => object}} schema
 * @param {object} config
 * @param {string} label
 */
export function assertKnownConfigKeys(schema, config, label) {
  const problem = describeUnknownConfigKeys(schema, config, label)
  if (problem !== null) throw new Error(problem)
}
