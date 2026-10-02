"""Real Cycles Principled anisotropy: sockets, tangent direction, pixels and reopen.

Run: Blender --background --factory-startup --python-exit-code 1 --python <this file>
All scene authoring goes through public SceneSpec + build_scene. bpy only inspects,
renders and saves/reopens the compiled result. No downloaded texture or model.
"""
import copy
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from deepblend_scene import build_scene
from deepblend_render import apply_render_overrides, render_preview
from deepblend_views import render_views
from deepblend_frames import render_frames
from deepblend_anisotropy import validate_native_material_usage
from deepblend_util import ActionError, Guard

profile = {'engine': 'cycles', 'resolution': [320, 240], 'samples': 48,
           'colorManagement': {'viewTransform': 'AgX', 'exposure': 0}, 'maxSamplesBudget': 64}
base = {
    'schemaVersion': 'deepblend.scene/v1',
    'project': {'id': 'anisotropy-proof', 'title': 'Directional metal reflection', 'units': 'metric',
                'fps': 24, 'frameStart': 1, 'frameEnd': 48, 'activeCamera': 'hero'},
    'materials': [{'id': 'metal', 'shader': 'principled',
                   'parameters': {'baseColor': [0.65, 0.52, 0.37, 1], 'metallic': 1, 'roughness': 0.36,
                                  'anisotropic': 0, 'anisotropicRotation': 0},
                   'tangent': {'mode': 'uv', 'uvMap': 'UVMap'}}],
    'entities': [{'id': 'plate', 'type': 'generator', 'generator': {'shape': 'plane', 'size': 0.48}, 'materialId': 'metal'}],
    'lights': [{'id': 'softbox', 'type': 'area', 'energy': 6, 'size': 0.035,
                'transform': {'location': [0, 0, 0.45], 'rotationEuler': [0, 0, 0]}}],
    'world': {'color': [0.025, 0.025, 0.025, 1], 'strength': 0.15},
    'cameras': [{'id': 'hero', 'lens': 45, 'sensorWidth': 36,
                 'transform': {'location': [0, 0, 0.9]}, 'targetPoint': [0, 0, 0]}],
    'shots': [{'id': 'shot', 'cameraId': 'hero', 'frameRange': [1, 48]}],
    'animationTracks': [], 'assets': [], 'renderProfiles': {'preview': profile, 'final': copy.deepcopy(profile)},
}


def shader():
    material = bpy.data.materials['db_mat__metal']
    return material, next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')


def mean_difference(first, second):
    return sum(abs(a - b) for a, b in zip(first, second)) / len(first)


