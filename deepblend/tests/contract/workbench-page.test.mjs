#!/usr/bin/env node
/**
 * The standalone fullscreen workbench (SPEC §20 M6) — and the ONE thing that
 * could go wrong with it.
 *
 * WHAT THIS SUITE UNIQUELY PROVES
 * -------------------------------
 * M6's item is one line in SPEC §20 ("独立全屏工作台") with no acceptance block of
 * its own, so it inherits M4's: manage a project without touching the filesystem,
 * recover the authoritative state after a refresh, never start Blender from the
 * browser, and put every write through the Host. The browser half of that is
 * `e2e/workbench-page.e2e.mjs`, in a real Chrome.
 *
 * What THIS file is for is the failure this milestone is actually exposed to:
 * **a second implementation of the M4 workbench.** A full-screen page has to show
 * the same six tabs, the same revision header and the same preview comparison —
 * and writing that a second time is not a shortcut, it is a second source of
 * truth: both get edited, and the one that rots first is the one nobody is
 * looking at.
 *
 * So the assertions here are about IDENTITY, not about appearance:
 *
 *   1. **The standalone page loads the console's own bundle.** The document's
 *      bootstrap imports the module id this bundle registers itself under, out of
 *      `window.__DSH_BOOT__` — the same graph the console reads.
 *   2. **The core is React-free.** The whole page is built and mounted with a
 *      `require` that throws on EVERY specifier. If any of the six tabs needed
 *      React, this fails.
 *   3. **Both faces draw the same tree from the same store.** A store is driven
 *      against scripted Host responses, and for all six tabs — plus the diff
 *      branch — the console binding and the page binding are compared node for
 *      node: same tags, same classes, same `data-*`, in the same order.
 *   4. **`mountStandalone` really goes through that builder.** Its own output is
 *      compared with the shared builder's output for the state its store actually
 *      loaded, which is what makes "the page has no renderer of its own" a fact
 *      about behaviour rather than about a call count.
 *   5. **The console's own panel is that tree.** The `main` seat is rendered
 *      through the same Node renderer the M4 card suite uses, and it produces the
 *      panel root and the six tabs — so the console did not keep a private copy.
 *   6. **The bindings are generic.** Fed a node the workbench never builds, they
 *      render it; and the binding section of the source names no route, no tab and
 *      no domain noun. A generic renderer cannot be a second implementation of the
 *      thing it renders.
 *
 * Run standalone: `node deepblend/tests/contract/workbench-page.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs` / `bash deepblend/tests/run-all.sh`
 *
 * Owner: DeepBlend Studio — M6
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { UI_PANEL_VIEWS, UI_ROUTES, UI_ROUTE_PREFIX } from '@deepblend/dsh-blender-contracts'

import {
  UI_PACKAGE,
  UI_MODULE_ID,
  loadClientBundle,
  makeReactStub,
  mountClient,
  renderTree,
  findNodes,
} from '../lib/client-bundle.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

// ---------------------------------------------------------------------------
// A document-shaped RECORDER for `toDom`
// ---------------------------------------------------------------------------
//
// It is not a DOM and it does not pretend to be one: it implements the calls
// `toDom` and `applyProps` actually make, and keeps what they produced as DATA so
// the two bindings' trees can be compared. The real DOM proof for the standalone
// page is the browser suite; this is the structural half, and it runs on a
// machine with no Chrome, no Blender and no server.

function createDocumentRecorder() {
  const doc = {
    head: { children: [], appendChild(node) { this.children.push(node) } },
    querySelector() { return null },
    createTextNode(text) { return { kind: 'text', text: String(text) } },
    createDocumentFragment() {
      return { kind: 'fragment', children: [], appendChild(node) { this.children.push(node) } }
    },
    createElement(tag) {
      return {
        kind: 'element',
        tag,
        attrs: {},
        dataset: {},
        style: {},
        listeners: {},
        children: [],
        value: undefined,
        disabled: undefined,
        ownerDocument: doc,
        setAttribute(name, value) { this.attrs[name] = String(value) },
        addEventListener(name, handler) { this.listeners[name] = handler },
        appendChild(node) { this.children.push(node) },
        querySelector() { return null },
      }
    },
  }
  return doc
}

/** A mount root, in the same spirit as the document recorder. */
function createRootRecorder(doc) {
  return {
    ownerDocument: doc,
    classList: { add() {} },
    children: [],
    replaceChildren(...nodes) { this.children = nodes },
    querySelector() { return null },
  }
}

