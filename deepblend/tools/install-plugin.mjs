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
 * WHY THIS STILL EXISTS NOW THAT `dsh plugin add` HAS BEEN MEASURED (Q10 → D98)
 * ---------------------------------------------------------------------------
 * It is NOT because pnpm is missing — `dsh plugin` needs pnpm on PATH, and pnpm is
 * installable, so that was never a property of the product. `dsh plugin --profile web add
 * <the six package paths>` works, from a checkout, today: measured end to end on a scratch
 * `$DSH_HOME`, the profile it produces serves `/deepblend/capabilities` with HTTP 200 and
 * `hostApiVersion 4` (`docs/probe-dsh-plugin-install.log`, tool:
 * `tools/dsh-plugin-install-probe.mjs`).
 *
 * What that path does NOT do is the one thing this script is for: it leaves the store at the
 * product default, `<DSH_HOME>/deepblend`. A checkout's tools all work on `<repo>/.deepblend`,
 * so a deployment installed that way shows an empty project list beside a project that
 * plainly exists on disk — the same measurement, `projectsRoot` under the scratch home. The
 * operator layer below is derived from the shipped bundle patch on every run and `--check`
 * re-derives and compares it, which `dsh plugin add` has no equivalent of either.
 *
 * So: `dsh plugin add` is the USER's path (and the one npm publishing would turn into a
 * single command); this script is the CONTRIBUTOR's, and the difference between them is
 * exactly the storage pin.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   $DSH_HOME/profiles/node_modules/@deepblend/<pkg>   ->  packages/deepblend/<dir>
 *   $DSH_HOME/profiles/<profile>/package.json          (adds ONE entry to
 *                                                       dsh.profile.bundles)
 *   $DSH_HOME/profiles/<profile>/cordis.patch.yml      (the operator layer; see
 *                                                       step 3 below)
 *
 * It does NOT touch the DSH installation, the shipped agent presets, or an
 * operator layer that somebody else wrote — that last one is refused rather than
 * overwritten, because "the installer replaced my config" is not a failure a user
 * can diagnose from the result.
 *
 * WHERE STORAGE ENDS UP
 * ---------------------
 * Since M5 the bundle names no path: unset, the product stores under
 * `<DSH_HOME>/deepblend` (SPEC §17). That is right for an installation and wrong
 * for a checkout — this repository's tools all work on `<repo>/.deepblend`, so a
 * deployment reading `~/.dsh/deepblend` would show an empty project list beside a
 * project that plainly exists on disk.
 *
 * So by default this script also writes the operator layer that pins the
 * deployment to `<repo>/.deepblend`. `--portable` skips it (and removes one it
 * wrote earlier), leaving the deployment on the product default. The layer is
 * DERIVED from the shipped bundle patch every run — never retyped — and `--check`
 * re-derives and compares, so a bundle change that never reached the deployment
 * is reported instead of silently ignored.
 *
 * Usage:
 *   node deepblend/tools/install-plugin.mjs                   # install into the `web` profile
 *   node deepblend/tools/install-plugin.mjs --profile <name>
 *   node deepblend/tools/install-plugin.mjs --portable        # keep the $DSH_HOME default
 *   node deepblend/tools/install-plugin.mjs --check           # report drift, change nothing
 *
 * Exit codes: 0 = installed and in sync, 1 = drift (with --check), 2 = nothing to
 *             install into, or an operator layer that is not ours.
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { linkTarget, localPackages, ROOT } from './workspace-layout.mjs'
import { BUNDLE_PATCH, buildStoreOverride, devStoreRoot, renderOperatorLayer } from './operator-layer.mjs'

/** The npm scope DeepBlend's own packages live under. */
const LOCAL_SCOPE = '@deepblend'

/** The bundle whose patch composes the three DeepBlend host rows. */
const BUNDLE_PACKAGE = '@deepblend/dsh-blender-bundle'

/** First line of an operator layer this tool generated; how it recognises its own. */
const OPERATOR_LAYER_MARKER = '# DeepBlend Studio — operator layer (GENERATED).'

/**
 * What `--portable` leaves behind: the empty patch list a profile ships with.
 *
 * Not an absent file. `dsh` creates `cordis.patch.yml` as part of every profile,
 * and an installer that deletes one of a deployment's own files is doing
 * something the user cannot see and did not ask for.
 */
const EMPTY_OPERATOR_LAYER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '#',
  '# Emptied by `node deepblend/tools/install-plugin.mjs --portable`: this',
  '# deployment keeps DeepBlend\'s product default storage (<DSH_HOME>/deepblend).',
  '[]',
  '',
].join('\n')

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const checkOnly = process.argv.includes('--check')

/**
 * `--portable` leaves the deployment on the product defaults (`<DSH_HOME>/deepblend`)
 * and removes an operator layer this tool wrote earlier.
 *
 * It exists because the two answers are both legitimate and the difference is
 * invisible afterwards: a developer wants the store beside the checkout so the
 * repository's tools and the workbench name the same directory, while anyone
 * installing DeepBlend as a plugin wants its state under `DSH_HOME`. Making that
 * a flag rather than a guess means a reader can tell which one a machine has.
 */
