#!/usr/bin/env node
/**
 * Install the repository's agent presets into the DSH home.
 *
 * WHY THIS EXISTS
 * ---------------
 * `deepblend/presets/` is SPEC §5.2's directory, and until M3 it was EMPTY: the
 * `deepblend-dev` preset existed only as `~/.dsh/.agent-presets/deepblend-dev/`, a
 * file outside version control that nothing regenerated and nothing compared against
 * anything. Two things followed from that, and both were observed:
 *
 *   1. **The deployment was not reproducible from the repository.** A fresh clone
 *      could not produce the preset the product runs on, which is the same class of
 *      gap the M2 session closed for the demo project (`.deepblend/` is generated, so
 *      the two things that make it reproducible are committed).
 *   2. **A stale copy nobody read drifted for hours.** That file's comment still said
 *      "the catalog is TEN tools" and called four tools "deliberately ABSENT" five
 *      hours after M3 registered them (architecture-decisions D60). Nothing linked
 *      the two copies, so nothing could notice.
 *
 * So the repository copy is the SOURCE and this script is the deployment step, the
 * same shape as `create-demo-project.mjs` producing the generated store.
 *
 * The bundle deploys presets at boot. This script also supports an explicit local
 * install and a guarded uninstall, with an ownership receipt and recovery journal
 * under `$DSH_HOME`. Preset files live in `$DSH_HOME/.agent-presets/`
 * — never the deployment's own `agent-presets` directory beside the DSH install,
 * which belongs to the deployment and is replaced on upgrade.
 *
 * Usage:
 *   node deepblend/tools/install-presets.mjs            # install every preset
 *   node deepblend/tools/install-presets.mjs --check    # report drift, change nothing
 *   node deepblend/tools/install-presets.mjs --uninstall # remove the presets this deploys
 *
 * `--check` HAS THREE OUTCOMES, NOT TWO
 * -------------------------------------
 * `in sync` / `drifted` / **`not installed on this machine`**. The third one is the state of
 * every fresh clone and every CI runner, and until 2026-09-14 it was counted as drift: the
 * per-file label already said "not installed", and the counter beside it said `drift += 1`,
 * so `--check` exited 1 with the summary "5 file(s) drifted" on a machine where nothing was
 * wrong and nothing could be fixed except by installing something the user never asked for.
 * (Measured in a Linux container; `milestone-status.md` §25. The sibling `plugin --check`
 * had it right all along: a missing profile is exit 2 with an explanation, the same third
 * state D75 named for the capability probe.)
 *
 * The rule is: **absent entirely is a state; partly present is drift.**
 *
 * Owner: DeepBlend Studio — M3
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import * as deployRule from '@deepblend/dsh-blender-preset/deploy'
import { applyInstallerPlan, fileState, snapshot, withInstallerLock } from './installer-transaction.mjs'

const args = process.argv.slice(2)
const unknown = args.filter(arg => !['--check', '--uninstall', '--help', '-h'].includes(arg))
if (unknown.length) {
  console.error(`Unknown preset installer argument: ${unknown.join(', ')}. Use --help; nothing was changed.`)
  process.exit(2)
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node deepblend/tools/install-presets.mjs [--check | --uninstall | --help]\n' +
    'No arguments: install repository presets into DSH_HOME.\n' +
    '--check: report state without writes. --uninstall: remove owned presets. --help: show this help without writes.')
  process.exit(0)
}

const ROOT = resolve(import.meta.dirname, '..', '..')
const SOURCE = join(ROOT, 'deepblend', 'presets')
const DSH_HOME = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const TARGET = join(DSH_HOME, '.agent-presets')
const RECEIPT = join(DSH_HOME, '.deepblend-preset-ownership.json')
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const checkOnly = process.argv.includes('--check')
const uninstall = process.argv.includes('--uninstall')
const REQUIRED_FILES = deployRule.REQUIRED_FILES
const filesUnder = deployRule.filesUnder
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}
function refuse(message) {
  const error = new Error(message)
  error.exitCode = 2
  throw error
}
function directory(path) {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse(`NOT OURS — refusing to traverse or remove a preset link or non-directory: ${path}`)
  return true
}
/** Reject all nested links instead of following one into a user's other directory. */
function installedFiles(root, relative = '') {
  const files = []
  if (!directory(join(root, relative))) return files
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const file = join(relative, entry.name)
    if (entry.isDirectory()) files.push(...installedFiles(root, file))
    else if (entry.isFile()) files.push(file)
    else refuse(`NOT OURS — preset contains a link or special file: ${join(root, file)}`)
  }
  return files.sort()
}
function profileNames() {
  const profiles = join(DSH_HOME, 'profiles')
  if (!existsSync(profiles)) return []
  return readdirSync(profiles, { withFileTypes: true })
    .filter(entry => entry.name !== 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => entry.name).sort()
}
/** Conservative check of declared dependencies and explicit preset references; no profile is started. */
function referencedProfiles(presets, observed) {
  const references = []
  const escaped = presets.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const presetName = new RegExp(`(^|[^A-Za-z0-9_-])(?:${escaped.join('|')})($|[^A-Za-z0-9_-])`)
  for (const profile of profileNames()) {
    const root = join(DSH_HOME, 'profiles', profile)
    if (!directory(root)) continue
    for (const name of ['package.json', 'cordis.yml', 'cordis.patch.yml']) {
      const path = join(root, name)
      const before = snapshot(path)
      observed.set(path, before)
      if (before.type === 'absent') continue
      if (before.type !== 'file') refuse(`Cannot inspect shared preset references through ${path}; no presets were removed`)
      const text = Buffer.from(before.data, 'base64').toString('utf8')
      if (name === 'package.json') {
        let manifest
        try { manifest = JSON.parse(text) } catch { refuse(`Cannot read ${path}; no presets were removed`) }
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) refuse(`Invalid profile manifest: ${path}`)
        const bundles = manifest.dsh?.profile?.bundles ?? []
        if (!Array.isArray(bundles)) refuse(`Invalid bundle references in ${path}`)
        const packages = [...bundles, ...DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {}))]
        if (packages.some(spec => typeof spec === 'string' && spec.startsWith('@deepblend/'))) references.push(`${profile} (${name})`)
      } else {
        const body = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
        if (body.includes('@deepblend/') || presetName.test(body)) references.push(`${profile} (${name})`)
      }
    }
  }
  return [...new Set(references)]
}
function pruneOwnedDirectories(root, files) {
  const directories = new Set([root])
  for (const file of files) {
    let path = dirname(join(root, file))
    while (path !== root) { directories.add(path); path = dirname(path) }
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) {
    try { rmdirSync(path) } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) say('left alone', `could not remove empty directory ${path}: ${error.message}`)
    }
  }
}

