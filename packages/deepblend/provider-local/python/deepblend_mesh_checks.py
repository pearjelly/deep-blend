"""Double-precision arithmetic over the actual float32 Blender mesh positions.

All shared-vertex neighbors enter the narrow phase. Tolerances are explicit;
this remains a finite mesh test rather than exact algebraic certification.
"""
import math
from collections import defaultdict

def sub(a,b): return tuple(x-y for x,y in zip(a,b))
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def length(a): return math.sqrt(dot(a,a))
def normal(a,b,c):
    n=cross(sub(b,a),sub(c,a));size=length(n)
    return tuple(x/size for x in n) if size>0 else None

def segment_triangle(p,q,a,b,c):
    direction=sub(q,p);ab=sub(b,a);ac=sub(c,a)
    v=cross(direction,ac);det=dot(ab,v)
    scale=length(direction)*length(ab)*length(ac)
    if scale==0 or abs(det)<=scale*1e-14:return None
    origin=sub(p,a);u=dot(origin,v)/det
    v=cross(origin,ab);w=dot(direction,v)/det;t=dot(ac,v)/det
    eps=1e-12
    if u < -eps or w < -eps or u+w > 1+eps or t < -eps or t > 1+eps:return None
    return tuple(p[i]+t*direction[i] for i in range(3))

def clip_area(a,b):
    def side(p,x,y):return (y[0]-x[0])*(p[1]-x[1])-(y[1]-x[1])*(p[0]-x[0])
    sign=1 if side(b[2],b[0],b[1])>0 else -1
    poly=list(a)
    for q,w in zip(b,b[1:]+b[:1]):
        out=[]
        for s,e in zip(poly,poly[1:]+poly[:1]):
            ds,de=sign*side(s,q,w),sign*side(e,q,w)
            if (ds>=0)!=(de>=0):
                f=ds/(ds-de);out.append((s[0]+f*(e[0]-s[0]),s[1]+f*(e[1]-s[1])))
            if de>=0:out.append(e)
        poly=out
        if not poly:return 0
    return abs(sum(a[0]*b[1]-a[1]*b[0] for a,b in zip(poly,poly[1:]+poly[:1])))*.5

def intersection_facts(mesh, max_candidates=2_000_000):
    mesh.calc_loop_triangles();triangles=[tuple(t.vertices) for t in mesh.loop_triangles]
    verts=[tuple(float(x) for x in v.co) for v in mesh.vertices]
    extent=max(max(v[i] for v in verts)-min(v[i] for v in verts) for i in range(3))
    cell=extent/24;bins=defaultdict(list);boxes=[]
    for index,tri in enumerate(triangles):
        lo=tuple(min(verts[j][i] for j in tri)-1e-10 for i in range(3))
        hi=tuple(max(verts[j][i] for j in tri)+1e-10 for i in range(3));boxes.append((lo,hi))
        for x in range(math.floor(lo[0]/cell),math.floor(hi[0]/cell)+1):
            for y in range(math.floor(lo[1]/cell),math.floor(hi[1]/cell)+1):
                for z in range(math.floor(lo[2]/cell),math.floor(hi[2]/cell)+1):bins[(x,y,z)].append(index)
    pairs=set()
    for values in bins.values():
        for k,a in enumerate(values):
            alo,ahi=boxes[a]
            for b in values[k+1:]:
                blo,bhi=boxes[b]
                if all(alo[i]<=bhi[i] and blo[i]<=ahi[i] for i in range(3)):
                    pairs.add((a,b))
                    if len(pairs)>max_candidates:raise ValueError('mesh intersection validation exceeds its candidate-pair budget')
    bad=[];coplanar=0;tested=0;normals=[]
    for t in triangles:normals.append(normal(*(verts[i] for i in t)))
    eps=1e-8
    for ai,bi in pairs:
        a,b=triangles[ai],triangles[bi];shared=set(a)&set(b);av=[verts[i] for i in a];bv=[verts[i] for i in b]
        na,nb=normals[ai],normals[bi]
        if na is None or nb is None:continue
        is_coplanar=length(cross(na,nb))<1e-5 and max(abs(dot(na,sub(p,av[0]))) for p in bv)<1e-9
        hit=False
        if is_coplanar:
            coplanar+=1;drop=max(range(3),key=lambda i:abs(na[i]));axes=[i for i in range(3) if i!=drop]
            hit=clip_area([tuple(p[i] for i in axes) for p in av],[tuple(p[i] for i in axes) for p in bv])>1e-14
        elif len(shared)<2:
            tested+=1
            for points,target in ((av,bv),(bv,av)):
                for p,q in zip(points,points[1:]+points[:1]):
                    where=segment_triangle(p,q,*target)
                    if where is not None and not any(length(sub(where,verts[i]))<eps for i in shared):hit=True
        if hit:bad.append({'triangles':[ai,bi],'sharedVertices':len(shared),'coplanar':is_coplanar})
    return {'aabbCandidatePairs':len(pairs),'coplanarPairsChecked':coplanar,'noncoplanarPairsChecked':tested,
        'intersectionsBeyondSharedBoundary':len(bad),'examples':bad[:12],
        'method':'Explicit AABB bins include shared vertices; float64 segment/triangle and coplanar polygon clipping over actual mesh coordinates; only noncoplanar shared-edge adjacency exempt',
        'toleranceM':eps,'coplanarAreaToleranceM2':1e-14,'planeToleranceM':1e-9,'barycentricTolerance':1e-12}


