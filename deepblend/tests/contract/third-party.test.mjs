#!/usr/bin/env node
/**
 * Third-party components and licences — the inventory, held to the code.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ledger C12 asked whether the third-party licences had ever been inventoried, and the measured
 * answer was no: `LICENSE` carried this project's own MIT, and nothing anywhere said that Blender is
 * GPL, that ffmpeg's licence depends on the build the USER installed, or that the managed Blender is
 * DOWNLOADED rather than redistributed. A company deciding whether it can ship this asks exactly
 * those questions first, and "we call it as a separate program" is an answer that has to be checkable.
 *
 * The assertions below are about the SHAPE of the claim rather than the licence names, because the
 * names belong to other people and change on their schedule:
 *
 *   1. the external programs the product runs are exactly the executables its own configuration
 *      schemas declare — derived in both directions, so the inventory cannot list a program nothing
 *      spawns and cannot miss one that is spawned;
 *   2. every published manifest declares the same licence as the repository root;
 *   3. the product's `dependencies` are its own packages only, and everything external is a
 *      `peerDependencies` entry — which is what "we do not redistribute it" means in a manifest;
 *   4. no tracked file is a binary somebody else built.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 * -----------------------------------
 * The licence TEXT of Blender or ffmpeg. Those are readings taken from the artifacts on a machine
 * (`third-party.md` §4 names the commands), and a contract test that asserted them would be asserting
 * about whatever the developer happened to install — green on one machine and red on the next for
 * reasons that have nothing to do with this repository.
 *
 * Run standalone: `node deepblend/tests/contract/third-party.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 *
 * Owner: DeepBlend Studio — commercial readiness (ledger C12)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../tools/workspace-layout.mjs'

const INVENTORY = join(ROOT, 'deepblend', 'docs', 'third-party.md')
const inventory = readFileSync(INVENTORY, 'utf8')

/** Every package this repository publishes, from the tree rather than from a list. */
const packages = readdirSync(join(ROOT, 'packages', 'deepblend'))
  .filter(name => existsSync(join(ROOT, 'packages', 'deepblend', name, 'package.json')))
  .map(name => ({ name, manifest: JSON.parse(readFileSync(join(ROOT, 'packages', 'deepblend', name, 'package.json'), 'utf8')) }))

test('the external programs the product runs are exactly the ones its schemas declare', () => {
  // DERIVED, BOTH WAYS. The three executables this product can start are the three its configuration
  // exposes — a Blender path on the runtime row, and ffmpeg/ffprobe for the delivery step. Anything
  // spawned that is NOT one of those would be an external program nobody configured, and anything
  // declared but not spawned is a knob that lies; the inventory has to name the same set either way.
  const sources = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) sources.push(readFileSync(full, 'utf8'))
    }
  }
  walk(join(ROOT, 'packages'))

  const declared = new Set()
  for (const source of sources) {
    for (const match of source.matchAll(/\b(blenderPath|ffmpegPath|ffprobePath)\s*:/g)) declared.add(match[1])
  }
  assert.deepEqual([...declared].sort(), ['blenderPath', 'ffmpegPath', 'ffprobePath'],
    `the configuration no longer declares exactly the three external executables: ${[...declared].sort().join(', ')}`)

  // EACH ONE HAS TO BE A ROW OF THE §2 TABLE, BY ITS FIRST CELL. Two mutations died here before this
  // rule was right, and both taught the same lesson twice over:
  //
  //   * asking `inventory.includes('ffprobe')` was satisfied by §1's prose and by §4's command list;
  //   * asking "does some row containing Blender say 外部程序" was satisfied by §1's own row, which is
  //     ABOUT the three kinds of relationship and names Blender as an example.
  //
  // So the table is extracted by its section, and the claim is the row's own subject: the component
  // name is its first cell, and the way it is used is its third.
  const section = inventory.slice(inventory.indexOf('## 2. 逐项'), inventory.indexOf('## 3. 为什么不冲突'))
  assert.ok(section.length > 200, 'the inventory has no §2 — this assertion has lost its subject')

  const rows = section.split('\n')
    .filter(line => line.startsWith('| **'))
    .map(line => line.split('|').map(cell => cell.trim()))
  assert.ok(rows.length >= 4, `§2 has ${rows.length} component row(s), which is too few to be an inventory`)

  const subjectOf = (row) => row[1] ?? ''
  const usageOf = (row) => row[3] ?? ''

  for (const [key, binary] of [['blenderPath', 'Blender'], ['ffmpegPath', 'ffmpeg'], ['ffprobePath', 'ffprobe']]) {
    const row = rows.find(candidate => subjectOf(candidate).includes(binary))
    assert.ok(row !== undefined,
      `no row of §2 has ${binary} as its subject, and \`${key}\` configures it — naming it in prose is not an inventory entry`)
  }

  // And every external program's row says HOW it is used, because the three-way distinction (external
  // invocation / peer / redistribution) is the whole licence argument: a row without it is a name.
  for (const binary of ['Blender', 'ffmpeg']) {
    const row = rows.find(candidate => subjectOf(candidate).includes(binary))
    assert.match(usageOf(row), /外部程序|external program/,
      `§2's row for ${binary} does not say it is invoked as an external program, which is what the licence argument rests on`)
  }
})

