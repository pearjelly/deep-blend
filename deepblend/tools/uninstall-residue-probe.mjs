#!/usr/bin/env node
/**
 * Probe: install DeepBlend, follow the manual's uninstall, and read back what is left.
 *
 * WHY THIS IS A PROBE AND NOT A SUITE
 * -----------------------------------
 * The reading needs a scratch `$DSH_HOME`, a profile created by `dsh`, and pnpm (the
 * ecosystem's own `dsh plugin remove` runs it) — none of which belongs in the contract layer,
 * which runs in CI on every push and promises to need nothing but Node, git and a Python 3.
 * Like `dsh-plugin-install-probe.mjs`, it is run deliberately and its output is committed:
 *
 *     node deepblend/tools/uninstall-residue-probe.mjs | tee deepblend/docs/probe-uninstall-residue.log
 *
 * The contract layer covers the same tool behaviour against a fixture profile
 * (`tests/contract/uninstall-residue.test.mjs`); what THIS adds is the real profile, created
 * by the real launcher, plus the one command the fixture cannot run.
 *
 * WHAT IT MEASURES, IN ORDER
 * --------------------------
 *   1. the documented INSTALL (the four steps' last two) really puts DeepBlend into the
 *      profile — the before-reading, so "it was removed" cannot be a statement about a home
 *      where nothing was ever installed;
 *   2. the documented UNINSTALL — `dsh plugin remove`, then `plugin:uninstall`, then
 *      `presets:uninstall` — with every exit code;
 *   3. the residue: the bundle registration, the dependency key, the operator layer this
 *      repository wrote, the `@deepblend/*` links, and the preset root.
 *
 * WHY THE `result:` LINE IS DERIVED AND NOT WRITTEN
 * ------------------------------------------------
 * `dsh-plugin-install-probe.mjs` used to announce its own success from the shape of the run
 * rather than from its readings, and a log with a false conclusion in it was committed as
 * evidence (D199). This probe has the same obligation: the conclusion and the exit code both
 * come from the `problems` list below, which is filled by the readings.
 *
 * It never touches `~/.dsh`. The whole run happens in a temp directory removed at the end,
 * including when it fails.
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C4)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')

const BUNDLE_PACKAGE = '@deepblend/dsh-blender-bundle'
const PROFILE = 'web'

/** The preset ids this repository deploys, read from the source of truth. */
const PRESETS = readdirSync(join(ROOT, 'deepblend', 'presets'))
  .filter(name => statSync(join(ROOT, 'deepblend', 'presets', name)).isDirectory())
  .sort()

