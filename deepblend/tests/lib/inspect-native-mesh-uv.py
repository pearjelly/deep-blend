"""Independent saved-file comparison. UV quality here means finite nonzero
triangle area only; it says nothing about overlap, seams or visual approval.
"""
import bpy
import hashlib
import json
import math
import sys

before_path, after_path, output_path = sys.argv[sys.argv.index('--') + 1:]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def inspect(path):
    bpy.ops.wm.open_mainfile(filepath=path)
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    geometry, objects, maps = {}, {}, {}
    for obj in bpy.context.scene.objects:
        key = obj.get('deepblend_id') or obj.name
        objects[key] = {'type': obj.type, 'matrix': [list(row) for row in obj.matrix_world],
                        'materials': [slot.material.name if slot.material else None for slot in obj.material_slots]}
        if obj.type == 'CAMERA':
            objects[key]['camera'] = [obj.data.lens, obj.data.sensor_width, obj.data.clip_start, obj.data.clip_end]
        if obj.type == 'LIGHT':
            objects[key]['light'] = [obj.data.type, obj.data.energy, list(obj.data.color)]
        if obj.type != 'MESH':
            continue
        mesh = obj.data
        geometry[key] = {'vertices': [list(vertex.co) for vertex in mesh.vertices],
                         'faces': [list(face.vertices) for face in mesh.polygons],
                         'normals': [list(face.normal) for face in mesh.polygons]}
        mesh.calc_loop_triangles()
        layers = []
        for layer in mesh.uv_layers:
            coordinates = [list(loop.uv) for loop in layer.data]
            areas = []
            for triangle in mesh.loop_triangles:
                a, b, c = [coordinates[index] for index in triangle.loops]
                areas.append(abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])) * .5)
            layers.append({'name': layer.name, 'finite': all(math.isfinite(value) for pair in coordinates for value in pair),
                           'triangleCount': len(areas), 'zeroAreaTriangleCount': sum(area == 0 for area in areas),
                           'minimumTriangleArea': min(areas, default=None), 'uvDigest': digest(coordinates)})
        maps[key] = layers
    return {'geometryDigest': digest(geometry), 'objectsDigest': digest(objects), 'uvMaps': maps,
            'targetVertices': len(geometry['beam']['vertices']), 'targetFaces': len(geometry['beam']['faces'])}


before, after = inspect(before_path), inspect(after_path)
json.dump({'before': before, 'after': after}, open(output_path, 'w'), indent=2)
assert before['geometryDigest'] == after['geometryDigest'], 'UV edit changed native geometry or normals'
assert before['objectsDigest'] == after['objectsDigest'], 'UV edit changed native objects, matrices, material slots, lights or cameras'
assert before['uvMaps']['beam'][0]['zeroAreaTriangleCount'] == 48
assert after['uvMaps']['beam'][0]['zeroAreaTriangleCount'] == 0
assert after['uvMaps']['beam'][0]['finite']
assert before['targetVertices'] == after['targetVertices'] == 48
assert before['targetFaces'] == after['targetFaces'] == 36
