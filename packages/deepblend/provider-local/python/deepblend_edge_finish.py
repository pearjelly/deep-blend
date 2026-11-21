"""Finish only convex timber edges, in the joint's orthonormal world frame."""
import math

import bmesh
import bpy
from mathutils import Vector

from deepblend_util import ActionError


def _invalid(message):
    raise ActionError('SCENE_SPEC_INVALID', 'half-lap edge finish: ' + message)


def _planar_uv(face, density):
    normal = face.normal.normalized()
    candidates = []
    for edge in face.edges:
        delta = edge.verts[1].co - edge.verts[0].co
        tangent = delta - normal * delta.dot(normal)
        if tangent.length_squared > 0:
            u = tangent.normalized()
            axis = max(range(3), key=lambda a: (abs(u[a]), -a))
            if u[axis] < 0:
                u = -u
            candidates.append((tangent.length_squared, tuple(u)))
    if not candidates:
        _invalid('a new edge face has no stable UV direction')
    u = Vector(max(candidates)[1])
    v = normal.cross(u).normalized()
    origin = face.verts[0].co
    return [((loop.vert.co-origin).dot(u)*density, (loop.vert.co-origin).dot(v)*density) for loop in face.loops]


def _usable_uv(face, coordinates):
    if any(not math.isfinite(x) for uv in coordinates for x in uv):
        return False
    for i in range(1, len(coordinates)-1):
        a, b, c = [face.verts[j].co for j in (0, i, i+1)]
        if (b-a).cross(c-a).length_squared == 0:
            continue
        a, b, c = [coordinates[j] for j in (0, i, i+1)]
        if (b[0]-a[0])*(c[1]-a[1]) == (b[1]-a[1])*(c[0]-a[0]):
            return False
    return True


