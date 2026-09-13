/**
 * A minimal Chrome DevTools Protocol driver — no dependencies.
 *
 * M4's acceptance is "the browser really shows something", which no unit test
 * can establish. This module is the piece that makes that testable from Node:
 * it launches a real Chrome, opens a real page against a real `dsh web`, and
 * answers questions about the live DOM.
 *
 * Deliberately small and honest: it drives Chrome over the protocol that Chrome
 * itself documents, using Node's own `fetch` and global `WebSocket`. There is no
 * CDP package to install, and nothing here is specific to DeepBlend.
 *
 * Owner: DeepBlend Studio — M4
 * Plane: test tooling (never loaded by the Host or the browser plugin).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Default Chrome location on macOS. */
export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** How long to wait for Chrome's debugging endpoint to answer. */
const LAUNCH_TIMEOUT_MS = 20000

/**
 * Find a TCP port nobody is listening on.
 *
 * Chrome's `--remote-debugging-port=0` does write the chosen port into
 * `DevToolsActivePort`, but reading that file races with startup; asking the OS
 * for a free port and letting Chrome bind it is simpler and has one failure mode
 * (a lost race) that shows up immediately rather than intermittently.
 *
 * @returns {Promise<number>}
 */
export async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Sleep. @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * One page (target) in a driven browser.
 *
 * Every method is a thin wrapper over a CDP command; nothing is cached, so a
 * question always describes the page as it is now. That is the property the M4
 * acceptance test needs ("reload and the authoritative state comes back").
 */
export class BrowserPage {
  /**
   * @param {string} webSocketDebuggerUrl
   * @param {() => void} [onConsole]
   */
  constructor(webSocketDebuggerUrl, onConsole) {
    this._url = webSocketDebuggerUrl
    this._nextId = 1
    this._pending = new Map()
    /** @type {Array<{ type: string, text: string }>} */
    this.consoleLog = []
    this._onConsole = onConsole
    this._socket = null
  }

  /** Open the DevTools socket and enable the domains this driver uses. */
  async connect() {
    this._socket = new WebSocket(this._url)
    await new Promise((resolve, reject) => {
      this._socket.addEventListener('open', () => resolve(undefined), { once: true })
      this._socket.addEventListener('error', (event) => reject(new Error(`devtools socket failed: ${String(event?.message ?? event)}`)), { once: true })
    })
    this._socket.addEventListener('message', (event) => this._receive(event.data))
    await this.send('Runtime.enable')
    await this.send('Page.enable')
    return this
  }

