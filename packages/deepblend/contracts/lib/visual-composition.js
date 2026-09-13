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
import { SUBJECT_PART_TAG, scoreReview, VISUAL_REVIEW_VERSION } from './visual-issue.js'
import { entityBoundingRadius } from './scene-spec.js'

/** Roles a generated view plan can contain, in reading order. */
export const VIEW_ROLES = Object.freeze(['active-camera', 'three-quarter', 'top', 'detail'])

/**
 * How many frames an animated scene is sampled at.
 *
 * Four, not three, and the difference is not academic: a turntable is at its most
 * obviously broken at a QUARTER turn, so three samples across a full rotation land on
 * 0/180/360 degrees — every one of them an angle where a part-by-part rotation looks
 * correct. Four samples land on 0/120/240/360 and the quarter turn is visible.
 */
export const ANIMATED_SAMPLE_FRAMES = 4

/** Cap on how many extra objects are tracked for occlusion, beyond the subject. */
const MAX_TRACKED_OCCLUDERS = 3

/**
 * @typedef {object} PlannedView
 * @property {string} id - the view id used everywhere downstream. A role name when
 *   the scene determines one, otherwise the camera's own id.
 * @property {string|null} role - one of {@link VIEW_ROLES}, or null when the scene
 *   assigns this camera no role and the view is named after the camera instead.
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
 * @param {string[]} [input.roles] - roles the CALLER asked for. Strict: if none can be
 *   filled the plan is empty and the caller reports why.
 * @param {string[]} [input.preferredRoles] - the product's standard set, used when the
 *   caller named none. Advisory: a scene with no roles falls back to camera-id views.
 * @param {number} [input.maxViews]
 * @returns {{ views: PlannedView[], notices: string[] }} the plan, plus what could
 *   NOT be planned — an unfilled role or a missing one — because a review that
 *   silently covers two views instead of four reads as a clean four-view review.
 */
