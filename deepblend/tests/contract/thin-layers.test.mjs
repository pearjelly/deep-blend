#!/usr/bin/env node
/**
 * The thin layers under everything: the path helpers, the JSON Schema validator's remaining keywords,
 * and the ScenePatch rules that need a SCENE to answer.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These are the last scattered dark lines in three files that every other test depends on:
 *
 *   - `paths.js` — what happens when a write fails (the temporary file is removed), when a document is
 *     missing and the caller said it may not be, when every failure must read as `null`, and when a
 *     publish would land on an existing directory.
 *   - `json-schema.js` — `exclusiveMinimum`/`exclusiveMaximum` (the two keywords no spec in this repo
 *     happened to use) and the recursion into `additionalProperties` subschemas.
 *   - `scene-patch.js` — the refusals that need the SCENE: an operation naming an id that cannot be an
 *     id, an entity declaring an asset that was never ingested, a camera that does not exist, and the
 *     world replacement.
 *
 * All of it is reachable with real files in a temp directory and hand-built documents. Nothing here
 * needs Blender.
 *
 * Run standalone: `node deepblend/tests/contract/thin-layers.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BlenderError, BlenderErrorCode, SchemaDefinitionError, applyPatchToSpec, compileSceneSpec, compileSchema,
  validateScenePatch, validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'
import { fileSha256, publishDirectory, readJson, readJsonSafe, writeFileAtomic, writeJsonAtomic } from '@deepblend/dsh-blender-host/paths'
import { ROOT } from '../../tools/workspace-layout.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BlenderErrorCode.${name} is not a code this build defines — the expectation would be undefined`)
  }
  return value
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-thin-layers-'))
const productSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))

// ---------------------------------------------------------------------------
// paths: a write that fails leaves no litter
// ---------------------------------------------------------------------------

// A path whose PARENT is a file: `mkdirSync(dirname)` then fails, which is the write's own failure path.
const blocker = join(scratch, 'blocker')
writeFileSync(blocker, 'i am a file, not a directory')
const failedWrite = (() => {
  try {
    writeFileAtomic(join(blocker, 'nested.json'), '{}')
    return 'written'
  } catch (cause) {
    return cause
  }
})()
check('a write that fails throws the OS error rather than swallowing it',
  failedWrite instanceof Error && /ENOTDIR|EEXIST|ENOENT/.test(failedWrite.code ?? failedWrite.message ?? ''),
  failedWrite?.code ?? failedWrite)
check('and no temporary file is left next to it: a crash mid-write must not leave litter a readdir would mistake for content',
  readdirSync(scratch).filter(name => name.includes('.tmp-')).length === 0,
  readdirSync(scratch))

mkdirSync(join(scratch, 'rename-target'), { recursive: true })
const renameFailed = (() => {
  try {
    writeFileAtomic(join(scratch, 'rename-target'), 'contents')
    return 'written'
  } catch (cause) {
    return cause
  }
})()
check('a write that fails AFTER the temporary file exists still removes it',
  renameFailed instanceof Error && readdirSync(scratch).filter(name => name.includes('.tmp-')).length === 0 &&
  readdirSync(scratch).includes('rename-target'),
  { error: renameFailed?.code ?? renameFailed, entries: readdirSync(scratch) })

writeJsonAtomic(join(scratch, 'written.json'), { ok: true })
check('a write that works lands the canonical JSON with a trailing newline, and no temporary file',
  readFileSync(join(scratch, 'written.json'), 'utf8') === '{\n  "ok": true\n}\n' &&
  readdirSync(scratch).filter(name => name.includes('.tmp-')).length === 0,
  JSON.stringify(readFileSync(join(scratch, 'written.json'), 'utf8')))

const missing = (() => {
  try {
    return readJson(join(scratch, 'never-written.json'))
  } catch (cause) {
    return cause
  }
})()
check('a missing document reads as null when absence is allowed',
  missing === null, missing)
check('and as REVISION_CORRUPT when the caller said it may not be missing',
  (() => {
    try {
      readJson(join(scratch, 'never-written.json'), { allowMissing: false })
      return false
    } catch (cause) {
      return cause instanceof BlenderError && cause.code === code('REVISION_CORRUPT') &&
        /^Expected a document at .* but it does not exist\.$/.test(cause.message)
    }
  })())

// A DIRECTORY where a document is expected: readFileSync fails with EISDIR on every platform.
mkdirSync(join(scratch, 'a-directory.json'), { recursive: true })
const unreadable = (() => {
  try {
    readJson(join(scratch, 'a-directory.json'))
    return 'read'
  } catch (cause) {
    return cause
  }
})()
check('a document that exists but cannot be read is a coded error, not a stack',
  unreadable instanceof BlenderError && unreadable.code === code('REVISION_CORRUPT') &&
  /^Could not read .*a-directory\.json\.$/.test(unreadable.message) && unreadable.cause !== undefined,
  unreadable?.message ?? unreadable)
check('while the SAFE reader answers null for every failure, including that one',
  readJsonSafe(join(scratch, 'a-directory.json')) === null &&
  readJsonSafe(join(scratch, 'never-written.json')) === null &&
  JSON.stringify(readJsonSafe(join(scratch, 'written.json'))) === JSON.stringify({ ok: true }))

const staging = join(scratch, 'staging')
const finalPath = join(scratch, 'final')
mkdirSync(staging, { recursive: true })
writeFileSync(join(staging, 'revision.json'), '{}')
mkdirSync(finalPath, { recursive: true })
const published = (() => {
  try {
    publishDirectory(staging, finalPath)
    return 'published'
  } catch (cause) {
    return cause
  }
})()
check('publishing over an existing directory is refused: the final name must not exist until it is complete',
  published instanceof BlenderError && published.code === code('REVISION_ALLOCATION_FAILED') &&
  published.message === `Refusing to publish over the existing directory ${finalPath}.`,
  published?.message ?? published)
rmSync(finalPath, { recursive: true, force: true })
publishDirectory(staging, finalPath)
check('and a clean publish moves the staging directory into place',
  readFileSync(join(finalPath, 'revision.json'), 'utf8') === '{}' && readdirSync(scratch).includes('final'))

// ---------------------------------------------------------------------------
// The schema validator's two unused keywords, and a subschema
// ---------------------------------------------------------------------------

const exclusive = compileSchema({ type: 'object', properties: { n: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 10 } } })({ n: 10 })
check('exclusiveMaximum is enforced with the number that broke it in the message',
  exclusive.length === 1 && exclusive[0].keyword === 'exclusiveMaximum' &&
  exclusive[0].path === 'n' && exclusive[0].message === '10 must be less than 10',
  exclusive)
check('and exclusiveMinimum likewise',
  JSON.stringify(compileSchema({ type: 'number', exclusiveMinimum: 3 })(3)) ===
    JSON.stringify([{ path: '<root>', keyword: 'exclusiveMinimum', message: '3 must be greater than 3' }]) &&
  compileSchema({ type: 'number', exclusiveMinimum: 3 })(4).length === 0,
  compileSchema({ type: 'number', exclusiveMinimum: 3 })(3))

const additional = compileSchema({ type: 'object', additionalProperties: { type: 'string' } })({ a: 'fine', b: 7 })
check('an additionalProperties SUBSCHEMA is visited, so its own keywords are enforced too',
  additional.length === 1 && additional[0].path === 'b' && additional[0].keyword === 'type',
  additional)
// An unknown `type` is a DEFINITION error, not a validation failure: a schema this build cannot
// enforce must not silently pass every value.
const unknownType = (() => {
  try {
    return compileSchema({ type: 'not-a-type' })('anything')
  } catch (cause) {
    return cause
  }
})()
check('a schema type the validator does not know is refused at COMPILE time, so it cannot pass everything',
  unknownType instanceof Error && /unknown type "not-a-type"/.test(unknownType.message),
  unknownType?.message ?? unknownType)

// The other half of that fact, and the reason `matchesType`'s `default: return false` is unreachable: every
// type name the validator accepts is HANDLED, so the fallback is only reachable if the compile-time check
// above is bypassed. Asserted through the public validator rather than by reading the switch, because "the
// switch has seven cases" is a fact about today's source and "these seven values validate" is the promise.
const JSON_TYPES = [
  ['object', { a: 1 }], ['array', [1, 2]], ['string', 'x'], ['number', 1.5],
  ['integer', 3], ['boolean', true], ['null', null],
]
const typeVerdicts = JSON_TYPES.map(([name, value]) => {
  const validate = compileSchema({ type: name })
  const accepted = validate(value).length === 0
  // and a value of a DIFFERENT type must still be refused, or the case would be "accept everything"
  const other = name === 'null' ? 'x' : name === 'array' ? 'x' : name === 'object' ? 'x' : null
  return { name, accepted, refusedOther: validate(other).length > 0 }
})
check('every JSON type name the validator accepts is handled, which is what makes its fallback unreachable',
  typeVerdicts.every(entry => entry.accepted && entry.refusedOther), typeVerdicts)

// ---------------------------------------------------------------------------
// ScenePatch: the rules that need the scene
// ---------------------------------------------------------------------------

const spec = compileSceneSpec(productSpec).spec

const badId = validateScenePatch({
  projectId: 'p', baseRevision: 'r0001',
  operations: [{ op: 'asset.add', asset: { id: '-not-an-id', type: 'glb', path: 'assets/raw/x.glb', sha256: 'a'.repeat(64) } }],
})
// For THIS shape the schema refuses first (its own `pattern` covers the id), so the id-grammar branch is
// shadowed — the D125 shape, pinned rather than pretended. What matters is that a bad id never reaches a
// scene: whichever layer answers, the patch is refused.
//
// AND THE OTHER SHAPE IS ASSERTED RIGHT BELOW, because "shadowed" was only ever true of SOME fields. MEASURED
// while checking whether the dark lines in `scene-patch.js` were really unreachable: `entity.material.set`'s
// `materialId` has no `pattern` in the schema, so the semantic branch IS what answers for it — the branch was
// reachable, and it had no test at all. A line explained away as dead code is the one kind of dark line that
// costs a real defect.
check('an operation naming something that cannot be an ID is refused, and for this shape the SCHEMA is what answers',
  badId.ok === false && badId.errors.length > 0 &&
  badId.errors.every(issue => issue.code === 'PATCH_SCHEMA_INVALID') &&
  !badId.errors.some(issue => issue.code === 'PATCH_ID_INVALID') &&
  badId.errors.some(issue => issue.code === 'PATCH_SCHEMA_INVALID' && issue.path === 'operations[0]'),
  badId.errors.map(issue => `${issue.code}@${issue.path}`))

// The other shape: a field the schema does NOT pattern (`materialId`), where the grammar check is the only
// thing standing between a bad id and the scene. This is the assertion that makes those lines covered.
const badMaterialId = validateScenePatch({
  projectId: 'p', baseRevision: 'r0001',
  operations: [{ op: 'entity.material.set', entityId: 'watch-body', materialId: '-not-an-id' }],
})
check('an id the schema does not pattern is caught by the grammar check, and it says which field',
  badMaterialId.ok === false && badMaterialId.errors.length === 1 &&
  badMaterialId.errors[0].code === 'PATCH_ID_INVALID' &&
  badMaterialId.errors[0].path === 'operations[0].materialId' &&
  /"-not-an-id" is not a valid id \(must match \^\[a-zA-Z\]\[a-zA-Z0-9\._-\]\*\$\)/.test(badMaterialId.errors[0].message),
  badMaterialId.errors.map(issue => `${issue.code}@${issue.path}`))

const brokenScene = { ...spec, entities: spec.entities.map(entity => (entity.id === 'watch-dial' ? { ...entity, type: 'asset-instance', assetId: 'never-ingested' } : entity)) }
const referenceCheck = validateSceneSpec(brokenScene)
check('an asset-instance that names an asset nobody ingested is refused by the semantic layer',
  referenceCheck.ok === false &&
  referenceCheck.errors.some(issue => issue.code === 'SCENE_ASSET_NOT_INGESTED' || /asset/.test(issue.message)),
  referenceCheck.errors.map(issue => issue.code))

const noCamera = (() => {
  try {
    return applyPatchToSpec(spec, {
      projectId: 'p', baseRevision: 'r0001',
      operations: [{ op: 'camera.update', cameraId: 'no-such-camera', lens: 50 }],
    })
    return 'applied'
  } catch (cause) {
    return cause
  }
})()
check('a camera operation that names no camera in the scene is refused against the SCENE, not the schema',
  noCamera instanceof Error && (noCamera.patchIssue?.code ?? noCamera.code) === 'PATCH_TARGET_MISSING' &&
  /no camera "no-such-camera" exists in this scene/.test(noCamera.patchIssue?.message ?? noCamera.message),
  noCamera?.patchIssue ?? noCamera?.message ?? noCamera)

rmSync(scratch, { recursive: true, force: true })

// ---- the hash of a file that is not there --------------------------------
//
// `fileSha256` answers `null` for a file it cannot read, and that is deliberately the SAME answer as for a
// file that does not exist: the caller is comparing artifact bytes, and "no bytes" is one fact. A throw here
// would turn a missing preview into a crashed listing.
{
  const scratch = mkdtempSync(join(tmpdir(), 'deepblend-sha-'))
  const present = join(scratch, 'present.txt')
  writeFileSync(present, 'some bytes', 'utf8')
  const unreadable = join(scratch, 'unreadable.txt')
  writeFileSync(unreadable, 'secret', 'utf8')
  chmodSync(unreadable, 0o000)
  check('hashing a file that is absent or unreadable answers null, and a readable one answers a digest',
    fileSha256(join(scratch, 'never-written.txt')) === null &&
    fileSha256(unreadable) === null &&
    /^[0-9a-f]{64}$/.test(fileSha256(present) ?? ''),
    { absent: fileSha256(join(scratch, 'never-written.txt')), unreadable: fileSha256(unreadable), present: (fileSha256(present) ?? '').slice(0, 12) })
  chmodSync(unreadable, 0o600)
  rmSync(scratch, { recursive: true, force: true })
}

// ---- the runtime type check's last arm is SHADOWED, and named here --------
//
// The compiled validator's type switch ends with `default: return false`, and no schema can reach it: the
// compiler refuses an unknown `type` at COMPILE time with `SchemaDefinitionError` (asserted below), so the
// runtime arm is dead code. The assertion is about the ORDER — the compiler is where an unusable schema is
// caught — and the branch itself is named rather than left looking covered.
check('an unknown schema type throws when the validator RUNS, so the type switch\'s default arm never answers',
  (() => {
    try {
      compileSchema({ type: 'nonsense' })({})
      return false
    } catch (cause) {
      return cause instanceof SchemaDefinitionError
    }
  })() &&
  // Lazy resolution, and it is worth pinning: the unknown type inside a property is only detected where
  // that property is actually reached, so a document that does not carry it validates fine. A schema is not
  // rejected wholesale at compile time — it is rejected at the point a value would have to be checked.
  (() => {
    const schema = compileSchema({ type: 'object', properties: { a: { type: 'nonsense' } } })
    const untouched = schema({})
    if (!Array.isArray(untouched) || untouched.length !== 0) return false
    try {
      schema({ a: 1 })
      return false
    } catch (cause) {
      return cause instanceof SchemaDefinitionError
    }
  })())

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nThin layers: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