// ---------------------------------------------------------------------------
// One shape for both trees
// ---------------------------------------------------------------------------

/** The part of a recorded DOM node both bindings must agree on. */
function domShape(node) {
  if (node === null || node === undefined) return null
  if (node.kind === 'text') return { text: node.text }
  if (node.kind === 'fragment') return { fragment: node.children.map(domShape).filter(Boolean) }
  const attrs = { ...node.attrs }
  if (Object.keys(node.style).length > 0) attrs.style = JSON.stringify(node.style)
  if (node.value !== undefined) attrs.value = String(node.value)
  if (node.disabled !== undefined) attrs.disabled = String(node.disabled)
  return { tag: node.tag, attrs, children: node.children.map(domShape).filter(Boolean) }
}

/**
 * The same shape, read off a rendered React tree.
 *
 * The two normalizations are deliberately the same function in spirit: `className`
 * is `class`, `style` is its JSON, `value`/`disabled` are the properties they
 * become, listeners and `key` are not part of the tree's identity, and everything
 * else is an attribute. Anything that survives this is something both faces show.
 */
function reactShape(node) {
  if (node === null || node === undefined) return null
  if (typeof node === 'string') return { text: node }
  if (typeof node !== 'object') return null
  if (Array.isArray(node)) return node.map(reactShape).filter(Boolean)

  const attrs = {}
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key === 'children' || key === 'key') continue
    if (typeof value === 'function') continue
    if (value === undefined || value === null || value === false) continue
    if (key === 'className') { attrs.class = String(value); continue }
    if (key === 'style') { attrs.style = JSON.stringify(value); continue }
    if (key === 'value') { attrs.value = String(value); continue }
    if (key === 'disabled') { attrs.disabled = 'true'; continue }
    if (key === 'spellCheck') { attrs.spellcheck = String(value); continue }
    attrs[key] = value === true ? '' : String(value)
  }
  const children = Array.isArray(node.children) ? node.children : [node.children]
  return { tag: node.tag, attrs, children: children.map(reactShape).filter(Boolean) }
}

/** Every value of one attribute in a shape, in document order. */
function attrsNamed(shape, name) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (node.text !== undefined) return
    if (node.attrs !== undefined && node.attrs[name] !== undefined) found.push(node.attrs[name])
    for (const child of node.children ?? []) walk(child)
  }
  walk(shape)
  return found
}

/** How many nodes a shape holds, so a mismatch reports its size and not just its truth. */
function countNodes(shape) {
  if (shape === null || shape === undefined) return 0
  if (Array.isArray(shape)) return shape.reduce((sum, child) => sum + countNodes(child), 0)
  return 1 + (shape.children ?? []).reduce((sum, child) => sum + countNodes(child), 0)
}

/** The first path at which two shapes disagree, for a diagnostic worth reading. */
function firstDifference(left, right, path = '$') {
  if (JSON.stringify(left) === JSON.stringify(right)) return null
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return { path, left, right }
  }
  if (left.tag !== right.tag) return { path: `${path}.tag`, left: left.tag, right: right.tag }
  const leftAttrs = JSON.stringify(left.attrs ?? left.text)
  const rightAttrs = JSON.stringify(right.attrs ?? right.text)
  if (leftAttrs !== rightAttrs) return { path: `${path}.attrs`, left: left.attrs ?? left.text, right: right.attrs ?? right.text }
  const leftChildren = left.children ?? []
  const rightChildren = right.children ?? []
  if (leftChildren.length !== rightChildren.length) {
    return { path: `${path}.children.length`, left: leftChildren.length, right: rightChildren.length }
  }
  for (let index = 0; index < leftChildren.length; index += 1) {
    const found = firstDifference(leftChildren[index], rightChildren[index], `${path}.children[${index}]`)
    if (found !== null) return found
  }
  return { path, left, right }
}

