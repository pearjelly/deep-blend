#!/usr/bin/env node
/**
 * Workspace setup contract test.
 *
 * WHY THIS EXISTS
 * ---------------
 * This repository's `node_modules/` is git-ignored, because it holds no content:
 * twelve absolute symlinks into the installed DSH deployment and into our own
 * `packages/`. A fresh clone therefore resolves NOTHING, and the failure mode is
 * the worst kind — every suite dies on `ERR_MODULE_NOT_FOUND` before evaluating
 * an assertion, so the suite is not "failing", it is *not running*:
 *
 *     $ node deepblend/tests/run.mjs
 *     DeepBlend tests: 0/16 file(s) passed
 *
 * That is exactly what happened on 2026-09-14, when a reinstalled DSH profile
 * left the links gone. Sixteen green suites became sixteen import errors, and
 * every one of them was green in CI-less local development ten minutes earlier.
 *
 * `tools/link-workspace.mjs` is the fix. This file is what keeps the fix true,
 * by asserting the four things the setup promises and nothing in the repository
 * could otherwise notice:
 *
 *   1. **Every scoped specifier in the source resolves.** New code that imports
 *      a package nobody linked fails HERE, naming the file that asked for it,
 *      instead of in whichever suite happens to import that module first.
 *   2. **Every link is a link.** A "setup" that copies a package into the tree
 *      would satisfy (1) while creating the second, drifting copy of the
 *      harness that `tests/lib/dsh-deployment.mjs` exists to prevent.
 *   3. **The setup step is committed.** A linker that is itself git-ignored is
 *      no use to the clone that needs it.
 *   4. **The step is discoverable.** `npm run setup` is the documented entry
 *      point; a script nobody can find is the gap this whole file is about.
 *
 * Run: node deepblend/tests/contract/workspace-links.test.mjs
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { deploymentScopes, resolveHarnessScope } from '../lib/dsh-deployment.mjs'
import {
  PACKAGES,
  ROOT,
  linkPathFor,
  linkTarget,
  localPackages,
  requiredSpecifiers,
} from '../../tools/workspace-layout.mjs'

const local = localPackages()
const { external, internal, declarations } = requiredSpecifiers(local)
const everySpecifier = [...internal, ...external]

/** The deployment this workspace is linked against. */
const scope = resolveHarnessScope()

/**
 * Two assertions below are about what a CLONE can do, so they need a checkout.
 * A tarball has no `.git`, and skipping loudly beats failing for a reason that
 * is not about the code — but it is a skip, never a silent pass.
 */
const checkout = existsSync(join(ROOT, '.git'))
const withoutCheckout = checkout ? false : 'not a git checkout'

test('the source names packages to link, and every one of them is classified', () => {
  assert.ok(everySpecifier.length > 0, 'the scan found no scoped specifiers at all — the scanner is broken, not the tree')

  // A `@deepblend/*` specifier that is not a local package would fall through the
  // classifier and be linked from nowhere. Catching it here means a renamed
  // package fails with the name that no longer matches a directory.
  for (const specifier of internal) {
    assert.ok(local.has(specifier), `${specifier} is imported but no packages/deepblend/* declares that name`)
  }

  assert.equal(
    local.size,
    [...local.keys()].length,
    'two local packages declare the same name',
  )
})

