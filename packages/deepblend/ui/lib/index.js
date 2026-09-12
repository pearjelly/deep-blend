/**
 * @deepblend/dsh-blender-ui
 *
 * The DeepBlend **Host half** of the workbench UI (SPEC §5.1, §14).
 *
 * M0 scope is deliberately one surface: a Settings Card data source reporting
 * whether Blender is usable. It is the browser-facing half only — it owns no
 * Blender logic and calls no Blender process itself. Every value it serves comes
 * from the authoritative `blenderStudio` Host service, so a page refresh can
 * always rebuild the card from Host state (SPEC §14.3).
 *
 * The client half (Slot registration, React rendering, tool cards) is M4; this
 * package ships the host route in M0 so the UI package boundary and the
 * authority rule are both established from the first milestone.
 *
 * Owner: DeepBlend Studio — M0
 * Plane: Host composition (Web Client half added in M4)
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

/** Route path serving the settings card document. */
export const CAPABILITIES_ROUTE = '/deepblend/capabilities'

/** Service key for the UI-facing host controller. */
export const BLENDER_UI_SERVICE = 'blenderUi'

/**
 * Configuration schema.
 *
 * Named `UiConfig`, NOT `Config`: the class below declares `static Config`, so a
 * module-scope `Config` would be shadowed inside the class body and
 * `static Config = Config` would throw a temporal-dead-zone ReferenceError at
 * module evaluation.
 */
export const UiConfig = z.object({
  /** Register the HTTP route on the composed web server. */
  serveRoute: z.boolean().default(true),
})

export default class BlenderUiHost extends Service {
  /**
   * `blenderStudio` is a hard dependency: the card has no authority without it.
   *
   * `webServer` is deliberately NOT declared here. It is optional (a headless
   * profile composes none), and it is not guaranteed to be up when this row
   * activates — the UI row necessarily activates *after* `blenderStudio`, which
   * activates after `blenderRuntime` waits on `subprocess`, so the order is not
   * ours to fix. Reading it once in the constructor silently registered no route
   * whenever the server had not started yet, which is why the endpoint answered
   * 404 on a real boot while every service still resolved.
   *
   * `ctx.inject` below is the correct seam: it runs the callback now if the
   * service is already present, and otherwise re-runs it when `webServer`
   * arrives.
   */
  static inject = ['blenderStudio']

  static Config = UiConfig

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('z').infer<typeof UiConfig>} config
   */
  constructor(ctx, config) {
    super(ctx, BLENDER_UI_SERVICE)
    this.config = config
    this._routeDisposer = null

    if (!config.serveRoute) return

    ctx.inject(['webServer'], (serverCtx) => {
      // Route registration belongs to this fiber, so unmounting the row removes
      // the route (SPEC §4.4 / lifecycle: every side effect is reversible).
      const dispose = serverCtx.webServer.register({
        kind: 'prefix',
        path: CAPABILITIES_ROUTE,
        handler: (request, response) => this._handleCapabilities(request, response),
      })
      this._routeDisposer = dispose
      return () => {
        this._routeDisposer = null
        dispose()
      }
    })
  }

  /**
   * Serve the settings-card document.
   *
   * Always responds 200 with a complete payload: a Blender-less machine is a
   * normal state the card must be able to render, not an error page.
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async _handleCapabilities(request, response) {
    const refresh = new URL(request.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'

    /** @type {Record<string, unknown>} */
    let payload
    try {
      const data = await this.ctx.blenderStudio.describeCapabilities({ refresh })
      payload = { ok: true, card: buildSettingsCard(data), data }
    } catch (cause) {
      const error = cause instanceof BlenderError
        ? cause
        : new BlenderError(
          BlenderErrorCode.CAPABILITY_PROBE_FAILED,
          cause instanceof Error ? cause.message : String(cause),
        )
      // A probe failure is still structured, so the card renders the reason
      // instead of the browser showing a transport error.
      payload = { ok: false, card: null, error: error.toJSON() }
    }

    const body = JSON.stringify(payload)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    // Capabilities are a live probe result; a cached copy would let the UI
    // disagree with the tool after a settings change (SPEC §14.3).
    response.setHeader('cache-control', 'no-store')
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  /**
   * The settings-card view model.
   *
   * Kept server-side so the browser holds no derivation logic and the card can
   * never drift from what the tool reports (SPEC §14.3).
   *
   * @param {Record<string, any>} data - canonical capabilities
   * @returns {Record<string, unknown>}
   */
  static buildCard(data) {
    return buildSettingsCard(data)
  }
}

/**
 * Build the settings-card view model from canonical capabilities.
 *
 * @param {Record<string, any>} data
 * @returns {Record<string, unknown>}
 */
export function buildSettingsCard(data) {
  const engines = Object.entries(data?.engines ?? {})
    .filter(([, probe]) => probe?.available)
    .map(([id]) => id)

  return {
    title: 'Blender',
    status: data?.installed ? 'ready' : 'missing',
    statusLabel: data?.installed ? '可用' : '未安装',
    rows: [
      { label: '可执行文件', value: data?.executable?.resolved ?? '未解析到' },
      { label: '配置路径', value: data?.executable?.requested ?? '—' },
      { label: '版本', value: data?.version ?? '—' },
      { label: '内嵌 Python', value: data?.pythonVersion ?? '—' },
      { label: '可用引擎', value: engines.length > 0 ? engines.join(', ') : '无' },
      { label: '首选引擎', value: data?.bestAvailableEngine ?? '—' },
      {
        label: 'GPU',
        value: data?.gpu?.available
          ? `${(data.gpu.devices ?? []).join(', ')}${data.gpu.preferredBackend ? ` (${data.gpu.preferredBackend})` : ''}`
          : '未检测到（CPU 渲染）',
      },
      {
        label: '导入格式',
        value: (data?.formats?.import ?? []).join(', ') || '无',
      },
      {
        label: '导出格式',
        value: (data?.formats?.export ?? []).join(', ') || '无',
      },
      {
        label: '无头渲染自检',
        value: data?.renderSmokeTest
          ? (data.renderSmokeTest.ok
            ? `通过（${data.renderSmokeTest.engine}，${data.renderSmokeTest.bytes} 字节）`
            : `失败${data.renderSmokeTest.error ? `：${data.renderSmokeTest.error}` : ''}`)
          : '—',
      },
    ],
    warnings: (data?.warnings ?? []).map(entry => ({ code: entry.code, message: entry.message })),
    probedAt: data?.probedAt ?? null,
  }
}
