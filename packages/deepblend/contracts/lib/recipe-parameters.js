/** Plan existing-assembly edits as ordinary, bounded ScenePatch operations. */
import { canonicalStringify, sha256Canonical } from './canonical.js'
import { instantiateRecipeLock, RecipeError } from './recipe.js'
import { validateSceneSpec } from './scene-spec.js'

const axisOf = binding => ['x', 'y', 'z'].indexOf(binding.axis)
const structural = parameter => parameter.bindings.some(binding => binding.kind === 'entity')
  && parameter.bindings.every(binding => ['entity', 'camera'].includes(binding.kind))
const entity = (spec, id) => spec.entities.find(item => item.id === id)
const vector = (target, property) => property === 'dimensions' ? target?.generator?.dimensions
  : property === 'targetPoint' ? target?.targetPoint : target?.transform?.location
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))

export function recipeGeometryParameters(manifest) {
  return manifest.parameters.filter(structural)
}

export function planRecipeGeometryEdit(lock, currentSpec, parameterState, changes) {
  const origin = instantiateRecipeLock(lock)
  const scene = validateSceneSpec(currentSpec)
  if (!scene.ok) throw new RecipeError('RECIPE_SCENE_INVALID', scene.summary, { errors: scene.errors })
  let currentLock = lock
  if (parameterState !== undefined) {
    if (parameterState?.schemaVersion !== 'deepblend.recipe-parameters/v1'
        || parameterState.manifestSha256 !== lock.manifestSha256) {
      throw new RecipeError('RECIPE_LOCK_INVALID', 'Parameter state belongs to a different recipe')
    }
    currentLock = { ...lock, values: parameterState.values, valuesSha256: parameterState.valuesSha256 }
  }
  const before = parameterState === undefined ? origin : instantiateRecipeLock(currentLock)
  const after = instantiateRecipeLock(currentLock, changes)
  const parameters = recipeGeometryParameters(lock.manifest)
  for (const id of Object.keys(changes)) {
    if (!parameters.some(parameter => parameter.id === id)) {
      throw new RecipeError('RECIPE_PARAMETER_INVALID', `Parameter ${id} is not an assembly geometry control`)
    }
  }
  const conflicts = []
  for (const parameter of parameters) for (const binding of parameter.bindings) {
    if (binding.kind !== 'entity') continue
    const expected = vector(entity(before.spec, binding.entityId), binding.property)?.[axisOf(binding)]
    const actual = vector(entity(currentSpec, binding.entityId), binding.property)?.[axisOf(binding)]
    if (!close(actual, expected)) conflicts.push({ parameterId: parameter.id, entityId: binding.entityId,
      property: binding.property, axis: binding.axis, expected, actual })
    if (binding.property === 'dimensions') {
      const oldScale = entity(before.spec, binding.entityId).transform.scale
      const scale = entity(currentSpec, binding.entityId)?.transform.scale
      if (!scale?.every((value, axis) => close(value, oldScale[axis]))) {
        conflicts.push({ parameterId: parameter.id, entityId: binding.entityId,
          property: 'scale', expected: oldScale, actual: scale })
      }
    }
  }
  if (conflicts.length) throw new RecipeError('RECIPE_PARAMETER_CONFLICT',
    'Recipe-controlled geometry was independently edited; resolve these fields before resizing', { conflicts })

  const changed = parameters.filter(parameter => before.values[parameter.id] !== after.values[parameter.id])
  const generators = new Map(), locations = new Map(), cameras = new Map(), tracks = new Map(), animationOffsets = new Map()
  const protectedCameras = new Set()
  for (const parameter of changed) for (const binding of parameter.bindings) {
    const axis = axisOf(binding)
    if (binding.kind === 'camera') {
      const actual = currentSpec.cameras?.find(item => item.id === binding.cameraId)
      const original = before.spec.cameras?.find(item => item.id === binding.cameraId)
      // Independently authored photography remains intact, including deleted cameras.
      if (!actual || canonicalStringify(actual) !== canonicalStringify(original)) {
        protectedCameras.add(binding.cameraId); continue
      }
      if (!cameras.has(binding.cameraId)) cameras.set(binding.cameraId, { op: 'camera.update', cameraId: binding.cameraId })
      const operation = cameras.get(binding.cameraId)
      const target = after.spec.cameras.find(item => item.id === binding.cameraId)
      if (binding.property === 'targetPoint') operation.targetPoint = structuredClone(target.targetPoint)
      else operation.transform = { location: structuredClone(target.transform.location) }
      continue
    }
    const actual = entity(currentSpec, binding.entityId), target = entity(after.spec, binding.entityId)
    if (binding.property === 'dimensions') {
      if (!generators.has(actual.id)) generators.set(actual.id, structuredClone(actual.generator))
      generators.get(actual.id).dimensions[axis] = target.generator.dimensions[axis]
    } else {
      if (!locations.has(actual.id)) locations.set(actual.id, structuredClone(actual.transform.location))
      const delta = target.transform.location[axis] - entity(before.spec, actual.id).transform.location[axis]
      locations.get(actual.id)[axis] = target.transform.location[axis]
      if (binding.offsetAnimation === true) animationOffsets.set(`${actual.id}:${binding.axis}`, {
        entityId: actual.id, property: `location.${binding.axis}`, delta,
      })
    }
  }
  for (const offset of animationOffsets.values()) for (const track of currentSpec.animationTracks ?? []) {
    if ((track.targetKind ?? 'entity') !== 'entity' || track.targetEntityId !== offset.entityId
        || track.property !== offset.property) continue
    if (!tracks.has(track.id)) tracks.set(track.id, structuredClone(track))
    for (const keyframe of tracks.get(track.id).keyframes) keyframe.value += offset.delta
  }
  const operations = [
    ...[...generators].map(([entityId, generator]) => ({ op: 'entity.generator.set', entityId, generator })),
    ...[...locations].map(([entityId, location]) => ({ op: 'entity.transform.update', entityId, location })),
    ...cameras.values(),
    ...[...tracks.values()].map(track => ({ op: 'animation.track.set', track })),
  ]
  return { operations, changedParameters: changed.map(parameter => parameter.id),
    preservedCameraIds: [...protectedCameras], parameterState: {
      schemaVersion: 'deepblend.recipe-parameters/v1', manifestSha256: lock.manifestSha256,
      values: after.values, valuesSha256: sha256Canonical(after.values),
    } }
}
