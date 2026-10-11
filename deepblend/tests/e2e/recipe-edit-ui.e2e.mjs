#!/usr/bin/env node
/** Existing assembly edits through the real DSH workbench and saved Blender files. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { Browser } from '../../tools/browser-driver.mjs'
import { REPO_ROOT, startWeb, storePatch } from '../../tools/dsh-web-harness.mjs'

const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(REPO_ROOT, '.deepblend', 'quality', `recipe-edit-${Date.now()}`))
if (existsSync(output)) throw Error('Use a fresh evidence directory')
mkdirSync(output, { recursive: true })
const store = join(output, 'store'), id = 'existing-speaker', checks = []
const file = (...parts) => join(store, 'projects', id, ...parts)
const read = (...parts) => JSON.parse(readFileSync(file(...parts)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
function check(name, ok, detail) {
  checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) throw Error(name)
}
let server, browser, page, failure, protectedFiles
const blender = process.env.DEEPBLEND_BLENDER_PATH || join(REPO_ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
async function saved(revision) {
  await page.waitFor(`Array.from(document.querySelectorAll('[data-view="preview"] img[data-artifact]')).some(image => image.src.includes('/${id}/revisions/${revision}/'))`, 180000)
  check(`${revision}: Host current pointer matches the actual rendered revision`, read('project.json').currentRevision === revision)
  const manifest = read('revisions', revision, 'revision-manifest.json'), preview = manifest.previews.at(-1)
  const bytes = readFileSync(file(preview.path)), pixels = decodePng(bytes)
  check(`${revision}: saved preview is a decoded image bound to the committed source`, preview.sourceRevision === revision
    && preview.sourceDigest === manifest.digest && preview.sha256 === sha(bytes) && pixels.data.length === preview.width * preview.height * 4)
  copyFileSync(file(preview.path), join(output, `${revision}.png`))
  return manifest
}
async function controls(revision) {
  await page.click('[data-view-tab="scene"]')
  await page.waitFor(`document.querySelector('[data-assembly-base-revision="${revision}"]') !== null`, 30000)
}
async function resize(revision, values) {
  await controls(revision)
  for (const [key, value] of Object.entries(values)) await page.fill(`[data-field="assembly-${key}"]`, String(value))
  const click = await page.click('[data-action="assembly-save"]')
  check(`${revision}: assembly save uses a real pointer action`, click.via === 'pointer')
}

try {
  const rows = JSON.parse(await storePatch(store))
  rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = blender
  rows.find(row => row.id === 'deepblend-blender-host').config.maxPreviewSamples = 8
  server = await startWeb({ workspacePath: REPO_ROOT, patch: JSON.stringify(rows) })
  const base = `http://127.0.0.1:${server.port}`
  browser = await Browser.launch({ args: ['--window-size=1440,1100'] }); page = await browser.newPage()
  await page.addInitScript(`window.__writes=JSON.parse(sessionStorage.getItem('deepblend-test-writes')||'[]');const original=window.fetch;window.fetch=(url,init)=>{if(init?.method==='POST'){window.__writes.push({url:String(url),body:JSON.parse(init.body)});sessionStorage.setItem('deepblend-test-writes',JSON.stringify(window.__writes))}return original(url,init)}`)
  await page.goto(base + '/deepblend/workbench')
  await page.waitFor('document.querySelector(\'[data-action="select-recipe:deepblend.modular-speaker@2.0.0"]\')!==null', 45000)
  await page.click('[data-action="select-recipe:deepblend.modular-speaker@2.0.0"]')
  await page.fill('[data-field="project-title"]', id)
  await page.click('[data-action="create-project"]')
  const first = await saved('r0001')
  protectedFiles = Object.fromEntries(['revisions/r0001/scene-spec.json', 'revisions/r0001/scene.blend',
    'revisions/r0001/recipe-lock.json', first.previews.at(-1).path].map(path => [path, sha(readFileSync(file(path)))]))
  await controls('r0001')
  check('the existing project shows its three saved millimetre values', await page.evaluate(`['cabinet-width-mm','cabinet-depth-mm','cabinet-height-mm'].every((key,i)=>Number(document.querySelector('[data-field="assembly-'+key+'"]').value)===[264,138,162][i])`))
  await page.fill('[data-field="assembly-cabinet-width-mm"]', '999')
  check('invalid existing dimensions block writes', await page.evaluate('document.querySelector(\'[data-action="assembly-save"]\').disabled && window.__writes.filter(row=>row.url.endsWith("/recipe-parameters")).length===0'))
  await resize('r0001', { 'cabinet-width-mm': 300 })
  const second = await saved('r0002')
  const state = read('revisions/r0002/recipe-parameters.json')
  check('dimensions are saved on the same project with an immutable origin', state.values['cabinet-width-mm'] === 300
    && state.originRevision === 'r0001' && second.baseRevision === 'r0001' && Boolean(second.recipeParameters))
  check('every original project artifact stays byte-identical', Object.entries(protectedFiles).every(([path, digest]) => sha(readFileSync(file(path))) === digest))

  // Independent customizations are fixture preparation through real Host HTTP,
  // not a claim that these preparation operations were made with GUI controls.
  const spec = read('revisions/r0002/scene-spec.json'), shell = spec.entities.find(entity => entity.id === 'cabinet-shell')
  const generator = structuredClone(shell.generator); generator.bevel.segments = 7
  const edited = await fetch(base + `/deepblend/projects/${id}/patch`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { baseRevision: 'r0002', saveCheckpoint: true, operations: [
      { op: 'material.parameter.update', materialId: shell.materialId, parameter: 'roughness', value: .42 },
      { op: 'entity.generator.set', entityId: shell.id, generator }, { op: 'camera.update', cameraId: 'hero', lens: 58 },
    ] } }) }).then(response => response.json())
  check('real Host customization fixture creates a separate revision', edited.ok && edited.revision.revision === 'r0003')
  const custom = read('revisions/r0003/scene-spec.json')
  await page.reload(); await controls('r0003')
  check('ordinary edits inherit the prior assembly dimensions', Number(await page.evaluate('document.querySelector(\'[data-field="assembly-cabinet-width-mm"]\').value')) === 300)
  await resize('r0003', { 'cabinet-width-mm': 340, 'cabinet-height-mm': 200 })
  await saved('r0004')
  const resized = read('revisions/r0004/scene-spec.json')
  check('resizing keeps independent material, bevel and photography edits', JSON.stringify(resized.materials) === JSON.stringify(custom.materials)
    && JSON.stringify(resized.cameras.find(camera => camera.id === 'hero')) === JSON.stringify(custom.cameras.find(camera => camera.id === 'hero'))
    && JSON.stringify(resized.entities.find(entity => entity.id === shell.id).generator.bevel) === JSON.stringify(generator.bevel))
  await page.reload(); await controls('r0004')
  check('refresh reads actual saved parameters', Number(await page.evaluate('document.querySelector(\'[data-field="assembly-cabinet-height-mm"]\').value')) === 200)
  const restored = await fetch(base + `/deepblend/projects/${id}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 'r0001', expectedCurrentRevision: 'r0004' }) }).then(response => response.json())
  check('conditional restoration selects original scene without deleting the resized history', restored.ok && read('project.json').currentRevision === 'r0001' && existsSync(file('revisions/r0004/scene.blend')))
  await page.reload(); await controls('r0001')
  check('restoration also restores the original controls', Number(await page.evaluate('document.querySelector(\'[data-field="assembly-cabinet-width-mm"]\').value')) === 264)
  check('restoration still protects all original bytes', Object.entries(protectedFiles).every(([path, digest]) => sha(readFileSync(file(path))) === digest))
  const writes = await page.evaluate('window.__writes'); json('ui-requests.json', writes)
  check('only one project was created; two edits used the semantic save route', writes.filter(row => row.url === '/deepblend/projects').length === 1
    && writes.filter(row => row.url.endsWith('/recipe-parameters')).length === 2)
  await page.screenshot(join(output, 'restored-controls.png'))

  const script = join(output, 'readback.py'), receipt = join(output, 'native-readback.json')
  const paths = ['r0001', 'r0002', 'r0004'].map(revision => ({ revision, path: file('revisions', revision, 'scene.blend'), specPath: file('revisions', revision, 'scene-spec.json') }))
  writeFileSync(script, `import bpy,json\nfrom mathutils import Matrix\nrows=[]\nfor item in ${JSON.stringify(paths)}:\n bpy.ops.wm.open_mainfile(filepath=item['path']);bpy.context.scene.frame_set(1);bpy.context.view_layer.update();dg=bpy.context.evaluated_depsgraph_get()\n def bounds(id):\n  o=bpy.data.objects['db_entity__'+id];e=o.evaluated_get(dg);m=e.to_mesh();t=Matrix.LocRotScale(o.location,o.rotation_euler.to_quaternion(),o.scale) if o.hide_viewport else e.matrix_world\n  try:\n   p=[t@v.co for v in m.vertices];return [[min(v[i] for v in p),max(v[i] for v in p)] for i in range(3)]\n  finally:e.to_mesh_clear()\n shell=bounds('cabinet-shell');cavity=bounds('shell-cavity-tool');o=bpy.data.objects['db_entity__cabinet-shell'];mat=o.data.materials[0];bsdf=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED')\n rows.append({'revision':item['revision'],'dimensions':[b-a for a,b in shell],'gap':[((shell[i][1]-shell[i][0])-(cavity[i][1]-cavity[i][0]))/2 for i in range(3)],'bottomZ':shell[2][0],'entities':len([o for o in bpy.data.objects if o.name.startswith('db_entity__')]),'roughness':bsdf.inputs['Roughness'].default_value,'lens':bpy.data.objects['db_camera__hero'].data.lens,'baseMeshFaces':len(o.data.polygons)})\n spec=json.load(open(item['specPath']));gen=next(e['generator'] for e in spec['entities'] if e['id']=='cabinet-shell');actualVertices=[tuple(v.co) for v in o.data.vertices];actualFaces=[tuple(p.vertices) for p in o.data.polygons]\n bpy.ops.mesh.primitive_cube_add(size=1);expected=bpy.context.object\n for v in expected.data.vertices:\n  for axis in range(3):v.co[axis]*=gen['dimensions'][axis]\n expected.data.update();m=expected.modifiers.new(name='independent-bevel',type='BEVEL');m.width=gen['bevel']['width'];m.segments=gen['bevel']['segments'];m.limit_method='ANGLE';m.angle_limit=0.5235987755982988;m.use_clamp_overlap=True;bpy.ops.object.modifier_apply(modifier=m.name)\n expected.matrix_world=o.matrix_world.copy()\n for entry in next(e['modifiers'] for e in spec['entities'] if e['id']=='cabinet-shell'):\n  target=bpy.data.objects['db_entity__'+entry['targetEntityId']];target.matrix_world=Matrix.LocRotScale(target.location,target.rotation_euler.to_quaternion(),target.scale);m=expected.modifiers.new(name='independent-cut',type='BOOLEAN');m.operation=entry['operation'].upper();m.solver='EXACT';m.object=target;bpy.ops.object.modifier_apply(modifier=m.name)\n rows[-1]['independentBevelMeshMatches']=len(actualVertices)==len(expected.data.vertices) and actualFaces==[tuple(p.vertices) for p in expected.data.polygons] and all(abs(a[i]-b.co[i])<1e-7 for a,b in zip(actualVertices,expected.data.vertices) for i in range(3))\njson.dump(rows,open(${JSON.stringify(receipt)},'w'))\n`)
  writeFileSync(join(output, 'native-readback.log'), execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }))
  const native = JSON.parse(readFileSync(receipt))
  native.forEach((row, i) => check(`${row.revision}: independent native reopening confirms dimensions, complete assembly and flat gaps`,
    row.entities === 111 && row.dimensions.every((value, axis) => Math.abs(value - [[.264,.138,.162],[.3,.138,.162],[.34,.138,.2]][i][axis]) < 1e-6)
      && row.gap.every((value, axis) => Math.abs(value - [.009,.0115,.009][axis]) < 1e-6) && Math.abs(row.bottomZ - .014) < 1e-6, row))
  check('native resized checkpoint retains customized material, camera and bevel', Math.abs(native[2].roughness - .42) < 1e-6 && native[2].lens === 58 && native.every(row => row.independentBevelMeshMatches) && native[2].baseMeshFaces < native[1].baseMeshFaces)
} catch (error) {
  failure = error.stack || String(error); console.error(error)
  if (page) json('failure-ui.json', await page.evaluate(`({writes:window.__writes ?? [],
    notices:Array.from(document.querySelectorAll('[data-result]')).map(node=>({kind:node.dataset.result,text:node.textContent})),
    images:Array.from(document.querySelectorAll('img[data-artifact]')).map(image=>image.src)})`).catch(error => ({ error: String(error) })))
  await page?.screenshot(join(output, 'failure.png')).catch(() => {})
} finally {
  await browser?.close().catch(() => {})
  await server?.stop().catch(error => { failure ??= String(error) })
  json('report.json', { status: failure ? 'failed' : 'passed', checks, failure, protectedFiles,
    scope: 'Existing project saves through real browser, DSH Host and Blender, source/history protection and independent native reopening. Customization/restore fixture calls are Host HTTP; no live LLM or minimum-wall/artistic certification claim.' })
}
console.log(`Recipe edit UI: ${checks.filter(check => check.ok).length}/${checks.length}; ${output}`)
if (failure) process.exitCode = 1