  /** @param {string} raw */
  _receive(raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this._pending.get(message.id)
      if (entry === undefined) return
      this._pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params?.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type))
        .join(' ')
      this.consoleLog.push({ type: message.params?.type ?? 'log', text })
      if (this.consoleLog.length > 200) this.consoleLog.shift()
      if (this._onConsole !== undefined) this._onConsole(message.params?.type ?? 'log', text)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails
      const text = details?.exception?.description ?? details?.text ?? 'unknown exception'
      this.consoleLog.push({ type: 'exception', text })
      if (this._onConsole !== undefined) this._onConsole('exception', text)
    }
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method })
      this._socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * The expression is wrapped so that a returned promise is awaited and the
   * value is transported as JSON — callers get plain data, never remote objects.
   *
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expression}) })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`evaluate failed: ${text}`)
    }
    return result.result?.value
  }

  /**
   * Install a script that runs in every new document, before the page's own code.
   *
   * Needed by any assertion about what the page DID rather than what it now shows:
   * a script injected after load disappears on the next navigation, so a reload
   * would silently erase the record — which is exactly the mistake a test is least
   * likely to notice.
   *
   * @param {string} source
   */
  async addInitScript(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
    return this
  }

  /** Navigate and wait for the load event. @param {string} url */
  async goto(url) {
    const loaded = new Promise((resolve) => {
      const listener = (event) => {
        let message
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (message.method === 'Page.loadEventFired') {
          this._socket.removeEventListener('message', listener)
          resolve(undefined)
        }
      }
      this._socket.addEventListener('message', listener)
    })
    await this.send('Page.navigate', { url })
    await loaded
    return this
  }

  /** Reload the current page and wait for load. */
  async reload() {
    await this.send('Page.reload', { ignoreCache: true })
    // `Page.loadEventFired` fires after the command resolves; wait for the
    // document to be interactive instead of racing the event registration.
    await this.waitFor('document.readyState === "complete"', 15000)
    return this
  }

  /**
   * Poll an expression until it is truthy.
   * @param {string} expression
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} the first truthy value
   */
  async waitFor(expression, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    let last
    for (;;) {
      try {
        last = await this.evaluate(expression)
        if (last) return last
      } catch (error) {
        last = String(error)
      }
      if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${expression} (last: ${JSON.stringify(last)})`)
      await sleep(100)
    }
  }

  /** Current DOM text of a selector, or null. @param {string} selector */
  text(selector) {
    return this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null })()`)
  }

  /** Count matches of a selector. @param {string} selector */
  count(selector) {
    return this.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  }

  /** All attribute values of matches. @param {string} selector @param {string} attribute */
  attributes(selector, attribute) {
    return this.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((el) => el.getAttribute(${JSON.stringify(attribute)}))`)
  }

  /**
   * Click the first element matching a selector, the way a user's pointer would.
   *
   * The mouse events go to the element's own centre. When something else is on
   * top of that point — a modal backdrop, the shell's expanded-sidebar mask — the
   * point belongs to the overlay and a synthetic press there would be testing the
   * overlay instead. In that case the element's own `click()` is dispatched, and
   * the caller can see which path was taken: a UI that is only reachable when the
   * pointer is dispatched programmatically is a UI whose layout hides its own
   * controls, and that is worth knowing.
   *
   * @param {string} selector
   * @returns {Promise<{ via: 'pointer'|'dom' }>}
   */
  async click(selector) {
    const target = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const rect = el.getBoundingClientRect()
      const x = rect.x + rect.width / 2
      const y = rect.y + rect.height / 2
      const top = document.elementFromPoint(x, y)
      return { x, y, reachable: top !== null && (top === el || el.contains(top) || top.contains(el)) }
    })()`)
    if (target === null) throw new Error(`click: no element matches ${selector}`)
    if (target.reachable) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, buttons: 0 })
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 })
      }
      return { via: 'pointer' }
    }
    await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.click(); return true })()`)
    return { via: 'dom' }
  }

  /**
   * Type into an input or textarea, through the events a real keystroke sends.
   *
   * React reads `value` from the DOM node but tracks the last value it rendered,
   * so assigning `el.value` alone is silently ignored on the next render. The
   * native setter plus a bubbling `input` event is what a user's typing looks
   * like from the component's side.
   *
   * @param {string} selector
   * @param {string} value
   */
  async fill(selector, value) {
    const filled = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const prototype = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    if (filled !== true) throw new Error(`fill: no element matches ${selector}`)
    await sleep(30)
    return this
  }

  /** Save a PNG of the current viewport. @param {string} path */
  async screenshot(path) {
    const { writeFileSync } = await import('node:fs')
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }

  /** Close this page. */
  async close() {
    try {
      await this.send('Page.close')
    } catch {
      // Closing the target tears the socket down; that is the expected outcome.
    }
    try {
      this._socket?.close()
    } catch {
      // already gone
    }
  }
}

/** A launched Chrome with its own profile directory. */
export class Browser {
  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {number} port
   * @param {string} userDataDir
   */
  constructor(child, port, userDataDir) {
    this.child = child
    this.port = port
    this.userDataDir = userDataDir
    /** @type {BrowserPage[]} */
    this.pages = []
  }

  /**
   * Launch Chrome with remote debugging and wait until it answers.
   * @param {{ chromePath?: string, headless?: boolean, args?: string[] }} [options]
   * @returns {Promise<Browser>}
   */
  static async launch(options = {}) {
    const chromePath = options.chromePath ?? process.env.DEEPBLEND_CHROME ?? DEFAULT_CHROME
    const headless = options.headless !== false
    const userDataDir = mkdtempSync(join(tmpdir(), 'deepblend-chrome-'))
    const port = await freePort()
    const args = [
      ...(headless ? ['--headless=new'] : []),
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
      ...(options.args ?? []),
    ]
    const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const browser = new Browser(child, port, userDataDir)
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) break
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL')
        throw new Error(`Chrome did not expose a debugging endpoint on port ${port} within ${LAUNCH_TIMEOUT_MS}ms`)
      }
      await sleep(100)
    }
    return browser
  }

  /**
   * Open a new page and connect to it.
   * @param {string} [url]
   * @param {{ onConsole?: (type: string, text: string) => void }} [options]
   * @returns {Promise<BrowserPage>}
   */
  async newPage(url = 'about:blank', options = {}) {
    // `/json/new` is a PUT resource in current Chrome; GET is refused with 405.
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!response.ok) throw new Error(`could not open a page: HTTP ${response.status}`)
    const target = await response.json()
    const page = new BrowserPage(target.webSocketDebuggerUrl, options.onConsole)
    await page.connect()
    this.pages.push(page)
    return page
  }

  /** Kill Chrome and remove its profile directory. */
  async close() {
    for (const page of this.pages) await page.close()
    this.child.kill('SIGKILL')
    await sleep(200)
    try {
      rmSync(this.userDataDir, { recursive: true, force: true })
    } catch {
      // a locked profile directory is not worth failing a test over
    }
  }
}
