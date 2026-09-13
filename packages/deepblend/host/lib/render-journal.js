/**
 * Render journal tail — reading the child's progress without trusting it.
 *
 * WHAT THE JOURNAL IS, AND WHAT IT IS NOT
 * ---------------------------------------
 * `bootstrap.py --events <path>` appends one JSON line per event and fsyncs each
 * one, so the journal survives a `kill -9` of the Host. That makes it the right
 * channel for the two facts disk cannot express on its own:
 *
 *   - which pid is rendering (`process.json`, written before any bpy work), and
 *   - that frame N has been written AND verified by the renderer.
 *
 * It is **not** the authority for which frames exist. A frame can be present while
 * its journal line is missing (killed between the file landing and the line being
 * flushed), and a file can exist while not being a frame (killed mid-write). So
 * this module only says "the renderer claims frame N landed"; the caller verifies
 * that frame against its bytes before counting it (see `frame-ledger.js`).
 *
 * THE TORN-LINE RULE
 * ------------------
 * The journal is appended to by a process that can be killed at any instant, so
 * the last line may be a partial write. The reader must NOT advance past a line it
 * could not parse: the rest of that line arrives a moment later, and an offset
 * that skipped it would lose an event permanently. So the offset advances only to
 * the end of the last COMPLETE, parsed line.
 *
 * Owner: DeepBlend Studio — M3
 * Plane: Host composition
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

/** Cap on one read, so a pathological journal cannot be read in one allocation. */
const MAX_READ_BYTES = 4 * 1024 * 1024

export class JournalTail {
  /** @param {string} path */
  constructor(path) {
    this.path = path
    this.offset = 0
    /** Events already returned, so a caller can ask for the whole set. */
    this.events = []
    this.tornLineSeen = false
  }

  /**
   * Read every complete line appended since the last call.
   *
   * @returns {object[]} the newly parsed events, in order.
   */
  drain() {
    if (!existsSync(this.path)) return []
    let size
    try {
      size = statSync(this.path).size
    } catch {
      return []
    }
    if (size <= this.offset) return []

    const length = Math.min(size - this.offset, MAX_READ_BYTES)
    const buffer = Buffer.alloc(length)
    let descriptor = null
    try {
      descriptor = openSync(this.path, 'r')
      readSync(descriptor, buffer, 0, length, this.offset)
    } catch {
      return []
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor)
        } catch {
          /* already closed */
        }
      }
    }

    const text = buffer.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) {
      // Nothing complete yet. The offset stays put so the partial line is re-read
      // once it is finished — skipping it would lose the event for good.
      if (text.length > 0) this.tornLineSeen = true
      return []
    }

    const complete = text.slice(0, lastNewline + 1)
    const consumedBytes = Buffer.byteLength(complete, 'utf8')
    const fresh = []
    for (const line of complete.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        fresh.push(JSON.parse(line))
      } catch {
        // A line that is complete AND unparseable is not a torn write; it is a
        // writer bug. Recorded as a marker rather than dropped, because a journal
        // that silently loses an event is indistinguishable from one that never
        // had it.
        this.tornLineSeen = true
        fresh.push({ type: 'unparseable-line' })
      }
    }
    this.offset += consumedBytes
    this.events.push(...fresh)
    return fresh
  }

  /**
   * The frames the renderer has claimed, from the events read so far.
   * @returns {number[]}
   */
  claimedFrames() {
    const frames = []
    for (const event of this.events) {
      if (event?.type === 'frame' && Number.isSafeInteger(event.frame)) frames.push(event.frame)
    }
    return frames
  }

  /** Per-frame durations the renderer reported, for the remaining-time estimate. */
  frameDurations() {
    const durations = []
    for (const event of this.events) {
      if (event?.type === 'frame' && Number.isFinite(event.ms)) durations.push(event.ms)
    }
    return durations
  }
}