const portable = process.argv.includes('--portable')

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
  // A profile is dsh's to create, not this installer's: it is a directory of files
  // (`cordis.yml`, `pnpm-workspace.yaml`, a manifest) that the launcher writes and
  // composes, and hand-building a half of one would leave a deployment that boots
  // differently from every other. Refusing is the honest answer — and the message has
  // to say the fix, because the reader reached this by following a manual whose
  // prerequisites did not mention it. MEASURED on a clean clone and a fresh DSH_HOME:
  // `dsh --profile web --dump-config` creates the profile as a side effect.
  console.error(`no profile at ${profileDirectory}`)
  console.error(`known profiles: ${existingProfiles().join(', ') || '(none)'}`)
  console.error(
    `A profile is created by \`dsh\`, not by this installer. Run \`dsh --profile ${profile} --dump-config\` ` +
    `(or start \`dsh web\` once) to initialise it, then re-run this command.`,
  )
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

// ---------------------------------------------------------------------------
// 3. The operator layer: where this deployment's storage lives.
//
// The bundle names no path any more, so an installed deployment stores under
// `<DSH_HOME>/deepblend` (SPEC §17) unless something says otherwise. This
// repository's own tools all work on `<repo>/.deepblend`, so without this step
// the workbench and the tools would name two different directories and the
// project list would be empty for a project that plainly exists on disk.
//
// The layer is DERIVED from the shipped bundle patch, never retyped, because a
// patch layer's `config` replaces the bundle's wholesale (D74). `--check`
// re-derives it and compares, so a bundle change that never reached the
// deployment is reported instead of being silently ignored.
// ---------------------------------------------------------------------------
const operatorLayerPath = join(profileDirectory, 'cordis.patch.yml')
const desiredStoreRoot = portable ? undefined : devStoreRoot(ROOT)

/** Whether the operator layer on disk is one this tool wrote, or nothing at all. */
function operatorLayerIsOurs() {
  if (!existsSync(operatorLayerPath)) return true
  const text = readFileSync(operatorLayerPath, 'utf8')
  if (text.includes(OPERATOR_LAYER_MARKER)) return true
  // An untouched profile ships a comment header and an empty patch list. Anything
  // that is not empty belongs to whoever wrote it, and is not ours to replace.
  const body = text.split('\n').filter(line => line.trim().length > 0 && !line.trimStart().startsWith('#')).join('\n')
  return body.trim() === '[]'
}

if (desiredStoreRoot !== undefined) {
  const expected = renderOperatorLayer(
    await buildStoreOverride({ storeRoot: desiredStoreRoot, bundlePatch: join(ROOT, BUNDLE_PATCH) }),
    desiredStoreRoot,
  )
  const current = existsSync(operatorLayerPath) ? readFileSync(operatorLayerPath, 'utf8') : null

  if (current === expected) {
    say(`profiles/${profile}/cordis.patch.yml`, `storage pinned to ${desiredStoreRoot}`)
  } else if (!operatorLayerIsOurs()) {
    // Refusing beats clobbering. Someone's own operator layer may hold settings
    // this tool knows nothing about, and "the installer overwrote my config" is
    // not a failure a user can diagnose from the result.
    //
    // This exits immediately rather than falling through, because `--check` would
    // otherwise reach its own `process.exit(0)` and report the workspace healthy
    // while the storage it was asked about is not pinned at all — a green line
    // describing the opposite of what just happened.
    say(`profiles/${profile}/cordis.patch.yml`, 'NOT OURS — left untouched')
    console.error(
      `${operatorLayerPath} already contains patch entries that this tool did not write.\n` +
      `DeepBlend's storage will follow the product default (<DSH_HOME>/deepblend) instead of ${desiredStoreRoot}.\n` +
      'Merge the layers by hand, or move that file aside and re-run.',
    )
    process.exit(2)
  } else {
    drift += 1
    if (checkOnly) {
      say(`profiles/${profile}/cordis.patch.yml`, current === null
        ? `missing (storage would be the product default, not ${desiredStoreRoot})`
        : 'DRIFTED — the bundle changed and this layer was not regenerated')
    } else {
      writeFileSync(operatorLayerPath, expected)
      say(`profiles/${profile}/cordis.patch.yml`, `storage pinned to ${desiredStoreRoot}`)
    }
  }
} else if (existsSync(operatorLayerPath) && operatorLayerIsOurs()) {
  // `--portable`: the deployment keeps the product default, so an operator layer
  // this tool wrote earlier is now the only thing overriding it.
  //
  // The file is EMPTIED rather than deleted. `cordis.patch.yml` is a standard
  // part of a profile — `dsh` creates it, and "the installer removed one of my
  // profile's files" is not a state a user should have to reason about. An empty
  // patch list is exactly what a profile ships with, so this restores it to that.
  const text = readFileSync(operatorLayerPath, 'utf8')
  if (text.includes(OPERATOR_LAYER_MARKER)) {
    drift += 1
    if (checkOnly) {
      say(`profiles/${profile}/cordis.patch.yml`, 'pins a store this run did not ask for')
    } else {
      writeFileSync(operatorLayerPath, EMPTY_OPERATOR_LAYER)
      say(`profiles/${profile}/cordis.patch.yml`, 'emptied — storage follows the product default')
    }
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
