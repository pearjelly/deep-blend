/**
 * M2 model-visible tools: the visual review loop.
 *
 * Plane: Agent preset (SPEC §4.2, §4.3). This module registers tools and publishes
 * NOTHING — it consumes `blenderStudio` from the Host composition.
 *
 * WHO OWNS THE LOOP, AND WHY IT IS SPLIT THIS WAY
 * -----------------------------------------------
 * Three tools, three different jobs, and the split is the design:
 *
 *  `blender_preview_views`  renders the multi-view plan and MEASURES it. No model
 *      call, no repair. This is the cheap observation, and it is what a model uses
 *      when it wants to look at something specific.
 *
 *  `blender_visual_review`  the same, PLUS it asks the vision model what the contact
 *      sheet shows. It returns the measured score, the measured issues, and the
 *      model's OWN findings side by side, with the sheet attached as an image. This
 *      is the tool that makes "the model really sees the preview" checkable: its
 *      `reported` findings are the model's words about pixels only it can read, and
 *      they are validated against the review they claim to describe.
 *
 *  `blender_visual_autofix`  the host-owned repair LOOP: propose, apply, re-render,
 *      re-score, and adopt only what measures better, bounded by the iteration cap
 *      and the repeated-issue rule. It returns a handover package when it stops short
 *      of passing.
 *
 * The alternative — one tool that does everything — was rejected because the score
 * has to stay a function of measurements (decision D30). If the repairing loop also
 * wrote the numbers it is judged by, "the score improved" would be a claim about the
 * model rather than a claim about the render.
 *
 * WHICH TOOLS EXIST, AND WHY ONLY THESE
 * -------------------------------------
 * SPEC §11's `blender_final_render`, `blender_export`, `blender_asset_ingest`,
 * `blender_job_status` and `blender_job_cancel` stay absent rather than
 * registered-and-throwing: a tool the model can see is a promise the runtime must
 * keep, and their host services arrive in M3.
 *
 * Owner: DeepBlend Studio — M2
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { BlenderWarningCode, warning } from '@deepblend/dsh-blender-contracts'

import {
  TOOL_OUTPUT,
  TOOL_OUTPUT_WITH_IMAGE,
  canonicalCall,
  definedFields,
  describeRevision,
  persistImage,
  renderFailure,
  renderSuccess,
  resolveStudio,
} from './shared.js'

/** A short reminder of what the measured facts mean, reused by both visual tools. */
const MEASUREMENT_GLOSSARY =
  'Measured facts per view: mean/p05/p95 display luminance with the clipped-dark and clipped-bright ' +
  'fractions, and per tracked object its silhouette pixel count (how large it would be with nothing in ' +
  'the way), its visible pixel count, the visible fraction (occlusion), its frame coverage, its bounding ' +
  'box and its centroid. These come from the rendered pixels, not from the SceneSpec.'

