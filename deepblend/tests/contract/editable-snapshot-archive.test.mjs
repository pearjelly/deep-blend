import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readdirSync, renameSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import yauzl from 'yauzl'
import {
  createEditableSnapshotArchive, pinSnapshotSource, SNAPSHOT_FILE_MANIFEST,
} from '../../../packages/deepblend/host/lib/editable-snapshot-archive.js'

const digest = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deepblend-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function source(root, sourcePath, contents, path = sourcePath, sourceType = 'asset') {
  await mkdir(dirname(join(root, sourcePath)), { recursive: true })
  await writeFile(join(root, sourcePath), contents)
  return { ...await pinSnapshotSource(root, sourcePath, { bytes: Buffer.byteLength(contents), sha256: digest(contents) }), path, sourceType }
}
async function unpackSmall(path) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true, strictFileNames: true })
  const files = new Map(), entries = []
  try {
    for await (const entry of zip.eachEntry()) {
      const chunks = [], stream = await zip.openReadStreamPromise(entry)
      for await (const chunk of stream) chunks.push(chunk)
      files.set(entry.fileName, Buffer.concat(chunks))
      entries.push(entry)
    }
  } finally { zip.close() }
  return { files, entries }
}
async function expectFailed(root, exportId, work, code) {
  let failure
  await assert.rejects(work, error => { failure = error; return error.code === code })
  assert.equal(existsSync(join(root, 'exports', exportId)), false)
  assert.ok(failure.failureDirectory, 'a failed preparation retains its staging location')
  assert.equal(existsSync(join(root, failure.failureDirectory, 'ready.json')), false)
  const receipt = JSON.parse(await readFile(join(root, failure.failureDirectory, 'failed.json')))
  assert.equal(receipt.state, 'failed')
  assert.equal(receipt.code, code)
  return failure
}

test('preserves native/source bytes and a minimal allowlist, with independent manifest and ZIP digests', async t => {
  const root = await fixture(t)
  const native = Buffer.concat([Buffer.from('BLENDER-v500'), Buffer.alloc(600000, 7)])
  const original = '{ "name": "佛塔", "referenceImages": ["ref-observation"] }\n'
  const files = [
    await source(root, 'revisions/r0001/native.blend', native, 'native/model.blend', 'native'),
    await source(root, 'revisions/r0001/scene-spec.json', original, 'source/scene-spec.json', 'provenance'),
    await source(root, 'assets/纹理.png', 'texture bytes'),
    await source(root, 'assets/empty.txt', ''),
  ]
  await writeFile(join(root, 'not-allowlisted-secret.txt'), 'do not include')
  const phases = new Set()
  const ready = await createEditableSnapshotArchive({ projectRoot: root, exportId: 'first', files,
    onProgress(progress) { phases.add(progress.phase); assert.equal(existsSync(join(root, 'exports/first')), false) } })
  assert.deepEqual(phases, new Set(['preparing', 'writing', 'verifying', 'publishing']))
  const bytes = await readFile(join(root, ready.archive.path))
  assert.equal(bytes.length, ready.archive.bytes)
  assert.equal(digest(bytes), ready.archive.sha256)
  const extracted = await unpackSmall(join(root, ready.archive.path))
  assert.deepEqual([...extracted.files.keys()], [...files.map(file => file.path), SNAPSHOT_FILE_MANIFEST])
  assert.deepEqual(extracted.files.get('native/model.blend'), native)
  assert.equal(extracted.files.get('source/scene-spec.json').toString(), original)
  const manifestBytes = extracted.files.get(SNAPSHOT_FILE_MANIFEST)
  assert.equal(digest(manifestBytes), ready.manifest.sha256)
  assert.deepEqual(await readFile(join(root, 'exports/first/file-manifest.json')), manifestBytes)
  const manifest = JSON.parse(manifestBytes)
  assert.equal(JSON.stringify(manifest).includes(root), false, 'no source computer absolute paths')
  for (const file of manifest.files) {
    assert.equal(digest(extracted.files.get(file.path)), file.sha256)
    assert.equal(extracted.files.get(file.path).length, file.bytes)
    assert.equal(typeof file.source.type, 'string')
  }
  assert.deepEqual(JSON.parse(await readFile(join(root, 'exports/first/ready.json'))), ready)
})

