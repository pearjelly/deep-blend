"""Use linear OBJ numeric/normal maps while retaining native color images."""
import bpy
from deepblend_image_roles import SOURCE_SPACE

# A later import can reuse an image first encountered as data. Remember its
# native color interpretation before changing it, including float-file spaces.
def image_role(node):
    roles = set()
    for link in node.outputs['Color'].links:
        numeric = (link.to_node.type == 'BSDF_PRINCIPLED' and link.to_socket.type == 'VALUE')
        normal = (link.to_node.type == 'NORMAL_MAP' and link.to_socket.name == 'Color')
        roles.add('data' if numeric or normal else 'color')
    if len(roles) > 1:
        raise ValueError('native OBJ image node has conflicting RGB uses')
    return next(iter(roles)) if roles else 'neutral'


def assign_image_roles(objects, protected_images):
    materials = {slot.material for obj in objects for slot in getattr(obj, 'material_slots', [])
                 if slot.material and slot.material.use_nodes}
    uses = {}
    for material in materials:
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image:
                uses.setdefault(node.image, []).append((node, image_role(node)))
    for original, nodes in uses.items():
        roles = {role for _, role in nodes if role != 'neutral'}
        if not roles:
            continue
        native_space = original.get(SOURCE_SPACE, original.colorspace_settings.name)
        spaces = {'color': native_space, 'data': 'Non-Color'}
        images = {}
        for role in sorted(roles):
            space = spaces[role]
            if original.colorspace_settings.name == space:
                image = original
            elif (len(roles) == 1 and original not in protected_images
                  and original.users == len(nodes)):
                # All users are this import. Alpha and disconnected nodes can
                # share its RGB interpretation without another allocation.
                image = original
                image[SOURCE_SPACE] = native_space
                image.colorspace_settings.name = space
            else:
                image = original.copy()
                image[SOURCE_SPACE] = native_space
                image.colorspace_settings.name = space
            images[role] = image
        neutral_role = 'color' if 'color' in images else 'data'
        for node, role in nodes:
            node.image = images[neutral_role if role == 'neutral' else role]


def import_obj(path):
    before_objects, before_images = set(bpy.data.objects), set(bpy.data.images)
    result = bpy.ops.wm.obj_import(filepath=path)
    assign_image_roles([obj for obj in bpy.data.objects if obj not in before_objects], before_images)
    return result