/**
 * Register the M2 visual tools for the calling agent scope.
 *
 * Registration is fiber-scoped: Cordis disposes it when the preset's subtree
 * unmounts, so no manual teardown is needed.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function applyVisualTools(ctx) {
  ctx.tools.register(previewViews(ctx))
  ctx.tools.register(visualReview(ctx))
  ctx.tools.register(visualAutofix(ctx))
}

// ---------------------------------------------------------------------------
// preview_views
// ---------------------------------------------------------------------------

function previewViews(ctx) {
  return defineTool({
    name: 'blender_preview_views',
    description:
      'Render a MULTI-VIEW preview of a revision in one go: the active camera, a three-quarter angle, a ' +
      'top-down view and a subject close-up, all from one Blender process, and measure each one. Returns ' +
      'the images\' paths, a composed contact sheet, and per-view measurements. Rendering does NOT create a ' +
      'revision — a preview observes a scene rather than changing it — so this is always safe to call and ' +
      'never needs a baseRevision. Use it to look at a scene; use blender_visual_review when you also want a ' +
      'score and a judgment.\n\n' + MEASUREMENT_GLOSSARY,
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: { type: 'string', description: 'Revision to render. Defaults to the current one.' },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Which of the standard views to render, in reading order: "active-camera", "three-quarter", ' +
          '"top", "detail". Omit for the project default. A role with no camera assigned to it is skipped.',
      },
      frame: {
        type: 'integer',
        description:
          'Frame for every view. Defaults to the MIDDLE of the frame range, which for a turntable is far ' +
          'more informative than the first frame. All views share one frame so they can be compared.',
      },
      width: { type: 'integer', description: 'Override the preview width in pixels.' },
      height: { type: 'integer', description: 'Override the preview height in pixels.' },
      samples: {
        type: 'integer',
        description: 'Override the preview profile\'s sample count; a value above the configured budget is reduced and reported.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.renderViews({
          ...definedFields({
            projectId: args.projectId,
            revision: args.revision,
            roles: args.roles,
            frame: args.frame,
            width: args.width,
            height: args.height,
            samples: args.samples,
          }),
          signal: exec.signal,
        }), warning)
        const scored = resolved.studio.scoreVisualViews({ views: data.views, subjectId: data.subjectId })
        const notes = [
          `Revision: ${data.revision}`,
          `Subject:  ${data.subjectId ?? '(none tagged)'}`,
          `Engine:   ${data.profile?.blenderEngine ?? data.profile?.engine}`,
          `Measured score: ${scored.score}/100`,
          '',
          'Views:',
        ]
        for (const view of data.views ?? []) {
          notes.push(
            `  ${String(view.viewId).padEnd(15)} ${view.path}  (camera ${view.cameraId}, frame ${view.frame}, ` +
              `${view.width}x${view.height}) — ${view.purpose ?? ''}`,
          )
        }
        const sheet = (data.revisionPreviews ?? data.contactSheets ?? [])
        notes.push('')
        notes.push('The paths are relative to the project directory. The measured score is what the automated')
        notes.push('scorer makes of these pixels; call blender_visual_review to score AND hear what a vision')
        notes.push('model sees on the contact sheet.')
        return {
          ok: true,
          text: renderSuccess(`Rendered ${data.views.length} view(s) of ${data.revision}.`, { ...data, score: scored.score, issues: scored.issues }, { notes, warnings: [...(data.warnings ?? []), ...canonicalWarnings] }),
          data: { ...data, score: scored.score, issues: scored.issues, sheet },
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'PREVIEW_VIEWS_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Render ${Array.isArray(args?.roles) ? args.roles.length : 'the standard'} views of "${args?.projectId ?? ''}"`,
      kind: 'other',
    }),
  })
}

// ---------------------------------------------------------------------------
// visual_review
// ---------------------------------------------------------------------------

function visualReview(ctx) {
  return defineTool({
    name: 'blender_visual_review',
    description:
      'Render the multi-view plan for a revision, measure it, and SHOW IT TO A VISION MODEL. The contact ' +
      'sheet is attached to this result, so you see the same image the reviewer saw. Returns three separate ' +
      'things, and keeping them separate is the point:\n' +
      '  score    — computed by the flight recorder from the pixels. Reproducible. Not an opinion.\n' +
      '  issues   — the measured problems behind that score, each with the number that caused it.\n' +
      '  reported — what the vision model says it SEES on the sheet, in its own words. The model does not ' +
      'control the score; its findings are validated against the review (an unknown view or a missing ' +
      'evidence string is discarded and listed under "rejected").\n' +
      'If the model proposed a ScenePatch, it comes back as `suggestedOperations` for you to review and ' +
      'apply with blender_scene_patch. Nothing is committed by this call.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: { type: 'string', description: 'Revision to review. Defaults to the current one.' },
      roles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Which standard views to render, in reading order. Omit for the project default.',
      },
      frame: { type: 'integer', description: 'Frame for every view. Defaults to the middle of the frame range.' },
      width: { type: 'integer', description: 'Override the preview width.' },
      height: { type: 'integer', description: 'Override the preview height.' },
    },
    output: TOOL_OUTPUT_WITH_IMAGE,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable, image: null }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.visualReview({
          ...definedFields({
            projectId: args.projectId,
            revision: args.revision,
            roles: args.roles,
            frame: args.frame,
            width: args.width,
            height: args.height,
          }),
          consultReviewer: true,
          signal: exec.signal,
        }), warning)

        const sheetPath = data.sheetArtifact?.path
        const bytes = await resolved.studio.readSheetPng(args.projectId, data)
        const persisted = await persistImage(resolved.attachments, bytes, `contact-sheet-${data.revision}.png`)

        const notes = describeReviewNotes(data)
        notes.push('')
        notes.push(MEASUREMENT_GLOSSARY)
        notes.push(
          `Contact sheet: ${sheetPath ?? '(not recorded)'}` +
          `${persisted.image !== null ? ' — also attached to this result as an image.' : '.'}`,
        )
        if (persisted.note !== null) notes.push(persisted.note)

        return {
          ok: true,
          text: renderSuccess(`Visual review of ${data.revision}: ${data.score}/100.`, data, { notes, warnings: [...(data.warnings ?? []), ...canonicalWarnings] }),
          data,
          image: persisted.image,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'VISUAL_REVIEW_FAILED')
        return { ok: false, ...failure, image: null }
      }
    },
    presentCall: args => ({ card: 'generic', title: `Review "${args?.projectId ?? ''}" visually`, kind: 'read' }),
  })
}

/**
 * The two lines that describe ONE measured issue: the finding, then the number behind it.
 *
 * Extracted (round 40) because this pair was written out TWICE — in the review's issue list and in the
 * open-issue list of `blender_visual_autofix` — and a format with two copies drifts silently: the day
 * one gains a clause, the two tools describe the same measurement differently and nothing fails. The
 * mutation run that found it is recorded in `docs/architecture-decisions.md` (D126).
 *
 * @param {{severity: string, code: string, viewId: string, objectId?: string|null, evidence: string}} issue
 * @returns {string[]} the two lines, in reading order
 */
