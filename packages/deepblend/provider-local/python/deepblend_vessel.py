"""Shared-boundary cup geometry. Construction is isolated from runtime actions.

Root strips use quintic endpoint jets. Numeric output checks do not certify
arbitrary continuous surfaces or artistic quality.
"""
import math
import bpy
import bmesh
from mathutils import Vector
from mathutils.geometry import delaunay_2d_cdt
from deepblend_vessel_parameters import handled_cup_parameters
from deepblend_mesh_checks import validate_handled_cup_mesh
from deepblend_util import ActionError
from deepblend_vessel_math import CupSurface, add, unit


class MeshBuilder:

    def __init__(self):
        self.vertices = []
        self.faces = []
        self.uv = []
        self.regions = []
        self.keys = {}
        self.normals = []

    def vertex(self, p, normal):
        normal = unit(normal)
        key = tuple((round(c, 10) for c in p))
        if key not in self.keys:
            self.keys[key] = len(self.vertices)
            self.vertices.append(tuple(p))
            self.normals.append(normal)
        else:
            previous = self.normals[self.keys[key]]
            if sum((a-b)**2 for a,b in zip(previous, normal)) > 1e-10:
                raise ActionError('SCENE_SPEC_INVALID', 'handled_cup output: incompatible shared surface normals')
        return self.keys[key]

    def face(self, ids, uv, region):
        unique = []
        coords = []
        for (i, c) in zip(ids, uv):
            if i not in unique:
                unique.append(i)
                coords.append(c)
        if len(unique) < 3:
            return
        self.faces.append(unique)
        self.uv.append(coords)
        self.regions.append(region)

    def finish(self, name):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        uv = mesh.uv_layers.new(name='UVMap')
        attr = mesh.attributes.new('deepblend_cup_region', 'INT', 'FACE')
        for (i, (polygon, coords)) in enumerate(zip(mesh.polygons, self.uv)):
            attr.data[i].value = self.regions[i]
            for (loop, c) in zip(polygon.loop_indices, coords):
                uv.data[loop].uv = c
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        select(obj)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
        mesh.normals_split_custom_set([self.normals[loop.vertex_index] for loop in mesh.loops])
        return obj

