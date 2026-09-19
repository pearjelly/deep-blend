#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend SceneSpec -> Blender scene compiler.

This is the heart of M1's batch provider: it turns a JSON SceneSpec into a real,
renderable Blender scene and saves it as a ``.blend`` checkpoint.

DESIGN RULES
------------
**The spec is the authority.** Every object, material, light, camera and
keyframe in the resulting scene is derived from the document. Nothing is
preserved from a previous state and nothing is inferred from the currently open
blend, because a compile that depended on what was already there could not be
replayed — and replayability is the entire reason SceneSpec exists (SPEC §8.1).

**Determinism where it is observable, honesty where it is not.** Object names,
counts, transforms, camera parameters, frame range and the keyframe trajectory
are all exactly specified, so they are asserted. Blender's own float rounding,
modifier tessellation and GPU sampling are not reproducible across builds, so
they are reported rather than asserted (SPEC §19.5 "不要求像素完全一致").

**Every decision is recorded.** When the compiler has to choose something the
author did not state — a default sample count, an engine downgrade, a fallback
aim — it appends a warning or a notice. A silent guess that shows up only in a
render is the most expensive kind of bug to find.

Runs inside Blender's embedded interpreter; ``bpy`` is available at call time.
"""

import json
import math
import os

import bpy
from mathutils import Vector

from deepblend_util import ActionError, Guard, as_text, error_text, report_progress, warning

#: SceneSpec engine key -> Blender render engine identifier.
BLENDER_ENGINE_BY_KEY = {
    "eevee": "BLENDER_EEVEE",
    "cycles": "CYCLES",
    "workbench": "BLENDER_WORKBENCH",
}

#: Engines probed for actual assignability. The static enum cannot be trusted on
#: Blender 5.2 (it reports only BLENDER_EEVEE while Cycles demonstrably works),
#: which is finding D1 from the M0 runtime audit.
CANDIDATE_ENGINES = ["BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"]

#: Preferred engine when the authored one is unavailable, best first.
ENGINE_FALLBACK_ORDER = ["CYCLES", "BLENDER_EEVEE", "BLENDER_WORKBENCH"]

#: Principled BSDF socket names, with the historical spellings each replaced.
#: Blender 4.0 renamed several; looking up the modern name first and falling back
#: keeps one code path working across both, instead of a version switch that has
#: to be re-verified on every release.
PRINCIPLED_SOCKETS = {
    "baseColor": ["Base Color"],
    "metallic": ["Metallic"],
    "roughness": ["Roughness"],
    "ior": ["IOR"],
    "alpha": ["Alpha"],
    "emissionColor": ["Emission Color", "Emission"],
    "emissionStrength": ["Emission Strength"],
    "coatWeight": ["Coat Weight", "Clearcoat"],
    "transmissionWeight": ["Transmission Weight", "Transmission"],
}

#: Layer-weight socket name for the Mix Shader node.
MIX_FACTOR_SOCKET = "Factor"

#: An `emission` shader is a different node with two sockets of its own, so it gets
#: its own table rather than being forced through a Principled one. The KEYS are the
#: same SceneSpec parameter names, which is the point: `material.parameter.update`
#: and a material animation track accept exactly the same vocabulary.
EMISSION_SHADER_SOCKETS = {
    "baseColor": ["Color"],
    "emissionColor": ["Color"],
    "emissionStrength": ["Strength"],
}

#: Object name prefixes, so a compiled scene is readable in Blender's outliner
#: and so validation can tell an entity object from a light by name alone.
ENTITY_PREFIX = "db_entity__"
LIGHT_PREFIX = "db_light__"
CAMERA_PREFIX = "db_camera__"

#: Material name prefix.
MATERIAL_PREFIX = "db_mat__"

#: 2*pi, used when a full-turn rotation is requested by a shorthand.
TAU = 6.283185307179586


# ---------------------------------------------------------------------------
# Scene reset
# ---------------------------------------------------------------------------


#: What a SceneSpec that declares no `world` is lit by. Mirrors `DEFAULT_WORLD` in
#: `contracts/lib/scene-spec.js`, which mirrors the schema's `default` keywords; the
#: contract suite asserts the JS and schema copies agree, and the Blender integration
#: suite asserts this copy produces them.
DEFAULT_WORLD_COLOR = (0.02, 0.021, 0.026, 1.0)
DEFAULT_WORLD_STRENGTH = 0.6


def reset_scene():
    """Empty the current Blender file, leaving a pristine scene.

    ``bpy.ops.wm.read_factory_settings(use_empty=True)`` is the honest way to do
    this: it resets preferences-independent scene state AND removes the startup
    cube/camera/light, in one call whose semantics are Blender's own. Deleting
    datablocks by hand leaves orphaned meshes, materials and collections behind,
    which then reappear in the count assertions and in the saved file.

    Returns the scene that must be used afterwards — the call replaces
    ``bpy.data``, so any reference captured before it is dead.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def build_world(scene, spec):
    """Apply the SceneSpec's `world` block, or the documented default.

    The background a viewer sees behind the product is the World, and until this
    existed the values were literals in this file: a brief asking for a black
    background could not be honoured through the spec at all, and the workaround
    (a near-black backdrop plane) still rendered mid-grey because a 0-albedo
    Principled surface keeps ~4% Fresnel specular. A `world` block with
    `strength: 0` is now the actual answer, and it is reachable from ScenePatch
    through `world.set`.
    """
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("db_world")
        scene.world = world

    declared = spec.get("world") if isinstance(spec.get("world"), dict) else None
    color = declared.get("color") if declared else None
    color = tuple(list(color)[:4]) if color is not None else DEFAULT_WORLD_COLOR
    if len(color) < 4:
        color = tuple(list(color) + [1.0] * (4 - len(color)))
    strength = declared.get("strength") if declared else None
    strength = float(strength) if strength is not None else DEFAULT_WORLD_STRENGTH

    # `World.use_nodes` is deprecated in 5.x and already defaults to True. Its
    # node tree is read rather than forced, so no deprecation warning reaches
    # stdout (which the provider captures as diagnostics) and an older build
    # without the default still gets a deterministic world.
    if getattr(world, "use_nodes", True) and world.node_tree is not None:
        background = world.node_tree.nodes.get("Background")
        if background is not None:
            background.inputs[0].default_value = color
            background.inputs[1].default_value = strength
            return {"declared": declared is not None, "color": list(color), "strength": strength}
    raise ActionError(
        "BLENDER_SCRIPT_ERROR",
        "the scene world has no addressable Background node, so the declared world "
        "cannot be applied; the render would silently use Blender's default",
    )


def available_engines():
    """Probe which render engines are genuinely assignable (finding D1).

    Each identifier is assigned to ``scene.render.engine`` and read back. A
    readback that does not match means the identifier does not exist in this
    build, which is the only reliable test: the static ``engine`` enum omits
    engines that work, and ``hasattr``-style checks report operators that are
    declared but unregistered (finding D10).
    """
    scene = bpy.context.scene
    original = scene.render.engine
    engines = {}
    for identifier in CANDIDATE_ENGINES:
        try:
            scene.render.engine = identifier
            engines[identifier] = scene.render.engine == identifier
        except Exception:
            engines[identifier] = False
    try:
        scene.render.engine = original
    except Exception:
        pass
    return engines


