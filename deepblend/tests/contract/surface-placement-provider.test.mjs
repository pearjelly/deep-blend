import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalBlenderRuntime, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import { BlenderErrorCode, sha256, verifySurfacePlacementReport, validateSurfacePlacementSelection } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const request = () => ({ subjectEntityId: 'body', supportEntityId: 'ramp', frame: 12, clearanceMm: 2, checkpointSha256: sha256('candidate') })
const object = z => ({ meshObjectCount: 1, vertexCount: 3, triangleCount: 1,
  rootWorldMatrix: [[1,0,0,0],[0,1,0,0],[0,0,1,z],[0,0,0,1]], worldBoundsMeters: { min: [0,0,z], max: [1,1,z] } })
const report = () => ({ schemaVersion: 'deepblend.surface-placement/v1', axis: 'world-z',
  ...request(), checkpointUnchanged: true, blenderVersion: '5.2.1', translationMeters: [0,0,-1.998],
  subjectContactMeters: [0,0,3], supportContactMeters: [0,0,1], placedSubjectContactMeters: [0,0,1.002],
  subjectTriangleIndex: 0, supportTriangleIndex: 0, statistics: { candidatePairs: 1 }, subject: object(3), support: object(1) })

test('a valid contact witness binds selected geometry to the exact checkpoint and explicit frame', () => {
  const value = report(); assert.equal(verifySurfacePlacementReport(value, request()), value)
  const zero = request(); delete zero.clearanceMm
  const valueZero = report(); valueZero.clearanceMm = 0; valueZero.translationMeters[2] = -2; valueZero.placedSubjectContactMeters[2] = 1
  verifySurfacePlacementReport(valueZero, zero)
})

for (const [label, alter] of [
  ['wrong source', r => { r.checkpointSha256 = '0'.repeat(64) }],
  ['wrong frame', r => { r.frame = 24 }],
  ['wrong selection', r => { r.supportEntityId = 'floor' }],
  ['horizontal movement', r => { r.translationMeters[0] = .1 }],
  ['separate XY witnesses', r => { r.supportContactMeters[0] = .1 }],
  ['false claimed clearance', r => { r.placedSubjectContactMeters[2] = 1 }],
  ['consistent movement with wrong vertical clearance', r => { r.translationMeters[2] -= .001; r.placedSubjectContactMeters[2] -= .001 }],
  ['contact outside geometry', r => { r.subjectContactMeters[0] = r.supportContactMeters[0] = r.placedSubjectContactMeters[0] = 2 }],
  ['unmeasured triangle', r => { r.supportTriangleIndex = 1 }],
  ['partial empty mesh set', r => { r.subject.meshObjectCount = 0 }],
  ['over-budget triangle set', r => { r.subject.triangleCount = 2_000_001 }],
  ['over-budget pairs', r => { r.statistics.candidatePairs = 1_000_001 }],
  ['non-affine root', r => { r.support.rootWorldMatrix[3][0] = 1 }],
  ['reversed native bounds', r => { r.subject.worldBoundsMeters.min[2] = 4 }],
  ['nonfinite placement', r => { r.translationMeters[2] = NaN }],
  ['unverified source bytes', r => { r.checkpointUnchanged = false }],
  ['unsupported stability claim', r => { r.physicallyStable = true }],
  ['missing baseline evidence', r => { r.baselineVerification = {} }],
]) test(`surface receipt refuses ${label}`, () => {
  const value = report(); alter(value)
  assert.throws(() => verifySurfacePlacementReport(value, request()), e => e.code === BlenderErrorCode.SCENE_VALIDATION_FAILED)
})

for (const [label, alter] of [
  ['same subject and support', q => { q.supportEntityId = q.subjectEntityId }],
  ['implicit frame', q => { delete q.frame }],
  ['fractional frame', q => { q.frame = 1.5 }],
  ['negative clearance', q => { q.clearanceMm = -.1 }],
  ['null clearance', q => { q.clearanceMm = null }],
  ['unbounded clearance', q => { q.clearanceMm = Infinity }],
  ['baseline without translation', q => { q.baselineCheckpointPath = '/baseline.blend'; q.baselineCheckpointSha256 = sha256('baseline') }],
]) test(`surface selection refuses ${label}`, () => {
  const q = request(); alter(q)
  assert.throws(() => validateSurfacePlacementSelection(q), e => e.code === BlenderErrorCode.SCENE_PATCH_INVALID)
})

