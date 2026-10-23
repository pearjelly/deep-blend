"""Independent saved lamp measurements. Usage: CHECKPOINT OUTPUT [SETTINGS_JSON].

Expected world matrices come from the fixture, never from the measured anchor.
Its inverse is used only for the separate relative geometry comparison. No
checkpoint is saved, including during the in-memory negative controls.
"""
import bpy, bmesh, json, sys, hashlib, math
from pathlib import Path
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from bpy_extras.object_utils import world_to_camera_view


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rows(matrix):
    return [[float(value) for value in row] for row in matrix]


def difference(a, b):
    return max((abs(x-y) for ra, rb in zip(a, b) for x, y in zip(ra, rb)), default=0)


def oriented_topology(polygons):
    # Blender's UV sphere construction can change polygon order between processes.
    # Preserve every oriented face and duplicate; only list order/cyclic start vary.
    faces = []
    for polygon in polygons:
        vertices = list(polygon.vertices)
        start = vertices.index(min(vertices))
        faces.append(vertices[start:]+vertices[:start])
    return sorted(faces)


def validate_oracle(settings, ids):
    if 'expectedWorldMatrices' not in settings:
        return
    expected = settings['expectedWorldMatrices']
    if not isinstance(expected, dict) or set(expected) != set(ids):
        raise ValueError('Expected world matrix oracle must cover exactly the 23 lamp parts')
    for entity, matrix in expected.items():
        if (not isinstance(matrix, list) or len(matrix) != 4
                or any(not isinstance(row, list) or len(row) != 4 for row in matrix)
                or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                       for row in matrix for value in row)):
            raise ValueError('Expected a finite 4x4 world matrix for '+entity)


def camera_facts(scene, camera, graph):
    evaluated = camera.evaluated_get(graph)
    data, dof = evaluated.data, evaluated.data.dof
    focus = dof.focus_object
    return {
        'frame': int(scene.frame_current), 'matrixWorld': rows(evaluated.matrix_world),
        'type': data.type, 'lens': float(data.lens), 'orthoScale': float(data.ortho_scale),
        'sensorWidth': float(data.sensor_width), 'sensorHeight': float(data.sensor_height),
        'sensorFit': data.sensor_fit, 'shift': [float(data.shift_x), float(data.shift_y)],
        'clip': [float(data.clip_start), float(data.clip_end)],
        'dof': {'enabled': bool(dof.use_dof), 'focusDistance': float(dof.focus_distance),
                'focusObject': None if focus is None else {
                    'name': focus.name, 'entityId': focus.get('deepblend_id'),
                    'matrixWorld': rows(focus.evaluated_get(graph).matrix_world)},
                'focusSubtarget': getattr(dof, 'focus_subtarget', '') or None,
                'apertureFstop': float(dof.aperture_fstop), 'apertureBlades': int(dof.aperture_blades),
                'apertureRotation': float(dof.aperture_rotation), 'apertureRatio': float(dof.aperture_ratio)}}


def material_facts(material):
    """Actual node inputs/links: preserving a material name alone cannot pass."""
    nodes = []
    for node in material.node_tree.nodes if material.use_nodes else []:
        inputs = []
        for socket in node.inputs:
            if not hasattr(socket, 'default_value'):
                continue
            value = socket.default_value
            if not isinstance(value, (bool, int, float, str)):
                try:
                    value = list(value)
                except TypeError:
                    continue
            inputs.append([socket.identifier, value])
        nodes.append({'name': node.name, 'type': node.bl_idname, 'inputs': inputs})
    links = sorted([link.from_node.name, link.from_socket.identifier,
                    link.to_node.name, link.to_socket.identifier]
                   for link in material.node_tree.links) if material.use_nodes else []
    return {'name': material.name, 'nodes': sorted(nodes, key=lambda item: item['name']), 'links': links}


