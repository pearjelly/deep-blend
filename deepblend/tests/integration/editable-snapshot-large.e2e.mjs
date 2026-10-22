/** Standalone bounded-memory probe. No Blender, model calls or real user data. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEditableSnapshotArchive, pinSnapshotSource } from '../../../packages/deepblend/host/lib/editable-snapshot-archive.js'

if (!process.argv.includes('--worker')) {
  const child = spawn(process.execPath, ['--max-old-space-size=96', fileURLToPath(import.meta.url), '--worker'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180000)
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
    assert.equal(code, 0, errors || 'large snapshot worker failed or exceeded three minutes')
    const result = JSON.parse(output)
    assert.equal(result.sourceBytes, 1024 ** 3)
    assert.ok(result.archiveBytes > result.sourceBytes, 'STORE must write the actual GiB, not just compress the hole')
    assert.ok(result.peakRssBytes <= 256 * 1024 ** 2, `peak RSS ${result.peakRssBytes} exceeds 256 MiB`)
    assert.ok(result.peakRssBytes - result.baselineRssBytes <= 160 * 1024 ** 2, 'RSS growth exceeds 160 MiB')
    assert.ok(result.cancelledAtBytes < 80 * 1024 ** 2, 'cancellation must stop promptly')
    assert.equal(result.cleanedUp, true)
    console.log(JSON.stringify(result, null, 2))
  } finally { clearTimeout(timeout); child.kill('SIGKILL') }
} else {
  const root = await mkdtemp(join(tmpdir(), 'deepblend-snapshot-large-'))
  const bytes = 1024 ** 3, baselineRssBytes = process.memoryUsage().rss
  let peakRssBytes = baselineRssBytes, result
  const sample = () => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss) }
  const sampler = setInterval(sample, 10)
  const start = performance.now()
  try {
    const handle = await open(join(root, 'large.blend'), 'wx')
    try { await handle.truncate(bytes); await handle.write(Buffer.from('BLENDER-probe'), 0, 13, 0); await handle.write(Buffer.from('end'), 0, 3, bytes - 3) }
    finally { await handle.close() }
    const allocatedBytes = (await stat(join(root, 'large.blend'))).blocks * 512
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(root, 'large.blend'), { highWaterMark: 256 * 1024 })) { hash.update(chunk); sample() }
    const file = { ...await pinSnapshotSource(root, 'large.blend', { bytes, sha256: hash.digest('hex') }), path: 'native/model.blend', sourceType: 'native' }
    const controller = new AbortController()
    let cancelledAtBytes = 0, failedDirectory
    await assert.rejects(createEditableSnapshotArchive({ projectRoot: root, exportId: 'large', files: [file], signal: controller.signal,
      onProgress(p) { sample(); if (p.phase === 'writing' && p.writtenBytes >= 64 * 1024 ** 2) { cancelledAtBytes = p.writtenBytes; controller.abort() } },
    }), error => { failedDirectory = error.failureDirectory; return error.code === 'SNAPSHOT_CANCELLED' })
    const failed = JSON.parse(await readFile(join(root, failedDirectory, 'failed.json')))
    assert.equal(failed.state, 'failed')
    // The product retains failed files for diagnosis. The probe cleans its own
    // failure before retry to keep temporary disk use to one archive at a time.
    await rm(join(root, failedDirectory), { recursive: true, force: true })
    const ready = await createEditableSnapshotArchive({ projectRoot: root, exportId: 'large', files: [file], onProgress: sample })
    sample()
    const maxRssKiB = process.resourceUsage().maxRSS
    peakRssBytes = Math.max(peakRssBytes, maxRssKiB * 1024)
    result = { sourceBytes: bytes, sourceAllocatedBytes: allocatedBytes, archiveBytes: ready.archive.bytes, archiveSha256: ready.archive.sha256,
      baselineRssBytes, peakRssBytes, maxRssKiB, cancelledAtBytes, elapsedMs: Math.round(performance.now() - start),
      heapLimitMiB: 96, peakRssLimitMiB: 256, rssGrowthLimitMiB: 160, nodeVersion: process.version }
  } finally { clearInterval(sampler); await rm(root, { recursive: true, force: true }) }
  console.log(JSON.stringify({ ...result, cleanedUp: true }))
}
