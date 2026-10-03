"""Deterministic meshes for bounded SceneSpec modeling operations."""
import math

import bpy
from deepblend_util import ActionError


def apply_model_modifiers(entities, entity_meshes):
    """Apply dependency-ordered, bounded mesh operations to actual geometry."""
    by_id = {entity["id"]: entity for entity in entities}
    done, active = set(), set()
    bpy.context.view_layer.update()

    def single_mesh(entity_id):
        meshes = entity_meshes.get(entity_id, [])
        if len(meshes) != 1:
            raise ActionError("SCENE_SPEC_INVALID", 'modifier entity "%s" needs exactly one mesh' % entity_id)
        return meshes[0]

    def visit(entity_id):
        if entity_id in done:
            return
        if entity_id in active:
            raise ActionError("SCENE_SPEC_INVALID", "boolean dependency cycle: " + entity_id)
        active.add(entity_id)
        entity = by_id[entity_id]
        for entry in entity.get("modifiers", []):
            kind = entry["type"]
            obj = single_mesh(entity_id)
            if kind == "boolean":
                target = entry["targetEntityId"]
                if target not in by_id:
                    raise ActionError("SCENE_SPEC_INVALID", "missing boolean operand: " + target)
                visit(target)
                operand = single_mesh(target)
            estimate = len(obj.data.polygons) * (entry.get("count", 1) if kind == "array" else 1)
            if estimate > 500_000:
                raise ActionError("SCENE_SPEC_INVALID", "modifier exceeds the 500000 polygon per-entity budget")
            modifier = obj.modifiers.new("db_model_" + kind, kind.upper())
            if kind == "solidify":
                modifier.thickness = float(entry["thickness"])
                modifier.offset = float(entry.get("offset", -1))
                modifier.use_even_offset = True
            elif kind == "mirror":
                modifier.use_axis = tuple(axis == entry["axis"] for axis in ("x", "y", "z"))
                modifier.use_mirror_merge = bool(entry.get("merge", True))
            elif kind == "array":
                modifier.count = int(entry["count"])
                modifier.use_relative_offset = False
                modifier.use_constant_offset = True
                modifier.constant_offset_displace = entry["offset"]
            elif kind == "boolean":
                modifier.operation = entry["operation"].upper()
                modifier.solver = "EXACT"
                modifier.object = operand
            elif kind == "bevel":
                modifier.width = float(entry["width"])
                modifier.segments = int(entry.get("segments", 4))
                modifier.limit_method = "ANGLE"
                modifier.angle_limit = math.radians(float(entry.get("angle", 30)))
                modifier.use_clamp_overlap = True
                miter_inner = entry.get("miterInner", "arc")
                if miter_inner not in ("arc", "sharp"):
                    raise ActionError("SCENE_SPEC_INVALID", "bevel miterInner must be arc or sharp")
                modifier.miter_inner = {"arc": "MITER_ARC", "sharp": "MITER_SHARP"}[miter_inner]
                modifier.spread = float(entry["width"])
            for selected in bpy.context.selected_objects:
                selected.select_set(False)
            # Hidden operands still need their own modifier stack evaluated.
            hidden = obj.hide_viewport
            obj.hide_viewport = False
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            try:
                result = bpy.ops.object.modifier_apply(modifier=modifier.name)
            finally:
                obj.hide_viewport = hidden
            if "FINISHED" not in result or not obj.data.polygons:
                raise ActionError("SCENE_SPEC_INVALID", 'modifier "%s" on "%s" produced no mesh' % (kind, entity_id))
            if len(obj.data.polygons) > 500_000:
                raise ActionError("SCENE_SPEC_INVALID", "modifier result exceeds the polygon budget")
            bpy.context.view_layer.update()
        active.remove(entity_id)
        done.add(entity_id)

    for entity in entities:
        visit(entity["id"])


