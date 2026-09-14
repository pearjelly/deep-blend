#!/usr/bin/env node
/**
 * Journal contract test — the renderer's event stream, and the rule that an event is never lost.
 *
 * WHY THIS EXISTS
 * ---------------
 * A coverage reading (`tools/coverage-probe.mjs`, `docs/probe-coverage.log`) said most of
 * `render-journal.js` had never been executed by the acceptance suite — and what was dark was not
 * incidental. It was `drain()`'s three hard cases, written down in the module's own header:
 *
 *   - the last line may be a PARTIAL write, because the renderer can be killed at any instant, and
 *     the reader must not advance past it: "an offset that skipped it would lose an event
 *     permanently";
 *   - a line can be complete AND unparseable, which is not a torn write but a writer bug, and it is
 *     "recorded as a marker rather than dropped, because a journal that silently loses an event is
 *     indistinguishable from one that never had it";
 *   - a read is capped, so a journal that outgrows one allocation is read in pieces.
 *
 * Three rules, all about not losing things, none of them ever executed. This file executes them.
 *
 * WRITING THEM FOUND TWO DEFECTS, which is the reason the file is worth its length:
 *
 *   - the torn flag was raised only for a read buffer with no complete line at all, so a render
 *     killed after frame 30 of 450 looked like an intact journal, and the host's "the journal ends
 *     mid-line" line could never fire for the case it was written for;
 *   - a complete-but-unparseable line raised the SAME flag, so a writer bug would have been reported
 *     to the user as "the renderer was killed mid-write" — the wrong cause, stated as fact.
 *
 * Both are now rules of their own (`tornLineIsEvidence`, one flag per fact) and both are pinned below.
 *
 * Run: node deepblend/tests/contract/render-journal.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JournalTail, incompleteJournalWarning, isFrameClaim } from '@deepblend/dsh-blender-host'

/** A scratch journal path, removed when the test file finishes. */
const scratch = mkdtempSync(join(tmpdir(), 'deepblend-journal-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
/** A journal file with the given initial text. @returns {JournalTail} */
function journalWith(text = '', name = `events-${(counter += 1)}.jsonl`) {
  const path = join(scratch, name)
  writeFileSync(path, text)
  return new JournalTail(path)
}

const line = event => `${JSON.stringify(event)}\n`

test('a journal that does not exist yet reads as nothing, not as a failure', () => {
  // The renderer creates the file a moment after the job record exists, so this is the ordinary
  // state of a job that just started.
  const journal = new JournalTail(join(scratch, 'does-not-exist.jsonl'))
  assert.deepEqual(journal.drain(), [])
  assert.deepEqual(journal.events, [])
})

test('every complete line is returned exactly once', () => {
  const journal = journalWith(line({ type: 'start' }) + line({ type: 'frame', frame: 1, ms: 1200 }))

  const first = journal.drain()
  assert.equal(first.length, 2, 'both lines should come back on the first read')
  assert.deepEqual(first[0], { type: 'start' })
  assert.deepEqual(first[1], { type: 'frame', frame: 1, ms: 1200 })

  // The offset advanced past them: a second read has nothing to add, which is what stops the
  // progress tick from re-reporting every frame on every poll.
  assert.deepEqual(journal.drain(), [])
  assert.equal(journal.events.length, 2, 'the tail keeps every event it has ever returned')
})

test('a partial last line is NOT returned, and is NOT lost', () => {
  // THE RULE THE MODULE EXISTS FOR. The renderer appends and can be killed between the write and
  // the flush, so a poll may see half a line. Advancing past it would drop the event for good.
  const complete = { type: 'frame', frame: 1, ms: 900 }
  const partial = '{"type":"frame","frame":2,'
  const journal = journalWith(line(complete) + partial)

  const first = journal.drain()
  assert.deepEqual(first, [complete], 'only the complete line is an event')
  assert.equal(journal.tornLineSeen, true, 'the reader has to KNOW it saw a torn line, not merely skip it')

  // The rest of the line arrives — the kill was at the wrong moment, or the flush was slow.
  appendFileSync(journal.path, '"ms":1100}\n')

  const second = journal.drain()
  assert.deepEqual(second, [{ type: 'frame', frame: 2, ms: 1100 }], 'the finished line is delivered exactly once')
  assert.equal(journal.events.length, 2)
})

test('a journal cut after complete lines still reads as torn — the ordinary kill case', () => {
  // THE DEFECT THIS TEST FOUND. The flag used to be raised only when the read buffer held no
  // complete line at all, so a render killed after frame 30 of 450 — one complete line, then a
  // half-written one — looked like an intact journal, and the host's "the journal ends mid-line"
  // line could not fire in the case it exists for. A diagnostic that cannot fire is not a
  // diagnostic.
  const journal = journalWith(line({ type: 'frame', frame: 1 }) + '{"type":"frame","frame":2')
  assert.deepEqual(journal.drain(), [{ type: 'frame', frame: 1 }])
  assert.equal(journal.tornLineSeen, true)

  // And the flag is a fact about the FILE, not a one-way trip to alarm: the line completing must
  // leave the offset right, so the event still arrives — and must CLEAR the flag, because a journal
  // whose tail arrived is whole, and a latched flag would report an event that was never lost.
  appendFileSync(journal.path, ',"ms":700}\n')
  assert.deepEqual(journal.drain(), [{ type: 'frame', frame: 2, ms: 700 }])
  assert.equal(journal.tornLineSeen, false, 'the tail completed, so the journal no longer ends mid-line')

  // A journal that ENDS on a newline is not torn, however long it is. Without this the flag could
  // be raised by nothing but a trailing byte and the test above would still pass.
  const clean = journalWith(`${line({ type: 'frame', frame: 1 })}\n`)
  assert.deepEqual(clean.drain(), [{ type: 'frame', frame: 1 }])
  assert.equal(clean.tornLineSeen, false, 'a journal that ends on a line boundary is complete')
})

test('a complete but unparseable line becomes a marker, not silence — and is not called a torn kill', () => {
  // A torn write is expected; a COMPLETE line that is not JSON is a bug in the writer. Dropping it
  // would make "the journal lost an event" indistinguishable from "the renderer never sent one".
  const journal = journalWith(line({ type: 'frame', frame: 1 }) + 'this is not json\n' + line({ type: 'frame', frame: 2 }))

  const events = journal.drain()
  assert.equal(events.length, 3)
  assert.deepEqual(events[1], { type: 'unparseable-line' }, 'the marker stands in for the lost event')
  assert.deepEqual(events[2], { type: 'frame', frame: 2 }, 'and the reader carries on past it')
  // Two different facts, two different flags. This one used to raise the torn flag as well, which
  // made the host report a writer bug as "the renderer was killed mid-write" — the wrong cause,
  // stated as fact.
  assert.equal(journal.tornLineSeen, false, 'a complete-but-unparseable line is not a torn line')
})

test('the torn tail is reported once, and only after the writer has stopped', () => {
  // THE SECOND RULE. Noticing a torn tail is not the same as accusing anyone: a poll runs every
  // second while the renderer is alive, and a line being written looks exactly like a line that was
  // cut off. The host cannot exercise this branch without a real kill, which is why the rule lives
  // here, where it can be driven by hand.
  const journal = journalWith(line({ type: 'frame', frame: 1 }) + '{"type": "frame", "fra')
  journal.drain()
  assert.equal(journal.tornLineSeen, true)

  assert.equal(journal.tornLineIsEvidence({ stopped: false }), false, 'a live writer is not evidence')
  assert.equal(journal.tornLineIsEvidence({ stopped: false }), false, 'and asking again does not change that')
  assert.equal(journal.tornLineIsEvidence({ stopped: true }), true, 'once the writer is gone, it is')
  assert.equal(journal.tornLineIsEvidence({ stopped: true }), false, 'reported exactly once — the poll keeps running')
  assert.equal(journal.tornLineIsEvidence({ stopped: false }), false, 'including after the report')

  // A journal that never saw a torn line says nothing, however long it is asked.
  const clean = journalWith(`${line({ type: 'frame', frame: 1 })}\n`)
  clean.drain()
  assert.equal(clean.tornLineIsEvidence({ stopped: true }), false)

  // A tail that was torn while the writer lived and completed before it stopped is NOT evidence: the
  // journal is whole, nothing was lost, and the only honest report is silence. This is the case that
  // makes the flag a reading rather than a latch.
  const slow = journalWith(`${line({ type: 'frame', frame: 1 })}\n{"type": "frame"`)
  slow.drain()
  assert.equal(slow.tornLineIsEvidence({ stopped: false }), false)
  appendFileSync(slow.path, ', "frame": 2}\n')
  slow.drain()
  assert.equal(slow.tornLineIsEvidence({ stopped: true }), false, 'the line arrived, so nothing is missing')
})

test('a journal whose ONLY line is still being written loses nothing', () => {
  // The branch the module's header describes first — "nothing complete yet" — and it was still dark
  // after the first pass of this file. That is the point of re-reading the probe instead of trusting
  // the tests just written: the tests you thought of are the ones you thought of.
  const journal = journalWith('{"type": "star')
  assert.deepEqual(journal.drain(), [], 'half a line is not an event')
  assert.equal(journal.tornLineSeen, true, 'and the file does end mid-line')
  assert.equal(journal.tornLineIsEvidence({ stopped: true }), true, 'so a stopped writer can be reported')

  // The offset stayed at zero, so the finished line arrives whole — the case that would be lost by
  // advancing past an unparseable tail.
  appendFileSync(journal.path, 't", "frame": 1}\n')
  assert.deepEqual(journal.drain(), [{ type: 'start', frame: 1 }], 'the event arrives, exactly once')
})

test('a journal path whose bytes cannot be read yields no events, and does not throw', () => {
  // `stat` succeeds and the read does not — the state a progress poll must survive, because a poll
  // that throws takes a three-hour render down over a bookkeeping error. A DIRECTORY is how this is
  // reached without permissions tricks: `chmod 000` is defeated by running as root, which CI does,
  // while `openSync(dir)` succeeds on POSIX and `readSync` raises EISDIR.
  const directoryPath = join(scratch, 'events-as-a-directory.jsonl')
  mkdirSync(directoryPath, { recursive: true })
  writeFileSync(join(directoryPath, 'filler'), 'x'.repeat(2048))
  // Stated, not assumed: a zero-size entry would return at the early size check and this test would
  // pass while exercising a different branch than the one it is named for.
  assert.ok(statSync(directoryPath).size > 0, 'the filler must give the directory a non-zero size')

  const journal = new JournalTail(directoryPath)
  assert.deepEqual(journal.drain(), [], 'an unreadable journal reads as nothing')
  assert.equal(journal.events.length, 0)
})

test('the incomplete-journal warning needs all four conditions, and is spent once', () => {
  // WHY THIS IS HERE AND NOT ONLY IN THE END-TO-END SUITE. That suite settles the warning against the
  // journal FILE — the right way to check agreement — but a SIGKILL lands on a line boundary in
  // practice (measured twice in round 25), so "torn, therefore recorded" is not reachable on demand
  // there, and the branch that writes the warning would never be exercised by it. The rule is four
  // conditions in a row, and all four are drivable here.
  const torn = journalWith(line({ type: 'frame', frame: 1 }) + '{"type": "frame", "fra')
  torn.drain()
  assert.equal(torn.tornLineSeen, true)

  // (1) the writer is still alive — a line being written is not a finding.
  assert.equal(incompleteJournalWarning(torn, { stopped: false, jobId: 'render-0001' }), null)
  // ...and asking did not spend the evidence.
  const entry = incompleteJournalWarning(torn, { stopped: true, jobId: 'render-0001', attemptToken: 'token-1' })
  assert.ok(entry !== null, 'once the writer has stopped, the torn tail is a finding')
  assert.equal(entry.code, 'JOURNAL_INCOMPLETE', 'the code a reader filters on')
  assert.match(entry.message, /cut off mid-line/, 'the message says what happened')
  assert.match(entry.message, /frame files themselves/, 'and says the counts are unaffected, which is the question a reader has')
  assert.equal(entry.detail.jobId, 'render-0001')
  assert.equal(entry.detail.attemptToken, 'token-1', 'the attempt is named, because a job can have several')
  // (2) spent once: the poll runs every second and a diagnostic that repeats is noise.
  assert.equal(incompleteJournalWarning(torn, { stopped: true, jobId: 'render-0001' }), null)

  // (3) a kill the caller ASKED for is not a finding — and it must not spend the evidence either, so
  // a later unexpected kill of the same attempt is still recorded.
  const cancelledJournal = journalWith(`${line({ type: 'frame', frame: 1 })}\n{"type": "fra`)
  cancelledJournal.drain()
  assert.equal(incompleteJournalWarning(cancelledJournal, { stopped: true, cancelled: true }), null)
  assert.equal(cancelledJournal.tornLineSeen, true, 'the flag survives a cancelled absorb, unconsumed')
  assert.ok(incompleteJournalWarning(cancelledJournal, { stopped: true }) !== null, 'so a real kill later is still recorded')

  // (4) a whole journal is not a finding, however often it is asked.
  const whole = journalWith(`${line({ type: 'frame', frame: 1 })}\n`)
  whole.drain()
  assert.equal(incompleteJournalWarning(whole, { stopped: true, jobId: 'render-0002' }), null)
  assert.equal(incompleteJournalWarning(whole, { stopped: true, jobId: 'render-0002' }), null)
})

test('blank lines are skipped, and do not stall the reader', () => {
  const journal = journalWith(`${line({ type: 'frame', frame: 1 })}\n\n   \n${line({ type: 'frame', frame: 2 })}`)
  const events = journal.drain()
  assert.deepEqual(events.map(event => event.frame), [1, 2])
})

test('a journal bigger than one read is read in pieces, and makes progress', () => {
  // The cap is 4 MiB. A journal that reaches it must not be read in one allocation — and the reader
  // must keep going rather than returning the same first chunk forever.
  const path = join(scratch, 'large.jsonl')
  const lines = 48_000
  const chunk = []
  for (let frame = 1; frame <= lines; frame += 1) chunk.push(line({ type: 'frame', frame, pad: 'x'.repeat(64) }))
  writeFileSync(path, chunk.join(''))

  const journal = new JournalTail(path)
  const first = journal.drain()
  assert.ok(first.length > 0, 'the first read returns events')
  assert.ok(first.length < lines, `the first read returned all ${lines} events, so the cap was not applied`)
  // A read stopped by the CAP is not a torn tail: the bytes after it are simply unread. The flag has
  // to depend on whether the read reached the end of the file, or every large journal would be
  // reported as a killed render.
  assert.equal(journal.tornLineSeen, false, 'a capped read says nothing about the tail')

  let total = first.length
  for (let pass = 0; pass < 200 && total < lines; pass += 1) total += journal.drain().length
  assert.equal(total, lines, 'every line is eventually delivered, in order, exactly once')
  assert.equal(journal.events[0].frame, 1)
  assert.equal(journal.events[lines - 1].frame, lines)
  assert.equal(journal.tornLineSeen, false, 'and the journal ends on a line boundary')
})

test('the durations the renderer reported come back for the remaining-time estimate', () => {
  const journal = journalWith(
    line({ type: 'start' }) +
    line({ type: 'frame', frame: 1, ms: 1200 }) +
    line({ type: 'frame', frame: 2 }) +
    line({ type: 'frame', frame: 3, ms: 800 }),
  )
  journal.drain()
  assert.deepEqual(journal.frameDurations(), [1200, 800], 'only the frames that reported a duration count')
})

test('the frames an event stream claims are never trusted on their own', () => {
  // The module's header is explicit: "the caller verifies that frame against its bytes before
  // counting it". So the only thing the journal may offer is a PREDICATE — "this event claims a
  // frame" — and the verification stays the ledger's job (`contract/render-job.test.mjs`). An
  // earlier version offered `claimedFrames()`, a list of unverified frame numbers: nothing called
  // it, and anything that did would have been trusting exactly the value the design says not to.
  const journal = journalWith(
    line({ type: 'frame', frame: 7 }) +
    line({ type: 'frame', frame: 8 }) +
    line({ type: 'frame', frame: 'nine' }) +
    line({ type: 'frame_failed', frame: 9 }),
  )
  const claimed = journal.drain().filter(isFrameClaim).map(event => event.frame)
  assert.deepEqual(claimed, [7, 8], 'a frame that is not an integer is not a claim')

  // The shape of the rule, stated once, where the host and the test both read it from.
  assert.equal(isFrameClaim({ type: 'frame', frame: 3 }), true)
  assert.equal(isFrameClaim({ type: 'frame' }), false, 'a frame event with no number claims nothing')
  assert.equal(isFrameClaim({ type: 'frame', frame: 1.5 }), false, 'a fractional frame is not a frame')
  assert.equal(isFrameClaim({ type: 'frame', frame: 2 ** 53 }), false, 'a number past the safe range cannot be a file name')
  assert.equal(isFrameClaim({ type: 'frame_failed', frame: 4 }), false, 'a FAILED frame is not a claim that it landed')
  assert.equal(isFrameClaim(null), false, 'and a partial line that never parsed claims nothing')
  assert.equal(isFrameClaim({ type: 'frame', frame: 0 }), true, 'frame 0 is a legal Blender frame, so it is a claim')
})