test('ZIP64 is independently readable, with compressed and empty entries', async t => {
  const root = await fixture(t)
  const files = [await source(root, 'model.blend', Buffer.alloc(1024 * 1024)), await source(root, 'empty', '')]
  const ready = await createEditableSnapshotArchive({ projectRoot: root, exportId: 'zip64', files, forceZip64: true, compress: true })
  const result = await unpackSmall(join(root, ready.archive.path))
  assert.ok(result.entries.every(entry => entry.versionNeededToExtract === 45))
  assert.ok(result.entries.every(entry => entry.extraFields.some(field => field.id === 1)))
  assert.ok(ready.archive.bytes < files[0].bytes / 20)
  assert.deepEqual(result.files.get('model.blend'), Buffer.alloc(1024 * 1024))
})

test('rejects escape paths, ambiguous portable names, reserved manifest and directory/file collisions before writing', async t => {
  const root = await fixture(t), file = await source(root, 'source', 'fixed')
  for (const bad of ['/tmp/out', '../out', 'x/../out', 'a\\b', 'C:/out', 'a//b', 'a/./b', 'a\0b', 'con.txt', 'x/AUX', 'x.', 'x ', 'a'.repeat(256), 'x/' + '纹'.repeat(100)]) {
    for (const field of ['path', 'sourcePath']) {
      await assert.rejects(createEditableSnapshotArchive({ projectRoot: root, exportId: 'bad', files: [{ ...file, [field]: bad }] }),
        error => error.code === 'SNAPSHOT_PATH_INVALID', `${field}: ${bad}`)
    }
  }
  for (const paths of [['file-manifest.json'], ['FILE-MANIFEST.JSON/child'], ['x', 'x/y'], ['X/A', 'x/B'], ['é', 'e\u0301'], ['A', 'a']]) {
    await assert.rejects(createEditableSnapshotArchive({ projectRoot: root, exportId: 'bad', files: paths.map(path => ({ ...file, path })) }),
      error => error.code === 'SNAPSHOT_PATH_CONFLICT', paths.join(', '))
  }
  for (const exportId of ['../bad', '.hidden', 'a/b', '', 'CON', 'x'.repeat(97)])
    await assert.rejects(createEditableSnapshotArchive({ projectRoot: root, exportId, files: [file] }), error => error.code === 'SNAPSHOT_PATH_INVALID')
  assert.equal(existsSync(join(root, 'exports')), false)
})

test('refuses source/parent/output symlinks even when their targets are inside the project', async t => {
  const root = await fixture(t), file = await source(root, 'assets/source', 'fixed')
  await symlink('assets/source', join(root, 'linked'))
  await symlink('assets', join(root, 'linked-dir'))
  for (const sourcePath of ['linked', 'linked-dir/source']) {
    await assert.rejects(pinSnapshotSource(root, sourcePath, file), error => error.code === 'SNAPSHOT_PATH_INVALID')
  }
  await rm(join(root, 'assets/source'))
  await writeFile(join(root, 'replacement'), 'fixed')
  await symlink('../replacement', join(root, 'assets/source'))
  await expectFailed(root, 'symlink', createEditableSnapshotArchive({ projectRoot: root, exportId: 'symlink', files: [file] }), 'SNAPSHOT_PATH_INVALID')
  await rm(join(root, 'exports'), { recursive: true })
  await symlink('assets', join(root, 'exports'))
  await assert.rejects(createEditableSnapshotArchive({ projectRoot: root, exportId: 'output-link', files: [file] }), error => error.code === 'SNAPSHOT_PATH_INVALID')
  assert.equal(existsSync(join(root, 'assets/output-link')), false)
})

