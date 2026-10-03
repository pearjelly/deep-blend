/** Isolated inspection renders. Successful tasks are published with one directory rename. */
import { createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, BLENDER_ENGINE_BY_KEY, JOB_RECORD_VERSION, compileSceneSpec, sceneSpecDigest,
  sha256, specHash, validateSceneSpec, toCanonicalJobRecord } from '@deepblend/dsh-blender-contracts'
import { streamAsset } from './asset-io.js'
import { stageAssetBundle, assetPreviewVersion, readGltfDocument, verifyAssetBundle, verifyUnbundledGltfAsset } from './asset-bundle.js'
import { fileSha256, fileSize, isFile, readJsonSafe, removeTree, resolveInside, writeJsonAtomic } from './paths.js'

export const DIAGNOSTIC_VERSION = 'deepblend.diagnostic/v1'
export const CLAY_TRANSFORM = Object.freeze({ id: 'opaque-clay', version: 1,
  scope: 'non-environment', baseColor: Object.freeze([.35, .35, .35, 1]), roughness: .62 })
export const DIAGNOSTIC_LIMITS = Object.freeze({ maxViews: 8, maxEdge: 2048, maxPngBytes: 32 * 1024 * 1024 })

function refuse(message, code = BlenderErrorCode.RENDER_RANGE_INVALID) {
  throw new BlenderError(code, message)
}

/** Preserve geometry, animation and lighting declarations; never change the input document. */
export function diagnosticSpec(source, mode) {
  if (!['beauty', 'clay'].includes(mode)) refuse('Inspection mode must be beauty or clay.')
  if (source.entities.some(entity => ['rigidBody', 'cloth', 'softBody', 'fluid'].some(key => entity[key] != null))) {
    refuse('Inspection cannot rebuild cached physics faithfully. Use the existing checkpoint preview for this scene.', BlenderErrorCode.UNSUPPORTED_ACTION)
  }
  const spec = structuredClone(source)
  if (mode === 'clay') {
    const ids = new Set((spec.materials ?? []).map(material => material.id))
    let id = 'inspection-clay', suffix = 1
    while (ids.has(id)) id = `inspection-clay-${suffix++}`
    spec.materials ??= []
    spec.materials.push({ id, shader: 'principled', parameters: {
      baseColor: [...CLAY_TRANSFORM.baseColor], roughness: CLAY_TRANSFORM.roughness,
    } })
    for (const entity of spec.entities) if (entity.type !== 'empty' && !entity.tags?.includes('environment')) {
      entity.materialId = id
      delete entity.materialBindings
    }
  }
  return compileSceneSpec(spec).spec
}

function inspectionPlan(spec, request, maxSamples) {
  const profile = spec.renderProfiles?.preview
  if (!profile) refuse('This revision has no preview render profile.', BlenderErrorCode.RENDER_PROFILE_MISSING)
  const views = request.views
  if (!Array.isArray(views) || views.length < 1 || views.length > DIAGNOSTIC_LIMITS.maxViews) {
    refuse(`An inspection needs 1–${DIAGNOSTIC_LIMITS.maxViews} explicit camera/frame views.`)
  }
  const ids = new Set(), cameras = new Set(spec.cameras.map(camera => camera.id))
  const plan = views.map(view => {
    if (!view || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(view.id ?? '') || ids.has(view.id)) refuse('Inspection view IDs must be unique safe names.')
    ids.add(view.id)
    if (!cameras.has(view.cameraId)) refuse(`Unknown inspection camera: ${view.cameraId}.`)
    if (!Number.isInteger(view.frame) || view.frame < spec.project.frameStart || view.frame > spec.project.frameEnd) {
      refuse(`Inspection frames must be integers from ${spec.project.frameStart} to ${spec.project.frameEnd}.`)
    }
    return { id: view.id, cameraId: view.cameraId, frame: view.frame }
  })
  const width = request.width ?? profile.resolution?.[0], height = request.height ?? profile.resolution?.[1]
  if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= DIAGNOSTIC_LIMITS.maxEdge)) {
    refuse(`Inspection resolution must be between 1 and ${DIAGNOSTIC_LIMITS.maxEdge} pixels per edge.`, BlenderErrorCode.RENDER_BUDGET_EXCEEDED)
  }
  const engine = request.engine ?? profile.engine
  if (!['cycles', 'eevee'].includes(engine)) refuse('Material and clay inspections require a Cycles or EEVEE preview profile.', BlenderErrorCode.UNSUPPORTED_ACTION)
  const samples = request.samples ?? profile.samples ?? 16
  if (!Number.isInteger(samples) || samples < 1) refuse('Inspection samples must be a positive integer.')
  const effectiveSamples = Math.min(samples, maxSamples, profile.maxSamplesBudget ?? maxSamples)
  const warnings = samples > effectiveSamples ? [{ code: 'RENDER_SAMPLES_REDUCED',
    message: `Inspection samples reduced from ${samples} to ${effectiveSamples}.` }] : []
  return { plan, width, height, samples: effectiveSamples, engine, warnings }
}

