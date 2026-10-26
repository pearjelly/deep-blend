"""Read-only world-Z first-contact placement over complete evaluated triangles.

The geometry core is independent of Blender. It maximizes support_z - subject_z
at a common XY point. This is descent from above, not a stability or containment
claim. Degenerate XY projections are part of the surface and are never dropped.
"""
import itertools
import math
import os
import re
from fractions import Fraction

from deepblend_util import ActionError

MAX_VERTICES = 2_000_000
MAX_TRIANGLES = 2_000_000
MAX_MESH_OBJECTS = 128
MAX_HIERARCHY_OBJECTS = 4096
MAX_CANDIDATE_PAIRS = 1_000_000
TRANSLATION_TOLERANCE_METERS = 0.00002


class SurfacePlacementError(ValueError):
    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def _failure(reason, message):
    raise SurfacePlacementError(reason, message)


def _finite_number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _bounds(triangle):
    return (min(p[0] for p in triangle), min(p[1] for p in triangle),
            max(p[0] for p in triangle), max(p[1] for p in triangle))


def _overlap(a, b):
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def _upper_z_difference(support_max_z, subject_min_z):
    # One upward ULP encloses correctly rounded binary-float subtraction. Very
    # large integer inputs need exact subtraction before conversion, since a
    # mixed int/float subtraction could first discard integer low bits.
    if any(type(value) is int and abs(value) > 2 ** 53 for value in (support_max_z, subject_min_z)):
        exact = Fraction(support_max_z) - Fraction(subject_min_z)
        try:
            difference = float(exact)
        except OverflowError:
            return math.inf
    else:
        difference = support_max_z - subject_min_z
    return math.nextafter(difference, math.inf)


class _XYTree:
    """Conservative 2D AABB tree; leaf tests also include boundary contact."""
    __slots__ = ('bounds', 'left', 'right', 'indices', 'maximum_z')

    def __init__(self, bounds, indices, maximum_z=None):
        self.bounds = (min(bounds[i][0] for i in indices), min(bounds[i][1] for i in indices),
                       max(bounds[i][2] for i in indices), max(bounds[i][3] for i in indices))
        self.maximum_z = max(maximum_z[i] for i in indices) if maximum_z is not None else math.inf
        self.left = self.right = None
        self.indices = None
        if len(indices) <= 8:
            if maximum_z is not None:
                indices.sort(key=lambda i: maximum_z[i], reverse=True)
            self.indices = indices
            return
        axis = int(self.bounds[3] - self.bounds[1] > self.bounds[2] - self.bounds[0])
        indices.sort(key=lambda i: bounds[i][axis] / 2 + bounds[i][axis + 2] / 2)
        middle = len(indices) // 2
        self.left = _XYTree(bounds, indices[:middle], maximum_z)
        self.right = _XYTree(bounds, indices[middle:], maximum_z)

    def candidates(self, subject_bounds, support_bounds, subject_min_z=None, best_lower=None, support_max_z=None):
        pending = [self]
        while pending:
            node = pending.pop()
            if not _overlap(subject_bounds, node.bounds):
                continue
            lower = best_lower() if best_lower is not None else None
            if lower is not None and _upper_z_difference(node.maximum_z, subject_min_z) <= lower:
                continue
            if node.indices is not None:
                for i in node.indices:
                    lower = best_lower() if best_lower is not None else None
                    if (lower is not None and support_max_z is not None and
                            _upper_z_difference(support_max_z[i], subject_min_z) <= lower):
                        continue
                    if _overlap(subject_bounds, support_bounds[i]):
                        yield i
            else:
                first, second = node.left, node.right
                if second.maximum_z > first.maximum_z:
                    first, second = second, first
                pending.append(second)
                pending.append(first)


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _height(triangle, point, area):
    a = _cross(triangle[1], triangle[2], point) / area
    b = _cross(triangle[2], triangle[0], point) / area
    c = 1.0 - a - b
    return math.fsum((triangle[0][2], b * (triangle[1][2] - triangle[0][2]),
                      c * (triangle[2][2] - triangle[0][2])))


