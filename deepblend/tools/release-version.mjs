#!/usr/bin/env node
/**
 * The one place this product's version is written, and the three questions asked of it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until this file, the version lived in EIGHT manifests and nowhere else: `packages/deepblend/*`
 * each wrote its own `0.1.0`, and the repository root wrote another. Nothing said they had to
 * agree. "They agree today" was an OBSERVATION, and the repository's own doctrine is that an
 * observation nobody asserts is a fact that rots — the same shape as D38, where one vocabulary
 * gained a word the other two did not.
 *
 * What made that expensive is not tidiness, it is the DELIVERY: the bundle pins its six siblings
 * at exact versions, and the tarball carries all six inside itself. So a bump that reaches six of
 * seven manifests does not produce a warning anywhere — it produces an artifact that either
 * depends on a version no registry has (npm route: 404 at install) or disagrees with itself about
 * what it is (tarball route). MEASURED against this repository before the policy existed:
 * `npm run publish:check` reported `7 problem(s)` for the mirror-image reason — a version already
 * on the registry cannot be replaced, so the seven had to move together or not at all.
 *
 * So: `deepblend/version.json` is the SOURCE. The manifests are copies, and `--check` is what
 * makes them copies rather than coincidences.
 *
 * THE LOCKSTEP IS MEASURED, NOT ASSUMED
 * -------------------------------------
 * The question "does any of the seven need to move on its own?" was asked before this shape was
 * chosen, and the answer is no, for a reason that is a property of the delivery rather than a
 * preference:
 *
 *   - the tarball route ships ONE artifact that CARRIES all six siblings. Its manifest declares
 *     them at exact versions, so one artifact is one version of the whole product. A sibling that
 *     moved independently would make the artifact's own version number mean nothing;
 *   - the npm route rewrites the six `github:` specs to exact sibling versions, so `bundle@X`
 *     installs exactly the six siblings the artifact carries. Independent movement is possible
 *     there and only there, and it would put the two routes out of step with each other — which
 *     is the one thing the three routes may not be;
 *   - the import graph is a star, not a chain: every one of the 16 imports between packages points
 *     at `contracts`, and `bundle` depends on all six. There is no leaf that changes alone.
 *
 * The repository ROOT manifest is in the set as well. It is `private: true` and is never
 * published, so it could be left behind — and that is exactly why it is included: a second number
 * that is allowed to differ is the defect this policy removes, and "0.1.0" in the root of a
 * repository whose product is 0.2.0 is a reader's question with no good answer.
 *
 * THE THREE QUESTIONS, AND WHY TWO OF THEM ARE NOT IN THE CONTRACT LAYER
 * ---------------------------------------------------------------------
 *   1. `--check`  DO THE MANIFESTS AGREE WITH THE SOURCE? A pure invariant with no network and no
 *                 history: true of any correct tree, so it belongs in the contract layer and runs
 *                 on every push (`contract/release-version.test.mjs`).
 *   2. `--sync`   WRITE THE SOURCE INTO EVERY MANIFEST. The bump, in one command, so that "bump
 *                 six of seven" is not a thing a person can do by hand.
 *   3. `--stale`  IS THE RELEASED ARTIFACT STILL THE CODE? This one CANNOT go in the contract
 *                 layer, and the reason is a measured state rather than a preference: it is RED
 *                 on the commit that lands it, because M6 changed `packages/**` and no release
 *                 carries those changes yet. A contract layer that is red for a known and
 *                 expected reason turns "the contract layer is green" into a sentence that is
 *                 false, and the next person to see red stops believing it. So it lives where
 *                 the release checks live and is run deliberately: it makes staleness VISIBLE
 *                 without making the main suite lie.
 *
 * WHAT `--stale` CANNOT SEE, SAID HERE RATHER THAN DISCOVERED LATER
 * ----------------------------------------------------------------
 * It compares the LATEST RELEASE TAG's `packages/` tree with HEAD's, using git alone. That is
 * offline and fast, and it catches the two ways this repository has actually gone stale: packages
 * that changed without a bump, and a bump with no release. It cannot see the other two halves of
 * the delivery, because neither is in git:
 *
 *   - whether the tag has a RELEASE and an ASSET attached (`gh release create` is a separate act);
 *   - whether npm serves the same version (a tag can be pushed with no publish at all).
 *
 * Those are what `tools/verify-release-routes.mjs` reads back, by installing each route and asking
 * it. The division is deliberate: this file answers "does the repository agree with itself", that
 * one answers "do the three routes serve it".
 *
 * Usage:
 *   node deepblend/tools/release-version.mjs           # the version, where it comes from, the tag
 *   node deepblend/tools/release-version.mjs --check   # every manifest equals the source
 *   node deepblend/tools/release-version.mjs --sync    # write the source into every manifest
 *   node deepblend/tools/release-version.mjs --stale   # is the latest release still this tree?
 *
 * Exit codes: 0 fine, 1 a real problem (drift, or stale), 2 a precondition is missing (no source
 * file, no git, a malformed version).
 *
 * Owner: DeepBlend Studio — M6 (release chain)
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './workspace-layout.mjs'

/** The single source. Every other `version` field in this repository is a copy of this one. */
export const SOURCE_PATH = join(ROOT, 'deepblend', 'version.json')

