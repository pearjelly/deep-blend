"""Synthetic scatter regression: hidden references retain their authored poses.

No case assets, modeling recipes or rendered user projects are used here.
"""
import hashlib
import json
import os
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from deepblend_scene import build_scene
from deepblend_util import Guard, ActionError
from deepblend_scatter import apply_surface_scatter


def authored_matrix(obj):
    local = Matrix.LocRotScale(obj.location, obj.rotation_euler.to_quaternion(), obj.scale)
    return authored_matrix(obj.parent) @ obj.matrix_parent_inverse @ local if obj.parent else local


def facts(obj):
    return {'vertices': [list(v.co) for v in obj.data.vertices],
            'faces': [list(f.vertices) for f in obj.data.polygons],
            'uvs': {uv.name: [list(p.uv) for p in uv.data] for uv in obj.data.uv_layers}}


def flags(obj):
    return (obj.hide_viewport, obj.hide_render, obj.hide_get())


def source_spec(target_hidden, prototype_hidden):
    spec = json.loads((ROOT / 'deepblend/fixtures/ceramic-vessel/scene-spec.json').read_text())
    spec['entities'] = [
        {'id': 'support', 'type': 'generator', 'visible': not target_hidden,
         'materialId': 'glaze', 'generator': {'shape': 'cube', 'size': 2},
         'transform': {'location': [7, -4, 3], 'rotationEuler': [.2, .4, .7], 'scale': [1.2, .8, .6]}},
        {'id': 'prototype', 'type': 'generator', 'visible': not prototype_hidden,
         'materialId': 'glaze', 'transform': {'location': [-2, 5, 1],
         'rotationEuler': [.4, -.2, .6], 'scale': [.7, 1.1, .9]},
         'generator': {'shape': 'mesh', 'vertices': [[0, 0, 0], [.02, 0, 0], [0, .02, 0], [0, 0, .1]],
                       'faces': [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
                       'uvMap': 'FixtureUV', 'faceUvs': [[[0, 0], [1, 0], [0, 1]]] * 4},
         'modifiers': [{'type': 'surface_scatter', 'targetEntityIds': ['support'], 'count': 24,
                        'seed': 719, 'anchorVertexIndices': [0], 'embedDepthMm': 12,
                        'scaleRange': [.8, 1.2], 'upwardBias': .3}]},
    ]
    return spec


def check_attachments(prototype, target):
    metadata = json.loads(prototype['deepblend_surface_scatter'])
    inverse = authored_matrix(target).inverted()
    pose = authored_matrix(prototype)
    assert metadata['count'] == 24 and len(prototype.data.vertices) == 96
    for index, placement in enumerate(metadata['placements']):
        actual = pose @ prototype.data.vertices[index * 4].co
        assert all(abs(value) < 1 for value in inverse @ actual), 'hidden support pose was ignored'
        assert (actual - Vector(placement['anchorWorldMeters'])).length < 1e-5, 'baked mesh and world receipt disagree'


visible_reference = None
results = []
with tempfile.TemporaryDirectory(prefix='deepblend-hidden-scatter-') as temporary:
    output = Path(os.environ.get('DEEPBLEND_HIDDEN_SCATTER_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)
    for target_hidden, prototype_hidden in [(False, False), (True, False), (False, True), (True, True)]:
        build_scene(source_spec(target_hidden, prototype_hidden), {}, Guard())
        prototype = bpy.data.objects['db_entity__prototype']
        target = bpy.data.objects['db_entity__support']
        check_attachments(prototype, target)
        assert flags(target) == (target_hidden, target_hidden, False)
        assert flags(prototype) == (prototype_hidden, prototype_hidden, False)
        geometry = facts(prototype)
        if visible_reference is None:
            visible_reference = geometry
        else:
            assert geometry == visible_reference, 'visibility changed seeded scatter geometry'
        filename = output / ('scatter-%s-%s.blend' % (target_hidden, prototype_hidden))
        bpy.ops.wm.save_as_mainfile(filepath=str(filename))
        saved = hashlib.sha256(filename.read_bytes()).hexdigest()
        bpy.ops.wm.open_mainfile(filepath=str(filename), load_ui=False, use_scripts=False)
        prototype = bpy.data.objects['db_entity__prototype']
        target = bpy.data.objects['db_entity__support']
        check_attachments(prototype, target)
        assert facts(prototype) == geometry
        assert flags(target) == (target_hidden, target_hidden, False)
        assert flags(prototype) == (prototype_hidden, prototype_hidden, False)
        assert hashlib.sha256(filename.read_bytes()).hexdigest() == saved
        results.append({'targetHidden': target_hidden, 'prototypeHidden': prototype_hidden,
                        'checkpointSha256': saved, 'actualAttachmentsInsideAuthoredSupport': True,
                        'matchesVisibleSeededGeometry': True, 'saveReopenUnchanged': True})

    # Direct runtime use also retains per-view-layer and ancestor visibility,
    # including on a refusal before a new prototype mesh is published.
    build_scene(source_spec(False, False), {}, Guard())
    prototype = bpy.data.objects['db_entity__prototype']
    target = bpy.data.objects['db_entity__support']
    parent = bpy.data.objects.new('static-parent', None)
    bpy.context.scene.collection.objects.link(parent)
    parent.hide_viewport = parent.hide_render = True
    parent.location = (4, 2, -1)
    parent.rotation_euler = (.1, .2, -.3)
    parent.scale = (1.1, .8, 1.3)
    target.parent = parent
    target.hide_viewport = True
    target.hide_set(True)
    prototype.hide_set(True)
    before_flags = [flags(obj) for obj in [prototype, target, parent]]
    before_target = facts(target)
    before_pose = [(list(obj.location), list(obj.rotation_euler), list(obj.scale)) for obj in [prototype, target, parent]]
    entry = source_spec(False, False)['entities'][1]['modifiers'][0]
    # One anchor per original tetrahedron remains valid on the already emitted
    # mesh; use one new copy to bound this extra lifecycle check.
    entry = deepcopy(entry)
    entry['count'] = 1
    apply_surface_scatter(prototype, [('support', target)], entry)
    metadata = json.loads(prototype['deepblend_surface_scatter'])
    actual = authored_matrix(prototype) @ prototype.data.vertices[0].co
    assert all(abs(value) < 1 for value in authored_matrix(target).inverted() @ actual)
    assert (actual - Vector(metadata['placements'][0]['anchorWorldMeters'])).length < 1e-5
    assert [flags(obj) for obj in [prototype, target, parent]] == before_flags
    assert [(list(obj.location), list(obj.rotation_euler), list(obj.scale)) for obj in [prototype, target, parent]] == before_pose
    assert facts(target) == before_target
    original = facts(prototype)
    count = len(bpy.data.meshes)
    # Invalid target topology must restore all reference visibility too.
    import bmesh
    mesh = bmesh.new()
    mesh.from_mesh(target.data)
    mesh.faces.ensure_lookup_table()
    mesh.faces.remove(mesh.faces[0])
    mesh.to_mesh(target.data)
    mesh.free()
    try:
        apply_surface_scatter(prototype, [('support', target)], entry)
        raise AssertionError('open target was accepted')
    except ActionError:
        assert [flags(obj) for obj in [prototype, target, parent]] == before_flags
        assert facts(prototype) == original and len(bpy.data.meshes) == count
    (output / 'report.json').write_text(json.dumps({'cases': results,
        'ancestorAndLocalVisibilityPreserved': True, 'refusalRetainsPrototypeAndFlags': True,
        'scope': 'Synthetic native regression; no user case, assets or renders.'}, indent=2) + '\n')
print('HIDDEN_SCATTER_POSE_PASSED: authored world attachments, visible/hidden parity, parent/local flags, refusal, save/reopen')