// ---------------------------------------------------------------------------
// A scripted Host
// ---------------------------------------------------------------------------
//
// The payloads below are the ROUTE responses, in the shapes the Host really
// sends, rather than a hand-built store snapshot. That matters: the store derives
// its state from them, so what the two faces are compared on is the state the
// product would actually hold — not a fixture that agrees with the views because
// the same person wrote both.

const SHEET = (slot, digest, revision) => ({
  slot,
  path: `revisions/${revision}/contact-sheets/${slot}.png`,
  sha256: digest,
  bytes: 4096,
  at: '2026-09-22T05:09:39.444Z',
})

const DEMO_PROJECT = {
  projectId: 'demo', title: 'Demo', currentRevision: 'r0003', revisionCount: 3,
  createdAt: '2026-09-22T05:00:00.000Z', updatedAt: '2026-09-22T05:09:39.444Z',
  goal: 'a turntable', unfinishedJobs: 1,
}

const ROUTE_PAYLOADS = {
  state: () => ({
    ok: true, route: 'state', hostApiVersion: 4, panelId: 'deepblend',
    projects: [DEMO_PROJECT], projectsRoot: '/tmp/projects',
    selected: {
      project: { projectId: 'demo', title: 'Demo', revisionCount: 3, currentRevision: 'r0003', unfinishedJobs: 1 },
      currentRevision: 'r0003',
      revisions: [
        { revision: 'r0002', kind: 'scene_patch', digest: 'bbbbbbbbbbbbbbbb', createdAt: '2026-09-22T05:08:00.000Z', summary: 'moved the body', isCurrent: false, previews: [{ path: 'a.png', kind: 'preview' }], contactSheets: [SHEET('preview-current', 'dddddddddddddddd', 'r0002')], reviews: [{ pass: true, score: 88 }], validation: { ok: true, errorCount: 0 } },
        { revision: 'r0003', kind: 'scene_patch', digest: 'cccccccccccccccc', createdAt: '2026-09-22T05:09:00.000Z', summary: 'turned the light down', isCurrent: true, previews: [], contactSheets: [SHEET('preview-previous', 'dddddddddddddddd', 'r0003'), SHEET('preview-current', 'eeeeeeeeeeeeeeee', 'r0003')], reviews: [{ pass: false, score: 41 }], validation: { ok: false, errorCount: 2 } },
      ],
      jobs: [{
        jobId: 'render-0001', status: 'running', type: 'final-render', frameStart: 1, frameEnd: 3,
        approval: { required: false, threshold: 900, frames: 3 }, deliverable: false, cancelable: true, resumable: false,
        progress: { completed: 0, expected: 3, percent: 0, missing: 3, corrupt: 0 },
        detail: '0/3 帧，可继续渲染', errorCode: null, message: null, delivery: null,
      }],
      unfinishedJobs: [{ jobId: 'render-0001' }],
      scene: {
        revision: 'r0003', digest: 'cccccccccccccccc',
        project: { id: 'demo', title: 'Demo', fps: 30, frameStart: 1, frameEnd: 60, activeCamera: 'camera-main' },
        world: { color: [0.05, 0.05, 0.05], strength: 1 },
        counts: { entities: 1, materials: 1, lights: 1, cameras: 1 },
        nodes: {
          entities: [{ id: 'body', kind: 'generator', shape: 'rounded_box', materialId: 'mat-body', locked: false, tags: ['hero'], transform: { location: [0, 0, 1] } }],
          materials: [{ id: 'mat-body', shader: 'principled', parameters: { baseColor: [1, 0, 0, 1], roughness: 0.4 } }],
          lights: [{ id: 'key', type: 'AREA', energy: 120 }],
          cameras: [{ id: 'camera-main', isActive: true, role: 'hero', lens: 50 }],
          shots: [{ id: 'shot-1', cameraId: 'camera-main', frameRange: [1, 60] }],
          animationTracks: [{ id: 'track-1', targetKind: 'entity', targetId: 'body', property: 'rotationEuler', keyframes: 3 }],
          assets: [{ id: 'asset-1', type: 'glb', path: 'assets/body.glb' }],
        },
      },
      qa: {
        revision: 'r0003', summary: '技术校验 2 处错误 · 视觉评分 41',
        technical: { available: true, ok: false, errorCount: 2, engine: 'CYCLES', activeCamera: 'camera-main', frameRange: [1, 60], counts: { objects: 4, materials: 1, cameraObjects: 1 }, errors: [{ severity: 'critical', code: 'NO_ACTIVE_CAMERA', category: 'scene', evidence: 'x' }] },
        visual: { available: true, pass: false, score: 41, iteration: 2, subjectId: 'body', viewCount: 3, reviewerAvailable: true, reviewerModel: 'deepseek-vl', reviewerError: null, measuredIssues: [{ severity: 'major', code: 'SUBJECT_TOO_SMALL', viewId: 'front', evidence: 'y' }], findings: [{ severity: 'minor', code: 'LIGHTING_FLAT', evidence: 'z' }], measuredIssueCount: 1, findingCount: 1 },
        semantic: { noticeCount: 1, notices: [{ code: 'WORLD_DEFAULT', message: 'world colour not set' }] },
      },
    },
  }),
  jobs: () => ({ ok: true, route: 'project.jobs', projectId: 'demo', jobs: ROUTE_PAYLOADS.state().selected.jobs, unfinished: [{ jobId: 'render-0001' }], recovery: null }),
  previews: () => ({
    ok: true, route: 'project.previews', artifactBase: '/deepblend/artifacts/demo/',
    previews: {
      projectId: 'demo',
      revisions: [
        { revision: 'r0002', isCurrent: false, summary: 'moved the body', createdAt: '2026-09-22T05:08:00.000Z', digest: 'bbbbbbbbbbbbbbbb', previews: [], contactSheets: [SHEET('preview-current', 'dddddddddddddddd', 'r0002')], reviews: [{ pass: true, score: 88 }] },
        { revision: 'r0003', isCurrent: true, summary: 'turned the light down', createdAt: '2026-09-22T05:09:00.000Z', digest: 'cccccccccccccccc', previews: [], contactSheets: [SHEET('preview-previous', 'dddddddddddddddd', 'r0003'), SHEET('preview-current', 'eeeeeeeeeeeeeeee', 'r0003')], reviews: [] },
      ],
    },
  }),
  diff: () => ({
    ok: true, route: 'project.diff', fromRevision: 'r0002', toRevision: 'r0003',
    diff: {
      identical: false, fromRevision: 'r0002', toRevision: 'r0003', totalChanges: 1,
      collections: { entities: { added: [], removed: [], changed: [{ id: 'body', fields: [{ field: 'transform.location', from: [0, 0, 1], to: [0, 0, 2] }] }] }, materials: { added: [], removed: [], changed: [] } },
      project: [{ field: 'frameEnd', from: 60, to: 90 }],
      world: [],
    },
  }),
  patch: () => ({ ok: true, route: 'project.patch', revision: { revision: 'r0004', digest: 'ffffffffffffffff' } }),
}

