#!/usr/bin/env node
/**
 * M1 contract test — the SCHEMA MIRROR.
 *
 * `deepblend/schemas/*.json` is the authoritative copy: it is what SPEC §5.2
 * points at, what the docs quote, and what a human reviews. The package ships a
 * second copy under `packages/deepblend/contracts/lib/schemas/` so the published
 * `@deepblend/dsh-blender-contracts` is self-contained and does not depend on the
 * repository layout at runtime.
 *
 * That duplication is deliberate and therefore dangerous: nothing about editing
 * the authoritative schema forces anyone to re-copy it. A drifted mirror is the
 * worst sort of defect, because the validator the runtime actually uses would
 * silently enforce a DIFFERENT (usually older, usually weaker) rule set than the
 * one the project believes in — and every green test that used the stale copy
 * would keep passing.
 *
 * This file is the guard: the two copies are asserted byte-identical, and both
 * directories are asserted to contain exactly the same files, so a schema added
 * to one side only is a failure too.
 *
 * Run standalone: `node deepblend/tests/contract/schema-mirror.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { compileSchema } from '@deepblend/dsh-blender-contracts'

// The packaged copies, imported exactly as `scene-spec.js` / `scene-patch.js`
// import them (JSON module, not a filesystem read): if one of them stopped being
// importable, the package would fail at load time in production.
import packagedJobResult from '../../../packages/deepblend/contracts/lib/schemas/job-result.schema.json' with { type: 'json' }
import packagedScenePatch from '../../../packages/deepblend/contracts/lib/schemas/scene-patch.schema.json' with { type: 'json' }
import packagedSceneSpec from '../../../packages/deepblend/contracts/lib/schemas/scene-spec.schema.json' with { type: 'json' }

/** Where SPEC §5.2 says the schemas live. Authoritative. */
const AUTHORITATIVE_DIR = resolve(import.meta.dirname, '..', '..', 'schemas')

/** The copy the package ships. Never authoritative, always enforced. */
const PACKAGED_DIR = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'deepblend', 'contracts', 'lib', 'schemas')

/** Every schema that must be mirrored, with its importable packaged module. */
const MIRRORED_SCHEMAS = [
  { name: 'scene-spec.schema.json', packaged: packagedSceneSpec },
  { name: 'scene-patch.schema.json', packaged: packagedScenePatch },
  { name: 'job-result.schema.json', packaged: packagedJobResult },
]

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

/** Read one schema as raw bytes-as-text, the form the drift guard compares. */
function readSchema(directory, name) {
  return readFileSync(resolve(directory, name), 'utf8')
}

/** Read one schema as raw bytes, for the strongest form of the identity check. */
function readSchemaBytes(directory, name) {
  return readFileSync(resolve(directory, name))
}

/** File names present in a directory, sorted, JSON only. */
function schemaNames(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.json')).sort()
}

// ---------------------------------------------------------------------------
// Both directories hold exactly the same schema files
// ---------------------------------------------------------------------------

const authoritativeNames = schemaNames(AUTHORITATIVE_DIR)
const packagedNames = schemaNames(PACKAGED_DIR)

check(
  'deepblend/schemas holds the three v1 schemas',
  JSON.stringify(authoritativeNames) === JSON.stringify([
    'job-result.schema.json', 'scene-patch.schema.json', 'scene-spec.schema.json',
  ]),
  authoritativeNames,
)
check(
  'the packaged schema directory lists exactly the same files',
  JSON.stringify(packagedNames) === JSON.stringify(authoritativeNames),
  { authoritative: authoritativeNames, packaged: packagedNames },
)
check(
  'every mirrored schema exists on both sides',
  MIRRORED_SCHEMAS.every(entry => authoritativeNames.includes(entry.name) && packagedNames.includes(entry.name)),
  MIRRORED_SCHEMAS.map(entry => entry.name),
)

// ---------------------------------------------------------------------------
// Byte-for-byte identity — the actual drift guard
// ---------------------------------------------------------------------------

