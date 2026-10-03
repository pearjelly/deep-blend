/** Fixed quality cases and failure-oriented validation, without starting Blender. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { canonicalStringify, compileSceneSpec, createImage, encodePng, validateSceneSpec } from '@deepblend/dsh-blender-contracts'
import {
  BENCHMARK_ROOT, benchmarkRuntimePaths, loadCase, validateCase, validateGeometry,
  hasEvaluatedMotion, hasRenderedMotion,
} from '../../tools/quality-benchmark.mjs'
import { hasPixelMotion, pngFacts, verifyBenchmark } from '../../tools/verify-quality-benchmark.mjs'

const manifest = JSON.parse(readFileSync(join(BENCHMARK_ROOT, 'manifest.json'), 'utf8'))
const fixedIds = ['glass-ceramic', 'metal-lamp', 'modular-speaker']
const freshCase = () => structuredClone(loadCase('glass-ceramic', manifest))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function pngWithFrameMetadata(png, frame) {
  // A valid PNG ancillary text chunk changes artifact bytes without touching IDAT.
  const text = Buffer.from(`Frame\0${frame}`), type = Buffer.from('tEXt')
  let crc = 0xffffffff
  for (const byte of Buffer.concat([type, text])) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const chunk = Buffer.alloc(text.length + 12)
  chunk.writeUInt32BE(text.length, 0); type.copy(chunk, 4); text.copy(chunk, 8)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, text.length + 8)
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
}

function artifactRun(t) {
  // This is a synthetic verifier fixture, not evidence of a Blender render.
  // No motion artifact is declared, so verification never invokes ffprobe.
  const root = mkdtempSync(join(tmpdir(), 'deepblend-artifact-audit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = freshCase(), id = source.entry.id, budget = structuredClone(manifest.tiers.draft)
  const casePath = join(root, id), variantPath = join(casePath, 'candidate')
  const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
  const save = (path, value) => write(path, JSON.stringify(value, null, 2) + '\n')
  const originals = {
    'deepblend/benchmarks/manifest.json': JSON.stringify(manifest, null, 2) + '\n',
    [`deepblend/benchmarks/${id}/scene-spec.json`]: JSON.stringify(source.candidate, null, 2) + '\n',
    [`deepblend/benchmarks/${id}/baseline-scene-spec.json`]: JSON.stringify(source.baseline, null, 2) + '\n',
    [`deepblend/benchmarks/${id}/brief.md`]: source.brief,
    [`deepblend/benchmarks/${id}/geometry-checks.json`]: JSON.stringify(source.geometryChecks, null, 2) + '\n',
  }
  const sourceSnapshot = Object.entries(originals).map(([path, bytes]) => {
    write(join(root, 'source-snapshot', path), bytes)
    return { path, sha256: sha256(bytes) }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const compiled = compileSceneSpec(source.candidate).spec
  save(join(variantPath, 'scene-spec.json'), compiled)
  const checkpoint = Buffer.from('Synthetic checkpoint bytes; this test does not claim a compiled Blender scene.')
  write(join(variantPath, 'scene.blend'), checkpoint)
  const profile = compiled.renderProfiles[budget.profile]
  const config = { engine: 'CYCLES', resolution: budget.resolution, samples: budget.samples,
    viewTransform: profile.colorManagement.viewTransform, exposure: profile.colorManagement.exposure,
    fps: 24, fpsBase: 1, frameStart: 1, frameEnd: 48 }
  const compile = { status: 'success', result: { renderConfig: { ...config, resolution: profile.resolution, samples: profile.samples } } }
  const views = { status: 'success', result: { renderConfig: structuredClone(config) } }
  save(join(variantPath, 'compile.json'), compile)
  const png = encodePng(createImage(...budget.resolution, [130, 110, 85, 255]))
  const images = {}
  for (const [index, view] of ['hero', 'detail', 'reverse'].entries()) {
    const bytes = pngWithFrameMetadata(png, index + 1), path = `${id}/candidate/${view}.png`
    write(join(root, path), bytes)
    images[view] = { ...pngFacts(bytes), path, cameraId: view, frame: 1 }
  }
  const entry = { ...source.entry, status: 'technical-pass', budget,
    inputs: { candidate: sha256(canonicalStringify(source.candidate)), baseline: sha256(canonicalStringify(source.baseline)),
      brief: sha256(source.brief), geometryChecks: sha256(canonicalStringify(source.geometryChecks)) },
    variants: { candidate: { checkpointSha256: sha256(checkpoint), renderConfig: structuredClone(config), images } } }
  const run = { schemaVersion: 'deepblend.benchmark-run/v1', tier: 'draft', status: 'technical-pass-review-required',
    finishedAt: '2026-10-02T00:00:00.000Z', selectedViews: null, cases: [entry],
    manifestSha256: sha256(originals['deepblend/benchmarks/manifest.json']),
    sourceSnapshot, sourceSnapshotSha256: sha256(canonicalStringify(sourceSnapshot)) }
  views.result.views = Object.entries(images).map(([viewId, image]) => ({ viewId, cameraId: image.cameraId, frame: image.frame, width: image.width, height: image.height, bytes: image.bytes }))
  const persist = () => {
    save(join(root, 'run.json'), run); save(join(casePath, 'result.json'), entry)
    save(join(variantPath, 'views.json'), views)
  }
  persist()
  return { root, entry, run, views, variantPath, persist, save }
}

function rejectCase(edit, expected) {
  const loaded = freshCase()
  edit(loaded)
  assert.throws(() => validateCase(loaded, manifest), expected)
}

function checkedGeometry() {
  // Independently specified measured box: dimensions and volume are consistent.
  return {
    checks: { closedEntities: ['shell'], dimensions: [
      { entityId: 'shell', axis: 0, min: 0.199, max: 0.201 },
      { entityId: 'shell', axis: 2, min: 0.099, max: 0.101 },
    ], volumes: [{ entityId: 'shell', min: 0.0023, max: 0.0025 }] },
    geometry: { objects: [{ entityId: 'shell', boundaryEdges: 0, nonManifoldEdges: 0,
      signedVolume: 0.0024, dimensions: [0.2, 0.12, 0.1] }] },
  }
}

function rejectGeometry(edit, expected) {
  const { geometry, checks } = checkedGeometry()
  edit(geometry, checks)
  assert.throws(() => validateGeometry(geometry, checks, 'measured-fixture'), expected)
}

test('the manifest retains all three fixed product categories', () => {
  assert.deepEqual(manifest.cases.map(entry => entry.id).sort(), fixedIds)
  assert.equal(manifest.motion.frameStart, 1)
  assert.equal(manifest.motion.frameEnd, 48)
  assert.equal(manifest.motion.fps, 24)
})

for (const id of fixedIds) {
  test(`${id}: candidate and ablation compile through public contracts without notices`, () => {
    const loaded = loadCase(id, manifest)
    const before = structuredClone(loaded)
    assert.doesNotThrow(() => validateCase(loaded, manifest))
    assert.deepEqual(loaded, before, 'pure validation must not normalize or rewrite the authored inputs')
    for (const [name, spec] of Object.entries({ candidate: loaded.candidate, baseline: loaded.baseline })) {
      const validated = validateSceneSpec(spec)
      assert.equal(validated.ok, true, `${id}/${name}: ${validated.summary}`)
      assert.deepEqual(validated.notices, [], `${id}/${name}: validation notices`)
      const compiled = compileSceneSpec(spec)
      assert.deepEqual(compiled.notices, [], `${id}/${name}: compilation notices`)
      for (const camera of ['hero', 'detail', 'reverse']) assert.ok(compiled.spec.cameras.some(entry => entry.id === camera))
      assert.equal(spec.assets.length, 0, 'the benchmark must rebuild without external assets')
    }
    assert.ok(loaded.geometryChecks.closedEntities.length > 0)
    assert.ok(loaded.geometryChecks.dimensions.length > 0)
  })
}

test('ablation cannot improve its outcome by changing lighting, world, camera or exposure', () => {
  const edits = [
    ['lights', loaded => { loaded.baseline.lights[0].energy += 1 }],
    ['world', loaded => { loaded.baseline.world.strength += 0.05 }],
    ['cameras', loaded => { loaded.baseline.cameras[0].transform.location[0] += 0.02 }],
    ['renderProfiles', loaded => {
      for (const profile of Object.values(loaded.baseline.renderProfiles)) profile.colorManagement.exposure += 0.25
    }],
  ]
  for (const [field, edit] of edits) {
    const loaded = freshCase()
    edit(loaded)
    assert.equal(validateSceneSpec(loaded.baseline).ok, true, `${field} mutation must stay a valid SceneSpec`)
    assert.throws(() => validateCase(loaded, manifest), new RegExp(`baseline ${field} differs`))
  }
})

test('shared product entities cannot move, rotate or change scale in the ablation', () => {
  for (const [component, delta] of [['location', 0.01], ['rotationEuler', 0.1], ['scale', 0.2]]) {
    rejectCase(loaded => {
      const candidate = loaded.candidate.entities.find(entity => entity.tags?.includes('environment') !== true &&
        loaded.baseline.entities.some(other => other.id === entity.id))
      assert.ok(candidate, 'fixture needs a shared product entity')
      const entity = loaded.baseline.entities.find(other => other.id === candidate.id)
      entity.transform ??= {}
      entity.transform[component] = [...(entity.transform[component] ?? (component === 'scale' ? [1, 1, 1] : [0, 0, 0]))]
      entity.transform[component][0] += delta
    }, /baseline transform differs/)
  }
})

test('identical controls and changed animation or shot selection are refused', () => {
  rejectCase(loaded => {
    loaded.baseline.entities = structuredClone(loaded.candidate.entities)
    loaded.baseline.materials = structuredClone(loaded.candidate.materials)
  }, /baseline is identical/)
  rejectCase(loaded => { loaded.baseline.animationTracks[0].keyframes[1].value += 0.001 }, /baseline animationTracks differs/)
  rejectCase(loaded => { loaded.baseline.shots[0].cameraId = 'reverse' }, /baseline shots differs/)
})

test('candidate and baseline obey the same frame, sample and polygon budgets', () => {
  rejectCase(loaded => { loaded.candidate.project.fps = 30 }, /fixed 24 fps/)
  rejectCase(loaded => { loaded.candidate.project.frameEnd = 49 }, /frame range must be 1\.\.48/)
  rejectCase(loaded => { loaded.candidate.renderProfiles.preview.samples += 1 }, /preview differs from the fixed budget/)
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    rejectCase(loaded => { loaded.entry.maxPolygons = value }, /invalid polygon budget/)
  }
})

test('geometry acceptance needs both a nonempty closed list and dimension ranges', () => {
  for (const value of [null, {}, { closedEntities: [], dimensions: [] }]) {
    rejectCase(loaded => { loaded.geometryChecks = value }, /closed geometry and dimension checks are required/)
  }
  rejectCase(loaded => { loaded.geometryChecks.closedEntities = [] }, /closed geometry and dimension checks are required/)
  rejectCase(loaded => { loaded.geometryChecks.dimensions = [] }, /closed geometry and dimension checks are required/)
})

test('every declared closed, dimension and volume check must reference an authored entity', () => {
  rejectCase(loaded => { loaded.geometryChecks.closedEntities.push('missing-subject') }, /unknown geometry check entity/)
  rejectCase(loaded => { loaded.geometryChecks.dimensions[0].entityId = 'missing-subject' }, /unknown geometry check entity/)
  rejectCase(loaded => { loaded.geometryChecks.volumes = [{ entityId: 'missing-subject', min: 0.001, max: 0.002 }] }, /unknown geometry check entity/)
})

test('dimension axes are exactly 0, 1 or 2', () => {
  for (const axis of [-1, 3, 1.5, '0', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    rejectCase(loaded => { loaded.geometryChecks.dimensions[0].axis = axis }, /invalid dimension axis/)
  }
})

test('geometry ranges must be finite, positive and ordered', () => {
  const badRanges = [[0, 1], [-1, 1], [2, 1], [Number.NaN, 1], [1, Number.NaN],
    [Number.NEGATIVE_INFINITY, 1], [1, Number.POSITIVE_INFINITY], ['1', 2]]
  for (const [min, max] of badRanges) {
    for (const field of ['dimensions', 'volumes']) {
      rejectCase(loaded => {
        const entityId = loaded.candidate.entities[0].id
        loaded.geometryChecks[field] = [{ entityId, ...(field === 'dimensions' ? { axis: 0 } : {}), min, max }]
      }, /invalid geometry check range/)
    }
  }
  const exact = freshCase()
  for (const check of exact.geometryChecks.dimensions) check.max = check.min
  for (const check of exact.geometryChecks.volumes ?? []) check.max = check.min
  assert.doesNotThrow(() => validateCase(exact, manifest), 'equal positive limits are a valid exact acceptance interval')
})

test('measured closed geometry within tolerances passes including exact interval endpoints', () => {
  const { geometry, checks } = checkedGeometry()
  assert.doesNotThrow(() => validateGeometry(geometry, checks))
  for (const endpoint of [0.199, 0.201]) {
    geometry.objects[0].dimensions[0] = endpoint
    assert.doesNotThrow(() => validateGeometry(geometry, checks))
  }
})

test('actual open, nonmanifold or nonpositive-volume meshes fail despite valid declarations', () => {
  for (const [field, value] of [['boundaryEdges', 1], ['nonManifoldEdges', 2], ['signedVolume', 0],
    ['signedVolume', -0.0024], ['signedVolume', Number.NaN], ['signedVolume', Number.POSITIVE_INFINITY]]) {
    rejectGeometry(geometry => { geometry.objects[0][field] = value }, /expected closed positive-volume geometry/)
  }
})

test('missing and ambiguous mesh identity cannot silently satisfy geometry checks', () => {
  rejectGeometry(geometry => { geometry.objects = [] }, /requires one mesh for shell/)
  rejectGeometry(geometry => { geometry.objects.push(structuredClone(geometry.objects[0])) }, /requires one mesh for shell/)
  rejectGeometry((_geometry, checks) => { checks.dimensions.push({ entityId: 'missing', axis: 0, min: 0.1, max: 0.2 }) }, /requires one mesh for missing/)
})

test('out-of-range and nonfinite measured dimensions fail rather than passing numeric comparisons', () => {
  for (const measured of [0.198, 0.202, Number.NaN, Number.POSITIVE_INFINITY, undefined, '0.2']) {
    rejectGeometry(geometry => { geometry.objects[0].dimensions[0] = measured }, /dimensions =/)
  }
  rejectGeometry(geometry => { delete geometry.objects[0].dimensions }, /dimensions =/)
  rejectGeometry(geometry => { geometry.objects[0].signedVolume = 0.003 }, /volumes =/)
})

test('evaluated looping motion is detected from the middle pose even when endpoints match', () => {
  const pose = (frame, z) => ({ frame, objects: [{ id: 'button', type: 'MESH',
    matrixWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, z], [0, 0, 0, 1]] }] })
  assert.equal(hasEvaluatedMotion([pose(1, 0.175), pose(24, 0.1743), pose(48, 0.175)]), true)
  assert.equal(hasEvaluatedMotion([pose(1, 0.175), pose(24, 0.175), pose(48, 0.175)]), false)
  assert.equal(hasEvaluatedMotion([pose(1, 0.175)]), false)
  assert.equal(hasEvaluatedMotion([]), false)
  assert.equal(hasEvaluatedMotion(null), false)
})

test('rendered looping motion uses decoded pixel hashes, including the middle frame', () => {
  const first = 'a'.repeat(64), changed = 'b'.repeat(64)
  const frame = (number, pixelSha256) => ({ frame: number, sha256: `artifact-${number}`, pixelSha256 })
  assert.equal(hasRenderedMotion([frame(1, first), frame(24, changed), frame(48, first)]), true)
  assert.equal(hasRenderedMotion([frame(1, first), frame(24, first), frame(48, first)]), false,
    'different PNG artifact hashes caused by frame/time metadata are not visual motion')
  assert.equal(hasRenderedMotion([frame(1, first)]), false)
  assert.equal(hasRenderedMotion([]), false)
  assert.equal(hasRenderedMotion(null), false)
})

test('artifact hashes cannot substitute for missing decoded pixel evidence', () => {
  assert.equal(hasRenderedMotion([{ sha256: 'artifact-one' }, { sha256: 'artifact-two' }]), false)
  for (const missing of [undefined, null, '']) {
    const known = { sha256: 'artifact-one', pixelSha256: 'a'.repeat(64) }
    const absent = { sha256: 'artifact-two', pixelSha256: missing }
    assert.equal(hasRenderedMotion([known, absent]), false)
    assert.equal(hasRenderedMotion([absent, known]), false)
    assert.equal(hasRenderedMotion([known, absent, { pixelSha256: 'b'.repeat(64) }]), false,
      'an incomplete pixel sequence cannot establish valid rendered motion')
  }
})

test('independent artifact audit decodes PNG pixels and leaves run/result evidence unchanged', t => {
  const h = artifactRun(t)
  const runBefore = readFileSync(join(h.root, 'run.json'))
  const resultPath = join(h.root, h.entry.id, 'result.json'), resultBefore = readFileSync(resultPath)
  const report = verifyBenchmark(h.root)
  assert.equal(report.status, 'technical-artifact-pass', JSON.stringify(report.errors))
  assert.deepEqual(report.evidenceLimitations, [])
  const images = Object.values(report.cases[0].variants.candidate.images)
  assert.equal(new Set(images.map(image => image.sha256)).size, 3, 'each PNG contains different Frame metadata')
  assert.equal(new Set(images.map(image => image.pixelSha256)).size, 1)
  assert.equal(images[0].pixelSha256, sha256(Buffer.from(createImage(384, 288, [130, 110, 85, 255]).data)))
  assert.equal(hasPixelMotion(images), false, 'metadata-only differences must not establish motion')
  assert.equal(hasPixelMotion([{ pixelSha256: images[0].pixelSha256 }, { pixelSha256: 'a'.repeat(64) }]), true)
  assert.equal(hasPixelMotion([{ pixelSha256: images[0].pixelSha256 }, { sha256: 'artifact-only' }]), false)
  assert.deepEqual(readFileSync(join(h.root, 'run.json')), runBefore)
  assert.deepEqual(readFileSync(resultPath), resultBefore)
  assert.ok(existsSync(join(h.root, 'artifact-verification.json')))
})

test('independent artifact audit rejects byte changes even when decoded PNG pixels are unchanged', t => {
  const h = artifactRun(t)
  const path = join(h.root, h.entry.variants.candidate.images.hero.path)
  const original = readFileSync(path)
  const metadata = original.indexOf(Buffer.from('Frame\0'))
  assert.ok(metadata > 0)
  // Replace the entire PNG with another valid metadata variant of the same image.
  writeFileSync(path, pngWithFrameMetadata(encodePng(createImage(384, 288, [130, 110, 85, 255])), 9))
  assert.equal(pngFacts(readFileSync(path)).pixelSha256, pngFacts(original).pixelSha256)
  const report = verifyBenchmark(h.root)
  assert.equal(report.status, 'failed')
  assert.ok(report.errors.some(error => /hero.*file SHA256/.test(error)), JSON.stringify(report.errors))
})

for (const [field, value] of [['samples', 8], ['exposure', 1]]) {
  test(`independent artifact audit rejects actual ${field} that disagrees with the saved spec and budget`, t => {
    const h = artifactRun(t)
    // Alter receipt and index together: detecting only their disagreement would miss this.
    h.views.result.renderConfig[field] = value
    h.entry.variants.candidate.renderConfig[field] = value
    h.persist()
    const report = verifyBenchmark(h.root)
    assert.equal(report.status, 'failed')
    assert.ok(report.errors.some(error => error.includes(`actual view receipt ${field}`)), JSON.stringify(report.errors))
    assert.equal(report.errors.some(error => error.includes('persisted renderConfig')), false)
  })
}

test('independent artifact audit rejects an indexed image that is missing on disk', t => {
  const h = artifactRun(t)
  rmSync(join(h.root, h.entry.variants.candidate.images.detail.path))
  const report = verifyBenchmark(h.root)
  assert.equal(report.status, 'failed')
  assert.ok(report.errors.some(error => error.includes('detail.png') && error.includes('ENOENT')), JSON.stringify(report.errors))
})

test('independent artifact audit rejects altered retained source bytes and forged inventories', t => {
  const bytesCase = artifactRun(t)
  const brief = join(bytesCase.root, 'source-snapshot', 'deepblend/benchmarks', bytesCase.entry.id, 'brief.md')
  writeFileSync(brief, readFileSync(brief, 'utf8') + '\nChanged after render.\n')
  const changedBytes = verifyBenchmark(bytesCase.root)
  assert.equal(changedBytes.status, 'failed')
  assert.ok(changedBytes.errors.some(error => /Source snapshot .*brief\.md file SHA256/.test(error)), JSON.stringify(changedBytes.errors))
  const inventoryCase = artifactRun(t)
  inventoryCase.run.sourceSnapshotSha256 = '0'.repeat(64)
  inventoryCase.persist()
  const changedInventory = verifyBenchmark(inventoryCase.root)
  assert.equal(changedInventory.status, 'failed')
  assert.ok(changedInventory.errors.some(error => error.includes('Source snapshot inventory SHA256')), JSON.stringify(changedInventory.errors))
})

test('independent artifact audit binds matching run/result input claims to the retained original', t => {
  const h = artifactRun(t)
  h.entry.inputs.candidate = '0'.repeat(64)
  h.persist()
  const report = verifyBenchmark(h.root)
  assert.equal(report.status, 'failed')
  assert.ok(report.errors.some(error => error.includes('candidate input vs saved original')), JSON.stringify(report.errors))
  assert.equal(report.errors.some(error => error.includes('run/result input hashes')), false,
    'matching false claims in both records must still be checked against retained source bytes')
})

test('independent artifact audit rejects a stored compiled scene that cannot be rebuilt from its original', t => {
  const h = artifactRun(t)
  const path = join(h.variantPath, 'scene-spec.json'), compiled = JSON.parse(readFileSync(path, 'utf8'))
  const material = compiled.materials.find(entry => typeof entry.parameters?.roughness === 'number')
  assert.ok(material)
  material.parameters.roughness = material.parameters.roughness === 0.6 ? 0.5 : 0.6
  assert.equal(validateSceneSpec(compiled).ok, true, 'a valid alternate scene must still fail provenance verification')
  h.save(path, compiled)
  const report = verifyBenchmark(h.root)
  assert.equal(report.status, 'failed')
  assert.ok(report.errors.some(error => error.includes('compiled SceneSpec vs saved original')), JSON.stringify(report.errors))
})

test('Blender and inspection execute retained source copies and refuse a missing capture', t => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-captured-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => benchmarkRuntimePaths(root), /Captured runtime source is missing/)
  const bootstrap = join(root, 'source-snapshot/packages/deepblend/provider-local/python/bootstrap.py')
  const inspector = join(root, 'source-snapshot/deepblend/tools/inspect-benchmark.py')
  for (const path of [bootstrap, inspector]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '# retained source') }
  assert.deepEqual(benchmarkRuntimePaths(root), { bootstrapPath: bootstrap, inspectorPath: inspector })
})

for (const [field, value] of [['cameraId', 'wrong-camera'], ['frame', 9]]) {
  test(`independent artifact audit rejects a different actual per-view ${field}`, t => {
    const h = artifactRun(t)
    h.views.result.views[0][field] = value; h.persist()
    const report = verifyBenchmark(h.root)
    assert.equal(report.status, 'failed')
    assert.ok(report.errors.some(error => /actual (camera|frame)/.test(error)), JSON.stringify(report.errors))
  })
}
