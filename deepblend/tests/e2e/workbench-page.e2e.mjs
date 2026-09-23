#!/usr/bin/env node
/**
 * M6 acceptance: the standalone fullscreen workbench, in a real browser.
 *
 * SPEC §20 M6's item is one line — 「独立全屏工作台」 — with no acceptance block of
 * its own, so it inherits M4's four conditions. What this file adds is the
 * question M4 never asked, because M4's panel only ever existed inside the
 * console:
 *
 *   **把外壳拿掉，它还站得住吗？**
 *
 * So the page under test is `GET /deepblend/workbench` — the plugin's own route,
 * served by the same `dsh web` process (no second server, no second port), with
 * no shell bundle, no sidebar and no conversation anywhere in the document. The
 * four inherited conditions are then read off THAT page:
 *
 *   不进入文件系统即可管理项目        create a project, change a scene and render a
 *                                    preview by clicking, then read the store on disk
 *   UI 刷新后可从 Host 恢复权威状态    reload and read the same project and revision
 *                                    back out of the DOM, and out of the request log
 *   浏览器不直接启动 Blender          the Blender that rendered is a child of the
 *                                    Host process, and the page's own fetch log
 *                                    contains nothing but declared routes
 *   所有写操作经过 Host              every write the page performed is a declared
 *                                    POST route, and it landed on disk through the
 *                                    facade
 *
 * AND THE ONE THING THIS MILESTONE COULD GET WRONG
 * ------------------------------------------------
 * A full-screen workbench is one edit away from being a SECOND implementation of
 * the M4 workbench. The structural half of that claim is asserted in
 * `contract/workbench-page.test.mjs`; the half that only a browser can settle is
 * asserted here, as a fact about the network:
 *
 *   **the page fetched the workbench bundle from the URL the boot graph declares
 *   for it** — `window.__DSH_BOOT__.entries[id].url`, the very row the console
 *   preloads. Not a copy, not a sibling file, not a bundled second panel.
 *
 * WHAT IS REAL HERE
 * -----------------
 * A real Chrome (headless), driven over the DevTools protocol by
 * `tools/browser-driver.mjs`; a real `dsh web` started by `tools/dsh-web-harness.mjs`
 * in its own DSH home AND its own project store; a real Blender, started by that
 * Host. The only thing this suite starts is a browser and a server it then stops.
 *
 * Run: node deepblend/tests/e2e/workbench-page.e2e.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
if (!existsSync(BLENDER_PATH)) {
  console.error(`Blender not found at ${BLENDER_PATH}; the standalone workbench acceptance cannot run.`)
  console.error('See deepblend/docs/dsh-baseline.md §5.')
  process.exit(2)
}

/** The bundle id the whole assertion about "one implementation" is stated over. */
const BUNDLE_ID = '@deepblend/dsh-blender-ui'

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-workbench-e2e-'))
const store = join(scratch, 'store')
const PROJECT_TITLE = `wb-e2e-${Math.random().toString(16).slice(2, 8)}`

/** Every Blender process whose command line mentions this test's store. */
function blenderProcesses() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes('Blender') && line.includes(store))
      .map(line => line.trim())
  } catch {
    return []
  }
}

