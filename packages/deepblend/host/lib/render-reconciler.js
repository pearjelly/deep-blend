/**
 * Render Job Reconciler — what a freshly started Host can say about a render that
 * was interrupted (SPEC §10.3).
 *
 * WHAT THE M3 PROBE MEASURED, AND WHY THIS FILE IS SHAPED LIKE THIS
 * -----------------------------------------------------------------
 * The probe (`deepblend/tools/m3-restart-probe.mjs`) SIGKILLed the process that
 * had started a real 1080p/256-spp delivery render and then recovered in a third
 * process. Three facts came out of it, and every one of them changed the design:
 *
 *   1. **The Blender child survives the Host.** It is spawned `detached`, so it
 *      leads its own process group and keeps rendering into the same directory.
 *      A recovery that reads the ledger BEFORE stopping it is describing a
 *      directory that is still being written to — so `stopOrphan` runs first, and
 *      the order is the point.
 *
 *   2. **The pid can only come from the child.** `ctx.subprocess.spawn` returns
 *      `{stdin, stdout, stderr, collected, done, terminate, waitForExit}` — it
 *      exposes no pid (measured against the installed runtime). So
 *      `bootstrap.py --proc <path>` writes `process.json` before it touches bpy,
 *      and that file is the only durable link between a job record and a process.
 *
 *   3. **macOS containment is a process group and nothing more.** On darwin
 *      `selectContainmentMode()` returns `fallback`, whose own warning says
 *      "descendants that escape the process group or direct-parent tree are not
 *      guaranteed to terminate". The group is what `terminate()` signals, and the
 *      probe confirmed `process.kill(-pid, SIGTERM)` does clear it
 *      (`gone: true`, `groupAlive: false`). This module signals the GROUP for the
 *      same reason, and re-verifies afterwards rather than trusting the signal.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * **It does not resume the render by itself.** SPEC §10.3 step 6 says resumable
 * work continues from the missing frames, and that is delivered — by
 * `blenderStudio.resumeRenderJob`, which the model (or the UI) calls. Auto-starting
 * is refused for two concrete reasons: SPEC §16.4 fixes delivery-render
 * concurrency at 1, and a Host can be started with several projects each holding
 * an interrupted render, so auto-resume would launch several Blender processes at
 * boot with no user present. Recovery leaves every job in `recovering`, with its
 * ledger already computed, so the decision costs one call.
 *
 * SPEC §10.3 step 8 asks for a recovery event "to the UI and the Session". At Host
 * startup there is no session yet — the reconciler runs before any agent exists —
 * so an in-process event would have no listener by construction. What it writes
 * instead is `recovery.json` in the job directory: a durable, auditable record of
 * what was found, what was stopped and what remains, which outlives the process
 * that discovered it.
 *
 * Owner: DeepBlend Studio — M3
 * Plane: Host composition
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './paths.js'

/** Grace given to SIGTERM before SIGKILL, matching the provider's own ladder. */
export const ORPHAN_GRACE_MS = 10_000

/** How long to wait for the group to disappear after a signal. */
const POLL_INTERVAL_MS = 150

/**
 * Is the process group led by `pid` still alive?
 *
 * Signalling `-pid` asks about the GROUP, which is the managed range this runtime
 * actually owns on macOS. `ps` is consulted for identity, not liveness: a pid can
 * be recycled, and killing a recycled pid would be the worst possible outcome of
 * a recovery.
 *
 * @param {number} pid
 * @returns {{alive: boolean, groupAlive: boolean, leaderAlive: boolean, command: string|null}}
 */
export function checkProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { alive: false, groupAlive: false, leaderAlive: false, command: null, invalid: true }
  }
  const probe = (target) => {
    try {
      process.kill(target, 0)
      return true
    } catch (error) {
      // EPERM means it exists and belongs to someone else — still alive.
      return error.code === 'EPERM'
    }
  }
  const groupAlive = probe(-pid)
  const leaderAlive = probe(pid)
  return { alive: groupAlive || leaderAlive, groupAlive, leaderAlive, command: processCommand(pid) }
}

