"""Bounded, read-only framing measurements of one evaluated cup and hero camera."""
import math
import bpy
from deepblend_util import ActionError


def measure_cup_hero_framing(spec, selection):
    if not isinstance(selection, dict) or set(selection) != {'entityId', 'cameraId', 'margin'} or selection != {'entityId': 'cup', 'cameraId': 'hero', 'margin': 0.03}:
        raise ActionError('SCENE_VALIDATION_FAILED', 'Expected one bounded cup/hero framing selection')
    entity = next((e for e in spec.get('entities', []) if e.get('id') == 'cup'), None)
    if not entity or entity.get('generator', {}).get('shape') != 'handled_cup':
        raise ActionError('SCENE_VALIDATION_FAILED', 'Cup framing needs the declared handled-cup entity')
    camera = bpy.data.objects.get('db_camera__hero')
    obj = bpy.data.objects.get('db_entity__cup')
    if camera is None or obj is None or camera.type != 'CAMERA' or obj.type != 'MESH' or camera.data.type != 'PERSP':
        raise ActionError('SCENE_VALIDATION_FAILED', 'Native cup and perspective hero are required for framing')
    scene = bpy.context.scene
    if not obj.visible_get(view_layer=bpy.context.view_layer) or obj.hide_render:
        raise ActionError('SCENE_VALIDATION_FAILED', 'Cannot frame an unavailable cup surface')
    if any(t.get('targetKind') == 'camera' and t.get('targetEntityId') == 'hero' for t in spec.get('animationTracks', [])):
        raise ActionError('SCENE_VALIDATION_FAILED', 'An authored camera animation cannot be reframed')
    depsgraph = bpy.context.evaluated_depsgraph_get()
    measured_camera = camera.evaluated_get(depsgraph)
    inverse = measured_camera.matrix_world.inverted()
    frame = measured_camera.data.view_frame(scene=scene)
    slopes = [(p.x / -p.z, p.y / -p.z) for p in frame]
    left, right = min(p[0] for p in slopes), max(p[0] for p in slopes)
    bottom, top = min(p[1] for p in slopes), max(p[1] for p in slopes)
    margin = selection['margin']
    left, right = left + (right-left)*margin, right - (right-left)*margin
    bottom, top = bottom + (top-bottom)*margin, top - (top-bottom)*margin
    if not left < 0 < right or not bottom < 0 < top:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The hero optical axis is outside the usable frame')
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
    try:
        if mesh is None or not 1 <= len(mesh.vertices) <= 2000000:
            raise ActionError('SCENE_TOO_HEAVY', 'Cup framing requires 1 to 2000000 evaluated vertices')
        backoff, nearest, farthest = 0.0, math.inf, -math.inf
        for vertex in mesh.vertices:
            point = inverse @ (evaluated.matrix_world @ vertex.co)
            depth = -point.z
            if not all(math.isfinite(v) for v in [point.x, point.y, depth]):
                raise ActionError('SCENE_VALIDATION_FAILED', 'Non-finite evaluated framing vertex')
            nearest, farthest = min(nearest, depth), max(farthest, depth)
            backoff = max(backoff, point.x/right-depth, point.x/left-depth,
                          point.y/top-depth, point.y/bottom-depth,
                          camera.data.clip_start+1e-5-depth)
        # Avoid a second corrective compile due to single-precision matrix noise.
        backoff = backoff + 1e-5 if backoff > 1e-6 else 0.0
        if not math.isfinite(backoff) or farthest+backoff >= camera.data.clip_end-1e-5:
            raise ActionError('SCENE_VALIDATION_FAILED', 'Cup framing exceeds the hero far clip')
        return {'schemaVersion': 'deepblend.camera-framing/v1', **selection,
                'frame': int(scene.frame_current), 'resolution': [scene.render.resolution_x, scene.render.resolution_y],
                'resolutionPercentage': scene.render.resolution_percentage,
                'pixelAspect': [scene.render.pixel_aspect_x, scene.render.pixel_aspect_y],
                'cameraLocation': list(measured_camera.matrix_world.translation),
                'cameraType': camera.data.type, 'lens': camera.data.lens, 'sensorWidth': camera.data.sensor_width,
                'backoffM': backoff, 'vertices': len(mesh.vertices),
                'nearestDepthM': nearest+backoff, 'farthestDepthM': farthest+backoff,
                'scope': 'evaluated-cup-vertices-at-reported-frame-and-render-aspect'}
    finally:
        if mesh is not None:
            evaluated.to_mesh_clear()
