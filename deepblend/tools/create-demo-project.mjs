/**
 * Create the M1 demo project in the REAL deployment store.
 *
 *   node deepblend/tools/create-demo-project.mjs
 *
 * Configured with exactly the values the installed bundle patch composes, so the
 * project this produces is the one a restarted profile finds. It is idempotent:
 * if the project already exists it reports its state and exits without touching
 * it.
 *
 * It is a script rather than a test because its side effect is the POINT:
 * `.deepblend/projects/` is where the operator's projects live, and a milestone
 * that claims "Project Store + Revision Store" should leave something real in it
 * — something a person can open, render again, and restore — rather than only
 * evidence inside a temporary directory that the test suite deletes.
 */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { devStoreRoot } from './operator-layer.mjs'

// deepblend/tools/ -> deepblend/ -> repository root
const ROOT = resolve(import.meta.dirname, '..', '..')
// The store the RUNNING deployment uses, from the one module that defines it:
// install-plugin.mjs pins the profile to this same root, so a project this tool
// writes is one the workbench actually lists (see operator-layer.mjs).
const WORK = devStoreRoot(ROOT)

const ctx = new Context()
ctx.plugin(LocalSubprocess)
ctx.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
  blenderPath: join(ROOT, '.tools/Blender.app/Contents/MacOS/Blender'),
  bootstrapPath: join(ROOT, 'packages/deepblend/provider-local/python/bootstrap.py'),
  workspaceRoot: WORK,
})
ctx.plugin((await import('@deepblend/dsh-blender-host')).default, {
  projectsRoot: join(WORK, 'projects'),
  workspaceRoot: WORK,
  serveCachedCapabilities: true,
  maxPreviewSamples: 512,
})
await new Promise(r => setTimeout(r, 250))

const studio = ctx.get('blenderStudio')
const fixture = JSON.parse(readFileSync(join(ROOT, 'deepblend/fixtures/product-turntable/scene-spec.json'), 'utf8'))

// The id is passed EXPLICITLY rather than derived from the title. Deriving it
// would make this script non-idempotent: `allocateProjectId` disambiguates a
// collision into `watch-commercial-2` instead of failing, which is the right
// behaviour for a project create and the wrong behaviour for a "make sure the
// demo exists" script. An explicit id turns the second run into a no-op.
const DEMO_PROJECT_ID = 'watch-commercial'

let project
try {
  project = await studio.createProject({
    projectId: DEMO_PROJECT_ID,
    title: 'Watch Commercial',
    goal: fixture.project.goal,
    sceneSpec: fixture,
    renderPreview: true,
  })
  console.log(`r0001  create     ${project.projectId}  digest ${project.revision.digest.slice(0, 12)}  ${project.job.durationMs} ms`)
} catch (error) {
  if (error.code !== 'PROJECT_EXISTS') throw error
  const existing = await studio.getProject(DEMO_PROJECT_ID)
  console.log(`${DEMO_PROJECT_ID} already exists at ${existing.currentRevision} — nothing to do.`)
  console.log('Delete it first if you want a fresh demo:')
  console.log(`  rm -rf .deepblend/projects/${DEMO_PROJECT_ID}`)
  await ctx.stop?.()
  process.exit(0)
}

const patch = await studio.applyScenePatch({
  projectId: project.projectId,
  baseRevision: project.revision.revision,
  note: 'Raise the key light and tighten the case bevel so the edge highlight reads at preview size.',
  stage: 'VISUAL_REVIEW',
  actor: 'm1-demo',
  operations: [
    { op: 'light.update', lightId: 'key-light', energy: 88, size: 0.8 },
    { op: 'material.parameter.update', materialId: 'hero-steel', parameter: 'roughness', value: 0.19 },
    { op: 'render.profile.set', profileName: 'preview', profile: { engine: 'cycles', resolution: [640, 360], samples: 64 } },
  ],
  renderPreview: true,
})
console.log(`r0002  patch      digest ${patch.digest.slice(0, 12)}  ${patch.job.durationMs} ms  previews ${patch.previews.length}`)

const validation = await studio.validateScene({ projectId: project.projectId })
console.log(`       validate   ok=${validation.ok} errors=${validation.errorCount} notices=${validation.noticeCount}`)

const preview = await studio.renderPreview({ projectId: project.projectId, cameraId: 'camera-top', frame: 22 })
console.log(`       preview    ${preview.artifacts[0].path}  ${preview.artifacts[0].width}x${preview.artifacts[0].height}  ${preview.artifacts[0].bytes} bytes  ${preview.job.durationMs} ms`)

const final = await studio.getProject(project.projectId)
console.log(`\nproject ${final.projectId}: ${final.revisions.length} revisions, current ${final.currentRevision}`)
for (const entry of final.revisions) {
  console.log(`  ${entry.revision}  ${String(entry.kind).padEnd(15)} ${entry.checkpoint === null ? 'no checkpoint ' : 'checkpoint    '} ${entry.previews.length} preview(s)`)
  console.log(`          ${entry.summary ?? ''}`)
}

console.log('\non disk:')
const walk = (dir, prefix = '') => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, `${prefix}${name}/`)
    else console.log(`  ${prefix}${name}  (${stats.size} B)`)
  }
}
walk(join(WORK, 'projects', final.projectId), `${final.projectId}/`)

await ctx.stop?.()
