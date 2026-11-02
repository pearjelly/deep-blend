/** Image delivery through real Chrome, Host and Blender with deliberately absent encoders. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import yauzl from 'yauzl'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const out = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `still-delivery-ui-${Date.now()}`))
if (existsSync(out)) throw Error(`Preserve existing evidence: ${out}`)
const root = join(out, 'store'), id = 'still-delivery-ui', checks = [], missing = join(out, 'definitely-missing-encoder')
mkdirSync(out, { recursive: true })
const file = (...parts) => join(root, 'projects', id, ...parts), read = (...parts) => JSON.parse(readFileSync(file(...parts), 'utf8'))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const check = (name, value, detail) => { checks.push({ name, ok: Boolean(value), detail }); console.log(`[${value ? 'PASS' : 'FAIL'}] ${name}`); if (!value) throw Error(name) }
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
let server, browser, page, failure, shutdown
try {
  check('the configured encoder and probe are genuinely absent', !existsSync(missing))
  const rows = JSON.parse(await storePatch(root)), host = rows.find(row => row.id === 'deepblend-blender-host')
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  host.config.ffmpegPath = missing; host.config.ffprobePath = missing
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows) }); const base = `http://127.0.0.1:${server.port}`
  const spec = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json'), 'utf8'))
  spec.project.id = id; spec.project.title = 'Image delivery without an encoder'
  spec.renderProfiles.preview = { ...spec.renderProfiles.preview, resolution: [160, 120], samples: 2, maxSamplesBudget: 2 }
  spec.renderProfiles.final = { ...spec.renderProfiles.final, resolution: [240, 180], samples: 4, maxSamplesBudget: 4 }
  const response = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: id, title: spec.project.title, sceneSpec: spec, renderPreview: false }) })
  const created = await response.json(); if (!response.ok || !created.ok) throw Error(JSON.stringify(created))
  const original = hash(file('revisions', 'r0001', 'scene.blend'))
  mkdirSync(file('output'), { recursive: true }); writeFileSync(file('output', 'final.mp4'), 'previous video sentinel')
  const previousOutput = hash(file('output', 'final.mp4'))
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] }); page = await browser.newPage()
  await page.addInitScript(`window.__renders=[];const original=window.fetch;window.fetch=async(input,init)=>{if(init?.method==='POST'&&String(input).endsWith('/render')){const item={body:JSON.parse(init.body)};window.__renders.push(item);const response=await original(input,init);item.response=await response.clone().json();return response}return original(input,init)}`)
  await page.goto(`${base}/deepblend/workbench`); await page.waitFor(`document.querySelector('[data-lighttable-revision="r0001"]')!==null`, 60000)
  await page.click('[data-view-tab="jobs"]'); await page.waitFor(`document.querySelector('[data-field="render-delivery-kind"]')!==null`, 60000)
  await page.fill('[data-field="frame-start"]', '1'); await page.fill('[data-field="frame-end"]', '1')
  const setSelect = async (field, value) => page.evaluate(`(()=>{const e=document.querySelector('[data-field="'+${JSON.stringify(field)}+'"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  const submit = async index => {
    check(`request ${index + 1} is started through the visible button`, (await clickWorkbenchControl(page, '[data-action="start-render"]')).via === 'pointer')
    await page.waitFor(`window.__renders[${index}]?.response!==undefined`, 120000)
    const request = await page.evaluate(`window.__renders[${index}]`)
    if (!request.response.ok) throw Error(JSON.stringify(request))
    return request
  }
  const terminal = async jobId => {
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      const job = read('renders', jobId, 'job.json')
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job
      await sleep(250)
    }
    throw Error(`Job ${jobId} did not finish within the observation budget`)
  }
  const videoRequest = await submit(0), videoId = videoRequest.response.job.jobId, video = await terminal(videoId)
  check('video delivery fails at the absent encoder after its Blender frame exists', video.status === 'failed' && existsSync(file('renders', videoId, 'frames', 'frame_0001.png')) && /ENCODE|FFMPEG/i.test(video.errorCode || ''), { status: video.status, errorCode: video.errorCode, message: video.message })
  await page.waitFor(`document.querySelector('[data-job="${videoId}"]')?.textContent.includes('failed')`, 30000)
  await setSelect('render-delivery-kind', 'still'); await setSelect('render-profile', 'final'); await setSelect('render-still-preset', 'still-2560x1440')
  const stillRequest = await submit(1), stillId = stillRequest.response.job.jobId, still = await terminal(stillId)
  check('the workbench sends an explicit single-frame image request', stillRequest.body.deliveryKind === 'still' && stillRequest.body.stillPreset === 'still-2560x1440' && stillRequest.body.revision === 'r0001' && stillRequest.body.frameStart === 1 && stillRequest.body.frameEnd === 1, stillRequest.body)
  check('image-only delivery completes even though the encoder and probe are unavailable', still.status === 'completed' && still.delivery?.kind === 'still' && still.delivery.verified === true && !still.delivery.videoPath && !existsSync(file('renders', stillId, 'encoded', `${stillId}.mp4`)), still.delivery)
  const manifest = read('renders', stillId, 'manifest.json'), imagePath = file('renders', stillId, 'frames', 'frame_0001.png'), image = decodePng(readFileSync(imagePath))
  check('the actual Blender PNG and saved receipt match the selected resolution and frame', image.width === 2560 && image.height === 1440 && manifest.schemaVersion === 'deepblend.still-delivery/v1' && manifest.image.frame === 1 && manifest.image.sha256 === hash(imagePath) && manifest.render.config.samples === 4, manifest.image)
  const downloads = join(out, 'downloads'); mkdirSync(downloads); await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true })
  const link = `[data-action="download-frame:${stillId}"]`; await page.waitFor(`document.querySelector(${JSON.stringify(link)})!==null`, 60000)
  check('the image-only job offers a real PNG download', (await clickWorkbenchControl(page, link)).via === 'pointer')
  const deadline = Date.now() + 30000; while (Date.now() < deadline && !readdirSync(downloads).some(name => name.endsWith('.png'))) await sleep(100)
  const name = readdirSync(downloads).find(value => value.endsWith('.png'))
  check('the downloaded PNG is the exact rendered image', Boolean(name) && hash(join(downloads, name)) === hash(imagePath), { name, sha256: hash(imagePath) })
  check('the image job is not described as a video and the original scene remains unchanged', await page.evaluate(`document.querySelector('[data-job="${stillId}"]')?.textContent.includes('图片来源已核验')&&!document.querySelector('[data-action="download-video:${stillId}"]')`) && hash(file('revisions', 'r0001', 'scene.blend')) === original && read('project.json').currentRevision === 'r0001')
  check('neither failed video nor successful image delivery overwrites the prior video output', hash(file('output', 'final.mp4')) === previousOutput)
  // Fault-inject the durable state after a frame exists, as though publication had
  // been interrupted. This does not claim to have killed a real Host process.
  const frameHash = hash(imagePath), interrupted = { ...still, status: 'recovering', delivery: null, outputManifest: null, finishedAt: null, message: 'fixture: interrupted before image publication' }
  writeFileSync(file('renders', stillId, 'job.json'), JSON.stringify(interrupted, null, 2) + '\n')
  await page.click('[data-action="reload"]'); await page.waitFor(`document.querySelector('[data-action="resume:${stillId}"]')!==null`, 30000)
  check('the interrupted image job can be resumed through the workbench', (await clickWorkbenchControl(page, `[data-action="resume:${stillId}"]`)).via === 'pointer')
  await page.waitFor('window.__renders[2]?.response!==undefined', 60000)
  const resumedRequest = await page.evaluate('window.__renders[2]'), resumed = await terminal(stillId)
  check('recovery republishes the existing exact image without another render or encoder', resumedRequest.body.resumeJobId === stillId && resumed.status === 'completed' && resumed.delivery?.kind === 'still' && resumed.attempt === still.attempt && hash(imagePath) === frameHash && hash(file('output', 'final.mp4')) === previousOutput, resumed.delivery)
  await page.click('[data-view-tab="revisions"]')
  const imageCheckbox = `[data-field="snapshot-image"][data-job-id="${stillId}"]`
  await page.waitFor(`document.querySelector(${JSON.stringify(imageCheckbox)})!==null`, 60000)
  check('the same-version image is selected for the editable copy by a real pointer', (await clickWorkbenchControl(page, imageCheckbox)).via === 'pointer')
  check('the combined editable copy is prepared by a real pointer', (await clickWorkbenchControl(page, '[data-action="snapshot-prepare"]')).via === 'pointer')
  await page.waitFor(`document.querySelector('[data-action="snapshot-download"]')!==null||document.querySelector('[data-editable-snapshot="failed"]')!==null`, 180000)
  const copyError = await page.evaluate(`document.querySelector('[data-editable-snapshot="failed"]')?.innerText||null`); if (copyError) throw Error(copyError)
  check('the combined editable copy downloads through the workbench', (await clickWorkbenchControl(page, '[data-action="snapshot-download"]')).via === 'pointer')
  const zipDeadline = Date.now() + 60000; while (Date.now() < zipDeadline && !readdirSync(downloads).some(name => name.endsWith('.zip'))) await sleep(100)
  const zipName = readdirSync(downloads).find(value => value.endsWith('.zip')); if (!zipName) throw Error('Editable copy was not downloaded')
  const archive = await yauzl.openPromise(join(downloads, zipName), { lazyEntries: true }), members = new Map()
  try { for await (const member of archive.eachEntry()) { const chunks = []; for await (const chunk of await archive.openReadStreamPromise(member)) chunks.push(chunk); members.set(member.fileName, Buffer.concat(chunks)) } } finally { archive.close() }
  const copiedImage = members.get(`renders/${stillId}/frames/frame_0001.png`), copiedScene = members.get('revisions/r0001/scene.blend')
  check('the archive contains the exact selected PNG and editable scene from one revision', Boolean(copiedImage && copiedScene) && createHash('sha256').update(copiedImage).digest('hex') === frameHash && createHash('sha256').update(copiedScene).digest('hex') === original && JSON.parse(members.get('snapshot-manifest.json')).selectedImages[0].jobId === stillId)
  await page.screenshot(join(out, 'workbench.png'))
  writeFileSync(join(out, 'receipts.json'), JSON.stringify({ videoRequest, video, stillRequest, still, manifest, interrupted, resumedRequest, resumed }, null, 2) + '\n')
} catch (error) { failure = error; console.error(error.stack || String(error)); if (page) await page.screenshot(join(out, 'failure.png')).catch(() => {}) }
finally { try { await browser?.close() } catch (error) { failure ??= error } try { shutdown = await server?.stop() } catch (error) { failure ??= error }
  writeFileSync(join(out, 'result.json'), JSON.stringify({ passed: !failure, checks, shutdown, error: failure ? String(failure) : null }, null, 2) + '\n') }
if (failure) process.exitCode = 1
else console.log(`Still image delivery UI: ${checks.length}/${checks.length} checks passed; ${out}`)
