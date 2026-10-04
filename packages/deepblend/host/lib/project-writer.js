/**
 * A project has one revision writer, including across local Node processes.
 *
 * mkdir is the acquisition primitive. A lease has no time-based expiry: a slow
 * compile must never lose ownership to a timeout. Only a recorded owner on this
 * host whose process is known to be gone can be recovered automatically. Missing
 * or malformed ownership, another hostname, EPERM and a reused live PID all fail
 * closed. The recovery guard is deliberately not recovered automatically; a crash
 * inside that short critical section needs an operator to inspect the lock paths.
 *
 * This coordinates cooperating processes on one local filesystem. It is not a
 * distributed lock for network filesystems or protection against external edits.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { BlenderError, BlenderErrorCode, sha256 } from '@deepblend/dsh-blender-contracts'
import { ensureDirectory, readJsonSafe, resolveInside } from './paths.js'

const held = new Map()

function ownerAt(path) {
  try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) } catch { return null }
}

function gone(owner) {
  if (owner?.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== 'string' || owner.token.length === 0) return false
  try { process.kill(owner.pid, 0); return false } catch (cause) { return cause.code === 'ESRCH' }
}

function conflict(directory, lockPath, owner, reason = 'another revision write is in progress') {
  const currentRevision = readJsonSafe(join(directory, 'project.json'))?.currentRevision ?? null
  return new BlenderError(BlenderErrorCode.REVISION_CONFLICT,
    `Project "${basename(directory)}" cannot be changed: ${reason}. Current revision is ${currentRevision ?? 'not yet created'}. ` +
    'Wait for the writer to finish, then read the scene again before retrying. ' +
    'If a lock owner cannot be verified, inspect the lock only after all writers have stopped.',
    { detail: { projectId: basename(directory), currentRevision, lockPath, owner } })
}

function acquire(directory, workspaceRoot) {
  const root = ensureDirectory(workspaceRoot, join(workspaceRoot, '.revision-writers'), 'revision writer locks')
  const lockPath = resolveInside(root, join(root, sha256(directory)), 'project writer lock')
  const recoveryPath = `${lockPath}.recovery`
  const owner = { pid: process.pid, hostname: hostname(), token: randomUUID(), createdAt: new Date().toISOString() }
  // Creating the recovery guard is itself an atomic test for another recovery.
  // Normal acquisition also passes through it, so no new writer can enter between
  // checking a dead owner and removing its stale lease.
  try { mkdirSync(recoveryPath) } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause
    throw conflict(directory, recoveryPath, ownerAt(lockPath), 'writer ownership is being checked or requires recovery')
  }
  try {
    try { mkdirSync(lockPath) } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
      const previous = ownerAt(lockPath)
      if (!gone(previous)) throw conflict(directory, lockPath, previous)
      rmSync(lockPath, { recursive: true })
      mkdirSync(lockPath)
    }
    try {
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
    } catch (cause) {
      rmSync(lockPath, { recursive: true, force: true })
      throw cause
    }
    return { lockPath, owner }
  } finally {
    rmSync(recoveryPath, { recursive: true, force: true })
  }
}

export function assertProjectWriter(directory) {
  const lease = held.get(directory)
  if (!lease || ownerAt(lease.lockPath)?.token !== lease.owner.token) {
    throw conflict(directory, lease?.lockPath ?? null, null, 'this transaction no longer owns the project writer lease')
  }
}

export function withProjectWriter(directory, workspaceRoot, action) {
  const existing = held.get(directory)
  if (existing) throw conflict(directory, existing.lockPath, existing.owner)
  const lease = acquire(directory, workspaceRoot)
  held.set(directory, lease)
  const release = () => {
    held.delete(directory)
    // Never remove another writer's lease after an external lock replacement.
    if (ownerAt(lease.lockPath)?.token === lease.owner.token) rmSync(lease.lockPath, { recursive: true, force: true })
  }
  let result
  try { result = action() } catch (cause) { release(); throw cause }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release)
  release()
  return result
}
