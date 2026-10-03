"""Actual image maps: color/data interpretation, channels, packing and pixels."""
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
from deepblend_util import Guard, ActionError

with tempfile.TemporaryDirectory(prefix='deepblend-pbr-') as temporary:
    root = Path(temporary)
    output = Path(os.environ.get('DEEPBLEND_PBR_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)
    for name in ['color', 'data', 'normal']:
        image = bpy.data.images.new(name, width=32, height=32)
        image.colorspace_settings.name = 'sRGB' if name == 'color' else 'Non-Color'
        pixels = []
        for y in range(32):
            for x in range(32):
                if name == 'color':
                    color = [.8, .08, .01, 1] if (x // 8 + y // 8) % 2 else [.01, .08, .8, 1]
                elif name == 'data':
                    color = [.35, .15, .85, 1]
                else:
                    color = [.7 if x % 8 < 4 else .3, .5, .958, 1]
                pixels.extend(color)
        image.pixels[:] = pixels
        image.filepath_raw = str(root / (name + '.png'))
        image.file_format = 'PNG'
        image.save()
    spec = json.loads((ROOT / 'deepblend/fixtures/ceramic-vessel/scene-spec.json').read_text())
    jpeg = bpy.data.images.load(str(root / 'color.png'))
    assert len(jpeg.pixels[:]) == 32 * 32 * 4
    jpeg.filepath_raw = str(root / 'color.jpg')
    jpeg.file_format = 'JPEG'
    jpeg.save()
    spec['assets'] = [{'id': name, 'type': 'png', 'path': name + '.png',
                       'sha256': hashlib.sha256((root / (name + '.png')).read_bytes()).hexdigest()}
                      for name in ['color', 'data', 'normal']]
    spec['assets'].append({'id': 'jpeg', 'type': 'jpg', 'path': 'color.jpg',
                           'sha256': hashlib.sha256((root / 'color.jpg').read_bytes()).hexdigest()})
    spec['renderProfiles']['preview']['resolution'] = [480, 360]
    spec['renderProfiles']['preview']['samples'] = 24
    def render(name):
        bpy.context.scene.cycles.device = 'CPU'
        path = output / (name + '.png')
        bpy.context.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        readback = bpy.data.images.load(str(path), check_existing=False)
        pixels = list(readback.pixels[:])
        bpy.data.images.remove(readback)
        return pixels
    build_scene(spec, {'project_root': str(root)}, Guard())
    plain = render('plain')
    glaze = next(material for material in spec['materials'] if material['id'] == 'glaze')
    glaze.pop('texture', None)
    glaze['parameters']['emissionStrength'] = .05
    glaze['images'] = {
        'baseColor': {'assetId': 'color', 'scale': [2, 1, 1], 'offset': [.1, 0, 0]},
        'roughness': {'assetId': 'data', 'channel': 'g'},
        'metallic': {'assetId': 'data', 'channel': 'r'},
        'normal': {'assetId': 'normal', 'strength': .6},
        'alpha': {'assetId': 'data', 'channel': 'a'},
        'emissionColor': {'assetId': 'jpeg'},
    }
    build_scene(spec, {'project_root': str(root)}, Guard())
    material = bpy.data.materials['db_mat__glaze']
    shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    sockets = {'baseColor': 'Base Color', 'roughness': 'Roughness', 'metallic': 'Metallic',
               'normal': 'Normal', 'alpha': 'Alpha', 'emissionColor': 'Emission Color'}
    for channel, socket in sockets.items():
        assert shader.inputs[socket].is_linked, (channel, socket)
        image = material.node_tree.nodes['db_image_' + channel].image
        expected = 'sRGB' if channel in ('baseColor', 'emissionColor') else 'Non-Color'
        assert image.colorspace_settings.name == expected
        assert image.packed_file is not None
    assert shader.inputs['Roughness'].links[0].from_socket.name == 'Green'
    assert shader.inputs['Alpha'].links[0].from_socket.name == 'Alpha'
    normal = shader.inputs['Normal'].links[0].from_node
    assert normal.type == 'NORMAL_MAP' and abs(normal.inputs['Strength'].default_value - .6) < 1e-6
    color = material.node_tree.nodes['db_image_baseColor']
    mapping = color.inputs['Vector'].links[0].from_node
    assert list(mapping.inputs['Scale'].default_value) == [2, 1, 1]
    mapped = render('image-pbr')
    difference = sum(abs(a-b) for a,b in zip(plain, mapped)) / len(mapped)
    assert difference > .02, difference
    normal_link = shader.inputs['Normal'].links[0]
    material.node_tree.links.remove(normal_link)
    without_normal = render('without-normal')
    assert sum(abs(a-b) for a,b in zip(mapped, without_normal)) / len(mapped) > .001, 'normal map has no visible effect'
    material.node_tree.links.new(normal.outputs['Normal'], shader.inputs['Normal'])
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'image-pbr.blend'))
    for asset in spec['assets']:
        (root / asset['path']).unlink()
    bpy.ops.wm.open_mainfile(filepath=str(output / 'image-pbr.blend'))
    reopened = render('packed-reopened')
    assert max(abs(a-b) for a,b in zip(mapped, reopened)) < 1/255 + 1e-6
    # Recreate sources from the packed images, then exercise the actual compiler
    # rejection for a UV layer name that does not exist on the vessel.
    for image in bpy.data.images:
        if image.packed_file:
            target = root / Path(image.filepath).name
            target.write_bytes(bytes(image.packed_file.data))
    glaze['images']['baseColor']['uvMap'] = 'missing-uv'
    try:
        build_scene(spec, {'project_root': str(root)}, Guard())
        raise AssertionError('missing UV map silently accepted')
    except ActionError as error:
        assert error.code == 'SCENE_VALIDATION_FAILED' and 'UV' in str(error), error
    print('IMAGE_MATERIALS_PASSED: six channels, colorspaces, UV transform, packed reopen without sources, pixel difference=%s' % difference)
