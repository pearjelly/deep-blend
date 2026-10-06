/** Browser bundle transfers own private files; only existing ingestion publishes assets. */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { BUNDLE_LIMITS, BUNDLE_LOCK, bundlePath } from './asset-bundle.js'
import { streamAsset } from './asset-io.js'
import { readJsonSafe, requireSafeSegment, resolveInside } from './paths.js'

export const ASSET_UPLOAD_LIMITS = Object.freeze({ maxFiles: BUNDLE_LIMITS.files, lifetimeMs: 15 * 60 * 1000, maxActive: 1 })
const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'failed'])
const invalid = (message, reason, code = BlenderErrorCode.ASSET_REQUEST_INVALID) => new BlenderError(code, message, { detail: { reason } })
const folded = value => value.normalize('NFC').toLowerCase()

/** Validate the whole manifest before creating directories or accepting any bytes. */
export function validateUploadManifest(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw invalid('The Host upload budget is unavailable.', 'upload-budget')
  if (!Array.isArray(request?.files) || !request.files.length || request.files.length > ASSET_UPLOAD_LIMITS.maxFiles) {
    throw invalid(`Select between 1 and ${ASSET_UPLOAD_LIMITS.maxFiles} files.`, 'file-count')
  }
  const paths = new Map(), directories = new Map()
  let totalBytes = 0
  const files = request.files.map((file, index) => {
    const path = bundlePath(file?.path), segments = path.split('/')
    if (segments.some(segment => /[. ]$/.test(segment) || /[\x7f]/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
      || folded(segment) === BUNDLE_LOCK)) throw invalid('A selected path uses a reserved or nonportable name.', 'reserved-path')
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw invalid('Every selected file needs its actual nonnegative byte size.', 'file-size')
    totalBytes += file.bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) throw invalid('The selected files exceed the configured total upload budget.', 'total-bytes', BlenderErrorCode.ASSET_TOO_LARGE)
    const key = folded(path)
    if (paths.has(key)) throw invalid(`Selected paths collide: ${paths.get(key)} and ${path}.`, 'duplicate-path')
    paths.set(key, path)
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join('/'), directoryKey = folded(directory)
      if (directories.has(directoryKey) && directories.get(directoryKey) !== directory) {
        throw invalid('Selected directory names collide after Unicode/case normalization.', 'duplicate-directory')
      }
      directories.set(directoryKey, directory)
    }
    return { id: `file-${index}`, path, bytes: file.bytes }
  })
  if ([...paths.keys()].some(key => directories.has(key))) throw invalid('A selected path is both a file and a directory.', 'file-directory-collision')
  const entrypoint = bundlePath(request?.entrypoint)
  const entry = files.find(file => file.path === entrypoint)
  if (!entry || !entry.bytes || !/\.(gltf|glb|obj)$/i.test(entrypoint)) throw invalid('Choose one nonempty glTF, GLB or OBJ entrypoint from the selected files.', 'entrypoint')
  if (request.license !== undefined && (typeof request.license !== 'string' || request.license.length > 200)) {
    throw invalid('The optional licence source must be text of at most 200 characters.', 'license')
  }
  return { entrypoint, files, totalBytes, license: request.license?.trim() || null }
}