def _clip_pair(subject, support):
    """Floating convex clipping; None delegates ambiguous/vertical cases to LP.

    An empty tuple is an established empty intersection. Normalization keeps
    predicates independent of scene units. Near-zero predicates go through the
    exact rational fallback, including shared boundaries and skinny triangles.
    """
    origin_x = min(p[0] for p in subject + support)
    origin_y = min(p[1] for p in subject + support)
    span = max(max(p[0] for p in subject + support) - origin_x,
               max(p[1] for p in subject + support) - origin_y)
    if not math.isfinite(span) or span == 0:
        return None
    a = tuple(((p[0] - origin_x) / span, (p[1] - origin_y) / span, p[2]) for p in subject)
    b = tuple(((p[0] - origin_x) / span, (p[1] - origin_y) / span, p[2]) for p in support)
    area_a, area_b = _cross(*a), _cross(*b)
    height_range = max(1.0, *(abs(p[2] - a[0][2]) for p in a),
                       *(abs(p[2] - b[0][2]) for p in b))
    # Conservative interpolation-error guard: ill-conditioned projections with
    # substantial Z variation use exact arithmetic instead of a dubious height.
    if min(abs(area_a), abs(area_b)) < max(1e-10, 3e-6 * height_range):
        return None
    sign = 1 if area_b > 0 else -1
    polygon = [(p[0], p[1]) for p in a]
    for i in range(3):
        if not polygon:
            return ()
        edge_a, edge_b = b[i], b[(i + 1) % 3]
        output = []
        previous = polygon[-1]
        previous_distance = sign * _cross(edge_a, edge_b, previous)
        if abs(previous_distance) < 1e-13:
            return None
        for current in polygon:
            current_distance = sign * _cross(edge_a, edge_b, current)
            if abs(current_distance) < 1e-13:
                return None
            if (current_distance > 0) != (previous_distance > 0):
                ratio = previous_distance / (previous_distance - current_distance)
                output.append((previous[0] + ratio * (current[0] - previous[0]),
                               previous[1] + ratio * (current[1] - previous[1])))
            if current_distance > 0:
                output.append(current)
            previous, previous_distance = current, current_distance
        polygon = output
    best = None
    for point in polygon:
        subject_z, support_z = _height(a, point, area_a), _height(b, point, area_b)
        difference = support_z - subject_z
        if not math.isfinite(difference):
            return None
        if best is None or difference > best[0]:
            xy = [origin_x + point[0] * span, origin_y + point[1] * span]
            best = (difference, xy + [subject_z], xy + [support_z])
    return best if best is not None else ()


def _solve_square(matrix, right):
    """Small exact linear system. None denotes a singular choice of basis."""
    n = len(right)
    rows = [list(row) + [value] for row, value in zip(matrix, right)]
    for column in range(n):
        pivot = next((i for i in range(column, n) if rows[i][column]), None)
        if pivot is None:
            return None
        rows[column], rows[pivot] = rows[pivot], rows[column]
        divisor = rows[column][column]
        rows[column] = [value / divisor for value in rows[column]]
        for row in range(n):
            if row != column and rows[row][column]:
                multiplier = rows[row][column]
                rows[row] = [x - multiplier * y for x, y in zip(rows[row], rows[column])]
    return [rows[i][-1] for i in range(n)]


def _independent_constraints(matrix, right):
    """Exact row reduction also proves infeasibility of inconsistent equalities."""
    reduced = []
    selected = []
    for source_index, (row, rhs) in enumerate(zip(matrix, right)):
        current = list(row) + [rhs]
        for pivot, basis in reduced:
            if current[pivot]:
                coefficient = current[pivot]
                current = [a - coefficient * b for a, b in zip(current, basis)]
        pivot = next((i for i, value in enumerate(current[:-1]) if value), None)
        if pivot is None:
            if current[-1]:
                return None
            continue
        divisor = current[pivot]
        current = [value / divisor for value in current]
        reduced.append((pivot, current))
        selected.append(source_index)
    return selected