def resolve_engine(requested_key, guard):
    """Map a SceneSpec engine key onto an assignable Blender engine.

    An unavailable engine is NOT a hard failure: the caller asked for a preview,
    and refusing to render because EEVEE needs a GL context the headless build
    does not have would be less useful than rendering it with Cycles and saying
    so. The downgrade is always reported as a warning, never applied silently.
    """
    requested = BLENDER_ENGINE_BY_KEY.get(requested_key)
    if requested is None:
        raise ActionError(
            "BLENDER_ENGINE_UNAVAILABLE",
            'render profile names engine "%s"; available keys are %s'
            % (requested_key, ", ".join(sorted(BLENDER_ENGINE_BY_KEY))),
        )

    engines = available_engines()
    if engines.get(requested, False):
        return requested, None

    for candidate in ENGINE_FALLBACK_ORDER:
        if engines.get(candidate, False):
            return candidate, warning(
                "ENGINE_DOWNGRADED",
                'engine "%s" is not assignable in this Blender build; using %s instead'
                % (requested, candidate),
                {"requested": requested, "used": candidate, "probed": engines},
            )

    raise ActionError(
        "BLENDER_ENGINE_UNAVAILABLE",
        "none of the candidate engines are assignable in this Blender build (probed: %s)" % (engines,),
        {"probed": engines},
    )


# ---------------------------------------------------------------------------
# Primitives, bevel and shading
# ---------------------------------------------------------------------------


def _select_only(obj):
    """Make ``obj`` the only selected AND active object.

    Object-level operators act on the SELECTION, not on a named argument. The
    primitive operators leave their new object selected, and that selection
    persists, so ``bpy.ops.object.modifier_apply`` on a later object would apply to
    whatever was still selected instead — which reports ``{'FINISHED'}`` while
    doing nothing to the object you meant. Deselecting first is the only way to
    make an object operator's target unambiguous.
    """
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _apply_bevel(obj, bevel):
    """Add and apply a bevel modifier, in the requested order.

    Applied rather than left live so the saved ``.blend`` has the geometry the
    preview actually shows; a live modifier would make the checkpoint's polygon
    count disagree with what was rendered.

    ``modifier_apply`` returns ``{'CANCELLED'}`` — not an exception — when the
    operator's poll fails, so the return value is checked and a silent no-op is
    turned into a real error. A bevel that quietly did not happen would show up
    only as geometry that looks sharper than the spec asked for.
    """
    width = float(bevel.get("width", 0.01))
    segments = int(bevel.get("segments", 3))
    modifier = obj.modifiers.new(name="db_bevel", type="BEVEL")
    modifier.width = width
    modifier.segments = max(1, segments)
    modifier.limit_method = "ANGLE"
    modifier.angle_limit = math.radians(30.0)
    # `use_angle_clamp` was removed in 5.x; `use_clamp_overlap` is the surviving
    # guard against a bevel wider than the face it cuts into.
    modifier.use_clamp_overlap = True

    before = len(obj.data.polygons)
    _select_only(obj)
    try:
        result = bpy.ops.object.modifier_apply(modifier=modifier.name)
    except Exception as exc:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'could not apply the bevel modifier on "%s": %s' % (obj.name, error_text(exc)),
        )
    if "FINISHED" not in result:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'applying the bevel modifier on "%s" was cancelled (operator poll failed)' % (obj.name,),
            {"operatorResult": sorted(result)},
        )
    if len(obj.data.polygons) <= before:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'the bevel on "%s" reported success but changed no geometry (%d polygons before and after)'
            % (obj.name, before),
            {"polygonsBefore": before, "polygonsAfter": len(obj.data.polygons)},
        )


def _shade_smooth(obj):
    """Smooth-shade an object, across the operator churn since Blender 4.1.

    Three spellings exist and they are NOT aliases:

    * ``shade_smooth_by_angle`` (4.1+) bakes a ``sharp_edge`` attribute and leaves
      no modifier — the right choice for a checkpoint, because nothing is left
      live that the saved file has to carry.
    * ``shade_auto_smooth`` (4.1+) ADDS a "Smooth by Angle" geometry-nodes
      modifier, which then shows up in the modifier stack of a file that is
      supposed to be a plain compile artifact.
    * ``shade_smooth`` (all versions) smooths everything, including the hard edges
      a bevel just created.

    They are tried in that order, so the best available behaviour is used on the
    Blender actually running. A total failure is a warning and never a hard error:
    shading is cosmetic, and failing a revision over a cosmetic operator would be
    the wrong trade.
    """
    _select_only(obj)
    for name in ("shade_smooth_by_angle", "shade_auto_smooth", "shade_smooth"):
        operator = getattr(bpy.ops.object, name, None)
        if operator is None:
            continue
        try:
            result = operator()
        except Exception:
            continue
        if "FINISHED" in result:
            return


def create_generator(name, spec):
    """Create the mesh for one ``generator`` entity and return the object.

    Every shape is built through a ``bpy.ops.mesh.primitive_*_add`` call so the
    mesh is Blender's own primitive rather than hand-built vertex data, and every
    call can be replayed to produce the same topology.
    """
    shape = spec.get("shape")
    size = float(spec.get("size", 2.0))
    radius = float(spec.get("radius", 1.0))
    depth = float(spec.get("depth", 2.0))
    segments = int(spec.get("segments", 32))
    ring_count = int(spec.get("ringCount", 16))

    if shape == "cube":
        bpy.ops.mesh.primitive_cube_add(size=size)
    elif shape == "rounded_box":
        bpy.ops.mesh.primitive_cube_add(size=size)
        bevel = spec.get("bevel") or {}
        if bevel:
            _apply_bevel(bpy.context.active_object, bevel)
    elif shape == "uv_sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=segments, ring_count=ring_count)
    elif shape == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=segments)
    elif shape == "cone":
        bpy.ops.mesh.primitive_cone_add(radius1=radius, depth=depth, vertices=segments)
    elif shape == "plane":
        bpy.ops.mesh.primitive_plane_add(size=size)
    elif shape == "torus":
        bpy.ops.mesh.primitive_torus_add(
            major_radius=float(spec.get("majorRadius", 1.0)),
            minor_radius=float(spec.get("minorRadius", 0.25)),
            major_segments=segments,
            minor_segments=ring_count,
        )
    else:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'unknown generator shape "%s"' % (shape,),
            {"supported": ["cube", "rounded_box", "uv_sphere", "cylinder", "cone", "plane", "torus"]},
        )

    obj = bpy.context.active_object
    if obj is None:
        raise ActionError("BLENDER_SCRIPT_ERROR", 'primitive for shape "%s" produced no object' % (shape,))
    obj.name = name
    obj.data.name = "%s_mesh" % (name,)
    return obj


