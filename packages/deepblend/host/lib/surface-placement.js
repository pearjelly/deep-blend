import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, compileSceneSpec, sceneSpecDigest, specHash, sha256Canonical,
  validateSurfacePlacementSelection, verifySurfacePlacementReport, SURFACE_PLACEMENT_LIMITS } from '@deepblend/dsh-blender-contracts'
import { fileSha256, fileSize, isFile, resolveInside, removeTree } from './paths.js'
import { verifyAssetBundle, verifyUnbundledGltfAsset, verifyUnbundledObjAsset } from './asset-bundle.js'

const refuse = (code, message) => { throw new BlenderError(code, `Surface placement: ${message}`) }
const checkCancellation = signal => { if (signal?.aborted) refuse(BlenderErrorCode.ABORTED, 'cancelled; no candidate was published.') }

export function normalizeSurfacePlacementRequest(request, projectsRoot) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.projectId !== 'string' || !request.projectId || !/^r[0-9]{4,}$/.test(request.baseRevision ?? '') ||
      request.renderPreview !== undefined && typeof request.renderPreview !== 'boolean' ||
      request.cameraId !== undefined && (typeof request.cameraId !== 'string' || !request.cameraId || request.cameraId.length > 128) ||
      request.idempotencyKey !== undefined && (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey.trim() || request.idempotencyKey.length > 128) ||
      Object.keys(request).some(key => !['projectId', 'baseRevision', 'subjectEntityId', 'supportEntityId', 'frame', 'clearanceMm',
        'renderPreview', 'cameraId', 'idempotencyKey', 'signal', 'projectsRoot'].includes(key))) {
    refuse(BlenderErrorCode.SCENE_PATCH_INVALID, 'expected an explicit bounded surface-placement request.')
  }
  if (request.projectsRoot !== undefined && request.projectsRoot !== projectsRoot) refuse(BlenderErrorCode.REVISION_CONFLICT, 'the active project store changed; read the selected work again.')
  const normalized = { projectId: request.projectId, baseRevision: request.baseRevision,
    subjectEntityId: request.subjectEntityId, supportEntityId: request.supportEntityId, frame: request.frame,
    clearanceMm: request.clearanceMm === undefined ? 0 : request.clearanceMm, renderPreview: request.renderPreview !== false,
    ...(request.cameraId === undefined ? {} : { cameraId: request.cameraId }),
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }) }
  validateSurfacePlacementSelection({ ...normalized, checkpointSha256: '0'.repeat(64) })
  return normalized
}

function protectSource(store, projectId, revision, spec, signal) {
  const project = store.projectDirectory(projectId), directory = store.revisionDirectory(projectId, revision)
  const checkpoint = resolveInside(project, `revisions/${revision}/scene.blend`, 'placement checkpoint')
  const manifest = store.readRevisionManifest(projectId, revision), digest = sceneSpecDigest(spec)
  if (manifest?.projectId !== projectId || manifest.revision !== revision || manifest.digest !== digest || manifest.specHashAfter !== specHash(spec)) {
    refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the saved revision manifest no longer matches its scene.')
  }
  if (!isFile(checkpoint)) refuse(BlenderErrorCode.REVISION_CHECKPOINT_MISSING, 'save a native checkpoint before placing on a surface.')
  if (fileSize(checkpoint) > SURFACE_PLACEMENT_LIMITS.checkpointBytes) refuse(BlenderErrorCode.SCENE_TOO_HEAVY, 'the source checkpoint exceeds the placement budget.')
  let expected = manifest.checkpointBinding?.sha256
  const paths = [join(directory, 'scene-spec.json'), join(directory, 'revision-manifest.json')]
  if (manifest.checkpointBinding) {
    const binding = manifest.checkpointBinding
    if (binding.sourceDigest !== digest || binding.specHash !== manifest.specHashAfter || binding.bytes !== fileSize(checkpoint)) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the checkpoint binding differs from the selected revision.')
  } else {
    const job = typeof manifest.jobId === 'string' ? store.readJobSafe(projectId, manifest.jobId) : null
    if (job?.projectId === projectId && job.revision === revision && job.status === 'succeeded' && ['compile_scene', 'apply_scene_patch'].includes(job.action)) {
      const matches = (job.artifacts ?? []).filter(a => a.kind === 'blend' && a.path === `revisions/${revision}/scene.blend` && a.bytes === fileSize(checkpoint))
      if (matches.length === 1) expected = matches[0].sha256
      paths.push(store.jobPath(projectId, manifest.jobId))
    }
  }
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) refuse(BlenderErrorCode.UNSUPPORTED_ACTION, 'this historical checkpoint has no verified producer hash; save a new checkpoint first.')
  const hashes = new Map(paths.map(path => [path, fileSha256(path)]))
  const verify = () => {
    checkCancellation(signal)
    resolveInside(project, `revisions/${revision}/scene.blend`, 'placement checkpoint')
    if (!isFile(checkpoint) || fileSha256(checkpoint) !== expected || [...hashes].some(([path, hash]) => !isFile(path) || fileSha256(path) !== hash)) {
      refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the saved source changed; the candidate was refused.')
    }
    for (const asset of spec.assets ?? []) {
      if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || typeof asset.path !== 'string') refuse(BlenderErrorCode.ASSET_HASH_MISMATCH, `asset ${asset.id} has no pinned source.`)
      const file = resolveInside(project, asset.path, 'placement asset')
      if (!isFile(file) || fileSha256(file) !== asset.sha256) refuse(BlenderErrorCode.ASSET_HASH_MISMATCH, `asset ${asset.id} no longer matches its declared source.`)
      verifyAssetBundle(project, asset); verifyUnbundledGltfAsset(project, asset); verifyUnbundledObjAsset(project, asset)
    }
  }
  verify()
  return { checkpoint, expected, verify }
}

