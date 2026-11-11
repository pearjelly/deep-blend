"""Cut complementary recesses in the compiled rectangular timber groups."""
from collections import defaultdict
from dataclasses import dataclass
from itertools import product
from math import hypot, prod

import bmesh
import bpy

from deepblend_util import ActionError


_MAX_BEAMS = 256
_MAX_FACES = 500_000
# Outward winding for the six faces of a rectangular cell.
_SIDES = (
    (0, 0, ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0))),
    (0, 1, ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1))),
    (1, 0, ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1))),
    (1, 1, ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0))),
    (2, 0, ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0))),
    (2, 1, ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1))),
)


def _invalid(message):
    raise ActionError('SCENE_SPEC_INVALID', 'half lap: ' + message)


@dataclass(frozen=True)
class _Box:
    low: tuple
    high: tuple

    def overlap(self, other):
        low = tuple(max(a, b) for a, b in zip(self.low, other.low))
        high = tuple(min(a, b) for a, b in zip(self.high, other.high))
        return _Box(low, high) if all(a < b for a, b in zip(low, high)) else None

    def length(self, axis):
        return self.high[axis] - self.low[axis]


@dataclass
class _Beam:
    box: _Box
    points: dict
    faces: dict
    length_axis: int


def _snap(values, tolerance):
    """Weld equivalent planes within the precision of the compiled mesh."""
    snapped = {}
    group = []
    for value in sorted(set(values)):
        if group and value - group[0] > tolerance:
            plane = sum(group) / len(group)
            snapped.update((x, plane) for x in group)
            group.clear()
        group.append(value)
    if group:
        plane = sum(group) / len(group)
        snapped.update((x, plane) for x in group)
    return snapped


def _beams(obj, points, tolerance):
    mesh = obj.data
    if len(mesh.vertices) > 8 * _MAX_BEAMS:
        _invalid(f'"{obj.name}" exceeds {_MAX_BEAMS} timber components')
    connections = defaultdict(list)
    for edge in mesh.edges:
        a, b = edge.vertices
        connections[a].append(b)
        connections[b].append(a)
    remaining = set(range(len(points)))
    owner = {}
    components = []
    while remaining:
        first = min(remaining)
        remaining.remove(first)
        component = [first]
        for vertex in component:
            owner[vertex] = len(components)
            for neighbor in connections[vertex]:
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    component.append(neighbor)
        components.append(component)
    faces = [[] for _ in components]
    for polygon in mesh.polygons:
        faces[owner[polygon.vertices[0]]].append(polygon)

    beams = []
    for indices, polygons in zip(components, faces):
        corners = {i: points[i] for i in indices}
        axes = tuple(sorted({p[axis] for p in corners.values()}) for axis in range(3))
        if len(indices) != 8 or len(polygons) != 6 or any(len(axis) != 2 for axis in axes):
            _invalid(f'"{obj.name}" needs closed, aligned rectangular timber components')
        if set(corners.values()) != set(product(*axes)):
            _invalid(f'"{obj.name}" has a component without all eight box corners')
        box = _Box(tuple(axis[0] for axis in axes), tuple(axis[1] for axis in axes))
        if min(box.length(axis) for axis in range(3)) <= tolerance:
            _invalid('a timber component is too thin for the compiled coordinate precision')
        if abs(box.length(0) - box.length(1)) <= tolerance:
            _invalid(f'"{obj.name}" needs a distinguishable timber length in its joint plane')
        planes = {}
        for polygon in polygons:
            vertices = [corners[i] for i in polygon.vertices]
            side = [(axis, int(vertices[0][axis] == box.high[axis])) for axis in range(3)
                    if all(p[axis] == vertices[0][axis] for p in vertices)]
            if len(vertices) != 4 or len(side) != 1 or side[0] in planes:
                _invalid(f'"{obj.name}" needs exactly one quad on each box face')
            axis, direction = side[0]
            a, b = (axis + 1) % 3, (axis + 2) % 3
            polygon_points = [(p[a] - vertices[0][a], p[b] - vertices[0][b]) for p in vertices]
            area = sum(x * v - y * u for (x, y), (u, v) in zip(polygon_points, polygon_points[1:] + polygon_points[:1]))
            if (area > 0) != bool(direction) or abs(area) < box.length(a) * box.length(b):
                _invalid(f'"{obj.name}" has a folded or inward timber face')
            planes[side[0]] = polygon
        beams.append(_Beam(box, corners, planes, int(box.length(1) > box.length(0))))
    if not beams or len({beam.length_axis for beam in beams}) != 1:
        _invalid(f'"{obj.name}" needs parallel timber components')
    for i, beam in enumerate(beams):
        if any(beam.box.overlap(other.box) for other in beams[:i]):
            _invalid(f'"{obj.name}" has overlapping timbers within its own group')
    return beams