for (const entry of MIRRORED_SCHEMAS) {
  const authoritative = readSchema(AUTHORITATIVE_DIR, entry.name)
  const packaged = readSchema(PACKAGED_DIR, entry.name)

  check(
    `${entry.name} is byte-identical in deepblend/schemas and the packaged mirror`,
    authoritative === packaged,
    authoritative === packaged
      ? `${authoritative.length} bytes`
      : { authoritativeBytes: authoritative.length, packagedBytes: packaged.length },
  )
  check(
    `${entry.name} has no trailing whitespace or line-ending drift`,
    authoritative.endsWith('\n') === packaged.endsWith('\n')
      && !authoritative.includes('\r')
      && !packaged.includes('\r'),
  )
  check(
    `${entry.name} is byte-identical when compared as raw bytes`,
    readSchemaBytes(AUTHORITATIVE_DIR, entry.name).equals(readSchemaBytes(PACKAGED_DIR, entry.name)),
    {
      authoritativeBytes: readSchemaBytes(AUTHORITATIVE_DIR, entry.name).length,
      packagedBytes: readSchemaBytes(PACKAGED_DIR, entry.name).length,
    },
  )
}

// ---------------------------------------------------------------------------
// The packaged copies are importable, addressable schema modules
// ---------------------------------------------------------------------------

for (const entry of MIRRORED_SCHEMAS) {
  check(
    `the packaged ${entry.name} imports as a JSON module with a $id`,
    typeof entry.packaged === 'object'
      && entry.packaged !== null
      && typeof entry.packaged.$id === 'string'
      && entry.packaged.$id.length > 0,
    entry.packaged?.$id,
  )
  check(
    `the packaged ${entry.name} declares $defs`,
    typeof entry.packaged.$defs === 'object' && entry.packaged.$defs !== null,
    Object.keys(entry.packaged.$defs ?? {}).length,
  )
  check(
    `the packaged ${entry.name} $id ends with its file name`,
    entry.packaged.$id.endsWith(entry.name),
    entry.packaged.$id,
  )
  check(
    `the imported ${entry.name} module matches the authoritative bytes`,
    JSON.stringify(entry.packaged) === JSON.stringify(JSON.parse(readSchema(AUTHORITATIVE_DIR, entry.name))),
  )
  check(
    `the imported ${entry.name} module matches the packaged bytes`,
    JSON.stringify(entry.packaged) === JSON.stringify(JSON.parse(readSchema(PACKAGED_DIR, entry.name))),
  )
}

// ---------------------------------------------------------------------------
// The mirror is a schema this validator can actually compile
//
// `compileSchema` throws `SchemaDefinitionError` for any keyword it does not
// enforce, so this proves the mirrored documents are inside the supported
// subset — a mirror that compiled to a silently weaker validator would be the
// same defect as a stale copy.
// ---------------------------------------------------------------------------

for (const entry of MIRRORED_SCHEMAS) {
  check(
    `the packaged ${entry.name} compiles without an unsupported keyword`,
    (() => {
      try {
        compileSchema(entry.packaged, { id: entry.name })
        return true
      } catch (error) {
        return false
      }
    })(),
  )
}

const structuralSceneSpec = compileSchema(packagedSceneSpec, { id: 'scene-spec.schema.json' })
const structuralScenePatch = compileSchema(packagedScenePatch, { id: 'scene-patch.schema.json' })

check(
  'the packaged scene-spec schema rejects a document missing its required blocks',
  (() => {
    const issues = structuralSceneSpec({ schemaVersion: 'deepblend.scene/v1' })
    return issues.some(issue => issue.keyword === 'required' && issue.path === 'project')
  })(),
)
check(
  'the packaged scene-patch schema rejects a patch with no operations',
  (() => {
    const issues = structuralScenePatch({ projectId: 'p', baseRevision: 'r0001', operations: [] })
    return issues.some(issue => issue.keyword === 'minItems' && issue.path === 'operations')
  })(),
)

// ---------------------------------------------------------------------------
// Packaging boundary
//
// The mirror is reachable by path (that is how the package itself imports it)
// but is deliberately NOT part of the package's public `exports` map, so no
// consumer can depend on a schema file's location. Pinned because "add the
// schemas to exports" would be a wire-visible change.
// ---------------------------------------------------------------------------

const subpathImport = await import('@deepblend/dsh-blender-contracts/lib/schemas/scene-spec.schema.json')
  .then(() => undefined, error => error)
check(
  'the schema mirror is not exposed through the package exports map',
  subpathImport !== undefined && subpathImport.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  subpathImport?.code ?? 'import unexpectedly succeeded',
)

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
console.log(`schema-mirror contract: ${results.length - failures}/${results.length} check(s) passed`)
if (failures > 0) {
  console.log('Failed checks:')
  for (const result of results) if (!result.ok) console.log(`  - ${result.name}`)
}
process.exit(failures > 0 ? 1 : 0)
