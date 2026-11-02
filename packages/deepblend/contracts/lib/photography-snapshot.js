import { BlenderError, BlenderErrorCode } from './index.js'

export const PHOTOGRAPHY_SNAPSHOT_LIMITS = Object.freeze({ entities: 128, lights: 32 })

const only = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k))
const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
const fail = message => { throw new BlenderError(BlenderErrorCode.SCENE_VALIDATION_FAILED, `Photography snapshot: ${message}`) }

export function validatePhotographySnapshot(selection) {
  if (!only(selection, ['lightIds', 'cameraMustBeStatic']) || typeof selection.cameraMustBeStatic !== 'boolean'
    || !Array.isArray(selection.lightIds) || selection.lightIds.length > PHOTOGRAPHY_SNAPSHOT_LIMITS.lights || new Set(selection.lightIds).size !== selection.lightIds.length
    || selection.lightIds.some(id => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id))) fail('choose at most 32 distinct named lights and an explicit camera-static requirement.')
}

export function verifyPhotographySnapshot(snapshot, selection) {
  validatePhotographySnapshot(selection)
  if (!only(snapshot, ['schemaVersion', 'staticGeometry', 'staticLights', 'cameraStatic', 'cameraRotationEuler', 'lights'])
    || snapshot.schemaVersion !== 'deepblend.photography-snapshot/v1' || snapshot.staticGeometry !== true || snapshot.staticLights !== true
    || typeof snapshot.cameraStatic !== 'boolean' || selection.cameraMustBeStatic && snapshot.cameraStatic !== true
    || !vector(snapshot.cameraRotationEuler) || !Array.isArray(snapshot.lights) || snapshot.lights.length !== selection.lightIds.length) fail('the runtime did not verify the requested static product and lighting snapshot.')
  for (const [index, light] of snapshot.lights.entries()) {
    const sun = light.type === 'sun', spot = light.type === 'spot'
    if (!only(light, ['id', 'type', 'energy', 'color', 'transform', ...(sun ? ['angle'] : ['size']), ...(spot ? ['spotSize', 'spotBlend'] : [])])
      || light.id !== selection.lightIds[index] || !['area', 'point', 'spot', 'sun'].includes(light.type)
      || !Number.isFinite(light.energy) || light.energy < 0 || !vector(light.color) || light.color.some(c => c < 0 || c > 1)
      || !only(light.transform, ['location', 'rotationEuler', 'scale']) || !vector(light.transform.location)
      || !vector(light.transform.rotationEuler) || !vector(light.transform.scale) || light.transform.scale.some(s => s <= 0)
      || (sun ? !Number.isFinite(light.angle) || light.angle < 0 || light.angle > Math.PI : !Number.isFinite(light.size) || light.size <= 0)
      || spot && (!Number.isFinite(light.spotSize) || light.spotSize <= 0 || light.spotSize > Math.PI || !Number.isFinite(light.spotBlend) || light.spotBlend < 0 || light.spotBlend > 1)) fail('a sampled light differs from the requested identity or supported native settings.')
  }
  return snapshot
}