for (const specifier of everySpecifier) {
  test(`${specifier} resolves from the repository root`, () => {
    // `import.meta.resolve` answers the Loader's question without executing the
    // module: a package that resolves but throws on evaluation is a different
    // defect, owned by contract/imports.test.mjs.
    const resolved = import.meta.resolve(specifier)
    assert.ok(
      resolved.startsWith('file:'),
      `${specifier} did not resolve to a file (got ${resolved}) — run: node deepblend/tools/link-workspace.mjs`,
    )
    assert.ok(existsSync(new URL(resolved)), `${specifier} resolved to ${resolved}, which does not exist`)
  })

  test(`${specifier} is reachable through a symbolic link, not a copy`, () => {
    const linkPath = linkPathFor(specifier)
    const target = linkTarget(linkPath)

    assert.notEqual(
      target,
      undefined,
      `${linkPath} is missing — asked for by ${declarations.get(specifier)}; run: node deepblend/tools/link-workspace.mjs`,
    )
    assert.notEqual(
      target,
      null,
      `${linkPath} exists but is not a symbolic link. Setup must not copy packages into the tree: a second copy of the \
harness is free to drift from the deployment that actually runs DeepBlend (see tests/lib/dsh-deployment.mjs).`,
    )

    if (internal.includes(specifier)) {
      assert.equal(target, local.get(specifier), `${specifier} points at ${target}, not at the package that declares it`)
      return
    }

    // Everything else has to come from THE DEPLOYMENT, so that a suite is never green against a
    // cordis the product does not load. The deployment is a LIST of scope directories rather than
    // one — MEASURED: a global install nests the harness's dependencies under the package and puts
    // anything installed alongside it in the scope directory above, and this repository imports five
    // packages from the first and `dsh-subprocess-local` from the second. This assertion used to
    // require the single nested directory, which made the correct link look like a copy.
    const insideDeployment = deploymentScopes().some(directory => target.startsWith(directory + sep))
    assert.ok(
      insideDeployment,
      `${specifier} points at ${target}, outside every scope directory of the running deployment ` +
      `(${deploymentScopes().join(', ')})`,
    )
  })
}

test('the two package sets the linker distinguishes are both non-empty', () => {
  // If either set were empty the loop above would pass vacuously, which is the
  // shape of a suite that goes green because it stopped looking.
  assert.ok(internal.length >= 6, `expected the six @deepblend packages, found ${internal.length}`)
  assert.ok(external.length >= 1, `expected at least one @deepseek-ai package, found ${external.length}`)
})

test('the repository ships the step that produces these links', { skip: withoutCheckout }, () => {
  for (const file of ['deepblend/tools/link-workspace.mjs', 'deepblend/tools/workspace-layout.mjs']) {
    const path = join(ROOT, file)
    assert.ok(existsSync(path), `${file} is missing, so a fresh clone has no way to link its workspace`)

    // Committed, not merely present: a git-ignored linker is no use to the clone
    // that needs it, and this is the assertion that would have caught the gap.
    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', relative(ROOT, path)], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    assert.equal(tracked, file, `${file} is not tracked by git`)
  }
})

