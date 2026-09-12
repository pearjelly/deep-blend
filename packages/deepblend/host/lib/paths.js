/**
 * Path containment and atomic file writes.
 *
 * Every filesystem write DeepBlend performs goes through this module, because
 * two of the SPEC's hard requirements are properties of *this* code rather than
 * of any caller:
 *
 *  - **§15.2 workspace boundary.** A model-supplied project id, revision id or
 *    file name must never be able to name a path outside the projects root. The
 *    guard is enforced on the RESOLVED, symlink-free path, so `..`, an absolute
 *    segment, a symlinked project directory and a Windows-style drive prefix are
 *    all rejected by the same check instead of by four separate ones.
 *  - **§13.2 atomic publication.** A revision directory must appear complete or
 *    not at all. A reader (or a crash) must never observe a half-written
 *    revision, so a revision is built in a staging directory and published with
 *    a single `rename`, and individual files are written to a temp name first.
 *
 * Owner: DeepBlend Studio — M1
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

/**
 * One path segment that is safe to join under a trusted root.
 *
 * Rejects the three ways a single segment can escape: an explicit traversal, a
 * separator (which would make it two segments), and the empty/`.`/`..` names.
 * A leading `.` is allowed — revision staging directories are named `.staging-*`
 * and Blender's own `.blend1` backups are legitimate file names — so the check
 * is about traversal, not about hiding files.
 *
 * @param {unknown} segment
 * @param {string} what - used in the error message, e.g. "project id".
 * @returns {string}
 */
export function requireSafeSegment(segment, what) {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new BlenderError(BlenderErrorCode.PATH_SEGMENT_INVALID, `${what} must be a non-empty string.`)
  }
  if (segment.includes('\0')) {
    throw new BlenderError(BlenderErrorCode.PATH_SEGMENT_INVALID, `${what} contains a NUL byte.`)
  }
  if (segment.includes('/') || segment.includes('\\')) {
    throw new BlenderError(
      BlenderErrorCode.PATH_SEGMENT_INVALID,
      `${what} "${segment}" contains a path separator; it must be a single name.`,
    )
  }
  if (segment === '.' || segment === '..') {
    throw new BlenderError(
      BlenderErrorCode.PATH_SEGMENT_INVALID,
      `${what} "${segment}" is a directory traversal token.`,
    )
  }
  // Windows drive-relative names such as `C:foo` are absolute on that platform.
  if (/^[a-zA-Z]:/.test(segment)) {
    throw new BlenderError(
      BlenderErrorCode.PATH_SEGMENT_INVALID,
      `${what} "${segment}" looks like a drive-relative path.`,
    )
  }
  return segment
}

/**
 * Resolve `candidate` and assert it stays inside `root`.
 *
 * The comparison happens on realpaths where they exist, so a symlink pointing
 * out of the workspace is rejected rather than followed. When the path does not
 * exist yet — the normal case for a directory about to be created — the nearest
 * existing ancestor is realpath'd instead, which still catches a symlinked
 * parent.
 *
 * @param {string} root - trusted absolute root (already realpath'd by the caller).
 * @param {string} candidate - absolute or root-relative path.
 * @param {string} what
 * @returns {string} the resolved, contained absolute path.
 */
export function resolveInside(root, candidate, what) {
  const base = resolve(root)
  const target = isAbsolute(candidate) ? normalize(candidate) : resolve(base, candidate)

  const baseReal = safeRealpath(base)
  const targetReal = safeRealpath(target)

  if (targetReal !== baseReal && !targetReal.startsWith(baseReal + sep)) {
    throw new BlenderError(
      BlenderErrorCode.PATH_OUTSIDE_WORKSPACE,
      `${what} resolves to ${targetReal}, which is outside ${baseReal} (SPEC §15.2).`,
      { detail: { root: baseReal, resolved: targetReal } },
    )
  }
  return targetReal
}

/**
 * realpath that tolerates a not-yet-existing path, by walking up to the closest
 * existing ancestor and re-appending the missing tail.
 *
 * @param {string} target
 * @returns {string}
 */
