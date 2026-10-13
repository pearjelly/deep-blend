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
bpy.ops.wm.save_as_mainfile(filepath=str(output/'fixture.blend'))
(output/'queries.json').write_text(json.dumps(groups,indent=2)+'\n')
