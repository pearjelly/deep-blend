import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BlenderError, BlenderErrorCode } from '@deepblend/dsh-blender-contracts'
import { composeToolPlane } from '../lib/tool-plane-harness.mjs'
import { findNodes, loadClientBundle, mountClient, renderTree, textOf } from '../lib/client-bundle.mjs'

const request = { projectId: 'display', baseRevision: 'r0002', subjectEntityId: 'statue', supportEntityId: 'plinth', frame: 1 }
const summary = { revision: 'r0003', digest: 'a'.repeat(64), checkpoint: 'revisions/r0003/scene.blend', previews: [],
  surfacePlacementReceipt: { sourceRevision: 'r0002', subjectEntityId: 'statue', supportEntityId: 'plinth', frame: 1, clearanceMm: 0 } }

test('surface placement requires the current revision, both entities and an explicit integer frame', async t => {
  let writes = 0
  const plane = await composeToolPlane({ studio: { surfacePlacementSupported: true, placeOnSurface() { writes++; return summary } }, expectAtLeast: 19 })
  t.after(() => plane.ctx.fiber.dispose())
  const tool = plane.registered.get('blender_place_on_surface')
  assert.ok(tool)
  assert.deepEqual(tool.parameters.required, Object.keys(request))
  assert.equal(Object.hasOwn(tool.parameters.properties, 'saveCheckpoint'), false)
  for (const key of Object.keys(request)) {
    const incomplete = { ...request }; delete incomplete[key]
    await assert.rejects(tool.execute(incomplete, {}), { code: 'INVALID_ARGS' })
  }
  for (const changes of [{ frame: 1.5 }, { frame: '1' }, { clearanceMm: '0' }, { renderPreview: 0 }, { cameraId: null }]) {
    await assert.rejects(tool.execute({ ...request, ...changes }, {}), { code: 'INVALID_ARGS' })
  }
  assert.equal(writes, 0, 'invalid tool arguments must not reach the mutating Host method')
  assert.deepEqual(tool.presentCall(request), { card: 'generic', title: 'Place "statue" on "plinth"', kind: 'move', projectId: 'display' })
})

test('surface placement forwards one semantic request and preserves the canonical saved receipt', async t => {
  const calls = [], studio = { surfacePlacementSupported: true, placeOnSurface(input) { calls.push(input); return structuredClone(summary) } }
  const plane = await composeToolPlane({ studio, expectAtLeast: 19 })
  t.after(() => plane.ctx.fiber.dispose())
  const signal = new AbortController().signal
  const saved = await plane.registered.get('blender_place_on_surface').execute(request, { signal })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.data, summary)
  assert.deepEqual(calls, [{ ...request, clearanceMm: 0, renderPreview: true, cameraId: undefined, idempotencyKey: undefined, signal }])
  assert.match(saved.text, /Saved surface placement in revision r0003/)
  assert.deepEqual(JSON.parse(saved.text.split('Canonical JSON:\n')[1]), summary)
  const args = { ...request, clearanceMm: 2.5, renderPreview: false, cameraId: 'side', idempotencyKey: 'placement-1' }
  studio.placeOnSurface = input => { calls.push(input); return { ...structuredClone(summary), idempotentReplay: true } }
  const replay = await plane.registered.get('blender_place_on_surface').execute(args, { signal })
  assert.deepEqual(calls[1], { ...args, signal })
  assert.equal(replay.data.idempotentReplay, true)
  assert.match(replay.text, /Reused surface placement/)
})

test('surface placement refuses missing or mismatched Host capabilities before any mutation', async () => {
  let writes = 0
  for (const studio of [undefined, {}, { placeOnSurface() { writes++ } },
    { surfacePlacementSupported: false, placeOnSurface() { writes++ } }, { surfacePlacementSupported: true }]) {
    const plane = await composeToolPlane({ studio, expectAtLeast: 19 })
    try {
      const result = await plane.registered.get('blender_place_on_surface').execute(request, {})
      assert.equal(result.ok, false)
      assert.equal(result.data.errorCode ?? result.data.code, BlenderErrorCode.RUNTIME_UNAVAILABLE)
      assert.match(result.text, /[Rr]estart/)
    } finally { await plane.ctx.fiber.dispose() }
  }
  assert.equal(writes, 0)
})

