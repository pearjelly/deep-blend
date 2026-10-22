import { BlenderError, BlenderErrorCode } from './index.js'

export const SHOT_CAMERA_SELECTION_VERSION = 'deepblend.shot-camera-selection/v1'
export const SHOT_CAMERA_SELECTION_LIMITS = Object.freeze({ shots: 64, bytes: 8192 })
const id = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(value)
const fail = message => { throw new BlenderError(BlenderErrorCode.SCENE_SPEC_INVALID, `Shot camera selection: ${message}`) }

/** Resolve only a previously normalized selection; never choose a fallback camera. */
export function shotCameraForFrame(selection, frame) {
  if (!Number.isSafeInteger(frame)) fail('requested frames must be integers.')
  const matches = selection.shots.filter(shot => frame >= shot.frameRange[0] && frame <= shot.frameRange[1])
  if (matches.length !== 1) fail(`frame ${frame} must belong to exactly one saved shot, found ${matches.length}.`)
  return { shotId: matches[0].id, cameraId: matches[0].cameraId }
}

/** A small immutable camera/range snapshot, without prompts or arbitrary shot metadata. */
export function normalizeShotCameraSelection(value, frames) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== SHOT_CAMERA_SELECTION_VERSION || value.mode !== 'shots' ||
      Object.keys(value).some(key => !['schemaVersion', 'mode', 'shots'].includes(key)) ||
      !Array.isArray(value.shots) || value.shots.length < 1 || value.shots.length > SHOT_CAMERA_SELECTION_LIMITS.shots) {
    fail('use an explicit saved-shot selection with 1–64 shots.')
  }
  const seen = new Set()
  const shots = value.shots.map(shot => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot) || !id(shot.id) || !id(shot.cameraId) ||
        Object.keys(shot).some(key => !['id', 'cameraId', 'frameRange'].includes(key)) || seen.has(shot.id) ||
        !Array.isArray(shot.frameRange) || shot.frameRange.length !== 2 || !shot.frameRange.every(Number.isSafeInteger) ||
        shot.frameRange[0] > shot.frameRange[1]) fail('each distinct shot needs its saved ID, camera ID and ordered integer frameRange.')
    seen.add(shot.id)
    return { id: shot.id, cameraId: shot.cameraId, frameRange: [...shot.frameRange] }
  }).sort((a, b) => a.frameRange[0] - b.frameRange[0] || a.id.localeCompare(b.id))
  for (let n = 1; n < shots.length; n++) {
    if (shots[n].frameRange[0] <= shots[n - 1].frameRange[1]) fail(`shots ${shots[n - 1].id} and ${shots[n].id} overlap.`)
  }
  const selection = { schemaVersion: SHOT_CAMERA_SELECTION_VERSION, mode: 'shots', shots }
  if (new TextEncoder().encode(JSON.stringify(selection)).byteLength > SHOT_CAMERA_SELECTION_LIMITS.bytes) fail('selection exceeds its 8192-byte metadata budget.')
  if (frames !== undefined) {
    if (!Array.isArray(frames) || !frames.length || frames.length > 100_000 || !frames.every(Number.isSafeInteger)) fail('select 1–100000 integer frames.')
    for (const frame of frames) shotCameraForFrame(selection, frame)
  }
  return selection
}

export function buildShotCameraSelection(spec, frames) {
  if (!Array.isArray(spec?.shots) || spec.shots.some(shot => !shot || typeof shot !== 'object' || Array.isArray(shot))) fail('the saved revision has no valid shot list.')
  const selection = normalizeShotCameraSelection({ schemaVersion: SHOT_CAMERA_SELECTION_VERSION, mode: 'shots',
    shots: spec.shots.map(shot => ({ id: shot.id, cameraId: shot.cameraId, frameRange: shot.frameRange })) }, frames)
  const cameras = new Set((Array.isArray(spec.cameras) ? spec.cameras : []).filter(camera => camera && typeof camera === 'object').map(camera => camera.id))
  for (const shot of selection.shots) if (!cameras.has(shot.cameraId)) fail(`shot ${shot.id} names missing saved camera ${shot.cameraId}.`)
  return selection
}
