/**
 * @deepblend/dsh-blender-ui — the Web Client half (SPEC §5.1, §14, §20 M6).
 *
 * This file is a **self-registering CJS factory**, which is what the browser's
 * client module system executes (`dsh-client-modules`): the shell loads the
 * bundle as a script, and the only thing the script does is hand a factory to
 * `window.__ModuleLoader__.load`. There is no top-level `import`, no bundler step
 * and no JSX — dependencies arrive through the factory's synchronous `require`,
 * and elements are built through one element vocabulary defined here.
 *
 * That is not a compromise: `docs/probe-m4-client-loop.log` measures this file's
 * own development loop — one line edited here is live in an already-open page in
 * about 600 ms, with no refresh, no restart and no build.
 *
 * ONE BUNDLE, TWO FACES (SPEC §20 M6 「独立全屏工作台」)
 * -----------------------------------------------------
 * The six tabs of the workbench are rendered by ONE implementation, and this file
 * is where it lives:
 *
 *   §C–§H  the React-free core: the element vocabulary, the display helpers, the
 *          framework-free store (state, polling, actions) and the six views, all
 *          of them pure functions returning a **descriptor tree** — plain
 *          `{ tag, props, children }` data, with no React in it anywhere.
 *   §I     two GENERIC bindings of that tree: `toReact` (for the console) and
 *          `toDom` (for the standalone page). Neither knows a single DeepBlend
 *          noun — no tab id, no route, no field name. That is the assertion
 *          `contract/workbench-page.test.mjs` makes, and it is the whole reason
 *          the standalone page is not a second implementation of the workbench.
 *   §K     the DSH console seats, which are React and stay React: the sidebar
 *          entry, the settings page, the tool cards and the session chip.
 *
 * The standalone page at `GET /deepblend/workbench` does NOT get a copy of any of
 * this. Its document (built by the Host half, `./index.js`) carries the ordinary
 * boot injections, and its ~10-line bootstrap calls
 * `window.__ModuleLoader__.create(...)` and imports **this same bundle** out of
 * `window.__DSH_BOOT__` — the very graph row the console loads. `mountStandalone`
 * (§J) is then the only thing that differs between the two faces.
 *
 * What it renders, and where (every seat below is one this package *adds to*; the
 * shipped console is never shadowed):
 *
 *   sidebar.panellist                      the Blender entry (id `deepblend`)
 *   main[key=deepblend]                    the workbench panel: 项目 / 场景树 /
 *                                          预览对比 / 任务 / QA / 版本
 *   settings.section                       the Blender settings page (the M0 card)
 *   tool.call.toolview[key=blender_*]      a card per DeepBlend tool
 *   conversation.session.header.utilities  a live job chip
 *
 * Authority (SPEC §14.3): this half reads and writes through the Host's HTTP
 * routes only. It keeps a mirror of Host state and its own UI selections, and it
 * can start nothing — there is no route that spawns a process.
 *
 * Owner: DeepBlend Studio — M4 (the workbench) / M6 (the standalone face)
 * Plane: Web Client (browser)
 */

