#!/usr/bin/env node
/**
 * Build the SELF-CONTAINED release tarball the plugin list accepts as its third install route.
 *
 * WHY THIS EXISTS
 * ---------------
 * The list accepts three ways to install a plugin, and this repository's entry only
 * exercised one of them:
 *
 *   1. FROM SOURCE   `github:pearjelly/deep-blend#path:/packages/deepblend/bundle` — works,
 *                    because pnpm resolves a `github:` spec through an anonymous codeload
 *                    tarball and the repository is public.
 *   2. FROM npm      needs six published packages. Not published: this machine has no npm
 *                    credentials and no `@deepblend` scope, so this route is blocked on an
 *                    account rather than on code.
 *   3. FROM A TARBALL — this file. It needs a SELF-CONTAINED artifact, and "self-contained"
 *                    is the whole difficulty: a tarball of the bundle alone still declares
 *                    six dependencies, so installing it would go back to the network for
 *                    packages that are not on any registry.
 *
 * HOW SELF-CONTAINMENT IS ACHIEVED, AND WHY IT IS NOT A BUNDLER
 * -------------------------------------------------------------
 * npm has carried the mechanism for this since before pnpm existed: **bundled
 * dependencies**. A package may ship its dependencies inside its own tarball and list them
 * under `bundledDependencies`; an installer then uses the copies in the tarball and never
 * resolves the specs.
 *
 * MEASURED, because the whole design rests on it and it is not obvious (pnpm 10.28.2, a
 * synthetic two-package pair, then this one):
 *
 *   - pnpm installs a tarball that carries `node_modules/@probe/leaf` and lists it under
 *     `bundledDependencies`, and `require('@probe/outer')` resolves the bundled copy;
 *   - it reports `Packages: +1` — it fetched the OUTER package and nothing else;
 *   - it still does this when the bundled dependency's spec is `9.9.9-does-not-exist`.
 *
 * That last line is the load-bearing one. It means the shipped manifest may declare the
 * siblings at their real versions (`0.1.0`) even though no registry has them, so the
 * artifact needs no network at all and the manifest tells the truth about what it carries.
 *
 * So no source is rewritten, no module is inlined, and there is no bundler: the repository
 * keeps one copy of every fact, and the vendored `node_modules` exists only inside a
 * throwaway staging directory that is never committed.
 *
 * THE TWO RULES THE MARKET ENFORCES, AND WHY THEY ARE RULES HERE TOO
 * -----------------------------------------------------------------
 * `scripts/lib/entries.mjs::tarballProblem` refuses a tarball URL unless it is https, on a
 * GitHub releases host, and ends in `.tgz` or `.tar.gz`. And `scripts/probe-tarballs.mjs`
 * separately WARNS about the failure mode that has bitten this list before:
 *
 *   A tarball whose URL contains its version and resolves `latest` at request time works
 *   today and 404s on the author's next release.
 *
 * `latest/download/` takes the filename literally, so an asset named
 * `deepblend-bundle-0.1.0.tgz` is reachable exactly until the next release. The asset name
 * is therefore VERSION-FREE — `deepblend-bundle.tgz` — and every release attaches that same
 * name. The version lives in the tag, where nothing resolves it by name.
 *
 * Usage:
 *   node deepblend/tools/build-release-tarball.mjs            # build into .tmp-release/
 *   node deepblend/tools/build-release-tarball.mjs --check    # assert the naming rules, build nothing
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './workspace-layout.mjs'

/** The bundle's package directory: the one an install mounts. */
const BUNDLE = join(ROOT, 'packages', 'deepblend', 'bundle')

/** Where the six siblings live, and the scope they are published under. */
const PACKAGES_DIRECTORY = join(ROOT, 'packages', 'deepblend')
const SCOPE = '@deepblend'

/**
 * The asset name, and the whole of the version-free rule.
 *
 * No `0.1.0`, no `v1`, no digits at all: `release-assets` are addressed by name under
 * `/releases/latest/download/`, so a name carrying a version is a URL that dies at the next
 * release. `--check` fails if a version appears here, which is the only way this stays true
 * once somebody is tempted to make the filename "more informative".
 */
export const ASSET_NAME = 'deepblend-bundle.tgz'

/** The URL the entry's `tarball` key declares, derived from the asset name. */
export const TARBALL_URL = `https://github.com/pearjelly/deep-blend/releases/latest/download/${ASSET_NAME}`

/** Where the built artifact and its staging directory go. Git-ignored. */
const OUT_DIRECTORY = join(ROOT, '.tmp-release')

