#!/usr/bin/env node
/**
 * Walk the install path on a machine that has never seen this project.
 *
 * WHY THIS EXISTS
 * ---------------
 * `install.md` has four steps and each one had been proven individually — from THIS
 * repository, on THIS machine, with a `$DSH_HOME` that already had DeepBlend in it.
 * Nobody had ever run them in order from a clean clone against a clean home, and the
 * difference between "four steps each work" and "the sequence works" turned out to be
 * real: measured on 2026-09-14, step 3 failed with
 *
 *     no profile at /tmp/db-freshhome/profiles/web
 *     known profiles: (none)
 *
 * because a profile is created by `dsh`, not by the installer, and the manual's
 * prerequisites did not say so. Every script was right; the assumption BETWEEN them
 * was undocumented. That is the same shape as the other gaps this milestone closed —
 * a step that exists only as prose in someone's head (D71) — and the answer is the
 * same: make it a command.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 * ------------------------------------
 * It proves the documented path is walkable: clone, the four steps in order, and the
 * contract suite green afterwards. It does NOT re-download Blender unless asked
 * (`--with-blender`), because 346 MB per run is a real cost for a check whose
 * download-and-verify behaviour is already asserted elsewhere. And it never touches
 * the developer's own `$DSH_HOME` — every step runs against a scratch home under the
 * temp directory, so a run cannot re-point a working deployment at a throwaway clone.
 *
 * Usage:
 *   node deepblend/tools/verify-clean-clone.mjs                 # clone, four steps, contract suite
 *   node deepblend/tools/verify-clean-clone.mjs --with-blender  # also install Blender and run everything
 *   node deepblend/tools/verify-clean-clone.mjs --keep          # leave the clone for inspection
 *   node deepblend/tools/verify-clean-clone.mjs --source <path> # clone from somewhere other than origin
 *
 * Exit codes: 0 = the documented path worked, 1 = a step failed, 2 = the environment
 *             cannot run it (no git, no dsh).
 *
 * Owner: DeepBlend Studio — M5
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const REPO = resolve(HERE, '..', '..')

const keep = process.argv.includes('--keep')
const withBlender = process.argv.includes('--with-blender')
const sourceIndex = process.argv.indexOf('--source')
const source = sourceIndex === -1 ? REPO : resolve(process.argv[sourceIndex + 1] ?? REPO)

function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/**
 * Run one step in the clone, with a scratch home, and return its combined output.
 * @param {string[]} argv
 * @param {{ cwd: string, home: string, label: string }} context
 * @returns {{ ok: boolean, output: string, status: number|null }}
 */
function step(argv, context) {
  console.log(`\n── ${context.label} ──`)
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: context.cwd,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: context.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // The last few lines are the step's own summary; printing the whole of a 346 MB
  // download's progress would bury the report this script exists to produce.
  for (const line of output.trim().split('\n').slice(-4)) console.log(`   ${line}`)
  return { ok: result.status === 0, output, status: result.status }
}