def mutate_memory(control, settings):
    objects = [bpy.data.objects['db_entity__'+entity] for entity in settings['productEntityIds']]
    if control == 'common-translation':
        wrong = Matrix.Translation(Vector((.07, -.03, .02)))
        for obj in objects:
            obj.matrix_world = wrong @ obj.matrix_world
    elif control == 'common-scale':
        anchor = bpy.data.objects['db_entity__weighted-base'].matrix_world.translation.copy()
        wrong = Matrix.Translation(anchor) @ Matrix.Scale(1.01, 4) @ Matrix.Translation(-anchor)
        for obj in objects:
            obj.matrix_world = wrong @ obj.matrix_world
    elif control == 'compensated-negative-scale':
        obj = bpy.data.objects['db_entity__weighted-base']
        obj.rotation_euler.z += math.pi
        obj.scale = (-1, -1, 1)
    elif control == 'missing-unbound-bulb':
        bpy.data.objects.remove(bpy.data.objects['db_entity__opal-bulb'], do_unlink=True)
    elif control == 'liner-offset':
        axis = bpy.data.objects['db_entity__weighted-base'].matrix_world.to_3x3() @ Vector((.001, 0, 0))
        bpy.data.objects['db_entity__shade-enamel-lining'].location += axis
    elif control == 'world-x-only-return':
        previous = settings['previousExpectedWorldMatrices']
        for entity in settings['supportEntityIds']:
            p = Vector([previous[entity][axis][3] for axis in range(3)])
            bpy.data.objects['db_entity__'+entity].location = p + Vector((.011, 0, 0))
    elif control == 'camera-lens-change':
        bpy.context.scene.camera.data.lens += 1
    elif control == 'unrelated-far-object':
        bpy.ops.mesh.primitive_cube_add(size=.1, location=(100, 100, 100))
        bpy.context.object.name = 'db_entity__inspection-unrelated'
    else:
        raise ValueError('Unknown negative control '+str(control))
    bpy.context.view_layer.update()


