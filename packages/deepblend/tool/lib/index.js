/**
 * @deepblend/dsh-blender-tool
 *
 * The **Agent-preset plane** consumer (SPEC §4.2, §5.1, §11).
 *
 * Registers the model-visible DeepBlend tools. This package publishes NO
 * service — it only consumes `blenderStudio` from the Host composition — which
 * is exactly what makes it legal to list as a row inside an agent preset: a
 * preset row that provided a process-global service would collide on the second
 * session (SPEC §4.4).
 *
 * M0 registers one tool, `blender_capabilities`. The remaining tools from
 * SPEC §11 arrive with the milestones that implement their host services; they
 * are deliberately absent rather than registered-and-throwing, because a tool
 * the model can see is a promise the runtime must keep.
 *
 * Owner: DeepBlend Studio — M0
 * Plane: Agent preset
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

/** Plugin name, surfaced in loader diagnostics. */
export const name = 'deepblend-blender-tool'

/**
 * `tools` is required to register at all.
 *
 * `blenderStudio` is deliberately NOT a hard injection, and this is a real
 * trade-off worth stating. Hard-injecting it makes the row park in `waiting`
 * whenever the DeepBlend Host Bundle is absent — an honest, diagnosable state,
 * and the option that hides least. But it also makes the preset UNMOUNTABLE
 * until the host bundle is composed: mount validation fails, and a session on
 * this preset cannot start at all.
 *
 * The Host Bundle is the M0 deliverable that must be installed by the operator
 * (it is a process-level composition change, so it only takes effect on the
 * next profile boot). Making the tool's absence a mount-time failure would mean
 * a half-installed deployment cannot even open a session to diagnose itself.
 *
 * So the service is resolved per call from `ctx`. The tool is always visible in
 * the catalog and its description says what it does; if the host half is
 * missing, calling it returns a stable `BLENDER_RUNTIME_UNAVAILABLE` error
 * explaining exactly which bundle to compose. Nothing fails silently.
 */
export const inject = ['tools']
/** No configuration in M0; present so a composition row may carry `config:` later. */
export const Config = undefined

/**
 * Render the canonical capability report as compact, model-readable text.
 *
 * The JSON document is appended verbatim because SPEC §11.1 requires Canonical
 * JSON in the tool result: the model must be able to read exact values rather
 * than a paraphrase, and downstream code must not have to parse prose.
 *
 * @param {Record<string, any>} value
 * @returns {string}
 */
function renderCapabilityText(value) {
  const lines = []
  const engineEntries = Object.entries(value.engines ?? {})
  const available = engineEntries.filter(([, probe]) => probe.available).map(([id]) => id)

  if (!value.installed) {
    lines.push('Blender: NOT INSTALLED')
    lines.push(`Configured path: ${value.executable?.requested ?? '<unset>'}`)
    lines.push('No Blender executable could be resolved. DeepBlend cannot build or render until one is available.')
  } else {
    lines.push(`Blender: ${value.version ?? 'unknown version'}`)
    lines.push(`Python:  ${value.pythonVersion ?? 'unknown'}`)
    lines.push(`Binary:  ${value.binaryPath ?? value.executable?.resolved ?? 'unknown'}`)
    lines.push(`Engines: ${available.length > 0 ? available.join(', ') : 'none assignable'}`)
    lines.push(
      `Engine enum (diagnostic only): ${
        Array.isArray(value.engineEnumItems) && value.engineEnumItems.length > 0
          ? value.engineEnumItems.join(', ')
          : '<empty>'
      }`,
    )
    const gpuDevices = value.gpu?.devices ?? []
    const backend = value.gpu?.preferredBackend
    lines.push(
      `GPU:     ${
        value.gpu?.available
          ? `${gpuDevices.join(', ')}${backend ? ` via ${backend}` : ''}`
          : 'none detected (CPU rendering)'
      }`,
    )
    lines.push(
      `Import:  ${(value.formats?.import ?? []).join(', ') || 'none'}`,
    )
    lines.push(
      `Export:  ${(value.formats?.export ?? []).join(', ') || 'none'}`,
    )
    const smoke = value.renderSmokeTest
    if (smoke) {
      lines.push(
        `Headless render probe: ${smoke.ok ? `ok via ${smoke.engine} (${smoke.bytes} bytes)` : `FAILED${smoke.error ? ` — ${smoke.error}` : ''}`}`,
      )
    }
  }

  const warnings = Array.isArray(value.warnings) ? value.warnings : []
  if (warnings.length > 0) {
    lines.push('')
    lines.push(`Warnings (${warnings.length}):`)
    for (const entry of warnings) lines.push(`  - [${entry.code}] ${entry.message}`)
  }

  lines.push('')
  lines.push('Canonical JSON:')
  lines.push(JSON.stringify(value, null, 2))
  return lines.join('\n')
}

