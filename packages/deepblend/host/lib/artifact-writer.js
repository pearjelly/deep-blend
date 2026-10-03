/** Short, bounded publication leases for emitted artifacts on a local filesystem. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout } from 'node:timers/promises'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { assertProjectWriter, withProjectWriter } from './project-writer.js'

const ownership = new AsyncLocalStorage()

export async function withArtifactWriter(directory, workspaceRoot, action, options = {}) {
  const { signal, timeoutMs = 10_000 } = options
  const checkCancelled = () => {
    if (signal?.aborted) throw new BlenderError(BlenderErrorCode.ABORTED, 'Artifact publication was cancelled.')
  }
  checkCancelled()
  // Only calls in the owning async chain may join its lease. A second Host in
  // this process must wait just like a second OS process; a global flag is unsafe.
  if (ownership.getStore()?.has(directory)) {
    assertProjectWriter(directory)
    return action()
  }
  const deadline = performance.now() + timeoutMs
  for (;;) {
    checkCancelled()
    let entered = false
    try {
      // The existing lease primitive also covers dead-owner recovery and release.
      // The revision directory is a different key from the project decision lock.
      return await withProjectWriter(directory, workspaceRoot, () => {
        entered = true
        const parents = new Set(ownership.getStore() ?? [])
        parents.add(directory)
        return ownership.run(parents, action)
      })
    } catch (cause) {
      // Retrying an action could duplicate its file changes. Retry acquisition only.
      if (entered || cause.code !== BlenderErrorCode.REVISION_CONFLICT) throw cause
      if (performance.now() >= deadline) {
        throw new BlenderError(BlenderErrorCode.REVISION_CONFLICT,
          'Artifact publication could not acquire its revision lease within the wait limit. Retry after the current publisher finishes.',
          { detail: { ...cause.detail, timeoutMs } })
      }
      try { await setTimeout(Math.min(10, Math.max(1, deadline - performance.now())), undefined, { signal }) }
      catch (cause) {
        checkCancelled()
        throw cause
      }
    }
  }
}
