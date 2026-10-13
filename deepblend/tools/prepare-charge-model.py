"""Freeze the official Packbot's frame-1 visible geometry into one importable asset.
No scene rendering or postproduction happens here; DeepBlend creates the final scene.
"""
import bpy,json,sys,os,hashlib
from mathutils import Matrix
source,output=sys.argv[sys.argv.index('--')+1:]
source=os.path.abspath(source);output=os.path.abspath(output)
bpy.ops.wm.open_mainfile(filepath=source,load_ui=False)
scene=bpy.context.scene;scene.frame_set(1);bpy.context.view_layer.update()
dg=bpy.context.evaluated_depsgraph_get()
selected=[o for o in scene.objects if o.type=='MESH' and o.name.startswith('GEO') and not o.hide_render and any(c.name in ['pack_bot.geometry','pack_bot.hands','pack_bot.shading'] for c in o.users_collection)]
if len(selected)<60:raise RuntimeError('Official Packbot geometry selection is unexpectedly incomplete')
asset_scene=bpy.data.scenes.new('CHARGE Packbot / static frame 1')
rows=[];materials=set();points=[]
for original in selected:
 evaluated=original.evaluated_get(dg)
 mesh=bpy.data.meshes.new_from_object(evaluated,preserve_all_data_layers=True,depsgraph=dg)
 if not mesh.polygons:continue
 # Apply the sampled pose to the mesh, preserving material slots and UVs.
 mesh.transform(evaluated.matrix_world)
 obj=bpy.data.objects.new(original.name,mesh);asset_scene.collection.objects.link(obj)
 for v in mesh.vertices:points.append(v.co.copy())
 materials.update(m for m in mesh.materials if m is not None)
 rows.append({'sourceObject':original.name,'polygons':len(mesh.polygons),'vertices':len(mesh.vertices),'uvLayers':[uv.name for uv in mesh.uv_layers],'materials':[m.name if m else None for m in mesh.materials]})
# Pack only images reachable from retained material node trees.
images=set();visited=set()
def walk(tree):
 if not tree or tree in visited:return
 visited.add(tree)
 for node in tree.nodes:
  if getattr(node,'image',None):images.add(node.image)
  if getattr(node,'node_tree',None):walk(node.node_tree)
for material in materials:walk(material.node_tree)
image_rows=[]
for image in images:
 if image.source not in ['FILE','TILED']:continue
 path=bpy.path.abspath(image.filepath,library=image.library)
 if not image.packed_file:
  if not os.path.isfile(path):raise RuntimeError('Used CHARGE texture is missing: '+path)
  image.filepath=path;image.reload();image.pack()
 image_rows.append({'name':image.name,'size':list(image.size),'packed':bool(image.packed_file),'sourcePath':path,'sha256':hashlib.sha256(open(path,'rb').read()).hexdigest() if os.path.isfile(path) else None})
# An object-only library is accepted by DeepBlend and avoids copying source view layers.
# No rig, source lighting, source cameras or controllers are members of the library.
bpy.data.libraries.write(output,set(asset_scene.objects),fake_user=False,compress=True,path_remap='ABSOLUTE')
report={'source':source,'sourceSha256':hashlib.sha256(open(source,'rb').read()).hexdigest(),'outputSha256':hashlib.sha256(open(output,'rb').read()).hexdigest(),'sourceFrame':1,'method':'Evaluated static geometry; world transforms baked; original material slots and UV layers retained; used images packed. Original rig and animation excluded.','parts':rows,'partCount':len(rows),'polygons':sum(r['polygons'] for r in rows),'bounds':[[min(p[i] for p in points),max(p[i] for p in points)] for i in range(3)],'images':image_rows,'license':'CC-BY — Blender Studio / Blender Foundation; official Blender 3.4 CHARGE demo'}
json.dump(report,open(output+'.json','w'),indent=2)
print('Prepared official Packbot:',len(rows),'parts,',report['polygons'],'polygons,',len(images),'packed images')
