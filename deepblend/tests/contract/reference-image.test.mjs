import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import sharp from 'sharp'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import {
  inspectReferenceImage, REFERENCE_IMAGE_MAX_BYTES, REFERENCE_IMAGE_MAX_PIXELS, REFERENCE_IMAGE_MAX_EDGE,
} from '../../../packages/deepblend/host/lib/reference-image.js'
import { ROOT, linkPathFor, linkTarget, linkTargets, localPackages, registryTarget, registryVersion, requiredSpecifiers } from '../../tools/workspace-layout.mjs'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const sha256 = data => createHash('sha256').update(data).digest('hex')
// Independent small fixture encoder: preserve 16-bit samples and construct
// damaged IDAT streams with valid container CRCs, rather than testing only files
// the production decoder itself generated.
function chunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const output = Buffer.alloc(data.length + 12)
  output.writeUInt32BE(data.length)
  body.copy(output, 4)
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
  return output
}
function header(width, height, depth = 8, color = 6) {
  const data = Buffer.alloc(13)
  data.writeUInt32BE(width)
  data.writeUInt32BE(height, 4)
  data[8] = depth
  data[9] = color
  return chunk('IHDR', data)
}
function pngFixture({ width = 1, height = 1, depth = 8, color = 6, pixels, compressed, extras = [] } = {}) {
  return Buffer.concat([signature, header(width, height, depth, color), ...extras,
    chunk('IDAT', compressed ?? deflateSync(pixels ?? Buffer.from([0, 180, 90, 30, 127]))), chunk('IEND')])
}
const png = pngFixture()
const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#987654' } }).jpeg().toBuffer()
const rejects = (data, code, options) => assert.rejects(inspectReferenceImage(data, options), error => {
  assert.ok(error instanceof BlenderError)
  assert.equal(error.code, BlenderErrorCode[code])
  return true
})

