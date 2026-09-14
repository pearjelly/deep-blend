#!/usr/bin/env node
/**
 * The model-visible tool inventory, read from the document that promises it.
 *
 * WHY THIS IS PARSED AND NOT WRITTEN DOWN
 * ---------------------------------------
 * `SPEC.md` §11 has a table with one row per high-level tool. Two milestone suites
 * need to know what that table names, and both used to carry their own hand-copied
 * array of the thirteen names. Two copies of a transcription is two chances to be
 * wrong, and neither copy could notice if the table itself changed: the suites
 * asserted the array against the runtime, and nothing asserted the array against
 * `SPEC.md`.
 *
 * So the table is the source, this module is the only reader of it, and the
 * structures that the guards below reject are the ways a Markdown table rots
 * SILENTLY — a row deleted, a column insert that swallows the name, a rename that
 * leaves a duplicate. Each of those would otherwise make a suite pass by expecting
 * less.
 *
 * The guards are what makes deriving safe. A parser without them turns "the spec no
 * longer says that" into "the test no longer asks for it", which is strictly worse
 * than a literal: the literal at least fails when it is wrong.
 *
 * THE DIRECTION THIS CANNOT CHECK, AND WHY THAT IS THE RIGHT ONE TO GIVE UP
 * -----------------------------------------------------------------------
 * A row DELETED from §11 on purpose shrinks the promise and every suite still passes.
 * Catching that would need a second literal list of the thirteen names — the copy this
 * module exists to delete. `SPEC.md` is this project's INPUT, not its output: what
 * actually rots is code falling behind the spec, and that is the direction the two
 * suites assert. What the guards above cover is the accident — a broken table, a
 * reshaped row, a truncated file — because an accident must never be indistinguishable
 * from a promise.
 *
 * Run: imported by the suites; not runnable on its own.
 *
 * Owner: DeepBlend Studio — M5
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const SPEC_PATH = join(ROOT, 'SPEC.md')

/** The heading that owns the table, and the header row that starts it. */
const SECTION_HEADING = '## 十一、模型可见工具'
const TABLE_HEADER = '| 工具 | 作用 | 默认权限 |'

/** A tool name is lower snake case behind the product's one namespace. */
const TOOL_NAME = /^blender_[a-z][a-z0-9_]*$/

/**
 * The fewest rows SPEC §11 can have and still be the section this module describes.
 *
 * This is a FLOOR, not an assertion about the current content — the point is to
 * catch a table that lost its rows (a broken parse, a truncated file), not to pin a
 * count that a future milestone is allowed to raise. The count that matters is
 * asserted where it belongs: against the package's own catalog.
 */
const MINIMUM_ROWS = 10

/**
 * Every tool `SPEC.md` §11's table names, in the order the table lists them.
 *
 * @returns {string[]}
 */
function parseSpecTools() {
  const lines = readFileSync(SPEC_PATH, 'utf8').split('\n')

  const heading = lines.indexOf(SECTION_HEADING)
  if (heading === -1) {
    throw new Error(`SPEC.md no longer has the heading ${JSON.stringify(SECTION_HEADING)}, so §11's tool table cannot be found`)
  }

  const header = lines.indexOf(TABLE_HEADER, heading)
  if (header === -1) {
    throw new Error(`SPEC.md §11 no longer has the header row ${JSON.stringify(TABLE_HEADER)}, so the tool table has been reshaped`)
  }

  const names = []
  // Start after the header and its `|---|` separator.
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.startsWith('|')) break

    const cells = line.split('|').map(cell => cell.trim())
    const name = cells[1]?.replace(/`/g, '')
    if (!TOOL_NAME.test(name ?? '')) {
      throw new Error(`SPEC.md §11 row ${index + 1} does not start with a tool name: ${JSON.stringify(line)}`)
    }
    names.push(name)
  }

  if (names.length < MINIMUM_ROWS) {
    throw new Error(`SPEC.md §11 parsed ${names.length} tool rows, fewer than the ${MINIMUM_ROWS} this section is expected to carry — the table is damaged, not shortened`)
  }
  if (new Set(names).size !== names.length) {
    const seen = new Set()
    const duplicates = names.filter(name => seen.has(name) || (seen.add(name) && false))
    throw new Error(`SPEC.md §11 names the same tool twice: ${[...new Set(duplicates)].join(', ')}`)
  }

  return names
}

/** Frozen, so a suite cannot edit the spec's inventory for the next suite. */
export const SPEC_11_TOOLS = Object.freeze(parseSpecTools())
