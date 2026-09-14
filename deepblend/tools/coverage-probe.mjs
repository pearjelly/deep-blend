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
 * Not a coverage GATE. There is no threshold and nothing fails ON A DARK LINE. A dark line is a
 * question ("is this reachable? is it dead? has nobody tested it?"), not a verdict — plenty of the
 * dark lines are defensive paths that exist precisely because something went wrong once. The output
 * is a list to read, and the log beside it is the record of what it said on the day it was run.
 *
 * WHAT IT DOES FAIL ON (two things, both about the reading being trustworthy):
 *
 *   - a suite that exited non-zero. Its output is kept (`suite-output.log` in the coverage
 *     directory, which is then kept too) and its failing lines are echoed, because a reading of a
 *     red tree is not a reading. The first version of this tool threw the output away and exited 0:
 *     `suite exit code: 1` was the only trace, and finding out WHICH suite failed cost another full
 *     run. A measurement of a broken tree has to say so;
 *   - a product source file that CHANGED while the suite ran. Coverage is line numbers from the
 *     processes and source text from disk, and they come from different moments: edit a file
 *     mid-run and every number in it is silently read against the wrong lines. MEASURED: a run
 *     whose last suites overlapped an edit reported `isFrameClaim` — a function a test calls seven
 *     times — as never executed, and listed comment lines as the dark ones. That is now a loud
 *     message and a non-zero exit instead of a mystery.
 *
 * AND IT CANNOT SEE `dsh web`. MEASURED: running the browser suite with coverage on produces ZERO
 * reports for the host package, because the server is a `dsh` process that does not write them —
 * so everything reached only through the UI reads as dark here. That is why `listProjects`,
 * `getRevisionDetail`, `getQaRecord` and `readArtifact` show count 0 although the browser suite
 * exercises all four end to end: the routes that call them are served by that invisible process.
 * Read a dark line as "no test I can see executes this", not as "nothing executes this".
 *
 * COMMENT AND BLANK LINES ARE NOT COUNTED, and the report prints both readings so a number can
 * still be compared with §36's. A comment cannot be unexecuted, and a metric whose tail is prose
 * invites a hunt for a gap that does not exist — which is the same defect as a metric that hides
 * one. The first reading counted every line and reported 13.7% dark; restricting the denominator to
 * lines that can execute raises the SHARE substantially while barely moving the dark count, because
 * a large share of this codebase is comments. The reading in `docs/probe-coverage.log` carries both.
 *
 * HOW A LINE IS JUDGED lives in `coverage-merge.mjs`, which is a module for a measured reason: the
 * merge has been wrong four times, and every one of those was caught by a number looking odd rather
 * than by a test — because a rule reachable only through the whole acceptance suite is a rule nobody
 * checks. The fourth (round 27) is the one that cost a round: a line was judged by its whole SPAN, so
 * V8's zero-count range for an untaken sub-expression — `? studio.hostApiVersion()`, starting 62
 * characters into the line — reported the line as never executed although thirteen processes had
 * executed it. The rule is now "the innermost range covering the line's FIRST CODE CHARACTER decides",
 * and `deepblend/tests/contract/probe-merge.test.mjs` drives it on synthetic reports, one case per
 * historical defect plus the direction that must not change (a never-run body stays dark).
 *
 * Usage:
 *   node deepblend/tools/coverage-probe.mjs                 # the contract layer (fast)
 *   node deepblend/tools/coverage-probe.mjs --all           # the whole acceptance suite (slow)
 *   node deepblend/tools/coverage-probe.mjs --top 20        # how many files to print
 *   node deepblend/tools/coverage-probe.mjs --file host/lib/render-journal.js   # one file, with source
 *
 * Owner: DeepBlend Studio — M5
 */

import { spawnSync } from 'node:child_process'

import { cannotExecute, mergeReports } from './coverage-merge.mjs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * Every product source file, with the size and mtime that decide "did this change?".
 *
 * A coverage reading is line numbers against source text, and the two come from different moments:
 * the numbers from the processes that ran, the text from disk when the report is printed. If a file
 * is edited during the run, every number in it is silently off by the diff — the union of what ran is
 * still true, and it is read against the wrong lines. MEASURED: a probe run whose suite took fifteen
 * minutes while the source was being edited reported `isFrameClaim` — a function a test calls seven
 * times — as never executed, and printed comment lines as the dark ones.
 */
