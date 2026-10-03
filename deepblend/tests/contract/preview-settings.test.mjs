/** Recorded settings must describe the actual image, including each sheet view. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng, compileSchema } from '@deepblend/dsh-blender-contracts'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadClientBundle } from '../lib/client-bundle.mjs'
const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const core = loadClientBundle().exports.workbench
const config = (width = 24, samples = 4) => ({ engine: 'CYCLES', resolution: [width, 16], resolutionPercentage: 100, samples, filmTransparent: false, viewTransform: 'AgX', look: 'None', exposure: 0, fps: 30, frameStart: 1, frameEnd: 90 })
const camera = (frame = 24) => ({ frame, matrixWorld: [[1, 0, 0, 0], [0, 1, 0, -3], [0, 0, 1, 1], [0, 0, 0, 1]], type: 'PERSP', lens: 58, orthoScale: 1, sensorWidth: 36, sensorHeight: 24, sensorFit: 'AUTO', shift: [0, 0], clip: [.01, 100], dof: { enabled: false, focusDistance: 0, focusObject: null, focusSubtarget: null, apertureFstop: 8, apertureBlades: 0, apertureRotation: 0, apertureRatio: 1 } })
const single = (revision, name, overrides = {}) => ({ kind: 'preview', path: `revisions/${revision}/previews/${name}.png`, at: name === 'before' ? '2026-10-04T01:00:00Z' : '2026-10-04T02:00:00Z', sourceRevision: revision, cameraId: 'hero', frame: 24, width: 24, height: 16, samples: 4, engine: 'CYCLES', renderConfig: config(), cameraFacts: camera(), ...overrides })
const sheet = (name, viewSettings, overrides = {}) => ({ kind: 'contact-sheet', slot: name === 'before' ? 'preview-previous' : 'preview-current', path: `revisions/r0001/contact-sheets/${name}.png`, at: name === 'before' ? '2026-10-04T01:00:00Z' : '2026-10-04T02:00:00Z', width: 999, height: 300, columns: 1, rows: 1, viewSettings, ...overrides })
const walk = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : []
const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join(' ')
function view(before, after, mode = 'renders') {
  const rows = [{ revision: 'r0001', previews: [before, after].filter(a => a?.kind === 'preview'), contactSheets: [before, after].filter(a => a?.kind === 'contact-sheet') }]
  const tree = core.renderView({ state: { activeProjectId: 'test', editorComparison: null, view: 'preview', previews: { revisions: rows }, selected: null, currentRevision: 'r0001', compareLeft: 'r0001', compareRight: 'r0001', compareMode: mode, artifactBase: '/artifacts/', notices: {}, inspectionWork: {} }, actions: {} })
  return { tree, nodes: walk(tree), conditions: walk(tree).find(n => n.props['data-preview-conditions']) }
}
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-measured-settings-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const reports = [], ctx = new Context()
  const report = request => { const width = request.width ?? 24; const result = { cameraId: request.cameraId ?? 'camera-main', frame: request.frame ?? 24, width, height: 16, engine: 'CYCLES', renderConfig: config(width, 3), cameraFacts: camera(request.frame ?? 24) }; reports.push(result); return result }
  ctx.provide('blenderRuntime', {
    async resolveEngineKey() { return { blenderEngine: 'CYCLES', warning: null } },
    async compileScene(r) { const directory = join(r.projectRoot, 'compiler'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'result.blend'), 'checkpoint'); r.onWorkingDirectory({ directory }); return { envelope: {}, report: { validation: {}, sceneFingerprint: { totalPolygons: 1 } } } },
    async renderPreview(r) { const measured = report(r); mkdirSync(join(r.outputPath, '..'), { recursive: true }); writeFileSync(r.outputPath, encodePng(createImage(measured.width, 16, [30, 40, 50, 255]))); return { envelope: {}, report: measured } },
    async renderViews(r) { const views = r.views.map(v => ({ ...report({ ...r, ...v }), viewId: v.id, outputPath: `/controlled/${v.id}.png` })); return { envelope: {}, durationMs: 1, pngs: Object.fromEntries(views.map(v => [v.viewId, encodePng(createImage(v.width, v.height, [30, 40, 50, 255]))])), report: { views, renderConfig: { ...config(), samples: 999 } } } },
  })
  const studio = new Studio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), maxPreviewSamples: 8, reconcileOnStart: false }))
  const created = await studio.createProject({ projectId: 'measured', title: 'measured', sceneSpec: fixture, saveCheckpoint: true, renderPreview: true })
  const render = width => studio.renderViews({ projectId: 'measured', revision: 'r0001', views: [{ id: 'hero', cameraId: 'camera-main', frame: 24 }, { id: 'later', cameraId: 'camera-main', frame: 36 }], width, height: 16, samples: 12 })
  return { studio, created, reports, render, root }
}

test('creation and independent single renders retain evaluated camera snapshots', async t => {
  const h = await setup(t), initial = h.created.revision.previews[0], result = await h.studio.renderPreview({ projectId: 'measured', revision: 'r0001', cameraId: 'camera-main', frame: 36, width: 24, height: 16, samples: 12 })
  assert.deepEqual(initial.cameraFacts, camera(24)); assert.deepEqual(result.artifacts[0].cameraFacts, camera(36))
  h.reports.at(-1).cameraFacts.lens = 99; assert.equal(result.artifacts[0].cameraFacts.lens, 58)
})

test('view and sheet budgets retain per-view measurements, never the request or last-view summary', async t => {
  const h = await setup(t), first = await h.render(24), current = first.previewSheets.current
  assert.deepEqual(first.views.map(v => v.samples), [3, 3]); assert.deepEqual(first.artifacts.filter(a => a.kind === 'view').map(a => a.samples), [3, 3])
  assert.deepEqual(current.viewSettings.map(v => [v.viewId, v.cameraId, v.frame, v.width, v.samples]), [['hero', 'camera-main', 24, 24, 3], ['later', 'camera-main', 36, 24, 3]])
  assert.ok(current.viewSettings.every(v => v.renderConfig.samples === 3 && v.cameraFacts.frame === v.frame))
  const original = structuredClone(current.viewSettings); h.reports.at(-1).renderConfig.samples = 50; h.reports.at(-1).cameraFacts.lens = 99
  assert.deepEqual(current.viewSettings, original)
  const next = await h.render(32); assert.deepEqual(next.previewSheets.previous.viewSettings, original)
  assert.equal(next.previewSheets.current.viewSettings[0].width, 32)
  const schema = compileSchema(JSON.parse(readFileSync(new URL('../../schemas/job-result.schema.json', import.meta.url))), 'job-result.schema.json')
  for (const result of [first, next]) assert.deepEqual(schema(JSON.parse(readFileSync(join(h.root, 'projects/measured/jobs', result.job.jobId + '.json')))), [])
})

test('an older runtime without measured view config keeps sampling and camera facts unknown', async t => {
  const h = await setup(t), render = h.studio.runtime.renderViews.bind(h.studio.runtime)
  h.studio.runtime.renderViews = async r => { const result = await render(r); for (const view of result.report.views) { delete view.renderConfig; delete view.cameraFacts } return result }
  const result = await h.render(24)
  assert.ok(result.artifacts.filter(a => a.kind === 'view').every(a => a.samples === null && a.renderConfig === null && a.cameraFacts === null))
  assert.ok(result.previewSheets.current.viewSettings.every(v => v.samples === null && v.renderConfig === null && v.cameraFacts === null))
})

test('latest and revision panes show measured pixels, sampling and camera without using a project profile', () => {
  const after = single('r0001', 'after')
  for (const mode of ['result', 'renders', 'revisions']) {
    const rendered = view(null, after, mode), panel = rendered.nodes.find(n => n.props['data-preview-settings'] === after.path)
    assert.ok(panel); assert.ok(text(panel).includes('24×16')); assert.ok(text(panel).includes('samples 4')); assert.ok(text(panel).includes('hero')); assert.ok(text(panel).includes('frame 24')); assert.ok(text(panel).includes('lens 58')); assert.ok(text(panel).includes('AgX'))
  }
})

test('complete matching conditions ignore source changes and object-key ordering', () => {
  const before = single('r0001', 'before'), after = single('r0001', 'after', { sourceDigest: 'new-scene' })
  after.cameraFacts = Object.fromEntries(Object.entries(after.cameraFacts).reverse())
  assert.equal(view(before, after).conditions.props['data-preview-conditions'], 'matching')
})

test('resolution and actual sampling differences are identified together', () => {
  const rendered = view(single('r0001', 'before'), single('r0001', 'after', { width: 32, samples: 8, renderConfig: config(32, 8) }))
  assert.equal(rendered.conditions.props['data-preview-conditions'], 'different'); assert.ok(text(rendered.conditions).includes('resolution')); assert.ok(text(rendered.conditions).includes('samples'))
})

test('camera lens and evaluated pose differences remain visible with the same camera ID', () => {
  for (const change of [c => { c.lens = 70 }, c => { c.matrixWorld[0][3] = 1 }, c => { c.dof.enabled = true }]) {
    const after = single('r0001', 'after'); change(after.cameraFacts)
    const rendered = view(single('r0001', 'before'), after); assert.equal(rendered.conditions.props['data-preview-conditions'], 'different'); assert.ok(text(rendered.conditions).includes('camera'))
  }
})

test('frame, engine, color, transparency and animation timing changes each affect comparison', () => {
  const changes = [[a => { a.frame = 36; a.cameraFacts.frame = 36 }, 'frame'], [a => { a.engine = a.renderConfig.engine = 'BLENDER_EEVEE' }, 'engine'], [a => { a.renderConfig.exposure = 1 }, 'color'], [a => { a.renderConfig.filmTransparent = true }, 'transparency'], [a => { a.renderConfig.fps = 24 }, 'timing']]
  for (const [change, label] of changes) { const after = single('r0001', 'after'); change(after); const rendered = view(single('r0001', 'before'), after); assert.equal(rendered.conditions.props['data-preview-conditions'], 'different'); assert.ok(text(rendered.conditions).includes(label)) }
})

test('legacy or conflicting measurements cannot be labelled matching or fabricate a sample count', () => {
  for (const changes of [{ cameraFacts: null }, { renderConfig: null, samples: 64 }, { samples: 128 }, { cameraFacts: { ...camera(), matrixWorld: [] } }]) {
    const after = single('r0001', 'after', changes), rendered = view(single('r0001', 'before'), after)
    assert.equal(rendered.conditions.props['data-preview-conditions'], 'unknown')
    if (!after.renderConfig) assert.ok(!text(rendered.nodes.find(n => n.props['data-preview-settings'] === after.path)).includes('samples 64'))
  }
})

test('sheet pixels are labelled separately from constituent budgets and every view is displayed', () => {
  const settings = [single('r0001', 'v1', { viewId: 'front' }), single('r0001', 'v2', { viewId: 'later', frame: 36, cameraFacts: camera(36) })]
  const after = sheet('after', settings), rendered = view(null, after, 'result'), panel = rendered.nodes.find(n => n.props['data-preview-settings'] === after.path)
  assert.ok(text(panel).includes('Sheet image 999×300')); assert.ok(text(panel).includes('24×16')); assert.equal(walk(panel).filter(n => n.props['data-render-view-id']).length, 2)
  assert.equal(view(sheet('before', settings), after).conditions.props['data-preview-conditions'], 'matching')
  assert.equal(view(sheet('before', settings, { columns: 2 }), after).conditions.props['data-preview-conditions'], 'different')
  const incomplete = view(sheet('before', [settings[0]]), sheet('after', [settings[0], { ...settings[1], cameraFacts: null }])).conditions
  assert.equal(incomplete.props['data-preview-conditions'], 'different'); assert.equal(incomplete.props['data-preview-conditions-incomplete'], 'true')
})

test('old sheets keep unknown settings instead of borrowing newer mutable view records', () => {
  const before = sheet('before', undefined), after = sheet('after', [{ ...single('r0001', 'new'), viewId: 'hero' }]), snapshot = structuredClone(before), rendered = view(before, after)
  assert.equal(rendered.conditions.props['data-preview-conditions'], 'different'); assert.equal(rendered.conditions.props['data-preview-conditions-incomplete'], 'true')
  assert.equal(rendered.nodes.filter(n => n.props['data-render-settings-missing']).length, 1); assert.deepEqual(before, snapshot)
})

test('standalone redraw protects held pointers and recovers on release, cancellation, blur and disposal', async () => {
  const surface = () => { const listeners = new Map(); return { listeners, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) } }
  const doc = { ...surface(), defaultView: surface(), head: { appendChild() {} }, querySelector: () => null,
    createTextNode: text => ({ text }), createDocumentFragment: () => ({ children: [], appendChild(node) { this.children.push(node) } }),
    createElement: tag => ({ tag, attrs: {}, dataset: {}, style: {}, children: [], setAttribute(key, value) { this.attrs[key] = value }, addEventListener() {}, appendChild(node) { this.children.push(node) } }) }
  const root = { ...surface(), ownerDocument: doc, classList: { add() {} }, children: [], querySelector: () => null,
    querySelectorAll() { return this.scroller ? [this.scroller] : [] },
    replaceChildren(...nodes) { this.children = nodes; this.scroller = { dataset: { scrollKey: 'same' }, scrollTop: 0, scrollLeft: 0 } } }
  const mounted = await core.mountStandalone(root, { fetch: async () => ({ status: 503, json: async () => ({ ok: false, error: { code: 'TEST_UNAVAILABLE', message: 'controlled offline host' } }) }), pollIdleMs: 60000 })
  const tick = () => new Promise(resolve => setTimeout(resolve, 10)); let disposed = false
  try {
    await tick(); root.scroller.scrollTop = 321; root.scroller.scrollLeft = 44; mounted.store.actions.setForm('title', 'scroll')
    assert.deepEqual([root.scroller.scrollTop, root.scroller.scrollLeft], [321, 44])
    root.scroller.dataset.scrollKey = 'different'; mounted.store.actions.setForm('title', 'changed surface')
    assert.deepEqual([root.scroller.scrollTop, root.scroller.scrollLeft], [0, 0])
    const before = root.children
    root.listeners.get('pointerdown')({ pointerId: 1 }); mounted.store.actions.setForm('title', 'one')
    assert.equal(root.children, before)
    root.listeners.get('pointerdown')({ pointerId: 2 }); mounted.store.actions.setForm('title', 'two')
    doc.listeners.get('pointerup')({ pointerId: 1 }); await tick(); assert.equal(root.children, before)
    doc.listeners.get('pointercancel')({ pointerId: 2 }); await tick(); assert.notEqual(root.children, before); assert.equal(mounted.store.getState().forms.title, 'two')
    const released = root.children; root.listeners.get('pointerdown')({ pointerId: 3 }); mounted.store.actions.setForm('title', 'three')
    doc.defaultView.listeners.get('blur')(); await tick(); assert.notEqual(root.children, released)
    root.listeners.get('pointerdown')({ pointerId: 4 }); mounted.store.actions.setForm('title', 'four'); doc.listeners.get('pointerup')({ pointerId: 4 })
    mounted.dispose(); disposed = true; await tick(); assert.deepEqual(root.children, [])
    assert.equal(root.listeners.size + doc.listeners.size + doc.defaultView.listeners.size, 0)
  } finally { if (!disposed) mounted.dispose() }
})
