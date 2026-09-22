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
  // The shape of defect this repository keeps paying for: the same fact written twice.
  //
  // TWO DIRECTIONS, and the first version of this test only had the weaker one. MEASURED by a
  // mutation that added `"version": "0.2.0"` to `deepblend/tools/blender-release.json`: it
  // SURVIVED, because the check read `readdirSync('deepblend')` and never descended into
  // `tools/`. A check that reads one directory and calls it "the repository" is the same defect
  // as a count that reads one file and calls it "the total".
  //
  // 1. EVERY manifest in this repository is in the lockstep set. `manifests()` discovers the root
  //    plus `packages/deepblend/*`, so a new package somewhere else — `tools/`, `examples/` —
  //    would carry a version nothing syncs and nothing compares. The walk skips the directories
  //    that hold other people's manifests (`node_modules` is symlinks into the DSH deployment,
  //    `.tools` is a Blender), because those are not this repository's to version.
  const IGNORED = new Set(['node_modules', '.git', '.tools', '.deepblend'])
  const manifestsOnDisk = []
  const walk = (directory, prefix) => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.name.startsWith('.tmp-')) continue
      const relative = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isDirectory()) {
        if (IGNORED.has(item.name)) continue
        walk(join(directory, item.name), relative)
      } else if (item.name === 'package.json') {
        manifestsOnDisk.push(relative)
      }
    }
  }
  walk(ROOT, '')

  const inLockstep = new Set(manifests().map(entry => entry.path.replace(`${ROOT}/`, '')))
  const outside = manifestsOnDisk.filter(path => !inLockstep.has(path))
  assert.deepEqual(outside, [],
    `these manifests carry a version that nothing keeps in step with deepblend/version.json: ${outside.join(', ')}`)

  // 2. No JSON the TOOLING reads may hold the PRODUCT version. Toolchain pins are the reason this
  //    is a comparison rather than a ban: `blender-release.json` and `dsh-baseline.json` each
  //    legitimately carry a `version`, and neither of them is this product's. What is forbidden is
  //    the same NUMBER in a second machine-read place — a `release.json` that pins 0.2.0 beside the
  //    source is a copy that will rot, which is the whole reason the source exists.
  const { version } = source()
  const secondSources = []
  const jsonUnder = (directory, prefix) => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isDirectory()) {
        if (IGNORED.has(item.name)) continue
        jsonUnder(join(directory, item.name), relative)
      } else if (item.name.endsWith('.json') && relative !== 'version.json') {
        let parsed
        try {
          parsed = JSON.parse(readFileSync(join(directory, item.name), 'utf8'))
        } catch {
          continue // a malformed file is another suite's problem, not this one's
        }
        if (parsed !== null && typeof parsed === 'object' && parsed.version === version) {
          secondSources.push(`deepblend/${relative}`)
        }
      }
    }
  }
  jsonUnder(join(ROOT, 'deepblend'), '')
  assert.deepEqual(secondSources, [],
    `these files carry ${version} in a second machine-read place: ${secondSources.join(', ')}`)

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
