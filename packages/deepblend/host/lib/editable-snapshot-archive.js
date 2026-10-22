/**
 * Low-level archive writer. The Host must first resolve a revision's allowlist
 * and producer/asset identities; this module neither discovers files nor proves
 * that an arbitrary .blend is portable. Source bytes are never rewritten.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, statfs, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import yauzl from 'yauzl'

const GiB = 1024 ** 3
export const SNAPSHOT_ARCHIVE_LIMITS = Object.freeze({
  files: 10000, fileBytes: 16 * GiB, totalBytes: 64 * GiB,
  archiveBytes: 80 * GiB, manifestBytes: 8 * 1024 ** 2, chunkBytes: 256 * 1024,
})
export const SNAPSHOT_FILE_MANIFEST = 'file-manifest.json'
const ARCHIVE_NAME = 'snapshot.zip'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const identityKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']

export class SnapshotArchiveError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'SnapshotArchiveError'
    this.code = code
  }
}
const fail = (code, message) => { throw new SnapshotArchiveError(code, message) }
function checkAbort(signal) {
  if (signal?.aborted) throw new SnapshotArchiveError('SNAPSHOT_CANCELLED', 'Snapshot preparation was cancelled.', { cause: signal.reason })
}

/** More restrictive than ZIP: the extracted names must also work on Windows. */
export function snapshotRelativePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024
    || /[\\\x00-\x1f\x7f:<>"|?*]/u.test(value)
    || value.split('/').some(part => !part || Buffer.byteLength(part) > 255 || part === '.' || part === '..' || /[ .]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    fail('SNAPSHOT_PATH_INVALID', 'Snapshot members require contained, portable relative paths.')
  }
  return value
}

function fileIdentity(stats) {
  return Object.fromEntries(identityKeys.map(key => [key, String(stats[key])]))
}
function sameIdentity(stats, expected) {
  return identityKeys.every(key => String(stats[key]) === expected[key])
}
function sameNode(stats, expected) {
  return String(stats.dev) === String(expected.dev) && String(stats.ino) === String(expected.ino)
}
async function maybeStat(path) {
  try { return await lstat(path, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function trustedRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !projectRoot) fail('SNAPSHOT_PATH_INVALID', 'A Host-resolved project root is required.')
  // The root is a trusted Host capability, never a request-supplied destination.
  const root = await realpath(resolve(projectRoot))
  const stats = await lstat(root, { bigint: true })
  if (!stats.isDirectory()) fail('SNAPSHOT_PATH_INVALID', 'The project root must be a directory.')
  return { root, stats }
}

/** Reject every symlink below the root, including links which stay inside it. */
async function inspectPath(context, relativePath, { directory = false, parents } = {}) {
  const rootStats = await lstat(context.root, { bigint: true })
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !sameNode(rootStats, context.stats))
    fail('SNAPSHOT_SOURCE_CHANGED', 'The project directory changed during snapshot preparation.')
  const segments = snapshotRelativePath(relativePath).split('/')
  const nodes = []
  let path = context.root
  for (let index = 0; index < segments.length; index++) {
    path = join(path, segments[index])
    const stats = await lstat(path, { bigint: true })
    const needsDirectory = index < segments.length - 1 || directory
    if (stats.isSymbolicLink() || (needsDirectory ? !stats.isDirectory() : !stats.isFile()))
      fail('SNAPSHOT_PATH_INVALID', `Snapshot path ${relativePath} must not contain links or special files.`)
    if (parents && index < segments.length - 1 && !sameNode(stats, parents[index]))
      fail('SNAPSHOT_SOURCE_CHANGED', `A parent directory of ${relativePath} changed.`)
    nodes.push(stats)
  }
  return { path, stats: nodes.at(-1), parents: nodes.slice(0, -1) }
}

function validateExpected(expected) {
  if (!Number.isSafeInteger(expected?.bytes) || expected.bytes < 0 || expected.bytes > SNAPSHOT_ARCHIVE_LIMITS.fileBytes
    || !/^[a-f0-9]{64}$/.test(expected?.sha256 ?? ''))
    fail('SNAPSHOT_IDENTITY_INVALID', 'Each source needs a fixed byte size (at most 16 GiB) and SHA256.')
}

/**
 * Pin filesystem identity AFTER the caller resolves an authoritative digest.
 * This does not bless that digest: the writer checks actual bytes against it.
 * It is serializable so a future request receipt can preserve the fixed plan.
 */
