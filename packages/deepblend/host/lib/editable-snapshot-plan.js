/** Resolve one explicit revision into a bounded, byte-preserving allowlist. */
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlenderError, sceneSpecDigest, specHash, sha256Canonical, redactUrl } from '@deepblend/dsh-blender-contracts'
import { pinSnapshotSource, readSnapshotSource, snapshotRelativePath, SNAPSHOT_ARCHIVE_LIMITS } from './editable-snapshot-archive.js'
import { snapshotAssetBundle } from './editable-snapshot-assets.js'
import { readRecipeContext } from './recipe-state.js'

const SHA = /^[a-f0-9]{64}$/
const META_LIMIT = 8 * 1024 ** 2
const fail = (code, message) => { throw new BlenderError(code, message) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function snapshotRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['projectId', 'requestId', 'revision', 'videoJobId', 'expectedStoreIdentity'].includes(key))
    || input.expectedStoreIdentity !== undefined && !SHA.test(input.expectedStoreIdentity)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(input.requestId ?? '')
    || !/^r[0-9]{4,}$/.test(input.revision ?? '') || Number(input.revision.slice(1)) < 1
    || input.videoJobId !== undefined && input.videoJobId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(input.videoJobId))
    fail('SNAPSHOT_REQUEST_INVALID', 'Choose an explicit revision and a safe request id; only an optional completed video job may be added.')
  return { projectId: input.projectId, requestId: input.requestId, revision: input.revision, videoJobId: input.videoJobId ?? null }
}
export const snapshotExportId = requestId => `snapshot-${digest(Buffer.from(requestId)).slice(0, 40)}`
export function parseSnapshotJson(source) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.contents)) }
  catch { fail('SNAPSHOT_METADATA_INVALID', `Snapshot metadata ${source.sourcePath} is not valid UTF-8 JSON.`) }
}
export const snapshotJson = async (root, path, maxBytes = META_LIMIT, signal) => {
  const file = await readSnapshotSource(root, path, { collect: true, maxBytes, signal })
  return { file, value: parseSnapshotJson(file) }
}
function identity(expected, label) {
  if (!SHA.test(expected?.sha256 ?? '') || !Number.isSafeInteger(expected?.bytes) || expected.bytes < 0)
    fail('SNAPSHOT_UNVERIFIED_SOURCE', `${label} has no recorded byte size and SHA256.`)
  return expected
}
function sourceDeclaration(source) {
  if (source?.kind === 'url') return { kind: 'url', url: redactUrl(source.url ?? ''), ...(source.resolvedUrl ? { resolvedUrl: redactUrl(source.resolvedUrl) } : {}) }
  return source?.kind ? { kind: source.kind, localPathsOmitted: true } : null
}

