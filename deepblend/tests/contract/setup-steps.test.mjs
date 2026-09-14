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
import { commandsIn, missingCommands } from '../lib/command-claims.mjs'

/** A file in `tools/` that changes the machine rather than describing it. */
const SETUP_STEP_PATTERN = /^(install|link)-[a-z-]+\.mjs$/

const TOOLS_DIRECTORY = join(ROOT, 'deepblend', 'tools')
const PRESETS_DIRECTORY = join(ROOT, 'deepblend', 'presets')

/** The Blender pin: version, platform, image and digest. */
const blenderPin = JSON.parse(readFileSync(join(TOOLS_DIRECTORY, 'blender-release.json'), 'utf8'))

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

test('the commands the README documents are ones a reader can run', () => {
  // The README is the front door. A renamed script it still names breaks the documented path without
  // breaking any other assertion here — and since round 34 the check is the shared one
  // (`tests/lib/command-claims.mjs`), which also resolves the repository paths it names.
  const readme = documentation.find(document => document.name === 'README.md').text
  const documented = commandsIn(readme)
  assert.ok(documented.length > 0, 'the README no longer tells anyone to run anything')

  const missing = missingCommands(readme, { scripts, root: ROOT })
  assert.deepEqual(missing, [], `README.md tells a reader to run ${missing.join(', ')}, which cannot be run`)
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

// ---------------------------------------------------------------------------
// The advice a blocked step gives
// ---------------------------------------------------------------------------

test('the platform guard tells the user about a knob the PRODUCT has', () => {
  // `install-blender.mjs` refuses on any platform its pinned DMG cannot serve, and its
  // advice used to be "set DEEPBLEND_BLENDER_PATH to its binary". That variable is read by
  // this repository's tests and probes and by NOTHING ELSE — `grep -rn DEEPBLEND_BLENDER_PATH
  // deepblend/tests` is the whole list. The installed product reads `blenderPath` on the
  // `deepblend-blender-runtime` row, which an operator sets in the operator layer. So a user
  // who followed the advice would set a variable nothing consults, at the one moment they
  // had already hit a wall, and `install.md` said `blenderPath` all along: the script and
  // the manual disagreed exactly when they needed to agree. Found by running this file's
  // subject in a Linux container; `milestone-status.md` §26.
  const installer = readFileSync(join(TOOLS_DIRECTORY, 'install-blender.mjs'), 'utf8')
  const guardStart = installer.indexOf('if (process.platform !==')
  const guardEnd = installer.indexOf('const present =')
  assert.ok(guardStart !== -1 && guardEnd > guardStart, 'install-blender.mjs no longer has the platform guard this test describes')
  const guard = installer.slice(guardStart, guardEnd)

  assert.match(guard, /blenderPath/, 'the advice does not name the knob the product reads')
  assert.match(
    guard,
    /cordis\.patch\.yml/,
    'the advice names a knob without saying where to set it — the operator layer is the "where", and a user who is already stuck will not guess it',
  )

  // And if it mentions the test-only variable at all, it has to say what it is. The two are
  // easy to confuse precisely because the tests are where a contributor meets the other one.
  if (guard.includes('DEEPBLEND_BLENDER_PATH')) {
    assert.match(
      guard,
      /does not/,
      'the guard mentions DEEPBLEND_BLENDER_PATH without saying that the installed product does not read it',
    )
  }

  // The key is real. `imports.test.mjs` asserts the provider's whole config schema against a
  // declared key list; this pins only the spelling the advice uses, so that a rename cannot
  // leave the advice pointing at a key that no longer exists.
  const provider = readFileSync(join(ROOT, 'packages', 'deepblend', 'provider-local', 'lib', 'index.js'), 'utf8')
  assert.match(
    provider,
    /blenderPath:\s*z\.string\(\)\.default\('auto'\)/,
    'the advice names `blenderPath`, but the provider no longer declares it with its documented default',
  )
})

test('the platform the managed Blender is pinned for is stated where prerequisites are', () => {
  // A boundary nobody can find is not a boundary. The pin records `platform`, and both
  // documents that list prerequisites have to say it — in the pin's own terms rather than in
  // a paraphrase that can drift from it. Normalised, so "macOS arm64" and "macos-arm64" are
  // the same claim.
  const wanted = blenderPin.platform.replace(/[^a-z0-9]/gi, '').toLowerCase()
  assert.ok(wanted.length > 0, 'the Blender pin no longer records a platform')

  for (const name of ['README.md', 'deepblend/docs/install.md']) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    assert.ok(
      text.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(wanted),
      `${name} states prerequisites without stating that the managed Blender is ${blenderPin.platform}`,
    )
  }
})

test('the profile installer says why it still exists, and it is not pnpm', () => {
  // A STEP THAT CANNOT SAY WHY IT EXISTS IS THE ONE SOMEBODY DELETES.
  //
  // `install-plugin.mjs` used to justify itself as "the manual equivalent of
  // `dsh plugin --profile add`, because this machine has no pnpm". That is a statement about
  // one machine, not about the product: `dsh plugin` needs pnpm on PATH and pnpm is
  // installable, and with it the supported path works from a checkout today (measured end to
  // end in `docs/probe-dsh-plugin-install.log` — the profile it produces serves
  // `/deepblend/capabilities` with HTTP 200). What the supported path does NOT do is pin the
  // store: it leaves it at `<DSH_HOME>/deepblend`, so a checkout would show an empty project
  // list beside a project that exists on disk. That difference is the reason this script is
  // still here, and it has to be the reason its own header gives.
  const installer = readFileSync(join(TOOLS_DIRECTORY, 'install-plugin.mjs'), 'utf8')
  const header = installer.slice(0, installer.indexOf('*/'))

  // The REASON, not the word: the header mentions "operator layer" in three other places
  // (what it touches, what --portable skips, what it refuses to overwrite), so an assertion on
  // that phrase survives the deletion of the sentence that justifies the script.
  // The reason as a COMPARISON — both halves have to be there. A header that mentions the
  // supported command without saying what it leaves undone reads as "this script is
  // redundant"; one that mentions the storage without the command reads as "we never checked".
  assert.match(
    header,
    /dsh plugin --profile web add/,
    'the installer no longer names the supported command it was measured against',
  )
  assert.match(
    header,
    /product default/,
    'the installer no longer states the difference that keeps it alive: the supported path leaves the store at the product default',
  )
  assert.match(
    header,
    /probe-dsh-plugin-install\.log/,
    'the installer does not point at the measurement that decided its own fate (Q10 → D98)',
  )

  // And the manual a user reads has to name BOTH paths, because they are not equivalent and
  // the reader is the one who has to choose.
  const install = readFileSync(join(ROOT, 'deepblend', 'docs', 'install.md'), 'utf8')
  assert.match(install, /dsh plugin --profile/, 'install.md does not mention the supported install path at all')
  assert.match(install, /plugin:install/, 'install.md does not mention the repository installer')
  // The claim has to be ATTACHED to that path, not merely present in the file: install.md
  // already names `pnpm-workspace.yaml` in a list of files the launcher writes, so a bare
  // /pnpm/ passes while saying nothing about the install path.
  const at = install.indexOf('dsh plugin --profile')
  const window = install.slice(Math.max(0, at - 400), at + 400)
  assert.match(
    window,
    /pnpm[^\n]{0,24}(在 PATH|on PATH)/,
    'install.md names the supported path without saying it needs pnpm ON PATH — a bare mention of pnpm elsewhere in the file is not the prerequisite a reader following it hits',
  )
})
