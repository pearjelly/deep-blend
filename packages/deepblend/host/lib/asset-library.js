/** Bounded local asset inspection. Original bytes are never rewritten. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname } from 'node:path'
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

async function readExactly(handle, offset, length) {
  const data = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const result = await handle.read(data, read, length - read, offset + read)
    if (!result.bytesRead) reject('The asset file is truncated.')
    read += result.bytesRead
  }
  return data
}

/** Inspect GLB JSON without reading a potentially large BIN chunk into memory. */
export async function inspectSelfContainedGlb(path, { signal } = {}) {
  const handle = await open(path, 'r')
  try {
    signal?.throwIfAborted()
    const { size } = await handle.stat()
    if (size < 20) reject('The GLB header is truncated.')
    const header = await readExactly(handle, 0, 12)
    if (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 2 || header.readUInt32LE(8) !== size) {
      reject('The upload must be a complete GLB 2 file with its declared byte length.')
    }
    let offset = 12, document = null, binBytes = null
    while (offset < size) {
      signal?.throwIfAborted()
      if (offset + 8 > size) reject('The GLB contains a truncated chunk header.')
      const chunk = await readExactly(handle, offset, 8)
      const length = chunk.readUInt32LE(0), kind = chunk.readUInt32LE(4)
      if (length % 4 !== 0 || offset + 8 + length > size) reject('The GLB has an invalid chunk length.')
      if (offset === 12 && kind !== 0x4e4f534a) reject('The first GLB chunk must contain its JSON document.')
      if (kind === 0x4e4f534a) {
        if (document !== null || length > ASSET_LIBRARY_LIMITS.maxGlbJsonBytes) {
          reject('The GLB needs one JSON chunk of at most 16 MiB.', BlenderErrorCode.ASSET_REQUEST_INVALID)
        }
        try { document = JSON.parse((await readExactly(handle, offset + 8, length)).toString('utf8')) }
        catch (cause) {
          if (cause instanceof BlenderError) throw cause
          reject('The GLB JSON document is invalid.')
        }
        if (!document || typeof document !== 'object' || Array.isArray(document) || document.asset?.version !== '2.0') {
          reject('The GLB must declare glTF version 2.0.')
        }
      } else if (kind === 0x004e4942) {
        if (binBytes !== null) reject('The GLB contains more than one binary chunk.')
        binBytes = length
      }
      offset += 8 + length
    }
    for (const key of ['buffers', 'images']) {
      if (document[key] !== undefined && !Array.isArray(document[key])) reject(`The GLB ${key} field must be an array.`)
      for (const item of document[key] ?? []) {
        if (!item || typeof item !== 'object') reject(`The GLB contains an invalid ${key} entry.`)
        if (item.uri !== undefined && (typeof item.uri !== 'string' || !/^data:[^,]*;base64,/i.test(item.uri))) {
          reject('Upload a self-contained GLB. External buffers and image files are not copied or fetched.', BlenderErrorCode.ASSET_REQUEST_INVALID)
        }
      }
    }
    const embedded = (document.buffers ?? []).filter(buffer => buffer.uri === undefined)
    if (embedded.length > 1 || embedded.some(buffer => !Number.isSafeInteger(buffer.byteLength)
      || buffer.byteLength < 0 || binBytes === null || buffer.byteLength > binBytes || binBytes - buffer.byteLength > 3)) {
      reject('The GLB embedded buffer does not match its binary chunk.')
    }
    return {
      animations: Array.isArray(document.animations) ? document.animations.length : 0,
      cameras: Array.isArray(document.cameras) ? document.cameras.length : 0,
      lights: Array.isArray(document.extensions?.KHR_lights_punctual?.lights) ? document.extensions.KHR_lights_punctual.lights.length : 0,
    }
  } finally { await handle.close() }
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
