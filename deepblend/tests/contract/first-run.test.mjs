#!/usr/bin/env node
/**
 * The first-run reading — how long "from zero to the first frame" takes, checked.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C6 asked how many steps and how many MINUTES a first run takes, and only the first half had
 * ever been measured: `verify-clean-clone.mjs` proved the documented path works, and nothing recorded
 * its cost. It does now — every step is timed, and `--with-blender` gained the step a user actually
 * cares about, `create-demo-project.mjs` rendering a preview whose PNG is read back off the disk.
 *
 * A LOG IS EVIDENCE ONLY IF SOMETHING READS IT. The reading is committed as
 * `probe-first-run.log`, and the assertions here are about its SHAPE rather than its numbers, because
 * the numbers are wall clocks on one machine on one network: what must stay true is that the four
 * documented steps and the first frame were all timed, that a rendered image was found on disk, and
 * that the one slow step is the Blender download — the step a user can skip by installing Blender
 * themselves. A log regenerated WITHOUT `--with-blender` would lose the download and the frame, and
 * this file goes red rather than letting a cheaper run quietly replace the evidence.
 *
 * Run standalone: `node deepblend/tests/contract/first-run.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C6)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const LOG = join(ROOT, 'deepblend', 'docs', 'probe-first-run.log')
const log = readFileSync(LOG, 'utf8')

/** The timing table's rows: `   <ms> ms   <s> s  <label>`. */
const timings = [...log.matchAll(/^\s+(\d+) ms\s+([\d.]+) s\s{2}(.+)$/gm)]
  .map(match => ({ ms: Number(match[1]), label: match[3].trim() }))

test('the reading carries a wall clock for every step a first run goes through', () => {
  assert.ok(timings.length >= 7, `only ${timings.length} timed step(s) in the log`)

  // The four documented steps and the two prerequisites that precede them, by the labels the tool
  // prints — so a renamed step fails here rather than silently dropping out of the table.
  const wanted = [
    /^clone$/,
    /^initialise the profile/,
    /^1\. npm run setup$/,
    /^2\. npm run blender:install$/,
    /^3\. npm run plugin:install$/,
    /^4\. npm run presets:install$/,
    /^5\. the first frame/,
  ]
  for (const pattern of wanted) {
    assert.ok(timings.some(entry => pattern.test(entry.label)),
      `the log has no timing for ${pattern} — the run that produced it did not walk the whole path`)
  }
})

test('the first frame is a picture on disk, not a printed path', () => {
  // The step that separates "installed" from "it works". `verify-clean-clone.mjs` reads the PNGs back
  // and says how many it found and which is largest; a run whose render failed prints `none`.
  const frames = log.match(/^frames on disk: (\d+)$/m)
  assert.ok(frames !== null, 'the log does not report how many frames landed on disk')
  assert.ok(Number(frames[1]) > 0, 'the first-frame step produced no image at all')

  const largest = log.match(/^ {2}the largest: (.+?) \((\d+) B\)$/m)
  assert.ok(largest !== null, 'the log does not name the largest frame')
  // A real render, not a placeholder: the provider's own floor for "this is a frame" is 512 bytes and
  // a 640x360 preview is orders of magnitude above this.
  assert.ok(Number(largest[2]) > 10_000, `the largest frame is ${largest[2]} B, which is not a rendered image`)
  assert.match(largest[1], /\.deepblend\/projects\/.+\/previews\/.+\.png$/,
    `the frame is not where a rendered preview lives: ${largest[1]}`)
})

test('the slow step is the Blender download — the one step a user can skip', () => {
  // THE SHAPE OF THE ANSWER, and the reason this file exists rather than a note in prose. "Where do
  // you get stuck" is one line long: the 346 MB download. Everything else is under a second.
  const download = timings.find(entry => /blender:install/.test(entry.label))
  const documented = timings.filter(entry => /^(1|3|4)\. npm run/.test(entry.label))
  assert.ok(download !== undefined && documented.length === 3,
    'the log is missing the download or one of the documented steps')

  for (const entry of documented) {
    assert.ok(entry.ms < download.ms,
      `${entry.label} (${entry.ms} ms) is not faster than the download (${download.ms} ms) — the reading changed shape`)
  }
  assert.ok(download.ms > 30_000,
    `the download took ${download.ms} ms, which is not a 346 MB fetch — was this log produced without --with-blender?`)

  // And the frame itself is fast: a first run is slow because of the download, not because of Blender.
  const frame = timings.find(entry => /the first frame/.test(entry.label))
  assert.ok(frame.ms < download.ms, 'rendering the first frame must not cost more than the download')
})

test('the log says what it is not, so its numbers are not read as a benchmark', () => {
  // A wall clock on one machine on one network is a reading, not a guarantee. The header has to say
  // so, or the next reader treats 149 s as a property of the product.
  assert.match(log, /A NOTE ON WHAT THIS IS NOT/)
  assert.match(log, /network whose/)
})