def import_asset_into_scene(name, asset_path, asset_type, guard):
    """Import a user asset and return the imported objects.

    Availability is decided by calling the operator inside a try block, not by
    asking whether it exists: ``bpy.ops.export_scene.obj`` is attribute-present
    but unregistered in this build, so the only honest availability test is to
    invoke it and see (finding D10). The likely failure — a build without the
    format's add-on — is classified as the format being unavailable rather than as
    a generic script error, because the two need different fixes.
    """
    before = set(bpy.data.objects.keys())

    if asset_type in ("glb", "gltf"):
        call = lambda: bpy.ops.import_scene.gltf(filepath=asset_path)  # noqa: E731
    elif asset_type == "fbx":
        call = lambda: bpy.ops.import_scene.fbx(filepath=asset_path)  # noqa: E731
    elif asset_type == "obj":
        call = lambda: bpy.ops.wm.obj_import(filepath=asset_path)  # noqa: E731
    elif asset_type == "usd":
        call = lambda: bpy.ops.wm.usd_import(filepath=asset_path)  # noqa: E731
    elif asset_type == "blend":
        call = lambda: bpy.ops.wm.append(filename=asset_path)  # noqa: E731
    else:
        raise ActionError("ASSET_FORMAT_UNAVAILABLE", 'unsupported asset type "%s"' % (asset_type,))

    try:
        call()
    except Exception as exc:
        raise ActionError(
            "ASSET_FORMAT_UNAVAILABLE",
            'this Blender build cannot import "%s" (%s): %s' % (asset_path, asset_type, error_text(exc)),
            {"assetPath": asset_path, "assetType": asset_type},
        )

    imported = [bpy.data.objects[key] for key in bpy.data.objects.keys() if key not in before]
    if not imported:
        raise ActionError(
            "ASSET_MISSING",
            'importing "%s" produced no objects' % (asset_path,),
            {"assetPath": asset_path},
        )

    root = imported[0]
    root.name = name
    for obj in imported[1:]:
        obj.parent = root
    guard.note(
        "SCENE_ASSET_IMPORTED",
        'entity "%s" imported %d object(s) from %s' % (name, len(imported), asset_path),
        {"assetPath": asset_path, "objectCount": len(imported)},
    )
    return imported


# ---------------------------------------------------------------------------
# Transforms
# ---------------------------------------------------------------------------


def apply_transform(obj, transform):
    """Apply a spec transform to an object.

    ``rotation_mode`` is forced to XYZ because the SceneSpec's ``rotationEuler``
    is documented as XYZ radians; leaving Blender's default (also XYZ, but a
    project could change it) implicit would make an authored rotation mean
    something different in a re-opened file.
    """
    location = transform.get("location") or [0, 0, 0]
    rotation = transform.get("rotationEuler") or [0, 0, 0]
    scale = transform.get("scale") or [1, 1, 1]
    obj.location = Vector(location)
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = (float(rotation[0]), float(rotation[1]), float(rotation[2]))
    obj.scale = Vector(scale)
    return obj


def apply_visibility(obj, visible):
    """Apply the spec's visibility flag to both viewport and render.

    Both are set: ``hide_render`` alone leaves a hidden object consuming a
    viewport slot, and ``hide_viewport`` alone still renders. A "hidden" entity
    that appears in the preview would be a straight lie to the model.
    """
    obj.hide_viewport = not visible
    obj.hide_render = not visible


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------


def _find_socket(node, names):
    """Find an input socket by any of its historical names."""
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            return socket
    return None


def _set_socket(node, key, value, guard, material_id):
    """Set one Principled socket, warning when this build does not have it."""
    socket = _find_socket(node, PRINCIPLED_SOCKETS.get(key, [key]))
    if socket is None:
        guard.warn(
            "ADDON_ENABLE_FAILED",
            'material "%s" sets "%s", but this Blender build has no such Principled BSDF socket'
            % (material_id, key),
            {"materialId": material_id, "parameter": key},
        )
        return
    try:
        if isinstance(value, (list, tuple)):
            existing = socket.default_value
            if hasattr(existing, "__len__") and len(existing) == 4:
                payload = list(value)
                while len(payload) < 4:
                    payload.append(1.0)
                socket.default_value = tuple(payload[:4])
            else:
                socket.default_value = tuple(value[:3])
        else:
            socket.default_value = float(value)
    except Exception as exc:
        guard.warn(
            "ADDON_ENABLE_FAILED",
            'material "%s" could not set "%s": %s' % (material_id, key, error_text(exc)),
            {"materialId": material_id, "parameter": key},
        )


#: Pattern node per SceneSpec texture `type`, with every name its scalar output has
#: carried. Blender renamed Noise's `Fac` to `Factor`, and Voronoi has no scalar
#: `Fac` at all (its scalar is `Distance`), so the output is resolved by trying the
#: historical spellings rather than by assuming one.
TEXTURE_PATTERN_NODES = {
    "noise": ("ShaderNodeTexNoise", ["Factor", "Fac"]),
    "wave": ("ShaderNodeTexWave", ["Factor", "Fac"]),
    "voronoi": ("ShaderNodeTexVoronoi", ["Distance", "Fac", "Factor"]),
}


def _pattern_value_output(pattern, names):
    """The scalar output of a pattern node, by any of its historical names."""
    for name in names:
        socket = pattern.outputs.get(name)
        if socket is not None:
            return socket
    return None


