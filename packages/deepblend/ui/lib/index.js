/**
 * @deepblend/dsh-blender-ui
 *
 * The DeepBlend **Host half** of the workbench UI (SPEC §5.1, §14).
 *
 * It owns exactly one thing: the typed HTTP surface the browser half reads and
 * writes through. Every handler answers by calling the authoritative
 * `blenderStudio` Host service; nothing here reads a project file, starts a
 * process, or keeps a cache. That is what makes SPEC §14.3 and the M4 acceptance
 * conditions true by construction rather than by review:
 *
 *   不进入文件系统即可管理项目        the browser only ever calls these routes
 *   UI 刷新后可从 Host 恢复权威状态    every response is computed per request
 *   浏览器不直接启动 Blender          no route exposes an execution entry
 *   所有写操作经过 Host              the four write routes call blenderStudio
 *
 * The route table is `UI_ROUTES` in `@deepblend/dsh-blender-contracts`: a path is
 * spelled once, and the handler table below is asserted to be exactly that set —
 * a closed set, because a handler with no route in the table would be an
 * unlisted capability.
 *
 * Owner: DeepBlend Studio — M0 (settings card) / M4 (the workbench API)
 * Plane: Host composition (the Web Client half is `./client.js`)
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  BlenderError,
  BlenderErrorCode,
  HOST_API_VERSION,
  UI_PANEL_ID,
  UI_ROUTES,
  UI_ROUTE_PREFIX,
  buildJobView,
  buildProjectView,
  buildQaView,
  buildRevisionDiff,
  buildSceneTree,
  buildSettingsCard,
  matchUiRoute,
} from '@deepblend/dsh-blender-contracts'

/** Route path serving the settings card document (M0's surface, kept verbatim). */
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
  /** Register the HTTP routes on the composed web server. */
  serveRoute: z.boolean().default(true),
})