def highlight_moments(pixels):
    # Compare the actual bright reflection's spread, not PNG metadata or noise alone.
    weights = [(max(0, sum(pixels[index:index + 3]) / 3 - 0.35), (index // 4) % 320, (index // 4) // 320)
               for index in range(0, len(pixels), 4)]
    total = sum(weight for weight, _, _ in weights)
    assert total > 1, 'no measurable highlight'
    cx = sum(weight * x for weight, x, _ in weights) / total
    cy = sum(weight * y for weight, _, y in weights) / total
    return [sum(weight * (x - cx) ** 2 for weight, x, _ in weights) / total,
            sum(weight * (y - cy) ** 2 for weight, _, y in weights) / total]


with tempfile.TemporaryDirectory(prefix='deepblend-anisotropy-') as temporary:
    root = Path(temporary)
    output = Path(os.environ.get('DEEPBLEND_ANISOTROPY_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)

    def compile(spec):
        report = build_scene(spec, {'project_root': str(root)}, Guard())
        bpy.context.scene.cycles.device = 'CPU'
        bpy.context.scene.cycles.seed = 17
        bpy.context.scene.cycles.use_animated_seed = False
        return report

    def render(name):
        path = output / (name + '.png')
        bpy.context.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(path), check_existing=False)
        pixels = list(image.pixels[:]); bpy.data.images.remove(image)
        return pixels

    compile(base)
    isotropic = render('isotropic')
    uv = copy.deepcopy(base)
    uv['materials'][0]['parameters']['anisotropic'] = 0.85
    compile(uv)
    material, node = shader()
    tangent = node.inputs['Tangent'].links[0].from_node
    assert tangent.type == 'TANGENT' and tangent.direction_type == 'UV_MAP' and tangent.uv_map == 'UVMap'
    assert abs(node.inputs['Anisotropic'].default_value - 0.85) < 1e-6
    uv_zero = render('uv-rotation-zero')
    rotated = copy.deepcopy(uv)
    rotated['materials'][0]['parameters']['anisotropicRotation'] = 0.25
    compile(rotated)
    assert abs(shader()[1].inputs['Anisotropic Rotation'].default_value - 0.25) < 1e-6
    uv_quarter = render('uv-rotation-quarter')
    assert mean_difference(isotropic, uv_zero) > 0.005, 'anisotropic socket has no meaningful pixel effect'
    assert mean_difference(uv_zero, uv_quarter) > 0.005, 'quarter-turn rotation has no meaningful pixel effect'
    zero_moments, quarter_moments = highlight_moments(uv_zero), highlight_moments(uv_quarter)
    assert zero_moments[0] > zero_moments[1] * 1.5, zero_moments
    assert quarter_moments[1] > quarter_moments[0] * 1.5, quarter_moments

    radial = copy.deepcopy(uv)
    radial['materials'][0]['tangent'] = {'mode': 'radial', 'axis': 'z'}
    compile(radial)
    material, node = shader()
    tangent = node.inputs['Tangent'].links[0].from_node
    assert tangent.direction_type == 'RADIAL' and tangent.axis == 'Z'
    radial_zero = render('radial-z')
    assert mean_difference(uv_zero, radial_zero) > 0.005, 'radial direction has no pixel effect'
    for axis in ('x', 'y'):
        alternate = copy.deepcopy(radial); alternate['materials'][0]['tangent']['axis'] = axis
        compile(alternate)
        assert shader()[1].inputs['Tangent'].links[0].from_node.axis == axis.upper()
    compile(radial)
    checkpoint = output / 'anisotropic-metal.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint))
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
    assert shader()[1].inputs['Tangent'].links[0].from_node.direction_type == 'RADIAL'
    reopened = render('radial-reopened')
    assert max(abs(a-b) for a,b in zip(radial_zero, reopened)) <= 1/255 + 1e-6, 'saved material graph changed its pixels'

    # Both material animation paths must reach real sockets, including enabled later.
    animated = copy.deepcopy(uv)
    animated['materials'][0]['parameters']['anisotropic'] = 0
    for property, values in [('anisotropic', [0, 0.85, 0]), ('anisotropicRotation', [0, 0.25, 0.5])]:
        animated['animationTracks'].append({'id': property, 'targetKind': 'material', 'targetEntityId': 'metal', 'property': property,
            'keyframes': [{'frame': frame, 'value': value, 'interpolation': 'linear'} for frame, value in zip([1, 24, 48], values)]})
    compile(animated)
    for frame, strength, rotation in [(1, 0, 0), (24, 0.85, 0.25), (48, 0, 0.5)]:
        bpy.context.scene.frame_set(frame)
        node = shader()[1]
        assert abs(node.inputs['Anisotropic'].default_value-strength) < 1e-6
        assert abs(node.inputs['Anisotropic Rotation'].default_value-rotation) < 1e-6
    bpy.context.scene.frame_set(24)
    animated_pixels = render('animated-quarter')
    assert mean_difference(uv_quarter, animated_pixels) < 0.001, 'animation does not reproduce the static material state'
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'animated-anisotropy.blend'))
    bpy.ops.wm.open_mainfile(filepath=str(output / 'animated-anisotropy.blend'))
    bpy.context.scene.frame_set(24)
    assert abs(shader()[1].inputs['Anisotropic'].default_value-0.85) < 1e-6
    assert abs(shader()[1].inputs['Anisotropic Rotation'].default_value-0.25) < 1e-6
    assert bpy.context.scene['deepblend_requires_cycles']
    # A saved checkpoint also guards later preview, view and final-frame engine
    # overrides, even at frame 1 where the animated anisotropy is still zero.
    checkpoint_path = str(output / 'animated-anisotropy.blend')
    bpy.context.scene.frame_set(1)
    assert abs(shader()[1].inputs['Anisotropic'].default_value) < 1e-6
    bpy.ops.wm.save_as_mainfile(filepath=checkpoint_path)
    blocked_image = str(output / 'must-not-render.png')
    attempts = [
        lambda: render_preview({'engine': 'workbench', 'frame': 1}, Guard(), checkpoint_path, blocked_image, 'hero'),
        lambda: render_views({'views': {'checkpoint': checkpoint_path, 'engine': 'workbench',
            'views': [{'id': 'blocked', 'cameraId': 'hero', 'frame': 1, 'output': blocked_image}]}}, Guard()),
        lambda: render_frames({'checkpoint': checkpoint_path, 'frames': [1], 'cameraId': 'hero',
            'outputDirectory': str(output / 'blocked-frames'), 'profile': {**profile, 'engine': 'workbench'}}, Guard()),
    ]
    for attempt in attempts:
        try:
            attempt()
            raise AssertionError('render engine override silently discarded anisotropy')
        except ActionError as error:
            assert error.code == 'SCENE_VALIDATION_FAILED' and 'Cycles' in str(error), error
        assert bpy.context.scene.render.engine == 'CYCLES', 'rejection already mutated the saved engine'
    assert not Path(blocked_image).exists() and not list((output / 'blocked-frames').glob('*.png'))

    def rejected(spec, needle):
        try:
            compile(spec)
            raise AssertionError('invalid anisotropy was silently accepted: ' + needle)
        except ActionError as error:
            assert error.code == 'SCENE_VALIDATION_FAILED' and needle in str(error), error

    missing = copy.deepcopy(uv); missing['materials'][0]['tangent']['uvMap'] = 'missing-uv'
    rejected(missing, 'UV')
    no_direction = copy.deepcopy(animated); del no_direction['materials'][0]['tangent']
    rejected(no_direction, 'tangent')
    emitter = copy.deepcopy(uv); emitter['materials'][0]['shader'] = 'emission'
    rejected(emitter, 'principled')
    no_cycles = copy.deepcopy(uv); no_cycles['renderProfiles']['preview']['engine'] = 'workbench'
    rejected(no_cycles, 'Cycles')
    unused = copy.deepcopy(base)
    unused['materials'].append({**copy.deepcopy(missing['materials'][0]), 'id': 'unused'})
    compile(unused)  # An unreferenced material's absent UV map is not a scene error.
    assert not bpy.context.scene['deepblend_requires_cycles']
    apply_render_overrides(bpy.context.scene, {'engine': 'workbench'}, Guard())
    disabled = copy.deepcopy(base); del disabled['materials'][0]['tangent']
    compile(disabled)
    assert not shader()[1].inputs['Tangent'].is_linked
    assert not bpy.context.scene['deepblend_requires_cycles']
    apply_render_overrides(bpy.context.scene, {'engine': 'workbench'}, Guard())

    # An asset without UVs can use radial direction; it must not silently fall back for UV direction.
    (root / 'no-uv.obj').write_text('v -.2 -.2 0\nv .2 -.2 0\nv .2 .2 0\nv -.2 .2 0\nf 1 2 3 4\n')
    asset = copy.deepcopy(radial)
    asset['assets'] = [{'id': 'source', 'type': 'obj', 'path': 'no-uv.obj'}]
    asset['entities'] = [{'id': 'plate', 'type': 'asset-instance', 'assetId': 'source', 'materialId': 'metal'}]
    compile(asset)
    assert all(not obj.data.uv_layers for obj in bpy.data.objects if obj.type == 'MESH')
    asset['materials'][0]['tangent'] = {'mode': 'uv', 'uvMap': 'UVMap'}
    rejected(asset, 'UV')

    # Native imported curves keep their data type and still obey the material
    # checks. Only this source fixture is authored with bpy; compile uses SceneSpec.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    curve = bpy.data.curves.new('NativeTube', 'CURVE')
    curve.dimensions = '3D'; curve.bevel_depth = 0.025; curve.bevel_resolution = 3
    curve.use_fill_caps = True
    spline = curve.splines.new('POLY'); spline.points.add(1)
    spline.points[0].co = (-0.15, 0, 0, 1); spline.points[1].co = (0.15, 0, 0, 1)
    native = bpy.data.objects.new('NativeTube', curve)
    native['fixture_role'] = 'tube'
    bpy.context.scene.collection.objects.link(native)
    assembly = bpy.data.objects.new('NativeAssembly', None)
    bpy.context.scene.collection.objects.link(assembly)
    native.parent = assembly; native.location = (0, 0.02, 0)
    for role, hide_render, hide_viewport in [('hidden-both', True, True), ('hidden-render', True, False), ('hidden-viewport', False, True)]:
        helper = bpy.data.objects.new(role, None); helper['fixture_role'] = role
        helper.hide_render = hide_render; helper.hide_viewport = hide_viewport
        helper.parent = assembly; bpy.context.scene.collection.objects.link(helper)
    orphan = bpy.data.objects.new('OrphanPrototype', curve.copy())
    orphan['fixture_role'] = 'orphan'
    source_material = bpy.data.materials.new('OriginalFinish'); source_material.diffuse_color = (0.2, 0.3, 0.4, 1)
    curve.materials.append(source_material)
    embedded = bpy.data.texts.new('untrusted.py')
    embedded.write("raise RuntimeError('import must not execute embedded source scripts')")
    embedded.use_module = True
    bpy.ops.wm.save_as_mainfile(filepath=str(root / 'native-curve.blend'))
    source_hash = hashlib.sha256((root / 'native-curve.blend').read_bytes()).hexdigest()
    # Unsupported scene/collection semantics must fail rather than exposing
    # prototypes, hidden helpers or objects from another scene.
    prototype_collection = bpy.data.collections.new('PrototypeCollection')
    prototype_collection.objects.link(orphan)
    instance = bpy.data.objects.new('CollectionInstance', None)
    instance.instance_type = 'COLLECTION'; instance.instance_collection = prototype_collection
    bpy.context.scene.collection.objects.link(instance)
    bpy.ops.wm.save_as_mainfile(filepath=str(root / 'collection-instance.blend'))
    bpy.data.objects.remove(instance, do_unlink=True)
    hidden_collection = bpy.data.collections.new('HiddenCollection')
    bpy.context.scene.collection.children.link(hidden_collection)
    hidden_collection.hide_render = True
    bpy.ops.wm.save_as_mainfile(filepath=str(root / 'hidden-collection.blend'))
    hidden_collection.hide_render = False
    bpy.context.view_layer.layer_collection.children['HiddenCollection'].exclude = True
    bpy.ops.wm.save_as_mainfile(filepath=str(root / 'excluded-collection.blend'))
    bpy.context.view_layer.layer_collection.children['HiddenCollection'].exclude = False
    extra_scene = bpy.data.scenes.new('OtherScene')
    bpy.ops.wm.save_as_mainfile(filepath=str(root / 'multiple-scenes.blend'))
    bpy.data.scenes.remove(extra_scene)
    image = bpy.data.images.new('FixtureColor', width=2, height=2)
    image.pixels[:] = [0.2, 0.5, 0.8, 1] * 4
    image.filepath_raw = str(root / 'color.png'); image.file_format = 'PNG'; image.save()
    native_spec = copy.deepcopy(radial)
    native_spec['assets'] = [{'id': 'native', 'type': 'blend', 'path': 'native-curve.blend'}]
    native_spec['entities'] = [{'id': 'native-tube', 'type': 'asset-instance', 'assetId': 'native', 'materialId': 'metal'}]
    compile(native_spec)
    preserved = next(obj for obj in bpy.data.objects if obj.type == 'CURVE')
    assert len(preserved.data.splines) == 1 and abs(preserved.data.bevel_depth - 0.025) < 1e-6
    assert preserved.material_slots[0].material == shader()[0]
    assert preserved.parent.type == 'EMPTY' and abs(preserved.location.y - 0.02) < 1e-6
    def preserved_visibility():
        objects = {obj.get('fixture_role'): obj for obj in bpy.context.scene.objects if obj.get('fixture_role')}
        assert 'orphan' not in objects
        for role, expected in [('hidden-both', (True, True)), ('hidden-render', (True, False)), ('hidden-viewport', (False, True))]:
            assert (objects[role].hide_render, objects[role].hide_viewport) == expected
            assert objects[role].parent == objects['tube'].parent
        wrapper = objects['tube'].parent.parent
        assert wrapper.get('deepblend_id') == 'native-tube' and not wrapper.hide_render and not wrapper.hide_viewport
    preserved_visibility()
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'native-anisotropy.blend'))
    bpy.ops.wm.open_mainfile(filepath=str(output / 'native-anisotropy.blend'))
    preserved = next(obj for obj in bpy.data.objects if obj.type == 'CURVE')
    assert preserved.parent.type == 'EMPTY' and abs(preserved.location.y - 0.02) < 1e-6
    assert preserved.material_slots[0].material == shader()[0]
    assert shader()[1].inputs['Tangent'].links[0].from_node.direction_type == 'RADIAL'
    assert bpy.context.scene['deepblend_requires_cycles']
    preserved_visibility()
    explicit_visible = copy.deepcopy(native_spec); explicit_visible['entities'][0]['visible'] = True
    compile(explicit_visible); preserved_visibility()
    explicit_hidden = copy.deepcopy(native_spec); explicit_hidden['entities'][0]['visible'] = False
    compile(explicit_hidden)
    assert all(obj.hide_render and obj.hide_viewport for obj in bpy.context.scene.objects if obj.get('deepblend_id') == 'native-tube')
    native_bad_uv = copy.deepcopy(native_spec)
    native_bad_uv['materials'][0]['tangent'] = {'mode': 'uv', 'uvMap': 'nonexistent-native-uv'}
    rejected(native_bad_uv, 'UV')
    native_bad_engine = copy.deepcopy(native_spec)
    native_bad_engine['renderProfiles']['preview']['engine'] = 'workbench'
    rejected(native_bad_engine, 'Cycles')
    native_unused = copy.deepcopy(native_bad_uv)
    del native_unused['entities'][0]['materialId']
    compile(native_unused)  # Unused declared anisotropy does not rewrite or reject native source material.
    preserved = next(obj for obj in bpy.data.objects if obj.type == 'CURVE')
    assert max(abs(a-b) for a,b in zip(preserved.material_slots[0].material.diffuse_color, (0.2, 0.3, 0.4, 1))) < 1e-6
    assert hashlib.sha256((root / 'native-curve.blend').read_bytes()).hexdigest() == source_hash
    native_pbr = copy.deepcopy(native_spec)
    native_pbr['materials'] = [{'id': 'metal', 'shader': 'principled', 'parameters': {'roughness': 0.4},
        'images': {'baseColor': {'assetId': 'color', 'uvMap': 'missing-native-image-uv'}}}]
    native_pbr['assets'].append({'id': 'color', 'type': 'png', 'path': 'color.png'})
    rejected(native_pbr, 'UV')
    del native_pbr['entities'][0]['materialId']
    compile(native_pbr)  # Declared image material is unused, so source UVs do not matter.
    preserved = next(obj for obj in bpy.data.objects if obj.type == 'CURVE')
    mapped = bpy.data.materials['db_mat__metal']
    preserved.data.materials.append(mapped)  # A real unused native slot also must not trigger a false rejection.
    bpy.context.view_layer.update()
    assert not validate_native_material_usage(native_pbr['materials'][0], mapped, preserved, 'CYCLES', [], bpy.context.evaluated_depsgraph_get())
    for filename, needle in [('collection-instance.blend', 'collection instances'), ('hidden-collection.blend', 'visibility'),
                             ('excluded-collection.blend', 'visibility'), ('multiple-scenes.blend', 'one scene')]:
        unsupported = copy.deepcopy(native_spec); unsupported['assets'][0]['path'] = filename
        try:
            compile(unsupported)
            raise AssertionError('unsupported blend source was silently accepted: ' + filename)
        except ActionError as error:
            assert error.code == 'ASSET_FORMAT_UNAVAILABLE' and needle in str(error), error
    bpy.data.libraries.write(str(root / 'empty.blend'), set())
    empty_asset = copy.deepcopy(native_spec); empty_asset['assets'][0]['path'] = 'empty.blend'
    try:
        compile(empty_asset)
        raise AssertionError('empty blend source was silently accepted')
    except ActionError as error:
        assert error.code == 'ASSET_MISSING', error
    facts = {'blenderVersion': bpy.app.version_string,
             'isotropicVsUV': mean_difference(isotropic, uv_zero),
             'rotationQuarterDifference': mean_difference(uv_zero, uv_quarter),
             'uvVsRadialDifference': mean_difference(uv_zero, radial_zero),
             'highlightMomentsUV': zero_moments, 'highlightMomentsQuarter': quarter_moments,
             'reopenMaxDifference': max(abs(a-b) for a,b in zip(radial_zero, reopened))}
    (output / 'anisotropy-evidence.json').write_text(json.dumps(facts, indent=2) + '\n')
    print('ANISOTROPY_PASSED: ' + json.dumps(facts))
