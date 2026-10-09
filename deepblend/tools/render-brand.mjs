#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ROOT } from './workspace-layout.mjs'

const base = join(ROOT, 'deepblend/docs/brand')
const packageAssets = join(ROOT, 'packages/deepblend/bundle/assets')
const manifestPath = join(base, 'manifest.json')
const tool = 'deepblend/tools/render-brand.mjs'
const sizes = { logo: [512,512], banner: [1440,520], 'social-card': [1280,640] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = process.argv.includes('--check')
if (!check) {
  // The Host declares and pins this renderer; reuse it without introducing another dependency.
  const require = createRequire(join(ROOT, 'packages/deepblend/host/package.json'))
  const sharp = require('sharp')
  const images = []
  mkdirSync(packageAssets, { recursive: true })
  for (const [name, [width, height]] of Object.entries(sizes)) {
    const source = `${name}.svg`, file = `${name}.png`
    const svg = readFileSync(join(base, source))
    await sharp(svg).png().toFile(join(base, file))
    const png = readFileSync(join(base, file))
    images.push({ source, sourceSha256: hash(svg), file, sha256: hash(png), bytes: png.length, width, height })
    for (const asset of [source, file]) copyFileSync(join(base, asset), join(packageAssets, asset))
  }
  const manifest = { schemaVersion: 'deepblend.brand-illustrations/v1', author: 'DeepBlend contributors',
    license: 'MIT', kind: 'original-workflow-illustration', productScreenshot: false, blenderRender: false,
    tool, renderer: 'sharp@0.35.5', images }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)+'\n')
  copyFileSync(manifestPath, join(packageAssets, 'manifest.json'))
}
const manifest = JSON.parse(readFileSync(manifestPath))
assert.equal(manifest.schemaVersion, 'deepblend.brand-illustrations/v1')
assert.equal(manifest.license, JSON.parse(readFileSync(join(ROOT, 'package.json'))).license)
assert.equal(manifest.tool, tool)
assert.equal(manifest.productScreenshot, false)
assert.equal(manifest.blenderRender, false)
assert.deepEqual(manifest.images.map(image => image.file).sort(), Object.keys(sizes).map(n => `${n}.png`).sort())
for (const image of manifest.images) {
  const svg = readFileSync(join(base, image.source)), png = readFileSync(join(base, image.file))
  assert.equal(hash(svg), image.sourceSha256, `${image.source}: source changed; run brand:render`)
  assert.equal(hash(png), image.sha256, `${image.file}: raster changed; run brand:render`)
  assert.equal(png.length, image.bytes)
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), image.width)
  assert.equal(png.readUInt32BE(20), image.height)
  assert.deepEqual([image.width,image.height], sizes[image.file.replace('.png','')])
  for (const name of [image.source, image.file]) assert.deepEqual(readFileSync(join(packageAssets, name)), readFileSync(join(base, name)), `${name}: package asset is stale`)
}
assert.deepEqual(readFileSync(join(packageAssets, 'manifest.json')), readFileSync(manifestPath))
console.log('brand: source hashes, PNG dimensions and package copies match')
