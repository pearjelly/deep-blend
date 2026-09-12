#!/usr/bin/env node
/**
 * M1 contract tests — canonical JSON, content hashing, and the schema compiler.
 *
 * These three modules are the foundation everything else in M1 stands on:
 *
 *  - `canonicalStringify` defines the bytes a revision digest is computed over.
 *    Key order must be sorted recursively and `undefined` must be DROPPED, not
 *    emitted as `null`, or two identical scenes hash differently and "not set"
 *    acquires two representations (SPEC §11.1).
 *  - `sha256` / `sha256Canonical` / `shortDigest` are the identity functions for
 *    revisions, assets and cache keys. A change here re-labels stored work.
 *  - `compileSchema` is the project's own JSON Schema subset, and it makes one
 *    promise that matters more than any other: **an unsupported keyword is a
 *    schema-load error, never a silently unenforced rule.** A validator that
 *    ignores `format` turns a rejected scene into an accepted one, so the
 *    failure mode is asserted explicitly below.
 *
 * Pure unit tests: no Blender, no subprocess, no network, no filesystem writes.
 *
 * Run standalone: `node deepblend/tests/contract/canonical.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { createHash } from 'node:crypto'

import {
  SchemaDefinitionError,
  canonicalPretty,
  canonicalStringify,
  compileSchema,
  formatIssues,
  sha256,
  sha256Canonical,
  shortDigest,
  sortValue,
} from '@deepblend/dsh-blender-contracts'

// ---------------------------------------------------------------------------
// Harness — a `results` array, `[PASS]`/`[FAIL]` lines, a summary, and a
// non-zero exit. The counting form the M1 contract files were specified with,
// also used by `deepblend/tests/composition/*.e2e.mjs`.
// ---------------------------------------------------------------------------

const results = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/** Run `fn`, returning either its value or the error it threw. */
function caught(fn) {
  try {
    return { value: fn() }
  } catch (error) {
    return { error }
  }
}

/** Compile a schema and return the thrown error instead of propagating it. */
function compileOrThrow(schema) {
  try {
    return { validate: compileSchema(schema) }
  } catch (error) {
    return { error }
  }
}

/** Validation issue keywords, for compact details. */
function keywords(issues) {
  return issues.map(issue => `${issue.keyword}@${issue.path}`)
}

// ---------------------------------------------------------------------------
// canonicalStringify — sorted keys, no whitespace
// ---------------------------------------------------------------------------

const nested = { b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }
check(
  'canonicalStringify sorts object keys recursively',
  canonicalStringify(nested) === '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
  canonicalStringify(nested),
)
check(
  'canonicalStringify emits no whitespace at all',
  canonicalStringify({ a: [1, 2, { b: 3 }], c: { d: 4 } }) === '{"a":[1,2,{"b":3}],"c":{"d":4}}'
    && /\s/.test(canonicalStringify({ a: [1, 2, { b: 3 }], c: { d: 4 } })) === false,
  canonicalStringify({ a: [1, 2, { b: 3 }], c: { d: 4 } }),
)
check(
  'two objects built in different insertion order serialize identically',
  canonicalStringify({ b: 1, a: { d: 2, c: 3 } }) === canonicalStringify({ a: { c: 3, d: 2 }, b: 1 }),
)
check(
  'array order is preserved, since it is data and not key order',
  canonicalStringify([3, 1, 2]) === '[3,1,2]' && canonicalStringify([{ b: 1, a: 2 }]) === '[{"a":2,"b":1}]',
  canonicalStringify([3, 1, 2]),
)
check(
  'an undefined member is dropped rather than emitted as null',
  canonicalStringify({ a: undefined, b: 1, c: null }) === '{"b":1,"c":null}',
  canonicalStringify({ a: undefined, b: 1, c: null }),
)
check(
  'a nested undefined member is dropped too',
  canonicalStringify({ a: { b: undefined, c: 1 } }) === '{"a":{"c":1}}',
  canonicalStringify({ a: { b: undefined, c: 1 } }),
)
check(
  'null is a value and survives serialization',
  canonicalStringify({ a: null }) === '{"a":null}',
  canonicalStringify({ a: null }),
)
check(
  'scalars serialize as plain JSON',
  canonicalStringify(1) === '1'
    && canonicalStringify('s') === '"s"'
    && canonicalStringify(true) === 'true'
    && canonicalStringify(null) === 'null',
)
check(
  'an object whose every member is undefined serializes as {}',
  canonicalStringify({ a: undefined, b: undefined }) === '{}',
  canonicalStringify({ a: undefined, b: undefined }),
)
check(
  'the canonical form of a key-reordered document is unchanged (the digest precondition)',
  canonicalStringify({ z: { y: [1, { b: 2, a: 3 }] }, a: 1 })
    === canonicalStringify({ a: 1, z: { y: [1, { a: 3, b: 2 }] } }),
)

