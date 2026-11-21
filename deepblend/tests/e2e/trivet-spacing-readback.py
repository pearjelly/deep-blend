"""Independently reopen saved trivet meshes and measure closed solids, centers and sampled joints."""
from itertools import product
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def read(path, spacing, lower, edge_width=None):
    bpy.ops.wm.open_mainfile(filepath=str(path))
    ids = ("longitudinal-slats", "cross-slats")
    groups = {obj.get("deepblend_id"): obj for obj in bpy.context.scene.objects
              if obj.type == "MESH" and obj.get("deepblend_id") in ids}
    assert set(groups) == set(ids)
    points, components, trees = {}, {}, {}
    cross_centers = []
    for name, obj in groups.items():
        points[name] = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
        if edge_width is not None:
            mesh=obj.data
            mesh.calc_loop_triangles()
            uv=mesh.uv_layers.active
            assert uv and all(math.isfinite(x) for item in uv.data for x in item.uv)
            if edge_width:
                assert mesh.has_custom_normals
            for normal in mesh.corner_normals:
                assert all(math.isfinite(x) for x in normal.vector) and abs(normal.vector.length-1)<1e-5
            for triangle in mesh.loop_triangles:
                a,b,c=[uv.data[index].uv for index in triangle.loops]
                assert abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))>1e-14
                assert all(mesh.corner_normals[index].vector.dot(triangle.normal)>0 for index in triangle.loops)
            # An unnotched outer face provides an independent physical width.
            if name=='longitudinal-slats':
                flat=[p.x for p in points[name] if abs(p.z-.02)<1e-7]
            else:
                flat=[p.y for p in points[name] if abs(p.z)<1e-7]
            assert flat and abs(min(flat)-(-.12+edge_width))<2e-6,(name,min(flat),edge_width)
        trees[name] = BVHTree.FromPolygons(points[name], [tuple(face.vertices) for face in obj.data.polygons])
        bm = bmesh.new()
        try:
            bm.from_mesh(obj.data)
            assert all(edge.is_manifold for edge in bm.edges)
            assert bm.calc_volume(signed=True) > 0
            remaining = set(bm.verts)
            count = 0
            while remaining:
                frontier = [remaining.pop()]
                for vertex in frontier:
                    for edge in vertex.link_edges:
                        adjacent = edge.other_vert(vertex)
                        if adjacent in remaining:
                            remaining.remove(adjacent)
                            frontier.append(adjacent)
                count += 1
                if name == "cross-slats":
                    positions = [(obj.matrix_world @ vertex.co).x for vertex in frontier]
                    cross_centers.append(round((min(positions) + max(positions)) * 500, 3))
            assert len(bm.verts) - len(bm.edges) + len(bm.faces) == 2 * count
            components[name] = count
        finally:
            bm.free()
    assert components == {"longitudinal-slats": 4, "cross-slats": 3}
    all_points = sum(points.values(), [])
    bounds = [round((max(point[i] for point in all_points) - min(point[i] for point in all_points)) * 1000, 3)
              for i in range(3)]
    assert bounds == [240, 240, 20], bounds
    x_centers = [-spacing, 0, spacing]
    assert sorted(cross_centers) == [round(center * 1000, 3) for center in x_centers], cross_centers
    y_centers = [-.084, -.031, .031, .084]
    edges = [
        sorted({-.12, .12} | {round(value + offset, 6) for value in values for offset in [-.012, .012]})
        for values in (x_centers, y_centers)
    ]
    midpoints = [[(a + b) / 2 for a, b in zip(axis, axis[1:])] for axis in edges]
    direction = Vector((0, 0, 1))
    sampled, overlaps = 0, 0
    for x, y, z in product(*midpoints, [.005, .015]):
        expected = set()
        if any(abs(y - center) < .012 for center in y_centers):
            expected.add("longitudinal-slats")
        if any(abs(x - center) < .012 for center in x_centers):
            expected.add("cross-slats")
        if len(expected) == 2:
            upper = next(name for name in ids if name != lower)
            expected = {lower if z < .010 else upper}
        found = set()
        for name, tree in trees.items():
            _, normal, _, _ = tree.ray_cast(Vector((x, y, z)), direction)
            if normal is not None and normal.z > .99:
                found.add(name)
        assert expected == found, (x, y, z, expected, found)
        sampled += 1
        overlaps += len(found) > 1
    assert overlaps == 0
    return {"boundsMm": bounds, "closedComponents": components, "spacingMm": spacing * 1000, "lower": lower,
            **({"edgeWidthMm":edge_width*1000,"degenerateUvTriangles":0,"cornerNormalsValid":True} if edge_width is not None else {}),
            "crossCentersMm": sorted(cross_centers), "crossings": len(x_centers) * len(y_centers), "sampledCells": sampled, "overlapCells": overlaps}


arguments = sys.argv[sys.argv.index("--") + 1:]
if arguments and arguments[0]=='--edge-widths':
    arguments=arguments[1:]
    assert len(arguments)%4==0
    variants={label:read(Path(path),float(spacing)/1000,'cross-slats',float(width)/1000)
              for label,spacing,width,path in zip(arguments[::4],arguments[1::4],arguments[2::4],arguments[3::4])}
else:
    assert len(arguments) % 3 == 0
    variants = {label: read(Path(path), float(spacing) / 1000, "cross-slats")
                for label, spacing, path in zip(arguments[::3], arguments[1::3], arguments[2::3])}
print("CENTERED_TRIVET " + json.dumps(variants))
