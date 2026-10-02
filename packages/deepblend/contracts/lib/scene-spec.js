/**
 * SceneSpec v1 — validation, semantic rules, and the deterministic camera solver.
 *
 * Two validation layers, deliberately separated (SPEC §13.2 "JSON Schema 验证"
 * then "技术验证"):
 *
 *  1. **Structural** — the JSON Schema in `deepblend/schemas/scene-spec.schema.json`.
 *     Answers "is this a well-formed SceneSpec?" It cannot answer anything that
 *     needs two parts of the document at once.
 *  2. **Semantic** — this module. Answers "does this document describe a scene
 *     that can actually be compiled?": unique ids, every reference resolving, no
 *     cycles, sane numbers, and no path escaping the project root.
 *
 * A failure in either layer is an *error* and refuses the revision. A "notice"
 * is different: it records that compilation had to make a decision the author
 * did not spell out (aiming a camera, applying a default). Notices are carried
 * into the digest so the model can see exactly what the compiler decided on its
 * behalf instead of discovering it in a render.
 *
 * Owner: DeepBlend Studio — M1
 */

import { canonicalStringify, sha256Canonical } from './canonical.js'
import { compileSchema, formatIssues } from './json-schema.js'
import { referenceImageIssues } from './reference-images.js'
import sceneSpecSchema from './schemas/scene-spec.schema.json' with { type: 'json' }

/** The one schema version this module understands. */
export const SCENE_SCHEMA_VERSION = 'deepblend.scene/v1'

/**
 * What a scene with no `world` block is lit by.
 *
 * These numbers used to exist ONLY as literals inside the Blender compiler
 * (`deepblend_scene.py`), which made "the background stays grey whatever the brief
 * asks for" unreachable from a SceneSpec. They are still the default, but they are
 * now contract: the schema declares the same values under `default`, and a test
 * asserts the two agree, so the copies cannot drift apart silently.
 *
 * They are deliberately NOT materialised into the compiled spec. The scene digest
 * is taken over the compiled document, so filling in `world: {...}` for a scene that
 * never mentioned it would change the digest of every revision ever recorded and
 * the store would look corrupt against its own manifests.
 */
export const DEFAULT_WORLD = Object.freeze({
  color: Object.freeze([0.02, 0.021, 0.026, 1]),
  strength: 0.6,
})

/** `id` grammar, mirrored from the schema so semantic messages can name it. */
const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/

/**
 * What an animation track can be pointed at.
 *
 * `entity` is the default and the only kind that existed before: an animation could
 * only move generated geometry, so "the camera orbits the product" had to be faked
 * by rotating the product instead, and "the dial lights up" had to be faked by
 * scaling emissive geometry instead of ramping a material.
 */
/** Transform channels, shared by every target that has a `transform`. */
export const TRANSFORM_ANIMATION_PROPERTIES = Object.freeze([
  'location.x', 'location.y', 'location.z',
  'rotationEuler.x', 'rotationEuler.y', 'rotationEuler.z',
  'scale.x', 'scale.y', 'scale.z',
])

/**
 * Material parameters that can be ramped.
 *
 * These are the same names `material.parameter.update` takes, so a reader has one
 * vocabulary rather than two. Which Blender socket each one addresses is the
 * compiler's business (`PRINCIPLED_SOCKETS`).
 */
export const MATERIAL_ANIMATION_PROPERTIES = Object.freeze([
  'emissionStrength', 'roughness', 'metallic', 'ior', 'alpha', 'coatWeight', 'transmissionWeight',
  'anisotropic', 'anisotropicRotation',
  'baseColor.r', 'baseColor.g', 'baseColor.b',
  'emissionColor.r', 'emissionColor.g', 'emissionColor.b',
])

/** The property vocabulary, per target kind. */
export const ANIMATION_PROPERTIES_BY_KIND = Object.freeze({
  entity: TRANSFORM_ANIMATION_PROPERTIES,
  camera: TRANSFORM_ANIMATION_PROPERTIES,
  material: MATERIAL_ANIMATION_PROPERTIES,
})

/**
 * Which collection an animation track's `targetKind` resolves against.
 *
 * ONE definition of the branch. The patch transaction and `validateSceneSpec` each
 * spelled out `entities` on their own, and they disagreed the moment kinds existed:
 * the schema accepted a legal camera track while the transaction still resolved it
 * against `entities` and refused the patch with a message about a missing entity.
 * The name form exists because the validator indexes collections by key.
 */
export function collectionNameForKind(kind) {
  if (kind === 'camera') return 'cameras'
  if (kind === 'material') return 'materials'
  // A BONE TRACK RESOLVES AGAINST THE ARMATURES, because that is the collection its id belongs to.
  if (kind === 'bone') return 'armatures'
  return 'entities'
}

/** The entries themselves, for a caller holding the document rather than an index. */
export function collectionForKind(spec, kind) {
  return spec[collectionNameForKind(kind)] ?? []
}

/** Material parameters that must not go negative; a negative emission is a black one. */
const NON_NEGATIVE_MATERIAL_PROPERTIES = Object.freeze([
  'emissionStrength', 'emissionColor.r', 'emissionColor.g', 'emissionColor.b',
])

/** Material parameters that are only meaningful inside [0, 1]. */
const UNIT_MATERIAL_PROPERTIES = Object.freeze([
  'roughness', 'metallic', 'alpha', 'coatWeight', 'transmissionWeight',
  'anisotropic', 'anisotropicRotation',
  'baseColor.r', 'baseColor.g', 'baseColor.b',
])

/** Render engines the spec vocabulary allows. */export const SCENE_ENGINES = Object.freeze(['eevee', 'cycles', 'workbench'])

/** Engine identifier used inside Blender, keyed by the spec's vocabulary. */
export const BLENDER_ENGINE_BY_KEY = Object.freeze({
  eevee: 'BLENDER_EEVEE',
  cycles: 'CYCLES',
  workbench: 'BLENDER_WORKBENCH',
})

/** Import operator per asset type, resolved behaviorally at compile time. */
export const IMPORT_OPERATOR_BY_ASSET_TYPE = Object.freeze({
  glb: 'import_scene.gltf',
  gltf: 'import_scene.gltf',
  fbx: 'import_scene.fbx',
  obj: 'wm.obj_import',
  usd: 'wm.usd_import',
  blend: 'wm.append',
})

export const IMAGE_ASSET_TYPES = Object.freeze(['png', 'jpg', 'jpeg'])
export const ENVIRONMENT_ASSET_TYPES = Object.freeze([...IMAGE_ASSET_TYPES, 'hdr', 'exr'])

const validateStructure = compileSchema(sceneSpecSchema, { id: 'scene-spec.schema.json' })