// ---------------------------------------------------------------------------
// sortValue — the transformation underneath, and its purity
// ---------------------------------------------------------------------------

const original = { b: 1, a: { d: 2 } }
const sorted = sortValue(original)
check(
  'sortValue returns a new object with sorted keys',
  Object.keys(sorted).join(',') === 'a,b' && JSON.stringify(sorted) === '{"a":{"d":2},"b":1}',
  sorted,
)
check(
  'sortValue does not mutate the input, at any depth',
  Object.keys(original).join(',') === 'b,a' && Object.keys(original.a).join(',') === 'd' && sorted.a !== original.a,
  original,
)
check(
  'sortValue maps arrays element-wise',
  JSON.stringify(sortValue([{ b: 1, a: 2 }])) === '[{"a":2,"b":1}]',
  sortValue([{ b: 1, a: 2 }]),
)
check(
  'sortValue passes primitives through untouched',
  sortValue(1) === 1 && sortValue('s') === 's' && sortValue(null) === null && sortValue(true) === true,
)

// ---------------------------------------------------------------------------
// canonicalPretty — the on-disk form
// ---------------------------------------------------------------------------

const pretty = canonicalPretty({ b: 1, a: { c: 2 } })
check(
  'canonicalPretty indents by two spaces and sorts keys',
  pretty === '{\n  "a": {\n    "c": 2\n  },\n  "b": 1\n}',
  pretty,
)
check('canonicalPretty output parses back', JSON.stringify(JSON.parse(pretty)) === '{"a":{"c":2},"b":1}')
check(
  'canonicalPretty is stable across insertion order',
  canonicalPretty({ a: { c: 2 }, b: 1 }) === pretty,
)
check(
  'canonicalPretty honours an explicit indent of 0 (compact but sorted)',
  canonicalPretty({ b: 1, a: 2 }, 0) === '{"a":2,"b":1}',
  canonicalPretty({ b: 1, a: 2 }, 0),
)
check(
  'canonicalPretty drops undefined members like canonicalStringify does',
  canonicalPretty({ a: undefined, b: 1 }, 0) === '{"b":1}',
)
check(
  'a pretty document re-serializes to the same canonical bytes',
  canonicalStringify(JSON.parse(pretty)) === canonicalStringify({ b: 1, a: { c: 2 } }),
)

// ---------------------------------------------------------------------------
// sha256 / sha256Canonical / shortDigest
// ---------------------------------------------------------------------------

const value = { z: [1, 2], y: { b: 1, a: 2 } }
check(
  'sha256 hashes text and bytes identically',
  sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    && sha256(Buffer.from('abc')) === sha256('abc'),
  sha256('abc'),
)
check(
  'sha256Canonical is sha256 over the canonical serialization',
  sha256Canonical(value) === sha256(canonicalStringify(value)),
)
check(
  'sha256Canonical matches a hand-computed digest of the exact canonical bytes',
  sha256Canonical(value) === createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex'),
  sha256Canonical(value),
)
check(
  'sha256Canonical is a 64-character lowercase hex digest',
  /^[0-9a-f]{64}$/.test(sha256Canonical(value)),
  sha256Canonical(value),
)
check(
  'sha256Canonical ignores key insertion order',
  sha256Canonical({ b: 1, a: 2 }) === sha256Canonical({ a: 2, b: 1 }),
)
check(
  'sha256Canonical changes when a value changes',
  sha256Canonical({ a: 2 }) !== sha256Canonical({ a: 3 }),
)
check(
  'sha256Canonical does not treat an undefined member as a null member',
  sha256Canonical({ a: undefined }) === sha256Canonical({}) && sha256Canonical({ a: null }) !== sha256Canonical({}),
)
check(
  'shortDigest is 16 lowercase hex characters',
  /^[0-9a-f]{16}$/.test(shortDigest(value)) && shortDigest(value).length === 16,
  shortDigest(value),
)
check(
  'shortDigest is a prefix of the full digest',
  sha256Canonical(value).startsWith(shortDigest(value)),
  { short: shortDigest(value), full: sha256Canonical(value) },
)
check(
  'shortDigest is order-insensitive and change-sensitive like the full digest',
  shortDigest({ b: 1, a: 2 }) === shortDigest({ a: 2, b: 1 }) && shortDigest({ a: 2 }) !== shortDigest({ a: 3 }),
)