/** Where the published packages live. */
const PACKAGES_DIRECTORY = join(ROOT, 'packages', 'deepblend')

/**
 * The tag a release of this version carries.
 *
 * `v` and the version, nothing else, because the listing entry points at
 * `/releases/latest/download/deepblend-bundle.tgz` — a URL with no version in it — so the tag is
 * the ONLY place a release states which version it is. `contract/listing-entry.test.mjs` and the
 * tarball builder both rest on that, and this function is the one definition of it.
 *
 * @param {string} version
 * @returns {string}
 */
export function releaseTag(version) {
  return `v${version}`
}

/** A version this repository is willing to put on a registry: plain `x.y.z`, no `v`, no range. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * Read the source.
 *
 * @returns {{version: string, path: string}}
 * @throws {Error} when the file is missing or does not hold a plain `x.y.z`. Both are refusals
 *   rather than defaults: a version tool that guesses is a version tool that publishes a guess.
 */
export function source() {
  if (!existsSync(SOURCE_PATH)) {
    throw new Error(`${SOURCE_PATH.replace(`${ROOT}/`, '')} is missing, and it is where the version is written`)
  }
  const parsed = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'))
  const version = parsed.version
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`${SOURCE_PATH.replace(`${ROOT}/`, '')} holds ${JSON.stringify(version)}, which is not a plain x.y.z`)
  }
  return { version, path: SOURCE_PATH }
}

/**
 * Every manifest in this repository that carries a `version`, in a stable order.
 *
 * The ROOT manifest first, then `packages/deepblend/*` sorted by directory. The set is DISCOVERED
 * rather than listed, so a package added later cannot be forgotten — and the count is asserted by
 * the contract layer, so a package that disappears is not silently a smaller set.
 *
 * @returns {Array<{path: string, label: string, name: string, version: string}>}
 */
export function manifests() {
  const found = []

  const add = (path, label) => {
    if (!existsSync(path)) return
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    found.push({ path, label, name: manifest.name, version: manifest.version })
  }

  add(join(ROOT, 'package.json'), 'package.json')
  for (const directory of readdirSync(PACKAGES_DIRECTORY).sort()) {
    const path = join(PACKAGES_DIRECTORY, directory)
    if (statSync(path).isDirectory()) add(join(path, 'package.json'), `packages/deepblend/${directory}`)
  }
  return found
}

/**
 * The manifests that do NOT carry the source's version.
 *
 * @param {string} version
 * @returns {Array<{label: string, name: string, version: string, expected: string}>}
 */
export function drift(version) {
  return manifests()
    .filter(manifest => manifest.version !== version)
    .map(manifest => ({ label: manifest.label, name: manifest.name, version: manifest.version, expected: version }))
}

