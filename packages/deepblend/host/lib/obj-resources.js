/** Inspect OBJ/MTL file references without loading a mesh or rewriting source bytes. */
import { openSync, closeSync, readSync, statSync } from 'node:fs'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

export const OBJ_LIMITS = Object.freeze({ modelBytes: 1024 * 1024 * 1024, materialBytes: 16 * 1024 * 1024, lineBytes: 1024 * 1024 })
const invalid = (message, code = BlenderErrorCode.ASSET_REQUEST_INVALID) => { throw new BlenderError(code, message) }
const numeric = value => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
const mapKeys = new Set(['map_Kd', 'map_Ks', 'map_Ns', 'map_d', 'refl', 'map_refl', 'map_Ke', 'bump', 'map_Bump', 'map_bump', 'map_Pr', 'map_Pm', 'map_Ps'])
const counts = { '-bm': 1, '-type': 1, '-blendu': 1, '-blendv': 1, '-boost': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1, '-mm': 2, '-t': 3, '-texres': 1 }

/** Physical lines are bounded; only OBJ has backslash/newline continuation. */
function lines(file, limit, callback, { continuation = false, signal } = {}) {
  signal?.throwIfAborted()
  if (statSync(file).size > limit) invalid('OBJ/MTL text exceeds its byte limit.', BlenderErrorCode.ASSET_TOO_LARGE)
  const fd = openSync(file, 'r'), decoder = new TextDecoder('utf-8', { fatal: true }), chunk = Buffer.alloc(64 * 1024)
  let pending = '', logical = '', bytes = 0
  const emit = physical => {
    if (Buffer.byteLength(physical) > OBJ_LIMITS.lineBytes) invalid('OBJ/MTL lines exceed 1 MiB.', BlenderErrorCode.ASSET_TOO_LARGE)
    const continued = continuation && /\\[\t\r ]*$/.test(physical)
    logical += continued ? physical.replace(/\\[\t\r ]*$/, ' ') : physical
    if (Buffer.byteLength(logical) > OBJ_LIMITS.lineBytes) invalid('OBJ/MTL logical lines exceed 1 MiB.', BlenderErrorCode.ASSET_TOO_LARGE)
    if (!continued) { callback(logical); logical = '' }
  }
  try {
    for (;;) {
      signal?.throwIfAborted()
      const n = readSync(fd, chunk, 0, chunk.length, null)
      bytes += n
      if (bytes > limit) invalid('OBJ/MTL text exceeds its byte limit.', BlenderErrorCode.ASSET_TOO_LARGE)
      pending += decoder.decode(chunk.subarray(0, n), { stream: n !== 0 })
      let start = 0, end
      while ((end = pending.indexOf('\n', start)) >= 0) { emit(pending.slice(start, end)); start = end + 1 }
      pending = pending.slice(start)
      if (Buffer.byteLength(pending) > OBJ_LIMITS.lineBytes) invalid('OBJ/MTL lines exceed 1 MiB.', BlenderErrorCode.ASSET_TOO_LARGE)
      if (!n) { if (pending || logical) emit(pending); if (logical) callback(logical); break }
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof BlenderError) throw error
    invalid('OBJ/MTL text must be valid UTF-8.', BlenderErrorCode.ASSET_CONTENT_MISMATCH)
  } finally { closeSync(fd) }
}
const field = line => /^\s*([^\s]+)(?:\s+(.*))?$/.exec(line.trim())
export function objLibraries(file, options = {}) {
  const libraries = new Set()
  lines(file, OBJ_LIMITS.modelBytes, line => {
    const match = field(line)
    if (match?.[1] !== 'mtllib') return
    let name = (match[2] ?? '').trim()
    if (name.length > 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1)
    if (!name) invalid('An OBJ material library reference is empty.')
    libraries.add(name)
  }, { ...options, continuation: true })
  return [...libraries]
}
export function mtlImages(file, options = {}) {
  const images = new Set()
  let material = false
  lines(file, OBJ_LIMITS.materialBytes, line => {
    const match = field(line)
    if (!match) return
    if (match[1] === 'newmtl') { material = true; return }
    if (!material || !mapKeys.has(match[1])) return
    let rest = (match[2] ?? '').trim()
    for (;;) {
      const token = /^([^\s]+)(?:\s+|$)/.exec(rest)?.[1]
      if (!token) break
      if (['-o', '-s'].includes(token)) {
        rest = rest.slice(token.length).trimStart()
        for (let n = 0; n < 3; n++) {
          const value = /^([^\s]+)(?:\s+|$)/.exec(rest)?.[1]
          if (!numeric(value ?? '')) break
          rest = rest.slice(value.length).trimStart()
        }
      } else if (Object.hasOwn(counts, token)) {
        rest = rest.slice(token.length).trimStart()
        for (let n = 0; n < counts[token]; n++) {
          const value = /^([^\s]+)(?:\s+|$)/.exec(rest)?.[1]
          if (!value || (token === '-bm' && !numeric(value))) invalid('An MTL texture option is incomplete or invalid.')
          rest = rest.slice(value.length).trimStart()
        }
      } else break
    }
    const name = rest.trim().replaceAll('"', '')
    if (!name) invalid('An MTL texture reference is empty.')
    images.add(name)
  }, options)
  return [...images]
}
