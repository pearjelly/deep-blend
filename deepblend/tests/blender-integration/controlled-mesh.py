"""Native control-surface invariants, including UV seams and bounded subdivision."""
import copy
import json
import sys
from pathlib import Path
import bpy
import bmesh

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from deepblend_scene import create_generator, reset_scene, build_scene
from deepblend_geometry import apply_model_modifiers
from deepblend_util import ActionError, Guard

cube = {'shape': 'mesh', 'vertices': [[-1,-1,-1], [1,-1,-1], [1,1,-1], [-1,1,-1],
        [-1,-1,1], [1,-1,1], [1,1,1], [-1,1,1]],
        'faces': [[0,3,2,1], [4,5,6,7], [0,1,5,4], [1,2,6,5], [2,3,7,6], [3,0,4,7]]}

def volume(obj):
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        assert all(edge.is_manifold for edge in bm.edges)
        return bm.calc_volume(signed=True)
    finally:
        bm.free()

reset_scene()
spec = copy.deepcopy(cube)
spec['faceUvs'] = [[[0,0], [1,0], [1,1], [0,1]] for face in spec['faces']]
spec['smooth'] = True
before = copy.deepcopy(spec)
obj = create_generator('authored', spec)
assert spec == before
assert abs(volume(obj) - 8) < 1e-6
assert all(p.use_smooth for p in obj.data.polygons)
assert list(obj.data.polygons[0].vertices) == spec['faces'][0]
for polygon, uvs in zip(obj.data.polygons, spec['faceUvs']):
    assert [list(obj.data.uv_layers.active.data[i].uv) for i in polygon.loop_indices] == uvs

for scheme in ['simple', 'catmull-clark']:
    reset_scene()
    obj = create_generator('subdiv', cube)
    obj.location = (3, 4, 5)
    apply_model_modifiers([{'id': 'surface', 'modifiers': [{'type': 'subdivision', 'levels': 2, 'scheme': scheme}]}], {'surface': [obj]})
    assert len(obj.data.polygons) == 96 and not obj.modifiers
    assert tuple(obj.location) == (3, 4, 5)
    measured = volume(obj)
    assert (abs(measured - 8) < 1e-5 if scheme == 'simple' else 2 < measured < 4), (scheme, measured)
    assert obj.data.uv_layers.active and len(obj.data.uv_layers.active.data) == len(obj.data.loops)

# Boundary policy changes the actual outline of an open authored quad.
extents = []
for boundary in ['all', 'preserve-corners']:
    reset_scene()
    obj = create_generator('open', {'shape': 'mesh', 'vertices': [[-1,-1,0], [1,-1,0], [1,1,0], [-1,1,0]], 'faces': [[0,1,2,3]]})
    apply_model_modifiers([{'id': 'open', 'modifiers': [{'type': 'subdivision', 'levels': 2, 'boundaryMode': boundary}]}], {'open': [obj]})
    extents.append(max(v.co.length for v in obj.data.vertices))
assert extents[1] > extents[0] + .1, extents

# Invalid input neither leaves partial meshes nor silently repairs authored data.
reset_scene()
for replacement in [{'faces': [[0,1,99]]}, {'faces': [[0,1,1]]},
                    {'faces': [[0,1,2], [2,1,0]]}, {'faceUvs': []},
                    {'vertices': [[0,0,0]] * 8}]:
    bad = {**cube, **replacement}
    before_meshes = len(bpy.data.meshes)
    try:
        create_generator('bad', bad)
        raise AssertionError('invalid mesh accepted')
    except ActionError:
        pass
    assert len(bpy.data.meshes) == before_meshes

reset_scene()
obj = create_generator('budget', cube)
apply_model_modifiers([{'id': 'budget', 'modifiers': [
    {'type': 'array', 'count': 64, 'offset': [3,0,0]},
    {'type': 'array', 'count': 64, 'offset': [0,3,0]}]}], {'budget': [obj]})
assert len(obj.data.polygons) == 24576
before_counts = (len(obj.data.vertices), len(obj.data.polygons))
try:
    apply_model_modifiers([{'id': 'budget', 'modifiers': [{'type': 'subdivision', 'levels': 3}]}], {'budget': [obj]})
    raise AssertionError('oversized subdivision accepted')
except ActionError as error:
    assert 'budget' in str(error)
assert not obj.modifiers and before_counts == (len(obj.data.vertices), len(obj.data.polygons))

# The full scene compiler must respect explicit flat shading, including bevels.
for smooth in [False, True]:
    spec = json.loads((ROOT / 'deepblend/fixtures/product-turntable/scene-spec.json').read_text())
    entity = next(e for e in spec['entities'] if e['type'] == 'generator')
    entity['generator'] = {**cube, 'smooth': smooth, 'bevel': {'width': .01, 'segments': 2}}
    build_scene(spec, {}, Guard())
    obj = bpy.data.objects['db_entity__' + entity['id']]
    assert all(p.use_smooth == smooth for p in obj.data.polygons)
print('CONTROLLED_MESH_PASSED')
