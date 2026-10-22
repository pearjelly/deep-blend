/** Existing importer verification runs off the Host event loop and is cancellable. */
import { parentPort, workerData } from 'node:worker_threads'
import { verifyAssetBundle, verifyUnbundledGltfAsset, verifyUnbundledObjAsset } from './asset-bundle.js'
try {
  const bundle = verifyAssetBundle(workerData.root, workerData.asset, { verifyGraphBytes: true })
  if (!bundle) {
    verifyUnbundledGltfAsset(workerData.root, workerData.asset, { verifyGraphBytes: true })
    verifyUnbundledObjAsset(workerData.root, workerData.asset, { verifyGraphBytes: true })
  }
  parentPort.postMessage({ bundle })
} catch (error) {
  parentPort.postMessage({ error: { code: error.code ?? 'SNAPSHOT_ASSET_UNSUPPORTED', message: error.message } })
}
