/** Independent Host process; controlled renderer unless a Blender path is supplied.
 * Barriers extend legal allocation/read windows without replacing their implementation. */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { createImage, encodePng } from '@deepblend/dsh-blender-contracts'
import { join } from 'node:path'

const [root, id, mode, widthText, release, camera = 'camera-main', frame = '1', kind = 'preview', native = ''] = process.argv.slice(2)
const width = Number(widthText), fibers = [], ctx = new Context()
function wait() {
  const end = Date.now() + 10_000, word = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(release)) {
    if (Date.now() > end) throw new Error('test barrier timed out')
    Atomics.wait(word, 0, 0, 10)
  }
}
let publishing = false, held = false
const read = fs.readFileSync
fs.readFileSync = function (path, ...args) {
  const bytes = read.call(this, path, ...args)
  if (publishing && !held && String(path).endsWith('revision-manifest.json')) {
    held = true; process.send({ type: 'manifest-read', pid: process.pid })
    if (mode === 'manifest-hold') wait()
  }
  return bytes
}
syncBuiltinESMExports()
if (native) {
  const { default: Subprocess } = await import('@deepseek-ai/dsh-subprocess-local')
  const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
  fibers.push(ctx.plugin(Subprocess), ctx.plugin(Provider, ProviderConfig({ blenderPath: native, workspaceRoot: root, timeoutMs: 120_000 })))
} else ctx.provide('blenderRuntime', {
  async resolveEngineKey() { return { blenderEngine: 'CYCLES', warning: null } },
  async renderPreview(r) {
    fs.mkdirSync(join(r.outputPath, '..'), { recursive: true })
    fs.writeFileSync(r.outputPath, encodePng(createImage(width, 16, [width, 80, 30, 255])))
    return { envelope: {}, report: { cameraId: r.cameraId, frame: r.frame, width, height: 16, engine: 'CYCLES',
      renderConfig: { resolution: [width, 16], samples: 4, engine: 'CYCLES' } } }
  },
  async renderViews() {
    const png = encodePng(createImage(width, 16, [width, 80, 30, 255]))
    return { envelope: {}, durationMs: 1, pngs: { hero: png }, report: { views: [{ viewId: 'hero', role: 'hero', cameraId: camera,
      frame: Number(frame), outputPath: '/controlled/hero.png', width, height: 16, engine: 'CYCLES' }] } }
  },
})
for (let i = 0; !ctx.get('blenderRuntime') && i < 500; i++) await new Promise(resolve => setTimeout(resolve, 10))
const runtime = ctx.get('blenderRuntime')
if (!runtime) throw new Error('child runtime did not activate')
for (const name of ['renderPreview', 'renderViews']) {
  const render = runtime[name].bind(runtime)
  runtime[name] = async r => {
    const result = await render(r); publishing = true
    process.send({ type: 'rendered', pid: process.pid }); return result
  }
}
const studio = new Studio(ctx, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false }))
if (mode === 'allocation') {
  const allocate = studio.store.allocateJobId.bind(studio.store)
  studio.store.allocateJobId = (...args) => {
    const jobId = allocate(...args); process.send({ type: 'allocated', jobId, pid: process.pid }); wait(); return jobId
  }
}
await new Promise(resolve => { process.once('message', resolve); process.send({ type: 'ready', pid: process.pid }) })
try {
  const request = { projectId: id, revision: 'r0001', cameraId: camera, frame: Number(frame), width, height: 16, samples: 4 }
  const value = await (kind === 'views' ? studio.renderViews({ ...request, views: [{ id: 'hero', role: 'hero', cameraId: camera, frame: Number(frame) }] }) : studio.renderPreview(request))
  process.send({ type: 'result', ok: true, job: value.job, artifacts: value.artifacts, pid: process.pid })
} catch (cause) { process.send({ type: 'result', ok: false, code: cause.code, message: cause.message, pid: process.pid }) }
finally {
  fs.readFileSync = read; syncBuiltinESMExports()
  for (const fiber of fibers.reverse()) await fiber.dispose()
  process.disconnect()
}