function ownerGone(owner, name) {
  if (owner?.schemaVersion !== 'deepblend.upload-owner/v1' || owner.token !== name || owner.hostname !== hostname()
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  try { process.kill(owner.pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
}

// A rollback may remove only the directory this attempt actually created.
// An existing path (mkdir failed) or a replaced directory is never adopted.
function sameDirectory(directory, created) {
  if (!created) return false
  try {
    const current = lstatSync(directory)
    return current.isDirectory() && current.dev === created.dev && current.ino === created.ino
  } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

/** State is per Host. Completed receipts are recovered from the asset ledger, including after restart. */
export class AssetUploadSessions {
  constructor({ root, maxBytes, readProject, ingest, published, now = Date.now, lifetimeMs = ASSET_UPLOAD_LIMITS.lifetimeMs }) {
    Object.assign(this, { root, maxBytes, readProject, ingest, published, now, lifetimeMs })
    this.sessions = new Map()
    this.owner = null
    this.closed = false
  }

  _project(projectId) {
    requireSafeSegment(projectId, 'project id')
    this.readProject(projectId)
  }

  _identity(request) {
    this._project(request?.projectId)
    if (!/^upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request?.uploadId ?? '')) {
      throw invalid('Unknown upload session. Select the files again.', 'unknown-session')
    }
  }

  _ownerDirectory() {
    if (this.owner) return join(this.root, this.owner.token)
    // The base is Host-controlled and outside project artifacts. Never clean an
    // owner from another machine, a live/reused PID, or malformed ownership.
    resolveInside(dirname(this.root), this.root, 'upload session root')
    mkdirSync(this.root, { recursive: true })
    const claim = join(this.root, '.claim')
    try { mkdirSync(claim) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      throw invalid('Another Host is acquiring upload ownership, or the ownership guard needs inspection.', 'upload-host-busy')
    }
    try {
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.claim') continue
        const directory = resolveInside(this.root, entry.name, 'upload owner')
        const owner = readJsonSafe(join(directory, 'owner.json'))
        if (ownerGone(owner, entry.name)) rmSync(directory, { recursive: true, force: true })
        else throw invalid('Another or unverified Host owns model upload storage. Finish its upload before retrying.', 'upload-host-busy')
      }
      const owner = { schemaVersion: 'deepblend.upload-owner/v1', token: randomUUID(), hostname: hostname(), pid: process.pid }
      const directory = join(this.root, owner.token)
      mkdirSync(directory)
      const created = lstatSync(directory), ownerText = JSON.stringify(owner)
      try { writeFileSync(join(directory, 'owner.json'), ownerText, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        // ENOSPC can leave a partial owner file. Only our exact serialization
        // or its prefix belongs to this failed attempt; foreign content stays.
        let contents = null
        try { contents = readFileSync(join(directory, 'owner.json'), 'utf8') }
        catch (readError) { if (readError.code === 'ENOENT') contents = '' }
        if (contents !== null && ownerText.startsWith(contents) && sameDirectory(directory, created)
          && readdirSync(directory).every(name => name === 'owner.json')) rmSync(directory, { recursive: true, force: true })
        throw error
      }
      this.owner = owner
      return directory
    } finally { rmSync(claim, { recursive: true, force: true }) }
  }

  _view(session) {
    return { projectId: session.projectId, uploadId: session.uploadId, status: session.status,
      entrypoint: session.entrypoint, expiresAt: new Date(session.deadline).toISOString(),
      totalBytes: session.totalBytes, receivedBytes: session.receivedBytes,
      inFlightBytes: session.inFlightBytes, transferredBytes: session.transferredBytes,
      files: session.files.map(file => ({ ...file })), limits: { maxBytes: this.maxBytes, ...ASSET_UPLOAD_LIMITS },
      ...(session.receipt ? { receipt: session.receipt } : {}), ...(session.error ? { error: session.error } : {}) }
  }

  _releaseEmptyOwner() {
    if (!this.owner || [...this.sessions.values()].some(item => !item.cleaned)) return
    const directory = join(this.root, this.owner.token)
    if (readJsonSafe(join(directory, 'owner.json'))?.token !== this.owner.token) { this.owner = null; return }
    // Do not let parent cleanup swallow an unregistered or foreign child.
    if (readdirSync(directory).some(name => name !== 'owner.json')) { this.owner = null; return }
    rmSync(directory, { recursive: true, force: true })
    this.owner = null
  }

  _clean(session) {
    clearTimeout(session.timer)
    rmSync(session.directory, { recursive: true, force: true })
    session.cleaned = true
    session.inFlightBytes = 0
    this._releaseEmptyOwner()
  }

  _published(session) {
    const receipt = this.published(session.projectId, session.uploadId)
    if (receipt) {
      session.status = 'completed'; session.receipt = receipt
      this._clean(session)
    }
    return receipt
  }

  async _session(request) {
    this._identity(request)
    const session = this.sessions.get(request.uploadId)
    if (!session || session.projectId !== request.projectId) throw invalid('Unknown upload session. Select the files again.', 'unknown-session')
    if (!TERMINAL.has(session.status) && this.now() >= session.deadline) await this._terminate(session, 'expired')
    return session
  }

  async create(request) {
    this._project(request?.projectId)
    const manifest = validateUploadManifest(request, this.maxBytes)
    if (this.closed) throw invalid('Upload service has stopped.', 'service-stopped')
    for (const session of this.sessions.values()) {
      if (!TERMINAL.has(session.status) && this.now() >= session.deadline) await this._terminate(session, 'expired')
      if (TERMINAL.has(session.status)) {
        if (session.operation) await session.operation.catch(() => {})
        if (!session.cleaned) this._clean(session)
      }
    }
    if (this.closed) throw invalid('Upload service has stopped.', 'service-stopped')
    if ([...this.sessions.values()].some(session => !TERMINAL.has(session.status))) throw invalid('Another model upload is active. Finish or cancel it first.', 'upload-busy')
    for (const [id, session] of this.sessions) {
      if (this.sessions.size < 32) break
      if (TERMINAL.has(session.status)) this.sessions.delete(id)
    }
    request.signal?.throwIfAborted()
    const uploadId = `upload-${randomUUID()}`, directory = join(this._ownerDirectory(), uploadId)
    let created = null
    try {
      mkdirSync(directory); created = lstatSync(directory)
      mkdirSync(join(directory, 'members')); mkdirSync(join(directory, 'partial'))
    } catch (error) {
      if (readJsonSafe(join(dirname(directory), 'owner.json'))?.token === this.owner?.token && sameDirectory(directory, created)) {
        rmSync(directory, { recursive: true, force: true })
      }
      this._releaseEmptyOwner()
      throw error
    }
    const session = { ...manifest, projectId: request.projectId, uploadId, assetId: `asset-${randomUUID()}`,
      directory, deadline: this.now() + this.lifetimeMs, status: 'receiving', files: manifest.files.map(file => ({ ...file, received: false })),
      receivedBytes: 0, transferredBytes: 0, inFlightBytes: 0, controller: new AbortController(), operation: null, operationKind: null }
    session.timer = setTimeout(() => { this._terminate(session, 'expired').catch(() => {}) }, this.lifetimeMs)
    session.timer.unref?.()
    this.sessions.set(uploadId, session)
    return this._view(session)
  }

  async get(request) {
    this._identity(request)
    const receipt = this.published(request.projectId, request.uploadId)
    if (receipt) return { projectId: request.projectId, uploadId: request.uploadId, status: 'completed', receipt }
    return this._view(await this._session(request))
  }

  async put(request) {
    const session = await this._session(request)
    const file = session.files.find(file => file.id === request.fileId)
    if (!file) throw invalid('Unknown upload member.', 'unknown-file')
    if (session.status !== 'receiving' || session.operation) throw invalid('This upload cannot receive another file now.', 'upload-busy')
    if (!request.stream || typeof request.stream[Symbol.asyncIterator] !== 'function') throw invalid('Upload the member as raw bytes.', 'byte-stream')
    const signal = request.signal ? AbortSignal.any([session.controller.signal, request.signal]) : session.controller.signal
    signal.throwIfAborted()
    const partial = join(session.directory, 'partial', randomUUID())
    session.operationKind = 'file'
    session.operation = Promise.resolve().then(async () => {
      try {
        const result = await streamAsset(request.stream, partial, {
          maxBytes: Math.min(file.bytes, this.maxBytes - session.receivedBytes + (file.received ? file.bytes : 0)), signal, label: file.path,
          onBytes: bytes => {
            session.transferredBytes += bytes - session.inFlightBytes
            session.inFlightBytes = bytes
            if (this.now() >= session.deadline) {
              session.status = 'expired'
              session.controller.abort(invalid('Upload expired; select the files again.', 'expired'))
            }
          },
        })
        signal.throwIfAborted()
        if (result.bytes !== file.bytes) throw invalid(`The received length for ${file.path} differs from the selected file size.`, 'length-mismatch', BlenderErrorCode.ASSET_CONTENT_MISMATCH)
        if (file.received) {
          if (file.sha256 !== result.sha256) throw invalid('A retried upload member has different bytes; it was not overwritten.', 'retry-mismatch', BlenderErrorCode.ASSET_HASH_MISMATCH)
        } else {
          const target = resolveInside(join(session.directory, 'members'), file.path, 'upload member')
          mkdirSync(dirname(target), { recursive: true })
          renameSync(partial, target)
          Object.assign(file, { received: true, sha256: result.sha256 })
          session.receivedBytes += result.bytes
        }
        session.inFlightBytes = 0
        return this._view(session)
      } catch (error) {
        if (!TERMINAL.has(session.status)) session.status = signal.aborted ? 'cancelled' : 'failed'
        session.error = { code: error.code ?? BlenderErrorCode.ASSET_REQUEST_INVALID, message: error.message }
        this._clean(session)
        throw error
      } finally {
        rmSync(partial, { force: true }); session.inFlightBytes = 0; session.operation = null; session.operationKind = null
      }
    })
    return session.operation
  }

  async complete(request) {
    this._identity(request)
    const published = this.published(request.projectId, request.uploadId)
    if (published) return { projectId: request.projectId, uploadId: request.uploadId, status: 'completed', receipt: published }
    const session = await this._session(request)
    if (session.operationKind === 'complete') return session.operation
    if (session.status !== 'receiving' || session.operation) throw invalid('This upload cannot be completed now.', 'upload-busy')
    if (session.files.some(file => !file.received)) throw invalid('Upload every selected file before completing the bundle.', 'incomplete')
    const signal = request.signal ? AbortSignal.any([session.controller.signal, request.signal]) : session.controller.signal
    signal.throwIfAborted()
    session.status = 'completing'; session.operationKind = 'complete'
    session.operation = Promise.resolve().then(async () => {
      try {
        await this.ingest({ projectId: session.projectId, assetId: session.assetId,
          sourceRoot: join(session.directory, 'members'), sourcePath: join(session.directory, 'members', session.entrypoint),
          type: session.entrypoint.split('.').at(-1).toLowerCase(), license: session.license, signal },
        { kind: 'upload', name: session.entrypoint, uploadId: session.uploadId,
          files: session.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) })
        if (!this._published(session)) throw invalid('The completed upload is missing its asset receipt.', 'missing-receipt')
        return this._view(session)
      } catch (error) {
        // A committed ledger entry survives a dropped/failed response. Never
        // delete published content or re-import it merely to obtain a receipt.
        if (this._published(session)) return this._view(session)
        if (!TERMINAL.has(session.status)) session.status = signal.aborted ? 'cancelled' : 'failed'
        session.error = { code: error.code ?? BlenderErrorCode.ASSET_REQUEST_INVALID, message: error.message }
        this._clean(session)
        throw error
      } finally { session.operation = null; session.operationKind = null }
    })
    return session.operation
  }

  async _terminate(session, status) {
    if (session.status === 'completed') return this._view(session)
    if (!TERMINAL.has(session.status)) session.status = status
    session.controller.abort(invalid(status === 'expired' ? 'Upload expired; select the files again.' : 'Upload cancelled.', status))
    await session.operation?.catch(() => {})
    if (!this._published(session)) this._clean(session)
    return this._view(session)
  }

  async cancel(request) {
    this._identity(request)
    const receipt = this.published(request.projectId, request.uploadId)
    if (receipt) return { projectId: request.projectId, uploadId: request.uploadId, status: 'completed', receipt }
    // An unfinished session can disappear after restart or terminal eviction.
    // Report only that this Host cannot continue it; do not inspect or delete
    // unknown storage, or claim that another Host's work was cancelled.
    if (!this.sessions.has(request.uploadId)) return {
      projectId: request.projectId, uploadId: request.uploadId, status: 'unavailable', reason: 'unknown-session',
    }
    return this._terminate(await this._session(request), 'cancelled')
  }

  async dispose() {
    this.closed = true
    await Promise.all([...this.sessions.values()].map(session => this._terminate(session, 'cancelled')))
    this._releaseEmptyOwner()
  }
}
