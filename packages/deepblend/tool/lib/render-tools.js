/**
 * M3 model-visible tools: the persistent delivery render (SPEC §11, §20 M3).
 *
 * Plane: Agent preset. Registers tools into the calling agent's scope and
 * publishes NOTHING — it consumes `blenderStudio` from the Host composition,
 * which is what makes it legal as a preset row (SPEC §4.4).
 *
 * WHY THESE FOUR, AND WHY THEY ARE THE LAST ONES
 * ----------------------------------------------
 * M0/M1/M2 registered ten tools and deliberately left five unregistered, on the
 * rule that **a tool the model can see is a promise the runtime must keep**. Four
 * of the five arrive here, because their host services now exist:
 *
 *   blender_final_render   start (or resume) a delivery render   — §7.2 startFinalRender
 *   blender_export         encode + publish + manifest           — §7.2 exportProject
 *   blender_job_status     read a durable job                    — §7.2 getJob
 *   blender_job_cancel     stop it and prove the process is gone — §7.2 cancelJob
 *
 * `blender_asset_ingest` stays ABSENT: its host service and its approval boundary
 * are M5 (SPEC §15.1), and registering it now would throw on every call.
 *
 * WHAT THE DESCRIPTIONS CARRY, AND WHY THEY ARE SO LONG
 * -----------------------------------------------------
 * A delivery render costs ~3.4 hours on the demo project and produces 424 MiB of
 * frames. The two facts a model must not have to learn by experiment are (a) that
 * `blender_final_render` RETURNS IMMEDIATELY and the work continues in the
 * background, and (b) that an interrupted render is resumed by calling the SAME
 * tool with `resumeJobId`, which renders only the frames that are missing. Both
 * are in the description text because the parameter schema cannot say them.
 *
 * Owner: DeepBlend Studio — M3
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { BlenderErrorCode, HOST_API_VERSION, warning } from '@deepblend/dsh-blender-contracts'

import {
  TOOL_OUTPUT,
  canonicalCall,
  definedFields,
  renderFailure,
  renderSuccess,
  requestApproval,
  resolveStudio,
} from './shared.js'

/**
 * Register every M3 DeepBlend tool for the calling agent scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function applyRenderTools(ctx) {
  ctx.tools.register(finalRender(ctx))
  ctx.tools.register(exportDelivery(ctx))
  ctx.tools.register(jobStatus(ctx))
  ctx.tools.register(jobCancel(ctx))
}


/**
 * Refuse, in words, when the host half in this process is older than the tools.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT DEFENSIVE PADDING
 * ----------------------------------------------------
 * A host SERVICE instance lives in the process that constructed it, and Node's ESM
 * module cache is process-level: updating the packages on disk does not update the
 * `blenderStudio` that is already running. So there is a real deployment state where
 * the tool plane is new and the host plane is not — and in that state every M3 tool
 * would call a method that does not exist and fail with a `TypeError` wearing a
 * `BLENDER_SCRIPT_ERROR` label. That is the worst kind of error here: a stable code
 * that names the wrong problem.
 *
 * WHY IT ASKS FOR A VERSION INSTEAD OF LOOKING FOR METHODS
 * --------------------------------------------------------
 * The first version of this guard probed for the M3-only methods by `typeof`, and it
 * was WRONG in a way worth recording. It caught `resumeRenderJob`, `listJobs` and
 * `reconcileRenderJobs` — those are simply absent on the old host — and it MISSED
 * `startFinalRender` and `exportProject`, because M1 implemented those as stubs and
 * so `typeof` is `'function'` on both the old and the new host. The guard therefore
 * covered four of six entry points and silently let through the two that would have
 * failed worst. `deepblend/tests/contract/host-plane-staleness.test.mjs` now asserts
 * all six, which is how the gap was found.
 *
 * The missing method is a property of the DEPLOYMENT, not of the request, so it is
 * reported as one, with the fix.
 *
 * @param {object} studio the resolved host service
 * @param {string[]} methods the M3 methods this tool needs, named in the diagnosis
 * @returns {{text: string, data: object}|null} a refusal, or null when the host is current
 */
