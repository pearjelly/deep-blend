"""Read a saved speaker checkpoint and report evaluated weave surface crossings.

Usage: blender -b --python inspect-speaker-weave.py -- speaker.blend report.json
This does not write the checkpoint or certify manufacturing tolerances.
"""
import hashlib
import itertools
import json
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils.bvhtree import BVHTree


def mesh_tree(mesh):
    return BVHTree.FromBMesh(mesh)


def crossing_control():
    mesh = bmesh.new()
    points = [(-1, 0, 0), (1, 0, 0), (0, 1, 0),
              (0, -.5, -1), (0, -.5, 1), (0, .75, 0)]
    vertices = [mesh.verts.new(point) for point in points]
    mesh.faces.new(vertices[:3])
    mesh.faces.new(vertices[3:])
    mesh.faces.ensure_lookup_table()
    mesh.faces.index_update()
    detected = (0, 1) in mesh_tree(mesh).overlap(mesh_tree(mesh))
    mesh.free()
    assert detected, 'Known intersecting triangles must be detected'
    return detected


checkpoint, output = sys.argv[sys.argv.index('--') + 1:]
checkpoint = Path(checkpoint).resolve()
before = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
control = crossing_control()
bpy.ops.wm.open_mainfile(filepath=str(checkpoint), load_ui=False)
bpy.context.scene.frame_set(1)
graph = bpy.context.evaluated_depsgraph_get()
ids = ['grille-warp-0', 'grille-warp-1', 'grille-weft']
trees, records = {}, []
for entity_id in ids:
    obj = bpy.data.objects['db_entity__' + entity_id].evaluated_get(graph)
    data = obj.to_mesh()
    mesh = bmesh.new()
    mesh.from_mesh(data)
    mesh.transform(obj.matrix_world)
    bmesh.ops.triangulate(mesh, faces=list(mesh.faces))
    mesh.verts.ensure_lookup_table()
    mesh.verts.index_update()
    mesh.faces.ensure_lookup_table()
    mesh.faces.index_update()
    faces = [set(vertex.index for vertex in face.verts) for face in mesh.faces]
    tree = mesh_tree(mesh)
    # Independent trees are necessary: comparing the same BVH instance with itself
    # can return no candidates and make a broken detector appear successful.
    self_pairs = tree.overlap(mesh_tree(mesh))
    crossings = [(a, b) for a, b in self_pairs
                 if a < b and faces[a].isdisjoint(faces[b])]
    records.append({'id': entity_id, 'triangles': len(mesh.faces),
                    'boundaryEdges': sum(edge.is_boundary for edge in mesh.edges),
                    'nonManifoldEdges': sum(not edge.is_manifold for edge in mesh.edges),
                    'signedVolume': mesh.calc_volume(signed=True),
                    'selfCandidates': len(self_pairs),
                    'nonadjacentSelfSurfacePairs': len(crossings)})
    trees[entity_id] = tree
    mesh.free()
    obj.to_mesh_clear()
pairs = [{'entities': [a, b], 'surfaceTrianglePairs': len(trees[a].overlap(trees[b]))}
         for a, b in itertools.combinations(ids, 2)]
assert hashlib.sha256(checkpoint.read_bytes()).hexdigest() == before
report = {'checkpointSha256': before, 'frame': 1, 'blenderVersion': bpy.app.version_string,
          'knownCrossingControlDetected': control, 'meshes': records, 'pairs': pairs,
          'scope': 'Evaluated triangulated surfaces including array and circular trim; '
                   'adjacent faces excluded from self checks. No volume penetration '
                   'or global minimum-wall measurement; checkpoint unchanged.'}
Path(output).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
