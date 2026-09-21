/**
 * The ecosystem install path, end to end, in a throwaway profile.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else in this suite checks the plugin's pieces: the manifest's fields, the patch's rows, the
 * configuration each row carries. None of it runs the command a USER of the plugin list would run — `dsh plugin
 * add` — which is the one path where a missing `dsh.client`, a `files` list that omits the patch, or a row whose
 * configuration never reaches the profile would show up as a plugin that installs and does nothing.
 *
 * The listing's own question — "is this a meta-package?" — is answered here by measurement rather than by reading
 * the patch: the rows must appear in the composed profile WITH their configuration. MEASURED: they do.
 *
 * HOW IT STAYS SAFE
 * -----------------
 * `$DSH_HOME` decides where a profile lives, so this file builds a throwaway home and installs into that. The
 * real `~/.dsh` is never written, and the last case proves it by checking the real profile still names the
 * bundle it had before.
 *
 * WHY THE LOCAL PATH RATHER THAN GITHUB
 * -------------------------------------
 * Not because the `github:` form cannot be exercised — it can, and it was: `dsh plugin --profile web add
 * 'github:pearjelly/deep-blend#path:/packages/deepblend/bundle'` installs in 11.8 s on a scratch `$DSH_HOME`,
 * `Packages: +7`, and the profile it produces serves `/deepblend/capabilities` with HTTP 200. That measurement
 * lives in `docs/milestone-status.md` §197 and in `docs/probe-dsh-plugin-install.log`, because it needs the
 * network and this layer promises to need nothing but Node, git and a Python 3.
 *
 * The local directory exercises the same code path without the fetch — pnpm install, then the bundle's patch
 * composed into the profile — so what is checked here is everything except the download. This paragraph used to
 * say the `github:` form "cannot be exercised from here" because "this repository is still private": true when
 * it was written, false since 2026-09-21, and never the real reason. The reason was always the network.
 *
 * Run standalone: `node deepblend/tests/contract/plugin-install-path.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT } from '../../tools/workspace-layout.mjs'

const BUNDLE = join(ROOT, 'packages', 'deepblend', 'bundle')

/** A profile `dsh` can install into: the installer composes its rows into one. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'deepblend-install-path-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  writeFileSync(
    join(home, 'profiles', 'web', 'package.json'),
    `${JSON.stringify({ name: 'web', private: true, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  )
  return home
}

const runInstaller = (args, home) => spawnSync('node', [join(ROOT, 'deepblend', 'tools', 'install-plugin.mjs'), ...args], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 120_000,
})

const run = (args, home) => spawnSync('dsh', args, {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: home }, timeout: 120_000,
})

test('installing the bundle through the ecosystem command composes its rows WITH their configuration', () => {
  const home = makeHome()
  try {
    const install = run(['plugin', 'add', BUNDLE, '--profile', 'web'], home)
    assert.equal(install.status, 0,
      `dsh plugin add failed:\n${install.stdout}\n${install.stderr}`)

    // The profile now lists the bundle as one of its layers.
    const profile = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.deepEqual(profile.dsh.profile.bundles, ['@deepblend/dsh-blender-bundle'],
      'the bundle was not added to the profile’s bundle list')

    // And the composed configuration contains the three rows the patch inserts.
    const dump = run(['--profile', 'web', '--dump-config'], home)
    assert.equal(dump.status, 0, `dsh --dump-config failed:\n${dump.stdout}\n${dump.stderr}`)
    const composed = dump.stdout
    for (const row of ['deepblend-blender-runtime', 'deepblend-blender-host', 'deepblend-blender-ui']) {
      assert.ok(composed.includes(`id: ${row}`), `the composed profile has no ${row} row`)
    }

    // THE META-PACKAGE QUESTION, ANSWERED BY MEASUREMENT: a bundle whose rows arrive without configuration is a
    // dependency list; this one's rows must arrive carrying the values its patch declares.
    const runtime = composed.slice(composed.indexOf('id: deepblend-blender-runtime'))
    assert.match(runtime, /timeoutMs: 180000/,
      'the runtime row composed without its configuration, so the bundle would be a dependency list')
    assert.match(runtime, /maxSpillBytes: 67108864/, 'the runtime row lost part of its configuration')
    const host = composed.slice(composed.indexOf('id: deepblend-blender-host'))
    assert.match(host, /maxPreviewSamples: 512/, 'the host row composed without its configuration')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('and the real profile was never touched', () => {
  // The real home is the one this session runs from, so it must still name the bundle it had: this file only ever
  // wrote to temp homes, and a change here would mean something else did.
  const real = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'package.json')
  const profile = JSON.parse(readFileSync(real, 'utf8'))
  assert.ok((profile.dsh?.profile?.bundles ?? []).includes('@deepblend/dsh-blender-bundle'),
    'the real profile no longer composes the bundle — this test only writes to temp homes, so something else changed it')
})

// ---------------------------------------------------------------------------
// What importing this plugin DOES — the reviewer's "surprising install-time behaviour"
// ---------------------------------------------------------------------------
//
// The listing's reviewer checklist asks about "anything alarming in the source — obfuscated code, credential
// exfiltration, surprising install-time behaviour", and the last of those is a property a machine can check: a
// plugin that writes files, starts processes or opens sockets the moment it is imported is doing something the
// person installing it did not ask for. This plugin's packages must be inert on import — they publish services,
// register tools and export functions, and every one of those happens when the profile composes them, not when
// Node loads the module.
//
// MEASURED by running each import in a child process whose cwd and HOME are throwaway directories, then checking
// that nothing was written and no handle was opened. A weaker version — importing in this process and looking at
// `getActiveResourcesInfo` — reported zero for every package and would also have reported zero for a module that
// wrote a file, which is why the directories are compared instead.
test('importing every package of this plugin writes nothing and starts nothing', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'deepblend-import-'))
  const packages = ['contracts', 'provider-local', 'host', 'tool', 'ui', 'preset', 'bundle']
  const offenders = []
  try {
    for (const name of packages) {
      const cwd = join(scratch, name)
      mkdirSync(cwd, { recursive: true })
      // Imported by ABSOLUTE PATH: the child's cwd is the throwaway directory being watched, so a bare package
      // specifier would resolve against that directory's (empty) `node_modules` and fail — which is how the first
      // version of this reported six failed imports instead of six inert ones.
      const entry = pathToFileURL(join(ROOT, 'packages', 'deepblend', name, 'lib', 'index.js')).href
      const probe = spawnSync('node', ['--input-type=module', '-e', `
        import { readdirSync } from 'node:fs'
        const before = readdirSync('.')
        await import(${JSON.stringify(entry)})
        const after = readdirSync('.')
        const handles = process.getActiveResourcesInfo().filter(kind => kind !== 'TTYWrap')
        console.log(JSON.stringify({ before, after, handles }))
      `], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, DSH_HOME: cwd }, timeout: 60_000 })
      if (probe.status !== 0) {
        offenders.push(`${name}: the import failed — ${(probe.stderr ?? '').split('\n')[0]}`)
        continue
      }
      const result = JSON.parse(probe.stdout.trim().split('\n').pop())
      if (JSON.stringify(result.before) !== JSON.stringify(result.after)) {
        offenders.push(`${name}: wrote ${result.after.filter(entry => !result.before.includes(entry)).join(', ')} into its cwd`)
      }
      if (result.handles.length > 0) {
        offenders.push(`${name}: left ${result.handles.join(', ')} open (a process, a socket or a watcher)`)
      }
    }
    assert.deepEqual(offenders, [], 'importing these packages must do nothing observable')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Uninstalling: the command the manual gives must actually remove it
// ---------------------------------------------------------------------------
//
// `install.md` §6 is the operator's removal path, and it was incomplete in a way only running it shows: its first
// step (`plugin:install --portable`) EMPTIES the operator layer but leaves the bundle composed, so the plugin was
// still installed — and the ecosystem's own removal command could not finish the job either. MEASURED:
// `dsh plugin remove @deepblend/dsh-blender-bundle --profile web` failed with ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS,
// because `install-plugin.mjs` wrote `dsh.profile.bundles` (all the Loader needs) and no `dependencies` entry
// (which is what pnpm — and therefore `plugin remove` — reads).
//
// The installer writes both now, and this case runs the whole round trip: install, remove with the ecosystem's
// command, and the profile must no longer compose the bundle.
test('the ecosystem remove command uninstalls what this installer installed', () => {
  const home = makeHome()
  try {
    const install = runInstaller([], home)
    assert.equal(install.status, 0, `install-plugin failed:\n${install.stdout}${install.stderr}`)
    const profilePath = join(home, 'profiles', 'web', 'package.json')
    const installed = JSON.parse(readFileSync(profilePath, 'utf8'))
    assert.deepEqual(installed.dsh.profile.bundles, ['@deepblend/dsh-blender-bundle'])
    assert.equal(typeof installed.dependencies?.['@deepblend/dsh-blender-bundle'], 'string',
      'the installer wrote no dependency entry, so `dsh plugin remove` cannot remove the bundle')

    const remove = run(['plugin', 'remove', '@deepblend/dsh-blender-bundle', '--profile', 'web'], home)
    assert.equal(remove.status, 0,
      `dsh plugin remove failed, so the manual\u2019s removal path does not work:\n${remove.stdout}${remove.stderr}`)
    const removed = JSON.parse(readFileSync(profilePath, 'utf8'))
    assert.deepEqual(removed.dsh.profile.bundles, [],
      'the bundle is still composed after removal, so the plugin is still installed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The OPERATOR-layer path must compose too, not just write the right files
// ---------------------------------------------------------------------------
//
// There are two ways this plugin gets installed, and they produce different profile states: the ecosystem's
// `dsh plugin add` writes a `dependencies` entry and lets pnpm place the package, while `install-plugin.mjs` links
// the packages into `profiles/node_modules` itself and writes the bundle name into `dsh.profile.bundles`. What
// `plugin:check` verifies for the operator path is that the FILES are in sync — the links, the operator layer, the
// dependency entry — and files being right is not the same claim as the Loader being able to compose the rows.
//
// It composes because the Loader resolves a bundle name through Node's own resolution, which walks up from
// `profiles/<name>/` to `profiles/node_modules`. MEASURED against the real home: three rows, with their
// configuration. This case pins that for a throwaway home, so a change to where the installer links would fail
// here rather than at a user's first start.
test('the operator-layer install composes its rows in a real profile too', () => {
  const home = makeHome()
  try {
    const install = runInstaller([], home)
    assert.equal(install.status, 0, `install-plugin failed:\n${install.stdout}${install.stderr}`)
    const dump = run(['--profile', 'web', '--dump-config'], home)
    assert.equal(dump.status, 0, `dsh --dump-config failed:\n${dump.stdout}${dump.stderr}`)
    for (const row of ['deepblend-blender-runtime', 'deepblend-blender-host', 'deepblend-blender-ui']) {
      assert.ok(dump.stdout.includes(`id: ${row}`),
        `the operator-layer install composed no ${row} row, so the Loader could not resolve the bundle`)
    }
    const runtime = dump.stdout.slice(dump.stdout.indexOf('id: deepblend-blender-runtime'))
    assert.match(runtime, /timeoutMs: 180000/, 'the row composed without its configuration')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The npm route's precondition: every package is publishable AS IT STANDS
// ---------------------------------------------------------------------------
//
// The list accepts three install routes and this repository now measures two of them
// end to end (source, tarball). The third — from npm — is the one the list recommends,
// and it is blocked on an ACCOUNT rather than on code: this machine has no npm
// credentials (`npm whoami` → `ENEEDAUTH`) and no `@deepblend` scope. That claim is
// only worth writing down if "ready to publish" is checkable, so it is checked here.
//
// Three properties, and each one is a way a publish goes wrong silently:
//
//   1. `private: true` left in a manifest. npm refuses the publish outright, which is
//      the good case; the bad case is a package published under a name that then
//      cannot be unpublished.
//   2. A directory holding something the author did not mean to ship. There is no
//      `files` field on five of the seven packages — deliberately, and MEASURED as
//      unnecessary: each of those directories contains only `lib/` (plus `python/` for
//      the provider and `presets/` for the preset package) and its manifest, so
//      `npm pack --dry-run` produces exactly the intended set. But "no `files` field"
//      means a scratch file dropped into one of those directories ships to the
//      registry, and nothing would say so. This is the assertion that says so.
//   3. A `@deepseek-ai/*` package in `dependencies` rather than `peerDependencies`.
//      Those are the DSH deployment the plugin runs INSIDE; declaring one as a
//      dependency would make npm try to install the harness into itself, and the
//      version ranges carry prerelease branches precisely because the harness ships
//      release candidates.
test('every package under packages/deepblend is publishable as it stands', () => {
  const directory = join(ROOT, 'packages', 'deepblend')
  const packages = readdirSync(directory)
    .filter(name => existsSync(join(directory, name, 'package.json')))
    .sort()
  assert.ok(packages.length >= 6, `only ${packages.length} packages found; the listing entry installs at least six`)

  // What a package directory may hold, and the rule differs by whether the manifest
  // declares a `files` list:
  //
  //   WITH `files`     every top-level entry must be one it lists. `package.json` and a
  //                    README are packed regardless, so they are always allowed.
  //   WITHOUT `files`  npm packs everything, so only the directories a package is made of
  //                    are permitted. This is the case that matters: five of the seven
  //                    packages have no `files` list, deliberately — MEASURED as
  //                    unnecessary, because each holds only `lib/` (plus `python/` for the
  //                    provider and `presets/` for the preset package) and its manifest.
  //                    But a scratch file dropped into one of them would ship to the
  //                    registry with nothing to say so, and this is what says so.
  const ALWAYS_PACKED = new Set(['package.json', 'README.md', 'node_modules'])
  const DEFAULT_DIRECTORIES = new Set(['lib', 'python', 'presets'])

  for (const name of packages) {
    const manifest = JSON.parse(readFileSync(join(directory, name, 'package.json'), 'utf8'))
    assert.notEqual(manifest.private, true,
      `${manifest.name} still declares private: true, so npm would refuse to publish it`)
    assert.equal(typeof manifest.repository?.url, 'string',
      `${manifest.name} declares no repository url — the list harvests the npm mapping by checking that a package's repository points back at the listed repo`)

    const entries = readdirSync(join(directory, name)).filter(entry => !ALWAYS_PACKED.has(entry))
    const listed = manifest.files
    const stray = listed === undefined
      ? entries.filter(entry => !DEFAULT_DIRECTORIES.has(entry))
      : entries.filter(entry => !listed.includes(entry))
    assert.deepEqual(stray, [],
      listed === undefined
        ? `${manifest.name} holds ${stray.join(', ')} and declares no files list, so npm would publish it`
        : `${manifest.name} holds ${stray.join(', ')}, which its files list does not include`)

    const dshDependencies = Object.keys(manifest.dependencies ?? {}).filter(key => key.startsWith('@deepseek-ai/'))
    assert.deepEqual(dshDependencies, [],
      `${manifest.name} depends on ${dshDependencies.join(', ')}; the harness is provided by the deployment the plugin runs inside, so it belongs in peerDependencies`)
  }

  // And the two packages that DO carry a `files` list must still list what the plugin
  // needs at runtime: the bundle's patch is what makes an install compose anything, and
  // the preset package's `presets/` is the other half of "it installs".
  const bundle = JSON.parse(readFileSync(join(directory, 'bundle', 'package.json'), 'utf8'))
  assert.ok(bundle.files?.includes('cordis.patch.yml'),
    'the bundle no longer ships cordis.patch.yml, so an installed bundle would compose no rows')
  const preset = JSON.parse(readFileSync(join(directory, 'preset', 'package.json'), 'utf8'))
  assert.ok(preset.files?.includes('presets'),
    'the preset package no longer ships presets/, so the deployer row would deploy nothing')
})
