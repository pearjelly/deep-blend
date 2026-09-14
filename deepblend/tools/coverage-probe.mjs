#!/usr/bin/env node
/**
 * Coverage probe: which lines of the product does the acceptance suite actually execute?
 *
 * WHY THIS EXISTS
 * ---------------
 * Round 22 found two defects by creating a hostile condition by hand — a full disk — and both were
 * in a FAILURE path: the render driver's failure handler could not write its own record, and the
 * reconciler's could not either. Neither was visible to any test, and the shape they share is
 * general: a branch that nothing has ever executed is a branch nothing has ever checked.
 *
 * This probe asks the mechanical version of that question. It runs the suite with V8 coverage on,
 * merges every process's report (the suites spawn Blender, `dsh web` and forked hosts, each with
 * its own coverage file), and prints the lines of `packages/deepblend/` that were never executed,
 * grouped by file and ordered by how much of the file is dark.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a coverage GATE. There is no threshold and nothing fails. A dark line is a question ("is this
 * reachable? is it dead? has nobody tested it?"), not a verdict — plenty of the dark lines are
 * defensive paths that exist precisely because something went wrong once. The output is a list to
 * read, and the log beside it is the record of what it said on the day it was run.
 *
 * AND IT CANNOT SEE `dsh web`. MEASURED: running the browser suite with coverage on produces ZERO
 * reports for the host package, because the server is a `dsh` process that does not write them —
 * so everything reached only through the UI reads as dark here. That is why `listProjects`,
 * `getRevisionDetail`, `getQaRecord` and `readArtifact` show count 0 although the browser suite
 * exercises all four end to end: the routes that call them are served by that invisible process.
 * Read a dark line as "no test I can see executes this", not as "nothing executes this".
 *
 * Usage:
 *   node deepblend/tools/coverage-probe.mjs                 # the contract layer (fast)
 *   node deepblend/tools/coverage-probe.mjs --all           # the whole acceptance suite (slow)
 *   node deepblend/tools/coverage-probe.mjs --top 20        # how many files to print
 *
 * Owner: DeepBlend Studio — M5
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const PACKAGES = join(ROOT, 'packages', 'deepblend')

const all = process.argv.includes('--all')
const keep = process.argv.includes('--keep')
/** Analyse a coverage directory from an earlier run instead of running the suite again. */
const fromIndex = process.argv.indexOf('--from')
const FROM = fromIndex === -1 ? null : process.argv[fromIndex + 1]
/** Write the per-file dark-line map, so the reading can be done without re-running the suite. */
const jsonIndex = process.argv.indexOf('--json')
const JSON_OUT = jsonIndex === -1 ? null : process.argv[jsonIndex + 1]
/** Print every dark line of ONE file, with its source, instead of the summary table. */
const fileIndex = process.argv.indexOf('--file')
const ONE_FILE = fileIndex === -1 ? null : process.argv[fileIndex + 1]
const topIndex = process.argv.indexOf('--top')
const TOP = topIndex === -1 ? 12 : Number(process.argv[topIndex + 1])

/** Only the product. The suites and the tooling are not what this probe is about. */
const IN_SCOPE = /\/packages\/deepblend\/[\w./-]+\.(js|mjs)$/

/**
 * A character offset to a 1-based line number.
 * @param {string} text
 * @param {number} offset
 */
