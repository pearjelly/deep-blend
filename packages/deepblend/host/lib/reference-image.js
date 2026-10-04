import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

export const REFERENCE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const REFERENCE_IMAGE_MAX_PIXELS = 16_000_000
export const REFERENCE_IMAGE_MAX_EDGE = 8192

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function invalid(message) {
  throw new BlenderError(BlenderErrorCode.ASSET_REQUEST_INVALID, message)
}

function mismatch(message, cause) {
  throw new BlenderError(BlenderErrorCode.ASSET_CONTENT_MISMATCH, message, { cause })
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

// libpng can ignore unknown ancillary chunks, including APNG's animation chunks.
// Check the complete container as well as decoding its pixels; never silently
// accept just a first frame, a concatenated file, or a damaged ancillary chunk.
function checkPng(data) {
  let offset = PNG_SIGNATURE.length
  let imageData = false
  let imageDataEnded = false
  while (offset < data.length) {
    if (offset + 12 > data.length) mismatch('The PNG image has a truncated chunk.')
    const length = data.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > data.length) mismatch('The PNG image has a truncated chunk.')
    const type = data.toString('ascii', offset + 4, offset + 8)
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) mismatch('The PNG image has an invalid chunk type.')
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) {
      mismatch('The PNG image has a damaged chunk checksum.')
    }
    if (offset === 8 ? type !== 'IHDR' || length !== 13 : type === 'IHDR') {
      mismatch('The PNG image has an invalid header.')
    }
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid('Reference images must be still images; animated PNG is not supported.')
    if (type === 'IDAT') {
      if (imageDataEnded) mismatch('The PNG image has nonconsecutive pixel chunks.')
      imageData = true
    } else if (imageData) imageDataEnded = true
    if (type === 'IEND') {
      if (length !== 0 || !imageData || end !== data.length) mismatch('The PNG image has an invalid ending or trailing content.')
      return
    }
    offset = end
  }
  mismatch('The PNG image is missing its complete ending.')
}

// Walk marker lengths and entropy-coded scans so progressive JPEG remains valid
// while truncated streams and extra images after EOI cannot be repaired by the
// decoder. MPF is a multi-picture container even if only its first image decodes.
function checkJpeg(data) {
  let offset = 2
  let sawScan = false
  let frames = 0
  let inScan = false
  while (offset < data.length) {
    if (inScan) {
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset += 1; continue }
        const start = offset
        while (data[offset] === 0xff) offset += 1
        const marker = data[offset]
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 1; continue }
        offset = start
        inScan = false
        break
      }
    }
    if (data[offset] !== 0xff) mismatch('The JPEG image has a truncated scan or invalid marker.')
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset++]
    if (marker === 0xd9) {
      if (!sawScan || offset !== data.length) mismatch('The JPEG image has an invalid ending or trailing content.')
      return
    }
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      mismatch('The JPEG image has an invalid marker.')
    }
    if (marker === 0x01) continue // TEM is the only other stand-alone marker.
    if (offset + 2 > data.length) mismatch('The JPEG image has a truncated segment.')
    const length = data.readUInt16BE(offset)
    const end = offset + length
    if (length < 2 || end > data.length) mismatch('The JPEG image has a truncated segment.')
    if (marker === 0xe2 && data.toString('latin1', offset + 2, offset + 6) === 'MPF\0') {
      invalid('Reference images must contain one image; multi-picture JPEG is not supported.')
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      frames += 1
      if (frames > 1) invalid('Reference images must contain one image; multi-frame JPEG is not supported.')
    }
    offset = end
    if (marker === 0xda) { sawScan = true; inScan = true }
  }
  mismatch('The JPEG image is missing its complete ending.')
}

/**
 * Inspect immutable source bytes without resizing, orienting or re-encoding.
 * Width/height describe the stored pixel grid, before any EXIF orientation.
 * The native codec is loaded only when a reference image is actually inspected.
 */
