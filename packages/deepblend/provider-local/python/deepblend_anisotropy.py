"""Explicit Principled anisotropy with Blender UV or radial tangent directions.

Blender 5.2's Principled Anisotropic/Anisotropic Rotation are Cycles-only.
Rotation is measured in turns, not radians. RADIAL uses Blender's cylindrical
projection about the object's local X/Y/Z axis; UV_MAP uses the named UV map.
https://docs.blender.org/manual/en/5.2/render/shader_nodes/shader/principled.html
https://docs.blender.org/manual/en/4.3/render/shader_nodes/input/tangent.html
"""
from deepblend_util import ActionError
from deepblend_images import validate_image_uv_usage

KEYS = ('anisotropic', 'anisotropicRotation')


def anisotropy_state(spec, tracks=()):
    parameters = spec.get('parameters') or {}
    animations = [track for track in tracks if track.get('targetKind') == 'material'
                  and track.get('targetEntityId') == spec['id'] and track.get('property') in KEYS]
    requested = spec.get('tangent') is not None or animations or any(key in parameters for key in KEYS)
    direction_required = any(parameters.get(key, 0) != 0 for key in KEYS) or any(
        key.get('value', 0) != 0 for track in animations for key in track.get('keyframes', []))
    active = parameters.get('anisotropic', 0) > 0 or any(
        key.get('value', 0) > 0 for track in animations if track['property'] == 'anisotropic'
        for key in track.get('keyframes', []))
    return requested, direction_required, active


def validate_anisotropy_material(spec, tracks=()):
    requested, direction_required, active = anisotropy_state(spec, tracks)
    if requested and spec.get('shader') == 'emission':
        raise ActionError('SCENE_VALIDATION_FAILED', 'anisotropy requires a principled or glass material', {'materialId': spec['id']})
    if direction_required and spec.get('tangent') is None:
        raise ActionError('SCENE_VALIDATION_FAILED', 'nonzero anisotropy or rotation requires an explicit tangent', {'materialId': spec['id']})
    return active


def build_anisotropy(material, principled, spec):
    """Connect a real tangent node; do not depend on Blender's implicit UV fallback."""
    requested, _, _ = anisotropy_state(spec)
    if not requested:
        return
    validate_anisotropy_material(spec)
    for socket in ('Anisotropic', 'Anisotropic Rotation', 'Tangent'):
        if principled.inputs.get(socket) is None:
            raise ActionError('SCENE_VALIDATION_FAILED', 'this Blender build lacks Principled ' + socket, {'materialId': spec['id']})
    binding = spec.get('tangent')
    if binding is None:
        return
    node = material.node_tree.nodes.new('ShaderNodeTangent')
    node.name = 'db_anisotropic_tangent'
    node.location = (-270, -740)
    if binding['mode'] == 'uv':
        node.direction_type = 'UV_MAP'
        node.uv_map = binding['uvMap']
    elif binding['mode'] == 'radial':
        node.direction_type = 'RADIAL'
        node.axis = binding['axis'].upper()
    else:
        raise ActionError('SCENE_VALIDATION_FAILED', 'unknown anisotropic tangent mode', {'materialId': spec['id']})
    material.node_tree.links.new(node.outputs['Tangent'], principled.inputs['Tangent'])


def validate_anisotropy_usage(spec, mesh, engine, tracks=(), uv_layers=None):
    """Called only for materials actually used by a mesh face, after slot overrides."""
    active = validate_anisotropy_material(spec, tracks)
    if active and engine != 'CYCLES':
        raise ActionError('SCENE_VALIDATION_FAILED', 'Principled anisotropy requires Cycles for this used material',
                          {'materialId': spec['id'], 'entityId': mesh.get('deepblend_id'), 'engine': engine})
    _, direction_required, _ = anisotropy_state(spec, tracks)
    binding = spec.get('tangent')
    layers = uv_layers if uv_layers is not None else getattr(mesh.data, 'uv_layers', None)
    if direction_required and binding and binding['mode'] == 'uv' and (layers is None or layers.get(binding['uvMap']) is None):
        raise ActionError('SCENE_VALIDATION_FAILED', 'anisotropic material requires its named UV map on the used mesh',
                          {'materialId': spec['id'], 'entityId': mesh.get('deepblend_id'),
                           'partId': mesh.get('deepblend_part_id'), 'uvMap': binding['uvMap']})
    return active


def validate_native_material_usage(spec, material, obj, engine, tracks, depsgraph):
    """Inspect evaluated faces without converting or changing the imported object.

    Curves, surfaces and text can render a material while remaining native data.
    A named UV map must exist on the evaluated surface; implicit fallback is not
    proof. Unused slots and unrelated materials never trigger this inspection.
    """
    _, direction_required, active = anisotropy_state(spec, tracks)
    assigned = {index for index, slot in enumerate(obj.material_slots) if slot.material == material}
    if not assigned or not (direction_required or active or spec.get('images')):
        return False
    evaluated = obj.evaluated_get(depsgraph)
    try:
        surface = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        if surface is None:
            raise ActionError('SCENE_VALIDATION_FAILED', 'cannot verify anisotropic direction on this native surface',
                              {'materialId': spec['id'], 'entityId': obj.get('deepblend_id'), 'objectType': obj.type})
        if any(polygon.material_index in assigned for polygon in surface.polygons):
            validate_image_uv_usage(spec, obj, surface.uv_layers)
            return validate_anisotropy_usage(spec, obj, engine, tracks, uv_layers=surface.uv_layers)
        return False
    finally:
        evaluated.to_mesh_clear()


def validate_anisotropy_render_engine(scene, engine):
    """Keep the saved scene's used-material requirement through render overrides."""
    if scene.get('deepblend_requires_cycles', False) and engine != 'CYCLES':
        raise ActionError('SCENE_VALIDATION_FAILED', 'this checkpoint uses animated or static anisotropy and requires Cycles',
                          {'engine': engine, 'requiredEngine': 'CYCLES'})