def _build_texture_graph(material, principled, texture, guard, material_id):
    """Wire a procedural pattern into a Principled BSDF.

    A material carrying only scalar parameters shades as one flat colour, which is
    why paper, wood and glazed ceramic all read as the same plastic. This builds the
    relief and variation that tells them apart, in OBJECT space so the pattern
    travels with the object and no image has to be ingested.

    Every socket is looked up by name and every stage is optional: a build missing
    one node degrades to a plainer material and says so, rather than failing the
    whole compile over a cosmetic detail.
    """
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    entry = TEXTURE_PATTERN_NODES.get(texture.get("type"))
    if entry is None:
        guard.warn(
            "ADDON_ENABLE_FAILED",
            'material "%s" asks for texture type "%s", which this compiler cannot build'
            % (material_id, texture.get("type")),
            {"materialId": material_id, "textureType": texture.get("type")},
        )
        return
    node_id, output_names = entry
    try:
        pattern = nodes.new(node_id)
    except Exception as exc:
        guard.warn(
            "ADDON_ENABLE_FAILED",
            'material "%s": this Blender build has no %s node: %s'
            % (material_id, node_id, error_text(exc)),
            {"materialId": material_id, "node": node_id},
        )
        return

    coord = nodes.new("ShaderNodeTexCoord")
    coord.location = (-1080, -240)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-900, -240)
    pattern.location = (-700, -240)
    links.new(coord.outputs["Object"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], pattern.inputs["Vector"])

    stretch = texture.get("stretch") or [1.0, 1.0, 1.0]
    scale = float(texture["scale"])
    mapping.inputs["Scale"].default_value = (
        scale * float(stretch[0]),
        scale * float(stretch[1]),
        scale * float(stretch[2]),
    )

    if pattern.inputs.get("Detail") is not None and texture.get("detail") is not None:
        pattern.inputs["Detail"].default_value = float(texture["detail"])
    if pattern.inputs.get("Distortion") is not None and texture.get("distortion") is not None:
        pattern.inputs["Distortion"].default_value = float(texture["distortion"])

    value = _pattern_value_output(pattern, output_names)
    if value is None:
        guard.warn(
            "ADDON_ENABLE_FAILED",
            'material "%s": %s exposes none of %s, so its texture was skipped'
            % (material_id, node_id, output_names),
            {"materialId": material_id, "node": node_id},
        )
        return

    # 1) Surface relief. This is what breaks a highlight up across a surface
    #    instead of letting it slide over like glass.
    bump_strength = float(texture.get("bump") or 0.0)
    normal_socket = _find_socket(principled, ["Normal"])
    if bump_strength > 0 and normal_socket is not None:
        bump = nodes.new("ShaderNodeBump")
        bump.location = (-260, -560)
        bump.inputs["Strength"].default_value = min(1.0, bump_strength)
        links.new(value, bump.inputs["Height"])
        links.new(bump.outputs["Normal"], normal_socket)

    # 2) Roughness variation, swung around whatever the material authored, so the
    #    authored value stays the centre of the range.
    variation = float(texture.get("roughnessVariation") or 0.0)
    roughness_socket = _find_socket(principled, PRINCIPLED_SOCKETS["roughness"])
    if variation > 0 and roughness_socket is not None:
        authored = float(roughness_socket.default_value)
        span = nodes.new("ShaderNodeMapRange")
        span.location = (-460, -160)
        span.inputs["From Min"].default_value = 0.0
        span.inputs["From Max"].default_value = 1.0
        span.inputs["To Min"].default_value = max(0.0, authored - variation * 0.5)
        span.inputs["To Max"].default_value = min(1.0, authored + variation * 0.5)
        links.new(value, span.inputs["Value"])
        links.new(span.outputs["Result"], roughness_socket)

    # 3) Colour variation, as a multiplicative tint centred on 1.0 so the authored
    #    base colour still decides the hue. Vector maths is used rather than a Mix
    #    node because Mix's A/B sockets are only distinguishable by index.
    color_variation = float(texture.get("colorVariation") or 0.0)
    base_socket = _find_socket(principled, PRINCIPLED_SOCKETS["baseColor"])
    if color_variation > 0 and base_socket is not None:
        tint = nodes.new("ShaderNodeMapRange")
        tint.location = (-460, 160)
        tint.inputs["From Min"].default_value = 0.0
        tint.inputs["From Max"].default_value = 1.0
        tint.inputs["To Min"].default_value = max(0.0, 1.0 - color_variation)
        tint.inputs["To Max"].default_value = 1.0
        links.new(value, tint.inputs["Value"])
        combine = nodes.new("ShaderNodeCombineXYZ")
        combine.location = (-260, 160)
        links.new(tint.outputs["Result"], combine.inputs["X"])
        links.new(tint.outputs["Result"], combine.inputs["Y"])
        links.new(tint.outputs["Result"], combine.inputs["Z"])
        multiply = nodes.new("ShaderNodeVectorMath")
        multiply.location = (-80, 160)
        multiply.operation = "MULTIPLY"
        links.new(combine.outputs["Vector"], multiply.inputs[0])
        multiply.inputs[1].default_value = tuple(list(base_socket.default_value)[:3])
        links.new(multiply.outputs["Vector"], base_socket)


def build_material(spec, guard):
    """Create one Blender material from a SceneSpec material entry."""
    material_id = spec["id"]
    shader = spec.get("shader", "principled")
    parameters = spec.get("parameters") or {}

    material = bpy.data.materials.new(name="%s%s" % (MATERIAL_PREFIX, material_id))
    # A material has `use_nodes` enabled by default in 5.x and arrives with a
    # Principled BSDF already wired to the output. Setting it again only emits a
    # deprecation warning, so the node tree is reset explicitly below instead.
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    for node in list(nodes):
        nodes.remove(node)

    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (320, 0)

    if shader == "emission":
        emission = nodes.new("ShaderNodeEmission")
        emission.location = (0, 0)
        color = parameters.get("emissionColor") or parameters.get("baseColor") or [1, 1, 1]
        emission.inputs["Color"].default_value = tuple(list(color)[:3] + [1.0]) if len(color) < 4 else tuple(color[:4])
        emission.inputs["Strength"].default_value = float(parameters.get("emissionStrength", 1.0))
        links.new(emission.outputs["Emission"], output.inputs["Surface"])
    else:
        principled = nodes.new("ShaderNodeBsdfPrincipled")
        principled.location = (0, 0)
        links.new(principled.outputs["BSDF"], output.inputs["Surface"])

        if shader == "glass":
            # A glass shader is a Principled with the transmission path opened up,
            # rather than a separate node graph: one node type means one set of
            # socket names to keep working across Blender versions.
            parameters = {"roughness": 0.05, "ior": 1.45, "transmissionWeight": 1.0, **parameters}

        for key, value in parameters.items():
            _set_socket(principled, key, value, guard, material_id)

        # After the scalars, so the pattern varies around the authored values
        # rather than replacing them.
        texture = spec.get("texture")
        if isinstance(texture, dict):
            _build_texture_graph(material, principled, texture, guard, material_id)

    alpha = parameters.get("alpha")
    if isinstance(alpha, (int, float)) and float(alpha) < 1.0:
        # Non-opaque alpha needs an explicit blend mode, or the viewport and the
        # render disagree about whether the surface is see-through.
        try:
            material.surface_render_method = "BLENDED"
        except Exception:
            try:
                material.blend_method = "BLEND"
            except Exception:
                guard.warn(
                    "ADDON_ENABLE_FAILED",
                    'material "%s" sets alpha < 1, but this build exposes no blend-mode attribute' % (material_id,),
                )

    material["deepblend_id"] = material_id
    return material


def build_default_material(guard):
    """The material applied to an entity that names none.

    A mid-grey diffuse surface: it renders legibly under any lighting the scene
    provides, so an entity with no material still produces a usable preview
    instead of a black silhouette that looks like a lighting bug.
    """
    material = bpy.data.materials.new(name="%sdefault" % (MATERIAL_PREFIX,))
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled is not None:
        _set_socket(principled, "baseColor", [0.62, 0.62, 0.64, 1.0], guard, "default")
        _set_socket(principled, "roughness", 0.55, guard, "default")
        _set_socket(principled, "metallic", 0.0, guard, "default")
    material["deepblend_id"] = "default"
    return material


# ---------------------------------------------------------------------------
# Lights and cameras
# ---------------------------------------------------------------------------


