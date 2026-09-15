#!/usr/bin/env node
/**
 * The host's revision surface: reading one revision, reading two, and answering "would this patch
 * apply?" BEFORE the caller spends a revision on it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `getRevisionDetail` and `readRevisionPair` are the two reads the M4 workbench is built on (the
 * diff view asks for a pair; the detail panel asks for one), and `validateScene` with a patch is the
 * dry run a model is told to use instead of guessing. All three were dark in the coverage reading:
 * 55 lines across the three methods, because nothing called them against a store that had a project
 * in it — the composition suites drive them through a REAL host, which needs Blender, and the store
 * suite tests the store rather than the service that reads it.
 *
 * NO BLENDER IS NEEDED HERE, and that is the point of the fixture. A revision with
 * `saveCheckpoint: false` is a legitimate state — the SceneSpec is the source of truth and the .blend
 * is derived — and it is committed without launching Blender at all. So a project is created and
 * patched here through the host's OWN transaction, with a runtime that would throw if anything
 * reached for it, and every branch of the dry run is then reachable in a fraction of a second.
 *
 * The dry-run branches are the interesting half: an ill-formed patch, a patch for the wrong base
 * revision, a patch that applies cleanly, and a patch that applies but leaves the scene invalid. Each
 * produces a DIFFERENT set of canonical issues, and the difference is the whole value of a dry run —
 * a version that answered all four the same way would still pass a test that only checked "no crash".
 *
 * Run standalone: `node deepblend/tests/contract/host-revision-reads.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
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

const issueCodes = report => report.errors.map(issue => issue.code)
const noticeCodes = report => report.notices.map(notice => notice.code)

// ---------------------------------------------------------------------------
// A project with two revisions, committed without Blender
// ---------------------------------------------------------------------------

const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-revision-reads-'))
let runtimeCalls = 0
const runtime = new Proxy({}, {
  get: () => async () => {
    runtimeCalls += 1
    throw new Error('this fixture commits spec-only revisions; nothing may reach the Blender runtime')
  },
})

const ctx = new Context()
ctx.provide('blenderRuntime', runtime)
const studio = new BlenderStudio(ctx, StudioConfig({
  workspaceRoot,
  projectsRoot: join(workspaceRoot, 'projects'),
}))

/** The product fixture, so the scene under test is a real one. */
const productSpec = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8'))

const created = await studio.transactions.createProject({
  title: 'watch commercial',
  goal: 'a turntable for the launch film',
  sceneSpec: productSpec,
  saveCheckpoint: false,
})
const projectId = created.projectId
const first = created.revision.revision

// `saveCheckpoint: false` is what keeps Blender out of this fixture, and it is a documented field of
// the patch document rather than a test-only switch: a scene edit that has not been rendered yet is a
// legitimate revision, and the SceneSpec is the source of truth (the .blend is derived from it).
const patch = {
  projectId,
  baseRevision: first,
  actor: 'test',
  stage: 'MODEL',
  note: 'move the hero forward',
  saveCheckpoint: false,
  operations: [{ op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.4, 0.02] }],
}
const patched = await studio.transactions.applyScenePatch(patch, {})
const second = patched.revision.revision

check('the fixture commits two revisions with no Blender at all',
  first === 'r0001' && second === 'r0002' && runtimeCalls === 0,
  { first, second, runtimeCalls })
check('and the second one records the first as its base revision, which is what a diff needs',
  studio.store.readRevisionManifest(projectId, second)?.baseRevision === first,
  studio.store.readRevisionManifest(projectId, second)?.baseRevision)

// ---------------------------------------------------------------------------
// One revision in full
// ---------------------------------------------------------------------------

const detail = await studio.getRevisionDetail({ projectId })
check('reading a revision defaults to the CURRENT one and says so',
  detail.projectId === projectId && detail.revision === second && detail.isCurrent === true,
  { revision: detail.revision, isCurrent: detail.isCurrent })
check('it returns the manifest and a scene summary built from the stored spec',
  detail.manifest?.digest !== undefined && detail.scene?.revision === second &&
  detail.scene?.revisionNumber === 2 && Array.isArray(detail.scene?.entities),
  { digest: detail.manifest?.digest?.slice(0, 16), entities: detail.scene?.entities?.length })
check('a revision that was never compiled reports NO checkpoint rather than a path to one',
  detail.checkpoint === null,
  detail.checkpoint)
check('and it reports no previews, sheets or reviews rather than inventing empty ones',
  JSON.stringify(detail.previews) === '[]' && JSON.stringify(detail.contactSheets) === '[]' && JSON.stringify(detail.reviews) === '[]',
  { previews: detail.previews, contactSheets: detail.contactSheets, reviews: detail.reviews })
check('it carries the three per-revision documents a spec-only revision still writes',
  detail.validation?.semantic?.ok === true && detail.validation?.technical === null &&
  detail.operations?.operationCount === 1 && detail.operations?.operations?.[0]?.target === 'watch-body' &&
  detail.request?.note === 'move the hero forward',
  { validation: detail.validation?.schemaVersion, operations: detail.operations?.operationCount, request: detail.request?.note })

