#!/usr/bin/env node
/**
 * Documented-counts contract test — the numbers in prose, checked against the tree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The most-repeated defect in this repository is a **number written in prose that
 * stopped being true**: a preset comment that said the catalog was ten tools five
 * hours after it was fourteen (D60), a README that said 14 tools when there were 15,
 * a `tool-contracts.md` table that drifted from the route table it described. Every one
 * of those was correct when written, and nothing re-read it afterwards.
 *
 * The structural counts are the ones a machine can settle without running anything, so
 * they are settled here:
 *
 *   - how many suites `run-all.sh` declares;
 *   - how many test FILES that run covers (the contract layer's discovered files plus
 *     the suites that name one explicitly);
 *   - how many of those contract files print their own count versus using `node:test`;
 *   - how many model-visible tools exist, from the one list the UI draws cards from.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * -----------------------------------
 * The assertion TOTALS (the 830-checks / 172-cases pair in the README). Those cannot be
 * known without running every suite, and this test runs inside that set — a check that
 * ran the others to count them would double the suite's cost to restate a number the
 * reader can get by running one command. They stay in the README as a **snapshot**,
 * labelled as one, and that label is what a reader is owed instead of a guarantee
 * nobody can keep. The README said 811 and 139 while this file was being written; the
 * measured values are 830 and 172. No single commit made that wrong — each one added
 * assertions and none of them re-read the sentence — which is precisely the drift a
 * snapshot label survives and an assertion does not.
 *
 * Run: node deepblend/tests/contract/documented-counts.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const RUN_ALL = join(ROOT, 'deepblend', 'tests', 'run-all.sh')

const runAll = readFileSync(RUN_ALL, 'utf8')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const toolContracts = readFileSync(join(ROOT, 'deepblend', 'docs', 'tool-contracts.md'), 'utf8')

/** Every `run_suite "label" \` + the command line under it. */
const declaredSuites = [...runAll.matchAll(/^run_suite "([^"]+)" \\\n {2}(.+)$/gm)]
  .map(match => ({ label: match[1], command: match[2].trim() }))

/**
 * The contract files the runner discovers, by the same rule `run.mjs` uses: every
 * `*.test.mjs` under `deepblend/tests`, in a stable order. Duplicating the rule here is
 * the point — a test that imported the runner's own list would agree with it by
 * construction.
 */
function discoveredContractFiles() {
  const found = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(join(directory, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        found.push(join(directory, entry.name))
      }
    }
  }
  walk(join(ROOT, 'deepblend', 'tests'))
  return found
}

const contractFiles = discoveredContractFiles()

/**
 * The files the run reaches through a suite that names one, as repo-relative paths.
 * Any that the contract runner already covers are dropped: a suite naming a contract
 * file directly would otherwise be counted twice, and a count that a redundant suite
 * can inflate stops meaning "files the run covers".
 */
const contractRelative = new Set(contractFiles.map(file => relative(ROOT, file)))
const namedSuiteFiles = [...new Set(
  declaredSuites
    .filter(suite => !suite.command.includes('run.mjs'))
    .map(suite => suite.command.split(/\s+/).pop()),
)].filter(path => !contractRelative.has(path))

const coveredFiles = contractFiles.length + namedSuiteFiles.length

test('the numbers this test compares are the ones the README states', () => {
  // If the README stops stating them, every assertion below would pass vacuously.
  assert.ok(readme.includes('个套件'), 'the README no longer states a suite count')
  assert.ok(readme.includes('个文件'), 'the README no longer states a file count')
  assert.ok(declaredSuites.length > 0, 'run-all.sh declares no suites, so the parser is wrong')
})

test('the suite count in the README is what run-all.sh declares', () => {
  const documented = readme.match(/\*\*(\d+) 个套件/)
  assert.ok(documented !== null, 'the README no longer spells the suite count as "N 个套件"')
  assert.equal(
    Number(documented[1]),
    declaredSuites.length,
    `the README says ${documented[1]} suites and run-all.sh declares ${declaredSuites.length}: ` +
      declaredSuites.map(suite => suite.label).join(' | '),
  )
})

test('the file count in the README is what the run actually covers', () => {
  // The contract layer is ONE suite that covers many files; every other suite names a
  // single file. That asymmetry is why this is computed rather than counted from the
  // suite list.
  const documented = readme.match(/\*\*(\d+) 个套件、(\d+) 个文件\*\*/)
  assert.ok(documented !== null, 'the README no longer spells the counts as "N 个套件、M 个文件"')
  assert.equal(
    Number(documented[2]),
    coveredFiles,
    `the README says ${documented[2]} files; the run covers ${contractFiles.length} contract files ` +
      `plus ${namedSuiteFiles.length} files a suite names directly = ${coveredFiles}`,
  )
})

test('every suite run-all.sh names exists', () => {
  for (const suite of declaredSuites) {
    const parts = suite.command.split(/\s+/)
    const entry = parts[parts.length - 1]
    assert.ok(existsSync(join(ROOT, entry)), `run-all.sh runs ${entry}, which does not exist`)
  }
})

