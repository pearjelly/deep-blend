import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { CREATION_REQUEST_VERSION, HOST_API_VERSION, PROJECT_RECORD_VERSION, sha256 } from '@deepblend/dsh-blender-contracts'
import { creationIdentity } from '../../../packages/deepblend/host/lib/creation-request.js'
import { RecipeCatalog, BUILTIN_RECIPES } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { createHandlers, statusForError } from '@deepblend/dsh-blender-ui'
import { loadClientBundle } from '../lib/client-bundle.mjs'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

// The browser has no module imports: its capability string must match the public protocol.
assert.equal(/const CREATION_REQUEST_PROTOCOL = '([^']+)'/.exec(readFileSync(new URL('../../../packages/deepblend/ui/lib/client.js', import.meta.url), 'utf8'))?.[1], CREATION_REQUEST_VERSION)

function host(t, existingRoot) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'deepblend-creation-'))
  const ctx = new Context(); ctx.provide('blenderRuntime', {})
  const studio = new BlenderStudio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  if (!existingRoot) t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, studio }
}
const input = { title: 'My lamp', goal: 'warm product photograph', creationKey: 'operator-intent-one', saveCheckpoint: false }
function files(directory) {
  const result = {}
  const walk = (path, prefix = '') => { for (const item of readdirSync(path, { withFileTypes: true })) {
    const relative = prefix + item.name, full = join(path, item.name)
    if (item.isDirectory()) walk(full, relative + '/'); else result[relative] = sha256(readFileSync(full))
  } }
  walk(directory); return result
}

test('the same creation key recovers the project across Host instances without any project write', async t => {
  const { root, studio } = host(t), first = await studio.createProject(input)
  const before = files(studio.store.projectDirectory(first.projectId))
  const second = host(t, root).studio
  second.transactions.createProject = () => { throw Error('must not create twice') }
  const replay = await second.createProject({ ...input })
  assert.equal(replay.projectId, first.projectId); assert.equal(replay.creationReplayed, true)
  assert.equal(replay.revision.revision, 'r0001'); assert.equal(replay.job.jobId, first.job.jobId)
  assert.deepEqual(second.store.listProjectIds(), [first.projectId])
  assert.deepEqual(files(second.store.projectDirectory(first.projectId)), before)
})

test('only hashed creation identity is stored, and an unkeyed caller cannot forge it', async t => {
  const { studio } = host(t), first = await studio.createProject(input)
  const record = studio.store.readRecord(first.projectId)
  assert.equal(record.creationRequest.schemaVersion, CREATION_REQUEST_VERSION)
  assert.equal(record.creationRequest.keyHash, sha256(input.creationKey))
  assert.match(record.creationRequest.requestHash, /^[a-f0-9]{64}$/)
  const all = Object.keys(files(studio.store.projectDirectory(first.projectId))).filter(p => p.endsWith('.json'))
    .map(p => readFileSync(join(studio.store.projectDirectory(first.projectId), p), 'utf8')).join('\n')
  assert.equal(all.includes(input.creationKey), false)
  const other = await studio.createProject({ title: 'Other', saveCheckpoint: false, creationRequest: record.creationRequest })
  assert.equal(studio.store.readRecord(other.projectId).creationRequest, undefined)
})

test('new keys and unkeyed requests still allow deliberately separate projects with the same title', async t => {
  const { studio } = host(t)
  const a = await studio.createProject(input), b = await studio.createProject({ ...input, creationKey: 'another-intent' })
  const c = await studio.createProject({ title: input.title, saveCheckpoint: false })
  const d = await studio.createProject({ title: input.title, saveCheckpoint: false })
  assert.deepEqual([a.projectId, b.projectId, c.projectId, d.projectId], ['my-lamp', 'my-lamp-2', 'my-lamp-3', 'my-lamp-4'])
})

test('reusing a key with changed creation inputs is refused before any write or runtime call', async t => {
  const { studio } = host(t), first = await studio.createProject(input), before = files(studio.store.projectDirectory(first.projectId))
  studio.transactions.createProject = () => { throw Error('must not write') }
  for (const change of [{ title: 'Different' }, { goal: 'other goal' }, { projectId: 'explicit' }, { renderPreview: true }, { saveCheckpoint: true }, { actor: 'other' }]) {
    await assert.rejects(studio.createProject({ ...input, ...change }), { code: 'CREATION_REQUEST_CONFLICT' })
  }
  assert.deepEqual(files(studio.store.projectDirectory(first.projectId)), before)
})