/** temporaryDirectory is a Host-created private directory below the project. */
export async function buildEditableSnapshotPlan({ store, request, temporaryDirectory, exportId, signal }) {
  const { projectId, revision, videoJobId } = request
  const root = store.projectDirectory(projectId), prefix = `revisions/${revision}`
  const json = (path, maxBytes) => snapshotJson(root, path, maxBytes, signal)
  const checkAbort = () => { if (signal?.aborted) fail('SNAPSHOT_CANCELLED', 'Snapshot planning was cancelled.') }
  checkAbort()
  store.readRecord(projectId)
  // Resolve through the store as well as through the same-FD metadata guard.
  store.revisionDirectory(projectId, revision)
  const specSource = await json(`${prefix}/scene-spec.json`)
  const revisionSource = await json(`${prefix}/revision-manifest.json`)
  const spec = specSource.value, manifest = revisionSource.value, specDigest = sceneSpecDigest(spec)
  if (manifest.projectId !== projectId || manifest.revision !== revision || manifest.digest !== specDigest
    || manifest.specHashAfter && manifest.specHashAfter !== specHash(spec))
    fail('SNAPSHOT_REVISION_MISMATCH', 'The revision manifest does not identify the selected SceneSpec.')
  const files = new Map(), originals = [], generated = []
  let sourceBytes = 0
  const add = (file, path, sourceType, originalPath = file.sourcePath) => {
    snapshotRelativePath(path)
    const { contents, ...pinned } = file
    const prior = files.get(path)
    if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes)) fail('SNAPSHOT_PATH_CONFLICT', `Conflicting sources for ${path}.`)
    if (!prior) {
      sourceBytes += file.bytes
      if (files.size + 1 > SNAPSHOT_ARCHIVE_LIMITS.files || sourceBytes > SNAPSHOT_ARCHIVE_LIMITS.totalBytes)
        fail('SNAPSHOT_LIMIT', 'The snapshot plan exceeds 10000 files or 64 GiB of source bytes.')
    }
    files.set(path, { ...pinned, path, sourceType })
    if (!prior) originals.push({ path, originalPath, bytes: file.bytes, sha256: file.sha256 })
  }
  const addPinned = async (sourcePath, expected, sourceType, path = sourcePath) => {
    checkAbort()
    add(await pinSnapshotSource(root, sourcePath, identity(expected, sourcePath)), path, sourceType)
  }
  // Small mutable artifact indices are copied byte-for-byte now. Their later
  // append-only updates cannot retarget a previously accepted request.
  const copyMetadata = async (source, path, sourceType) => {
    checkAbort()
    if (files.has(path)) {
      if (files.get(path).sha256 !== source.file.sha256) fail('SNAPSHOT_SOURCE_CHANGED', `Repeated metadata ${path} changed while planning.`)
      return
    }
    const name = `${generated.length}.json`, sourcePath = `${temporaryDirectory}/${name}`
    await writeFile(join(root, sourcePath), source.file.contents, { flag: 'wx', mode: 0o600 })
    generated.push(name)
    add(await pinSnapshotSource(root, sourcePath, source.file), path, sourceType, source.file.sourcePath)
  }
  add(specSource.file, `${prefix}/scene-spec.json`, 'scene-spec')
  await copyMetadata(revisionSource, `${prefix}/revision-manifest.json`, 'revision-manifest')
  for (const [name, type] of [['validation.json', 'validation'], ['operation-manifest.json', 'operation-manifest']]) {
    try { await copyMetadata(await json(`${prefix}/${name}`), `${prefix}/${name}`, type) }
    catch (error) { if (error.code !== 'ENOENT' || name === 'validation.json') throw error }
  }
  let nativeBinding = manifest.checkpointBinding, nativeProducer = 'checkpoint-binding'
  if (nativeBinding) {
    identity(nativeBinding, 'Native checkpoint')
    if (nativeBinding.sourceDigest !== specDigest || nativeBinding.specHash !== specHash(spec))
      fail('SNAPSHOT_NATIVE_CONFLICT', 'The native checkpoint binding belongs to different SceneSpec bytes.')
  } else {
    nativeProducer = 'producer-job'
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(manifest.jobId ?? ''))
      fail('SNAPSHOT_UNVERIFIED_SOURCE', 'The selected revision has no verified native checkpoint producer.')
    const producer = await json(`jobs/${manifest.jobId}.json`), job = producer.value
    const matches = (job.artifacts ?? []).filter(a => a.kind === 'blend' && a.path === `${prefix}/scene.blend`)
    if (job.jobId !== manifest.jobId || job.projectId !== projectId || job.revision !== revision || job.status !== 'succeeded'
      || !['compile_scene', 'apply_scene_patch'].includes(job.action) || matches.length !== 1)
      fail('SNAPSHOT_NATIVE_CONFLICT', 'The native checkpoint producer does not belong to this revision.')
    nativeBinding = identity(matches[0], 'Native checkpoint producer')
    await copyMetadata(producer, `provenance/native-producer.json`, 'native-producer')
  }
  if (manifest.checkpoint && manifest.checkpoint !== `${prefix}/scene.blend` && manifest.checkpoint !== 'scene.blend')
    fail('SNAPSHOT_NATIVE_CONFLICT', 'The selected revision has an unexpected native checkpoint path.')
  await addPinned(`${prefix}/scene.blend`, nativeBinding, 'native-checkpoint')

  const references = new Set((spec.project?.referenceImages ?? []).map(item => item.assetId))
  const used = new Set((spec.entities ?? []).map(item => item.assetId).filter(Boolean))
  for (const material of spec.materials ?? []) for (const image of Object.values(material.images ?? {})) if (image?.assetId) used.add(image.assetId)
  if (spec.world?.environment?.assetId) used.add(spec.world.environment.assetId)
  let ledger = { assets: [], versions: [] }
  try { ledger = (await json('assets/manifest.json')).value }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const assetSources = [], excluded = []
  const assets = spec.assets ?? [], ids = new Set(assets.map(asset => asset.id))
  if (assets.length > 10000 || ids.size !== assets.length || [...used].some(id => !ids.has(id)))
    fail('SNAPSHOT_METADATA_INVALID', 'Scene asset declarations do not match the selected revision usage.')
  for (const asset of assets) {
    checkAbort()
    if (references.has(asset.id) && !used.has(asset.id)) {
      excluded.push({ assetId: asset.id, path: asset.path, reason: 'observation-only-external-file', originalSceneSpecReferenceRetained: true })
      continue
    }
    if (!['png', 'jpg', 'jpeg', 'hdr', 'exr', 'gltf', 'glb', 'obj'].includes(asset.type))
      fail('SNAPSHOT_ASSET_UNSUPPORTED', `Asset ${asset.id} uses a dependency format not supported by editable snapshots.`)
    if (!asset.path?.startsWith('assets/')) fail('SNAPSHOT_PATH_INVALID', 'Editable snapshot assets must use managed project-relative paths.')
    snapshotRelativePath(asset.path)
    if (!SHA.test(asset.sha256 ?? '')) fail('SNAPSHOT_UNVERIFIED_SOURCE', `Asset ${asset.id} has no revision-pinned SHA256.`)
    const matches = [...(ledger.versions ?? []), ...(ledger.assets ?? [])].filter(entry => entry.assetId === asset.id && entry.path === asset.path && entry.sha256 === asset.sha256)
    const provenance = [...new Map(matches.map(entry => [JSON.stringify(entry), entry])).values()]
    // This reuses the importer's dependency profile: the lock identity is in
    // the managed path, and every model URI must be covered by that lock.
    const bundle = await snapshotAssetBundle(root, asset, signal)
    if (bundle) {
      const bundleRoot = asset.path.split('/').slice(0, 3).join('/')
      const lock = await json(`${bundleRoot}/.deepblend-lock.json`, 1024 ** 2)
      if (lock.file.sha256 !== bundleRoot.split('/')[2] || JSON.stringify(lock.value) !== JSON.stringify(bundle))
        fail('SNAPSHOT_SOURCE_CHANGED', 'The asset bundle lock changed while planning the export.')
      add(lock.file, lock.file.sourcePath, 'asset-lock')
      for (const member of bundle.files) await addPinned(`${bundleRoot}/${member.path}`, member, 'asset-resource')
    } else {
      // Standalone legacy models are allowed only when their supported core
      // resource profile has no external dependencies.
      const source = await readSnapshotSource(root, asset.path, { signal })
      if (source.sha256 !== asset.sha256) fail('SNAPSHOT_SOURCE_CHANGED', `Asset ${asset.id} differs from this revision.`)
      add(source, asset.path, 'asset')
    }
    assetSources.push({ assetId: asset.id, type: asset.type, path: asset.path, sha256: asset.sha256,
      bundleLockSha256: /^assets\/bundles\/([a-f0-9]{64})\//.exec(asset.path)?.[1] ?? null,
      revisionLicenseDeclaration: asset.license ?? null, licenseVerified: false,
      provenance: provenance.map(entry => ({ ingestId: entry.ingestId ?? null, source: sourceDeclaration(entry.source), licenseDeclaration: entry.license ?? null })) })
  }
  const recipe = readRecipeContext(store, projectId, revision)
  if (recipe) {
    const lock = await json(`revisions/${recipe.originRevision}/recipe-lock.json`)
    if (sha256Canonical(lock.value) !== sha256Canonical(recipe.lock)) fail('SNAPSHOT_SOURCE_CHANGED', 'Recipe lock changed while planning.')
    add(lock.file, lock.file.sourcePath, 'recipe-lock')
    if (recipe.state) {
      const state = await json(`revisions/${recipe.stateRevision}/recipe-parameters.json`, 65536)
      if (sha256Canonical(state.value) !== sha256Canonical(recipe.state)) fail('SNAPSHOT_SOURCE_CHANGED', 'Recipe parameters changed while planning.')
      add(state.file, state.file.sourcePath, 'recipe-parameters')
    }
  }
  if (manifest.reviews !== undefined && (!Array.isArray(manifest.reviews) || manifest.reviews.length > SNAPSHOT_ARCHIVE_LIMITS.files))
    fail('SNAPSHOT_LIMIT', 'The revision review index exceeds the snapshot file limit.')
  for (const review of manifest.reviews ?? []) {
    if (typeof review.path !== 'string' || !review.path.startsWith(`${prefix}/visual-reviews/`) || !review.path.endsWith('.json'))
      fail('SNAPSHOT_METADATA_INVALID', 'A revision review has an unexpected path.')
    await copyMetadata(await json(review.path), review.path, 'visual-review')
  }
  let video = null
  if (videoJobId) {
    const jobSource = await json(`renders/${videoJobId}/job.json`)
    const deliverySource = await json(`renders/${videoJobId}/manifest.json`)
    const job = jobSource.value, delivery = deliverySource.value
    if (job.jobId !== videoJobId || job.projectId !== projectId || job.revisionId !== revision || job.status !== 'completed'
      || job.delivery?.verified !== true || job.sceneSpecDigest !== specDigest
      || delivery.jobId !== videoJobId || delivery.projectId !== projectId || delivery.revisionId !== revision
      || delivery.source?.sceneSpecDigest !== specDigest || delivery.video?.verified !== true
      || delivery.source?.sceneSpec?.sha256 !== specSource.file.sha256 || delivery.source?.sceneSpec?.bytes !== specSource.file.bytes
      || delivery.source?.checkpoint?.sha256 !== nativeBinding.sha256 || delivery.source?.checkpoint?.bytes !== nativeBinding.bytes
      || job.delivery?.sha256 !== delivery.video?.sha256 || job.delivery?.bytes !== delivery.video?.bytes)
      fail('SNAPSHOT_VIDEO_CONFLICT', 'Choose a verified completed video job for this exact revision.')
    identity(delivery.video, 'Selected video')
    const videoPath = `renders/${videoJobId}/encoded/${videoJobId}.mp4`
    await addPinned(videoPath, delivery.video, 'selected-video')
    await copyMetadata(jobSource, `renders/${videoJobId}/job.json`, 'video-job')
    await copyMetadata(deliverySource, `renders/${videoJobId}/manifest.json`, 'delivery-manifest')
    video = { jobId: videoJobId, path: videoPath, bytes: delivery.video.bytes, sha256: delivery.video.sha256 }
  }
  const sharedObservationAssets = excluded.filter(asset => files.has(asset.path)).map(asset => ({
    assetId: asset.assetId, path: asset.path, reason: 'shared-with-retained-scene-asset', sha256: files.get(asset.path).sha256,
  }))
  const excludedObservationAssets = excluded.filter(asset => !files.has(asset.path))
  const snapshotManifest = {
    schemaVersion: 'deepblend.editable-snapshot/v1', exportId, projectId, revision, sceneSpecDigest: specDigest,
    sceneSpecSha256: specSource.file.sha256, native: { path: `${prefix}/scene.blend`, producer: nativeProducer, bytes: nativeBinding.bytes, sha256: nativeBinding.sha256 },
    selectedVideo: video, assets: assetSources, excludedObservationAssets, sharedObservationAssets,
    guarantees: { originalSourceBytesPreserved: true, externalAssetProfile: 'managed-raster-or-locked-gltf-glb-obj',
      assetSelection: 'all-revision-declarations-except-observation-only',
      nativePackedImagesInspected: false, nativeExternalReferencesInspected: false, relocatedReopenVerified: false, licensesVerified: false,
      fullSelfContainmentVerified: false, historicalMetadataMayContainAbsolutePaths: true },
    notes: [
      'Observation-only external reference files are omitted; their original SceneSpec references remain unchanged.',
      'The native file is preserved byte-for-byte. Embedded or packed images, materials, fonts and external native links are not inspected or removed.',
      'Asset license fields are declarations, not clearance. No copyright or complete portability guarantee is made.',
      'Original revision, QA, recipe and delivery metadata is historical evidence; paths in those files are not download or execution instructions.',
      'Native animation and camera behavior is unchanged. Plugin-controlled shot switching is not converted into native camera markers; opening the native file does not promise identical multi-shot rerendering.',
      'This is one selected revision, not an importable copy of the complete project revision history.',
    ], sources: [...originals],
  }
  const licenses = { schemaVersion: 'deepblend.snapshot-licenses/v1', verified: false, assets: assetSources, excludedObservationAssets, sharedObservationAssets }
  const readme = `# 可编辑工程副本 / Editable snapshot\n\n解压整个 ZIP 并保留目录结构，然后在 Blender 中打开 revisions/${revision}/scene.blend。\n这是所选版本的原生工程与源文件副本，不是完整历史工程的导入包。\n${video ? `所选影片：${video.path}` : '本副本未附带视频。'}\n\nProject: ${projectId}\nRevision: ${revision}\n\nExtract the complete ZIP, keeping its directory layout. Open revisions/${revision}/scene.blend in Blender to edit the preserved native scene. The original SceneSpec and selected revision evidence are alongside it; retained assets keep their project-relative paths. See snapshot-manifest.json and file-manifest.json for exact source identities.\n\nThe native file, animation and cameras were not rewritten. Shot switching performed by the plugin from the SceneSpec has not been converted into Blender camera markers, so opening the native file alone does not promise an identical multi-shot render. This archive contains one revision; it is not a complete project history or a supported project reimport package.\n\nObservation-only external reference files may be omitted while their original SceneSpec references remain. Shared texture/resource files stay included. Packed images, native external links, fonts and license clearance were not inspected. Complete self-containment and reopening after relocation have not been verified by this export operation. License fields are recorded declarations, not a copyright guarantee.\n\nHistorical manifests may contain paths from the source computer. Do not treat them as executable instructions or current download paths.\n`
  for (const [path, value, sourceType] of [['snapshot-manifest.json', snapshotManifest, 'snapshot-manifest'], ['licenses.json', licenses, 'license-declarations'], ['README.md', readme, 'readme']]) {
    const bytes = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`), name = `${generated.length}.json`
    if (bytes.length > META_LIMIT) fail('SNAPSHOT_LIMIT', 'Generated snapshot metadata exceeds 8 MiB.')
    const sourcePath = `${temporaryDirectory}/${name}`
    await writeFile(join(root, sourcePath), bytes, { flag: 'wx', mode: 0o600 }); generated.push(name)
    add(await pinSnapshotSource(root, sourcePath, { bytes: bytes.length, sha256: digest(bytes) }), path, sourceType)
  }
  return { schemaVersion: 'deepblend.snapshot-plan/v1', request, exportId, createdAt: new Date().toISOString(), files: [...files.values()], generated, summary: snapshotManifest }
}