// ---------------------------------------------------------------------------
// The environment this needs, checked before anything is created.
// ---------------------------------------------------------------------------
for (const command of ['git', 'dsh']) {
  const probe = spawnSync('which', [command], { encoding: 'utf8' })
  if (probe.status !== 0) {
    console.error(`this verifies the install path with \`${command}\`, which is not on PATH`)
    process.exit(2)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-clean-clone-'))
const clone = join(scratch, 'clone')
const home = join(scratch, 'home')

say('source', source)
say('scratch', scratch)
say('note', 'every step runs against this scratch DSH_HOME; the developer\'s own is never touched')

const failures = []
function record(label, result) {
  if (!result.ok) failures.push(`${label} (exit ${result.status})`)
}

try {
  // -------------------------------------------------------------------------
  // 0. A clean clone.
  // -------------------------------------------------------------------------
  const cloned = step(['git', 'clone', '--quiet', source, clone], { cwd: scratch, home, label: 'clone' })
  record('clone', cloned)
  if (!cloned.ok) throw new Error('the clone itself failed, so nothing below would mean anything')

  // -------------------------------------------------------------------------
  // The prerequisite the first walk found: a profile is dsh's to create.
  //
  // `dsh --profile web --dump-config` composes the tree and creates the profile as a
  // side effect. MEASURED on an empty home; this is why `install.md` §0 now lists it.
  // -------------------------------------------------------------------------
  const initialised = step(['dsh', '--profile', 'web', '--dump-config'], { cwd: clone, home, label: 'initialise the profile (dsh creates it, not the installer)' })
  record('initialise the profile', initialised)
  if (!initialised.ok) throw new Error('no profile could be initialised, so the install steps have nothing to install into')

  // -------------------------------------------------------------------------
  // The four documented steps, in the documented order.
  // -------------------------------------------------------------------------
  record('setup', step(['node', join(clone, 'deepblend/tools/link-workspace.mjs')], { cwd: clone, home, label: '1. npm run setup' }))
  record('setup:check', step(['node', join(clone, 'deepblend/tools/link-workspace.mjs'), '--check'], { cwd: clone, home, label: '1b. npm run setup:check' }))

  if (withBlender) {
    record('blender:install', step(['node', join(clone, 'deepblend/tools/install-blender.mjs')], { cwd: clone, home, label: '2. npm run blender:install' }))
  } else {
    console.log('\n── 2. npm run blender:install — SKIPPED ──')
    console.log('   (346 MB; pass --with-blender to include it. Everything below still runs.)')
  }

  record('plugin:install', step(['node', join(clone, 'deepblend/tools/install-plugin.mjs')], { cwd: clone, home, label: '3. npm run plugin:install' }))
  record('plugin:check', step(['node', join(clone, 'deepblend/tools/install-plugin.mjs'), '--check'], { cwd: clone, home, label: '3b. npm run plugin:check' }))
  record('presets:install', step(['node', join(clone, 'deepblend/tools/install-presets.mjs')], { cwd: clone, home, label: '4. npm run presets:install' }))
  record('presets:check', step(['node', join(clone, 'deepblend/tools/install-presets.mjs'), '--check'], { cwd: clone, home, label: '4b. npm run presets:check' }))

  // -------------------------------------------------------------------------
  // And the tree it produced actually composes.
  // -------------------------------------------------------------------------
  const composed = step(['dsh', '--profile', 'web', '--dump-config'], { cwd: clone, home, label: 'the installed profile composes' })
  record('composition', composed)
  const rows = (composed.output.match(/deepblend-blender-(runtime|host|ui)/g) ?? [])
  say('deepblend rows composed', [...new Set(rows)].length)
  if (new Set(rows).size !== 3) failures.push('the composed tree does not carry all three DeepBlend rows')

  // -------------------------------------------------------------------------
  // Finally: does the thing it installed actually pass its own tests?
  // -------------------------------------------------------------------------
  record('contract suite', step(['node', join(clone, 'deepblend/tests/run.mjs')], { cwd: clone, home, label: 'the contract suite, in the clone' }))

  if (withBlender) {
    record('acceptance suite', step(['bash', join(clone, 'deepblend/tests/run-all.sh')], { cwd: clone, home, label: 'the full acceptance suite, in the clone' }))
  }
} catch (error) {
  console.error(`\n${error.message}`)
}

console.log('')
if (failures.length === 0) {
  if (!keep) rmSync(scratch, { recursive: true, force: true })
  else say('kept', scratch)
  console.log('✓ the documented install path works from a clean clone against a clean DSH_HOME')
  if (!withBlender) console.log('  (Blender was skipped; re-run with --with-blender for the full path)')
  process.exit(0)
}

// A failed run keeps its scratch by default: the whole point of failing is that
// somebody has to look at the half-installed state, and deleting the evidence to be
// tidy would make the next run reproduce the work instead of the diagnosis.
say('kept for inspection', scratch)
console.log(`✗ the documented path failed at: ${failures.join(', ')}`)
process.exit(1)
