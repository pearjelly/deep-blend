#!/usr/bin/env node
/**
 * M4 acceptance, in a real browser, against a real `dsh web` and a real Blender.
 *
 * SPEC §20 M4 states four conditions, and every one of them is about the browser:
 *
 *   不进入文件系统即可管理项目        create a project, change a scene, render a
 *                                    preview, start a delivery render and cancel
 *                                    it — all by clicking, then check the disk
 *    UI 刷新后可从 Host 恢复权威状态    reload the page and read the same facts back
 *                                    out of the DOM
 *   浏览器不直接启动 Blender          the page's own fetch log contains nothing but
 *                                    declared routes, and the Blender that rendered
 *                                    is a child of the Host process
 *   所有写操作经过 Host              every write the page performed landed on disk
 *                                    through the facade, and no other write exists
 *
 * WHAT IS REAL HERE
 * -----------------
 * A real Chrome (headless), driven over the DevTools protocol by
 * `tools/browser-driver.mjs`; a real `dsh web` started by
 * `tools/dsh-web-harness.mjs` in its own DSH home AND its own project store (so the
 * developer's store is neither read nor written, and the host's restart reconciler
 * cannot touch a render someone is running); a real Blender, started by that Host.
 *
 * WHY IT RUNS ITS OWN SERVER
 * --------------------------
 * `docs/probe-m4-client-loop.log` §3.1: `dsh-client-modules` caches a package's
 * "is this a client package?" verdict for the life of the process, so a client half
 * added while a server is running is invisible to it. A browser test therefore has
 * to point at a server started AFTER the packages on disk — which is also why this
 * suite can be run while the developer's own GUI keeps running.
 *
 * Run: node deepblend/tests/e2e/ui.e2e.mjs
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { encodePng } from '@deepblend/dsh-blender-contracts'

import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, dismissFirstRunDialogs, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const BLENDER_PATH = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
if (!existsSync(BLENDER_PATH)) {
  console.error(`Blender not found at ${BLENDER_PATH}; the M4 UI acceptance cannot run.`)
  console.error('See deepblend/docs/dsh-baseline.md §5.')
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-ui-e2e-'))
const store = join(scratch, 'store')
const PROJECT_TITLE = `ui-e2e-${Math.random().toString(16).slice(2, 8)}`

/** Every Blender process whose command line mentions this test's store. */
function blenderProcesses() {
  try {
    const output = execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' })
    return output.split('\n')
      .filter(line => line.includes('Blender') && line.includes(store))
      .map(line => line.trim())
  } catch {
    return []
  }
}

