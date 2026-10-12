#!/usr/bin/env node
/** Rebuild the smoothed speaker from its accepted assembly and pinned native preview. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createSmoothSpeakerBundle } from './lib/smooth-speaker-recipe.mjs'
import { sha256 } from '../../packages/deepblend/contracts/lib/canonical.js'
const root = resolve(import.meta.dirname, '../..')
const baseline = join(root, 'deepblend/tests/fixtures/modular-speaker-v2')
const target = join(root, 'deepblend/recipes/modular-speaker')
const previewBytes = readFileSync(join(target, 'preview.png'))
assert.equal(sha256(previewBytes), 'd3d8ae075c70300099861a1637cd3182d966f05b3b410f0887b26cc692e0d41d', 'Native preview changed; rerender and review before updating the pin')
const bundle = createSmoothSpeakerBundle({ manifest: JSON.parse(readFileSync(join(baseline, 'recipe.json'))),
  sceneBytes: readFileSync(join(baseline, 'scene-spec.json')), previewBytes: readFileSync(join(baseline, 'preview.png')) }, previewBytes)
for (const [name, bytes] of Object.entries({ 'recipe.json': Buffer.from(JSON.stringify(bundle.manifest, null, 2) + '\n'),
  'scene-spec.json': bundle.sceneBytes, 'preview.png': bundle.previewBytes, LICENSE: readFileSync(join(baseline, 'LICENSE')) })) {
  if (process.argv.includes('--check')) assert.deepEqual(readFileSync(join(target, name)), bytes, `${name} differs from the linked speaker`)
  else writeFileSync(join(target, name), bytes)
}
console.log(`Modular speaker 2.1.0 ${process.argv.includes('--check') ? 'verified' : 'built'} from reviewed 2.0.0 assembly and pinned native pixels`)
