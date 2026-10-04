/** Child process for the revision writer contract. No Blender process is started. */
import { Context } from '@deepseek-ai/cordis'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [workspaceRoot, projectId, mode, baseRevision = 'r0001', releasePath] = process.argv.slice(2)
const ctx = new Context()
ctx.provide('blenderRuntime', {
  async compileScene(request) {
    const spec = readFileSync(request.sceneSpecPath, 'utf8')
    await new Promise(resolve => {
      process.once('message', resolve)
      process.send({ type: 'compiling', sceneSpecPath: request.sceneSpecPath })
    })
    const directory = join(request.projectRoot, `test-compiler-${process.pid}`)
    mkdirSync(directory, { recursive: true })
    try {
      writeFileSync(join(directory, 'result.blend'), spec)
      request.onWorkingDirectory({ directory })
      return { report: { validation: { ok: true }, sceneFingerprint: { totalPolygons: 12 } }, envelope: {} }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  },
})
const studio = new BlenderStudio(ctx, StudioConfig({
  workspaceRoot, projectsRoot: join(workspaceRoot, 'projects'), reconcileOnStart: false,
}))
if (mode === 'asset-hold') {
  const withProjectWrite = studio.store.withProjectWrite.bind(studio.store)
  studio.store.withProjectWrite = (id, action) => withProjectWrite(id, () => {
    // Extend the real synchronous publication section so another Node process
    // deterministically attempts an import while the first owns the lease.
    process.send({ type: 'publishing' })
    const until = Date.now() + 5000
    const sleep = new Int32Array(new SharedArrayBuffer(4))
    while (!existsSync(releasePath)) {
      if (Date.now() > until) throw new Error('asset publication test barrier timed out')
      Atomics.wait(sleep, 0, 0, 10)
    }
    return action()
  })
}
try {
  const value = mode.startsWith('asset')
    ? await studio.ingestAsset({ ...JSON.parse(baseRevision), projectId })
    : mode === 'restore'
    ? await studio.restoreRevision({ projectId, revision: baseRevision })
    : await studio.applyScenePatch({ projectId, baseRevision,
      operations: [{ op: 'camera.update', cameraId: 'camera-main', lens: 55 }],
      saveCheckpoint: mode === 'hold',
    })
  process.send({ type: 'result', ok: true, revision: value.revision, path: value.path, sha256: value.sha256 })
} catch (cause) {
  process.send({ type: 'result', ok: false, code: cause.code, message: cause.message, detail: cause.detail })
}
process.disconnect()
