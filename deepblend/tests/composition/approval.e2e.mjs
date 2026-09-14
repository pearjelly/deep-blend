#!/usr/bin/env node
/**
 * M5 — the approval plane that can PREVENT an expensive render (SPEC §15.1, Q7).
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §11 gives `blender_final_render` the permission "达阈值需审批", and until M5 the
 * threshold was only a WARNING attached to a job that had already started. The
 * workbench said so out loud — its approval view carried `plane: "display-only"` —
 * because a panel that merely shows a threshold while looking like a gate is worse
 * than one that admits it is not.
 *
 * Describing a cost is not controlling it. So the gate now lives where the render is
 * started — the host, which is the only place every caller passes through — and this
 * suite asserts the part that matters: **nothing starts when the answer is not yes**.
 *
 * WHY `'allowed-once'` AND NOTHING ELSE
 * ------------------------------------
 * `ctx.approval.request` returns one of `'allowed-once' | 'rejected' | 'cancelled' |
 * 'unavailable'`, and the service documents its own failure direction: a missing or
 * throwing answerer yields `'unavailable'`. Every path below that is not a grant is
 * asserted to refuse — including the two that look most like "we could not ask, so
 * carry on". An unanswered question is not a yes when the question is "may I spend
 * four hours of your machine".
 *
 * The tool's own schema is checked too: there is no `approved` parameter, because a
 * model able to write `approved: true` would be approving its own spending.
 *
 * Run: node deepblend/tests/composition/approval.e2e.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const THRESHOLD = 4

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-approval-'))

/**
 * The tool registry seam, plus a recording approval service.
 *
 * `answer` decides what the operator does: a vocabulary value, or `'missing'` to
 * compose no approval service at all, or `'throws'` for an answerer that fails.
 */
function seams(record, answer) {
  const registered = new Map()
  const registry = {
    name: 'tool-registry-stub',
    apply(ctx) {
      ctx.provide('tools', {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
        get(name) { return registered.get(name) },
        schemas() { return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })) },
        // Dispatch through the definition's own output contract, exactly as the real
        // registry does — including the `exec` a tool sees, which is where `agent`
        // comes from and therefore what `ctx.approval.request` needs.
        async execute(input) {
          const definition = registered.get(input.name)
          if (definition === undefined) throw new Error(`UNKNOWN_TOOL ${input.name}`)
          try {
            const value = await definition.execute(input.arguments ?? {}, {
              ...input,
              def: definition,
              deferContext() {},
              concludeTurn() {},
            })
            return { isError: false, value, content: definition.output.render(input.arguments, value) }
          } catch (error) {
            return {
              isError: true,
              error: { message: error?.message ?? String(error), info: { name: 'BlenderError', code: error?.code ?? 'UNKNOWN' } },
              content: [],
            }
          }
        },
        restrict() { return () => {} },
        guard() { return () => {} },
      })
      if (answer === 'missing') return
      ctx.provide('approval', {
        async request(req) {
          record.asked.push({ toolName: req.toolName, reason: req.reason, hasAgent: req.agent !== undefined })
          if (answer === 'throws') throw new Error('no answerer is composed')
          return answer
        },
      })
    },
  }
  return { registry, registered }
}

/** Call one tool the way the harness does, with an agent identity attached. */
async function callTool(registry, name, args) {
  return registry.execute({
    name,
    arguments: args,
    callId: `call-${name}-${Math.random().toString(16).slice(2, 8)}`,
    signal: undefined,
    agent: { id: 'session-approval-suite' },
  })
}

/** Boot a host + tool plane with the given answerer behaviour. */
async function boot(answer) {
  const record = { asked: [] }
  const { registry, registered } = seams(record, answer)
  const root = new Context()
  root.plugin(registry)
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
    projectsRoot: join(scratch, `projects-${answer}`),
    requireApprovalAboveFrames: THRESHOLD,
  })
  // The tool package is a preset-row plugin — a module namespace carrying
  // name/inject/apply, with no default export.
  root.plugin(await import('@deepblend/dsh-blender-tool'))
  await new Promise(settle => setTimeout(settle, 400))
  return { root, record, registry: root.get('tools'), registered }
}

const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))
spec.renderProfiles.final = { ...spec.renderProfiles.final, resolution: [64, 36], samples: 2 }

/** A project with a checkpoint, in whichever host this case is using. */
async function seed(root, projectId) {
  const studio = root.get('blenderStudio')
  await studio.createProject({
    projectId,
    title: projectId,
    goal: 'Approve or refuse an expensive render.',
    sceneSpec: spec,
    saveCheckpoint: true,
    renderPreview: false,
  })
  return studio
}

const UNDER = [1, 2]
const OVER = [1, 2, 3, 4, 5, 6]

