import test from 'node:test'
import assert from 'node:assert/strict'
import { validateScenePatch } from '../../../packages/deepblend/contracts/lib/scene-patch.js'

const camera = () => ({ id: 'cam-interior', role: 'interior', lens: 24,
  clipping: [.005, 250], fStop: 16, targetPoint: [.045, 0, .44],
  transform: { location: [.045, -.35, .205], rotationEuler: [0, 0, 0], scale: [1, 1, 1] } })
const patch = operations => ({ projectId: 'lamp', baseRevision: 'r0001', operations })

test('actual lamp camera rejection identifies its invalid role and allowed replacements', () => {
  const result = validateScenePatch(patch([{ op: 'camera.add', camera: camera() }]))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.path === 'operations[0]' && e.message.includes('[oneOf]')))
  const role = result.errors.find(e => e.path === 'operations[0].camera.role')
  assert.equal(role?.code, 'PATCH_SCHEMA_INVALID')
  assert.match(role.message, /"active-camera", "three-quarter", "top", "detail"/)
  assert.match(role.message, /received "interior" \[enum\]/)
  assert.ok(result.summary.includes(role.message))
})

test('correcting the reported camera role permits the same authored camera', () => {
  const authored = camera(); authored.role = 'detail'
  assert.equal(validateScenePatch(patch([{ op: 'camera.add', camera: authored }])).ok, true)
})

test('nested missing fields retain the operation index in the diagnostic', () => {
  const authored = camera(); authored.role = 'detail'; delete authored.id
  const result = validateScenePatch(patch([{ op: 'entity.remove', entityId: 'unused' }, { op: 'camera.add', camera: authored }]))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.path === 'operations[1].camera.id' && e.message.includes('[required]')))
})

test('unknown operations remain rejected without invented branch guidance', () => {
  const result = validateScenePatch(patch([{ op: 'camera.interior', camera: camera() }]))
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors.map(e => e.path), ['operations[0]'])
})

test('diagnostic expansion preserves original input and rejects unknown fields', () => {
  const authored = camera(); authored.role = 'detail'; authored.inventedLens = 85
  const input = patch([{ op: 'camera.add', camera: authored }]), before = structuredClone(input)
  const result = validateScenePatch(input)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(e => e.path === 'operations[0].camera.inventedLens' && e.message.includes('[additionalProperties]')))
  assert.deepEqual(input, before)
})