test('the contract layer\u2019s own split is what the README states', () => {
  // Detect the PRINT, not the phrase. A pattern that looked for the words alone also
  // matched this file, which contains the pattern — and a file that counted itself into
  // the wrong half would make the partition assertion below fail for the wrong reason.
  const selfCounting = contractFiles.filter(path => /console\.log\(.*check\(s\) passed|console\.log\(.*checks passed/.test(readFileSync(path, 'utf8')))
  const nodeTest = contractFiles.filter(path => /from 'node:test'/.test(readFileSync(path, 'utf8')))

  const documented = readme.match(/\*\*(\d+) 个文件 = .*?（(\d+) 个文件打印计数）.*?(\d+) 个 `node:test` 用例（(\d+) 个文件）\*\*/)
  assert.ok(documented !== null, 'the README no longer spells the contract split')

  assert.equal(Number(documented[1]), contractFiles.length, 'the README\u2019s contract file count is stale')
  assert.equal(Number(documented[2]), selfCounting.length, `the README says ${documented[2]} printing files, found ${selfCounting.length}`)
  assert.equal(Number(documented[4]), nodeTest.length, `the README says ${documented[4]} node:test files, found ${nodeTest.length}`)

  // Every file is one or the other: a suite that printed its own count AND used
  // node:test would make the README's arithmetic describe something that is not a
  // partition.
  assert.equal(
    selfCounting.length + nodeTest.length,
    contractFiles.length,
    'a contract file both prints its own count and uses node:test, so the split is not a partition',
  )
})

test('the tool count in the README and in tool-contracts.md is the real one', () => {
  const tools = UI_TOOL_CARD_KEYS.length

  const readmeTool = readme.match(/(\d+) 个模型可见工具/)
  assert.ok(readmeTool !== null, 'the README no longer states the tool count')
  assert.equal(Number(readmeTool[1]), tools, `the README says ${readmeTool[1]} tools; there are ${tools}`)

  // And the sentence a reader uses to check the roster after installing.
  const readmeRoster = readme.match(/工具清单为 \*\*(\d+) 个\*\*/)
  assert.ok(readmeRoster !== null, 'the README no longer states the expected roster size')
  assert.equal(Number(readmeRoster[1]), tools, `the README promises a ${readmeRoster[1]}-tool roster; there are ${tools}`)

  const contractTool = toolContracts.match(/恰好是上面这 \*\*(\d+)\*\* 个/)
  assert.ok(contractTool !== null, 'tool-contracts.md no longer states the catalog size')
  assert.equal(Number(contractTool[1]), tools, `tool-contracts.md says ${contractTool[1]} tools; there are ${tools}`)
})

test('the count in the README\u2019s own directory tree is the real one', () => {
  // The tree diagram is the third place a contract-file count appears, and it was
  // maintained by hand — 11, then 12, then 21, then 22, then 24 — while the directory
  // moved on. A hand-maintained count in a diagram nobody runs is the same defect as a
  // hand-maintained count in a sentence.
  const inTree = readme.match(/contract\/\s+(\d+) 个 \*\.test\.mjs/)
  assert.ok(inTree !== null, 'the README no longer states a contract count in its directory tree')
  assert.equal(
    Number(inTree[1]),
    contractFiles.length,
    `the README's tree says ${inTree[1]} contract files; there are ${contractFiles.length}`,
  )
})

test('every per-file check count the README quotes is the count that file prints', () => {
  // A count quoted for ONE file is cheap to settle — that file alone takes a quarter of
  // a second — so it is settled rather than dropped. It was 65 when the README was
  // written and 87 by the time anyone looked, and the sentence around it ("the defects
  // that USING the product exposed") is the most useful pointer a new contributor gets;
  // a stale figure beside it is what makes a reader stop trusting the rest.
  const quoted = [...readme.matchAll(/`(contract\/[\w.-]+\.test\.mjs)`（(\d+) 项）/g)]
  assert.ok(quoted.length > 0, 'the README quotes no per-file check count, so this check has nothing to verify')

  for (const [, file, claimed] of quoted) {
    const path = join(ROOT, 'deepblend', 'tests', file)
    assert.ok(existsSync(path), `the README quotes a count for ${file}, which does not exist`)

    const output = spawnSync(process.execPath, [path], { encoding: 'utf8' })
    const printed = /(\d+)\/\d+ check\(s\) passed/.exec(output.stdout ?? '')
    assert.ok(
      printed !== null,
      `the README quotes ${claimed} checks for ${file}, but running it printed no count ` +
        `(exit ${output.status}); stderr: ${(output.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`,
    )
    assert.equal(
      Number(claimed),
      Number(printed[1]),
      `the README says ${file} has ${claimed} checks; it prints ${printed[1]}`,
    )
  }
})

test('the tool count is derived from the list the UI draws cards from, not a second list', () => {
  // The number in the docs has to come from ONE place. `UI_TOOL_CARD_KEYS` is that
  // place, and `ui-plane.e2e.mjs` already asserts it equals what the preset actually
  // registers — so this test does not repeat that; it only refuses a docs page that
  // invented its own figure.
  assert.ok(
    Object.isFrozen(UI_TOOL_CARD_KEYS),
    'UI_TOOL_CARD_KEYS is not frozen, so a caller could change the number the docs quote',
  )
  assert.equal(
    new Set(UI_TOOL_CARD_KEYS).size,
    UI_TOOL_CARD_KEYS.length,
    'the card list has a duplicate, so its length is not a tool count',
  )
})
