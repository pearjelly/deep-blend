/** Preview history must identify and retain the image that a person compared. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, sceneSpecDigest, compileSchema, compileSceneSpec, buildSceneTree, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const spec = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const core = loadClientBundle().exports.workbench
const flatten = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flatten)] : []
const images = (revisions, mode = 'renders', currentRevision = revisions.at(-1).revision) => flatten(core.renderView({
  state: { activeProjectId: 'history', editorComparison: null, view: 'preview', previews: { revisions }, selected: null, currentRevision, compareLeft: currentRevision,
    compareRight: currentRevision, compareMode: mode, artifactBase: '/artifacts/', notices: {}, inspectionWork: {} }, actions: {},
})).filter(node => node.tag === 'img')
const single = (rev, name, at, extra = {}) => ({ kind: 'preview', path: `revisions/${rev}/previews/${name}.png`, sha256: sha(name), at, ...extra })
const sheet = (rev, slot, at, extra = {}) => ({ kind: 'contact-sheet', slot, path: `revisions/${rev}/contact-sheets/${slot}.png`, sha256: sha(slot), at, ...extra })
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-preview-history-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const ctx = new Context(), reports = []
  ctx.provide('blenderRuntime', {
    async resolveEngineKey() { return { blenderEngine: 'CYCLES', warning: null } },
    async compileScene(r) { const directory = join(r.projectRoot, 'native-stub'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'result.blend'), 'checkpoint'); r.onWorkingDirectory({ directory }); return { envelope: {}, report: { validation: {}, sceneFingerprint: { totalPolygons: 1 } } } },
    async renderPreview(r) {
      const width = r.width ?? 16; mkdirSync(join(r.outputPath, '..'), { recursive: true })
      writeFileSync(r.outputPath, encodePng(createImage(width, 16, [width, r.samples ?? 10, 30, 255])))
      const report = { cameraId: r.cameraId, frame: r.frame ?? 1, width, height: 16, engine: 'CYCLES', renderConfig: { engine: 'CYCLES', resolution: [width, 16], samples: r.samples } }
      reports.push(report); return { envelope: {}, report }
    },
  })
  const studio = new Studio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), maxPreviewSamples: 8 }))
  const source = structuredClone(spec); source.renderProfiles.preview.resolution = [16, 16]
  const created = await studio.transactions.createProject({ title: 'history', sceneSpec: source, saveCheckpoint: true, renderPreview: true })
  const projectId = created.projectId, revision = created.revision.revision
  const file = name => join(studio.store.projectDirectory(projectId), name)
  const render = request => studio.renderPreview({ projectId, revision, cameraId: 'camera-main', frame: 1, ...request })
  return { studio, projectId, revision, created, file, render, ctx, reports }
}

test('creation records its source and measured settings without rewriting the authored sample budget', async t => {
  const { studio, projectId, revision, created } = await setup(t)
  const artifact = created.revision.previews[0], stored = studio.store.readRevisionSpec(projectId, revision)
  assert.equal(artifact.sourceRevision, revision); assert.equal(artifact.sourceDigest, sceneSpecDigest(stored))
  assert.ok(Number.isFinite(Date.parse(artifact.at))); assert.equal(artifact.samples, 8); assert.equal(artifact.renderConfig.samples, 8)
  assert.ok(stored.renderProfiles.preview.samples > artifact.samples)
})

test('same camera and frame retain both PNGs, their original jobs and revision source bytes', async t => {
  const { studio, projectId, revision, render, file, reports } = await setup(t)
  const protectedFiles = ['scene-spec.json', 'scene.blend'].map(name => `revisions/${revision}/${name}`)
  const before = protectedFiles.map(name => readFileSync(file(name)))
  const a = await render({ width: 16, samples: 4 }), first = a.artifacts[0], firstBytes = readFileSync(file(first.path))
  const b = await render({ width: 20, samples: 8 }), second = b.artifacts[0]
  assert.notEqual(first.path, second.path); assert.deepEqual(readFileSync(file(first.path)), firstBytes)
  assert.equal(sha(firstBytes), first.sha256); assert.equal(sha(readFileSync(file(second.path))), second.sha256)
  const entries = studio.store.readRevisionManifest(projectId, revision).previews
  assert.ok(entries.some(item => item.path === first.path && item.sha256 === first.sha256)); assert.ok(entries.some(item => item.path === second.path))
  assert.deepEqual(JSON.parse(readFileSync(file(`jobs/${a.job.jobId}.json`))).artifacts[0], first)
  assert.ok(Number.isFinite(Date.parse(first.at))); assert.equal(first.sourceRevision, revision); assert.equal(first.sourceDigest, a.digest); assert.equal(first.jobId, a.job.jobId)
  assert.deepEqual(first.renderConfig, { engine: 'CYCLES', resolution: [16, 16], samples: 4 }); reports.at(-2).renderConfig.samples = 100
  assert.equal(first.renderConfig.samples, 4, 'renderer-owned report mutations cannot alter the returned evidence')
  assert.deepEqual(protectedFiles.map(name => readFileSync(file(name))), before)
  const schema = compileSchema(JSON.parse(readFileSync(new URL('../../schemas/job-result.schema.json', import.meta.url))), 'job-result.schema.json')
  assert.deepEqual(schema(JSON.parse(readFileSync(file(`jobs/${a.job.jobId}.json`)))), [])
})

test('concurrent renders of the same camera/frame retain distinct bytes and both entries', async t => {
  const { studio, projectId, revision, render, file } = await setup(t)
  const renders = await Promise.all([render({ width: 18, samples: 4 }), render({ width: 22, samples: 8 })])
  assert.equal(new Set(renders.map(item => item.artifacts[0].path)).size, 2)
  for (const result of renders) { const artifact = result.artifacts[0]; assert.equal(sha(readFileSync(file(artifact.path))), artifact.sha256); assert.ok(studio.store.readRevisionManifest(projectId, revision).previews.some(item => item.path === artifact.path)) }
})

test('an older renderer without measured config leaves its settings unknown', async t => {
  const { studio, render } = await setup(t)
  const original = studio.runtime.renderPreview.bind(studio.runtime)
  studio.runtime.renderPreview = async r => { const result = await original(r); delete result.report.renderConfig; return result }
  const result = await render({ width: 18, samples: 4 })
  assert.equal(result.artifacts[0].renderConfig, null); assert.equal(result.artifacts[0].samples, null)
})

test('legacy reads establish only an own-path source and preserve the manifest bytes', async t => {
  const { studio, projectId, revision, file } = await setup(t), path = file(`revisions/${revision}/revision-manifest.json`)
  const manifest = JSON.parse(readFileSync(path)), digest = manifest.digest
  manifest.previews = [single(revision, 'own', undefined), single('r0999', 'copied', undefined), single(revision, 'declared', undefined, { sourceRevision: 'r0999', sourceDigest: sha('other') }), single(revision, '../traversal', undefined), single(revision, 'explicit-unknown', undefined, { sourceRevision: null })]
  writeFileSync(path, JSON.stringify(manifest)); const before = readFileSync(path)
  const row = (await studio.listPreviewSets({ projectId })).revisions[0]
  assert.equal(row.previews[0].sourceRevision, revision); assert.equal(row.previews[0].sourceDigest, digest); assert.equal(row.previews[0].at, undefined)
  assert.equal(row.previews[1].sourceRevision, null); assert.equal(row.previews[1].sourceDigest, null)
  assert.equal(row.previews[2].sourceRevision, 'r0999'); assert.equal(row.previews[2].sourceDigest, sha('other'))
  assert.equal(row.previews[3].sourceRevision, null); assert.equal(row.previews[4].sourceRevision, null)
  assert.deepEqual(readFileSync(path), before)
})

test('newly created single previews appear on both latest and render comparison views', () => {
  const rows = [{ revision: 'r0001', digest: sha('source'), previews: [single('r0001', 'hero', undefined)], contactSheets: [] }]
  for (const mode of ['result', 'renders', 'revisions']) {
    const nodes = images(rows, mode); assert.ok(nodes.length > 0)
    assert.ok(nodes.every(node => node.props['data-artifact-revision'] === 'r0001'))
  }
  assert.equal(images(rows, 'result')[0].props['data-artifact-source-digest'], sha('source'))
})

test('the current product image reserves its measured size without enlarging small previews', () => {
  for (const [width, height] of [[256, 192], [48, 16], [1200, 1800]]) {
    const rows = [{ revision: 'r0001', previews: [single('r0001', 'hero', undefined, { width, height })], contactSheets: [] }]
    const image = images(rows, 'result')[0]
    assert.equal(image.props.width, width); assert.equal(image.props.height, height)
    assert.equal(image.props.style.aspectRatio, `${width} / ${height}`)
    assert.notEqual(image.props.style.width, 'auto', 'known pixels reserve space before the image decodes')
    assert.equal(image.props.style.height, 'auto')
    assert.equal(image.props.style.maxWidth, '100%'); assert.equal(image.props.style.maxHeight, 'calc(100vh - 300px)')
    assert.equal(images(rows, 'renders')[0].props.width, undefined, 'comparison panes retain their own sizing')
  }
})

test('legacy or invalid preview dimensions do not invent a reserved image size', () => {
  for (const dimensions of [{}, { width: 256 }, { height: 192 }, { width: 0, height: 192 }, { width: 256, height: -1 },
    { width: 256.5, height: 192 }, { width: '256', height: 192 }, { width: Infinity, height: 192 }]) {
    const rows = [{ revision: 'r0001', previews: [single('r0001', 'hero', undefined, dimensions)], contactSheets: [] }]
    const image = images(rows, 'result')[0]
    assert.equal(image.props.width, undefined); assert.equal(image.props.height, undefined)
    assert.equal(image.props.style.width, 'auto'); assert.equal(image.props.style.height, 'auto')
    assert.equal(image.props.style.aspectRatio, undefined)
  }
})

test('latest measured single render supersedes an older sheet while retaining the preceding render', () => {
  const rows = [{ revision: 'r0001', previews: [single('r0001', 'initial', '2026-10-03T01:00:00Z'), single('r0001', 'new', '2026-10-03T03:00:00Z')], contactSheets: [sheet('r0001', 'preview-current', '2026-10-03T02:00:00Z')] }]
  assert.equal(images(rows, 'result')[0].props['data-artifact'], rows[0].previews[1].path)
  const pair = images(rows); assert.equal(pair[0].props['data-artifact'], rows[0].contactSheets[0].path); assert.equal(pair[1].props['data-artifact'], rows[0].previews[1].path)
})

test('editing retains the prior single preview before and after the first render', () => {
  const rows = ['r0001', 'r0002'].map(revision => ({ revision, previews: [single(revision, 'hero', undefined)], contactSheets: [] }))
  assert.deepEqual(images([{ ...rows[0] }, { ...rows[1], previews: [] }]).map(node => node.props['data-artifact-revision']), ['r0001'], 'the old image stays visible while the new version has no render')
  assert.deepEqual(images(rows).map(node => node.props['data-artifact-revision']), ['r0001', 'r0002'])
  assert.equal(images(rows, 'result', 'r0001')[0].props['data-artifact-revision'], 'r0001', 'restoring the pointer must show the restored source')
})

test('comparison keeps declared sources and never labels copied or traversal paths as the enclosing version', () => {
  const rows = [{ revision: 'r0002', previews: [single('r0002', 'declared', undefined, { sourceRevision: 'r0001', sourceDigest: sha('old') })], contactSheets: [] }]
  assert.equal(images(rows, 'result')[0].props['data-artifact-revision'], 'r0001')
  assert.equal(images(rows)[0].props['data-artifact-revision'], 'r0001')
  for (const item of [single('r0001', 'copied', undefined), single('r0002', '../escape', undefined), single('r0002', 'unknown', undefined, { sourceRevision: null })]) {
    rows[0].previews = [item]; assert.equal(images(rows, 'result')[0].props['data-artifact-revision'], '')
  }
})


test('editor matching refuses a declared different source even when render settings match', () => {
  const renderConfig = { engine: 'CYCLES', resolution: [16, 16], resolutionPercentage: 100, samples: 8,
    filmTransparent: false, viewTransform: 'AgX', look: 'None', exposure: 0, fps: 24, frameStart: 1, frameEnd: 48 }
  const measured = revision => single(revision, 'hero', undefined, { cameraId: 'hero', frame: 24, width: 16, height: 16, engine: 'CYCLES', samples: 8, renderConfig })
  const comparison = { before: 'r0001', after: 'r0002', beforePreviews: [measured('r0001')], afterPreviews: [measured('r0002')] }
  assert.equal(core.sceneEditor.previewPair(comparison).reason, null)
  comparison.beforePreviews[0].sourceRevision = 'r0999'
  const refusedBefore = core.sceneEditor.previewPair(comparison)
  assert.equal(refusedBefore.beforeArtifact, null); assert.equal(refusedBefore.reason, 'no-matching-baseline')
  comparison.afterPreviews[0].sourceRevision = 'r0001'
  assert.equal(core.sceneEditor.previewPair(comparison).afterArtifact, null)
})

// Drive the actual shared store and view. All comparison calls are reads; the
// controlled Host allows delayed replies and changes to the current project.
async function comparisonClient(t, ids = ['r0001', 'r0002', 'r0003']) {
  const scene = compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/metal-lamp/scene-spec.json', import.meta.url)))).spec
  const host = { root: '/comparison-store/a', current: ids.at(-1), ids: [...ids], queue: [] }, reads = [], writes = []
  const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), json: async () => payload })
  const settings = { pollIdleMs: 999999, pollLiveMs: 999999, fetch: async (input, init = {}) => {
    const u = new URL(String(input), 'http://controlled.test'), projectId = u.searchParams.get('projectId') || u.pathname.split('/')[3] || 'project-a'
    if (init.method === 'POST') { writes.push(String(input)); throw Error('comparison must not write') }
    if (u.pathname.endsWith('/diff')) {
      reads.push({ projectId, from: u.searchParams.get('from'), to: u.searchParams.get('to') })
      const queued = host.queue.shift(); if (queued) return await queued
      return response({ ok: true, diff: { fromRevision: u.searchParams.get('from'), toRevision: u.searchParams.get('to'), identical: false, totalChanges: 1, collections: {}, project: [], world: [] } })
    }
    const rows = host.ids.map(revision => ({ revision, isCurrent: revision === host.current, previews: [], contactSheets: [], reviews: [] }))
    const payload = u.pathname.endsWith('/jobs') ? { route: 'project.jobs', jobs: [], unfinished: [] }
      : u.pathname.endsWith('/previews') ? { route: 'project.previews', artifactBase: '/artifacts/'+projectId+'/', previews: { revisions: rows } }
      : { route: 'state', projectsRoot: host.root, projects: [{ projectId: 'project-a' }, { projectId: 'project-b' }], selected: { project: { projectId, title: projectId, revisionCount: rows.length }, currentRevision: host.current, revisions: rows, scene: buildSceneTree(scene, { revision: host.current }), jobs: [], unfinishedJobs: [] } }
    return response({ ok: true, hostApiVersion: HOST_API_VERSION, ...payload })
  } }
  const store = core.createWorkbenchStore(settings); t.after(() => store.stop()); store.start()
  const wait = async predicate => { for (let n = 0; n < 100; n++) { if (predicate(store.getState())) return; await new Promise(r => setTimeout(r, 10)) } throw Error('comparison fixture did not settle') }
  await wait(s => s.status === 'ok' && s.previews && s.currentRevision === host.current)
  const nodes = () => flatten(core.renderView({ state: store.getState(), actions: store.actions }))
  const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); host.queue.push(promise); return { resolve: diff => resolve(response({ ok: true, diff })), payload: (value, status) => resolve(response(value, status)), error: error => resolve(response({ ok: false, error })), reject } }
  const select = (left = 'r0001', right = host.current) => { store.actions.setView('preview'); store.actions.setCompareMode('revisions'); store.actions.pickCompare('left', left); store.actions.pickCompare('right', right) }
  const pair = () => nodes().filter(n => ['compare-left', 'compare-right'].includes(n.props['data-field'])).map(n => n.props.value)
  return { store, host, reads, writes, wait, nodes, pending, select, pair }
}
const difference = (from = 'r0001', to = 'r0003', count = 1) => ({ fromRevision: from, toRevision: to, identical: false, totalChanges: count, collections: {}, project: [], world: [] })

for (const mode of ['result', 'renders', 'revisions']) test(`version comparison: revision entry enters the selected/current pair from ${mode}`, async t => {
  const f = await comparisonClient(t); f.store.actions.setCompareMode(mode); f.store.actions.pickCompare('right', 'r0002'); f.store.actions.setView('revisions')
  const button = f.nodes().find(n => n.props['data-action'] === 'compare-from:r0001'); button.props.onClick()
  assert.equal(f.store.getState().compareMode, 'revisions'); assert.equal(f.store.getState().view, 'preview'); assert.deepEqual(f.pair(), ['r0001', 'r0003']); assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0)
})
test('version comparison: selected current uses the nearest other saved version', async t => {
  const f = await comparisonClient(t); f.store.actions.compareFrom('r0003'); assert.deepEqual(f.pair(), ['r0002', 'r0003']); assert.equal(f.writes.length, 0)
})
test('version comparison: restored earliest current can compare with the next saved version', async t => {
  const f = await comparisonClient(t); f.host.current = 'r0001'; f.store.actions.reload(); await f.wait(s => s.currentRevision === 'r0001'); f.store.actions.compareFrom('r0001'); assert.deepEqual(f.pair(), ['r0002', 'r0001'])
})
test('version comparison: one version has a disabled entry and cannot silently compare itself', async t => {
  const f = await comparisonClient(t, ['r0001']); f.store.actions.setView('revisions'); const button = f.nodes().find(n => n.props['data-action'] === 'compare-from:r0001'); assert.equal(button.props.disabled, true)
  const before = JSON.stringify(f.store.getState()); f.store.actions.compareFrom('r0001'); assert.equal(JSON.stringify(f.store.getState()), before); assert.equal(f.writes.length, 0)
})
test('version comparison: unavailable selected or current versions cannot substitute another pair', async t => {
  const f = await comparisonClient(t); f.select(); const before = JSON.stringify(f.store.getState()); f.store.actions.compareFrom('r0999'); assert.equal(JSON.stringify(f.store.getState()), before)
  f.host.current = 'r0999'; f.store.actions.reload(); await f.wait(s => s.currentRevision === 'r0999'); const unavailable = JSON.stringify(f.store.getState()); f.store.actions.compareFrom('r0001'); assert.equal(JSON.stringify(f.store.getState()), unavailable)
})
test('version comparison: explicit entry clears old diff and automatic edit metadata but retains unsubmitted inputs', async t => {
  const f = await comparisonClient(t); f.select('r0001', 'r0002'); await f.store.actions.diff('r0001', 'r0002'); f.store.actions.setForm('title', 'My unfinished project'); f.store.actions.setForm('goal', 'Keep my notes'); f.store.actions.setView('scene'); f.store.actions.selectEditorEntity('shade-shell'); f.store.actions.updateEditor('transform', ['location', 0], .007)
  const drafts = JSON.stringify(f.store.getState().editorDrafts); f.store.actions.compareFrom('r0002'); const s = f.store.getState(); assert.equal(s.diff, null); assert.equal(s.diffError, null); assert.equal(s.editorComparison, null); assert.equal(s.forms.title, 'My unfinished project'); assert.equal(s.forms.goal, 'Keep my notes'); assert.equal(JSON.stringify(s.editorDrafts), drafts); assert.deepEqual(f.pair(), ['r0002', 'r0003']); assert.equal(f.writes.length, 0)
})
for (const change of ['pair', 'mode', 'entry', 'tab', 'project', 'root', 'current', 'stop']) test(`version comparison: late success cannot repaint after ${change} changes`, async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003');
  if (change === 'pair') f.store.actions.pickCompare('left', 'r0002')
  if (change === 'mode') f.store.actions.setCompareMode('result')
  if (change === 'entry') f.store.actions.compareFrom('r0002')
  if (change === 'tab') f.store.actions.setView('revisions')
  if (change === 'project') { f.store.actions.selectProject('project-b'); await f.wait(s => s.activeProjectId === 'project-b') }
  if (change === 'root') { f.host.root = '/comparison-store/b'; f.store.actions.reload(); await f.wait(s => s.projectsRoot === f.host.root) }
  if (change === 'current') { f.host.current = 'r0002'; f.store.actions.reload(); await f.wait(s => s.currentRevision === f.host.current) }
  if (change === 'stop') f.store.stop()
  p.resolve(difference()); await work; assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError, null); assert.equal(f.writes.length, 0)
})
for (const kind of ['coded', 'network']) test(`version comparison: late ${kind} error cannot replace a later valid result`, async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); f.store.actions.compareFrom('r0002'); await f.store.actions.diff('r0002', 'r0003')
  if (kind === 'coded') p.error({ code: 'OLD_ERROR', message: 'earlier comparison' }); else p.reject(Error('earlier network error'))
  await work; assert.equal(f.store.getState().diff.fromRevision, 'r0002'); assert.equal(f.store.getState().diff.toRevision, 'r0003'); assert.equal(f.store.getState().diffError, null)
})
test('version comparison: newest request wins even when two requests share the same pair', async t => {
  const f = await comparisonClient(t); f.select(); const first = f.pending(), older = f.store.actions.diff('r0001', 'r0003'); const second = f.pending(), newer = f.store.actions.diff('r0001', 'r0003'); second.resolve(difference('r0001', 'r0003', 2)); await newer; first.resolve(difference('r0001', 'r0003', 7)); await older; assert.equal(f.store.getState().diff.totalChanges, 2)
})
test('version comparison: changing context clears an already displayed diff and error', async t => {
  const f = await comparisonClient(t); f.select(); await f.store.actions.diff('r0001', 'r0003'); assert.equal(f.store.getState().diff.fromRevision, 'r0001'); f.store.actions.setCompareMode('result'); assert.equal(f.store.getState().diff, null)
  f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); p.error({ code: 'CURRENT_ERROR', message: 'visible' }); await work; assert.equal(f.store.getState().diffError.code, 'CURRENT_ERROR'); f.store.actions.compareFrom('r0002'); assert.equal(f.store.getState().diffError, null)
})
test('version comparison: mismatched successful response is refused instead of mislabeled', async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); p.resolve(difference('r0001', 'r0002')); await work; assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError.code, 'UI_DIFF_MISMATCH')
})
test('version comparison: unavailable pair and non-version mode do not fetch a diff', async t => {
  const f = await comparisonClient(t); f.select(); f.store.actions.setCompareMode('result'); await f.store.actions.diff('r0001', 'r0003'); f.select(); await f.store.actions.diff('r0001', 'r0999'); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
})

for (const change of ['pair', 'mode', 'tab', 'root', 'current']) test(`version comparison: returning from a ${change} round trip cannot revive an earlier request`, async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003')
  if (change === 'pair') { f.store.actions.pickCompare('left', 'r0002'); f.store.actions.pickCompare('left', 'r0001') }
  if (change === 'mode') { f.store.actions.setCompareMode('result'); f.store.actions.setCompareMode('revisions') }
  if (change === 'tab') { f.store.actions.setView('revisions'); f.store.actions.setView('preview') }
  if (change === 'root') { f.host.root = '/comparison-store/b'; f.store.actions.reload(); await f.wait(s => s.projectsRoot === f.host.root); f.host.root = '/comparison-store/a'; f.store.actions.reload(); await f.wait(s => s.projectsRoot === f.host.root) }
  if (change === 'current') { f.host.current = 'r0002'; f.store.actions.reload(); await f.wait(s => s.currentRevision === 'r0002'); f.host.current = 'r0003'; f.store.actions.reload(); await f.wait(s => s.currentRevision === 'r0003') }
  p.resolve(difference()); await work; assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError, null)
})
for (const change of ['root', 'current']) test(`version comparison: a ${change} change clears the displayed old comparison result`, async t => {
  const f = await comparisonClient(t); f.select(); await f.store.actions.diff('r0001', 'r0003'); assert.equal(f.store.getState().diff.fromRevision, 'r0001')
  if (change === 'root') f.host.root = '/comparison-store/b'; else f.host.current = 'r0002'
  f.store.actions.reload(); await f.wait(s => s.projectsRoot === f.host.root && s.currentRevision === f.host.current); assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError, null)
})

test('version comparison: explicitly choosing the same pair discards an earlier pending request', async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); f.store.actions.compareFrom('r0001'); p.resolve(difference()); await work; assert.equal(f.store.getState().diff, null)
})
for (const place of ['envelope', 'diff']) test(`version comparison: wrong project identity in ${place} is refused`, async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); const payload = { ok: true, diff: difference() }; if (place === 'envelope') payload.projectId = 'project-b'; else payload.diff.projectId = 'project-b'
  p.payload(payload); await work; assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError.code, 'UI_DIFF_MISMATCH')
})
for (const field of ['fromRevision', 'toRevision']) test(`version comparison: mismatched envelope ${field} is refused`, async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); p.payload({ ok: true, diff: difference(), [field]: 'r0002' }); await work; assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError.code, 'UI_DIFF_MISMATCH')
})
test('version comparison: HTTP failure cannot be presented as a successful structural difference', async t => {
  const f = await comparisonClient(t); f.select(); const p = f.pending(), work = f.store.actions.diff('r0001', 'r0003'); p.payload({ ok: true, diff: difference() }, 503); await work; assert.equal(f.store.getState().diff, null); assert.equal(f.store.getState().diffError.code, 'HTTP_503')
})
