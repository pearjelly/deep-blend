/** Two independent Host/Blender processes publish into one real project. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Provider, { ProviderConfig } from '@deepblend/dsh-blender-provider-local'
import Studio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { sha256, sceneSpecDigest, decodePng } from '@deepblend/dsh-blender-contracts'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = resolve(import.meta.dirname, '../../..'), BLENDER = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender')
const output = resolve(process.env.DEEPBLEND_ARTIFACT_CONCURRENCY_OUTPUT ?? join(ROOT, '.deepblend/quality', `artifact-concurrency-${Date.now()}`))
if (existsSync(output)) throw new Error(`Evidence directory already exists: ${output}`)
mkdirSync(output, { recursive: true })
const root = join(output, 'workspace'), checks = [], runs = [], children = [], ctx = new Context(), fibers = []
let failure = null
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`)
}
function child(args) {
  const proc = fork(fileURLToPath(new URL('../lib/artifact-writer-child.mjs', import.meta.url)), args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages = [], waiters = []; let stdout = '', stderr = ''
  proc.stdout.on('data', chunk => { stdout += chunk }); proc.stderr.on('data', chunk => { stderr += chunk })
  proc.on('message', message => {
    messages.push(message); const index = waiters.findIndex(waiter => waiter.type === message.type)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
  })
  const exited = new Promise(resolve => proc.once('exit', (code, signal) => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child ${code}/${signal}: ${stderr}`))
    resolve({ code, signal, stdout, stderr })
  }))
  const entry = { proc, messages, exited, next(type) {
    const message = messages.find(entry => entry.type === type)
    return message ? Promise.resolve(message) : new Promise((resolve, reject) => {
      waiters.push({ type, resolve, reject }); setTimeout(() => reject(new Error(`child did not report ${type}: ${stderr}`)), 120_000).unref()
    })
  } }; children.push(entry); return entry
}
try {
  fibers.push(ctx.plugin(LocalSubprocess), ctx.plugin(Provider, ProviderConfig({ blenderPath: BLENDER, workspaceRoot: root, timeoutMs: 120_000 })))
  fibers.push(ctx.plugin(Studio, StudioConfig({ workspaceRoot: root, projectsRoot: join(root, 'projects'), reconcileOnStart: false })))
  for (let i = 0; !ctx.get('blenderStudio') && i < 500; i++) await delay(10)
  const studio = ctx.get('blenderStudio')
  if (!studio) throw new Error('native Host did not activate')
  const spec = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
  spec.renderProfiles.preview.resolution = [48, 16]; spec.renderProfiles.preview.samples = 4
  const created = await studio.createProject({ projectId: 'race', title: 'native concurrent previews', sceneSpec: spec, saveCheckpoint: true })
  const projectId = created.projectId, file = name => join(root, 'projects', projectId, name), protectedPaths = ['scene-spec.json', 'scene.blend'].map(name => file('revisions/r0001/' + name)), protectedBytes = protectedPaths.map(path => readFileSync(path))
  const digest = sceneSpecDigest(studio.store.readRevisionSpec(projectId, 'r0001'))
  for (const mode of ['allocation', 'manifest', 'views']) {
    const release = join(output, `release-${mode}`), kind = mode === 'views' ? 'views' : 'preview'
    const args = (held, width) => [root, projectId, mode === 'allocation' ? 'allocation' : held ? 'manifest-hold' : 'normal', String(width), release, 'camera-main', '24', kind, BLENDER]
    const a = child(args(true, 48)), b = child(args(false, 56)); await Promise.all([a.next('ready'), b.next('ready')])
    a.proc.send('go'); let allocated = null
    if (mode === 'allocation') {
      b.proc.send('go'); allocated = await Promise.all([a.next('allocated'), b.next('allocated')]); writeFileSync(release, 'release')
    } else {
      await a.next('manifest-read'); b.proc.send('go'); await b.next('rendered'); await delay(100); writeFileSync(release, 'release')
    }
    const results = await Promise.all([a.next('result'), b.next('result')]), exits = await Promise.all([a.exited, b.exited])
    runs.push({ mode, allocated, results, exits, messages: [a.messages, b.messages] })
    check(`${mode}: both independent Hosts succeed`, results.every(result => result.ok), results)
    check(`${mode}: distinct process and attempt identities`, results[0].pid !== results[1].pid && results[0].job.jobId !== results[1].job.jobId)
    check(`${mode}: all child providers finish cleanly`, exits.every(exit => exit.code === 0 && exit.signal === null), exits)
    const manifest = studio.store.readRevisionManifest(projectId, 'r0001')
    const live = mode === 'views' ? [results[1]] : results
    for (const result of live) {
      check(`${mode}: completed job retains exact returned artifacts`, JSON.stringify(studio.store.readJobSafe(projectId, result.job.jobId).artifacts) === JSON.stringify(result.artifacts))
      for (const artifact of result.artifacts) {
        const bytes = readFileSync(file(artifact.path)), png = decodePng(bytes)
        check(`${mode}: ${artifact.kind} pixels and index retain actual digest and source`, sha256(bytes) === artifact.sha256 && png.width === artifact.width && png.height === artifact.height && artifact.sourceDigest === digest && artifact.sourceRevision === 'r0001' && [...manifest.previews, ...(manifest.contactSheets ?? [])].some(item => item.path === artifact.path && item.sha256 === artifact.sha256), artifact)
        if (artifact.kind === 'preview') check(`${mode}: actual Blender camera, frame and sampling are recorded`, artifact.renderConfig?.samples === 4 && artifact.frame === 24 && artifact.cameraId === 'camera-main', artifact.renderConfig)
      }
    }
    if (mode === 'views') {
      const previous = manifest.contactSheets.find(item => item.slot === 'preview-previous'), current = manifest.contactSheets.find(item => item.slot === 'preview-current'), first = results[0].artifacts.find(item => item.kind === 'contact-sheet')
      const previousPng = decodePng(readFileSync(file(previous.path)))
      check('views: rotation retains first actual sheet bytes, dimensions, time and producing job', sha256(readFileSync(file(previous.path))) === first.sha256 && previous.sha256 === first.sha256 && previous.jobId === results[0].job.jobId && previous.at === first.at && previous.width === previousPng.width && previous.height === previousPng.height)
      check('views: current sheet belongs to the second coordinated publisher', current.jobId === results[1].job.jobId)
    } else check(`${mode}: separate native single images remain separate files`, results[0].artifacts[0].path !== results[1].artifacts[0].path)
    check(`${mode}: authored source and checkpoint remain byte-identical`, protectedPaths.every((path, i) => readFileSync(path).equals(protectedBytes[i])))
    check(`${mode}: publication leases are released`, readdirSync(join(root, '.revision-writers')).length === 0)
  }
} catch (cause) { failure = cause; console.error(cause) }
finally {
  for (const child of children) { if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill('SIGKILL'); await child.exited }
  for (const fiber of fibers.reverse()) await fiber.dispose()
  writeFileSync(join(output, 'result.json'), JSON.stringify({ scope: 'Actual independent Host/Blender processes on one local filesystem; controlled barriers extend allocation and manifest read windows. Views retain the existing mutable two-generation policy.', checks, runs, failure: failure ? { message: failure.message, stack: failure.stack } : null }, null, 2) + '\n')
}
console.log(`\nArtifact concurrency: ${checks.filter(check => check.ok).length}/${checks.length} check(s) passed`)
if (failure) process.exitCode = 1
