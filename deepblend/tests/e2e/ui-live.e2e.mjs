#!/usr/bin/env node
/**
 * M4's live pass: a DeepBlend **tool card** and the session chip, rendered by a
 * real model call in a real session.
 *
 * WHY THIS IS NOT IN `run-all.sh`
 * -------------------------------
 * Everything else M4 delivers is checked without spending anything: the route
 * table, the view models, the seat table and the browser acceptance all run
 * offline (`composition/ui-plane.e2e.mjs`, `tests/e2e/ui.e2e.mjs`). Tool cards
 * are the one deliverable whose evidence IS a model call — a card only exists
 * because a wire tool was called inside a session, and a session only calls a
 * tool because a model decided to.
 *
 * So this suite costs a real model call, exactly like `e2e/visual-live.e2e.mjs`,
 * and it is run deliberately rather than on every suite run. It does NOT skip
 * itself when it cannot run: without a credential store or with the DeepBlend
 * preset missing, it fails and says which one is absent. A live suite that
 * quietly passes for the wrong reason is worse than no live suite.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. The DeepBlend agent preset can be selected in the console for a new session.
 *   2. A message that names a project makes the model call `blender_project_get`.
 *   3. The card this package registers renders FOR THAT CALL — `data-tool-card`
 *      carries the wire tool name, the state resolves to ok, and the card shows the
 *      project id it read from the call's own JSON arguments.
 *   4. The session-header chip is present, which is the other session-scoped seat.
 *
 * Run: node deepblend/tests/e2e/ui-live.e2e.mjs
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Browser } from '../../tools/browser-driver.mjs'
import { REAL_HOME, REPO_ROOT, dismissFirstRunDialogs, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const PRESET_LABEL = 'DeepBlend 开发模式'

// Loud, not silent: each of these is a reason the suite cannot run, and a
// "passed" that means "skipped" is the failure mode this repository refuses.
if (!existsSync(BLENDER_PATH)) {
  console.error(`Blender not found at ${BLENDER_PATH}; the live tool-card pass cannot run.`)
  process.exit(2)
}
if (!existsSync(join(REAL_HOME, '.credentials.yaml'))) {
  console.error(`No credential store at ${join(REAL_HOME, '.credentials.yaml')}; the live tool-card pass needs a model route.`)
  process.exit(2)
}
if (!existsSync(join(REAL_HOME, '.agent-presets', 'deepblend-dev', 'preset.yml'))) {
  console.error('The deepblend-dev preset is not installed; run: node deepblend/tools/install-presets.mjs')
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-ui-live-'))
const store = join(scratch, 'store')
const projectId = `ui-live-${Math.random().toString(16).slice(2, 8)}`

let server = null
let browser = null

try {
  server = await startWeb({ workspacePath: REPO_ROOT, patch: await storePatch(store), keepHome: true })
  console.log(`── test server on ${server.url.split('?')[0]} ──`)

  // The project is made through the Host route, not through the UI: this suite is
  // about the TOOL CARD, and the browser-side project flow has its own suite.
  const created = await fetch(`http://127.0.0.1:${server.port}/deepblend/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: projectId }),
  }).then(response => response.json())
  check('a project exists for the model to read', created.ok === true, created.error?.code ?? created.project?.projectId)

  browser = await Browser.launch({ args: ['--window-size=1500,950'] })
  const page = await browser.newPage('about:blank')
  await page.goto(server.url)
  await dismissFirstRunDialogs(page)
  await page.waitFor(`document.querySelector('[contenteditable="true"]') !== null`, 30000)

  // ── 1. the preset is selectable ──────────────────────────────────────────
  const opened = await page.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(candidate => (candidate.textContent || '').trim() === '标准模式')
    if (!button) return false
    button.click()
    return true
  })()`)
  check('the new-session screen offers the agent-preset control', opened === true)
  await page.waitFor(`Array.from(document.querySelectorAll('*')).some(element => (element.textContent || '').trim().startsWith(${JSON.stringify(PRESET_LABEL)}))`, 20000)
  const selected = await page.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem], [role=option], li, button, div'))
      .filter(element => (element.textContent || '').trim().startsWith(${JSON.stringify(PRESET_LABEL)}))
    const item = items[items.length - 1]
    if (!item) return false
    item.click()
    return true
  })()`)
  check('the DeepBlend preset can be selected for a new session', selected === true)
  await page.waitFor(`Array.from(document.querySelectorAll('button')).some(button => (button.textContent || '').trim() === ${JSON.stringify(PRESET_LABEL)})`, 20000)
  check('the console shows the DeepBlend preset as the session\'s preset',
    (await page.evaluate(`Array.from(document.querySelectorAll('button')).map(button => (button.textContent || '').trim()).includes(${JSON.stringify(PRESET_LABEL)})`)) === true)

  // ── 2. the model is asked to call a DeepBlend tool ───────────────────────
  const message = `调用 blender_project_get，projectId 用 ${projectId}，然后只回一句话。`
  await page.evaluate(`(() => {
    const editor = document.querySelector('[contenteditable="true"]')
    editor.focus()
    document.execCommand('insertText', false, ${JSON.stringify(message)})
    return editor.textContent.length
  })()`)
  await page.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="发送消息"]')
    if (button) button.click()
    return button !== null
  })()`)

  // ── 3. the card for that call ────────────────────────────────────────────
  await page.waitFor(`document.querySelector('[data-tool-card]') !== null`, 300000)
  const cards = await page.attributes('[data-tool-card]', 'data-tool-card')
  check('the call rendered through this package\'s card, keyed by the wire tool name',
    cards.includes('blender_project_get'), cards)
  const states = await page.attributes('[data-tool-card]', 'data-tool-state')
  check('the card resolves the finished call to a real outcome rather than staying at running',
    states.includes('ok'), states)
  const cardText = await page.text('[data-tool-card="blender_project_get"]')
  check('the card shows the project the model actually asked for',
    (cardText ?? '').includes(projectId), (cardText ?? '').replace(/\s+/g, ' ').slice(0, 120))
  check('the card offers the tool result for inspection',
    (await page.count('[data-tool-card="blender_project_get"] [data-action="toggle-card"]')) === 1)

  // ── 4. the other session-scoped seat ─────────────────────────────────────
  check('the session-header chip is registered and rendering',
    (await page.count('[data-deepblend-chip="jobs"]')) === 1,
    await page.text('[data-deepblend-chip="jobs"]'))

  await page.screenshot('/tmp/deepblend-m4-toolcard.png')
  console.log('screenshot: /tmp/deepblend-m4-toolcard.png')
} catch (cause) {
  check('the live pass completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  if (browser !== null) await browser.close().catch(() => {})
  if (server !== null) await server.stop().catch(() => {})
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok)
console.log(`\nM4 live UI pass: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
