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
 * Both used to live only in prose — `README.zh.md` §5 and `runtime-audit.md` §5.4
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
 *   node deepblend/tools/install-plugin.mjs --uninstall       # the same writes, in reverse
 *
 * Exit codes: 0 = installed and in sync, 1 = drift (with --check), 2 = nothing to
 *             install into, or an operator layer that is not ours.
 *
 * Owner: DeepBlend Studio — M5 (reproducibility); `--uninstall` — commercial readiness (C4)
 */

import { existsSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { linkTarget, localPackages, ROOT } from './workspace-layout.mjs'
import { BUNDLE_PATCH, buildStoreOverride, devStoreRoot, renderOperatorLayer, REHOMED_ROW_IDS } from './operator-layer.mjs'
import { snapshot, fileState, applyInstallerPlan, withInstallerLock } from './installer-transaction.mjs'

const LOCAL_SCOPE = '@deepblend'
const BUNDLE_PACKAGE = '@deepblend/dsh-blender-bundle'
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const OPERATOR_LAYER_MARKER = '# DeepBlend Studio — operator layer (GENERATED).'
const EMPTY_OPERATOR_LAYER = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# Emptied by the DeepBlend installer; storage follows the product default.',
  '[]', '',
].join('\n')
const DSH_HOME = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const checkOnly = process.argv.includes('--check')
const uninstall = process.argv.includes('--uninstall')
const portable = process.argv.includes('--portable')

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}
function refuse(message) {
  const error = new Error(message)
  error.exitCode = 2
  throw error
}
function requestedProfile() {
  const index = process.argv.indexOf('--profile')
  if (index === -1) return 'web'
  const name = process.argv[index + 1]
  if (!name || name.startsWith('--') || name === '.' || name === '..' || /[\\/]/.test(name)) {
    refuse('--profile needs a directory name, e.g. --profile web')
  }
  return name
}
function existingProfiles() {
  const root = join(DSH_HOME, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => name !== 'node_modules' && statSync(join(root, name)).isDirectory()).sort()
}
function operatorLayerIsOurs(text) {
  if (text === null) return true
  if (text.includes(OPERATOR_LAYER_MARKER)) return true
  const body = text.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#')).join('\n')
  return body.trim() === '[]'
}
function entriesOfLayer(text) {
  if (text === null) return []
  const body = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim()
  const rows = body ? JSON.parse(body) : []
  if (!Array.isArray(rows)) refuse('The generated operator layer must contain an array; it was left untouched')
  for (const id of REHOMED_ROW_IDS) {
    if (rows.filter(row => row?.id === id).length > 1) refuse(`Multiple operator entries target ${id}; no configuration was changed`)
  }
  return rows
}
function userAdditions(currentRows, templateRows) {
  const preserved = []
  const merged = templateRows.map(row => {
    const found = currentRows.find(candidate => candidate?.id === row.id)
    if (!found) return row
    const extra = Object.fromEntries(Object.entries(found.config ?? {}).filter(([key]) => !(key in (row.config ?? {}))))
    for (const key of Object.keys(extra)) preserved.push(`${row.id}.${key}`)
    const extraRow = Object.fromEntries(Object.entries(found).filter(([key]) => !['id', 'config'].includes(key)))
    for (const key of Object.keys(extraRow)) preserved.push(`${row.id}.${key}`)
    return { ...row, ...extraRow, config: { ...row.config, ...extra } }
  })
  for (const row of currentRows) {
    if (templateRows.some(candidate => candidate.id === row?.id)) continue
    preserved.push(`${row?.id ?? '(row with no id)'} (a whole row)`)
    merged.push(row)
  }
  return { preserved, merged }
}
function mergeOperatorLayer(expected, current) {
  const { preserved, merged } = userAdditions(entriesOfLayer(current), entriesOfLayer(expected))
  if (!preserved.length) return { text: expected, preserved }
  const header = expected.split('\n').filter(line => line.trimStart().startsWith('#')).join('\n')
  return { text: `${header}\n${JSON.stringify(merged, null, 2)}\n`, preserved }
}
function retainedLayer(rows) {
  return rows.length
    ? `${OPERATOR_LAYER_MARKER}\n# Other plugin/user entries retained; only DeepBlend rows belong to the installer.\n${JSON.stringify(rows, null, 2)}\n`
    : EMPTY_OPERATOR_LAYER
}

