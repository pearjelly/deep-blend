#!/usr/bin/env node
/**
 * Fixture inventory contract test — "全部 Fixture 通过", made checkable.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §20 asks M5 for "全部 Fixture 通过". The fixtures ARE exercised: the M1 suite
 * drives the product turntable, the M2 suite drives the correct room and all three
 * planted-defect scenes, and M3 renders from the room. What none of that covers is
 * the INVENTORY — a fixture can sit in `deepblend/fixtures/` that no suite ever
 * opens, and every suite stays green. That is the same shape as a preset row nobody
 * asserts (D79) and a tool nobody calls (D80): content that exists, is shipped, and
 * is never checked by anything.
 *
 * So this file checks the four claims an inventory can make:
 *
 *   1. every fixture directory holds a parseable SceneSpec;
 *   2. every fixture is OPENED by at least one suite — a fixture nothing reads is
 *      either dead weight or a test somebody forgot to write;
 *   3. every planted defect declares a category and a code the scorer actually
 *      knows, so `defect.json` cannot describe a problem the product cannot report;
 *   4. every derived fixture still names a base that exists, so the derivation
 *      documented in `make-visual-fixtures.mjs` is still reproducible.
 *
 * What it cannot check: whether a fixture MEASURES as its `defect.json` claims. That
 * needs Blender, and it lives in `blender-integration/visual-loop.e2e.mjs`, which
 * asserts exactly that for all three planted defects.
 *
 * Run: node deepblend/tests/contract/fixture-inventory.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { VISUAL_ISSUE_CATEGORIES, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { ROOT, sourceFiles } from '../../tools/workspace-layout.mjs'

const FIXTURES = join(ROOT, 'deepblend', 'fixtures')

/**
 * Directories under `fixtures/` that hold data rather than a scene.
 *
 * `blender/` is a recorded capability document, not a scene: it has no SceneSpec and
 * nothing renders it. Named here explicitly rather than pattern-matched, so adding a
 * second such directory is a deliberate edit.
 */
const NON_SCENE_DIRECTORIES = new Set(['blender'])

const fixtureDirectories = readdirSync(FIXTURES)
  .filter(name => statSync(join(FIXTURES, name)).isDirectory())
  .sort()

/** Every test file's text, once, for the "is this fixture opened" question. */
const suiteText = sourceFiles(join(ROOT, 'deepblend', 'tests'))
  .map(file => readFileSync(file, 'utf8'))
  .join('\n')

test('the fixture inventory is non-empty and has the shape this test assumes', () => {
  assert.ok(fixtureDirectories.length >= 4, `expected several fixtures, found ${fixtureDirectories.length}`)
  assert.ok(
    fixtureDirectories.includes('interior-room') && fixtureDirectories.includes('product-turntable'),
    'the two SPEC-named templates are missing from the inventory',
  )
})

test('every scene fixture holds a parseable, versioned SceneSpec', () => {
  for (const name of fixtureDirectories) {
    if (NON_SCENE_DIRECTORIES.has(name)) continue
    const path = join(FIXTURES, name, 'scene-spec.json')
    assert.ok(existsSync(path), `${name} has no scene-spec.json, so it is not a scene fixture`)

    const spec = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(spec.schemaVersion, 'deepblend.scene/v1', `${name} declares an unexpected schemaVersion`)
    assert.ok(typeof spec.project?.id === 'string', `${name} has no project id`)
    assert.ok(Array.isArray(spec.entities), `${name} has no entities array`)
  }
})

test('every fixture is opened by at least one suite', () => {
  const unopened = fixtureDirectories.filter(name => !suiteText.includes(name))
  assert.deepEqual(
    unopened,
    [],
    `no suite opens ${unopened.join(', ')}. A fixture nothing reads is a claim nothing checks — ` +
      'either wire it into a suite or delete it.',
  )
})

test('every planted defect declares a category, a code and a code known to the scorer', () => {
  const defectDirectories = fixtureDirectories.filter(name => existsSync(join(FIXTURES, name, 'defect.json')))
  assert.equal(defectDirectories.length, 3, `expected the three M2 planted defects, found ${defectDirectories.length}`)

  // The codes the deterministic scorer can actually emit. `defect.json` describes what
  // a fixture was DERIVED to break, and the M2 suite asserts the scorer reports exactly
  // this code — so a typo here would make the fixture describe a problem that cannot
  // be measured, and the suite would fail far from the cause.
  const measurableCodes = new Set([
    'SUBJECT_OCCLUDED',
    'SUBJECT_OFF_CENTER',
    'SUBJECT_TOO_SMALL',
    'SUBJECT_FILLS_FRAME',
    'SUBJECT_PART_HIDDEN',
    'FRAME_UNDEREXPOSED',
    'FRAME_OVEREXPOSED',
  ])

  for (const name of defectDirectories) {
    const defect = JSON.parse(readFileSync(join(FIXTURES, name, 'defect.json'), 'utf8'))
    assert.ok(
      VISUAL_ISSUE_CATEGORIES.includes(defect.category),
      `${name} declares category "${defect.category}", which is not in the closed set ${VISUAL_ISSUE_CATEGORIES.join(', ')}`,
    )
    assert.ok(measurableCodes.has(defect.code), `${name} declares code "${defect.code}", which no measurement emits`)
    assert.ok(typeof defect.objectId === 'string' && defect.objectId.length > 0, `${name} names no object`)
    assert.ok(typeof defect.viewId === 'string' && defect.viewId.length > 0, `${name} names no view`)
    assert.ok(
      typeof defect.planted === 'string' && defect.planted.length > 20,
      `${name} does not describe what was planted, so a reader has to diff two documents to find out`,
    )
    assert.ok(typeof defect.expectedFix === 'string' && defect.expectedFix.length > 5, `${name} suggests no fix`)
  }
})

test('every derived fixture still names a base that exists, so it can be regenerated', () => {
  const defectDirectories = fixtureDirectories.filter(name => existsSync(join(FIXTURES, name, 'defect.json')))
  for (const name of defectDirectories) {
    const defect = JSON.parse(readFileSync(join(FIXTURES, name, 'defect.json'), 'utf8'))
    assert.ok(
      existsSync(join(ROOT, defect.derivedFrom)),
      `${name} says it was derived from ${defect.derivedFrom}, which does not exist — ` +
        'the derivation in make-visual-fixtures.mjs can no longer be replayed',
    )
    assert.ok(
      existsSync(join(ROOT, defect.generatedBy)),
      `${name} names ${defect.generatedBy} as its generator, which does not exist`,
    )
  }
})

test('the correct fixtures are the ones the suites assert stay correct', () => {
  // `interior-room` must keep scoring as a passing reference and `product-turntable`
  // carries the golden digest. If either were quietly turned into a defect fixture,
  // "the scrubber reports problems" would stop meaning anything.
  for (const name of ['interior-room', 'product-turntable']) {
    assert.ok(
      !existsSync(join(FIXTURES, name, 'defect.json')),
      `${name} is the correct reference and must not carry a planted defect`,
    )
  }
  assert.ok(
    existsSync(join(FIXTURES, 'product-turntable', 'golden.json')),
    'the product turntable lost its golden document, so M1 has nothing to compare against',
  )

  // A sanity check on the vocabulary this file shares with the product: if the error
  // code table moves, the codes above are the wrong kind of thing to be asserting.
  assert.ok(typeof BlenderErrorCode.PROJECT_NOT_FOUND === 'string', 'BlenderErrorCode is not the table this test assumes')
})
