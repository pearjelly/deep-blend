import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHOT_CAMERA_SELECTION_VERSION, buildShotCameraSelection, normalizeShotCameraSelection,
  shotCameraForFrame } from '@deepblend/dsh-blender-contracts'

const spec = () => ({ cameras: [{ id: 'first-alphabetically' }, { id: 'wide' }, { id: 'close' }], shots: [
  { id: 'detail', cameraId: 'close', frameRange: [4, 6], description: 'not renderer input' },
  { id: 'establish', cameraId: 'wide', frameRange: [1, 3] },
] })
const invalid = fn => assert.throws(fn, error => error.code === 'SCENE_SPEC_INVALID')

test('explicit saved shots select the authored camera at both sides of a cut, not the first camera', () => {
  const source = spec(), before = JSON.stringify(source), selection = buildShotCameraSelection(source, [1, 3, 4, 6])
  assert.deepEqual([1, 3, 4, 6].map(frame => shotCameraForFrame(selection, frame).cameraId), ['wide', 'wide', 'close', 'close'])
  assert.deepEqual(shotCameraForFrame(selection, 4), { shotId: 'detail', cameraId: 'close' })
  assert.equal(selection.schemaVersion, SHOT_CAMERA_SELECTION_VERSION)
  assert.equal(JSON.stringify(source), before)
  source.shots[0].frameRange[0] = 2
  assert.equal(selection.shots[1].frameRange[0], 4, 'the frozen selection must not alias editable source arrays')
  assert.equal('description' in selection.shots[1], false)
})

for (const [name, mutate] of [
  ['missing camera', value => { value.shots[0].cameraId = 'missing' }],
  ['no shots', value => { value.shots = [] }],
  ['unranged storyboard', value => { delete value.shots[0].frameRange }],
  ['overlapping cut', value => { value.shots[0].frameRange[0] = 3 }],
  ['uncovered requested frame', value => { value.shots[0].frameRange[0] = 5 }],
  ['backwards range', value => { value.shots[0].frameRange = [6, 4] }],
  ['fractional range', value => { value.shots[0].frameRange = [4.5, 6] }],
  ['duplicate shot id', value => { value.shots[0].id = value.shots[1].id }],
  ['invalid camera id', value => { value.shots[0].cameraId = '../escape' }],
]) test(name + ' is refused without changing the saved project', () => {
  const source = spec(); mutate(source); const before = JSON.stringify(source)
  invalid(() => buildShotCameraSelection(source, [1, 3, 4, 6])); assert.equal(JSON.stringify(source), before)
})

test('gaps outside an explicit partial frame list do not pretend to cover the complete project', () => {
  const source = spec(); source.shots[0].frameRange[0] = 5
  const selection = buildShotCameraSelection(source, [1, 6])
  assert.equal(shotCameraForFrame(selection, 6).cameraId, 'close')
  invalid(() => normalizeShotCameraSelection(selection, [4]))
  invalid(() => shotCameraForFrame(selection, 4))
})

test('a camera may be reused for disjoint shots', () => {
  const source = spec(); source.shots[0].cameraId = 'wide'
  assert.equal(buildShotCameraSelection(source, [1, 6]).shots.length, 2)
})

for (const [name, mutate] of [
  ['unknown protocol', value => { value.schemaVersion += '-unknown' }],
  ['non-shot mode', value => { value.mode = 'automatic' }],
  ['unknown root setting', value => { value.overrideCamera = 'close' }],
  ['unknown per-shot setting', value => { value.shots[0].source = '/outside.blend' }],
  ['boolean frame', value => { value.shots[0].frameRange = [false, 3] }],
  ['too many ranges', value => { value.shots = Array.from({ length: 65 }, (_, n) => ({ id: 's' + n, cameraId: 'wide', frameRange: [n, n] })) }],
]) test(name + ' cannot be accepted as durable camera provenance', () => {
  const selection = buildShotCameraSelection(spec(), [1, 6]); mutate(selection)
  invalid(() => normalizeShotCameraSelection(selection))
})

test('normalization has a finite metadata budget even for valid-looking long IDs', () => {
  const shots = Array.from({ length: 64 }, (_, n) => ({ id: 's' + n + 'x'.repeat(100), cameraId: 'c' + 'x'.repeat(126), frameRange: [n, n] }))
  invalid(() => normalizeShotCameraSelection({ schemaVersion: SHOT_CAMERA_SELECTION_VERSION, mode: 'shots', shots }))
})
