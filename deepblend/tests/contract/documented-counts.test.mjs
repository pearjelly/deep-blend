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
 * The assertion TOTALS — how many checks and how many `node:test` cases the layer reports.
 * Those cannot be known without running every suite, and this test runs inside that set: a
 * check that ran the others to count them would double the suite's cost to restate a number
 * the reader can get by running one command. They stay in the README as a **snapshot**,
 * labelled as one, and that label is what a reader is owed instead of a guarantee nobody can
 * keep. The README said 811 and 139 while this file was being written, and 830 and 186 two
 * rounds later. No single commit made either wrong — each one added assertions and none of
 * them re-read the sentence — which is precisely the drift a snapshot label survives and an
 * assertion does not.
 *
 * AND THIS PARAGRAPH DOES NOT PRINT THE TOTALS EITHER, for the same reason it exists: it did,
 * briefly, and a maintenance script left a placeholder word in both places. A number in a
 * comment nothing reads is the defect this whole file is about, so the comment stopped
 * carrying one (§34). The README is where the snapshot lives; this is the reason.
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

import { SCENE_OPERATION_NAMES, UI_TOOL_CARD_KEYS } from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const RUN_ALL = join(ROOT, 'deepblend', 'tests', 'run-all.sh')

const runAll = readFileSync(RUN_ALL, 'utf8')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const install = readFileSync(join(ROOT, 'deepblend', 'docs', 'install.md'), 'utf8')
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