/**
 * The full argv of a pid, or null.
 *
 * `ps -o args=` is used rather than `-o command=`: on macOS `command` is truncated
 * for long argument lists, and the render's identity lives at the END of its argv
 * (the `--request <jobDirectory>/request.json` pair).
 *
 * This uses `node:child_process` directly rather than `ctx.subprocess`. That is
 * deliberate and is the one exception in this package: `ctx.subprocess` is the
 * seam for the processes DeepBlend MANAGES, and a reconcile may need to inspect a
 * pid whose owning service instance no longer exists. The call is a fixed argv,
 * never a shell string, and its output is data (SPEC §15.2's argv rule is about
 * how a process is started, and nothing is started here).
 *
 * @param {number} pid
 * @returns {string|null}
 */
function processCommand(pid) {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
    return output.length > 0 ? output : null
  } catch {
    return null
  }
}

/**
 * Does the recorded pid still belong to THIS job?
 *
 * A recycled pid that happens to be alive must never be signalled. The job
 * directory appears twice in a render's argv — as `cwd` and inside `--request`,
 * `--result` and `--plan` — so requiring it in the command line is a strong,
 * cheap identity check.
 *
 * @param {{pid: number, jobDirectory: string, command: string|null}} input
 * @returns {{matches: boolean, reason: string}}
 */
export function identifyProcess(input) {
  if (input.command === null || input.command.length === 0) {
    return { matches: false, reason: 'the process has no readable command line' }
  }
  if (input.command.includes(input.jobDirectory)) {
    return { matches: true, reason: 'the command line names this job directory' }
  }
  return {
    matches: false,
    reason: 'the live process is not this job\'s renderer (its command line does not name the job directory)',
  }
}

/**
 * Terminate the orphan's process group: SIGTERM, wait, SIGKILL, wait, verify.
 *
 * The verification is the point. "I sent a signal" and "the process is gone" are
 * different claims, and the M3 acceptance condition is the second one.
 *
 * @param {{pid: number, graceMs?: number}} input
 * @returns {Promise<object>}
 */
export async function stopProcessGroup(input) {
  const pid = input.pid
  const graceMs = input.graceMs ?? ORPHAN_GRACE_MS
  const report = { pid, term: null, kill: null, gone: false }
  const signal = (name) => {
    try {
      process.kill(-pid, name)
      return 'signalled-group'
    } catch (error) {
      try {
        process.kill(pid, name)
        return `signalled-pid (group failed: ${error.code})`
      } catch (inner) {
        return `not-sent: ${inner.code}`
      }
    }
  }

  report.term = signal('SIGTERM')
  if (await waitForGone(pid, graceMs)) {
    report.gone = true
    return report
  }
  report.kill = signal('SIGKILL')
  report.gone = await waitForGone(pid, graceMs)
  return report
}

async function waitForGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (checkProcessAlive(pid).alive === false) return true
    await new Promise(resolveWait => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  return checkProcessAlive(pid).alive === false
}

/**
 * Reconcile one interrupted render job.
 *
 * @param {object} input
 * @param {import('./render-job-store.js').RenderJobStore} input.store
 * @param {import('./frame-ledger.js').readFrameLedger} input.readFrameLedger
 * @param {string} input.projectId
 * @param {string} input.jobId
 * @param {object|null} input.record
 * @param {(record: object) => object} input.write - persists the updated record.
 * @param {number} [input.orphanGraceMs] - how long to wait for a signalled orphan to die. Defaults to
 *   `ORPHAN_GRACE_MS` (10 s), which is what a real recovery uses; a test that has to reach the
 *   "survived" branch otherwise spends twenty seconds proving a refusal.
 * @returns {Promise<object>} the finding, which is also what `recovery.json` holds.
 */
