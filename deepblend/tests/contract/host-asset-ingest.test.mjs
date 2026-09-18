#!/usr/bin/env node
/**
 * Asset ingest: every way it refuses, and the two ways it reaches off this machine.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `assets.e2e.mjs` drives this path through the composition with real files, and that is why the
 * refusals left in the coverage reading were the ones a well-behaved caller never produces: no source
 * at all, a path that is a DIRECTORY, a local file above the byte cap, and the whole remote half
 * (`_fetchAssetToScratch`) — which was dark because a test that needs the network is a test nobody
 * runs, and because the fetch uses the global `fetch`, so its failures look unreachable from a
 * contract test.
 *
 * They are not unreachable: a `node:http` server on a random loopback port is the real thing, not a
 * stub. The host fetches from it over a real socket, streams a real body, and hits its real HTTP and
 * size branches. Nothing here mocks `fetch`, and nothing leaves the machine.
 *
 * The refusals are worth reading for the same reason every other refusal in this session was: they
 * are what an operator sees when an import does not work, and each one names a DIFFERENT cause
 * (nothing to import / not a file / too big / not a URL / not a protocol / HTTP status / no bytes).
 * A version that answered all of them "the import failed" would pass a test that only checked `ok:false`.
 *
 * DELIBERATELY NOT COVERED, and named so nobody assumes it runs: the post-copy size check in
 * `ingestAsset` compares the bytes on disk after the copy with the same cap checked before it. It can
 * only fire if the source file GROWS between the two `stat` calls, so it is a race guard rather than a
 * rule — reproducing it would mean racing this machine, which measures the machine.
 *
 * Run standalone: `node deepblend/tests/contract/host-asset-ingest.test.mjs`
 * Run all:        `node deepblend/tests/run.mjs`
 */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { ROOT } from '../../tools/workspace-layout.mjs'

// NAMED, NOT PRETENDED COVERED: `ingestAsset` checks the size TWICE — once on the staged copy and once after
// the bytes land in the project (`statSync(destination).size > assetMaxBytes`, which removes the file and throws
// `ASSET_TOO_LARGE`). The second check cannot be driven from a test: it fires only when the file GREW between
// the pre-copy stat and the copy, which is a race against whoever is writing the source — the same shape as the
// `statSync` guard in the provider's `_assertAllowed`. The first check is asserted below, and the second is a
// belt for a source that is still being written while it is ingested.
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

function code(name) {
  const value = BlenderErrorCode[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`BlenderErrorCode.${name} is not a code this build defines — the expectation would be undefined`)
  }
  return value
}

/** A 12-byte Blender-style header for the type the extension claims. */
const glbBytes = Buffer.concat([Buffer.from('glTF', 'latin1'), Buffer.from([2, 0, 0, 0, 12, 0, 0, 0])])

const ASSET_MAX_BYTES = 256
const workspaceRoot = mkdtempSync(join(tmpdir(), 'deepblend-asset-ingest-'))
const outsideRoot = mkdtempSync(join(tmpdir(), 'deepblend-asset-source-'))

const ctx = new Context()
ctx.provide('blenderRuntime', {})
const studio = new BlenderStudio(ctx, StudioConfig({
  workspaceRoot,
  projectsRoot: join(workspaceRoot, 'projects'),
  assetMaxBytes: ASSET_MAX_BYTES,
}))

const project = await studio.transactions.createProject({
  title: 'assets', sceneSpec: JSON.parse(readFileSync(join(ROOT, 'deepblend', 'fixtures', 'product-turntable', 'scene-spec.json'), 'utf8')),
  saveCheckpoint: false,
})
const projectId = project.projectId
const ingestError = request => studio.ingestAsset(request).catch(cause => cause)

// ---------------------------------------------------------------------------
// A real server on a random loopback port: no stubbing, no outside network
// ---------------------------------------------------------------------------