function run(presets) {
  if (existsSync(TARGET)) directory(TARGET)
  const beforeReceipt = snapshot(RECEIPT)
  if (!['file', 'absent'].includes(beforeReceipt.type)) refuse(`NOT OURS — expected a regular receipt file: ${RECEIPT}`)
  const receipt = beforeReceipt.type === 'file'
    ? JSON.parse(Buffer.from(beforeReceipt.data, 'base64').toString('utf8'))
    : { version: 1, presets: {} }
  if (receipt.version !== 1 || !receipt.presets || typeof receipt.presets !== 'object' || Array.isArray(receipt.presets)) refuse(`Invalid preset ownership receipt: ${RECEIPT}`)
  const changes = []
  const observed = new Map([[RECEIPT, beforeReceipt]])
  const knownProfiles = profileNames()
  const plan = (path, after) => {
    const before = observed.get(path) ?? snapshot(path)
    observed.set(path, before)
    if (after.type === 'file' && before.type === 'file') after.mode = before.mode
    if (!isDeepStrictEqual(before, after)) changes.push({ path, before, after })
  }
  const apply = () => {
    if (uninstall && !isDeepStrictEqual(profileNames(), knownProfiles)) refuse('Profiles changed during planning; no presets were removed')
    for (const [path, before] of observed) {
      if (!isDeepStrictEqual(snapshot(path), before)) refuse(`Configuration changed during planning: ${path}; no preset files were changed`)
    }
    applyInstallerPlan(DSH_HOME, changes)
  }
  const sources = new Map(presets.map(id => {
    const source = join(SOURCE, id)
    for (const required of REQUIRED_FILES) {
      if (!existsSync(join(source, required))) refuse(`${id}: missing ${required} in the repository copy`)
    }
    return [id, Object.fromEntries(filesUnder(source).map(file => [file, readFileSync(join(source, file))]))]
  }))

  if (uninstall) {
    const present = presets.filter(id => directory(join(TARGET, id)))
    if (present.length) {
      const references = referencedProfiles(presets, observed)
      if (references.length) refuse(`Presets are still referenced by profile(s): ${references.join(', ')}. Remove their DeepBlend bundle/dependency or preset configuration first; no presets were removed.`)
    }
    const removals = []
    for (const id of presets) {
      if (!present.includes(id)) { say(id, 'not installed'); delete receipt.presets[id]; continue }
      const root = join(TARGET, id)
      const files = installedFiles(root)
      // Legacy/native deployment has no receipt. Exact published content is the only
      // evidence available there; anything else must be preserved for manual review.
      const owned = receipt.presets[id]?.files ?? Object.fromEntries(Object.entries(sources.get(id)).map(([file, bytes]) => [file, digest(bytes)]))
      for (const file of files) {
        const path = join(root, file)
        const before = snapshot(path)
        observed.set(path, before)
        const currentHash = before.type === 'file' ? digest(Buffer.from(before.data, 'base64')) : null
        const publishedHash = sources.get(id)[file] ? digest(sources.get(id)[file]) : null
        if (currentHash === null || (currentHash !== owned[file] && currentHash !== publishedHash)) {
          refuse(`NOT OURS — ${path} was modified or has no ownership evidence; no presets were removed. Preserve or move your changes before retrying.`)
        }
        plan(path, { type: 'absent' })
      }
      removals.push({ id, root, files })
      delete receipt.presets[id]
    }
    if (Object.keys(receipt.presets).length) plan(RECEIPT, fileState(`${JSON.stringify(receipt, null, 2)}\n`))
    else plan(RECEIPT, { type: 'absent' })
    apply()
    for (const removal of removals) {
      pruneOwnedDirectories(removal.root, removal.files)
      say(removal.id, `removed owned files -> ${removal.root}`)
    }
    say('preset root', TARGET)
    say('result', !removals.length ? 'no DeepBlend preset was installed' : `uninstalled ${removals.length} preset(s)`)
    return 0
  }

  let drift = 0
  let installed = 0
  let absent = 0
  for (const id of presets) {
    const root = join(TARGET, id)
    const source = sources.get(id)
    const sourceFiles = Object.keys(source)
    const targetFiles = installedFiles(root)
    if (!checkOnly) {
      for (const file of targetFiles) {
        const existing = readFileSync(join(root, file))
        if (source[file] && !existing.equals(source[file]) && digest(existing) !== receipt.presets[id]?.files?.[file]) {
          refuse(`NOT OURS — ${join(root, file)} was modified or conflicts with the preset being installed; no preset files were changed. Preserve or move your changes before retrying.`)
        }
      }
    }
    const stale = targetFiles.filter(file => !sourceFiles.includes(file))
    const missing = sourceFiles.filter(file => !existsSync(join(root, file)))
    if (checkOnly && stale.length === 0 && missing.length === sourceFiles.length) {
      say(id, 'not installed on this machine — nothing to drift'); absent += 1; continue
    }
    for (const file of stale) {
      drift += 1
      if (checkOnly) { say(`${id}/${file}`, 'STALE — installed but no longer in the repository copy'); continue }
      const path = join(root, file)
      const before = snapshot(path)
      if (receipt.presets[id]?.files?.[file] === digest(Buffer.from(before.data, 'base64'))) {
        plan(path, { type: 'absent' })
        say(`${id}/${file}`, 'removed — no longer in the repository copy')
      } else say(`${id}/${file}`, 'kept — not an unchanged file owned by this installer')
    }
    for (const file of sourceFiles) {
      const path = join(root, file)
      const before = snapshot(path)
      observed.set(path, before)
      const same = before.type === 'file' && Buffer.from(before.data, 'base64').equals(source[file])
      if (checkOnly) {
        say(`${id}/${file}`, same ? 'in sync' : before.type === 'absent' ? 'MISSING' : 'DRIFTED')
        if (!same) drift += 1
      } else if (!same) {
        plan(path, { type: 'file', data: source[file].toString('base64'), mode: 0o600 })
        installed += 1
        say(`${id}/${file}`, `installed -> ${path}`)
      } else say(`${id}/${file}`, 'already in sync')
    }
    receipt.presets[id] = { files: Object.fromEntries(sourceFiles.map(file => [file, digest(source[file])])) }
  }
  if (checkOnly) {
    if (drift) { say('result', `${drift} file(s) drifted`); say('fix', 'preserve or move local edits, then run node deepblend/tools/install-presets.mjs'); return 1 }
    say('result', absent === presets.length ? 'the presets are not installed on this machine, so there is nothing to drift' : 'the installed presets match the repository')
    return 0
  }
  plan(RECEIPT, fileState(`${JSON.stringify(receipt, null, 2)}\n`))
  apply()
  say('installed files', installed)
  say('note', 'a preset is read when the profile starts; restart `dsh web` for a change to take effect')
  say('next', "check it mounts: the roster reports each preset's standing mount state")
  return 0
}

try {
  if (checkOnly && uninstall) refuse('--check reports and --uninstall changes; pick one')
  if (!existsSync(SOURCE)) refuse(`no preset source directory at ${SOURCE}`)
  const presets = readdirSync(SOURCE, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  if (!presets.length) refuse(`${SOURCE} contains no preset directories`)
  if (!existsSync(DSH_HOME)) {
    if (checkOnly || uninstall) {
      say('result', uninstall ? 'no DeepBlend preset was installed' : 'the presets are not installed on this machine, so there is nothing to drift')
      process.exitCode = 0
    } else {
      mkdirSync(DSH_HOME, { recursive: true })
      process.exitCode = await withInstallerLock(DSH_HOME, false, () => run(presets))
    }
  } else process.exitCode = await withInstallerLock(DSH_HOME, checkOnly, () => run(presets))
} catch (error) {
  console.error(error.message)
  process.exitCode = error.exitCode ?? 2
}