function finiteArray(values, size) { return Array.isArray(values) && values.length === size && values.every(Number.isFinite) }
function matrixFacts(value) { return Array.isArray(value) && value.length === 4 && value.every(row => finiteArray(row, 4)) }
function dofFacts(value) {
  return value && typeof value.enabled === 'boolean'
    && ['focusDistance', 'apertureFstop', 'apertureBlades', 'apertureRotation', 'apertureRatio'].every(key => Number.isFinite(value[key]))
    && value.focusDistance >= 0 && value.apertureFstop > 0 && value.apertureRatio > 0
    && Number.isInteger(value.apertureBlades) && value.apertureBlades >= 0
    && (value.focusSubtarget === null || typeof value.focusSubtarget === 'string')
    && (value.focusObject === null || typeof value.focusObject?.name === 'string'
      && (value.focusObject.entityId === null || typeof value.focusObject.entityId === 'string') && matrixFacts(value.focusObject.matrixWorld))
}

/** Missing measurements must never be filled with requested settings. */
function verifyFacts(entry, expected, settings) {
  const facts = entry?.cameraFacts, measured = entry?.renderConfig
  if (entry?.viewId !== expected.id || entry.cameraId !== expected.cameraId || entry.frame !== expected.frame
    || entry.width !== settings.width || entry.height !== settings.height
    || !measured || measured.engine !== entry.engine || entry.engine !== BLENDER_ENGINE_BY_KEY[settings.engine] || !finiteArray(measured.resolution, 2)
    || measured.resolution[0] !== entry.width || measured.resolution[1] !== entry.height
    || !Number.isInteger(measured.samples) || measured.samples < 1 || measured.samples > settings.samples
    || measured.resolutionPercentage !== 100 || typeof measured.filmTransparent !== 'boolean'
    || !Number.isFinite(measured.exposure) || typeof measured.viewTransform !== 'string' || typeof measured.look !== 'string'
    || !Number.isFinite(measured.fps) || measured.fps <= 0 || !Number.isInteger(measured.frameStart) || !Number.isInteger(measured.frameEnd)
    || measured.frameStart > entry.frame || measured.frameEnd < entry.frame
    || !facts || facts.frame !== entry.frame || !matrixFacts(facts.matrixWorld) || !['PERSP', 'ORTHO', 'PANO'].includes(facts.type)
    || !['lens', 'orthoScale', 'sensorWidth', 'sensorHeight'].every(key => Number.isFinite(facts[key]) && facts[key] > 0)
    || !['AUTO', 'HORIZONTAL', 'VERTICAL'].includes(facts.sensorFit)
    || !finiteArray(facts.shift, 2) || !finiteArray(facts.clip, 2) || facts.clip[0] <= 0 || facts.clip[1] <= facts.clip[0] || !dofFacts(facts.dof)) {
    refuse(`Inspection view ${expected.id} has missing or inconsistent measured camera/render facts.`, BlenderErrorCode.RENDER_NO_OUTPUT)
  }
}

