/** Continue one recognized default hero using an actual Blender vertex/frustum measurement. */
import { BlenderError } from '@deepblend/dsh-blender-contracts'
const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
const near = (a, b) => vector(a) && vector(b) && a.every((value, axis) => Math.abs(value-b[axis]) <= 1e-6)
const refuse = message => { throw new BlenderError('PROTOCOL_VERSION_MISMATCH', `Cannot verify recipe hero framing: ${message}`) }

export function fitCupHeroFromNative(spec, report, selector) {
  if (!selector) return null
  const camera = spec.cameras.find(item => item.id === selector.cameraId)
  const native = report?.cameraFraming
  if (selector.cameraId !== 'hero' || selector.entityId !== 'cup' || selector.margin !== 0.03
      || !camera || !vector(camera.targetPoint) || !vector(camera.transform.location)
      || native?.schemaVersion !== 'deepblend.camera-framing/v1'
      || native.entityId !== selector.entityId || native.cameraId !== selector.cameraId
      || native.margin !== selector.margin || native.cameraType !== 'PERSP'
      || !near(native.cameraLocation, camera.transform.location)
      || !Number.isFinite(native.lens) || Math.abs(native.lens-camera.lens) > 1e-6
      || !Number.isFinite(native.sensorWidth) || Math.abs(native.sensorWidth-(camera.sensorWidth??36)) > 1e-6
      || !Number.isFinite(native.backoffM) || native.backoffM < 0
      || !Number.isInteger(native.vertices) || native.vertices < 1 || native.vertices > 2000000
      || native.scope !== 'evaluated-cup-vertices-at-reported-frame-and-render-aspect'
      || !Number.isInteger(native.frame) || native.frame !== report.renderConfig?.frameStart
      || native.resolutionPercentage !== 100 || !Array.isArray(native.pixelAspect)
      || native.pixelAspect.length !== 2 || !native.pixelAspect.every(value => Number.isFinite(value) && Math.abs(value-1) <= 1e-9)
      || !Number.isFinite(native.nearestDepthM) || native.nearestDepthM <= 0
      || !Number.isFinite(native.farthestDepthM) || native.farthestDepthM < native.nearestDepthM
      || native.nearestDepthM <= (camera.clipping?.[0] ?? 0.1)
      || native.farthestDepthM >= (camera.clipping?.[1] ?? 1000)
      || !Array.isArray(native.resolution) || native.resolution.length !== 2
      || !native.resolution.every((value, axis) => Number.isInteger(value) && value > 0 && value === report.renderConfig?.resolution?.[axis])) refuse('missing or inconsistent measured facts')
  if (spec.animationTracks.some(track => track.targetKind === 'camera' && track.targetEntityId === camera.id)) refuse('animated camera')
  const away = camera.transform.location.map((value, axis) => value-camera.targetPoint[axis])
  const distance = Math.hypot(...away)
  if (!(distance > 0)) refuse('invalid target')
  const location = camera.transform.location.map((value, axis) => value+away[axis]/distance*native.backoffM)
  if (!vector(location)) refuse('non-finite fitted camera')
  return { ...structuredClone(native), location,
    source: 'native-evaluated-vertices-and-blender-camera-frame' }
}
