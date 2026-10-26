"""Independent complete-lamp native oracle; imports no product placement code.

Elementary world matrices and the affine finite support plane are supplied by
fixtures. Every evaluated vertex and oriented polygon is compared to the pinned
same-size native reference. Files are opened read-only and never saved.
"""
import bpy,sys,json,hashlib,math
from pathlib import Path
requests_path,out=sys.argv[sys.argv.index('--')+1:]
requests=json.loads(Path(requests_path).read_text())
def digest(v): return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def capture(request):
    before=sha(request['checkpoint'])
    bpy.ops.wm.open_mainfile(filepath=request['checkpoint'],load_ui=False,use_scripts=False)
    bpy.context.scene.frame_set(request.get('frame',24)); bpy.context.view_layer.update()
    graph=bpy.context.evaluated_depsgraph_get(); parts={}
    for entity in request['ids']+['task-ramp','unrelated-marker','studio-floor']:
        obj=bpy.data.objects['db_entity__'+entity]; evaluated=obj.evaluated_get(graph)
        mesh=evaluated.to_mesh()
        try:
            local=[[float(v) for v in vertex.co] for vertex in mesh.vertices]
            world=[[float(v) for v in evaluated.matrix_world@vertex.co] for vertex in mesh.vertices]
            raw_topology=[list(face.vertices) for face in mesh.polygons]
            topology=sorted(min(face[i:]+face[:i] for i in range(len(face))) for face in raw_topology)
            materials=[]
            for slot in obj.material_slots:
                mat=slot.material; node=mat.node_tree.nodes.get('Principled BSDF') if mat else None
                materials.append(None if not node else {'name':mat.name,'roughness':float(node.inputs['Roughness'].default_value)})
            parts[entity]={'world':world,'local':local,'topologyHash':digest(topology),'localHash':digest([local,topology]),'materials':materials,
                'matrix':[[float(v) for v in row] for row in evaluated.matrix_world],
                'min':[min(p[a] for p in world) for a in range(3)],'max':[max(p[a] for p in world) for a in range(3)]}
        finally: evaluated.to_mesh_clear()
    others={obj.name:{'type':obj.type,'matrix':[[float(v) for v in row] for row in obj.evaluated_get(graph).matrix_world],
        'lens':float(obj.data.lens) if obj.type=='CAMERA' else None} for obj in bpy.data.objects if obj.type in ('CAMERA','LIGHT')}
    return {'checkpointSha256':before,'checkpointUnchanged':before==sha(request['checkpoint']),'parts':parts,'others':others}
captures={r['label']:capture(r) for r in requests}
results=[]
for request in requests:
    current=captures[request['label']]; ref=captures[request.get('reference',request['label'])]
    M=request.get('expectedMatrix',[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])
    errors={}; local_errors={}; local_equal={}; materials_equal={}; matrix_errors={}
    for entity in request['ids']:
        a,b=ref['parts'][entity],current['parts'][entity]
        errors[entity]=max((math.dist([sum(M[i][j]*p[j] for j in range(3))+M[i][3] for i in range(3)],q)
            for p,q in zip(a['world'],b['world'])),default=math.inf) if len(a['world'])==len(b['world']) else math.inf
        local_errors[entity]=max((math.dist(p,q) for p,q in zip(a['local'],b['local'])),default=math.inf) if len(a['local'])==len(b['local']) else math.inf
        local_equal[entity]=a['topologyHash']==b['topologyHash'] and local_errors[entity]<1e-7; materials_equal[entity]=a['materials']==b['materials']
        expected=[[sum(M[i][k]*a['matrix'][k][j] for k in range(4)) for j in range(4)] for i in range(4)]
        matrix_errors[entity]=max(abs(expected[i][j]-b['matrix'][i][j]) for i in range(4) for j in range(4))
    product=[p for entity in request['ids'] for p in current['parts'][entity]['world']]
    # The independent support is a finite plane: z = 0.08 + 0.08*x.
    # An affine height difference attains its minimum at an evaluated vertex.
    intercept,slope=request.get('plane',[.08,.08])
    gaps=[p[2]-intercept-slope*p[0] for p in product]
    member_gaps={entity:min(p[2]-intercept-slope*p[0] for p in current['parts'][entity]['world']) for entity in request['ids']}
    gap_matrix=request.get('poseForGapMatrix')
    planned_points=([[sum(gap_matrix[i][j]*p[j] for j in range(3))+gap_matrix[i][3] for i in range(3)] for p in product] if gap_matrix else product)
    planned_gap=min(p[2]-intercept-slope*p[0] for p in planned_points)
    ramp=current['parts']['task-ramp']
    plane_error=max(abs(p[2]-intercept-slope*p[0]) for p in ramp['world'])
    results.append({'label':request['label'],'reference':request.get('reference'),
        'checkpointSha256':current['checkpointSha256'],'checkpointUnchanged':current['checkpointUnchanged'],
        'memberCount':len(request['ids']),'maxVertexErrorsM':errors,'maxMatrixErrors':matrix_errors,'maxLocalVertexErrorsM':local_errors,
        'allLocalGeometryEqual':all(local_equal.values()),'faceComparison':'Complete sorted oriented polygon cycles; cyclic start and polygon order ignored, winding and vertex indices retained','allMaterialsEqual':all(materials_equal.values()),
        'minimumWholeLampVerticalGapM':min(gaps),'memberMinimumVerticalGapsM':member_gaps,'plannedMinimumGapM':planned_gap,'photographyFacts':current['others'],'supportPlaneErrorM':plane_error,
        'insideSupportXYBounds':all(ramp['min'][0]<=p[0]<=ramp['max'][0] and ramp['min'][1]<=p[1]<=ramp['max'][1] for p in product),
        'unrelatedUnchanged':all(current['parts'][e]==ref['parts'][e] for e in ['task-ramp','unrelated-marker','studio-floor']),
        'photographyUnchanged':current['others']==ref['others'],
        'parts':{e:{k:v for k,v in p.items() if k not in ('world','local')} for e,p in current['parts'].items()}})
Path(out).write_text(json.dumps({'schemaVersion':1,'oracle':'Independent native evaluated vertices, elementary affine matrix and analytical finite plane; no product placement solver imported.','records':results},indent=2)+'\n')
