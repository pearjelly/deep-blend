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
 *   3. DSH remains a peer dependency; ordinary third-party runtime dependencies are the
 *      explicitly reviewed image, preset and ZIP libraries;
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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ROOT } from '../../tools/workspace-layout.mjs'
import { verifyShowcaseProvenance } from '../../tools/showcase-provenance.mjs'
import { verifyPagodaProvenance } from '../../tools/pagoda-provenance.mjs'
import { verifyRecoveryReproductionProvenance } from '../../tools/recovery-reproduction-provenance.mjs'

const INVENTORY = join(ROOT, 'deepblend', 'docs', 'third-party.md')
const inventory = readFileSync(INVENTORY, 'utf8')

/** Every package this repository publishes, from the tree rather than from a list. */
const packages = readdirSync(join(ROOT, 'packages', 'deepblend'))
  .filter(name => existsSync(join(ROOT, 'packages', 'deepblend', name, 'package.json')))
  .map(name => ({ name, manifest: JSON.parse(readFileSync(join(ROOT, 'packages', 'deepblend', name, 'package.json'), 'utf8')) }))

function verifyLighttableProvenance(root) {
  const base = 'deepblend/docs/assets/lighttable'
  const manifest = JSON.parse(readFileSync(join(root, base, 'manifest.json'), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(manifest.schemaVersion, 'deepblend.lighttable-docs/v1')
  assert.equal(manifest.license, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.author, 'DeepBlend contributors')
  assert.equal(manifest.original, true)
  assert.equal(manifest.sourceRepository, 'https://github.com/pearjelly/deep-blend')
  assert.equal(manifest.reproductionGuide, 'README.md')
  assert.ok(existsSync(join(root, base, manifest.reproductionGuide)))
  assert.ok(['cua-browser-ui', 'cdp-browser-ui'].includes(manifest.capture.interaction),
    'Lighttable captures must name an actual browser interaction method')
  assert.equal(manifest.capture.uiSource, 'packages/deepblend/ui/lib/client.js')
  assert.equal(hash(readFileSync(join(root, manifest.capture.uiSource))), manifest.capture.capturedUiSha256,
    'Lighttable captured UI differs from the published client; recapture before publishing')
  assert.equal(manifest.capture.viewed, true)
  assert.equal(manifest.capture.nativeRegressionRerun, false)
  assert.deepEqual(manifest.images.map(image => image.file).sort(), ['narrow.png', 'workbench.png'])
  const paths = []
  for (const image of manifest.images) {
    const path = `${base}/${image.file}`
    const bytes = readFileSync(join(root, path))
    assert.equal(hash(bytes), image.sha256, `${path}: Lighttable screenshot digest differs`)
    assert.equal(bytes.length, image.bytes)
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width)
    assert.equal(bytes.readUInt32BE(20), image.height)
    assert.deepEqual([image.width, image.height], image.file === 'workbench.png' ? [1440, 1013] : [390, 844])
    assert.equal(image.postProcessed, false)
    const conversion = image.encodingConversion
    assert.equal(conversion.sourceFile, image.file === 'workbench.png' ? 'lighttable-desktop.png' : 'lighttable-narrow.png')
    assert.equal(conversion.sourceFormat, 'JPEG')
    assert.match(conversion.sourceSha256, /^[a-f0-9]{64}$/)
    assert.match(conversion.decodedPixelsSha256, /^[a-f0-9]{64}$/)
    assert.equal(conversion.pixelMode, 'RGB')
    assert.equal(conversion.decodedPixelsIdentical, true)
    for (const field of ['cropped', 'resized', 'colorAdjusted']) assert.equal(conversion[field], false)
    paths.push(path)
  }
  return paths
}

function verifyMeshUvProvenance(root) {
  const base = 'deepblend/docs/assets/mesh-uv'
  const manifest = JSON.parse(readFileSync(join(root, base, 'provenance.json'), 'utf8'))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.author, 'DeepBlend contributors')
  assert.equal(manifest.nativeSource.sourceSpec, 'deepblend/docs/assets/showcase/pagoda/scene-spec.json')
  assert.equal(hash(readFileSync(join(root, manifest.nativeSource.sourceSpec))), manifest.nativeSource.sourceSpecSha256, 'mesh UV source spec differs')
  assert.equal(manifest.nativeSource.externalAssetFilesDistributed, false)
  assert.ok(manifest.nativeSource.externalMaterials.every(asset => asset.license === 'CC0-1.0' && asset.source.startsWith('https://polyhaven.com/a/')))
  const expected = ['rafter-after.png', 'rafter-before.png', 'workbench.png'].map(file => `${base}/${file}`)
  assert.deepEqual(manifest.images.map(image => image.file).sort(), expected)
  for (const image of manifest.images) {
    const bytes = readFileSync(join(root, image.file))
    assert.equal(hash(bytes), image.documentationPngSha256, 'mesh UV image digest differs')
    assert.equal(bytes.length, image.documentationBytes)
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width)
    assert.equal(bytes.readUInt32BE(20), image.height)
    assert.match(image.originalPngSha256, /^[a-f0-9]{64}$/)
    assert.match(image.originalPixelsSha256, /^[a-f0-9]{64}$/)
    assert.equal(image.originalPixelsSha256, image.documentationPixelsSha256)
    assert.equal(image.provenanceMetadataOnly, true)
  }
  return expected
}

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

