import bpy,bmesh,json,sys,hashlib,math
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from bpy_extras.object_utils import world_to_camera_view
checkpoint,out=map(Path,sys.argv[sys.argv.index('--')+1:]);before=hashlib.sha256(checkpoint.read_bytes()).hexdigest();bpy.ops.wm.open_mainfile(filepath=str(checkpoint),load_ui=False)
scene=bpy.context.scene;graph=bpy.context.evaluated_depsgraph_get();parts={};bvhs={};frames=[]
for obj in bpy.data.objects:
 if not obj.name.startswith('db_entity__') or obj.name=='db_entity__studio-floor':continue
 evaluated=obj.evaluated_get(graph);mesh=evaluated.to_mesh()
 if mesh is None:continue
 bm=bmesh.new();bm.from_mesh(mesh);bm.transform(obj.matrix_world);bm.normal_update();points=[v.co.copy() for v in bm.verts]
 if not points:bm.free();evaluated.to_mesh_clear();continue
 unseen=set(bm.verts);components=0
 while unseen:
  components+=1;stack=[unseen.pop()]
  while stack:
   for e in stack.pop().link_edges:
    for v in e.verts:
     if v in unseen:unseen.remove(v);stack.append(v)
 bounds=[[min(v[i] for v in points) for i in range(3)],[max(v[i] for v in points) for i in range(3)]];entity=obj.name.removeprefix('db_entity__');bvhs[entity]=BVHTree.FromBMesh(bm)
 parts[entity]={'nativeType':obj.type,'vertices':len(bm.verts),'faces':len(bm.faces),'components':components,'boundaryEdges':sum(e.is_boundary for e in bm.edges),'nonManifoldEdges':sum(not e.is_manifold for e in bm.edges),'signedVolume':bm.calc_volume(signed=True),'finite':all(math.isfinite(x) for v in points for x in v),'worldBounds':bounds,'dimensionsMm':[(bounds[1][i]-bounds[0][i])*1000 for i in range(3)],'scale':list(obj.scale),'materialNames':[x.material.name if x.material else None for x in obj.material_slots],'geometrySha256':hashlib.sha256(json.dumps({'vertices':[list(v) for v in points],'faces':[[v.index for v in f.verts] for f in bm.faces]},sort_keys=True).encode()).hexdigest()}
 camera=scene.camera
 if camera:frames.extend(world_to_camera_view(scene,camera,v) for v in points)
 bm.free();evaluated.to_mesh_clear()
# Radial rays at three fixed world heights. Report actual crossings, not global minimum thickness.
radial=[]
for z in [.34,.37,.40]:
 hits={}
 for entity in ['shade-shell','shade-enamel-lining']:
  origin=Vector((-.2,0,z));direction=Vector((1,0,0));found=[]
  for i in range(8):
   location,normal,face,distance=bvhs[entity].ray_cast(origin,direction,.6)
   if location is None:break
   found.append(list(location));origin=location+direction*1e-7
  hits[entity]=found
 shell=hits['shade-shell'];liner=hits['shade-enamel-lining']
 radial.append({'worldHeightMm':z*1000,'hits':hits,'shellRadialThicknessMm':(shell[1][0]-shell[0][0])*1000 if len(shell)>=2 else None,'shellLinerRadialGapMm':(liner[0][0]-shell[1][0])*1000 if len(shell)>=2 and liner else None})
normalSamples=[]
for height in [.34,.37,.40]:
 outer,normal,face,distance=bvhs['shade-shell'].ray_cast(Vector((-.2,0,height)),Vector((1,0,0)),.5)
 if outer is None:raise RuntimeError('No shell normal sample origin')
 inward=-normal.normalized();inner,n2,f2,d2=bvhs['shade-shell'].ray_cast(outer+inward*1e-7,inward,.05)
 if inner is None:raise RuntimeError('No shell opposite boundary')
 liner,n3,f3,d3=bvhs['shade-enamel-lining'].ray_cast(inner+inward*1e-7,inward,.01)
 normalSamples.append({'outerHeightMm':height*1000,'normalWallThicknessMm':(inner-outer).length*1000,'normalShellLinerGapMm':(liner-inner).length*1000 if liner else None})
report={'checkpointSha256':before,'checkpointUnchanged':hashlib.sha256(checkpoint.read_bytes()).hexdigest()==before,'blenderVersion':bpy.app.version_string,'parts':parts,'radialSamples':radial,'normalWallSamples':normalSamples,'renderConfig':{'resolution':[scene.render.resolution_x,scene.render.resolution_y],'percentage':scene.render.resolution_percentage,'samples':scene.cycles.samples,'frame':scene.frame_current,'camera':scene.camera.name if scene.camera else None},'projectedBounds':[[min(v[i] for v in frames) for i in range(3)],[max(v[i] for v in frames) for i in range(3)]] if frames else None,'scope':'Actual evaluated geometry; radial wall/liner samples are not all-surface minimum thickness. Bounds do not certify collisions or visual quality.'}
out.write_text(json.dumps(report,indent=2)+'\n');print('LAMP_NATIVE_MEASURED',len(parts))
