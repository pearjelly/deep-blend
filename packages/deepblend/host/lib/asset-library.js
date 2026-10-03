/** Bounded local asset inspection. Original bytes are never rewritten. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
import { readGltfDocument, gltfResources } from './asset-bundle.js'
import { BlenderError, BlenderErrorCode, assetContentVerdict } from '@deepblend/dsh-blender-contracts'

export const ASSET_LIBRARY_LIMITS = Object.freeze({
  maxImagePixels: 64 * 1024 * 1024,
  maxImageEdge: 8192,
  maxGlbJsonBytes: 16 * 1024 * 1024,
  previewWidth: 512,
  previewHeight: 384,
  previewSamples: 16,
})

const MIME_BY_TYPE = Object.freeze({
  glb: ['model/gltf-binary'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
  hdr: ['image/vnd.radiance', 'image/x-hdr'], exr: ['image/x-exr', 'image/exr'],
})

function reject(message, code = BlenderErrorCode.ASSET_CONTENT_MISMATCH) {
  throw new BlenderError(code, message)
}

export function uploadAssetType(name, mediaType) {
  const type = extname(name).slice(1).toLowerCase()
  if (!Object.hasOwn(MIME_BY_TYPE, type)) reject('Choose a GLB, PNG, JPEG, HDR or EXR file.', BlenderErrorCode.ASSET_REQUEST_INVALID)
  if (mediaType !== undefined && typeof mediaType !== 'string') reject('The upload media type must be text.', BlenderErrorCode.ASSET_REQUEST_INVALID)
  const mime = (mediaType ?? '').split(';')[0].trim().toLowerCase()
  if (mime && mime !== 'application/octet-stream' && !MIME_BY_TYPE[type].includes(mime)) {
    reject('The file extension and upload media type do not agree.')
  }
  return type
}

/** Inspect bounded GLB metadata; the upload profile requires all core resources embedded. */
export async function inspectSelfContainedGlb(path, { signal } = {}) {
  const { document, binBytes } = readGltfDocument(path, { format: 'glb', signal })
  if (gltfResources(document, 'upload.glb', binBytes).length) {
    reject('Upload a self-contained GLB. External buffers and image files are not copied or fetched.', BlenderErrorCode.ASSET_REQUEST_INVALID)
  }
  return {
    animations: Array.isArray(document.animations) ? document.animations.length : 0,
    cameras: Array.isArray(document.cameras) ? document.cameras.length : 0,
    lights: Array.isArray(document.extensions?.KHR_lights_punctual?.lights) ? document.extensions.KHR_lights_punctual.lights.length : 0,
  }
}

export async function checkAssetUpload(path, type, { signal } = {}) {
  signal?.throwIfAborted()
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(512)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (assetContentVerdict(head.subarray(0, bytesRead), type) === 'contradicts') {
      reject('The uploaded bytes contradict the file extension.')
    }
  } finally { await handle.close() }
  return type === 'glb' ? inspectSelfContainedGlb(path, { signal }) : null
}

/** Hash incrementally, including while checking large staged model files. */
export async function hashAssetFile(path, { maxBytes, signal } = {}) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.length
    if (maxBytes !== undefined && bytes > maxBytes) reject('The asset exceeds the configured byte limit.', BlenderErrorCode.ASSET_TOO_LARGE)
    hash.update(chunk)
  }
  signal?.throwIfAborted()
  return { bytes, sha256: hash.digest('hex') }
}

/** Decode the complete stored image, then make a bounded PNG derivative. */
export async function previewRasterAsset(path, type, outputPath, { signal } = {}) {
  signal?.throwIfAborted()
  const { default: sharp } = await import('sharp')
  const inputOptions = { failOn: 'warning', limitInputPixels: ASSET_LIBRARY_LIMITS.maxImagePixels, sequentialRead: true }
  const source = sharp(path, inputOptions)
  // Sharp is both a Promise API and a Duplex. destroy(error) can reject the
  // operation AND emit a stream error; the latter needs its own listener.
  // Keep it for the object's lifetime because destroy emits asynchronously.
  source.on('error', () => {})
  const abort = () => source.destroy(signal.reason instanceof Error ? signal.reason : new Error('Asset preview cancelled.'))
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const metadata = await source.metadata()
    const expected = type === 'png' ? 'png' : 'jpeg'
    if (metadata.format !== expected) reject('The image decoder found a different format from the declared asset type.')
    if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height)
      || metadata.width < 1 || metadata.height < 1 || metadata.width > ASSET_LIBRARY_LIMITS.maxImageEdge
      || metadata.height > ASSET_LIBRARY_LIMITS.maxImageEdge || metadata.width * metadata.height > ASSET_LIBRARY_LIMITS.maxImagePixels) {
      reject('The image exceeds the asset library pixel or edge limit.', BlenderErrorCode.ASSET_TOO_LARGE)
    }
    if ((metadata.pages ?? 1) !== 1) reject('Asset library images must contain a single still image.', BlenderErrorCode.ASSET_REQUEST_INVALID)
    signal?.throwIfAborted()
    const result = await source.resize({ width: ASSET_LIBRARY_LIMITS.previewWidth, height: ASSET_LIBRARY_LIMITS.previewHeight,
      fit: 'inside', withoutEnlargement: true }).png().toFile(outputPath)
    signal?.throwIfAborted()
    return {
      image: { width: metadata.width, height: metadata.height, channels: metadata.channels,
        format: expected, orientation: metadata.orientation ?? 1, colorSpace: metadata.space },
      preview: { width: result.width, height: result.height, mime: 'image/png', toneMapped: false },
    }
  } catch (cause) {
    signal?.throwIfAborted()
    if (cause instanceof BlenderError) throw cause
    throw new BlenderError(BlenderErrorCode.ASSET_CONTENT_MISMATCH, 'The image could not be completely decoded.', { cause })
  } finally { signal?.removeEventListener('abort', abort) }
}
