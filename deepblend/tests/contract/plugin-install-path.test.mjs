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

import { withoutPnpm } from '../lib/preconditions.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bundledPackages, shippedManifest, stagingManifest } from '../../tools/build-release-tarball.mjs'
import { alreadyPublished, npmError, npmManifest, publishOrder, publishRefusalFix } from '../../tools/publish-packages.mjs'
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

test('installing the bundle through the ecosystem command composes its rows WITH their configuration', { skip: withoutPnpm() }, () => {
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

test('and the real profile was never touched', { skip: withoutPnpm() }, () => {
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
test('the ecosystem remove command uninstalls what this installer installed', { skip: withoutPnpm() }, () => {
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

// ---------------------------------------------------------------------------
// The npm route's PROCEDURE: two traps that are silent when they are wrong
// ---------------------------------------------------------------------------
//
// `tools/publish-packages.mjs` is the one command that completes the npm route once an
// operator has an account. Its two design constraints were both found by running
// `npm publish --dry-run` against this repository, and both fail in a way that points
// somewhere other than the cause:
//
//   1. THE CONFIGURED REGISTRY IS A MIRROR. `npm config get registry` on this machine
//      answers `https://mirrors.cloud.tencent.com/npm/`, which proxies reads and does not
//      accept publishes. A publish sent there fails with a status that reads like a
//      permissions problem, so the reader checks their token instead of their registry.
//      The tool names the public registry on every command; this asserts it does, and that
//      the reason is written down where the next person will read it.
//
//   2. THE ORDER IS NOT ALPHABETICAL, and npm resolves nothing. `contracts` is imported by
//      four of the others and `bundle` depends on all six, so a `bundle` published first is
//      a package whose install 404s — and the publish itself SUCCEEDS. The order is derived
//      from the manifests' own `dependencies` rather than typed, and this case checks the
//      derivation against the manifests instead of against a copy of the answer.
test('the publish procedure names the public registry and orders dependencies first', () => {
  const tool = readFileSync(join(ROOT, 'deepblend', 'tools', 'publish-packages.mjs'), 'utf8')

  // The registry is the public one, and it is passed on the command line rather than left to
  // `npm config`. Both halves matter: naming it in a comment would not change where npm sends
  // the request.
  assert.ok(tool.includes("const REGISTRY = 'https://registry.npmjs.org/'"),
    'publish-packages.mjs no longer pins the public registry, so a publish would go to whatever npm config says')
  assert.match(tool, /'--registry', REGISTRY|--registry.*REGISTRY/,
    'publish-packages.mjs defines the registry but does not pass it to npm')
  assert.ok(tool.includes('mirrors.cloud.tencent.com'),
    'the mirror is no longer named in the tool, so the next reader has to rediscover why the registry is pinned')

  // And the order, checked as a PROPERTY rather than against a literal list: for every
  // package, every dependency of it that lives in this repository must appear earlier.
  const order = publishOrder()
  const position = new Map(order.map((entry, index) => [entry.name, index]))
  const local = new Set(order.map(entry => entry.name))
  assert.equal(order.length, local.size, 'publishOrder returned a package twice')

  const violations = []
  for (const entry of order) {
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      if (!local.has(dependency)) continue
      if (position.get(dependency) > position.get(entry.name)) {
        violations.push(`${dependency} must precede ${entry.name}`)
      }
    }
  }
  assert.deepEqual(violations, [], 'the publish order puts a package before something it depends on')
  // The two ends, stated because they are the ones a hand-written list gets wrong: the shared
  // contracts package first, and the bundle — which depends on all six — last.
  assert.equal(order[0].name, '@deepblend/dsh-blender-contracts', 'the shared contracts package is not published first')
  assert.equal(order[order.length - 1].name, '@deepblend/dsh-blender-bundle', 'the bundle is not published last')
})

// ---------------------------------------------------------------------------
// What the npm route PUBLISHES is not what the repository CONTAINS
// ---------------------------------------------------------------------------
//
// `ebb11ac` changed every sibling dependency from an exact `0.1.0` to a self-referential
// `github:pearjelly/deep-blend#path:…` spec, and for the SOURCE route that was the whole
// fix: a remote install fetches the bundle and then resolves its dependencies, and `0.1.0`
// resolved to nothing because none of the six was published. MEASURED, that route works.
//
// The same spec makes the npm route something other than what the plugin list recommends it
// for. `dsh plugin add @deepblend/dsh-blender-bundle` would take the artifact from the
// registry and then send pnpm back to GIT for all six siblings — a registry install in name
// only, and not the second-long path the listing entry describes. Nothing in the repository
// would be wrong: the manifest is CORRECT for a different route than the one being measured.
//
// So `tools/publish-packages.mjs` rewrites the specs at publish time, into a staged copy —
// the repository keeps the `github:` form, and the tarball builder rewrites it again for
// route 3, where the siblings are bundled instead of fetched. This case asserts the
// invariant that makes the npm route what it claims: NOTHING PUBLISHED FROM THIS REPOSITORY
// MAY CARRY A GIT SPEC.
test('the manifests this repository publishes carry no git spec', () => {
  const order = publishOrder()
  const byName = new Map(order.map(entry => [entry.name, entry]))
  assert.ok(order.length >= 6, `only ${order.length} packages would be published; the entry installs at least six`)

  const surviving = []
  let rewrites = 0
  for (const entry of order) {
    const { manifest, rewritten } = npmManifest(entry, byName)
    rewrites += rewritten.length
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec.startsWith('github:')) surviving.push(`${entry.name} -> ${name}: ${spec}`)
      // And every local dependency is published BY THIS RUN, at a version that exists. A
      // rewrite to a version nobody is publishing is the same 404 with none of the
      // diagnostics, which is the failure this whole case is about.
      if (name.startsWith('@deepblend/')) {
        assert.ok(byName.has(name), `${entry.name} depends on ${name}, which this run does not publish`)
        assert.equal(spec, byName.get(name).version,
          `${entry.name} would be published depending on ${name}@${spec}, but this run publishes ${byName.get(name).version}`)
      }
    }
  }
  assert.deepEqual(surviving, [], 'a published manifest still resolves a sibling from git, so the npm route is not a registry install')
  // EXACT, not a floor: every local `github:` spec the repository's manifests carry must be
  // rewritten, and the rewrite must invent none. A floor would pass on a tree where one
  // package's spec had been missed and another's double-counted, and the number this file's
  // own milestone record quotes would stop meaning anything.
  const inRepository = order.reduce((total, entry) => total
    + Object.values(entry.manifest.dependencies ?? {}).filter(spec => spec.startsWith('github:')).length, 0)
  assert.equal(rewrites, inRepository,
    `the repository's manifests carry ${inRepository} git spec(s) and the publish rewrite touched ${rewrites}`)
  const carriers = order.filter(entry => Object.values(entry.manifest.dependencies ?? {}).some(spec => spec.startsWith('github:'))).length
  assert.ok(inRepository >= 6 && carriers >= 5,
    `the rewrite has almost nothing to do (${inRepository} spec(s) across ${carriers} package(s)), so this case may be passing vacuously`)

  // And the repository's own manifests keep the git form, because route 1 needs it. Both
  // halves asserted, because "rewrite everything to versions" would break the source route
  // just as silently as the reverse breaks this one.
  const bundle = JSON.parse(readFileSync(join(ROOT, 'packages', 'deepblend', 'bundle', 'package.json'), 'utf8'))
  const gitSpecs = Object.values(bundle.dependencies ?? {}).filter(spec => spec.startsWith('github:'))
  assert.equal(gitSpecs.length, 6,
    'the repository bundle manifest no longer carries six git specs, so a source install would resolve unpublished versions')
})

// ---------------------------------------------------------------------------
// The tarball route's shipped manifest: the same invariant, for the same reason
// ---------------------------------------------------------------------------
//
// Route 3 rewrites the dependency specs too, and for the same reason as route 2 — but its
// rewrite is the more extreme one: the six siblings are not fetched from anywhere at all,
// they are VENDORED into the artifact's own `node_modules`. A `github:` spec left in the
// shipped manifest would therefore not even be a slow install; it would be a network
// round-trip for packages that are already inside the tarball.
//
// This property was checked only at BUILD time until this case existed, and a build needs
// the network — so it was a step an operator ran, not a case that runs on every push. The
// same is true of the `bundledDependencies` list, which is the thing that makes pnpm use
// the vendored copies instead of resolving the specs at all.
test('the tarball this repository releases carries no git spec either', () => {
  const bundle = JSON.parse(readFileSync(join(ROOT, 'packages', 'deepblend', 'bundle', 'package.json'), 'utf8'))
  const packages = bundledPackages()
  assert.ok(packages.length >= 6, `only ${packages.length} packages would be bundled into the artifact`)

  const shipped = shippedManifest(bundle, packages)

  // No git spec survives, and every sibling the bundle depends on is declared at exactly the
  // version being bundled — not a range, and not the commit-pinned spec the BUILD manifest
  // needs in order to fetch them in the first place.
  const gitSpecs = Object.entries(shipped.dependencies).filter(([, spec]) => spec.startsWith('github:'))
  assert.deepEqual(gitSpecs, [], 'the released artifact would still resolve a sibling from git, though it carries that sibling inside itself')

  const versions = new Map(packages.map(entry => [entry.name, entry.version]))
  const mismatched = Object.entries(shipped.dependencies)
    .filter(([name, spec]) => versions.has(name) && spec !== versions.get(name))
    .map(([name, spec]) => `${name}: declared ${spec}, bundled ${versions.get(name)}`)
  assert.deepEqual(mismatched, [], 'the released artifact declares a version other than the one it carries')
  assert.equal(Object.keys(shipped.dependencies).length, packages.length,
    'the released artifact does not declare every package it bundles')

  // The other half, and the one that makes the vendored copies be USED: pnpm consults
  // `bundledDependencies` and skips resolution entirely — MEASURED, it does so even when a
  // bundled dependency's spec names a version that exists nowhere. Without this list the
  // artifact would carry six packages and then go to the network for all six.
  const pinned = stagingManifest(bundle, packages, 'a'.repeat(40))
  const bundled = new Set(pinned.bundledDependencies ?? [])
  const notBundled = packages.map(entry => entry.name).filter(name => !bundled.has(name))
  assert.deepEqual(notBundled, [], 'the artifact would carry packages it does not declare as bundled, so pnpm would fetch them instead')
})

// ---------------------------------------------------------------------------
// Reporting a publish failure, which the first version got wrong in production
// ---------------------------------------------------------------------------
//
// A real `npm run publish:packages` failed and the tool printed:
//
//     @deepblend/dsh-blender-contracts@0.1.0 — FAILED: npm error A complete log of this
//     run can be found in: /Users/hxb/.npm/_logs/….log
//
// `npm publish` prints a paragraph whose LAST line is always that log path, and the tool
// took the last line. A genuine 403 was therefore reported as a filename, and the reader was
// sent to a log to find what npm had already said on the line above it. The refusal itself
// was `Two-factor authentication or granular access token with bypass 2fa enabled is required
// to publish packages` — an operator's problem with a one-line fix, presented as a path.
//
// The exact output of that run is the fixture below, because a hand-written one would have
// been written by whoever wrote the parser and would agree with it by construction.
test('a publish failure is reported as the cause, not as npm\'s log path', () => {
  const realFailure = [
    'npm notice',
    'npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access',
    'npm error code E403',
    'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@deepblend%2fdsh-blender-contracts - '
      + 'Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.',
    'npm error 403 In most cases, you or one of your dependencies are requesting',
    'npm error 403 a package version that is forbidden by your security policy, or',
    'npm error 403 on a server you do not have access to.',
    'npm error A complete log of this run can be found in: /Users/hxb/.npm/_logs/x.log',
  ].join('\n')

  const reported = npmError(realFailure)
  assert.match(reported, /Two-factor authentication/,
    `the failure was reported as "${reported}", which does not name the cause`)
  assert.ok(!/A complete log of this run/.test(reported), 'the log path was reported as the error again')
  assert.ok(!/^npm notice/.test(reported), 'a notice line was reported as the error')

  // And the refusal is recognised, so the fix is printed rather than "FAILED: 403".
  const withAuthenticator = publishRefusalFix(realFailure, true)
  assert.ok(withAuthenticator !== null, 'the 2FA refusal was not recognised, so the operator gets no fix')
  assert.match(withAuthenticator, /--otp/, 'the fix does not mention the one-time code an authenticator can produce')
  assert.match(withAuthenticator, /Bypass 2FA/, 'the fix does not mention the token that does not expire mid-run')

  // THE ADVICE DEPENDS ON THE ACCOUNT, and this is the half that was measured on a real one:
  // publishing was refused for want of 2FA while `npm profile get` answered `tfa: false`. On
  // that account `--otp` CANNOT work — there is no authenticator to produce a code — so
  // offering it sends the reader to a settings page with nothing to change on it.
  const withoutAuthenticator = publishRefusalFix(realFailure, false)
  // Not "must not mention --otp": naming it in order to say it CANNOT help is the useful
  // thing to do, because it is the fix everybody reaches for first. What must not happen is
  // offering it as a route that works.
  assert.match(withoutAuthenticator, /`--otp` cannot help/,
    'the fix does not say why the one-time code is not the answer on this account')
  assert.match(withoutAuthenticator, /Bypass 2FA/, 'the only route that works on that account is not named')
  assert.match(withoutAuthenticator, /no authenticator|NO authenticator/i,
    'the fix does not say why the one-time code was withheld')

  // With the state unknown both routes are offered, because guessing wrong is worse than
  // naming two.
  const unknown = publishRefusalFix(realFailure)
  assert.match(unknown, /--otp/, 'with the account state unknown, the one-time code was withheld')
  assert.match(unknown, /Bypass 2FA/, 'with the account state unknown, the token route was withheld')

  // The other refusals this tool knows, and one it must NOT claim to know: a fix invented for
  // an unrecognised failure would send the reader somewhere wrong.
  // The scope refusal, and the assertion that matters most about it: the first version of
  // this message told the reader to run `npm org create`, WHICH IS NOT A COMMAND — `npm org`
  // only manages orgs that already exist. An invented command costs a round trip and teaches
  // the reader the tool is guessing, so the case now asserts the real route (the website) and
  // that no `npm org create` is suggested again.
  const scopeFix = publishRefusalFix('npm error code E404\nnpm error 404 Not Found - PUT https://registry.npmjs.org/@deepblend%2fdsh-blender-contracts - Not found')
  assert.match(scopeFix, /npmjs\.com\/org\/create/, 'the scope refusal does not name where an org is actually created')
  assert.ok(!/npm org create/.test(scopeFix), 'the scope refusal suggests `npm org create` again, which is not a command')
  assert.match(scopeFix, /token in ~\/\.npmrc is not allowed to publish/,
    'the other cause of a 404 on a scoped PUT — a token without publish access to the scope — is not named')
  // The ordering trap, asserted because it is the one that costs a round trip: a granular
  // token's allowlist is fixed at creation, so creating the org afterwards is not enough.
  assert.match(scopeFix, /EDIT OR REGENERATE IT AFTER the org exists/,
    'the fix does not warn that a token created before the org cannot be given it afterwards')
  assert.equal(publishRefusalFix('npm error code E500\nnpm error Internal server error'), null,
    'a failure this tool does not recognise was given an invented fix')
})

// ---------------------------------------------------------------------------
// Re-running the publish, which the first version made impossible
// ---------------------------------------------------------------------------
//
// A published version is immutable, so a re-run gets "You cannot publish over the
// previously published versions" for every package that went up the first time. The first
// version of the loop treated that as a FAILURE and stopped — which made a partial publish
// unrecoverable: a run interrupted after three of seven packages could never be finished,
// because the fourth run would stop on the first package, which is already there.
//
// MEASURED on the real publish, not imagined: the second run answered exactly that and
// stopped at `contracts`, leaving the six already done indistinguishable from the six not.
test('a version that is already on the registry is a skip, not a failure', () => {
  const realAnswer = 'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/'
    + '@deepblend%2fdsh-blender-contracts - You cannot publish over the previously published versions: 0.1.0.'
  assert.equal(alreadyPublished(realAnswer), true,
    'a re-run would stop at the first package that is already published, so a partial publish could never be completed')

  // And it is not confused with the refusals that ARE the operator's to fix — those must
  // still stop the run and print their fix.
  assert.equal(alreadyPublished('npm error 403 403 Forbidden - PUT … - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.'), false,
    'a 2FA refusal was mistaken for an already-published version, so the run would skip it and claim success')
  assert.equal(alreadyPublished('npm error 404 Not Found - PUT … - Not found'), false,
    'a 404 was mistaken for an already-published version')
})
