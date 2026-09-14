/**
 * The workbench UI's contract: the HTTP route vocabulary and the view models
 * behind it (SPEC §14.2–§14.4).
 *
 * Why this lives in `contracts` and not in the UI package:
 *
 *  - **One place per word.** This repository has already paid five times for the
 *    same vocabulary written twice (D38, D43, D57, D60). M4 adds route paths,
 *    view ids, tool-card keys and the `dsh.client` id — so a path is spelled here
 *    once, and the Host router, the client plugin and the tests all read it.
 *  - **Testable without a browser.** Everything here is a pure function of Host
 *    data. The scene tree, the revision diff, the QA view and the approval badge
 *    are therefore covered by contract tests instead of by clicking.
 *  - **The browser holds no authority.** SPEC §14.3: the Host service owns the
 *    state; the client keeps a mirror and its own UI selections. A view model
 *    built here is built by the Host, per request, from `blenderStudio`.
 *
 * Plane: contracts (pure data and rules). No I/O, no Blender, no Cordis.
 */

import { RENDER_JOB_TERMINAL_STATUSES } from './render-job.js'

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Every UI route shares this prefix; the M0 settings route already did. */
export const UI_ROUTE_PREFIX = '/deepblend'

/** Marker in a `path` that captures the remainder of the request path. */
export const UI_REST_MARKER = '*'

/**
 * The complete route table.
 *
 * `write: true` marks a route that changes something on disk. Every one of them
 * is served by calling `blenderStudio` — the browser never touches a file, and
 * `deepblend/tests/contract/ui-api.test.mjs` asserts that the handler table has
 * exactly these ids and nothing else (a closed set, SPEC §20 M4 "所有写操作经过
 * Host").
 *
 * @type {ReadonlyArray<{ id: string, method: string, path: string, write: boolean, summary: string }>}
 */
export const UI_ROUTES = Object.freeze([
  { id: 'capabilities', method: 'GET', path: '/deepblend/capabilities', write: false, summary: 'Blender capabilities and the settings card.' },
  { id: 'state', method: 'GET', path: '/deepblend/state', write: false, summary: 'Everything the panel needs to render itself from scratch.' },
  { id: 'projects.list', method: 'GET', path: '/deepblend/projects', write: false, summary: 'Every project in the store.' },
  { id: 'projects.create', method: 'POST', path: '/deepblend/projects', write: true, summary: 'Create a project (title, optional seed scene).' },
  { id: 'project.overview', method: 'GET', path: '/deepblend/projects/:projectId', write: false, summary: 'One project: summary, revisions, current digest.' },
  { id: 'project.scene', method: 'GET', path: '/deepblend/projects/:projectId/scene', write: false, summary: 'The Scene Tree of a revision.' },
  { id: 'project.revisions', method: 'GET', path: '/deepblend/projects/:projectId/revisions', write: false, summary: 'Every revision with its manifest and QA verdict.' },
  { id: 'project.revision', method: 'GET', path: '/deepblend/projects/:projectId/revisions/:revision', write: false, summary: 'One revision in full: manifest, QA, previews, operations.' },
  { id: 'project.diff', method: 'GET', path: '/deepblend/projects/:projectId/diff', write: false, summary: 'Structural diff between two revisions (?from=&to=).' },
  { id: 'project.qa', method: 'GET', path: '/deepblend/projects/:projectId/qa', write: false, summary: 'The QA view of a revision (?revision=).' },
  { id: 'project.previews', method: 'GET', path: '/deepblend/projects/:projectId/previews', write: false, summary: 'Preview sets per revision, for Preview Compare.' },
  { id: 'project.preview', method: 'POST', path: '/deepblend/projects/:projectId/preview', write: true, summary: 'Render the low-cost multi-view preview (and its contact sheet).' },
  { id: 'project.patch', method: 'POST', path: '/deepblend/projects/:projectId/patch', write: true, summary: 'Apply a ScenePatch as one atomic revision.' },
  { id: 'project.restore', method: 'POST', path: '/deepblend/projects/:projectId/restore', write: true, summary: 'Restore an earlier revision as a new revision.' },
  { id: 'project.jobs', method: 'GET', path: '/deepblend/projects/:projectId/jobs', write: false, summary: 'Render/export jobs of a project.' },
  { id: 'project.job', method: 'GET', path: '/deepblend/projects/:projectId/jobs/:jobId', write: false, summary: 'One job with its live progress.' },
  { id: 'project.job.cancel', method: 'POST', path: '/deepblend/projects/:projectId/jobs/:jobId/cancel', write: true, summary: 'Cancel a running job and verify the process is gone.' },
  { id: 'project.render', method: 'POST', path: '/deepblend/projects/:projectId/render', write: true, summary: 'Start a delivery render (or resume one).' },
  { id: 'artifacts.open', method: 'GET', path: '/deepblend/artifacts/:projectId/*', write: false, summary: 'Serve one project-relative artifact (a preview PNG).' },
])

