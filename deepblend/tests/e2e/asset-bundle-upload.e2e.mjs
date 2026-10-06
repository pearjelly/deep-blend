#!/usr/bin/env node
/** Real FileList/directory input, raw File transfers and glTF/GLB/OBJ preview/apply.
 * No synthetic input events or fake Host receipts. Run serially with native access.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { writeAssetUploadFixtures } from '../lib/asset-upload-fixtures.mjs'

const directory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `asset-bundle-upload-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(directory)) throw Error(`Evidence already exists: ${directory}`)
const root = join(directory, 'store'), sources = join(directory, 'sources'), projectId = 'bundle-upload', pickerProjectId = 'bundle-upload-other'
mkdirSync(sources, { recursive: true })
const checks = [], applications = [], history = [], startedAt = new Date().toISOString()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value) }
const json = (name, value) => write(join(directory, name), JSON.stringify(value, null, 2) + '\n')
const record = (name, value) => appendFileSync(join(directory, name), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
const path = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(path(...parts)))
const current = () => read('project.json').currentRevision
const check = (name, ok, detail) => {
  const result = { name, ok: Boolean(ok), detail }; checks.push(result); record('checks.jsonl', result)
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail)}`)
}
const entrypoints = writeAssetUploadFixtures(sources)
const sourceFiles = folder => readdirSync(join(sources, folder), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => join(entry.parentPath ?? entry.path, entry.name)).sort()
json('fixtures.json', Object.fromEntries(Object.keys(entrypoints).map(folder => [folder, { entrypoint: entrypoints[folder], files: sourceFiles(folder).map(file => ({ path: relative(join(sources, folder), file).split('\\').join('/'), bytes: readFileSync(file).length, sha256: sha(readFileSync(file)) })) }])))
function snapshotSource() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw Error(`Cannot identify tested source: ${result.stderr}`)
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort().map(file => ({ path: file, sha256: sha(readFileSync(join(REPO_ROOT, file))) }))
}
const beforeSource = snapshotSource()
json('source-before.json', { rows: beforeSource, head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(), note: 'HEAD identifies the base when this worktree is uncommitted; rows identify the actual tested bytes.' })
const blenderPath = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const scene = defaultSceneSpec({ projectId, title: 'Browser resource bundles', goal: 'Preserve authored resources until explicit scene application.' })
scene.renderProfiles.preview = { engine: 'cycles', resolution: [256, 192], samples: 8, maxSamplesBudget: 8, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 } }
let server, browser, page, base, outcome = 'failed', shutdown, originals, stage = 'prerequisites'
const field = name => `[data-field="${name}"]`
const card = row => `[data-asset-id="${row.asset.id}"][data-asset-path="${row.asset.path}"]`
async function api(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10000) })
  const result = await response.json(); if (!response.ok || !result.ok) throw Error(`${route}: ${JSON.stringify(result)}`)
  return result
}
const inventory = async () => (await api(`/deepblend/projects/${projectId}/assets`)).assets
const idle = () => page.waitFor('!document.querySelector("[data-field=asset-bundle-files]")?.disabled&&!document.querySelector("[data-asset-bundle-progress]")', 30000)
async function pointer(selector) {
  await page.waitFor(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n&&!n.disabled})()`)
  const click = await page.click(selector); record('actions.jsonl', { stage, selector, ...click })
  check(`${stage}: ${selector} receives a real pointer`, click.via === 'pointer')
}
async function key(key, code, keyCode, modifiers = 0) {
  const macCodes = { KeyA: 0, Tab: 48, Escape: 53 }
  const text = key === 'Tab' ? '\t' : key === 'Escape' ? '\x1b' : key.length === 1 ? key : undefined
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode,
    ...(process.platform === 'darwin' && macCodes[code] !== undefined ? { nativeVirtualKeyCode: macCodes[code] } : {}), modifiers,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
    ...(type === 'keyDown' && code === 'KeyA' && modifiers ? { commands: ['selectAll'] } : {}), })
}
async function entrypoint(value) {
  const selector = field('asset-bundle-entrypoint')
  const choices = await page.evaluate(`(()=>{
    const select=document.querySelector(${JSON.stringify(selector)})
    const visible=node=>node&&!node.hidden&&getComputedStyle(node).display!=='none'&&!['hidden','collapse'].includes(getComputedStyle(node).visibility)
    return {value:select?.value,visible:visible(select)&&!select.disabled&&select.getClientRects().length>0&&!select.closest('[hidden],[inert]'),
      options:Array.from(select?.options||[]).filter(option=>{
        const group=option.closest('optgroup')
        return visible(option)&&!option.disabled&&(!group||visible(group)&&!group.disabled)
      }).map(option=>({value:option.value,label:option.label}))}
  })()`)
  const targets = choices.options.filter(option => option.value === value)
  const target = targets[0], labelKey = label => label.normalize('NFC').toLowerCase()
  check(`${stage}: requested entrypoint has one visible, enabled label`, choices.visible && value && targets.length === 1 && target.label
    && choices.options.filter(option => labelKey(option.label) === labelKey(target.label)).length === 1, { value, choices })
  if (choices.value === value) return
  // Focus by real Tab navigation, then use one unambiguous type-ahead key.
  // Opening Cocoa's popup and continuing after its first committed character
  // can strand later CDP keys on a select the synchronous redraw replaced.
  const firstCharacter = Array.from(target.label)[0], characterKey = labelKey(firstCharacter)
  check(`${stage}: one native key identifies the requested entrypoint`,
    /^[cm]$/i.test(firstCharacter) && choices.options.filter(option => labelKey(option.label).startsWith(characterKey)).length === 1)
  const tab = async () => {
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', {
      type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
      ...(process.platform === 'darwin' ? { nativeVirtualKeyCode: 48 } : {}), text: '\t', unmodifiedText: '\t',
    })
  }
  for (let index = 0; index < 20 && !await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`); index++) await tab()
  check(`${stage}: native Tab focuses the visible entrypoint select`, await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`))
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', {
    type, key: firstCharacter, code: `Key${firstCharacter.toUpperCase()}`, windowsVirtualKeyCode: firstCharacter.toUpperCase().charCodeAt(0),
    ...(process.platform === 'darwin' ? { nativeVirtualKeyCode: characterKey === 'c' ? 8 : 46 } : {}), text: firstCharacter, unmodifiedText: firstCharacter,
  })
  await page.waitFor(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`)
  await tab()
}
async function typeText(selector, value) {
  await pointer(selector)
  await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2)
  const selection = await page.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return {focused:document.activeElement===n,start:n.selectionStart,end:n.selectionEnd,length:n.value.length}})()`)
  check(`${stage}: native select-all covers the focused text`, selection.focused && selection.start === 0 && selection.end === selection.length, selection)
  await page.send('Input.insertText', { text: value }); await key('Tab', 'Tab', 9)
  const actual = await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value`)
  check(`${stage}: keyboard input retained`, actual === value, { expected: value, actual })
}
// Keep capture readiness observable even when animation callbacks are suspended.
function captureLayoutSnapshot(selector) {
  const target = document.querySelector(selector), library = document.querySelector('[data-assets-library]')
  const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(value => Math.round(value * 10) / 10) }
  const images = Array.from(library?.querySelectorAll('img') || [])
  return { ready: Boolean(target && library && target.getClientRects().length && document.fonts?.status !== 'loading' && images.every(image => image.complete && image.naturalWidth > 0)),
    viewport: [innerWidth, innerHeight, scrollX, scrollY, document.documentElement.scrollWidth], target: target ? rect(target) : null,
    controls: Array.from(library?.querySelectorAll('input,select,button,[role=status],img') || []).map(node => ({ tag: node.tagName, field: node.dataset.field, action: node.dataset.action, disabled: node.disabled, rect: rect(node), image: node.tagName === 'IMG' ? [node.complete, node.naturalWidth, node.naturalHeight] : undefined })),
    // Progress text changes during a real transfer; its geometry and presence must settle, not its percentage.
    phase: { progress: Boolean(library?.querySelector('[data-asset-bundle-progress]')), error: library?.querySelector('.db-error')?.textContent || '', assets: Array.from(library?.querySelectorAll('[data-asset-id]') || []).map(node => node.dataset.assetId) } }
}
async function waitForStableCapture(read, { timeoutMs = 4000, pollMs = 100, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now(); let previous = null, stable = 0
  while (now() - started < timeoutMs) {
    const snapshot = await read(), signature = JSON.stringify(snapshot)
    stable = snapshot.ready && signature === previous ? stable + 1 : 0; previous = signature
    if (stable >= 3) return snapshot
    await pause(pollMs)
  }
  throw Error('Capture layout did not settle within its observation budget')
}
function observePageCommands(target) {
  const send = target.send.bind(target)
  target.send = async (method, params = {}, options = {}) => {
    const commandId = target._nextId, startedAt = Date.now()
    record('cdp-commands.jsonl', { phase: 'sent', commandId, method, params, options, startedAt })
    try {
      const result = await send(method, params, options)
      const receipt = method === 'Page.captureScreenshot' ? { pngBytes: Buffer.from(result.data, 'base64').length, pngSha256: sha(Buffer.from(result.data, 'base64')) } : result
      record('cdp-commands.jsonl', { phase: 'received', commandId, method, startedAt, finishedAt: Date.now(), result: receipt }); return result
    } catch (error) {
      record('cdp-commands.jsonl', { phase: 'rejected', commandId, method, startedAt, finishedAt: Date.now(), error: { code: error.code, message: error.message } }); throw error
    }
  }
}
async function capture(label, selector = '[data-asset-bundle-picker]', narrow = false) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`)
  await waitForStableCapture(async () => { const snapshot = await page.evaluate(`(${captureLayoutSnapshot.toString()})(${JSON.stringify(selector)})`); record('layout-samples.jsonl', { label, selector, snapshot }); return snapshot })
  const dom = await page.evaluate(`(()=>{const box=document.querySelector('[data-assets-library]');return {lang:document.documentElement.lang,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,text:box?.innerText,controls:Array.from(box?.querySelectorAll('input,select,button,[role=status],img')||[]).map(n=>{const r=n.getBoundingClientRect();return {tag:n.tagName,field:n.dataset.field,action:n.dataset.action,text:n.textContent,disabled:n.disabled,value:n.type==='file'?undefined:n.value,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,naturalWidth:n.naturalWidth,naturalHeight:n.naturalHeight}})}})()`)
  json(`${label}.dom.json`, dom); await page.screenshot(join(directory, `${label}.png`))
  if (narrow) check(`${label}: active library controls fit the narrow desktop viewport`, dom.scrollWidth <= dom.width + 1 && dom.controls.filter(n => n.width > 0).every(n => n.left >= -1 && n.right <= dom.width + 1), dom)
  json('browser-evidence.json', await page.evaluate('window.__uploadAudit.export()'))
}
async function openFilePicker(name) {
  // Chromium rejects directory enumeration for hidden WebContents even when
  // CDP dispatched a trusted pointer. Re-activate this owned page after captures.
  const priorVisibility = await page.evaluate('document.visibilityState')
  await page.send('Page.bringToFront')
  await page.waitFor('document.visibilityState === "visible"')
  record('picker-activation.jsonl', { stage, priorVisibility, visibility: await page.evaluate('document.visibilityState') })
  await page.waitFor(`(()=>{const n=document.querySelector(${JSON.stringify(field(name))});return n&&!n.disabled})()`)
  await page.send('DOM.getDocument')
  await page.send('Page.setInterceptFileChooserDialog', { enabled: true })
  const opened = page._waitForEvent('Page.fileChooserOpened')
  let chooser
  try { await pointer(field(name)); chooser = await opened.promise }
  finally { opened.cancel() }
  // Ordinary polls may replace an idle node before the pointer. The actual
  // chooser supplies the opened control; a pre-click snapshot is not its identity.
  const described = await page.send('DOM.describeNode', { backendNodeId: chooser.backendNodeId })
  const pushed = await page.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [chooser.backendNodeId] })
  const nodeId = pushed.nodeIds[0]
  const remote = await page.send('DOM.resolveNode', { backendNodeId: chooser.backendNodeId })
  const observed = await page.send('Runtime.callFunctionOn', { objectId: remote.object.objectId,
    functionDeclaration: 'function(){return window.__uploadAudit.watch(this)}', returnByValue: true })
  const identity = observed.result.value
  check(`${stage}: real pointer opens the observed native file control`, nodeId > 0 && identity.connected && !identity.disabled && identity.field === name)
  record('file-chooser-events.jsonl', { stage, chooser })
  record('file-nodes.jsonl', { stage, nodeId, backendNodeId: chooser.backendNodeId, identity, attributes: described.node.attributes })
  return { nodeId, objectId: remote.object.objectId, identity }
}
async function select(folder, mode = 'directory', files = sourceFiles(folder), whileOpen) {
  const name = mode === 'directory' ? 'asset-bundle-directory' : 'asset-bundle-files'
  const previous = await page.evaluate('window.__uploadAudit.selections.length')
  const node = await openFilePicker(name)
  if (whileOpen) await whileOpen(node)
  // Deliver to the exact object resolved from the opened chooser, rather than
  // remapping it through a frontend node id that belongs to a DOM snapshot.
  record('picker-page-state.jsonl', { stage, state: await page.evaluate('({visibility:document.visibilityState,focus:document.hasFocus(),url:location.href})') })
  const terminalMark = await page.evaluate('window.__uploadAudit.fileEvents.length')
  await page.send('DOM.setFileInputFiles', { objectId: node.objectId, files: mode === 'directory' ? [join(sources, folder)] : files })
  await page.waitFor(`window.__uploadAudit.fileEvents.slice(${terminalMark}).some(e=>e.kind==='target-event'&&e.node.uid===${node.identity.uid}&&['input','cancel'].includes(e.type))`)
  const terminal = await page.evaluate(`window.__uploadAudit.fileEvents.slice(${terminalMark}).find(e=>e.kind==='target-event'&&e.node.uid===${node.identity.uid}&&['input','cancel'].includes(e.type))`)
  check(`${stage}: native selection returns trusted input rather than cancellation`, terminal.type === 'input' && terminal.trusted, terminal)
  await page.waitFor(`window.__uploadAudit.selections.length>${previous}&&window.__uploadAudit.selections.at(-1).files.every(f=>f.sha256)`)
  const selected = await page.evaluate('window.__uploadAudit.selections.at(-1)')
  const expected = files.map(file => ({ path: mode === 'directory' ? relative(join(sources, folder), file).split('\\').join('/') : file.split('/').at(-1), bytes: readFileSync(file).length, sha256: sha(readFileSync(file)) }))
  const normalized = selected.files.map(file => ({ path: mode === 'directory' ? file.relativePath.split('/').slice(1).join('/') : file.name, bytes: file.size, sha256: file.sha256 }))
  check(`${stage}: trusted input preserves real FileList paths and source bytes`, selected.eventType === 'input' && selected.trusted && selected.files.length > 0 && JSON.stringify(normalized.sort((a,b)=>a.path.localeCompare(b.path))) === JSON.stringify(expected.sort((a,b)=>a.path.localeCompare(b.path))) && selected.files.every(file => mode === 'directory' ? file.relativePath.startsWith(folder + '/') : file.relativePath === ''), { selected, expected })
  await page.waitFor('document.querySelector("[data-field=asset-bundle-entrypoint]")!==null')
  check(`${stage}: upload requires an explicit entrypoint`, await page.evaluate('document.querySelector("[data-action=asset-bundle-upload]").disabled'))
}
async function verifyPickerContexts() {
  // Returning [] through DOM.setFileInputFiles on an empty intercepted picker
  // produced no trusted cancel in the preserved native probe. It does not
  // exercise OS-dialog cancellation; lifecycle cancel remains a CPU contract.
  stage = 'picker-same-source-refresh'
  await select('gltf-first', 'directory', sourceFiles('gltf-first'), async node => {
    const mark = await page.evaluate('window.__uploadAudit.requests.length')
    await pointer('[data-action=reload]')
    // Wait for the explicit refresh and the next ordinary idle poll. No timer
    // is disabled, and the FileList is delivered only after both real reads.
    await page.waitFor(`window.__uploadAudit.requests.slice(${mark}).filter(r=>r.url.includes('/deepblend/state?')&&r.finished&&r.status===200).length>=2`, 20000)
    const identity = await page.evaluate(`window.__uploadAudit.watch(document.querySelector(${JSON.stringify(field('asset-bundle-directory'))}))`)
    check('same-source refresh and idle poll preserve the pending file input identity', identity.uid === node.identity.uid && identity.connected && identity.context === node.identity.context, { before: node.identity, after: identity })
  })
  const originalSelection = await page.evaluate('document.querySelector("[data-asset-bundle-picker]").innerText')
  stage = 'picker-cross-project-late'
  const old = await openFilePicker('asset-bundle-directory')
  const mark = await page.evaluate('window.__uploadAudit.requests.length')
  await pointer('[data-view-tab=projects]'); await pointer(`[data-action="select-project:${pickerProjectId}"]`)
  await page.waitFor(`Boolean(document.querySelector('[data-brief-project="${pickerProjectId}"]'))`)
  await pointer('[data-view-tab=scene]'); await pointer('[data-action=assets-open]')
  await page.waitFor(`Boolean(document.querySelector('[data-assets-library="${pickerProjectId}"] [data-asset-bundle-picker]'))`)
  await page.send('DOM.setFileInputFiles', { objectId: old.objectId, files: [join(sources, 'obj')] })
  await page.waitFor(`window.__uploadAudit.fileEvents.some(e=>e.kind==='target-event'&&e.type==='input'&&e.node.uid===${old.identity.uid})`)
  const late = await page.evaluate(`window.__uploadAudit.fileEvents.find(e=>e.kind==='target-event'&&e.type==='input'&&e.node.uid===${old.identity.uid})`)
  check('a trusted late FileList from the detached old input cannot become the new project selection', late.trusted && !late.node.connected && !await page.count('[data-field=asset-bundle-entrypoint]'), late)
  await capture('00-other-project-rejects-late-selection', '[data-asset-bundle-picker]')
  await pointer('[data-view-tab=projects]'); await pointer(`[data-action="select-project:${projectId}"]`)
  await page.waitFor(`Boolean(document.querySelector('[data-brief-project="${projectId}"]'))`); await pointer('[data-view-tab=scene]')
  await page.waitFor('Boolean(document.querySelector("[data-asset-bundle-picker]"))')
  const events = await page.evaluate('window.__uploadAudit.fileEvents.length')
  await page.send('DOM.setFileInputFiles', { objectId: old.objectId, files: [join(sources, 'glb')] })
  await page.waitFor(`window.__uploadAudit.fileEvents.slice(${events}).some(e=>e.kind==='target-event'&&e.type==='input'&&e.node.uid===${old.identity.uid})`)
  check('returning to the original project cannot revive the old picker or make a POST', await page.evaluate(`document.querySelector('[data-asset-bundle-picker]').innerText===${JSON.stringify(originalSelection)}&&window.__uploadAudit.requests.slice(${mark}).every(r=>r.method==='GET')`))
  check('picker-only interactions preserve both saved revisions and the empty other library', current() === 'r0001' && JSON.parse(readFileSync(join(root, 'projects', pickerProjectId, 'project.json'))).currentRevision === 'r0001' && (await api(`/deepblend/projects/${pickerProjectId}/assets`)).assets.length === 0)
  await capture('00-original-project-selection-preserved', '[data-asset-bundle-picker]')
}
async function upload(folder, mode = 'directory', lostComplete = false) {
  stage = `upload-${folder}`
  const before = await inventory(), revision = current()
  await select(folder, mode); await entrypoint(entrypoints[folder])
  if (lostComplete) await page.evaluate("window.__uploadAudit.dropNext='complete'")
  await pointer('[data-action=asset-bundle-upload]'); await idle()
  await page.waitFor(`document.querySelectorAll('[data-asset-id]').length===${before.length + 1}`, 30000)
  const row = (await inventory()).find(item => !before.some(prior => prior.asset.path === item.asset.path && prior.asset.id === item.asset.id))
  check(`${folder}: upload only registers an unchecked asset`, row && !row.inspection && !row.declaredInRevision && current() === revision)
  const ledger = read('assets/manifest.json').assets.find(item => item.assetId === row.asset.id && item.path === row.asset.path)
  check(`${folder}: referenced dependency bytes survive`, ledger?.bundle?.files.length > 0 && ledger.bundle.files.every(member => sha(readFileSync(join(sources, folder, member.path))) === sha(readFileSync(path('assets/bundles', ledger.bundle.sha256, member.path)))))
  if (lostComplete) {
    const requests = await page.evaluate('window.__uploadAudit.requests')
    const lost = requests.find(item => item.dropped === 'complete')
    check('lost complete response recovers the actual published receipt without duplicate registration', lost?.response?.status === 'completed' && requests.some(item => item.url.endsWith('/cancel') && item.response?.receipt?.uploadId === lost.response.uploadId && item.response.status === 'completed') && !await page.evaluate('Boolean(document.querySelector("[data-assets-library] .db-error"))'))
  }
  json(`${folder}-asset.json`, { row, ledger }); return row
}
async function inspect(row, name, narrow = false) {
  stage = `inspect-${name}`; const revision = current()
  await idle(); await pointer(`${card(row)} [data-action="asset-preview:${row.asset.id}"]`)
  await page.waitFor(`(()=>{const i=document.querySelector(${JSON.stringify(card(row) + ' img[data-asset-preview]')});return i?.complete&&i.naturalWidth>0&&i.naturalHeight>0})()`, 180000)
  await idle(); const result = (await inventory()).find(item => item.asset.id === row.asset.id && item.asset.path === row.asset.path)
  const bytes = readFileSync(path(result.preview.path)), image = decodePng(bytes)
  check(`${name}: native inspection reports UV/materials and an actual matching PNG`, result.inspection?.kind === 'model' && result.inspection.parts.some(part => part.uvMaps?.length && part.sourceMaterialSlots?.length) && result.preview.sha256 === sha(bytes) && image.width === result.preview.width && image.height === result.preview.height && current() === revision)
  copyFileSync(path(result.preview.path), join(directory, `${name}-preview.png`)); json(`${name}-inspection.json`, result)
  await capture(`${name}-preview-ui`, card(row), narrow); return result
}
function preserveRevision(revision) {
  history.push({ revision, files: ['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(name => ({ name, sha256: sha(readFileSync(path('revisions', revision, name))) })) })
}
async function apply(row, name, narrow = false) {
  stage = `apply-${name}`; const before = current(); preserveRevision(before)
  await pointer(`${card(row)} [data-action="asset-use:${row.asset.id}"]`)
  await typeText(field('asset-entity-id'), `uploaded-${name}`)
  await capture(`${name}-apply-draft`, '[data-asset-draft]', narrow)
  await pointer('[data-action=asset-apply]')
  await page.waitFor(`(()=>{const i=document.querySelector('[data-compare=right] img[data-artifact-revision]');return i?.dataset.artifactRevision&&i.dataset.artifactRevision!==${JSON.stringify(before)}&&i.complete&&i.naturalWidth>0})()`, 180000)
  const after = current(), spec = read('revisions', after, 'scene-spec.json'), manifest = read('revisions', after, 'revision-manifest.json')
  const entity = spec.entities.find(item => item.id === `uploaded-${name}`), asset = spec.assets.find(item => item.id === entity?.assetId), preview = manifest.previews.at(-1)
  check(`${name}: explicit application publishes the exact asset and a valid saved preview`, after !== before && asset?.path === row.asset.path && asset.sha256 === row.asset.sha256 && !entity.materialId && !entity.materialBindings && preview?.sha256 === sha(readFileSync(path(preview.path))) && existsSync(path('revisions', after, 'scene.blend')))
  const png = decodePng(readFileSync(path(preview.path))); check(`${name}: saved preview dimensions match its actual receipt`, png.width > 0 && png.height > 0 && preview.width === png.width && preview.height === png.height, { width: png.width, height: png.height })
  copyFileSync(path(preview.path), join(directory, `${after}-${name}-applied.png`)); applications.push({ name, before, after, entity, asset, preview })
  json('applications.json', applications)
  await pointer('[data-view-tab=scene]'); await page.waitFor('document.querySelector("[data-assets-library]")!==null')
  if (!await page.count('[data-asset-bundle-picker]')) { await pointer('[data-action=assets-open]'); await page.waitFor('document.querySelector("[data-asset-bundle-picker]")!==null') }
  await idle(); await capture(`${name}-applied`, '[data-assets-library]', narrow)
}

// Runs before the real client. Observe raw File objects and trusted events; only
// the explicitly armed response-loss cases change the request's outcome.
function installUploadAudit() {
  const audit = { requests: [], selections: [], events: [], fileEvents: [], dropNext: null,
    export() { return { requests: this.requests, selections: this.selections, events: this.events, fileEvents: this.fileEvents, dropNext: this.dropNext } } }
  window.__uploadAudit = audit
  const emit = value => console.info('__UPLOAD_AUDIT__' + JSON.stringify({ at: Date.now(), ...value }))
  const identities = new WeakMap(), attached = new WeakSet(); let nextIdentity = 1
  const describe = node => {
    if (!identities.has(node)) identities.set(node, nextIdentity++)
    return { uid: identities.get(node), connected: node.isConnected, field: node.dataset.field, context: node.dataset.fileContext,
      attributes: Array.from(node.attributes).map(attribute => [attribute.name, attribute.value]), disabled: node.disabled,
      files: Array.from(node.files || []).map(file => ({ name: file.name, size: file.size, relativePath: file.webkitRelativePath })) }
  }
  const fileEvent = (kind, node, event) => { const row = { at: Date.now(), kind, type: event?.type, trusted: event?.isTrusted, node: describe(node) }; audit.fileEvents.push(row); emit({ kind: 'file-node', event: row }) }
  audit.watch = node => {
    if (!attached.has(node)) { attached.add(node); for (const type of ['input', 'change', 'cancel']) node.addEventListener(type, event => fileEvent('target-event', node, event), true) }
    return describe(node)
  }
  const inputs = node => [...(node.matches?.('input[type=file]') ? [node] : []), ...(node.querySelectorAll?.('input[type=file]') || [])]
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target.type === 'file') fileEvent('attribute', record.target)
      for (const removed of record.removedNodes || []) for (const node of inputs(removed)) fileEvent('removed', node)
      for (const added of record.addedNodes || []) for (const node of inputs(added)) { audit.watch(node); fileEvent('added', node) }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'webkitdirectory', 'data-file-context'] })
  for (const type of ['input', 'change', 'cancel']) document.addEventListener(type, event => { if (event.target?.type === 'file') fileEvent('document-event', event.target, event) }, true)
  const digest = async file => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(v => v.toString(16).padStart(2, '0')).join('')
  // Standalone onChange runs on input and can synchronously replace/clear the
  // file node. Capture the native input before that target handler consumes it.
  document.addEventListener('input', event => {
    const target = event.target
    if (target?.type !== 'file' || !target.dataset.field?.startsWith('asset-bundle-')) return
    const files = Array.from(target.files), selection = { field: target.dataset.field, eventType: event.type, trusted: event.isTrusted,
      files: files.map(file => ({ name: file.name, size: file.size, type: file.type, relativePath: file.webkitRelativePath })) }
    audit.selections.push(selection); emit({ kind: 'selection', selection })
    Promise.all(files.map(async (file, index) => { selection.files[index].sha256 = await digest(file) }))
      .then(() => emit({ kind: 'selection-hashes', selection })).catch(error => { selection.error = String(error); emit({ kind: 'selection-error', error: String(error) }) })
  }, true)
  for (const type of ['pointerdown', 'pointerup', 'click', 'keydown']) document.addEventListener(type, event => {
    const target = event.target.closest?.('[data-action],[data-field],[data-view-tab]')
    if (!target) return
    const rect = target.getBoundingClientRect(), item = { type, trusted: event.isTrusted, action: target.dataset.action, field: target.dataset.field,
      tab: target.dataset.viewTab, disabled: target.disabled, key: event.key, x: event.clientX, y: event.clientY,
      box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }
    audit.events.push(item); emit({ kind: 'input', event: item })
  }, true)
  const original = window.fetch
  window.fetch = async function(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href).href
    if (!url.includes('/deepblend/')) return original.call(this, input, init)
    const body = init?.body, item = { url, method: init?.method || 'GET', startedAt: Date.now(), bodyType: body?.constructor?.name,
      fileBytes: body instanceof File ? body.size : null, signalInitiallyAborted: init?.signal?.aborted ?? null }
    if (typeof body === 'string') { try { item.body = JSON.parse(body) } catch {} }
    if (body instanceof File) {
      item.file = { name: body.name, relativePath: body.webkitRelativePath }
      digest(body).then(hash => { item.fileSha256 = hash; emit({ kind: 'file-hash', url, hash }) }).catch(error => { item.hashError = String(error) })
    }
    audit.requests.push(item); emit({ kind: 'request', request: item })
    const onAbort = () => { item.abortedAt = Date.now(); emit({ kind: 'abort', url }) }
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await original.call(this, input, init)
      item.status = response.status
      if (response.headers.get('content-type')?.includes('application/json')) {
        try { item.response = await response.clone().json() } catch (error) { item.parseError = String(error) }
      }
      if (audit.dropNext && url.endsWith('/' + audit.dropNext)) {
        item.dropped = audit.dropNext; audit.dropNext = null
        emit({ kind: 'real-response-dropped', request: item })
        throw new TypeError('Test boundary: actual Host response was lost before the client received it')
      }
      return response
    } catch (error) { item.error = String(error); throw error }
    finally {
      item.finished = true; item.finishedAt = Date.now()
      init?.signal?.removeEventListener('abort', onAbort); emit({ kind: 'request-finished', request: item })
    }
  }
}
async function verifyServedClient() {
  const provenance = await page.evaluate(`(()=>{const graph=window.__DSH_BOOT__||{};return {row:(graph.entries||[]).find(e=>e.id==='@deepblend/dsh-blender-ui')||null,loaded:performance.getEntriesByType('resource').map(e=>e.name).filter(n=>n.includes('@deepblend/dsh-blender-ui/client.js'))}})()`)
  check('the actual page loaded this workbench client exactly once', provenance.row?.url && provenance.loaded.length === 1, provenance)
  const bytes = readFileSync(join(REPO_ROOT, 'packages/deepblend/ui/lib/client.js'))
  let source = bytes.toString('utf8').replace(/(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/, '').replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/, '')
  if (!source.endsWith('\n')) source += '\n'
  const expected = Buffer.from(`${source};\n//# sourceMappingURL=${provenance.row.url.replace(/\/client\.js(?=&rev=)/, '/client.js.map')}\n`)
  const response = await fetch(new URL(provenance.row.url, base), { signal: AbortSignal.timeout(10000) }), served = Buffer.from(await response.arrayBuffer())
  write(join(directory, 'served-client.js'), served)
  json('client-source.json', { ...provenance, sourceSha256: sha(bytes), servedSha256: sha(served), expectedSha256: sha(expected) })
  check('the served client matches the entire checkout source', response.ok && served.equals(expected))
}
function readProcessRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,stat=,lstart=,comm='], { encoding: 'utf8', timeout: 2000 })
  if (result.status !== 0) return { error: String(result.error || result.stderr || 'process inspection failed'), rows: [] }
  const rows = []
  for (const line of result.stdout.trim().split('\n')) {
    const fields = line.trim().split(/\s+/); if (fields.length < 9) return { error: 'Unrecognized process identity row', rows: [] }
    rows.push({ pid: Number(fields[0]), ppid: Number(fields[1]), stat: fields[2], start: fields.slice(3, 8).join(' '), command: fields.slice(8).join(' ') })
  }
  return { rows }
}
function ownProcessTree() {
  const table = readProcessRows(); if (table.error) return table
  const ids = new Set([server?.child.pid, browser?.child.pid].filter(Boolean))
  let changed
  do { changed = false; for (const row of table.rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true } } while (changed)
  return { rows: table.rows.filter(row => ids.has(row.pid)) }
}
async function waitForOwnedExit(observed, { timeoutMs = 12000, pollMs = 100, read = readProcessRows, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const started = now(), snapshots = [], identityErrors = new Map(); let remaining = observed.rows
  let lastObservedAliveAt = null, firstObservedAllExitedAt = null
  const finish = errors => ({ remaining, snapshots, errors, elapsedMs: now() - started, budgetMs: timeoutMs,
    startedAt: started, finishedAt: now(), lastObservedAliveAt, firstObservedAllExitedAt })
  if (observed.error) return finish([observed.error])
  for (;;) {
    const table = read()
    if (table.error) return finish([...identityErrors.values(), table.error])
    remaining = []
    for (const owner of observed.rows) {
      const current = table.rows.find(row => row.pid === owner.pid)
      if (!current) continue
      // Darwin ps falls back to (kernel name) when argv reading fails. Keep
      // observing that exact-name fallback as alive until absence or Z is seen.
      const sameCommand = current.command === owner.command
        || current.command === `(${owner.command.split('/').at(-1)})`
      // macOS ps replaces comm with <defunct> for an unreaped exited child.
      // Its unchanged start identity and Z state are actual exit evidence.
      if (current.start === owner.start && current.stat.startsWith('Z')
        && (sameCommand || current.command === '<defunct>')) continue
      if (current.start !== owner.start || !sameCommand) {
        identityErrors.set(owner.pid, `PID ${owner.pid} changed identity; the original exit was not observed: ${JSON.stringify({ owner, current })}`); continue
      }
      if (!current.stat.startsWith('Z')) remaining.push(current)
    }
    const at = now()
    if (remaining.length) lastObservedAliveAt = at
    else if (!identityErrors.size) firstObservedAllExitedAt = at
    snapshots.push({ at, elapsedMs: at - started, remaining, identityErrors: [...identityErrors.values()] })
    if (!remaining.length || at - started >= timeoutMs) return finish([...identityErrors.values()])
    await pause(pollMs)
  }
}

function retainHome() {
  if (!server?.home || !existsSync(server.home)) return
  const links = [], files = []
  const walk = (folder, prefix = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, file = join(folder, entry.name)
      if (entry.isSymbolicLink()) links.push({ path: name, target: readlinkSync(file) })
      else if (entry.isDirectory()) walk(file, name)
      else if (entry.isFile()) { const target = join(directory, 'dsh-home', name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target); files.push({ path: name, sha256: sha(readFileSync(file)) }) }
    }
  }
  // Preserve the owned home outside the artifact, and copy its ordinary files.
  // Following its package links would archive the whole deployment or checkout.
  walk(server.home); json('dsh-home-links.json', { home: server.home, files, links })
}
function verifyNativeCheckpoint() {
  const output = join(directory, 'native-readback.json'), script = join(directory, 'native-readback.py')
  write(script, `import bpy,json,sys\nfrom pathlib import Path\nresult={}\nfor entity in ['uploaded-gltf','uploaded-obj','uploaded-glb']:\n    meshes=[o for o in bpy.data.objects if o.type=='MESH' and o.get('deepblend_id')==entity]\n    result[entity]=[{'name':o.name,'faces':len(o.data.polygons),'uvLayers':[v.name for v in o.data.uv_layers],'materials':[{'name':m.name,'images':[{'name':n.image.name,'size':list(n.image.size),'packed':bool(n.image.packed_file),'linked':any(l.from_node==n and l.to_socket.name=='Base Color' for l in m.node_tree.links)} for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.image]} for m in o.data.materials if m and m.use_nodes]} for o in meshes]\nPath(sys.argv[sys.argv.index('--')+1]).write_text(json.dumps(result,indent=2))\n`)
  const before = sha(readFileSync(path('revisions', current(), 'scene.blend'))), started = Date.now()
  const run = spawnSync(blenderPath, ['--background', '--factory-startup', path('revisions', current(), 'scene.blend'), '--python', script, '--', output], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 })
  write(join(directory, 'native-readback.stdout.log'), run.stdout || ''); write(join(directory, 'native-readback.stderr.log'), run.stderr || '')
  json('native-readback-process.json', { pid: run.pid, status: run.status, signal: run.signal, error: run.error?.message, elapsedMs: Date.now() - started })
  check('independent Blender reopen finishes without rewriting the saved checkpoint', run.status === 0 && existsSync(output) && sha(readFileSync(path('revisions', current(), 'scene.blend'))) === before)
  const result = JSON.parse(readFileSync(output))
  for (const name of ['gltf', 'obj', 'glb']) check(`${name}: saved native meshes retain authored UVs and linked image materials`, result[`uploaded-${name}`]?.some(mesh => mesh.faces > 0 && mesh.uvLayers.length > 0 && mesh.materials.some(material => material.images.some(image => image.size[0] === 8 && image.size[1] === 8 && image.linked))), result[`uploaded-${name}`])
}
try {
  check('explicit Blender prerequisite is available', existsSync(blenderPath), blenderPath)
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  stage = 'start-isolated-host'
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: true, inheritUserConfig: false })
  base = `http://127.0.0.1:${server.port}`
  // Retain this isolated Host only; never inherit or log the user's credentials.
  write(join(directory, 'host.log'), server.output.join(''))
  server.child.stdout?.on('data', bytes => appendFileSync(join(directory, 'host.log'), bytes))
  server.child.stderr?.on('data', bytes => appendFileSync(join(directory, 'host.log'), bytes))
  stage = 'create-project'
  const created = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, sceneSpec: scene, title: scene.project.title, renderPreview: false }), signal: AbortSignal.timeout(180000) })
  const receipt = await created.json(); json('create-receipt.json', receipt)
  check('real Host creates the initial saved scene without an implicit preview', created.ok && receipt.ok && current() === 'r0001')
  // A second real saved project lets the browser prove that an old picker
  // cannot target a new project. It adds one checkpoint compile, no preview.
  const other = defaultSceneSpec({ projectId: pickerProjectId, title: 'Picker destination control', goal: 'Reject selections started in the other project.' })
  const otherResponse = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: pickerProjectId, sceneSpec: other, title: other.project.title, renderPreview: false }), signal: AbortSignal.timeout(180000) })
  const otherReceipt = await otherResponse.json(); json('picker-project-receipt.json', otherReceipt)
  check('second real picker control project creates only its initial saved checkpoint', otherResponse.ok && otherReceipt.ok && existsSync(join(root, 'projects', pickerProjectId, 'revisions/r0001/scene.blend')))
  originals = Object.fromEntries(['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(name => [name, sha(readFileSync(path('revisions/r0001', name)))]))
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] })
  json('runtime.json', { node: process.version, platform: process.platform, blenderPath, hostPid: server.child.pid, chromePid: browser.child.pid, chrome: browser.launchFacts, home: server.home, scenePreview: scene.renderProfiles.preview })
  page = await browser.newPage('about:blank', { onConsole: (type, text) => record('console.jsonl', { type, text }) })
  observePageCommands(page) // Connection setup precedes tracing; every test command from this point is recorded.
  await page.addInitScript(`(${installUploadAudit.toString()})()`)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null', 45000)
  await verifyServedClient()
  stage = 'open-library'; await pointer('[data-view-tab=projects]'); await pointer(`[data-action="select-project:${projectId}"]`); await page.waitFor(`Boolean(document.querySelector('[data-brief-project="${projectId}"]'))`); await pointer('[data-view-tab=scene]'); await pointer('[data-action=assets-open]')
  await page.waitFor('document.querySelector("[data-asset-bundle-picker]")!==null')
  await verifyPickerContexts()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  stage = 'flat-reference-error'
  await select('obj', 'files'); await entrypoint('cup.obj'); await pointer('[data-action=asset-bundle-upload]')
  await page.waitFor('document.querySelector("[data-assets-library] .db-error")?.textContent.includes("ASSET_")', 30000)
  await idle()
  check('flat cross-folder selection fails honestly without registering an asset or changing the scene', (await inventory()).length === 0 && current() === 'r0001')
  await capture('01-narrow-dependency-error', '[data-assets-library] .db-error', true)
  await page.send('Emulation.clearDeviceMetricsOverride')
  await upload('flat', 'files')
  const first = await upload('gltf-first'), second = await upload('gltf-next'), obj = await upload('obj'), glb = await upload('glb', 'directory', true)
  check('texture-only change preserves the main hash and creates a separate immutable dependency version', first.asset.sha256 === second.asset.sha256 && first.asset.path !== second.asset.path)
  check('unreferenced selected files are excluded from the stored dependency closure', first.bundle.files.length === 3 && glb.bundle.files.length === 2)
  await page.waitFor('window.__uploadAudit.requests.filter(item=>item.bodyType==="File").every(item=>item.fileSha256)')
  const uploaded = await page.evaluate('window.__uploadAudit.requests'), members = uploaded.filter(item => /\/files\/file-\d+$/.test(item.url))
  check('all transferred members are real File bodies; registration makes no preview or scene patch request', members.length > 0 && members.every(item => item.bodyType === 'File' && item.fileBytes >= 0 && /^[a-f0-9]{64}$/.test(item.fileSha256)) && !uploaded.some(item => /\/(preview|patch)$/.test(item.url)))
  const selections = await page.evaluate('window.__uploadAudit.selections')
  check('raw request File hashes match actual selected source bytes', members.every(item => selections.some(selection => selection.files.some(file => file.sha256 === item.fileSha256 && file.size === item.fileBytes && file.name === item.file.name))))
  await capture('02-five-unchecked-assets')
  stage = 'active-upload-cancel'
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await select('cancel'); await entrypoint('cup.gltf')
  await page.send('Network.enable')
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 50, downloadThroughput: 1024 * 1024, uploadThroughput: 100 * 1024 })
  await pointer('[data-action=asset-bundle-upload]')
  await page.waitFor('window.__uploadAudit.requests.some(item=>item.bodyType==="File"&&item.fileBytes===5*1024*1024&&!item.finished)', 30000)
  const active = await page.evaluate('window.__uploadAudit.requests.find(item=>item.bodyType==="File"&&item.fileBytes===5*1024*1024&&!item.finished)')
  const sessionId = new URL(active.url).pathname.match(/asset-uploads\/([^/]+)/)[1]
  await page.waitFor(`window.__uploadAudit.requests.some(item=>item.method==='GET'&&item.response?.uploadId===${JSON.stringify(sessionId)}&&item.response.inFlightBytes>0)&&document.querySelector('[data-asset-bundle-progress]')`, 15000)
  json('active-status.json', await api(`/deepblend/projects/${projectId}/asset-uploads/${sessionId}`))
  check('active upload disables selection and exposes real progress plus an enabled cancel action', await page.evaluate('document.querySelector("[data-field=asset-bundle-files]").disabled&&document.querySelector("[data-field=asset-bundle-directory]").disabled&&document.querySelector("[data-field=asset-bundle-entrypoint]").disabled&&Boolean(document.querySelector("[data-asset-bundle-progress]")?.textContent)&&!document.querySelector("[data-action=asset-cancel]").disabled'))
  await capture('03-narrow-active-progress', '[data-asset-bundle-progress]', true)
  await page.evaluate("window.__uploadAudit.dropNext='cancel'")
  await pointer('[data-action=asset-cancel]')
  await page.waitFor('window.__uploadAudit.requests.some(item=>item.dropped==="cancel")&&document.querySelector("[data-assets-library] .db-error")&&!document.querySelector("[data-asset-bundle-progress]")', 30000)
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  const cancelled = await api(`/deepblend/projects/${projectId}/asset-uploads/${sessionId}`)
  check('a lost actual cancel receipt keeps cleanup unresolved and retryable while the Host has cancelled', cancelled.status === 'cancelled' && await page.evaluate('Boolean(document.querySelector("[data-action=asset-cancel]"))&&document.querySelector("[data-action=asset-bundle-upload]").disabled'))
  await capture('04-narrow-cleanup-unconfirmed', '[data-assets-library] .db-error', true)
  stage = 'retry-cleanup'; await pointer('[data-action=asset-cancel]')
  await page.waitFor('!document.querySelector("[data-action=asset-cancel]")&&!document.querySelector("[data-assets-library] .db-error")')
  check('explicit retry confirms cancellation without an asset or scene revision', (await api(`/deepblend/projects/${projectId}/asset-uploads/${sessionId}`)).status === 'cancelled' && (await inventory()).length === 5 && current() === 'r0001')
  check('user cancel aborts the current raw File request', (await page.evaluate('window.__uploadAudit.requests')).some(item => item.url === active.url && item.abortedAt && item.error))
  await capture('05-narrow-cleanup-recovered', '[data-asset-bundle-picker]', true)
  await page.send('Emulation.clearDeviceMetricsOverride')
  const a = await inspect(first, 'gltf-first'), b = await inspect(second, 'gltf-next')
  const imageA = decodePng(readFileSync(path(a.preview.path))), imageB = decodePng(readFileSync(path(b.preview.path)))
  check('same-main dependency versions produce different decoded native preview pixels', imageA.width === imageB.width && imageA.height === imageB.height && !imageA.data.every((value, index) => value === imageB.data[index]))
  await inspect(obj, 'obj')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await inspect(glb, 'glb', true)
  await apply(glb, 'glb', true)
  await page.send('Emulation.clearDeviceMetricsOverride')
  await apply(first, 'gltf'); await apply(obj, 'obj')
  stage = 'native-checkpoint-readback'; verifyNativeCheckpoint()
  check('every earlier saved scene, spec and manifest remains byte-identical', history.length === 3 && history.every(row => row.files.every(file => sha(readFileSync(path('revisions', row.revision, file.name))) === file.sha256)) && Object.entries(originals).every(([name, hash]) => sha(readFileSync(path('revisions/r0001', name))) === hash))
  json('history-hashes.json', history)
  const scratch = join(root, 'projects/.asset-uploads')
  check('completed, failed and cancelled sessions leave no private owner directories', !existsSync(scratch) || readdirSync(scratch).length === 0)
  const finalFiles = ['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(name => ({ path: path('revisions', current(), name), sha256: sha(readFileSync(path('revisions', current(), name))) }))
  json('final-source-hashes.json', finalFiles)
  outcome = 'passed'
} catch (error) {
  record('failures.jsonl', { stage, error: error.stack || String(error) })
  checks.push({ name: `${stage}: unexpected failure`, ok: false, detail: error.stack || String(error) }); console.error(error)
  if (page) {
    await page.screenshot(join(directory, 'failure.png')).catch(error => record('failures.jsonl', { stage: 'failure-screenshot', error: String(error) }))
    await page.evaluate('({audit:window.__uploadAudit?.export(),text:document.body.innerText})').then(value => json('failure-browser.json', value)).catch(error => record('failures.jsonl', { stage: 'failure-browser', error: String(error) }))
  }
} finally {
  if (page) await page.evaluate('window.__uploadAudit?.export()').then(value => json('browser-evidence.json', value)).catch(() => {})
  const processes = ownProcessTree(); json('owned-processes-before-close.json', processes)
  try { await browser?.close() } catch (error) { outcome = 'failed'; checks.push({ name: 'browser shutdown', ok: false, detail: String(error) }) }
  try { shutdown = await server?.stop() } catch (error) { outcome = 'failed'; checks.push({ name: 'server shutdown', ok: false, detail: String(error) }) }
  const exitWait = await waitForOwnedExit(processes); json('owned-processes-exit-wait.json', exitWait)
  const residual = exitWait.remaining
  json('shutdown.json', { shutdown, residual, observationErrors: exitWait.errors, host: server && { pid: server.child.pid, exitCode: server.child.exitCode, signalCode: server.child.signalCode }, chrome: browser && { pid: browser.child.pid, exitCode: browser.child.exitCode, signalCode: browser.child.signalCode } })
  if (residual.length || exitWait.errors.length) { outcome = 'failed'; checks.push({ name: 'owned processes exited', ok: false, detail: exitWait }) }
  if (server) write(join(directory, 'host-final.log'), server.output.join(''))
  try { retainHome() } catch (error) { outcome = 'failed'; checks.push({ name: 'retain isolated home evidence', ok: false, detail: String(error) }) }
  const afterSource = snapshotSource(); json('source-after.json', afterSource)
  if (JSON.stringify(beforeSource) !== JSON.stringify(afterSource)) { outcome = 'failed'; checks.push({ name: 'tested source remained unchanged', ok: false }) }
  json('results.json', { outcome, checks, startedAt, finishedAt: new Date().toISOString(), shutdown, originals, applications, directory,
    scope: 'Actual browser FileList and directory-relative paths, flat success/refusal, raw byte hashes, real completed/cancelled response loss, retry cleanup, active 390px progress/error/cancel, four native previews and glTF/GLB/OBJ application plus independent checkpoint reopen. Includes one additional checkpoint-only control project and controlled late native FileList delivery after project switching. Isolated standalone page; OS picker is intercepted after a real pointer, no OS dialog interaction, DSH sidebar, Host-restart, touch, keyboard-accessibility or art-quality acceptance claim.' })
}
console.log(`Asset bundle upload: ${checks.filter(item => item.ok).length}/${checks.length} check(s) passed; ${directory}`)
if (outcome !== 'passed') process.exitCode = 1