let bodiesServed = 0
const server = createServer((request, response) => {
  if (request.url === '/missing.glb') {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('no such asset')
    return
  }
  if (request.url === '/empty.glb') {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    response.end()
    return
  }
  if (request.url === '/huge.glb') {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    // Sixteen chunks of 64 bytes: the cap is 256, so this is refused three chunks in — the point of
    // capping the STREAM rather than trusting `Content-Length`.
    for (let index = 0; index < 16; index += 1) response.write(Buffer.alloc(64, 7))
    response.end()
    return
  }
  if (request.url === '/model.glb') {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    bodiesServed += 1
    response.end(glbBytes)
    return
  }
  response.writeHead(500)
  response.end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------------------
// The refusals that a well-behaved caller never produces
// ---------------------------------------------------------------------------

const noSource = await ingestError({ projectId })
check('an ingest with nothing to import says which two fields it needs',
  noSource instanceof BlenderError && noSource.code === code('ASSET_SOURCE_NOT_FOUND') &&
  /needs either sourcePath \(a local file\) or sourceUrl \(a remote one\)/.test(noSource.message),
  noSource?.message ?? noSource)

const bothSources = await ingestError({ projectId, sourcePath: '/tmp/x.glb', sourceUrl: `${base}/model.glb` })
check('an ingest that names BOTH a local and a remote source is refused rather than picking one',
  bothSources instanceof BlenderError && bothSources.code === code('ASSET_REQUEST_INVALID') &&
  /not both/.test(bothSources.message),
  bothSources?.message ?? bothSources)

const missingFile = await ingestError({ projectId, sourcePath: join(outsideRoot, 'absent.glb') })
check('a local path that does not exist names the path it resolved to, not the one that was typed',
  missingFile instanceof BlenderError && missingFile.code === code('ASSET_SOURCE_NOT_FOUND') &&
  missingFile.detail?.sourcePath === join(outsideRoot, 'absent.glb') && /^no file at /.test(missingFile.message),
  missingFile?.detail ?? missingFile?.message)

const directory = await ingestError({ projectId, sourcePath: outsideRoot })
check('a DIRECTORY is not an asset: the refusal says it is not a regular file, and where it looked',
  directory instanceof BlenderError && directory.code === code('ASSET_SOURCE_NOT_FOUND') &&
  /is not a regular file\./.test(directory.message) && directory.detail?.sourcePath === outsideRoot,
  directory?.message ?? directory)

const tooBigPath = join(outsideRoot, 'huge-local.glb')
writeFileSync(tooBigPath, Buffer.alloc(ASSET_MAX_BYTES + 1, 3))
const tooBigLocal = await ingestError({ projectId, sourcePath: tooBigPath })
check('a local file above the cap is refused BEFORE it is copied, quoting both numbers',
  tooBigLocal instanceof BlenderError && tooBigLocal.code === code('ASSET_TOO_LARGE') &&
  tooBigLocal.detail?.bytes === ASSET_MAX_BYTES + 1 && tooBigLocal.detail?.maxBytes === ASSET_MAX_BYTES &&
  /above the configured assetMaxBytes of 256 \(SPEC §15\)/.test(tooBigLocal.message),
  tooBigLocal?.detail ?? tooBigLocal?.message)
check('and that refusal left no half-copied asset in the project',
  !existsSync(join(studio.store.projectDirectory(projectId), 'assets', 'raw', 'huge-local.glb')),
  readdirSync(join(studio.store.projectDirectory(projectId), 'assets'), { withFileTypes: true }).map(entry => entry.name))

// ---------------------------------------------------------------------------
// The remote half
// ---------------------------------------------------------------------------

const notAUrl = await ingestError({ projectId, sourceUrl: 'not a url at all', approved: true })
check('a remote source that is not a URL is refused as ASSET_FETCH_FAILED, quoting what was given',
  notAUrl instanceof BlenderError && notAUrl.code === code('ASSET_FETCH_FAILED') &&
  notAUrl.message === '"not a url at all" is not a URL.',
  notAUrl?.message ?? notAUrl)

const wrongProtocol = await ingestError({ projectId, sourceUrl: 'file:///etc/passwd', approved: true })
check('a protocol this will not fetch is refused by name, because "file://" is a real thing to try',
  wrongProtocol instanceof BlenderError && wrongProtocol.code === code('ASSET_FETCH_FAILED') &&
  wrongProtocol.detail?.protocol === 'file:' &&
  /is not a protocol this will fetch; use http or https\./.test(wrongProtocol.message),
  wrongProtocol?.detail ?? wrongProtocol?.message)

const notFound = await ingestError({ projectId, sourceUrl: `${base}/missing.glb`, approved: true })
check('an HTTP status that is not ok is reported with the status, not as "the fetch failed"',
  notFound instanceof BlenderError && notFound.code === code('ASSET_FETCH_FAILED') &&
  notFound.detail?.status === 404 && notFound.detail?.url === `${base}/missing.glb`,
  notFound?.detail ?? notFound?.message)

const empty = await ingestError({ projectId, sourceUrl: `${base}/empty.glb`, approved: true })
check('a 200 with no bytes is refused rather than imported as an empty model',
  empty instanceof BlenderError && empty.code === code('ASSET_FETCH_FAILED') &&
  /answered with no bytes\./.test(empty.message),
  empty?.message ?? empty)

const huge = await ingestError({ projectId, sourceUrl: `${base}/huge.glb`, approved: true })
check('a body that grows past the cap is stopped WHILE streaming, with the number received so far',
  huge instanceof BlenderError && huge.code === code('ASSET_TOO_LARGE') &&
  huge.detail?.received > ASSET_MAX_BYTES && huge.detail?.maxBytes === ASSET_MAX_BYTES &&
  /the download was stopped rather than completed/.test(huge.message),
  huge?.detail ?? huge?.message)
check('and the scratch space of every failed fetch is gone, so the next attempt starts clean',
  readdirSync(join(workspaceRoot, 'tmp')).filter(name => name.startsWith('asset-')).length === 0,
  readdirSync(join(workspaceRoot, 'tmp')))

// Port 1 is closed on every sane machine, so this is a REAL connection failure — the catch that turns
// an unrecognized throw from `fetch` into a coded refusal, rather than letting a TypeError reach a model.
const unreachable = await ingestError({ projectId, sourceUrl: 'http://127.0.0.1:1/model.glb', approved: true })
check('a fetch that cannot reach the host becomes ASSET_FETCH_FAILED, keeping what the network said',
  unreachable instanceof BlenderError && unreachable.code === code('ASSET_FETCH_FAILED') &&
  /could not be fetched: /.test(unreachable.message) && unreachable.detail?.url === 'http://127.0.0.1:1/model.glb',
  unreachable?.message ?? unreachable)

const fetched = await studio.ingestAsset({ projectId, sourceUrl: `${base}/model.glb`, approved: true })
check('a fetch that works lands the bytes in the project, under the name the URL ended with',
  fetched.assetId === 'model' && fetched.type === 'glb' &&
  fetched.path === 'assets/raw/model.glb' && fetched.bytes === glbBytes.length &&
  fetched.source?.kind === 'url' && fetched.source?.url === `${base}/model.glb`,
  { assetId: fetched.assetId, path: fetched.path, source: fetched.source })
const landed = join(studio.store.projectDirectory(projectId), fetched.path)
check('and the sha256 it reports is the hash of the bytes that are actually there',
  statSync(landed).size === glbBytes.length &&
  fetched.sha256 === createHash('sha256').update(readFileSync(landed)).digest('hex'),
  { sha256: fetched.sha256, bytes: statSync(landed).size })
// The whole sentence is pinned because a MODEL reads it and acts on it: it is a ScenePatch fragment,
// and every field in it has to be the one the manifest recorded.
check('it ends by telling the caller how to DECLARE the asset, because ingesting does not change the scene',
  fetched.nextStep ===
    `declare it with blender_scene_patch: {op: "asset.add", asset: {id: "${fetched.assetId}", ` +
      `type: "${fetched.type}", path: "${fetched.path}", sha256: "${fetched.sha256}"}}` &&
  fetched.currentRevision === project.revision.revision,
  { currentRevision: fetched.currentRevision, nextStep: fetched.nextStep })
check('the server was asked exactly once for that file, so the ingest did not re-fetch it',
  bodiesServed === 1, bodiesServed)

// A local ingest of the same bytes: the two sources must produce the same asset record shape.
const localCopy = join(outsideRoot, 'local-model.glb')
writeFileSync(localCopy, glbBytes)
const local = await studio.ingestAsset({ projectId, sourcePath: localCopy, assetId: 'local-model' })
check('a local ingest produces the same record shape, with a local source',
  local.assetId === 'local-model' && local.sha256 === fetched.sha256 &&
  local.source?.kind === 'local' && local.source?.path === localCopy,
  { assetId: local.assetId, source: local.source, sameHash: local.sha256 === fetched.sha256 })

await new Promise(resolve => server.close(resolve))
rmSync(workspaceRoot, { recursive: true, force: true })
rmSync(outsideRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter(entry => entry.ok).length
console.log(`\nHost asset ingest: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
