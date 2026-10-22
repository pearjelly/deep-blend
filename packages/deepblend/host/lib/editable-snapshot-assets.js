import { Worker } from 'node:worker_threads'
import { BlenderError } from '@deepblend/dsh-blender-contracts'

export async function snapshotAssetBundle(root, asset, signal) {
  if (signal?.aborted) throw new BlenderError('SNAPSHOT_CANCELLED', 'Snapshot asset planning was cancelled.')
  if (!['gltf', 'glb', 'obj'].includes(asset.type) && !asset.path.startsWith('assets/bundles/')) return null
  const worker = new Worker(new URL('./editable-snapshot-assets-worker.js', import.meta.url), {
    workerData: { root, asset }, resourceLimits: { maxOldGenerationSizeMb: 256 },
  })
  let abort
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(new BlenderError('SNAPSHOT_CANCELLED', 'Snapshot asset planning was cancelled.'))
      signal?.addEventListener('abort', abort, { once: true })
      worker.once('message', result => result.error
        ? reject(new BlenderError(result.error.code, result.error.message)) : resolve(result.bundle))
      worker.once('error', error => reject(new BlenderError('SNAPSHOT_ASSET_UNSUPPORTED', `Asset dependency verification failed: ${error.message}`)))
      worker.once('exit', code => { if (code !== 0) reject(new BlenderError('SNAPSHOT_ASSET_UNSUPPORTED', 'Asset dependency verification stopped before completion.')) })
      if (signal?.aborted) abort()
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