test('surface placement keeps Host refusals and unknown input intact rather than guessing a patch', async t => {
  const calls = [], studio = { surfacePlacementSupported: true,
    placeOnSurface(input) { calls.push(input); throw new BlenderError('SURFACE_PLACEMENT_INVALID', 'Unknown placement field: saveCheckpoint') },
    applyScenePatch() { assert.fail('placement failures must not fall back to guessed transforms') } }
  const plane = await composeToolPlane({ studio, expectAtLeast: 19 })
  t.after(() => plane.ctx.fiber.dispose())
  const rejected = await plane.registered.get('blender_place_on_surface').execute({ ...request, saveCheckpoint: false }, {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0].saveCheckpoint, false, 'Host validation must see the original unsupported intent')
  assert.equal(rejected.ok, false)
  assert.equal(rejected.data.errorCode, 'SURFACE_PLACEMENT_INVALID')
  for (const code of [BlenderErrorCode.REVISION_CONFLICT, BlenderErrorCode.ABORTED, 'SURFACE_PLACEMENT_UNAVAILABLE']) {
    studio.placeOnSurface = () => { throw new BlenderError(code, 'Placement was not committed') }
    const failed = await plane.registered.get('blender_place_on_surface').execute(request, {})
    assert.equal(failed.ok, false)
    assert.equal(failed.data.errorCode, code)
    assert.match(failed.text, /Placement was not committed/)
    if (code === BlenderErrorCode.REVISION_CONFLICT) {
      assert.match(failed.text, /retry blender_place_on_surface/)
      assert.doesNotMatch(failed.text, /re-issue the patch/)
    }
  }
})

test('surface placement attaches only its committed preview and keeps the saved revision if attachment fails', async t => {
  const bytes = readFileSync(new URL('../fixtures/obj-image-formats/paint.png', import.meta.url))
  const hash = data => createHash('sha256').update(data).digest('hex')
  const artifact = { kind: 'preview', cameraId: 'side', frame: 1, sourceRevision: summary.revision,
    sourceDigest: summary.digest, mime: 'image/png', width: 64, height: 64, bytes: bytes.length,
    sha256: hash(bytes), path: 'revisions/r0003/previews/side.png' }
  const receipt = { ...structuredClone(summary), previews: [artifact] }
  let placements = 0, reads = 0, saves = 0, readBytes = bytes
  const studio = { surfacePlacementSupported: true,
    placeOnSurface() { placements++; return structuredClone(receipt) },
    renderPreview() { assert.fail('the saved preview must be reused') },
    renderViews() { assert.fail('placement must not trigger an extra inspection') },
    readArtifact(input) { reads++; assert.deepEqual(input, { projectId: request.projectId, path: artifact.path });
      return { path: artifact.path, contentType: 'image/png', size: readBytes.length, bytes: readBytes } } }
  const plane = await composeToolPlane({ studio, expectAtLeast: 19, services: { attachments: {
    saveImage(input) { saves++; assert.deepEqual(input.data, bytes); return { attachmentId: 'placement-preview', mediaType: 'image/png', width: 64, height: 64, bytes: bytes.length } },
  } } })
  t.after(() => plane.ctx.fiber.dispose())
  const tool = plane.registered.get('blender_place_on_surface')
  const good = await tool.execute({ ...request, cameraId: 'side' }, {})
  assert.equal(good.ok, true)
  assert.equal(good.image.attachmentId, 'placement-preview')
  assert.deepEqual(good.data.surfacePlacementReceipt, summary.surfacePlacementReceipt)
  assert.equal(good.imageSource.sourceRevision, summary.revision)
  assert.equal(tool.output.render(request, JSON.parse(JSON.stringify(good))).filter(block => block.type === 'image').length, 1)
  assert.deepEqual([placements, reads, saves], [1, 1, 1], 'replaying the result performs no IO')
  const withoutImage = await tool.execute({ ...request, renderPreview: false }, {})
  assert.equal(withoutImage.ok, true)
  assert.deepEqual([placements, reads, saves], [2, 1, 1])
  readBytes = Buffer.from(bytes); readBytes[30] ^= 1
  const badAttachment = await tool.execute(request, {})
  assert.equal(badAttachment.ok, true)
  assert.equal(badAttachment.image, null)
  assert.equal(badAttachment.data.revision, summary.revision)
  assert.match(badAttachment.text, /revision remains saved/)
  assert.match(badAttachment.text, /model has not seen this image/)
  assert.equal(saves, 1, 'corrupt preview bytes must never reach the attachment store')
})

test('surface placement has a registered card for its real invocation and all completion states', () => {
  const client = mountClient(loadClientBundle().exports)
  const entries = client.registrations.filter(entry => entry.options.name === 'tool.call.toolview' && entry.options.key === 'blender_place_on_surface')
  assert.equal(entries.length, 1)
  const component = entries[0].component
  for (const [state, block] of [
    ['running', { argsRaw: JSON.stringify(request) }],
    ['ok', { kind: 'tool-result', call: { argsRaw: JSON.stringify(request) }, content: [{ type: 'text', text: 'Surface placement saved.' }], isError: false }],
    ['error', { kind: 'tool-result', call: { argsRaw: JSON.stringify(request) }, content: [{ type: 'text', text: 'REVISION_CONFLICT' }], isError: true }],
  ]) {
    const tree = renderTree(component({ toolName: 'blender_place_on_surface', block }))
    const roots = findNodes(tree, node => node.props['data-tool-card'] === 'blender_place_on_surface')
    assert.equal(roots.length, 1)
    assert.equal(roots[0].props['data-tool-state'], state)
    assert.match(textOf(tree), /display/)
  }
})
