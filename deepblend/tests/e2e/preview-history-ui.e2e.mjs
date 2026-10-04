#!/usr/bin/env node
/** Real preview settings, render history, editor comparison, restore and legacy reads. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import Studio from '@deepblend/dsh-blender-host'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { decodePng, sceneSpecDigest } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `preview-history-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(output)) throw Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const root = join(output, 'store'), projectId = 'preview-history', checks = [], fibers = []
const file = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(file(...parts)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
let server, browser, page, failure, shutdown, protectedSources, retained = [], manifests
const sourceHashes = revision => Object.fromEntries(['scene-spec.json', 'scene.blend'].map(name => [`revisions/${revision}/${name}`, sha(readFileSync(file('revisions', revision, name)))]))
const kept = () => retained.every(item => sha(readFileSync(file(item.path))) === item.sha256)
try {
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  const rows = JSON.parse(await storePatch(root)); rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.addInitScript(`window.__previewPointerClicks=[];document.addEventListener('click',event=>{const control=event.target.closest?.('[data-action]');if(control)window.__previewPointerClicks.push({action:control.dataset.action,disabled:control.disabled===true})},true);
    window.__previewHoldRefresh=false;window.__previewHeld=[];window.__previewReleases=[];
    const originalFetch=window.fetch;window.fetch=async(input,init)=>{const url=String(input);const response=await originalFetch(input,init);
      if(window.__previewHoldRefresh&&(!init?.method||init.method==='GET')&&url.includes('/deepblend/')){window.__previewHeld.push(url);await new Promise(resolve=>window.__previewReleases.push(resolve));}return response;}`)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor('document.querySelector(\'[data-action="select-recipe:deepblend.metal-lamp@2.0.0"]\')!==null', 45000)
  await page.click('[data-action="select-recipe:deepblend.metal-lamp@2.0.0"]'); await page.fill('[data-field="project-title"]', projectId)
  check('creation uses the visible gallery button', (await page.click('[data-action="create-project"]')).via === 'pointer')
  await page.waitFor('document.querySelector("[data-compare=current] img[data-artifact-revision=r0001]")?.complete===true', 180000)
  const initial = read('revisions', 'r0001', 'revision-manifest.json').previews[0]
  protectedSources = sourceHashes('r0001'); retained.push(initial)
  check('new creation displays and records the actual source revision and digest', initial.sourceRevision === 'r0001' && initial.sourceDigest === sceneSpecDigest(read('revisions', 'r0001', 'scene-spec.json'))
    && await page.evaluate(`document.querySelector('[data-compare=current] img').dataset.artifactSourceDigest===${JSON.stringify(initial.sourceDigest)}`))
  check('initial budget is measured independently of the authored profile', initial.width === 768 && initial.height === 576 && initial.samples === 8 && initial.renderConfig.samples === 8 && read('revisions', 'r0001', 'scene-spec.json').renderProfiles.preview.samples === 64)
  check('creation records evaluated camera facts and visibly shows the actual budget', initial.cameraFacts.frame === initial.frame && initial.cameraFacts.lens > 0
    && await page.evaluate('document.querySelector("[data-compare=current] [data-render-settings-known=true]")?.textContent.includes("768×576")===true'))
  await page.screenshot(join(output, '01-created.png'))
  const ctx = new Context()
  fibers.push(ctx.plugin(LocalSubprocess), ctx.plugin(Provider, ProviderConfig({ blenderPath, workspaceRoot: root, timeoutMs: 120000 })), ctx.plugin(Studio, { workspaceRoot: root, projectsRoot: join(root, 'projects'), maxPreviewSamples: 8 }))
  await new Promise(resolve => setTimeout(resolve, 250)); const studio = ctx.get('blenderStudio')
  const render = async (width, height, samples) => {
    const result = await studio.renderPreview({ projectId, revision: 'r0001', cameraId: 'hero', frame: 24, width, height, samples })
    const artifact = result.artifacts[0], png = decodePng(readFileSync(file(artifact.path)))
    check(`native ${width}×${height}/${samples} single render records measured bytes, settings and source`, png.width === width && png.height === height && artifact.width === width && artifact.height === height
      && artifact.samples === samples && artifact.renderConfig.samples === samples && artifact.sourceRevision === 'r0001' && artifact.sourceDigest === initial.sourceDigest && artifact.jobId === result.job.jobId && Number.isFinite(Date.parse(artifact.at)) && sha(readFileSync(file(artifact.path))) === artifact.sha256)
    retained.push(artifact); return artifact
  }
  const first = await render(192, 144, 4), second = await render(240, 180, 8)
  check('two renders at the same camera/frame retain both exact images and source files', first.path !== second.path && kept() && Object.entries(protectedSources).every(([path, digest]) => sha(readFileSync(file(path))) === digest))
  const previews = read('revisions', 'r0001', 'revision-manifest.json').previews
  check('the manifest and original completed jobs retain the two independent attempts', [first, second].every(item => previews.some(row => isDeepStrictEqual(row, item)) && isDeepStrictEqual(read('jobs', item.jobId + '.json').artifacts[0], item)))
  await page.click('[data-action="reload"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.dataset.artifact===${JSON.stringify(second.path)}`)
  check('latest result shows the newest single render with its recorded revision', await page.evaluate(`document.querySelector('[data-compare=current] img').dataset.artifactRevision==='r0001'`))
  await page.click('[data-compare-mode="renders"]')
  check('render comparison shows the two independent same-version attempts', await page.evaluate(`document.querySelector('[data-compare=left] img').dataset.artifact===${JSON.stringify(first.path)}&&document.querySelector('[data-compare=right] img').dataset.artifact===${JSON.stringify(second.path)}`))
  check('same-version images show their distinct budgets and measured condition differences', await page.evaluate('document.querySelector("[data-compare=left]").textContent.includes("192×144")&&document.querySelector("[data-compare=right]").textContent.includes("240×180")&&document.querySelector("[data-preview-conditions]").dataset.previewConditions==="different"&&document.querySelector("[data-preview-conditions]").dataset.previewConditionsIncomplete==="false"'))
  for (const item of [first, second]) {
    const response = await fetch(`${base}/deepblend/artifacts/${projectId}/${item.path}`), bytes = Buffer.from(await response.arrayBuffer())
    check(`browser artifact response preserves ${item.jobId} exact PNG bytes`, response.ok && sha(bytes) === item.sha256)
  }
  const views = await studio.renderViews({ projectId, revision: 'r0001', views: [{ id: 'hero', cameraId: 'hero', frame: 24 }], width: 160, height: 120, samples: 4 })
  let currentSheet = views.artifacts.find(item => item.slot === 'preview-current')
  check('a later multi-view sheet records its own source without replacing single attempts', currentSheet?.sourceRevision === 'r0001' && currentSheet.sourceDigest === initial.sourceDigest && kept())
  check('a sheet stores each measured view rather than the requested profile', views.views[0].samples === 4 && currentSheet.viewSettings[0].renderConfig.samples === 4 && currentSheet.viewSettings[0].cameraFacts.frame === 24 && currentSheet.viewSettings[0].cameraFacts.lens === first.cameraFacts.lens)
  const firstSheet = structuredClone(currentSheet)
  await page.click('[data-action="reload"]'); await page.click('[data-compare-mode="result"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.dataset.artifactDigest===${JSON.stringify(firstSheet.sha256)}`)
  // Both generations use preview-current.png. Hold refresh responses so a path-only
  // wait demonstrably observes the old metadata, then wait for the new digest.
  await page.evaluate('window.__previewHoldRefresh=true')
  const multi = await studio.renderViews({ projectId, revision: 'r0001', views: [{ id: 'hero', cameraId: 'hero', frame: 24 }, { id: 'later', cameraId: 'hero', frame: 36 }], width: 192, height: 144, samples: 12 })
  currentSheet = multi.previewSheets.current
  check('rotation retains the preceding sheet settings and the new capped per-view budget', isDeepStrictEqual(multi.previewSheets.previous.viewSettings, firstSheet.viewSettings) && multi.previewSheets.previous.sha256 === firstSheet.sha256
    && currentSheet.viewSettings.every(item => item.samples === 8 && item.renderConfig.samples === 8) && currentSheet.viewSettings[1].cameraFacts.frame === 36)
  await page.click('[data-action="reload"]')
  await page.waitFor('window.__previewHeld.length>0')
  check('a reused sheet path cannot identify the refreshed image or its settings', await page.evaluate(`document.querySelector('[data-compare=current] img')?.dataset.artifact===${JSON.stringify(currentSheet.path)}&&document.querySelector('[data-compare=current] img')?.dataset.artifactDigest===${JSON.stringify(firstSheet.sha256)}&&document.querySelectorAll('[data-compare=current] [data-render-view-id]').length===1`))
  await page.evaluate('(()=>{window.__previewHoldRefresh=false;for(const release of window.__previewReleases)release();return true})()')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.dataset.artifact===${JSON.stringify(currentSheet.path)}&&document.querySelector('[data-compare=current] img')?.dataset.artifactDigest===${JSON.stringify(currentSheet.sha256)}`)
  check('sheet display distinguishes composed pixels from both constituent render settings', await page.evaluate(`document.querySelector('[data-compare=current]').textContent.includes(${JSON.stringify(`${currentSheet.width}×${currentSheet.height}`)})&&document.querySelector('[data-compare=current]').textContent.includes('192×144')&&document.querySelectorAll('[data-compare=current] [data-render-view-id]').length===2&&document.querySelector('[data-render-view-id=later]').textContent.includes('36')`))
  await page.screenshot(join(output, '02-sheet-settings.png'))
  const third = await render(256, 192, 8)
  await page.click('[data-action="reload"]'); await page.click('[data-compare-mode="result"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.dataset.artifact===${JSON.stringify(third.path)}`)
  check('a newer single render supersedes an older sheet on the latest view', await page.evaluate(`document.querySelector('[data-compare=current] img').dataset.artifactRevision==='r0001'`))
  await page.click('[data-compare-mode="renders"]')
  check('mixed render comparison retains the preceding sheet and newest single', await page.evaluate(`document.querySelector('[data-compare=left] img').dataset.artifact===${JSON.stringify(currentSheet.path)}&&document.querySelector('[data-compare=right] img').dataset.artifact===${JSON.stringify(third.path)}`))
  check('mixed layouts have an explicit measured condition difference', await page.evaluate('document.querySelector("[data-preview-conditions]").dataset.previewConditions==="different"&&document.querySelector("[data-preview-conditions]").dataset.previewConditionsIncomplete==="false"'))
  await page.waitFor('Array.from(document.querySelectorAll("[data-view=preview] img")).every(img=>img.complete&&img.naturalWidth>0)')
  await page.screenshot(join(output, '02-render-history.png'))
  const measuredManifestPath = file('revisions', 'r0001', 'revision-manifest.json'), measuredManifestBytes = readFileSync(measuredManifestPath)
  const missingSettings = JSON.parse(measuredManifestBytes), legacySingle = missingSettings.previews.find(item => item.path === third.path)
  delete legacySingle.renderConfig; delete legacySingle.cameraFacts
  writeFileSync(measuredManifestPath, JSON.stringify(missingSettings, null, 2) + '\n'); const missingSettingsBytes = readFileSync(measuredManifestPath)
  await page.click('[data-action="reload"]')
  await page.waitFor('document.querySelector("[data-preview-conditions]")?.dataset.previewConditionsIncomplete==="true"')
  check('legacy settings remain unknown without borrowing the authored budget or rewriting the manifest', await page.evaluate('document.querySelector("[data-compare=right] [data-render-settings-known=false]")!==null&&!document.querySelector("[data-compare=right] [data-preview-settings]").textContent.includes("64")') && readFileSync(measuredManifestPath).equals(missingSettingsBytes))
  await page.screenshot(join(output, '02-legacy-settings.png'))
  writeFileSync(measuredManifestPath, measuredManifestBytes); await page.click('[data-action="reload"]')
  // Reproduce a manifest written before provenance fields existed. Reading it
  // must enrich the response without migrating or changing its stored bytes.
  const legacyPath = file('revisions', 'r0001', 'revision-manifest.json'), legacy = JSON.parse(readFileSync(legacyPath))
  delete legacy.previews[0].sourceRevision; delete legacy.previews[0].sourceDigest; delete legacy.previews[0].at
  writeFileSync(legacyPath, JSON.stringify(legacy, null, 2) + '\n'); const legacyBytes = readFileSync(legacyPath)
  const projection = await (await fetch(`${base}/deepblend/projects/${projectId}/previews`)).json()
  check('actual Host legacy read derives only the source and preserves unknown time and manifest bytes', projection.previews.revisions[0].previews[0].sourceRevision === 'r0001' && projection.previews.revisions[0].previews[0].sourceDigest === initial.sourceDigest
    && projection.previews.revisions[0].previews[0].at === undefined && readFileSync(legacyPath).equals(legacyBytes))
  await page.click('[data-view-tab="scene"]'); await page.click('[data-action="select-entity:shade-shell"]')
  await page.waitFor('document.querySelector("[data-field=editor-material-roughness]")!==null')
  await page.fill('[data-field="editor-material-roughness"]', '0.31')
  const scrollRefresh = await page.evaluate('(()=>{document.querySelector("[data-action=editor-apply]").scrollIntoView({block:"center"});const before=document.querySelector(".db-body").scrollTop;document.querySelector("[data-field=editor-material-roughness]").dispatchEvent(new Event("input",{bubbles:true}));return{before,after:document.querySelector(".db-body").scrollTop}})()')
  check('an idle state refresh preserves the actual scrolled main surface', scrollRefresh.before > 0 && scrollRefresh.after === scrollRefresh.before, scrollRefresh)
  const heldTab = await page.evaluate('(()=>{const el=document.querySelector("[data-view-tab=preview]");el.scrollIntoView();window.__heldPreviewTab=el;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()')
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...heldTab, button: 'left', buttons: 1, clickCount: 1 })
  const heldConnected = await page.evaluate('(()=>{document.querySelector("[data-field=editor-material-roughness]").dispatchEvent(new Event("input",{bubbles:true}));return window.__heldPreviewTab.isConnected})()')
  check('a forced refresh keeps the pressed native control connected', heldConnected)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...heldTab, button: 'left', buttons: 0, clickCount: 1 })
  await page.waitFor('document.querySelector("[data-view=preview]")!==null')
  check('native release still activates the tab after an intervening state refresh', await page.evaluate('document.querySelector("[data-view-tab=preview]").dataset.active==="true"'))
  await page.click('[data-view-tab="scene"]'); await page.waitFor('document.querySelector("[data-action=editor-apply]")?.disabled===false')
  await page.waitFor('document.querySelector("[data-action=editor-apply]")?.disabled===false')
  check('a real material edit uses the visible apply control', (await page.click('[data-action="editor-apply"]')).via === 'pointer'
    && await page.evaluate('window.__previewPointerClicks.at(-1)?.action==="editor-apply"'))
  await page.waitFor('document.querySelector("[data-compare=right] img[data-artifact-revision=r0002]")?.complete===true', 180000)
  const after = read('revisions', 'r0002', 'revision-manifest.json').previews[0]; retained.push(after)
  check('editor comparison uses the matching baseline budget rather than a later different-size render', await page.evaluate(`document.querySelector('[data-compare=left] img').dataset.artifact===${JSON.stringify(initial.path)}&&document.querySelector('[data-compare=right] img').dataset.artifact===${JSON.stringify(after.path)}`)
    && isDeepStrictEqual(initial.renderConfig, after.renderConfig) && ['cameraId', 'frame', 'width', 'height', 'engine', 'samples'].every(key => initial[key] === after[key]))
  check('a material edit retains actual camera conditions and visibly reports a matched comparison', isDeepStrictEqual(initial.cameraFacts, after.cameraFacts)
    && await page.evaluate('document.querySelector("[data-preview-conditions]").dataset.previewConditions==="matching"'))
  check('edited preview records the changed source digest', after.sourceRevision === 'r0002' && after.sourceDigest !== initial.sourceDigest && after.sourceDigest === sceneSpecDigest(read('revisions', 'r0002', 'scene-spec.json')))
  const beforePixels = decodePng(readFileSync(file(initial.path))), afterPixels = decodePng(readFileSync(file(after.path)))
  let changed = 0; for (let i = 0; i < beforePixels.data.length; i += 4) if ([0, 1, 2].some(channel => beforePixels.data[i + channel] !== afterPixels.data[i + channel])) changed++
  check('same-settings material edit changes actual native RGB pixels', changed > 0, { changedPixels: changed, before: sha(beforePixels.data), after: sha(afterPixels.data) })
  manifests = ['r0001', 'r0002'].map(revision => ({ revision, sha256: sha(readFileSync(file('revisions', revision, 'revision-manifest.json'))) }))
  await page.click('[data-view-tab="scene"]'); await page.click('[data-action="select-entity:shade-shell"]')
  await page.waitFor('document.querySelector("[data-action=editor-restore]")?.disabled===false')
  check('restore uses a real pointer on the conditional editor control', (await page.click('[data-action="editor-restore"]')).via === 'pointer')
  await page.waitFor('document.querySelector(".db-head")?.textContent.includes("r0001")===true')
  check('restore changes only the pointer while retaining both versions and every single PNG', read('project.json').currentRevision === 'r0001' && readdirSync(file('revisions')).sort().join(',') === 'r0001,r0002' && kept()
    && manifests.every(item => sha(readFileSync(file('revisions', item.revision, 'revision-manifest.json'))) === item.sha256))
  await page.click('[data-view-tab="preview"]'); await page.click('[data-compare-mode="result"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.dataset.artifact===${JSON.stringify(third.path)}`)
  check('restored latest view displays r0001 pixels and source instead of the edited version', await page.evaluate(`document.querySelector('[data-compare=current] img').dataset.artifactRevision==='r0001'&&document.querySelector('[data-compare=current] img').dataset.artifactSourceDigest===${JSON.stringify(initial.sourceDigest)}`))
  await page.reload(); await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null')
  await page.click('[data-view-tab="preview"]'); await page.click('[data-compare-mode="result"]')
  await page.waitFor(`document.querySelector('[data-compare=current] img')?.dataset.artifact===${JSON.stringify(third.path)}`)
  check('reload retains the restored source, history and unmodified legacy manifest', kept() && manifests.every(item => sha(readFileSync(file('revisions', item.revision, 'revision-manifest.json'))) === item.sha256)
    && await page.evaluate('document.querySelector("[data-compare=current] img").dataset.artifactRevision==="r0001"'))
  await page.waitFor('document.querySelector("[data-compare=current] img").complete&&document.querySelector("[data-compare=current] img").naturalWidth>0')
  await page.screenshot(join(output, '03-restored.png'))
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  const narrow = await page.evaluate('(()=>{const panel=document.querySelector("[data-compare=current]").getBoundingClientRect();return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,left:panel.left,right:panel.right,budgetVisible:document.querySelector("[data-compare=current]").textContent.includes("256×192")}})()')
  check('actual render settings remain visible without horizontal overflow at 390 pixels', narrow.viewport === 390 && narrow.scrollWidth <= 390 && narrow.left >= 0 && narrow.right <= 390 && narrow.budgetVisible, narrow)
  await page.screenshot(join(output, '04-narrow-settings.png')); await page.send('Emulation.clearDeviceMetricsOverride')
  json('artifacts.json', { initial, first, second, third, after, currentSheet, firstSheet, narrow, protectedSources, manifests, retained })
} catch (error) {
  failure = error.stack || String(error); checks.push({ name: 'workflow completes without unexpected failure', ok: false, detail: failure }); console.error(error); await page?.screenshot(join(output, 'failure.png')).catch(() => {})
  if (page) json('failure-dom.json', await page.evaluate('({clicks:window.__previewPointerClicks,editor:document.querySelector("[data-scene-editor]")?.dataset,apply:document.querySelector("[data-action=editor-apply]")?.disabled,text:document.body.textContent})').catch(error => ({ failure: String(error) })))
} finally {
  for (const fiber of fibers.slice().reverse()) { try { await fiber.dispose() } catch (error) { failure ??= String(error) } }
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) { try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { failure ??= String(error) } }
  json('report.json', { status: failure ? 'failed' : 'passed', checks, failure, shutdown, scope: 'Real Chrome, Host and Blender: measured single and per-view settings, capped samples, retained sheet snapshots, mixed conditions, matched editor comparison, legacy unknown settings, scroll continuity and native activation under forced refresh, narrow display, restore and reload. Multi-view current/previous slots retain their established two-generation policy; no artistic approval.' })
}
console.log(`Preview history: ${checks.filter(item => item.ok).length}/${checks.length} checks passed; ${output}`)
if (failure) process.exitCode = 1
