#!/usr/bin/env node
/**
 * Bundle portability contract test.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until M5 the bundle patch carried five literal absolute paths:
 *
 *     blenderPath:         /Users/hxb/workspace/deep-blend/.tools/Blender.app/…
 *     bootstrapPath:       /Users/hxb/workspace/deep-blend/packages/…/bootstrap.py
 *     workspaceRoot:       /Users/hxb/workspace/deep-blend/.deepblend
 *     executableAllowlist: [/Users/hxb/workspace/deep-blend/.tools/…]
 *     projectsRoot:        /Users/hxb/workspace/deep-blend/.deepblend/projects
 *
 * They were not configuration. They were one developer's home directory, and no
 * amount of documentation makes another machine grow that directory. On any other
 * machine the product mounted, reported healthy, and failed at first render —
 * and `dsh --dump-config` looked correct throughout, because the values WERE what
 * the file said. `!!js` could not fix it: it is evaluated against the Loader
 * context, where `process` does not exist (M0 §4.2, verified).
 *
 * So the defaults moved into the packages, where they are ordinary Node code that
 * can read `DSH_HOME` and look at its own location. This file is what keeps them
 * there, because the failure mode of a regression is silent: a hardcoded path
 * works perfectly on the machine that has it.
 *
 * It asserts three things and nothing else:
 *
 *   1. no absolute path appears anywhere in the bundle patch — comments included,
 *      because a commented-out absolute path is how the next one gets pasted in;
 *   2. the rows that lost their path keys still mount and still resolve them,
 *      which `composition/activation.e2e.mjs` proves against a real Blender and a
 *      scratch `DSH_HOME`;
 *   3. the resolution rules are the documented ones, tested directly rather than
 *      through a mounted service, so a failure names the rule that broke.
 *
 * Run: node deepblend/tests/contract/bundle-portability.test.mjs
 *
 * Owner: DeepBlend Studio — M5 (portability)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEEPBLEND_STATE_DIRECTORY,
  expandHome,
  managedBlenderCandidates,
  resolveDefaultWorkspaceRoot,
  resolveDshHome,
  resolveProjectsRoot,
  resolveWorkspaceRoot,
} from '@deepblend/dsh-blender-contracts'
import { ROOT } from '../../tools/workspace-layout.mjs'

const BUNDLE_PATCH = join(ROOT, 'packages', 'deepblend', 'bundle', 'cordis.patch.yml')
const patchText = readFileSync(BUNDLE_PATCH, 'utf8')

/**
 * A path that names one machine rather than a convention.
 *
 * Deliberately narrow. `/Applications` and `/opt/homebrew/bin` are NOT flagged:
 * they are standard locations, the same on every Mac of that kind, and the
 * provider's built-in allowlist names them on purpose. What must never appear is
 * a HOME directory, a mounted volume, or a scratch mount — those exist on exactly
 * one machine, and a comment naming one is how the next real path gets pasted in.
 *
 * Two leading segments are required so the pattern cannot match the slashes in
 * prose like "and/or".
 */
const MACHINE_SPECIFIC_PATH = /\/(?:Users|home|Volumes|mnt|private|tmp)\/[\w./@-]+/g

test('the bundle patch names no absolute path, in a value or in a comment', () => {
  const found = [...patchText.matchAll(MACHINE_SPECIFIC_PATH)].map(match => match[0])
  assert.deepEqual(
    found,
    [],
    `packages/deepblend/bundle/cordis.patch.yml contains machine-specific paths: ${found.join(', ')}. ` +
      'A path here is one machine\'s home directory; move the default into the package that owns it ' +
      '(see the note above the first row) or set it in the operator layer.',
  )
})

test('no `!!js` expression is used to compute a value', async () => {
  // The bundle's header explains why at length; this is the assertion behind the
  // explanation. `!!js` is evaluated against the Loader context, so anything
  // reaching for `process` silently keeps its schema default instead of failing.
  const live = patchText
    .split('\n')
    .filter(line => line.includes('!!js') && !line.trimStart().startsWith('#'))
  assert.deepEqual(live, [], 'the bundle patch uses a live !!js expression; see the header for why that cannot work here')
})

test('the rows that carried paths no longer declare them', async () => {
  const { readBundleRows } = await import('../../tools/operator-layer.mjs')
  const rows = await readBundleRows(BUNDLE_PATCH)
  const byId = new Map(rows.map(row => [row.id, row]))

  for (const [id, keys] of [
    ['deepblend-blender-runtime', ['blenderPath', 'bootstrapPath', 'workspaceRoot']],
    ['deepblend-blender-host', ['workspaceRoot', 'projectsRoot']],
  ]) {
    const config = byId.get(id)?.config ?? {}
    for (const key of keys) {
      assert.ok(
        !(key in config),
        `${id} declares ${key}; unset is what makes the package default apply, and a value here is a value some machine lacks`,
      )
    }
  }

  // The portability fix must not have emptied the file: the policy configuration
  // — caps, timeouts, the reviewer route — is what makes this a product rather
  // than three bare rows, and it stays here.
  assert.ok(
    byId.get('deepblend-blender-runtime')?.config?.timeoutMs > 0,
    'the runtime row lost its timeout along with its paths',
  )
})

// ---------------------------------------------------------------------------
// The resolution rules themselves.
//
// Pure functions of `{ env, home }`, so every case below is a machine this test
// can describe without being on it.
// ---------------------------------------------------------------------------

