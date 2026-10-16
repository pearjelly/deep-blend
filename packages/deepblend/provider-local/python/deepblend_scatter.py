"""Bounded, deterministic placement of a prototype on static closed meshes.

This is a runtime modeling primitive, not a case/recipe script. Only structured
SceneSpec data enters it. Every emitted attachment vertex is checked against
the actual target solid before the new mesh replaces the prototype.
"""
import bisect
import json
import math
import random
from array import array

import bmesh
import bpy
from mathutils import Quaternion, Vector
from mathutils.bvhtree import BVHTree

from deepblend_util import ActionError

MAX_POLYGONS = 500_000
MAX_VERTICES = 1_000_000
MAX_LOOPS = 2_000_000
MAX_TARGET_POLYGONS = 131_072
MAX_TARGET_TRIANGLES = 262_144
RAY_DIRECTIONS = tuple(Vector(value).normalized() for value in
                       ((1, .173, .287), (.219, 1, .131), (.157, .271, 1)))


def _refuse(message):
    raise ActionError('SCENE_SPEC_INVALID', 'surface_scatter: ' + message)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _inside(target, point):
    """Three independent parity rays; ambiguous/excessive crossings are refused."""
    votes = 0
    for direction in RAY_DIRECTIONS:
        origin, hits = point.copy(), 0
        for _ in range(256):
            location, _, _, _ = target['bvh'].ray_cast(origin, direction, target['ray_length'])
            if location is None:
                break
            hits += 1
            origin = location + direction * target['epsilon'] * 4
        else:
            return False
        votes += hits % 2
    return votes >= 2


def _target(entity_id, obj):
    mesh = obj.data
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        if not bm.faces or any(not edge.is_manifold for edge in bm.edges) or abs(bm.calc_volume(signed=True)) <= 1e-18:
            _refuse('target "%s" needs a closed, non-degenerate solid mesh' % entity_id)
    finally:
        bm.free()
    points = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    if any(not all(math.isfinite(value) for value in point) for point in points):
        _refuse('target has non-finite world coordinates')
    mesh.calc_loop_triangles()
    triangles = [tuple(triangle.vertices) for triangle in mesh.loop_triangles]
    diagonal = math.sqrt(sum((max(point[axis] for point in points) - min(point[axis] for point in points)) ** 2 for axis in range(3)))
    epsilon = max(1e-6, max(abs(value) for point in points for value in point) * 4e-7, diagonal * 1e-7)
    return {'id': entity_id, 'points': points, 'triangles': triangles,
            'bvh': BVHTree.FromPolygons(points, triangles, all_triangles=True),
            'epsilon': epsilon, 'ray_length': max(1.0, diagonal * 4)}


