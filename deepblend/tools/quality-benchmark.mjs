#!/usr/bin/env node
/** Rebuild authored quality cases through the public contracts and local provider. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider from '@deepblend/dsh-blender-provider-local'
import { compileSceneSpec, validateSceneSpec, canonicalStringify, decodePng } from '@deepblend/dsh-blender-contracts'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyBenchmark } from './verify-quality-benchmark.mjs'

export const ROOT = resolve(import.meta.dirname, '../..')
export const BENCHMARK_ROOT = join(ROOT, 'deepblend/benchmarks')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
function sourceSnapshot() {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(js|mjs|json|py|md)$/.test(entry.name)) files.push({ path: relative(ROOT, path), sha256: hash(readFileSync(path)) })
    }
  }
  walk(join(ROOT, 'packages/deepblend'))
  walk(BENCHMARK_ROOT)
  for (const filename of ['package.json', 'package-lock.json']) {
    const path = join(ROOT, 'deepblend/development/runtime', filename)
    if (existsSync(path)) files.push({ path: relative(ROOT, path), sha256: hash(readFileSync(path)) })
  }
  for (const path of [join(ROOT, 'deepblend/tools/quality-benchmark.mjs'), join(ROOT, 'deepblend/tools/inspect-benchmark.py'), join(ROOT, 'deepblend/tools/blender-release.json'), join(ROOT, 'deepblend/tools/verify-quality-benchmark.mjs')]) files.push({ path: relative(ROOT, path), sha256: hash(readFileSync(path)) })
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
const same = (a, b) => canonicalStringify(a) === canonicalStringify(b)
const html = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export function loadCase(id, manifest = json(join(BENCHMARK_ROOT, 'manifest.json'))) {
  const entry = manifest.cases.find(item => item.id === id)
  if (!entry || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Unknown benchmark case: ${id}`)
  const directory = join(BENCHMARK_ROOT, id)
  const candidate = json(join(directory, 'scene-spec.json'))
  const baseline = json(join(directory, 'baseline-scene-spec.json'))
  const brief = readFileSync(join(directory, 'brief.md'), 'utf8')
  const geometryChecks = json(join(directory, 'geometry-checks.json'))
  validateCase({ entry, candidate, baseline, brief, geometryChecks }, manifest)
  return { entry, directory, candidate, baseline, brief, geometryChecks }
}

export function viewsForCase(entry, manifest) {
  return manifest.views.map(view => entry.motionCameraId && view.id.startsWith('motion-')
    ? { ...view, cameraId: entry.motionCameraId } : view)
}

export function validateCase({ entry, candidate, baseline, brief, geometryChecks }, manifest) {
  const id = entry.id
  if (brief.trim().length < 200) throw new Error(`${id}: a concrete design brief is required`)
  for (const [variant, spec] of Object.entries({ candidate, baseline })) {
    const checked = validateSceneSpec(spec)
    if (!checked.ok) throw new Error(`${id}/${variant}: ${checked.summary}`)
    if (spec.project.frameStart !== 1 || spec.project.frameEnd !== 48) throw new Error(`${id}: frame range must be 1..48`)
    if (spec.project.fps !== manifest.motion.fps) throw new Error(`${id}: use the fixed ${manifest.motion.fps} fps budget`)
    for (const view of viewsForCase(entry, manifest)) if (!spec.cameras.some(camera => camera.id === view.cameraId)) throw new Error(`${id}: missing camera ${view.cameraId}`)
    if (!spec.animationTracks?.some(track => track.keyframes.some(frame => frame.value !== track.keyframes[0].value))) throw new Error(`${id}: an actual animation is required`)
    if (spec.renderProfiles.preview.colorManagement?.viewTransform !== 'AgX' ||
        !same(spec.renderProfiles.preview.colorManagement, spec.renderProfiles.final.colorManagement)) throw new Error(`${id}: preview and final color management must match AgX`)
    for (const profileName of ['preview', 'final']) {
      const tier = manifest.tiers[profileName === 'preview' ? 'review' : 'final']
      const profile = spec.renderProfiles[profileName]
      if (profile.engine !== 'cycles' || !same(profile.resolution, tier.resolution) || profile.samples !== tier.samples) throw new Error(`${id}: ${profileName} differs from the fixed budget`)
    }
  }
  // The control removes authored detail, not camera or exposure disadvantages.
  for (const field of ['cameras', 'lights', 'world', 'renderProfiles', 'shots', 'animationTracks']) {
    if (!same(candidate[field] ?? null, baseline[field] ?? null)) throw new Error(`${id}: baseline ${field} differs from candidate`)
  }
  if (same(candidate.entities, baseline.entities) && same(candidate.materials, baseline.materials)) throw new Error(`${id}: baseline is identical`)
  if (candidate.assets?.length || baseline.assets?.length) throw new Error(`${id}: this original procedural baseline must be self-contained`)
  const baselineById = new Map(baseline.entities.map(entity => [entity.id, entity]))
  for (const entity of candidate.entities) {
    const control = baselineById.get(entity.id)
    if (control && !same(entity.transform ?? null, control.transform ?? null)) throw new Error(`${id}: baseline transform differs for ${entity.id}`)
  }
  if (!Number.isSafeInteger(entry.maxPolygons) || entry.maxPolygons <= 0) throw new Error(`${id}: invalid polygon budget`)
  if (!geometryChecks?.closedEntities?.length || !geometryChecks?.dimensions?.length) throw new Error(`${id}: closed geometry and dimension checks are required`)
  const entities = new Set(candidate.entities.map(entity => entity.id))
  for (const entityId of geometryChecks.closedEntities) if (!entities.has(entityId)) throw new Error(`${id}: unknown geometry check entity ${entityId}`)
  for (const [kind, checks] of [['dimensions', geometryChecks.dimensions], ['volumes', geometryChecks.volumes ?? []]]) {
    for (const check of checks) {
      if (!entities.has(check.entityId)) throw new Error(`${id}: unknown geometry check entity ${check.entityId}`)
      if (kind === 'dimensions' && ![0, 1, 2].includes(check.axis)) throw new Error(`${id}: invalid dimension axis`)
      if (!Number.isFinite(check.min) || !Number.isFinite(check.max) || check.min <= 0 || check.max < check.min) throw new Error(`${id}: invalid geometry check range`)
    }
  }
  return true
}

export function validateGeometry(geometry, checks, id = 'benchmark') {
  const select = entityId => {
    const objects = geometry.objects.filter(object => object.entityId === entityId)
    if (objects.length !== 1) throw new Error(`${id}: geometry check requires one mesh for ${entityId}`)
    return objects[0]
  }
  for (const entityId of checks.closedEntities) {
    const mesh = select(entityId)
    if (mesh.boundaryEdges !== 0 || mesh.nonManifoldEdges !== 0 || !Number.isFinite(mesh.signedVolume) || mesh.signedVolume <= 0) {
      throw new Error(`${id}/${entityId}: expected closed positive-volume geometry`)
    }
  }
  for (const [kind, list] of [['dimensions', checks.dimensions], ['volumes', checks.volumes ?? []]]) {
    for (const check of list) {
      const mesh = select(check.entityId)
      const measured = kind === 'dimensions' ? mesh.dimensions?.[check.axis] : mesh.signedVolume
      if (!Number.isFinite(measured) || measured < check.min || measured > check.max) throw new Error(`${id}/${check.entityId}: ${kind} = ${measured}, expected ${check.min}..${check.max}`)
    }
  }
  return true
}

export function hasEvaluatedMotion(poses) {
  return Array.isArray(poses) && poses.length > 1 && poses.slice(1).some(pose => !same(poses[0].objects, pose.objects))
}

export function hasRenderedMotion(frames) {
  return Array.isArray(frames) && frames.length > 1 && frames.every(frame => typeof frame.pixelSha256 === 'string' && /^[a-f0-9]{64}$/.test(frame.pixelSha256)) && frames.slice(1).some(frame => frame.pixelSha256 !== frames[0].pixelSha256)
}

function claySpec(spec) {
  const clay = structuredClone(spec)
  clay.materials.push({ id: 'benchmark-clay', shader: 'principled', parameters: { baseColor: [.35, .35, .35, 1], roughness: .62 } })
  for (const entity of clay.entities) if (entity.type !== 'empty' && !entity.tags?.includes('environment')) {
    entity.materialId = 'benchmark-clay'
    delete entity.materialBindings
  }
  return clay
}

function pngFacts(bytes) {
  const image = decodePng(bytes)
  let luminance = 0, square = 0
  for (let index = 0; index < image.data.length; index += 4) {
    const value = (.2126 * image.data[index] + .7152 * image.data[index + 1] + .0722 * image.data[index + 2]) / 255
    luminance += value; square += value * value
  }
  const count = image.width * image.height
  return { width: image.width, height: image.height, bytes: bytes.length, sha256: hash(bytes),
    pixelSha256: hash(Buffer.from(image.data)), meanLuminance: luminance / count, luminanceStdDev: Math.sqrt(Math.max(0, square / count - (luminance / count) ** 2)) }
}

function execute(executable, args, cwd, timeoutMs, signal) {
  return new Promise((done, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('Cancelled')); return }
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-16000) })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('exit', code => {
      cleanup()
      if (signal?.aborted) reject(signal.reason ?? new Error('Cancelled'))
      else if (code !== 0 || timedOut) reject(new Error(`${executable} ${timedOut ? 'timed out' : `exited ${code}`}\n${output}`))
      else done(output)
    })
  })
}

export function writeGallery(output, report) {
  const statusLabel = value => ({ 'technical-pass': '渲染检查通过', 'technical-pass-review-required': '渲染检查通过 · 等待画面评审', 'technical-artifact-pass-review-required': '产物核验通过 · 等待画面评审', 'partial-run-review-required': '局部预览 · 等待画面评审', running: '正在渲染', failed: '检查失败', cancelled: '已取消' })[value] ?? value
  const sections = report.cases.map(entry => {
    const candidate = entry.variants?.candidate, baseline = entry.variants?.baseline, clay = entry.variants?.clay
    const figure = (variant, name, label) => variant?.images?.[name]
      ? `<figure><a href="${html(variant.images[name].path)}" target="_blank"><img loading="lazy" src="${html(variant.images[name].path)}" alt="${html(entry.title + ' ' + label)}"></a><figcaption>${html(label)} · ${variant.images[name].width}×${variant.images[name].height}，点击原图</figcaption></figure>` : ''
    const compare = (name, label) => candidate?.images?.[name] && baseline?.images?.[name]
      ? `<figure><div class="comparison"><img src="${html(candidate.images[name].path)}" alt="${html(label)}：成品候选"><div class="baseline"><img src="${html(baseline.images[name].path)}" alt="${html(label)}：简化消融对照"></div><div class="labels"><span>简化消融对照</span><span>成品候选</span></div><input aria-label="${html(label)}对照分界" type="range" min="0" max="100" value="50"></div><figcaption>${html(label)} · ${candidate.images[name].width}×${candidate.images[name].height} · 原图：<a target="_blank" href="${html(candidate.images[name].path)}">候选</a> / <a target="_blank" href="${html(baseline.images[name].path)}">对照</a></figcaption></figure>`
      : figure(candidate, name, label)
    return `<section><div class="heading"><p class="eyebrow">${html(entry.category)}</p><h2>${html(entry.title)}</h2><p>${html(statusLabel(entry.status))} · 画面评审：待审阅 · ${(entry.durationMs / 1000).toFixed(1)} 秒</p></div>
    ${entry.error ? `<pre>${html(entry.error)}</pre>` : ''}
    ${compare('hero', '主视角')}
    <div class="grid">${compare('detail', '细节近景')}${compare('reverse', '背面 / 另一角度')}</div>
    <div class="grid">${figure(clay, 'hero', '灰模：轮廓与结构')}${figure(clay, 'detail', '灰模：细节')}</div>
    <div class="grid">${figure(candidate, 'motion-mid', '动画中间帧')}${figure(candidate, 'motion-end', '动画末帧')}</div>
    ${entry.motion?.path ? `<video controls loop muted playsinline preload="metadata" src="${html(entry.motion.path)}"></video><p class="caption">实际 ${entry.motion.frameCount} 帧 · ${entry.motion.width}×${entry.motion.height} · ${entry.motion.fps} fps；运动检查采用较低分辨率。</p>` : ''}
    <details><summary>固定设计目标与审阅标准</summary><pre>${html(entry.brief ?? '')}</pre></details>
    <p class="links">候选 ${candidate?.polygons ?? '—'} 面 · <a href="${html(entry.evidenceRoot ?? entry.id)}/candidate/scene-spec.json">SceneSpec</a> · <a href="${html(entry.evidenceRoot ?? entry.id)}/candidate/scene.blend">Blender 检查点</a> · <a href="${html(entry.evidenceRoot ?? entry.id)}/candidate/geometry.json">实测几何</a> · <a href="${html(entry.evidenceRoot ?? entry.id)}/result.json">运行记录</a>${entry.sourceRun ? ` · 来源：<a href="${html(entry.sourceRun)}">${html(entry.sourceLabel ?? '独立批次')}</a>` : ''}${entry.artifactVerification ? ` · <a href="${html(entry.artifactVerification)}">独立审计</a>` : ''}</p></section>`
  }).join('')
  writeFileSync(join(output, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepBlend · 作品质量基准</title><style>
  :root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;color:#ecebe7;background:#141615}*{box-sizing:border-box}body{margin:0}main{max-width:1160px;margin:auto;padding:48px 24px 80px}h1{font-size:clamp(32px,5vw,60px);letter-spacing:-.045em;margin:.2em 0}h2{font-size:30px;letter-spacing:-.02em;margin:.2em 0}p{line-height:1.7;color:#aaaFA9}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:12px;color:#c1ceab}header{max-width:850px;margin-bottom:48px}section{border-top:1px solid #373c37;padding:36px 0}.heading{margin-bottom:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:16px 0}img{display:block;width:100%;border-radius:6px}figcaption,.caption{font-size:13px;color:#a6afa6;padding-top:8px}.comparison{position:relative;border-radius:6px;overflow:hidden}.comparison img{border-radius:0}.baseline{position:absolute;inset:0;clip-path:inset(0 50% 0 0)}.labels{position:absolute;top:14px;left:14px;right:14px;display:flex;justify-content:space-between}.labels span{background:#131713b8;border-radius:4px;padding:6px 10px;font-size:12px}.comparison input{position:absolute;bottom:12px;width:90%;left:5%;accent-color:#c1ceab}video{display:block;width:100%;max-height:600px;background:#090909;border-radius:6px;margin-top:20px}a{color:#c9d6b4}summary{cursor:pointer;padding:15px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;color:#b8bfb6;background:#1c201c;border-radius:6px;padding:20px;font:14px/1.7 system-ui}.badge{display:inline-block;border:1px solid #4e5c45;border-radius:20px;padding:5px 12px;color:#c1ceab;font-size:12px}footer{border-top:1px solid #373c37;padding-top:20px;font-size:13px}@media(max-width:680px){main{padding:28px 16px}.grid{grid-template-columns:1fr}}
  </style><main><header><p class="eyebrow">DEEPBLEND / QUALITY BENCHMARKS</p><h1>让精细度可以被审阅。</h1><p>固定场景、机位、曝光与预算，检查几何、材质和灯光。滑动对照图查看细节贡献，使用灰模与动画检查结构。</p><span class="badge">${html(report.tier)} · ${html(statusLabel(report.status))}</span><p>对照图是明确制作的简化消融，不代表历史插件表现。所有作品来自公开 SceneSpec；技术通过不自动代表美术通过。</p>${report.provenanceNote ? `<p>${html(report.provenanceNote)}</p>` : ''}</header>${sections}<footer><a href="run.json">输入摘要、设备、耗时与产物清单</a> · 原创设计，MIT · 重建流程模型调用：0（不含前期创作）</footer></main><script>for(const range of document.querySelectorAll('.comparison input'))range.addEventListener('input',()=>range.parentElement.querySelector('.baseline').style.clipPath='inset(0 '+(100-range.value)+'% 0 0)')</script></html>`)
}

export function benchmarkRuntimePaths(output) {
  const root = join(output, 'source-snapshot')
  const paths = { bootstrapPath: join(root, 'packages/deepblend/provider-local/python/bootstrap.py'),
    inspectorPath: join(root, 'deepblend/tools/inspect-benchmark.py') }
  for (const path of Object.values(paths)) if (!existsSync(path)) throw new Error(`Captured runtime source is missing: ${path}`)
  return paths
}

export async function renderCase(loaded, manifest, tierName, output, options = {}) {
  const { entry, candidate, baseline, brief } = loaded
  const captured = benchmarkRuntimePaths(output)
  const tier = manifest.tiers[tierName]
  const directory = join(output, entry.id)
  mkdirSync(directory, { recursive: true })
  const began = Date.now()
  const result = { ...entry, status: 'running', brief, artisticStatus: 'review-required', modelCalls: 0, variants: {},
    inputs: { candidate: hash(canonicalStringify(candidate)), baseline: hash(canonicalStringify(baseline)), brief: hash(brief), geometryChecks: hash(canonicalStringify(loaded.geometryChecks)) },
    budget: tier, startedAt: new Date().toISOString() }
  const persist = () => { result.durationMs = Date.now() - began; save(join(directory, 'result.json'), result) }
  const ctx = new Context()
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('case budget exceeded')), tier.maxCaseSeconds * 1000)
  let sequence = null
  const abort = () => { controller.abort(options.signal?.reason ?? new Error('Cancelled')); sequence?.handle.terminate() }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  ctx.plugin(LocalSubprocess)
  ctx.plugin(Provider, { blenderPath: process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender'),
    bootstrapPath: captured.bootstrapPath, workspaceRoot: output,
    timeoutMs: Math.min(600000, tier.maxCaseSeconds * 1000) })
  try {
    controller.signal.throwIfAborted()
    await new Promise(resolve => setTimeout(resolve, 100))
    const runtime = ctx.get('blenderRuntime')
    if (!runtime) throw new Error('The local Blender provider did not activate')
    const variants = { candidate, ...(tier.baseline ? { baseline } : {}), ...(tier.clay ? { clay: claySpec(candidate) } : {}) }
    for (const [name, source] of Object.entries(variants)) {
      if (controller.signal.aborted) throw new Error('case budget exceeded or cancelled')
      const variantDir = join(directory, name); mkdirSync(variantDir, { recursive: true })
      const spec = compileSceneSpec(source).spec
      const specPath = join(variantDir, 'scene-spec.json'), checkpointPath = join(variantDir, 'scene.blend')
      save(specPath, spec)
      console.log(`${entry.id}/${name}: compile`)
      const compiled = await runtime.compileScene({ sceneSpecPath: specPath, projectRoot: variantDir, profile: tier.profile, signal: controller.signal,
        onWorkingDirectory: ({ directory }) => copyFileSync(join(directory, 'result.blend'), checkpointPath) })
      save(join(variantDir, 'compile.json'), compiled.envelope)
      const polygons = (compiled.report.objects ?? []).reduce((sum, object) => sum + (object.polygonCount ?? 0), 0)
      if (polygons > entry.maxPolygons) throw new Error(`${entry.id}: ${polygons} polygons exceed ${entry.maxPolygons}`)
      const variant = result.variants[name] = { compileMs: compiled.durationMs, polygons, checkpointSha256: hash(readFileSync(checkpointPath)), images: {} }
      console.log(`${entry.id}/${name}: inspect compiled checkpoint`)
      const geometryPath = join(variantDir, 'verification-geometry.json')
      await execute(process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender'),
        ['--background', '--factory-startup', '--python-exit-code', '1', '--python', captured.inspectorPath, '--', checkpointPath, geometryPath], output, 60000, controller.signal)
      if (name === 'candidate') {
        const geometry = json(geometryPath)
        copyFileSync(geometryPath, join(variantDir, 'geometry.json'))
        variant.geometry = geometry
        validateGeometry(geometry, loaded.geometryChecks, entry.id)
        if (!hasEvaluatedMotion(geometry.poses)) throw new Error(`${entry.id}: declared motion does not change evaluated transforms`)
      }
      persist()
      const caseViews = viewsForCase(entry, manifest)
      const views = options.views ? caseViews.filter(view => options.views.includes(view.id))
        : name === 'clay' ? caseViews.slice(0, 2) : name === 'baseline' || tierName === 'draft' ? caseViews.slice(0, 3) : caseViews
      console.log(`${entry.id}/${name}: render ${views.map(view => view.id).join(', ')}`)
      const rendered = await runtime.renderViews({ checkpointPath, views, engine: 'cycles', width: tier.resolution[0], height: tier.resolution[1], samples: tier.samples, signal: controller.signal })
      save(join(variantDir, 'views.json'), rendered.envelope)
      variant.renderMs = rendered.durationMs; variant.renderConfig = rendered.report.renderConfig
      for (const view of views) {
        const bytes = rendered.pngs[view.id]
        if (!bytes) throw new Error(`${entry.id}/${name}: missing ${view.id}`)
        const facts = pngFacts(bytes)
        if (!same([facts.width, facts.height], tier.resolution)) throw new Error(`${entry.id}: unexpected image size`)
        if (facts.luminanceStdDev < .005) throw new Error(`${entry.id}/${name}/${view.id}: image is effectively uniform`)
        const path = join(variantDir, `${view.id}.png`); writeFileSync(path, bytes)
        variant.images[view.id] = { ...facts, path: relative(output, path), cameraId: view.cameraId, frame: view.frame }
      }
      persist()
    }
    if (tier.motion && !options.views) {
      const motion = manifest.motion
      const frames = Array.from({ length: motion.frameEnd - motion.frameStart + 1 }, (_, index) => index + motion.frameStart)
      const jobDirectory = join(directory, 'motion')
      console.log(`${entry.id}: render ${frames.length} motion frames`)
      sequence = await runtime.startFrameSequence({ checkpointPath: join(directory, 'candidate/scene.blend'), jobDirectory,
        frames, cameraId: entry.motionCameraId ?? motion.cameraId, frameRange: [1, 48], jobId: `benchmark-${entry.id}`,
        profileName: 'preview', profile: { ...candidate.renderProfiles.preview, resolution: motion.resolution, samples: motion.samples } })
      const onAbort = () => sequence.handle.terminate()
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
      const rendered = await runtime.awaitFrameSequence(sequence)
      controller.signal.removeEventListener('abort', onAbort)
      sequence = null
      if (rendered.exitCode !== 0 || rendered.envelope?.status !== 'success') throw new Error(`Motion render failed: ${JSON.stringify(rendered.envelope?.error)}`)
      const actual = rendered.envelope.result
      if (actual.renderedCount !== frames.length) throw new Error('Motion frame count differs from the plan')
      const frameFacts = actual.frames.map(frame => ({ frame: frame.frame, ms: frame.ms, ...pngFacts(readFileSync(frame.path)) }))
      if (!hasRenderedMotion(frameFacts)) throw new Error('Motion frames are all byte-identical; inspect whether animation is effective')
      const video = join(jobDirectory, 'motion.mp4')
      await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(motion.fps), '-start_number', '1',
        '-i', join(jobDirectory, 'frames/frame_%04d.png'), '-frames:v', String(frames.length), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], output, 60000, controller.signal)
      const probe = JSON.parse(await execute('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate', '-of', 'json', video], output, 10000, controller.signal)).streams[0]
      if (Number(probe.nb_read_frames) !== frames.length || !same([probe.width, probe.height], motion.resolution) || probe.avg_frame_rate !== `${motion.fps}/1`) throw new Error('Encoded motion metadata differs from requested frames, dimensions or rate')
      result.motion = { path: relative(output, video), sha256: hash(readFileSync(video)), frameCount: frames.length, fps: motion.fps,
        width: probe.width, height: probe.height, renderMs: rendered.durationMs, renderConfig: actual.renderConfig, frames: frameFacts }
    }
    controller.signal.throwIfAborted()
    result.status = 'technical-pass'
  } catch (error) {
    result.status = 'failed'; result.error = error.stack ?? error.message
  } finally {
    clearTimeout(deadline); options.signal?.removeEventListener('abort', abort)
    await ctx.stop?.(); persist()
  }
  return result
}

async function main() {
  const args = process.argv.slice(2), manifest = json(join(BENCHMARK_ROOT, 'manifest.json'))
  const acceptedFlags = new Set(['--case', '--tier', '--views', '--output', '--check'])
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (!acceptedFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`)
    if (flag !== '--check' && (!args[++index] || args[index].startsWith('--'))) throw new Error(`Missing value for ${flag}`)
  }
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback
  const tier = value('--tier', 'review'), caseName = value('--case', 'all')
  if (!manifest.tiers[tier]) throw new Error(`Unknown tier ${tier}`)
  const cases = caseName === 'all' ? manifest.cases.map(entry => entry.id) : [caseName]
  const loaded = cases.map(id => loadCase(id, manifest))
  if (args.includes('--check')) { console.log(`Validated ${loaded.length} fixed benchmark case(s).`); return }
  const views = value('--views', null)?.split(',')
  if (views?.some(id => !manifest.views.some(view => view.id === id))) throw new Error('Unknown view in --views')
  const output = resolve(value('--output', join(ROOT, '.deepblend/quality/benchmarks', `${Date.now()}-${randomUUID().slice(0, 8)}`)))
  if (existsSync(join(output, 'run.json'))) throw new Error('Output already contains a run; use a fresh directory to retain prior evidence')
  mkdirSync(output, { recursive: true })
  const sources = sourceSnapshot()
  for (const source of sources) {
    const bytes = readFileSync(join(ROOT, source.path))
    if (hash(bytes) !== source.sha256) throw new Error(`Source changed during snapshot: ${source.path}`)
    const target = join(output, 'source-snapshot', source.path)
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes)
  }
  const blender = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
  const version = (await execute(blender, ['--version'], ROOT, 10000)).trim()
  const expectedVersion = json(join(ROOT, 'deepblend/tools/blender-release.json')).version
  if (!version.startsWith(`Blender ${expectedVersion}`)) throw new Error(`Benchmark requires Blender ${expectedVersion}; found ${version.split('\n')[0]}`)
  const report = { schemaVersion: 'deepblend.benchmark-run/v1', tier, status: 'running', startedAt: new Date().toISOString(),
    manifestSha256: hash(readFileSync(join(BENCHMARK_ROOT, 'manifest.json'))), sourceRevision: (await execute('git', ['rev-parse', 'HEAD'], ROOT, 10000)).trim(),
    sourceSnapshotSha256: hash(canonicalStringify(sources)), sourceSnapshot: sources, blenderVersion: version,
    runtimeSources: { blenderPython: 'source-snapshot/packages/deepblend/provider-local/python', inspector: 'source-snapshot/deepblend/tools/inspect-benchmark.py' },
    selectedViews: views ?? null,
    machine: { platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
    referencePolicy: manifest.referencePolicy, modelCalls: 0, cases: [] }
  save(join(output, 'run.json'), report)
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Benchmark run cancelled'))
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    for (const item of loaded) {
      if (controller.signal.aborted) break
      report.cases.push(await renderCase(item, manifest, tier, output, { views, signal: controller.signal }))
      save(join(output, 'run.json'), report); writeGallery(output, report)
    }
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
  report.status = controller.signal.aborted ? 'cancelled' : report.cases.every(entry => entry.status === 'technical-pass') ? (views ? 'partial-run-review-required' : 'technical-pass-review-required') : 'failed'
  report.finishedAt = new Date().toISOString(); save(join(output, 'run.json'), report); writeGallery(output, report)
  console.log(`BENCHMARK_RESULT ${join(output, 'run.json')}`)
  if (['failed', 'cancelled'].includes(report.status)) process.exitCode = 1
  else {
    const verified = verifyBenchmark(output)
    console.log(`ARTIFACT_VERIFICATION ${verified.status} ${join(output, 'artifact-verification.json')}`)
    if (verified.status !== 'technical-artifact-pass') { console.error(verified.errors.join('\n')); process.exitCode = 1 }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1 })
