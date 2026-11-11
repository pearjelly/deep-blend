"""Create known static and briefly out-of-frame native scenes for the audit test."""
import bpy
import math
import json
import sys
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

destination = Path(sys.argv[sys.argv.index('--') + 1])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 5
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
cube.name = 'db_entity__product'
data = bpy.data.cameras.new('fixture-camera')
camera = bpy.data.objects.new('db_camera__hero', data)
scene.collection.objects.link(camera)
camera['deepblend_id'] = 'hero'
camera.location = (0, 0, 5)
scene.camera = camera
data.lens = 50
scene.render.resolution_x = scene.render.resolution_y = 64
bpy.ops.wm.save_as_mainfile(filepath=str(destination / 'in-frame.blend'))
original_mesh = cube.data
triangle = bpy.data.meshes.new('loose-bounds')
triangle.from_pydata([(0, -1.4, 0), (0, 1.4, 0), (1.4, 0, 0)], [], [(0, 1, 2)])
triangle.update()
cube.data = triangle
cube.rotation_euler.z = math.pi / 4
bpy.context.view_layer.update()
def inside(point):
    projected = world_to_camera_view(scene, camera, cube.matrix_world @ Vector(point))
    return 0 <= projected.x <= 1 and 0 <= projected.y <= 1 and data.clip_start <= projected.z <= data.clip_end
(destination / 'loose-geometry.json').write_text(json.dumps({
    'boundsOutside': not all(inside(point) for point in cube.bound_box),
    'verticesInside': all(inside(vertex.co) for vertex in cube.data.vertices),
}))
bpy.ops.wm.save_as_mainfile(filepath=str(destination / 'loose-bounds.blend'))
cube.data = original_mesh
cube.rotation_euler.z = 0
for frame, x in [(1, 0), (2, 10), (3, 0), (5, 0)]:
    cube.location.x = x
    cube.keyframe_insert(data_path='location', index=0, frame=frame)
bpy.ops.wm.save_as_mainfile(filepath=str(destination / 'briefly-out.blend'))
