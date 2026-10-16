import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Verify the pinned, original recovery evidence before declaring its images. */
export function verifyRecoveryReproductionProvenance(root) {
  const base = 'deepblend/reproductions/recovery-v0.11.0'
  const read = path => JSON.parse(readFileSync(join(root, base, path), 'utf8'))
  const hash = path => createHash('sha256').update(readFileSync(join(root, base, path))).digest('hex')
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).license, 'MIT')
  assert.match(readFileSync(join(root, base, 'LICENSE'), 'utf8'), /MIT License[\s\S]*DeepBlend Studio contributors/)
  // Keep the publisher's complete checksum/source/recovery verification in use.
  execFileSync('python3', [join(root, base, 'verify-package.py')], { encoding: 'utf8', stdio: 'pipe' })
  const spec = read('source-r0001.scene-spec.json')
  assert.equal(spec.assets?.length ?? 0, 0, 'recovery reproduction must not inherit an original-MIT claim for external assets')
  assert.ok(spec.entities.every(entity => entity.type === 'generator'), 'review imported recovery geometry provenance')
  const manifest = read('evidence/delivery-manifest.json')
  const ledger = read('evidence/final-frame-sources.json')
  const report = read('evidence/verification.json')
  assert.equal(ledger.jobId, manifest.jobId)
  assert.equal(ledger.revisionId, manifest.revisionId)
  const checkpoint = hash('scene-r0001.blend')
  for (const source of Object.values(ledger.sources)) {
    assert.equal(source.checkpointSha256, checkpoint, 'recovery frame source is detached from the published native project')
    assert.equal(source.revisionId, manifest.revisionId)
  }
  assert.deepEqual(Object.keys(ledger.frames).sort(), Object.keys(report.frames).sort())
  return Object.entries(ledger.frames).map(([frame, receipt]) => {
    assert.ok(ledger.sources[receipt.sourceId], `recovery frame ${frame} has no native source`)
    const file = `frames/frame_${frame.padStart(4, '0')}.png`
    assert.equal(hash(file), receipt.sha256, `recovery frame ${frame} differs from its source receipt`)
    assert.equal(receipt.sha256, report.frames[frame])
    return `${base}/${file}`
  })
}
