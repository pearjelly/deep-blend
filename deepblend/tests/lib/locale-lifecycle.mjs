import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { resolveDshScope } from './dsh-deployment.mjs'

// CPU recorders, not a browser or a substitute for React/browser acceptance.
// Mutation delivery and hook scheduling are explicit, so no store poll or manual
// rerender can accidentally make a missing language subscription look correct.
export const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
export function documentRecorder(initial = '') {
  const observers = new Set()
  const events = target => Object.assign(target, {
    listeners: new Map(),
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn) },
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn) },
    emit(name, event) { for (const fn of this.listeners.get(name) ?? []) fn(event) },
  })
  const doc = events({ activeElement: null, body: {}, head: { children: [], appendChild(node) { this.children.push(node) } },
    querySelector() { return null },
    createTextNode(text) { return { text: String(text) } },
    createDocumentFragment() { return { children: [], appendChild(node) { this.children.push(node) } } },
    createElement(tag) { return events({ tag, attrs: {}, dataset: {}, style: {}, children: [], ownerDocument: doc,
      classList: { add() {} }, setAttribute(key, value) { this.attrs[key] = String(value) },
      appendChild(node) { this.children.push(node) }, querySelector() { return null }, querySelectorAll() { return [] },
      replaceChildren(...children) { this.children = children; this.draws = (this.draws ?? 0) + 1 },
    }) },
  })
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; this.pending = false }
    observe(target, options) { this.target = target; this.options = options; this.active = true; observers.add(this) }
    disconnect() { this.active = false; observers.delete(this) }
    queue() {
      if (this.pending) return
      this.pending = true
      queueMicrotask(() => { this.pending = false; if (this.active) this.callback([{ type: 'attributes', attributeName: 'lang', target: this.target }]) })
    }
  }
  let lang = initial
  doc.documentElement = { get lang() { return lang }, set lang(value) {
    lang = String(value)
    for (const observer of observers) if (observer.target === doc.documentElement && observer.options?.attributes && observer.options.attributeFilter.includes('lang')) observer.queue()
  } }
  doc.defaultView = events({ MutationObserver })
  return { doc, observers, root: doc.createElement('main') }
}

export function hookRecorder() {
  let current = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const r = current, index = r.cursor++
      if (!r.hooks[index]) r.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const state = r.hooks[index]
      return [state.value, value => { const next = typeof value === 'function' ? value(state.value) : value
        if (Object.is(state.value, next)) return
        state.value = next; r.schedule()
      }]
    },
    useRef(initial) { const r = current, index = r.cursor++; return r.hooks[index] ??= { current: initial } },
    useEffect(callback, deps) {
      const r = current, index = r.cursor++, before = r.hooks[index]
      if (!before || !deps || deps.length !== before.deps?.length || deps.some((x, i) => !Object.is(x, before.deps[i]))) {
        r.hooks[index] = { deps, cleanup: before?.cleanup }
        r.effects.push(() => { r.hooks[index].cleanup?.(); r.hooks[index].cleanup = callback() })
      }
    },
  }
  function mount(component, props = {}, { deferEffects = false } = {}) {
    const r = { hooks: [], effects: [], cursor: 0, renders: 0, tree: null, mounted: true, queued: false,
      schedule() { if (!r.mounted || r.queued) return; r.queued = true
        queueMicrotask(() => { r.queued = false; if (r.mounted) { r.render(); r.commit() } }) },
      render() { r.cursor = 0; current = r; try { r.tree = component(props); r.renders++ } finally { current = null } },
      commit() { for (const effect of r.effects.splice(0)) effect() },
      unmount() { r.mounted = false; for (const hook of r.hooks) hook?.cleanup?.() },
    }
    r.render(); if (!deferEffects) r.commit()
    return r
  }
  return { React, mount }
}

export function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(' ')
  if (typeof node.type === 'function') return textOf(node.type(node.props ?? {}))
  if (node.text !== undefined) return node.text
  return textOf(node.props?.children ?? node.children ?? [])
}

function moduleFrom(source, sandbox, resolve) {
  let captured
  sandbox.window.__ModuleLoader__ = { load: entry => { captured = entry } }
  runInNewContext(source, sandbox)
  return captured.factory(resolve)
}

export function environment(source, { lang = '', pendingFetch = true } = {}) {
  const document = documentRecorder(lang), hooks = hookRecorder(), intervals = new Map(), requests = []
  let sequence = 0
  const fetch = async path => {
    requests.push(String(path))
    if (pendingFetch) return new Promise(() => {})
    const payload = String(path).split('?')[0] === '/deepblend/projects'
      ? { ok: true, route: 'projects.list', projects: [] }
      : { ok: true, route: 'state', hostApiVersion: 6, projects: [], selected: null }
    return { status: 200, text: async () => JSON.stringify(payload) }
  }
  const sandbox = { window: {}, document: document.doc, navigator: { languages: ['en-US'], language: 'en-US' },
    console, AbortController, setTimeout, clearTimeout, queueMicrotask, fetch,
    setInterval: (callback, ms) => { const id = ++sequence; intervals.set(id, { callback, ms }); return id },
    clearInterval: id => intervals.delete(id),
  }
  const bundle = moduleFrom(source, sandbox, id => {
    if (id === 'react') return hooks.React
    throw Error(`unexpected plugin import ${id}`)
  })
  const registrations = []
  bundle.apply({ effect: callback => callback(), slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  } })
  const seat = name => registrations.find(item => item.options.name === name).component
  return { ...document, ...hooks, bundle, sandbox, seat, requests, intervals, fetch }
}

// Run the installed DSH locale plugin's real factory/apply/LocaleRuntime.
// Only UI registration and Host settings transport are controlled CPU seams.
export function dshLocale(env) {
  const source = readFileSync(join(resolveDshScope('dsh-client-locale'), 'dsh-client-locale/lib/client.js'), 'utf8')
  const plugin = moduleFrom(source, env.sandbox, id => {
    if (id === 'react' || id === 'react/jsx-runtime' || id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (id === '@deepseek-ai/dsh-client-store') return { defineStore: value => value }
    throw Error(`unexpected DSH locale dependency ${id}`)
  })
  const listeners = new Set(), cleanups = [], changes = [], writes = []
  let value
  const host = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    getSnapshot: () => ({ value }), set: (key, data) => writes.push({ key, data }),
    deliver(next) { value = next; for (const fn of [...listeners]) fn() },
  }
  const ctx = { effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    provide(key, service) { this[key] = service }, emit: (...event) => changes.push(event),
    settingsScope: { bind: () => host }, slots: { installLocale() {}, inject: (_name, callback) => callback(), register() { return () => {} } },
  }
  plugin.apply(ctx)
  return { locale: ctx.locale, host, changes, writes, dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() } }
}