/**
 * The bundle's directory name, and the one package that is NOT bundled.
 *
 * It is the artifact: its manifest becomes the tarball's manifest and its files sit at the
 * tarball's root. Everything else under `packages/deepblend` is a sibling the profile needs
 * and the artifact must therefore carry.
 */
const BUNDLE_DIRECTORY = 'bundle'

/**
 * Every package under `packages/deepblend`, with the three facts this build needs.
 *
 * The DIRECTORY and the package NAME are different strings (`bundle` vs
 * `@deepblend/dsh-blender-bundle`) and both are needed: the directory names the path inside
 * the repository, the name is what a manifest declares and what the Loader resolves.
 *
 * @returns {Array<{directory: string, name: string, version: string}>}
 */
export function localPackages() {
  return readdirSync(PACKAGES_DIRECTORY)
    .filter(directory => existsSync(join(PACKAGES_DIRECTORY, directory, 'package.json')))
    .sort()
    .map((directory) => {
      const manifest = JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, directory, 'package.json'), 'utf8'))
      return { directory, name: manifest.name, version: manifest.version }
    })
}

/** The packages the artifact must CARRY: everything except the bundle, which is the artifact. */
export function bundledPackages() {
  return localPackages().filter(({ directory }) => directory !== BUNDLE_DIRECTORY)
}

/** Run a command in a directory and return its combined output, without throwing. */
function run(command, args, cwd) {
  const outcome = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { status: outcome.status, output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim() }
}

/** The commit this artifact is built from, or a refusal. */
function releaseCommit(allowDirty) {
  const head = run('git', ['rev-parse', 'HEAD'], ROOT)
  if (head.status !== 0) {
    console.error('not a git checkout, so there is no commit to build a reproducible artifact from')
    process.exit(2)
  }
  const commit = head.output.trim()
  const dirty = run('git', ['status', '--porcelain'], ROOT).output
  if (dirty !== '' && !allowDirty) {
    // A release artifact is a claim about a COMMIT. Building one from a working tree that
    // differs from every commit produces a tarball nobody can reproduce or audit, and the
    // failure is invisible — the install works, it is just not the code that was released.
    console.error(`${ROOT} has uncommitted changes, so this artifact would not correspond to any commit`)
    console.error('commit or stash them, or pass --allow-dirty if this is a local experiment')
    process.exit(2)
  }

  // AND THE COMMIT HAS TO BE ON THE REMOTE, which is not a formality: the staging install
  // fetches the siblings by `github:…#<commit>&path:…`, and codeload cannot serve a commit
  // nobody has pushed. Without this check the build dies inside pnpm with an empty error —
  // MEASURED, on the first clean-tree build of this very tool — and an empty pnpm error
  // reads like a network fault rather than "you have not pushed yet".
  run('git', ['fetch', 'origin', '--quiet'], ROOT)
  const containing = run('git', ['branch', '--remotes', '--contains', commit], ROOT).output
  if (containing === '') {
    console.error(`${commit.slice(0, 12)} is not on any remote branch, so pnpm cannot fetch it`)
    console.error('push it first — a release artifact has to correspond to a commit other people can fetch')
    process.exit(2)
  }
  return commit
}

/**
 * The staging manifest: the bundle's own, with its `github:` specs pinned to `commit` and
 * every sibling declared as bundled.
 *
 * The specs are pinned rather than left on the default branch for the same reason as the
 * clean-tree rule: `github:owner/repo#path:…` resolves to whatever the default branch holds
 * at install time, so an unpinned build silently mixes two commits into one artifact. The
 * pin is INSERTED into the spec the manifest already carries — `#path:…` becomes
 * `#<commit>&path:…` — rather than rebuilt from the package name, so the path stays the one
 * the bundle declares and this tool cannot disagree with it.
 */
export function stagingManifest(manifest, packages, commit) {
  const dependencies = {}
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    dependencies[name] = spec.startsWith('github:')
      ? spec.replace('#', `#${commit}&`)
      : spec
  }
  return {
    ...manifest,
    dependencies,
    // Every sibling the profile needs, not only the bundle's direct dependencies: the rows
    // the patch names are resolved by the Loader, not by Node, so a package that is nobody's
    // `dependencies` entry is still required at runtime.
    bundledDependencies: packages.map(({ name }) => name),
  }
}

/**
 * The shipped manifest: what the artifact actually carries, and nothing it has to fetch.
 *
 * Exported so the contract layer can assert the same property the npm route is asserted for
 * (`contract/plugin-install-path.test.mjs`): the manifest that leaves this repository names
 * its siblings at exact versions and carries no `github:` spec. Without that, the check only
 * happened at BUILD time — which needs the network, so it was a step an operator ran rather
 * than a case that runs on every push.
 *
 * Exact versions rather than a range, for the reason the publish tool gives: these seven are
 * released in lockstep, and a range would let a `0.1.0` bundle install a `0.1.4` host it was
 * never tested against.
 */