export function safeRealpath(target) {
  const absolute = resolve(target)
  try {
    return realpathSync(absolute)
  } catch {
    // Fall through: the path (or its parent) does not exist yet.
  }
  const segments = []
  let cursor = absolute
  for (;;) {
    const parent = dirname(cursor)
    if (parent === cursor) return absolute
    segments.unshift(cursor.slice(parent.length + 1))
    cursor = parent
    try {
      return join(realpathSync(cursor), ...segments)
    } catch {
      // Keep walking up.
    }
  }
}

/** Ensure a directory exists, resolving and checking containment first. */
export function ensureDirectory(root, candidate, what) {
  const target = resolveInside(root, candidate, what)
  mkdirSync(target, { recursive: true })
  return target
}

/**
 * Write a file so a reader never sees a partial document.
 *
 * The temp name is a sibling (same filesystem, so `rename` is atomic) and is
 * removed on failure so a crash mid-write does not leave litter that a later
 * `readdir` would mistake for content.
 *
 * @param {string} path
 * @param {string} contents
 */
export function writeFileAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(temporary, contents, 'utf8')
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}

/** Write canonical JSON atomically, with a trailing newline. */
export function writeJsonAtomic(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Read and parse JSON, or return `null` when the file is absent.
 *
 * A file that exists but does not parse THROWS rather than returning null: the
 * two situations need different handling. Absence is a normal state ("this
 * project has no final render yet"); corruption is a bug that must surface with
 * the path in the message instead of being silently treated as absence, which is
 * how a corrupt revision would quietly become a lost revision.
 *
 * @param {string} path
 * @param {{ allowMissing?: boolean }} [options]
 * @returns {any}
 */
export function readJson(path, options = {}) {
  if (!existsSync(path)) {
    if (options.allowMissing === false) {
      throw new BlenderError(BlenderErrorCode.REVISION_CORRUPT, `Expected a document at ${path}, but it does not exist.`)
    }
    return null
  }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new BlenderError(BlenderErrorCode.REVISION_CORRUPT, `Could not read ${path}.`, { cause })
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new BlenderError(
      BlenderErrorCode.REVISION_CORRUPT,
      `${path} exists but is not valid JSON: ${cause.message}. Refusing to treat corruption as absence.`,
      { cause },
    )
  }
}

/**
 * Read JSON and return `null` for EVERY failure, including corruption.
 *
 * For derived data only — the projects index, a cache. Anything whose absence
 * would be a lie about the user's work must use {@link readJson}, which treats
 * corruption as an error.
 *
 * @param {string} path
 * @returns {any}
 */
export function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Atomically publish a fully-built staging directory as the final directory.
 *
 * `rename` on the same filesystem is atomic, which is the entire mechanism by
 * which SPEC §13.2's "原子发布 Revision 目录" holds: the revision directory does
 * not exist until it is complete under its real name.
 *
 * @param {string} staging
 * @param {string} finalPath
 */
export function publishDirectory(staging, finalPath) {
  if (existsSync(finalPath)) {
    throw new BlenderError(
      BlenderErrorCode.REVISION_ALLOCATION_FAILED,
      `Refusing to publish over the existing directory ${finalPath}.`,
    )
  }
  mkdirSync(dirname(finalPath), { recursive: true })
  renameSync(staging, finalPath)
}

/** Remove a directory tree, tolerating absence. */
export function removeTree(path) {
  rmSync(path, { recursive: true, force: true })
}

/** List immediate child directories of `path`, sorted; `[]` when absent. */
export function listDirectories(path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/** File size in bytes, or `null` when the file is absent. */
export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** sha256 of a file's bytes, or `null` when the file is absent. */
export function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** True when a readable file exists at `path`. */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Turn an arbitrary human title into a safe, stable project id.
 *
 * Non-ASCII titles are dropped rather than transliterated: a project id appears
 * in directory names and in tool arguments, and a predictable ASCII id that a
 * model can retype exactly is worth more than a pretty one. A title with no
 * usable ASCII ends up as `project`, and the store appends a numeric suffix on
 * collision — an id is a handle, and the human-readable name lives in
 * `project.title`.
 *
 * @param {string} title
 * @returns {string}
 */
export function slugifyProjectId(title) {
  const ascii = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return ascii.length === 0 ? 'project' : ascii
}
