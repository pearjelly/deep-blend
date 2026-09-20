/**
 * The installers' `--check` modes, audited by breaking what they check.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four `--check` scripts are the repository's operator-facing guarantees: `setup:check`,
 * `blender:check`, `plugin:check`, `presets:check`. Three of them were exercised by NOTHING — the comment
 * beside the one that bit somebody says so in as many words ("nothing but a hand-run `npm run plugin:check`
 * surfaced it"). A check that cannot fail is worse than no check, and the only way to know which kind you have
 * is to break the thing it looks at and watch it complain.
 *
 * HOW IT STAYS SAFE
 * -----------------
 * Both installers resolve their operator layer from `$DSH_HOME` (`process.env.DSH_HOME ?? ~/.dsh`), so this file
 * builds a THROWAWAY home in a temp directory and drives the whole lifecycle there: nothing to install into,
 * install, drift, re-install. The real `~/.dsh` is never written — and the last case proves it, by running the
 * real `plugin:check` and requiring it to still report "in sync".
 *
 * WHAT IT PINS, BESIDES "IT FAILS"
 * --------------------------------
 * The exit codes are a contract, not an implementation detail: the plugin layer says 0 = in sync, 1 = drift,
 * 2 = nothing to install into, and the preset layer says absent-entirely is a STATE (0) while PARTLY present is
 * drift (1). The second half is the subtle one — it was a real defect until 2026-09-14, when a fresh clone's
 * `--check` exited 1 with "5 file(s) drifted" on a machine where nothing was wrong.
 *
 * Run standalone: `node deepblend/tests/contract/installer-drift.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MANAGED_BLENDER_RELATIVE_PATHS, MANAGED_TOOLS_DIRECTORY } from '@deepblend/dsh-blender-contracts'

import { ROOT } from '../../tools/workspace-layout.mjs'

/** Run a tool with a given `DSH_HOME`, and report its exit code and output together. */
function run(tool, args, home) {
  const result = spawnSync('node', [join(ROOT, 'deepblend', 'tools', tool), ...args], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: home },
  })
  assert.ok(result.status !== null, `${tool} ${args.join(' ')} did not exit: ${result.error?.message}`)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** A profile directory `dsh` would have created: the installer composes its rows into one. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'deepblend-installer-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'web', 'package.json'),
    `${JSON.stringify({ name: 'web', private: true, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  )
  return home
}

test('plugin --check says "nothing to install into" (2) when there is no profile at all', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepblend-installer-'))
  try {
    const checked = run('install-plugin.mjs', ['--check'], home)
    assert.equal(checked.status, 2, `expected the documented "nothing to install into" code:\n${checked.output}`)
    assert.match(checked.output, /no profile at/, 'and it must say which profile it looked for')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('plugin: install, drift, re-install — and the codes are 0, 1, 0', () => {
  const home = makeHome()
  try {
    const installed = run('install-plugin.mjs', [], home)
    assert.equal(installed.status, 0, installed.output)

    const inSync = run('install-plugin.mjs', ['--check'], home)
    assert.equal(inSync.status, 0, `a fresh install must check clean:\n${inSync.output}`)
    assert.match(inSync.output, /installed in the "web" profile/)

    // The operator layer this installer OWNS is the profile's `cordis.patch.yml`; the packages it links are
    // symlinks into this repository, and writing through those would edit the repository instead of the home.
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    assert.ok(existsSync(patch), 'the installer must have written the profile patch')
    appendFileSync(patch, '\n# drift introduced by this test\n')

    const drifted = run('install-plugin.mjs', ['--check'], home)
    assert.equal(drifted.status, 1, `drift must be exit 1, not "fine":\n${drifted.output}`)
    assert.match(drifted.output, /1 thing\(s\) are not installed/, drifted.output)
    assert.match(drifted.output, /fix: node deepblend\/tools\/install-plugin\.mjs/, 'and it must name the fix')

    const repaired = run('install-plugin.mjs', [], home)
    assert.equal(repaired.status, 0, repaired.output)
    assert.equal(run('install-plugin.mjs', ['--check'], home).status, 0, 'and the repair must check clean')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('presets --check: absent entirely is a STATE (0), partly present is DRIFT (1)', () => {
  const home = makeHome()
  try {
    const absent = run('install-presets.mjs', ['--check'], home)
    assert.equal(absent.status, 0,
      `a machine that never installed the presets is not broken, so this must be 0:\n${absent.output}`)
    assert.match(absent.output, /nothing to drift/, 'and it must say why 0 is the honest answer')

    assert.equal(run('install-presets.mjs', [], home).status, 0, 'the install itself')
    const inSync = run('install-presets.mjs', ['--check'], home)
    assert.equal(inSync.status, 0, inSync.output)
    assert.match(inSync.output, /match the repository/)

    // PARTLY present is the case that was wrong until 2026-09-14: the counter said "drift" for files that were
    // simply absent. One file missing from an installed layer is drift, and this is the assertion that says so.
    const installedRoot = join(home, '.agent-presets')
    const walk = directory => readdirSync(directory, { withFileTypes: true })
      .flatMap(entry => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]))
    const files = walk(installedRoot)
    assert.ok(files.length > 1, `the preset layer should hold several files, found ${files.length}`)
    rmSync(files[0])

    const partly = run('install-presets.mjs', ['--check'], home)
    assert.equal(partly.status, 1, `one missing file out of ${files.length} is drift:\n${partly.output}`)
    assert.match(partly.output, /drift/i, partly.output)

    assert.equal(run('install-presets.mjs', [], home).status, 0, 'the repair')
    assert.equal(run('install-presets.mjs', ['--check'], home).status, 0, 'and it checks clean again')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('blender:check agrees with the machine it is on, and never claims 0 without an install', () => {
  // THE FOURTH CHECK, AND THE ONE THAT CANNOT BE DRIVEN INTO DRIFT SAFELY. It reads the managed install that
  // lives inside THIS repository (`deepblend/tools/<app>`), with no override — so breaking it would mean moving
  // a real Blender or editing the pinned release record, both of which are the machine rather than a fixture.
  // What is reachable is asserted: where an install exists it must verify clean, and where none exists it must
  // NOT report "installed and matching" (its documented code for that is 0; the contract names no code for
  // "absent", so this asserts only what is true either way). The drift branch — a digest that does not match —
  // is exercised by `blender:install` and by hand, and is named here rather than pretended.
  //
  // MEASURED, so the next reader does not mistake the coverage for something it is not: on a machine WITH the
  // install (this one), the absent branch is unreachable, and a mutation that breaks it there is EQUIVALENT —
  // it survives. CI is where the other half runs, because a runner has no Blender. The present branch is the one
  // this machine can pin, and the mutation that makes it exit 1 goes red here.
  // Derived from the same constants the installer uses (`MANAGED_TOOLS_DIRECTORY` is `.tools`, and the app name
  // is the first segment of `MANAGED_BLENDER_RELATIVE_PATHS[0]`) — the first version of this probe hardcoded
  // `deepblend/tools/Blender.app`, found nothing, and then failed a machine that HAS Blender installed.
  const app = join(ROOT, MANAGED_TOOLS_DIRECTORY, MANAGED_BLENDER_RELATIVE_PATHS[0].split('/')[0])
  const present = existsSync(app)
  const checked = spawnSync('node', [join(ROOT, 'deepblend', 'tools', 'install-blender.mjs'), '--check'], {
    cwd: ROOT, encoding: 'utf8',
  })
  assert.ok(checked.status !== null, 'blender:check did not exit')
  if (present) {
    assert.equal(checked.status, 0,
      `the managed install is present, so this must verify clean:\n${checked.stdout}${checked.stderr}`)
    assert.match(`${checked.stdout}${checked.stderr}`, /(in sync|matching|installed)/i)
  } else {
    assert.notEqual(checked.status, 0,
      `there is no managed install, so this must not report success:\n${checked.stdout}${checked.stderr}`)
  }
})

test('and the real DSH home was never touched: its own plugin:check still reports in sync', () => {
  const real = spawnSync('npm', ['run', '--silent', 'plugin:check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(real.status, 0,
    `the real deployment drifted — this test only ever wrote to temp homes, so something else did:\n` +
    `${real.stdout}${real.stderr}`)
})