export async function pinSnapshotSource(projectRoot, sourcePath, expected) {
  validateExpected(expected)
  const context = await trustedRoot(projectRoot)
  const source = await inspectPath(context, sourcePath)
  const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = await handle.stat({ bigint: true })
    const after = await inspectPath(context, sourcePath, { parents: source.parents })
    if (!stats.isFile() || Number(stats.size) !== expected.bytes || !sameIdentity(after.stats, fileIdentity(stats)))
      fail('SNAPSHOT_SOURCE_CHANGED', `Source ${sourcePath} changed while its identity was pinned.`)
    return Object.freeze({ sourcePath, bytes: expected.bytes, sha256: expected.sha256, identity: Object.freeze(fileIdentity(stats)) })
  } finally { await handle.close() }
}

/** Read bounded metadata, or hash a large source, through one guarded FD. */
export async function readSnapshotSource(projectRoot, sourcePath, { collect = false, maxBytes = SNAPSHOT_ARCHIVE_LIMITS.fileBytes, expected, signal } = {}) {
  checkAbort(signal)
  const context = await trustedRoot(projectRoot), source = await inspectPath(context, sourcePath)
  const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true }), identity = fileIdentity(before), bytes = Number(before.size)
    if (!before.isFile() || !Number.isSafeInteger(bytes) || bytes > maxBytes) fail('SNAPSHOT_LIMIT', `Source ${sourcePath} exceeds its size limit.`)
    const hash = createHash('sha256'), chunks = []
    let offset = 0
    while (offset < bytes) {
      checkAbort(signal)
      const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_ARCHIVE_LIMITS.chunkBytes, bytes - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) fail('SNAPSHOT_SOURCE_CHANGED', `Source ${sourcePath} became truncated.`)
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (collect) chunks.push(chunk)
      offset += bytesRead
    }
    const sha256 = hash.digest('hex'), after = await inspectPath(context, sourcePath, { parents: source.parents })
    checkAbort(signal)
    if (!sameIdentity(await handle.stat({ bigint: true }), identity) || !sameIdentity(after.stats, identity)
      || expected && (expected.bytes !== bytes || expected.sha256 !== sha256))
      fail('SNAPSHOT_SOURCE_CHANGED', `Source ${sourcePath} differs from its fixed identity.`)
    return { sourcePath, bytes, sha256, identity, ...(collect ? { contents: Buffer.concat(chunks, bytes) } : {}) }
  } finally { await handle.close() }
}

/** Verify before headers and deliver from the SAME FD, with bounded memory. */
export async function openSnapshotFile(projectRoot, sourcePath, expected, { signal } = {}) {
  if (!Number.isSafeInteger(expected?.bytes) || expected.bytes < 0 || expected.bytes > SNAPSHOT_ARCHIVE_LIMITS.archiveBytes
    || !/^[a-f0-9]{64}$/.test(expected?.sha256 ?? '')) fail('SNAPSHOT_IDENTITY_INVALID', 'A download needs a fixed archive byte size and SHA256.')
  checkAbort(signal)
  const context = await trustedRoot(projectRoot), source = await inspectPath(context, sourcePath)
  const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let closed = false
  const close = async () => { if (!closed) { closed = true; await handle.close() } }
  const assertIdentity = async identity => {
    const after = await inspectPath(context, sourcePath, { parents: source.parents })
    if (!sameIdentity(await handle.stat({ bigint: true }), identity) || !sameIdentity(after.stats, identity))
      fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The snapshot archive changed during download.')
  }
  const scan = async function* (identity) {
    let offset = 0, lastChunk
    const hash = createHash('sha256')
    while (offset < expected.bytes) {
      checkAbort(signal)
      const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_ARCHIVE_LIMITS.chunkBytes, expected.bytes - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The snapshot archive became truncated.')
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk); offset += bytesRead
      // Withhold the final chunk until verification succeeds. With an HTTP
      // Content-Length, a corrupt transfer must end short of the promised size.
      if (offset < expected.bytes) yield chunk
      else lastChunk = chunk
    }
    checkAbort(signal)
    await assertIdentity(identity)
    if (hash.digest('hex') !== expected.sha256) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The snapshot archive failed SHA256 verification.')
    if (lastChunk) yield lastChunk
  }
  try {
    const before = await handle.stat({ bigint: true }), identity = fileIdentity(before)
    if (!before.isFile() || Number(before.size) !== expected.bytes) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The snapshot archive size changed.')
    for await (const _chunk of scan(identity)) { /* Verify without buffering the archive. */ }
    return { bytes: expected.bytes, sha256: expected.sha256, close,
      stream: Readable.from((async function* () { try { yield* scan(identity) } finally { await close() } })(), { objectMode: false }) }
  } catch (error) { await close(); throw error }
}