test('recipe key order and omitted defaults do not change the intent, but different parameters do', async t => {
  const { studio } = host(t), recipe = studio.listRecipes().recipes.find(r => r.id === 'deepblend.metal-lamp')
  const body = { ...input, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, parameters: { exposure: .3, 'spun-roughness': .3 } } }
  const first = await studio.createProject(body)
  const replay = await studio.createProject({ ...body, actor: null, renderPreview: false,
    recipe: { parameters: { 'spun-roughness': .3, exposure: .3 }, digest: recipe.digest, version: recipe.version, id: recipe.id } })
  assert.equal(replay.projectId, first.projectId)
  await assert.rejects(studio.createProject({ ...body, recipe: { ...body.recipe, parameters: { exposure: .7, 'spun-roughness': .3 } } }), { code: 'CREATION_REQUEST_CONFLICT' })
})

test('a saved creation remains recoverable when its recipe is no longer available', async t => {
  const { root, studio } = host(t), recipes = join(root, 'recipes')
  cpSync(join(BUILTIN_RECIPES, 'metal-lamp'), join(recipes, 'lamp'), { recursive: true })
  studio.recipes = new RecipeCatalog({ builtinRoot: recipes })
  const recipe = studio.listRecipes().recipes[0], body = { ...input, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest } }
  const first = await studio.createProject(body), before = files(studio.store.projectDirectory(first.projectId))
  rmSync(join(recipes, 'lamp'), { recursive: true })
  assert.throws(() => studio.recipes.instantiate(body.recipe), { code: 'RECIPE_NOT_FOUND' })
  assert.equal((await studio.createProject(body)).projectId, first.projectId)
  assert.deepEqual(files(studio.store.projectDirectory(first.projectId)), before)
})

test('plain JSON from another JavaScript realm has the same creation identity', async t => {
  const { studio } = host(t), recipe = studio.listRecipes().recipes[0]
  const selection = { id: recipe.id, version: recipe.version, digest: recipe.digest }
  const external = runInNewContext('(' + JSON.stringify(selection) + ')')
  const first = await studio.createProject({ ...input, recipe: external })
  assert.equal((await studio.createProject({ ...input, recipe: selection })).projectId, first.projectId)
})

test('recovery returns the current saved revision without rolling back a later edit', async t => {
  const { studio } = host(t), first = await studio.createProject(input)
  await studio.applyScenePatch({ projectId: first.projectId, baseRevision: 'r0001', saveCheckpoint: false,
    operations: [{ op: 'world.set', world: { color: [.1, .2, .3], strength: .5 } }] })
  const before = files(studio.store.projectDirectory(first.projectId)), replay = await studio.createProject(input)
  assert.equal(replay.currentRevision, 'r0002'); assert.equal(replay.revision.revision, 'r0002')
  assert.deepEqual(files(studio.store.projectDirectory(first.projectId)), before)
})

test('invalid keys and non-JSON creation inputs are refused without creating a project', async t => {
  const { studio } = host(t)
  for (const creationKey of ['', ' ', 3, null, 'x'.repeat(129), 'a\nb', 'a\x00b']) {
    await assert.rejects(studio.createProject({ ...input, creationKey }), { code: 'CREATION_REQUEST_INVALID' })
  }
  for (const goal of [NaN, Infinity, new Date(), () => 'goal']) {
    await assert.rejects(studio.createProject({ ...input, goal }), { code: 'CREATION_REQUEST_INVALID' })
  }
  assert.deepEqual(studio.store.listProjectIds(), [])
})

