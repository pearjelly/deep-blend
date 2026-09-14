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
 * `tornLineSeen` says "the file ended mid-line as of the last read that reached the
 * end of it", and it is recomputed on every such read rather than latched: a tail
 * that completes on the next poll means the journal is whole, and a latched flag
 * would go on accusing the renderer of losing an event that arrived.
 *
 * That flag is what a kill between two writes leaves behind — and it is ALSO what a
 * line still being written looks like, so at read time the two are indistinguishable.
 * The flag is a fact about the file; `tornLineIsEvidence({stopped})` is where the
 * fact becomes reportable, and it takes the one thing only the caller knows: whether
 * the writer has stopped for good.
 *
 * A COMPLETE line that does not parse is a different fact — a writer bug, not a
 * torn kill — so it gets its own `unparseable-line` marker and does NOT raise the
 * torn flag. Reporting one as the other would name the wrong cause.
 *
 * Owner: DeepBlend Studio — M3
 * Plane: Host composition
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

import { BlenderWarningCode, warning } from '@deepblend/dsh-blender-contracts'

/** Cap on one read, so a pathological journal cannot be read in one allocation. */
const MAX_READ_BYTES = 4 * 1024 * 1024

export class JournalTail {
  /** @param {string} path */
  constructor(path) {
    this.path = path
    this.offset = 0
    /** Events already returned, so a caller can ask for the whole set. */
    this.events = []
    /** The file ended mid-line as of the last read that reached the end of it. */
    this.tornLineSeen = false
    /** The torn tail has already been reported, so it is not reported again. */
    this.tornReported = false
  }

  /**
   * Is the torn tail EVIDENCE yet — that is, should the caller report it?
   *
   * `tornLineSeen` is a fact about the file; this is where the fact becomes
   * reportable, and it needs one thing only the caller knows: whether the writer has
   * stopped. Mid-render an incomplete last line is the ordinary state of a line being
   * written, and a reader that called every one of those a kill would put a false
   * accusation in the log of every healthy render. Once the process is gone, the same
   * bytes mean the last event never arrived.
   *
   * True at most once per journal: a poll repeats every second, and a diagnostic that
   * repeats is noise. A `false` answer is not final, though — the caller asks again on
   * the next read, which is how a tail that is still being written gets its chance to
   * complete, and how one that never does gets reported once the writer is gone.
   *
   * @param {{stopped: boolean}} input - whether the writer has stopped for good.
   * @returns {boolean}
   */
  tornLineIsEvidence(input) {
    if (this.tornReported === true || this.tornLineSeen !== true) return false
    if (input?.stopped !== true) return false
    this.tornReported = true
    return true
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

    // Did this read reach the end of the FILE, or stop at the cap? Only a read that
    // reached the end can say anything about the tail: with bytes still unread, an
    // incomplete line here is the cap, not a torn write.
    const readToEnd = this.offset + length === size

    const text = buffer.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) {
      // Nothing complete yet. The offset stays put so the partial line is re-read
      // once it is finished — skipping it would lose the event for good.
      if (readToEnd) this.tornLineSeen = text.length > 0
      return []
    }
    // The flag describes the file as it stands NOW, so it is recomputed rather than
    // latched — and the ordinary torn case is a NON-EMPTY TAIL after the last newline,
    // which is what a kill between two writes leaves behind. Missing that case was a
    // real defect: the flag was raised only for a buffer with no complete line at all,
    // so a journal cut after frame 30 of 450 looked intact, and the host's "the journal
    // ends mid-line" line could not fire for the case it exists for. Recomputing also
    // keeps the opposite lie out: a tail that completes on the next poll means the
    // journal is whole, and a latched flag would still be accusing the renderer of
    // losing an event that arrived.
    if (readToEnd) this.tornLineSeen = lastNewline < text.length - 1

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
        // had it. Deliberately NOT `tornLineSeen`: the two have different causes,
        // and the caller says different things about them.
        fresh.push({ type: 'unparseable-line' })
      }
    }
    this.offset += consumedBytes
    this.events.push(...fresh)
    return fresh
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

/**
 * Does this event claim that a frame landed?
 *
 * "Claims" is the operative word: the renderer says frame N is done, and the caller
 * verifies that against the frame's BYTES before counting it (see `frame-ledger.js`).
 * The rule lives here, next to the format, because it had two copies in the host and
 * a copy in a test — three places to drift.
 *
 * (This replaces a `claimedFrames()` collector that handed back a list of unverified
 * frame numbers. Nothing called it, which is the only reason it was harmless: the
 * architecture says a claim is never the authority, so the collection of claims is
 * exactly the value no caller may act on. A predicate cannot be mistaken for a
 * ledger.)
 *
 * @param {unknown} event
 * @returns {boolean}
 */
export function isFrameClaim(event) {
  return event?.type === 'frame' && Number.isSafeInteger(event.frame)
}

/**
 * The warning this attempt earns when its journal was cut off mid-line, or `null`.
 *
 * WHY THE WHOLE DECISION IS HERE AND NOT AT THE CALL SITE
 * ------------------------------------------------------
 * It is four conditions in a row — the file ends mid-line, the writer has stopped, the kill was not
 * one the caller asked for, and it has not been said before — and the only place that can call it is
 * a background absorb inside a running Host. MEASURED, round 25: the end-to-end suite settles it
 * against the FILE, but a `SIGKILL` lands on a line boundary in practice (two runs, both clean), so
 * "torn, therefore recorded" is not reachable on demand there, and the branch that writes the warning
 * would never be exercised. A rule whose only exercise is luck is a rule nobody has checked, so it
 * lives where the contract suite can drive all four conditions by hand.
 *
 * A kill the caller ASKED for is not a finding: `cancelJob` terminates the process group on purpose,
 * and a journal cut in half is the expected consequence of that. That check comes FIRST so a
 * cancelled absorb does not consume the once-only flag of a journal that is genuinely torn.
 *
 * @param {JournalTail} journal
 * @param {{stopped: boolean, cancelled?: boolean, jobId?: string, attemptToken?: string|null}} input
 * @returns {{code: string, message: string, detail?: object}|null}
 */
export function incompleteJournalWarning(journal, input) {
  if (input?.cancelled === true) return null
  if (journal?.tornLineIsEvidence({ stopped: input?.stopped === true }) !== true) return null
  const detail = {}
  if (input?.jobId !== undefined) detail.jobId = input.jobId
  if (input?.attemptToken !== undefined && input.attemptToken !== null) detail.attemptToken = input.attemptToken
  return warning(
    BlenderWarningCode.JOURNAL_INCOMPLETE,
    'an attempt at this job was cut off mid-line in its event journal (a kill between the write and the ' +
      'flush), so the last event the renderer sent never arrived. Frame progress and the resumed frame ' +
      'set are read from the frame files themselves, so no count here is affected.',
    Object.keys(detail).length > 0 ? detail : undefined,
  )
}
