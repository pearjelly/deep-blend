"""Finite local surface rays. This does not establish global wall or clearance minima."""
import math
import re
from deepblend_util import ActionError

EPSILON = 1e-7  # metres: 0.0001 mm; smaller separations are unavailable
MAX_SURFACE_DISTANCE = .1


def validate_surface_selection(samples, ids):
    if not isinstance(samples, list) or not 1 <= len(samples) <= 8:
        raise ActionError('BLENDER_SCRIPT_ERROR', 'Select 1–8 surface samples.')
    seen = set()
    allowed = {'sampleId', 'entityId', 'targetEntityId', 'originMeters', 'direction', 'searchDistanceMm'}
    for q in samples:
        if (not isinstance(q, dict) or set(q) - allowed or
                not isinstance(q.get('sampleId'), str) or re.fullmatch('[a-zA-Z0-9_-]{1,64}', q['sampleId']) is None or
                q['sampleId'] in seen or q.get('entityId') not in ids or
                ('targetEntityId' in q and (q['targetEntityId'] not in ids or q['targetEntityId'] == q['entityId']))):
            raise ActionError('BLENDER_SCRIPT_ERROR', 'Invalid surface identity or unsupported fields.')
        seen.add(q['sampleId'])
        for key in ('originMeters', 'direction'):
            v = q.get(key)
            if not isinstance(v, list) or len(v) != 3 or any(type(x) not in (int, float) or not math.isfinite(x) for x in v):
                raise ActionError('BLENDER_SCRIPT_ERROR', 'Surface seeds and directions must be finite vectors.')
        norm = math.hypot(*q['direction'])
        search = q.get('searchDistanceMm')
        if (any(abs(x) > 1000 for x in q['originMeters']) or not 1e-12 <= norm <= 1e6 or
                type(search) not in (int, float) or not math.isfinite(search) or not .01 <= search <= 500):
            raise ActionError('BLENDER_SCRIPT_ERROR', 'Surface seeds, directions or search distances exceed the budget.')


def evaluated_surface(obj, graph):
    import bpy
    import bmesh
    from mathutils.bvhtree import BVHTree
    if obj.type != 'MESH':
        return {'reason': 'not-mesh'}
    if not obj.visible_get(view_layer=bpy.context.view_layer):
        return {'reason': 'viewport-disabled'}
    evaluated = obj.evaluated_get(graph)
    mesh = evaluated.to_mesh()
    bm = bmesh.new()
    try:
        if mesh is None or not mesh.vertices or not mesh.polygons:
            return {'reason': 'empty-or-invalid-geometry'}
        if len(mesh.vertices) > 250_000 or len(mesh.polygons) > 250_000:
            return {'reason': 'geometry-budget-exceeded'}
        bm.from_mesh(mesh)
        bm.transform(evaluated.matrix_world)
        bm.normal_update()
        if any(not math.isfinite(x) for v in bm.verts for x in v.co):
            return {'reason': 'empty-or-invalid-geometry'}
        volume = bm.calc_volume(signed=True)
        if any(not e.is_manifold or not e.is_contiguous for e in bm.edges) or not math.isfinite(volume) or volume <= 0:
            return {'reason': 'unsupported-topology-or-winding'}
        remaining = set(bm.verts)
        pending = [remaining.pop()]
        while pending:
            for edge in pending.pop().link_edges:
                for vertex in edge.verts:
                    if vertex in remaining:
                        remaining.remove(vertex)
                        pending.append(vertex)
        if remaining:
            return {'reason': 'unsupported-topology-or-winding'}
        return {'bvh': BVHTree.FromBMesh(bm)}
    finally:
        bm.free()
        evaluated.to_mesh_clear()


def surface_sample(q, surfaces):
    from mathutils import Vector
    magnitude = math.hypot(*q['direction'])
    direction = Vector([x / magnitude for x in q['direction']]).normalized()
    result = {k: q[k] for k in ('sampleId', 'entityId', 'originMeters', 'searchDistanceMm')}
    result['direction'] = list(direction)
    if 'targetEntityId' in q:
        result['targetEntityId'] = q['targetEntityId']
    source = surfaces[q['entityId']]

    def unavailable(reason):
        return dict(result, status=reason)

    if 'reason' in source:
        return unavailable(source['reason'])
    outer, normal, _, _ = source['bvh'].ray_cast(Vector(q['originMeters']), direction, q['searchDistanceMm'] / 1000)
    if outer is None:
        return unavailable('no-entry')
    if normal.dot(direction) >= -1e-6:
        return unavailable('entry-not-inward')
    inward = -normal.normalized()
    inner, opposite_normal, _, _ = source['bvh'].ray_cast(outer + inward * EPSILON, inward, MAX_SURFACE_DISTANCE)
    if inner is None:
        return unavailable('no-opposite-surface')
    if opposite_normal.dot(inward) <= 1e-6:
        return unavailable('exit-not-outward')
    chord = (inner - outer).length * 1000
    if not math.isfinite(chord) or chord <= 2 * EPSILON * 1000:
        return unavailable('below-resolution')
    result.update(status='sampled', entryMeters=list(outer), exitMeters=list(inner),
                  inwardUnitNormal=list(inward), normalSurfaceChordMm=chord)
    if 'targetEntityId' in q:
        target = surfaces[q['targetEntityId']]
        if 'reason' in target:
            result['gap'] = {'status': target['reason']}
        else:
            start = inner + inward * EPSILON
            point, n, _, _ = target['bvh'].ray_cast(start, inward, MAX_SURFACE_DISTANCE)
            obstruction, _, _, _ = source['bvh'].ray_cast(start, inward, MAX_SURFACE_DISTANCE)
            if point is None:
                result['gap'] = {'status': 'no-target-entry'}
            elif n.dot(inward) >= -1e-6:
                result['gap'] = {'status': 'target-not-inward'}
            elif obstruction is not None and (obstruction - inner).length <= (point - inner).length + EPSILON:
                result['gap'] = {'status': 'source-surface-before-target'}
            elif (point - inner).length <= 2 * EPSILON:
                result['gap'] = {'status': 'below-resolution'}
            else:
                result['gap'] = {'status': 'sampled', 'targetEntryMeters': list(point),
                                 'normalRaySeparationMm': (point - inner).length * 1000}
    return result


def inspect_surface_samples(samples, graph):
    import bpy
    ids = {q['entityId'] for q in samples} | {q['targetEntityId'] for q in samples if 'targetEntityId' in q}
    surfaces = {id: evaluated_surface(bpy.data.objects['db_entity__' + id], graph) for id in sorted(ids)}
    return [surface_sample(q, surfaces) for q in samples]
