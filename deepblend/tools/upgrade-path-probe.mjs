#!/usr/bin/env node
/**
 * Probe: can a profile that installed an OLD version be upgraded, and by which command?
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C3, and the last gap in the install family. Three routes install, and (since C2) they are
 * compared and agree. What had never been measured is the question a user asks SECOND: *"I have last
 * month's build — how do I get this month's?"* `install.md` had no answer, because nobody had run it.
 *
 * The reason it is worth a probe rather than a paragraph: the tarball route's asset name carries no
 * version (`/releases/latest/download/deepblend-bundle.tgz` — the market's rule), so the URL is
 * byte-identical between releases, and pnpm's store is keyed by that URL. A machine that installed
 * the previous release and asks for the same URL again gets the previous artifact — MEASURED in
 * `milestone-status.md` §199.6, and it looks exactly like a failed release.
 *
 * WHAT IT MEASURES
 * ----------------
 * For each route that can start from an old version, in a scratch `$DSH_HOME` of its own:
 *
 *   1. install the OLD spec, and read the version back;
 *   2. re-run the ecosystem's own `add` with the CURRENT spec — does it move?
 *   3. if it does not, `remove` and then `add` — does that move?
 *
 * Both old specs are real: `@deepblend/dsh-blender-bundle@0.2.1` on the registry, and
 * `…/releases/download/v0.2.1/deepblend-bundle.tgz` — a Release asset is addressable by its TAG even
 * though the version-free name only ever serves the latest, which is what makes this measurable.
 *
 * Usage:
 *   node deepblend/tools/upgrade-path-probe.mjs | tee deepblend/docs/probe-upgrade-path.log
 *
 * Exit codes: 0 = at least one documented path upgrades on every route, 1 = a route cannot be
 *             upgraded at all, 2 = the environment could not run it (no pnpm, no network).
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C3)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { source } from './release-version.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')

const BUNDLE_PACKAGE = '@deepblend/dsh-blender-bundle'
const BUNDLE_DIRECTORY = BUNDLE_PACKAGE.replace(/^@[^/]+\//, '')
const CURRENT = source().version
const OLD = '0.2.1'

/** The two routes that can be started from an old version, with the specs that do it. */
const ROUTES = [
  { id: 'npm', oldSpec: `${BUNDLE_PACKAGE}@${OLD}`, currentSpec: BUNDLE_PACKAGE },
  {
    id: 'tarball',
    oldSpec: `https://github.com/pearjelly/deep-blend/releases/download/v${OLD}/deepblend-bundle.tgz`,
    currentSpec: 'https://github.com/pearjelly/deep-blend/releases/latest/download/deepblend-bundle.tgz',
  },
]

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

function run(command, args, options = {}) {
  const outcome = spawnSync(command, args, { encoding: 'utf8', ...options })
  return { status: outcome.status, combined: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim() }
}

/**
 * The version the profile actually has, read from the bundle's own manifest.
 *
 * NOT the same readback as `dsh-plugin-install-probe.mjs`, and deliberately so: that probe answers
 * "did this route deliver the product" (six pins, a served route, both presets), which needs a
 * server. This one answers "which version is in this profile now", which is one file. The full
 * readback runs once per route in the parity check; this runs after every upgrade attempt.
 *
 * @param {string} home
 * @returns {string|null}
 */
function installedVersion(home) {
  const manifest = join(home, 'profiles', 'web', 'node_modules', '@deepblend', BUNDLE_DIRECTORY, 'package.json')
  if (!existsSync(manifest)) return null
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * The spec the profile's manifest records for the bundle — WHY an upgrade did or did not move.
 *
 * The version alone says what happened; this says why. MEASURED on the first run of this probe: the
 * npm route re-added the BARE package name over an exact `@0.2.1` pin and stayed at 0.2.1, which is
 * only explicable if the ecosystem command leaves an existing dependency's spec alone. A reader of
 * this log should not have to guess that.
 *
 * @param {string} home
 * @returns {string|null}
 */
function recordedSpec(home) {
  const manifest = join(home, 'profiles', 'web', 'package.json')
  if (!existsSync(manifest)) return null
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.[BUNDLE_PACKAGE] ?? null
  } catch {
    return null
  }
}

