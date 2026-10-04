import { createHash } from 'node:crypto'
import { BlenderError, BlenderErrorCode, warning } from '@deepblend/dsh-blender-contracts'
import { canonicalCall, definedFields, persistImage, renderSuccess } from './shared.js'

const REQUIRED_HOST_API = 6
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

function aborted(signal) {
  if (signal?.aborted) {
    throw new BlenderError(BlenderErrorCode.ABORTED,
      'Inspection cancelled. A diagnostic already published by the Host may remain in the revision.')
  }
}

function receiptError(message) {
  throw new BlenderError(BlenderErrorCode.SCRIPT_ERROR, `Inspection receipt verification failed: ${message}`)
}

/** Render and attach one revision-bound inspection. All IO happens during execute. */
export async function renderInspection(resolved, request) {
  const { studio, attachments } = resolved
  const { projectId, revision, mode, cameraId, frame, signal } = request
  aborted(signal)
  if (!['beauty', 'clay'].includes(mode) || typeof revision !== 'string' || !revision.trim() ||
      typeof cameraId !== 'string' || !cameraId.trim() || !Number.isSafeInteger(frame)) {
    throw new BlenderError(BlenderErrorCode.RENDER_RANGE_INVALID,
      'An isolated inspection requires mode beauty or clay, an explicit revision, cameraId and integer frame.')
  }
  const reported = typeof studio.hostApiVersion === 'function' ? studio.hostApiVersion() : null
  const missingMethods = ['renderViews', 'readArtifact'].filter(name => typeof studio[name] !== 'function')
  if (!Number.isFinite(reported) || reported < REQUIRED_HOST_API || missingMethods.length) {
    throw new BlenderError(BlenderErrorCode.RUNTIME_UNAVAILABLE,
      'Isolated inspections require DeepBlend Host API 6 or newer. Upgrade the Host if needed, then restart the profile.',
      { detail: { requiredHostApiVersion: REQUIRED_HOST_API,
        reportedHostApiVersion: Number.isFinite(reported) ? reported : null, missingMethods,
        fix: 'upgrade the DeepBlend Host if needed, then restart the profile' } })
  }
  const { data, canonicalWarnings } = await canonicalCall(studio.renderViews({
    ...definedFields({ projectId, revision, mode, width: request.width, height: request.height, samples: request.samples }),
    views: [{ id: 'inspection', cameraId, frame }], signal,
  }), warning)
  aborted(signal)
  if (data.schemaVersion !== 'deepblend.diagnostic/v1' || data.projectId !== projectId ||
      data.revision !== revision || data.sourceRevision !== revision || data.mode !== mode ||
      typeof data.sourceDigest !== 'string' || !data.sourceDigest ||
      !Array.isArray(data.artifacts) || data.artifacts.length !== 1) receiptError('source or mode does not match the request.')
  const artifact = data.artifacts[0]
  if (artifact?.kind !== 'diagnostic' || artifact.mode !== mode || artifact.sourceRevision !== revision ||
      artifact.sourceDigest !== data.sourceDigest || artifact.viewId !== 'inspection' ||
      artifact.cameraId !== cameraId || artifact.frame !== frame || artifact.mime !== 'image/png' ||
      typeof artifact.path !== 'string' || !artifact.path.startsWith(`revisions/${revision}/diagnostics/`) ||
      artifact.path.split('/').some(part => !part || part === '.' || part === '..') ||
      typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_IMAGE_BYTES ||
      !Number.isSafeInteger(artifact.width) || artifact.width <= 0 || artifact.width > 2048 ||
      !Number.isSafeInteger(artifact.height) || artifact.height <= 0 || artifact.height > 2048) {
    receiptError('artifact does not match the requested view or image limits.')
  }
  const read = await studio.readArtifact({ projectId, path: artifact.path })
  aborted(signal)
  if (read?.path !== artifact.path || read.contentType !== 'image/png' || !Buffer.isBuffer(read.bytes) ||
      read.size !== artifact.bytes || read.bytes.length !== artifact.bytes ||
      createHash('sha256').update(read.bytes).digest('hex') !== artifact.sha256) {
    receiptError('the stored PNG differs from the published artifact.')
  }
  let image = null
  let note = null
  try {
    const store = typeof attachments?.saveImage === 'function' ? {
      async saveImage(input) {
        const ref = await attachments.saveImage(input)
        if (typeof ref?.attachmentId !== 'string' || !ref.attachmentId.trim() || ref.mediaType !== 'image/png' ||
            ref.bytes !== artifact.bytes || ref.width !== artifact.width || ref.height !== artifact.height) {
          throw new Error('attachment reference does not match the verified PNG')
        }
        return ref
      },
    } : attachments
    const attached = await persistImage(store, read.bytes, `${mode}-${revision}-${cameraId}-${frame}.png`)
    aborted(signal)
    image = attached.image
    note = attached.note
  } catch (cause) {
    aborted(signal)
    image = null
    // The render succeeded. Do not prompt an expensive re-render for an attachment failure.
    note = `The inspection PNG was rendered and verified, but could not be attached: ${cause?.message ?? String(cause)}. ` +
      'The model cannot see it in this result. Its project-relative path is in the payload; read it with a file-read tool.'
  }
  aborted(signal)
  const notes = [
    `Source revision: ${revision}; mode: ${mode}; camera: ${cameraId}; frame: ${frame}.`,
    `Image: ${artifact.path} (${artifact.width}x${artifact.height}, sha256 ${artifact.sha256}).`,
    'This independent inspection was rebuilt from SceneSpec. The source revision and normal previews are unchanged.',
    'It does not establish technical or artistic approval.',
    ...(data.limitations ?? []),
    ...(note ? [note] : []),
  ]
  return { ok: true, data, image,
    text: renderSuccess(`Rendered ${mode} inspection of ${revision}.`, data,
      { notes, warnings: [...(data.warnings ?? []), ...canonicalWarnings] }) }
}