export function listDiagnostics(store, projectId, revision) {
  const directory = resolveInside(store.projectDirectory(projectId), join(store.revisionDirectory(projectId, revision), 'diagnostics'), 'diagnostics')
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => {
      const path = resolveInside(directory, join(entry.name, 'result.json'), 'diagnostic result')
      const result = readJsonSafe(path)
      return result?.schemaVersion === DIAGNOSTIC_VERSION && result.sourceRevision === revision && Array.isArray(result.artifacts)
        ? result.artifacts : []
    }).sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

export async function renderDiagnostic(host, request) {
  const { store, runtime, config } = host
  const projectId = request.projectId
  if (typeof request.revision !== 'string') refuse('Inspection requires an explicit source revision.')
  store.readRecord(projectId)
  const revision = request.revision, spec = store.readRevisionSpec(projectId, revision)
  const scene = diagnosticSpec(spec, request.mode)
  const checked = validateSceneSpec(scene)
  if (!checked.ok) throw new BlenderError(BlenderErrorCode.SCENE_SPEC_INVALID, checked.summary, { detail: checked.errors })
  const settings = inspectionPlan(spec, request, config.maxPreviewSamples), warnings = [...settings.warnings]
  const project = store.projectDirectory(projectId), revisionDirectory = store.revisionDirectory(projectId, revision)
  // A counter alone can collide across Host instances observing the same store.
  const jobId = `${store.allocateJobId(projectId, 'diagnostic')}-${randomUUID()}`, signal = request.signal
  const scratch = resolveInside(project, `staging/.diagnostic-${jobId}`, 'inspection staging')
  const compileRoot = join(scratch, 'source'), output = join(scratch, 'output')
  const relative = `revisions/${revision}/diagnostics/${jobId}`
  const destination = resolveInside(project, relative, 'inspection publication')
  const startedMs = Date.now(), startedAt = new Date().toISOString()
  const baseJob = { schemaVersion: JOB_RECORD_VERSION, jobId, projectId, action: 'render_views', revision,
    startedAt, idempotencyKey: null, baseRevision: revision, warnings }
  let published = false, complete = false
  const sourceSpecSha256 = fileSha256(join(revisionDirectory, 'scene-spec.json'))
  const sourceCheckpoint = join(revisionDirectory, 'scene.blend')
  const sourceCheckpointSha256 = isFile(sourceCheckpoint) ? fileSha256(sourceCheckpoint) : null
  store.writeJob(projectId, { ...baseJob, status: 'running', errorCode: null, message: null,
    finishedAt: null, durationMs: null, artifacts: [] })
  try {
    signal?.throwIfAborted()
    mkdirSync(compileRoot, { recursive: true }); mkdirSync(output)
    const sourceAssets = []
    const assetPaths = new Map()
    const stagedBundles = new Set()
    for (const asset of spec.assets ?? []) {
      if (typeof asset.path !== 'string' || !asset.path.startsWith('assets/')) {
        refuse('Inspection requires project-local assets under assets/.', BlenderErrorCode.ASSET_REQUEST_INVALID)
      }
      if (!['gltf', 'glb', 'png', 'jpg', 'jpeg', 'hdr', 'exr', 'stl', 'ply'].includes(asset.type)) {
        refuse(`Inspection cannot isolate dependencies of ${asset.type} assets. Use a self-contained GLB or the existing checkpoint preview.`, BlenderErrorCode.UNSUPPORTED_ACTION)
      }
      if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) refuse(`Asset ${asset.id} has no exact SHA-256.`, BlenderErrorCode.ASSET_HASH_MISMATCH)
      const original = resolveInside(project, asset.path, 'inspection source asset')
      const staged = resolveInside(join(compileRoot, 'assets'), join(compileRoot, asset.path), 'inspection copied asset')
      if (!isFile(original)) refuse(`Asset ${asset.id} is missing.`, BlenderErrorCode.ASSET_SOURCE_NOT_FOUND)
      let copied = assetPaths.get(staged)
      if (!copied) {
        const version = assetPreviewVersion(asset)
        let bundled = stagedBundles.has(version)
        if (!bundled) bundled = await stageAssetBundle(project, compileRoot, asset, { maxBytes: config.assetMaxBytes, signal })
        if (bundled) {
          stagedBundles.add(version)
          copied = { sha256: fileSha256(staged), bytes: fileSize(staged) }
        } else {
          mkdirSync(dirname(staged), { recursive: true })
          copied = await streamAsset(createReadStream(original), staged, { maxBytes: config.assetMaxBytes, signal, label: asset.id })
        }
        assetPaths.set(staged, copied)
      }
      if (copied.sha256 !== asset.sha256) refuse(`Asset ${asset.id} no longer matches this revision.`, BlenderErrorCode.ASSET_HASH_MISMATCH)
      verifyAssetBundle(compileRoot, asset)
      // Aliases can share bytes while declaring different types. Copying once
      // must not let an earlier image alias bypass a later GLB dependency check.
      if (['gltf', 'glb'].includes(asset.type)) {
        verifyUnbundledGltfAsset(compileRoot, asset)
        const { document } = readGltfDocument(staged, { format: asset.type, signal })
        if (document.cameras?.length || document.extensions?.KHR_lights_punctual?.lights?.length) refuse('Inspection requires model-only glTF/GLB assets, without embedded cameras or lights.', BlenderErrorCode.UNSUPPORTED_ACTION)
      }
      sourceAssets.push({ id: asset.id, path: asset.path, sha256: copied.sha256, bytes: copied.bytes })
    }
    const sceneSpecPath = join(compileRoot, 'scene-spec.json'), checkpointPath = join(compileRoot, 'derived.blend')
    writeJsonAtomic(sceneSpecPath, scene)
    const compiled = await runtime.compileScene({ sceneSpecPath, projectRoot: compileRoot, profile: 'preview',
      jobId: `${jobId}-compile`, session: false, signal,
      onWorkingDirectory: info => copyFileSync(join(info.directory, 'result.blend'), checkpointPath) })
    signal?.throwIfAborted()
    if (!isFile(checkpointPath)) refuse('Inspection compilation produced no checkpoint.', BlenderErrorCode.REVISION_CHECKPOINT_MISSING)
    if (compiled.report?.validation?.ok !== true) refuse('The derived inspection scene failed Blender validation.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
    const polygons = compiled.report?.sceneFingerprint?.totalPolygons
    if (!Number.isFinite(polygons) || polygons > config.maxMeshPolygons) refuse('The derived scene exceeds the mesh budget or has no measured mesh count.', BlenderErrorCode.SCENE_TOO_HEAVY)
    const run = await runtime.renderViews({ checkpointPath, views: settings.plan, track: [], parts: [],
      engine: settings.engine, width: settings.width, height: settings.height, samples: settings.samples,
      jobId: `${jobId}-render`, session: false, signal })
    signal?.throwIfAborted()
    for (const result of [compiled, run]) warnings.push(...(result.envelope?.warnings ?? []))
    if (!Array.isArray(run.report?.views) || run.report.views.length !== settings.plan.length) {
      refuse('Inspection returned an incomplete view set.', BlenderErrorCode.RENDER_NO_OUTPUT)
    }
    const transform = request.mode === 'clay' ? CLAY_TRANSFORM : { id: 'rebuild-original', version: 1 }
    const sourceDigest = sceneSpecDigest(spec), sourceSpecHash = specHash(spec)
    const at = new Date().toISOString(), artifacts = []
    const { default: sharp } = await import('sharp')
    for (let index = 0; index < settings.plan.length; index++) {
      const expected = settings.plan[index], entry = run.report.views[index]
      verifyFacts(entry, expected, settings)
      const png = run.pngs?.[expected.id]
      if (!Buffer.isBuffer(png) || png.length < 8 || png.length > DIAGNOSTIC_LIMITS.maxPngBytes) {
        refuse('Inspection returned no bounded PNG bytes.', BlenderErrorCode.RENDER_NO_OUTPUT)
      }
      const options = { failOn: 'warning', limitInputPixels: DIAGNOSTIC_LIMITS.maxEdge ** 2 }
      const metadata = await sharp(png, options).metadata()
      if (metadata.format !== 'png' || metadata.width !== entry.width || metadata.height !== entry.height || (metadata.pages ?? 1) !== 1) {
        refuse('Inspection PNG dimensions disagree with the measured report.', BlenderErrorCode.RENDER_NO_OUTPUT)
      }
      await sharp(png, options).raw().toBuffer()
      signal?.throwIfAborted()
      writeFileSync(join(output, `${expected.id}.png`), png, { flag: 'wx' })
      artifacts.push({ kind: 'diagnostic', mode: request.mode, transformationVersion: transform.version,
        sourceRevision: revision, sourceDigest, sourceSpecHash, viewId: expected.id, cameraId: entry.cameraId,
        frame: entry.frame, width: entry.width, height: entry.height, engine: entry.engine,
        samples: entry.renderConfig.samples, renderConfig: entry.renderConfig, cameraFacts: entry.cameraFacts,
        path: `${relative}/${expected.id}.png`, resultPath: `${relative}/result.json`, bytes: png.length,
        sha256: sha256(png), mime: 'image/png', at })
    }
    const result = { schemaVersion: DIAGNOSTIC_VERSION, projectId, revision, sourceRevision: revision, sourceDigest,
      sourceSpecHash, sourceSpecSha256, sourceCheckpointSha256, sourceAssets,
      mode: request.mode, transform, derivedSpecHash: specHash(scene), derivedCheckpointSha256: fileSha256(checkpointPath),
      execution: { transport: 'batch' }, limits: DIAGNOSTIC_LIMITS,
      limitations: request.mode === 'clay' ? [
        'Non-environment surfaces are opaque grey. Transparency, emission, texture, normal and bump appearance are removed.',
        'Rebuilt from SceneSpec; imported shader displacement may change rendered geometry. This is not original-checkpoint equivalence.',
        'A grey render does not prove thickness, watertightness, self-intersection freedom or artistic quality.',
      ] : ['Rebuilt from SceneSpec; this is not a render of the original checkpoint.'],
      artifacts, views: artifacts, at, durationMs: Date.now() - startedMs, warnings }
    writeJsonAtomic(join(output, 'derived-scene-spec.json'), scene)
    writeJsonAtomic(join(output, 'result.json'), result)
    signal?.throwIfAborted()
    store.withProjectWrite(projectId, () => {
      store.readRecord(projectId)
      mkdirSync(dirname(destination), { recursive: true })
      renameSync(output, destination)
      published = true
    })
    const job = store.writeJob(projectId, { ...baseJob, status: 'succeeded', errorCode: null, message: null,
      finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, artifacts })
    complete = true
    return { ...result, job: toCanonicalJobRecord(job) }
  } catch (cause) {
    const failure = host._failedRenderError(signal?.aborted
      ? new BlenderError(BlenderErrorCode.ABORTED, 'Inspection was cancelled.', { cause }) : cause, jobId)
    store.writeJob(projectId, { ...baseJob, status: 'failed', errorCode: failure.code, message: failure.message,
      finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs, artifacts: [] })
    throw failure
  } finally {
    removeTree(scratch)
    if (published && !complete) removeTree(destination)
  }
}
