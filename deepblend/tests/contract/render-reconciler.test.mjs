#!/usr/bin/env node
/**
 * Reconciler contract — the recovery pass, driven with real pids instead of a live Host.
 *
 * WHY THIS EXISTS
 * ---------------
 * `reconcileRenderJob` is what runs when a Host starts and finds a render nobody is watching any
 * more, and the coverage reading (round 31) said its three most dangerous branches had NEVER been
 * executed by any suite:
 *
 *   - a live pid that is NOT this job's renderer (a recycled pid after a reboot, or another
 *     process entirely). The rule is "never signal it" — and the cost of getting it wrong is
 *     killing an unrelated process on the user's machine;
 *   - a record that cannot be parsed. The rule is "report it, never repair it in place", because
 *     the broken file may be the only evidence of what the job was doing;
 *   - an orphan that SURVIVES the SIGTERM/SIGKILL ladder. The rule is "not resumable", because a
 *     second renderer writing the same frames produces files neither process can vouch for.
 *
 * All three are safety properties, all three were dark, and the module takes its store, its ledger
 * reader and its writer as parameters — which is exactly what makes them drivable here with real
 * child processes rather than with a running Host. A safety rule whose only exercise is a machine
 * that happens to hit it is a safety rule nobody has checked.
 *
 * Run: node deepblend/tests/contract/render-reconciler.test.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import {
  RenderJobStore,
  checkProcessAlive,
  identifyProcess,
  readFrameLedger,
  reconcileRenderJob,
} from '@deepblend/dsh-blender-host'

/**
 * A real PNG at the resolution the records below declare, because the ledger judges frames by their BYTES
 * and their HEADER: a solid 32x32 image compresses to ~100 bytes and is read as `truncated` (round 52 paid
 * for that one), so the pixels are made incompressible and the size matches `renderConfig.resolution`.
 */
const frameImage = createImage(320, 180, [10, 20, 30, 255])
for (let index = 0; index < frameImage.data.length; index += 1) {
  frameImage.data[index] = (index * 7 + (index >> 3)) & 0xff
}
const framePng = encodePng(frameImage)

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-reconciler-'))
const projects = join(scratch, 'projects')
mkdirSync(projects, { recursive: true })
const store = new RenderJobStore({
  projectDirectory: projectId => join(projects, projectId),
  workspaceRoot: projects,
})

/** Sleeping children, killed when this file finishes however it finishes. */
const children = []
process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * A real process whose command line may or may not name the job directory.
 *
 * `ps -o args=` is what `identifyProcess` reads, so the extra argument is the whole point: a renderer
 * is identified by having the job directory in its argv, and a process that merely exists is not.
 */
function sleeper(jobDirectory) {
  const args = ['-e', 'setTimeout(() => {}, 120000)']
  if (jobDirectory !== undefined) args.push(jobDirectory)
  const child = spawn(process.execPath, args, { stdio: 'ignore', detached: true })
  // `unref` so a sleeping child does not hold THIS process open until its own 120 s timer fires —
  // measured: without it the file took 120 s to exit while its four tests took under a second. The
  // child is still killed by the exit handler above.
  child.unref()
  children.push(child)
  return child
}

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(settle => setTimeout(settle, 50))
  }
  return false
}

/** A render job record in the state a dead Host leaves behind: running, one frame done. */
function runningRecord({ jobId, pid, attemptToken = 'token-a' }) {
  return {
    projectId: 'demo',
    jobId,
    type: 'final-render',
    status: 'running',
    revisionId: 'r0001',
    frameStart: 1,
    frameEnd: 3,
    expectedFrames: 3,
    completedFrames: [1],
    missingFrames: [2, 3],
    corruptFrames: [],
    fps: 30,
    pid,
    attempt: 1,
    attemptToken,
    dshJobId: null,
    delivery: null,
    warnings: [],
    filePrefix: 'frame_',
    filePadding: 4,
    renderConfig: { resolution: [320, 180], samples: 8, engine: 'cycles', viewTransform: 'AgX' },
  }
}

/** Run the pass the way the Host does: the record comes from the store, the write goes back to it. */
async function reconcile(record, overrides = {}) {
  const { jobId, projectId } = record
  store.write(record)
  const written = []
  const finding = await reconcileRenderJob({
    store,
    readFrameLedger,
    projectId,
    jobId,
    record: store.read(projectId, jobId),
    write: next => {
      written.push(next)
      return store.write(next)
    },
    ...overrides,
  })
  return { finding, written }
}

