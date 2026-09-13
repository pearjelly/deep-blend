/**
 * @deepblend/dsh-blender-ui — the Web Client half (SPEC §5.1, §14).
 *
 * This file is a **self-registering CJS factory**, which is what the browser's
 * client module system executes (`dsh-client-modules`): the shell loads the
 * bundle as a script, and the only thing the script does is hand a factory to
 * `window.__ModuleLoader__.load`. There is no top-level `import`, no bundler step
 * and no JSX — dependencies arrive through the factory's synchronous `require`,
 * and elements are built with `React.createElement`.
 *
 * That is not a compromise: `docs/probe-m4-client-loop.log` measures this file's
 * own development loop — one line edited here is live in an already-open page in
 * about 600 ms, with no refresh, no restart and no build.
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
 * Owner: DeepBlend Studio — M4
 * Plane: Web Client (browser)
 */

window.__ModuleLoader__.load({
  // Must be the PACKAGE NAME: the client module graph addresses this bundle by
  // package identity, and the Host row mounts the same package.
  id: '@deepblend/dsh-blender-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    /** The sidebar id, the `main` key and the settings section id — one value. */
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
      'blender_scene_validate', 'blender_preview_views', 'blender_visual_review',
      'blender_visual_autofix', 'blender_final_render', 'blender_export',
      'blender_job_status', 'blender_job_cancel',
    ]

    const ROUTES = {
      state: '/deepblend/state',
      projects: '/deepblend/projects',
      capabilities: '/deepblend/capabilities',
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

    // -------------------------------------------------------------------------
    // Styles. Injected once per document, the way the shipped plugins do it: one
    // <style> tagged with this package, deduped by querySelector.
    // -------------------------------------------------------------------------

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

    function injectStyles() {
      const tagId = '@deepblend/dsh-blender-ui/workbench.css'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@deepblend/dsh-blender-ui'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // Talking to the Host
    // -------------------------------------------------------------------------

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
     * Read one Host route, and keep reading it while `intervalMs` is set.
     *
     * A page refresh re-runs exactly this, which is why the panel rebuilds itself
     * from the Host (SPEC §20 M4 「UI 刷新后可从 Host 恢复权威状态」).
     */
    function useHostRoute(path, options) {
      const intervalMs = options && options.intervalMs ? options.intervalMs : 0
      const expectedRoute = options && options.route ? options.route : null
      const [state, setState] = react.useState({ status: 'loading', payload: null, error: null })

      react.useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const response = await fetch(path, { headers: { accept: 'application/json' } })
            const text = await response.text()
            let payload = null
            try {
              payload = text.length === 0 ? null : JSON.parse(text)
            } catch {
              payload = null
            }
            if (!live) return
            // A route this half declared but the running Host does not serve: either
            // a body with the wrong identity, or a response that is not ours at all.
            if (expectedRoute !== null && (payload === null || payload.route !== expectedRoute)) {
              setState({
                status: 'stale',
                payload: null,
                error: staleHostError(expectedRoute, {
                  payload,
                  status: response.status,
                  detail: payload === null
                    ? `HTTP ${response.status}，${text.length} 字节，非 JSON`
                    : `route=${JSON.stringify(payload.route)}`,
                }),
              })
              return
            }
            if (payload && payload.ok) setState({ status: 'ok', payload, error: null })
            else setState({ status: 'error', payload: null, error: (payload && payload.error) || { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` } })
          } catch (error) {
            if (live) setState({ status: 'error', payload: null, error: { code: 'UI_FETCH_FAILED', message: String((error && error.message) || error) } })
          }
        }
        load()
        if (intervalMs <= 0) return () => { live = false }
        const timer = setInterval(load, intervalMs)
        return () => { live = false; clearInterval(timer) }
      }, [path, intervalMs, expectedRoute])

      return state
    }

    /** POST a JSON body and return the parsed payload. Errors come back as data. */
    async function postJson(path, body) {
      try {
        const response = await fetch(path, {
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

    // -------------------------------------------------------------------------
    // Small pieces
    // -------------------------------------------------------------------------

    function Badge(props) {
      return h('span', { className: 'db-badge', 'data-tone': props.tone || 'muted', 'data-badge': props.name || undefined }, props.children)
    }

    function Row(props) {
      return h('div', { className: 'db-row' },
        h('span', null, props.label),
        h('span', null, props.value === null || props.value === undefined || props.value === '' ? '—' : String(props.value)))
    }

    function Button(props) {
      return h('button', {
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
      return h('div', { className: 'db-error', 'data-deepblend-error': props.error.code || 'error' },
        h('div', null, `${props.error.code || 'ERROR'}: ${props.error.message || ''}`),
        props.error.detail ? h('pre', { className: 'db-pre' }, JSON.stringify(props.error.detail, null, 2)) : null)
    }

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

    function ProgressBar(props) {
      const percent = Math.max(0, Math.min(100, Number(props.percent) || 0))
      return h('div', { className: 'db-bar', 'data-progress': String(percent) }, h('i', { style: { width: `${percent}%` } }))
    }

    /** A definition list, used by the settings page and the revision summary. */
    function KeyValues(props) {
      const entries = (props.entries || []).filter(entry => entry !== null && entry !== undefined)
      return h('dl', { className: 'db-kv' }, entries.flatMap((entry, index) => [
        h('dt', { key: `k${index}` }, entry.label),
        h('dd', { key: `v${index}` }, entry.value === null || entry.value === undefined || entry.value === '' ? '—' : String(entry.value)),
      ]))
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /** 项目: the list, the create form, and the selected project's summary. */
    function ProjectsView(props) {
      const [title, setTitle] = react.useState('')
      const [goal, setGoal] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)

      const create = async () => {
        setBusy(true)
        const outcome = await postJson(ROUTES.projects, { title, goal: goal.length > 0 ? goal : undefined })
        setBusy(false)
        if (outcome.ok) {
          setTitle('')
          setGoal('')
          setResult({ ok: true, message: `已创建 ${outcome.payload.project.projectId}` })
          props.onCreated(outcome.payload.project.projectId)
        } else {
          setResult({ ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        }
      }

      return h('div', { 'data-view': 'projects' },
        h(ErrorBox, { error: props.error }),
        h('div', { className: 'db-card' },
          h('h4', null, '项目'),
          props.projects.length === 0
            ? h('div', { className: 'db-muted' }, '这个工作区还没有项目。')
            : h('ul', { className: 'db-list' }, props.projects.map(project => h('li', { key: project.projectId, 'data-project': project.projectId },
              h('div', { className: 'db-inline' },
                h(Button, {
                  tone: project.projectId === props.selectedId ? 'primary' : undefined,
                  action: `select-project:${project.projectId}`,
                  onClick: () => props.onSelect(project.projectId),
                }, project.title || project.projectId),
                h('span', { className: 'db-muted db-mono' }, project.projectId),
                project.unfinishedJobs > 0 ? h(Badge, { tone: 'live', name: 'unfinished' }, `${project.unfinishedJobs} 个任务在跑`) : null,
                h('span', { className: 'db-muted' }, `${project.revisionCount} 个 revision`),
              ),
              h('div', { className: 'db-muted db-mono' }, `当前 ${project.currentRevision || '—'} · 更新于 ${formatTime(project.updatedAt)}`),
              project.goal ? h('div', { className: 'db-muted' }, project.goal) : null,
            ))),
          h('div', { className: 'db-muted db-mono', style: { marginTop: '6px' } }, `projectsRoot: ${props.projectsRoot || '—'}`),
        ),

        h('div', { className: 'db-card' },
          h('h4', null, '新建项目（写操作经 Host）'),
          h('div', { className: 'db-inline' },
            h('input', {
              className: 'db-input',
              'data-field': 'project-title',
              placeholder: '标题，例如 watch-commercial',
              value: title,
              onChange: event => setTitle(event.target.value),
            }),
            h('input', {
              className: 'db-input',
              'data-field': 'project-goal',
              placeholder: '目标（可选）',
              value: goal,
              onChange: event => setGoal(event.target.value),
            }),
            h(Button, { tone: 'primary', action: 'create-project', disabled: busy || title.trim().length === 0, onClick: create }, busy ? '创建中…' : '创建'),
          ),
          result ? h('div', { 'data-result': result.ok ? 'ok' : 'error', className: result.ok ? 'db-muted' : 'db-error', style: { marginTop: '8px' } }, result.message) : null,
        ),

        props.state ? h('div', { className: 'db-card' },
          h('h4', null, `当前项目：${props.state.project.title}`),
          h(KeyValues, { entries: [
            { label: 'projectId', value: props.state.project.projectId },
            { label: '当前 revision', value: props.state.currentRevision },
            { label: 'revision 数', value: props.state.project.revisionCount },
            { label: 'digest', value: shortDigest(props.state.scene.digest) },
            { label: '帧范围', value: `${props.state.scene.project.frameStart}–${props.state.scene.project.frameEnd} @ ${props.state.scene.project.fps}fps` },
            { label: '活动相机', value: props.state.scene.project.activeCamera },
            { label: '对象 / 材质 / 灯 / 相机', value: [
              props.state.scene.counts.entities, props.state.scene.counts.materials,
              props.state.scene.counts.lights, props.state.scene.counts.cameras,
            ].join(' / ') },
          ] }),
          h('div', { className: 'db-muted', style: { marginTop: '6px' } }, props.state.qa.summary),
        ) : h('div', { className: 'db-card db-muted' }, '尚未选择项目。'),
      )
    }

    /** 场景树: the Scene Tree of the revision in view. */
    function SceneView(props) {
      const scene = props.state ? props.state.scene : null
      const [patchText, setPatchText] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)

      const template = scene === null ? '' : JSON.stringify({
        baseRevision: props.state.currentRevision,
        operations: [{
          op: 'entity.transform.update',
          entityId: (scene.nodes.entities[0] || {}).id || 'entity-id',
          rotationEuler: [0, 0, 0.12],
        }],
      }, null, 2)
      const text = patchText === null ? template : patchText

      const apply = async () => {
        let patch
        try {
          patch = JSON.parse(text)
        } catch (error) {
          setResult({ ok: false, message: `patch 不是合法 JSON：${error.message}` })
          return
        }
        setBusy(true)
        const outcome = await postJson(projectRoute(props.projectId, '/patch'), { patch })
        setBusy(false)
        setResult(outcome.ok
          ? { ok: true, message: `已提交 ${outcome.payload.revision.revision}（digest ${shortDigest(outcome.payload.revision.digest)}）` }
          : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        if (outcome.ok) {
          setPatchText(null)
          props.onChanged()
        }
      }

      if (scene === null) return h('div', { 'data-view': 'scene', className: 'db-muted' }, '尚未选择项目。')

      const section = (title, items, render) => h('div', { className: 'db-card', key: title },
        h('h4', null, `${title}（${items.length}）`),
        items.length === 0 ? h('div', { className: 'db-muted' }, '空') : h('ul', { className: 'db-list' }, items.map(item => h('li', { key: item.id }, render(item)))))

      return h('div', { 'data-view': 'scene' },
        h(ErrorBox, { error: props.error }),
        h('div', { className: 'db-card' },
          h('div', { className: 'db-inline' },
            h('strong', null, String(scene.project.title || scene.project.id || '')),
            h(Badge, null, scene.revision),
            h('span', { className: 'db-muted db-mono' }, `digest ${shortDigest(scene.digest)}`),
            h(Badge, null, `world ${scene.world ? `${(scene.world.color || []).join(',')} × ${scene.world.strength}` : '默认'}`),
          ),
        ),
        h('div', { className: 'db-grid' },
          section('实体 entities', scene.nodes.entities, entity => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `entity:${entity.id}` }, entity.id), ' ',
            h('span', { className: 'db-kind' }, entity.shape || entity.kind),
            entity.materialId ? h('span', { className: 'db-muted' }, `材质 ${entity.materialId}`) : null,
            entity.locked ? h(Badge, { tone: 'warn' }, 'locked') : null,
            entity.tags.length > 0 ? h('span', { className: 'db-muted db-mono' }, ` tags=[${entity.tags.join(' ')}]`) : null,
            entity.transform ? h('div', { className: 'db-muted db-mono' }, `loc ${(entity.transform.location || []).map(value => Number(value).toFixed(3)).join(', ')}`) : null)),
          section('材质 materials', scene.nodes.materials, material => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `material:${material.id}` }, material.id), ' ',
            h('span', { className: 'db-kind' }, material.shader),
            material.parameters ? h('span', { className: 'db-muted db-mono' }, Object.entries(material.parameters).slice(0, 4).map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(',')}]` : value}`).join(' ')) : null)),
          section('灯光 lights', scene.nodes.lights, light => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `light:${light.id}` }, light.id), ' ',
            h('span', { className: 'db-kind' }, light.type),
            h('span', { className: 'db-muted' }, `energy ${light.energy}`))),
          section('相机 cameras', scene.nodes.cameras, camera => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `camera:${camera.id}` }, camera.id), ' ',
            camera.isActive ? h(Badge, { tone: 'ok' }, 'active') : null, ' ',
            h('span', { className: 'db-kind' }, camera.role || 'no role'),
            h('span', { className: 'db-muted' }, `lens ${camera.lens}`))),
          section('镜头 shots', scene.nodes.shots, shot => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `shot:${shot.id}` }, shot.id), ' ',
            h('span', { className: 'db-muted' }, `${shot.cameraId} ${(shot.frameRange || []).join('–')}`))),
          section('动画轨道 animationTracks', scene.nodes.animationTracks, track => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `track:${track.id}` }, track.id), ' ',
            h('span', { className: 'db-kind' }, track.targetKind),
            h('span', { className: 'db-muted' }, `${track.targetId} · ${track.property} · ${track.keyframes} 关键帧`))),
          section('资产 assets', scene.nodes.assets, asset => h('div', null,
            h('span', { className: 'db-mono', 'data-node': `asset:${asset.id}` }, asset.id), ' ',
            h('span', { className: 'db-kind' }, asset.type),
            h('span', { className: 'db-muted db-mono' }, String(asset.path || '')))),
        ),

        h('div', { className: 'db-card' },
          h('h4', null, 'ScenePatch（写操作经 Host，原子提交为一个 revision）'),
          h('textarea', {
            className: 'db-area',
            'data-field': 'scene-patch',
            value: text,
            spellCheck: false,
            onChange: event => setPatchText(event.target.value),
          }),
          h('div', { className: 'db-inline', style: { marginTop: '8px' } },
            h(Button, { tone: 'primary', action: 'apply-patch', disabled: busy || props.projectId === null, onClick: apply }, busy ? '提交中…' : '提交'),
            h(Button, { action: 'reset-patch', onClick: () => setPatchText(null) }, '重置模板'),
            result ? h('span', { 'data-result': result.ok ? 'ok' : 'error', className: result.ok ? 'db-muted' : 'db-error', style: { border: 0, padding: '0 6px', marginBottom: 0 } }, result.message) : null,
          ),
        ),
      )
    }

    /** 预览对比: two revisions' contact sheets side by side. */
    function PreviewView(props) {
      const previews = props.previews
      if (previews === null) return h('div', { 'data-view': 'preview', className: 'db-muted' }, '尚未选择项目。')
      const revisions = previews.revisions
      const pick = wanted => (revisions.some(entry => entry.revision === wanted) ? wanted : (((revisions[revisions.length - 1] || {}).revision) || null))
      const left = pick(props.compareLeft)
      const right = pick(props.compareRight)
      const entryOf = id => revisions.find(entry => entry.revision === id) || null

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
      const sheetOf = (entry) => {
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

      /** The pair a render leaves behind: what it just composed, and the one before. */
      const renderPairOf = (entry) => {
        if (entry === null) return { current: null, previous: null }
        const sheets = entry.contactSheets || []
        const current = sheets.find(sheet => sheet.slot === 'preview-current') ?? null
        const previous = sheets.find(sheet => sheet.slot === 'preview-previous') ?? null
        return {
          current: current === null ? null : { ...current, label: '本次渲染' },
          previous: previous === null ? null : { ...previous, label: '上一次渲染' },
        }
      }

      /** One image (or the reason there is none), with its digest and its time. */
      const imagePane = (side, title, artifact, missing) => {
        const when = artifactTime(artifact)
        return h('div', { className: 'db-shot', 'data-compare': side, 'data-compare-kind': artifact === null ? 'empty' : 'image' },
          h('h5', null, title),
          artifact === null
            ? h('div', { className: 'db-muted' }, missing)
            : [
              h('img', {
                key: 'img',
                'data-artifact': artifact.path,
                'data-artifact-digest': artifact.sha256 || '',
                'data-artifact-slot': artifact.slot || '',
                alt: `${title} ${artifact.path}`,
                src: artifactUrl(props.artifactBase, artifact),
              }),
              h('div', { className: 'db-muted db-mono', key: 'meta' },
                `${artifact.slot ? artifact.slot : (artifact.kind || 'artifact')} · ${artifact.sha256 ? String(artifact.sha256).slice(0, 10) : '—'}${when === null ? '' : ` · 渲染于 ${when}`}`),
            ].filter(Boolean))
      }

      const revisionMeta = entry => h('div', { className: 'db-muted', key: 'meta' }, `${entry.summary || '（无说明）'} · ${formatTime(entry.createdAt)}`)

      /** The revision axis: two revisions side by side, each one's newest image. */
      const revisionPane = (entry, side) => h('div', { className: 'db-shot', 'data-compare': side },
        h('h5', null, entry === null ? '—' : `${entry.revision}${entry.isCurrent ? ' (当前)' : ''}`),
        entry === null
          ? h('div', { className: 'db-muted' }, '没有这个 revision')
          : [
            revisionMeta(entry),
            (() => {
              const sheet = sheetOf(entry)
              return sheet === null
                ? h('div', { className: 'db-muted', key: 'none' }, '这个 revision 还没有预览图（渲染一次预览即可）。')
                : h('img', {
                  key: 'img',
                  'data-artifact': sheet.path,
                  'data-artifact-digest': sheet.sha256 || '',
                  'data-artifact-slot': sheet.slot || '',
                  alt: `${entry.revision} ${sheet.label}`,
                  src: artifactUrl(props.artifactBase, sheet),
                })
            })(),
            (() => {
              const sheet = sheetOf(entry)
              const when = artifactTime(sheet)
              return sheet === null ? null : h('div', { className: 'db-muted db-mono', key: 'sheet' },
                `${sheet.sha256 ? String(sheet.sha256).slice(0, 10) : '—'}${when === null ? '' : ` · 渲染于 ${when}`}`)
            })(),
            h('div', { className: 'db-muted db-mono', key: 'counts' }, `previews ${(entry.previews || []).length} · sheets ${(entry.contactSheets || []).length} · reviews ${(entry.reviews || []).length}`),
            (entry.reviews || []).length > 0
              ? h('div', { key: 'score' }, h(Badge, { tone: entry.reviews[entry.reviews.length - 1].pass ? 'ok' : 'warn' }, `review ${entry.reviews[entry.reviews.length - 1].score === undefined ? '—' : entry.reviews[entry.reviews.length - 1].score} 分`))
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
      const pair = renderPairOf(entryOf(right))
      const rendersMode = props.compareMode !== 'revisions'
      const renderPairPanes = [
        imagePane('left', pair.previous === null ? '上一次渲染' : `上一次渲染 · ${right}`, pair.previous,
          '还没有上一次渲染：再点一次「渲染预览」，这里就会出现前后并排。'),
        imagePane('right', `本次渲染 · ${right}`, pair.current,
          '这个 revision 还没有由面板渲过预览（上方的「渲染预览」会生成第一张）。'),
      ]

      return h('div', { 'data-view': 'preview' },
        h(ErrorBox, { error: props.error }),
        h('div', { className: 'db-tabs' },
          h(Button, { tone: 'primary', action: 'render-preview', disabled: props.busy || props.projectId === null, onClick: props.onRenderPreview }, props.busy ? '渲染中…' : '渲染预览'),
          props.previewResult ? h('span', { 'data-result': props.previewResult.ok ? 'ok' : 'error', className: props.previewResult.ok ? 'db-muted' : 'db-error', style: { border: 0, padding: '0 6px', marginBottom: 0 } }, props.previewResult.message) : null,
        ),
        h('div', { className: 'db-tabs' },
          h('span', { className: 'db-muted' }, '比较：'),
          h('button', {
            type: 'button', className: 'db-btn', 'data-compare-mode': 'renders', 'data-active': String(rendersMode),
            onClick: () => props.onMode('renders'),
          }, '上一次 vs 本次渲染'),
          h('button', {
            type: 'button', className: 'db-btn', 'data-compare-mode': 'revisions', 'data-active': String(!rendersMode),
            onClick: () => props.onMode('revisions'),
          }, '两个 revision'),
          h('span', { style: { flex: 1 } }),
          rendersMode
            ? h('span', { className: 'db-inline' },
              h('span', { className: 'db-muted' }, '版本'),
              h('select', {
                className: 'db-input', 'data-field': 'compare-revision', style: { width: 'auto' }, value: right || '',
                onChange: event => {
                  props.onPick('left', event.target.value)
                  props.onPick('right', event.target.value)
                },
              }, revisions.map(entry => h('option', { key: entry.revision, value: entry.revision }, entry.revision))))
            : h('span', { className: 'db-inline' },
              h('select', {
                className: 'db-input', 'data-field': 'compare-left', style: { width: 'auto' }, value: left || '',
                onChange: event => props.onPick('left', event.target.value),
              }, revisions.map(entry => h('option', { key: entry.revision, value: entry.revision }, entry.revision))),
              h('span', { className: 'db-muted' }, '↔'),
              h('select', {
                className: 'db-input', 'data-field': 'compare-right', style: { width: 'auto' }, value: right || '',
                onChange: event => props.onPick('right', event.target.value),
              }, revisions.map(entry => h('option', { key: entry.revision, value: entry.revision }, entry.revision))),
              props.projectId ? h(Button, { action: 'diff', onClick: () => props.onDiff(left, right) }, '看结构差异') : null),
        ),
        h('div', { style: { paddingTop: '2px' } },
          h('div', { className: 'db-grid' }, rendersMode
            ? renderPairPanes
            : [revisionPane(entryOf(left), 'left'), revisionPane(entryOf(right), 'right')]),
          props.diff ? h('div', { className: 'db-card', 'data-diff': props.diff.identical ? 'identical' : 'changed' },
            h('h4', null, `${props.diff.fromRevision} → ${props.diff.toRevision}：${props.diff.identical ? '结构完全相同' : `${props.diff.totalChanges} 处结构变化`}`),
            props.diff.identical ? null : h('div', null,
              Object.entries(props.diff.collections)
                .filter(([, entry]) => entry.added.length + entry.removed.length + entry.changed.length > 0)
                .map(([kind, entry]) => h('div', { key: kind },
                  h('strong', null, kind),
                  entry.added.length > 0 ? h('div', { className: 'db-muted db-mono' }, `+ ${entry.added.join(', ')}`) : null,
                  entry.removed.length > 0 ? h('div', { className: 'db-muted db-mono' }, `- ${entry.removed.join(', ')}`) : null,
                  entry.changed.map(change => h('div', { key: change.id, className: 'db-muted db-mono' },
                    `~ ${change.id}: ${change.fields.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`)))),
              props.diff.project.length > 0 ? h('div', { className: 'db-muted db-mono' }, `project: ${props.diff.project.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`) : null,
              props.diff.world.length > 0 ? h('div', { className: 'db-muted db-mono' }, `world: ${props.diff.world.map(field => `${field.field} ${JSON.stringify(field.from)} → ${JSON.stringify(field.to)}`).join('; ')}`) : null,
            ),
          ) : null,
          props.diffError ? h(ErrorBox, { error: props.diffError }) : null,
        ),
      )
    }

    /** 任务: live progress, cancel, resume, and the approval threshold. */
    function JobsView(props) {
      const [frameStart, setFrameStart] = react.useState('')
      const [frameEnd, setFrameEnd] = react.useState('')
      const [profile, setProfile] = react.useState('preview')
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const jobs = props.jobs || []

      const start = async (resumeJobId) => {
        setBusy(true)
        const outcome = await postJson(projectRoute(props.projectId, '/render'), {
          resumeJobId,
          frameStart: frameStart === '' ? undefined : Number(frameStart),
          frameEnd: frameEnd === '' ? undefined : Number(frameEnd),
          profile: resumeJobId === undefined ? profile : undefined,
        })
        setBusy(false)
        setResult(outcome.ok
          ? { kind: 'render', ok: true, message: `任务 ${outcome.payload.job.jobId} 已启动（${outcome.payload.job.frames || '?'} 帧）` }
          : { kind: 'render', ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        props.onChanged()
      }

      const cancel = async (jobId) => {
        setBusy(true)
        const outcome = await postJson(projectRoute(props.projectId, `/jobs/${encodeURIComponent(jobId)}/cancel`), {})
        setBusy(false)
        setResult(outcome.ok
          ? {
            kind: 'cancel',
            ok: outcome.payload.cancelled.processGone !== false,
            message: outcome.payload.cancelled.processGone === false
              ? '取消已请求，但进程仍在'
              : `已取消 ${jobId}，进程实测已消失`,
          }
          : { kind: 'cancel', ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        props.onChanged()
      }

      if (props.projectId === null) return h('div', { 'data-view': 'jobs', className: 'db-muted' }, '尚未选择项目。')

      return h('div', { 'data-view': 'jobs' },
        h(ErrorBox, { error: props.error }),
        h('div', { className: 'db-card' },
          h('h4', null, '任务'),
          jobs.length === 0
            ? h('div', { className: 'db-muted' }, '还没有渲染任务。')
            : h('ul', { className: 'db-list' }, jobs.map(job => h('li', { key: job.jobId, 'data-job': job.jobId },
              h('div', { className: 'db-inline' },
                h('span', { className: 'db-mono' }, job.jobId),
                h(Badge, { tone: statusTone(job.status) }, job.status),
                h('span', { className: 'db-muted' }, job.type),
                h('span', { className: 'db-muted db-mono' }, `帧 ${job.frameStart}–${job.frameEnd}`),
                job.approval && job.approval.required ? h(Badge, { tone: 'warn', name: 'approval' }, `需审批：${job.approval.frames} 帧 > 阈值 ${job.approval.threshold}`) : null,
                job.deliverable ? h(Badge, { tone: 'ok' }, '交付已校验') : null,
                job.cancelable ? h(Button, { tone: 'danger', action: `cancel:${job.jobId}`, disabled: busy, onClick: () => cancel(job.jobId) }, '取消') : null,
                job.resumable ? h(Button, { action: `resume:${job.jobId}`, disabled: busy, onClick: () => start(job.jobId) }, '继续渲染') : null,
              ),
              h(ProgressBar, { percent: job.progress.percent }),
              h('div', { className: 'db-muted', 'data-job-detail': job.jobId }, `${job.detail} · ${job.progress.percent}% · 缺失 ${job.progress.missing} · 损坏 ${job.progress.corrupt}`),
              job.errorCode ? h('div', { className: 'db-error', style: { marginTop: '4px' } }, `${job.errorCode}: ${job.message || ''}`) : null,
              job.delivery ? h('div', { className: 'db-muted db-mono' }, `video ${job.delivery.videoPath || ''}`) : null,
            ))),
        ),

        h('div', { className: 'db-card' },
          h('h4', null, '启动一次交付渲染（写操作经 Host）'),
          h('div', { className: 'db-inline' },
            h('label', { className: 'db-muted' }, '帧起'),
            h('input', { className: 'db-input', 'data-field': 'frame-start', style: { width: '90px' }, value: frameStart, onChange: event => setFrameStart(event.target.value) }),
            h('label', { className: 'db-muted' }, '帧止'),
            h('input', { className: 'db-input', 'data-field': 'frame-end', style: { width: '90px' }, value: frameEnd, onChange: event => setFrameEnd(event.target.value) }),
            h('label', { className: 'db-muted' }, 'profile'),
            h('select', {
              className: 'db-input', 'data-field': 'render-profile', style: { width: 'auto' }, value: profile,
              onChange: event => setProfile(event.target.value),
            },
              h('option', { value: 'preview' }, 'preview'),
              h('option', { value: 'final' }, 'final')),
            h(Button, { tone: 'primary', action: 'start-render', disabled: busy, onClick: () => start(undefined) }, busy ? '提交中…' : '启动'),
          ),
          result ? h('div', { 'data-result': result.ok ? 'ok' : 'error', 'data-result-kind': result.kind || 'render', className: result.ok ? 'db-muted' : 'db-error', style: { marginTop: '8px' } }, result.message) : null,
        ),
      )
    }

    /** QA: technical validation and the visual review, never merged. */
    function QaView(props) {
      const qa = props.qa
      if (qa === null || qa === undefined) return h('div', { 'data-view': 'qa', className: 'db-muted' }, '尚未选择项目。')
      const issueList = (issues, keyPrefix) => h('ul', { className: 'db-list' }, issues.map((issue, index) => h('li', { key: `${keyPrefix}${index}` },
        h('div', { className: 'db-inline' },
          h(Badge, { tone: issue.severity === 'critical' ? 'bad' : issue.severity === 'major' ? 'warn' : 'muted' }, issue.severity || '—'),
          h('span', { className: 'db-mono' }, issue.code || '—'),
          issue.category ? h('span', { className: 'db-muted' }, issue.category) : null,
          issue.viewId ? h('span', { className: 'db-muted db-mono' }, issue.viewId) : null,
        ),
        h('div', null, issue.evidence || ''))))

      return h('div', { 'data-view': 'qa' },
        h(ErrorBox, { error: props.error }),
        h('div', { className: 'db-card', 'data-qa-revision': qa.revision },
          h('div', { className: 'db-inline' },
            h('strong', null, `QA · ${qa.revision}`),
            h(Badge, { tone: qa.technical.ok ? 'ok' : 'bad' }, qa.technical.available ? (qa.technical.ok ? '技术校验通过' : `技术错误 ${qa.technical.errorCount}`) : '无技术校验记录'),
            qa.visual.available ? h(Badge, { tone: qa.visual.pass ? 'ok' : 'warn' }, `视觉评分 ${qa.visual.score}`) : h(Badge, null, '未跑视觉评审'),
            qa.semantic.noticeCount > 0 ? h(Badge, { tone: 'warn' }, `${qa.semantic.noticeCount} 条 notices`) : null,
          ),
          h('div', { className: 'db-muted', style: { marginTop: '4px' } }, qa.summary),
        ),

        h('div', { className: 'db-card' },
          h('h4', null, '技术校验（validation.json）'),
          h(KeyValues, { entries: [
            { label: '引擎', value: qa.technical.engine },
            { label: '活动相机', value: qa.technical.activeCamera },
            { label: '帧范围', value: qa.technical.frameRange ? qa.technical.frameRange.join('–') : null },
            { label: '对象', value: qa.technical.counts ? qa.technical.counts.objects : null },
            { label: '材质', value: qa.technical.counts ? qa.technical.counts.materials : null },
            { label: '相机', value: qa.technical.counts ? qa.technical.counts.cameraObjects : null },
          ] }),
          qa.technical.errors.length === 0
            ? h('div', { className: 'db-muted' }, '没有技术错误。')
            : issueList(qa.technical.errors, 'tech'),
          qa.semantic.notices.length === 0 ? null : h('div', { style: { marginTop: '8px' } },
            h('h4', null, '编译器 notices'),
            h('ul', { className: 'db-list' }, qa.semantic.notices.map((notice, index) => h('li', { key: `n${index}` },
              h('span', { className: 'db-mono' }, notice.code || ''), ' ', notice.message || '')))),
        ),

        h('div', { className: 'db-card' },
          h('h4', null, '视觉评审（测量 + 模型 finding，两个来源不合并）'),
          qa.visual.available
            ? h('div', null,
              h(KeyValues, { entries: [
                { label: '分数', value: qa.visual.score },
                { label: '通过', value: qa.visual.pass ? '是' : '否' },
                { label: '轮次', value: qa.visual.iteration },
                { label: '主体', value: qa.visual.subjectId },
                { label: '视角数', value: qa.visual.viewCount },
                { label: '审查器', value: qa.visual.reviewerAvailable ? (qa.visual.reviewerModel || '已调用') : (qa.visual.reviewerError || '未调用') },
              ] }),
              qa.visual.measuredIssues.length === 0 ? h('div', { className: 'db-muted' }, '测量没有发现问题。') : issueList(qa.visual.measuredIssues, 'm'),
              qa.visual.findings.length === 0
                ? h('div', { className: 'db-muted' }, qa.visual.reviewerAvailable ? '审查器没有报告 finding。' : '没有第二意见。')
                : issueList(qa.visual.findings, 'f'))
            : h('div', { className: 'db-muted' }, '这个 revision 还没有视觉评审。可以用 blender_visual_review 跑一次。'),
        ),
      )
    }

    /** 版本: the revision list, restore, and the hand-off to Preview Compare. */
    function RevisionsView(props) {
      const [busy, setBusy] = react.useState(false)
      const [result, setResult] = react.useState(null)
      const revisions = (props.state && props.state.revisions) || []

      const restore = async (revision) => {
        setBusy(true)
        const outcome = await postJson(projectRoute(props.projectId, '/restore'), { revision })
        setBusy(false)
        setResult(outcome.ok
          ? { ok: true, message: `已恢复 ${revision} 为 ${outcome.payload.revision.revision}` }
          : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
        props.onChanged()
      }

      if (props.projectId === null) return h('div', { 'data-view': 'revisions', className: 'db-muted' }, '尚未选择项目。')

      return h('div', { 'data-view': 'revisions' },
        h(ErrorBox, { error: props.error }),
        h('div', { className: 'db-card' },
          h('h4', null, `版本（${revisions.length}）`),
          h('ul', { className: 'db-list' }, revisions.map(entry => h('li', { key: entry.revision, 'data-revision': entry.revision },
            h('div', { className: 'db-inline' },
              h('span', { className: 'db-mono' }, entry.revision),
              entry.isCurrent ? h(Badge, { tone: 'ok' }, '当前') : null,
              h('span', { className: 'db-muted' }, entry.kind || '—'),
              h('span', { className: 'db-muted' }, formatTime(entry.createdAt)),
              h('span', { className: 'db-muted db-mono' }, `digest ${shortDigest(entry.digest)}`),
              h(Button, { action: `compare-from:${entry.revision}`, onClick: () => props.onCompare(entry.revision) }, '对比'),
              entry.isCurrent ? null : h(Button, { action: `restore:${entry.revision}`, disabled: busy, onClick: () => restore(entry.revision) }, '恢复'),
            ),
            h('div', { className: 'db-muted' }, entry.summary || '（无说明）'),
            h('div', { className: 'db-muted db-mono' }, `previews ${(entry.previews || []).length} · validation ${entry.validation ? (entry.validation.ok ? 'ok' : `${entry.validation.errorCount} errors`) : '—'}`),
          ))),
          result ? h('div', { 'data-result': result.ok ? 'ok' : 'error', className: result.ok ? 'db-muted' : 'db-error', style: { marginTop: '8px' } }, result.message) : null,
        ),
      )
    }

    /**
     * The panel: a header, the view nav, and the active view.
     *
     * The selected project and the compare pair are LOCAL UI state (SPEC §14.3).
     * Everything they point at is read from the Host on every render pass, so the
     * mirror cannot outlive the truth.
     */
    function WorkbenchPanel() {
      const [view, setView] = react.useState('projects')
      const [projectId, setProjectId] = react.useState(null)
      const [compareLeft, setCompareLeft] = react.useState(null)
      const [compareRight, setCompareRight] = react.useState(null)
      const [diff, setDiff] = react.useState(null)
      const [diffError, setDiffError] = react.useState(null)
      const [previewBusy, setPreviewBusy] = react.useState(false)
      const [previewResult, setPreviewResult] = react.useState(null)
      // Which pair Preview Compare shows. Local UI state, like the rest of this
      // panel's selections (SPEC §14.3): it decides what is DISPLAYED, never what is
      // true.
      const [compareMode, setCompareMode] = react.useState('renders')
      const [tick, setTick] = react.useState(0)

      const statePath = projectId === null
        ? `${ROUTES.state}?t=${tick}`
        : `${ROUTES.state}?projectId=${encodeURIComponent(projectId)}&t=${tick}`
      const state = useHostRoute(statePath, { route: 'state', intervalMs: POLL_IDLE_MS })
      const payload = state.payload
      const selected = payload && payload.selected ? payload.selected : null
      const activeProjectId = projectId !== null
        ? projectId
        : (payload && payload.projects && payload.projects[0] ? payload.projects[0].projectId : null)

      const liveJobs = selected !== null && (selected.unfinishedJobs || []).length > 0
      const jobs = useHostRoute(
        activeProjectId === null ? `${ROUTES.state}?t=${tick}` : `${projectRoute(activeProjectId, '/jobs')}?t=${tick}`,
        { route: activeProjectId === null ? 'state' : 'project.jobs', intervalMs: liveJobs ? POLL_LIVE_MS : POLL_IDLE_MS },
      )
      const previews = useHostRoute(
        activeProjectId === null ? `${ROUTES.state}?t=${tick}` : `${projectRoute(activeProjectId, '/previews')}?t=${tick}`,
        { route: activeProjectId === null ? 'state' : 'project.previews', intervalMs: 0 },
      )

      /** A write just happened: re-run every read, including the view-specific ones. */
      const reload = () => setTick(value => value + 1)

      const error = state.error || jobs.error || previews.error
      const jobPayload = jobs.payload
      const previewPayload = previews.payload
      const stale = state.status === 'stale' || jobs.status === 'stale' || previews.status === 'stale'

      const body = (() => {
        if (stale) return h('div', { className: 'db-body' }, h(ErrorBox, { error: state.error }))
        if (payload === null) return h('div', { className: 'db-body db-muted' }, '读取 Host 状态…')
        switch (view) {
          case 'scene':
            return h('div', { className: 'db-body' }, h(SceneView, {
              state: selected,
              projectId: activeProjectId,
              error: state.error,
              onChanged: reload,
            }))
          case 'preview':
            return h('div', { className: 'db-body' }, h(PreviewView, {
              previews: previewPayload && previewPayload.previews ? previewPayload.previews : null,
              artifactBase: previewPayload && previewPayload.artifactBase ? previewPayload.artifactBase : '',
              projectId: activeProjectId,
              busy: previewBusy,
              previewResult,
              compareMode,
              onMode: setCompareMode,
              onRenderPreview: async () => {
                setPreviewBusy(true)
                setPreviewResult(null)
                const outcome = await postJson(projectRoute(activeProjectId, '/preview'), {})
                setPreviewBusy(false)
                setPreviewResult(outcome.ok
                  ? {
                    ok: true,
                    message: `已渲染 ${outcome.payload.preview.views.length} 个视角 → 合成 ${outcome.payload.preview.revision} 的 contact sheet`
                      + (outcome.payload.preview.sheets && outcome.payload.preview.sheets.previous
                        ? '；上一张已留作「上一次渲染」，可以直接并排比较'
                        : '（这是第一张；再渲染一次就能并排比较前后）')
                      + '。预览是产物：替换同一路径上的旧图，不产生新的 revision。',
                  }
                  : { ok: false, message: `${outcome.error.code}: ${outcome.error.message}` })
                reload()
              },
              compareLeft: compareLeft || (selected ? selected.currentRevision : null),
              compareRight: compareRight || (selected ? selected.currentRevision : null),
              diff,
              diffError,
              onPick: (side, revision) => {
                setDiff(null)
                setDiffError(null)
                if (side === 'left') setCompareLeft(revision)
                else setCompareRight(revision)
              },
              onDiff: async (from, to) => {
                setDiffError(null)
                try {
                  const response = await fetch(`${projectRoute(activeProjectId, '/diff')}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { headers: { accept: 'application/json' } })
                  const parsed = await response.json()
                  if (parsed && parsed.ok) setDiff(parsed.diff)
                  else {
                    setDiff(null)
                    setDiffError((parsed && parsed.error) || { code: `HTTP_${response.status}`, message: 'diff 失败' })
                  }
                } catch (error2) {
                  setDiff(null)
                  setDiffError({ code: 'UI_FETCH_FAILED', message: String((error2 && error2.message) || error2) })
                }
              },
            }))
          case 'jobs':
            return h('div', { className: 'db-body' }, h(JobsView, {
              jobs: jobPayload && jobPayload.jobs ? jobPayload.jobs : [],
              projectId: activeProjectId,
              error: jobs.error,
              onChanged: reload,
            }))
          case 'qa':
            return h('div', { className: 'db-body' }, h(QaView, { qa: selected ? selected.qa : null, error: state.error }))
          case 'revisions':
            return h('div', { className: 'db-body' }, h(RevisionsView, {
              state: selected,
              projectId: activeProjectId,
              error: state.error,
              onChanged: reload,
              onCompare: revision => {
                setCompareLeft(revision)
                setView('preview')
              },
            }))
          default:
            return h('div', { className: 'db-body' }, h(ProjectsView, {
              projects: payload.projects || [],
              projectsRoot: payload.projectsRoot,
              selectedId: activeProjectId,
              state: selected,
              error: state.error,
              onSelect: (id) => {
                setProjectId(id)
                setDiff(null)
                setCompareLeft(null)
                setCompareRight(null)
              },
              onCreated: (id) => {
                setProjectId(id)
                reload()
              },
            }))
        }
      })()

      return h('div', { className: 'db-root', 'data-deepblend-panel': PANEL_ID },
        h('div', { className: 'db-head' },
          h('span', { className: 'db-title' }, `${PANEL_LABEL} 工作台`),
          selected ? h('span', { className: 'db-muted' }, selected.project.title) : null,
          selected ? h(Badge, null, selected.currentRevision || '—') : null,
          selected && (selected.unfinishedJobs || []).length > 0
            ? h(Badge, { tone: 'live', name: 'unfinished' }, `${selected.unfinishedJobs.length} 个任务在跑`)
            : null,
          payload && payload.hostApiVersion !== EXPECTED_HOST_API
            ? h(Badge, { tone: 'warn', name: 'api' }, `hostApiVersion ${payload.hostApiVersion} ≠ ${EXPECTED_HOST_API}`)
            : null,
          h('span', { style: { flex: 1 } }),
          h(Button, { action: 'reload', onClick: reload }, '刷新'),
        ),
        h('div', { className: 'db-nav' }, VIEWS.map(entry => h('button', {
          key: entry.id,
          type: 'button',
          'data-view-tab': entry.id,
          'data-active': String(view === entry.id),
          onClick: () => setView(entry.id),
        }, entry.label))),
        error !== null && error !== undefined && !stale ? h('div', { style: { padding: '8px 14px 0' } }, h(ErrorBox, { error })) : null,
        body,
      )
    }

    /** The settings page: the M0 card, now with a seat. */
    function BlenderSettingsPage() {
      const state = useHostRoute(ROUTES.capabilities, { route: 'capabilities', intervalMs: 0 })
      const payload = state.payload
      const card = payload ? payload.card : null

      return h('div', { 'data-deepblend-settings': PANEL_ID, style: { padding: '4px 2px' } },
        state.error !== null && state.error !== undefined ? h(ErrorBox, { error: state.error }) : null,
        state.status === 'loading' ? h('div', { className: 'db-muted' }, '检测 Blender…') : null,
        card === null ? null : h('div', null,
          h('div', { className: 'db-inline' },
            h('strong', null, card.title),
            h(Badge, { tone: card.status === 'ready' ? 'ok' : 'bad' }, card.statusLabel),
            card.probedAt ? h('span', { className: 'db-muted' }, `探测于 ${formatTime(card.probedAt)}`) : null,
          ),
          h('div', { className: 'db-card', style: { marginTop: '8px' } },
            card.rows.map(row => h(Row, { key: row.label, label: row.label, value: row.value }))),
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
      const [expanded, setExpanded] = react.useState(false)

      const jobShaped = ['blender_final_render', 'blender_export', 'blender_job_status', 'blender_job_cancel'].includes(toolName)
      const reviewShaped = ['blender_visual_review', 'blender_visual_autofix', 'blender_preview_views'].includes(toolName)
      const canReadJob = projectId !== null && jobId !== null
      const idle = `${ROUTES.state}?t=0`

      const jobState = useHostRoute(
        canReadJob ? projectRoute(projectId, `/jobs/${encodeURIComponent(jobId)}`) : idle,
        { route: canReadJob ? 'project.job' : 'state', intervalMs: jobShaped && canReadJob ? POLL_LIVE_MS : 0 },
      )
      const qaState = useHostRoute(
        projectId === null ? idle : projectRoute(projectId, '/qa'),
        { route: projectId === null ? 'state' : 'project.qa', intervalMs: reviewShaped && projectId !== null ? POLL_IDLE_MS : 0 },
      )
      const previewState = useHostRoute(
        projectId === null ? idle : projectRoute(projectId, '/previews'),
        { route: projectId === null ? 'state' : 'project.previews', intervalMs: 0 },
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
          jobId ? h(Badge, null, jobId) : null,
          Array.isArray(args.operations) ? h(Badge, null, `${args.operations.length} 个操作`) : null,
          job && job.approval && job.approval.required ? h(Badge, { tone: 'warn', name: 'approval' }, `需审批：${job.approval.frames} 帧 > ${job.approval.threshold}`) : null,
          h('span', { style: { flex: 1 } }),
          settled ? h('button', { type: 'button', className: 'db-chip', 'data-action': 'toggle-card', onClick: () => setExpanded(value => !value) }, expanded ? '收起' : '详情') : null,
        ),

        jobShaped && job !== null ? h('div', { 'data-tool-job': job.jobId },
          h('div', { className: 'db-inline' },
            h(Badge, { tone: statusTone(job.status) }, job.status),
            h('span', { className: 'db-muted' }, `${job.progress.completed}/${job.progress.expected} 帧 · ${job.progress.percent}%`),
            job.estimatedRemainingMs ? h('span', { className: 'db-muted' }, `预计 ${Math.round(job.estimatedRemainingMs / 1000)} s`) : null,
          ),
          h(ProgressBar, { percent: job.progress.percent }),
          h('div', { className: 'db-muted' }, job.detail),
          job.delivery ? h('div', { className: 'db-muted db-mono' }, String(job.delivery.videoPath || '')) : null,
        ) : null,

        reviewShaped && qa !== null ? h('div', { 'data-tool-qa': qa.revision },
          h('div', { className: 'db-inline' },
            qa.visual.available ? h(Badge, { tone: qa.visual.pass ? 'ok' : 'warn' }, `视觉评分 ${qa.visual.score}`) : h(Badge, null, '未跑视觉评审'),
            h(Badge, { tone: qa.technical.ok ? 'ok' : 'bad' }, qa.technical.available ? (qa.technical.ok ? '技术校验通过' : `${qa.technical.errorCount} 个技术错误`) : '无记录'),
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
      const state = useHostRoute(ROUTES.projects, { route: 'projects.list', intervalMs: POLL_LIVE_MS })
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
    return module.exports
  },
})
