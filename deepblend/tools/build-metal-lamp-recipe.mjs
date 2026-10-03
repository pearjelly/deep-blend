#!/usr/bin/env node
/** Package the native benchmark's exact source and preview with distinct finish controls. */
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {recipeCapabilitiesForScene,validateRecipePackage,instantiateRecipe} from '../../packages/deepblend/contracts/lib/recipe.js'
import {canonicalStringify} from '../../packages/deepblend/contracts/lib/canonical.js'
import {compileSceneSpec} from '../../packages/deepblend/contracts/lib/scene-spec.js'
const root=resolve(import.meta.dirname,'../..'),target=join(root,'deepblend/recipes/metal-lamp')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const sceneBytes=readFileSync(join(root,'deepblend/benchmarks/metal-lamp/scene-spec.json'))
const nativePreviewBytes=readFileSync(join(root,'deepblend/benchmarks/previews/metal-lamp-hero.png'))
const provenance=JSON.parse(readFileSync(join(root,'deepblend/benchmarks/previews/manifest.json'))).images.find(image=>image.caseId==='metal-lamp')
assert(provenance,'Missing native benchmark preview provenance')
assert.equal(sha(canonicalStringify(JSON.parse(sceneBytes))),provenance.candidateInputSha256,'Benchmark source changed; rerender and verify its preview before packaging')
assert.equal(sha(nativePreviewBytes),provenance.sha256,'Native benchmark preview bytes changed')
// Copy encoded image chunks unchanged; remove author/time metadata from the public package.
const chunks=[nativePreviewBytes.subarray(0,8)]
for(let offset=8;offset<nativePreviewBytes.length;){
  const end=offset+12+nativePreviewBytes.readUInt32BE(offset)
  assert(end<=nativePreviewBytes.length,'Truncated native PNG chunk')
  const kind=nativePreviewBytes.toString('ascii',offset+4,offset+8)
  if(!['tEXt','iTXt','zTXt','tIME','eXIf'].includes(kind))chunks.push(nativePreviewBytes.subarray(offset,end))
  offset=end
}
const previewBytes=Buffer.concat(chunks)
const scene=JSON.parse(sceneBytes),material=id=>scene.materials.find(m=>m.id===id)
assert.equal(material('champagne-spun').texture.coordinates,'uv')
assert.equal(material('champagne-spun').texture.uvMap,'UVMap')
const manifest={schemaVersion:'deepblend.recipe/v1',id:'deepblend.metal-lamp',version:'2.0.0',title:'香槟金属桌灯',
  description:'连续旋压灯罩、沿曲面延伸的金属细纹、珐琅内衬、曲线弯臂与贴地线缆。分别调整旋压件和拉丝件的粗糙度，同步调整金属颜色与摄影曝光。',
  author:{name:'DeepBlend contributors',url:'https://github.com/pearjelly/deep-blend'},license:'MIT',
  source:{url:'https://github.com/pearjelly/deep-blend',note:'Native metal-lamp benchmark with UV grain. SceneSpec bytes and native hero pixels are pinned; preview metadata is removed. Source URL is attribution, not an installation endpoint.'},
  compatibility:{sceneSchemaVersion:'deepblend.scene/v1',capabilities:recipeCapabilitiesForScene(scene)},
  input:{path:'scene-spec.json',sha256:sha(sceneBytes)},preview:{path:'preview.png',sha256:sha(previewBytes),mediaType:'image/png',alt:'香槟金属桌灯默认参数及曲面细纹的实际 Blender 渲染'},
  parameters:[
    {id:'main-color',title:'主金属颜色',description:'同步调整旋压件和拉丝件的金属色调。',type:'color',default:material('champagne-spun').parameters.baseColor.slice(0,3),bindings:['champagne-spun','champagne-brushed'].map(materialId=>({kind:'material',materialId,property:'baseColor'}))},
    ...[['spun-roughness','旋压件粗糙度','灯罩、底座和旋钮的光泽。','champagne-spun'],['brushed-roughness','拉丝件粗糙度','支架与弯臂的光泽。','champagne-brushed']].map(([id,title,description,materialId])=>({id,title,description:description+'数值越小，反光越集中。',type:'number',default:material(materialId).parameters.roughness,minimum:.22,maximum:.6,bindings:[{kind:'material',materialId,property:'roughness'}]})),
    {id:'exposure',title:'摄影曝光',description:'调整整体画面的明暗，预览和成品同步生效。',type:'number',default:scene.renderProfiles.preview.colorManagement.exposure,minimum:-1,maximum:1,bindings:['preview','final'].map(profile=>({kind:'render-profile',profile,property:'exposure'}))},
  ]}
const bundle={manifest,sceneBytes,previewBytes},checked=validateRecipePackage(bundle)
assert(checked.ok,checked.summary)
assert.deepEqual(instantiateRecipe(bundle).spec,compileSceneSpec(scene).spec,'Default controls must preserve the exact authored scene')
const files={'recipe.json':Buffer.from(JSON.stringify(manifest,null,2)+'\n'),'scene-spec.json':sceneBytes,'preview.png':previewBytes}
for(const [name,bytes]of Object.entries(files)){
  if(process.argv.includes('--check'))assert.deepEqual(readFileSync(join(target,name)),bytes,`${name} differs from native benchmark recipe`)
  else writeFileSync(join(target,name),bytes)
}
console.log(`Metal lamp 2.0.0 ${process.argv.includes('--check')?'verified':'built'} from native benchmark source and pixels`)
