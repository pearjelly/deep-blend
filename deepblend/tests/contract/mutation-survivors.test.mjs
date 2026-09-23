#!/usr/bin/env node
/**
 * The survivors of mutation testing — a standing record, held to the tree.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repository's rule is that a surviving mutation is the most valuable output of a round: it
 * points at a hole in an assertion. Until `mutation-survivors.md` existed, that output lived only in
 * the prose of the round that produced it — so the next round did not read it, and the same hole was
 * dug again. MEASURED: the same shape appeared in three consecutive rounds (§202.7, §203.6, §204.5),
 * each time discovered from scratch.
 *
 * The document is append-only and its rows are holes, not runs. The assertions here are what make it
 * a record rather than a paragraph:
 *
 *   1. every row names a killer — a file or a command — and it EXISTS;
 *   2. every row's shape is one of the three the contract holds (and the document's own §1 table
 *      declares exactly that set: one vocabulary, or neither means anything);
 *   3. every `milestone-status.md` section a row cites EXISTS, so a quotation lands somewhere;
 *   4. the ledger's C14 count is derived from this table rather than copied from it.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * -----------------------------------
 * That the killers still kill. Re-running a mutation means editing product code and reverting it, which
 * is a deliberate act with a report (`milestone-status.md` §199.7, §202.7, §203.6, §204.5), not
 * something a contract test should do to the tree it is testing.
 *
 * Run standalone: `node deepblend/tests/contract/mutation-survivors.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C14)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const DOC = join(ROOT, 'deepblend', 'docs', 'mutation-survivors.md')
const doc = readFileSync(DOC, 'utf8')
const milestone = readFileSync(join(ROOT, 'deepblend', 'docs', 'milestone-status.md'), 'utf8')

/**
 * The closed set of shapes. HELD HERE, not read from the document: a set a document declares and a
 * test merely reads is a set with no contract, and a fourth shape would then be a one-line edit.
 */
const SHAPES = {
  A: '作用域比主张宽',
  B: '测的是被测对象旁边的东西',
  C: '读了一个范围，把它叫作全部',
}

/** The document's `## N.` sections. */
const sections = new Map([...doc.matchAll(/^## (\d)\. (.+)$/gm)].map(match => [match[1], match[2].trim()]))

/**
 * The §1 shape table's codes.
 *
 * THE EXTRACTOR USED TO ONLY SEE `A`, `B` AND `C`, which made it blind to the one thing it exists to
 * catch. MEASURED: a mutation that added a fourth shape row SURVIVED, because the pattern could not
 * match the letter `D` — the set it read was a subset of the set it held, so the two always agreed.
 * That is the fourth time this repository has met the same shape, and the first time the instrument
 * itself was the thing with the narrow scope. It now takes any letter and compares.
 */
const declaredShapes = [...doc
  .slice(doc.indexOf('## 1. 三个形状'), doc.indexOf('## 2. 存活者'))
  .split('\n')
  .filter(line => line.startsWith('| **'))
  .map(line => (line.match(/^\| \*\*([A-Z])/) ?? [])[1])]

/** The §2 rows, as cell arrays. */
const rows = doc.split('\n')
  .filter(line => /^\| \d+ \| /.test(line))
  .map(line => line.split('|').map(cell => cell.trim()).filter((cell, index) => index > 0))

/** Backticked spans that name something a reader could open or run. */
function referencesIn(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1].trim())
    .filter(span => /^npm run [\w:.-]+$/.test(span) || /^[A-Za-z0-9_./@-]+\.(mjs|js|md|json|yml|yaml|log)$/.test(span))
}

function resolves(reference) {
  if (reference.startsWith('npm run ')) {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
    return scripts[reference.slice('npm run '.length)] !== undefined
  }
  return existsSync(join(ROOT, reference))
}

test('the document has the sections and rows this contract is written against', () => {
  for (const [number, title] of [['1', '三个形状，三条规则'], ['2', '存活者（追加式，只增不减）'], ['3', '量具自己也会说谎'], ['4', '怎么加一行']]) {
    assert.ok(sections.has(number), `no \`## ${number}. ${title}\` section`)
  }
  assert.ok(rows.length >= 6, `only ${rows.length} survivor row(s) — the record this was written for has six`)
})

test('the document declares the shapes this contract holds, and no others', () => {
  assert.deepEqual(
    declaredShapes.sort(),
    Object.keys(SHAPES).sort(),
    'the document declares a different set of shapes than the contract — one vocabulary, or neither means anything',
  )
})

test('every survivor names a killer that exists', () => {
  for (const row of rows) {
    const [index, round, mutation, shape, killer, status] = row
    assert.ok(mutation.length > 10, `row ${index} has no mutation worth recording`)
    assert.ok(killer.length > 10, `row ${index} names no killer`)

    const references = referencesIn(killer)
    assert.ok(references.length >= 1,
      `row ${index} names nothing a reader could open or run as the killer: ${killer}`)
    for (const reference of references) {
      assert.ok(resolves(reference), `row ${index} points at \`${reference}\`, which does not exist`)
    }
    assert.match(status, /已杀死|仍然开着/, `row ${index} has no status: ${status}`)
    assert.ok(round.includes('§'), `row ${index} does not say which round it came from: ${round}`)
  }
})

test('every shape a row uses is in the closed set', () => {
  for (const row of rows) {
    const [index, , , shape] = row
    const code = (shape.match(/\*\*([ABC])\*\*/) ?? [])[1]
    assert.ok(code !== undefined, `row ${index} does not name a shape from the closed set: ${shape}`)
    assert.ok(SHAPES[code] !== undefined, `row ${index} names shape ${code}, which the contract does not hold`)
  }
})

test('every section a row cites exists in the record it quotes', () => {
  // A citation that lands nowhere is worse than no citation: it reads like evidence. The rows quote
  // `milestone-status.md` by section, so each one has to be a heading in that file.
  for (const row of rows) {
    const [index, round] = row
    for (const [, number] of round.matchAll(/§([\d.]+)/g)) {
      assert.ok(
        new RegExp(`^#{2,4} ${number.replace(/\./g, '\\.')}[ .]`, 'm').test(milestone),
        `row ${index} cites §${number}, which is not a section of milestone-status.md`,
      )
    }
  }
})

test('the document carries no count of its own rows', () => {
  // THE DEFECT THIS REPOSITORY KEEPS PAYING FOR: a number in prose that nothing re-reads. The first
  // version of this document said which rounds had reported zero survivors, in a sentence, and got it
  // wrong in the same breath — so counts live in the table (where the rows ARE the count) and nowhere
  // else. A reader who wants the number counts the rows, or reads the ledger, which derives it.
  const prose = doc
    .split('\n')
    .filter(line => !line.startsWith('|') && !line.startsWith('#'))
    .join('\n')
  const counted = /(?:^|[^\d])(\d+)\s*(?:条|个|轮)/.exec(prose)
  assert.equal(counted, null,
    `the document states a count in prose (${JSON.stringify(counted?.[0]?.trim())}) — the rows are the count`)
})