// ---------------------------------------------------------------------------
// compileSchema — the supported subset
// ---------------------------------------------------------------------------

const person = compileSchema({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'age'],
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 10, pattern: '^[a-z]+$' },
    age: { type: 'integer', minimum: 18, maximum: 120 },
    kind: { type: 'string', enum: ['staff', 'guest'] },
    tag: { const: 'pinned' },
    nested: {
      type: 'object',
      additionalProperties: false,
      properties: { x: { type: 'number' } },
    },
    list: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'number' } },
  },
})

check(
  'a conforming value produces no issues',
  JSON.stringify(person({ name: 'ada', age: 36, kind: 'staff', tag: 'pinned', nested: { x: 1 }, list: [1, 2] })) === '[]',
  person({ name: 'ada', age: 36, kind: 'staff', tag: 'pinned', nested: { x: 1 }, list: [1, 2] }),
)
check(
  'a missing required property reports `required` at its own path',
  keywords(person({ age: 20 })).includes('required@name'),
  keywords(person({ age: 20 })),
)
check(
  'a wrong type reports `type` and stops checking that subtree',
  keywords(person({ name: 7, age: 20 })).join(',') === 'type@name',
  keywords(person({ name: 7, age: 20 })),
)
check(
  'a fractional number is not an integer',
  keywords(person({ name: 'ada', age: 17.5 })).includes('type@age'),
  keywords(person({ name: 'ada', age: 17.5 })),
)
check(
  'integer accepts a number with no fractional part',
  JSON.stringify(person({ name: 'ada', age: 18.0 })) === '[]',
)
check(
  'minimum and maximum both fire with their own messages',
  keywords(person({ name: 'ada', age: 121 })).includes('maximum@age')
    && keywords(person({ name: 'ada', age: 3 })).includes('minimum@age'),
  { high: keywords(person({ name: 'ada', age: 121 })), low: keywords(person({ name: 'ada', age: 3 })) },
)
check(
  'minLength and maxLength are enforced on strings',
  keywords(person({ name: 'a', age: 20 })).includes('minLength@name')
    && keywords(person({ name: 'abcdefghijk', age: 20 })).includes('maxLength@name'),
  keywords(person({ name: 'abcdefghijk', age: 20 })),
)
check(
  'pattern is enforced on strings',
  keywords(person({ name: 'ADA', age: 20 })).includes('pattern@name')
    && JSON.stringify(person({ name: 'ada', age: 20 })) === '[]',
  keywords(person({ name: 'ADA', age: 20 })),
)
check(
  'enum lists the allowed values in its message',
  keywords(person({ name: 'ada', age: 20, kind: 'other' })).includes('enum@kind'),
  person({ name: 'ada', age: 20, kind: 'other' }),
)
check(
  'const is enforced with the literal value',
  keywords(person({ name: 'ada', age: 20, tag: 'loose' })).includes('const@tag'),
  person({ name: 'ada', age: 20, tag: 'loose' }),
)
check(
  'additionalProperties: false rejects an unknown property at the root',
  keywords(person({ name: 'ada', age: 20, extra: true })).includes('additionalProperties@extra'),
  keywords(person({ name: 'ada', age: 20, extra: true })),
)
check(
  'additionalProperties: false is enforced inside a nested object too',
  keywords(person({ name: 'ada', age: 20, nested: { x: 1, y: 2 } })).includes('additionalProperties@nested.y'),
  keywords(person({ name: 'ada', age: 20, nested: { x: 1, y: 2 } })),
)
check(
  'minItems and maxItems bound arrays and items validates each element',
  keywords(person({ name: 'ada', age: 20, list: [] })).includes('minItems@list')
    && keywords(person({ name: 'ada', age: 20, list: [1, 2, 3] })).includes('maxItems@list')
    && keywords(person({ name: 'ada', age: 20, list: ['x'] })).includes('type@list[0]'),
  {
    empty: keywords(person({ name: 'ada', age: 20, list: [] })),
    long: keywords(person({ name: 'ada', age: 20, list: [1, 2, 3] })),
    bad: keywords(person({ name: 'ada', age: 20, list: ['x'] })),
  },
)
check(
  'a type union accepts either member and names both on failure',
  (() => {
    const nullable = compileSchema({ type: ['string', 'null'] })
    return JSON.stringify(nullable(null)) === '[]'
      && JSON.stringify(nullable('s')) === '[]'
      && nullable(1)[0].message === 'expected string or null, received number'
  })(),
)
check(
  'a `null` type accepts only null',
  JSON.stringify(compileSchema({ type: 'null' })(null)) === '[]'
    && JSON.stringify(compileSchema({ type: 'null' })(1)) !== '[]',
)

