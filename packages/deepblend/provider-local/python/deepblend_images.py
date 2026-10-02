"""Image PBR maps with explicit data/color handling and packed checkpoints."""
import os
import bpy
from deepblend_util import ActionError

SOCKETS = {'baseColor': 'Base Color', 'roughness': 'Roughness', 'metallic': 'Metallic',
           'normal': 'Normal', 'alpha': 'Alpha', 'emissionColor': 'Emission Color'}


def validate_image_uv_usage(spec, obj, layers):
    """Validate named/default UV on a surface that actually uses this material."""
    for binding in (spec.get('images') or {}).values():
        uv_name = binding.get('uvMap')
        if layers is None or not layers or (uv_name and layers.get(uv_name) is None):
            raise ActionError('SCENE_VALIDATION_FAILED', 'image material requires an existing UV map on the used surface',
                              {'entityId': obj.get('deepblend_id'), 'partId': obj.get('deepblend_part_id'), 'uvMap': uv_name})


def load_packed_image(asset, project_root, colorspace=None):
    root = os.path.realpath(project_root or '.')
    path = os.path.realpath(os.path.join(root, asset['path']))
    if os.path.commonpath([root, path]) != root:
        raise ActionError('PATH_OUTSIDE_WORKSPACE', 'image asset escapes the project directory')
    try:
        image = bpy.data.images.load(path, check_existing=False)
        if min(image.size) <= 0 or max(image.size) > 8192:
            raise ValueError('image dimensions must be between 1 and 8192 pixels')
        if colorspace is not None:
            image.colorspace_settings.name = colorspace
        image.pack()
        return image
    except Exception as error:
        raise ActionError('ASSET_CONTENT_MISMATCH', 'cannot load image asset: %s' % error)


def build_environment(world, background, environment, assets, project_root):
    asset = assets.get(environment['assetId'])
    if asset is None or asset.get('type') not in ('png', 'jpg', 'jpeg', 'hdr', 'exr'):
        raise ActionError('ASSET_FORMAT_UNAVAILABLE', 'environment requires a declared image asset')
    # Declare interpretation rather than inherit loader defaults: those can be
    # sRGB even for float images. This contract expects linear Rec.709 HDR/EXR.
    image = load_packed_image(asset, project_root,
                              'sRGB' if asset['type'] in ('png', 'jpg', 'jpeg') else 'Linear Rec.709')
    nodes, links = world.node_tree.nodes, world.node_tree.links
    texture = nodes.new('ShaderNodeTexEnvironment')
    texture.name = 'db_environment'
    texture.image = image
    texture.projection = 'EQUIRECTANGULAR'
    coordinates = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Rotation'].default_value[2] = environment.get('rotation', 0)
    links.new(coordinates.outputs['Generated'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], texture.inputs['Vector'])
    links.new(texture.outputs['Color'], background.inputs['Color'])
    return {'width': int(image.size[0]), 'height': int(image.size[1]),
            'channels': int(image.channels), 'isFloat': bool(image.is_float),
            'colorSpace': image.colorspace_settings.name}


def build_image_maps(material, principled, bindings, assets, project_root):
    nodes, links = material.node_tree.nodes, material.node_tree.links
    for channel, binding in bindings.items():
        asset = assets.get(binding['assetId'])
        if asset is None or asset.get('type') not in ('png', 'jpg', 'jpeg'):
            raise ActionError('ASSET_FORMAT_UNAVAILABLE', 'PBR maps require declared PNG or JPEG assets')
        # Independent datablocks allow the same source to serve color and data.
        image = load_packed_image(asset, project_root,
                                  'sRGB' if channel in ('baseColor', 'emissionColor') else 'Non-Color')
        texture = nodes.new('ShaderNodeTexImage')
        texture.name = 'db_image_' + channel
        texture.image = image
        texture.extension = 'REPEAT'
        texture.interpolation = 'Linear'
        uv = nodes.new('ShaderNodeUVMap')
        uv.uv_map = binding.get('uvMap', '')
        mapping = nodes.new('ShaderNodeMapping')
        mapping.inputs['Scale'].default_value = binding.get('scale', [1, 1, 1])
        mapping.inputs['Location'].default_value = binding.get('offset', [0, 0, 0])
        links.new(uv.outputs['UV'], mapping.inputs['Vector'])
        links.new(mapping.outputs['Vector'], texture.inputs['Vector'])
        source = texture.outputs['Color']
        if channel == 'normal':
            normal = nodes.new('ShaderNodeNormalMap')
            normal.space = 'TANGENT'
            normal.uv_map = binding.get('uvMap', '')
            normal.inputs['Strength'].default_value = binding.get('strength', 1)
            links.new(source, normal.inputs['Color'])
            source = normal.outputs['Normal']
        elif channel in ('roughness', 'metallic', 'alpha'):
            selected = binding.get('channel', 'r')
            if selected == 'a':
                source = texture.outputs['Alpha']
            else:
                separate = nodes.new('ShaderNodeSeparateColor')
                separate.mode = 'RGB'
                links.new(source, separate.inputs['Color'])
                source = separate.outputs[{'r': 'Red', 'g': 'Green', 'b': 'Blue'}[selected]]
        links.new(source, principled.inputs[SOCKETS[channel]])
