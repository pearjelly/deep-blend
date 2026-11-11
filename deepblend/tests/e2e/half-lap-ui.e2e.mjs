#!/usr/bin/env node
/** Preview and confirm real native timber cuts through the workbench. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { decodePng, validateSceneSpec } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { buildHalfLapFixture } from '../../examples/runtime-author/conformance.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const defaultOutput = join(REPO_ROOT, '.deepblend', 'quality', `half-lap-${Date.now()}`)
const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || defaultOutput)
if (existsSync(output)) throw Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const root = join(output, 'store')
const projectId = 'half-lap-timber'
const project = join(root, 'projects', projectId)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = (...parts) => JSON.parse(readFileSync(join(project, ...parts)))
const record = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + '\n')
const checks = []
function passed(name) {
  checks.push(name)
  console.log(`[PASS] ${name}`)
}

const sceneSpec = buildHalfLapFixture(projectId)
record('input.json', sceneSpec)

const control = name => `[data-field="editor-half-lap-${name}"]`
const element = selector => `document.querySelector(${JSON.stringify(selector)})`
const draftAction = '[data-action="half-lap-preview"]'
const saveAction = '[data-action="editor-apply"]'
let server, browser, page, failure, native
try {
  const validation = validateSceneSpec(sceneSpec)
  assert(validation.ok, validation.summary)
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  const endpoint = `${base}/deepblend/projects/${projectId}`
  const url = `${base}/deepblend/workbench`
  async function post(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000) })
    return { status: response.status, data: await response.json() }
  }
  const creation = await post(`${base}/deepblend/projects`, { projectId, title: sceneSpec.project.title, sceneSpec, renderPreview: true })
  assert.equal(creation.status, 200, JSON.stringify(creation.data.error))
  const before = read('revisions', 'r0001', 'scene-spec.json')
  const manifest = rev => read('revisions', rev, 'revision-manifest.json')
  const previewBefore = manifest('r0001').previews.at(-1)
  const originalFiles = ['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend', 'revisions/r0001/revision-manifest.json', previewBefore.path]
  const hashes = files => files.map(file => sha(readFileSync(join(project, file))))
  const originalHashes = hashes(originalFiles)
  const baseline = readFileSync(join(project, 'project.json'))
  const jobs = () => readdirSync(join(project, 'jobs')).sort()
  const originalJobs = jobs()
  const unchanged = () => {
    assert(baseline.equals(readFileSync(join(project, 'project.json'))))
    assert.deepEqual(jobs(), originalJobs)
    assert.deepEqual(readdirSync(join(project, 'revisions')), ['r0001'])
    assert.deepEqual(hashes(originalFiles), originalHashes)
  }
  writeFileSync(join(output, 'before.png'), readFileSync(join(project, previewBefore.path)))

  browser = await Browser.launch({ args: ['--window-size=1440,1100'] })
  page = await browser.newPage()
  await page.addInitScript(`window.__timberWrites = [];
    const original = window.fetch;
    window.fetch = async (url, options) => {
      const result = await original(url, options);
      if (options?.method === 'POST') window.__timberWrites.push({
        url: String(url), body: JSON.parse(options.body), status: result.status, data: await result.clone().json()
      });
      return result;
    }`)
  const waitFor = (selector, ms = 30000) => page.waitFor(`${element(selector)} !== null`, ms)
  const openEditor = async id => {
    assert.equal((await page.click('[data-view-tab="scene"]')).via, 'pointer')
    await clickWorkbenchControl(page, `[data-action="select-entity:${id}"]`)
    await waitFor(control('partner'))
  }
  const select = async (name, value) => {
    const selector = control(name)
    await page.evaluate(`(() => {
      const select = ${element(selector)};
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    assert.equal(await page.evaluate(`${element(selector)}.value`), value)
  }
  async function inspectDraft(index, lowerEntityId, upperEntityId) {
    assert.equal((await page.click(draftAction)).via, 'pointer')
    await waitFor('[data-half-lap-inspection="ready"]', 60000)
    await page.waitFor(`[...document.querySelectorAll('[data-half-lap-slot]')].length === 2
      && [...document.querySelectorAll('[data-half-lap-slot]')].every(img => img.complete && img.naturalWidth === 480)`, 15000)
    const response = await page.evaluate(`window.__timberWrites[${index}]`)
    assert.equal(response.status, 200)
    assert.match(response.url, /half-lap-preview$/)
    const { preview } = response.data
    assert.deepEqual(preview.joint, { lowerEntityId, upperEntityId })
    assert.equal(preview.baseRevision, 'r0001')
    assert.equal(preview.crossings, 12)
    assert.equal(preview.partialCrossings, 6)
    assert.equal(preview.sample, 'partial')
    for (const role of ['lower', 'upper']) {
      const bytes = Buffer.from(preview[role].pngBase64, 'base64')
      assert.equal(sha(bytes), preview[role].sha256)
      const image = decodePng(bytes)
      assert.deepEqual([image.width, image.height], [480, 320])
      writeFileSync(join(output, `preview-${index + 1}-${role}.png`), bytes)
    }
    unchanged()
    return { request: response.body, hash: preview.candidateSpecHash }
  }

  await page.goto(url)
  await waitFor('[data-lighttable-revision="r0001"]', 45000)
  await openEditor('timber-x')
  await select('partner', 'timber-y')
  assert.equal(await page.evaluate('window.__timberWrites.length'), 0)
  const first = await inspectDraft(0, 'timber-x', 'timber-y')
  passed('Actual draft preview produces both sides of a partial crossing and leaves saved bytes and jobs alone')
  await select('role', 'upper')
  assert.equal(await page.evaluate("document.querySelectorAll('[data-half-lap-slot]').length"), 0)
  const swapped = await inspectDraft(1, 'timber-y', 'timber-x')
  assert.notEqual(swapped.hash, first.hash)
  passed('Changing roles retires stale pictures and creates a different inspected draft')

  const rejected = await post(`${endpoint}/patch`, { patch: swapped.request.patch,
    expectedStoreIdentity: swapped.request.expectedStoreIdentity, expectedSpecHash: first.hash })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.data.error.code, 'REVISION_CONFLICT')
  unchanged()
  passed('A confirmation with the previous draft hash refuses before creating a revision or job')

  assert.equal((await page.click(saveAction)).via, 'pointer')
  await waitFor('[data-lighttable-revision="r0002"]', 90000)
  const save = await page.evaluate('window.__timberWrites[2]')
  assert.equal(save.status, 200)
  assert.equal(save.body.expectedSpecHash, swapped.hash)
  const pair = { lowerEntityId: 'timber-y', upperEntityId: 'timber-x' }
  assert.deepEqual(save.body.patch.operations, [{ op: 'joint.halfLap.set', ...pair }])
  assert.deepEqual(read('revisions', 'r0002', 'scene-spec.json'), { ...before, halfLaps: [pair] })
  assert.equal(manifest('r0002').specHashAfter, swapped.hash)
  const previewAfter = manifest('r0002').previews.at(-1)
  for (const key of ['cameraId', 'frame', 'width', 'height', 'engine', 'renderConfig']) assert.deepEqual(previewAfter[key], previewBefore[key])
  writeFileSync(join(output, 'after.png'), readFileSync(join(project, previewAfter.path)))
  passed('Pointer confirmation saves exactly the inspected revision and renders the original view')

  await page.goto(url)
  await waitFor('[data-lighttable-revision="r0002"]', 45000)
  await openEditor('timber-y')
  assert.equal(await page.evaluate(`${element(control('partner'))}.value`), 'timber-x')
  assert.equal(await page.evaluate(`${element(control('role'))}.value`), 'lower')
  await select('partner', '')
  assert.equal(await page.evaluate('window.__timberWrites.length'), 0)
  assert.equal((await page.click(saveAction)).via, 'pointer')
  await waitFor('[data-lighttable-revision="r0003"]', 90000)
  const removal = await page.evaluate('window.__timberWrites[0]')
  assert.equal(removal.status, 200)
  assert.deepEqual(removal.body.patch.operations, [{ op: 'joint.halfLap.set', ...pair, enabled: false }])
  assert.deepEqual(read('revisions', 'r0003', 'scene-spec.json'), before)
  assert.deepEqual(hashes(originalFiles), originalHashes)
  passed('The other group shows its saved role and can remove the joint without touching history')

  const readback = join(REPO_ROOT, 'deepblend/tests/blender-integration/half-lap-readback.py')
  const log = execFileSync(blenderPath, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
    '--python', readback, '--', project], { encoding: 'utf8', timeout: 40000 })
  writeFileSync(join(output, 'native.log'), log)
  const line = log.split('\n').find(row => row.startsWith('HALF_LAP_READBACK '))
  native = JSON.parse(line?.slice('HALF_LAP_READBACK '.length) ?? 'null')
  assert.deepEqual(native, { sampledCells: 126, originalOverlapCells: 24, joinedOverlapCells: 0, closedComponents: 7, removalRestoresOriginalSolids: true })
  passed('Independent Blender readback verifies both cut depths, all seven components and restoration')
} catch (error) {
  failure = error
  console.error(error)
  if (page) await page.screenshot(join(output, 'failure.png')).catch(() => {})
} finally {
  record('result.json', { ok: !failure, checks, native, error: failure?.stack })
  await browser?.close()
  await server?.stop()
}
if (failure) process.exitCode = 1
