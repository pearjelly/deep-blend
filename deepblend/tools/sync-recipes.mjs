#!/usr/bin/env node
/** Ship exactly the reviewed local recipes with the Host package. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateRecipePackage } from '../../packages/deepblend/contracts/lib/recipe.js'

const root = resolve(import.meta.dirname, '../..')
const source = join(root, 'deepblend/recipes'), target = join(root, 'packages/deepblend/host/recipes')
const check = process.argv.includes('--check')
let failed = false
for (const name of readdirSync(source).sort()) {
  const directory = join(source, name)
  const manifest = JSON.parse(readFileSync(join(directory, 'recipe.json')))
  const verdict = validateRecipePackage({ manifest, sceneBytes: readFileSync(join(directory, 'scene-spec.json')), previewBytes: readFileSync(join(directory, 'preview.png')) })
  if (!verdict.ok) throw new Error(`${name}: ${verdict.summary}`)
  for (const file of ['recipe.json', 'scene-spec.json', 'preview.png', 'LICENSE']) {
    const bytes = readFileSync(join(directory, file)), destination = join(target, name, file)
    if (check) {
      try { if (!readFileSync(destination).equals(bytes)) throw new Error('differs') }
      catch { console.error(`Recipe mirror differs: ${name}/${file}`); failed = true }
    } else { mkdirSync(join(target, name), { recursive: true }); writeFileSync(destination, bytes) }
  }
}
if (check) {
  const expected = readdirSync(source).sort(), actual = readdirSync(target).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) { console.error('Recipe package directories differ'); failed = true }
}
if (failed) process.exitCode = 1
else console.log(`Recipes validated and ${check ? 'mirrors verified' : 'mirrors written'}`)
