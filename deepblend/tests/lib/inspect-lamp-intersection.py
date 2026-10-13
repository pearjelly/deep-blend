import bpy, json, hashlib, sys, os
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_ray_tri

def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for part in iter(lambda: stream.read(1024*1024), b''): h.update(part)
    return h.hexdigest()

def triangles(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        vertices = [evaluated.matrix_world @ v.co for v in mesh.vertices]
        faces = [tuple(t.vertices) for t in mesh.loop_triangles]
        return vertices, faces, BVHTree.FromPolygons(vertices, faces, all_triangles=True)
    finally: evaluated.to_mesh_clear()

def intersect(a, b):
    va, fa, ba = triangles(a); vb, fb, bb = triangles(b)
    candidates = ba.overlap(bb); hits = []
    for ia, ib in candidates:
        ta = [va[i] for i in fa[ia]]; tb = [vb[i] for i in fb[ib]]
        found = None
        for first, other in [(ta,tb),(tb,ta)]:
            for start, end in [(first[0],first[1]),(first[1],first[2]),(first[2],first[0])]:
                vector = end - start; length = vector.length
                if length < 1e-12: continue
                direction = vector / length
                point = intersect_ray_tri(other[0],other[1],other[2],direction,start,True)
                if point is not None and -1e-9 <= (point-start).dot(direction) <= length+1e-9:
                    found = list(point); break
            if found is not None: break
        if found is not None: hits.append({'triangles':[ia,ib], 'point':found})
    return {'broadPhasePairs':len(candidates),'finiteSegmentTriangleHits':len(hits),'firstHits':hits[:5],
            'scope':'Triangle edge/surface intersections; not a minimum-clearance measurement. Coplanar-only contacts are not certified absent.'}

args = sys.argv[sys.argv.index('--')+1:]; output = args[0]; sources = args[1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=.1); a=bpy.context.object
bpy.ops.mesh.primitive_cube_add(size=.1, location=(.09,0,0)); b=bpy.context.object
positive=intersect(a,b); b.location.x=.2; bpy.context.view_layer.update(); negative=intersect(a,b)
assert positive['finiteSegmentTriangleHits']>0 and negative['finiteSegmentTriangleHits']==0
records=[]
for source in sources:
    before=digest(source);bpy.ops.wm.open_mainfile(filepath=source,load_ui=False,use_scripts=False);bpy.context.scene.frame_set(24)
    shell=bpy.data.objects['db_entity__shade-shell'];mast=bpy.data.objects['db_entity__upright-mast']
    result=intersect(shell,mast);assert digest(source)==before
    records.append({'source':source,'checkpointSha256':before,'checkpointUnchanged':True,'frame':24,**result})
with open(output,'w') as stream:json.dump({'sanity':{'overlappingCubes':positive,'separatedCubes':negative},'records':records},stream,indent=2)
