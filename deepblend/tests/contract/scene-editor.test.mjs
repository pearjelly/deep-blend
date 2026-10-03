/** Public object editor: lossless patches, project-pinned drafts and honest preview evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileSceneSpec, buildSceneTree, applyPatchToSpec, validateScenePatch, validateSceneSpec, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const plain = value => JSON.parse(JSON.stringify(value))
const core = loadClientBundle().exports.workbench
const editor = core.sceneEditor
const source = name => compileSceneSpec(JSON.parse(readFileSync(new URL(`../../recipes/${name}/scene-spec.json`, import.meta.url)))).spec
const tree = (spec, revision = 'r0001', assetParts = []) => buildSceneTree(spec, { revision, assetParts })
const make = (name = 'metal-lamp', id = 'shade-shell') => { const spec = source(name); return { spec, draft: editor.createDraft(tree(spec), 'project-a', id) } }
function apply(spec, draft) {
  const patch = plain(editor.buildPatch(draft))
  assert.equal(validateScenePatch(patch).ok, true, validateScenePatch(patch).summary)
  const next = applyPatchToSpec(spec, patch).spec
  assert.equal(validateSceneSpec(next).ok, true, validateSceneSpec(next).summary)
  return { patch, next }
}
const config = { engine: 'CYCLES', resolution: [320, 240], resolutionPercentage: 100, samples: 16, filmTransparent: false, viewTransform: 'AgX', look: 'None', exposure: 0, fps: 24, frameStart: 1, frameEnd: 48 }
const artifact = (revision, extra = {}) => ({ kind: 'preview', path: `revisions/${revision}/previews/hero.png`, sha256: revision.repeat(8), cameraId: 'hero', frame: 1, width: 320, height: 240, engine: 'CYCLES', samples: 16, renderConfig: plain(config), ...extra })
const flatten = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flatten)] : []
const waitFor = async (store, predicate) => {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('client state did not settle')) }, 3000)
    const unsubscribe = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); unsubscribe(); resolve() } })
  })
}
async function client(t, spec = source('metal-lamp'), options = {}) {
  const projects = { 'project-a': { spec, revision: 'r0001' }, 'project-b': { spec: plain(spec), revision: 'r0001' } }
  const calls = [], previews = { 'project-a': [{ revision: 'r0001', previews: [artifact('r0001')], contactSheets: [{ path: 'wrong-frame24-sheet.png', sha256: 'sheet' }] }], 'project-b': [] }
  let failure = null
  const settings = { pollIdleMs: 100000, fetch: async (url, init = {}) => {
    const path = new URL(url, 'http://localhost'), projectId = path.pathname.match(/projects\/([^/]+)/)?.[1] || path.searchParams.get('projectId') || 'project-a'
    const project = projects[projectId]
    let payload
    if (init.method === 'POST') {
      const body = JSON.parse(init.body); calls.push({ path: path.pathname, body })
      if (options.onPost) await options.onPost({ path: path.pathname, body })
      if (failure) payload = { ok: false, error: failure }
      else if (path.pathname.endsWith('/patch')) {
        assert.equal(body.patch.baseRevision, project.revision)
        project.spec = applyPatchToSpec(project.spec, body.patch).spec; project.revision = 'r0002'
        previews[projectId].push({ revision: 'r0002', previews: [artifact('r0002')] })
        payload = { ok: true, revision: { revision: 'r0002', digest: 'changed', previews: options.omitResponsePreviews ? [] : [artifact('r0002')] } }
      } else if (path.pathname.endsWith('/restore')) {
        assert.equal(body.expectedCurrentRevision, project.revision)
        project.revision = body.revision; payload = { ok: true, revision: { revision: body.revision } }
      }
    } else if (path.pathname.endsWith('/jobs')) payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (path.pathname.endsWith('/previews')) payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.previews', artifactBase: '/artifact', previews: { revisions: previews[projectId] } }
    else payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'state', projects: Object.keys(projects).map(projectId => ({ projectId })),
      selected: { project: { title: projectId, projectId, revisionCount: 1 }, qa: { summary: 'Controlled UI fixture' }, currentRevision: project.revision, scene: tree(project.spec, project.revision), jobs: [], unfinishedJobs: [] } }
    return { ok: true, status: payload.ok ? 200 : 409, text: async () => JSON.stringify(payload), json: async () => payload }
  } }
  const mounted = options.root ? await core.mountStandalone(options.root, settings) : null
  const store = mounted?.store || core.createWorkbenchStore(settings)
  t.after(() => mounted ? mounted.dispose() : store.stop()); store.start(); await waitFor(store, s => s.status === 'ok')
  store.actions.setView('scene'); store.actions.selectEditorEntity('shade-shell')
  const nodes = () => flatten(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = name => nodes().find(node => node.props['data-field'] === name)
  return { store, nodes, field, calls, projects, previews, fail: value => { failure = value } }
}

test('untouched drafts are no-ops for all four built-in recipes, isolated from the scene', () => {
  for (const name of ['metal-lamp', 'glass-ceramic', 'modular-speaker', 'glazed-cup']) {
    const spec = source(name), scene = tree(spec), before = JSON.stringify(scene)
    for (const entity of scene.nodes.entities) {
      const draft = editor.createDraft(scene, 'project-a', entity.id)
      assert.deepEqual(plain(editor.errors(draft)), [], entity.id)
      assert.deepEqual(plain(editor.buildPatch(draft).operations), [], entity.id)
      draft.entity.transform.location[0] += .1
    }
    assert.equal(JSON.stringify(scene), before)
  }
})

test('position and rotation patches preserve scale, geometry and unrelated entities', () => {
  const { spec, draft } = make(), before = plain(spec)
  draft.entity.transform.location[0] += .008; draft.entity.transform.rotationEuler[2] += Math.PI / 6
  const { patch, next } = apply(spec, draft)
  assert.equal(patch.saveCheckpoint, true); assert.equal(patch.renderPreview, true)
  assert.deepEqual(Object.keys(patch.operations[0]).sort(), ['entityId', 'location', 'op', 'rotationEuler'])
  assert.deepEqual(next.entities[0].transform.scale, before.entities[0].transform.scale)
  assert.deepEqual(next.entities.slice(1), before.entities.slice(1)); assert.deepEqual(spec, before)
})

test('lathe profile point edits keep caps, resolution, bevel and transform', () => {
  const { spec, draft } = make()
  draft.entity.generator.profile[2][0] += .0001
  const { next, patch } = apply(spec, draft)
  assert.equal(patch.operations[0].op, 'entity.generator.set')
  const expected = plain(spec.entities[0].generator); expected.profile[2][0] += .0001
  assert.deepEqual(next.entities[0].generator, expected)
  assert.deepEqual(next.entities[0].transform, spec.entities[0].transform)
})

test('curve path editing retains smooth interpolation, cap policy and tube resolution', () => {
  const { spec, draft } = make('metal-lamp', 'fabric-power-cable')
  draft.entity.generator.path[2][1] += .002
  const { next } = apply(spec, draft), old = spec.entities.find(e => e.id === draft.entityId)
  const expected = plain(old.generator); expected.path[2][1] += .002
  assert.deepEqual(next.entities.find(e => e.id === draft.entityId).generator, expected)
})

test('each public modifier remains a complete ordered definition in the generated patch', () => {
  const { spec, draft } = make()
  draft.entity.modifiers = [
    { type: 'bevel', width: .0005, segments: 3, angle: 25 },
    { type: 'solidify', thickness: .002, offset: -.5 },
    { type: 'array', count: 3, offset: [.1, 0, 0] },
    { type: 'mirror', axis: 'y', merge: false },
    { type: 'boolean', operation: 'difference', targetEntityId: 'weighted-base' },
  ]
  const { patch, next } = apply(spec, draft)
  assert.equal(patch.operations[0].op, 'entity.modifiers.set')
  assert.deepEqual(next.entities[0].modifiers, draft.entity.modifiers)
})

test('unspecified bevel inner corners display arc without materializing or rewriting the stack', async t => {
  const spec = source('metal-lamp'), target = spec.entities.find(entity => entity.id === 'shade-shell')
  target.modifiers = [{ type: 'bevel', width: .0005, segments: 3, angle: 25 }]
  const { store, field } = await client(t, spec)
  assert.equal(field('editor-modifier-0-miterInner').props.value, 'arc')
  assert.deepEqual(plain(editor.buildPatch(editor.draftFor(store.getState())).operations), [])
  assert.equal(Object.hasOwn(editor.draftFor(store.getState()).entity.modifiers[0], 'miterInner'), false)
  store.actions.updateEditor('transform', ['location', 0], .001)
  assert.deepEqual(plain(editor.buildPatch(editor.draftFor(store.getState())).operations.map(operation => operation.op)), ['entity.transform.update'])
  store.actions.resetEditor()
  field('editor-modifier-0-width').props.onChange({ target: { value: '0.8' } })
  const stack = plain(editor.buildPatch(editor.draftFor(store.getState())).operations[0].modifiers)
  assert.deepEqual(stack, [{ type: 'bevel', width: .0008, segments: 3, angle: 25 }])
  assert.equal(field('editor-generator-bevel-miterInner'), undefined, 'generator bevel has no new control')
})

test('explicit bevel corner edits preserve ordered operations and unrelated geometry and materials', async t => {
  const spec = source('metal-lamp'), target = spec.entities.find(entity => entity.id === 'shade-shell')
  target.modifiers = [{ type: 'bevel', width: .0005, segments: 3, angle: 25 }, { type: 'array', count: 2, offset: [.01, 0, 0] }]
  const { store, field, calls, projects } = await client(t, spec)
  field('editor-modifier-0-miterInner').props.onChange({ target: { value: 'sharp' } })
  assert.equal(field('editor-modifier-0-miterInner').props.value, 'sharp')
  await store.actions.applyEditor(); await waitFor(store, state => state.currentRevision === 'r0002')
  const patch = calls[0].body.patch
  assert.equal(validateScenePatch(patch).ok, true, validateScenePatch(patch).summary)
  assert.deepEqual(patch.operations, [{ op: 'entity.modifiers.set', entityId: 'shade-shell', modifiers: [
    { type: 'bevel', width: .0005, segments: 3, angle: 25, miterInner: 'sharp' }, { type: 'array', count: 2, offset: [.01, 0, 0] },
  ] }])
  const changed = projects['project-a'].spec.entities.find(entity => entity.id === 'shade-shell')
  assert.deepEqual(changed.generator, target.generator); assert.deepEqual(changed.transform, target.transform)
  assert.deepEqual(projects['project-a'].spec.materials, spec.materials)
  store.actions.setView('scene'); store.actions.selectEditorEntity('shade-shell'); assert.equal(field('editor-modifier-0-miterInner').props.value, 'sharp')
  field('editor-modifier-0-miterInner').props.onChange({ target: { value: 'arc' } })
  assert.equal(editor.buildPatch(editor.draftFor(store.getState())).operations[0].modifiers[0].miterInner, 'arc')
})

test('invalid bevel inner corner values are rejected locally without posting an edit', async t => {
  const spec = source('metal-lamp'); spec.entities.find(entity => entity.id === 'shade-shell').modifiers = [{ type: 'bevel', width: .001 }]
  const { store, calls } = await client(t, spec)
  for (const value of ['smooth', 'ARC', '', null]) {
    store.actions.updateEditor('modifiers', [0, 'miterInner'], value)
    assert.match(editor.errors(editor.draftFor(store.getState())).join(' '), /miterInner/)
    await store.actions.applyEditor()
  }
  assert.equal(calls.length, 0)
})

test('local material changes clone the complete anisotropic textured definition with alpha', () => {
  const { spec, draft } = make()
  draft.material.definition.parameters.baseColor = [.1, .2, .3, .6]
  draft.material.definition.parameters.roughness = .31
  const { patch, next } = apply(spec, draft)
  assert.deepEqual(patch.operations.map(o => o.op), ['material.add', 'entity.material.set'])
  const original = spec.materials.find(m => m.id === draft.material.id), added = next.materials.find(m => m.id === draft.cloneId)
  assert.deepEqual(added.texture, original.texture); assert.deepEqual(added.tangent, original.tangent)
  assert.equal(added.parameters.anisotropic, original.parameters.anisotropic); assert.equal(added.parameters.baseColor[3], .6)
  assert.deepEqual(next.materials.find(m => m.id === original.id), original)
  assert.deepEqual(next.entities.slice(1), spec.entities.slice(1)); assert.equal(next.entities[0].materialId, draft.cloneId)
})

test('local cloning preserves image channels that are not being edited; image-driven controls reject edits', () => {
  const { draft } = make()
  const images = { normal: { assetId: 'normal-map', uvMap: 'UVMap' }, baseColor: { assetId: 'color-map', uvMap: 'UVMap' } }
  draft.materials.find(m => m.id === draft.material.id).definition.images = plain(images)
  draft.material.definition.images = plain(images)
  draft.material.definition.parameters.roughness = .31
  const patch = plain(editor.buildPatch(draft))
  assert.deepEqual(patch.operations[0].material.images, images)
  draft.material.definition.parameters.baseColor = [.1, .2, .3, 1]
  assert.throws(() => editor.buildPatch(draft), /baseColor/)
})

test('shared edits update named parameters without cloning or rebinding', () => {
  const { spec, draft } = make(); draft.material.scope = 'shared'; draft.material.definition.parameters.roughness = .31
  const { patch, next } = apply(spec, draft)
  assert.deepEqual(patch.operations, [{ op: 'material.parameter.update', materialId: draft.material.id, parameter: 'roughness', value: .31 }])
  assert.deepEqual(next.entities, spec.entities)
})

test('animated transforms and local cloning of any animated material cannot silently discard motion', () => {
  const { draft } = make(); draft.tracks.push({ targetKind: 'entity', targetId: draft.entityId, property: 'location.x' })
  draft.entity.transform.location[0] += .01; assert.throws(() => editor.buildPatch(draft), /location.x/)
  draft.entity.transform.location[0] = draft.original.transform.location[0]
  draft.tracks.push({ targetKind: 'material', targetId: draft.material.id, property: 'metallic' })
  draft.material.definition.parameters.roughness = .31
  assert.throws(() => editor.buildPatch(draft), /roughness/)
  draft.material.scope = 'shared'; assert.equal(editor.buildPatch(draft).operations[0].op, 'material.parameter.update')
  draft.tracks.push({ targetKind: 'material', targetId: draft.material.id, property: 'roughness' })
  assert.throws(() => editor.buildPatch(draft), /roughness/)
})

function assetDraft() {
  const { draft } = make(); draft.original.kind = draft.entity.kind = 'asset-instance'
  draft.original.generator = draft.entity.generator = null
  draft.original.assetParts = [
    { partId: '/Root/Body', sourceMaterialSlots: [{ index: 0, materialName: 'Original 0' }, { index: 1, materialName: 'Original 1' }], materialSlots: [{ index: 0, materialId: draft.material.id }] },
    { partId: '/Root/Empty', sourceMaterialSlots: [], materialSlots: [{ index: 0, materialId: draft.material.id }] },
  ]
  draft.original.materialBindings = draft.entity.materialBindings = [{ partId: '/Root/Empty', materialId: draft.material.id }]
  draft.material.target = 'slot'; draft.material.partId = '/Root/Body'; draft.material.slotIndex = '1'
  draft.material.definition.parameters.roughness = .31
  return draft
}

test('asset slot edits use original inventory, preserve other bindings and explicit whole-part priority', () => {
  const draft = assetDraft(), patch = plain(editor.buildPatch(draft))
  const operation = patch.operations.at(-1)
  assert.equal(validateScenePatch(patch).ok, true, validateScenePatch(patch).summary)
  assert.equal(operation.op, 'entity.materialBindings.set')
  assert.deepEqual(operation.materialBindings, [{ partId: '/Root/Empty', materialId: draft.material.id }, { partId: '/Root/Body', slotIndex: 1, materialId: draft.cloneId }])
  draft.material.target = 'part'
  assert.deepEqual(plain(editor.buildPatch(draft)).operations.at(-1).materialBindings.at(-1), { partId: '/Root/Body', materialId: draft.cloneId })
  draft.material.target = 'entity'; assert.equal(editor.buildPatch(draft).operations.at(-1).op, 'entity.material.set')
})

test('empty selector, absent part, generated current slot and ambiguous asset stack cannot be edited', () => {
  const draft = assetDraft(); draft.material.slotIndex = ''; assert.throws(() => editor.buildPatch(draft), /slotIndex/)
  draft.material.slotIndex = '0'; draft.material.partId = '/Root/Empty'; assert.throws(() => editor.buildPatch(draft), /slotIndex/)
  draft.material.partId = 'missing'; assert.throws(() => editor.buildPatch(draft), /partId/)
  draft.material.target = 'entity'; draft.entity.modifiers = [{ type: 'bevel', width: .001 }]
  assert.throws(() => editor.buildPatch(draft), /modifiers/)
})

test('invalid finite values, excessive stacks and invalid array offsets never build a patch', () => {
  const { draft } = make(); draft.entity.transform.location[0] = null; assert.throws(() => editor.buildPatch(draft), /location.x/)
  draft.entity.transform.location[0] = 0; draft.entity.modifiers = [{ type: 'array', count: 65, offset: [0, 0, 0] }]
  assert.throws(() => editor.buildPatch(draft), /modifiers/)
  draft.entity.modifiers = Array.from({ length: 9 }, () => ({ type: 'bevel', width: .001 }))
  assert.throws(() => editor.buildPatch(draft), /modifiers/)
})

test('comparison snapshots select matching single-frame artifacts and ignore mismatched candidates', () => {
  const before = artifact('r0001'), after = artifact('r0002')
  const pair = editor.previewPair({ before: 'r0001', after: 'r0002', beforePreviews: [before, { ...before, frame: 24 }], afterPreviews: [after] })
  assert.equal(pair.reason, null); assert.equal(pair.beforeArtifact.frame, 1); assert.equal(pair.afterArtifact.sha256, after.sha256)
  before.sha256 = 'mutated'; assert.notEqual(pair.beforeArtifact.sha256, 'mutated')
  for (const change of [{ frame: 24 }, { cameraId: 'reverse' }, { renderConfig: { ...config, samples: 32 } }, { renderConfig: null }]) {
    const mismatch = editor.previewPair({ before: 'r0001', after: 'r0002', beforePreviews: [artifact('r0001', change)], afterPreviews: [after] })
    assert.equal(mismatch.beforeArtifact, null); assert.equal(mismatch.reason, 'no-matching-baseline')
  }
  assert.equal(editor.previewPair({ before: 'r0001', after: 'r0002', beforePreviews: [], afterPreviews: [artifact('r0002', { renderConfig: null })] }).reason, 'unknown-settings')
})

test('real UI handlers use mm/degrees, initialize RGB color correctly and submit only on apply', async t => {
  const { store, field, calls } = await client(t)
  assert.match(field('editor-material-color').props.value, /^#[0-9a-f]{6}$/)
  assert.notEqual(field('editor-material-color').props.value, '#000000')
  field('editor-location-x').props.onChange({ target: { value: '8' } })
  field('editor-rotation-z').props.onChange({ target: { value: '30' } })
  field('editor-material-color').props.onChange({ target: { value: '#597c86' } })
  const draft = editor.draftFor(store.getState())
  assert.equal(draft.entity.transform.location[0], .008); assert.ok(Math.abs(draft.entity.transform.rotationEuler[2] - Math.PI / 6) < 1e-12)
  assert.equal(draft.material.definition.parameters.baseColor[3], 1); assert.equal(calls.length, 0)
  await store.actions.applyEditor(); assert.equal(calls.length, 1); assert.equal(calls[0].body.patch.renderPreview, true)
})

test('profile, path and all modifier controls are present; reordering retains original full definitions', async t => {
  const { store, field, nodes } = await client(t)
  assert.ok(field('editor-generator-profile-0-0'))
  for (const type of ['bevel', 'solidify', 'array', 'mirror', 'boolean']) store.actions.editEditorList('modifiers', 0, 'add', type)
  for (const id of ['editor-modifier-0-angle', 'editor-modifier-1-thickness', 'editor-modifier-2-count', 'editor-modifier-2-offset-x', 'editor-modifier-3-merge', 'editor-modifier-4-targetEntityId']) assert.ok(field(id), id)
  const before = plain(editor.draftFor(store.getState()).entity.modifiers)
  store.actions.editEditorList('modifiers', 2, 'up')
  assert.deepEqual(plain(editor.draftFor(store.getState()).entity.modifiers), [before[0], before[2], before[1], before[3], before[4]])
  store.actions.selectEditorEntity('fabric-power-cable'); assert.ok(field('editor-generator-path-0-2'))
  assert.ok(nodes().some(n => n.tag === 'details' && !n.props.open))
})

test('polling preserves dirty inputs, marks conflicts and refuses to submit against an old revision', async t => {
  const { store, projects, calls, nodes } = await client(t)
  store.actions.updateEditor('material', ['definition', 'parameters', 'roughness'], .31)
  projects['project-a'].revision = 'r0002'; projects['project-a'].spec.materials.find(m => m.id === 'champagne-spun').parameters.roughness = .33
  store.actions.reload(); await waitFor(store, s => s.currentRevision === 'r0002')
  assert.equal(editor.draftFor(store.getState()).material.definition.parameters.roughness, .31)
  assert.equal(nodes().find(n => n.props['data-scene-editor']).props['data-editor-conflict'], 'true')
  await store.actions.applyEditor(); assert.equal(calls.length, 0)
  store.actions.resetEditor(); assert.equal(editor.draftFor(store.getState()).baseRevision, 'r0002')
  assert.equal(editor.draftFor(store.getState()).material.definition.parameters.roughness, .33)
  assert.equal(nodes().find(n => n.props['data-scene-editor']).props['data-editor-dirty'], 'false')
})

test('project switches isolate drafts and recover the previous project input without posting', async t => {
  const { store, calls } = await client(t)
  store.actions.updateEditor('transform', ['location', 0], .008)
  store.actions.selectProject('project-b'); await waitFor(store, s => s.activeProjectId === 'project-b'); store.actions.selectEditorEntity('shade-shell')
  assert.notEqual(editor.draftFor(store.getState()).entity.transform.location[0], .008)
  store.actions.selectProject('project-a'); await waitFor(store, s => s.activeProjectId === 'project-a'); store.actions.selectEditorEntity('shade-shell')
  assert.equal(editor.draftFor(store.getState()).entity.transform.location[0], .008); assert.equal(calls.length, 0)
})

test('rejected requests preserve draft inputs and the same local clone identity for retry', async t => {
  const { store, fail, calls } = await client(t)
  store.actions.updateEditor('material', ['definition', 'parameters', 'roughness'], .31)
  const before = plain(editor.draftFor(store.getState())); fail({ code: 'SCENE_VALIDATION_FAILED', message: 'Controlled rejection' })
  await store.actions.applyEditor(); await store.actions.applyEditor()
  assert.deepEqual(plain(editor.draftFor(store.getState())), before)
  assert.equal(calls[0].body.patch.operations[0].material.id, calls[1].body.patch.operations[0].material.id)
})

test('commit compares base-to-new artifacts, resolves missing response preview metadata from manifest, and restores conditionally', async t => {
  const { store, calls, nodes } = await client(t, source('metal-lamp'), { omitResponsePreviews: true })
  store.actions.updateEditor('transform', ['location', 0], .008); await store.actions.applyEditor()
  await waitFor(store, s => s.currentRevision === 'r0002' && s.editorComparison?.resolved)
  const state = store.getState(); assert.equal(state.compareLeft, 'r0001'); assert.equal(state.compareRight, 'r0002')
  assert.equal(state.editorComparison.beforeArtifact.path, artifact('r0001').path)
  assert.equal(state.editorComparison.afterArtifact.sha256, artifact('r0002').sha256)
  assert.deepEqual(nodes().filter(n => n.tag === 'img').map(n => n.props['data-artifact']), [artifact('r0001').path, artifact('r0002').path])
  await store.actions.restoreEditor(); await waitFor(store, s => s.currentRevision === 'r0001')
  assert.deepEqual(calls.at(-1).body, { revision: 'r0001', expectedCurrentRevision: 'r0002' })
  store.actions.selectEditorEntity('shade-shell'); assert.equal(editor.draftFor(store.getState()).baseRevision, 'r0001')
})

test('editor comparison never substitutes a contact sheet when the matching baseline is absent', async t => {
  const { store, previews, nodes } = await client(t)
  previews['project-a'][0].previews[0].frame = 24
  store.actions.reload(); await new Promise(resolve => setTimeout(resolve, 10))
  store.actions.updateEditor('transform', ['location', 0], .008); await store.actions.applyEditor()
  await waitFor(store, s => s.editorComparison?.resolved)
  assert.equal(store.getState().editorComparison.beforeArtifact, null)
  assert.deepEqual(nodes().filter(n => n.tag === 'img').map(n => n.props['data-artifact']), [artifact('r0002').path])
})

test('material animation and animated transform guards also apply in actual store handlers', async t => {
  const spec = source('metal-lamp')
  spec.animationTracks.push({ id: 'metal-change', targetKind: 'material', targetEntityId: 'champagne-spun', property: 'metallic', keyframes: [{ frame: 1, value: 1 }, { frame: 48, value: .5 }] })
  spec.animationTracks.push({ id: 'shade-move', targetKind: 'entity', targetEntityId: 'shade-shell', property: 'location.x', keyframes: [{ frame: 1, value: 0 }, { frame: 48, value: .1 }] })
  assert.equal(validateSceneSpec(spec).ok, true, validateSceneSpec(spec).summary)
  const { store, field } = await client(t, spec)
  assert.equal(field('editor-material-roughness').props.disabled, true); assert.equal(field('editor-location-x').props.disabled, true)
  const original = editor.draftFor(store.getState()).material.definition.parameters.roughness
  store.actions.updateEditor('material', ['definition', 'parameters', 'roughness'], .31)
  assert.equal(editor.draftFor(store.getState()).material.definition.parameters.roughness, original)
  store.actions.updateEditor('material', ['scope'], 'shared')
  assert.equal(field('editor-material-roughness').props.disabled, false)
  store.actions.updateEditor('material', ['definition', 'parameters', 'roughness'], .31)
  assert.equal(editor.buildPatch(editor.draftFor(store.getState())).operations[0].op, 'material.parameter.update')
})


test('optional generator defaults remain absent and do not block an unrelated edit', async t => {
  const spec = source('metal-lamp'), target = spec.entities[0]
  target.generator = { shape: 'cube', bevel: {} }
  const compiled = compileSceneSpec(spec).spec
  const { store, field, calls } = await client(t, compiled)
  assert.equal(field('editor-generator-size').props.value, 2000)
  assert.equal(field('editor-generator-bevel-width').props.value, 10)
  assert.equal(field('editor-generator-bevel-segments').props.value, 3)
  store.actions.updateEditor('transform', ['location', 0], .005)
  await store.actions.applyEditor()
  assert.deepEqual(calls[0].body.patch.operations.map(operation => operation.op), ['entity.transform.update'])
  assert.deepEqual(compiled.entities[0].generator.bevel, {})
})

test('rounded boxes retain their intrinsic bevel and expose local size with preserved scale', async t => {
  const spec = source('metal-lamp'); spec.entities[0].generator = { shape: 'rounded_box', size: .2, bevel: { width: .002 } }
  spec.entities[0].transform.scale = [2, 3, 4]
  const { store, field, nodes } = await client(t, compileSceneSpec(spec).spec)
  assert.equal(field('editor-generator-bevel').props.disabled, true)
  store.actions.updateEditor('generator', ['bevel'], undefined)
  assert.equal(editor.draftFor(store.getState()).entity.generator.bevel.width, .002)
  assert.ok(JSON.stringify(nodes()).includes('2 × 3 × 4'))
})

test('mixed native and public material slots do not masquerade as one uniform part material', async t => {
  const { store } = await client(t)
  const current = editor.draftFor(store.getState())
  // Use the same server-projected shape the asset inventory supplies.
  current.original.kind = current.entity.kind = 'asset-instance'
  delete current.original.materialId; delete current.entity.materialId
  current.original.assetParts = [{ partId: '/Mixed', sourceMaterialSlots: [{ index: 0 }, { index: 1 }],
    materialSlots: [{ index: 0, materialId: null }, { index: 1, materialId: 'champagne-spun' }] }]
  current.original.materialBindings = [{ partId: '/Mixed', slotIndex: 1, materialId: 'champagne-spun' }]
  store.actions.updateEditor('material', ['target'], 'part'); store.actions.updateEditor('material', ['partId'], '/Mixed')
  assert.equal(editor.draftFor(store.getState()).material.id, '')
  store.actions.updateEditor('material', ['id'], 'champagne-spun')
  const patch = plain(editor.buildPatch(editor.draftFor(store.getState())))
  assert.deepEqual(patch.operations.at(-1).materialBindings, [{ partId: '/Mixed', slotIndex: 1, materialId: 'champagne-spun' }, { partId: '/Mixed', materialId: 'champagne-spun' }])
})

test('unknown samples, invalid pixel dimensions and inconsistent observed render metadata cannot compare', () => {
  for (const change of [{ samples: null, renderConfig: { ...config, samples: null } }, { width: 321 }, { height: null }, { engine: null }, { renderConfig: { ...config, resolutionPercentage: 50 } }]) {
    const pair = editor.previewPair({ before: 'r0001', after: 'r0002', beforePreviews: [artifact('r0001', change)], afterPreviews: [artifact('r0002', change)] })
    assert.equal(pair.beforeArtifact, null); assert.equal(pair.reason, 'unknown-settings')
  }
  const half = { width: 160, height: 120, renderConfig: { ...config, resolutionPercentage: 50 } }
  assert.equal(editor.previewPair({ before: 'r0001', after: 'r0002', beforePreviews: [artifact('r0001', half)], afterPreviews: [artifact('r0002', half)] }).reason, null)
})

test('ordinary history restore uses current revision CAS, rejects duplicate clicks and reports correct direction', async t => {
  let unblock
  const blocked = new Promise(resolve => { unblock = resolve })
  const { store, calls, projects } = await client(t, source('metal-lamp'), { onPost: () => blocked })
  projects['project-a'].revision = 'r0002'; store.actions.reload(); await waitFor(store, s => s.currentRevision === 'r0002')
  const first = store.actions.restoreRevision('r0001'); await store.actions.restoreRevision('r0001')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body, { revision: 'r0001', expectedCurrentRevision: 'r0002' })
  unblock(); await first; await waitFor(store, s => s.currentRevision === 'r0001')
  assert.match(store.getState().notices.revisions.message, /r0002.*r0001/)
})

test('a delayed history restore cannot publish its notice into another project', async t => {
  let unblock
  const blocked = new Promise(resolve => { unblock = resolve })
  const { store } = await client(t, source('metal-lamp'), { onPost: () => blocked })
  const pending = store.actions.restoreRevision('r0001')
  store.actions.selectProject('project-b'); await waitFor(store, s => s.activeProjectId === 'project-b')
  unblock(); await pending
  assert.equal(store.getState().notices.revisions, null)
  assert.equal(store.getState().activeProjectId, 'project-b')
})


test('standalone sets controlled select values after option construction; checkbox true and false remain distinct', () => {
  const order = []
  const doc = {
    createTextNode: text => ({ text }),
    createElement(tag) {
      const node = { tag, children: [], attrs: {}, style: {}, checked: false,
        appendChild(child) { this.children.push(child); order.push(`append:${tag}`) },
        setAttribute(key, value) { this.attrs[key] = value; if (key === 'checked') this.checked = true },
        addEventListener() {},
      }
      let value = ''
      Object.defineProperty(node, 'value', { get: () => value, set(next) {
        order.push(`value:${tag}`)
        value = tag === 'select' ? node.children.find(child => child.value === next)?.value || '' : next
      } })
      return node
    },
  }
  const select = core.toDom(core.el('select', { value: 'celadon-glaze' },
    core.el('option', { value: '' }, 'Keep current'), core.el('option', { value: 'celadon-glaze' }, 'Ceramic')), doc)
  assert.equal(select.value, 'celadon-glaze')
  assert.ok(order.lastIndexOf('value:select') > order.lastIndexOf('append:select'))
  assert.equal(core.toDom(core.el('input', { type: 'checkbox', checked: true }), doc).checked, true)
  assert.equal(core.toDom(core.el('input', { type: 'checkbox', checked: false }), doc).checked, false)
})


function lifecycleDocument() {
  const walk = node => [node, ...(node.children || []).flatMap(walk)]
  const doc = { body: {}, activeElement: null,
    querySelector: () => null, createTextNode: text => ({ text }),
    createElement(tag) {
      return { tag, ownerDocument: doc, children: [], attrs: {}, dataset: {}, style: {}, listeners: {}, open: false,
        classList: { add() {} },
        setAttribute(key, value) { this.attrs[key] = value; if (key === 'open') this.open = true; if (key.startsWith('data-')) this.dataset[key.slice(5)] = value },
        addEventListener(key, handler) { this.listeners[key] = handler },
        appendChild(child) { this.children.push(child) },
        replaceChildren(...children) { this.children = children },
        querySelector(selector) { const field = selector.match(/data-field="([^"]+)"/)?.[1]; return walk(this).find(node => node.attrs?.['data-field'] === field) || null },
        focus() { doc.activeElement = this },
      }
    },
  }
  doc.activeElement = doc.body; doc.head = doc.createElement('head')
  const root = doc.createElement('main')
  return { root, all: () => walk(root) }
}

test('standalone disclosure state survives actual input and polling redraws, and stays isolated by project and object', async t => {
  const { root, all } = lifecycleDocument()
  const { store } = await client(t, source('metal-lamp'), { root })
  const details = suffix => all().find(node => node.tag === 'details' && node.attrs['data-disclosure']?.includes(suffix))
  const field = name => all().find(node => node.attrs?.['data-field'] === name)
  const original = details('advanced-patch'); assert.equal(original.open, false)
  original.open = true; original.listeners.toggle({ currentTarget: original })
  assert.equal(details('advanced-patch').open, true)
  const textarea = field('scene-patch'); textarea.listeners.input({ target: { value: '{"test": "draft"}' } })
  assert.notEqual(details('advanced-patch'), original, 'the DOM was actually rebuilt')
  assert.equal(details('advanced-patch').open, true); assert.equal(field('scene-patch').value, '{"test": "draft"}')
  let before = details('advanced-patch'); store.actions.reload()
  await waitFor(store, () => details('advanced-patch') !== before)
  assert.equal(details('advanced-patch').open, true)
  const stack = details('modifiers'); assert.equal(stack.open, true)
  stack.open = false; stack.listeners.toggle({ currentTarget: stack })
  store.actions.updateEditor('transform', ['location', 0], .002)
  assert.equal(details('modifiers').open, false)
  store.actions.selectEditorEntity('weighted-base'); assert.equal(details('modifiers').open, true)
  store.actions.selectEditorEntity('shade-shell'); assert.equal(details('modifiers').open, false)
  store.actions.selectProject('project-b'); await waitFor(store, state => state.activeProjectId === 'project-b')
  store.actions.selectEditorEntity('shade-shell')
  assert.equal(details('advanced-patch').open, false); assert.equal(details('modifiers').open, true)
  store.actions.selectProject('project-a'); await waitFor(store, state => state.activeProjectId === 'project-a')
  store.actions.selectEditorEntity('shade-shell')
  assert.equal(details('advanced-patch').open, true); assert.equal(details('modifiers').open, false)
  let redraws = 0; const unsubscribe = store.subscribe(() => { redraws += 1 })
  const stable = details('advanced-patch'); stable.listeners.toggle({ currentTarget: stable }); unsubscribe()
  assert.equal(redraws, 0, 'a toggle emitted by controlled initial rendering does not create a redraw loop')
})

test('surface texture edits clone the full local material and preserve every unrelated definition', () => {
  const {spec,draft}=make(), before=plain(spec)
  draft.material.definition.texture={...draft.material.definition.texture,coordinates:'uv',uvMap:'UVMap',stretch:[.0002,640,1],scale:1,bump:.009}
  assert.equal(editor.dirty(draft),true)
  const {patch,next}=apply(spec,draft)
  assert.deepEqual(patch.operations.map(o=>o.op),['material.add','entity.material.set'])
  assert.deepEqual(next.materials.find(m=>m.id===draft.cloneId),{...plain(draft.material.definition),id:draft.cloneId})
  for(const material of before.materials)assert.deepEqual(next.materials.find(m=>m.id===material.id),material)
  assert.deepEqual(next.entities.slice(1),before.entities.slice(1));assert.deepEqual(next.lights,before.lights);assert.deepEqual(next.cameras,before.cameras)
  assert.deepEqual(spec,before)
})

test('shared surface texture changes and removal use complete texture operations without rebinding', () => {
  for(const texture of [{type:'wave',coordinates:'uv',scale:35,stretch:[1,4,1],distortion:2},undefined]) {
    const {spec,draft}=make();draft.material.scope='shared'
    if(texture===undefined)delete draft.material.definition.texture;else draft.material.definition.texture=plain(texture)
    const {patch,next}=apply(spec,draft)
    assert.deepEqual(patch.operations,[{op:'material.texture.set',materialId:draft.material.id,texture:texture??null}])
    assert.deepEqual(next.entities,spec.entities)
    assert.deepEqual(next.materials.find(m=>m.id===draft.material.id).texture,texture)
  }
})

test('surface texture edits compose with parameter changes and original imported slot bindings', () => {
  const draft=assetDraft();draft.material.definition.texture.bump=.07
  const patch=plain(editor.buildPatch(draft))
  assert.deepEqual(patch.operations.map(o=>o.op),['material.add','entity.materialBindings.set'])
  assert.equal(patch.operations[0].material.texture.bump,.07)
  assert.equal(patch.operations[0].material.parameters.roughness,.31)
  assert.deepEqual(patch.operations[1].materialBindings,[{partId:'/Root/Empty',materialId:draft.material.id},{partId:'/Root/Body',slotIndex:1,materialId:draft.cloneId}])
  draft.material.scope='shared'
  assert.deepEqual(plain(editor.buildPatch(draft)).operations.map(o=>o.op),['material.parameter.update','material.texture.set'])
})

test('surface texture validation rejects bad patterns, coordinates, names, bounds and malformed arrays', () => {
  for(const texture of [null,[],{type:'wood',scale:1},{type:'noise',scale:0},{type:'noise',scale:Infinity},{type:'noise',scale:1,coordinates:'camera'},
    {type:'noise',scale:1,uvMap:'UVMap'},{type:'noise',scale:1,coordinates:'uv',uvMap:' '},{type:'noise',scale:1,coordinates:'uv',uvMap:1},
    {type:'noise',scale:1,stretch:[1,0,1]},{type:'noise',scale:1,stretch:[1,1]}, {type:'noise',scale:1,stretch:'bad'},
    {type:'noise',scale:1,detail:17},{type:'noise',scale:1,distortion:-1},{type:'noise',scale:1,bump:1.1},
    {type:'noise',scale:1,roughnessVariation:-.1},{type:'noise',scale:1,colorVariation:null},{type:'noise',scale:1,unknown:1}]) {
    const {draft}=make();draft.material.definition.texture=texture
    assert.throws(()=>editor.buildPatch(draft),/texture/)
  }
})

test('procedural texture edits refuse image materials and local animated clones; shared undriven texture is editable', () => {
  for(const kind of ['images','emission','animation']) {
    const {draft}=make()
    if(kind==='images')draft.material.definition.images={normal:{assetId:'image'}}
    if(kind==='emission')draft.material.definition.shader='emission'
    if(kind==='animation')draft.tracks.push({targetKind:'material',targetId:draft.material.id,property:'metallic'})
    draft.material.definition.texture.bump=.07
    assert.throws(()=>editor.buildPatch(draft),/texture/)
    if(kind==='animation') {draft.material.scope='shared';assert.equal(editor.buildPatch(draft).operations[0].op,'material.texture.set')}
  }
})

test('texture controls preserve omitted defaults, optional names and untouched fields through actual event handlers', async t => {
  const spec=source('metal-lamp');spec.materials.find(m=>m.id==='champagne-spun').texture={type:'noise',scale:20}
  const {field,store,calls}=await client(t,spec)
  const draft=()=>editor.draftFor(store.getState())
  assert.equal(field('editor-texture-coordinates').props.value,'object')
  assert.equal(field('editor-texture-stretch-x').props.value,1)
  assert.equal(field('editor-texture-bump').props.value,'')
  assert.deepEqual(plain(editor.buildPatch(draft()).operations),[])
  field('editor-texture-coordinates').props.onChange({target:{value:'uv'}})
  field('editor-texture-uvMap').props.onChange({target:{value:'UV Map '}})
  field('editor-texture-stretch-y').props.onChange({target:{value:'800'}})
  field('editor-texture-bump').props.onChange({target:{value:'0.006'}})
  assert.deepEqual(plain(draft().material.definition.texture),{type:'noise',scale:20,coordinates:'uv',uvMap:'UV Map ',stretch:[1,800,1],bump:.006})
  field('editor-texture-uvMap').props.onChange({target:{value:''}})
  assert.equal(Object.hasOwn(draft().material.definition.texture,'uvMap'),false)
  field('editor-texture-bump').props.onChange({target:{value:''}})
  assert.equal(Object.hasOwn(draft().material.definition.texture,'bump'),false)
  field('editor-texture-uvMap').props.onChange({target:{value:'UVMap'}})
  field('editor-texture-coordinates').props.onChange({target:{value:'object'}})
  assert.equal(Object.hasOwn(draft().material.definition.texture,'uvMap'),false)
  field('editor-texture-type').props.onChange({target:{value:'voronoi'}})
  assert.deepEqual(plain(draft().material.definition.texture),{type:'voronoi',scale:20,coordinates:'object',stretch:[1,800,1]})
  assert.equal(calls.length,0)
  field('editor-texture-type').props.onChange({target:{value:''}})
  assert.equal(Object.hasOwn(draft().material.definition,'texture'),false)
  field('editor-texture-type').props.onChange({target:{value:'wave'}})
  assert.deepEqual(plain(draft().material.definition.texture),{type:'wave',scale:20,bump:.01})
})

test('texture controls lock image replacement and recover an editable shared animated surface', async t => {
  const {field,store,calls,nodes}=await client(t)
  const draft=editor.draftFor(store.getState());draft.tracks.push({targetKind:'material',targetId:draft.material.id,property:'metallic'})
  assert.equal(nodes().find(n=>n.props['data-texture-editor']).props.disabled,true)
  const before=plain(draft.material.definition.texture)
  field('editor-texture-bump').props.onChange({target:{value:'0.8'}})
  assert.deepEqual(plain(editor.draftFor(store.getState()).material.definition.texture),before)
  field('editor-material-scope').props.onChange({target:{value:'shared'}})
  assert.equal(nodes().find(n=>n.props['data-texture-editor']).props.disabled,false)
  field('editor-texture-bump').props.onChange({target:{value:'0.8'}})
  assert.equal(editor.draftFor(store.getState()).material.definition.texture.bump,.8)
  editor.draftFor(store.getState()).material.definition.images={normal:{assetId:'map'}}
  assert.equal(nodes().find(n=>n.props['data-texture-editor']).props.disabled,true)
  assert.equal(calls.length,0)
})

test('surface texture drafts survive a native refusal and submit the correction against the unchanged revision', async t => {
  const {field,store,calls,fail,projects}=await client(t)
  field('editor-texture-coordinates').props.onChange({target:{value:'uv'}})
  field('editor-texture-uvMap').props.onChange({target:{value:'missing-map'}})
  field('editor-texture-scale').props.onChange({target:{value:'2'}})
  fail({code:'SCENE_VALIDATION_FAILED',message:'Missing UV map missing-map'})
  await store.actions.applyEditor()
  assert.equal(store.getState().currentRevision,'r0001')
  assert.equal(field('editor-texture-uvMap').props.value,'missing-map')
  assert.equal(editor.dirty(editor.draftFor(store.getState())),true)
  field('editor-texture-uvMap').props.onChange({target:{value:'UVMap'}});fail(null)
  await store.actions.applyEditor();await waitFor(store,s=>s.currentRevision==='r0002')
  assert.equal(calls.length,2);assert.equal(calls[1].body.patch.baseRevision,'r0001')
  const saved=projects['project-a'].spec;assert.equal(saved.materials.find(m=>m.id===saved.entities.find(e=>e.id==='shade-shell').materialId).texture.uvMap,'UVMap')
  assert.equal(editor.dirty(editor.draftFor(store.getState())),false)
})