export function describeIssueLines(issue) {
  return [
    `  [${issue.severity}] ${issue.code} in view "${issue.viewId}"${issue.objectId ? ` on "${issue.objectId}"` : ''}`,
    `      ${issue.evidence}`,
  ]
}

/**
 * The block a model reads after a review: the measurement, the measured issues, and what the vision
 * model claimed — with the claims that were DISCARDED named as such.
 *
 * Exported and pure (round 40) for the same reason `describeJobLines` is: this is the text a model
 * acts on, and the coverage reading showed every branch that needs a review WITH findings to be
 * dark, because no suite had ever composed one. A rule reachable only through a real render PLUS a
 * real model call is a rule nobody has checked.
 *
 * @param {object} data - the canonical review result
 * @returns {string[]} the note lines, in reading order
 */
export function describeReviewNotes(data) {
  const reviewerError = data.reviewer?.error
  const reviewerUnavailable = reviewerError !== null && reviewerError !== undefined
  const notes = [
    `Revision: ${data.revision}  (rendered from ${data.checkpointRevision})`,
    `Score:    ${data.score}/100 — ${data.pass ? 'PASSES' : 'does NOT pass'} the delivery threshold`,
    `Subject:  ${data.subjectId ?? '(none tagged)'}`,
    `Parts:    ${(data.parts ?? []).length > 0 ? data.parts.join(', ') + '  (declared subject-part: they ARE the subject, so they cannot be in its way)' : '(none declared; only the subject is judged for occlusion)'}`,
    '',
    'Measured issues:',
  ]
  if (data.issues.length === 0) {
    notes.push('  (none)')
  } else {
    for (const issue of data.issues) notes.push(...describeIssueLines(issue))
  }
  notes.push('')
  if (reviewerUnavailable) {
    notes.push('The vision reviewer could NOT be consulted, so this result has the measurements and the')
    notes.push(`sheet but no second opinion: [${reviewerError.code}] ${reviewerError.message}`)
    notes.push('')
  }
  notes.push('What the vision model reported seeing on the sheet:')
  if ((data.reported ?? []).length === 0) {
    notes.push(reviewerUnavailable ? '  (no reviewer was available)' : '  (nothing that survived validation)')
  } else {
    for (const finding of data.reported) {
      notes.push(
        `  [${finding.severity}] ${finding.category} in view "${finding.viewId}"` +
        `${finding.objectId ? ` on "${finding.objectId}"` : ''} (confidence ${finding.confidence})`,
      )
      notes.push(`      ${finding.evidence}`)
    }
  }
  if ((data.rejected ?? []).length > 0) {
    notes.push('')
    notes.push(`Discarded findings (${data.rejected.length}) — they named something the review does not contain:`)
    for (const entry of data.rejected) notes.push(`  - ${entry.reason}`)
  }
  if ((data.suggestedOperations ?? []).length > 0) {
    notes.push('')
    notes.push(`The reviewer proposed ${data.suggestedOperations.length} ScenePatch operation(s); apply them with`)
    notes.push('blender_scene_patch if you agree, or run blender_visual_autofix to let the host try them.')
  }
  return notes
}

