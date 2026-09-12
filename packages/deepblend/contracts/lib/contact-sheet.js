/**
 * Contact-sheet composition: many preview views into one image, with labels.
 *
 * WHY A SHEET AND NOT N IMAGES
 * ----------------------------
 * Measured in the M2 probe (`runtime-audit.md` §7.2.3): one 640x360 view costs 177
 * vision tokens and a 2x2 sheet costs 369. Token cost is therefore NOT the reason
 * to prefer a sheet — the reason is that the model's per-request pixel budget
 * (640 000 px) downscales whatever is sent, and a sheet is the only way to answer a
 * *relational* question ("is the subject off-centre, is anything in front of it")
 * from one look. The numbers that decide detail questions are the measurements,
 * which travel as text.
 *
 * The layout is chosen so the sheet survives that downscale with each tile at or
 * above the resolution of the views that went into it: a 2x2 sheet of 640x360 views
 * is composed at 2x and lands at roughly 1:1 after the model's own resize. A 3x3
 * sheet would land below 1:1 and would make a partial occlusion look like no
 * occlusion at all — which is worse than not showing it.
 *
 * Owner: DeepBlend Studio — M2
 */

import { blendInto, createImage, decodePng, encodePng, fillRect } from './png.js'
import { drawText } from './bitmap-font.js'

/** Sheet background: a neutral mid-dark grey, so neither a black nor a white render
 *  appears to bleed into its neighbour. */
const BACKGROUND = [24, 24, 28, 255]
/** Cell caption band. Exported so a reader can identify a band without guessing. */
export const CAPTION_BAND_COLOR = [12, 12, 16, 255]
const CAPTION_BAND = CAPTION_BAND_COLOR
/** Cell caption text. */
const CAPTION_TEXT = [232, 232, 236, 255]
/** The border that separates two adjacent renders. */
const BORDER = [96, 96, 104, 255]

/** Layout constants, in output pixels. */
const MARGIN = 20
const GAP = 16
const CAPTION_HEIGHT = 30
const CAPTION_SCALE = 2
const BORDER_WIDTH = 2
/** Target sheet width before the layout is fitted to the grid. */
const TARGET_WIDTH = 1600

/**
 * @typedef {object} SheetView
 * @property {string} viewId - the id the tool and the measurements use.
 * @property {string} [label] - caption text; defaults to the view id.
 * @property {Buffer} png - the rendered PNG bytes.
 */

/**
 * @typedef {object} SheetPlacement
 * @property {string} viewId
 * @property {string} label - the caption as DRAWN (the font has one case).
 * @property {number} column - 0-based column in the grid.
 * @property {number} row - 0-based row in the grid.
 * @property {[number, number, number, number]} box - normalized [left, top, right, bottom]
 *   of the IMAGE TILE, so a caller can talk about "the tile at ..." without pixels.
 * @property {[number, number, number, number]} captionBox - normalized box of the
 *   caption band above the tile. Reported separately rather than left to be derived:
 *   a caller that recomputes the layout is a second implementation of it, and the one
 *   that drifts is always the copy nobody draws.
 */

/**
 * Compose a contact sheet.
 *
 * @param {object} input
 * @param {SheetView[]} input.views - in reading order (left to right, then down).
 * @param {number} [input.columns] - grid columns; defaults to a near-square grid.
 * @param {number} [input.scale] - tile upscale factor; defaults to the largest
 *   power of two that keeps the sheet near {@link TARGET_WIDTH}.
 * @param {string} [input.title] - drawn top-left above the grid when present.
 * @returns {{ png: Buffer, width: number, height: number, columns: number, rows: number, placements: SheetPlacement[] }}
 */