export function buildViewPlan(input) {
  const spec = input?.spec
  if (spec === null || typeof spec !== 'object') throw new Error('buildViewPlan needs a SceneSpec')
  const cameras = Array.isArray(spec.cameras) ? spec.cameras : []
  if (cameras.length === 0) throw new Error('the scene declares no camera to render from')

  const frames = frameRange(spec)
  const frame = normalizeFrame(input.frame, frames)
  const subjectId = input.subjectId ?? null
  // TWO KINDS OF "WHICH ROLES", and conflating them cost a real project its review.
  //
  //   `roles`          the CALLER asked for these. If none can be filled, that is an
  //                    error: answering "give me the top view" with four views named
  //                    after cameras is the same lie as guessing a role from the alphabet.
  //   `preferredRoles` the PRODUCT's standard set. It is a preference, so a scene that
  //                    declares no roles still gets reviewed — by camera-id views.
  //
  // Treating the configured preference as an explicit request made
  // `blender_visual_review` throw "needs at least one view" on any role-less project,
  // which is every project built before roles existed.
  const explicitRoles = Array.isArray(input.roles) && input.roles.length > 0 ? input.roles : null
  const preferredRoles = Array.isArray(input.preferredRoles) && input.preferredRoles.length > 0
    ? input.preferredRoles
    : VIEW_ROLES
  const requestedRoles = explicitRoles ?? preferredRoles

  // ---------------------------------------------------------------------------
  // Camera selection is by ROLE. There is no positional fallback, and that took a
  // real defect to learn.
  //
  // The first version fell back to array position ("the second camera is the
  // three-quarter view"). That was defensible only while declaration order survived
  // storage — and it does not: `upsertById` keeps every collection sorted by id, so
  // after the first patch the array is alphabetical. A four-camera project therefore
  // got its views assigned to whatever the alphabet produced, and the plan handed the
  // reviewer a view LABELLED "top" that was actually the three-quarter camera. The
  // reviewer itself flagged the mismatch at 0.62 confidence and correctly declined to
  // "fix" it — a mislabelled view is worse than an unlabelled one, because the label
  // is what the finding gets attached to.
  //
  // So a view exists only when the scene determines it: an explicit `role`, or
  // `project.activeCamera` for the active view, or a scene with exactly one camera.
  // Anything else falls back to one view per camera labelled by CAMERA ID — which is
  // true whatever the order — and says so.
  // ---------------------------------------------------------------------------

  const determined = []
  const claimed = new Set()

  // A camera already used by a stronger role cannot fill a second one — four tiles of
  // one camera would spend four renders to say one thing. But when SEVERAL cameras claim
  // the same role (an author who retagged one), the first is not necessarily free, and
  // stopping at it silently DROPS the role from the plan. So every candidate is tried.
  const claim = (role, purpose, candidates) => {
    if (!requestedRoles.includes(role)) return
    for (const camera of candidates) {
      if (camera === undefined || camera === null) continue
      if (claimed.has(camera.id)) continue
      claimed.add(camera.id)
      determined.push({ role, camera, purpose })
      return
    }
  }

  // The active view is the one statement a role-less scene can still make about
  // itself, so it is resolved first and from the strongest source available.
  const activeByName = cameras.find(camera => camera.id === spec.project?.activeCamera)
  const activeByRole = cameras.find(camera => camera.role === 'active-camera')
  const soloCamera = cameras.length === 1 ? cameras[0] : undefined
  const active = activeByName ?? activeByRole ?? soloCamera

  claim('active-camera', 'what the animation is actually seen through', [active])
  for (const role of requestedRoles) {
    if (role === 'active-camera') continue
    claim(role, rolePurpose(role, subjectId), cameras.filter(candidate => candidate.role === role))
  }

  /** @type {{ views: object[], notices: string[] }} */
  const notices = []

  // ---------------------------------------------------------------------------
  // HOW MANY FRAMES A REVIEW NEEDS. One frame is not enough, and the way it failed
  // is worth stating exactly.
  //
  // A real project (r0018) had a completely broken "turntable": all seven tracks
  // wrote `rotationEuler.z` only, so every part rotated about its OWN origin and at
  // a quarter turn the case went edge-on while the markers and the crown stayed put
  // and read as detached debris. A real vision review scored it 100 — because the
  // review rendered ONE frame, at the MIDDLE of the range, and the middle of 1..90 is
  // frame 45 = 180 degrees, the one angle where every part of a symmetric assembly
  // maps onto itself.
  //
  // So the sample frames are spread EVENLY, endpoints included, and deliberately not
  // taken from the keyframes: a linear track's keyframes are exactly where such a
  // defect is invisible.
  //
  // Sampling every view at every frame would be the thorough answer and is the wrong
  // one: the request image budget is 640 000 px (measured, runtime-audit §7.2) and the
  // harness DOWNSAMPLES to fit it, so sixteen tiles arrive blurrier than four. Motion
  // is most legible from the hero angle, so the active view is the one that carries
  // the extra frames and the other roles keep their single, comparable pose.
  // ---------------------------------------------------------------------------
  const animatedSpan = animationSpan(spec)
  const sampleFrames = input.frame !== undefined
    ? [normalizeFrame(input.frame, frames)]
    : animatedSpan === null
      ? [frame]
      : evenlySpaced(animatedSpan, ANIMATED_SAMPLE_FRAMES)
  const poseFrame = sampleFrames[Math.floor((sampleFrames.length - 1) / 2)]
  const heroIndex = determined.findIndex(entry => entry.role === 'active-camera')

  /** The frames one planned view is rendered at. */
  const framesFor = (entry, index) => {
    // No animation, or the caller named the frame: one frame, exactly as before.
    if (sampleFrames.length === 1) return [sampleFrames[0]]
    // With roles, the active view carries the motion. Without them, the first entry
    // does — the plan still has to sample something rather than go back to one frame.
    const carries = heroIndex >= 0 ? index === heroIndex : index === 0
    return carries ? sampleFrames : [poseFrame]
  }

  let views = determined.flatMap((entry, index) => framesFor(entry, index).map(sample => ({
    // A view that appears once keeps its bare role as the id, because that id is what
    // findings, sheets and `blender_preview_views` text have always keyed on.
    id: framesFor(entry, index).length > 1 ? `${entry.role}@${sample}` : entry.role,
    role: entry.role,
    cameraId: entry.camera.id,
    frame: sample,
    label: viewCaption({ role: entry.role, cameraId: entry.camera.id, frame: sample }),
    purpose: entry.purpose,
  })))

  if (sampleFrames.length > 1) {
    notices.push(
      `this scene animates, so the review samples ${sampleFrames.length} frames ` +
      `(${sampleFrames.join(', ')}) spread evenly across frames ${animatedSpan[0]}–${animatedSpan[1]}: ` +
      `the active view is rendered at each, the other views at frame ${poseFrame} so they stay comparable. ` +
      'A single frame cannot tell a working animation from one that only looks right at that frame.',
    )
  }

  if (soloCamera !== undefined && activeByName === undefined && activeByRole === undefined) {
    notices.push('the scene declares one camera and no roles, so it is used as the active view')
  }

  // The camera-id fallback exists for a scene that declares no roles — NOT for a
  // caller who asked for specific roles and named ones the scene cannot fill. Answering
  // "render me the top view" with four views called `camera-main` and friends would be
  // the same class of lie as the alphabetical role guess this replaced, so an explicit
  // request that cannot be honoured produces an EMPTY plan and the caller raises.
  const askedForRoles = explicitRoles !== null
  if (views.length === 0 && askedForRoles) {
    notices.push(
      `the requested role(s) ${requestedRoles.join(', ')} are not filled by any camera in this scene, and the ` +
      `scene declares ${cameras.length} camera(s): ${cameras.map(camera => camera.id).join(', ')}`,
    )
  } else if (views.length === 0) {
    // No role anywhere. Render the cameras the scene HAS, labelled with their own
    // ids: a camera id is a fact, and a role invented from alphabetical order is not.
    const fallback = [...cameras].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const cap = Number.isInteger(input.maxViews) && input.maxViews > 0 ? input.maxViews : VIEW_ROLES.length
    for (const camera of fallback.slice(0, cap)) {
      views.push({
        id: camera.id,
        role: null,
        cameraId: camera.id,
        frame,
        label: viewCaption({ role: null, cameraId: camera.id, frame }),
        purpose: 'a camera this scene declares; the scene assigns it no role, so the view is named after the camera',
      })
    }
    notices.push(
      `no camera in this scene declares a \`role\`, and no activeCamera is set, so the plan renders ` +
      `${views.length} of ${cameras.length} camera(s) named after the cameras themselves. Set \`role\` on each ` +
      `camera (active-camera / three-quarter / top / detail) to get the standard four-view plan.`,
    )
    if (fallback.length > cap) {
      notices.push(`the remaining ${fallback.length - cap} camera(s) were left out to keep the review affordable: ` +
        `${fallback.slice(cap).map(camera => camera.id).join(', ')}`)
    }
  } else if (views.length < requestedRoles.length) {
    const missing = requestedRoles.filter(role => !views.some(view => view.role === role))
    notices.push(
      `no camera fills ${missing.length === 1 ? 'the role' : 'the roles'} ${missing.join(', ')}, so ` +
      `${missing.length === 1 ? 'that view was' : 'those views were'} left out of this plan; ` +
      `the review covers ${views.length} view(s) instead of ${requestedRoles.length}`,
    )
  }
  // An explicit activeCamera or an explicit `role` gets no notice: the author already
  // said it, and a plan that reports decisions the caller made on purpose trains
  // everyone reading warnings to skip them.

  const limit = Number.isInteger(input.maxViews) && input.maxViews > 0 ? input.maxViews : views.length
  return { views: views.slice(0, limit), notices }
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
  // Every declared PART is tracked regardless of size. The volume ranking below is a
  // guess about what might hide the subject; a declaration is not a guess, and a small
  // component that is missing is exactly the defect that a size ranking would skip.
  const declared = subjectParts(spec)
  // `environment` geometry is excluded, and that is a measurement decision rather than
  // a tidiness one: the floor of a room occupies the subject's screen pixels from
  // behind, and a wall does the same from the side. Tracking them would report a
  // chair as occluded by the floor it stands on. Which objects may hide the subject
  // is authored intent, so the spec's own tag decides it.
  const visible = entities.filter(entity =>
    entity.visible !== false && !(entity.tags ?? []).includes('environment'))
  const ranked = [...visible].sort((left, right) => entityExtent(right) - entityExtent(left))
  const tracked = []
  if (subjectId !== null && subjectId !== undefined) tracked.push(subjectId)
  for (const entityId of declared) {
    if (!tracked.includes(entityId)) tracked.push(entityId)
  }
  for (const entity of ranked) {
    if (tracked.length >= declared.length + MAX_TRACKED_OCCLUDERS + 1) break
    if (tracked.includes(entity.id)) continue
    tracked.push(entity.id)
  }
  return tracked
}

