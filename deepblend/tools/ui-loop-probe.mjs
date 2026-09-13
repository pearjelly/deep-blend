/**
 * The M4 development-loop probe: **edit one line of client code — how does it
 * reach the browser?**
 *
 * `docs/m4-brief.md` §3 asks for this to be measured before any UI is designed,
 * because the answer decides the cost of every later iteration, and because it
 * is the one thing about the client plane that cannot be read off the docs. The
 * three candidates differ by an order of magnitude:
 *
 *   A. save → refresh the page
 *   B. save → restart `dsh web` → refresh
 *   C. a separate watcher/build step is required
 *
 * This tool answers it with a real browser: it opens a real page, changes one
 * line of `packages/deepblend/ui/lib/client.js`, and watches the live DOM
 * without touching the page. If the DOM changes on its own, the answer is
 * "neither A nor B" — the client-plugin reload chain did it.
 *
 * Usage:
 *   node deepblend/tools/ui-loop-probe.mjs --url "http://127.0.0.1:3099/?token=…"
 *
 * It restores the file it edits, and it never restarts anything.
 *
 * Owner: DeepBlend Studio — M4
 * Plane: test tooling.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Browser } from './browser-driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const CLIENT_FILE = join(REPO, 'packages', 'deepblend', 'ui', 'lib', 'client.js')

/**
 * The line this probe edits: the panel's own label.
 *
 * It is a real constant of the shipped UI rather than a probe-only marker, which is
 * the point — the probe measures the loop that the next UI change will actually
 * take, and it names itself in the sidebar's `aria-label`, where a DOM assertion can
 * see it.
 */
const LABEL_PATTERN = /const PANEL_LABEL = '([^']*)'/

/** How long to watch the live page for a change it was not told about. */
const HMR_WINDOW_MS = 8000

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { url: null, screenshot: null, watchMs: HMR_WINDOW_MS }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--url') args.url = argv[++index]
    else if (flag === '--screenshot') args.screenshot = argv[++index]
    else if (flag === '--watch-ms') args.watchMs = Number(argv[++index])
  }
  return args
}

/**
 * Rewrite the panel label in the client file.
 *
 * Written to a temporary file and renamed into place, which is what an editor's
 * save does and what the dev chain needs: a truncating write has a window in
 * which a reader sees a short file, and the bundle watcher polls this exact file
 * every 500 ms. Measured while writing this probe — a plain `writeFileSync` made
 * the loop fail intermittently, and the symptom was the panel and the sidebar
 * entry vanishing together rather than a stale label.
 *
 * @param {string} label
 * @returns {string} the label that was there before
 */
function writeLabel(label) {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  const match = source.match(LABEL_PATTERN)
  if (match === null) throw new Error(`the probe label line is missing from ${CLIENT_FILE}`)
  const temporary = `${CLIENT_FILE}.probe-tmp`
  writeFileSync(temporary, source.replace(LABEL_PATTERN, `const PANEL_LABEL = '${label}'`))
  renameSync(temporary, CLIENT_FILE)
  return match[1]
}

/** The label the page is showing right now, or null when the slot is absent. */
const READ_LABEL = `(() => {
  const button = document.querySelector('button[aria-label^="Blender"]')
  return button === null ? null : button.getAttribute('aria-label')
})()`

/**
 * Watch the live page for a label change, without reloading or navigating.
 * @param {import('./browser-driver.mjs').BrowserPage} page
 * @param {string} expected
 * @param {number} timeoutMs
 * @returns {Promise<number|null>} milliseconds until the change, or null
 */