/** Route ids by name, so a caller never repeats a path or an id. */
export const UI_ROUTE_IDS = Object.freeze(
  Object.fromEntries(UI_ROUTES.map(route => [route.id, route.id])),
)

/**
 * Decode the tail a `*` captured.
 *
 * The tail is the ONE route parameter that is handed to a path guard
 * (`readArtifact` → `resolveInside`), and a guard that receives `%2e%2e%2f` text
 * cannot recognize it as `..` — it would look for a file literally named that.
 * Decoding here means the guard sees the path the request actually names, which
 * is the only form in which refusing it is meaningful. A malformed escape is
 * kept verbatim: it names no file either way, and the guard answers 404 rather
 * than the router throwing before a response exists.
 *
 * @param {string[]} segments
 * @returns {string}
 */
function decodePathTail(segments) {
  const raw = segments.join('/')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Compile one route path into a matcher.
 *
 * Small on purpose: segment-wise, `:name` captures one segment, `*` captures the
 * rest. A hand-written router keeps the route table the single source of truth
 * (a framework would want its own spelling of the same paths).
 *
 * @param {string} path
 * @returns {(segments: string[]) => Record<string, string> | null}
 */
function compilePath(path) {
  const parts = path.split('/').filter(part => part.length > 0)
  return (segments) => {
    /** @type {Record<string, string>} */
    const params = {}
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (part === UI_REST_MARKER) {
        if (index >= segments.length) return null
        params.rest = decodePathTail(segments.slice(index))
        return params
      }
      const segment = segments[index]
      if (segment === undefined) return null
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segment)
      else if (part !== segment) return null
    }
    return segments.length === parts.length ? params : null
  }
}

const COMPILED_ROUTES = UI_ROUTES.map(route => ({ route, match: compilePath(route.path) }))

/**
 * Resolve a request to a route.
 *
 * @param {string} method - HTTP method; only the table's own methods match.
 * @param {string} pathname - request path without the query string.
 * @returns {{ route: object, params: Record<string, string> } | null}
 * @throws {Error} when the table contains two routes with one id (a programming error).
 */
export function matchUiRoute(method, pathname) {
  const segments = String(pathname ?? '').split('/').filter(part => part.length > 0)
  for (const entry of COMPILED_ROUTES) {
    if (entry.route.method !== method) continue
    const params = entry.match(segments)
    if (params !== null) return { route: entry.route, params }
  }
  return null
}

/** The routes a browser may POST to. Used by the acceptance test as a closed set. */
export function writeRouteIds() {
  return UI_ROUTES.filter(route => route.write).map(route => route.id)
}

// ---------------------------------------------------------------------------
// Panel vocabulary
// ---------------------------------------------------------------------------

/**
 * The M4 deliverables, as the panel's own navigation.
 *
 * SPEC §20 M4 lists nine items; the sidebar entry, the tool cards, the settings
 * page and the approval display are seats elsewhere (they are not panel views).
 * The panel therefore renders these six, and `deepblend/tests/contract/ui-api.test.mjs`
 * asserts that every deliverable is reachable from exactly one of the two lists.
 */
