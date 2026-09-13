#!/usr/bin/env node
/**
 * The workbench UI's two planes, mounted and driven — no browser, no Blender.
 *
 * WHAT THIS SUITE UNIQUELY PROVES
 * -------------------------------
 *  1. **The route set is closed.** The Host half's handler table is exactly the
 *     route table in the contracts package, in both directions. A handler with no
 *     route would be a capability nobody listed; a route with no handler would be
 *     a promise the runtime cannot keep.
 *  2. **Every request goes through `blenderStudio`.** The handlers are driven
 *     against a recording stub of the facade, and each route's call is asserted
 *     against the method it is allowed to use — reads for GET, and exactly one
 *     named write for each POST. That is SPEC §20 M4's 「所有写操作经过 Host」 as a
 *     test rather than a sentence.
 *  3. **The module has no execution path.** The UI host source is asserted to
 *     import no filesystem and no process module, so 「浏览器不直接启动 Blender」
 *     cannot be broken by an edit that merely looks like a helper.
 *  4. **The client bundle registers a closed seat table** — loaded here for real,
 *     through the same `window.__ModuleLoader__.load` contract the browser uses,
 *     with a recording Slot registry. Every DeepBlend tool with a card is checked
 *     against the tools the preset actually registers, so the two lists cannot
 *     drift apart.
 *
 * The browser-side half of the acceptance (a real page, a real render, a real
 * refresh) is `deepblend/tests/e2e/ui.e2e.mjs`. This file is what runs everywhere,
 * including on a machine with no Blender.
 *
 * Run standalone: `node deepblend/tests/composition/ui-plane.e2e.mjs`
 * Run all:        `node deepblend/tests/run.mjs` (as a test) / `run-all.sh`
 */

import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import {
  UI_PANEL_ID,
  UI_ROUTES,
  UI_ROUTE_PREFIX,
  UI_TOOL_CARD_KEYS,
  buildSettingsCard,
} from '@deepblend/dsh-blender-contracts'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

import { importDsh } from '../lib/dsh-deployment.mjs'

/** The harness's OWN lossless-JSON rule, imported rather than reimplemented (M2.2). */
const { isJsonValue } = await importDsh('dsh-util-values')

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const UI_PACKAGE = join(PROJECT_ROOT, 'packages', 'deepblend', 'ui')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

// ---------------------------------------------------------------------------
// A recording stand-in for the authoritative facade
// ---------------------------------------------------------------------------

/** The methods a GET route may call. Reading is not writing, and both are named. */
const READ_METHODS = new Set([
  'describeCapabilities', 'listProjects', 'getProject', 'getScene', 'getRevisionDetail',
  'readRevisionPair', 'getQaRecord', 'listPreviewSets', 'readArtifact', 'listJobs', 'getJob',
])
/** The method each write route must call, and no other. */
const WRITE_METHOD = {
  'projects.create': 'createProject',
  'project.preview': 'renderViews',
  'project.patch': 'applyScenePatch',
  'project.restore': 'restoreRevision',
  'project.job.cancel': 'cancelJob',
  'project.render': 'startFinalRender',
}
/**
 * Every method that writes.
 *
 * `resumeRenderJob` is the second entry point behind one route (`project.render`
 * decides between starting and resuming), so it is allowed but is not any
 * route's single expected call — the resume case is asserted on its own below.
 */
const ALLOWED_WRITES = new Set([...Object.values(WRITE_METHOD), 'resumeRenderJob'])

/**
 * The facade stub: every call is recorded, and every answer looks like the real
 * one's shape (the view builders run on it, so the shapes matter).
 */
