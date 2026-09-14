/**
 * What a file's first bytes say it is — the content half of SPEC §15.2's
 * "MIME 与扩展名双重校验".
 *
 * WHY THIS EXISTS
 * ---------------
 * The extension check (`IMPORT_OPERATOR_BY_ASSET_TYPE`) decides which import operator a file
 * gets, and it trusts the NAME. That is fine as far as it goes — Blender classifies the import
 * behaviourally and a file that is not really a glTF fails as a branchable result (D10) — but
 * it means the first thing that notices "this `.glb` is actually a ZIP" is a Blender launch
 * that fails several seconds later, with a message about the importer rather than about the
 * file. This module is the cheap gate in front of that: 512 bytes, no subprocess, decided
 * before anything is copied into the project.
 *
 * THE RULE IS ASYMMETRIC ON PURPOSE
 * ---------------------------------
 * It refuses only when the bytes POSITIVELY CONTRADICT the extension — a known signature for
 * a different format, a NUL byte in a format that must be text, or an empty file. Anything it
 * cannot tell about is `inconclusive` and passes, because the alternative (a matcher clever
 * enough to be sure) is also a matcher clever enough to reject somebody's legitimate model.
 * Three of the six importable types have no magic number at all: `.obj` and ascii `.usd` are
 * text, and `.gltf` is JSON.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a security boundary. It cannot tell a real glTF from a crafted one, and it is not meant
 * to: DECIDING what a file is remains Blender's job, and this only refuses the cases where the
 * file says out loud that it is something else.
 *
 * Owner: DeepBlend Studio — M5
 */

/** How many bytes of a file this needs. Enough for a text sniff, small enough to be free. */
export const ASSET_HEAD_BYTES = 512

/**
 * The signatures worth knowing, in one table.
 *
 * `format` is the asset type a signature belongs to, or `null` for a format this product
 * cannot import — which is the interesting half: a ZIP or a PNG inside a `.glb` is exactly the
 * case the extension check cannot see.
 */
const SIGNATURES = Object.freeze([
  // Importable types.
  { format: 'glb', magic: 'glTF', at: 0 },
  { format: 'blend', magic: 'BLENDER', at: 0 },
  { format: 'fbx', magic: 'Kaydara FBX Binary', at: 0 },
  { format: 'usd', magic: 'PXR-USDC', at: 0 },
  // Everything else that is common enough to name, all of it a contradiction for any of the
  // six importable types.
  { format: null, magic: 'PK\u0003\u0004', at: 0, label: 'a ZIP archive' },
  { format: null, magic: '\u0089PNG\r\n\u001a\n', at: 0, label: 'a PNG image' },
  { format: null, magic: '\u00ff\u00d8\u00ff', at: 0, label: 'a JPEG image' },
  { format: null, magic: '%PDF', at: 0, label: 'a PDF' },
  { format: null, magic: '\u007fELF', at: 0, label: 'an ELF binary' },
  { format: null, magic: 'MZ', at: 0, label: 'a Windows executable' },
  { format: null, magic: '\u001f\u008b', at: 0, label: 'a gzip stream' },
  { format: null, magic: 'RIFF', at: 0, label: 'a RIFF container' },
  { format: null, magic: 'OggS', at: 0, label: 'an Ogg stream' },
  { format: null, magic: 'ID3', at: 0, label: 'an MP3' },
  { format: null, magic: 'ftyp', at: 4, label: 'an ISO base media file (MP4/MOV)' },
  { format: null, magic: '\u0000asm', at: 0, label: 'a WebAssembly module' },
])

/** Asset types whose content is text and must therefore contain no NUL byte. */
const TEXT_TYPES = Object.freeze(['obj', 'gltf', 'usd', 'fbx'])

/** The label a contradiction reports, from the signature it matched. */
function labelFor(entry) {
  return entry.label ?? `a ${entry.format} file`
}

/** Does `head` begin with `magic` at `at`? Bytes, never a decoded string. */
function startsWith(head, magic, at) {
  const needle = Buffer.from(magic, 'latin1')
  if (head.length < at + needle.length) return false
  return head.subarray(at, at + needle.length).equals(needle)
}

/** Bytes a text file may legitimately contain besides the printable range. */
const PRINTABLE_EXCEPTIONS = Object.freeze([0x09, 0x0a, 0x0d])

/**
 * What the bytes say, independently of the name.
 *
 * `signature` is the whole verdict about magic numbers: an entry MATCHED, and whether the
 * format it belongs to is importable is a separate question — `format: null` in the table
 * means "a known format this product cannot import". Collapsing those two, "no signature
 * matched" and "a signature for something else matched", is the bug the first version of this
 * function had: it made a ZIP named `.glb` read as *unknown* rather than as a ZIP.
 *
 * @param {Uint8Array|Buffer} head - the first bytes of the file (`ASSET_HEAD_BYTES` is enough)
 * @returns {{ signature: {format: string|null, label: string}|null, text: boolean, empty: boolean }}
 */
export function describeAssetContent(head) {
  const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head ?? [])
  const empty = bytes.length === 0
  for (const entry of SIGNATURES) {
    if (startsWith(bytes, entry.magic, entry.at)) {
      return { signature: { format: entry.format, label: labelFor(entry) }, text: false, empty }
    }
  }
  // Text, for the purposes of this gate, is bytes a text file can contain: the printable
  // range, UTF-8 continuation bytes, and tab/newline/CR. A NUL fails that, and so does binary
  // garbage that merely happens to contain no NUL — which is what the second version of this
  // function learned, because "contains no zero byte" is not the same claim as "is text".
  const text = !empty && bytes.every(byte => byte >= 0x20 || PRINTABLE_EXCEPTIONS.includes(byte))
  return { signature: null, text, empty }
}

/**
 * Does the content agree with the extension?
 *
 * @param {Uint8Array|Buffer} head
 * @param {string} type - an asset type from `IMPORT_OPERATOR_BY_ASSET_TYPE`
 * @returns {'agrees'|'contradicts'|'inconclusive'}
 */
export function assetContentVerdict(head, type) {
  const described = describeAssetContent(head)

  if (described.empty) return 'contradicts'
  if (described.signature !== null) {
    // A signature for THIS type agrees. A signature for anything else contradicts — including
    // for another importable type, which is how a `.obj` holding a `.blend` reads, and
    // including for a format this product cannot import at all, which is how a ZIP named
    // `.glb` reads.
    return described.signature.format === type ? 'agrees' : 'contradicts'
  }
  // No signature. Text formats are satisfied by text; a binary format is not satisfied by
  // anything (its magic was required and did not match), but it is not contradicted either,
  // so it stays inconclusive rather than being refused on a guess.
  if (TEXT_TYPES.includes(type)) return described.text ? 'agrees' : 'contradicts'
  return 'inconclusive'
}