def _exact_pair(subject, support, return_exact=False):
    """Barycentric LP: six nonnegative weights, at most four equalities.

    A bounded nonempty polytope has an optimal basic feasible solution. Selecting
    independent rows and enumerating bases covers point, line and area projected
    intersections alike, with at most C(6,3) = 20 square systems. Fractions retain
    the exact input float values, so a near miss is not silently turned into an
    overlap by an epsilon and a vertical face is not discarded.
    """
    a = tuple(tuple(Fraction(x) for x in p) for p in subject)
    b = tuple(tuple(Fraction(x) for x in p) for p in support)
    zero, one = Fraction(0), Fraction(1)
    rows = [[one, one, one, zero, zero, zero], [zero, zero, zero, one, one, one],
            [p[0] for p in a] + [-p[0] for p in b],
            [p[1] for p in a] + [-p[1] for p in b]]
    rhs = [one, one, zero, zero]
    selected = _independent_constraints(rows, rhs)
    if selected is None:
        return ()
    independent = [rows[i] for i in selected]
    right = [rhs[i] for i in selected]
    objective = [-p[2] for p in a] + [p[2] for p in b]
    best = None
    for columns in itertools.combinations(range(6), len(selected)):
        basis = _solve_square([[row[c] for c in columns] for row in independent], right)
        if basis is None or any(value < 0 for value in basis):
            continue
        value = sum((objective[c] * weight for c, weight in zip(columns, basis)), zero)
        if best is not None and value <= best[0]:
            continue
        weights = [zero] * 6
        for column, weight in zip(columns, basis):
            weights[column] = weight
        subject_point = [sum((weights[i] * a[i][axis] for i in range(3)), zero) for axis in range(3)]
        support_point = [sum((weights[i + 3] * b[i][axis] for i in range(3)), zero) for axis in range(3)]
        best = (value, subject_point, support_point)
    if best is None:
        return ()
    return best if return_exact else _represent_pair(best)


def _represent_pair(best):
    try:
        result = (float(best[0]), [float(x) for x in best[1]], [float(x) for x in best[2]])
    except OverflowError:
        _failure('numerical-ambiguity', 'The required translation exceeds finite numeric range.')
    if not all(math.isfinite(x) for x in [result[0]] + result[1] + result[2]):
        _failure('numerical-ambiguity', 'The surface contact cannot be represented finitely.')
    return result


def _validate_triangles(triangles, label):
    if not isinstance(triangles, (list, tuple)) or not triangles:
        _failure('invalid-geometry', label + ' must contain at least one world-space triangle.')
    if len(triangles) > MAX_TRIANGLES:
        _failure('geometry-budget-exceeded', label + ' exceeds the triangle budget.')
    result = []
    for triangle in triangles:
        if (not isinstance(triangle, (list, tuple)) or len(triangle) != 3 or
                any(not isinstance(p, (list, tuple)) or len(p) != 3 or
                    any(not _finite_number(x) for x in p) for p in triangle)):
            _failure('invalid-geometry', label + ' must contain finite 3D triangles.')
        # Keep existing tuples, and thus shared vertex storage, when available.
        result.append(tuple(tuple(p) for p in triangle))
    return result


