#!/usr/bin/env node
/**
 * Probe: what happens when the disk fills up in the middle of a delivery render.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §15.2 lists "CPU、内存、磁盘、GPU 配额" and `security.md` records the honest state: only
 * bytes and time are capped, and a frame sequence's disk use has no ceiling. The recorded reason
 * leans on SPEC §15.3 putting process resource limits in the container layer — which is true for
 * CPU, memory and GPU, and NOT true for the frames this product writes. Those are our data.
 *
 * So the question this probe answers is the one the deviation text was asserting without evidence:
 * **when the volume fills, does the render fail in a way a person can recover from, or does it
 * lose work / hang / report success?** A real 24 MiB volume, a real render, a real failure.
 *
 * It never touches the developer's store: the project root IS the mounted image, and the image is
 * removed at the end whatever happens.
 *
 * Run: node deepblend/tools/disk-full-probe.mjs | tee deepblend/docs/probe-disk-full.log
 *
 * Owner: DeepBlend Studio — M5
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'

import { defaultSceneSpec } from '@deepblend/dsh-blender-host'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')

/** Small enough to fill in seconds, large enough for APFS to accept the image. */
const VOLUME_MB = 24
/** A frame this size fills 24 MiB in roughly thirty frames. */
const RESOLUTION = [1280, 720]
const SAMPLES = 4
const FRAMES = 400
/** How long to wait for the render to reach a terminal state before calling it a hang. */
const WAIT_MS = 6 * 60 * 1000

const say = (label, value) => console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-disk-probe-'))
const image = join(scratch, 'volume.dmg')
const mount = join(scratch, 'mnt')
let attached = false
let root = null

