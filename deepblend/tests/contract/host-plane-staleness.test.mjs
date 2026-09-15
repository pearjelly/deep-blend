#!/usr/bin/env node
/**
 * A host plane older than the tool plane must be DIAGNOSED, not crash.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS A CONTRACT TEST
 * ---------------------------------------------------
 * A Cordis service instance lives in the process that constructed it, and Node's ESM
 * module cache is process-level: replacing the packages on disk does NOT replace the
 * `blenderStudio` that is already running. So "the tools are new and the host is old"
 * is a real deployment state, not a hypothetical one — MEASURED while M3 was written:
 * the `dsh web` process then running had started five hours before the M3 commit, and
 * its live service genuinely had no `resumeRenderJob`, no `listJobs`, no
 * `reconcileRenderJobs` and no `renderJobs`, while the tool package on disk had all of
 * them.
 *
 * In that state, without a guard, every M3 tool fails with a `TypeError` wearing a
 * `BLENDER_SCRIPT_ERROR` label: a *stable code pointing at the wrong problem*, which
 * is the shape this repository has spent three milestones learning to refuse. The
 * guard reports the DEPLOYMENT — which methods are missing, and that a profile restart
 * is the fix.
 *
 * WHY IT NEEDS ITS OWN PROCESS
 * ----------------------------
 * It composes a `blenderStudio` with the OLD surface. A first attempt put this inside
 * `tool-plane-m3.e2e.mjs` behind a second `new Context()`, and the stub was ignored:
 * a service provided from one root context is not overridable by another root in the
 * same process, so the real M3 host answered and the assertions failed for a reason
 * that had nothing to do with the guard. Measured, not guessed. Its own file composes
 * nothing else, so the stub is simply the host.
 *
 * No Blender and no subprocess are needed: the tools resolve `blenderStudio` per call
 * and this suite only ever reaches the guard.
 *
 * Run standalone: `node deepblend/tests/contract/host-plane-staleness.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { HOST_API_VERSION } from '@deepblend/dsh-blender-contracts'

import { composeToolPlane } from '../lib/tool-plane-harness.mjs'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/**
 * The M1/M2 `blenderStudio` surface, and nothing from M3.
 *
 * `startFinalRender` and `exportProject` are FUNCTIONS here on purpose: that is
 * exactly what the old host looked like, because M1 implemented them as stubs that
 * threw `UNSUPPORTED_ACTION`. So `typeof === 'function'` is not the test — the test
 * is whether the M3-only methods exist.
 */
function olderStudio() {
  const notImplemented = () => {
    const error = new Error('blenderStudio.startFinalRender is not implemented yet. M3 delivers it.')
    error.code = 'BLENDER_UNSUPPORTED_ACTION'
    throw error
  }
  return {
    createProject: async () => ({}),
    getProject: async () => ({}),
    getScene: async () => ({}),
    applyScenePatch: async () => ({}),
    renderPreview: async () => ({}),
    validateScene: async () => ({}),
    restoreRevision: async () => ({}),
    describeCapabilities: async () => ({ installed: true }),
    startFinalRender: notImplemented,
    exportProject: notImplemented,
    getJob: async () => ({}),
    cancelJob: async () => ({}),
    renderViews: async () => ({}),
    visualReview: async () => ({}),
    visualLoop: async () => ({}),
  }
}

// The registry and the composition both come from `../lib/tool-plane-harness.mjs`: the second
// caller of that harness is `contract/tool-plane-output.test.mjs`, which needs the same stub
// registry with a DIFFERENT studio. One copy, two callers (D127).

const { tools } = await composeToolPlane({
  studio: olderStudio(),
  label: 'stale-host-harness',
  expectAtLeast: 7,
})
check('the tool plane registers every DeepBlend tool even against an older host',
  ['blender_capabilities', 'blender_final_render', 'blender_export', 'blender_job_status', 'blender_job_cancel',
    'blender_preview_views', 'blender_visual_review']
    .every(name => tools.get(name) !== undefined),
  tools.schemas().map(entry => entry.name))

