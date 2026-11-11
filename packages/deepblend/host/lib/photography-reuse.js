import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BlenderError, BlenderErrorCode, compileSceneSpec, sceneSpecDigest, sha256Canonical,
  verifyCameraFitReport } from '@deepblend/dsh-blender-contracts'
import { protectPlacementSource } from './surface-placement.js'
import { fileSha256, removeTree, resolveInside } from './paths.js'

const fail = (message, code = BlenderErrorCode.SCENE_PATCH_INVALID) => { throw new BlenderError(code, `Photography reuse: ${message}`) }
const only = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k))
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const ids = v => Array.isArray(v) && v.length >= 1 && v.length <= 128 && new Set(v).size === v.length
  && v.every(id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id))
const revision = v => typeof v === 'string' && /^r\d{4,}$/.test(v)

export function normalizePhotographyReuseRequest(request) {
  if (!only(request, ['projectId', 'baseRevision', 'expectedDigest', 'expectedStoreIdentity', 'cameraId', 'frame', 'entityIds', 'source', 'signal'])
    || typeof request.projectId !== 'string' || !request.projectId || !revision(request.baseRevision)
    || !hash(request.expectedDigest) || !hash(request.expectedStoreIdentity) || !ids(request.entityIds)
    || typeof request.cameraId !== 'string' || !request.cameraId || !Number.isSafeInteger(request.frame)
    || !only(request.source, ['projectId', 'revision', 'digest', 'cameraId', 'frame', 'entityIds'])
    || typeof request.source.projectId !== 'string' || !request.source.projectId || !revision(request.source.revision)
    || !hash(request.source.digest) || !ids(request.source.entityIds) || typeof request.source.cameraId !== 'string'
    || !request.source.cameraId || !Number.isSafeInteger(request.source.frame)) fail('choose two explicit saved sources, their complete product members, cameras and integer frames.')
  const { signal, ...input } = request
  return { ...structuredClone(input), entityIds: [...input.entityIds].sort(),
    source: { ...structuredClone(input.source), entityIds: [...input.source.entityIds].sort() } }
}

function boundsOf(members) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const m of members) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], m.worldBoundsMeters.min[i]); max[i] = Math.max(max[i], m.worldBoundsMeters.max[i])
  }
  const diagonal = Math.hypot(...max.map((v, i) => v - min[i])), center = min.map((v, i) => (v + max[i]) / 2)
  if (!Number.isFinite(diagonal) || diagonal < 1e-6) fail('the selected product has no useful finite native extent.')
  return { min, max, center, diagonal }
}

