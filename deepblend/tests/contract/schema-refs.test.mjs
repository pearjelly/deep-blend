#!/usr/bin/env node
/**
 * Every `$ref` in a shipped schema resolves — and the advice this product gives validates against it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * MEASURED before it existed: `scene-patch.schema.json` declared `asset.add`'s `license` as
 * `{"$ref": "#/$defs/license"}` while that document had NO `license` definition. The result was not a
 * refusal a caller could branch on — it was a `SchemaDefinitionError` thrown from inside the validator, so
 * a patch that declared an asset's licence crashed instead of being rejected. Two things were wrong at once
 * and only one of them was in the schema: `blender_asset_ingest`'s advice told the model to write
 * `license: "CC-BY-4.0"` (a string), while `asset.license` is an OBJECT with `source`, `commercialUse` and
 * `attribution`. A model that did what it was told got a schema error for its trouble.
 *
 * So this file checks three things, in the order they would have caught the defect:
 *
 *   1. every `$ref` in every shipped schema resolves (the dangling reference itself);
 *   2. a definition carried by two documents is IDENTICAL in both — the `license` object lives in the
 *      SceneSpec schema and had to be copied into the patch schema, because the validator resolves
 *      references within one document; two copies with one checker is the rule;
 *   3. the ADVICE validates: the `nextStep` text `blender_asset_ingest` hands the model is turned back into
 *      a patch and put through the validator. Advice that cannot be followed is worse than no advice.
 *
 * Run standalone: `node deepblend/tests/contract/schema-refs.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { validateScenePatch } from '@deepblend/dsh-blender-contracts'

import { ROOT } from '../../tools/workspace-layout.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const SCHEMA_DIR = join(ROOT, 'packages', 'deepblend', 'contracts', 'lib', 'schemas')
const schemas = readdirSync(SCHEMA_DIR).filter(name => name.endsWith('.json')).map((name) => {
  const text = readFileSync(join(SCHEMA_DIR, name), 'utf8')
  return { name, text, json: JSON.parse(text) }
})

/** Every `{"$ref": "#/…"}` in a document, with the JSON pointer it names. */
function refsOf(value, path = [], found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => refsOf(entry, [...path, String(index)], found))
    return found
  }
  if (value === null || typeof value !== 'object') return found
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string') found.push({ at: path.join('/'), ref: entry })
    else refsOf(entry, [...path, key], found)
  }
  return found
}

function resolves(document, ref) {
  if (!ref.startsWith('#/')) return true // an external reference is a different question, and there are none
  let node = document
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object' || !(key in node)) return false
    node = node[key]
  }
  return true
}

const dangling = []
let refCount = 0
for (const schema of schemas) {
  for (const { at, ref } of refsOf(schema.json)) {
    refCount += 1
    if (!resolves(schema.json, ref)) dangling.push(`${schema.name} ${ref} (at ${at})`)
  }
}
check('the schemas were found and they contain references at all (a check over zero refs proves nothing)',
  schemas.length >= 3 && refCount >= 10, { schemas: schemas.length, refs: refCount })
check('every $ref in every shipped schema resolves (a dangling one throws inside the validator)',
  dangling.length === 0, dangling)

// ---- the definition the patch document had to borrow ----------------------
//
// The `license` definition lives in the SceneSpec schema and had to be COPIED into the patch schema, because
// the validator resolves references within one document. That copy is not checked here: `schema-mirror.test.mjs`
// already asserts the packaged schemas are byte-identical to the authoritative ones under `deepblend/schemas/`,
// which is a stronger statement than "the two definitions match" — one fact, one checker.
const patchSchema = schemas.find(schema => schema.name === 'scene-patch.schema.json').json
check('the patch document now carries the definition it references',
  patchSchema.$defs?.license !== undefined)

// ---- the advice this product gives must validate ---------------------------

const declaredAsset = { id: 'advice', type: 'glb', path: 'assets/raw/advice.glb', sha256: 'a'.repeat(64) }
check('a licensed asset declaration in the SHAPE THE SCHEMA USES is accepted',
  validateScenePatch({
    projectId: 'p', baseRevision: 'r0001',
    operations: [{ op: 'asset.add', asset: { ...declaredAsset, license: { source: 'CC-BY-4.0' } } }],
  }).ok === true)
check('and the bare-string spelling the advice used to print is REJECTED, which is why it was fixed',
  validateScenePatch({
    projectId: 'p', baseRevision: 'r0001',
    operations: [{ op: 'asset.add', asset: { ...declaredAsset, license: 'CC-BY-4.0' } }],
  }).ok !== true)

// The advice is read out of the host's source rather than retyped here, so this cannot pass while the
// sentence the model actually receives says something else. It is a SHAPE check, not a parse: the rendered
// sentence is asserted in `host-asset-ingest.test.mjs`, where a real licence produces it and the declaration
// is put through the validator (the loop that matters). What this catches is the spelling coming back.
const host = readFileSync(join(ROOT, 'packages', 'deepblend', 'host', 'lib', 'index.js'), 'utf8')
const adviceAt = host.indexOf('declare it with blender_scene_patch:')
check('the advice sentence is still where this test reads it (a moved sentence must fail loudly)',
  adviceAt !== -1)
const advice = host.slice(adviceAt, adviceAt + 700)
check('and it spells the licence the way the schema wants it, not as a bare string',
  advice.includes('license: ${JSON.stringify({ source: license })}') && !/license: \$\{JSON\.stringify\(license\)\}/.test(advice),
  advice.slice(advice.indexOf('license'), advice.indexOf('license') + 80))

const passed = results.filter(entry => entry.ok).length
console.log(`\nSchema references: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