function hostPlaneIsCurrent(studio, methods) {
  const version = typeof studio.hostApiVersion === 'function' ? studio.hostApiVersion() : 0
  if (Number.isFinite(version) && version >= HOST_API_VERSION) return null

  // Named when they can be named, because "which methods are missing" is the useful
  // half of the diagnosis for a human deciding whether to restart. Absence is not
  // always detectable (see above), so this list is evidence, never the test.
  const missing = methods.filter(name => typeof studio[name] !== 'function')
  const versionText = Number.isFinite(version) && version > 0 ? `host API ${version}` : 'no host API version'
  return {
    text:
      `DeepBlend host services are present but too OLD for this tool.\n` +
      `errorCode: ${BlenderErrorCode.RUNTIME_UNAVAILABLE}\n` +
      `message:   this tool needs host API ${HOST_API_VERSION}, and the running blenderStudio service reports ` +
      `${versionText}${missing.length > 0 ? ` and has no ${missing.join(', ')}` : ''}. The packages on disk are ` +
      'newer than the host service in this process, which is expected after an upgrade and before a profile ' +
      'restart: a Cordis service keeps the code it was constructed from.\n' +
      'fix:       restart the profile (`dsh web`) and open a new session.',
    data: {
      ok: false,
      errorCode: BlenderErrorCode.RUNTIME_UNAVAILABLE,
      message:
        `the running blenderStudio service is host API ${version || 'pre-M3'} and this tool needs ` +
        `${HOST_API_VERSION}; restart the profile`,
      detail: {
        requiredHostApiVersion: HOST_API_VERSION,
        reportedHostApiVersion: Number.isFinite(version) ? version : null,
        missingMethods: missing,
        fix: 'restart the dsh profile',
      },
    },
  }
}

/**
 * Render the shared body of a job report as prose a model can act on.
 *
 * WHY IT IS EXPORTED: it is the block a model reads when it asks about a job, so it is where a
 * recorded fact either reaches the reader or dies. The alternative to exporting it is a rule whose
 * only exercise is a real render through a running Host — the same trade `frame-ledger.js` records
 * for `sampleFrame`, and the same failure mode: a rule that can only fail in production is a rule
 * nobody has checked. `contract/render-job.test.mjs` drives it directly, including the negative
 * control (a job with no warnings prints no warning line).
 *
 * @param {object} job
 * @returns {string[]}
 */
