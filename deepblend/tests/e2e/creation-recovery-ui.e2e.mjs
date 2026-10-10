#!/usr/bin/env node
/** Real creation failures, a lost actual HTTP reply, explicit recovery and immutable output. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs'
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
try {
  const rows = JSON.parse(await storePatch(store))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = configuredBlender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  const patch = JSON.stringify(rows)
  server = await startWeb({ workspacePath: REPO_ROOT, patch, keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.addInitScript(`window.__creationRequests=[];window.__creationReads=[];const original=window.fetch;
    window.fetch=async(url,init)=>{const creating=init?.method==='POST'&&String(url)==='/deepblend/projects';
      if(creating)window.__creationRequests.push(JSON.parse(init.body));const response=await original(url,init);
      if(String(url).startsWith('/deepblend/state')){const payload=await response.clone().json();window.__creationReads.push({url:String(url),payload});}return response;}`)
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
  await page.fill('[data-field="project-title"]', 'newer-draft')
  await page.fill('[data-field="recipe-exposure"]', '.8')
  check('retrying the captured attempt uses a real pointer', (await page.click('[data-action="retry-creation"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.naturalWidth>0`, 180000)
  const firstRequests = await page.evaluate('window.__creationRequests')
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
  await page.click('[data-action="retry-creation"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.naturalWidth>0`, 45000)
  check('lost-reply retry keeps exactly the two intended projects', projects().join() === 'recovered-environment,recovered-reply')
  check('no old scene, image, job or revision file changes during recovery', JSON.stringify(projectFiles('recovered-reply')) === JSON.stringify(before)
    && JSON.stringify(projectFiles('recovered-environment')) === JSON.stringify(environmentBefore))
  const requests = await page.evaluate('window.__creationRequests')
  check('the uncertain request reuses its key and changed inputs used a fresh key', requests.length === 4
    && JSON.stringify(requests[2]) === JSON.stringify(requests[3]) && requests[0].creationKey !== requests[2].creationKey)
  check('recovery is explicitly labelled and uncommitted versions never became a global error', await page.evaluate(`document.querySelector('[data-view=preview] [data-result=ok]')?.innerText.includes('未重复')&&window.__creationReads.every(r=>r.payload.ok&&!JSON.stringify(r.payload.error||{}).includes('r0000'))`))
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(out, '04-recovered.png'))
  const port = server.port; await server.stop()
  server = await startWeb({ workspacePath: REPO_ROOT, port, patch, keepHome: false })
  const replay = await fetch(base + '/deepblend/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requests[2]) }).then(r => r.json())
  check('a restarted actual Host still recovers the same keyed request', replay.ok && replay.project.creationReplayed && replay.project.projectId === 'recovered-reply'
    && JSON.stringify(projectFiles('recovered-reply')) === JSON.stringify(before) && projects().length === 2)
  record('requests', requests); record('state-reads', await page.evaluate('window.__creationReads'))
  record('sources', { before, environmentBefore, replay, sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })
} catch (error) { failure = error.stack || String(error); console.error(error); record('browser-console', page?.consoleLog ?? []); await page?.screenshot(join(out, 'failure.png')).catch(() => {}) }
finally { paused?.cancel(); await browser?.close(); await server?.stop(); record('report', { status: failure ? 'failed' : 'passed', checks, failure,
  scope: 'Real Chrome, DSH and native Blender. Missing executable repaired only in an isolated alias; the actual successful HTTP reply is dropped with CDP. Recovery, newer inputs, pixels/files/jobs, 360px and a restarted Host are observed. No online model calls.' }) }
console.log(`Creation recovery: ${failure ? 'FAILED' : 'PASSED'}; ${checks.filter(item => item.ok).length}/${checks.length} checks passed; ${out}`)
if (failure) process.exitCode = 1
