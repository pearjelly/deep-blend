import test from 'node:test'
import assert from 'node:assert/strict'
import { HOST_API_VERSION, CREATION_REQUEST_VERSION } from '@deepblend/dsh-blender-contracts'
import { RecipeCatalog } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { loadClientBundle } from '../lib/client-bundle.mjs'

class Storage {
  values = new Map()
  failWrites = false
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failWrites) throw Error('quota'); this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}
const prefix = root => 'deepblend.creation-draft/v1:' + encodeURIComponent(root) + ':'
const records = (storage, root) => [...storage.values].filter(([key]) => key.startsWith(prefix(root))).map(([key, raw]) => ({ key, raw, data: JSON.parse(raw) }))
const unavailable = { ok: false, error: { code: 'BLENDER_NOT_FOUND', message: 'Unavailable' } }
const recovered = { ok: true, project: { projectId: 'existing', creationReplayed: true } }

async function client(t, storage, options = {}) {
  const core = loadClientBundle().exports.workbench, posts = []
  let root = options.root ?? '/projects/a', recipes = options.recipes ?? new RecipeCatalog().list(), protocol = options.protocol ?? CREATION_REQUEST_VERSION
  const store = core.createWorkbenchStore({ creationDraftStorage: storage, creationDraftLifecycle: options.lifecycle, pollIdleMs: 100000,
    fetch: async (url, init = {}) => {
      let payload
      if (init.method === 'POST') {
        const body = JSON.parse(init.body); posts.push(body)
        payload = await (options.post?.(body, posts.length) ?? unavailable)
      } else {
        const route = url.includes('/jobs') ? 'project.jobs' : url.includes('/previews') ? 'project.previews' : 'state'
        payload = { ok: true, route, hostApiVersion: HOST_API_VERSION, creationRequestProtocol: protocol,
          projectsRoot: root, projects: [], selected: null, recipeCatalog: recipes, jobs: [], unfinished: [], previews: { revisions: [] } }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
    } })
  t.after(() => store.stop())
  const ready = new Promise(resolve => { const off = store.subscribe(s => { if (s.status === 'ok') { off(); resolve() } }) })
  store.start(); await ready
  const nodes = () => {
    const walk = n => n && typeof n === 'object' ? [n, ...(n.children ?? []).flatMap(walk)] : []
    return walk(core.buildWorkbenchView(store.getState(), store.actions))
  }
  const reload = async changedRoot => {
    if (changedRoot) root = changedRoot
    const complete = new Promise(resolve => { const off = store.subscribe(s => { if (s.projectsRoot === root) { off(); resolve() } }) })
    store.actions.reload(); await complete
  }
  return { store, posts, nodes, reload, root, storage, core,
    draft: () => store.getState().creationDrafts[0],
    recipe: () => store.getState().recipeCatalog.recipes.find(recipe => recipe.id === 'deepblend.metal-lamp') }
}
function fill(h, title = 'Warm lamp') {
  h.store.actions.selectRecipe(h.recipe()); h.store.actions.setForm('title', title)
  h.store.actions.setForm('goal', 'Keep the warm studio brief'); h.store.actions.setRecipeParameter('exposure', .3)
}

test('unsent creation inputs survive a new store but restoring remains explicit and read-only', async t => {
  const storage = new Storage(), first = await client(t, storage); fill(first)
  const saved = records(storage, first.root)[0].data
  assert.equal(saved.forms.title, 'Warm lamp'); assert.equal(saved.forms.goal, 'Keep the warm studio brief')
  assert.equal(saved.forms.recipeParameters.exposure, .3); assert.equal(saved.attempt, null)
  assert.deepEqual(Object.keys(saved.forms.recipe).sort(), ['digest', 'id', 'version'])
  first.store.stop(); const reopened = await client(t, storage)
  assert.equal(reopened.store.getState().forms.title, ''); assert.equal(reopened.posts.length, 0)
  assert.equal(reopened.draft().title, 'Warm lamp')
  assert.ok(reopened.nodes().some(node => node.props['data-action'] === 'restore-creation-draft:' + reopened.draft().id))
  reopened.store.actions.restoreCreationDraft(reopened.draft().id)
  assert.equal(reopened.store.getState().forms.title, 'Warm lamp'); assert.equal(reopened.store.getState().forms.recipeParameters.exposure, .3)
  assert.equal(reopened.posts.length, 0)
})

test('the captured request is saved before POST and a reopened draft retries the same key and original inputs', async t => {
  const storage = new Storage(); let beforePost
  const first = await client(t, storage, { post: body => { beforePost = records(storage, '/projects/a')[0].data.attempt; return Promise.reject(TypeError('actual reply lost')) } })
  fill(first); await first.store.actions.createProject()
  assert.equal(beforePost.key, first.posts[0].creationKey); assert.deepEqual(beforePost.body.recipe, first.posts[0].recipe)
  first.store.stop(); const next = await client(t, storage, { post: () => recovered })
  next.store.actions.restoreCreationDraft(next.draft().id)
  assert.equal(next.posts.length, 0); assert.ok(next.nodes().some(node => node.props['data-action'] === 'retry-creation'))
  await next.store.actions.retryCreation(); assert.deepEqual(next.posts[0], first.posts[0])
  assert.equal(records(storage, next.root).length, 0)
})

test('a pending HTTP operation survives store teardown without an automatic retry', async t => {
  const storage = new Storage(); let settle
  const first = await client(t, storage, { post: () => new Promise(resolve => { settle = resolve }) }); fill(first)
  const writing = first.store.actions.createProject()
  assert.equal(records(storage, first.root)[0].data.attempt.key, first.posts[0].creationKey)
  first.store.stop(); const next = await client(t, storage)
  next.store.actions.restoreCreationDraft(next.draft().id); assert.equal(next.posts.length, 0)
  await next.store.actions.retryCreation(); assert.equal(next.posts[0].creationKey, first.posts[0].creationKey)
  settle(unavailable); await writing
  assert.equal(records(storage, next.root).length, 1)
  assert.equal(records(storage, next.root)[0].data.ownerActive, true)
})

test('retry preserves newer draft values and completion removes only the confirmed original inputs', async t => {
  const storage = new Storage(), first = await client(t, storage); fill(first); await first.store.actions.createProject(); first.store.stop()
  const next = await client(t, storage, { post: () => recovered }); next.store.actions.restoreCreationDraft(next.draft().id)
  next.store.actions.setForm('title', 'Newer scene'); next.store.actions.setRecipeParameter('exposure', .8)
  await next.store.actions.retryCreation()
  assert.equal(next.posts[0].title, 'Warm lamp'); assert.equal(next.posts[0].recipe.parameters.exposure, .3)
  const remaining = records(storage, next.root); assert.equal(remaining.length, 1)
  assert.equal(remaining[0].data.forms.title, 'Newer scene'); assert.equal(remaining[0].data.forms.recipeParameters.exposure, .8); assert.equal(remaining[0].data.attempt, null)
  const third = await client(t, storage); third.store.actions.restoreCreationDraft(third.draft().id)
  assert.equal(third.store.getState().forms.title, 'Newer scene'); assert.equal(third.store.getState().forms.recipeParameters.exposure, .8)
})

test('a later edit to the restored source record is never removed by another page completing its request', async t => {
  const storage = new Storage(), first = await client(t, storage); fill(first); await first.store.actions.createProject()
  const next = await client(t, storage, { post: () => recovered }); next.store.actions.restoreCreationDraft(next.draft().id)
  first.store.actions.setForm('goal', 'A later goal in the other page')
  await next.store.actions.retryCreation()
  assert.ok(records(storage, next.root).some(entry => entry.data.forms.goal === 'A later goal in the other page'))
})

test('different live pages keep separate drafts in the same project store', async t => {
  const storage = new Storage(), a = await client(t, storage), b = await client(t, storage)
  fill(a, 'Page A'); fill(b, 'Page B'); a.store.actions.setRecipeParameter('exposure', .6)
  const saved = records(storage, a.root); assert.equal(saved.length, 2)
  assert.equal(saved.find(entry => entry.data.forms.title === 'Page A').data.forms.recipeParameters.exposure, .6)
  assert.equal(saved.find(entry => entry.data.forms.title === 'Page B').data.forms.recipeParameters.exposure, .3)
})

test('explicit restoration preserves a currently edited draft as a separate saved entry', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a, 'Original')
  const b = await client(t, storage); fill(b, 'Current unsent'); const old = b.store.getState().creationDrafts.find(draft => draft.title === 'Original')
  b.store.actions.restoreCreationDraft(old.id)
  assert.equal(b.store.getState().forms.title, 'Original')
  assert.ok(records(storage, b.root).some(entry => entry.data.forms.title === 'Current unsent'))
  assert.equal(b.posts.length, 0)
})