export function shippedManifest(manifest, packages) {
  const versions = {}
  for (const { name, version } of packages) versions[name] = version
  return { ...manifest, dependencies: versions }
}

/** Read the names of the entries inside a tarball. */
function tarballEntries(file) {
  const listing = run('tar', ['tzf', file], ROOT)
  if (listing.status !== 0) throw new Error(`could not read ${file}: ${listing.output}`)
  return listing.output.split('\n').filter(Boolean)
}

/** `--check`: the naming rules, asserted without building anything. */
function check() {
  let failures = 0
  const fail = (message) => {
    console.log(`FAIL: ${message}`)
    failures += 1
  }

  // Rule 1: no version in the asset name. This is the rule the market only WARNS about,
  // and the warning is why the list has a standing issue about dead tarballs.
  if (/\d+\.\d+/.test(ASSET_NAME)) {
    fail(`${ASSET_NAME} carries a version, so /releases/latest/download/ would 404 at the next release`)
  }
  if (!ASSET_NAME.endsWith('.tgz') && !ASSET_NAME.endsWith('.tar.gz')) {
    fail(`${ASSET_NAME} is not a .tgz or .tar.gz, which the market's tarballProblem refuses`)
  }

  // Rule 2: the URL is the one the market accepts — https, github.com, under /releases/.
  const url = new URL(TARBALL_URL)
  if (url.protocol !== 'https:') fail(`${TARBALL_URL} is not https`)
  if (url.hostname !== 'github.com') fail(`${TARBALL_URL} is not hosted on GitHub releases`)
  if (!url.pathname.includes('/releases/')) fail(`${TARBALL_URL} does not point at a GitHub release asset`)
  if (!url.pathname.includes('/releases/latest/download/')) {
    // Not a market rule, a repository one: `latest` is what makes a version-free name the
    // right answer. A tag-pinned URL would be correct with a versioned name, and would also
    // have to be edited into the entry at every release.
    fail(`${TARBALL_URL} is not a /releases/latest/download/ URL, so a version-free asset name buys nothing`)
  }

  // Rule 3: the six siblings are what "self-contained" means, so their number is not a
  // detail — a package that stops being bundled turns the artifact back into a network
  // install, and the install still succeeds, which is the worst way for it to be wrong.
  const packages = bundledPackages()
  if (packages.length < 6) fail(`only ${packages.length} packages under packages/deepblend, expected at least 6 to bundle`)

  console.log(failures === 0
    ? `result: ${ASSET_NAME} satisfies the release naming rules (${packages.length} packages bundled)`
    : `result: ${failures} problem(s)`)
  return failures === 0 ? 0 : 1
}

