#!/usr/bin/env node
/**
 * The workbench's copy — two locales, and the platform's own fallback rule.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C16. The harness localizes itself: `dsh-client-locale` ships `zh` and `en` and states its
 * fallback in one sentence — *"English is both the locale the UI opens in when the browser names no
 * registered language (and for non-browser runs), and the dictionary consulted after the active
 * locale misses a key ... because a browser naming no registered language is the reader least likely
 * to read Chinese"* (`FALLBACK_LOCALE = "en"`). It publishes the active locale on the page
 * (`document.documentElement.lang`).
 *
 * MEASURED before this file existed: the workbench hard-coded Chinese in every user-facing position,
 * so the reader the platform had deliberately routed to English got a Chinese screen. That is not a
 * preference — it is the product contradicting the platform it runs on.
 *
 * WHAT IS CHECKED
 * ---------------
 *   1. the two sides carry the SAME key set (the harness's own invariant, so a missing key cannot
 *      leave a hole in either direction);
 *   2. the locale is read from the page and falls back to English — for an unregistered language and
 *      for no browser at all;
 *   3. NO user-facing Chinese survives outside the table: the region is extracted and the rest of the
 *      file must be free of it. This is what stops the table from being decoration beside the real
 *      strings;
 *   4. every `t('key')` call site names a key that exists in both sides — a typo would otherwise
 *      render as the raw key to a user, which is a hole nobody would notice in a test that only
 *      counted strings.
 *
 * Run standalone: `node deepblend/tests/contract/workbench-copy.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C16)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { ROOT } from '../../tools/workspace-layout.mjs'

const SOURCE = readFileSync(join(ROOT, 'packages', 'deepblend', 'ui', 'lib', 'client.js'), 'utf8')

const REGION_START = '// #region strings'
const REGION_END = '// #endregion strings'
const region = SOURCE.slice(SOURCE.indexOf(REGION_START), SOURCE.indexOf(REGION_END))
assert.ok(region.length > 1000, 'the string region is missing from the client bundle')

/**
 * Evaluate the real region — not a copy of it — with a chosen `document`.
 *
 * The region ends with the table, the locale resolution and `t`, so evaluating it answers the
 * question a browser would: what does this file print for THIS page language?
 */
function stringsFor(lang) {
  const document = lang === undefined ? undefined : { documentElement: { lang } }
  const sandbox = { document, Object, String, RegExp }
  runInNewContext(`${region}\n;globalThis.__result = { STRINGS, LOCALE, t }`, sandbox)
  return sandbox.__result
}

test('the two locales carry the same key set', () => {
  const { STRINGS } = stringsFor('en')
  const zh = Object.keys(STRINGS.zh).sort()
  const en = Object.keys(STRINGS.en).sort()
  assert.ok(zh.length > 100, `only ${zh.length} string(s) — the table is not the workbench's copy`)
  assert.deepEqual(zh, en, 'the two sides disagree about which keys exist')
})

test('the locale comes from the page, and English is the fallback', () => {
  assert.equal(stringsFor('zh-CN').LOCALE, 'zh', 'a zh-CN page must resolve to zh')
  assert.equal(stringsFor('zh').LOCALE, 'zh')
  assert.equal(stringsFor('en-US').LOCALE, 'en')
  // THE PLATFORM'S OWN RULE, quoted at the top of this file: a language the product does not ship
  // gets English, "the reader least likely to read Chinese".
  assert.equal(stringsFor('fr').LOCALE, 'en', 'an unregistered language must fall back to English')
  assert.equal(stringsFor(undefined).LOCALE, 'en', 'a non-browser run must fall back to English')
  assert.equal(stringsFor('').LOCALE, 'en', 'an empty lang must fall back to English')
})

test('the same key renders in the active locale, and the fallback chain is explicit', () => {
  assert.equal(stringsFor('zh-CN').t('tab.projects'), '项目')
  assert.equal(stringsFor('en-US').t('tab.projects'), 'Projects')
  assert.equal(stringsFor('fr').t('tab.projects'), 'Projects', 'an unregistered language reads English')

  // Placeholders are filled, and an unknown name is left VISIBLE rather than blanked — a hole a
  // reader can report beats a hole a reader cannot see.
  const { t } = stringsFor('en-US')
  assert.equal(t('jobs.started', { jobId: 'render-1', frames: 450 }), 'Job render-1 started (450 frames)')
  assert.equal(t('jobs.started', { jobId: 'render-1' }), 'Job render-1 started ({frames} frames)')
  assert.equal(t('a.key.that.does.not.exist'), 'a.key.that.does.not.exist')
})

test('no user-facing Chinese survives outside the table', () => {
  // THE ASSERTION THAT MAKES THE TABLE MEAN SOMETHING. A region that holds the strings while the
  // render paths keep their own literals would pass every check above and change nothing a user sees.
  const outside = SOURCE.slice(0, SOURCE.indexOf(REGION_START)) + SOURCE.slice(SOURCE.indexOf(REGION_END))
  // Comments are allowed to discuss the product in Chinese; what must not is code.
  const code = outside.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const literals = [...code.matchAll(/'([^'\\\n]*[\u4e00-\u9fa5][^'\\\n]*)'/g)].map(match => match[1])
  assert.deepEqual(literals, [], `these strings are still hard-coded outside the table: ${literals.slice(0, 5).join(' | ')}`)
})

test('every t() call site names a key that exists', () => {
  const { STRINGS } = stringsFor('en')
  const known = new Set(Object.keys(STRINGS.zh))
  const calls = [...SOURCE.matchAll(/\bt\(\s*'([^']+)'/g)].map(match => match[1])
  assert.ok(calls.length > 100, `only ${calls.length} call site(s) — the migration is not complete`)

  const unknown = [...new Set(calls)].filter(key => !known.has(key))
  assert.deepEqual(unknown, [], `these keys are used but do not exist, so a user would see the key itself: ${unknown.join(', ')}`)

  // And the other direction, so the table cannot accumulate strings nothing renders.
  const unused = [...known].filter(key => !calls.includes(key))
  assert.deepEqual(unused, [], `these keys are in the table but no call site uses them: ${unused.join(', ')}`)
})
