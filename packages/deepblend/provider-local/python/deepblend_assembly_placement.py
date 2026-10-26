"""Read-only whole-assembly pose/settle measurement and complete candidate proof.

The public Host owns recipe provenance and complete membership. This native layer
measures the exact supplied union, then independently reopens both pinned files
and checks every evaluated member against one rigid upright world transform.
"""
import math
import re

from deepblend_util import ActionError
from deepblend_surface_placement import (
    _capture_checkpoint, _verified_checkpoint, _unsupported, _finite_number, _active_animation,
    solve_surface_placement, SurfacePlacementError, MAX_MESH_OBJECTS, MAX_VERTICES,
    MAX_TRIANGLES, MAX_HIERARCHY_OBJECTS, TRANSLATION_TOLERANCE_METERS,
)

BASIS_TOLERANCE = 1e-6
UV_TOLERANCE = 1e-6
IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def _fail(message):
    raise ActionError('SCENE_VALIDATION_FAILED', message)


def _matrix_product(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _point(matrix, point):
    return tuple(sum(matrix[i][j] * point[j] for j in range(3)) + matrix[i][3] for i in range(3))


def _valid_pose(pose):
    return (isinstance(pose, dict) and set(pose) == {'translationMm', 'yawDegrees', 'pivotMm'}
            and all(isinstance(pose[key], list) and len(pose[key]) == 3
                    and all(_finite_number(value) and abs(value) <= 1_000_000 for value in pose[key])
                    for key in ('translationMm', 'pivotMm'))
            and _finite_number(pose['yawDegrees']) and abs(pose['yawDegrees']) <= 360)


def _pose_matrix(pose):
    angle = pose['yawDegrees'] * math.pi / 180
    c, s = math.cos(angle), math.sin(angle)
    x, y = (value / 1000 for value in pose['pivotMm'][:2])
    dx, dy, dz = (value / 1000 for value in pose['translationMm'])
    return [[c, -s, 0, x-c*x+s*y+dx], [s, c, 0, y-s*x-c*y+dy],
            [0, 0, 1, dz], [0, 0, 0, 1]]


def _upright_matrix(matrix):
    if (not isinstance(matrix, list) or len(matrix) != 4
            or any(not isinstance(row, list) or len(row) != 4
                   or any(not _finite_number(value) or abs(value) > 1e6 for value in row) for row in matrix)):
        return False
    near = lambda a, b: abs(a-b) <= 1e-9
    return (all(near(matrix[3][i], value) for i, value in enumerate((0, 0, 0, 1)))
            and all(near(matrix[2][i], value) for i, value in enumerate((0, 0, 1)))
            and near(matrix[0][2], 0) and near(matrix[1][2], 0)
            and near(matrix[0][0], matrix[1][1]) and near(matrix[0][1], -matrix[1][0])
            and near(matrix[0][0]**2+matrix[1][0]**2, 1))


def _cycle(values):
    values = tuple(values)
    return min(values[i:] + values[:i] for i in range(len(values)))


def _socket_value(value):
    if isinstance(value, (str, bool, int, float)):
        return value
    if hasattr(value, '__len__') and not hasattr(value, 'bl_rna'):
        return tuple(value)
    if value is None:
        return None
    return (getattr(getattr(value, 'bl_rna', None), 'identifier', type(value).__name__), getattr(value, 'name', None))


def _material_facts(material):
    if material is None:
        return None
    tree = material.node_tree
    if _active_animation(material) or _active_animation(tree):
        _unsupported('animated-assembly-material', 'Complete assembly placement requires static materials.')
    nodes = []
    for node in tree.nodes if tree else []:
        properties = tuple((key, getattr(node, key)) for key in ('operation', 'blend_type', 'noise_dimensions',
            'normalize', 'noise_type', 'distribution', 'subsurface_method', 'gradient_type', 'voronoi_dimensions',
            'feature', 'distance', 'interpolation', 'extension', 'projection', 'vector_type', 'convert_from', 'convert_to')
            if hasattr(node, key))
        nodes.append((node.name, node.bl_idname, properties,
                      tuple((socket.identifier, _socket_value(socket.default_value)) for socket in node.inputs
                            if hasattr(socket, 'default_value'))))
    links = sorted((link.from_node.name, link.from_socket.identifier, link.to_node.name, link.to_socket.identifier)
                   for link in tree.links) if tree else []
    return (material.name, tuple(material.diffuse_color), bool(material.use_nodes), sorted(nodes), links)


def _capture(path, expected, frame, member_ids, support_id):
    """Reuse the static, visibility, source hash and cross-object checks of v1."""
    import bpy
    captures = _capture_checkpoint(path, expected, frame, member_ids, support_id)
    graph = bpy.context.evaluated_depsgraph_get()
    for capture in captures:
        for part in capture['parts']:
            obj = bpy.data.objects[part['identity'][0]]
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            try:
                # Polygon order and cyclic start are not identity. Preserve the
                # complete oriented faces, per-face material and loop UV data.
                faces = []
                for face in mesh.polygons:
                    corners = []
                    for loop_index in face.loop_indices:
                        corners.append((mesh.loops[loop_index].vertex_index,
                                        tuple(tuple(layer.uv[loop_index].vector) for layer in mesh.uv_layers)))
                    faces.append((_cycle(corners), face.material_index, bool(face.use_smooth)))
                part['appearance'] = (tuple(layer.name for layer in mesh.uv_layers), sorted(faces),
                                      tuple(_material_facts(slot.material) for slot in obj.material_slots))
            finally:
                evaluated.to_mesh_clear()
    total_meshes = sum(item['metadata']['meshObjectCount'] for item in captures[:-1])
    total_vertices = sum(item['metadata']['vertexCount'] for item in captures[:-1])
    total_triangles = sum(item['metadata']['triangleCount'] for item in captures[:-1])
    if (total_meshes > MAX_MESH_OBJECTS or total_vertices > MAX_VERTICES or total_triangles > MAX_TRIANGLES
            or sum(len(item['hierarchyIdentity']) for item in captures[:-1]) > MAX_HIERARCHY_OBJECTS):
        _unsupported('geometry-budget-exceeded', 'The complete subject union exceeds the bounded native geometry budget.')
    _verified_checkpoint(path, expected)
    return captures


def _transformed(capture, matrix):
    triangles = [tuple(_point(matrix, point) for point in triangle) for triangle in capture['triangles']]
    parts = [{**part, 'vertices': [_point(matrix, point) for point in part['vertices']]} for part in capture['parts']]
    points = [point for part in parts for point in part['vertices']]
    metadata = {**capture['metadata'], 'rootWorldMatrix': _matrix_product(matrix, capture['metadata']['rootWorldMatrix']),
                'worldBoundsMeters': {'min': [min(point[a] for point in points) for a in range(3)],
                                     'max': [max(point[a] for point in points) for a in range(3)]}}
    return {**capture, 'parts': parts, 'triangles': triangles, 'metadata': metadata}


def _compare_appearance(old, new, label):
    if old[0] != new[0] or old[2] != new[2] or len(old[1]) != len(new[1]):
        _fail(label + ' native UV layers, materials or mesh faces changed.')
    maximum_uv_error = 0.0
    for a, b in zip(old[1], new[1]):
        if a[1:] != b[1:] or len(a[0]) != len(b[0]):
            _fail(label + ' native face identity, material indices or smooth flags changed.')
        for ac, bc in zip(a[0], b[0]):
            if ac[0] != bc[0] or len(ac[1]) != len(bc[1]):
                _fail(label + ' native oriented topology or loop UV identity changed.')
            for auv, buv in zip(ac[1], bc[1]):
                maximum_uv_error = max(maximum_uv_error, max(abs(a-b) for a, b in zip(auv, buv)))
    if maximum_uv_error > UV_TOLERANCE:
        _fail(label + ' evaluated UV coordinates changed beyond float32 reconstruction tolerance.')
    return maximum_uv_error


def _compare_rigid(baseline, current, matrix, label):
    if baseline['hierarchyIdentity'] != current['hierarchyIdentity'] or len(baseline['parts']) != len(current['parts']):
        _fail(label + ' hierarchy identity changed.')
    maximum, maximum_uv_error = 0.0, 0.0
    for old, new in zip(baseline['parts'], current['parts']):
        if old['identity'] != new['identity'] or len(old['vertices']) != len(new['vertices']):
            _fail(label + ' mesh topology or identity changed.')
        maximum_uv_error = max(maximum_uv_error, _compare_appearance(old['appearance'], new['appearance'], label))
        for before, after in zip(old['vertices'], new['vertices']):
            maximum = max(maximum, math.dist(_point(matrix, before), after))
    expected = _matrix_product(matrix, baseline['metadata']['rootWorldMatrix'])
    actual = current['metadata']['rootWorldMatrix']
    position_error = max(abs(expected[i][3]-actual[i][3]) for i in range(3))
    basis_error = max(abs(expected[i][j]-actual[i][j]) for i in range(4) for j in range(4) if j != 3)
    if maximum > TRANSLATION_TOLERANCE_METERS or position_error > TRANSLATION_TOLERANCE_METERS or basis_error > BASIS_TOLERANCE:
        _fail(label + ' did not follow the complete rigid world transform.')
    return {'rigidTransform': True, 'maxVertexErrorMeters': maximum,
            'maxRootPositionErrorMeters': position_error, 'maxRootBasisError': basis_error, 'maxUvError': maximum_uv_error}


def inspect_assembly_placement(request, options):
    import bpy
    payload = request.get('payload')
    allowed = {'scope', 'subjectEntityId', 'memberEntityIds', 'supportEntityId', 'frame', 'clearanceMm', 'pose',
               'checkpointSha256', 'baselineCheckpointPath', 'baselineCheckpointSha256', 'expectedWorldMatrixMeters'}
    valid_id = lambda value: isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,127}', value) is not None
    valid_hash = lambda value: isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None
    if not isinstance(payload, dict) or set(payload) - allowed or payload.get('scope') != 'recipe-assembly':
        _fail('Unsupported complete assembly measurement payload.')
    ids, subject, support = payload.get('memberEntityIds'), payload.get('subjectEntityId'), payload.get('supportEntityId')
    frame, expected, pose, clearance = payload.get('frame'), payload.get('checkpointSha256'), payload.get('pose'), payload.get('clearanceMm', 0)
    if (not isinstance(ids, list) or not 1 <= len(ids) <= MAX_MESH_OBJECTS or not all(valid_id(value) for value in ids)
            or ids != sorted(set(ids)) or not valid_id(subject) or subject not in ids or not valid_id(support) or support in ids
            or type(frame) is not int or not 0 <= frame <= 1_000_000 or not valid_hash(expected)
            or not _valid_pose(pose) or not _finite_number(clearance) or not 0 <= clearance <= 1000):
        _fail('Complete assembly selection, pose, frame or checkpoint binding is invalid.')
    baseline_fields = {'baselineCheckpointPath', 'baselineCheckpointSha256', 'expectedWorldMatrixMeters'}
    has_baseline = bool(baseline_fields & set(payload))
    baseline = None
    if has_baseline:
        if (not baseline_fields <= set(payload) or not valid_hash(payload['baselineCheckpointSha256'])
                or not isinstance(payload['baselineCheckpointPath'], str) or not _upright_matrix(payload['expectedWorldMatrixMeters'])):
            _fail('Complete candidate verification requires a pinned baseline and a rigid upright matrix.')
        baseline = _capture(payload['baselineCheckpointPath'], payload['baselineCheckpointSha256'], frame, ids, support)
    checkpoint = options.get('blend')
    current = _capture(checkpoint, expected, frame, ids, support)
    verification = None
    if has_baseline:
        members = [{'entityId': entity_id, **_compare_rigid(baseline[index], current[index], payload['expectedWorldMatrixMeters'], entity_id)}
                   for index, entity_id in enumerate(ids)]
        support_proof = _compare_rigid(baseline[-1], current[-1], IDENTITY, support)
        _verified_checkpoint(payload['baselineCheckpointPath'], payload['baselineCheckpointSha256'])
        verification = {'checkpointSha256': payload['baselineCheckpointSha256'], 'checkpointUnchanged': True,
                        'worldMatrixMeters': payload['expectedWorldMatrixMeters'], 'members': members,
                        'supportUnchanged': True, 'supportMaxErrorMeters': support_proof['maxVertexErrorMeters'],
                        'toleranceMeters': TRANSLATION_TOLERANCE_METERS, 'basisTolerance': BASIS_TOLERANCE, 'uvTolerance': UV_TOLERANCE}
    matrix = _pose_matrix(pose)
    transformed = [_transformed(item, matrix) for item in current[:-1]]
    triangles = [triangle for item in transformed for triangle in item['triangles']]
    support_capture = current[-1]
    try:
        solution = solve_surface_placement(triangles, support_capture['triangles'], clearance / 1000)
    except SurfacePlacementError as exc:
        _unsupported(exc.reason, str(exc))
    result_matrix = [list(row) for row in matrix]; result_matrix[2][3] += solution['deltaZ']
    members = [{'entityId': entity_id, 'geometry': transformed[index]['metadata']} for index, entity_id in enumerate(ids)]
    offset, contact_member = 0, None
    for member in members:
        count = member['geometry']['triangleCount']
        if offset <= solution['subjectTriangleIndex'] < offset + count:
            contact_member = member['entityId']
        offset += count
    union = {key: sum(member['geometry'][key] for member in members) for key in ('meshObjectCount', 'vertexCount', 'triangleCount')}
    union['rootWorldMatrix'] = next(member['geometry']['rootWorldMatrix'] for member in members if member['entityId'] == subject)
    union['worldBoundsMeters'] = {'min': [min(member['geometry']['worldBoundsMeters']['min'][a] for member in members) for a in range(3)],
                                 'max': [max(member['geometry']['worldBoundsMeters']['max'][a] for member in members) for a in range(3)]}
    report = {'schemaVersion': 'deepblend.assembly-placement/v1', 'axis': 'world-z', 'checkpointSha256': expected,
              'checkpointUnchanged': True, 'frame': frame, 'blenderVersion': bpy.app.version_string,
              'subjectEntityId': subject, 'memberEntityIds': ids, 'members': members, 'supportEntityId': support,
              'pose': pose, 'poseMatrixMeters': matrix, 'resultWorldMatrixMeters': result_matrix,
              'clearanceMm': clearance, 'translationMeters': [0, 0, solution['deltaZ']],
              'subjectContactEntityId': contact_member, 'subjectContactMeters': solution['subjectContactMeters'],
              'supportContactMeters': solution['supportContactMeters'], 'placedSubjectContactMeters': solution['placedSubjectContactMeters'],
              'subjectTriangleIndex': solution['subjectTriangleIndex'], 'supportTriangleIndex': solution['supportTriangleIndex'],
              'statistics': {'candidatePairs': solution['statistics']['candidatePairs']},
              'subject': union, 'support': support_capture['metadata']}
    if verification is not None:
        report['baselineVerification'] = verification
    _verified_checkpoint(checkpoint, expected)
    return report, [], []
