"""Inspect official CHARGE source data; do not render, rewrite or execute Text scripts."""
import bpy,json,sys,os
source,output=sys.argv[sys.argv.index('--')+1:]
bpy.ops.wm.open_mainfile(filepath=os.path.abspath(source),load_ui=False)
bpy.context.scene.frame_set(1);bpy.context.view_layer.update()
dg=bpy.context.evaluated_depsgraph_get()
rows=[]
for o in bpy.context.scene.objects:
 row={'name':o.name,'type':o.type,'renderHidden':o.hide_render,'viewportHidden':o.hide_viewport,'instanceType':o.instance_type,'collections':[c.name for c in o.users_collection],'materials':[s.material.name if s.material else None for s in o.material_slots]}
 if o.type=='MESH':
  e=o.evaluated_get(dg);m=e.to_mesh()
  try:
   points=[e.matrix_world@v.co for v in m.vertices]
   row['polygons']=len(m.polygons)
   if points:row['bounds']=[[min(p[i] for p in points),max(p[i] for p in points)] for i in range(3)]
  finally:e.to_mesh_clear()
 rows.append(row)
report={'source':source,'blenderVersion':bpy.app.version_string,'scenes':[s.name for s in bpy.data.scenes],'viewLayers':[v.name for v in bpy.context.scene.view_layers], 'objects':rows,'images':[{'name':i.name,'path':i.filepath,'resolved':bpy.path.abspath(i.filepath,library=i.library),'packed':bool(i.packed_file),'size':list(i.size),'exists':os.path.isfile(bpy.path.abspath(i.filepath,library=i.library))} for i in bpy.data.images if i.source=='FILE'],'libraries':[l.filepath for l in bpy.data.libraries]}
json.dump(report,open(output,'w'),indent=2)
print('CHARGE source inspected:',len(rows),'objects;',len(report['images']),'images')