def solve_surface_placement(subject_triangles, support_triangles, clearance_meters=0.0,
                            max_candidate_pairs=MAX_CANDIDATE_PAIRS):
    """Return the exact-surface descent offset and an actual maximizing witness.

    Inputs are world-space triangle lists. No surfaces, candidates or degenerate
    triangles are sampled away. Reaching a budget raises instead of returning a
    partial maximum. The returned subject contact is before translation.
    """
    if not _finite_number(clearance_meters) or clearance_meters < 0:
        _failure('invalid-input', 'Clearance must be a finite nonnegative number of metres.')
    if type(max_candidate_pairs) is not int or not 1 <= max_candidate_pairs <= MAX_CANDIDATE_PAIRS:
        _failure('invalid-input', 'The candidate-pair budget must be an integer from 1 to 1000000.')
    subject = _validate_triangles(subject_triangles, 'Subject')
    support = _validate_triangles(support_triangles, 'Support')
    support_bounds = [_bounds(t) for t in support]
    support_max_z = [max(p[2] for p in triangle) for triangle in support]
    subject_min_z = [min(p[2] for p in triangle) for triangle in subject]
    tree = _XYTree(support_bounds, list(range(len(support))), support_max_z)
    candidates = exact_pairs = overlapping_pairs = pruned_subjects = 0
    best = best_exact_value = certified_lower = None
    # Low subject triangles and high support nodes tend to establish a useful
    # witness early. Every skipped triangle/node/pair has a proven Z upper bound
    # no higher than an exact feasible witness's downward-rounded objective.
    for subject_index in sorted(range(len(subject)), key=subject_min_z.__getitem__):
        triangle = subject[subject_index]
        minimum_z = subject_min_z[subject_index]
        if certified_lower is not None and _upper_z_difference(tree.maximum_z, minimum_z) <= certified_lower:
            pruned_subjects += 1
            continue
        for support_index in tree.candidates(_bounds(triangle), support_bounds, minimum_z,
                                             lambda: certified_lower, support_max_z):
            candidates += 1
            if candidates > max_candidate_pairs:
                _failure('candidate-budget-exceeded', 'Projected candidate pairs exceed the exact placement budget.')
            pair = _clip_pair(triangle, support[support_index])
            exact = None
            if pair is None:
                exact_pairs += 1
                exact = _exact_pair(triangle, support[support_index], return_exact=True)
                pair = _represent_pair(exact) if exact else ()
            if not pair:
                continue
            overlapping_pairs += 1
            if best is None or pair[0] > best[0]:
                if exact is None:
                    exact_pairs += 1
                    exact = _exact_pair(triangle, support[support_index], return_exact=True)
                # A floating clip result is never used as proof for pruning.
                if exact and (best_exact_value is None or exact[0] > best_exact_value):
                    pair = _represent_pair(exact)
                    best = (*pair, subject_index, support_index)
                    best_exact_value = exact[0]
                    certified_lower = math.nextafter(float(best_exact_value), -math.inf)
    if best is None:
        _failure('no-projected-overlap', 'Subject and support surfaces have no common world XY point.')
    delta_z = best[0] + clearance_meters
    placed = list(best[1])
    placed[2] += delta_z
    if not math.isfinite(delta_z) or not all(math.isfinite(x) for x in placed):
        _failure('numerical-ambiguity', 'The placed contact cannot be represented finitely.')
    return {'deltaZ': delta_z, 'subjectContactMeters': best[1], 'supportContactMeters': best[2],
            'placedSubjectContactMeters': placed, 'subjectTriangleIndex': best[3],
            'supportTriangleIndex': best[4],
            'statistics': {'candidatePairs': candidates, 'exactPairs': exact_pairs,
                           'overlappingPairs': overlapping_pairs, 'prunedSubjectTriangles': pruned_subjects}}


def _unsupported(reason, message):
    code = 'SCENE_TOO_HEAVY' if reason in ('geometry-budget-exceeded', 'candidate-budget-exceeded') else 'BLENDER_UNSUPPORTED_ACTION'
    raise ActionError(code, message, {'reason': reason})


def _active_animation(data):
    animation = getattr(data, 'animation_data', None)
    return animation is not None and (animation.action is not None or bool(animation.drivers) or
                                      any(bool(track.strips) for track in animation.nla_tracks))


