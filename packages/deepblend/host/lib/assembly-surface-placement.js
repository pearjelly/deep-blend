/** Complete lamp placement shares the existing single-writer revision transaction. */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, compileSceneSpec, specHash, sha256Canonical, planLampAssemblyPlacement,
  verifyAssemblyPlacementReport, SURFACE_PLACEMENT_LIMITS, ASSEMBLY_PLACEMENT_BASIS_TOLERANCE } from '@deepblend/dsh-blender-contracts'
import { fileSha256, fileSize, isFile, resolveInside, removeTree } from './paths.js'
import { readRecipeContext } from './recipe-state.js'
import { protectPlacementSource, validateStaticPlacementSelection } from './surface-placement.js'

const refuse = (code, message) => { throw new BlenderError(code, `Assembly placement: ${message}`) }
const identityPose = () => ({ translationMm: [0, 0, 0], yawDegrees: 0, pivotMm: [0, 0, 0] })
const cancellation = signal => { if (signal?.aborted) refuse(BlenderErrorCode.ABORTED, 'cancelled; no candidate was published.') }

export function describeLampAssemblyPlacement(context, spec) {
  if (!context) return null
  try {
    const plan = planLampAssemblyPlacement(context.lock, spec, context.state ?? undefined)
    const anchor = spec.entities.find(entity => entity.id === plan.subjectEntityId)
    return { available: true, scope: 'recipe-assembly', subjectEntityId: plan.subjectEntityId,
      memberEntityIds: plan.memberEntityIds, memberCount: plan.memberEntityIds.length,
      anchorPositionMm: anchor.transform.location.map(value => value * 1000), defaultPose: plan.pose,
      coordinates: 'relative world translation in mm; relative upright yaw in degrees about a world pivot in mm, then measured world-Z settling',
      photography: 'preserved', recipe: { id: context.lock.id, version: context.lock.version } }
  } catch (error) {
    if (error.code === BlenderErrorCode.UNSUPPORTED_ACTION
        && (context.lock.id !== 'deepblend.metal-lamp' || context.lock.version !== '2.2.0')) return null
    return { available: false, scope: 'recipe-assembly', error: { code: error.code ?? 'RECIPE_LOCK_INVALID', message: error.message },
      conflicts: error.details?.conflicts ?? [] }
  }
}

function protectRecipe(store, request, context) {
  const paths = new Set([join(store.revisionDirectory(request.projectId, context.originRevision), 'recipe-lock.json')])
  let revision = request.baseRevision
  while (revision !== 'r0000') {
    paths.add(join(store.revisionDirectory(request.projectId, revision), 'revision-manifest.json'))
    if (revision === context.originRevision) break
    revision = store.readRevisionManifest(request.projectId, revision).baseRevision
  }
  if (context.stateRevision) paths.add(join(store.revisionDirectory(request.projectId, context.stateRevision), 'recipe-parameters.json'))
  const hashes = [...paths].map(path => [path, fileSha256(path)])
  return { lockSha256: hashes[0][1], verify: () => {
    if (hashes.some(([path, sha256]) => !isFile(path) || fileSha256(path) !== sha256)) {
      refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the saved recipe ancestry changed; no candidate was published.')
    }
  } }
}

function operationMatrix(operation) {
  const [x, y, z] = operation.rotationEuler, [px, py, pz] = operation.location
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z)
  return [[cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx, px], [sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx, py],
    [-sy, cy*sx, cy*cx, pz], [0, 0, 0, 1]]
}

