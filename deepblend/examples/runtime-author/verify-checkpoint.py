"""Independent saved-fixture check and CPU reference render; no DeepBlend imports."""
import bpy, bmesh, json, math, sys
from pathlib import Path
from bpy_extras.object_utils import world_to_camera_view

checkpoint, output, reference = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.open_mainfile(filepath=checkpoint)
scene = bpy.context.scene
body = next(obj for obj in scene.objects if obj.get('deepblend_id') == 'body')
camera = next(obj for obj in scene.objects if obj.get('deepblend_id') == 'hero')
assert body.type == 'MESH' and camera.type == 'CAMERA'
assert all(math.isfinite(c) for v in body.data.vertices for c in v.co)
mesh = bmesh.new()
mesh.from_mesh(body.data)
volume = mesh.calc_volume(signed=True)
assert all(edge.is_manifold for edge in mesh.edges)
assert volume > 0 and abs(volume - 16 * math.sin(2 * math.pi / 32) * .05**2 * .1) < 1e-9
mesh.free()
assert len(body.data.uv_layers) > 0
assert all(math.isfinite(c) for layer in body.data.uv_layers for uv in layer.data for c in uv.uv)
node = next(n for n in body.active_material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
assert max(abs(a-b) for a,b in zip(node.inputs['Base Color'].default_value, [.18,.3,.265,1])) < 1e-6
assert abs(node.inputs['Roughness'].default_value - .25) < 1e-6
assert scene.view_settings.view_transform == 'AgX'
assert abs(scene.view_settings.exposure - .25) < 1e-6
poses = []
for frame, x in [(1,0), (2,.05), (3,.1)]:
    scene.frame_set(frame)
    assert abs(body.matrix_world.translation.x-x) < 1e-6
    assert max(abs(a-b) for a,b in zip(body.dimensions, [.1,.1,.1])) < 1e-6
    poses.append({'frame':frame, 'location':list(body.matrix_world.translation),
                  'cameraMatrix':[[float(c) for c in row] for row in camera.matrix_world]})
scene.frame_set(1)
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 8
scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 160,120,100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = reference
projected = [world_to_camera_view(scene,camera,body.matrix_world @ __import__('mathutils').Vector(v)) for v in body.bound_box]
roi = [max(0,int(min(v.x for v in projected)*160)),max(0,int((1-max(v.y for v in projected))*120)),
       min(160,math.ceil(max(v.x for v in projected)*160)),min(120,math.ceil((1-min(v.y for v in projected))*120))]
assert roi[2]>roi[0] and roi[3]>roi[1]
bpy.ops.render.render(write_still=True)
Path(output).write_text(json.dumps({'blenderVersion':bpy.app.version_string,'buildHash':bpy.app.build_hash.decode(),
  'polygons':sum(len(obj.data.polygons) for obj in scene.objects if obj.type=='MESH'),
  'bodyPolygons':len(body.data.polygons),'volume':volume,'poses':poses,'roi':roi,'reference':reference}))