export const UI_PANEL_VIEWS = Object.freeze([
  { id: 'projects', label: '项目', summary: 'Projects and the create form (SPEC §20 M4 "不进入文件系统即可管理项目").' },
  { id: 'scene', label: '场景树', summary: 'Scene Tree of a revision.' },
  { id: 'preview', label: '预览对比', summary: 'Preview Compare: two revisions side by side.' },
  { id: 'jobs', label: '任务', summary: 'Jobs with live progress, cancel and the approval threshold.' },
  { id: 'qa', label: 'QA', summary: 'Technical and measured issues of a revision.' },
  { id: 'revisions', label: '版本', summary: 'Revisions, their diffs and restore.' },
])

/**
 * The two slots a preview render writes its contact sheet into.
 *
 * A preview render REPLACES its own image (D28/D69), so on its own it can only ever
 * show you the present. Keeping one generation back is what makes SPEC §14.2's
 * 「Preview 前后对比」 mean something for a change you just made: the pair is
 * *上一次渲染 / 本次渲染* of one revision — a different axis from comparing two
 * revisions, and the one a person reaches for right after clicking render.
 *
 * One spelling, read by the Host (which writes the slots), the client (which
 * displays them) and the suite that asserts the pair exists.
 */
export const PREVIEW_SHEET_SLOTS = Object.freeze({
  /** The sheet this render just composed. */
  current: 'preview-current',
  /** The sheet the previous render composed, kept for comparison. */
  previous: 'preview-previous',
})

/** The sidebar entry id — also the `main` panel key it selects. */
export const UI_PANEL_ID = 'deepblend'

/** Label of the sidebar entry, the settings page and the panel itself. */
export const UI_PANEL_LABEL = 'Blender'

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

/** Deep-clone through JSON so a view model never shares a live object. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Stable stringify with sorted keys, for comparing two items field by field. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/** The fields of two objects that differ, as `{ field, from, to }`. */
function changedFields(before, after) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()
  const changes = []
  for (const key of keys) {
    const from = before?.[key]
    const to = after?.[key]
    if (canonical(from) === canonical(to)) continue
    changes.push({ field: key, from: clone(from) ?? null, to: clone(to) ?? null })
  }
  return changes
}

/**
 * One comparable collection in a SceneSpec: how the diff addresses it.
 *
 * The key is the entity kind from the document, so a diff of two revisions says
 * `entities/watch-body` rather than "item 4".
 */
const DIFF_COLLECTIONS = Object.freeze([
  { key: 'entities', idField: 'id' },
  { key: 'materials', idField: 'id' },
  { key: 'lights', idField: 'id' },
  { key: 'cameras', idField: 'id' },
  { key: 'shots', idField: 'id' },
  { key: 'animationTracks', idField: 'id' },
  { key: 'assets', idField: 'id' },
])

/**
 * Structural diff of two SceneSpec documents (SPEC §14.4 `diffRevisions`).
 *
 * Deliberately structural rather than textual: "r0020 added 7 animation tracks"
 * is what a human comparing revisions needs, while a text diff of two 400-line
 * JSON documents is unreadable and reorders on every write.
 *
 * @param {object} from - the older spec
 * @param {object} to - the newer spec
 * @param {{ fromRevision?: string, toRevision?: string }} [context]
 * @returns {Record<string, unknown>}
 */
