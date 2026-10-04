/** Real photography controls, fixed saved inspections, native fields and conditional restore. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend/quality', `photography-ui-${Date.now()}`))
if (existsSync(output)) throw Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const root = join(output, 'store'), projectId = 'photography-cup', checks = []
const path = (...parts) => join(root, 'projects', projectId, ...parts)
const read = (...parts) => JSON.parse(readFileSync(path(...parts)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
const field = key => `[data-field="photo-${key}"]`
const cameraOf = spec => spec.cameras.find(camera => camera.id === 'hero')
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
let server, browser, page, base, failure = null, shutdown, original
try {
  const blender = process.env.DEEPBLEND_BLENDER_PATH ?? join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  const sceneSpec = JSON.parse(readFileSync(join(REPO_ROOT, 'deepblend/recipes/glazed-cup/scene-spec.json')))
  sceneSpec.renderProfiles.preview.resolution = [320, 240]; sceneSpec.renderProfiles.preview.samples = 8
  Object.assign(cameraOf(sceneSpec), { sensorWidth: 42, fStop: 6.3 })
  const rows = JSON.parse(await storePatch(root))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows), keepHome: false })
  base = `http://127.0.0.1:${server.port}`
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) })
    const value = await response.json(); if (!response.ok || !value.ok) throw Error(JSON.stringify(value)); return value
  }
  await post('/deepblend/projects', { projectId, title: projectId, sceneSpec, saveCheckpoint: true, renderPreview: false })
  await post('/deepblend/projects', { projectId: 'photography-other', title: 'Other project', sceneSpec, renderPreview: false })
  const initial = read('revisions/r0001/scene-spec.json')
  const before = (await post(`/deepblend/projects/${projectId}/preview`, { revision: 'r0001', mode: 'beauty', views: [{ id: 'selected', cameraId: 'hero', frame: 1 }], samples: 8 })).preview
  json('before-receipt.json', before)
  const beforeArtifact = before.artifacts[0]
  original = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend', beforeArtifact.path].map(file => [file, sha(readFileSync(path(file)))]))
  copyFileSync(path(beforeArtifact.path), join(output, 'before.png'))
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.addInitScript(`window.__photoRequests=[];const original=window.fetch;window.fetch=async(input,init)=>{const entry={url:String(input),method:init?.method||'GET'};if(init?.body)entry.body=JSON.parse(init.body);window.__photoRequests.push(entry);const response=await original(input,init);if(response.headers.get('content-type')?.includes('application/json'))entry.result=await response.clone().json();entry.finished=true;return response}`)
  await page.goto(`${base}/deepblend/workbench`)
  await page.waitFor(`document.querySelector('[data-action="select-project:${projectId}"]')!==null`, 45000)
  const selectProject = async id => {
    await page.click('[data-view-tab="projects"]'); await page.click(`[data-action="select-project:${id}"]`)
    await page.click('[data-view-tab="scene"]')
    await page.waitFor(`document.querySelector('[data-photography-editor="${id}"]')!==null`, 45000)
  }
  await selectProject(projectId)
  const fill = async (key, value) => { await page.fill(field(key), String(value)); await page.waitFor(`document.querySelector(${JSON.stringify(field(key))}).value===${JSON.stringify(String(value))}`) }
  const writes = () => page.evaluate('window.__photoRequests.filter(item=>item.method==="POST")')
  const saved = async revision => page.waitFor(`(()=>{const box=document.querySelector('[data-photography-saved="${revision}"]'),img=box?.querySelector('img');return img?.complete&&img.naturalWidth>0&&!document.querySelector('[data-action="photo-retry"]').disabled})()`, 180000)
  check('saved camera and light values load without an implicit write', await page.evaluate(`document.querySelector(${JSON.stringify(field('camera-lens'))}).value==='60'&&document.querySelector(${JSON.stringify(field('light-energy'))}).value==='0.65'&&document.querySelector('[data-action="photo-save"]').disabled`) && (await writes()).length === 0)
  check('a targeted camera disables rotation that the target would override', await page.evaluate(`document.querySelector(${JSON.stringify(field('camera-rotationEuler-x'))}).disabled`))
  await fill('samples', 8); await fill('light-energy', .9)
  await page.evaluate(`document.querySelector(${JSON.stringify(field('light-size'))}).focus()`); await fill('light-size', .14)
  await page.evaluate(`window.__photoPollInput=document.querySelector(${JSON.stringify(field('light-size'))})`)
  const reads = await page.evaluate('window.__photoRequests.filter(item=>item.method==="GET"&&item.finished&&item.url.includes("/state")).length')
  await page.waitFor(`window.__photoRequests.filter(item=>item.method==='GET'&&item.finished&&item.url.includes('/state')).length>${reads}&&document.querySelector(${JSON.stringify(field('light-size'))})!==window.__photoPollInput`, 20000)
  await page.evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  check('polling retains the typed value and focus', await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(field('light-size'))})&&document.activeElement.value==='0.14'`))
  await selectProject('photography-other')
  check('another project starts from its own saved light', await page.evaluate(`document.querySelector(${JSON.stringify(field('light-energy'))}).value==='0.65'`))
  await selectProject(projectId)
  check('returning to a project retains its unsubmitted photography draft', await page.evaluate(`document.querySelector(${JSON.stringify(field('light-energy'))}).value==='0.9'&&document.querySelector(${JSON.stringify(field('light-size'))}).value==='0.14'`) && (await writes()).length === 0)
  const pointer = await page.click('[data-action="photo-save"]'); await saved('r0002')
  const firstWrites = await writes(), firstPatch = firstWrites[0]?.body.patch, firstPreview = firstWrites[1]?.result?.preview
  check('a real pointer saves one light patch then inspects its exact receipt', pointer.via === 'pointer' && firstWrites.length === 2 && firstPatch.baseRevision === 'r0001' && firstPatch.saveCheckpoint === true && firstPatch.renderPreview === false && isDeepStrictEqual(firstPatch.operations.map(op => op.op), ['light.update']) && firstWrites[1].body.revision === 'r0002' && firstPreview.sourceDigest === firstWrites[0].result.revision.digest)
  const lit = read('revisions/r0002/scene-spec.json'), litArtifact = firstPreview.artifacts[0]
  check('lighting alone preserves authored cameras, objects, materials, assets and references', ['cameras', 'entities', 'materials', 'assets', 'project', 'animationTracks'].every(key => isDeepStrictEqual(lit[key], initial[key])) && isDeepStrictEqual(lit.lights, initial.lights.map(light => light.id === 'key' ? { ...light, energy: .9, size: .14 } : light)))
  check('the actual light comparison uses matching camera, frame and render settings', ['cameraId', 'frame', 'width', 'height', 'samples', 'engine'].every(key => litArtifact[key] === beforeArtifact[key]) && isDeepStrictEqual(litArtifact.cameraFacts, beforeArtifact.cameraFacts) && isDeepStrictEqual(litArtifact.renderConfig, beforeArtifact.renderConfig))
  const a = decodePng(readFileSync(path(beforeArtifact.path))), b = decodePng(readFileSync(path(litArtifact.path)))
  let changed = 0; for (let i = 0; i < a.data.length; i += 4) if ([0, 1, 2].some(c => a.data[i + c] !== b.data[i + c])) changed++
  check('the two saved inspection images have different decoded pixels', a.width === b.width && a.height === b.height && changed > 0, { changedPixels: changed, before: sha(a.data), after: sha(b.data) })
  copyFileSync(path(litArtifact.path), join(output, 'light-after.png')); json('light-receipt.json', firstPreview)
  await fill('camera-lens', 55); await fill('camera-location-x', .185); await fill('camera-targetPoint-z', .06)
  await page.click('[data-action="photo-add-light"]')
  const addedId = await page.evaluate(`document.querySelector(${JSON.stringify(field('light'))}).value`)
  await fill('light-energy', .15); await fill('light-size', .1); await fill('light-color-r', .4)
  for (const [key, value] of [['location-x', .1], ['location-y', -.1], ['location-z', .18], ['rotationEuler-x', 40], ['rotationEuler-z', 25]]) await fill(`light-${key}`, value)
  await page.evaluate(`document.querySelector(${JSON.stringify(field('camera-lens'))}).scrollIntoView({block:'center'})`)
  await page.screenshot(join(output, '01-photography-draft.png'))
  await page.click('[data-action="photo-save"]'); await saved('r0003')
  const finalWrites = await writes(), final = read('revisions/r0003/scene-spec.json'), framedPreview = finalWrites[3].result.preview
  check('camera and new fill light are one saved transaction', finalWrites.length === 4 && isDeepStrictEqual(finalWrites[2].body.patch.operations.map(op => op.op), ['camera.update', 'light.add']) && finalWrites[2].body.patch.baseRevision === 'r0002' && cameraOf(final).lens === 55 && cameraOf(final).transform.location[0] === .185 && cameraOf(final).targetPoint[2] === .06 && final.lights.find(light => light.id === addedId)?.energy === .15 && isDeepStrictEqual(final.lights.find(light => light.id === addedId)?.color, [.4, 1, 1]))
  check('new framing preserves unedited camera fields and the final active-camera choice', final.project.activeCamera === initial.project.activeCamera && ['sensorWidth', 'clipping', 'fStop'].every(key => isDeepStrictEqual(cameraOf(final)[key], cameraOf(initial)[key])) && isDeepStrictEqual(final.cameras.filter(camera => camera.id !== 'hero'), initial.cameras.filter(camera => camera.id !== 'hero')))
  copyFileSync(path(framedPreview.artifacts[0].path), join(output, 'framing-after.png')); json('framing-receipt.json', framedPreview)
  const script = join(output, 'native-readback.py'), nativeFile = join(output, 'native-readback.json')
  const lightingSettingsFile = join(output, 'lighting-control-settings.json')
  const controlNames = ['r0001-control-a', 'r0001-control-b', 'r0002-light-change']
  const controlFiles = controlNames.map(name => join(output, `${name}.png`))
  writeFileSync(script, `import bpy,json,hashlib
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

def digest(value):
 return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def plain(v):
 try:return list(v)
 except TypeError:return v

def inspect(file):
 bpy.ops.wm.open_mainfile(filepath=file)
 bpy.context.view_layer.update()
 scene=bpy.context.scene
 meshes={};cameras={};lights={}
 for obj in scene.objects:
  key=obj.get('deepblend_id',obj.name)
  if obj.type=='MESH':
   m=obj.data
   meshes[key]=digest({'world':[list(r) for r in obj.matrix_world],'vertices':[list(v.co) for v in m.vertices],'faces':[list(p.vertices) for p in m.polygons],'uv':[[list(v.uv) for v in layer.data] for layer in m.uv_layers],'normals':[list(n.vector) for n in m.corner_normals],'slots':[s.material.get('deepblend_id',s.material.name) if s.material else None for s in obj.material_slots]})
  elif obj.type=='CAMERA':
   c=obj.data
   cameras[key]={'location':list(obj.location),'direction':list(obj.matrix_world.to_quaternion()@Vector((0,0,-1))),'lens':c.lens,'sensorWidth':c.sensor_width,'clipping':[c.clip_start,c.clip_end],'dof':c.dof.use_dof,'fStop':c.dof.aperture_fstop}
  elif obj.type=='LIGHT':
   l=obj.data
   lights[key]={'type':l.type,'energy':l.energy,'color':list(l.color),'size':l.size if l.type=='AREA' else None,'location':list(obj.location),'rotation':list(obj.rotation_euler)}
 materials={}
 for m in bpy.data.materials:
  if m.get('deepblend_id'):
   materials[m['deepblend_id']]=digest({'nodes':sorted([{'name':n.name,'type':n.bl_idname,'inputs':[(i.identifier,plain(i.default_value)) for i in n.inputs if hasattr(i,'default_value')]} for n in m.node_tree.nodes],key=lambda n:n['name']),'links':sorted((l.from_node.name,l.from_socket.identifier,l.to_node.name,l.to_socket.identifier) for l in m.node_tree.links)})
 hero=next(o for o in scene.objects if o.type=='CAMERA' and o.get('deepblend_id')=='hero')
 cup=next(o for o in scene.objects if o.get('deepblend_id')=='cup')
 points=[world_to_camera_view(scene,hero,cup.matrix_world@v.co) for v in cup.data.vertices]
 bounds={'x':[min(p.x for p in points),max(p.x for p in points)],'y':[min(p.y for p in points),max(p.y for p in points)],'depthMin':min(p.z for p in points)}
 return {'meshes':meshes,'materials':materials,'cameras':cameras,'lights':lights,'cupProjection':bounds}

# Three bounded independent renders: reopen the unchanged source for both
# controls, then open the lighting-only revision with exactly the same settings.
# Single-thread CPU plus fixed sampling removes device/thread/seed variation.
def render_control(file, output):
 bpy.ops.wm.open_mainfile(filepath=file)
 scene=bpy.context.scene
 scene.frame_set(1)
 hero=next(o for o in scene.objects if o.type=='CAMERA' and o.get('deepblend_id')=='hero')
 scene.camera=hero
 scene.render.engine='CYCLES'
 scene.cycles.device='CPU'
 scene.cycles.samples=8
 scene.cycles.seed=173
 scene.cycles.use_animated_seed=False
 scene.cycles.use_adaptive_sampling=False
 scene.cycles.use_denoising=False
 scene.cycles.time_limit=0
 scene.render.threads_mode='FIXED'
 scene.render.threads=1
 scene.render.resolution_x=160
 scene.render.resolution_y=120
 scene.render.resolution_percentage=100
 scene.render.use_persistent_data=False
 scene.render.use_compositing=False
 scene.render.use_sequencer=False
 scene.render.dither_intensity=0
 scene.render.image_settings.file_format='PNG'
 scene.render.image_settings.color_mode='RGBA'
 scene.render.image_settings.color_depth='8'
 scene.render.filepath=output
 bpy.context.view_layer.update()
 settings={'engine':scene.render.engine,'device':scene.cycles.device,'seed':scene.cycles.seed,'animatedSeed':scene.cycles.use_animated_seed,'samples':scene.cycles.samples,'adaptiveSampling':scene.cycles.use_adaptive_sampling,'denoising':scene.cycles.use_denoising,'timeLimit':scene.cycles.time_limit,'threadsMode':scene.render.threads_mode,'threads':scene.render.threads,'resolution':[scene.render.resolution_x,scene.render.resolution_y],'resolutionPercentage':scene.render.resolution_percentage,'frame':scene.frame_current,'camera':hero.get('deepblend_id'),'cameraMatrix':[list(row) for row in hero.matrix_world],'lens':hero.data.lens,'sensorWidth':hero.data.sensor_width,'clipping':[hero.data.clip_start,hero.data.clip_end],'dof':hero.data.dof.use_dof,'fStop':hero.data.dof.aperture_fstop,'focusDistance':hero.data.dof.focus_distance,'viewTransform':scene.view_settings.view_transform,'look':scene.view_settings.look,'exposure':scene.view_settings.exposure,'gamma':scene.view_settings.gamma,'filmTransparent':scene.render.film_transparent,'dither':scene.render.dither_intensity,'output':[scene.render.image_settings.file_format,scene.render.image_settings.color_mode,scene.render.image_settings.color_depth]}
 bpy.ops.render.render(write_still=True)
 return settings

files=${JSON.stringify(['r0001', 'r0002', 'r0003'].map(revision => path('revisions', revision, 'scene.blend')))}
json.dump([inspect(file) for file in files],open(${JSON.stringify(nativeFile)},'w'),indent=2)
outputs=${JSON.stringify(controlFiles)}
settings=[render_control(files[index],destination) for index,destination in zip([0,0,1],outputs)]
json.dump(settings,open(${JSON.stringify(lightingSettingsFile)},'w'),indent=2)
`)
  writeFileSync(join(output, 'native-readback.log'), execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }))
  const native = JSON.parse(readFileSync(nativeFile)), last = native[2], close = (a, b) => Math.abs(a - b) < 1e-6
  check('independent saved scenes retain exact mesh, UV, normals and material graphs', native.slice(1).every(item => isDeepStrictEqual(item.meshes, native[0].meshes) && isDeepStrictEqual(item.materials, native[0].materials)))
  check('independent scene reopening finds the saved energy, dimensions, camera and new light', close(native[1].lights.key.energy, .9) && close(native[1].lights.key.size, .14) && last.cameras.hero.lens === 55 && last.lights[addedId].type === 'AREA' && close(last.lights[addedId].energy, .15) && close(last.lights[addedId].size, .1) && close(last.lights[addedId].rotation[0], 40 * Math.PI / 180))
  check('native camera position and fill color equal the submitted values',
    last.cameras.hero.location.every((value, index) => close(value, cameraOf(final).transform.location[index]))
    && close(last.cameras.hero.location[0], .185)
    && last.lights[addedId].color.every((value, index) => close(value, [.4, 1, 1][index]))
    && last.lights[addedId].location.every((value, index) => close(value, [.1, -.1, .18][index])))
  check('every reopened scene preserves nondefault camera optics and clipping', native.every(item => item.cameras.hero.dof
    && close(item.cameras.hero.sensorWidth, 42) && close(item.cameras.hero.fStop, 6.3)
    && item.cameras.hero.clipping.every((value, index) => close(value, cameraOf(initial).clipping[index]))))
  const controlSettings = JSON.parse(readFileSync(lightingSettingsFile))
  const controls = controlFiles.map(file => { const bytes = readFileSync(file), decoded = decodePng(bytes); return { bytes, ...decoded } })
  const controlSummaries = controls.map((image, index) => ({ name: controlNames[index], path: controlFiles[index],
    width: image.width, height: image.height, fileSha256: sha(image.bytes), pixelSha256: sha(image.data) }))
  const controlEqual = isDeepStrictEqual(controls[0].data, controls[1].data)
  let controlChanged = 0
  for (let i = 0; i < controls[0].data.length; i += 4) if ([0, 1, 2].some(c => controls[0].data[i + c] !== controls[2].data[i + c])) controlChanged++
  json('lighting-control.json', { settings: controlSettings, images: controlSummaries, unchangedControlEqual: controlEqual, changedPixels: controlChanged })
  check('the three small native controls use identical CPU, seed, camera and sampling settings',
    controlSettings.length === 3 && controlSettings.every(settings => isDeepStrictEqual(settings, controlSettings[0])
      && settings.engine === 'CYCLES' && settings.device === 'CPU' && settings.seed === 173 && settings.animatedSeed === false
      && settings.samples === 8 && settings.threads === 1 && settings.adaptiveSampling === false && settings.denoising === false
      && settings.camera === 'hero' && settings.frame === 1 && isDeepStrictEqual(settings.resolution, [160, 120]))
    && controls.every(image => image.width === 160 && image.height === 120), controlSettings[0])
  check('reopening the same saved scene reproduces identical decoded control pixels', controlEqual, controlSummaries.slice(0, 2))
  check('changing only saved lighting changes pixels beyond the identical control', controlChanged > 0,
    { changedPixels: controlChanged, before: controlSummaries[0], after: controlSummaries[2] })
  const target = cameraOf(final).targetPoint.map((x, i) => x - last.cameras.hero.location[i]), length = Math.hypot(...target)
  check('the saved camera actually aims at the selected coordinate and contains the cup', close(last.cameras.hero.direction.reduce((sum, x, i) => sum + x * target[i] / length, 0), 1) && last.cupProjection.depthMin > 0 && ['x', 'y'].every(axis => last.cupProjection[axis][0] >= 0 && last.cupProjection[axis][1] <= 1), last.cupProjection)
  await page.evaluate(`document.querySelector('[data-photography-artifact]').scrollIntoView({block:'center'})`); await page.screenshot(join(output, '02-saved-photography.png'))
  await page.click('[data-action="photo-restore"]')
  await page.waitFor(`document.querySelector('[data-photography-base="r0002"]')!==null&&!document.querySelector('[data-photography-saved]')`, 45000)
  const restored = (await writes()).at(-1)
  check('restore uses the saved revision condition and returns the actual previous scene', restored.url.endsWith('/restore') && restored.body.revision === 'r0002' && restored.body.expectedCurrentRevision === 'r0003' && read('project.json').currentRevision === 'r0002' && await page.evaluate(`document.querySelector(${JSON.stringify(field('camera-lens'))}).value==='60'&&!Array.from(document.querySelector(${JSON.stringify(field('light'))}).options).some(option=>option.value===${JSON.stringify(addedId)})`))
  await page.reload(); await page.waitFor(`document.querySelector('[data-action="select-project:${projectId}"]')!==null`, 45000); await selectProject(projectId)
  check('refresh reads saved lighting and camera values with no hidden write', await page.evaluate(`document.querySelector(${JSON.stringify(field('light-energy'))}).value==='0.9'&&document.querySelector(${JSON.stringify(field('camera-lens'))}).value==='60'&&document.querySelector('[data-action="photo-save"]').disabled`) && (await writes()).length === 0)
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await page.evaluate(`document.querySelector(${JSON.stringify(field('camera-lens'))}).scrollIntoView({block:'center'})`)
  check('photography inputs remain within a narrow viewport', await page.evaluate(`Array.from(document.querySelectorAll('[data-photography-editor] input,[data-photography-editor] select')).every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`))
  await page.screenshot(join(output, '03-narrow-photography.png'))
  check('old scene bytes, native checkpoint and source inspection stay unchanged', Object.entries(original).every(([file, digest]) => sha(readFileSync(path(file))) === digest))
  json('requests.json', [...finalWrites, restored])
} catch (error) { failure = error.stack || String(error); console.error(error); await page?.screenshot(join(output, 'failure.png')).catch(() => {}) }
finally {
  for (const [name, close] of [['browser', () => browser?.close()], ['server', () => server?.stop()]]) {
    try { const result = await close(); if (name === 'server') shutdown = result } catch (error) { failure ??= String(error) }
  }
  json('report.json', { status: failure ? 'failed' : 'passed', checks, failure, shutdown, original, scope: 'Real Chrome, Host and Blender photography edits, saved source binding, decoded lighting pixels with a fixed CPU/seed repeat control, independent checkpoints and conditional restore. No external artistic approval.' })
}
console.log(`Photography editor: ${checks.filter(check => check.ok).length}/${checks.length} checks passed; ${output}`)
if (failure) process.exitCode = 1
