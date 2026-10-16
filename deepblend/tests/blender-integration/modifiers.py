"""Verify applied modeling operations against geometric invariants in Blender."""
import json
import hashlib
import os
import sys
import tempfile
from pathlib import Path

import bpy
import bmesh
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from deepblend_scene import create_generator, reset_scene, build_scene
from deepblend_geometry import apply_model_modifiers
from deepblend_util import Guard, ActionError


def inspect(obj):
    mesh = bmesh.new()
    try:
        mesh.from_mesh(obj.data)
        unseen = set(mesh.verts)
        components = 0
        while unseen:
            components += 1
            pending = [unseen.pop()]
            while pending:
                for edge in pending.pop().link_edges:
                    for vertex in edge.verts:
                        if vertex in unseen:
                            unseen.remove(vertex)
                            pending.append(vertex)
        return {'volume': mesh.calc_volume(signed=True),
                'manifold': all(edge.is_manifold for edge in mesh.edges),
                'components': components}
    finally:
        mesh.free()


for operation, volume in [('union', 12), ('difference', 4), ('intersect', 4)]:
    reset_scene()
    body = create_generator('body', {'shape': 'cube', 'size': 2})
    cutter = create_generator('cutter', {'shape': 'cube', 'size': 2})
    cutter.location.x = 1
    cutter.hide_viewport = cutter.hide_render = True
    apply_model_modifiers([
        {'id': 'body', 'modifiers': [{'type': 'boolean', 'operation': operation, 'targetEntityId': 'cutter'}]},
        {'id': 'cutter'}], {'body': [body], 'cutter': [cutter]})
    measured = inspect(body)
    assert measured['manifold'] and measured['components'] == 1, measured
    assert abs(measured['volume'] - volume) < 1e-5, (operation, measured)
    assert cutter.hide_viewport and cutter.hide_render

reset_scene()
plane = create_generator('sheet', {'shape': 'plane', 'size': 2})
apply_model_modifiers([{'id': 'sheet', 'modifiers': [{'type': 'solidify', 'thickness': .2}]}], {'sheet': [plane]})
assert inspect(plane)['manifold'] and abs(inspect(plane)['volume'] - .8) < 1e-5
assert abs(min(v.co.z for v in plane.data.vertices) + .2) < 1e-6

# A post-boolean bevel must change the merged solid, keep it closed, and honor
# both segment count and the angle filter rather than only smoothing normals.
bevel_faces = []
for segments in [1, 6]:
    reset_scene()
    body = create_generator('body', {'shape': 'cube', 'size': 2})
    cutter = create_generator('cutter', {'shape': 'cube', 'size': 2})
    cutter.location.x = 1
    cutter.location.y = 1
    apply_model_modifiers([
        {'id': 'body', 'modifiers': [
            {'type': 'boolean', 'operation': 'union', 'targetEntityId': 'cutter'},
            {'type': 'bevel', 'width': .1, 'segments': segments}]},
        {'id': 'cutter'}], {'body': [body], 'cutter': [cutter]})
    measured = inspect(body)
    assert measured['manifold'] and measured['components'] == 1, measured
    assert 13 < measured['volume'] < 14, measured
    bevel_faces.append(len(body.data.polygons))
assert bevel_faces[1] > bevel_faces[0] > 12, bevel_faces
reset_scene()
cube = create_generator('angle-filter', {'shape': 'cube', 'size': 2})
apply_model_modifiers([{'id': 'cube', 'modifiers': [{'type': 'bevel', 'width': .1, 'angle': 100}]}], {'cube': [cube]})
assert len(cube.data.polygons) == 6 and abs(inspect(cube)['volume'] - 8) < 1e-5

reset_scene()
cube = create_generator('copies', {'shape': 'cube', 'size': 2})
apply_model_modifiers([{'id': 'copies', 'modifiers': [{'type': 'array', 'count': 3, 'offset': [3, 0, 0]}]}], {'copies': [cube]})
assert inspect(cube)['components'] == 3 and abs(inspect(cube)['volume'] - 24) < 1e-5
assert abs(max(v.co.x for v in cube.data.vertices) - 7) < 1e-6

