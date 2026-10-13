"""Manual read-only feasibility probe; no production API or minimum-gap claim.

Run Blender with --background --factory-startup --disable-autoexec
--python-exit-code 1 --python THIS_FILE -- CONFIG_JSON REPORT_JSON.
CONFIG_JSON is an array of cases with name, checkpoint, checkpointSha256,
frame, entities and samples. Each sample has id, entityId, originMeters,
direction and optionally targetEntityId. Inputs are world metres.
"""
import bpy, bmesh, hashlib, json, math, sys, time
from pathlib import Path
from mathutils import Vector
from mathutils.bvhtree import BVHTree

EPS = 1e-7
def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def native(obj):
    ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    if obj.type != 'MESH': return {'reason': 'not-mesh'}
    if not obj.visible_get(view_layer=bpy.context.view_layer): return {'reason': 'viewport-disabled'}
    mesh = ev.to_mesh()
    bm = bmesh.new()
    try:
        if mesh is None: return {'reason': 'not-mesh'}
        if len(mesh.vertices) > 250_000 or len(mesh.polygons) > 250_000:
            return {'reason': 'geometry-budget-exceeded'}
        bm.from_mesh(mesh); bm.transform(ev.matrix_world); bm.normal_update()
        if not bm.verts or not all(math.isfinite(x) for v in bm.verts for x in v.co):
            return {'reason': 'empty-or-invalid'}
        remaining = set(bm.verts); components = 0
        while remaining:
            components += 1; pending = [remaining.pop()]
            while pending:
                for edge in pending.pop().link_edges:
                    for v in edge.verts:
                        if v in remaining: remaining.remove(v); pending.append(v)
        facts = {'vertices': len(bm.verts), 'faces': len(bm.faces), 'components': components,
                 'nonManifoldEdges': sum(not e.is_manifold for e in bm.edges),
                 'inconsistentEdges': sum(not e.is_contiguous for e in bm.edges),
                 'signedVolume': bm.calc_volume(signed=True)}
        if components != 1 or facts['nonManifoldEdges'] or facts['inconsistentEdges'] or facts['signedVolume'] <= 0:
            return {'reason': 'unsupported-topology-or-winding', 'facts': facts}
        return {'bvh': BVHTree.FromBMesh(bm), 'facts': facts}
    finally:
        bm.free(); ev.to_mesh_clear()

def sample(source, origin, direction, target=None):
    if 'reason' in source: return {'status': source['reason']}
    direction = Vector(direction).normalized(); origin = Vector(origin)
    outer, normal, face, distance = source['bvh'].ray_cast(origin, direction, .5)
    if outer is None: return {'status': 'no-entry'}
    if normal.dot(direction) >= -1e-6: return {'status': 'entry-not-inward'}
    inward = -normal.normalized()
    inner, inner_normal, face2, _ = source['bvh'].ray_cast(outer + inward * EPS, inward, .1)
    if inner is None: return {'status': 'no-opposite-surface'}
    if inner_normal.dot(inward) <= 1e-6: return {'status': 'exit-not-outward'}
    result = {'status': 'sampled', 'entryMeters': list(outer), 'exitMeters': list(inner),
              'inwardUnitNormal': list(inward), 'normalSurfaceChordMm': (inner-outer).length * 1000}
    if target is not None:
        if 'reason' in target: result['gap'] = {'status': target['reason']}
        else:
            point, n, face3, _ = target['bvh'].ray_cast(inner + inward * EPS, inward, .1)
            obstruction, _, _, _ = source['bvh'].ray_cast(inner + inward * EPS, inward, .1)
            if point is None: result['gap'] = {'status': 'no-target-entry'}
            elif n.dot(inward) >= -1e-6: result['gap'] = {'status': 'target-not-inward'}
            elif obstruction is not None and (obstruction-inner).length <= (point-inner).length + EPS:
                result['gap'] = {'status': 'source-surface-before-target'}
            else: result['gap'] = {'status': 'sampled', 'targetEntryMeters': list(point),
                                   'normalRaySeparationMm': (point-inner).length * 1000}
    return result

