#!/usr/bin/env node
/**
 * Release-version contract — one number, and the copies that must equal it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file, this product's version was written in EIGHT places and asserted in none:
 * `packages/deepblend/*` each carried its own `0.1.0`, and the repository root carried another.
 * "They agree" was an observation about a Tuesday, and this repository's doctrine is that an
 * observation nobody asserts is a fact that rots (D38: a `role` added to one of three
 * vocabularies, and the other two rejected it for pointing at the wrong problem).
 *
 * The reason it is not merely untidy is the DELIVERY. The bundle pins its six siblings at exact
 * versions, and the tarball route CARRIES all six inside itself. A bump that reaches six of seven
 * manifests therefore fails in two different places with two different symptoms:
 *
 *   - npm route: the artifact declares a sibling version no registry has, and the install 404s;
 *   - tarball route: the artifact disagrees with itself about what version it is.
 *
 * Neither is caught by building or publishing — both SUCCEED. MEASURED, from the other direction:
 * `npm run publish:check` reported `7 problem(s)` because a published version is immutable, so the
 * seven have to move together or not at all.
 *
 * So `deepblend/version.json` is the source, `tools/release-version.mjs --check` is the comparison,
 * and this file holds four things that could each rot on their own:
 *
 *   1. **The invariant.** Every manifest that carries a `version` carries the source's.
 *   2. **The set is the whole set.** Discovered, not listed, so a package added later is included
 *      — and counted, so a package that quietly disappears is not a smaller set that still passes.
 *   3. **The shipped command agrees.** The last test runs `--check` as a process, because a
 *      library function that agrees with the tree while the CLI does not is a check nobody runs.
 *   4. **The tag is derived, not typed.** `/releases/latest/download/` carries no version, so the
 *      tag is the only place a release says which version it is; `releaseTag()` is its one
 *      definition, and the tarball builder and the listing entry are asserted against it.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * The FRESHNESS question — "is the released artifact still this tree?" — is `--stale`, and it is
 * not in this layer on purpose: it is RED on the commit that adds it, because M6 changed
 * `packages/**` and no release carries those changes. A contract layer that is red for a known
 * and expected reason turns "the contract layer is green" into a sentence that is false. It lives
 * with the release checks (`npm run release:freshness`), where it makes staleness visible without
 * making the main suite lie.
 *
 * Run: node deepblend/tests/contract/release-version.test.mjs
 *
 * Owner: DeepBlend Studio — M6 (release chain)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'
import { manifests, releaseTag, source, drift } from '../../tools/release-version.mjs'
import { ASSET_NAME, TARBALL_URL } from '../../tools/build-release-tarball.mjs'

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const sourceFile = join(ROOT, 'deepblend', 'version.json')

/** The seven published packages, as directory names, read off the disk rather than typed. */
const published = readdirSync(join(ROOT, 'packages', 'deepblend'))
  .filter(name => statSync(join(ROOT, 'packages', 'deepblend', name)).isDirectory())
  .sort()

test('the version source exists, is committed, and holds a plain x.y.z', () => {
  assert.ok(existsSync(sourceFile), 'deepblend/version.json is the single source of the version and must exist')

  // Committed, because a version source that a clone does not receive is not a source. `git
  // ls-files` rather than a `.gitignore` reading: what matters is that a fresh clone HAS it.
  const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'deepblend/version.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim()
  assert.equal(tracked, 'deepblend/version.json')

  const { version } = source()
  assert.match(version, /^\d+\.\d+\.\d+$/,
    `${version} is not a plain x.y.z — a "v" prefix or a range is not something this repository may put on a registry`)
})

test('every manifest that carries a version carries the source version', () => {
  const { version } = source()
  const differing = drift(version)
  assert.deepEqual(differing, [],
    `these manifests disagree with deepblend/version.json (${version}): `
    + differing.map(entry => `${entry.label} is ${entry.version}`).join(', ')
    + ' — run `npm run version:sync`')
})

