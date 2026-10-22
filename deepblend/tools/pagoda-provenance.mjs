/** Verify the published pagoda media against its retained production delivery receipt. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function verifyPagodaProvenance(root) {
  const base = 'deepblend/docs/assets/showcase/pagoda'
  const read = file => readFileSync(join(root, base, file))
  const manifest = JSON.parse(read('manifest.json'))
  assert.equal(manifest.schemaVersion, 'deepblend.public-case/v1')
  assert.equal(manifest.license, 'CC0-1.0 third-party assets; MIT scene structure and documentation')
  assert.equal(manifest.projectId, 'official-comparison-pagoda')
  assert.equal(manifest.revisionId, 'r0075')
  assert.equal(manifest.renderJobId, 'render-0002')
  const declared = new Set()
  const verifyFile = (record, expectedName) => {
    assert.equal(record.file, expectedName)
    const bytes = read(expectedName)
    assert.equal(digest(bytes), record.sha256, `${expectedName}: pagoda digest differs`)
    assert.equal(bytes.length, record.bytes, `${expectedName}: pagoda byte count differs`)
    declared.add(`${base}/${expectedName}`)
    return bytes
  }
  const receipt = JSON.parse(verifyFile(manifest.deliveryReceipt, 'delivery.json'))
  assert.match(manifest.deliveryReceipt.originalSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(manifest.deliveryReceipt.redactions, ['video.encode.argv (absolute local command paths)'])
  assert.equal(receipt.video.encode.argv, undefined)
  assert.equal(receipt.schemaVersion, 'deepblend.delivery-manifest/v1')
  assert.equal(receipt.projectId, manifest.projectId)
  assert.equal(receipt.revisionId, manifest.revisionId)
  assert.equal(receipt.jobId, manifest.renderJobId)
  assert.deepEqual(receipt.completeness, { complete: true, missing: [] })
  assert.equal(manifest.source.sceneSpec, 'scene-spec.json')
  const spec = JSON.parse(verifyFile({ ...manifest.source, file: manifest.source.sceneSpec }, 'scene-spec.json'))
  assert.equal(spec.project.id, manifest.projectId)
  assert.equal(manifest.source.sha256, receipt.source.sceneSpec.sha256)
  assert.equal(manifest.source.bytes, receipt.source.sceneSpec.bytes)
  assert.equal(manifest.source.scope, 'structural-source-only')
  assert.equal(manifest.source.externalAssetsIncluded, false)
  assert.equal(manifest.source.nativeProjectIncluded, false)
  assert.match(receipt.source.checkpoint.sha256, /^[a-f0-9]{64}$/)

  verifyFile(manifest.video, 'final.mp4')
  assert.equal(manifest.video.sha256, receipt.video.sha256)
  assert.equal(manifest.video.bytes, receipt.video.bytes)
  assert.equal(manifest.video.verified, true)
  assert.equal(receipt.video.verified, true)
  assert.deepEqual(receipt.video.problems, [])
  for (const key of ['durationSeconds', 'fps', 'frameCount', 'codec']) {
    assert.equal(manifest.video[key], receipt.video.probed[key])
  }
  assert.deepEqual(manifest.video.resolution, [receipt.video.probed.width, receipt.video.probed.height])
  assert.deepEqual(manifest.video.resolution, receipt.render.config.resolution)
  assert.equal(manifest.video.samples, receipt.render.config.samples)
  assert.equal(manifest.video.engine.toUpperCase(), receipt.render.config.engine)
  assert.deepEqual([manifest.video.frameCount, manifest.video.fps, manifest.video.durationSeconds], [900, 24, 37.5])
  const frames = Array.from({ length: 900 }, (_, index) => index + 1)
  assert.deepEqual(receipt.frames.renderedFrames, frames)
  assert.deepEqual(receipt.frames.corrupt, [])
  const provenance = receipt.render.provenance
  assert.equal(provenance.coverage, 'complete')
  assert.deepEqual(provenance.frames.map(frame => frame.frame), frames)
  for (const source of provenance.sources) {
    assert.equal(source.revisionId, manifest.revisionId)
    assert.equal(source.checkpointSha256, receipt.source.checkpoint.sha256)
    assert.deepEqual(source.renderConfig, receipt.render.config)
  }
  assert.deepEqual(manifest.images.map(image => image.file).sort(),
    ['buddha-court.png', 'buddha-detail.png', 'final-courtyard.png', 'poster.png'])
  for (const image of manifest.images) {
    const bytes = verifyFile(image, image.file)
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), image.width)
    assert.equal(bytes.readUInt32BE(20), image.height)
    assert.deepEqual([image.width, image.height], manifest.video.resolution)
    assert.equal(image.postProcessed, false)
    const frame = provenance.frames.find(frame => frame.frame === image.frame)
    assert.ok(frame, `${image.file}: missing source frame`)
    assert.equal(frame.sha256, image.sha256, `${image.file}: source frame digest differs`)
    assert.equal(frame.cameraId, image.cameraId)
    assert.equal(frame.shotId, image.shotId)
    assert.ok(provenance.sources.some(source => source.id === frame.sourceId), 'missing frame source')
    const shot = spec.shots.find(shot => shot.id === image.shotId)
    assert.ok(shot && image.frame >= shot.frameRange[0] && image.frame <= shot.frameRange[1])
    assert.equal(shot.cameraId, image.cameraId)
  }
  return declared
}
