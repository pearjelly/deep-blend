#!/usr/bin/env node
/**
 * M2 contract test — the PNG codec and the contact-sheet compositor.
 *
 * WHAT THIS HAS TO PROVE, AND WHY IT IS NOT "IT RUNS"
 * ---------------------------------------------------
 * The contact sheet is the ONE thing in M2 that a model actually looks at. Every
 * other artifact is either text or a number a test can compare; the sheet is pixels,
 * and a compositor bug produces a perfectly valid PNG that shows the wrong thing —
 * a mislabelled cell, a swapped pair, a tile drawn at half scale. None of those throw.
 *
 * So the assertions are about CONTENT:
 *
 *   - a synthetic PNG with known pixels decodes to exactly those pixels;
 *   - the encoder is lossless, asserted by a decode-encode-decode round trip;
 *   - every Adam7 pass reconstructs (written by hand here, because the only PNGs
 *     the product writes are non-interlaced and a decoder bug in the interlaced
 *     path would otherwise never be exercised);
 *   - a composed sheet really contains its views at the placements it reports, so a
 *     reviewer told "cell (row 2, column 1) is the detail view" is telling the truth.
 *
 * Run standalone: `node deepblend/tests/contract/png-sheet.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { deflateSync } from 'node:zlib'

import {
  CAPTION_BAND_COLOR,
  blendInto,
  composeContactSheet,
  createImage,
  decodePng,
  drawText,
  encodePng,
  fillRect,
  textWidth,
  viewCaption,
} from '@deepblend/dsh-blender-contracts'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

// ---------------------------------------------------------------------------
// A PNG writer that is deliberately independent of the code under test
// ---------------------------------------------------------------------------

/** Build a PNG by hand so the decoder is tested against something it did not write. */
function handmadePng(width, height, pixelAt) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y)
      const offset = y * (width * 4 + 1) + 1 + x * 4
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      raw[offset + 3] = a
    }
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  chunks.push(handmadeChunk('IHDR', ihdr))
  chunks.push(handmadeChunk('IDAT', deflateSync(raw)))
  chunks.push(handmadeChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

function handmadeChunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(handmadeCrc(Buffer.concat([body, payload])), 0)
  return Buffer.concat([length, body, payload, crc])
}

function handmadeCrc(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------

/** A pixel reader that names what it found, so a failure says which pixel is wrong. */
function pixelAt(image, x, y) {
  const offset = (y * image.width + x) * 4
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]]
}

// ---- decode ----------------------------------------------------------------

const handmade = handmadePng(4, 3, (x, y) => [x * 60, y * 80, 200, 255 - x * 10])
const decoded = decodePng(handmade)
check('a handmade 4x3 PNG decodes with the right dimensions',
  decoded.width === 4 && decoded.height === 3, { width: decoded.width, height: decoded.height })
check('decoded pixels are exactly the ones the file was built from',
  pixelAt(decoded, 0, 0).join(',') === '0,0,200,255' &&
  pixelAt(decoded, 3, 0).join(',') === '180,0,200,225' &&
  pixelAt(decoded, 2, 2).join(',') === '120,160,200,235',
  { origin: pixelAt(decoded, 0, 0), far: pixelAt(decoded, 2, 2) })

check('a buffer without the PNG signature is refused by name',
  (() => {
    try {
      decodePng(Buffer.from('not a png at all'))
      return false
    } catch (cause) {
      return /signature/.test(String(cause.message))
    }
  })())

check('a truncated PNG is refused rather than silently short-filled',
  (() => {
    try {
      decodePng(handmade.subarray(0, 30))
      return false
    } catch (cause) {
      return /truncated|IHDR|IDAT/.test(String(cause.message))
    }
  })())

// ---- the round trip --------------------------------------------------------

const solid = createImage(7, 5, [10, 20, 30, 255])
const reencoded = encodePng(solid)
const redecode = decodePng(reencoded)
check('createImage + encodePng + decodePng round-trips every pixel',
  redecode.width === 7 && redecode.height === 5 &&
  [...redecode.data].every((value, index) => value === solid.data[index]),
  { bytes: reencoded.length })