reset_scene()
cube = create_generator('mirror', {'shape': 'cube', 'size': 1})
for vertex in cube.data.vertices:
    vertex.co.x += 2
apply_model_modifiers([{'id': 'mirror', 'modifiers': [{'type': 'mirror', 'axis': 'x'}]}], {'mirror': [cube]})
assert inspect(cube)['manifold'] and inspect(cube)['components'] == 2
assert abs(inspect(cube)['volume'] - 2) < 1e-5
assert min(v.co.x for v in cube.data.vertices) == -2.5

# The operand follows the consumer in the input and has its own stack.
reset_scene()
body = create_generator('body', {'shape': 'cube', 'size': 2})
cutter = create_generator('cutter', {'shape': 'cube', 'size': 2})
cutter.location.x = 1
cutter.hide_viewport = True
apply_model_modifiers([
    {'id': 'body', 'modifiers': [{'type': 'boolean', 'operation': 'union', 'targetEntityId': 'cutter'},
                               {'type': 'array', 'count': 2, 'offset': [10, 0, 0]}]},
    {'id': 'cutter', 'modifiers': [{'type': 'array', 'count': 2, 'offset': [3, 0, 0]}]}],
    {'body': [body], 'cutter': [cutter]})
assert abs(inspect(body)['volume'] - 40) < 1e-5, inspect(body)
assert inspect(body)['components'] == 4
assert cutter.hide_viewport

reset_scene()
cube = create_generator('budget', {'shape': 'cube', 'size': 1})
try:
    apply_model_modifiers([{'id': 'budget', 'modifiers': [
        {'type': 'array', 'count': 64, 'offset': [2, 0, 0]},
        {'type': 'array', 'count': 64, 'offset': [0, 2, 0]},
        {'type': 'array', 'count': 64, 'offset': [0, 0, 2]},
    ]}], {'budget': [cube]})
    raise AssertionError('oversized array was accepted')
except ActionError as error:
    assert 'polygon' in str(error), error
    assert len(cube.data.polygons) == 6 * 64 * 64, 'budget must refuse before allocating the final array'

try:
    apply_model_modifiers([{'id': 'multiple', 'modifiers': [{'type': 'mirror', 'axis': 'x'}]}],
                          {'multiple': [cube, cube]})
    raise AssertionError('ambiguous multi-mesh operation was accepted')
except ActionError as error:
    assert 'exactly one mesh' in str(error), error

