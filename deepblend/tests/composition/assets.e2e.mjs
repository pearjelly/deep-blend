#!/usr/bin/env node
/**
 * M5 — the asset policy: SPEC §11's `blender_asset_ingest`, both halves of it.
 *
 * WHY THIS EXISTS
 * ---------------
 * SPEC §11 gives this tool the permission "本地自动，网络需审批" — local automatic,
 * network requires approval — and SPEC §13's project tree has carried
 * `assets/{raw,normalized,textures,manifest.json}` since M1. The CONSUMER half was
 * built then. The producer could not be, and the reason is the interesting part:
 * `assets` had no patch operation, so a scene could declare assets only if the
 * document that CREATED the project already had them, and an ingest would have had
 * nothing to attach its result to. M5 added `asset.add` / `asset.remove` to the
 * vocabulary; this suite covers the pair.
 *
 * WHAT IT ASSERTS, AND WHY EACH PAIR IS TWO-SIDED
 * ----------------------------------------------
 * The approval half is the same shape as the render gate (D87–D88), and the network
 * cases below are the ones that read most like "we could not ask, so carry on":
 * a denial, an answerer that throws, and a deployment with no approval service at
 * all. Every one of them must leave NOTHING on disk, which is what the second half of
 * each pair checks.
 *
 * The remote cases run against a real HTTP server on 127.0.0.1, because the subject
 * is the fetch: its byte cap is applied while READING, so a test that stubbed the
 * fetch would be testing the stub. One of the cases is a server that keeps sending
 * past the cap on purpose.
 *
 * Run: node deepblend/tests/composition/assets.e2e.mjs
 *
 * Owner: DeepBlend Studio — M5
 */

import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const MAX_BYTES = 4096

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'deepblend-assets-'))

/** The tool registry seam, plus a recording approval service whose answer we choose. */
function seams(record, answer) {
  const registered = new Map()
  return {
    registered,
    registry: {
      name: 'tool-registry-stub',
      apply(ctx) {
        ctx.provide('tools', {
          register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) },
          get(name) { return registered.get(name) },
          schemas() { return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })) },
          async execute(input) {
            const definition = registered.get(input.name)
            if (definition === undefined) throw new Error(`UNKNOWN_TOOL ${input.name}`)
            try {
              const value = await definition.execute(input.arguments ?? {}, { ...input, def: definition, deferContext() {}, concludeTurn() {} })
              return { isError: false, value, content: definition.output.render(input.arguments, value) }
            } catch (error) {
              return { isError: true, error: { message: error?.message ?? String(error), info: { name: 'BlenderError', code: error?.code ?? 'UNKNOWN' } }, content: [] }
            }
          },
          restrict() { return () => {} },
          guard() { return () => {} },
        })
        if (answer === 'missing') return
        ctx.provide('approval', {
          async request(req) {
            record.asked.push({ toolName: req.toolName, reason: req.reason })
            if (answer === 'throws') throw new Error('no answerer is composed')
            return answer
          },
        })
      },
    },
  }
}

let port = 0
/**
 * A real HTTP server, because the subject IS the fetch.
 *
 * `/model.glb` answers with a small body; `/endless.glb` answers 200 with no
 * `Content-Length` and then keeps writing — the case that makes "cap the stream" and
 * "trust the header" different implementations.
 */
const server = createServer((request, response) => {
  if (request.url === '/endless.glb') {
    response.writeHead(200, { 'content-type': 'model/gltf-binary' })
    const chunk = Buffer.alloc(1024, 0x61)
    let sent = 0
    const pump = () => {
      if (sent > MAX_BYTES * 4 || response.destroyed) return response.end()
      sent += chunk.byteLength
      if (response.write(chunk)) setImmediate(pump)
      else response.once('drain', pump)
    }
    pump()
    return
  }
  if (request.url === '/missing.glb') {
    response.writeHead(404)
    return response.end('nope')
  }
  const body = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 0x20)])
  response.writeHead(200, { 'content-type': 'model/gltf-binary', 'content-length': String(body.byteLength) })
  response.end(body)
})
await new Promise(ready => server.listen(0, '127.0.0.1', ready))
port = server.address().port
const url = path => `http://127.0.0.1:${port}${path}`

const spec = JSON.parse(readFileSync(join(PROJECT_ROOT, 'deepblend', 'fixtures', 'interior-room', 'scene-spec.json'), 'utf8'))