test('third-party runtime dependencies are limited to reviewed image, preset and ZIP libraries; DSH stays a peer', () => {
  const local = new Set(packages.map(({ manifest }) => manifest.name))
  const ordinary = []
  for (const { name, manifest } of packages) {
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
        if (local.has(dependency)) continue
        assert.ok(!dependency.startsWith('@deepseek-ai/'), `${name}: ${dependency} must remain a DSH peer`)
        ordinary.push({ package: name, field, dependency, version })
      }
    }
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      assert.ok(peer.startsWith('@deepseek-ai/'),
        `packages/deepblend/${name} lists unreviewed peer ${peer}; peers are for the DSH deployment`)
      // Any of the ordinary spellings — `^1.2.3`, `~1.2`, `>=4.0.0 <5`, `*`. MEASURED: the first
      // version of this rule only accepted a leading digit, caret or tilde and rejected the harness's
      // own `>=4.0.0 <5`, which is a perfectly good range.
      assert.match(String(range), /^[\^~><=*]|^\d/, `the peer range for ${peer} is not a version range: ${range}`)
    }
  }
  assert.deepEqual(ordinary, [
    { package: 'host', field: 'dependencies', dependency: 'sharp', version: '0.35.5' },
    { package: 'host', field: 'dependencies', dependency: 'yauzl', version: '3.4.0' },
    { package: 'host', field: 'dependencies', dependency: 'yazl', version: '3.3.1' },
    { package: 'preset', field: 'dependencies', dependency: 'js-yaml', version: '4.3.2' },
  ],
    'adding or moving an external dependency requires an explicit inventory and contract review')
  for (const token of ['sharp', '0.35.5', '@img/sharp-', 'libvips', 'Apache-2.0', 'LGPL-3.0-or-later']) {
    assert.ok(inventory.includes(token), `third-party inventory omits the reviewed codec detail ${token}`)
  }
})