/** The parent process id of a pid, or null. */
function parentOf(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const parsed = Number(output)
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

/**
 * A stable number for what the panel is displaying.
 *
 * The image is drawn into an 8x8 canvas and its pixels are folded into one
 * integer, so "did the picture change?" is answered by the rendered bytes rather
 * than by an attribute the test could be reading wrongly.
 */
/** The same reading, for one named pane. @param {'left'|'right'} side */
function displayedPixels(side) {
  return `(() => {
  const img = document.querySelector('[data-compare="${side}"] img')
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const context = canvas.getContext('2d')
  context.drawImage(img, 0, 0, 8, 8)
  const data = context.getImageData(0, 0, 8, 8).data
  let hash = 0
  for (let index = 0; index < data.length; index += 4) {
    hash = (hash * 31 + data[index] + data[index + 1] * 7 + data[index + 2] * 13) % 1000000007
  }
  return hash
})()`
}

/** Switch the panel to one view and wait for that view to render. */
async function openView(page, name) {
  await page.click(`[data-view-tab="${name}"]`)
  await page.waitFor(`document.querySelector('[data-view="${name}"]') !== null`, 20000)
}

const pageErrors = []
let server = null
let browser = null
let page = null

try {
  // -------------------------------------------------------------------------
  // A server whose store is scratch space
  // -------------------------------------------------------------------------
  const patch = await storePatch(store)
  server = await startWeb({ workspacePath: REPO_ROOT, patch, keepHome: true })
  console.log(`── test server on ${server.url.split('?')[0]} (store ${store}) ──`)

  browser = await Browser.launch({ args: ['--window-size=1500,950'] })
  page = await browser.newPage('about:blank', {
    onConsole: (type, text) => {
      if (type === 'error' || type === 'exception') pageErrors.push(`${type}: ${text}`)
    },
  })

  // Record every request the page makes, so the acceptance can be stated as a
  // fact about the BROWSER rather than as a fact about the source: whatever the
  // UI does, it does through these URLs.
  // Installed per DOCUMENT, so the record survives the reload the acceptance
  // requires — a recorder injected once would vanish with the old document and
  // the "did it rebuild from the Host?" assertion would read an empty list.
  // The shell itself talks to `/api/*` constantly (session list, credentials,
  // settings), so "the page made a request" is not the claim under test. The
  // claim is about the DEEPBLEND surface: every DeepBlend request the page makes
  // must be a declared route, and the writes must be the ones the acceptance
  // asked for. (Attributing a call to a plugin by its stack frame does not work
  // here — every client bundle is concatenated into one combo script whose URL
  // names them all — so the assertion is stated over the DeepBlend prefix, which
  // only this package's client half and the console's own panel code use.)
  await page.addInitScript(`
    window.__m4requests = []
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      window.__m4requests.push({ url: String(input), method: (init && init.method) || 'GET' })
      return originalFetch(input, init)
    }
  `)
  await page.goto(server.url)

  await dismissFirstRunDialogs(page)

  // -------------------------------------------------------------------------
  // 0. The entry exists in a real page
  // -------------------------------------------------------------------------
  await page.waitFor('document.querySelector("button[aria-label=\\"Blender\\"]") !== null', 30000)
  check('the Blender entry is in the sidebar of a real page', await page.count('button[aria-label="Blender"]') === 1)

  const entryClick = await page.click('button[aria-label="Blender"]')
  check('the entry is reachable by a pointer, not only by a synthetic click', entryClick.via === 'pointer', entryClick)
  await page.waitFor('document.querySelector("[data-deepblend-panel=deepblend]") !== null', 15000)
  check('the workbench panel opens in the main column', await page.count('[data-deepblend-panel=deepblend]') === 1)
  check('the panel offers the six M4 views',
    (await page.attributes('[data-view-tab]', 'data-view-tab')).join(',') === 'projects,scene,preview,jobs,qa,revisions',
    await page.attributes('[data-view-tab]', 'data-view-tab'))
  await page.waitFor(`document.querySelector('[data-view="projects"]') !== null`, 20000)
  await page.waitFor(`document.querySelector('[data-action="create-project"]') !== null`, 20000)
  check('a fresh store is shown as a fresh store, not as an error',
    ((await page.text('[data-view="projects"]')) ?? '').includes('还没有项目'),
    ((await page.text('[data-view="projects"]')) ?? '').replace(/\s+/g, ' ').slice(0, 120))

  // -------------------------------------------------------------------------
  // 1. 不进入文件系统即可管理项目 — create a project through the UI
  // -------------------------------------------------------------------------
  await page.fill('[data-field="project-title"]', PROJECT_TITLE)
  await page.click('[data-action="create-project"]')
  await page.waitFor(`document.querySelector('[data-result="ok"]') !== null`, 30000)
  const created = await page.text('[data-result="ok"]')
  check('creating a project through the UI reports the new project id', /已创建/.test(created ?? ''), created)

  const projectId = PROJECT_TITLE
  check('the store now holds the project the browser asked for',
    existsSync(join(store, 'projects', projectId, 'project.json')),
    join(store, 'projects', projectId, 'project.json'))
  check('and its first revision was published',
    readStoreJson(projectId, 'revisions', 'r0001', 'revision-manifest.json') !== null)
  check('the project was created by the HOST: the record names the id the UI typed',
    readStoreJson(projectId, 'project.json')?.projectId === projectId,
    readStoreJson(projectId, 'project.json')?.projectId)
  check('and the scene spec on disk is a compiled scene, not a stub',
    (readStoreJson(projectId, 'revisions', 'r0001', 'scene-spec.json')?.entities ?? []).length > 0)

  await page.waitFor(`document.querySelector('[data-project="${projectId}"]') !== null`, 20000)
  check('the project appears in the panel list',
    ((await page.text('[data-project="' + projectId + '"]')) ?? '').includes(PROJECT_TITLE))

  // -------------------------------------------------------------------------
  // 2. Scene Tree — read the seeded scene, then change it through the UI
  // -------------------------------------------------------------------------
  await openView(page, 'scene')
  await page.waitFor('document.querySelector("[data-node]") !== null', 20000)
  const nodes = await page.attributes('[data-node]', 'data-node')
  check('the Scene Tree shows the entities the spec really declares',
    nodes.includes('entity:subject') && nodes.includes('camera:camera-main'),
    nodes.slice(0, 8))
  check('the Scene Tree is not empty for a project that has a scene',
    ((await page.text('[data-view="scene"]')) ?? '').includes('实体 entities（1）'),
    ((await page.text('[data-view="scene"]')) ?? '').slice(0, 80))

  const patchDocument = JSON.stringify({
    baseRevision: 'r0001',
    operations: [{ op: 'entity.transform.update', entityId: 'subject', location: [0, 0, 1.5] }],
  }, null, 2)
  await page.fill('[data-field="scene-patch"]', patchDocument)
  await page.click('[data-action="apply-patch"]')
  await page.waitFor('document.querySelector(\'[data-view="scene"] [data-result="ok"]\') !== null', 60000)
  const patchResult = await page.text('[data-view="scene"] [data-result="ok"]')
  check('the patch was committed as a new revision by the Host', /已提交 r0002/.test(patchResult ?? ''), patchResult)
  check('the second revision exists on disk',
    readStoreJson(projectId, 'revisions', 'r0002', 'revision-manifest.json') !== null)
  check('the write really changed the stored scene',
    JSON.stringify(readStoreJson(projectId, 'revisions', 'r0002', 'scene-spec.json')?.entities?.[0]?.transform?.location) === '[0,0,1.5]',
    readStoreJson(projectId, 'revisions', 'r0002', 'scene-spec.json')?.entities?.[0]?.transform?.location)
  check('the revision chain records what it was based on',
    readStoreJson(projectId, 'revisions', 'r0002', 'revision-manifest.json')?.baseRevision === 'r0001')

  // -------------------------------------------------------------------------
  // 3. Preview Compare — a real Blender render, started from the panel
  // -------------------------------------------------------------------------
  await page.click('[data-view-tab="preview"]')
  await page.waitFor(`document.querySelector('[data-action="render-preview"]') !== null`, 20000)
  const previewClick = await page.click('[data-action="render-preview"]')
  check('the preview button is reachable by a pointer', previewClick.via === 'pointer', previewClick)
  await page.waitFor('document.querySelector(\'[data-view="preview"] [data-result="ok"], [data-view="preview"] [data-result="error"]\') !== null', 300000)
  const previewResult = await page.text('[data-view="preview"] [data-result]')
  check('rendering a preview from the panel succeeds on a real Blender', /已渲染/.test(previewResult ?? ''), previewResult)

  const previewRoot = join(store, 'projects', projectId, 'revisions', 'r0002', 'previews')
  const previewFiles = existsSync(previewRoot)
    ? readdirSync(previewRoot, { recursive: true }).map(String).filter(name => name.endsWith('.png'))
    : []
  check('the preview PNGs are on disk under the revision', previewFiles.some(name => name.endsWith('.png')), previewFiles.slice(0, 4))

  // ── the pair: 上一次渲染 vs 本次渲染, both from real renders ──────────────
  //
  // The first render leaves the left pane empty (there is nothing to compare yet);
  // the second one rotates the previous sheet into place. That rotation is the whole
  // reason Preview Compare can answer "what changed?" after a render — a preview
  // replaces its own image, so without a kept generation the panel could only ever
  // show the present, which is exactly what the operator reported as "没有出现新的条目".
  await page.waitFor('document.querySelector("[data-compare=right] img") !== null', 30000)
  const firstSheets = await page.evaluate(`(() => {
    const right = document.querySelector('[data-compare="right"] img')
    return {
      leftKind: document.querySelector('[data-compare="left"]').getAttribute('data-compare-kind'),
      rightSlot: right.getAttribute('data-artifact-slot'),
      rightSrc: right.getAttribute('src'),
      rightWidth: right.naturalWidth,
      rightHeight: right.naturalHeight,
    }
  })()`)
  check('the first render composes a contact sheet the panel shows', firstSheets.rightWidth > 0 && firstSheets.rightHeight > 0, firstSheets)
  check('and it is labelled as THIS render, by slot rather than by path',
    firstSheets.rightSlot === 'preview-current', firstSheets.rightSlot)
  check('with nothing to compare against yet, the left pane says so',
    firstSheets.leftKind === 'empty', firstSheets.leftKind)
  check('the pane states when the image was produced',
    /渲染于/.test((await page.text('[data-compare="right"]')) ?? ''), (await page.text('[data-compare="right"]'))?.slice(0, 80))
  check('the rendered image is fetched from a URL keyed on its own digest',
    /[?&]v=[0-9a-f]{8,}/.test(firstSheets.rightSrc ?? ''), firstSheets.rightSrc)

  // A SECOND real render: this is the operator's second click, and the assertion is
  // that the panel can now show a before and an after of the same revision.
  await page.click('[data-action="render-preview"]')
  await page.waitFor('document.querySelector(\'[data-compare="left"] img[data-artifact-slot="preview-previous"]\') !== null', 300000)
  const pair = await page.evaluate(`(() => {
    const read = side => {
      const img = document.querySelector('[data-compare="' + side + '"] img')
      return img === null ? null : { slot: img.getAttribute('data-artifact-slot'), digest: img.getAttribute('data-artifact-digest') }
    }
    return { left: read('left'), right: read('right') }
  })()`)
  check('the second render keeps the previous sheet, so the panes hold a before and an after',
    pair.left?.slot === 'preview-previous' && pair.right?.slot === 'preview-current', pair)
  check('the two panes are genuinely different renders, not the same image twice',
    pair.left?.digest !== pair.right?.digest && Boolean(pair.left?.digest) && Boolean(pair.right?.digest),
    { left: pair.left?.digest?.slice(0, 10), right: pair.right?.digest?.slice(0, 10) })
  const pairTimes = await page.evaluate(`(() => {
    const at = side => (document.querySelector('[data-compare="' + side + '"] img') || {}).getAttribute?.('data-artifact-at') ?? null
    return { left: at('left'), right: at('right') }
  })()`)
  check('each pane reports the time of ITS OWN render, not the time of the rotation',
    typeof pairTimes.left === 'string' && typeof pairTimes.right === 'string'
    && pairTimes.left.length > 0 && pairTimes.left !== pairTimes.right,
    pairTimes)
  check('the render result says what it did with the previous sheet',
    /上一次渲染/.test((await page.text('[data-result="ok"]')) ?? ''), ((await page.text('[data-result="ok"]')) ?? '').slice(0, 120))
  check('the two axes are both offered', (await page.attributes('[data-compare-mode]', 'data-compare-mode')).join(',') === 'renders,revisions')
  check('switching to the revision axis shows the revision panes',
    await (async () => {
      await page.click('[data-compare-mode="revisions"]')
      await new Promise(resolve => setTimeout(resolve, 400))
      const kinds = await page.attributes('[data-compare]', 'data-compare-kind')
      await page.click('[data-compare-mode="renders"]')
      await new Promise(resolve => setTimeout(resolve, 400))
      return kinds.length === 2
    })())

  // ── after a scene change, "before" is the OLDER revision's last render ───
  //
  // The workflow this exists for: change something, render once, look at the
  // difference. On the first render of a new revision there is no previous
  // generation of THAT revision, so the pair would be empty exactly when it is
  // wanted — unless "before" reaches one revision back.
  const patchAgain = JSON.stringify({
    baseRevision: 'r0002',
    operations: [{ op: 'entity.transform.update', entityId: 'subject', location: [0, 0, 2.4] }],
  }, null, 2)
  await openView(page, 'scene')
  await page.fill('[data-field="scene-patch"]', patchAgain)
  await page.click('[data-action="apply-patch"]')
  await page.waitFor(`document.querySelector('[data-view="scene"] [data-result="ok"]') !== null`, 60000)
  await openView(page, 'preview')
  await page.waitFor(`document.querySelector('[data-action="render-preview"]') !== null`, 20000)
  const beforeThird = await page.attributes('[data-compare="left"] img', 'data-artifact-revision')
  check('before the third render, the left pane already shows the older revision\'s render',
    beforeThird[0] === 'r0002', beforeThird)
  await page.click('[data-action="render-preview"]')
  await page.waitFor(`document.querySelector('[data-compare="right"] img[data-artifact-revision="r0003"]') !== null`, 300000)
  const crossPair = await page.evaluate(`(() => {
    const read = side => {
      const img = document.querySelector('[data-compare="' + side + '"] img')
      return img === null ? null : {
        revision: img.getAttribute('data-artifact-revision'),
        digest: img.getAttribute('data-artifact-digest'),
        at: img.getAttribute('data-artifact-at'),
      }
    }
    return { left: read('left'), right: read('right') }
  })()`)
  check('after a scene change, 上一次渲染 is the previous revision\'s render and 本次渲染 is this one',
    crossPair.left?.revision === 'r0002' && crossPair.right?.revision === 'r0003', crossPair)
  check('and they are different images from different times',
    crossPair.left?.digest !== crossPair.right?.digest && crossPair.left?.at !== crossPair.right?.at,
    { left: crossPair.left?.digest?.slice(0, 10), right: crossPair.right?.digest?.slice(0, 10) })
  check('the left pane names the revision it came from, so a cross-revision pair is not mistaken for one scene',
    /上一次渲染 · r0002/.test((await page.text('[data-compare="left"]')) ?? ''), (await page.text('[data-compare="left"]'))?.slice(0, 40))

  // ── the stale-image regression: bytes replaced at the SAME path ──────────
  //
  // Measured before this was fixed: the panel kept displaying the previous bytes,
  // because its <img> was keyed on the path alone and a browser does not re-request
  // an unchanged src. The disk is edited here rather than rendered a third time,
  // because replacing a file in place is exactly what a re-render does to it.
  const displayedBefore = await page.evaluate(displayedPixels('right'))
  const newest = readStoreJson(projectId, 'revisions', 'r0003', 'revision-manifest.json')
  const currentSheet = (newest?.contactSheets ?? []).find(entry => entry.slot === 'preview-current')
  const pixels = Buffer.alloc(64 * 36 * 4)
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 255
    pixels[index + 3] = 255
  }
  const replacement = encodePng({ width: 64, height: 36, data: pixels })
  const sheetPath = join(store, 'projects', projectId, currentSheet.path)
  const originalSheet = readFileSync(sheetPath)
  writeFileSync(sheetPath, replacement)
  const replacementDigest = createHash('sha256').update(replacement).digest('hex')
  writeFileSync(
    join(store, 'projects', projectId, 'revisions', 'r0003', 'revision-manifest.json'),
    JSON.stringify({
      ...newest,
      contactSheets: newest.contactSheets.map(entry => entry.path === currentSheet.path
        ? { ...entry, sha256: replacementDigest, bytes: replacement.length }
        : entry),
    }, null, 2),
  )
  await page.click('[data-action="reload"]')
  await page.waitFor(`${displayedPixels('right')} !== ${displayedBefore}`, 20000).catch(() => {})
  const displayedAfter = await page.evaluate(displayedPixels('right'))
  check('a re-render at the same path is SHOWN: the panel fetches the new bytes instead of keeping the old image',
    displayedAfter !== displayedBefore && displayedAfter !== null,
    { before: displayedBefore, after: displayedAfter })
  const shownDigest = await page.attributes('[data-compare="right"] img', 'data-artifact-digest')
  check('and the URL it displays is keyed on the artifact\'s own digest',
    shownDigest[0] === replacementDigest, { shown: shownDigest[0]?.slice(0, 12), expected: replacementDigest.slice(0, 12) })
  // Put the real render back, so the rest of the suite describes what Blender produced.
  writeFileSync(sheetPath, originalSheet)
  writeFileSync(
    join(store, 'projects', projectId, 'revisions', 'r0003', 'revision-manifest.json'),
    JSON.stringify(newest, null, 2),
  )

  // -------------------------------------------------------------------------
  // 4. Jobs — start a delivery render and cancel it
  // -------------------------------------------------------------------------
  await page.click('[data-view-tab="jobs"]')
  await page.waitFor(`document.querySelector('[data-action="start-render"]') !== null`, 20000)
  await page.fill('[data-field="frame-start"]', '1')
  await page.fill('[data-field="frame-end"]', '3')
  await page.click('[data-action="start-render"]')
  await page.waitFor('document.querySelector("[data-job]") !== null', 60000)

  const runningJobId = await page.attributes('[data-job]', 'data-job').then(ids => ids[0])
  check('a delivery render started from the panel appears as a job', typeof runningJobId === 'string', runningJobId)

  const jobRecord = readStoreJson(projectId, 'renders', runningJobId, 'job.json')
  check('the Host recorded the job on disk', jobRecord !== null)
  check('the job is the one the panel started: same id, same project',
    jobRecord?.jobId === runningJobId && jobRecord?.projectId === projectId,
    { jobId: jobRecord?.jobId, projectId: jobRecord?.projectId })

  // The render is running now: the Blender behind it must be the Host's child,
  // not something the browser produced.
  await page.waitFor(`document.querySelector('[data-action^="cancel:"]') !== null`, 60000)
  const live = blenderProcesses()
  check('a real Blender is rendering this job', live.length > 0, live.slice(0, 2).map(line => line.slice(0, 90)))
  const livePid = live.length > 0 ? Number(live[0].split(/\s+/)[0]) : null
  const liveParent = livePid === null ? null : parentOf(livePid)
  const serverPid = server.child.pid
  check('the Blender that is rendering is a child of the Host process, not of the page',
    livePid !== null && liveParent === serverPid,
    { livePid, liveParent, serverPid })

  const cancelClick = await page.click(`[data-action="cancel:${runningJobId}"]`)
  check('the cancel control is reachable by a pointer', cancelClick.via === 'pointer', cancelClick)
  await page.waitFor(`document.querySelector('[data-result-kind="cancel"]') !== null`, 60000)
  const cancelResult = await page.text('[data-result-kind="cancel"]')
  check('cancelling reports the process measured gone, not merely signalled',
    /进程实测已消失/.test(cancelResult ?? ''), cancelResult)
  check('cancelling left no Blender process for this store', blenderProcesses().length === 0, blenderProcesses())
  check('the cancelled job is recorded as cancelled on disk',
    readStoreJson(projectId, 'renders', runningJobId, 'job.json')?.status === 'cancelled',
    readStoreJson(projectId, 'renders', runningJobId, 'job.json')?.status)

  // The approval display: M4 shows the threshold the Host applies. This job is
  // far below it, and the payload must say so rather than leaving the badge to
  // guess.
  const jobsPayload = await fetch(`http://127.0.0.1:${server.port}/deepblend/projects/${projectId}/jobs`).then(response => response.json())
  const approval = jobsPayload.jobs.find(job => job.jobId === runningJobId)?.approval
  check('the job carries the Host\'s approval threshold and its own frame count',
    approval?.threshold === 900 && approval?.frames === 3 && approval?.required === false,
    approval)
  check('the approval view reports an enforced threshold rather than a displayed one',
    approval?.plane === 'enforced')

  // -------------------------------------------------------------------------
  // 5. 刷新后可从 Host 恢复权威状态
  // -------------------------------------------------------------------------
  // A new document starts a new log, and the writes happened in the OLD one, so
  // the record is carried across the navigation instead of being lost with it.
  const requestsBeforeReload = await page.evaluate('window.__m4requests')
  await page.reload()
  await dismissFirstRunDialogs(page)
  await page.waitFor('document.querySelector("button[aria-label=\\"Blender\\"]") !== null', 30000)
  await page.click('button[aria-label="Blender"]')
  await page.waitFor('document.querySelector("[data-deepblend-panel=deepblend]") !== null', 15000)
  await page.waitFor(`document.querySelector('[data-project="${projectId}"]') !== null`, 30000)

  const afterReload = await page.text('[data-deepblend-panel=deepblend]')
  check('after a refresh the panel still shows the project', (afterReload ?? '').includes(PROJECT_TITLE))
  // Read the revision from the store rather than writing a literal: this suite makes
  // more than one revision, and a hardcoded id here is the kind of assertion that
  // fails later for the wrong reason.
  const hostRevision = readStoreJson(projectId, 'project.json')?.currentRevision
  check('after a refresh the panel shows the revision the Host has, not a cached one',
    typeof hostRevision === 'string' && (await page.text('.db-head'))?.includes(hostRevision),
    { hostRevision, header: await page.text('.db-head') })

  await openView(page, 'jobs')
  await page.waitFor('document.querySelector("[data-job]") !== null', 30000)
  const jobTextAfterReload = await page.text(`[data-job="${runningJobId}"]`)
  check('after a refresh the job is read back from the Host, still cancelled',
    (jobTextAfterReload ?? '').includes('cancelled'), (jobTextAfterReload ?? '').slice(0, 120))

  const requestsAfterReload = await page.evaluate('window.__m4requests')
  check('the refreshed page rebuilt itself from the Host rather than from memory',
    requestsAfterReload.some(entry => entry.url.includes('/deepblend/state')),
    requestsAfterReload.map(entry => entry.url).slice(0, 6))

  // -------------------------------------------------------------------------
  // 6. 浏览器不直接启动 Blender / 所有写操作经过 Host
  // -------------------------------------------------------------------------
  const requests = [...requestsBeforeReload, ...(await page.evaluate('window.__m4requests'))]
  check('the refreshed page made requests of its own (so the log is really per document)',
    Array.isArray(requests) && requests.length > 0, Array.isArray(requests) ? requests.length : requests)
  check('every request the page made was same-origin',
    requests.every(entry => entry.url.startsWith('/') || entry.url.startsWith('http://127.0.0.1')))

  // The DeepBlend traffic, which is the browser-side statement of
  // 「所有写操作经过 Host」: whatever the panel wanted, it went through these URLs.
  const routeOf = url => url.replace(/^https?:\/\/127\.0\.0\.1:\d+/, '').split('?')[0]
  const panel = requests.filter(entry => routeOf(entry.url).startsWith('/deepblend/'))
  const declaredDeepblend = new RegExp('^/deepblend/(capabilities|state|projects'
    + '(/[^/]+(/(scene|revisions|diff|qa|previews|patch|restore|preview|render)'
    + '|/jobs(/[^/]+(/cancel)?)?'
    + '|/revisions/[^/]+)?)?'
    + '|artifacts/[^/]+/.+)$')
  check('the page made DeepBlend requests at all (so the closed set has content)', panel.length >= 5, panel.length)
  check('every DeepBlend request the page made is a declared DeepBlend route',
    panel.every(entry => declaredDeepblend.test(routeOf(entry.url))),
    panel.filter(entry => !declaredDeepblend.test(routeOf(entry.url))).map(entry => routeOf(entry.url)).slice(0, 5))

  const panelWrites = panel.filter(entry => entry.method === 'POST')
  check('every DeepBlend write the page performed is one of the declared write routes',
    panelWrites.length >= 5 && panelWrites.every(entry => /\/(projects|patch|restore|render|preview|jobs\/[^/]+\/cancel)$/.test(routeOf(entry.url))),
    panelWrites.map(entry => `${entry.method} ${routeOf(entry.url)}`))
  check('the page performed the writes the acceptance asked for: create, patch, preview, render, cancel',
    panelWrites.some(entry => /\/deepblend\/projects$/.test(routeOf(entry.url)))
    && panelWrites.some(entry => /\/patch$/.test(routeOf(entry.url)))
    && panelWrites.some(entry => /\/preview$/.test(routeOf(entry.url)))
    && panelWrites.some(entry => /\/render$/.test(routeOf(entry.url)))
    && panelWrites.some(entry => /\/cancel$/.test(routeOf(entry.url))),
    panelWrites.map(entry => routeOf(entry.url)))

  check('the page has no Node execution surface',
    await page.evaluate('typeof require === "undefined" && typeof process === "undefined" && typeof module === "undefined"'))
  check('the page cannot reach a Blender the Host did not start',
    await page.evaluate('typeof globalThis.spawn === "undefined" && typeof globalThis.child_process === "undefined"'))

  // The route set, from outside: an unknown route and an escaping artifact path.
  const unknown = await fetch(`http://127.0.0.1:${server.port}/deepblend/not-a-route`).then(async response => ({ status: response.status, body: await response.json() }))
  check('an unknown route is refused with the route list', unknown.status === 404 && unknown.body.error.code === 'UI_ROUTE_NOT_FOUND', unknown.status)
  const escape = await fetch(`http://127.0.0.1:${server.port}/deepblend/artifacts/${projectId}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    .then(async response => ({ status: response.status, body: await response.json() }))
  check('an artifact path that escapes the project is refused by the Host',
    escape.status === 400 || escape.status === 404, { status: escape.status, code: escape.body?.error?.code })
  const missing = await fetch(`http://127.0.0.1:${server.port}/deepblend/artifacts/${projectId}/revisions/r0002/previews/none.png`)
    .then(async response => ({ status: response.status, body: await response.json() }))
  check('a preview that was never rendered is a coded 404, not a blank page',
    missing.status === 404 && missing.body.error.code === 'ARTIFACT_NOT_FOUND', missing.status)

  // -------------------------------------------------------------------------
  // 7. Settings — the M0 card, now with a seat in the console
  // -------------------------------------------------------------------------
  await page.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="设置"]')
      || Array.from(document.querySelectorAll('button')).find(candidate => (candidate.textContent || '').trim() === '设置')
    if (button) button.click()
    return true
  })()`)
  // The settings panel lists one nav row per registered section; ours is the
  // entry this package adds, and it is rendered by the shipped settings shell.
  await page.waitFor(`Array.from(document.querySelectorAll('button')).some(candidate => (candidate.textContent || '').trim() === 'Blender')`, 20000)
  await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('button')).filter(candidate => (candidate.textContent || '').trim() === 'Blender')
    const row = rows[rows.length - 1]
    if (row) row.click()
    return rows.length
  })()`)
  await page.waitFor('document.querySelector("[data-deepblend-settings=deepblend]") !== null', 20000)
  // The card is fetched when the section mounts and the probe launches Blender,
  // so the assertion waits for the answer rather than for the container.
  await page.waitFor(`(document.querySelector('[data-deepblend-settings=deepblend]') || {}).textContent.includes('5.2.1')`, 60000)
  const settingsText = await page.text('[data-deepblend-settings=deepblend]')
  check('the Blender settings page renders the capabilities card the Host serves',
    (settingsText ?? '').includes('5.2.1 LTS') && (settingsText ?? '').includes('可执行文件'),
    (settingsText ?? '').replace(/\s+/g, ' ').slice(0, 120))

  // -------------------------------------------------------------------------
  // 8. A Host older than the UI is DIAGNOSED, not rendered as an empty panel
  //
  // This is the deployment state D59 named for the tools, seen from the browser:
  // the packages on disk are newer than the `blenderUi` the process constructed.
  // The two shapes below are not invented — they were MEASURED against the M0-era
  // UI half that was really running on 3080 while M4 was written:
  //
  //   GET /deepblend/capabilities → 200 with the settings card and no `route` field
  //   GET /deepblend/state        → 404 with an EMPTY body (no content type at all)
  //
  // so the panel has to diagnose a body with the wrong identity AND a response that
  // is not JSON. The first draft of this test simulated the first shape for
  // `/deepblend/state`, which no deployment produces, and it passed for that reason.
  // -------------------------------------------------------------------------
  await page.addInitScript(`
    const olderFetch = window.fetch
    window.fetch = (input, init) => {
      const url = String(input)
      if (url.includes('/deepblend/state')) {
        return Promise.resolve(new Response('', { status: 404 }))
      }
      if (url.includes('/deepblend/capabilities')) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          card: { title: 'Blender', rows: [] },
          data: { installed: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return olderFetch(input, init)
    }
  `)
  await page.reload()
  await dismissFirstRunDialogs(page)
  await page.waitFor(`document.querySelector('button[aria-label="Blender"]') !== null`, 30000)
  await page.click('[aria-label="Blender"]')
  await page.waitFor(`document.querySelector('[data-deepblend-error]') !== null`, 20000)
  const staleText = await page.text('[data-deepblend-error]')
  check('a Host that answers a 404 with no body is reported as a stale deployment, not as a fetch error',
    (staleText ?? '').includes('UI_HOST_API_STALE'), (staleText ?? '').slice(0, 90))
  check('the diagnosis keeps what was actually observed',
    (staleText ?? '').includes('404') && (staleText ?? '').includes('非 JSON'), (staleText ?? '').slice(0, 200))
  check('and the diagnosis says what to do about it',
    (staleText ?? '').includes('dsh web'), (staleText ?? '').slice(0, 200))
  // The other shape: a 200 whose body belongs to another route. The settings page
  // fetches /deepblend/capabilities, which a stale Host answers with the M0 card —
  // so the card must NOT be shown as if it were current.
  await page.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="设置"]')
      || Array.from(document.querySelectorAll('button')).find(candidate => (candidate.textContent || '').trim() === '设置')
    if (button) button.click()
    return true
  })()`)
  await page.waitFor(`Array.from(document.querySelectorAll('button')).some(candidate => (candidate.textContent || '').trim() === 'Blender')`, 20000)
  await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('button')).filter(candidate => (candidate.textContent || '').trim() === 'Blender')
    const row = rows[rows.length - 1]
    if (row) row.click()
    return true
  })()`)
  await page.waitFor(`document.querySelector('[data-deepblend-settings=deepblend]') !== null`, 20000)
  const staleSettings = await page.text('[data-deepblend-settings=deepblend]')
  check('a 200 whose body carries no route id is diagnosed instead of rendered as the card',
    (staleSettings ?? '').includes('UI_HOST_API_STALE'),
    (staleSettings ?? '').replace(/\s+/g, ' ').slice(0, 120))

  // -------------------------------------------------------------------------
  // 9. The console stayed clean while all of that happened
  // -------------------------------------------------------------------------
  check('the page logged no errors and threw nothing (the simulated stale Host included)',
    pageErrors.length === 0, pageErrors.slice(0, 4))
  check('every revision in the store was published by the Host, with a manifest',
    readdirSync(join(store, 'projects', projectId, 'revisions')).every(revision =>
      existsSync(join(store, 'projects', projectId, 'revisions', revision, 'revision-manifest.json'))),
    readdirSync(join(store, 'projects', projectId, 'revisions')))
} catch (cause) {
  check('the suite completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  if (page !== null) await page.screenshot('/tmp/deepblend-m4-ui-e2e.png').catch(() => {})
  if (browser !== null) await browser.close().catch(() => {})
  if (server !== null) {
    // WHETHER THE SERVER STOPPED ON ITS OWN IS PART OF THIS SUITE'S VERDICT, not housekeeping.
    //
    // MEASURED (round 29): `dsh web` handles SIGTERM, disposes its app fiber and exits with code 0 —
    // in about 700 ms. The harness used to wait 300 ms and SIGKILL, so the process died mid-shutdown
    // and never wrote its V8 coverage report. The suite passed either way; what it lost was the whole
    // UI plane in `docs/probe-coverage.log`, where `listProjects`, `getRevisionDetail`, `readArtifact`
    // and `getQaRecord` read as never-executed although this file drives all four in a real browser.
    // `via: 'sigkill'` means the grace period expired: something made the shutdown slower or stuck.
    const stopped = await server.stop().catch(cause => ({ via: `failed: ${String(cause)}`, ms: 0 }))
    check('the server finished its own shutdown rather than being killed mid-way',
      stopped.via === 'sigterm', stopped)
  }
  const leftovers = blenderProcesses()
  if (leftovers.length > 0) {
    console.error(`WARNING: Blender processes survived the suite: ${leftovers.join(' | ')}`)
    for (const line of leftovers) {
      const pid = Number(line.split(/\s+/)[0])
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter(entry => !entry.ok)
console.log(`\nM4 UI acceptance: ${results.length - failed.length}/${results.length} check(s) passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map(entry => entry.name).join('; ')}`)
  process.exit(1)
}