const gradient = createImage(5, 4, [0, 0, 0, 255])
for (let y = 0; y < gradient.height; y += 1) {
  for (let x = 0; x < gradient.width; x += 1) {
    const offset = (y * gradient.width + x) * 4
    gradient.data[offset] = x * 51
    gradient.data[offset + 1] = y * 64
    gradient.data[offset + 2] = (x + y) * 20
    gradient.data[offset + 3] = 255
  }
}
check('a gradient survives the codec unchanged (the encoder is lossless)',
  [...decodePng(encodePng(gradient)).data].every((value, index) => value === gradient.data[index]))

// ---- Adam7 ----------------------------------------------------------------

/**
 * Build an interlaced PNG by hand.
 *
 * The product never WRITES interlaced PNGs, so nothing else in the suite reaches
 * these seven passes. A test that only covers what we emit would leave a decoder
 * path that claims support and has never run once — and the day a renderer or a
 * user-supplied image arrives interlaced is the day that shows up as garbage.
 */
function interlacedPng(width, height, pixelAt) {
  const passes = []
  for (const pass of [
    [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
  ]) {
    const [xStart, yStart, xStep, yStep] = pass
    const passWidth = width <= xStart ? 0 : Math.ceil((width - xStart) / xStep)
    const passHeight = height <= yStart ? 0 : Math.ceil((height - yStart) / yStep)
    passes.push({ passWidth, passHeight, xStart, yStart, xStep, yStep })
  }

  const buffers = []
  for (const pass of passes) {
    if (pass.passWidth === 0 || pass.passHeight === 0) continue
    const raw = Buffer.alloc((pass.passWidth * 4 + 1) * pass.passHeight)
    for (let py = 0; py < pass.passHeight; py += 1) {
      raw[py * (pass.passWidth * 4 + 1)] = 0
      for (let px = 0; px < pass.passWidth; px += 1) {
        const x = pass.xStart + px * pass.xStep
        const y = pass.yStart + py * pass.yStep
        const [r, g, b, a] = pixelAt(x, y)
        const offset = py * (pass.passWidth * 4 + 1) + 1 + px * 4
        raw[offset] = r
        raw[offset + 1] = g
        raw[offset + 2] = b
        raw[offset + 3] = a
      }
    }
    buffers.push(raw)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[12] = 1 // Adam7
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    handmadeChunk('IHDR', ihdr),
    handmadeChunk('IDAT', deflateSync(Buffer.concat(buffers))),
    handmadeChunk('IEND', Buffer.alloc(0)),
  ])
}

const interlacedSource = (x, y) => [x * 30, y * 40, 90, 255]
const interlaced = decodePng(interlacedPng(9, 7, interlacedSource))
let interlacedMismatches = 0
for (let y = 0; y < 7; y += 1) {
  for (let x = 0; x < 9; x += 1) {
    const expected = interlacedSource(x, y)
    const actual = pixelAt(interlaced, x, y)
    if (expected.join(',') !== actual.join(',')) interlacedMismatches += 1
  }
}
check('an interlaced PNG reconstructs every pixel through all seven Adam7 passes',
  interlaced.width === 9 && interlaced.height === 7 && interlacedMismatches === 0,
  { mismatches: interlacedMismatches })

// ---- filters ---------------------------------------------------------------

/**
 * A filter-type sweep: the same image written with each of the five scanline
 * filters must decode identically. Blender writes whichever filter its encoder
 * prefers per row, so a decoder that only handles "none" would fail on real renders
 * — the format allows all five and a real encoder uses several.
 */
function filteredPng(width, height, pixelAt, filterFor) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const filterType = filterFor(y)
    raw[y * (stride + 1)] = filterType
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y)
      const line = [r, g, b, a]
      for (let channel = 0; channel < 4; channel += 1) {
        const index = x * 4 + channel
        const left = x > 0 ? [pixelAt(x - 1, y)][0][channel] : 0
        const up = y > 0 ? [pixelAt(x, y - 1)][0][channel] : 0
        const upLeft = x > 0 && y > 0 ? [pixelAt(x - 1, y - 1)][0][channel] : 0
        let value = line[channel]
        if (filterType === 1) value -= left
        else if (filterType === 2) value -= up
        else if (filterType === 3) value -= (left + up) >> 1
        else if (filterType === 4) {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value -= pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft)
        }
        raw[y * (stride + 1) + 1 + index] = value & 0xff
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    handmadeChunk('IHDR', ihdr),
    handmadeChunk('IDAT', deflateSync(raw)),
    handmadeChunk('IEND', Buffer.alloc(0)),
  ])
}