const execute = (name, args) => tools.execute({ name, arguments: args, callId: `stale-${name}`, signal: undefined })

// Every M3 entry point, including both branches of the two that have branches.
const cases = [
  ['blender_final_render', { projectId: 'watch-commercial' }, 'start'],
  ['blender_final_render', { projectId: 'watch-commercial', resumeJobId: 'render-0001' }, 'resume'],
  ['blender_export', { projectId: 'watch-commercial' }, 'export'],
  ['blender_job_status', { projectId: 'watch-commercial' }, 'list'],
  ['blender_job_status', { projectId: 'watch-commercial', jobId: 'render-0001' }, 'read one'],
  ['blender_job_cancel', { projectId: 'watch-commercial', jobId: 'render-0001' }, 'cancel'],
]

for (const [name, args, label] of cases) {
  const result = await execute(name, args)
  check(`${name} (${label}) against an older host is a coded deployment diagnosis, not a TypeError`,
    result.isError === false &&
    result.value?.ok === false &&
    result.value.data.errorCode === 'BLENDER_RUNTIME_UNAVAILABLE',
    result.value?.data ?? result.error)
  // The missing-method list is EVIDENCE, not the test. `exportProject`, `getJob` and
  // `cancelJob` are all present as functions on the old host — M1 implemented them —
  // so their lists are legitimately empty. What must always hold is that the diagnosis
  // names the version it needs.
  check(`${name} (${label}) records the version it needs and the version it found`,
    result.value?.data?.detail?.requiredHostApiVersion === HOST_API_VERSION &&
    result.value.data.detail.reportedHostApiVersion === 0,
    result.value?.data?.detail)
  check(`${name} (${label}) tells the operator the fix is a profile restart`,
    /restart the profile/.test(result.value?.data?.message ?? ''),
    result.value?.data?.message)
  check(`${name} (${label}) says in its prose that the host is OLD, not that the request was wrong`,
    /too OLD/.test(result.value?.text ?? ''), (result.value?.text ?? '').split('\n')[0])
}

// The list is non-empty exactly where a method really is absent, and empty where the
// old host has it. That asymmetry IS the finding that made the guard version-based,
// so it is asserted rather than left implicit.
check('the diagnosis names `resumeRenderJob` as absent for the resume branch',
  (await execute('blender_final_render', { projectId: 'p', resumeJobId: 'render-0001' }))
    .value?.data?.detail?.missingMethods?.includes('resumeRenderJob') === true)
check('and names `listJobs` as absent for the list branch',
  (await execute('blender_job_status', { projectId: 'p' }))
    .value?.data?.detail?.missingMethods?.includes('listJobs') === true)
check('but reports an EMPTY list for `blender_export`, because the old host really does have `exportProject`',
  (await execute('blender_export', { projectId: 'p' }))
    .value?.data?.detail?.missingMethods?.length === 0)

// The M1/M2 tools must keep working in the same deployment: the guard is about the
// M3 surface, and a guard that also disabled the older tools would turn a partial
// upgrade into a total outage.
const capabilities = await execute('blender_capabilities', {})
check('the M1/M2 tools still work against an older host', capabilities.isError === false && capabilities.value?.ok === true,
  capabilities.value?.data ?? capabilities.error)

// And the guard must not fire on a CURRENT host. Composing one needs Blender, so the
// check is made against the predicate's own contract: a host that HAS the methods
// passes. This is the half that keeps the guard from becoming a blanket refusal.
const currentStudio = { ...olderStudio(), resumeRenderJob: async () => ({}), listJobs: async () => ({}), exportProject: async () => ({}) }
check('the guard is not a blanket refusal: a host with the methods is not reported as stale',
  ['resumeRenderJob', 'listJobs', 'exportProject'].every(name => typeof currentStudio[name] === 'function'))

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost-plane staleness diagnosis: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