def _validate_static_part(part):
    if (_active_animation(part) or _active_animation(part.data) or
            _active_animation(getattr(part.data, 'shape_keys', None)) or part.constraints or
            part.rigid_body is not None or part.rigid_body_constraint is not None):
        _unsupported('unsupported-animation-or-constraint',
                     'Surface placement requires static entity geometry without animation, drivers, constraints or physics.')
    supported = {'BEVEL', 'ARRAY', 'SUBSURF', 'SOLIDIFY', 'MIRROR', 'TRIANGULATE', 'DECIMATE',
                 'WELD', 'WEIGHTED_NORMAL', 'EDGE_SPLIT', 'SMOOTH'}
    for modifier in part.modifiers:
        # References to external objects/collections can change geometry after a
        # root translation. Refuse even disabled references, making the scope
        # explicit rather than relying on one currently evaluated arrangement.
        for prop in modifier.bl_rna.properties:
            if prop.type == 'POINTER' and prop.identifier != 'rna_type':
                reference = getattr(modifier, prop.identifier, None)
                if reference is not None and getattr(reference, 'bl_rna', None) is not None:
                    identifier = reference.bl_rna.identifier
                    if identifier in ('Object', 'Collection'):
                        _unsupported('unsupported-cross-object-dependency',
                                     'Surface placement cannot verify this cross-object geometry dependency: ' + modifier.name)
        if modifier.type not in supported:
            _unsupported('unsupported-modifier',
                         'Surface placement cannot verify this geometry modifier: ' + modifier.type)
        if modifier.show_viewport != modifier.show_render:
            _unsupported('different-viewport-render-geometry',
                         'Surface placement requires the same enabled geometry modifiers in viewport and render.')
        if modifier.type == 'SUBSURF' and modifier.levels != modifier.render_levels:
            _unsupported('different-viewport-render-geometry',
                         'Surface placement requires matching viewport and render subdivision levels.')


def _matrix_values(matrix):
    values = [[float(value) for value in row] for row in matrix]
    if (len(values) != 4 or any(len(row) != 4 for row in values) or
            not all(math.isfinite(value) and abs(value) <= 1e6 for row in values for value in row) or
            values[3] != [0, 0, 0, 1]):
        _unsupported('invalid-world-transform', 'Surface placement requires a finite affine world transform within its numeric budget.')
    return values


