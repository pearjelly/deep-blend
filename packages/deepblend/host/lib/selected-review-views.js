import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'

/** Resolve an explicit, bounded inspection of saved cameras without changing them. */
export function selectedReviewPlan(spec, request) {
  const refuse = message => { throw new BlenderError(BlenderErrorCode.SCENE_PATCH_INVALID, message) }
  if (request?.projectId !== spec?.project?.id || !/^r\d{4,}$/.test(request?.revision ?? '')) refuse('Select an explicit saved project revision before reviewing its cameras.')
  if (!Array.isArray(request.views) || request.views.length < 1 || request.views.length > 4) refuse('Choose one through four saved camera/frame pairs for this review.')
  const ids = new Set(), pairs = new Set()
  const views = request.views.map(view => {
    if (!view || typeof view !== 'object' || Array.isArray(view) || Object.keys(view).some(key => !['id', 'cameraId', 'frame'].includes(key))
      || typeof view.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(view.id) || ids.has(view.id)) refuse('Each review view needs a distinct safe identifier and a saved camera/frame pair.')
    if (typeof view.cameraId !== 'string' || !spec.cameras?.some(camera => camera.id === view.cameraId)) {
      throw new BlenderError(BlenderErrorCode.SCENE_CAMERA_MISSING, 'A selected review camera is absent from this saved revision. Choose its saved camera again.')
    }
    if (!Number.isSafeInteger(view.frame) || view.frame < spec.project.frameStart || view.frame > spec.project.frameEnd) refuse('Each review frame must be inside the selected revision’s saved frame range.')
    const pair = JSON.stringify([view.cameraId, view.frame])
    if (pairs.has(pair)) refuse('The same camera/frame pair is already selected for this review.')
    ids.add(view.id); pairs.add(pair)
    return { id: view.id, cameraId: view.cameraId, frame: view.frame, role: 'selected',
      label: view.cameraId, purpose: 'Explicitly selected saved camera and frame; a preview-resolution inspection, not the final output image.' }
  })
  const declared = typeof spec.project.aspectRatio === 'string' ? /^([1-9]\d*):([1-9]\d*)$/.exec(spec.project.aspectRatio) : null
  let ratio = declared ? [Number(declared[1]), Number(declared[2])] : spec.renderProfiles?.preview?.resolution
  if (!Array.isArray(ratio) || ratio.length !== 2 || ratio.some(n => !Number.isSafeInteger(n) || n < 1)) refuse('The saved output aspect cannot be resolved. Save the project aspect before reviewing selected cameras.')
  const gcd = (a, b) => b ? gcd(b, a % b) : a, divisor = gcd(...ratio)
  ratio = ratio.map(n => n / divisor)
  const scale = Math.floor(640 / Math.max(...ratio)), resolution = ratio.map(n => n * scale)
  if (scale < 1 || Math.min(...resolution) < 32) refuse('The saved aspect cannot fit a useful review within the 640-pixel preview budget.')
  return { views, resolution, samples: 16 }
}
