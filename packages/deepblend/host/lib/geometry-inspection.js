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
    const native = verifyGeometryReport(result?.report, request)
    verifySource()
    return { schemaVersion: 'deepblend.scene-geometry/v1', projectId, sourceRevision: revision,
      sourceDigest: digest, sourceSpecHash: manifest.specHashAfter, sourceCheckpointSha256: expected,
      sourceUnchanged: true, frame: native.frame, objects: native.objects, blenderVersion: native.blenderVersion,
      excludedMeasurements: ['wallThickness', 'shellToLinerClearance', 'minimumClearance', 'collision'],
      execution: { transport: 'batch' }, limitations: [
        'World-axis spans include rotations, handles and protrusions; they are not intrinsic body dimensions.',
        'This evaluates saved native mesh geometry, not shader displacement or rendered pixels.',
        'No wall thickness, clearance, collision, topology or artistic approval is established.',
        'Do not subtract shell and liner extents or radii to report a gap: both bounds describe outer surfaces, and their difference includes wall material and depends on curvature and orientation.',
        'Unchanged height, position or scale does not prove that wall thickness or clearance was preserved. Report those conditions as unmeasured unless a separate surface measurement verifies them.',
      ] }
  } finally { removeTree(scratch) }
}
