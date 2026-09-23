#!/usr/bin/env node
/**
 * The three install routes serve the same product — the comparison, and the reading it produced.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C2, and the oldest named gap in this repository: every route had been verified on its own,
 * and nothing asserted that they agree. The routes fetch from three different places (the default
 * branch, the registry, the Release asset), so they can disagree — and the way they disagree is quiet,
 * because each one reports success about a different product.
 *
 * Two things are checked here, and they are different kinds of check:
 *
 *   1. **the comparison itself**, driven with readings — so the negative controls run in milliseconds
 *      instead of three installs. The case that matters most is two routes that agree with EACH OTHER
 *      while both being stale: agreement alone is not the claim, agreement with the repository is.
 *   2. **the committed reading** (`probe-route-parity.log`), whose shape has to keep saying that three
 *      real routes were installed and read back — including the one number that must DIFFER, which is
 *      what stops "they agree" from meaning "nothing was measured".
 *
 * Run standalone: `node deepblend/tests/contract/route-parity.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C2)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'
import { ROUTES, compareRoutes, reading, repositoryVersion } from '../../tools/route-parity.mjs'

const LOG = join(ROOT, 'deepblend', 'docs', 'probe-route-parity.log')
const log = readFileSync(LOG, 'utf8')
const version = repositoryVersion(ROOT)

/** Three agreeing readings, which each case then breaks in one specific way. */
function readings(overrides = {}) {
  const base = { workbench: 'HTTP 200, text/html; charset=utf-8', presets: '["deepblend","deepblend-dev"]', verdict: 'the spec installs' }
  return ROUTES.map(route => ({
    id: route.id,
    version: `@deepblend/dsh-blender-bundle@${version}`,
    fetched: route.fetched,
    ...base,
    ...(overrides[route.id] ?? {}),
  }))
}

const problemsOf = (list) => compareRoutes({ readings: list, routes: ROUTES, expected: version }).problems

test('three agreeing routes produce no problems — so the check is not vacuous', () => {
  assert.deepEqual(problemsOf(readings()), [])
})

test('two routes that disagree are reported, naming both versions', () => {
  const split = problemsOf(readings({ npm: { version: '@deepblend/dsh-blender-bundle@0.0.1' } }))
  assert.equal(split.length, 1, split.join(' | '))
  assert.match(split[0], /2 different versions/)
  assert.match(split[0], /0\.0\.1/)
})

test('two routes that agree with EACH OTHER but not with the repository are reported', () => {
  // THE CASE THE CHECK EXISTS FOR, and the one agreement alone would call healthy: a Release and a
  // registry that both serve last month's build are perfectly consistent with one another.
  const stale = problemsOf(readings({
    source: { version: '@deepblend/dsh-blender-bundle@0.0.1' },
    npm: { version: '@deepblend/dsh-blender-bundle@0.0.1' },
    tarball: { version: '@deepblend/dsh-blender-bundle@0.0.1' },
  }))
  assert.equal(stale.length, 1, stale.join(' | '))
  assert.match(stale[0], /version\.json says/)
})

test('a route whose workbench route does not answer is reported, by route', () => {
  const dead = problemsOf(readings({ tarball: { workbench: 'HTTP 404, no content-type' } }))
  assert.equal(dead.length, 1, dead.join(' | '))
  assert.match(dead[0], /tarball/)
  assert.match(dead[0], /workbench/)
})

test('the count that must DIFFER is checked too, in both directions', () => {
  // If every reading had to be identical, a run that measured nothing would pass. The tarball route
  // carries its siblings; the others resolve them.
  const allSeven = problemsOf(readings({ tarball: { fetched: '7' } }))
  assert.equal(allSeven.length, 1, allSeven.join(' | '))
  assert.match(allSeven[0], /expected to fetch 1/)

  const allOne = problemsOf(readings({ source: { fetched: '1' }, npm: { fetched: '1' } }))
  assert.equal(allOne.length, 2, allOne.join(' | '))
})

test('routes that delivered different presets are reported', () => {
  const presets = problemsOf(readings({ npm: { presets: '["deepblend"]' } }))
  assert.equal(presets.length, 1, presets.join(' | '))
  assert.match(presets[0], /different presets/)
})

test('the committed reading says three routes were installed and read back', () => {
  const routes = ['source', 'npm', 'tarball']
  for (const route of routes) {
    assert.match(log, new RegExp(`^── ${route}: `, 'm'), `the log has no section for the ${route} route`)
  }
  assert.match(log, /^problems: 0$/m, 'the committed reading reports problems')
  assert.match(log, /the three install routes serve the same product/, 'the log has no verdict line')

  // The three versions agree, and they are the repository's — read out of the log rather than trusted.
  const served = [...log.matchAll(/^(source|npm|tarball) installed: (.+)$/gm)].map(match => match[2])
  assert.equal(served.length, 3, `the log reports ${served.length} installed version(s)`)
  assert.equal(new Set(served).size, 1, `the log's three routes disagree: ${served.join(' | ')}`)
  assert.ok(served[0].endsWith(`@${version}`),
    `the log says the routes serve ${served[0]}, and deepblend/version.json says ${version}`)

  // And the difference that proves the three really were different paths.
  assert.match(log, /^tarball packages pnpm fetched: 1$/m)
  assert.match(log, /^source packages pnpm fetched: 7$/m)
  assert.match(log, /^npm packages pnpm fetched: 7$/m)
})

test('the log states how the check was shown to fail', () => {
  // A comparison that has never been seen to report a disagreement is a comparison nobody has tested.
  // The header carries the command that breaks it, so the next reader can run it.
  assert.match(log, /DEEPBLEND_PARITY_NPM_SPEC/)
  assert.match(log, /different versions/)
})

test('the reading helper reads the probe lines the probe actually prints', () => {
  const output = 'installed version: @deepblend/x@1.2.3\nworkbench route: HTTP 200, text/html\nresult: fine\n'
  assert.equal(reading(output, 'installed version'), '@deepblend/x@1.2.3')
  assert.equal(reading(output, 'workbench route'), 'HTTP 200, text/html')
  assert.equal(reading(output, 'nothing here'), null)
})
