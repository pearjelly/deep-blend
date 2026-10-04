"""Image PBR maps with explicit data/color handling and packed checkpoints."""
import os
import bpy
from deepblend_util import ActionError
from deepblend_image_headers import check_image_header, MAX_IMAGE_DECODE_BYTES

SOCKETS = {'baseColor': 'Base Color', 'roughness': 'Roughness', 'metallic': 'Metallic',
           'normal': 'Normal', 'alpha': 'Alpha', 'emissionColor': 'Emission Color'}


def image_asset_path(asset, project_root):
    root = os.path.realpath(project_root or '.')
    path = os.path.realpath(os.path.join(root, asset['path']))
    if os.path.commonpath([root, path]) != root:
        raise ActionError('PATH_OUTSIDE_WORKSPACE', 'image asset escapes the project directory')
    return path


def check_scene_image_budget(spec, project_root):
    """Count declared image datablocks before scene reset or native decode.

    Color and data bindings create separate datablocks even for one source; a
    cache of header facts must not collapse their allocation costs. Imported
    model textures require their own preflight and are not counted here.
    """
    assets = {asset['id']: asset for asset in spec.get('assets') or []}
    bindings = []
    environment = (spec.get('world') or {}).get('environment')
    if environment:
        bindings.append((environment, ('png', 'jpg', 'jpeg', 'hdr', 'exr')))
    for material in spec.get('materials') or []:
        for binding in (material.get('images') or {}).values():
            bindings.append((binding, ('png', 'jpg', 'jpeg')))
    total, facts = 0, {}
    for binding, formats in bindings:
        asset = assets.get(binding['assetId'])
        if asset is None or asset.get('type') not in formats:
            raise ActionError('ASSET_FORMAT_UNAVAILABLE', 'image binding requires a declared image asset')
        path = image_asset_path(asset, project_root)
        if path not in facts:
            facts[path] = check_image_header(path)
        total += facts[path]['decodedBytes']
        if total > MAX_IMAGE_DECODE_BYTES:
            raise ActionError('ASSET_CONTENT_MISMATCH', 'declared scene images exceed the 1 GiB decoded pixel budget')
    return {'bindings': len(bindings), 'decodedBytes': total}


def pack_imported_material_images(objects):
    """Keep OBJ's authored image nodes usable after saving or moving a checkpoint."""
    trees, visited, images = [], set(), set()
    for obj in objects:
        for slot in getattr(obj, 'material_slots', []):
            material = slot.material
            if material and material.use_nodes and material.node_tree:
                trees.append(material.node_tree)
    while trees:
        tree = trees.pop()
        if tree in visited:
            continue
        visited.add(tree)
        for node in tree.nodes:
            if node.type == 'GROUP' and node.node_tree:
                trees.append(node.node_tree)
            image = getattr(node, 'image', None)
            if image is not None:
                images.add(image)
    for image in images:
        try:
            if min(image.size) <= 0 or max(image.size) > 8192:
                raise ValueError('image dimensions must be between 1 and 8192 pixels')
            if not image.packed_file:
                image.pack()
            if not image.packed_file:
                raise ValueError('Blender did not embed the image')
        except Exception as error:
            raise ActionError('ASSET_CONTENT_MISMATCH', 'cannot embed imported material image: %s' % error)


def validate_image_uv_usage(spec, obj, layers):
    """Validate named/default UV on a surface that actually uses this material."""
    for binding in (spec.get('images') or {}).values():
        uv_name = binding.get('uvMap')
        if layers is None or not layers or (uv_name and layers.get(uv_name) is None):
            raise ActionError('SCENE_VALIDATION_FAILED', 'image material requires an existing UV map on the used surface',
                              {'entityId': obj.get('deepblend_id'), 'partId': obj.get('deepblend_part_id'), 'uvMap': uv_name})


def validate_procedural_uv_usage(spec, obj, layers):
    """Reject implicit UV fallback on an evaluated surface using this material."""
    texture = spec.get('texture') or {}
    if texture.get('coordinates') != 'uv':
        return
    name = texture.get('uvMap')
    valid = layers is not None and bool(layers) and (
        layers.get(name) is not None if name else any(layer.active_render for layer in layers))
    if not valid:
        raise ActionError('SCENE_VALIDATION_FAILED', 'procedural texture requires an existing UV map on the used surface',
                          {'materialId': spec['id'], 'entityId': obj.get('deepblend_id'),
                           'partId': obj.get('deepblend_part_id'), 'uvMap': name})


def load_packed_image(asset, project_root, colorspace=None):
    path = image_asset_path(asset, project_root)
    facts = check_image_header(path)
    image = None
    try:
        image = bpy.data.images.load(path, check_existing=False)
        if min(image.size) <= 0 or max(image.size) > 8192:
            raise ValueError('image dimensions must be between 1 and 8192 pixels')
        if list(image.size) not in [[part['width'], part['height']] for part in facts['parts']]:
            raise ValueError('decoded image dimensions disagree with the inspected header')
        if colorspace is not None:
            image.colorspace_settings.name = colorspace
        image.pack()
        return image
    except Exception as error:
        if image is not None:
            bpy.data.images.remove(image)
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