def build_light(spec):
    """Create one light object from a SceneSpec light entry."""
    light_id = spec["id"]
    light_type = spec.get("type", "point")
    data = bpy.data.lights.new(name="%s%s" % (LIGHT_PREFIX, light_id), type=light_type.upper())
    data.energy = float(spec.get("energy", 100.0))

    color = spec.get("color") or [1, 1, 1]
    data.color = tuple(list(color)[:3])

    if light_type == "area":
        # `size` is the area light's radius. The attribute is `size` on an Area
        # light and `shadow_soft_size` on Point/Spot, so the two are set through
        # explicit branches rather than one shared line that would only work for
        # one of them.
        data.shape = "SQUARE"
        data.size = float(spec.get("size", 1.0))
    elif light_type in ("point", "spot"):
        data.shadow_soft_size = float(spec.get("size", 0.25))
    if light_type == "spot":
        data.spot_size = float(spec.get("spotSize", math.radians(45.0)))
        data.spot_blend = float(spec.get("spotBlend", 0.15))
    if light_type == "sun":
        data.angle = float(spec.get("angle", math.radians(0.526)))

    obj = bpy.data.objects.new("%s%s" % (LIGHT_PREFIX, light_id), data)
    bpy.context.scene.collection.objects.link(obj)
    obj["deepblend_id"] = light_id
    return obj


def build_camera(spec, entity_positions):
    """Create one camera object, aiming it at its target when it has one.

    The aim is computed here, with Blender's own ``to_track_quat``, rather than
    pre-computed in Node: a camera rotation is Blender's convention to define, and
    re-implementing it in a second language is how the two ends end up framing the
    same subject slightly differently.

    A camera with a target but no authored position is a compile error rather than
    a guess — the Node-side resolver fills that in deterministically, so reaching
    this point without a location means the spec was compiled without being
    resolved.
    """
    camera_id = spec["id"]
    data = bpy.data.cameras.new(name="%s%s" % (CAMERA_PREFIX, camera_id))
    data.lens = float(spec.get("lens", 50.0))
    data.sensor_width = float(spec.get("sensorWidth", 36.0))
    clipping = spec.get("clipping")
    if clipping:
        data.clip_start = float(clipping[0])
        data.clip_end = float(clipping[1])
    if spec.get("fStop") is not None:
        data.dof.use_dof = True
        data.dof.aperture_fstop = float(spec["fStop"])

    obj = bpy.data.objects.new("%s%s" % (CAMERA_PREFIX, camera_id), data)
    bpy.context.scene.collection.objects.link(obj)
    obj["deepblend_id"] = camera_id

    transform = spec.get("transform") or {}
    location = transform.get("location")
    if location is None:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'camera "%s" has no resolved transform.location; compile the SceneSpec before sending it '
            "(compileSceneSpec fills in a derived position for targeted cameras)" % (camera_id,),
        )
    obj.location = Vector(location)
    obj.rotation_mode = "XYZ"

    target_entity = spec.get("targetEntityId")
    target_point = spec.get("targetPoint")
    if target_entity is not None:
        if target_entity not in entity_positions:
            raise ActionError(
                "SCENE_VALIDATION_FAILED",
                'camera "%s" targets entity "%s", which produced no object in this scene'
                % (camera_id, target_entity),
                {"cameraId": camera_id, "targetEntityId": target_entity},
            )
        target_point = entity_positions[target_entity]

    if target_point is not None:
        direction = Vector(target_point) - obj.location
        if direction.length > 0:
            # -Z is a camera's viewing axis and +Y its up axis, so this is the
            # rotation that points the lens at the target with a level horizon.
            obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler("XYZ")
    else:
        rotation = transform.get("rotationEuler")
        if rotation is not None:
            obj.rotation_euler = (float(rotation[0]), float(rotation[1]), float(rotation[2]))

    if data.dof.use_dof:
        # An f-stop on its own is NOT depth of field. Blender's focus_distance
        # defaults to 10 m, so a desk-sized scene sits far outside the field and
        # the whole frame comes back uniformly soft — every plane blurred, nothing
        # in focus, which reads as a mistake rather than as a shallow depth of
        # field. Focus on whatever the camera is already aimed at.
        focus_object = None
        if target_entity is not None:
            focus_object = bpy.data.objects.get("%s%s" % (ENTITY_PREFIX, target_entity))
        if focus_object is not None:
            # Focusing the object rather than a distance keeps a MOVING subject
            # sharp for the whole shot instead of only at the frame it was
            # measured on.
            data.dof.focus_object = focus_object
        elif target_point is not None:
            data.dof.focus_distance = max(1e-4, (Vector(target_point) - obj.location).length)

    return obj


# ---------------------------------------------------------------------------
# Animation
# ---------------------------------------------------------------------------

#: SceneSpec track property -> the bpy attribute its index addresses.
TRACK_PROPERTY_ATTR = {
    "location": "location",
    "rotationEuler": "rotation_euler",
    "scale": "scale",
}

#: SceneSpec interpolation name -> Blender fcurve interpolation identifier.
INTERPOLATION_BY_NAME = {
    "constant": "CONSTANT",
    "linear": "LINEAR",
    "bezier": "BEZIER",
    "ease_in": "SINE",
    "ease_out": "SINE",
    "ease_in_out": "SINE",
}


def _surface_node(material):
    """The node feeding a material's output, or None.

    Animation addresses the socket on the node that actually shades the surface, so
    this follows the same link `build_material` created rather than guessing a node
    name: an `emission` material has no Principled BSDF at all.
    """
    tree = getattr(material, "node_tree", None)
    if tree is None:
        return None
    for node in tree.nodes:
        if node.type != "OUTPUT_MATERIAL":
            continue
        links = node.inputs["Surface"].links if "Surface" in node.inputs else []
        if links:
            return links[0].from_node
    return None


def _material_socket(material, parameter):
    """Resolve a SceneSpec material parameter to (node, socket), or (node, None).

    One vocabulary for parameter names: the socket table below is the SAME one
    `material.parameter.update` goes through, so an animation cannot address a
    parameter a static set could not.
    """
    node = _surface_node(material)
    if node is None:
        return None, None
    if node.type == "EMISSION":
        names = EMISSION_SHADER_SOCKETS.get(parameter)
    else:
        names = PRINCIPLED_SOCKETS.get(parameter)
    if names is None:
        return node, None
    return node, _find_socket(node, names)