def miter_facts(obj):
    """Keep geometry and corner normals observable across save/reopen."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    vertices = [list(obj.matrix_world @ vertex.co) for vertex in mesh.vertices]
    triangles = [list(triangle.vertices) for triangle in mesh.loop_triangles]
    tree = BVHTree.FromPolygons(vertices, triangles, all_triangles=True, epsilon=0.0)
    # A useful screen for this fixture, not a proof for arbitrary solid meshes.
    overlaps = sum(1 for a, b in tree.overlap(tree)
                   if a < b and not set(triangles[a]).intersection(triangles[b]))
    content = {'vertices': vertices, 'faces': [list(face.vertices) for face in mesh.polygons],
               'normals': [list(normal.vector) for normal in mesh.corner_normals]}
    return {**inspect(obj), 'vertices': len(vertices), 'polygons': len(mesh.polygons),
            'meshAndNormalsSha256': hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest(),
            'boundsMin': [min(vertex[axis] for vertex in vertices) for axis in range(3)],
            'boundsMax': [max(vertex[axis] for vertex in vertices) for axis in range(3)],
            'potentialNonAdjacentTriangleIntersections': overlaps}


# Exercise the public field through the real scene builder, including its normal
# handling. A curved bore makes Arc's extra corner topology visible; a cube alone
# would only prove that the enum reached Blender.
with tempfile.TemporaryDirectory(prefix='deepblend-miter-') as temporary:
    output = Path(os.environ.get('DEEPBLEND_MODELING_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)
    results = {}
    for mode in ('default', 'arc', 'sharp'):
        spec = json.loads((ROOT / 'deepblend/fixtures/curved-bore/scene-spec.json').read_text())
        spec['renderProfiles']['preview'].update({'resolution': [480, 360], 'samples': 32})
        body_spec = next(entity for entity in spec['entities'] if entity['id'] == 'body')
        bevel = next(modifier for modifier in body_spec['modifiers'] if modifier['type'] == 'bevel')
        if mode == 'default':
            bevel.pop('miterInner', None)
        else:
            bevel['miterInner'] = mode
        (output / ('bore-' + mode + '.scene-spec.json')).write_text(json.dumps(spec, indent=2) + '\n')
        build_scene(spec, {}, Guard())
        bpy.context.scene.cycles.seed = 712
        body = bpy.data.objects['db_entity__body']
        before = miter_facts(body)
        assert before['manifold'] and before['components'] == 1 and before['volume'] > 0, before
        assert all(-.055001 <= value <= .055001 for point in body.bound_box for value in point[:2]), before
        assert abs(before['boundsMin'][2]) < 1e-6 and abs(before['boundsMax'][2] - .115) < 1e-6, before
        bpy.ops.wm.save_as_mainfile(filepath=str(output / ('bore-' + mode + '.blend')))
        bpy.ops.wm.open_mainfile(filepath=str(output / ('bore-' + mode + '.blend')))
        assert miter_facts(bpy.data.objects['db_entity__body']) == before, 'miter changed after save/reopen'
        results[mode] = before
        # Opt-in retained visual evidence for focused local verification; the
        # geometry and checkpoint assertions above always run in the M1 suite.
        if os.environ.get('DEEPBLEND_MITER_RENDER') == '1' and mode != 'default':
            bpy.context.scene.cycles.device = 'CPU'
            bpy.context.scene.render.filepath = str(output / ('bore-' + mode + '.png'))
            bpy.ops.render.render(write_still=True)
            assert (output / ('bore-' + mode + '.png')).stat().st_size > 2000
    assert results['default'] == results['arc'], 'omitted miterInner must preserve Arc exactly'
    assert results['sharp']['polygons'] != results['arc']['polygons'], results
    assert results['sharp']['meshAndNormalsSha256'] != results['arc']['meshAndNormalsSha256'], results
    assert results['sharp']['potentialNonAdjacentTriangleIntersections'] == 0, results
    assert abs(results['sharp']['volume'] / results['arc']['volume'] - 1) < .0001, results
    (output / 'boolean-miter.json').write_text(json.dumps(results, indent=2) + '\n')
    print('MITER_PASSED: public enum, default=arc, changed topology, closed/no-spike, save/reopen')


with tempfile.TemporaryDirectory(prefix='deepblend-modifiers-') as temporary:
    output = Path(os.environ.get('DEEPBLEND_MODELING_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)
    spec = json.loads((ROOT / 'deepblend/fixtures/ceramic-vessel/scene-spec.json').read_text())
    spec['entities'][0]['modifiers'] = [
        {'type': 'boolean', 'operation': 'union', 'targetEntityId': 'handle'},
        {'type': 'bevel', 'width': .002, 'segments': 6, 'angle': 30}]
    spec['entities'].append({'id': 'handle', 'type': 'generator', 'visible': False, 'materialId': 'glaze',
        'generator': {'shape': 'curve', 'radius': .006, 'pathInterpolation': 'bezier',
                      'curveResolution': 24, 'bevelResolution': 8,
                      'path': [[.062, 0, .147], [.098, 0, .157], [.127, 0, .138],
                               [.13, 0, .105], [.119, 0, .073], [.078, 0, .055]]}})
    (output / 'fused-vessel.scene-spec.json').write_text(json.dumps(spec, indent=2) + '\n')
    build_scene(spec, {}, Guard())
    body = bpy.data.objects['db_entity__vessel']
    measured = inspect(body)
    assert measured['manifold'] and measured['components'] == 1 and measured['volume'] > 0, measured
    # Default miter spread is large relative to this 19 cm vessel and can create
    # spikes despite a manifold result. Bound the actual output, not just topology.
    assert all(-.09 < vertex.co.x < .15 and abs(vertex.co.y) < .09 and
               -.01 < vertex.co.z < .21 for vertex in body.data.vertices), 'bevel produced outlying vertices'
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'fused-vessel.blend'))
    bpy.ops.wm.open_mainfile(filepath=str(output / 'fused-vessel.blend'))
    assert inspect(bpy.data.objects['db_entity__vessel']) == measured
    bpy.context.scene.cycles.device = 'CPU'
    bpy.context.scene.render.filepath = str(output / 'fused-vessel.png')
    bpy.ops.render.render(write_still=True)
    assert (output / 'fused-vessel.png').stat().st_size > 2000
    print('MODIFIERS_PASSED: volume, manifold topology, dependency order, hidden operands, fused vessel, save/reopen/render')


# Generic, non-case fixture: actual attachment vertices inside rotated/scaled
# supports, with UV/material preservation, deterministic bytes and atomic refusal.
from copy import deepcopy
from deepblend_scatter import apply_surface_scatter

def scatter_fixture(seed=42):
    reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=2)
    target=bpy.context.object; target.name='support'
    target.location=(1,2,3);target.rotation_euler=(.2,.3,.4);target.scale=(.8,1.3,.7)
    bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=.01,radius2=.004,depth=.12)
    proto=bpy.context.object;proto.name='prototype'
    proto.location=(4,-2,1);proto.rotation_euler=(.3,.5,.2);proto.scale=(1.2,.8,1.1)
    base_z=min(v.co.z for v in proto.data.vertices)
    anchors=[v.index for v in proto.data.vertices if abs(v.co.z-base_z)<1e-6][:4]
    material=bpy.data.materials.new('source-mat');proto.data.materials.append(material)
    proto.data.polygons[1].material_index=0;proto.data.polygons[1].use_smooth=True
    entry={'type':'surface_scatter','targetEntityIds':['support'],'count':16,'seed':seed,
           'anchorVertexIndices':anchors,'embedDepthMm':12,'scaleRange':[.8,1.2],'upwardBias':.6}
    entities=[{'id':'prototype','type':'generator','modifiers':[entry]},{'id':'support','type':'generator'}]
    return proto,target,entry,entities

def geometry_facts(obj):
    mesh=obj.data
    return {'vertices':[list(v.co)for v in mesh.vertices],'faces':[list(f.vertices)for f in mesh.polygons],
            'smooth':[f.use_smooth for f in mesh.polygons],'slots':[f.material_index for f in mesh.polygons],
            'materials':[m.name for m in mesh.materials],
            'uv':{layer.name:[list(value.uv)for value in layer.data]for layer in mesh.uv_layers}}

stable=None
for seed in (42,42,43):
    proto,target,entry,entities=scatter_fixture(seed)
    before,source=geometry_facts(target),geometry_facts(proto)
    apply_model_modifiers(entities,{'prototype':[proto],'support':[target]})
    metadata=json.loads(proto['deepblend_surface_scatter']);facts=geometry_facts(proto)
    assert geometry_facts(target)==before,'support mesh changed'
    assert len(proto.data.vertices)==len(source['vertices'])*16
    assert len(proto.data.polygons)==len(source['faces'])*16
    assert facts['materials']==source['materials']
    assert facts['smooth']==source['smooth']*16 and facts['slots']==source['slots']*16
    for name,uv in source['uv'].items():assert facts['uv'][name]==uv*16,'UV seams changed'
    inv=target.matrix_world.inverted()
    for i in range(16):
        for k in metadata['anchorVertexIndices']:
            point=inv@(proto.matrix_world@proto.data.vertices[i*len(source['vertices'])+k].co)
            assert all(abs(value)<1 for value in point),'actual attachment vertex escaped support'
    if stable is None:stable=facts
    elif seed==42:assert facts==stable,'same seed did not reproduce exact mesh/UVs'
    else:assert facts!=stable,'different seed did not change placements'
    with tempfile.TemporaryDirectory(prefix='deepblend-scatter-')as temporary:
        path=Path(temporary)/'scatter.blend'
        bpy.ops.wm.save_as_mainfile(filepath=str(path))
        saved=hashlib.sha256(path.read_bytes()).hexdigest()
        bpy.ops.wm.open_mainfile(filepath=str(path))
        proto=bpy.data.objects['prototype'];target=bpy.data.objects['support']
        assert geometry_facts(proto)==facts and json.loads(proto['deepblend_surface_scatter'])==metadata
        assert geometry_facts(target)==before and hashlib.sha256(path.read_bytes()).hexdigest()==saved
        if seed==43:
            # A native render of this fixture (not of the actual pagoda case).
            bpy.ops.object.camera_add(location=(5,-4,6));camera=bpy.context.object
            camera.rotation_euler=(target.location-camera.location).to_track_quat('-Z','Y').to_euler()
            bpy.context.scene.camera=camera;bpy.context.scene.render.engine='CYCLES'
            bpy.context.scene.cycles.samples=4;bpy.context.scene.cycles.device='CPU'
            bpy.context.scene.world=bpy.data.worlds.new('scatter-world')
            bpy.context.scene.world.color=(.4,.4,.4)
            bpy.context.scene.render.resolution_x=128;bpy.context.scene.render.resolution_y=96
            bpy.context.scene.render.resolution_percentage=100
            bpy.context.scene.render.filepath=str(Path(temporary)/'scatter.png')
            bpy.ops.render.render(write_still=True)
            assert (Path(temporary)/'scatter.png').stat().st_size>100
            assert hashlib.sha256(path.read_bytes()).hexdigest()==saved

for mode in ('open','bad-anchor','insufficient','budget','animated','self','not-last','moving-dependency'):
    proto,target,entry,entities=scatter_fixture()
    if mode=='open':
        bm=bmesh.new();bm.from_mesh(target.data);bm.faces.ensure_lookup_table();bm.faces.remove(bm.faces[0]);bm.to_mesh(target.data);bm.free()
    elif mode=='bad-anchor':entry['anchorVertexIndices']=[99999]
    elif mode=='insufficient':entry['anchorVertexIndices']=[0,1,2,3];proto.scale=(1000,1000,1000)
    elif mode=='budget':
        from unittest.mock import patch
        budget=patch('deepblend_scatter.MAX_POLYGONS',1);budget.start()
    elif mode=='self':entry['targetEntityIds']=['prototype']
    elif mode=='not-last':entities[0]['modifiers'].append({'type':'bevel','width':.001})
    elif mode=='moving-dependency':
        entities.append({'id':'operand','type':'generator'});entities[1]['modifiers']=[{'type':'boolean','operation':'union','targetEntityId':'operand'}]
    bpy.context.view_layer.update()
    original=geometry_facts(proto);original_target=geometry_facts(target);mesh_count=len(bpy.data.meshes)
    tracks=[{'targetEntityId':'support'if mode=='animated'else 'operand','property':'location.x'}]if mode in ('animated','moving-dependency')else []
    try:
        apply_model_modifiers(entities,{'prototype':[proto],'support':[target]},tracks)
        raise AssertionError('surface scatter accepted '+mode)
    except ActionError as error:
        assert 'surface_scatter' in str(error),str(error)
        assert geometry_facts(proto)==original and geometry_facts(target)==original_target,'refusal changed original geometry'
        assert len(bpy.data.meshes)==mesh_count,'refusal leaked mesh data'
    finally:
        if mode=='budget':budget.stop()
print('SURFACE_SCATTER_PASSED: actual anchors, static dependencies, exact seeds, UV/materials, budgets, atomic refusal, save/reopen/render')
