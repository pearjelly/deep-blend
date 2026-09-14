#!/usr/bin/env node
/**
 * Install DeepBlend's Host Bundle into a DSH profile.
 *
 * WHY THIS EXISTS
 * ---------------
 * `link-workspace.mjs` closes the half of the gap that is about the repository's
 * own tests. This closes the half that is about the PRODUCT: for a running `dsh`
 * to compose the DeepBlend rows at all, two things have to be true of the profile
 * and neither of them was ever a step:
 *
 *   1. `$DSH_HOME/profiles/node_modules/@deepblend/*` must link to this
 *      repository's packages. The Loader resolves a row's `name` with a bare
 *      `import()`, from inside the DSH installation; that directory is on the
 *      resolution chain and is writable (`runtime-audit.md` §5.2).
 *   2. The profile's `package.json` must list `@deepblend/dsh-blender-bundle`
 *      under `dsh.profile.bundles`, or the bundle's patch file is never read.
 *
 * Both used to live only in prose — `README.md` §5 and `runtime-audit.md` §5.4
 * describe them as "the manual equivalent of `dsh plugin --profile add`, because
 * this machine has no pnpm". On 2026-09-14 the profile was reinstalled and both
 * were gone, and the cost was not theoretical:
 *
 *     $ node deepblend/tests/e2e/ui.e2e.mjs
 *     [FAIL] the suite completed without an unexpected throw
 *            — Error: dsh web never served /deepblend/capabilities on port 65377
 *
 * The M4 browser suite starts its own isolated `dsh web` and links the real
 * profile's `node_modules` into it, so a bundle the profile cannot resolve makes
 * the workbench never appear — with no message anywhere saying why. Diagnosing
 * that from the failure takes far longer than running this command.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   $DSH_HOME/profiles/node_modules/@deepblend/<pkg>   ->  packages/deepblend/<dir>
 *   $DSH_HOME/profiles/<profile>/package.json          (adds ONE entry to
 *                                                       dsh.profile.bundles)
 *
 * It does NOT touch the DSH installation, the shipped agent presets, or
 * `cordis.patch.yml`. An operator layer that overrides bundle config is the
 * operator's file, and `deepblend/tools/dsh-web-harness.mjs` writes a temporary
 * one for its own runs.
 *
 * Usage:
 *   node deepblend/tools/install-plugin.mjs                   # install into the `web` profile
 *   node deepblend/tools/install-plugin.mjs --profile <name>
 *   node deepblend/tools/install-plugin.mjs --check           # report drift, change nothing
 *
 * Exit codes: 0 = installed and in sync, 1 = drift (with --check), 2 = nothing to
 *             install into.
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { linkTarget, localPackages } from './workspace-layout.mjs'

/** The npm scope DeepBlend's own packages live under. */
const LOCAL_SCOPE = '@deepblend'

/** The bundle whose patch composes the three DeepBlend host rows. */
const BUNDLE_PACKAGE = '@deepblend/dsh-blender-bundle'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const checkOnly = process.argv.includes('--check')

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/**
 * The profile to install into. `--profile <name>` overrides the default because a
 * deployment may run several, and installing into the wrong one is silent: the
 * rows simply never compose and nothing reports a mistake.
 * @returns {string}
 */
function requestedProfile() {
  const index = process.argv.indexOf('--profile')
  if (index === -1) return 'web'
  const name = process.argv[index + 1]
  if (name === undefined || name.startsWith('--')) {
    console.error('--profile needs a name, e.g. --profile web')
    process.exit(2)
  }
  return name
}

/** Directory names under `$DSH_HOME/profiles`, excluding the shared node_modules. */
function existingProfiles() {
  const root = join(DSH_HOME, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter(name => name !== 'node_modules' && statSync(join(root, name)).isDirectory())
    .sort()
}

const profile = requestedProfile()
const profileDirectory = join(DSH_HOME, 'profiles', profile)

if (!existsSync(profileDirectory)) {
  console.error(`no profile at ${profileDirectory}`)
  console.error(`known profiles: ${existingProfiles().join(', ') || '(none)'}`)
  process.exit(2)
}

const local = localPackages()
if (local.size === 0) {
  console.error('no local packages found under packages/deepblend')
  process.exit(2)
}

let drift = 0

// ---------------------------------------------------------------------------
// 1. The package links.
//
// Absolute, like every other link in this project: the Loader reaches these
// through the profile, the M4 harness reaches them through ITS home's link to
// this same directory, and a relative target would resolve differently in each.
// ---------------------------------------------------------------------------
const scopeDirectory = join(DSH_HOME, 'profiles', 'node_modules', LOCAL_SCOPE)

for (const [name, directory] of [...local].sort()) {
  const bare = name.split('/')[1]
  const linkPath = join(scopeDirectory, bare)
  const current = linkTarget(linkPath)

  if (current === directory) {
    say(`profiles/node_modules/${name}`, 'in sync')
    continue
  }
  drift += 1
  if (checkOnly) {
    say(`profiles/node_modules/${name}`, current === undefined ? 'not installed' : `DRIFTED -> ${current}`)
    continue
  }
  mkdirSync(scopeDirectory, { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(directory, linkPath)
  say(`profiles/node_modules/${name}`, `linked -> ${directory}`)
}

// ---------------------------------------------------------------------------
// 2. The bundle registration.
//
// `dsh.profile.bundles` is what makes the Loader read the bundle's patch file at
// all. It is edited in place with the rest of the manifest preserved: this file
// belongs to the deployment, and an installer that rewrote it wholesale would
// quietly drop whatever else the operator had put there.
// ---------------------------------------------------------------------------
const manifestPath = join(profileDirectory, 'package.json')
if (!existsSync(manifestPath)) {
  console.error(`no package.json in ${profileDirectory}`)
  process.exit(2)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles

if (!Array.isArray(bundles)) {
  console.error(`${manifestPath} has no dsh.profile.bundles array, so no bundle can be composed into it`)
  process.exit(2)
}

if (bundles.includes(BUNDLE_PACKAGE)) {
  say(`profiles/${profile}/package.json`, `${BUNDLE_PACKAGE} already registered`)
} else {
  drift += 1
  if (checkOnly) {
    say(`profiles/${profile}/package.json`, `missing ${BUNDLE_PACKAGE} in dsh.profile.bundles`)
  } else {
    // Prepended, not appended: bundle patches compose in order and a later layer
    // wins on a row id, so DeepBlend's rows sit where the deployment's own
    // bundles can still override them.
    manifest.dsh.profile.bundles = [BUNDLE_PACKAGE, ...bundles]
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    say(`profiles/${profile}/package.json`, `registered ${BUNDLE_PACKAGE}`)
  }
}

if (checkOnly) {
  if (drift === 0) {
    say('result', `DeepBlend is installed in the "${profile}" profile at ${DSH_HOME}`)
    process.exit(0)
  }
  say('result', `${drift} thing(s) are not installed in the "${profile}" profile`)
  say('fix', `node deepblend/tools/install-plugin.mjs --profile ${profile}`)
  process.exit(1)
}

say('dsh home', DSH_HOME)
say('profile', profile)
say('result', drift === 0 ? 'DeepBlend was already installed; nothing changed' : `installed (${drift} change(s))`)
say('also needed', 'node deepblend/tools/install-presets.mjs — the agent preset is a separate plane')
say('note', 'a profile reads its bundles when it starts; restart `dsh web` for the rows to compose')
