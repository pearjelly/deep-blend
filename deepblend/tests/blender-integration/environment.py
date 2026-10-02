"""HDR/EXR radiance, orientation, lighting and packed checkpoint round trip."""
import hashlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path
import bpy
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'packages/deepblend/provider-local/python'))
from deepblend_scene import build_scene
from deepblend_util import Guard

with tempfile.TemporaryDirectory(prefix='deepblend-environment-') as temporary:
    root = Path(temporary)
    output = Path(os.environ.get('DEEPBLEND_ENV_OUTPUT', temporary))
    output.mkdir(parents=True, exist_ok=True)
    pixels = []
    for y in range(128):
        for x in range(256):
            color = [.04, .05, .08, 1]
            if 30 < x < 65 and 60 < y < 105:
                color = [18, 12, 7, 1]
            elif 145 < x < 195 and 50 < y < 85:
                color = [4, 7, 12, 1]
            pixels.extend(color)
    for extension, format_name in [('exr', 'OPEN_EXR'), ('hdr', 'HDR')]:
        image = bpy.data.images.new('studio-' + extension, width=256, height=128, float_buffer=True)
        image.colorspace_settings.name = 'Linear Rec.709'
        image.pixels[:] = pixels
        bpy.context.scene.render.image_settings.file_format = format_name
        image.save_render(str(root / ('studio.' + extension)), scene=bpy.context.scene)
    spec = json.loads((ROOT / 'deepblend/fixtures/ceramic-vessel/scene-spec.json').read_text())
    spec['assets'] = [{'id': extension, 'type': extension, 'path': 'studio.' + extension,
                       'sha256': hashlib.sha256((root / ('studio.' + extension)).read_bytes()).hexdigest()}
                      for extension in ['hdr', 'exr']]
    spec['lights'] = []
    spec['world'] = {'strength': .6, 'environment': {'assetId': 'exr', 'rotation': 0}}
    glaze = next(material for material in spec['materials'] if material['id'] == 'glaze')
    glaze.pop('texture', None)
    glaze['parameters'] = {'baseColor': [.8, .8, .8, 1], 'metallic': .9, 'roughness': .16}
    spec['renderProfiles']['preview']['resolution'] = [480, 360]
    spec['renderProfiles']['preview']['samples'] = 32
    def render(name):
        bpy.context.scene.cycles.device = 'CPU'
        path = output / (name + '.png')
        bpy.context.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(path), check_existing=False)
        result = list(image.pixels[:])
        bpy.data.images.remove(image)
        return result
    def difference(a, b):
        return sum(abs(x-y) for x,y in zip(a,b))/len(a)
    build_scene(spec, {'project_root': str(root)}, Guard())
    environment = bpy.context.scene.world.node_tree.nodes['db_environment']
    assert environment.type == 'TEX_ENVIRONMENT' and environment.projection == 'EQUIRECTANGULAR'
    assert max(environment.image.pixels[:]) > 17, ('HDR radiance was clipped', max(environment.image.pixels[:]), environment.image.is_float)
    assert environment.image.colorspace_settings.name == 'Linear Rec.709', environment.image.colorspace_settings.name
    original = render('environment-zero')
    spec['world']['environment']['assetId'] = 'hdr'
    build_scene(spec, {'project_root': str(root)}, Guard())
    assert max(bpy.context.scene.world.node_tree.nodes['db_environment'].image.pixels[:]) > 17
    hdr = render('environment-hdr')
    assert difference(original, hdr) < .02, difference(original,hdr)
    spec['world']['environment']['rotation'] = math.pi / 2
    build_scene(spec, {'project_root': str(root)}, Guard())
    mapping = bpy.context.scene.world.node_tree.nodes['db_environment'].inputs['Vector'].links[0].from_node
    assert abs(mapping.inputs['Rotation'].default_value[2] - math.pi/2) < 1e-6
    rotated = render('environment-rotated')
    assert difference(original, rotated) > .02, 'orientation did not affect pixels'
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'environment.blend'))
    background = bpy.context.scene.world.node_tree.nodes.get('Background')
    background.inputs['Strength'].default_value = 0
    dark = render('environment-off')
    assert difference(rotated, dark) > .05, 'environment did not light the scene'
    for asset in spec['assets']:
        (root / asset['path']).unlink()
    bpy.ops.wm.open_mainfile(filepath=str(output / 'environment.blend'))
    reopened = render('environment-packed')
    assert max(abs(a-b) for a,b in zip(rotated,reopened)) < 1/255 + 1e-6
    print('ENVIRONMENT_PASSED: EXR/HDR radiance, rotation, environment-only lighting, packed reopen without source')