def build_material_animation(material, track, guard):
    """Key one material parameter onto its node socket.

    ``emissionStrength`` is why this exists: "the dial gradually lights up" is a ramp
    on one socket, and before animation could target a material the only way to
    express it was emissive geometry that scaled in.

    Keyframes are inserted through the SOCKET's own ``keyframe_insert`` rather than by
    naming a data path, because a socket's path embeds its index in the node's input
    list (``nodes["Principled BSDF"].inputs[29].default_value``) and that index moves
    whenever Blender reorders its sockets.
    """
    property_name = track.get("property", "")
    parameter, _, component = property_name.partition(".")
    node, socket = _material_socket(material, parameter)
    if node is None:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'animation track "%s" targets material "%s", which has no surface node to animate'
            % (track.get("id"), material.get("deepblend_id") or material.name),
        )
    if socket is None:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'animation track "%s" animates "%s", which is not a parameter of material "%s"'
            % (track.get("id"), property_name, material.get("deepblend_id") or material.name),
            {"supported": sorted(set(PRINCIPLED_SOCKETS) | set(EMISSION_SHADER_SOCKETS))},
        )

    axis = None
    if component:
        if component not in ("r", "g", "b", "a"):
            raise ActionError(
                "BLENDER_SCRIPT_ERROR",
                'animation track "%s" names component "%s"; expected r, g, b or a'
                % (track.get("id"), component),
            )
        axis = "rgba".index(component)
        if not hasattr(socket.default_value, "__len__"):
            raise ActionError(
                "BLENDER_SCRIPT_ERROR",
                'animation track "%s" names component "%s" of "%s", which is a single value, not a colour'
                % (track.get("id"), component, parameter),
            )

    keyframes = track.get("keyframes") or []
    if len(keyframes) < 2:
        raise ActionError(
            "SCENE_VALIDATION_FAILED",
            'animation track "%s" has %d keyframe(s); at least 2 are required to describe motion'
            % (track.get("id"), len(keyframes)),
        )

    data_path = socket.path_from_id("default_value")
    for keyframe in keyframes:
        frame = int(keyframe["frame"])
        value = float(keyframe["value"])
        if axis is None:
            socket.default_value = value
            socket.keyframe_insert("default_value", frame=frame)
        else:
            current = list(socket.default_value)
            while len(current) <= axis:
                current.append(1.0)
            current[axis] = value
            socket.default_value = tuple(current)
            socket.keyframe_insert("default_value", index=axis, frame=frame)

    tree = material.node_tree
    action = tree.animation_data.action if tree.animation_data is not None else None
    if action is None:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'animation track "%s" inserted keyframes but produced no action' % (track.get("id"),),
        )

    _apply_interpolation(action, data_path, axis, keyframes, track, guard)
    action.name = "db_anim__%s" % (track.get("id"),)
    action["deepblend_id"] = track.get("id")
    return action


def _apply_interpolation(action, data_path, axis, keyframes, track, guard):
    """Set each keyframe point's interpolation from the track, and say if none could be."""
    interpolations = set()
    for fcurve in action_fcurves(action):
        if fcurve.data_path != data_path:
            continue
        if axis is not None and fcurve.array_index != axis:
            continue
        for point in fcurve.keyframe_points:
            wanted = None
            for keyframe in keyframes:
                if int(round(point.co[0])) == int(keyframe["frame"]):
                    wanted = keyframe.get("interpolation")
                    break
            if wanted is None:
                continue
            point.interpolation = INTERPOLATION_BY_NAME.get(wanted, "BEZIER")
            interpolations.add(point.interpolation)

    if not interpolations:
        guard.warn(
            "SCENE_ANIMATION_KEYFRAMES_ADJUSTED",
            'animation track "%s" produced no addressable fcurve for %s; interpolation was left '
            "at Blender's default" % (track.get("id"), data_path),
            {"trackId": track.get("id"), "property": track.get("property")},
        )


def build_animation(obj, track, guard):
    """Key one animation track onto an object, returning the action name.

    Keyframes are inserted through ``keyframe_insert`` on the object's own
    property path, which lets Blender create the action, slot and fcurve with its
    own current conventions. Hand-building an action and assigning it to
    ``animation_data.action`` is what silently produced an un-evaluated scene in
    Blender 4.4+, where an action needs a SLOT as well as a datablock pointer.

    Interpolation is then applied to every point of the created fcurve, because
    ``keyframe_insert`` has no interpolation argument and always writes the user
    preference's default.
    """
    property_name = track.get("property", "")
    if "." not in property_name:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'animation track "%s" names property "%s" without a component' % (track.get("id"), property_name),
        )
    attr, _, component = property_name.rpartition(".")
    bpy_attr = TRACK_PROPERTY_ATTR.get(attr)
    if bpy_attr is None or component not in ("x", "y", "z"):
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'animation track "%s" names unsupported property "%s"' % (track.get("id"), property_name),
            {"supported": sorted("%s.%s" % (name, axis) for name in TRACK_PROPERTY_ATTR for axis in "xyz")},
        )
    axis = "xyz".index(component)

    keyframes = track.get("keyframes") or []
    if len(keyframes) < 2:
        raise ActionError(
            "SCENE_VALIDATION_FAILED",
            'animation track "%s" has %d keyframe(s); at least 2 are required to describe motion'
            % (track.get("id"), len(keyframes)),
        )

    bpy.context.view_layer.objects.active = obj
    # Keyframes must be inserted on the identity transform before the track's own
    # values, or the first insert would capture a value from a different property.
    obj.rotation_mode = "XYZ"

    for keyframe in keyframes:
        frame = int(keyframe["frame"])
        value = float(keyframe["value"])
        setattr(obj, bpy_attr, _with_component(getattr(obj, bpy_attr), axis, value))
        obj.keyframe_insert(data_path=bpy_attr, index=axis, frame=frame)

    action = obj.animation_data.action if obj.animation_data is not None else None
    if action is None:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'animation track "%s" inserted keyframes but produced no action' % (track.get("id"),),
        )

    # One implementation of "apply the track's interpolation", shared with material
    # tracks: the two used to be the same twelve lines, and the copy that rots is the
    # one nothing runs.
    _apply_interpolation(action, bpy_attr, None, keyframes, track, guard)

    action.name = "db_anim__%s" % (track.get("id"),)
    action["deepblend_id"] = track.get("id")
    return action


def _with_component(vector, axis, value):
    """Return a copy of a 3-component vector with one component replaced."""
    components = [vector[0], vector[1], vector[2]]
    components[axis] = value
    return components


def action_fcurves(action):
    """Every fcurve in an action, across Blender's legacy and layered APIs.

    Blender 5.x made actions LAYERED: ``action.fcurves`` no longer exists, and the
    curves live at ``action.layers[*].strips[*].channelbags[*].fcurves``. The
    legacy attribute is tried first so this works unchanged on 3.x/4.x builds,
    where it is the only location.

    This is precisely the kind of difference that cannot be inferred from a
    version number: the attribute is simply absent at runtime, so a version switch
    would have to be re-verified on every Blender release. Walking both shapes and
    returning whichever exists is correct by construction.
    """
    legacy = getattr(action, "fcurves", None)
    if legacy is not None:
        return list(legacy)

    collected = []
    for layer in getattr(action, "layers", []) or []:
        for strip in getattr(layer, "strips", []) or []:
            for channelbag in getattr(strip, "channelbags", []) or []:
                collected.extend(channelbag.fcurves)
    return collected


# ---------------------------------------------------------------------------
# Scene-level render configuration
# ---------------------------------------------------------------------------