def create_curve(name, spec):
    """Sweep a round section along a polyline or automatic Bezier spline."""
    data = bpy.data.curves.new(name + "_path", "CURVE")
    data.dimensions = "3D"
    data.resolution_u = int(spec.get("curveResolution", 16))
    data.render_resolution_u = data.resolution_u
    data.bevel_depth = float(spec.get("radius", 0.01))
    data.bevel_resolution = int(spec.get("bevelResolution", 8))
    data.use_fill_caps = bool(spec.get("capEnds", True))
    bezier = spec.get("pathInterpolation", "poly") == "bezier"
    spline = data.splines.new("BEZIER" if bezier else "POLY")
    points = spline.bezier_points if bezier else spline.points
    points.add(len(spec["path"]) - 1)
    for point, coordinate in zip(points, spec["path"]):
        point.co = coordinate if bezier else (*coordinate, 1)
        if bezier:
            point.handle_left_type = "AUTO"
            point.handle_right_type = "AUTO"
    spline.use_cyclic_u = bool(spec.get("pathClosed", False))
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    for selected in bpy.context.selected_objects:
        selected.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    result = bpy.ops.object.convert(target="MESH")
    if "FINISHED" not in result:
        raise RuntimeError("curve conversion did not produce a mesh")
    obj = bpy.context.object
    # Curve conversion duplicates the end-cap rim vertices. Weld those rims
    # into the side wall; per-corner UVs remain distinct across texture seams.
    import bmesh
    mesh = bmesh.new()
    try:
        mesh.from_mesh(obj.data)
        bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=max(float(spec.get("radius", 0.01)) * 1e-7, 1e-12))
        bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
        mesh.to_mesh(obj.data)
    finally:
        mesh.free()
    return obj


def create_lathe(name, spec):
    """Revolve an ordered [radius, height] boundary about local Z.

    Axis points become one vertex, so caps have no coincident pole rings.
    UV U runs around the circumference; V follows profile arc length.
    """
    import bmesh

    profile = spec["profile"]
    segments = int(spec.get("segments", 96))
    closed = bool(spec.get("closedProfile", False))
    vertices, rings, faces, face_uvs = [], [], [], []
    distances = [0.0]
    for a, b in zip(profile, profile[1:]):
        distances.append(distances[-1] + math.dist(a, b))
    total = distances[-1] + (math.dist(profile[-1], profile[0]) if closed else 0)
    for radius, height in profile:
        ring = []
        for index in range(1 if radius == 0 else segments):
            angle = math.tau * index / segments
            ring.append(len(vertices))
            vertices.append((radius * math.cos(angle), radius * math.sin(angle), height))
        rings.append(ring)

    def add_face(indices, uvs):
        # A pole appears twice in a quad. Collapse it to a triangle while
        # retaining the texture seam as per-corner UVs.
        unique = []
        corners = []
        for index, uv in zip(indices, uvs):
            if index not in unique:
                unique.append(index)
                corners.append(uv)
        if len(unique) >= 3:
            faces.append(unique)
            face_uvs.append(corners)

    for row in range(len(profile) if closed else len(profile) - 1):
        following = (row + 1) % len(profile)
        a, b = rings[row], rings[following]
        va = distances[row] / total
        vb = distances[following] / total if following else 1.0
        for column in range(segments):
            next_column = (column + 1) % segments
            ua, ub = column / segments, (column + 1) / segments
            add_face([a[column % len(a)], a[next_column % len(a)],
                      b[next_column % len(b)], b[column % len(b)]],
                     [(ua, va), (ub, va), (ub, vb), (ua, vb)])

    if not closed and spec.get("capEnds", True):
        for row, reverse in [(0, True), (len(rings) - 1, False)]:
            ring = rings[row]
            if len(ring) == 1:
                continue
            ordered = list(reversed(ring)) if reverse else list(ring)
            radius = profile[row][0]
            add_face(ordered, [(vertices[index][0] / (2 * radius) + 0.5,
                                vertices[index][1] / (2 * radius) + 0.5) for index in ordered])

    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon, corners in zip(mesh.polygons, face_uvs):
        for loop_index, coordinate in zip(polygon.loop_indices, corners):
            uv.data[loop_index].uv = coordinate
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
    finally:
        bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    return obj