/** Build the artifact. */
function build(allowDirty) {
  const commit = releaseCommit(allowDirty)
  const packages = bundledPackages()
  const manifest = JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8'))
  const declared = new Set(Object.keys(manifest.dependencies ?? {}))
  const missing = packages.filter(({ name }) => !declared.has(name))
  if (missing.length > 0) {
    console.error(`${BUNDLE}/package.json does not depend on ${missing.map(({ name }) => name).join(', ')}, so the artifact would not carry them`)
    process.exit(2)
  }

  rmSync(OUT_DIRECTORY, { recursive: true, force: true })
  const stage = join(OUT_DIRECTORY, 'stage')
  mkdirSync(stage, { recursive: true })

  // 1. The bundle's own files, verbatim. The patch, the module and the manifest are the
  //    artifact; only the manifest is rewritten, and only to pin and to declare.
  for (const name of readdirSync(BUNDLE)) {
    if (name === 'node_modules') continue
    const from = join(BUNDLE, name)
    if (statSync(from).isFile()) copyFileSync(from, join(stage, name))
  }

  const pinned = stagingManifest(manifest, packages, commit)
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pinned, null, 2)}\n`)

  // 2. Fetch the siblings.
  //
  //    `hoisted` is not a preference: pnpm's default isolated linker leaves symlinks in
  //    `node_modules`, and a tarball of symlinks extracts into a `node_modules` full of
  //    dangling links — an install that succeeds and a bundle that cannot import anything.
  //
  //    `auto-install-peers=false` is the one that had to be MEASURED. pnpm installs peer
  //    dependencies by default, and these packages declare `@deepseek-ai/cordis`,
  //    `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` as peers — the DSH deployment
  //    the plugin runs inside, which no registry this build can reach carries. Leaving the
  //    default on fails the build with
  //
  //        ERR_PNPM_FETCH_404  GET …/@deepseek-ai%2Fdsh-type-meta: Not Found - 404
  //
  //    which names a package this repository has never heard of and reads like a broken
  //    dependency rather than a peer that is supposed to be absent. Turning it off is also
  //    the CORRECT model: a peer is provided by the consumer, so it must not be bundled.
  console.log(`staging ${packages.length} packages at ${commit.slice(0, 12)}…`)
  const install = run('pnpm', [
    'install',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--ignore-scripts',
    '--reporter=silent',
  ], stage)
  if (install.status !== 0) {
    console.error(`pnpm install failed in the staging directory:\n${install.output}`)
    process.exit(1)
  }

  // 3. Prove the fetch produced real directories before packing them. A missing sibling here
  //    is the difference between a self-contained artifact and one that 404s on install.
  const scopeDirectory = join(stage, 'node_modules', ...SCOPE.split('/'))
  const vendored = existsSync(scopeDirectory)
    ? readdirSync(scopeDirectory).filter(name => existsSync(join(scopeDirectory, name, 'package.json'))).sort()
    : []
  const absent = packages
    .filter(({ name }) => !vendored.includes(name.slice(`${SCOPE}/`.length)))
    .map(({ name }) => name)
  if (absent.length > 0) {
    console.error(`the staging install did not vendor: ${absent.join(', ')}`)
    process.exit(1)
  }
  for (const name of vendored) {
    // A symlink would survive `readdirSync` and die on extraction, which is the failure the
    // hoisted linker exists to avoid — so it is asserted rather than assumed.
    if (statSync(join(scopeDirectory, name)).isSymbolicLink()) {
      console.error(`${SCOPE}/${name} is a symlink; the tarball would extract into a dangling link`)
      process.exit(1)
    }
  }

  // 4. The shipped manifest declares the versions it carries, so nothing is left to resolve.
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(shippedManifest(pinned, packages), null, 2)}\n`)

  const pack = run('npm', ['pack', '--silent', '--pack-destination', OUT_DIRECTORY], stage)
  if (pack.status !== 0) {
    console.error(`npm pack failed:\n${pack.output}`)
    process.exit(1)
  }
  const produced = pack.output.split('\n').filter(Boolean).pop().trim()
  const artifact = join(OUT_DIRECTORY, ASSET_NAME)
  rmSync(artifact, { force: true })
  // RENAMED, not packed under its own name: `npm pack` names a tarball
  // `<name-without-scope>-<version>.tgz`, which is exactly the versioned filename the
  // market's probe warns about.
  run('mv', [join(OUT_DIRECTORY, produced), artifact], ROOT)

  // 5. Read the artifact back rather than trusting the pack. The rules the market enforces
  //    are about the URL, but the rules that make the URL MEAN anything are about what is
  //    inside: every sibling present, and no spec left that would send an installer back to
  //    the network.
  const entries = tarballEntries(artifact)
  const inside = entries.filter(entry => entry.startsWith('package/node_modules/'))
  const shipped = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
  const unpinned = Object.entries(shipped.dependencies).filter(([, spec]) => spec.startsWith('github:'))

  console.log(`built: ${artifact.replace(`${ROOT}/`, '')}`)
  console.log(`  commit:    ${commit}`)
  console.log(`  files:     ${entries.length} (${inside.length} under node_modules)`)
  console.log(`  packages:  ${Object.keys(shipped.dependencies).length} declared, all bundled`)
  console.log(`  size:      ${(statSync(artifact).size / 1024).toFixed(1)} kB`)
  console.log(`  url:       ${TARBALL_URL}`)
  if (unpinned.length > 0) {
    console.error(`  FAIL: the shipped manifest still resolves ${unpinned.map(([name]) => name).join(', ')} from git`)
    process.exit(1)
  }
  if (inside.length === 0) {
    console.error('  FAIL: the artifact carries no node_modules, so it is not self-contained')
    process.exit(1)
  }
  console.log(`  next:      gh release create <tag> ${ASSET_NAME.replace(/^/, '.tmp-release/')} --repo pearjelly/deep-blend`)
  return 0
}

// GUARDED, and the guard is load-bearing rather than tidy: the contract layer imports
// `ASSET_NAME` and `TARBALL_URL` from this module to check the entry against the artifact
// the build really produces. Without the guard, importing a constant would run a full
// staging install and fail on a dirty tree — a test that builds a release as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  process.exit(argv.includes('--check') ? check() : build(argv.includes('--allow-dirty')))
}