/** A `fetch` that answers the scripted Host, and refuses anything else loudly. */
function scriptedFetch(input, init) {
  const url = String(input)
  const method = (init && init.method) || 'GET'
  const body = (() => {
    try { return init && init.body ? JSON.parse(init.body) : null } catch { return null }
  })()
  const respond = (payload) => Promise.resolve({
    status: 200,
    ok: true,
    async text() { return JSON.stringify(payload) },
    async json() { return payload },
  })
  if (method === 'POST' && url.endsWith('/patch')) return respond(ROUTE_PAYLOADS.patch())
  if (url.includes('/diff')) return respond(ROUTE_PAYLOADS.diff())
  if (url.includes('/previews')) return respond(ROUTE_PAYLOADS.previews())
  if (url.includes('/jobs')) return respond(ROUTE_PAYLOADS.jobs())
  if (url.includes('/deepblend/state')) return respond(ROUTE_PAYLOADS.state())
  if (method === 'POST') return respond({ ok: false, error: { code: 'TEST_UNSCRIPTED', message: `no scripted answer for ${method} ${url} (${JSON.stringify(body)})` } })
  return respond({ ok: false, error: { code: 'TEST_UNSCRIPTED', message: `no scripted answer for ${method} ${url}` } })
}

/** Let the store's in-flight reads settle. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 5) })

/** Build a store that has finished its first load against the scripted Host. */
async function loadedStore() {
  const store = core.createWorkbenchStore({ fetch: scriptedFetch })
  store.start()
  await settle()
  return store
}

