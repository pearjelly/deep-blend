/**
 * ScenePatch v1 — validation, and the pure function that applies one.
 *
 * `applyPatchToSpec` MUTATES NOTHING. It copies the parts of the spec a patch
 * touches and returns a new document. That single property is what makes the
 * rest of the revision machinery trustworthy: if validation, compilation or
 * rendering fails at any later point, the previous revision's in-memory spec was
 * never modified, so "失败不污染当前 Revision" (SPEC §13.2) is a structural
 * guarantee rather than something the error path has to remember to undo.
 *
 * Operations are applied in order and atomically: the FIRST failing operation
 * aborts the whole patch and the caller receives an error, never a partial
 * result. A patch that half-applied would be worse than one that failed, because
 * the failure would be invisible in the resulting scene.
 *
 * Owner: DeepBlend Studio — M1
 */

import { compileSchema, formatIssues } from './json-schema.js'
import { collectionForKind, sceneSpecDigest, specHash } from './scene-spec.js'
import scenePatchSchema from './schemas/scene-patch.schema.json' with { type: 'json' }

const validatePatchStructure = compileSchema(scenePatchSchema, { id: 'scene-patch.schema.json' })

/** Operation names in the order they are documented, for stable tool output. */
export const SCENE_OPERATION_NAMES = Object.freeze([
  'entity.transform.update',
  'entity.visibility.set',
  'entity.tags.set',
  'entity.add',
  'entity.remove',
  'entity.material.set',
  'material.add',
  'material.parameter.update',
  'light.add',
  'light.update',
  'light.remove',
  'camera.add',
  'camera.update',
  'camera.remove',
  'animation.track.set',
  'animation.track.remove',
  'shot.set',
  'shot.remove',
  'project.frameRange.set',
  'render.profile.set',
  'world.set',
  'asset.add',
  'asset.remove',
])

/** The `id` grammar shared with SceneSpec. */const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/

/**
 * @typedef {object} PatchIssue
 * @property {string} code
 * @property {string} path
 * @property {string} message
 */

/**
 * Structural validation of a patch document on its own.
 *
 * This is the cheap check the tool layer runs BEFORE touching a project: a
 * syntactically broken patch should be rejected without reading any project
 * state, so a caller cannot use a malformed patch to probe the filesystem.
 *
 * @param {unknown} patch
 * @returns {{ ok: boolean, errors: PatchIssue[], summary: string }}
 */
export function validateScenePatch(patch) {
  /** @type {PatchIssue[]} */
  const errors = []

  const structural = validatePatchStructure(patch)
  for (const issue of structural) {
    errors.push({ code: 'PATCH_SCHEMA_INVALID', path: issue.path, message: `${issue.message} [${issue.keyword}]` })
  }
  if (errors.length > 0) {
    return { ok: false, errors, summary: formatIssues(structural) }
  }

  const document = /** @type {any} */ (patch)

  // NOTE: `baseRevision` needs no semantic check here. The schema's `pattern`
  // already rejects every string `^r[0-9]{4,}$` would, and this function returns
  // early on structural errors — so a second check would be unreachable code that
  // reads like a guarantee. It lived here briefly and was removed for that
  // reason; the rejection is asserted via PATCH_SCHEMA_INVALID[pattern].
  if (typeof document.idempotencyKey === 'string' && document.idempotencyKey.trim().length === 0) {
    errors.push({
      code: 'PATCH_IDEMPOTENCY_KEY_BLANK',
      path: 'idempotencyKey',
      message: 'an idempotency key must not be blank — it is the only thing preventing a retried patch from applying twice',
    })
  }

  document.operations.forEach((operation, position) => {
    const at = `operations[${position}]`
    const op = operation.op

    if (op === 'entity.transform.update') {
      const supplied = ['location', 'rotationEuler', 'scale'].filter(key => operation[key] !== undefined)
      if (supplied.length === 0) {
        errors.push({
          code: 'PATCH_OPERATION_EMPTY',
          path: at,
          message: 'entity.transform.update must supply at least one of location, rotationEuler or scale',
        })
      }
    }
    if (op === 'light.update') {
      const supplied = ['transform', 'energy', 'color', 'size', 'spotSize', 'spotBlend', 'angle']
        .filter(key => operation[key] !== undefined)
      if (supplied.length === 0) {
        errors.push({
          code: 'PATCH_OPERATION_EMPTY',
          path: at,
          message: 'light.update must supply at least one field to change',
        })
      }
    }
    if (op === 'camera.update') {
      // This field list is the THIRD copy of `camera.update`'s vocabulary — the JSON
      // Schema's `$defs.camera` (which `camera.add` uses), the `camera.update` branch's
      // own property list, and here. Adding `role` to the first two and not this one
      // produced a rejection that named the wrong problem ("must supply at least one
      // field to change" for a patch that supplied one) from a copy nobody remembered
      // existed. It is now a named constant that a test asserts against the schema.
      const supplied = CAMERA_UPDATE_FIELDS.filter(key => operation[key] !== undefined)
      if (supplied.length === 0) {
        errors.push({
          code: 'PATCH_OPERATION_EMPTY',
          path: at,
          message: `camera.update must supply at least one field to change: ${CAMERA_UPDATE_FIELDS.join(', ')}`,
        })
      }
      if (operation.targetEntityId !== undefined && operation.targetPoint !== undefined) {
        errors.push({
          code: 'PATCH_CAMERA_TARGET_AMBIGUOUS',
          path: at,
          message: 'camera.update must set either targetEntityId or targetPoint, not both',
        })
      }
    }
    for (const key of ['entityId', 'materialId', 'lightId', 'cameraId', 'trackId', 'shotId']) {
      const value = operation[key]
      if (typeof value === 'string' && !ID_PATTERN.test(value)) {
        errors.push({
          code: 'PATCH_ID_INVALID',
          path: `${at}.${key}`,
          message: `"${value}" is not a valid id (must match ${ID_PATTERN.source})`,
        })
      }
    }
  })

  return { ok: errors.length === 0, errors, summary: errors.length === 0 ? 'valid' : errors.map(entry => `${entry.path}: ${entry.message}`).join('\n') }
}

