/**
 * @deepblend/dsh-blender-host
 *
 * The DeepBlend **Host service** (SPEC §5.1, §7.2).
 *
 * Owns the `blenderStudio` business facade that both the model-facing tool
 * package and the Web UI talk to. In M0 that facade does exactly one thing —
 * report Blender capabilities — and every not-yet-built capability is present
 * as a method that throws a stable `UNSUPPORTED_ACTION` error rather than
 * silently returning undefined.
 *
 * Why the facade exists at all in M0: the SPEC's plane rule. `blender_capabilities`
 * must be a *preset* row (it decides what the model sees), while the capability
 * probe, its caching and its policy belong to the *host*. Splitting them now
 * means M1 adds store methods here without re-cutting the package boundary.
 *
 * Owner: DeepBlend Studio — M0
 * Plane: Host composition
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  BLENDER_SETTINGS_NAMESPACE,
  BlenderError,
  BlenderErrorCode,
  toCanonicalCapabilities,
} from '@deepblend/dsh-blender-contracts'

/** Service key registered into the Cordis context. */
export const BLENDER_STUDIO_SERVICE = 'blenderStudio'

/** The runtime service this facade consumes. */
const RUNTIME_SERVICE = 'blenderRuntime'

/**
 * Host-level configuration. Mirrors SPEC §17, limited to what M0 implements.
 *
 * Fields for later milestones are deliberately absent rather than stubbed: an
 * unknown key in a composition row is a mistake the operator should see now
 * (SPEC §17 "配置 Schema 必须在启动时校验").
 *
 * Named `StudioConfig`, NOT `Config`. The class below declares `static Config`,
 * and a module-scope `Config` would be shadowed by that class field inside the
 * class body — so `static Config = Config` would read the field already being
 * initialized and throw a temporal-dead-zone ReferenceError during module
 * evaluation, taking the whole package down on import. That is exactly the bug
 * this naming avoids; it failed only at bundle-load time, never in the unit
 * tests, which is why the runtime install check caught it.
 */
export const StudioConfig = z.object({
  /** Directory holding DeepBlend projects. Created on first use in M1. */
  projectsRoot: z.string(),
  /** Serve a cached capabilities document without re-probing during a page load. */
  serveCachedCapabilities: z.boolean().default(true),
})

export default class BlenderStudio extends Service {
  // A hard dependency: without a BlenderRuntime the facade has nothing to report,
  // so Cordis keeps this row `waiting` instead of failing at first call.
  static inject = [RUNTIME_SERVICE]

  static Config = StudioConfig

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('z').infer<typeof StudioConfig>} config
   */
  constructor(ctx, config) {
    super(ctx, BLENDER_STUDIO_SERVICE)
    this.config = config
    /** In-flight probe, so N concurrent callers share one Blender launch. */
    this._inFlight = null
  }

  /** @type {Promise<import('@deepblend/dsh-blender-contracts').BlenderCapabilities>|null} */
  _inFlight

  /** @returns {import('@deepblend/dsh-blender-provider-local').default} */
  get runtime() {
    return this.ctx.blenderRuntime
  }

  /**
   * Report Blender capabilities.
   *
   * Concurrent callers are coalesced onto one probe: a Blender launch costs
   * ~1 s, and a page load plus a tool call arriving together must not launch
   * two processes (SPEC §16.4 concurrency discipline).
   *
   * @param {{ refresh?: boolean, signal?: AbortSignal }} [request]
   * @returns {Promise<import('@deepblend/dsh-blender-contracts').BlenderCapabilities>}
   */
  async getCapabilities(request = {}) {
    if (request.refresh === true) this.runtime.invalidateCapabilities()
    if (this._inFlight !== null) return this._inFlight

    const probe = (async () => {
      try {
        return await this.runtime.getCapabilities({
          refresh: request.refresh === true,
          ...request.signal !== undefined ? { signal: request.signal } : {},
        })
      } finally {
        this._inFlight = null
      }
    })()
    this._inFlight = probe
    return probe
  }

  /**
   * The canonical, stable-order view consumed by the model tool and the UI.
   *
   * One projection serves both surfaces so the browser can never disagree with
   * the tool about what Blender can do (SPEC §14.3 "Host 保存权威项目状态").
   *
   * @param {{ refresh?: boolean, signal?: AbortSignal }} [request]
   * @returns {Promise<Record<string, unknown>>}
   */
  async describeCapabilities(request = {}) {
    const capabilities = await this.getCapabilities(request)
    return toCanonicalCapabilities(capabilities)
  }

  /**
   * Drop cached state after a settings change so a corrected `blenderPath`
   * takes effect without a restart (SPEC §17 "配置变化时安全重载").
   */
  reload() {
    this.runtime.invalidateCapabilities()
  }

  // ---------------------------------------------------------------------------
  // Declared-but-unimplemented M1+ surface (SPEC §7.2).
  //
  // Each of these exists so the package boundary is frozen now, and each throws
  // a stable code so no caller — model, UI or test — can mistake absence for
  // success (SPEC §11.1).
  // ---------------------------------------------------------------------------

  /** @returns {never} */
  _notImplemented(operation) {
    throw new BlenderError(
      BlenderErrorCode.UNSUPPORTED_ACTION,
      `blenderStudio.${operation} is not implemented in M0. ` +
        `M0 delivers capability detection only; SceneSpec, revisions and rendering arrive in M1+.`,
      { detail: { operation, milestone: 'M1' } },
    )
  }

  /** @returns {never} */
  createProject() { return this._notImplemented('createProject') }
  /** @returns {never} */
  getProject() { return this._notImplemented('getProject') }
  /** @returns {never} */
  getScene() { return this._notImplemented('getScene') }
  /** @returns {never} */
  applyScenePatch() { return this._notImplemented('applyScenePatch') }
  /** @returns {never} */
  renderPreview() { return this._notImplemented('renderPreview') }
  /** @returns {never} */
  validateScene() { return this._notImplemented('validateScene') }
  /** @returns {never} */
  startFinalRender() { return this._notImplemented('startFinalRender') }
  /** @returns {never} */
  exportProject() { return this._notImplemented('exportProject') }
  /** @returns {never} */
  restoreRevision() { return this._notImplemented('restoreRevision') }
  /** @returns {never} */
  getJob() { return this._notImplemented('getJob') }
  /** @returns {never} */
  cancelJob() { return this._notImplemented('cancelJob') }
}

/**
 * Settings namespace name re-exported for the UI half, which must not import the
 * host implementation merely to learn a string.
 */
export { BLENDER_SETTINGS_NAMESPACE }
