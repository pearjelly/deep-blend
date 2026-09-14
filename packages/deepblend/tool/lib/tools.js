/**
 * M1 model-visible tools: the batch SceneSpec loop.
 *
 * Plane: Agent preset (SPEC §4.2, §4.3). This module registers tools and
 * publishes NOTHING — it consumes `blenderStudio` from the Host composition.
 *
 * WHICH TOOLS EXIST, AND WHY ONLY THESE
 * -------------------------------------
 * SPEC §11 lists twelve tools for the finished product. M1 registers six, plus
 * the M0 `blender_capabilities`, and the rule for the gap is the M0 rule:
 * **a tool the model can see is a promise the runtime must keep.** So
 * `blender_final_render`, `blender_export`, `blender_asset_ingest`,
 * `blender_job_status` and `blender_job_cancel` are deliberately absent rather
 * than registered-and-throwing: their host services arrive in M3, and a model
 * that can see `blender_final_render` would reasonably plan around it.
 *
 * WHAT THE TOOL DESCRIPTIONS ARE DOING
 * ------------------------------------
 * They are the API documentation the model actually reads, so they carry the
 * facts a caller cannot discover from the schema: that a write needs the current
 * `baseRevision`, that a stale one is refused rather than merged, that an
 * identical retry is safe, and — most importantly — that `preview_render` needs
 * a `.blend` checkpoint, which is why a patch that should be visible must set
 * `saveCheckpoint`.
 *
 * Owner: DeepBlend Studio — M1
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { SCENE_OPERATION_NAMES, BlenderWarningCode, warning } from '@deepblend/dsh-blender-contracts'

import {
  TOOL_OUTPUT,
  canonicalCall,
  definedFields,
  describeRevision,
  renderFailure,
  renderSuccess,
  resolveStudio,
} from './shared.js'

/** A short parameter description of a SceneSpec engine key. */
const ENGINE_KEY_DESCRIPTION =
  'Render engine: "cycles" (path traced — correct metal, glass and shadows; the default), ' +
  '"eevee" (fast rasterised preview), or "workbench" (solid shading, no materials). ' +
  'If the installed Blender cannot run the requested engine it is downgraded and a warning is returned.'

/** Shared shape for the `sceneSpec` parameter of project_create. */
const SCENE_SPEC_PARAMETER = {
  type: 'object',
  additionalProperties: true,
  description:
    'A complete SceneSpec v1 document to seed the project with. Omit it to start from a minimal, ' +
    'immediately renderable scaffold (one cube, one camera, one area light, both render profiles), ' +
    'then build the scene with blender_scene_patch — that route is usually better, because each patch ' +
    'is a reviewable revision instead of one large opaque document. ' +
    'Top-level keys: schemaVersion, project, assets[], materials[], entities[], lights[], cameras[], ' +
    'shots[], animationTracks[], renderProfiles{preview,final}. ' +
    'A generator entity is `{id,type:"generator",generator:{shape,size|radius|depth|majorRadius|minorRadius,bevel?},' +
    'materialId,transform:{location,rotationEuler,scale}}` where shape is one of ' +
    'cube, rounded_box, uv_sphere, cylinder, cone, plane, torus. Material parameters use Blender 5 socket ' +
    'names: baseColor [r,g,b,a], metallic, roughness, ior, alpha, emissionColor, emissionStrength, ' +
    'coatWeight, transmissionWeight. A camera aims itself at `targetEntityId` (or `targetPoint`) and needs ' +
    '`transform.location` for framing.',
}

