/** Reference-image UI: raw transport, saved-revision projections and isolated browser drafts. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import BlenderUiHost, { createHandlers, statusForError } from '@deepblend/dsh-blender-ui'
import { BlenderError, buildSceneTree, buildQaView, compileSceneSpec, validateScenePatch, validateSceneSpec, applyPatchToSpec, HOST_API_VERSION, UI_ROUTES, matchUiRoute } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'

const core = loadClientBundle().exports.workbench, brief = core.referenceBrief
const clone = value => JSON.parse(JSON.stringify(value))
const sha = 'a'.repeat(64), otherSha = 'b'.repeat(64)
const asset = { id: 'reference-asset', type: 'png', path: `assets/raw/${sha}.png`, sha256: sha }
const reference = { id: 'front-reference', assetId: asset.id, sha256: sha, label: 'Product front', purposes: ['geometry', 'goalFit'], notes: 'Keep the curved shoulder' }
const image = { mime: 'image/png', width: 20, height: 10, bytes: 100, sha256: sha }
const source = () => compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/glass-ceramic/scene-spec.json', import.meta.url)))).spec
const scene = (spec, revision = 'r0001') => buildSceneTree(spec, { revision })
const nodesOf = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(nodesOf)] : []
const validPatch = patch => assert.equal(validateScenePatch(patch).ok, true, validateScenePatch(patch).summary)
async function waitFor(store, predicate) {
  if (predicate(store.getState())) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error('reference client did not settle')) }, 3000)
    const stop = store.subscribe(state => { if (predicate(state)) { clearTimeout(timer); stop(); resolve() } })
  })
}

async function client(t, options = {}) {
  const projects = { one: { spec: source(), revision: 'r0001' }, two: { spec: source(), revision: 'r0001' } }
  projects.one.spec.project.goal = 'Saved goal one'; projects.two.spec.project.goal = 'Saved goal two'
  options.prepare?.(projects)
  const calls = []
  let failure = null
  const store = core.createWorkbenchStore({ pollIdleMs: 100000, fetch: async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost'), id = parsed.pathname.match(/projects\/([^/]+)/)?.[1] || parsed.searchParams.get('projectId') || 'one'
    const project = projects[id]
    let payload
    if (init.method === 'POST') {
      const raw = parsed.pathname.endsWith('/reference-images'), body = raw ? init.body : JSON.parse(init.body)
      calls.push({ path: parsed.pathname, query: parsed.searchParams, body, headers: init.headers })
      if (options.onPost) await options.onPost({ raw, id, body })
      if (failure) payload = { ok: false, error: failure }
      else if (raw) payload = { ok: true, asset, image }
      else if (parsed.pathname.endsWith('/patch')) {
        validPatch(body.patch)
        assert.equal(body.patch.baseRevision, project.revision)
        project.spec = applyPatchToSpec(project.spec, body.patch).spec
        assert.equal(validateSceneSpec(project.spec).ok, true, validateSceneSpec(project.spec).summary)
        project.revision = `r${String(Number(project.revision.slice(1)) + 1).padStart(4, '0')}`; payload = { ok: true, revision: { revision: project.revision } }
      } else if (parsed.pathname.endsWith('/review')) payload = { ok: true, revision: project.revision, review: options.review || { reviewerError: null, referenceImages: [] } }
      else payload = { ok: true, run: { finalRevision: project.revision, stopReason: 'ITERATION_CAP', artistic: { status: 'unassessable' } } }
    } else if (parsed.pathname.endsWith('/jobs')) payload = { ok: true, route: 'project.jobs', hostApiVersion: HOST_API_VERSION, jobs: [], unfinished: [] }
    else if (parsed.pathname.endsWith('/previews')) payload = { ok: true, route: 'project.previews', hostApiVersion: HOST_API_VERSION, artifactBase: `/deepblend/artifacts/${id}/`, previews: { revisions: [] } }
    else payload = { ok: true, route: 'state', hostApiVersion: HOST_API_VERSION, projects: Object.keys(projects).map(projectId => ({ projectId })), selected: {
      project: { projectId: id, title: id }, scene: scene(project.spec, project.revision), currentRevision: project.revision,
      qa: buildQaView({ projectId: id, revision: project.revision, review: options.qaReview || null }), jobs: [], unfinishedJobs: [],
    } }
    return { ok: payload.ok, status: payload.ok ? 200 : 409, text: async () => JSON.stringify(payload), json: async () => payload }
  } })
  t.after(() => store.stop()); store.start(); await waitFor(store, state => state.status === 'ok')
  const nodes = () => nodesOf(core.renderView({ state: store.getState(), actions: store.actions }))
  const field = name => nodes().find(node => node.props['data-field'] === name)
  const action = name => nodes().find(node => node.props['data-action'] === name)
  return { store, calls, projects, nodes, field, action, fail: value => { failure = value } }
}
const file = { name: 'front view.png', type: 'image/png', size: 100, bytes: 'opaque file payload' }

test('subject projection resolves the saved SceneSpec and preserves unavailable explicit selection', () => {
  const spec = source(), automatic = scene(spec)
  assert.equal(automatic.project.reviewSubjectId, null)
  assert.equal(automatic.reviewSubject.id, 'bottle'); assert.equal(automatic.reviewSubject.mode, 'automatic'); assert.equal(automatic.reviewSubject.available, true)
  spec.project.reviewSubjectId = 'cap'; spec.entities.find(entity => entity.id === 'cap').visible = false
  const explicit = scene(spec, 'r0002')
  assert.equal(explicit.project.reviewSubjectId, 'cap'); assert.equal(explicit.reviewSubject.id, 'cap')
  assert.equal(explicit.reviewSubject.mode, 'explicit'); assert.equal(explicit.reviewSubject.available, false)
  assert.match(explicit.reviewSubject.reason, /hidden/)
  explicit.reviewSubject.candidates.push('floor'); assert.deepEqual(scene(spec).reviewSubject.candidates, ['cap'])
  assert.equal(automatic.project.reviewSubjectId, null, 'a later selection cannot mutate historical projection')
})

test('subject-only saves use an independent public operation and combined saves preserve the camera', () => {
  const spec = source(), draft = brief.createDraft(scene(spec), 'one'), cameras = clone(spec.cameras)
  assert.deepEqual(clone(brief.buildPatch(draft).operations), [])
  draft.reviewSubjectId = 'floor'
  const patch = clone(brief.buildPatch(draft)); validPatch(patch)
  assert.deepEqual(patch.operations, [{ op: 'project.reviewSubject.set', entityId: 'floor' }])
  assert.equal(patch.renderPreview, false); assert.equal(patch.saveCheckpoint, true); assert.equal(patch.baseRevision, 'r0001')
  const next = applyPatchToSpec(spec, patch).spec
  assert.equal(next.project.reviewSubjectId, 'floor'); assert.deepEqual(next.cameras, cameras)
  draft.goal = 'New goal'; draft.referenceImages = [clone(reference)]; draft.pendingAssets[asset.id] = asset
  const together = clone(brief.buildPatch(draft)); validPatch(together)
  assert.deepEqual(together.operations.map(operation => operation.op), ['asset.add', 'project.brief.set', 'project.reviewSubject.set'])
  assert.equal(validateSceneSpec(applyPatchToSpec(spec, together).spec).ok, true)
  const reset = brief.createDraft(scene(next, 'r0002'), 'one'); reset.reviewSubjectId = null
  const cleared = clone(brief.buildPatch(reset)); validPatch(cleared)
  assert.deepEqual(cleared.operations, [{ op: 'project.reviewSubject.set', entityId: null }])
  assert.equal(applyPatchToSpec(next, cleared).spec.project.reviewSubjectId, undefined)
})

test('subject selector includes visible environment objects with a label and excludes hidden or empty objects', async t => {
  const { field, store, calls, action, nodes } = await client(t, { prepare: projects => {
    projects.one.spec.entities.find(entity => entity.id === 'cap').visible = false
    projects.one.spec.entities.push({ id: 'pivot', type: 'empty' })
  } })
  const select = field('brief-review-subject'), options = nodesOf(select).filter(node => node.tag === 'option')
  assert.equal(select.props.value, ''); assert.ok(options.some(option => option.props.value === 'floor' && JSON.stringify(option).includes('environment object')))
  assert.equal(options.some(option => ['cap', 'pivot'].includes(option.props.value)), false)
  store.actions.updateBrief('reviewSubjectId', 'cap'); assert.equal(field('brief-review-subject').props.value, '')
  select.props.onChange({ target: { value: 'floor' } })
  assert.equal(field('brief-review-subject').props.value, 'floor'); assert.equal(calls.length, 0)
  assert.equal(action('project-review').props.disabled, true); assert.equal(action('project-autofix').props.disabled, true)
  assert.equal(nodes().find(node => node.props['data-review-subject-resolution']).props['data-review-subject-id'], 'bottle', 'pending selection cannot replace saved resolution')
})

test('saving and reloading a subject keeps its identity; clearing it restores automatic selection', async t => {
  const { field, store, calls, nodes, projects } = await client(t)
  field('brief-review-subject').props.onChange({ target: { value: 'tray' } })
  await store.actions.saveBrief(); await waitFor(store, state => state.currentRevision === 'r0002' && state.briefDrafts.one)
  assert.equal(field('brief-review-subject').props.value, 'tray'); assert.equal(brief.dirty(store.getState().briefDrafts.one), false)
  assert.equal(nodes().find(node => node.props['data-review-subject-resolution']).props['data-review-subject-mode'], 'explicit')
  store.actions.reload(); await waitFor(store, state => state.status === 'ok')
  assert.equal(field('brief-review-subject').props.value, 'tray')
  field('brief-review-subject').props.onChange({ target: { value: '' } })
  await store.actions.saveBrief(); await waitFor(store, state => state.currentRevision === 'r0003' && state.briefDrafts.one)
  assert.equal(projects.one.spec.project.reviewSubjectId, undefined)
  assert.equal(nodes().find(node => node.props['data-review-subject-resolution']).props['data-review-subject-id'], 'bottle')
  assert.deepEqual(calls.map(call => call.body.patch.operations), [[{ op: 'project.reviewSubject.set', entityId: 'tray' }], [{ op: 'project.reviewSubject.set', entityId: null }]])
})

test('an unavailable saved subject remains selected with an explicit warning and permits unrelated brief edits', async t => {
  const { store, field, nodes, calls } = await client(t, { prepare: projects => {
    projects.one.spec.project.reviewSubjectId = 'cap'; projects.one.spec.entities.find(entity => entity.id === 'cap').visible = false
  } })
  assert.equal(field('brief-review-subject').props.value, 'cap')
  assert.ok(nodes().some(node => node.props['data-review-subject-available'] === 'false'))
  assert.match(JSON.stringify(nodes()), /hidden in this revision/)
  store.actions.updateBrief('goal', 'Keep the explicit choice, but update the goal')
  await store.actions.saveBrief(); assert.deepEqual(calls[0].body.patch.operations.map(operation => operation.op), ['project.brief.set'])
})

test('object editor shortcut changes only the project brief draft, and unsaved object edits also block review', async t => {
  const { store, calls, action } = await client(t)
  store.actions.setView('scene'); store.actions.selectEditorEntity('cap')
  action('editor-review-subject').props.onClick()
  assert.equal(store.getState().view, 'projects'); assert.equal(store.getState().briefDrafts.one.reviewSubjectId, 'cap'); assert.equal(calls.length, 0)
  store.actions.resetBrief(); store.actions.setView('scene'); store.actions.selectEditorEntity('cap')
  store.actions.updateEditor('transform', ['location', 0], .01)
  store.actions.setView('projects'); assert.equal(action('project-review').props.disabled, true)
  await store.actions.runVisual('review'); assert.equal(calls.length, 0)
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two')
  assert.equal(Boolean(action('project-review').props.disabled), false, 'another project draft cannot block this project')
})

test('subject drafts survive polling, project switches and conflicts until explicitly discarded', async t => {
  const { store, projects, field, action, calls } = await client(t)
  store.actions.updateBrief('reviewSubjectId', 'tray'); projects.one.spec.project.reviewSubjectId = 'cap'; projects.one.revision = 'r0002'
  store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0002')
  assert.equal(field('brief-review-subject').props.value, 'tray'); assert.equal(action('brief-save').props.disabled, true)
  await store.actions.saveBrief(); assert.equal(calls.length, 0)
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two')
  assert.equal(field('brief-review-subject').props.value, '')
  store.actions.selectProject('one'); await waitFor(store, state => state.activeProjectId === 'one')
  assert.equal(field('brief-review-subject').props.value, 'tray')
  store.actions.resetBrief(); assert.equal(field('brief-review-subject').props.value, 'cap')
  assert.equal(store.getState().briefDrafts.one.baseRevision, 'r0002')
})

test('QA subject identity and reason come only from the recorded review, including unavailable and legacy records', async t => {
  const subject = { id: 'tray', mode: 'explicit', source: 'Recorded explicit choice', available: false, reason: 'Recorded unavailable reason' }
  const review = { subjectId: 'bottle', subject, score: 0 }
  const projected = buildQaView({ projectId: 'one', revision: 'r0001', review })
  projected.visual.subject.source = 'Changed'; assert.equal(review.subject.source, 'Recorded explicit choice')
  const { store, nodes } = await client(t, { qaReview: review })
  store.actions.updateBrief('reviewSubjectId', 'floor'); store.actions.setView('qa')
  const shown = nodes().find(node => node.props['data-reviewed-subject'])
  assert.equal(shown.props['data-reviewed-subject'], 'tray'); assert.equal(shown.props['data-reviewed-subject-available'], 'false')
  assert.match(JSON.stringify(shown), /Recorded explicit choice/); assert.match(JSON.stringify(shown), /Recorded unavailable reason/)
  delete review.subject; store.actions.reload(); await waitFor(store, state => state.selected.qa.visual.subject === null)
  const legacy = nodes().find(node => node.props['data-reviewed-subject'])
  assert.equal(legacy.props['data-reviewed-subject'], 'bottle'); assert.equal(legacy.props['data-reviewed-subject-mode'], 'legacy')
})

test('unsubmitted advanced patches block review only in their own project and survive project switches', async t => {
  const { store, action, calls } = await client(t)
  const text = '{"baseRevision":"r0001","operations":[]}'
  store.actions.setForm('patch', text); assert.equal(action('project-review').props.disabled, true)
  await store.actions.runVisual('review'); assert.equal(calls.length, 0)
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two')
  assert.equal(store.getState().forms.patch, null); assert.equal(Boolean(action('project-review').props.disabled), false)
  store.actions.selectProject('one'); await waitFor(store, state => state.activeProjectId === 'one')
  assert.equal(store.getState().forms.patch, text); assert.equal(action('project-review').props.disabled, true)
  store.actions.setForm('patch', null); assert.equal(Boolean(action('project-review').props.disabled), false)
})

test('scene projection deep-clones revision goal/references and does not expose mutable aliases', () => {
  const spec = source(); spec.project.goal = 'Saved revision goal'; spec.project.referenceImages = [clone(reference)]; spec.assets = [clone(asset)]
  const projected = scene(spec)
  assert.equal(projected.project.goal, spec.project.goal); assert.deepEqual(projected.project.referenceImages, [reference])
  projected.project.referenceImages[0].purposes.push('lighting'); assert.deepEqual(spec.project.referenceImages[0].purposes, ['geometry', 'goalFit'])
})

test('project state reads the requested revision goal, not stale project-record metadata', async () => {
  const spec = source(); spec.project.goal = 'Historical goal'; spec.project.referenceImages = [clone(reference)]; spec.assets = [clone(asset)]
  let requested
  const handlers = createHandlers({ blenderStudio: {
    getProject: async () => ({ title: 'Example', currentRevision: 'r0009', revisionCount: 9 }),
    listProjects: async () => ({ projects: [{ projectId: 'one', goal: 'Stale record goal' }] }),
    getScene: async (_id, request) => { requested = request; return { revision: 'r0002', spec } },
    listJobs: async () => ({ jobs: [], unfinished: [] }), getQaRecord: async () => ({ revision: 'r0002', validation: null, review: null }),
  } })
  const value = await handlers['project.overview']({ params: { projectId: 'one' }, query: { revision: 'r0002' } })
  assert.equal(requested.revision, 'r0002'); assert.equal(value.project.goal, 'Historical goal')
  assert.equal(value.scene.project.goal, 'Historical goal'); assert.deepEqual(value.scene.project.referenceImages, [reference])
})

test('QA reports actual recorded references and refuses artistic pass when reference preparation failed', () => {
  const review = { score: 95, pass: true, artistic: { status: 'pass', dimensions: {} }, referenceImages: [{ ...reference, ...image }], reviewInputsDigest: otherSha,
    referenceInputError: { code: 'ASSET_HASH_MISMATCH', message: 'Changed input' } }
  const projected = buildQaView({ projectId: 'one', revision: 'r0002', review }).visual
  assert.equal(projected.score, 95); assert.equal(projected.artistic.status, 'unassessable')
  assert.equal(projected.reviewInputsDigest, otherSha); assert.deepEqual(projected.referenceImages[0].purposes, reference.purposes)
  projected.referenceImages[0].purposes.push('lighting'); assert.equal(review.referenceImages[0].purposes.length, 2)
  assert.deepEqual(buildQaView({ projectId: 'one', revision: 'r0001' }).visual.referenceImages, [])
})

test('three explicit write routes have closed handlers and bounded reviewer inputs', async () => {
  const calls = [], handlers = createHandlers({ blenderStudio: {
    uploadReferenceImage: async input => { calls.push(input); return { asset, image } },
    visualReview: async input => { calls.push(input); return { revision: input.revision, score: 91, referenceImages: [reference], reviewInputsDigest: sha } },
    visualLoop: async input => { calls.push(input); return { finalRevision: input.revision } },
  } })
  assert.deepEqual(Object.keys(handlers).sort(), UI_ROUTES.filter(route => !['artifacts.open', 'workbench.page'].includes(route.id)).map(route => route.id).sort())
  for (const [id, suffix] of [['project.referenceImage.upload', 'reference-images'], ['project.review', 'review'], ['project.autofix', 'autofix']]) {
    assert.equal(matchUiRoute('POST', `/deepblend/projects/one/${suffix}`).route.id, id)
    assert.equal(UI_ROUTES.find(route => route.id === id).write, true)
  }
  const result = await handlers['project.review']({ params: { projectId: 'one' }, body: { revision: 'r0001', consultReviewer: false, reviewer: 'ignored' } })
  assert.deepEqual(calls[0], { projectId: 'one', revision: 'r0001', consultReviewer: true, width: 640, height: 480, samples: 16 })
  assert.equal(result.review.referenceImages[0].id, reference.id)
  await handlers['project.autofix']({ params: { projectId: 'one' }, body: { revision: 'r0001', maxIterations: 2, autoFix: false, operations: ['ignored'] } })
  assert.deepEqual(calls[1], { projectId: 'one', revision: 'r0001', autoFix: true, maxIterations: 2, width: 640, height: 480, samples: 16 })
  for (const maxIterations of [0, 4, 1.5, '2', Infinity]) await assert.rejects(handlers['project.autofix']({ params: { projectId: 'one' }, body: { revision: 'r0001', maxIterations } }), /maxIterations/)
  await assert.rejects(handlers['project.review']({ params: { projectId: 'one' }, body: {} }), /revision/)
  assert.equal(calls.length, 2)
})

test('HTTP upload passes the untouched stream and MIME to Host, bypassing JSON body parsing', async () => {
  const data = Buffer.alloc(4 * 1024 * 1024 + 1, 0xff), request = Readable.from([data.subarray(0, 50), data.subarray(50)])
  Object.assign(request, { method: 'POST', url: '/deepblend/projects/one/reference-images?name=front%20view.png', headers: { 'content-type': 'image/png' } })
  let received
  const context = new Context(); context.provide('blenderStudio', { uploadReferenceImage: async input => {
    assert.equal(input.stream, request); const parts = []; for await (const part of input.stream) parts.push(part)
    received = { ...input, bytes: Buffer.concat(parts) }; return { asset, image }
  } })
  const host = new BlenderUiHost(context, { serveRoute: false })
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
  await host._handle(request, response)
  assert.equal(response.statusCode, 200); assert.equal(received.name, 'front view.png'); assert.equal(received.mediaType, 'image/png')
  assert.ok(received.bytes.equals(data)); assert.deepEqual(JSON.parse(response.body).asset, asset)
  assert.equal(JSON.parse(response.body).image.bytes, 100); assert.ok(response.body.length < 1000)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
})

test('reference upload validation errors have actionable HTTP status codes', () => {
  for (const [code, expected] of Object.entries({ ASSET_REQUEST_INVALID: 400, ASSET_CONTENT_MISMATCH: 415, ASSET_TOO_LARGE: 413, PATH_SEGMENT_INVALID: 400, ASSET_HASH_MISMATCH: 409, ASSET_SOURCE_NOT_FOUND: 404 })) {
    assert.equal(statusForError(new BlenderError(code, 'Controlled error')), expected)
  }
})

test('brief saves only referenced staged assets, then replaces goal/references atomically', () => {
  const spec = source(), draft = brief.createDraft(scene(spec), 'one')
  draft.goal = 'Make the shoulder match'; draft.referenceImages = [clone(reference)]
  draft.pendingAssets = { [asset.id]: asset, unused: { ...asset, id: 'unused', sha256: otherSha, path: `assets/raw/${otherSha}.png` } }
  const patch = clone(brief.buildPatch(draft)); validPatch(patch)
  assert.deepEqual(patch.operations.map(operation => operation.op), ['asset.add', 'project.brief.set'])
  assert.equal(patch.baseRevision, 'r0001'); assert.equal(patch.saveCheckpoint, true); assert.equal(patch.renderPreview, false)
  const next = applyPatchToSpec(spec, patch).spec; assert.equal(validateSceneSpec(next).ok, true)
  assert.deepEqual(next.project.referenceImages, [reference]); assert.equal(next.assets.length, 1); assert.equal(spec.project.referenceImages, undefined)
})

test('upload is binary, shows a hash-pinned thumbnail and creates no revision before Save brief', async t => {
  const { store, calls, field, nodes, projects } = await client(t)
  await store.actions.uploadReferences([file])
  assert.equal(calls.length, 1); assert.equal(calls[0].body, file); assert.equal(calls[0].headers['content-type'], 'image/png')
  assert.equal(calls[0].query.get('name'), file.name); assert.equal(projects.one.revision, 'r0001')
  const draft = store.getState().briefDrafts.one
  assert.equal(draft.referenceImages.length, 1); assert.equal(draft.referenceImages[0].label, file.name)
  const thumbnail = nodes().find(node => node.tag === 'img' && node.props.alt === file.name)
  assert.ok(thumbnail.props.src.startsWith('/deepblend/artifacts/one/assets/raw/')); assert.ok(thumbnail.props.src.includes(sha))
  field('brief-goal').props.onChange({ target: { value: 'Updated goal' } })
  await store.actions.saveBrief(); await waitFor(store, state => state.currentRevision === 'r0002' && state.briefDrafts.one)
  assert.equal(calls.length, 2); assert.equal(calls[1].body.patch.operations.at(-1).goal, 'Updated goal')
  assert.equal(projects.one.spec.project.referenceImages[0].sha256, sha); assert.equal(store.getState().briefDrafts.one.goal, 'Updated goal')
  assert.equal(brief.dirty(store.getState().briefDrafts.one), false)
})

test('invalid files, excessive counts and invalid purposes are stopped without a write', async t => {
  const { store, calls, action } = await client(t)
  for (const invalid of [{ ...file, type: 'image/gif' }, { ...file, size: 8 * 1024 * 1024 + 1 }, { ...file, size: 0 }]) await store.actions.uploadReferences([invalid])
  await store.actions.uploadReferences(Array.from({ length: 5 }, () => file)); assert.equal(calls.length, 0)
  await store.actions.uploadReferences([file]); const id = store.getState().briefDrafts.one.referenceImages[0].id
  store.actions.updateBrief('purposes', [], id); assert.equal(action('brief-save').props.disabled, true)
  await store.actions.saveBrief(); assert.equal(calls.length, 1)
  store.actions.removeReference(id); assert.equal(brief.dirty(store.getState().briefDrafts.one), false)
})

test('polling preserves brief edits and old revision conflicts until explicit reset', async t => {
  const { store, projects, calls, field, action } = await client(t)
  store.actions.updateBrief('goal', 'My unsaved goal')
  projects.one.spec.project.goal = 'Peer goal'; projects.one.revision = 'r0002'
  store.actions.reload(); await waitFor(store, state => state.currentRevision === 'r0002')
  assert.equal(field('brief-goal').props.value, 'My unsaved goal'); assert.equal(action('brief-save').props.disabled, true)
  await store.actions.saveBrief(); assert.equal(calls.length, 0)
  store.actions.resetBrief(); assert.equal(field('brief-goal').props.value, 'Peer goal'); assert.equal(store.getState().briefDrafts.one.baseRevision, 'r0002')
})

test('an upload completing after a project switch stays attached to the originating draft', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { store } = await client(t, { onPost: () => pending })
  store.actions.updateBrief('goal', 'One draft')
  const upload = store.actions.uploadReferences([file])
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two')
  store.actions.updateBrief('goal', 'Two draft'); finish(); await upload
  assert.equal(store.getState().briefDrafts.one.referenceImages.length, 1); assert.equal(store.getState().briefDrafts.two.referenceImages.length, 0)
  assert.equal(store.getState().briefDrafts.two.goal, 'Two draft'); assert.equal(store.getState().activeProjectId, 'two')
  store.actions.selectProject('one'); await waitFor(store, state => state.activeProjectId === 'one')
  assert.equal(store.getState().briefDrafts.one.goal, 'One draft')
})

test('failed save preserves staged assets and all reference annotations for retry', async t => {
  const { store, fail, calls } = await client(t)
  await store.actions.uploadReferences([file]); const id = store.getState().briefDrafts.one.referenceImages[0].id
  store.actions.updateBrief('notes', 'Preserve this note', id); store.actions.updateBrief('purposes', ['geometry', 'lighting'], id)
  const before = clone(store.getState().briefDrafts.one); fail({ code: 'REVISION_CONFLICT', message: 'Controlled concurrent write' })
  await store.actions.saveBrief(); assert.deepEqual(clone(store.getState().briefDrafts.one), before)
  assert.equal(calls.at(-1).body.patch.operations[0].asset.sha256, sha)
})

test('review and correction only run on explicit clicks against saved revisions and use a bounded round selection', async t => {
  const { store, calls, action } = await client(t)
  store.actions.reload(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls.length, 0)
  store.actions.updateBrief('goal', 'Uncommitted'); assert.equal(action('project-review').props.disabled, true)
  await store.actions.runVisual('review'); assert.equal(calls.length, 0)
  store.actions.resetBrief(); await store.actions.runVisual('review')
  assert.deepEqual(calls[0].body, { revision: 'r0001' }); assert.equal(store.getState().view, 'qa')
  store.actions.setVisualIterations(2); await store.actions.runVisual('autofix')
  assert.deepEqual(calls[1].body, { revision: 'r0001', maxIterations: 2 })
  store.actions.setVisualIterations(99); assert.equal(store.getState().visualIterations.one, 2)
})

test('actual reference IDs and preparation failure are visible without inventing a reference pass', async t => {
  const qaReview = { score: 99, pass: true, referenceImages: [{ ...reference, ...image }], reviewInputsDigest: otherSha,
    referenceInputError: { code: 'ASSET_HASH_MISMATCH', message: 'Reference changed' }, artistic: { status: 'unassessable', dimensions: {} } }
  const { store, nodes } = await client(t, { qaReview, review: { referenceInputError: qaReview.referenceInputError } })
  await store.actions.runVisual('review')
  assert.equal(store.getState().visualRuns.one.error, 'Reference changed')
  assert.equal(nodes().find(node => node.props['data-reviewed-reference-id']).props['data-reviewed-reference-id'], reference.id)
  assert.equal(nodes().find(node => node.props['data-reference-evidence']).props['data-review-inputs-digest'], otherSha)
})


test('a delayed review response never changes the active project or its local brief', async t => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const { store } = await client(t, { onPost: () => pending })
  const review = store.actions.runVisual('review')
  store.actions.selectProject('two'); await waitFor(store, state => state.activeProjectId === 'two')
  store.actions.updateBrief('goal', 'Two stays editable'); finish(); await review
  assert.equal(store.getState().activeProjectId, 'two'); assert.equal(store.getState().view, 'projects')
  assert.equal(store.getState().briefDrafts.two.goal, 'Two stays editable')
  assert.equal(store.getState().visualRuns.two, undefined); assert.equal(store.getState().visualRuns.one.result.revision, 'r0001')
})


test('a failed reviewer is not labeled called successfully or described as finding nothing', async t => {
  const qaReview = { score: 90, pass: true, artistic: { status: 'unassessable', dimensions: {} }, reported: [],
    reviewer: { model: null, error: { code: 'VISUAL_REVIEW_MODEL_UNAVAILABLE', message: 'Configured model is unavailable' } } }
  const { store, nodes } = await client(t, { qaReview })
  store.actions.setView('qa')
  const rendered = JSON.stringify(nodes())
  assert.ok(rendered.includes('review did not complete'))
  assert.ok(rendered.includes('Configured model is unavailable'))
  assert.ok(!rendered.includes('The reviewer reported no findings.'))
})
