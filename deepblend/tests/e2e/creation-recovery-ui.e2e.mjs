#!/usr/bin/env node
/** Real creation failures, a lost actual HTTP reply, explicit recovery and immutable output. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Browser } from '../../tools/browser-driver.mjs'
import { startWeb, storePatch, REPO_ROOT } from '../../tools/dsh-web-harness.mjs'
import { ensureWorkbenchCaptureReady } from '../../tools/docs-capture-visibility.mjs'

const out = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || '.deepblend/quality/creation-recovery-' + new Date().toISOString().replace(/[:.]/g, '-'))
if (existsSync(out)) throw Error('Evidence directory already exists: ' + out)
mkdirSync(out, { recursive: true })
const store = join(out, 'store'), checks = [], hash = bytes => createHash('sha256').update(bytes).digest('hex')
const record = (name, value) => writeFileSync(join(out, name + '.json'), JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
const actualBlender = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const app = actualBlender.match(/^(.*\.app)\/(Contents\/MacOS\/[^/]+)$/)
const alias = join(out, app ? 'Blender.app' : 'blender-install')
const configuredBlender = join(alias, app ? app[2] : basename(actualBlender))
const projectsRoot = join(store, 'projects')
const projects = () => existsSync(projectsRoot) ? readdirSync(projectsRoot).filter(id => existsSync(join(projectsRoot, id, 'project.json'))).sort() : []
function projectFiles(id) {
  const files = {}, root = join(projectsRoot, id)
  const walk = (path, prefix = '') => { for (const item of readdirSync(path, { withFileTypes: true })) {
    const name = prefix + item.name, full = join(path, item.name)
    if (item.isDirectory()) walk(full, name + '/'); else files[name] = hash(readFileSync(full))
  } }; walk(root); return files
}
let server, browser, page, paused, failure
const requestHistory = [], readHistory = []
const trackPage = async target => target.addInitScript(`window.__creationRequests=[];window.__creationReads=[];const original=window.fetch;
  window.fetch=async(url,init)=>{const creating=init?.method==='POST'&&String(url)==='/deepblend/projects';
    if(creating)window.__creationRequests.push(JSON.parse(init.body));const response=await original(url,init);
    if(String(url).startsWith('/deepblend/state')){const payload=await response.clone().json();window.__creationReads.push({url:String(url),payload});}return response;}`)
async function collectPage(target) {
  const captured = await target.evaluate(`({requests:window.__creationRequests,reads:window.__creationReads})`)
  requestHistory.push(...captured.requests); readHistory.push(...captured.reads)
  await target.evaluate(`(()=>{window.__creationRequests=[];window.__creationReads=[];return null})()`)
}
async function restoreDraft(target, title) {
  const action = await target.evaluate(`([...document.querySelectorAll('[data-creation-draft]')].find(n=>n.querySelector('strong')?.textContent===${JSON.stringify(title)})?.querySelector('[data-action^="restore-creation-draft:"]')?.dataset.action)`)
  if (!action) throw Error('No saved draft for ' + title)
  return target.click('[data-action=' + JSON.stringify(action) + ']')
}
try {
  const rows = JSON.parse(await storePatch(store))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = configuredBlender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  const patch = JSON.stringify(rows)
  server = await startWeb({ workspacePath: REPO_ROOT, patch, keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await trackPage(page)
  await page.goto(base + '/deepblend/workbench')
  await page.waitFor(`document.querySelector('[data-action="select-recipe:deepblend.metal-lamp@2.0.0"]')!==null`, 45000)
  await ensureWorkbenchCaptureReady(page)
  await page.click('[data-action="select-recipe:deepblend.metal-lamp@2.0.0"]')
  await page.fill('[data-field="project-title"]', 'recovered-environment')
  await page.fill('[data-field="project-goal"]', 'Keep the warm studio brief')
  await page.fill('[data-field="recipe-exposure"]', '.3')
  check('the initial creation uses a real pointer', (await page.click('[data-action="create-project"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[data-creation-recovery]')!==null&&document.querySelector('[data-action="create-project"]')?.disabled===false`, 45000)
  check('missing Blender leaves no published project', projects().length === 0)
  check('failure keeps the entered name, goal and parameters', await page.evaluate(`document.querySelector('[data-field="project-title"]').value==='recovered-environment'&&document.querySelector('[data-field="project-goal"]').value==='Keep the warm studio brief'&&Number(document.querySelector('[data-field="recipe-exposure"]').value)===.3`))
  check('failure gives a localised next step and an environment guide', await page.evaluate(`document.querySelector('[data-view=projects] [data-result=error]').innerText.includes('Blender')&&!!document.querySelector('[data-creation-recovery] a[href$="environment-check.md"]')`))
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '01-environment-failure.png'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: false })
  const narrowWrites = await page.evaluate('window.__creationRequests.length')
  check('narrow recovery reaches its real read-only refresh control', (await page.click('[data-action="refresh-creation-projects"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[data-action="retry-creation"]')!==null`)
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '02-narrow-recovery.png'))
  check('360px recovery controls are visible without overflowing or submitting another creation', await page.evaluate(`(()=>{const e=document.querySelector('[data-action="retry-creation"]'),r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth+1&&window.__creationRequests.length===${narrowWrites}})()`))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  // Repair only this test's configured executable location, without changing the user's installation.
  symlinkSync(app ? app[1] : dirname(actualBlender), alias, 'dir')
  await page.evaluate(`fetch('/deepblend/capabilities?refresh=1').then(r=>r.json()).then(()=>null)`)
  await collectPage(page); await page.reload()
  await page.waitFor(`document.querySelector('[data-creation-draft]')!==null`, 45000)
  check('page reload offers the saved failure without auto-submitting', await page.evaluate(`document.querySelector('[data-field="project-title"]').value===''&&window.__creationRequests.length===0`))
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '03-saved-draft-after-reload.png'))
  check('restoring the failed creation draft uses a real pointer', (await restoreDraft(page, 'recovered-environment')).via === 'pointer')
  check('restoring a saved failure does not submit before explicit retry', await page.evaluate('window.__creationRequests.length===0'))
  check('reloaded name, goal and recipe parameters match the captured draft', await page.evaluate(`document.querySelector('[data-field="project-title"]').value==='recovered-environment'&&document.querySelector('[data-field="project-goal"]').value==='Keep the warm studio brief'&&Number(document.querySelector('[data-field="recipe-exposure"]').value)===.3`))
  await page.fill('[data-field="project-title"]', 'newer-draft')
  await page.fill('[data-field="recipe-exposure"]', '.8')
  check('retrying the captured attempt uses a real pointer', (await page.click('[data-action="retry-creation"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.naturalWidth>0`, 180000)
  const firstRequests = [...requestHistory, ...await page.evaluate('window.__creationRequests')]
  check('repair retries the exact original creation key and parameters', firstRequests.length === 2 && JSON.stringify(firstRequests[0]) === JSON.stringify(firstRequests[1]))
  await page.click('[data-view-tab="projects"]')
  check('the original project is created, while newer typed inputs survive', projects().join() === 'recovered-environment'
    && await page.evaluate(`document.querySelector('[data-field="project-title"]')?.value==='newer-draft'&&Number(document.querySelector('[data-field="recipe-exposure"]')?.value)===.8`))
  const environmentSpec = JSON.parse(readFileSync(join(projectsRoot, 'recovered-environment/revisions/r0001/scene-spec.json')))
  check('saved native scene uses the captured exposure and goal', environmentSpec.renderProfiles.preview.colorManagement.exposure === .3
    && environmentSpec.project.goal === 'Keep the warm studio brief')
  const environmentBefore = projectFiles('recovered-environment')

  await page.fill('[data-field="project-title"]', 'recovered-reply')
  await page.fill('[data-field="recipe-exposure"]', '.4')
  await page.send('Fetch.enable', { patterns: [{ urlPattern: base + '/deepblend/projects', requestStage: 'Response' }] })
  paused = page._waitForEvent('Fetch.requestPaused')
  await page.click('[data-action="create-project"]')
  const response = await paused.promise
  check('the reply being dropped is an actual successful Host POST', response.request.method === 'POST' && response.responseStatusCode === 200)
  const captured = await page.send('Fetch.getResponseBody', { requestId: response.requestId })
  const reply = JSON.parse(captured.base64Encoded ? Buffer.from(captured.body, 'base64').toString() : captured.body)
  check('the committed reply identifies a real saved project', reply.ok && reply.project.projectId === 'recovered-reply' && projects().includes('recovered-reply'))
  record('dropped-host-reply', reply)
  const before = projectFiles('recovered-reply')
  await page.send('Fetch.failRequest', { requestId: response.requestId, errorReason: 'ConnectionReset' }); await page.send('Fetch.disable')
  await page.waitFor(`document.querySelector('[data-creation-recovery]')!==null&&document.querySelector('[data-action="retry-creation"]')?.disabled===false`, 45000)
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '03-uncertain-reply.png'))
  const requestsBefore = await page.evaluate('window.__creationRequests.length')
  await page.click('[data-action="refresh-creation-projects"]')
  await page.waitFor(`document.querySelector('[data-action="select-project:recovered-reply"]')!==null`, 15000)
  check('checking the saved project list sends no new creation', await page.evaluate('window.__creationRequests.length') === requestsBefore)
  await collectPage(page); await page.close(); page = await browser.newPage(); await trackPage(page)
  await page.goto(base + '/deepblend/workbench'); await page.waitFor(`document.querySelector('[data-creation-draft]')!==null`, 45000)
  check('closing and reopening the tab preserves the uncertain draft without a POST', await page.evaluate(`document.querySelector('[data-field="project-title"]').value===''&&window.__creationRequests.length===0`))
  check('reopened uncertain creation is restored by a real pointer', (await restoreDraft(page, 'recovered-reply')).via === 'pointer')
  check('restoring a reopened uncertain result does not auto-submit', await page.evaluate('window.__creationRequests.length===0'))
  await page.click('[data-action="retry-creation"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.naturalWidth>0`, 45000)
  check('lost-reply retry keeps exactly the two intended projects', projects().join() === 'recovered-environment,recovered-reply')
  check('no old scene, image, job or revision file changes during recovery', JSON.stringify(projectFiles('recovered-reply')) === JSON.stringify(before)
    && JSON.stringify(projectFiles('recovered-environment')) === JSON.stringify(environmentBefore))
  const requests = [...requestHistory, ...await page.evaluate('window.__creationRequests')]
  check('the uncertain request reuses its key and changed inputs used a fresh key', requests.length === 4
    && JSON.stringify(requests[2]) === JSON.stringify(requests[3]) && requests[0].creationKey !== requests[2].creationKey)
  check('recovery is explicitly labelled and uncommitted versions never became a global error', await page.evaluate(`document.querySelector('[data-view=preview] [data-result=ok]')?.innerText.includes('未重复')&&window.__creationReads.every(r=>r.payload.ok&&!JSON.stringify(r.payload.error||{}).includes('r0000'))`))
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '04-recovered.png'))
  await page.click('[data-view-tab="projects"]'); await page.fill('[data-field="project-title"]', 'First page draft')
  await page.fill('[data-field="project-goal"]', 'First page keeps its own goal')
  const secondPage = await browser.newPage(); await trackPage(secondPage); await secondPage.goto(base + '/deepblend/workbench')
  await secondPage.waitFor(`document.querySelector('[data-action="create-project"]')!==null`, 45000)
  await secondPage.fill('[data-field="project-title"]', 'Second page draft')
  await page.fill('[data-field="project-goal"]', 'First page changed later')
  check('two real pages keep separate browser drafts without creating projects', await secondPage.evaluate(`document.querySelector('[data-field="project-title"]').value==='Second page draft'&&window.__creationRequests.length===0`)
    && await page.evaluate(`Object.keys(localStorage).filter(k=>k.startsWith('deepblend.creation-draft/v1:')).map(k=>JSON.parse(localStorage.getItem(k)).forms.title).includes('First page draft')&&Object.keys(localStorage).filter(k=>k.startsWith('deepblend.creation-draft/v1:')).map(k=>JSON.parse(localStorage.getItem(k)).forms.title).includes('Second page draft')`))
  await collectPage(page); await collectPage(secondPage); await page.close(); await secondPage.close()
  page = await browser.newPage(); await trackPage(page); await page.goto(base + '/deepblend/workbench')
  await page.waitFor(`document.querySelectorAll('[data-creation-draft]').length>=2`, 45000)
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '05-independent-saved-drafts.png'))
  await restoreDraft(page, 'First page draft')
  check('an unsent draft survives closed tabs and still requires explicit creation', await page.evaluate(`document.querySelector('[data-field="project-title"]').value==='First page draft'&&document.querySelector('[data-field="project-goal"]').value==='First page changed later'&&window.__creationRequests.length===0`) && projects().length === 2)
  const deleteAction = await page.evaluate(`([...document.querySelectorAll('[data-creation-draft]')].find(n=>n.querySelector('strong')?.textContent==='Second page draft')?.querySelector('[data-action^="delete-creation-draft:"]')?.dataset.action)`)
  await page.click('[data-action=' + JSON.stringify(deleteAction) + ']')
  check('deleting one browser draft keeps current inputs and both saved projects', await page.evaluate(`document.querySelector('[data-field="project-title"]').value==='First page draft'&&window.__creationRequests.length===0&&!Object.keys(localStorage).filter(k=>k.startsWith('deepblend.creation-draft/v1:')).some(k=>JSON.parse(localStorage.getItem(k)).forms.title==='Second page draft')`) && projects().length === 2)
  const port = server.port; await server.stop()
  server = await startWeb({ workspacePath: REPO_ROOT, port, patch, keepHome: false })
  const replay = await fetch(base + '/deepblend/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requests[2]) }).then(r => r.json())
  check('a restarted actual Host still recovers the same keyed request', replay.ok && replay.project.creationReplayed && replay.project.projectId === 'recovered-reply'
    && JSON.stringify(projectFiles('recovered-reply')) === JSON.stringify(before) && projects().length === 2)
  await collectPage(page); record('requests', requestHistory); record('state-reads', readHistory)
  record('sources', { before, environmentBefore, replay, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })
} catch (error) { failure = error.stack || String(error); console.error(error); record('browser-console', page?.consoleLog ?? []); await page?.screenshot(join(out, 'failure.png')).catch(() => {}) }
finally {
  paused?.cancel(); await browser?.close(); await server?.stop()
  // Evidence must not expand this temporary symlink into the complete application.
  // Only the owned link is removed; the real Blender installation remains untouched.
  try {
    const aliasStat = lstatSync(alias, { throwIfNoEntry: false })
    if (aliasStat) { if (!aliasStat.isSymbolicLink()) throw Error('The temporary executable alias is not a symlink'); unlinkSync(alias) }
    check('the temporary application alias is absent from retained evidence', !lstatSync(alias, { throwIfNoEntry: false }))
  } catch (error) { failure ||= error.stack || String(error); console.error(error) }
  record('report', { status: failure ? 'failed' : 'passed', checks, failure,
    scope: 'Real Chrome, DSH and native Blender. Actual lost HTTP reply, browser reload, closed/reopened tabs, independent page drafts, explicit restoration/deletion, current inputs, original pixels/files/jobs, 360px and a restarted Host. Only the temporary application alias is removed from evidence; the real installation is unchanged. No online model calls.' })
}
console.log(`Creation recovery: ${failure ? 'FAILED' : 'PASSED'}; ${checks.filter(item => item.ok).length}/${checks.length} checks passed; ${out}`)
if (failure) process.exitCode = 1