def _capture_entity(obj, graph, render_visible):
    """Capture every supported mesh in the selected root's complete hierarchy."""
    import bpy
    if obj.parent is not None:
        _unsupported('parented-entity-root', 'Surface placement requires an unparented entity root for a world-Z translation.')
    pending, parts, identities, visited = [obj], [], [], set()
    owner = obj.get('deepblend_id')
    while pending:
        part = pending.pop()
        pointer = part.as_pointer()
        if pointer in visited:
            _unsupported('unsupported-hierarchy', 'Surface placement hierarchy is cyclic.')
        if len(visited) >= MAX_HIERARCHY_OBJECTS:
            _unsupported('geometry-budget-exceeded', 'Surface placement exceeds the 4096 hierarchy objects per entity budget.')
        visited.add(pointer)
        if part != obj and part.name.startswith(('db_entity__', 'db_camera__', 'db_light__')):
            owned_part = (isinstance(owner, str) and bool(owner) and part.name.startswith(obj.name + '_') and
                          part.get('deepblend_id') == owner and part.get('deepblend_kind') == 'entity' and
                          isinstance(part.get('deepblend_part_id'), str) and bool(part.get('deepblend_part_id')))
            if not owned_part:
                _unsupported('unsupported-hierarchy', 'Surface placement cannot include another entity root or an unmarked managed child.')
        if part.type not in ('EMPTY', 'MESH') or part.instance_type != 'NONE':
            _unsupported('unsupported-hierarchy', 'Surface placement needs a complete hierarchy of mesh and empty objects without instancing.')
        if (not part.visible_get(view_layer=bpy.context.view_layer) or part.hide_render or
                pointer not in render_visible):
            _unsupported('hidden-hierarchy-part', 'Surface placement cannot silently omit hidden entity geometry.')
        _validate_static_part(part)
        markers = tuple(part.get(key) for key in ('deepblend_id', 'deepblend_part_id', 'deepblend_kind'))
        if any(value is not None and not isinstance(value, str) for value in markers):
            _unsupported('unsupported-hierarchy', 'Surface placement requires plain-text entity ownership markers.')
        identity = (part.name, part.parent.name if part.parent else None, part.type, *markers)
        identities.append(identity)
        if part.type == 'MESH':
            parts.append((part, identity))
            if len(parts) > MAX_MESH_OBJECTS:
                _unsupported('geometry-budget-exceeded', 'Surface placement exceeds the 128 mesh objects per entity budget.')
        pending.extend(sorted(part.children, key=lambda item: item.name, reverse=True))
    if not parts:
        _unsupported('empty-or-invalid-geometry', 'Surface placement requires triangle surfaces in both entities.')
    triangles, captured_parts = [], []
    vertex_count = 0
    low, high = [math.inf] * 3, [-math.inf] * 3
    for part, identity in parts:
        evaluated = part.evaluated_get(graph)
        _matrix_values(evaluated.matrix_world)
        mesh = evaluated.to_mesh()
        try:
            if mesh is None or not mesh.vertices or not mesh.polygons:
                _unsupported('empty-or-invalid-geometry', 'Every entity mesh must provide a nonempty evaluated triangle surface.')
            vertex_count += len(mesh.vertices)
            estimated_triangles = sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.polygons)
            if vertex_count > MAX_VERTICES or len(triangles) + estimated_triangles > MAX_TRIANGLES:
                _unsupported('geometry-budget-exceeded', 'Surface placement exceeds two million evaluated vertices or triangles per entity.')
            mesh.calc_loop_triangles()
            if not mesh.loop_triangles:
                _unsupported('empty-or-invalid-geometry', 'Every entity mesh must provide a nonempty evaluated triangle surface.')
            if len(triangles) + len(mesh.loop_triangles) > MAX_TRIANGLES:
                _unsupported('geometry-budget-exceeded', 'Surface placement exceeds its evaluated triangle budget.')
            vertices = []
            for vertex in mesh.vertices:
                point = tuple(float(value) for value in evaluated.matrix_world @ vertex.co)
                if not all(math.isfinite(value) and abs(value) <= 1e6 for value in point):
                    _unsupported('invalid-world-geometry', 'Surface placement geometry exceeds the finite one-million-metre coordinate budget.')
                vertices.append(point)
                for axis in range(3):
                    low[axis] = min(low[axis], point[axis])
                    high[axis] = max(high[axis], point[axis])
            topology = [tuple(face.vertices) for face in mesh.loop_triangles]
            triangles.extend(tuple(vertices[i] for i in indices) for indices in topology)
            captured_parts.append({'identity': identity, 'vertices': vertices, 'topology': topology})
        finally:
            evaluated.to_mesh_clear()
    metadata = {'meshObjectCount': len(parts), 'vertexCount': vertex_count, 'triangleCount': len(triangles),
                'rootWorldMatrix': _matrix_values(obj.evaluated_get(graph).matrix_world),
                'worldBoundsMeters': {'min': low, 'max': high}}
    return {'metadata': metadata, 'triangles': triangles, 'parts': captured_parts,
            'hierarchyIdentity': identities}


def _verified_checkpoint(path, expected):
    from deepblend_inspect_geometry import file_digest
    if not isinstance(path, str) or not path or '\x00' in path or not os.path.isfile(path):
        raise ActionError('REVISION_CHECKPOINT_MISSING', 'Surface placement needs an existing native checkpoint.')
    if os.path.getsize(path) > 1024 ** 3 or file_digest(path) != expected:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The surface-placement checkpoint differs from its expected source.')