/** Boot a host + tool plane. `answer` picks what the operator does. */
async function boot(answer) {
  const record = { asked: [] }
  const { registry, registered } = seams(record, answer)
  const root = new Context()
  root.plugin(registry)
  root.plugin(LocalSubprocess)
  root.plugin((await import('@deepblend/dsh-blender-provider-local')).default, {
    blenderPath: process.env.DEEPBLEND_BLENDER_PATH
      ?? join(PROJECT_ROOT, '.tools', 'Blender.app', 'Contents', 'MacOS', 'Blender'),
    bootstrapPath: join(PROJECT_ROOT, 'packages', 'deepblend', 'provider-local', 'python', 'bootstrap.py'),
    workspaceRoot: scratch,
    timeoutMs: 180_000,
  })
  root.plugin((await import('@deepblend/dsh-blender-host')).default, {
    workspaceRoot: scratch,
    projectsRoot: join(scratch, `projects-${answer}`),
    assetMaxBytes: MAX_BYTES,
  })
  root.plugin(await import('@deepblend/dsh-blender-tool'))
  await new Promise(settle => setTimeout(settle, 400))
  return { root, record, registry: root.get('tools'), registered, studio: root.get('blenderStudio') }
}

async function callTool(registry, name, args) {
  return registry.execute({
    name,
    arguments: args,
    callId: `call-${name}-${Math.random().toString(16).slice(2, 8)}`,
    signal: undefined,
    agent: { id: 'session-assets-suite' },
  })
}

const localSource = join(scratch, 'Widget Model.glb')
writeFileSync(localSource, Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 0x20)]))
const oversized = join(scratch, 'Huge.fbx')
writeFileSync(oversized, Buffer.alloc(MAX_BYTES + 1, 0x62))
const wrongFormat = join(scratch, 'notes.txt')
writeFileSync(wrongFormat, 'not a model')
// A PNG wearing a .glb name. The extension check cannot see this: the type is importable, so
// only the content gate added in M5 (SPEC §15.2 "MIME 与扩展名双重校验") refuses it.
const mislabeled = join(scratch, 'Actually a picture.glb')
writeFileSync(mislabeled, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]))
// …and its mirror image: a real glTF that is CALLED something else. The content gate must not
// refuse this one, or the check would be rejecting files that are exactly what they need to be.
const emptyFile = join(scratch, 'Empty.glb')
writeFileSync(emptyFile, Buffer.alloc(0))
const misnamed = join(scratch, 'model-with-no-extension')
writeFileSync(misnamed, Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 0x20)]))

// ---------------------------------------------------------------------------
// 1. Local: automatic, and the descriptor it returns is the one a patch accepts
// ---------------------------------------------------------------------------
try {
  const session = await boot('rejected')
  try {
    await session.studio.createProject({ projectId: 'local', title: 'Local', goal: 'g', sceneSpec: spec, saveCheckpoint: false, renderPreview: false })

    const ingested = await callTool(session.registry, 'blender_asset_ingest', { projectId: 'local', sourcePath: localSource })
    check('a LOCAL asset needs no approval and is ingested directly',
      ingested.value?.ok === true && session.record.asked.length === 0,
      { ok: ingested.value?.ok, asked: session.record.asked.length, why: ingested.value?.data?.errorCode ?? String(ingested.value?.text ?? '').split('\n').slice(0, 3).join(' ') })

    const data = ingested.value?.data ?? {}
    check('it lands in assets/raw/ under a project-relative path',
      typeof data.path === 'string' && data.path.startsWith('assets/raw/'), data.path)
    check('the bytes on disk are the bytes of the source',
      existsSync(join(session.studio.store.projectDirectory('local'), data.path))
      && statSync(join(session.studio.store.projectDirectory('local'), data.path)).size === statSync(localSource).size,
      data.bytes)
    check('it reports a sha256 the scene can pin',
      /^[a-f0-9]{64}$/.test(data.sha256 ?? ''), data.sha256)
    check('the id is derived from the file name, reduced to the id grammar',
      data.assetId === 'Widget-Model', data.assetId)

    // The manifest is a ledger beside the bytes, not a second source of truth.
    const manifest = JSON.parse(readFileSync(join(session.studio.store.projectDirectory('local'), 'assets', 'manifest.json'), 'utf8'))
    check('the manifest records what was ingested, from where, and its digest',
      manifest.assets?.length === 1 && manifest.assets[0].sha256 === data.sha256
      && manifest.assets[0].source?.kind === 'local',
      manifest.assets?.[0]?.assetId)

    check('ingesting does NOT commit a revision — the scene changes through one path only',
      (await session.studio.getProject('local')).revisions.length === 1,
      (await session.studio.getProject('local')).revisions.map(entry => entry.revision))

    // THE OTHER DIRECTION OF THE CONTENT GATE, and the one that matters more: it must not
    // refuse a file that is exactly what it needs to be. This glTF is called something with
    // no extension at all, so the caller states the type — and the bytes agree with it.
    const renamed = await callTool(session.registry, 'blender_asset_ingest', {
      projectId: 'local',
      sourcePath: misnamed,
      type: 'glb',
      assetId: 'model-with-no-extension',
    })
    check('a real glTF called something else is accepted once its type is stated',
      renamed.value?.ok === true,
      renamed.value?.data?.errorCode ?? String(renamed.value?.text ?? '').split('\n').slice(0, 2).join(' '))

    // And the descriptor is usable exactly as reported.
    const declared = await session.studio.applyScenePatch({
      projectId: 'local',
      baseRevision: 'r0001',
      operations: [
        { op: 'asset.add', asset: { id: data.assetId, type: data.type, path: data.path, sha256: data.sha256 } },
        { op: 'entity.add', entity: { id: 'widget', type: 'asset-instance', assetId: data.assetId } },
      ],
      note: 'assets suite: declare and instantiate the ingested asset',
      saveCheckpoint: false,
    })
    check('the returned descriptor is accepted by asset.add and can be instantiated',
      declared.revision === 'r0002', declared.revision ?? declared.errorCode)
    // NOTE: the facade takes the project id POSITIONALLY and the rest as options —
    // measured, after the first version passed one object and got a
    // "project id must be a non-empty string" from three frames down.
    const stored = await session.studio.getScene('local', { revision: 'r0002', full: true })
    check('the committed SceneSpec carries the asset and the entity that uses it',
      stored.spec?.assets?.[0]?.sha256 === data.sha256
      && stored.spec?.entities?.some(entity => entity.assetId === data.assetId),
      stored.spec?.assets?.length)
  } finally {
    await session.root.stop?.()
  }
} catch (cause) {
  check('the local ingest section completed without an unexpected throw', false, cause?.stack ?? String(cause))
}

