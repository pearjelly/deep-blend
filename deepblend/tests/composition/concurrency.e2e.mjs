#!/usr/bin/env node
/**
 * M5 — two concurrent DeepBlend sessions must not corrupt each other's work.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §20's definition of done lists "两个并发 deepblend 会话无服务冲突", and it was
 * the last acceptance line with nothing asserting it. The interesting half is not
 * the services — the plane rules make those structural (a preset's service rows sit
 * in an `isolate` realm, checked below) — but the SHARED STATE they both write: one
 * project store.
 *
 * Two sessions editing one project is not a hypothetical. It is what happens when a
 * user opens two tabs, and what happens when the same session retries a call whose
 * first attempt has not returned. The answer has to be a CODED REFUSAL that leaves
 * the store consistent, never a silent second write.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS TWO-SIDED
 * -----------------------------------------------
 * Every case here runs its calls with `Promise.allSettled`, so both are genuinely in
 * flight, and asserts BOTH halves: exactly one success, and a failure with a named
 * code. "One of them worked" alone would pass if the store had silently accepted
 * both and the loser had lost its answer.
 *
 * The last case is the idempotency contract under concurrency, and it is stated the
 * way it was MEASURED rather than the way it would be nice to state: two simultaneous
 * submissions of one key produce one revision and one conflict, and the SEQUENTIAL
 * retry then returns the recorded result. That is a weaker promise than "duplicates
 * always replay identically", and it is the true one — see D85.
 *
 * Run: node deepblend/tests/composition/concurrency.e2e.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-concurrency-'))

const root = new Context()
try {
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: process.env.DEEPBLEND_BLENDER_PATH
      ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
    bootstrapPath: join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
    workspaceRoot: scratch,
    timeoutMs: 180_000,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    workspaceRoot: scratch,
    projectsRoot: join(scratch, 'projects'),
    serveCachedCapabilities: true,
  })
  await new Promise(settle => setTimeout(settle, 400))

  const studio = root.get('blenderStudio')

  // One real project with ONE real checkpoint, so the delivery cases can start a
  // render, and at 64x36/4 samples so they cost nothing.
  const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
  spec.renderProfiles.preview = { ...spec.renderProfiles.preview, resolution: [64, 36], samples: 4 }
  spec.renderProfiles.final = { ...spec.renderProfiles.final, resolution: [64, 36], samples: 4 }

  await studio.createProject({
    projectId: 'contended',
    title: 'Contended project',
    goal: 'Two callers, one store.',
    sceneSpec: spec,
    saveCheckpoint: true,
    renderPreview: false,
  })
  check('a project with a checkpoint exists for the contended cases',
    (await studio.getProject('contended')).currentRevision === 'r0001')

  // -------------------------------------------------------------------------
  // 1. Two patches from the SAME base revision
  // -------------------------------------------------------------------------
  const lens = value => ({ op: 'camera.update', cameraId: 'camera-main', lens: value })
  const patch = (base, value) => studio.applyScenePatch({
    projectId: 'contended',
    baseRevision: base,
    operations: [lens(value)],
    note: `concurrency: ${value}`,
    saveCheckpoint: false,
  })

  const raced = await Promise.allSettled([patch('r0001', 40), patch('r0001', 50)])
  const winners = raced.filter(entry => entry.status === 'fulfilled')
  const losers = raced.filter(entry => entry.status === 'rejected')

  check('of two patches submitted from one base revision, exactly one commits',
    winners.length === 1 && losers.length === 1,
    raced.map(entry => entry.status === 'fulfilled' ? entry.value.revision : `rejected ${entry.reason?.code}`))
  check('and the loser is refused with a coded conflict rather than silently merged away',
    losers[0]?.reason?.code === 'REVISION_CONFLICT', losers[0]?.reason?.code ?? '(no rejection)')
  check('the conflict names the revision the caller must re-read from, so the recovery is mechanical',
    typeof losers[0]?.reason?.message === 'string' && /r0002/.test(losers[0].reason.message),
    String(losers[0]?.reason?.message ?? '').split('\n')[0])

  const afterRace = await studio.getProject('contended')
  check('the store holds exactly the revisions that were acknowledged — no phantom from the loser',
    afterRace.revisions.map(entry => entry.revision).join(',') === 'r0001,r0002',
    afterRace.revisions.map(entry => entry.revision))
  check('and the current pointer is the winner, not a mixture',
    afterRace.currentRevision === winners[0].value.revision, afterRace.currentRevision)

  // -------------------------------------------------------------------------
  // 2. Two deliveries started at once
  // -------------------------------------------------------------------------
  const startDelivery = () => studio.startFinalRender({ projectId: 'contended', revision: 'r0001', frames: [1] })
  const deliveries = await Promise.allSettled([startDelivery(), startDelivery()])
  const started = deliveries.filter(entry => entry.status === 'fulfilled')
  const refused = deliveries.filter(entry => entry.status === 'rejected')

  check('of two deliveries started at once, exactly one gets a job',
    started.length === 1 && refused.length === 1,
    deliveries.map(entry => entry.status === 'fulfilled' ? entry.value.jobId : `rejected ${entry.reason?.code}`))
  check('and the other is refused with a code that names the conflict, not a generic failure',
    refused[0]?.reason?.code === 'RENDER_JOB_CONFLICT', refused[0]?.reason?.code ?? '(no rejection)')
  check('the refusal points at the running job, so the caller can resume or cancel it instead of retrying blindly',
    /resumeJobId|blender_job_cancel/.test(String(refused[0]?.reason?.message ?? '')),
    String(refused[0]?.reason?.message ?? '').slice(0, 120))

  for (const entry of started) {
    await studio.cancelJob({ projectId: 'contended', jobId: entry.value.jobId, reason: 'concurrency suite' })
  }
  check('the one job that started can be cancelled, and the project is usable afterwards',
    (await studio.getProject('contended')).currentRevision === 'r0002')

  // -------------------------------------------------------------------------
  // 3. Previews do not take the delivery lock
  // -------------------------------------------------------------------------
  //
  // A delivery is exclusive per PROJECT — two renderers writing one frame directory
  // produce files neither can vouch for. A preview writes into the revision's own
  // `previews/` directory, so two of them on different revisions must both proceed:
  // making previews exclusive would turn "look at it while it renders" into a queue.
  const previews = await Promise.allSettled([
    studio.renderPreview({ projectId: 'contended', revision: 'r0001', cameraId: 'camera-main' }),
    studio.renderPreview({ projectId: 'contended', revision: 'r0002', cameraId: 'camera-main' }),
  ])
  check('two previews on different revisions run concurrently rather than queueing',
    previews.every(entry => entry.status === 'fulfilled'),
    previews.map(entry => entry.status === 'fulfilled' ? entry.value.job.jobId : `rejected ${entry.reason?.code}`))

  // -------------------------------------------------------------------------
  // 4. Idempotency under concurrency — stated as measured
  // -------------------------------------------------------------------------
  const keyed = () => studio.applyScenePatch({
    projectId: 'contended',
    baseRevision: 'r0002',
    operations: [lens(60)],
    note: 'concurrency: same key from two callers',
    idempotencyKey: 'concurrency-suite-key',
    saveCheckpoint: false,
  })

  const duplicates = await Promise.allSettled([keyed(), keyed()])
  const committed = duplicates.filter(entry => entry.status === 'fulfilled')
  const conflicted = duplicates.filter(entry => entry.status === 'rejected')

  check('two simultaneous submissions of ONE idempotency key create one revision, not two',
    committed.length === 1 && (await studio.getProject('contended')).revisions.length === 3,
    { committed: committed.length, revisions: (await studio.getProject('contended')).revisions.length })
  check('the simultaneous duplicate is refused rather than applied twice',
    conflicted[0]?.reason?.code === 'REVISION_CONFLICT', conflicted[0]?.reason?.code ?? '(no rejection)')

  // The stronger promise, and the one the README actually makes: a retry AFTER the
  // first attempt has been recorded returns that attempt's result instead of making a
  // second revision. Stated here because the concurrent case above does NOT replay —
  // it conflicts — and a test that claimed otherwise would be asserting a guarantee
  // the implementation does not offer (D85).
  const retry = await keyed()
  check('a SEQUENTIAL retry of the same key returns the recorded result instead of committing again',
    retry.idempotentReplay === true && retry.revision === committed[0].value.revision,
    { replayed: retry.idempotentReplay, revision: retry.revision, first: committed[0].value.revision })
  check('so the key still did its job: three submissions, three revisions total',
    (await studio.getProject('contended')).revisions.length === 3,
    (await studio.getProject('contended')).revisions.map(entry => entry.revision))

  // -------------------------------------------------------------------------
  // 5. The structural half: nothing publishes into the root realm
  // -------------------------------------------------------------------------
  //
  // The service half of "no service conflict" is not a runtime accident — it is the
  // `isolate` realm on every group a preset mounts. `dsh-agent-presets` refuses a
  // service row that has none, and this asserts the property before a mount has to.
  const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot')
  for (const preset of ['deepblend', 'deepblend-dev']) {
    const rows = loadOverlayPatches(
      `concurrency-${preset}`,
      join(PROJECT_ROOT, 'deepblend', 'presets', preset, 'agent.cordis.yml'),
    )
    const groups = rows.filter(row => row.group === true)
    check(`${preset}: every group carries an isolate realm, so no row publishes into the root realm`,
      groups.length > 0 && groups.every(group => group.isolate !== undefined && Object.keys(group.isolate).length > 0),
      groups.map(group => `${group.id}:${Object.keys(group.isolate ?? {}).join('+') || 'NONE'}`))
    check(`${preset}: the tool row publishes nothing, which is what makes two sessions safe to run at once`,
      rows.some(row => row.id === 'deepblend-tool') && !rows.some(row => row.id === 'deepblend-tool' && row.isolate !== undefined))
  }
} catch (cause) {
  check('the concurrency suite completed without an unexpected throw', false, cause?.stack ?? String(cause))
} finally {
  await root.stop?.()
  rmSync(scratch, { recursive: true, force: true })
}

const passed = results.filter(entry => entry.ok).length
console.log(`\nM5 concurrency: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