test('every published manifest declares the licence the repository root does', () => {
  // A package on the registry with no `license` field is "unlicensed" as far as a consumer's tooling
  // is concerned, whatever the repository says at its root. All eight carry MIT today; this holds it.
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license
  assert.ok(typeof root === 'string' && root.length > 0, 'the repository root declares no licence at all')

  for (const { name, manifest } of packages) {
    assert.equal(manifest.license, root, `packages/deepblend/${name} declares ${manifest.license ?? 'nothing'}, and the root says ${root}`)
  }
  assert.ok(inventory.includes(root), `third-party.md does not state this project's own licence (${root})`)
})

test('nothing third-party is redistributed: own packages as dependencies, everything else as peers', () => {
  // THIS IS "we do not redistribute it", written in the place a consumer's tooling reads. A third-party
  // entry in `dependencies` would be code this repository ships; a `peerDependencies` entry is code the
  // USER already has, which is what the harness is.
  for (const { name, manifest } of packages) {
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      assert.ok(dependency.startsWith('@deepblend/'),
        `packages/deepblend/${name} depends on ${dependency}, which is not this repository's own package — that is redistributed third-party code`)
    }
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      assert.ok(!peer.startsWith('@deepblend/'),
        `packages/deepblend/${name} lists its own ${peer} as a peer; peers are for what the deployment provides`)
      // Any of the ordinary spellings — `^1.2.3`, `~1.2`, `>=4.0.0 <5`, `*`. MEASURED: the first
      // version of this rule only accepted a leading digit, caret or tilde and rejected the harness's
      // own `>=4.0.0 <5`, which is a perfectly good range.
      assert.match(String(range), /^[\^~><=*]|^\d/, `the peer range for ${peer} is not a version range: ${range}`)
    }
  }
})

test('no tracked file is a binary somebody else built', () => {
  // The strongest cheap statement of "the artifact carries no third-party bytes": nothing built by
  // anyone else is in the tree at all. The managed Blender is downloaded at install time, ffmpeg is
  // installed by the user, and the harness comes from the user's deployment.
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')
  assert.ok(tracked.length > 100, `only ${tracked.length} tracked file(s) — is this a checkout?`)

  const binary = /\.(dmg|pkg|exe|msi|so|dylib|dll|a|o|node|wasm|zip|tgz|tar\.xz|tar\.gz|7z|jar)$/i
  const offenders = tracked.filter(file => binary.test(file))
  assert.deepEqual(offenders, [], `these tracked files are binaries: ${offenders.join(', ')}`)

  // The images this repository DOES carry are its own, and the tool that makes them is the evidence.
  const images = tracked.filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
  for (const image of images) {
    assert.match(image, /^deepblend\/docs\/images\//,
      `${image} is an image outside docs/images — every picture here is captured from this product by capture-docs-images.mjs`)
  }
  assert.ok(tracked.includes('deepblend/tools/capture-docs-images.mjs'),
    'the tool that produces the documentation images is gone, so their provenance cannot be checked')
})

test('the inventory says how to re-check each claim, and states the boundary of its own reasoning', () => {
  // A licence document that cannot be re-derived is a paragraph. Each row points at code or an
  // assertion, and §4 gives the commands — including the one that reads Blender's OWN licence file
  // rather than quoting a website.
  assert.match(inventory, /## 4\. 怎么复核/, 'third-party.md has no section saying how to re-check it')
  assert.match(inventory, /license\/license\.md/, 'the command that reads Blender\'s own licence file is not given')
  assert.match(inventory, /ffmpeg -version/, 'the command that reads the local ffmpeg build\'s licence flags is not given')

  // And the reasoning has a stated boundary: redistributing Blender would change the answer, and the
  // document has to say so rather than leaving a reader to assume the MIT claim is unconditional.
  assert.match(inventory, /如果将来要再分发/, 'third-party.md does not state what would change if Blender were redistributed')
})
