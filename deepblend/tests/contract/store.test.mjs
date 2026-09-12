/**
 * Project Store, Revision Store, path guard and idempotency ledger.
 *
 * These are unit tests — no Blender, no subprocess. They cover the parts of M1
 * that decide whether a write is SAFE, which is exactly the set of behaviours
 * that must hold on a machine where Blender is absent or broken: a conflict must
 * still be refused, an idempotent retry must still not double-apply, and no
 * caller-supplied id may still escape the projects root.
 *
 * Run: node deepblend/tests/contract/store.test.mjs
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProjectStore,
  formatRevisionId,
  parseRevisionId,
  GENESIS_REVISION,
} from '@deepblend/dsh-blender-host'
import {
  resolveInside,
  requireSafeSegment,
  slugifyProjectId,
  writeFileAtomic,
  readJson,
  safeRealpath,
} from '@deepblend/dsh-blender-host/paths'
import {
  deriveIdempotencyKey,
  resolveIdempotencyKey,
  defaultSceneSpec,
} from '@deepblend/dsh-blender-host/revision-transaction'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/** A throwaway workspace so nothing here can touch a real project store. */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-store-'))
  return {
    root,
    store: new ProjectStore({ projectsRoot: join(root, 'projects'), workspaceRoot: root }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// Revision ids
// ---------------------------------------------------------------------------

check('revision ids are zero padded so directory listings sort chronologically',
  formatRevisionId(1) === 'r0001' && formatRevisionId(42) === 'r0042', formatRevisionId(42))

check('revision id padding widens rather than truncating past 9999',
  formatRevisionId(12345) === 'r12345', formatRevisionId(12345))

check('parseRevisionId accepts only real revision ids',
  parseRevisionId('r0007') === 7 && parseRevisionId('r0000') === null && parseRevisionId('nope') === null
    && parseRevisionId('r001x') === null && parseRevisionId(7) === null,
  [parseRevisionId('r0007'), parseRevisionId('r0000'), parseRevisionId('nope')])

check('GENESIS_REVISION is not a real revision id',
  GENESIS_REVISION === 'r0000' && parseRevisionId(GENESIS_REVISION) === null)

// ---------------------------------------------------------------------------
// Path guard (SPEC §15.2)
// ---------------------------------------------------------------------------

const segments = [
  ['../evil', 'traversal'],
  ['..', 'the parent token'],
  ['a/b', 'a slash'],
  ['a\\b', 'a backslash'],
  ['', 'empty'],
  ['C:windows', 'a drive-relative path'],
  ['nul\0byte', 'a NUL byte'],
]
for (const [value, label] of segments) {
  let code = null
  try {
    requireSafeSegment(value, 'project id')
  } catch (error) {
    code = error.code
  }
  check(`requireSafeSegment rejects ${label}`, code === 'PATH_SEGMENT_INVALID', code)
}

check('requireSafeSegment accepts a normal id, including a dotfile-style name',
  requireSafeSegment('watch-commercial', 'project id') === 'watch-commercial'
    && requireSafeSegment('.staging-r0001', 'staging dir') === '.staging-r0001')

{
  const { root, dispose } = makeWorkspace()
  try {
    const inside = join(root, 'projects', 'a')
    check('resolveInside accepts a contained path',
      resolveInside(root, inside, 'test') === safeRealpath(inside))

    let escaped = null
    try {
      resolveInside(root, join(root, '..', 'outside'), 'test')
    } catch (error) {
      escaped = error.code
    }
    check('resolveInside rejects a path that escapes the root', escaped === 'PATH_OUTSIDE_WORKSPACE', escaped)
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Project ids
// ---------------------------------------------------------------------------

check('slugifyProjectId produces a usable id from a title',
  slugifyProjectId('Watch Commercial') === 'watch-commercial'
    && slugifyProjectId('  Product turntable — brushed steel  ') === 'product-turntable-brushed-steel',
  slugifyProjectId('  Product turntable — brushed steel  '))

check('slugifyProjectId falls back to a fixed name when no ASCII survives',
  slugifyProjectId('智能手表') === 'project' && slugifyProjectId('') === 'project',
  slugifyProjectId('智能手表'))

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

{
  const { root, dispose } = makeWorkspace()
  try {
    const target = join(root, 'nested', 'value.json')
    writeFileAtomic(target, '{"a":1}\n')
    check('writeFileAtomic creates missing parent directories', existsSync(target))

    writeFileAtomic(target, '{"a":2}\n')
    check('writeFileAtomic replaces an existing file', JSON.parse(readFileSync(target, 'utf8')).a === 2)

    const leftovers = readdirSafe(join(root, 'nested')).filter(name => name.includes('.tmp-'))
    check('writeFileAtomic leaves no temporary file behind', leftovers.length === 0, leftovers)

    check('readJson returns null for an absent file', readJson(join(root, 'missing.json')) === null)

    const corrupt = join(root, 'corrupt.json')
    writeFileSync(corrupt, '{not json')
    let code = null
    try {
      readJson(corrupt)
    } catch (error) {
      code = error.code
    }
    check('readJson THROWS on corruption instead of reporting absence', code === 'REVISION_CORRUPT', code)
  } finally {
    dispose()
  }
}

/** readdir that tolerates absence — a missing directory has no entries. */
function readdirSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Project store
// ---------------------------------------------------------------------------

{
  const { root, store, dispose } = makeWorkspace()
  try {
    store.ensureRoot()
    const id = store.allocateProjectId('Watch Commercial')
    check('allocateProjectId derives an id from the title', id === 'watch-commercial', id)

    store.createSkeleton(id)
    const now = new Date().toISOString()
    store.writeRecord(id, {
      schemaVersion: 'deepblend.project/v1',
      projectId: id,
      title: 'Watch Commercial',
      goal: null,
      createdAt: now,
      updatedAt: now,
      currentRevision: 'r0001',
      revisionCount: 1,
    })

    check('exists() reports a project with a record', store.exists(id) === true)
    check('readRecord returns the stored record', store.readRecord(id).title === 'Watch Commercial')
    check('currentRevision reads through to the record', store.currentRevision(id) === 'r0001')

    const second = store.allocateProjectId('Watch Commercial')
    check('allocateProjectId disambiguates a collision instead of failing', second === 'watch-commercial-2', second)

    check('listProjectIds finds the project and ignores the index file',
      store.listProjectIds().includes(id), store.listProjectIds())

    check('nextRevisionId starts at r0001 for an empty project', store.nextRevisionId(id) === 'r0001')

    let missing = null
    try {
      store.readRecord('does-not-exist')
    } catch (error) {
      missing = error.code
    }
    check('readRecord on an unknown project gives PROJECT_NOT_FOUND', missing === 'PROJECT_NOT_FOUND', missing)

    let traversal = null
    try {
      store.readRecord('../escape')
    } catch (error) {
      traversal = error.code
    }
    check('the store refuses a project id that is a traversal token',
      traversal === 'PATH_SEGMENT_INVALID', traversal)

    let badRevision = null
    try {
      store.revisionDirectory(id, 'latest')
    } catch (error) {
      badRevision = error.code
    }
    check('revisionDirectory refuses a non-revision id', badRevision === 'REVISION_ID_INVALID', badRevision)
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

{
  const base = { projectId: 'p', baseRevision: 'r0001', operations: [{ op: 'entity.remove', entityId: 'x' }] }

  const derived = deriveIdempotencyKey(base)
  check('a derived idempotency key is stable for identical intent',
    deriveIdempotencyKey({ ...base }) === derived, derived.slice(0, 20))

  check('the derived key changes when an operation changes',
    deriveIdempotencyKey({ ...base, operations: [{ op: 'entity.remove', entityId: 'y' }] }) !== derived)

  check('the derived key changes when the base revision changes',
    deriveIdempotencyKey({ ...base, baseRevision: 'r0002' }) !== derived)

  check('the derived key changes when the actor or stage changes',
    deriveIdempotencyKey({ ...base, actor: 'a' }) !== derived
      && deriveIdempotencyKey({ ...base, stage: 'PATCH' }) !== derived)

  check('the derived key is independent of object key order',
    deriveIdempotencyKey({
      operations: base.operations,
      baseRevision: base.baseRevision,
      projectId: base.projectId,
    }) === derived)

  check('an explicit idempotency key is honoured over the derived one',
    resolveIdempotencyKey({ ...base, idempotencyKey: 'run-38' }).key === 'run-38'
      && resolveIdempotencyKey({ ...base, idempotencyKey: 'run-38' }).derived === false)

  check('a blank idempotency key falls back to the derived one',
    resolveIdempotencyKey({ ...base, idempotencyKey: '   ' }).derived === true)
}

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

{
  const { store, dispose } = makeWorkspace()
  try {
    store.ensureRoot()
    const id = store.allocateProjectId('Ledger')
    store.createSkeleton(id)

    check('an unused key has no record', store.readIdempotencyRecord(id, 'k1') === null)

    store.writeIdempotencyRecord(id, 'k1', { outcome: { revision: 'r0001' }, kind: 'scene_patch' })
    const record = store.readIdempotencyRecord(id, 'k1')
    check('a written record round-trips its outcome', record?.outcome?.revision === 'r0001')
    check('the record keeps the raw key readable for audit', record?.idempotencyKey === 'k1')

    // A key is caller-supplied free text; the ledger must not care what is in it.
    const hostile = '../../etc/passwd with spaces and \\ backslashes'
    store.writeIdempotencyRecord(id, hostile, { outcome: { revision: 'r0002' } })
    check('a hostile-looking idempotency key is hashed, not used as a path',
      store.readIdempotencyRecord(id, hostile)?.outcome?.revision === 'r0002')

    const operations = readdirSafe(join(store.projectDirectory(id), 'operations'))
    check('every ledger file name is a plain hex digest',
      operations.length === 2 && operations.every(name => /^[a-f0-9]{32}\.json$/.test(name)), operations)
  } finally {
    dispose()
  }
}

// ---------------------------------------------------------------------------
// Default scene scaffold
// ---------------------------------------------------------------------------

{
  const spec = defaultSceneSpec({ projectId: 'p', title: 'T', goal: 'g' })
  check('the default scaffold carries the requested identity',
    spec.project.id === 'p' && spec.project.title === 'T' && spec.project.goal === 'g')
  check('the default scaffold has geometry, a light and a camera',
    spec.entities.length === 1 && spec.lights.length === 1 && spec.cameras.length === 1)
  check('the default scaffold defines both render profiles',
    spec.renderProfiles.preview !== undefined && spec.renderProfiles.final !== undefined)
  check('the default camera aims at the subject',
    spec.cameras[0].targetEntityId === spec.entities[0].id)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
const failures = results.filter(entry => !entry.ok)
console.log(`M1 store suite: ${results.length - failures.length}/${results.length} checks passed`)
if (failures.length > 0) {
  console.log('Failed:')
  for (const entry of failures) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