def _cuts(lower, upper, tolerance):
    if lower[0].length_axis == upper[0].length_axis:
        _invalid('the two timber groups must cross at right angles')
    recesses = ([[] for _ in lower], [[] for _ in upper])
    for i, a in enumerate(lower):
        for j, b in enumerate(upper):
            shared = a.box.overlap(b.box)
            if shared is None:
                continue
            if a.box.low[2] != b.box.low[2] or a.box.high[2] != b.box.high[2]:
                _invalid('crossing timbers must have matching top and bottom heights')
            if min(shared.length(axis) for axis in range(3)) <= tolerance:
                _invalid('a crossing is too small for the compiled coordinate precision')
            middle = (shared.low[2] + shared.high[2]) / 2
            recesses[0][i].append(_Box((*shared.low[:2], middle), shared.high))
            recesses[1][j].append(_Box(shared.low, (*shared.high[:2], middle)))
    if not any(recesses[0]):
        _invalid('the timber groups have no crossings; adjust their position or remove the joint')
    return recesses


def _face_uv(mesh, beam, side):
    polygon = beam.faces[side]
    uv_layer = mesh.uv_layers.active
    a, b = (side[0] + 1) % 3, (side[0] + 2) % 3
    uv = {}
    for loop in polygon.loop_indices:
        vertex = beam.points[mesh.loops[loop].vertex_index]
        uv[vertex[a] == beam.box.high[a], vertex[b] == beam.box.high[b]] = tuple(uv_layer.data[loop].uv)
    origin, u, v, corner = uv[False, False], uv[True, False], uv[False, True], uv[True, True]
    predicted = tuple(x + y - z for x, y, z in zip(u, v, origin))
    if hypot(*(x - y for x, y in zip(predicted, corner))) > 2e-6 * max(1., hypot(*corner), hypot(*predicted)):
        _invalid('a cut timber face has non-affine UVs; project planar face UVs before applying the joint')

    def map_point(point):
        x = (point[a] - beam.box.low[a]) / beam.box.length(a)
        y = (point[b] - beam.box.low[b]) / beam.box.length(b)
        return tuple(o + x * (s - o) + y * (t - o) for o, s, t in zip(origin, u, v))

    return map_point


def _notched_faces(axes, cuts):
    indices = [{plane: i for i, plane in enumerate(axis)} for axis in axes]
    occupied = set(product(*(range(len(axis) - 1) for axis in axes)))
    for cut in cuts:
        occupied.difference_update(product(*(range(index[low], index[high])
                                           for index, low, high in zip(indices, cut.low, cut.high))))
    for cell in sorted(occupied):
        for axis, direction, corners in _SIDES:
            neighbor = list(cell)
            neighbor[axis] += 1 if direction else -1
            if tuple(neighbor) in occupied:
                continue
            face = [tuple(planes[i + offset] for planes, i, offset in zip(axes, cell, corner))
                    for corner in corners]
            yield (axis, direction), face


