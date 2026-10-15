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


def object_axis_frame(matrix):
    values = [[float(x) for x in row] for row in matrix]
    if not all(math.isfinite(x) for row in values for x in row) or values[3] != [0, 0, 0, 1]:
        return None
    lengths = [math.sqrt(sum(values[row][axis] ** 2 for row in range(3))) for axis in range(3)]
    if any(not math.isfinite(x) or x <= 1e-12 for x in lengths):
        return None
    columns = [[values[row][axis] / lengths[axis] for row in range(3)] for axis in range(3)]
    if any(abs(sum(columns[a][row] * columns[b][row] for row in range(3))) > 1e-6 for a in range(3) for b in range(a + 1, 3)):
        return None
    basis = [[columns[axis][row] for axis in range(3)] + [values[row][3]] for row in range(3)] + [[0, 0, 0, 1]]
    return lengths, basis


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
    object_axes = payload.get('objectAxes', False)
    if type(object_axes) is not bool:
        raise ActionError('BLENDER_SCRIPT_ERROR', 'objectAxes must be boolean.')
    samples = payload.get('surfaceSamples')
    if 'surfaceSamples' in payload:
        from deepblend_inspect_surface import validate_surface_selection
        validate_surface_selection(samples, ids)
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
            axis_frame = object_axis_frame(evaluated.matrix_world) if object_axes else None
            mesh = evaluated.to_mesh()
            try:
                if mesh is None or not mesh.vertices:
                    entry['unavailableReason'] = 'empty-or-invalid-geometry'
                else:
                    low = [math.inf] * 3
                    high = [-math.inf] * 3
                    local_low, local_high = [math.inf] * 3, [-math.inf] * 3
                    finite = True
                    for vertex in mesh.vertices:
                        point = evaluated.matrix_world @ vertex.co
                        if not all(math.isfinite(x) for x in point) or not all(math.isfinite(x) for x in vertex.co):
                            finite = False
                            break
                        for axis in range(3):
                            if object_axes and axis_frame is not None:
                                local_low[axis] = min(local_low[axis], float(vertex.co[axis]) * axis_frame[0][axis])
                                local_high[axis] = max(local_high[axis], float(vertex.co[axis]) * axis_frame[0][axis])
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
                        if object_axes and axis_frame is None:
                            entry['objectAxisStatus'] = 'unsupported-object-axis-basis'
                        elif object_axes:
                            entry.update(objectAxisStatus='measured', objectAxisWorldMatrix=axis_frame[1], objectAxisBoundsMeters={'min': local_low, 'max': local_high},
                                         objectAxisExtentMm=[(local_high[i] - local_low[i]) * 1000 for i in range(3)])
            finally:
                evaluated.to_mesh_clear()
        objects.append(entry)
    report = {'schemaVersion': 'deepblend.geometry-inspection/v1', 'checkpointSha256': expected,
              'checkpointUnchanged': True, 'frame': measured_frame, 'blenderVersion': bpy.app.version_string,
              'objects': objects}
    if 'surfaceSamples' in payload:
        from deepblend_inspect_surface import inspect_surface_samples
        report['schemaVersion'] = 'deepblend.geometry-inspection/v2'
        report['surfaceSamples'] = inspect_surface_samples(samples, graph)
    if object_axes:
        report['schemaVersion'] = 'deepblend.geometry-inspection/v3'
        report['objectAxisBasis'] = 'evaluated-object-axes-scaled'
    if file_digest(checkpoint) != expected:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The checkpoint changed during geometry inspection.')
    return report, [], []
