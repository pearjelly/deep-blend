/** Real shot cuts, byte-bound camera evidence and unchanged single-camera delivery. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import Provider from '../../../packages/deepblend/provider-local/lib/index.js'
import Studio from '../../../packages/deepblend/host/lib/index.js'
import { decodePng } from '@deepblend/dsh-blender-contracts'
import { importDsh } from '../lib/dsh-deployment.mjs'

const ROOT = resolve(import.meta.dirname, '../../..')
const out = resolve(process.env.DEEPBLEND_SHOT_RENDER_OUTPUT ?? join(ROOT, '.deepblend/quality', 'shot-render-' + Date.now()))
assert(!existsSync(out), 'Preserve existing native evidence')
mkdirSync(out, { recursive: true })
const blender = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const bootstrap = process.env.DEEPBLEND_SHOT_BOOTSTRAP ?? join(ROOT, 'packages/deepblend/provider-local/python/bootstrap.py')
const { LocalJobRegistry } = await importDsh('dsh-jobs-local')
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const read = path => JSON.parse(readFileSync(path))
const checks = []
function check(name, value) { checks.push({ name, ok: !!value }); console.log(`[${value ? 'PASS' : 'FAIL'}] ${name}`); assert(value, name) }
const profile = { engine: 'cycles', resolution: [96, 64], samples: 2, maxSamplesBudget: 512,
  colorManagement: { viewTransform: 'Standard', exposure: 0 }, filmTransparent: false }
const spec = {
  schemaVersion: 'deepblend.scene/v1',
  project: { id: 'native-shot-cuts', title: 'Native shot cuts', units: 'metric', fps: 24, frameStart: 1, frameEnd: 8,
    aspectRatio: '3:2', activeCamera: 'camera-a', reviewSubjectId: 'red-body' },
  assets: [], lights: [], world: { color: [0, 0, 0], strength: 0 },
  materials: [
    { id: 'red', shader: 'principled', parameters: { baseColor: [1, 0, 0, 1], emissionColor: [1, 0, 0, 1], emissionStrength: 1 } },
    { id: 'blue', shader: 'principled', parameters: { baseColor: [0, 0, 1, 1], emissionColor: [0, 0, 1, 1], emissionStrength: 1 } },
  ],
  entities: [
    { id: 'red-body', type: 'generator', generator: { shape: 'cube', size: 2 }, materialId: 'red', transform: { location: [0, 0, 0] }, tags: ['subject'] },
    { id: 'blue-body', type: 'generator', generator: { shape: 'cube', size: 2 }, materialId: 'blue', transform: { location: [10, 0, 0] } },
  ],
  cameras: [
    { id: 'camera-a', role: 'active-camera', lens: 50, transform: { location: [0, -6, 0] }, targetPoint: [0, 0, 0] },
    { id: 'camera-b', lens: 50, transform: { location: [10, -6, 0] }, targetPoint: [10, 0, 0] },
  ],
  // Deliberately use the second camera first, the opposite of the default route.
  shots: [
    { id: 'opening', cameraId: 'camera-b', frameRange: [1, 2] },
    { id: 'detail', cameraId: 'camera-a', frameRange: [3, 8] },
  ],
  animationTracks: [],
  renderProfiles: { preview: structuredClone(profile), final: structuredClone(profile) },
}

async function makeHost() {
  const ctx = new Context()
  ctx.plugin(Subprocess); ctx.plugin(LocalJobRegistry)
  ctx.plugin(Provider, { workspaceRoot: out, blenderPath: blender,
    bootstrapPath: bootstrap, timeoutMs: 120000 })
  ctx.plugin(Studio, { workspaceRoot: out, projectsRoot: join(out, 'projects'), maxFinalSamples: 512,
    ffmpegPath: process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg', ffprobePath: process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe',
    progressPollMs: 50, encodePreset: 'ultrafast' })
  for (let n = 0; n < 300 && !ctx.get('blenderStudio'); n++) await new Promise(r => setTimeout(r, 10))
  const studio = ctx.get('blenderStudio'); assert(studio, 'Host failed to activate')
  await studio.awaitReconciliation()
  return { ctx, studio }
}
async function finish(studio, projectId, jobId) {
  const deadline = Date.now() + 180000
  for (;;) {
    const { renderJob } = await studio.getJob({ projectId, jobId })
    if (['completed', 'failed', 'cancelled'].includes(renderJob.status)) return renderJob
    assert(Date.now() < deadline, 'Native shot job did not settle')
    await new Promise(r => setTimeout(r, 30))
  }
}
function colour(directory, frame) {
  const image = decodePng(readFileSync(join(directory, `frame_${String(frame).padStart(4, '0')}.png`)))
  const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4
  return [...image.data.slice(pixel, pixel + 3)]
}
const red = pixel => pixel[0] > 80 && pixel[0] > pixel[2] * 2
const blue = pixel => pixel[2] > 80 && pixel[2] > pixel[0] * 2
let host = await makeHost()
try {
  let { studio } = host
  const created = await studio.createProject({ title: 'Native shot cuts', sceneSpec: spec, saveCheckpoint: true })
  const projectId = created.projectId, revision = created.revision.revision
  const native = studio.store.checkpointPath(projectId, revision)
  const source = join(studio.store.revisionDirectory(projectId, revision), 'scene-spec.json')
  const before = { native: hash(native), spec: hash(source) }
  const legacy = await studio.startFinalRender({ projectId, revision, frameStart: 1, frameEnd: 4 })
  const legacyJob = await finish(studio, projectId, legacy.jobId)
  check('the old single-camera default still completes with saved shot metadata', legacyJob.status === 'completed')
  check('the legacy route keeps the chosen camera on both sides of a saved cut', red(colour(legacyJob.framesDirectory, 1)) && red(colour(legacyJob.framesDirectory, 4)))
  const oldFrames = [1, 2, 3, 4].map(frame => hash(join(legacyJob.framesDirectory, `frame_000${frame}.png`)))
  const outputVideo = join(studio.store.projectDirectory(projectId), 'output/final.mp4'), oldVideo = hash(outputVideo)
  const priorJobs = readdirSync(studio.renderJobs.rendersRoot(projectId))
  for (const request of [{ cameraId: 'camera-a' }, { frames: [1, 4] }]) {
    await assert.rejects(studio.startShotSequenceRender({ projectId, revision, ...request }), error => ['SCENE_SPEC_INVALID', 'RENDER_RANGE_INVALID'].includes(error.code))
  }
  await assert.rejects(studio.startFinalRender({ projectId, revision, frames: [1, 4] }), error => error.code === 'RENDER_RANGE_INVALID')
  check('conflicting or unencodable selections create no job and preserve the published video',
    JSON.stringify(readdirSync(studio.renderJobs.rendersRoot(projectId))) === JSON.stringify(priorJobs) && hash(outputVideo) === oldVideo)

  const started = await studio.startShotSequenceRender({ projectId, revision, frameStart: 1, frameEnd: 4 })
  const job = await finish(studio, projectId, started.jobId)
  check('explicit shot delivery renders and encodes through the real Host/runtime', job.status === 'completed')
  check('the first two native frames actually show the second camera’s blue subject', blue(colour(job.framesDirectory, 1)) && blue(colour(job.framesDirectory, 2)))
  check('the cut selects the red subject at frames three and four', red(colour(job.framesDirectory, 3)) && red(colour(job.framesDirectory, 4)))
  const record = studio.renderJobs.read(projectId, started.jobId), directory = studio.renderJobs.jobDirectory(projectId, started.jobId)
  check('the request uses a distinct action so an older bootstrap cannot silently ignore the selection', read(join(directory, 'request.json')).action === 'render_shot_frames')
  check('actual camera evidence is complete and bound to each saved PNG', job.provenance.coverage === 'complete' &&
    job.provenance.frames.map(f => f.cameraId).join(',') === 'camera-b,camera-b,camera-a,camera-a' &&
    job.provenance.frames.every(f => f.sha256 === hash(join(job.framesDirectory, `frame_000${f.frame}.png`))))
  const manifest = read(join(directory, 'manifest.json'))
  check('the film receipt describes the sequence rather than claiming one camera rendered it all', record.cameraId === null &&
    manifest.render.cameraId === null && manifest.render.cameraSelection.mode === 'shots' && manifest.frames.rendered === 4 && manifest.video.probed.frameCount === 4)
  check('legacy completed frame bytes and saved native/spec remain unchanged', oldFrames.every((digest, n) => digest === hash(join(legacyJob.framesDirectory, `frame_000${n + 1}.png`))) && hash(native) === before.native && hash(source) === before.spec)
  writeFileSync(join(out, 'initial-receipts.json'), JSON.stringify({ projectId, revision, before, legacy: legacyJob, sequence: job }, null, 2))

  // A real cancelled renderer, then a fresh Host: frozen selection and journal
  // evidence must survive without relying on the original in-memory instance.
  const resumeSpec = structuredClone(spec)
  resumeSpec.project.id = 'native-shot-resume'
  resumeSpec.renderProfiles.final = { ...structuredClone(profile), resolution: [768, 512], samples: 256 }
  const resumedProject = await studio.createProject({ title: 'Native shot resume', sceneSpec: resumeSpec, saveCheckpoint: true })
  const resumeId = resumedProject.projectId, resumeRevision = resumedProject.revision.revision
  const resumeNative = studio.store.checkpointPath(resumeId, resumeRevision), originalNative = hash(resumeNative)
  const interrupted = await studio.startShotSequenceRender({ projectId: resumeId, revision: resumeRevision })
  const interruptDirectory = studio.renderJobs.jobDirectory(resumeId, interrupted.jobId)
  const journal = join(interruptDirectory, 'events.jsonl'), deadline = Date.now() + 180000
  for (;;) {
    const text = existsSync(journal) ? readFileSync(journal, 'utf8') : ''
    if (text.split('\n').some(line => { try { const event = JSON.parse(line); return event.type === 'frame' && event.frame === 1 } catch { return false } })) break
    assert(Date.now() < deadline, 'No durable first shot frame before cancellation')
    await new Promise(r => setTimeout(r, 5))
  }
  const pid = (await studio.getJob({ projectId: resumeId, jobId: interrupted.jobId })).renderJob.pid
  const cancelled = await studio.cancelJob({ projectId: resumeId, jobId: interrupted.jobId, reason: 'native shot resume acceptance' })
  check('the explicit shot process is cancelled and measured gone', cancelled.cancelled === true && cancelled.processGone === true)
  let gone = false; try { process.kill(pid, 0) } catch (error) { gone = error.code === 'ESRCH' }
  check('the shot renderer is independently absent after cancellation', gone)
  const partial = (await studio.getJob({ projectId: resumeId, jobId: interrupted.jobId })).renderJob
  const known = partial.provenance.frames.map(binding => ({ ...binding }))
  check('cancellation leaves a genuine camera-verified prefix and an unfinished suffix', known.length > 0 && known.length < 8 && !known.some(binding => binding.frame === 8))
  const held = new Map(known.map(binding => [binding.frame, hash(join(partial.framesDirectory, `frame_${String(binding.frame).padStart(4, '0')}.png`))]))
  // A complete PNG without a camera completion event must not be skipped. Its
  // blue pixels are deliberately wrong for the last (red) shot.
  copyFileSync(join(partial.framesDirectory, 'frame_0001.png'), join(partial.framesDirectory, 'frame_0008.png'))
  const unverifiedDigest = hash(join(partial.framesDirectory, 'frame_0008.png'))
  const changed = await studio.applyScenePatch({ projectId: resumeId, baseRevision: resumeRevision,
    note: 'New current storyboard must not change an interrupted render', stage: 'VISUAL_REVIEW', saveCheckpoint: false,
    operations: [
      { op: 'shot.set', shot: { ...resumeSpec.shots[0], cameraId: 'camera-a' } },
      { op: 'shot.set', shot: { ...resumeSpec.shots[1], cameraId: 'camera-b' } },
    ] })
  check('a different current storyboard is saved while the original native remains intact', changed.revision !== resumeRevision && hash(resumeNative) === originalNative)
  await host.ctx.fiber.dispose()
  host = await makeHost(); studio = host.studio
  const resumed = await studio.resumeRenderJob({ projectId: resumeId, jobId: interrupted.jobId, samples: 2 })
  check('a fresh Host resumes missing or camera-unverified frames, not the known prefix', resumed.alreadyComplete === known.length &&
    resumed.resumedFrames.includes(8) && known.every(binding => !resumed.resumedFrames.includes(binding.frame)))
  const final = await finish(studio, resumeId, interrupted.jobId)
  check('resumed shot delivery completes with actual per-frame camera provenance', final.status === 'completed' && final.provenance.coverage === 'complete' &&
    final.provenance.frames.map(binding => binding.cameraId).join(',') === 'camera-b,camera-b,camera-a,camera-a,camera-a,camera-a,camera-a,camera-a')
  check('resume preserves every known PNG byte and the frozen old checkpoint', [...held].every(([frame, digest]) => hash(join(final.framesDirectory, `frame_${String(frame).padStart(4, '0')}.png`)) === digest) && hash(resumeNative) === originalNative)
  check('the unverified complete PNG is replaced with the correct saved-shot pixels', red(colour(final.framesDirectory, 8)))
  const retained = join(interruptDirectory, 'retained')
  const retainedPaths = existsSync(retained) ? readdirSync(retained, { recursive: true }).filter(name => name.endsWith('frame_0008.png')) : []
  check('the replaced unverified PNG is retained as raw evidence', retainedPaths.some(name => hash(join(retained, name)) === unverifiedDigest))
  const resumedManifest = read(join(interruptDirectory, 'manifest.json'))
  check('the final receipt uses the original revision/selection and reports the explicit mixed sample budgets', resumedManifest.revisionId === resumeRevision &&
    resumedManifest.render.cameraSelection.shots[0].cameraId === 'camera-b' && resumedManifest.render.provenance.configuration === 'mixed')
  writeFileSync(join(out, 'resume-receipts.json'), JSON.stringify({ resumeId, resumeRevision, changedRevision: changed.revision,
    originalNative, known, unverifiedDigest, resumed, final, retainedPaths }, null, 2))
} finally {
  await host.ctx.fiber.dispose()
  writeFileSync(join(out, 'checks.json'), JSON.stringify({ checks, scope: 'Actual tiny native camera/pixel and MP4 selection acceptance; no case artwork or long-film quality certification.' }, null, 2))
}
console.log(`Native shot rendering: ${checks.filter(c => c.ok).length}/${checks.length} check(s) passed`)