function createStudioStub() {
  const calls = []
  const record = (name, args) => {
    calls.push({ name, args })
    if (!READ_METHODS.has(name) && !ALLOWED_WRITES.has(name)) {
      throw new Error(`the UI called an unlisted facade method: ${name}`)
    }
  }
  const manifest = { revision: 'r0002', revisionNumber: 2, kind: 'scene_patch', digest: 'd2', baseRevision: 'r0001', createdAt: '2026-09-13T00:00:00.000Z', summary: 'x', previews: [], contactSheets: [], reviews: [] }
  const spec = {
    schemaVersion: 'deepblend.scene/v1',
    project: { id: 'demo', title: 'Demo', fps: 30, frameStart: 1, frameEnd: 60, activeCamera: 'camera-main' },
    entities: [{ id: 'body', type: 'generator', generator: { shape: 'rounded_box' }, transform: { location: [0, 0, 1], rotationEuler: [0, 0, 0], scale: [1, 1, 1] } }],
    materials: [], lights: [], cameras: [{ id: 'camera-main' }], shots: [], animationTracks: [],
  }
  return {
    calls,
    config: { requireApprovalAboveFrames: 900 },
    methodsCalled: () => calls.map(call => call.name),
    async describeCapabilities() {
      record('describeCapabilities')
      return { installed: true, version: '5.2.1 LTS', engines: { CYCLES: { available: true } }, gpu: {}, formats: {}, warnings: [], executable: {}, probedAt: 'now' }
    },
    async listProjects() {
      record('listProjects')
      return { projects: [{ projectId: 'demo', title: 'Demo', currentRevision: 'r0002', revisionCount: 2, createdAt: null, updatedAt: null, goal: null, jobs: [{ jobId: 'render-0001', type: 'final-render', status: 'running', revisionId: 'r0002' }], scene: null }], count: 1, projectsRoot: '/tmp/projects' }
    },
    async getProject() {
      record('getProject')
      return { projectId: 'demo', title: 'Demo', currentRevision: 'r0002', revisionCount: 2, revisions: [{ revision: 'r0002', isCurrent: true, digest: 'd2', previews: [], validation: null }] }
    },
    async getScene(_projectId, options) {
      record('getScene')
      // The digest path is what the Host returns when `full` is not asked for;
      // returning `spec` unconditionally here would hide the defect that made the
      // Scene Tree render empty, so the stub mirrors the real contract.
      return options?.full === true
        ? { revision: 'r0002', digest: 'd2', spec, compiledSpec: {} }
        : { revision: 'r0002', digest: 'd2' }
    },
    async getRevisionDetail() {
      record('getRevisionDetail')
      return { projectId: 'demo', revision: 'r0002', isCurrent: true, manifest, scene: {}, validation: null, operations: null, request: null, checkpoint: null, previews: [], contactSheets: [], reviews: [] }
    },
    async readRevisionPair() {
      record('readRevisionPair')
      return { projectId: 'demo', fromRevision: 'r0001', toRevision: 'r0002', from: spec, to: spec }
    },
    async getQaRecord() {
      record('getQaRecord')
      return { projectId: 'demo', revision: 'r0002', validation: null, review: null, reviewViews: [], reviewArtifact: null, reviewCount: 0 }
    },
    async listPreviewSets() {
      record('listPreviewSets')
      return { projectId: 'demo', currentRevision: 'r0002', revisions: [{ revision: 'r0002', isCurrent: true, previews: [], contactSheets: [], reviews: [] }] }
    },
    async readArtifact({ path }) {
      record('readArtifact', { path })
      // The REAL error class: the handler branches on `instanceof BlenderError`,
      // so a lookalike would test the wrapper's fallback path by accident.
      if (String(path).startsWith('/')) throw new BlenderError(BlenderErrorCode.PATH_OUTSIDE_WORKSPACE, 'absolute path')
      if (String(path).includes('..')) throw new BlenderError(BlenderErrorCode.PATH_OUTSIDE_WORKSPACE, 'outside the project')
      if (path !== 'revisions/r0002/contact-sheets/round-0.png') {
        throw new BlenderError(BlenderErrorCode.ARTIFACT_NOT_FOUND, `no artifact at ${path}`)
      }
      return { path, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', size: 4 }
    },
    async listJobs() {
      record('listJobs')
      return {
        projectId: 'demo',
        jobs: [{ jobId: 'render-0001', projectId: 'demo', type: 'final-render', status: 'running', expectedFrames: 60, completedFrames: 30, missingFrames: [31], corruptFrames: [], frameStart: 1, frameEnd: 60, delivery: null, warnings: [] }],
        unfinished: ['render-0001'],
        recovery: [],
      }
    },
    async getJob() {
      record('getJob')
      return { jobId: 'render-0001', renderJob: { jobId: 'render-0001', projectId: 'demo', status: 'running', expectedFrames: 60, completedFrames: 30, missingFrames: [], corruptFrames: [], frameStart: 1, frameEnd: 60, delivery: null, warnings: [] } }
    },
    async createProject(request) {
      record('createProject', request)
      return { projectId: 'demo', title: request.title, revision: { revision: 'r0001' } }
    },
    async renderViews(request) {
      record('renderViews', request)
      return { revision: request.revision ?? 'r0002', digest: 'd2', profile: { engine: 'cycles' }, artifacts: [], views: [], warnings: [], durationMs: 1, pngs: {} }
    },
    async applyScenePatch(request) {
      record('applyScenePatch', request)
      return { revision: 'r0003', digest: 'd3' }
    },
    async restoreRevision(request) {
      record('restoreRevision', request)
      return { revision: 'r0004', digest: 'd4' }
    },
    async cancelJob(request) {
      record('cancelJob', request)
      return { jobId: request.jobId, status: 'cancelled', processGone: true }
    },
    async startFinalRender(request) {
      record('startFinalRender', request)
      return { jobId: 'render-0002', frames: Number(request.frameEnd ?? 3) - Number(request.frameStart ?? 1) + 1 }
    },
    async resumeRenderJob(request) {
      record('resumeRenderJob', request)
      return { jobId: request.jobId, resumed: true }
    },
  }
}

/** A `webServer` that captures the one route the UI registers. */
function createWebServerStub() {
  const registered = []
  return {
    registered,
    register(entry) {
      registered.push(entry)
      return () => {
        const index = registered.indexOf(entry)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
}

/** A Node-shaped request the handler can read the method, url and body from. */
function makeRequest({ method = 'GET', url, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A Node-shaped response that records what was sent. */
function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body === undefined ? null : body
    },
  }
}

// ---------------------------------------------------------------------------
// Part 1 — the Host half
// ---------------------------------------------------------------------------

const root = new Context()
const studio = createStudioStub()
const webServer = createWebServerStub()
root.provide('blenderStudio', studio)
root.provide('webServer', webServer)

const uiModule = await import('@deepblend/dsh-blender-ui')
const { BLENDER_UI_SERVICE, CAPABILITIES_ROUTE } = uiModule
const ui = new uiModule.default(root, { serveRoute: true })
await new Promise(settle => setTimeout(settle, 50))

check('the UI service registers under its declared key',
  root.get(BLENDER_UI_SERVICE) !== undefined || ui.ctx !== undefined,
  { registered: root.get(BLENDER_UI_SERVICE) !== undefined, key: BLENDER_UI_SERVICE })
check('exactly one route is registered, at the DeepBlend prefix',
  webServer.registered.length === 1
  && webServer.registered[0].kind === 'prefix'
  && webServer.registered[0].path === UI_ROUTE_PREFIX,
  webServer.registered.map(entry => `${entry.kind}:${entry.path}`))
check('the M0 capabilities path is still the settings-card route', CAPABILITIES_ROUTE === '/deepblend/capabilities')

/** Drive one request through the registered handler. */
async function request(method, url, body) {
  const response = makeResponse()
  await webServer.registered[0].handler(makeRequest({ method, url, body }), response)
  let parsed = null
  try {
    parsed = response.body === null ? null : JSON.parse(response.body)
  } catch {
    parsed = null
  }
  return { response, json: parsed }
}

// --- the handler table is exactly the route table ---------------------------

const routeIds = UI_ROUTES.map(route => route.id).sort()
// The artifact route is served by the byte path in `_handle`, not by a JSON
// handler, so the handler table is the table minus exactly that one.
const expectedHandlerIds = routeIds.filter(id => id !== 'artifacts.open')
const handlerIds = Object.keys(ui.handlers).sort()
check('the handler table is exactly the route table, minus the byte route',
  JSON.stringify(handlerIds) === JSON.stringify(expectedHandlerIds),
  { handlers: handlerIds, routes: routeIds })

// --- every GET route answers from the facade, with a body the client can place

/** A request for a declared route, built from the route's own path. */
function sampleUrl(route) {
  return route.path
    .replace(':projectId', 'demo')
    .replace(':revision', 'r0002')
    .replace(':jobId', 'render-0001')
    .replace(/\/\*$/, '/revisions/r0002/contact-sheets/round-0.png')
}

for (const route of UI_ROUTES) {
  studio.calls.length = 0
  const { response, json } = await request(route.method, sampleUrl(route), route.method === 'POST' ? { title: 'Demo', patch: {}, revision: 'r0001', frameStart: 1, frameEnd: 3, jobId: 'render-0001' } : undefined)

  if (route.id === 'artifacts.open') {
    check(`${route.id} serves bytes, not JSON`,
      response.statusCode === 200 && response.headers['content-type'] === 'image/png' && response.headers['cache-control'] === 'no-store',
      { status: response.statusCode, type: response.headers['content-type'] })
    continue
  }

  check(`${route.id} answers 200 with ok:true`, response.statusCode === 200 && json?.ok === true, { status: response.statusCode, code: json?.error?.code })
  check(`${route.id} reports the route that served it, so a stale Host is detectable`, json?.route === route.id, json?.route)
  check(`${route.id} reports the host API version`, json?.hostApiVersion === 4, json?.hostApiVersion)
  check(`${route.id} answers with lossless JSON`, isJsonValue(json), route.id)

  const called = studio.methodsCalled()
  if (route.write === true) {
    check(`${route.id} is a write, and calls exactly ${WRITE_METHOD[route.id]} once`,
      called.length === 1 && called[0] === WRITE_METHOD[route.id], called)
  } else {
    check(`${route.id} reads through the facade only`, called.every(name => READ_METHODS.has(name)), called)
    check(`${route.id} performs no write`, called.every(name => !ALLOWED_WRITES.has(name)), called)
  }
}

// --- the M0 payload shape is unchanged -------------------------------------

{
  studio.calls.length = 0
  const { json } = await request('GET', CAPABILITIES_ROUTE)
  check('the capabilities route still answers with { ok, card, data }',
    json.ok === true && json.card !== null && json.data !== null && json.card.title === 'Blender', Object.keys(json))
  check('the card is built by the one builder the contracts package owns',
    uiModule.buildSettingsCard === buildSettingsCard)
}

// --- failures are structured, and they name the right problem ---------------

{
  const { response, json } = await request('GET', '/deepblend/no-such-route')
  check('an unknown route is a 404 that lists the surface',
    response.statusCode === 404 && json.error.code === 'UI_ROUTE_NOT_FOUND' && Array.isArray(json.error.detail?.routes),
    { status: response.statusCode, body: json.error })
}
{
  const { response, json } = await request('POST', '/deepblend/projects', '{not json')
  check('a malformed body is a 400 with a patch-schema code, not a crash',
    response.statusCode === 400 && json.error.code === 'SCENE_PATCH_INVALID', json.error.code)
}
{
  // A missing project must read as "not there" rather than "the Host broke".
  const failing = new Context()
  const brokenStudio = createStudioStub()
  brokenStudio.getQaRecord = async () => {
    throw new BlenderError(BlenderErrorCode.PROJECT_NOT_FOUND, 'no such project')
  }
  const server = createWebServerStub()
  failing.provide('blenderStudio', brokenStudio)
  failing.provide('webServer', server)
  new (await import('@deepblend/dsh-blender-ui')).default(failing, { serveRoute: true })
  await new Promise(settle => setTimeout(settle, 20))
  const response = makeResponse()
  await server.registered[0].handler(makeRequest({ method: 'GET', url: '/deepblend/projects/nope/qa' }), response)
  const json = JSON.parse(response.body)
  check('a missing project is a 404 with its own code', response.statusCode === 404 && json.error.code === 'PROJECT_NOT_FOUND', json.error.code)
}
{
  // The one URL parameter that reaches the filesystem, in the three shapes an
  // attacker would try. Two of them never reach the facade at all, and saying so
  // is the point: `..` segments are normalized away by the URL parser, so the
  // request is answered "there is no such route" rather than being handed to a
  // path resolver that has to be right. The encoded form DOES reach it, and the
  // facade's own guard (`resolveInside`, SPEC §15.2) is what refuses it.
  const plain = await request('GET', '/deepblend/artifacts/demo/../../../etc/passwd')
  check('a plain ../ escape is normalized away before any handler sees it',
    plain.response.statusCode === 404 && plain.json.error.code === 'UI_ROUTE_NOT_FOUND',
    { status: plain.response.statusCode, code: plain.json.error.code })
  const encoded = await request('GET', '/deepblend/artifacts/demo/%2e%2e%2f%2e%2e%2fetc%2fpasswd')
  check('an encoded ../ escape reaches the facade and is refused by the path guard',
    encoded.response.statusCode === 400 && encoded.json.error.code === 'PATH_OUTSIDE_WORKSPACE',
    { status: encoded.response.statusCode, code: encoded.json.error.code })
  const absolute = await request('GET', '/deepblend/artifacts/demo//etc/passwd')
  const pathSeen = studio.calls.filter(call => call.name === 'readArtifact').pop()?.args?.path
  check('a URL cannot smuggle an absolute artifact path into the facade',
    absolute.response.statusCode === 404 && typeof pathSeen === 'string' && !pathSeen.startsWith('/'),
    { status: absolute.response.statusCode, pathSeen })
  const missing = await request('GET', '/deepblend/artifacts/demo/revisions/r0002/previews/nope.png')
  check('an artifact that does not exist is a 404 with its own code, not a blank page',
    missing.response.statusCode === 404 && missing.json?.error?.code === 'ARTIFACT_NOT_FOUND',
    { status: missing.response.statusCode, code: missing.json?.error?.code })
}
{
  studio.calls.length = 0
  const { json } = await request('POST', '/deepblend/projects/demo/render', { resumeJobId: 'render-0001' })
  check('a resume is routed to the resume entry point, not to a fresh start',
    studio.methodsCalled().includes('resumeRenderJob') && !studio.methodsCalled().includes('startFinalRender'),
    studio.methodsCalled())
  check('the resume answers with the job it continued',
    json.ok === true && json.job.jobId === 'render-0001',
    { ok: json.ok, job: json.job, code: json.error?.code })
  check('the resume hands the host the job id it actually reads',
    studio.calls.some(call => call.name === 'resumeRenderJob' && call.args?.jobId === 'render-0001'),
    studio.calls.map(call => `${call.name}(${JSON.stringify(call.args ?? {})})`))
}

// --- the module cannot execute anything -------------------------------------

{
  const source = readFileSync(join(UI_PACKAGE, 'lib', 'index.js'), 'utf8')
  const forbidden = ['node:child_process', 'node:fs', 'child_process', "from 'node:fs'", 'spawn(', 'execFile', 'eval(', 'new Function']
  const found = forbidden.filter(token => source.includes(token))
  check('the UI host imports no filesystem and no process module, so the browser cannot start Blender',
    found.length === 0, found)
  check('the UI host is a Host-plane module (it may import cordis, schemastery and the contracts)',
    /from '@deepseek-ai\/cordis'/.test(source) && /from '@deepblend\/dsh-blender-contracts'/.test(source))
}

// ---------------------------------------------------------------------------
// Part 2 — the client bundle, loaded the way the browser loads it
// ---------------------------------------------------------------------------

/**
 * Load `lib/client.js` through its real entry point.
 *
 * The bundle is a script that calls `window.__ModuleLoader__.load({ id, factory })`
 * and nothing else — the same shape `dsh-client-modules` executes in the page. A
 * fake loader and a fake React are enough to run `apply` and read back the seat
 * table, which is the part of the client half a Node test can honestly check. The
 * rendering is checked in a real browser instead (`e2e/ui.e2e.mjs`).
 */
function loadClientBundle() {
  const source = readFileSync(join(UI_PACKAGE, 'lib', 'client.js'), 'utf8')
  check('the client bundle has no top-level ESM syntax',
    !/^\s*import\s/m.test(source) && !/^\s*export\s/m.test(source))
  check('the client bundle registers itself through the module loader',
    source.includes('window.__ModuleLoader__.load(') && source.includes("id: '@deepblend/dsh-blender-ui'"))

  let captured = null
  const window = { __ModuleLoader__: { load: entry => { captured = entry } } }
  runInNewContext(source, { window, document: undefined, JSON, Object, Array, String, Number, Boolean, Math, Error, Set, Map, Promise, console })
  check('loading the bundle registers exactly one module', captured !== null && typeof captured.factory === 'function')
  check('the module id is the package name, which is what the graph dispatches on',
    captured.id === '@deepblend/dsh-blender-ui', captured.id)

  /** A React stand-in: the components are never invoked here, only handed over. */
  const reactStub = {
    createElement: () => null,
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const exports = captured.factory(specifier => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub
    throw new Error(`the client bundle required an unexpected module: ${specifier}`)
  })
  return exports
}

const clientExports = loadClientBundle()
check('the client half exports apply and inject (CJS shape, not export default)',
  typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject), Object.keys(clientExports))
check('the client half declares the Slot registry as its one hard dependency',
  clientExports.inject.includes('slots') && clientExports.inject.length === 1, clientExports.inject)

/** Run `apply` against a recording Slot registry. */
function applyClient() {
  const registrations = []
  const injected = []
  const effects = []
  const context = {
    effect(callback, label) {
      effects.push(label ?? 'effect')
      return callback()
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  clientExports.apply(context)
  return { registrations, injected, effects }
}

const client = applyClient()
const seats = client.registrations.map(entry => entry.options)
const seat = (name, key) => seats.find(entry => entry.name === name && (key === undefined || (key === 'key' ? entry.key !== undefined : entry[key] !== undefined)))

check('the client touches exactly five slots — every one of them additive',
  JSON.stringify([...new Set(seats.map(entry => entry.name))].sort()) === JSON.stringify([
    'conversation.session.header.utilities', 'main', 'settings.section', 'sidebar.panellist', 'tool.call.toolview',
  ]),
  [...new Set(seats.map(entry => entry.name))])
check('the registrations are one per seat plus one per tool card',
  client.registrations.length === 4 + UI_TOOL_CARD_KEYS.length, client.registrations.length)
check('the sidebar entry uses the panel id as its cell key and carries a label',
  client.injected.includes('sidebar.panellist')
  && seats.some(entry => entry.name === 'sidebar.panellist' && entry.id === UI_PANEL_ID && typeof entry.label === 'function'),
  seats.filter(entry => entry.name === 'sidebar.panellist'))
check('the main panel is registered under the same id the sidebar dispatches',
  seats.some(entry => entry.name === 'main' && entry.key === UI_PANEL_ID), seats.filter(entry => entry.name === 'main'))
check('the settings page and the session chip are additive seats with the same id',
  seats.some(entry => entry.name === 'settings.section' && entry.id === UI_PANEL_ID)
  && seats.some(entry => entry.name === 'conversation.session.header.utilities' && entry.id === UI_PANEL_ID))
check('the shipped conversation panel is never replaced (main is keyed, and only our key is taken)',
  seats.filter(entry => entry.name === 'main').length === 1)
check('the styles are installed as a reversible effect', client.effects.length === 1 && /style/i.test(client.effects[0]), client.effects)

const cardKeys = seats.filter(entry => entry.name === 'tool.call.toolview').map(entry => entry.key)
check('a card is registered for every DeepBlend tool name, and for nothing else',
  JSON.stringify([...cardKeys].sort()) === JSON.stringify([...UI_TOOL_CARD_KEYS].sort()),
  { registered: cardKeys.length, expected: UI_TOOL_CARD_KEYS.length })
check('every card registration has a component, so keying it cannot silently render nothing',
  seats.filter(entry => entry.name === 'tool.call.toolview').every(entry => typeof client.registrations.find(r => r.options === entry).component === 'function'))

// --- the card keys must cover the tools the preset really registers ---------

{
  const toolRoot = new Context()
  const registered = new Map()
  toolRoot.plugin({
    name: 'ui-plane-tool-harness',
    apply(ctx) {
      ctx.provide('blenderStudio', {
        config: {},
        async describeCapabilities() { return {} },
        async listProjects() { return { projects: [] } },
      })
      ctx.provide('tools', {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
        get: name => registered.get(name),
        schemas: () => [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
      })
      ctx.provide('attachments', { async saveImage() { return { attachmentId: 'x' } } })
    },
  })
  toolRoot.plugin(await import('@deepblend/dsh-blender-tool'))
  await new Promise(settle => setTimeout(settle, 300))

  const wireNames = toolRoot.get('tools').schemas().map(entry => entry.name)
  const missing = wireNames.filter(name => !cardKeys.includes(name))
  check('every tool the preset registers has a card in the UI', wireNames.length > 0 && missing.length === 0, { tools: wireNames.length, missing })
  const orphan = cardKeys.filter(key => !wireNames.includes(key))
  check('the UI draws no card for a tool that does not exist', orphan.length === 0, orphan)
}

// ---------------------------------------------------------------------------

const failed = results.filter(entry => !entry.ok)
console.log(`\nui plane: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