function freezePlan(files) {
  if (!Array.isArray(files) || !files.length || files.length > SNAPSHOT_ARCHIVE_LIMITS.files)
    fail('SNAPSHOT_LIMIT', 'A snapshot needs between 1 and 10000 allowlisted files.')
  const names = new Map([[SNAPSHOT_FILE_MANIFEST, { kind: 'file', path: SNAPSHOT_FILE_MANIFEST }]])
  let totalBytes = 0
  const plan = files.map(file => {
    validateExpected(file)
    const path = snapshotRelativePath(file.path), sourcePath = snapshotRelativePath(file.sourcePath)
    if (sourcePath.split('/')[0].toLowerCase() === 'exports') fail('SNAPSHOT_PATH_INVALID', 'An export cannot be a snapshot source.')
    if (!file.identity || !identityKeys.every(key => typeof file.identity[key] === 'string' && /^\d{1,30}$/.test(file.identity[key]))
      || file.identity.size !== String(file.bytes)) fail('SNAPSHOT_IDENTITY_INVALID', `Source ${sourcePath} needs a pinned file identity.`)
    if (typeof file.sourceType !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(file.sourceType))
      fail('SNAPSHOT_IDENTITY_INVALID', `Source ${sourcePath} needs an explicit source type.`)
    const parts = path.normalize('NFC').toLowerCase().split('/')
    for (let index = 0; index < parts.length; index++) {
      const key = parts.slice(0, index + 1).join('/'), kind = index === parts.length - 1 ? 'file' : 'directory'
      const original = path.split('/').slice(0, index + 1).join('/'), prior = names.get(key)
      if (prior && (kind === 'file' || prior.kind === 'file' || prior.path !== original))
        fail('SNAPSHOT_PATH_CONFLICT', `Snapshot member ${path} conflicts with another member or the file manifest.`)
      names.set(key, { kind, path: original })
    }
    totalBytes += file.bytes
    return Object.freeze({ path, sourcePath, sourceType: file.sourceType, bytes: file.bytes, sha256: file.sha256,
      identity: Object.freeze(Object.fromEntries(identityKeys.map(key => [key, file.identity[key]]))) })
  })
  if (totalBytes > SNAPSHOT_ARCHIVE_LIMITS.totalBytes) fail('SNAPSHOT_LIMIT', 'Snapshot source bytes exceed 64 GiB.')
  return { files: plan, totalBytes }
}

function manifestFor(plan) {
  return {
    schemaVersion: 'deepblend.snapshot-files/v1',
    // This manifest cannot hash itself. Its exact bytes are separately bound
    // by the ready receipt, together with the digest of the complete ZIP.
    files: plan.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256,
      source: { type: file.sourceType, path: file.sourcePath } })),
    totalBytes: plan.totalBytes,
  }
}

async function* verifiedSource(context, file, signal, progress) {
  checkAbort(signal)
  const source = await inspectPath(context, file.sourcePath)
  const handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || !sameIdentity(before, file.identity))
      fail('SNAPSHOT_SOURCE_CHANGED', `Source ${file.sourcePath} no longer matches the fixed request.`)
    const pathBefore = await inspectPath(context, file.sourcePath, { parents: source.parents })
    if (!sameIdentity(pathBefore.stats, file.identity)) fail('SNAPSHOT_SOURCE_CHANGED', `Source ${file.sourcePath} was replaced.`)
    const hash = createHash('sha256')
    let offset = 0
    while (offset < file.bytes) {
      checkAbort(signal)
      const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_ARCHIVE_LIMITS.chunkBytes, file.bytes - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) fail('SNAPSHOT_SOURCE_CHANGED', `Source ${file.sourcePath} became truncated.`)
      const bytes = buffer.subarray(0, bytesRead)
      hash.update(bytes)
      offset += bytesRead
      progress(bytesRead, file.path)
      checkAbort(signal)
      yield bytes
    }
    checkAbort(signal)
    const after = await handle.stat({ bigint: true })
    const pathAfter = await inspectPath(context, file.sourcePath, { parents: source.parents })
    if (!sameIdentity(after, file.identity) || !sameIdentity(pathAfter.stats, file.identity) || hash.digest('hex') !== file.sha256)
      fail('SNAPSHOT_SOURCE_CHANGED', `Source ${file.sourcePath} changed or does not match its recorded SHA256.`)
  } finally { await handle.close() }
}

