/**
 * A minimal PNG codec: enough to read Blender's renders and write a contact sheet.
 *
 * WHY HAND-ROLLED
 * ---------------
 * The contact sheet is a real product artifact, and every image library is either
 * a native dependency (a build step and a platform matrix for a package that must
 * stay pure ESM — D4) or a large pure-JS dependency that would still need to be
 * vendored into the profile's module tree. The actual requirement is narrow: read
 * 8-bit PNG in the five colour types Blender emits, composite rectangles, write
 * 8-bit RGBA PNG. `node:zlib` supplies the only hard part (DEFLATE) and the rest is
 * arithmetic over a `Buffer`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * Blender 5.2's `bpy.data.images` reads and writes PNGs (`save_render`, `save_as`),
 * so a second encoder is only justified by where it has to run: the sheet is
 * composed on the Node side, where the view measurements and the artifact index
 * already are, and where a Python round trip would mean another Blender launch per
 * review round. Two encoders would be worse than one — so this one owns the sheet
 * entirely and Blender never touches it.
 *
 * Interlacing (Adam7) IS supported on read because it is cheap once the pass
 * geometry is written down, and because "unsupported input" that only appears on
 * someone else's machine is the worst kind of gap.
 *
 * Owner: DeepBlend Studio — M2
 */

import { deflateSync, inflateSync } from 'node:zlib'

/** PNG signature. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Bytes per pixel for each supported colour type (at bit depth 8/16). */
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Adam7 interlace pass geometry: x start/step and y start/step per pass. */
const ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
]

/**
 * @typedef {object} RgbaImage
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} data - RGBA, 4 bytes per pixel, row-major, top-down.
 */

/**
 * Decode a PNG buffer into an RGBA image.
 *
 * @param {Buffer} buffer
 * @returns {RgbaImage}
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: the 8-byte signature is missing')
  }

  let offset = 8
  let header = null
  let palette = null
  let transparency = null
  const idat = []

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('truncated PNG: incomplete chunk header')
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) throw new Error(`truncated PNG: chunk ${type} claims ${length} bytes`)

    if (type === 'IHDR') header = parseHeader(buffer.subarray(start, end))
    else if (type === 'PLTE') palette = Buffer.from(buffer.subarray(start, end))
    else if (type === 'tRNS') transparency = Buffer.from(buffer.subarray(start, end))
    else if (type === 'IDAT') idat.push(Buffer.from(buffer.subarray(start, end)))
    else if (type === 'IEND') break

    offset = end + 4 // skip the CRC; the decode below is the real check
  }

  if (header === null) throw new Error('PNG has no IHDR chunk')
  if (idat.length === 0) throw new Error('PNG has no IDAT data')

  const { width, height, bitDepth, colorType, interlace } = header
  if (!(colorType in CHANNELS_BY_COLOR_TYPE)) {
    throw new Error(`unsupported PNG colour type ${colorType}`)
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`unsupported PNG bit depth ${bitDepth}`)
  }
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  const bytesPerSample = bitDepth / 8
  const raw = inflateSync(Buffer.concat(idat))

  const image = { width, height, data: new Uint8Array(width * height * 4) }

  if (interlace === 0) {
    const stride = width * channels * bytesPerSample
    const unfiltered = unfilter(raw, height, stride, channels * bytesPerSample)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        writePixel(image, x, y, readPixel(unfiltered, y * stride + x * channels * bytesPerSample, colorType, bitDepth, palette, transparency))
      }
    }
    return image
  }

  // Adam7: each pass is an independent image with its own scanline filters.
  let cursor = 0
  for (const pass of ADAM7) {
    const passWidth = passColumns(width, pass.xStart, pass.xStep)
    const passHeight = passColumns(height, pass.yStart, pass.yStep)
    if (passWidth === 0 || passHeight === 0) continue
    const passStride = passWidth * channels * bytesPerSample
    const passBytes = (passStride + 1) * passHeight
    const chunk = raw.subarray(cursor, cursor + passBytes)
    cursor += passBytes
    const unfiltered = unfilter(chunk, passHeight, passStride, channels * bytesPerSample)
    for (let py = 0; py < passHeight; py += 1) {
      for (let px = 0; px < passWidth; px += 1) {
        const x = pass.xStart + px * pass.xStep
        const y = pass.yStart + py * pass.yStep
        if (x >= width || y >= height) continue
        writePixel(image, x, y, readPixel(unfiltered, py * passStride + px * channels * bytesPerSample, colorType, bitDepth, palette, transparency))
      }
    }
  }
  return image
}

/**
 * Encode an RGBA image as an 8-bit truecolour PNG.
 *
 * @param {RgbaImage} image
 * @returns {Buffer}
 */