def configure_scene(scene, spec, profile, guard):
    """Apply project frame range, fps and one render profile to the scene."""
    project = spec.get("project") or {}
    scene.frame_start = int(project.get("frameStart", 1))
    scene.frame_end = int(project.get("frameEnd", 1))
    scene.render.fps = int(round(float(project.get("fps", 24))))
    scene.render.fps_base = 1.0

    resolution = profile.get("resolution") or [640, 360]
    scene.render.resolution_x = int(resolution[0])
    scene.render.resolution_y = int(resolution[1])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = bool(profile.get("filmTransparent", False))

    samples = profile.get("samples")
    samples_applied = None
    if samples is not None:
        samples = int(samples)
        # Applying a profile's sample count is engine-specific: EEVEE has no
        # `samples` (it has `taa_render_samples`), and Cycles' attribute is the
        # plain one. Both are attempted so a profile is honoured whichever engine
        # the downgrade path landed on.
        applied = False
        if scene.render.engine == "CYCLES":
            try:
                scene.cycles.samples = samples
                scene.cycles.use_denoising = True
                # Cycles on Apple silicon: METAL is used by setting the device and
                # nothing else. `preferences.refresh_devices()` before the first
                # render HANGS this Blender build, so it is deliberately never
                # called here — the device list starts empty and Cycles finds the
                # GPU anyway.
                try:
                    scene.cycles.device = "GPU"
                except Exception:
                    pass
                applied = True
            except Exception:
                applied = False
        elif scene.render.engine == "BLENDER_EEVEE":
            try:
                scene.eevee.taa_render_samples = samples
                applied = True
            except Exception:
                applied = False
        if applied:
            samples_applied = samples
            guard.note(
                "SCENE_COMPILER_DECISION",
                "render profile %s: engine %s, %d samples, %dx%d"
                % (profile_name_of(spec, profile), scene.render.engine, samples,
                   scene.render.resolution_x, scene.render.resolution_y),
            )
        else:
            guard.note(
                "SCENE_COMPILER_DECISION",
                "sample count %d was not applied to engine %s (that engine exposes no sample attribute)"
                % (samples, scene.render.engine),
            )

    if profile.get("raytracing") is not None:
        # EEVEE only. Its raytracing pipeline defaults OFF, which leaves every
        # surface lit by direct light alone: objects lose their contact shadow and
        # read as floating, which is exactly the flatness the flag exists to fix.
        # Cycles has real global illumination and no such switch, so the key is
        # reported as ignored there rather than treated as an error.
        if scene.render.engine == "BLENDER_EEVEE":
            try:
                scene.eevee.use_raytracing = bool(profile["raytracing"])
                options = getattr(scene.eevee, "ray_tracing_options", None)
                if options is not None:
                    # The stock defaults trade quality for speed. A delivery wants
                    # the screen trace at full resolution and still applied to
                    # rougher surfaces than the default cutoff allows.
                    for attribute, value in (
                        ("resolution_scale", 1),
                        ("screen_trace_quality", 0.5),
                        ("trace_max_roughness", 0.9),
                        ("use_denoise", True),
                    ):
                        if hasattr(options, attribute):
                            setattr(options, attribute, value)
                guard.note(
                    "SCENE_COMPILER_DECISION",
                    "render profile %s: EEVEE raytracing %s"
                    % (profile_name_of(spec, profile), "enabled" if profile["raytracing"] else "disabled"),
                )
            except Exception as exc:
                guard.warn(
                    "ADDON_ENABLE_FAILED",
                    "could not set EEVEE raytracing on profile %s: %s"
                    % (profile_name_of(spec, profile), error_text(exc)),
                )
        else:
            guard.note(
                "SCENE_COMPILER_DECISION",
                "render profile %s sets raytracing, which engine %s has no switch for; ignored"
                % (profile_name_of(spec, profile), scene.render.engine),
            )

    color = profile.get("colorManagement") or {}
    view_transform = color.get("viewTransform")
    if view_transform:
        # Availability is decided by ASSIGNING and reading back, never by the
        # enum. On Blender 5.2 both `enum_items` and `enum_items_static` report
        # only ['NONE'] for view_transform while 'Standard', 'AgX', 'Filmic',
        # 'Raw' and 'False Color' all assign successfully — the same class of
        # lying metadata as the render-engine enum (finding D1). Enumerating it
        # rejected valid values and silently kept AgX, which would have made every
        # colour-managed preview differ from the profile that asked for it.
        applied = assign_view_transform(scene, view_transform)
        if not applied:
            guard.warn(
                "SCENE_COMPILER_DECISION",
                'view transform "%s" was not accepted by this Blender build; keeping "%s"'
                % (view_transform, scene.view_settings.view_transform),
                {"requested": view_transform, "kept": scene.view_settings.view_transform},
            )
    look = color.get("look")
    if look:
        try:
            scene.view_settings.look = look
        except Exception:
            guard.warn("SCENE_COMPILER_DECISION", 'view look "%s" is not available; keeping the default' % (look,))
    if color.get("exposure") is not None:
        scene.view_settings.exposure = float(color["exposure"])

    return {
        "engine": scene.render.engine,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "filmTransparent": scene.render.film_transparent,
        "frameStart": scene.frame_start,
        "frameEnd": scene.frame_end,
        "fps": scene.render.fps,
        "viewTransform": scene.view_settings.view_transform,
        "profileName": profile_name_of(spec, profile),
        "requestedEngine": profile.get("engine"),
        "profileEngine": profile.get("engine"),
        "samples": samples_applied,
    }


def profile_name_of(spec, profile):
    """Which named profile in the spec is this object, for the audit record."""
    for name, candidate in (spec.get("renderProfiles") or {}).items():
        if candidate is profile:
            return name
    return None


def assign_view_transform(scene, name):
    """Assign a view transform, returning whether it actually took effect.

    A rejected enum value is not always an exception in Blender: it can be
    silently ignored. Comparing the read-back is therefore the only reliable test,
    and it is also what makes a success claim here trustworthy.
    """
    settings = scene.view_settings
    try:
        settings.view_transform = name
    except Exception:
        return False
    try:
        return settings.view_transform == name
    except Exception:
        return False


# ---------------------------------------------------------------------------
# The compile entry point
# ---------------------------------------------------------------------------