try {
  if (!existsSync(BLENDER)) {
    console.error(`Blender not found at ${BLENDER}; see deepblend/docs/dsh-baseline.md §5.`)
    process.exit(2)
  }

  say('date', new Date().toISOString())
  say('scratch', scratch)

  // -------------------------------------------------------------------------
  // A real, small volume
  // -------------------------------------------------------------------------
  const created = spawnSync('hdiutil', ['create', '-size', `${VOLUME_MB}m`, '-fs', 'APFS', '-volname', 'DeepBlendProbe', '-quiet', image], { encoding: 'utf8' })
  if (created.status !== 0) throw new Error(`hdiutil create failed: ${created.stderr || created.stdout}`)
  const attachedResult = spawnSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mount, image], { encoding: 'utf8' })
  if (attachedResult.status !== 0) throw new Error(`hdiutil attach failed: ${attachedResult.stderr || attachedResult.stdout}`)
  attached = true

  const df = spawnSync('df', ['-m', mount], { encoding: 'utf8' }).stdout.trim().split('\n').pop().split(/\s+/)
  say('volume', `${df[1]} MiB total, ${df[3]} MiB available at ${mount}`)

  // -------------------------------------------------------------------------
  // A project on that volume
  // -------------------------------------------------------------------------
  // Inside the workspace, because the host refuses a projectsRoot that escapes it — the guard
  // fired on the first version of this probe, which is the control doing its job (SPEC §15.2).
  const workspace = join(mount, 'workspace')
  const projectsRoot = join(workspace, 'projects')

  root = new Context()
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: BLENDER,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: workspace,
    timeoutMs: 300_000,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    workspaceRoot: workspace,
    projectsRoot,
  })
  await new Promise(settle => setTimeout(settle, 400))

  const studio = root.get('blenderStudio')
  const spec = defaultSceneSpec({ projectId: 'disk-full', title: 'Disk full', goal: 'Fill a small volume.' })
  spec.renderProfiles.final = {
    engine: 'cycles',
    resolution: RESOLUTION,
    samples: SAMPLES,
    filmTransparent: false,
    colorManagement: { viewTransform: 'AgX' },
    maxSamplesBudget: 1024,
  }
  spec.renderProfiles.preview = { ...spec.renderProfiles.preview, resolution: [64, 36], samples: 4, maxSamplesBudget: 64 }

  const created2 = await studio.createProject({
    projectId: 'disk-full',
    title: 'Disk full',
    goal: 'Fill a small volume.',
    sceneSpec: spec,
    saveCheckpoint: true,
    renderPreview: false,
  })
  say('project', `${created2.projectId} at ${created2.revision?.revision ?? '?'}`)

  // -------------------------------------------------------------------------
  // Render until the volume says no
  // -------------------------------------------------------------------------
  const started = await studio.startFinalRender({ projectId: 'disk-full', frameStart: 1, frameEnd: FRAMES, profileName: 'final' })
  const jobId = started.jobId
  say('job', `${jobId}, frames 1..${FRAMES} at ${RESOLUTION.join('x')}`)

  const framesDirectory = join(projectsRoot, 'disk-full', 'renders', jobId, 'frames')
  const framesOnDisk = () => (existsSync(framesDirectory) ? readdirSync(framesDirectory).filter(name => name.endsWith('.png')).length : 0)
  const rendererAlive = () => spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' }).stdout
    .split('\n').some(line => line.includes('Blender') && line.includes('disk-full'))

  const startedMs = Date.now()
  let job = null
  let lastCount = -1
  let lastChangeMs = Date.now()
  for (;;) {
    job = await studio.getJob({ projectId: 'disk-full', jobId })
    const count = framesOnDisk()
    if (count !== lastCount) {
      lastCount = count
      lastChangeMs = Date.now()
      console.log(`   ${new Date().toISOString()} ${job.status} ${count} frame(s) on disk, renderer ${rendererAlive() ? 'alive' : 'GONE'}`)
    }

    const terminal = ['completed', 'failed', 'cancelled'].includes(job.status)
    if (terminal) { say('terminal by', 'the job record'); break }
    // The interesting case: the record still says running, but nothing is rendering any more.
    if (!rendererAlive() && Date.now() - lastChangeMs > 45_000) {
      say('stalled', `the record still says "${job.status}" while no renderer exists and no frame has landed for 45 s`)
      break
    }
    if (Date.now() - startedMs > WAIT_MS) { say('timeout', `${Math.round(WAIT_MS / 1000)} s without a terminal state`); break }
    await new Promise(settle => setTimeout(settle, 1500))
  }

  say('elapsed', `${Math.round((Date.now() - startedMs) / 1000)} s`)
  say('final status', job.status)
  say('errorCode', job.errorCode ?? '(none)')
  say('message', (job.message ?? '(none)').split('\n')[0].slice(0, 200))
  say('progress', job.progress)

  // What is actually on the volume?
  const files = existsSync(framesDirectory) ? readdirSync(framesDirectory).filter(name => name.endsWith('.png')) : []
  const bytes = files.reduce((sum, name) => sum + statSync(join(framesDirectory, name)).size, 0)
  say('frames on disk', `${files.length} files, ${(bytes / (1024 * 1024)).toFixed(1)} MiB`)
  say('average frame', files.length === 0 ? '(none)' : `${Math.round(bytes / files.length / 1024)} KiB`)

  const dfAfter = spawnSync('df', ['-m', mount], { encoding: 'utf8' }).stdout.trim().split('\n').pop().split(/\s+/)
  say('volume after', `${dfAfter[3]} MiB available`)

  // Is there still a Blender rendering into a full disk?
  const processTable = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' }).stdout
  const survivors = processTable.split('\n').filter(line => line.includes('Blender') && line.includes('disk-full'))
  say('blender still running', survivors.length === 0 ? 'none' : survivors.map(line => line.trim().slice(0, 90)))

  // And is the job recoverable? A resume is legal for a failed/cancelled job, and the frames
  // already written are the ones it keeps.
  say('resumable', ['failed', 'cancelled'].includes(job.status) ? 'yes — blender_final_render {resumeJobId}' : 'no')
  say('job record on disk', existsSync(join(projectsRoot, 'disk-full', 'renders', jobId, 'job.json')) ? 'yes' : 'no')

  // -------------------------------------------------------------------------
  // A restart, on the same store: whatever the record says, a fresh Host has to
  // make sense of it. This is the M3 reconciler, exercised by an accident rather
  // than by a kill.
  // -------------------------------------------------------------------------
  await root.stop?.()
  root = null
  const second = new Context()
  second.plugin(LocalSubprocess)
  second.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: BLENDER,
    bootstrapPath: BOOTSTRAP,
    workspaceRoot: workspace,
    timeoutMs: 300_000,
  })
  second.plugin((await import('@deepblend/dsh-blender-host')).default, {
    workspaceRoot: workspace,
    projectsRoot,
  })
  await new Promise(settle => setTimeout(settle, 400))
  root = second

  const studio2 = second.get('blenderStudio')
  // The reconciler is deferred by one tick and is asynchronous; reading the job before it has
  // finished measures the race, not the recovery. The first version of this probe did exactly
  // that and reported "a restart left the job running".
  // Two things, on purpose. `awaitReconciliation` is the pass the Host kicked when it was
  // constructed (SPEC §10.3, on by default); calling `reconcileRenderJobs` after it is the
  // same decision asked a second time, and comparing the two says whether the startup pass
  // ran at all or whether it ran and found nothing.
  const startupFindings = await studio2.awaitReconciliation()
  say('startup pass', startupFindings.map(finding => `${finding.status} (${finding.notes.length} note(s))`))

  // Free some room WITHOUT touching the frames: the image is detached and grown offline, which is
  // the only way to ask "does the recovery happen once there is space?" without destroying the work
  // being recovered. (Growing it while attached was the first attempt; hdiutil refuses, exit 35.)
  spawnSync('hdiutil', ['detach', '-quiet', '-force', mount], { encoding: 'utf8' })
  attached = false
  const resized = spawnSync('hdiutil', ['resize', '-size', `${VOLUME_MB * 4}m`, image], { encoding: 'utf8' })
  const reattached = spawnSync('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mount, image], { encoding: 'utf8' })
  attached = reattached.status === 0
  const dfFreed = spawnSync('df', ['-m', mount], { encoding: 'utf8' }).stdout.trim().split('\n').pop().split(/\s+/)
  say('volume after growing it', `${dfFreed[3]} MiB available (resize exit ${resized.status})`)
  const keptFrames = framesOnDisk()
  say('frames after detach and re-attach', keptFrames)

  const findings = await studio2.reconcileRenderJobs()
  say('reconciliation findings', findings.map(finding => ({
    previous: finding.previousStatus,
    status: finding.status,
    missing: finding.ledger?.missing ?? null,
    notes: finding.notes.length,
  })))

  const afterRestart = await studio2.getJob({ projectId: 'disk-full', jobId })
  say('after a restart', `${afterRestart.status}${afterRestart.errorCode ? ` (${afterRestart.errorCode})` : ''}`)
  say('missing frames after the restart', afterRestart.progress?.missing ?? '(not reported)')

  say('result', ['failed', 'cancelled', 'recovering'].includes(afterRestart.status)
    ? 'a full volume leaves the Host alive, the frames on disk, and a job a restart can pick up'
    : `UNEXPECTED: a restart left the job ${afterRestart.status}`)
} catch (cause) {
  console.error(`\nprobe threw: ${cause?.stack ?? cause}`)
} finally {
  if (root !== null) await root.stop?.().catch(() => {})
  if (attached) {
    spawnSync('hdiutil', ['detach', '-quiet', '-force', mount], { encoding: 'utf8' })
    attached = false
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log(`\n── cleaned up ${scratch}`)
}
