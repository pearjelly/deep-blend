"""Fit an explicit static view without changing the evaluated viewing rotation.

The perspective solve uses every selected vertex, in camera coordinates. The
verification path must project the compiled candidate independently of this
formula; a proposed location alone is never evidence of a successful fit.
"""
import math
import hashlib
import json
import os
import re
import struct

from deepblend_util import ActionError

VERSION = 'deepblend.camera-fit/v1'
TOLERANCE = .00002


def _refuse(message, code='SCENE_VALIDATION_FAILED'):
    raise ActionError(code, 'Camera fit: '+message)


def fit_perspective_points(points, limits, clipping, margin):
    """Return the new origin in the source camera's normalized local frame.

    Recenter the vertex bounds and find a distance satisfying all four frustum
    planes and the near clip. Shifted frusta are handled by moving the origin
    opposite their midpoint slope. Far clipping is a hard refusal.
    """
    if (not isinstance(points, (list, tuple)) or len(limits) != 4 or len(clipping) != 2 or
            not all(math.isfinite(x) for x in [*limits, *clipping, margin]) or
            not 0 <= margin <= .25 or not 0 < clipping[0] < clipping[1]):
        raise ValueError('Invalid perspective calibration')
    left, right, bottom, top = limits
    if not left < right or not bottom < top:
        raise ValueError('Degenerate perspective calibration')
    width, height = right-left, top-bottom
    left, right = left+width*margin, right-width*margin
    bottom, top = bottom+height*margin, top-height*margin
    middle_x, middle_y = (left+right)/2, (bottom+top)/2
    half_x, half_y = (right-left)/2, (top-bottom)/2
    low, high, count = [math.inf]*3, [-math.inf]*3, 0
    for point in points:
        count += 1
        if count > 2_000_000 or len(point) != 3 or not all(math.isfinite(x) and abs(x) <= 1e6 for x in point):
            raise ValueError('Invalid or excessive evaluated vertices')
        for axis in range(3):
            low[axis], high[axis] = min(low[axis], point[axis]), max(high[axis], point[axis])
    if count == 0:
        raise ValueError('No evaluated vertices')
    center = [(low[i]+high[i])/2 for i in range(3)]
    distance = 0.0
    for point in points:
        x, y, z = [point[i]-center[i] for i in range(3)]
        distance = max(distance, (x+right*z)/half_x, -(x+left*z)/half_x,
                       (y+top*z)/half_y, -(y+bottom*z)/half_y,
                       clipping[0]+z)
    # Recompilation and matrix operations use Blender's single-precision values.
    distance += max(.0001, distance*1e-5)
    nearest, farthest = distance-(high[2]-center[2]), distance-(low[2]-center[2])
    if not math.isfinite(distance) or farthest >= clipping[1]-.00001:
        raise ValueError('The complete selection cannot fit inside the camera clip range')
    return {'origin': [center[0]-middle_x*distance, center[1]-middle_y*distance, center[2]+distance],
            'center': center, 'distanceMeters': distance,
            'nearestDepthMeters': nearest, 'farthestDepthMeters': farthest,
            'vertexCount': count}


def _hash_file(path, expected):
    from deepblend_inspect_geometry import file_digest
    if not isinstance(path, str) or not os.path.isfile(path) or file_digest(path) != expected:
        _refuse('The checkpoint differs from its pinned native source.')


def _camera_settings(camera):
    data = camera.data
    if (data.type != 'PERSP' or data.dof.aperture_blades != 0 or
            data.dof.aperture_rotation != 0 or data.dof.aperture_ratio != 1):
        _refuse('This camera has unsupported projection or aperture settings.', 'BLENDER_UNSUPPORTED_ACTION')
    return {'lens': float(data.lens), 'sensorWidth': float(data.sensor_width),
            'sensorHeight': float(data.sensor_height), 'sensorFit': data.sensor_fit,
            'shift': [float(data.shift_x), float(data.shift_y)],
            'clipping': [float(data.clip_start), float(data.clip_end)],
            **({'fStop': float(data.dof.aperture_fstop)} if data.dof.use_dof else {})}