def apply_surface_scatter(obj, targets, entry):
    count = entry.get('count')
    seed = entry.get('seed', 0)
    anchors = entry.get('anchorVertexIndices')
    scales = entry.get('scaleRange', [1.0, 1.0])
    depth_mm = entry.get('embedDepthMm', 5.0)
    bias = entry.get('upwardBias', 0.0)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 512:
        _refuse('count must be an integer from 1 to 512')
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2_147_483_647:
        _refuse('seed must be an integer from 0 to 2147483647')
    if not isinstance(targets, list) or not 1 <= len(targets) <= 8 or len({key for key, _ in targets}) != len(targets):
        _refuse('select 1 to 8 distinct static target meshes')
    if not isinstance(anchors, list) or not 1 <= len(anchors) <= 8 or any(
            isinstance(index, bool) or not isinstance(index, int) or index < 0 for index in anchors) or len(set(anchors)) != len(anchors):
        _refuse('anchorVertexIndices needs 1 to 8 distinct evaluated prototype vertex indices')
    if not isinstance(scales, list) or len(scales) != 2 or any(not _finite(value) for value in scales) or not .05 <= scales[0] <= scales[1] <= 20:
        _refuse('scaleRange must be an ordered positive range within 0.05 to 20')
    if not _finite(depth_mm) or not 0 < depth_mm <= 100 or not _finite(bias) or not 0 <= bias <= 1:
        _refuse('embedDepthMm must be within (0,100] and upwardBias within [0,1]')
    source = obj.data
    if not source.polygons or len(source.polygons) * count > MAX_POLYGONS or len(source.vertices) * count > MAX_VERTICES or len(source.loops) * count > MAX_LOOPS:
        _refuse('prototype times count exceeds the vertex, polygon or UV-corner budget before allocation')
    if any(index >= len(source.vertices) for index in anchors):
        _refuse('attachment index exceeds the evaluated prototype vertex count')
    used = {index for polygon in source.polygons for index in polygon.vertices}
    if any(index not in used for index in anchors):
        _refuse('attachment vertices must belong to actual prototype faces')
    if sum(len(target.data.polygons) for _, target in targets) > MAX_TARGET_POLYGONS:
        _refuse('targets exceed the 131072-polygon surface budget')
    if sum(max(0, len(polygon.vertices) - 2) for _, target in targets for polygon in target.data.polygons) > MAX_TARGET_TRIANGLES:
        _refuse('targets exceed the 262144-triangle surface budget before triangulation')
    target_records = [_target(key, target) for key, target in targets]
    if sum(len(target['triangles']) for target in target_records) > MAX_TARGET_TRIANGLES:
        _refuse('targets exceed the 262144-triangle surface budget')
    weighted, areas, total = [], [], 0.0
    for target in target_records:
        for triangle in target['triangles']:
            a, b, c = (target['points'][index] for index in triangle)
            normal = (b - a).cross(c - a)
            area = normal.length * .5
            if area <= 1e-14:
                continue
            normal.normalize()
            total += area
            weighted.append((target, a, b, c, normal))
            areas.append(total)
    if not weighted or not math.isfinite(total):
        _refuse('targets have no measurable triangle surface')
    prototype = [vertex.co.copy() for vertex in source.vertices]
    if any(not all(math.isfinite(value) for value in point) for point in prototype):
        _refuse('prototype has non-finite coordinates')
    anchor = sum((prototype[index] for index in anchors), Vector()) / len(anchors)
    relative = [point - anchor for point in prototype]
    faces = [tuple(polygon.vertices) for polygon in source.polygons]
    smooth = [polygon.use_smooth for polygon in source.polygons]
    material_indices = [polygon.material_index for polygon in source.polygons]
    materials = list(source.materials)
    uv_maps = [(layer.name, [(item.uv.x, item.uv.y) for item in layer.data]) for layer in source.uv_layers]
    matrix = obj.matrix_world.copy()
    try:
        inverse = matrix.inverted()
    except ValueError:
        _refuse('prototype transform is singular')
    linear = matrix.to_3x3()
    axis = linear @ Vector((0, 0, 1))
    if axis.length <= 1e-12:
        _refuse('prototype Z axis is degenerate')
    axis.normalize()
    rng = random.Random(seed)
    vertices, output_faces, placements = [], [], []
    for _ in range(count * 16):
        if len(placements) == count:
            break
        target, a, b, c, face_normal = weighted[min(len(weighted) - 1, bisect.bisect_right(areas, rng.random() * total))]
        u, v = math.sqrt(rng.random()), rng.random()
        surface = a * (1 - u) + b * (u * (1 - v)) + c * (u * v)
        normal = face_normal.copy()
        epsilon = target['epsilon']
        if not _inside(target, surface - normal * epsilon):
            if not _inside(target, surface + normal * epsilon):
                continue
            normal.negate()
        _, _, _, chord = target['bvh'].ray_cast(surface - normal * epsilon, -normal, target['ray_length'])
        if chord is None or not math.isfinite(chord):
            continue
        depth = min(depth_mm / 1000, (chord + epsilon) * .25)
        if depth < epsilon * 8:
            continue
        point = surface - normal * depth
        direction = normal * (1 - bias) + Vector((0, 0, 1)) * bias
        if direction.length <= 1e-10:
            direction = Vector((0, 0, 1))
        direction.normalize()
        scale = rng.uniform(*scales)
        rotation = Quaternion(direction, rng.random() * math.tau).to_matrix() @ axis.rotation_difference(direction).to_matrix()
        transform = rotation @ linear * scale
        # Check the actual float32 round trip that will be stored in the mesh,
        # not only an ideal surface point or the object's declared origin.
        attachment = [matrix @ (inverse @ (point + transform @ relative[index])) for index in anchors]
        distances = [target['bvh'].find_nearest(value)[3] for value in attachment]
        if any(distance is None or distance < epsilon * 4 for distance in distances) or any(not _inside(target, value) for value in attachment):
            continue
        offset = len(vertices)
        emitted = [inverse @ (point + transform @ value) for value in relative]
        if any(not all(math.isfinite(value) for value in point) for point in emitted):
            _refuse('placement produced non-finite coordinates')
        vertices.extend(emitted)
        output_faces.extend(tuple(index + offset for index in face) for face in faces)
        placements.append({'index': len(placements), 'targetEntityId': target['id'],
                           'anchorWorldMeters': list(point), 'embedDepthMm': depth * 1000, 'scale': scale})
    if len(placements) != count:
        _refuse('could place only %d/%d instances with all selected attachment vertices inside the actual targets; choose fitting anchors, scale or targets' % (len(placements), count))
    mesh = bpy.data.meshes.new(source.name + '_surface_scatter')
    try:
        mesh.from_pydata(vertices, [], output_faces)
        mesh.update()
        if mesh.validate(verbose=False, clean_customdata=False):
            _refuse('emitted geometry required a native repair')
        for material in materials:
            mesh.materials.append(material)
        for index, polygon in enumerate(mesh.polygons):
            prototype_index = index % len(faces)
            polygon.use_smooth = smooth[prototype_index]
            polygon.material_index = material_indices[prototype_index]
        for name, coordinates in uv_maps:
            layer = mesh.uv_layers.new(name=name)
            layer.data.foreach_set('uv', array('f', (coordinate for _ in range(count) for uv in coordinates for coordinate in uv)))
        obj.data = mesh
        obj['deepblend_surface_scatter'] = json.dumps({'schemaVersion': 'deepblend.surface-scatter/v1',
            'mode': 'static-closed-surface', 'count': count, 'seed': seed,
            'prototypeVertexCount': len(prototype), 'prototypePolygonCount': len(faces),
            'anchorVertexIndices': anchors, 'targetEntityIds': [key for key, _ in targets], 'placements': placements}, allow_nan=False)
    except Exception:
        if mesh.users == 0:
            bpy.data.meshes.remove(mesh)
        raise
    if source.users == 0:
        bpy.data.meshes.remove(source)