/** Same archive FD for write, independent member readback, size and full SHA. */
async function verifyArchive(handle, expectedFiles, expectedBytes, expectedSha256, signal, progress) {
  const before = await handle.stat({ bigint: true })
  if (!before.isFile() || Number(before.size) !== expectedBytes) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The written archive size changed.')
  // autoClose:false leaves ownership with the FileHandle. All entry streams
  // finish before the owner closes it; yauzl must not close this shared FD.
  const reader = await yauzl.fromFdPromise(handle.fd, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true })
  const remaining = new Map(expectedFiles.map(file => [file.path, file]))
  for await (const entry of reader.eachEntry()) {
    checkAbort(signal)
    const expected = remaining.get(entry.fileName)
    if (!expected || entry.uncompressedSize !== expected.bytes || entry.isEncrypted())
      fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The archive contains an unexpected, duplicate or incorrectly sized member.')
    const stream = await reader.openReadStreamPromise(entry)
    const hash = createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of stream) {
        checkAbort(signal)
        bytes += chunk.length
        if (bytes > expected.bytes) fail('SNAPSHOT_ARCHIVE_MISMATCH', `Archive member ${entry.fileName} exceeds its recorded size.`)
        hash.update(chunk)
        progress(chunk.length, entry.fileName)
      }
    } finally { stream.destroy() }
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256)
      fail('SNAPSHOT_ARCHIVE_MISMATCH', `Archive member ${entry.fileName} failed SHA256 verification.`)
    remaining.delete(entry.fileName)
  }
  if (remaining.size) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The archive is missing required members.')
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(SNAPSHOT_ARCHIVE_LIMITS.chunkBytes)
  let offset = 0
  while (offset < expectedBytes) {
    checkAbort(signal)
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset)
    if (!bytesRead) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The written archive became truncated.')
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  const after = await handle.stat({ bigint: true })
  if (!sameIdentity(after, fileIdentity(before)) || hash.digest('hex') !== expectedSha256)
    fail('SNAPSHOT_ARCHIVE_MISMATCH', 'The written archive failed whole-file verification.')
  return fileIdentity(after)
}

async function writeArchive(path, context, plan, manifestBytes, signal, progress, compress, forceZip64) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
  const zip = new yazl.ZipFile()
  const hash = createHash('sha256')
  let bytes = 0, activeSource, stopped = false
  const sink = new Writable({ highWaterMark: SNAPSHOT_ARCHIVE_LIMITS.chunkBytes, write(chunk, _encoding, callback) {
    ;(async () => {
      checkAbort(signal)
      if (bytes + chunk.length > SNAPSHOT_ARCHIVE_LIMITS.archiveBytes) fail('SNAPSHOT_LIMIT', 'The archive exceeds 80 GiB.')
      let offset = 0
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset, bytes + offset)
        if (!result.bytesWritten) fail('SNAPSHOT_IO', 'The archive write made no progress.')
        offset += result.bytesWritten
      }
      hash.update(chunk)
      bytes += chunk.length
    })().then(() => callback(), callback)
  } })
  const stop = error => {
    if (stopped) return
    stopped = true
    activeSource?.destroy(error)
    zip.outputStream.destroy(error)
    sink.destroy(error)
  }
  zip.on('error', stop)
  const abort = () => stop(new SnapshotArchiveError('SNAPSHOT_CANCELLED', 'Snapshot preparation was cancelled.', { cause: signal.reason }))
  signal?.addEventListener('abort', abort, { once: true })
  const writing = pipeline(zip.outputStream, sink)
  // Observe failures immediately even if source setup below throws first.
  writing.catch(() => {})
  try {
    checkAbort(signal)
    const options = { compress, compressionLevel: compress ? 1 : 0, forceZip64Format: forceZip64, mode: 0o100644, mtime: new Date('2000-01-01T00:00:00Z') }
    for (const file of plan.files) {
      zip.addReadStreamLazy(file.path, { ...options, size: file.bytes }, callback => {
        if (stopped) return callback(new SnapshotArchiveError('SNAPSHOT_CANCELLED', 'Archive writing stopped.'))
        activeSource = Readable.from(verifiedSource(context, file, signal, (n, member) => progress('writing', n, member)),
          { objectMode: false, highWaterMark: SNAPSHOT_ARCHIVE_LIMITS.chunkBytes })
        // Unlike addFile(), yazl's lazy-stream API leaves input errors to us.
        activeSource.on('error', stop)
        callback(null, activeSource)
      })
    }
    zip.addBuffer(manifestBytes, SNAPSHOT_FILE_MANIFEST, options)
    zip.end({ forceZip64Format: forceZip64 })
    await writing
    await handle.sync()
    const digest = hash.digest('hex')
    const identity = await verifyArchive(handle, [...plan.files, { path: SNAPSHOT_FILE_MANIFEST, bytes: manifestBytes.length, sha256: sha256(manifestBytes) }],
      bytes, digest, signal, (n, member) => progress('verifying', n, member))
    return { bytes, sha256: digest, identity }
  } catch (error) {
    stop(error)
    await writing.catch(() => {})
    // Readable.from waits for the generator's finally block to close its FD.
    if (activeSource && !activeSource.closed) await new Promise(resolve => activeSource.once('close', resolve))
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    await handle.close()
  }
}

