import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../tools/workspace-layout.mjs'
import { environment, dshLocale, flush, textOf } from '../lib/locale-lifecycle.mjs'

const source = readFileSync(join(ROOT, 'packages/deepblend/ui/lib/client.js'), 'utf8')

test('late DSH Host preference is reflected at first panel mount, including cached tab labels', async t => {
  const env = environment(source), dsh = dshLocale(env)
  t.after(dsh.dispose)
  dsh.host.deliver({ preference: 'zh' })
  await flush()
  const panel = env.mount(env.seat('main'))
  t.after(panel.unmount)
  await flush()
  const text = textOf(panel.tree)
  assert.equal(env.doc.documentElement.lang, 'zh-CN')
  assert.match(text, /Blender 工作台/)
  assert.match(text, /项目/)
  assert.doesNotMatch(text, /Projects/)
})

test('an already mounted standalone view redraws on delayed preference without a Host response or lost draft', async t => {
  const env = environment(source), dsh = dshLocale(env)
  t.after(dsh.dispose)
  const mounted = await env.bundle.mountStandalone(env.root, { fetch: env.fetch })
  t.after(mounted.dispose)
  mounted.store.actions.setForm('title', 'unsaved cup title')
  mounted.store.actions.setForm('frameEnd', '17')
  mounted.store.actions.setView('jobs')
  const snapshot = mounted.store.getState(), requests = env.requests.length, draws = env.root.draws
  dsh.host.deliver({ preference: 'zh' })
  await flush()
  const after = textOf(env.root)
  assert.match(after, /Blender 工作台/)
  assert.match(after, /项目/)
  assert.ok(env.root.draws > draws)
  assert.equal(env.requests.length, requests, 'changing language must not reload the Host')
  assert.equal(mounted.store.getState(), snapshot, 'draft and selected view remain the same store snapshot')
})

test('mounted React panel updates on zh/en switches and unknown locale falls back immediately', async t => {
  const env = environment(source), dsh = dshLocale(env)
  t.after(dsh.dispose)
  const panel = env.mount(env.seat('main'))
  t.after(panel.unmount)
  await flush()
  dsh.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' })
  const states = [], requests = env.requests.length
  for (const locale of ['zh', 'en', 'zh', 'fr']) {
    dsh.locale.setLocale(locale)
    await flush()
    const text = textOf(panel.tree)
    states.push({ locale, lang: env.doc.documentElement.lang, renders: panel.renders, text })
  }
  assert.match(states[0].text, /项目/)
  assert.match(states[1].text, /Projects/)
  assert.match(states[2].text, /项目/)
  assert.match(states[3].text, /Projects/)
  assert.equal(states[3].lang, 'fr', 'the plugin must not overwrite DSH preference to force its fallback')
  assert.equal(env.requests.length, requests)
})

test('React render-to-effect gap rechecks the locale after subscribing', async t => {
  const env = environment(source), dsh = dshLocale(env)
  t.after(dsh.dispose)
  const panel = env.mount(env.seat('main'), {}, { deferEffects: true })
  t.after(panel.unmount)
  dsh.host.deliver({ preference: 'zh' })
  await flush()
  panel.commit()
  await flush()
  const after = textOf(panel.tree)
  assert.match(after, /Blender 工作台/)
  assert.match(after, /项目/)
  assert.ok(panel.renders > 1)
})

test('the final unmount disconnects observers and later changes cannot redraw disposed views', async t => {
  const env = environment(source), dsh = dshLocale(env)
  t.after(dsh.dispose)
  const a = env.mount(env.seat('main')), b = env.mount(env.seat('settings.section'))
  const standalone = await env.bundle.mountStandalone(env.root, { fetch: env.fetch })
  t.after(() => { a.unmount(); b.unmount(); standalone.dispose() })
  const observersMounted = env.observers.size
  a.unmount()
  dsh.locale.setLocale('zh')
  await flush()
  const bText = textOf(b.tree), remaining = env.observers.size
  b.unmount(); standalone.dispose()
  const observersDisposed = env.observers.size, renders = [a.renders, b.renders], draws = env.root.draws
  dsh.locale.setLocale('en')
  await flush()
  assert.equal(observersMounted, 1, 'mounted surfaces share one document observer')
  assert.equal(remaining, 1)
  assert.match(bText, /检测 Blender/)
  assert.equal(observersDisposed, 0)
  assert.deepEqual([a.renders, b.renders], renders)
  assert.equal(env.root.draws, draws)
})

test('standalone language redraw preserves the existing active-press deferral', async t => {
  const env = environment(source), dsh = dshLocale(env)
  t.after(dsh.dispose)
  const mounted = await env.bundle.mountStandalone(env.root, { fetch: env.fetch })
  t.after(mounted.dispose)
  env.root.emit('pointerdown', { pointerId: 9 })
  const draws = env.root.draws
  dsh.locale.setLocale('zh')
  await flush()
  assert.equal(env.root.draws, draws, 'a language change must not replace the currently pressed control')
  env.doc.emit('pointerup', { pointerId: 9 })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.match(textOf(env.root), /项目/)
  assert.ok(env.root.draws > draws)
})

for (const [seat, props, expected, pendingFetch] of [
  ['settings.section', {}, '检测 Blender', true],
  ['tool.call.toolview', { toolName: 'blender_project_get', block: { kind: 'tool-result', call: { argsRaw: '{}' }, content: [], isError: false } }, '详情', true],
  ['conversation.session.header.utilities', {}, '无渲染任务', false],
]) test(`${seat} updates its mounted copy without another response`, async t => {
  const env = environment(source, { pendingFetch }), dsh = dshLocale(env)
  t.after(dsh.dispose)
  const panel = env.mount(env.seat(seat), props)
  t.after(panel.unmount)
  await flush()
  const requests = env.requests.length
  dsh.locale.setLocale('zh')
  await flush()
  const after = textOf(panel.tree)
  assert.ok(after.includes(expected), `expected ${expected}; got ${after}`)
  assert.equal(env.requests.length, requests)
})