test('an overlapping same-key call is refused; completing and retrying creates only one project', async t => {
  const { studio } = host(t); let release, entered
  const gate = new Promise(resolve => { release = resolve }), began = new Promise(resolve => { entered = resolve })
  const original = studio._createProject.bind(studio)
  studio._createProject = async (...args) => { entered(); await gate; return original(...args) }
  const first = studio.createProject(input); await began
  const second = studio.createProject(input)
  release(); const [a, b] = await Promise.allSettled([first, second])
  assert.equal(a.status, 'fulfilled'); assert.equal(b.status, 'rejected'); assert.equal(b.reason.code, 'REVISION_CONFLICT')
  const result = a.value, replay = await studio.createProject(input)
  assert.equal(replay.projectId, result.projectId); assert.equal(studio.store.listProjectIds().length, 1)
})

test('a failed uncommitted attempt releases its key for an explicit retry', async t => {
  const { studio } = host(t), original = studio._createProject.bind(studio); let calls = 0
  studio._createProject = (...args) => ++calls === 1 ? Promise.reject(Error('before creation')) : original(...args)
  await assert.rejects(studio.createProject(input), /before creation/)
  const first = await studio.createProject(input), replay = await studio.createProject(input)
  assert.equal(replay.projectId, first.projectId); assert.equal(calls, 2)
})

test('independent processes with different workspace roots still coordinate the same store and key', async t => {
  const { root, studio } = host(t); let release, entered
  const gate = new Promise(resolve => { release = resolve }), began = new Promise(resolve => { entered = resolve })
  const original = studio._createProject.bind(studio)
  studio._createProject = async (...args) => { entered(); await gate; return original(...args) }
  const first = studio.createProject(input); await began
  const script = `import {Context} from '@deepseek-ai/cordis';import Studio,{StudioConfig} from '@deepblend/dsh-blender-host';
    const ctx=new Context();ctx.provide('blenderRuntime',{});const root=process.argv[1];
    const studio=new Studio(ctx,StudioConfig({workspaceRoot:root,projectsRoot:root,reconcileOnStart:false}));
    try{const r=await studio.createProject(${JSON.stringify(input)});console.log(JSON.stringify({ok:true,id:r.projectId}));}
    catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}`
  let other
  try { other = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, join(root, 'projects')], { encoding: 'utf8', timeout: 20000 }).trim()) }
  finally { release() }
  await first
  assert.deepEqual(other, { ok: false, code: 'REVISION_CONFLICT' })
  assert.equal(studio.store.listProjectIds().length, 1)
})

test('keyed creation refuses reserved metadata directory names before writes', async t => {
  const { studio } = host(t)
  for (const projectId of ['staging', '.revision-writers', '.creation-requests']) {
    await assert.rejects(studio.createProject({ ...input, projectId }), { code: 'PROJECT_ID_INVALID' })
  }
  assert.deepEqual(studio.store.listProjectIds(), [])
  const body = { ...input, title: 'Staging', creationKey: 'reserved-looking-title' }
  const first = await studio.createProject(body), before = files(studio.store.projectDirectory(first.projectId))
  assert.equal(first.projectId, 'staging-2')
  const replay = await studio.createProject(body)
  assert.equal(replay.creationReplayed, true); assert.equal(replay.projectId, first.projectId)
  assert.deepEqual(files(studio.store.projectDirectory(first.projectId)), before)
  assert.deepEqual(studio.store.listProjectIds(), ['staging-2'])
  const unkeyed = await studio.createProject({ title: ' staging ', saveCheckpoint: false })
  assert.equal(unkeyed.projectId, 'staging-3')
  assert.deepEqual(studio.store.listProjectIds(), ['staging-2', 'staging-3'])
})

test('incomplete and duplicated creation claims fail closed and remain visible for inspection', async t => {
  const { studio } = host(t), identity = creationIdentity(input)
  studio.store.createSkeleton('incomplete')
  const record = { schemaVersion: PROJECT_RECORD_VERSION, projectId: 'incomplete', title: 'Incomplete',
    currentRevision: 'r0000', revisionCount: 0, creationRequest: identity }
  studio.store.writeRecord('incomplete', record)
  const before = files(studio.store.projectDirectory('incomplete'))
  await assert.rejects(studio.createProject(input), { code: 'CREATION_REQUEST_CONFLICT' })
  const listed = await studio.listProjects(); assert.equal(listed.projects[0].creationPending, true)
  assert.equal(listed.projects[0].unreadable, false)
  const handlers = createHandlers({ blenderStudio: studio })
  assert.equal((await handlers.state({ query: {} })).selected, null)
  assert.equal((await handlers.state({ query: { projectId: 'incomplete' } })).selected, null)
  assert.deepEqual(files(studio.store.projectDirectory('incomplete')), before)
  studio.store.createSkeleton('duplicate'); studio.store.writeRecord('duplicate', { ...record, projectId: 'duplicate' })
  await assert.rejects(studio.createProject(input), { code: 'CREATION_REQUEST_CONFLICT' })
})

