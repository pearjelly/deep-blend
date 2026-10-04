"""Read geometry and motion from a compiled benchmark checkpoint; never change it."""
import json
import hashlib
import sys
from pathlib import Path
import bpy
import bmesh

arguments = sys.argv[sys.argv.index('--') + 1:]
checkpoint, output = map(Path, arguments)
bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
scene = bpy.context.scene
scene.frame_set(1)
bpy.context.view_layer.update()
objects = []
for obj in bpy.data.objects:
    if obj.type != 'MESH':
        continue
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    data = evaluated.to_mesh()
    mesh = bmesh.new()
    try:
        mesh.from_mesh(data)
        mesh.transform(obj.matrix_world)
        mesh.normal_update()
        coordinates = [vertex.co for vertex in mesh.verts]
        lower = [min(co[axis] for co in coordinates) for axis in range(3)] if coordinates else [0, 0, 0]
        upper = [max(co[axis] for co in coordinates) for axis in range(3)] if coordinates else [0, 0, 0]
        objects.append({
            'entityId': obj.get('deepblend_id'), 'name': obj.name,
            'visible': not (obj.hide_viewport or obj.hide_render),
            'vertices': len(mesh.verts), 'polygons': len(mesh.faces),
            'boundaryEdges': sum(edge.is_boundary for edge in mesh.edges),
            'nonManifoldEdges': sum(not edge.is_manifold for edge in mesh.edges),
            'signedVolume': mesh.calc_volume(signed=True),
            'worldBounds': {'min': lower, 'max': upper},
            'dimensions': [upper[axis] - lower[axis] for axis in range(3)],
            'uvLayers': [layer.name for layer in data.uv_layers],
            'materialNames': [slot.material.name if slot.material else None for slot in obj.material_slots],
        })
    finally:
        mesh.free()
        evaluated.to_mesh_clear()
poses = []
for frame in range(scene.frame_start, scene.frame_end + 1):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    poses.append({'frame': frame, 'objects': [{
        'id': obj.get('deepblend_id'), 'type': obj.type,
        'matrixWorld': [list(row) for row in obj.matrix_world],
    } for obj in bpy.data.objects if obj.get('deepblend_id')]})
report = {'checkpointSha256': hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
          'inspectorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'checkpointRenderConfig': {'engine': scene.render.engine,
              'resolution': [round(scene.render.resolution_x * scene.render.resolution_percentage / 100), round(scene.render.resolution_y * scene.render.resolution_percentage / 100)],
              'samples': scene.cycles.samples, 'viewTransform': scene.view_settings.view_transform,
              'exposure': scene.view_settings.exposure, 'gamma': scene.view_settings.gamma},
          'blenderVersion': bpy.app.version_string, 'blenderBuildHash': bpy.app.build_hash.decode(),
          'cyclesDevice': scene.cycles.device, 'objects': objects, 'poses': poses}
output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print('BENCHMARK_GEOMETRY_INSPECTED')