/**
 * @typedef {object} SceneSpecIssue
 * @property {'error'|'notice'} severity
 * @property {string} code - stable, machine-branchable.
 * @property {string} path - where in the document.
 * @property {string} message
 */

/**
 * Validate a SceneSpec structurally and semantically.
 *
 * @param {unknown} spec
 * @returns {{ ok: boolean, errors: SceneSpecIssue[], notices: SceneSpecIssue[], summary: string }}
 */
export function validateSceneSpec(spec) {
  /** @type {SceneSpecIssue[]} */
  const errors = []
  /** @type {SceneSpecIssue[]} */
  const notices = []

  const structural = validateStructure(spec)
  for (const issue of structural) {
    errors.push({
      severity: 'error',
      code: 'SCENE_SCHEMA_INVALID',
      path: issue.path,
      message: `${issue.message} [${issue.keyword}]`,
    })
  }
  if (errors.length > 0) {
    // Semantic rules assume a well-formed document; running them against a
    // malformed one produces noise that buries the actual schema violation.
    return { ok: false, errors, notices, summary: formatIssues(structural) }
  }

  const document = /** @type {any} */ (spec)
  const project = document.project

  // ---- project invariants -------------------------------------------------
  if (project.frameEnd <= project.frameStart) {
    errors.push({
      severity: 'error', code: 'SCENE_FRAME_RANGE_INVALID', path: 'project.frameEnd',
      message: `frameEnd (${project.frameEnd}) must be greater than frameStart (${project.frameStart})`,
    })
  }

  // ---- uniqueness ---------------------------------------------------------
  const collections = [
    ['assets', document.assets ?? []],
    // ARMATURES ARE A COLLECTION LIKE ANY OTHER: they have ids, they can collide, and other things
    // reference them by id. Leaving them out of this list meant the cross-reference check had nothing to
    // look in, so a skinned entity was reported as naming a rig that does not exist — its own rig.
    ['armatures', document.armatures ?? []],
    ['materials', document.materials ?? []],
    ['entities', document.entities],
    ['lights', document.lights ?? []],
    ['cameras', document.cameras],
    ['shots', document.shots ?? []],
    ['animationTracks', document.animationTracks ?? []],
  ]
  /** @type {Map<string, Map<string, number>>} */
  const indexByCollection = new Map()
  for (const [name, entries] of collections) {
    /** @type {Map<string, number>} */
    const seen = new Map()
    entries.forEach((entry, position) => {
      const id = entry?.id
      if (typeof id !== 'string') return // already a structural error
      if (!ID_PATTERN.test(id)) {
        errors.push({
          severity: 'error', code: 'SCENE_ID_INVALID', path: `${name}[${position}].id`,
          message: `"${id}" is not a valid id (must match ${ID_PATTERN.source})`,
        })
      }
      if (seen.has(id)) {
        errors.push({
          severity: 'error', code: 'SCENE_ID_DUPLICATE', path: `${name}[${position}].id`,
          message: `duplicate id "${id}" — first defined at ${name}[${seen.get(id)}]`,
        })
      } else {
        seen.set(id, position)
      }
    })
    indexByCollection.set(name, seen)
  }
  const idsOf = name => indexByCollection.get(name) ?? new Map()

  // ---- reference integrity ------------------------------------------------
  for (const issue of referenceImageIssues(project.referenceImages ?? [], document.assets ?? [])) {
    errors.push({ ...issue, severity: 'error', path: `project.referenceImages${issue.path}` })
  }
  const requiresId = (collection, id, path, what) => {
    if (id === undefined || id === null) return
    if (!idsOf(collection).has(id)) {
      errors.push({
        severity: 'error', code: 'SCENE_REFERENCE_MISSING', path,
        message: `${what} "${id}" does not exist in ${collection}`,
      })
    }
  }
  requiresId('entities', project.reviewSubjectId, 'project.reviewSubjectId', 'review subject')
  if (project.reviewSubjectId !== undefined && document.entities.some(entity =>
    entity.id === project.reviewSubjectId && entity.type === 'empty')) {
    errors.push({ severity: 'error', code: 'SCENE_SPEC_INVALID', path: 'project.reviewSubjectId',
      message: 'The review subject must be a renderable entity, not an empty.' })
  }

  ;(document.assets ?? []).forEach((asset, position) => {
    // Path containment (SPEC §15.2). The project root is the only legal base.
    const path = asset.path
    if (typeof path === 'string') {
      if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
        errors.push({
          severity: 'error', code: 'SCENE_ASSET_PATH_ABSOLUTE', path: `assets[${position}].path`,
          message: `"${path}" is absolute; asset paths must be relative to the project root`,
        })
      } else if (path.split(/[\\/]/).includes('..')) {
        errors.push({
          severity: 'error', code: 'SCENE_ASSET_PATH_TRAVERSAL', path: `assets[${position}].path`,
          message: `"${path}" contains a ".." segment and would escape the project root`,
        })
      }
    }
  })

  if (document.world?.environment) {
    const id = document.world.environment.assetId
    requiresId('assets', id, 'world.environment.assetId', 'environment image')
    const asset = (document.assets ?? []).find(entry => entry.id === id)
    if (asset && !ENVIRONMENT_ASSET_TYPES.includes(asset.type)) errors.push({ severity: 'error',
      code: 'SCENE_WORLD_ENVIRONMENT_INVALID', path: 'world.environment.assetId', message: 'environment requires an image asset' })
  }

  for (const [index, material] of (document.materials ?? []).entries()) {
    const anisotropicKeys = ['anisotropic', 'anisotropicRotation']
    const anisotropicTracks = (document.animationTracks ?? []).filter(track => track.targetKind === 'material' &&
      track.targetEntityId === material.id && anisotropicKeys.includes(track.property))
    const declaredAnisotropy = material.tangent !== undefined || anisotropicTracks.length > 0 ||
      anisotropicKeys.some(key => material.parameters?.[key] !== undefined)
    if (declaredAnisotropy && material.shader === 'emission') errors.push({ severity: 'error',
      code: 'SCENE_MATERIAL_ANISOTROPY_INVALID', path: `materials[${index}]`,
      message: 'anisotropic parameters and tangents require a principled or glass material' })
    const directionRequired = anisotropicKeys.some(key => (material.parameters?.[key] ?? 0) !== 0) ||
      anisotropicTracks.some(track => track.keyframes.some(keyframe => keyframe.value !== 0))
    if (directionRequired && material.tangent === undefined) errors.push({ severity: 'error',
      code: 'SCENE_MATERIAL_ANISOTROPY_INVALID', path: `materials[${index}].tangent`,
      message: 'nonzero anisotropy or rotation, including animation, requires an explicit uv or radial tangent' })
    if (material.images && material.texture) errors.push({ severity: 'error', code: 'SCENE_MATERIAL_IMAGES_INVALID',
      path: `materials[${index}].images`, message: 'image maps and procedural texture cannot be combined on one material yet' })
    if (material.images && material.shader === 'emission') errors.push({ severity: 'error', code: 'SCENE_MATERIAL_IMAGES_INVALID',
      path: `materials[${index}].images`, message: 'image maps require a principled or glass material' })
    for (const [channel, binding] of Object.entries(material.images ?? {})) {
      const path = `materials[${index}].images.${channel}`
      requiresId('assets', binding.assetId, `${path}.assetId`, 'image asset')
      const asset = (document.assets ?? []).find(entry => entry.id === binding.assetId)
      if (asset && !IMAGE_ASSET_TYPES.includes(asset.type)) errors.push({ severity: 'error',
        code: 'SCENE_MATERIAL_IMAGES_INVALID', path, message: 'material image maps require PNG or JPEG assets' })
      if ((binding.strength !== undefined && channel !== 'normal') ||
          (binding.channel !== undefined && !['roughness', 'metallic', 'alpha'].includes(channel))) {
        errors.push({ severity: 'error', code: 'SCENE_MATERIAL_IMAGES_INVALID', path,
          message: 'strength applies only to normals; channel selection applies only to scalar maps' })
      }
    }
  }

  document.entities.forEach((entity, position) => {
    const at = `entities[${position}]`
    if (entity.type === 'asset-instance') {
      if (entity.assetId === undefined) {
        errors.push({
          severity: 'error', code: 'SCENE_ENTITY_ASSET_REQUIRED', path: `${at}.assetId`,
          message: 'an asset-instance entity must name the asset it instantiates',
        })
      } else {
        requiresId('assets', entity.assetId, `${at}.assetId`, 'asset')
        if (ENVIRONMENT_ASSET_TYPES.includes((document.assets ?? []).find(asset => asset.id === entity.assetId)?.type)) {
          errors.push({ severity: 'error', code: 'SCENE_ENTITY_ASSET_INVALID', path: `${at}.assetId`,
            message: 'an image asset cannot be instantiated as a mesh' })
        }
      }
      if (entity.generator !== undefined) {
        errors.push({
          severity: 'error', code: 'SCENE_ENTITY_GENERATOR_CONFLICT', path: `${at}.generator`,
          message: 'an asset-instance entity must not also declare a procedural generator',
        })
      }
    }
    if (entity.type === 'generator' && entity.generator === undefined) {
      errors.push({
        severity: 'error', code: 'SCENE_ENTITY_GENERATOR_REQUIRED', path: `${at}.generator`,
        message: 'a generator entity must declare its `generator` block',
      })
    }
    if (entity.type !== 'asset-instance' && entity.assetId !== undefined) {
      errors.push({
        severity: 'error', code: 'SCENE_ENTITY_ASSET_UNUSED', path: `${at}.assetId`,
        message: `only an asset-instance entity may declare assetId (this entity is "${entity.type}")`,
      })
    }
    requiresId('materials', entity.materialId, `${at}.materialId`, 'material')
    if (entity.materialBindings !== undefined) {
      if (entity.type !== 'asset-instance') errors.push({ severity: 'error', code: 'SCENE_MATERIAL_BINDING_INVALID',
        path: `${at}.materialBindings`, message: 'materialBindings requires an asset-instance entity' })
      const selectors = new Set()
      for (const [index, binding] of entity.materialBindings.entries()) {
        requiresId('materials', binding.materialId, `${at}.materialBindings[${index}].materialId`, 'material')
        const key = JSON.stringify([binding.partId, binding.slotIndex ?? null])
        if (selectors.has(key)) errors.push({ severity: 'error', code: 'SCENE_MATERIAL_BINDING_INVALID',
          path: `${at}.materialBindings[${index}]`, message: 'duplicate part and slot material binding' })
        selectors.add(key)
      }
    }
    if (entity.generator?.shape === 'lathe') {
      const profile = entity.generator.profile
      const invalid = message => errors.push({ severity: 'error', code: 'SCENE_GENERATOR_PROFILE_INVALID',
        path: `${at}.generator.profile`, message })
      if (!Array.isArray(profile) || profile.length < 2) {
        invalid('a lathe requires at least two [radius, height] profile points')
      } else {
        if (profile.some(point => point[0] < 0) || !profile.some(point => point[0] > 0)) {
          invalid('lathe radii must be nonnegative, with at least one positive radius')
        }
        if (profile.some((point, index) => index > 0 && point[0] === profile[index - 1][0] && point[1] === profile[index - 1][1])) {
          invalid('consecutive lathe profile points must differ')
        }
        if (profile.slice(1, -1).some(point => point[0] === 0)) invalid('axis points are allowed only at the two profile ends')
        if (new Set(profile.map(point => point[1])).size < 2) invalid('a lathe profile must have nonzero height')
        if (entity.generator.closedProfile && (profile.length < 3 ||
          (profile[0][0] === profile.at(-1)[0] && profile[0][1] === profile.at(-1)[1]))) {
          invalid('a closed profile needs at least three points and closes automatically; omit the repeated first point')
        }
        if (profileIntersects(profile, entity.generator.closedProfile === true)) invalid('lathe profile edges must not intersect')
      }
    } else if (entity.generator && ['profile', 'closedProfile', ...(entity.generator.shape === 'curve' ? [] : ['capEnds'])].some(key => entity.generator[key] !== undefined)) {
      errors.push({ severity: 'error', code: 'SCENE_GENERATOR_PROFILE_INVALID', path: `${at}.generator`,
        message: 'profile and closedProfile require lathe geometry; capEnds requires lathe or curve geometry' })
    }
    const generator = entity.generator
    if (generator?.shape === 'curve') {
      const path = generator.path
      const invalid = message => errors.push({ severity: 'error', code: 'SCENE_GENERATOR_PATH_INVALID',
        path: `${at}.generator.path`, message })
      if (!Array.isArray(path) || path.length < (generator.pathClosed ? 3 : 2)) {
        invalid('a curve needs two path points, or three for a closed path')
      } else {
        if (path.some((point, i) => i > 0 && point.every((value, axis) => value === path[i - 1][axis]))) {
          invalid('consecutive curve path points must differ')
        }
        if (generator.pathClosed && path[0].every((value, axis) => value === path.at(-1)[axis])) {
          invalid('a closed path closes automatically; omit the repeated first point')
        }
        for (let i = generator.pathClosed ? 0 : 1; i < (generator.pathClosed ? path.length : path.length - 1); i += 1) {
          const a = path[(i + path.length - 1) % path.length].map((v, axis) => v - path[i][axis])
          const b = path[(i + 1) % path.length].map((v, axis) => v - path[i][axis])
          const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
          if (Math.hypot(...cross) < 1e-12 && a.reduce((sum, v, axis) => sum + v * b[axis], 0) > 0) {
            invalid('a curve path must not reverse along the same segment')
            break
          }
        }
      }
    } else if (generator && ['path', 'pathClosed', 'pathInterpolation', 'curveResolution', 'bevelResolution'].some(key => generator[key] !== undefined)) {
      errors.push({ severity: 'error', code: 'SCENE_GENERATOR_PATH_INVALID', path: `${at}.generator`,
        message: 'curve path parameters apply only to curve geometry' })
    }
    // AND THE RIG IT IS SKINNED TO. MEASURED: this check was missing at first, and the contract suite
    // caught it — the schema can say `armatureId` is a string, but only a cross-reference can say it
    // names something the scene declares. An entity skinned to an armature nobody declares would render
    // as a static object while the file says it is rigged, which is the failure this code exists for.
    requiresId('armatures', entity.armatureId, `${at}.armatureId`, 'armature')
    if (entity.type === 'generator' && entity.materialId === undefined) {
      notices.push({
        severity: 'notice', code: 'SCENE_ENTITY_MATERIAL_DEFAULTED', path: at,
        message: `entity "${entity.id}" has no materialId; the default principled material will be applied`,
      })
    }
    checkScale(entity.transform?.scale, `${at}.transform.scale`, errors, entity.id)
    for (const [i, modifier] of (entity.modifiers ?? []).entries()) {
      const path = `${at}.modifiers[${i}]`
      if (entity.type === 'empty' || (modifier.type === 'solidify' && modifier.thickness === 0) ||
        (modifier.type === 'array' && modifier.offset.every(value => value === 0))) {
        errors.push({ severity: 'error', code: 'SCENE_MODIFIER_INVALID', path,
          message: 'mesh modifiers need geometry, nonzero thickness and nonzero array offset' })
      }
      if (modifier.type === 'boolean') requiresId('entities', modifier.targetEntityId, `${path}.targetEntityId`, 'boolean operand')
    }
  })

  const modifierEntities = new Map(document.entities.map(entity => [entity.id, entity]))
  const visitedModifiers = new Set(), activeModifiers = new Set()
  const visitModifiers = id => {
    if (activeModifiers.has(id)) {
      errors.push({ severity: 'error', code: 'SCENE_MODIFIER_CYCLE', path: 'entities',
        message: `boolean dependency cycle includes entity "${id}"` })
      return
    }
    if (visitedModifiers.has(id)) return
    activeModifiers.add(id)
    for (const modifier of modifierEntities.get(id)?.modifiers ?? []) {
      if (modifier.type === 'boolean') visitModifiers(modifier.targetEntityId)
    }
    activeModifiers.delete(id)
    visitedModifiers.add(id)
  }
  for (const id of modifierEntities.keys()) visitModifiers(id)

  ;(document.lights ?? []).forEach((light, position) => {
    checkScale(light.transform?.scale, `lights[${position}].transform.scale`, errors, light.id)
  })

  document.cameras.forEach((camera, position) => {
    const at = `cameras[${position}]`
    requiresId('entities', camera.targetEntityId, `${at}.targetEntityId`, 'entity')
    if (camera.targetEntityId !== undefined && camera.targetPoint !== undefined) {
      errors.push({
        severity: 'error', code: 'SCENE_CAMERA_TARGET_AMBIGUOUS', path: at,
        message: 'a camera must declare either targetEntityId or targetPoint, not both',
      })
    }
    if (Array.isArray(camera.clipping) && camera.clipping[0] >= camera.clipping[1]) {
      errors.push({
        severity: 'error', code: 'SCENE_CAMERA_CLIPPING_INVALID', path: `${at}.clipping`,
        message: `clip start (${camera.clipping[0]}) must be less than clip end (${camera.clipping[1]})`,
      })
    }
    const hasTarget = camera.targetEntityId !== undefined || camera.targetPoint !== undefined
    const hasLocation = camera.transform?.location !== undefined
    if (!hasLocation && !hasTarget) {
      errors.push({
        severity: 'error', code: 'SCENE_CAMERA_UNPLACED', path: at,
        message: 'a camera needs at least a transform.location or a target to be placed',
      })
    }
    if (hasTarget && camera.transform?.rotationEuler !== undefined) {
      notices.push({
        severity: 'notice', code: 'SCENE_CAMERA_ROTATION_IGNORED', path: `${at}.transform.rotationEuler`,
        message:
          `camera "${camera.id}" declares both a target and an explicit rotationEuler; ` +
          'the derived aim wins because a target is the stronger statement of intent',
      })
    }
    if (hasTarget && !hasLocation) {
      notices.push({
        severity: 'notice', code: 'SCENE_CAMERA_POSITION_DERIVED', path: `${at}.transform.location`,
        message:
          `camera "${camera.id}" has a target but no position; a deterministic frontal position ` +
          'will be derived from the target',
      })
    }
  })

  ;(document.shots ?? []).forEach((shot, position) => {
    requiresId('cameras', shot.cameraId, `shots[${position}].cameraId`, 'camera')
    if (Array.isArray(shot.frameRange) && shot.frameRange[0] >= shot.frameRange[1]) {
      errors.push({
        severity: 'error', code: 'SCENE_SHOT_FRAME_RANGE_INVALID', path: `shots[${position}].frameRange`,
        message: `shot frame range end (${shot.frameRange[1]}) must exceed its start (${shot.frameRange[0]})`,
      })
    }
  })

  ;(document.animationTracks ?? []).forEach((track, position) => {
    const at = `animationTracks[${position}]`
    // The target kind decides WHICH collection the id resolves against — ids are
    // unique per collection, not globally, so "watch-dial" could name an entity and
    // a material at once and only the kind says which. Absent means `entity`, which
    // is what every track written before kinds existed meant.
    const kind = track.targetKind ?? 'entity'
    requiresId(collectionNameForKind(kind), track.targetEntityId, `${at}.targetEntityId`, kind)
    // AND THE BONE INSIDE IT. MEASURED: this is the same shape as `armatureId` last round — the schema
    // can say `boneName` is a string, and only a cross-reference can say the armature HAS that bone.
    // A track pointing at a bone nobody declares animates nothing while the file says the rig moves.
    if (kind === 'bone') {
      if (typeof track.boneName !== 'string' || track.boneName.length === 0) {
        errors.push({
          severity: 'error', code: 'SCENE_REFERENCE_MISSING', path: `${at}.boneName`,
          message: 'a bone track must name the bone it drives',
        })
      } else {
        const armature = (document.armatures ?? []).find(entry => entry?.id === track.targetEntityId)
        if (armature !== undefined && !(armature.bones ?? []).some(bone => bone?.name === track.boneName)) {
          errors.push({
            severity: 'error', code: 'SCENE_REFERENCE_MISSING', path: `${at}.boneName`,
            message: `bone "${track.boneName}" does not exist in armature "${track.targetEntityId}"`,
          })
        }
      }
    }

    // A property that does not belong to the target's kind is not a typo the
    // compiler can shrug off: `emissionStrength` on an entity, or `location.x` on a
    // material, addresses nothing, and the track would then animate in the report
    // while the render showed no motion at all.
    const allowed = ANIMATION_PROPERTIES_BY_KIND[kind]
    if (allowed !== undefined && !allowed.includes(track.property)) {
      errors.push({
        severity: 'error', code: 'SCENE_ANIMATION_PROPERTY_INVALID', path: `${at}.property`,
        message:
          `property "${track.property}" cannot be animated on a ${kind}; ` +
          `${kind} tracks support: ${allowed.join(', ')}`,
      })
    }

    // Ranges the schema cannot express, because they depend on WHICH parameter the
    // property names. A negative emission strength is a black emitter and a
    // metallic of 3 is a typo; both would otherwise compile and render silently.
    for (const [index, keyframe] of (track.keyframes ?? []).entries()) {
      const value = keyframe?.value
      if (typeof value !== 'number') continue
      const path = `${at}.keyframes[${index}].value`
      if (kind === 'material' && NON_NEGATIVE_MATERIAL_PROPERTIES.includes(track.property) && value < 0) {
        errors.push({
          severity: 'error', code: 'SCENE_KEYFRAME_VALUE_OUT_OF_RANGE', path,
          message: `"${track.property}" cannot be negative, but keyframe ${index} is ${value}`,
        })
      }
      if (kind === 'material' && UNIT_MATERIAL_PROPERTIES.includes(track.property) && (value < 0 || value > 1)) {
        errors.push({
          severity: 'error', code: 'SCENE_KEYFRAME_VALUE_OUT_OF_RANGE', path,
          message: `"${track.property}" must be within [0, 1], but keyframe ${index} is ${value}`,
        })
      }
    }

    const frames = track.keyframes.map(keyframe => keyframe.frame)
    for (let index = 1; index < frames.length; index += 1) {
      if (frames[index] <= frames[index - 1]) {
        errors.push({
          severity: 'error', code: 'SCENE_KEYFRAMES_UNORDERED', path: `${at}.keyframes[${index}].frame`,
          message: `keyframe frames must strictly increase; ${frames[index]} follows ${frames[index - 1]}`,
        })
        break
      }
    }
  })

  // ---- renderability ------------------------------------------------------
  const hasEmitter = document.entities.some(entity => entity.type !== 'empty')
  if (!hasEmitter) {
    errors.push({
      severity: 'error', code: 'SCENE_HAS_NO_GEOMETRY', path: 'entities',
      message: 'the scene contains no entity that would produce geometry; a render would be empty',
    })
  }
  const lights = document.lights ?? []
  if (lights.length === 0) {
    notices.push({
      severity: 'notice', code: 'SCENE_NO_LIGHTS', path: 'lights',
      message: 'the scene declares no lights; the render will be lit only by world illumination',
    })
  }

  return {
    ok: errors.length === 0,
    errors,
    notices,
    summary: errors.length === 0 ? 'valid' : formatIssues(errors.map(issue => ({
      path: issue.path, keyword: issue.code, message: issue.message,
    }))),
  }
}