test('a pending first project does not prevent the state route from opening a completed project', async t => {
  const { studio } = host(t), first = await studio.createProject(input)
  studio.store.createSkeleton('pending'); studio.store.writeRecord('pending', { schemaVersion: PROJECT_RECORD_VERSION,
    projectId: 'pending', title: 'Pending', currentRevision: 'r0000', revisionCount: 0, updatedAt: '2999-01-01' })
  const result = await createHandlers({ blenderStudio: studio }).state({ query: {} })
  assert.equal(result.projects[0].projectId, 'pending'); assert.equal(result.projects[0].creationPending, true)
  assert.equal(result.selected.project.projectId, first.projectId)
})

test('the HTTP creation route refuses a keyed call on an older running Host', async () => {
  let calls = 0
  const handlers = createHandlers({ blenderStudio: { createProject() { calls++; throw Error('old Host must not write') } } })
  await assert.rejects(handlers['projects.create']({ body: input }), { code: 'UI_HOST_API_STALE' })
  assert.equal(calls, 0)
})

test('creation validation and state conflicts have distinct HTTP outcomes', () => {
  assert.equal(statusForError({ code: 'CREATION_REQUEST_INVALID' }), 400)
  assert.equal(statusForError({ code: 'CREATION_REQUEST_CONFLICT' }), 409)
  assert.equal(statusForError({ code: 'PROJECT_ID_INVALID' }), 400)
})

async function client(t, post, protocol = CREATION_REQUEST_VERSION, projects = []) {
  const core = loadClientBundle().exports.workbench, calls = [], reads = []
  const store = core.createWorkbenchStore({ fetch: async (url, init = {}) => {
    let payload
    if (init.method === 'POST') { const body = JSON.parse(init.body); calls.push(body); payload = await post(body, calls.length) }
    else { reads.push(url); const route = url.includes('/jobs') ? 'project.jobs' : url.includes('/previews') ? 'project.previews' : 'state';
      payload = { ok: true, route, hostApiVersion: HOST_API_VERSION, creationRequestProtocol: protocol,
        projects, selected: null, recipeCatalog: new RecipeCatalog().list(), jobs: [], unfinished: [], previews: { revisions: [] } } }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
  } })
  t.after(() => store.stop())
  const ready = new Promise(resolve => { const off = store.subscribe(s => { if (s.status === 'ok') { off(); resolve() } }) })
  store.start(); await ready; store.actions.setForm('title', 'Creation draft'); store.actions.setForm('goal', 'Keep my goal')
  const nodes = () => { const flatten = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(flatten)] : []
    return flatten(core.buildWorkbenchView(store.getState(), store.actions)) }
  return { store, calls, reads, nodes }
}
const failed = { ok: false, error: { code: 'BLENDER_NOT_FOUND', message: 'raw diagnostic' } }
const success = { ok: true, project: { projectId: 'saved', creationReplayed: true } }