/** Body ceiling for a POSTed document (a ScenePatch is small; a whole spec is not huge). */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export default class BlenderUiHost extends Service {
  /**
   * `blenderStudio` is a hard dependency: the API has no authority without it.
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

    // One handler per route id, and no other way in. A test asserts the key set
    // equals UI_ROUTES exactly, in both directions.
    this._handlers = createHandlers(this.ctx)

    if (!config.serveRoute) return

    ctx.inject(['webServer'], (serverCtx) => {
      // Route registration belongs to this fiber, so unmounting the row removes
      // the route (SPEC §4.4 / lifecycle: every side effect is reversible).
      const dispose = serverCtx.webServer.register({
        kind: 'prefix',
        path: UI_ROUTE_PREFIX,
        handler: (request, response) => this._handle(request, response),
      })
      this._routeDisposer = dispose
      return () => {
        this._routeDisposer = null
        dispose()
      }
    })
  }

  /** The handler table, exposed for the closed-set assertion. */
  get handlers() {
    return this._handlers
  }

  /**
   * Serve one UI request.
   *
   * Always answers with a structured JSON body: a failure the UI can render
   * (`{ ok: false, error: { code, message } }`) is worth more than a transport
   * error, and the browser half has no other source of truth to fall back on.
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @returns {Promise<void>}
   */
  async _handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const matched = matchUiRoute(request.method ?? 'GET', url.pathname)

    if (matched === null) {
      this._sendJson(response, 404, {
        ok: false,
        error: {
          code: BlenderErrorCode.UI_ROUTE_NOT_FOUND,
          message: `${request.method} ${url.pathname} is not a DeepBlend route.`,
          detail: { routes: UI_ROUTES.map(route => `${route.method} ${route.path}`) },
        },
      })
      return
    }

    try {
      if (matched.route.id === 'artifacts.open') {
        await this._sendArtifact(request, response, matched.params)
        return
      }
      const body = await readRequestBody(request)
      const result = await this._handlers[matched.route.id]({
        params: matched.params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      })
      this._sendJson(response, 200, { ok: true, route: matched.route.id, hostApiVersion: HOST_API_VERSION, ...result })
    } catch (cause) {
      const error = cause instanceof BlenderError
        ? cause
        : new BlenderError(
          BlenderErrorCode.UI_REQUEST_FAILED,
          cause instanceof Error ? cause.message : String(cause),
        )
      this._sendJson(response, statusForError(error), {
        ok: false,
        route: matched.route.id,
        hostApiVersion: HOST_API_VERSION,
        error: error.toJSON(),
      })
    }
  }

  /**
   * Serve one artifact as bytes.
   *
   * The only route whose response is not JSON, and the only one where a URL
   * parameter reaches the filesystem — so the project id and the path are both
   * handed to `blenderStudio.readArtifact`, which resolves them inside the
   * project directory and refuses anything else (SPEC §15.2).
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {Record<string, string>} params
   */
  async _sendArtifact(request, response, params) {
    const artifact = await this.ctx.blenderStudio.readArtifact({ projectId: params.projectId, path: params.rest })
    response.setHeader('content-type', artifact.contentType)
    // A re-rendered view must never be shown from a cache: the sheet for a
    // revision that was re-reviewed is a different file with the same path.
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-length', String(artifact.size))
    response.end(request.method === 'HEAD' ? undefined : artifact.bytes)
  }

  /**
   * @param {import('node:http').ServerResponse} response
   * @param {number} status
   * @param {Record<string, unknown>} payload
   */
  _sendJson(response, status, payload) {
    const body = JSON.stringify(payload)
    response.setHeader('content-type', 'application/json; charset=utf-8')
    // Nothing here may be cached: every value is a live read of Host state, and a
    // cached copy would let the UI disagree with the tool after a write
    // (SPEC §14.3 「刷新后可从 Host 恢复权威状态」).
    response.setHeader('cache-control', 'no-store')
    response.statusCode = status
    response.end(body)
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
 * Where a coded failure lands on the wire.
 *
 * A missing project or revision is a 404 — the UI has to tell "not there" from
 * "the Host refused", and both are normal answers rather than crashes.
 *
 * @param {BlenderError} error
 * @returns {number}
 */
export function statusForError(error) {
  switch (error.code) {
    case BlenderErrorCode.PROJECT_NOT_FOUND:
    case BlenderErrorCode.REVISION_NOT_FOUND:
    case BlenderErrorCode.RENDER_JOB_NOT_FOUND:
    case BlenderErrorCode.ARTIFACT_NOT_FOUND:
    case BlenderErrorCode.UI_ROUTE_NOT_FOUND:
      return 404
    case BlenderErrorCode.PATH_OUTSIDE_WORKSPACE:
    case BlenderErrorCode.SCENE_PATCH_INVALID:
      return 400
    case BlenderErrorCode.RENDER_JOB_CONFLICT:
      return 409
    default:
      return 500
  }
}

/**
 * Read a request body as JSON.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {}
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new BlenderError(
        BlenderErrorCode.SCENE_PATCH_INVALID,
        `The request body exceeded ${MAX_BODY_BYTES} bytes.`,
      )
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new BlenderError(
      BlenderErrorCode.SCENE_PATCH_INVALID,
      `The request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, 'The request body is not a JSON object.')
  }
  return parsed
}

/**
 * The handler table: one function per route id.
 *
 * Every entry calls `blenderStudio` and projects its answer with a pure builder
 * from the contracts package. There is no filesystem call, no process spawn and
 * no `eval` anywhere in this file — which is what the M4 acceptance condition
 * 「浏览器不直接启动 Blender」 means when it is written as a test rather than as
 * a sentence.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Record<string, (input: { params: Record<string, string>, query: Record<string, string>, body: Record<string, unknown> }) => Promise<Record<string, unknown>> | Record<string, unknown>>}
 */
export function createHandlers(ctx) {
  const studio = () => ctx.blenderStudio
  const approvalThreshold = () => studio().config?.requireApprovalAboveFrames ?? Number.POSITIVE_INFINITY

  return {
    /** SPEC §14.4 `blenderSettings.getCapabilities`; M0's route, unchanged in shape. */
    capabilities: async ({ query }) => {
      const refresh = query.refresh === '1'
      try {
        const data = await studio().describeCapabilities({ refresh })
        return { card: buildSettingsCard(data), data }
      } catch (cause) {
        // A probe failure is still structured, so the card renders the reason
        // instead of the browser showing a transport error. M0 behaviour, kept:
        // a Blender-less machine is a normal state, not an error page.
        const error = cause instanceof BlenderError
          ? cause
          : new BlenderError(
            BlenderErrorCode.CAPABILITY_PROBE_FAILED,
            cause instanceof Error ? cause.message : String(cause),
          )
        return { card: null, data: null, error: error.toJSON() }
      }
    },

    /** Everything the panel needs to render itself from scratch, in one request. */
    state: async ({ query }) => {
      const listed = await studio().listProjects()
      const projectId = query.projectId ?? listed.projects[0]?.projectId ?? null
      return {
        panelId: UI_PANEL_ID,
        projects: listed.projects.map(record => buildProjectView(record)),
        projectsRoot: listed.projectsRoot,
        selected: projectId === null
          ? null
          : await buildProjectState(studio(), projectId, query.revision ?? undefined, approvalThreshold()),
      }
    },

    'projects.list': async () => {
      const listed = await studio().listProjects()
      return { projects: listed.projects.map(record => buildProjectView(record)), projectsRoot: listed.projectsRoot }
    },

    'projects.create': async ({ body }) => {
      const created = await studio().createProject({
        title: body.title,
        goal: body.goal,
        sceneSpec: body.sceneSpec,
        projectId: body.projectId,
        saveCheckpoint: true,
        renderPreview: body.renderPreview === true,
      })
      return { project: created }
    },

    'project.overview': async ({ params, query }) => buildProjectState(studio(), params.projectId, query.revision, approvalThreshold()),

    'project.scene': async ({ params, query }) => {
      const detail = await studio().getScene(params.projectId, { revision: query.revision, full: true })
      return {
        revision: detail.revision,
        digest: detail.digest,
        scene: buildSceneTree(detail.spec, {
          revision: detail.revision,
          digest: detail.digest,
          compiled: detail.compiledSpec ?? null,
        }),
      }
    },

    'project.revisions': async ({ params }) => {
      const project = await studio().getProject(params.projectId)
      return { projectId: params.projectId, currentRevision: project.currentRevision ?? null, revisions: project.revisions }
    },

    'project.revision': async ({ params }) => {
      const detail = await studio().getRevisionDetail({ projectId: params.projectId, revision: params.revision })
      return { detail }
    },

    'project.diff': async ({ params, query }) => {
      const pair = await studio().readRevisionPair({ projectId: params.projectId, from: query.from, to: query.to })
      return {
        fromRevision: pair.fromRevision,
        toRevision: pair.toRevision,
        diff: buildRevisionDiff(pair.from, pair.to, { fromRevision: pair.fromRevision, toRevision: pair.toRevision }),
      }
    },

    'project.qa': async ({ params, query }) => {
      const record = await studio().getQaRecord({ projectId: params.projectId, revision: query.revision })
      return {
        qa: buildQaView({
          projectId: record.projectId,
          revision: record.revision,
          validation: record.validation,
          review: record.review,
        }),
        reviewCount: record.reviewCount,
        reviewArtifact: record.reviewArtifact,
      }
    },

    'project.previews': async ({ params }) => {
      const sets = await studio().listPreviewSets({ projectId: params.projectId })
      return { previews: sets, artifactBase: `${UI_ROUTE_PREFIX}/artifacts/${encodeURIComponent(params.projectId)}/` }
    },

    'project.preview': async ({ params, body }) => {
      // `renderViews` answers with the rendered PNG bytes in `pngs`, which is not
      // lossless JSON and is not what the browser needs: the panel displays the
      // images through the artifact route, so the response carries the paths,
      // the measurements and the warnings — never the buffers.
      const result = await studio().renderViews({
        projectId: params.projectId,
        revision: body.revision,
        samples: numberOrUndefined(body.samples),
        maxViews: numberOrUndefined(body.maxViews),
        reason: body.reason ?? 'preview rendered from the workbench UI',
      })
      return {
        preview: {
          projectId: params.projectId,
          revision: result.revision ?? body.revision ?? null,
          digest: result.digest ?? null,
          profile: result.profile ?? null,
          artifacts: result.artifacts ?? [],
          views: (result.views ?? []).map(view => ({
            viewId: view.viewId,
            role: view.role ?? null,
            cameraId: view.cameraId ?? null,
            frame: view.frame ?? null,
            path: view.path ?? null,
            caption: view.caption ?? null,
          })),
          warnings: result.warnings ?? [],
          durationMs: result.durationMs ?? null,
        },
      }
    },

    'project.patch': async ({ params, body }) => {
      // The patch is passed through verbatim: the Host validates it against the
      // ScenePatch schema and the base revision, and it is the only writer.
      const patch = { ...(body.patch ?? body), projectId: params.projectId }
      const result = await studio().applyScenePatch(patch)
      return { revision: result }
    },

    'project.restore': async ({ params, body }) => {
      const result = await studio().restoreRevision({
        projectId: params.projectId,
        revision: body.revision,
        reason: body.reason ?? 'restored from the workbench UI',
        actor: body.actor ?? 'ui',
      })
      return { revision: result }
    },

    'project.jobs': async ({ params }) => {
      const jobs = await studio().listJobs({ projectId: params.projectId })
      return {
        projectId: params.projectId,
        jobs: jobs.jobs.map(job => buildJobView(job, { threshold: approvalThreshold() })),
        unfinished: jobs.unfinished,
        recovery: jobs.recovery,
      }
    },

    'project.job': async ({ params }) => {
      const job = await studio().getJob({ projectId: params.projectId, jobId: params.jobId })
      return { job: buildJobView(job.renderJob ?? job, { threshold: approvalThreshold() }) }
    },

    'project.job.cancel': async ({ params, body }) => {
      const result = await studio().cancelJob({
        projectId: params.projectId,
        jobId: params.jobId,
        reason: body.reason ?? 'cancelled from the workbench UI',
      })
      return { cancelled: result }
    },

    'project.render': async ({ params, body }) => {
      const resumeJobId = typeof body.resumeJobId === 'string' && body.resumeJobId.length > 0 ? body.resumeJobId : null
      const request = {
        projectId: params.projectId,
        revision: body.revision,
        frameStart: numberOrUndefined(body.frameStart),
        frameEnd: numberOrUndefined(body.frameEnd),
        samples: numberOrUndefined(body.samples),
        profile: body.profile,
        reason: body.reason ?? 'started from the workbench UI',
      }
      // A resume is a different host entry point, and the UI must not have to
      // know which one to call: `resumeJobId` is the caller's whole intent.
      //
      // The parameter names differ on purpose on the two sides of the boundary —
      // the tool/UI vocabulary says `resumeJobId` because that is what it MEANS,
      // while `resumeRenderJob` takes `jobId` because that is what it USES. The
      // mapping is therefore here, in one place, and asserted by the plane suite:
      // passing `resumeJobId` straight through reads as a missing job id at the
      // host, which a user would see as "RENDER_JOB_NOT_FOUND" on a job that is
      // sitting right there in the panel.
      const result = resumeJobId === null
        ? await studio().startFinalRender(request)
        : await studio().resumeRenderJob({ ...request, jobId: resumeJobId })
      return { job: result, resumed: resumeJobId !== null }
    },
  }
}

/**
 * One project's whole panel state: summary, scene, revisions, jobs and QA.
 *
 * Assembled from separate Host reads rather than from a Host-side aggregate, so
 * each answer is the same one the corresponding tool would get.
 *
 * @param {any} studio
 * @param {string} projectId
 * @param {string|undefined} revision
 * @param {number} threshold
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildProjectState(studio, projectId, revision, threshold) {
  const overview = await studio.getProject(projectId, revision === undefined ? {} : { revision })
  const listed = await studio.listProjects()
  const record = listed.projects.find(entry => entry.projectId === projectId) ?? null
  const requested = revision ?? overview.currentRevision
  // `full: true` is load-bearing. `getScene` returns a DIGEST by default (the
  // model-facing rule: do not spend context on a document nobody asked for), and
  // buildSceneTree fed with a digest renders an empty tree — a silent wrong
  // answer, "this project has 0 entities", for a project with 17 of them. The
  // workbench asks for the document because the Scene Tree IS the document.
  const scene = await studio.getScene(projectId, { revision: requested, full: true })
  const jobs = await studio.listJobs({ projectId })
  const qa = await studio.getQaRecord({ projectId, revision: scene.revision })
  return {
    project: buildProjectView({
      projectId,
      title: overview.title,
      goal: record?.goal ?? null,
      currentRevision: overview.currentRevision,
      revisionCount: overview.revisionCount,
      createdAt: record?.createdAt ?? null,
      updatedAt: record?.updatedAt ?? null,
    }, { sceneSummary: overview.scene ?? null, jobs: jobs.jobs }),
    // The revision everything below was read at: the scene's own answer, so the
    // panel can never label one revision's tree with another revision's id.
    currentRevision: scene.revision,
    scene: buildSceneTree(scene.spec, {
      revision: scene.revision,
      digest: scene.digest,
      compiled: scene.compiledSpec ?? null,
    }),
    revisions: overview.revisions ?? [],
    jobs: jobs.jobs.map(job => buildJobView(job, { threshold })),
    unfinishedJobs: jobs.unfinished,
    qa: buildQaView({
      projectId,
      revision: qa.revision,
      validation: qa.validation,
      review: qa.review,
    }),
  }
}

/** A query/body value that is a finite number, or undefined. @param {unknown} value */
function numberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Build the settings-card view model from canonical capabilities.
 *
 * Re-exported from the contracts package because the card is a view model, and
 * this repository has paid five times for one vocabulary written twice (D38,
 * D43, D57, D60) — the sixth copy is the one nobody runs.
 *
 * @param {Record<string, any>} data
 * @returns {Record<string, unknown>}
 */
export { buildSettingsCard }
