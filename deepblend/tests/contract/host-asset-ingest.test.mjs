#!/usr/bin/env node
/** Asset imports over real loopback HTTP and local files: content identity,
 * version provenance, hash verification, bounded streaming, cancellation and cleanup.
 * No external network or Blender process is needed for this contract suite.
 */

import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BlenderError, BlenderErrorCode, validateScenePatch } from '@deepblend/dsh-blender-contracts'
import BlenderStudio, { StudioConfig } from '@deepblend/dsh-blender-host'
import { ROOT } from '../../tools/workspace-layout.mjs'

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

import { encodeGlb } from '../lib/glb.mjs'
/** A complete self-contained GLB document for transfer and provenance checks. */
const glbBytes = encodeGlb({ asset: { version: '2.0' } })

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
let finishProgressResponse
const server = createServer((request, response) => {
  if (request.url === '/redirect-once.glb') {
    // A redirect is normal (an S3 region mismatch does it), and the point of the case below is that the host
    // FOLLOWS it while keeping the chain visible rather than handing the decision to the network.
    response.writeHead(302, { location: '/model.glb' })
    response.end()
    return
  }
  if (request.url === '/redirect-forever.glb') {
    response.writeHead(302, { location: '/redirect-forever.glb' })
    response.end()
    return
  }
  if (request.url === '/redirect-nowhere.glb') {
    // A 3xx with no `Location` at all: nothing to follow, and the status is not `ok`, so the caller's own
    // refusal is what answers. Without a case, that arm is dark and nobody knows whether it returns or hangs.
    response.writeHead(302)
    response.end()
    return
  }
  if (request.url === '/redirect-unparseable.glb') {
    // `Location` that is not a URL at all (an unterminated IPv6 host). Relative values are legal and resolve
    // against the current URL, so this is the arm that only a genuinely broken header reaches.
    response.writeHead(302, { location: 'http://[' })
    response.end()
    return
  }
  if (request.url === '/redirect-elsewhere.glb') {
    // The hop nobody approved: a protocol the first check refuses. With `redirect: 'follow'` this never reached
    // the host's own rule; now every hop is checked against it.
    response.writeHead(302, { location: 'ftp://example.invalid/model.glb' })
    response.end()
    return
  }
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
  if (request.url === '/progress.glb') {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    const body = encodeGlb({ asset: { version: '2.0' }, extras: { progress: 'x'.repeat(32) } })
    response.write(body.subarray(0, glbBytes.length))
    finishProgressResponse = () => response.end(body.subarray(glbBytes.length))
    return
  }
  if (request.url === '/slow.glb') {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    response.write(glbBytes)
    return // The client deadline/cancel must close this unfinished response.
  }
  if (request.url === '/race.glb') {
    // A second URL serving the same bytes: the concurrency case below must not disturb the counter that
    // proves `/model.glb` was fetched exactly once.
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    response.end(glbBytes)
    return
  }
  if (request.url?.startsWith('/model.glb')) {
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

// THE LICENCE IS CARRIED, and this is the case that proves the parameter is not decoration: the model sets
// it, the manifest beside the bytes keeps it, the answer returns it, and the `nextStep` declaration it is told
// to write carries it into the SceneSpec — which is the only place a later reader looks for provenance.
const licensedSource = join(outsideRoot, 'licensed.glb')
writeFileSync(licensedSource, glbBytes)
const licensed = await studio.ingestAsset({
  projectId, sourcePath: licensedSource, assetId: 'licensed-asset', license: '  CC-BY-4.0  ',
})
const licensedManifest = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8'))
const licensedEntry = licensedManifest.assets.find(entry => entry.assetId === 'licensed-asset')
check('an ingested licence is TRIMMED, recorded in the manifest and returned, because the tool promised it',
  licensed.license === 'CC-BY-4.0' && licensedEntry?.license === 'CC-BY-4.0' &&
  licensed.nextStep.includes('license: {"source":"CC-BY-4.0"}'),
  { returned: licensed.license, manifest: licensedEntry?.license })
const unlicensed = await studio.ingestAsset({
  projectId, sourcePath: licensedSource, assetId: 'unlicensed-asset',
})
const unlicensedEntry = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8'))
  .assets.find(entry => entry.assetId === 'unlicensed-asset')
// THE ADVICE IS PUT BACK THROUGH THE VALIDATOR. A sentence that tells the model to write something the
// schema refuses is worse than no sentence: the model follows it, gets `SCENE_PATCH_INVALID`, and has no way
// to know which of the two is wrong. The first version of this advice printed `license: "CC-BY-4.0"` — a bare
// string where the schema wants `{source, commercialUse, attribution}` — and the patch schema ALSO had a
// dangling `$ref` for that field, so following the advice threw a schema-definition error from inside the
// validator. Both are fixed; this is the assertion that keeps the pair fixed together, built from the
// answer's own fields rather than by parsing the prose.
const expectedDeclaration =
  `{op: "asset.add", asset: {id: "${licensed.assetId}", type: "${licensed.type}", ` +
  `path: "${licensed.path}", sha256: "${licensed.sha256}", license: {"source":"CC-BY-4.0"}}}`
const adviceVerdict = validateScenePatch({
  projectId,
  baseRevision: 'r0001',
  operations: [{
    op: 'asset.add',
    asset: {
      id: licensed.assetId, type: licensed.type, path: licensed.path, sha256: licensed.sha256,
      license: { source: licensed.license },
    },
  }],
})
check('the declaration the answer TELLS the caller to write is the one it can actually write',
  licensed.nextStep.includes(expectedDeclaration), { nextStep: licensed.nextStep })
check('and that declaration is one the patch schema accepts (advice that cannot be followed is worse than none)',
  adviceVerdict.ok === true, adviceVerdict.errors?.slice(0, 2) ?? null)

check('and an asset nobody licensed records `null` rather than a missing field, so the two facts stay apart',
  unlicensed.license === null && unlicensedEntry?.license === null &&
  !unlicensed.nextStep.includes('license:'),
  { returned: unlicensed.license, manifest: unlicensedEntry?.license })

// TWO REMOTE INGESTS AT ONCE, which is the only way this path can interleave: a remote source awaits the
// network, so two calls can be in flight together and both reach the manifest's read-modify-write. The
// manifest is read, modified and written with NO `await` in between — which is what makes the pair safe, and
// which is a property rather than an accident: inserting an `await` there (making the hash async, say) would
// turn one of these two entries into a silent lost update, and nothing else in this file would notice.
const concurrent = await Promise.all([
  studio.ingestAsset({ projectId, sourceUrl: `${base}/race.glb`, assetId: 'race-one', approved: true }),
  studio.ingestAsset({ projectId, sourceUrl: `${base}/race.glb`, assetId: 'race-two', approved: true }),
])
const afterRace = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8'))
// THE HAPPY PATH'S SCRATCH, which nothing had ever asked about: the existing check below is named "of every
// FAILED fetch", and it was telling the truth — but a successful remote ingest left its scratch directory
// behind, holding a second copy of bytes already in `assets/raw/`. MEASURED with one ingest against a loopback
// server: `tmp/asset-<uuid>/` was still there afterwards. The fix is a `finally`; this is the assertion that
// keeps it.
const scratchAfterSuccess = existsSync(join(workspaceRoot, 'tmp'))
  ? readdirSync(join(workspaceRoot, 'tmp'))
  : []
// AND THE OTHER SIDE OF THE SAME CLEANUP, which is the dangerous one: the scratch removal must never touch a
// LOCAL source, because that file belongs to the caller. The mutation that sets `fetchedScratch` for a local
// source is caught by the whole file falling over, but the property deserves its own sentence.
const localSource = join(outsideRoot, 'keep-me.glb')
writeFileSync(localSource, glbBytes)
await studio.ingestAsset({ projectId, sourcePath: localSource, assetId: 'kept-local' })
check('a LOCAL source is never deleted by the scratch cleanup, because that file is the caller\u2019s',
  existsSync(localSource) && readFileSync(localSource).equals(glbBytes),
  { exists: existsSync(localSource) })

check('a SUCCESSFUL remote ingest leaves no scratch behind either, because the bytes are already copied',
  scratchAfterSuccess.length === 0,
  scratchAfterSuccess)

// Identical content shares one object while each independently named alias survives.
check('concurrent identical ingests preserve both aliases and deduplicate their bytes',
  concurrent.every(entry => entry.assetId !== undefined) && concurrent[0].path === concurrent[1].path &&
  afterRace.assets.filter(entry => entry.assetId.startsWith('race-')).length === 2 &&
  afterRace.assets.every(entry => existsSync(join(studio.store.projectDirectory(projectId), entry.path))),
  { manifestIds: afterRace.assets.map(entry => entry.assetId) })

// A PRESIGNED URL IS THE ORDINARY CASE, not the exotic one: the link a model is handed for a model file
// usually carries its own signature in the query. Every message this path produces also lands in a job record
// and in the model's transcript, so the raw URL is a credential being copied around. The check asserts BOTH
// that the secret is absent and that the removal is visible — a reader comparing the message with what they
// pasted has to be able to tell a cleaned URL from one that never had a query.
const unapprovedSigned = await ingestError({
  projectId,
  sourceUrl: `${base}/model.glb?signature=approval-secret`,
})
check('an unapproved signed URL is redacted in both the error message and detail',
  unapprovedSigned.code === code('ASSET_APPROVAL_REQUIRED') &&
  !JSON.stringify({ message: unapprovedSigned.message, detail: unapprovedSigned.detail }).includes('approval-secret') &&
  unapprovedSigned.detail.sourceUrl === `${base}/model.glb (query removed)`)

const presigned = await ingestError({
  projectId,
  sourceUrl: `${base}/missing.glb?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAEXAMPLE`,
  approved: true,
})
check('a failed fetch of a PRESIGNED url quotes it with the signature removed, and says so',
  presigned instanceof BlenderError && presigned.code === code('ASSET_FETCH_FAILED') &&
  !presigned.message.includes('deadbeefcafe') && !presigned.message.includes('AKIAEXAMPLE') &&
  presigned.message.includes(`${base}/missing.glb (query removed)`) &&
  !String(presigned.detail?.url ?? '').includes('deadbeefcafe') &&
  presigned.detail?.url === `${base}/missing.glb (query removed)`,
  { message: presigned?.message, url: presigned?.detail?.url })

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
  /the transfer was stopped/.test(huge.message),
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
check('a fetch stores the bytes at a path determined by their digest',
  fetched.assetId === 'model' && fetched.type === 'glb' &&
  fetched.path === `assets/raw/${fetched.sha256}.glb` && fetched.bytes === glbBytes.length &&
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

// ---------------------------------------------------------------------------
// Two ingests of the SAME FILE NAME at once
// ---------------------------------------------------------------------------
//
// Same name, different bytes: both objects and their history must survive.
{
  const firstSource = join(outsideRoot, 'a', 'twin.glb')
  const secondSource = join(outsideRoot, 'b', 'twin.glb')
  mkdirSync(join(outsideRoot, 'a'), { recursive: true })
  mkdirSync(join(outsideRoot, 'b'), { recursive: true })
  // Small enough for the fixture's 256-byte cap, different enough that a mixture is detectable.
  const firstBytes = encodeGlb({ asset: { version: '2.0' }, extras: { variant: 'first' } })
  const secondBytes = encodeGlb({ asset: { version: '2.0' }, extras: { variant: 'other' } })
  writeFileSync(firstSource, firstBytes)
  writeFileSync(secondSource, secondBytes)

  const [left, right] = await Promise.all([
    studio.ingestAsset({ projectId, sourcePath: firstSource, assetId: 'twin-left' }).catch(cause => cause),
    studio.ingestAsset({ projectId, sourcePath: secondSource, assetId: 'twin-right' }).catch(cause => cause),
  ])
  check('concurrent different files with one name preserve BOTH versions',
    left.path !== right.path && readFileSync(join(studio.store.projectDirectory(projectId), left.path)).equals(firstBytes) &&
    readFileSync(join(studio.store.projectDirectory(projectId), right.path)).equals(secondBytes))
  const replaced = await studio.ingestAsset({ projectId, sourcePath: secondSource, assetId: 'twin-left' })
  const manifest = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8'))
  check('replacing an alias preserves its old bytes and both provenance versions',
    replaced.path === right.path && readFileSync(join(studio.store.projectDirectory(projectId), left.path)).equals(firstBytes) &&
    manifest.versions.filter(entry => entry.assetId === 'twin-left').length === 2 &&
    manifest.assets.find(entry => entry.assetId === 'twin-left').path === right.path)
  await studio.ingestAsset({ projectId, sourcePath: secondSource, assetId: 'twin-left', license: 'CC0-1.0' })
  const changedProvenance = JSON.parse(readFileSync(join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8'))
  const history = changedProvenance.versions.filter(entry => entry.assetId === 'twin-left' && entry.path === right.path)
  check('new provenance for identical bytes does not erase the prior provenance record',
    history.length === 2 && history.some(entry => entry.license === null) && history.some(entry => entry.license === 'CC0-1.0'))

}

// ---------------------------------------------------------------------------
// A declared hash has to be the FILE's hash
// ---------------------------------------------------------------------------// ---------------------------------------------------------------------------
// A declared hash has to be the FILE's hash
// ---------------------------------------------------------------------------
//
// `blender_asset_ingest` computes the sha256 of what it wrote and tells the caller to declare that number in
// `asset.add`. Nothing compared the two: the patch applier is a pure function over documents (no filesystem, which
// is the right shape for it), and the compiler never reads `assets[].sha256`. So a patch could store provenance
// that is simply false, and the delivery manifest and any human auditing the scene would trust it.
{
  const wrongHash = await studio.transactions.applyScenePatch({
    projectId,
    baseRevision: studio.store.readRecord(projectId).currentRevision,
    idempotencyKey: 'declared-wrong-hash',
    operations: [{
      op: 'asset.add',
      asset: { id: 'declared', type: 'glb', path: fetched.path, sha256: 'b'.repeat(64) },
    }],
    saveCheckpoint: false,
  }).catch(cause => cause)
  check('a patch declaring a hash that is not the file\u2019s is REFUSED, naming both numbers',
    wrongHash instanceof BlenderError && wrongHash.code === code('ASSET_HASH_MISMATCH') &&
    wrongHash.detail?.declared === 'b'.repeat(64) &&
    /^[0-9a-f]{64}$/.test(wrongHash.detail?.actual ?? '') &&
    /Nothing was committed/.test(wrongHash.message),
    wrongHash?.code === undefined ? wrongHash : { code: wrongHash.code, declared: wrongHash.detail?.declared?.slice(0, 8), actual: wrongHash.detail?.actual?.slice(0, 8) })

  // The honest declaration goes through, which is what makes the refusal a check rather than a wall.
  const actualHash = createHash('sha256').update(readFileSync(join(studio.store.projectDirectory(projectId), fetched.path))).digest('hex')
  const rightHash = await studio.transactions.applyScenePatch({
    projectId,
    baseRevision: studio.store.readRecord(projectId).currentRevision,
    idempotencyKey: 'declared-right-hash',
    operations: [{
      op: 'asset.add',
      asset: { id: 'declared', type: 'glb', path: fetched.path, sha256: actualHash },
    }],
    saveCheckpoint: false,
  })
  // Read the committed document back through the store rather than through the response: the response's shape is
  // the transaction's, and the question here is what was WRITTEN.
  const committed = studio.store.readRevisionSpec(projectId, rightHash.revision.revision)
  check('and the hash the ingest actually reported is accepted, so the rule is a check and not a wall',
    rightHash.revision?.revision !== undefined &&
    (committed.assets ?? []).some(asset => asset.id === 'declared' && asset.sha256 === actualHash),
    (committed.assets ?? []).map(asset => `${asset.id}:${asset.sha256?.slice(0, 8)}`))

  // A path with no file is left to the compiler: declaring an asset before its bytes exist is a different
  // question, and answering it here would refuse a flow that works.
  const noFile = await studio.transactions.applyScenePatch({
    projectId,
    baseRevision: studio.store.readRecord(projectId).currentRevision,
    idempotencyKey: 'declared-later',
    operations: [{
      op: 'asset.add',
      asset: { id: 'later', type: 'glb', path: 'assets/raw/not-yet.glb', sha256: 'c'.repeat(64) },
    }],
    saveCheckpoint: false,
  })
  check('an asset whose file does not exist yet is NOT refused here: that question belongs to the compiler',
    noFile.revision?.revision !== undefined, noFile?.code ?? 'committed')
}

// Unchanged asset declarations are rechecked on unrelated edits.
{
  const pinnedPath = join(studio.store.projectDirectory(projectId), fetched.path)
  const original = readFileSync(pinnedPath)
  const before = studio.store.readRecord(projectId).currentRevision
  writeFileSync(pinnedPath, Buffer.concat([original, Buffer.from('changed')]))
  const failed = await studio.transactions.applyScenePatch({ projectId, baseRevision: before,
    operations: [{ op: 'entity.visibility.set', entityId: studio.store.readRevisionSpec(projectId, before).entities[0].id, visible: false }],
    saveCheckpoint: false }).catch(error => error)
  check('a changed pinned asset blocks an unrelated patch without moving the revision',
    failed.code === 'ASSET_HASH_MISMATCH' && studio.store.readRecord(projectId).currentRevision === before)
  const refusedOverwrite = await ingestError({ projectId, sourcePath: localSource })
  check('reingest refuses to overwrite a corrupted content-addressed object', refusedOverwrite.code === 'ASSET_HASH_MISMATCH')
  writeFileSync(pinnedPath, original)
}
const secretFetch = await studio.ingestAsset({ projectId, sourceUrl: `${base}/model.glb?signature=test-secret`, approved: true })
const savedManifest = readFileSync(join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8')
check('successful source provenance also redacts signed URL query values',
  !JSON.stringify(secretFetch).includes('test-secret') && !savedManifest.includes('test-secret'))

let streamFinished = false
const streaming = studio.ingestAsset({ projectId, sourceUrl: `${base}/progress.glb`, approved: true })
  .finally(() => { streamFinished = true })
let sawPartialFile = false
for (let attempt = 0; attempt < 100 && !sawPartialFile; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
  const partial = readdirSync(join(workspaceRoot, 'tmp')).filter(name => name.startsWith('asset-'))
  sawPartialFile = partial.some(name => {
    const path = join(workspaceRoot, 'tmp', name, 'download')
    return existsSync(path) && statSync(path).size >= glbBytes.length
  })
}
check('download bytes reach disk before the server finishes its response', sawPartialFile && !streamFinished)
finishProgressResponse?.()
const streamed = await streaming
check('a streamed object hash describes exactly the published bytes',
  streamed.sha256 === createHash('sha256').update(readFileSync(join(studio.store.projectDirectory(projectId), streamed.path))).digest('hex'))

const originalTimeout = studio.config.assetFetchTimeoutMs
studio.config.assetFetchTimeoutMs = 40
const deadlineStarted = Date.now()
const timedOut = await ingestError({ projectId, sourceUrl: `${base}/slow.glb`, approved: true })
studio.config.assetFetchTimeoutMs = originalTimeout
check('a stalled body hits the asset deadline and removes its partial scratch file',
  timedOut.code === 'ASSET_FETCH_FAILED' && /timed out/.test(timedOut.message) && Date.now() - deadlineStarted < 2000 &&
  readdirSync(join(workspaceRoot, 'tmp')).filter(name => name.startsWith('asset-')).length === 0)
const abort = new AbortController()
const cancelTimer = setTimeout(() => abort.abort(), 40)
const cancelled = await ingestError({ projectId, sourceUrl: `${base}/slow.glb`, approved: true, signal: abort.signal })
clearTimeout(cancelTimer)
check('cancelling a streaming asset removes its partial bytes',
  cancelled.code === 'ASSET_FETCH_FAILED' && /cancelled/.test(cancelled.message) &&
  readdirSync(join(workspaceRoot, 'tmp')).filter(name => name.startsWith('asset-')).length === 0)

// ---------------------------------------------------------------------------
// Redirects: followed, bounded, and VISIBLE
// ---------------------------------------------------------------------------
//
// MEASURED before this round: the only URL check was the protocol of the ORIGINAL url, and the fetch used
// `redirect: 'follow'` — so a server answering `302 Location: …` moved the request wherever it liked, including
// to this machine's own services, and the human who approved the URL never saw it. The approval gate is the
// control for "fetch this URL"; a redirect made that control's subject a lie.
{
  const redirected = await studio.ingestAsset({
    projectId, sourceUrl: `${base}/redirect-once.glb`, assetId: 'redirected', approved: true,
  })
  check('a redirect is FOLLOWED (an S3 region mismatch is normal) and where it went is part of the result',
    typeof redirected.sha256 === 'string' && redirected.redirectedFrom?.hops === 1 &&
    redirected.redirectedFrom.chain.length === 2 &&
    /redirect-once\.glb$/.test(redirected.redirectedFrom.chain[0]) &&
    /model\.glb$/.test(redirected.redirectedFrom.chain[1]),
    redirected.redirectedFrom ?? redirected)

  // AND THE MANIFEST KEEPS IT, because the manifest is the copy a later reader trusts: the tool result is gone
  // when the conversation ends, and "which URL did these bytes come from?" is exactly the question a provenance
  // record exists to answer.
  const redirectManifest = JSON.parse(readFileSync(
    join(studio.store.projectDirectory(projectId), 'assets', 'manifest.json'), 'utf8',
  ))
  const redirectEntry = (redirectManifest.assets ?? []).find(entry => entry.assetId === 'redirected')
  check('and the asset manifest records BOTH the approved URL and the one that answered',
    /redirect-once\.glb$/.test(redirectEntry?.source?.url ?? '') &&
    /model\.glb$/.test(redirectEntry?.source?.resolvedUrl ?? ''),
    redirectEntry?.source ?? redirectEntry)

  const endless = await studio.ingestAsset({
    projectId, sourceUrl: `${base}/redirect-forever.glb`, assetId: 'endless', approved: true,
  }).catch(cause => cause)
  check('a server that redirects forever is REFUSED after a bounded number of hops, not followed',
    endless instanceof BlenderError && endless.code === code('ASSET_FETCH_FAILED') &&
    /redirected more than \d+ times/.test(endless.message) &&
    Array.isArray(endless.detail?.chain) && endless.detail.chain.length > 1,
    endless?.code === undefined ? endless : { code: endless.code, hops: endless.detail?.chain?.length })

  const nowhere = await studio.ingestAsset({
    projectId, sourceUrl: `${base}/redirect-nowhere.glb`, assetId: 'nowhere', approved: true,
  }).catch(cause => cause)
  check('a 3xx with no Location is not a redirect: it is answered by the caller\u2019s own HTTP-status refusal',
    nowhere instanceof BlenderError && nowhere.code === code('ASSET_FETCH_FAILED') &&
    /answered HTTP 302/.test(nowhere.message),
    nowhere?.code === undefined ? nowhere : { code: nowhere.code, message: nowhere.message.slice(0, 60) })

  const unparseable = await studio.ingestAsset({
    projectId, sourceUrl: `${base}/redirect-unparseable.glb`, assetId: 'unparseable', approved: true,
  }).catch(cause => cause)
  check('a Location that is not a URL is refused with the value it could not read',
    unparseable instanceof BlenderError && unparseable.code === code('ASSET_FETCH_FAILED') &&
    /which is not a URL/.test(unparseable.message) && unparseable.detail?.location === 'http://[',
    unparseable?.code === undefined ? unparseable : { code: unparseable.code, location: unparseable.detail?.location })

  const elsewhere = await studio.ingestAsset({
    projectId, sourceUrl: `${base}/redirect-elsewhere.glb`, assetId: 'elsewhere', approved: true,
  }).catch(cause => cause)
  check('a redirect to a protocol the FIRST check refuses is refused at the hop too',
    elsewhere instanceof BlenderError && elsewhere.code === code('ASSET_FETCH_FAILED') &&
    /only http and https are followed, on the first URL and on every hop after it/.test(elsewhere.message) &&
    elsewhere.detail?.protocol === 'ftp:',
    elsewhere?.code === undefined ? elsewhere : { code: elsewhere.code, protocol: elsewhere.detail?.protocol })
}

const pngSource = join(outsideRoot, 'albedo.png')
writeFileSync(pngSource, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'))
const pngAsset = await studio.ingestAsset({ projectId, sourcePath: pngSource, assetId: 'albedo' })
check('PNG maps use content-addressed asset storage and return a valid scene declaration',
  pngAsset.type === 'png' && pngAsset.path === `assets/raw/${pngAsset.sha256}.png` &&
  existsSync(join(studio.store.projectDirectory(projectId), pngAsset.path)))
const wrongImage = await ingestError({ projectId, sourcePath: pngSource, type: 'jpg' })
check('PNG bytes declared as JPEG are refused', wrongImage.code === code('ASSET_CONTENT_MISMATCH'))
for (const [type, bytes] of [['hdr', Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n')],
  ['exr', Buffer.from([0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0])]]) {
  const source = join(outsideRoot, `environment.${type}`)
  writeFileSync(source, bytes)
  const imported = await studio.ingestAsset({ projectId, sourcePath: source, assetId: `environment-${type}` })
  check(`${type} signatures pass the ingest gate and receive a content-addressed path`,
    imported.type === type && imported.path === `assets/raw/${imported.sha256}.${type}`)
}

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
