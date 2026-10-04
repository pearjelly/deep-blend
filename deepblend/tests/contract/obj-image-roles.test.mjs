/** Source RGB interpretations must agree with allocations before native import. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {encodePng} from '@deepblend/dsh-blender-contracts';
const root=resolve(import.meta.dirname,'../../../packages/deepblend/provider-local/python');
const script=String.raw`
import sys,json,base64,tempfile,types
from pathlib import Path
sys.path.insert(0,sys.argv[1]);r=json.load(sys.stdin)
from deepblend_obj_images import inspect_obj_images
from deepblend_util import ActionError
with tempfile.TemporaryDirectory() as d:
 Path(d,'model.obj').write_text('mtllib model.mtl\nusemtl painted\nusemtl second\n')
 Path(d,'model.mtl').write_text(r['mtl']);Path(d,'paint.png').write_bytes(base64.b64decode(r['image']))
 try:
  if r.get('scene'):
   sys.modules['bpy']=types.SimpleNamespace();from deepblend_images import check_scene_image_budget
   Path(d,'small.png').write_bytes(base64.b64decode(r['small']));result=check_scene_image_budget(r['scene'],d)
  else:result=inspect_obj_images(d,{'path':'model.obj','type':'obj'})
  print(json.dumps({'ok':True,'facts':result}))
 except ActionError as e:print(json.dumps({'ok':False,'code':e.code,'message':str(e)}))
`;
function png(w=4,h=3){const b=Buffer.from(encodePng({width:1,height:1,data:Buffer.from([128,128,128,255])}));b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);let c=0xffffffff;for(const byte of b.subarray(12,29)){c^=byte;for(let n=0;n<8;n++)c=(c>>>1)^(c&1?0xedb88320:0);}b.writeUInt32BE((c^0xffffffff)>>>0,29);return b.toString('base64');}
function inspect(maps,extra={}){const r=spawnSync('python3',['-c',script,root],{input:JSON.stringify({mtl:'newmtl painted\n'+maps.map(k=>k+' paint.png\n').join(''),image:png(),...extra}),encoding:'utf8',timeout:15000,maxBuffer:1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
const mixed=['map_Kd','map_Pr'];
test('color and emission maps share their source interpretation',()=>{const r=inspect(['map_Kd','map_Ke']);assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.allocations,1);assert.equal(r.facts.decodedBytes,192);assert.deepEqual(r.facts.facts[0].roles,['color']);});
test('each native numeric or normal map uses one data interpretation',()=>{for(const map of ['map_Pr','map_Pm','map_Ks','map_Ns','map_Ps','refl','map_refl','bump','map_Bump','map_bump']){const r=inspect([map]);assert(r.ok,map);assert.equal(r.facts.allocations,1,map);assert.deepEqual(r.facts.facts[0].roles,['data'],map);}});
test('color and each data use budget separate RGB interpretations',()=>{for(const map of ['map_Pr','map_Pm','map_Ks','map_Ns','map_Ps','refl','bump']){const r=inspect(['map_Kd',map]);assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.allocations,2,map);assert.equal(r.facts.decodedBytes,384);}});
test('alpha-only sampling creates one allocation without RGB correction',()=>{const r=inspect(['map_d']);assert(r.ok);assert.equal(r.facts.allocations,1);assert.deepEqual(r.facts.facts[0].roles,['alpha']);});
test('alpha with color or data reuses that RGB interpretation',()=>{for(const map of ['map_Kd','map_Pr','bump']){const r=inspect(['map_d',map]);assert(r.ok);assert.equal(r.facts.allocations,1,map);assert.equal(r.facts.decodedBytes,192);}});
test('all three semantic uses allocate only two RGB buffers',()=>{const r=inspect(['map_Kd','map_Ke','map_Pr','map_Pm','bump','map_d']);assert(r.ok);assert.equal(r.facts.allocations,2);assert.deepEqual(r.facts.facts[0].roles,['alpha','color','data']);});
test('two material slots and a normalized image path reuse source-role costs',()=>{const r=inspect([],{mtl:'newmtl painted\nmap_Kd paint.png\nnewmtl second\nmap_Pr ./paint.png\nmap_Pm paint.png\n'});assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.allocations,2);assert.equal(r.facts.decodedBytes,384);});
test('unused materials cannot add a role to the used source',()=>{const r=inspect([],{mtl:'newmtl painted\nmap_Pr paint.png\nnewmtl unused\nmap_Kd paint.png\n'});assert(r.ok);assert.equal(r.facts.allocations,1);assert.deepEqual(r.facts.facts[0].roles,['data']);});
test('inclusive mixed-role limit combines with declared images before scene reset',()=>{const image=png(8192,4096);let r=inspect(mixed,{image});assert(r.ok);assert.equal(r.facts.decodedBytes,1024**3);const scene={assets:[{id:'model',path:'model.obj',type:'obj'},{id:'small',path:'small.png',type:'png'}],entities:[{type:'asset-instance',assetId:'model'}],materials:[{images:{roughness:{assetId:'small'}}}]};r=inspect(mixed,{image,scene,small:png(1,1)});assert.equal(r.code,'ASSET_CONTENT_MISMATCH');});
test('single data source fits where mixed or repeated source roles exceed the budget',()=>{const image=png(8192,8192);assert(inspect(['map_Pr'],{image}).ok);assert.equal(inspect(mixed,{image}).code,'ASSET_CONTENT_MISMATCH');const scene={assets:[{id:'model',path:'model.obj',type:'obj'}],entities:[{type:'asset-instance',assetId:'model'},{type:'asset-instance',assetId:'model'}]};assert.equal(inspect(['map_Pr'],{image,scene,small:png(1,1)}).code,'ASSET_CONTENT_MISMATCH');});
