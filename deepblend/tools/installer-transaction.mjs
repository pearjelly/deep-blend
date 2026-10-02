/** Atomic file replacement and rollback for the profile installer. */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const JOURNAL_NAME = '.deepblend-plugin-transaction.json'
const LOCK_NAME = '.deepblend-plugin-install.lock'

/** Snapshot only the file or link itself; never follow a link into a package. */
export function snapshot(path) {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return { type: 'absent' }
    throw error
  }
  if (stat.isSymbolicLink()) return { type: 'link', target: readlinkSync(path) }
  if (stat.isFile()) return { type: 'file', data: readFileSync(path).toString('base64'), mode: stat.mode & 0o777 }
  throw new Error(`Refusing to replace a directory or special file: ${path}`)
}

export const fileState = (text, mode = 0o600) => ({ type: 'file', data: Buffer.from(text).toString('base64'), mode })

function replace(path, state) {
  if (state.type === 'absent') {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.deepblend-write-${randomUUID()}`)
  try {
    if (state.type === 'link') symlinkSync(state.target, temporary)
    else {
      writeFileSync(temporary, Buffer.from(state.data, 'base64'), { mode: state.mode })
      chmodSync(temporary, state.mode)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function checkedEntries(root, entries) {
  if (!Array.isArray(entries)) throw new Error('Invalid installer recovery journal')
  for (const entry of entries) {
    const path = resolve(root, entry.path)
    const rel = relative(root, path)
    if (rel.startsWith('..') || rel === '' || rel !== entry.path) throw new Error('Invalid installer recovery path')
    for (const state of [entry.before, entry.after]) {
      if (!state || !['absent', 'file', 'link'].includes(state.type)) throw new Error('Invalid installer recovery state')
    }
  }
  return entries
}

function recover(root, journal) {
  const data = JSON.parse(readFileSync(journal, 'utf8'))
  if (data.version !== 1) throw new Error('Unknown installer recovery journal version')
  const entries = checkedEntries(root, data.entries)
  // Do not overwrite edits made after the interruption. Check every path before restoring any.
  for (const entry of entries) {
    const current = snapshot(join(root, entry.path))
    if (!isDeepStrictEqual(current, entry.before) && !isDeepStrictEqual(current, entry.after)) {
      throw new Error(`Installer recovery found a subsequent edit at ${entry.path}; journal kept at ${journal}`)
    }
  }
  for (const entry of [...entries].reverse()) replace(join(root, entry.path), entry.before)
  rmSync(journal)
}

/** Serializes this installer's mutations across profiles; --check uses no lock or writes. */
export async function withInstallerLock(root, checkOnly, task) {
  const lock = join(root, LOCK_NAME)
  const acquiring = `${lock}.acquiring`
  const journal = join(root, JOURNAL_NAME)
  if (checkOnly) {
    if (existsSync(journal) || existsSync(lock) || existsSync(acquiring)) throw new Error('An installer is running or interrupted; run the installer without --check to recover first')
    return task()
  }
  // Reclaiming a dead PID's lock also needs serialization: two recovery attempts
  // must not both remove the lock and then enter the transaction concurrently.
  try { mkdirSync(acquiring) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Another installer is acquiring its lock. Retry; if it persists, verify no installer is running before removing ${acquiring}`)
  }
  try {
    if (existsSync(lock)) {
      let owner
      try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) } catch {
        throw new Error(`Installer lock has no readable owner: ${lock}. Check for a running installer before removing that lock.`)
      }
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error(`Invalid installer lock owner: ${lock}`)
      try {
        process.kill(owner.pid, 0)
        throw new Error(`Another installer is running (PID ${owner.pid})`)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      rmSync(lock, { recursive: true })
    }
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
  } finally {
    rmSync(acquiring, { recursive: true, force: true })
  }
  try {
    if (existsSync(journal)) {
      recover(root, journal)
      console.log('recovered: restored the interrupted installer transaction')
    }
    return await task()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** All changes have been planned and validated before this function is called. */
export function applyInstallerPlan(root, changes, { afterWrite } = {}) {
  if (changes.length === 0) return
  const journal = join(root, JOURNAL_NAME)
  if (existsSync(journal)) throw new Error(`An unfinished installer transaction exists: ${journal}`)
  const entries = changes.map(({ path, before, after }) => ({ path: relative(root, path), before, after }))
  checkedEntries(root, entries)
  for (const entry of entries) {
    if (!isDeepStrictEqual(snapshot(join(root, entry.path)), entry.before)) {
      throw new Error(`Configuration changed while planning: ${entry.path}; nothing was installed`)
    }
  }
  replace(journal, fileState(JSON.stringify({ version: 1, entries })))
  try {
    for (const [index, entry] of entries.entries()) {
      const path = join(root, entry.path)
      if (!isDeepStrictEqual(snapshot(path), entry.before)) throw new Error(`Configuration changed during installation: ${entry.path}`)
      replace(path, entry.after)
      afterWrite?.(index, path)
    }
    rmSync(journal)
  } catch (error) {
    try { recover(root, journal) } catch (recoveryError) {
      throw new Error(`${error.message}; ${recoveryError.message}`)
    }
    throw new Error(`${error.message}; previous files and links restored`)
  }
}
