#!/usr/bin/env node
/**
 * Link the workspace's `node_modules` to the DSH deployment that is installed.
 *
 * WHY THIS EXISTS
 * ---------------
 * `node_modules/` is git-ignored on purpose: in this repository it holds no
 * content, only absolute symlinks into the deployment (see `.gitignore`). The
 * consequence is that a fresh clone cannot resolve a single one of its own
 * imports, and **every contract suite fails before it runs an assertion**:
 *
 *     $ node deepblend/tests/run.mjs
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepblend/dsh-blender-contracts'
 *     DeepBlend tests: 0/16 file(s) passed
 *
 * That is not hypothetical — it is what this repository did on 2026-09-14, after
 * the DSH profile was reinstalled. Sixteen green suites became sixteen import
 * errors, and nothing in the tree said how to get back. This script is that
 * missing step: **the reproducibility gap the `.gitignore` comment described was
 * covered by a document, and a document is not a step.**
 *
 * WHY THE LINKS ARE DERIVED AND NOT DECLARED
 * ------------------------------------------
 * The obvious fix — put `@deepseek-ai/cordis` and friends in a `package.json` —
 * is the one this repository deliberately rejects, for the reason written out in
 * `tests/lib/dsh-deployment.mjs`: it would install a SECOND copy of the harness
 * inside the repository, free to drift from the deployment that actually runs
 * DeepBlend. A contract suite would then be green against a cordis the product
 * does not load.
 *
 * So the links are derived from the installed deployment instead of from a
 * registry, and the specifiers to link are **read out of this repository's own
 * source** (`workspace-layout.mjs`) rather than listed here. A new
 * `import '@deepseek-ai/dsh-whatever'` therefore only ever needs this script
 * re-run; it never needs this file edited.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   node_modules/@deepseek-ai/<pkg>   ->  <deployment>/node_modules/@deepseek-ai/<pkg>
 *   node_modules/@deepblend/<pkg>     ->  packages/deepblend/<dir>
 *
 * Nothing else. It never writes into the DSH installation, and it never writes
 * into `$DSH_HOME` — the profile-plane links are `install-plugin.mjs`'s job and
 * the presets are `install-presets.mjs`'s.
 *
 * Usage:
 *   node deepblend/tools/link-workspace.mjs            # link, then verify by importing
 *   node deepblend/tools/link-workspace.mjs --check    # report drift, change nothing
 *
 * Exit codes: 0 = linked and every specifier imports, 1 = drift or a failed import,
 *             2 = no DSH deployment, no source to scan, or a package the deployment
 *                 does not contain.
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDshScope } from '../tests/lib/dsh-deployment.mjs'
import {
  PACKAGES,
  SCANNED_DIRECTORIES,
  linkPathFor,
  linkTarget,
  localPackages,
  requiredSpecifiers,
} from './workspace-layout.mjs'

/** Print one `label: value` line, matching the other tools' output shape. */
function say(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

const checkOnly = process.argv.includes('--check')

// ---------------------------------------------------------------------------
// Locate the deployment first. A missing one is a hard, named failure: every
// suite would fail anyway, and an unclear error here is the thing this script
// exists to delete.
// ---------------------------------------------------------------------------
let scope
try {
  scope = resolveDshScope()
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(2)
}
say('dsh scope', scope)

const local = localPackages()
if (local.size === 0) {
  console.error(`no local packages found under ${PACKAGES}`)
  process.exit(2)
}

const { external, internal, declarations } = requiredSpecifiers(local)
if (external.length === 0 && internal.length === 0) {
  console.error(`no scoped import specifiers found under ${SCANNED_DIRECTORIES.join(', ')}`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Plan. Every link is absolute, because a relative one would break the moment a
// package is reached through a second path — the profile links these same
// packages, and Node resolves the realpath.
// ---------------------------------------------------------------------------
/** Where each specifier has to point, and who asked for it. */
const wanted = [
  ...internal.map(specifier => ({ specifier, target: local.get(specifier), declaredBy: declarations.get(specifier) })),
  ...external.map(specifier => ({
    specifier,
    target: join(scope, specifier.split('/')[1]),
    declaredBy: declarations.get(specifier),
  })),
]

const plan = wanted.map(entry => {
  const current = linkTarget(linkPathFor(entry.specifier))
  const action = current === entry.target
    ? 'in sync'
    : !existsSync(entry.target)
      ? 'TARGET MISSING'
      : current === undefined ? 'missing' : 'DRIFTED'
  return { ...entry, current, action }
})

for (const entry of plan) {
  if (entry.action === 'in sync') {
    say(entry.specifier, 'in sync')
    continue
  }
  if (entry.action === 'TARGET MISSING') {
    console.error(`${entry.specifier}: ${entry.target} does not exist (asked for by ${entry.declaredBy})`)
    continue
  }
  say(entry.specifier, `${entry.action} (asked for by ${entry.declaredBy})`)
}

const missingTargets = plan.filter(entry => entry.action === 'TARGET MISSING')
const drifted = plan.filter(entry => entry.action === 'missing' || entry.action === 'DRIFTED')

if (missingTargets.length > 0) {
  say('result', `${missingTargets.length} package(s) are not in the deployment at ${scope}`)
  say('fix', 'install the DSH package that provides them, or set DEEPBLEND_DSH_ROOT to another deployment')
  process.exit(2)
}

if (checkOnly) {
  if (drifted.length === 0) {
    say('result', `the workspace resolves all ${plan.length} package(s) from the deployment`)
    process.exit(0)
  }
  say('result', `${drifted.length} of ${plan.length} link(s) are not in place`)
  say('fix', 'node deepblend/tools/link-workspace.mjs')
  process.exit(1)
}

for (const entry of drifted) {
  const linkPath = linkPathFor(entry.specifier)
  mkdirSync(join(linkPath, '..'), { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(entry.target, linkPath)
}

say('linked', drifted.length)

// ---------------------------------------------------------------------------
// Verify by importing. A symlink that exists is not a resolution that works — a
// package can be linked and still lack the entry point Node asks for, and that is
// exactly the state in which the suites fail with ERR_MODULE_NOT_FOUND.
// ---------------------------------------------------------------------------
let failed = 0
for (const entry of plan) {
  try {
    await import(entry.specifier)
  } catch (error) {
    failed += 1
    console.error(`✗ ${entry.specifier}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

say('resolved', `${plan.length - failed}/${plan.length}`)
if (failed > 0) {
  say('result', `${failed} package(s) are linked but do not import`)
  process.exit(1)
}

say('note', 'node_modules holds only absolute links into the deployment; it is git-ignored and costs no disk')
console.log(`✓ the workspace resolves ${plan.length} package(s) from the DSH deployment`)
console.log('  next: node deepblend/tests/run.mjs   (unit + contract, no Blender required)')