const report = []
function say(label, value) {
  const line = `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  report.push(line)
  console.log(line)
}

/** The readings that are WRONG, as opposed to merely interesting. */
const problems = []
function problem(what) {
  problems.push(what)
  console.log(`PROBLEM: ${what}`)
}

/** Run a command and capture everything, without throwing on a non-zero exit. */
function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, { encoding: 'utf8', ...options })
  return {
    status: outcome.status,
    combined: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim(),
  }
}

/** The last non-empty line, which is what a `dsh` subcommand's verdict is on. */
const lastLine = text => text.split('\n').map(line => line.trim()).filter(Boolean).pop() ?? '(no output)'

const home = mkdtempSync(join(tmpdir(), 'deepblend-uninstall-probe-'))
const profileDirectory = join(home, 'profiles', PROFILE)
const manifestPath = join(profileDirectory, 'package.json')
const operatorLayerPath = join(profileDirectory, 'cordis.patch.yml')
const scopeDirectory = join(home, 'profiles', 'node_modules', '@deepblend')
const presetRoot = join(home, '.agent-presets')

const env = { ...process.env, DSH_HOME: home }

const manifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'))
/** The patch entries in an operator layer, ignoring its comment header. */
function operatorEntries() {
  if (!existsSync(operatorLayerPath)) return null
  const body = readFileSync(operatorLayerPath, 'utf8')
    .split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim()
  return body.length === 0 ? [] : JSON.parse(body)
}
const linksInScope = () => (existsSync(scopeDirectory) ? readdirSync(scopeDirectory).sort() : null)
const presetsPresent = () => PRESETS.filter(preset => existsSync(join(presetRoot, preset)))

try {
  say('date', new Date().toISOString())
  say('scratch DSH_HOME', home)
  say('dsh', lastLine(run('dsh', ['--version']).combined))
  say('pnpm', lastLine(run('pnpm', ['--version']).combined))

  // -------------------------------------------------------------------------
  // 0. A profile, created by the launcher rather than by this probe.
  // -------------------------------------------------------------------------
  const created = run('dsh', ['--profile', PROFILE, '--dump-config'], { env })
  say('profile created by `dsh`', created.status === 0 ? 'yes' : `exit ${created.status}`)
  if (created.status !== 0) {
    say('result', 'no profile could be created, so nothing about uninstall can be measured here')
    process.exit(2)
  }

  // -------------------------------------------------------------------------
  // 1. The documented install, so the reading below is about removal.
  // -------------------------------------------------------------------------
  const installed = run('node', [join(HERE, 'install-plugin.mjs')], { cwd: ROOT, env })
  say('`plugin:install`', `exit ${installed.status} — ${lastLine(installed.combined)}`)
  const presetsInstalled = run('node', [join(HERE, 'install-presets.mjs')], { cwd: ROOT, env })
  say('`presets:install`', `exit ${presetsInstalled.status} — ${lastLine(presetsInstalled.combined)}`)

  const before = {
    bundleRegistered: (manifest().dsh?.profile?.bundles ?? []).includes(BUNDLE_PACKAGE),
    dependency: manifest().dependencies?.[BUNDLE_PACKAGE] ?? null,
    operatorEntries: operatorEntries(),
    links: linksInScope(),
    presets: presetsPresent(),
  }
  say('BEFORE — bundle in dsh.profile.bundles', before.bundleRegistered)
  say('BEFORE — dependency', before.dependency ?? '(none)')
  say('BEFORE — operator layer entries', before.operatorEntries?.length ?? '(no file)')
  say('BEFORE — links into this checkout', before.links?.length ?? '(no scope directory)')
  say('BEFORE — presets in the root', before.presets)

  if (!before.bundleRegistered || before.dependency === null || before.presets.length !== PRESETS.length) {
    problem('the install did not put DeepBlend into the profile, so the uninstall reading below would be vacuous')
  }

  // -------------------------------------------------------------------------
  // 2. The documented uninstall, in the documented order.
  // -------------------------------------------------------------------------
  const removed = run('dsh', ['plugin', 'remove', BUNDLE_PACKAGE, '--profile', PROFILE], { env })
  say('`dsh plugin remove`', `exit ${removed.status} — ${lastLine(removed.combined)}`)
  if (removed.status !== 0) problem('`dsh plugin remove` failed, so the ecosystem half of the uninstall was not measured')

  const pluginUndone = run('node', [join(HERE, 'install-plugin.mjs'), '--uninstall'], { cwd: ROOT, env })
  say('`plugin:uninstall`', `exit ${pluginUndone.status} — ${lastLine(pluginUndone.combined)}`)
  if (pluginUndone.status !== 0) problem('`plugin:uninstall` exited non-zero')

  const presetsUndone = run('node', [join(HERE, 'install-presets.mjs'), '--uninstall'], { cwd: ROOT, env })
  say('`presets:uninstall`', `exit ${presetsUndone.status} — ${lastLine(presetsUndone.combined)}`)
  if (presetsUndone.status !== 0) problem('`presets:uninstall` exited non-zero')

  // -------------------------------------------------------------------------
  // 3. The residue.
  // -------------------------------------------------------------------------
  const after = manifest()
  const bundleAfter = (after.dsh?.profile?.bundles ?? []).includes(BUNDLE_PACKAGE)
  const entriesAfter = operatorEntries()
  const linksAfter = linksInScope()
  const presetsAfter = presetsPresent()
  const rootAfter = existsSync(presetRoot)
    ? readdirSync(presetRoot).filter(name => statSync(join(presetRoot, name)).isDirectory()).sort()
    : []

  say('AFTER — bundle in dsh.profile.bundles', bundleAfter)
  say('AFTER — dependencies key', after.dependencies === undefined ? '(absent)' : JSON.stringify(after.dependencies))
  say('AFTER — operator layer entries', entriesAfter?.length ?? '(no file)')
  say('AFTER — scope directory', linksAfter === null ? '(gone)' : JSON.stringify(linksAfter))
  say('AFTER — presets in the root', presetsAfter)
  say('AFTER — directories left in the preset root', rootAfter)

  if (bundleAfter) problem('the profile still composes the bundle after the documented uninstall')
  if (after.dependencies !== undefined) problem(`the profile still has a dependencies key: ${JSON.stringify(after.dependencies)}`)
  if (entriesAfter !== null && entriesAfter.length > 0) problem('the operator layer still carries patch entries this repository wrote')
  if (linksAfter !== null) problem(`the @deepblend scope directory outlived the uninstall: ${JSON.stringify(linksAfter)}`)
  if (presetsAfter.length > 0) problem(`presets survived the uninstall: ${JSON.stringify(presetsAfter)}`)

  // The other direction, and the one a hand-typed `rm -rf` list cannot give: what remains in
  // the profile is what `dsh` put there, and nothing else. `pnpm-lock.yaml` is written by the
  // `dsh plugin remove` above; everything else is the launcher's own set.
  const remaining = existsSync(profileDirectory)
    ? readdirSync(profileDirectory).sort().filter(name => name !== 'pnpm-lock.yaml')
    : []
  say('AFTER — profile files', remaining)
  const launcherFiles = ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml']
  const extra = remaining.filter(name => !launcherFiles.includes(name))
  if (extra.length > 0) problem(`the profile holds files neither the launcher nor this reading accounts for: ${JSON.stringify(extra)}`)
  if (!existsSync(operatorLayerPath)) problem('the operator layer file was deleted; it belongs to the profile, so it is emptied and not removed')

  say('problems', problems.length)
  say('result', problems.length === 0
    ? 'the documented uninstall leaves the profile and the preset root with nothing of DeepBlend in them'
    : `${problems.length} reading(s) say the uninstall is not clean`)
  process.exit(problems.length === 0 ? 0 : 1)
} finally {
  rmSync(home, { recursive: true, force: true })
}
