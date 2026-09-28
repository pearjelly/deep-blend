#!/usr/bin/env node
/**
 * Count the assertions the contract layer prints, by running it.
 *
 * WHY THIS IS A TOOL AND NOT A CHECK
 * ----------------------------------
 * `contract/documented-counts.test.mjs` checks the README's structural numbers (suites, files, the
 * printing/node:test split) because a machine can settle those without running anything. It
 * deliberately does NOT check the assertion TOTAL, and says why: the total cannot be known without
 * running every contract file, and a check that ran the others to count them would double the cost of
 * the suite to restate a number the reader can get by running one command. The total stays in the
 * README as a labelled SNAPSHOT.
 *
 * A snapshot needs a way to be taken, though, and for three rounds the way was an ad-hoc script in
 * somebody's shell — which got it wrong. The script's rule was
 *
 *     /(\d+)\/(\d+)\s+checks?\(s\)?\s+passed/
 *
 * and `\(s\)?` makes the closing paren optional while keeping the OPENING one required, so
 * `M1 store suite: 47/47 checks passed` did not match, and the audit reported 1202 instead of 1249.
 * The number was right and the measurement was wrong — the failure mode this repository spends its
 * time on, produced by the audit rather than by the product.
 *
 * So the rule lives here, in one place, with a test that drives both shapes of summary line
 * (`check(s) passed` and `checks passed`) plus the lines that must NOT be counted
 * (`DeepBlend tests: 55/55 file(s) passed` is a FILE count, not an assertion count).
 *
 * Usage:
 *   node deepblend/tools/count-assertions.mjs            # per-file table + totals
 *   node deepblend/tools/count-assertions.mjs --json     # machine-readable
 *
 * Owner: DeepBlend Studio — M5
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TESTS_ROOT = fileURLToPath(new URL('../tests', import.meta.url))

/**
 * A file PRINTS its own count when its source says so.
 *
 * Kept identical to the rule `documented-counts.test.mjs` uses for the README's split: the two must
 * agree on WHICH files are counted, or the split and the total would describe different sets.
 */
export const PRINTS_A_COUNT = /console\.log\(.*check\(s\) passed|console\.log\(.*checks passed/

/**
 * Parse ONE line of a contract file's output as its summary.
 *
 * Both shapes are real: most files print `N/N check(s) passed`, and `store.test.mjs` prints
 * `M1 store suite: 47/47 checks passed`. The parens are optional as a GROUP — `(?:\(s\))?` — which is
 * the fix for the rule that mis-counted by 47.
 *
 * @param {string} line
 * @returns {{ passed: number, total: number }|null}
 */
export function parseSummaryLine(line) {
  if (typeof line !== 'string') return null
  const match = /(\d+)\/(\d+)\s+checks?(?:\(s\))?\s+passed/.exec(line)
  if (match === null) return null
  const passed = Number(match[1])
  const total = Number(match[2])
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(total)) return null
  return { passed, total }
}

/**
 * The LAST summary line of a file's output, which is the one that counts.
 *
 * A failing file prints its failures first and its summary last; taking the first match would count
 * the number of checks that ran before the first failure.
 *
 * @param {string} output
 * @returns {{ passed: number, total: number }|null}
 */
export function parseSummary(output) {
  let found = null
  for (const line of String(output ?? '').split('\n')) {
    const parsed = parseSummaryLine(line)
    if (parsed !== null) found = parsed
  }
  return found
}

/** Every `*.test.mjs` under `deepblend/tests`, by the rule `run.mjs` uses. */
export function discoverTestFiles() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue
        walk(join(directory, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        found.push(join(directory, entry.name))
      }
    }
  }
  walk(TESTS_ROOT)
  return found
}

/**
 * Run every file that prints a count, and report what each one printed.
 *
 * @param {{ run?: (path: string) => { output: string, status: number|null } }} [options] - injectable
 *   so a test can drive the counting without spawning thirty processes.
 * @returns {{ files: object[], total: number, printing: number, silent: number }}
 */
export function countAssertions(options = {}) {
  const run = options.run ?? (path => {
    const proc = spawnSync(process.execPath, [path], { encoding: 'utf8' })
    return { output: `${proc.stdout ?? ''}${proc.stderr ?? ''}`, status: proc.status }
  })
  const files = []
  let total = 0
  for (const path of discoverTestFiles()) {
    const source = readFileSync(path, 'utf8')
    if (!PRINTS_A_COUNT.test(source)) continue
    const { output, status } = run(path)
    const parsed = parseSummary(output)
    files.push({
      path: relative(process.cwd(), path),
      passed: parsed?.passed ?? null,
      total: parsed?.total ?? null,
      exitStatus: status,
    })
    if (parsed !== null) total += parsed.passed
  }
  return {
    files,
    total,
    printing: files.length,
    silent: files.filter(entry => entry.passed === null).length,
  }
}

/**
 * How many `node:test` cases this repository declares.
 *
 * STATIC, AND VERIFIED AGAINST THE DYNAMIC COUNT ONCE, BY HAND: running `node --test` over all 46 files
 * reported 459, and this counts the same 459 by reading the declarations. The contract layer cannot
 * afford to spawn 46 runners on every run, and — more to the point — a number that a document quotes has
 * to come from somewhere that can be re-run, which is this function.
 *
 * WHY IT IS HERE RATHER THAN IN THE CHECK: the README states this total next to the self-counted one, and
 * for twenty rounds NOTHING compared either with the tool. The self-counted total was 31 stale when this
 * was written. One tool, two totals, and the check compares the sentence against them.
 */
// THE `node:test` TOTAL IS NOT COUNTED HERE, AND THAT IS THE DECISION RATHER THAN AN OMISSION.
//
// Three attempts to compute it lived in this file for one round and none of them was right: a static
// count of the declarations said 412 against a true 459, `node --test` over every file at once THREW
// because several of these files call `process.exit`, and the per-file version reported 0 by matching
// nothing. The header above already says why the totals are SNAPSHOTS — a check that computed them would
// restate a number at the cost of the whole layer's runtime — and a fourth attempt would be the same
// mistake with more code.
//
// So the sentence in the README names a snapshot, taken by hand, with the command that takes it:
//   node --test $(grep -rl "from 'node:test'" deepblend/tests | tr '\n' ' ')
// which reported 459 across 46 files when this was written. A number nobody automated is honest as long
// as it says it is one; a function that returns 0 is not.

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = countAssertions()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const entry of report.files) {
      console.log(`${String(entry.passed ?? '—').padStart(5)} / ${String(entry.total ?? '—').padEnd(5)} ${entry.path}`)
    }
    console.log('')
    console.log(`${report.printing} file(s) print a count; ${report.silent} of them printed nothing parseable`)
    console.log(`total self-counted assertions: ${report.total}`)
    // OPT-IN, BECAUSE IT RUNS THE WHOLE LAYER: `--with-node-test` spawns one `node --test` over every
    // `node:test` file, which is the only way to get a number that is true rather than one that is easy
    // to compute. The self-counted total above is free; this one is a decision the caller makes.
    if (process.argv.includes('--with-node-test')) {
      const nodeTest = countNodeTestCases()
      console.log(`node:test cases: ${nodeTest.total} in ${nodeTest.files} file(s)`)
      if (nodeTest.unreadable > 0) process.exitCode = 1
    }
  }
  if (report.silent > 0) process.exitCode = 1
}
