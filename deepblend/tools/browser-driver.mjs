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
const COMMAND_TIMEOUT_MS = 30000

function cdpError(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, ...detail })
}

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
   * @param {{ commandTimeoutMs?: number, connectTimeoutMs?: number, closeTimeoutMs?: number }} [options]
   */
  constructor(webSocketDebuggerUrl, onConsole, options = {}) {
    this._url = webSocketDebuggerUrl
    this._nextId = 1
    this._pending = new Map()
    /** @type {Array<{ type: string, text: string }>} */
    this.consoleLog = []
    this._onConsole = onConsole
    this._socket = null
    this._eventWaiters = new Set()
    this._connectionError = null
    this._closePromise = null
    this._timeouts = { command: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
      connect: options.connectTimeoutMs ?? 10000, close: options.closeTimeoutMs ?? 2000 }
    for (const value of Object.values(this._timeouts)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('CDP timeouts must be positive timer-safe integers')
    }
  }

  /** Open the DevTools socket and enable the domains this driver uses. */
  async connect() {
    if (this._socket) throw new Error('This DevTools page has already connected')
    this._socket = new WebSocket(this._url)
    this._socket.addEventListener('message', (event) => this._receive(event.data))
    this._socket.addEventListener('error', (event) => this._failConnection(cdpError('CDP_SOCKET_ERROR',
      `devtools socket failed: ${String(event?.message || event?.error?.message || 'WebSocket error')}`)))
    this._socket.addEventListener('close', (event) => this._failConnection(cdpError('CDP_SOCKET_CLOSED',
      `devtools socket closed (code ${event.code ?? 'unknown'}${event.reason ? `, ${event.reason}` : ''})`)))
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer)
          this._socket.removeEventListener('open', opened)
          this._socket.removeEventListener('error', failed)
          this._socket.removeEventListener('close', failed)
          if (error) reject(error); else resolve(undefined)
        }
        const opened = () => finish()
        const failed = () => finish(this._connectionError)
        const timer = setTimeout(() => finish(cdpError('CDP_CONNECT_TIMEOUT',
          `devtools connection timed out after ${this._timeouts.connect}ms`, { timeoutMs: this._timeouts.connect })), this._timeouts.connect)
        this._socket.addEventListener('open', opened)
        this._socket.addEventListener('error', failed)
        this._socket.addEventListener('close', failed)
      })
      await this.send('Runtime.enable')
      await this.send('Page.enable')
      return this
    } catch (error) {
      this._failConnection(error)
      try { this._socket.close() } catch { /* retain the original connection failure */ }
      throw error
    }
  }

  /** Reject every outstanding command/event when the transport can no longer answer. */
  _failConnection(error) {
    this._connectionError ??= error
    for (const entry of [...this._pending.values()]) entry.reject(cdpError(this._connectionError.code,
      `${entry.method}: ${this._connectionError.message}`, { method: entry.method, cause: this._connectionError }))
    for (const waiter of [...this._eventWaiters]) waiter.reject(this._connectionError)
  }

  /** Subscribe before dispatching the command that may immediately emit this event. */
  _waitForEvent(method) {
    let cancel
    const promise = new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this._eventWaiters.delete(waiter) }
      const waiter = { method, resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } }
      const timer = setTimeout(() => waiter.reject(cdpError('CDP_EVENT_TIMEOUT',
        `${method} was not received within ${this._timeouts.command}ms`, { method, timeoutMs: this._timeouts.command })), this._timeouts.command)
      cancel = cleanup
      this._eventWaiters.add(waiter)
      if (this._connectionError) waiter.reject(this._connectionError)
    })
    return { promise, cancel: () => cancel() }
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
      if (message.error !== undefined) entry.reject(cdpError('CDP_PROTOCOL_ERROR', `${entry.method}: ${message.error.message}`,
        { method: entry.method, protocolError: message.error }))
      else entry.resolve(message.result)
      return
    }
    for (const waiter of [...this._eventWaiters]) {
      if (message.method === waiter.method) waiter.resolve(message.params)
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
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  send(method, params = {}, options = {}) {
    if (this._connectionError) return Promise.reject(cdpError(this._connectionError.code,
      `${method}: ${this._connectionError.message}`, { method, cause: this._connectionError }))
    if (this._closePromise && method !== 'Page.close') return Promise.reject(cdpError('CDP_PAGE_CLOSED',
      `${method}: devtools page is closing`, { method }))
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) return Promise.reject(cdpError('CDP_NOT_CONNECTED',
      `${method}: devtools socket is not open`, { method }))
    const id = this._nextId++
    const timeoutMs = options.timeoutMs ?? this._timeouts.command
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) return Promise.reject(new Error('Invalid CDP command timeout'))
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this._pending.delete(id) }
      const entry = { method, resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } }
      const timer = setTimeout(() => entry.reject(cdpError('CDP_COMMAND_TIMEOUT',
        `${method} (command ${id}) timed out after ${timeoutMs}ms; the command was not retried`, { method, commandId: id, timeoutMs })), timeoutMs)
      this._pending.set(id, entry)
      try { this._socket.send(JSON.stringify({ id, method, params })) }
      catch (error) { entry.reject(cdpError('CDP_SEND_FAILED', `${method}: ${error.message || error}`, { method, commandId: id, cause: error })) }
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
    const loaded = this._waitForEvent('Page.loadEventFired')
    try {
      const navigated = this.send('Page.navigate', { url }).then(result => {
        if (result.errorText) throw new Error(`Page.navigate failed: ${result.errorText}`)
      })
      await Promise.all([navigated, loaded.promise])
      return this
    } finally { loaded.cancel() }
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
        // A lost CDP response is a transport failure, not a false DOM predicate.
        // Preserve it immediately so the caller can record evidence and close.
        if (error.code?.startsWith('CDP_') && error.code !== 'CDP_PROTOCOL_ERROR') throw error
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
   * Scroll the element into view before checking its centre, as a person can
   * reach controls below a long form. The mouse events go to that centre. When something else is on
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
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
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
  close() {
    if (this._closePromise) return this._closePromise
    this._closePromise = (async () => {
      try { await this.send('Page.close', {}, { timeoutMs: this._timeouts.close }) }
      catch { /* Closing the target may tear down its socket before it answers. */ }
      finally {
        this._failConnection(cdpError('CDP_PAGE_CLOSED', 'devtools page was closed'))
        try { this._socket?.close() } catch { /* already gone */ }
      }
    })()
    return this._closePromise
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
    const port = await freePort()
    const userDataDir = mkdtempSync(join(tmpdir(), 'deepblend-chrome-'))
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
    let stderr = '', spawnError = null
    child.stdout.resume()
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-32768) })
    child.on('error', error => { spawnError = error })
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    try {
      for (;;) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
          const reason = spawnError?.message ?? (child.exitCode !== null || child.signalCode !== null
            ? `Chrome exited early (code ${child.exitCode}, signal ${child.signalCode})`
            : `Chrome did not expose a debugging endpoint within ${LAUNCH_TIMEOUT_MS}ms`)
          const error = new Error(`${reason}; executable ${chromePath}; port ${port}.\n${stderr}`)
          error.launch = { chromePath, port, userDataDir, exitCode: child.exitCode, signal: child.signalCode, stderr }
          throw error
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
          if (response.ok) break
        } catch {
          // not up yet
        }
        await sleep(100)
      }
      browser.launchFacts = { chromePath, port, get stderr() { return stderr } }
      return browser
    } catch (error) {
      child.kill('SIGKILL')
      await sleep(200)
      rmSync(userDataDir, { recursive: true, force: true })
      throw error
    }
  }

  /**
   * Open a new page and connect to it.
   * @param {string} [url]
   * @param {{ onConsole?: (type: string, text: string) => void, commandTimeoutMs?: number, connectTimeoutMs?: number, closeTimeoutMs?: number }} [options]
   * @returns {Promise<BrowserPage>}
   */
  async newPage(url = 'about:blank', options = {}) {
    // `/json/new` is a PUT resource in current Chrome; GET is refused with 405.
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(options.connectTimeoutMs ?? 10000) })
    if (!response.ok) throw new Error(`could not open a page: HTTP ${response.status}`)
    const target = await response.json()
    const page = new BrowserPage(target.webSocketDebuggerUrl, options.onConsole, options)
    await page.connect()
    this.pages.push(page)
    return page
  }

  /** Kill Chrome and remove its profile directory. */
  async close() {
    await Promise.allSettled(this.pages.map(page => page.close()))
    this.child.kill('SIGKILL')
    await sleep(200)
    try {
      rmSync(this.userDataDir, { recursive: true, force: true })
    } catch {
      // a locked profile directory is not worth failing a test over
    }
  }
}
