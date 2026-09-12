/**
 * Visual review composition: turning a render plan into the exact things a
 * reviewer — model or human — is shown (SPEC §12.3).
 *
 * WHAT A REVIEW CONTAINS, AND WHY EACH PART IS THERE
 * --------------------------------------------------
 *  1. A contact sheet: one labelled image of every view. Answers the RELATIONAL
 *     questions ("is the subject off-centre", "is something in front of it") in one
 *     look, which is the only way to answer them cheaply.
 *  2. The measurements: coverage, centring, silhouette visibility per object, and
 *     a luminance histogram per view. Answers the NUMERIC questions, and is the
 *     only part that is reproducible (decision D30).
 *  3. The measured findings: what those numbers already prove is wrong.
 *
 * The sheet alone cannot decide anything (a partial occlusion can read as a small
 * subject), and the numbers alone cannot either (a number cannot tell a deliberate
 * silhouette from a mistake). That is why both travel together and why the score
 * is computed from the second while the model is asked about the first.
 *
 * Owner: DeepBlend Studio — M2
 */

import { composeContactSheet, viewCaption } from './contact-sheet.js'
import { scoreReview, VISUAL_REVIEW_VERSION } from './visual-issue.js'

/** Roles a generated view plan can contain, in reading order. */
export const VIEW_ROLES = Object.freeze(['active-camera', 'three-quarter', 'top', 'detail'])

/** Cap on how many extra objects are tracked for occlusion, beyond the subject. */
const MAX_TRACKED_OCCLUDERS = 3

/**
 * @typedef {object} PlannedView
 * @property {string} id - the view id used everywhere downstream.
 * @property {string} role - one of {@link VIEW_ROLES}.
 * @property {string} cameraId - the SceneSpec camera this view renders from.
 * @property {string|null} frame
 * @property {string} label - what the contact sheet draws on the cell.
 * @property {string} purpose - why this view is in the plan, for the model.
 */

/**
 * Build the standard multi-view plan for a scene (SPEC §12.3: main camera, 45
 * degrees, top, subject close-up).
 *
 * The plan is expressed in SceneSpec camera IDS, never as ad-hoc camera transforms:
 * a view the project does not declare cannot be reported, compared across rounds,
 * or turned into a camera patch. A rotation that is not in the spec is also not
 * reproducible after a restore.
 *
 * @param {object} input
 * @param {object} input.spec - a compiled SceneSpec.
 * @param {string|null} [input.subjectId]
 * @param {number} [input.frame] - the frame for animated views; defaults to the
 *   middle of the range, because a turntable's first frame is its least
 *   informative angle.
 * @param {string[]} [input.roles] - subset of {@link VIEW_ROLES}; order is honoured.
 * @param {number} [input.maxViews]
 * @returns {PlannedView[]}
 */
export function buildViewPlan(input) {
  const spec = input?.spec
  if (spec === null || typeof spec !== 'object') throw new Error('buildViewPlan needs a SceneSpec')
  const cameras = Array.isArray(spec.cameras) ? spec.cameras : []
  if (cameras.length === 0) throw new Error('the scene declares no camera to render from')

  const frames = frameRange(spec)
  const frame = normalizeFrame(input.frame, frames)
  const subjectId = input.subjectId ?? null

  // Camera selection is by ROLE where the scene names one, and by ORDER otherwise.
  // Order is the honest fallback: the compiler preserves declaration order, so
  // "the second camera" at least means the same thing across rounds of one project.
  const byRole = (role, position) => cameras.find(camera => camera.role === role) ?? cameras[position] ?? null
  const active = cameras.find(camera => camera.id === spec.activeCamera) ?? cameras[0]
  const threeQuarter = byRole('three-quarter', 1)
  const top = byRole('top', 2)
  const detail = byRole('detail', 1)

  const candidates = [
    {
      role: 'active-camera',
      camera: active,
      frame,
      purpose: 'what the animation is actually seen through',
    },
    {
      role: 'three-quarter',
      camera: threeQuarter === active ? cameras[1] ?? null : threeQuarter,
      frame,
      purpose: 'a 45-degree reading of the subject where depth, silhouette and contact shadows are visible',
    },
    {
      role: 'top',
      camera: top,
      frame,
      purpose: 'top-down placement: what is beside, behind or on top of the subject',
    },
    {
      role: 'detail',
      camera: detail,
      frame,
      purpose: subjectId === null
        ? 'a closer angle on the subject'
        : `a closer angle on "${subjectId}" for surface, edge and material detail`,
    },
  ]

  const requestedRoles = Array.isArray(input.roles) && input.roles.length > 0 ? input.roles : VIEW_ROLES
  const views = []
  const usedCameras = new Set()
  for (const candidate of candidates) {
    if (!requestedRoles.includes(candidate.role)) continue
    if (candidate.camera === null || candidate.camera === undefined) continue
    // One camera can legitimately serve two roles, but only when the roles ask for
    // different things — a plan of four copies of the same view would spend four
    // renders and four tiles to say one thing. The active camera therefore claims
    // its id first and later roles yield.
    if (usedCameras.has(candidate.camera.id) && views.length > 0) continue
    usedCameras.add(candidate.camera.id)
    views.push({
      id: candidate.role,
      role: candidate.role,
      cameraId: candidate.camera.id,
      frame: candidate.frame,
      label: viewCaption({ role: candidate.role, cameraId: candidate.camera.id, frame: candidate.frame }),
      purpose: candidate.purpose,
    })
  }

  const limit = Number.isInteger(input.maxViews) && input.maxViews > 0 ? input.maxViews : views.length
  return views.slice(0, limit)
}