// ---------------------------------------------------------------------------
// 2. The local policy: size, format, existence
// ---------------------------------------------------------------------------
try {
  const session = await boot('rejected')
  try {
    await session.studio.createProject({ projectId: 'policy', title: 'Policy', goal: 'g', sceneSpec: spec, saveCheckpoint: false, renderPreview: false })
    const before = (await session.studio.getProject('policy')).revisions.length

    for (const [label, args, expected] of [
      ['a source above assetMaxBytes', { projectId: 'policy', sourcePath: oversized }, 'ASSET_TOO_LARGE'],
      ['a source that does not exist', { projectId: 'policy', sourcePath: join(scratch, 'ghost.glb') }, 'ASSET_SOURCE_NOT_FOUND'],
      ['a format this project cannot carry', { projectId: 'policy', sourcePath: wrongFormat }, 'ASSET_FORMAT_UNAVAILABLE'],
      ['a .glb whose bytes are a PNG', { projectId: 'policy', sourcePath: mislabeled, type: 'glb' }, 'ASSET_CONTENT_MISMATCH'],
      ['an empty .glb', { projectId: 'policy', sourcePath: emptyFile }, 'ASSET_CONTENT_MISMATCH'],
      ['neither source', { projectId: 'policy' }, 'ASSET_REQUEST_INVALID'],
      ['both sources at once', { projectId: 'policy', sourcePath: localSource, sourceUrl: url('/model.glb') }, 'ASSET_REQUEST_INVALID'],
      ['an assetId that is a path segment', { projectId: 'policy', sourcePath: localSource, assetId: '../escape' }, 'PATH_SEGMENT_INVALID'],
      ['an unknown project', { projectId: 'ghost', sourcePath: localSource }, 'PROJECT_NOT_FOUND'],
    ]) {
      const refused = await callTool(session.registry, 'blender_asset_ingest', args)
      check(`${label} is refused with ${expected}`,
        refused.value?.ok === false && (refused.value?.data?.errorCode === expected || refused.value?.data?.code === expected),
        refused.value?.data?.errorCode ?? refused.value?.data?.code ?? JSON.stringify(refused.value?.data ?? refused.error).slice(0, 80))
    }

    check('and none of those refusals wrote anything into the project',
      !existsSync(join(session.studio.store.projectDirectory('policy'), 'assets', 'manifest.json'))
      && (await session.studio.getProject('policy')).revisions.length === before,
      before)
  } finally {
    await session.root.stop?.()
  }
} catch (cause) {
  check('the local policy section completed without an unexpected throw', false, cause?.stack ?? String(cause))
}