test('identity is not a substitute for actual source SHA256 verification', async t => {
  const root = await fixture(t), file = await source(root, 'source.blend', Buffer.alloc(700000, 1))
  const wrongDigest = { ...file, sha256: digest(Buffer.alloc(file.bytes, 2)) }
  await expectFailed(root, 'bad-digest', createEditableSnapshotArchive({ projectRoot: root, exportId: 'bad-digest', files: [wrongDigest] }), 'SNAPSHOT_SOURCE_CHANGED')
  const replacement = join(root, 'replacement')
  await writeFile(replacement, Buffer.alloc(file.bytes, 1))
  renameSync(replacement, join(root, file.sourcePath))
  await expectFailed(root, 'replaced', createEditableSnapshotArchive({ projectRoot: root, exportId: 'replaced', files: [file] }), 'SNAPSHOT_SOURCE_CHANGED')
})

test('detects mutation during the same open source stream and after an earlier source finished', async t => {
  const root = await fixture(t), first = await source(root, 'first.blend', Buffer.alloc(1024 * 1024, 1))
  let mutated = false
  await expectFailed(root, 'in-flight', createEditableSnapshotArchive({ projectRoot: root, exportId: 'in-flight', files: [first],
    onProgress(p) {
      if (p.phase !== 'writing' || mutated) return
      mutated = true
      const otherProcess = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import {openSync,writeSync,closeSync} from 'node:fs'; const fd=openSync(process.argv[1],'r+'); writeSync(fd,Buffer.from('changed'),0,7,Number(process.argv[2])); closeSync(fd)",
        join(root, first.sourcePath), String(first.bytes - 7)], { encoding: 'utf8' })
      assert.equal(otherProcess.status, 0, otherProcess.stderr)
    } }), 'SNAPSHOT_SOURCE_CHANGED')
  const repinned = await pinSnapshotSource(root, first.sourcePath, { bytes: first.bytes, sha256: digest(await readFile(join(root, first.sourcePath))) })
  const second = await source(root, 'second', Buffer.alloc(1024 * 1024, 2))
  mutated = false
  await expectFailed(root, 'early-source', createEditableSnapshotArchive({ projectRoot: root, exportId: 'early-source', files: [{ ...first, ...repinned }, second],
    onProgress(p) {
      if (p.phase !== 'writing' || p.member !== second.path || mutated) return
      mutated = true
      const fd = openSync(join(root, first.sourcePath), 'r+')
      try { writeSync(fd, Buffer.from('changed again')) } finally { closeSync(fd) }
    } }), 'SNAPSHOT_SOURCE_CHANGED')
})

test('cancellation while writing or verifying retains failed state, and the same export id can retry', async t => {
  const root = await fixture(t), file = await source(root, 'model.blend', Buffer.alloc(1024 * 1024, 5))
  for (const phase of ['writing', 'verifying', 'publishing']) {
    const controller = new AbortController()
    await expectFailed(root, phase, createEditableSnapshotArchive({ projectRoot: root, exportId: phase, files: [file], signal: controller.signal,
      onProgress(p) { if (p.phase === phase) controller.abort('test cancellation') } }), 'SNAPSHOT_CANCELLED')
    const retry = await createEditableSnapshotArchive({ projectRoot: root, exportId: phase, files: [file] })
    assert.equal(retry.state, 'ready')
  }
})

test('independent readback detects corrupted archive bytes before ready publication', async t => {
  const root = await fixture(t), file = await source(root, 'model.blend', Buffer.alloc(1024 * 1024, 5))
  let corrupted = false
  await expectFailed(root, 'corrupt', createEditableSnapshotArchive({ projectRoot: root, exportId: 'corrupt', files: [file], onProgress(p) {
    if (p.phase !== 'verifying' || corrupted) return
    corrupted = true
    const staging = readdirSync(join(root, 'exports')).find(name => name.startsWith('.preparing-'))
    const fd = openSync(join(root, 'exports', staging, 'snapshot.zip'), 'r+')
    try { writeSync(fd, Buffer.from([6]), 0, 1, 900000) } finally { closeSync(fd) }
  } }), 'SNAPSHOT_ARCHIVE_MISMATCH')
})

