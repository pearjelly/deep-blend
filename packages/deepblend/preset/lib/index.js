/**
 * @deepblend/dsh-blender-preset
 *
 * The **Agent-preset plane** deliverable (SPEC §4.2, §5.2).
 *
 * WHY THIS PACKAGE EXISTS
 * -----------------------
 * The tools a session may see belong to an AGENT PRESET, not to the Host
 * composition (SPEC §4.3): registering them process-wide would hand every
 * session in the deployment the Blender toolset. That is why they are not in the
 * bundle's patch.
 *
 * But a preset is a directory under `<DSH_HOME>/.agent-presets/`, and
 * `dsh plugin add` installs a package — it does not write a user's preset root.
 * So a plugin whose value IS its preset has to deliver one, and the ecosystem's
 * pattern for that is a deployer row: the bundle mounts this package, and the
 * package installs the preset it ships. `dsh-expert-orchestrator` is the same
 * shape, and it is on the plugin list.
 *
 * WHAT IT TOUCHES
 * ---------------
 * Exactly `<DSH_HOME>/.agent-presets/<id>/` for the preset ids it ships, and
 * nothing else. The root is a user-owned, writable directory — a person may have
 * authored presets of their own beside these — so this never removes the root,
 * never touches another preset, and never deletes a file that the shipped copy
 * still has.
 *
 * The write is IDEMPOTENT and reports rather than insists: a file whose bytes
 * already match is not rewritten, a stale file left by an earlier release is
 * removed, and a home that cannot be written is logged and left alone. A plugin
 * that throws while a profile composes would take the whole deployment down over
 * a convenience copy, which is the wrong trade in both directions.
 *
 * WHY DEPLOYING IS THE DEFAULT
 * ----------------------------
 * An installed preset that has to be installed again by hand is the failure this
 * exists to remove: `dsh plugin add` is the whole install, and the session list
 * then shows "DeepBlend Studio". `deploy: false` is for a deployment that
 * manages its preset root itself (a fleet, or a test), and it is honoured
 * without a warning because it is a decision rather than a mistake.
 *
 * Owner: DeepBlend Studio — M6 (plugin-market packaging)
 * Plane: Agent preset
 */

import z from '@deepseek-ai/schemastery'

import { PRESET_SOURCE, defaultTarget, deployPresets, presetIds } from './deploy.js'

/** Plugin name, surfaced in loader diagnostics. */
export const name = 'deepblend-blender-preset'

/**
 * No service is consumed and none is published.
 *
 * The deployment reads its own package and writes a directory, so there is
 * nothing to wait for — and publishing a service from a row would make the
 * preset that mounts it collide on a second session (SPEC §4.4). This row lives
 * in the HOST composition precisely because it must happen once per process.
 */
export const inject = []

/** The shipped preset ids, for a composition that wants to name them. */
export const SHIPPED_PRESETS = Object.freeze(presetIds())

export const Config = z.object({
  /** Deploy the shipped presets when this row composes. */
  deploy: z.boolean().default(true),
  /**
   * Which preset ids to deploy. Empty means every preset this package ships,
   * which is the right default: a preset added to the package should arrive
   * without a composition change.
   */
  presets: z.array(z.string()).default([]),
  /** The preset root to deploy into; empty means `<DSH_HOME>/.agent-presets`. */
  target: z.string().default(''),
})

/** The scope every line this row logs carries. */
export const LOG_SCOPE = 'deepblend-preset'

/**
 * Deploy the shipped presets, and report what it took.
 *
 * Exported so the contract layer can drive it without composing a profile — the
 * same reason `host/lib/frame-ledger.js` exports its measurement.
 *
 * @param {object} config - the validated row configuration.
 * @param {{info?: Function, warn?: Function}} [logger]
 * @returns {{deployed: Array<{id: string, written: number, removed: number}>, skipped: string[], failed: string[]}}
 */
export function deployShippedPresets(config, logger) {
  const target = config.target === '' ? defaultTarget() : config.target
  const ids = config.presets.length === 0 ? presetIds(PRESET_SOURCE) : config.presets
  const reports = []
  const skipped = []
  const failed = []

  for (const id of ids) {
    try {
      const [report] = deployPresets({ source: PRESET_SOURCE, target, ids: [id] })
      if (report === undefined) {
        skipped.push(id)
        continue
      }
      if (report.plan.problem !== null) {
        // Refusing beats writing half a preset: a directory without its
        // composition still occupies the id in the roster.
        failed.push(`${id}: ${report.plan.problem}`)
        logger?.warn?.(`${LOG_SCOPE}: ${id} was not deployed — ${report.plan.problem}`)
        continue
      }
      reports.push({ id, written: report.written.length, removed: report.removed.length })
    } catch (cause) {
      // A read-only or missing home is the operator's business, not a reason to
      // fail the composition. The session list simply will not show the preset,
      // and this line says why.
      failed.push(`${id}: ${cause instanceof Error ? cause.message : String(cause)}`)
      logger?.warn?.(`${LOG_SCOPE}: could not deploy ${id} into ${target}: ${String(cause)}`)
    }
  }
  return { deployed: reports, skipped, failed }
}

/**
 * The row's apply: deploy once per composition, then stay out of the way.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  if (!config.deploy) {
    ctx.logger?.info?.(`${LOG_SCOPE}: deployment is switched off for this row; the preset root is left as it is`)
    return
  }
  const { deployed, failed } = deployShippedPresets(config, ctx.logger)
  if (deployed.length === 0 && failed.length === 0) return
  const summary = deployed
    .map(entry => `${entry.id} (${entry.written} written, ${entry.removed} removed)`)
    .join(', ')
  if (deployed.length > 0) {
    ctx.logger?.info?.(`${LOG_SCOPE}: deployed into ${config.target === '' ? defaultTarget() : config.target} — ${summary}`)
  }
}
