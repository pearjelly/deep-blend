/** Browser-independent state/route/tool contracts; actual browser/native tests are separate. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RecipeCatalog } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { buildSceneTree, planLampAssemblyPlacement, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { createHandlers } from '@deepblend/dsh-blender-ui'
import { loadClientBundle } from '../lib/client-bundle.mjs'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'
const clone = value => JSON.parse(JSON.stringify(value)), core = loadClientBundle().exports.workbench
const catalog = new RecipeCatalog(), recipe = catalog.list().recipes.find(item => item.id === 'deepblend.metal-lamp')
const { sceneSpec, lock } = catalog.instantiate({ id: recipe.id, version: recipe.version, digest: recipe.digest })
const plan = planLampAssemblyPlacement(lock, sceneSpec, undefined)
async function settle(store, predicate) {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(Error('Placement fixture did not settle')) }, 2500)
    const stop = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); stop(); resolve() } })
  })
}
const nodesOf = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []
async function client(t, options = {}) {
  const projects = { one: { revision: 'r0001' }, two: { revision: 'r0001' } }, calls = [], ledger = new Map()
  let commits = 0, projectsRoot = '/placement-fixture'
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost'), id = parsed.pathname.match(/projects\/([^/]+)/)?.[1] || parsed.searchParams.get('projectId') || 'one'
    const project = projects[id]; let payload
    if (init.method === 'POST') {
      const body = JSON.parse(init.body), call = { id, path: parsed.pathname, body, signal: init.signal }; calls.push(call)
      await options.beforePost?.(call)
      if (options.postError) payload = { ok: false, error: { code: options.postError, message: 'Explicit fixture refusal' } }
      else {
        let result = ledger.get(body.idempotencyKey)
        if (!result) {
          commits++; project.revision = 'r0002'
          result = { revision: project.revision, digest: 'b'.repeat(64), surfacePlacementReceipt: {
            schemaVersion: 'deepblend.assembly-placement-receipt/v1', sourceRevision: body.baseRevision,
            subjectEntityId: body.subjectEntityId, memberEntityIds: plan.memberEntityIds, supportEntityId: body.supportEntityId,
            frame: body.frame, clearanceMm: body.clearanceMm, pose: body.pose } }
          ledger.set(body.idempotencyKey, clone(result))
        }
        if (options.dropFirstReply && calls.length === 1) throw Error('Response lost after the explicit fixture committed')
        payload = { ok: true, revision: clone(result) }; options.alterReply?.(payload, calls.length)
      }
    } else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', artifactBase: `/deepblend/artifacts/${id}/`,
      previews: { projectId: id, revisions: [{ revision: project.revision, previews: [], contactSheets: [] }] } }
    else {
      const tree = buildSceneTree(sceneSpec, { revision: project.revision, digest: 'a'.repeat(64) })
      payload = { ok: true, route: 'state', projectsRoot, assemblyPlacementSupported: options.supported !== false,
        projects: [{ projectId: 'one' }, { projectId: 'two' }], selected: {
          project: { projectId: id, title: id }, currentRevision: project.revision, scene: tree, jobs: [], unfinishedJobs: [], qa: {},
          recipeParameters: { projectId: id, revision: project.revision, available: true, conflicts: [],
            parameters: [{ id: 'shade-diameter-mm', title: 'Shade diameter', minimum: 180, maximum: 250, value: 209.8 }],
            placement: options.broken ? { available: false, conflicts: [{ entityId: 'fabric-power-cable' }] }
              : { available: true, subjectEntityId: plan.subjectEntityId, memberEntityIds: plan.memberEntityIds, memberCount: 23, defaultPose: plan.pose } } } }
    }
    payload.hostApiVersion = HOST_API_VERSION
    return { ok: payload.ok, status: payload.ok ? 200 : 409, json: async () => clone(payload), text: async () => JSON.stringify(payload) }
  }
  const store = core.createWorkbenchStore({ fetch, pollIdleMs: 100000 }); t.after(() => store.stop()); store.start()
  await settle(store, state => state.status === 'ok'); store.actions.setView('scene')
  const nodes = () => nodesOf(core.buildWorkbenchView(store.getState(), store.actions))
  const field = id => nodes().find(node => node.props['data-field'] === `placement-${id}`)
  const action = id => nodes().find(node => node.props['data-action'] === `placement-${id}`)
  const draft = () => store.getState().placementDrafts[JSON.stringify([store.getState().projectsRoot, store.getState().activeProjectId])]
  return { store, projects, calls, field, action, nodes, draft, commits: () => commits, setRoot: value => { projectsRoot = value } }
}
function choose(f) { f.store.actions.setPlacementSupport('studio-floor'); f.store.actions.setPlacementValue('x', '200'); f.store.actions.setPlacementValue('yaw', '35') }

test('the complete placement form selects only external supports and submits one semantic request after explicit save', async t => {
  const f = await client(t)
  assert.ok(f.field('support')); assert.equal(f.action('save').props.disabled, true)
  assert.deepEqual(f.draft().supports.map(entity => entity.id), ['studio-floor'])
  choose(f); assert.equal(f.calls.length, 0)
  f.store.actions.setPlacementValue('yaw', '361'); assert.equal(f.action('save').props.disabled, true)
  assert.equal(f.field('yaw').props['aria-invalid'], 'true'); await f.store.actions.savePlacement(); assert.equal(f.calls.length, 0)
  f.store.actions.setPlacementValue('yaw', '35'); assert.equal(f.action('save').props.disabled, false)
  await f.store.actions.savePlacement(); await settle(f.store, state => state.currentRevision === 'r0002' && !f.draft()?.attempt)
  assert.equal(f.calls.length, 1); const body = f.calls[0].body
  assert.equal(body.scope, 'recipe-assembly'); assert.equal(body.subjectEntityId, 'weighted-base'); assert.equal(body.baseRevision, 'r0001')
  assert.deepEqual(body.pose.translationMm, [200, 0, 0]); assert.equal(body.pose.yawDegrees, 35)
  assert.equal(Object.hasOwn(body, 'operations'), false); assert.equal(Object.hasOwn(body, 'memberEntityIds'), false)
  assert.equal(f.store.getState().view, 'preview'); assert.equal(f.draft().values.x, 0)
  const notice = () => f.nodes().find(node => node.props['data-result-kind'] === 'assembly-placement')
  assert.ok(notice(), 'the immediate revision comparison destination must show placement completion')
  assert.equal(notice().props.role, 'status'); assert.equal(notice().props['aria-live'], 'polite')
  assert.match(JSON.stringify(notice().children), /23/); assert.match(JSON.stringify(notice().children), /r0002/)
  f.store.actions.setCompareMode('result'); assert.ok(notice(), 'latest-result mode must retain the same project-bound completion')
  f.store.actions.selectProject('two'); await settle(f.store, state => state.activeProjectId === 'two')
  assert.equal(notice(), undefined, 'a different project must not display the prior placement success')
})

test('a lost response retains the exact request/key and retries once without duplicating the actual fixture commit', async t => {
  const f = await client(t, { dropFirstReply: true }); choose(f)
  await f.store.actions.savePlacement(); await settle(f.store, state => state.currentRevision === 'r0002')
  assert.ok(f.draft().attempt); assert.equal(f.field('x').props.disabled, true); assert.equal(f.action('save').props.disabled, false)
  const captured = clone(f.draft().attempt); f.store.actions.setPlacementValue('x', '999'); assert.equal(f.draft().values.x, '200')
  await f.store.actions.savePlacement(); await settle(f.store, () => !f.draft()?.attempt)
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0].body, f.calls[1].body); assert.deepEqual(f.calls[1].body, captured)
  assert.equal(f.commits(), 1)
})

test('known refusal keeps the typed placement editable and records no successful revision', async t => {
  const f = await client(t, { postError: 'RECIPE_PARAMETER_CONFLICT' }); choose(f)
  await f.store.actions.savePlacement()
  assert.equal(f.draft().attempt, null); assert.equal(f.draft().values.x, '200'); assert.equal(f.field('x').props.disabled, false)
  assert.equal(f.store.getState().notices.scene.ok, false); assert.equal(f.projects.one.revision, 'r0001')
})

test('an externally advanced revision retains a stale draft and requires an explicit reset before another placement', async t => {
  const f = await client(t); choose(f); f.projects.one.revision = 'r0003'; await f.store.actions.reload()
  await settle(f.store, state => state.currentRevision === 'r0003')
  assert.equal(f.draft().baseRevision, 'r0001'); assert.equal(f.draft().values.x, '200'); assert.equal(f.action('save').props.disabled, true)
  await f.store.actions.savePlacement(); assert.equal(f.calls.length, 0)
  f.store.actions.resetPlacement(); assert.equal(f.draft().baseRevision, 'r0003'); assert.equal(f.draft().values.x, 0)
})

test('a pending result cannot replace the newly selected project or its scoped draft', async t => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const f = await client(t, { beforePost: () => gate }); choose(f)
  const save = f.store.actions.savePlacement(); await settle(f.store, state => state.busy.placement)
  f.store.actions.selectProject('two'); await settle(f.store, state => state.activeProjectId === 'two')
  release(); await save; await settle(f.store, state => !state.busy.placement && f.draft()?.projectId === 'two')
  assert.equal(f.calls[0].id, 'one'); assert.equal(f.store.getState().activeProjectId, 'two')
  assert.equal(f.store.getState().view, 'scene'); assert.equal(f.draft().projectId, 'two'); assert.equal(f.draft().values.x, 0)
  assert.notEqual(f.store.getState().notices.scene?.kind, 'assembly-placement')
})

test('changing the active project store while a placement is pending does not adopt the old-store result', async t => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const f = await client(t, { beforePost: () => gate }); choose(f); const save = f.store.actions.savePlacement()
  await settle(f.store, state => state.busy.placement); f.setRoot('/new-store'); await f.store.actions.reload()
  await settle(f.store, state => state.projectsRoot === '/new-store'); release(); await save
  assert.equal(f.calls[0].body.projectsRoot, '/placement-fixture'); assert.equal(f.store.getState().projectsRoot, '/new-store')
  assert.notEqual(f.store.getState().notices.scene?.kind, 'assembly-placement')
})

test('cancel aborts the captured request and preserves uncertainty until readback/retry', async t => {
  const f = await client(t, { beforePost: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('Cancelled fixture request')), { once: true })) })
  choose(f); const save = f.store.actions.savePlacement(); await settle(f.store, state => state.busy.placement)
  f.store.actions.cancelPlacement(); await save
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls.length, 1); assert.equal(f.store.getState().busy.placement, false)
  assert.ok(f.draft().attempt); assert.equal(f.projects.one.revision, 'r0001')
})

test('a mismatched success receipt remains unconfirmed rather than selecting the wrong result', async t => {
  const f = await client(t, { alterReply: payload => { payload.revision.surfacePlacementReceipt.memberEntityIds.pop() } }); choose(f)
  await f.store.actions.savePlacement()
  assert.ok(f.draft().attempt); assert.equal(f.store.getState().notices.scene.ok, false); assert.equal(f.store.getState().view, 'scene')
})

test('unsupported Hosts and incomplete lamps do not offer a mutating placement form', async t => {
  for (const options of [{ supported: false }, { broken: true }]) {
    const f = await client(t, options)
    assert.equal(f.field('support'), undefined); assert.equal(f.action('save'), undefined); assert.equal(f.calls.length, 0)
  }
})

test('the UI route preserves source/store identity, signal and bounded intent while the Host owns saving', async () => {
  const signal = new AbortController().signal; let input
  const handlers = createHandlers({ blenderStudio: { assemblyPlacementSupported: true, placeOnSurface: request => { input = request; return { revision: 'r0002' } } } })
  const body = { projectId: 'wrong-body-id', projectsRoot: '/store', baseRevision: 'r0001', scope: 'recipe-assembly', subjectEntityId: 'weighted-base',
    supportEntityId: 'table', frame: 24, pose: { translationMm: [10, 0, 0] }, idempotencyKey: 'one-placement' }
  const result = await handlers['project.surfacePlacement']({ params: { projectId: 'one' }, body, signal })
  assert.deepEqual(input, { ...body, projectId: 'one', renderPreview: true, signal }); assert.equal(result.revision.revision, 'r0002')
  const old = createHandlers({ blenderStudio: { surfacePlacementSupported: true } })
  await assert.rejects(old['project.surfacePlacement']({ params: { projectId: 'one' }, body }), { code: 'UI_HOST_API_STALE' })
})

test('the existing tool forwards one complete lamp intent and refuses a stale whole-assembly capability', async t => {
  const calls = [], studio = { surfacePlacementSupported: true, assemblyPlacementSupported: true,
    placeOnSurface: input => { calls.push(input); return { revision: 'r0002', digest: 'a'.repeat(64), previews: [] } } }
  const plane = await composeToolPlane({ studio, expectAtLeast: 19 }); t.after(() => plane.ctx.fiber.dispose())
  const tool = plane.registered.get('blender_place_on_surface'), args = { projectId: 'one', baseRevision: 'r0001', subjectEntityId: 'weighted-base', supportEntityId: 'table',
    frame: 24, scope: 'recipe-assembly', pose: { translationMm: [200, -100, 150], yawDegrees: 35, pivotMm: [80, -30, 0] }, renderPreview: false }
  assert.equal((await tool.execute(args, {})).ok, true); assert.equal(calls.length, 1); assert.deepEqual(calls[0].pose, args.pose)
  assert.match(tool.presentCall(args).title, /complete lamp/)
  studio.assemblyPlacementSupported = false
  assert.equal((await tool.execute(args, {})).data.errorCode, 'BLENDER_RUNTIME_UNAVAILABLE'); assert.equal(calls.length, 1)
})