// ---------------------------------------------------------------------------
// 1. The grant path, and the absence of one
// ---------------------------------------------------------------------------
try {
  const granted = await boot('allowed-once')
  try {
    const studio = await seed(granted.root, 'granted')
    const below = await callTool(granted.registry, 'blender_final_render', { projectId: 'granted', frames: UNDER })
    check('a render below the threshold starts without asking anyone',
      below.value?.ok === true && granted.record.asked.length === 0,
      { started: below.value?.data?.jobId, asked: granted.record.asked.length })
    await studio.cancelJob({ projectId: 'granted', jobId: below.value.data.jobId, reason: 'approval suite' })

    const above = await callTool(granted.registry, 'blender_final_render', { projectId: 'granted', frames: OVER })
    check('a render above the threshold asks the approval plane, and starts when it grants',
      above.value?.ok === true && granted.record.asked.length === 1,
      { started: above.value?.data?.jobId, asked: granted.record.asked.length })
    check('the ask names the tool and carries an agent, because an approval is logged against one',
      granted.record.asked[0]?.toolName === 'blender_final_render' && granted.record.asked[0]?.hasAgent === true,
      granted.record.asked[0])
    check('and the reason states the real size and the measured cost, so the human can decide',
      /6 frame/.test(granted.record.asked[0]?.reason ?? '') && /19\.6-41\.4 s per frame/.test(granted.record.asked[0]?.reason ?? ''),
      String(granted.record.asked[0]?.reason ?? '').slice(0, 120))
    check('the job record says this render was approved, rather than only that it was large',
      (above.value?.data?.warnings ?? []).some(entry => entry.detail?.approval === 'granted'),
      (above.value?.data?.warnings ?? []).map(entry => entry.code))
    await studio.cancelJob({ projectId: 'granted', jobId: above.value.data.jobId, reason: 'approval suite' })
  } finally {
    await granted.root.stop?.()
  }
} catch (cause) {
  check('the grant path completed without an unexpected throw', false, cause?.stack ?? String(cause))
}

// ---------------------------------------------------------------------------
// 2. Every answer that is not a grant refuses, and nothing starts
// ---------------------------------------------------------------------------
for (const [answer, label] of [
  ['rejected', 'declined'],
  ['cancelled', 'cancelled'],
  ['unavailable', 'unavailable'],
  ['throws', 'an answerer that throws'],
  ['missing', 'no approval service composed at all'],
]) {
  try {
    const refused = await boot(answer)
    try {
      const studio = await seed(refused.root, 'refused')
      const started = await callTool(refused.registry, 'blender_final_render', { projectId: 'refused', frames: OVER })

      check(`${label}: an over-threshold render is refused with a coded result`,
        started.isError === false && started.value?.ok === false
        && started.value?.data?.errorCode === 'RENDER_APPROVAL_REFUSED',
        started.value?.data?.errorCode ?? started.error?.message ?? '(started anyway)')

      // THE assertion this whole suite exists for. A refusal that still allocated a
      // job would be a warning with extra steps.
      const jobs = await studio.listJobs({ projectId: 'refused' })
      check(`${label}: nothing was started — no job exists`,
        (jobs.jobs ?? []).length === 0,
        (jobs.jobs ?? []).map(entry => `${entry.jobId}:${entry.status}`))

      const project = await studio.getProject('refused')
      check(`${label}: and the project is exactly as it was`,
        project.currentRevision === 'r0001' && (project.jobs ?? []).length === 0,
        { revision: project.currentRevision, jobs: (project.jobs ?? []).length })
    } finally {
      await refused.root.stop?.()
    }
  } catch (cause) {
    check(`${label}: the case completed without an unexpected throw`, false, cause?.stack ?? String(cause))
  }
}

// ---------------------------------------------------------------------------
// 3. The model cannot approve its own spending
// ---------------------------------------------------------------------------
try {
  const schema = await boot('rejected')
  try {
    const definition = schema.registered.get('blender_final_render')
    const properties = Object.keys(definition?.parameters?.properties ?? {})
    check('blender_final_render exposes no `approved` parameter, so a model cannot assert a grant',
      !properties.includes('approved'), properties)

    // A real project, because the tool resolves it before it ever reaches the gate —
    // and a refusal for the WRONG reason would read exactly like the right one.
    const studio = await seed(schema.root, 'bypass')

    // And the refusal must not read as a retryable glitch: it names the outcome and
    // the ways forward, because "refused" with no next step is how a caller ends up
    // retrying the same call.
    const refused = await callTool(schema.registry, 'blender_final_render', { projectId: 'bypass', frames: OVER })
    check('the refusal states that nothing was started',
      /Nothing was started/.test(refused.value?.text ?? ''), String(refused.value?.text ?? '').slice(0, 80))
    check('and it names what to do instead of leaving the caller to retry blindly',
      /raise `requireApprovalAboveFrames`/.test(refused.value?.text ?? '')
      && /smaller range/.test(refused.value?.text ?? ''))

    // The host is the enforcement point, so a caller that bypasses the tool entirely
    // is refused too — the workbench starts renders as well, and a control only one of
    // two callers respects is not a control.
    let bypassCode = null
    try {
      await studio.startFinalRender({ projectId: 'bypass', frames: OVER })
    } catch (error) {
      bypassCode = error?.code
    }
    check('the HOST refuses an over-threshold render that arrives without a grant, so bypassing the tool does not bypass the gate',
      bypassCode === 'RENDER_APPROVAL_REQUIRED', bypassCode ?? '(started)')
    check('and it left no job behind, exactly like the tool-level refusal',
      (await studio.listJobs({ projectId: 'bypass' })).jobs.length === 0)
  } finally {
    await schema.root.stop?.()
  }
} catch (cause) {
  check('the self-approval case completed without an unexpected throw', false, cause?.stack ?? String(cause))
}

rmSync(scratch, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
console.log(`\nM5 approval: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
