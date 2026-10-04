/** Actual frame settings, bound to bytes. Only finalization/recovery hashes PNGs;
 * UI polling checks the saved stat signature. The current journal is folded into
 * one bounded source document before the provider may replace that journal. */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BlenderError, BlenderErrorCode, frameFileName } from '@deepblend/dsh-blender-contracts'
import { writeJsonAtomic } from './paths.js'
import { inspectFrameSample, sampleFrame } from './frame-ledger.js'

const VERSION = 'deepblend.frame-sources/v1'
const MAX_BYTES = 16 * 1024 * 1024
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024
const MAX_FRAMES = 100_000
const MAX_CONFIG_BYTES = 8192
const TOKEN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const configFields = ['engine', 'resolution', 'resolutionPercentage', 'samples', 'filmTransparent', 'viewTransform', 'look', 'exposure', 'fps', 'fpsBase', 'frameStart', 'frameEnd']
const documentPath = directory => join(directory, 'frame-sources.json')
const empty = record => ({ schemaVersion: VERSION, projectId: record.projectId, jobId: record.jobId, revisionId: record.revisionId, sources: {}, frames: {}, current: null })
const fail = message => new BlenderError(BlenderErrorCode.RENDER_JOB_STATE_INVALID, message)
const limit = (reason, message) => new BlenderError(BlenderErrorCode.RENDER_JOB_STATE_INVALID, message, { detail: { frameProvenanceLimit: reason } })
/** One budget for a getJob or an entire listJobs projection, never per row. */
export const createFrameProvenanceReadBudget = () => ({ frames: 256, bytes: 256 * 1024, documents: 16, reads: 16 })
function limitedSummary(record, reason) {
  const count = record.frameEnd - record.frameStart + 1
  return { schemaVersion: VERSION, coverage: 'unknown', configuration: 'unknown', groups: [], sources: [], frames: [],
    unknownFrames: [], missingFrames: [], knownFrameCount: 0, unknownFrameCount: 0, missingFrameCount: 0,
    limited: true, limitation: reason, uncheckedFrameCount: Number.isSafeInteger(count) && count > 0 ? count : 0 }
}
const range = record => {
  const count = record.frameEnd - record.frameStart + 1
  if (!Number.isSafeInteger(count) || count < 1) throw fail('Invalid frame provenance range.')
  if (count > MAX_FRAMES) throw limit('frame-limit', `Frame provenance supports 1..${MAX_FRAMES} frames per job.`)
  return Array.from({ length: count }, (_, i) => record.frameStart + i)
}
const framePath = (record, directory, frame) => join(record.framesDirectory ?? join(directory, 'frames'), frameFileName(frame, record.filePrefix ?? 'frame_', record.filePadding ?? 4))
function signature(path) {
  try { const s = statSync(path); return s.isFile() ? { bytes: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs } : null } catch { return null }
}
const same = (a, b) => a != null && b != null && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
function digest(path) {
  try {
    const before = signature(path)
    // Frame hashing is performed after the renderer has stopped. A changed file
    // is never attributed while this read is in progress.
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024)
    const fd = openSync(path, 'r')
    try { let size; while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size)) }
    finally { closeSync(fd) }
    const sha256 = hash.digest('hex')
    const after = signature(path)
    return same(before, after) ? { sha256, stat: after } : null
  } catch { return null }
}
function actualConfig(value) {
  if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > MAX_CONFIG_BYTES) return null
  if (typeof value.engine !== 'string' || !value.engine || value.engine.length > 128 ||
      !Array.isArray(value.resolution) || value.resolution.length !== 2 || !value.resolution.every(n => Number.isSafeInteger(n) && n > 0) ||
      !(value.samples === null || Number.isSafeInteger(value.samples) && value.samples > 0)) return null
  const config = {}
  for (const key of configFields) {
    if (value[key] === undefined) continue
    if (key !== 'resolution' && value[key] !== null && !['string', 'boolean', 'number'].includes(typeof value[key])) return null
    if (typeof value[key] === 'number' && !Number.isFinite(value[key])) return null
    config[key] = value[key]
  }
  return config
}
function readSource(path, budget) {
  if (budget) budget.documents -= 1
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const maxBytes = budget ? Math.min(budget.bytes, MAX_BYTES) : MAX_BYTES
    if (size > maxBytes) throw limit(budget ? 'status-budget' : 'source-byte-limit', 'Frame source metadata exceeds its read budget; it has been preserved.')
    // Read at most the budget even if an external file grows after fstat.
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      if (budget && budget.reads-- < 1) throw limit('status-budget', 'Frame source read calls exceeded their allowance; the file has been preserved.')
      const n = readSync(fd, buffer, offset, size - offset, offset)
      if (n === 0) break
      offset += n
      if (budget) budget.bytes -= n
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'))
  } finally { closeSync(fd) }
}
function load(record, directory, budget) {
  const fresh = empty(record)
  try {
    const path = documentPath(directory)
    const data = readSource(path, budget)
    if (data.schemaVersion !== VERSION || data.projectId !== record.projectId || data.jobId !== record.jobId || data.revisionId !== record.revisionId ||
        !data.sources || !data.frames || typeof data.sources !== 'object' || typeof data.frames !== 'object') return fresh
    const expected = new Set(range(record))
    for (const [id, source] of Object.entries(data.sources)) {
      if (TOKEN.test(id) && source?.id === id && source.revisionId === record.revisionId && actualConfig(source.renderConfig) && Buffer.byteLength(JSON.stringify(source)) <= MAX_CONFIG_BYTES * 3) fresh.sources[id] = source
    }
    for (const [frame, binding] of Object.entries(data.frames)) {
      if (expected.has(Number(frame)) && String(Number(frame)) === frame && fresh.sources[binding?.sourceId] && HASH.test(binding.sha256 ?? '')) fresh.frames[frame] = binding
    }
    const c = data.current
    if (TOKEN.test(c?.id ?? '') && c.revisionId === record.revisionId && Array.isArray(c.plannedFrames) && c.plannedFrames.length <= MAX_FRAMES &&
        c.plannedFrames.every(frame => expected.has(frame)) && Buffer.byteLength(JSON.stringify(c)) <= MAX_BYTES / 2) fresh.current = c
  } catch (cause) {
    if (cause?.detail?.frameProvenanceLimit) throw cause
    // Legacy, missing or corrupt source data remains unknown.
  }
  return fresh
}
function save(directory, data) {
  const used = new Set(Object.values(data.frames).map(binding => binding.sourceId))
  for (const id of Object.keys(data.sources)) if (!used.has(id)) delete data.sources[id]
  if (Buffer.byteLength(JSON.stringify(data, null, 2) + '\n') > MAX_BYTES) throw limit('source-byte-limit', `Frame provenance exceeds its ${MAX_BYTES} byte metadata limit.`)
  writeJsonAtomic(documentPath(directory), data)
}
function foldJournal(data, record, directory) {
  const current = data.current
  if (!current) return
  const path = join(directory, 'events.jsonl')
  if (!existsSync(path)) return
  // Refuse replacement of a journal that cannot be safely absorbed. Its owner
  // may retry after resolving the problem; do not quietly discard known data.
  if (statSync(path).size > MAX_JOURNAL_BYTES) throw limit('journal-byte-limit', 'The frame journal exceeds the provenance read limit; it has been preserved.')
  const lines = readFileSync(path, 'utf8').split('\n')
  lines.pop() // only fsynced complete JSON lines count
  if (lines.length > MAX_FRAMES * 3 + 32) throw limit('journal-line-limit', 'The frame journal has too many provenance records; it has been preserved.')
  const planned = new Set(current.plannedFrames)
  let config = null, invalid = false
  const claims = new Map()
  for (const line of lines) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.attemptToken !== current.id) continue
    if (event.type === 'render_config') {
      const next = actualConfig(event.renderConfig)
      if (!next || config && JSON.stringify(next) !== JSON.stringify(config)) invalid = true
      else config = next
    } else if (event.type === 'frame' && config && planned.has(event.frame) && HASH.test(event.sha256 ?? '')) {
      claims.set(event.frame, event.sha256)
    }
  }
  if (invalid) {
    for (const [frame, binding] of Object.entries(data.frames)) if (binding.sourceId === current.id) delete data.frames[frame]
    return
  }
  if (!config) return
  const { plannedFrames, ...source } = current
  data.sources[current.id] = { ...source, renderConfig: config }
  for (const [frame, sha256] of claims) {
    // inspect() verifies this claimed digest once, after all journal records.
    data.frames[frame] = { sourceId: current.id, sha256, stat: null }
  }
}
function inspect(data, record, directory, verify) {
  const groups = new Map(), bindings = [], unknownFrames = [], missingFrames = []
  for (const frame of range(record)) {
    const path = framePath(record, directory, frame), stat = signature(path)
    if (stat === null) { missingFrames.push(frame); if (verify) delete data.frames[frame]; continue }
    const binding = data.frames[frame], source = data.sources[binding?.sourceId]
    const measured = verify && binding ? digest(path) : null
    const valid = source && (verify ? measured?.sha256 === binding.sha256 && inspectFrameSample(sampleFrame(path), {
      width: record.renderConfig?.resolution?.[0], height: record.renderConfig?.resolution?.[1],
    }).ok : same(stat, binding.stat))
    if (!valid) { unknownFrames.push(frame); if (verify) delete data.frames[frame]; continue }
    if (verify) binding.stat = measured.stat
    bindings.push({ frame, sourceId: binding.sourceId, sha256: binding.sha256 })
    const key = JSON.stringify([source.renderConfig, source.cameraId, source.checkpointSha256])
    if (!groups.has(key)) groups.set(key, { renderConfig: source.renderConfig, frames: [], sourceIds: [] })
    const group = groups.get(key); group.frames.push(frame)
    if (!group.sourceIds.includes(source.id)) group.sourceIds.push(source.id)
  }
  const known = bindings.length, complete = known > 0 && unknownFrames.length === 0 && missingFrames.length === 0
  return {
    schemaVersion: VERSION, coverage: complete ? 'complete' : known ? 'partial' : 'unknown',
    configuration: groups.size > 1 ? 'mixed' : complete ? 'uniform' : 'unknown',
    groups: [...groups.values()], unknownFrames, missingFrames, frames: bindings,
    knownFrameCount: known, unknownFrameCount: unknownFrames.length, missingFrameCount: missingFrames.length,
    sources: [...new Set(bindings.map(b => b.sourceId))].map(id => data.sources[id]),
  }
}
/** Publication may defer attribution at a metadata limit, preserving every source
 * file and journal. Recovery/startup stays strict before replacing any evidence. */