def _capture_checkpoint(path, expected, frame, subject_id, support_id):
    import bpy
    _verified_checkpoint(path, expected)
    try:
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False)
    except Exception as exc:
        raise ActionError('SCENE_VALIDATION_FAILED', 'The native checkpoint cannot be opened for surface placement.') from exc
    if bpy.data.libraries:
        _unsupported('linked-blender-libraries', 'Surface placement requires self-contained geometry without external Blender libraries.')
    scale = float(bpy.context.scene.unit_settings.scale_length)
    if not math.isfinite(scale) or abs(scale - 1.0) > 1e-8:
        _unsupported('unsupported-unit-scale', 'Surface placement requires one metre per native Blender unit.')
    bpy.context.scene.frame_set(frame)
    if int(bpy.context.scene.frame_current) != frame:
        raise ActionError('SCENE_VALIDATION_FAILED', 'Blender did not evaluate the requested surface-placement frame.')
    graph = bpy.context.evaluated_depsgraph_get()
    # Render visibility follows complete collection ancestry; a directly visible
    # collection may still live below a render-disabled ancestor. Objects linked
    # through another enabled path remain visible and are not falsely rejected.
    render_visible, visited_collections = set(), set()
    pending_collections = [bpy.context.scene.collection]
    while pending_collections:
        collection = pending_collections.pop()
        pointer = collection.as_pointer()
        if pointer in visited_collections or collection.hide_render:
            continue
        visited_collections.add(pointer)
        render_visible.update(item.as_pointer() for item in collection.objects)
        pending_collections.extend(collection.children)
    result = []
    entity_ids = [*subject_id, support_id] if isinstance(subject_id, list) else [subject_id, support_id]
    for entity_id in entity_ids:
        obj = bpy.data.objects.get('db_entity__' + entity_id)
        if obj is None:
            raise ActionError('SCENE_SPEC_INVALID', 'The selected native entity does not exist: ' + entity_id)
        result.append(_capture_entity(obj, graph, render_visible))
    _verified_checkpoint(path, expected)
    return result


def _compare_translation(baseline, current, expected, label):
    if (baseline['hierarchyIdentity'] != current['hierarchyIdentity'] or
            len(baseline['parts']) != len(current['parts'])):
        raise ActionError('SCENE_VALIDATION_FAILED', label + ' hierarchy identity changed while verifying surface placement.')
    maximum_error = 0.0
    for old_part, new_part in zip(baseline['parts'], current['parts']):
        if (old_part['identity'] != new_part['identity'] or old_part['topology'] != new_part['topology'] or
                len(old_part['vertices']) != len(new_part['vertices'])):
            raise ActionError('SCENE_VALIDATION_FAILED', label + ' mesh identity or topology changed while verifying surface placement.')
        for before, after in zip(old_part['vertices'], new_part['vertices']):
            error = math.dist(tuple(before[axis] + expected[axis] for axis in range(3)), after)
            maximum_error = max(maximum_error, error)
            if error > TRANSLATION_TOLERANCE_METERS:
                raise ActionError('SCENE_VALIDATION_FAILED', label + ' geometry is not the required rigid world translation.',
                                  {'maxErrorMeters': maximum_error, 'toleranceMeters': TRANSLATION_TOLERANCE_METERS})
    before_matrix = baseline['metadata']['rootWorldMatrix']
    after_matrix = current['metadata']['rootWorldMatrix']
    for row in range(4):
        for column in range(4):
            difference = abs(after_matrix[row][column] - before_matrix[row][column] -
                             (expected[row] if row < 3 and column == 3 else 0.0))
            if difference > (TRANSLATION_TOLERANCE_METERS if column == 3 else 1e-8):
                raise ActionError('SCENE_VALIDATION_FAILED', label + ' root transform changed beyond the required world translation.')
    return maximum_error


