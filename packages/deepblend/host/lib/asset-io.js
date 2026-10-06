/** Bounded asset streaming. The digest covers exactly the bytes written. */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

export async function streamAsset(source, target, { maxBytes, signal, label = 'asset', onBytes }) {
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length
      try { onBytes?.(bytes) } catch (error) { callback(error); return }
      if (bytes > maxBytes) return callback(new BlenderError(BlenderErrorCode.ASSET_TOO_LARGE,
        `${label} exceeds the configured assetMaxBytes of ${maxBytes}; the transfer was stopped.`,
        { detail: { received: bytes, maxBytes } }))
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(source, meter, createWriteStream(target, { flags: 'wx' }), { signal })
  return { bytes, sha256: hash.digest('hex') }
}
