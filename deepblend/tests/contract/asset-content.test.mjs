#!/usr/bin/env node
/**
 * Asset content contract test — the second half of SPEC §15.2's "MIME 与扩展名双重校验".
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension picks the import operator, and until this round nothing looked at the bytes.
 * A file named `.glb` that is really a ZIP reached Blender, and the first thing to notice was
 * an importer failing several seconds later with a message about glTF rather than about the
 * file the user pointed at. The gate that fixes that is a pure function over the first 512
 * bytes, so it belongs here — no Blender, no subprocess, no fixtures on disk.
 *
 * THE ASYMMETRY IS THE DESIGN, AND IT IS WHAT THESE TESTS PIN
 * ----------------------------------------------------------
 * `contradicts` only when the bytes say out loud that they are something else. `inconclusive`
 * is a first-class answer, not a failure to decide: three of the six importable types have no
 * magic number at all, and a gate that guessed would eventually refuse somebody's legitimate
 * model. The tests below therefore assert the THREE-valued result rather than a boolean, and
 * half of them are about what does NOT get refused.
 *
 * Two bugs this file's expectations caught while it was being written, both worth keeping in
 * the record: the first version of `describeAssetContent` conflated "no signature matched" with
 * "a signature for an unimportable format matched" (so a ZIP named `.glb` read as *unknown*),
 * and the first version of the text test was "contains no NUL byte", which accepts binary
 * garbage that happens to have no zeros in it.
 *
 * Run: node deepblend/tests/contract/asset-content.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ASSET_HEAD_BYTES, assetContentVerdict, describeAssetContent } from '@deepblend/dsh-blender-contracts'

/** Bytes from a latin1 string, which is how the signatures are written. */
const bytes = text => Buffer.from(text, 'latin1')

/** A 12-byte Blender header: `BLENDER` then a pointer size and endianness. */
const BLEND_HEAD = bytes('BLENDER-v452')

test('the magic numbers of every importable type are recognised', () => {
  assert.equal(assetContentVerdict(bytes('glTF'), 'glb'), 'agrees')
  assert.equal(assetContentVerdict(BLEND_HEAD, 'blend'), 'agrees')
  assert.equal(assetContentVerdict(bytes('Kaydara FBX Binary  \u0000'), 'fbx'), 'agrees')
  assert.equal(assetContentVerdict(bytes('PXR-USDC'), 'usd'), 'agrees')
})

test('the three types with no magic number are satisfied by text', () => {
  // `.obj`, ascii `.usd` and `.gltf` are text, and there is nothing in the bytes to compare —
  // so the claim these tests make is the weaker, honest one: plausible text passes.
  assert.equal(assetContentVerdict(bytes('v 1.0 0 0 0\nf 1 2 3\n'), 'obj'), 'agrees')
  assert.equal(assetContentVerdict(bytes('#usda 1.0\n'), 'usd'), 'agrees')
  assert.equal(assetContentVerdict(bytes('{"asset":{"version":"2.0"}}'), 'gltf'), 'agrees')
  // …including text with the multi-byte characters a real file can carry.
  assert.equal(assetContentVerdict(Buffer.from('# 场景说明\n', 'utf8'), 'obj'), 'agrees')
})

test('a file that is a different format is contradicted, whatever it is named', () => {
  // The cases the extension check cannot see. Each is a real signature for something else.
  const cases = [
    [Buffer.concat([bytes('PK'), Buffer.from([3, 4]), bytes('rest')]), 'glb', 'a ZIP archive'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'glb', 'a PNG image'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'glb', 'a JPEG image'],
    [bytes('%PDF-1.7'), 'blend', 'a PDF'],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), 'blend', 'an ELF binary'],
    [bytes('MZ\u0090\u0000'), 'obj', 'a Windows executable'],
    [Buffer.from([0x1f, 0x8b, 0x08, 0x00]), 'glb', 'a gzip stream'],
    [Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), 'glb', 'a WebAssembly module'],
    // And the importable ones against each other: an `.obj` holding a `.blend` is the same
    // mistake in the other direction, and it is the one a person actually makes.
    [BLEND_HEAD, 'glb', null],
    [bytes('glTF'), 'obj', null],
  ]

  for (const [head, type, label] of cases) {
    assert.equal(
      assetContentVerdict(head, type),
      'contradicts',
      `${JSON.stringify(head.subarray(0, 8).toString('latin1'))} named .${type} should be refused`,
    )
    if (label !== null) {
      assert.equal(describeAssetContent(head).signature?.label, label, 'the refusal has to be able to say WHAT it found')
    }
  }
})

