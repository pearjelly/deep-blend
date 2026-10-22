"""Read-only perspective projection of actual evaluated vertices at one frame."""
import math
import bpy
from deepblend_util import ActionError


def framing_camera(scene, graph, camera_id, margin):
    # A full-camera frustum cannot certify a masked/cropped render region or
    # multiple eye views. Keep manual settings intact and refuse that claim.
    if scene.render.use_border or scene.render.use_multiview:
        raise ActionError('BLENDER_UNSUPPORTED_ACTION', 'Native camera framing does not support render borders or multiview; manual settings are unchanged. Geometry inspection without a camera remains available.')
    obj = bpy.data.objects.get('db_camera__' + camera_id)
    if obj is None or obj.type != 'CAMERA':
        raise ActionError('SCENE_SPEC_INVALID', 'Selected native framing camera does not exist.')
    camera = obj.evaluated_get(graph)
    if camera.data.type != 'PERSP':
        raise ActionError('BLENDER_UNSUPPORTED_ACTION', 'Native vertex framing currently requires a perspective camera.')
    # Blender's camera projection ignores object scale (world_to_camera_view
    # normalizes the matrix too). Respect old projects' manual camera scale.
    normalized = camera.matrix_world.normalized()
    if not math.isfinite(normalized.determinant()) or abs(normalized.determinant()) < 1e-12:
        raise ActionError('SCENE_VALIDATION_FAILED', 'Degenerate native camera transform.')
    inverse = normalized.inverted()
    corners = camera.data.view_frame(scene=scene)
    slopes = [(p.x/-p.z, p.y/-p.z) for p in corners]
    limits = [min(p[0] for p in slopes), max(p[0] for p in slopes), min(p[1] for p in slopes), max(p[1] for p in slopes)]
    if not all(math.isfinite(v) for v in limits) or limits[0] >= limits[1] or limits[2] >= limits[3]:
        raise ActionError('SCENE_VALIDATION_FAILED', 'Invalid native camera frustum.')
    return inverse, limits, {'id': camera_id, 'type': 'PERSP', 'margin': margin,
                             'clipStartMeters': float(camera.data.clip_start), 'clipEndMeters': float(camera.data.clip_end)}


def project_geometry(obj, aggregate, graph, calibration):
    inverse, (left, right, bottom, top), camera = calibration
    parts = ([obj] + list(obj.children_recursive)) if aggregate else [obj]
    meshes = [p for p in parts if p.type == 'MESH']
    if any(p.hide_render for p in parts):
        return {'status': 'unavailable-render-hidden'}
    low, high, nearest, farthest, count = [math.inf]*2, [-math.inf]*2, math.inf, -math.inf, 0
    for part in meshes:
        evaluated = part.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        try:
            count += len(mesh.vertices) if mesh else 0
            if count > 2000000:
                return {'status': 'geometry-budget-exceeded'}
            if mesh is None or not mesh.vertices:
                raise ActionError('SCENE_VALIDATION_FAILED', 'Geometry disappeared during framing inspection.')
            for vertex in mesh.vertices:
                point = inverse @ (evaluated.matrix_world @ vertex.co)
                depth = -float(point.z)
                if not all(math.isfinite(v) for v in point):
                    raise ActionError('SCENE_VALIDATION_FAILED', 'Non-finite native framing vertex.')
                nearest, farthest = min(nearest, depth), max(farthest, depth)
                if depth > 1e-8:
                    uv = [(float(point.x)/depth-left)/(right-left), (float(point.y)/depth-bottom)/(top-bottom)]
                    for axis in range(2):
                        low[axis], high[axis] = min(low[axis], uv[axis]), max(high[axis], uv[axis])
        finally:
            evaluated.to_mesh_clear()
    result = {'status': 'not-fully-in-front' if nearest <= 1e-8 else 'measured',
              'nearestDepthMeters': nearest, 'farthestDepthMeters': farthest,
              'containedInClip': nearest >= camera['clipStartMeters'] and farthest <= camera['clipEndMeters']}
    if result['status'] == 'measured':
        margin = camera['margin']
        result.update(normalizedBounds={'min': low, 'max': high},
                      containedInFrame=all(low[i] >= margin and high[i] <= 1-margin for i in range(2)))
    return result