async function syncDirectory(path) {
  // Directory fsync is unavailable on Windows. Atomic rename remains the
  // visibility boundary there; power-loss durability depends on the filesystem.
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try { await handle.sync() } finally { await handle.close() }
}
async function writeDurableJson(path, bytes, signal) {
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    const before = await handle.stat({ bigint: true }), hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(Math.min(SNAPSHOT_ARCHIVE_LIMITS.chunkBytes, bytes.length))
    let offset = 0
    while (offset < bytes.length) {
      checkAbort(signal)
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes.length - offset), offset)
      if (!bytesRead) fail('SNAPSHOT_ARCHIVE_MISMATCH', 'Written snapshot metadata became truncated.')
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (Number(after.size) !== bytes.length || !sameIdentity(after, fileIdentity(before)) || hash.digest('hex') !== sha256(bytes))
      fail('SNAPSHOT_ARCHIVE_MISMATCH', 'Written snapshot metadata failed byte verification.')
    return fileIdentity(after)
  } finally { await handle.close() }
}

/**
 * Publish exports/<exportId> with a single rename after byte verification.
 * Failed/incomplete .preparing-* directories remain for diagnosis and never
 * qualify as ready. Existing successful exports are never replaced. This is
 * deliberately not the requestId/revision resolver or the public download API.
 * onProgress is synchronous and may cancel via the supplied AbortController.
 */
