import { sha256, CAMERA_FIT_LIMITS } from '@deepblend/dsh-blender-contracts'

export const selection = () => ({ entityIds: ['body'], assetInstanceIds: [], frame: 7,
  cameraId: 'hero', fittedCameraId: 'complete-view', margin: .03, checkpointSha256: sha256('source') })
const matrix = location => [[1,0,0,location[0]],[0,1,0,location[1]],[0,0,1,location[2]],[0,0,0,1]]
export function nativeFitReport(input) {
  const optics = { lens: 50, sensorWidth: 36, sensorHeight: 24, sensorFit: 'AUTO', shift: [0,0], clipping: [.01,100], fStop: 8 }
  const camera = { id: input.fittedCameraId, role: 'detail', ...optics,
    transform: { location: [.5,.5,2], rotationEuler: [0,0,0], scale: [1,1,1] }, focusDistance: 2 }
  return { schemaVersion: 'deepblend.camera-fit/v1', ...Object.fromEntries(
    ['entityIds','assetInstanceIds','frame','cameraId','fittedCameraId','margin','checkpointSha256'].map(k=>[k, structuredClone(input[k])])),
  checkpointUnchanged: true, blenderVersion: '5.2.1',
  camera: { id: input.baselineCheckpointPath ? input.fittedCameraId : input.cameraId, ...optics,
    matrixWorld: matrix(camera.transform.location), focusDistance: 2, focusObject: null },
  view: { resolution: [1024,768], percentage: 100, pixelAspect: [1,1], activeCamera: 'db_camera__'+input.cameraId },
  members: input.entityIds.map(entityId => ({ entityId, meshObjectCount: 1, vertexCount: 8,
    worldBoundsMeters: { min: [0,0,0], max: [1,1,1] }, geometrySha256: sha256('geometry-'+entityId),
    projection: { containedInClip: true, nearestDepthMeters: 1, farthestDepthMeters: 2,
      containedInFrame: true, normalizedBounds: { min: [.2,.2], max: [.8,.8] } } })),
  ...(input.baselineCheckpointPath ? { baselineVerification: { checkpointSha256: input.baselineCheckpointSha256,
    checkpointUnchanged: true, selectedGeometryUnchanged: true, originalObjectsUnchanged: true,
    opticsAndRotationPreserved: true, maxVertexErrorMeters: 0, toleranceMeters: CAMERA_FIT_LIMITS.toleranceMeters,
    originalObjectCount: 4 } } : { proposal: camera }) }
}
