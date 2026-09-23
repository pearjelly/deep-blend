#!/usr/bin/env node
/**
 * The cost model — every number in it, recomputed.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C17 asked whether a user can know what they are about to spend, and the measured answer was
 * that the product said "so this is hours of machine time" and left the arithmetic to the reader,
 * while the token side had no number at all. `deepblend/docs/cost.md` is the model; this file is what
 * keeps it from becoming a paragraph:
 *
 *   1. the per-frame rate the document quotes is the constant the PRODUCT uses — one definition, not
 *      a copy in prose;
 *   2. the estimate the approval prompt shows is computed from that rate and the requested frame
 *      count, so "2.5 hours to 5.2 hours" is a reading rather than a sentence;
 *   3. the token figures are the ones the live probe prints, and the document says which image each
 *      one came from;
 *   4. the document states what it does NOT know, because a cost model that only lists its numbers
 *      reads as complete.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * -----------------------------------
 * The token numbers themselves. They are one model's answers on one deployment, and a contract test
 * asserting 1049 would be asserting a language model's verbosity. What is checked is that the
 * document quotes the same figures the probe produced and names their source, so a stale number is a
 * visible edit rather than a silent one.
 *
 * Run standalone: `node deepblend/tests/contract/cost-model.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C17)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'
import { REFERENCE_SECONDS_PER_FRAME, describeRenderCost } from '@deepblend/dsh-blender-tool'

const doc = readFileSync(join(ROOT, 'deepblend', 'docs', 'cost.md'), 'utf8')
const renderTools = readFileSync(join(ROOT, 'packages', 'deepblend', 'tool', 'lib', 'render-tools.js'), 'utf8')

test('the rate the document quotes is the constant the product uses', () => {
  // ONE DEFINITION. The rate was a string in the approval prompt and a sentence in the tool
  // description; the document would have been a third copy. It is a frozen constant now, and this
  // assertion ties the prose to it.
  assert.equal(REFERENCE_SECONDS_PER_FRAME.low, 19.6)
  assert.equal(REFERENCE_SECONDS_PER_FRAME.high, 41.4)
  assert.match(doc, new RegExp(`${REFERENCE_SECONDS_PER_FRAME.low}\\s*[–-]\\s*${REFERENCE_SECONDS_PER_FRAME.high}`),
    'cost.md does not quote the rate the product uses')
  assert.match(renderTools, /REFERENCE_SECONDS_PER_FRAME/, 'the tool no longer defines the rate')
})

test('the estimate is computed, and the document quotes what the prompt actually prints', () => {
  // The claim in the document is a SHAPE: `frames × rate`, rendered as a range in human units. The
  // document's own example has to be reproducible by the function the product calls.
  const example = describeRenderCost(450)
  assert.match(example, /^2\.5 hours to 5\.2 hours of machine time$/, example)
  assert.ok(doc.includes(example),
    `cost.md does not quote the estimate the prompt prints for 450 frames (${example})`)

  // And the properties that make it an estimate rather than a decoration: it scales, it is a range,
  // and an unknown frame count is answered with "unknown" instead of a guess.
  assert.notEqual(describeRenderCost(900), describeRenderCost(450))
  assert.match(describeRenderCost(900), /hours to .*hours/)
  assert.equal(describeRenderCost(null), 'an unknown amount of machine time')
  assert.equal(describeRenderCost(0), 'an unknown amount of machine time')
  // Singular, because a person reads this sentence.
  assert.match(describeRenderCost(3), /1 minute to 2 minutes/)
})

test('the token figures are the ones the probe produced, and the document names their source', () => {
  // Each figure carries the image it came from, because the two differ by six times in bytes and the
  // whole point of quoting both is that the cost is driven by the ANSWER rather than the picture.
  for (const total of ['1049', '740']) {
    assert.ok(doc.includes(total), `cost.md does not quote the measured total ${total}`)
  }
  assert.match(doc, /visual-review-live-probe\.mjs/, 'cost.md does not name the tool that produced the token figures')
  assert.match(doc, /contact-sheets\/round-0\.png/, 'cost.md does not name the contact sheet the second figure came from')
  assert.ok(existsSync(join(ROOT, 'deepblend', 'tools', 'visual-review-live-probe.mjs')))
})

test('the per-loop bound is derived from the configured iteration cap, not asserted from memory', () => {
  // The document says a loop is at most five reviews. That number belongs to the deployment's own
  // patch, so the assertion reads it there.
  const patch = readFileSync(join(ROOT, 'packages', 'deepblend', 'bundle', 'cordis.patch.yml'), 'utf8')
  const cap = (patch.match(/maxVisualIterations:\s*(\d+)/) ?? [])[1]
  assert.ok(cap !== undefined, 'the bundle patch no longer sets maxVisualIterations')
  assert.match(doc, new RegExp(`maxVisualIterations\`?\\s*(默认\\s*)?${cap}`),
    `cost.md does not state the configured iteration cap (${cap})`)
})

test('the document says what it does not know', () => {
  // A cost model that lists only its numbers reads as complete. The two gaps it names are real and
  // were measured while writing it: a successful review does not record its own `usage` (only the
  // empty-answer failure does), and nothing aggregates a session's tokens.
  assert.match(doc, /仍然不知道的/, 'cost.md does not state what it cannot answer')
  assert.match(doc, /成功的那次不记/, 'cost.md does not name the review record that keeps no usage')

  const host = readFileSync(join(ROOT, 'packages', 'deepblend', 'host', 'lib', 'index.js'), 'utf8')
  const successPath = host.slice(host.indexOf('const parsed = parseReviewerAnswer(raw)'))
  assert.ok(!/usage/.test(successPath.slice(0, 200)),
    'a successful review now records usage — cost.md says it does not, so one of the two is stale')
})
