#!/usr/bin/env node
/**
 * Probe-merge contract — the rule that turns V8's block ranges into "was this LINE ever executed?".
 *
 * WHY THIS EXISTS
 * ---------------
 * `coverage-probe.mjs` has chosen where the next round should look four times, and it has been wrong
 * about that four times. Every one of the four was a MERGE rule, and every one was caught by a number
 * looking odd rather than by a test:
 *
 *   1. one shared range list across processes: a range positive in one and zero in another read as
 *      dark, so the contract layer and the whole suite reported the same 63.6%;
 *   2. containment-only filtering: `JournalTail.drain` reported as 56 dark lines although it had run
 *      101 times;
 *   3. dropping zero ranges that contained a positive one: every file reported as 0% dark, because the
 *      module wrapper contains everything;
 *   4. judging a line by its whole span: V8's zero-count range for an untaken SUB-EXPRESSION blackened
 *      the line it sits on. MEASURED — `const version = typeof studio.hostApiVersion === 'function'
 *      ? studio.hostApiVersion() : 0` carries a zero range starting 62 characters into the line, and
 *      the probe called it never-executed while thirteen processes had executed it. The dark list for
 *      `tool/render-tools.js` was 89 lines; 35 of them were false.
 *
 * A rule that can only be exercised by running the whole acceptance suite is a rule nobody checks, so
 * the merge is a module (`tools/coverage-merge.mjs`) and this file drives it on synthetic reports.
 * Each case below is one of the four defects or the rule that replaced it — including the direction
 * that must NOT change: an entire body or a branch with a line of its own still reads as dark, or the
 * fix would have traded false positives for hidden gaps.
 *
 * Run: node deepblend/tests/contract/probe-merge.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  cannotExecute,
  executedLines,
  firstCodeOffset,
  lineAt,
  lineStartsOf,
  mergeReports,
  rangesToTree,
} from '../../tools/coverage-merge.mjs'

/**
 * A source written to carry every shape the rule has to judge, one per line:
 *
 *   1  const top = 1                  module level, runs when the module loads
 *   2  function ran(x) {
 *   3    const y = x > 0 ? x : 0      the measured shape: the false arm never runs
 *   4    if (x > 1) {
 *   5      return 'big'               a branch that never runs, with a line of its own
 *   6    }
 *   7    return 'small'
 *   8  }
 *   9  function never() {
 *   10   return 0                    a whole body that never runs
 *   11 }
 *   12
 *   13   // a comment
 *   14 ran(1)
 */
const SOURCE = [
  'const top = 1',
  'function ran(x) {',
  '  const y = x > 0 ? x : 0',
  '  if (x > 1) {',
  "    return 'big'",
  '  }',
  "  return 'small'",
  '}',
  'function never() {',
  '  return 0',
  '}',
  '',
  '  // a comment',
  'ran(1)',
].join('\n')

const lineStarts = lineStartsOf(SOURCE)
/**
 * The offset of the first code character of a 1-based line, computed HERE rather than by asking the
 * module under test. MEASURED reason: an earlier version of this file built its ranges with
 * `firstCodeOffset`, so a mutation that made that function return the LINE START shifted the ranges
 * with it and every assertion still passed — the test and the code agreed because they were the same
 * computation.
 */
const lines = SOURCE.split('\n')
const rawFirstCode = line => lineStarts[line - 1] + (lines[line - 1].length - lines[line - 1].trimStart().length)
const at = rawFirstCode
/** A range from the first code character of `from` to the end of `to` (inclusive), in characters. */
const span = (from, to, count) => ({
  startOffset: at(from),
  endOffset: (lineStarts[to] ?? SOURCE.length + 1) - 1,
  count,
})

/** The report one process writes for this module when `ran(1)` was called and `x > 1` never held. */
const EXECUTED_PROCESS = [
  { startOffset: 0, endOffset: SOURCE.length, count: 1 },   // the module wrapper
  span(2, 8, 1),                                            // `ran` ran
  span(3, 3, 0).startOffset === at(3)                       // the ternary's untaken arm: starts mid-line
    ? { startOffset: SOURCE.indexOf('? x', at(3)), endOffset: (lineStarts[3] ?? SOURCE.length + 1) - 1, count: 0 }
    : span(3, 3, 0),
  span(5, 5, 0),                                            // the `if` branch that never ran
  span(9, 11, 0),                                           // `never` was never called
]

const executedOf = ranges => executedLines(ranges, lineStarts, SOURCE)

test('a line whose ternary arm never ran is still EXECUTED — the round-27 defect', () => {
  // The failing shape, exactly as measured: the zero range covers `? studio.hostApiVersion()` and
  // starts 62 characters into the line. The line's statement did run, so the line ran.
  const covered = executedOf(EXECUTED_PROCESS)
  assert.equal(covered.has(3), true, 'the whole line was reported dark because one arm of it was not taken')
  assert.equal(covered.has(4), true, 'the `if` condition ran, so its line ran')
  assert.equal(covered.has(7), true, 'the taken return ran')
})

test('a never-run branch or body with a line of its own stays DARK — the direction that must not change', () => {
  // The fix must not trade false dark lines for hidden gaps: these are the findings the probe exists
  // to produce.
  const covered = executedOf(EXECUTED_PROCESS)
  assert.equal(covered.has(5), false, 'a branch that never ran must stay dark')
  assert.equal(covered.has(10), false, 'a never-called function body must stay dark')
})

