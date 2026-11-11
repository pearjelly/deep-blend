"""Inspect three saved native checkpoints for the timber workbench fixture."""
import json
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def read_timber_groups(checkpoint):
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
    groups = {}
    for obj in bpy.context.scene.objects:
        entity_id = obj.get("deepblend_id")
        if entity_id not in ("timber-x", "timber-y") or obj.type != "MESH":
            continue
        assert entity_id not in groups
        mesh = obj.data
        topology = bmesh.new()
        try:
            topology.from_mesh(mesh)
            assert all(edge.is_manifold for edge in topology.edges)
            remaining = set(topology.verts)
            components = 0
            while remaining:
                components += 1
                frontier = [remaining.pop()]
                for vertex in frontier:
                    for edge in vertex.link_edges:
                        neighbor = edge.other_vert(vertex)
                        if neighbor in remaining:
                            remaining.remove(neighbor)
                            frontier.append(neighbor)
            assert len(topology.verts) - len(topology.edges) + len(topology.faces) == 2 * components
        finally:
            topology.free()
        vertices = [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
        tree = BVHTree.FromPolygons(vertices, [tuple(face.vertices) for face in mesh.polygons])
        groups[entity_id] = (components, tree)
    assert {name: item[0] for name, item in groups.items()} == {"timber-x": 4, "timber-y": 3}
    return groups


def cells(edges):
    return [(left + right) / 2 for left, right in zip(edges, edges[1:])]


def sampled_solids(groups):
    # The analytical grid includes both boundaries of every array/mirror timber
    # and the common half-depth. No sample lies on a face.
    xs = cells([-1.3, -.4, -.18, .15, .37, .7, .92, 1.3])
    ys = cells([-.93, -.85, -.73, -.38, -.18, .18, .38, .73, .85, .93])
    direction = Vector((0, 0, 1))
    solids = {}
    for x in xs:
        for y in ys:
            for z in (.17, .27):
                inside = set()
                for name, (_, tree) in groups.items():
                    _, normal, _, _ = tree.ray_cast(Vector((x, y, z)), direction)
                    if normal is not None and normal.z > .99:
                        inside.add(name)
                solids[x, y, z] = inside
    return solids


project = Path(sys.argv[sys.argv.index("--") + 1])
before, joined, removed = [
    sampled_solids(read_timber_groups(project / "revisions" / rev / "scene.blend"))
    for rev in ("r0001", "r0002", "r0003")
]
overlap = 0
for position, previous in before.items():
    x, y, z = position
    in_x = any(lo < y < hi for lo, hi in [(-.93, -.73), (-.38, -.18), (.18, .38), (.73, .93)])
    in_y = -.85 < y < .85 and any(lo < x < hi for lo, hi in [(-.4, -.18), (.15, .37), (.7, .92)])
    expected = ({"timber-x"} if in_x else set()) | ({"timber-y"} if in_y else set())
    assert previous == expected == removed[position], position
    if len(expected) == 2:
        overlap += 1
        # The browser switches timber-x to the upper role before confirming.
        expected = {"timber-y" if z < .22 else "timber-x"}
    assert joined[position] == expected, (position, joined[position], expected)
assert overlap == 24
print("HALF_LAP_READBACK " + json.dumps({
    "sampledCells": len(before), "originalOverlapCells": overlap,
    "joinedOverlapCells": sum(len(members) == 2 for members in joined.values()),
    "closedComponents": 7, "removalRestoresOriginalSolids": True,
}))