def _build_mesh(obj, beams, cuts, to_local):
    old = obj.data
    uv_layer = old.uv_layers.active
    if uv_layer is None:
        _invalid(f'"{obj.name}" needs its compiled timber UV layer')
    points, faces, attributes = [], [], []
    remaining_cells = _MAX_FACES
    for beam, recesses in zip(beams, cuts):
        vertex_indices = {}
        if not recesses:
            for old_index in sorted(beam.points):
                vertex_indices[old_index] = len(points)
                points.append(tuple(old.vertices[old_index].co))
            for polygon in sorted(beam.faces.values(), key=lambda face: face.index):
                faces.append([vertex_indices[i] for i in polygon.vertices])
                attributes.append((polygon, [tuple(uv_layer.data[i].uv) for i in polygon.loop_indices]))
            continue
        mapping = {side: _face_uv(old, beam, side) for side in beam.faces}
        axes = [sorted({beam.box.low[axis], beam.box.high[axis]} |
                       {bound[axis] for cut in recesses for bound in (cut.low, cut.high)}) for axis in range(3)]
        remaining_cells -= prod(len(axis) - 1 for axis in axes)
        if remaining_cells < 0:
            _invalid('the notches exceed the per-entity geometry budget')
        for side, corners in _notched_faces(axes, recesses):
            if len(faces) >= _MAX_FACES:
                _invalid('the notches exceed the per-entity polygon budget')
            face = []
            for point in corners:
                if point not in vertex_indices:
                    vertex_indices[point] = len(points)
                    points.append(tuple(to_local(point)))
                face.append(vertex_indices[point])
            faces.append(face)
            attributes.append((beam.faces[side], [mapping[side](point) for point in corners]))

    result = bpy.data.meshes.new(old.name + '_half_lap')
    try:
        result.from_pydata(points, [], faces)
        result.update(calc_edges=True)
        if result.validate(verbose=False, clean_customdata=False):
            _invalid('Blender rejected the notched mesh')
        checked = bmesh.new()
        try:
            checked.from_mesh(result)
            if any(not edge.is_manifold for edge in checked.edges) or any(face.calc_area() <= 0 for face in checked.faces):
                _invalid('a notch produced a degenerate or open timber')
            if len(checked.verts) - len(checked.edges) + len(checked.faces) != 2 * len(beams):
                _invalid('a notch changed the timber component topology')
            if checked.calc_volume(signed=True) <= 0:
                _invalid('the notched group has no positive volume')
        finally:
            checked.free()
        for material in old.materials:
            result.materials.append(material)
        uv = result.uv_layers.new(name=uv_layer.name)
        for polygon, (source, coords) in zip(result.polygons, attributes):
            polygon.material_index = source.material_index
            polygon.use_smooth = source.use_smooth
            for loop, coord in zip(polygon.loop_indices, coords):
                uv.data[loop].uv = coord
    except Exception:
        bpy.data.meshes.remove(result)
        raise
    return result


def apply_half_lap(lower, upper):
    """Apply both sides after their array/mirror stacks, before dependent modifiers."""
    from mathutils import Vector

    frame = lower.matrix_world.to_quaternion().to_matrix().to_4x4()
    frame.translation = lower.matrix_world.translation
    from_world = frame.inverted()
    objects = (lower, upper)
    matrices = [from_world @ obj.matrix_world for obj in objects]
    # The common plane follows the first group. Positive, non-degenerate object
    # scales are allowed, but arbitrary skew between groups is not.
    for matrix in matrices:
        basis = matrix.to_3x3()
        columns = [column.normalized() for column in basis.col]
        aligned = all(max(abs(x) for x in column) >= 1 - 1e-6 and
                      sum(abs(x) > 1e-5 for x in column) == 1 for column in columns)
        if basis.determinant() <= 0 or not aligned or abs(columns[2].z - 1) > 1e-6:
            _invalid('timbers need one shared joint plane and right-angle alignment')
    coords = [[tuple(matrix @ vertex.co) for vertex in obj.data.vertices]
              for obj, matrix in zip(objects, matrices)]
    scale = max((abs(value) for group in coords for point in group for value in point), default=0.)
    tolerance = max(1e-7, scale * 8 * 2 ** -23)
    planes = [_snap((p[axis] for group in coords for p in group), tolerance) for axis in range(3)]
    measured = [_beams(obj, [tuple(index[value] for index, value in zip(planes, point)) for point in group],
                       tolerance) for obj, group in zip(objects, coords)]
    recesses = _cuts(*measured, tolerance)
    staged = []
    try:
        for obj, beams, cuts, matrix in zip(objects, measured, recesses, matrices):
            inverse = matrix.inverted()
            staged.append(_build_mesh(obj, beams, cuts, lambda p: inverse @ Vector(p)))
    except Exception:
        for mesh in staged:
            bpy.data.meshes.remove(mesh)
        raise
    for obj, mesh in zip(objects, staged):
        old = obj.data
        obj.data = mesh
        if old.users == 0:
            bpy.data.meshes.remove(old)