test('limits are explicit compressed-byte, decimal-pixel and edge bounds', () => {
  assert.equal(REFERENCE_IMAGE_MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(REFERENCE_IMAGE_MAX_PIXELS, 16_000_000)
  assert.equal(REFERENCE_IMAGE_MAX_EDGE, 8192)
})

test('a real transparent PNG returns exact source provenance without changing the bytes', async () => {
  const original = Buffer.from(png)
  assert.deepEqual(await inspectReferenceImage(png, { name: 'Reference.PNG', mediaType: 'IMAGE/PNG' }), {
    type: 'png', mime: 'image/png', width: 1, height: 1, bytes: png.length, sha256: sha256(png),
  })
  assert.deepEqual(png, original)
})

for (const extension of ['jpg', 'jpeg', 'JPG', 'JPEG']) {
  test(`JPEG accepts .${extension} with the canonical image/jpeg MIME`, async () => {
    assert.deepEqual(await inspectReferenceImage(jpeg, { name: `photo.${extension}`, mediaType: 'image/jpeg' }), {
      type: extension.toLowerCase(), mime: 'image/jpeg', width: 32, height: 24, bytes: jpeg.length, sha256: sha256(jpeg),
    })
  })
}

test('omitted declarations infer PNG or canonical jpg from complete content', async () => {
  assert.equal((await inspectReferenceImage(png)).type, 'png')
  assert.equal((await inspectReferenceImage(new Uint8Array(jpeg))).type, 'jpg')
})

test('the asynchronous inspector owns a snapshot of mutable caller bytes', async () => {
  const data = Buffer.from(png)
  const pending = inspectReferenceImage(data)
  data.fill(0)
  assert.equal((await pending).sha256, sha256(png))
})

test('palette transparency, 16-bit RGBA and interlaced PNG are fully decoded', async () => {
  const palette = await sharp(png).png({ palette: true }).toBuffer()
  assert.equal((await sharp(palette).metadata()).isPalette, true)
  const sixteenBit = pngFixture({ depth: 16, pixels: Buffer.from([0, 255, 255, 128, 0, 64, 0, 128, 0]) })
  assert.equal((await sharp(sixteenBit).metadata()).bitsPerSample, 16)
  const interlaced = await sharp({ create: { width: 20, height: 17, channels: 4, background: '#12345680' } })
    .png({ progressive: true }).toBuffer()
  assert.equal((await sharp(interlaced).metadata()).isProgressive, true)
  for (const data of [palette, sixteenBit, interlaced]) {
    const image = await inspectReferenceImage(data, { name: 'source.png' })
    assert.equal(image.sha256, sha256(data))
    assert.equal(image.bytes, data.length)
  }
})

test('progressive, greyscale and CMYK JPEG retain their original hash', async () => {
  const progressive = await sharp(jpeg).jpeg({ progressive: true }).toBuffer()
  assert.equal((await sharp(progressive).metadata()).isProgressive, true)
  const grey = await sharp(jpeg).greyscale().jpeg().toBuffer()
  const cmyk = await sharp(jpeg).toColourspace('cmyk').jpeg().toBuffer()
  for (const data of [progressive, grey, cmyk]) assert.equal((await inspectReferenceImage(data)).sha256, sha256(data))
})

test('EXIF orientation does not silently re-encode or change stored pixel dimensions', async () => {
  const portrait = await sharp(jpeg).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  const image = await inspectReferenceImage(portrait)
  assert.deepEqual([image.width, image.height, image.sha256], [32, 24, sha256(portrait)])
})

test('extension, declared MIME and signature must agree', async () => {
  for (const [data, options] of [
    [png, { name: 'photo.jpg' }], [jpeg, { name: 'photo.png' }],
    [png, { mediaType: 'image/jpeg' }], [jpeg, { mediaType: 'image/png' }],
    [png, { name: 'photo.png', mediaType: 'image/jpeg' }],
  ]) await rejects(data, 'ASSET_CONTENT_MISMATCH', options)
})

test('unsupported names, MIME declarations and non-byte input have typed request errors', async () => {
  for (const options of [{ name: 'image.webp' }, { name: 'image' }, { name: '' }, { name: 2 },
    { mediaType: 'image/gif' }, { mediaType: 'application/octet-stream' }, { mediaType: 2 }]) {
    await rejects(png, 'ASSET_REQUEST_INVALID', options)
  }
  for (const data of ['', 'image.png', null, {}, Buffer.alloc(0)]) await rejects(data, 'ASSET_REQUEST_INVALID')
})

test('unsupported actual content cannot masquerade as PNG or JPEG', async () => {
  const webp = await sharp(png).webp().toBuffer()
  for (const data of [webp, Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from('not an image')]) {
    await rejects(data, 'ASSET_CONTENT_MISMATCH', { name: 'image.png' })
  }
})

test('over-8-MiB payloads are rejected before decoding', async () => {
  await rejects(Buffer.alloc(REFERENCE_IMAGE_MAX_BYTES + 1), 'ASSET_TOO_LARGE')
})

test('a valid PNG exactly at the compressed byte limit remains valid', async () => {
  const data = pngFixture({ extras: [chunk('npAD', Buffer.alloc(REFERENCE_IMAGE_MAX_BYTES - png.length - 12))] })
  assert.equal(data.length, REFERENCE_IMAGE_MAX_BYTES)
  assert.equal((await inspectReferenceImage(data)).bytes, REFERENCE_IMAGE_MAX_BYTES)
})

test('the 8192-pixel edge is inclusive and applies to both axes', async () => {
  const valid = await sharp({ create: { width: 8192, height: 1, channels: 3, background: '#335577' } }).png().toBuffer()
  assert.equal((await inspectReferenceImage(valid)).width, 8192)
  for (const dimensions of [{ width: 8193 }, { height: 8193 }]) {
    await rejects(pngFixture(dimensions), 'ASSET_TOO_LARGE')
  }
})

test('metadata that exceeds 16 MP is rejected before incomplete pixel data is decoded', async () => {
  const tooManyPixels = pngFixture({ width: 4000, height: 4001 })
  assert.equal((await sharp(tooManyPixels).metadata()).height, 4001)
  await rejects(tooManyPixels, 'ASSET_TOO_LARGE')
})

test('the 16 MP pixel limit is inclusive for a fully decoded image', async () => {
  const boundary = await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#335577' } }).png().toBuffer()
  const result = await inspectReferenceImage(boundary)
  assert.deepEqual([result.width, result.height], [4000, 4000])
  assert.equal(result.width * result.height, REFERENCE_IMAGE_MAX_PIXELS)
})

test('PNG checksum corruption, incomplete container and trailing content are rejected', async () => {
  const crcDamage = Buffer.from(png)
  crcDamage[crcDamage.length - 1] ^= 1
  for (const data of [crcDamage, png.subarray(0, 24), png.subarray(0, -1), png.subarray(0, -12),
    Buffer.concat([png, png]), Buffer.concat([png, Buffer.from('junk')])]) {
    await rejects(data, 'ASSET_CONTENT_MISMATCH')
  }
})

test('PNG metadata success cannot conceal a corrupt compressed pixel stream', async () => {
  const damaged = pngFixture({ compressed: Buffer.from([120, 156, 255, 255, 255, 255]) })
  assert.equal((await sharp(damaged).metadata()).width, 1, 'the fixture must pass metadata-only validation')
  await rejects(damaged, 'ASSET_CONTENT_MISMATCH')
})

test('JPEG truncation, trailing bytes and concatenated images are rejected', async () => {
  for (const data of [jpeg.subarray(0, 8), jpeg.subarray(0, -2), jpeg.subarray(0, -1),
    Buffer.concat([jpeg, jpeg]), Buffer.concat([jpeg, Buffer.from('junk')])]) {
    await rejects(data, 'ASSET_CONTENT_MISMATCH')
  }
})

test('JPEG metadata success cannot conceal a truncated scan even with an EOI marker', async () => {
  const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]))
  assert.ok(scan > 0)
  const start = scan + 2 + jpeg.readUInt16BE(scan + 2)
  const damaged = Buffer.concat([jpeg.subarray(0, start + 1), Buffer.from([0xff, 0xd9])])
  assert.equal((await sharp(damaged).metadata()).width, 32, 'the fixture must pass metadata-only validation')
  await rejects(damaged, 'ASSET_CONTENT_MISMATCH')
})

