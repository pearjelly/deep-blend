#!/usr/bin/env node
/** Real pointer save, native UV area, equal-cost pixels, replay and old revision protection. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { decodePng, validateSceneSpec } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'
import { clickWorkbenchControl } from './workbench-navigation.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `mesh-uv-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(output)) throw Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const root = join(output, 'store'), projectId = 'mesh-uv-beams', checks = [], startedAt = new Date().toISOString()
const path = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(path(...parts)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (file, value) => writeFileSync(join(output, file), JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) {
  checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`)
  if (!ok) throw Error(name)
}
const field = key => `[data-field="editor-uv-${key}"]`
const sceneSpec = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json')))
sceneSpec.project = { ...sceneSpec.project, id: projectId, title: '逐面 UV · 重复纹理验收', goal: 'Synthetic regression fixture: retain beam geometry and repair collapsed repeating-texture UVs.', frameEnd: 24 }
sceneSpec.materials = [{ id: 'wood-test', shader: 'principled', parameters: { baseColor: [.3, .12, .035, 1], roughness: .55 },
  texture: { type: 'wave', coordinates: 'uv', uvMap: 'UVMap', scale: 12, stretch: [1, 2, 1], bump: .03, colorVariation: .3 } }, sceneSpec.materials[0]]
sceneSpec.entities = [sceneSpec.entities.find(entity => entity.id === 'stage'), { id: 'beam', type: 'generator', materialId: 'wood-test',
  tags: ['hero-product'], transform: { location: [-.4,0,.1], rotationEuler: [0,0,0], scale: [1,1,1] },
  generator: { shape: 'mesh', vertices: [[0,.1,0],[.13,.1,0],[.13,2.7,0],[0,2.7,0],[0,.1,.14],[.13,.1,.14],[.13,2.7,.14],[0,2.7,.14]],
    faces: [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]], smooth: false },
  modifiers: [{ type: 'array', count: 3, offset: [.35,0,0] }, { type: 'mirror', axis: 'y', merge: false }] }]
sceneSpec.entities[0].generator.size = 14
sceneSpec.cameras = [{ id: 'camera-main', role: 'active-camera', lens: 45, sensorWidth: 36, clipping: [.05,100],
  transform: { location: [3,-5,4], rotationEuler: [0,0,0], scale: [1,1,1] }, targetPoint: [0,0,.12] }]
sceneSpec.shots = []; sceneSpec.animationTracks = []
sceneSpec.lights = [{ id:'key', type:'area', energy:700, size:5, color:[1,.95,.85,1], transform:{location:[1,-2,6],rotationEuler:[0,0,0],scale:[1,1,1]} }]
sceneSpec.world = { color: [.5,.5,.5,1], strength: .5 }
sceneSpec.renderProfiles.preview = { ...sceneSpec.renderProfiles.preview, resolution: [480,360], samples: 16 }
json('scene-input.json', sceneSpec)
let server, browser, page, failure, shutdown, originals
try {
  const validation = validateSceneSpec(sceneSpec)
  if (!validation.ok) throw Error(validation.summary)
  const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
  const rows = JSON.parse(await storePatch(root)); rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 16
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  const base = `http://127.0.0.1:${server.port}`
  const created = await fetch(`${base}/deepblend/projects`, { method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify({projectId,title:sceneSpec.project.title,sceneSpec,renderPreview:true}),signal:AbortSignal.timeout(180000) })
  if (!created.ok) throw Error(`Create ${created.status}: ${await created.text()}`)
  const before = read('revisions','r0001','scene-spec.json'), previewBefore = read('revisions','r0001','revision-manifest.json').previews.at(-1)
  originals = Object.fromEntries(['revisions/r0001/scene-spec.json','revisions/r0001/scene.blend',previewBefore.path].map(file => [file,sha(readFileSync(path(file)))]))
  copyFileSync(path(previewBefore.path),join(output,'before.png'))
  browser = await Browser.launch({args:['--window-size=1440,1100']}); page = await browser.newPage()
  await page.addInitScript(`window.__uvWrites=[];const originalFetch=window.fetch;window.fetch=(input,init)=>{if(init?.method==='POST')window.__uvWrites.push({url:String(input),body:JSON.parse(init.body)});return originalFetch(input,init)}`)
  const openEditor = async () => {
    await page.click('[data-view-tab="scene"]'); await page.waitFor(`document.querySelector(${JSON.stringify('[data-action="select-entity:beam"]')})!==null`,30000)
    await clickWorkbenchControl(page,'[data-action="select-entity:beam"]'); await page.waitFor(`document.querySelector(${JSON.stringify(field('project'))})!==null`,30000)
  }
  await page.goto(`${base}/deepblend/workbench`); await page.waitFor('document.querySelector("[data-lighttable-revision=r0001]")!==null',45000); await openEditor()
  check('opening existing mesh UV controls makes no write and leaves the saved UV choice intact', await page.evaluate(`window.__uvWrites.length===0&&!document.querySelector(${JSON.stringify(field('project'))}).checked&&document.querySelector('[data-scene-editor]').dataset.editorDirty==='false'`))
  const clicked = await page.click(field('project')); check('a real pointer stages UV projection',clicked.via==='pointer')
  await page.fill(field('scale'),'0')
  check('invalid repetitions keep the save button disabled and publish nothing',await page.evaluate('document.querySelector("[data-action=editor-apply]").disabled&&window.__uvWrites.length===0')&&read('project.json').currentRevision==='r0001')
  await page.fill(field('scale'),'1')
  const capture = async (name,width,height,theme='light') => {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
    await page.evaluate(`(()=>{document.querySelector('[data-uv-editor]').scrollIntoView({block:'center'});window.scrollTo(0,0)})()`)
    await page.evaluate(`(()=>{const input=document.querySelector('[data-field="workbench-appearance"]');input.value=${JSON.stringify(theme)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const metrics = await page.evaluate(`(()=>{const node=document.querySelector('[data-uv-editor]'),r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,ready:[...document.images].every(image=>image.complete)}})()`)
    check(`${name} controls fit the viewport and preview is loaded`,metrics.left>=0&&metrics.right<=metrics.width&&metrics.scrollWidth<=metrics.width&&metrics.ready,metrics)
    const {cssContentSize} = await page.send('Page.getLayoutMetrics')
    const result = await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}})
    writeFileSync(join(output,name),Buffer.from(result.data,'base64'))
  }
  await capture('desktop.png',1440,1100)
  await capture('mobile.png',390,844)
  await capture('desktop-dark.png',1440,1100,'dark')
  await capture('mobile-dark.png',390,844,'dark')
  await page.fill(field('scale'),'0')
  check('invalid repeats link adjacent range feedback and keep Save disabled',await page.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(field('scale'))}),feedback=document.getElementById(input.getAttribute('aria-describedby'));return input.getAttribute('aria-invalid')==='true'&&feedback?.textContent.includes('0.0001')&&feedback.textContent.includes('10000')&&document.querySelector('[data-action="editor-apply"]').disabled})()`))
  await capture('desktop-error.png',1440,1100)
  await capture('mobile-error.png',390,844)
  await capture('desktop-dark-error.png',1440,1100,'dark')
  await capture('mobile-dark-error.png',390,844,'dark')
  await page.fill(field('scale'),'1')
  await page.evaluate(`(()=>{const input=document.querySelector('[data-field="workbench-appearance"]');input.value='light';input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false})
  check('draft changes wait for Save',await page.evaluate('window.__uvWrites.length===0'))
  const saved = await page.click('[data-action="editor-apply"]');check('Save is reachable with a real pointer',saved.via==='pointer')
  await page.waitFor('document.querySelector("[data-lighttable-revision=r0002]")!==null',180000)
  const writes=await page.evaluate('window.__uvWrites'), request=writes.at(-1).body.patch;json('requests.json',writes)
  check('one save sends only the semantic UV request against its original revision',writes.length===1&&request.baseRevision==='r0001'&&request.saveCheckpoint===true&&request.renderPreview===true&&isDeepStrictEqual(request.operations,[{op:'entity.uv.project',entityId:'beam',quarterTurns:0,scale:1}]))
  const after=read('revisions','r0002','scene-spec.json'),restored=structuredClone(after);delete restored.entities.find(entity=>entity.id==='beam').generator.faceUvs
  check('the saved spec changes only explicit UVs',isDeepStrictEqual(restored,before))
  const previewAfter=read('revisions','r0002','revision-manifest.json').previews.at(-1)
  check('actual before and after previews have equal render settings',isDeepStrictEqual(previewBefore.renderConfig,previewAfter.renderConfig)&&['cameraId','frame','width','height','samples','engine'].every(key=>previewBefore[key]===previewAfter[key]))
  copyFileSync(path(previewAfter.path),join(output,'after.png'))
  const a=decodePng(readFileSync(path(previewBefore.path))),b=decodePng(readFileSync(path(previewAfter.path)))
  let changed=0;for(let index=0;index<a.data.length;index+=4)if([0,1,2].some(channel=>a.data[index+channel]!==b.data[index+channel]))changed++
  check('the UV save reaches actual rendered pixels',changed>0,{changedPixels:changed,beforePixels:sha(a.data),afterPixels:sha(b.data)})
  const nativePath=join(output,'native-readback.json')
  writeFileSync(join(output,'native-readback.log'),execFileSync(blenderPath,['--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',join(REPO_ROOT,'deepblend/tests/lib/inspect-native-mesh-uv.py'),'--',path('revisions','r0001','scene.blend'),path('revisions','r0002','scene.blend'),nativePath],{timeout:90000,maxBuffer:8*1024*1024}))
  const native=JSON.parse(readFileSync(nativePath));check('independent reopening finds 48 collapsed UV triangles repaired and identical native geometry',native.before.uvMaps.beam[0].zeroAreaTriangleCount===48&&native.after.uvMaps.beam[0].zeroAreaTriangleCount===0&&native.before.geometryDigest===native.after.geometryDigest&&native.before.objectsDigest===native.after.objectsDigest,native)
  const replay=await fetch(base+`/deepblend/projects/${projectId}/patch`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({patch:request}),signal:AbortSignal.timeout(180000)})
  const replayResult=await replay.json();json('replay.json',replayResult)
  check('replaying the same saved request returns the original revision without another checkpoint',replay.ok&&replayResult.revision?.revision==='r0002'&&replayResult.revision?.idempotentReplay===true&&read('project.json').currentRevision==='r0002'&&!existsSync(path('revisions','r0003')))
  await page.reload();await page.waitFor('document.querySelector("[data-lighttable-revision=r0002]")!==null',45000);await openEditor()
  check('refresh shows saved UVs without staging a second rebuild',await page.evaluate(`!document.querySelector(${JSON.stringify(field('project'))}).checked&&document.querySelector('[data-scene-editor]').dataset.editorDirty==='false'&&document.querySelector('[data-uv-editor]').textContent.includes('已保存')&&window.__uvWrites.length===0`))
  check('the original spec, checkpoint and preview remain byte-identical',Object.entries(originals).every(([file,digest])=>sha(readFileSync(path(file)))===digest))
  check('the workflow made no hidden review or model request',writes.every(row=>row.url.endsWith('/patch'))&&(read('revisions','r0002','revision-manifest.json').reviews||[]).length===0)
} catch (error) {
  failure=error.stack||String(error);checks.push({name:'workflow completes without unexpected failure',ok:false,detail:failure});console.error(error)
  await page?.screenshot(join(output,'failure.png')).catch(()=>{})
} finally {
  for(const [name,close] of [['browser',()=>browser?.close()],['server',()=>server?.stop()]])try{const result=await close();if(name==='server')shutdown=result}catch(error){failure??=String(error)}
  json('report.json',{startedAt,completedAt:new Date().toISOString(),status:failure?'failed':'passed',checks,failure,shutdown,originals,
    scope:'Synthetic six-beam fixture, real browser/Host/Blender, independent reopening, exact UV triangle area and equal-setting pixel change; no model calls, atlas packing, seam or artistic approval.'})
}
console.log(`Mesh UV editor: ${checks.filter(check=>check.ok).length}/${checks.length} checks passed; ${output}`)
if(failure)process.exitCode=1
