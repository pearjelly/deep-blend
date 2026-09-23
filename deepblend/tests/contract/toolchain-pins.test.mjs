#!/usr/bin/env node
/**
 * Toolchain pin contract test.
 *
 * This repository pins two external things and cannot work without either:
 * a Blender build to render with, and a DSH deployment to be a plugin FOR.
 * Both pins are compatibility anchors rather than conveniences — SPEC §9.5 makes
 * the 3D executor one, and SPEC §0.1 makes the harness one — and both were
 * previously stated in more than one place with nothing comparing them:
 *
 *   Blender 5.2.1   docs/dsh-baseline.md §5      and  tools/blender-release.json
 *   DSH 0.1.5-rc.2  docs/dsh-baseline.md §1      and  .github/workflows/ci.yml
 *                   and whatever the developer has installed
 *
 * Three copies of one fact, compared by nothing. That is the exact shape of
 * architecture-decisions D38 — `role` was added to one of three vocabularies and
 * the other two then rejected a CORRECT input for the WRONG reason — and it is
 * worth a test rather than a convention, because a version skew does not look
 * like a version skew. It looks like a suite that fails for an unrelated reason,
 * or worse, one that passes against a harness the product does not run.
 *
 * What this file cannot check: whether the pinned versions are GOOD choices.
 * Only that every place stating them agrees, and that the machine running the
 * suite actually has them.
 *
 * Run: node deepblend/tests/contract/toolchain-pins.test.mjs
 *
 * Owner: DeepBlend Studio — M5 (reproducibility)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveHarnessScope } from '../lib/dsh-deployment.mjs'
import { ROOT } from '../../tools/workspace-layout.mjs'

const baselineDoc = readFileSync(join(ROOT, 'deepblend', 'docs', 'dsh-baseline.md'), 'utf8')
const ciWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const blenderPin = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'tools', 'blender-release.json'), 'utf8'))
const dshPin = JSON.parse(readFileSync(join(ROOT, 'deepblend', 'tools', 'dsh-baseline.json'), 'utf8'))

// ---------------------------------------------------------------------------
// Blender
// ---------------------------------------------------------------------------

test('the Blender pin names a version, an https image and a positive size', () => {
  assert.match(blenderPin.version, /^\d+\.\d+\.\d+$/, 'version must be a plain x.y.z')
  assert.ok(blenderPin.url.startsWith('https://'), 'the image must be fetched over https')
  assert.equal(
    blenderPin.url.split('/').pop(),
    blenderPin.image,
    'the pinned image name and the URL basename must be the same file',
  )
  assert.ok(Number.isSafeInteger(blenderPin.bytes) && blenderPin.bytes > 0, 'bytes must be a positive integer')
})

test('the Blender pin records a digest, or says out loud that it has none', () => {
  // `null` is a legitimate state (Blender publishes no checksum for this release,
  // so the first verified download establishes it) — but it must be `null` and
  // not an empty string or an absent key, because the installer branches on it.
  if (blenderPin.sha256 === null) {
    assert.ok(
      Array.isArray(blenderPin._comment) && blenderPin._comment.join(' ').includes('sha256'),
      'an unpinned digest must be explained in the file that leaves it unpinned',
    )
    return
  }
  assert.match(blenderPin.sha256, /^[0-9a-f]{64}$/, 'a recorded digest must be a lowercase sha256')
})

test('the Blender version in the pin is the version the baseline document records', () => {
  const tableRows = baselineDoc.split('\n').filter(line => line.includes('| 版本 |') || line.includes('Blender 5.'))
  assert.ok(tableRows.length > 0, 'docs/dsh-baseline.md §5 no longer records a Blender version')
  assert.ok(
    baselineDoc.includes(`Blender ${blenderPin.version}`),
    `docs/dsh-baseline.md does not mention Blender ${blenderPin.version}, which tools/blender-release.json pins`,
  )
  assert.ok(
    baselineDoc.includes(blenderPin.url),
    'docs/dsh-baseline.md no longer records the pinned download URL, so the pin has no provenance',
  )
})

test('the Blender installer and its pin are both shipped', () => {
  for (const file of ['deepblend/tools/install-blender.mjs', 'deepblend/tools/blender-release.json']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is missing, so a fresh clone cannot obtain the runtime`)
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts?.['blender:install'], 'node deepblend/tools/install-blender.mjs')
  assert.equal(manifest.scripts?.['blender:check'], 'node deepblend/tools/install-blender.mjs --check')
})

// ---------------------------------------------------------------------------
// DSH
// ---------------------------------------------------------------------------

test('the DSH anchor is stated identically in the pin, the baseline document and CI', () => {
  const version = dshPin.version
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'the anchor must be a plain published version')

  assert.ok(
    baselineDoc.includes(version),
    `docs/dsh-baseline.md does not state the pinned DSH version ${version}`,
  )
  assert.ok(
    ciWorkflow.includes(`@deepseek-ai/dsh@${version}`),
    `.github/workflows/ci.yml does not install the pinned DSH version ${version}; CI would test a different harness`,
  )
})

// ---------------------------------------------------------------------------
// The one patch this project applies to the PINNED BASELINE
// ---------------------------------------------------------------------------
//
// `docs/dsh-reasoning-content-fix.patch` is unusual among this repository's files: it
// modifies the INSTALLED DSH, not anything under version control here. It used to sit in
// the repository root referenced by nothing, which is the defect shape this repository
// keeps recording — a fact written where nobody reads it, correct when written and never
// re-read (D38, D43, D57, D60).
//
// It is not decorative: in thinking mode every assistant message carrying `tool_calls`
// must carry `reasoning_content`, and the pinned `0.1.5-rc.2` omits the field whenever the
// turn produced no reasoning text. Every DeepBlend capability is a tool call, so without
// the patch the workbench cannot complete a single render.
//
// The two halves are asserted separately because either one alone rots: a document that
// names a file which no longer exists, and a file nobody names, are both failures and
// neither is visible from the other.
test('the baseline patch is named by the baseline document and exists where it says', () => {
  const PATCH = 'dsh-reasoning-content-fix.patch'
  assert.ok(
    baselineDoc.includes(PATCH),
    `docs/dsh-baseline.md no longer names ${PATCH}, so the workaround it documents is unreferenced again`,
  )
  const path = join(ROOT, 'deepblend', 'docs', PATCH)
  assert.ok(existsSync(path), `docs/dsh-baseline.md names ${PATCH} but deepblend/docs/${PATCH} does not exist`)
  // And it is no longer ALSO at the repository root, which is where it was orphaned. Two
  // copies is the other half of the same defect.
  assert.ok(!existsSync(join(ROOT, PATCH)),
    `${PATCH} is back at the repository root as well as in docs/, which is the second copy this case exists to prevent`)
})

test('the deployment this workspace links against is the pinned one', () => {
  // The strongest of the four: not what a file says, but what the suites will
  // actually import. A mismatch here means every other green line describes a
  // harness the product does not run.
  const scope = resolveHarnessScope()

  // `resolveHarnessScope()` returns an `@deepseek-ai` directory, and the `dsh`
  // package sits either inside it (a sibling dependency scope) or two levels
  // above it (`<dsh>/node_modules/@deepseek-ai`, which is what a global npm
  // install produces). Both shapes are real; asking which one this is beats
  // assuming, and validating the manifest's own `name` beats trusting a path.
  const candidates = [
    join(scope, 'dsh', 'package.json'),
    join(scope, '..', '..', 'package.json'),
  ]
  const manifestPath = candidates.find(path =>
    existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).name === '@deepseek-ai/dsh')

  assert.ok(
    manifestPath !== undefined,
    `no @deepseek-ai/dsh package manifest near ${scope} (tried ${candidates.join(', ')})`,
  )

  const installed = JSON.parse(readFileSync(manifestPath, 'utf8')).version
  assert.equal(
    installed,
    dshPin.version,
    `the linked deployment is DSH ${installed} but the repository pins ${dshPin.version}. ` +
      `Install the pinned version (npm install -g @deepseek-ai/dsh@${dshPin.version}) or upgrade the pin in one commit.`,
  )
})