/**
 * The block a model reads after `blender_visual_autofix`: what each round did, what is still open,
 * and — when the loop stopped short — the handover it must work from.
 *
 * Extracted and exported (round 40) for the same reason as `describeReviewNotes`: it is the text a
 * model acts on, it has six branches (a round with and without a new revision, a round with and
 * without a reason, rounds that saw findings, open issues, and a handover with and without tried
 * revisions), and before this extraction no suite could reach one of them without a real repair loop,
 * a real render per round, and a real model call per round.
 *
 * @param {object} data - the canonical loop result
 * @returns {string[]} the note lines, in reading order
 */
export function describeLoopNotes(data) {
  const notes = [
    `Score:    ${data.startScore} -> ${data.finalScore}  (${data.passed ? 'PASSES' : 'still below the threshold'})`,
    `Revision: ${data.startRevision} -> ${data.finalRevision}`,
    `Rounds:   ${data.iterations} of ${data.maxIterations} used`,
    `Stopped:  ${data.stopReason}`,
    '',
    'Round log:',
  ]
  for (const round of data.rounds) {
    const detail = round.newRevision !== null ? ` -> ${round.newRevision}` : ''
    notes.push(
      `  round ${round.round}: ${round.outcome}${detail} — score ${round.score}` +
      `${round.reason !== null ? `, ${round.reason}` : ''}`,
    )
    for (const finding of round.reported ?? []) {
      notes.push(`      saw: [${finding.category}] ${finding.evidence}`)
    }
  }
  if ((data.openIssues ?? []).length > 0) {
    notes.push('')
    notes.push('Still open:')
    for (const issue of data.openIssues) notes.push(...describeIssueLines(issue))
  }
  if (data.handover !== null) {
    notes.push('')
    notes.push('HUMAN/SESSION HANDOVER — the loop stopped short of passing:')
    notes.push(`  reason:   ${data.handover.reason}`)
    notes.push(`  work from: ${data.handover.revision}`)
    if ((data.handover.attemptedRevisions ?? []).length > 0) {
      notes.push(`  tried:     ${data.handover.attemptedRevisions.join(', ')} (kept in the history, not adopted)`)
    }
    notes.push('  next steps:')
    for (const suggestion of data.handover.suggestions) notes.push(`    - ${suggestion}`)
  }
  return notes
}

// ---------------------------------------------------------------------------
// visual_autofix
// ---------------------------------------------------------------------------

function visualAutofix(ctx) {
  return defineTool({
    name: 'blender_visual_autofix',
    description:
      'Run the automated visual repair loop on a revision: review, propose a ScenePatch, commit it, render ' +
      'and measure again, and KEEP the change only if the score actually went up. Stops when the score ' +
      `passes, when the iteration cap is reached, or when the same finding recurs without improving. ` +
      'Because it stops on its own, a handover package comes back whenever it stopped short of passing: the ' +
      'revision to work from (never a polluted one), the open issues with their measurements, and concrete ' +
      'next steps.\n\n' +
      'A round that does not improve the score is rolled back — the revision stays in the history, but the ' +
      'project does not move to a worse one. Every round is reported, including the ones that failed, so you ' +
      'can see what was already tried before proposing another change yourself.\n\n' +
      MEASUREMENT_GLOSSARY,
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: { type: 'string', description: 'Revision to start from. Defaults to the current one.' },
      maxIterations: {
        type: 'integer',
        description: 'Cap on repair rounds. Defaults to the configured maximum (5, per SPEC).',
      },
      minConfidenceForAutoFix: {
        type: 'number',
        description:
          'Findings below this confidence are reported but never auto-applied. Defaults to the configured ' +
          'value (0.8). Raise it to make the loop more conservative.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.visualLoop({
          ...definedFields({
            projectId: args.projectId,
            revision: args.revision,
            maxIterations: args.maxIterations,
            minConfidenceForAutoFix: args.minConfidenceForAutoFix,
          }),
          signal: exec.signal,
        }), warning)
        const notes = describeLoopNotes(data)
        return {
          ok: true,
          text: renderSuccess(
            data.passed
              ? `Visual repair reached ${data.finalScore}/100 on ${data.finalRevision}.`
              : `Visual repair stopped at ${data.finalScore}/100 on ${data.finalRevision}; it needs a human decision.`,
            data,
            { notes, warnings: canonicalWarnings },
          ),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'VISUAL_AUTOFIX_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Auto-fix visuals of "${args?.projectId ?? ''}"`,
      kind: 'write',
    }),
  })
}
