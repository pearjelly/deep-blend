/** Actual native color/data roles, source fidelity, UV graphs and controlled pixels. */
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {encodePng,decodePng} from '@deepblend/dsh-blender-contracts';
import {defaultSceneSpec} from '@deepblend/dsh-blender-host';
const sha=b=>createHash('sha256').update(b).digest('hex'),save=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n');
const uri=(b,mime='application/octet-stream')=>'data:'+mime+';base64,'+b.toString('base64');
const ref=index=>({index,texCoord:1,extensions:{KHR_texture_transform:{offset:[.1,.2],scale:[.8,.6],rotation:.25}}});
const COLOR='sRGB',DATA='Non-Color';
function fixture(name,kind,materials,bytes,{external=false,alias=false}={}){
 const positions=Buffer.alloc(36),uv=Buffer.alloc(24);positions.writeFloatLE(.1,12);positions.writeFloatLE(.1,28);uv.writeFloatLE(1,8);uv.writeFloatLE(1,20);const binary=Buffer.concat([positions,uv]);
 const image=external?{uri:'paint.png'}:{uri:uri(bytes,'image/png')};
 const doc={asset:{version:'2.0'},buffers:[{uri:uri(binary),byteLength:binary.length}],bufferViews:[{buffer:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[.1,.1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}],images:alias?[image,{...image}]:[image],samplers:[{magFilter:9728,minFilter:9728,wrapS:33071,wrapT:33648}],textures:(alias?[0,1]:[0]).map(source=>({source,sampler:0})),materials:materials.map((m,n)=>({name:name+'-material-'+n,...m})),meshes:[{name:name+'-mesh',primitives:materials.map((_,material)=>({attributes:{POSITION:0,TEXCOORD_0:1,TEXCOORD_1:1},material}))}],nodes:[{mesh:0}],scenes:[{nodes:[0]}],scene:0,extensionsUsed:['KHR_texture_transform',...new Set(materials.flatMap(m=>Object.keys(m.extensions??{})))]};
 const files=external?{'paint.png':bytes}:{};
 if(kind==='glb'){
  delete doc.buffers[0].uri;let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((-json.length)&3,32)]);const chunk=(type,b)=>{const h=Buffer.alloc(8);h.writeUInt32LE(b.length);h.writeUInt32LE(type,4);return Buffer.concat([h,b]);},payload=Buffer.concat([chunk(0x4e4f534a,json),chunk(0x004e4942,binary)]),header=Buffer.alloc(12);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(payload.length+12,8);files['model.glb']=Buffer.concat([header,payload]);
 }else files['model.gltf']=Buffer.from(JSON.stringify(doc));
 return {files,doc};
}
const READBACK=String.raw`
import sys,json,hashlib,math
from pathlib import Path
import bpy
mode,path,prefix,policyfile,out=sys.argv[sys.argv.index('--')+1:];policy=json.loads(Path(policyfile).read_text());file=Path(path);before=hashlib.sha256(file.read_bytes()).hexdigest()
if mode=='source':bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.import_scene.gltf(filepath=path)
else:bpy.ops.wm.open_mainfile(filepath=path)
bpy.context.view_layer.update();materials=[];meshes=[];images={}
def rounded(value):
 if isinstance(value,(float,int,bool,str)):return round(value,6) if isinstance(value,float) else value
 try:return [round(float(v),6) for v in value]
 except TypeError:return None
for material in bpy.data.materials:
 if not material.name.startswith(prefix+'-material-') or not material.use_nodes:continue
 tree=material.node_tree;nodes=[];uses=[]
 for node in tree.nodes:
  row={'name':node.name,'type':node.type,'label':node.label,'inputs':[(s.name,rounded(s.default_value)) for s in node.inputs if hasattr(s,'default_value')]}
  if node.type=='TEX_IMAGE':
   image=node.image;assert image and image.packed_file and list(image.size)==[8,8] and image.alpha_mode=='CHANNEL_PACKED'
   pixels=list(image.pixels[:]);assert image.has_data and pixels and all(math.isfinite(v) for v in pixels)
   packed=hashlib.sha256(image.packed_file.data).hexdigest();expected=policy['spaces'][node.label]
   if mode!='source':
    if expected is not None:assert image.colorspace_settings.name==expected,(node.label,image.colorspace_settings.name,expected)
    if node.label not in policy.get('baked',[]):assert packed==policy['sourceSha256'],'authored packed bytes changed'
   uses.append({'label':node.label,'image':image.name,'space':image.colorspace_settings.name,'alphaMode':image.alpha_mode,'packedSha256':packed,'alpha':[round(min(pixels[3::4]),6),round(max(pixels[3::4]),6)],'alphaSha256':hashlib.sha256(json.dumps([round(v,6) for v in pixels[3::4]],separators=(',',':')).encode()).hexdigest()})
   images[image.name]={'space':image.colorspace_settings.name,'packedSha256':packed,'size':list(image.size)}
   row.update(interpolation=node.interpolation,extension=node.extension)
   assert node.interpolation=='Closest' and node.extension=='EXTEND'
  if node.type=='UVMAP':row['uvMap']=node.uv_map
  if node.type=='MAPPING':row['vectorType']=node.vector_type
  if node.type=='MATH':row['operation']=node.operation
  nodes.append(row)
 assert uses
 materials.append({'graph':{'nodes':nodes,'links':[(l.from_node.name,l.from_socket.name,l.to_node.name,l.to_socket.name) for l in tree.links]},'uses':uses})
for obj in bpy.context.scene.objects:
 if obj.type!='MESH' or not any(s.material and s.material.name.startswith(prefix+'-material-') for s in obj.material_slots):continue
 meshes.append({'vertices':[[round(v,6) for v in obj.matrix_world@vertex.co] for vertex in obj.data.vertices],'polygons':[list(p.vertices) for p in obj.data.polygons],'materialIndices':[p.material_index for p in obj.data.polygons],'uv':[[[round(v,6) for v in loop.uv] for loop in layer.data] for layer in obj.data.uv_layers]})
assert materials and meshes and hashlib.sha256(file.read_bytes()).hexdigest()==before
assert set(policy['spaces'])=={u['label'] for m in materials for u in m['uses']},(policy,materials)
if mode!='source':assert len(images)==policy['allocations'],(images,policy)
Path(out).write_text(json.dumps({'passed':True,'nativeVersion':bpy.app.version_string,'sourceSha256':before,'unchanged':True,'materials':materials,'meshes':meshes,'images':images},indent=2)+'\n');print('IMPORTED_IMAGE_ROLES_READBACK_PASSED')
`;
const PIXELS=String.raw`
import sys,json,hashlib,math
from pathlib import Path
import bpy
checkpoint,directory=sys.argv[sys.argv.index('--')+1:];directory=Path(directory);file=Path(checkpoint);before=hashlib.sha256(file.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=checkpoint);scene=bpy.context.scene
scene.cycles.device='CPU';scene.cycles.seed=123;scene.cycles.use_denoising=False;scene.render.resolution_x=scene.render.resolution_y=128;scene.render.resolution_percentage=100;scene.cycles.samples=16;scene.view_settings.view_transform='Standard';scene.view_settings.look='None';scene.view_settings.exposure=0;scene.view_settings.gamma=1;scene.frame_set(1)
color=next(n.image for m in bpy.data.materials if m.use_nodes and m.name.startswith('core-material-') for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.label=='BASE COLOR');data=next(n.image for m in bpy.data.materials if m.use_nodes and m.name.startswith('core-material-') for n in m.node_tree.nodes if n.type=='TEX_IMAGE' and n.label=='METALLIC ROUGHNESS')
assert color!=data and color.colorspace_settings.name=='sRGB' and data.colorspace_settings.name=='Non-Color';packed=hashlib.sha256(color.packed_file.data).hexdigest();rows=[]
for name,space in [('product','sRGB'),('wrong-color-role','Non-Color'),('restored','sRGB')]:
 color.colorspace_settings.name=space;path=directory/(name+'.png');scene.render.filepath=str(path);bpy.ops.render.render(write_still=True);image=bpy.data.images.load(str(path),check_existing=False);pixels=list(image.pixels[:]);assert pixels and all(math.isfinite(v) for v in pixels);assert max(pixels[0:-1:4])-min(pixels[0:-1:4])>.01;bpy.data.images.remove(image);assert data.colorspace_settings.name=='Non-Color';assert hashlib.sha256(color.packed_file.data).hexdigest()==packed;rows.append({'name':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
assert hashlib.sha256(file.read_bytes()).hexdigest()==before
(directory/'pixels.json').write_text(json.dumps({'passed':True,'checkpointSha256':before,'unchanged':True,'rows':rows,'nativeVersion':bpy.app.version_string,'render':{'engine':scene.render.engine,'camera':scene.camera.name,'frame':1,'resolution':[128,128],'samples':16,'seed':123,'viewTransform':'Standard','exposure':0,'denoising':False}},indent=2)+'\n');print('IMPORTED_ROLES_CONTROLLED_PIXELS_PASSED')
`;
const PRESERVE=String.raw`
import sys,json,hashlib
from pathlib import Path
import bpy
root,project,specfile,checkpoint,out=sys.argv[sys.argv.index('--')+1:];sys.path.insert(0,str(Path(root)/'packages/deepblend/provider-local/python'));import deepblend_scene as compiler
from deepblend_util import Guard,ActionError
file=Path(checkpoint);before=hashlib.sha256(file.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=checkpoint);objects=set(bpy.data.objects);images=set(bpy.data.images);calls=[]
def forbidden(*args):calls.append(args);raise AssertionError('mixed-role budget reached native import')
compiler.import_asset_into_scene=forbidden
try:compiler.build_scene(json.loads(Path(specfile).read_text()),{'project_root':project,'profile':'preview'},Guard())
except ActionError as e:assert e.code=='ASSET_CONTENT_MISMATCH'
else:raise AssertionError('mixed-role allocation budget accepted')
assert not calls and set(bpy.data.objects)==objects and set(bpy.data.images)==images and hashlib.sha256(file.read_bytes()).hexdigest()==before
Path(out).write_text(json.dumps({'passed':True,'imports':0,'objectsPreserved':True,'imagesPreserved':True,'checkpointSha256':before,'code':'ASSET_CONTENT_MISMATCH'},indent=2)+'\n')
`;
export async function checkImportedImageRoles({studio,output,root,python,check}){
 mkdirSync(output);const source=encodePng({width:8,height:8,data:Buffer.from(Array.from({length:64},(_,i)=>i%2?[20,150,90,128]:[160,40,10,200]).flat())}),spec=defaultSceneSpec({projectId:'imported-image-roles',title:'Imported image roles'});spec.cameras[0]={id:'camera-main',lens:50,sensorWidth:36,clipping:[.001,10],transform:{location:[.04,-.3,.04],rotationEuler:[Math.PI/2,0,0],scale:[1,1,1]}};spec.lights[0].transform={location:[.04,-.2,.04],rotationEuler:[Math.PI/2,0,0],scale:[1,1,1]};spec.lights[0].energy=1;spec.lights[0].size=.1;spec.renderProfiles.preview.resolution=[128,128];spec.renderProfiles.preview.samples=16;spec.renderProfiles.preview.colorManagement.viewTransform='Standard';
 const created=await studio.createProject({title:spec.project.title,sceneSpec:spec,saveCheckpoint:true}),projectId=created.projectId,project=studio.store.projectDirectory(projectId),rows=[];writeFileSync(join(output,'authored.png'),source);
 const apply=operations=>studio.applyScenePatch({projectId,baseRevision:studio.store.currentRevision(projectId),operations}),ingest=async(name,files)=>{const directory=join(output,name);mkdirSync(directory);for(const[p,b]of Object.entries(files))writeFileSync(join(directory,p),b);const entry=files['model.glb']?'model.glb':'model.gltf',item=await studio.ingestAsset({projectId,sourceRoot:directory,sourcePath:join(directory,entry),assetId:name,license:'MIT'});save(join(output,name+'-ingest.json'),item);return item;},declaration=item=>({id:item.assetId,path:item.path,type:item.type,sha256:item.sha256});
 const core={pbrMetallicRoughness:{baseColorTexture:ref(0),metallicRoughnessTexture:ref(0),roughnessFactor:1,metallicFactor:1}},extensions={pbrMetallicRoughness:{baseColorTexture:ref(0)},normalTexture:ref(0),emissiveTexture:ref(0),occlusionTexture:ref(0),extensions:{KHR_materials_clearcoat:{clearcoatFactor:.5,clearcoatTexture:ref(0),clearcoatRoughnessTexture:ref(0),clearcoatNormalTexture:ref(0)},KHR_materials_transmission:{transmissionFactor:.5,transmissionTexture:ref(0)},KHR_materials_volume:{thicknessFactor:.01,thicknessTexture:ref(0)},KHR_materials_specular:{specularFactor:.5,specularTexture:ref(0),specularColorTexture:ref(0)},KHR_materials_sheen:{sheenColorFactor:[.3,.3,.3],sheenColorTexture:ref(0),sheenRoughnessTexture:ref(0)},KHR_materials_iridescence:{iridescenceFactor:.25,iridescenceTexture:ref(0),iridescenceThicknessTexture:ref(0)},KHR_materials_anisotropy:{anisotropyStrength:.25,anisotropyTexture:ref(0)}}};
 const alpha={extensions:{KHR_materials_specular:{specularTexture:ref(0)}}},simple=index=>({index});
 const variants=[
  {name:'core',kind:'gltf',materials:[core],spaces:{'BASE COLOR':COLOR,'METALLIC ROUGHNESS':DATA},allocations:2},
  {name:'core-glb',kind:'glb',materials:[core],spaces:{'BASE COLOR':COLOR,'METALLIC ROUGHNESS':DATA},allocations:2},
  {name:'external-alias',kind:'gltf',external:true,alias:true,materials:[{pbrMetallicRoughness:{metallicRoughnessTexture:ref(0),baseColorTexture:ref(1)}}],spaces:{'BASE COLOR':COLOR,'METALLIC ROUGHNESS':DATA},allocations:2},
  {name:'alpha-data',kind:'gltf',materials:[alpha,{normalTexture:ref(0)}],spaces:{'SPECULAR':null,'NORMAL MAP':DATA},allocations:1},
  {name:'alpha-color',kind:'gltf',materials:[alpha,{pbrMetallicRoughness:{baseColorTexture:ref(0)}}],spaces:{'SPECULAR':null,'BASE COLOR':COLOR},allocations:1},
  {name:'extensions',kind:'gltf',materials:[extensions],spaces:{'BASE COLOR':COLOR,'EMISSIVE':COLOR,'NORMAL MAP':DATA,'OCCLUSION':DATA,'CLEARCOAT':DATA,'CLEARCOAT ROUGHNESS':DATA,'CLEARCOAT NORMAL':DATA,'TRANSMISSION':DATA,'THICKNESS':DATA,'SPECULAR':COLOR,'SPECULAR COLOR':COLOR,'SHEEN COLOR':COLOR,'SHEEN ROUGHNESS':null,'IRIDESCENCE':DATA,'IRIDESCENCE THICKNESS':DATA,'ANISOTROPY':DATA},allocations:2},
  {name:'specular-glossiness',kind:'gltf',materials:[{normalTexture:simple(0),extensions:{KHR_materials_pbrSpecularGlossiness:{diffuseTexture:simple(0),specularGlossinessTexture:simple(0),glossinessFactor:1}}}],spaces:{'DIFFUSE':COLOR,'NORMAL MAP':DATA,'SPECULAR COLOR':COLOR,'ROUGHNESS':null},allocations:3,baked:['ROUGHNESS'],simple:true},
 ];
 let coreCheckpoint;
 for(const variant of variants){
  const data=fixture(variant.name,variant.kind,variant.materials,source,variant),item=await ingest(variant.name,data.files),asset=declaration(item);await apply([...(variant.name==='core'?[{op:'entity.remove',entityId:'subject'}]:[]),{op:'asset.add',asset},{op:'entity.add',entity:{id:asset.id,type:'asset-instance',assetId:asset.id}}]);const revision=studio.store.currentRevision(projectId),checkpoint=join(project,'revisions',revision,'scene.blend'),before=sha(readFileSync(checkpoint)),policy=join(output,variant.name+'-policy.json'),actual=join(output,variant.name+'-readback.json'),native=join(output,variant.name+'-native.json');save(policy,{spaces:variant.spaces,allocations:variant.allocations,baked:variant.baked??[],sourceSha256:sha(source)});python(variant.name+'-readback',READBACK,['checkpoint',checkpoint,variant.name,policy,actual]);python(variant.name+'-native',READBACK,['source',join(output,variant.name,'model.'+variant.kind),variant.name,policy,native]);const facts=JSON.parse(readFileSync(actual)),original=JSON.parse(readFileSync(native));
  check(variant.name+' independently preserves packed color/data interpretations',facts.passed&&facts.unchanged);
  const graphs=value=>value.materials.map(m=>m.graph);check(variant.name+' keeps native UV, sampler, node links and geometry',JSON.stringify(graphs(facts))===JSON.stringify(graphs(original))&&JSON.stringify(facts.meshes)===JSON.stringify(original.meshes));
  const alphas=value=>value.materials.flatMap(m=>m.uses.map(u=>({label:u.label,alpha:u.alpha,alphaSha256:u.alphaSha256})));check(variant.name+' preserves native alpha values and source checkpoint bytes',JSON.stringify(alphas(facts))===JSON.stringify(alphas(original))&&sha(readFileSync(checkpoint))===before);rows.push({name:variant.name,revision,checkpointSha256:before,readback:variant.name+'-readback.json',native:variant.name+'-native.json',policy:variant.name+'-policy.json',sourceSha256:item.sha256});if(variant.name==='core')coreCheckpoint=checkpoint;
 }
 const repeated=await studio.applyScenePatch({projectId,baseRevision:studio.store.currentRevision(projectId),operations:[{op:'entity.add',entity:{id:'external-alias-second',type:'asset-instance',assetId:'external-alias'}}]}),repeatRevision=studio.store.currentRevision(projectId),repeatCheckpoint=join(project,'revisions',repeatRevision,'scene.blend'),repeatPolicy=join(output,'external-alias-repeat-policy.json');save(repeatPolicy,{spaces:{'BASE COLOR':COLOR,'METALLIC ROUGHNESS':DATA},allocations:3,sourceSha256:sha(source)});python('external-alias-repeat-readback',READBACK,['checkpoint',repeatCheckpoint,'external-alias',repeatPolicy,join(output,'external-alias-repeat-readback.json')]);check('repeated external images protect both instances and reuse matching data roles',JSON.parse(readFileSync(join(output,'external-alias-repeat-readback.json'))).passed);assert(repeated);
 const preview=await studio.renderPreview({projectId,revision:rows[0].revision,cameraId:'camera-main',frame:1});save(join(output,'preview.json'),preview);const png=decodePng(readFileSync(join(project,preview.artifacts[0].path)));check('public saved mixed-use scene produces a real nonconstant preview',png.width===128&&png.height===128&&new Set(Array.from({length:png.width*png.height},(_,i)=>png.data.subarray(i*4,i*4+3).toString('hex'))).size>32);
 python('controlled-role-pixels',PIXELS,[coreCheckpoint,output]);const pixels=['product','wrong-color-role','restored'].map(name=>decodePng(readFileSync(join(output,name+'.png'))));let changed=0;for(let n=0;n<pixels[0].data.length;n+=4)if([0,1,2].some(c=>pixels[0].data[n+c]!==pixels[1].data[n+c]))changed++;check('only wrong color interpretation changes fixed rendered pixels',changed>100);check('restoring color interpretation restores identical rendered pixels',pixels[0].data.every((v,i)=>v===pixels[2].data[i]));
 const badPath=join(output,'broken.gltf');writeFileSync(badPath,'{}');python('constructor-restoration',String.raw`
import sys,json
from pathlib import Path
import bpy
root,bad,good,out=sys.argv[sys.argv.index('--')+1:];sys.path.insert(0,str(Path(root)/'packages/deepblend/provider-local/python'));from deepblend_gltf_import import import_gltf
from io_scene_gltf2.io.imp.gltf2_io_gltf import glTFImporter
before=glTFImporter.__init__
try:result=import_gltf(bad);assert result=={'CANCELLED'}
except RuntimeError:pass
assert glTFImporter.__init__ is before
result=import_gltf(good);assert result=={'FINISHED'} and glTFImporter.__init__ is before
Path(out).write_text(json.dumps({'passed':True,'successAndFailureRestored':True})+'\n')
`,[root,badPath,join(output,'core/model.gltf'),join(output,'constructor-restoration.json')]);check('native constructor is restored after failed and successful imports',JSON.parse(readFileSync(join(output,'constructor-restoration.json'))).passed);
 // Metadata-only payload is deliberately never decoded: two role allocations
 // at 512 MiB each, plus the existing normal images, exceed the scene budget.
 const header=Buffer.from(encodePng({width:1,height:1,data:Buffer.from([90,30,20,128])}));header.writeUInt32BE(8192,16);header.writeUInt32BE(4096,20);let crc=0xffffffff;for(const v of header.subarray(12,29)){crc^=v;for(let n=0;n<8;n++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}header.writeUInt32BE((crc^0xffffffff)>>>0,29);const overflow=await ingest('role-budget',fixture('role-budget','gltf',[core],header).files),revision=studio.store.currentRevision(projectId),checkpoint=join(project,'revisions',revision,'scene.blend'),before=sha(readFileSync(checkpoint)),saved=JSON.parse(readFileSync(join(project,'revisions',revision,'scene-spec.json')));let error;try{await apply([{op:'asset.add',asset:declaration(overflow)},{op:'entity.add',entity:{id:overflow.assetId,type:'asset-instance',assetId:overflow.assetId}}]);}catch(e){error=e;}check('mixed-role aggregate refusal protects actual public revision and checkpoint',error?.code==='ASSET_CONTENT_MISMATCH'&&studio.store.currentRevision(projectId)===revision&&sha(readFileSync(checkpoint))===before);saved.assets.push(declaration(overflow));saved.entities.push({id:overflow.assetId,type:'asset-instance',assetId:overflow.assetId});save(join(output,'budget-rejected-spec.json'),saved);python('role-budget-preservation',PRESERVE,[root,project,join(output,'budget-rejected-spec.json'),checkpoint,join(output,'budget-preservation.json')]);check('mixed-role image allocations refuse before scene reset or any native import',JSON.parse(readFileSync(join(output,'budget-preservation.json'))).passed);
 const report={passed:true,project,rows,repeatRevision,repeatCheckpointSha256:sha(readFileSync(repeatCheckpoint)),revision,checkpointSha256:before,authoredImageSha256:sha(source),controlledChangedPixels:changed,metadataOnlyBudget:true,scope:'Actual public Host saves and render, independent native checkpoint/encoded-source/UV/sampler/alpha checks, repeated instances, constructor restoration and pre-reset refusal. Fixed pixels prove only the color interpretation effect; artistic/human acceptance remains open.'};save(join(output,'report.json'),report);
}