async function waitForLabel(page, expected, timeoutMs) {
  const started = Date.now()
  for (;;) {
    const label = await page.evaluate(READ_LABEL)
    if (label === expected) return Date.now() - started
    if (Date.now() - started > timeoutMs) return null
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.url === null) throw new Error('--url is required (the dsh web URL including its token)')

  const original = readFileSync(CLIENT_FILE, 'utf8')
  const originalLabel = original.match(LABEL_PATTERN)?.[1]
  if (originalLabel === undefined) throw new Error(`the probe label line is missing from ${CLIENT_FILE}`)

  const results = []
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }

  // A desktop viewport, deliberately: on a narrow one the shell turns the sidebar
  // into an overlay that CLOSES when a panel is selected, and the entry the probe
  // measures stops being in the page — measured, after a first run reported "no
  // change within 8000ms" while HMR was in fact working.
  const browser = await Browser.launch({ args: ['--window-size=1400,900'] })
  try {
    const page = await browser.newPage('about:blank', {
      // A swap that fails says so here and nowhere else, so the probe listens.
      onConsole: (type, text) => {
        if (type === 'error' || type === 'exception') console.log(`[page ${type}] ${text.slice(0, 200)}`)
      },
    })
    await page.addInitScript(`
      window.__m4ProbeRequests = []
      const probeFetch = window.fetch
      window.fetch = (input, init) => {
        window.__m4ProbeRequests.push(String(input))
        return probeFetch(input, init)
      }
    `)
    await page.goto(args.url)

    // ── the client half is really in this page ──────────────────────────────
    await page.waitFor('document.querySelector("button[aria-label^=\\"Blender\\"]") !== null', 20000)
    const label = await page.evaluate(READ_LABEL)
    record('the client bundle registered a sidebar entry in a real page', label === originalLabel, `aria-label=${JSON.stringify(label)}`)
    record('the icon the plugin drew is in the DOM', await page.count('[data-deepblend-icon]') > 0)

    // ── the panel, selected by clicking the sidebar entry ───────────────────
    await page.click('button[aria-label^="Blender"]')
    await page.waitFor('document.querySelector("[data-deepblend-panel]") !== null', 15000)
    record('selecting the entry renders the workbench panel', await page.count('[data-deepblend-panel=deepblend]') === 1)
    await page.waitFor('window.__m4ProbeRequests.length > 0', 15000)
    const asked = await page.evaluate('window.__m4ProbeRequests.slice()')
    record(
      'the panel reads the Host over HTTP, same origin, on a declared route',
      asked.some(url => url.startsWith('/deepblend/state')),
      asked.slice(0, 4),
    )
    if (args.screenshot !== null) await page.screenshot(args.screenshot)

    // ── measurement 1: content change, no user action ───────────────────────
    // A marker on the window separates "the fiber was swapped in place" from
    // "the page silently reloaded": a reload would erase it.
    await page.evaluate('(window.__m4Probe = { at: Date.now() }, window.__m4Probe.at)')
    const changedLabel = `${originalLabel} edit-1`
    writeLabel(changedLabel)
    const hmrMs = await waitForLabel(page, changedLabel, args.watchMs)
    const survived = await page.evaluate('window.__m4Probe ? window.__m4Probe.at : null')
    record(
      'editing one line reaches an OPEN page with no refresh and no restart',
      hmrMs !== null,
      hmrMs === null ? `no change within ${args.watchMs}ms` : `${hmrMs}ms after the write`,
    )
    if (hmrMs !== null) {
      record(
        'the update happened in the SAME document — a swap, not a silent reload',
        survived !== null,
        survived === null ? 'the page reloaded itself' : `window marker survived (set at ${survived})`,
      )
    }

    // ── measurement 2: if not, does a plain refresh pick it up? ──────────────
    let refreshMs = null
    if (hmrMs === null) {
      const started = Date.now()
      await page.reload()
      refreshMs = await waitForLabel(page, changedLabel, 20000)
      record('a plain page refresh picks up a bundle edit', refreshMs !== null, refreshMs === null ? 'no' : `${Date.now() - started}ms`)
    }

    // A separate observation, and a real one: the shell DESELECTS a main-panel id
    // that is momentarily unregistered, so a swap closes the workbench panel the
    // probe had open. The sidebar entry survives; the selection does not.
    if (hmrMs !== null) {
      const panelAfterSwap = await page.count('[data-deepblend-panel]')
      record(
        'the swap closes a panel that was selected (the shell drops an id that is briefly unregistered)',
        panelAfterSwap === 0,
        panelAfterSwap === 0 ? 'the panel closed; the sidebar entry is still there' : 'the panel stayed open',
      )
    }

    const verdict = hmrMs !== null
      ? 'A-never-happens: the client-plugin reload chain swaps the fiber with no refresh and no restart'
      : refreshMs !== null
        ? 'A: save, then refresh the page'
        : 'B: the running process must be restarted — or the page lost the plugin to a failed swap'
    console.log(`\nverdict: ${verdict}`)
  } finally {
    writeFileSync(CLIENT_FILE, original)
    await browser.close()
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\nui loop probe: ${results.length - failed.length}/${results.length} check(s) passed`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