export async function reconcileRenderJob(input) {
  const { store, projectId, jobId, record } = input
  const jobDirectory = store.jobDirectory(projectId, jobId)
  const finding = {
    schemaVersion: 'deepblend.render-recovery/v1',
    jobId,
    projectId,
    reconciledAt: new Date().toISOString(),
    previousStatus: record?.status ?? null,
    status: null,
    process: null,
    ledger: null,
    notes: [],
  }

  if (record === null) {
    // A record that cannot be parsed is REPORTED, never repaired in place: the
    // file may still be the only evidence of what the job was doing, and
    // overwriting it would destroy exactly the thing a human needs to look at.
    finding.status = 'unreadable'
    finding.notes.push(
      `${store.recordPath(projectId, jobId)} is unreadable or not a render job record; ` +
      'it is left untouched so the evidence survives, and the job is reported on every startup until it is resolved',
    )
    writeRecovery(jobDirectory, finding)
    return finding
  }

  const expected = store.expectedFrames(record)
  const framesDirectory = store.framesDirectory(projectId, jobId)

  // (1) Stop the orphan BEFORE reading the ledger. A live renderer is writing
  // into the very directory the ledger describes, so the other order produces an
  // answer that is already stale by the time it is returned.
  const identityPath = join(jobDirectory, 'process.json')
  const identity = existsSync(identityPath) ? readJsonSafe(identityPath) : null
  const recordedPid = record.pid ?? identity?.pid ?? null
  if (recordedPid !== null) {
    const alive = checkProcessAlive(recordedPid)
    const identityVerdict = alive.alive
      ? identifyProcess({ pid: recordedPid, jobDirectory, command: alive.command })
      : { matches: false, reason: 'the process is gone' }
    finding.process = { pid: recordedPid, alive: alive.alive, identity: identityVerdict }
    if (alive.alive && identityVerdict.matches) {
      const stopped = await stopProcessGroup({ pid: recordedPid, graceMs: input.orphanGraceMs })
      finding.process.stopped = stopped
      finding.notes.push(
        `an orphaned renderer (pid ${recordedPid}) survived the previous Host and was stopped: ` +
        `${stopped.term}${stopped.kill !== null ? `, then ${stopped.kill}` : ''}, gone=${stopped.gone}`,
      )
      if (stopped.gone !== true) {
        // Refusing to resume is the only safe answer: a resumer would race the
        // orphan for the same frame files, and a frame written by two processes
        // is a frame nobody can account for.
        finding.status = 'orphan-survived'
        finding.notes.push(
          'the orphan could not be stopped, so the job is NOT resumable: a second renderer writing the same ' +
          'frames would produce files neither process can vouch for',
        )
        writeRecovery(jobDirectory, finding)
        return finding
      }
    } else if (alive.alive) {
      finding.notes.push(
        `pid ${recordedPid} is alive but is not this job's renderer (${identityVerdict.reason}); it was left alone`,
      )
    } else {
      finding.notes.push(`the renderer recorded for this job (pid ${recordedPid}) is no longer running`)
    }
  } else {
    finding.notes.push('the job recorded no pid, so there was no process to check')
  }

  // (2) The frames are the authority.
  const ledger = input.readFrameLedger({
    framesDirectory,
    expected,
    expectedSize: {
      width: record.renderConfig?.resolution?.[0],
      height: record.renderConfig?.resolution?.[1],
      prefix: record.filePrefix,
      padding: record.filePadding,
    },
  })
  finding.ledger = {
    expected: expected.length,
    present: ledger.presentCount,
    corrupt: ledger.corruptCount,
    missing: ledger.missingCount,
    toRender: ledger.toRender,
    toRenderCount: ledger.toRenderCount,
    corruptFrames: ledger.corrupt.map(entry => ({ frame: entry.frame, reason: entry.reason, bytes: entry.bytes })),
  }

  // (3) Decide. A job whose frames are all present is still not finished — it
  // still owes an encoded video and a manifest — so "complete frames" is NOT
  // `completed`. Marking it completed here is exactly how a delivery silently
  // ships without a video.
  const next = {
    ...record,
    status: 'recovering',
    completedFrames: ledger.present.map(entry => entry.frame),
    missingFrames: ledger.toRender,
    recoveredAt: finding.reconciledAt,
    errorCode: null,
    message: ledger.toRenderCount === 0
      ? 'all frames are present; the job still owes its encoded video and delivery manifest'
      : `${ledger.toRenderCount} frame(s) still owed: ${ledger.corruptCount} incomplete, ${ledger.missingCount} absent`,
  }
  finding.status = 'recovering'
  finding.resumable = true
  const written = input.write(next)
  finding.record = { status: written.status, completedFrames: written.completedFrames.length }
  writeRecovery(jobDirectory, finding)
  return finding
}

function writeRecovery(jobDirectory, finding) {
  try {
    writeJsonAtomic(join(jobDirectory, 'recovery.json'), finding)
  } catch {
    // A recovery report that cannot be written must not abort a recovery: the
    // record itself is the authority, and this is the audit trail beside it.
  }
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
