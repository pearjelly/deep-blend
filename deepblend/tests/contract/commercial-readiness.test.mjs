#!/usr/bin/env node
/**
 * Commercial-readiness ledger contract — the ledger's own four rules, checked.
 *
 * WHY THIS EXISTS
 * ---------------
 * `deepblend/docs/commercial-readiness.md` is the exit condition for the standing objective
 * "keep improving deep-blend until it is commercially viable". That objective runs across many
 * rounds without a human in the loop (SPEC §21.1's last step was revised for it —
 * `architecture-decisions.md` D200), and the ONLY brake on automatic advance is the rule that
 * **every round has to leave countable progress**. A rule with nothing watching it is a
 * sentence, and this repository has paid for that shape often enough to know better.
 *
 * The four rules, and what each one would catch:
 *
 *   1. **one record per round, numbers consecutive** — a round that was skipped, or two
 *      records for one round, is a history that cannot be read as a sequence;
 *   2. **every record names at least one MOVE, from a closed set of six, and names the ledger
 *      rows it moved** — "this round I investigated X and concluded it was fine" is exactly
 *      the shape that is not progress, and the closed set is asserted to be the set this file
 *      holds rather than whatever the ledger happens to say today (D38: one vocabulary);
 *   3. **every ✓ row names a criterion that EXISTS, every ✗ row says what is missing** — a
 *      green row whose criterion points at a deleted file is worse than a red one, because it
 *      reads as done. And a ✓ row may not carry a residual gap: that is what a ✗ row is for;
 *   4. **the ledger's numbers live in ONE place and are recomputed from their named source** —
 *      the most-repeated defect in this repository is a number written in prose that stopped
 *      being true (D93). So the ledger's prose cells may carry no digits at all, and every
 *      number in its registry is re-derived here and compared.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK
 * -------------------------------------
 * Whether the readings are any good. A test can prove that a criterion exists, not that it is
 * the right criterion — that judgement is in the ledger's prose and in the round record, where
 * a reader can argue with it. What this file removes is the possibility of the ledger quietly
 * becoming a document that describes a product nobody measured.
 *
 * Run: node deepblend/tests/contract/commercial-readiness.test.mjs
 *
 * Owner: DeepBlend Studio — commercial readiness (D200)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const LEDGER = join(ROOT, 'deepblend', 'docs', 'commercial-readiness.md')
const COVERAGE_LOG = join(ROOT, 'deepblend', 'docs', 'probe-coverage.log')
const SPEC = join(ROOT, 'SPEC.md')

const text = readFileSync(LEDGER, 'utf8')
const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts

/**
 * The closed set of move types. HELD HERE, not read from the ledger: a set that a document
 * declares and a test merely reads is a set with no contract, and adding a seventh kind of
 * "progress" would then be a one-line edit to the document.
 */
const MOVES = {
  M1: '账本上一行 ✗ → ✓',
  M2: '一条红 → 绿',
  M3: '新增一行（带一条现在就是红的断言，或一条量出缺口的可重跑读数）',
  M4: '一条活下来的变异 → 被新断言杀死',
  M5: '一个具名缺口被关闭',
  M6: '一个可数量化读数改善并被记录',
}