test('both runtime locks preserve the reviewed ZIP dependency graph and its licence inventory', () => {
  const reviewed = {
    yazl: { version: '3.3.1', dependencies: { 'buffer-crc32': '^1.0.0' } },
    yauzl: { version: '3.4.0', dependencies: { pend: '~1.2.0' } },
    'buffer-crc32': { version: '1.0.0', dependencies: {} },
    pend: { version: '1.2.0', dependencies: {} },
  }
  const section = inventory.slice(inventory.indexOf('## 2. 逐项'), inventory.indexOf('## 3. 为什么不冲突'))
  for (const [name, expected] of Object.entries(reviewed)) {
    const rows = section.split('\n').filter(line => line.startsWith(`| **${name} ${expected.version}** |`))
    assert.equal(rows.length, 1, `the licence inventory must name ${name}@${expected.version} exactly once`)
    const cells = rows[0].split('|').map(cell => cell.trim())
    assert.equal(cells[2], 'MIT', `${name}: review the actual package licence before changing the inventory`)
    assert.ok(cells[5].includes(`${name}/package.json`) && cells[5].includes(`${name}/LICENSE`),
      `${name}: the inventory must identify the original manifest and licence`)
  }
  const graphs = []
  for (const directory of ['deepblend/development/runtime', 'deepblend/development/compatibility/dsh-0.2.1-rc.1']) {
    const manifest = JSON.parse(readFileSync(join(ROOT, directory, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(ROOT, directory, 'package-lock.json'), 'utf8'))
    for (const name of ['yazl', 'yauzl']) {
      assert.equal(manifest.dependencies[name], reviewed[name].version, `${directory}: direct ZIP dependency changed`)
      assert.equal(lock.packages[''].dependencies[name], reviewed[name].version, `${directory}: root lock differs`)
    }
    const graph = {}
    for (const [name, expected] of Object.entries(reviewed)) {
      const entry = lock.packages[`node_modules/${name}`]
      assert.ok(entry, `${directory}: missing ${name}`)
      assert.equal(entry.version, expected.version, `${directory}: ${name} version needs review`)
      assert.deepEqual(entry.dependencies ?? {}, expected.dependencies, `${directory}: ${name} dependency graph needs review`)
      assert.deepEqual(entry.optionalDependencies ?? {}, {}, `${directory}: ${name} has an unreviewed optional dependency`)
      assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${expected.version}.tgz`)
      assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/)
      graph[name] = { version: entry.version, dependencies: entry.dependencies ?? {}, resolved: entry.resolved, integrity: entry.integrity }
    }
    graphs.push(graph)
  }
  assert.deepEqual(graphs[0], graphs[1], 'the two runtime locks must resolve the same reviewed ZIP package bytes')
})

test('source files exclude external binaries and published images have declared provenance', () => {
  // Include new source before its first commit, so a local pass cannot conceal
  // a failure that only appears in CI after those files become tracked.
  // Ignored dependencies and release artifacts have a separate inventory.
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
  assert.ok(tracked.length > 100, `only ${tracked.length} tracked file(s) — is this a checkout?`)

  const binary = /\.(dmg|pkg|exe|msi|so|dylib|dll|a|o|node|wasm|zip|tgz|tar\.xz|tar\.gz|7z|jar)$/i
  const offenders = tracked.filter(file => binary.test(file))
  assert.deepEqual(offenders, [], `these tracked files are binaries: ${offenders.join(', ')}`)

  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const ownLicense = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license
  const previewManifest = JSON.parse(readFileSync(join(ROOT, 'deepblend/benchmarks/previews/manifest.json'), 'utf8'))
  assert.equal(previewManifest.license, ownLicense)
  assert.equal(previewManifest.tool, 'deepblend/tools/quality-benchmark.mjs')
  assert.ok(tracked.includes(previewManifest.tool))
  const declared = new Set()
  for (const file of verifyShowcaseProvenance(ROOT)) declared.add(file)
  for (const file of verifyPagodaProvenance(ROOT)) declared.add(file)
  for (const file of verifyRecoveryReproductionProvenance(ROOT)) declared.add(file)
  for (const file of verifyLighttableProvenance(ROOT)) declared.add(file)
  for (const file of verifyMeshUvProvenance(ROOT)) declared.add(file)
  // CHARGE is a separately licensed real DSH case, not an original MIT model.
  const chargeBase = 'deepblend/docs/assets/showcase/charge-study'
  const charge = JSON.parse(readFileSync(join(ROOT, chargeBase, 'manifest.json'), 'utf8'))
  assert.equal(charge.schemaVersion, 'deepblend.public-case/v1')
  assert.equal(charge.casePluginVersion, '0.5.0')
  assert.match(charge.license, /CC-BY.*Blender Studio.*MIT/)
  for (const file of charge.files) {
    assert.ok(!file.path.includes('..') && !file.path.startsWith('/'))
    const path = `${chargeBase}/${file.path}`, bytes = readFileSync(join(ROOT, path))
    assert.equal(hash(bytes), file.sha256, `${path}: CHARGE case digest differs`)
    assert.equal(bytes.length, file.bytes)
    declared.add(path)
  }
  const receipt = JSON.parse(readFileSync(join(ROOT, chargeBase, 'delivery.json'), 'utf8'))
  assert.equal(receipt.pluginVersion, charge.casePluginVersion)
  assert.equal(receipt.delivery.verified, true)
  assert.equal(receipt.delivery.jobId, charge.jobId)
  assert.equal(receipt.delivery.revision, charge.revision)
  assert.equal(hash(readFileSync(join(ROOT, chargeBase, 'night-shift.mp4'))), receipt.sha256)
  const frames = JSON.parse(readFileSync(join(ROOT, chargeBase, 'frame-sources.json'), 'utf8'))
  const native = JSON.parse(readFileSync(join(ROOT, chargeBase, 'native-readback.json'), 'utf8'))
  assert.equal(Object.keys(frames.frames).length, 144)
  assert.equal(frames.jobId, charge.jobId)
  for (const source of Object.values(frames.sources)) assert.equal(source.checkpointSha256, native.checkpointSha256)
  assert.equal(native.passed, true)
  const replay = JSON.parse(readFileSync(join(ROOT, chargeBase, 'replay-check.json'), 'utf8'))
  assert.equal(replay.passed, true)
  assert.equal(replay.pixelIdentical, false)
  for (const image of previewManifest.images) {
    assert.match(image.file, /^[a-z0-9-]+\.png$/)
    const path = `deepblend/benchmarks/previews/${image.file}`
    const bytes = readFileSync(join(ROOT, path))
    assert.equal(hash(bytes), image.sha256, `${path}: preview digest differs from its provenance`)
    assert.equal(bytes.length, image.bytes)
    assert.match(image.sourceRunSha256, /^[a-f0-9]{64}$/)
    assert.match(image.sourceSnapshotSha256, /^[a-f0-9]{64}$/)
    declared.add(path)
  }
  for (const name of readdirSync(join(ROOT, 'deepblend/recipes'))) {
    const base = `deepblend/recipes/${name}`
    const recipe = JSON.parse(readFileSync(join(ROOT, base, 'recipe.json'), 'utf8'))
    assert.equal(recipe.license, ownLicense)
    assert.equal(recipe.source.url, 'https://github.com/pearjelly/deep-blend')
    assert.equal(recipe.preview.path, 'preview.png')
    assert.equal(recipe.input.path, 'scene-spec.json')
    assert.equal(hash(readFileSync(join(ROOT, base, recipe.input.path))), recipe.input.sha256)
    for (const directory of [base, `packages/deepblend/host/recipes/${name}`]) {
      const path = `${directory}/${recipe.preview.path}`
      assert.equal(hash(readFileSync(join(ROOT, path))), recipe.preview.sha256,
        `${path}: recipe preview differs from its declared original source`)
      declared.add(path)
    }
  }

  for (const [name, expectedPreview] of [
    ['metal-lamp-v2','a4c39a0679b5c829fa7183b55a5b637d3fcc0f6dfaf89e7dc0f2f319c9ed9572'],
    ['metal-lamp-v1','e961539a4d22bb78232569c38f66ee51b8ed5d5e352655f35bc4a2adaa9a69f6'],
    ['modular-speaker-v2','b23f9fa591d1b1a49db6067cf9df872611dde34c2472b07f38ea73590c4e1492'],
    ['modular-speaker-v1','b23f9fa591d1b1a49db6067cf9df872611dde34c2472b07f38ea73590c4e1492'],
    ['glazed-cup-v1','c4f93d87bfc528f1435160befda27ec5868d747f21fba50148bcf98a4abbbb92'],
    ['glazed-cup-v3','b8f7b70e26032ef9f6deae577856a71342c450a0e71e47c804876227d1086807'],
    ['glazed-cup-v2','ce84a64b8bb3314c83b84f2f96c907fca7ee74cc24ad425c52df6cd915af197f'],
  ]) {
    const historical=`deepblend/tests/fixtures/${name}`
    const historicalRecipe=JSON.parse(readFileSync(join(ROOT,historical,'recipe.json')))
    assert.equal(historicalRecipe.version,name==='glazed-cup-v3'?'3.0.0':['glazed-cup-v2','modular-speaker-v2','metal-lamp-v2'].includes(name)?'2.0.0':'1.0.0');assert.equal(historicalRecipe.license,ownLicense)
    assert.equal(historicalRecipe.source.url,'https://github.com/pearjelly/deep-blend')
    assert.equal(historicalRecipe.input.path,'scene-spec.json');assert.equal(historicalRecipe.preview.path,'preview.png')
    assert.equal(hash(readFileSync(join(ROOT,historical,'scene-spec.json'))),historicalRecipe.input.sha256)
    assert.equal(hash(readFileSync(join(ROOT,historical,'preview.png'))),historicalRecipe.preview.sha256)
    assert.equal(historicalRecipe.preview.sha256,expectedPreview)
    assert.ok(readFileSync(join(ROOT,historical,'LICENSE'),'utf8').includes('MIT License'))
    declared.add(`${historical}/preview.png`)
  }

  const fixtureBase = 'deepblend/tests/fixtures/obj-image-formats'
  const fixtureManifest = JSON.parse(readFileSync(join(ROOT, fixtureBase, 'formats.json'), 'utf8'))
  assert.equal(fixtureManifest.license, ownLicense)
  assert.equal(fixtureManifest.author, 'DeepBlend contributors')
  assert.equal(fixtureManifest.schemaVersion, 'deepblend.obj-image-fixtures/v1')
  assert.equal(fixtureManifest.images.length, 15)
  for (const image of fixtureManifest.images) {
    assert.match(image.file, /^paint\.(png|jpg|bmp|tga|rgb|cin|dpx|tif|hdr|exr|jp2|dds|psd|webp|avif)$/)
    const path = `${fixtureBase}/${image.file}`
    assert.equal(hash(readFileSync(join(ROOT, path))), image.sha256,
      `${path}: native fixture bytes differ from their declared provenance`)
    assert.equal(image.width, 64)
    assert.equal(image.height, 64)
    declared.add(path)
  }

  const tutorialBase = 'deepblend/docs/assets/creator-tutorial'
  const tutorialManifest = JSON.parse(readFileSync(join(ROOT, tutorialBase, 'manifest.json'), 'utf8'))
  assert.equal(tutorialManifest.schemaVersion, 'deepblend.creator-tutorial-images/v1')
  assert.equal(tutorialManifest.license, ownLicense)
  assert.equal(tutorialManifest.author, 'DeepBlend contributors')
  assert.match(tutorialManifest.sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(tutorialManifest.sourceTree, /^[a-f0-9]{40}$/)
  assert.match(tutorialManifest.sourceRun.reportSha256, /^[a-f0-9]{64}$/)
  assert.match(tutorialManifest.sourceRun.walkthroughSha256, /^[a-f0-9]{64}$/)
  assert.ok(existsSync(join(ROOT, tutorialBase, tutorialManifest.reproductionGuide)))
  assert.deepEqual(tutorialManifest.images.map(image => image.file).sort(),
    ['cup-105mm-clay.png', 'cup-110mm-clay.png', 'cup-final-frame.png'])
  for (const image of tutorialManifest.images) {
    const path = `${tutorialBase}/${image.file}`
    const bytes = readFileSync(join(ROOT, path))
    assert.equal(hash(bytes), image.sha256, `${path}: tutorial image differs from its native source`)
    assert.equal(bytes.length, image.bytes)
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width)
    assert.equal(bytes.readUInt32BE(20), image.height)
    for (const field of ['sceneSpecSha256', 'checkpointSha256', 'sourceReceiptSha256']) assert.match(image[field], /^[a-f0-9]{64}$/)
    assert.equal(image.postProcessed, false)
    declared.add(path)
  }

  const photographyBase = 'deepblend/docs/assets/photography-reuse'
  const photography = JSON.parse(readFileSync(join(ROOT, photographyBase, 'manifest.json'), 'utf8'))
  assert.equal(photography.schemaVersion, 'deepblend.photography-docs/v1')
  assert.equal(photography.license, ownLicense)
  assert.equal(photography.author, 'DeepBlend contributors')
  assert.equal(photography.tool, 'deepblend/tests/e2e/photography-ui.e2e.mjs')
  assert.ok(tracked.includes(photography.tool))
  // The 36-check regression is historical evidence. Later navigation fixes change
  // the live test file; its bytes must not replace the recorded historical digest.
  assert.match(photography.toolSha256, /^[a-f0-9]{64}$/)
  assert.match(photography.sourceBase, /^[a-f0-9]{40}$/)
  for (const key of ['uiSha256', 'sourceReportSha256', 'sourceRequestsSha256']) assert.match(photography[key], /^[a-f0-9]{64}$/)
  assert.equal(hash(readFileSync(join(ROOT, 'packages/deepblend/ui/lib/client.js'))), photography.uiSha256)
  assert.equal(photography.nativeChecks, 36)
  // Current UI captures and historical native acceptance have distinct source bindings.
  assert.equal(photography.nativeRegression.nativeChecks, photography.nativeChecks)
  assert.equal(photography.nativeRegression.sourceBase, photography.sourceBase)
  assert.equal(photography.nativeRegression.tool, photography.tool)
  assert.equal(photography.nativeRegression.toolSha256, photography.toolSha256)
  assert.equal(photography.nativeRegression.sourceReportSha256, photography.sourceReportSha256)
  assert.equal(photography.nativeRegression.sourceRequestsSha256, photography.sourceRequestsSha256)
  assert.match(photography.nativeRegression.uiSha256, /^[a-f0-9]{64}$/)
  assert.ok(photography.nativeRegression.scope.length > 0)
  // The current browser capture has its own client and report binding, separate
  // from the earlier native suite's tool, report and request ledger above.
  assert.ok(['cua-browser-ui', 'cdp-browser-ui'].includes(photography.capture.interaction),
    'Photography captures must name an actual browser interaction method')
  assert.equal(photography.capture.uiSha256, photography.uiSha256)
  const captureBytes = readFileSync(join(ROOT, photographyBase, photography.capture.report))
  assert.equal(hash(captureBytes), photography.capture.reportSha256)
  const capture = JSON.parse(captureBytes)
  assert.equal(capture.passed, true)
  assert.equal(capture.uiSha256, photography.uiSha256)
  assert.equal(capture.nativeRegressionRerun, photography.capture.nativeRegressionRerun)
  assert.equal(capture.nativeRegressionRerun, false, 'the current draft-only capture does not claim to rerun the historical native suite')
  assert.equal(capture.allHostBytesUnchanged, true)
  assert.ok(capture.protectedHostFiles > 0)
  assert.equal(capture.dom.applied, true)
  assert.equal(capture.dom.photographyOpen, true)
  assert.equal(capture.dom.width, 390)
  assert.equal(capture.dom.scrollWidth, capture.dom.width)
  assert.ok(capture.dom.controls.every(control => control.left >= 0 && control.right <= capture.dom.width))
  assert.equal(photography.postProcessed, false)
  assert.ok(existsSync(join(ROOT, photographyBase, photography.reproductionGuide)))
  assert.deepEqual(photography.images.map(image => image.file).sort(), ['draft.png', 'narrow.png'])
  for (const image of photography.images) {
    const path = `${photographyBase}/${image.file}`, bytes = readFileSync(join(ROOT, path))
    assert.equal(hash(bytes), image.sha256, `${path}: screenshot differs from its declared native source`)
    assert.equal(bytes.length, image.bytes)
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width)
    assert.equal(bytes.readUInt32BE(20), image.height)
    assert.equal(image.postProcessed, false)
    assert.deepEqual([image.width, image.height], image.file === 'draft.png' ? [1440, 1013] : [390, 844])
    declared.add(path)
  }

  // Brand illustrations are original SVG artwork, explicitly distinct from render evidence.
  execFileSync(process.execPath, [join(ROOT, 'deepblend/tools/render-brand.mjs'), '--check'],
    { cwd: ROOT, encoding: 'utf8' })
  const brand = JSON.parse(readFileSync(join(ROOT, 'deepblend/docs/brand/manifest.json')))
  for (const image of brand.images) {
    declared.add(`deepblend/docs/brand/${image.file}`)
    declared.add(`packages/deepblend/bundle/assets/${image.file}`)
  }

  // Historical screenshots come from the capture tool; new captures and other
  // images must be exact files declared by provenance manifests, not allowed folders.
  const images = tracked.filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
  for (const image of images) {
    assert.ok(/^deepblend\/docs\/images\//.test(image) || declared.has(image),
      `${image} has no declared screenshot, Lighttable, benchmark, recipe, tutorial, brand, showcase, recovery reproduction or native fixture provenance`)
  }
  assert.ok(tracked.includes('deepblend/tools/capture-docs-images.mjs'),
    'the tool that produces the documentation images is gone, so their provenance cannot be checked')
})

test('Lighttable provenance rejects changed image digests and detached UI captures', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'deepblend-lighttable-integrity-'))
  const base = 'deepblend/docs/assets/lighttable'
  try {
    writeFileSync(join(fixture, 'package.json'), readFileSync(join(ROOT, 'package.json')))
    cpSync(join(ROOT, base), join(fixture, base), { recursive: true })
    mkdirSync(join(fixture, 'packages/deepblend/ui/lib'), { recursive: true })
    cpSync(join(ROOT, 'packages/deepblend/ui/lib/client.js'), join(fixture, 'packages/deepblend/ui/lib/client.js'))
    assert.equal(verifyLighttableProvenance(fixture).length, 2)
    const manifestPath = join(fixture, base, 'manifest.json')
    const original = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const check = (change, pattern) => {
      const changed = structuredClone(original)
      change(changed)
      writeFileSync(manifestPath, JSON.stringify(changed))
      assert.throws(() => verifyLighttableProvenance(fixture), pattern)
    }
    check(value => { value.images[0].sha256 = '0'.repeat(64) }, /Lighttable screenshot digest differs/)
    check(value => { value.capture.capturedUiSha256 = '0'.repeat(64) }, /Lighttable captured UI differs/)
    check(value => { value.images.push({ ...value.images[0], file: 'unreviewed.png' }) }, /Expected values to be strictly deep-equal/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

test('mesh UV documentation rejects changed PNGs and a detached source spec', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'deepblend-mesh-uv-integrity-'))
  const base = 'deepblend/docs/assets/mesh-uv'
  try {
    cpSync(join(ROOT, base), join(fixture, base), { recursive: true })
    const source = 'deepblend/docs/assets/showcase/pagoda/scene-spec.json'
    mkdirSync(join(fixture, 'deepblend/docs/assets/showcase/pagoda'), { recursive: true })
    cpSync(join(ROOT, source), join(fixture, source))
    assert.equal(verifyMeshUvProvenance(fixture).length, 3)
    const manifestPath = join(fixture, base, 'provenance.json'), original = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const broken = structuredClone(original); broken.images[0].documentationPngSha256 = '0'.repeat(64)
    writeFileSync(manifestPath, JSON.stringify(broken))
    assert.throws(() => verifyMeshUvProvenance(fixture), /mesh UV image digest differs/)
    writeFileSync(manifestPath, JSON.stringify(original)); writeFileSync(join(fixture, source), '{}')
    assert.throws(() => verifyMeshUvProvenance(fixture), /mesh UV source spec differs/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

test('recovery reproduction rejects changed frames and detached native source receipts', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'deepblend-recovery-integrity-'))
  const base = 'deepblend/reproductions/recovery-v0.11.0'
  try {
    writeFileSync(join(fixture, 'package.json'), readFileSync(join(ROOT, 'package.json')))
    cpSync(join(ROOT, base), join(fixture, base), { recursive: true })
    assert.equal(verifyRecoveryReproductionProvenance(fixture).length, 24)
    const frame = join(fixture, base, 'frames/frame_0001.png')
    const original = readFileSync(frame)
    writeFileSync(frame, Buffer.concat([original, Buffer.from('changed')]))
    assert.throws(() => verifyRecoveryReproductionProvenance(fixture), /checksum mismatch/)
    writeFileSync(frame, original)
    const ledgerPath = join(fixture, base, 'evidence/final-frame-sources.json')
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    Object.values(ledger.sources)[0].checkpointSha256 = '0'.repeat(64)
    writeFileSync(ledgerPath, JSON.stringify(ledger))
    // Updating the public file inventory must not hide a detached source claim.
    const checksums = join(fixture, base, 'SHA256SUMS')
    const digest = createHash('sha256').update(readFileSync(ledgerPath)).digest('hex')
    writeFileSync(checksums, readFileSync(checksums, 'utf8').replace(/^[a-f0-9]{64}(  evidence\/final-frame-sources\.json)$/m, `${digest}$1`))
    assert.throws(() => verifyRecoveryReproductionProvenance(fixture), /detached from the published native project/)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('showcase rejects changed images, scenes, dimensions and detached clay provenance', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'deepblend-showcase-integrity-'))
  const base = 'deepblend/docs/assets/showcase'
  const manifest = JSON.parse(readFileSync(join(ROOT, base, 'manifest.json'), 'utf8'))
  try {
    writeFileSync(join(fixture, 'package.json'), readFileSync(join(ROOT, 'package.json')))
    mkdirSync(join(fixture, base), { recursive: true })
    symlinkSync(join(ROOT, 'deepblend/showcase'), join(fixture, 'deepblend/showcase'))
    for (const file of readdirSync(join(ROOT, base)).filter(file => file !== 'manifest.json')) {
      symlinkSync(join(ROOT, base, file), join(fixture, base, file))
    }
    const check = (change, pattern) => {
      const changed = structuredClone(manifest)
      change(changed.cases[0])
      writeFileSync(join(fixture, base, 'manifest.json'), JSON.stringify(changed))
      assert.throws(() => verifyShowcaseProvenance(fixture), pattern)
    }
    check(entry => { entry.images[0].sha256 = '0'.repeat(64) }, /digest differs/)
    check(entry => { entry.sceneSourceSha256 = '0'.repeat(64) }, /scene source changed/)
    check(entry => { entry.images[0].width++ }, /Expected values to be strictly equal/)
    check(entry => { entry.inspections[0].revision = 'r9999' }, /Expected values to be strictly equal/)
    check(entry => { entry.images[0].webDerivative.sha256 = '0'.repeat(64) }, /digest differs/)
    check(entry => { entry.inspections = [] }, /missing clay provenance/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

test('pagoda provenance rejects altered media and detached production frame records', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'deepblend-pagoda-integrity-'))
  const base = 'deepblend/docs/assets/showcase/pagoda'
  try {
    cpSync(join(ROOT, base), join(fixture, base), { recursive: true })
    assert.equal(verifyPagodaProvenance(fixture).size, 7)
    const manifestPath = join(fixture, base, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath))
    const check = (change, pattern) => {
      const changed = structuredClone(manifest)
      change(changed)
      writeFileSync(manifestPath, JSON.stringify(changed))
      assert.throws(() => verifyPagodaProvenance(fixture), pattern)
    }
    check(value => { value.images[0].sha256 = '0'.repeat(64) }, /pagoda digest differs/)
    check(value => { value.images[0].frame = 2 }, /source frame digest differs/)
    check(value => { value.source.sha256 = '0'.repeat(64) }, /pagoda digest differs/)
    check(value => { value.video.sha256 = '0'.repeat(64) }, /pagoda digest differs/)
    check(value => { value.license = 'MIT' }, /Expected values to be strictly equal/)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const receiptPath = join(fixture, base, 'delivery.json')
    const receipt = JSON.parse(readFileSync(receiptPath))
    receipt.render.provenance.sources[0].checkpointSha256 = '0'.repeat(64)
    const bytes = Buffer.from(JSON.stringify(receipt))
    writeFileSync(receiptPath, bytes)
    manifest.deliveryReceipt.sha256 = createHash('sha256').update(bytes).digest('hex')
    manifest.deliveryReceipt.bytes = bytes.length
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => verifyPagodaProvenance(fixture), /Expected values to be strictly equal/)
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})

test('release manifest checks explicitly leave native artifact acceptance pending', () => {
  const output = execFileSync(process.execPath, [join(ROOT, 'deepblend/tools/build-release-tarball.mjs'), '--check'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.match(output, /check-scope: manifest-and-naming-only/)
  assert.match(output, /native-artifact-status: target-platform-validation-required/)
  const requirements = JSON.parse(output.split('\n').find(line => line.startsWith('native-dependencies: ')).slice('native-dependencies: '.length))
  assert.deepEqual(requirements, [{ consumer: '@deepblend/dsh-blender-host', dependency: 'sharp', version: '0.35.5',
    requiresTargetValidation: true, evidence: ['artifactSha256', 'platform', 'arch', 'libc', 'pngDecode', 'jpegDecode', 'licenses'] }])
  assert.match(inventory, /DEEPBLEND_INSTALLED_HOST/)
  assert.match(inventory, /REFERENCE_PNG/)
  assert.match(inventory, /REFERENCE_JPEG/)
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
