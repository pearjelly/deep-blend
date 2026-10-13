/** Refuse to rebuild away native edits not represented by the saved SceneSpec. */
import { BlenderError, GEOMETRY_INSPECTION_LIMITS } from '@deepblend/dsh-blender-contracts'
import { fileSha256, fileSize, isFile, resolveInside } from './paths.js'

export function protectRecipeNativeSource(store, projectId, revision) {
  const project = store.projectDirectory(projectId)
  const path = resolveInside(project, `revisions/${revision}/scene.blend`, 'recipe checkpoint')
  const manifest = store.readRevisionManifest(projectId, revision)
  if (!isFile(path) && !manifest.checkpoint && !manifest.checkpointBinding) return () => {}
  const conflict = () => { throw new BlenderError('RECIPE_PARAMETER_CONFLICT',
    'The saved native file was independently changed or has no verified producer hash. Keep that file and reconcile its edits before resizing; no new revision was published.',
    { detail: { conflicts: [{ entityId: null, property: 'native-checkpoint', revision }] } }) }
  let expected = manifest.checkpointBinding?.sha256, bytes = manifest.checkpointBinding?.bytes
  if (!expected) {
    const job = typeof manifest.jobId === 'string' ? store.readJobSafe(projectId, manifest.jobId) : null
    if (job?.projectId === projectId && job.revision === revision && job.status === 'succeeded'
      && ['compile_scene', 'apply_scene_patch'].includes(job.action)) {
      const matches = (job.artifacts ?? []).filter(a => a.kind === 'blend' && a.path === `revisions/${revision}/scene.blend`)
      if (matches.length === 1) { expected = matches[0].sha256; bytes = matches[0].bytes }
    }
  }
  const verify = () => {
    resolveInside(project, `revisions/${revision}/scene.blend`, 'recipe checkpoint')
    if (!/^[a-f0-9]{64}$/.test(expected ?? '') || !isFile(path)
      || fileSize(path) !== bytes || bytes > GEOMETRY_INSPECTION_LIMITS.checkpointBytes || fileSha256(path) !== expected) conflict()
  }
  verify()
  return verify
}
