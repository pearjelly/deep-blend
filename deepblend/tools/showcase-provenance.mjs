/** Validate exact published showcase files; never allow an entire asset directory. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function verifyShowcaseProvenance(root) {
  const base = 'deepblend/docs/assets/showcase'
  const manifest = JSON.parse(readFileSync(join(root, base, 'manifest.json'), 'utf8'))
  const license = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license
  assert.equal(manifest.schemaVersion, 'deepblend.showcase/v1')
  assert.equal(manifest.complete, true)
  assert.deepEqual(manifest.cases.map(c => c.id).sort(), [...manifest.expectedCases].sort())
  assert.equal(new Set(manifest.expectedCases).size, manifest.expectedCases.length)
  assert.deepEqual(manifest.externalSceneAssets, [])
  const declared = new Set()
  function verifyFile(record, extension) {
    assert.match(record.path, new RegExp(`^[a-z0-9-]+\\.${extension}$`))
    const path = `${base}/${record.path}`
    assert.ok(!declared.has(path), `duplicate showcase source: ${path}`)
    const bytes = readFileSync(join(root, path))
    assert.equal(digest(bytes), record.sha256, `${path}: showcase digest differs from provenance`)
    assert.equal(bytes.length, record.bytes, `${path}: showcase byte count differs`)
    declared.add(path)
    return bytes
  }
  for (const entry of manifest.cases) {
    assert.match(entry.id, /^[a-z0-9-]+$/)
    assert.equal(entry.license, license)
    assert.equal(entry.sceneSource, `../../../showcase/${entry.id}/scene-spec.json`)
    const source = readFileSync(join(root, 'deepblend/showcase', entry.id, 'scene-spec.json'))
    assert.equal(digest(source), entry.sceneSourceSha256, `${entry.id}: scene source changed`)
    const project = JSON.parse(source).project.id
    assert.deepEqual(entry.images.map(image => image.kind).sort(), ['detail', 'hero'])
    assert.equal(entry.inspections.length, 1, `${entry.id}: missing clay provenance`)
    const hero = entry.images.find(image => image.kind === 'hero')
    for (const image of [...entry.images, ...entry.inspections]) {
      const bytes = verifyFile(image, 'png')
      assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
      assert.equal(bytes.readUInt32BE(16), image.width)
      assert.equal(bytes.readUInt32BE(20), image.height)
      assert.match(image.pixelSha256, /^[a-f0-9]{64}$/)
      assert.equal(image.projectId, project)
      assert.match(image.revision, /^r\d+$/)
      assert.match(image.sceneDigest, /^[a-f0-9]{64}$/)
      assert.ok(Number.isInteger(image.frame) && image.frame >= 1)
      assert.deepEqual(image.renderConfig.resolution, [image.width, image.height])
      if (image.mode === 'clay') {
        assert.equal(image.revision, hero.revision)
        assert.equal(image.sceneDigest, hero.sceneDigest)
        assert.equal(image.cameraId, hero.cameraId)
        assert.equal(image.frame, hero.frame)
        assert.match(image.sourceReceiptSha256, /^[a-f0-9]{64}$/)
      } else verifyFile(image.webDerivative, 'webp')
    }
    assert.equal(entry.inspections[0].mode, 'clay')
    const video = entry.video
    verifyFile(video, 'mp4')
    assert.equal(video.verified, true)
    assert.equal(video.projectId, project)
    assert.equal(video.revision, hero.revision)
    assert.deepEqual([video.width, video.height, video.fps, video.frameCount, video.durationSeconds], [1920, 1080, 24, 144, 6])
    assert.deepEqual(video.encodedFrameSamples.map(frame => frame.encodedFrame), [1, 72, 144])
    assert.equal(new Set(video.encodedFrameSamples.map(frame => frame.pixelSha256)).size, 3)
    verifyFile(video.animatedPreview, 'webp')
    assert.deepEqual([video.animatedPreview.width, video.animatedPreview.height, video.animatedPreview.sampledFrames, video.animatedPreview.durationMs], [960, 540, 72, 6000])
  }
  return declared
}