/** A single uniform rig transform; it does not promise matching framing or appearance. */
export function adaptPhotographyRig(sourceReport, destinationReport, destinationSpec, cameraId) {
  const sourceBounds = boundsOf(sourceReport.members), targetBounds = boundsOf(destinationReport.members)
  const scale = targetBounds.diagonal / sourceBounds.diagonal
  if (!Number.isFinite(scale) || scale < .001 || scale > 1000) fail('the product scale ratio exceeds the supported 0.001–1000 range; confirm model units first.')
  const map = point => point.map((v, i) => targetBounds.center[i] + scale * (v - sourceBounds.center[i]))
  const targetCamera = destinationSpec.cameras.find(c => c.id === cameraId)
  if (!targetCamera) fail('the saved destination camera is missing.', BlenderErrorCode.SCENE_CAMERA_MISSING)
  const camera = structuredClone(targetCamera), sourcePosition = sourceReport.camera.matrixWorld.slice(0, 3).map(row => row[3])
  camera.lens = sourceReport.camera.lens
  camera.transform = { ...camera.transform, location: map(sourcePosition), rotationEuler: [...sourceReport.photography.cameraRotationEuler] }
  delete camera.targetEntityId; delete camera.targetPoint
  if (targetCamera.fStop !== undefined) {
    const forward = sourceReport.camera.matrixWorld.slice(0, 3).map(row => -row[2])
    const depth = sourceBounds.center.reduce((sum, v, i) => sum + (v - sourcePosition[i]) * forward[i], 0) * scale
    if (!Number.isFinite(depth) || depth <= 1e-6) fail('the source camera does not face the selected product; choose a useful source view.')
    camera.focusDistance = depth
  }
  const forward = sourceReport.camera.matrixWorld.slice(0, 3).map(row => -row[2])
  const clipping = destinationReport.camera.clipping
  for (let bits = 0; bits < 8; bits++) {
    const point = targetBounds.min.map((v, i) => bits & (1 << i) ? targetBounds.max[i] : v)
    const depth = point.reduce((sum, v, i) => sum + (v - camera.transform.location[i]) * forward[i], 0)
    if (depth < clipping[0] - 1e-6 || depth > clipping[1] + 1e-6) fail('the adapted product bounds exceed the destination camera clipping; confirm units or choose another camera.', BlenderErrorCode.UNSUPPORTED_ACTION)
  }
  const lights = sourceReport.photography.lights.map(light => ({ ...structuredClone(light),
    transform: { ...structuredClone(light.transform), location: map(light.transform.location) },
    ...(light.type === 'sun' ? {} : { size: light.size * scale, energy: light.energy * scale * scale }) }))
  const candidate = structuredClone(destinationSpec)
  candidate.cameras[candidate.cameras.findIndex(c => c.id === cameraId)] = camera
  candidate.lights = lights
  // Includes overflow, references and schema validation without publishing a revision.
  compileSceneSpec(candidate)
  return { camera, lights, scale, sourceBounds, targetBounds }
}