// ---------------------------------------------------------------------------
// Part 1 — the standalone page loads the console's own bundle
// ---------------------------------------------------------------------------

const source = readFileSync(join(UI_PACKAGE, 'lib', 'client.js'), 'utf8')
const hostModule = await import('@deepblend/dsh-blender-ui')

{
  const route = UI_ROUTES.find(entry => entry.id === 'workbench.page')
  check('the workbench page is a declared route in the closed set',
    route !== undefined && route.method === 'GET' && route.path === `${UI_ROUTE_PREFIX}/workbench`, route)
  check('and it is a READ route: a page is not a write',
    route !== undefined && route.write === false, route?.write)
  check('the Host half names the same path, so the two spellings cannot drift',
    hostModule.WORKBENCH_PAGE_ROUTE === route.path,
    { host: hostModule.WORKBENCH_PAGE_ROUTE, table: route.path })

  const document = hostModule.workbenchPageDocument(hostModule.WORKBENCH_PAGE_ROOT_ID)
  check('the document imports the module id this bundle registers itself under',
    document.includes(`modules.import('${UI_MODULE_ID}')`)
    && source.includes(`id: '${UI_MODULE_ID}'`),
    { imported: UI_MODULE_ID })
  check('the document mounts through this bundle\'s own entry point',
    document.includes('bundle.mountStandalone(root)'))
  check('the document builds the module system from the boot graph, not from a second copy of anything',
    document.includes('window.__ModuleLoader__.create({ boot: window.__DSH_BOOT__, staticModules: {} })'))
  check('the document reserves the element it mounts into',
    document.includes(`id="${hostModule.WORKBENCH_PAGE_ROOT_ID}"`))
  check('the document carries no workbench markup of its own: one empty root and the bootstrap',
    !/data-view|data-deepblend-panel|db-root|db-card/.test(document),
    document.length)
}

// ---------------------------------------------------------------------------
// Part 2 — the core is React-free, and the page mounts with no React at all
// ---------------------------------------------------------------------------

/**
 * Load the bundle with a `require` that refuses everything.
 *
 * This is the load-bearing assertion of the whole design. The console supplies
 * React as a platform seed word; the standalone page supplies no seed at all
 * (`staticModules: {}`). If the workbench core reached for React — at factory
 * time, or from inside a view — the standalone page would not render, and this
 * call is where that shows up instead of on a blank full-screen page.
 */
const reactless = (() => {
  try {
    return { exports: loadClientBundle({
      resolve: (specifier) => { throw new Error(`this bundle must not require "${specifier}" to serve the standalone page`) },
    }).exports }
  } catch (error) {
    return { error }
  }
})()

check('the bundle materializes with a require that refuses every specifier',
  reactless.error === undefined && typeof reactless.exports?.mountStandalone === 'function',
  reactless.error === undefined ? Object.keys(reactless.exports) : `threw: ${reactless.error.message}`)

const core = reactless.exports?.workbench