/** Read other profiles before touching shared links. An unreadable manifest is a refusal. */
function otherReferences(profile, local, observed) {
  const references = []
  for (const other of existingProfiles().filter(name => name !== profile)) {
    const path = join(DSH_HOME, 'profiles', other, 'package.json')
    if (!existsSync(path)) continue
    let manifest
    try {
      const before = snapshot(path)
      if (before.type !== 'file') throw new Error('not a regular manifest')
      observed.set(path, before)
      manifest = JSON.parse(Buffer.from(before.data, 'base64').toString('utf8'))
    } catch {
      refuse(`Cannot read ${path}; shared package references cannot be checked`)
    }
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const names = new Set([...(Array.isArray(bundles) ? bundles : []), ...DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {}))])
    if ([...names].some(name => local.has(name))) references.push(other)
  }
  return references
}

async function run(profile) {
  const profileDirectory = join(DSH_HOME, 'profiles', profile)
  const manifestPath = join(profileDirectory, 'package.json')
  if (!existsSync(manifestPath)) refuse(`no package.json in ${profileDirectory}`)
  const initialManifest = snapshot(manifestPath)
  if (initialManifest.type !== 'file') refuse(`Expected a regular profile manifest at ${manifestPath}`)
  const originalManifest = JSON.parse(Buffer.from(initialManifest.data, 'base64').toString('utf8'))
  const manifest = structuredClone(originalManifest)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) refuse(`${manifestPath} has no dsh.profile.bundles array, so no bundle can be composed into it`)
  const local = localPackages()
  if (!local.size) refuse('no local packages found under packages/deepblend')
  const observed = new Map([[manifestPath, initialManifest]])
  const knownProfiles = existingProfiles()
  const references = otherReferences(profile, local, observed)
  const scope = join(DSH_HOME, 'profiles', 'node_modules', LOCAL_SCOPE)
  const layerPath = join(profileDirectory, 'cordis.patch.yml')
  const initialLayer = snapshot(layerPath)
  if (!['file', 'absent'].includes(initialLayer.type)) refuse(`Expected a regular operator layer at ${layerPath}; no links or files were changed`)
  observed.set(layerPath, initialLayer)
  const current = initialLayer.type === 'file' ? Buffer.from(initialLayer.data, 'base64').toString('utf8') : null
  const changes = []
  let drift = 0
  const plan = (path, after) => {
    const before = observed.get(path) ?? snapshot(path)
    if (after.type === 'file' && before.type === 'file') after.mode = before.mode
    if (!isDeepStrictEqual(before, after)) changes.push({ path, before, after })
  }
  const planFile = (path, text) => plan(path, fileState(text))
  const apply = () => {
    if (!isDeepStrictEqual(existingProfiles(), knownProfiles)) refuse('Profiles changed during planning; re-run the installer')
    for (const [path, before] of observed) {
      if (!isDeepStrictEqual(snapshot(path), before)) refuse(`Configuration changed during planning: ${path}; no files or links were changed`)
    }
    applyInstallerPlan(DSH_HOME, changes)
  }

  if (uninstall) {
    // Only owned rows may be removed. User additions inside those rows cannot be detached
    // safely because DSH replaces entire row configs; refuse before making any change.
    if (current === null) say(`profiles/${profile}/cordis.patch.yml`, 'no operator layer')
    else if (!operatorLayerIsOurs(current)) say(`profiles/${profile}/cordis.patch.yml`, 'NOT OURS — left untouched')
    else if (current.includes(OPERATOR_LAYER_MARKER)) {
      const rows = entriesOfLayer(current)
      const owned = rows.filter(row => REHOMED_ROW_IDS.includes(row?.id))
      if (owned.length) {
        const template = await buildStoreOverride({ storeRoot: devStoreRoot(ROOT), bundlePatch: join(ROOT, BUNDLE_PATCH) })
        const { preserved } = userAdditions(owned, template)
        if (preserved.length) refuse(`${layerPath} carries user settings: ${preserved.join(', ')}. Uninstall made no changes; preserve these settings outside the generated DeepBlend rows before re-running.`)
      }
      const others = rows.filter(row => !REHOMED_ROW_IDS.includes(row?.id))
      planFile(layerPath, retainedLayer(others))
      say(`profiles/${profile}/cordis.patch.yml`, others.length ? `kept ${others.length} other plugin/user row(s)` : 'emptied — storage follows the product default')
    } else say(`profiles/${profile}/cordis.patch.yml`, 'already empty')

    if (bundles.includes(BUNDLE_PACKAGE)) {
      manifest.dsh.profile.bundles = bundles.filter(name => name !== BUNDLE_PACKAGE)
      say(`profiles/${profile}/package.json`, `unregistered ${BUNDLE_PACKAGE}`)
    }
    if (manifest.dependencies?.[BUNDLE_PACKAGE] !== undefined) {
      delete manifest.dependencies[BUNDLE_PACKAGE]
      if (!Object.keys(manifest.dependencies).length) delete manifest.dependencies
    }
    const remainingNames = [...manifest.dsh.profile.bundles, ...DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {}))]
    if (remainingNames.some(name => local.has(name))) references.push(profile)
    // Avoid reformatting a profile whose manifest has no changes.
    if (!isDeepStrictEqual(manifest, originalManifest)) {
      planFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    let ours = 0
    let theirs = 0
    for (const [name, directory] of [...local].sort()) {
      const path = join(scope, name.split('/')[1])
      const target = linkTarget(path)
      if (target === undefined) continue
      if (target === directory && !references.length) {
        plan(path, { type: 'absent' })
        ours += 1
      } else if (target !== directory) theirs += 1
    }
    say(`profiles/node_modules/${LOCAL_SCOPE}`, references.length
      ? `kept shared links used by profile(s): ${references.join(', ')}`
      : ours ? `removed ${ours} link(s)` : 'no links into this checkout')
    if (theirs) say('left alone', `${theirs} foreign package(s) — \`dsh plugin remove ${BUNDLE_PACKAGE} --profile ${profile}\` manages pnpm links`)
    apply()
    if (existsSync(scope) && readdirSync(scope).length === 0) rmdirSync(scope)
    say('result', changes.length ? `uninstalled (${changes.length} change(s))` : 'nothing of DeepBlend was installed in this profile')
    say('also needed', references.length
      ? 'presets remain shared with the other profiles; leave them installed'
      : 'node deepblend/tools/install-presets.mjs --uninstall — the agent preset is a separate plane')
    say('note', 'a profile reads its bundles when it starts; restart `dsh web` for the rows to stop composing')
    return 0
  }

  // Plan the layer first: a refusal must never have already relinked packages or registered a bundle.
  if (!portable && !operatorLayerIsOurs(current)) {
    say(`profiles/${profile}/cordis.patch.yml`, 'NOT OURS — left untouched')
    refuse(`${layerPath} already contains patch entries that this tool did not write.\nMerge the layers by hand, or move that file aside and re-run. No files or links were changed.`)
  }
  if (!portable || current?.includes(OPERATOR_LAYER_MARKER)) {
    const template = await buildStoreOverride({ storeRoot: devStoreRoot(ROOT), bundlePatch: join(ROOT, BUNDLE_PATCH) })
    if (portable) {
      const rows = entriesOfLayer(current)
      const { preserved } = userAdditions(rows.filter(row => REHOMED_ROW_IDS.includes(row?.id)), template)
      if (preserved.length) refuse(`${layerPath} carries ${preserved.join(', ')}, which \`--portable\` cannot keep. No files or links were changed.`)
      const text = retainedLayer(rows.filter(row => !REHOMED_ROW_IDS.includes(row?.id)))
      if (text !== current) {
        planFile(layerPath, text)
        drift += 1
      }
      say(`profiles/${profile}/cordis.patch.yml`, checkOnly && text !== current
        ? 'pins a store this run did not ask for'
        : 'DeepBlend overrides removed; other plugin/user rows kept')
    } else {
      const expected = renderOperatorLayer(template, devStoreRoot(ROOT))
      const { text, preserved } = mergeOperatorLayer(expected, current)
      if (text !== current) {
        drift += 1
        planFile(layerPath, text)
        say(`profiles/${profile}/cordis.patch.yml`, checkOnly ? 'DRIFTED — the bundle changed and this layer was not regenerated' : `storage pinned to ${devStoreRoot(ROOT)}`)
      } else say(`profiles/${profile}/cordis.patch.yml`, `storage pinned to ${devStoreRoot(ROOT)}`)
      if (preserved.length) say(`profiles/${profile}/cordis.patch.yml`, `kept your own setting(s): ${preserved.join(', ')}`)
    }
  }

  for (const [name, directory] of [...local].sort()) {
    const path = join(scope, name.split('/')[1])
    const target = linkTarget(path)
    if (target === directory) { say(`profiles/node_modules/${name}`, 'in sync'); continue }
    // A real directory is never ours to replace, even when no profile currently references it.
    if (target === null) refuse(`Refusing to overwrite a package directory not owned by this installer: ${path}`)
    if (target !== undefined && references.length) refuse(`Refusing to replace a shared package used by profile(s) ${references.join(', ')}: ${path}`)
    drift += 1
    plan(path, { type: 'link', target: directory })
    say(`profiles/node_modules/${name}`, checkOnly ? 'DRIFTED — package link is not in place' : `linked -> ${directory}`)
  }
  if (!bundles.includes(BUNDLE_PACKAGE)) {
    manifest.dsh.profile.bundles = [BUNDLE_PACKAGE, ...bundles]
    drift += 1
  }
  const dependency = `link:${join(ROOT, 'packages', 'deepblend', 'bundle')}`
  if (manifest.dependencies?.[BUNDLE_PACKAGE] !== dependency) {
    manifest.dependencies = { ...manifest.dependencies ?? {}, [BUNDLE_PACKAGE]: dependency }
    drift += 1
  }
  if (!isDeepStrictEqual(manifest, originalManifest)) {
    planFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  if (checkOnly) {
    say('result', drift ? `${drift} thing(s) are not installed in the "${profile}" profile` : `DeepBlend is installed in the "${profile}" profile at ${DSH_HOME}`)
    if (drift) say('fix', `node deepblend/tools/install-plugin.mjs --profile ${profile}`)
    return drift ? 1 : 0
  }
  apply()
  say('dsh home', DSH_HOME)
  say('profile', profile)
  say('result', changes.length ? `installed (${changes.length} change(s))` : 'DeepBlend was already installed; nothing changed')
  say('also needed', 'node deepblend/tools/install-presets.mjs — the agent preset is a separate plane')
  say('note', 'a profile reads its bundles when it starts; restart `dsh web` for the rows to compose')
  return 0
}

try {
  if (checkOnly && uninstall) refuse('--check reports and --uninstall changes; pick one')
  const profile = requestedProfile()
  if (!existsSync(join(DSH_HOME, 'profiles', profile))) {
    refuse(`no profile at ${join(DSH_HOME, 'profiles', profile)}\nknown profiles: ${existingProfiles().join(', ') || '(none)'}\nA profile is created by \`dsh\`, not by this installer. Run \`dsh --profile ${profile} --dump-config\` to initialise it, then re-run.`)
  }
  process.exitCode = await withInstallerLock(DSH_HOME, checkOnly, () => run(profile))
} catch (error) {
  console.error(error.message)
  process.exitCode = error.exitCode ?? 2
}
