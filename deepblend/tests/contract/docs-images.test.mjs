#!/usr/bin/env node
/**
 * Documentation-images contract test — the pictures are claims too.
 *
 * WHY THIS EXISTS
 * ---------------
 * A screenshot in a README says "this is what the thing looks like". Of all the claims
 * this repository makes, that one had the least behind it: the pictures are produced by
 * `deepblend/tools/capture-docs-images.mjs` from a real `dsh web`, a real Chrome and a
 * real Blender, and until this file existed nothing noticed if they were replaced, went
 * blank, or were never referenced by anything.
 *
 * The failure mode is quiet in a way the others are not. A screenshot of a page that
 * failed to render is a PERFECTLY VALID PNG — right size, right format, right digest —
 * and it would sit in the README looking like evidence. So the checks here are about
 * pixels, not just files:
 *
 *   1. the manifest describes every image, and the tool that wrote the manifest exists;
 *   2. each image is byte-for-byte what the manifest recorded, at the size it recorded;
 *   3. each image decodes, is fully opaque, and carries far more distinct colours than a
 *      blank or half-rendered page can;
 *   4. every image is referenced from README.md with non-empty alt text, and every image
 *      README.md references exists — a 300 KiB PNG nobody links to is dead weight in a
 *      clone, which is the one cost this repository cannot test away.
 *
 * WHAT IT CANNOT CHECK
 * --------------------
 * Whether the picture is a GOOD picture — whether the panel it shows is the panel worth
 * showing. That judgement is in the tool's own comments, next to the code that makes it.
 *
 * Run: node deepblend/tests/contract/docs-images.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { decodePng } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const DIR = join(ROOT, 'deepblend', 'docs', 'images')
const MANIFEST_PATH = join(DIR, 'manifest.json')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const files = readdirSync(DIR).filter(name => name.endsWith('.png')).sort()

/**
 * The fewest distinct colours a real screenshot of this UI can contain.
 *
 * MEASURED, NOT GUESSED. At `SAMPLE_STRIDE` these three pictures carry 773, 4798 and 6039
 * distinct colours; the sparsest is the workbench, because a page of mostly white panel is
 * mostly two colours and a handful of greys. A page that failed to render carries ONE, and
 * a page that rendered its shell but not its panel carries a few dozen. The floor sits
 * between the two populations with a wide margin on both sides, because its job is to
 * catch "this is not a picture of anything" rather than to be tight — and the control
 * below proves the metric can fail at all.
 */
const MINIMUM_COLOURS = 500

/** How many pixels are sampled per image, as a stride over the RGBA buffer. */
const SAMPLE_STRIDE = 16

/** Distinct colours, opacity and the dominant colour's share, from a decoded PNG. */
function describeImage(buffer) {
  return describeImageFrom(decodePng(buffer))
}

/** The same reading, from an already-decoded RGBA image. */
function describeImageFrom(image) {
  const counts = new Map()
  let opaque = true
  let sampled = 0
  for (let offset = 0; offset + 3 < image.data.length; offset += 4 * SAMPLE_STRIDE) {
    const key = (image.data[offset] << 24) | (image.data[offset + 1] << 16) | (image.data[offset + 2] << 8) | image.data[offset + 3]
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (image.data[offset + 3] !== 255) opaque = false
    sampled += 1
  }
  const dominant = Math.max(...counts.values())
  return { width: image.width, height: image.height, colours: counts.size, opaque, sampled, dominantShare: dominant / sampled }
}

test('the manifest exists, parses, and names the tool that wrote it', () => {
  assert.ok(existsSync(MANIFEST_PATH), 'deepblend/docs/images/manifest.json is missing; re-run the capture tool')
  assert.equal(manifest.tool, 'deepblend/tools/capture-docs-images.mjs', 'the manifest does not name the tool that produces these images')
  assert.ok(
    existsSync(join(ROOT, manifest.tool)),
    `the manifest names ${manifest.tool}, which does not exist — the pictures can no longer be reproduced`,
  )
  assert.ok(Array.isArray(manifest.images) && manifest.images.length > 0, 'the manifest lists no images')
})