/** Reject a zero or negative scale component, which would produce a degenerate object. */
function checkScale(scale, path, errors, owner) {
  if (!Array.isArray(scale)) return
  scale.forEach((component, index) => {
    if (!(Math.abs(component) > 0)) {
      errors.push({
        severity: 'error', code: 'SCENE_SCALE_DEGENERATE', path: `${path}[${index}]`,
        message: `scale component for "${owner}" is ${component}; a zero scale collapses the object`,
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Deterministic compilation
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CompileResult
 * @property {object} spec - the resolved spec, safe to compile in Blender.
 * @property {SceneSpecIssue[]} notices - decisions the compiler had to make.
 * @property {Record<string, { location: number[], radius: number }>} entityBounds
 */

/**
 * Resolve everything a Blender compile would otherwise have to guess, so the
 * same SceneSpec always produces the same scene (SPEC §19.5 golden scenes).
 *
 * M1 resolves:
 *  - every generator's missing dimensions to the documented defaults;
 *  - every entity transform's missing components to identity;
 *  - a camera's POSITION when it declares a target but no location.
 *
 * WHAT IS DELIBERATELY *NOT* RESOLVED HERE: the camera's AIM.
 *
 * Aiming a camera at a point is a rotation, and computing it in Node would mean
 * re-implementing `Vector.to_track_quat('-Z','Y').to_euler('XYZ')` — including
 * its degeneracy choices — in a second language. Two implementations of one
 * rotation is one too many: any divergence shows up as a camera that frames the
 * subject slightly differently on one side than the other, which is among the
 * most expensive bugs to notice. `bootstrap.py` therefore owns the aim, using
 * Blender's own operator, and the authored `rotationEuler` is simply ignored
 * when a target is present (validation emits `SCENE_CAMERA_ROTATION_IGNORED`).
 *
 * The resolved spec stays a valid SceneSpec, so a spec read back from a
 * revision recompiles identically.
 *
 * @param {object} spec - an already schema- and semantically-valid SceneSpec.
 * @returns {CompileResult}
 */
export function compileSceneSpec(spec) {
  /** @type {SceneSpecIssue[]} */
  const notices = []

  const entities = spec.entities.map(entity => ({
    visible: true,
    locked: false,
    tags: [],
    ...entity,
    transform: identityTransform(entity.transform),
    ...entity.type === 'generator' ? { generator: resolveGenerator(entity.generator) } : {},
  }))

  /** Entity centre and radius from generator footprint — the aiming substrate. */
  const entityBounds = {}
  for (const entity of entities) {
    entityBounds[entity.id] = boundsOf({ ...entity, modifiers: [] })
  }
  const boundsVisited = new Set()
  const expandBooleanBounds = entity => {
    if (boundsVisited.has(entity.id)) return
    boundsVisited.add(entity.id)
    for (const modifier of entity.modifiers ?? []) {
      const scale = Math.max(...entity.transform.scale.map(Math.abs))
      if (modifier.type === 'solidify') entityBounds[entity.id].radius += Math.abs(modifier.thickness) * scale
      if (modifier.type === 'array') entityBounds[entity.id].radius += Math.hypot(...modifier.offset) * (modifier.count - 1) * scale
      if (modifier.type !== 'boolean' || modifier.operation !== 'union') continue
      const operand = entities.find(candidate => candidate.id === modifier.targetEntityId)
      if (!operand) continue
      expandBooleanBounds(operand)
      const own = entityBounds[entity.id], other = entityBounds[operand.id]
      own.radius = Math.max(own.radius, Math.hypot(...own.location.map((v, axis) => v - other.location[axis])) + other.radius)
    }
  }
  for (const entity of entities) expandBooleanBounds(entity)

  const cameras = spec.cameras.map(camera => {
    const targetPoint = camera.targetEntityId !== undefined
      ? entityBounds[camera.targetEntityId]?.location ?? [0, 0, 0]
      : camera.targetPoint
    const targetRadius = camera.targetEntityId !== undefined
      ? entityBounds[camera.targetEntityId]?.radius ?? 1
      : 0

    if (targetPoint === undefined) {
      // No aim requested: honour the authored rotation and position verbatim.
      return { ...camera, transform: identityTransform(camera.transform) }
    }

    const authored = camera.transform?.location
    const location = authored ?? deriveCameraLocation(targetPoint, targetRadius)
    if (authored === undefined) {
      notices.push({
        severity: 'notice', code: 'SCENE_CAMERA_POSITION_DERIVED', path: `cameras.${camera.id}.transform.location`,
        message:
          `camera "${camera.id}" was placed at [${location.map(round4).join(', ')}], derived from ` +
          `target [${targetPoint.map(round4).join(', ')}] — set transform.location to control framing exactly`,
      })
    }
    return { ...camera, transform: { ...identityTransform(camera.transform), location } }
  })

  const resolved = {
    ...spec,
    entities,
    cameras,
    // `shader` is required by the schema, so it is never defaulted here — a
    // default that cannot fire would misrepresent the contract as looser than it
    // is. Only `parameters` is materialised, because every consumer wants a
    // parameters object to read from rather than a chain of existence checks.
    materials: (spec.materials ?? []).map(material => ({
      parameters: {},
      ...material,
    })),
    lights: (spec.lights ?? []).map(light => ({
      energy: defaultEnergyFor(light.type),
      color: [1, 1, 1],
      transform: identityTransform(light.transform),
      ...light,
    })),
  }

  return { spec: resolved, notices, entityBounds }
}

/** Reject intersections and collinear reversals in a lathe boundary. */
function profileIntersects(points, closed) {
  const edges = points.slice(0, closed ? points.length : -1).map((point, index) => [point, points[(index + 1) % points.length]])
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const on = (a, b, p) => Math.abs(cross(a, b, p)) < 1e-12 &&
    p.every((value, axis) => value >= Math.min(a[axis], b[axis]) - 1e-12 && value <= Math.max(a[axis], b[axis]) + 1e-12)
  for (let i = closed ? 0 : 1; i < (closed ? points.length : points.length - 1); i += 1) {
    const a = points[(i + points.length - 1) % points.length], b = points[i], c = points[(i + 1) % points.length]
    if (Math.abs(cross(a, b, c)) < 1e-12 &&
      (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0) return true
  }
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 2; j < edges.length; j += 1) {
      if (closed && i === 0 && j === edges.length - 1) continue
      const [a, b] = edges[i], [c, d] = edges[j]
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
        on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return true
    }
  }
  return false
}

/** Generator defaults, applied per shape. */
function resolveGenerator(generator) {
  const shape = generator?.shape
  const base = { shape }
  switch (shape) {
    case 'cube':
      return { ...base, ...generator, size: generator.size ?? 2 }
    case 'rounded_box':
      return {
        ...base,
        ...generator,
        size: generator.size ?? 2,
        bevel: { width: generator.bevel?.width ?? 0.08, segments: generator.bevel?.segments ?? 4 },
      }
    case 'uv_sphere':
      return { ...base, ...generator, radius: generator.radius ?? 1, segments: generator.segments ?? 32, ringCount: generator.ringCount ?? 16 }
    case 'cylinder':
      return { ...base, ...generator, radius: generator.radius ?? 1, depth: generator.depth ?? 2, segments: generator.segments ?? 32 }
    case 'cone':
      return { ...base, ...generator, radius: generator.radius ?? 1, depth: generator.depth ?? 2, segments: generator.segments ?? 32 }
    case 'plane':
      return { ...base, ...generator, size: generator.size ?? 2 }
    case 'torus':
      return {
        ...base,
        ...generator,
        majorRadius: generator.majorRadius ?? 1,
        minorRadius: generator.minorRadius ?? 0.25,
        segments: generator.segments ?? 48,
        ringCount: generator.ringCount ?? 12,
      }
    case 'lathe':
      return { ...base, ...generator, segments: generator.segments ?? 96,
        closedProfile: generator.closedProfile ?? false, capEnds: generator.capEnds ?? true }
    case 'curve':
      return { ...base, ...generator, radius: generator.radius ?? 0.01, pathClosed: generator.pathClosed ?? false,
        pathInterpolation: generator.pathInterpolation ?? 'poly', curveResolution: generator.curveResolution ?? 16,
        bevelResolution: generator.bevelResolution ?? 8, capEnds: generator.capEnds ?? true }
    default:
      return { ...generator }
  }
}

/** Map a light type to a defensible default energy in watts. */
function defaultEnergyFor(type) {
  switch (type) {
    case 'sun': return 3
    case 'point': return 100
    case 'spot': return 200
    default: return 500
  }
}

/**
 * Centre and bounding radius of one entity, from its generator footprint and
 * transform. Deliberately analytic rather than measured: the aim must be
 * available BEFORE Blender runs, and an unmeasured analytic bound is what keeps
 * compilation reproducible.
 */
function boundsOf(entity) {
  return { location: [...entity.transform.location], radius: entityBoundingRadius(entity) }
}

/**
 * How big an entity is, as one bounding radius, from its generator footprint.
 *
 * ONE DEFINITION, TWO CONSUMERS. The camera aiming uses it to decide where to stand,
 * and the visual review uses it to rank which entities are big enough to matter. Those
 * need to agree: a scene where the camera frames "the big thing" and the review tracks
 * "the big thing" and the two disagree is a scene with two half-answers.
 *
 * They did disagree, and it cost a real project its subject. The review had its own
 * `entityVolume` that dispatched on which FIELDS were present rather than on `shape`,
 * so a cylinder — which has both `radius` and `depth` — matched the radius branch first
 * and was scored as a SPHERE. A 36 mm watch dial then outranked the 44 mm case it sits
 * in, and the review scored the dial as the subject of the shot.
 *
 * @param {object} entity
 * @returns {number}
 */
export function entityBoundingRadius(entity) {
  const scale = entity?.transform?.scale ?? [1, 1, 1]
  let radius = 1
  const generator = entity?.generator
  if (generator !== undefined) {
    switch (generator.shape) {
      case 'cube': radius = (generator.size / 2) * Math.sqrt(3); break
      case 'rounded_box': radius = (generator.size / 2) * Math.sqrt(3); break
      case 'uv_sphere': radius = generator.radius; break
      case 'cylinder': radius = Math.hypot(generator.radius, generator.depth / 2); break
      case 'cone': radius = Math.hypot(generator.radius, generator.depth / 2); break
      case 'plane': radius = (generator.size / 2) * Math.SQRT2; break
      case 'torus': radius = generator.majorRadius + generator.minorRadius; break
      case 'lathe': radius = Math.max(...generator.profile.map(([r, z]) => Math.hypot(r, z))); break
      case 'curve': radius = Math.max(...generator.path.map(point => Math.hypot(...point))) *
        (generator.pathInterpolation === 'bezier' ? 2 : 1) + generator.radius; break
      default: radius = 1
    }
  }
  for (const modifier of entity?.modifiers ?? []) {
    if (modifier.type === 'solidify') radius += Math.abs(modifier.thickness)
    if (modifier.type === 'array') radius += Math.hypot(...modifier.offset) * (modifier.count - 1)
  }
  return radius * Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]))
}

/** Fill in an identity transform for every component the author omitted. */
function identityTransform(transform) {
  return {
    location: transform?.location ?? [0, 0, 0],
    rotationEuler: transform?.rotationEuler ?? [0, 0, 0],
    scale: transform?.scale ?? [1, 1, 1],
  }
}

/**
 * Deterministic camera position for a target with no authored location.
 *
 * Not a "nice" framing heuristic and not trying to be: it is a fixed, documented
 * relationship to the target's analytic radius, chosen so that (a) the subject
 * is inside the frustum at the default 50 mm lens, and (b) the same spec always
 * yields the same camera. A model that wants real framing sets the location.
 */
function deriveCameraLocation(targetPoint, targetRadius) {
  const distance = Math.max(2, targetRadius * 2.5)
  return [
    round4(targetPoint[0]),
    round4(targetPoint[1] - distance),
    round4(targetPoint[2] + distance * 0.45),
  ]
}

/** Round to 4 decimals so a derived float is stable across platforms. */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * The scene-relevant projection of a spec.
 *
 * Project metadata, including goal and referenceImages, is excluded on purpose: the digest exists
 * to answer "is the SCENE different?", and a re-worded brief over an unchanged
 * scene is not a new scene. Two revisions can therefore share a digest, which is
 * exactly the signal a caller wants when deciding whether a re-render is needed.
 *
 * @param {object} spec
 * @returns {object}
 */
export function sceneProjection(spec) {
  return {
    assets: spec.assets ?? [],
    entities: spec.entities ?? [],
    materials: spec.materials ?? [],
    lights: spec.lights ?? [],
    cameras: spec.cameras ?? [],
    shots: spec.shots ?? [],
    animationTracks: spec.animationTracks ?? [],
    renderProfiles: spec.renderProfiles ?? {},
    // ABSENCE IS PRESERVED, for the same reason `applyPatchToSpec` preserves it: a
    // scene that never mentions a world must keep the digest it was recorded with.
    // `world: spec.world ?? null` here would silently re-digest every revision in
    // every store.
    ...(spec.world === undefined ? {} : { world: spec.world }),
  }
}

/**
 * Content hash of the compiled scene. Stable across key order and process runs.
 * @param {object} spec
 * @returns {string} lowercase hex sha256.
 */
export function sceneSpecDigest(spec) {
  return sha256Canonical(sceneProjection(spec))
}

/**
 * Content hash of the WHOLE document, including `project`.
 *
 * Distinct from {@link sceneSpecDigest}, and the distinction is load-bearing.
 * The scene digest deliberately excludes project metadata and the authored brief so
 * that re-wording a brief over an unchanged scene is not treated as a new scene.
 * But it also excludes `project.frameStart`, `project.frameEnd` and `project.fps`
 * — which ARE scene-relevant: changing the frame range changes what a render
 * produces and what "the animation" means.
 *
 * A single field could not serve both readings, so both exist and are used for
 * different questions:
 *
 *   `sceneSpecDigest` → "is the geometry, lighting and animation the same?"
 *                       (drives re-render decisions)
 *   `specHash`        → "did ANY part of the stored document change?"
 *                       (drives the revision's changed/unchanged verdict)
 *
 * Before this existed, a frame-range-only revision reported `sceneChanged: false`
 * even though the frame range had moved, which would make any re-render gate skip
 * it. Guarded by a regression test in scene-patch.test.mjs.
 *
 * @param {object} spec
 * @returns {string} lowercase hex sha256.
 */
export function specHash(spec) {
  return sha256Canonical(spec)
}

/** Identity of authored review inputs, independent of geometry and render settings.
 * References and purposes are sets identified by id; display order does not change
 * their meaning. Asset aliases are resolved from this document, never a live catalog.
 * The Host must still verify these declared hashes against the actual file bytes.
 */
export function reviewInputsDigest(spec) {
  const referenceImages = (spec?.project?.referenceImages ?? []).map(reference => {
    const asset = (spec.assets ?? []).find(entry => entry.id === reference.assetId)
    return {
      id: reference.id, assetId: reference.assetId, sha256: reference.sha256,
      label: reference.label, purposes: [...reference.purposes].sort(), notes: reference.notes ?? '',
      asset: asset ? { id: asset.id, type: asset.type, path: asset.path, sha256: asset.sha256 ?? null } : null,
    }
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  return sha256Canonical({ goal: spec?.project?.goal ?? '', referenceImages,
    ...(spec?.project?.reviewSubjectId === undefined ? {} : { reviewSubjectId: spec.project.reviewSubjectId }) })
}

/**
 * The compact `SceneDigest` handed to the model (SPEC §7.2 `getScene`, §18
 * "FullSceneSpec 明确需要时才读取"): counts, framing facts and profiles, never
 * the whole document.
 *
 * THE SUMMARY READS THE RESOLVED FORM, ALWAYS
 * -------------------------------------------
 * Compiling first is not belt-and-braces; it is what makes this function total. The
 * fields it reads are the ones compilation MATERIALISES — `entity.transform`, every
 * generator's shape-specific size, a camera's derived position — and all of them are
 * optional in the schema, so a legal document can omit any of them.
 *
 * Two real defects came from reading the raw document here:
 *
 *   - a camera added without a `transform` (also legal) crashed the whole call on
 *     `camera.transform.location`, so a successful commit returned an error;
 *   - a generator that omitted its shape's size field made `boundsOf` compute
 *     `undefined * n`, and NaN becomes `null` in JSON — so the summary carried
 *     silently wrong bounds and the harness rejected its own result.
 *
 * Revisions are immutable, so unresolved documents written by earlier code stay on
 * disk forever. Repairing them is not an option; reading them correctly is.
 *
 * @param {object} document - a SceneSpec as STORED, resolved or not.
 * @param {{ revision?: string|null, revisionNumber?: number|null, digest?: string }} [context]
 * @returns {Record<string, unknown>}
 */
export function summarizeSceneSpec(document, context = {}) {
  // Compilation is idempotent and only fills in documented defaults, so for the
  // resolved documents every writer now produces this is a no-op.
  const spec = compileSceneSpec(document).spec

  const entities = spec.entities ?? []
  const lights = spec.lights ?? []
  const cameras = spec.cameras ?? []
  const materials = spec.materials ?? []
  const shots = spec.shots ?? []
  const tracks = spec.animationTracks ?? []

  const bounds = entities.map(entity => ({ entity, ...boundsOf(entity) }))
  const enclosing = boundsBox(bounds)
  // The subject is what a camera is expected to frame. Environment geometry —
  // a 6 m stage plane under a 20 cm product, for instance — would otherwise make
  // the "scene bounds" say 8 m across, which is true and useless for framing.
  const subject = entities.filter(entity => !(entity.tags ?? []).includes('environment'))
  const subjectBounds = subject.length === 0 ? null : boundsBox(subject.map(entity => ({ entity, ...boundsOf(entity) })))

  return {
    revision: context.revision ?? null,
    revisionNumber: context.revisionNumber ?? null,
    // The digest identifies the DOCUMENT — what is on disk and what a manifest
    // records — so it is taken from the document, not from the resolved projection.
    // For every resolved document the two are the same value; for an older
    // unresolved one, reporting the resolved digest would make a reader compare it
    // against the manifest and conclude the revision was corrupt.
    digest: context.digest ?? sceneSpecDigest(document),
    schemaVersion: spec.schemaVersion,
    project: {
      id: spec.project.id,
      title: spec.project.title,
      goal: spec.project.goal ?? null,
      referenceImages: structuredClone(spec.project.referenceImages ?? []),
      reviewSubjectId: spec.project.reviewSubjectId ?? null,
      fps: spec.project.fps,
      frameStart: spec.project.frameStart,
      frameEnd: spec.project.frameEnd,
      aspectRatio: spec.project.aspectRatio,
      units: spec.project.units ?? 'metric',
      activeCamera: spec.project.activeCamera ?? null,
    },
    counts: {
      assets: (spec.assets ?? []).length,
      entities: entities.length,
      materials: materials.length,
      lights: lights.length,
      cameras: cameras.length,
      shots: shots.length,
      animationTracks: tracks.length,
    },
    entities: entities.map(entity => ({
      id: entity.id,
      type: entity.type,
      shape: entity.generator?.shape ?? null,
      materialId: entity.materialId ?? null,
      ...(entity.materialBindings?.length ? { materialBindings: entity.materialBindings } : {}),
      location: entity.transform.location.map(round4),
      visible: entity.visible !== false,
      locked: entity.locked === true,
      tags: entity.tags ?? [],
    })),
    materials: materials.map(material => ({
      id: material.id,
      shader: material.shader,
      parameters: material.parameters ?? {},
      ...(material.tangent ? { tangent: material.tangent } : {}),
    })),
    lights: lights.map(light => ({
      id: light.id,
      type: light.type,
      energy: light.energy,
      location: light.transform.location.map(round4),
    })),
    cameras: cameras.map(camera => ({
      id: camera.id,
      role: camera.role ?? null,
      lens: camera.lens ?? 50,
      location: camera.transform.location.map(round4),
      rotationEuler: camera.transform.rotationEuler.map(round4),
      targetEntityId: camera.targetEntityId ?? null,
      targetPoint: camera.targetPoint ?? null,
    })),
    shots: shots.map(shot => ({
      id: shot.id,
      cameraId: shot.cameraId,
      frameRange: shot.frameRange ?? [spec.project.frameStart, spec.project.frameEnd],
      description: shot.description ?? null,
    })),
    animationTracks: tracks.map(track => ({
      id: track.id,
      // Only when the document states one. Materialising `targetKind: 'entity'` for a
      // track written before kinds existed would make the summary disagree with the
      // bytes on disk, which is the same trap the world block avoids.
      ...(track.targetKind === undefined ? {} : { targetKind: track.targetKind }),
      targetEntityId: track.targetEntityId,
      property: track.property,
      keyframeCount: track.keyframes.length,
      frameRange: [
        track.keyframes[0]?.frame ?? null,
        track.keyframes[track.keyframes.length - 1]?.frame ?? null,
      ],
    })),
    renderProfiles: spec.renderProfiles,
    // The world the render will actually use, with the schema's defaults filled in
    // for a scene that never stated one. `declared` says whether the author asked
    // for it, because "black because I said so" and "black because that is the
    // default" are different facts about a scene.
    world: {
      declared: spec.world !== undefined,
      color: spec.world?.color ?? DEFAULT_WORLD.color,
      strength: spec.world?.strength ?? DEFAULT_WORLD.strength,
      ...(spec.world?.environment ? { environment: spec.world.environment } : {}),
    },
    bounds: enclosing,
    subjectBounds,
  }
}

/**
 * Analytic bounding box over entities that carry a centre and radius.
 * @param {{ location: number[], radius: number }[]} entries
 * @returns {{ min: number[], max: number[] }}
 */
function boundsBox(entries) {
  return {
    min: [0, 1, 2].map(axis => round4(Math.min(...entries.map(entry => entry.location[axis] - entry.radius)))),
    max: [0, 1, 2].map(axis => round4(Math.max(...entries.map(entry => entry.location[axis] + entry.radius)))),
  }
}

/**
 * Canonical text form of a spec, for on-disk storage and golden comparison.
 * @param {object} spec
 * @returns {string}
 */
export function sceneSpecCanonicalText(spec) {
  return `${JSON.stringify(JSON.parse(canonicalStringify(spec)), null, 2)}\n`
}