export function encodePng(image) {
  const { width, height, data } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`cannot encode a ${width}x${height} image`)
  }
  if (data.length < width * height * 4) {
    throw new Error(`pixel buffer is ${data.length} bytes, need ${width * height * 4}`)
  }

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0 // filter type 0: none. The sheet is written once and read by a decoder here.
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, rowStart + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Create a blank RGBA image filled with one colour.
 *
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number, number]} color
 * @returns {RgbaImage}
 */
export function createImage(width, height, color) {
  const data = new Uint8Array(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = color[0]
    data[index + 1] = color[1]
    data[index + 2] = color[2]
    data[index + 3] = color[3]
  }
  return { width, height, data }
}

/**
 * Copy a rectangle of pixels from one image into another, scaling as needed.
 *
 * Scaling is a box filter (area average) when shrinking and nearest-neighbour when
 * growing. The box filter matters: a contact sheet's whole purpose is to be
 * downscaled by the model's own request pipeline, and nearest-neighbour downscale
 * first would turn thin features into aliased speckle that reads as noise.
 *
 * @param {RgbaImage} source
 * @param {RgbaImage} target
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
export function blendInto(source, target, box) {
  const { x: originX, y: originY, width: boxWidth, height: boxHeight } = box
  if (boxWidth <= 0 || boxHeight <= 0) return
  const scaleX = source.width / boxWidth
  const scaleY = source.height / boxHeight

  for (let y = 0; y < boxHeight; y += 1) {
    const targetY = originY + y
    if (targetY < 0 || targetY >= target.height) continue
    const sourceTop = y * scaleY
    const sourceBottom = Math.min(source.height, Math.max(sourceTop + 1, (y + 1) * scaleY))
    for (let x = 0; x < boxWidth; x += 1) {
      const targetX = originX + x
      if (targetX < 0 || targetX >= target.width) continue
      const sourceLeft = x * scaleX
      const sourceRight = Math.min(source.width, Math.max(sourceLeft + 1, (x + 1) * scaleX))

      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      let count = 0
      const firstY = Math.floor(sourceTop)
      const lastY = Math.max(firstY + 1, Math.ceil(sourceBottom))
      const firstX = Math.floor(sourceLeft)
      const lastX = Math.max(firstX + 1, Math.ceil(sourceRight))
      for (let sy = firstY; sy < lastY && sy < source.height; sy += 1) {
        for (let sx = firstX; sx < lastX && sx < source.width; sx += 1) {
          const offset = (sy * source.width + sx) * 4
          red += source.data[offset]
          green += source.data[offset + 1]
          blue += source.data[offset + 2]
          alpha += source.data[offset + 3]
          count += 1
        }
      }
      if (count === 0) continue
      const offset = (targetY * target.width + targetX) * 4
      target.data[offset] = Math.round(red / count)
      target.data[offset + 1] = Math.round(green / count)
      target.data[offset + 2] = Math.round(blue / count)
      target.data[offset + 3] = Math.round(alpha / count)
    }
  }
}

/**
 * Fill a rectangle with one colour (source-over, opaque).
 *
 * @param {RgbaImage} image
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {[number, number, number, number]} color
 */
export function fillRect(image, box, color) {
  const left = Math.max(0, Math.floor(box.x))
  const top = Math.max(0, Math.floor(box.y))
  const right = Math.min(image.width, Math.ceil(box.x + box.width))
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height))
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4
      image.data[offset] = color[0]
      image.data[offset + 1] = color[1]
      image.data[offset + 2] = color[2]
      image.data[offset + 3] = color[3]
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Parse the IHDR payload.
 * @param {Buffer} payload
 */