function sourceFingerprints() {
  const fingerprints = new Map()
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const stat = statSync(path)
        fingerprints.set(path, `${stat.size}:${stat.mtimeMs}`)
      }
    }
  }
  walk(join(ROOT, 'packages'))
  return fingerprints
}

const coverageDirectory = FROM ?? mkdtempSync(join(tmpdir(), 'deepblend-coverage-'))
/**
 * The suite's exit code, kept so the tool can hand it back.
 *
 * This probe runs the whole acceptance suite, and it used to throw the suite's OUTPUT away and
 * still exit 0. Both halves of that cost a real 15-minute run: the reading below describes a tree
 * whose suite is red, and `suite exit code: 1` was the only trace of it — no way to tell WHICH
 * suite failed without running everything again. A measurement of a broken tree has to say so.
 */
let suiteStatus = 0
let suiteFailed = false
let sourceDrift = []
try {
  if (FROM === null) {
    const command = all ? 'bash' : 'node'
    const args = all ? [join(ROOT, 'deepblend', 'tests', 'run-all.sh')] : [join(ROOT, 'deepblend', 'tests', 'run.mjs')]
    console.log(`running: ${command} ${args.join(' ')}`)
    console.log(`coverage directory: ${coverageDirectory}\n`)

    const before = sourceFingerprints()
    const run = spawnSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const after = sourceFingerprints()
    sourceDrift = [...after].filter(([path, fingerprint]) => before.get(path) !== fingerprint).map(([path]) => relative(ROOT, path))
    for (const path of before.keys()) if (!after.has(path)) sourceDrift.push(`${relative(ROOT, path)} (deleted)`)
    if (sourceDrift.length > 0) {
      console.log(`SOURCE CHANGED DURING THE RUN (${sourceDrift.length} file(s)) — line numbers below are suspect:`)
      for (const path of sourceDrift) console.log(`   ${path}`)
      console.log('   re-run the probe on a frozen tree before quoting any of this\n')
    }
    suiteStatus = run.status ?? 1
    suiteFailed = suiteStatus !== 0
    // Kept, not swallowed. The output is the only thing that says WHICH suite failed, and a suite
    // that failed for an environmental reason is indistinguishable from one that failed on a real
    // defect until someone reads it.
    const suiteOutputPath = join(coverageDirectory, 'suite-output.log')
    writeFileSync(suiteOutputPath, `${run.stdout ?? ''}${run.stderr ?? ''}`)
    console.log(`suite exit code: ${suiteStatus}`)
    console.log(`suite output: ${suiteOutputPath}`)
    if (suiteFailed) {
      console.log('\nTHE SUITE FAILED — the reading below describes a tree that is not green.')
      for (const line of `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n')) {
        if (line.startsWith('✗ ') || line.startsWith('✖ ') || /^Failed/.test(line)) console.log(`   ${line}`)
      }
      console.log('   (the whole output is in the file above)')
    }
  } else {
    console.log(`reading coverage from ${coverageDirectory}`)
  }

  // -------------------------------------------------------------------------
  // Merge every process's report
  // -------------------------------------------------------------------------
  const reports = readdirSync(coverageDirectory).filter(name => name.endsWith('.json'))
  /** @type {object[]} */
  const scripts = []
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
      if (typeof script?.url !== 'string' || !IN_SCOPE.test(script.url)) continue
      scripts.push(script)
    }
  }

  // The merge lives in its own module because it has been wrong four times, and a rule that can only
  // be exercised by running the whole suite is a rule nobody checks
  // (`deepblend/tests/contract/probe-merge.test.mjs` drives it on synthetic reports).
  const byFile = mergeReports(scripts, path => (existsSync(path) ? readFileSync(path, 'utf8') : null))

  console.log(`coverage files: ${reports.length} (${parsed} parsed), product files seen: ${byFile.size}\n`)

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const rows = []
  for (const [path, entry] of byFile) {
    const lines = entry.lineStarts.length
    const sourceLines = entry.text.split('\n')
    // Two counts per file: every line, and every line that could execute. The headline reports the
    // second; the raw one is kept so a reading can still be compared with §36's.
    const darkLines = new Set()
    let codeLines = 0
    let rawDark = 0
    for (let line = 1; line <= lines; line += 1) {
      const executable = !cannotExecute(sourceLines[line - 1] ?? '')
      if (executable) codeLines += 1
      if (entry.executed.has(line)) continue
      rawDark += 1
      if (executable) darkLines.add(line)
    }
    rows.push({
      path: relative(ROOT, path),
      lines,
      codeLines,
      rawDark,
      darkLines,
      encountered: entry.seen && entry.executed.size > 0,
    })
  }

  // A file that was never even LOADED is a different finding from one with dark branches, and the
  // distinction matters: the first is a package the suite never touches, the second is a path
  // inside a package it does.
  const neverLoaded = rows.filter(row => !row.encountered)
  const partially = rows.filter(row => row.encountered && row.darkLines.size > 0)
    .map(row => ({ ...row, share: row.darkLines.size / row.codeLines }))
    .sort((left, right) => (right.darkLines.size - left.darkLines.size))

  console.log(`── product files never loaded (${neverLoaded.length}) ──`)
  for (const row of neverLoaded) console.log(`   ${row.path} (${row.lines} lines)`)

  if (JSON_OUT !== null) {
    const dump = {}
    for (const row of rows) {
      dump[row.path] = {
        lines: row.lines,
        codeLines: row.codeLines,
        rawDark: row.rawDark,
        encountered: row.encountered,
        // Code lines only: a comment cannot be unexecuted, so it is not in this list.
        dark: [...row.darkLines].sort((left, right) => left - right),
      }
    }
    const sum = pick => rows.reduce((total, row) => total + pick(row), 0)
    writeFileSync(JSON_OUT, JSON.stringify({
      totals: { lines: sum(row => row.lines), codeLines: sum(row => row.codeLines), rawDark: sum(row => row.rawDark), dark: sum(row => row.darkLines.size) },
      files: dump,
    }, null, 2))
    console.log(`dark-line map written to ${JSON_OUT}`)
  }

  if (ONE_FILE !== null) {
    const row = rows.find(candidate => candidate.path.endsWith(ONE_FILE))
    if (row === undefined) {
      console.log(`no product file matches ${ONE_FILE}`)
    } else {
      const text = byFile.get(join(ROOT, row.path)).text.split('\n')
      console.log(`\n── ${row.path}: ${row.darkLines.size} of ${row.codeLines} code lines never executed ` +
        `(${row.lines} lines in the file, ${row.lines - row.codeLines} of them blank or comment) ──`)
      for (const line of [...row.darkLines].sort((left, right) => left - right)) {
        console.log(`   ${String(line).padStart(5)} │ ${text[line - 1] ?? ''}`)
      }
    }
    process.exit(suiteFailed || sourceDrift.length > 0 ? 1 : 0)
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
    console.log(`   ${row.path.padEnd(58)} ${String(row.darkLines.size).padStart(4)}/${String(row.codeLines).padEnd(5)} code lines dark  ${text.join(', ')}${shown.length > 6 ? ', …' : ''}`)
  }

  const totalLines = rows.reduce((total, row) => total + row.lines, 0)
  const totalCode = rows.reduce((total, row) => total + row.codeLines, 0)
  const totalDark = rows.reduce((total, row) => total + row.darkLines.size, 0)
  const totalRawDark = rows.reduce((total, row) => total + row.rawDark, 0)
  const share = (part, whole) => `${((part / whole) * 100).toFixed(1)}%`
  // Both readings, on purpose: the raw one is the number §36 published (every line, comments
  // included), and the code one is the number that means what a reader assumes it means.
  console.log(`\nproduct lines seen: ${totalLines}, never executed: ${totalRawDark} (${share(totalRawDark, totalLines)})  [every line]`)
  console.log(`product CODE lines: ${totalCode}, never executed: ${totalDark} (${share(totalDark, totalCode)})  [blank + comment-only lines excluded]`)
  console.log('a dark line is a question, not a defect: is it reachable, is it dead, or has nobody tested it?')
  // The suite's verdict is this tool's verdict. A probe that reports a reading and exits 0 after a
  // red suite is a check that cannot fail — and a reading whose source moved under it is not a
  // reading, so that exits non-zero too.
  if (suiteFailed || sourceDrift.length > 0) process.exitCode = 1
} finally {
  // A FAILED run keeps its evidence: the coverage directory holds `suite-output.log`, and the one
  // run whose output someone needs is the one that failed.
  if (FROM === null && !keep && !suiteFailed && sourceDrift.length === 0) rmSync(coverageDirectory, { recursive: true, force: true })
  else if (FROM === null) console.log(`\nkept ${coverageDirectory} — analyse it with --from ${coverageDirectory}`)
}
