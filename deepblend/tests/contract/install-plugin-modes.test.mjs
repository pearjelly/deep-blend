#!/usr/bin/env node
/**
 * The profile installer's modes, tested against a real scratch DSH home.
 *
 * WHY THIS EXISTS
 * ---------------
 * `install-plugin.mjs` now decides something that is invisible afterwards: WHERE
 * a deployment keeps its projects. Since M5 the bundle names no path, so an
 * unconfigured deployment stores under `<DSH_HOME>/deepblend` — right for an
 * installation, wrong for a checkout, where every tool in this repository works on
 * `<repo>/.deepblend`. The installer reconciles the two by writing an operator
 * layer, and it has three behaviours that matter and that nothing else exercises:
 *
 *   1. **install** — pin storage to the checkout, and register the bundle;
 *   2. **--portable** — leave the product default, by EMPTYING the operator layer
 *      rather than deleting it: `cordis.patch.yml` is a file `dsh` creates as part
 *      of every profile, and "the installer removed one of my profile's files" is
 *      not a state a user should have to reason about;
 *   3. **refuse** — an operator layer somebody else wrote is left byte-for-byte
 *      alone and the run exits non-zero. "The installer replaced my config" is
 *      also not something a user can diagnose from the result.
 *
 * Behaviour 3 is the one most likely to be "fixed" into compliance by a later
 * change, and behaviour 2's difference from deletion is invisible in a diff of the
 * tool. So they are asserted here, against a temporary home that no developer
 * depends on — the installer writes into `$DSH_HOME`, which is exactly why this
 * cannot be checked by running it on the real one.
 *
 * Run: node deepblend/tests/contract/install-plugin-modes.test.mjs
 *
 * Owner: DeepBlend Studio — M5 (portability)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'
import { devStoreRoot, renderOperatorLayer } from '../../tools/operator-layer.mjs'

const INSTALLER = join(ROOT, 'deepblend', 'tools', 'install-plugin.mjs')

/** A profile that looks like one `dsh` created, minus anything DeepBlend added. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'deepblend-install-plugin-'))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '# Your patch layer for this dsh profile.\n[]\n')
  return home
}

/** Run the installer with `DSH_HOME` pointed at a scratch home. */
function runInstaller(home, ...args) {
  const result = spawnSync('node', [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

const manifestOf = home => JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
const operatorLayerOf = home => readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')

/** The patch entries in an operator layer, ignoring its comment header. */
function entriesOf(text) {
  const body = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim()
  return body.length === 0 ? [] : JSON.parse(body)
}

test('installing registers the bundle and pins storage to the checkout', () => {
  const home = makeHome()
  try {
    const first = runInstaller(home)
    assert.equal(first.status, 0, first.stderr)

    assert.deepEqual(
      manifestOf(home).dsh.profile.bundles[0],
      '@deepblend/dsh-blender-bundle',
      'the bundle must be FIRST, so a deployment bundle can still override its rows',
    )

    const entries = entriesOf(operatorLayerOf(home))
    const roots = Object.fromEntries(entries.flatMap(entry => Object.entries(entry.config ?? {})))
    assert.equal(roots.workspaceRoot, devStoreRoot(ROOT), 'storage was not pinned to the checkout')
    assert.equal(roots.projectsRoot, join(devStoreRoot(ROOT), 'projects'))

    // Idempotent: a second run changes nothing, and --check agrees.
    const second = runInstaller(home)
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stdout, /already installed; nothing changed/)
    assert.equal(runInstaller(home, '--check').status, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--portable empties the operator layer instead of deleting a profile file', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)
    assert.ok(entriesOf(operatorLayerOf(home)).length > 0)

    const portable = runInstaller(home, '--portable')
    assert.equal(portable.status, 0, portable.stderr)

    // The FILE, not the entries: `dsh` creates cordis.patch.yml with every
    // profile, and an installer that removes it is doing something the user
    // cannot see and did not ask for.
    assert.ok(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml')), 'the profile file was deleted')
    assert.deepEqual(entriesOf(operatorLayerOf(home)), [], 'the layer still pins a store --portable did not ask for')

    // And it is a no-op the second time rather than drift.
    assert.equal(runInstaller(home, '--portable', '--check').status, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an operator layer written by somebody else is refused, never overwritten', () => {
  const home = makeHome()
  try {
    const foreign = '# my own layer\n- id: someone-elses-row\n  config:\n    x: 1\n'
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), foreign)

    const refused = runInstaller(home)
    assert.equal(refused.status, 2, `expected refusal, got ${refused.status}: ${refused.stdout}${refused.stderr}`)
    assert.equal(operatorLayerOf(home), foreign, 'a foreign operator layer was modified')
    assert.match(refused.stderr, /Merge the layers by hand/)

    // And --check must not report the workspace healthy while the storage it was
    // asked about is not pinned at all — that would be a green line describing
    // the opposite of what just happened.
    assert.equal(runInstaller(home, '--check').status, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--check reports drift when the bundle changes under an installed deployment', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)

    // Simulate the bundle gaining a key: the generated layer no longer restates
    // everything, which is the failure mode that would otherwise be silent (a
    // deployment quietly keeping an old snapshot of the configuration).
    const stale = entriesOf(operatorLayerOf(home))
    delete stale[0].config.timeoutMs
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), renderOperatorLayer(stale, devStoreRoot(ROOT)))

    const checked = runInstaller(home, '--check')
    assert.equal(checked.status, 1, `expected drift, got ${checked.status}: ${checked.stdout}`)
    assert.match(checked.stdout, /DRIFTED/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/**
 * The non-macOS install path, which is a USER's key in a file this tool generates.
 *
 * `install.md` §0 tells a Linux or Windows user to install Blender themselves and set `blenderPath`
 * on the `deepblend-blender-runtime` row of the operator layer. That file is generated here, and it
 * used to be REGENERATED from the bundle patch on the next run — which dropped the key. MEASURED:
 * `installed (1 change(s))` and `grep -c blenderPath` went to 0, so the documented way to make the
 * product work on any other platform was destroyed by the next `plugin:install`, and `--check`
 * called the correct configuration drift.
 *
 * The rule the assertions below hold: this tool owns the keys it DERIVES, and everything else in
 * the file is the user's.
 */
test('a setting the user adds to a row this tool owns survives a re-install, and the run says so', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)

    const rows = entriesOf(operatorLayerOf(home))
    rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = '/opt/blender/blender'
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), renderOperatorLayer(rows, devStoreRoot(ROOT)))

    const again = runInstaller(home)
    assert.equal(again.status, 0, again.stderr)
    const after = entriesOf(operatorLayerOf(home)).find(row => row.id === 'deepblend-blender-runtime')
    assert.equal(after.config.blenderPath, '/opt/blender/blender', 'the documented non-macOS setting was dropped')
    // NOT SILENTLY: the failure this replaced was exactly a silent one, so the line has to exist.
    assert.match(again.stdout, /kept your own setting\(s\): deepblend-blender-runtime\.blenderPath/)

    // And the tool's own keys are still the tool's: the store pin is intact.
    assert.equal(after.config.workspaceRoot, devStoreRoot(ROOT))

    // A difference that is only the user's is NOT drift. Calling it drift is what made a correct
    // configuration look wrong, which is how a user ends up "fixing" it back to broken.
    assert.equal(runInstaller(home, '--check').status, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a key this tool DERIVES is still drift when the user changes it', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)
    const rows = entriesOf(operatorLayerOf(home))
    rows.find(row => row.id === 'deepblend-blender-host').config.workspaceRoot = '/somewhere/else'
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), renderOperatorLayer(rows, devStoreRoot(ROOT)))

    // Ownership has to cut both ways, or "the user's keys are preserved" becomes "the tool can no
    // longer tell whether its own pinning is in place".
    const checked = runInstaller(home, '--check')
    assert.equal(checked.status, 1, `expected drift, got ${checked.status}: ${checked.stdout}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a whole row the user adds is preserved too', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)
    const rows = entriesOf(operatorLayerOf(home))
    rows.push({ id: 'their-own-row', config: { something: true } })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), renderOperatorLayer(rows, devStoreRoot(ROOT)))

    assert.equal(runInstaller(home).status, 0)
    assert.deepEqual(
      entriesOf(operatorLayerOf(home)).find(row => row.id === 'their-own-row'),
      { id: 'their-own-row', config: { something: true } },
      'a row this tool does not define was dropped',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--portable refuses rather than emptying a layer that holds the user\'s settings', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)
    const rows = entriesOf(operatorLayerOf(home))
    rows.find(row => row.id === 'deepblend-blender-runtime').config.blenderPath = '/opt/blender/blender'
    const withUserKey = renderOperatorLayer(rows, devStoreRoot(ROOT))
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), withUserKey)

    // A patch entry's `config` REPLACES the bundle's wholesale (D74), so these keys cannot be moved
    // into an empty layer without dropping the row's other settings. Refusing and naming them is the
    // only answer that neither lies nor breaks the row.
    const portable = runInstaller(home, '--portable')
    assert.equal(portable.status, 2, `expected refusal, got ${portable.status}: ${portable.stdout}`)
    assert.equal(operatorLayerOf(home), withUserKey, 'the layer was emptied despite holding a user setting')
    assert.match(portable.stderr, /deepblend-blender-runtime\.blenderPath/)
    // The tool's OWN keys are not what it is refusing about: the message must not blame them.
    assert.doesNotMatch(portable.stderr, /workspaceRoot|projectsRoot/)

    // With nothing of the user's in it, --portable still does what it always did.
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), renderOperatorLayer(entriesOf(operatorLayerOf(home)).map(row => {
      const { blenderPath, ...rest } = row.config ?? {}
      return { ...row, config: rest }
    }), devStoreRoot(ROOT)))
    assert.equal(runInstaller(home, '--portable').status, 0)
    assert.deepEqual(entriesOf(operatorLayerOf(home)), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the installed package links point at this repository', () => {
  const home = makeHome()
  try {
    assert.equal(runInstaller(home).status, 0)
    // Without these the Loader cannot resolve a row's `name` at all, which is the
    // failure that shows up as a route that never appears.
    const bundleLink = join(home, 'profiles', 'node_modules', '@deepblend', 'dsh-blender-bundle')
    assert.ok(existsSync(join(bundleLink, 'cordis.patch.yml')), `no bundle reachable at ${bundleLink}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