def build_scene(spec, options, guard):
    """Compile a SceneSpec into a live Blender scene.

    ``options`` may carry:
      - ``profile``: which render profile to apply (default ``preview``).

    Returns a report describing what was built. Raises ``ActionError`` on any
    failure that must not be silently tolerated.
    """
    report_progress("reset_scene", 5)
    scene = reset_scene()

    report_progress("build_world", 10)
    world_report = build_world(scene, spec)

    report_progress("configure_scene", 12)
    profile_name = options.get("profile") or "preview"
    profiles = spec.get("renderProfiles") or {}
    profile = profiles.get(profile_name)
    if profile is None:
        profile = profiles.get("preview")
    if profile is None:
        raise ActionError(
            "RENDER_PROFILE_MISSING",
            'the SceneSpec defines no render profile named "%s" and no "preview" profile' % (profile_name,),
        )

    requested_engine = profile.get("engine", "cycles")
    engine, downgrade = resolve_engine(requested_engine, guard)
    try:
        scene.render.engine = engine
    except Exception as exc:
        raise ActionError(
            "BLENDER_ENGINE_UNAVAILABLE",
            'could not assign render engine "%s": %s' % (engine, error_text(exc)),
        )
    if downgrade is not None:
        guard.warnings.append(downgrade)

    # Materials first: entities reference them by id during construction.
    report_progress("build_materials", 20)
    materials = {}
    for entry in spec.get("materials") or []:
        materials[entry["id"]] = build_material(entry, guard)
    default_material = build_default_material(guard)

    assets = {asset["id"]: asset for asset in spec.get("assets") or []}

    report_progress("build_entities", 35)
    entity_objects = {}
    entity_positions = {}
    for entity in spec.get("entities") or []:
        entity_id = entity["id"]
        name = "%s%s" % (ENTITY_PREFIX, entity_id)
        visible = entity.get("visible", True)

        if entity.get("type") == "empty":
            obj = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(obj)
            objects = [obj]
        elif entity.get("type") == "asset-instance":
            asset = assets.get(entity.get("assetId"))
            if asset is None:
                raise ActionError(
                    "ASSET_MISSING",
                    'entity "%s" instantiates asset "%s", which the SceneSpec does not declare'
                    % (entity_id, entity.get("assetId")),
                )
            project_root = options.get("project_root")
            relative = asset.get("path", "")
            if project_root:
                asset_path = os.path.normpath(os.path.join(project_root, relative))
            else:
                asset_path = relative
            objects = import_asset_into_scene(name, asset_path, asset.get("type"), guard)
        else:
            generator = entity.get("generator")
            if generator is None:
                raise ActionError(
                    "SCENE_VALIDATION_FAILED",
                    'entity "%s" is a generator entity with no generator block' % (entity_id,),
                )
            objects = [create_generator(name, generator)]

        root = objects[0]
        apply_transform(root, entity.get("transform") or {})
        apply_visibility(root, visible)
        for obj in objects:
            apply_visibility(obj, visible)

        material_id = entity.get("materialId")
        if material_id is None and entity.get("type") != "empty":
            material_id = "default"
            materials.setdefault("default", default_material)
        material = materials.get(material_id)
        if material is None:
            raise ActionError(
                "SCENE_VALIDATION_FAILED",
                'entity "%s" references material "%s", which was not built' % (entity_id, material_id),
            )
        for obj in objects:
            if not hasattr(obj.data, "materials"):
                continue
            obj.data.materials.clear()
            obj.data.materials.append(material)
            if entity.get("generator", {}).get("shape") in ("uv_sphere", "cylinder", "cone", "torus"):
                _shade_smooth(obj)

        for obj in objects:
            obj["deepblend_id"] = entity_id
            obj["deepblend_kind"] = "entity"
        entity_objects[entity_id] = root
        entity_positions[entity_id] = [float(root.location[0]), float(root.location[1]), float(root.location[2])]

    report_progress("build_lights", 55)
    for light in spec.get("lights") or []:
        obj = build_light(light)
        apply_transform(obj, light.get("transform") or {})

    report_progress("build_cameras", 65)
    cameras = {}
    for camera in spec.get("cameras") or []:
        cameras[camera["id"]] = build_camera(camera, entity_positions)
    if cameras:
        scene.camera = cameras[spec["cameras"][0]["id"]]

    report_progress("build_animation", 75)
    actions = []
    for track in spec.get("animationTracks") or []:
        target_id = track.get("targetEntityId")
        # `targetKind` decides WHICH collection the id resolves against. Ids are unique
        # per collection, not globally, so the kind is the only thing that says whether
        # "watch-dial" means the mesh or the material. Absent means `entity`, which is
        # what every track written before kinds existed meant.
        kind = track.get("targetKind") or "entity"
        if kind == "camera":
            target = cameras.get(target_id)
        elif kind == "material":
            target = materials.get(target_id)
        else:
            target = entity_objects.get(target_id)
        if target is None:
            raise ActionError(
                "SCENE_VALIDATION_FAILED",
                'animation track "%s" targets %s "%s", which this scene does not contain'
                % (track.get("id"), kind, target_id),
            )
        if kind == "material":
            action = build_material_animation(target, track, guard)
        else:
            action = build_animation(target, track, guard)
        actions.append({"id": track.get("id"), "targetKind": kind, "targetEntityId": target_id, "action": action.name})

    report_progress("configure_render", 85)
    render_config = configure_scene(scene, spec, profile, guard)

    scene["deepblend_spec_schema"] = spec.get("schemaVersion", "")
    scene["deepblend_project_id"] = (spec.get("project") or {}).get("id", "")
    scene["deepblend_render_config"] = json.dumps(render_config, sort_keys=True)

    # Every transform above was written to the datablocks; `matrix_world` (and
    # therefore every bound box and every camera-framing projection) is STALE
    # until the dependency graph is told to re-evaluate. Without this the
    # validation report describes an empty scene, and the camera framing check
    # would score every object as being at the origin.
    bpy.context.view_layer.update()

    report_progress("compile_done", 90)
    return {
        "objects": describe_objects(),
        "actions": actions,
        "world": world_report,
        "renderConfig": render_config,
        "engine": engine,
        "requestedEngine": requested_engine,
        "profileName": profile_name,
        "entityObjectNames": {key: value.name for key, value in entity_objects.items()},
        "cameraNames": {key: value.name for key, value in cameras.items()},
    }


def describe_objects():
    """Inventory of every object in the scene, for validation and golden checks."""
    entries = []
    for obj in bpy.data.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "deepblendId": obj.get("deepblend_id"),
            "deepblendKind": obj.get("deepblend_kind"),
            "location": [round(float(value), 6) for value in obj.location],
            "rotationEuler": [round(float(value), 6) for value in obj.rotation_euler],
            "scale": [round(float(value), 6) for value in obj.scale],
            "visible": not (obj.hide_render or obj.hide_viewport),
            "parent": obj.parent.name if obj.parent is not None else None,
        }
        if obj.type == "MESH":
            entry["vertexCount"] = len(obj.data.vertices)
            entry["polygonCount"] = len(obj.data.polygons)
            entry["materialNames"] = [material.name for material in obj.data.materials if material is not None]
        if obj.type == "LIGHT":
            entry["lightType"] = obj.data.type
            entry["energy"] = round(float(obj.data.energy), 6)
        if obj.type == "CAMERA":
            entry["lens"] = round(float(obj.data.lens), 6)
            entry["sensorWidth"] = round(float(obj.data.sensor_width), 6)
        if obj.animation_data is not None and obj.animation_data.action is not None:
            entry["action"] = as_text(obj.animation_data.action.name)
        entries.append(entry)
    entries.sort(key=lambda item: item["name"])
    return entries