export function describeJobLines(job) {
  const lines = [
    `job:      ${job.jobId}${job.dshJobId !== null && job.dshJobId !== undefined ? ` (DSH job ${job.dshJobId})` : ''}`,
    `project:  ${job.projectId} @ ${job.revisionId}`,
    `status:   ${job.status}`,
    `frames:   ${job.completedFrames}/${job.expectedFrames} complete (${job.percent}%) in range ${job.frameStart}..${job.frameEnd}`,
  ]
  if (job.pid !== null && job.pid !== undefined) lines.push(`pid:      ${job.pid}`)
  if (job.meanMsPerFrame !== null && job.meanMsPerFrame !== undefined) {
    const remaining = job.estimatedRemainingMs === null || job.estimatedRemainingMs === undefined
      ? 'unknown'
      : `${Math.round(job.estimatedRemainingMs / 1000)} s`
    lines.push(`speed:    ${(job.meanMsPerFrame / 1000).toFixed(1)} s/frame, ~${remaining} remaining`)
  }
  if (Array.isArray(job.corruptFrames) && job.corruptFrames.length > 0) {
    lines.push(
      `incomplete frames: ${job.corruptFrames
        .slice(0, 8)
        .map(entry => `${entry.frame} (${entry.reason})`)
        .join(', ')}${job.corruptFrames.length > 8 ? `, +${job.corruptFrames.length - 8} more` : ''}`,
    )
  }
  if (job.errorCode !== null && job.errorCode !== undefined) lines.push(`errorCode: ${job.errorCode}`)
  if (job.message !== null && job.message !== undefined) lines.push(`message:  ${job.message}`)
  if (job.delivery !== null && job.delivery !== undefined) {
    lines.push(`delivery: ${job.delivery.status}${job.delivery.videoPath ? ` -> ${job.delivery.videoPath}` : ''}`)
  }
  if (job.recovery !== null && job.recovery !== undefined) {
    lines.push('recovery: this job was found unfinished when the host started; its ledger was rebuilt from the frames on disk')
    for (const note of job.recovery.notes ?? []) lines.push(`  - ${note}`)
  }
  // The record's own warnings, shown HERE because this list is the only place a human or a model reads
  // a job's state. MEASURED defect: `JOB_PROJECTION_UNAVAILABLE` has been written onto job records
  // since M3 and nothing ever displayed it — a fact recorded and never read is a fact not recorded,
  // minus the disk space. Appended last, after the numbers, because a warning does not change what
  // the job did.
  if (Array.isArray(job.warnings) && job.warnings.length > 0) {
    for (const entry of job.warnings) lines.push(`warning:  [${entry.code}] ${entry.message}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// blender_final_render
// ---------------------------------------------------------------------------

function finalRender(ctx) {
  return defineTool({
    name: 'blender_final_render',
    description:
      'Start a DELIVERY render: every frame of the project\'s range (or a sub-range you name) at the ' +
      'SceneSpec\'s "final" render profile, then encode it to MP4 and publish the delivery package. ' +
      'This is the expensive operation — measured on this machine at 19.6-41.4 s PER FRAME for a ' +
      '1920x1080 / Cycles / 256-sample delivery, so a 450-frame animation is about 3.4 hours. ' +
      '\n\nIt RETURNS IMMEDIATELY with a jobId; the render continues in the background while you keep ' +
      'working. Poll it with blender_job_status, which also works after the harness has been restarted. ' +
      '\n\nIF A RENDER WAS INTERRUPTED (harness restart, crash, cancellation), call this tool again with ' +
      '`resumeJobId` set to that job. It reads which frames are actually complete on disk and renders ONLY ' +
      'the missing or incomplete ones, so resuming a 400-of-450 render costs 50 frames, not 450. Frames ' +
      'left half-written by a kill are detected and re-rendered rather than kept. ' +
      '\n\nA project may have only ONE delivery render at a time: a second start is refused with ' +
      'RENDER_JOB_CONFLICT until the first is finished, cancelled, or resumed.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project to render.' },
      resumeJobId: {
        type: 'string',
        description:
          'Resume this interrupted render instead of starting a new one. The job must belong to the same ' +
          'project. Only the missing frames are rendered. Use blender_job_status to find unfinished jobs.',
      },
      revision: {
        type: 'string',
        description: 'Revision to render. Defaults to the project\'s current revision.',
      },
      frameStart: { type: 'number', description: 'First frame. Defaults to the project\'s own frameStart.' },
      frameEnd: { type: 'number', description: 'Last frame (inclusive). Defaults to the project\'s own frameEnd.' },
      frames: {
        type: 'array',
        items: { type: 'number' },
        description:
          'An explicit list of frames instead of a contiguous range — useful for a spot check of a few ' +
          'expensive frames. Frames outside the project\'s own range are dropped with a warning.',
      },
      cameraId: { type: 'string', description: 'Camera to render from. Defaults to the camera with role "active-camera".' },
      profileName: { type: 'string', description: 'SceneSpec render profile name. Defaults to "final".' },
      samples: {
        type: 'number',
        description:
          'Override the profile\'s sample count. The profile\'s own maxSamplesBudget is the ceiling; the ' +
          'preview sample budget deliberately does not apply to a delivery render.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) {
        return { ok: false, text: `Delivery render unavailable.\n${resolved.unavailable.text}`, data: resolved.unavailable.data }
      }
      try {
        if (typeof args?.resumeJobId === 'string' && args.resumeJobId.length > 0) {
          const stale = hostPlaneIsCurrent(resolved.studio, ['resumeRenderJob', 'getJob'])
          if (stale !== null) return { ok: false, ...stale }
          const { data, canonicalWarnings } = await canonicalCall(
            resolved.studio.resumeRenderJob(definedFields({
              projectId: args.projectId,
              jobId: args.resumeJobId,
              signal: exec?.signal,
            })),
            warning,
          )
          const job = await resolved.studio.getJob({ projectId: data.projectId, jobId: data.jobId })
          const notes = [
            `already complete: ${data.alreadyComplete} frame(s)`,
            `resuming:         ${data.resumed} frame(s)${data.resumedFrames?.length ? ` -> ${summarizeFrames(data.resumedFrames)}` : ''}`,
            data.corrupt?.length > 0
              ? `re-rendering:     ${data.corrupt.length} incomplete frame(s): ` +
                data.corrupt.map(entry => `${entry.frame} (${entry.reason})`).join(', ')
              : null,
            '',
            ...describeJobLines(job.renderJob),
          ].filter(line => line !== null)
          return {
            ok: true,
            text: renderSuccess(
              `Resumed render job ${data.jobId} for ${data.projectId}/${data.revision}.`,
              data,
              { notes: [...notes, ...canonicalWarnings.map(entry => `[${entry.code}] ${entry.message}`)], warnings: data.warnings ?? [] },
            ),
            data: { ...data, job: job.renderJob },
          }
        }

        const stale = hostPlaneIsCurrent(resolved.studio, ['startFinalRender', 'listJobs', 'getJob'])
        if (stale !== null) return { ok: false, ...stale }

        const startRequest = {
          projectId: args.projectId,
          revision: args.revision,
          frameStart: args.frameStart,
          frameEnd: args.frameEnd,
          frames: args.frames,
          cameraId: args.cameraId,
          profileName: args.profileName,
          samples: args.samples,
        }

        let started
        try {
          started = await canonicalCall(resolved.studio.startFinalRender(definedFields(startRequest)), warning)
        } catch (cause) {
          // ── the approval gate (SPEC §15.1, architecture-decisions Q7) ────────
          //
          // The HOST refuses an over-threshold render that arrives without a grant,
          // which is where the enforcement has to live: the workbench starts renders
          // too, and a control only one of two callers respects is not a control.
          // What this plane adds is the means to ANSWER it — `ctx.approval.request`
          // needs a live Agent and an open turn, and a tool call is the one place
          // that has both.
          if (cause?.code !== BlenderErrorCode.RENDER_APPROVAL_REQUIRED) throw cause

          const approval = await requestApproval(ctx, exec, {
            toolName: 'blender_final_render',
            refusalCode: 'RENDER_APPROVAL_REFUSED',
            // THE REVISION IS PART OF WHAT IS BEING APPROVED. The refusal computed its frame plan for one
            // revision, and without this the prompt said "300 frames" while the human had no way to see WHICH
            // scene those frames were of — and the re-issue below could resolve a newer revision, so the render
            // they approved and the render that ran were not necessarily the same thing.
            detail: {
              frames: cause.detail?.frames ?? null,
              threshold: cause.detail?.threshold ?? null,
              revision: cause.detail?.revision ?? null,
            },
            reason:
              `Start a DELIVERY render of ${cause.detail?.frames ?? 'an unknown number of'} frame(s)` +
              `${cause.detail?.frameStart != null && cause.detail?.frameEnd != null
                ? ` (${cause.detail.frameStart}..${cause.detail.frameEnd})`
                : ''}${cause.detail?.revision == null ? '' : ` of revision ${cause.detail.revision}`}` +
              `, above the configured approval threshold of ${cause.detail?.threshold ?? '?'}. ` +
              'Measured cost on the reference machine: 19.6-41.4 s per frame at 1920x1080 / Cycles / 256 ' +
              'samples, so this is hours of machine time.',
            refusal:
              `Nothing was started — no job, no frames. The request was for ${cause.detail?.frames ?? '?'} ` +
              `frame(s), above the threshold of ${cause.detail?.threshold ?? '?'}. Options: ask the operator ` +
              'again, render a smaller range to check the scene first, or have the operator raise ' +
              '`requireApprovalAboveFrames` for this deployment.',
          })
          if (approval.granted !== true) return { ok: false, ...approval.refusal }

          // `approved` is set HERE and nowhere else. It is deliberately NOT a tool
          // parameter: a model able to write `approved:true` would be approving its
          // own spending, and the point of the threshold is that someone else
          // decides. The only route to this line is an `'allowed-once'` outcome.
          // PINNED TO THE REVISION THAT WAS APPROVED. `startRequest.revision` is often absent (the schema
          // documents it as "defaults to the project's current revision"), so re-issuing the same request after
          // an approval that took human time could render a revision nobody approved — a patch landing in
          // between is enough. The refusal names the revision it measured, and that is the one this renders.
          const approvedRevision = cause.detail?.revision ?? startRequest.revision
          started = await canonicalCall(
            resolved.studio.startFinalRender(definedFields({
              ...startRequest,
              ...approvedRevision === undefined ? {} : { revision: approvedRevision },
              approved: true,
            })),
            warning,
          )
        }
        const { data, canonicalWarnings } = started
        return {
          ok: true,
          text: renderSuccess(
            `Delivery render started: ${data.jobId} (${data.frames} frame(s), ${data.frameStart}..${data.frameEnd}).`,
            data,
            {
              notes: [
                'This call has already returned; the frames are rendering in the background.',
                `Next: blender_job_status {projectId: "${data.projectId}", jobId: "${data.jobId}"} to watch it.`,
                `If it is interrupted: blender_final_render {projectId: "${data.projectId}", resumeJobId: "${data.jobId}"} ` +
                  'renders only the frames that are still missing.',
              ],
              warnings: [...(data.warnings ?? []), ...canonicalWarnings],
            },
          ),
          data,
        }
      } catch (cause) {
        return { ok: false, ...renderFailure(cause, 'BLENDER_SCRIPT_ERROR') }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args?.resumeJobId !== undefined
        ? `Resume delivery render ${args.resumeJobId}`
        : `Render delivery for "${args?.projectId ?? ''}"`,
      kind: 'edit',
    }),
  })
}

// ---------------------------------------------------------------------------
// blender_export
// ---------------------------------------------------------------------------

function exportDelivery(ctx) {
  return defineTool({
    name: 'blender_export',
    description:
      'Encode and publish the delivery package for a render whose frames already exist: H.264 MP4 into ' +
      'output/final.mp4, a verified delivery-manifest.json into output/, and the render manifest under ' +
      'renders/. It spends NO Blender time — use it to re-encode after a settings change, to re-publish a ' +
      'package whose manifest was lost, or to build the video for a render another session finished. ' +
      '\n\nIt refuses with RENDER_FRAMES_INCOMPLETE when frames are missing or were left half-written by a ' +
      'kill, naming how many are owed; continue those with blender_final_render {resumeJobId}. ' +
      '\n\nEvery property in the manifest is MEASURED with ffprobe after encoding and compared against what ' +
      'the job claimed. A mismatch fails the export with ENCODE_VERIFY_FAILED and publishes nothing, rather ' +
      'than shipping a video whose duration or frame count disagrees with its own manifest.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project whose frames should be packaged.' },
      jobId: {
        type: 'string',
        description: 'The render job whose frames to encode. Defaults to the newest job with a complete frame set.',
      },
      revision: { type: 'string', description: 'Restrict the default job search to this revision.' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) {
        return { ok: false, text: `Delivery export unavailable.\n${resolved.unavailable.text}`, data: resolved.unavailable.data }
      }
      try {
        const stale = hostPlaneIsCurrent(resolved.studio, ['exportProject', 'getJob'])
        if (stale !== null) return { ok: false, ...stale }
        const { data, canonicalWarnings } = await canonicalCall(
          resolved.studio.exportProject(definedFields({
            projectId: args?.projectId,
            jobId: args?.jobId,
            revision: args?.revision,
          })),
          warning,
        )
        return {
          ok: data.verified === true,
          text: data.verified === true
            ? renderSuccess(`Delivery published for ${data.projectId} @ ${data.revision}.`, data, { warnings: canonicalWarnings })
            : `Delivery encoded but NOT published: its properties disagree with the job's own claims.\n` +
              `${JSON.stringify(data.problems, null, 2)}\n\nCanonical JSON:\n${JSON.stringify(data, null, 2)}`,
          data,
        }
      } catch (cause) {
        return { ok: false, ...renderFailure(cause, 'BLENDER_SCRIPT_ERROR') }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Package the delivery for "${args?.projectId ?? ''}"`,
      kind: 'edit',
    }),
  })
}

// ---------------------------------------------------------------------------
// blender_job_status
// ---------------------------------------------------------------------------

function jobStatus(ctx) {
  return defineTool({
    name: 'blender_job_status',
    description:
      'Read DeepBlend render jobs from the durable store. Without jobId it lists the project\'s jobs — ' +
      'newest last — and reports which are unfinished, which is how an interrupted render is found after a ' +
      'harness restart. With jobId it reports one job in detail: status, how many frames are complete out ' +
      'of how many, the measured seconds per frame and the estimated time remaining, the frames that are ' +
      'missing or were left incomplete, and the delivery package once one exists. ' +
      '\n\nThis reads from DISK, not from the current process, so it answers correctly for a render started ' +
      'before the harness restarted. Progress is counted from the frame files themselves. ' +
      '\n\nAny warnings recorded on the job are printed with it. They are NOT errors and none of them ' +
      'changes the numbers: JOURNAL_INCOMPLETE means an attempt was cut off mid-line in its event journal, ' +
      'which is why the progress above is counted from the frame files rather than from that journal.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project to inspect.' },
      jobId: { type: 'string', description: 'One render job id. Omit to list the project\'s jobs.' },
      limit: { type: 'number', description: 'When listing, return at most this many of the newest jobs.' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) {
        return { ok: false, text: `Job status unavailable.\n${resolved.unavailable.text}`, data: resolved.unavailable.data }
      }
      try {
        if (typeof args?.jobId === 'string' && args.jobId.length > 0) {
          const stale = hostPlaneIsCurrent(resolved.studio, ['getJob'])
          if (stale !== null) return { ok: false, ...stale }
          const { data, canonicalWarnings } = await canonicalCall(
            resolved.studio.getJob({ projectId: args.projectId, jobId: args.jobId }),
            warning,
          )
          const lines = data.renderJob !== undefined ? describeJobLines(data.renderJob) : [`job: ${data.jobId}`, `status: ${data.status}`]
          return {
            ok: true,
            text: renderSuccess(`Job ${data.jobId}.`, data, { notes: lines, warnings: canonicalWarnings }),
            data,
          }
        }
        const stale = hostPlaneIsCurrent(resolved.studio, ['listJobs'])
        if (stale !== null) return { ok: false, ...stale }
        const { data, canonicalWarnings } = await canonicalCall(
          resolved.studio.listJobs(definedFields({ projectId: args?.projectId, limit: args?.limit })),
          warning,
        )
        const lines = data.jobs.length === 0
          ? ['This project has no render jobs yet. Start one with blender_final_render.']
          : data.jobs.flatMap(job => describeJobLines(job).map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`)))
        if (data.unfinished.length > 0) {
          lines.push('')
          lines.push(`Unfinished: ${data.unfinished.join(', ')} — continue with blender_final_render {resumeJobId}.`)
        }
        if (data.recoveryError !== null && data.recoveryError !== undefined) {
          lines.push('')
          lines.push(`Restart reconciliation reported an error: ${data.recoveryError}`)
        }
        return {
          ok: true,
          text: renderSuccess(`${data.jobs.length} render job(s) for ${data.projectId}.`, data, { notes: lines, warnings: canonicalWarnings }),
          data,
        }
      } catch (cause) {
        return { ok: false, ...renderFailure(cause, 'BLENDER_SCRIPT_ERROR') }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args?.jobId !== undefined ? `Read job ${args.jobId}` : `List jobs of "${args?.projectId ?? ''}"`,
      kind: 'read',
    }),
  })
}

