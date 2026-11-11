/** A point-in-time filesystem observation, not a reservation or render budget. */
import { statfsSync } from 'node:fs'

export const LOW_PROJECT_STORAGE_BYTES = 2 * 1024 ** 3

export function inspectProjectStorage(projectsRoot, { statfs = statfsSync } = {}) {
  try {
    const info = statfs(projectsRoot, { bigint: true })
    if (typeof info.bavail !== 'bigint' || typeof info.bsize !== 'bigint' || info.bavail < 0n || info.bsize <= 0n) throw Error('invalid filesystem result')
    const bytes = info.bavail * info.bsize
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('filesystem result exceeds safe numeric range')
    const availableBytes = Number(bytes)
    return { status: availableBytes < LOW_PROJECT_STORAGE_BYTES ? 'low' : 'observed', availableBytes, observedAt: Date.now() }
  } catch {
    return { status: 'unverified', availableBytes: null, observedAt: Date.now() }
  }
}