// ---------------------------------------------------------------------------
// 3. Remote: approved, and every answer that is not a grant
// ---------------------------------------------------------------------------
try {
  const session = await boot('allowed-once')
  try {
    await session.studio.createProject({ projectId: 'remote', title: 'Remote', goal: 'g', sceneSpec: spec, saveCheckpoint: false, renderPreview: false })

    const fetched = await callTool(session.registry, 'blender_asset_ingest', { projectId: 'remote', sourceUrl: url('/model.glb') })
    check('a REMOTE asset asks the approval plane and is ingested when it grants',
      fetched.value?.ok === true && session.record.asked.length === 1,
      { ok: fetched.value?.ok, asked: session.record.asked.length, code: fetched.value?.data?.errorCode })
    check('the ask names the tool and states the address and the size cap',
      session.record.asked[0]?.toolName === 'blender_asset_ingest'
      && String(session.record.asked[0]?.reason ?? '').includes(url('/model.glb'))
      && String(session.record.asked[0]?.reason ?? '').includes(String(MAX_BYTES)),
      String(session.record.asked[0]?.reason ?? '').slice(0, 120))
    check('the manifest records that it came from a URL, because provenance is not optional',
      JSON.parse(readFileSync(join(session.studio.store.projectDirectory('remote'), 'assets', 'manifest.json'), 'utf8'))
        .assets[0].source?.kind === 'url',
      fetched.value?.data?.source)

    // The byte cap is applied while READING, so a server that never stops is stopped.
    const endless = await callTool(session.registry, 'blender_asset_ingest', { projectId: 'remote', sourceUrl: url('/endless.glb') })
    check('a response that keeps streaming past the cap is stopped mid-download',
      endless.value?.ok === false && endless.value?.data?.errorCode === 'ASSET_TOO_LARGE',
      endless.value?.data?.errorCode ?? endless.value?.data)

    const missing = await callTool(session.registry, 'blender_asset_ingest', { projectId: 'remote', sourceUrl: url('/missing.glb') })
    check('an HTTP error surfaces as a coded fetch failure, not a crash',
      missing.value?.ok === false && missing.value?.data?.errorCode === 'ASSET_FETCH_FAILED',
      missing.value?.data?.errorCode ?? missing.value?.data)
  } finally {
    await session.root.stop?.()
  }
} catch (cause) {
  check('the remote grant section completed without an unexpected throw', false, cause?.stack ?? String(cause))
}

for (const [answer, label] of [['rejected', 'declined'], ['throws', 'an answerer that throws'], ['missing', 'no approval service at all']]) {
  try {
    const session = await boot(answer)
    try {
      await session.studio.createProject({ projectId: 'denied', title: 'Denied', goal: 'g', sceneSpec: spec, saveCheckpoint: false, renderPreview: false })
      const refused = await callTool(session.registry, 'blender_asset_ingest', { projectId: 'denied', sourceUrl: url('/model.glb') })
      check(`${label}: the remote ingest is refused with a coded result`,
        refused.value?.ok === false && refused.value?.data?.errorCode === 'ASSET_APPROVAL_REFUSED',
        refused.value?.data?.errorCode ?? refused.value?.data ?? refused.error?.message)
      check(`${label}: and nothing was downloaded or written`,
        !existsSync(join(session.studio.store.projectDirectory('denied'), 'assets', 'manifest.json')),
        existsSync(join(session.studio.store.projectDirectory('denied'), 'assets')))
    } finally {
      await session.root.stop?.()
    }
  } catch (cause) {
    check(`${label}: the case completed without an unexpected throw`, false, cause?.stack ?? String(cause))
  }
}

// ---------------------------------------------------------------------------
// 4. The host is the enforcement point, so bypassing the tool does not bypass it
// ---------------------------------------------------------------------------
try {
  const session = await boot('allowed-once')
  try {
    await session.studio.createProject({ projectId: 'bypass', title: 'Bypass', goal: 'g', sceneSpec: spec, saveCheckpoint: false, renderPreview: false })
    let code = null
    try {
      await session.studio.ingestAsset({ projectId: 'bypass', sourceUrl: url('/model.glb') })
    } catch (error) {
      code = error?.code
    }
    check('the HOST refuses an unapproved remote ingest, so the tool is not the only gate',
      code === 'ASSET_APPROVAL_REQUIRED', code ?? '(ingested anyway)')
    check('and that refusal left nothing behind either',
      !existsSync(join(session.studio.store.projectDirectory('bypass'), 'assets', 'manifest.json')))

    // A local path is the same call with no approval at all, which is the half of
    // SPEC §11's permission that says "本地自动".
    const local = await session.studio.ingestAsset({ projectId: 'bypass', sourcePath: localSource })
    check('while a LOCAL ingest through the same seam proceeds with no grant at all',
      local.assetId === 'Widget-Model' && session.record.asked.length === 0, local.assetId)
  } finally {
    await session.root.stop?.()
  }
} catch (cause) {
  check('the bypass section completed without an unexpected throw', false, cause?.stack ?? String(cause))
}

server.close()
server.closeAllConnections?.()
rmSync(scratch, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
console.log(`\nM5 assets: ${passed}/${results.length} check(s) passed`)
if (passed !== results.length) {
  console.log('Failures:')
  for (const entry of results.filter(row => !row.ok)) console.log(`  - ${entry.name}`)
  process.exit(1)
}
process.exit(0)
