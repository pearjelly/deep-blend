/** Photography edits are lossless, revision-bound saves followed by an independent inspection. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileSceneSpec, buildSceneTree, applyPatchToSpec, validateScenePatch, validateSceneSpec, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const plain = value => JSON.parse(JSON.stringify(value))
const core = loadClientBundle().exports.workbench, editor = core.photographyEditor
const source = (name = 'glazed-cup') => compileSceneSpec(JSON.parse(readFileSync(new URL(`../../recipes/${name}/scene-spec.json`, import.meta.url)))).spec
const tree = (spec, revision = 'r0001') => buildSceneTree(spec, { revision, digest: revision.repeat(8) })
const make = (spec = source()) => ({ spec, draft: editor.createDraft(tree(spec), 'one') })
const flatten = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flatten)] : []
function apply(spec, draft) {
  const patch = plain(editor.buildPatch(draft)), validation = validateScenePatch(patch)
  assert.equal(validation.ok, true, validation.summary)
  const next = applyPatchToSpec(spec, patch).spec, checked = validateSceneSpec(next)
  assert.equal(checked.ok, true, checked.summary)
  return { patch, next }
}
const waitFor = async (store, predicate) => {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('client did not settle')) }, 2000)
    const unsubscribe = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); unsubscribe(); resolve() } })
  })
}
async function client(t, options = {}) {
  const spec = options.spec || source(), projects = { one: { spec, revision: 'r0001' }, two: { spec: plain(spec), revision: 'r0001' } }
  const calls = [], reads = []; let patchFailure, previewFailure, restoreFailure
  const settings = { pollIdleMs: 100000, fetch: async (url, init = {}) => {
    const path = new URL(url, 'http://localhost'), projectId = path.pathname.match(/projects\/([^/]+)/)?.[1] || path.searchParams.get('projectId') || 'one', project = projects[projectId]
    let payload
    if (init.method === 'POST') {
      const body = JSON.parse(init.body), route = path.pathname.split('/').at(-1); calls.push({ route, projectId, body })
      if (options.onPost) await options.onPost({ route, body, signal: init.signal })
      if (route === 'patch') {
        if (patchFailure) payload = { ok: false, error: patchFailure }
        else {
          assert.equal(body.patch.baseRevision, project.revision)
          assert.equal(validateScenePatch(body.patch).ok, true, validateScenePatch(body.patch).summary)
          project.spec = applyPatchToSpec(project.spec, body.patch).spec; project.revision = 'r0002'
          payload = { ok: true, revision: { revision: project.revision, digest: 'saved-digest' } }
        }
      } else if (route === 'preview') {
        if (previewFailure) payload = { ok: false, error: previewFailure }
        else payload = { ok: true, preview: { revision: body.revision, sourceRevision: body.revision, sourceDigest: 'saved-digest', mode: body.mode,
          artifacts: [{ kind: 'diagnostic', mode: body.mode, sourceRevision: body.revision, cameraId: body.views[0].cameraId, frame: body.views[0].frame,
            mime: 'image/png', path: `revisions/${body.revision}/inspection.png`, sha256: 'a'.repeat(64) }] } }
        if (options.mutatePreview && payload.ok) options.mutatePreview(payload.preview)
      } else if (route === 'restore') {
        if (restoreFailure) payload = { ok: false, error: restoreFailure }
        else { assert.equal(body.expectedCurrentRevision, project.revision); project.revision = body.revision; payload = { ok: true, revision: { revision: body.revision } } }
      }
    } else if (path.pathname.endsWith('/revisions')) {
      payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.revisions', projectId, currentRevision: project.revision,
        revisions: Object.keys(options.histories?.[projectId] || { [project.revision]: project.spec }).map(revision => ({ revision, digest: 'a'.repeat(64) })) }
    } else if (path.pathname.endsWith('/scene')) {
      const revision = path.searchParams.get('revision'), saved = options.histories?.[projectId]?.[revision] || project.spec
      const scene = tree({ ...saved, project: { ...saved.project, id: projectId } }, revision); scene.digest = 'a'.repeat(64)
      payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.scene', projectId, revision, digest: scene.digest, scene }
    } else if (path.pathname.endsWith('/jobs')) payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (path.pathname.endsWith('/previews')) payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.previews', artifactBase: `/deepblend/artifacts/${projectId}/`, previews: { projectId, revisions: [] } }
    else payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'state', cameraTargetResetSupported: options.legacy !== true, projectsRoot: typeof options.root === 'function' ? options.root() : null, projects: Object.keys(projects).map(projectId => ({ projectId })),
      selected: { project: { projectId, title: projectId }, currentRevision: project.revision, scene: tree(project.spec, project.revision), jobs: [], unfinishedJobs: [] } }
    if (init.method !== 'POST') { reads.push({ url: String(url), projectId }); if (options.onRead) await options.onRead({ path, payload, signal: init.signal }) }
    return { ok: payload.ok, status: payload.ok ? 200 : 409, text: async () => JSON.stringify(payload), json: async () => payload }
  } }
  const store = core.createWorkbenchStore(settings); t.after(() => store.stop()); store.start(); await waitFor(store, state => state.status === 'ok'); store.actions.setView('scene')
  const nodes = () => flatten(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = key => nodes().find(node => node.props['data-field'] === `photo-${key}`)
  const action = key => nodes().find(node => node.props['data-action'] === `photo-${key}`)
  return { store, calls, reads, projects, nodes, field, action, draft: () => editor.draftFor(store.getState()), fail: (kind, value) => {
    if (kind === 'patch') patchFailure = value; if (kind === 'preview') previewFailure = value; if (kind === 'restore') restoreFailure = value
  } }
}

test('scene projection and drafts retain complete independent camera and light definitions', () => {
  const spec = source(), original = plain(spec)
  spec.cameras[0].targetPoint = [.07, -.08, .09]; delete spec.cameras[0].targetEntityId
  Object.assign(spec.cameras[0], { sensorWidth: 45, clipping: [.003, 850], fStop: 2.3 })
  Object.assign(spec.lights[0], { spotSize: 1.2, spotBlend: .8, angle: .04, color: [.4, .5, .6, .7] })
  const scene = tree(spec), draft = editor.createDraft(scene, 'one')
  assert.deepEqual(plain(scene.nodes.cameras[0].definition), spec.cameras[0]); assert.deepEqual(plain(scene.nodes.lights[0].definition), spec.lights[0])
  draft.cameras[0].lens = 83; draft.cameras[0].transform.location[0] += .12
  draft.lights[0].energy = 350; draft.lights[0].color[1] = .25; draft.lights[0].transform.rotationEuler[2] += .5
  const { patch, next } = apply(spec, draft)
  assert.deepEqual(patch.operations.map(item => item.op), ['camera.update', 'light.update'])
  assert.deepEqual(next.cameras[0], plain(draft.cameras[0])); assert.deepEqual(next.lights[0], plain(draft.lights[0]))
  for (const key of ['entities', 'materials', 'assets', 'project', 'animationTracks']) assert.deepEqual(next[key], original[key])
  assert.equal(spec.cameras[0].lens, original.cameras[0].lens); assert.equal(scene.nodes.lights[0].definition.color[1], .5)
  scene.nodes.cameras[0].definition.clipping[0] = .5; scene.nodes.lights[0].definition.color[0] = 0
  assert.equal(spec.cameras[0].clipping[0], .003); assert.equal(spec.lights[0].color[0], .4)
})

test('untouched recipes have no photography patch and omitted optional fields remain absent', () => {
  for (const name of ['glazed-cup', 'metal-lamp', 'glass-ceramic', 'modular-speaker']) {
    const { draft } = make(source(name)); assert.deepEqual(plain(editor.errors(draft)), []); assert.deepEqual(plain(editor.buildPatch(draft).operations), [])
    assert.equal(editor.dirty(draft), false)
  }
  const spec = source(); delete spec.lights[0].size; delete spec.lights[0].color
  const { draft } = make(spec); draft.cameras[0].lens += 1
  const { next } = apply(spec, draft); assert.equal(Object.hasOwn(next.lights[0], 'size'), false); assert.equal(Object.hasOwn(next.lights[0], 'color'), false)
})

test('actual camera target controls switch entity, point and free rotation without ignored inputs', async t => {
  const { store, field, draft } = await client(t)
  const camera = () => draft().cameras.find(camera => camera.id === draft().cameraId), oldRotation = plain(camera().transform.rotationEuler)
  assert.equal(field('camera-rotationEuler-x').props.disabled, true)
  store.actions.updatePhotography('camera', ['transform', 'rotationEuler', 0], 1)
  assert.deepEqual(plain(camera().transform.rotationEuler), oldRotation)
  field('camera-aim').props.onChange({ target: { value: 'point' } }); field('camera-targetPoint-z').props.onChange({ target: { value: '.4' } })
  assert.equal(camera().targetEntityId, undefined); assert.deepEqual(plain(camera().targetPoint), [0, 0, .4])
  let result = apply(source(), draft()); assert.equal(result.next.cameras.find(item => item.id === camera().id).targetEntityId, undefined)
  store.actions.updatePhotography('camera', ['aim'], 'free'); assert.equal(camera().targetPoint, undefined); assert.equal(editor.buildPatch(draft()).operations[0].clearTarget, true)
  field('camera-aim').props.onChange({ target: { value: 'entity' } }); field('camera-target').props.onChange({ target: { value: draft().entities.at(-1).id } })
  result = apply(source(), draft()); assert.equal(result.next.cameras.find(item => item.id === camera().id).targetPoint, undefined)
  assert.equal(result.next.cameras.find(item => item.id === camera().id).targetEntityId, draft().entities.at(-1).id)
})

test('free cameras accept degrees, and switching to a target discards an ignored draft rotation', async t => {
  const spec = source(); delete spec.cameras[0].targetEntityId; delete spec.cameras[0].targetPoint
  const { store, field, draft } = await client(t, { spec })
  store.actions.selectPhotography('camera', spec.cameras[0].id)
  field('camera-rotationEuler-z').props.onChange({ target: { value: '90' } })
  assert.equal(draft().cameras[0].transform.rotationEuler[2], Math.PI / 2)
  assert.equal(editor.buildPatch(draft()).operations[0].transform.rotationEuler[2], Math.PI / 2)
  field('camera-aim').props.onChange({ target: { value: 'point' } })
  assert.deepEqual(plain(draft().cameras[0].transform.rotationEuler), spec.cameras[0].transform.rotationEuler)
  assert.equal(editor.buildPatch(draft()).operations[0].transform, undefined)
})

test('animated camera axes and aim are guarded in UI, actions, and patch construction', async t => {
  const spec = source(), id = spec.cameras[0].id
  spec.animationTracks.push({ id: 'camera-slide', targetKind: 'camera', targetEntityId: id, property: 'location.x', keyframes: [{ frame: 1, value: 1 }, { frame: 48, value: 2 }] },
    { id: 'camera-rotate', targetKind: 'camera', targetEntityId: id, property: 'rotationEuler.z', keyframes: [{ frame: 1, value: 0 }, { frame: 48, value: 1 }] })
  const { store, field, draft } = await client(t, { spec }); store.actions.selectPhotography('camera', id)
  assert.equal(field('camera-location-x').props.disabled, true); assert.equal(field('camera-aim').props.disabled, true)
  const before = plain(draft().cameras[0]); store.actions.updatePhotography('camera', ['transform', 'location', 0], 40); store.actions.updatePhotography('camera', ['aim'], 'point')
  assert.deepEqual(plain(draft().cameras[0]), before)
  field('camera-location-y').props.onChange({ target: { value: '3' } }); assert.equal(draft().cameras[0].transform.location[1], 3)
  draft().cameras[0].transform.location[0] += 1; assert.throws(() => editor.buildPatch(draft()), /location.x/)
  draft().cameras[0].transform.location[0] = before.transform.location[0]; delete draft().cameras[0].targetEntityId; draft().cameras[0].targetPoint = [1, 2, 3]
  assert.throws(() => editor.buildPatch(draft()), /target/)
})

test('light controls retain type-specific fields and add an explicit area light in the same save', async t => {
  const spec = source(); Object.assign(spec.lights[0], { type: 'spot', spotSize: .8, spotBlend: .3, size: .17, color: [.2, .4, .6, .8] })
  const { store, field, calls, projects, draft } = await client(t, { spec }); store.actions.selectPhotography('light', spec.lights[0].id)
  field('light-energy').props.onChange({ target: { value: '275' } }); field('light-color-g').props.onChange({ target: { value: '.3' } })
  field('light-size').props.onChange({ target: { value: '.2' } }); field('light-rotationEuler-x').props.onChange({ target: { value: '30' } })
  store.actions.addPhotographyLight(); const added = plain(draft().lights.at(-1)); assert.equal(added.type, 'area'); assert.equal(calls.length, 0)
  await store.actions.savePhotography(); await waitFor(store, state => state.currentRevision === 'r0002')
  assert.deepEqual(calls.map(call => call.route), ['patch', 'preview']); assert.equal(calls[0].body.patch.renderPreview, false); assert.equal(calls[0].body.patch.saveCheckpoint, true)
  const saved = projects.one.spec.lights.find(light => light.id === spec.lights[0].id); assert.equal(saved.type, 'spot'); assert.equal(saved.spotSize, .8); assert.equal(saved.spotBlend, .3)
  assert.deepEqual(saved.color, [.2, .3, .6, .8]); assert.equal(saved.transform.rotationEuler[0], Math.PI / 6); assert.deepEqual(projects.one.spec.lights.find(light => light.id === added.id), added)
})

test('invalid inputs and target-overridden rotation do not create a request', async t => {
  const { store, calls, draft } = await client(t)
  for (const [kind, path, value] of [['camera', ['lens'], 0], ['light', ['energy'], -1], ['light', ['color', 0], 2], ['light', ['size'], 0], ['camera', ['transform', 'location', 0], null]]) {
    store.actions.resetPhotography(); store.actions.updatePhotography(kind, path, value); await store.actions.savePhotography(); assert.equal(calls.length, 0)
  }
  store.actions.resetPhotography(); draft().cameras[0].targetPoint = [0, 1, 2]; delete draft().cameras[0].targetEntityId
  draft().cameras[0].transform.rotationEuler[1] += 1; assert.throws(() => editor.buildPatch(draft()), /rotationEuler/)
  store.actions.resetPhotography(); delete draft().cameras[0].targetEntityId; delete draft().cameras[0].targetPoint
  assert.equal(editor.buildPatch(draft()).operations[0].clearTarget, true); assert.equal(calls.length, 0)
})

test('polling and project switches retain drafts, expose stale bases and refuse stale saves', async t => {
  const { store, calls, draft, projects, action } = await client(t)
  store.actions.updatePhotography('camera', ['lens'], 81); const id = draft().cameraId
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two'); assert.notEqual(draft().cameras.find(item => item.id === id).lens, 81)
  store.actions.updatePhotography('light', ['energy'], 700)
  store.actions.selectProject('one'); await waitFor(store, state => state.activeProjectId === 'one'); assert.equal(draft().cameras.find(item => item.id === id).lens, 81)
  projects.one.revision = 'r0003'; store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0003')
  assert.equal(draft().baseRevision, 'r0001'); assert.equal(action('save').props.disabled, true); await store.actions.savePhotography(); assert.equal(calls.length, 0)
  store.actions.resetPhotography(); assert.equal(draft().baseRevision, 'r0003'); assert.equal(editor.dirty(draft()), false)
})

test('save fixes preview to the committed revision, camera and frame and duplicate saves cannot race', async t => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve })
  const { store, calls, draft, projects } = await client(t, { onPost: async ({ route }) => { if (route === 'patch') await gate } })
  store.actions.selectPhotography('camera', draft().cameras.at(-1).id); store.actions.updatePhotography('inspection', 'frame', draft().frameEnd); store.actions.updatePhotography('inspection', 'samples', 24)
  const cameraId = draft().cameraId, frame = draft().frame
  store.actions.updatePhotography('camera', ['lens'], 80)
  const save = store.actions.savePhotography(); await store.actions.savePhotography(); assert.equal(calls.length, 1)
  unblock(); await save
  assert.deepEqual(calls[1].body, { revision: 'r0002', mode: 'beauty', views: [{ id: 'selected', cameraId, frame }], samples: 24 })
  assert.equal(store.getState().photographyWork.one.artifact.sourceRevision, 'r0002')
  projects.one.revision = 'r0003'; store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0003')
  await store.actions.retryPhotography(); assert.equal(calls.at(-1).body.revision, 'r0002'); assert.equal(calls.filter(call => call.route === 'patch').length, 1)
})

test('a refused save keeps its draft and retries against the same revision', async t => {
  const { store, calls, draft, fail } = await client(t); store.actions.updatePhotography('camera', ['lens'], 87)
  fail('patch', { code: 'REVISION_CONFLICT', message: 'changed elsewhere' }); await store.actions.savePhotography()
  assert.equal(draft().baseRevision, 'r0001'); assert.equal(editor.dirty(draft()), true); assert.equal(calls.length, 1)
  fail('patch', null); await store.actions.savePhotography(); assert.equal(calls[1].body.patch.baseRevision, 'r0001'); assert.equal(calls[2].route, 'preview')
})

test('saved revision survives failed or cancelled images and retry does not save twice', async t => {
  let unblock; let pause = false; const gate = new Promise(resolve => { unblock = resolve })
  const { store, calls, fail, action } = await client(t, { onPost: async ({ route }) => { if (route === 'preview' && pause) await gate } })
  store.actions.updatePhotography('camera', ['lens'], 84); fail('preview', { code: 'RENDER_FAILED', message: 'GPU unavailable' }); await store.actions.savePhotography()
  assert.match(store.getState().photographyWork.one.error, /r0002.*GPU unavailable/); assert.equal(store.getState().photographyEdits.one.after, 'r0002')
  await waitFor(store, state => state.currentRevision === 'r0002')
  assert.equal(action('retry').props.disabled, false); assert.equal(action('restore').props.disabled, false)
  fail('preview', null); pause = true; const retry = store.actions.retryPhotography(); store.actions.cancelPhotography(); unblock(); await retry
  assert.match(store.getState().photographyWork.one.error, /r0002/); assert.equal(store.getState().photographyWork.one.artifact, null)
  pause = false; await store.actions.retryPhotography(); assert.equal(store.getState().photographyWork.one.error, null)
  assert.ok(store.getState().photographyWork.one.artifact); assert.equal(calls.filter(call => call.route === 'patch').length, 1)
})

test('wrong revision, digest, camera, frame or artifact receipts are rejected after save', async t => {
  for (const mutatePreview of [receipt => { receipt.revision = 'r0009' }, receipt => { receipt.sourceDigest = 'wrong' }, receipt => { receipt.artifacts[0].cameraId = 'other' }, receipt => { receipt.artifacts[0].frame += 1 }, receipt => { receipt.artifacts[0].sha256 = 'not-a-digest' }]) {
    const { store } = await client(t, { mutatePreview }); store.actions.updatePhotography('camera', ['lens'], 81); await store.actions.savePhotography()
    assert.equal(store.getState().photographyWork.one.artifact, null); assert.match(store.getState().photographyWork.one.error, /r0002/)
    assert.equal(store.getState().photographyEdits.one.after, 'r0002')
  }
})

test('late save and image responses remain with their original project', async t => {
  let unblock; const gate = new Promise(resolve => { unblock = resolve })
  const { store, calls, draft, nodes } = await client(t, { onPost: async ({ route }) => { if (route === 'patch') await gate } })
  store.actions.updatePhotography('camera', ['lens'], 91); const pending = store.actions.savePhotography()
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two'); unblock(); await pending
  assert.equal(store.getState().activeProjectId, 'two'); assert.equal(draft().projectId, 'two'); assert.equal(store.getState().photographyEdits.two, undefined)
  assert.equal(nodes().some(node => node.props['data-photography-saved']), false); assert.equal(calls[1].projectId, 'one')
  store.actions.selectProject('one'); await waitFor(store, state => state.activeProjectId === 'one'); assert.equal(store.getState().photographyWork.one.artifact.sourceRevision, 'r0002')
})

test('restore is conditional, preserves newer drafts on rejection, and refuses changed current revisions', async t => {
  const { store, calls, draft, fail, projects, action } = await client(t)
  store.actions.updatePhotography('camera', ['lens'], 89); await store.actions.savePhotography(); await waitFor(store, state => state.currentRevision === 'r0002')
  store.actions.updatePhotography('light', ['energy'], 902); fail('restore', { code: 'REVISION_CONFLICT', message: 'concurrent edit' }); await store.actions.restorePhotography()
  assert.deepEqual(calls.at(-1).body, { revision: 'r0001', expectedCurrentRevision: 'r0002' }); assert.equal(editor.dirty(draft()), true)
  assert.equal(store.getState().photographyEdits.one.after, 'r0002'); assert.match(store.getState().photographyWork.one.error, /REVISION_CONFLICT/)
  projects.one.revision = 'r0003'; store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0003'); assert.equal(action('restore').props.disabled, true)
  const count = calls.length; await store.actions.restorePhotography(); assert.equal(calls.length, count)
  projects.one.revision = 'r0002'; store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0002'); fail('restore', null); await store.actions.restorePhotography()
  await waitFor(store, state => state.currentRevision === 'r0001'); assert.equal(draft().baseRevision, 'r0002'); assert.equal(editor.dirty(draft()), true); assert.equal(store.getState().photographyEdits.one, undefined)
})


test('camera and light numeric controls retain empty drafts before replacement, including valid zero', async t => {
  const cases = [
    ['camera-lens', 'camera', ['lens'], '83', false],
    ['camera-location-x', 'camera', ['transform', 'location', 0], '.2', true],
    ['camera-rotationEuler-x', 'camera', ['transform', 'rotationEuler', 0], '15', true],
    ['camera-targetPoint-y', 'camera', ['targetPoint', 1], '.1', true],
    ['light-energy', 'light', ['energy'], '275', true],
    ['light-color-g', 'light', ['color', 1], '.3', true],
    ['light-size', 'light', ['size'], '.5', false],
    ['light-location-z', 'light', ['transform', 'location', 2], '.3', true],
    ['light-rotationEuler-y', 'light', ['transform', 'rotationEuler', 1], '20', true],
  ]
  for (const [name, kind, path, replacement, zeroValid] of cases) {
    const spec = source(); spec.animationTracks = []
    const camera = spec.cameras.find(c => c.id === spec.project.activeCamera)
    delete camera.targetEntityId; delete camera.targetPoint
    if (path[0] === 'targetPoint') camera.targetPoint = [.01, .02, .03]
    const { store, field, action, draft, calls } = await client(t, { spec })
    field(name).props.onChange({ target: { value: '' } })
    const item = () => draft()[`${kind}s`].find(item => item.id === draft()[`${kind}Id`])
    assert.equal(path.reduce((value, key) => value[key], item()), null, name)
    assert.equal(field(name).props.value, '', `${name}: deleted value must stay visibly empty`)
    assert.equal(action('save').props.disabled, true, name)
    await store.actions.savePhotography(); assert.equal(calls.length, 0, name)
    field(name).props.onChange({ target: { value: '0' } })
    assert.equal(field(name).props.value, 0, name)
    assert.equal(editor.errors(draft()).length === 0, zeroValid, `${name}: zero follows the existing domain`)
    field(name).props.onChange({ target: { value: replacement } })
    assert.equal(field(name).props.value, Number(replacement), name)
    assert.equal(action('save').props.disabled, false, name)
    apply(spec, draft())
  }
})

test('cleared lens, light energy and size are invalid even when save is called directly', async t => {
  for (const name of ['camera-lens', 'light-energy', 'light-size']) {
    const { store, field, action, draft, calls } = await client(t)
    field(name).props.onChange({ target: { value: '' } })
    assert.equal(action('save').props.disabled, true, `${name}: null is not an omitted default`)
    assert(editor.errors(draft()).length > 0, name)
    await store.actions.savePhotography()
    assert.equal(calls.length, 0, `${name}: invalid draft must not reach the Host`)
  }
})

test('omitted photographic options show defaults without a patch and zero keeps its existing meaning', async t => {
  const spec = source(); spec.animationTracks = []
  const camera = spec.cameras.find(c => c.id === spec.project.activeCamera), light = spec.lights[0]
  delete camera.lens; delete camera.transform; delete camera.targetEntityId; delete camera.targetPoint
  delete light.energy; delete light.color; delete light.size; delete light.transform
  const { field, draft } = await client(t, { spec })
  for (const [name, expected] of [['camera-lens', 50], ['camera-location-x', 0], ['camera-rotationEuler-x', 0],
    ['light-energy', 100], ['light-color-r', 1], ['light-size', light.type === 'area' ? 1 : .25], ['light-location-z', 0]])
    assert.equal(field(name).props.value, expected, name)
  const selected = draft().cameras.find(c => c.id === draft().cameraId)
  assert.equal(selected.lens, undefined); assert.equal(selected.transform, undefined)
  assert.equal(draft().lights[0].energy, undefined); assert.equal(draft().lights[0].color, undefined); assert.equal(draft().lights[0].size, undefined)
  assert.deepEqual(plain(editor.buildPatch(draft()).operations), [])
})

test('saved photography reuse replaces lighting and editable camera fields in a target-bound draft', () => {
  assert.equal(typeof editor.reuse, 'function', 'saved photography must be reusable without manually retyping its fields')
  const from = source(), target = source(); from.cameras[0].lens = 55; from.cameras[0].targetPoint[2] = .06
  from.lights[0].energy = .9; from.lights[0].color = [.8, .9, 1]; from.lights[0].spotBlend = .2
  target.cameras[0].id = 'destination-camera'; target.project.activeCamera = 'destination-camera'; for (const shot of target.shots) if (shot.cameraId === 'hero') shot.cameraId = 'destination-camera'
  target.cameras[0].sensorWidth = 42; target.cameras[0].fStop = 6.3
  const { draft } = make(target), before = plain(draft), snapshot = plain(from)
  const reused = editor.reuse(draft, tree(from, 'r0007'), from.cameras[0].id, '')
  assert.deepEqual(plain(draft), before, 'applying a reusable setup must not mutate the original draft')
  assert.deepEqual(from, snapshot, 'the saved source must remain untouched')
  const { patch, next } = apply(target, reused)
  assert.equal(patch.baseRevision, draft.baseRevision); assert.equal(next.cameras[0].id, 'destination-camera')
  assert.equal(next.cameras[0].lens, 55); assert.deepEqual(next.cameras[0].targetPoint, from.cameras[0].targetPoint)
  assert.equal(next.cameras[0].sensorWidth, 42); assert.equal(next.cameras[0].fStop, 6.3)
  assert.deepEqual(Object.fromEntries(next.lights.map(item => [item.id, item])), Object.fromEntries(from.lights.map(item => [item.id, item])), 'all source light identities and complete definitions must be reused, including noneditable fields')
  for (const key of ['entities', 'materials', 'assets', 'world', 'project', 'animationTracks', 'renderProfiles', 'shots']) assert.deepEqual(next[key], target[key])
  assert.deepEqual(next.cameras.slice(1), target.cameras.slice(1)); assert.equal(reused.projectId, draft.projectId)
})

test('reusing an object-targeted camera requires an explicit target-work object mapping', () => {
  assert.equal(typeof editor.reuse, 'function')
  const from = source(), { spec, draft } = make(); delete from.cameras[0].targetPoint; from.cameras[0].targetEntityId = 'source-only-object'
  assert.throws(() => editor.reuse(draft, tree(from), 'hero', ''), /target|目标|对象/i)
  assert.throws(() => editor.reuse(draft, tree(from), 'hero', 'not-here'), /target|目标|对象/i)
  const { next } = apply(spec, editor.reuse(draft, tree(from), 'hero', spec.entities[0].id))
  assert.equal(next.cameras[0].targetEntityId, spec.entities[0].id); assert.equal(next.cameras[0].targetPoint, undefined)
})

test('reusing a free-rotation camera clears the earlier aim and cannot overwrite animated axes', () => {
  assert.equal(typeof editor.reuse, 'function')
  const from = source(), { spec, draft } = make(); delete from.cameras[0].targetPoint; from.cameras[0].transform.rotationEuler = [.1, .2, .3]
  const { patch, next } = apply(spec, editor.reuse(draft, tree(from), 'hero', ''))
  assert.equal(patch.operations[0].clearTarget, true); assert.equal(next.cameras[0].targetPoint, undefined)
  assert.deepEqual(next.cameras[0].transform.rotationEuler, [.1, .2, .3]); assert.equal(Object.hasOwn(next.cameras[0], 'clearTarget'), false)
  spec.animationTracks.push({ id: 'locked', targetKind: 'camera', targetEntityId: 'hero', property: 'rotationEuler.z', keyframes: [{ frame: 1, value: 0 }, { frame: 48, value: 1 }] })
  const locked = make(spec).draft, before = plain(locked)
  assert.throws(() => editor.reuse(locked, tree(from), 'hero', ''), /rotation|target|旋转|输入/i)
  assert.deepEqual(plain(locked), before)
})

test('clearTarget is explicit, mutually exclusive with a new target and remains absent from saved camera data', () => {
  const { spec } = make(), operation = { op: 'camera.update', cameraId: 'hero', clearTarget: true, transform: { rotationEuler: [.1, .2, .3] } }
  const patch = { projectId: 'one', baseRevision: 'r0001', operations: [operation] }
  assert.equal(validateScenePatch(patch).ok, true, 'a targeted camera must support returning to free rotation')
  const next = applyPatchToSpec(spec, patch).spec; assert.equal(next.cameras[0].targetPoint, undefined); assert.equal(next.cameras[0].clearTarget, undefined)
  for (const extra of [{ targetPoint: [0, 0, 0] }, { targetEntityId: spec.entities[0].id }, { clearTarget: false }]) {
    assert.equal(validateScenePatch({ ...patch, operations: [{ ...operation, ...extra }] }).ok, false)
  }
})

test('the actual source controls read a saved version and apply without a write until explicit save', async t => {
  const { store, calls, projects, field, action, draft, reads } = await client(t)
  projects.two.spec.cameras[0].lens = 55; projects.two.spec.lights[0].energy = .9
  await store.actions.setPhotographySource('project', 'two')
  assert.equal(store.getState().photographyReuse.one.revision, 'r0001'); assert.equal(field('source-camera').props.value, 'hero')
  assert.equal(action('reuse').props.disabled, false); action('reuse').props.onClick()
  assert.equal(draft().cameras.find(item => item.id === 'hero').lens, 55); assert.equal(draft().lights.find(item => item.id === 'key').energy, .9)
  assert.equal(calls.length, 0); assert(reads.some(item => item.url.endsWith('/scene?revision=r0001')))
  await store.actions.savePhotography(); assert.deepEqual(calls.map(item => item.route), ['patch', 'preview'])
  assert.equal(calls[0].projectId, 'one'); assert.match(calls[0].body.patch.note, /two.*r0001.*aaaa.*hero/); assert.equal(calls[0].body.patch.baseRevision, 'r0001'); assert.equal(calls[1].body.revision, 'r0002')
  assert.equal(projects.two.revision, 'r0001'); assert.equal(projects.two.spec.cameras[0].lens, 55); assert.equal(store.getState().photographyReuse.one.applied, false); assert.equal(store.getState().photographyReuse.one.baseRevision, 'r0002'); await waitFor(store, state => state.currentRevision === 'r0002'); store.actions.reusePhotography(); assert.equal(editor.dirty(draft()), false); assert.equal(store.getState().photographyReuse.one.unchanged, true); assert.equal(calls.length, 2); store.actions.updatePhotography('camera', ['lens'], 81); assert.equal(store.getState().photographyReuse.one.unchanged, false)
})

test('an existing photography draft requires explicit replacement and keeps other work inputs', async t => {
  const { store, calls, projects, draft, field, action } = await client(t)
  projects.two.spec.cameras[0].lens = 55; store.actions.updatePhotography('camera', ['lens'], 81); store.actions.setForm('patch', 'other unsaved edit')
  await store.actions.setPhotographySource('project', 'two'); const before = plain(draft())
  assert.equal(action('reuse').props.disabled, true); store.actions.reusePhotography(); assert.deepEqual(plain(draft()), before)
  field('source-replace').props.onChange({ target: { checked: true } }); assert.equal(action('reuse').props.disabled, false)
  store.actions.reusePhotography(); assert.equal(draft().cameras.find(item => item.id === 'hero').lens, 55)
  assert.equal(store.getState().photographyReuse.one.replaceDraft, false); assert.equal(store.getState().forms.patch, 'other unsaved edit'); assert.equal(calls.length, 0)
})

test('source reads reject project, version and digest mismatches without replacing the destination draft', async t => {
  for (const change of [p => p.projectId = 'elsewhere', p => p.revision = 'r0009', p => p.scene.revision = 'r0009', p => p.digest = 'b'.repeat(64), p => p.scene.project.id = 'elsewhere']) {
    const { store, draft, calls } = await client(t, { onRead: ({ path, payload }) => { if (path.pathname.endsWith('/scene')) change(payload) } })
    const before = plain(draft()); await store.actions.setPhotographySource('project', 'two')
    assert.equal(store.getState().photographyReuse.one.source, null); assert(store.getState().photographyReuse.one.error)
    store.actions.reusePhotography(); assert.deepEqual(plain(draft()), before); assert.equal(calls.length, 0)
  }
})

test('a later source selection wins over a late saved-scene response', async t => {
  let finish; const gate = new Promise(resolve => finish = resolve)
  const { store, projects, calls } = await client(t, { onRead: async ({ path }) => { if (path.pathname.endsWith('/scene') && path.pathname.includes('/two/')) await gate } })
  projects.two.spec.cameras[0].lens = 99
  const old = store.actions.setPhotographySource('project', 'two'); await waitFor(store, state => state.photographyReuse.one?.revision === 'r0001')
  await store.actions.setPhotographySource('project', 'one'); finish(); await old
  assert.equal(store.getState().photographyReuse.one.sourceProjectId, 'one'); assert.equal(store.getState().photographyReuse.one.source.nodes.cameras.find(item => item.id === 'hero').definition.lens, 60)
  assert.equal(calls.length, 0)
})

test('a stored historical version remains the source when the source current pointer changes', async t => {
  const old = source(), newest = source(); old.cameras[0].lens = 55; newest.cameras[0].lens = 90
  const { store, projects, calls, draft } = await client(t, { histories: { two: { r0001: old, r0002: newest } }, onRead: ({ path }) => { if (path.pathname.endsWith('/revisions') && path.pathname.includes('/two/')) projects.two.revision = 'r0002' } })
  await store.actions.setPhotographySource('project', 'two'); assert.equal(store.getState().photographyReuse.one.revision, 'r0001')
  await store.actions.setPhotographySource('revision', 'r0002'); assert.equal(store.getState().photographyReuse.one.source.nodes.cameras.find(item => item.id === 'hero').definition.lens, 90)
  await store.actions.setPhotographySource('revision', 'r0001'); assert.equal(store.getState().photographyReuse.one.revision, 'r0001')
  store.actions.reusePhotography(); assert.equal(draft().cameras.find(item => item.id === 'hero').lens, 55); assert.equal(calls.length, 0)
})

test('a late source read after stopping cannot update the snapshot', async t => {
  let finish; const gate = new Promise(resolve => finish = resolve)
  const { store, calls } = await client(t, { onRead: async ({ path }) => { if (path.pathname.endsWith('/scene')) await gate } })
  const pending = store.actions.setPhotographySource('project', 'two'); await waitFor(store, state => state.photographyReuse.one?.revision === 'r0001')
  store.stop(); const snapshot = store.getState(); finish(); await pending
  assert.equal(store.getState(), snapshot); assert.equal(calls.length, 0)
})

test('project storage changes invalidate saved photography sources and keep an unsaved draft intact', async t => {
  let root = '/first-store'
  const { store, draft, calls } = await client(t, { root: () => root })
  await store.actions.setPhotographySource('project', 'two'); store.actions.updatePhotography('camera', ['lens'], 81)
  const before = plain(draft()); root = '/other-store'; store.actions.reload(); await waitFor(store, state => state.projectsRoot === root)
  assert.deepEqual(Object.keys(store.getState().photographyReuse), []); store.actions.reusePhotography(); assert.deepEqual(plain(draft()), before); assert.equal(calls.length, 0)
})

test('an older Host keeps legacy photography editing while refusing unsupported reuse and target clearing', async t => {
  const { store, reads, calls, draft, field, action } = await client(t, { legacy: true })
  const before = plain(draft()), oldReads = reads.length
  assert.equal(action('reuse'), undefined); assert.equal(field('source-project'), undefined)
  await store.actions.setPhotographySource('project', 'two'); store.actions.reusePhotography()
  store.actions.updatePhotography('camera', ['aim'], 'free'); assert.deepEqual(plain(draft()), before)
  assert.equal(reads.length, oldReads); assert.equal(calls.length, 0)
  store.actions.updatePhotography('camera', ['lens'], 55); await store.actions.savePhotography()
  assert.equal(calls[0].body.patch.operations[0].lens, 55); assert.equal(calls[0].body.patch.operations[0].clearTarget, undefined)
})

test('a saved light rig with identical definitions in a different order needs no new revision', () => {
  const { spec, draft } = make(), same = plain(spec); same.lights.reverse()
  const reused = editor.reuse(draft, tree(same), 'hero', '')
  assert.equal(editor.dirty(reused), false); assert.deepEqual(plain(editor.buildPatch(reused).operations), [])
  reused.lights.find(item => item.id === 'key').energy += .1
  assert.equal(editor.dirty(reused), true); assert(editor.buildPatch(reused).operations.some(item => item.op === 'light.add'))
})