const old = await studio.getRevisionDetail({ projectId, revision: first })
check('asking for an OLDER revision answers about that revision and marks it as not current',
  old.revision === first && old.isCurrent === false && old.scene?.revisionNumber === 1,
  { revision: old.revision, isCurrent: old.isCurrent })

const missing = await studio.getRevisionDetail({ projectId, revision: 'r0099' }).catch(cause => cause)
// The MESSAGE is asserted, not just the code: without the guard the store raises its own
// REVISION_NOT_FOUND a few lines later, so a check that only looked at the code could not tell the
// method's own refusal from the one it delegates to (a mutation proved exactly that).
check('asking for a revision that does not exist is refused by the method, naming both ids',
  missing instanceof BlenderError && missing.code === code('REVISION_NOT_FOUND') &&
  missing.detail?.projectId === projectId && missing.detail?.revision === 'r0099' &&
  missing.message === `Project "${projectId}" has no revision "r0099".`,
  missing?.message)

const emptyProject = await studio.transactions.createProject({ title: 'empty', saveCheckpoint: false })
studio.store.writeRecord(emptyProject.projectId, { ...studio.store.readRecord(emptyProject.projectId), currentRevision: null, revisionCount: 0 })
const noRevisions = await studio.getRevisionDetail({ projectId: emptyProject.projectId }).catch(cause => cause)
check('a project with no current revision says so instead of reading revision "null"',
  noRevisions instanceof BlenderError && noRevisions.code === code('REVISION_NOT_FOUND') &&
  /has no revisions yet/.test(noRevisions.message),
  noRevisions?.message)

// ---------------------------------------------------------------------------
// Two revisions, for the diff
// ---------------------------------------------------------------------------

const pair = await studio.readRevisionPair({ projectId })
check('the pair defaults to the previous revision and the current one, and hands over both specs',
  pair.fromRevision === first && pair.toRevision === second &&
  pair.from?.project?.id === projectId && pair.to?.project?.id === projectId,
  { from: pair.fromRevision, to: pair.toRevision })
check('the pair carries both manifests, so a caller can show what each revision decided',
  pair.fromManifest?.digest !== undefined && pair.toManifest?.digest !== undefined &&
  pair.fromManifest.digest !== pair.toManifest.digest)
check('and the two specs really differ, which is the whole reason the pair exists',
  JSON.stringify(pair.from.entities) !== JSON.stringify(pair.to.entities),
  { from: pair.from.entities.length, to: pair.to.entities.length })

const explicit = await studio.readRevisionPair({ projectId, from: first, to: first })
check('an explicit `from` is honoured even when it is the same revision as `to`',
  explicit.fromRevision === first && explicit.toRevision === first &&
  JSON.stringify(explicit.from) === JSON.stringify(explicit.to))

const genesis = await studio.readRevisionPair({ projectId, to: first }).catch(cause => cause)
check('a revision with no base revision refuses to invent one to compare against',
  genesis instanceof BlenderError && genesis.code === code('REVISION_NOT_FOUND') &&
  /records no base revision/.test(genesis.message),
  genesis?.message)

// ---------------------------------------------------------------------------
// The patch dry run: four different answers, four different issue sets
// ---------------------------------------------------------------------------

const clean = await studio.validateScene({ projectId, revision: second })
check('validating a revision with no patch reports the stored state and no technical report',
  clean.ok === true && clean.revision === second && clean.errorCount === 0 &&
  clean.technical === null && clean.digest === studio.store.readRevisionManifest(projectId, second).digest,
  { ok: clean.ok, technical: clean.technical })

const accepted = await studio.validateScene({
  projectId,
  revision: first,
  patch: { baseRevision: first, operations: [{ op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.4, 0.02] }] },
})
check('a patch that would apply cleanly is answered with PATCH_WOULD_SUCCEED and no errors',
  accepted.ok === true && issueCodes(accepted).length === 0 &&
  noticeCodes(accepted).includes('PATCH_WOULD_SUCCEED'),
  { errors: issueCodes(accepted), notices: noticeCodes(accepted) })
check('and every operation it would apply is reported by name, so the model can see what it asked for',
  accepted.notices.filter(notice => notice.code === 'PATCH_OPERATION_WOULD_APPLY').length === 1 &&
  /watch-body/.test(accepted.notices.find(notice => notice.code === 'PATCH_OPERATION_WOULD_APPLY')?.message ?? ''),
  accepted.notices.filter(notice => notice.code === 'PATCH_OPERATION_WOULD_APPLY'))
