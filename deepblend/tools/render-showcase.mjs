#!/usr/bin/env node
/** Render the showcase with the installed DeepBlend public Host/Provider API. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const command = args[0] ?? 'preview'
const caseIds = value('--case', 'all') === 'all' ? ['amber-atlas', 'solstice', 'nocturne'] : [value('--case')]
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const deployment = value('--deployment', join(dshHome, 'profiles/desktop'))
const require = createRequire(join(deployment, 'node_modules/@deepblend/dsh-blender-bundle/package.json'))
const imported = async name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await imported('@deepseek-ai/cordis')
const { default: LocalSubprocess } = await imported('@deepseek-ai/dsh-subprocess-local')
const { default: Provider } = await imported('@deepblend/dsh-blender-provider-local')
const { default: Studio } = await imported('@deepblend/dsh-blender-host')
const { validateSceneSpec, canonicalStringify, decodePng } = await imported('@deepblend/dsh-blender-contracts')
const hash = value => createHash('sha256').update(value).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const work = value('--store', join(dshHome, 'deepblend'))
const output = value('--output', join(ROOT, 'deepblend/docs/assets/showcase'))
const evidence = join(ROOT, '.deepblend/showcase-run')
const defaultBlender = process.platform === 'darwin' && process.arch === 'arm64'
  ? join(ROOT, 'deepblend/tools/blender-metal-launcher.mjs')
  : join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const blender = value('--blender', defaultBlender)
mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
const ctx = new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin(Provider, { blenderPath: blender, workspaceRoot: work, timeoutMs: 600000 })
ctx.plugin(Studio, { workspaceRoot: work, projectsRoot: join(work, 'projects'), maxPreviewSamples: 512,
  maxFinalSamples: 512, ffmpegPath: process.env.DEEPBLEND_FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg',
  ffprobePath: process.env.DEEPBLEND_FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe',
  encodeCrf: 16, encodePreset: 'slow', reconcileOnStart: false, progressPollMs: 1000 })
await new Promise(resolve => setTimeout(resolve, 150))
const studio = ctx.get('blenderStudio')
if (!studio) throw new Error('Installed DeepBlend Host did not activate')
const installed = json(join(deployment, 'node_modules/@deepblend/dsh-blender-bundle/package.json')).version
console.log(`Installed DeepBlend ${installed}; ${command}; store ${work}`)
function record(id, kind, data) {
  const dir = join(evidence, id); mkdirSync(dir, { recursive: true });
  save(join(dir, `${kind}.json`), { at: new Date().toISOString(), pluginVersion: installed, ...data })
}
function copyArtifacts(id, tag, result, projectId) {
  const facts = []
  for (const artifact of result.artifacts ?? []) {
    if (!['view', 'diagnostic', 'preview'].includes(artifact.kind)) continue
    const source = join(work, 'projects', projectId, artifact.path)
    const filename = tag === 'still' ? `${id}-${artifact.cameraId === 'detail' ? 'detail' : 'hero'}.png` : `${id}-${tag}-${artifact.viewId ?? artifact.cameraId ?? 'hero'}.png`
    const path = join(output, filename); copyFileSync(source, path)
    const bytes = readFileSync(path), decoded = decodePng(bytes)
    facts.push({ filename, width: decoded.width, height: decoded.height, sha256: hash(bytes), pixelSha256: hash(Buffer.from(decoded.data)), bytes: bytes.length, source: artifact })
  }
  record(id, `${tag}-${facts[0]?.source.cameraId ?? 'hero'}-artifacts`, { facts }); console.log(JSON.stringify({ id, tag, files: facts.map(x => x.filename), durationMs: result.job?.durationMs }))
}
try {
  if (command === 'capabilities') {
    const capabilities = await studio.getCapabilities(); save(join(evidence, 'capabilities.json'), capabilities)
    console.log(JSON.stringify(capabilities));
  } else for (const id of caseIds) {
    const sourcePath = join(ROOT, 'deepblend/showcase', id, 'scene-spec.json')
    if (!existsSync(sourcePath)) throw new Error(`Unknown showcase case ${id}`)
    const spec = json(sourcePath), checked = validateSceneSpec(spec)
    if (!checked.ok) throw new Error(`${id}: ${checked.summary}`)
    const projectId = spec.project.id
    if (command === 'check') { console.log(`${id}: valid ${spec.entities.length} entities, ${spec.animationTracks.length} motion tracks`); continue }
    if (command === 'create') {
      try {
        const result = await studio.createProject({ projectId, title: spec.project.title, goal: spec.project.goal,
          sceneSpec: spec, renderPreview: false, actor: 'showcase-author' })
        record(id, 'create', { sourceSpecSha256: hash(canonicalStringify(spec)), result }); console.log(JSON.stringify({ id, projectId, revision: result.revision }))
      } catch (error) { if (error.code !== 'PROJECT_EXISTS') throw error; console.log(`${projectId} already exists`) }
      continue
    }
    const scene = await studio.getScene(projectId, { full: true })
    if (command === 'patch') {
      const operations = json(value('--operations'))
      const result = await studio.applyScenePatch({ projectId, baseRevision: scene.revision,
        operations, note: value('--note', 'Refine showcase lighting, composition and surface finish after real preview inspection.'), actor: 'showcase-author', stage: 'VISUAL_REVIEW', renderPreview: false })
      record(id, `patch-${result.revision}`, { operations, result })
      const updated = await studio.getScene(projectId, { full: true }); save(sourcePath, updated.spec)
      console.log(JSON.stringify({id,revision:result.revision,kind:result.kind})); continue
    }
    if (['preview', 'still', 'clay'].includes(command)) {
      const still = command === 'still', mode = command === 'clay' ? 'clay' : undefined
      const frameList = value('--frames', still ? '72' : '1,72,144').split(',').map(Number)
      const cameraId = value('--camera', 'hero')
      const views = frameList.map(frame => ({ id: `${cameraId}-f${String(frame).padStart(3, '0')}`, cameraId, frame }))
      const result = await studio.renderViews({ projectId, revision: scene.revision, views, ...(mode ? { mode } : {}),
        engine: value('--engine', 'cycles'), width: Number(value('--width', still ? '2560' : '960')), height: Number(value('--height', still ? '1440' : '540')),
        samples: Number(value('--samples', still ? '256' : '64')) })
      copyArtifacts(id, command, result, projectId); record(id, command, { result: { ...result, pngs: undefined } }); continue
    }
    if (command === 'cancel') { const result = await studio.cancelJob({ projectId, jobId: value('--job') }); console.log(JSON.stringify(result)); continue }
    if (command === 'film' || command === 'resume') {
      const result = command === 'resume'
        ? await studio.resumeRenderJob({ projectId, jobId: value('--job') })
        : await studio.startFinalRender({ projectId, revision: scene.revision, profileName: 'final' })
      record(id, 'film-start', { result }); console.log(JSON.stringify({ id, ...result }))
      let last = -1
      while (true) {
        const status = await studio.getJob({ projectId, jobId: result.jobId })
        const r = status.renderJob
        if (r?.completedFrames !== last) { last = r?.completedFrames; console.log(JSON.stringify({ id, status: status.status, completed: r?.completedFrames, expected: r?.expectedFrames, meanMsPerFrame: r?.meanMsPerFrame, estimatedRemainingMs:r?.estimatedRemainingMs })) }
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) {
          record(id, 'film-status', { status })
          if (status.status !== 'completed') throw new Error(`Film ${id}: ${status.status} ${status.message}`)
          break
        }
        await new Promise(resolve => setTimeout(resolve, 10000))
      }
      const exported = await studio.exportProject({ projectId, jobId: result.jobId })
      if (!exported.verified) throw new Error(`Delivery verification failed: ${JSON.stringify(exported.problems)}`)
      let path = exported.video.path
      if (!path.startsWith('/')) path = join(work, 'projects', projectId, path)
      const filename = `${id}.mp4`; copyFileSync(path, join(output, filename))
      record(id, 'delivery', { exported, filename, sha256: hash(readFileSync(join(output, filename))) })
      console.log(JSON.stringify({ id, filename, video: exported.video, verified: exported.verified })); continue
    }
    throw new Error(`Unknown command ${command}`)
  }
} finally { await ctx.stop?.() }
