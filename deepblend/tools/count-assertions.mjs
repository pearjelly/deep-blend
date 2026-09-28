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
import { resolve, join, relative } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
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
export async function countAssertions(options = {}) {
  // PARALLEL, AND MEASURED. Sequentially this took 52 seconds — 80 files, one at a time — which is why
  // the tool's own header says the total is a snapshot a check cannot afford: paying 52s on a 97s layer
  // to guard one documentation number is a bad trade. The same work through a small pool costs about
  // eight seconds, and that changes the trade rather than the number.
  const concurrency = options.concurrency ?? 8
  const run = options.run ?? (path => new Promise(resolveRun => {
    execFile(process.execPath, [path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveRun({ output: `${stdout ?? ''}${stderr ?? ''}`, status: error === null ? 0 : (error.code ?? 1) })
    })
  }))

  const paths = discoverTestFiles().filter(path => PRINTS_A_COUNT.test(readFileSync(path, 'utf8')))
  const results = new Array(paths.length)
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      const index = next
      next += 1
      results[index] = await run(paths[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker))

  const files = []
  let total = 0
  for (const [index, path] of paths.entries()) {
    const { output, status } = results[index]
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
/**
 * How many `node:test` cases this repository declares — counted by RUNNING them, in one runner.
 *
 * THE COMMENT THAT USED TO BE HERE WAS WRONG, AND MEASUREMENT IS WHAT FOUND IT. It said the total could
 * not be counted cheaply because "these files call process.exit and cannot share a runner". Neither half
 * held up: a grep for `process.exit` across the 46 files matches exactly one file, and the match is
 * GENERATED FIXTURE TEXT inside this repository's own mutation-harness test rather than a call — and one
 * `node --test` over all 46 completes and reports the total in 18 seconds.
 *
 * The earlier failure was mine to misread: a suite with a red file makes `execFileSync` throw even though
 * the runner COMPLETED, and "it threw" was taken for "the runner cannot take all the files".
 *
 * A STATIC COUNT IS NOT AN OPTION, and that is also measured: counting `test(` declarations gives 413
 * against a true 460, because 18 of them are declared inside loops — `for (const x of xs) test(...)` is
 * one declaration and many cases. A document quoting this number needs the number that is true.
 */
export function countNodeTestCases() {
  const owners = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.test.mjs') && readFileSync(path, 'utf8').includes("from 'node:test'")) owners.push(path)
    }
  }
  walk(TESTS_ROOT)

  let output = ''
  try {
    output = execFileSync('node', ['--test', ...owners], {
      cwd: resolve(TESTS_ROOT, '..', '..'),
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
    }).toString()
  } catch (error) {
    // THE OUTPUT IS READ FROM BOTH OUTCOMES: a red file throws here and still printed its total.
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`.toString()
  }
  // MATCHED WITHOUT THE SUMMARY GLYPH ON PURPOSE: the escaping of a non-ASCII character through a
  // generator script is one more thing to get wrong, and the word `tests` with a number is unambiguous
  // in this output. MEASURED: the glyph-shaped version silently returned null.
  const match = output.match(/^\S* ?tests (\d+)$/m)
  return { total: match === null ? null : Number(match[1]), files: owners.length, passed: /^\u2139 fail 0$/m.test(output) }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const report = await countAssertions()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    for (const entry of report.files) {
      console.log(`${String(entry.passed ?? '—').padStart(5)} / ${String(entry.total ?? '—').padEnd(5)} ${entry.path}`)
    }
    console.log('')
    console.log(`${report.printing} file(s) print a count; ${report.silent} of them printed nothing parseable`)
    console.log(`total self-counted assertions: ${report.total}`)

    // `--check` COMPARES THE README WITH THIS NUMBER, and it is a COMMAND rather than a contract check
    // for a measured reason: this tool costs 32 seconds through its pool (52 sequentially) against a
    // contract layer that costs 97, and paying a third of the layer to guard one documentation figure is
    // the trade the header above already refused. What it is NOT is a snapshot nobody can verify — the
    // README states this total and, until this flag existed, nothing in the repository compared the two.
    //
    // THE `node:test` TOTAL IS NOT CHECKED HERE, and that is stated rather than implied: counting it
    // needs one runner per file (46 of them, because these files call process.exit and cannot share a
    // runner), which costs more than this whole tool. It stays a snapshot, and the README's sentence is
    // the only place it is written down.
    if (process.argv.includes('--check')) {
      const readme = readFileSync(join(TESTS_ROOT, '..', '..', 'README.zh.md'), 'utf8')
      const stated = readme.match(/(\d[\d\s]*)\s*项自计断言/)
      const value = stated === null ? null : Number(stated[1].replace(/\s/g, ''))
      const nodeTest = countNodeTestCases()
      const statedCases = readme.match(/(\d+)\s*个\s*`?node:test`?\s*用例/)
      const cases = statedCases === null ? null : Number(statedCases[1])

      const wrong = []
      if (value !== report.total) wrong.push(`self-counted: README says ${value ?? 'nothing'}, the tool counts ${report.total}`)
      if (cases !== nodeTest.total) wrong.push(`node:test: README says ${cases ?? 'nothing'}, the tool counts ${nodeTest.total}`)
      if (wrong.length > 0) {
        for (const line of wrong) console.error(line)
        console.error('the sentence to correct is the one beginning "**80 个文件 = "')
        process.exitCode = 1
      } else {
        console.log(`README agrees: ${value} self-counted, ${cases} node:test cases in ${nodeTest.files} file(s)`)
      }
    }
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
