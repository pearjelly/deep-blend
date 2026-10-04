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
  const calls = []; let patchFailure, previewFailure, restoreFailure
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
    } else if (path.pathname.endsWith('/jobs')) payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.jobs', jobs: [], unfinished: [] }
    else if (path.pathname.endsWith('/previews')) payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.previews', artifactBase: '/artifact', previews: { revisions: [] } }
    else payload = { ok: true, hostApiVersion: HOST_API_VERSION, route: 'state', projects: Object.keys(projects).map(projectId => ({ projectId })),
      selected: { project: { projectId, title: projectId }, currentRevision: project.revision, scene: tree(project.spec, project.revision), jobs: [], unfinishedJobs: [] } }
    return { ok: payload.ok, status: payload.ok ? 200 : 409, text: async () => JSON.stringify(payload), json: async () => payload }
  } }
  const store = core.createWorkbenchStore(settings); t.after(() => store.stop()); store.start(); await waitFor(store, state => state.status === 'ok'); store.actions.setView('scene')
  const nodes = () => flatten(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = key => nodes().find(node => node.props['data-field'] === `photo-${key}`)
  const action = key => nodes().find(node => node.props['data-action'] === `photo-${key}`)
  return { store, calls, projects, nodes, field, action, draft: () => editor.draftFor(store.getState()), fail: (kind, value) => {
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

test('actual camera target controls switch entity and point without ignored rotation or target clearing', async t => {
  const { store, field, draft } = await client(t)
  const camera = () => draft().cameras.find(camera => camera.id === draft().cameraId), oldRotation = plain(camera().transform.rotationEuler)
  assert.equal(field('camera-rotationEuler-x').props.disabled, true)
  store.actions.updatePhotography('camera', ['transform', 'rotationEuler', 0], 1)
  assert.deepEqual(plain(camera().transform.rotationEuler), oldRotation)
  field('camera-aim').props.onChange({ target: { value: 'point' } }); field('camera-targetPoint-z').props.onChange({ target: { value: '.4' } })
  assert.equal(camera().targetEntityId, undefined); assert.deepEqual(plain(camera().targetPoint), [0, 0, .4])
  let result = apply(source(), draft()); assert.equal(result.next.cameras.find(item => item.id === camera().id).targetEntityId, undefined)
  store.actions.updatePhotography('camera', ['aim'], 'free'); assert.equal(camera().targetPoint[2], .4)
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

test('invalid inputs and unsupported target clearing do not create a request', async t => {
  const { store, calls, draft } = await client(t)
  for (const [kind, path, value] of [['camera', ['lens'], 0], ['light', ['energy'], -1], ['light', ['color', 0], 2], ['light', ['size'], 0], ['camera', ['transform', 'location', 0], null]]) {
    store.actions.resetPhotography(); store.actions.updatePhotography(kind, path, value); await store.actions.savePhotography(); assert.equal(calls.length, 0)
  }
  store.actions.resetPhotography(); draft().cameras[0].targetPoint = [0, 1, 2]; delete draft().cameras[0].targetEntityId
  draft().cameras[0].transform.rotationEuler[1] += 1; assert.throws(() => editor.buildPatch(draft()), /rotationEuler/)
  store.actions.resetPhotography(); delete draft().cameras[0].targetEntityId; delete draft().cameras[0].targetPoint
  assert.throws(() => editor.buildPatch(draft()), /target/)
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
