/** A preview and its download address must belong to the work being viewed. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileSceneSpec, buildSceneTree, HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'
import { loadClientBundle } from '../lib/client-bundle.mjs'
const core = loadClientBundle().exports.workbench
const scene = compileSceneSpec(JSON.parse(readFileSync(new URL('../../recipes/metal-lamp/scene-spec.json', import.meta.url)))).spec
const flatten = node => node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(flatten)] : []
const drain = () => new Promise(resolve => setTimeout(resolve, 20))
async function fixture(t, options = {}) {
  const host = { root: '/preview-store/a', projects: options.empty ? [] : ['a', 'b'], failures: new Map(), queues: new Map(), reads: [], writes: [] }
  const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) })
  const preview = (id, name = 'initial') => ({ ok: true, hostApiVersion: HOST_API_VERSION, route: 'project.previews',
    artifactBase: '/deepblend/artifacts/' + id + '/', previews: { projectId: id, currentRevision: 'r0001', revisions: [{ revision: 'r0001', isCurrent: true,
      previews: [{ kind: 'preview', path: 'revisions/r0001/previews/' + id + '-' + name + '.png', sha256: 'a'.repeat(64), width: 32, height: 24 }], contactSheets: [], reviews: [] }] } })
  const store = core.createWorkbenchStore({ pollIdleMs: 999999, pollLiveMs: 999999, fetch: async (input, init = {}) => {
    const u = new URL(String(input), 'http://controlled.test'), id = u.searchParams.get('projectId') || u.pathname.split('/')[3] || host.projects[0]
    if (init.method === 'POST') { host.writes.push(String(input)); throw Error('viewing must not write') }
    if (u.pathname.endsWith('/previews')) {
      host.reads.push(id)
      const queued = host.queues.get(id)?.shift(); if (queued) return await queued
      const failure = host.failures.get(id)
      if (failure === 'network') throw Error('preview network unavailable')
      if (failure) return response(failure.payload, failure.status)
      return response(preview(id))
    }
    const payload = u.pathname.endsWith('/jobs') ? { route: 'project.jobs', jobs: [], unfinished: [] }
      : { route: 'state', projectsRoot: host.root, projects: host.projects.map(projectId => ({ projectId })), selected: id ? {
        project: { projectId: id, title: id, revisionCount: 1 }, currentRevision: 'r0001', revisions: [{ revision: 'r0001' }],
        scene: buildSceneTree(scene, { revision: 'r0001' }), jobs: [], unfinishedJobs: [] } : null }
    return response({ ok: true, hostApiVersion: HOST_API_VERSION, ...payload })
  } })
  t.after(() => store.stop()); store.start()
  const wait = async predicate => { for (let n = 0; n < 100; n++) { if (predicate(store.getState())) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw Error('preview fixture did not settle') }
  await wait(s => host.projects.length ? s.activeProjectId === 'a' && s.previews?.projectId === 'a' : s.status === 'ok')
  const pending = id => { let resolve; const promise = new Promise(r => { resolve = r }); const queue = host.queues.get(id) || []; queue.push(promise); host.queues.set(id, queue); return { payload: (payload, status) => resolve(response(payload, status)), success: (name = 'late') => resolve(response(preview(id, name))), error: () => resolve(response({ ok: false, route: 'project.previews', error: { code: 'PREVIEW_READ_FAILED', message: 'private failed read' } }, 503)) } }
  const nodes = () => flatten(core.renderView({ state: store.getState(), actions: store.actions }))
  return { store, host, response, preview, wait, pending, nodes }
}
const noPreview = state => { assert.equal(state.previews, null); assert.equal(state.artifactBase, ''); assert.equal(state.previewContext, null) }
test('project preview: switching projects immediately retires the old image and address', async t => {
  const f = await fixture(t); f.host.failures.set('b', 'network'); f.store.actions.selectProject('b'); noPreview(f.store.getState()); assert.equal(f.store.getState().previewReadStatus, 'loading')
})
test('project preview: failed B read cannot reuse A under the B heading', async t => {
  const f = await fixture(t); f.host.failures.set('b', 'network'); f.store.actions.selectProject('b'); await f.wait(s => s.activeProjectId === 'b'); noPreview(f.store.getState()); assert.equal(f.host.writes.length, 0)
})
test('project preview: network failure has a visible error and explicit refresh', async t => {
  const f = await fixture(t); f.host.failures.set('b', 'network'); f.store.actions.selectProject('b'); await f.wait(s => s.activeProjectId === 'b'); f.store.actions.setView('preview');
  assert.equal(f.store.getState().error?.code, 'UI_FETCH_FAILED'); assert.equal(f.store.getState().previewReadStatus, 'error'); assert.ok(f.nodes().some(n => n.props?.['data-action'] === 'preview-reload')); assert.equal(f.host.writes.length, 0)
})
test('project preview: refresh recovers the selected project without creating or rendering', async t => {
  const f = await fixture(t); f.host.failures.set('b', 'network'); f.store.actions.selectProject('b'); await f.wait(s => s.activeProjectId === 'b'); f.store.actions.setView('preview'); const refresh = f.nodes().find(n => n.props?.['data-action'] === 'preview-reload'); assert.ok(refresh); assert.equal(typeof refresh.props.onClick, 'function'); f.host.failures.delete('b'); await refresh.props.onClick(); await f.wait(s => s.previews?.projectId === 'b');
  assert.equal(f.store.getState().artifactBase, '/deepblend/artifacts/b/'); assert.equal(f.store.getState().previewContext?.projectId, 'b'); assert.equal(f.store.getState().previewContext?.projectsRoot, '/preview-store/a'); assert.equal(f.store.getState().previewReadStatus, 'ok'); assert.equal(f.store.getState().error, null); assert.equal(f.host.writes.length, 0)
})
for (const kind of ['host-error', 'http-error', 'other-project', 'other-envelope', 'missing-project', 'other-address', 'missing-address', 'bad-revisions']) test('project preview: refuses ' + kind + ' instead of assigning a wrong image', async t => {
  const f = await fixture(t), payload = f.preview('b'); let status = 200
  if (kind === 'host-error') { payload.ok = false; payload.error = { code: 'PREVIEW_READ_FAILED', message: 'read failed' }; status = 503 }
  if (kind === 'http-error') status = 503
  if (kind === 'other-project') payload.previews.projectId = 'a'
  if (kind === 'other-envelope') payload.projectId = 'a'
  if (kind === 'missing-project') delete payload.previews.projectId
  if (kind === 'other-address') payload.artifactBase = '/deepblend/artifacts/a/'
  if (kind === 'missing-address') payload.artifactBase = ''
  if (kind === 'bad-revisions') payload.previews.revisions = null
  f.host.failures.set('b', { payload, status }); f.store.actions.selectProject('b'); await f.wait(s => s.activeProjectId === 'b'); noPreview(f.store.getState());
  assert.equal(f.store.getState().error?.code, kind === 'host-error' ? 'PREVIEW_READ_FAILED' : kind === 'http-error' ? 'HTTP_503' : 'UI_PREVIEW_MISMATCH'); assert.equal(f.host.writes.length, 0)
})
for (const kind of ['success', 'failure']) test('project preview: delayed A ' + kind + ' cannot replace newer B', async t => {
  const f = await fixture(t), p = f.pending('a'); f.store.actions.reload(); await f.wait(() => f.host.reads.filter(x => x === 'a').length === 2); f.store.actions.selectProject('b'); await f.wait(s => s.previews?.projectId === 'b'); if (kind === 'success') p.success(); else p.error(); await drain();
  assert.equal(f.store.getState().previews?.projectId, 'b'); assert.equal(f.store.getState().artifactBase, '/deepblend/artifacts/b/'); assert.equal(f.store.getState().error, null)
})
for (const kind of ['success', 'failure']) test('project preview: an older same-project ' + kind + ' cannot undo a newer refresh', async t => {
  const f = await fixture(t), p = f.pending('a'); f.store.actions.reload(); await f.wait(() => f.host.reads.length === 2); f.store.actions.reload(); await f.wait(() => f.host.reads.length === 3); await drain(); if (kind === 'success') p.success(); else p.error(); await drain();
  assert.ok(f.store.getState().previews); assert.ok(f.store.getState().previews.revisions[0].previews[0].path.endsWith('a-initial.png')); assert.equal(f.store.getState().error, null)
})
test('project preview: changing stores with the same project ID cannot keep old-store pixels after failure', async t => {
  const f = await fixture(t); f.host.root = '/preview-store/b'; f.host.failures.set('a', 'network'); f.store.actions.reload(); await f.wait(s => s.projectsRoot === f.host.root); noPreview(f.store.getState()); assert.equal(f.store.getState().error?.code, 'UI_FETCH_FAILED')
})
test('project preview: successful same-ID store switch records the new source context', async t => {
  const f = await fixture(t); f.host.root = '/preview-store/b'; f.store.actions.reload(); await f.wait(s => s.projectsRoot === f.host.root); assert.equal(f.store.getState().previewContext?.projectsRoot, '/preview-store/b'); assert.equal(f.store.getState().previewContext?.projectId, 'a')
})
test('project preview: failed refresh preserves unsubmitted edits while retiring old pixels', async t => {
  const f = await fixture(t); f.store.actions.setForm('patch', 'unsaved scene adjustment'); f.host.failures.set('a', 'network'); const n = f.host.reads.length; f.store.actions.reload(); await f.wait(() => f.host.reads.length > n); await drain();
  noPreview(f.store.getState()); assert.equal(f.store.getState().forms.patch, 'unsaved scene adjustment'); assert.equal(f.store.getState().patchDrafts.a, 'unsaved scene adjustment'); assert.equal(f.host.writes.length, 0)
})
test('project preview: returning to A restores its draft and its own image', async t => {
  const f = await fixture(t); f.store.actions.setForm('patch', 'draft for A'); f.store.actions.selectProject('b'); await f.wait(s => s.previews?.projectId === 'b'); f.store.actions.selectProject('a'); await f.wait(s => s.previews?.projectId === 'a'); assert.equal(f.store.getState().forms.patch, 'draft for A'); assert.equal(f.store.getState().artifactBase, '/deepblend/artifacts/a/'); assert.equal(f.host.writes.length, 0)
})
test('project preview: valid empty history is different from a failed read', async t => {
  const f = await fixture(t), payload = f.preview('b'); payload.previews.revisions = []; f.host.failures.set('b', { payload, status: 200 }); f.store.actions.selectProject('b'); await f.wait(s => s.activeProjectId === 'b'); assert.equal(f.store.getState().previews.revisions.length, 0); assert.equal(f.store.getState().previewReadStatus, 'ok'); assert.equal(f.store.getState().error, null)
})
test('project preview: an empty workspace has an idle preview state', async t => {
  const f = await fixture(t, { empty: true }); noPreview(f.store.getState()); assert.equal(f.store.getState().previewReadStatus, 'idle')
})
test('project preview: stopping the store retires its pending read', async t => {
  const f = await fixture(t), p = f.pending('a'); f.store.actions.reload(); await f.wait(() => f.host.reads.length === 2); f.store.stop(); p.success(); await drain(); assert.ok(f.store.getState().previews); assert.ok(f.store.getState().previews.revisions[0].previews[0].path.endsWith('a-initial.png'))
})
