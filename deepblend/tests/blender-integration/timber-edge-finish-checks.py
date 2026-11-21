"""Native transformed-timber, UV, shading and atomic-failure checks; no model calls."""
import copy, hashlib, json, math, sys
from pathlib import Path
import bmesh
import bpy
from mathutils import Euler, Matrix

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root/'packages/deepblend/provider-local/python'))
arguments = sys.argv[sys.argv.index('--')+1:]
assert len(arguments)==2
input_path, output_path = map(Path, arguments)
from deepblend_mesh import create_mesh
from deepblend_geometry import apply_model_modifiers
from deepblend_half_lap import apply_half_lap
from deepblend_mesh_checks import validate_corner_normals
from deepblend_util import ActionError
import deepblend_edge_finish as finish

source = json.loads(input_path.read_text())
ids = ['longitudinal-slats', 'cross-slats']
rotation = Matrix.Translation((.37, -.19, .13)) @ Euler((.31, -.24, .63), 'XYZ').to_matrix().to_4x4()
scale = Matrix.Diagonal((1.4, .7, 1.3, 1))
results = []

def fresh(spacing=.064, baked=False, transformed=False, legacy=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    entities = [copy.deepcopy(e) for e in source['entities'] if e['id'] in ids]
    groups = {}
    for entity in entities:
        entity['transform']={'location':[0,0,0],'rotationEuler':[0,0,0],'scale':[1,1,1],**entity.get('transform',{})}
        if entity['id']=='cross-slats':
            entity['transform']['location'][0] = .078-spacing
            entity['modifiers'][0]['offset'][0] = spacing
        if legacy:
            entity['generator'].pop('faceUvs', None)
        obj=create_mesh(entity['id'], entity['generator'])
        obj.location=entity['transform']['location']
        obj.rotation_euler=entity['transform']['rotationEuler']
        obj.scale=entity['transform']['scale']
        groups[entity['id']]=obj
    apply_model_modifiers(entities, {k:[o] for k,o in groups.items()})
    for obj in groups.values():
        original=obj.matrix_world.copy()
        if transformed:
            if baked:
                obj.data.transform(scale @ original)
                obj.matrix_world=rotation
            else:
                obj.matrix_world=rotation @ scale @ original
    bpy.context.view_layer.update()
    return groups

def signature(groups):
    return {key: {'mesh':obj.data.as_pointer(), 'coordinates':[tuple(v.co) for v in obj.data.vertices],
        'faces':[tuple(p.vertices) for p in obj.data.polygons],
        'uvs':[tuple(l.uv) for l in obj.data.uv_layers.active.data]} for key,obj in groups.items()}

def facts(groups, require_uv=True):
    values={}
    for name,obj in groups.items():
        mesh=obj.data;bm=bmesh.new();bm.from_mesh(mesh)
        try:
            assert all(e.is_manifold for e in bm.edges),name
            assert all(f.calc_area()>0 for f in bm.faces),name
            components=4 if name==ids[0] else 3
            unseen=set(bm.verts);actual_components=0
            while unseen:
                frontier=[unseen.pop()];actual_components+=1
                for vertex in frontier:
                    for edge in vertex.link_edges:
                        other=edge.other_vert(vertex)
                        if other in unseen:
                            unseen.remove(other);frontier.append(other)
            assert actual_components==components,(name,actual_components)
            assert len(bm.verts)-len(bm.edges)+len(bm.faces)==2*components,name
            assert bm.calc_volume(signed=True)>0,name
        finally:bm.free()
        validate_corner_normals(mesh)
        uv=mesh.uv_layers.active;mesh.calc_loop_triangles();bad=0
        for t in mesh.loop_triangles:
            a,b,c=[uv.data[i].uv for i in t.loops]
            bad+=abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))<=1e-14
        if require_uv:assert bad==0,(name,bad)
        normal_matrix=obj.matrix_world.to_3x3().inverted().transposed()
        corners=[(tuple(obj.matrix_world @ mesh.vertices[l.vertex_index].co),
                  tuple((normal_matrix @ mesh.corner_normals[i].vector).normalized()))
                 for i,l in enumerate(mesh.loops)]
        values[name]={'vertices':len(mesh.vertices),'polygons':len(mesh.polygons),'triangles':len(mesh.loop_triangles),
                      'degenerateUvTriangles':bad,'corners':corners}
    return values

for spacing,width,reverse in [(.052,.00025,False),(.064,.0005,False),(.092,.001,False),(.064,.0005,True)]:
    print('TIMBER_CASE', spacing, width, reverse, flush=True)
    groups=fresh(spacing)
    pair=ids if reverse else ids[::-1]
    witness=apply_half_lap(*(groups[k] for k in pair),inspect=True,edge_width=width)
    assert witness['crossings']==12,witness['crossings']
    observed=facts(groups)
    results.append({'spacing':spacing,'width':width,'reversed':reverse,'crossings':12,
                    'groups':{k:{n:v for n,v in x.items() if n!='corners'} for k,x in observed.items()}})

actual=fresh(transformed=True)
apply_half_lap(actual[ids[1]], actual[ids[0]], edge_width=.0005)
a=facts(actual)
reference=fresh(transformed=True,baked=True)
apply_half_lap(reference[ids[1]], reference[ids[0]], edge_width=.0005)
b=facts(reference)
errors={}
for name in ids:
    assert len(a[name]['corners'])==len(b[name]['corners'])
    position=max(math.dist(x[0],y[0]) for x,y in zip(a[name]['corners'],b[name]['corners']))
    normals=max(math.dist(x[1],y[1]) for x,y in zip(a[name]['corners'],b[name]['corners']))
    print('NORMAL_COMPARISON',name,position,normals,flush=True)
    assert position<2e-6 and normals<2e-3,(name,position,normals)
    errors[name]={'maximumWorldPositionErrorM':position,'maximumWorldNormalError':normals}