export function buildRevisionDiff(from, to, context = {}) {
  /** @type {Record<string, unknown>} */
  const collections = {}
  for (const { key, idField } of DIFF_COLLECTIONS) {
    const before = new Map((from?.[key] ?? []).map(item => [item[idField], item]))
    const after = new Map((to?.[key] ?? []).map(item => [item[idField], item]))
    const added = [...after.keys()].filter(id => !before.has(id)).sort()
    const removed = [...before.keys()].filter(id => !after.has(id)).sort()
    const changed = []
    for (const id of [...after.keys()].filter(candidate => before.has(candidate)).sort()) {
      const fields = changedFields(before.get(id), after.get(id))
      if (fields.length > 0) changed.push({ id, fields })
    }
    collections[key] = { added, removed, changed }
  }

  const projectChanges = changedFields(from?.project, to?.project)
  const worldChanges = changedFields(from?.world ?? null, to?.world ?? null)
  const renderProfileChanges = changedFields(from?.renderProfiles, to?.renderProfiles)

  const totalChanges = Object.values(collections)
    .reduce((sum, entry) => sum + entry.added.length + entry.removed.length + entry.changed.length, 0)
    + projectChanges.length + worldChanges.length + renderProfileChanges.length

  return {
    fromRevision: context.fromRevision ?? null,
    toRevision: context.toRevision ?? null,
    identical: totalChanges === 0,
    totalChanges,
    collections,
    project: projectChanges,
    world: worldChanges,
    renderProfiles: renderProfileChanges,
  }
}

/**
 * The Scene Tree (SPEC §14.2 "Scene Tree").
 *
 * One tree of the SceneSpec's own collections under their Blender collection
 * names, because those names are what the compiled `.blend` actually contains
 * (`collectionNameForKind`). A tree that invented its own grouping would send a
 * human looking for a collection that does not exist in the outliner.
 *
 * @param {object} spec - a SceneSpec document
 * @param {{ revision?: string, digest?: string, compiled?: object|null }} [context]
 * @returns {Record<string, unknown>}
 */
export function buildSceneTree(spec, context = {}) {
  const entities = spec?.entities ?? []
  const lights = spec?.lights ?? []
  const cameras = spec?.cameras ?? []
  const materials = spec?.materials ?? []
  const shots = spec?.shots ?? []
  const tracks = spec?.animationTracks ?? []
  const assets = spec?.assets ?? []

  /** @type {Record<string, unknown[]>} */
  const nodes = {
    entities: entities.map(entity => ({
      id: entity.id,
      kind: entity.type,
      shape: entity.generator?.shape ?? null,
      assetId: entity.assetId ?? null,
      materialId: entity.materialId ?? null,
      tags: entity.tags ?? [],
      locked: entity.locked === true,
      transform: clone(entity.transform ?? null),
      detail: entity.detail ?? null,
    })),
    materials: materials.map(material => ({
      id: material.id,
      shader: material.shader ?? null,
      parameters: clone(material.parameters ?? null),
    })),
    lights: lights.map(light => ({
      id: light.id,
      type: light.type ?? null,
      energy: light.energy ?? null,
      transform: clone(light.transform ?? null),
    })),
    cameras: cameras.map(camera => ({
      id: camera.id,
      role: camera.role ?? null,
      lens: camera.lens ?? null,
      targetEntityId: camera.targetEntityId ?? null,
      isActive: (spec?.project?.activeCamera ?? null) === camera.id,
    })),
    shots: shots.map(shot => ({ id: shot.id, cameraId: shot.cameraId ?? null, frameRange: clone(shot.frameRange ?? null), description: shot.description ?? null })),
    animationTracks: tracks.map(track => ({
      id: track.id,
      targetKind: track.targetKind ?? 'entity',
      targetId: track.targetEntityId ?? track.targetCameraId ?? track.targetMaterialId ?? null,
      property: track.property ?? null,
      keyframes: (track.keyframes ?? []).length,
      frameRange: (track.keyframes ?? []).length === 0
        ? null
        : [track.keyframes[0].frame, track.keyframes[track.keyframes.length - 1].frame],
    })),
    assets: assets.map(asset => ({ id: asset.id, type: asset.type ?? null, path: asset.path ?? null, sha256: asset.sha256 ?? null })),
  }

  return {
    revision: context.revision ?? null,
    digest: context.digest ?? null,
    project: {
      id: spec?.project?.id ?? null,
      title: spec?.project?.title ?? null,
      fps: spec?.project?.fps ?? null,
      frameStart: spec?.project?.frameStart ?? null,
      frameEnd: spec?.project?.frameEnd ?? null,
      activeCamera: spec?.project?.activeCamera ?? null,
    },
    world: clone(spec?.world ?? null),
    counts: {
      entities: nodes.entities.length,
      materials: nodes.materials.length,
      lights: nodes.lights.length,
      cameras: nodes.cameras.length,
      shots: nodes.shots.length,
      animationTracks: nodes.animationTracks.length,
      assets: nodes.assets.length,
    },
    nodes,
    compiledAvailable: context.compiled !== undefined && context.compiled !== null,
  }
}