function lineAt(text, offset) {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * Nest V8's flat range list into the block tree it describes.
 *
 * The first range of a function is its body; every other range is a block nested somewhere inside
 * it, and a nesting range's count is never higher than its parent's. Sorting by start-then-widest
 * and keeping a stack rebuilds that tree, one tree per script: the module wrapper is the root and
 * every function body hangs off it.
 *
 * @param {{startOffset: number, endOffset: number, count: number}[]} ranges
 */
function rangesToTree(ranges) {
  const sorted = [...ranges].sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset)
  const roots = []
  const stack = []
  for (const range of sorted) {
    if (range.endOffset <= range.startOffset) continue
    const node = { startOffset: range.startOffset, endOffset: range.endOffset, count: range.count, children: [] }
    while (stack.length > 0) {
      const parent = stack[stack.length - 1]
      if (parent.startOffset <= node.startOffset && parent.endOffset >= node.endOffset) break
      stack.pop()
    }
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

/**
 * The line numbers one process executed in one file.
 *
 * V8's semantics are "the innermost block that mentions this byte wins": a block with a positive
 * count is covered, and a nested block with a zero count punches a hole in it. Walking the tree and
 * overwriting each span with its own verdict reproduces that exactly.
 *
 * THREE WRONG VERSIONS CAME BEFORE THIS ONE, all of them caught by the numbers looking wrong rather
 * than by a test: (1) pushing every report's ranges into one list made a range covered by one
 * process and not by another count as dark, so the contract layer and the whole suite reported the
 * SAME 63.6%; (2) filtering zero ranges by containment alone reported `JournalTail.drain` as 56
 * dark lines although it had run 101 times, because one process contributed a whole-body
 * `count: 0` range; (3) dropping any zero range that contained a positive one reported every file
 * as 0% dark, because the module wrapper contains everything. A coverage tool that is wrong in
 * either direction is worse than none, so the merged answer is computed per process — where the
 * tree is unambiguous — and unioned.
 *
 * @param {{startOffset: number, endOffset: number, count: number}[]} ranges
 * @param {number[]} lineStarts
 * @returns {Set<number>}
 */
function executedLines(ranges, lineStarts) {
  const lineOf = offset => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (lineStarts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }

  const covered = new Set()
  const apply = (node, marked) => {
    const state = node.count > 0
    for (let line = lineOf(node.startOffset); line <= lineOf(Math.max(node.startOffset, node.endOffset - 1)); line += 1) {
      if (state) covered.add(line)
      else if (marked) covered.delete(line)
    }
    for (const child of node.children) apply(child, state)
  }
  for (const root of rangesToTree(ranges)) apply(root, false)
  return covered
}

const coverageDirectory = FROM ?? mkdtempSync(join(tmpdir(), 'deepblend-coverage-'))
try {
  if (FROM === null) {
    const command = all ? 'bash' : 'node'
    const args = all ? [join(ROOT, 'deepblend', 'tests', 'run-all.sh')] : [join(ROOT, 'deepblend', 'tests', 'run.mjs')]
    console.log(`running: ${command} ${args.join(' ')}`)
    console.log(`coverage directory: ${coverageDirectory}\n`)

    const run = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    console.log(`suite exit code: ${run.status}`)
  } else {
    console.log(`reading coverage from ${coverageDirectory}`)
  }

  // -------------------------------------------------------------------------
  // Merge every process's report
  // -------------------------------------------------------------------------
  const reports = readdirSync(coverageDirectory).filter(name => name.endsWith('.json'))
  /** @type {Map<string, {text: string, lineStarts: number[], executed: Set<number>, seen: boolean}>} */
  const byFile = new Map()
  let parsed = 0

  for (const name of reports) {
    let json = null
    try {
      json = JSON.parse(readFileSync(join(coverageDirectory, name), 'utf8'))
    } catch {
      continue
    }
    parsed += 1
    for (const script of json.result ?? []) {
      if (!IN_SCOPE.test(script.url)) continue
      const path = script.url.replace('file://', '')
      if (!existsSync(path)) continue

      let entry = byFile.get(path)
      if (entry === undefined) {
        const text = readFileSync(path, 'utf8')
        const lineStarts = [0]
        for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lineStarts.push(index + 1)
        entry = { text, lineStarts, executed: new Set(), seen: false }
        byFile.set(path, entry)
      }

      const ranges = []
      for (const fn of script.functions ?? []) ranges.push(...(fn.ranges ?? []))
      if (ranges.length === 0) continue
      entry.seen = true
      for (const line of executedLines(ranges, entry.lineStarts)) entry.executed.add(line)
    }
  }

  console.log(`coverage files: ${reports.length} (${parsed} parsed), product files seen: ${byFile.size}\n`)

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const rows = []
  for (const [path, entry] of byFile) {
    const lines = entry.lineStarts.length
    const darkLines = new Set()
    for (let line = 1; line <= lines; line += 1) if (!entry.executed.has(line)) darkLines.add(line)
    rows.push({
      path: relative(ROOT, path),
      lines,
      darkLines,
      encountered: entry.seen && entry.executed.size > 0,
    })
  }

  // A file that was never even LOADED is a different finding from one with dark branches, and the
  // distinction matters: the first is a package the suite never touches, the second is a path
  // inside a package it does.
  const neverLoaded = rows.filter(row => !row.encountered)
  const partially = rows.filter(row => row.encountered && row.darkLines.size > 0)
    .map(row => ({ ...row, share: row.darkLines.size / row.lines }))
    .sort((left, right) => (right.darkLines.size - left.darkLines.size))

  console.log(`── product files never loaded (${neverLoaded.length}) ──`)
  for (const row of neverLoaded) console.log(`   ${row.path} (${row.lines} lines)`)

  if (JSON_OUT !== null) {
    const dump = {}
    for (const row of rows) {
      dump[row.path] = {
        lines: row.lines,
        encountered: row.encountered,
        dark: [...row.darkLines].sort((left, right) => left - right),
      }
    }
    writeFileSync(JSON_OUT, JSON.stringify({ totals: { lines: rows.reduce((sum, row) => sum + row.lines, 0), dark: rows.reduce((sum, row) => sum + row.darkLines.size, 0) }, files: dump }, null, 2))
    console.log(`dark-line map written to ${JSON_OUT}`)
  }

  if (ONE_FILE !== null) {
    const row = rows.find(candidate => candidate.path.endsWith(ONE_FILE))
    if (row === undefined) {
      console.log(`no product file matches ${ONE_FILE}`)
    } else {
      const text = byFile.get(join(ROOT, row.path)).text.split('\n')
      console.log(`\n── ${row.path}: ${row.darkLines.size} of ${row.lines} lines never executed ──`)
      for (const line of [...row.darkLines].sort((left, right) => left - right)) {
        console.log(`   ${String(line).padStart(5)} │ ${text[line - 1] ?? ''}`)
      }
    }
    process.exit(0)
  }

  console.log(`\n── the darkest of the files that were loaded (${partially.length}) ──`)
  for (const row of partially.slice(0, TOP)) {
    const dark = [...row.darkLines].sort((left, right) => left - right)
    const shown = []
    for (const line of dark) {
      const last = shown[shown.length - 1]
      if (last !== undefined && line === last[1] + 1) last[1] = line
      else shown.push([line, line])
    }
    const text = shown.slice(0, 6).map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`))
    console.log(`   ${row.path.padEnd(58)} ${String(row.darkLines.size).padStart(4)}/${String(row.lines).padEnd(5)} lines dark  ${text.join(', ')}${shown.length > 6 ? ', …' : ''}`)
  }

  const totalLines = [...byFile.values()].reduce((sum, entry) => sum + entry.text.split('\n').length, 0)
  const totalDark = partially.reduce((sum, row) => sum + row.darkLines.size, 0)
  console.log(`\nproduct lines seen: ${totalLines}, never executed: ${totalDark} (${((totalDark / totalLines) * 100).toFixed(1)}%)`)
  console.log('a dark line is a question, not a defect: is it reachable, is it dead, or has nobody tested it?')
} finally {
  if (FROM === null && !keep) rmSync(coverageDirectory, { recursive: true, force: true })
  else if (FROM === null) console.log(`\nkept ${coverageDirectory} — analyse it with --from ${coverageDirectory}`)
}