results.append({'positiveNonuniformScaleAndCommonRotationVersusBakedReference':errors})

groups=fresh(legacy=True)
apply_half_lap(groups[ids[1]],groups[ids[0]],edge_width=.0005)
legacy=facts(groups,require_uv=False)
results.append({'legacyUv':{k:{n:v for n,v in x.items() if n!='corners'} for k,x in legacy.items()},
                'limit':'Legacy collapsed original face UVs are preserved; the new recipe needs explicit face UVs.'})

groups=fresh()
before=signature(groups);meshes={m.as_pointer() for m in bpy.data.meshes};objects={o.as_pointer() for o in bpy.data.objects}
original=finish.finish_timber_mesh;calls=0
def fail_second(*args):
    global calls
    calls+=1
    if calls==2:raise ActionError('SCENE_SPEC_INVALID','deliberate second member failure')
    return original(*args)
finish.finish_timber_mesh=fail_second
try:
    try:apply_half_lap(groups[ids[1]],groups[ids[0]],edge_width=.0005)
    except ActionError as error:assert 'deliberate' in str(error)
    else:raise AssertionError('second member must refuse')
finally:finish.finish_timber_mesh=original
assert signature(groups)==before
assert {m.as_pointer() for m in bpy.data.meshes}==meshes
assert {o.as_pointer() for o in bpy.data.objects}==objects
results.append({'secondMemberRefusalLeavesOriginalsAndDataInventoryUnchanged':True})

groups=fresh()
before=signature(groups);meshes={m.as_pointer() for m in bpy.data.meshes};objects={o.as_pointer() for o in bpy.data.objects}
try:apply_half_lap(groups[ids[1]],groups[ids[0]],edge_width=.005)
except ActionError as error:
    assert error.code=='SCENE_SPEC_INVALID'
    assert signature(groups)==before
    assert {m.as_pointer() for m in bpy.data.meshes}==meshes
    assert {o.as_pointer() for o in bpy.data.objects}==objects
    boundary='refused without changing originals or data inventory'
else:
    # The public contract allows native overlap limiting. A healthy clamped
    # result is valid too; do not require one vendor's exact boundary refusal.
    facts(groups)
    assert len(bpy.data.meshes)==len(meshes) and {o.as_pointer() for o in bpy.data.objects}==objects
    boundary='built as closed components with valid UVs and corner normals'
results.append({'fiveMillimetreBoundary':boundary})

from types import SimpleNamespace
groups=fresh()
before=signature(groups);meshes={m.as_pointer() for m in bpy.data.meshes};objects={o.as_pointer() for o in bpy.data.objects}
selected={o.as_pointer() for o in bpy.context.selected_objects};active=bpy.context.view_layer.objects.active
native_bpy=finish.bpy
native_apply=bpy.ops.object.modifier_apply
def copied_mesh_failure(**kwargs):
    native_apply(**kwargs)
    obj=bpy.context.view_layer.objects.active
    obj.data=obj.data.copy()
    raise RuntimeError('deliberate native failure after copied modifier output')
finish.bpy=SimpleNamespace(data=bpy.data,context=bpy.context,
    ops=SimpleNamespace(object=SimpleNamespace(shade_smooth_by_angle=bpy.ops.object.shade_smooth_by_angle,
                                               modifier_apply=copied_mesh_failure)))
try:
    try:apply_half_lap(groups[ids[1]],groups[ids[0]],edge_width=.0005)
    except RuntimeError as error:assert 'deliberate native failure' in str(error)
    else:raise AssertionError('the copied native output must refuse')
finally:finish.bpy=native_bpy
assert signature(groups)==before
assert {o.as_pointer() for o in bpy.data.objects}==objects
assert {o.as_pointer() for o in bpy.context.selected_objects}==selected
assert bpy.context.view_layer.objects.active==active
assert {m.as_pointer() for m in bpy.data.meshes}==meshes,'copied modifier output leaked'
results.append({'copiedNativeModifierFailureLeavesMeshesObjectsSelectionAndOriginalsUnchanged':True})

groups=fresh()
count=len(bpy.data.meshes);object_count=len(bpy.data.objects)
def copied_mesh_success(**kwargs):
    result=native_apply(**kwargs)
    obj=bpy.context.view_layer.objects.active
    obj.data=obj.data.copy()
    return result
finish.bpy=SimpleNamespace(data=bpy.data,context=bpy.context,
    ops=SimpleNamespace(object=SimpleNamespace(shade_smooth_by_angle=bpy.ops.object.shade_smooth_by_angle,
                                               modifier_apply=copied_mesh_success)))
try:apply_half_lap(groups[ids[1]],groups[ids[0]],edge_width=.0005)
finally:finish.bpy=native_bpy
facts(groups)
assert len(bpy.data.meshes)==count and len(bpy.data.objects)==object_count
results.append({'successfulCopiedNativeModifierOutputReplacesInputsWithoutLeakingMeshes':True})

path=output_path
path.write_text(json.dumps({'status':'passed','results':results},indent=2)+'\n')
print('TIMBER_EDGE_MATRIX '+str(path))
