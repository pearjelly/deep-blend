/**
 * Frame ledger — what a render job has actually delivered, read off disk.
 *
 * THE RULE THIS MODULE EXISTS FOR
 * -------------------------------
 * **The frames are the authority; the job record's `completedFrames[]` is a cache
 * of that authority and may never overrule it.**
 *
 * The M3 restart probe measured why this matters. A `kill -9` of the process that
 * started a render left three facts behind:
 *
 *   1. the Blender child SURVIVED (it is spawned `detached`, so it leads its own
 *      process group) and was still writing into the directory a recovery was
 *      about to describe;
 *   2. the child's `events.jsonl` journal was intact up to its last fsynced line —
 *      a fact about the journal, not about the frames;
 *   3. a process killed between `create` and `finish` leaves a file that EXISTS
 *      and is not a frame.
 *
 * So a record that said "frames 1..3 are done" would have been right by luck, and
 * a record that trusted file existence would have been wrong whenever the kill
 * landed mid-write. This module reads the frames.
 *
 * WHY IT SAMPLES RATHER THAN READS
 * --------------------------------
 * A 450-frame delivery is ~424 MiB. The ledger is rebuilt on every recovery and
 * on every progress tick, so reading all of it would cost more than the render.
 * `inspectFrameSample` in the contracts package decides the question from a stat
 * plus 45 bytes per frame — the PNG signature and IHDR at the front, the IEND
 * trailer at the back — which is the same question answered from the artifact.
 *
 * Owner: DeepBlend Studio — M3
 * Plane: Host composition
 */

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  frameFileName,
  inspectFrameSample as inspectFrameSampleFromContracts,
  resolveFrameLedger,
} from '@deepblend/dsh-blender-contracts'

/** Bytes of the file read from the front. Covers the signature and the IHDR. */
const HEAD_BYTES = 33
/** Bytes of the file read from the back. Covers a whole IEND chunk and its CRC. */
const TAIL_BYTES = 12

/**
 * Sample one frame without reading it.
 *
 * `exists` is part of the result and not inferable from `size`, and that is a
 * measured fix rather than tidiness: an ABSENT file and an EMPTY file both have
 * size 0, so a reader that only saw the size reported every missing frame as
 * "empty" — a corrupt frame. The render set came out right by luck (both are
 * re-rendered), but the diagnosis was wrong, so a status line saying "3 absent"
 * where the truth was "3 corrupt" was a lie the type system could not catch.
 *
 * @param {string} path
 * @returns {{exists: boolean, size: number, header?: Buffer, tail?: Buffer}}
 */
export function sampleFrame(path) {
  let size
  try {
    size = statSync(path).size
  } catch {
    return { exists: false, size: 0 }
  }
  let descriptor = null
  try {
    descriptor = openSync(path, 'r')
    const header = Buffer.alloc(Math.min(HEAD_BYTES, size))
    if (header.length > 0) readSync(descriptor, header, 0, header.length, 0)
    const tailLength = Math.min(TAIL_BYTES, size)
    const tail = Buffer.alloc(tailLength)
    if (tailLength > 0) readSync(descriptor, tail, 0, tailLength, size - tailLength)
    return { exists: true, size, header, tail }
  } catch {
    // An unreadable file is a fact to report, not an exception to escape this
    // function: the ledger's whole job is to describe the directory truthfully.
    // It EXISTS — the stat succeeded — and its bytes could not be read.
    return { exists: true, size }
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Not for "already closed" — the descriptor was opened here and nothing else closes it. It is here
        // because a throw inside `finally` REPLACES the error being propagated, and the caller needs the read
        // failure rather than a close failure.
      }
    }
  }
}

/**
 * Build the ledger for one job's frames.
 *
 * @param {object} input
 * @param {string} input.framesDirectory - absolute path of the frames directory.
 * @param {number[]} input.expected - every frame this job is responsible for.
 * @param {{width?: number, height?: number, prefix?: string, padding?: number}} [input.expectedSize]
 * @returns {{present: object[], corrupt: object[], missing: number[], toRender: number[],
 *   presentCount: number, corruptCount: number, missingCount: number, toRenderCount: number}}
 */
/**
 * The same decision applied to one frame, re-exported so a caller that is
 * verifying a single claimed frame (the progress path) does not have to build a
 * whole ledger to ask about it.
 *
 * @param {{size: number, header?: Buffer, tail?: Buffer}} sample
 * @param {{width?: number, height?: number}} [expected]
 */
export function inspectFrameSample(sample, expected = {}) {
  return inspectFrameSampleFromContracts(sample, expected)
}

/**
 * Build the ledger for one job's frames.
 *
 * @param {object} input
 * @param {string} input.framesDirectory - absolute path of the frames directory.
 * @param {number[]} input.expected - every frame this job is responsible for.
 * @param {{width?: number, height?: number, prefix?: string, padding?: number}} [input.expectedSize]
 * @returns {{present: object[], corrupt: object[], missing: number[], toRender: number[],
 *   presentCount: number, corruptCount: number, missingCount: number, toRenderCount: number}}
 */
export function readFrameLedger(input) {
  const prefix = input.expectedSize?.prefix ?? 'frame_'
  const padding = input.expectedSize?.padding ?? 4
  /** @type {Map<number, {ok: boolean, reason?: string|null, bytes?: number}>} */
  const observed = new Map()
  for (const frame of input.expected) {
    const path = join(input.framesDirectory, frameFileName(frame, prefix, padding))
    const sample = sampleFrame(path)
    // An absent frame is left OUT of the observation map rather than recorded as a
    // zero-byte file: `resolveFrameLedger` reports what it does not observe as
    // MISSING, which is a different fact from a present-but-incomplete frame and
    // the two lead a reader to different actions.
    if (sample.exists !== true) continue
    const verdict = inspectFrameSample(sample, {
      width: input.expectedSize?.width,
      height: input.expectedSize?.height,
    })
    observed.set(frame, { ok: verdict.ok, reason: verdict.reason, bytes: verdict.bytes })
  }
  const ledger = resolveFrameLedger({ expected: input.expected, observed })
  return {
    ...ledger,
    presentCount: ledger.present.length,
    corruptCount: ledger.corrupt.length,
    missingCount: ledger.missing.length,
    toRenderCount: ledger.toRender.length,
  }
}

/**
 * Every PNG present in a frames directory, as frame numbers.
 *
 * Used only for DIAGNOSIS — reporting frames on disk that this job does not
 * expect. It is deliberately not part of the ledger: a directory listing cannot
 * tell a complete frame from a torn one, and it cannot tell a frame of THIS job
 * from a leftover of another.
 *
 * Directory ENTRIES are skipped, which is a measured fix: a directory named
 * `frame_0004.png` was listed here as a frame on disk, and the listing is the one
 * place a reader looks to see whether the frames are really there. What the entry
 * RESOLVES to is a question for the ledger (`sampleFrame` follows links and reads
 * bytes), so a symlink to a PNG is still listed — it is a usable frame.
 *
 * @param {string} framesDirectory
 * @param {{prefix?: string}} [options]
 * @returns {number[]}
 */
export function framesOnDisk(framesDirectory, options = {}) {
  if (!existsSync(framesDirectory)) return []
  const prefix = options.prefix ?? 'frame_'
  const found = []
  for (const entry of readdirSync(framesDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) continue
    const name = entry.name
    if (!name.startsWith(prefix) || !name.endsWith('.png')) continue
    const digits = name.slice(prefix.length, -4)
    if (!/^\d+$/.test(digits)) continue
    found.push(Number.parseInt(digits, 10))
  }
  return found.sort((left, right) => left - right)
}