/**
 * Every field `camera.update` may change.
 *
 * Exported so a test can assert it against the JSON Schema's own property list. Three
 * copies of one vocabulary is two too many, and the failure mode when they disagree is
 * not a crash — it is a rejection that names the wrong problem.
 */
export const CAMERA_UPDATE_FIELDS = Object.freeze([
  'lens', 'sensorWidth', 'clipping', 'transform', 'targetEntityId', 'targetPoint', 'fStop', 'role',
])

/** Build an anchored error for a failed operation. */
function operationError(index, code, message) {
  const error = new Error(`operations[${index}] (${code}): ${message}`)
  // @ts-expect-error - attaching structured detail to a plain Error for the caller.
  error.patchIssue = { code, path: `operations[${index}]`, message }
  return error
}

/**
 * The optional collections, as arrays.
 *
 * EVERY collection except `entities` and `cameras` may be ABSENT rather than empty —
 * `applyPatchToSpec` is careful to keep it that way, because an absent key is a
 * different document from `[]` (see `collection()` below). The cost of that care is
 * that a lookup has to tolerate absence, and MEASURED, it did not:
 *
 *     material.add  on a spec with no Materials -> TypeError: Cannot read
 *     light.add     on a spec with no Lights    ->   properties of undefined
 *     asset.add     on a spec with no Assets    ->   (reading 'findIndex')
 *
 * An uncoded `TypeError` reaching the model is the one failure shape SPEC §9.4 rules
 * out — every refusal is supposed to be a branchable result with a stable code, and a
 * stack trace means "this is a bug". It was a bug, and a reachable one: the minimal
 * scaffold `blender_project_create` starts from declares no lights and no materials, so
 * the FIRST `light.add` on a fresh project hit it.
 *
 * Fixed at the helpers rather than at the three call sites, because the next operation
 * added would otherwise have to remember.
 */
const asCollection = collection => (Array.isArray(collection) ? collection : [])

/** Find an entry by id inside a collection, or `-1`. */
function indexOfId(collection, id) {
  return asCollection(collection).findIndex(entry => entry.id === id)
}