export async function applyAssemblySurfacePlacement(transaction, request, { signal } = {}) {
  const { store, runtime } = transaction
  const { idempotencyKey: explicitKey, ...intent } = request
  const intentSha256 = sha256Canonical(intent), key = explicitKey ?? `assembly-placement-${intentSha256}`
  const recorded = store.readIdempotencyRecord(request.projectId, key)
  if (recorded !== null) {
    if (recorded.kind !== 'surface_placement' || recorded.intentSha256 !== intentSha256) refuse(BlenderErrorCode.SCENE_PATCH_REJECTED, 'this idempotency key belongs to a different request.')
    return { ...recorded.outcome, idempotentReplay: true, replayOf: recorded.outcome.revision.revision,
      idempotencyKey: key, idempotencyKeyDerived: explicitKey === undefined }
  }
  cancellation(signal)
  if (store.readRecord(request.projectId).currentRevision !== request.baseRevision) refuse(BlenderErrorCode.REVISION_CONFLICT, 'the current revision changed; read the scene again before placing.')
  if (typeof runtime?.inspectAssemblyPlacement !== 'function') refuse(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'the configured runtime does not support complete assembly placement.')
  const spec = store.readRevisionSpec(request.projectId, request.baseRevision)
  const context = readRecipeContext(store, request.projectId, request.baseRevision)
  if (!context) refuse(BlenderErrorCode.UNSUPPORTED_ACTION, 'select a saved complete metal-lamp 2.2.0 recipe.')
  const plan = planLampAssemblyPlacement(context.lock, spec, context.state ?? undefined, request.pose)
  if (request.subjectEntityId !== plan.subjectEntityId || plan.memberEntityIds.includes(request.supportEntityId)) {
    refuse(BlenderErrorCode.SCENE_PATCH_INVALID, 'select the weighted-base anchor of the complete lamp and a support outside the lamp.')
  }
  validateStaticPlacementSelection(spec, request)
  const source = protectPlacementSource(store, request.projectId, request.baseRevision, spec, signal)
  const recipe = protectRecipe(store, request, context)
  const scratch = resolveInside(store.projectDirectory(request.projectId), `.surface-placement-${randomUUID()}`, 'assembly placement workspace')
  mkdirSync(scratch, { recursive: true })
  try {
    const snapshot = join(scratch, 'source.blend'); copyFileSync(source.checkpoint, snapshot)
    const verifySource = () => {
      cancellation(signal); source.verify(); recipe.verify()
      if (!isFile(snapshot) || fileSha256(snapshot) !== source.expected) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the native baseline changed during placement.')
    }
    const selection = { subjectEntityId: plan.subjectEntityId, memberEntityIds: plan.memberEntityIds,
      supportEntityId: request.supportEntityId, frame: request.frame, clearanceMm: request.clearanceMm }
    const inspect = async input => {
      verifySource()
      const result = await runtime.inspectAssemblyPlacement({ ...input, signal })
      const report = verifyAssemblyPlacementReport(result?.report, input)
      verifySource()
      if (!isFile(input.checkpointPath) || fileSha256(input.checkpointPath) !== input.checkpointSha256) {
        refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'native measurement changed a checkpoint input.')
      }
      return report
    }
    const before = await inspect({ ...selection, pose: plan.pose, checkpointPath: snapshot, checkpointSha256: source.expected })
    for (const operation of plan.operations) {
      const native = before.members.find(member => member.entityId === operation.entityId).geometry.rootWorldMatrix
      const expected = operationMatrix(operation)
      if (native.some((row, i) => row.some((value, j) => Math.abs(value - expected[i][j]) >
          (j === 3 ? SURFACE_PLACEMENT_LIMITS.toleranceMeters : ASSEMBLY_PLACEMENT_BASIS_TOLERANCE)))) {
        refuse(BlenderErrorCode.UNSUPPORTED_ACTION, `native member ${operation.entityId} does not match its saved world placement.`)
      }
    }
    const operations = plan.operations.map(operation => ({ ...operation,
      location: operation.location.map((value, axis) => value + before.translationMeters[axis]) }))
    const expectedSpec = structuredClone(spec)
    for (const operation of operations) Object.assign(expectedSpec.entities.find(entity => entity.id === operation.entityId).transform,
      { location: operation.location, rotationEuler: operation.rotationEuler })
    let candidate = null
    const surfacePlacement = { intentSha256, keyDerived: explicitKey === undefined,
      expectedSpecHash: specHash(compileSceneSpec(expectedSpec).spec), receipt: null,
      verifyCandidate: async checkpointPath => {
        if (!isFile(checkpointPath)) refuse(BlenderErrorCode.REVISION_CHECKPOINT_MISSING, 'the candidate compile produced no checkpoint.')
        if (fileSize(checkpointPath) > SURFACE_PLACEMENT_LIMITS.checkpointBytes) refuse(BlenderErrorCode.SCENE_TOO_HEAVY, 'the candidate checkpoint exceeds the placement budget.')
        const checkpointSha256 = fileSha256(checkpointPath)
        const after = await inspect({ ...selection, pose: identityPose(), checkpointPath, checkpointSha256,
          baselineCheckpointPath: snapshot, baselineCheckpointSha256: source.expected, expectedWorldMatrixMeters: before.resultWorldMatrixMeters })
        if (Math.abs(after.translationMeters[2]) > SURFACE_PLACEMENT_LIMITS.toleranceMeters) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the saved complete lamp does not establish the requested vertical gap.')
        candidate = { checkpointPath, checkpointSha256 }
        surfacePlacement.receipt = { schemaVersion: 'deepblend.assembly-placement-receipt/v1', scope: 'recipe-assembly',
          sourceRevision: request.baseRevision, sourceCheckpointSha256: source.expected, resultCheckpointSha256: checkpointSha256,
          recipeOrigin: { revision: context.originRevision, manifestSha256: context.lock.manifestSha256, lockSha256: recipe.lockSha256 },
          subjectEntityId: plan.subjectEntityId, memberEntityIds: plan.memberEntityIds, supportEntityId: request.supportEntityId,
          frame: request.frame, axis: 'world-z', clearanceMm: request.clearanceMm, pose: plan.pose,
          poseMatrixMeters: before.poseMatrixMeters, settleTranslationMeters: before.translationMeters,
          resultWorldMatrixMeters: before.resultWorldMatrixMeters, toleranceMeters: SURFACE_PLACEMENT_LIMITS.toleranceMeters,
          before: { subjectContactEntityId: before.subjectContactEntityId, subjectContactMeters: before.subjectContactMeters,
            supportContactMeters: before.supportContactMeters, subjectTriangleIndex: before.subjectTriangleIndex, supportTriangleIndex: before.supportTriangleIndex },
          after: { subjectContactEntityId: after.subjectContactEntityId, subjectContactMeters: after.subjectContactMeters,
            supportContactMeters: after.supportContactMeters, residualTranslationMeters: after.translationMeters, baselineVerification: after.baselineVerification },
          measurement: 'minimum-vertical-separation-over-complete-assembly-and-support-overlapping-xy-triangles',
          limitations: ['The complete pinned static lamp and the selected support at this explicit frame.',
            'Does not certify physics stability, Euclidean clearance, other objects, shader displacement or the movement path.',
            'Saved cameras and lights are preserved; a new composition requires an explicit photography edit.'] }
      } }
    const verifyNativeSource = () => {
      verifySource()
      if (!candidate || !isFile(candidate.checkpointPath) || fileSha256(candidate.checkpointPath) !== candidate.checkpointSha256) refuse(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'the verified native candidate changed before publication.')
    }
    return await transaction._applyScenePatch({ projectId: request.projectId, baseRevision: request.baseRevision,
      idempotencyKey: key, saveCheckpoint: true, renderPreview: request.renderPreview, operations,
      note: `Place complete lamp on ${request.supportEntityId} at frame ${request.frame}` },
    { signal, surfacePlacement, verifyNativeSource, previewFrame: request.frame, cameraId: request.cameraId })
  } finally { removeTree(scratch) }
}