/** Read two immutable native snapshots and return a reviewable photography draft. */
export async function planPhotographyReuse(host, request) {
  const input = normalizePhotographyReuseRequest(request), signal = request.signal
  const cancelled = () => { if (signal?.aborted) fail('cancelled; no saved scene was changed.', BlenderErrorCode.ABORTED) }
  cancelled()
  const verifyCurrent = () => {
    cancelled()
    if (host.editableSnapshots.storeIdentity !== input.expectedStoreIdentity
      || host.store.readRecord(input.projectId).currentRevision !== input.baseRevision) fail('the destination store or current revision changed; refresh the saved work.', BlenderErrorCode.REVISION_CONFLICT)
  }
  verifyCurrent()
  if (typeof host.runtime?.inspectCameraFit !== 'function') fail('the current runtime cannot read a bounded native photography snapshot.', BlenderErrorCode.RUNTIME_UNAVAILABLE)
  const destinationSpec = host.store.readRevisionSpec(input.projectId, input.baseRevision)
  const sourceSpec = host.store.readRevisionSpec(input.source.projectId, input.source.revision)
  if (sceneSpecDigest(destinationSpec) !== input.expectedDigest || sceneSpecDigest(sourceSpec) !== input.source.digest) fail('a selected saved scene no longer matches its digest.', BlenderErrorCode.REVISION_CONFLICT)
  for (const [spec, selection] of [[destinationSpec, input], [sourceSpec, input.source]]) {
    if (!spec.cameras.some(c => c.id === selection.cameraId)) fail('a selected camera is missing.', BlenderErrorCode.SCENE_CAMERA_MISSING)
    if (selection.frame < spec.project.frameStart || selection.frame > spec.project.frameEnd) fail('a selected frame is outside its saved project range.')
    if (selection.entityIds.some(id => !spec.entities.some(e => e.id === id && ['generator', 'asset-instance'].includes(e.type) && e.visible !== false))) fail('select visible saved mesh entities or complete asset instances.')
    if (selection.entityIds.some(id => {
      const entity = spec.entities.find(e => e.id === id)
      return ['armatureId', 'rigidBody', 'cloth', 'softBody', 'fluid'].some(k => entity[k] !== undefined)
    }) || (spec.animationTracks ?? []).some(t => (t.targetKind ?? 'entity') === 'entity' && selection.entityIds.includes(t.targetEntityId))) fail('animated, rigged or simulated selected products cannot use static boundary reuse.', BlenderErrorCode.UNSUPPORTED_ACTION)
    if (spec.lights.length > 32) fail('at most 32 named lights can be reused.')
  }
  if ((destinationSpec.animationTracks ?? []).some(t => t.targetKind === 'camera' && t.targetEntityId === input.cameraId)) fail('choose a static destination camera before adapting photography.', BlenderErrorCode.UNSUPPORTED_ACTION)
  const source = protectPlacementSource(host.store, input.source.projectId, input.source.revision, sourceSpec, signal)
  const destination = protectPlacementSource(host.store, input.projectId, input.baseRevision, destinationSpec, signal)
  const directory = resolveInside(host.workspaceRoot, join('tmp', `photography-reuse-${randomUUID()}`), 'photography inspection')
  mkdirSync(directory, { recursive: true })
  try {
    const inspect = async (spec, selection, protectedSource, name, cameraMustBeStatic) => {
      cancelled(); protectedSource.verify()
      const checkpointPath = join(directory, name + '.blend'); copyFileSync(protectedSource.checkpoint, checkpointPath)
      if (fileSha256(checkpointPath) !== protectedSource.expected) fail('the staged checkpoint changed.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
      const selected = { checkpointPath, checkpointSha256: protectedSource.expected, entityIds: selection.entityIds,
        assetInstanceIds: selection.entityIds.filter(id => spec.entities.find(e => e.id === id).type === 'asset-instance'),
        frame: selection.frame, cameraId: selection.cameraId, fittedCameraId: `photo-inspection-${randomUUID()}`, margin: 0,
        photography: { lightIds: spec.lights.map(l => l.id), cameraMustBeStatic } }
      const result = await host.runtime.inspectCameraFit({ ...selected, signal })
      const report = verifyCameraFitReport(result?.report, selected)
      cancelled(); protectedSource.verify()
      if (fileSha256(checkpointPath) !== protectedSource.expected) fail('the staged checkpoint changed.', BlenderErrorCode.SCENE_VALIDATION_FAILED)
      return report
    }
    // Sequential native reads bound peak geometry memory to one inspection.
    const sourceReport = await inspect(sourceSpec, input.source, source, 'source', false)
    const destinationReport = await inspect(destinationSpec, input, destination, 'destination', true)
    source.verify(); destination.verify(); verifyCurrent()
    const adapted = adaptPhotographyRig(sourceReport, destinationReport, destinationSpec, input.cameraId)
    const provenance = { mode: 'product-bounds-v1', storeIdentity: input.expectedStoreIdentity, sourceProject: input.source.projectId, sourceRevision: input.source.revision,
      sourceDigest: input.source.digest, sourceCheckpoint: source.expected, sourceCamera: input.source.cameraId, sourceFrame: input.source.frame,
      sourceMembersDigest: sha256Canonical(input.source.entityIds), destinationDigest: input.expectedDigest, destinationCheckpoint: destination.expected,
      destinationMembersDigest: sha256Canonical(input.entityIds), destinationFrame: input.frame,
      sourceCenter: adapted.sourceBounds.center, destinationCenter: adapted.targetBounds.center, scale: adapted.scale }
    if (JSON.stringify(provenance).length > 1800) fail('the source labels exceed the saved provenance budget.')
    return { schemaVersion: 'deepblend.photography-reuse/v1', request: input, ...adapted, provenance,
      sourceStaticCamera: sourceReport.photography.cameraStatic,
      sourceView: sourceReport.view, destinationView: destinationReport.view,
      scope: 'Static selected product bounds and named lighting at explicit saved frames; draft only.',
      limitations: ['Models, materials, world, other cameras and render settings are preserved.',
        'Destination sensor, shift, aperture and clipping are retained; framing and appearance can differ.',
        'Non-sun light size scales with product size and power with its square; sun strength and angle remain unchanged.',
        'Verify the preview and complete framing; this does not assess occlusion, shader displacement, flicker or artistic quality.'] }
  } finally { removeTree(directory) }
}