/**
 * The entities the scene declared part of the subject's own body.
 *
 * @param {object} spec
 * @returns {string[]} ids, sorted so the set is stable across storage reordering.
 */
export function subjectParts(spec) {
  const entities = Array.isArray(spec?.entities) ? spec.entities : []
  return entities
    .filter(entity => (entity.tags ?? []).includes(SUBJECT_PART_TAG))
    .map(entity => entity.id)
    .sort()
}

/**
 * The subject of a shot: the entity the animation is about, and WHY it was chosen.
 *
 * THE CHOICE MUST NOT DEPEND ON ARRAY ORDER
 * -----------------------------------------
 * The first version took `entities.find(hero-product)`. Since `upsertById` keeps
 * collections sorted by id, "find" means "alphabetically first", and a scene that
 * tagged its case, dial, crown and four indices as `hero-product` resolved its
 * subject to **`index-nine`** — a 2.5 mm marker. Two consecutive reviews then scored
 * that marker's occlusion and proposed scaling it 5x and pointing every camera at it:
 * arithmetically correct, and completely meaningless. Nothing crashed, and the
 * findings were well-formed, which is exactly why it took a human reading the sheet
 * to notice.
 *
 * The rule now has a stated order of evidence, and every step of it is a fact about
 * the file rather than a fact about the alphabet:
 *
 *   1. what the ACTIVE camera aims at — a camera exists to frame something, and
 *      `targetEntityId` is the author saying what;
 *   2. a `hero-product` tag when exactly one entity carries it;
 *   3. among several, the largest by volume, ties broken by id;
 *   4. with no tag at all, the largest visible entity, ties broken by id.
 *
 * Step 3 is deliberately "largest" rather than "first": a scene that tags four things
 * hero is ambiguous, and the biggest of them is the only defensible reading.
 *
 * @param {object} spec
 * @returns {{ id: string|null, source: string, candidates: string[] }}
 */