/** The ledger split into its `## ` sections, keyed by their number. */
function sectionsOf(document) {
  const found = new Map()
  for (const match of document.matchAll(/^## (\d)\. (.+)$/gm)) {
    const start = match.index + match[0].length
    const rest = document.slice(start)
    const end = rest.search(/^## \d\. /m)
    found.set(match[1], { title: match[2].trim(), body: end < 0 ? rest : rest.slice(0, end) })
  }
  return found
}

const sections = sectionsOf(text)

/** Markdown table rows as arrays of cells, `|`-split and trimmed, without the header/rule. */
function rowsOf(body) {
  return body.split('\n')
    .filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()))
    .filter(cells => !cells.every(cell => /^:?-{2,}:?$/.test(cell)))
    .filter(cells => !/^#|^面$|^日期$|^代号$|^数字$|^M6 项$/.test(cells[0]))
}

const ledger = sections.get('1')
const registry = sections.get('2')
const vocabulary = sections.get('3')
const rounds = sections.get('4')

/** The ledger's rows, by id. */
const ledgerRows = new Map(
  rowsOf(ledger.body)
    .filter(cells => /^C\d+$/.test(cells[0]))
    .map(cells => [cells[0], { area: cells[1], question: cells[2], status: cells[3], criterion: cells[4], gap: cells[5] }]),
)

/** The M6 completion list in §1: rows of `| item | ✓ or ✗ |`. */
const m6Rows = rowsOf(ledger.body).filter(cells => cells.length === 2 && /^[✓✗]$/.test(cells[1]))

/** The round records: `### 轮 N — date`, then that round's bullets up to the next heading. */
const roundRecords = rounds.body
  .split(/^### /m)
  .slice(1)
  .map(block => {
    const heading = block.match(/^轮 (\d+)/)
    return heading === null
      ? null
      : {
          number: Number(heading[1]),
          body: block.slice(block.indexOf('\n') + 1),
          moves: [...block.matchAll(/^- \*\*移动：(M\d)\*\*/gm)].map(move => move[1]),
        }
  })
  .filter(record => record !== null)

// ---------------------------------------------------------------------------
// The document has to have the shape the other rules are written against, or a
// check below would pass by finding nothing (the vacuity the negative controls in
// `probe-logs.test.mjs` exist for).
// ---------------------------------------------------------------------------

test('the ledger has the four sections this contract is written against', () => {
  for (const [number, title] of [['1', '账本'], ['2', '数字的唯一来源'], ['3', '移动的闭集'], ['4', '轮次记录']]) {
    assert.ok(sections.has(number), `no \`## ${number}. ${title}\` section`)
    assert.equal(sections.get(number).title, title, `§${number} is titled "${sections.get(number).title}"`)
  }
  assert.ok(ledgerRows.size >= 10, `only ${ledgerRows.size} ledger row(s) — a ledger that thin is not a ledger`)
  assert.ok(roundRecords.length >= 1, 'no round records at all')
})

test('§1 rows are well formed, and their status is one of the two the contract knows', () => {
  for (const [id, row] of ledgerRows) {
    for (const [field, value] of Object.entries(row)) {
      assert.ok(value !== undefined && value.length > 0, `${id} has an empty ${field} cell`)
    }
    assert.match(row.status, /^[✓✗]$/, `${id} has status "${row.status}", which is neither ✓ nor ✗`)
  }
})

// ---------------------------------------------------------------------------
// Rule 1 and rule 2: the round records.
// ---------------------------------------------------------------------------

test('the round records are one per round and numbered consecutively from one', () => {
  const numbers = roundRecords.map(record => record.number)
  assert.deepEqual(
    numbers,
    Array.from({ length: numbers.length }, (_, index) => index + 1),
    `round numbers are ${JSON.stringify(numbers)} — a gap or a duplicate makes the history unreadable as a sequence`,
  )
  // Two records for one round would show up as a duplicate above; this catches the other
  // shape, a second heading for the same round written with a different number.
  assert.equal(new Set(numbers).size, numbers.length)
})

test('the ledger\'s closed set of moves is the set this contract holds', () => {
  const declared = new Map(rowsOf(vocabulary.body).filter(cells => /^M\d$/.test(cells[0])).map(cells => [cells[0], cells[1]]))
  assert.deepEqual(
    [...declared.keys()].sort(),
    Object.keys(MOVES).sort(),
    'the ledger declares a different set of move types than the contract — one vocabulary, or neither means anything',
  )
  // The DEFINITION is asserted too, not just the key: a set whose members were redefined
  // ("M3 = wrote a paragraph") would keep the keys and lose the meaning.
  assert.match(declared.get('M1'), /✗ → ✓/)
  assert.match(declared.get('M4'), /变异/)
})

test('every round record names at least one move, from the closed set, and says which rows it moved', () => {
  for (const record of roundRecords) {
    assert.ok(record.moves.length >= 1, `轮 ${record.number} names no move — a round without one is the thing the objective forbids`)
    for (const move of record.moves) {
      assert.ok(MOVES[move] !== undefined, `轮 ${record.number} names ${move}, which is not in the closed set`)
    }
    const named = [...record.body.matchAll(/\bC\d+\b/g)].map(match => match[0])
    assert.ok(named.length >= 1, `轮 ${record.number} names no ledger row, so nothing can be checked against §1`)
    for (const id of new Set(named)) {
      assert.ok(ledgerRows.has(id), `轮 ${record.number} refers to ${id}, which is not a row in §1`)
    }
    // "I investigated X and found nothing" is not a move; the record has to say what changed.
    // The block, not the line: a move is written as one bullet with continuation lines, and
    // measuring the first line would fail every move that opens with its headline.
    const blocks = record.body.split(/^- \*\*移动：/m).slice(1)
    assert.equal(blocks.length, record.moves.length, `轮 ${record.number}: ${blocks.length} block(s) for ${record.moves.length} move(s)`)
    for (const block of blocks) {
      assert.ok(block.trim().length > 120, `轮 ${record.number}'s ${block.slice(0, 2)} move is too short to be a reading: ${block.trim().slice(0, 60)}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Rule 3: a ✓ row's criterion has to exist, and a ✗ row has to say what is missing.
// ---------------------------------------------------------------------------

/** Backticked spans that name something a reader could open or run. */
function referencesIn(cell) {
  const spans = [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1].trim())
  return spans.filter(span =>
    /^npm run [\w:.-]+$/.test(span)
    || /^node [\w./@-]+/.test(span)
    || /^[A-Za-z0-9_./@-]+\.(mjs|js|md|json|yml|yaml|log)$/.test(span))
}

/** Where a reference resolves to, or `null` when it cannot be found anywhere sensible. */
function resolveReference(reference) {
  if (reference.startsWith('npm run ')) {
    const name = reference.slice('npm run '.length)
    return scripts[name] === undefined ? null : `package.json scripts.${name}`
  }
  if (reference.startsWith('node ')) {
    const path = reference.slice('node '.length).split(/\s+/)[0]
    return existsSync(join(ROOT, path)) ? path : null
  }
  if (existsSync(join(ROOT, reference))) return reference
  // A bare log name is how every document in this repository cites an evidence file.
  if (existsSync(join(ROOT, 'deepblend', 'docs', reference))) return `deepblend/docs/${reference}`
  return null
}

test('every ✓ row names a criterion, and every file or command it points at exists', () => {
  for (const [id, row] of ledgerRows) {
    if (row.status !== '✓') continue
    const references = referencesIn(row.criterion)
    assert.ok(references.length >= 1, `${id} is ✓ but names nothing a reader could open or run: ${row.criterion}`)
    for (const reference of references) {
      assert.ok(resolveReference(reference) !== null, `${id} is ✓ and points at \`${reference}\`, which does not exist`)
    }
    assert.equal(row.gap, '—', `${id} is ✓ and still carries a gap ("${row.gap}") — that is what a ✗ row is for`)
  }
})

test('every ✗ row says what is missing, in words', () => {
  for (const [id, row] of ledgerRows) {
    if (row.status !== '✗') continue
    assert.notEqual(row.gap, '—', `${id} is ✗ and does not say what is missing`)
    assert.ok(row.gap.length >= 20, `${id}'s gap is too short to be actionable: ${row.gap}`)
    assert.doesNotMatch(row.gap, /^还没有判据。?$/, `${id} says only "no criterion yet" — say which criterion, or what it would take`)
  }
  // And the ledger has to be able to be finished: a ledger with no ✓ at all is a wish list.
  const green = [...ledgerRows.values()].filter(row => row.status === '✓').length
  assert.ok(green >= 1, 'no row is green, so nothing here is a claim about the product')
})

// ---------------------------------------------------------------------------
// Rule 4: numbers live in one place and are recomputed.
// ---------------------------------------------------------------------------

/**
 * How to recompute each number in §2. Keyed by the ledger's own label, and asserted below to
 * be the SAME SET — so adding a number to the registry without a reader here is a red test,
 * not an unguarded copy of a fact.
 */
const READERS = {
  '产品代码行（全部）': () => coverageReading()[0],
  '产品代码黑暗行': () => coverageReading()[1],
  '产品代码黑暗比例': () => `${coverageReading()[2]}%`,
  '账本行数': () => String(ledgerRows.size),
  '轮次记录数': () => String(roundRecords.length),
  'M6 总项': () => String(m6ItemsInSpec().length),
  'M6 已完成项': () => String(m6Rows.filter(cells => cells[1] === '✓').length),
}

/** The three coverage numbers, from the one log that holds them. */
function coverageReading() {
  const log = readFileSync(COVERAGE_LOG, 'utf8')
  const match = log.match(/^product CODE lines:\s+(\d+), never executed:\s+(\d+) \(([\d.]+)%\)/m)
  assert.ok(match, 'probe-coverage.log no longer carries the `product CODE lines:` reading this registry quotes')
  return [match[1], match[2], match[3]]
}

/** The M6 extension items, from SPEC §20 — the authority the ledger points at. */
function m6ItemsInSpec() {
  const spec = readFileSync(SPEC, 'utf8')
  const heading = spec.indexOf('### M6')
  assert.ok(heading >= 0, 'SPEC.md no longer has an M6 section')
  const body = spec.slice(heading)
  const end = body.indexOf('\n---')
  return (end < 0 ? body : body.slice(0, end)).split('\n').filter(line => line.trim().startsWith('- '))
}

test('§2 is the only place the ledger carries a number, and the registry matches its readers', () => {
  const registryRows = rowsOf(registry.body).filter(cells => cells.length >= 4)
  const declared = new Map(registryRows.map(cells => [cells[0], cells[1]]))

  assert.deepEqual(
    [...declared.keys()].sort(),
    Object.keys(READERS).sort(),
    'the registry and the readers in this file have drifted — every number the ledger quotes needs one here',
  )
  for (const [label, value] of declared) {
    assert.equal(value, READERS[label](), `§2 says "${label}" is ${value}, and recomputing it from its source gives a different number`)
  }
  // The source column has to name something, and it is where a reader goes to check.
  for (const cells of registryRows) {
    assert.ok(cells[2].length > 0, `§2's "${cells[0]}" names no source`)
    for (const reference of referencesIn(cells[2])) {
      assert.ok(resolveReference(reference) !== null, `§2's "${cells[0]}" points at \`${reference}\`, which does not exist`)
    }
  }
})

test('the ledger\'s prose cells carry no digits, so no number can live in two places', () => {
  // The rule, and its three exemptions: a backticked span is a REFERENCE (a path, a command, a
  // config key, an identifier like `macos-arm64` — opening it is how you check it), and `§N` is
  // a cross-reference to a section. Everything else has to be a word. Without this, "68 files"
  // could sit in a ✓ row and stay right for a while, which is the failure mode this whole file
  // exists for.
  const strip = cell => cell
    .replace(/`[^`]*`/g, '')
    .replace(/§\s?[\d.]+/g, '')

  for (const [id, row] of ledgerRows) {
    for (const [field, value] of Object.entries(row)) {
      if (field === 'status') continue
      const residue = strip(value)
      assert.doesNotMatch(
        residue,
        /\d/,
        `${id}'s ${field} carries a digit outside a reference: "${residue.trim()}" — numbers belong in §2, with a source`,
      )
    }
  }

  // AND THE EXEMPTION IS NOT A HOLE. A backticked span may carry digits only when it is
  // something a reader can open or when it is an identifier — `68` in backticks is exactly the
  // second copy this rule is about, and it would otherwise pass by being quoted.
  for (const [id, row] of ledgerRows) {
    for (const span of [...row.criterion.matchAll(/`([^`]+)`/g)].map(match => match[1].trim())) {
      if (!/\d/.test(span)) continue
      const isIdentifier = /^[A-Za-z][\w./@:-]*$/.test(span) && !span.includes(' ')
      assert.ok(
        resolveReference(span) !== null || isIdentifier,
        `${id} quotes \`${span}\`, which is neither a reference that exists nor an identifier — a number in backticks is still a number`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// Negative controls: the rules above have to be able to fail.
// ---------------------------------------------------------------------------

test('the digit rule and the reference rule can both fail, so neither is vacuous', () => {
  const strip = cell => cell.replace(/`[^`]*`/g, '').replace(/§\s?[\d.]+/g, '')
  assert.doesNotMatch(strip('六十个文件'), /\d/, 'a spelled-out number is not a digit')
  assert.match(strip('68 个文件'), /\d/, 'a bare number must be caught')
  assert.doesNotMatch(strip('`deepblend/tests/contract/x.test.mjs` 盯着'), /\d/, 'a reference is exempt')
  assert.doesNotMatch(strip('见 `SPEC.md` §20'), /\d/, 'a section reference is exempt')

  assert.ok(resolveReference('deepblend/docs/commercial-readiness.md') !== null, 'a real path must resolve')
  assert.equal(resolveReference('deepblend/docs/no-such-file.md'), null, 'a missing path must not resolve')
  assert.ok(resolveReference('npm run test') !== null, 'a real script must resolve')
  assert.equal(resolveReference('npm run no-such-script'), null, 'a missing script must not resolve')
  assert.ok(resolveReference('probe-coverage.log') !== null, 'a bare log name must resolve in deepblend/docs')
})

test('the ledger is cited from the record that has to keep it, and the probe log from the manual', () => {
  // An exit condition nothing points at is a document nobody will read. The milestone record
  // is where the next round starts, and `install.md` is what a user follows.
  const milestone = readFileSync(join(ROOT, 'deepblend', 'docs', 'milestone-status.md'), 'utf8')
  assert.ok(
    milestone.includes('commercial-readiness.md'),
    'no round record cites the ledger, so the next round has no reason to open it',
  )
  const install = readFileSync(join(ROOT, 'deepblend', 'docs', 'install.md'), 'utf8')
  assert.ok(install.includes('probe-uninstall-residue.log'), 'the manual does not cite the reading behind its uninstall section')
})

test('the tool files the ledger leans on are the ones the repository actually ships', () => {
  // `probe-logs.test.mjs` owns the log-header rules; this owns the one thing the ledger
  // promises a reader: that the readings behind its rows can be taken again.
  const tools = readdirSync(join(ROOT, 'deepblend', 'tools'))
  assert.ok(tools.includes('uninstall-residue-probe.mjs'))
  assert.ok(tools.includes('dsh-plugin-install-probe.mjs'))
  assert.ok(tools.includes('coverage-probe.mjs'))
})
