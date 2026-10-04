#!/usr/bin/env node
/** Real local files → staged library → isolated inspection → explicit revision.
 * No online model, third-party assets, historical workspace, or mock Host required.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { defaultSceneSpec } from '../../../packages/deepblend/host/lib/revision-transaction.js'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const directory = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `asset-library-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`))
if (existsSync(directory)) throw new Error(`Evidence directory already exists: ${directory}`)
const root = join(directory, 'store'), sources = join(directory, 'sources'), projectId = 'asset-ui', results = [], startedAt = new Date().toISOString()
mkdirSync(sources, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const path = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(path(...parts)))
const current = () => read('project.json').currentRevision
const spec = () => read('revisions', current(), 'scene-spec.json')
const manifest = () => read('revisions', current(), 'revision-manifest.json')
const write = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) { results.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`); if (!ok) throw new Error(name) }
const blenderPath = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
if (!existsSync(blenderPath)) throw new Error(`Set DEEPBLEND_BLENDER_PATH; Blender not found: ${blenderPath}`)
const generate = String.raw`
import bpy,sys,json,struct
from pathlib import Path
root=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=.16,location=(0,0,.08))
body=bpy.context.object; body.name='authored-body'
for name,color in [('authored-red',(.6,.02,.01,1)),('authored-blue',(.01,.06,.5,1))]:
    material=bpy.data.materials.new(name); material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=color
    body.data.materials.append(material)
for face in body.data.polygons: face.material_index=face.index%2
bpy.ops.export_scene.gltf(filepath=str(root/'authored-product.glb'),export_format='GLB')
image=bpy.data.images.new('bundle-color',width=8,height=8,alpha=True);image.pixels=[.03,.55,.09,1]*64
texture=body.data.materials[0].node_tree.nodes.new('ShaderNodeTexImage');texture.image=image
body.data.materials[0].node_tree.links.new(texture.outputs['Color'],body.data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Base Color'])
bpy.ops.export_scene.gltf(filepath=str(root/'bundled.gltf'),export_format='GLTF_SEPARATE')
document=json.loads((root/'bundled.gltf').read_text());data=json.dumps(document,separators=(',',':')).encode();data+=b' '*(-len(data)%4)
payload=struct.pack('<II',len(data),0x4e4f534a)+data
(root/'bundled.glb').write_bytes(struct.pack('<4sII',b'glTF',2,len(payload)+12)+payload)
(root/'bundle-image.json').write_text(json.dumps(document['images'][0]['uri']))
image.filepath_raw=str(root/document['images'][0]['uri'])
bpy.ops.wm.obj_export(filepath=str(root/'bundled.obj'),path_mode='RELATIVE',export_pbr_extensions=True)
(root/'bundled-implicit.obj').write_text('\n'.join(line for line in (root/'bundled.obj').read_text().splitlines() if not line.startswith('mtllib '))+'\n')
(root/'bundled-implicit.mtl').write_bytes((root/'bundled.mtl').read_bytes())
pixels=[]
for y in range(32):
    for x in range(64): pixels.extend([8,5,2,1] if 12<x<25 and 10<y<24 else [.06,.08,.15,1])
for extension,kind in [('hdr','HDR'),('exr','OPEN_EXR')]:
    image=bpy.data.images.new(extension,width=64,height=32,float_buffer=True)
    image.colorspace_settings.name='Linear Rec.709'; image.pixels[:]=pixels
    bpy.context.scene.render.image_settings.file_format=kind
    image.save_render(str(root/('authored-studio.'+extension)),scene=bpy.context.scene)
`
writeFileSync(join(directory, 'generate.py'), generate)
const generated = spawnSync(blenderPath, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', join(directory, 'generate.py'), '--', sources], { encoding: 'utf8', timeout: 120000 })
writeFileSync(join(directory, 'generate.log'), `${generated.stdout || ''}\n${generated.stderr || ''}`)
if (generated.status !== 0) throw new Error('Local asset generation failed; see generate.log')
const pixels = Buffer.alloc(128 * 64 * 4)
for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) { const i = (y * 128 + x) * 4; pixels.set([x * 2, y * 4, (Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 230 : 25, 255], i) }
await sharp(pixels, { raw: { width: 128, height: 64, channels: 4 } }).png().toFile(join(sources, 'authored-color.png'))
await sharp(pixels, { raw: { width: 128, height: 64, channels: 4 } }).jpeg().toFile(join(sources, 'authored-color.jpeg'))
const scene = defaultSceneSpec({ projectId, title: 'Local asset workflow', goal: 'Inspect and explicitly apply locally authored assets.' })
scene.entities[0].generator = { shape: 'cube', size: .16 }; scene.entities[0].transform.location = [-.14, 0, .08]
scene.entities.push({ id: 'floor', type: 'generator', generator: { shape: 'plane', size: 1.4 }, materialId: 'default-surface', tags: ['environment'], transform: { location: [0, 0, -.002], rotationEuler: [0, 0, 0], scale: [1, 1, 1] } })
scene.materials[0].parameters.baseColor = [.12, .17, .24, 1]
scene.world = { color: [.08, .1, .14], strength: .3 }
scene.cameras[0].transform.location = [.65, -.85, .48]; delete scene.cameras[0].targetEntityId; scene.cameras[0].targetPoint = [0, 0, .08]; scene.cameras[0].clipping = [.01, 100]
scene.lights[0].transform.location = [.3, -.4, .75]; scene.lights[0].transform.rotationEuler = [.48, 0, .6]; scene.lights[0].energy = 30; scene.lights[0].size = .6
scene.renderProfiles.preview = { engine: 'cycles', resolution: [256, 192], samples: 8, maxSamplesBudget: 8, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 } }
let server, browser, page, base, url, outcome = 'failed', shutdown, originals = {}, captures = [], previews = []
const field = name => `[data-field="${name}"]`
async function select(name, value) { await page.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(field(name))});if(!el)throw Error('missing select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`) }
async function sceneView() { await page.click('[data-view-tab="scene"]'); await page.waitFor('document.querySelector("[data-assets-library]")!==null', 30000) }
async function upload(name) {
  const before = current(), file = join(sources, name)
  const { root: dom } = await page.send('DOM.getDocument'); const selected = await page.send('DOM.querySelector', { nodeId: dom.nodeId, selector: field('asset-upload') })
  await page.send('DOM.setFileInputFiles', { nodeId: selected.nodeId, files: [file] })
  await page.waitFor(`Array.from(document.querySelectorAll('[data-asset-id]')).some(el=>el.textContent.includes(${JSON.stringify(name)}))`, 30000)
  const inventory = await (await fetch(`${base}/deepblend/projects/${projectId}/assets`)).json()
  const row = inventory.assets.find(entry => entry.originalName === name)
  check(`${name}: native upload stores exact bytes and keeps the scene revision`, row?.asset.sha256 === sha(readFileSync(file)) && current() === before)
  return row
}
const card = row => `[data-asset-id="${row.asset.id}"][data-asset-path="${row.asset.path}"]`
async function inspect(row) {
  const before = current(), clicked = await page.click(`${card(row)} [data-action="asset-preview:${row.asset.id}"]`)
  await page.waitFor(`document.querySelector(${JSON.stringify(card(row) + ' [data-asset-preview]')})?.naturalWidth>0`, 180000)
  const inventory = await (await fetch(`${base}/deepblend/projects/${projectId}/assets`)).json()
  const item = inventory.assets.find(entry => entry.asset.id === row.asset.id && entry.asset.path === row.asset.path)
  check(`${row.originalName}: isolated preview is a real PNG with pinned inspection`, clicked.via === 'pointer' && item.preview?.sha256 === sha(readFileSync(path(item.preview.path))) && current() === before)
  copyFileSync(path(item.preview.path), join(directory, `library-${row.asset.type}-${previews.length}.png`)); previews.push(item)
  return item
}
async function choose(row) { await page.click(`${card(row)} [data-action="asset-use:${row.asset.id}"]`); await page.waitFor('document.querySelector("[data-asset-draft]")!==null') }
async function apply(label) {
  const before = current(), clicked = await page.click('[data-action="asset-apply"]')
  await page.waitFor(`document.querySelector('[data-compare="right"] img[data-artifact-revision]')?.dataset.artifactRevision!==undefined && document.querySelector('[data-compare="right"] img[data-artifact-revision]').dataset.artifactRevision!==${JSON.stringify(before)}`, 180000)
  const after = current(), preview = manifest().previews.at(-1)
  check(`${label}: explicit pointer apply saves a checkpoint and actual preview`, clicked.via === 'pointer' && after !== before && existsSync(path('revisions', after, 'scene.blend')) && preview?.sha256 === sha(readFileSync(path(preview.path))))
  copyFileSync(path(preview.path), join(directory, `${after}-${label}.png`)); captures.push({ before, after, label, preview })
  await sceneView(); return { before, after, preview }
}
try {
  const rows = JSON.parse(await storePatch(root)); rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blenderPath
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false }); base = `http://127.0.0.1:${server.port}`; url = `${base}/deepblend/workbench`
  write('server-info.json', { root, url, port: server.port })
  const created = await fetch(`${base}/deepblend/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, title: scene.project.title, sceneSpec: scene, renderPreview: true }), signal: AbortSignal.timeout(180000) })
  if (!created.ok) throw new Error(`Fixture creation ${created.status}: ${await created.text()}`)
  const firstPreview = manifest().previews.at(-1); copyFileSync(path(firstPreview.path), join(directory, 'r0001-before.png'))
  originals = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend', 'revisions/r0001/revision-manifest.json', firstPreview.path].map(file => [file, sha(readFileSync(path(file)))]))
  browser = await Browser.launch({ args: ['--window-size=1440,1000'] }); page = await browser.newPage()
  await page.addInitScript(`window.__assetRequests=[];window.__assetPointerEvents=[];
    for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{
      const target=event.target,card=target.closest?.('[data-asset-path]'),rect=target.getBoundingClientRect?.();
      window.__assetPointerEvents.push({at:performance.now(),type,x:event.clientX,y:event.clientY,tag:target.tagName,
        action:target.closest?.('[data-action]')?.getAttribute('data-action'),assetPath:card?.getAttribute('data-asset-path'),
        disabled:target.disabled,rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null});
      if(window.__assetPointerEvents.length>400)window.__assetPointerEvents.shift();
    },true);
    const original=window.fetch;window.fetch=async(input,init)=>{let body;try{body=typeof init?.body==='string'?JSON.parse(init.body):undefined}catch{}
      const record={at:performance.now(),url:String(input),method:init?.method||'GET',body,bodyType:init?.body?.constructor?.name,fileBytes:init?.body instanceof File?init.body.size:null};
      window.__assetRequests.push(record);
      try{const response=await original(input,init);record.status=response.status;record.completedAt=performance.now();
        if(!response.ok)response.clone().text().then(text=>record.errorBody=text.slice(0,4000)).catch(()=>{});
        return response;
      }catch(error){record.error=String(error);record.completedAt=performance.now();throw error;}
    }`)
  await page.goto(url); await page.waitFor('document.querySelector("[data-brief-base-revision=r0001]")!==null', 45000); await sceneView()
  check('the library is opened explicitly without an automatic inspection request', !(await page.evaluate('window.__assetRequests')).some(request => /\/assets/.test(request.url)))
  await page.click('[data-action="assets-open"]'); await page.waitFor('document.querySelector("[data-asset-limits]")!==null')
  check('the UI displays Host limits and an optional 200-character license', (await page.text('[data-asset-limits]')).includes('1,024') && await page.evaluate('document.querySelector("[data-field=asset-license]").maxLength===200'))
  await page.fill(field('asset-license'), 'Original fixture authored by this test')
  const model = await upload('authored-product.glb'), inspectedModel = await inspect(model)
  check('GLB inspection exposes source material slots and UV inventory', inspectedModel.inspection.parts.some(part => part.sourceMaterialSlots?.length === 2 && part.uvMaps?.length))
  await choose(model); await page.fill(field('asset-entity-id'), 'imported-product'); await page.fill(field('asset-location-x'), '140')
  check('draft edits do not create a revision and remain pinned to the base', current() === 'r0001' && await page.evaluate('document.querySelector("[data-assets-library]").dataset.assetBaseRevision==="r0001"'))
  await page.screenshot(join(directory, '01-glb-draft.png')); await apply('model')
  const imported = spec().entities.find(entity => entity.id === 'imported-product')
  check('GLB insertion retains native material graphs by omitting any material override', imported.assetId === model.asset.id && !Object.hasOwn(imported, 'materialId') && !Object.hasOwn(imported, 'materialBindings') && imported.transform.location[0] === .14)
  check('license provenance is declared verbatim with the applied asset', spec().assets.find(asset => asset.id === model.asset.id).license?.source === 'Original fixture authored by this test')
  await page.fill(field('asset-license'), '')
  const png = await upload('authored-color.png'); await inspect(png); await choose(png); await select('asset-target-entity', 'subject'); await page.fill(field('asset-uv-map'), 'missing-uv')
  const beforeFailure = current(), filesBeforeFailure = readdirSync(path('revisions'))
  await page.click('[data-action="asset-apply"]'); await page.waitFor('document.querySelector("[data-assets-library] .db-error")?.textContent.includes("SCENE_VALIDATION_FAILED")', 180000)
  check('missing named UV fails clearly without publishing a revision and keeps user input', current() === beforeFailure && isDeepStrictEqual(readdirSync(path('revisions')), filesBeforeFailure) && await page.evaluate('document.querySelector("[data-field=asset-uv-map]").value==="missing-uv"'))
  await page.fill(field('asset-uv-map'), ''); await page.fill(field('asset-map-scale-u'), '2'); await apply('png-color')
  const pngSpec = spec(), targetMaterial = pngSpec.materials.find(material => material.id === pngSpec.entities.find(entity => entity.id === 'subject').materialId)
  check('PNG binding clones the selected material, preserves the shared floor and stores UV settings', targetMaterial.images.baseColor.assetId === png.asset.id && targetMaterial.images.baseColor.scale[0] === 2 && pngSpec.entities.find(entity => entity.id === 'floor').materialId === 'default-surface' && !pngSpec.materials.find(material => material.id === 'default-surface').images)
  check('an undeclared license stays absent when applying the PNG', !Object.hasOwn(pngSpec.assets.find(asset => asset.id === png.asset.id), 'license'))
  const jpeg = await upload('authored-color.jpeg'); await inspect(jpeg); await choose(jpeg); await select('asset-target-entity', 'imported-product'); await select('asset-material-target', 'slot')
  const actualScene = await (await fetch(`${base}/deepblend/projects/${projectId}/scene`)).json(); const part = actualScene.scene.nodes.entities.find(entity => entity.id === 'imported-product').assetParts.find(item => item.sourceMaterialSlots.length === 2)
  await select('asset-material-part', part.partId); await select('asset-material-slot', '0')
  check('native imported material requires an explicit new material before binding', await page.evaluate('document.querySelector("[data-action=asset-apply]").disabled'))
  await page.click(field('asset-new-material')); await apply('jpeg-slot')
  const jpegSpec = spec(), jpegEntity = jpegSpec.entities.find(entity => entity.id === 'imported-product'), binding = jpegEntity.materialBindings[0]
  check('JPEG applies only the explicit original slot and preserves the rest of the native object', binding.partId === part.partId && binding.slotIndex === 0 && jpegEntity.materialBindings.length === 1 && !jpegEntity.materialId && jpegSpec.materials.find(material => material.id === binding.materialId).images.baseColor.assetId === jpeg.asset.id)
  const worldBefore = structuredClone(jpegSpec.world)
  for (const [extension, strength, rotation] of [['hdr', .4, 30], ['exr', .6, 60]]) {
    const environment = await upload(`authored-studio.${extension}`), result = await inspect(environment)
    check(`${extension}: UI identifies the preview as a tone-mapped lighting example`, result.inspection.kind === 'environment' && result.preview.toneMapped && (await page.text(`[data-asset-id="${environment.asset.id}"]`)).includes('环境照明'))
    await choose(environment); await page.fill(field('asset-world-strength'), String(strength)); await page.fill(field('asset-world-rotation'), String(rotation)); await apply(`${extension}-world`)
    check(`${extension}: world application preserves color, cameras and lights`, spec().world.environment.assetId === environment.asset.id && Math.abs(spec().world.environment.rotation - rotation * Math.PI / 180) < 1e-10 && spec().world.strength === strength && isDeepStrictEqual(spec().world.color, worldBefore.color) && isDeepStrictEqual(spec().cameras, scene.cameras) && isDeepStrictEqual(spec().lights, scene.lights))
  }
  const seedContext = new Context(); seedContext.provide('blenderRuntime', {})
  const seed = new Studio(seedContext, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
  let bundledVersions
  try {
    const gltf = await seed.ingestAsset({ projectId, sourcePath: join(sources, 'bundled.gltf'), sourceRoot: sources, assetId: 'bundled-json' })
    const first = await seed.ingestAsset({ projectId, sourcePath: join(sources, 'bundled.glb'), sourceRoot: sources, assetId: 'bundled-binary' })
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 230, g: 25, b: 15, alpha: 1 } } }).png().toFile(join(sources, JSON.parse(readFileSync(join(sources, 'bundle-image.json')))))
    const second = await seed.ingestAsset({ projectId, sourcePath: join(sources, 'bundled.glb'), sourceRoot: sources, assetId: 'bundled-binary' })
    const objFirst = await seed.ingestAsset({ projectId, sourcePath: join(sources, 'bundled.obj'), sourceRoot: sources, assetId: 'bundled-obj' })
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 25, g: 40, b: 230, alpha: 1 } } }).png().toFile(join(sources, JSON.parse(readFileSync(join(sources, 'bundle-image.json')))))
    const objSecond = await seed.ingestAsset({ projectId, sourcePath: join(sources, 'bundled.obj'), sourceRoot: sources, assetId: 'bundled-obj' })
    const objImplicit = await seed.ingestAsset({ projectId, sourcePath: join(sources, 'bundled-implicit.obj'), sourceRoot: sources, assetId: 'bundled-obj-implicit' })
    bundledVersions = [gltf, first, second, objFirst, objSecond, objImplicit]
  } finally { await seedContext.fiber.dispose() }
  await page.click('[data-action="assets-open"]')
  await page.waitFor('document.querySelectorAll("[data-asset-id]").length===11', 30000)
  const library = await (await fetch(`${base}/deepblend/projects/${projectId}/assets`)).json()
  const bundledRows = bundledVersions.map(version => library.assets.find(row => row.asset.path === version.path && row.asset.id === version.assetId))
  check('same-main GLB versions appear as separate cards with exact paths', bundledVersions[1].sha256 === bundledVersions[2].sha256 && bundledVersions[1].path !== bundledVersions[2].path && bundledRows.every(Boolean))
  check('same-main OBJ versions and implicit MTL model have independent cards', bundledVersions[3].sha256 === bundledVersions[4].sha256 && bundledVersions[3].path !== bundledVersions[4].path && bundledRows.slice(3).every(row => row.asset.type === 'obj'))
  for (const [index, row] of bundledRows.entries()) {
    const receipt = await inspect(row)
    check('bundled model preview exposes real material slots and UVs', receipt.inspection.kind === 'model' && receipt.inspection.parts.some(p => p.sourceMaterialSlots.length === 2 && p.uvMaps.length))
    await choose(row); await page.fill(field('asset-entity-id'), 'bundled-object-' + index)
    await apply('bundled-' + index)
    const entity = spec().entities.find(e => e.id === 'bundled-object-' + index), applied = spec().assets.find(a => a.id === entity.assetId)
    const earlierIndex = index === 2 ? 1 : index === 4 ? 3 : null
    check('selected dependency version applies without changing earlier objects', applied.path === row.asset.path && applied.sha256 === row.asset.sha256 && !Object.hasOwn(entity, 'materialId') && (earlierIndex === null || spec().assets.find(a => a.id === spec().entities.find(e => e.id === 'bundled-object-' + earlierIndex).assetId).path === bundledRows[earlierIndex].asset.path))
  }
  const pixelA = decodePng(readFileSync(path(previews[6].preview.path))), pixelB = decodePng(readFileSync(path(previews[7].preview.path)))
  check('same-main GLB versions produce different actual browser preview images', !pixelA.data.every((v, i) => v === pixelB.data[i]))
  const objPixelA = decodePng(readFileSync(path(previews[8].preview.path))), objPixelB = decodePng(readFileSync(path(previews[9].preview.path)))
  check('same-main OBJ texture versions produce different actual browser preview images', !objPixelA.data.every((v, i) => v === objPixelB.data[i]))
  const bundledRequests = (await page.evaluate('window.__assetRequests')).filter(r => r.method === 'POST' && /\/assets\/.+\/preview$/.test(r.url) && r.body?.assetPath?.startsWith('assets/bundles/'))
  check('browser preview requests pin every selected full dependency path', bundledRequests.length === 6 && bundledRows.every(row => bundledRequests.some(r => r.body.assetPath === row.asset.path)))
  const saved = current(); write('requests-before-refresh.json', await page.evaluate('window.__assetRequests'))
  await page.reload(); await page.waitFor(`document.querySelector('[data-brief-base-revision="${saved}"]')!==null`, 45000); await sceneView(); await page.click('[data-action="assets-open"]'); await page.waitFor('document.querySelectorAll("[data-asset-preview]").length>=11 && Array.from(document.querySelectorAll("[data-asset-preview]")).every(image=>image.naturalWidth>0)', 30000)
  check('refresh recovers all version-specific preview PNGs and their source hashes', await page.evaluate('document.querySelectorAll("[data-asset-preview]").length>=11'))
  await page.evaluate('document.querySelector("[data-assets-library]").scrollIntoView({block:"start"})'); await page.screenshot(join(directory, '02-library-after-refresh.png'))
  await choose(model); await page.fill(field('asset-entity-id'), 'unsaved-conflict-object')
  const peer = await fetch(`${base}/deepblend/projects/${projectId}/patch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { projectId, baseRevision: saved, saveCheckpoint: true, renderPreview: false, operations: [{ op: 'project.brief.set', goal: 'A peer changed the saved goal.', referenceImages: [] }] } }), signal: AbortSignal.timeout(180000) })
  if (!peer.ok) throw new Error(`Peer patch failed: ${await peer.text()}`)
  await page.waitFor('document.querySelector("[data-assets-library]").dataset.assetConflict==="true"', 30000)
  check('a newer revision preserves the asset draft and disables a stale commit', await page.evaluate('document.querySelector("[data-field=asset-entity-id]").value==="unsaved-conflict-object" && document.querySelector("[data-action=asset-apply]").disabled'))
  await page.screenshot(join(directory, '03-conflict-preserved.png')); await page.click('[data-action="asset-reset"]')
  const cancelRevision = current()
  await page.click(`[data-action="asset-preview:${model.asset.id}"]`); await page.waitFor('document.querySelector("[data-action=asset-cancel]")!==null'); await page.click('[data-action="asset-cancel"]')
  await page.waitFor('document.querySelector("[data-assets-library] .db-error")?.textContent.includes("取消")', 30000)
  check('cancelled reinspection reports cancellation, clears usable current result and leaves the scene intact', current() === cancelRevision && await page.evaluate(`document.querySelector('[data-action="asset-use:${model.asset.id}"]').disabled && !document.querySelector('[data-asset-draft]')`))
  await page.screenshot(join(directory, '04-cancelled-inspection.png'))
  const pngBefore = decodePng(readFileSync(path(captures[0].preview.path))), pngAfter = decodePng(readFileSync(path(captures[1].preview.path)))
  let changedPixels = 0; for (let i = 0; i < pngBefore.data.length; i += 4) if ([0, 1, 2].some(channel => pngBefore.data[i + channel] !== pngAfter.data[i + channel])) changedPixels++
  check('the PNG material change reaches actual same-setting render pixels', changedPixels > 0 && isDeepStrictEqual(captures[0].preview.renderConfig, captures[1].preview.renderConfig), { changedPixels })
  check('original checkpoint, SceneSpec, manifest and preview remain byte-identical', Object.entries(originals).every(([file, digest]) => sha(readFileSync(path(file))) === digest))
  const requests = JSON.parse(readFileSync(join(directory, 'requests-before-refresh.json')))
  check('all five uploads used native File bodies and no model review was requested', requests.filter(request => request.method === 'POST' && /\/assets\?/.test(request.url)).length === 5 && requests.filter(request => request.method === 'POST' && /\/assets\?/.test(request.url)).every(request => request.bodyType === 'File' && request.fileBytes > 0) && requests.every(request => !/\/(review|autofix)$/.test(request.url)))
  write('requests-after-refresh.json', await page.evaluate('window.__assetRequests')); write('inspections.json', previews); write('captures.json', captures)
  outcome = 'passed'
} catch (error) {
  console.error(error); results.push({ name: 'unexpected failure', ok: false, detail: error.stack || String(error) })
  if (page) {
    const evidence = await page.evaluate(`(() => ({requests:window.__assetRequests,events:window.__assetPointerEvents,
      libraryHtml:document.querySelector('[data-assets-library]')?.outerHTML,bodyText:document.body.innerText,
      scrolls:Array.from(document.querySelectorAll('[data-scroll-key]')).map(el=>({key:el.dataset.scrollKey,top:el.scrollTop,left:el.scrollLeft})),
      cards:Array.from(document.querySelectorAll('[data-asset-path]')).map(el=>({assetId:el.dataset.assetId,assetPath:el.dataset.assetPath,
        buttons:Array.from(el.querySelectorAll('button')).map(button=>({action:button.dataset.action,disabled:button.disabled,rect:button.getBoundingClientRect().toJSON()})),
        image:(()=>{const image=el.querySelector('[data-asset-preview]');return image?{src:image.src,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,rect:image.getBoundingClientRect().toJSON()}:null})()}))}))()`)
      .catch(diagnosticError => ({ captureError: String(diagnosticError) }))
    write('failure-evidence.json', evidence); write('failure-console.json', page.consoleLog)
    await page.screenshot(join(directory, 'failure.png')).catch(() => {})
  }
}
finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { outcome = 'failed'; results.push({ name: `${name} shutdown`, ok: false, detail: String(error) }) }
  }
  const report = { startedAt, completedAt: new Date().toISOString(), outcome, directory, root, url, projectId, shutdown, originals, captures, results, passed: results.filter(result => result.ok).length, total: results.length,
    scope: 'Real browser, locally authored five upload formats plus locked JSON glTF, two same-main external GLB versions, two same-main OBJ versions and implicit MTL OBJ, actual Host/Blender output. Representative base-color image binding, original GLB slot override, world lighting, conflict and preview cancellation. Other map channels, all format combinations and online model quality are not claimed.' }
  write('results.json', report); console.log(`Asset library UI: ${report.passed}/${report.total}; ${directory}`)
}
if (outcome !== 'passed') process.exitCode = 1
