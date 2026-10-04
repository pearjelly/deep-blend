/** Color/data interpretations and native baked images must have allocation budgets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {encodePng} from '@deepblend/dsh-blender-contracts';
const root=resolve(import.meta.dirname,'../../../packages/deepblend/provider-local/python');
const script=String.raw`
import sys,json,tempfile,base64,types
from pathlib import Path
sys.path.insert(0,sys.argv[1]);r=json.load(sys.stdin)
from deepblend_gltf_images import inspect_gltf_images
from deepblend_util import ActionError
with tempfile.TemporaryDirectory() as d:
 Path(d,'model.gltf').write_text(json.dumps(r['document']))
 try:
  if r.get('scene'):
   sys.modules['bpy']=types.SimpleNamespace();from deepblend_images import check_scene_image_budget
   Path(d,'small.png').write_bytes(base64.b64decode(r['small']))
   result=check_scene_image_budget(r['scene'],d)
  else:result=inspect_gltf_images(d,{'path':'model.gltf','type':'gltf'})
  print(json.dumps({'ok':True,'facts':result}))
 except ActionError as e:print(json.dumps({'ok':False,'code':e.code,'message':str(e)}))
`;
function crc(bytes){let c=0xffffffff;for(const x of bytes){c^=x;for(let n=0;n<8;n++)c=(c>>>1)^(c&1?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function png(w=4,h=3){const b=Buffer.from(encodePng({width:1,height:1,data:Buffer.from([90,30,20,128])}));b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);b.writeUInt32BE(crc(b.subarray(12,29)),29);return b;}
const uri=b=>'data:image/png;base64,'+b.toString('base64');
const doc=(material={},bytes=png())=>({asset:{version:'2.0'},images:[{uri:uri(bytes)}],textures:[{source:0}],materials:[material]});
function inspect(document,extra={}){const r=spawnSync('python3',['-c',script,root],{input:JSON.stringify({document,...extra}),encoding:'utf8',timeout:15000,maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
const mixed=()=>({pbrMetallicRoughness:{baseColorTexture:{index:0},metallicRoughnessTexture:{index:0}}});
test('core color/data uses allocate independently while retaining one source header',()=>{const r=inspect(doc(mixed()));assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.allocations,2);assert.equal(r.facts.decodedBytes,4*3*16*2);assert.deepEqual(r.facts.facts[0].roles,['color','data']);});
test('repeated materials and texture indices reuse the same source-role allocation',()=>{const d=doc(mixed());d.textures.push({source:0});d.materials.push({pbrMetallicRoughness:{baseColorTexture:{index:1},metallicRoughnessTexture:{index:1}}});const r=inspect(d);assert(r.ok);assert.equal(r.facts.allocations,2);assert.equal(r.facts.decodedBytes,384);});
test('alpha-only specular and sheen uses add no RGB interpretation copies',()=>{for(const role of ['color','data']){const material=role==='color'?{emissiveTexture:{index:0}}:{normalTexture:{index:0}};material.extensions={KHR_materials_specular:{specularTexture:{index:0}},KHR_materials_sheen:{sheenRoughnessTexture:{index:0}}};const r=inspect(doc(material));assert(r.ok);assert.equal(r.facts.allocations,1);assert.deepEqual(r.facts.facts[0].roles,['alpha',role]);}});
test('each supported material extension budgets its declared color/data/alpha use',()=>{const fields=[['KHR_materials_clearcoat','clearcoatTexture','data'],['KHR_materials_clearcoat','clearcoatRoughnessTexture','data'],['KHR_materials_clearcoat','clearcoatNormalTexture','data'],['KHR_materials_transmission','transmissionTexture','data'],['KHR_materials_volume','thicknessTexture','data'],['KHR_materials_specular','specularColorTexture','color'],['KHR_materials_specular','specularTexture','alpha'],['KHR_materials_sheen','sheenColorTexture','color'],['KHR_materials_sheen','sheenRoughnessTexture','alpha'],['KHR_materials_iridescence','iridescenceTexture','data'],['KHR_materials_iridescence','iridescenceThicknessTexture','data'],['KHR_materials_anisotropy','anisotropyTexture','data'],['KHR_materials_pbrSpecularGlossiness','diffuseTexture','color']];for(const [extension,field,role]of fields){const m=role==='color'?{normalTexture:{index:0}}:{emissiveTexture:{index:0}};m.extensions={[extension]:{[field]:{index:0}}};const r=inspect(doc(m));assert(r.ok,JSON.stringify(r));assert.equal(r.facts.allocations,role==='alpha'?1:2,field);assert(r.facts.facts[0].roles.includes(role),field);}});
test('specular/glossiness source, RGB interpretation and baked roughness each cost an allocation',()=>{const material={normalTexture:{index:0},extensions:{KHR_materials_pbrSpecularGlossiness:{specularGlossinessTexture:{index:0}}}},d=doc(material);d.materials.push(structuredClone(material));let r=inspect(d);assert(r.ok);assert.equal(r.facts.allocations,3);assert.equal(r.facts.decodedBytes,576);d.materials.forEach(m=>m.extensions.KHR_materials_pbrSpecularGlossiness.glossinessFactor=0);r=inspect(d);assert(r.ok);assert.equal(r.facts.allocations,2);});
test('color/data role costs follow the native selected core or fallback image',()=>{const d=doc(mixed());d.images.push({uri:uri(png(2,2))});d.textures[0].extensions={EXT_texture_webp:{source:1}};let r=inspect(d);assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.decodedBytes,384);delete d.textures[0].source;r=inspect(d);assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.decodedBytes,128);assert.equal(r.facts.facts[0].imageIndex,1);});
test('inclusive 1 GiB mixed-use estimate combines with explicit scene image bindings',()=>{const d=doc(mixed(),png(8192,4096));let r=inspect(d);assert(r.ok);assert.equal(r.facts.decodedBytes,1024**3);const scene={assets:[{id:'model',type:'gltf',path:'model.gltf'},{id:'small',type:'png',path:'small.png'}],entities:[{type:'asset-instance',assetId:'model'}],materials:[{images:{baseColor:{assetId:'small'}}}]};r=inspect(d,{scene,small:png(1,1).toString('base64')});assert.equal(r.code,'ASSET_CONTENT_MISMATCH');assert.match(r.message,/scene images exceed/);});
test('a source at the per-image limit is refused when color/data copies exceed the scene limit',()=>{const r=inspect(doc(mixed(),png(8192,8192)));assert.equal(r.code,'ASSET_CONTENT_MISMATCH');assert.match(r.message,/imported images exceed/);});
test('invalid material texture references fail before native allocations',()=>{for(const index of [false,true,-1,1,1.5,null]){const r=inspect(doc({emissiveTexture:{index}}));assert.equal(r.code,'ASSET_CONTENT_MISMATCH');}for(const change of [d=>d.materials={},d=>d.materials[0].normalTexture=[],d=>d.materials[0].extensions=5,d=>d.materials[0].extensions={KHR_materials_specular:4}]){const d=doc();change(d);assert.equal(inspect(d).code,'ASSET_CONTENT_MISMATCH');}});
test('core normal, occlusion and emission uses share only matching interpretations',()=>{for(const fields of [['normalTexture'],['occlusionTexture'],['normalTexture','occlusionTexture']]){const material={emissiveTexture:{index:0}};for(const field of fields)material[field]={index:0};const r=inspect(doc(material));assert(r.ok);assert.equal(r.facts.allocations,2,fields.join(','));assert.deepEqual(r.facts.facts[0].roles,['color','data']);}});