/**
 * The QA view (SPEC §14.2 "QA Issues").
 *
 * Two independent sources, reported side by side and never merged: the technical
 * validation stored with the revision, and the measured issues of the most recent
 * visual review. Merging them would hide which one said what — and M2's whole
 * argument is that they are separate evidence. The field names are the ones the
 * producers actually write (`validation.json`: `{ semantic, technical }`; the
 * review document: `issues` measured here, `reported` authored by the model).
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.revision
 * @param {object|null} [input.validation] - `revisions/<r>/validation.json`
 * @param {object|null} [input.review] - the latest recorded review document
 * @returns {Record<string, unknown>}
 */
export function buildQaView({ projectId, revision, validation = null, review = null }) {
  const technical = validation?.technical ?? null
  const semantic = validation?.semantic ?? null
  const errors = technical?.errors ?? []
  const notices = semantic?.notices ?? []
  const measured = review?.issues ?? []
  const reported = review?.reported ?? []
  const rejected = review?.rejected ?? []
  const reviewer = review?.reviewer ?? null

  return {
    projectId,
    revision,
    technical: {
      available: technical !== null,
      ok: technical?.ok !== false,
      errorCount: errors.length,
      errors: errors.map(entry => ({
        code: entry.code ?? null,
        message: entry.message ?? null,
        detail: clone(entry.detail ?? null),
      })),
      counts: clone(technical?.counts ?? null),
      frameRange: clone(technical?.frameRange ?? null),
      engine: technical?.engine ?? null,
      activeCamera: technical?.activeCamera ?? null,
    },
    semantic: {
      ok: semantic?.ok !== false,
      noticeCount: notices.length,
      notices: notices.map(entry => ({ code: entry.code ?? null, message: entry.message ?? null })),
    },
    visual: {
      available: review !== null,
      score: review?.score ?? null,
      pass: review?.pass ?? null,
      iteration: review?.iteration ?? null,
      subjectId: review?.subjectId ?? null,
      viewCount: review?.viewCount ?? null,
      sheet: clone(review?.sheet ?? null),
      measuredIssueCount: measured.length,
      measuredIssues: measured.map(issue => ({
        code: issue.code ?? null,
        severity: issue.severity ?? null,
        category: issue.category ?? null,
        viewId: issue.viewId ?? null,
        objectIds: issue.objectIds ?? (issue.objectId ? [issue.objectId] : []),
        evidence: issue.evidence ?? null,
      })),
      reviewerAvailable: reviewer !== null,
      reviewerError: reviewer?.error ? String(reviewer.error.message ?? reviewer.error) : null,
      reviewerModel: reviewer?.model ?? null,
      findingCount: reported.length,
      findings: reported.map(finding => ({
        viewId: finding.viewId ?? null,
        category: finding.category ?? null,
        severity: finding.severity ?? null,
        evidence: finding.evidence ?? null,
        confidence: finding.confidence ?? null,
      })),
      rejectedFindingCount: rejected.length,
    },
    issueCount: errors.length + measured.length + reported.length,
    summary: validation === null && review === null
      ? '这个 revision 还没有 QA 记录：技术校验随 revision 一起写入，视觉评审需要显式运行。'
      : `技术错误 ${errors.length} 条；测量问题 ${measured.length} 条；审查器 finding ${reported.length} 条。`,
  }
}