def measure(path, settings, control=None):
    bpy.ops.wm.open_mainfile(filepath=str(path), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    if 'frame' in settings:
        scene.frame_set(settings['frame'])
    if settings.get('cameraId'):
        candidates = [obj for obj in scene.objects if obj.type == 'CAMERA'
                      and obj.get('deepblend_id') == settings['cameraId']]
        if len(candidates) != 1:
            raise RuntimeError('Expected exactly one requested native camera')
        scene.camera = candidates[0]
    bpy.context.view_layer.update()
    if control:
        mutate_memory(control, settings)
    graph = bpy.context.evaluated_depsgraph_get()
    all_ids = sorted(obj.name.removeprefix('db_entity__') for obj in bpy.data.objects
                     if obj.name.startswith('db_entity__'))
    ids = settings.get('productEntityIds', [entity for entity in all_ids if entity != 'studio-floor'])
    if len(ids) != len(set(ids)) or ('productEntityIds' in settings and len(ids) != 23):
        raise ValueError('The fixture must name exactly 23 distinct lamp parts')
    validate_oracle(settings, ids)
    missing = [entity for entity in ids if 'db_entity__'+entity not in bpy.data.objects]
    anchor = bpy.data.objects.get('db_entity__weighted-base')
    inverse = anchor.evaluated_get(graph).matrix_world.inverted() if anchor else Matrix.Identity(4)
    camera = scene.camera
    camera_inverse = camera.evaluated_get(graph).matrix_world.inverted() if camera else None
    parts, meshes, bvhs, projections, depths, materials, placement = {}, {}, {}, [], [], {}, []
    for entity in ids:
        obj = bpy.data.objects.get('db_entity__'+entity)
        if obj is None:
            continue
        evaluated = obj.evaluated_get(graph)
        matrix, rotation = evaluated.matrix_world.copy(), obj.rotation_euler.to_matrix()
        basis = matrix.to_3x3()
        expected = settings.get('expectedWorldMatrices', {}).get(entity)
        item = {'entityId': entity, 'positionErrorM': None, 'basisError': None, 'rotationError': None,
                'orthogonalityError': difference(rows(basis.transposed() @ basis), rows(Matrix.Identity(3))),
                'determinantError': abs(basis.determinant()-1),
                'scaleError': max(abs(float(v)-1) for v in obj.scale),
                'positiveScale': all(float(v) > 0 for v in obj.scale), 'rotationMode': obj.rotation_mode}
        if expected:
            item.update(positionErrorM=max(abs(matrix[axis][3]-expected[axis][3]) for axis in range(3)),
                        basisError=difference(rows(basis), [row[:3] for row in expected[:3]]),
                        rotationError=difference(rows(rotation), [row[:3] for row in expected[:3]]))
        placement.append(item)
        mesh = evaluated.to_mesh()
        if mesh is None:
            parts[entity] = {'nativeType': obj.type, 'error': 'no-evaluated-mesh'}
            continue
        bm = bmesh.new()
        try:
            object_points = [v.co.copy() for v in mesh.vertices]
            topology = oriented_topology(mesh.polygons)
            bm.from_mesh(mesh)
            bm.transform(matrix)
            bm.normal_update()
            points = [v.co.copy() for v in bm.verts]
            if not points:
                parts[entity] = {'nativeType': obj.type, 'error': 'empty-evaluated-mesh'}
                continue
            unseen, components = set(bm.verts), 0
            while unseen:
                components += 1
                pending = [unseen.pop()]
                while pending:
                    for edge in pending.pop().link_edges:
                        for vertex in edge.verts:
                            if vertex in unseen:
                                unseen.remove(vertex)
                                pending.append(vertex)
            bounds = [[min(v[i] for v in points) for i in range(3)],
                      [max(v[i] for v in points) for i in range(3)]]
            parts[entity] = {
                'nativeType': obj.type, 'vertices': len(bm.verts), 'faces': len(bm.faces),
                'components': components, 'boundaryEdges': sum(e.is_boundary for e in bm.edges),
                'nonManifoldEdges': sum(not e.is_manifold for e in bm.edges),
                'signedVolume': bm.calc_volume(signed=True),
                'finite': all(math.isfinite(x) for v in points for x in v),
                'worldBounds': bounds, 'dimensionsMm': [(bounds[1][i]-bounds[0][i])*1000 for i in range(3)],
                'matrixWorld': rows(matrix), 'rotationMatrix': rows(rotation), 'rotationMode': obj.rotation_mode,
                'scale': list(obj.scale), 'materialNames': [slot.material.name if slot.material else None for slot in obj.material_slots],
                'geometrySha256': hashlib.sha256(json.dumps({'vertices': [list(v) for v in points],
                    'faces': topology}, sort_keys=True).encode()).hexdigest()}
            for slot in obj.material_slots:
                if slot.material and slot.material.name not in materials:
                    materials[slot.material.name] = material_facts(slot.material)
            if entity == 'shade-shell':
                # evaluated mesh coordinates are relative to the shell's own axis.
                parts[entity]['outerDiameterMm'] = 2000*max(math.hypot(v.x, v.y) for v in object_points)
            if camera:
                projections.extend(world_to_camera_view(scene, camera, point) for point in points)
                depths.extend(-(camera_inverse @ point).z for point in points)
            # Keep world bounds/projection above. Only this BVH and later rays are lamp-local.
            bm.transform(inverse)
            bm.normal_update()
            meshes[entity] = {'points': [v.co.copy() for v in bm.verts], 'topology': topology}
            bvhs[entity] = BVHTree.FromBMesh(bm)
        finally:
            bm.free()
            evaluated.to_mesh_clear()

    radial, normal_samples = [], []
    for height in [.34, .37, .40]:
        hits = {}
        for entity in ['shade-shell', 'shade-enamel-lining']:
            found, origin, direction = [], Vector((-.2, 0, height)), Vector((1, 0, 0))
            if entity in bvhs:
                for unused in range(8):
                    location, normal, face, distance = bvhs[entity].ray_cast(origin, direction, .6)
                    if location is None:
                        break
                    found.append(list(location))
                    origin = location + direction*1e-7
            hits[entity] = found
        shell, liner = hits['shade-shell'], hits['shade-enamel-lining']
        radial.append({'lampHeightMm': height*1000, 'hits': hits,
                       'shellRadialThicknessMm': (shell[1][0]-shell[0][0])*1000 if len(shell) >= 2 else None,
                       'shellLinerRadialGapMm': (liner[0][0]-shell[1][0])*1000 if len(shell) >= 2 and liner else None})
        sample = {'outerHeightMm': height*1000, 'normalWallThicknessMm': None, 'normalShellLinerGapMm': None}
        if 'shade-shell' in bvhs and 'shade-enamel-lining' in bvhs:
            outer, normal, face, distance = bvhs['shade-shell'].ray_cast(Vector((-.2, 0, height)), Vector((1, 0, 0)), .5)
            if outer is not None:
                inward = -normal.normalized()
                inner, unused, unused2, unused3 = bvhs['shade-shell'].ray_cast(outer+inward*1e-7, inward, .05)
                if inner is not None:
                    liner, unused, unused2, unused3 = bvhs['shade-enamel-lining'].ray_cast(inner+inward*1e-7, inward, .01)
                    sample.update(normalWallThicknessMm=(inner-outer).length*1000,
                                  normalShellLinerGapMm=(liner-inner).length*1000 if liner is not None else None)
        normal_samples.append(sample)
    facts = {
        'blenderVersion': bpy.app.version_string, 'productEntityIds': ids, 'missingEntityIds': missing,
        'extraEntityIds': [entity for entity in all_ids if entity not in ids],
        'projectionEntityIds': [entity for entity in ids if entity in meshes], 'parts': parts,
        'placementMeasurements': placement, 'materialFacts': materials,
        'radialSamples': radial, 'normalWallSamples': normal_samples,
        'shadeOuterDiameterMm': parts.get('shade-shell', {}).get('outerDiameterMm'),
        'renderConfig': {'resolution': [scene.render.resolution_x, scene.render.resolution_y],
                         'percentage': scene.render.resolution_percentage, 'samples': scene.cycles.samples,
                         'frame': scene.frame_current, 'camera': camera.name if camera else None},
        'cameraFacts': camera_facts(scene, camera, graph) if camera else None,
        'projectedBounds': [[min(v[i] for v in projections) for i in range(3)],
                            [max(v[i] for v in projections) for i in range(3)]] if projections else None,
        'cameraDepthRange': [min(depths), max(depths)] if depths else None,
        'scope': 'Actual evaluated geometry; three lamp-local normal rays are not all-surface minimum thickness. Fullmesh comparisons require matching topology and preserved local edits.'}
    return facts, meshes


def compare_geometry(facts, meshes, reference, reference_meshes):
    comparisons = {}
    for entity in facts['productEntityIds']:
        actual, original = meshes.get(entity), reference_meshes.get(entity)
        item = {'verticesMatch': False, 'topologyMatches': False, 'maxLocalVertexErrorM': None}
        if actual is not None and original is not None:
            item['verticesMatch'] = len(actual['points']) == len(original['points'])
            item['topologyMatches'] = actual['topology'] == original['topology']
            if item['verticesMatch'] and item['topologyMatches']:
                errors = [(a-b).length for a, b in zip(actual['points'], original['points'])]
                worst = max(range(len(errors)), key=errors.__getitem__)
                item.update(maxLocalVertexErrorM=errors[worst], worstVertexIndex=worst,
                            actualLampPoint=list(actual['points'][worst]), referenceLampPoint=list(original['points'][worst]))
        comparisons[entity] = item
    facts['geometryComparison'] = comparisons
    facts['referenceNormalWallSamples'] = reference['normalWallSamples']


def validate(facts, settings):
    failures, tolerance = [], settings.get('tolerances')
    def fail(entity, prop, actual, expected, error=None):
        failures.append({'entityId': entity, 'property': prop, 'actual': actual, 'expected': expected, 'error': error})
    for entity in facts['missingEntityIds']:
        fail(entity, 'membership', 'missing', 'present')
    for entity, part in facts['parts'].items():
        if part.get('error') or not part.get('finite'):
            fail(entity, 'native-mesh', part.get('error', 'nonfinite'), 'finite nonempty evaluated mesh')
        for field in ['matrixWorld', 'rotationMatrix', 'scale']:
            values = part.get(field, [])
            flat = [x for row in values for x in row] if field != 'scale' else values
            if not all(math.isfinite(x) for x in flat):
                fail(entity, field, 'nonfinite', 'finite')
    for item in facts['placementMeasurements']:
        entity = item['entityId']
        if not item['positiveScale'] or item['rotationMode'] != 'XYZ':
            fail(entity, 'raw-transform', {'scale': facts['parts'].get(entity, {}).get('scale'),
                                         'rotationMode': item['rotationMode']}, 'positive unit scale and XYZ')
        if tolerance:
            for field, limit in [('positionErrorM', 'positionM'), ('basisError', 'basis'), ('rotationError', 'rotation'),
                                 ('orthogonalityError', 'basis'), ('determinantError', 'basis'), ('scaleError', 'scale')]:
                value = item[field]
                if value is not None and (not math.isfinite(value) or value > tolerance[limit]):
                    fail(entity, field, value, tolerance[limit], value)
    for entity, comparison in facts.get('geometryComparison', {}).items():
        if not comparison['verticesMatch'] or not comparison['topologyMatches']:
            fail(entity, 'geometry-topology', comparison, 'same corresponding evaluated vertices/faces')
        elif tolerance and comparison['maxLocalVertexErrorM'] > tolerance['geometryM']:
            fail(entity, 'local-geometry', comparison['maxLocalVertexErrorM'], tolerance['geometryM'], comparison['maxLocalVertexErrorM'])
    for sample in facts['normalWallSamples']:
        if sample['normalWallThicknessMm'] is None or sample['normalShellLinerGapMm'] is None:
            fail('shade-shell/shade-enamel-lining', 'normal-ray', sample, 'three actual wall and liner crossings')
    if settings.get('expectedCameraFacts') is not None and facts['cameraFacts'] != settings['expectedCameraFacts']:
        fail(None, 'fixed-camera', facts['cameraFacts'], settings['expectedCameraFacts'])
    facts['placementMismatches'] = [failure for failure in failures if failure['property'] not in
                                   ('local-geometry', 'geometry-topology', 'normal-ray', 'fixed-camera')]
    facts['validation'] = {'ok': not failures, 'failures': failures}


args = sys.argv[sys.argv.index('--')+1:]
if len(args) not in (2, 3):
    raise ValueError('Expected CHECKPOINT OUTPUT [SETTINGS_JSON]')
checkpoint, output = map(Path, args[:2])
settings = json.loads(Path(args[2]).read_text()) if len(args) == 3 else {}
source_hash = digest(checkpoint)
if settings.get('checkpointSha256') and settings['checkpointSha256'] != source_hash:
    raise RuntimeError('Checkpoint differs from the requested source hash')
facts, meshes = measure(checkpoint, settings)
reference, reference_meshes, reference_hash = None, None, None
if settings.get('referenceCheckpoint'):
    reference_path = Path(settings['referenceCheckpoint'])
    reference_hash = digest(reference_path)
    if settings.get('referenceSha256') != reference_hash:
        raise RuntimeError('Reference checkpoint differs from its fixed hash')
    reference_settings = {key: settings[key] for key in ['productEntityIds', 'frame', 'cameraId'] if key in settings}
    reference, reference_meshes = measure(reference_path, reference_settings)
    compare_geometry(facts, meshes, reference, reference_meshes)
    facts['referenceCheckpointSha256'] = reference_hash
validate(facts, settings)

if settings.get('negativeControls'):
    if not settings.get('tolerances') or reference is None:
        raise ValueError('Negative controls require frozen tolerances and a same-size reference')
    controls = []
    expected_failures = {
        'common-translation': {'positionErrorM'}, 'common-scale': {'basisError', 'scaleError', 'orthogonalityError'},
        'compensated-negative-scale': {'raw-transform', 'scaleError'},
        'missing-unbound-bulb': {'membership'}, 'liner-offset': {'positionErrorM', 'local-geometry'},
        'world-x-only-return': {'positionErrorM', 'local-geometry'}, 'camera-lens-change': {'fixed-camera'}}
    for control in [*expected_failures, 'unrelated-far-object']:
        measured, control_meshes = measure(checkpoint, settings, control)
        compare_geometry(measured, control_meshes, reference, reference_meshes)
        validate(measured, settings)
        properties = {item['property'] for item in measured['validation']['failures']}
        local_errors = [item['maxLocalVertexErrorM'] for item in measured['geometryComparison'].values()
                        if item['maxLocalVertexErrorM'] is not None]
        if control == 'unrelated-far-object':
            passed = measured['validation']['ok'] and measured['projectedBounds'] == facts['projectedBounds']
        else:
            passed = not measured['validation']['ok'] and expected_failures[control].issubset(properties)
        if control == 'common-translation':
            passed = passed and len(local_errors) == 23 and max(local_errors) <= settings['tolerances']['geometryM']
        controls.append({'name': control, 'passed': passed, 'failureProperties': sorted(properties),
                         'requiredFailureProperties': sorted(expected_failures.get(control, set())),
                         'maxLocalVertexErrorM': max(local_errors, default=None),
                         'failures': measured['validation']['failures']})
    facts['negativeControls'] = controls
    facts['negativeControlsPassed'] = all(control['passed'] for control in controls)

facts.update(checkpointSha256=source_hash, checkpointUnchanged=digest(checkpoint) == source_hash)
if reference_hash:
    facts['referenceCheckpointUnchanged'] = digest(settings['referenceCheckpoint']) == reference_hash
output.write_text(json.dumps(facts, indent=2, allow_nan=False)+'\n')
print('LAMP_NATIVE_MEASURED', len(facts['parts']), 'valid='+str(facts['validation']['ok']))