def select(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

def inside(point, polygon):
    (x, y) = point
    hit = False
    for (a, b) in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            hit = not hit
    return hit

class _HandledCupMesh(CupSurface):
    """Analytic profiles sampled into one mesh; roots share cup/handle vertices.

    R/T/B are cup radius/wall/base, r is the tube radius, A/L are root
    footprint/length, H is attachment half-gap, N/M are angular resolutions.
    """




    def add_wall(self, builder, holes):
        (lower, upper) = (self.C, self.HEIGHT - self.T / 2)
        p = self.profile()
        dist = [0]
        for (a, b) in zip(p, p[1:]):
            dist.append(dist[-1] + math.dist(a, b))
        (v0, v1) = (dist[9] / dist[-1], dist[10] / dist[-1])
        hole_coords = []
        for z in (self.P['lower'], self.P['upper']):
            hole_coords.append([(self.R * math.asin(self.A * math.cos(self.TAU * j / self.M) / self.R), z + self.A * math.sin(self.TAU * j / self.M)) for j in range(self.M)])
        coords = []
        edges = []
        for row in range(self.P['wallRows'] + 1):
            z = lower + (upper - lower) * row / self.P['wallRows']
            for col in range(self.N + 1):
                u = -math.pi * self.R + self.TAU * self.R * col / self.N
                if holes and any((inside((u, z), p) for p in hole_coords)):
                    continue
                coords.append((u, z))
        if holes:
            for polygon in hole_coords:
                start = len(coords)
                coords.extend(polygon)
                edges.extend(((start + j, start + (j + 1) % self.M) for j in range(self.M)))
        output = delaunay_2d_cdt([Vector(p) for p in coords], edges, [], 0, 1e-09, True)
        (points, _, faces, orig, _, _) = output
        points = [coords[ids[0]] if len(ids) == 1 else tuple(p) for (p, ids) in zip(points, orig)]
        for face in faces:
            center = tuple((sum((points[i][axis] for i in face)) / len(face) for axis in range(2)))
            if holes and any((inside(center, p) for p in hole_coords)):
                continue
            ids = [builder.vertex((self.R * math.cos(points[i][0] / self.R), self.R * math.sin(points[i][0] / self.R), points[i][1]),
                                  (math.cos(points[i][0] / self.R), math.sin(points[i][0] / self.R), 0)) for i in face]
            builder.face(ids, [(0.25 * (points[i][0] / (self.TAU * self.R) + 0.5), v0 + (v1 - v0) * (points[i][1] - lower) / (upper - lower)) for i in face], 0)

    def add_cup(self, builder, holes):
        p = self.profile()
        rings = []
        dist = [0]
        for (a, b) in zip(p, p[1:]):
            dist.append(dist[-1] + math.dist(a, b))
        vs = [v / dist[-1] for v in dist]
        for (radius, z), (radial, vertical) in zip(p, self.profile_normals()):
            rings.append([builder.vertex((radius * math.cos(-math.pi + self.TAU * j / self.N), radius * math.sin(-math.pi + self.TAU * j / self.N), z),
                                        (radial * math.cos(-math.pi + self.TAU * j / self.N), radial * math.sin(-math.pi + self.TAU * j / self.N), vertical)) for j in range(self.N)])
        for row in range(len(p) - 1):
            if row == 9:
                continue
            for j in range(self.N):
                k = (j + 1) % self.N
                builder.face([rings[row][j], rings[row][k], rings[row + 1][k], rings[row + 1][j]], [(0.25 * j / self.N, vs[row]), (0.25 * (j + 1) / self.N, vs[row]), (0.25 * (j + 1) / self.N, vs[row + 1]), (0.25 * j / self.N, vs[row + 1])], 1)
        self.add_wall(builder, holes)

    def add_roots(self, builder):
        for upper in (False, True):
            rings = []
            for i in range(self.P['rootSegments'] + 1):
                rings.append([builder.vertex(self.root_point(i / self.P['rootSegments'], self.TAU * j / self.M, upper),
                                            self.root_normal(i / self.P['rootSegments'], self.TAU * j / self.M, upper)) for j in range(self.M)])
            for i in range(self.P['rootSegments']):
                for j in range(self.M):
                    k = (j + 1) % self.M
                    u = 0.3 if upper else 0.45
                    builder.face([rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]], [(u + 0.1 * j / self.M, i / self.P['rootSegments']), (u + 0.1 * (j + 1) / self.M, i / self.P['rootSegments']), (u + 0.1 * (j + 1) / self.M, (i + 1) / self.P['rootSegments']), (u + 0.1 * j / self.M, (i + 1) / self.P['rootSegments'])], 2 if upper else 3)

    def add_handle(self, builder):
        sections = []
        for i in range(self.P['handleSegments'] + 1):
            a = math.pi * i / self.P['handleSegments']
            sections.append(((self.R + self.L + self.H * math.sin(a), 0, self.MID + self.H * math.cos(a)), (math.sin(a), 0, math.cos(a))))
        rings = []
        for (center, normal) in sections:
            rings.append([builder.vertex(add(center, (self.r * math.sin(self.TAU * j / self.M) * normal[0], self.r * math.cos(self.TAU * j / self.M), self.r * math.sin(self.TAU * j / self.M) * normal[2])),
                                        (math.sin(self.TAU * j / self.M) * normal[0], math.cos(self.TAU * j / self.M), math.sin(self.TAU * j / self.M) * normal[2])) for j in range(self.M)])
        for i in range(len(rings) - 1):
            for j in range(self.M):
                k = (j + 1) % self.M
                builder.face([rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]], [(0.6 + 0.4 * j / self.M, i / (len(rings) - 1)), (0.6 + 0.4 * (j + 1) / self.M, i / (len(rings) - 1)), (0.6 + 0.4 * (j + 1) / self.M, (i + 1) / (len(rings) - 1)), (0.6 + 0.4 * j / self.M, (i + 1) / (len(rings) - 1))], 4)

def create_handled_cup(name, spec):
    parameters=handled_cup_parameters(spec)
    shape=_HandledCupMesh(parameters)
    builder=MeshBuilder()
    shape.add_cup(builder, True)
    shape.add_roots(builder)
    shape.add_handle(builder)
    obj=builder.finish(name)
    try:
        validate_handled_cup_mesh(obj.data, parameters)
    except Exception:
        mesh=obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.meshes.remove(mesh)
        raise
    return obj