/** `dsh plugin …` in one scratch home, with pnpm's store pinned so a cache cannot answer for us. */
const ecosystem = (home, args, store) => run('dsh', ['plugin', '--profile', 'web', ...args], {
  cwd: ROOT,
  env: { ...process.env, DSH_HOME: home, npm_config_store_dir: store, npm_config_registry: 'https://registry.npmjs.org/' },
})

const pnpm = run('pnpm', ['--version'])
say('date', new Date().toISOString())
say('pnpm', pnpm.status === 0 ? pnpm.combined.split('\n')[0] : 'not on PATH')
say('the version this repository is at', CURRENT)
say('the old version each route starts from', OLD)
if (pnpm.status !== 0) {
  say('result', 'no pnpm, so the ecosystem command cannot run and nothing here can be measured')
  process.exit(2)
}

for (const route of ROUTES) {
  console.log(`\n── ${route.id}: ${OLD} → ${CURRENT} ──`)
  const home = mkdtempSync(join(tmpdir(), `deepblend-upgrade-${route.id}-`))
  const store = mkdtempSync(join(tmpdir(), `deepblend-upgrade-store-${route.id}-`))
  try {
    run('dsh', ['--profile', 'web', '--dump-config'], { cwd: ROOT, env: { ...process.env, DSH_HOME: home } })

    // 1. the old version, really installed.
    const installed = ecosystem(home, ['add', route.oldSpec], store)
    const start = installedVersion(home)
    say(`${route.id} installed`, start === null ? `nothing (exit ${installed.status})` : `${BUNDLE_PACKAGE}@${start}`)
    say(`${route.id} recorded spec`, recordedSpec(home) ?? '(none)')
    if (start !== OLD) {
      problem(`${route.id}: installing ${route.oldSpec} produced ${start ?? 'nothing'}, so the upgrade question cannot be asked`)
      continue
    }

    // 2. the same command again, with the current spec. For npm this is the bare package name (the
    //    `latest` tag); for the tarball it is the version-free URL.
    const readded = ecosystem(home, ['add', route.currentSpec], store)
    const afterReadd = installedVersion(home)
    say(`${route.id} after re-adding the current spec`, `${BUNDLE_PACKAGE}@${afterReadd ?? 'nothing'} (exit ${readded.status})`)
    say(`${route.id} recorded spec now`, recordedSpec(home) ?? '(none)')

    if (afterReadd === CURRENT) {
      say(`${route.id} upgrade path`, 're-running `dsh plugin add` with the current spec is enough')
      continue
    }

    // 3. the other documented shape: remove, then add.
    const removed = ecosystem(home, ['remove', BUNDLE_PACKAGE], store)
    const added = ecosystem(home, ['add', route.currentSpec], store)
    const afterReplace = installedVersion(home)
    say(`${route.id} after remove + add`, `${BUNDLE_PACKAGE}@${afterReplace ?? 'nothing'} (remove exit ${removed.status}, add exit ${added.status})`)
    say(`${route.id} recorded spec now`, recordedSpec(home) ?? '(none)')

    if (afterReplace === CURRENT) {
      say(`${route.id} upgrade path`, 'remove then add — re-adding alone left the old version')
    } else {
      problem(`${route.id}: neither re-adding nor remove+add reached ${CURRENT} (it is at ${afterReplace ?? 'nothing'})`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
  }
}

say('problems', problems.length)
say('result', problems.length === 0
  ? 'every route can be upgraded from an old version, and the probe says which command does it'
  : `${problems.length} reading(s) say an upgrade path does not work`)
process.exit(problems.length === 0 ? 0 : 1)
