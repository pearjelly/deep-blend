#!/usr/bin/env node
/**
 * The assertion counter's OWN rule, driven by hand.
 *
 * WHY THIS FILE EXISTS: the rule was written once in an ad-hoc audit script, `\(s\)?` made the closing
 * paren optional and the opening one required, and the audit reported 1202 instead of 1249 — a WRONG
 * MEASUREMENT of a RIGHT NUMBER, which is the failure mode this repository keeps paying for. The rule
 * lives in `tools/count-assertions.mjs` now and is driven here: both shapes of summary line, and the
 * lines that must NOT be counted.
 *
 * Run: node deepblend/tests/contract/assertion-counter.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { parseSummary, parseSummaryLine, PRINTS_A_COUNT } from '../../tools/count-assertions.mjs'

test('the parenthesised shape is counted', () => {
  assert.deepEqual(parseSummaryLine('VisualIssue + loop contract: 101/101 check(s) passed'), { passed: 101, total: 101 })
})

test('the UNparenthesised shape is counted too — this is the line the old rule missed', () => {
  assert.deepEqual(parseSummaryLine('M1 store suite: 47/47 checks passed'), { passed: 47, total: 47 })
})

test('a runner line that counts FILES is not an assertion count', () => {
  assert.equal(parseSummaryLine('DeepBlend tests: 55/55 file(s) passed'), null)
})

test('a passing/failing mix is read as the numbers it prints', () => {
  assert.deepEqual(parseSummaryLine('M1 tool output contract: 58/59 check(s) passed'), { passed: 58, total: 59 })
})

test('the LAST summary line wins, so a failing file is not counted at its first partial run', () => {
  const output = [
    'M1 store suite: 12/47 check(s) passed',
    '[FAIL] something',
    'M1 store suite: 46/47 check(s) passed',
  ].join('\n')
  assert.deepEqual(parseSummary(output), { passed: 46, total: 47 })
})

test('output with no summary at all reads as null rather than as zero', () => {
  assert.equal(parseSummary('just some output\n'), null)
  assert.equal(parseSummary(''), null)
  assert.equal(parseSummary(undefined), null)
})

test('the "which files print a count" rule reads REAL files the way the README split needs', () => {
  // Real files rather than synthesized strings: the first version of this test assembled the pattern
  // from parts to keep it out of its own source, and assembling it is exactly what stopped it matching.
  const store = readFileSync(new URL('./store.test.mjs', import.meta.url), 'utf8')
  const nodeTest = readFileSync(new URL('./workspace-links.test.mjs', import.meta.url), 'utf8')
  assert.equal(PRINTS_A_COUNT.test(store), true, 'store.test.mjs prints a count')
  assert.equal(PRINTS_A_COUNT.test(nodeTest), false, 'a node:test file does not')
  // And this file must NOT match: a file whose source contains the pattern would be counted twice.
  assert.equal(PRINTS_A_COUNT.test(readFileSync(new URL('./assertion-counter.test.mjs', import.meta.url), 'utf8')), false)
})