export async function inspectReferenceImage(data, { name, mediaType } = {}) {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) invalid('A reference image must contain PNG or JPEG bytes.')
  if (data.byteLength > REFERENCE_IMAGE_MAX_BYTES) {
    throw new BlenderError(BlenderErrorCode.ASSET_TOO_LARGE, 'A reference image must be at most 8 MiB.', {
      detail: { bytes: data.byteLength, maxBytes: REFERENCE_IMAGE_MAX_BYTES },
    })
  }
  let extension
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) invalid('A reference image name must end in .png, .jpg or .jpeg.')
    extension = extname(name).slice(1).toLowerCase()
    if (!['png', 'jpg', 'jpeg'].includes(extension)) invalid('A reference image name must end in .png, .jpg or .jpeg.')
  }
  let declaredMime
  if (mediaType !== undefined) {
    if (typeof mediaType !== 'string') invalid('A reference image media type must be image/png or image/jpeg.')
    declaredMime = mediaType.trim().toLowerCase()
    if (!['image/png', 'image/jpeg'].includes(declaredMime)) invalid('A reference image media type must be image/png or image/jpeg.')
  }
  // Own the bytes across asynchronous decode so a caller cannot change the hash
  // or source content after its type was checked.
  const source = Buffer.from(data)
  const format = source.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png'
    : source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff ? 'jpeg' : undefined
  if (!format) mismatch('The reference image bytes are not a PNG or JPEG image.')
  const mime = format === 'png' ? 'image/png' : 'image/jpeg'
  if ((extension && (extension === 'png' ? 'png' : 'jpeg') !== format) || (declaredMime && declaredMime !== mime)) {
    mismatch('The reference image extension, media type and actual content must agree.')
  }
  if (format === 'png') checkPng(source)
  else checkJpeg(source)

  // Installation errors are not malformed user files. Let the original import
  // failure surface with its actionable native-binary/package diagnostic.
  const { default: sharp } = await import('sharp')
  let metadata
  try {
    // metadata() does not decode pixels. Keep libvips' safety checks; our stricter
    // dimensions are checked below before allocating the decoded image buffer.
    metadata = await sharp(source, { failOn: 'warning', limitInputPixels: false }).metadata()
  } catch (cause) {
    mismatch('The reference image metadata is invalid.', cause)
  }
  const { width, height } = metadata
  if (metadata.format !== format || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    mismatch('The reference image has invalid dimensions or content type.')
  }
  if ((metadata.pages ?? 1) !== 1 || metadata.pageHeight !== undefined || metadata.loop !== undefined || metadata.delay !== undefined) {
    invalid('Reference images must contain one still image.')
  }
  if (width > REFERENCE_IMAGE_MAX_EDGE || height > REFERENCE_IMAGE_MAX_EDGE || width * height > REFERENCE_IMAGE_MAX_PIXELS) {
    throw new BlenderError(BlenderErrorCode.ASSET_TOO_LARGE, 'A reference image must be at most 16 megapixels and 8192 pixels on each side.', {
      detail: { width, height, maxPixels: REFERENCE_IMAGE_MAX_PIXELS, maxEdge: REFERENCE_IMAGE_MAX_EDGE },
    })
  }
  try {
    // raw().toBuffer() forces every pixel to be decoded; metadata alone accepts
    // some corrupt/truncated pixel streams. No encoded copy replaces the source.
    const { info } = await sharp(source, { failOn: 'warning', limitInputPixels: REFERENCE_IMAGE_MAX_PIXELS })
      .raw().toBuffer({ resolveWithObject: true })
    if (info.width !== width || info.height !== height) mismatch('The decoded reference image dimensions do not match its header.')
  } catch (cause) {
    if (cause instanceof BlenderError) throw cause
    mismatch('The reference image pixels cannot be completely decoded.', cause)
  }
  return {
    type: extension ?? (format === 'png' ? 'png' : 'jpg'), mime, width, height,
    bytes: source.length, sha256: createHash('sha256').update(source).digest('hex'),
  }
}