if (core === undefined) {
  check('the React-free core is reachable, so the standalone page has something to mount', false, 'the bundle did not load')
} else {
  check('the console seats are still exported from the same bundle',
    typeof reactless.exports.apply === 'function' && Array.isArray(reactless.exports.inject))

  const doc = createDocumentRecorder()
  const root = createRootRecorder(doc)
  const mounted = await core.mountStandalone(root, { fetch: scriptedFetch })
  await settle()

  const drawn = domShape(root.children[0])
  check('mountStandalone renders the whole workbench with no React in the process',
    drawn !== null && drawn.tag === 'div' && drawn.attrs['data-deepblend-panel'] === 'deepblend',
    drawn === null ? null : { tag: drawn.tag, attrs: drawn.attrs })
  check('and it renders all six tabs, from the one view list',
    JSON.stringify(attrsNamed(drawn, 'data-view-tab')) === JSON.stringify(core.VIEWS.map(view => view.id)),
    attrsNamed(drawn, 'data-view-tab'))
  check('it installed the workbench stylesheet and the standalone theme fallback',
    doc.head.children.length === 2, doc.head.children.map(tag => tag.dataset.pluginCss))

  // The assertion a hand-written page would fail: what the mount actually drew is
  // what the shared builder produces for the state its own store loaded.
  const expected = domShape(core.toDom(core.buildWorkbenchView(mounted.store.getState(), mounted.store.actions), createDocumentRecorder()))
  check('and what it drew is the shared builder\'s own output for the state it loaded — not a tree of its own',
    JSON.stringify(drawn) === JSON.stringify(expected),
    JSON.stringify(drawn) === JSON.stringify(expected)
      ? { nodes: countNodes(drawn) }
      : firstDifference(drawn, expected))

  mounted.dispose()
  check('and disposing it leaves the page empty rather than half-mounted', root.children.length === 0)
  check('the state it loaded came from the Host, so the mount is not a static sketch',
    mounted.store.getState().status === 'ok' && mounted.store.getState().selected !== null,
    { status: mounted.store.getState().status })
}

// ---------------------------------------------------------------------------
// Part 3 — the six tabs are declared once, and the page's list is that list
// ---------------------------------------------------------------------------

// THE LABELS ARE LOCALIZED NOW (ledger C16), and this suite runs with NO `document`, which is the
// harness's own "non-browser" case: the copy falls back to English. So the claim this check makes is
// about the IDS — the vocabulary the contracts package owns — and the labels are checked against the
// bundle's own table rather than against a language this test would have to guess.
check('the bundle renders the six views the contracts package declares, in order',
  core !== undefined &&
  JSON.stringify(core.VIEWS.map(view => view.id)) === JSON.stringify(UI_PANEL_VIEWS.map(view => view.id)) &&
  core.VIEWS.every(view => typeof view.label === 'string' && view.label.length > 0),
  { client: core?.VIEWS.map(view => view.id), contracts: UI_PANEL_VIEWS.map(view => view.id) })

