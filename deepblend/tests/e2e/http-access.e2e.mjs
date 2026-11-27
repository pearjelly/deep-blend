#!/usr/bin/env node
/** Real DSH owner login and native workbench access, with no model calls. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, fetchFromWebServer, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS ?? join(REPO_ROOT, '.deepblend/quality', 'http-access-' + Date.now()))
assert(!existsSync(output))
mkdirSync(output, { recursive: true })
const store = join(output, 'store')
const id = 'http-owner-control'
const checks = []

function snapshot(root) {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name)
    return [path.slice(root.length + 1), createHash('sha256').update(readFileSync(path)).digest('hex')]
  }).sort(([a], [b]) => a.localeCompare(b)))
}

function check(name, ok) {
  checks.push({ name, ok })
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name)
  assert(ok, name)
}

async function browserPost(page, path, body) {
  return page.evaluate('(async () => {'
    + 'const response = await fetch(' + JSON.stringify(path) + ', { method: "POST", headers: { "content-type": "application/json" },'
    + 'body: ' + JSON.stringify(JSON.stringify(body)) + ' });'
    + 'return { status: response.status, body: await response.json() };'
    + '})()')
}

let server, browser, page, failure, shutdown
try {
  const rows = JSON.parse(await storePatch(store))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = process.env.DEEPBLEND_BLENDER_PATH
    ?? join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows) })
  const base = new URL(server.url).origin
  const projects = '/deepblend/projects'
  const workbench = '/deepblend/workbench'
  const patch = projects + '/' + id + '/patch'
  for (const path of [projects, '/deepblend/diagnostics', '/deepblend/not-a-route']) {
    const response = await fetch(base + path)
    const body = await response.json()
    check(path + ' requires a DSH session before exposing data or route metadata',
      response.status === 401 && body.error?.code === 'UI_HTTP_AUTH_REQUIRED' && !body.error.detail)
  }
  const invalid = await fetch(base + projects, { headers: { cookie: 'invalid=not-a-session' } })
  check('an invalid cookie is refused', invalid.status === 401)
  await invalid.arrayBuffer()
  const cli = await fetchFromWebServer(base + projects)
  check('a DSH-issued owner session permits the intended CLI read', cli.status === 200)
  await cli.arrayBuffer()
  const unrelated = await fetchFromWebServer(base + projects, { headers: { origin: 'https://unrelated.example' } })
  check('an owner session still follows the DSH Origin policy', unrelated.status === 403)
  await unrelated.arrayBuffer()

  browser = await Browser.launch()
  page = await browser.newPage()
  await page.goto(base + workbench)
  check('anonymous browser navigation cannot mount the private workbench',
    await page.evaluate('document.getElementById("deepblend-workbench") === null'))
  await page.goto(server.url)
  await page.goto(base + workbench)
  await page.waitFor('document.getElementById("deepblend-workbench")?.dataset.deepblendStandalone === "ready"', 30000)
  check('the real DSH launch URL signs in to the standalone workbench', await page.evaluate('location.search === ""'))

  const title = 'HTTP owner control'
  const sceneSpec = defaultSceneSpec({ projectId: id, title, goal: 'Access-boundary fixture' })
  const saved = await browserPost(page, projects, { projectId: id, title, sceneSpec, renderPreview: false })
  const project = join(store, 'projects', id)
  const current = () => JSON.parse(readFileSync(join(project, 'project.json'))).currentRevision
  check('the authenticated browser saves the first native revision',
    saved.status === 200 && saved.body.ok && current() === 'r0001' && existsSync(join(project, 'revisions/r0001/scene.blend')))

  const original = snapshot(project)
  const anonymous = await fetch(base + patch, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check('anonymous write routes require a session before validating the input', anonymous.status === 401)
  await anonymous.arrayBuffer()
  check('the refused request leaves every saved project file unchanged',
    JSON.stringify(snapshot(project)) === JSON.stringify(original))

  const continued = await browserPost(page, patch, { patch: {
    projectId: id, baseRevision: 'r0001', saveCheckpoint: true, renderPreview: false,
    operations: [{ op: 'project.brief.set', goal: 'Authenticated owner continuation', referenceImages: [] }],
  } })
  check('the authenticated browser also saves the next native revision',
    continued.status === 200 && continued.body.ok && current() === 'r0002' && existsSync(join(project, 'revisions/r0002/scene.blend')))
  const next = snapshot(project)
  check('continuation preserves every earlier revision file',
    Object.entries(original).filter(([name]) => name.startsWith('revisions/r0001/')).every(([name, digest]) => next[name] === digest))
  await page.screenshot(join(output, 'authenticated-workbench.png'))
} catch (error) {
  failure = String(error.stack ?? error).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')
  console.error(failure)
  await page?.screenshot(join(output, 'failure.png')).catch(() => {})
} finally {
  await browser?.close()
  shutdown = await server?.stop()
  writeFileSync(join(output, 'report.json'), JSON.stringify({
    status: failure ? 'failed' : 'passed', checks, shutdown, failure,
    scope: 'Real DSH Connection, Chrome login, anonymous and Origin refusal, and native revision creation. No online model calls.',
  }, null, 2) + '\n')
}
console.log('HTTP access boundary: ' + checks.filter(check => check.ok).length + '/' + checks.length + ' checks passed')
if (failure) process.exitCode = 1