// ---------------------------------------------------------------------------
// blender_job_cancel
// ---------------------------------------------------------------------------

function jobCancel(ctx) {
  return defineTool({
    name: 'blender_job_cancel',
    description:
      'Cancel a running delivery render and STOP ITS BLENDER PROCESS, including a renderer left behind by a ' +
      'previous harness process. The result reports whether the process is actually GONE, measured after ' +
      'the signal rather than assumed from sending one: cancellation that leaves a renderer writing frames ' +
      'is not cancellation. ' +
      '\n\nFrames already rendered are kept and the job is marked cancelled; if you later want the delivery, ' +
      'start with blender_final_render {resumeJobId} and only the missing frames will be rendered. ' +
      'Cancelling an already-finished job is a no-op that says so, not an error.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project the job belongs to.' },
      jobId: { type: 'string', required: true, description: 'The render job to cancel.' },
      reason: { type: 'string', description: 'Recorded verbatim in the job record and the harness job log.' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) {
        return { ok: false, text: `Job cancellation unavailable.\n${resolved.unavailable.text}`, data: resolved.unavailable.data }
      }
      try {
        const stale = hostPlaneIsCurrent(resolved.studio, ['cancelJob'])
        if (stale !== null) return { ok: false, ...stale }
        const { data, canonicalWarnings } = await canonicalCall(
          resolved.studio.cancelJob(definedFields({
            projectId: args?.projectId,
            jobId: args?.jobId,
            reason: args?.reason,
          })),
          warning,
        )
        const notes = [
          data.cancelled
            ? `Cancel requested: ${data.reason}`
            : `Nothing to cancel: ${data.reason}`,
          `process gone: ${data.processGone === true ? 'yes (verified)' : 'NO — a renderer is still alive; do not start another render for this project'}`,
          `frames kept: ${data.completedFrames ?? 0}`,
        ]
        if (data.process?.term !== undefined) notes.push(`signal: ${data.process.term}${data.process.kill ? ` then ${data.process.kill}` : ''}`)
        return {
          ok: data.processGone !== false,
          text: renderSuccess(`Job ${data.jobId}: ${data.status}.`, data, { notes, warnings: canonicalWarnings }),
          data,
        }
      } catch (cause) {
        return { ok: false, ...renderFailure(cause, 'BLENDER_SCRIPT_ERROR') }
      }
    },
    presentCall: args => ({ card: 'generic', title: `Cancel job ${args?.jobId ?? ''}`, kind: 'edit' }),
  })
}

/** `[1, 2, 3, … 450]` -> `1-3, … 450`, so a 450-frame list does not flood a result. */
function summarizeFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return ''
  if (frames.length <= 8) return frames.join(', ')
  return `${frames.slice(0, 6).join(', ')}, … +${frames.length - 6} more`
}