{
  // A second renderer would have to spell the markers again. These count the
  // spellings: the nav is built from `VIEWS`, so its marker appears once, and the
  // panel root appears once.
  const viewIds = [...source.matchAll(/['"]data-view['"]\s*:\s*'([a-z]+)'/g)].map(match => match[1])
  check('every `data-view` the bundle can emit is one of the six, and every one of the six is emitted',
    JSON.stringify([...new Set(viewIds)].sort()) === JSON.stringify(core.VIEWS.map(view => view.id).sort()),
    [...new Set(viewIds)].sort())
  check('the tab marker is spelled exactly once in the bundle, because the nav is built from the list',
    source.split("'data-view-tab'").length - 1 === 1, source.split("'data-view-tab'").length - 1)
  check('the panel root marker is spelled exactly once in the bundle',
    source.split("'data-deepblend-panel'").length - 1 === 1, source.split("'data-deepblend-panel'").length - 1)
}

// ---------------------------------------------------------------------------
// Part 3b — a notice belongs to the tab it happened in
//
// This is not decoration. The M4 console suite sequences itself by waiting for a
// view's success notice after clicking that view's button, and it broke exactly
// here when the store first landed: the notice outlived a tab round-trip, so the
// wait was satisfied by the PREVIOUS edit's message and the next click went out
// before the write it was supposed to follow. Measured, not imagined — the run
// rendered a preview against the revision the patch had not committed yet.
// ---------------------------------------------------------------------------

if (core !== undefined) {
  const store = await loadedStore()
  const notices = () => store.getState().notices
  check('a fresh store opens on 项目 and carries no notice at all',
    store.getState().view === 'projects' && Object.values(notices()).every(entry => entry === null),
    notices())

  store.actions.setView('scene')
  store.actions.setForm('patch', '{"baseRevision":"r0003"}')
  await store.actions.applyPatch()
  // The message is localized; the REVISION it names is the fact. `committed r0004 (digest …)` is the
  // English fallback this suite sees, and asserting the id rather than the wording is what makes this
  // check survive a translation.
  check('a committed patch leaves its result in the tab it was made in',
    notices().scene?.ok === true && /r0004/.test(notices().scene.message) &&
    !/^\s*scene\.committed\s*$/.test(notices().scene.message), notices().scene)

  store.actions.setView('scene')
  check('clicking the tab you are already on is not a re-entry, so the result stays',
    notices().scene?.ok === true, notices().scene)

  store.actions.setView('preview')
  store.actions.setView('scene')
  check('leaving a tab and coming back clears its result, so a stale 「已提交」 cannot read as the edit you just made',
    notices().scene === null, notices().scene)
  store.stop()
}

// ---------------------------------------------------------------------------
// Part 4 — both faces draw the SAME tree, for every one of the six tabs
// ---------------------------------------------------------------------------

if (core !== undefined) {
  const store = await loadedStore()
  const reactStub = makeReactStub()
  const doc = createDocumentRecorder()

  check('the scripted Host drove the store into a state with content in every tab',
    store.getState().status === 'ok'
    && store.getState().selected !== null
    && store.getState().previews !== null
    && store.getState().jobs.length > 0,
    { status: store.getState().status, jobs: store.getState().jobs.length, previews: store.getState().previews !== null })

  for (const view of core.VIEWS) {
    store.actions.setView(view.id)
    // The preview tab carries the structural-diff branch too, so it is driven
    // here rather than left to whichever face happens to render it.
    if (view.id === 'preview') await store.actions.diff('r0002', 'r0003')

    const snapshot = store.getState()
    const consoleShape = reactShape(renderTree(core.toReact(core.buildWorkbenchView(snapshot, store.actions), reactStub.createElement)))
    const pageShape = domShape(core.toDom(core.buildWorkbenchView(snapshot, store.actions), doc))
    const same = JSON.stringify(consoleShape) === JSON.stringify(pageShape)

    check(`the console and the standalone page render 视图「${view.label}」 as the same tree`,
      same,
      same ? { nodes: countNodes(consoleShape) } : {
        firstDifference: firstDifference(consoleShape, pageShape),
        consoleNodes: countNodes(consoleShape),
        pageNodes: countNodes(pageShape),
      })
    check(`视图「${view.label}」 is the active tab on both faces, and it rendered its own body`,
      attrsNamed(pageShape, 'data-view-tab').length === 6
      && attrsNamed(pageShape, 'data-view').includes(view.id)
      && JSON.stringify(attrsNamed(pageShape, 'data-view')) === JSON.stringify(attrsNamed(consoleShape, 'data-view')),
      { page: attrsNamed(pageShape, 'data-view'), console: attrsNamed(consoleShape, 'data-view') })
  }

  // Back to the tab the diff belongs to: the loop left the store on 版本, and the
  // diff branch lives in 预览对比.
  store.actions.setView('preview')
  const diffShape = domShape(core.toDom(core.buildWorkbenchView(store.getState(), store.actions), doc))
  check('and the diff branch rendered on both faces, so that comparison was not vacuous',
    store.getState().diff !== null && attrsNamed(diffShape, 'data-diff').length === 1,
    store.getState().diff === null ? 'the diff never arrived' : attrsNamed(diffShape, 'data-diff'))
  store.stop()
}

// ---------------------------------------------------------------------------
// Part 5 — the console's own `main` seat IS that tree
// ---------------------------------------------------------------------------

{
  const exports = loadClientBundle().exports
  const client = mountClient(exports)
  const main = client.registrations.find(entry => entry.options.name === 'main')
  check('the main seat is registered, so the console has a workbench to compare', main !== undefined)
  const tree = renderTree(main.component({}))
  const roots = findNodes(tree, node => node.props['data-deepblend-panel'] !== undefined)
  check('the seat renders the panel root from the shared builder, not from a private renderer',
    roots.length === 1 && roots[0].props['data-deepblend-panel'] === 'deepblend',
    roots.map(node => node.props['data-deepblend-panel']))
  const tabs = findNodes(tree, node => node.props['data-view-tab'] !== undefined).map(node => node.props['data-view-tab'])
  check('and it renders all six tabs',
    JSON.stringify(tabs) === JSON.stringify(exports.workbench.VIEWS.map(view => view.id)), tabs)
  // `buildWorkbenchView` is called from exactly three places, and the count is the
  // claim: the definition, the console seat, and the standalone mount. A fourth
  // call site would be a second panel; a missing one would mean a face that kept
  // its own renderer. (Function identity is NOT compared across loads — each load
  // runs the bundle in its own VM context, so identity would fail for a reason
  // that has nothing to do with this.)
  const builderCalls = source.split('buildWorkbenchView(').length - 1
  check('the shared builder is defined once and called from exactly the two faces',
    builderCalls === 3 && (source.match(/function buildWorkbenchView\(/g) ?? []).length === 1,
    { calls: builderCalls })
}

// ---------------------------------------------------------------------------
// Part 6 — the bindings are generic, so they cannot be a second implementation
// ---------------------------------------------------------------------------

if (core !== undefined) {
  const doc = createDocumentRecorder()
  const probe = core.el('x-widget', { 'data-probe': 'yes', style: { color: 'red' } }, 'hello')
  const dom = core.toDom(probe, doc)
  check('toDom renders a node the workbench never builds, so it is a walker rather than a script',
    dom.tag === 'x-widget' && dom.attrs['data-probe'] === 'yes' && dom.style.color === 'red' && dom.children[0].text === 'hello',
    domShape(dom))
  const react = reactShape(renderTree(core.toReact(probe, makeReactStub().createElement)))
  check('and toReact renders the same node the same way',
    JSON.stringify(react) === JSON.stringify(domShape(dom)), { react, dom: domShape(dom) })

  // A function tag is the shape a second renderer would take if someone started
  // building views outside the shared vocabulary: it must be loud, not blank.
  let threw = null
  try { core.toDom(core.el(() => null, {}), doc) } catch (error) { threw = error }
  check('a node whose tag is a component is refused loudly rather than rendered as nothing',
    threw !== null && /must be a string/.test(threw.message), threw?.message)
}

{
  /** One section of the bundle, read between the banners that mark it. */
  const section = (from, to) => {
    const start = source.indexOf(from)
    const end = source.indexOf(to)
    check(`the bundle still marks the section "${from.trim()}", so the bindings can be read in isolation`,
      start !== -1 && end > start, { start, end })
    return source.slice(start, end)
  }
  const bindings = section('// §I  The two bindings', '// §J  The standalone face')
  const standalone = section('// §J  The standalone face', '// §K  The console face')

  // The nouns a second implementation of the six tabs would have to name.
  const DOMAIN = ['/deepblend', 'blender', 'project', 'revision', 'job', 'qa', 'preview', 'scene', 'data-view', 'data-action', 'data-deepblend']
  const named = DOMAIN.filter(noun => bindings.toLowerCase().includes(noun.toLowerCase()))
  check('the two bindings name no route, no tab and no domain noun: they are a renderer, not a workbench',
    named.length === 0, named)
  check('the bindings are the two the views are drawn through, and there are no others',
    (source.match(/function to(React|Dom)\(/g) ?? []).length === 2,
    source.match(/function to(React|Dom)\(/g))

  // `mountStandalone` is the ONE place the two faces differ, and the only marker
  // it knows is the one it needs to put the caret back after a redraw.
  const markers = [...standalone.matchAll(/data-[a-z-]+/g)].map(match => match[0])
  check('the standalone mount knows exactly one marker, and it is the caret\'s',
    JSON.stringify([...new Set(markers)]) === JSON.stringify(['data-field']), [...new Set(markers)])
  const standaloneNouns = DOMAIN.filter(noun => noun !== 'data-view' && standalone.toLowerCase().includes(noun.toLowerCase()))
  check('and it names no route, no tab and no domain noun either',
    standaloneNouns.length === 0, standaloneNouns)
}

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok)
console.log(`\nstandalone workbench contract: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