/**
 * Register the DeepBlend tools for the calling agent scope.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // Registration is fiber-scoped: Cordis disposes this registration when the
  // preset's subtree unmounts, so no manual teardown hook is needed (and adding
  // one would risk double-disposal on reload).
  ctx.tools.register(defineTool({
    name: 'blender_capabilities',
    description:
      'Report what the local Blender runtime can actually do: version, Python version, which render ' +
      'engines are genuinely available, GPU compute devices, supported import/export formats, and whether ' +
      'a headless render probe succeeded. Call this before planning any modelling, material or render work, ' +
      'and again after the operator changes Blender settings. Engine availability is reported behaviorally — ' +
      'a listed engine has been verified assignable, and absence from the diagnostic engine enum does not ' +
      'mean an engine is unavailable.',
    parameters: {
      refresh: {
        type: 'boolean',
        description:
          'Re-probe Blender instead of serving the short-lived cached report. Use after changing the ' +
          'Blender path or installing a different Blender build.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    /**
     * @param {{ refresh?: boolean }} args
     * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec
     */
    async execute(args, exec) {
      // Resolved per call rather than injected — see the `inject` note above.
      const studio = ctx.get('blenderStudio')
      if (studio === undefined) {
        const error = new BlenderError(
          BlenderErrorCode.RUNTIME_UNAVAILABLE,
          'The DeepBlend host half is not composed in this process, so no Blender runtime is available. ' +
            'Add "@deepblend/dsh-blender-bundle" to the profile\'s dsh.profile.bundles and restart the profile.',
          { detail: { missingService: 'blenderStudio', bundle: '@deepblend/dsh-blender-bundle' } },
        )
        return {
          text: `Blender capability probe unavailable.\nerrorCode: ${error.code}\nmessage:   ${error.message}`,
          data: error.toJSON(),
        }
      }

      try {
        const data = await studio.describeCapabilities({
          refresh: args?.refresh === true,
          signal: exec.signal,
        })
        return { text: renderCapabilityText(data), data }
      } catch (cause) {
        // A probe failure must still reach the model as readable text plus a
        // stable code, not as an opaque tool crash (SPEC §11.1).
        const error = cause instanceof BlenderError
          ? cause
          : new BlenderError(
            BlenderErrorCode.CAPABILITY_PROBE_FAILED,
            cause instanceof Error ? cause.message : String(cause),
            { cause },
          )
        return {
          text:
            `Blender capability probe failed.\n` +
            `errorCode: ${error.code}\n` +
            `message:   ${error.message}\n` +
            (error.detail !== undefined ? `detail:    ${JSON.stringify(error.detail)}\n` : ''),
          data: { errorCode: error.code, message: error.message, detail: error.detail ?? null },
        }
      }
    },
    presentCall: args =>
      args?.refresh === true
        ? { card: 'generic', title: 'Re-probe Blender capabilities', kind: 'other' }
        : { card: 'generic', title: 'Check Blender capabilities', kind: 'read' },
  }))
}
