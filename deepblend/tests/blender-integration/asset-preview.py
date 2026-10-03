"""Real asset-preview inventory and environment reports through public actions.

Run with pinned Blender --background --factory-startup --python-exit-code 1
--python <this file>. DEEPBLEND_ASSET_PREVIEW_OUTPUT retains all generated proof.
bpy authors the self-contained source assets and inspects checkpoints; production
compilation and previews use action_compile_scene / render_preview unchanged.
"""
import copy
import hashlib
import json
import math
import os
import struct
import sys
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from bootstrap import action_compile_scene, write_checkpoint
from deepblend_scene import describe_objects, reset_scene
from deepblend_render import render_preview
from deepblend_util import Guard

checks = []


def check(label, condition):
    assert condition, label
    checks.append(label)
    print('PASS: ' + label, flush=True)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def edit_glb(path):
    raw = path.read_bytes()
    chunks, offset = [], 12
    while offset < len(raw):
        length, kind = struct.unpack_from('<II', raw, offset)
        payload = raw[offset + 8:offset + 8 + length]
        if kind == 0x4E4F534A:
            document = json.loads(payload)
            primitives = document['meshes'][0]['primitives']
            assert len(primitives) == 2
            # glTF's absent material is an actual empty Blender slot. Force both
            # UV channels into each primitive, without relying on export pruning.
            primitives[1].pop('material')
            for primitive in primitives:
                primitive['attributes']['TEXCOORD_1'] = primitive['attributes']['TEXCOORD_0']
            payload = json.dumps(document, separators=(',', ':')).encode()
            payload += b' ' * (-len(payload) % 4)
        chunks.append(struct.pack('<II', len(payload), kind) + payload)
        offset += 8 + length
    body = b''.join(chunks)
    path.write_bytes(struct.pack('<4sII', b'glTF', 2, len(body) + 12) + body)


def base_spec():
    profile = {'engine': 'cycles', 'resolution': [256, 192], 'samples': 8,
               'maxSamplesBudget': 16, 'colorManagement': {'viewTransform': 'AgX', 'exposure': 0}}
    return {'schemaVersion': 'deepblend.scene/v1',
            'project': {'id': 'asset-preview-proof', 'title': 'Isolated asset inspection', 'units': 'metric',
                        'fps': 24, 'frameStart': 1, 'frameEnd': 2, 'activeCamera': 'hero'},
            'entities': [], 'assets': [], 'materials': [], 'animationTracks': [],
            'lights': [{'id': 'key', 'type': 'area', 'energy': 150, 'size': 2,
                        'transform': {'location': [2, 0, 4], 'rotationEuler': [0, 0, 0]}}],
            'cameras': [{'id': 'hero', 'lens': 45, 'sensorWidth': 36,
                         'transform': {'location': [4, -3, 3]}, 'targetPoint': [1.6, 1.7, .8]}],
            'shots': [{'id': 'still', 'cameraId': 'hero', 'frameRange': [1, 2]}],
            'renderProfiles': {'preview': profile, 'final': copy.deepcopy(profile)},
            'world': {'color': [.04, .04, .04, 1], 'strength': .4}}


