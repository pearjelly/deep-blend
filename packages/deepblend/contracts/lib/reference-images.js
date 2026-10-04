/** Semantic checks shared by a SceneSpec and a project.brief.set operation.
 * Shape validation runs first. With assets omitted, only local invariants apply.
 */
export function referenceImageIssues(references, assets) {
  const issues = []
  const ids = new Set()
  for (const [index, reference] of references.entries()) {
    const add = (field, message, code = 'SCENE_SPEC_INVALID') =>
      issues.push({ path: `[${index}].${field}`, message, code })
    if (ids.has(reference.id)) add('id', `duplicate reference image id "${reference.id}"`, 'SCENE_ID_DUPLICATE')
    ids.add(reference.id)
    if (new Set(reference.purposes).size !== reference.purposes.length) {
      add('purposes', 'reference image purposes must be unique')
    }
    if (assets === undefined) continue
    const asset = assets.find(entry => entry.id === reference.assetId)
    if (!asset) {
      add('assetId', `reference image asset "${reference.assetId}" does not exist`, 'SCENE_REFERENCE_MISSING')
      continue
    }
    if (!['png', 'jpg', 'jpeg'].includes(asset.type)) add('assetId', 'reference images require a PNG or JPEG asset')
    if (asset.sha256 !== reference.sha256) add('sha256', 'reference image sha256 must match its declared asset sha256')
    if (asset.path !== `assets/raw/${reference.sha256}.${asset.type}`) {
      add('assetId', 'reference image assets require the immutable assets/raw/<sha256>.<type> path')
    }
  }
  return issues
}