function validateStaticSelection(spec, request) {
  const selected = [request.subjectEntityId, request.supportEntityId]
  const entities = selected.map(id => spec.entities.find(entity => entity.id === id))
  if (entities.some(entity => !entity || !['generator', 'asset-instance'].includes(entity.type))) refuse(BlenderErrorCode.SCENE_SPEC_INVALID, 'select two saved mesh entities or asset instances.')
  if (entities.some(entity => ['armatureId', 'rigidBody', 'cloth', 'softBody', 'fluid'].some(key => entity[key] !== undefined)) ||
      (spec.animationTracks ?? []).some(track => (track.targetKind ?? 'entity') === 'entity' && selected.includes(track.targetEntityId))) {
    refuse(BlenderErrorCode.UNSUPPORTED_ACTION, 'animated, rigged or simulated selections cannot be placed by this static operation.')
  }
  for (const entity of spec.entities) {
    if (entity.id === request.subjectEntityId) continue
    if ((entity.modifiers ?? []).some(modifier => modifier.targetEntityId === request.subjectEntityId || modifier.targetEntityIds?.includes(request.subjectEntityId))) {
      refuse(BlenderErrorCode.UNSUPPORTED_ACTION, `moving the subject would also change dependent entity ${entity.id}.`)
    }
  }
  if (request.cameraId !== undefined && !(spec.cameras ?? []).some(camera => camera.id === request.cameraId)) refuse(BlenderErrorCode.SCENE_CAMERA_MISSING, 'the requested preview camera does not exist.')
  return entities[0]
}

