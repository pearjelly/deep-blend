/** Bind dependency parsing to expected bytes on one descriptor. */
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs'
import { BlenderError } from '@deepblend/dsh-blender-contracts'
const keys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']
export function openAssetMetadata(file, limit) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > BigInt(limit)) throw new BlenderError('ASSET_TOO_LARGE', 'Asset metadata exceeds its byte limit or is not a regular file.')
    return { fd, before }
  } catch (error) { closeSync(fd); throw error }
}
export function verifyAssetMetadata(fd, before, expected) {
  if (expected) {
    if (!/^[a-f0-9]{64}$/.test(expected.sha256 ?? '') || expected.bytes !== undefined && expected.bytes !== Number(before.size))
      throw new BlenderError('ASSET_HASH_MISMATCH', 'Dependency metadata has no matching recorded identity.')
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(256 * 1024)
    let offset = 0
    while (offset < Number(before.size)) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, Number(before.size) - offset), offset)
      if (!n) throw new BlenderError('ASSET_HASH_MISMATCH', 'Dependency metadata became truncated.')
      hash.update(chunk.subarray(0, n)); offset += n
    }
    if (hash.digest('hex') !== expected.sha256) throw new BlenderError('ASSET_HASH_MISMATCH', 'Parsed dependency metadata differs from its recorded SHA256.')
  }
  const after = fstatSync(fd, { bigint: true })
  if (!keys.every(key => before[key] === after[key])) throw new BlenderError('ASSET_HASH_MISMATCH', 'Dependency metadata changed during parsing.')
}