test('an uncertain browser result retries the same captured intent and does not auto-submit', async t => {
  const h = await client(t, (_, n) => n === 1 ? Promise.reject(TypeError('connection lost')) : success)
  await h.store.actions.createProject(); assert.equal(h.calls.length, 1)
  assert.equal(h.store.getState().forms.title, 'Creation draft')
  assert.equal(h.store.getState().forms.goal, 'Keep my goal')
  assert.match(h.store.getState().notices.projects.message, /same request|同一次/)
  assert.ok(h.nodes().some(n => n.props['data-action'] === 'retry-creation'))
  h.store.actions.reload(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(h.calls.length, 1)
  await h.store.actions.retryCreation(); assert.deepEqual(h.calls[1], h.calls[0])
  assert.match(h.store.getState().notices.projects.message, /previously|之前/)
})

test('unchanged inputs reuse a key; changed inputs start a distinct intent', async t => {
  const h = await client(t, () => failed)
  await h.store.actions.createProject(); await h.store.actions.createProject()
  assert.equal(h.calls[0].creationKey, h.calls[1].creationKey)
  h.store.actions.setForm('goal', 'Another goal'); await h.store.actions.createProject()
  assert.notEqual(h.calls[2].creationKey, h.calls[0].creationKey)
})

test('retry uses the original recipe parameters and a recovered response preserves newer typed inputs', async t => {
  const h = await client(t, (_, n) => n === 1 ? failed : success)
  const recipe = h.store.getState().recipeCatalog.recipes.find(r => r.id === 'deepblend.metal-lamp')
  h.store.actions.selectRecipe(recipe); h.store.actions.setRecipeParameter('exposure', .3)
  await h.store.actions.createProject()
  h.store.actions.setRecipeParameter('exposure', .8); h.store.actions.setForm('title', 'Newer draft')
  await h.store.actions.retryCreation()
  assert.equal(h.calls[1].recipe.parameters.exposure, .3); assert.equal(h.calls[1].creationKey, h.calls[0].creationKey)
  assert.equal(h.store.getState().forms.recipeParameters.exposure, .8); assert.equal(h.store.getState().forms.title, 'Newer draft')
  assert.equal(h.store.getState().view, 'preview')
  assert.match(h.store.getState().notices.preview?.message ?? '', /previously|之前/)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(h.nodes().some(n => n.props['data-result-kind'] === 'creation' && n.props['data-result'] === 'ok'))
})

test('pending projects are visible but cannot be selected or used for per-project polling', async t => {
  const h = await client(t, () => failed, CREATION_REQUEST_VERSION, [{ projectId: 'pending', title: 'Pending', creationPending: true }])
  const button = h.nodes().find(n => n.props['data-action'] === 'select-project:pending')
  assert.equal(button.props.disabled, true); assert.equal(h.store.getState().activeProjectId, null)
  assert.equal(h.reads.some(url => url.includes('/projects/pending')), false)
})

test('the browser refuses creation when the running Host has no creation-recovery capability', async t => {
  const h = await client(t, () => { throw Error('must not write') }, null)
  await h.store.actions.createProject(); assert.equal(h.calls.length, 0)
  assert.equal(h.nodes().find(n => n.props['data-action'] === 'create-project').props.disabled, true)
  assert.match(h.store.getState().notices.projects.message, /restart|重启/)
})

test('a pending list row does not replace an available completed project on refresh', async t => {
  const h = await client(t, () => failed, CREATION_REQUEST_VERSION,
    [{ projectId: 'pending', creationPending: true }, { projectId: 'ready', creationPending: false }])
  assert.equal(h.store.getState().activeProjectId, 'ready')
  h.store.actions.reload(); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(h.store.getState().activeProjectId, 'ready')
})

test('the HTTP route forwards the creation key to its capable authoritative Host', async () => {
  let request
  const handlers = createHandlers({ blenderStudio: { creationRequestProtocol: CREATION_REQUEST_VERSION,
    createProject(body) { request = body; return { projectId: 'saved' } } } })
  await handlers['projects.create']({ body: input })
  assert.equal(request.creationKey, input.creationKey)
})

test('model tool keys reach capable Hosts, while older Hosts are refused without a write', async () => {
  for (const capable of [false, true]) {
    let request
    const studio = { ...(capable ? { creationRequestProtocol: CREATION_REQUEST_VERSION } : {}),
      createProject(body) { request = body; return { projectId: 'saved', title: 'Saved', creationReplayed: true,
        revision: { revision: 'r0001', digest: 'a'.repeat(64), checkpoint: null, previews: [] }, warnings: [] } } }
    const plane = await composeToolPlane({ studio, expectAtLeast: 17, label: 'creation-key' })
    try { const result = await plane.registered.get('blender_project_create').execute(input, {})
      assert.equal(result.ok, capable)
      if (capable) { assert.equal(request.creationKey, input.creationKey); assert.match(result.text, /Recovered.*no new project/) }
      else { assert.equal(request, undefined); assert.equal(result.data.errorCode, 'UI_HOST_API_STALE') }
    } finally { await plane.ctx.stop?.() }
  }
})
