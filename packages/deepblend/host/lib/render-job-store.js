/**
 * Render Job Store — the durable record of a render that must survive a restart.
 *
 * Plane: HOST composition (SPEC §4.1 "DeepBlend Persistent Job Store", §4.3
 * "渲染任务恢复 → Host / 需要重启后恢复"). Process-level, cross-session, on disk.
 *
 * WHERE IT LIVES, AND WHY NOT IN `jobs/`
 * -------------------------------------
 * ```
 * <project>/
 *   jobs/<jobId>.json              attempt log, one per Blender action   (M1)
 *   renders/
 *     <jobId>/
 *       job.json                   THE RENDER JOB — this module            (M3)
 *       plan.json                  the frame list handed to the renderer
 *       process.json               the pid the CHILD claimed
 *       events.jsonl               the child's fsynced per-frame journal
 *       result.json                the child's bootstrap envelope
 *       frames/frame_0001.png …    the deliverable's frames
 *       encoded/<jobId>.mp4        the encoded video, before publication
 *       manifest.json              the render manifest for this job
 * ```
 *
 * `jobs/` holds M1's attempt log: written once at the start of an action and once
 * at the end, because every M1/M2 action finished inside the tool call that
 * started it. The durable render job is a different object with a different
 * lifetime (SPEC §10.2), and `allocateJobId` counts `*.json` in `jobs/` to mint
 * its ids — writing render jobs there would both inflate that counter and make
 * "list this project's attempts" return two shapes.
 *
 * WHY THE RECORD IS WRITTEN SO OFTEN
 * ----------------------------------
 * Every mutation is an atomic write of the whole document (`writeJsonAtomic`:
 * temp file in the same directory, then `rename`). At ~29 s per frame, one write
 * per frame costs nothing measurable, and the alternative — batching — means a
 * kill loses the very progress the record exists to preserve. A reader therefore
 * sees either the previous complete document or the new one, never a torn one.
 *
 * Owner: DeepBlend Studio — M3
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  BlenderError,
  BlenderErrorCode,
  RENDER_JOB_VERSION,
  RENDER_JOB_TERMINAL_STATUSES,
  canTransitionRenderJob,
  checkTransition,
  frameNumbers,
  isTerminalRenderJobStatus,
} from '@deepblend/dsh-blender-contracts'

import { ensureDirectory, readJson, requireSafeSegment, resolveInside, writeJsonAtomic } from './paths.js'

/** Directory under the project that holds render jobs. */
export const RENDER_JOBS_DIRECTORY = 'renders'

/**
 * A render job id, safe as a single path segment.
 *
 * Minted from the project and a monotonically increasing counter rather than a
 * timestamp: the id appears in a tool result the model reasons about and in a
 * directory a human opens, and `render-0001` reads as "the first delivery render"
 * where `render-20260913143502-3` reads as noise.
 *
 * @param {number} ordinal
 * @returns {string}
 */
export function formatRenderJobId(ordinal) {
  return `render-${String(ordinal).padStart(4, '0')}`
}

/** The statuses that mean "this job still owes the project frames". */
export const UNFINISHED_STATUSES = Object.freeze(['queued', 'running', 'stopping', 'recovering'])

export class RenderJobStore {
  /**
   * @param {{ projectDirectory: (projectId: string) => string, workspaceRoot: string }} options
   */
  constructor(options) {
    this.projectDirectory = options.projectDirectory
    this.workspaceRoot = options.workspaceRoot
  }

  /** `<project>/renders` */
  rendersRoot(projectId) {
    return join(this.projectDirectory(projectId), RENDER_JOBS_DIRECTORY)
  }

  /** `<project>/renders/<jobId>` */
  jobDirectory(projectId, jobId) {
    requireSafeSegment(jobId, 'render job id')
    return resolveInside(this.workspaceRoot, join(this.rendersRoot(projectId), jobId), 'render job directory')
  }

  /** `<project>/renders/<jobId>/frames` */
  framesDirectory(projectId, jobId) {
    return join(this.jobDirectory(projectId, jobId), 'frames')
  }

  /** Create the job directory tree. */
  ensureJobDirectory(projectId, jobId) {
    return ensureDirectory(this.workspaceRoot, this.jobDirectory(projectId, jobId), 'render job directory')
  }

  /** `<project>/renders/<jobId>/job.json` */
  recordPath(projectId, jobId) {
    return join(this.jobDirectory(projectId, jobId), 'job.json')
  }

  /**
   * Mint the next render job id for a project.
   *
   * The counter is derived from the directory listing rather than stored, so it
   * cannot drift from what exists: a deleted job frees its ordinal, and a
   * restored project keeps the ids it shipped with.
   *
   * @param {string} projectId
   * @returns {string}
   */
  allocateJobId(projectId) {
    const root = this.rendersRoot(projectId)
    const existing = existsSync(root)
      ? readdirSync(root).map(name => /^render-(\d+)$/.exec(name)).filter(Boolean).map(match => Number.parseInt(match[1], 10))
      : []
    const next = existing.length === 0 ? 1 : Math.max(...existing) + 1
    return formatRenderJobId(next)
  }

