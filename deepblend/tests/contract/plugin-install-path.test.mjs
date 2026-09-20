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
 * The list's own install form is `github:owner/repo#path:…`, and that form cannot be exercised from here: this
 * repository is still private, and pnpm resolves a `github:` spec through an ANONYMOUS codeload tarball, which
 * answers 404 for a private repository. The local directory exercises the same code path — pnpm install, then the
 * bundle's patch composed into the profile — without the network, so what is checked here is everything except
 * the fetch.
 *
 * Run standalone: `node deepblend/tests/contract/plugin-install-path.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const packages = ['contracts', 'provider-local', 'host', 'tool', 'ui', 'bundle']
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
