"""Preserve native glTF color/data image uses without changing importer files."""
import bpy


class ImageRoles:
    is_critical = True

    def __init__(self):
        self.images = {}
        self.rgb_roles = {}

    def gather_import_gltf_before_hook(self, gltf):
        from types import SimpleNamespace
        from io_scene_gltf2.blender.imp.texture import get_source
        from deepblend_gltf_roles import texture_uses
        document = {'materials': [material.to_dict() for material in (gltf.data.materials or [])]}
        for index, role in texture_uses(document):
            if role not in ('color', 'data'):
                continue
            source = get_source(SimpleNamespace(gltf=gltf), gltf.data.textures[index])
            if source is not None:
                self.rgb_roles.setdefault(source, set()).add(role)

    def gather_import_texture_before_hook(self, texture, mh, tex_info, location,
                                         label, color_socket, alpha_socket, is_data, gltf):
        from io_scene_gltf2.blender.imp.image import BlenderImage
        from io_scene_gltf2.blender.imp.texture import get_source
        source = get_source(mh, texture)
        if source is None:
            return
        BlenderImage.create(gltf, source)
        declaration = gltf.data.images[source]
        if not declaration.blender_image_name:
            return
        image = bpy.data.images[declaration.blender_image_name]
        # The native hook supplies semantic use, independent of node labels or
        # later graph rewrites. Alpha alone has the same values in either space.
        role = 'alpha' if color_socket is None and alpha_socket is not None else 'data' if is_data else 'color'
        if role == 'alpha' and source in self.rgb_roles:
            # If alpha is imported first, use a declared RGB interpretation.
            # Otherwise a later RGB use would create an unnecessary copy which
            # the alpha-only budget correctly does not include.
            roles = self.rgb_roles[source]
            role = next(iter(roles)) if len(roles) == 1 else 'data' if image.colorspace_settings.name == 'Non-Color' else 'color'
        key = (source, role)
        if key not in self.images:
            if role != 'alpha':
                space = 'Non-Color' if role == 'data' else 'sRGB'
                if image.colorspace_settings.name != space:
                    # External files may reuse an image from another material,
                    # image index or imported instance. Protect its existing users.
                    if image.users:
                        image = image.copy()
                    image.colorspace_settings.name = space
            self.images[key] = image
        declaration.blender_image_name = self.images[key].name

    def gather_import_texture_after_hook(self, texture, tree, mh, tex_info, location,
                                        label, color_socket, alpha_socket, is_data, gltf):
        from io_scene_gltf2.blender.imp.texture import get_source
        source = get_source(mh, texture)
        if source is None:
            return
        # Restore a color interpretation for native specular/glossiness baking,
        # which reads the image cache directly outside the texture-node hook.
        for role in ('color', 'data', 'alpha'):
            if (source, role) in self.images:
                gltf.data.images[source].blender_image_name = self.images[source, role].name
                return


def import_gltf(path):
    """Run the registered operator with one critical extension for this call.

    The pinned operator exposes user hooks through its importer constructor.
    Attach ours in memory for the synchronous call and restore that constructor
    on success and failure. Keep native settings, geometry, samplers, UVs and
    material conversion; no addon file or user preference is changed.
    """
    from io_scene_gltf2.io.imp.gltf2_io_gltf import glTFImporter
    original = glTFImporter.__init__

    def initialize(self, filename, settings):
        options = dict(settings)
        options['import_user_extensions'] = [*settings['import_user_extensions'], ImageRoles()]
        original(self, filename, options)

    glTFImporter.__init__ = initialize
    try:
        return bpy.ops.import_scene.gltf(filepath=path)
    finally:
        glTFImporter.__init__ = original