/**
 * The approval display (SPEC §14.2 "Approval", §15.1).
 *
 * M3 already records the cost threshold on a delivery job; M4 shows it. Nothing
 * here gates anything — the plane that can block a start belongs to the harness
 * approval prompt, which is M5 — and saying so in the payload is the point: a UI
 * that implied it had blocked a render would be lying.
 *
 * @param {object} input
 * @param {object} input.record - the stored render-job record
 * @param {number} input.threshold - `requireApprovalAboveFrames`
 * @returns {Record<string, unknown>}
 */
export function buildApprovalView({ record, threshold }) {
  const frames = record?.expectedFrames ?? 0
  const required = typeof threshold === 'number' && frames > threshold
  const recorded = (record?.warnings ?? []).find(entry => entry?.detail?.threshold === threshold) ?? null
  return {
    required,
    threshold,
    frames,
    // The warning M3 wrote is the record that the requirement was noticed; the
    // UI reports the same fact rather than recomputing an opinion about it.
    recorded: recorded !== null,
    recordedMessage: recorded?.message ?? null,
    // M5 changed what this word means. Through M4 the threshold was a NOTE attached
    // to a job that had already started, and the view said `display-only` so that a
    // panel could not imply it had gated anything. The gate now exists and lives in
    // the host: an over-threshold render that arrives without a grant is refused with
    // `RENDER_APPROVAL_REQUIRED` before a job is allocated, and the model obtains the
    // grant through the harness's own approval plane.
    plane: 'enforced',
    note: '阈值以上，Host 会拒绝没有授权的渲染（RENDER_APPROVAL_REQUIRED，且不分配任何 job）；' +
      '模型侧经 harness 审批平面取得授权后才会重提。',
  }
}

/**
 * One job, as the Jobs view renders it.
 *
 * @param {object} job - canonical job from `blenderStudio`
 * @param {{ threshold: number }} options
 * @returns {Record<string, unknown>}
 */
export function buildJobView(job, options) {
  const expected = job.expectedFrames ?? 0
  const completed = job.completedFrames ?? 0
  const live = !RENDER_JOB_TERMINAL_STATUSES.includes(job.status)
  return {
    ...clone(job),
    progress: {
      completed,
      expected,
      percent: expected === 0 ? 0 : Math.round((completed / expected) * 1000) / 10,
      missing: (job.missingFrames ?? []).length,
      corrupt: (job.corruptFrames ?? []).length,
      live,
    },
    // Both answers come from the state machine in `render-job.js` rather than
    // from a list written here: a second opinion about which statuses are
    // terminal is exactly the copy that rots (D38, D43, D57, D60).
    cancelable: live,
    resumable: ['failed', 'cancelled', 'recovering'].includes(job.status),
    deliverable: job.status === 'completed' && job.delivery !== null,
    approval: buildApprovalView({ record: { expectedFrames: expected, warnings: job.warnings ?? [] }, threshold: options?.threshold ?? Number.POSITIVE_INFINITY }),
    detail: describeJobForHuman(job),
  }
}

/**
 * One line a human can read without knowing the state machine.
 *
 * @param {object} job
 * @returns {string}
 */
export function describeJobForHuman(job) {
  const frames = `${job.completedFrames ?? 0}/${job.expectedFrames ?? 0} 帧`
  switch (job.status) {
    case 'queued': return `排队中：${frames}`
    case 'running': return job.estimatedRemainingMs === null || job.estimatedRemainingMs === undefined
      ? `渲染中：${frames}`
      : `渲染中：${frames}，预计还剩 ${formatDuration(job.estimatedRemainingMs)}`
    case 'stopping': return `正在停止：${frames}`
    case 'recovering': return `进程已消失，可从缺失帧继续：${frames}`
    case 'completed': return job.delivery === null ? `已完成：${frames}` : `已交付：${frames}，视频已校验`
    case 'failed': return `失败（${job.errorCode ?? '未分类'}）：${frames}，可继续渲染`
    case 'cancelled': return `已取消：${frames}，可继续渲染`
    default: return `${job.status}：${frames}`
  }
}

