/** Durable request/retry boundary for fixed-revision editable snapshots. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { BlenderError } from '@deepblend/dsh-blender-contracts'
import { createEditableSnapshotArchive, openSnapshotFile, readSnapshotSource, snapshotRelativePath } from './editable-snapshot-archive.js'
import { buildEditableSnapshotPlan, snapshotRequest, snapshotExportId, snapshotJson } from './editable-snapshot-plan.js'
import { assertProjectWriter, projectWriterState, withProjectWriter } from './project-writer.js'

// Shared across facade instances within a Host. Durable plans and publication
// remain authoritative across processes; request leases use fail-closed ownership recovery.
const active = new Map(), planning = new Map()
const fail = (code, message) => { throw new BlenderError(code, message) }
const keyFor = (root, exportId) => `${root}/${exportId}`
function errorFor(cause) {
  if (cause instanceof BlenderError) return cause
  const code = cause.code === 'ENOENT' ? 'SNAPSHOT_SOURCE_MISSING'
    : cause.code?.startsWith('SNAPSHOT_') ? cause.code : 'SNAPSHOT_IO'
  return new BlenderError(code, cause.message ?? 'Editable snapshot preparation failed.')
}
function exportIdentifier(value) {
  if (!/^snapshot-[a-f0-9]{40}$/.test(value ?? '')) fail('SNAPSHOT_REQUEST_INVALID', 'Invalid editable snapshot id.')
  return value
}
async function directory(root, relative, create = false) {
  let path = root
  for (const part of snapshotRelativePath(relative).split('/')) {
    path = join(path, part)
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SNAPSHOT_PATH_INVALID', 'Export storage must contain only real project directories.')
  }
  return path
}
async function writeJson(root, relative, value, beforeCommit) {
  const parts = snapshotRelativePath(relative).split('/'), name = parts.pop(), parent = await directory(root, parts.join('/'))
  const temporary = join(parent, `.write-${randomUUID()}`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  let identity, committed = false, closed = false
  try {
    identity = await handle.stat({ bigint: true })
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync()
    await handle.close(); closed = true
    await directory(root, parts.join('/'))
    beforeCommit?.()
    await rename(temporary, join(parent, name)); committed = true
  } finally {
    if (!closed) await handle.close().catch(() => {})
    if (!committed && identity) await (async () => {
      await directory(root, parts.join('/'))
      const current = await lstat(temporary, { bigint: true })
      if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(temporary)
    })().catch(() => {})
  }
}
const requestPath = exportId => `export-requests/${exportId}`
async function cleanFailedPayload(root, exportId, cause) {
  if (typeof cause?.failureDirectory !== 'string'
    || !new RegExp(`^exports/\\.preparing-${exportId}-[a-f0-9-]{36}$`).test(cause.failureDirectory)) return
  const matches = (stat, expected) => stat.isDirectory() && !stat.isSymbolicLink() && expected
    && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino
  const check = async () => {
    if (!matches(await lstat(root, { bigint: true }), cause.failureRootIdentity)) return false
    await directory(root, cause.failureDirectory)
    return matches(await lstat(join(root, cause.failureDirectory), { bigint: true }), cause.failureIdentity)
  }
  if (!await check()) return
  let failed
  try { failed = (await snapshotJson(root, `${cause.failureDirectory}/failed.json`, 65536)).value }
  catch (error) { if (error.code !== 'ENOENT') return }
  // ENOSPC may have prevented the small failure receipt. The current thrown
  // error still carries the identities of this owned attempt, after FD close.
  if (failed && (failed.state !== 'failed' || failed.exportId !== exportId || failed.code !== cause.code)) return
  try { await lstat(join(root, cause.failureDirectory, 'ready.json')); return } catch (error) { if (error.code !== 'ENOENT') return }
  for (const name of ['snapshot.zip', 'file-manifest.json']) {
    if (!await check()) return
    const path = join(root, cause.failureDirectory, name)
    const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) return false
    if (stat) await unlink(path)
  }
  if (!failed && await check()) await writeJson(root, `${cause.failureDirectory}/failed.json`, {
    state: 'failed', exportId, code: cause.code, message: cause.message, partialPayloadRemoved: true,
  }).catch(() => {})
  return true
}
const statusBase = plan => ({ exportId: plan.exportId, projectId: plan.request.projectId, revision: plan.request.revision,
  storeIdentity: plan.storeIdentity,
  planFrozen: plan.schemaVersion === 'deepblend.snapshot-plan/v1',
  videoJobId: plan.request.videoJobId, requestId: plan.request.requestId, createdAt: plan.createdAt,
  totalBytes: plan.files.reduce((sum, file) => sum + file.bytes, 0) })

export class EditableSnapshots {
  constructor(store, { archive = createEditableSnapshotArchive, planner = buildEditableSnapshotPlan } = {}) {
    this.store = store; this.archive = archive; this.planner = planner
    this.storeIdentity = createHash('sha256').update(JSON.stringify([store.projectsRoot, store.workspaceRoot])).digest('hex')
    this.disposed = false; this.pending = new Set(); this.controller = new AbortController()
  }
  assertStore(expected) {
    if (expected !== undefined && expected !== this.storeIdentity) fail('SNAPSHOT_STORE_CHANGED', 'The project store changed. Refresh the workbench before preparing or downloading a snapshot.')
  }
  root(projectId) { this.store.readRecord(projectId); return this.store.projectDirectory(projectId) }
  async readPlan(projectId, exportId) {
    exportIdentifier(exportId)
    const root = this.root(projectId)
    let plan
    try {
      try { plan = (await snapshotJson(root, `${requestPath(exportId)}/plan.json`, 32 * 1024 ** 2)).value }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        plan = (await snapshotJson(root, `${requestPath(exportId)}/request.json`, 65536)).value
      }
    }
    catch (error) { if (error.code === 'ENOENT') fail('SNAPSHOT_NOT_FOUND', 'This project has no such editable snapshot request.'); throw errorFor(error) }
    if (!['deepblend.snapshot-plan/v1', 'deepblend.snapshot-request/v1'].includes(plan.schemaVersion) || plan.exportId !== exportId || plan.request?.projectId !== projectId
      || snapshotExportId(plan.request.requestId) !== exportId || !Array.isArray(plan.files)
      || plan.schemaVersion === 'deepblend.snapshot-plan/v1' && !plan.files.length)
      fail('SNAPSHOT_METADATA_INVALID', 'The saved snapshot plan is invalid.')
    snapshotRequest(plan.request)
    plan.storeIdentity = this.storeIdentity
    return { root, plan }
  }
  async ready(root, plan) {
    if (plan.schemaVersion !== 'deepblend.snapshot-plan/v1') return null
    let receipt
    try { receipt = (await snapshotJson(root, `exports/${plan.exportId}/ready.json`, 65536)).value }
    catch (error) { if (error.code === 'ENOENT') return null; throw errorFor(error) }
    if (receipt.schemaVersion !== 'deepblend.snapshot-archive/v1' || receipt.state !== 'ready' || receipt.exportId !== plan.exportId
      || receipt.archive?.path !== `exports/${plan.exportId}/snapshot.zip`
      || !/^[a-f0-9]{64}$/.test(receipt.archive?.sha256 ?? '') || !Number.isSafeInteger(receipt.archive?.bytes) || receipt.archive.bytes < 1
      || receipt.manifest?.path !== 'file-manifest.json' || receipt.fileCount !== plan.files.length)
      fail('SNAPSHOT_METADATA_INVALID', 'The published snapshot receipt is invalid.')
    const manifest = await readSnapshotSource(root, `exports/${plan.exportId}/file-manifest.json`, { collect: true, maxBytes: 8 * 1024 ** 2, expected: receipt.manifest })
    const files = JSON.parse(manifest.contents.toString('utf8'))
    const expected = plan.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, source: { type: file.sourceType, path: file.sourcePath } }))
    if (JSON.stringify(files.files) !== JSON.stringify(expected) || files.totalBytes !== statusBase(plan).totalBytes)
      fail('SNAPSHOT_METADATA_INVALID', 'The published snapshot does not match the saved request plan.')
    return { ...statusBase(plan), state: 'ready', phase: 'ready', writtenBytes: files.totalBytes, verifiedBytes: files.totalBytes,
      archive: { bytes: receipt.archive.bytes, sha256: receipt.archive.sha256 },
      downloadUrl: `/deepblend/projects/${encodeURIComponent(plan.request.projectId)}/editable-snapshots/${plan.exportId}/download?storeIdentity=${this.storeIdentity}` }
  }
  async get({ projectId, exportId }) {
    const { root, plan } = await this.readPlan(projectId, exportId)
    const ready = await this.ready(root, plan)
    if (ready) return ready
    const running = active.get(keyFor(root, exportId))
    if (running) {
      if (running.status.state !== 'preparing') { await running.promise; return this.get({ projectId, exportId }) }
      return { ...running.status }
    }
    let receipt
    try { receipt = (await snapshotJson(root, `${requestPath(exportId)}/status.json`, 65536)).value }
    catch (error) { if (error.code !== 'ENOENT') throw errorFor(error) }
    if (receipt && ['exportId', 'projectId', 'revision', 'videoJobId', 'requestId'].some(field => receipt[field] !== statusBase(plan)[field]))
      fail('SNAPSHOT_METADATA_INVALID', 'The saved preparation status does not match its fixed plan.')
    const progress = receipt ? { phase: receipt.phase, writtenBytes: receipt.writtenBytes, verifiedBytes: receipt.verifiedBytes,
      ...(receipt.failureDirectory ? { failureDirectory: receipt.failureDirectory, partialPayloadRemoved: receipt.partialPayloadRemoved === true } : {}) } : {}
    const ownership = projectWriterState(join(root, requestPath(exportId)), this.store.workspaceRoot)
    if (ownership === 'held') return { ...statusBase(plan), ...progress, state: 'preparing' }
    if (ownership === 'unknown') return { ...statusBase(plan), ...progress, state: 'failed', error: {
      code: 'SNAPSHOT_OWNER_UNVERIFIED', message: 'Snapshot writer ownership cannot be verified. Inspect its writer lease only after all Hosts have stopped.' } }
    if (['failed', 'cancelled'].includes(receipt?.state)) return { ...statusBase(plan), ...progress, state: receipt.state, error: receipt.error }
    return { ...statusBase(plan), state: 'failed', phase: 'interrupted', error: {
      code: 'SNAPSHOT_INTERRUPTED', message: 'Preparation stopped before publication. Repeat the original request to resume the fixed plan.' } }
  }
  async create(input) {
    this.assertStore(input?.expectedStoreIdentity)
    if (this.disposed) fail('SNAPSHOT_CANCELLED', 'The snapshot Host is stopping.')
    const request = snapshotRequest(input), root = this.root(request.projectId), exportId = snapshotExportId(request.requestId)
    const key = keyFor(root, exportId)
    if (!planning.has(key)) {
      const operation = this.prepare(root, request, exportId)
      planning.set(key, operation)
      this.pending.add(operation)
      operation.finally(() => this.pending.delete(operation)).catch(() => {})
      operation.finally(() => { if (planning.get(key) === operation) planning.delete(key) }).catch(() => {})
    }
    const plan = await planning.get(key)
    if (this.disposed) fail('SNAPSHOT_CANCELLED', 'The snapshot Host stopped before preparation could start.')
    if (JSON.stringify(plan.request) !== JSON.stringify(request)) fail('SNAPSHOT_REQUEST_CONFLICT', 'This request id already names a different fixed revision or video selection.')
    const ready = await this.ready(root, plan)
    if (ready) return ready
    if (!active.has(key)) this.launch(root, plan)
    return { ...active.get(key).status }
  }
  async prepare(root, request, exportId) {
    try { return (await this.readPlan(request.projectId, exportId)).plan }
    catch (error) { if (error.code !== 'SNAPSHOT_NOT_FOUND') throw error }
    await directory(root, 'export-requests', true)
    const temporary = `export-requests/.planning-${exportId}-${randomUUID()}`
    await directory(root, temporary, true)
    try {
      const plan = { schemaVersion: 'deepblend.snapshot-request/v1', request, exportId, createdAt: new Date().toISOString(),
        storeIdentity: this.storeIdentity, files: [] }
      await writeJson(root, `${temporary}/request.json`, plan)
      await directory(root, temporary)
      try { await rename(join(root, temporary), join(root, requestPath(exportId))) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
        return (await this.readPlan(request.projectId, exportId)).plan
      }
      return plan
    } catch (cause) {
      const error = errorFor(cause)
      await writeJson(root, `${temporary}/failure.json`, { code: error.code, message: error.message }).catch(() => {})
      throw error
    }
  }
  launch(root, plan) {
    const key = keyFor(root, plan.exportId), controller = new AbortController()
    const running = { owner: this, controller, status: { ...statusBase(plan), state: 'preparing',
      phase: plan.schemaVersion === 'deepblend.snapshot-plan/v1' ? 'preparing' : 'planning', writtenBytes: 0, verifiedBytes: 0 }, promise: null }
    const leaseDirectory = join(root, requestPath(plan.exportId))
    const writeStatus = value => { assertProjectWriter(leaseDirectory); return writeJson(root, `${requestPath(plan.exportId)}/status.json`, value, () => assertProjectWriter(leaseDirectory)) }
    try { running.promise = withProjectWriter(leaseDirectory, this.store.workspaceRoot, () => {
      active.set(key, running)
      return (async () => {
      let checkpoint = Promise.resolve(), lastCheckpoint = 0, planningDirectory = null, planningIdentity = null, frozen = plan.schemaVersion === 'deepblend.snapshot-plan/v1'
      try {
        // The lease-free read in create() may have raced a previous owner.
        // Re-read after acquisition: a frozen plan can never be replanned.
        const latest = (await this.readPlan(plan.request.projectId, plan.exportId)).plan
        if (JSON.stringify(latest.request) !== JSON.stringify(plan.request)) fail('SNAPSHOT_REQUEST_CONFLICT', 'The saved snapshot request changed before its writer was acquired.')
        plan = latest; frozen = plan.schemaVersion === 'deepblend.snapshot-plan/v1'
        const alreadyReady = await this.ready(root, plan)
        if (alreadyReady) { running.status = alreadyReady; return }
        running.status = { ...statusBase(plan), state: 'preparing', phase: frozen ? 'preparing' : 'planning', writtenBytes: 0, verifiedBytes: 0 }
        await writeStatus({ ...running.status, updatedAt: Date.now() })
        if (!frozen) {
          planningDirectory = `${requestPath(plan.exportId)}/.planning-${randomUUID()}`
          await directory(root, planningDirectory, true)
          planningIdentity = await lstat(join(root, planningDirectory), { bigint: true })
          const prepared = await this.planner({ store: this.store, request: plan.request, exportId: plan.exportId,
            temporaryDirectory: planningDirectory, signal: controller.signal })
          prepared.createdAt = plan.createdAt; prepared.storeIdentity = this.storeIdentity
          if (controller.signal.aborted) throw new BlenderError('SNAPSHOT_CANCELLED', 'Snapshot planning was cancelled.')
          assertProjectWriter(leaseDirectory)
          await writeJson(root, `${requestPath(plan.exportId)}/plan.json`, prepared, () => assertProjectWriter(leaseDirectory))
          plan = prepared; frozen = true
          running.status = { ...statusBase(plan), state: 'preparing', phase: 'preparing', writtenBytes: 0, verifiedBytes: 0 }
        }
        await this.archive({ projectRoot: root, exportId: plan.exportId, files: plan.files, signal: controller.signal,
          onProgress: progress => {
            assertProjectWriter(leaseDirectory)
            running.status = { ...running.status, ...progress }
            if (Date.now() - lastCheckpoint > 2000) {
              lastCheckpoint = Date.now()
              const receipt = { ...running.status, updatedAt: lastCheckpoint }
              checkpoint = checkpoint.then(() => writeStatus(receipt)).catch(() => {})
            }
          } })
        running.status = await this.ready(root, plan)
      } catch (cause) {
        // The archive promise closes all its FDs before rejecting. Delete only
        // this attempt's known payload, after matching the retained directory
        // and root identities; never scan or remove crash/unknown attempts.
        const partialPayloadRemoved = await cleanFailedPayload(root, plan.exportId, cause).catch(() => false)
        // Another process may have won the non-overwriting publication race.
        const ready = await this.ready(root, plan).catch(() => null)
        if (ready) running.status = ready
        else {
          const error = errorFor(cause)
          running.status = { ...running.status, state: error.code === 'SNAPSHOT_CANCELLED' ? 'cancelled' : 'failed',
            error: { code: error.code, message: error.message }, ...(cause.failureDirectory ? {
              failureDirectory: cause.failureDirectory, partialPayloadRemoved: partialPayloadRemoved === true,
            } : {}) }
        }
      } finally {
        await checkpoint
        if (planningDirectory && !frozen) {
          // Only this attempt's flat metadata directory is disposable. A
          // committed plan keeps its pinned generated sources for every retry.
          await (async () => {
            assertProjectWriter(leaseDirectory)
            await directory(root, planningDirectory)
            const stat = await lstat(join(root, planningDirectory), { bigint: true })
            if (stat.dev !== planningIdentity.dev || stat.ino !== planningIdentity.ino) return
            const children = []
            for (const name of await readdir(join(root, planningDirectory))) {
              if (!/^\d+\.json$/.test(name)) return
              const child = await lstat(join(root, planningDirectory, name), { bigint: true })
              if (!child.isFile() || child.isSymbolicLink()) return
              children.push({ name, dev: child.dev, ino: child.ino })
            }
            for (const child of children) {
              const current = await lstat(join(root, planningDirectory, child.name), { bigint: true })
              const parent = await lstat(join(root, planningDirectory), { bigint: true })
              if (parent.dev !== planningIdentity.dev || parent.ino !== planningIdentity.ino || current.dev !== child.dev || current.ino !== child.ino || !current.isFile()) return
              await unlink(join(root, planningDirectory, child.name))
            }
            await rmdir(join(root, planningDirectory))
          })().catch(() => {})
        }
        await Promise.resolve().then(() => writeStatus(running.status)).catch(() => {})
        if (active.get(key) === running) active.delete(key)
      }
      })()
    }); running.promise.catch(() => {}) } catch (cause) {
      if (cause.code === 'REVISION_CONFLICT') fail('SNAPSHOT_BUSY', 'Another Host owns this snapshot request, or its writer ownership requires inspection. Retry after that writer finishes.')
      throw errorFor(cause)
    }
  }
  async cancel({ projectId, exportId, expectedStoreIdentity }) {
    this.assertStore(expectedStoreIdentity)
    const { root, plan } = await this.readPlan(projectId, exportId)
    const ready = await this.ready(root, plan)
    if (ready) return ready
    const running = active.get(keyFor(root, exportId))
    if (running) { running.controller.abort(); await running.promise }
    else {
      try {
        await withProjectWriter(join(root, requestPath(exportId)), this.store.workspaceRoot, async () => {
          const status = await this.get({ projectId, exportId })
          await writeJson(root, `${requestPath(exportId)}/status.json`, { ...status, state: 'cancelled', error: { code: 'SNAPSHOT_CANCELLED', message: 'Snapshot preparation was cancelled.' } },
            () => assertProjectWriter(join(root, requestPath(exportId))))
        })
      } catch (cause) {
        if (cause.code === 'REVISION_CONFLICT') fail('SNAPSHOT_BUSY', 'Another Host owns this request; cancel it from that Host, or retry after it finishes.')
        throw errorFor(cause)
      }
    }
    return this.get({ projectId, exportId })
  }
  async open({ projectId, exportId, signal, expectedStoreIdentity }) {
    this.assertStore(expectedStoreIdentity)
    const { root, plan } = await this.readPlan(projectId, exportId), status = await this.ready(root, plan)
    if (!status) fail('SNAPSHOT_NOT_READY', 'This snapshot is not ready to download.')
    try {
      const file = await openSnapshotFile(root, `exports/${exportId}/snapshot.zip`, status.archive, { signal })
      return { ...file, filename: `${exportId}.zip`, contentType: 'application/zip' }
    } catch (error) { throw errorFor(error) }
  }
  async dispose() {
    this.disposed = true; this.controller.abort()
    await Promise.allSettled([...this.pending])
    const pending = [...active.values()].filter(running => running.owner === this).map(running => {
      running.controller.abort(); return running.promise
    })
    await Promise.allSettled(pending)
  }
}
