/** Native-compatible OBJ image metadata, selected maps and shared scene budgets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { encodePng } from '@deepblend/dsh-blender-contracts';

const pythonRoot=resolve(import.meta.dirname,'../../../packages/deepblend/provider-local/python');
const fixtures=resolve(import.meta.dirname,'../fixtures/obj-image-formats');
const manifest=JSON.parse(readFileSync(join(fixtures,'formats.json')));
const script=String.raw`
import sys,json,base64,tempfile,builtins,types
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from deepblend_imported_image_headers import check_imported_image_header
from deepblend_obj_images import inspect_obj_images
from deepblend_util import ActionError
request=json.load(sys.stdin);reads=0;largest=0;original=builtins.open
class Source:
 def __init__(self,source):self.source=source
 def __enter__(self):return self
 def __exit__(self,*args):self.source.close()
 def fileno(self):return self.source.fileno()
 def seek(self,*args):return self.source.seek(*args)
 def tell(self):return self.source.tell()
 def read(self,count):
  global reads,largest
  assert count>=0,'unbounded read';largest=max(largest,count);data=self.source.read(count);reads+=len(data);return data
 def readline(self,count):
  global reads,largest
  assert count>=0,'unbounded line read';largest=max(largest,count);data=self.source.readline(count);reads+=len(data);return data
with tempfile.TemporaryDirectory() as directory:
 for name,value in request.get('files',{}).items():
  path=Path(directory)/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(base64.b64decode(value))
 if 'bytes' in request:(Path(directory)/'image').write_bytes(base64.b64decode(request['bytes']))
 builtins.open=lambda *args,**kwargs:Source(original(*args,**kwargs))
 try:
  mode=request.get('mode','header')
  if mode=='header':facts=check_imported_image_header(str(Path(directory)/'image'))
  elif mode=='obj':facts=inspect_obj_images(directory,request.get('asset',{'path':'model.obj','type':'obj'}))
  else:
   sys.modules['bpy']=types.SimpleNamespace();from deepblend_images import check_scene_image_budget
   facts=check_scene_image_budget(request['spec'],directory)
  result={'ok':True,'facts':facts}
 except (ActionError,ValueError) as error:result={'ok':False,'code':getattr(error,'code',None),'error':str(error)}
 result.update(readBytes=reads,largestRead=largest);print(json.dumps(result))
`;
const b64=b=>Buffer.from(b).toString('base64');
function python(input){const r=spawnSync('python3',['-c',script,pythonRoot],{input:JSON.stringify(input),encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
const header=b=>python({bytes:b64(b)});
const native=format=>Buffer.from(readFileSync(join(fixtures,manifest.images.find(r=>r.format===format).file)));
const sha=b=>createHash('sha256').update(b).digest('hex');
function crc(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function png(width=4,height=3){const b=Buffer.from(encodePng({width:1,height:1,data:Buffer.from([1,2,3,255])}));b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);b.writeUInt32BE(crc(b.subarray(12,29)),29);return b;}
function obj(mtl='newmtl paint\nmap_Kd paint.png\n',extra={}){return {mode:'obj',files:{'model.obj':b64('mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl paint\nf 1 2 3\n'),'model.mtl':b64(mtl),'paint.png':b64(png()),...extra}};}
function scene(input,instances=1,extra={}){return {...input,mode:'scene',spec:{assets:[{id:'model',path:'model.obj',type:'obj'}],entities:Array.from({length:instances},(_,i)=>({id:'object-'+i,type:'asset-instance',assetId:'model'})),...extra}};}

test('all fifteen native-accepted fixtures retain exact provenance bytes and actual dimensions',()=>{
 assert.equal(manifest.images.length,15);assert.equal(manifest.license,'MIT');assert.equal(manifest.generation.buildHash,'9e2066aef7ef');
 for(const r of manifest.images){const b=readFileSync(join(fixtures,r.file));assert.equal(sha(b),r.sha256,r.format);const value=header(b);assert(value.ok,JSON.stringify(value));assert(value.facts.parts.every(p=>p.width===64&&p.height===64));assert(value.readBytes<2048,r.format);assert.equal(value.readBytes,value.facts.headerBytes);}
});

function oversized(format,width){const b=native(format);if(format==='BMP')b.writeInt32LE(width,18);else if(format==='TARGA')b.writeUInt16LE(width,12);else if(format==='IRIS')b.writeUInt16BE(width,6);else if(format==='CINEON')b.writeUInt32BE(width,200);else if(format==='DPX')b[b.toString('ascii',0,4)==='SDPX'?'writeUInt32BE':'writeUInt32LE'](width,772);else if(format==='PSD')b.writeUInt32BE(width,18);else if(format==='DDS')b.writeUInt32LE(width,16);else if(format==='JPEG2000'){const p=b.indexOf(Buffer.from([255,79,255,81]));assert(p>=0);b.writeUInt32BE(width,p+8);}else if(format==='TIFF'){assert.equal(b.toString('ascii',0,2),'II');const p=b.readUInt32LE(4),count=b.readUInt16LE(p);let found=false;for(let i=0;i<count;i++){const q=p+2+i*12;if(b.readUInt16LE(q)===256){assert.equal(b.readUInt16LE(q+2),3);b.writeUInt16LE(width,q+8);found=true;}}assert(found);}else if(format==='AVIF'){const p=b.indexOf('ispe');assert(p>=0);b.writeUInt32BE(width,p+8);}return b;}
const additional=['BMP','TARGA','IRIS','CINEON','DPX','TIFF','PSD','DDS','JPEG2000','AVIF'];
test('all ten additional formats reject oversized and empty actual metadata before pixel reads',()=>{for(const f of additional)for(const w of [0,9000]){const r=header(oversized(f,w));assert.equal(r.code,'ASSET_CONTENT_MISMATCH',f+': '+JSON.stringify(r));assert(r.readBytes<2048,f);}});
test('additional format headers accept the inclusive documented side boundary',()=>{for(const f of additional){const r=header(oversized(f,8192));assert(r.ok,f+': '+JSON.stringify(r));assert(r.facts.parts.some(p=>p.width===8192));}});
test('truncated native-compatible size metadata returns a stable refusal',()=>{for(const f of additional)for(const n of [0,2,8])assert.equal(header(native(f).subarray(0,n)).code,'ASSET_CONTENT_MISMATCH',f+' '+n);});
test('BMP top-down images and SGI/PSD channel limits follow metadata rather than the suffix',()=>{const bmp=native('BMP');bmp.writeInt32LE(-64,22);assert.equal(header(bmp).facts.parts[0].height,64);for(const f of ['IRIS','PSD']){const b=native(f);b.writeUInt16BE(65,f==='IRIS'?10:12);assert.equal(header(b).code,'ASSET_CONTENT_MISMATCH');}});

function tiff(width=4,height=3,{big=false,endian='LE',offset=16,entriesExtra=0}={}){const inline=big?8:4,stride=big?20:12,count=3+entriesExtra,countBytes=big?8:2,b=Buffer.alloc(offset+countBytes+stride*count+8);b.write(endian==='LE'?'II':'MM');b['writeUInt16'+endian](big?43:42,2);if(big){b['writeUInt16'+endian](8,4);b['writeBigUInt64'+endian](BigInt(offset),8);b['writeBigUInt64'+endian](BigInt(count),offset);}else{b['writeUInt32'+endian](offset,4);b['writeUInt16'+endian](count,offset);}for(const [i,tag,value]of [[0,256,width],[1,257,height],[2,277,4]]){const p=offset+countBytes+i*stride;b['writeUInt16'+endian](tag,p);b['writeUInt16'+endian](4,p+2);if(big)b['writeBigUInt64'+endian](1n,p+4);else b['writeUInt32'+endian](1,p+4);b['writeUInt32'+endian](value,p+stride-inline);}return b;}
test('TIFF and BigTIFF in either byte order preserve first-image dimensions and channels',()=>{for(const big of [false,true])for(const endian of ['LE','BE']){const r=header(tiff(4,3,{big,endian}));assert(r.ok,JSON.stringify(r));assert.equal(r.facts.decodedBytes,192);assert.equal(r.facts.parts[0].channels,4);}});
test('TIFF metadata after a large encoded payload is sought without reading that payload',()=>{const r=header(tiff(4,3,{offset:2*1024*1024}));assert(r.ok,JSON.stringify(r));assert(r.readBytes<128);assert(r.largestRead<=36);});
test('TIFF escaping directories, duplicate dimensions and excessive metadata refuse before allocation',()=>{const escape=tiff();escape.writeUInt32LE(0xfffffff0,4);assert.equal(header(escape).code,'ASSET_CONTENT_MISMATCH');const duplicate=tiff();duplicate.writeUInt16LE(256,16+2+12);assert.equal(header(duplicate).code,'ASSET_CONTENT_MISMATCH');const massive=tiff(4,3,{big:true});massive.writeBigUInt64LE(1n<<54n,16);const r=header(massive);assert.equal(r.code,'ASSET_CONTENT_MISMATCH');assert(r.readBytes<64);});
test('the combined metadata read budget includes prefix and directory inspection',()=>{const r=header(tiff(4,3,{big:true,entriesExtra:52425}));assert.equal(r.code,'ASSET_CONTENT_MISMATCH');assert(r.readBytes<64);});

function dds(width,height,{levels=1,faces=0,arrays=0}={}){const b=Buffer.alloc(arrays?148:128);b.write('DDS ');b.writeUInt32LE(124,4);b.writeUInt32LE(height,12);b.writeUInt32LE(width,16);b.writeUInt32LE(levels,28);b.writeUInt32LE(32,76);b.writeUInt32LE(faces,112);if(arrays){b.write('DX10',84);b.writeUInt32LE(28,128);b.writeUInt32LE(3,132);b.writeUInt32LE(arrays,140);}return b;}
test('DDS mipmaps, cube faces and DX10 arrays have cumulative decoded allocation bounds',()=>{assert.equal(header(dds(4,3,{levels:3})).facts.decodedBytes,(12+2+1)*16);assert.equal(header(dds(4,3,{faces:0xfe00})).facts.decodedBytes,12*16*6);assert.equal(header(dds(4,3,{arrays:2})).facts.decodedBytes,12*16*2);for(const options of [{levels:2},{faces:0xfe00},{arrays:2}])assert.equal(header(dds(8192,8192,options)).code,'ASSET_CONTENT_MISMATCH');});
test('DDS invalid header sizes, empty arrays and unbounded mip counts are coded refusals',()=>{const wrong=dds(4,3);wrong.writeUInt32LE(125,4);assert.equal(header(wrong).code,'ASSET_CONTENT_MISMATCH');const array=dds(4,3,{arrays:1});array.writeUInt32LE(0,140);assert.equal(header(array).code,'ASSET_CONTENT_MISMATCH');assert.equal(header(dds(4,3,{levels:0xffffffff})).code,'ASSET_CONTENT_MISMATCH');});

const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;},u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
function box(kind,...bytes){const body=Buffer.concat(bytes);return Buffer.concat([u32(body.length+8),Buffer.from(kind),body]);}
function sequence(width,height,{reduced=true,timing=false}={}){
 const bits=[];const field=(n,count)=>{for(let i=count-1;i>=0;i--)bits.push((n>>>i)&1);};
 field(0,3);field(1,1);field(reduced?1:0,1);
 if(reduced)field(0,5);else{field(timing?1:0,1);if(timing){field(1,32);field(1,32);field(1,1);field(1,1);field(1,1);field(3,5);field(1,32);field(0,5);field(0,5);}field(1,1);field(0,5);field(0,12);field(8,5);field(0,1);if(timing){field(1,1);field(0,4);field(0,4);field(0,1);}field(1,1);field(0,4);}
 field(13,4);field(13,4);field(width-1,14);field(height-1,14);while(bits.length%8)bits.push(0);const b=Buffer.alloc(bits.length/8);for(let i=0;i<bits.length;i++)b[i>>3]|=bits[i]<<(7-(i%8));return Buffer.concat([Buffer.from([10,b.length]),b]);
}
function avif({other=9000,relation,primary=1,index=1,codedWidth=4,codedHeight=3,reduced=true,timing=false}={}){
 const extent=(w,h)=>box('ispe',Buffer.alloc(4),u32(w),u32(h)),properties=box('ipco',extent(4,3),extent(other,1)),associations=box('ipma',Buffer.alloc(4),u32(2),u16(1),Buffer.from([1,index]),u16(2),Buffer.from([1,2])),refs=relation?box('iref',Buffer.alloc(4),box(relation,u16(relation==='auxl'?2:1),u16(1),u16(relation==='auxl'?1:2))):Buffer.alloc(0);
 const grid=relation==='dimg',first=grid?Buffer.concat([Buffer.from([0,0,0,0]),u16(4),u16(3)]):sequence(codedWidth,codedHeight,{reduced,timing}),second=sequence(other,1),info=(id,kind)=>box('infe',Buffer.from([2,0,0,0]),u16(id),u16(0),Buffer.from(kind),Buffer.from([0])),loc=(id,offset,size)=>Buffer.concat([u16(id),u16(1),u16(0),u16(1),u32(offset),u32(size)]);
 return Buffer.concat([box('ftyp',Buffer.from('avif'),u32(0),Buffer.from('avif')),box('meta',Buffer.alloc(4),box('pitm',Buffer.alloc(4),u16(primary)),box('iinf',Buffer.alloc(4),u16(2),info(1,grid?'grid':'av01'),info(2,'av01')),box('iloc',Buffer.from([1,0,0,0,0x44,0]),u16(2),loc(1,0,first.length),loc(2,first.length,second.length)),box('idat',first,second),box('iprp',properties,associations),refs)]);
}
test('AVIF inspects the primary image and retains unused oversized alternate metadata',()=>{const r=header(avif());assert(r.ok,JSON.stringify(r));assert.equal(r.facts.parts.length,1);assert.equal(r.facts.decodedBytes,192);});
test('AVIF decoded grid and alpha dependencies are inspected rather than hidden behind the primary',()=>{for(const relation of ['dimg','auxl']){const r=header(avif({relation}));assert.equal(r.code,'ASSET_CONTENT_MISMATCH');}assert.equal(header(avif({relation:'auxl',other:8})).facts.parts.length,2);});
test('AVIF missing primary associations, invalid property indices and escaping boxes refuse',()=>{for(const opts of [{primary:9},{index:9}])assert.equal(header(avif(opts)).code,'ASSET_CONTENT_MISMATCH');const bad=avif();bad.writeUInt32BE(0xffffffff,0);assert.equal(header(bad).code,'ASSET_CONTENT_MISMATCH');});
test('AVIF sequence maxima cannot hide behind smaller container extents',()=>{
 for(const opts of [{},{reduced:false},{reduced:false,timing:true}]){
  const r=header(avif({...opts,codedWidth:64,codedHeight:32}));assert(r.ok,JSON.stringify(r));assert.equal(r.facts.parts[0].width,64);assert.equal(r.facts.parts[0].height,32);
  assert.equal(header(avif({...opts,codedWidth:9000})).code,'ASSET_CONTENT_MISMATCH');
 }
 const b=native('AVIF'),p=b.indexOf('ispe');b.writeUInt32BE(16,p+8);b.writeUInt32BE(16,p+12);const r=header(b);assert(r.ok,JSON.stringify(r));assert(r.facts.parts.every(p=>p.width===64&&p.height===64));
});
test('AVIF missing item payloads, malformed sequence metadata and encoded OBU bounds refuse',()=>{
 const missing=avif();missing.write('xxxx',missing.indexOf('iloc'));assert.equal(header(missing).code,'ASSET_CONTENT_MISMATCH');
 for(const replacement of [Buffer.from([0x8a,1,0]),Buffer.from([10,255,255,255,255,255,255,255,255,255])]){const b=avif({other:1}),p=b.indexOf('idat')+4;replacement.copy(b,p);assert.equal(header(b).code,'ASSET_CONTENT_MISMATCH');}
});
test('JPEG2000 dimensions come from its codestream rather than the display box',()=>{const b=native('JPEG2000'),marker=b.indexOf(Buffer.from([255,79,255,81]));assert(marker>=0);const bare=b.subarray(marker);const r=header(bare);assert(r.ok,JSON.stringify(r));assert.equal(r.facts.parts[0].width,64);const invalid=Buffer.from(bare);invalid.writeUInt32BE(64,16);assert.equal(header(invalid).code,'ASSET_CONTENT_MISMATCH');});

test('explicit and implicit OBJ material libraries inspect the same used image',()=>{const explicit=obj(),implicit=obj();implicit.files['model.obj']=b64(Buffer.from(explicit.files['model.obj'],'base64').toString().replace('mtllib model.mtl\n',''));for(const input of [explicit,implicit]){const r=python(input);assert(r.ok,JSON.stringify(r));assert.equal(r.facts.images,1);assert.equal(r.facts.decodedBytes,192);}});
test('unused material maps do not consume budget or decode an oversized alternate',()=>{const r=python(obj('newmtl paint\nmap_Kd paint.png\nnewmtl unused\nmap_Kd large.png\n',{'large.png':b64(png(9000,1))}));assert(r.ok,JSON.stringify(r));assert.equal(r.facts.images,1);});
test('shadowed maps and native aliases select their last definitions without loading abandoned images',()=>{const r=python(obj('newmtl paint\nmap_Kd large.png\nmap_Kd paint.png\nmap_bump large.png\nbump paint.png\n',{'large.png':b64(png(9000,1))}));assert(r.ok,JSON.stringify(r));assert.equal(r.facts.images,1);});
test('repeated maps and materials reuse one native image path in an import',()=>{const r=python(obj('newmtl paint\nmap_Kd paint.png\nmap_Pr paint.png\nmap_Ke paint.png\n'));assert(r.ok);assert.equal(r.facts.images,1);assert.equal(r.facts.decodedBytes,192);});
test('ordered explicit libraries and final implicit library retain native replacement semantics',()=>{const input=obj('newmtl paint\nmap_Kd paint.png\n',{'first.mtl':b64('newmtl paint\nmap_Kd large.png\n'),'large.png':b64(png(9000,1))});input.files['model.obj']=b64(Buffer.from(input.files['model.obj'],'base64').toString().replace('mtllib model.mtl','mtllib first.mtl'));const r=python(input);assert(r.ok,JSON.stringify(r));assert.equal(r.facts.images,1);});
test('distinct MTL path spellings retain native repeated application and basename fallback order',()=>{for(const libraries of ['model.mtl\nmtllib middle.mtl\nmtllib ./model.mtl','./model.mtl\nmtllib middle.mtl']){const input=obj(undefined,{'middle.mtl':b64('newmtl paint\nmap_Kd large.png\n'),'large.png':b64(png(9000,1))});input.files['model.obj']=b64(Buffer.from(input.files['model.obj'],'base64').toString().replace('mtllib model.mtl','mtllib '+libraries));const r=python(input);assert(r.ok,JSON.stringify(r));assert.equal(r.facts.images,1);assert.equal(r.facts.facts[0].path,'paint.png');}});
test('a normalized MTL alias cannot hide the oversized image actually selected last',()=>{const input=obj('newmtl paint\nmap_Kd large.png\n',{'middle.mtl':b64('newmtl paint\nmap_Kd paint.png\n'),'large.png':b64(png(9000,1))});input.files['model.obj']=b64(Buffer.from(input.files['model.obj'],'base64').toString().replace('mtllib model.mtl','mtllib model.mtl\nmtllib middle.mtl\nmtllib ./model.mtl'));assert.equal(python(input).code,'ASSET_CONTENT_MISMATCH');});
test('nested, quoted and Unicode OBJ/MTL paths retain their actual contained resource',()=>{const input=obj();input.asset={path:'models/model.obj',type:'obj'};input.files={'models/model.obj':b64('mtllib "../material room/paint.mtl"\nusemtl paint\n'), 'material room/paint.mtl':b64('newmtl paint\nmap_Kd -s 2 3 4 "../paint é.png"\n'),'paint é.png':b64(png())};const r=python(input);assert(r.ok,JSON.stringify(r));assert.equal(r.facts.facts[0].path,'paint é.png');});
test('escaping texture references and unsupported image contents are stable refusals',()=>{assert.equal(python(obj('newmtl paint\nmap_Kd ../../outside.png\n')).ok,false);assert.equal(python(obj('newmtl paint\nmap_Kd paint.png\n',{'paint.png':b64('not an image')})).code,'ASSET_CONTENT_MISMATCH');});
test('repeated OBJ instances share header facts but count their separate conservative allocations',()=>{const r=python(scene(obj(),2));assert(r.ok,JSON.stringify(r));assert.equal(r.facts.importedImages,2);assert.equal(r.facts.decodedBytes,384);});
test('OBJ and explicit images enforce the shared inclusive 1 GiB scene boundary',()=>{const input=obj(undefined,{'paint.png':b64(png(8192,8192))});assert(python(scene(input)).ok);assert.equal(python(scene(input,2)).code,'ASSET_CONTENT_MISMATCH');const mixed=scene(input);mixed.files['environment.png']=b64(png());mixed.spec.assets.push({id:'environment',path:'environment.png',type:'png'});mixed.spec.world={environment:{assetId:'environment'}};assert.equal(python(mixed).code,'ASSET_CONTENT_MISMATCH');});