test('the link count in install.md is what the linker resolves', () => {
  // `install.md` tells a reader that `node_modules/` holds "12 个指向已安装的 DSH 部署与本仓库 packages/ 的绝对
  // 符号链接", and that number is the linker's own output — a count that rots the moment a thirteenth package is
  // imported. `link-workspace.mjs` is a script with no exported plan, so the tie runs its `--check` mode, which
  // prints the number and exits non-zero when the workspace is out of sync.
  const stated = install.match(/(\d+) 个指向\*\*已安装的 DSH 部署/)
  assert.ok(stated !== null, 'install.md no longer states "N 个指向已安装的 DSH 部署" — re-anchor this check')
  const check = spawnSync('npm', ['run', '--silent', 'setup:check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(check.status, 0, `setup:check failed, so the link count cannot be compared:\n${check.stdout}${check.stderr}`)
  const resolved = /resolves all (\d+) package\(s\)/.exec(check.stdout)
  assert.ok(resolved !== null, `setup:check no longer prints "resolves all N package(s)":\n${check.stdout}`)
  assert.equal(Number(stated[1]), Number(resolved[1]),
    `install.md says ${stated[1]} symlinks; the linker resolves ${resolved[1]}`)
})

test('the layout counts in the README are what the tree holds', () => {
  // Two numbers in the README's tree block are countable, and both were unchecked — the kind of number that
  // rots when a tool or a module is added. Each is derived here, and each derivation is guarded: a reworded line
  // must fail rather than make the check pass over nothing (the same rule the suite-count cases follow).
  const tools = readme.match(/(\d+) 个模型可见工具/)
  assert.ok(tools !== null, 'the README no longer states "N 个模型可见工具"')
  assert.equal(Number(tools[1]), UI_TOOL_CARD_KEYS.length,
    `the README says ${tools[1]} model-visible tools; the contract declares ${UI_TOOL_CARD_KEYS.length}`)

  // The module count excludes the dispatcher and the shared utility, and the README says so in the same line —
  // without that clause the number would be unverifiable by a reader AND by this check.
  const modules = readme.match(/(\d+) 个动作模块（另有 (\S+\.py) 这一份工具）/)
  assert.ok(modules !== null, 'the README no longer states "N 个动作模块（另有 X.py 这一份工具）"')
  const pythonDirectory = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python')
  const files = readdirSync(pythonDirectory).filter(name => name.endsWith('.py'))
  assert.ok(files.length > 3, `the python directory holds ${files.length} .py files; the parser is wrong`)
  const actionModules = files.filter(name => name !== 'bootstrap.py' && name !== modules[2])
  assert.equal(Number(modules[1]), actionModules.length,
    `the README says ${modules[1]} action modules; ${files.length} .py files minus bootstrap.py minus ` +
    `${modules[2]} is ${actionModules.length} (${actionModules.join(', ')})`)
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

test('the "N 条照跑" count in the README is the number of lines run-all.sh prints', () => {
  // The README tells a reader that without Python "其余 N 条照跑", and N is the number of `✓` lines the
  // acceptance suite prints: one per contract file plus one per other suite. It is derived from the two counts
  // the cases above already compute, which is how this was caught — adding one contract file made the run print
  // 78 while the sentence still said 77.
  const stated = readme.match(/其余 (\d+) 条照跑/)
  assert.ok(stated !== null, 'the README no longer states "其余 N 条照跑" — re-anchor this check')
  // `coveredFiles` already counts the files the other suites name, so the only extra line is the CONTRACT
  // suite's own (it covers many files and prints one line for the layer). That asymmetry is the same one the
  // file-count case documents; getting it wrong here is what the first version of this check did, reporting 93.
  const lines = coveredFiles + (declaredSuites.length - namedSuiteFiles.length)
  assert.equal(Number(stated[1]), lines,
    `the README says ${stated[1]} checks keep running; ${coveredFiles} files plus the contract suite's own ` +
    `line = ${lines}`)
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

test('no document other than the README carries its own copy of the assertion totals', () => {
  // THE DEFECT THIS FINDS, MEASURED: `CONTRIBUTING.md`'s quick start said
  // `npm test  # 单元 + 契约，806 项自计断言 + 82 个 node:test 用例` for twenty-five commits. The same
  // command printed 841 and 215. Whether 806/82 was ever right is not recoverable — no commit made it
  // wrong, because nothing ever re-read it — and that is the point: a total in a document nobody
  // checks cannot even be shown to have been true.
  //
  // The README's snapshot survives by being LABELLED as a snapshot and read by a human who runs one
  // command to replace it (D93). A second copy has neither property, so the rule is: one document
  // carries the totals, and the rest point at it. The check is deliberately about the SHAPE — a
  // number next to "断言" or "node:test 用例" — because a rule that listed the two stale figures would
  // be the same rot one round later.
  const documents = [
    'CONTRIBUTING.md',
    'deepblend/docs/usage.md',
    'deepblend/docs/install.md',
    'deepblend/docs/recovery.md',
    // The templates a contributor reads before running anything: the same rule, one file over.
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml',
  ]
  const totals = /\d+\s*(?:项自计断言|项?自计断言|个\s*`?node:test`?\s*用例)/
  for (const name of documents) {
    const path = join(ROOT, name)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    const found = text.match(totals)
    assert.equal(
      found,
      null,
      `${name} carries its own copy of the assertion totals (${JSON.stringify(found?.[0])}). ` +
        'The README owns that snapshot and labels it as one; a second copy is a number nothing re-reads.',
    )
  }
  // The rule has to be able to fail, so it is exercised on the sentence that was actually there.
  assert.notEqual('npm test   # 单元 + 契约，806 项自计断言 + 82 个 node:test 用例'.match(totals), null)
  // ...and must not fire on the README's own labelled snapshot, which stays where it is.
  assert.notEqual(readme.match(totals), null, 'the README no longer carries the snapshot this rule is an exception for')
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

// ---------------------------------------------------------------------------
// The document that OWNS the totals states them once
// ---------------------------------------------------------------------------
//
// D93's rule is that one document carries the totals and the rest point at it. The check below enforces that for
// the OTHER documents by shape; nothing enforced it for the README itself, and the README had grown two copies of
// both numbers — the snapshot sentence and a later one explaining that they are a snapshot. The second copy read
// 1469 for nineteen rounds while the first had moved to 1488, which is exactly the rot D93's rule is about.
//
// The rule here is self-anchoring: the totals are READ from the snapshot sentence (by the same shape the other
// check uses), and then each must appear exactly once in the whole document. No figure is written into this file,
// so this check cannot rot the way the sentence did.
test('the README names each of its totals exactly once', () => {
  const shape = /(\d[\d\s]*)\s*项自计断言|(\d+)\s*个\s*`?node:test`?\s*用例/g
  const totals = [...readme.matchAll(shape)].map(match => (match[1] ?? match[2]).replace(/\s/g, ''))
  assert.equal(totals.length, 2,
    `the README should state a self-counted total and a node:test total once each; found ${totals.length}`)
  for (const total of totals) {
    const occurrences = (readme.match(new RegExp(`\\b${total}\\b`, 'g')) ?? []).length
    assert.equal(occurrences, 1,
      `the README states ${total} ${occurrences} times — the totals belong in one sentence, and a second copy is what rotted for nineteen rounds`)
  }
})

// ---------------------------------------------------------------------------
// EVERY count statement in the README, not just the anchored one
// ---------------------------------------------------------------------------
//
// The checks above anchor one phrasing each — `**N 个套件` in the expectations paragraph, `N 个模型可见工具` in the
// layout block — and the README states the suite count in more places than that. MEASURED by mutation: changing
// the command block's `# 16 个套件` to `# 17 个套件` left the suite green, because the anchor matched a different
// sentence, while changing the layout's tool count went red. A reader who trusts the command block would run the
// suite expecting a number nothing was checking.
//
// The rule here is the general one: EVERY `N 个套件` in the README must be the declared suite count, and every
// `N 个模型可见工具` must be the roster's size. The phrasings are scoped deliberately — the README says `N 个文件`
// about a package's own file count as well as about the run, so that one keeps its single anchored assertion.
test('every suite and tool count the README states is the declared one', () => {
  const suiteStatements = [...readme.matchAll(/(\d+)\s*个套件/g)].map(match => Number(match[1]))
  assert.ok(suiteStatements.length >= 2,
    `expected the README to state the suite count in more than one place, found ${suiteStatements.length}`)
  const wrongSuites = suiteStatements.filter(value => value !== declaredSuites.length)
  assert.deepEqual(wrongSuites, [],
    `the README states ${wrongSuites.join(', ')} suites; run-all.sh declares ${declaredSuites.length}`)

  // TWO PHRASINGS MEAN THE CURRENT TOTAL, and a third does not. "N 个模型可见工具" (the layout block) and
  // "全部 N 个工具" (the quick-start comment) both state the roster's size; "M1 的 7 个工具" and "M2 全部 10 个
  // 工具" state what those suites' planes contained, which their own suites assert ("all seven", "all ten") and
  // which this file must not touch — they are records of a scope, not copies of the roster.
  const toolStatements = [
    ...[...readme.matchAll(/(\d+)\s*个模型可见工具/g)].map(match => Number(match[1])),
    // Anchored at the comment marker: the current-total line reads "# 全部 16 个工具 + 真实交付", while the
    // scoped one reads "# M2 全部 10 个工具 + 图片回传". A bare `全部 N 个工具` pattern matches both, and the first
    // version of this did — it then failed on a correct README by reading M2's scope as the roster.
    ...[...readme.matchAll(/#\s*全部\s*(\d+)\s*个工具/g)].map(match => Number(match[1])),
  ]
  assert.ok(toolStatements.length >= 2,
    `expected the README to state the roster size in both phrasings, found ${toolStatements.length}`)
  const wrongTools = toolStatements.filter(value => value !== UI_TOOL_CARD_KEYS.length)
  assert.deepEqual(wrongTools, [],
    `the README states ${wrongTools.join(', ')} model-visible tools; the contract declares ${UI_TOOL_CARD_KEYS.length}`)
})

// ---------------------------------------------------------------------------
// The operation vocabulary's size, wherever a live document states it
// ---------------------------------------------------------------------------
//
// MEASURED by sweeping the live documents for counted statements: `usage.md` said "24 个操作名就是全部词汇" —
// correct — while `tool-contracts.md`, the document a model is pointed at, said "共 19 个操作" and "只接受 20 个
// 固定操作名". The contract declares 24. Two statements in the same file disagreed with each other's neighbour and
// with the code, and nothing read either of them.
//
// The ordinal beside them was checked at the same time and is right: `world.set` is the 21st name, which is what
// "第 21 个操作" says. That one is asserted here too, because an ordinal is a count with an index attached.
test('every statement of the operation vocabulary’s size is the declared size', () => {
  const live = ['deepblend/docs/usage.md', 'deepblend/docs/tool-contracts.md', 'deepblend/docs/recovery.md']
  const size = SCENE_OPERATION_NAMES.length
  const wrong = []
  let inspected = 0
  for (const path of live) {
    const text = readFileSync(join(ROOT, path), 'utf8')
    // THREE PHRASINGS MEAN THE SIZE, and two look like it without being it: "第 21 个操作" is an ORDINAL (asserted
    // below, against the name at that position) and "1 个操作" says how many operations one patch carries. A bare
    // `N 个操作` pattern matched all three, and this is the second round in a row where an over-wide pattern failed
    // on a correct document — the fix is the same both times: match the words that mean the total.
    const sizePhrasings = [
      /共\s*(\d+)\s*个操作/g,
      /(\d+)\s*个固定操作名/g,
      /(\d+)\s*个操作名就是全部词汇/g,
    ]
    for (const phrasing of sizePhrasings) {
      for (const match of text.matchAll(phrasing)) {
        inspected += 1
        if (Number(match[1]) !== size) wrong.push(`${path}: ${match[0]}`)
      }
    }
  }
  assert.ok(inspected >= 3, `expected the documents to state the vocabulary size, found ${inspected}`)
  assert.deepEqual(wrong, [], `the contract declares ${size} operation names`)

  const ordinal = /第 (\d+) 个操作/.exec(readFileSync(join(ROOT, 'deepblend', 'docs', 'tool-contracts.md'), 'utf8'))
  assert.ok(ordinal !== null, 'the ordinal paragraph is gone — re-anchor this check rather than deleting it')
  assert.equal(SCENE_OPERATION_NAMES[Number(ordinal[1]) - 1], 'world.set',
    `the document calls world.set the ${ordinal[1]}st operation; the contract puts it elsewhere`)
})