/** Runs entirely inside the transaction's single project-writer lease. */
export async function applySurfacePlacement(transaction, request, { signal } = {}) {
  const { store, runtime } = transaction
  const { idempotencyKey: explicitKey, ...intent } = request
  const intentSha256 = sha256Canonical(intent), key = explicitKey ?? `surface-placement-${intentSha256}`
  const recorded = store.readIdempotencyRecord(request.projectId, key)
  // Logical intent precedes current/base checks and native work: old successful
  // requests remain replayable after an unrelated later revision or restore.
  if (recorded !== null) {
    if (recorded.kind !== 'surface_placement' || recorded.intentSha256 !== intentSha256) refuse(BlenderErrorCode.SCENE_PATCH_REJECTED, 'this idempotency key belongs to a different request.')
    return { ...recorded.outcome, idempotentReplay: true, replayOf: recorded.outcome.revision.revision,
      idempotencyKey: key, idempotencyKeyDerived: explicitKey === undefined }
  }
  checkCancellation(signal)
  if (store.readRecord(request.projectId).currentRevision !== request.baseRevision) refuse(BlenderErrorCode.REVISION_CONFLICT, 'the current revision changed; read the scene again before placing.')
  if (typeof runtime?.inspectSurfacePlacement !== 'function') refuse(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'the configured runtime does not support native surface placement.')
  const spec = store.readRevisionSpec(request.projectId, request.baseRevision)
  const subject = validateStaticSelection(spec, request)
  const source = protectSource(store, request.projectId, request.baseRevision, spec, signal)
  const scratch = resolveInside(store.projectDirectory(request.projectId), `.surface-placement-${randomUUID()}`, 'placement workspace')
  mkdirSync(scratch, { recursive: true })
  try {
    const snapshot = join(scratch, 'source.blend'); copyFileSync(source.checkpoint, snapshot)
    const selection = { subjectEntityId: request.subjectEntityId, supportEntityId: request.supportEntityId,
      frame: request.frame, clearanceMm: request.clearanceMm }
    const inspect = async input => {
      checkCancellation(signal)
      const result = await runtime.inspectSurfacePlacement({ ...input, signal })
      checkCancellation(signal)
      const report = verifySurfacePlacementReport(result?.report, input)
      if (!isFile(snapshot) || fileSha256(snapshot) !== source.expected || !isFile(input.checkpointPath) || fileSha256(input.checkpointPath) !== input.checkpointSha256) {
        refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'native inspection changed its checkpoint input.')
      }
      source.verify()
      return report
    }
    const before = await inspect({ ...selection, checkpointPath: snapshot, checkpointSha256: source.expected })
    const location = subject.transform.location
    if (location.some((v, axis) => Math.abs(v - before.subject.rootWorldMatrix[axis][3]) > SURFACE_PLACEMENT_LIMITS.toleranceMeters)) {
      refuse(BlenderErrorCode.UNSUPPORTED_ACTION, 'the native subject origin does not match its saved world placement.')
    }
    const translationMeters = before.translationMeters
    const nextLocation = [location[0], location[1], location[2] + translationMeters[2]]
    if (!nextLocation.every(Number.isFinite)) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the placement translation is not finite.')
    const expectedSpec = structuredClone(spec)
    expectedSpec.entities.find(entity => entity.id === subject.id).transform.location = nextLocation
    let candidate = null
    const surfacePlacement = {
      intentSha256, keyDerived: explicitKey === undefined, expectedSpecHash: specHash(compileSceneSpec(expectedSpec).spec), receipt: null,
      verifyCandidate: async checkpointPath => {
        if (!isFile(checkpointPath)) refuse(BlenderErrorCode.REVISION_CHECKPOINT_MISSING, 'the candidate compile produced no checkpoint.')
        if (fileSize(checkpointPath) > SURFACE_PLACEMENT_LIMITS.checkpointBytes) refuse(BlenderErrorCode.SCENE_TOO_HEAVY, 'the candidate checkpoint exceeds the placement budget.')
        const checkpointSha256 = fileSha256(checkpointPath)
        const after = await inspect({ ...selection, checkpointPath, checkpointSha256,
          baselineCheckpointPath: snapshot, baselineCheckpointSha256: source.expected, expectedTranslationMeters: translationMeters })
        if (Math.abs(after.translationMeters[2]) > SURFACE_PLACEMENT_LIMITS.toleranceMeters) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the compiled placement does not establish the requested gap within tolerance.')
        candidate = { checkpointPath, checkpointSha256 }
        surfacePlacement.receipt = { schemaVersion: 'deepblend.surface-placement-receipt/v1',
          sourceRevision: request.baseRevision, sourceCheckpointSha256: source.expected, resultCheckpointSha256: checkpointSha256,
          subjectEntityId: subject.id, supportEntityId: request.supportEntityId, frame: request.frame, axis: 'world-z',
          clearanceMm: request.clearanceMm, translationMeters, toleranceMeters: SURFACE_PLACEMENT_LIMITS.toleranceMeters,
          before: { subjectContactMeters: before.subjectContactMeters, supportContactMeters: before.supportContactMeters,
            subjectTriangleIndex: before.subjectTriangleIndex, supportTriangleIndex: before.supportTriangleIndex },
          after: { subjectContactMeters: after.subjectContactMeters, supportContactMeters: after.supportContactMeters,
            residualTranslationMeters: after.translationMeters, baselineVerification: after.baselineVerification },
          scope: 'minimum-vertical-separation-over-overlapping-xy-triangles',
          limitations: ['One explicit frame and the two selected evaluated mesh sets only.',
            'Does not certify physics stability, Euclidean minimum clearance, other scene objects, shader displacement or an animation range.'] }
      },
    }
    const verifyNativeSource = () => {
      source.verify()
      if (!isFile(snapshot) || fileSha256(snapshot) !== source.expected || !candidate || !isFile(candidate.checkpointPath) || fileSha256(candidate.checkpointPath) !== candidate.checkpointSha256) {
        refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the verified native candidate or baseline changed before publication.')
      }
    }
    return await transaction._applyScenePatch({ projectId: request.projectId, baseRevision: request.baseRevision,
      idempotencyKey: key, saveCheckpoint: true, renderPreview: request.renderPreview,
      operations: [{ op: 'entity.transform.update', entityId: subject.id, location: nextLocation }],
      note: `Place ${subject.id} on ${request.supportEntityId} at frame ${request.frame}` },
    { signal, surfacePlacement, verifyNativeSource, previewFrame: request.frame, cameraId: request.cameraId })
  } finally { removeTree(scratch) }
}