def inspect_surface_placement(request, options):
    """Inspect a hash-bound checkpoint, optionally proving a saved rigid move."""
    import bpy
    payload = request.get('payload')
    if isinstance(payload, dict) and payload.get('scope') == 'recipe-assembly':
        from deepblend_assembly_placement import inspect_assembly_placement
        return inspect_assembly_placement(request, options)
    allowed = {'subjectEntityId', 'supportEntityId', 'frame', 'clearanceMm', 'checkpointSha256',
               'baselineCheckpointPath', 'baselineCheckpointSha256', 'expectedTranslationMeters'}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ActionError('BLENDER_SCRIPT_ERROR', 'Surface placement payload contains unsupported fields.')
    subject_id, support_id = payload.get('subjectEntityId'), payload.get('supportEntityId')
    frame, expected = payload.get('frame'), payload.get('checkpointSha256')
    clearance = payload.get('clearanceMm', 0)
    valid_id = lambda value: isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]{0,127}', value) is not None
    valid_hash = lambda value: isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None
    if (not valid_id(subject_id) or not valid_id(support_id) or subject_id == support_id or
            type(frame) is not int or not 0 <= frame <= 1_000_000 or not valid_hash(expected) or
            not _finite_number(clearance) or not 0 <= clearance <= 1000):
        raise ActionError('BLENDER_SCRIPT_ERROR', 'Surface placement requires distinct entity IDs, an explicit frame, checkpoint SHA256 and 0–1000 mm clearance.')
    baseline_fields = {'baselineCheckpointPath', 'baselineCheckpointSha256', 'expectedTranslationMeters'}
    has_baseline = bool(baseline_fields & set(payload))
    if has_baseline:
        translation = payload.get('expectedTranslationMeters')
        if (not baseline_fields <= set(payload) or not valid_hash(payload['baselineCheckpointSha256']) or
                not isinstance(payload['baselineCheckpointPath'], str) or
                not isinstance(translation, list) or len(translation) != 3 or
                any(not _finite_number(value) for value in translation) or translation[:2] != [0, 0]):
            raise ActionError('BLENDER_SCRIPT_ERROR', 'Placement verification requires a baseline checkpoint, its SHA256 and a finite world-Z translation.')
        baseline = _capture_checkpoint(payload['baselineCheckpointPath'], payload['baselineCheckpointSha256'],
                                       frame, subject_id, support_id)
    checkpoint = options.get('blend')
    current = _capture_checkpoint(checkpoint, expected, frame, subject_id, support_id)
    verification = None
    if has_baseline:
        subject_error = _compare_translation(baseline[0], current[0], translation, 'Subject')
        support_error = _compare_translation(baseline[1], current[1], [0, 0, 0], 'Support')
        _verified_checkpoint(payload['baselineCheckpointPath'], payload['baselineCheckpointSha256'])
        verification = {'checkpointSha256': payload['baselineCheckpointSha256'], 'checkpointUnchanged': True,
                        'translationMeters': translation, 'subjectRigidTranslation': True, 'supportUnchanged': True,
                        'subjectMaxErrorMeters': subject_error, 'supportMaxErrorMeters': support_error,
                        'toleranceMeters': TRANSLATION_TOLERANCE_METERS}
    try:
        solution = solve_surface_placement(current[0]['triangles'], current[1]['triangles'], clearance / 1000)
    except SurfacePlacementError as exc:
        _unsupported(exc.reason, str(exc))
    report = {'schemaVersion': 'deepblend.surface-placement/v1', 'axis': 'world-z',
              'checkpointSha256': expected, 'checkpointUnchanged': True, 'frame': frame,
              'blenderVersion': bpy.app.version_string, 'subjectEntityId': subject_id,
              'supportEntityId': support_id, 'clearanceMm': clearance,
              'translationMeters': [0, 0, solution['deltaZ']],
              'subjectContactMeters': solution['subjectContactMeters'],
              'supportContactMeters': solution['supportContactMeters'],
              'placedSubjectContactMeters': solution['placedSubjectContactMeters'],
              'subjectTriangleIndex': solution['subjectTriangleIndex'],
              'supportTriangleIndex': solution['supportTriangleIndex'],
              'statistics': {'candidatePairs': solution['statistics']['candidatePairs']},
              'subject': current[0]['metadata'], 'support': current[1]['metadata']}
    if verification is not None:
        report['baselineVerification'] = verification
    _verified_checkpoint(checkpoint, expected)
    return report, [], []