test('the set of manifests is the root plus every published package, and none is missing', () => {
  const all = manifests()
  const labels = all.map(entry => entry.label)

  // The count is asserted rather than the membership, because the membership is DERIVED: if a
  // package directory were renamed or dropped, `manifests()` would quietly return a smaller set
  // and the invariant above would still pass over it. 8 = package.json + the seven published.
  assert.equal(all.length, 1 + published.length,
    `expected ${1 + published.length} manifests (package.json + ${published.length} published packages), found ${all.length}: ${labels.join(', ')}`)
  assert.equal(all.length, 8,
    `the seven published packages plus the repository root is 8 manifests, and this repository has ${all.length}. `
    + 'A new package is fine — the set is discovered on purpose — but the number is the thing that '
    + 'notices one that left.')
  assert.ok(labels.includes('package.json'), 'the repository root manifest carries a version too, and a second number is the defect this policy removes')

  for (const directory of published) {
    assert.ok(labels.includes(`packages/deepblend/${directory}`),
      `packages/deepblend/${directory} has a package.json that carries a version, and it is not in the set`)
  }
})

test('every published package is still published under the scope, so the set is the publish set', () => {
  // `--sync` writes the version into whatever `manifests()` finds. If a directory under
  // `packages/deepblend` were a fixture rather than a package, this policy would start versioning
  // it — so the shape the tool assumes is asserted here instead of being implied by a directory
  // listing. A `private: true` package is excluded on purpose: it is not published, so a version
  // it carries is not a version anyone installs.
  for (const entry of manifests().slice(1)) {
    const manifest = JSON.parse(readFileSync(entry.path, 'utf8'))
    assert.equal(manifest.private, undefined,
      `${entry.label} is private, so it is not one of the packages the npm route installs`)
    assert.match(manifest.name, /^@deepblend\//,
      `${entry.label} is named ${manifest.name}, which is not under the scope the seven are published to`)
  }
})

test('the release tag is derived from the version and is what the tarball URL is addressed by', () => {
  const { version } = source()
  assert.equal(releaseTag(version), `v${version}`)

  // The asset name carries no version (the market's `latest/download/` rule, held by
  // `release:check`), so the TAG is the only place a release states its version. A tag that did
  // not equal `v<version>` would make the artifact and the manifest disagree with nothing to
  // compare them.
  assert.ok(TARBALL_URL.includes('/releases/latest/download/'),
    'the tarball URL is a latest/download URL, which is why the tag has to carry the version')
  assert.ok(!TARBALL_URL.includes(version),
    `${TARBALL_URL} contains ${version}, so a version-free asset name would buy nothing`)
  assert.equal(ASSET_NAME, 'deepblend-bundle.tgz')
})

test('the version source is not restated anywhere a test cannot compare it', () => {
  // The shape of defect this repository keeps paying for: the same fact written twice. The version
  // may appear in PROSE (a milestone record, a dated measurement) but not in a second machine-read
  // field — so no manifest other than the eight may carry a `version`, and no JSON under
  // `deepblend/` other than the source may hold one.
  for (const name of readdirSync(join(ROOT, 'deepblend'))) {
    const path = join(ROOT, 'deepblend', name)
    if (!name.endsWith('.json') || !statSync(path).isFile()) continue
    if (path === sourceFile) continue
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(parsed.version, undefined,
      `deepblend/${name} carries a version field, which is a second source of the product version`)
  }

  // And the root manifest is in the lockstep set rather than exempt, which is the assertion that
  // says so: `packageJson.version` is read from the file the tool also reads, so this is a check
  // that the two readers see the same thing rather than a second copy.
  const root = manifests().find(entry => entry.label === 'package.json')
  assert.equal(root.version, packageJson.version)
})

test('the shipped --check agrees with the tree it just inspected', () => {
  const output = execFileSync('node', [join(ROOT, 'deepblend', 'tools', 'release-version.mjs'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const { version } = source()
  assert.ok(output.includes(`all 8 manifests carry ${version}`),
    `--check did not report agreement with the source; it said:\n${output}`)
})
