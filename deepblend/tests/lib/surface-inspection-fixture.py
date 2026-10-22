"""Independent analytic/refusal scenes for the actual Provider inspection path."""
import bpy, json, sys
from pathlib import Path
from mathutils import Vector

output=Path(sys.argv[sys.argv.index('--')+1]);output.mkdir(parents=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
def cube(id,dimensions,location=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1,location=location)
    obj=bpy.context.object;obj.name='db_entity__'+id;obj.scale=dimensions
    bpy.context.view_layer.update();return obj

wall=cube('wall',(.002,.04,.04));cube('liner',(.002,.04,.04),(.004,0,0))
cube('overlap',(.002,.04,.04),(.0015,0,0));cube('far',(.002,.04,.04),(.4,0,0))
rotated=cube('rotated',(.002,.04,.04),(.05,-.02,.03));rotated.rotation_euler[2]=.47
reflected=cube('reflected',(-.002,.04,.04),(.09,-.02,.03))
disabled=cube('disabled',(.002,.04,.04));disabled.hide_viewport=True
bpy.ops.mesh.primitive_plane_add(size=.02);bpy.context.object.name='db_entity__plane'
bpy.ops.mesh.primitive_torus_add(major_segments=128,minor_segments=256,major_radius=.01,minor_radius=.002)
bpy.context.object.name='db_entity__torus';cube('beyond',(.002,.04,.04),(.015,0,0))
mesh=bpy.data.meshes.new('budget');mesh.from_pydata([(i*1e-7,0,0) for i in range(250001)],[],[(0,1,2)])
obj=bpy.data.objects.new('db_entity__budget',mesh);bpy.context.collection.objects.link(obj)
curve=bpy.data.curves.new('curve','CURVE');curve.dimensions='3D';s=curve.splines.new('POLY');s.points.add(1);s.points[0].co=(0,0,0,1);s.points[1].co=(0,0,.01,1)
obj=bpy.data.objects.new('db_entity__curve',curve);bpy.context.collection.objects.link(obj)
bpy.context.scene.frame_set(24);bpy.context.view_layer.update()
def q(id,source='wall',origin=(-.02,0,0),direction=(1,0,0),target=None):
    r={'sampleId':id,'entityId':source,'originMeters':list(origin),'direction':list(direction),'searchDistanceMm':50}
    if target:r['targetEntityId']=target
    return r
origin=rotated.matrix_world @ Vector((-10,0,0));direction=rotated.matrix_world.to_3x3() @ Vector((1,0,0))
groups=[
 {'entities':['wall','liner','overlap','rotated','reflected','plane'],'samples':[
     q('known',target='liner'),q('miss',origin=(-.02,.08,0)),q('inside',origin=(0,0,0)),q('oblique',origin=(-.02,-.019,0),direction=(1,1,0)),
     q('rotated','rotated',origin,direction),q('reflected','reflected',(.06,-.02,.03)),q('plane','plane',(0,0,.02),(0,0,-1)),q('overlap',target='overlap')]},
 {'entities':['wall','disabled','budget','curve','far'],'samples':[q('disabled','disabled'),q('budget','budget'),q('curve','curve'),q('far',target='far')]},
 {'entities':['torus','beyond'],'samples':[q('occluded','torus',(-.025,0,0),target='beyond')]},
]
# Physical object-axis witnesses: construction scale, reflection, evaluation and shear.
axis_cube=cube('axis-physical',(.3,.15,.18),(3,3,3));axis_cube.rotation_euler=(-.2,.3,1.0471975511965976)
axis_reflect=cube('axis-reflected',(-.3,.15,.18),(5,3,3));axis_reflect.rotation_euler=(-.2,.3,1.0471975511965976)
axis_array=cube('axis-evaluated',(.2,.1,.05),(7,3,3));modifier=axis_array.modifiers.new('evaluated-array','ARRAY');modifier.count=2;modifier.relative_offset_displace=(1,0,0)
parent=bpy.data.objects.new('axis-shear-parent',None);bpy.context.collection.objects.link(parent);parent.scale=(2,1,1)
sheared=cube('axis-sheared',(.1,.2,.3),(9,3,3));sheared.parent=parent;sheared.rotation_euler[2]=.7853981633974483
cube('axis-degenerate',(0,.2,.3),(11,3,3))
bpy.context.view_layer.update()
# Aggregate imported-container witnesses: nested transforms, evaluated modifiers,
# hidden children, another entity's ownership and no partial over-budget result.
def asset_root(id):
    root=bpy.data.objects.new('db_entity__'+id,None)
    bpy.context.collection.objects.link(root)
    return root
root=asset_root('asset-whole');root.location=(3,4,5);root.scale=(2,2,2);root.rotation_euler[2]=1.5707963267948966
first=cube('asset-part-one',(1,2,1),(1,0,.25));first.name='imported-one';first.parent=root
nested=bpy.data.objects.new('imported-nested',None);bpy.context.collection.objects.link(nested);nested.parent=root
second=cube('asset-part-two',(.5,.5,1),(-1,0,1));second.name='imported-two';second.parent=nested
mod=second.modifiers.new('native-extra-detail','ARRAY');mod.count=2;mod.relative_offset_displace=(1,0,0)
hidden_root=asset_root('asset-hidden');hidden=cube('asset-hidden-part',(1,1,1));hidden.name='imported-hidden';hidden.parent=hidden_root;hidden.hide_viewport=True
foreign_root=asset_root('asset-foreign');foreign=cube('foreign-owner',(1,1,1));foreign.parent=foreign_root
for id,owner,part_marker in [('asset-owned','asset-owned',True),('asset-owned-foreign','another-entity',True),('asset-owned-unmarked','asset-owned-unmarked',False)]:
    owned=asset_root(id);owned['deepblend_id']=id;owned['deepblend_kind']='entity'
    part=cube(id+'_part',(.1,.2,.3),(2,0,0));part.parent=owned
    part['deepblend_id']=owner;part['deepblend_kind']='entity'
    if part_marker:part['deepblend_part_id']='/reused-mesh'
asset_root('asset-empty')
budget_root=asset_root('asset-budget')
for i in range(129):
    part=bpy.data.objects.new('imported-budget-'+str(i),first.data);bpy.context.collection.objects.link(part);part.parent=budget_root
bpy.context.view_layer.update()
# Native perspective, camera shift, portrait aspect and actual animated path.
small=cube('framing-small',(1,1,1),(0,0,-5))
cube('framing-crossing',(1,1,20),(0,0,-5))
cube('framing-far',(1,1,1),(0,0,-200))
render_hidden=cube('framing-hidden',(1,1,1),(0,0,-5));render_hidden.hide_render=True
cam_data=bpy.data.cameras.new('framing-camera-data');cam_data.lens=35;cam_data.shift_x=.1;cam_data.shift_y=-.05;cam_data.clip_start=.1;cam_data.clip_end=100
camera=bpy.data.objects.new('db_camera__framing',cam_data);bpy.context.collection.objects.link(camera);camera.scale=(1.4,.7,2.2)
camera.location=(0,0,0);camera.keyframe_insert(data_path='location',frame=1)
camera.location=(10,0,0);camera.keyframe_insert(data_path='location',frame=24)
bpy.context.scene.render.resolution_x=900;bpy.context.scene.render.resolution_y=1600
bpy.context.scene.render.pixel_aspect_x=1.1;bpy.context.scene.render.pixel_aspect_y=1
from bpy_extras.object_utils import world_to_camera_view
expected={}
for frame in (1,24):
    bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
    points=[world_to_camera_view(bpy.context.scene,camera,small.matrix_world@v.co) for v in small.data.vertices]
    expected[str(frame)]={'min':[min(p[a] for p in points) for a in range(2)],'max':[max(p[a] for p in points) for a in range(2)]}
(output/'framing-expected.json').write_text(json.dumps(expected))
bpy.context.scene.frame_set(24);bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(output/'fixture.blend'))
(output/'queries.json').write_text(json.dumps(groups,indent=2)+'\n')

# Manual render regions/stereo are preserved; a full-camera projection is not
# evidence about a cropped/black-masked or per-eye rendered image.
scene=bpy.context.scene
for suffix,border,crop,multiview in [('border-masked',True,False,False),('border-cropped',True,True,False),('multiview',False,False,True)]:
    scene.render.use_border=border;scene.render.use_crop_to_border=crop;scene.render.use_multiview=multiview
    scene.render.border_min_x=.8;scene.render.border_max_x=1
    scene.render.border_min_y=.8;scene.render.border_max_y=1
    bpy.ops.wm.save_as_mainfile(filepath=str(output/('framing-'+suffix+'.blend')))