const filterSource = (x, y) => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 61) & 0xff, (x * x + y * 3) & 0xff, 255]
let filterMismatches = 0
for (const filterType of [0, 1, 2, 3, 4]) {
  const image = decodePng(filteredPng(8, 6, filterSource, () => filterType))
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (filterSource(x, y).join(',') !== pixelAt(image, x, y).join(',')) filterMismatches += 1
    }
  }
}
check('all five PNG scanline filters decode to the same image',
  filterMismatches === 0, { mismatches: filterMismatches })

// ---- primitives ------------------------------------------------------------

const canvas = createImage(20, 20, [0, 0, 0, 255])
fillRect(canvas, { x: 5, y: 5, width: 10, height: 10 }, [255, 0, 0, 255])
check('fillRect writes exactly its rectangle and nothing outside it',
  pixelAt(canvas, 4, 4).join(',') === '0,0,0,255' &&
  pixelAt(canvas, 5, 5).join(',') === '255,0,0,255' &&
  pixelAt(canvas, 14, 14).join(',') === '255,0,0,255' &&
  pixelAt(canvas, 15, 15).join(',') === '0,0,0,255')

const fillTarget = createImage(6, 6, [0, 0, 0, 255])
fillRect(fillTarget, { x: -3, y: -3, width: 6, height: 6 }, [9, 9, 9, 255])
check('a rectangle that starts off-canvas is clipped, not wrapped',
  pixelAt(fillTarget, 0, 0).join(',') === '9,9,9,255' && pixelAt(fillTarget, 3, 3).join(',') === '0,0,0,255')

// ---- text ------------------------------------------------------------------

check('drawText renders a known glyph and leaves the background alone',
  (() => {
    const target = createImage(12, 9, [0, 0, 0, 255])
    drawText(target, 'I', 1, 1, [255, 255, 255, 255], 1)
    // 'I' is a bar with serifs: its middle row (row 3 of the glyph) is lit at the
    // centre column, and the pixel to its right is not.
    return pixelAt(target, 1 + 2, 1 + 3).join(',') === '255,255,255,255' &&
      pixelAt(target, 1 + 4, 1 + 3).join(',') === '0,0,0,255'
  })())

check('drawText uppercases rather than drawing blanks for lowercase',
  (() => {
    const upper = createImage(12, 9, [0, 0, 0, 255])
    const lower = createImage(12, 9, [0, 0, 0, 255])
    drawText(upper, 'A', 1, 1, [255, 255, 255, 255], 1)
    drawText(lower, 'a', 1, 1, [255, 255, 255, 255], 1)
    return [...upper.data].join(',') === [...lower.data].join(',')
  })())

check('an unknown character falls back to a visible glyph instead of a blank',
  (() => {
    const target = createImage(12, 9, [0, 0, 0, 255])
    drawText(target, '\u00e9', 1, 1, [255, 255, 255, 255], 1)
    return target.data.some(value => value === 255)
  })())

check('textWidth agrees with the advance drawText actually uses',
  (() => {
    // The caption band is sized from `textWidth`, so a disagreement would silently
    // overflow the band and clip a label.
    const target = createImage(200, 9, [0, 0, 0, 255])
    drawText(target, 'ABC', 1, 1, [255, 255, 255, 255], 1)
    let lastLit = -1
    for (let x = 0; x < target.width; x += 1) {
      for (let y = 0; y < target.height; y += 1) {
        if (pixelAt(target, x, y)[0] === 255) lastLit = Math.max(lastLit, x)
      }
    }
    // The last glyph's rightmost lit column is its own last column, so the last lit
    // pixel sits at exactly `textWidth - 1` when the text starts at x = 1. A width
    // that disagreed with the advance would put a caption's tail outside its band.
    return lastLit === textWidth('ABC', 1)
  })())

// ---- captions --------------------------------------------------------------

check('view captions shorten long role names instead of truncating them',
  viewCaption({ role: 'three-quarter', cameraId: 'camera-top', frame: 22 }) === '3Q:CAMERA-TOP F22',
  viewCaption({ role: 'three-quarter', cameraId: 'camera-top', frame: 22 }))
check('a caption with no frame omits the frame rather than printing Fnull',
  viewCaption({ role: 'top', cameraId: 'camera-top', frame: null }) === 'TOP:CAMERA-TOP')