/**
 * Which objects the renderer should measure by isolation.
 *
 * The subject is always tracked. The others matter because occlusion is only
 * visible as a comparison: without a hiding object's own numbers, "the subject is
 * 40% hidden" says nothing about what to move. They are ranked by bounding-box
 * volume, which is a proxy for "big enough to hide something" and costs nothing to
 * compute — the alternative, tracking everything, would multiply the render count
 * of every view.
 *
 * @param {object} spec
 * @param {string|null} subjectId
 * @returns {string[]}
 */
export function trackedObjects(spec, subjectId) {
  const entities = Array.isArray(spec?.entities) ? spec.entities : []
  // `environment` geometry is excluded, and that is a measurement decision rather than
  // a tidiness one: the floor of a room occupies the subject's screen pixels from
  // behind, and a wall does the same from the side. Tracking them would report a
  // chair as occluded by the floor it stands on. Which objects may hide the subject
  // is authored intent, so the spec's own tag decides it.
  const visible = entities.filter(entity =>
    entity.visible !== false && !(entity.tags ?? []).includes('environment'))
  const ranked = [...visible].sort((left, right) => entityVolume(right) - entityVolume(left))
  const tracked = []
  if (subjectId !== null && subjectId !== undefined) tracked.push(subjectId)
  for (const entity of ranked) {
    if (tracked.length >= MAX_TRACKED_OCCLUDERS + 1) break
    if (tracked.includes(entity.id)) continue
    tracked.push(entity.id)
  }
  return tracked
}

/**
 * The subject of a shot: the entity the animation is about.
 *
 * `tags` is the authored statement of intent and wins when present. The fallback
 * prefers whichever tracked object the measurements say fills the frame most,
 * because "the thing the camera is looking at" is a fact about the render rather
 * than about the file — and a spec that never tagged a hero still has one.
 *
 * @param {object} spec
 * @returns {string|null}
 */
export function resolveSubjectId(spec) {
  const entities = Array.isArray(spec?.entities) ? spec.entities : []
  const tagged = entities.find(entity => Array.isArray(entity.tags) && entity.tags.includes('hero-product'))
  if (tagged !== undefined) return tagged.id
  const geometric = entities.filter(entity => entity.visible !== false && entityVolume(entity) > 0)
  if (geometric.length === 0) return null
  return [...geometric].sort((left, right) => entityVolume(right) - entityVolume(left))[0].id
}

/**
 * Compose the contact sheet and the review document for one round.
 *
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.revision
 * @param {string} input.digest
 * @param {object[]} input.views - rendered view entries, each with `metrics`.
 * @param {Record<string, Buffer>} input.pngs - view id -> PNG bytes.
 * @param {string|null} [input.subjectId]
 * @param {number} [input.iteration]
 * @param {string} [input.sheetPath] - project-relative path recorded for the sheet.
 * @returns {{ sheet: { png: Buffer, width: number, height: number, placements: object[] }, review: object }}
 */
