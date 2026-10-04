"""Declared image uses supported by the pinned native glTF material importer."""

CORE = {
    'baseColorTexture': 'color', 'metallicRoughnessTexture': 'data',
}
MATERIAL = {
    'emissiveTexture': 'color', 'normalTexture': 'data', 'occlusionTexture': 'data',
}
EXTENSIONS = {
    'KHR_materials_pbrSpecularGlossiness': {
        'diffuseTexture': 'color', 'specularGlossinessTexture': 'color',
    },
    'KHR_materials_clearcoat': {
        'clearcoatTexture': 'data', 'clearcoatRoughnessTexture': 'data',
        'clearcoatNormalTexture': 'data',
    },
    'KHR_materials_transmission': {'transmissionTexture': 'data'},
    'KHR_materials_volume': {'thicknessTexture': 'data'},
    'KHR_materials_specular': {'specularColorTexture': 'color', 'specularTexture': 'alpha'},
    'KHR_materials_sheen': {'sheenColorTexture': 'color', 'sheenRoughnessTexture': 'alpha'},
    'KHR_materials_iridescence': {'iridescenceTexture': 'data', 'iridescenceThicknessTexture': 'data'},
    'KHR_materials_anisotropy': {'anisotropyTexture': 'data'},
}


def texture_uses(document):
    """Yield texture indices and roles, including native baked roughness copies.

    Alpha is linear in either image color space and needs no independent RGB
    interpretation. Count declared uses conservatively, even unused materials.
    Unknown material extensions remain subject to native support checks.
    """
    materials = document.get('materials', [])
    if not isinstance(materials, list):
        raise ValueError('glTF materials must be an array')
    for material in materials:
        if not isinstance(material, dict):
            raise ValueError('invalid glTF material declaration')
        groups = [(material, MATERIAL), (material.get('pbrMetallicRoughness') or {}, CORE)]
        extensions = material.get('extensions') or {}
        if not isinstance(extensions, dict):
            raise ValueError('invalid glTF material extensions')
        groups.extend((extensions.get(name) or {}, fields) for name, fields in EXTENSIONS.items())
        for group, fields in groups:
            if not isinstance(group, dict):
                raise ValueError('invalid glTF material texture group')
            for field, role in fields.items():
                info = group.get(field)
                if info is not None:
                    if not isinstance(info, dict):
                        raise ValueError('invalid glTF material texture reference')
                    yield info.get('index'), role
        specular = extensions.get('KHR_materials_pbrSpecularGlossiness') or {}
        info = specular.get('specularGlossinessTexture')
        if info is not None and specular.get('glossinessFactor', 1) != 0:
            yield info.get('index'), 'baked'
