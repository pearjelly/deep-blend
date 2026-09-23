#!/usr/bin/env node
/**
 * Probe: the three install routes serve THE SAME THING.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C2, and the oldest named gap in this repository: every one of the three routes has been
 * verified on its own — `probe-dsh-plugin-{npm,github,tarball}.log` are three separate readings with
 * the same criteria — and **nothing asserted that they agree**. "Three commands run three times" is
 * not a check; it is a habit. The difference matters because the routes fetch from three different
 * places (the default branch, the registry, the Release asset), so they can disagree, and the way they
 * disagree is quiet: each one reports success about a different product.
 *
 * WHAT IT MEASURES
 * ----------------
 * It runs the existing probe three times — one per route — and compares the readings:
 *
 *   installed version     must be IDENTICAL across the three, and equal to `deepblend/version.json`.
 *                         The repository's own statement of what it is is the third opinion, and a
 *                         Release and a registry that agree with each other while disagreeing with
 *                         `main` is exactly the failure this catches.
 *   workbench route       `GET /deepblend/workbench` must answer HTTP 200 on all three. The version
 *                         number is what an artifact says about itself; this route is what only the
 *                         CURRENT version has, so a stale artifact answers 404 while claiming an old
 *                         version honestly.
 *   presets deployed      the same preset ids, byte-identical to `deepblend/presets/`.
 *   packages pnpm fetched AND ONE READING THAT MUST DIFFER: 7 / 7 / 1. The tarball carries its
 *                         siblings inside the artifact; the other two resolve them. Asserting the
 *                         difference is what stops "they agree" from meaning "nothing was measured".
 *
 * WHY IT IS NOT IN THE CONTRACT LAYER
 * -----------------------------------
 * It needs the network and pnpm — the contract layer promises to need neither, and runs in CI on
 * every push. This belongs to the release family, next to the four steps it verifies.
 *
 * Usage:
 *   npm run release:parity | tee deepblend/docs/probe-route-parity.log
 *
 * Exit codes: 0 = the three routes agree and match the repository, 1 = they do not,
 *             2 = a route could not be measured at all (no pnpm, no network, no Release).
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C2)
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ROUTES as BASE_ROUTES, READING_LABELS, compareRoutes, reading, repositoryVersion } from './route-parity.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const PROBE = join(HERE, 'dsh-plugin-install-probe.mjs')

/**
 * The three routes, in the order the manual lists them, each with the spec that selects it.
 *
 * `DEEPBLEND_PARITY_<ID>_SPEC` overrides one route's spec, and it exists for ONE reason: to show this
 * check can fail. A comparison that has never been seen to report a disagreement is a comparison
 * nobody has tested — so the negative control points one route at an older published version and the
 * check must say so:
 *
 *   DEEPBLEND_PARITY_NPM_SPEC='@deepblend/dsh-blender-bundle@0.2.1' npm run release:parity
 */
const ROUTES = BASE_ROUTES
  .map(route => ({ ...route, spec: process.env[`DEEPBLEND_PARITY_${route.id.toUpperCase()}_SPEC`] ?? route.spec }))

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

say('date', new Date().toISOString())
say('repository version', repositoryVersion(ROOT))
say('note', 'each route is installed once, in its own scratch DSH_HOME, and read back')

// The tarball route's URL is version-free by design, so pnpm's store is keyed by a string that does
// not change between releases — a machine that installed the previous one is handed the previous
// artifact. An EMPTY store is what makes this reading a reading about the current release.
const store = mkdtempSync(join(tmpdir(), 'deepblend-parity-store-'))
const readings = []

try {
  for (const route of ROUTES) {
    console.log(`\n── ${route.id}: ${route.spec} ──`)
    const run = spawnSync(process.execPath, [PROBE, '--spec', route.spec], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_store_dir: store,
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    // The probe prints its own verdict; echoing it keeps this log readable on its own.
    for (const line of output.split('\n').filter(entry => /^(installed version|workbench route|packages pnpm fetched|presets deployed|result):/.test(entry))) {
      console.log(`   ${line}`)
    }

    const entry = {
      id: route.id,
      status: run.status,
      version: reading(output, READING_LABELS.version),
      workbench: reading(output, READING_LABELS.workbench),
      fetched: reading(output, READING_LABELS.fetched),
      presets: reading(output, READING_LABELS.presets),
      verdict: reading(output, READING_LABELS.verdict),
    }
    readings.push(entry)

    if (run.status !== 0) problem(`${route.id}: the probe exited ${run.status} — ${entry.verdict ?? 'no verdict line'}`)
    if (entry.version === null) problem(`${route.id}: the probe reported no installed version`)
  }
} finally {
  rmSync(store, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// The comparison itself, which is the whole point of this tool.
// ---------------------------------------------------------------------------
console.log('\n── do the three routes agree? ──')
const expectedVersion = repositoryVersion(ROOT)
const comparison = compareRoutes({ readings, routes: ROUTES, expected: expectedVersion })
for (const line of comparison.lines) {
  report.push(line)
  console.log(line)
}
for (const entry of comparison.problems) problem(entry)

say('problems', problems.length)
say('result', problems.length === 0
  ? 'the three install routes serve the same product, and it is the one this repository is'
  : `${problems.length} reading(s) say the three routes do not agree`)
process.exit(problems.length === 0 ? 0 : 1)