test('binary content in a text format is contradicted, NUL byte or not', () => {
  // The bug the second version of the text test fixed: "contains no zero byte" is not the same
  // claim as "is text". Bytes 1,2,3 contain no NUL and are not an OBJ file.
  assert.equal(assetContentVerdict(Buffer.from([0x01, 0x02, 0x03]), 'obj'), 'contradicts')
  assert.equal(assetContentVerdict(bytes('v 1.0\u0000f 1 2 3'), 'obj'), 'contradicts')
  // Tab, newline and carriage return are text; anything else below 0x20 is not.
  assert.equal(assetContentVerdict(bytes('v 1.0\r\n\tf 1 2 3'), 'obj'), 'agrees')
  assert.equal(assetContentVerdict(Buffer.from([0x1b, 0x5b, 0x30, 0x6d]), 'obj'), 'contradicts')
})

test('an empty file is refused: a zero-byte model is not a model', () => {
  assert.equal(assetContentVerdict(Buffer.alloc(0), 'glb'), 'contradicts')
  assert.equal(assetContentVerdict(Buffer.alloc(0), 'obj'), 'contradicts')
  assert.equal(describeAssetContent(Buffer.alloc(0)).empty, true)
})

test('what the gate cannot tell about, it passes', () => {
  // THE MOST IMPORTANT TEST IN THIS FILE. `inconclusive` is the answer for a binary format
  // whose magic did not match and which is not a known alternative either — a glTF binary with
  // an unusual header, a Blender file from a future version, a format this list has never
  // heard of. Refusing those would make this gate a source of false refusals, and deciding what
  // a model file really is stays Blender's job.
  assert.equal(assetContentVerdict(Buffer.from([0x01, 0x02, 0x03]), 'glb'), 'inconclusive')
  assert.equal(assetContentVerdict(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'blend'), 'inconclusive')
  assert.equal(assetContentVerdict(bytes('some prose that is not a model'), 'glb'), 'inconclusive')

  // …and the same bytes in a TEXT format are a different answer, because a text format has a
  // shape to fail: prose is text, so `.obj` passes, and byte soup is not, so `.obj` refuses.
  assert.equal(assetContentVerdict(bytes('some prose'), 'obj'), 'agrees')
})

test('the verdict reads no more of the file than it is given', () => {
  // The caller reads 512 bytes off disk (an asset may be a gigabyte). Nothing here may need
  // more than that, and a signature straddling the boundary must not be invented.
  assert.equal(typeof ASSET_HEAD_BYTES, 'number')
  const just = Buffer.alloc(ASSET_HEAD_BYTES, 0x41)
  BLEND_HEAD.copy(just, 0)
  assert.equal(assetContentVerdict(just, 'blend'), 'agrees')

  const truncated = BLEND_HEAD.subarray(0, 3)
  assert.equal(assetContentVerdict(truncated, 'blend'), 'inconclusive')
  assert.equal(assetContentVerdict(truncated, 'obj'), 'agrees')
})

test('the describe helper reports the two questions separately', () => {
  // `signature` answers "did a magic number match", `signature.format` answers "is it one we
  // can import". Collapsing them is the bug the first version had.
  const zip = describeAssetContent(Buffer.concat([bytes('PK'), Buffer.from([3, 4])]))
  assert.notEqual(zip.signature, null, 'a ZIP has a signature — it just is not an importable one')
  assert.equal(zip.signature.format, null)
  assert.equal(zip.text, false)

  const glb = describeAssetContent(bytes('glTF'))
  assert.equal(glb.signature.format, 'glb')

  const text = describeAssetContent(bytes('v 1.0'))
  assert.equal(text.signature, null)
  assert.equal(text.text, true)
})