def cube(name, size, location=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj=bpy.context.object; obj.name=name; obj.scale=size
    bpy.context.view_layer.update(); return obj

start=time.monotonic(); bpy.ops.wm.read_factory_settings(use_empty=True)
a=cube('wall', (.002,.04,.04)); b=cube('target', (.002,.04,.04), (.004,0,0))
sanity={'known2mm': sample(native(a), (-.02,0,0), (1,0,0),native(b)),
        'inside': sample(native(a), (0,0,0),(1,0,0)),
        'miss': sample(native(a),(-.02,.08,0),(1,0,0))}
sanity['obliqueSeed']=sample(native(a),(-.02,-.019,0),(1,1,0))
b.location.x=.0015; bpy.context.view_layer.update()
sanity['overlappingTarget']=sample(native(a),(-.02,0,0),(1,0,0),native(b))
b.location=(.01,.02,0); bpy.context.view_layer.update()
bpy.ops.mesh.primitive_torus_add(major_segments=128,minor_segments=256,major_radius=.01,minor_radius=.002)
torus=bpy.context.object
b.location=(.015,0,0); bpy.context.view_layer.update()
sanity['occludedTarget']=sample(native(torus),(-.025,0,0),(1,0,0),native(b))
a.rotation_euler[2]=.47; a.location=(.05,-.02,.03); bpy.context.view_layer.update()
origin=a.matrix_world @ Vector((-10,0,0)); direction=a.matrix_world.to_3x3() @ Vector((1,0,0))
sanity['rotatedTranslated']=sample(native(a),origin,direction)
a.scale.x=-.002; bpy.context.view_layer.update(); sanity['reflectedWinding']=sample(native(a),origin,direction)
bpy.ops.mesh.primitive_plane_add(size=.02); sanity['open']=sample(native(bpy.context.object),(0,0,.02),(0,0,-1))
config_path,out=sys.argv[sys.argv.index('--')+1:]
Path(out+'.sanity.json').write_text(json.dumps(sanity,indent=2)+'\n')
assert abs(sanity['known2mm']['normalSurfaceChordMm']-2)<.001
assert abs(sanity['known2mm']['gap']['normalRaySeparationMm']-2)<.001
assert abs(sanity['rotatedTranslated']['normalSurfaceChordMm']-2)<.001
assert abs(sanity['obliqueSeed']['normalSurfaceChordMm']-2)<.001
assert sanity['overlappingTarget']['gap']['status']=='target-not-inward'
assert sanity['occludedTarget']['gap']['status']=='source-surface-before-target'
assert sanity['inside']['status']=='entry-not-inward'
assert sanity['miss']['status']=='no-entry'
assert sanity['open']['status']=='unsupported-topology-or-winding'
assert sanity['reflectedWinding']['status']=='unsupported-topology-or-winding'
records=[]
cases=json.loads(Path(config_path).read_text())
assert isinstance(cases,list) and 1<=len(cases)<=8
for case in cases:
    assert isinstance(case['frame'],int) and 0<=case['frame']<=1_000_000
    assert 1<=len(case['entities'])<=8 and len(set(case['entities']))==len(case['entities'])
    assert 1<=len(case['samples'])<=8 and len({q['id'] for q in case['samples']})==len(case['samples'])
    for q in case['samples']:
        assert q['entityId'] in case['entities'] and (q.get('targetEntityId') is None or q['targetEntityId'] in case['entities'])
        assert q.get('targetEntityId')!=q['entityId']
        for vector in [q['originMeters'],q['direction']]:
            assert len(vector)==3 and all(isinstance(v,(int,float)) and math.isfinite(v) for v in vector)
        assert Vector(q['direction']).length>1e-12
    path=case['checkpoint']; before=digest(path); then=time.monotonic()
    assert before==case['checkpointSha256'], 'Checkpoint differs from the pinned baseline'
    bpy.ops.wm.open_mainfile(filepath=path,load_ui=False,use_scripts=False)
    assert not bpy.data.libraries and abs(bpy.context.scene.unit_settings.scale_length-1)<1e-8
    bpy.context.scene.frame_set(case['frame'])
    cache={id:native(bpy.data.objects['db_entity__'+id]) for id in case['entities']}
    results=[{'id':q['id'],'entityId':q['entityId'],'targetEntityId':q.get('targetEntityId'),
              'originMeters':q['originMeters'],'direction':list(Vector(q['direction']).normalized()),
              **sample(cache[q['entityId']],q['originMeters'],q['direction'],cache.get(q.get('targetEntityId')))} for q in case['samples']]
    assert before==digest(path)
    records.append({'case':case['name'],'checkpointSha256':before,'checkpointUnchanged':True,
                    'frame':case['frame'],'elapsedMs':round((time.monotonic()-then)*1000),
                    'geometry':{id:v.get('facts',{'reason':v.get('reason')}) for id,v in cache.items()},'samples':results})
report={'blenderVersion':bpy.app.version_string,'sanity':sanity,'records':records,
        'elapsedMs':round((time.monotonic()-start)*1000),
        'scope':'Finite local rays on evaluated closed connected consistently wound positive-volume mesh; self-intersection absence is not certified. Surface chord and gap along the entry normal only; not global thickness, minimum clearance, collision absence, manufacturing or appearance approval. Manual sample selection, not model capability.'}
Path(out).write_text(json.dumps(report,indent=2)+'\n')
print('SURFACE_PROBE',report['elapsedMs'],[(r['case'],[s['status'] for s in r['samples']]) for r in records])
