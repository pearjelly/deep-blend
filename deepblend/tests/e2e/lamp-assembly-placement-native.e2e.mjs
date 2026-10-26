/** Actual complete-lamp pose/settle, independent native oracle, continuation and atomic negative control. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '../../../packages/deepblend/provider-local/lib/index.js'
import Studio, { StudioConfig } from '../../../packages/deepblend/host/lib/index.js'
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(process.env.DEEPBLEND_E2E_ARTIFACTS || join(root, '.deepblend/quality', 'lamp-assembly-placement-' + Date.now()))
if (existsSync(output)) throw Error('Preserve existing native evidence: ' + output)
mkdirSync(output, { recursive: true })
const blender = process.env.DEEPBLEND_BLENDER_PATH || join(root, '.tools/Blender.app/Contents/MacOS/Blender')
const json = (name, value) => { const path = join(output, name); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); return path }
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const checks = [], history = {}, calls = [], startedAt = new Date().toISOString()
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`); if (!ok) throw Error(name) }
const sourcePaths = ['packages/deepblend/contracts/lib/assembly-placement.js', 'packages/deepblend/contracts/lib/lamp-placement.js',
  'packages/deepblend/contracts/lib/recipe-parameters.js', 'packages/deepblend/contracts/lib/surface-placement.js',
  'packages/deepblend/host/lib/assembly-surface-placement.js', 'packages/deepblend/host/lib/surface-placement.js',
  'packages/deepblend/host/lib/index.js', 'packages/deepblend/host/lib/revision-transaction.js',
  'packages/deepblend/provider-local/lib/index.js', 'packages/deepblend/provider-local/python/deepblend_assembly_placement.py',
  'packages/deepblend/provider-local/python/deepblend_surface_placement.py', 'packages/deepblend/provider-local/python/bootstrap.py',
  'packages/deepblend/host/recipes/metal-lamp/recipe.json', 'packages/deepblend/host/recipes/metal-lamp/scene-spec.json',
  'deepblend/tests/lib/inspect-assembly-placement.py', 'deepblend/tests/e2e/lamp-assembly-placement-native.e2e.mjs']
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, hash(join(root, path))]))
json('source-inputs.json', { blender, node: process.version, sourceHashes })
const ctx = new Context(); ctx.plugin(LocalSubprocess)
ctx.plugin(Provider, { blenderPath: blender, bootstrapPath: join(root, 'packages/deepblend/provider-local/python/bootstrap.py'), workspaceRoot: output, timeoutMs: 300000 })
let studio, failure
const cases = [
  { name: 'flat-translation', slope: 0, angle: 0, pivot: [0, 0, 0], offset: [.12, -.08, .2] },
  { name: 'slope-pivot-yaw', slope: .08, angle: 35 * Math.PI / 180, pivot: [.08, -.03, 0], offset: [.2, -.1, .15] },
]
function poseMatrix({ angle, pivot: [x, y], offset: [dx, dy, dz] }) {
  const c = Math.cos(angle), s = Math.sin(angle)
  return [[c, -s, 0, x-c*x+s*y+dx], [s, c, 0, y-s*x-c*y+dy], [0, 0, 1, dz], [0, 0, 0, 1]]
}
function saved(id, label) {
  const revision = studio.store.readRecord(id).currentRevision, directory = studio.store.revisionDirectory(id, revision)
  const entry = { label, id, revision, directory, checkpoint: join(directory, 'scene.blend'), spec: studio.store.readRevisionSpec(id, revision) }
  for (const name of ['scene.blend', 'scene-spec.json', 'recipe-lock.json', 'recipe-parameters.json']) {
    const path = join(directory, name); if (existsSync(path)) history[path] = hash(path)
  }
  return entry
}
async function call(name, input, fn) {
  const start = Date.now()
  try { const value = await fn(); calls.push({ name, input, status: 'succeeded', durationMs: Date.now()-start, value }); json('calls.json', calls); return value }
  catch (error) { calls.push({ name, input, status: 'refused', durationMs: Date.now()-start, error: { code: error.code, message: error.message } }); json('calls.json', calls); throw error }
}
function runPython(label, script, args, timeout = 180000) {
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', ...args],
    { encoding: 'utf8', timeout, maxBuffer: 16*1024*1024 })
  writeFileSync(join(output, label + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  check(label + ' independent Blender exited0', result.status === 0, { status: result.status, error: result.error?.message })
}
function inspect(label, requests) {
  const input = json(label + '-requests.json', requests), path = join(output, label + '.json')
  runPython(label, join(root, 'deepblend/tests/lib/inspect-assembly-placement.py'), [input, path])
  return JSON.parse(readFileSync(path)).records
}
function inspection(entry, ids, fixture, extra = {}) {
  return { label: entry.label, checkpoint: entry.checkpoint, ids, frame: 24, plane: [.08, fixture.slope], ...extra }
}
function protectedBytes() { return Object.entries(history).every(([path, sha256]) => hash(path) === sha256) }
const MUTATE = String.raw`
import bpy,sys,json
from pathlib import Path
checkpoint,settings=sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.open_mainfile(filepath=checkpoint,load_ui=False,use_scripts=False)
old=json.loads(Path(settings).read_text())
obj=bpy.data.objects['db_entity__weighted-base']
obj.location=old['location']; obj.rotation_euler=old['rotationEuler']; obj.scale=old['scale']
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=checkpoint,check_existing=False)
`
try {
  await new Promise(resolve => setTimeout(resolve, 100))
  check('actual source provider is active', Boolean(ctx.get('blenderRuntime')))
  studio = new Studio(ctx, StudioConfig({ workspaceRoot: output, projectsRoot: join(output, 'store'), reconcileOnStart: false, maxPreviewSamples: 32 }))
  const recipe = studio.listRecipes().recipes.find(recipe => recipe.id === 'deepblend.metal-lamp')
  check('current pinned recipe is2.2.0', recipe?.version === '2.2.0')
  async function fixture(id, options, diameter) {
    await call('fixture creation', { id, diameter }, () => studio.createProject({ projectId: id, title: 'Complete lamp native placement',
      recipe: { id: recipe.id, version: recipe.version, digest: recipe.digest, ...(diameter ? { parameters: { 'shade-diameter-mm': diameter } } : {}) }, saveCheckpoint: true, renderPreview: false }))
    const initial = saved(id, id + '-created'), shell = structuredClone(initial.spec.entities.find(entity => entity.id === 'shade-shell').generator)
    shell.segments = 160
    const operations = [
      { op: 'material.parameter.update', materialId: 'champagne-spun', parameter: 'roughness', value: .517 },
      { op: 'entity.generator.set', entityId: 'shade-shell', generator: shell },
      ...initial.spec.animationTracks.filter(track => track.targetKind === 'camera').map(track => ({ op: 'animation.track.remove', trackId: track.id })),
      { op: 'camera.update', cameraId: 'hero', lens: 42 },
      { op: 'entity.add', entity: { id: 'task-ramp', type: 'generator', generator: { shape: 'plane', size: 4 }, materialId: 'dark-bronze',
        transform: { location: [0, 0, .08], rotationEuler: [0, -Math.atan(options.slope), 0] } } },
      { op: 'entity.add', entity: { id: 'unrelated-marker', type: 'generator', generator: { shape: 'cube', size: .03 }, materialId: 'dark-bronze', transform: { location: [-1, 0, .2] } } },
    ]
    await call('fixture preparation', { id, operationCount: operations.length }, () => studio.applyScenePatch({ projectId: id, baseRevision: initial.revision, operations, saveCheckpoint: true, renderPreview: false }))
    return saved(id, id + '-reference')
  }
  for (const options of cases) options.reference = await fixture(options.name, options)
  const reference250 = await fixture('unposed250', cases[1], 250), reference230 = await fixture('unposed230', cases[1], 230)
  const ids = cases[0].reference.spec.entities.filter(entity => !['studio-floor', 'task-ramp', 'unrelated-marker'].includes(entity.id)).map(entity => entity.id).sort()
  check('origin contains all23 named product members including cable', ids.length === 23 && ids.includes('fabric-power-cable') && ids.at(-1) === 'weighted-base')
  const measuredSources = inspect('independent-source-plans', cases.map(options => inspection(options.reference, ids, options, { poseForGapMatrix: poseMatrix(options) })))
  for (const [index, options] of cases.entries()) {
    const facts = measuredSources[index], expected = poseMatrix(options)
    expected[2][3] += .0015-facts.plannedMinimumGapM
    options.expected = expected
    check(options.name + ' actual support matches the independent affine plane', facts.supportPlaneErrorM < 1e-6)
  }
  // Frozen before the public operation; never inferred from the placed anchor/receipt.
  json('independent-expected-world-transforms-before-placement.json', cases.map(options => ({ name: options.name,
    sourceCheckpointSha256: hash(options.reference.checkpoint), expectedMatrix: options.expected, plane: [.08, options.slope] })))
  const results = []
  for (const options of cases) {
    const source = options.reference, request = { projectId: source.id, baseRevision: source.revision, scope: 'recipe-assembly',
      subjectEntityId: 'weighted-base', supportEntityId: 'task-ramp', frame: 24, clearanceMm: 1.5,
      pose: { translationMm: options.offset.map(value => value*1000), yawDegrees: options.angle*180/Math.PI,
        pivotMm: options.pivot.map(value => value*1000) }, renderPreview: false, idempotencyKey: options.name }
    const receipt = await call('complete pose and native settling', request, () => studio.placeOnSurface(request))
    const placed = saved(source.id, options.name + '-placed'); options.placed = placed; options.request = request
    check(options.name + ' single revision contains all23 native verification records', receipt.revision === 'r0003'
      && isDeepStrictEqual(receipt.surfacePlacementReceipt.memberEntityIds, ids) && receipt.surfacePlacementReceipt.after.baselineVerification.members.length === 23)
    const expectedSpec = structuredClone(source.spec)
    for (const entity of placed.spec.entities) if (ids.includes(entity.id)) expectedSpec.entities.find(value => value.id === entity.id).transform = structuredClone(entity.transform)
    check(options.name + ' source fields outside all23 transforms are unchanged', isDeepStrictEqual(expectedSpec, placed.spec))
    const replay = await studio.placeOnSurface(request)
    check(options.name + ' exact replay makes no new revision', replay.idempotentReplay && replay.revision === placed.revision
      && studio.store.readRecord(source.id).currentRevision === placed.revision)
    results.push(inspection(source, ids, options), inspection(placed, ids, options, { reference: source.label, expectedMatrix: options.expected }))
  }
  const slope = cases[1], continued = []
  for (const diameter of [250, 230]) {
    const baseRevision = studio.store.readRecord(slope.reference.id).currentRevision
    const receipt = await call('placed lamp diameter continuation', { diameter, baseRevision }, () => studio.updateRecipeParameters({ projectId: slope.reference.id,
      baseRevision, parameters: { 'shade-diameter-mm': diameter }, saveCheckpoint: true, renderPreview: false, idempotencyKey: 'continue-' + diameter }))
    const entry = saved(slope.reference.id, 'continued-' + diameter), reference = diameter === 250 ? reference250 : reference230
    check(diameter + 'mm continuation retains edited finish and shell segments', entry.spec.materials.find(material => material.id === 'champagne-spun').parameters.roughness === .517
      && entry.spec.entities.find(entity => entity.id === 'shade-shell').generator.segments === 160
      && receipt.parameters.parameters.find(parameter => parameter.id === 'shade-diameter-mm').value === diameter)
    continued.push(entry)
    results.push(inspection(reference, ids, slope), inspection(entry, ids, slope, { reference: reference.label, expectedMatrix: slope.expected }))
  }
  const native = inspect('independent-saved-results', results)
  for (const entry of [cases[0].placed, cases[1].placed, ...continued]) {
    const facts = native.find(record => record.label === entry.label)
    check(entry.label + ' all native vertices/matrices match the independent complete transform', facts.memberCount === 23
      && Object.values(facts.maxVertexErrorsM).every(value => value < 2e-6) && Object.values(facts.maxMatrixErrors).every(value => value < 2e-6),
    { maxVertexErrorM: Math.max(...Object.values(facts.maxVertexErrorsM)) })
    check(entry.label + ' all native local vertices and oriented topology/materials/photography/unrelated objects match',
      facts.allLocalGeometryEqual && facts.allMaterialsEqual && facts.photographyUnchanged && facts.unrelatedUnchanged && facts.checkpointUnchanged)
    check(entry.label + ' every selected native member has the required1.5mm vertical clearance on the finite support',
      Math.abs(facts.minimumWholeLampVerticalGapM-.0015) < 2e-6 && facts.insideSupportXYBounds && facts.supportPlaneErrorM < 1e-6,
    { wholeLampMinimumGapM: facts.minimumWholeLampVerticalGapM, memberMinimumGapsM: facts.memberMinimumVerticalGapsM })
  }
  for (const entry of [cases[0].placed, continued.at(-1)]) {
    const receipt = await call('render saved complete result', { projectId: entry.id, revision: entry.revision }, () => studio.renderPreview({ projectId: entry.id,
      revision: entry.revision, cameraId: 'hero', frame: 24, width: 768, height: 576, samples: 32 }))
    for (const artifact of receipt.artifacts) {
      const path = join(studio.store.projectDirectory(entry.id), artifact.path), bytes = readFileSync(path)
      check(entry.label + ' actual saved preview bytes/source/frame match', hash(path) === artifact.sha256 && artifact.sourceRevision === entry.revision && artifact.frame === 24
        && bytes.subarray(1, 4).toString() === 'PNG' && bytes.readUInt32BE(16) === 768 && bytes.readUInt32BE(20) === 576)
      history[path] = hash(path)
    }
  }

  // Corrupt the actual newly compiled candidate so its final sorted member did
  // not move. The independent native proof must refuse before publication.
  const id = slope.reference.id, beforeNegative = studio.store.readRecord(id), spec = studio.store.readRevisionSpec(id, beforeNegative.currentRevision)
  const runtime = ctx.get('blenderRuntime'), compile = runtime.compileScene.bind(runtime), script = join(output, 'leave-last-member-behind.py')
  writeFileSync(script, MUTATE)
  const settings = json('last-member-old-transform.json', spec.entities.find(entity => entity.id === 'weighted-base').transform)
  let corrupted = false, refused = false
  runtime.compileScene = input => compile({ ...input, onWorkingDirectory: async info => {
    const path = join(info.directory, 'result.blend')
    runPython('negative-candidate-mutation', script, [path, settings])
    copyFileSync(path, join(output, 'negative-last-member-candidate.blend')); corrupted = true
    await input.onWorkingDirectory?.(info)
  } })
  try {
    await call('negative actual last member left behind', { baseRevision: beforeNegative.currentRevision }, () => studio.placeOnSurface({
      projectId: id, baseRevision: beforeNegative.currentRevision, scope: 'recipe-assembly', subjectEntityId: 'weighted-base', supportEntityId: 'task-ramp',
      frame: 24, clearanceMm: 1.5, pose: { translationMm: [25, 0, 0], yawDegrees: 10 }, renderPreview: false, idempotencyKey: 'native-last-member-negative' }))
  } catch (error) { refused = error.code === 'SCENE_VALIDATION_FAILED'; json('negative-last-member-refusal.json', { code: error.code, message: error.message }) }
  finally { runtime.compileScene = compile }
  check('actual last-member candidate mutation was exercised and atomically refused', corrupted && refused)
  check('failed candidate retains exact current record and publishes no revision/staging remnants', isDeepStrictEqual(studio.store.readRecord(id), beforeNegative)
    && !existsSync(studio.store.revisionDirectory(id, 'r0006')) && readdirSync(join(studio.store.projectDirectory(id), 'staging')).length === 0
    && !readdirSync(studio.store.projectDirectory(id)).some(name => name.startsWith('.surface-placement-')))
  check('all saved source/native/recipe/state/preview bytes remain unchanged', protectedBytes())
  check('all core and independent oracle source bytes stayed unchanged during this actual run', Object.entries(sourceHashes).every(([path, sha256]) => hash(join(root, path)) === sha256))
  json('history-source-protection.json', history)
} catch (error) { failure = { message: error.message, code: error.code, stack: error.stack }; console.error(error) }
finally {
  try { await ctx.fiber.dispose() } catch (error) { failure ??= { message: error.message } }
  json('summary.json', { startedAt, finishedAt: new Date().toISOString(), checks, failure,
    scope: 'Actual public Host operations and independent native complete-lamp geometry on two authored supports. Maintainer fixture tests, not an LLM run or artistic/manufacturing certification.' })
  if (failure) process.exitCode = 1
}