test('a real two-frame APNG container cannot silently become its first frame', async () => {
  const animation = Buffer.alloc(8)
  animation.writeUInt32BE(2)
  function frame(sequence) {
    const data = Buffer.alloc(26)
    data.writeUInt32BE(sequence)
    data.writeUInt32BE(1, 4)
    data.writeUInt32BE(1, 8)
    data.writeUInt16BE(1, 20)
    data.writeUInt16BE(24, 22)
    return chunk('fcTL', data)
  }
  const pixels = deflateSync(Buffer.from([0, 180, 90, 30, 127]))
  const sequence = Buffer.alloc(4)
  sequence.writeUInt32BE(2)
  const apng = Buffer.concat([signature, header(1, 1), chunk('acTL', animation), frame(0), chunk('IDAT', pixels),
    frame(1), chunk('fdAT', Buffer.concat([sequence, pixels])), chunk('IEND')])
  assert.equal((await sharp(apng).metadata()).format, 'png')
  await rejects(apng, 'ASSET_REQUEST_INVALID')
})

test('JPEG MPF multi-picture declarations are explicitly refused', async () => {
  const mpf = Buffer.from([0xff, 0xe2, 0, 6, 77, 80, 70, 0])
  const data = Buffer.concat([jpeg.subarray(0, 2), mpf, jpeg.subarray(2)])
  await rejects(data, 'ASSET_REQUEST_INVALID')
})

