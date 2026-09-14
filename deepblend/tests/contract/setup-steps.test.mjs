#!/usr/bin/env node
/**
 * Setup-step inventory contract test.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every gap this milestone closed had the same shape: **the step existed as
 * prose, so it did not exist.** `npm run setup` was "node_modules holds symlinks
 * into the deployment, see `.gitignore`"; the Blender install was
 * "see dsh-baseline.md §5"; the profile assembly was "the manual equivalent of
 * `dsh plugin --profile add`, see runtime-audit.md §5.4". Each of those sentences
 * was true, and none of them could be executed, so when the profile was
 * reinstalled on 2026-09-14 all three were gone at once and the repository could
 * not run, render, or install itself.
 *
 * The fix is a family of scripts in `deepblend/tools/`. This test keeps the
 * family honest, and it does so by DISCOVERING them rather than listing them —
 * a hand-written list is a copy, and the copy nobody runs is the one that rots
 * (architecture-decisions D38, D60):
 *
 *   1. every setup step is **tracked by git** (an ignored installer is no use to
 *      the clone that needs it);
 *   2. every setup step is **reachable from `package.json`** (a script nobody can
 *      find is the gap this whole milestone is about);
 *   3. every setup step is **named in a document a human reads** — and so is the
 *      npm script that runs it, because "the README says `npm run setup`" and
 *      "`npm run setup` exists" are two different claims.
 *
 * What it does NOT check: that any step was RUN. `--check` modes own that, and
 * the suites call them.
 *
 * Run: node deepblend/tests/contract/setup-steps.test.mjs
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

/** A file in `tools/` that changes the machine rather than describing it. */
const SETUP_STEP_PATTERN = /^(install|link)-[a-z-]+\.mjs$/

const TOOLS_DIRECTORY = join(ROOT, 'deepblend', 'tools')

const setupSteps = existsSync(TOOLS_DIRECTORY)
  ? readdirSync(TOOLS_DIRECTORY).filter(name => SETUP_STEP_PATTERN.test(name)).sort()
  : []

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const scripts = manifest.scripts ?? {}

/** Documents a human is expected to read before running anything. */
const documentation = ['README.md', 'CONTRIBUTING.md']
  .map(name => ({ name, text: readFileSync(join(ROOT, name), 'utf8') }))

const checkout = existsSync(join(ROOT, '.git'))

test('the setup steps are discovered, not listed', () => {
  // If the pattern stops matching, every assertion below passes vacuously — which
  // is the shape of a suite that went green because it stopped looking.
  assert.ok(
    setupSteps.length >= 4,
    `expected at least four setup steps in deepblend/tools, found ${setupSteps.length}: ${setupSteps.join(', ')}`,
  )
})

for (const step of setupSteps) {
  const file = `deepblend/tools/${step}`

  test(`${file} is reachable from package.json`, () => {
    const runners = Object.entries(scripts).filter(([, command]) => command.includes(`deepblend/tools/${step}`))
    assert.ok(
      runners.length > 0,
      `${file} is not referenced by any package.json script, so nothing tells a reader it exists`,
    )
  })

  test(`${file} is named in a document a human reads`, () => {
    const mentions = documentation.filter(document => document.text.includes(step))
    assert.ok(
      mentions.length > 0,
      `${file} appears in no document (checked ${documentation.map(d => d.name).join(', ')})`,
    )
  })

  test(`${file} is tracked by git`, { skip: checkout ? false : 'not a git checkout' }, () => {
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', relative(ROOT, join(TOOLS_DIRECTORY, step))], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    assert.equal(tracked, file, `${file} is present but not committed, so a fresh clone does not get it`)
  })
}

test('every setup step exposes a --check mode, because running is not inspecting', () => {
  // The `--check` convention is what lets a suite or a contributor ask "is this
  // machine set up" without changing it. A step without one can only be run,
  // which makes it unusable from a test that must not have side effects.
  for (const step of setupSteps) {
    const source = readFileSync(join(TOOLS_DIRECTORY, step), 'utf8')
    assert.ok(
      source.includes("'--check'"),
      `deepblend/tools/${step} does not recognise --check`,
    )
  }
})

test('the documented npm scripts are the ones package.json actually defines', () => {
  // The README is the front door. A renamed script that the README still names
  // breaks the documented path without breaking any other assertion here.
  const readme = documentation.find(document => document.name === 'README.md').text
  const documented = [...readme.matchAll(/npm run ([a-z:-]+)/g)].map(match => match[1])
  assert.ok(documented.length > 0, 'the README no longer tells anyone to run anything')

  for (const name of new Set(documented)) {
    assert.ok(
      Object.hasOwn(scripts, name),
      `README.md says \`npm run ${name}\` but package.json defines no such script`,
    )
  }
})