/** Run a git command in the repository, without throwing on a non-zero exit. */
function git(args) {
  const outcome = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return { status: outcome.status, output: `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim() }
}

/**
 * The latest release tag, by version order rather than by date.
 *
 * `-v:refname` is what makes `v0.10.0` sort above `v0.9.0`; the default `refname` order puts
 * `v0.9.0` last and would compare HEAD against a release from two versions ago. A repository with
 * no tags answers null, which the caller reports as "nothing has been released" rather than as an
 * error — that is a state, not a fault.
 *
 * @returns {string|null}
 */
export function latestTag() {
  const listed = git(['tag', '--list', 'v*', '--sort=-v:refname'])
  if (listed.status !== 0) return null
  return listed.output.split('\n').map(line => line.trim()).filter(Boolean)[0] ?? null
}

/**
 * The version a tag records, read out of that tag's own `deepblend/version.json`.
 *
 * From the tag, not from the manifest at the tag: `deepblend/version.json` has existed for exactly
 * as long as this policy has, so a tag cut before it cannot be read this way. That is reported as
 * `null` and named in the output rather than treated as a mismatch — the alternative is a check
 * that calls every release older than itself broken.
 *
 * @param {string} tag
 * @returns {string|null}
 */
export function versionAtTag(tag) {
  const shown = git(['show', `${tag}:deepblend/version.json`])
  if (shown.status !== 0) return null
  try {
    const version = JSON.parse(shown.output).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * The files under `packages/` that differ between a tag and HEAD.
 *
 * `packages/` and not the whole tree: a documentation commit after a release does not make the
 * released artifact stale, and a check that says it does is a check that gets ignored. What the
 * artifact IS is the packages tree, so that is what is compared.
 *
 * @param {string} tag
 * @returns {string[]}
 */
export function changedSince(tag) {
  const diff = git(['diff', '--name-only', `${tag}..HEAD`, '--', 'packages/'])
  if (diff.status !== 0) return []
  return diff.output.split('\n').map(line => line.trim()).filter(Boolean)
}

/** `--check`: every manifest equals the source. The invariant the contract layer runs. */
function check() {
  let current
  try {
    current = source()
  } catch (cause) {
    console.error(`FAIL: ${cause.message}`)
    return 2
  }

  const all = manifests()
  const differing = drift(current.version)
  console.log(`source:   deepblend/version.json — ${current.version}`)
  console.log(`tag:      ${releaseTag(current.version)}`)
  console.log(`manifests: ${all.length} (package.json + packages/deepblend/*)`)
  for (const manifest of all) {
    const mark = manifest.version === current.version ? '=' : '!'
    console.log(`  ${mark} ${manifest.label.padEnd(36)} ${manifest.version}  (${manifest.name})`)
  }
  if (differing.length > 0) {
    for (const manifest of differing) {
      console.log(`FAIL: ${manifest.label} is ${manifest.version}, and the source says ${manifest.expected}`)
    }
    console.log(`result: ${differing.length} manifest(s) disagree with the source`)
    console.log('fix:    node deepblend/tools/release-version.mjs --sync')
    return 1
  }
  console.log(`result: all ${all.length} manifests carry ${current.version}, which is what the source says`)
  return 0
}

/** `--sync`: write the source's version into every manifest. The bump, in one command. */
function sync() {
  let current
  try {
    current = source()
  } catch (cause) {
    console.error(`FAIL: ${cause.message}`)
    return 2
  }

  let written = 0
  for (const manifest of manifests()) {
    if (manifest.version === current.version) {
      console.log(`  = ${manifest.label} — already ${current.version}`)
      continue
    }
    const parsed = JSON.parse(readFileSync(manifest.path, 'utf8'))
    parsed.version = current.version
    writeFileSync(manifest.path, `${JSON.stringify(parsed, null, 2)}\n`)
    console.log(`  → ${manifest.label} — ${manifest.version} becomes ${current.version}`)
    written += 1
  }
  console.log(`result: ${written} manifest(s) written; every manifest now carries ${current.version}`)
  console.log(`next:   commit, then build the artifact: npm run release:tarball`)
  return 0
}

/**
 * `--stale`: is the latest release still this tree?
 *
 * Three states, and the output names which one rather than only failing:
 *
 *   FRESH            the latest tag's `packages/` tree equals HEAD's, and the tag records the
 *                    same version the source does;
 *   CHANGED          packages changed since the tag and the version did NOT — a release that
 *                    silently carries more than its version number claims;
 *   UNRELEASED       the version moved and no tag carries it — the four-step chain was started
 *                    and not finished, which is the state that leaves a tarball and a Release
 *                    claiming a version npm does not have.
 */
function stale() {
  let current
  try {
    current = source()
  } catch (cause) {
    console.error(`FAIL: ${cause.message}`)
    return 2
  }

  // TAGS ARE FETCHED, and this is load-bearing rather than tidy: `gh release create` creates the
  // tag on the REMOTE, so a checkout that has just cut a release does not have its own tag yet and
  // this check would compare HEAD against the PREVIOUS release and call a finished chain stale.
  // A fetch that fails (no network, no remote) is reported and the local tags are used — the
  // check degrades to what the checkout knows instead of refusing to answer.
  const fetched = git(['fetch', '--tags', '--quiet'])
  if (fetched.status !== 0) console.log(`note:     could not fetch tags, so this reads the local ones (${fetched.output.split('\n')[0]})`)

  const tag = latestTag()
  console.log(`source:   deepblend/version.json — ${current.version}`)
  console.log(`tag:      ${releaseTag(current.version)} (the tag a release of this version carries)`)

  if (tag === null) {
    console.log('released: nothing — this repository has no v* tag')
    console.log('result: STALE — no release carries this code')
    console.log('next:   node deepblend/tools/build-release-tarball.mjs, then gh release create')
    return 1
  }

  const releasedVersion = versionAtTag(tag)
  const changed = changedSince(tag)
  console.log(`released: ${tag} — records ${releasedVersion ?? 'no deepblend/version.json (predates this policy)'}`)
  console.log(`changed:  ${changed.length} file(s) under packages/ since ${tag}`)

  // A tag that predates the source file has no version to compare, and comparing it anyway would
  // report "the version moved to 0.1.0" for a version that never moved. That is not a small
  // wording problem: it is the difference between a check that reads history and one that
  // invents it, and the first tag this policy ever sees is exactly such a tag.
  const versionMoved = releasedVersion !== null && releasedVersion !== current.version
  if (releasedVersion === null) {
    console.log(`note:     ${tag} carries no version source, so only the packages tree can be compared`)
  }
  if (changed.length === 0 && !versionMoved) {
    console.log(`result: FRESH — ${tag} carries the packages tree at HEAD`
      + (releasedVersion === null ? '' : `, and both say ${current.version}`))
    return 0
  }

  const kind = versionMoved && changed.length > 0
    ? `the version moved to ${current.version} and ${changed.length} file(s) moved with it`
    : versionMoved
      ? `the version moved to ${current.version}`
      : releasedVersion === null
        ? `${changed.length} file(s) changed and no release carries them`
        : `${changed.length} file(s) changed and the version did not (still ${current.version})`
  console.log(`result: STALE — ${kind}`)
  if (changed.length > 0 && changed.length <= 12) {
    for (const file of changed) console.log(`        ${file}`)
  } else if (changed.length > 12) {
    for (const file of changed.slice(0, 12)) console.log(`        ${file}`)
    console.log(`        … and ${changed.length - 12} more`)
  }
  // The all-or-nothing rule, said where the operator will read it rather than in a document they
  // may not have open: a tarball and a Release for a version npm does not have is worse than no
  // release at all, because the two routes then disagree about what the product is.
  console.log('next:   the four steps are one act — bump, rebuild the tarball, cut the Release, republish npm:')
  console.log('          npm run release:tarball')
  console.log(`          gh release create ${releaseTag(current.version)} .tmp-release/deepblend-bundle.tgz --repo pearjelly/deep-blend`)
  console.log('          npm run publish:packages')
  console.log('        stopping after the Release leaves two routes claiming a version npm does not have')
  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  if (argv.includes('--check')) process.exit(check())
  else if (argv.includes('--sync')) process.exit(sync())
  else if (argv.includes('--stale')) process.exit(stale())
  else {
    try {
      const current = source()
      console.log(`version: ${current.version}`)
      console.log(`source:  ${current.path.replace(`${ROOT}/`, '')}`)
      console.log(`tag:     ${releaseTag(current.version)}`)
      console.log(`copies:  ${manifests().length} manifest(s) carry it — check them with --check`)
    } catch (cause) {
      console.error(`FAIL: ${cause.message}`)
      process.exit(2)
    }
    process.exit(0)
  }
}