// ---- the sheet -------------------------------------------------------------

/** A view whose pixels are a single flat colour, so its cell is identifiable. */
function colouredView(viewId, width, height, color) {
  return { viewId, label: viewId.toUpperCase(), png: encodePng(createImage(width, height, color)) }
}

const sheet = composeContactSheet({
  views: [
    colouredView('red', 20, 10, [255, 0, 0, 255]),
    colouredView('green', 20, 10, [0, 255, 0, 255]),
    colouredView('blue', 20, 10, [0, 0, 255, 255]),
    colouredView('white', 20, 10, [255, 255, 255, 255]),
  ],
  columns: 2,
  scale: 2,
  title: 'SHEET',
})
check('a 2x2 sheet of 20x10 tiles composes at the expected size',
  sheet.columns === 2 && sheet.rows === 2 && sheet.width === 20 * 2 * 2 + 2 * 20 + 16 &&
  sheet.height === 20 * 2 + 2 * (30 + 20) + 16 + 30,
  { width: sheet.width, height: sheet.height })

const sheetImage = decodePng(sheet.png)
check('the composed sheet decodes back to the size it reports',
  sheetImage.width === sheet.width && sheetImage.height === sheet.height)

/**
 * THE assertion this file exists for: the colour in each cell is the view the
 * placement table says it is. A sheet that renders beautifully with its tiles swapped
 * would send a reviewer to patch the wrong camera.
 */
const expectedColours = {
  red: '255,0,0,255',
  green: '0,255,0,255',
  blue: '0,0,255,255',
  white: '255,255,255,255',
}
let placementFailures = []
for (const placement of sheet.placements) {
  const [left, top, right, bottom] = placement.box
  const centreX = Math.floor(((left + right) / 2) * sheet.width)
  const centreY = Math.floor(((top + bottom) / 2) * sheet.height)
  const found = pixelAt(sheetImage, centreX, centreY).join(',')
  if (found !== expectedColours[placement.viewId]) {
    placementFailures.push(`${placement.viewId} at centre (${centreX},${centreY}) is ${found}`)
  }
}
check('every placement box really contains the view it names',
  placementFailures.length === 0, placementFailures)

check('placements are reported in reading order, left to right then down',
  sheet.placements.map(entry => `${entry.row}:${entry.column}:${entry.viewId}`).join(' ') ===
  '0:0:red 0:1:green 1:0:blue 1:1:white',
  sheet.placements.map(entry => entry.viewId))

check('each tile has a caption band above it that does not overlap the tile',
  (() => {
    const failures = []
    for (const placement of sheet.placements) {
      const [left, top, right, bottom] = placement.captionBox
      const centreX = Math.floor(((left + right) / 2) * sheet.width)
      const centreY = Math.floor(((top + bottom) / 2) * sheet.height)
      const band = pixelAt(sheetImage, centreX, centreY).join(',')
      if (band !== CAPTION_BAND_COLOR.join(',')) failures.push(`${placement.viewId} band is ${band}`)
      // And the band stops before the tile starts.
      if (placement.captionBox[3] > placement.box[1]) failures.push(`${placement.viewId} band overlaps its tile`)
    }
    return failures.length === 0 ? true : failures
  })())

check('a contact sheet with no views is refused by name',
  (() => {
    try {
      composeContactSheet({ views: [] })
      return false
    } catch (cause) {
      return /at least one view/.test(String(cause.message))
    }
  })())

check('a view whose bytes are missing is refused rather than drawn as blank',
  (() => {
    try {
      composeContactSheet({ views: [{ viewId: 'x', png: null }] })
      return false
    } catch (cause) {
      return /no PNG bytes/.test(String(cause.message))
    }
  })())

check('blendInto scales a tile to fill its box exactly',
  (() => {
    const source = createImage(4, 4, [200, 100, 50, 255])
    const target = createImage(8, 8, [0, 0, 0, 255])
    blendInto(source, target, { x: 0, y: 0, width: 8, height: 8 })
    return [...target.data].every((value, index) => value === [200, 100, 50, 255][index % 4])
  })())

// ---- summary ---------------------------------------------------------------

const failed = results.filter(entry => !entry.ok).length
console.log('')
console.log(`PNG + contact sheet contract: ${results.length - failed}/${results.length} check(s) passed`)
process.exit(failed === 0 ? 0 : 1)