test('Host declares and the isolated runtime pins the codec, including native optional packages', () => {
  const host = JSON.parse(readFileSync(join(ROOT, 'packages/deepblend/host/package.json')))
  const runtime = JSON.parse(readFileSync(join(ROOT, 'deepblend/development/runtime/package.json')))
  const lock = JSON.parse(readFileSync(join(ROOT, 'deepblend/development/runtime/package-lock.json')))
  assert.equal(host.dependencies.sharp, '0.35.5')
  assert.equal(runtime.dependencies.sharp, host.dependencies.sharp)
  assert.equal(lock.packages[''].dependencies.sharp, host.dependencies.sharp)
  assert.equal(lock.packages['node_modules/sharp'].version, host.dependencies.sharp)
  assert.ok(lock.packages['node_modules/sharp'].optionalDependencies['@img/sharp-linux-x64'])
  assert.ok(lock.packages['node_modules/sharp'].optionalDependencies['@img/sharp-darwin-arm64'])
  assert.equal(sharp.versions.sharp, host.dependencies.sharp)
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /run: node deepblend\/tools\/development\.mjs setup --github-env/)
})

test('workspace links explicitly declared libraries without classifying them as DSH plugins', () => {
  const local = localPackages()
  const specifiers = requiredSpecifiers(local)
  assert.ok(specifiers.registry.includes('sharp'))
  assert.ok(!specifiers.external.includes('sharp'))
  assert.ok(!specifiers.internal.includes('sharp'))
  assert.equal(linkPathFor('sharp'), join(ROOT, 'node_modules/sharp'))
  const root = mkdtempSync(join(tmpdir(), 'deepblend-codec-links-'))
  try {
    const scopes = [join(root, 'nested/node_modules/@deepseek-ai'), join(root, 'outer/node_modules/@deepseek-ai')]
    const codec = join(dirname(scopes[1]), 'sharp')
    mkdirSync(codec, { recursive: true })
    writeFileSync(join(codec, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.35.5' }))
    assert.equal(registryTarget('sharp', scopes), codec)
    assert.deepEqual(linkTargets({ internal: [], external: [], registry: ['sharp'], local, scopes }),
      [{ specifier: 'sharp', target: codec, requiredVersion: '0.35.5' }])
    assert.equal(registryVersion('sharp', local), '0.35.5')
    const older = join(dirname(scopes[0]), 'sharp')
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, 'package.json'), JSON.stringify({ name: 'sharp', version: '0.34.0' }))
    assert.equal(registryTarget('sharp', scopes, '0.35.5'), codec, 'explicit pin wins over a nested DSH transitive version')
    assert.equal(registryTarget('sharp', [scopes[0]], '0.35.5'), older, 'the mismatch target is retained for a named diagnostic')
    assert.equal(registryTarget('missing-library', scopes), join(dirname(scopes[0]), 'missing-library'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('importing the inspector does not load the native codec', () => {
  // Run with native addons disabled: importing sharp eagerly would fail before
  // this script could report the exported function. No globals are modified.
  const probe = spawnSync(process.execPath, ['--no-addons', '--input-type=module', '-e',
    "const m = await import('./packages/deepblend/host/lib/reference-image.js'); console.log(typeof m.inspectReferenceImage)"],
  { cwd: ROOT, encoding: 'utf8' })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout.trim(), 'function')
})

test('both setup modes refuse a deployment codec version mismatch before changing links', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepblend-codec-version-'))
  const before = linkTarget(linkPathFor('sharp'))
  try {
    mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true })
    mkdirSync(join(root, 'node_modules/sharp'), { recursive: true })
    writeFileSync(join(root, 'node_modules/sharp/package.json'), JSON.stringify({ name: 'sharp', version: '0.34.0' }))
    for (const args of [[], ['--check']]) {
      const probe = spawnSync(process.execPath, [join(ROOT, 'deepblend/tools/link-workspace.mjs'), ...args], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, DEEPBLEND_DSH_ROOT: root, PATH: '' },
      })
      assert.equal(probe.status, 2, probe.stdout + probe.stderr)
      assert.match(probe.stderr, /sharp: VERSION MISMATCH; requires 0\.35\.5, found 0\.34\.0/)
      assert.ok(probe.stderr.includes(join(root, 'node_modules/sharp')))
      assert.equal(linkTarget(linkPathFor('sharp')), before)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
