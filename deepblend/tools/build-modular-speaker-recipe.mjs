#!/usr/bin/env node
/** Preserve the reviewed default while exposing bounded assembly dimensions. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createLinkedSpeakerBundle } from './lib/linked-speaker-recipe.mjs'
const root = resolve(import.meta.dirname, '../..')
const baseline = join(root, 'deepblend/tests/fixtures/modular-speaker-v1')
const target = join(root, 'deepblend/recipes/modular-speaker')
const bundle = createLinkedSpeakerBundle({ manifest: JSON.parse(readFileSync(join(baseline, 'recipe.json'))),
  sceneBytes: readFileSync(join(baseline, 'scene-spec.json')), previewBytes: readFileSync(join(baseline, 'preview.png')) })
for (const [name, bytes] of Object.entries({ 'recipe.json': Buffer.from(JSON.stringify(bundle.manifest, null, 2) + '\n'),
  'scene-spec.json': bundle.sceneBytes, 'preview.png': bundle.previewBytes, LICENSE: readFileSync(join(baseline, 'LICENSE')) })) {
  if (process.argv.includes('--check')) assert.deepEqual(readFileSync(join(target, name)), bytes, `${name} differs from the linked speaker`)
  else writeFileSync(join(target, name), bytes)
}
console.log(`Modular speaker 2.0.0 ${process.argv.includes('--check') ? 'verified' : 'built'} from reviewed 1.0.0 geometry and native pixels`)
