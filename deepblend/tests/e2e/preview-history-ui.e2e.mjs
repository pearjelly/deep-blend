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
import { ensureWorkbenchCaptureReady } from '../../tools/docs-capture-visibility.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
const lampSelector = `[data-action="select-recipe:deepblend.metal-lamp@${JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/recipes/metal-lamp/recipe.json'), 'utf8')).version}"]`
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
    window.__previewHoldRefresh=false;window.__previewHeld=[];window.__previewReleases=[];window.__versionHoldDiff=false;window.__versionDiffReleases=[];window.__versionDiffReads=[];window.__versionWrites=[];window.__ownerFailProject=null;window.__ownerHoldProject=null;window.__ownerCorruptProject=null;window.__ownerFailures=[];window.__ownerHeld=[];window.__ownerReleases=[];window.__ownerResponses=[];
    const originalFetch=window.fetch;window.fetch=async(input,init)=>{const url=String(input);if(init?.method==='POST')window.__versionWrites.push({url,body:JSON.parse(init.body)});if(url.includes('/previews?')&&window.__ownerFailProject&&url.includes('/projects/'+window.__ownerFailProject+'/previews?')){window.__ownerFailures.push(url);throw new TypeError('private preview network failure');}const response=await originalFetch(input,init);
      if(url.includes('/previews?')){const nativeText=response.text.bind(response);response.text=async()=>{const text=await nativeText();const value=JSON.parse(text);if(window.__ownerCorruptProject&&url.includes('/projects/'+window.__ownerCorruptProject+'/previews?'))value.previews.projectId='wrong-project';window.__ownerResponses.push({url,projectId:value.previews?.projectId});return JSON.stringify(value);};if(window.__ownerHoldProject&&url.includes('/projects/'+window.__ownerHoldProject+'/previews?')){window.__ownerHeld.push(url);await new Promise(resolve=>window.__ownerReleases.push(resolve));}}
      if(url.includes('/diff?')){if(window.__versionHoldDiff)await new Promise(resolve=>window.__versionDiffReleases.push(resolve));const nativeJson=response.json.bind(response);response.json=async()=>{const value=await nativeJson();window.__versionDiffReads.push({url,from:value.diff?.fromRevision,to:value.diff?.toRevision});return value;};}
      if(window.__previewHoldRefresh&&(!init?.method||init.method==='GET')&&url.includes('/deepblend/')){window.__previewHeld.push(url);await new Promise(resolve=>window.__previewReleases.push(resolve));}return response;}`)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor(`document.querySelector(${JSON.stringify(lampSelector)})!==null`, 45000)
  await page.click(lampSelector); await page.fill('[data-field="project-title"]', projectId)
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
  await page.click('[data-view-tab=revisions]')
  check('a single saved version has a disabled comparison entry and a visible explanation', await page.evaluate(`document.querySelector('[data-action=\"compare-from:r0001\"]').disabled===true&&document.querySelector('[data-view=revisions]').textContent.includes('至少两版')`))
  await page.click('[data-view-tab=preview]')
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
  // Start from the real restored r0001, then branch a third saved version.
  await page.click('[data-view-tab=scene]'); await page.click('[data-action="select-entity:shade-shell"]')
  await page.waitFor('document.querySelector("[data-field=editor-material-roughness]")!==null')
  await page.fill('[data-field=editor-material-roughness]', '.47'); await page.waitFor('document.querySelector("[data-action=editor-apply]")?.disabled===false')
  check('third version is saved by a real pointer', (await page.click('[data-action=editor-apply]')).via === 'pointer')
  await page.waitFor('document.querySelector("[data-compare=right] img[data-artifact-revision=r0003]")?.complete===true', 180000)
  const thirdVersion = read('revisions', 'r0003', 'revision-manifest.json').previews[0]; retained.push(thirdVersion)
  check('third version has an actual native PNG and explicit saved source', decodePng(readFileSync(file(thirdVersion.path))).width === thirdVersion.width && thirdVersion.sourceRevision === 'r0003'
    && thirdVersion.sourceDigest === sceneSpecDigest(read('revisions', 'r0003', 'scene-spec.json')) && sha(readFileSync(file(thirdVersion.path))) === thirdVersion.sha256)
  const allSaved = Object.fromEntries(['r0001', 'r0002', 'r0003'].flatMap(revision => ['scene-spec.json', 'scene.blend', 'revision-manifest.json'].map(name => [revision+'/'+name, sha(readFileSync(file('revisions',revision,name)))])))
  const readOnlyWrites = await page.evaluate('window.__versionWrites.length')
  const displayedPair = async (left, right) => await page.evaluate(`document.querySelector('[data-compare-mode=revisions]').dataset.active==='true'&&document.querySelector('[data-field=compare-left]').value===${JSON.stringify(left)}&&document.querySelector('[data-field=compare-right]').value===${JSON.stringify(right)}&&document.querySelector('[data-compare=left] img')?.dataset.artifactRevision===${JSON.stringify(left)}&&document.querySelector('[data-compare=right] img')?.dataset.artifactRevision===${JSON.stringify(right)}`)
  await page.click('[data-compare-mode=result]'); await page.click('[data-view-tab=revisions]')
  check('history-to-current comparison enters through a real pointer', (await page.click('[data-action="compare-from:r0001"]')).via === 'pointer')
  check('entry from latest-result displays selected r0001 against current r0003', await displayedPair('r0001', 'r0003'))
  await page.waitFor('Array.from(document.querySelectorAll("[data-compare] img")).every(img=>img.complete&&img.naturalWidth>0)')
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(output,'05-version-entry.png'))
  await page.click('[data-action=diff]'); await page.waitFor('document.querySelector("[data-diff] h4")?.textContent.includes("r0001 → r0003")===true')
  check('structural difference identifies the same pair as the two rendered panes', await displayedPair('r0001','r0003') && await page.evaluate('document.querySelector("[data-diff] h4").textContent.includes("r0001 → r0003")'))
  // The setup pair uses the standalone input event; measured entry controls use real pointers.
  await page.evaluate(`(()=>{const e=document.querySelector('[data-field=compare-right]');e.value='r0002';e.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await page.click('[data-action=diff]'); await page.waitFor('document.querySelector("[data-diff] h4")?.textContent.includes("r0001 → r0002")===true')
  await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0002"]')
  check('entry replaces an old right-side choice with current r0003 and clears old differences', await displayedPair('r0002','r0003') && await page.count('[data-diff]') === 0)
  await page.click('[data-compare-mode=renders]'); await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0001"]')
  check('entry from render history switches to the chosen/current version comparison', await displayedPair('r0001','r0003'))
  await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0003"]')
  check('current-version entry chooses the nearest other saved version', await displayedPair('r0002','r0003'))
  await page.click('[data-view-tab=scene]'); await page.click('[data-action="select-entity:shade-shell"]'); await page.fill('[data-field=editor-material-roughness]','.53')
  await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0001"]'); await page.click('[data-view-tab=scene]')
  check('viewing comparisons retains the later unsaved material value and does not submit it', await page.evaluate('document.querySelector("[data-field=editor-material-roughness]").value==="0.53"&&document.querySelector("[data-action=editor-apply]").disabled===false') && await page.evaluate('window.__versionWrites.length') === readOnlyWrites)
  await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0001"]')
  const diffReadsBefore = await page.evaluate('window.__versionDiffReads.length')
  await page.evaluate('window.__versionHoldDiff=true'); await page.click('[data-action=diff]'); await page.waitFor('window.__versionDiffReleases.length===1')
  await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0002"]'); await page.click('[data-action=diff]')
  // Hold both responses until observed, then let the newer one finish first.
  await page.waitFor('window.__versionDiffReleases.length===2'); await page.evaluate('(()=>{window.__versionHoldDiff=false;window.__versionDiffReleases.pop()();})()')
  await page.waitFor('document.querySelector("[data-diff] h4")?.textContent.includes("r0002 → r0003")===true')
  await page.evaluate('window.__versionDiffReleases.shift()()')
  await page.waitFor(`window.__versionDiffReads.length===${diffReadsBefore + 2}`)
  check('an actual delayed old HTTP reply cannot repaint a newer valid comparison', await displayedPair('r0002','r0003') && await page.evaluate('document.querySelector("[data-diff] h4").textContent.includes("r0002 → r0003")'))
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(output,'06-current-pair-diff.png'))
  check('all comparison navigation and diff reads leave native files and previews unchanged', await page.evaluate('window.__versionWrites.length') === readOnlyWrites && kept()
    && Object.entries(allSaved).every(([name,h]) => sha(readFileSync(file('revisions',name))) === h))
  await page.click('[data-view-tab=revisions]'); check('explicit restore still uses a real pointer', (await page.click('[data-action="restore:r0001"]')).via === 'pointer')
  await page.waitFor('document.querySelector(".db-head")?.textContent.includes("r0001")===true'); await page.click('[data-action="compare-from:r0003"]')
  check('after explicit restore the requested saved version compares against the actual restored current', await displayedPair('r0003','r0001') && read('project.json').currentRevision === 'r0001')
  check('restoring and viewing retain every saved scene, manifest and native PNG', kept() && Object.entries(allSaved).every(([name,h]) => sha(readFileSync(file('revisions',name))) === h)
    && readdirSync(file('revisions')).sort().join(',') === 'r0001,r0002,r0003')
  await page.click('[data-view-tab=revisions]'); await page.click('[data-action="compare-from:r0001"]')
  check('restored earliest current selects the next other saved version without restoring again', await displayedPair('r0002','r0001') && await page.evaluate('window.__versionWrites.length') === readOnlyWrites + 1)
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false}); await page.click('[data-view-tab=revisions]')
  const small = await page.evaluate('(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll("[data-action^=compare-from]")].map(e=>({action:e.dataset.action,disabled:e.disabled,label:e.textContent}))}))()')
  check('version entry controls remain enabled and readable without horizontal overflow at 390 pixels', small.width===390&&small.scrollWidth<=390&&small.buttons.length===3&&small.buttons.every(e=>!e.disabled&&e.label.length>0),small)
  await page.click('[data-action="compare-from:r0003"]'); check('narrow-screen comparison is activated by a real pointer and keeps the restored pair',await displayedPair('r0003','r0001'))
  await ensureWorkbenchCaptureReady(page); await page.screenshot(join(output,'07-narrow-version-pair.png')); await page.send('Emulation.clearDeviceMetricsOverride')
  json('version-comparison.json',{allSaved,thirdVersion,readOnlyWrites,diffReads:await page.evaluate('window.__versionDiffReads'),writesAfterRestore:await page.evaluate('window.__versionWrites.length'),small,current:read('project.json').currentRevision})
  // Two real works with different geometry exercise project ownership. Network
  // failures and delayed HTTP replies affect reads only, never their saved bytes.
  const cupId = 'preview-owner-cup', cupFile = (...parts) => join(root, 'projects', cupId, ...parts)
  await page.click('[data-view-tab=projects]'); await page.click('[data-action="select-recipe:deepblend.glazed-cup@3.1.0"]'); await page.fill('[data-field=project-title]', cupId)
  check('the second work is created only through the explicit pointer control', (await page.click('[data-action=create-project]')).via === 'pointer')
  const ownerImage = id => `document.querySelector('[data-compare=current] img')?.src.includes('/artifacts/${id}/')===true&&document.querySelector('[data-compare=current] img')?.complete===true&&document.querySelector('[data-compare=current] img')?.naturalWidth>0`
  await page.waitFor(ownerImage(cupId), 180000)
  const cupManifest = JSON.parse(readFileSync(cupFile('revisions', 'r0001', 'revision-manifest.json'))), cupArtifact = cupManifest.previews[0]
  const cupProtected = Object.fromEntries(['scene-spec.json', 'scene.blend', 'revision-manifest.json', cupArtifact.path].map(name => { const path = name.startsWith('revisions/') ? name : 'revisions/r0001/' + name; return [path, sha(readFileSync(cupFile(path)))] }))
  check('the cup PNG is an actual independent Blender output with its own source digest', sha(readFileSync(cupFile(cupArtifact.path))) === cupArtifact.sha256 && cupArtifact.sourceRevision === 'r0001' && cupArtifact.sourceDigest === sceneSpecDigest(JSON.parse(readFileSync(cupFile('revisions', 'r0001', 'scene-spec.json')))))
  const ownerWrites = await page.evaluate('window.__versionWrites.length')
  const selectOwner = async id => { await page.click('[data-view-tab=projects]'); await page.click(`[data-action="select-project:${id}"]`); await page.click('[data-view-tab=preview]'); await page.waitFor('document.querySelector("[data-compare-mode=result]")!==null'); await page.click('[data-compare-mode=result]') }
  await selectOwner(projectId); await page.waitFor(ownerImage(projectId)); await page.click('[data-view-tab=scene]'); await page.click('[data-action="select-entity:shade-shell"]'); await page.click('[data-action=editor-reset]'); await page.fill('[data-field=editor-material-roughness]', '.47');
  check('the ownership scenario starts with an editable draft from the restored current version', await page.evaluate('document.querySelector("[data-field=editor-material-roughness]").value==="0.47"&&document.querySelector("[data-action=editor-apply]").disabled===false')); await page.click('[data-view-tab=preview]');
  check('the valid lamp preview has a real original-PNG download control before the failure', await page.count('[data-image-download]') > 0)
  await page.evaluate(`window.__ownerFailProject=${JSON.stringify(cupId)}`); await page.click('[data-view-tab=projects]'); await page.click(`[data-action="select-project:${cupId}"]`); await page.click('[data-view-tab=preview]')
  await page.waitFor(`window.__ownerFailures.length===1&&document.querySelector('.db-head')?.textContent.includes(${JSON.stringify(cupId)})===true`)
  check('failed cup read cannot show the lamp under the cup heading or offer its download', await page.count('[data-compare] img') === 0 && await page.count('[data-image-download]') === 0 && await page.count('[data-preview-state=error]') === 1)
  check('preview failure is visible and supplies a read-only explicit refresh', await page.evaluate('document.body.textContent.includes("UI_FETCH_FAILED")&&document.querySelector("[data-action=preview-reload]")?.disabled===false') && await page.evaluate('window.__versionWrites.length') === ownerWrites)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  const failedSmall = await page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,copy:document.querySelector("[data-preview-state=error]")?.textContent})')
  check('preview recovery remains readable without overflow at 390 pixels', failedSmall.width === 390 && failedSmall.scrollWidth <= 390 && failedSmall.copy.includes('未提交修改'), failedSmall)
  await page.screenshot(join(output, '08-narrow-preview-read-failure.png'))
  await page.evaluate('window.__ownerFailProject=null')
  check('narrow recovery is an explicit real pointer action', (await page.click('[data-action=preview-reload]')).via === 'pointer'); await page.waitFor(ownerImage(cupId))
  check('refresh recovers only the cup and does not create or render', await page.count('[data-preview-state=error]') === 0 && await page.evaluate('window.__versionWrites.length') === ownerWrites)
  await page.send('Emulation.clearDeviceMetricsOverride'); await page.screenshot(join(output, '09-cup-preview-recovered.png'))
  await selectOwner(projectId); await page.waitFor(ownerImage(projectId)); await page.click('[data-view-tab=scene]'); await page.click('[data-action="select-entity:shade-shell"]')
  check('returning to the lamp restores its unsubmitted material value without writing', await page.evaluate('document.querySelector("[data-field=editor-material-roughness]").value==="0.47"&&document.querySelector("[data-action=editor-apply]").disabled===false') && await page.evaluate('window.__versionWrites.length') === ownerWrites)
  await page.click('[data-view-tab=preview]'); await page.evaluate(`window.__ownerHoldProject=${JSON.stringify(cupId)}`); await page.click('[data-view-tab=projects]'); await page.click(`[data-action="select-project:${cupId}"]`); await page.click('[data-view-tab=preview]'); await page.waitFor('window.__ownerReleases.length===1')
  check('pending cup selection retires the lamp image before its new reply arrives', await page.count('[data-compare] img') === 0 && await page.count('[data-preview-state=loading]') === 1)
  await page.evaluate('(()=>{window.__ownerHoldProject=null;window.__ownerReleases.shift()();})()'); await page.waitFor(ownerImage(cupId))
  await selectOwner(projectId); await page.waitFor(ownerImage(projectId)); const repliesBefore = await page.evaluate('window.__ownerResponses.length')
  await page.evaluate(`window.__ownerHoldProject=${JSON.stringify(projectId)}`); await page.click('[data-action=reload]'); await page.waitFor('window.__ownerReleases.length===1')
  await selectOwner(cupId); await page.waitFor(ownerImage(cupId)); const repliesWithCup = await page.evaluate('window.__ownerResponses.length'); check('the newer cup reply actually arrives before the held lamp reply', repliesWithCup > repliesBefore)
  await page.evaluate('(()=>{window.__ownerHoldProject=null;window.__ownerReleases.shift()();})()'); await page.waitFor(`window.__ownerResponses.length===${repliesWithCup + 1}`)
  check('a consumed late lamp HTTP reply cannot replace the current cup', await page.evaluate(ownerImage(cupId)) && await page.evaluate(`document.querySelector('.db-head').textContent.includes(${JSON.stringify(cupId)})`))
  await page.evaluate(`window.__ownerFailProject=${JSON.stringify(cupId)}`); await page.click('[data-action=reload]'); await page.waitFor('window.__ownerFailures.length===2'); await page.evaluate('new Promise(resolve=>setTimeout(resolve,0))')
  check('a same-project failed refresh retires its cached PNG and offers recovery', await page.count('[data-compare] img') === 0 && await page.count('[data-preview-state=error]') === 1 && await page.count('[data-action=preview-reload]') === 1)
  await page.evaluate('window.__ownerFailProject=null'); await page.click('[data-action=preview-reload]'); await page.waitFor(ownerImage(cupId)); await page.evaluate(`window.__ownerCorruptProject=${JSON.stringify(cupId)}`); const corruptBefore = await page.evaluate('window.__ownerResponses.length'); await page.click('[data-action=reload]'); await page.waitFor(`window.__ownerResponses.length===${corruptBefore + 1}`)
  check('a real HTTP preview with another project identity is refused visibly', await page.count('[data-compare] img') === 0 && await page.evaluate('document.body.textContent.includes("UI_PREVIEW_MISMATCH")') && await page.count('[data-action=preview-reload]') === 1)
  await page.evaluate('window.__ownerCorruptProject=null'); await page.click('[data-action=preview-reload]'); await page.waitFor(ownerImage(cupId))
  check('all preview navigation and recovery keep both works and all original PNGs unchanged', kept() && Object.entries(allSaved).every(([name,h]) => sha(readFileSync(file('revisions', name))) === h) && Object.entries(cupProtected).every(([path,h]) => sha(readFileSync(cupFile(path))) === h) && await page.evaluate('window.__versionWrites.length') === ownerWrites)
  json('project-preview-ownership.json', { projectId, cupId, cupArtifact, cupProtected, allSaved, ownerWrites, finalWrites: await page.evaluate('window.__versionWrites.length'), failedSmall, failures: await page.evaluate('window.__ownerFailures'), responses: await page.evaluate('window.__ownerResponses') })
  json('artifacts.json', { initial, first, second, third, after, currentSheet, firstSheet, narrow, protectedSources, manifests, retained })
} catch (error) {
  failure = error.stack || String(error); checks.push({ name: 'workflow completes without unexpected failure', ok: false, detail: failure }); console.error(error); await page?.screenshot(join(output, 'failure.png')).catch(() => {})
  if (page) json('failure-dom.json', await page.evaluate('({clicks:window.__previewPointerClicks,editor:document.querySelector("[data-scene-editor]")?.dataset,apply:document.querySelector("[data-action=editor-apply]")?.disabled,text:document.body.textContent})').catch(error => ({ failure: String(error) })))
} finally {
  for (const fiber of fibers.slice().reverse()) { try { await fiber.dispose() } catch (error) { failure ??= String(error) } }
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) { try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { failure ??= String(error) } }
  json('report.json', { status: failure ? 'failed' : 'passed', checks, failure, shutdown, scope: 'Real Chrome, Host and Blender: measured single and per-view settings, capped samples, retained sheet snapshots, mixed conditions, matched editor comparison, legacy unknown settings, scroll continuity and native activation under forced refresh, narrow display, restore, reload, saved-version entries, three real versions, current/nearest comparison, read-only navigation, preserved unsaved inputs, delayed diff response ownership and narrow activation; two actual works, network and identity refusal, explicit preview recovery, pending and delayed source ownership, preserved material drafts and narrow failure layout. Multi-view current/previous slots retain their established two-generation policy; no artistic approval.' })
}
console.log(`Preview history: ${checks.filter(item => item.ok).length}/${checks.length} checks passed; ${output}`)
if (failure) process.exitCode = 1