test('different stores never offer or replay another store\'s saved creation intent', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); await a.store.actions.createProject()
  const b = await client(t, storage, { root: '/projects/b' }); assert.equal(b.store.getState().creationDrafts.length, 0)
  await a.reload('/projects/b'); assert.equal(a.store.getState().forms.title, ''); assert.equal(a.store.getState().creationWork, null)
  await a.store.actions.retryCreation(); assert.equal(a.posts.length, 1)
  assert.equal(records(storage, '/projects/a').length, 1)
})

test('a late response from a different project store cannot replace the active store selection or inputs', async t => {
  const storage = new Storage(); let settle
  const h = await client(t, storage, { post: () => new Promise(resolve => { settle = resolve }) }); fill(h)
  const pending = h.store.actions.createProject(); await h.reload('/projects/b')
  h.store.actions.setForm('title', 'New store draft'); settle(recovered); await pending
  assert.equal(h.store.getState().projectId, null); assert.equal(h.store.getState().forms.title, 'New store draft')
})

test('corrupt, oversized and tampered draft records remain untouched and cannot be submitted', async t => {
  const storage = new Storage(), source = await client(t, storage); fill(source); await source.store.actions.createProject(); source.store.stop()
  const entry = records(storage, source.root)[0], fixtures = [
    '{broken', JSON.stringify({ ...entry.data, schemaVersion: 'unknown' }),
    JSON.stringify({ ...entry.data, forms: { ...entry.data.forms, patch: 'unexpected scene write' } }),
    JSON.stringify({ ...entry.data, attempt: { ...entry.data.attempt, signature: 'changed' } }),
    JSON.stringify({ ...entry.data, attempt: { ...entry.data.attempt, body: { ...entry.data.attempt.body, sceneSpec: {} } } }),
    JSON.stringify(entry.data).replace('"exposure":0.3', '"exposure":1e999'),
    JSON.stringify({ ...entry.data, attempt: { ...entry.data.attempt, key: 'invalid\nkey' } }),
    'x'.repeat(262145),
    JSON.stringify({ ...entry.data, forms: { ...entry.data.forms, goal: 'x'.repeat(262145) } }),
  ]
  for (const raw of fixtures) {
    storage.setItem(entry.key, raw); const h = await client(t, storage)
    assert.equal(h.draft().invalid, true)
    assert.ok(h.nodes().some(node => node.props['data-action'] === 'restore-creation-draft:' + h.draft().id && node.props.disabled))
    h.store.actions.restoreCreationDraft(h.draft().id); await h.store.actions.retryCreation()
    assert.equal(h.posts.length, 0); assert.equal(storage.getItem(entry.key), raw); h.store.stop()
  }
})