def finish_timber_mesh(mesh, matrix, beams, maps, width):
    """Return a staged mesh; the caller owns publication of both joint members.

    Existing face UVs remain on their faces. Each new face inherits the affine
    map and material of the dominant original box face. Legacy collapsed maps
    use a finite planar fallback on new faces only.
    """
    if isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or not 0 < width <= .005:
        _invalid('width must be finite and in (0, 0.005] metres')
    bm = bmesh.new()
    temporary = None
    output = mesh
    completed = False
    old_selected = list(bpy.context.selected_objects)
    old_active = bpy.context.view_layer.objects.active
    try:
        bm.from_mesh(mesh)
        bm.transform(matrix)
        bm.normal_update()
        selected = [edge for edge in bm.edges if edge.is_convex and edge.calc_face_angle() > math.radians(1)]
        if len(bm.faces) + len(selected)*9 > 500_000:
            _invalid('the finished mesh would exceed the 500000 polygon budget')
        extent = max(beam.box.length(a) for beam in beams for a in range(3))
        tolerance = max(1e-7, extent*8*2**-23)
        densities = []
        for beam, mapping in zip(beams, maps):
            values = []
            for (axis, side), project in mapping.items():
                a, b = (axis+1) % 3, (axis+2) % 3
                origin = list(beam.box.low)
                p, q = origin.copy(), origin.copy()
                p[a], q[b] = beam.box.high[a], beam.box.high[b]
                uv, u, v = project(origin), project(p), project(q)
                determinant = abs((u[0]-uv[0])*(v[1]-uv[1])-(u[1]-uv[1])*(v[0]-uv[0]))
                density = math.sqrt(determinant / (beam.box.length(a)*beam.box.length(b)))
                if math.isfinite(density) and density > 0:
                    values.append(density)
            densities.append(max(values, default=1/max(beam.box.length(a) for a in range(3))))
        result = bmesh.ops.bevel(bm, geom=selected, offset=width, offset_type='OFFSET', segments=3,
            profile=.5, affect='EDGES', clamp_overlap=True, material=-1, loop_slide=True,
            mark_seam=True, miter_inner='SHARP', miter_outer='SHARP')
        bm.normal_update()
        if not result['faces']:
            _invalid('width is below the precision of the compiled timber mesh')
        if len(bm.faces) > 500_000:
            _invalid('the finished mesh exceeds the polygon budget')
        layer = bm.loops.layers.uv.active
        if layer is None:
            _invalid('the timber needs its compiled UV layer')
        for face in result['faces']:
            center = face.calc_center_median()
            scores = [min(min(center[a]-beam.box.low[a], beam.box.high[a]-center[a]) for a in range(3))
                      for beam in beams]
            owner = max(range(len(scores)), key=lambda i: scores[i])
            if scores[owner] < -tolerance:
                _invalid('a new edge face escaped the original timber bounds')
            axis = max(range(3), key=lambda a: (abs(face.normal[a]), -a))
            side = (axis, int(face.normal[axis] > 0))
            coordinates = [maps[owner][side](tuple(loop.vert.co)) for loop in face.loops]
            if not _usable_uv(face, coordinates):
                coordinates = _planar_uv(face, densities[owner])
            if not _usable_uv(face, coordinates):
                _invalid('a new edge face has degenerate UV coordinates')
            for loop, uv in zip(face.loops, coordinates):
                loop[layer].uv = uv
            face.material_index = beams[owner].faces[side].material_index
        if any(not edge.is_manifold for edge in bm.edges) or any(face.calc_area() <= 0 for face in bm.faces):
            _invalid('finishing produced a degenerate or open timber')
        if len(bm.verts)-len(bm.edges)+len(bm.faces) != 2*len(beams) or bm.calc_volume(signed=True) <= 0:
            _invalid('finishing changed the timber component topology')
        bm.to_mesh(mesh)
        mesh.update()
        temporary = bpy.data.objects.new('db_timber_edge_finish', mesh)
        bpy.context.scene.collection.objects.link(temporary)
        for obj in bpy.context.selected_objects:
            obj.select_set(False)
        temporary.select_set(True)
        bpy.context.view_layer.objects.active = temporary
        # Three bevel segments meet at 30 degrees. Keep a margin above that
        # boundary so float32 rounding cannot split equivalent scaled meshes.
        # The right-angle concave notch edges remain sharp.
        if 'FINISHED' not in bpy.ops.object.shade_smooth_by_angle(angle=math.radians(45)):
            _invalid('could not shade the finished timber')
        normals = temporary.modifiers.new('db_timber_weighted_normals', 'WEIGHTED_NORMAL')
        normals.keep_sharp, normals.mode, normals.weight = True, 'FACE_AREA_WITH_ANGLE', 50
        if 'FINISHED' not in bpy.ops.object.modifier_apply(modifier=normals.name):
            _invalid('could not preserve flat face shading')
        output = temporary.data
        corner_normals = [item.vector.copy() for item in output.corner_normals]
        output.transform(matrix.inverted())
        to_local_normal = matrix.to_3x3().transposed()
        output.normals_split_custom_set([tuple((to_local_normal @ normal).normalized()) for normal in corner_normals])
        if any(not math.isfinite(x) for layer in output.uv_layers for item in layer.data for x in item.uv):
            _invalid('finishing produced non-finite UV coordinates')
        completed = True
        return output
    finally:
        bm.free()
        if temporary is not None:
            # Native modifiers may replace their input datablock, including
            # before raising. The caller still owns the staged input on error.
            alternate = temporary.data
            bpy.data.objects.remove(temporary, do_unlink=True)
            if completed:
                if output != mesh and mesh.users == 0:
                    bpy.data.meshes.remove(mesh)
            elif alternate != mesh and alternate.users == 0:
                bpy.data.meshes.remove(alternate)
        for obj in old_selected:
            if obj.name in bpy.context.scene.objects:
                obj.select_set(True)
        if old_active is not None and old_active.name in bpy.context.scene.objects:
            bpy.context.view_layer.objects.active = old_active