window.__ModuleLoader__.load({
  // Must be the PACKAGE NAME: the client module graph addresses this bundle by
  // package identity, and the Host row mounts the same package. The standalone
  // page imports it by this id too, which is what makes "the same bundle" a fact
  // rather than a claim.
  id: '@deepblend/dsh-blender-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // =========================================================================
    // §A  React, read lazily — and only by the console face
    // =========================================================================
    //
    // `react` is a platform SEED WORD: the console's boot supplies it
    // (`PLATFORM_MODULES` in the shell bundle), and the standalone page does not
    // — its `create({ staticModules: {} })` has no seed at all. Reading React at
    // factory time would therefore make this bundle unusable to the standalone
    // page, and reading it here would make the standalone page need React in
    // order to render a page that never calls a hook.
    //
    // So it is read on first use, which happens only inside the console seats in
    // §K. The core in §C–§J never touches it, and `workbench-page.test.mjs`
    // asserts that a factory with a `require` that throws on every specifier can
    // still build and render the whole standalone page.

    let reactModule = null
    /** The React namespace, or a loud failure naming who wanted it. @returns {any} */
    function react() {
      if (reactModule === null) reactModule = require('react')
      return reactModule
    }
    /** `createElement`, spelled as a function so the require stays lazy. */
    const h = (...args) => react().createElement(...args)

    // =========================================================================
    // §B  Vocabulary
    // =========================================================================

    /** The sidebar id, the `main` key, the settings section id and the panel marker. */
    const PANEL_ID = 'deepblend'
    /** Label shown by the sidebar entry, the settings nav and the panel title. */
    const PANEL_LABEL = 'Blender'
    /** The host API this half was written against; a mismatch is a deployment state. */
    const EXPECTED_HOST_API = 4
    /** Polling cadence while something is live; M3 writes progress once a second. */
    const POLL_LIVE_MS = 1500
    /** Polling cadence when nothing is running. */
    const POLL_IDLE_MS = 8000

    const VIEWS = [
      { id: 'projects', label: '项目' },
      { id: 'scene', label: '场景树' },
      { id: 'preview', label: '预览对比' },
      { id: 'jobs', label: '任务' },
      { id: 'qa', label: 'QA' },
      { id: 'revisions', label: '版本' },
    ]

    /** Every DeepBlend wire tool name this package draws a card for. */
    const TOOL_CARD_KEYS = [
      'blender_capabilities', 'blender_project_create', 'blender_project_get',
      'blender_scene_get', 'blender_scene_patch', 'blender_preview_render',
      'blender_scene_validate', 'blender_revision_restore', 'blender_asset_ingest',
      'blender_preview_views', 'blender_visual_review',
      'blender_visual_autofix', 'blender_final_render', 'blender_export',
      'blender_job_status', 'blender_job_cancel',
    ]

    const ROUTES = {
      state: '/deepblend/state',
      projects: '/deepblend/projects',
      capabilities: '/deepblend/capabilities',
      // The one route here that is not fetched by the panel: it is the `href` of the export link in
      // the header, so the BROWSER makes the request and writes the file. `contract/diagnostics.test.mjs`
      // holds these four paths to the route table the Host actually matches.
      diagnostics: '/deepblend/diagnostics',
    }

    /** Route for one project's own surfaces. */
    function projectRoute(projectId, suffix) {
      return `/deepblend/projects/${encodeURIComponent(projectId)}${suffix || ''}`
    }

    /**
     * The URL an artifact is displayed from.
     *
     * The `v` parameter is the artifact's own content digest, and it is
     * load-bearing rather than decorative: a preview is an EMITTED artifact, so
     * re-rendering one replaces the bytes at the SAME path (D28). An `<img>` whose
     * `src` does not change is not re-fetched by the browser, so a panel keyed on
     * the path alone keeps showing the previous render — measured, not assumed
     * (§13.11 of the milestone status: the bytes on disk said red, the panel said
     * otherwise). The digest changes when the picture does, and the browser then
     * has no choice but to fetch it.
     *
     * @param {string} base - the artifact route prefix for this project
     * @param {{ path?: string, sha256?: string|null, bytes?: number|null }} artifact
     */
    function artifactUrl(base, artifact) {
      const path = artifact && artifact.path ? artifact.path : ''
      const version = artifact && artifact.sha256
        ? String(artifact.sha256).slice(0, 12)
        : (artifact && artifact.bytes ? `b${artifact.bytes}` : '0')
      return `${base}${path}?v=${version}`
    }

    /** Short "when was this produced" for an artifact, or null. */
    function artifactTime(artifact) {
      const at = artifact && artifact.at ? artifact.at : null
      return at === null ? null : formatTime(at)
    }

    // =========================================================================
    // §C  Styles. Injected once per document, the way the shipped plugins do it:
    //     one <style> tagged with this package, deduped by querySelector.
    // =========================================================================

    const CSS = `
.db-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.db-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.db-title{font-weight:600}
.db-muted{color:var(--dsw-alias-label-tertiary)}
.db-nav{display:flex;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.db-nav button{background:0 0;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:5px 10px}
.db-nav button:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.db-nav button[data-active=true]{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.db-tabs{display:flex;gap:8px;padding:2px 0 8px;flex:none;flex-wrap:wrap;align-items:center}
.db-body{flex:1;min-height:0;overflow:auto;padding:12px 14px 24px}
.db-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.db-card h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.db-row{display:flex;gap:8px;align-items:baseline;padding:2px 0;line-height:18px}
.db-row>span:first-child{color:var(--dsw-alias-label-tertiary);flex:none;min-width:82px}
.db-row>span:last-child{min-width:0;overflow-wrap:anywhere;font-family:var(--dsw-font-mono);font-size:12px}
.db-btn{background:var(--dsw-alias-fill-l2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;padding:4px 9px}
.db-btn:disabled{opacity:.5;cursor:default}
.db-btn[data-tone=primary]{background:var(--dsw-alias-brand-primary,#3b6ef5);border-color:transparent;color:#fff}
.db-btn[data-tone=danger]{color:var(--dsw-alias-label-error,#e5484d)}
.db-input,.db-area{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:inherit;font:inherit;font-size:12px;padding:5px 8px;width:100%;box-sizing:border-box}
.db-area{font-family:var(--dsw-font-mono);min-height:150px;white-space:pre;overflow:auto}
.db-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.db-badge{border-radius:6px;font-size:11px;line-height:16px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.db-badge[data-tone=ok]{color:var(--dsw-alias-label-success,#2f9e44);border-color:currentColor}
.db-badge[data-tone=warn]{color:var(--dsw-alias-label-warning,#e8a33d);border-color:currentColor}
.db-badge[data-tone=bad]{color:var(--dsw-alias-label-error,#e5484d);border-color:currentColor}
.db-badge[data-tone=live]{color:var(--dsw-alias-brand-primary,#3b6ef5);border-color:currentColor}
.db-bar{background:var(--dsw-alias-fill-l2);border-radius:999px;height:6px;overflow:hidden;width:100%;margin:4px 0}
.db-bar>i{background:var(--dsw-alias-brand-primary,#3b6ef5);display:block;height:100%}
.db-list{list-style:none;margin:0;padding:0}
.db-list>li{border-bottom:1px solid var(--dsw-alias-border-l1);padding:7px 0}
.db-list>li:last-child{border-bottom:0}
.db-kind{color:var(--dsw-alias-label-tertiary);min-width:96px;display:inline-block}
.db-error{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-error,#e5484d);border-radius:10px;color:var(--dsw-alias-label-error,#e5484d);padding:10px 12px;margin-bottom:10px;white-space:pre-wrap}
.db-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.db-shot{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px}
.db-shot img{display:block;width:100%;height:auto;border-radius:6px;background:#000}
.db-shot h5{margin:0 0 6px;font-size:12px;font-weight:600}
.db-chip{display:inline-flex;align-items:center;gap:5px;background:0 0;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:3px 6px}
.db-chip:hover{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary)}
.db-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);display:inline-block}
.db-dot[data-tone=live]{background:var(--dsw-alias-brand-primary,#3b6ef5)}
.db-dot[data-tone=ok]{background:var(--dsw-alias-label-success,#2f9e44)}
.db-dot[data-tone=bad]{background:var(--dsw-alias-label-error,#e5484d)}
.db-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;margin:0}
.db-kv dt{color:var(--dsw-alias-label-tertiary)}
.db-kv dd{margin:0;font-family:var(--dsw-font-mono);overflow-wrap:anywhere}
.db-pre{background:var(--dsw-alias-bg-layer-1);border-radius:8px;font-family:var(--dsw-font-mono);font-size:11px;margin:6px 0 0;max-height:200px;overflow:auto;padding:8px;white-space:pre-wrap}
`

    /**
     * The theme tokens the workbench CSS reads, for a document that has no console.
     *
     * Inside the console these come from the shell's own stylesheets; on the
     * standalone page there is no shell, and every `var(--dsw-alias-…)` would
     * resolve to nothing — the page would render, in the sense that the DOM would
     * be right, and be unreadable, which is not what 「整屏工作台」 means. So the
     * standalone mount installs a fallback set. It is a THEME, not a renderer:
     * no structure, no text, and the console never loads it.
     */
    const STANDALONE_TOKENS = `
:root{color-scheme:light dark;
--dsw-alias-label-primary:#1c1c1e;--dsw-alias-label-secondary:#4a4a4f;--dsw-alias-label-tertiary:#8a8a8f;
--dsw-alias-border-l1:#d9d9de;--dsw-alias-fill-l2:#ececf1;--dsw-alias-bg-layer-1:#f6f6f8;
--dsw-alias-brand-primary:#3b6ef5;--dsw-alias-label-success:#2f9e44;--dsw-alias-label-warning:#b8791b;--dsw-alias-label-error:#d13438;
--dsw-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--dsw-alias-label-primary:#e8e8ea;--dsw-alias-label-secondary:#b6b6bc;--dsw-alias-label-tertiary:#8a8a8f;
--dsw-alias-border-l1:#3a3a40;--dsw-alias-fill-l2:#2a2a30;--dsw-alias-bg-layer-1:#202024;
--dsw-alias-brand-primary:#6f9bff;--dsw-alias-label-success:#4ec46a;--dsw-alias-label-warning:#e8a33d;--dsw-alias-label-error:#ff6b6f}}
`

    /** Install one `<style>`, once per document, deduped by its own tag id. */
    function injectStyleTag(doc, tagId, css) {
      if (doc === undefined || doc === null) return
      if (doc.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = doc.createElement('style')
      tag.dataset.plugin = '@deepblend/dsh-blender-ui'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      doc.head.appendChild(tag)
    }

    /** The workbench stylesheet. @param {Document} [doc] */
    function injectStyles(doc) {
      injectStyleTag(doc ?? (typeof document === 'undefined' ? null : document), '@deepblend/dsh-blender-ui/workbench.css', CSS)
    }

    /** The standalone theme fallback. Only `mountStandalone` calls this. @param {Document} doc */
    function injectStandaloneTokens(doc) {
      injectStyleTag(doc, '@deepblend/dsh-blender-ui/standalone-tokens.css', STANDALONE_TOKENS)
    }

    // =========================================================================
    // §D  The element vocabulary
    // =========================================================================
    //
    // A node is either a string (text) or `{ tag, props, children }`. Nothing
    // here knows what React is; §I is where a node becomes a React element or a
    // DOM node, and those two are the only places that know about either.

    /** Build one node. @returns {{ tag: string|Function, props: object, children: any[] }} */
    function el(tag, props, ...children) {
      return { tag, props: props === null || props === undefined ? {} : props, children: flatten(children) }
    }

    /** Drop the empties a conditional produces, and splice nested arrays. @param {any[]} list */
    function flatten(list) {
      const out = []
      for (const item of list) {
        if (item === null || item === undefined || item === false || item === true) continue
        if (Array.isArray(item)) { out.push(...flatten(item)); continue }
        out.push(item)
      }
      return out
    }

    /**
     * The shared pieces, as ordinary functions returning nodes.
     *
     * They take a props object with `children`, the way a component does, and
     * they are CALLED by the views rather than handed to a renderer as a tag —
     * so a typo is a missing call, not a blank cell. `toReact`/`toDom` refuse a
     * function tag loudly for the same reason.
     */

    function Badge(props) {
      return el('span', { className: 'db-badge', 'data-tone': props.tone || 'muted', 'data-badge': props.name || undefined }, props.children)
    }

    function Row(props) {
      return el('div', { className: 'db-row' },
        el('span', null, props.label),
        el('span', null, props.value === null || props.value === undefined || props.value === '' ? '—' : String(props.value)))
    }

    function Button(props) {
      return el('button', {
        type: 'button',
        className: 'db-btn',
        'data-tone': props.tone,
        'data-action': props.action,
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    function ErrorBox(props) {
      if (props.error === null || props.error === undefined) return null
      return el('div', { className: 'db-error', 'data-deepblend-error': props.error.code || 'error' },
        el('div', null, `${props.error.code || 'ERROR'}: ${props.error.message || ''}`),
        props.error.detail ? el('pre', { className: 'db-pre' }, JSON.stringify(props.error.detail, null, 2)) : null)
    }

    function ProgressBar(props) {
      const percent = Math.max(0, Math.min(100, Number(props.percent) || 0))
      return el('div', { className: 'db-bar', 'data-progress': String(percent) }, el('i', { style: { width: `${percent}%` } }))
    }

    /** A definition list, used by the settings page and the revision summary. */
    function KeyValues(props) {
      const entries = (props.entries || []).filter(entry => entry !== null && entry !== undefined)
      return el('dl', { className: 'db-kv' }, entries.flatMap((entry, index) => [
        el('dt', { key: `k${index}` }, entry.label),
        el('dd', { key: `v${index}` }, entry.value === null || entry.value === undefined || entry.value === '' ? '—' : String(entry.value)),
      ]))
    }

    // =========================================================================
    // §E  Display helpers
    // =========================================================================

    /** Shorten a digest for display without losing which digest it is. */
    function shortDigest(value) {
      return typeof value === 'string' && value.length > 12 ? `${value.slice(0, 12)}…` : (value || '—')
    }

    /** A timestamp a human reads at a glance. */
    function formatTime(value) {
      if (value === null || value === undefined || value === '') return '—'
      const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleTimeString()
    }

    function statusTone(status) {
      if (status === 'completed') return 'ok'
      if (status === 'failed') return 'bad'
      if (status === 'cancelled') return 'warn'
      if (status === 'queued' || status === 'running' || status === 'stopping' || status === 'recovering') return 'live'
      return 'muted'
    }

    /** A value that is a finite number, or undefined. @param {unknown} value */
    function numberOrUndefined(value) {
      if (value === undefined || value === null || value === '') return undefined
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }

    // =========================================================================
    // §F  Talking to the Host
    // =========================================================================

    /**
     * The one place this half notices a deployment older than itself.
     *
     * Both shapes a stale Host produces are covered, because MEASURED against the
     * process that was really running (the M0-era UI half, still serving on 3080):
     *
     *   GET /deepblend/capabilities   → 200 with the settings card, and no `route`
     *                                   field (its route is registered as a PREFIX
     *                                   of that one path, so every sub-path of it
     *                                   answers the same card)
     *   GET /deepblend/state          → 404 with an EMPTY body: no content type,
     *                                   nothing to parse
     *
     * The first is a successful wrong answer, the second is not JSON at all, and a
     * panel that only checked `ok` or only caught a parse error would report the
     * wrong problem in one of the two cases. So both end up here.
     *
     * @param {string} expectedRoute
     * @param {{ status?: number, detail?: string, payload?: any }} observed
     */
    function staleHostError(expectedRoute, observed) {
      const version = observed && observed.payload && observed.payload.hostApiVersion
        ? observed.payload.hostApiVersion
        : '未知'
      const detail = observed && observed.detail ? `观察到的响应：${observed.detail}。` : ''
      return {
        code: 'UI_HOST_API_STALE',
        message:
          `本进程里的 blenderUi 比磁盘上的包旧：/deepblend/${expectedRoute} 没有被这一版的宿主回答` +
          `（${detail}hostApiVersion=${version}，本 UI 需要 ${EXPECTED_HOST_API}）。` +
          '重启 profile（dsh web）即可。',
      }
    }

    /**
     * Read one Host route once, with the stale-deployment diagnosis applied.
     *
     * A page refresh re-runs exactly this, which is why the panel rebuilds itself
     * from the Host (SPEC §20 M4 「UI 刷新后可从 Host 恢复权威状态」) — and why the
     * standalone page inherits that property for free.
     *
     * @param {typeof fetch} fetchImpl
     * @param {string} path
     * @param {string|null} expectedRoute
     * @returns {Promise<{ status: 'ok'|'error'|'stale', payload: any, error: any }>}
     */
    async function readRoute(fetchImpl, path, expectedRoute) {
      try {
        const response = await fetchImpl(path, { headers: { accept: 'application/json' } })
        const text = await response.text()
        let payload = null
        try {
          payload = text.length === 0 ? null : JSON.parse(text)
        } catch {
          payload = null
        }
        // A route this half declared but the running Host does not serve: either
        // a body with the wrong identity, or a response that is not ours at all.
        if (expectedRoute !== null && (payload === null || payload.route !== expectedRoute)) {
          return {
            status: 'stale',
            payload: null,
            error: staleHostError(expectedRoute, {
              payload,
              status: response.status,
              detail: payload === null
                ? `HTTP ${response.status}，${text.length} 字节，非 JSON`
                : `route=${JSON.stringify(payload.route)}`,
            }),
          }
        }
        if (payload && payload.ok) return { status: 'ok', payload, error: null }
        return {
          status: 'error',
          payload: null,
          error: (payload && payload.error) || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` },
        }
      } catch (error) {
        return { status: 'error', payload: null, error: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } }
      }
    }

    /** POST a JSON body and return the parsed payload. Errors come back as data. */
    async function postJson(fetchImpl, path, body) {
      try {
        const response = await fetchImpl(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const payload = await response.json()
        if (payload && payload.ok) return { ok: true, payload }
        return { ok: false, error: (payload && payload.error) || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` } }
      } catch (error) {
        return { ok: false, error: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } }
      }
    }

    // =========================================================================
    // §G  The store: the workbench's state, its polling and its actions
    // =========================================================================
    //
    // Framework-free on purpose. Both faces subscribe to the same object, so
    // "what the workbench is showing" and "what a click does" are decided once —
    // the console only differs in HOW it draws the snapshot, never in what the
    // snapshot is. Local UI state (which tab, which project, the compare pair,
    // the half-typed patch) lives here too, exactly as SPEC §14.3 draws the line:
    // it decides what is DISPLAYED, never what is TRUE.

    /** A blank snapshot, so `getState()` always answers the same shape. */
    function emptySnapshot() {
      return {
        status: 'loading',
        error: null,
        hostApiVersion: null,
        projects: [],
        projectsRoot: null,
        selected: null,
        currentRevision: null,
        jobs: [],
        unfinishedJobs: [],
        previews: null,
        artifactBase: '',
        view: 'projects',
        projectId: null,
        activeProjectId: null,
        compareLeft: null,
        compareRight: null,
        compareMode: 'renders',
        diff: null,
        diffError: null,
        previewBusy: false,
        forms: { title: '', goal: '', patch: null, frameStart: '', frameEnd: '', profile: 'preview' },
        busy: { create: false, patch: false, render: false, restore: false },
        notices: { projects: null, scene: null, preview: null, jobs: null, revisions: null },
      }
    }

    /**
     * Build the workbench store.
     *
     * @param {{ fetch?: typeof fetch, pollLiveMs?: number, pollIdleMs?: number }} [options]
     */
    function createWorkbenchStore(options) {
      const settings = options || {}
      const fetchImpl = settings.fetch ?? ((...args) => fetch(...args))
      const pollLiveMs = settings.pollLiveMs ?? POLL_LIVE_MS
      const pollIdleMs = settings.pollIdleMs ?? POLL_IDLE_MS

      let data = emptySnapshot()
      let snapshot = { ...data }
      const listeners = new Set()
      let timer = null
      let tick = 0
      let live = false

      const notify = () => {
        snapshot = { ...data, forms: { ...data.forms }, busy: { ...data.busy }, notices: { ...data.notices } }
        for (const listener of [...listeners]) listener(snapshot)
      }
      /** Change the snapshot and tell everyone. @param {object} patch */
      const set = (patch) => { data = { ...data, ...patch }; notify() }
      /** Change one nested table. @param {'forms'|'busy'|'notices'} table @param {string} key @param {any} value */
      const setIn = (table, key, value) => { data = { ...data, [table]: { ...data[table], [key]: value } }; notify() }

      /** The project every per-project route is addressed to. */
      const target = () => data.projectId ?? (data.projects[0] ? data.projects[0].projectId : null)

      /** Read everything the panel shows, in one pass. */
      const load = async () => {
        const projectId = target()
        const statePath = projectId === null ? ROUTES.state : `${ROUTES.state}?projectId=${encodeURIComponent(projectId)}`
        const stateResult = await readRoute(fetchImpl, `${statePath}${statePath.includes('?') ? '&' : '?'}t=${tick}`, 'state')
        if (stateResult.status !== 'ok') {
          set({ status: stateResult.status, error: stateResult.error, hostApiVersion: stateResult.payload ? stateResult.payload.hostApiVersion : null })
          return
        }
        const payload = stateResult.payload
        const active = projectId !== null ? projectId : (payload.projects && payload.projects[0] ? payload.projects[0].projectId : null)
        const patch = {
          status: 'ok',
          error: null,
          hostApiVersion: payload.hostApiVersion ?? null,
          projects: payload.projects || [],
          projectsRoot: payload.projectsRoot ?? null,
          selected: payload.selected ?? null,
          activeProjectId: active,
          currentRevision: payload.selected ? payload.selected.currentRevision : null,
          jobs: payload.selected ? payload.selected.jobs || [] : [],
          unfinishedJobs: payload.selected ? payload.selected.unfinishedJobs || [] : [],
        }
        live = patch.unfinishedJobs.length > 0

        if (active !== null) {
          const jobsResult = await readRoute(fetchImpl, `${projectRoute(active, '/jobs')}?t=${tick}`, 'project.jobs')
          if (jobsResult.status === 'ok') {
            patch.jobs = jobsResult.payload.jobs || []
            patch.unfinishedJobs = jobsResult.payload.unfinished || []
            live = patch.unfinishedJobs.length > 0
          } else if (jobsResult.status === 'stale') {
            patch.status = 'stale'
            patch.error = jobsResult.error
          }
          const previewResult = await readRoute(fetchImpl, `${projectRoute(active, '/previews')}?t=${tick}`, 'project.previews')
          if (previewResult.status === 'ok') {
            patch.previews = previewResult.payload.previews ?? null
            patch.artifactBase = previewResult.payload.artifactBase ?? ''
          } else if (previewResult.status === 'stale') {
            patch.status = 'stale'
            patch.error = previewResult.error
          }
        } else {
          patch.previews = null
          patch.artifactBase = ''
        }
        set(patch)
        arm()
      }

      /** Poll at the cadence the current state deserves. */
      const arm = () => {
        if (timer !== null) { clearInterval(timer); timer = null }
        if (!running) return
        timer = setInterval(() => { void load() }, live ? pollLiveMs : pollIdleMs)
      }

      let running = false

      /** A write just happened: re-run every read, including the view-specific ones. */
      const reload = () => { tick += 1; void load() }

      /** Run one write, report it in this view's notice, then reload. */
      const write = async (view, path, body, describe) => {
        const outcome = await postJson(fetchImpl, path, body)
        setIn('notices', view, outcome.ok ? describe(outcome.payload) : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        reload()
        return outcome
      }

      const actions = {
        /**
         * Switch tabs, and drop the notice the tab being ENTERED was carrying.
         *
         * The notice reports something that happened while a person was looking at
         * that view, and a view you left is not the view it happened in. In the
         * console this used to fall out of the view being a component that
         * unmounted; the store is shared by two faces now, so it has to be SAID
         * rather than inherited — and it is not cosmetic: a stale 「已提交 r0002」
         * still on screen after a tab round-trip reads as the result of the edit
         * you just made. Clicking the tab you are already on is not a re-entry, so
         * it clears nothing.
         */
        setView: (view) => (view === data.view ? undefined : set({ view, notices: { ...data.notices, [view]: null } })),
        selectProject: (projectId) => set({ projectId, diff: null, diffError: null, compareLeft: null, compareRight: null }),
        reload,
        setForm: (field, value) => setIn('forms', field, value),
        setCompareMode: (compareMode) => set({ compareMode }),
        pickCompare: (side, revision) => set(side === 'left'
          ? { compareLeft: revision, diff: null, diffError: null }
          : { compareRight: revision, diff: null, diffError: null }),
        /** Hand off from 版本 to 预览对比 with that revision on the left. */
        compareFrom: (revision) => set({ compareLeft: revision, view: 'preview' }),

        diff: async (from, to) => {
          set({ diffError: null })
          try {
            const response = await fetchImpl(`${projectRoute(target(), '/diff')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: { accept: 'application/json' } })
            const parsed = await response.json()
            if (parsed && parsed.ok) set({ diff: parsed.diff })
            else set({ diff: null, diffError: (parsed && parsed.error) || { code: `HTTP_${response.status}`, message: 'diff 失败' } })
          } catch (error) {
            set({ diff: null, diffError: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } })
          }
        },

        createProject: async () => {
          setIn('busy', 'create', true)
          const outcome = await postJson(fetchImpl, ROUTES.projects, {
            title: data.forms.title,
            goal: data.forms.goal.length > 0 ? data.forms.goal : undefined,
          })
          setIn('busy', 'create', false)
          if (outcome.ok) {
            set({ forms: { ...data.forms, title: '', goal: '' }, projectId: outcome.payload.project.projectId })
            setIn('notices', 'projects', { ok: true, message: `已创建 ${outcome.payload.project.projectId}` })
            reload()
          } else {
            setIn('notices', 'projects', { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          }
        },

        applyPatch: async () => {
          const text = data.forms.patch
          let patch
          try {
            patch = JSON.parse(text)
          } catch (error) {
            setIn('notices', 'scene', { ok: false, message: `patch 不是合法 JSON：${error.message}` })
            return
          }
          setIn('busy', 'patch', true)
          const outcome = await postJson(fetchImpl, projectRoute(target(), '/patch'), { patch })
          setIn('busy', 'patch', false)
          if (outcome.ok) {
            setIn('notices', 'scene', { ok: true, message: `已提交 ${outcome.payload.revision.revision}（digest ${shortDigest(outcome.payload.revision.digest)}）` })
            setIn('forms', 'patch', null)
            reload()
          } else {
            setIn('notices', 'scene', { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          }
        },

        renderPreview: async () => {
          set({ previewBusy: true, previewResult: null })
          const outcome = await postJson(fetchImpl, projectRoute(target(), '/preview'), {})
          set({ previewBusy: false })
          set({
            previewResult: outcome.ok
              ? {
                ok: true,
                message: `已渲染 ${outcome.payload.preview.views.length} 个视角 → 合成 ${outcome.payload.preview.revision} 的 contact sheet`
                  + (outcome.payload.preview.sheets && outcome.payload.preview.sheets.previous
                    ? '；上一张已留作「上一次渲染」，可以直接并排比较'
                    : '（这是第一张；再渲染一次就能并排比较前后）')
                  + '。预览是产物：替换同一路径上的旧图，不产生新的 revision。',
              }
              : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` },
          })
          reload()
        },

        startRender: async (resumeJobId) => {
          setIn('busy', 'render', true)
          const outcome = await postJson(fetchImpl, projectRoute(target(), '/render'), {
            resumeJobId,
            frameStart: data.forms.frameStart === '' ? undefined : Number(data.forms.frameStart),
            frameEnd: data.forms.frameEnd === '' ? undefined : Number(data.forms.frameEnd),
            profile: resumeJobId === undefined ? data.forms.profile : undefined,
          })
          setIn('busy', 'render', false)
          setIn('notices', 'jobs', outcome.ok
            ? { kind: 'render', ok: true, message: `任务 ${outcome.payload.job.jobId} 已启动（${outcome.payload.job.frames || '?'} 帧）` }
            : { kind: 'render', ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },

        cancelJob: async (jobId) => {
          setIn('busy', 'render', true)
          const outcome = await postJson(fetchImpl, projectRoute(target(), `/jobs/${encodeURIComponent(jobId)}/cancel`), {})
          setIn('busy', 'render', false)
          setIn('notices', 'jobs', outcome.ok
            ? {
              kind: 'cancel',
              ok: outcome.payload.cancelled.processGone !== false,
              message: outcome.payload.cancelled.processGone === false
                ? '取消已请求，但进程仍在'
                : `已取消 ${jobId}，进程实测已消失`,
            }
            : { kind: 'cancel', ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },

        restoreRevision: async (revision) => {
          setIn('busy', 'restore', true)
          const outcome = await postJson(fetchImpl, projectRoute(target(), '/restore'), { revision })
          setIn('busy', 'restore', false)
          setIn('notices', 'revisions', outcome.ok
            ? { ok: true, message: `已恢复 ${revision} 为 ${outcome.payload.revision.revision}` }
            : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
          reload()
        },
      }

      return {
        getState: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        /** Begin reading, and keep reading while something is live. */
        start() {
          if (running) return
          running = true
          void load()
        },
        stop() {
          running = false
          if (timer !== null) { clearInterval(timer); timer = null }
        },
        actions,
        /** The console's write helper, kept reachable for the tool cards. */
        readRoute: (path, route) => readRoute(fetchImpl, path, route),
      }
    }

    // =========================================================================
    // §H  The six tabs — THE implementation
    // =========================================================================
    //
    // Every function below is a pure function of the snapshot (plus the action
    // table), and every one of them returns a node. Nothing in this section
    // touches React, the DOM, or the network.

    /** 项目: the list, the create form, and the selected project's summary. */
    function ProjectsView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      return el('div', { 'data-view': 'projects' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('h4', null, '项目'),
          state.projects.length === 0
            ? el('div', { className: 'db-muted' }, '这个工作区还没有项目。')
            : el('ul', { className: 'db-list' }, state.projects.map(project => el('li', { key: project.projectId, 'data-project': project.projectId },
              el('div', { className: 'db-inline' },
                Button({
                  tone: project.projectId === state.activeProjectId ? 'primary' : undefined,
                  action: `select-project:${project.projectId}`,
                  onClick: () => actions.selectProject(project.projectId),
                  children: project.title || project.projectId,
                }),
                el('span', { className: 'db-muted db-mono' }, project.projectId),
                project.unfinishedJobs > 0 ? Badge({ tone: 'live', name: 'unfinished', children: `${project.unfinishedJobs} 个任务在跑` }) : null,
                el('span', { className: 'db-muted' }, `${project.revisionCount} 个 revision`),
              ),
              el('div', { className: 'db-muted db-mono' }, `当前 ${project.currentRevision || '—'} · 更新于 ${formatTime(project.updatedAt)}`),
              project.goal ? el('div', { className: 'db-muted' }, project.goal) : null,
            ))),
          el('div', { className: 'db-muted db-mono', style: { marginTop: '6px' } }, `projectsRoot: ${state.projectsRoot || '—'}`),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, '新建项目（写操作经 Host）'),
          el('div', { className: 'db-inline' },
            el('input', {
              className: 'db-input',
              'data-field': 'project-title',
              placeholder: '标题，例如 watch-commercial',
              value: state.forms.title,
              onChange: event => actions.setForm('title', event.target.value),
            }),
            el('input', {
              className: 'db-input',
              'data-field': 'project-goal',
              placeholder: '目标（可选）',
              value: state.forms.goal,
              onChange: event => actions.setForm('goal', event.target.value),
            }),
            Button({
              tone: 'primary',
              action: 'create-project',
              disabled: state.busy.create || state.forms.title.trim().length === 0,
              onClick: actions.createProject,
              children: state.busy.create ? '创建中…' : '创建',
            }),
          ),
          state.notices.projects ? Notice(state.notices.projects, { marginTop: '8px' }) : null,
        ),

        state.selected ? el('div', { className: 'db-card' },
          el('h4', null, `当前项目：${state.selected.project.title}`),
          KeyValues({ entries: [
            { label: 'projectId', value: state.selected.project.projectId },
            { label: '当前 revision', value: state.selected.currentRevision },
            { label: 'revision 数', value: state.selected.project.revisionCount },
            { label: 'digest', value: shortDigest(state.selected.scene.digest) },
            { label: '帧范围', value: `${state.selected.scene.project.frameStart}–${state.selected.scene.project.frameEnd} @ ${state.selected.scene.project.fps}fps` },
            { label: '活动相机', value: state.selected.scene.project.activeCamera },
            { label: '对象 / 材质 / 灯 / 相机', value: [
              state.selected.scene.counts.entities, state.selected.scene.counts.materials,
              state.selected.scene.counts.lights, state.selected.scene.counts.cameras,
            ].join(' / ') },
          ] }),
          el('div', { className: 'db-muted', style: { marginTop: '6px' } }, state.selected.qa.summary),
        ) : el('div', { className: 'db-card db-muted' }, '尚未选择项目。'),
      )
    }

    /** A result line, in the two shapes the panel already used. */
    function Notice(result, style) {
      if (result === null || result === undefined) return null
      return el('div', {
        'data-result': result.ok ? 'ok' : 'error',
        'data-result-kind': result.kind || undefined,
        className: result.ok ? 'db-muted' : 'db-error',
        style: style || undefined,
      }, result.message)
    }

    /** 场景树: the Scene Tree of the revision in view. */
    function SceneView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      const scene = state.selected ? state.selected.scene : null
      if (scene === null) return el('div', { 'data-view': 'scene', className: 'db-muted' }, '尚未选择项目。')

      const template = JSON.stringify({
        baseRevision: state.selected.currentRevision,
        operations: [{
          op: 'entity.transform.update',
          entityId: (scene.nodes.entities[0] || {}).id || 'entity-id',
          rotationEuler: [0, 0, 0.12],
        }],
      }, null, 2)
      const text = state.forms.patch === null ? template : state.forms.patch

      const section = (title, items, render) => el('div', { className: 'db-card', key: title },
        el('h4', null, `${title}（${items.length}）`),
        items.length === 0
          ? el('div', { className: 'db-muted' }, '空')
          : el('ul', { className: 'db-list' }, items.map(item => el('li', { key: item.id }, render(item)))))

      return el('div', { 'data-view': 'scene' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('div', { className: 'db-inline' },
            el('strong', null, String(scene.project.title || scene.project.id || '')),
            Badge({ children: scene.revision }),
            el('span', { className: 'db-muted db-mono' }, `digest ${shortDigest(scene.digest)}`),
            Badge({ children: `world ${scene.world ? `${(scene.world.color || []).join(',')} × ${scene.world.strength}` : '默认'}` }),
          ),
        ),
        el('div', { className: 'db-grid' },
          section('实体 entities', scene.nodes.entities, entity => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `entity:${entity.id}` }, entity.id), ' ',
            el('span', { className: 'db-kind' }, entity.shape || entity.kind),
            entity.materialId ? el('span', { className: 'db-muted' }, `材质 ${entity.materialId}`) : null,
            entity.locked ? Badge({ tone: 'warn', children: 'locked' }) : null,
            entity.tags.length > 0 ? el('span', { className: 'db-muted db-mono' }, ` tags=[${entity.tags.join(' ')}]`) : null,
            entity.transform ? el('div', { className: 'db-muted db-mono' }, `loc ${(entity.transform.location || []).map(value => Number(value).toFixed(3)).join(', ')}`) : null)),
          section('材质 materials', scene.nodes.materials, material => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `material:${material.id}` }, material.id), ' ',
            el('span', { className: 'db-kind' }, material.shader),
            material.parameters ? el('span', { className: 'db-muted db-mono' }, Object.entries(material.parameters).slice(0, 4).map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(',')}]` : value}`).join(' ')) : null)),
          section('灯光 lights', scene.nodes.lights, light => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `light:${light.id}` }, light.id), ' ',
            el('span', { className: 'db-kind' }, light.type),
            el('span', { className: 'db-muted' }, `energy ${light.energy}`))),
          section('相机 cameras', scene.nodes.cameras, camera => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `camera:${camera.id}` }, camera.id), ' ',
            camera.isActive ? Badge({ tone: 'ok', children: 'active' }) : null, ' ',
            el('span', { className: 'db-kind' }, camera.role || 'no role'),
            el('span', { className: 'db-muted' }, `lens ${camera.lens}`))),
          section('镜头 shots', scene.nodes.shots, shot => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `shot:${shot.id}` }, shot.id), ' ',
            el('span', { className: 'db-muted' }, `${shot.cameraId} ${(shot.frameRange || []).join('–')}`))),
          section('动画轨道 animationTracks', scene.nodes.animationTracks, track => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `track:${track.id}` }, track.id), ' ',
            el('span', { className: 'db-kind' }, track.targetKind),
            el('span', { className: 'db-muted' }, `${track.targetId} · ${track.property} · ${track.keyframes} 关键帧`))),
          section('资产 assets', scene.nodes.assets, asset => el('div', null,
            el('span', { className: 'db-mono', 'data-node': `asset:${asset.id}` }, asset.id), ' ',
            el('span', { className: 'db-kind' }, asset.type),
            el('span', { className: 'db-muted db-mono' }, String(asset.path || '')))),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, 'ScenePatch（写操作经 Host，原子提交为一个 revision）'),
          el('textarea', {
            className: 'db-area',
            'data-field': 'scene-patch',
            value: text,
            spellCheck: false,
            onChange: event => actions.setForm('patch', event.target.value),
          }),
          el('div', { className: 'db-inline', style: { marginTop: '8px' } },
            Button({
              tone: 'primary',
              action: 'apply-patch',
              disabled: state.busy.patch || state.activeProjectId === null,
              onClick: actions.applyPatch,
              children: state.busy.patch ? '提交中…' : '提交',
            }),
            Button({ action: 'reset-patch', onClick: () => actions.setForm('patch', null), children: '重置模板' }),
            Notice(state.notices.scene, { border: 0, padding: '0 6px', marginBottom: 0 }),
          ),
        ),
      )
    }

    /**
     * The newest image to show for a revision.
     *
     * Order of preference: the sheet THIS panel's render just composed, then any
     * contact sheet (a review's), then the newest single view. The artifact is
     * passed through WHOLE with a display label added: an earlier version built a
     * fresh `{ path, kind }` here and threw away the digest and the timestamp —
     * which is how the panel ended up keyed on the path alone and showing a stale
     * render (§13.5B).
     */
    function sheetOf(entry) {
      if (entry === null) return null
      const sheets = entry.contactSheets || []
      const current = sheets.find(sheet => sheet.slot === 'preview-current')
      if (current && current.path) return { ...current, label: '本次渲染' }
      const sheet = sheets[sheets.length - 1]
      if (sheet && sheet.path) return { ...sheet, label: 'contact sheet' }
      const list = entry.previews || []
      const preview = list[list.length - 1]
      if (preview && preview.path) return { ...preview, label: preview.kind || 'preview' }
      return null
    }

    /**
     * The pair a render leaves behind: what it just composed, and what came before.
     *
     * "Before" is the previous generation of the SAME revision when there is one.
     * When there is not — which is the case on the first render after a scene
     * change, and therefore the case the comparison exists for — it falls back to
     * the newest render of an older revision. Without that fallback the axis is
     * empty exactly when a person wants it: they changed something, rendered once,
     * and the left pane would say "nothing to compare yet" while the picture they
     * want to compare against is sitting one revision back.
     *
     * The pane labels say which revision each side came from, so a cross-revision
     * pair cannot be mistaken for two renders of one scene.
     */
    function renderPairOf(entry, allRevisions) {
      if (entry === null) return { current: null, previous: null }
      const sheets = entry.contactSheets || []
      const current = sheets.find(sheet => sheet.slot === 'preview-current') ?? null
      let previous = sheets.find(sheet => sheet.slot === 'preview-previous') ?? null
      let previousRevision = entry.revision
      if (previous === null) {
        const index = allRevisions.findIndex(candidate => candidate.revision === entry.revision)
        const older = (index > 0 ? allRevisions.slice(0, index) : []).reverse()
          .find(candidate => (candidate.contactSheets || []).some(sheet => sheet.slot === 'preview-current'))
        if (older !== undefined) {
          previous = (older.contactSheets || []).find(sheet => sheet.slot === 'preview-current')
          previousRevision = older.revision
        }
      }
      return {
        current: current === null ? null : { ...current, label: '本次渲染', sourceRevision: entry.revision },
        previous: previous === null ? null : { ...previous, label: '上一次渲染', sourceRevision: previousRevision },
      }
    }

    /** 预览对比: two revisions' contact sheets side by side. */
    function PreviewView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      const previews = state.previews
      if (previews === null) return el('div', { 'data-view': 'preview', className: 'db-muted' }, '尚未选择项目。')
      const revisions = previews.revisions
      const pick = wanted => (revisions.some(entry => entry.revision === wanted) ? wanted : (((revisions[revisions.length - 1] || {}).revision) || null))
      const left = pick(state.compareLeft || state.currentRevision)
      const right = pick(state.compareRight || state.currentRevision)
      const entryOf = id => revisions.find(entry => entry.revision === id) || null

      /** One image (or the reason there is none), with its digest and its time. */
      const imagePane = (side, title, artifact, missing) => {
        const when = artifactTime(artifact)
        return el('div', { className: 'db-shot', 'data-compare': side, 'data-compare-kind': artifact === null ? 'empty' : 'image' },
          el('h5', null, title),
          artifact === null
            ? el('div', { className: 'db-muted' }, missing)
            : [
              el('img', {
                key: 'img',
                'data-artifact': artifact.path,
                'data-artifact-digest': artifact.sha256 || '',
                'data-artifact-slot': artifact.slot || '',
                'data-artifact-revision': artifact.sourceRevision || '',
                'data-artifact-at': artifact.at || '',
                alt: `${title} ${artifact.path}`,
                src: artifactUrl(state.artifactBase, artifact),
              }),
              el('div', { className: 'db-muted db-mono', key: 'meta' },
                `${artifact.sourceRevision ? `${artifact.sourceRevision} ` : ''}${artifact.slot ? artifact.slot : (artifact.kind || 'artifact')} · ${artifact.sha256 ? String(artifact.sha256).slice(0, 10) : '—'}${when === null ? '' : ` · 渲染于 ${when}`}`),
            ].filter(Boolean))
      }

      const revisionMeta = entry => el('div', { className: 'db-muted', key: 'meta' }, `${entry.summary || '（无说明）'} · ${formatTime(entry.createdAt)}`)

      /** The revision axis: two revisions side by side, each one's newest image. */
      const revisionPane = (entry, side) => el('div', { className: 'db-shot', 'data-compare': side },
        el('h5', null, entry === null ? '—' : `${entry.revision}${entry.isCurrent ? ' (当前)' : ''}`),
        entry === null
          ? el('div', { className: 'db-muted' }, '没有这个 revision')
          : [
            revisionMeta(entry),
            (() => {
              const sheet = sheetOf(entry)
              return sheet === null
                ? el('div', { className: 'db-muted', key: 'none' }, '这个 revision 还没有预览图（渲染一次预览即可）。')
                : el('img', {
                  key: 'img',
                  'data-artifact': sheet.path,
                  'data-artifact-digest': sheet.sha256 || '',
                  'data-artifact-slot': sheet.slot || '',
                  'data-artifact-revision': entry.revision,
                  'data-artifact-at': sheet.at || '',
                  alt: `${entry.revision} ${sheet.label}`,
                  src: artifactUrl(state.artifactBase, sheet),
                })
            })(),
            (() => {
              const sheet = sheetOf(entry)
              const when = artifactTime(sheet)
              return sheet === null ? null : el('div', { className: 'db-muted db-mono', key: 'sheet' },
                `${sheet.sha256 ? String(sheet.sha256).slice(0, 10) : '—'}${when === null ? '' : ` · 渲染于 ${when}`}`)
            })(),
            el('div', { className: 'db-muted db-mono', key: 'counts' }, `previews ${(entry.previews || []).length} · sheets ${(entry.contactSheets || []).length} · reviews ${(entry.reviews || []).length}`),
            (entry.reviews || []).length > 0
              ? el('div', { key: 'score' }, Badge({
                tone: entry.reviews[entry.reviews.length - 1].pass ? 'ok' : 'warn',
                children: `review ${entry.reviews[entry.reviews.length - 1].score === undefined ? '—' : entry.reviews[entry.reviews.length - 1].score} 分`,
              }))
              : null,
          ].filter(Boolean))

      // Two axes, because two different questions get asked here:
      //
      //   renders   「我刚渲的这一张，和上一张比，变了什么？」 — same revision, one
      //             generation apart. This is the default, because it is the question
      //             a person has right after clicking render, and because a preview
      //             render does not create a revision, so the revision axis could not
      //             express it at all (§13.5B).
      //   revisions 「这个版本和那个版本比，变了什么？」 — the axis SPEC §14.2 and the
      //             M4 brief describe, kept because it is the one that survives a
      //             scene change.
      const pair = renderPairOf(entryOf(right), revisions)
      const rendersMode = state.compareMode !== 'revisions'
      const renderPairPanes = [
        imagePane('left', pair.previous === null ? '上一次渲染' : `上一次渲染 · ${pair.previous.sourceRevision}`, pair.previous,
          '还没有上一次渲染：再点一次「渲染预览」，或者先在某个更早的 revision 上渲一次。'),
        imagePane('right', `本次渲染 · ${right}`, pair.current,
          '这个 revision 还没有由面板渲过预览（上方的「渲染预览」会生成第一张）。'),
      ]

      return el('div', { 'data-view': 'preview' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-tabs' },
          Button({
            tone: 'primary',
            action: 'render-preview',
            disabled: state.previewBusy || state.activeProjectId === null,
            onClick: actions.renderPreview,
            children: state.previewBusy ? '渲染中…' : '渲染预览',
          }),
          Notice(state.previewResult, { border: 0, padding: '0 6px', marginBottom: 0 }),
        ),
        el('div', { className: 'db-tabs' },
          el('span', { className: 'db-muted' }, '比较：'),
          el('button', {
            type: 'button', className: 'db-btn', 'data-compare-mode': 'renders', 'data-active': String(rendersMode),
            onClick: () => actions.setCompareMode('renders'),
          }, '上一次 vs 本次渲染'),
          el('button', {
            type: 'button', className: 'db-btn', 'data-compare-mode': 'revisions', 'data-active': String(!rendersMode),
            onClick: () => actions.setCompareMode('revisions'),
          }, '两个 revision'),
          el('span', { style: { flex: 1 } }),
          rendersMode
            ? el('span', { className: 'db-inline' },
              el('span', { className: 'db-muted' }, '版本'),
              el('select', {
                className: 'db-input', 'data-field': 'compare-revision', style: { width: 'auto' }, value: right || '',
                onChange: event => {
                  actions.pickCompare('left', event.target.value)
                  actions.pickCompare('right', event.target.value)
                },
              }, revisions.map(entry => el('option', { key: entry.revision, value: entry.revision }, entry.revision))))
            : el('span', { className: 'db-inline' },
              el('select', {
                className: 'db-input', 'data-field': 'compare-left', style: { width: 'auto' }, value: left || '',
                onChange: event => actions.pickCompare('left', event.target.value),
              }, revisions.map(entry => el('option', { key: entry.revision, value: entry.revision }, entry.revision))),
              el('span', { className: 'db-muted' }, '↔'),
              el('select', {
                className: 'db-input', 'data-field': 'compare-right', style: { width: 'auto' }, value: right || '',
                onChange: event => actions.pickCompare('right', event.target.value),
              }, revisions.map(entry => el('option', { key: entry.revision, value: entry.revision }, entry.revision))),
              state.activeProjectId ? Button({ action: 'diff', onClick: () => actions.diff(left, right), children: '看结构差异' }) : null),
        ),
        el('div', { style: { paddingTop: '2px' } },
          el('div', { className: 'db-grid' }, rendersMode
            ? renderPairPanes
            : [revisionPane(entryOf(left), 'left'), revisionPane(entryOf(right), 'right')]),
          state.diff ? el('div', { className: 'db-card', 'data-diff': state.diff.identical ? 'identical' : 'changed' },
            el('h4', null, `${state.diff.fromRevision} → ${state.diff.toRevision}：${state.diff.identical ? '结构完全相同' : `${state.diff.totalChanges} 处结构变化`}`),
            state.diff.identical ? null : el('div', null,
              Object.entries(state.diff.collections)
                .filter(([, entry]) => entry.added.length + entry.removed.length + entry.changed.length > 0)
                .map(([kind, entry]) => el('div', { key: kind },
                  el('strong', null, kind),
                  entry.added.length > 0 ? el('div', { className: 'db-muted db-mono' }, `+ ${entry.added.join(', ')}`) : null,
                  entry.removed.length > 0 ? el('div', { className: 'db-muted db-mono' }, `- ${entry.removed.join(', ')}`) : null,
                  entry.changed.map(change => el('div', { key: change.id, className: 'db-muted db-mono' },
                    `~ ${change.id}: ${change.fields.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`)))),
              state.diff.project.length > 0 ? el('div', { className: 'db-muted db-mono' }, `project: ${state.diff.project.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`) : null,
              state.diff.world.length > 0 ? el('div', { className: 'db-muted db-mono' }, `world: ${state.diff.world.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`) : null,
            ),
          ) : null,
          state.diffError ? ErrorBox({ error: state.diffError }) : null,
        ),
      )
    }

    /** 任务: live progress, cancel, resume, and the approval threshold. */
    function JobsView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      if (state.activeProjectId === null) return el('div', { 'data-view': 'jobs', className: 'db-muted' }, '尚未选择项目。')
      const jobs = state.jobs || []

      return el('div', { 'data-view': 'jobs' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('h4', null, '任务'),
          jobs.length === 0
            ? el('div', { className: 'db-muted' }, '还没有渲染任务。')
            : el('ul', { className: 'db-list' }, jobs.map(job => el('li', { key: job.jobId, 'data-job': job.jobId },
              el('div', { className: 'db-inline' },
                el('span', { className: 'db-mono' }, job.jobId),
                Badge({ tone: statusTone(job.status), children: job.status }),
                el('span', { className: 'db-muted' }, job.type),
                el('span', { className: 'db-muted db-mono' }, `帧 ${job.frameStart}–${job.frameEnd}`),
                job.approval && job.approval.required ? Badge({ tone: 'warn', name: 'approval', children: `需审批：${job.approval.frames} 帧 > 阈值 ${job.approval.threshold}` }) : null,
                job.deliverable ? Badge({ tone: 'ok', children: '交付已校验' }) : null,
                job.cancelable ? Button({ tone: 'danger', action: `cancel:${job.jobId}`, disabled: state.busy.render, onClick: () => actions.cancelJob(job.jobId), children: '取消' }) : null,
                job.resumable ? Button({ action: `resume:${job.jobId}`, disabled: state.busy.render, onClick: () => actions.startRender(job.jobId), children: '继续渲染' }) : null,
              ),
              ProgressBar({ percent: job.progress.percent }),
              el('div', { className: 'db-muted', 'data-job-detail': job.jobId }, `${job.detail} · ${job.progress.percent}% · 缺失 ${job.progress.missing} · 损坏 ${job.progress.corrupt}`),
              job.errorCode ? el('div', { className: 'db-error', style: { marginTop: '4px' } }, `${job.errorCode}: ${job.message || ''}`) : null,
              job.delivery ? el('div', { className: 'db-muted db-mono' }, `video ${job.delivery.videoPath || ''}`) : null,
            ))),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, '启动一次交付渲染（写操作经 Host）'),
          el('div', { className: 'db-inline' },
            el('label', { className: 'db-muted' }, '帧起'),
            el('input', { className: 'db-input', 'data-field': 'frame-start', style: { width: '90px' }, value: state.forms.frameStart, onChange: event => actions.setForm('frameStart', event.target.value) }),
            el('label', { className: 'db-muted' }, '帧止'),
            el('input', { className: 'db-input', 'data-field': 'frame-end', style: { width: '90px' }, value: state.forms.frameEnd, onChange: event => actions.setForm('frameEnd', event.target.value) }),
            el('label', { className: 'db-muted' }, 'profile'),
            el('select', {
              className: 'db-input', 'data-field': 'render-profile', style: { width: 'auto' }, value: state.forms.profile,
              onChange: event => actions.setForm('profile', event.target.value),
            },
              el('option', { value: 'preview' }, 'preview'),
              el('option', { value: 'final' }, 'final')),
            Button({ tone: 'primary', action: 'start-render', disabled: state.busy.render, onClick: () => actions.startRender(undefined), children: state.busy.render ? '提交中…' : '启动' }),
          ),
          Notice(state.notices.jobs, { marginTop: '8px' }),
        ),
      )
    }

    /** QA: technical validation and the visual review, never merged. */
    function QaView(ctx) {
      const state = ctx.state
      const qa = state.selected ? state.selected.qa : null
      if (qa === null || qa === undefined) return el('div', { 'data-view': 'qa', className: 'db-muted' }, '尚未选择项目。')
      const issueList = (issues, keyPrefix) => el('ul', { className: 'db-list' }, issues.map((issue, index) => el('li', { key: `${keyPrefix}${index}` },
        el('div', { className: 'db-inline' },
          Badge({ tone: issue.severity === 'critical' ? 'bad' : issue.severity === 'major' ? 'warn' : 'muted', children: issue.severity || '—' }),
          el('span', { className: 'db-mono' }, issue.code || '—'),
          issue.category ? el('span', { className: 'db-muted' }, issue.category) : null,
          issue.viewId ? el('span', { className: 'db-muted db-mono' }, issue.viewId) : null,
        ),
        el('div', null, issue.evidence || ''))))

      return el('div', { 'data-view': 'qa' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card', 'data-qa-revision': qa.revision },
          el('div', { className: 'db-inline' },
            el('strong', null, `QA · ${qa.revision}`),
            Badge({ tone: qa.technical.ok ? 'ok' : 'bad', children: qa.technical.available ? (qa.technical.ok ? '技术校验通过' : `技术错误 ${qa.technical.errorCount}`) : '无技术校验记录' }),
            qa.visual.available ? Badge({ tone: qa.visual.pass ? 'ok' : 'warn', children: `视觉评分 ${qa.visual.score}` }) : Badge({ children: '未跑视觉评审' }),
            qa.semantic.noticeCount > 0 ? Badge({ tone: 'warn', children: `${qa.semantic.noticeCount} 条 notices` }) : null,
          ),
          el('div', { className: 'db-muted', style: { marginTop: '4px' } }, qa.summary),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, '技术校验（validation.json）'),
          KeyValues({ entries: [
            { label: '引擎', value: qa.technical.engine },
            { label: '活动相机', value: qa.technical.activeCamera },
            { label: '帧范围', value: qa.technical.frameRange ? qa.technical.frameRange.join('–') : null },
            { label: '对象', value: qa.technical.counts ? qa.technical.counts.objects : null },
            { label: '材质', value: qa.technical.counts ? qa.technical.counts.materials : null },
            { label: '相机', value: qa.technical.counts ? qa.technical.counts.cameraObjects : null },
          ] }),
          qa.technical.errors.length === 0
            ? el('div', { className: 'db-muted' }, '没有技术错误。')
            : issueList(qa.technical.errors, 'tech'),
          qa.semantic.notices.length === 0 ? null : el('div', { style: { marginTop: '8px' } },
            el('h4', null, '编译器 notices'),
            el('ul', { className: 'db-list' }, qa.semantic.notices.map((notice, index) => el('li', { key: `n${index}` },
              el('span', { className: 'db-mono' }, notice.code || ''), ' ', notice.message || '')))),
        ),

        el('div', { className: 'db-card' },
          el('h4', null, '视觉评审（测量 + 模型 finding，两个来源不合并）'),
          qa.visual.available
            ? el('div', null,
              KeyValues({ entries: [
                { label: '分数', value: qa.visual.score },
                { label: '通过', value: qa.visual.pass ? '是' : '否' },
                { label: '轮次', value: qa.visual.iteration },
                { label: '主体', value: qa.visual.subjectId },
                { label: '视角数', value: qa.visual.viewCount },
                { label: '审查器', value: qa.visual.reviewerAvailable ? (qa.visual.reviewerModel || '已调用') : (qa.visual.reviewerError || '未调用') },
              ] }),
              qa.visual.measuredIssues.length === 0 ? el('div', { className: 'db-muted' }, '测量没有发现问题。') : issueList(qa.visual.measuredIssues, 'm'),
              qa.visual.findings.length === 0
                ? el('div', { className: 'db-muted' }, qa.visual.reviewerAvailable ? '审查器没有报告 finding。' : '没有第二意见。')
                : issueList(qa.visual.findings, 'f'))
            : el('div', { className: 'db-muted' }, '这个 revision 还没有视觉评审。可以用 blender_visual_review 跑一次。'),
        ),
      )
    }

    /** 版本: the revision list, restore, and the hand-off to Preview Compare. */
    function RevisionsView(ctx) {
      const state = ctx.state
      const actions = ctx.actions
      if (state.activeProjectId === null) return el('div', { 'data-view': 'revisions', className: 'db-muted' }, '尚未选择项目。')
      const revisions = (state.selected && state.selected.revisions) || []

      return el('div', { 'data-view': 'revisions' },
        ErrorBox({ error: state.error }),
        el('div', { className: 'db-card' },
          el('h4', null, `版本（${revisions.length}）`),
          el('ul', { className: 'db-list' }, revisions.map(entry => el('li', { key: entry.revision, 'data-revision': entry.revision },
            el('div', { className: 'db-inline' },
              el('span', { className: 'db-mono' }, entry.revision),
              entry.isCurrent ? Badge({ tone: 'ok', children: '当前' }) : null,
              el('span', { className: 'db-muted' }, entry.kind || '—'),
              el('span', { className: 'db-muted' }, formatTime(entry.createdAt)),
              el('span', { className: 'db-muted db-mono' }, `digest ${shortDigest(entry.digest)}`),
              Button({ action: `compare-from:${entry.revision}`, onClick: () => actions.compareFrom(entry.revision), children: '对比' }),
              entry.isCurrent ? null : Button({ action: `restore:${entry.revision}`, disabled: state.busy.restore, onClick: () => actions.restoreRevision(entry.revision), children: '恢复' }),
            ),
            el('div', { className: 'db-muted' }, entry.summary || '（无说明）'),
            el('div', { className: 'db-muted db-mono' }, `previews ${(entry.previews || []).length} · validation ${entry.validation ? (entry.validation.ok ? 'ok' : `${entry.validation.errorCount} errors`) : '—'}`),
          ))),
          Notice(state.notices.revisions, { marginTop: '8px' }),
        ),
      )
    }

    /** The active view, and nothing else — the `.db-body` wrapper is the caller's. */
    function renderView(ctx) {
      switch (ctx.state.view) {
        case 'scene': return SceneView(ctx)
        case 'preview': return PreviewView(ctx)
        case 'jobs': return JobsView(ctx)
        case 'qa': return QaView(ctx)
        case 'revisions': return RevisionsView(ctx)
        default: return ProjectsView(ctx)
      }
    }

    /**
     * The whole workbench: header, the six-tab nav, and the active view.
     *
     * This is the function both faces call. The console hands its result to
     * `toReact`; the standalone page hands it to `toDom`. Neither of them decides
     * anything about what the workbench contains.
     *
     * @param {object} state - the store's snapshot
     * @param {object} actions - the store's action table
     */
    function buildWorkbenchView(state, actions) {
      const ctx = { state, actions }
      const stale = state.status === 'stale'
      const body = stale
        ? el('div', { className: 'db-body' }, ErrorBox({ error: state.error }))
        : state.status === 'loading'
          ? el('div', { className: 'db-body db-muted' }, '读取 Host 状态…')
          : el('div', { className: 'db-body' }, renderView(ctx))

      return el('div', { className: 'db-root', 'data-deepblend-panel': PANEL_ID },
        el('div', { className: 'db-head' },
          el('span', { className: 'db-title' }, `${PANEL_LABEL} 工作台`),
          state.selected ? el('span', { className: 'db-muted' }, state.selected.project.title) : null,
          state.selected ? Badge({ children: state.selected.currentRevision || '—' }) : null,
          state.unfinishedJobs.length > 0
            ? Badge({ tone: 'live', name: 'unfinished', children: `${state.unfinishedJobs.length} 个任务在跑` })
            : null,
          state.hostApiVersion !== null && state.hostApiVersion !== EXPECTED_HOST_API
            ? Badge({ tone: 'warn', name: 'api', children: `hostApiVersion ${state.hostApiVersion} ≠ ${EXPECTED_HOST_API}` })
            : null,
          el('span', { style: { flex: 1 } }),
          // AN ANCHOR, NOT A BUTTON. The export is a download, and a download is what an anchor with
          // `download` does: the browser fetches the route and writes the file itself, in both faces
          // (React passes `href`/`download` through, the DOM binding sets them as attributes). A button
          // would need imperative blob plumbing in a renderer that has no place to put it.
          el('a', {
            className: 'db-btn',
            href: ROUTES.diagnostics,
            download: 'deepblend-diagnostics.json',
            'data-action': 'export-diagnostics',
            title: '导出一份可以附在问题里的诊断信息（版本、配置、项目与任务的摘要）',
          }, '导出诊断'),
          Button({ action: 'reload', onClick: actions.reload, children: '刷新' }),
        ),
        el('div', { className: 'db-nav' }, VIEWS.map(entry => el('button', {
          key: entry.id,
          type: 'button',
          'data-view-tab': entry.id,
          'data-active': String(state.view === entry.id),
          onClick: () => actions.setView(entry.id),
        }, entry.label))),
        state.error !== null && state.error !== undefined && !stale ? el('div', { style: { padding: '8px 14px 0' } }, ErrorBox({ error: state.error })) : null,
        body,
      )
    }

    // =========================================================================
    // §I  The two bindings of a node — generic, and deliberately ignorant
    // =========================================================================

    /** A node is text, a list, or `{ tag, props, children }`; anything else is a bug. */
    function assertNode(node) {
      if (typeof node.tag !== 'string') {
        throw new Error(`workbench: a node's tag must be a string, got ${typeof node.tag} — a component must be CALLED, not used as a tag`)
      }
    }

    /**
     * Node → React element.
     *
     * The console's binding. It knows `createElement` and nothing else: no route,
     * no tab id, no field name.
     *
     * @param {any} node
     * @param {(type: any, props: any, ...children: any[]) => any} createElement
     */
    function toReact(node, createElement) {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return node
      if (Array.isArray(node)) return node.map(child => toReact(child, createElement))
      assertNode(node)
      return createElement(node.tag, node.props, ...node.children.map(child => toReact(child, createElement)))
    }

    /** Props that are listeners, spelled the way this vocabulary spells them. */
    const EVENT_NAMES = {
      onClick: 'click', onChange: 'input', onInput: 'input', onKeyDown: 'keydown',
      onSubmit: 'submit', onBlur: 'blur', onFocus: 'focus',
    }

    /**
     * Apply one node's props to a DOM element.
     *
     * Generic by construction: `className`, `style`, `value`, `on*`, and
     * everything else as an attribute. Nothing here names a DeepBlend concept.
     */
    function applyProps(element, props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'children' || key === 'key') continue
        if (key === 'className') { element.setAttribute('class', String(value)); continue }
        if (key === 'style') { Object.assign(element.style, value); continue }
        if (key === 'value') { element.value = String(value); continue }
        if (key === 'disabled') { element.disabled = value === true; continue }
        if (key === 'spellCheck') { element.setAttribute('spellcheck', String(value)); continue }
        if (EVENT_NAMES[key] !== undefined) { element.addEventListener(EVENT_NAMES[key], value); continue }
        element.setAttribute(key, value === true ? '' : String(value))
      }
    }

    /**
     * Node → DOM node.
     *
     * The standalone page's binding, and the same story as `toReact`: a generic
     * walk of the tree, with no idea what it is drawing.
     *
     * @param {any} node
     * @param {Document} doc
     * @returns {Node|null}
     */
    function toDom(node, doc) {
      if (node === null || node === undefined || node === false || node === true) return null
      if (typeof node === 'string' || typeof node === 'number') return doc.createTextNode(String(node))
      if (Array.isArray(node)) {
        const fragment = doc.createDocumentFragment()
        for (const child of node) {
          const built = toDom(child, doc)
          if (built !== null) fragment.appendChild(built)
        }
        return fragment
      }
      assertNode(node)
      const element = doc.createElement(node.tag)
      applyProps(element, node.props)
      for (const child of node.children) {
        const built = toDom(child, doc)
        if (built !== null) element.appendChild(built)
      }
      return element
    }

    // =========================================================================
    // §J  The standalone face (SPEC §20 M6)
    // =========================================================================

    /**
     * Mount the whole workbench into a plain DOM element.
     *
     * This is the ONLY thing the standalone page adds, and it is the only place
     * in this file where the two faces differ: the console's `WorkbenchPanel`
     * (§K) subscribes to the same store and draws the same tree through
     * `toReact`; this draws it through `toDom`.
     *
     * It is deliberately NOT a second panel: no view is named here, no route is
     * spelled here, and there is no state of its own beyond the store both faces
     * share. `contract/workbench-page.test.mjs` asserts exactly that — that this
     * function and the two bindings contain no DeepBlend noun at all.
     *
     * @param {HTMLElement} root - the element the page reserves for the workbench
     * @param {{ fetch?: typeof fetch, pollLiveMs?: number, pollIdleMs?: number }} [options]
     * @returns {Promise<{ store: object, dispose: () => void }>}
     */
    async function mountStandalone(root, options) {
      const doc = root.ownerDocument
      injectStandaloneTokens(doc)
      injectStyles(doc)
      root.classList.add('db-standalone-root')

      const store = createWorkbenchStore(options)

      /**
       * Redraw from the snapshot.
       *
       * The tree is rebuilt wholesale, so a text field would lose its caret on
       * every keystroke. The focus and the selection are therefore carried across
       * the redraw by the field's own `data-field` marker — the one piece of DOM
       * bookkeeping this binding needs, and the reason it can rebuild rather than
       * reconcile.
       */
      const draw = () => {
        const active = doc.activeElement
        const focused = active !== null && active !== doc.body && active.dataset ? active.dataset.field ?? null : null
        const caret = focused === null ? null : active.selectionStart

        const next = toDom(buildWorkbenchView(store.getState(), store.actions), doc)
        root.replaceChildren(...(next === null ? [] : [next]))

        if (focused !== null) {
          const restored = root.querySelector(`[data-field="${focused}"]`)
          if (restored !== null) {
            restored.focus()
            if (caret !== null && typeof restored.setSelectionRange === 'function') restored.setSelectionRange(caret, caret)
          }
        }
      }

      const unsubscribe = store.subscribe(draw)
      store.start()
      draw()

      return {
        store,
        dispose() {
          unsubscribe()
          store.stop()
          root.replaceChildren()
        },
      }
    }

    // =========================================================================
    // §K  The console face — React, and only React
    // =========================================================================

    /** One store per panel, started with the mount and stopped with it. */
    function useWorkbenchStore() {
      const ref = react().useRef(null)
      if (ref.current === null) ref.current = createWorkbenchStore({})
      react().useEffect(() => {
        ref.current.start()
        return () => ref.current.stop()
      }, [])
      return ref.current
    }

    /** Re-render on every store change. */
    function useSnapshot(store) {
      const [snapshot, setSnapshot] = react().useState(() => store.getState())
      react().useEffect(() => store.subscribe(setSnapshot), [store])
      return snapshot
    }

    /** React bindings for the shared pieces: one line each, no second implementation. */
    const RBadge = props => toReact(Badge(props), h)
    const RRow = props => toReact(Row(props), h)
    const RButton = props => toReact(Button(props), h)
    const RErrorBox = props => toReact(ErrorBox(props), h)
    const RProgressBar = props => toReact(ProgressBar(props), h)
    const RKeyValues = props => toReact(KeyValues(props), h)

    /**
     * The panel: the shared workbench tree, drawn by React.
     *
     * The selected project and the compare pair are LOCAL UI state (SPEC §14.3) —
     * they live in the store, which both faces share. Everything they point at is
     * read from the Host on every pass, so the mirror cannot outlive the truth.
     */
    function WorkbenchPanel() {
      const store = useWorkbenchStore()
      const snapshot = useSnapshot(store)
      return toReact(buildWorkbenchView(snapshot, store.actions), h)
    }

    /** The settings page: the M0 card, now with a seat. */
    function BlenderSettingsPage() {
      const [state, setState] = react().useState({ status: 'loading', payload: null, error: null })
      react().useEffect(() => {
        let live = true
        readRoute((...args) => fetch(...args), ROUTES.capabilities, 'capabilities').then(result => {
          if (live) setState(result)
        })
        return () => { live = false }
      }, [])
      const payload = state.payload
      const card = payload ? payload.card : null

      return h('div', { 'data-deepblend-settings': PANEL_ID, style: { padding: '4px 2px' } },
        state.error !== null && state.error !== undefined ? h(RErrorBox, { error: state.error }) : null,
        state.status === 'loading' ? h('div', { className: 'db-muted' }, '检测 Blender…') : null,
        card === null ? null : h('div', null,
          h('div', { className: 'db-inline' },
            h('strong', null, card.title),
            h(RBadge, { tone: card.status === 'ready' ? 'ok' : 'bad' }, card.statusLabel),
            card.probedAt ? h('span', { className: 'db-muted' }, `探测于 ${formatTime(card.probedAt)}`) : null,
          ),
          h('div', { className: 'db-card', style: { marginTop: '8px' } },
            card.rows.map(row => h(RRow, { key: row.label, label: row.label, value: row.value }))),
          card.warnings.length === 0 ? null : h('div', { className: 'db-card' },
            h('h4', null, '警告'),
            h('ul', { className: 'db-list' }, card.warnings.map((entry, index) => h('li', { key: `w${index}` },
              h('span', { className: 'db-mono' }, entry.code || ''), ' ', entry.message || '')))),
          h('div', { className: 'db-muted db-mono' }, `hostApiVersion ${payload.hostApiVersion}`),
        ),
      )
    }

    // -------------------------------------------------------------------------
    // Tool cards (SPEC §14.2 "Tool Result Cards")
    // -------------------------------------------------------------------------

    /** The tool's own arguments — the harness records them verbatim. */
    function callArgs(block) {
      const settled = block !== null && block !== undefined && typeof block === 'object' && 'kind' in block
      return (settled ? (block.call && block.call.argsRaw) : (block && block.argsRaw)) || ''
    }

    function parseArgs(raw) {
      try {
        const parsed = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /** The settled result's text, for the expandable half of a card. */
    function resultText(block) {
      if (block === null || block === undefined) return ''
      if (!('kind' in block)) return ''
      const parts = (block.content || []).map(item => (item.type === 'text' ? item.text : `<${item.type}>`))
      const text = parts.join('\n')
      if (text.length > 0) return text
      return block.error ? `${block.error.name || 'error'}: ${block.error.code || ''}` : ''
    }

    /** Read one route for a card, once or on a cadence. */
    function useCardRoute(path, route, intervalMs) {
      const [state, setState] = react().useState({ status: 'loading', payload: null, error: null })
      react().useEffect(() => {
        let live = true
        const load = async () => {
          const result = await readRoute((...args) => fetch(...args), path, route)
          if (live) setState(result)
        }
        load()
        if (intervalMs <= 0) return () => { live = false }
        const timer = setInterval(load, intervalMs)
        return () => { live = false; clearInterval(timer) }
      }, [path, intervalMs, route])
      return state
    }

    /**
     * A DeepBlend tool card.
     *
     * It never parses prose for ids: `projectId` / `jobId` come from the call's own
     * JSON arguments, and everything shown beyond that is read back from the Host
     * — which is also why a card stays correct while the render it describes is
     * still running.
     */
    function BlenderToolCard(props) {
      const toolName = props.toolName
      const args = parseArgs(callArgs(props.block))
      const projectId = typeof args.projectId === 'string' ? args.projectId : null
      const jobId = typeof args.jobId === 'string' ? args.jobId : (typeof args.resumeJobId === 'string' ? args.resumeJobId : null)
      const settled = props.block !== null && props.block !== undefined && 'kind' in props.block
      const [expanded, setExpanded] = react().useState(false)

      const jobShaped = ['blender_final_render', 'blender_export', 'blender_job_status', 'blender_job_cancel'].includes(toolName)
      const reviewShaped = ['blender_visual_review', 'blender_visual_autofix', 'blender_preview_views'].includes(toolName)
      const canReadJob = projectId !== null && jobId !== null
      const idle = `${ROUTES.state}?t=0`

      const jobState = useCardRoute(
        canReadJob ? projectRoute(projectId, `/jobs/${encodeURIComponent(jobId)}`) : idle,
        canReadJob ? 'project.job' : 'state',
        jobShaped && canReadJob ? POLL_LIVE_MS : 0,
      )
      const qaState = useCardRoute(
        projectId === null ? idle : projectRoute(projectId, '/qa'),
        projectId === null ? 'state' : 'project.qa',
        reviewShaped && projectId !== null ? POLL_IDLE_MS : 0,
      )
      const previewState = useCardRoute(
        projectId === null ? idle : projectRoute(projectId, '/previews'),
        projectId === null ? 'state' : 'project.previews',
        0,
      )

      const job = jobState.payload && jobState.payload.job ? jobState.payload.job : null
      const qa = projectId !== null && qaState.payload && qaState.payload.qa ? qaState.payload.qa : null
      const previews = projectId !== null && previewState.payload && previewState.payload.previews ? previewState.payload.previews : null
      const artifactBase = previewState.payload && previewState.payload.artifactBase ? previewState.payload.artifactBase : ''

      const sheet = (() => {
        if (previews === null) return null
        const revision = (qa && qa.revision) || args.baseRevision || null
        const entry = previews.revisions.find(candidate => candidate.revision === revision) || previews.revisions[previews.revisions.length - 1]
        if (entry === undefined) return null
        const sheets = entry.contactSheets || []
        const pick = sheets[sheets.length - 1] || (entry.previews || [])[(entry.previews || []).length - 1]
        return pick && pick.path ? pick : null
      })()

      return h('div', {
        className: 'db-card',
        'data-tool-card': toolName,
        'data-tool-state': settled ? (props.block.isError ? 'error' : 'ok') : 'running',
        style: { marginBottom: '6px' },
      },
        h('div', { className: 'db-inline' },
          h('span', { className: 'db-dot', 'data-tone': settled ? (props.block.isError ? 'bad' : 'ok') : 'live' }),
          h('strong', { className: 'db-mono' }, toolName),
          projectId ? h('span', { className: 'db-muted db-mono' }, projectId) : null,
          jobId ? h(RBadge, null, jobId) : null,
          Array.isArray(args.operations) ? h(RBadge, null, `${args.operations.length} 个操作`) : null,
          job && job.approval && job.approval.required ? h(RBadge, { tone: 'warn', name: 'approval' }, `需审批：${job.approval.frames} 帧 > ${job.approval.threshold}`) : null,
          h('span', { style: { flex: 1 } }),
          settled ? h('button', { type: 'button', className: 'db-chip', 'data-action': 'toggle-card', onClick: () => setExpanded(value => !value) }, expanded ? '收起' : '详情') : null,
        ),

        jobShaped && job !== null ? h('div', { 'data-tool-job': job.jobId },
          h('div', { className: 'db-inline' },
            h(RBadge, { tone: statusTone(job.status) }, job.status),
            h('span', { className: 'db-muted' }, `${job.progress.completed}/${job.progress.expected} 帧 · ${job.progress.percent}%`),
            job.estimatedRemainingMs ? h('span', { className: 'db-muted' }, `预计 ${Math.round(job.estimatedRemainingMs / 1000)} s`) : null,
          ),
          h(RProgressBar, { percent: job.progress.percent }),
          h('div', { className: 'db-muted' }, job.detail),
          job.delivery ? h('div', { className: 'db-muted db-mono' }, String(job.delivery.videoPath || '')) : null,
        ) : null,

        reviewShaped && qa !== null ? h('div', { 'data-tool-qa': qa.revision },
          h('div', { className: 'db-inline' },
            qa.visual.available ? h(RBadge, { tone: qa.visual.pass ? 'ok' : 'warn' }, `视觉评分 ${qa.visual.score}`) : h(RBadge, null, '未跑视觉评审'),
            h(RBadge, { tone: qa.technical.ok ? 'ok' : 'bad' }, qa.technical.available ? (qa.technical.ok ? '技术校验通过' : `${qa.technical.errorCount} 个技术错误`) : '无记录'),
            h('span', { className: 'db-muted' }, `测量 ${qa.visual.measuredIssueCount} · 模型 finding ${qa.visual.findingCount}`),
          ),
          qa.visual.measuredIssues.slice(0, 4).map((issue, index) => h('div', { key: `i${index}`, className: 'db-muted db-mono' },
            `[${issue.severity}] ${issue.code} ${issue.viewId || ''} :: ${issue.evidence || ''}`)),
          qa.visual.reviewerError ? h('div', { className: 'db-error' }, `审查器失败：${qa.visual.reviewerError}`) : null,
        ) : null,

        reviewShaped && sheet !== null ? h('div', { style: { marginTop: '6px' } },
          h('img', {
            'data-tool-sheet': sheet.path,
            'data-artifact-digest': sheet.sha256 || '',
            alt: 'contact sheet',
            src: artifactUrl(artifactBase, sheet),
            style: { width: '100%', borderRadius: '6px', background: '#000' },
          }),
          h('div', { className: 'db-muted db-mono' }, `${sheet.sha256 ? String(sheet.sha256).slice(0, 10) : '—'}${artifactTime(sheet) === null ? '' : ` · 渲染于 ${artifactTime(sheet)}`}`)) : null,

        expanded || !settled ? h('pre', { className: 'db-pre' }, (resultText(props.block) || '(运行中…)').slice(0, 4000)) : null,
      )
    }

    /** The session-header chip: how many renders are live, right now. */
    function SessionJobsChip() {
      const state = useCardRoute(ROUTES.projects, 'projects.list', POLL_LIVE_MS)
      if (state.payload === null) return null
      const projects = state.payload.projects || []
      const unfinished = projects.reduce((sum, project) => sum + (project.unfinishedJobs || 0), 0)
      return h('span', {
        className: 'db-chip',
        'data-deepblend-chip': 'jobs',
        title: projects.map(project => `${project.projectId}: ${project.unfinishedJobs || 0}`).join('\n'),
      },
        h('span', { className: 'db-dot', 'data-tone': unfinished > 0 ? 'live' : 'ok' }),
        unfinished > 0 ? `${unfinished} 个渲染在跑` : '无渲染任务',
      )
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /**
     * The sidebar glyph, drawn from the owner's `{ size, active }` and nothing else.
     *
     * An isometric cube rather than a brand mark: the owner renders it at 16–18 px
     * beside the console's own icons, where a cube still reads as "3D" and a logo
     * detail turns to mush. It inherits `currentColor`, so hover and selected
     * states are the shell's.
     */
    function PanelIcon(props) {
      const size = props && props.size ? props.size : 18
      const active = Boolean(props && props.active)
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.9 : 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'data-deepblend-icon': 'blender',
      },
        h('path', { d: 'M12 2.7l8 4.6v9.4l-8 4.6-8-4.6V7.3z' }),
        h('path', { d: 'M4 7.3l8 4.6 8-4.6' }),
        h('path', { d: 'M12 11.9v9.4' }),
      )
    }

    /** Client services this plugin needs; `slots` is the Slot registry. */
    const inject = ['slots']

    /**
     * Register every seat this package owns.
     *
     * Each registration is additive: the sidebar list gains one entry, `main`
     * gains one key (`conversation` is untouched — it hosts the whole conversation
     * tree, tool cards included), the settings list gains one page, and each
     * `tool.call.toolview` key is unclaimed today.
     */
    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'deepblend-ui: styles')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: () => PANEL_LABEL },
        PanelIcon,
      ))

      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID },
        WorkbenchPanel,
      ))

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: PANEL_ID, order: 50, label: () => PANEL_LABEL },
        BlenderSettingsPage,
      ))

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: PANEL_ID, order: 60, label: () => PANEL_LABEL },
        SessionJobsChip,
      ))

      ctx.slots.inject('tool.call.toolview', () => TOOL_CARD_KEYS.map(key => ctx.slots.register(
        { name: 'tool.call.toolview', key },
        BlenderToolCard,
      )))
    }

    exports.apply = apply
    exports.inject = inject

    /**
     * The standalone page's entry point, and the pieces a test can reach without
     * a browser. Exported from THIS bundle on purpose: the page imports this
     * module out of `window.__DSH_BOOT__`, so "the standalone workbench and the
     * console workbench are one implementation" is a fact about which file was
     * loaded, not a promise about two files staying in step.
     */
    exports.mountStandalone = mountStandalone
    exports.workbench = {
      PANEL_ID,
      VIEWS,
      CSS,
      ROUTES,
      projectRoute,
      artifactUrl,
      shortDigest,
      formatTime,
      statusTone,
      el,
      toReact,
      toDom,
      buildWorkbenchView,
      createWorkbenchStore,
      renderView,
      mountStandalone,
      injectStyles,
      injectStandaloneTokens,
    }
    return module.exports
  },
})