/** The parent process id of a pid, or null. */
function parentOf(pid) {
  try {
    const parsed = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Read one JSON file from the test store, or null. */
function readStoreJson(...segments) {
  const path = join(store, 'projects', ...segments)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

let browser = null
let page = null
let server = null
const pageErrors = []

try {
  const patch = await storePatch(store)
  server = await startWeb({ workspacePath: REPO_ROOT, patch, keepHome: true })
  const base = server.url.split('?')[0]
  console.log(`── test server on ${base} (store ${store}) ──`)

  browser = await Browser.launch({ args: ['--window-size=1400,900'] })
  page = await browser.newPage('about:blank', {
    onConsole: (type, text) => {
      if (type === 'error' || type === 'exception') pageErrors.push(`${type}: ${text}`)
    },
  })

  // The request log, per DOCUMENT, so it survives the reload the acceptance
  // requires. The standalone page talks to the Host and to nothing else, so the
  // log is a complete statement of what it did.
  await page.addInitScript(`
    window.__wbreqs = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      window.__wbreqs.push({ url: String(input), method: (init && init.method) || 'GET' })
      return originalFetch(input, init)
    }
  `)

  // -------------------------------------------------------------------------
  // 0. The page opens, and it is NOT the console
  // -------------------------------------------------------------------------
  const pageUrl = `${base}deepblend/workbench`
  await page.goto(pageUrl)

  await page.waitFor('document.querySelector("[data-deepblend-panel=deepblend]") !== null', 30000)
  check('the standalone route serves a page that mounts the workbench',
    await page.count('[data-deepblend-panel=deepblend]') === 1)
  check('the page reports itself as the standalone face, and it booted rather than fell back',
    await page.evaluate('document.getElementById("deepblend-workbench").dataset.deepblendStandalone') === 'ready',
    await page.evaluate('document.getElementById("deepblend-workbench").dataset.deepblendStandalone'))

  // 把外壳拿掉: nothing of the console is here. The sidebar entry M4 clicks, the
  // app's own mount point, the conversation surface, and the shell's boot card.
  const shellTraces = await page.evaluate(`(() => {
    const found = []
    if (document.querySelector('button[aria-label="Blender"]') !== null) found.push('sidebar entry')
    if (document.querySelector('#root') !== null) found.push('#root')
    if (document.querySelector('[data-dsh-boot]') !== null) found.push('boot card')
    if (document.querySelector('[contenteditable]') !== null) found.push('conversation input')
    return found
  })()`)
  check('the document carries no chat shell: no sidebar, no app mount, no conversation',
    Array.isArray(shellTraces) && shellTraces.length === 0, shellTraces)
  check('the workbench fills the page rather than sitting in a pane',
    await page.evaluate('document.getElementById("deepblend-workbench").getBoundingClientRect().height > window.innerHeight - 2'),
    await page.evaluate('document.getElementById("deepblend-workbench").getBoundingClientRect().height'))

  check('the page offers the six M4 views, in order',
    (await page.attributes('[data-view-tab]', 'data-view-tab')).join(',') === 'projects,scene,preview,jobs,qa,revisions',
    await page.attributes('[data-view-tab]', 'data-view-tab'))
  await page.waitFor('document.querySelector(\'[data-view="projects"]\') !== null', 20000)
  await page.waitFor('document.querySelector(\'[data-action="create-project"]\') !== null', 20000)
  check('a fresh store is shown as a fresh store, not as an error',
    ((await page.text('[data-view="projects"]')) ?? '').includes('还没有项目'),
    ((await page.text('[data-view="projects"]')) ?? '').replace(/\s+/g, ' ').slice(0, 120))

  // -------------------------------------------------------------------------
  // 1. ONE IMPLEMENTATION, read off the network
  //
  // This is the assertion M6 exists for. The page has no copy of the workbench:
  // it fetched the console's own bundle, from the URL the console's own boot
  // graph declares for it.
  // -------------------------------------------------------------------------
  const provenance = await page.evaluate(`(() => {
    const graph = window.__DSH_BOOT__
    const row = (graph.entries || []).find(entry => entry.id === ${JSON.stringify(BUNDLE_ID)}) || null
    const batch = (graph.batches || []).find(entry => (entry.entries || []).includes(${JSON.stringify(BUNDLE_ID)})) || null
    const resources = performance.getEntriesByType('resource').map(entry => entry.name)
    const loaded = resources.filter(name => name.includes(${JSON.stringify(BUNDLE_ID + '/client.js')}))
    return {
      row,
      batch,
      loaded,
      shellAssets: resources.filter(name => /\\/assets\\/index-/.test(name)),
      allResources: resources.length,
    }
  })()`)

  check('the boot graph declares a row for the workbench bundle, and an initial batch that carries it',
    provenance.row !== null && typeof provenance.row.url === 'string'
    && provenance.batch !== null && typeof provenance.batch.url === 'string'
    && provenance.batch.url.includes(BUNDLE_ID),
    { row: provenance.row?.url, batch: provenance.batch?.url?.slice(0, 120) })
  check('the standalone page loaded the workbench bundle from the URL the graph declares for it',
    provenance.loaded.length === 1 && provenance.loaded[0].endsWith(provenance.batch.url),
    { loaded: provenance.loaded.length, declaredBatch: provenance.batch?.url?.slice(0, 120) })
  check('and it loaded the bundle exactly once, so there is no second copy being fetched alongside',
    provenance.loaded.length === 1, provenance.loaded.map(url => url.slice(0, 100)))
  check('and it loaded no console bundle at all: the page is not the shell wearing a different URL',
    provenance.shellAssets.length === 0, provenance.shellAssets)

  // -------------------------------------------------------------------------
  // 2. 不进入文件系统即可管理项目 — create a project, change a scene, render a preview
  // -------------------------------------------------------------------------
  await page.fill('[data-field="project-title"]', PROJECT_TITLE)
  const createClick = await page.click('[data-action="create-project"]')
  check('the create control is reachable by a pointer, not only by a synthetic click',
    createClick.via === 'pointer', createClick)
  await page.waitFor('document.querySelector(\'[data-result="ok"]\') !== null', 30000)
  const created = await page.text('[data-result="ok"]')
  check('creating a project from the full-screen page reports the new project id', /已创建/.test(created ?? ''), created)

  const projectId = PROJECT_TITLE
  check('the store now holds the project the browser asked for',
    existsSync(join(store, 'projects', projectId, 'project.json')))
  check('the project was created by the HOST, not by the page',
    readStoreJson(projectId, 'project.json')?.projectId === projectId,
    readStoreJson(projectId, 'project.json')?.projectId)

  await page.click('[data-view-tab="scene"]')
  await page.waitFor('document.querySelector("[data-node]") !== null', 20000)
  const nodes = await page.attributes('[data-node]', 'data-node')
  check('the Scene Tree shows the entities the spec really declares',
    nodes.includes('entity:subject') && nodes.includes('camera:camera-main'), nodes.slice(0, 8))

  const patchDocument = JSON.stringify({
    baseRevision: 'r0001',
    operations: [{ op: 'entity.transform.update', entityId: 'subject', location: [0, 0, 1.5] }],
  }, null, 2)
  await page.fill('[data-field="scene-patch"]', patchDocument)
  await page.click('[data-action="apply-patch"]')
  await page.waitFor('document.querySelector(\'[data-view="scene"] [data-result="ok"]\') !== null', 60000)
  const patchResult = await page.text('[data-view="scene"] [data-result="ok"]')
  check('the patch was committed as a new revision by the Host', /已提交 r0002/.test(patchResult ?? ''), patchResult)
  check('the write really changed the stored scene',
    JSON.stringify(readStoreJson(projectId, 'revisions', 'r0002', 'scene-spec.json')?.entities?.[0]?.transform?.location) === '[0,0,1.5]',
    readStoreJson(projectId, 'revisions', 'r0002', 'scene-spec.json')?.entities?.[0]?.transform?.location)

  await page.click('[data-view-tab="preview"]')
  await page.waitFor('document.querySelector(\'[data-action="render-preview"]\') !== null', 20000)
  const previewClick = await page.click('[data-action="render-preview"]')
  check('the preview button is reachable by a pointer', previewClick.via === 'pointer', previewClick)
  await page.waitFor('document.querySelector(\'[data-view="preview"] [data-result="ok"], [data-view="preview"] [data-result="error"]\') !== null', 300000)
  const previewResult = await page.text('[data-view="preview"] [data-result]')
  check('rendering a preview from the full-screen page succeeds on a real Blender',
    /已渲染/.test(previewResult ?? ''), previewResult)

  await page.waitFor(
    'document.querySelector("[data-compare=right] img") !== null && '
    + 'document.querySelector("[data-compare=right] img").naturalWidth > 0',
    60000)
  const shown = await page.evaluate(`(() => {
    const img = document.querySelector('[data-compare="right"] img')
    return { src: img.getAttribute('src'), digest: img.getAttribute('data-artifact-digest'), width: img.naturalWidth }
  })()`)
  check('the page displays the rendered contact sheet, fetched through the artifact route',
    shown.width > 0 && shown.src.startsWith('/deepblend/artifacts/'), shown)
  check('the preview PNG is on disk under the revision',
    readStoreJson(projectId, 'revisions', 'r0002', 'revision-manifest.json')?.contactSheets?.length > 0,
    readStoreJson(projectId, 'revisions', 'r0002', 'revision-manifest.json')?.contactSheets)

  // -------------------------------------------------------------------------
  // 2b. 导出诊断: the one thing this page produces FOR SOMEBODY ELSE
  //
  // It is an anchor with `download`, so the BROWSER fetches the route and writes
  // the file — which means the request log above cannot see it (that log hooks
  // `fetch`) and the only honest evidence is the file. So the download is
  // allowed to a directory this test owns, the link is clicked by POINTER, and
  // what lands there is parsed and read.
  // -------------------------------------------------------------------------
  const downloadDirectory = mkdtempSync(join(tmpdir(), 'deepblend-diagnostics-'))
  try {
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory })

    const exportClick = await page.click('[data-action="export-diagnostics"]')
    check('the export control is reachable by a pointer, like every other control on this page',
      exportClick.via === 'pointer', exportClick)

    const exportedPath = join(downloadDirectory, 'deepblend-diagnostics.json')
    const deadline = Date.now() + 30000
    while (!existsSync(exportedPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    check('clicking it downloads a file, and the file is the bundle the route serves',
      existsSync(exportedPath), exportedPath)

    const exported = existsSync(exportedPath) ? JSON.parse(readFileSync(exportedPath, 'utf8')) : null
    const expectedVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend', 'version.json'), 'utf8')).version
    check('the downloaded bundle is the product\'s own diagnostic format, at the version it ships',
      exported?.format === 'deepblend-diagnostics' && exported?.product?.version === expectedVersion,
      { format: exported?.format, version: exported?.product?.version, expectedVersion })
    check('and it describes THIS store, so it is a reading rather than a template',
      exported?.store?.projectCount >= 1 && exported.store.projects.some(project => project.projectId === projectId),
      { count: exported?.store?.projectCount, projectId })
    check('it carries the Blender probe result, which is the first thing a maintainer asks for',
      exported?.blender?.probed === true && typeof exported?.blender?.installed === 'boolean' &&
      exported.blender.version !== null,
      { installed: exported?.blender?.installed, version: exported?.blender?.version })
    const leaked = JSON.stringify(exported).includes(homedir())
    check('it carries no home directory, so it can be pasted into a public issue',
      !leaked, leaked ? 'a home path reached the downloaded file' : undefined)
  } finally {
    rmSync(downloadDirectory, { recursive: true, force: true })
  }

  // A delivery render, so the job plane is exercised from the full-screen page
  // too and the Blender-parentage assertion below has something to look at.
  await page.click('[data-view-tab="jobs"]')
  await page.waitFor('document.querySelector(\'[data-action="start-render"]\') !== null', 20000)
  await page.fill('[data-field="frame-start"]', '1')
  await page.fill('[data-field="frame-end"]', '3')
  await page.click('[data-action="start-render"]')
  await page.waitFor('document.querySelector("[data-job]") !== null', 60000)
  const jobId = (await page.attributes('[data-job]', 'data-job'))[0]
  check('a delivery render started from the full-screen page appears as a job', typeof jobId === 'string', jobId)
  check('the Host recorded the job on disk', readStoreJson(projectId, 'renders', jobId, 'job.json') !== null)

  await page.waitFor('document.querySelector(\'[data-action^="cancel:"]\') !== null', 60000)
  const live = blenderProcesses()
  const livePid = live.length > 0 ? Number(live[0].split(/\s+/)[0]) : null
  check('the Blender that is rendering is a child of the Host process, not of the page',
    livePid !== null && parentOf(livePid) === server.child.pid,
    { livePid, liveParent: livePid === null ? null : parentOf(livePid), serverPid: server.child.pid })

  await page.click(`[data-action="cancel:${jobId}"]`)
  await page.waitFor('document.querySelector(\'[data-result-kind="cancel"]\') !== null', 60000)
  check('cancelling reports the process measured gone, not merely signalled',
    /进程实测已消失/.test((await page.text('[data-result-kind="cancel"]')) ?? ''),
    await page.text('[data-result-kind="cancel"]'))
  check('cancelling left no Blender process for this store', blenderProcesses().length === 0, blenderProcesses())

  // -------------------------------------------------------------------------
  // 3. 刷新后可从 Host 恢复权威状态
  // -------------------------------------------------------------------------
  const requestsBeforeReload = await page.evaluate('window.__wbreqs')
  await page.reload()
  await page.waitFor('document.querySelector("[data-deepblend-panel=deepblend]") !== null', 30000)
  await page.waitFor(`document.querySelector('[data-project="${projectId}"]') !== null`, 30000)

  const hostRevision = readStoreJson(projectId, 'project.json')?.currentRevision
  check('after a refresh the page still shows the project, read back from the Host',
    ((await page.text('[data-deepblend-panel=deepblend]')) ?? '').includes(PROJECT_TITLE))
  check('after a refresh the header shows the revision the Host has, not a cached one',
    typeof hostRevision === 'string' && ((await page.text('.db-head')) ?? '').includes(hostRevision),
    { hostRevision, header: await page.text('.db-head') })

  await page.click('[data-view-tab="jobs"]')
  await page.waitFor('document.querySelector("[data-job]") !== null', 30000)
  check('after a refresh the job is read back from the Host, still cancelled',
    ((await page.text(`[data-job="${jobId}"]`)) ?? '').includes('cancelled'),
    ((await page.text(`[data-job="${jobId}"]`)) ?? '').slice(0, 120))

  const requestsAfterReload = await page.evaluate('window.__wbreqs')
  check('the refreshed page rebuilt itself from the Host rather than from memory',
    requestsAfterReload.some(entry => entry.url.includes('/deepblend/state')),
    requestsAfterReload.map(entry => entry.url).slice(0, 6))

  // -------------------------------------------------------------------------
  // 4. 浏览器不直接启动 Blender / 所有写操作经过 Host
  // -------------------------------------------------------------------------
  const requests = [...requestsBeforeReload, ...requestsAfterReload]
  check('the refreshed page made requests of its own, so the log is really per document',
    requests.length > 0, requests.length)
  check('every request the page made was same-origin',
    requests.every(entry => entry.url.startsWith('/') || entry.url.startsWith('http://127.0.0.1')))

  const routeOf = url => url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').split('?')[0]
  const panel = requests.filter(entry => routeOf(entry.url).startsWith('/deepblend/'))
  // The declared set, as a regular expression built from the route table's own
  // shape. `/deepblend/workbench` is a document navigation rather than a fetch,
  // so it never appears here — the page's own traffic is reads and writes.
  const declared = new RegExp('^/deepblend/(state|capabilities|projects'
    + '(/[^/]+(/(scene|revisions|diff|qa|previews|patch|restore|preview|render)'
    + '|/jobs(/[^/]+(/cancel)?)?'
    + '|/revisions/[^/]+)?)?'
    + '|artifacts/[^/]+/.+)$')
  check('the page made DeepBlend requests at all, so the closed set has content', panel.length >= 5, panel.length)
  check('every DeepBlend request the page made is a declared DeepBlend route',
    panel.every(entry => declared.test(routeOf(entry.url))),
    panel.filter(entry => !declared.test(routeOf(entry.url))).map(entry => routeOf(entry.url)).slice(0, 5))

  const writes = panel.filter(entry => entry.method === 'POST')
  check('every write the page performed is one of the declared write routes',
    writes.length >= 4 && writes.every(entry => /\/(projects|patch|restore|render|preview|jobs\/[^/]+\/cancel)$/.test(routeOf(entry.url))),
    writes.map(entry => `${entry.method} ${routeOf(entry.url)}`))
  check('the page performed the writes the acceptance asked for: create, patch, preview, render, cancel',
    writes.some(entry => /\/deepblend\/projects$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/patch$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/preview$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/render$/.test(routeOf(entry.url)))
    && writes.some(entry => /\/cancel$/.test(routeOf(entry.url))),
    writes.map(entry => routeOf(entry.url)))

  check('the page has no Node execution surface',
    await page.evaluate('typeof require === "undefined" && typeof process === "undefined" && typeof module === "undefined"'))
  check('the page cannot reach a Blender the Host did not start',
    await page.evaluate('typeof globalThis.spawn === "undefined" && typeof globalThis.child_process === "undefined"'))

  // The route set, from outside the page: a page-only route that does not exist,
  // and the byte route's escape guard, which the standalone page must inherit.
  const unknown = await fetch(`${base}deepblend/not-a-route`).then(async response => ({ status: response.status, body: await response.json() }))
  check('an unknown route is refused with the route list, from the standalone deployment too',
    unknown.status === 404 && unknown.body.error.code === 'UI_ROUTE_NOT_FOUND', unknown.status)
  const escape = await fetch(`${base}deepblend/artifacts/${projectId}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    .then(async response => ({ status: response.status, body: await response.json() }))
  check('an artifact path that escapes the project is refused by the Host',
    escape.status === 400 || escape.status === 404, { status: escape.status, code: escape.body?.error?.code })

  // -------------------------------------------------------------------------
  // 5. The console stayed clean
  // -------------------------------------------------------------------------
  check('the page logged no errors and threw nothing', pageErrors.length === 0, pageErrors.slice(0, 4))
} catch (cause) {
  check('the suite completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  if (page !== null) await page.screenshot('/tmp/deepblend-m6-workbench-e2e.png').catch(() => {})
  if (browser !== null) await browser.close().catch(() => {})
  if (server !== null) {
    // The same verdict M4's suite makes: a server that finishes its own shutdown
    // is a server that was not killed mid-way.
    const stopped = await server.stop().catch(cause => ({ via: `failed: ${String(cause)}`, ms: 0 }))
    check('the server finished its own shutdown rather than being killed mid-way',
      stopped.via === 'sigterm', stopped)
  }
  const leftovers = blenderProcesses()
  if (leftovers.length > 0) {
    console.error(`WARNING: Blender processes survived the suite: ${leftovers.join(' | ')}`)
    for (const line of leftovers) {
      try {
        process.kill(Number(line.split(/\s+/)[0]), 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok)
console.log(`\nM6 standalone workbench acceptance: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
