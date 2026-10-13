"""Bounded, read-only evaluation of a hash-pinned native checkpoint."""
import hashlib
import math
import os
import re

from deepblend_util import ActionError


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_geometry(request, options):
    import bpy
    payload = request.get('payload')
    if not isinstance(payload, dict):
        raise ActionError('BLENDER_SCRIPT_ERROR', 'Geometry inspection payload must be an object.')
    ids, frame, expected = payload.get('entityIds'), payload.get('frame'), payload.get('checkpointSha256')
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 8 or
            any(not isinstance(x, str) or not x or x.strip() != x or len(x) > 128 or '\x00' in x for x in ids) or
            len(set(ids)) != len(ids) or type(frame) is not int or not 0 <= frame <= 1000000 or
            not isinstance(expected, str) or re.fullmatch('[a-f0-9]{64}', expected) is None):
        raise ActionError('BLENDER_SCRIPT_ERROR', 'Geometry inspection requires 1–8 distinct entity IDs, an explicit frame and checkpoint SHA256.')
    checkpoint = options.get('blend')
    if not checkpoint or not os.path.isfile(checkpoint):
        raise ActionError('REVISION_CHECKPOINT_MISSING', 'Geometry inspection needs a native checkpoint.')
    if os.path.getsize(checkpoint) > 1024 ** 3 or file_digest(checkpoint) != expected:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The inspected checkpoint differs from the expected source.')
    try:
        bpy.ops.wm.open_mainfile(filepath=checkpoint, load_ui=False, use_scripts=False)
    except Exception as exc:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The native checkpoint cannot be opened for inspection.') from exc
    if bpy.data.libraries:
        raise ActionError('BLENDER_UNSUPPORTED_ACTION', 'Inspection requires self-contained geometry; externally linked Blender libraries are not hash-bound by this checkpoint.')
    unit_scale = float(bpy.context.scene.unit_settings.scale_length)
    if not math.isfinite(unit_scale) or abs(unit_scale - 1.0) > 1e-8:
        raise ActionError('BLENDER_UNSUPPORTED_ACTION', 'Inspection requires a native unit scale of 1 metre per Blender unit; rescaled display units cannot be reported as millimetres.')
    bpy.context.scene.frame_set(frame)
    measured_frame = int(bpy.context.scene.frame_current)
    if measured_frame != frame:
        raise ActionError('SCENE_VALIDATION_FAILED', 'Blender did not evaluate the requested inspection frame.')
    graph = bpy.context.evaluated_depsgraph_get()
    objects = []
    for entity_id in ids:
        obj = bpy.data.objects.get('db_entity__' + entity_id)
        if obj is None:
            raise ActionError('SCENE_SPEC_INVALID', 'The selected native entity does not exist: ' + entity_id)
        entry = {'entityId': entity_id, 'type': obj.type, 'available': False}
        if obj.type != 'MESH':
            entry['unavailableReason'] = 'not-mesh'
        elif not obj.visible_get(view_layer=bpy.context.view_layer):
            entry['unavailableReason'] = 'viewport-disabled'
        else:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            try:
                if mesh is None or not mesh.vertices:
                    entry['unavailableReason'] = 'empty-or-invalid-geometry'
                else:
                    low = [math.inf] * 3
                    high = [-math.inf] * 3
                    finite = True
                    for vertex in mesh.vertices:
                        point = evaluated.matrix_world @ vertex.co
                        if not all(math.isfinite(x) for x in point):
                            finite = False
                            break
                        for axis in range(3):
                            low[axis] = min(low[axis], float(point[axis]))
                            high[axis] = max(high[axis], float(point[axis]))
                    matrix = [[float(x) for x in row] for row in evaluated.matrix_world]
                    scale = [float(x) for x in obj.scale]
                    if not finite or not all(math.isfinite(x) for row in matrix for x in row) or not all(math.isfinite(x) for x in scale):
                        entry['unavailableReason'] = 'empty-or-invalid-geometry'
                    else:
                        entry.update(available=True, worldBoundsMeters={'min': low, 'max': high},
                                     worldAxisExtentMm=[(high[i] - low[i]) * 1000 for i in range(3)],
                                     worldMatrix=matrix, scale=scale, vertexCount=len(mesh.vertices), polygonCount=len(mesh.polygons))
            finally:
                evaluated.to_mesh_clear()
        objects.append(entry)
    if file_digest(checkpoint) != expected:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The checkpoint changed during geometry inspection.')
    return {'schemaVersion': 'deepblend.geometry-inspection/v1', 'checkpointSha256': expected,
            'checkpointUnchanged': True, 'frame': measured_frame, 'blenderVersion': bpy.app.version_string,
            'objects': objects}, [], []