/**
 * Register every M1 DeepBlend tool for the calling agent scope.
 *
 * Registration is fiber-scoped: Cordis disposes it when the preset's subtree
 * unmounts, so no manual teardown is needed — and adding one would risk
 * double-disposal on reload.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.tools.register(projectCreate(ctx))
  ctx.tools.register(projectGet(ctx))
  ctx.tools.register(sceneGet(ctx))
  ctx.tools.register(scenePatch(ctx))
  ctx.tools.register(previewRender(ctx))
  ctx.tools.register(sceneValidate(ctx))
  ctx.tools.register(revisionRestore(ctx))
}

// ---------------------------------------------------------------------------
// project_create
// ---------------------------------------------------------------------------

function projectCreate(ctx) {
  return defineTool({
    name: 'blender_project_create',
    description:
      'Create a DeepBlend 3D project and commit its first revision. Returns the projectId and the initial ' +
      'revision id — keep BOTH, because every later write must name the project and the revision it read. ' +
      'Give it the operator\'s brief as `goal`: it is stored with the project and never parsed, so write it ' +
      'in full. Omit `sceneSpec` to start from a minimal renderable scaffold and build up with ' +
      'blender_scene_patch; pass one only when you already know the whole scene. ' +
      'Set saveCheckpoint:false to skip the Blender compile and store the SceneSpec alone (fast, but the ' +
      'revision then has no .blend to preview from until a later checkpointed revision).',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description:
          'Human-readable project title. Also the source of the project id (slugified), so keep it short ' +
          'and distinctive — "watch commercial" becomes projectId "watch-commercial".',
      },
      goal: {
        type: 'string',
        description:
          'The operator\'s natural-language brief, stored verbatim for audit. It never affects compilation.',
      },
      sceneSpec: SCENE_SPEC_PARAMETER,
      projectId: {
        type: 'string',
        description:
          'Optional explicit project id (lowercase letters, digits, dashes). Omit to derive it from the title; ' +
          'a collision gets a numeric suffix rather than an error.',
      },
      saveCheckpoint: {
        type: 'boolean',
        description:
          'Compile the scene in Blender and store `<revision>/scene.blend` as a checkpoint. Default true. ' +
          'A preview can only be rendered from a checkpoint, so leave this on unless you are only reshaping the spec.',
      },
      renderPreview: {
        type: 'boolean',
        description:
          'Also render the preview profile now, so the first revision already has a viewable image. Default false.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.createProject({
          ...definedFields({
            title: args.title,
            goal: args.goal,
            sceneSpec: args.sceneSpec,
            projectId: args.projectId,
            saveCheckpoint: args.saveCheckpoint,
          }),
          renderPreview: args.renderPreview === true,
          signal: exec.signal,
        }), warning)
        const notes = [
          `Project:  ${data.projectId}  "${data.title}"`,
          `Revision: ${describeRevision(data.revision)}`,
          `Digest:   ${data.revision.digest}`,
        ]
        if (data.revision.checkpoint === null) {
          notes.push('No checkpoint was saved, so this revision cannot be previewed until a later revision saves one.')
        }
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
          notes.push('')
          notes.push('Compiler notes (these describe decisions made on your behalf):')
          for (const entry of data.warnings) notes.push(`  - ${entry.message}`)
        }
        return {
          ok: true,
          text: renderSuccess(`Created project "${data.projectId}" at revision ${data.revision.revision}.`, data, {
            notes,
            warnings: canonicalWarnings,
          }),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'PROJECT_CREATE_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Create project "${args?.title ?? 'project'}"`,
      kind: 'write',
    }),
  })
}

// ---------------------------------------------------------------------------
// project_get
// ---------------------------------------------------------------------------

function projectGet(ctx) {
  return defineTool({
    name: 'blender_project_get',
    description:
      'Read a project: its current revision, the scene digest, and the full revision history with each ' +
      'revision\'s summary, digest, checkpoint and previews. Use this to see how a scene evolved, and to ' +
      'find a revision id you want to restore. It returns digests and summaries, not full SceneSpecs — ' +
      'call blender_scene_get with full:true when you need the document itself.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id returned by blender_project_create.' },
      revision: {
        type: 'string',
        description: 'Read a specific revision (e.g. "r0003") instead of the current one. Read-only; ' +
          'the project\'s current revision does not change.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(
          resolved.studio.getProject(args.projectId, definedFields({ revision: args.revision })), warning,
        )
        const scene = data.scene ?? {}
        const notes = [
          `Project:  ${data.projectId}  "${data.title}"`,
          `Current:  ${data.currentRevision}  (${data.revisionCount} revision${data.revisionCount === 1 ? '' : 's'})`,
          `Scene:    ${JSON.stringify(scene.counts ?? {})}`,
          `Frame range: ${scene.project?.frameStart}..${scene.project?.frameEnd} at ${scene.project?.fps} fps`,
          '',
          'Revisions:',
        ]
        for (const entry of data.revisions ?? []) {
          const marker = entry.isCurrent ? ' <- current' : ''
          notes.push(
            `  ${entry.revision}  ${entry.kind ?? '?'}${entry.checkpoint === null ? ' (no checkpoint)' : ''}` +
              `${(entry.previews ?? []).length > 0 ? ` (${entry.previews.length} preview)` : ''}${marker}`,
          )
          if (entry.summary) notes.push(`        ${entry.summary}`)
        }
        if (args.revision !== undefined && args.revision !== data.currentRevision) {
          notes.push('')
          notes.push(`Read revision ${args.revision}; the project still points at ${data.currentRevision}.`)
        }
        return {
          ok: true,
          text: renderSuccess(`Project "${data.projectId}" at ${data.currentRevision}.`, data, { notes, warnings: canonicalWarnings }),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'PROJECT_READ_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({ card: 'generic', title: `Read project "${args?.projectId ?? ''}"`, kind: 'read' }),
  })
}

// ---------------------------------------------------------------------------
// scene_get
// ---------------------------------------------------------------------------

function sceneGet(ctx) {
  return defineTool({
    name: 'blender_scene_get',
    description:
      'Read a project\'s scene. By default this returns a compact SceneDigest — the revision and digest, ' +
      'frame range and fps, entity/material/light/camera counts, every entity with its shape, material ' +
      'location and visibility, camera parameters, animation tracks and the render profiles. That is ' +
      'usually everything you need to decide what to change. Pass full:true to also get the complete ' +
      'SceneSpec document, which you should do only when you actually need exact field values. ' +
      'ALWAYS use the revision this returns as `baseRevision` for your next blender_scene_patch.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: { type: 'string', description: 'Read a specific revision instead of the current one.' },
      full: {
        type: 'boolean',
        description: 'Also return the complete SceneSpec and its compiled form. Costs a lot of context — ' +
          'use it when you need exact values, not to browse.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.getScene(args.projectId, {
          ...definedFields({ revision: args.revision }),
          full: args.full === true,
        }), warning)
        const counts = data.counts ?? {}
        const notes = [
          `Revision ${data.revision}${data.isCurrent ? ' (current)' : ' (NOT current — patches against it will be refused)'}`,
          `Digest:  ${data.digest}`,
          `Title:   ${data.project?.title}`,
          `Frame range: ${data.project?.frameStart}..${data.project?.frameEnd} at ${data.project?.fps} fps, ${data.project?.aspectRatio}`,
          `Counts:  ${JSON.stringify(counts)}`,
          '',
          'Entities:',
        ]
        for (const entity of data.entities ?? []) {
          notes.push(
            `  ${entity.id.padEnd(22)} ${String(entity.type).padEnd(15)} ${String(entity.shape ?? '-').padEnd(12)}` +
              ` material=${entity.materialId ?? '<default>'} at [${entity.location.join(', ')}]` +
              `${entity.visible === false ? ' HIDDEN' : ''}${entity.locked ? ' locked' : ''}`,
          )
        }
        notes.push('')
        notes.push('Cameras:')
        for (const camera of data.cameras ?? []) {
          notes.push(
            `  ${camera.id.padEnd(18)} ${camera.lens}mm at [${camera.location.join(', ')}]` +
              ` aiming at ${camera.targetEntityId ?? (camera.targetPoint ? `point [${camera.targetPoint.join(', ')}]` : 'authored rotation')}`,
          )
        }
        notes.push('')
        notes.push('Lights:')
        for (const light of data.lights ?? []) {
          notes.push(`  ${light.id.padEnd(18)} ${light.type.padEnd(8)} energy=${light.energy} at [${light.location.join(', ')}]`)
        }
        if ((data.animationTracks ?? []).length > 0) {
          notes.push('')
          notes.push('Animation:')
          for (const track of data.animationTracks) {
            notes.push(
              `  ${track.id.padEnd(20)} ${track.targetEntityId}.${track.property}  ` +
                `${track.keyframeCount} keyframes over frames ${track.frameRange?.[0]}..${track.frameRange?.[1]}`,
            )
          }
        }
        notes.push('')
        notes.push(`Render profiles: ${JSON.stringify(data.renderProfiles)}`)
        if ((data.previews ?? []).length > 0) {
          notes.push(`Previews: ${data.previews.map(entry => `${entry.path} (camera ${entry.cameraId}, frame ${entry.frame})`).join('; ')}`)
        }
        if (data.checkpoint !== null) notes.push(`Checkpoint: ${data.checkpoint}`)
        return {
          ok: true,
          text: renderSuccess(`Scene ${data.revision} of project "${args.projectId}".`, data, { notes, warnings: canonicalWarnings }),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'SCENE_READ_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args?.full === true ? `Read full scene of "${args?.projectId ?? ''}"` : `Read scene of "${args?.projectId ?? ''}"`,
      kind: 'read',
    }),
  })
}

// ---------------------------------------------------------------------------
// scene_patch
// ---------------------------------------------------------------------------

const OPERATION_SUMMARY = [
  'entity.transform.update      {entityId, location?, rotationEuler?, scale?}  — only supplied components change',
  'entity.visibility.set        {entityId, visible}',
  'entity.tags.set              {entityId, tags}                                    — replaces the whole tag list; [] clears it',
  'entity.add                   {entity}                                       — full entity object',
  'entity.remove                {entityId}',
  'entity.material.set          {entityId, materialId|null}                    — null restores the default material',
  'material.add                 {material}                                     — {id, shader, parameters?}',
  'material.parameter.update    {materialId, parameter, value}                  — parameter is a Blender 5 socket name',
  'light.add                    {light}',
  'light.update                 {lightId, energy?, color?, size?, transform?, spotSize?, spotBlend?, angle?}',
  'light.remove                 {lightId}',
  'camera.add                   {camera}',
  'camera.update                {cameraId, lens?, transform?, targetEntityId?, targetPoint?, clipping?, fStop?}',
  'camera.remove                {cameraId}',
  'animation.track.set          {track}                                        — {id, targetEntityId, targetKind?, property, keyframes[]}',
  'animation.track.remove       {trackId}',
  'shot.set                     {shot}                                         — {id, cameraId, frameRange?, description?}',
  'shot.remove                  {shotId}',
  'project.frameRange.set       {frameStart, frameEnd, fps?}',
  'render.profile.set           {profileName, profile}                         — profileName is "preview" or "final"',
  'world.set                    {world}                                        — {color?, strength?}; the environment behind the product',
].join('\n  ')

function scenePatch(ctx) {
  return defineTool({
    name: 'blender_scene_patch',
    description:
      'Modify a scene and commit the result as one new immutable revision. This is the ONLY way to change a ' +
      'scene — there is no free-form edit. Read the scene first with blender_scene_get and pass the revision ' +
      'it returned as `baseRevision`; if the project has moved on since, the patch is REFUSED rather than ' +
      'merged, and you should re-read and re-apply. Operations apply in order and all-or-nothing: if any one ' +
      'fails, no revision is created and the current revision is untouched, so a failed patch is always safe ' +
      'to correct and retry. Retrying an identical patch is also safe — it returns the original outcome ' +
      'instead of committing twice.\n\n' +
      'Set saveCheckpoint (default true) unless you are only reshaping the spec: a preview can only be ' +
      'rendered from a revision that has a .blend checkpoint.\n\n' +
      'Operations (each object needs an "op" key):\n  ' + OPERATION_SUMMARY,
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      baseRevision: {
        type: 'string',
        required: true,
        description:
          'The revision you read before computing this patch, e.g. "r0002". A stale value is refused — ' +
          'this is what stops a concurrent edit from silently discarding your work, and it is also how ' +
          'you find out that you need to re-read.',
      },
      operations: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
        description:
          'Ordered list of operations. Each needs an "op" key naming the operation (see the tool description). ' +
          'Later operations see the result of earlier ones, so a patch can remove a camera and then the shot ' +
          'that used it — in that order.',
      },
      note: {
        type: 'string',
        description:
          'One line explaining WHY this change was made. It is stored in the revision history and is what a ' +
          'human reads when reviewing how the scene evolved — write it as prose, not as a repeat of the operations.',
      },
      actor: { type: 'string', description: 'Who asked for this change, for the audit trail (a session id, a stage name).' },
      stage: {
        type: 'string',
        description: 'The orchestrator stage that produced this patch (BRIEF, BUILD, VISUAL_REVIEW, PATCH, ...).',
      },
      idempotencyKey: {
        type: 'string',
        description:
          'Optional. Identifies THIS logical intent. Leave it unset and one is derived from the project, the ' +
          'base revision and the operations — so an accidental retry is already safe. Set it explicitly only ' +
          'when you deliberately want to apply the same operations again as a new revision.',
      },
      saveCheckpoint: {
        type: 'boolean',
        description:
          'Compile the patched scene in Blender and store `<revision>/scene.blend`. Default true. ' +
          'Turn it off only for a spec-only change you do not intend to look at.',
      },
      renderPreview: {
        type: 'boolean',
        description: 'Also render the preview profile as part of this commit, so the revision arrives with an image. Default false.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        return {
          ok: false,
          text:
            'DeepBlend call failed.\nerrorCode: SCENE_PATCH_INVALID\n' +
            'message:   a ScenePatch needs at least one operation.\n' +
            `supported operations:\n  ${SCENE_OPERATION_NAMES.join('\n  ')}`,
          data: { ok: false, errorCode: 'SCENE_PATCH_INVALID', message: 'operations must be a non-empty array', detail: null },
        }
      }
      try {
        // `definedFields` is load-bearing here, not tidiness: forwarding
        // `note: undefined` puts an own `note` key on the patch document, and the
        // host's schema validation rejects that as a wrong TYPE. A correct call
        // with an omitted optional argument was being refused for exactly this.
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.applyScenePatch({
          ...definedFields({
            projectId: args.projectId,
            baseRevision: args.baseRevision,
            operations: args.operations,
            note: args.note,
            actor: args.actor,
            stage: args.stage,
            idempotencyKey: args.idempotencyKey,
            saveCheckpoint: args.saveCheckpoint,
          }),
          renderPreview: args.renderPreview === true,
          signal: exec.signal,
        }), warning)
        const notes = [
          `Revision: ${describeRevision(data)}`,
          `Digest:   ${data.revision ? data.revision : data.digest}`,
          `Summary:  ${data.summary ?? '(none)'}`,
        ]
        if (data.idempotentReplay === true) {
          notes.unshift(
            'This exact patch had already been applied, so the original outcome was returned and nothing was ' +
              'committed again. This is the idempotency guard working, not an error.',
          )
        }
        if (data.checkpoint !== null && data.checkpoint !== undefined) {
          notes.push(`Checkpoint: ${data.checkpoint}`)
        } else {
          notes.push('No checkpoint was saved, so this revision cannot be previewed as-is.')
        }
        if ((data.previews ?? []).length > 0) {
          for (const preview of data.previews) {
            notes.push(`Preview:   ${preview.path}  (camera ${preview.cameraId}, frame ${preview.frame}, ${preview.width}x${preview.height})`)
          }
        }
        const scene = data.scene ?? {}
        if (scene.counts) notes.push(`Scene now: ${JSON.stringify(scene.counts)}`)
        return {
          ok: true,
          text: renderSuccess(
            `${data.idempotentReplay === true ? 'Reused' : 'Committed'} revision ${data.revision}.`,
            data,
            { notes, warnings: [...(data.warnings ?? []), ...canonicalWarnings] },
          ),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'SCENE_PATCH_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Patch scene of "${args?.projectId ?? ''}" (${Array.isArray(args?.operations) ? args.operations.length : 0} ops)`,
      kind: 'write',
    }),
  })
}

// ---------------------------------------------------------------------------
// preview_render
// ---------------------------------------------------------------------------

function previewRender(ctx) {
  return defineTool({
    name: 'blender_preview_render',
    description:
      'Render one preview frame of a revision from a camera, and store the PNG inside that revision. ' +
      'Rendering does NOT create a revision — a preview observes a scene, it does not change it — so it is ' +
      'always safe to call. A preview needs a .blend checkpoint: if the revision has one it is opened ' +
      'directly; if it does not, the revision is compiled from its SceneSpec into a scratch directory first ' +
      '(slower, and reported as a warning). Prefer committing patches with saveCheckpoint:true so previews ' +
      'stay cheap. Returns the project-relative path of the image, its dimensions, the engine actually used, ' +
      'and the frame that was rendered.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: { type: 'string', description: 'Revision to render. Defaults to the current one.' },
      cameraId: {
        type: 'string',
        description: 'Camera to render from. Defaults to the project\'s first camera — name one when the scene has several.',
      },
      frame: {
        type: 'integer',
        description:
          'Frame to render. Defaults to the MIDDLE of the project\'s frame range, which is usually more ' +
          'informative than frame 1 for an animated scene.',
      },
      samples: {
        type: 'integer',
        description:
          'Override the preview profile\'s sample count. Lower is faster and noisier. A value above the ' +
          'profile\'s maxSamplesBudget is reduced and reported rather than honoured.',
      },
      width: { type: 'integer', description: 'Override preview width in pixels.' },
      height: { type: 'integer', description: 'Override preview height in pixels.' },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.renderPreview({
          ...definedFields({
            projectId: args.projectId,
            revision: args.revision,
            cameraId: args.cameraId,
            frame: args.frame,
            samples: args.samples,
            width: args.width,
            height: args.height,
          }),
          signal: exec.signal,
        }), warning)
        const notes = [
          `Revision: ${data.revision}`,
          `Engine:   ${data.profile?.blenderEngine ?? data.profile?.engine}`,
          `Samples:  ${data.profile?.samples ?? 'engine default'}`,
        ]
        for (const artifact of data.artifacts ?? []) {
          notes.push(
            `Image:    ${artifact.path}  (camera ${artifact.cameraId}, frame ${artifact.frame}, ` +
              `${artifact.width}x${artifact.height}, ${artifact.bytes} bytes, sha256 ${String(artifact.sha256).slice(0, 16)}…)`,
          )
        }
        notes.push('')
        notes.push('The path is relative to the project directory. Open it to see what the scene actually looks like.')
        return {
          ok: true,
          text: renderSuccess(`Rendered a preview of ${data.revision}.`, data, { notes, warnings: [...(data.warnings ?? []), ...canonicalWarnings] }),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'PREVIEW_RENDER_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Render preview of "${args?.projectId ?? ''}"${args?.cameraId ? ` from ${args.cameraId}` : ''}`,
      kind: 'other',
    }),
  })
}

// ---------------------------------------------------------------------------
// scene_validate
// ---------------------------------------------------------------------------

function sceneValidate(ctx) {
  return defineTool({
    name: 'blender_scene_validate',
    description:
      'Check a revision for problems BEFORE you spend a revision on a change. Reports structural and semantic ' +
      'errors (dangling references, duplicate ids, an unrenderable scene), the technical report Blender ' +
      'produced when the revision was compiled (object and geometry counts, camera framing, whether the ' +
      'subject is inside the frame), and the decisions the compiler made on your behalf. ' +
      'Pass `patch` to ALSO dry-run a ScenePatch: it is applied to an in-memory copy and validated without ' +
      'committing anything, which is the cheapest way to find out whether a patch will be accepted. ' +
      'ok:true means there are no errors — notices are expected and are listed so you can see what the ' +
      'compiler decided.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: { type: 'string', description: 'Revision to validate. Defaults to the current one.' },
      patch: {
        type: 'object',
        additionalProperties: true,
        description:
          'Optional ScenePatch to dry-run against the validated revision: ' +
          '{baseRevision, operations:[...], plus optional projectId}. Nothing is committed. ' +
          'Its baseRevision should equal the revision being validated.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }
      try {
        const { data, canonicalWarnings } = await canonicalCall(resolved.studio.validateScene({
          projectId: args.projectId,
          revision: args.revision,
          patch: args.patch === undefined ? undefined : { projectId: args.projectId, ...args.patch },
          signal: exec.signal,
        }), warning)
        const notes = [
          `Revision: ${data.revision}`,
          `Result:   ${data.ok ? 'VALID' : `INVALID — ${data.errorCount} error(s)`}`,
          `Digest:   ${data.digest}`,
        ]
        if (data.technical !== null && data.technical !== undefined) {
          const technical = data.technical
          notes.push(
            `Technical: engine ${technical.engine}, frames ${technical.frameRange?.[0]}..${technical.frameRange?.[1]} ` +
              `at ${technical.fps} fps, active camera ${technical.activeCamera}`,
          )
          if (technical.counts) notes.push(`Counts:   ${JSON.stringify(technical.counts)}`)
          if (technical.geometry) {
            notes.push(
              `Geometry: ${technical.geometry.totalVertices} vertices, ${technical.geometry.totalPolygons} polygons` +
                `${(technical.geometry.degenerateObjects ?? []).length > 0 ? `, DEGENERATE: ${technical.geometry.degenerateObjects.join(', ')}` : ''}`,
            )
          }
        } else {
          notes.push('Technical: this revision has no recorded technical report (it was committed without a checkpoint).')
        }
        if (data.errorCount > 0) {
          notes.push('')
          notes.push('Errors:')
          for (const issue of data.errors) notes.push(`  - [${issue.code}] ${issue.path ?? ''} ${issue.message}`)
        }
        if (data.noticeCount > 0) {
          notes.push('')
          notes.push('Notices (decisions the compiler made):')
          for (const issue of data.notices) notes.push(`  - [${issue.code}] ${issue.message}`)
        }
        return {
          ok: true,
          text: renderSuccess(
            data.ok
              ? `Revision ${data.revision} validates.`
              : `Revision ${data.revision} has ${data.errorCount} error(s).`,
            data,
            { notes, warnings: canonicalWarnings },
          ),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'SCENE_VALIDATE_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args?.patch === undefined
        ? `Validate "${args?.projectId ?? ''}"`
        : `Dry-run a patch against "${args?.projectId ?? ''}"`,
      kind: 'read',
    }),
  })
}

// ---------------------------------------------------------------------------
// revision_restore
// ---------------------------------------------------------------------------

/**
 * Put the project back on an earlier revision.
 *
 * WHY THIS TOOL EXISTS, AND WHY IT WAS MISSING
 * --------------------------------------------
 * SPEC §11 lists `blender_revision_restore` among the model-visible tools, with
 * "需确认" as its permission. It was never implemented — while two of this
 * repository's own documents told a user to call it:
 * `README.md` ("可直接重放或 `blender_revision_restore` 回退") and
 * `milestone-status.md` §10B ("需要回退时：`blender_revision_restore {…}`").
 * Both were written by an earlier session that assumed the tool followed from the
 * facade method. The facade method did exist and did work — the workbench's own
 * Revisions panel calls it — so nothing failed, and nothing noticed.
 *
 * That is the whole shape of the defect: a promise in prose, a working
 * implementation one layer down, and no line of code that had to agree with
 * either. `composition/tool-plane-m3.e2e.mjs` now calls this tool, which is the
 * line of code that would have caught it.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not destructive. Restore MOVES THE POINTER to a revision that already
 * exists; every later revision stays in the history, and the revision it left is
 * still there to come back to. That is why the guard below is an explicit
 * `confirm` rather than an approval prompt: the expensive and irreversible
 * operations are the renders, and SPEC's approval plane (§15.1, Q7) is about
 * those. A caller who has to write `confirm: true` has stated an intent; a caller
 * who forgot to read the history has not.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function revisionRestore(ctx) {
  return defineTool({
    name: 'blender_revision_restore',
    description:
      'Move a project back to an earlier revision. Read blender_project_get first and pass the exact ' +
      'revision id from its history — this does not take an index, a timestamp or "the previous one". ' +
      'Nothing is deleted: the revisions after the target stay in the history, and the revision you ' +
      'leave is still there to restore again. Requires confirm:true, because the scene the model is ' +
      'reasoning about changes underneath it — after a restore, re-read with blender_scene_get before ' +
      'proposing any further patch, or the baseRevision you pass will be a conflict.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'The project id.' },
      revision: {
        type: 'string',
        required: true,
        description: 'The revision to move the project to, exactly as blender_project_get reports it (e.g. "r0003").',
      },
      confirm: {
        type: 'boolean',
        required: true,
        description: 'Must be true. A restore changes which revision later patches must be based on, so it is ' +
          'never something to do as a side effect of another call.',
      },
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const resolved = resolveStudio(ctx)
      if (resolved.unavailable !== undefined) return { ok: false, ...resolved.unavailable }

      // NOTE ON THE ABSENT `confirm` CHECK. An earlier version of this tool ran a
      // hand-written refusal when `args.confirm !== true`. It was unreachable: the
      // parameter is declared `required`, so the harness rejects a call that omits it
      // with `INVALID_ARGS` before `execute` is entered — measured while writing this
      // suite, and it is why the branch is gone. A guard that cannot fire reads like
      // protection and is not, which is the same defect as a test that cannot fail.
      // The confirmation this tool offers IS the schema requirement, and
      // `composition/tool-plane-m3.e2e.mjs` asserts both halves: that it is declared,
      // and that omitting it never reaches the host.
      try {
        const { data, canonicalWarnings } = await canonicalCall(
          resolved.studio.restoreRevision(definedFields({
            projectId: args.projectId,
            revision: args.revision,
          })),
          warning,
        )

        // `restored:false` is a success, not a no-op to hide: the target was
        // already current, and saying so beats reporting a change that did not
        // happen (D54's rule, one layer down).
        const alreadyThere = data.restored !== true
        const notes = alreadyThere
          ? [`${args.revision} was already the current revision; nothing moved.`]
          : [
              `Moved  ${data.from}  ->  ${data.revision}`,
              'The revisions in between are still in the history — this only moved the pointer.',
              'Re-read with blender_scene_get before the next patch: its baseRevision must now be ' +
                `${data.revision}.`,
            ]

        return {
          ok: true,
          text: renderSuccess(
            alreadyThere
              ? `Project "${data.projectId}" is already on ${data.revision}.`
              : `Project "${data.projectId}" is now on ${data.revision} (was ${data.from}).`,
            data,
            { notes, warnings: canonicalWarnings },
          ),
          data,
        }
      } catch (cause) {
        const failure = renderFailure(cause, 'REVISION_RESTORE_FAILED')
        return { ok: false, ...failure }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Restore "${args?.projectId ?? ''}" to ${args?.revision ?? '?'}`,
      kind: 'edit',
    }),
  })
}
