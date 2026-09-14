/**
 * Load the workbench's client half, and render it without a browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * `packages/deepblend/ui/lib/client.js` is a client package: it registers itself through
 * `window.__ModuleLoader__.load({ id, factory })` and builds its UI with `react.createElement`.
 * Two different questions are worth asking of it in Node, and both need the same three things —
 * a fake module loader, a React stand-in, and a way to walk what a component returns:
 *
 *   1. WHAT DOES IT REGISTER, AND WHERE? (`composition/ui-plane.e2e.mjs`) Nothing needs to
 *      render; the seat table is the claim.
 *   2. DO THE THINGS IT REGISTERS ACTUALLY RENDER? (`contract/ui-cards.test.mjs`) The sixteen
 *      tool cards are the most visible part of this plugin inside a conversation, and until
 *      this module existed they were asserted to EXIST and never once invoked.
 *
 * So the loader lives here, and both callers use it. A second copy of "how do you load this
 * bundle" is the shape of defect this repository has paid for repeatedly (D38/D43/D57/D60).
 *
 * THE RENDERER IS SMALL ON PURPOSE
 * --------------------------------
 * It calls function components directly and walks the element tree they return. It is NOT React:
 * no reconciliation, no state updates, no effects, no event handling. What it does prove is that
 * every component's render path survives its props — which is the class of defect a card can
 * have without any assertion noticing.
 *
 * Owner: DeepBlend Studio — M5
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { ROOT } from '../../tools/workspace-layout.mjs'

/** The client half, and the package id its module registers under. */
export const UI_PACKAGE = join(ROOT, 'packages', 'deepblend', 'ui')
export const UI_MODULE_ID = '@deepblend/dsh-blender-ui'

/**
 * A React stand-in that produces a walkable tree.
 *
 * `createElement` returns a plain node rather than `null`, which is the difference between
 * "the components are never invoked here, only handed over" (the older comment in
 * `ui-plane.e2e.mjs`) and being able to render them. `useState` returns its initial value and
 * an update function that does nothing: a component that calls a setter DURING render would
 * loop under React, and here it simply has no effect, which is the honest behaviour for a
 * one-pass renderer.
 */
export function makeReactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/**
 * Load `client.js` the way the page does.
 *
 * @param {{ react?: object }} [options]
 * @returns {{ moduleId: string, exports: object, source: string }}
 */
export function loadClientBundle(options = {}) {
  const react = options.react ?? makeReactStub()
  const source = readFileSync(join(UI_PACKAGE, 'lib', 'client.js'), 'utf8')

  let captured = null
  const window = { __ModuleLoader__: { load: entry => { captured = entry } } }
  runInNewContext(source, {
    window,
    document: undefined,
    JSON, Object, Array, String, Number, Boolean, Math, Error, Set, Map, Promise, console,
  })
  if (captured === null || typeof captured.factory !== 'function') {
    throw new Error('client.js did not register a module through window.__ModuleLoader__.load')
  }

  const exports = captured.factory(specifier => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return react
    throw new Error(`the client bundle required an unexpected module: ${specifier}`)
  })

  return { moduleId: captured.id, exports, source }
}

/**
 * Run the client half's `apply` against a registry that records instead of rendering.
 *
 * @param {object} exports - from {@link loadClientBundle}
 * @returns {{ registrations: {options: object, component: Function}[], injected: string[], effects: string[] }}
 */
export function mountClient(exports) {
  const registrations = []
  const injected = []
  const effects = []
  const context = {
    effect(callback, label) {
      effects.push(label ?? 'effect')
      return callback()
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(context)
  return { registrations, injected, effects }
}

/** A node the renderer produced: a host tag, its props, and its rendered children. */
const HOST = Symbol('host')

/**
 * Render an element tree by calling every function component in it.
 *
 * @param {unknown} element
 * @param {{ depth?: number, maxDepth?: number }} [options]
 * @returns {unknown} host nodes as `{ tag, props, children }`, text as strings
 */
export function renderTree(element, options = {}) {
  const depth = options.depth ?? 0
  const maxDepth = options.maxDepth ?? 200
  if (depth > maxDepth) throw new Error(`renderTree went ${depth} levels deep, which is a cycle rather than a tree`)

  if (element === null || element === undefined || element === false || element === true) return null
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(child => renderTree(child, { depth: depth + 1, maxDepth }))
  if (typeof element !== 'object') return null

  if (typeof element.type === 'function') {
    // A function component. Called directly: this is the whole point, and the reason a crash
    // inside it is a test failure rather than a blank cell in a page nobody looked at.
    const name = element.type.name || 'anonymous component'
    let rendered
    try {
      rendered = element.type(element.props ?? {})
    } catch (cause) {
      throw new Error(`${name} threw while rendering: ${cause?.message ?? String(cause)}`)
    }
    return renderTree(rendered, { depth: depth + 1, maxDepth })
  }

  if (typeof element.type === 'string') {
    return {
      [HOST]: true,
      tag: element.type,
      props: element.props ?? {},
      children: renderTree(element.props?.children, { depth: depth + 1, maxDepth }),
    }
  }

  // `Symbol.for('react.fragment')` and friends: a symbol type with children and nothing else.
  return renderTree(element.props?.children, { depth: depth + 1, maxDepth })
}

/** Every host node in a rendered tree, in document order. */
export function findNodes(tree, predicate = () => true) {
  const found = []
  const walk = node => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (node[HOST] === true && predicate(node)) found.push(node)
    walk(node.children)
  }
  walk(tree)
  return found
}

/** The first host node with this tag name. */
export function findNode(tree, tag) {
  return findNodes(tree, node => node.tag === tag)[0] ?? null
}

/** All the text in a rendered tree, joined — what a reader would see. */
export function textOf(tree) {
  const parts = []
  const walk = node => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node === 'string') { parts.push(node); return }
    if (typeof node !== 'object') return
    walk(node.children)
  }
  walk(tree)
  return parts.join(' ')
}