test('a modified external manifest cannot disagree with the ready receipt or the archived manifest', async t => {
  const root = await fixture(t), file = await source(root, 'model.blend', Buffer.alloc(600000, 7))
  await expectFailed(root, 'manifest-change', createEditableSnapshotArchive({ projectRoot: root, exportId: 'manifest-change', files: [file], onProgress(p) {
    if (p.phase !== 'publishing') return
    const staging = readdirSync(join(root, 'exports')).find(name => name.startsWith('.preparing-'))
    const fd = openSync(join(root, 'exports', staging, 'file-manifest.json'), 'r+')
    try { writeSync(fd, Buffer.from('corrupted manifest')) } finally { closeSync(fd) }
  } }), 'SNAPSHOT_ARCHIVE_MISMATCH')
})

test('an injected disk write failure retains diagnosis, never a ready export', async t => {
  const root = await fixture(t), file = await source(root, 'source', Buffer.alloc(1024 * 1024))
  const probe = await open(join(root, 'probe'), 'w')
  const prototype = Object.getPrototypeOf(probe), original = prototype.write
  await probe.close()
  prototype.write = async function () { throw Object.assign(new Error('test disk exhausted'), { code: 'ENOSPC' }) }
  try {
    const error = await expectFailed(root, 'disk-failure', createEditableSnapshotArchive({ projectRoot: root, exportId: 'disk-failure', files: [file] }), 'SNAPSHOT_IO')
    assert.equal(error.cause.code, 'ENOSPC')
  } finally { prototype.write = original }
})

test('concurrent publication and later attempts preserve the original successful archive', async t => {
  const root = await fixture(t), file = await source(root, 'source', Buffer.alloc(1024 * 1024, 5))
  const results = await Promise.allSettled([1, 2].map(() => createEditableSnapshotArchive({ projectRoot: root, exportId: 'same', files: [file] })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SNAPSHOT_EXISTS')
  const ready = results.find(r => r.status === 'fulfilled').value
  const original = await readFile(join(root, ready.archive.path))
  await assert.rejects(createEditableSnapshotArchive({ projectRoot: root, exportId: 'same', files: [file] }), error => error.code === 'SNAPSHOT_EXISTS')
  assert.deepEqual(await readFile(join(root, ready.archive.path)), original)
  assert.equal((await stat(join(root, ready.archive.path))).size, ready.archive.bytes)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'exports/same/ready.json'))), ready)
})

test('a killed writer leaves only incomplete staging; a fresh attempt can publish the fixed files', async t => {
  for (const phase of ['writing', 'before-commit']) {
    const root = await fixture(t), file = await source(root, 'source', Buffer.alloc(1024 * 1024, 3))
    const moduleUrl = new URL('../../../packages/deepblend/host/lib/editable-snapshot-archive.js', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const pause = () => { process.send('paused'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); };
      if(process.argv[3] === 'before-commit') {
        const rename = fs.promises.rename;
        fs.promises.rename = async (...args) => { pause(); return rename(...args); };
        syncBuiltinESMExports();
      }
      const {createEditableSnapshotArchive} = await import(${JSON.stringify(moduleUrl)});
      await createEditableSnapshotArchive({projectRoot: process.argv[1], exportId:'interrupted', files:JSON.parse(process.argv[2]),
        onProgress(p) { if (p.phase === 'writing' && process.argv[3] === 'writing') pause(); }
      });`, root, JSON.stringify([file]), phase], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    t.after(() => child.kill('SIGKILL'))
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child did not reach ' + phase)), 10000)
      child.once('message', () => { clearTimeout(timeout); resolve() })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
    })
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
    assert.equal(existsSync(join(root, 'exports/interrupted')), false)
    const leftovers = readdirSync(join(root, 'exports'))
    assert.equal(leftovers.length, 1, 'no persistent publish lock remains')
    assert.ok(leftovers[0].startsWith('.preparing-'))
    // A ready document in an uncommitted staging directory is never success.
    assert.equal(existsSync(join(root, 'exports', leftovers[0], 'ready.json')), phase === 'before-commit')
    const ready = await createEditableSnapshotArchive({ projectRoot: root, exportId: 'interrupted', files: [file] })
    assert.equal(ready.state, 'ready')
    assert.ok(existsSync(join(root, 'exports', leftovers[0])), 'original interrupted evidence is retained')
  }
})
