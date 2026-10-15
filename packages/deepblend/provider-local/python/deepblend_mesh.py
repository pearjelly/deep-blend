"""Bounded indexed control geometry. Inputs are data, never executable text."""
import math

import bpy
from deepblend_util import ActionError


def create_mesh(name, spec):
    vertices, faces = spec.get('vertices'), spec.get('faces')

    def invalid(message):
        raise ActionError('SCENE_SPEC_INVALID', 'mesh: ' + message)

    def number(value):
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)

    if not isinstance(vertices, list) or not 3 <= len(vertices) <= 32768:
        invalid('requires 3 to 32768 local-space vertices')
    if any(not isinstance(point, list) or len(point) != 3 or
           any(not number(value) or abs(value) > 1e6 for value in point) for point in vertices):
        invalid('vertices need finite bounded local coordinates')
    if not isinstance(faces, list) or not 1 <= len(faces) <= 32768:
        invalid('requires 1 to 32768 indexed faces')
    if any(not isinstance(face, list) or not 3 <= len(face) <= 32 for face in faces):
        invalid('faces need 3 to 32 corners')
    if sum(len(face) for face in faces) > 131072:
        invalid('exceeds the 131072 face-corner budget')
    seen = set()
    for face in faces:
        if any(isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(vertices) for index in face):
            invalid('face index outside vertices')
        key = frozenset(face)
        if len(key) != len(face) or key in seen:
            invalid('repeated face or face vertex')
        seen.add(key)
        origin = vertices[face[0]]
        points = [[value - origin[axis] for axis, value in enumerate(vertices[index])] for index in face]
        normal = [0.0, 0.0, 0.0]
        for a, b in zip(points[1:-1], points[2:]):
            normal[0] += a[1] * b[2] - a[2] * b[1]
            normal[1] += a[2] * b[0] - a[0] * b[2]
            normal[2] += a[0] * b[1] - a[1] * b[0]
        scale_squared = max(sum(value * value for value in point) for point in points)
        if math.hypot(*normal) <= scale_squared * 1e-12:
            invalid('zero or unstable face area')
    face_uvs = spec.get('faceUvs')
    if face_uvs is not None and (not isinstance(face_uvs, list) or len(face_uvs) != len(faces) or
            any(not isinstance(corners, list) or len(corners) != len(face) or
                any(not isinstance(uv, list) or len(uv) != 2 or any(not number(v) for v in uv) for uv in corners)
                for face, corners in zip(faces, face_uvs))):
        invalid('faceUvs need one finite UV pair per face corner')
    if 'smooth' in spec and not isinstance(spec['smooth'], bool):
        invalid('smooth must be boolean')

    mesh = bpy.data.meshes.new(name + '_mesh')
    try:
        mesh.from_pydata(vertices, [], faces)
        mesh.update(calc_edges=True)
        if mesh.validate(verbose=False, clean_customdata=False):
            invalid('Blender refused the authored topology')
        uv_layer = mesh.uv_layers.new(name='UVMap')
        low = [min(point[axis] for point in vertices) for axis in range(3)]
        extent = [max(point[axis] for point in vertices) - low[axis] for axis in range(3)]
        axes = sorted(range(3), key=lambda axis: (-extent[axis], axis))[:2]
        for index, polygon in enumerate(mesh.polygons):
            polygon.use_smooth = spec.get('smooth', False)
            for corner, loop in enumerate(polygon.loop_indices):
                coordinate = face_uvs[index][corner] if face_uvs is not None else [
                    (vertices[mesh.loops[loop].vertex_index][axis] - low[axis]) / (extent[axis] or 1) for axis in axes]
                uv_layer.data[loop].uv = coordinate
    except Exception:
        bpy.data.meshes.remove(mesh)
        raise
    for selected in bpy.context.selected_objects:
        selected.select_set(False)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    return obj
