#!/usr/bin/env node
/** Real subject selection, immutable geometry/cameras, restore and measured review.
 * Runs its own isolated Host, creates the shipped speaker recipe, and deliberately
 * selects an unavailable model to exercise preflight failure without online calls.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const directory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `review-subject-ui-r16-${new Date().toISOString().replace(/[:.]/g, '-')}`))
const root = join(directory, 'store'), projectId = 'speaker', results = [], requests = []
const startedAt = new Date().toISOString(), sha256 = value => createHash('sha256').update(value).digest('hex')
mkdirSync(directory, { recursive: true })
const read = (...parts) => JSON.parse(readFileSync(join(root, 'projects', projectId, ...parts)))
const projectPath = (...parts) => join(root, 'projects', projectId, ...parts)
function check(name, ok, detail) {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok) throw new Error(name)
}
async function waitDisk(predicate, timeout = 180000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Timed out waiting for the actual project store')
}
const selector = '[data-field="brief-review-subject"]'
let server, browser, page, url, shutdown, outcome = 'failed', originals = {}
try {
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
  if (!existsSync(blenderPath)) throw new Error(`Blender not found at ${blenderPath}; set DEEPBLEND_BLENDER_PATH.`)
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  Object.assign(rows.find(row => row.id === 'deepblend-blender-host').config, { maxPreviewSamples: 16, visualReviewModel: 'deepblend-subject-ui-unavailable' })
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`; url = `${base}/deepblend/workbench`
  const catalog = await (await fetch(`${base}/deepblend/recipes`)).json()
  const recipe = catalog.recipes.find(recipe => recipe.id === 'deepblend.modular-speaker')
  check('the isolated Host exposes the validated speaker recipe', Boolean(recipe?.digest))
  const created = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, title: projectId, recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, parameters: {} }, renderPreview: false }), signal: AbortSignal.timeout(180000) })
  if (!created.ok) throw new Error(`Fixture creation ${created.status}: ${await created.text()}`)
  const beforeSpec = read('revisions', 'r0001', 'scene-spec.json')
  originals = Object.fromEntries(['scene-spec.json', 'scene.blend'].map(file => [projectPath('revisions', 'r0001', file), sha256(readFileSync(projectPath('revisions', 'r0001', file)))]))
  check('the fixture is a real checkpoint without preview renders', existsSync(projectPath('revisions', 'r0001', 'scene.blend')) && read('revisions', 'r0001', 'revision-manifest.json').previews.length === 0)
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] }); page = await browser.newPage()
  await page.addInitScript(`window.__subjectRequests=[];const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method==='POST')window.__subjectRequests.push({url:String(input),body:typeof init.body==='string'?JSON.parse(init.body):null});return originalFetch(input,init)}`)
  await page.goto(url)
  await page.waitFor('document.querySelector(\'[data-brief-base-revision="r0001"]\')!==null', 45000)
  check('automatic selection is shown with its actual resolved subject and reason', await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value==='' && document.querySelector('[data-review-subject-resolution]').dataset.reviewSubjectId==='power-cable' && document.querySelector('[data-review-subject-resolution]').dataset.reviewSubjectMode==='automatic'`))
  await page.evaluate('document.querySelector("[data-review-subject-resolution]").scrollIntoView({block:"center"})')
  await page.screenshot(join(directory, '01-automatic.png'))
  await page.click(selector)
  // Native select interaction emits input; the shared standalone binding uses it.
  await page.evaluate(`(() => {const select=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'cabinet-shell');select.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('selecting a main object creates only a local draft and disables review', await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value==='cabinet-shell' && document.querySelector('[data-action="project-review"]').disabled && window.__subjectRequests.length===0`))
  check('the saved resolution remains visible until the draft is saved', await page.evaluate('document.querySelector("[data-review-subject-resolution]").dataset.reviewSubjectId') === 'power-cable')
  const clicked = await page.click('[data-action="brief-save"]'); check('the subject is saved by a reachable pointer action', clicked.via === 'pointer')
  await waitDisk(() => read('project.json').currentRevision === 'r0002')
  await page.waitFor('document.querySelector(\'[data-brief-base-revision="r0002"][data-brief-dirty="false"]\')!==null', 30000)
  const patchRequests = await page.evaluate('window.__subjectRequests'); requests.push(...patchRequests)
  check('the only scene operation changes the review subject and does not request a render', patchRequests.length === 1
    && JSON.stringify(patchRequests[0].body.patch.operations) === JSON.stringify([{ op: 'project.reviewSubject.set', entityId: 'cabinet-shell' }])
    && patchRequests[0].body.patch.baseRevision === 'r0001' && patchRequests[0].body.patch.saveCheckpoint === true && patchRequests[0].body.patch.renderPreview === false)
  const afterSpec = read('revisions', 'r0002', 'scene-spec.json'), withoutSubject = spec => {
    const result = JSON.parse(JSON.stringify(spec)); delete result.project.reviewSubjectId; return result
  }
  check('geometry, materials, complete scene and cameras remain identical apart from the subject binding', JSON.stringify(withoutSubject(beforeSpec)) === JSON.stringify(withoutSubject(afterSpec)))
  check('saving the binding creates a checkpoint without preview cost', existsSync(projectPath('revisions', 'r0002', 'scene.blend')) && read('revisions', 'r0002', 'revision-manifest.json').previews.length === 0)
  for (const file of ['scene-spec.json', 'scene.blend']) originals[projectPath('revisions', 'r0002', file)] = sha256(readFileSync(projectPath('revisions', 'r0002', file)))
  await page.reload(); await page.waitFor('document.querySelector(\'[data-brief-base-revision="r0002"]\')!==null', 45000)
  check('refresh preserves the native selector value and resolved explicit identity', await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value==='cabinet-shell' && document.querySelector('[data-review-subject-resolution]').dataset.reviewSubjectId==='cabinet-shell' && document.querySelector('[data-review-subject-resolution]').dataset.reviewSubjectMode==='explicit'`))
  await page.evaluate('document.querySelector("[data-review-subject-resolution]").scrollIntoView({block:"center"})'); await page.screenshot(join(directory, '02-explicit-after-refresh.png'))
  for (const [revision, expected] of [['r0001', ''], ['r0002', 'cabinet-shell']]) {
    await page.click('[data-view-tab="revisions"]'); await page.waitFor(`document.querySelector('[data-action="restore:${revision}"]')!==null`, 30000)
    const restore = await page.click(`[data-action="restore:${revision}"]`); check(`restore ${revision} is reachable by pointer`, restore.via === 'pointer')
    await waitDisk(() => read('project.json').currentRevision === revision)
    await page.click('[data-view-tab="projects"]'); await page.waitFor(`document.querySelector('[data-brief-base-revision="${revision}"]')!==null`, 30000)
    check(`restoring ${revision} restores its saved subject choice`, await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`) === expected)
  }
  const restoredWrites = await page.evaluate('window.__subjectRequests')
  check('both restores compare against the expected current revision', JSON.stringify(restoredWrites.map(request => request.body)) === JSON.stringify([
    { revision: 'r0001', expectedCurrentRevision: 'r0002' }, { revision: 'r0002', expectedCurrentRevision: 'r0001' }]))
  const review = await page.click('[data-action="project-review"]'); check('actual review starts only after a pointer request', review.via === 'pointer')
  await page.waitFor('document.querySelector("[data-review-error]")!==null', 300000)
  await page.waitFor('document.querySelector(\'[data-reviewed-subject="cabinet-shell"]\')!==null', 30000)
  const record = read('revisions', 'r0002', 'revision-manifest.json').reviews.at(-1)
  const reviewFile = projectPath(record.path), actual = JSON.parse(readFileSync(reviewFile)).review
  copyFileSync(reviewFile, join(directory, 'actual-review.json'))
  check('real rendered measurements persist the chosen cabinet shell as an explicit available subject', actual.subjectId === 'cabinet-shell'
    && actual.subject.id === 'cabinet-shell' && actual.subject.mode === 'explicit' && actual.subject.available === true && actual.viewCount > 0,
    { subject: actual.subject, score: actual.score, viewCount: actual.viewCount })
  check('the unavailable model yields an explicit error and no artistic pass', actual.reviewer.error?.code === 'VISUAL_REVIEW_MODEL_UNAVAILABLE' && actual.artistic.status === 'unassessable', actual.reviewer.error)
  check('QA shows persisted subject metadata rather than a draft or automatic fallback', await page.evaluate('document.querySelector("[data-reviewed-subject]").dataset.reviewedSubjectMode') === 'explicit')
  check('all original and edited SceneSpecs and checkpoints remain byte-identical through restore and review', Object.entries(originals).every(([path, hash]) => sha256(readFileSync(path)) === hash))
  check('review does not create another revision', read('project.json').currentRevision === 'r0002')
  requests.push(...await page.evaluate('window.__subjectRequests'))
  await page.evaluate('document.querySelector("[data-visual-actions]").scrollIntoView({block:"start"})'); await page.screenshot(join(directory, '03-explicit-review.png'))
  outcome = 'passed'
} catch (error) {
  console.error(error); results.push({ name: 'unexpected failure', ok: false, detail: error.stack || String(error) })
  if (page) await page.screenshot(join(directory, 'failure.png')).catch(() => {})
} finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) {
      outcome = 'failed'; results.push({ name: `${name} shutdown`, ok: false, detail: String(error) })
    }
  }
  const report = { startedAt, completedAt: new Date().toISOString(), outcome, url, root, directory, projectId, originals, requests, shutdown,
    results, passed: results.filter(result => result.ok).length, total: results.length,
    scope: 'Real native selector, saved subject binding, conditional restore and rendered subject measurements. SceneSpec geometry/cameras are identical; no before/after pixel equivalence or artistic approval claim.' }
  writeFileSync(join(directory, 'results.json'), JSON.stringify(report, null, 2))
  console.log(`Review-subject UI: ${report.passed}/${report.total}; ${directory}`)
}
if (outcome !== 'passed') process.exitCode = 1
