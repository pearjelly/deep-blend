/** A fitted view is a new static camera, published only after native verification. */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, CAMERA_FIT_LIMITS, compileSceneSpec, specHash, sha256Canonical,
  validateCameraFitSelection, verifyCameraFitReport } from '@deepblend/dsh-blender-contracts'
import { fileSha256, fileSize, isFile, resolveInside, removeTree } from './paths.js'
import { protectPlacementSource } from './surface-placement.js'

const fail = (message, code = BlenderErrorCode.SCENE_PATCH_INVALID) => { throw new BlenderError(code, `Camera fit: ${message}`) }
const cancelled = signal => { if (signal?.aborted) fail('cancelled; no fitted view was published.', BlenderErrorCode.ABORTED) }

export function normalizeCameraFitRequest(request, projectsRoot) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.projectId !== 'string' || !request.projectId || !/^r[0-9]{4,}$/.test(request.baseRevision ?? '') ||
      request.renderPreview !== undefined && typeof request.renderPreview !== 'boolean' ||
      request.idempotencyKey !== undefined && (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey.trim() || request.idempotencyKey.length > 128) ||
      Object.keys(request).some(k => !['projectId', 'baseRevision', 'entityIds', 'cameraId', 'fittedCameraId', 'frame', 'margin',
        'renderPreview', 'idempotencyKey', 'projectsRoot', 'signal'].includes(k))) fail('expected one bounded fitted-view request.')
  if (request.projectsRoot !== undefined && request.projectsRoot !== projectsRoot) fail('the active project store changed; read the selected work again.', BlenderErrorCode.REVISION_CONFLICT)
  const normalized = { projectId: request.projectId, baseRevision: request.baseRevision,
    entityIds: structuredClone(request.entityIds), cameraId: request.cameraId, fittedCameraId: request.fittedCameraId,
    frame: request.frame, margin: request.margin === undefined ? .03 : request.margin, renderPreview: request.renderPreview !== false,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }) }
  validateCameraFitSelection({ ...normalized, assetInstanceIds: [], checkpointSha256: '0'.repeat(64) })
  normalized.entityIds.sort()
  return normalized
}

