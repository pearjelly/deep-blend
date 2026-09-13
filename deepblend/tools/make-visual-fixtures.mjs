#!/usr/bin/env node
/**
 * Derive the three planted-defect fixtures from the interior room.
 *
 * WHY DERIVED RATHER THAN HAND-WRITTEN
 * ------------------------------------
 * `deepblend/fixtures/interior-room/` is a *correct* scene: it must keep scoring as
 * a passing reference, and it is the fixture a human opens to see what the product
 * considers good. The M2 acceptance criterion needs the opposite — scenes with one
 * KNOWN defect each, so "the model identified the composition problem" can be
 * asserted as a fact rather than as an opinion about a render.
 *
 * Writing three more full SceneSpecs by hand would make four copies of one room, and
 * the four would drift the first time the room changed. Deriving them instead makes
 * the defect the ONLY difference, which is exactly the property the tests rely on:
 * every assertion about "what changed" is about the planted defect and nothing else.
 *
 * Each derived fixture records its defect in `defect.json` beside the spec, so a
 * reader (and the test) can see the intended problem without diffing two documents.
 *
 * Run: node deepblend/tools/make-visual-fixtures.mjs
 *
 * Owner: DeepBlend Studio — M2
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const FIXTURES = join(ROOT, 'deepblend', 'fixtures')
const BASE = join(FIXTURES, 'interior-room', 'scene-spec.json')

/** Deep clone through JSON: a SceneSpec is a JSON document by definition. */
const clone = value => JSON.parse(JSON.stringify(value))

/**
 * Move a camera so the subject leaves the centre of the frame.
 *
 * The composed Latin name says what it is: the camera is fine, the FRAMING is not,
 * and the fix is a camera transform — which is what makes it a composable problem
 * for the automated loop rather than a broken scene.
 */
function offCentreComposition(base) {
  const spec = clone(base)
  const camera = spec.cameras.find(entry => entry.id === 'camera-main')
  // Aim well beside the subject: the camera still looks at the room, but the table
  // it is supposed to be about sits near the edge of frame.
  camera.transform.location = [1.30, -2.9, 1.15]
  camera.targetPoint = [1.34, 1.30, 0.62]
  return {
    spec,
    defect: {
      category: 'composition',
      code: 'SUBJECT_OFF_CENTER',
      objectId: 'coffee-table',
      viewId: 'active-camera',
      planted: 'the active camera is aimed well to the right of the coffee table, leaving the subject at the edge of frame',
      expectedFix: 'move camera-main so the table is centred again',
    },
  }
}

/**
 * Dim the room to the point the frame reads dark.
 *
 * Both area lights are scaled down rather than deleted: a scene with no lights at
 * all is a scene-level error, and the interesting review case is a scene that
 * renders and is merely too dark to deliver.
 */
function underExposed(base) {
  const spec = clone(base)
  for (const light of spec.lights) light.energy = Math.max(1, light.energy * 0.018)
  return {
    spec,
    defect: {
      category: 'exposure',
      code: 'FRAME_UNDEREXPOSED',
      // The SUBJECT is what the finding names, not the frame. Exposure is judged on the
      // subject's own pixels, because a frame-wide floor reports a correctly lit product
      // on the black background the brief asks for as underexposed — and the repair loop
      // accepts only patches that raise the score, so it would lighten the background to
      // "fix" a scene that was already right.
      objectId: 'coffee-table',
      viewId: 'active-camera',
      planted: 'both area lights are reduced to about 2% energy, so the subject reads dark',
      expectedFix: 'raise light energy (or lower the exposure compensation) until the product is lit',
    },
  }
}

/**
 * Stand the partition screen directly between the camera and the subject.
 *
 * Chosen over "hide the subject" deliberately: a hidden object is not occluded, it
 * is absent, and its fix is `entity.visibility.set`. An occlusion is a second object
 * in the way, and its fix is to move one of the two — a different problem with a
 * different solution, which is why the two have different findings.
 */
function occludedSubject(base) {
  const spec = clone(base)
  const screen = spec.entities.find(entry => entry.id === 'screen')
  // On the camera-to-table line, wide and tall enough to cover it from the active
  // camera while leaving the other three views clear — so the finding is
  // attributable to ONE view, which is what the tests check.
  // Wide enough to hide more than a third of the subject: below that ratio the
  // finding is critical, which is what makes the scene score as failing rather than
  // landing exactly on the pass threshold.
  screen.transform.location = [-0.35, -1.25, 0.60]
  screen.transform.scale = [0.12, 0.05, 0.78]
  return {
    spec,
    defect: {
      category: 'occlusion',
      code: 'SUBJECT_OCCLUDED',
      objectId: 'coffee-table',
      viewId: 'active-camera',
      planted: 'the partition screen stands on the camera-main sight line, hiding most of the coffee table from that view',
      expectedFix: 'move the screen aside, or move camera-main around it',
    },
  }
}

const FIXTURES_TO_WRITE = [
  ['composition-off-centre', offCentreComposition],
  ['exposure-underlit', underExposed],
  ['occlusion-screen', occludedSubject],
]

const base = JSON.parse(readFileSync(BASE, 'utf8'))

for (const [name, build] of FIXTURES_TO_WRITE) {
  const { spec, defect } = build(base)
  spec.project.id = `interior-${name}`
  spec.project.title = `Interior room — ${name}`
  spec.project.goal =
    `The interior room with one planted defect (${defect.category}: ${defect.code}) used to prove the visual loop ` +
    `can see and fix it. Derived from fixtures/interior-room by tools/make-visual-fixtures.mjs; ` +
    `the defect is described in defect.json beside this file.`

  const directory = join(FIXTURES, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'scene-spec.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  writeFileSync(join(directory, 'defect.json'), `${JSON.stringify({
    derivedFrom: 'deepblend/fixtures/interior-room/scene-spec.json',
    generatedBy: 'deepblend/tools/make-visual-fixtures.mjs',
    ...defect,
  }, null, 2)}\n`, 'utf8')
  console.log(`wrote ${directory}`)
  console.log(`  planted: ${defect.category} / ${defect.code} on ${defect.viewId}`)
}

console.log(`\n${FIXTURES_TO_WRITE.length} derived fixtures written.`)