test('unavailable or quota-limited storage leaves current inputs and explicit in-memory retries usable', async t => {
  const storage = new Storage(); storage.failWrites = true
  const h = await client(t, storage); fill(h); assert.equal(h.store.getState().creationDraftStorageStatus, 'unavailable')
  assert.equal(h.store.getState().forms.title, 'Warm lamp')
  assert.ok(h.nodes().some(node => node.props['data-creation-draft-status'] === 'unavailable'))
  await h.store.actions.createProject(); await h.store.actions.retryCreation(); assert.equal(h.posts.length, 2)
  assert.equal(h.posts[0].creationKey, h.posts[1].creationKey)
})

test('an oversized input or non-JSON numeric value is never silently truncated or changed in a saved draft', async t => {
  const storage = new Storage(), h = await client(t, storage); fill(h)
  const before = records(storage, h.root)[0].raw, huge = '界'.repeat(100000)
  h.store.actions.setForm('goal', huge); assert.equal(h.store.getState().forms.goal, huge)
  assert.equal(h.store.getState().creationDraftStorageStatus, 'tooLarge'); assert.equal(records(storage, h.root)[0].raw, before)
  h.store.actions.setForm('goal', 'Valid'); const valid = records(storage, h.root)[0].raw
  h.store.actions.setRecipeParameter('exposure', NaN); assert.ok(Number.isNaN(h.store.getState().forms.recipeParameters.exposure))
  assert.equal(h.store.getState().creationDraftStorageStatus, 'unavailable'); assert.equal(records(storage, h.root)[0].raw, valid)
})

