/** Source-change receipts must distinguish evidence from an old conservative boolean. No Blender. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  buildOperationManifest, compileSceneSpec, sceneSpecDigest, specHash, toCanonicalRevisionSummary,
} from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { ROOT } from '../../tools/workspace-layout.mjs'
import { loadClientBundle, makeReactStub, renderTree, findNodes, textOf } from '../lib/client-bundle.mjs'

const fixture = () => JSON.parse(readFileSync(join(ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json'), 'utf8'))
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const write = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
const audit = value => ({ specChangeStatus: value.specChangeStatus, specChanged: value.specChanged })
const expected = status => ({ specChangeStatus: status, specChanged: status !== 'unchanged' })

async function project(t) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-source-audit-'))
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.provide('blenderRuntime', new Proxy({}, { get: () => () => { throw new Error('No Blender in source audit tests') } }))
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot, projectsRoot: join(workspaceRoot, 'projects') }))
  const created = await studio.transactions.createProject({ title: 'source audit', sceneSpec: fixture(), saveCheckpoint: false })
  return { studio, projectId: created.projectId, revision: created.revision.revision }
}

function receipts(studio, projectId, revision) {
  const directory = studio.store.revisionDirectory(projectId, revision)
  return { revision: read(join(directory, 'revision-manifest.json')), operation: read(join(directory, 'operation-manifest.json')) }
}

test('operation receipts never equate missing or malformed full hashes with unchanged source', () => {
  const same = 'a'.repeat(64), different = 'b'.repeat(64)
  for (const [before, after, status] of [
    [same, same, 'unchanged'], [same, different, 'changed'],
    [null, same, 'unknown'], [undefined, same, 'unknown'], [same, null, 'unknown'],
    [same, undefined, 'unknown'], [undefined, undefined, 'unknown'], ['', '', 'unknown'],
    ['legacy-digest', 'legacy-digest', 'unknown'],
  ]) {
    const revision = { revision: 'r0075', baseRevision: 'r0074', digestBefore: same, digestAfter: same,
      specHashBefore: before, specHashAfter: after }
    const operation = buildOperationManifest({ operations: [], request: {}, revision, notices: [] })
    assert.deepEqual(audit(operation), expected(status), JSON.stringify({ before, after }))
    assert.equal(operation.sceneChanged, false, 'render digest comparison stays separate')
  }
})

test('ordinary no-op, metadata-only and scene edits persist the actual before/after hashes in both receipts', async t => {
  const { studio, projectId, revision: first } = await project(t)
  let revision = first
  for (const change of [
    { status: 'unchanged', sceneChanged: false, operation: spec => ({ op: 'project.frameRange.set', frameStart: spec.project.frameStart, frameEnd: spec.project.frameEnd }) },
    { status: 'changed', sceneChanged: false, operation: spec => ({ op: 'project.frameRange.set', frameStart: spec.project.frameStart, frameEnd: spec.project.frameEnd + 10 }) },
    { status: 'changed', sceneChanged: true, operation: () => ({ op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.4, 0.02] }) },
  ]) {
    const before = studio.store.readRevisionSpec(projectId, revision)
    const result = await studio.applyScenePatch({ projectId, baseRevision: revision, saveCheckpoint: false,
      operations: [change.operation(before)] })
    revision = result.revision
    const after = studio.store.readRevisionSpec(projectId, revision)
    const saved = receipts(studio, projectId, revision)
    for (const [kind, receipt] of Object.entries(saved)) {
      assert.equal(receipt.specHashBefore, specHash(before), `${kind} before is the saved source`)
      assert.equal(receipt.specHashAfter, specHash(after), `${kind} after is the committed source`)
      assert.deepEqual(audit(receipt), expected(change.status), kind)
      assert.equal(receipt.sceneChanged, change.sceneChanged, kind)
    }
    assert.deepEqual(audit(result), expected(change.status), 'model-facing canonical result')
  }
})

test('legacy false operation / true revision records read as unknown without rewriting either file', async t => {
  const { studio, projectId, revision } = await project(t)
  const result = await studio.applyScenePatch({ projectId, baseRevision: revision, saveCheckpoint: false,
    operations: [{ op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.4, 0.02] }] })
  const directory = studio.store.revisionDirectory(projectId, result.revision)
  // Exact observed legacy shape: both before hashes null, geometry changed, contradictory booleans.
  for (const [name, changed] of [['revision-manifest.json', true], ['operation-manifest.json', false]]) {
    const file = join(directory, name), manifest = read(file)
    manifest.specHashBefore = null
    manifest.specChanged = changed
    delete manifest.specChangeStatus
    write(file, manifest)
  }
  const names = ['scene-spec.json', 'revision-manifest.json', 'operation-manifest.json', 'request.json']
  const originalBytes = new Map(names.map(name => [name, readFileSync(join(directory, name))]))
  const detail = await studio.getRevisionDetail({ projectId, revision: result.revision })
  const listed = (await studio.getProject(projectId)).revisions.find(entry => entry.revision === result.revision)
  assert.deepEqual(audit(detail), expected('unknown'))
  assert.deepEqual(audit(listed), expected('unknown'))
  assert.deepEqual(audit(toCanonicalRevisionSummary({ manifest: detail.manifest })), expected('unknown'))
  assert.equal(detail.manifest.specChanged, true, 'raw revision retained')
  assert.equal(detail.operations.specChanged, false, 'raw operation retained')
  assert.equal(detail.operations.specHashBefore, null)
  assert.equal(detail.operations.sceneChanged, true)
  for (const [name, bytes] of originalBytes) assert.deepEqual(readFileSync(join(directory, name)), bytes, name)
})

test('historical summaries derive from complete hashes instead of trusting either stored audit field', () => {
  const same = 'a'.repeat(64), other = 'b'.repeat(64)
  for (const [before, after, status] of [[same, same, 'unchanged'], [same, other, 'changed'], [null, same, 'unknown']]) {
    for (const specChanged of [true, false]) {
      const manifest = { revision: 'r0002', specHashBefore: before, specHashAfter: after,
        specChanged, specChangeStatus: status === 'changed' ? 'unchanged' : 'changed' }
      const preserved = structuredClone(manifest)
      assert.deepEqual(audit(toCanonicalRevisionSummary({ manifest })), expected(status))
      assert.deepEqual(manifest, preserved)
    }
  }
})

test('a direct legacy commit with no before hash writes matching unknown receipts', async t => {
  const { studio, projectId, revision } = await project(t)
  const spec = studio.store.readRevisionSpec(projectId, revision)
  const outcome = await studio.transactions.commit({ projectId, baseRevision: revision, kind: 'scene_patch', spec,
    digestBefore: sceneSpecDigest(spec), operations: [], saveCheckpoint: false, renderPreview: false })
  for (const receipt of Object.values(receipts(studio, projectId, outcome.revision.revision))) {
    assert.equal(receipt.specHashBefore, null)
    assert.deepEqual(audit(receipt), expected('unknown'))
  }
})

test('editing an unresolved legacy source hashes the stored original, not its default-filled compilation', async t => {
  const { studio, projectId, revision } = await project(t)
  const directory = studio.store.revisionDirectory(projectId, revision)
  const legacy = studio.store.readRevisionSpec(projectId, revision)
  legacy.entities.push({ id: 'legacy-bare', type: 'generator', generator: { shape: 'uv_sphere' } })
  legacy.cameras.push({ id: 'camera-legacy', lens: 50, targetPoint: [0, 0, 0] })
  const before = specHash(legacy), compiledBefore = specHash(compileSceneSpec(legacy).spec)
  assert.notEqual(before, compiledBefore, 'fixture must actually exercise default filling')
  write(join(directory, 'scene-spec.json'), legacy)
  const manifest = read(join(directory, 'revision-manifest.json'))
  manifest.digest = manifest.digestAfter = sceneSpecDigest(legacy)
  manifest.specHashAfter = before
  delete manifest.specChangeStatus
  write(join(directory, 'revision-manifest.json'), manifest)
  const oldSource = readFileSync(join(directory, 'scene-spec.json'))
  const result = await studio.applyScenePatch({ projectId, baseRevision: revision, saveCheckpoint: false,
    operations: [{ op: 'project.frameRange.set', frameStart: legacy.project.frameStart, frameEnd: legacy.project.frameEnd }] })
  for (const receipt of Object.values(receipts(studio, projectId, result.revision))) {
    assert.equal(receipt.specHashBefore, before)
    assert.notEqual(receipt.specHashBefore, compiledBefore)
    assert.equal(receipt.specHashAfter, specHash(studio.store.readRevisionSpec(projectId, result.revision)))
    assert.deepEqual(audit(receipt), expected('changed'))
  }
  assert.deepEqual(readFileSync(join(directory, 'scene-spec.json')), oldSource)
})

test('the revision page displays explicit source status and never promotes a legacy boolean to certainty', () => {
  const client = loadClientBundle().exports.workbench
  for (const [status, oldFlag, label] of [
    ['changed', false, 'Project content changed'], ['unchanged', true, 'Project content unchanged'],
    ['unknown', true, 'Project content change could not be confirmed'], ['unknown', false, 'Project content change could not be confirmed'],
    [undefined, false, 'Project content change could not be confirmed'], [undefined, true, 'Project content change could not be confirmed'],
  ]) {
    const state = { activeProjectId: 'audit', view: 'revisions', error: null, busy: {}, notices: {},
      selected: { currentRevision: 'r0002', revisions: [{ revision: 'r0002', isCurrent: true,
        kind: 'scene_patch', specChanged: oldFlag, specChangeStatus: status, previews: [] }] } }
    const tree = renderTree(client.toReact(client.renderView({ state, actions: {} }), makeReactStub().createElement))
    const statusNodes = findNodes(tree, node => node.props?.['data-spec-change-status'] !== undefined)
    assert.equal(statusNodes.length, 1)
    assert.equal(statusNodes[0].props['data-spec-change-status'], status ?? 'unknown')
    assert.equal(textOf(statusNodes[0]), label)
  }
})
