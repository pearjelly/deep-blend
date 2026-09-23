#!/usr/bin/env node
/**
 * The upgrade path — measured once, and now the answer in the manual.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C3, the last gap in the install family. Three routes install and (since C2) agree; what a
 * user asks SECOND is "I have last month's build — how do I get this month's?", and `install.md` had
 * no answer because nobody had run the question as a command.
 *
 * The measurement found the two routes behave DIFFERENTLY, and the reason is worth keeping: the
 * ecosystem's `add` leaves an existing dependency's spec alone, so re-running it upgrades the tarball
 * route (whose spec changed, because its URL is version-free and the tag did the changing) and does
 * NOT upgrade the npm route (whose spec is still the old pin). The command that works on both is
 * `remove` then `add`.
 *
 * What is asserted here:
 *
 *   1. the committed reading covers both routes, starts each at the old version and ends each at the
 *      one this repository is at;
 *   2. it carries the `recorded spec` lines, because the version alone says what happened and the spec
 *      says why — and "why" is what the manual needed;
 *   3. `install.md` gives the two commands IN ORDER and says why re-running only the second is not
 *      enough. A manual that lists commands without the reason is the shape this repository keeps
 *      replacing with a command;
 *   4. the source route's answer is written down as the INFERENCE it is, not as a reading.
 *
 * Run standalone: `node deepblend/tests/contract/upgrade-path.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C3)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const LOG = join(ROOT, 'deepblend', 'docs', 'probe-upgrade-path.log')
const log = readFileSync(LOG, 'utf8')
const install = readFileSync(join(ROOT, 'deepblend', 'docs', 'install.md'), 'utf8')
const version = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'version.json'), 'utf8')).version

/** One `label: value` line out of the probe's output. */
const reading = (label) => {
  const match = log.match(new RegExp(`^${label}: (.*)$`, 'm'))
  return match === null ? null : match[1].trim()
}

test('the reading starts both routes at the old version and ends them at this repository\'s', () => {
  const old = reading('the old version each route starts from')
  assert.ok(old !== null && /^\d+\.\d+\.\d+$/.test(old), `the log does not name the old version: ${old}`)
  assert.equal(reading('the version this repository is at'), version)
  assert.notEqual(old, version, 'the log upgrades from the version it is already at, so it measures nothing')

  for (const route of ['npm', 'tarball']) {
    assert.match(log, new RegExp(`^${route} installed: @deepblend/dsh-blender-bundle@${old}$`, 'm'),
      `the log does not show the ${route} route starting at ${old}`)
    // And each route reached the current version by SOME documented command — which one differs, and
    // that difference is the finding.
    assert.match(log, new RegExp(`^${route} (after re-adding the current spec|after remove \\+ add): @deepblend/dsh-blender-bundle@${version}`, 'm'),
      `the log does not show the ${route} route reaching ${version}`)
  }
  assert.match(log, /^problems: 0$/m, 'the committed reading reports problems')
})

test('the reading carries the spec, which is why an upgrade did or did not move', () => {
  // THE MECHANISM, and the reason this log is more than a table of versions: `add` leaves an existing
  // dependency's spec alone, so the npm route stayed on its old pin while the tarball's URL changed.
  //
  // THE EXACT LINES, not a count and not "some line saying 0.2.1". MEASURED twice over: the first
  // version asked for a COUNT of spec lines and a mutation deleting one survived it; the second asked
  // for "some npm line equal to the old version" and a mutation deleting the INITIAL line survived
  // that too — because the post-re-add line says `0.2.1` as well. The mechanism lives in the pair:
  // the spec BEFORE the re-add, and the spec AFTER remove + add.
  const oldVersion = reading('the old version each route starts from')
  assert.match(log, new RegExp(`^npm recorded spec: ${oldVersion}$`, 'm'),
    'the log does not show the npm route keeping its old spec before the re-add')
  assert.match(log, new RegExp(`^npm recorded spec now: \\^${version}$`, 'm'),
    `the log does not show the npm route's spec becoming ${version} after remove + add`)
  assert.match(log, new RegExp(`^tarball recorded spec: .*v${oldVersion}.*$`, 'm'),
    'the log does not show the tarball route starting from the TAGGED url')
  assert.match(log, new RegExp(`^tarball recorded spec now: .*latest/download.*$`, 'm'),
    'the log does not show the tarball route moving to the version-free url')

})

test('the manual gives the upgrade as two commands in order, and says why one is not enough', () => {
  const section = install.slice(install.indexOf('### 升级到新版本'))
  assert.ok(section.length > 100, 'install.md has no upgrade section')

  const blocks = [...section.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map(match => match[1])
  const commands = blocks.join('\n')
  const remove = commands.indexOf('plugin remove')
  const add = commands.indexOf('plugin add')
  assert.ok(remove >= 0, 'the upgrade section does not name the remove command')
  assert.ok(add >= 0, 'the upgrade section does not name the add command')
  assert.ok(remove < add, 'the upgrade section lists add before remove, and the order is the instruction')

  // AND THE REASON. A manual that lists two commands without saying why the second alone is not enough
  // leaves the reader to try the obvious thing, watch it silently do nothing, and conclude the upgrade
  // is broken — which is exactly what the npm route does.
  assert.match(section, /不会动一个已经存在的依赖/, 'the upgrade section does not say why re-adding alone is not enough')
  assert.match(section, /probe-upgrade-path\.log/, 'the upgrade section does not cite the reading it came from')
})

test('the source route\'s answer is written down as an inference rather than a reading', () => {
  // It tracks the default branch, so there is no old version to start from — the question cannot be
  // asked of it, and the answer is reasoned from the other two. Saying "measured" here would be a
  // claim with no reading behind it, which is the one thing this ledger is built to prevent.
  const section = install.slice(install.indexOf('### 升级到新版本'))
  assert.match(section, /源码路线没有/, 'the upgrade section does not address the source route')
  assert.match(section, /这是\*\*推断\*\*，不是读数/, 'the source route answer is not marked as an inference')
  assert.doesNotMatch(log, /^source installed:/m, 'the log claims to have measured the source route, which it did not')
})