export function resolveSubject(spec) {
  const entities = Array.isArray(spec?.entities) ? spec.entities : []
  const visible = entities.filter(entity => entity.visible !== false)

  // 1. What the shot is actually framed on.
  const cameras = Array.isArray(spec?.cameras) ? spec.cameras : []
  const active = cameras.find(camera => camera.id === spec?.project?.activeCamera)
    ?? cameras.find(camera => camera.role === 'active-camera')
  if (active?.targetEntityId !== undefined) {
    const aimed = visible.find(entity => entity.id === active.targetEntityId)
    if (aimed !== undefined) {
      return { id: aimed.id, source: `the active camera "${active.id}" aims at it`, candidates: [aimed.id] }
    }
  }

  const tagged = visible.filter(entity => Array.isArray(entity.tags) && entity.tags.includes('hero-product'))
  if (tagged.length === 1) {
    return { id: tagged[0].id, source: 'it is the only entity tagged hero-product', candidates: [tagged[0].id] }
  }

  const pool = tagged.length > 1 ? tagged : visible.filter(entity => entityExtent(entity) > 0)
  if (pool.length === 0) return { id: null, source: 'this scene has no entity to be the subject of', candidates: [] }

  // Descending volume, and the id only breaks exact ties — so two entities of equal
  // size resolve the same way on every machine and after every re-sort.
  const ranked = [...pool].sort((left, right) => {
    const byVolume = entityExtent(right) - entityExtent(left)
    if (byVolume !== 0) return byVolume
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const candidates = ranked.map(entity => entity.id)
  return {
    id: ranked[0].id,
    source: tagged.length > 1
      ? `${tagged.length} entities are tagged hero-product, so the largest was taken; the ambiguity is reported`
      : 'it is the largest visible entity and nothing is tagged hero-product',
    candidates,
  }
}

/**
 * The subject's id alone. Kept because most callers want only the id; use
 * {@link resolveSubject} when the reason for the choice matters — which is whenever
 * the answer is going to be shown to someone.
 *
 * @param {object} spec
 * @returns {string|null}
 */
export function resolveSubjectId(spec) {
  return resolveSubject(spec).id
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

/**
 * Why one standard role is in the plan, phrased for the model that reads it.
 *
 * @param {string} role
 * @param {string|null} subjectId
 * @returns {string}
 */
function rolePurpose(role, subjectId) {
  switch (role) {
    case 'three-quarter':
      return 'a 45-degree reading of the subject where depth, silhouette and contact shadows are visible'
    case 'top':
      return 'top-down placement: what is beside, behind or on top of the subject'
    case 'detail':
      return subjectId === null
        ? 'a closer angle on the subject'
        : `a closer angle on "${subjectId}" for surface, edge and material detail`
    case 'active-camera':
      return 'what the animation is actually seen through'
    default:
      return `the scene's "${role}" view`
  }
}

/**
 * The frame span a scene actually animates over, or null when it does not animate.
 *
 * Taken from the tracks rather than from the project range on purpose: a project may
 * declare 1..450 with motion only in 30..390, and sampling the declared range would
 * spend three of four frames on frames that hold still.
 */
function animationSpan(spec) {
  const tracks = Array.isArray(spec?.animationTracks) ? spec.animationTracks : []
  const frames = []
  for (const track of tracks) {
    for (const keyframe of track.keyframes ?? []) {
      if (Number.isInteger(keyframe?.frame)) frames.push(keyframe.frame)
    }
  }
  if (frames.length === 0) return null
  const declared = frameRange(spec)
  const start = Math.max(declared.start, Math.min(...frames))
  const end = Math.min(declared.end, Math.max(...frames))
  return end > start ? [start, end] : null
}

/**
 * `count` whole frames spread evenly across [start, end], endpoints included.
 *
 * Endpoints included is deliberate: the first and last frame of a commercial are the
 * two a human will judge, so a plan that skipped them would trade one blind spot for
 * another. Interior samples are what catch a defect that hides at the extremes.
 */
function evenlySpaced([start, end], count) {
  if (count <= 1 || end <= start) return [start]
  const step = (end - start) / (count - 1)
  const out = []
  for (let index = 0; index < count; index += 1) {
    const value = Math.round(start + index * step)
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/** The declared frame range of a compiled spec. */
function frameRange(spec) {  const start = Number.isFinite(spec?.project?.frameStart) ? spec.project.frameStart : 1
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
 * How big an entity is, for ranking and for measuring.
 *
 * THE SHARED DEFINITION, not a local one. This file used to compute its own volume,
 * and that copy dispatched on which FIELDS a generator happened to have rather than on
 * its shape — so a cylinder matched the `radius` branch and was scored as a sphere. A
 * 36 mm watch dial then outranked the 44 mm case it sits in and became "the largest
 * hero-tagged entity", i.e. the subject of the shot. The measurement was fine; the
 * thing deciding what to point it at was not.
 *
 * `entityBoundingRadius` is the definition the camera aiming already uses, so the two
 * agree by construction rather than by review.
 *
 * @param {object} entity
 * @returns {number}
 */
function entityExtent(entity) {
  // A bounding radius, not a volume: what makes an object worth tracking is how much
  // of the FRAME it can cover. A thin partition has almost no volume and hides
  // everything, which is exactly the occluder this ranking must not skip.
  return entityBoundingRadius(entity)
}