test('a live pid that is NOT this job\'s renderer is left alone, and reported as such', async () => {
  // The catastrophic version of getting this wrong is killing a stranger's process on a machine where
  // pids were recycled after a reboot. The job directory has to be in the render's argv for the pid to
  // count as its renderer, so a sleeper WITHOUT it is exactly the case.
  const jobId = 'render-0001'
  const child = sleeper()
  const { finding } = await reconcile(runningRecord({ jobId, pid: child.pid }))

  assert.equal(finding.process.identity.matches, false)
  assert.match(finding.process.identity.reason, /not this job's renderer/)
  assert.ok(
    finding.notes.some(note => note.includes('is not this job\'s renderer') && note.includes('left alone')),
    `the finding must say the process was left alone: ${JSON.stringify(finding.notes)}`,
  )
  assert.equal(
    checkProcessAlive(child.pid).alive,
    true,
    'the passer-by was signalled — this is the branch that must never kill anything',
  )
})

test('an orphan that survives the ladder makes the job NOT resumable, and its record is untouched', async () => {
  // A second renderer writing the same frames produces files neither process can vouch for, so the
  // only safe answer is refusal. `process.kill` is patched to EPERM for this pid because a process we
  // own is always killable — EPERM is precisely what "it exists and is not yours" looks like, which is
  // also the case `checkProcessAlive` treats as alive.
  const jobId = 'render-0002'
  const jobDirectory = store.jobDirectory('demo', jobId)
  const child = sleeper(jobDirectory)
  assert.equal(identifyProcess({ pid: child.pid, jobDirectory, command: `node -e x ${jobDirectory}` }).matches, true)

  const realKill = process.kill
  process.kill = (pid, signal) => {
    if (pid === child.pid || pid === -child.pid) {
      const error = new Error('Operation not permitted')
      error.code = 'EPERM'
      throw error
    }
    return realKill(pid, signal)
  }
  let result
  try {
    // A short grace: the default is 10 s per signal and this branch is reached by waiting them out.
    result = await reconcile(runningRecord({ jobId, pid: child.pid }), { orphanGraceMs: 250 })
  } finally {
    process.kill = realKill
  }

  assert.equal(result.finding.status, 'orphan-survived')
  assert.notEqual(result.finding.resumable, true, 'a job whose orphan survived must NOT be marked resumable')
  assert.ok(
    result.finding.notes.some(note => note.includes('NOT resumable') && note.includes('neither process can vouch for')),
    `the finding must give the corruption reason: ${JSON.stringify(result.finding.notes)}`,
  )
  assert.deepEqual(result.written, [], 'the job record must not be rewritten when the orphan survived')
  assert.equal(store.read('demo', jobId).status, 'running', 'the stored record still says what it said')
})

test('an unreadable record is reported and LEFT ON DISK byte for byte', async () => {
  // The broken file may be the only evidence of what the job was doing, so repairing it in place would
  // destroy exactly what a human needs to look at.
  const jobId = 'render-0003'
  const jobDirectory = store.jobDirectory('demo', jobId)
  mkdirSync(jobDirectory, { recursive: true })
  const recordPath = store.recordPath('demo', jobId)
  const garbage = '{"jobId": "render-0003", "status": "run'
  writeFileSync(recordPath, garbage)

  const written = []
  const finding = await reconcileRenderJob({
    store,
    readFrameLedger,
    projectId: 'demo',
    jobId,
    record: null,
    write: next => {
      written.push(next)
      return next
    },
  })

  assert.equal(finding.status, 'unreadable')
  assert.match(finding.notes[0], /unreadable or not a render job record/)
  assert.ok(finding.notes[0].includes('left untouched'), 'the note must say the file was not repaired')
  assert.deepEqual(written, [], 'an unreadable record must not be overwritten')
  assert.equal(readFileSync(recordPath, 'utf8'), garbage, 'the evidence must survive byte for byte')
  assert.ok(existsSync(join(jobDirectory, 'recovery.json')), 'the finding is written beside the job')
})

test('the orphan is stopped BEFORE the ledger is read, which is the documented order', async () => {
  // "A live renderer is writing into the very directory the ledger describes, so the other order
  // produces an answer that is already stale by the time it is returned." That ordering is a rule in
  // a comment; this is the assertion that it holds.
  const jobId = 'render-0004'
  const jobDirectory = store.jobDirectory('demo', jobId)
  const child = sleeper(jobDirectory)

  assert.equal(await waitFor(() => checkProcessAlive(child.pid).alive), true, 'the sleeper must be running')
  const observations = []
  const ledgerReader = input => {
    observations.push(checkProcessAlive(child.pid).alive)
    return readFrameLedger(input)
  }

  const { finding } = await reconcile(runningRecord({ jobId, pid: child.pid }), { readFrameLedger: ledgerReader })

  assert.deepEqual(observations, [false], 'the ledger was read while the renderer was still alive')
  assert.equal(finding.status, 'recovering')
  assert.equal(finding.resumable, true, 'a job whose orphan was stopped IS resumable')
  assert.equal(finding.process.stopped.gone, true, 'and the stop is verified, not assumed')
  assert.equal(checkProcessAlive(child.pid).alive, false, 'the orphan is really gone')
})

// ---------------------------------------------------------------------------
// The answers that are not about a live process at all
// ---------------------------------------------------------------------------

test('a pid that cannot be a process is answered as INVALID rather than probed', () => {
  // `checkProcessAlive` is the function every "is it still running?" question goes through, and its guard
  // exists so that a nonsense pid cannot be turned into a signal later. "There is no such process" and
  // "that is not a pid" are different facts, and the second one is reported as `invalid` instead of being
  // folded into the first.
  for (const value of [0, -1, 1.5, Number.NaN, '123']) {
    const answer = checkProcessAlive(value)
    assert.equal(answer.alive, false, `${String(value)} must not read as alive`)
    assert.equal(answer.invalid, true, `${String(value)} must read as an invalid pid`)
  }
})

test('a process whose command line cannot be read is NOT claimed as this job\'s renderer', () => {
  // The identity check exists because pids are recycled: an alive pid is not evidence of anything until its
  // argv names this job's directory. An empty command line means the identity cannot be established at all,
  // and the answer has to say exactly that rather than match on the pid.
  for (const command of [null, '']) {
    const verdict = identifyProcess({ pid: 12345, jobDirectory: '/tmp/jobs/render-0001', command })
    assert.equal(verdict.matches, false)
    assert.equal(verdict.reason, 'the process has no readable command line')
  }
})

test('a job whose frames all landed is still NOT complete: it owes its video, and the record says so', async () => {
  // "All frames are present" is where a delivery silently ships without a video if the reconciler reads it
  // as `completed`. The record goes to `recovering` with nothing missing, and the message names the debt.
  const jobId = 'render-0010'
  const record = runningRecord({ jobId, pid: null })
  const framesDirectory = store.framesDirectory('demo', jobId)
  mkdirSync(framesDirectory, { recursive: true })
  for (const frame of [1, 2, 3]) {
    writeFileSync(join(framesDirectory, `frame_${String(frame).padStart(4, '0')}.png`), framePng)
  }
  const { finding } = await reconcile(record)
  const stored = store.read('demo', jobId)
  assert.equal(finding.status, 'recovering')
  assert.equal(finding.resumable, true)
  assert.deepEqual(stored.missingFrames, [])
  assert.equal(stored.status, 'recovering')
  assert.equal(
    stored.message,
    'all frames are present; the job still owes its encoded video and delivery manifest',
  )
})

test('a recovery report that cannot be written does not abort the recovery it describes', async () => {
  // `recovery.json` is the audit trail BESIDE the record, and the record is the authority. A directory
  // standing where the report belongs makes the write fail for real; the recovery must still finish.
  const jobId = 'render-0011'
  const record = runningRecord({ jobId, pid: null })
  mkdirSync(join(store.jobDirectory('demo', jobId), 'recovery.json'), { recursive: true })
  const { finding } = await reconcile(record)
  assert.equal(finding.status, 'recovering')
  assert.equal(store.read('demo', jobId).status, 'recovering', 'the record is the authority and it was written')
})

test('a process identity document that is not JSON counts as no identity at all', async () => {
  // A half-written `process.json` is what a kill between the write and the flush leaves behind. Reading it
  // as "no pid recorded" is the honest answer; throwing would take the whole reconciliation pass down.
  const jobId = 'render-0012'
  const record = runningRecord({ jobId, pid: null })
  mkdirSync(store.jobDirectory('demo', jobId), { recursive: true })
  writeFileSync(join(store.jobDirectory('demo', jobId), 'process.json'), '{"pid": 12', 'utf8')
  const { finding } = await reconcile(record)
  assert.equal(finding.process, null)
  assert.equal(finding.status, 'recovering')
  assert.ok(
    finding.notes.some(note => note.includes('no pid')),
    `the finding must say there was no pid to check: ${JSON.stringify(finding.notes)}`,
  )
})
