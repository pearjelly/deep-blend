/**
 * Shared plumbing for the DeepBlend model-visible tools (SPEC §11).
 *
 * Plane: Agent preset — this package contributes tools to ONE session's model
 * and publishes no service, which is what makes it legal as a preset row
 * (SPEC §4.4).
 *
 * WHY A SHARED MODULE
 * -------------------
 * Every DeepBlend tool has the same four obligations, and each one is easy to
 * get subtly wrong in a different way per tool:
 *
 *  1. **Resolve `blenderStudio` per call.** The host bundle is a process-level
 *     composition change that only takes effect on the next profile boot, so a
 *     half-installed deployment must still be able to open a session and
 *     diagnose itself. The absence is reported as a stable
 *     `BLENDER_RUNTIME_UNAVAILABLE` result, never as a thrown error.
 *  2. **Return canonical JSON plus readable text.** SPEC §11.1 requires both: the
 *     model reads the prose, and nothing downstream may have to parse it.
 *  3. **Turn every failure into a stable `errorCode`.** A tool that throws leaves
 *     the model with a stack trace and no way to branch.
 *  4. **Never let a failure look like a success.** Every error result carries
 *     `ok: false` AND a non-empty `message`.
 *
 * Owner: DeepBlend Studio — M1
 */

import { BlenderError, BlenderErrorCode, toCanonicalFailure } from '@deepblend/dsh-blender-contracts'

/** The host service every DeepBlend tool consumes. */
export const STUDIO_SERVICE = 'blenderStudio'

/** The bundle an operator must compose when the host half is missing. */
export const HOST_BUNDLE = '@deepblend/dsh-blender-bundle'

/**
 * Resolve the studio service, or describe precisely why it is unavailable.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{ studio: any }|{ unavailable: { text: string, data: object } }}
 */
export function resolveStudio(ctx) {
  const studio = ctx.get(STUDIO_SERVICE)
  if (studio !== undefined) return { studio }
  const error = new BlenderError(
    BlenderErrorCode.RUNTIME_UNAVAILABLE,
    'The DeepBlend host half is not composed in this process, so no Blender runtime is available. ' +
      `Add "${HOST_BUNDLE}" to the profile's dsh.profile.bundles and restart the profile.`,
    { detail: { missingService: STUDIO_SERVICE, bundle: HOST_BUNDLE } },
  )
  return {
    unavailable: {
      text:
        `DeepBlend host services are unavailable.\n` +
        `errorCode: ${error.code}\n` +
        `message:   ${error.message}`,
      data: error.toJSON(),
    },
  }
}

/**
 * Render a canonical success envelope as model-readable text.
 *
 * @param {string} headline
 * @param {object} data
 * @param {{ notes?: string[], warnings?: object[] }} [options]
 * @returns {string}
 */
export function renderSuccess(headline, data, options = {}) {
  const lines = [headline, '']
  for (const note of options.notes ?? []) lines.push(note)
  if ((options.notes ?? []).length > 0) lines.push('')
  const warnings = options.warnings ?? []
  if (warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`)
    for (const entry of warnings) lines.push(`  - [${entry.code}] ${entry.message}`)
    lines.push('')
  }
  lines.push('Canonical JSON:')
  lines.push(JSON.stringify(data, null, 2))
  return lines.join('\n')
}

/**
 * Render a failure as model-readable text plus a stable code.
 *
 * @param {unknown} cause
 * @param {string} fallbackCode
 * @returns {{ text: string, data: object }}
 */
export function renderFailure(cause, fallbackCode) {
  const failure = toCanonicalFailure(cause, {
    isBlenderError: value => value instanceof BlenderError,
    fallbackCode,
  })
  const lines = [
    'DeepBlend call failed.',
    `errorCode: ${failure.code}`,
    `message:   ${failure.message}`,
  ]
  if (failure.detail !== null && failure.detail !== undefined) {
    lines.push(`detail:    ${JSON.stringify(failure.detail)}`)
  }
  if (failure.stack !== null) {
    // Only an unrecognized failure carries a stack: it is the one case where the
    // caller cannot branch on a code, so the trace is the whole value.
    lines.push('', 'This failure has no stable code — it is a bug. Stack:', failure.stack)
  }
  if (failure.code === BlenderErrorCode.REVISION_CONFLICT) {
    lines.push(
      '',
      'The patch was refused rather than merged, because merging would silently discard whatever changed',
      'since you read the scene. Call blender_scene_get, then re-issue the patch with the revision it returns.',
    )
  }
  return { text: lines.join('\n'), data: { ok: false, errorCode: failure.code, message: failure.message, detail: failure.detail } }
}

/**
 * The canonical tool output contract. Every DeepBlend tool declares exactly this.
 *
 * `ok` is first so a transcript reads as a verdict before it reads as data.
 */
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    text: { type: 'string', required: true },
    data: { type: 'object', additionalProperties: true, required: true },
  },
}

/** The `output` block every DeepBlend tool shares. */
export const TOOL_OUTPUT = {
  schema: TOOL_OUTPUT_SCHEMA,
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/**
 * A short, model-readable line describing a revision, for use inside a headline.
 * @param {object} summary
 * @returns {string}
 */
export function describeRevision(summary) {
  if (summary === undefined || summary === null) return 'unknown revision'
  const parts = [summary.revision ?? '?']
  if (summary.kind !== undefined && summary.kind !== null) parts.push(summary.kind)
  if (summary.checkpoint !== null && summary.checkpoint !== undefined) parts.push('checkpoint saved')
  if (Array.isArray(summary.previews) && summary.previews.length > 0) {
    parts.push(`${summary.previews.length} preview${summary.previews.length === 1 ? '' : 's'}`)
  }
  return parts.join(', ')
}

/**
 * Drop every key whose value is `undefined`.
 *
 * This exists because of a real bug, and it is worth stating plainly: a tool
 * receives `args.note === undefined` for an optional parameter the model did not
 * supply, and forwarding `{ note: undefined }` to the host produces a document
 * with an OWN `note` key. The host validates against a JSON Schema, where an
 * absent key means "not supplied" and an own key set to `undefined` means "the
 * caller sent the wrong type" — so a perfectly correct call was rejected with
 * `SCHEMA_PATCH_INVALID: note: expected string, received undefined`.
 *
 * `JSON.stringify` would have dropped the key, which is exactly why the bug
 * survived the serializing paths and only appeared end to end. Filtering at the
 * boundary is the fix: the tool builds documents, so the tool must not emit keys
 * it was not given.
 *
 * @param {Record<string, unknown>} object
 * @returns {Record<string, unknown>}
 */
export function definedFields(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

/**
 * Convert a thrown value into a BlenderError with a stable code.
 * @param {unknown} cause
 * @param {string} fallbackCode
 * @returns {BlenderError}
 */
export function asBlenderError(cause, fallbackCode) {
  if (cause instanceof BlenderError) return cause
  return new BlenderError(
    fallbackCode,
    cause instanceof Error ? cause.message : String(cause),
    { cause },
  )
}
