/** Fixed asset preview scenes, compiled in batch mode outside project revisions. */
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, compileSceneSpec, validateSceneSpec, specHash } from '@deepblend/dsh-blender-contracts'
import { defaultSceneSpec } from './revision-transaction.js'
import { ASSET_LIBRARY_LIMITS } from './asset-library.js'
import { readGltfDocument, verifyAssetBundle, verifyUnbundledGltfAsset } from './asset-bundle.js'

export const ASSET_PREVIEW_TEMPLATE = 'deepblend.asset-preview/v1'

function invalid(message, detail) {
  throw new BlenderError(BlenderErrorCode.ASSET_REQUEST_INVALID, message, { detail })
}

function pointLight(id, location, target, energy, size) {
  const d = target.map((value, index) => value - location[index])
  return { id, type: 'area', energy, size, color: [1, 1, 1], transform: { location,
    rotationEuler: [Math.atan2(Math.hypot(d[0], d[1]), -d[2]), 0, Math.atan2(-d[0], d[1])] } }
}

export function assetPreviewScene(asset, { bounds, environment = false, samples = ASSET_LIBRARY_LIMITS.previewSamples } = {}) {
  const spec = defaultSceneSpec({ projectId: 'asset-preview', title: 'Isolated asset preview' })
  spec.project.aspectRatio = '4:3'
  spec.project.activeCamera = 'camera-main'
  spec.assets = [structuredClone(asset)]
  spec.entities = environment ? [
    { id: 'grey-sphere', type: 'generator', generator: { shape: 'uv_sphere', radius: 0.45, segments: 48, ringCount: 24 },
      materialId: 'default-surface', transform: { location: [-0.5, 0, 0.45] } },
    { id: 'metal-sphere', type: 'generator', generator: { shape: 'uv_sphere', radius: 0.45, segments: 48, ringCount: 24 },
      materialId: 'metal-surface', transform: { location: [0.5, 0, 0.45] } },
  ] : [{ id: 'asset-subject', type: 'asset-instance', assetId: asset.id }]
  if (environment) spec.materials.push({ id: 'metal-surface', shader: 'principled',
    parameters: { baseColor: [0.7, 0.7, 0.7, 1], metallic: 1, roughness: 0.12 } })
  const extent = bounds ?? (environment ? { min: [-1, -0.5, 0], max: [1, 0.5, 1] } : { min: [-1, -1, -1], max: [1, 1, 1] })
  const target = extent.min.map((value, i) => (value + extent.max[i]) / 2)
  const radius = Math.max(0.0001, Math.hypot(...extent.min.map((value, i) => extent.max[i] - value)) / 2)
  const camera = spec.cameras[0]
  delete camera.targetEntityId
  camera.targetPoint = target
  camera.clipping = [Math.max(0.00001, radius / 1000), Math.max(1, radius * 40)]
  camera.transform.location = target.map((value, i) => value + [2.6, -3.6, 2.2][i] * radius)
  spec.world = environment ? { color: [1, 1, 1, 1], strength: 1, environment: { assetId: asset.id, rotation: 0 } }
    : { color: [0.18, 0.18, 0.18, 1], strength: 0.35 }
  spec.lights = environment ? [] : [
    pointLight('key-light', target.map((v, i) => v + [2, -3, 4][i] * radius), target, 350 * radius ** 2, 3 * radius),
    pointLight('fill-light', target.map((v, i) => v + [-3, -1, 2][i] * radius), target, 180 * radius ** 2, 4 * radius),
  ]
  const profile = { engine: 'cycles', resolution: [ASSET_LIBRARY_LIMITS.previewWidth, ASSET_LIBRARY_LIMITS.previewHeight],
    samples, maxSamplesBudget: samples, filmTransparent: false, colorManagement: { viewTransform: 'AgX', exposure: 0 } }
  spec.renderProfiles = { preview: profile, final: structuredClone(profile) }
  return spec
}

function modelInspection(report, glb) {
  const objects = (report.objects ?? []).filter(object => object.deepblendId === 'asset-subject')
  const surfaces = objects.filter(object => object.type === 'MESH' && object.renderVisible === true)
  if (!surfaces.length) invalid('The GLB has no visible mesh with measured bounds for an isolated preview.')
  if (surfaces.some(object => !object.worldBounds)) invalid('A renderable part has no evaluated world bounds; the preview cannot frame the complete asset.')
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (const object of surfaces) for (let axis = 0; axis < 3; axis++) {
    const min = object.worldBounds.min?.[axis], max = object.worldBounds.max?.[axis]
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) invalid('The imported model returned invalid world bounds.')
    bounds.min[axis] = Math.min(bounds.min[axis], min); bounds.max[axis] = Math.max(bounds.max[axis], max)
  }
  if (bounds.max.every((value, index) => value === bounds.min[index])) invalid('The model has zero measured size.')
  return { kind: 'model', bounds, dimensions: bounds.max.map((value, index) => value - bounds.min[index]),
    parts: objects.filter(object => typeof object.partId === 'string').map(object => ({
      partId: object.partId, parentPartId: object.parentPartId ?? null, name: object.name, type: object.type,
      worldBounds: object.worldBounds ?? null, boundsFrame: object.boundsFrame,
      renderVisible: object.renderVisible, uvMaps: object.uvMaps ?? [], evaluatedUvMaps: object.evaluatedUvMaps ?? null,
      ...(object.boundsUnavailable ? { boundsUnavailable: object.boundsUnavailable } : {}),
      ...(object.evaluatedUvMapsUnavailable ? { evaluatedUvMapsUnavailable: object.evaluatedUvMapsUnavailable } : {}),
      sourceMaterialSlots: object.sourceMaterialSlots ?? [], materialSlots: object.materialSlots ?? [],
      assetSha256: null, selectorVersion: 1,
    })), warnings: glb.animations ? ['This GLB contains animation. The isolated preview shows frame 1 only.'] : [] }
}

