import { mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, sceneSpecDigest, specHash, validateGeometrySelection,
  verifyGeometryReport, GEOMETRY_INSPECTION_LIMITS } from '@deepblend/dsh-blender-contracts'
import { fileSha256, fileSize, isFile, resolveInside, removeTree } from './paths.js'
import { verifyAssetBundle, verifyUnbundledGltfAsset, verifyUnbundledObjAsset } from './asset-bundle.js'

function refuse(code, message) { throw new BlenderError(code, `Native geometry inspection: ${message}`) }
function cancelled(signal) {
  if (signal?.aborted) refuse(BlenderErrorCode.ABORTED, 'cancelled; the saved source was not changed.')
}

/** Native values are bound to an immutable revision, never inferred from generator declarations. */
export async function inspectRevisionGeometry(host, projectId, revision, selection, signal) {
  const store = host.store, spec = store.readRevisionSpec(projectId, revision)
  const manifest = store.readRevisionManifest(projectId, revision), digest = sceneSpecDigest(spec)
  const project = store.projectDirectory(projectId), directory = store.revisionDirectory(projectId, revision)
  const checkpoint = resolveInside(project, `revisions/${revision}/scene.blend`, 'inspection checkpoint')
  cancelled(signal)
  // Validate selection even if the historical checkpoint has no hash evidence.
  validateGeometrySelection({ ...selection, checkpointSha256: '0'.repeat(64) })
  if (selection.entityIds.some(id => !(spec.entities ?? []).some(entity => entity.id === id))) refuse(BlenderErrorCode.SCENE_SPEC_INVALID, 'one or more selected entities do not exist in this revision.')
  if (selection.cameraId !== undefined && !(spec.cameras ?? []).some(camera => camera.id === selection.cameraId)) refuse(BlenderErrorCode.SCENE_SPEC_INVALID, 'framing camera does not exist in this saved revision.')
  if (selection.assetInstanceIds?.some(id => !spec.entities.some(entity => entity.id === id && entity.type === 'asset-instance'))) refuse(BlenderErrorCode.SCENE_SPEC_INVALID, 'aggregate bounds require selected asset-instance entities from this saved revision.')
  if (manifest?.projectId !== projectId || manifest.revision !== revision || manifest.digest !== digest || manifest.specHashAfter !== specHash(spec)) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the revision manifest no longer matches its saved scene.')
  if (!isFile(checkpoint)) refuse(BlenderErrorCode.REVISION_CHECKPOINT_MISSING, 'this revision has no native checkpoint; save a checkpoint before measuring.')
  if (fileSize(checkpoint) > GEOMETRY_INSPECTION_LIMITS.checkpointBytes) refuse(BlenderErrorCode.SCENE_TOO_HEAVY, 'the native checkpoint exceeds the inspection budget.')
  const binding = manifest.checkpointBinding
  let expected
  if (binding) {
    if (binding.sourceDigest !== digest || binding.specHash !== manifest.specHashAfter || binding.bytes !== fileSize(checkpoint)) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'checkpoint binding differs from the selected revision.')
    expected = binding.sha256
  } else {
    // Older immutable revisions retain the producer's exact artifact hash in their compile job.
    const job = typeof manifest.jobId === 'string' ? store.readJobSafe(projectId, manifest.jobId) : null
    if (job?.projectId === projectId && job.revision === revision && job.status === 'succeeded' &&
        ['compile_scene', 'apply_scene_patch'].includes(job.action)) {
      const matches = (job.artifacts ?? []).filter(a => a.kind === 'blend' && a.path === `revisions/${revision}/scene.blend` && a.bytes === fileSize(checkpoint))
      if (matches.length === 1) expected = matches[0].sha256
    }
  }
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) refuse(BlenderErrorCode.UNSUPPORTED_ACTION, 'this historical checkpoint has no verified producer hash; save a new checkpoint before measuring.')
  if (typeof host.runtime?.inspectGeometry !== 'function') refuse(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'the configured runtime does not support native geometry inspection.')
  const paths = [join(directory, 'scene-spec.json'), join(directory, 'revision-manifest.json')]
  if (!binding) paths.push(store.jobPath(projectId, manifest.jobId))
  const before = new Map(paths.map(path => [path, fileSha256(path)]))
  const verifySource = () => {
    cancelled(signal)
    resolveInside(project, `revisions/${revision}/scene.blend`, 'inspection checkpoint')
    if (!isFile(checkpoint) || fileSha256(checkpoint) !== expected || [...before].some(([path, hash]) => !isFile(path) || fileSha256(path) !== hash)) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the saved source changed; no measurement is accepted.')
    for (const asset of spec.assets ?? []) {
      if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || typeof asset.path !== 'string') refuse(BlenderErrorCode.ASSET_HASH_MISMATCH, `asset ${asset.id} has no pinned source.`)
      const file = resolveInside(project, asset.path, 'inspection asset')
      if (!isFile(file) || fileSha256(file) !== asset.sha256) refuse(BlenderErrorCode.ASSET_HASH_MISMATCH, `asset ${asset.id} no longer matches its declared source.`)
      verifyAssetBundle(project, asset); verifyUnbundledGltfAsset(project, asset); verifyUnbundledObjAsset(project, asset)
    }
  }
  verifySource()
  const scratch = resolveInside(host.workspaceRoot, join('tmp', `geometry-${randomUUID()}`), 'geometry workspace')
  mkdirSync(scratch, { recursive: true })
  try {
    const snapshot = join(scratch, 'source.blend'); copyFileSync(checkpoint, snapshot)
    const request = { ...selection, checkpointPath: snapshot, checkpointSha256: expected, signal }
    if (fileSha256(snapshot) !== expected) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the staged native input differs from the saved source.')
    const result = await host.runtime.inspectGeometry(request)
    cancelled(signal)
    if (selection.surfaceSamples !== undefined && result?.report?.schemaVersion === 'deepblend.geometry-inspection/v1') {
      refuse(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'the runtime does not support local surface samples; upgrade DeepBlend. Ordinary native geometry reads remain available.')
    }
    if (selection.objectAxes === true && result?.report?.schemaVersion !== 'deepblend.geometry-inspection/v3') refuse(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'The runtime does not support object-local native bounds; upgrade DeepBlend. Ordinary reads remain available.')
    if ((selection.assetInstanceIds !== undefined || selection.cameraId !== undefined) && result?.report?.schemaVersion !== 'deepblend.geometry-inspection/v4') refuse(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'The runtime does not support aggregate asset bounds; upgrade DeepBlend. Ordinary reads remain available.')
    const native = verifyGeometryReport(result?.report, request)
    verifySource()
    const hasSamples = selection.surfaceSamples !== undefined
    return { schemaVersion: selection.assetInstanceIds !== undefined || selection.cameraId !== undefined ? 'deepblend.scene-geometry/v4' : selection.objectAxes === true ? 'deepblend.scene-geometry/v3' : hasSamples ? 'deepblend.scene-geometry/v2' : 'deepblend.scene-geometry/v1', projectId, sourceRevision: revision,
      sourceDigest: digest, sourceSpecHash: manifest.specHashAfter, sourceCheckpointSha256: expected,
      ...(selection.objectAxes === true ? { objectAxisBasis: native.objectAxisBasis } : {}),
      ...(selection.cameraId === undefined ? {} : { camera: native.camera }),
      sourceUnchanged: true, frame: native.frame, objects: native.objects, blenderVersion: native.blenderVersion,
      ...(hasSamples ? { surfaceSamples: native.surfaceSamples } : {}),
      excludedMeasurements: hasSamples ? ['globalWallThickness', 'assemblyClearance', 'minimumClearance', 'collision', 'selfIntersection'] :
        ['wallThickness', 'shellToLinerClearance', 'minimumClearance', 'collision'],
      execution: { transport: 'batch' }, limitations: [
        'World-axis spans include rotations, handles and protrusions; they are not intrinsic body dimensions. Never invert a world-axis bounding box to recover local bounds.',
        ...(selection.objectAxes === true ? ['objectAxisBoundsMeters and objectAxisExtentMm bound actual evaluated mesh vertices in physical orthogonal axes of the selected object. They include evaluated modifiers, protrusions and native object/world scale, exclude placement rotation/translation, and are not semantic body dimensions or assembly extents. objectAxisWorldMatrix supplies the normalized axes and native origin. Sheared or degenerate object-axis bases have explicit unavailable objectAxisStatus while world bounds remain measured; these dimensions are not inferred from world bounds. Native scale can include generator construction transforms; it is not itself proof of a manual scaling edit. These extents already include that scale; do not apply it again.'] : []),
        'This evaluates saved native mesh geometry, not shader displacement or rendered pixels.',
        ...(selection.cameraId === undefined ? [] : ['cameraProjection bounds actual evaluated vertices in normalized image coordinates (X right, Y up), using native perspective, render aspect and camera shift at this ONE reported frame. Margin defaults to 0.03. A contained frame does not certify visibility, occlusion, collision, shader displacement, motion blur or the rest of an animation. Check every intended shot and the full rendered path; never alter unrelated or manually authored cameras automatically.']),
        ...(selection.assetInstanceIds !== undefined ? ['ASSET_MESH_SET bounds cover all evaluated mesh descendants of each explicitly selected asset instance, including nested native transforms and modifiers. Hidden, unsupported, empty or over-budget hierarchies are unavailable as a whole. Bounds are not a contact surface: compare bottom/top only for a deliberately horizontal support and verify actual placement in images. No automatic movement or reparenting occurs.'] : []),
        ...(hasSamples ? [
          'Surface samples are finite local chords along evaluated triangle-face normals, not shader or smoothed shading normals.',
          'The normalSurfaceChordMm runs from source entry to source exit. Target normalRaySeparationMm runs from source EXIT to target entry along that inward normal and excludes the source chord. Other scene objects are not checked; this is not full assembly free clearance.',
          'Closed connected consistently wound positive-volume geometry is required, but absence of self-intersections is not certified.',
          'No global minimum wall thickness, minimum clearance, collision absence, manufacturing safety or artistic approval is established.',
          'Unmeasured, missed, overlapping, occluded or unsupported samples must remain unavailable, never be replaced by zero or inferred from bounds.',
          'Search distance is explicitly requested (0.01–500 mm); chord and target search limits are each 100 mm. Epsilon is 0.0001 mm; distances at or below twice epsilon are unavailable.',
        ] : ['No wall thickness, clearance, collision, topology or artistic approval is established.']),
        'Do not subtract shell and liner extents or radii to report a gap: both bounds describe outer surfaces, and their difference includes wall material and depends on curvature and orientation.',
        'Unchanged height, position or scale does not prove that wall thickness or clearance was preserved. Report those conditions as unmeasured unless a separate surface measurement verifies them.',
      ] }
  } finally { removeTree(scratch) }
}