test('every image in the directory is in the manifest, and the other way round', () => {
  assert.deepEqual(
    manifest.images.map(entry => entry.file).sort(),
    files,
    'the PNGs on disk and the entries in the manifest are not the same set — an image added or removed by hand',
  )
})

test('every image is byte-for-byte what the manifest recorded', () => {
  for (const entry of manifest.images) {
    const bytes = readFileSync(join(DIR, entry.file))
    const digest = createHash('sha256').update(bytes).digest('hex')
    assert.equal(digest, entry.sha256, `${entry.file} does not match the digest the capture tool recorded`)
    assert.equal(bytes.length, entry.bytes, `${entry.file} is ${bytes.length} bytes; the manifest recorded ${entry.bytes}`)
    assert.equal(bytes.readUInt32BE(16), entry.width, `${entry.file} is not the width the manifest recorded`)
    assert.equal(bytes.readUInt32BE(20), entry.height, `${entry.file} is not the height the manifest recorded`)
    assert.ok(entry.note && entry.note.length > 20, `${entry.file} has no note saying what it shows`)
  }
})

test('the "is this a picture" measure actually rejects a blank one', () => {
  // A threshold is only worth having if crossing it is possible. This builds the exact
  // failure mode the check exists for — a valid PNG of the right size with nothing on it —
  // and asserts that the measure the next test uses says so. Without this, a mistyped
  // stride or a decoder that returned an empty buffer would make every picture "pass".
  const width = 3000
  const height = 1900
  const blank = { width, height, data: new Uint8Array(width * height * 4).fill(255) }
  const described = describeImageFrom(blank)
  assert.equal(described.colours, 1, 'a single-colour image must measure as one colour')
  assert.ok(described.dominantShare > 0.99, 'a single-colour image must be almost entirely that colour')
  assert.ok(described.colours < MINIMUM_COLOURS, 'the floor must reject a blank image')
})

test('every image is a picture rather than a blank or half-rendered page', () => {
  // The check that a digest cannot make: a white PNG has a perfectly good digest.
  for (const entry of manifest.images) {
    const described = describeImage(readFileSync(join(DIR, entry.file)))
    const summary = `${entry.file} is ${described.width}x${described.height}, ${described.colours} distinct colours, dominant share ${described.dominantShare.toFixed(3)}`
    assert.ok(
      described.colours >= MINIMUM_COLOURS,
      `${summary} — fewer than ${MINIMUM_COLOURS} distinct colours is a blank page, not a screenshot of the workbench`,
    )
    assert.ok(
      described.dominantShare < 0.98,
      `${summary} — one colour covers almost the whole frame, which is what a page that failed to render looks like`,
    )
    assert.ok(described.opaque, `${summary} — a screenshot of the workbench has no transparent pixels`)
  }
})

test('every image is referenced from the README, with alt text', () => {
  const referenced = new Set()
  for (const match of readme.matchAll(/!\[([^\]]*)\]\((deepblend\/docs\/images\/[\w.-]+\.png)\)/g)) {
    assert.ok(match[1].trim().length > 0, `${match[2]} is referenced with empty alt text, which is the caption a reader gets when the image does not load`)
    referenced.add(match[2].split('/').pop())
  }
  assert.deepEqual(
    [...referenced].sort(),
    files,
    'the README and the images directory disagree: an image nobody links to is dead weight in every clone',
  )
})

test('the README says where the pictures came from', () => {
  // A reader is entitled to know whether a picture is a screenshot or a mockup, and a
  // repository whose whole argument is "measured, not asserted" cannot leave that implicit.
  assert.ok(
    /capture-docs-images\.mjs/.test(readme),
    'the README shows pictures without naming the tool that produces them, so a reader cannot tell a screenshot from a mockup',
  )
})
