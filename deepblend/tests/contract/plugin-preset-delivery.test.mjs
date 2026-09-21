/**
 * The Agent-preset plane's deliverable: one install, both planes.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dsh plugin add` installs a PACKAGE; it does not write a user's preset root.
 * The sixteen model-visible tools belong to an agent preset (SPEC §4.3), so a
 * plugin that only mounted the Host composition would install and half work: the
 * workbench appears, the project store serves, and no session can render
 * anything, because the model has no `blender_*` tool to call.
 *
 * The bundle therefore mounts a deployer row (`@deepblend/dsh-blender-preset`)
 * that ships the presets and installs them into `<DSH_HOME>/.agent-presets/`.
 * This file checks the three things that make that safe rather than merely
 * present:
 *
 *  1. **The shipped copy is the repository's copy.** The package must carry its
 *     own `presets/` (a package can only ship what is inside it), which is a
 *     second copy of a fact — and this repository has paid for second copies
 *     repeatedly. The two trees are compared byte for byte here, so the copy
 *     cannot be stale in a commit. `tools/sync-plugin-presets.mjs` is the only
 *     writer.
 *
 *  2. **Deploying is idempotent and three-state.** Nothing installed is a state,
 *     not drift; a half-present preset is drift and is completed; a file an
 *     earlier release left behind is removed; and a second run writes nothing.
 *     Driven against a throwaway target, so no DSH home is touched.
 *
 *  3. **The row is composed with its configuration.** A deployer row whose
 *     `config:` never reaches the plugin would silently deploy into the default
 *     root whatever the composition said — checked by composing a real profile
 *     in `plugin-install-path.test.mjs`, and here by requiring the row to carry
 *     the keys the schema declares.
 *
 * Run standalone: `node deepblend/tests/contract/plugin-preset-delivery.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { PRESET_SOURCE, REQUIRED_FILES, deployPresets, filesUnder, planPreset } from '@deepblend/dsh-blender-preset/deploy'

import { ROOT } from '../../tools/workspace-layout.mjs'

const REPOSITORY_PRESETS = join(ROOT, 'deepblend', 'presets')
const PACKAGE = join(ROOT, 'packages', 'deepblend', 'preset')
const SHIPPED_PRESETS = join(PACKAGE, 'presets')
const BUNDLE_PATCH = join(ROOT, 'packages', 'deepblend', 'bundle', 'cordis.patch.yml')

test('the shipped preset copy is the repository copy, byte for byte', () => {
  assert.ok(existsSync(SHIPPED_PRESETS),
    'the plugin package ships no presets/, so a market install would deploy nothing')
  assert.equal(PRESET_SOURCE, `${SHIPPED_PRESETS}/`,
    'the deployer resolves its preset source somewhere other than the package it belongs to')

  const repository = filesUnder(REPOSITORY_PRESETS)
  const shipped = filesUnder(SHIPPED_PRESETS)
  assert.deepEqual(shipped, repository,
    'the shipped copy and deepblend/presets/ hold different files — run `npm run presets:sync`')

  const different = repository.filter(file => {
    const from = join(REPOSITORY_PRESETS, file)
    const to = join(SHIPPED_PRESETS, file)
    return readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')
  })
  assert.deepEqual(different, [],
    'these files differ between the shipped copy and deepblend/presets/ — run `npm run presets:sync`')

  // The manifest must actually ship them: `files` is what an install copies, and a
  // preset left out of it is a deployer that deploys nothing.
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  assert.ok((manifest.files ?? []).includes('presets'),
    'the package manifest does not list presets/ in files, so an install would not carry them')
  assert.ok((manifest.files ?? []).includes('lib'), 'the package manifest does not list lib/ in files')
})

test('deploying into a fresh root writes every file, and a second run writes nothing', () => {
  const target = mkdtempSync(join(tmpdir(), 'deepblend-preset-deploy-'))
  try {
    const first = deployPresets({ source: PRESET_SOURCE, target })
    assert.ok(first.length >= 2, `expected both shipped presets, deployed ${first.length}`)
    for (const report of first) {
      assert.equal(report.plan.problem, null, `${report.id} could not be deployed: ${report.plan.problem}`)
      assert.equal(report.written.length, report.plan.files.length,
        `${report.id} did not write every file it ships`)
      for (const required of REQUIRED_FILES) {
        assert.ok(existsSync(join(target, report.id, required)),
          `${report.id} was deployed without its ${required}`)
      }
      // The skills travel with the preset: a fixed file list would drop them, and
      // the persona tells the model to load one. Only `deepblend` ships a skill —
      // `deepblend-dev` is the repository's own development mode — so the claim is
      // "whatever this preset ships, it arrives", not "every preset has a skill".
      const skills = report.plan.files.filter(file => file.startsWith('skills/'))
      for (const skill of skills) {
        assert.ok(existsSync(join(target, report.id, skill)), `${report.id} was deployed without ${skill}`)
      }
    }
    const withSkills = first.filter(report => report.plan.files.some(file => file.startsWith('skills/')))
    assert.ok(withSkills.length > 0,
      'no shipped preset carries a skills/ directory, so the walk that must descend into one is untested')

    // IDEMPOTENT: the same call again must find nothing to do. A deployer that
    // rewrites every file on every boot is one that cannot report drift.
    const second = deployPresets({ source: PRESET_SOURCE, target })
    for (const report of second) {
      assert.deepEqual(report.written, [], `${report.id} was rewritten on a second run`)
      assert.deepEqual(report.removed, [], `${report.id} removed files on a second run`)
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a preset that is absent, partial or stale is told apart', () => {
  const target = mkdtempSync(join(tmpdir(), 'deepblend-preset-states-'))
  const id = 'deepblend'
  try {
    const source = join(PRESET_SOURCE, id)
    const installed = join(target, id)

    // ABSENT — nothing of this preset is here. That is every fresh machine, and
    // it is a state rather than drift (the mistake the operator tool made once).
    const absent = planPreset({ source, target: installed, id })
    assert.equal(absent.absent, true, 'a preset that was never installed was not reported as absent')
    assert.deepEqual(absent.stale, [], 'an absent preset reported stale files')

    // PARTIAL — one file present, the rest missing. A half-present preset is
    // broken rather than absent, so it must read as drift.
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'preset.yml'), 'name: something else\n')
    const partial = planPreset({ source, target: installed, id })
    assert.equal(partial.absent, false, 'a partially installed preset was reported as absent')
    assert.ok(partial.drifted.includes('preset.yml'), 'a file with different bytes was not reported as drifted')
    assert.ok(partial.missing.includes('agent.cordis.yml'), 'a missing file was not reported as missing')

    // STALE — a file an earlier release shipped and this one does not.
    writeFileSync(join(installed, 'removed-in-a-later-release.md'), 'gone\n')
    const stale = planPreset({ source, target: installed, id })
    assert.deepEqual(stale.stale, ['removed-in-a-later-release.md'],
      'a file the shipped copy no longer has was not reported as stale')

    // AND THE DEPLOY CLEANS IT UP, without touching anything else in the root.
    const bystander = join(target, 'someone-elses-preset')
    mkdirSync(bystander, { recursive: true })
    writeFileSync(join(bystander, 'preset.yml'), 'name: mine\n')
    deployPresets({ source: PRESET_SOURCE, target, ids: [id] })
    assert.equal(existsSync(join(installed, 'removed-in-a-later-release.md')), false,
      'the stale file survived the deploy')
    assert.equal(readFileSync(join(bystander, 'preset.yml'), 'utf8'), 'name: mine\n',
      'the deploy touched a preset it does not own')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the bundle mounts the deployer with the configuration its schema declares', () => {
  const patch = readFileSync(BUNDLE_PATCH, 'utf8')
  const row = patch.slice(patch.indexOf('id: deepblend-blender-preset'))
  assert.ok(patch.includes('id: deepblend-blender-preset'),
    'the bundle no longer mounts the preset deployer, so a market install would deliver no preset')
  assert.match(row, /name: '@deepblend\/dsh-blender-preset'/,
    'the deployer row does not name the package that ships the presets')
  for (const key of ['deploy', 'presets', 'target']) {
    assert.match(row, new RegExp(`\\n\\s+${key}:`),
      `the deployer row carries no ${key}, so the composition cannot decide where or whether to deploy`)
  }
  // The row's configuration must reach a schema that accepts it — a key the
  // schema drops is a key the composition silently cannot set.
  const bundle = JSON.parse(readFileSync(join(ROOT, 'packages', 'deepblend', 'bundle', 'package.json'), 'utf8'))
  assert.ok(
    Object.keys(bundle.dependencies ?? {}).includes('@deepblend/dsh-blender-preset'),
    'the bundle mounts a row for a package it does not depend on, so the row cannot resolve',
  )
  const presetManifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
  assert.equal(presetManifest.exports?.['./deploy']?.default, './lib/deploy.js',
    'the package no longer exports ./deploy, which the operator tool and this suite import')
})

test('the preset the deployer installs is the preset the roster can read', () => {
  // The roster scans a preset root for directories whose name is a preset id and
  // whose composition file parses. A shipped directory that fails either is a
  // roster row that is broken on every machine that installs the plugin.
  const ids = filesUnder(PRESET_SOURCE).length > 0
    ? [...new Set(filesUnder(PRESET_SOURCE).map(file => file.split('/')[0]))]
    : []
  assert.deepEqual(ids.sort(), ['deepblend', 'deepblend-dev'],
    'the shipped preset ids changed, so the roster rows this plugin adds changed with them')
  for (const id of ids) {
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/, `${id} is not a valid preset id, so the roster would skip it`)
    const metadata = readFileSync(join(PRESET_SOURCE, id, 'preset.yml'), 'utf8')
    assert.match(metadata, /^name:\s*\S/m, `${id}/preset.yml declares no name, so the session list would show nothing`)
    const composition = readFileSync(join(PRESET_SOURCE, id, 'agent.cordis.yml'), 'utf8')
    assert.ok(composition.includes('@deepblend/dsh-blender-tool'),
      `${id} does not mount the tool package, so the sixteen tools would never reach the model`)
    // The bundle may be NAMED in a comment — the preset's own prose explains which
    // host composition publishes the service its tools consume — but a ROW that
    // mounted it would publish a process-global service from inside a preset, and
    // the second session on that preset would collide (SPEC §4.4).
    assert.ok(composition.includes("name: '@deepblend/dsh-blender-bundle'") === false,
      `${id} mounts the Host bundle as a row inside a preset, which publishes a service and would collide on a second session`)
  }
  // The relative path the roster would see, for the record: `deepblend/presets`
  // is SPEC §5.2's path and stays the source; the package copy is generated.
  assert.ok(relative(ROOT, REPOSITORY_PRESETS) === 'deepblend/presets')
})