test('the module wrapper does not make every loaded file read as covered', () => {
  // Defect 3's shape. The wrapper (count 1, the whole file) is the OUTERMOST range, so it must lose to
  // the function body's own verdict on every line inside it.
  const covered = executedOf(EXECUTED_PROCESS)
  assert.equal(covered.has(1), true, 'module-level code does run when the module loads')
  assert.equal(covered.has(14), true, 'and so does a module-level call')
  assert.equal(covered.has(10), false, 'but a function body the wrapper merely SPANS is not covered by it')
})

test('a process that never called the function contributes no coverage, and erases none', () => {
  // Defect 1's shape: a range that is positive in one process and zero in another must not cancel out.
  // The question is "did ANY process execute this line".
  const neverCalled = [
    { startOffset: 0, endOffset: SOURCE.length, count: 1 },
    span(2, 8, 0),
    span(9, 11, 0),
  ]
  const alone = executedOf(neverCalled)
  assert.equal(alone.has(7), false, 'in this process the body never ran')

  const merged = mergeReports(
    [
      { url: 'file:///synthetic/module.js', functions: [{ ranges: EXECUTED_PROCESS }] },
      { url: 'file:///synthetic/module.js', functions: [{ ranges: neverCalled }] },
    ],
    () => SOURCE,
  )
  const entry = merged.get('/synthetic/module.js')
  assert.ok(entry !== undefined, 'the file is missing from the merge entirely')
  assert.equal(entry.executed.has(7), true, 'one process ran it, so it is covered')
  assert.equal(entry.executed.has(10), false, 'and nothing ran the never-called body in either process')
})

test('a report with no positive range marks nothing as executed — the negative control', () => {
  // Without this, the union above could be "covered" because the merge ignores counts entirely.
  const allZero = [
    { startOffset: 0, endOffset: SOURCE.length, count: 0 },
    span(2, 8, 0),
    span(9, 11, 0),
  ]
  const covered = executedOf(allZero)
  assert.equal(covered.size, 0, 'a process that executed nothing must cover nothing')
})

test('the module wrapper is identified by being the outermost range, not by a line number', () => {
  // The tree is what makes "innermost wins" possible at all; if nesting broke, every line inside a
  // function would be judged by the wrapper and read as covered.
  const tree = rangesToTree(EXECUTED_PROCESS)
  assert.equal(tree.length, 1, 'the whole file has one root')
  assert.equal(tree[0].count, 1, 'and the root is the module wrapper')
  const bodies = tree[0].children
  assert.deepEqual(bodies.map(child => child.count).sort(), [0, 1], 'the two function bodies hang off the wrapper')
  // The untaken arm and the untaken branch nest INSIDE the executed body — which is exactly why they
  // can be ignored at a statement start without being ignored everywhere.
  const executedBody = bodies.find(child => child.count === 1)
  assert.equal(executedBody.children.length, 2, 'the zero ranges belong to the body that ran, not to the file')
})

test('the judge sits at the first CODE character, not at the line start', () => {
  // The distinction the whole rule rests on: a zero-count range for an untaken arm starts mid-line,
  // so the anchor has to be the statement, not the indentation. Asserted against raw arithmetic here,
  // because every range in this file is built from the same idea.
  assert.equal(firstCodeOffset(SOURCE, lineStarts, 5), rawFirstCode(5), 'an indented line anchors at its first code character')
  assert.notEqual(rawFirstCode(5), lineStarts[4], 'line 5 is indented, so the two anchors differ')
  assert.equal(firstCodeOffset(SOURCE, lineStarts, 1), 0, 'an unindented line anchors at column 0')
  assert.equal(firstCodeOffset(SOURCE, lineStarts, 12), null, 'a blank line has no anchor')
})

test('a comment or a blank line is never reported dark, whichever way it was executed', () => {
  // A comment cannot be "never executed" — counting it is a category error that made the first reading
  // send people after prose.
  assert.equal(cannotExecute('  // done'), true)
  assert.equal(cannotExecute(''), true)
  assert.equal(cannotExecute('   '), true)
  assert.equal(cannotExecute(' * a jsdoc line'), true)
  assert.equal(cannotExecute('/* opens'), true)
  assert.equal(cannotExecute("const y = x > 0 ? x : 0   // trailing note"), false)
  assert.equal(cannotExecute('}'), false)
})

test('a file whose source cannot be read is left out rather than counted as dark', () => {
  // The probe reads source from disk at report time; a file that is gone (a generated module, a stale
  // report) must not appear as a file with every line dark.
  const merged = mergeReports(
    [{ url: 'file:///synthetic/gone.js', functions: [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }] }],
    () => null,
  )
  assert.equal(merged.size, 0)
  // ...and a script with no ranges at all is not "a file that ran": it is a file this process has no
  // opinion about, which is how "never loaded" stays distinguishable from "loaded but dark".
  const noRanges = mergeReports([{ url: 'file:///synthetic/module.js', functions: [] }], () => SOURCE)
  assert.equal(noRanges.size, 0)
})

test('lineAt maps an offset to the line that contains it, including the last one', () => {
  // Small, but every number the probe prints depends on it.
  assert.equal(lineAt(lineStarts, 0), 1)
  assert.equal(lineAt(lineStarts, lineStarts[2]), 3)
  assert.equal(lineAt(lineStarts, lineStarts[2] - 1), 2)
  assert.equal(lineAt(lineStarts, SOURCE.length - 1), 14)
})