function baselineReport() {
  return { checkpointSha256: sha256('baseline'), checkpointUnchanged: true, translationMeters: [0,0,-1.998],
    subjectRigidTranslation: true, supportUnchanged: true, subjectMaxErrorMeters: .000001,
    supportMaxErrorMeters: 0, toleranceMeters: .00002 }
}

test('candidate verification refuses support deformation or a different intended move', () => {
  const q = { ...request(), baselineCheckpointPath: '/baseline.blend', baselineCheckpointSha256: sha256('baseline'), expectedTranslationMeters: [0,0,-1.998] }
  const valid = { ...report(), baselineVerification: baselineReport() }; verifySurfacePlacementReport(valid, q)
  for (const change of [b => { b.supportUnchanged = false }, b => { b.subjectMaxErrorMeters = .000021 },
    b => { b.checkpointSha256 = '1'.repeat(64) }, b => { b.translationMeters[2] += 1 }, b => { b.toleranceMeters = .01 }]) {
    const invalid = structuredClone(valid); change(invalid.baselineVerification)
    assert.throws(() => verifySurfacePlacementReport(invalid, q), e => e.code === BlenderErrorCode.SCENE_VALIDATION_FAILED)
  }
})

async function fixture(t, baseline = false) {
  const scratch = mkdtempSync(join(tmpdir(), 'deepblend-placement-provider-')), ctx = new Context()
  const runtime = new LocalBlenderRuntime(ctx, ProviderConfig({ workspaceRoot: scratch }))
  t.after(async () => { await ctx.fiber.dispose(); rmSync(scratch, { recursive: true, force: true }) })
  const source = join(scratch, 'candidate.blend'), before = join(scratch, 'baseline.blend')
  writeFileSync(source, 'candidate'); writeFileSync(before, 'baseline')
  const q = { ...request(), checkpointPath: source,
    ...(baseline ? { baselineCheckpointPath: before, baselineCheckpointSha256: sha256('baseline'), expectedTranslationMeters: [0,0,-1.998] } : {}) }
  let calls = 0
  runtime._keptSession = async () => { throw Error('Must leave the user session intact') }
  runtime.runBootstrap = async (call, options) => {
    calls++
    assert.equal(call.action, 'inspect_surface_placement'); assert.equal(options.session, false)
    assert.notEqual(options.args[1], source); assert.equal(readFileSync(options.args[1], 'utf8'), 'candidate')
    if (baseline) {
      assert.notEqual(call.payload.baselineCheckpointPath, before)
      assert.equal(readFileSync(call.payload.baselineCheckpointPath, 'utf8'), 'baseline')
    }
    return { exitCode: 0, envelope: { protocolVersion: 'deepblend.blender/v1', status: 'success', action: call.action,
      jobId: call.jobId, error: null, result: { ...report(), ...(baseline ? { baselineVerification: baselineReport() } : {}) } }, durationMs: 1 }
  }
  return { runtime, scratch, source, before, q, calls: () => calls }
}

test('both candidate and baseline are copied, hash checked and removed after isolated verification', async t => {
  const f = await fixture(t, true); const result = await f.runtime.inspectSurfacePlacement(f.q)
  assert.equal(result.report.baselineVerification.supportUnchanged, true); assert.equal(f.calls(), 1)
  assert.equal(readFileSync(f.source, 'utf8'), 'candidate'); assert.equal(readFileSync(f.before, 'utf8'), 'baseline')
  assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
})

test('an explicit job correlation is retained and an omitted one is generated for each inspection', async t => {
  const f = await fixture(t)
  const first = await f.runtime.inspectSurfacePlacement({ ...f.q, jobId: 'placement-explicit' })
  const second = await f.runtime.inspectSurfacePlacement(f.q)
  const third = await f.runtime.inspectSurfacePlacement(f.q)
  assert.equal(first.envelope.jobId, 'placement-explicit')
  assert.equal(typeof second.envelope.jobId, 'string'); assert.ok(second.envelope.jobId.length > 0)
  assert.notEqual(second.envelope.jobId, first.envelope.jobId); assert.notEqual(second.envelope.jobId, third.envelope.jobId)
})