export function syncFrameProvenance(record, directory, options = {}) {
  try {
    range(record)
    const data = load(record, directory)
    foldJournal(data, record, directory)
    const summary = inspect(data, record, directory, true)
    save(directory, data)
    return summary
  } catch (cause) {
    if (options.allowLimited && cause?.detail?.frameProvenanceLimit) return limitedSummary(record, cause.detail.frameProvenanceLimit)
    throw cause
  }
}
/** No PNG reads/hashes on the status path. A skipped job is explicitly unchecked,
 * not classified as missing/corrupt or attributed from an old saved summary. */
export function readFrameProvenance(record, directory, budget = createFrameProvenanceReadBudget()) {
  const count = record.frameEnd - record.frameStart + 1
  if (!Number.isSafeInteger(count) || count < 1 || count > budget.frames || budget.documents < 1 || budget.bytes < 1 || budget.reads < 1) {
    return limitedSummary(record, 'status-budget')
  }
  budget.frames -= count
  try { return inspect(load(record, directory, budget), record, directory, false) }
  catch (cause) {
    if (cause?.detail?.frameProvenanceLimit) return limitedSummary(record, 'status-budget')
    throw cause
  }
}
/** Must finish before the provider can clear its previous journal. */
export function beginFrameAttempt(record, directory, input) {
  syncFrameProvenance(record, directory)
  const data = load(record, directory)
  const expected = new Set(range(record))
  if (!TOKEN.test(input.id) || !input.frames.every(frame => expected.has(frame))) throw fail('Invalid frame provenance attempt identity.')
  if (Buffer.byteLength(JSON.stringify(input.profile)) > MAX_CONFIG_BYTES) throw fail('The frame profile exceeds the provenance metadata limit.')
  const checkpoint = input.checkpointPath && digest(input.checkpointPath)
  data.current = {
    id: input.id, attempt: (record.attempt ?? 0) + 1, revisionId: record.revisionId,
    cameraId: input.cameraId ?? null, checkpointSha256: checkpoint?.sha256 ?? null,
    requestedSamples: input.requestedSamples ?? input.profile.samples ?? null,
    effectiveProfile: input.profile, plannedFrames: input.frames,
  }
  // A replacement is unknown until its new completion event binds its bytes.
  for (const frame of input.frames) delete data.frames[frame]
  save(directory, data)
}