export async function renderAssetPreview({ runtime, asset, directory, maxMeshPolygons, maxPreviewSamples, signal }) {
  const environment = ['hdr', 'exr'].includes(asset.type)
  if (!environment && !['gltf', 'glb'].includes(asset.type)) invalid('This preview supports glTF/GLB models and HDR/EXR environment lighting.')
  let glb = null
  if (!environment) {
    signal?.throwIfAborted()
    verifyAssetBundle(directory, asset)
    verifyUnbundledGltfAsset(directory, asset)
    const { document } = readGltfDocument(join(directory, asset.path), { format: asset.type, signal })
    glb = { animations: document.animations?.length ?? 0, cameras: document.cameras?.length ?? 0,
      lights: document.extensions?.KHR_lights_punctual?.lights?.length ?? 0 }
  }
  if (glb && (glb.cameras || glb.lights)) invalid(
    'This GLB contains cameras or lights. Export a model-only GLB for the current asset library preview; its contents will not be silently removed.')
  const samples = Math.max(1, Math.min(ASSET_LIBRARY_LIMITS.previewSamples, Math.floor(maxPreviewSamples)))
  const checkpointPath = join(directory, 'preview.blend'), sceneSpecPath = join(directory, 'scene-spec.json')
  const compile = async scene => {
    signal?.throwIfAborted()
    const checked = validateSceneSpec(scene)
    if (!checked.ok) throw new BlenderError(BlenderErrorCode.SCENE_SPEC_INVALID,
      'The isolated preview scene is invalid.', { detail: { errors: checked.errors } })
    const compiled = compileSceneSpec(scene).spec
    writeFileSync(sceneSpecPath, JSON.stringify(compiled))
    const result = await runtime.compileScene({ sceneSpecPath, profile: 'preview', projectRoot: directory,
      jobId: `asset-compile-${randomUUID()}`, session: false, signal,
      onWorkingDirectory: info => { copyFileSync(join(info.directory, 'result.blend'), checkpointPath) } })
    if (result.report?.validation?.ok !== true) throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED,
      'The isolated asset failed Blender validation.', { detail: { validation: result.report?.validation ?? null } })
    const polygons = result.report?.sceneFingerprint?.totalPolygons
    if (!Number.isFinite(polygons) || polygons > maxMeshPolygons) throw new BlenderError(BlenderErrorCode.SCENE_TOO_HEAVY,
      'The isolated asset exceeds the mesh budget or has no measured polygon count.', { detail: { polygons, maxMeshPolygons } })
    if (!existsSync(checkpointPath)) throw new BlenderError(BlenderErrorCode.REVISION_CHECKPOINT_MISSING, 'The asset preview produced no checkpoint.')
    return { report: result.report, sceneHash: specHash(compiled) }
  }
  let scene = assetPreviewScene(asset, { environment, samples })
  let compiled = await compile(scene), inspection
  if (environment) {
    const image = compiled.report.world?.environment?.image
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)) invalid('Blender returned no measured environment image dimensions.')
    if (image.width > ASSET_LIBRARY_LIMITS.maxImageEdge || image.height > ASSET_LIBRARY_LIMITS.maxImageEdge
      || image.width * image.height > ASSET_LIBRARY_LIMITS.maxImagePixels) {
      throw new BlenderError(BlenderErrorCode.ASSET_TOO_LARGE, 'The environment image exceeds the library image budget.')
    }
    inspection = { kind: 'environment', image, warnings: ['This is a tone-mapped lighting preview on two spheres, not a full image thumbnail.'] }
  } else {
    inspection = modelInspection(compiled.report, glb)
    for (const part of inspection.parts) part.assetSha256 = asset.sha256
    scene = assetPreviewScene(asset, { bounds: inspection.bounds, samples })
    compiled = await compile(scene)
  }
  signal?.throwIfAborted()
  const outputPath = join(directory, 'preview.png')
  const result = await runtime.renderPreview({ checkpointPath, outputPath, cameraId: 'camera-main', frame: 1,
    width: ASSET_LIBRARY_LIMITS.previewWidth, height: ASSET_LIBRARY_LIMITS.previewHeight,
    samples, engine: 'cycles', session: false, signal, jobId: `asset-render-${randomUUID()}` })
  signal?.throwIfAborted()
  return { inspection, sourceSceneSha256: compiled.sceneHash, template: ASSET_PREVIEW_TEMPLATE,
    preview: { path: outputPath, width: result.report?.width, height: result.report?.height, mime: 'image/png',
      renderConfig: result.report?.renderConfig ?? null, toneMapped: true } }
}
