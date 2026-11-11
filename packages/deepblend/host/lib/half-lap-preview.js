import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyPatchToSpec, BlenderError, BlenderErrorCode, compileSceneSpec, decodePng,
  sceneSpecCanonicalText, sceneSpecDigest, sha256, specHash, validateScenePatch, validateSceneSpec,
} from '@deepblend/dsh-blender-contracts'
import { resolveInside } from './paths.js'
import { assertRuntimeSceneFeatures } from './runtime-scene-features.js'

const imageLimit = 512 * 1024
const previewsInProgress = new WeakSet()

function readSlotImage(directory, role) {
  const file = join(directory, `half-lap-${role}.png`)
  const stat = statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size < 33 || stat.size > imageLimit) {
    throw new BlenderError(BlenderErrorCode.RENDER_NO_OUTPUT, 'The slot inspection is missing a bounded PNG.')
  }
  const bytes = readFileSync(file)
  if (bytes.length !== stat.size || bytes.readUInt32BE(16) !== 480 || bytes.readUInt32BE(20) !== 320) {
    throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'The slot inspection has unexpected image dimensions.')
  }
  const decoded = decodePng(bytes)
  const hasShading = decoded.data.some((channel, index) => index % 4 !== 3 && channel !== decoded.data[index % 4])
  if (decoded.width !== 480 || decoded.height !== 320 || !hasShading) {
    throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'The slot inspection PNG could not be verified.')
  }
  return { width: decoded.width, height: decoded.height, sha256: sha256(bytes), pngBase64: bytes.toString('base64') }
}

export async function previewHalfLap(host, input) {
  const { store, runtime, transactions } = host
  if (typeof runtime?.compileHalfLapInspection !== 'function') {
    throw new BlenderError(BlenderErrorCode.RUNTIME_UNAVAILABLE, 'The current Blender runtime does not support slot inspection.')
  }
  if (previewsInProgress.has(host)) {
    throw new BlenderError(BlenderErrorCode.REVISION_CONFLICT, 'Another slot inspection is running. Wait for it or cancel it first.')
  }
  const { patch, expectedDigest, expectedStoreIdentity } = input
  const checked = validateScenePatch(patch)
  if (!checked.ok) throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, checked.summary)
  const changes = patch.operations.filter(op => op.op === 'joint.halfLap.set' && op.enabled !== false)
  if (changes.length !== 1) {
    throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, 'Preview one active half-lap change at a time.')
  }
  const { lowerEntityId, upperEntityId } = changes[0]
  const joint = { lowerEntityId, upperEntityId }
  const { projectId, baseRevision } = patch
  const timed = AbortSignal.timeout(45000)
  const signal = input.signal ? AbortSignal.any([input.signal, timed]) : timed
  const ensureCurrent = () => {
    if (signal.aborted) throw new BlenderError(BlenderErrorCode.ABORTED, 'The slot inspection was cancelled or timed out.')
    if (host.editableSnapshots.storeIdentity !== expectedStoreIdentity || store.currentRevision(projectId) !== baseRevision) {
      throw new BlenderError(BlenderErrorCode.REVISION_CONFLICT, 'The saved scene changed. Refresh before previewing the slots.')
    }
  }
  ensureCurrent()
  const base = store.readRevisionSpec(projectId, baseRevision)
  const baseHash = specHash(base)
  if (sceneSpecDigest(base) !== expectedDigest) {
    throw new BlenderError(BlenderErrorCode.REVISION_CONFLICT, 'The saved scene changed. Refresh before previewing the slots.')
  }
  const applied = applyPatchToSpec(compileSceneSpec(base).spec, patch)
  const candidate = compileSceneSpec(applied.spec).spec
  const validation = validateSceneSpec(candidate)
  if (!validation.ok || !candidate.halfLaps?.some(pair => pair.lowerEntityId === lowerEntityId && pair.upperEntityId === upperEntityId)) {
    throw new BlenderError(BlenderErrorCode.SCENE_SPEC_INVALID, validation.ok ? 'The draft does not contain the requested half lap.' : validation.summary)
  }

  let scratch
  previewsInProgress.add(host)
  try {
    transactions.verifyPatchAssets(projectId, candidate)
    const featureCheck = assertRuntimeSceneFeatures(runtime, candidate, { signal })
    if (featureCheck) await featureCheck
    const parent = resolveInside(store.workspaceRoot, 'tmp', 'half-lap preview scratch')
    mkdirSync(parent, { recursive: true })
    scratch = mkdtempSync(join(parent, 'half-lap-preview-'))
    const sceneSpecPath = join(scratch, 'scene-spec.json')
    writeFileSync(sceneSpecPath, sceneSpecCanonicalText(candidate))
    let lower, upper
    const { report } = await runtime.compileHalfLapInspection({
      sceneSpecPath, projectRoot: store.projectDirectory(projectId), profile: 'preview', joint, signal,
      onWorkingDirectory: ({ directory }) => {
        if (existsSync(join(directory, 'result.blend'))) {
          throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'Slot inspection produced a checkpoint instead of a draft.')
        }
        lower = readSlotImage(directory, 'lower')
        upper = readSlotImage(directory, 'upper')
      },
    })
    ensureCurrent()
    if (specHash(store.readRevisionSpec(projectId, baseRevision)) !== baseHash) {
      throw new BlenderError(BlenderErrorCode.REVISION_CONFLICT, 'The saved scene changed during the slot inspection.')
    }
    transactions.verifyPatchAssets(projectId, candidate)
    const measured = report?.halfLapInspection
    if (report?.outputBlend !== null || report?.validation?.ok !== true || !lower || !upper ||
        measured?.schemaVersion !== 'deepblend.half-lap-inspection/v1' || !Number.isSafeInteger(measured.crossings) || measured.crossings < 1 ||
        !Number.isSafeInteger(measured.partialCrossings) || measured.partialCrossings < 0 || measured.partialCrossings > measured.crossings ||
        measured.sample !== (measured.partialCrossings ? 'partial' : 'full')) {
      throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED, 'The runtime did not verify both slot faces.')
    }
    return {
      schemaVersion: measured.schemaVersion, projectId, baseRevision, baseDigest: expectedDigest, storeIdentity: expectedStoreIdentity,
      candidateSpecHash: specHash(candidate), joint, crossings: measured.crossings, partialCrossings: measured.partialCrossings,
      sample: measured.sample, lower, upper,
    }
  } finally {
    previewsInProgress.delete(host)
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}