/** Insert or replace by id, keeping the collection sorted by id for a stable diff. */
function upsertById(collection, entry) {
  // Sorted by id, always. Patch operations arrive in whatever order the caller
  // found convenient, and an author-controlled array order would make two
  // documents that describe the same scene serialize differently — which the
  // digest and every golden fixture would then disagree about.
  return [...asCollection(collection).filter(candidate => candidate.id !== entry.id), entry]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** Remove by id. */
function removeById(collection, id) {
  return asCollection(collection).filter(entry => entry.id !== id)
}

/**
 * Assign a collection back, keeping ABSENCE where it belonged.
 *
 * `removeById` on the last entry yields `[]`, and writing that back would turn "this
 * project declares no assets" into "this project declares an empty list of assets" —
 * the distinction `collection()` above exists to preserve, and the one that makes a
 * no-op patch leave the document canonically identical.
 *
 * @param {any} target
 * @param {string} key
 * @param {object[]} remaining
 */
function assignCollection(target, key, remaining) {
  if (remaining.length === 0) delete target[key]
  else target[key] = remaining
}

/**
 * A shallow copy of `object` without `key`.
 *
 * Used where a patch must CLEAR a field that the schema forbids setting to null
 * (an absent key and an explicit null mean different things). The source object
 * is never mutated: `applyPatchToSpec` must leave its input byte-identical, and
 * `delete` on a live object is exactly how that guarantee gets broken.
 */
function withoutKey(object, key) {
  const copy = { ...object }
  delete copy[key]
  return copy
}

/**
 * @typedef {object} AppliedOperation
 * @property {string} op
 * @property {string} target
 * @property {string} summary
 * @property {string[]} changedPaths
 */

/**
 * @typedef {object} ApplyPatchResult
 * @property {object} spec - the new spec. The input spec is untouched.
 * @property {AppliedOperation[]} operations - per-operation audit records.
 * @property {string} digestBefore - scene digest of the input
 * @property {string} digestAfter - scene digest of the output
 * @property {string} specHashBefore - whole-document hash of the input
 * @property {string} specHashAfter - whole-document hash of the output
 */

/**
 * Apply a patch to an ALREADY COMPILED spec (as produced by `compileSceneSpec`,
 * so every default is materialised and no operation has to reason about
 * absent-vs-default).
 *
 * Throws on the first failing operation. The thrown error carries
 * `patchIssue` with a stable `code`, and `spec` is guaranteed unmodified because
 * every branch builds a new array before mutating anything.
 *
 * @param {object} spec
 * @param {object} patch
 * @returns {ApplyPatchResult}
 */
export function applyPatchToSpec(spec, patch) {
  const digestBefore = sceneSpecDigest(spec)
  const specHashBefore = specHash(spec)

  /**
   * A copy of an optional collection, or `undefined` when it holds nothing.
   *
   * PRESERVING ABSENCE IS THE POINT. Materialising `assets: []` for a spec that
   * had no `assets` key is invisible to the scene digest but visible in the
   * stored bytes, so a patch that changed nothing would still rewrite the
   * document and change its `specHash` — breaking the property that a no-op patch
   * leaves the spec canonically identical. It also loses information: an absent
   * key is "this project declares no assets", and `assets: []` is a different
   * document that happens to mean the same thing today.
   */
  const collection = (target, key) => {
    const value = target[key]
    if (value !== undefined && value.length > 0) target[key] = [...value]
  }

  /** @type {any} */
  let next = {
    ...spec,
    entities: [...spec.entities],
    cameras: [...spec.cameras],
    renderProfiles: { ...spec.renderProfiles },
  }
  for (const key of ['assets', 'materials', 'lights', 'shots', 'animationTracks']) {
    collection(next, key)
  }

  /** @type {AppliedOperation[]} */
  const applied = []

  patch.operations.forEach((operation, index) => {
    const op = operation.op
    const fail = (code, message) => { throw operationError(index, code, message) }

    switch (op) {
      // ---- entities -------------------------------------------------------
      case 'entity.transform.update': {
        const at = indexOfId(next.entities, operation.entityId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no entity "${operation.entityId}" exists in this scene`)
        const entity = next.entities[at]
        /** @type {string[]} */
        const changed = []
        /** @type {Record<string, unknown>} */
        const transform = { ...entity.transform }
        for (const component of ['location', 'rotationEuler', 'scale']) {
          if (operation[component] === undefined) continue
          if (operation[component].every((value, axis) => value === entity.transform[component][axis])) continue
          transform[component] = [...operation[component]]
          changed.push(`entities.${entity.id}.transform.${component}`)
        }
        next.entities = [...next.entities]
        next.entities[at] = { ...entity, transform }
        applied.push({
          op,
          target: entity.id,
          summary: changed.length === 0
            ? `entity "${entity.id}" transform already matched the requested values`
            : `updated ${changed.map(path => path.split('.').pop()).join(', ')} of entity "${entity.id}"`,
          changedPaths: changed,
        })
        break
      }

      case 'entity.visibility.set': {
        const at = indexOfId(next.entities, operation.entityId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no entity "${operation.entityId}" exists in this scene`)
        const entity = next.entities[at]
        next.entities = [...next.entities]
        next.entities[at] = { ...entity, visible: operation.visible }
        applied.push({
          op,
          target: entity.id,
          summary: `entity "${entity.id}" is now ${operation.visible ? 'visible' : 'hidden'}`,
          changedPaths: [`entities.${entity.id}.visible`],
        })
        break
      }

      case 'entity.tags.set': {
        const at = indexOfId(next.entities, operation.entityId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no entity "${operation.entityId}" exists in this scene`)
        const entity = next.entities[at]
        const tags = operation.tags
        // Tags are how a scene states intent that geometry cannot, so setting them is a
        // real scene change and not metadata: `environment` decides what may occlude,
        // `hero-product` marks the subject, `subject-part` says an entity is part of the
        // subject's own body. Until this operation existed, the only way to change a tag
        // was to recreate the project — the same gap `role` had for cameras.
        //
        // An EMPTY list removes the key rather than storing `tags: []`. Absent means
        // "this entity declares no intent", and an empty array would be a second way to
        // say the same thing — which is how two documents that mean the same thing end
        // up serializing differently (D21, and the digest that follows from it).
        next.entities = [...next.entities]
        next.entities[at] = tags.length === 0
          ? withoutKey(entity, 'tags')
          : { ...entity, tags: [...tags] }
        const before = Array.isArray(entity.tags) ? entity.tags : []
        applied.push({
          op,
          target: entity.id,
          summary: tags.length === 0
            ? `entity "${entity.id}" no longer declares any tags (was ${before.join(', ') || 'none'})`
            : `entity "${entity.id}" tags are now ${tags.join(', ')}` +
              (before.length > 0 ? ` (were ${before.join(', ')})` : ''),
          changedPaths: [`entities.${entity.id}.tags`],
        })
        break
      }

      case 'entity.add': {
        if (indexOfId(next.entities, operation.entity.id) >= 0) {
          fail('PATCH_TARGET_EXISTS', `entity "${operation.entity.id}" already exists; use entity.transform.update instead`)
        }
        const entity = operation.entity
        if (entity.assetId !== undefined && indexOfId(next.assets, entity.assetId) < 0) {
          fail('PATCH_REFERENCE_MISSING', `entity "${entity.id}" references asset "${entity.assetId}", which this scene does not declare`)
        }
        if (entity.materialId !== undefined && indexOfId(next.materials, entity.materialId) < 0) {
          fail('PATCH_REFERENCE_MISSING', `entity "${entity.id}" references material "${entity.materialId}", which this scene does not declare`)
        }
        next.entities = upsertById(next.entities, entity)
        applied.push({
          op,
          target: entity.id,
          summary: `added ${entity.type} entity "${entity.id}"`,
          changedPaths: [`entities.${entity.id}`],
        })
        break
      }

      case 'entity.remove': {
        if (indexOfId(next.entities, operation.entityId) < 0) {
          fail('PATCH_TARGET_MISSING', `no entity "${operation.entityId}" exists in this scene`)
        }
        const dependents = []
        if (next.cameras.some(camera => camera.targetEntityId === operation.entityId)) {
          dependents.push('camera target')
        }
        if (next.animationTracks.some(track => track.targetEntityId === operation.entityId)) {
          dependents.push('animation track')
        }
        if (dependents.length > 0) {
          fail(
            'PATCH_TARGET_IN_USE',
            `entity "${operation.entityId}" is still referenced by ${dependents.join(' and ')}; ` +
              'remove or re-point those in the same patch, before this operation',
          )
        }
        next.entities = removeById(next.entities, operation.entityId)
        applied.push({
          op,
          target: operation.entityId,
          summary: `removed entity "${operation.entityId}"`,
          changedPaths: [`entities.${operation.entityId}`],
        })
        break
      }

      case 'entity.material.set': {
        const at = indexOfId(next.entities, operation.entityId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no entity "${operation.entityId}" exists in this scene`)
        if (operation.materialId !== null && indexOfId(next.materials, operation.materialId) < 0) {
          fail('PATCH_REFERENCE_MISSING', `material "${operation.materialId}" is not declared in this scene`)
        }
        const entity = next.entities[at]
        next.entities = [...next.entities]
        if (operation.materialId === null) {
          const { materialId, ...rest } = entity
          next.entities[at] = rest
        } else {
          next.entities[at] = { ...entity, materialId: operation.materialId }
        }
        applied.push({
          op,
          target: entity.id,
          summary: operation.materialId === null
            ? `entity "${entity.id}" now uses the default material`
            : `entity "${entity.id}" now uses material "${operation.materialId}"`,
          changedPaths: [`entities.${entity.id}.materialId`],
        })
        break
      }

      // ---- materials ------------------------------------------------------
      case 'material.add': {
        if (indexOfId(next.materials, operation.material.id) >= 0) {
          fail('PATCH_TARGET_EXISTS', `material "${operation.material.id}" already exists; use material.parameter.update instead`)
        }
        next.materials = upsertById(next.materials, {
          shader: 'principled',
          parameters: {},
          ...operation.material,
        })
        applied.push({
          op,
          target: operation.material.id,
          summary: `added ${operation.material.shader} material "${operation.material.id}"`,
          changedPaths: [`materials.${operation.material.id}`],
        })
        break
      }

      case 'material.parameter.update': {
        const at = indexOfId(next.materials, operation.materialId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no material "${operation.materialId}" exists in this scene`)
        const material = next.materials[at]
        const previous = material.parameters?.[operation.parameter]
        next.materials = [...next.materials]
        next.materials[at] = {
          ...material,
          parameters: { ...material.parameters, [operation.parameter]: operation.value },
        }
        applied.push({
          op,
          target: material.id,
          summary: `material "${material.id}" ${operation.parameter}: ${
            previous === undefined ? '(default)' : JSON.stringify(previous)
          } → ${JSON.stringify(operation.value)}`,
          changedPaths: [`materials.${material.id}.parameters.${operation.parameter}`],
        })
        break
      }

      // ---- lights ---------------------------------------------------------
      case 'light.add': {
        if (indexOfId(next.lights, operation.light.id) >= 0) {
          fail('PATCH_TARGET_EXISTS', `light "${operation.light.id}" already exists; use light.update instead`)
        }
        next.lights = upsertById(next.lights, operation.light)
        applied.push({
          op,
          target: operation.light.id,
          summary: `added ${operation.light.type} light "${operation.light.id}"`,
          changedPaths: [`lights.${operation.light.id}`],
        })
        break
      }

      case 'light.update': {
        const at = indexOfId(next.lights, operation.lightId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no light "${operation.lightId}" exists in this scene`)
        const light = next.lights[at]
        const { op: _op, lightId: _lightId, transform, ...scalars } = operation
        /** @type {Record<string, unknown>} */
        const patchFields = {}
        for (const [key, value] of Object.entries(scalars)) {
          if (value === undefined) continue
          patchFields[key] = value
        }
        if (transform !== undefined) {
          patchFields.transform = {
            ...light.transform,
            ...Object.fromEntries(Object.entries(transform).filter(([, value]) => value !== undefined)),
          }
        }
        next.lights = [...next.lights]
        next.lights[at] = { ...light, ...patchFields }
        applied.push({
          op,
          target: light.id,
          summary: `updated light "${light.id}": ${Object.keys(patchFields).join(', ')}`,
          changedPaths: Object.keys(patchFields).map(key => `lights.${light.id}.${key}`),
        })
        break
      }

      case 'light.remove': {
        if (indexOfId(next.lights, operation.lightId) < 0) {
          fail('PATCH_TARGET_MISSING', `no light "${operation.lightId}" exists in this scene`)
        }
        next.lights = removeById(next.lights, operation.lightId)
        applied.push({
          op,
          target: operation.lightId,
          summary: `removed light "${operation.lightId}"`,
          changedPaths: [`lights.${operation.lightId}`],
        })
        break
      }

      // ---- cameras --------------------------------------------------------
      case 'camera.add': {
        if (indexOfId(next.cameras, operation.camera.id) >= 0) {
          fail('PATCH_TARGET_EXISTS', `camera "${operation.camera.id}" already exists; use camera.update instead`)
        }
        if (operation.camera.targetEntityId !== undefined
          && indexOfId(next.entities, operation.camera.targetEntityId) < 0) {
          fail('PATCH_REFERENCE_MISSING', `camera "${operation.camera.id}" targets entity "${operation.camera.targetEntityId}", which does not exist`)
        }
        next.cameras = upsertById(next.cameras, operation.camera)
        applied.push({
          op,
          target: operation.camera.id,
          summary: `added camera "${operation.camera.id}"`,
          changedPaths: [`cameras.${operation.camera.id}`],
        })
        break
      }

      case 'camera.update': {
        const at = indexOfId(next.cameras, operation.cameraId)
        if (at < 0) fail('PATCH_TARGET_MISSING', `no camera "${operation.cameraId}" exists in this scene`)
        if (operation.targetEntityId !== undefined
          && indexOfId(next.entities, operation.targetEntityId) < 0) {
          fail('PATCH_REFERENCE_MISSING', `camera "${operation.cameraId}" targets entity "${operation.targetEntityId}", which does not exist`)
        }
        const camera = next.cameras[at]
        const { op: _op, cameraId: _cameraId, transform, ...scalars } = operation
        /** @type {Record<string, unknown>} */
        const patchFields = {}
        for (const [key, value] of Object.entries(scalars)) {
          if (value === undefined) continue
          patchFields[key] = value
        }
        if (transform !== undefined) {
          patchFields.transform = {
            ...camera.transform,
            ...Object.fromEntries(Object.entries(transform).filter(([, value]) => value !== undefined)),
          }
        }
        // Switching aim source must not leave the other one behind: a camera
        // carrying both a target entity and a target point is rejected by
        // SceneSpec validation (SCENE_CAMERA_TARGET_AMBIGUOUS). Clearing the old
        // key therefore has to happen on the CAMERA.
        //
        // It previously deleted from `patchFields`, which can never hold the key
        // being cleared — validateScenePatch rejects one operation that supplies
        // both — so the deletion was a no-op and a successfully-applied patch
        // produced a document that then FAILED SceneSpec validation. There is a
        // red regression test for this in scene-patch.test.mjs.
        const clearedAim = operation.targetEntityId !== undefined
          ? 'targetPoint'
          : operation.targetPoint !== undefined ? 'targetEntityId' : null
        const mergedAim = clearedAim === null ? camera : withoutKey(camera, clearedAim)
        next.cameras = [...next.cameras]
        next.cameras[at] = { ...mergedAim, ...patchFields }
        applied.push({
          op,
          target: camera.id,
          summary: `updated camera "${camera.id}": ${Object.keys(patchFields).join(', ')}` +
            (clearedAim === null ? '' : `, cleared ${clearedAim}`),
          changedPaths: [
            ...Object.keys(patchFields).map(key => `cameras.${camera.id}.${key}`),
            ...clearedAim === null ? [] : [`cameras.${camera.id}.${clearedAim}`],
          ],
        })
        break
      }

      case 'camera.remove': {
        if (indexOfId(next.cameras, operation.cameraId) < 0) {
          fail('PATCH_TARGET_MISSING', `no camera "${operation.cameraId}" exists in this scene`)
        }
        const usingShot = next.shots.find(shot => shot.cameraId === operation.cameraId)
        if (usingShot !== undefined) {
          fail(
            'PATCH_TARGET_IN_USE',
            `camera "${operation.cameraId}" is used by shot "${usingShot.id}"; remove that shot in the same patch, before this operation`,
          )
        }
        next.cameras = removeById(next.cameras, operation.cameraId)
        applied.push({
          op,
          target: operation.cameraId,
          summary: `removed camera "${operation.cameraId}"`,
          changedPaths: [`cameras.${operation.cameraId}`],
        })
        break
      }

      // ---- animation ------------------------------------------------------
      case 'animation.track.set': {
        // The target's collection comes from `targetKind`, and this is the SECOND
        // place that has to know the rule — `validateSceneSpec` is the other, and
        // the compiler is the third. They disagreed the moment kinds existed: the
        // schema accepted a camera track and this branch still resolved it against
        // `entities`, so a legal patch was refused with a message about a missing
        // entity. Resolution goes through one helper for exactly that reason.
        const kind = operation.track.targetKind ?? 'entity'
        if (indexOfId(collectionForKind(next, kind), operation.track.targetEntityId) < 0) {
          fail(
            'PATCH_REFERENCE_MISSING',
            `animation track "${operation.track.id}" targets ${kind} "${operation.track.targetEntityId}", which does not exist`,
          )
        }
        const replacing = indexOfId(next.animationTracks, operation.track.id) >= 0
        next.animationTracks = upsertById(next.animationTracks, operation.track)
        applied.push({
          op,
          target: operation.track.id,
          summary: `${replacing ? 'replaced' : 'added'} animation track "${operation.track.id}" ` +
            `(${kind} ${operation.track.targetEntityId}, ${operation.track.property}, ` +
            `${operation.track.keyframes.length} keyframes)`,
          changedPaths: [`animationTracks.${operation.track.id}`],
        })
        break
      }

      case 'animation.track.remove': {
        if (indexOfId(next.animationTracks, operation.trackId) < 0) {
          fail('PATCH_TARGET_MISSING', `no animation track "${operation.trackId}" exists in this scene`)
        }
        next.animationTracks = removeById(next.animationTracks, operation.trackId)
        applied.push({
          op,
          target: operation.trackId,
          summary: `removed animation track "${operation.trackId}"`,
          changedPaths: [`animationTracks.${operation.trackId}`],
        })
        break
      }

      // ---- shots ----------------------------------------------------------
      case 'shot.set': {
        if (indexOfId(next.cameras, operation.shot.cameraId) < 0) {
          fail('PATCH_REFERENCE_MISSING', `shot "${operation.shot.id}" uses camera "${operation.shot.cameraId}", which does not exist`)
        }
        const replacing = indexOfId(next.shots, operation.shot.id) >= 0
        next.shots = upsertById(next.shots, operation.shot)
        applied.push({
          op,
          target: operation.shot.id,
          summary: `${replacing ? 'replaced' : 'added'} shot "${operation.shot.id}" on camera "${operation.shot.cameraId}"`,
          changedPaths: [`shots.${operation.shot.id}`],
        })
        break
      }

      case 'shot.remove': {
        if (indexOfId(next.shots, operation.shotId) < 0) {
          fail('PATCH_TARGET_MISSING', `no shot "${operation.shotId}" exists in this scene`)
        }
        next.shots = removeById(next.shots, operation.shotId)
        applied.push({
          op,
          target: operation.shotId,
          summary: `removed shot "${operation.shotId}"`,
          changedPaths: [`shots.${operation.shotId}`],
        })
        break
      }

      // ---- project and profiles -------------------------------------------
      case 'project.frameRange.set': {
        if (operation.frameEnd <= operation.frameStart) {
          fail('PATCH_FRAME_RANGE_INVALID', `frameEnd (${operation.frameEnd}) must be greater than frameStart (${operation.frameStart})`)
        }
        /** @type {Record<string, unknown>} */
        const nextProject = { ...next.project, frameStart: operation.frameStart, frameEnd: operation.frameEnd }
        if (operation.fps !== undefined) nextProject.fps = operation.fps
        const changed = [
          `project.frameStart: ${next.project.frameStart} → ${operation.frameStart}`,
          `project.frameEnd: ${next.project.frameEnd} → ${operation.frameEnd}`,
        ]
        next = { ...next, project: nextProject }
        applied.push({
          op,
          target: next.project.id,
          summary: changed.join(', '),
          changedPaths: ['project.frameStart', 'project.frameEnd'],
        })
        break
      }

      case 'render.profile.set': {
        const existing = next.renderProfiles[operation.profileName]
        // A render profile is a COST DECLARATION, and `resolution` is the part of
        // it that decides how much a render costs. So it is never half-changed:
        // the incoming resolution replaces the existing one outright, and a patch
        // that omits it keeps the existing one rather than deleting it.
        //
        // Both of the previous behaviours here were wrong. Assigning
        // `operation.profile.resolution` unconditionally left an own key set to
        // `undefined`, which passes as "success" and then fails SceneSpec
        // validation (resolution is required). And defining a NEW profile without
        // a resolution threw a bare TypeError while formatting the summary, which
        // the tool layer could not map to a stable error code.
        const resolution = operation.profile.resolution ?? existing?.resolution
        if (resolution === undefined) {
          fail(
            'PATCH_PROFILE_UNRESOLVED_RESOLUTION',
            `render.profile.set for "${operation.profileName}" supplies no resolution and there is no ` +
              'existing profile to inherit one from; a render profile must state its resolution because ' +
              'resolution is what decides the render cost',
          )
        }
        const merged = { ...existing, ...operation.profile, resolution }
        next.renderProfiles = { ...next.renderProfiles, [operation.profileName]: merged }
        applied.push({
          op,
          target: operation.profileName,
          summary: existing === undefined
            ? `defined the ${operation.profileName} render profile (${merged.engine}, ${resolution.join('x')}` +
              `${merged.samples === undefined ? '' : `, ${merged.samples} samples`})`
            : `updated the ${operation.profileName} render profile` +
              `${operation.profile.resolution === undefined ? ' (kept its resolution)' : ` (${resolution.join('x')})`}`,
          changedPaths: [`renderProfiles.${operation.profileName}`],
        })
        break
      }

      case 'world.set': {
        // The world REPLACES rather than merges, matching how a caller thinks about
        // "make the background black": a half-updated world is how the hidden grey
        // constant survived this long in the first place.
        const previous = next.world
        next.world = { ...operation.world }
        applied.push({
          op,
          target: 'world',
          summary: previous === undefined
            ? `set the scene world (color ${JSON.stringify(next.world.color)}, strength ${next.world.strength ?? 'default'})`
            : 'replaced the scene world',
          changedPaths: ['world'],
        })
        break
      }

      // ---- assets ---------------------------------------------------------
      //
      // WHY THESE TWO EXIST. `assets` has been part of the SceneSpec since M1 —
      // validated, digest-stable, compiled by the right importer per type — and there
      // was no way to ADD one after the project was created. A spec could carry assets
      // only if the document that created the project already had them, so
      // `blender_asset_ingest` would have had nothing to attach its result to. The
      // vocabulary and the producer are one feature, and this is the half that was
      // missing.
      case 'asset.add': {
        if (indexOfId(next.assets, operation.asset.id) >= 0) {
          fail('PATCH_TARGET_EXISTS', `asset "${operation.asset.id}" already exists in this scene`)
        }
        // The path guard lives in the SceneSpec's semantic validator and runs again on
        // the committed document, but a patch that would be refused there is refused
        // HERE with a patch code, so the caller learns which operation was wrong
        // instead of getting a whole-document verdict.
        const assetPath = operation.asset.path
        if (assetPath.startsWith('/') || assetPath.split('/').includes('..')) {
          fail(
            'PATCH_OPERATION_INVALID',
            `asset "${operation.asset.id}" names the path "${assetPath}"; asset paths are relative to the ` +
              'project root and may not contain ".." (SPEC §15.2)',
          )
        }
        next.assets = upsertById(next.assets, { ...operation.asset })
        applied.push({
          op,
          target: operation.asset.id,
          summary: `added ${operation.asset.type} asset "${operation.asset.id}" at ${assetPath}`,
          changedPaths: [`assets.${operation.asset.id}`],
        })
        break
      }

      case 'asset.remove': {
        if (indexOfId(next.assets, operation.assetId) < 0) {
          fail('PATCH_TARGET_MISSING', `no asset "${operation.assetId}" exists in this scene`)
        }
        // The rule `entity.remove` follows, for the same reason: an entity that
        // instantiates this asset would be left pointing at nothing, and the compiler
        // would then refuse a scene the patch claimed to have produced.
        const dependents = next.entities.filter(entity => entity.assetId === operation.assetId)
        if (dependents.length > 0) {
          fail(
            'PATCH_TARGET_IN_USE',
            `asset "${operation.assetId}" is still instantiated by ${dependents.map(entity => `"${entity.id}"`).join(', ')}; ` +
              'remove those entities in the same patch, before this operation',
          )
        }
        assignCollection(next, 'assets', removeById(next.assets, operation.assetId))
        applied.push({
          op,
          target: operation.assetId,
          summary: `removed asset "${operation.assetId}"`,
          changedPaths: [`assets.${operation.assetId}`],
        })
        break
      }

      default:
        fail('PATCH_OPERATION_UNKNOWN', `"${op}" is not a ScenePatch v1 operation`)
    }
  })

  return {
    spec: next,
    operations: applied,
    digestBefore,
    digestAfter: sceneSpecDigest(next),
    specHashBefore,
    specHashAfter: specHash(next),
  }
}

/**
 * The `operation-manifest.json` written beside every revision (SPEC §8.4).
 *
 * @param {object} input
 * @param {AppliedOperation[]} input.operations
 * @param {object} input.request - the accepted patch, recorded verbatim.
 * @param {{ revision: string, baseRevision: string, digestBefore: string, digestAfter: string,
 *           specHashBefore?: string, specHashAfter?: string }} input.revision
 * @param {import('./scene-spec.js').SceneSpecIssue[]} input.notices
 * @returns {Record<string, unknown>}
 */
export function buildOperationManifest({ operations, request, revision, notices }) {
  return {
    schemaVersion: 'deepblend.operation-manifest/v1',
    revision: revision.revision,
    baseRevision: revision.baseRevision,
    digestBefore: revision.digestBefore,
    digestAfter: revision.digestAfter,
    specHashBefore: revision.specHashBefore ?? null,
    specHashAfter: revision.specHashAfter ?? null,
    // Two different questions, two different answers. `sceneChanged` excludes
    // project.title/goal by design (see sceneSpecDigest); `specChanged` covers the
    // whole document, so the frame range counts.
    sceneChanged: revision.digestBefore !== revision.digestAfter,
    specChanged: (revision.specHashBefore ?? null) !== null
      && revision.specHashBefore !== revision.specHashAfter,
    idempotencyKey: request.idempotencyKey,
    actor: request.actor ?? null,
    stage: request.stage ?? null,
    note: request.note ?? null,
    savedCheckpoint: request.saveCheckpoint !== false,
    renderedPreview: request.renderPreview === true,
    operationCount: operations.length,
    operations,
    notices,
  }
}