  /**
   * Persist a render job record.
   *
   * Validates the status transition first. An illegal transition here is a bug in
   * the caller, and the failure it prevents is a record in a state no reader can
   * act on — for example `completed` with missing frames, which would make the
   * reconciler consider the job finished.
   *
   * @param {object} record
   * @param {{allowIllegalTransition?: boolean}} [options]
   * @returns {object}
   */
  write(record, options = {}) {
    const previous = options.previous ?? null
    if (previous !== null && !canTransitionRenderJob(previous.status, record.status)) {
      const verdict = checkTransition(previous.status, record.status)
      throw new BlenderError(
        BlenderErrorCode.RENDER_JOB_STATE_INVALID,
        `${verdict.reason} (job ${record.jobId})`,
        { detail: { jobId: record.jobId, from: previous.status, to: record.status } },
      )
    }
    this.ensureJobDirectory(record.projectId, record.jobId)
    const next = { ...record, schemaVersion: RENDER_JOB_VERSION, updatedAt: Date.now() }
    writeJsonAtomic(this.recordPath(record.projectId, record.jobId), next)
    return next
  }

  /**
   * Read a render job record, or throw.
   * @param {string} projectId
   * @param {string} jobId
   * @returns {object}
   */
  read(projectId, jobId) {
    const path = this.recordPath(projectId, jobId)
    const record = readJson(path)
    if (record === null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_JOB_NOT_FOUND,
        `Project "${projectId}" has no render job "${jobId}".`,
        { detail: { projectId, jobId } },
      )
    }
    return record
  }

  /** Read a record without throwing, for a scan. */
  readSafe(projectId, jobId) {
    return readJson(this.recordPath(projectId, jobId))
  }

  /** Every render job id under a project, in ordinal order. */
  listJobIds(projectId) {
    const root = this.rendersRoot(projectId)
    if (!existsSync(root)) return []
    return readdirSync(root)
      .map(name => /^render-(\d+)$/.exec(name))
      .filter(match => match !== null)
      .map(match => ({ id: match[0], ordinal: Number.parseInt(match[1], 10) }))
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(entry => entry.id)
  }

  /**
   * Every render job record in a project, newest last.
   * @param {string} projectId
   * @returns {object[]}
   */
  list(projectId) {
    const records = []
    for (const jobId of this.listJobIds(projectId)) {
      const record = this.readSafe(projectId, jobId)
      if (record !== null) records.push(record)
    }
    return records
  }

  /**
   * The jobs that still owe frames — the reconciler's input set.
   *
   * A record that cannot be PARSED is included as a job id with a null record, so
   * a corrupt record is surfaced rather than skipped. A scan that silently drops
   * what it cannot read reports "nothing unfinished" for a directory that has an
   * unfinished job in it, which is the one answer restart recovery must never give.
   *
   * @param {string} projectId
   * @returns {{jobId: string, record: object|null}[]}
   */
  unfinished(projectId) {
    const found = []
    for (const jobId of this.listJobIds(projectId)) {
      const record = this.readSafe(projectId, jobId)
      if (record === null) {
        found.push({ jobId, record: null })
        continue
      }
      if (!isTerminalRenderJobStatus(record.status)) found.push({ jobId, record })
    }
    return found
  }

  /**
   * The unfinished jobs of every project under a root.
   *
   * SPEC §10.3 says the reconciler runs "at Host startup", and a scan of every
   * project is the honest reading: an unfinished render is exactly the thing a
   * user comes back to the workbench to find, and a project they open first would
   * otherwise be the only one that reports it. The scan touches one small JSON
   * document per job plus a directory listing per project, so its cost is bounded
   * by the number of projects, not by the number of frames.
   *
   * @param {string[]} projectIds
   * @returns {{projectId: string, jobId: string, record: object|null}[]}
   */
  unfinishedAcross(projectIds) {
    const found = []
    for (const projectId of projectIds) {
      for (const entry of this.unfinished(projectId)) {
        found.push({ projectId, jobId: entry.jobId, record: entry.record })
      }
    }
    return found
  }

  /**
   * The record's own frame range as an explicit list.
   * @param {object} record
   * @returns {number[]}
   */
  expectedFrames(record) {
    const { frames, error } = frameNumbers(record.frameStart, record.frameEnd)
    if (error !== null) {
      throw new BlenderError(
        BlenderErrorCode.RENDER_RANGE_INVALID,
        `render job ${record.jobId} has ${error}`,
        { detail: { jobId: record.jobId, frameStart: record.frameStart, frameEnd: record.frameEnd } },
      )
    }
    return frames
  }

  /** True when the record is finished and owes nothing. */
  static isTerminal(record) {
    return RENDER_JOB_TERMINAL_STATUSES.includes(record?.status)
  }
}
