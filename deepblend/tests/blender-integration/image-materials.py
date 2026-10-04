"""Actual image maps: color/data interpretation, channels, packing and pixels."""
import hashlib
import copy
import struct
import zlib
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
from deepblend_images import load_packed_image
from deepblend_image_headers import check_image_header

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
    # A refused source must not allocate a decoded image or reset the scene.
    # This real 9000x1 PNG is small enough to test safely; the old loader decoded
    # it before checking its dimensions, and kept the failed datablock alive.
    oversized = bpy.data.images.new('oversized-source', width=9000, height=1)
    oversized.filepath_raw = str(root / 'oversized.png')
    oversized.file_format = 'PNG'
    oversized.save()
    bpy.data.images.remove(oversized)
    before_images = set(bpy.data.images)
    try:
        load_packed_image({'path': 'oversized.png', 'type': 'png'}, str(root))
        raise AssertionError('oversized image accepted')
    except ActionError as error:
        assert error.code == 'ASSET_CONTENT_MISMATCH' and 'before decoding' in str(error), error
    assert set(bpy.data.images) == before_images, 'refused image allocated a native datablock'
    candidate = copy.deepcopy(spec)
    candidate['assets'].append({'id': 'oversized', 'type': 'png', 'path': 'oversized.png',
                               'sha256': hashlib.sha256((root / 'oversized.png').read_bytes()).hexdigest()})
    candidate['materials'][0]['images'] = {'baseColor': {'assetId': 'oversized'}}
    before_objects = set(bpy.data.objects)
    before_scene = bpy.context.scene
    try:
        build_scene(candidate, {'project_root': str(root)}, Guard())
        raise AssertionError('oversized material accepted')
    except ActionError as error:
        assert error.code == 'ASSET_CONTENT_MISMATCH', error
    assert bpy.context.scene == before_scene and set(bpy.data.objects) == before_objects, 'budget refusal reset the scene'
    assert set(bpy.data.images) == before_images, 'scene budget allocated a native image'
    # Metadata-only oversize allocation request: never decode this synthetic
    # payload. It verifies that two bindings of one source are counted twice.
    budget_source = bytearray((root / 'oversized.png').read_bytes())
    budget_source[16:24] = struct.pack('>II', 8192, 8192)
    budget_source[29:33] = struct.pack('>I', zlib.crc32(budget_source[12:29]) & 0xffffffff)
    (root / 'budget-header.png').write_bytes(budget_source)
    candidate['assets'][-1] = {'id': 'oversized', 'type': 'png', 'path': 'budget-header.png',
                               'sha256': hashlib.sha256(budget_source).hexdigest()}
    candidate['materials'][0]['images']['roughness'] = {'assetId': 'oversized'}
    try:
        build_scene(candidate, {'project_root': str(root)}, Guard())
        raise AssertionError('aggregate image budget accepted repeated source bindings')
    except ActionError as error:
        assert error.code == 'ASSET_CONTENT_MISMATCH' and 'scene images exceed' in str(error), error
    assert bpy.context.scene == before_scene and set(bpy.data.objects) == before_objects, 'aggregate refusal reset the scene'
    assert set(bpy.data.images) == before_images, 'aggregate refusal allocated an image'
    refused_sources = []
    for name in ('oversized.png', 'budget-header.png'):
        data = (root / name).read_bytes()
        (output / name).write_bytes(data)
        refused_sources.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                                'metadataOnly': name == 'budget-header.png'})
    # Check actual native headers alongside the pure metadata fixtures. These
    # files were packed and recreated above with their original source bytes.
    for extension in ('png', 'jpg'):
        facts = check_image_header(str(root / ('color.' + extension)))
        assert facts['parts'][0]['width'] == 32 and facts['parts'][0]['height'] == 32
    (output / 'report.json').write_text(json.dumps({
        'nativeVersion': bpy.app.version_string, 'sixChannels': True, 'packedSourceRemoval': True,
        'normalPixelDifference': sum(abs(a-b) for a,b in zip(mapped, without_normal)) / len(mapped),
        'pbrPixelDifference': difference, 'packedMaxPixelDifference': max(abs(a-b) for a,b in zip(mapped, reopened)),
        'refusedSources': refused_sources, 'singleRefusalBeforeDecode': True,
        'aggregateRepeatedSourceRefusal': True, 'sceneObjectsPreserved': True,
        'imageDatablocksBefore': len(before_images), 'imageDatablocksAfter': len(bpy.data.images),
    }, indent=2) + '\n')
    print('IMAGE_MATERIALS_PASSED: six channels, colorspaces, UV transform, packed reopen without sources, pixel difference=%s' % difference)