def canonical_face(indices):
    """Face order and cyclic starting corners do not change oriented topology."""
    values = tuple(indices)
    if not values:
        _refuse('An evaluated face has no corners.')
    start = min(range(len(values)), key=values.__getitem__)
    return values[start:]+values[:start]


def _capture(path, expected, selection, camera_id):
    import bpy
    from mathutils import Vector
    from bpy_extras.object_utils import world_to_camera_view
    from deepblend_geometry_framing import framing_camera
    _hash_file(path, expected)
    bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    if len(scene.objects) > 100_000:
        _refuse('The native scene exceeds the original-object verification budget.', 'SCENE_TOO_HEAVY')
    if bpy.data.libraries or abs(scene.unit_settings.scale_length-1) > 1e-8:
        _refuse('A self-contained checkpoint with metre units is required.', 'BLENDER_UNSUPPORTED_ACTION')
    if 'photography' in selection:
        _verify_static_product(selection)
    scene.frame_set(selection['frame'])
    if scene.frame_current != selection['frame']:
        _refuse('The requested frame was not evaluated.')
    graph = bpy.context.evaluated_depsgraph_get()
    inverse, limits, _ = framing_camera(scene, graph, camera_id, selection['margin'])
    camera = bpy.data.objects['db_camera__'+camera_id].evaluated_get(graph)
    settings = _camera_settings(camera)
    matrix = camera.matrix_world.normalized().copy()
    if (matrix.to_3x3().determinant() < 0 or
            any(abs(matrix.col[a].to_3d().dot(matrix.col[b].to_3d())) > 1e-6
                for a in range(3) for b in range(a+1, 3))):
        _refuse('A nonsheared viewing rotation is required.', 'BLENDER_UNSUPPORTED_ACTION')
    render_visible, visited, pending = set(), set(), [scene.collection]
    while pending:
        collection = pending.pop()
        pointer = collection.as_pointer()
        if pointer in visited or collection.hide_render:
            continue
        visited.add(pointer)
        render_visible.update(obj.as_pointer() for obj in collection.objects)
        pending.extend(collection.children)
    parts, members, total_vertices, total_polygons = [], [], 0, 0
    owned = set()
    all_world = []
    asset_ids = selection.get('assetInstanceIds', [])
    for entity_id in selection['entityIds']:
        obj = bpy.data.objects.get('db_entity__'+entity_id)
        if obj is None:
            _refuse('The selected native entity does not exist: '+entity_id, 'SCENE_SPEC_INVALID')
        if entity_id not in asset_ids and (obj.type != 'MESH' or obj.children):
            _refuse('Select whole mesh entities or explicit asset instances.', 'BLENDER_UNSUPPORTED_ACTION')
        pending, hierarchy, meshes = [obj], [], []
        while pending:
            part = pending.pop()
            pointer = part.as_pointer()
            if pointer in owned or len(owned) >= 4096:
                _refuse('Overlapping selections or an excessive hierarchy cannot be fitted.', 'BLENDER_UNSUPPORTED_ACTION')
            owned.add(pointer)
            if part != obj and part.name.startswith(('db_entity__', 'db_camera__', 'db_light__')):
                if not (part.name.startswith(obj.name+'_') and part.get('deepblend_id') == entity_id and
                        part.get('deepblend_kind') == 'entity' and isinstance(part.get('deepblend_part_id'), str) and part['deepblend_part_id']):
                    _refuse('An asset hierarchy includes another managed entity.', 'BLENDER_UNSUPPORTED_ACTION')
            if (part.type not in ('EMPTY', 'MESH') or part.instance_type != 'NONE' or
                    not part.visible_get(view_layer=bpy.context.view_layer) or part.hide_render or
                    pointer not in render_visible):
                _refuse('Hidden, instanced or nonmesh hierarchy parts cannot be silently omitted.', 'BLENDER_UNSUPPORTED_ACTION')
            if part.rigid_body is not None or part.rigid_body_constraint is not None:
                _refuse('Physics-dependent geometry is outside a static fitted view.', 'BLENDER_UNSUPPORTED_ACTION')
            for modifier in part.modifiers:
                if (modifier.show_viewport != modifier.show_render or
                        modifier.type in ('CLOTH', 'SOFT_BODY', 'FLUID', 'PARTICLE_SYSTEM', 'NODES') or
                        modifier.type == 'SUBSURF' and modifier.levels != modifier.render_levels):
                    _refuse('The selected viewport geometry does not provide a bounded render-equivalent mesh.', 'BLENDER_UNSUPPORTED_ACTION')
            hierarchy.append([part.name, part.parent.name if part.parent else None, part.type])
            if part.type == 'MESH':
                meshes.append(part)
            pending.extend(sorted(part.children, key=lambda p: p.name, reverse=True))
        if not meshes or len(parts)+len(meshes) > 128:
            _refuse('Select 1–128 mesh objects in total.', 'SCENE_TOO_HEAVY')
        world, low, high, digest = [], [math.inf]*3, [-math.inf]*3, hashlib.sha256()
        for part in meshes:
            evaluated = part.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            try:
                if mesh is None or not mesh.vertices or not mesh.polygons:
                    _refuse('A selected mesh is empty.')
                total_vertices += len(mesh.vertices)
                total_polygons += len(mesh.polygons)
                if total_vertices > 2_000_000 or total_polygons > 2_000_000:
                    _refuse('The complete selection exceeds two million vertices or polygons.', 'SCENE_TOO_HEAVY')
                vertices = []
                for vertex in mesh.vertices:
                    point = tuple(float(x) for x in evaluated.matrix_world @ vertex.co)
                    if not all(math.isfinite(x) and abs(x) <= 1e6 for x in point):
                        _refuse('Nonfinite or excessive world coordinates.')
                    digest.update(struct.pack('<3d', *point))
                    vertices.append(point)
                    for axis in range(3):
                        low[axis], high[axis] = min(low[axis], point[axis]), max(high[axis], point[axis])
                topology = sorted(canonical_face(p.vertices) for p in mesh.polygons)
                digest.update(json.dumps(topology, separators=(',', ':')).encode())
                parts.append({'name': part.name, 'vertices': vertices, 'topology': topology})
                world.extend(vertices)
            finally:
                evaluated.to_mesh_clear()
        projected = [world_to_camera_view(scene, camera, Vector(p)) for p in world]
        nearest, farthest = min(p.z for p in projected), max(p.z for p in projected)
        projection = {'containedInClip': nearest >= settings['clipping'][0] and farthest <= settings['clipping'][1],
                      'nearestDepthMeters': nearest, 'farthestDepthMeters': farthest,
                      'containedInFrame': False}
        if nearest > 1e-8:
            minimum, maximum = [min(p[i] for p in projected) for i in range(2)], [max(p[i] for p in projected) for i in range(2)]
            projection.update(normalizedBounds={'min': minimum, 'max': maximum},
                              containedInFrame=all(minimum[i] >= selection['margin'] and maximum[i] <= 1-selection['margin'] for i in range(2)))
        members.append({'entityId': entity_id, 'meshObjectCount': len(meshes), 'vertexCount': len(world),
                        'worldBoundsMeters': {'min': low, 'max': high}, 'geometrySha256': digest.hexdigest(),
                        'projection': projection, 'hierarchy': hierarchy})
        all_world.extend(world)
    # Preserve original scene objects, cameras and lights at this same frame.
    states = {}
    for obj in scene.objects:
        evaluated = obj.evaluated_get(graph)
        state = {'type': obj.type, 'matrix': [list(row) for row in evaluated.matrix_world]}
        if obj.type == 'CAMERA':
            from deepblend_render import _camera_facts
            state['camera'] = _camera_facts(scene, obj)
        if obj.type == 'LIGHT':
            state['light'] = {'type': evaluated.data.type, 'energy': float(evaluated.data.energy), 'color': list(evaluated.data.color)}
        states[obj.name] = state
    view = {'resolution': [scene.render.resolution_x, scene.render.resolution_y],
            'percentage': scene.render.resolution_percentage,
            'pixelAspect': [float(scene.render.pixel_aspect_x), float(scene.render.pixel_aspect_y)],
            'activeCamera': scene.camera.name if scene.camera else None}
    _hash_file(path, expected)
    return {'matrix': matrix, 'inverse': inverse, 'limits': limits, 'settings': settings,
            'world': all_world, 'parts': parts, 'members': members, 'states': states, 'view': view,
            'focusDistance': float(camera.data.dof.focus_distance),
            'focusObject': camera.data.dof.focus_object.name if camera.data.dof.focus_object else None}