test('retired recipes retain captured parameters and requests while new creation requires a current selection', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); await a.store.actions.createProject(); a.store.stop()
  const b = await client(t, storage, { recipes: { recipes: [], errors: [] }, post: () => recovered }); b.store.actions.restoreCreationDraft(b.draft().id)
  assert.equal(b.store.getState().creationDraftMissingRecipe.id, 'deepblend.metal-lamp')
  assert.equal(b.store.getState().forms.recipeParameters.exposure, .3)
  assert.ok(b.nodes().some(node => node.props['data-action'] === 'create-project' && node.props.disabled))
  await b.store.actions.createProject(); assert.equal(b.posts.length, 0)
  await b.store.actions.retryCreation(); assert.deepEqual(b.posts[0], a.posts[0])
})

test('saved missing-recipe information survives another reopen without silently becoming a blank project', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); a.store.stop()
  const b = await client(t, storage, { recipes: { recipes: [], errors: [] } }); b.store.actions.restoreCreationDraft(b.draft().id); b.store.stop()
  const c = await client(t, storage, { recipes: { recipes: [], errors: [] } }); c.store.actions.restoreCreationDraft(c.draft().id)
  assert.equal(c.store.getState().creationDraftMissingRecipe.id, 'deepblend.metal-lamp')
  assert.equal(c.store.getState().forms.recipeParameters.exposure, .3)
})

test('a recipe with the same id and version but a different digest cannot silently replace the saved recipe', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); await a.store.actions.createProject(); a.store.stop()
  const catalog = new RecipeCatalog().list(), changed = { ...catalog, recipes: catalog.recipes.map(recipe => recipe.id === 'deepblend.metal-lamp' ? { ...recipe, digest: 'f'.repeat(64) } : recipe) }
  const b = await client(t, storage, { recipes: changed, post: () => recovered }); b.store.actions.restoreCreationDraft(b.draft().id)
  assert.equal(b.store.getState().creationDraftMissingRecipe.digest, a.posts[0].recipe.digest)
  assert.equal(b.store.getState().forms.recipe, null); await b.store.actions.createProject(); assert.equal(b.posts.length, 0)
  await b.store.actions.retryCreation(); assert.equal(b.posts[0].recipe.digest, a.posts[0].recipe.digest)
})

test('a silently refused browser write is detected without discarding the current inputs', async t => {
  const storage = new Storage(); storage.setItem = () => {}
  const h = await client(t, storage); fill(h)
  assert.equal(h.store.getState().creationDraftStorageStatus, 'unavailable'); assert.equal(h.store.getState().forms.title, 'Warm lamp')
  assert.equal(storage.length, 0); await h.store.actions.createProject(); await h.store.actions.retryCreation()
  assert.equal(h.posts.length, 2); assert.equal(h.posts[0].creationKey, h.posts[1].creationKey)
})

test('deleting a chosen browser draft or clearing the current draft never posts or clears another store', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); a.store.stop()
  const other = await client(t, storage, { root: '/projects/b' }); fill(other, 'Other store')
  storage.setItem('deepblend.workbench.appearance', 'dark')
  const b = await client(t, storage); b.store.actions.deleteCreationDraft(b.draft().id)
  assert.equal(records(storage, '/projects/a').length, 0); assert.equal(records(storage, '/projects/b').length, 1)
  fill(b, 'Current'); b.store.actions.clearCreationDraft(); assert.equal(b.store.getState().forms.title, '')
  assert.equal(records(storage, '/projects/a').length, 0); assert.equal(storage.getItem('deepblend.workbench.appearance'), 'dark'); assert.equal(b.posts.length, 0)
})

