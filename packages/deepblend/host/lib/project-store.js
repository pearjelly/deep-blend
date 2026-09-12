/**
 * Project Store — the durable, cross-session home of a DeepBlend project.
 *
 * Plane: HOST composition (SPEC §4.1 "DeepBlend Project Store", §4.3 "项目与
 * Revision 存储 → Host / 跨会话持久化"). It is in-process shared state on disk,
 * not a per-session service.
 *
 * LAYOUT (one directory per project, everything below it project-relative):
 *
 * ```
 * <projectsRoot>/
 *   projects.json                    index: one line per project, for listing
 *   <projectId>/
 *     project.json                   PROJECT RECORD — the authority for "what is current"
 *     assets/                        ingested user assets (M1: declared, not yet ingested)
 *     revisions/
 *       r0001/                       immutable once published
 *         scene-spec.json            the revision's scene (the real source of truth)
 *         revision-manifest.json     identity, digests, counts, validation
 *         operation-manifest.json    what changed and why
 *         request.json               the exact patch that was accepted
 *         validation.json            the QA report for this revision
 *         scene.blend                checkpoint, when saveCheckpoint was set
 *         previews/                  rendered previews for this revision
 *     jobs/
 *       <jobId>.json                 one durable record per Blender batch attempt
 *     operations/
 *       <key-hash>.json              idempotency ledger (SPEC §8.5)
 *     staging/
 *       <revision>/                  a revision under construction; never read
 * ```
 *
 * Two rules the layout encodes:
 *
 *  - **`currentRevision` lives in `project.json`, never in a revision.** A
 *    revision manifest describes that revision and nothing else, so publishing a
 *    revision and moving the pointer stay two separate steps and a half-finished
 *    publish cannot claim to be current.
 *  - **`staging/` is the only mutable revision state.** Everything under
 *    `revisions/` was published by an atomic rename and is never written again.
 *
 * Owner: DeepBlend Studio — M1
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  BlenderError,
  BlenderErrorCode,
  PROJECT_RECORD_VERSION,
  canonicalPretty,
  sha256,
} from '@deepblend/dsh-blender-contracts'
import {
  ensureDirectory,
  isFile,
  listDirectories,
  readJson,
  requireSafeSegment,
  resolveInside,
  safeRealpath,
  slugifyProjectId,
  writeFileAtomic,
  writeJsonAtomic,
} from './paths.js'

/** Revision id grammar. Zero-padded so directory listings sort chronologically. */
const REVISION_PATTERN = /^r(\d+)$/

/**
 * Format a revision number as an id. Padding widens past 9999 rather than
 * truncating, so ordering by name never silently breaks on a long-running project.
 * @param {number} value
 * @returns {string}
 */
export function formatRevisionId(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new BlenderError(BlenderErrorCode.REVISION_ALLOCATION_FAILED, `Invalid revision number ${value}.`)
  }
  return `r${String(value).padStart(4, '0')}`
}

/**
 * Parse a revision id into its ordinal, or `null` when it is not one.
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseRevisionId(value) {
  if (typeof value !== 'string') return null
  const match = REVISION_PATTERN.exec(value)
  if (match === null) return null
  const ordinal = Number.parseInt(match[1], 10)
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null
}

/** The revision id used before any revision exists. Never a real revision. */
export const GENESIS_REVISION = 'r0000'

/** Compute the sha256 that keys an idempotency record. */
function idempotencyRecordFor(projectId, key) {
  return {
    schemaVersion: 'deepblend.idempotency/v1',
    projectId,
    idempotencyKey: key,
  }
}

export class ProjectStore {
  /**
   * @param {{ projectsRoot: string, workspaceRoot: string }} config
   */
  constructor(config) {
    this.projectsRoot = safeRealpath(config.projectsRoot)
    this.workspaceRoot = safeRealpath(config.workspaceRoot)
  }

  /** The projects root, created on first use. */
  ensureRoot() {
    return ensureDirectory(this.workspaceRoot, join(this.projectsRoot), 'projectsRoot')
  }

  /** Absolute path of a project directory. Validates the id before joining. */
  projectDirectory(projectId) {
    requireSafeSegment(projectId, 'project id')
    return resolveInside(this.projectsRoot, join(this.projectsRoot, projectId), `project "${projectId}"`)
  }