export async function applyCameraFit(transaction, request, { signal } = {}) {
  const { store, runtime } = transaction
  const { idempotencyKey: explicitKey, ...intent } = request
  const intentSha256 = sha256Canonical(intent), key = explicitKey ?? `camera-fit-${intentSha256}`
  const recorded = store.readIdempotencyRecord(request.projectId, key)
  if (recorded !== null) {
    if (recorded.kind !== 'camera_fit' || recorded.intentSha256 !== intentSha256) fail('this idempotency key belongs to a different request.', BlenderErrorCode.SCENE_PATCH_REJECTED)
    return { ...recorded.outcome, idempotentReplay: true, replayOf: recorded.outcome.revision.revision,
      idempotencyKey: key, idempotencyKeyDerived: explicitKey === undefined }
  }
  cancelled(signal)
  if (store.readRecord(request.projectId).currentRevision !== request.baseRevision) fail('the current revision changed; read the scene again.', BlenderErrorCode.REVISION_CONFLICT)
  if (typeof runtime?.inspectCameraFit !== 'function') fail('the configured runtime does not support native fitted views.', BlenderErrorCode.RUNTIME_UNAVAILABLE)
  const spec = store.readRevisionSpec(request.projectId, request.baseRevision)
  if (!spec.cameras.some(c => c.id === request.cameraId)) fail('the source camera does not exist.', BlenderErrorCode.SCENE_CAMERA_MISSING)
  if (spec.cameras.some(c => c.id === request.fittedCameraId)) fail('choose an unused new camera ID.')
  const selected = request.entityIds.map(id => spec.entities.find(e => e.id === id))
  if (selected.some(e => !e || !['generator', 'asset-instance'].includes(e.type))) fail('select existing mesh entities or complete asset instances.')
  const source = protectPlacementSource(store, request.projectId, request.baseRevision, spec, signal)
  const scratch = resolveInside(store.projectDirectory(request.projectId), `.camera-fit-${randomUUID()}`, 'fitted view workspace')
  mkdirSync(scratch, { recursive: true })
  try {
    const snapshot = join(scratch, 'source.blend'); copyFileSync(source.checkpoint, snapshot)
    const selection = { entityIds: request.entityIds, assetInstanceIds: selected.filter(e => e.type === 'asset-instance').map(e => e.id),
      frame: request.frame, cameraId: request.cameraId, fittedCameraId: request.fittedCameraId, margin: request.margin }
    const inspect = async input => {
      cancelled(signal)
      const result = await runtime.inspectCameraFit({ ...input, signal })
      cancelled(signal)
      const report = verifyCameraFitReport(result?.report, input)
      source.verify()
      if (!isFile(snapshot) || fileSha256(snapshot) !== source.expected || !isFile(input.checkpointPath) || fileSha256(input.checkpointPath) !== input.checkpointSha256) fail('the native baseline or inspection input changed.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
      return report
    }
    const before = await inspect({ ...selection, checkpointPath: snapshot, checkpointSha256: source.expected })
    const camera = structuredClone(before.proposal), expected = structuredClone(spec)
    expected.cameras.push(camera)
    let candidate = null
    const cameraFit = { intentSha256, keyDerived: explicitKey === undefined,
      cameraOrder: expected.cameras.map(c => c.id),
      expectedSpecHash: specHash(compileSceneSpec(expected).spec), receipt: null,
      verifyCandidate: async checkpointPath => {
        if (!isFile(checkpointPath)) fail('the candidate compile produced no checkpoint.', BlenderErrorCode.REVISION_CHECKPOINT_MISSING)
        if (fileSize(checkpointPath) > CAMERA_FIT_LIMITS.checkpointBytes) fail('the candidate exceeds the native checkpoint budget.', BlenderErrorCode.SCENE_TOO_HEAVY)
        const checkpointSha256 = fileSha256(checkpointPath)
        const after = await inspect({ ...selection, checkpointPath, checkpointSha256,
          baselineCheckpointPath: snapshot, baselineCheckpointSha256: source.expected })
        if (camera.transform.location.some((v, i) => Math.abs(v-after.camera.matrixWorld[i][3]) > CAMERA_FIT_LIMITS.toleranceMeters) ||
            camera.fStop !== undefined && (after.camera.focusObject !== null || Math.abs(after.camera.focusDistance-camera.focusDistance) > Math.max(1e-6, camera.focusDistance*1e-6))) fail('the compiled fitted camera differs from its measured proposal.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
        candidate = { checkpointPath, checkpointSha256 }
        cameraFit.receipt = { schemaVersion: 'deepblend.camera-fit-receipt/v1', sourceRevision: request.baseRevision,
          sourceCheckpointSha256: source.expected, resultCheckpointSha256: checkpointSha256, ...selection,
          camera, view: after.view, members: after.members, baselineVerification: after.baselineVerification,
          scope: 'all-selected-evaluated-vertices-at-one-frame-and-native-render-aspect',
          limitations: ['One explicit frame and the complete selected mesh sets only.',
            'The new camera is static; original cameras, animation tracks and shots are preserved.',
            'Does not assess occlusion, artistic composition, transparency, shader displacement or an animation range.'] }
      } }
    const verifyNativeSource = () => {
      cancelled(signal); source.verify()
      if (!isFile(snapshot) || fileSha256(snapshot) !== source.expected || !candidate || !isFile(candidate.checkpointPath) || fileSha256(candidate.checkpointPath) !== candidate.checkpointSha256) fail('the verified candidate or baseline changed before publication.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
    }
    return await transaction._applyScenePatch({ projectId: request.projectId, baseRevision: request.baseRevision,
      operations: [{ op: 'camera.add', camera }], saveCheckpoint: true, renderPreview: request.renderPreview,
      idempotencyKey: key, note: `Save fitted view ${camera.id} at frame ${request.frame}` },
    { signal, cameraFit, verifyNativeSource, previewFrame: request.frame, cameraId: camera.id })
  } finally { removeTree(scratch) }
}
