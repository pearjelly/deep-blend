"""Render-aspect framing check for each evaluated preview frame.

Bounds wholly inside the frustum are sufficient; otherwise check actual mesh
vertices to avoid rejecting an empty corner of a loose bounding box. This does
not detect occlusion, transparency, shader displacement or appearance.
"""
import math
import re

from deepblend_util import ActionError


def refuse(code, message, frame=None):
    raise ActionError(code, message, {'frame': frame} if frame is not None else None)


def validate_audit(audit, frames, camera_selection):
    if (not isinstance(audit, dict) or set(audit) != {'entityIds', 'assetInstanceIds'} or
            not isinstance(audit['entityIds'], list) or not 1 <= len(audit['entityIds']) <= 128 or
            not isinstance(audit['assetInstanceIds'], list) or
            any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,127}', x)
                for x in [*audit['entityIds'], *audit['assetInstanceIds']]) or
            len(set(audit['entityIds'])) != len(audit['entityIds']) or
            len(set(audit['assetInstanceIds'])) != len(audit['assetInstanceIds']) or
            not set(audit['assetInstanceIds']) <= set(audit['entityIds']) or
            camera_selection is not None or
            not 1 <= len(frames) <= 360 or any(type(x) is not int or not 0 <= x <= 1_000_000 for x in frames) or
            len(set(frames)) != len(frames)):
        refuse('MOTION_FRAME_UNVERIFIABLE', 'Invalid bounded motion frame inspection.')


def audit_frame(scene, camera, audit, frame):
    import bpy
    from mathutils import Vector
    from bpy_extras.object_utils import world_to_camera_view

    graph = bpy.context.evaluated_depsgraph_get()
    evaluated_camera = camera.evaluated_get(graph)
    if evaluated_camera.data.type != 'PERSP':
        refuse('MOTION_FRAME_UNVERIFIABLE', 'The camera projection cannot be checked.', frame)
    visible, seen, pending = set(), set(), [scene.collection]
    while pending:
        collection = pending.pop()
        pointer = collection.as_pointer()
        if pointer in seen or collection.hide_render:
            continue
        seen.add(pointer)
        visible.update(obj.as_pointer() for obj in collection.objects)
        pending.extend(collection.children)
    owned, mesh_count, vertices, polygons = set(), 0, 0, 0
    for entity_id in audit['entityIds']:
        root = bpy.data.objects.get('db_entity__' + entity_id)
        if root is None or entity_id not in audit['assetInstanceIds'] and (root.type != 'MESH' or root.children):
            refuse('MOTION_FRAME_UNVERIFIABLE', 'A selected product part cannot be inspected.', frame)
        pending, entity_meshes = [root], 0
        while pending:
            obj = pending.pop()
            pointer = obj.as_pointer()
            if pointer in owned or len(owned) >= 4096:
                refuse('MOTION_FRAME_UNVERIFIABLE', 'Selected hierarchies overlap or exceed the inspection budget.', frame)
            owned.add(pointer)
            if obj != root and obj.name.startswith(('db_entity__', 'db_camera__', 'db_light__')):
                if not (obj.name.startswith(root.name + '_') and obj.get('deepblend_id') == entity_id and
                        obj.get('deepblend_kind') == 'entity' and isinstance(obj.get('deepblend_part_id'), str) and obj['deepblend_part_id']):
                    refuse('MOTION_FRAME_UNVERIFIABLE', 'An asset hierarchy includes another managed entity.', frame)
            if (obj.type not in ('EMPTY', 'MESH') or obj.instance_type != 'NONE' or obj.hide_render or
                    not obj.visible_get(view_layer=bpy.context.view_layer) or pointer not in visible or
                    obj.rigid_body is not None or obj.rigid_body_constraint is not None):
                refuse('MOTION_FRAME_UNVERIFIABLE', 'A selected part is hidden or has unsupported geometry.', frame)
            for modifier in obj.modifiers:
                if (modifier.show_viewport != modifier.show_render or
                        modifier.type in ('CLOTH', 'SOFT_BODY', 'FLUID', 'PARTICLE_SYSTEM', 'NODES') or
                        modifier.type == 'SUBSURF' and modifier.levels != modifier.render_levels):
                    refuse('MOTION_FRAME_UNVERIFIABLE', 'A selected part has unsupported render geometry.', frame)
            if obj.type == 'MESH':
                mesh_count += 1
                entity_meshes += 1
                if mesh_count > 128:
                    refuse('MOTION_FRAME_UNVERIFIABLE', 'The selected meshes exceed the inspection budget.', frame)
                evaluated = obj.evaluated_get(graph)
                mesh = evaluated.to_mesh()
                try:
                    if mesh is None or not mesh.vertices or not mesh.polygons:
                        refuse('MOTION_FRAME_UNVERIFIABLE', 'A selected evaluated mesh is empty.', frame)
                    vertices += len(mesh.vertices)
                    polygons += len(mesh.polygons)
                    if vertices > 2_000_000 or polygons > 2_000_000:
                        refuse('MOTION_FRAME_UNVERIFIABLE', 'The evaluated geometry exceeds the inspection budget.', frame)
                    bounds = [tuple(corner) for corner in evaluated.bound_box]
                    if len(bounds) != 8:
                        refuse('MOTION_FRAME_UNVERIFIABLE', 'An evaluated mesh has no bounding box.', frame)
                    def inside(point):
                        world = evaluated.matrix_world @ Vector(point)
                        if not all(math.isfinite(float(v)) and abs(float(v)) <= 1e6 for v in world):
                            refuse('MOTION_FRAME_UNVERIFIABLE', 'A selected mesh has invalid coordinates.', frame)
                        p = world_to_camera_view(scene, evaluated_camera, world)
                        if not all(math.isfinite(float(v)) for v in p):
                            refuse('MOTION_FRAME_UNVERIFIABLE', 'The selected mesh cannot be projected.', frame)
                        return (evaluated_camera.data.clip_start <= p.z <= evaluated_camera.data.clip_end and
                                0 <= p.x <= 1 and 0 <= p.y <= 1)
                    if not all(inside(corner) for corner in bounds):
                        if not all(inside(vertex.co) for vertex in mesh.vertices):
                            refuse('MOTION_OUT_OF_FRAME', 'A selected product part leaves the frame.', frame)
                finally:
                    evaluated.to_mesh_clear()
            pending.extend(obj.children)
        if not entity_meshes:
            refuse('MOTION_FRAME_UNVERIFIABLE', 'A selected product part has no mesh.', frame)