  /** Absolute path of one revision directory inside a project. */
  revisionDirectory(projectId, revision) {
    if (parseRevisionId(revision) === null) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_ID_INVALID,
        `"${revision}" is not a revision id; expected the form r0001.`,
      )
    }
    return join(this.projectDirectory(projectId), 'revisions', revision)
  }

  /** True when a project directory and record both exist. */
  exists(projectId) {
    try {
      return isFile(join(this.projectDirectory(projectId), 'project.json'))
    } catch {
      return false
    }
  }

  /**
   * Read a project record, or throw a stable error explaining which of the two
   * states (absent vs. corrupt) the caller hit.
   * @param {string} projectId
   * @returns {object}
   */
  readRecord(projectId) {
    const directory = this.projectDirectory(projectId)
    if (!existsSync(directory)) {
      throw new BlenderError(
        BlenderErrorCode.PROJECT_NOT_FOUND,
        `No DeepBlend project named "${projectId}" exists under ${this.projectsRoot}.`,
        { detail: { projectId, projectsRoot: this.projectsRoot } },
      )
    }
    const record = readJson(join(directory, 'project.json'))
    if (record === null) {
      throw new BlenderError(
        BlenderErrorCode.PROJECT_CORRUPT,
        `Project directory ${directory} exists but has no project.json; it was never completed.`,
        { detail: { projectId, directory } },
      )
    }
    if (record.schemaVersion !== PROJECT_RECORD_VERSION) {
      throw new BlenderError(
        BlenderErrorCode.PROJECT_CORRUPT,
        `Project "${projectId}" records schemaVersion "${record.schemaVersion}", expected "${PROJECT_RECORD_VERSION}".`,
      )
    }
    return record
  }

  /** Persist a project record atomically. */
  writeRecord(projectId, record) {
    const directory = ensureDirectory(this.projectsRoot, this.projectDirectory(projectId), `project "${projectId}"`)
    writeJsonAtomic(join(directory, 'project.json'), record)
    this.#refreshIndex(projectId, record)
    return record
  }

  /**
   * Allocate a project id from a title, avoiding collisions.
   *
   * Suffixing rather than failing is deliberate: two projects called "watch
   * commercial" are a normal thing for an operator to do, and making the second
   * one fail would push the caller into inventing ids by hand.
   *
   * @param {string} title
   * @returns {string}
   */
  allocateProjectId(title) {
    this.ensureRoot()
    const base = slugifyProjectId(title)
    for (let suffix = 0; suffix < 1000; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`
      if (!this.exists(candidate)) return candidate
    }
    throw new BlenderError(
      BlenderErrorCode.PROJECT_EXISTS,
      `Could not allocate an unused project id derived from "${title}" after 1000 attempts.`,
    )
  }

  /** Every project id in the store, sorted. */
  listProjectIds() {
    const root = this.ensureRoot()
    return listDirectories(root).filter(name => name !== 'staging' && this.exists(name))
  }

  /** Create a project's directory skeleton. Does NOT allocate a revision. */
  createSkeleton(projectId) {
    const directory = ensureDirectory(this.projectsRoot, this.projectDirectory(projectId), `project "${projectId}"`)
    for (const child of ['assets', 'revisions', 'jobs', 'operations', 'staging']) {
      ensureDirectory(this.projectsRoot, join(directory, child), `${projectId}/${child}`)
    }
    return directory
  }

  // -------------------------------------------------------------------------
  // Revisions
  // -------------------------------------------------------------------------

  /** The revision id a project currently points at. */
  currentRevision(projectId) {
    return this.readRecord(projectId).currentRevision
  }

  /** All published revision ids for a project, in ascending order. */
  listRevisions(projectId) {
    const directory = join(this.projectDirectory(projectId), 'revisions')
    return listDirectories(directory)
      .filter(name => parseRevisionId(name) !== null)
      .sort((left, right) => /** @type {number} */ (parseRevisionId(left)) - /** @type {number} */ (parseRevisionId(right)))
  }

  /** The next revision id after the highest published one. */
  nextRevisionId(projectId) {
    const revisions = this.listRevisions(projectId)
    if (revisions.length === 0) return formatRevisionId(1)
    const highest = /** @type {number} */ (parseRevisionId(revisions[revisions.length - 1]))
    return formatRevisionId(highest + 1)
  }

  /**
   * Read the SceneSpec stored in a revision.
   * @param {string} projectId
   * @param {string} revision
   * @returns {object}
   */
  readRevisionSpec(projectId, revision) {
    const directory = this.revisionDirectory(projectId, revision)
    if (!existsSync(directory)) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_NOT_FOUND,
        `Project "${projectId}" has no revision ${revision}.`,
        { detail: { projectId, revision, available: this.listRevisions(projectId) } },
      )
    }
    const spec = readJson(join(directory, 'scene-spec.json'))
    if (spec === null) {
      throw new BlenderError(
        BlenderErrorCode.REVISION_CORRUPT,
        `Revision ${revision} of "${projectId}" has no scene-spec.json.`,
        { detail: { projectId, revision } },
      )
    }
    return spec
  }

  /**
   * Read a revision manifest.
   * @param {string} projectId
   * @param {string} revision
   * @returns {object|null}
   */
  readRevisionManifest(projectId, revision) {
    return readJson(join(this.revisionDirectory(projectId, revision), 'revision-manifest.json'))
  }

  /** Absolute path of a revision's `.blend` checkpoint, or `null` when absent. */
  checkpointPath(projectId, revision) {
    const path = join(this.revisionDirectory(projectId, revision), 'scene.blend')
    return isFile(path) ? path : null
  }

  /**
   * Append one preview artifact to a revision's manifest, returning the
   * revision's complete preview list.
   *
   * Thin alias for {@link recordRevisionArtifact} under the `previews` index. Kept
   * as its own name because every M1 caller and test reads it as "the preview
   * index", and renaming a working call site to make a generalization visible is
   * churn that hides the change it was meant to advertise.
   *
   * @param {string} projectId
   * @param {string} revision
   * @param {object} artifact
   * @returns {object[]} the revision's previews, in render order.
   */
  recordRevisionPreview(projectId, revision, artifact) {
    return this.recordRevisionArtifact(projectId, revision, 'previews', artifact)
  }

  /**
   * Append one artifact to a revision's **artifact index** (decision D28).
   *
   * A revision is immutable in everything it DECIDED: its SceneSpec, its
   * checkpoint, its validation report, its digests. But it also *emits* things
   * afterwards — previews, contact sheets, a visual review — and those are produced
   * on demand, because rendering and reviewing observe a scene rather than change
   * it (which is why neither creates a revision).
   *
   * This is the append-only amendment that keeps the index honest, and it is
   * deliberately generic over the index key: M1 learned that a manifest claiming
   * one preview while the directory held three is worse than no manifest at all,
   * because the manifest is the copy that gets persisted, delivered and READ. A
   * second kind of emitted artifact would have re-created that bug immediately, in
   * a place where the M1 regression test could not see it.
   *
   * It touches only the named index key; every other field is carried over
   * byte-for-byte, and the single {@link writeJsonAtomic} means a reader sees the
   * old list or the new one, never a half-written manifest.
   *
   * @param {string} projectId
   * @param {string} revision
   * @param {'previews'|'contactSheets'|'reviews'} indexKey
   * @param {object} artifact
   * @returns {object[]} the revision's entries under that key, in emission order.
   */
  recordRevisionArtifact(projectId, revision, indexKey, artifact) {
    const path = join(this.revisionDirectory(projectId, revision), 'revision-manifest.json')
    const manifest = readJson(path)
    if (manifest === null) {
      // A revision directory with no manifest did not finish publishing, so there
      // is nothing to amend and nothing safe to write into it.
      return [artifact]
    }
    const existing = Array.isArray(manifest[indexKey]) ? manifest[indexKey] : []
    // Re-emitting the same path replaces its entry rather than duplicating it:
    // re-rendering a view after a fix must not make the sheet look like two.
    const next = [...existing.filter(entry => entry.path !== artifact.path), artifact]
    writeJsonAtomic(path, { ...manifest, [indexKey]: next })
    return next
  }

  /**
   * The newest revision at or before `revision` that has a `.blend` checkpoint.
   *
   * A preview must render the scene the caller asked for. Compiling a revision
   * from spec is always available (the spec is the source of truth), but a
   * checkpoint is cheaper and — importantly — is the artifact the SPEC requires
   * the renderer to consume when one exists (SPEC §9.1 "已有 Checkpoint").
   *
   * @param {string} projectId
   * @param {string} [revision]
   * @returns {{ revision: string, path: string }|null}
   */
  findCheckpointAtOrBefore(projectId, revision) {
    const ceiling = revision === undefined ? null : parseRevisionId(revision)
    const candidates = this.listRevisions(projectId)
      .filter(candidate => ceiling === null || /** @type {number} */ (parseRevisionId(candidate)) <= ceiling)
      .reverse()
    for (const candidate of candidates) {
      const path = this.checkpointPath(projectId, candidate)
      if (path !== null) return { revision: candidate, path }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /** Absolute path of a job record. */
  jobPath(projectId, jobId) {
    requireSafeSegment(jobId, 'job id')
    return join(this.projectDirectory(projectId), 'jobs', `${jobId}.json`)
  }

  /** Persist a job record. */
  writeJob(projectId, record) {
    const path = this.jobPath(projectId, record.jobId)
    writeJsonAtomic(path, record)
    return record
  }

  /** Read a job record, or throw when it is unknown. */
  readJob(projectId, jobId) {
    const record = readJson(this.jobPath(projectId, jobId))
    if (record === null) {
      throw new BlenderError(
        BlenderErrorCode.PROJECT_NOT_FOUND,
        `Project "${projectId}" has no job "${jobId}".`,
        { detail: { projectId, jobId } },
      )
    }
    return record
  }

  /**
   * Allocate a job id. Monotonic within the project and readable in a log,
   * because a job id ends up in a tool result the model reasons about.
   * @param {string} projectId
   * @param {string} action
   * @returns {string}
   */
  allocateJobId(projectId, action) {
    const directory = join(this.projectDirectory(projectId), 'jobs')
    const existing = existsSync(directory)
      ? readdirSync(directory).filter(name => name.endsWith('.json')).length
      : 0
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
    return `${action}-${stamp}-${String(existing + 1).padStart(3, '0')}`
  }

  // -------------------------------------------------------------------------
  // Idempotency ledger (SPEC §8.5)
  // -------------------------------------------------------------------------

  /**
   * The ledger path for an idempotency key.
   *
   * The key is hashed rather than used as a file name: a key is caller-supplied
   * free text, and hashing removes every question about separators, length and
   * case-folding on a case-insensitive filesystem. The raw key is stored inside
   * the record so the ledger stays readable.
   *
   * @param {string} projectId
   * @param {string} idempotencyKey
   * @returns {string}
   */
  idempotencyPath(projectId, idempotencyKey) {
    return join(this.projectDirectory(projectId), 'operations', `${sha256(idempotencyKey).slice(0, 32)}.json`)
  }

  /**
   * Look up a previously recorded outcome for an idempotency key.
   * @param {string} projectId
   * @param {string} idempotencyKey
   * @returns {object|null}
   */
  readIdempotencyRecord(projectId, idempotencyKey) {
    const path = this.idempotencyPath(projectId, idempotencyKey)
    const record = readJson(path)
    if (record === null) return null
    if (record.idempotencyKey !== idempotencyKey) {
      // A hash collision, or a file someone copied. Either way the safe answer is
      // "no record", which degrades to a normal apply rather than to a wrong reuse.
      return null
    }
    return record
  }

  /** Record the outcome of an idempotency key so a retry can reuse it. */
  writeIdempotencyRecord(projectId, idempotencyKey, outcome) {
    const path = this.idempotencyPath(projectId, idempotencyKey)
    const record = {
      ...idempotencyRecordFor(projectId, idempotencyKey),
      recordedAt: new Date().toISOString(),
      ...outcome,
    }
    writeJsonAtomic(path, record)
    return record
  }

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  /**
   * Absolute path of a declared asset, contained inside the project.
   * @param {string} projectId
   * @param {string} relativePath
   * @returns {string}
   */
  assetPath(projectId, relativePath) {
    const directory = this.projectDirectory(projectId)
    return resolveInside(directory, join(directory, relativePath), `asset "${relativePath}"`)
  }

  // -------------------------------------------------------------------------
  // Index
  // -------------------------------------------------------------------------

  /**
   * Maintain a flat index of projects for fast listing.
   *
   * The index is a convenience, never an authority: `listProjectIds()` and
   * `readRecord()` read the directory tree, and a missing or stale index only
   * costs a rebuild. Keeping that direction of dependency matters — an index that
   * could disagree with the records would make "which revision is current?"
   * ambiguous, which is precisely the question the store exists to answer.
   */
  #refreshIndex(projectId, record) {
    const path = join(this.projectsRoot, 'projects.json')
    const index = readJson(path) ?? { schemaVersion: 'deepblend.project-index/v1', projects: {} }
    index.projects = index.projects ?? {}
    index.projects[projectId] = {
      title: record.title,
      currentRevision: record.currentRevision,
      updatedAt: record.updatedAt,
    }
    try {
      writeFileAtomic(path, canonicalPretty(index))
    } catch {
      // The index is derived data. Failing a successful write because a cache
      // could not be updated would make the cache more important than the truth.
    }
  }
}