test('twenty existing drafts are retained when another page reaches the storage limit', async t => {
  const storage = new Storage()
  for (let i = 0; i < 20; i++) { const h = await client(t, storage); h.store.actions.setForm('title', 'Draft ' + i); h.store.stop() }
  const before = [...storage.values], extra = await client(t, storage); extra.store.actions.setForm('title', 'Another')
  assert.equal(extra.store.getState().creationDraftStorageStatus, 'full'); assert.deepEqual([...storage.values], before)
  extra.store.actions.deleteCreationDraft(extra.draft().id)
  assert.equal(extra.store.getState().creationDraftStorageStatus, 'saved'); assert.equal(records(storage, extra.root).length, 20)
})

test('repeatedly reopening an inactive draft consumes the copied record without filling the draft limit', async t => {
  const storage = new Storage(); let h = await client(t, storage); fill(h); h.store.stop()
  for (let i = 0; i < 5; i++) {
    h = await client(t, storage); h.store.actions.restoreCreationDraft(h.draft().id)
    assert.equal(records(storage, h.root).length, 1); assert.equal(h.store.getState().forms.title, 'Warm lamp')
    h.store.stop(); assert.equal(records(storage, h.root)[0].data.ownerActive, false)
  }
})

test('restoring a live page creates a separate record and never consumes its active saved inputs', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a)
  const b = await client(t, storage); b.store.actions.restoreCreationDraft(b.draft().id)
  assert.equal(records(storage, a.root).length, 2)
  a.store.actions.setForm('title', 'Live original'); b.store.actions.setForm('title', 'Restored copy')
  assert.deepEqual(records(storage, a.root).map(r => r.data.forms.title).sort(), ['Live original', 'Restored copy'])
})

test('pagehide marks a draft inactive and pageshow resumes persistence without posting', async t => {
  const listeners = new Map(), lifecycle = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const storage = new Storage(), h = await client(t, storage, { lifecycle }); fill(h)
  listeners.get('pagehide')(); assert.equal(records(storage, h.root)[0].data.ownerActive, false)
  listeners.get('pageshow')(); assert.equal(records(storage, h.root)[0].data.ownerActive, true)
  h.store.actions.setForm('title', 'After pageshow'); assert.equal(records(storage, h.root)[0].data.forms.title, 'After pageshow')
  assert.equal(h.posts.length, 0); h.store.stop(); assert.equal(listeners.size, 0)
})

test('a failed copy cannot consume an inactive original browser draft', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); a.store.stop()
  const before = records(storage, a.root)[0], b = await client(t, storage); storage.failWrites = true
  b.store.actions.restoreCreationDraft(b.draft().id)
  assert.equal(storage.getItem(before.key), before.raw); assert.equal(b.store.getState().forms.title, 'Warm lamp')
  assert.equal(b.store.getState().creationDraftStorageStatus, 'unavailable'); assert.equal(b.posts.length, 0)
})

test('starting the same store again marks its saved draft active while retaining its inputs', async t => {
  const storage = new Storage(), h = await client(t, storage); fill(h); h.store.stop()
  assert.equal(records(storage, h.root)[0].data.ownerActive, false)
  h.store.start(); assert.equal(records(storage, h.root)[0].data.ownerActive, true)
  assert.equal(h.store.getState().forms.title, 'Warm lamp'); assert.equal(h.posts.length, 0)
})

test('a stopped page cannot publish late input callbacks into another page\'s recovered draft', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); a.store.stop()
  const b = await client(t, storage); b.store.actions.restoreCreationDraft(b.draft().id)
  const before = [...storage.values]
  a.store.actions.setForm('title', 'Late callback from a stopped page')
  a.store.actions.setRecipeParameter('exposure', .9)
  assert.deepEqual([...storage.values], before)
  assert.equal(b.store.getState().forms.title, 'Warm lamp'); assert.equal(b.store.getState().forms.recipeParameters.exposure, .3)
})

test('completion cleans only the unchanged active source of the confirmed creation', async t => {
  const storage = new Storage(), a = await client(t, storage); fill(a); await a.store.actions.createProject()
  const b = await client(t, storage, { post: () => recovered }); b.store.actions.restoreCreationDraft(b.draft().id)
  assert.equal(records(storage, a.root).length, 2)
  await b.store.actions.retryCreation(); assert.equal(records(storage, a.root).length, 0)
  assert.deepEqual(b.posts[0], a.posts[0])
})