// oneOf — exactly one branch must match, which is how every patch operation is
// validated (a hit on two shapes is as much of an error as a hit on none).
const operationShape = compileSchema({
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['op', 'entityId'], properties: { op: { const: 'entity.remove' }, entityId: { type: 'string' } } },
    { type: 'object', additionalProperties: false, required: ['op', 'cameraId'], properties: { op: { const: 'camera.remove' }, cameraId: { type: 'string' } } },
  ],
})
check(
  'oneOf accepts a value matching exactly one branch',
  JSON.stringify(operationShape({ op: 'entity.remove', entityId: 'x' })) === '[]',
)
check(
  'oneOf rejects a value matching no branch',
  operationShape({ op: 'scene.wipe' })[0].keyword === 'oneOf'
    && operationShape({ op: 'scene.wipe' })[0].path === '<root>'
    && operationShape({ op: 'scene.wipe' })[0].message.includes('matches none of the 2'),
  operationShape({ op: 'scene.wipe' }),
)
check(
  'oneOf rejects a value matching more than one branch',
  (() => {
    const ambiguous = compileSchema({ oneOf: [{ type: 'number' }, { type: 'integer' }] })
    return ambiguous(3)[0].keyword === 'oneOf' && ambiguous(3)[0].message.includes('matches 2 of the 2')
  })(),
  compileSchema({ oneOf: [{ type: 'number' }, { type: 'integer' }] })(3),
)
check(
  'formatIssues renders one `path: message [keyword]` line per issue',
  formatIssues(person({ age: 1 })) === 'name: required property "name" is missing [required]\nage: 1 is below 18 [minimum]',
  formatIssues(person({ age: 1 })),
)
check(
  'formatIssues of an empty issue list is the empty string',
  formatIssues([]) === '',
)

// ---------------------------------------------------------------------------
// compileSchema — $ref resolution
// ---------------------------------------------------------------------------

const referenced = compileSchema({
  $defs: { identifier: { type: 'string', pattern: '^[a-z]+$' } },
  type: 'object',
  required: ['id'],
  properties: { id: { $ref: '#/$defs/identifier' } },
})
check(
  'a local $ref resolves and applies its target constraints',
  JSON.stringify(referenced({ id: 'abc' })) === '[]' && referenced({ id: 'ABC' })[0].keyword === 'pattern',
  referenced({ id: 'ABC' }),
)
check(
  'a $ref whose target does not exist throws SchemaDefinitionError',
  (() => {
    const unresolved = compileSchema({ type: 'object', properties: { id: { $ref: '#/$defs/missing' } } })
    const outcome = caught(() => unresolved({ id: 'abc' }))
    return outcome.error instanceof SchemaDefinitionError
      && outcome.error.message.includes('$ref "#/$defs/missing" does not resolve')
  })(),
)
check(
  'a non-local $ref is refused rather than silently ignored',
  (() => {
    const external = compileSchema({ type: 'object', properties: { id: { $ref: 'other.schema.json#/$defs/id' } } })
    const outcome = caught(() => external({ id: 'abc' }))
    return outcome.error instanceof SchemaDefinitionError && outcome.error.message.includes('only local "#/..." $ref values')
  })(),
)

