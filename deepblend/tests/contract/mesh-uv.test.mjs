import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyPatchToSpec, compileSceneSpec, requiredSceneFeatures, validateScenePatch } from '@deepblend/dsh-blender-contracts'
import { projectMeshFaceUvs } from '../../../packages/deepblend/contracts/lib/mesh-uv.js'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/product-turntable/scene-spec.json', import.meta.url)))
const beam = { shape: 'mesh', vertices: [[0,0,0],[.13,0,0],[.13,2.6,0],[0,2.6,0],[0,0,.14],[.13,0,.14],[.13,2.6,.14],[0,2.6,.14]],
  faces: [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]], smooth: false }
const source = () => {
  const spec = compileSceneSpec(structuredClone(fixture)).spec
  spec.entities.find(entity => entity.id === 'watch-body').generator = structuredClone(beam)
  return spec
}
const patch = (options = {}) => ({ projectId: fixture.project.id, baseRevision: 'r0001',
  operations: [{ op: 'entity.uv.project', entityId: 'watch-body', ...options }] })
const mesh = spec => spec.entities.find(entity => entity.id === 'watch-body').generator
const area = ([a,b,c]) => Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])) / 2
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-12, `${a} != ${b}`)

test('every beam face has usable UV area with common density and intact aspect ratio', () => {
  const uv = projectMeshFaceUvs(beam)
  assert.equal(uv.length, 6)
  for (let face = 0; face < 6; face++) {
    assert.ok(area(uv[face].slice(0,3)) > 0)
    const indices = beam.faces[face]
    for (let corner = 0; corner < 4; corner++) {
      const next = (corner + 1) % 4, a = beam.vertices[indices[corner]], b = beam.vertices[indices[next]]
      near(Math.hypot(...uv[face][corner].map((value, axis) => value-uv[face][next][axis])), Math.hypot(...a.map((value,axis) => value-b[axis])) / 2.6)
      if (Math.hypot(...a.map((value,axis) => value-b[axis])) > 2.5) {
        near(Math.abs(uv[face][corner][0]-uv[face][next][0]), 1)
        near(uv[face][corner][1], uv[face][next][1])
      }
    }
  }
})
test('explicit quarter turns rotate each island and scale controls repetitions', () => {
  const uv = projectMeshFaceUvs(beam), turned = projectMeshFaceUvs(beam, { quarterTurns: 1 }), scaled = projectMeshFaceUvs(beam, { scale: 2 })
  for (let face = 0; face < 6; face++) {
    const top = Math.max(...uv[face].map(point => point[1]))
    for (let corner = 0; corner < 4; corner++) {
      near(turned[face][corner][0], top-uv[face][corner][1]); near(turned[face][corner][1], uv[face][corner][0])
      scaled[face][corner].forEach((value,axis) => near(value, uv[face][corner][axis]*2))
    }
  }
  for (const quarterTurns of [2,3]) assert.ok(projectMeshFaceUvs(beam,{quarterTurns}).every(face => area(face.slice(0,3)) > 0))
})
test('projection replaces only UVs, retains old runtime compatibility and repeats as a no-op', () => {
  const spec = source(), before = structuredClone(spec), request = patch(), requestBefore = structuredClone(request)
  mesh(spec).faceUvs = beam.faces.map(() => [[7,8],[7,8],[7,8],[7,8]])
  const original = structuredClone(spec), result = applyPatchToSpec(spec, request)
  assert.deepEqual(spec, original); assert.deepEqual(request, requestBefore)
  const restored = structuredClone(result.spec); delete mesh(restored).faceUvs
  assert.deepEqual(restored, before)
  assert.deepEqual(result.operations[0].changedPaths, ['entities.watch-body.generator.faceUvs'])
  assert.deepEqual(requiredSceneFeatures(result.spec), requiredSceneFeatures(spec))
  assert.deepEqual(mesh(compileSceneSpec(result.spec).spec).faceUvs, mesh(result.spec).faceUvs)
  const repeat = applyPatchToSpec(result.spec, request)
  assert.equal(repeat.specHashBefore, repeat.specHashAfter); assert.deepEqual(repeat.operations[0].changedPaths, [])
})
test('changing geometry then projecting uses the new control points in the same patch', () => {
  const spec = source(), changed = structuredClone(beam); changed.vertices[5][0] = .2
  // Triangulate so the edited side faces remain planar.
  changed.faces = changed.faces.flatMap(([a,b,c,d]) => [[a,b,c],[a,c,d]])
  const request = patch(); request.operations.unshift({op:'entity.generator.set',entityId:'watch-body',generator:changed})
  const result = applyPatchToSpec(spec, request)
  assert.deepEqual(mesh(result.spec).faceUvs, projectMeshFaceUvs(changed))
  assert.deepEqual(mesh(spec), beam)
})
test('nonplanar, missing and wrong targets refuse atomically without changing earlier operations', () => {
  for (const kind of ['missing','cube','warped']) {
    const spec = source()
    if (kind === 'cube') mesh(spec).shape = 'cube'
    if (kind === 'warped') mesh(spec).vertices[5][0] = .2
    const before = structuredClone(spec), request = patch({entityId:kind === 'missing' ? 'absent' : 'watch-body'})
    request.operations.unshift({op:'entity.visibility.set',entityId:'stage',visible:false})
    assert.throws(() => applyPatchToSpec(spec,request), error => error.patchIssue?.code === (kind === 'missing' ? 'PATCH_TARGET_MISSING' : 'PATCH_OPERATION_INVALID'))
    assert.deepEqual(spec,before)
  }
})
test('invalid options and unknown fields are refused with the known operation diagnostics', () => {
  assert.equal(validateScenePatch(patch()).ok,true)
  for (const options of [{quarterTurns:-1},{quarterTurns:4},{quarterTurns:1.2},{scale:0},{scale:.00001},{scale:10001},{scale:Infinity},{scale:null},{mode:'smart'}]) {
    const validation = validateScenePatch(patch(options))
    assert.equal(validation.ok,false,JSON.stringify(options))
    assert.ok(validation.errors.some(issue => issue.path.startsWith('operations[0].')))
  }
})
test('planar concave faces project without geometry changes; invalid topology stays rejected', () => {
  const concave = {shape:'mesh',vertices:[[0,0,0],[2,0,0],[1,.5,0],[2,1,0],[0,1,0]],faces:[[0,1,2,3,4]]}
  const before = structuredClone(concave), uv = projectMeshFaceUvs(concave)
  assert.equal(uv[0].length,5); assert.deepEqual(concave,before)
  for (const bad of [{...beam,faces:[[0,1,99]]},{...beam,faces:[[0,0,1]]},{...beam,vertices:[[NaN,0,0],...beam.vertices.slice(1)]}]) assert.throws(() => projectMeshFaceUvs(bad))
})
