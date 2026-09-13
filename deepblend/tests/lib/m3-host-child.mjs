#!/usr/bin/env node
/**
 * A Host in its own process, for the M3 restart suite.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "重启后能识别未完成渲染" is a claim about a process that is GONE. A suite that
 * constructs a second Host *inside* the process that started the render does not
 * test it: the first Host's background render loop is still alive, still holds the
 * subprocess handle, and — measured — marks the job `failed` the moment its child
 * dies. The second Host then finds a terminal record and reports nothing to
 * recover, which is a green test for the wrong reason.
 *
 * So the suite forks this file. Phase 1 runs in one process, is SIGKILLed, and the
 * recovery runs in a THIRD process that only ever reads the store. That is the
 * shape of the real event, and it is the same shape `tools/m3-restart-probe.mjs`
 * used to produce the evidence this milestone was designed from.
 *
 * Usage (driven by the suite, never by hand):
 *   node m3-host-child.mjs start    --scratch <dir> --project <id> --revision <r> --frame-start N --frame-end M
 *   node m3-host-child.mjs recover  --scratch <dir>
 *
 * Both modes print exactly one machine-readable line prefixed `M3CHILD ` and then
 * either idle (start) or exit (recover).
 *
 * Owner: DeepBlend Studio — M3
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { importDsh } from './dsh-deployment.mjs'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..', '..', '..')
const BLENDER = process.env.DEEPBLEND_BLENDER_PATH
  ?? join(ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender')
const BOOTSTRAP = join(ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py')

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function emit(payload) {
  console.log(`M3CHILD ${JSON.stringify(payload)}`)
}

const scratch = option('scratch')
if (scratch === undefined) {
  console.error('--scratch is required')
  process.exit(2)
}
if (!existsSync(BLENDER)) {
  console.error(`Blender not found at ${BLENDER}`)
  process.exit(2)
}

const { LocalJobRegistry } = await importDsh('dsh-jobs-local')
const { default: Provider, ProviderConfig } = await import('@deepblend/dsh-blender-provider-local')
const { default: Studio } = await import('@deepblend/dsh-blender-host')

const ctx = new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin(LocalJobRegistry)
ctx.plugin(Provider, ProviderConfig({
  blenderPath: BLENDER,
  bootstrapPath: BOOTSTRAP,
  workspaceRoot: scratch,
  timeoutMs: 600_000,
}))
ctx.plugin(Studio, {
  projectsRoot: join(scratch, 'projects'),
  workspaceRoot: scratch,
  serveCachedCapabilities: true,
  maxPreviewSamples: 512,
  ffmpegPath: process.env.DEEPBLEND_FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.DEEPBLEND_FFPROBE_PATH ?? 'ffprobe',
  reconcileOnStart: true,
  progressPollMs: 200,
  encodePreset: 'ultrafast',
})
await new Promise(settle => setTimeout(settle, 300))
const studio = ctx.get('blenderStudio')
if (studio === undefined) {
  console.error('blenderStudio did not activate in the child Host')
  process.exit(2)
}

const mode = process.argv[2]

if (mode === 'start') {
  const started = await studio.startFinalRender({
    projectId: option('project'),
    revision: option('revision'),
    frameStart: Number(option('frame-start')),
    frameEnd: Number(option('frame-end')),
  })
  emit({
    mode: 'start',
    pid: process.pid,
    jobId: started.jobId,
    dshJobId: started.dshJobId ?? null,
    projectId: started.projectId,
    revision: started.revision,
    frameStart: started.frameStart,
    frameEnd: started.frameEnd,
    frames: started.frames,
  })
  // Idle until SIGKILLed. The render continues in the detached Blender child; this
  // process is the thing the suite is about to destroy.
  setInterval(() => {}, 1000)
} else if (mode === 'recover') {
  const findings = await studio.awaitReconciliation()
  const projects = option('project') !== undefined ? [option('project')] : studio.store.listProjectIds()
  const records = []
  for (const projectId of projects) {
    for (const record of studio.renderJobs.list(projectId)) records.push(studio._canonicalRenderJob(record))
  }
  emit({ mode: 'recover', pid: process.pid, findings, records })
  process.exit(0)
} else {
  console.error('usage: m3-host-child.mjs <start|recover> --scratch <dir> [...]')
  process.exit(2)
}