def validate_corner_normals(mesh):
    """Check actual stored normals, including their orientation on each triangle."""
    normals = [tuple(float(c) for c in item.vector) for item in mesh.corner_normals]
    if len(normals) != len(mesh.loops):
        raise ValueError('missing corner normals')
    if any(not all(math.isfinite(c) for c in n) or abs(length(n)-1)>1e-5 for n in normals):
        raise ValueError('non-finite or non-unit corner normals')
    mesh.calc_loop_triangles()
    for triangle in mesh.loop_triangles:
        points = [tuple(float(c) for c in mesh.vertices[i].co) for i in triangle.vertices]
        face_normal = normal(*points)
        if face_normal is None or any(dot(normals[i], face_normal)<=0 for i in triangle.loops):
            raise ValueError('corner normal opposes its geometry triangle')


def validate_handled_cup_mesh(mesh, parameters):
    """Refuse invalid discrete output; do not publish a folded or open cup."""
    import bmesh
    from deepblend_util import ActionError
    def invalid(message):
        raise ActionError('SCENE_SPEC_INVALID', 'handled_cup output: '+message)
    if not mesh.polygons or len(mesh.polygons)>100_000:
        invalid('empty mesh or polygon budget exceeded')
    if any(not math.isfinite(c) for vertex in mesh.vertices for c in vertex.co):
        invalid('non-finite coordinates')
    bm=bmesh.new()
    try:
        bm.from_mesh(mesh)
        if any(not edge.is_manifold for edge in bm.edges):invalid('open or non-manifold boundary')
        if any(face.calc_area()<=0 for face in bm.faces):invalid('zero-area face')
        if len(bm.verts)-len(bm.edges)+len(bm.faces)!=0:invalid('unexpected cup/handle topology')
        unseen=set(bm.verts);stack=[unseen.pop()]
        while stack:
            for edge in stack.pop().link_edges:
                for vertex in edge.verts:
                    if vertex in unseen:unseen.remove(vertex);stack.append(vertex)
        if unseen:invalid('disconnected geometry')
        if bm.calc_volume(signed=True)<=0:invalid('nonpositive signed volume')
    finally:
        bm.free()
    uv=mesh.uv_layers.active
    if uv is None or any(not math.isfinite(c) for item in uv.data for c in item.uv):invalid('missing or invalid UVs')
    mesh.calc_loop_triangles()
    for tri in mesh.loop_triangles:
        points = [tuple(float(x) for x in mesh.vertices[i].co) for i in tri.vertices]
        if length(cross(sub(points[1], points[0]), sub(points[2], points[0]))) <= 0:
            invalid('zero-area geometry triangle')
        a,b,c=(uv.data[i].uv for i in tri.loops)
        if abs((b-a).cross(c-a))<1e-12:invalid('zero-area UV triangle')
    if not mesh.has_custom_normals:invalid('missing analytic corner normals')
    try:
        validate_corner_normals(mesh)
        intersections=intersection_facts(mesh)
    except ValueError as error:
        invalid(str(error))
    if intersections['intersectionsBeyondSharedBoundary']:
        invalid('triangles intersect beyond their shared boundary')
    return intersections