test('an unset workspace root lands under DSH_HOME, per SPEC §17', () => {
  assert.equal(
    resolveDefaultWorkspaceRoot({ env: { DSH_HOME: '/srv/dsh' }, home: '/home/u' }),
    join('/srv/dsh', DEEPBLEND_STATE_DIRECTORY),
  )
  assert.equal(
    resolveDefaultWorkspaceRoot({ env: {}, home: '/home/u' }),
    join('/home/u', '.dsh', DEEPBLEND_STATE_DIRECTORY),
  )
  // An empty DSH_HOME is not a location, and must not resolve to `/deepblend`.
  assert.equal(resolveDshHome({ env: { DSH_HOME: '' }, home: '/home/u' }), join('/home/u', '.dsh'))
})

test('an unset projects root follows the workspace root, per SPEC §13', () => {
  const workspaceRoot = resolveWorkspaceRoot(undefined, { env: { DSH_HOME: '/srv/dsh' } })
  assert.equal(resolveProjectsRoot(undefined, workspaceRoot), join(workspaceRoot, 'projects'))
  // And an operator who overrides ONLY the workspace root gets a store that moved
  // with it. This is the property that a pair of independent defaults would lose.
  const moved = resolveWorkspaceRoot('/mnt/big', { env: { DSH_HOME: '/srv/dsh' } })
  assert.equal(resolveProjectsRoot(undefined, moved), join('/mnt/big', 'projects'))
})

test('a configured root wins, and a `~` is expanded the way SPEC §17 writes it', () => {
  assert.equal(resolveWorkspaceRoot('~/state', { home: '/home/u' }), '/home/u/state')
  assert.equal(resolveWorkspaceRoot('/mnt/big', { home: '/home/u' }), '/mnt/big')
  // Whitespace-only is what an operator layer produces when a key is present but
  // empty; treating it as "set" would put the store in the process's cwd.
  assert.equal(resolveWorkspaceRoot('   ', { env: {}, home: '/home/u' }), join('/home/u', '.dsh', DEEPBLEND_STATE_DIRECTORY))
  assert.equal(expandHome('not/absolute', '/home/u'), join(process.cwd(), 'not/absolute'))
})

test('the managed-install candidates are what tools/install-blender.mjs actually writes', async () => {
  const release = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'tools', 'blender-release.json'), 'utf8'))
  const [macos] = managedBlenderCandidates(['/repo'])

  // The candidate list and the installer must agree, or `blenderPath: 'auto'`
  // silently falls back to PATH and the deployment runs a Blender nobody pinned.
  assert.equal(macos, join('/repo', '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender'))
  assert.ok(
    release.image.includes(release.platform.replace('-', '-')),
    'the pinned release no longer describes a platform the candidate list covers',
  )
  assert.match(release.platform, /^macos-arm64$/, 'the candidate list below is macOS-shaped; a new platform needs a new entry')
})

test('the repository ships the step that produces the managed install, and it agrees on the name', async () => {
  const installer = readFileSync(join(ROOT, 'deepblend', 'tools', 'install-blender.mjs'), 'utf8')
  // The installer builds its destination from the same two constants rather than
  // repeating the literals; this asserts the agreement, which is the part a
  // rename would break.
  assert.ok(
    installer.includes('MANAGED_TOOLS_DIRECTORY'),
    'install-blender.mjs no longer names the managed tools directory by its shared constant',
  )
  assert.ok(
    installer.includes('MANAGED_BLENDER_RELATIVE_PATHS'),
    'install-blender.mjs no longer derives the binary path from the list the provider probes',
  )
})

// ---------------------------------------------------------------------------
// The operator layer, which is what actually relocates a deployment's storage.
// ---------------------------------------------------------------------------

test('the operator layer restates every bundle key, because a patch config replaces rather than merges', async () => {
  const { buildStoreOverride, readBundleRows } = await import('../../tools/operator-layer.mjs')
  const rows = await readBundleRows(BUNDLE_PATCH)
  const override = await buildStoreOverride({ storeRoot: '/srv/store', bundlePatch: BUNDLE_PATCH })

  assert.ok(override.length > 0, 'the override is empty, so every assertion below would pass vacuously')

  for (const entry of override) {
    const shipped = rows.find(row => row.id === entry.id)
    assert.ok(shipped !== undefined, `the override names a row the bundle does not declare: ${entry.id}`)

    // THE assertion behind D74/D77. A patch layer's `config` is REPLACED, not
    // merged, so a key the bundle sets and this override omits is a key the
    // deployment silently loses — a timeout of `undefined`, a view list gone.
    const missing = Object.keys(shipped.config ?? {}).filter(key => !(key in entry.config))
    assert.deepEqual(missing, [], `${entry.id}: the override drops bundle keys ${missing.join(', ')}`)
  }
})

test('the operator layer moves the roots and changes nothing else', async () => {
  const { buildStoreOverride, devStoreRoot, readBundleRows, STORE_ROOT_KEYS } = await import('../../tools/operator-layer.mjs')
  const rows = await readBundleRows(BUNDLE_PATCH)
  const storeRoot = join(ROOT, '.deepblend')
  const override = await buildStoreOverride({ storeRoot, bundlePatch: BUNDLE_PATCH })

  for (const entry of override) {
    const shipped = rows.find(row => row.id === entry.id)?.config ?? {}
    for (const [key, value] of Object.entries(entry.config)) {
      if (STORE_ROOT_KEYS[entry.id].includes(key)) {
        const expected = key === 'projectsRoot' ? join(storeRoot, 'projects') : storeRoot
        assert.equal(value, expected, `${entry.id}.${key} was not relocated`)
      } else {
        assert.deepEqual(value, shipped[key], `${entry.id}.${key} was changed by a tool whose job is to move two roots`)
      }
    }
  }

  // And the module the repository's tools resolve their store through agrees with
  // what the installer writes, or a project created by a tool is one the
  // workbench never lists.
  assert.equal(devStoreRoot(ROOT), storeRoot, 'devStoreRoot and this test disagree about where the dev store is')
})