test('a deployment split across two scope directories is found, and each package comes from its own', () => {
  // THE LAYOUT A GLOBAL INSTALL ACTUALLY PRODUCES, which the single-scope model could not describe.
  // MEASURED on a clean machine: `npm install -g @deepseek-ai/dsh@<pin> <two more>` puts the harness's
  // dependencies in `<dsh>/node_modules/@deepseek-ai/` (120 packages) and everything installed
  // alongside it in the scope directory ABOVE the package. Five of this repository's six imports come
  // from the first and `dsh-subprocess-local` from the second — so a resolver that returns one
  // directory is wrong about one of them, and the candidate for the second was misspelled
  // (`…/@deepseek-ai/@deepseek-ai`) so it matched nothing on any machine.
  //
  // The fixture builds that exact shape and runs the resolver in a CHILD process, because the scopes
  // are memoized per process and `which dsh` is read from PATH.
  const root = mkdtempSync(join(tmpdir(), 'deepblend-split-scope-'))
  try {
    const bin = join(root, 'bin')
    const harness = join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    const nested = join(harness, 'node_modules', '@deepseek-ai')
    const above = join(root, 'lib', 'node_modules', '@deepseek-ai')
    for (const [directory, name] of [
      [join(nested, 'cordis'), 'cordis'],
      [join(nested, 'dsh-llm'), 'dsh-llm'],
      [join(above, 'dsh-subprocess-local'), 'dsh-subprocess-local'],
    ]) {
      mkdirSync(join(directory, 'lib'), { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0' }))
    }
    mkdirSync(join(harness, 'lib'), { recursive: true })
    writeFileSync(join(harness, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }))
    // EXECUTABLE, or `which` skips it and the fixture silently tests the real deployment instead —
    // MEASURED: the first version of this test did exactly that and failed with the machine's own
    // nvm scope in the "actual" slot.
    writeFileSync(join(harness, 'lib', 'bin.js'), '// a stand-in for the launcher\n')
    chmodSync(join(harness, 'lib', 'bin.js'), 0o755)
    mkdirSync(bin, { recursive: true })
    symlinkSync(join(harness, 'lib', 'bin.js'), join(bin, 'dsh'))

    const script = `
      import { deploymentScopes, resolveDshScope } from ${JSON.stringify(pathToFileURL(join(ROOT, 'deepblend', 'tests', 'lib', 'dsh-deployment.mjs')).href)}
      const scopes = deploymentScopes()
      console.log(JSON.stringify({
        scopes: scopes.length,
        cordis: resolveDshScope('cordis'),
        subprocessLocal: resolveDshScope('dsh-subprocess-local'),
      }))
    `
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEEPBLEND_DSH_ROOT: '' },
    })
    assert.equal(probe.status, 0, `the resolver failed on a split deployment:\n${probe.stderr}`)
    const reading = JSON.parse(probe.stdout.trim().split('\n').pop())

    // At least two: the fixture's two, plus whatever this checkout itself resolves (the repository's
    // own scope is a candidate too). What matters is that BOTH of the fixture's are reachable.
    assert.ok(reading.scopes >= 2, `a split deployment must be seen as more than one scope directory, saw ${reading.scopes}`)
    // Canonicalised, because the resolver realpaths the launcher it found: on macOS `/var` is a
    // symlink to `/private/var`, so comparing the raw fixture paths compares two spellings of one
    // directory.
    assert.equal(reading.cordis, realpathSync(nested), 'a package the harness nests must come from the nested scope')
    assert.equal(reading.subprocessLocal, realpathSync(above), 'a package installed alongside the harness must come from the scope above it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the setup step is discoverable from the repository root', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts?.setup, 'node deepblend/tools/link-workspace.mjs')
  assert.equal(manifest.scripts?.test, 'node deepblend/tests/run.mjs')
  // The README's quick start is written against these two; a rename of either
  // breaks the documented path without breaking any other assertion here.
  const readme = readFileSync(join(ROOT, 'README.zh.md'), 'utf8')
  assert.ok(readme.includes('npm run setup'), 'the README no longer tells a fresh clone how to link its workspace')
})

test('the links are git-ignored, so no clone ever commits a path into someone else installation', { skip: withoutCheckout }, () => {
  const ignored = execFileSync('git', ['check-ignore', 'node_modules'], { cwd: ROOT, encoding: 'utf8' }).trim()
  assert.equal(ignored, 'node_modules')

  // And the local packages are NOT ignored — the links point at them, so they
  // must be in the clone.
  const packagesTracked = execFileSync('git', ['ls-files', '--error-unmatch', relative(ROOT, PACKAGES)], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
  assert.ok(packagesTracked.startsWith('packages/deepblend/'))
})

test('check mode agrees with the tree it just inspected', () => {
  // The one assertion that runs the shipped command end to end. `--check` is
  // what a contributor runs before blaming their own change, so it must exit 0
  // on a workspace that this test just proved resolvable.
  const output = execFileSync('node', [join(ROOT, 'deepblend', 'tools', 'link-workspace.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.match(output, /result: the workspace resolves all \d+ package\(s\) from the deployment/)
  assert.doesNotMatch(output, /DRIFTED|not installed|TARGET MISSING/)
})