with tempfile.TemporaryDirectory(prefix='deepblend-asset-preview-') as temporary:
    output = Path(os.environ.get('DEEPBLEND_ASSET_PREVIEW_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)
    source = output / 'sources'
    source.mkdir()

    def compile_case(name, spec):
        document = output / (name + '.scene-spec.json')
        checkpoint = output / (name + '.blend')
        document.write_text(json.dumps(spec, indent=2) + '\n')
        payload, warnings, notices = action_compile_scene({}, {
            'scene_spec': str(document), 'output_blend': str(checkpoint), 'project_root': str(source), 'profile': 'preview'})
        (output / (name + '.compile.json')).write_text(json.dumps(payload, indent=2) + '\n')
        return payload, checkpoint

    def render_case(name, checkpoint):
        path = output / (name + '.png')
        report = render_preview({'width': 256, 'height': 192, 'samples': 8, 'frame': 1, 'engine': 'cycles'},
                                Guard(), str(checkpoint), str(path), 'hero')
        check(name + ': actual preview dimensions and frame',
              [report['width'], report['height'], report['frame']] == [256, 192, 1])
        image = bpy.data.images.load(str(path), check_existing=False)
        pixels = list(image.pixels[:])
        check(name + ': PNG has finite, nonconstant pixels',
              all(math.isfinite(value) for value in pixels) and max(pixels[::4]) - min(pixels[::4]) > .05)
        bpy.data.images.remove(image)
        (output / (name + '.render.json')).write_text(json.dumps(report, indent=2) + '\n')
        return report

    # Self-contained GLB with rotated/scaled nested parents, two materials, and
    # two UV attributes. The empty slot is encoded in GLB itself above.
    reset_scene()
    parent = bpy.data.objects.new('assembly', None)
    bpy.context.scene.collection.objects.link(parent)
    parent.location = (.4, -.2, .3)
    parent.rotation_euler.z = .42
    parent.scale = (1.2, .8, 1.1)
    nested = bpy.data.objects.new('nested', None)
    bpy.context.scene.collection.objects.link(nested)
    nested.parent = parent
    nested.location = (0, .1, .12)
    nested.rotation_euler.x = .2
    bpy.ops.mesh.primitive_cube_add(size=.4)
    body = bpy.context.object
    body.name = 'body'
    body.parent = nested
    body.location.z = .2
    for index, color in enumerate(((.7, .05, .02, 1), (.3, .3, .3, 1))):
        material = bpy.data.materials.new('source-' + str(index))
        material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = color
        body.data.materials.append(material)
    for polygon in body.data.polygons:
        polygon.material_index = polygon.index % 2
    model = source / 'nested.glb'
    bpy.ops.export_scene.gltf(filepath=str(model), export_format='GLB')
    edit_glb(model)
    model_sha = sha(model)
    spec = base_spec()
    spec['assets'] = [{'id': 'model', 'type': 'glb', 'path': model.name, 'sha256': model_sha}]
    spec['entities'] = [
        {'id': 'model', 'type': 'asset-instance', 'assetId': 'model',
         'transform': {'location': [1, 2, .1], 'scale': [1.5, 1.5, 1.5]}},
        {'id': 'hidden-helper', 'type': 'generator', 'generator': {'shape': 'cube', 'size': 1},
         'visible': False, 'transform': {'location': [100, 100, 100]}},
    ]
    payload, checkpoint = compile_case('model', spec)
    entry = next(item for item in payload['objects'] if item['deepblendId'] == 'model' and item['type'] == 'MESH')
    obj = bpy.data.objects[entry['name']]
    vertices = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    check('nested GLB: world bounds include parent and instance transforms',
          all(abs(entry['worldBounds'][key][axis] - operation(vertex[axis] for vertex in vertices)) < 1e-5
              for key, operation in [('min', min), ('max', max)] for axis in range(3)))
    check('nested GLB: bounds frame is the actual checkpoint frame', entry['boundsFrame'] == bpy.context.scene.frame_current)
    wrapper = next(item for item in payload['objects'] if item['name'] == 'db_entity__model')
    check('instance wrapper is never a zero-size geometric bound', wrapper['worldBounds'] is None)
    helper = next(item for item in payload['objects'] if item['deepblendId'] == 'hidden-helper')
    check('hidden helper never reports a stale evaluated bound or affects preview framing',
          helper['worldBounds'] is None and helper['boundsUnavailable'] == 'viewport-disabled'
          and helper['evaluatedUvMaps'] is None and helper['renderVisible'] is False and entry['renderVisible'] is True)
    check('GLB original and current material slots preserve the empty index',
          len(entry['sourceMaterialSlots']) == 2 and entry['sourceMaterialSlots'][1]['materialName'] is None
          and entry['materialSlots'][1]['index'] == 1 and entry['materialSlots'][1]['materialName'] is None
          and entry['materialSlots'][1]['materialId'] is None)
    check('both material slots report actual used polygon counts',
          all(slot['usedPolygonCount'] > 0 for slot in entry['materialSlots'])
          and sum(slot['usedPolygonCount'] for slot in entry['materialSlots']) == entry['polygonCount'])
    check('both original UV layers are reported without inventing an unwrap verdict',
          len(entry['uvMaps']) == 2 and all(layer['source'] == 'mesh-data' and layer['finite']
              and layer['loopCount'] == len(obj.data.loops) for layer in entry['uvMaps']))
    check('evaluated UV evidence is labeled separately',
          len(entry['evaluatedUvMaps']) == 2 and all(layer['source'] == 'evaluated-mesh' and layer['finite']
              for layer in entry['evaluatedUvMaps']))
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
    reopened = next(item for item in describe_objects() if item['name'] == entry['name'])
    check('inventory survives saved checkpoint reopen', reopened == entry)
    render_case('model', checkpoint)
    check('model source hash is unchanged by compile, save, reopen and render', sha(model) == model_sha)

    # A real un-applied modifier proves that inventory measures evaluated bounds,
    # while slot counts and original UV are explicitly still source mesh data.
    obj = bpy.data.objects[entry['name']]
    modifier = obj.modifiers.new('inventory-array', 'ARRAY')
    modifier.count = 2
    modifier.use_relative_offset = False
    modifier.use_constant_offset = True
    modifier.constant_offset_displace = (.8, 0, 0)
    bpy.context.view_layer.update()
    evaluated_entry = next(item for item in describe_objects() if item['name'] == obj.name)
    check('unapplied modifier changes evaluated bounds and UV loop count',
          evaluated_entry['worldBounds']['max'][0] > entry['worldBounds']['max'][0] + .5
          and evaluated_entry['evaluatedUvMaps'][0]['loopCount'] == 2 * entry['uvMaps'][0]['loopCount']
          and evaluated_entry['uvMaps'] == entry['uvMaps'])
    obj.hide_viewport = True
    viewport_hidden = next(item for item in describe_objects() if item['name'] == obj.name)
    check('viewport-only hiding does not mean render-hidden or authorize stale evaluated facts',
          not viewport_hidden['visible'] and viewport_hidden['renderVisible']
          and viewport_hidden['worldBounds'] is None and viewport_hidden['evaluatedUvMaps'] is None)
    obj.hide_viewport = False
    obj.visible_camera = False
    check('camera ray visibility is reflected in render eligibility',
          not next(item for item in describe_objects() if item['name'] == obj.name)['renderVisible'])
    obj.visible_camera = True
    layer = obj.data.uv_layers[0]
    previous = layer.data[0].uv.copy()
    layer.data[0].uv.x = float('nan')
    check('non-finite original UV is reported explicitly',
          not next(item for item in describe_objects() if item['name'] == obj.name)['uvMaps'][0]['finite'])
    layer.data[0].uv = previous

    # Source radiance above one must remain floating point. Only the displayed
    # PNG is tone mapped; source bytes and packed checkpoint radiance survive.
    reset_scene()
    pixels = []
    for y in range(32):
        for x in range(64):
            pixels.extend([18, 12, 7, 1] if 8 < x < 20 and 12 < y < 27 else [.04, .05, .08, 1])
    for extension, format_name in [('hdr', 'HDR'), ('exr', 'OPEN_EXR')]:
        image = bpy.data.images.new('studio-' + extension, width=64, height=32, float_buffer=True)
        image.colorspace_settings.name = 'Linear Rec.709'
        image.pixels[:] = pixels
        bpy.context.scene.render.image_settings.file_format = format_name
        path = source / ('studio.' + extension)
        image.save_render(str(path), scene=bpy.context.scene)
    for extension in ['hdr', 'exr']:
        path = source / ('studio.' + extension)
        original_sha = sha(path)
        environment = base_spec()
        environment['assets'] = [{'id': 'environment', 'type': extension, 'path': path.name, 'sha256': original_sha}]
        environment['world'] = {'strength': .6, 'environment': {'assetId': 'environment', 'rotation': .25}}
        environment['lights'] = []
        environment['materials'] = [
            {'id': 'matte', 'shader': 'principled', 'parameters': {'baseColor': [.5, .5, .5, 1], 'roughness': .7}},
            {'id': 'metal', 'shader': 'principled', 'parameters': {'baseColor': [.7, .7, .7, 1], 'roughness': .15, 'metallic': 1}},
        ]
        environment['entities'] = [
            {'id': name, 'type': 'generator', 'generator': {'shape': 'uv_sphere', 'radius': .12},
             'materialId': name, 'transform': {'location': [x, 0, .13]}}
            for name, x in [('matte', -.15), ('metal', .15)]]
        environment['entities'].append({'id': 'floor', 'type': 'generator', 'generator': {'shape': 'plane', 'size': 2}, 'materialId': 'matte'})
        environment['cameras'][0].update({'transform': {'location': [.75, -.9, .55]}, 'targetPoint': [0, 0, .13]})
        payload, checkpoint = compile_case('environment-' + extension, environment)
        facts = payload['world']['environment']['image']
        actual_image = bpy.context.scene.world.node_tree.nodes['db_environment'].image
        check(extension + ': compile action exposes actual image facts', facts == {
            'width': 64, 'height': 32, 'channels': actual_image.channels,
            'isFloat': True, 'colorSpace': 'Linear Rec.709'})
        check(extension + ': reported environment keeps declared rotation and identity',
              payload['world']['environment']['assetId'] == 'environment' and payload['world']['environment']['rotation'] == .25)
        check(extension + ': checkpoint has packed radiance above one', actual_image.packed_file is not None and max(actual_image.pixels[:]) > 17)
        render_case('environment-' + extension, checkpoint)
        reopened_image = bpy.context.scene.world.node_tree.nodes['db_environment'].image
        check(extension + ': render reopening preserves floating point radiance and interpretation',
              reopened_image.is_float and max(reopened_image.pixels[:]) > 17 and reopened_image.colorspace_settings.name == 'Linear Rec.709')
        check(extension + ': original source bytes remain unchanged', sha(path) == original_sha)

    files = {str(path.relative_to(output)): sha(path) for path in output.rglob('*') if path.is_file()}
    (output / 'verification.json').write_text(json.dumps({'status': 'technical-artifact-pass',
        'blenderVersion': bpy.app.version_string, 'checks': checks, 'passed': len(checks), 'files': files}, indent=2) + '\n')
    print('ASSET_PREVIEW_PASSED: %d checks; %s' % (len(checks), output), flush=True)