for (const [label, change, code] of [
  ['crash exit', r => { r.exitCode = 139 }, BlenderErrorCode.NONZERO_EXIT],
  ['missing exit', r => { r.exitCode = null }, BlenderErrorCode.NONZERO_EXIT],
  ['missing status', r => { delete r.envelope.status }],
  ['pending status', r => { r.envelope.status = 'pending' }],
  ['error status', r => { r.envelope.status = 'error' }],
  ['wrong action', r => { r.envelope.action = 'inspect_geometry' }],
  ['wrong request', r => { r.envelope.jobId = 'unrelated-job' }],
  ['wrong protocol', r => { r.envelope.protocolVersion = 'deepblend.blender/v0' }],
  ['nonempty error', r => { r.envelope.error = { code: 'BLENDER_SCRIPT_ERROR' } }],
]) test(`a plausible contact report with ${label} is refused before acceptance`, async t => {
  const f = await fixture(t), run = f.runtime.runBootstrap
  f.runtime.runBootstrap = async (...args) => { const result = await run(...args); change(result); return result }
  await assert.rejects(f.runtime.inspectSurfacePlacement(f.q), { code: code ?? BlenderErrorCode.PROTOCOL_VERSION_MISMATCH })
  assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
})

for (const changed of ['source', 'before']) test(`changed ${changed} bytes refuse a plausible result and clean private files`, async t => {
  const f = await fixture(t, true), run = f.runtime.runBootstrap
  f.runtime.runBootstrap = async (...args) => { const value = await run(...args); writeFileSync(f[changed], 'changed'); return value }
  await assert.rejects(f.runtime.inspectSurfacePlacement(f.q), e => e.code === BlenderErrorCode.SCENE_VALIDATION_FAILED)
  assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
})

test('a modified private snapshot also invalidates the receipt', async t => {
  const f = await fixture(t), run = f.runtime.runBootstrap
  f.runtime.runBootstrap = async (...args) => { const value = await run(...args); writeFileSync(args[1].args[1], 'changed'); return value }
  await assert.rejects(f.runtime.inspectSurfacePlacement(f.q), e => e.code === BlenderErrorCode.SCENE_VALIDATION_FAILED)
})

test('cancellation before and after the native result preserves abort semantics', async t => {
  const f = await fixture(t), run = f.runtime.runBootstrap, controller = new AbortController()
  f.runtime.runBootstrap = async (...args) => { const value = await run(...args); controller.abort(); return value }
  await assert.rejects(f.runtime.inspectSurfacePlacement({ ...f.q, signal: controller.signal }), e => e.code === BlenderErrorCode.ABORTED)
  await assert.rejects(f.runtime.inspectSurfacePlacement({ ...f.q, signal: controller.signal }), e => e.code === BlenderErrorCode.ABORTED)
  assert.equal(f.calls(), 1); assert.deepEqual(readdirSync(join(f.scratch, 'tmp')), [])
})

test('baseline paths cannot escape the workspace through symlinks', async t => {
  const f = await fixture(t, true), outside = mkdtempSync(join(tmpdir(), 'deepblend-placement-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const foreign = join(outside, 'foreign.blend'), link = join(f.scratch, 'linked.blend')
  writeFileSync(foreign, 'baseline'); symlinkSync(foreign, link)
  await assert.rejects(f.runtime.inspectSurfacePlacement({ ...f.q, baselineCheckpointPath: link }), e => e.code === BlenderErrorCode.PATH_OUTSIDE_WORKSPACE)
  assert.equal(f.calls(), 0); assert.equal(existsSync(join(f.scratch, 'tmp')), false)
})

test('independent analytic surface-placement cases pass without Blender', () => {
  const run = spawnSync('python3', ['-B', join(ROOT, 'deepblend/tests/lib/test-surface-placement.py')], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  assert.match(run.stderr, /Ran \d+ tests/)
})
