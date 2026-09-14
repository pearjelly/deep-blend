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
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

/** A file in `tools/` that changes the machine rather than describing it. */
const SETUP_STEP_PATTERN = /^(install|link)-[a-z-]+\.mjs$/

const TOOLS_DIRECTORY = join(ROOT, 'deepblend', 'tools')
const PRESETS_DIRECTORY = join(ROOT, 'deepblend', 'presets')

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

// ---------------------------------------------------------------------------
// What "--check" means when the thing is not there at all
// ---------------------------------------------------------------------------

/**
 * Run `install-presets.mjs --check` against a throwaway DSH home.
 *
 * A fresh `DSH_HOME` is the state of every clone and every CI runner, and it costs nothing
 * to produce: this is a REAL run of the real script, in the state the question is about.
 *
 * @param {string} home
 * @param {(target: string) => void} [prepare]
 */
function checkPresets(home, prepare = () => {}) {
  prepare(home)
  const outcome = spawnSync(process.execPath, [join(TOOLS_DIRECTORY, 'install-presets.mjs'), '--check'], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
  })
  return { status: outcome.status, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' }
}

test('a preset that is not installed at all is a state, not drift', () => {
  // THE DEFECT THIS PINS. `--check` used to count a missing file as drift, so it exited 1
  // with "5 file(s) drifted" on every fresh clone and every CI runner — red exactly where
  // nothing was wrong, and with a `fix:` line telling the reader to install something they
  // never asked for. Its sibling `plugin:check` had the third state right all along
  // (a missing profile is exit 2 with an explanation), and D75 named it for the capability
  // probe. Found by running the check in a Linux container; `milestone-status.md` §25.
  const home = mkdtempSync(join(tmpdir(), 'deepblend-presets-absent-'))
  try {
    const outcome = checkPresets(home)
    assert.equal(outcome.status, 0, `--check exits ${outcome.status} on a machine where the presets were never installed:\n${outcome.stdout}`)
    assert.match(outcome.stdout, /not installed on this machine/, 'the absent state is not named in the output')
    assert.match(outcome.stdout, /nothing to drift/, 'the output does not say that there is nothing to report')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a partly installed, drifted or stale deployment is still drift', () => {
  // The other direction, and the reason the third state is safe to add: "absent" is a
  // narrow condition, so no real problem can hide inside it. Each of the three is produced
  // for real, on a throwaway home.
  const cases = [
    ['half installed', /MISSING/, home => {
      mkdirSync(join(home, '.agent-presets', 'deepblend'), { recursive: true })
      copyFileSync(join(PRESETS_DIRECTORY, 'deepblend', 'preset.yml'), join(home, '.agent-presets', 'deepblend', 'preset.yml'))
    }],
    ['drifted', /DRIFTED/, home => {
      install(home)
      appendFileSync(join(home, '.agent-presets', 'deepblend', 'preset.yml'), '\n# edited by hand\n')
    }],
    ['stale', /STALE/, home => {
      install(home)
      writeFileSync(join(home, '.agent-presets', 'deepblend', 'obsolete.md'), 'left over from an older release\n')
    }],
  ]

  for (const [label, named, prepare] of cases) {
    const home = mkdtempSync(join(tmpdir(), 'deepblend-presets-drift-'))
    try {
      const outcome = checkPresets(home, prepare)
      assert.equal(outcome.status, 1, `${label} was not reported as drift (exit ${outcome.status}):\n${outcome.stdout}`)
      assert.match(outcome.stdout, /drifted/, `${label} does not say "drifted" in its summary:\n${outcome.stdout}`)
      // And WHICH of the three ways it drifted, per file: "installed but stale", "installed
      // and different" and "not there" are three different repairs.
      assert.match(outcome.stdout, named, `${label} is reported without naming what is wrong:\n${outcome.stdout}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  /** Deploy the real presets into a throwaway home, the way a contributor would. */
  function install(home) {
    const outcome = spawnSync(process.execPath, [join(TOOLS_DIRECTORY, 'install-presets.mjs')], {
      cwd: ROOT,
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
    assert.equal(outcome.status, 0, `installing into a throwaway home failed: ${outcome.stderr}`)
  }
})
