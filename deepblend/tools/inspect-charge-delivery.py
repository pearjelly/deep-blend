"""Independently reopen the saved DeepBlend scene and audit imported model completeness."""
import bpy,json,sys,hashlib
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
checkpoint,prepared_receipt,output=sys.argv[sys.argv.index('--')+1:]
prepared=json.load(open(prepared_receipt))
bpy.ops.wm.open_mainfile(filepath=checkpoint,load_ui=False)
bpy.context.scene.frame_set(1);bpy.context.view_layer.update()
root=bpy.data.objects.get('db_entity__packbot')
if root is None:raise RuntimeError('The saved DeepBlend scene has no Packbot instance')
meshes=[o for o in root.children_recursive if o.type=='MESH']
polygons=sum(len(o.data.polygons) for o in meshes)
if len(meshes)!=prepared['partCount'] or polygons!=prepared['polygons']:raise RuntimeError('Imported official geometry is incomplete')
images=set();visited=set()
def walk(tree):
 if not tree or tree in visited:return
 visited.add(tree)
 for node in tree.nodes:
  if getattr(node,'image',None):images.add(node.image)
  if getattr(node,'node_tree',None):walk(node.node_tree)
for obj in meshes:
 for material in obj.data.materials:
  if material:walk(material.node_tree)
rows=[]
for image in images:
 if image.source=='FILE':
  if not image.packed_file or min(image.size)<=0:raise RuntimeError('Used texture is not self-contained: '+image.name)
  rows.append({'name':image.name,'size':list(image.size),'packed':True})
framing=[]
for frame in [1,72,144]:
 bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
 points=[o.matrix_world@Vector(corner) for o in meshes for corner in o.bound_box]
 projected=[world_to_camera_view(bpy.context.scene,bpy.data.objects['db_camera__hero'],p) for p in points]
 box=[min(p.x for p in projected),min(p.y for p in projected),max(p.x for p in projected),max(p.y for p in projected)]
 if not (0<box[0]<box[2]<1 and 0<box[1]<box[3]<1 and min(p.z for p in projected)>0):raise RuntimeError('The whole Packbot bound does not fit the hero camera')
 framing.append({'frame':frame,'camera':'hero','normalizedBoundingBox':box,'inFrame':True,'lowestWorldZ':min(p.z for p in points)})
result={'passed':True,'blenderVersion':bpy.app.version_string,'checkpointSha256':hashlib.sha256(open(checkpoint,'rb').read()).hexdigest(),'importedMeshParts':len(meshes),'polygons':polygons,'packedImages':rows,'heroFraming':framing,'sceneObjects':len(bpy.context.scene.objects),'cameraCount':len([o for o in bpy.context.scene.objects if o.type=='CAMERA']),'frameRange':[bpy.context.scene.frame_start,bpy.context.scene.frame_end],'method':'Independent native reopening, actual instance members, retained polygon count, reachable packed images and projected world-space mesh bounds. This is verification only, not a scene-authoring or rendering path.'}
json.dump(result,open(output,'w'),indent=2);print('Independent scene audit passed:',len(meshes),'parts;',polygons,'polygons;',len(rows),'packed images')
