/** Real catalog, Host transactions and UI routes; no Blender needed for data-only commits. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { sha256, HOST_API_VERSION, CREATION_REQUEST_VERSION } from '@deepblend/dsh-blender-contracts'
import { RecipeCatalog, BUILTIN_RECIPES } from '../../../packages/deepblend/host/lib/recipe-catalog.js'
import { createHandlers, statusForError } from '@deepblend/dsh-blender-ui'
import { loadClientBundle } from '../lib/client-bundle.mjs'

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-recipes-'))
  const recipes = join(root, 'recipes'); mkdirSync(recipes)
  cpSync(join(BUILTIN_RECIPES, 'metal-lamp'), join(recipes, 'lamp'), { recursive: true })
  const catalog = new RecipeCatalog({ builtinRoot: recipes })
  const { id, version, digest } = catalog.list().recipes[0]
  const request = { id, version, digest }
  const context = new Context(); context.provide('blenderRuntime', {})
  const studio = new BlenderStudio(context, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  studio.recipes = catalog
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, recipes, catalog, request, studio }
}

test('the distributed Host carries four validated self-contained recipes', () => {
  const result = new RecipeCatalog().list()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.recipes.map(r => r.id).sort(), ['deepblend.glass-ceramic', 'deepblend.glazed-cup', 'deepblend.metal-lamp', 'deepblend.modular-speaker'])
  assert.ok(result.recipes.every(r => r.parameters.length === (r.id === 'deepblend.metal-lamp' ? 4 : 3) && r.license === 'MIT'))
  for (const name of ['glass-ceramic', 'glazed-cup', 'metal-lamp', 'modular-speaker']) {
    for (const file of ['recipe.json', 'scene-spec.json', 'preview.png', 'LICENSE']) {
      assert.ok(readFileSync(join(BUILTIN_RECIPES, name, file)).equals(
        readFileSync(new URL(`../../recipes/${name}/${file}`, import.meta.url))), `${name}/${file} differs from its reviewed source`)
    }
  }
})

test('recipe project persists selected parameters and verifiable source in the first atomic revision', async t => {
  const { studio, request, recipes } = setup(t)
  const created = await studio.createProject({ title: 'My lamp', recipe: { ...request, parameters: { exposure: 0.4 } }, saveCheckpoint: false })
  const spec = studio.store.readRevisionSpec(created.projectId, 'r0001')
  assert.equal(spec.renderProfiles.preview.colorManagement.exposure, 0.4)
  assert.equal(spec.renderProfiles.final.colorManagement.exposure, 0.4)
  const revision = studio.store.readRevisionManifest(created.projectId, 'r0001')
  const lock = JSON.parse(readFileSync(join(studio.store.revisionDirectory(created.projectId, 'r0001'), revision.recipe.lockPath)))
  assert.equal(lock.packageDigest, request.digest)
  assert.equal(sha256(lock.sceneSource), lock.inputSha256)
  assert.equal(lock.values.exposure, 0.4)
  rmSync(recipes, { recursive: true })
  // The original input remains usable after the registered package disappears.
  assert.equal(JSON.parse(lock.sceneSource).schemaVersion, spec.schemaVersion)
  assert.equal(studio.store.readRevisionManifest(created.projectId, 'r0001').recipe.id, request.id)
})

test('invalid recipe parameters allocate no project', async t => {
  const { studio, request, root } = setup(t)
  await assert.rejects(studio.createProject({ title: 'bad', recipe: { ...request, parameters: { exposure: 999 } }, saveCheckpoint: false }), { code: 'RECIPE_PARAMETER_INVALID' })
  assert.equal(existsSync(join(root, 'projects', 'bad')), false)
})

test('the Host rejects ambiguous initial sources and ignores caller-provided provenance', async t => {
  const { studio, request } = setup(t)
  await assert.rejects(studio.createProject({ title: 'bad', recipe: request, sceneSpec: {} }), { code: 'RECIPE_REQUEST_INVALID' })
  const made = await studio.createProject({ title: 'blank', recipeLock: { id: 'forged' }, saveCheckpoint: false })
  assert.equal(studio.store.readRevisionManifest(made.projectId, 'r0001').recipe, undefined)
})

test('changed manifest is rejected against the selection digest', t => {
  const { request, recipes, catalog } = setup(t)
  const path = join(recipes, 'lamp', 'recipe.json'), manifest = JSON.parse(readFileSync(path))
  manifest.description += ' Revised.'; writeFileSync(path, JSON.stringify(manifest))
  assert.throws(() => catalog.instantiate(request), { code: 'RECIPE_CHANGED' })
})

test('tampered SceneSpec or preview never reaches instantiation or preview response', t => {
  const { request, recipes, catalog } = setup(t)
  writeFileSync(join(recipes, 'lamp', 'scene-spec.json'), '{}')
  assert.equal(catalog.list().recipes.length, 0)
  assert.equal(catalog.list().errors[0].code, 'RECIPE_HASH_MISMATCH')
  assert.throws(() => catalog.preview(request), { code: 'RECIPE_NOT_FOUND' })
})

test('duplicate identities exclude every conflicting package', t => {
  const { recipes, catalog, request } = setup(t)
  cpSync(join(recipes, 'lamp'), join(recipes, 'lamp-copy'), { recursive: true })
  assert.equal(catalog.list().recipes.length, 0)
  assert.equal(catalog.list().errors[0].code, 'RECIPE_ID_CONFLICT')
  assert.throws(() => catalog.instantiate(request), { code: 'RECIPE_NOT_FOUND' })
})

test('symlinked package and files are rejected without reading outside the catalog', t => {
  const { recipes, catalog, root } = setup(t)
  cpSync(join(recipes, 'lamp'), join(root, 'outside'), { recursive: true })
  rmSync(join(recipes, 'lamp'), { recursive: true })
  symlinkSync(join(root, 'outside'), join(recipes, 'lamp'))
  assert.equal(catalog.list().errors[0].code, 'RECIPE_PATH_INVALID')
  rmSync(join(recipes, 'lamp')); mkdirSync(join(recipes, 'lamp'))
  for (const name of ['recipe.json', 'scene-spec.json', 'preview.png']) symlinkSync(join(root, 'outside', name), join(recipes, 'lamp', name))
  assert.equal(catalog.list().recipes.length, 0)
  assert.equal(catalog.list().errors[0].code, 'RECIPE_PATH_INVALID')
})

test('bad external package does not hide healthy packages; preview bytes remain exact', t => {
  const { recipes, catalog, request } = setup(t)
  mkdirSync(join(recipes, 'broken'))
  assert.equal(catalog.list().recipes.length, 1)
  assert.equal(catalog.list().errors.length, 1)
  const preview = catalog.preview(request)
  assert.ok(preview.bytes.equals(readFileSync(join(recipes, 'lamp', 'preview.png'))))
  assert.equal(preview.size, preview.bytes.length)
})

test('recipe read errors have stable HTTP statuses', () => {
  assert.equal(statusForError({ code: 'RECIPE_CHANGED' }), 409)
  assert.equal(statusForError({ code: 'RECIPE_NOT_FOUND' }), 404)
  assert.equal(statusForError({ code: 'RECIPE_PARAMETER_INVALID' }), 400)
})

test('UI discovery and creation use the authoritative Host methods', async t => {
  const { studio, request } = setup(t)
  const handlers = createHandlers({ blenderStudio: studio })
  assert.equal((await handlers['recipes.list']()).recipes[0].digest, request.digest)
  assert.equal((await handlers.state({ query: {} })).recipeCatalog.recipes.length, 1)
  const original = studio.createProject.bind(studio)
  studio.createProject = input => original({ ...input, saveCheckpoint: false })
  const outcome = await handlers['projects.create']({ body: { title: 'From UI', recipe: { ...request, parameters: { exposure: 0.2 } } } })
  assert.equal(studio.store.readRevisionSpec(outcome.project.projectId, 'r0001').renderProfiles.final.colorManagement.exposure, 0.2)
})

test('compiler failure leaves no published recipe revision', async t => {
  const { studio, request } = setup(t)
  studio.transactions.runtime = { compileScene: async () => { throw new Error('controlled compile failure') } }
  await assert.rejects(studio.createProject({ title: 'failed', recipe: request }), /controlled compile failure/)
  assert.equal(existsSync(join(studio.projectsRoot, 'failed', 'revisions', 'r0001', 'recipe-lock.json')), false)
  assert.equal((await studio.listProjects()).projects.length, 0)
})

test('initial recipe preview respects the same sample ceiling as later previews', async t => {
  const { studio, request } = setup(t)
  studio.transactions.config.maxPreviewSamples = 8
  let usedSamples
  const actualRenderConfig = { engine: 'CYCLES', resolution: [768, 576], samples: 8,
    viewTransform: 'AgX', look: 'None', exposure: 0.2, filmTransparent: false }
  studio.transactions.runtime = {
    compileScene: async input => {
      const directory = mkdtempSync(join(input.projectRoot, 'compiler-'))
      try {
        writeFileSync(join(directory, 'result.blend'), 'controlled compiler fixture')
        input.onWorkingDirectory({ directory })
        return { report: { validation: { ok: true }, sceneFingerprint: { totalPolygons: 12 }, objects: [] }, envelope: {} }
      } finally { rmSync(directory, { recursive: true, force: true }) }
    },
    resolveEngineKey: async () => ({ blenderEngine: 'CYCLES', warning: null }),
    renderPreview: async input => {
      usedSamples = input.samples
      writeFileSync(input.outputPath, 'controlled preview fixture; not a real image')
      return { report: { cameraId: 'camera-measured', frame: 3, width: 768, height: 576,
        engine: 'CYCLES', renderConfig: actualRenderConfig }, envelope: { warnings: [], notices: [] } }
    },
  }
  const created = await studio.createProject({ title: 'bounded', recipe: request, renderPreview: true })
  assert.equal(usedSamples, 8)
  assert.equal(studio.store.readRevisionSpec(created.projectId, 'r0001').renderProfiles.preview.samples, 64)
  assert.ok(created.warnings.some(warning => warning.code === 'RENDER_SAMPLES_REDUCED'))
  const preview = studio.store.readRevisionManifest(created.projectId, 'r0001').previews[0]
  assert.equal(preview.samples, 8)
  assert.equal(preview.cameraId, 'camera-measured')
  assert.equal(preview.frame, 3)
  assert.equal(preview.engine, 'CYCLES')
  assert.deepEqual(preview.renderConfig, actualRenderConfig)
  studio.transactions.runtime.renderPreview = async input => {
    writeFileSync(input.outputPath, 'controlled preview fixture without measured metadata')
    return { report: {}, envelope: {} }
  }
  const legacy = await studio.createProject({ title: 'unknown renderer settings', recipe: request, renderPreview: true })
  const unknown = studio.store.readRevisionManifest(legacy.projectId, 'r0001').previews[0]
  for (const field of ['cameraId', 'frame', 'width', 'height', 'engine', 'samples', 'renderConfig']) {
    assert.equal(unknown[field], null, `${field} must not infer a measured value from a requested profile`)
  }
})

async function client(t) {
  const core = loadClientBundle().exports.workbench
  const calls = [], recipes = new RecipeCatalog().list()
  const store = core.createWorkbenchStore({ fetch: async (url, init = {}) => {
    let payload
    if (init.method === 'POST') {
      calls.push(JSON.parse(init.body))
      payload = { ok: false, error: { code: 'RECIPE_CHANGED', message: 'Refresh the catalog' } }
    } else payload = { ok: true, route: 'state', hostApiVersion: HOST_API_VERSION, creationRequestProtocol: CREATION_REQUEST_VERSION, projects: [], selected: null, recipeCatalog: recipes }
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload }
  } })
  t.after(() => store.stop())
  const loaded = new Promise(resolve => { const unsubscribe = store.subscribe(state => {
    if (state.status === 'ok') { unsubscribe(); resolve() }
  }) })
  store.start(); await loaded
  const nodes = () => {
    const flatten = node => node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(flatten)] : []
    return flatten(core.buildWorkbenchView(store.getState(), store.actions))
  }
  return { store, nodes, calls, recipes: recipes.recipes }
}

test('UI offers the exact catalog, converts color input to linear RGB and blocks out-of-range values', async t => {
  const { store, nodes, recipes } = await client(t)
  assert.equal(nodes().filter(node => node.props['data-recipe']).length, 4)
  store.actions.selectRecipe(recipes[0])
  const color = nodes().find(node => node.props['data-field'] === 'recipe-main-color')
  color.props.onChange({ target: { value: '#808080' } })
  assert.ok(store.getState().forms.recipeParameters['main-color'].every(channel => Math.abs(channel - 0.21586) < 0.00001))
  store.actions.setRecipeParameter('exposure', 999)
  assert.equal(nodes().find(node => node.props['data-action'] === 'create-project').props.disabled, true)
  store.actions.setRecipeParameter('exposure', 0.2)
  assert.equal(nodes().find(node => node.props['data-action'] === 'create-project').props.disabled, false)
})

test('UI pins the selected package and preserves inputs when creation is rejected', async t => {
  const { store, calls, recipes } = await client(t)
  store.actions.selectRecipe(recipes[0]); store.actions.setForm('title', 'Recipe experiment')
  store.actions.setRecipeParameter('exposure', 0.2)
  await store.actions.createProject()
  assert.equal(calls[0].recipe.digest, recipes[0].digest)
  assert.equal(calls[0].recipe.parameters.exposure, 0.2)
  assert.equal(calls[0].renderPreview, true)
  assert.equal(store.getState().forms.title, 'Recipe experiment')
  assert.match(store.getState().notices.projects.technicalDetails, /RECIPE_CHANGED/)
  store.actions.selectRecipe(null)
  await store.actions.createProject()
  assert.equal(calls[1].recipe, undefined)
})

test('switching recipes updates automatic titles and preserves a user title', async t => {
  const { store, recipes } = await client(t)
  store.actions.selectRecipe(recipes[0]); store.actions.selectRecipe(recipes[1])
  assert.equal(store.getState().forms.title, recipes[1].title)
  store.actions.setForm('title', 'My design'); store.actions.selectRecipe(recipes[2])
  assert.equal(store.getState().forms.title, 'My design')
})

test('an updated catalog disables a stale selection until the recipe is selected again', async t => {
  const { store, nodes, recipes, calls } = await client(t)
  store.actions.selectRecipe(recipes[0])
  recipes[0] = { ...recipes[0], digest: 'f'.repeat(64) }
  await new Promise(resolve => {
    const unsubscribe = store.subscribe(state => { if (state.recipeCatalog.recipes[0].digest === recipes[0].digest) { unsubscribe(); resolve() } })
    store.actions.reload()
  })
  assert.equal(nodes().find(node => node.props['data-action'] === 'create-project').props.disabled, true)
  await store.actions.createProject(); assert.equal(calls.length, 0)
  store.actions.selectRecipe(recipes[0])
  assert.equal(nodes().find(node => node.props['data-action'] === 'create-project').props.disabled, false)
})

test('same recipe ID can expose distinct versions and removed v1 cannot silently select v2', async t => {
  const {root,recipes,catalog,studio,request}=setup(t)
  cpSync(new URL('../fixtures/metal-lamp-v1/',import.meta.url),join(recipes,'historical'),{recursive:true})
  const items=catalog.list();assert.deepEqual(items.errors,[])
  assert.deepEqual(items.recipes.map(r=>r.version).sort(),['1.0.0','2.0.0'])
  const old=items.recipes.find(r=>r.version==='1.0.0'),selection={id:old.id,version:old.version,digest:old.digest,parameters:{'surface-roughness':.45}}
  assert(readFileSync(new URL('../fixtures/metal-lamp-v1/preview.png',import.meta.url)).equals(catalog.preview(selection).bytes))
  const made=await studio.createProject({title:'historical lamp',recipe:selection,saveCheckpoint:false})
  const directory=studio.store.revisionDirectory(made.projectId,'r0001')
  const manifest=studio.store.readRevisionManifest(made.projectId,'r0001'),lockPath=join(directory,manifest.recipe.lockPath)
  const before=readFileSync(lockPath),source=readFileSync(join(directory,'scene-spec.json'))
  const lock=JSON.parse(before);assert.equal(lock.version,'1.0.0');assert.equal(lock.values['surface-roughness'],.45)
  assert.equal(sha256(lock.sceneSource),'6896f467a2bea311f14435c5fd755a021867c686262ea71cac80d4198694d75d')
  rmSync(join(recipes,'historical'),{recursive:true})
  assert.throws(()=>catalog.instantiate(selection),{code:'RECIPE_NOT_FOUND'})
  assert.equal(catalog.list().recipes[0].version,'2.0.0')
  assert(before.equals(readFileSync(lockPath)));assert(source.equals(readFileSync(join(directory,'scene-spec.json'))))
  const current=catalog.instantiate(request)
  assert.equal(current.lock.version,'2.0.0');assert.equal(current.lock.values['spun-roughness'],.28);assert.equal(current.lock.values['brushed-roughness'],.39)
})

test('cup versions keep distinct transition defaults and immutable historical source locks', async t => {
  const {recipes,catalog,studio}=setup(t)
  cpSync(join(BUILTIN_RECIPES,'glazed-cup'),join(recipes,'cup-current'),{recursive:true})
  cpSync(new URL('../fixtures/glazed-cup-v2/',import.meta.url),join(recipes,'cup-middle'),{recursive:true})
  cpSync(new URL('../fixtures/glazed-cup-v1/',import.meta.url),join(recipes,'cup-old'),{recursive:true})
  const entries=catalog.list().recipes.filter(r=>r.id==='deepblend.glazed-cup');assert.deepEqual(entries.map(r=>r.version).sort(),['1.0.0','2.0.0','3.0.0'])
  const select=version=>{const r=entries.find(r=>r.version===version);return {id:r.id,version:r.version,digest:r.digest}}
  const original=select('1.0.0'),middle=select('2.0.0'),current=select('3.0.0')
  assert.equal(catalog.instantiate(original).sceneSpec.entities.find(e=>e.id==='cup').generator.rootTension,1)
  assert.equal(catalog.instantiate(middle).sceneSpec.entities.find(e=>e.id==='cup').generator.rootTension,1.5)
  assert.equal(catalog.instantiate(current).sceneSpec.entities.find(e=>e.id==='cup').generator.rootTension,2.5)
  const middleMade=await studio.createProject({title:'historical cup v2',recipe:middle,saveCheckpoint:false}),middleDirectory=studio.store.revisionDirectory(middleMade.projectId,'r0001'),middleManifest=studio.store.readRevisionManifest(middleMade.projectId,'r0001')
  const middleBefore=Object.fromEntries(['scene-spec.json',middleManifest.recipe.lockPath].map(p=>[p,readFileSync(join(middleDirectory,p))]))
  const middleLock=JSON.parse(middleBefore[middleManifest.recipe.lockPath]);assert.equal(middleLock.version,'2.0.0')
  assert.equal(sha256(middleLock.sceneSource),'7bf69996931787262aa7a1155d80149c8e2e2ee7041fd771884070c032ef80ca')
  assert.equal(JSON.parse(middleLock.sceneSource).entities.find(e=>e.id==='cup').generator.rootTension,1.5)
  const made=await studio.createProject({title:'historical cup',recipe:original,saveCheckpoint:false}),directory=studio.store.revisionDirectory(made.projectId,'r0001'),manifest=studio.store.readRevisionManifest(made.projectId,'r0001')
  const before=Object.fromEntries(['scene-spec.json',manifest.recipe.lockPath].map(p=>[p,readFileSync(join(directory,p))]))
  const lock=JSON.parse(before[manifest.recipe.lockPath]);assert.equal(lock.version,'1.0.0');assert.equal(sha256(lock.sceneSource),'59e8d58c33bd4dfb16af906d894ffd12cd12c3b3a8395579c9ae0df7856b6b5c')
  assert.equal(JSON.parse(lock.sceneSource).entities.find(e=>e.id==='cup').generator.rootTension,undefined)
  rmSync(join(recipes,'cup-old'),{recursive:true});assert.throws(()=>catalog.instantiate(original),{code:'RECIPE_NOT_FOUND'})
  rmSync(join(recipes,'cup-middle'),{recursive:true});assert.throws(()=>catalog.instantiate(middle),{code:'RECIPE_NOT_FOUND'})
  assert.equal(catalog.instantiate(current).lock.version,'3.0.0')
  for(const [p,b]of Object.entries(before))assert(b.equals(readFileSync(join(directory,p))))
  for(const [p,b]of Object.entries(middleBefore))assert(b.equals(readFileSync(join(middleDirectory,p))))
})
