/** Public OBJ saves retain native graphs while numeric RGB uses stay linear. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {defaultSceneSpec} from '@deepblend/dsh-blender-host';
import {encodePng} from '@deepblend/dsh-blender-contracts';
import {PRESERVE} from './imported-image-budgets.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const save=(p,r)=>writeFileSync(p,JSON.stringify(r,null,2)+'\n');
const mesh='mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl painted\nf 1/1 2/2 3/3\n';
const READBACK=String.raw`
import bpy,sys,json,hashlib,math
from pathlib import Path
mode,path,entity,policy_path,out=sys.argv[sys.argv.index('--')+1:];policy=json.loads(Path(policy_path).read_text());file=Path(path);before=hashlib.sha256(file.read_bytes()).hexdigest()
if mode=='source':
 bpy.ops.wm.read_factory_settings(use_empty=True);bpy.ops.wm.obj_import(filepath=path);objects=list(bpy.context.scene.objects)
else:
 bpy.ops.wm.open_mainfile(filepath=path);root=bpy.data.objects['db_entity__'+entity];objects=[]
 for obj in bpy.context.scene.objects:
  parent=obj.parent
  while parent and parent!=root:parent=parent.parent
  if parent==root:objects.append(obj)
meshes=[];materials=set();uses=[];unique=set();graphs=[]
for obj in objects:
 if obj.type!='MESH':continue
 m=obj.data;assert all(math.isfinite(c) for v in m.vertices for c in v.co)
 meshes.append({'vertices':[list(v.co)for v in m.vertices],'faces':[list(p.vertices)for p in m.polygons],'uv':[[list(v.uv)for v in layer.data]for layer in m.uv_layers],'normals':[list(n.vector)for n in m.corner_normals],'world':[list(row)for row in obj.matrix_world]})
 materials.update(slot.material for slot in obj.material_slots if slot.material)
for material in materials:
 nodes=list(material.node_tree.nodes);index={node:i for i,node in enumerate(nodes)};graph={'nodes':[],'links':sorted([index[l.from_node],l.from_socket.name,index[l.to_node],l.to_socket.name]for l in material.node_tree.links)}
 for node in nodes:
  inputs={}
  for socket in node.inputs:
   if hasattr(socket,'default_value'):
    value=socket.default_value;inputs[socket.name]=value if isinstance(value,(float,int,bool,str))else list(value)
  properties={key:getattr(node,key)for key in ['interpolation','extension','projection','space','uv_map']if hasattr(node,key)}
  graph['nodes'].append({'type':node.type,'inputs':inputs,'properties':properties})
  if node.type!='TEX_IMAGE' or not node.image:continue
  image=node.image;size=list(image.size);pixels=list(image.pixels[:]);assert image.has_data and all(math.isfinite(v)for v in pixels)
  packed=bytes(image.packed_file.data) if image.packed_file else Path(bpy.path.abspath(image.filepath)).read_bytes();assert hashlib.sha256(packed).hexdigest()==policy['sourceSha256'];unique.add(image)
  targets=[{'node':l.to_node.type,'input':l.to_socket.name,'output':l.from_socket.name}for output in node.outputs for l in output.links]
  expected=[]
  for target in targets:
   if target['output']=='Alpha':continue
   key=target['node']+':'+target['input'];assert key in policy['spaces'],key;expected.append(policy['spaces'][key])
  if mode!='source':
   assert image.packed_file
   for space in expected:assert image.colorspace_settings.name==space,(targets,image.colorspace_settings.name,space)
  uses.append({'targets':targets,'colorspace':image.colorspace_settings.name,'size':size,'sourceSha256':hashlib.sha256(packed).hexdigest(),'pixelsSha256':hashlib.sha256(json.dumps(pixels,separators=(',',':')).encode()).hexdigest(),'alphaSha256':hashlib.sha256(json.dumps(pixels[3::4],separators=(',',':')).encode()).hexdigest(),'float':bool(image.is_float),'sourceSpace':image.get('deepblend_image_source_colorspace')})
 graphs.append(graph)
assert meshes and uses and len(unique)<=policy['allocations'];assert hashlib.sha256(file.read_bytes()).hexdigest()==before
Path(out).write_text(json.dumps({'passed':True,'unchanged':True,'sourceFileSha256':before,'meshes':sorted(meshes,key=lambda r:json.dumps(r,sort_keys=True)),'graphs':sorted(graphs,key=lambda r:json.dumps(r,sort_keys=True)),'uses':sorted(uses,key=lambda r:json.dumps(r['targets'],sort_keys=True)),'imageAllocations':len(unique),'nativeVersion':bpy.app.version_string,'buildHash':bpy.app.build_hash.decode()},indent=2)+'\n')
`;
const SHADER=String.raw`
import bpy,sys,json,hashlib,math
from pathlib import Path
checkpoint,entity,kind,directory,out=sys.argv[sys.argv.index('--')+1:];file=Path(checkpoint);before=hashlib.sha256(file.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=checkpoint);root=bpy.data.objects['db_entity__'+entity];material=next(slot.material for obj in bpy.data.objects if obj.parent==root and obj.type=='MESH' for slot in obj.material_slots if slot.material);target='NORMAL_MAP' if kind=='normal' else 'BSDF_PRINCIPLED';socket='Color' if kind=='normal' else 'Roughness';destination=next(n for n in material.node_tree.nodes if n.type==target);image=destination.inputs[socket].links[0].from_node.image;assert image.colorspace_settings.name=='Non-Color';packed=bytes(image.packed_file.data);rows=[]
scene=bpy.data.scenes.new('numeric probe');scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.seed=0;scene.cycles.use_adaptive_sampling=False;scene.render.resolution_x=16;scene.render.resolution_y=16;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='OPEN_EXR';scene.render.image_settings.color_depth='32';scene.view_settings.view_transform='Raw';scene.frame_set(1)
mesh=bpy.data.meshes.new('numeric plane');mesh.from_pydata([(-2,-2,0),(2,-2,0),(2,2,0),(-2,2,0)],[],[(0,1,2,3)]);uv=mesh.uv_layers.new()
for loop,coord in zip(uv.data,[(0,0),(1,0),(1,1),(0,1)]):loop.uv=coord
obj=bpy.data.objects.new('numeric plane',mesh);scene.collection.objects.link(obj);probe=bpy.data.materials.new('numeric probe');probe.use_nodes=True;nodes=probe.node_tree.nodes;nodes.clear();tex=nodes.new('ShaderNodeTexImage');tex.image=image;links=probe.node_tree.links;source=tex.outputs['Color']
if kind=='normal':
 normal=nodes.new('ShaderNodeNormalMap');normal.space='TANGENT';normal.inputs['Strength'].default_value=1;separate=nodes.new('ShaderNodeSeparateXYZ');scale=nodes.new('ShaderNodeMath');scale.operation='MULTIPLY';scale.inputs[1].default_value=.5;shift=nodes.new('ShaderNodeMath');shift.operation='ADD';shift.inputs[1].default_value=.5;links.new(source,normal.inputs['Color']);links.new(normal.outputs['Normal'],separate.inputs['Vector']);links.new(separate.outputs['X'],scale.inputs[0]);links.new(scale.outputs[0],shift.inputs[0]);source=shift.outputs[0]
else:
 scalar=nodes.new('ShaderNodeMath');scalar.operation='MULTIPLY';scalar.inputs[1].default_value=1;links.new(source,scalar.inputs[0]);source=scalar.outputs[0]
emission=nodes.new('ShaderNodeEmission');emission.inputs['Strength'].default_value=1;output=nodes.new('ShaderNodeOutputMaterial');links.new(source,emission.inputs['Color']);links.new(emission.outputs[0],output.inputs['Surface']);obj.data.materials.append(probe);camera=bpy.data.cameras.new('numeric camera');camera.type='ORTHO';camera.ortho_scale=2;cam=bpy.data.objects.new('numeric camera',camera);scene.collection.objects.link(cam);cam.location=(0,0,2);scene.camera=cam
for state,space in [('correct','Non-Color'),('wrong','sRGB'),('restored','Non-Color')]:
 image.colorspace_settings.name=space;path=Path(directory)/(entity+'-'+state+'.exr');scene.render.filepath=str(path);bpy.ops.render.render(write_still=True,scene=scene.name);result=bpy.data.images.load(str(path),check_existing=False);size=list(result.size);values=list(result.pixels[:]);actual=values[(8*16+8)*4:(8*16+8)*4+3];encoded=128/255 if state!='wrong' else ((128/255+.055)/1.055)**2.4;expected=encoded
 if kind=='normal':expected=(encoded*2-1)/math.sqrt(2*(encoded*2-1)**2+1)*.5+.5
 assert size==[16,16] and all(math.isfinite(v)for v in values);assert max(abs(v-expected)for v in actual)<.001,(actual,expected);rows.append({'state':state,'colorspace':space,'actualLinearShaderRgb':actual,'expected':expected,'pixelsSha256':hashlib.sha256(json.dumps(values,separators=(',',':')).encode()).hexdigest(),'file':str(path)})
assert rows[0]['pixelsSha256']==rows[2]['pixelsSha256'] and rows[0]['pixelsSha256']!=rows[1]['pixelsSha256'];assert bytes(image.packed_file.data)==packed and hashlib.sha256(file.read_bytes()).hexdigest()==before
Path(out).write_text(json.dumps({'passed':True,'actualNativeShaderRenders':3,'kind':kind,'rows':rows,'checkpointSha256':before,'sourceUnchanged':True,'scope':'Actual saved imported data image sampled by the native shader. Deliberately wrong color interpretation changes values; restoring data interpretation restores identical rendered pixels. No saved source is modified.'},indent=2)+'\n')
`;
export async function checkObjImageRoles({studio,output,root,python,check}) {
 mkdirSync(output);
 const spec=defaultSceneSpec({projectId:'obj-image-role-proof',title:'OBJ image roles'}),created=await studio.createProject({title:spec.project.title,sceneSpec:spec,saveCheckpoint:true}),projectId=created.projectId,project=studio.store.projectDirectory(projectId);
 const apply=operations=>studio.applyScenePatch({projectId,baseRevision:studio.store.currentRevision(projectId),operations});
 const rgba=Buffer.alloc(8*8*4,128);for(let i=3;i<rgba.length;i+=4)rgba[i]=255;const gray=encodePng({width:8,height:8,data:rgba});
 const normalRgba=Buffer.from(rgba);for(let i=2;i<normalRgba.length;i+=4)normalRgba[i]=255;const normal=encodePng({width:8,height:8,data:normalRgba});
 const manifest=JSON.parse(readFileSync(join(root,'deepblend/tests/fixtures/obj-image-formats/formats.json'))),rows=[];
 const numeric={'map_Pr':'Roughness','map_Pm':'Metallic','map_Ks':'Specular IOR Level','map_Ns':'Roughness','map_Ps':'Sheen Weight','refl':'Metallic'};
 const variants=Object.keys(numeric).map(map=>({name:map.replace('map_','').toLowerCase()+'-data',maps:[map]}));
 variants.push({name:'normal-data',maps:['map_Bump'],bytes:normal},{name:'color-normal',maps:['map_Kd','map_Bump'],bytes:normal},{name:'color-data',maps:['map_Kd','map_Pr']},{name:'alpha-only',maps:['map_d']},{name:'alpha-data',maps:['map_d','map_Pr']},{name:'alpha-color',maps:['map_d','map_Kd']},{name:'all-roles',maps:['map_Kd','map_Ke','map_Pr','map_d']},{name:'same-source-slots',maps:['map_Kd'],extraMaterial:'newmtl second\nmap_Pr paint.png\n',model:mesh+'usemtl second\nf 1/1 2/2 3/3\n'},{name:'overridden-numeric',maps:['map_Kd','map_Ns','map_Pr','map_Pm','refl']});
 for(const item of manifest.images)variants.push({name:'mixed-'+item.format.toLowerCase(),maps:['map_Kd','map_Pr'],file:item.file,bytes:readFileSync(join(root,'deepblend/tests/fixtures/obj-image-formats',item.file)),nativeSpace:item.nativeColorSpace});
 let previous;
 const ingest=async(name,files)=>{const source=join(output,name);mkdirSync(source);for(const[f,b]of Object.entries(files))writeFileSync(join(source,f),b);const receipt=await studio.ingestAsset({projectId,sourceRoot:source,sourcePath:join(source,'model.obj'),assetId:name,license:'MIT'});save(join(output,name+'-ingest.json'),receipt);rmSync(source,{recursive:true});return {receipt,asset:{id:receipt.assetId,path:receipt.path,type:receipt.type,sha256:receipt.sha256}};};
 for(const variant of variants){
  const name='obj-role-'+variant.name,file=variant.file??'paint.png',bytes=variant.bytes??gray,mtl='newmtl painted\nPr .24\nPm .15\n'+variant.maps.map(map=>map+' -s 2 3 1 -o .1 .2 0 '+file+'\n').join('')+(variant.extraMaterial??''),item=await ingest(name,{'model.obj':variant.model??mesh,'model.mtl':mtl,[file]:bytes});
  const spaces={};for(const map of variant.maps){if(map==='map_Kd')spaces['BSDF_PRINCIPLED:Base Color']=variant.nativeSpace??'sRGB';else if(map==='map_Ke')spaces['BSDF_PRINCIPLED:Emission Color']=variant.nativeSpace??'sRGB';else if(map==='map_Bump')spaces['NORMAL_MAP:Color']='Non-Color';else if(numeric[map])spaces['BSDF_PRINCIPLED:'+numeric[map]]='Non-Color';}if(variant.extraMaterial)spaces['BSDF_PRINCIPLED:Roughness']='Non-Color';
  const allocations=Object.values(spaces).includes('Non-Color')&&Object.values(spaces).some(v=>v!=='Non-Color')?2:1,policy={spaces,allocations,sourceSha256:sha(bytes)};save(join(output,name+'-policy.json'),policy);
  const operations=previous?[{op:'entity.remove',entityId:previous},{op:'asset.remove',assetId:previous}]:[];await apply([...operations,{op:'asset.add',asset:item.asset},{op:'entity.add',entity:{id:name,type:'asset-instance',assetId:name}}]);previous=name;
  const revision=studio.store.currentRevision(projectId),checkpoint=join(project,'revisions',revision,'scene.blend'),source=join(project,item.asset.path),actual=join(output,name+'-readback.json'),native=join(output,name+'-native.json'),policyPath=join(output,name+'-policy.json');
  python(name+'-readback',READBACK,['checkpoint',checkpoint,name,policyPath,actual]);python(name+'-native',READBACK,['source',source,name,policyPath,native]);const fixed=JSON.parse(readFileSync(actual)),original=JSON.parse(readFileSync(native));
  check(name+' keeps native geometry, UV, normals, mappings and shader links',JSON.stringify(fixed.meshes)===JSON.stringify(original.meshes)&&JSON.stringify(fixed.graphs)===JSON.stringify(original.graphs));
  const values=r=>r.uses.map(({targets,size,sourceSha256,pixelsSha256,alphaSha256,float})=>({targets,size,sourceSha256,pixelsSha256,alphaSha256,float}));check(name+' preserves exact source bytes and actual decoded pixels with typed RGB uses',fixed.passed&&JSON.stringify(values(fixed))===JSON.stringify(values(original)));
  rows.push({name,revision,checkpoint,sourceSha256:sha(bytes),bundleSha256:item.receipt.bundle.sha256,readback:actual,native,policy:policyPath});
 }
 const shaderRows=[];for(const [name,kind]of [['obj-role-pr-data','roughness'],['obj-role-normal-data','normal']]){const row=rows.find(r=>r.name===name),report=join(output,name+'-shader.json');python(name+'-shader',SHADER,[row.checkpoint,row.name,kind,output,report]);const facts=JSON.parse(readFileSync(report));check(name+' actual shader preserves authored linear data and immutable saved sources',facts.passed&&facts.sourceUnchanged);check(name+' wrong RGB interpretation changes real pixels and restoring data exactly recovers them',facts.rows[0].pixelsSha256===facts.rows[2].pixelsSha256&&facts.rows[0].pixelsSha256!==facts.rows[1].pixelsSha256);shaderRows.push({name,report});}
 const repeat=await apply([{op:'entity.add',entity:{id:'obj-role-second',type:'asset-instance',assetId:previous}}]),revision=studio.store.currentRevision(projectId),checkpoint=join(project,'revisions',revision,'scene.blend'),last=rows.at(-1),policy=last.policy;
 for(const id of [previous,'obj-role-second']){const actual=join(output,id+'-repeat-readback.json');python(id+'-repeat',READBACK,['checkpoint',checkpoint,id,policy,actual]);check(id+' repeated import preserves both original and new color/data users',JSON.parse(readFileSync(actual)).passed);}assert(repeat);
 const interop=await ingest('obj-role-explicit-data',{'model.obj':mesh,'model.mtl':'newmtl painted\nmap_Kd paint.png\n','paint.png':gray}),imageAsset={id:'obj-role-shared-image',type:'png',path:join(dirname(interop.asset.path),'paint.png'),sha256:sha(gray)};let boundaryError;try{await apply([{op:'asset.add',asset:imageAsset}]);}catch(error){boundaryError=error;}check('bundle texture cannot masquerade as a standalone asset entrypoint',boundaryError?.code==='ASSET_REQUEST_INVALID'&&studio.store.currentRevision(projectId)===revision);
 const interopRevision=revision,interopCheckpoint=checkpoint,interopReport=join(output,'explicit-data-interop.json');
 python('obj-role-explicit-data-interop',String.raw`
import bpy,sys,json,hashlib
from pathlib import Path
root,project,image_path,model_path,checkpoint,out,expected=sys.argv[sys.argv.index('--')+1:];sys.path.insert(0,str(Path(root)/'packages/deepblend/provider-local/python'));from deepblend_images import load_packed_image
from deepblend_obj_import import import_obj
file=Path(checkpoint);before=hashlib.sha256(file.read_bytes()).hexdigest();data=load_packed_image({'path':image_path},project,'Non-Color');protected=bpy.data.materials.new('protected numeric user');protected.use_nodes=True;node=protected.node_tree.nodes.new('ShaderNodeTexImage');node.image=data;before_objects=set(bpy.data.objects);result=import_obj(str(Path(project)/model_path));assert result=={'FINISHED'};material=next(slot.material for obj in bpy.data.objects if obj not in before_objects and obj.type=='MESH' for slot in obj.material_slots if slot.material);shader=next(n for n in material.node_tree.nodes if n.type=='BSDF_PRINCIPLED');color=shader.inputs['Base Color'].links[0].from_node.image;assert data!=color and node.image==data and data.colorspace_settings.name=='Non-Color' and color.colorspace_settings.name=='sRGB';color.pack();assert all(i.packed_file and hashlib.sha256(i.packed_file.data).hexdigest()==expected for i in [data,color]);assert hashlib.sha256(file.read_bytes()).hexdigest()==before;Path(out).write_text(json.dumps({'passed':True,'dataSpace':data.colorspace_settings.name,'colorSpace':color.colorspace_settings.name,'separateImages':True,'sourceUnchanged':True,'checkpointSha256':before,'scope':'Actual native packed image loader and OBJ wrapper with an existing protected numeric user of the same file. This is not a public SceneSpec declaration outside the bundle entrypoint boundary.'})+'\n')
 `,[root,project,imageAsset.path,interop.asset.path,checkpoint,interopReport,sha(gray)]);check('native OBJ color import restores file space after a protected numeric image binding',JSON.parse(readFileSync(interopReport)).passed);
 for(const row of rows)check(row.name+' prior saved scene remains byte-identical',sha(readFileSync(row.checkpoint))===JSON.parse(readFileSync(row.readback)).sourceFileSha256);
 // Synthetic metadata measures role costs only; never decode the large payload.
 const header=Buffer.from(gray);header.writeUInt32BE(8192,16);header.writeUInt32BE(4096,20);let crc=0xffffffff;for(const b of header.subarray(12,29)){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}header.writeUInt32BE((crc^0xffffffff)>>>0,29);
 const budgetRevision=interopRevision,budgetCheckpoint=interopCheckpoint;
 const oversized=await ingest('obj-role-budget',{'model.obj':mesh,'model.mtl':'newmtl painted\nmap_Kd paint.png\nmap_Pr paint.png\n','paint.png':header}),before=sha(readFileSync(budgetCheckpoint)),saved=JSON.parse(readFileSync(join(project,'revisions',budgetRevision,'scene-spec.json')));let error;try{await apply([{op:'asset.add',asset:oversized.asset},{op:'entity.add',entity:{id:oversized.asset.id,type:'asset-instance',assetId:oversized.asset.id}}]);}catch(e){error=e;}
 check('mixed OBJ role budget refuses before publishing or changing the saved checkpoint',error?.code==='ASSET_CONTENT_MISMATCH'&&studio.store.currentRevision(projectId)===budgetRevision&&sha(readFileSync(budgetCheckpoint))===before);saved.assets.push(oversized.asset);saved.entities.push({id:oversized.asset.id,type:'asset-instance',assetId:oversized.asset.id});save(join(output,'budget-rejected-spec.json'),saved);python('obj-role-budget-preservation',PRESERVE,[root,project,join(output,'budget-rejected-spec.json'),budgetCheckpoint,join(output,'budget-preservation.json')]);check('mixed OBJ role budget retains live objects and images before native import',JSON.parse(readFileSync(join(output,'budget-preservation.json'))).passed);
 save(join(output,'report.json'),{passed:true,project,projectId,rows,shaderRows,repeatRevision:revision,repeatCheckpoint:checkpoint,interopRevision,interopCheckpoint,interopReport,budgetRevision,budgetCheckpoint,metadataOnlyBudget:true,scope:'Actual public Host/native saved OBJ graph, geometry, decoded pixels, packed bytes, numeric/color/alpha roles, fifteen raster formats, repeated imports, explicit binding reuse, measured scalar/normal shader values and pre-reset typed-buffer budget refusal. Artistic and full decoder peak-memory acceptance remain separate.'});
}