export async function createEditableSnapshotArchive({ projectRoot, exportId, files, signal, onProgress, compress = false, forceZip64 = false }) {
  if (typeof exportId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(exportId))
    fail('SNAPSHOT_PATH_INVALID', 'The export id must be a safe, non-hidden identifier.')
  snapshotRelativePath(exportId)
  if (typeof compress !== 'boolean' || typeof forceZip64 !== 'boolean') fail('SNAPSHOT_IDENTITY_INVALID', 'Archive encoding options must be boolean.')
  const plan = freezePlan(files)
  const manifest = Buffer.from(`${JSON.stringify(manifestFor(plan), null, 2)}\n`)
  if (manifest.length > SNAPSHOT_ARCHIVE_LIMITS.manifestBytes) fail('SNAPSHOT_LIMIT', 'The file manifest exceeds 8 MiB.')
  checkAbort(signal)
  const context = await trustedRoot(projectRoot)
  await mkdir(join(context.root, 'exports'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const exportsDirectory = await inspectPath(context, 'exports', { directory: true })
  const finalPath = join(exportsDirectory.path, exportId)
  if (await maybeStat(finalPath)) fail('SNAPSHOT_EXISTS', `Export ${exportId} already exists.`)
  const stagingName = `.preparing-${exportId}-${randomUUID()}`
  const staging = join(exportsDirectory.path, stagingName)
  await mkdir(staging, { mode: 0o700 })
  const stagingStats = await lstat(staging, { bigint: true })
  let published = false, phase = 'preparing', writtenBytes = 0, verifiedBytes = 0
  const progress = (nextPhase, bytes = 0, member) => {
    phase = nextPhase
    if (phase === 'writing') writtenBytes += bytes
    if (phase === 'verifying') verifiedBytes += bytes
    onProgress?.({ state: 'preparing', phase, writtenBytes, verifiedBytes, totalBytes: plan.totalBytes, member })
  }
  const assertDestination = async () => {
    const current = await inspectPath(context, 'exports', { directory: true })
    if (!sameNode(current.stats, exportsDirectory.stats)) fail('SNAPSHOT_SOURCE_CHANGED', 'The exports directory changed.')
    const stagingNow = await inspectPath(context, `exports/${stagingName}`, { directory: true })
    if (!sameNode(stagingNow.stats, stagingStats)) fail('SNAPSHOT_SOURCE_CHANGED', 'The staging directory changed.')
  }
  try {
    const estimateBytes = Math.ceil(plan.totalBytes * (compress ? 1.14 : 1)) + manifest.length * 2 + (plan.files.length + 1) * 4096 + 1024 ** 2
    const disk = await statfs(staging, { bigint: true })
    if (BigInt(estimateBytes) > disk.bavail * disk.bsize) fail('SNAPSHOT_SPACE', 'There is not enough free space to prepare this snapshot.')
    progress('preparing')
    checkAbort(signal)
    await assertDestination()
    const manifestIdentity = await writeDurableJson(join(staging, SNAPSHOT_FILE_MANIFEST), manifest, signal)
    const archive = await writeArchive(join(staging, ARCHIVE_NAME), context, plan, manifest, signal, progress, compress, forceZip64)
    checkAbort(signal)
    progress('publishing')
    checkAbort(signal)
    await assertDestination()
    // Earlier entries must not have changed while later entries were copied.
    for (const file of plan.files) {
      checkAbort(signal)
      const current = await inspectPath(context, file.sourcePath)
      if (!sameIdentity(current.stats, file.identity)) fail('SNAPSHOT_SOURCE_CHANGED', `Source ${file.sourcePath} changed before publication.`)
    }
    const verifyOutputIdentities = async readyIdentity => {
      for (const [name, identity] of [[ARCHIVE_NAME, archive.identity], [SNAPSHOT_FILE_MANIFEST, manifestIdentity], ...(readyIdentity ? [['ready.json', readyIdentity]] : [])]) {
        const current = await inspectPath(context, `exports/${stagingName}/${name}`)
        if (!sameIdentity(current.stats, identity)) fail('SNAPSHOT_ARCHIVE_MISMATCH', `Verified output ${name} changed before publication.`)
      }
    }
    await verifyOutputIdentities()
    const receipt = {
      schemaVersion: 'deepblend.snapshot-archive/v1', state: 'ready', exportId,
      archive: { path: `exports/${exportId}/${ARCHIVE_NAME}`, ...archive },
      manifest: { path: SNAPSHOT_FILE_MANIFEST, bytes: manifest.length, sha256: sha256(manifest) },
      fileCount: plan.files.length, sourceBytes: plan.totalBytes,
    }
    if (await maybeStat(finalPath)) fail('SNAPSHOT_EXISTS', `Export ${exportId} already exists.`)
    checkAbort(signal)
    const readyIdentity = await writeDurableJson(join(staging, 'ready.json'), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), signal)
    await syncDirectory(staging)
    await assertDestination()
    await verifyOutputIdentities(readyIdentity)
    checkAbort(signal)
    // The rename call is the commit boundary. Every successful destination is
    // nonempty, so another writer cannot replace it with a directory rename.
    // No durable lock can strand a request after a process kill. Node has no
    // portable rename-no-replace primitive for an adversarial empty directory.
    try { await rename(staging, finalPath) } catch (error) {
      if (['ENOTEMPTY', 'EEXIST', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(error.code) && await maybeStat(finalPath))
        fail('SNAPSHOT_EXISTS', `Export ${exportId} already exists.`)
      throw error
    }
    published = true
    // A post-commit sync failure must not turn a published success into failed.
    await syncDirectory(exportsDirectory.path).catch(() => {})
    return receipt
  } catch (cause) {
    if (published) throw cause
    const error = cause instanceof SnapshotArchiveError ? cause : new SnapshotArchiveError('SNAPSHOT_IO', `Snapshot preparation failed during ${phase}: ${cause.message}`, { cause })
    error.failureDirectory = `exports/${stagingName}`
    error.failureIdentity = { dev: String(stagingStats.dev), ino: String(stagingStats.ino) }
    error.failureRootIdentity = { dev: String(context.stats.dev), ino: String(context.stats.ino) }
    // Retention is best effort (ENOSPC may also prevent diagnostic metadata).
    // Never follow a changed destination merely to write a failure receipt.
    await assertDestination().then(async () => {
      await unlink(join(staging, 'ready.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
      await writeFile(join(staging, 'failed.json'), `${JSON.stringify({ state: 'failed', exportId, phase, writtenBytes, verifiedBytes, code: error.code, message: error.message }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }).catch(() => {})
    throw error
  }
}
