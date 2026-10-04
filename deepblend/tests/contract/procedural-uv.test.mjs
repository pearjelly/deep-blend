/** Public texture coordinate grammar and revision operations. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {validateSceneSpec, validateScenePatch, applyPatchToSpec, compileSceneSpec} from '@deepblend/dsh-blender-contracts'
const fixture=()=>JSON.parse(readFileSync(new URL('../../fixtures/ceramic-vessel/scene-spec.json',import.meta.url)))
const texture={type:'noise',scale:1,coordinates:'uv',uvMap:'UVMap',stretch:[.0001,800,1],bump:.006}
const scene=t=>{const s=fixture();s.materials[0].texture=t;return s}
const patch=t=>({projectId:'ceramic',baseRevision:'r0001',operations:[{op:'material.texture.set',materialId:fixture().materials[0].id,texture:t}]})
for(const [name,t] of [['legacy',{type:'noise',scale:3}],['explicit object',{type:'noise',scale:3,coordinates:'object'}],['default UV',{...texture,uvMap:undefined}],['named UV',{...texture,uvMap:'Manufacturing UV'}]]) {
 test(`${name} texture is accepted by scene and patch, compiled without changing its coordinate choice`,()=>{
  const clean=JSON.parse(JSON.stringify(t)),s=scene(clean),p=patch(clean);
  assert.equal(validateSceneSpec(s).ok,true,validateSceneSpec(s).summary)
  assert.equal(validateScenePatch(p).ok,true,validateScenePatch(p).summary)
  assert.deepEqual(compileSceneSpec(s).spec.materials[0].texture,clean)
  assert.deepEqual(applyPatchToSpec(fixture(),p).spec.materials[0].texture,clean)
 })
}
for(const [name,t] of [['unknown coordinates',{...texture,coordinates:'generated'}],['name without UV',{...texture,coordinates:undefined}],['name on object',{...texture,coordinates:'object'}],['empty name',{...texture,uvMap:''}],['whitespace name',{...texture,uvMap:' \t '}],['nonstring name',{...texture,uvMap:3}]]){
 test(`${name} is refused by scene and patch`,()=>{
  assert.equal(validateSceneSpec(scene(t)).ok,false)
  assert.equal(validateScenePatch(patch(t)).ok,false)
 })
}
test('coordinate replacement and clearing preserve other material settings and author inputs',()=>{
 const s=fixture(),before=structuredClone(s),next=applyPatchToSpec(s,patch(texture)).spec;
 assert.deepEqual(s,before)
 assert.deepEqual(next.materials[0].parameters,s.materials[0].parameters)
 assert.deepEqual(next.materials.slice(1),s.materials.slice(1))
 assert.equal(Object.hasOwn(applyPatchToSpec(next,patch(null)).spec.materials[0],'texture'),false)
})
test('emission cannot silently discard a UV procedural texture',()=>{
 const s=scene(texture);s.materials[0].shader='emission'
 assert.equal(validateSceneSpec(s).ok,false)
 assert.ok(validateSceneSpec(s).errors.some(e=>e.code==='SCENE_MATERIAL_TEXTURE_INVALID'))
})