function parseHeader(payload) {
  if (payload.length < 13) throw new Error('IHDR chunk is short')
  return {
    width: payload.readUInt32BE(0),
    height: payload.readUInt32BE(4),
    bitDepth: payload[8],
    colorType: payload[9],
    compression: payload[10],
    filter: payload[11],
    interlace: payload[12],
  }
}

/**
 * Wrap a payload in a PNG chunk with its CRC.
 * @param {string} type
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const typeBuffer = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])), 0)
  return Buffer.concat([length, typeBuffer, payload, crc])
}

/** CRC-32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Number of columns one Adam7 pass covers. */
function passColumns(size, start, step) {
  if (size <= start) return 0
  return Math.ceil((size - start) / step)
}

/**
 * Reverse PNG scanline filtering.
 *
 * @param {Buffer} raw - the inflated IDAT stream, filter byte per scanline.
 * @param {number} height
 * @param {number} stride - bytes per scanline, excluding the filter byte.
 * @param {number} bytesPerPixel
 * @returns {Buffer} the unfiltered scanlines, still without filter bytes.
 */
function unfilter(raw, height, stride, bytesPerPixel) {
  const output = Buffer.alloc(stride * height)
  let previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    if (cursor + 1 + stride > raw.length) {
      throw new Error('PNG image data ended before the last scanline')
    }
    const filterType = raw[cursor]
    const line = raw.subarray(cursor + 1, cursor + 1 + stride)
    const target = output.subarray(y * stride, (y + 1) * stride)
    cursor += 1 + stride

    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? target[index - bytesPerPixel] : 0
      const up = previous[index]
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0
      const value = line[index]
      let restored
      switch (filterType) {
        case 0: restored = value; break
        case 1: restored = value + left; break
        case 2: restored = value + up; break
        case 3: restored = value + ((left + up) >> 1); break
        case 4: restored = value + paeth(left, up, upLeft); break
        default: throw new Error(`unknown PNG filter type ${filterType} on scanline ${y}`)
      }
      target[index] = restored & 0xff
    }
    previous = target
  }
  return output
}

/** The PNG Paeth predictor. */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Read one pixel out of an unfiltered scanline as RGBA.
 *
 * @param {Buffer} line
 * @param {number} offset
 * @param {number} colorType
 * @param {number} bitDepth
 * @param {Buffer|null} palette
 * @param {Buffer|null} transparency
 * @returns {[number, number, number, number]}
 */
function readPixel(line, offset, colorType, bitDepth, palette, transparency) {
  const sample = index => (bitDepth === 16 ? line[offset + index * 2] : line[offset + index])
  switch (colorType) {
    case 0: {
      const grey = sample(0)
      return [grey, grey, grey, 255]
    }
    case 2:
      return [sample(0), sample(1), sample(2), 255]
    case 3: {
      const index = sample(0)
      if (palette === null || index * 3 + 2 >= palette.length) return [0, 0, 0, 255]
      const alpha = transparency !== null && index < transparency.length ? transparency[index] : 255
      return [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], alpha]
    }
    case 4: {
      const grey = sample(0)
      return [grey, grey, grey, sample(1)]
    }
    case 6:
      return [sample(0), sample(1), sample(2), sample(3)]
    default:
      // NOT the same sentence the decoder throws for an unsupported type (`unsupported PNG colour type N`,
      // raised before any pixel is read): this one is unreachable unless that check is bypassed, so saying
      // the same thing here would be a second copy of a message nobody can reach — and would read as if this
      // were the place that decides which types are supported.
      throw new Error(`readPixel was called with colour type ${colorType}, which the decoder refuses before reading any pixel`)
  }
}

/**
 * Store one RGBA pixel.
 * @param {RgbaImage} image
 * @param {number} x
 * @param {number} y
 * @param {[number, number, number, number]} pixel
 */
function writePixel(image, x, y, pixel) {
  const offset = (y * image.width + x) * 4
  image.data[offset] = pixel[0]
  image.data[offset + 1] = pixel[1]
  image.data[offset + 2] = pixel[2]
  image.data[offset + 3] = pixel[3]
}