// ---------------------------------------------------------------------------
// compileSchema — the honest-failure guarantee
//
// "A silently ignored constraint is worse than no validator at all, because it
// converts a rejected scene into an accepted one." Every keyword outside the
// supported subset must therefore fail while loading the SCHEMA.
// ---------------------------------------------------------------------------

for (const [keyword, schema] of [
  ['format', { type: 'string', format: 'email' }],
  ['minProperties', { type: 'object', minProperties: 1 }],
  ['uniqueItems', { type: 'array', uniqueItems: true }],
  ['allOf', { allOf: [{ type: 'string' }] }],
  ['anyOf', { anyOf: [{ type: 'string' }] }],
  ['not', { not: { type: 'string' } }],
  ['contentEncoding', { type: 'string', contentEncoding: 'base64' }],
]) {
  const outcome = compileOrThrow(schema)
  check(
    `the unsupported keyword "${keyword}" throws SchemaDefinitionError at compile time`,
    outcome.error instanceof SchemaDefinitionError
      && outcome.error.name === 'SchemaDefinitionError'
      && outcome.error.message.includes(`unsupported JSON Schema keyword "${keyword}"`),
    outcome.error?.message ?? 'compiled without error',
  )
}

check(
  'an unsupported keyword nested under properties is found by the compile walk',
  (() => {
    const outcome = compileOrThrow({ type: 'object', properties: { a: { type: 'string', format: 'email' } } })
    return outcome.error instanceof SchemaDefinitionError && outcome.error.message.includes('format')
  })(),
)
check(
  'an unsupported keyword nested under $defs is found by the compile walk',
  (() => {
    const outcome = compileOrThrow({ $defs: { a: { type: 'string', contentEncoding: 'base64' } }, type: 'object' })
    return outcome.error instanceof SchemaDefinitionError && outcome.error.message.includes('contentEncoding')
  })(),
)
check(
  'the error names the schema it was loading when an id was supplied',
  (() => {
    const outcome = caught(() => compileSchema({ type: 'string', format: 'email' }, { id: 'my.schema.json' }))
    return outcome.error.message.startsWith('my.schema.json: unsupported JSON Schema keyword "format"')
  })(),
)
check(
  'annotation keywords are accepted even though they enforce nothing',
  (() => {
    const outcome = compileOrThrow({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'annotated.schema.json',
      title: 'Annotated',
      description: 'ignored by design',
      default: 'x',
      examples: ['a'],
      type: 'string',
    })
    return outcome.error === undefined && JSON.stringify(outcome.validate('hi')) === '[]'
  })(),
)
check(
  'an unknown type name is refused rather than treated as unsatisfiable',
  (() => {
    const visit = caught(() => compileSchema({ type: 'strang' })('x'))
    return visit.error instanceof SchemaDefinitionError && visit.error.message.includes('unknown type "strang"')
  })(),
  caught(() => compileSchema({ type: 'strang' })('x')).error?.message,
)
check(
  'an array where a schema object belongs is refused',
  (() => {
    const outcome = compileOrThrow([])
    return outcome.error instanceof SchemaDefinitionError && outcome.error.message.includes('unexpected array')
  })(),
)
check(
  'SchemaDefinitionError is an Error subclass that carries its own name',
  (() => {
    const error = new SchemaDefinitionError('boom')
    return error instanceof Error && error instanceof SchemaDefinitionError
      && error.name === 'SchemaDefinitionError' && error.message === 'boom'
  })(),
)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`canonical contract: ${results.length - failures}/${results.length} check(s) passed`)
if (failures > 0) {
  console.log('Failed checks:')
  for (const result of results) if (!result.ok) console.log(`  - ${result.name}`)
}
process.exit(failures > 0 ? 1 : 0)
