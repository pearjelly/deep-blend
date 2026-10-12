import { createHash } from 'node:crypto'
import { persistImage } from './shared.js'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024

/** Persist one already verified PNG; validate any normalized durable reference. */
export async function persistVerifiedPng(attachments, bytes, artifact, name, signal) {
  const store = typeof attachments?.saveImage === 'function' ? {
    async saveImage(input) {
      const ref = await attachments.saveImage(input)
      const exact = ref?.mediaType === 'image/png' && ref.bytes === artifact.bytes &&
        ref.width === artifact.width && ref.height === artifact.height
      const dimensionsMatch = ref?.width === artifact.width && ref?.height === artifact.height ||
        ref?.originalDimensions?.width === artifact.width && ref?.originalDimensions?.height === artifact.height &&
        ref.width <= artifact.width && ref.height <= artifact.height
      if (typeof ref?.attachmentId !== 'string' || !ref.attachmentId.trim() ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mediaType) ||
          !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > MAX_IMAGE_BYTES ||
          !Number.isSafeInteger(ref.width) || ref.width <= 0 || !Number.isSafeInteger(ref.height) || ref.height <= 0 ||
          !dimensionsMatch) {
        throw new Error('attachment reference does not match the verified PNG')
      }
      // DSH may normalize the verified PNG into a smaller encoded image. Its
      // read API verifies that durable image's digest, format and dimensions.
      if (!exact) {
        if (typeof attachments.readImage !== 'function') throw new Error('normalized attachment cannot be read back')
        const stored = await attachments.readImage(ref, signal)
        if (!(stored?.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes ||
            ['attachmentId', 'mediaType', 'bytes', 'width', 'height'].some(key => stored.ref?.[key] !== ref[key]) ||
            ref.attachmentId.startsWith('sha256:') &&
            createHash('sha256').update(stored.data).digest('hex') !== ref.attachmentId.slice(7)) {
          throw new Error('normalized attachment bytes do not match its durable reference')
        }
      }
      return ref
    },
  } : attachments
  const attached = await persistImage(store, bytes, name)
  let { image, note } = attached
  if (image && (image.mediaType !== 'image/png' || image.bytes !== artifact.bytes ||
      image.width !== artifact.width || image.height !== artifact.height)) {
    note = 'The attached image is the attachment service normalization of the verified source PNG. ' +
      `Attached format: ${image.mediaType}; dimensions: ${image.width}x${image.height}. ` +
      'The original PNG and its source digest remain at the project path in this result.'
  }
  return { image, note }
}
