import { createHash } from 'node:crypto'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { persistVerifiedPng } from './attachment-image.js'
import { imageForCallingModel } from './image-delivery.js'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** Attach the receipt's existing preview, with no compile, render or output-time IO. */
export async function attachCommittedPreview(ctx, exec, resolved, value, { projectId, summary }) {
  const artifact = summary?.previews?.[0]
  if (!artifact) return value
  const cancelled = () => {
    if (exec?.signal?.aborted) throw new BlenderError(BlenderErrorCode.ABORTED,
      'Preview attachment cancelled; the saved revision may already exist.')
  }
  try {
    cancelled()
    const revision = summary.revision
    if (typeof projectId !== 'string' || !projectId || !/^r[0-9]{4,}$/.test(revision) ||
        !/^[a-f0-9]{64}$/.test(summary.digest) || artifact.kind !== 'preview' ||
        artifact.sourceRevision !== revision || artifact.sourceDigest !== summary.digest ||
        artifact.mime !== 'image/png' || typeof artifact.path !== 'string' ||
        !artifact.path.startsWith(`revisions/${revision}/previews/`) ||
        artifact.path.split('/').some(part => !part || part === '.' || part === '..') ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > MAX_IMAGE_BYTES ||
        !Number.isSafeInteger(artifact.width) || artifact.width <= 0 || artifact.width > 2048 ||
        !Number.isSafeInteger(artifact.height) || artifact.height <= 0 || artifact.height > 2048 ||
        typeof artifact.cameraId !== 'string' || !artifact.cameraId || !Number.isSafeInteger(artifact.frame) ||
        typeof resolved.studio.readArtifact !== 'function') throw new Error('Invalid saved preview receipt')
    const read = await resolved.studio.readArtifact({ projectId, path: artifact.path })
    cancelled()
    if (read?.path !== artifact.path || read.contentType !== 'image/png' || !Buffer.isBuffer(read.bytes) ||
        read.size !== artifact.bytes || read.bytes.length !== artifact.bytes || read.bytes.length < 24 ||
        !read.bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
        read.bytes.readUInt32BE(16) !== artifact.width || read.bytes.readUInt32BE(20) !== artifact.height ||
        createHash('sha256').update(read.bytes).digest('hex') !== artifact.sha256) {
      throw new Error('Saved PNG differs from its receipt')
    }
    const attached = await persistVerifiedPng(resolved.attachments, read.bytes, artifact,
      `preview-${revision}-${artifact.cameraId}-${artifact.frame}.png`, exec?.signal)
    cancelled()
    return await imageForCallingModel(ctx, exec, {
      ...value, image: attached.image,
      imageSource: { ...artifact, projectId, revision, digest: summary.digest },
      text: value.text + '\n\nThe image uses the preview already saved with this revision; no extra render was started.' +
        (attached.note ? '\n' + attached.note : ''),
    })
  } catch (cause) {
    cancelled()
    if (cause?.code === BlenderErrorCode.ABORTED) throw cause
    return { ...value, image: null,
      text: value.text + '\n\nThe revision remains saved, but its preview could not be verified and attached here. ' +
        'The model has not seen this image. Use the receipt to inspect the saved artifact; do not recreate the project or repeat the render to repair an attachment.' }
  }
}
