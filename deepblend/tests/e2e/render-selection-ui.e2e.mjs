#!/usr/bin/env node
/** Real browser → UI handler → Host → Blender render selection and revision pinning.
 * Runs three small frames, with no model calls. Each run retains an isolated store,
 * native reports, frames, request history, screenshots and shutdown evidence.
 * Included in full acceptance and the independent Linux editing job.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { decodePng, sceneSpecDigest } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const requestedOutput = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality',
  `render-selection-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(requestedOutput)) throw Error(`Evidence directory already exists: ${requestedOutput}`)
mkdirSync(requestedOutput, { recursive: true })
// Match the Host's canonical paths, including macOS /tmp → /private/tmp.
const output = realpathSync(requestedOutput)
const root = join(output, 'store'), projectId = 'render-selection-ui', checks = [], jobs = [], pageErrors = []
const startedAt = new Date().toISOString(), cleanup = { cancellations: [], shutdown: null, processes: [] }
const file = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(file(...parts), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const redact = value => String(value).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function bounded(operation, label, timeoutMs = 5000) {
  let timer
  try {
    return await Promise.race([operation, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}
function check(name, ok, detail) {
  checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`)
}
let server, browser, page, base, failure, requests = [], protectedSources

async function post(path, body, timeoutMs = 180000) {
  const response = await fetch(`${base}/deepblend${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw Error(`${path}: ${JSON.stringify(payload)}`)
  return payload
}

async function selectProfile(value) {
  await page.evaluate(`(() => {
    const element = document.querySelector('[data-field="render-profile"]')
    if (!element) throw Error('render profile control is missing')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)})
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

async function receipt(index) {
  await page.waitFor(`window.__renderRequests[${index}]?.receipt !== undefined`, 60000)
  const request = await page.evaluate(`window.__renderRequests[${index}]`)
  check('the browser received a render job from the real Host', request.receipt.ok === true, request)
  return request
}

async function completed(jobId) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (existsSync(file('renders', jobId, 'job.json'))) {
      const job = read('renders', jobId, 'job.json')
      if (job.status === 'completed') return job
      if (['failed', 'cancelled'].includes(job.status)) throw Error(`Render ${jobId}: ${job.errorCode}: ${job.message}`)
    }
    await sleep(250)
  }
  throw Error(`Render ${jobId} did not complete within 180 seconds`)
}

async function verifyJob(request, profileName, revision, frames, cameraId, resolution) {
  const jobId = request.receipt.job.jobId, job = await completed(jobId)
  const plan = read('renders', jobId, 'plan.json'), envelope = read('renders', jobId, 'result.json')
  const manifest = read('renders', jobId, 'manifest.json'), spec = read('revisions', revision, 'scene-spec.json')
  const expected = { ...spec.renderProfiles[profileName], ...(resolution ? { resolution } : {}) }, native = envelope.result
  check(`${profileName}: browser request pins the selected profile, revision and frame range`,
    request.body.profile === profileName && request.body.revision === revision
      && request.body.frameStart === frames[0] && request.body.frameEnd === frames.at(-1), request.body)
  check(`${profileName}: job and renderer plan use the selected source and configuration`,
    job.revisionId === revision && job.profileName === profileName && job.sceneSpecDigest === sceneSpecDigest(spec)
      && plan.profileName === profileName && plan.checkpoint === job.checkpointPath
      && isDeepStrictEqual(plan.frames, frames) && isDeepStrictEqual(plan.profile.resolution, expected.resolution)
      && plan.profile.samples === expected.samples && job.renderConfig.samples === expected.samples
      && isDeepStrictEqual(job.renderConfig.resolution, expected.resolution), { job, plan })
  if (cameraId) check(`${profileName}: the selected camera is used by the request, render plan and Blender`,
    request.body.cameraId === cameraId && plan.cameraId === cameraId && native.cameraId === cameraId,
    { request: request.body.cameraId, plan: plan.cameraId, actual: native.cameraId })
  check(`${profileName}: Blender reports the actual native samples and dimensions`,
    envelope.status === 'success' && native.profileName === profileName
      && native.renderConfig.samples === expected.samples
      && isDeepStrictEqual(native.renderConfig.resolution, expected.resolution)
      && isDeepStrictEqual(native.renderedFrames, frames), envelope)
  const pixels = frames.map(frame => {
    const name = `${plan.filePrefix}${String(frame).padStart(plan.padding, '0')}.png`
    const bytes = readFileSync(file('renders', jobId, 'frames', name)), png = decodePng(bytes)
    check(`${profileName}: frame ${frame} contains actual PNG pixels at the selected size`,
      png.width === expected.resolution[0] && png.height === expected.resolution[1], { width: png.width, height: png.height })
    return { frame, path: file('renders', jobId, 'frames', name), sha256: sha(bytes), width: png.width, height: png.height }
  })
  check(`${profileName}: verified delivery keeps this job's source and measured video dimensions`,
    job.delivery.verified === true && manifest.revisionId === revision
      && manifest.source.sceneSpecDigest === job.sceneSpecDigest && manifest.render.profileName === profileName
      && manifest.render.config.samples === expected.samples && manifest.video.verified === true
      && manifest.video.probed.width === expected.resolution[0] && manifest.video.probed.height === expected.resolution[1]
      && manifest.video.probed.frameCount === frames.length, manifest)
  const evidence = { jobId, revision, profileName, job, plan, native, manifest, pixels }
  jobs.push(evidence); json(`${profileName}-${jobId}.json`, evidence)
  await page.waitFor(`document.querySelector('[data-job="${jobId}"]')?.textContent.includes('completed')`, 30000)
  await page.screenshot(join(output, `${profileName}-completed.png`))
  return evidence
}

function scopedProcesses() {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes(root) && /blender/i.test(line))
    .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), command: line.trim() }))
}

try {
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  if (!existsSync(blenderPath)) throw Error(`Set DEEPBLEND_BLENDER_PATH; Blender not found at ${blenderPath}`)
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.finalRenderProfile = 'final'
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  base = `http://127.0.0.1:${server.port}`
  json('server-info.json', { root, url: `${base}/deepblend/workbench`, port: server.port, pid: server.child.pid, hostDefault: 'final' })
  const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json'), 'utf8'))
  spec.project.id = projectId; spec.project.title = 'Render profile and revision selection'
  spec.renderProfiles.preview = { ...spec.renderProfiles.preview, resolution: [160, 120], samples: 4, maxSamplesBudget: 4 }
  spec.renderProfiles.final = { ...spec.renderProfiles.final, resolution: [240, 180], samples: 12, maxSamplesBudget: 12 }
  await post('/projects', { projectId, title: spec.project.title, sceneSpec: spec, renderPreview: false })
  protectedSources = Object.fromEntries(['scene-spec.json', 'scene.blend'].map(name => [name, sha(readFileSync(file('revisions', 'r0001', name)))]))

  browser = await Browser.launch({ args: ['--window-size=1440,1000'] })
  page = await browser.newPage('about:blank', { onConsole: (type, text) => {
    if (type === 'error' || type === 'exception') pageErrors.push(redact(`${type}: ${text}`))
  } })
  await page.addInitScript(`
    window.__renderRequests = []
    const originalFetch = window.fetch
    window.fetch = async (input, init) => {
      if (init?.method !== 'POST' || !/\\/render$/.test(String(input))) return originalFetch(input, init)
      const request = { url: String(input), body: JSON.parse(init.body) }
      window.__renderRequests.push(request)
      if (window.__holdNextRender) {
        window.__holdNextRender = false
        await new Promise(resolve => { window.__releaseRender = resolve })
      }
      try {
        const response = await originalFetch(input, init)
        request.status = response.status
        request.receipt = await response.clone().json()
        return response
      } catch (error) { request.receipt = { ok: false, error: String(error) }; throw error }
    }
  `)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]") !== null', 45000)
  await page.click('[data-view-tab="jobs"]')
  await page.waitFor('document.querySelector("[data-action=start-render]") !== null')
  await page.fill('[data-field="frame-start"]', '1'); await page.fill('[data-field="frame-end"]', '2')
  await page.evaluate(`(() => { const e = document.querySelector('[data-field="render-camera"]'); e.value = 'camera-top'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await page.waitFor(`document.querySelector('[data-field="render-still-preset"] option[value="video-1920x1080"]')!==null`)
  await page.evaluate(`(()=>{const e=document.querySelector('[data-field="render-still-preset"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'video-1920x1080');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await selectProfile('preview'); await page.screenshot(join(output, 'preview-selected.png'))

  // Hold the actual browser request after the click, before the real HTTP call.
  // A separate editor commits r0002 in that interval; forwarding the untouched
  // request must still render r0001, not whichever revision is current later.
  await page.evaluate('window.__holdNextRender = true')
  check('preview is submitted by the visible native button', (await page.click('[data-action="start-render"]')).via === 'pointer')
  await page.waitFor('typeof window.__releaseRender === "function"')
  const held = await page.evaluate('window.__renderRequests[0]')
  check('the clicked request already contains the loaded source before it reaches the Host',
    held.body.revision === 'r0001' && held.body.profile === 'preview' && held.body.cameraId === 'camera-top' && held.body.videoPreset === 'video-1920x1080', held)
  const update = await post(`/projects/${projectId}/patch`, { patch: { projectId, baseRevision: 'r0001',
    saveCheckpoint: false, renderPreview: false, operations: [
      { op: 'render.profile.set', profileName: 'preview', profile: { resolution: [96, 64], samples: 1 } },
      { op: 'entity.transform.update', entityId: 'watch-body', location: [0, -0.2, 0.02] },
      { op: 'camera.remove', cameraId: 'camera-top' },
    ] } })
  check('another editor publishes a genuinely different current revision before the render request arrives',
    update.revision.revision === 'r0002' && read('project.json').currentRevision === 'r0002'
      && sceneSpecDigest(read('revisions', 'r0002', 'scene-spec.json')) !== sceneSpecDigest(read('revisions', 'r0001', 'scene-spec.json')), update)
  await page.evaluate('(() => { window.__releaseRender(); delete window.__releaseRender })()')
  const preview = await verifyJob(await receipt(0), 'preview', 'r0001', [1, 2], 'camera-top', [1920, 1080])
  execFileSync('ffmpeg', ['-v', 'error', '-i', file('renders', preview.jobId, 'encoded', `${preview.jobId}.mp4`), '-f', 'null', '-'], { timeout: 60000 })
  check('the 1080p video is fully decoded independently', true)
  check('the completed job displays the camera that produced the frames',
    await page.evaluate(`document.querySelector('[data-job="${preview.jobId}"] [data-job-camera="camera-top"]') !== null`))
  check('the first task preserves its old checkpoint and sources after the newer revision is current',
    preview.plan.checkpoint === file('revisions', 'r0001', 'scene.blend') && read('project.json').currentRevision === 'r0002'
      && Object.entries(protectedSources).every(([name, hash]) => sha(readFileSync(file('revisions', 'r0001', name))) === hash))

  await page.click('[data-action="reload"]')
  await page.waitFor("document.querySelector('[data-lighttable-revision=r0002]') !== null")
  await page.click('[data-action="start-render"]')
  check('a camera removed from the current revision is refused without sending a new render request',
    await page.evaluate(`window.__renderRequests.length === 1 && document.querySelector('[data-view="jobs"]').textContent.includes('所选相机在当前版本中不存在')`))
  const refused = await fetch(`${base}/deepblend/projects/${projectId}/render`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 'r0002', cameraId: 'camera-top', frameStart: 3, frameEnd: 3, profile: 'final' }) })
  const refusedPayload = await refused.json()
  check('the Host also refuses a missing camera before creating a job', !refused.ok && refusedPayload.error?.code === 'SCENE_CAMERA_MISSING'
    && readdirSync(file('renders')).filter(name => /^render-[0-9]+$/.test(name)).length === 1, refusedPayload)
  await page.evaluate(`(() => { const e = document.querySelector('[data-field="render-camera"]'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await selectProfile('final'); await page.fill('[data-field="frame-start"]', '3'); await page.fill('[data-field="frame-end"]', '3')
  await page.waitFor(`document.querySelector('[data-field="render-still-preset"]')!==null`)
  await page.evaluate(`(()=>{const e=document.querySelector('[data-field="render-still-preset"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'still-2560x1440');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  check('final is submitted by the visible native button', (await page.click('[data-action="start-render"]')).via === 'pointer')
  const request = await receipt(1)
  check('the browser explicitly requests the single-frame delivery preset', request.body.stillPreset === 'still-2560x1440')
  const final = await verifyJob(request, 'final', 'r0002', [3], null, [2560, 1440])
  const downloads = join(output, 'downloads'); mkdirSync(downloads)
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
  const frameLink = `[data-action="download-frame:${final.jobId}"]`
  await page.waitFor(`document.querySelector(${JSON.stringify(frameLink)}) !== null`, 30000)
  check('the saved single-frame render can be downloaded through the real workbench', (await page.click(frameLink)).via === 'pointer')
  const downloadDeadline = Date.now() + 30000
  while (Date.now() < downloadDeadline && !readdirSync(downloads).some(name => name.endsWith('.png'))) await sleep(100)
  const downloadedName = readdirSync(downloads).find(name => name.endsWith('.png'))
  check('the browser receives the exact task PNG with its revision in the name', Boolean(downloadedName)
    && downloadedName.includes('r0002') && sha(readFileSync(join(downloads, downloadedName))) === final.pixels[0].sha256,
    { downloadedName, expected: final.pixels[0].sha256 })
  check('later rendering keeps the earlier job frames byte-identical', preview.pixels.every(frame => sha(readFileSync(frame.path)) === frame.sha256))
  requests = await page.evaluate('window.__renderRequests')
  check('the browser sent exactly the two requested render operations', requests.length === 2, requests)
  check('the browser logged no errors', pageErrors.length === 0, pageErrors)
} catch (error) {
  failure = redact(error.stack || String(error)); checks.push({ name: 'workflow completes without unexpected failure', ok: false, detail: failure })
  console.error(failure)
  if (page) {
    await bounded(page.screenshot(join(output, 'failure.png')), 'failure screenshot').catch(error => { cleanup.screenshotError = redact(error) })
    json('failure-dom.json', await bounded(page.evaluate('({text:document.body.textContent,requests:window.__renderRequests})'), 'failure DOM').catch(error => ({ error: redact(error) })))
  }
} finally {
  if (page) requests = await bounded(page.evaluate('window.__renderRequests'), 'request evidence').catch(error => {
    cleanup.requestEvidenceError = redact(error); return requests
  })
  // Discover jobs from disk too: the renderer may have started before a failed
  // browser response made its job id available to this process.
  if (server && existsSync(file('renders'))) {
    for (const jobId of readdirSync(file('renders'))) {
      if (!existsSync(file('renders', jobId, 'job.json'))) continue
      try {
        const job = read('renders', jobId, 'job.json')
        if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
          cleanup.cancellations.push({ jobId, result: await post(`/projects/${projectId}/jobs/${jobId}/cancel`, { reason: 'render selection acceptance cleanup' }, 30000) })
        }
      } catch (error) { failure ??= redact(error); cleanup.cancellations.push({ jobId, error: redact(error) }) }
    }
  }
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try {
      const result = await bounded(close(), `${name} shutdown`, name === 'server' ? 20000 : 5000)
      if (name === 'server') cleanup.shutdown = result
      if (name === 'browser' && browser) {
        cleanup.browser = { pid: browser.child.pid, exitCode: browser.child.exitCode, signalCode: browser.child.signalCode }
        if (browser.child.exitCode === null && browser.child.signalCode === null) failure ??= 'Browser shutdown was not confirmed'
      }
    }
    catch (error) {
      failure ??= redact(error); cleanup[name] = { error: redact(error) }
      if (name === 'browser' && browser && browser.child.exitCode === null && browser.child.signalCode === null) {
        try {
          browser.child.kill('SIGKILL'); await sleep(250)
          cleanup.browser = { ...cleanup.browser, pid: browser.child.pid, forcedTermination: true,
            exitCode: browser.child.exitCode, signalCode: browser.child.signalCode }
        } catch (cause) { cleanup.browser.forceError = redact(cause) }
      }
    }
  }
  if (server) {
    writeFileSync(join(output, 'server.log'), redact(server.output.join('')))
    if (cleanup.shutdown?.via !== 'sigterm') failure ??= `Server shutdown was ${cleanup.shutdown?.via ?? 'unconfirmed'}`
  }
  try {
    const deadline = Date.now() + 5000
    while ((cleanup.processes = scopedProcesses()).length && Date.now() < deadline) await sleep(100)
    if (cleanup.processes.length) {
      failure ??= 'Blender processes survived normal server shutdown'
      cleanup.forcedTermination = cleanup.processes.map(processInfo => {
        try { process.kill(processInfo.pid, 'SIGKILL'); return { ...processInfo, signalled: true } }
        catch (error) { return { ...processInfo, error: redact(error) } }
      })
      await sleep(250); cleanup.afterForcedTermination = scopedProcesses()
    }
  } catch (error) { failure ??= redact(error); cleanup.processInspectionError = redact(error) }
  json('requests.json', requests); json('shutdown.json', cleanup)
  json('report.json', { schemaVersion: 'deepblend.render-selection-ui/v1', startedAt, finishedAt: new Date().toISOString(),
    status: failure ? 'failed' : 'passed', failure, output, root, projectId, protectedSources, checks, pageErrors,
    jobs: jobs.map(({ jobId, revision, profileName, pixels }) => ({ jobId, revision, profileName, pixels })), cleanup,
    scope: 'Real Chrome, Host, Blender and encoder; profile/revision selection, native samples, PNG dimensions and delivery provenance. No model calls or artistic approval. Resume and reduced-budget rendering remain separate acceptance work.' })
}
console.log(`Render selection UI: ${checks.filter(item => item.ok).length}/${checks.length} checks passed; ${output}`)
if (failure) process.exitCode = 1
