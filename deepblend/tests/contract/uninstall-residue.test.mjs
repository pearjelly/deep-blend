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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localPackages, ROOT } from '../../tools/workspace-layout.mjs'
import { resolveDshScope } from '../lib/dsh-deployment.mjs'
import { withInstallerLock } from '../../tools/installer-transaction.mjs'

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
const ownershipOf = home => join(home, '.deepblend-preset-ownership.json')

function filesInHome(home) {
  const files = {}
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else files[path.slice(home.length)] = entry.isSymbolicLink() ? `link:${readlinkSync(path)}` : readFileSync(path, 'base64')
    }
  }
  walk(home)
  return files
}

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

test('preset uninstall preserves both profiles until their final declared bundle reference is removed', () => {
  const home = makeHome()
  try {
    cpSync(join(home, 'profiles', 'web'), join(home, 'profiles', 'second'), { recursive: true })
    assert.equal(run(PLUGIN_TOOL, home).status, 0)
    assert.equal(run(PLUGIN_TOOL, home, '--profile', 'second').status, 0)
    assert.equal(run(PRESET_TOOL, home).status, 0)
    const before = filesInHome(home)
    const refused = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /still referenced/)
    assert.match(refused.stderr, /web/)
    assert.match(refused.stderr, /second/)
    assert.deepEqual(filesInHome(home), before)
    assert.equal(run(PLUGIN_TOOL, home, '--uninstall').status, 0)
    const oneLeft = filesInHome(home)
    assert.equal(run(PRESET_TOOL, home, '--uninstall').status, 2)
    assert.deepEqual(filesInHome(home), oneLeft)
    assert.equal(run(PLUGIN_TOOL, home, '--profile', 'second', '--check').status, 0)
    assert.equal(run(PLUGIN_TOOL, home, '--profile', 'second', '--uninstall').status, 0)
    const removed = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(removed.status, 0, removed.stderr)
    for (const id of PRESETS) assert.ok(!existsSync(join(presetRootOf(home), id)))
    assert.ok(!existsSync(ownershipOf(home)))
    assert.ok(existsSync(presetRootOf(home)), 'the shared preset root remains')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('explicit preset selection also prevents removal after its bundle has been unregistered', () => {
  const home = makeHome()
  try {
    assert.equal(run(PRESET_TOOL, home).status, 0)
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[{"id":"agent-presets","config":{"default":"deepblend"}}]\n')
    const before = filesInHome(home)
    const result = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(result.status, 2)
    assert.match(result.stderr, /web \(cordis.patch.yml\)/)
    assert.deepEqual(filesInHome(home), before)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('all explicit dependency fields protect shared links and presets in the current or another profile', () => {
  for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const profile of ['web', 'second']) {
      const home = makeHome()
      try {
        if (profile === 'second') cpSync(join(home, 'profiles', 'web'), join(home, 'profiles', profile), { recursive: true })
        assert.equal(run(PLUGIN_TOOL, home).status, 0)
        assert.equal(run(PRESET_TOOL, home).status, 0)
        const manifestPath = join(home, 'profiles', profile, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        manifest[field] = { '@deepblend/dsh-blender-contracts': '*' }
        writeFileSync(manifestPath, JSON.stringify(manifest))
        const removed = run(PLUGIN_TOOL, home, '--uninstall')
        assert.equal(removed.status, 0, `${field} in ${profile}: ${removed.stderr}`)
        assert.ok(existsSync(join(home, 'profiles', 'node_modules', '@deepblend', 'dsh-blender-contracts', 'package.json')))
        const before = filesInHome(home)
        const refused = run(PRESET_TOOL, home, '--uninstall')
        assert.equal(refused.status, 2, `${field} in ${profile}: ${refused.stderr}`)
        assert.ok(refused.stderr.includes(`${profile} (package.json)`))
        assert.deepEqual(filesInHome(home), before)
        const remaining = JSON.parse(readFileSync(manifestPath, 'utf8'))
        delete remaining[field]
        writeFileSync(manifestPath, JSON.stringify(remaining))
        assert.equal(run(PLUGIN_TOOL, home, '--uninstall').status, 0)
        assert.ok(!existsSync(join(home, 'profiles', 'node_modules', '@deepblend')))
        assert.equal(run(PRESET_TOOL, home, '--uninstall').status, 0)
      } finally { rmSync(home, { recursive: true, force: true }) }
    }
  }
})

test('preset reinstall preserves user edits but upgrades files that still match their previous receipt', () => {
  const home = makeHome()
  try {
    assert.equal(run(PRESET_TOOL, home).status, 0)
    const path = join(presetRootOf(home), 'deepblend', 'preset.yml')
    const published = readFileSync(path)
    writeFileSync(path, 'my edited preset\n')
    const before = filesInHome(home)
    const refused = run(PRESET_TOOL, home)
    assert.equal(refused.status, 2, refused.stderr)
    assert.match(refused.stderr, /modified/)
    assert.deepEqual(filesInHome(home), before)

    // Model an unchanged older installation without editing repository source.
    const older = 'an earlier released preset\n'
    writeFileSync(path, older)
    const receipt = JSON.parse(readFileSync(ownershipOf(home), 'utf8'))
    receipt.presets.deepblend.files['preset.yml'] = createHash('sha256').update(older).digest('hex')
    writeFileSync(ownershipOf(home), JSON.stringify(receipt))
    const upgraded = run(PRESET_TOOL, home)
    assert.equal(upgraded.status, 0, upgraded.stderr)
    assert.deepEqual(readFileSync(path), published)
    assert.equal(run(PRESET_TOOL, home, '--check').status, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('preset uninstall refuses modified or unowned files without deleting the other preset', () => {
  for (const file of ['preset.yml', 'my-notes.md']) {
    const home = makeHome()
    try {
      assert.equal(run(PRESET_TOOL, home).status, 0)
      writeFileSync(join(presetRootOf(home), 'deepblend', file), 'user-owned content\n')
      const before = filesInHome(home)
      const result = run(PRESET_TOOL, home, '--uninstall')
      assert.equal(result.status, 2)
      assert.match(result.stderr, /NOT OURS/)
      assert.deepEqual(filesInHome(home), before)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

test('preset links, including nested links, are preserved and never followed for uninstall', () => {
  for (const nested of [false, true]) {
    const home = makeHome()
    try {
      assert.equal(run(PRESET_TOOL, home).status, 0)
      const outside = join(home, 'other-preset-files')
      mkdirSync(outside)
      writeFileSync(join(outside, 'keep.md'), 'must survive')
      const target = join(presetRootOf(home), 'deepblend')
      if (nested) symlinkSync(outside, join(target, 'external'))
      else { rmSync(target, { recursive: true }); symlinkSync(outside, target) }
      const before = filesInHome(home)
      const result = run(PRESET_TOOL, home, '--uninstall')
      assert.equal(result.status, 2)
      assert.match(result.stderr, /link/)
      assert.deepEqual(filesInHome(home), before)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }
})

test('an unchanged file recorded by an older preset receipt can be uninstalled safely', () => {
  const home = makeHome()
  try {
    assert.equal(run(PRESET_TOOL, home).status, 0)
    const bytes = 'owned by an older release\n'
    const receipt = JSON.parse(readFileSync(ownershipOf(home), 'utf8'))
    receipt.presets.deepblend.files['old-owned-file.md'] = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(ownershipOf(home), JSON.stringify(receipt))
    writeFileSync(join(presetRootOf(home), 'deepblend', 'old-owned-file.md'), bytes)
    const result = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(result.status, 0, result.stderr)
    assert.ok(!existsSync(join(presetRootOf(home), 'deepblend')))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('legacy native presets without a receipt are removable only when their files match the published source', () => {
  const home = makeHome()
  try {
    cpSync(join(ROOT, 'deepblend', 'presets'), presetRootOf(home), { recursive: true })
    assert.ok(!existsSync(ownershipOf(home)))
    const result = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(result.status, 0, result.stderr)
    for (const id of PRESETS) assert.ok(!existsSync(join(presetRootOf(home), id)))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('preset operations use the same lock as host installation', async () => {
  const home = makeHome()
  try {
    assert.equal(run(PRESET_TOOL, home).status, 0)
    await withInstallerLock(home, false, () => {
      const before = filesInHome(home)
      const result = run(PRESET_TOOL, home, '--uninstall')
      assert.equal(result.status, 2)
      assert.match(result.stderr, /Another installer is running/)
      assert.deepEqual(filesInHome(home), before)
    })
    assert.equal(run(PRESET_TOOL, home, '--uninstall').status, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the preset command restores an interrupted deletion before checking live profile references', () => {
  const home = makeHome()
  try {
    assert.equal(run(PLUGIN_TOOL, home).status, 0)
    assert.equal(run(PRESET_TOOL, home).status, 0)
    const before = filesInHome(home)
    const module = join(ROOT, 'deepblend', 'tools', 'installer-transaction.mjs')
    const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { applyInstallerPlan, snapshot, withInstallerLock } from ${JSON.stringify(`file://${module}`)};
      const home = process.argv[1];
      const path = home + '/.agent-presets/deepblend/preset.yml';
      await withInstallerLock(home, false, () => applyInstallerPlan(home, [
        { path, before: snapshot(path), after: { type: 'absent' } },
      ], { afterWrite() { process.kill(process.pid, 'SIGKILL') } }));
    `, home], { encoding: 'utf8' })
    assert.equal(interrupted.signal, 'SIGKILL')
    assert.ok(!existsSync(join(presetRootOf(home), 'deepblend', 'preset.yml')))
    const pending = filesInHome(home)
    assert.equal(run(PRESET_TOOL, home, '--check').status, 2)
    assert.deepEqual(filesInHome(home), pending, '--check must not recover or delete anything')
    const recovered = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(recovered.status, 2, 'a live bundle still requires the restored preset')
    assert.match(recovered.stdout, /recovered: restored/)
    assert.match(recovered.stderr, /still referenced/)
    assert.deepEqual(filesInHome(home), before)
    assert.equal(run(PLUGIN_TOOL, home, '--uninstall').status, 0)
    assert.equal(run(PRESET_TOOL, home, '--uninstall').status, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('real DSH two-profile lifecycle blocks preset removal while the other profile still composes DeepBlend', () => {
  const home = mkdtempSync(join(tmpdir(), 'deepblend-preset-lifecycle-'))
  try {
    const cli = join(resolveDshScope('dsh'), 'dsh', 'lib', 'bin.js')
    const dump = profile => spawnSync(process.execPath, [cli, '--profile', profile, '--dump-config'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, DSH_HOME: home },
    })
    assert.equal(dump('web').status, 0)
    cpSync(join(home, 'profiles', 'web'), join(home, 'profiles', 'second'), { recursive: true })
    assert.equal(run(PLUGIN_TOOL, home).status, 0)
    assert.equal(run(PLUGIN_TOOL, home, '--profile', 'second').status, 0)
    assert.equal(run(PRESET_TOOL, home).status, 0)
    assert.equal(run(PLUGIN_TOOL, home, '--uninstall').status, 0)
    const refused = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(refused.status, 2, refused.stderr)
    assert.match(refused.stderr, /second/)
    const composed = dump('second')
    assert.equal(composed.status, 0, composed.stderr)
    assert.match(composed.stdout, /id: deepblend-blender-host/)
    assert.match(composed.stdout, /id: deepblend-blender-preset/)
    assert.equal(run(PRESET_TOOL, home, '--check').status, 0)
    assert.equal(run(PLUGIN_TOOL, home, '--profile', 'second', '--uninstall').status, 0)
    const removed = run(PRESET_TOOL, home, '--uninstall')
    assert.equal(removed.status, 0, removed.stderr)
    const remaining = dump('second')
    assert.equal(remaining.status, 0, remaining.stderr)
    assert.doesNotMatch(remaining.stdout, /id: deepblend-blender-preset/)
  } finally { rmSync(home, { recursive: true, force: true }) }
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

for (const args of [['--help'], ['-h'], ['--help', '--uninstall'], ['--hepl'], ['--check', '--unknown']]) {
  test(`preset installer ${args.join(' ')} does not mutate an existing or absent DSH home`, () => {
    const home = makeHome(), absent = join(home, 'never-created')
    try {
      const before = filesInHome(home)
      for (const target of [home, absent]) {
        const result = run(PRESET_TOOL, target, ...args)
        const invalid = args.some(arg => ['--hepl', '--unknown'].includes(arg))
        assert.equal(result.status, invalid ? 2 : 0, result.stdout + result.stderr)
        assert.match(invalid ? result.stderr : result.stdout, invalid ? /Unknown preset installer argument/ : /Usage:/)
        assert.deepEqual(filesInHome(home), before)
        assert.equal(existsSync(absent), false)
        assert.equal(existsSync(presetRootOf(home)), false)
        assert.equal(existsSync(ownershipOf(home)), false)
      }
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
}
