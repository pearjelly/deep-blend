#!/usr/bin/env node
/**
 * Uninstall residue — what is left in a profile and a preset root after removing DeepBlend.
 *
 * WHY THIS EXISTS
 * ---------------
 * `install.md` §6 gave the uninstall as four steps, and following them IN ORDER re-installed
 * the plugin. MEASURED on a scratch `$DSH_HOME`: `dsh plugin remove` emptied the profile's
 * `dsh.profile.bundles` and `dependencies`, and the documented second step —
 * `plugin:install -- --portable` — answered `installed (3 change(s))` and wrote both keys
 * back. That step is an INSTALLER. Every command in the sequence exited 0, and the reader
 * ended exactly where they started.
 *
 * Three more residues were invisible for the same reason (nothing was looking):
 *
 *   - the operator layer this tool wrote (it pins storage to the checkout);
 *   - the seven `@deepblend/*` links under `profiles/node_modules/`;
 *   - the presets — a different root entirely, and the manual named ONE directory while the
 *     deployer installs every preset in `deepblend/presets/`, which is two.
 *
 * So the assertions below are of two kinds, and both are needed:
 *
 *   1. **the tool does what it says** — install, uninstall, read the home back. The fixture is
 *      a profile shaped like one `dsh` creates (the same fixture `install-plugin-modes.test.mjs`
 *      uses); the REAL profile, created by `dsh --profile web --dump-config`, is what
 *      `tools/uninstall-residue-probe.mjs` drives, because that needs `dsh` and pnpm and this
 *      layer promises to need neither.
 *   2. **the manual does not tell the reader to run an installer as an uninstaller** — the
 *      defect was in the prose, and the tool could have been perfect while the manual still
 *      walked a user in a circle. That one is asserted against `install.md` directly.
 *
 * WHAT IS DELIBERATELY NOT REMOVED, and therefore asserted as SURVIVING: a link into pnpm's
 * store (that is `dsh plugin remove`'s to prune), a foreign operator layer, a foreign preset
 * directory, and the preset root itself. An uninstaller that deletes a directory it did not
 * fill is the same class of mistake as an installer that overwrites a config file.
 *
 * Run: node deepblend/tests/contract/uninstall-residue.test.mjs
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C4)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localPackages, ROOT } from '../../tools/workspace-layout.mjs'

const PLUGIN_TOOL = join(ROOT, 'deepblend', 'tools', 'install-plugin.mjs')
const PRESET_TOOL = join(ROOT, 'deepblend', 'tools', 'install-presets.mjs')
const INSTALL_DOC = join(ROOT, 'deepblend', 'docs', 'install.md')

const BUNDLE_PACKAGE = '@deepblend/dsh-blender-bundle'

/** The presets this repository deploys — read from the source, not typed. */
const PRESETS = readdirSync(join(ROOT, 'deepblend', 'presets'))
  .filter(name => existsSync(join(ROOT, 'deepblend', 'presets', name, 'preset.yml')))
  .sort()

