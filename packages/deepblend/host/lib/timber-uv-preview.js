import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPatchToSpec, BlenderError, BlenderErrorCode, compileSceneSpec, sceneSpecCanonicalText,
  sceneSpecDigest, sha256, specHash, validateScenePatch, validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'
import { diagnosticSpec } from './diagnostic-preview.js'
import { fileSize, isFile, removeTree, resolveInside, writeFileAtomic } from './paths.js'
import { assertRuntimeSceneFeatures } from './runtime-scene-features.js'

const maxEdge = 720
const maxImageBytes = 3 * 1024 * 1024
const activePreviews = new WeakSet()

function verifyPair(spec, operations) {
  const projections = operations.filter(operation => operation.op === 'entity.uv.project')
  const ids = new Set(projections.map(operation => operation.entityId))
  const [first, second] = projections
  const paired = projections.length === 2 && ids.size === 2 && spec.halfLaps?.some(joint =>
    ids.has(joint.lowerEntityId) && ids.has(joint.upperEntityId))
  if (!paired || (first.quarterTurns ?? 0) !== (second.quarterTurns ?? 0) || (first.scale ?? 1) !== (second.scale ?? 1)) {
    throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, 'Choose both members of one saved timber joint and use the same UV settings.')
  }
  return [...ids]
}

export async function previewTimberUv(host, { patch, expectedDigest, expectedStoreIdentity, cameraId, signal: callerSignal }) {
  const { config, runtime, store, transactions } = host
  if (!host.timberUvPreviewSupported) {
    throw new BlenderError(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'The current Blender runtime does not support timber UV previews.')
  }
  if (activePreviews.has(host)) {
    throw new BlenderError(BlenderErrorCode.REVISION_CONFLICT, 'Another timber UV preview is rendering.')
  }
  const checked = validateScenePatch(patch)
  if (!checked.ok) throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, checked.summary)
  const { projectId, baseRevision } = patch
  const timeout = AbortSignal.timeout(60_000)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
  const cancelled = () => new BlenderError(BlenderErrorCode.ABORTED, 'The timber UV preview was cancelled or timed out.')
  const conflict = () => new BlenderError(BlenderErrorCode.REVISION_CONFLICT, 'The saved scene changed. Refresh before previewing the texture.')
  const ensureCurrent = () => {
    if (signal.aborted) throw cancelled()
    if (!/^[a-f0-9]{64}$/.test(expectedStoreIdentity ?? '') || expectedStoreIdentity !== host.editableSnapshots.storeIdentity
      || store.currentRevision(projectId) !== baseRevision) throw conflict()
  }

  ensureCurrent()
  const source = store.readRevisionSpec(projectId, baseRevision)
  const baseHash = specHash(source)
  if (sceneSpecDigest(source) !== expectedDigest) throw conflict()
  const entities = verifyPair(source, patch.operations)
  if (!source.cameras.some(camera => camera.id === cameraId)) {
    throw new BlenderError(BlenderErrorCode.SCENE_CAMERA_MISSING, 'Choose a camera from the saved scene.')
  }
  const applied = applyPatchToSpec(compileSceneSpec(source).spec, patch)
  const candidate = diagnosticSpec(applied.spec, 'beauty')
  const validation = validateSceneSpec(candidate)
  if (!validation.ok) throw new BlenderError(BlenderErrorCode.SCENE_SPEC_INVALID, validation.summary)
  const profile = candidate.renderProfiles?.preview
  if (!profile) throw new BlenderError(BlenderErrorCode.RENDER_PROFILE_MISSING, 'This scene has no preview render profile.')
  const [sourceWidth, sourceHeight] = profile.resolution
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight))
  const resolution = [sourceWidth, sourceHeight].map(edge => Math.max(1, Math.round(edge * scale)))
  const renderSpec = { ...candidate, renderProfiles: { ...candidate.renderProfiles,
    preview: { ...profile, resolution, samples: Math.min(profile.samples ?? 24, 24) } } }
  const frame = source.project.frameStart
  const candidateSpecHash = specHash(candidate)
  let scratch
  activePreviews.add(host)
  try {
    transactions.verifyPatchAssets(projectId, candidate)
    const parent = resolveInside(store.workspaceRoot, 'tmp', 'timber UV preview scratch')
    mkdirSync(parent, { recursive: true })
    scratch = mkdtempSync(join(parent, 'timber-uv-'))
    const sceneSpecPath = join(scratch, 'scene-spec.json')
    const checkpointPath = join(scratch, 'draft.blend')
    writeFileAtomic(sceneSpecPath, sceneSpecCanonicalText(candidate))
    const featureCheck = assertRuntimeSceneFeatures(runtime, candidate, { signal })
    if (featureCheck) await featureCheck
    const projectRoot = store.projectDirectory(projectId)
    const compiled = await runtime.compileScene({ sceneSpecPath, projectRoot, profile: 'preview', session: false, signal,
      onWorkingDirectory: ({ directory }) => copyFileSync(join(directory, 'result.blend'), checkpointPath) })
    ensureCurrent()
    if (compiled.report?.validation?.ok !== true || !isFile(checkpointPath)) {
      throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'Blender could not compile this texture draft.')
    }
    const polygons = compiled.report.sceneFingerprint?.totalPolygons
    if (!Number.isSafeInteger(polygons) || polygons < 0 || polygons > config.maxMeshPolygons) {
      throw new BlenderError(BlenderErrorCode.SCENE_TOO_HEAVY, 'The texture draft exceeds the preview mesh budget or has no measured mesh count.')
    }
    const { artifact } = await transactions.renderPreviewInto({ projectId, revision: baseRevision,
      staging: scratch, spec: renderSpec, checkpointPath, cameraId, frame, session: false, signal })
    const path = join(scratch, 'previews', `${cameraId}.png`)
    const bytes = fileSize(path)
    const badImage = () => new BlenderError(BlenderErrorCode.RENDER_NO_OUTPUT, 'Blender returned an invalid texture preview image.')
    if (!bytes || bytes > maxImageBytes || bytes !== artifact.bytes
      || resolution[0] !== artifact.width || resolution[1] !== artifact.height
      || !Number.isInteger(artifact.samples) || artifact.samples < 1 || artifact.samples > renderSpec.renderProfiles.preview.samples) throw badImage()
    const png = readFileSync(path)
    if (sha256(png) !== artifact.sha256) throw badImage()
    const { default: sharp } = await import('sharp')
    const image = sharp(png, { failOn: 'warning', limitInputPixels: maxEdge ** 2 })
    const measured = await image.metadata()
    if (measured.format !== 'png' || measured.width !== artifact.width || measured.height !== artifact.height) throw badImage()
    await image.raw().toBuffer()
    ensureCurrent()
    if (specHash(store.readRevisionSpec(projectId, baseRevision)) !== baseHash) throw conflict()
    transactions.verifyPatchAssets(projectId, candidate)
    return { schemaVersion: 'deepblend.timber-uv-preview/v1', projectId, baseRevision, baseDigest: expectedDigest,
      storeIdentity: expectedStoreIdentity, candidateSpecHash, entities, cameraId, frame,
      image: { width: artifact.width, height: artifact.height, samples: artifact.samples, engine: artifact.engine,
        sha256: artifact.sha256, pngBase64: png.toString('base64') } }
  } catch (error) {
    if (signal.aborted) throw cancelled()
    throw error
  } finally {
    activePreviews.delete(host)
    if (scratch) removeTree(scratch)
  }
}