check('the success notice names the revision and both digests, so a dry run is auditable',
  new RegExp(`all 1 operation\\(s\\) would apply cleanly against ${first}; the scene digest would change from [0-9a-f]{16} to [0-9a-f]{16}`)
    .test(accepted.notices.find(notice => notice.code === 'PATCH_WOULD_SUCCEED')?.message ?? ''),
  accepted.notices.find(notice => notice.code === 'PATCH_WOULD_SUCCEED')?.message)

const illFormed = await studio.validateScene({
  projectId,
  revision: first,
  patch: { baseRevision: first, operations: [{ op: 'entity.nonsense.do' }] },
})
check('a patch that is not well formed is answered as an error, and nothing is applied',
  illFormed.ok === false && issueCodes(illFormed).length > 0 &&
  illFormed.errors.every(issue => /^the patch is not well formed — /.test(issue.message)) &&
  !noticeCodes(illFormed).includes('PATCH_WOULD_SUCCEED'),
  { errors: issueCodes(illFormed), first: illFormed.errors[0]?.message })
check('and its issues keep the code and the path the patch validator produced',
  illFormed.errors.every(issue => typeof issue.code === 'string' && issue.code.length > 0),
  illFormed.errors.map(issue => ({ code: issue.code, path: issue.path })))

const wrongBase = await studio.validateScene({
  projectId,
  revision: second,
  patch: { baseRevision: first, operations: [{ op: 'entity.transform.update', entityId: 'watch-body', location: [0, 0, 0] }] },
})
check('a patch written against an older revision is refused as a REVISION_CONFLICT, not merged',
  wrongBase.ok === false && issueCodes(wrongBase).includes(code('REVISION_CONFLICT')) &&
  wrongBase.errors.some(issue => issue.path === 'baseRevision' && issue.message.includes(`the patch targets ${first} but revision ${second}`)),
  wrongBase.errors)

// A patch the PATCH schema accepts and the scene can apply, whose RESULT is not a valid scene:
// `roughness: 5` is out of the [0,1] range the SceneSpec schema enforces. This is the branch that
// says "your operation is fine, what it produces is not" — and it is the one a model most needs to
// read correctly, because re-issuing the same patch will fail the same way.
const invalidAfter = await studio.validateScene({
  projectId,
  revision: first,
  patch: {
    baseRevision: first,
    operations: [{ op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 5 }],
  },
})
check('a patch that applies but leaves the scene invalid is answered with the error on the RESULT',
  invalidAfter.ok === false &&
  invalidAfter.errors.some(issue => /^applying the patch — /.test(issue.message) &&
    issue.path === 'materials[1].parameters.roughness') &&
  !noticeCodes(invalidAfter).includes('PATCH_WOULD_SUCCEED'),
  { errors: invalidAfter.errors.map(issue => `${issue.code}@${issue.path}: ${issue.message}`) })
check('and that answer keeps BOTH halves: the operations that would apply and the errors they produce',
  noticeCodes(invalidAfter).includes('PATCH_OPERATION_WOULD_APPLY') && invalidAfter.errors.length > 0,
  { notices: noticeCodes(invalidAfter), errors: issueCodes(invalidAfter) })

const impossible = await studio.validateScene({
  projectId,
  revision: first,
  patch: { baseRevision: first, operations: [{ op: 'entity.transform.update', entityId: 'no-such-entity', location: [0, 0, 0] }] },
})
check('a patch the scene refuses becomes a coded issue rather than a thrown stack, keeping the code the refusal carried',
  impossible.ok === false && impossible.errors.length === 1 &&
  impossible.errors[0].code === 'PATCH_TARGET_MISSING' && impossible.errors[0].path === 'operations[0]',
  impossible.errors)

// A store written by an OLDER build is a state this product must still read: the artifact lists were
// added to the manifest over time, and every one of them is read through a `?? []`. Removing them from
// the document on disk is the only way to produce that state, and it is what makes those fallbacks
// live rather than shadowed by the writer that always sets them.
const manifestPath = join(studio.store.revisionDirectory(projectId, second), 'revision-manifest.json')
const trimmed = JSON.parse(readFileSync(manifestPath, 'utf8'))
const hadArtifactLists = ['previews', 'contactSheets', 'reviews'].filter(key => key in trimmed)
for (const key of hadArtifactLists) delete trimmed[key]
writeFileSync(manifestPath, JSON.stringify(trimmed, null, 2))
const older = await studio.getRevisionDetail({ projectId })
check('a manifest written before the artifact lists existed still reads as three empty lists',
  hadArtifactLists.length > 0 &&
  JSON.stringify(older.previews) === '[]' && JSON.stringify(older.contactSheets) === '[]' &&
  JSON.stringify(older.reviews) === '[]',
  { trimmed: hadArtifactLists, previews: older.previews, contactSheets: older.contactSheets, reviews: older.reviews })

check('none of the dry runs changed the project: the current revision is still the one the patch landed on',
  studio.store.readRecord(projectId).currentRevision === second)
check('and the dry runs never reached the Blender runtime, because a dry run is not a compile',
  runtimeCalls === 0)

rmSync(workspaceRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost revision surface: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