/** A scratch `$DSH_HOME` whose `web` profile looks like one `dsh` created. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'deepblend-uninstall-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '# Your patch layer for this dsh profile.\n[]\n')
  return home
}

/** Run one of the two tools with `DSH_HOME` pointed at a scratch home. */
function run(tool, home, ...args) {
  const result = spawnSync('node', [tool, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const manifestOf = home => JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
const scopeOf = home => join(home, 'profiles', 'node_modules', '@deepblend')
const presetRootOf = home => join(home, '.agent-presets')

/** The patch entries in an operator layer, ignoring its comment header. */
function entriesOf(text) {
  const body = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim()
  return body.length === 0 ? [] : JSON.parse(body)
}

/** The §6 section of `install.md`, up to the next `## `. */
function uninstallSection() {
  const doc = readFileSync(INSTALL_DOC, 'utf8')
  const start = doc.indexOf('## 6.')
  assert.ok(start >= 0, 'install.md no longer has a §6 — this assertion needs to follow it')
  const rest = doc.slice(start)
  const end = rest.indexOf('\n## ', 1)
  return end < 0 ? rest : rest.slice(0, end)
}

test('install then uninstall leaves a profile that names DeepBlend nowhere', () => {
  const home = makeHome()
  try {
    const installed = run(PLUGIN_TOOL, home)
    assert.equal(installed.status, 0, installed.stderr)
    assert.ok(manifestOf(home).dsh.profile.bundles.includes(BUNDLE_PACKAGE), 'the fixture did not install')
    assert.ok(existsSync(scopeOf(home)), 'the fixture installed no links')
    assert.ok(entriesOf(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).length > 0)

    const undone = run(PLUGIN_TOOL, home, '--uninstall')
    assert.equal(undone.status, 0, undone.stderr)

    const manifest = manifestOf(home)
    assert.ok(!manifest.dsh.profile.bundles.includes(BUNDLE_PACKAGE), 'the bundle is still composed')
    // The KEY, not just the entry: `dsh` writes no `dependencies` at all on a fresh profile,
    // so a leftover `{}` is a difference the next reader has to explain.
    assert.equal(manifest.dependencies, undefined, `a dependency entry survived: ${JSON.stringify(manifest.dependencies)}`)

    const layer = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    assert.ok(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml')), 'the profile file was deleted')
    assert.deepEqual(entriesOf(layer), [], 'the operator layer still pins a store DeepBlend no longer uses')

    assert.ok(!existsSync(scopeOf(home)), 'the scope directory outlived the links in it')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the links that are not this checkout\'s are left alone, and named', () => {
  const home = makeHome()
  try {
    assert.equal(run(PLUGIN_TOOL, home).status, 0)

    // What the npm and tarball routes leave behind: a link into pnpm's store. Removing it
    // here would produce a profile whose manifest still depends on a package whose link is
    // gone, so the reading has to be "left alone, and the reader is told which command
    // removes it".
    const foreign = join(home, 'profiles', 'node_modules', '.pnpm', '@deepblend+dsh-blender-host@0.2.0', 'node_modules', '@deepblend')
    mkdirSync(join(foreign, 'dsh-blender-host'), { recursive: true })
    const foreignLink = join(scopeOf(home), 'dsh-blender-host')
    rmSync(foreignLink, { recursive: true, force: true })
    symlinkSync(join(foreign, 'dsh-blender-host'), foreignLink)

    const undone = run(PLUGIN_TOOL, home, '--uninstall')
    assert.equal(undone.status, 0, undone.stderr)

    assert.ok(existsSync(foreignLink), 'a pnpm-managed link was removed by the wrong tool')
    assert.match(undone.stdout, /left alone/, 'the run removed what it did not write without saying so')
    assert.match(undone.stdout, /dsh plugin remove/, 'and it has to name the command that does remove it')
    assert.ok(existsSync(scopeOf(home)), 'the scope directory went while a link still lived in it')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an operator layer written by somebody else is refused by --uninstall too', () => {
  const home = makeHome()
  try {
    const mine = '# Somebody else\'s patch layer.\n[{"id": "their-row", "config": {"a": 1}}]\n'
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), mine)

    const undone = run(PLUGIN_TOOL, home, '--uninstall')
    assert.equal(undone.status, 0, undone.stderr)
    assert.equal(
      readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8'),
      mine,
      'an uninstaller deleted patch entries it did not write',
    )
    assert.match(undone.stdout, /NOT OURS/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--uninstall is idempotent, and --check afterwards agrees the profile does not have it', () => {
  const home = makeHome()
  try {
    assert.equal(run(PLUGIN_TOOL, home).status, 0)
    assert.equal(run(PLUGIN_TOOL, home, '--uninstall').status, 0)

    const again = run(PLUGIN_TOOL, home, '--uninstall')
    assert.equal(again.status, 0, 'uninstalling something that is not installed is not an error')
    assert.match(again.stdout, /nothing of DeepBlend was installed/)

    // THE READING THAT PROVES THE UNINSTALL HAPPENED, rather than that it printed. `--check`
    // reports drift when the profile does not compose the bundle, so a run that "uninstalled"
    // by writing nothing would still answer 0 here.
    const check = run(PLUGIN_TOOL, home, '--check')
    assert.equal(check.status, 1, `--check still reports the install as healthy:\n${check.stdout}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--check and --uninstall together are refused rather than guessed', () => {
  const home = makeHome()
  try {
    for (const tool of [PLUGIN_TOOL, PRESET_TOOL]) {
      const both = run(tool, home, '--check', '--uninstall')
      assert.equal(both.status, 2, `${tool} guessed which of two opposite questions was meant`)
      assert.match(both.stderr, /pick one/)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the presets this repository deploys all go, and nothing else in the root does', () => {
  const home = makeHome()
  try {
    assert.ok(PRESETS.length >= 2, `this assertion is vacuous with ${PRESETS.length} preset(s)`)
    assert.equal(run(PRESET_TOOL, home).status, 0)
    for (const preset of PRESETS) {
      assert.ok(existsSync(join(presetRootOf(home), preset, 'preset.yml')), `${preset} was not installed`)
    }

    // A preset from somewhere else, and a file directly in the root. Neither is ours.
    const foreign = join(presetRootOf(home), 'somebody-elses-preset')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'preset.yml'), 'name: theirs\n')

    const undone = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(undone.status, 0, undone.stderr)
    for (const preset of PRESETS) {
      assert.ok(!existsSync(join(presetRootOf(home), preset)), `${preset} survived the uninstall`)
    }
    assert.ok(existsSync(join(foreign, 'preset.yml')), 'the uninstaller removed a preset it did not deploy')
    assert.ok(existsSync(presetRootOf(home)), 'the uninstaller removed a root it did not fill')

    // Idempotent, and the third state `--check` already had: nothing installed is not drift.
    const again = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(again.status, 0)
    assert.match(again.stdout, /no DeepBlend preset was installed/)
    const check = run(PRESET_TOOL, home, '--check')
    assert.equal(check.status, 0, check.stdout)
    assert.match(check.stdout, /not installed on this machine/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the manual tells the reader to uninstall, not to run the installer again', () => {
  const section = uninstallSection()

  // THE DEFECT ITSELF, as an assertion — and it is asserted against the COMMAND BLOCKS,
  // because that is what the reader runs. `--portable` is an INSTALL mode: it registers the
  // bundle and writes the dependency key back. It sat in this section's second command block,
  // introduced by "然后是剩下的" ("then the rest"), which made it read as cleanup. Prose that
  // explains why it is NOT the uninstall is a different thing from a command that does it.
  const blocks = [...section.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map(match => match[1])
  assert.ok(blocks.length >= 1, 'the uninstall section names no commands at all')

  for (const block of blocks) {
    assert.doesNotMatch(block, /plugin:install|install-plugin\.mjs(?![\s\S]*--uninstall)/,
      `an uninstall command block still runs the installer:\n${block}`)
    // The hand-typed path that was wrong: the deployer installs every preset in the source
    // directory, so a manual listing one directory is right until the next preset is added.
    assert.doesNotMatch(block, /rm -rf[^\n]*\.agent-presets/, 'the manual is back to hand-deleting preset directories')
  }

  const commands = blocks.join('\n')
  assert.match(commands, /plugin:uninstall|install-plugin\.mjs --uninstall/, 'the uninstall command is not named')
  assert.match(commands, /presets:uninstall|install-presets\.mjs --uninstall/, 'the preset uninstall command is not named')

  // Every command the section names has to exist as a script, or the reader runs nothing.
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  for (const [, name] of commands.matchAll(/npm run ([\w:.-]+)/g)) {
    assert.ok(scripts[name] !== undefined, `install.md §6 names \`npm run ${name}\`, which is not a script`)
  }
})

test('the two uninstall modes are reachable from the repository root', () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  assert.match(scripts['plugin:uninstall'] ?? '', /install-plugin\.mjs --uninstall/)
  assert.match(scripts['presets:uninstall'] ?? '', /install-presets\.mjs --uninstall/)

  // The tools really answer to the flag, on a home with nothing in it: a script that points
  // at a file which does not understand `--uninstall` would exit 2 ("no profile") instead.
  const home = makeHome()
  try {
    for (const [tool, args] of [[PLUGIN_TOOL, ['--uninstall']], [PRESET_TOOL, ['--uninstall']]]) {
      const result = run(tool, home, ...args)
      assert.equal(result.status, 0, `${tool} ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('every local package this repository links is a package the uninstaller knows about', () => {
  // The list the uninstaller removes is `localPackages()`, the same list the installer links.
  // A package added to `packages/deepblend/` without the workspace layout knowing it would be
  // linked by nothing and removed by nothing — which is exactly how a residue starts.
  const local = localPackages()
  assert.ok(local.size >= 6, `only ${local.size} local package(s) found`)
  for (const [name, directory] of local) {
    assert.ok(name.startsWith('@deepblend/'), `${name} is outside the scope this tool manages`)
    assert.ok(existsSync(join(directory, 'package.json')), `${name} points at ${directory}, which has no manifest`)
  }
})