/** Human duration from milliseconds. @param {number} ms */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/**
 * The settings card (SPEC §14.2 "Blender 能力设置卡").
 *
 * Built from canonical capabilities and nothing else, so the card can never
 * disagree with what `blender_capabilities` reports to the model.
 *
 * @param {Record<string, any>} data - canonical capabilities
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
      { label: '导入格式', value: (data?.formats?.import ?? []).join(', ') || '无' },
      { label: '导出格式', value: (data?.formats?.export ?? []).join(', ') || '无' },
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

/**
 * The project list entry.
 *
 * @param {object} record - the stored project record
 * @param {{ sceneSummary?: object|null, jobs?: object[] }} [extra]
 * @returns {Record<string, unknown>}
 */
export function buildProjectView(record, extra = {}) {
  const jobs = extra.jobs ?? []
  return {
    projectId: record.projectId ?? record.id ?? null,
    title: record.title ?? null,
    currentRevision: record.currentRevision ?? null,
    revisionCount: record.revisionCount ?? 0,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    goal: record.goal ?? null,
    scene: clone(extra.sceneSummary ?? null),
    jobs: jobs.map(job => ({ jobId: job.jobId, status: job.status, type: job.type, revisionId: job.revisionId })),
    // Counted here, from the state machine, so a status chip in the UI is a
    // number the Host computed rather than a second list of "live" statuses in
    // the browser.
    unfinishedJobs: jobs.filter(job => !RENDER_JOB_TERMINAL_STATUSES.includes(job.status)).length,
  }
}

/**
 * The tool-card contract (SPEC §14.2 "Tool Result Cards").
 *
 * A card never parses prose out of a tool result: it reads the tool's own JSON
 * arguments (which the harness records verbatim) for the ids, and then asks the
 * Host for the authoritative state. `deepblend/tests/contract/ui-api.test.mjs`
 * covers the extraction, because a card that silently rendered nothing is exactly
 * the failure mode that looks like "the tool returned nothing interesting".
 *
 * @param {string} argsRaw - the JSON string the model sent for the call
 * @returns {{ projectId: string|null, jobId: string|null, revision: string|null, operationCount: number|null }}
 */
export function parseToolCallTarget(argsRaw) {
  let args = null
  try {
    args = typeof argsRaw === 'string' && argsRaw.length > 0 ? JSON.parse(argsRaw) : null
  } catch {
    args = null
  }
  if (args === null || typeof args !== 'object') return { projectId: null, jobId: null, revision: null, operationCount: null }
  return {
    projectId: typeof args.projectId === 'string' ? args.projectId : null,
    jobId: typeof args.jobId === 'string' ? args.jobId : (typeof args.resumeJobId === 'string' ? args.resumeJobId : null),
    revision: typeof args.baseRevision === 'string' ? args.baseRevision : (typeof args.revision === 'string' ? args.revision : null),
    operationCount: Array.isArray(args.operations) ? args.operations.length : null,
  }
}

/**
 * The wire tool names this package renders a card for.
 *
 * One list, read by the client plugin (registration keys) and by the tests. It is
 * every DeepBlend tool that exists: a card for a tool that does not exist would
 * never render, and a tool without a card falls back to the generic row (which is
 * what the shipped console does for unknown tools).
 */
export const UI_TOOL_CARD_KEYS = Object.freeze([
  'blender_capabilities',
  'blender_project_create',
  'blender_project_get',
  'blender_scene_get',
  'blender_scene_patch',
  'blender_preview_render',
  'blender_scene_validate',
  'blender_revision_restore',
  'blender_preview_views',
  'blender_visual_review',
  'blender_visual_autofix',
  'blender_final_render',
  'blender_export',
  'blender_job_status',
  'blender_job_cancel',
])