export function composeContactSheet(input) {
  const views = input?.views ?? []
  if (views.length === 0) throw new Error('a contact sheet needs at least one view')

  const decoded = views.map(view => {
    if (!Buffer.isBuffer(view.png)) throw new Error(`view "${view.viewId}" has no PNG bytes`)
    return { view, image: decodePng(view.png) }
  })

  // The first view defines the tile size. Views in one sheet come from one render
  // plan, so they share a resolution; taking the first and scaling the rest to fit
  // keeps a stray view from reflowing the whole grid.
  const tileWidth = decoded[0].image.width
  const tileHeight = decoded[0].image.height
  if (tileWidth <= 0 || tileHeight <= 0) throw new Error('the first view decoded to an empty image')

  const columns = clampInteger(input.columns ?? Math.ceil(Math.sqrt(views.length)), 1, views.length)
  const rows = Math.ceil(views.length / columns)
  const scale = clampInteger(input.scale ?? defaultScale(columns, tileWidth), 1, 8)

  const cellWidth = tileWidth * scale
  const cellHeight = tileHeight * scale
  const titleHeight = typeof input.title === 'string' && input.title.length > 0
    ? CAPTION_HEIGHT
    : 0

  const width = MARGIN * 2 + columns * cellWidth + (columns - 1) * GAP
  const height = MARGIN * 2 + titleHeight + rows * (CAPTION_HEIGHT + cellHeight) + (rows - 1) * GAP

  const sheet = createImage(width, height, BACKGROUND)
  if (titleHeight > 0) {
    drawText(sheet, input.title, MARGIN, MARGIN - 4, CAPTION_TEXT, CAPTION_SCALE)
  }

  /** @type {SheetPlacement[]} */
  const placements = []
  decoded.forEach((entry, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = MARGIN + column * (cellWidth + GAP)
    const top = MARGIN + titleHeight + row * (CAPTION_HEIGHT + cellHeight + GAP)
    const label = entry.view.label ?? entry.view.viewId

    fillRect(sheet, { x: left, y: top, width: cellWidth, height: CAPTION_HEIGHT }, CAPTION_BAND)
    drawText(sheet, label, left + 6, top + 8, CAPTION_TEXT, CAPTION_SCALE)

    const imageTop = top + CAPTION_HEIGHT
    // A border, not a gap: two renders of the same scene differ along their shared
    // edge most of all, and an unseparated pair reads as one wide image.
    fillRect(sheet, { x: left, y: imageTop, width: cellWidth, height: cellHeight }, BORDER)
    blendInto(entry.image, sheet, {
      x: left + BORDER_WIDTH,
      y: imageTop + BORDER_WIDTH,
      width: cellWidth - BORDER_WIDTH * 2,
      height: cellHeight - BORDER_WIDTH * 2,
    })

    placements.push({
      viewId: entry.view.viewId,
      label: label.toUpperCase(),
      column,
      row,
      captionBox: [
        round(left / width),
        round(top / height),
        round((left + cellWidth) / width),
        round((top + CAPTION_HEIGHT) / height),
      ],
      box: [
        round(left / width),
        round(imageTop / height),
        round((left + cellWidth) / width),
        round((imageTop + cellHeight) / height),
      ],
    })
  })

  return {
    png: encodePng(sheet),
    width,
    height,
    columns,
    rows,
    placements,
  }
}

/**
 * The largest power of two that keeps a sheet near the target width.
 *
 * Measured against the REQUEST pixel budget, not against aesthetics: a sheet wider
 * than the budget is downscaled by the model pipeline, so upscaling past the point
 * where the downscale lands at 1:1 adds bytes and no detail.
 *
 * @param {number} columns
 * @param {number} tileWidth
 * @returns {number}
 */
function defaultScale(columns, tileWidth) {
  const perTile = TARGET_WIDTH / columns
  let scale = 1
  while (scale * 2 * tileWidth <= perTile && scale < 8) scale *= 2
  return scale
}

/**
 * Clamp an integer option into a range, tolerating absent or fractional input.
 * @param {unknown} value
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 */
function clampInteger(value, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return minimum
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)))
}

/** Round to six decimals: enough to locate a tile, small enough to read. */
function round(value) {
  return Math.round(value * 1e6) / 1e6
}

/** Role names shortened to what the 26-character caption band can hold. */
const CAPTION_ROLE_ALIASES = Object.freeze({
  'active-camera': 'ACTIVE',
  'three-quarter': '3Q',
  top: 'TOP',
  detail: 'DETAIL',
  front: 'FRONT',
  side: 'SIDE',
  back: 'BACK',
})

/**
 * A short caption for one view that fits the band.
 *
 * The long role names are shortened rather than truncated, because a truncated
 * caption is the one thing a label must not be: `THREE-QUARTER:CAMERA-T~` tells a
 * reviewer less than `3Q:CAMERA-TOP` while looking like it told them something.
 *
 * @param {object} view - a view entry from a render plan.
 * @returns {string}
 */
export function viewCaption(view) {
  const role = typeof view.role === 'string' && view.role.length > 0 ? view.role : null
  const camera = String(view.cameraId ?? view.viewId ?? 'view')
  const frame = view.frame ?? null
  const label = role === null ? camera : `${CAPTION_ROLE_ALIASES[role] ?? role}:${camera}`
  const caption = frame === null ? label : `${label} F${frame}`
  // Uppercased here rather than at draw time so the string a caller sees IS the string
  // on the sheet. A caption that reads "3Q:camera-top" to a human and "3Q:CAMERA-TOP"
  // to the font is two representations of one label, which is how a reviewer ends up
  // quoting a view id that nothing else uses.
  return caption.toUpperCase()
}