export function buildVisualReview(input) {
  const views = Array.isArray(input.views) ? input.views : []
  if (views.length === 0) throw new Error('a visual review needs at least one rendered view')

  const scored = scoreReview(views, { subjectId: input.subjectId ?? null })

  const sheetViews = []
  for (const view of views) {
    const png = input.pngs?.[view.viewId]
    if (!Buffer.isBuffer(png)) continue
    sheetViews.push({ viewId: view.viewId, label: view.caption ?? view.viewId, png })
  }
  if (sheetViews.length === 0) throw new Error('no rendered bytes were available to compose a contact sheet')

  const sheet = composeContactSheet({
    views: sheetViews,
    title: `${input.projectId} ${input.revision} SCORE ${scored.score}`,
  })

  const review = {
    schemaVersion: VISUAL_REVIEW_VERSION,
    projectId: input.projectId,
    revision: input.revision,
    digest: input.digest,
    iteration: input.iteration ?? 0,
    score: scored.score,
    pass: scored.score >= 90,
    perView: scored.perView,
    issues: scored.issues,
    viewCount: views.length,
    subjectId: input.subjectId ?? null,
    sheet: {
      path: input.sheetPath ?? null,
      width: sheet.width,
      height: sheet.height,
      columns: sheet.columns,
      rows: sheet.rows,
      placements: sheet.placements,
    },
    reported: [],
    rejected: [],
  }
  return { sheet, review }
}

/**
 * The measured facts, in the compact form the reviewer prompt carries.
 *
 * Prose, not JSON, because it is read by a model: a JSON blob of nested numbers
 * costs tokens and invites the model to quote fields rather than reason about them.
 *
 * @param {object} review
 * @returns {string}
 */
export function describeMeasurements(review) {
  const lines = [`Measured facts for ${review.projectId} ${review.revision} (score ${review.score}/100):`]
  for (const view of review.perView) {
    lines.push(`  view "${view.viewId}" scored ${view.score}`)
  }
  if (review.issues.length === 0) {
    lines.push('  no measured problem.')
    return lines.join('\n')
  }
  lines.push('  measured problems:')
  for (const issue of review.issues) {
    lines.push(`    [${issue.severity}] ${issue.code} (${issue.category}) ${issue.evidence}`)
  }
  return lines.join('\n')
}

/** The declared frame range of a compiled spec. */
function frameRange(spec) {
  const start = Number.isFinite(spec?.project?.frameStart) ? spec.project.frameStart : 1
  const end = Number.isFinite(spec?.project?.frameEnd) ? spec.project.frameEnd : start
  return { start, end }
}

/** Clamp a requested frame into the range, defaulting to the middle. */
function normalizeFrame(requested, range) {
  if (Number.isInteger(requested)) {
    return Math.min(range.end, Math.max(range.start, requested))
  }
  return Math.floor((range.start + range.end) / 2)
}

/**
 * A comparable size for an entity: its generator's declared extent, scaled.
 *
 * Deliberately approximate. It only has to rank candidates for extra measurement,
 * and a precise bounding box would have to come from Blender — which is a whole
 * launch to answer a question about which of two boxes is bigger.
 */
function entityVolume(entity) {
  const scale = entity?.transform?.scale ?? [1, 1, 1]
  const scaleFactor = Math.abs(scale[0] ?? 1) * Math.abs(scale[1] ?? 1) * Math.abs(scale[2] ?? 1)
  if (entity?.type === 'asset-instance') return scaleFactor
  const generator = entity?.generator ?? {}
  const size = generator.size
  if (Array.isArray(size) && size.length === 3) {
    return Math.abs(size[0]) * Math.abs(size[1]) * Math.abs(size[2]) * scaleFactor
  }
  if (Number.isFinite(size)) return size ** 3 * scaleFactor
  if (Number.isFinite(generator.radius)) return (4 / 3) * Math.PI * generator.radius ** 3 * scaleFactor
  if (Number.isFinite(generator.depth)) return Math.PI * (generator.radius ?? 1) ** 2 * generator.depth * scaleFactor
  return scaleFactor
}