def _near_tree(a, b):
    if isinstance(a, (int, float)) and not isinstance(a, bool):
        return isinstance(b, (int, float)) and math.isfinite(a) and math.isfinite(b) and abs(a-b) <= 1e-6
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(_near_tree(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)):
        return isinstance(b, (list, tuple)) and len(a) == len(b) and all(_near_tree(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def _verify_static_product(selection):
    """Prove time-independent product evaluation, including modifier operands.

    Unlike placement, this read never translates geometry. Static Boolean,
    Mirror and Array dependencies can therefore be measured without dropping
    them or treating their hidden tools as visible product members.
    """
    import bpy
    from deepblend_surface_placement import _active_animation
    visited, collections, vertices, polygons = set(), set(), 0, 0
    allowed = {'BEVEL', 'ARRAY', 'SUBSURF', 'SOLIDIFY', 'MIRROR', 'TRIANGULATE', 'DECIMATE',
               'WELD', 'WEIGHTED_NORMAL', 'EDGE_SPLIT', 'SMOOTH', 'BOOLEAN'}
    def collection_members(collection):
        pointer = collection.as_pointer()
        if pointer in collections:
            return
        collections.add(pointer)
        for obj in collection.objects:
            visit(obj)
        for child in collection.children:
            collection_members(child)
    def visit(obj):
        nonlocal vertices, polygons
        pointer = obj.as_pointer()
        if pointer in visited:
            return
        if len(visited) >= 4096:
            _refuse('Static product dependencies exceed the inspection budget.', 'SCENE_TOO_HEAVY')
        visited.add(pointer)
        if (_active_animation(obj) or _active_animation(obj.data) or
                _active_animation(getattr(obj.data, 'shape_keys', None)) or obj.constraints or
                obj.rigid_body is not None or obj.rigid_body_constraint is not None):
            _refuse('Selected product geometry or its dependencies are animated, constrained or simulated.', 'BLENDER_UNSUPPORTED_ACTION')
        if obj.type == 'MESH':
            vertices += len(obj.data.vertices); polygons += len(obj.data.polygons)
            if vertices > 2_000_000 or polygons > 2_000_000:
                _refuse('Static product dependencies exceed the mesh budget.', 'SCENE_TOO_HEAVY')
        if obj.parent is not None:
            visit(obj.parent)
        for modifier in obj.modifiers:
            if (modifier.type not in allowed or modifier.show_viewport != modifier.show_render or
                    modifier.type == 'SUBSURF' and modifier.levels != modifier.render_levels):
                _refuse('The product has unsupported or different viewport/render geometry.', 'BLENDER_UNSUPPORTED_ACTION')
            for prop in modifier.bl_rna.properties:
                if prop.type != 'POINTER' or prop.identifier == 'rna_type':
                    continue
                reference = getattr(modifier, prop.identifier, None)
                if isinstance(reference, bpy.types.Object):
                    visit(reference)
                elif isinstance(reference, bpy.types.Collection):
                    collection_members(reference)
                elif isinstance(reference, bpy.types.ID):
                    _refuse('An unsupported product modifier dependency cannot be ignored.', 'BLENDER_UNSUPPORTED_ACTION')
    for entity_id in selection['entityIds']:
        obj = bpy.data.objects.get('db_entity__'+entity_id)
        if obj is None:
            _refuse('A selected native product member is missing.', 'SCENE_SPEC_INVALID')
        for part in [obj, *obj.children_recursive]:
            visit(part)


def _photography_snapshot(selection):
    """Sample named lighting and prove that the selected product is static.

    The source camera may be sampled at one explicit frame. A destination
    camera must be static so replacing its draft cannot erase native motion.
    """
    import bpy
    from deepblend_surface_placement import _active_animation
    requested = selection['photography']
    if (not isinstance(requested, dict) or set(requested) != {'lightIds', 'cameraMustBeStatic'} or
            type(requested.get('cameraMustBeStatic')) is not bool or
            not isinstance(requested.get('lightIds'), list) or len(requested['lightIds']) > 32 or
            len(set(requested['lightIds'])) != len(requested['lightIds']) or
            any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,127}', x) for x in requested['lightIds'])):
        _refuse('Expected named lighting and an explicit static-camera requirement.', 'SCENE_SPEC_INVALID')
    visited = set()
    def static_chain(obj):
        while obj is not None:
            pointer = obj.as_pointer()
            if pointer not in visited:
                if (_active_animation(obj) or _active_animation(obj.data) or obj.constraints or
                      obj.rigid_body is not None or obj.rigid_body_constraint is not None):
                    _refuse('Animated or constrained destination cameras and lighting cannot be replaced.', 'BLENDER_UNSUPPORTED_ACTION')
                visited.add(pointer)
            obj = obj.parent
    camera = bpy.data.objects['db_camera__'+selection['cameraId']]
    current, camera_static = camera, True
    while current is not None:
        if (_active_animation(current) or _active_animation(current.data) or current.constraints or
                current.rigid_body is not None or current.rigid_body_constraint is not None):
            camera_static = False
        current = current.parent
    if requested['cameraMustBeStatic'] and not camera_static:
        _refuse('Choose a static destination camera before adapting photography.', 'BLENDER_UNSUPPORTED_ACTION')
    render_visible, collections, pending = set(), set(), [bpy.context.scene.collection]
    while pending:
        collection = pending.pop()
        pointer = collection.as_pointer()
        if pointer in collections or collection.hide_render:
            continue
        collections.add(pointer)
        render_visible.update(o.as_pointer() for o in collection.objects)
        pending.extend(collection.children)
    named = {bpy.data.objects.get('db_light__'+i) for i in requested['lightIds']}
    if None in named or any(o.type == 'LIGHT' and not o.hide_render and o.as_pointer() in render_visible and o not in named for o in bpy.context.scene.objects):
        _refuse('The selected scene has missing or additional native lighting; isolate it before reuse.', 'BLENDER_UNSUPPORTED_ACTION')
    graph = bpy.context.evaluated_depsgraph_get()
    lights = []
    for light_id in requested['lightIds']:
        obj = bpy.data.objects['db_light__'+light_id]
        static_chain(obj)
        evaluated = obj.evaluated_get(graph)
        data = evaluated.data
        if obj.hide_render or obj.as_pointer() not in render_visible or not obj.visible_get(view_layer=bpy.context.view_layer):
            _refuse('Hidden or node-driven lighting cannot be represented by this reuse plan.', 'BLENDER_UNSUPPORTED_ACTION')
        # Blender 5.x enables the default light node tree. It is representable
        # only while the emission remains the identity multiplier of the light
        # datablock's energy/color; arbitrary shader lighting is not copied.
        if data.use_nodes:
            tree = data.node_tree
            emission = next((n for n in tree.nodes if n.bl_idname == 'ShaderNodeEmission'), None) if tree else None
            output = next((n for n in tree.nodes if n.bl_idname == 'ShaderNodeOutputLight'), None) if tree else None
            if (tree is None or _active_animation(tree) or len(tree.nodes) != 2 or len(tree.links) != 1 or
                    emission is None or output is None or
                    any(abs(float(v)-1) > 1e-8 for v in emission.inputs['Color'].default_value) or
                    abs(float(emission.inputs['Strength'].default_value)-1) > 1e-8 or
                    emission.inputs.get('Weight') is not None and abs(float(emission.inputs['Weight'].default_value)) > 1e-8 or
                    tree.links[0].from_node != emission or tree.links[0].to_node != output or
                    tree.links[0].from_socket.name != 'Emission' or tree.links[0].to_socket.name != 'Surface'):
                _refuse('Custom or animated light emission cannot be represented by this reuse plan.', 'BLENDER_UNSUPPORTED_ACTION')
        matrix = evaluated.matrix_world.copy()
        basis = matrix.normalized()
        if (basis.to_3x3().determinant() <= 0 or
                any(abs(basis.col[a].to_3d().dot(basis.col[b].to_3d())) > 1e-6 for a in range(3) for b in range(a+1, 3))):
            _refuse('Sheared or mirrored light transforms are unsupported.', 'BLENDER_UNSUPPORTED_ACTION')
        position, rotation, scale = matrix.decompose()
        light = {'id': light_id, 'type': data.type.lower(), 'energy': float(data.energy),
                 'color': list(data.color), 'transform': {'location': list(position),
                 'rotationEuler': list(rotation.to_euler('XYZ')), 'scale': list(scale)}}
        if data.type == 'AREA':
            if data.shape != 'SQUARE':
                _refuse('Only the supported square-area light definition can be reused.', 'BLENDER_UNSUPPORTED_ACTION')
            light['size'] = float(data.size)
        elif data.type in ('POINT', 'SPOT'):
            light['size'] = float(data.shadow_soft_size)
            if data.type == 'SPOT':
                light.update(spotSize=float(data.spot_size), spotBlend=float(data.spot_blend))
        elif data.type == 'SUN':
            light['angle'] = float(data.angle)
        else:
            _refuse('Unsupported native light type.', 'BLENDER_UNSUPPORTED_ACTION')
        lights.append(light)
    return {'schemaVersion': 'deepblend.photography-snapshot/v1', 'staticGeometry': True,
            'staticLights': True, 'cameraStatic': camera_static,
            'cameraRotationEuler': list(camera.evaluated_get(graph).matrix_world.normalized().to_euler('XYZ')), 'lights': lights}


def inspect_camera_fit(request, options):
    """Read-only proposal or independent candidate verification in a private batch."""
    import bpy
    from mathutils import Vector
    payload = request.get('payload')
    required = {'entityIds', 'assetInstanceIds', 'frame', 'cameraId', 'fittedCameraId', 'margin', 'checkpointSha256'}
    baseline_keys = {'baselineCheckpointPath', 'baselineCheckpointSha256'}
    photography_keys = {'photography'} if isinstance(payload, dict) and 'photography' in payload else set()
    candidate = isinstance(payload, dict) and bool(baseline_keys & payload.keys())
    if (not isinstance(payload, dict) or set(payload) != required | photography_keys | (baseline_keys if candidate else set()) or
            not isinstance(payload.get('entityIds'), list) or not 1 <= len(payload['entityIds']) <= (128 if photography_keys else 64) or
            len(set(payload['entityIds'])) != len(payload['entityIds']) or
            not isinstance(payload.get('assetInstanceIds'), list) or len(set(payload['assetInstanceIds'])) != len(payload['assetInstanceIds']) or
            not set(payload['assetInstanceIds']) <= set(payload['entityIds']) or
            any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,127}', x)
                for x in [*payload['entityIds'], payload.get('cameraId'), payload.get('fittedCameraId')]) or
            payload['cameraId'] == payload['fittedCameraId'] or
            type(payload.get('frame')) is not int or not 0 <= payload['frame'] <= 1_000_000 or
            type(payload.get('margin')) not in (int, float) or not math.isfinite(payload['margin']) or not 0 <= payload['margin'] <= .25 or
            not isinstance(payload.get('checkpointSha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', payload['checkpointSha256']) or
            candidate and (photography_keys or not isinstance(payload.get('baselineCheckpointSha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', payload['baselineCheckpointSha256']))):
        _refuse('Expected one bounded frame, camera, distinct new camera and complete selection.', 'SCENE_SPEC_INVALID')
    path = options.get('blend')
    measured = _capture(path, payload['checkpointSha256'], payload, payload['fittedCameraId'] if candidate else payload['cameraId'])
    report = {'schemaVersion': VERSION, **{k: payload[k] for k in required},
              'checkpointUnchanged': True, 'blenderVersion': bpy.app.version_string,
              'members': [{k: v for k, v in member.items() if k != 'hierarchy'} for member in measured['members']],
              'view': measured['view'], 'camera': {'id': payload['fittedCameraId'] if candidate else payload['cameraId'],
                  **measured['settings'], 'matrixWorld': [list(row) for row in measured['matrix']],
                  'focusDistance': measured['focusDistance'], 'focusObject': measured['focusObject']}}
    if candidate:
        baseline = _capture(payload['baselineCheckpointPath'], payload['baselineCheckpointSha256'], payload, payload['cameraId'])
        if not all(m['projection']['containedInFrame'] and m['projection']['containedInClip'] for m in measured['members']):
            _refuse('The compiled candidate does not contain the complete selection.')
        if len(baseline['parts']) != len(measured['parts']):
            _refuse('The candidate changed selected mesh ownership.')
        max_error = 0.0
        for a, b in zip(baseline['parts'], measured['parts']):
            if a['name'] != b['name'] or a['topology'] != b['topology'] or len(a['vertices']) != len(b['vertices']):
                _refuse('The candidate changed selected geometry topology.')
            for p, q in zip(a['vertices'], b['vertices']):
                max_error = max(max_error, math.dist(p, q))
        original_states = dict(measured['states'])
        new_state = original_states.pop('db_camera__'+payload['fittedCameraId'], None)
        if (max_error > TOLERANCE or new_state is None or not _near_tree(original_states, baseline['states']) or
                not _near_tree(measured['view'], baseline['view']) or
                not _near_tree(measured['settings'], baseline['settings']) or
                any(abs(measured['matrix'][i][j]-baseline['matrix'][i][j]) > 1e-6 for i in range(3) for j in range(3))):
            _refuse('The candidate changed original geometry, photography or viewing direction.')
        report['baselineVerification'] = {'checkpointSha256': payload['baselineCheckpointSha256'], 'checkpointUnchanged': True,
            'selectedGeometryUnchanged': True, 'originalObjectsUnchanged': True, 'opticsAndRotationPreserved': True,
            'maxVertexErrorMeters': max_error, 'toleranceMeters': TOLERANCE,
            'originalObjectCount': len(baseline['states'])}
    else:
        if 'db_camera__'+payload['fittedCameraId'] in measured['states']:
            _refuse('The new camera ID is already in use.', 'SCENE_SPEC_INVALID')
        try:
            fitted = fit_perspective_points([list(measured['inverse'] @ Vector(p)) for p in measured['world']],
                                            measured['limits'], measured['settings']['clipping'], payload['margin'])
        except ValueError as exc:
            _refuse(str(exc))
        camera = {'id': payload['fittedCameraId'], 'role': 'detail', **measured['settings'],
                  'transform': {'location': list(measured['matrix'] @ Vector(fitted['origin'])),
                                'rotationEuler': list(measured['matrix'].to_euler('XYZ')), 'scale': [1, 1, 1]}}
        if 'fStop' in camera:
            camera['focusDistance'] = fitted['distanceMeters']
        report['proposal'] = camera
    if photography_keys:
        if candidate:
            _refuse('Photography sampling requires the saved source, not a fitted candidate.', 'SCENE_SPEC_INVALID')
        report['photography'] = _photography_snapshot(payload)
    _hash_file(path, payload['checkpointSha256'])
    return report, [], []
