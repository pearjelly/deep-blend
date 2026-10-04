"""Real GLB regression for stable part selectors and object-local material slots.

Run with Blender --background --factory-startup --python-exit-code 1 --python <this file>.
The fixture is authored and exported here; no external assets or downloads are needed.
"""
import copy
import hashlib
import json
import struct
import sys
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/deepblend/provider-local/python"))
from deepblend_scene import build_scene, describe_objects, reset_scene
from deepblend_parts import apply_material_bindings, isolated_import_names
from deepblend_util import ActionError, Guard


def edit_glb_json(path, change):
    """Keep every binary chunk unchanged while editing the GLB JSON chunk."""
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", raw)
    assert (magic, version, length) == (b"glTF", 2, len(raw))
    chunks = []
    offset = 12
    changed = False
    while offset < len(raw):
        size, kind = struct.unpack_from("<II", raw, offset)
        payload = raw[offset + 8:offset + 8 + size]
        assert len(payload) == size
        if kind == 0x4E4F534A:
            document = json.loads(payload.decode("utf-8"))
            change(document)
            payload = json.dumps(document, separators=(",", ":")).encode("utf-8")
            payload += b" " * ((-len(payload)) % 4)
            changed = True
        chunks.append(struct.pack("<II", len(payload), kind) + payload)
        offset += 8 + size
    assert changed and offset == len(raw)
    body = b"".join(chunks)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


def material_state(material):
    if material is None:
        return None
    shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    values = {}
    for name in ("Base Color", "Metallic", "Roughness", "IOR", "Alpha"):
        value = shader.inputs[name].default_value
        values[name] = tuple(round(v, 6) for v in value) if hasattr(value, "__len__") else round(value, 6)
    textures = []
    for node in material.node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image is not None:
            textures.append((tuple(node.image.size), node.image.colorspace_settings.name,
                             tuple(round(value, 6) for value in node.image.pixels[:])))
    return {
        "values": values,
        "links": sorted((link.from_node.type, link.from_socket.name,
                         link.to_node.type, link.to_socket.name) for link in material.node_tree.links),
        "textures": sorted(textures),
    }


def mesh_state(obj):
    """Read effective object slots: data.materials omits OBJECT-linked overrides."""
    bpy.context.view_layer.update()
    return {
        "vertices": [tuple(round(value, 6) for value in vertex.co) for vertex in obj.data.vertices],
        "worldVertices": [tuple(round(value, 6) for value in obj.matrix_world @ vertex.co)
                          for vertex in obj.data.vertices],
        "faces": [tuple(face.vertices) for face in obj.data.polygons],
        "faceMaterials": [face.material_index for face in obj.data.polygons],
        "uv": [(layer.name, [tuple(round(value, 6) for value in loop.uv) for loop in layer.data])
               for layer in obj.data.uv_layers],
        "materials": [material_state(slot.material) for slot in obj.material_slots],
    }


def mesh_parts(report, entity_id):
    entries = [entry for entry in report["objects"]
               if entry.get("deepblendId") == entity_id and entry["type"] == "MESH"]
    assert entries, "compiled report has no meshes for " + entity_id
    result = {}
    for entry in entries:
        part_id = entry.get("partId")
        assert isinstance(part_id, str) and part_id.startswith("/"), entry
        assert part_id not in result, "ambiguous partId: " + part_id
        obj = bpy.data.objects[entry["name"]]
        slots = entry.get("materialSlots")
        assert isinstance(slots, list) and len(slots) == len(obj.material_slots), entry
        assert [slot["index"] for slot in slots] == list(range(len(slots))), entry
        assert all("materialName" in slot and "materialId" in slot for slot in slots), entry
        assert [slot["materialName"] for slot in slots] == [
            slot.material.name if slot.material else None for slot in obj.material_slots], entry
        source_slots = entry.get("sourceMaterialSlots")
        assert isinstance(source_slots, list), entry
        assert [slot["index"] for slot in source_slots] == list(range(len(source_slots))), entry
        assert all("materialName" in slot for slot in source_slots), entry
        result[part_id] = (obj, entry)
    return result


def snapshots(report, entity_id):
    return {part: mesh_state(obj) for part, (obj, _) in mesh_parts(report, entity_id).items()}


def assert_geometry_unchanged(before, after):
    assert set(before) == set(after), "part inventory changed"
    for part in before:
        for field in ("vertices", "worldVertices", "faces", "faceMaterials", "uv"):
            assert before[part][field] == after[part][field], (part, field)


def assert_rejected(spec, root, bindings, label):
    candidate = copy.deepcopy(spec)
    candidate["entities"][0]["materialBindings"] = bindings
    try:
        build_scene(candidate, {"project_root": str(root)}, Guard())
    except ActionError as error:
        assert error.code == "SCENE_VALIDATION_FAILED", (label, error.code, str(error))
        assert str(error), label + " returned no diagnostic"
    else:
        raise AssertionError(label + " was silently accepted")


def render_pixels(path):
    scene = bpy.context.scene
    scene.cycles.device = "CPU"
    scene.render.filepath = str(path)
    assert bpy.ops.render.render(write_still=True) == {"FINISHED"}
    image = bpy.data.images.load(str(path), check_existing=False)
    assert tuple(image.size) == (256, 192)
    pixels = list(image.pixels[:])
    bpy.data.images.remove(image)
    return pixels


def assert_import_names_restored():
    """An importer may create colliding blocks before throwing an exception."""
    reset_scene()
    collections = ("meshes", "objects", "curves", "armatures", "cameras", "lights",
                   "metaballs", "lattices", "collections")

    def create(kind, name):
        collection = getattr(bpy.data, kind)
        if kind == "objects":
            item = collection.new(name, bpy.data.meshes["original-meshes"])
            bpy.context.scene.collection.objects.link(item)
            return item
        if kind == "curves":
            return collection.new(name, "CURVE")
        if kind == "lights":
            return collection.new(name, "AREA")
        return collection.new(name)

    # Include every namespace the helper promises to isolate, and keep a mesh
    # attached to an object so name restoration cannot substitute a new block.
    for kind in collections:
        create(kind, "original-" + kind)
        # The name assigned to a conflicting newcomer can itself collide with
        # another existing block. Restoring originals must win both collisions.
        create(kind, "test-failed-import_original-" + kind)
    originals = [(getattr(bpy.data, kind), [(item, item.name) for item in getattr(bpy.data, kind)])
                 for kind in collections]
    new_items = []
    marker = RuntimeError("simulated importer failure after allocating data")
    try:
        with isolated_import_names("test-failed-import"):
            for kind in collections:
                new_items.append((kind, create(kind, "original-" + kind)))
            raise marker
    except RuntimeError as error:
        assert error is marker, "name cleanup replaced the importer exception"
    else:
        raise AssertionError("importer exception was swallowed")
    for collection, entries in originals:
        for item, name in entries:
            assert item.name == name and collection.get(name) == item, (name, item.name)
    for kind, item in new_items:
        assert item.name != "original-" + kind, "new import retained an existing name: " + kind
    assert bpy.data.objects["original-objects"].data == bpy.data.meshes["original-meshes"]


def assert_mixed_material_targets():
    """Global overrides cover curves too; local part bindings remain mesh-only."""
    reset_scene()
    source = [bpy.data.materials.new("mixed-source-a"), bpy.data.materials.new("mixed-source-b")]
    materials = {key: bpy.data.materials.new("mixed-" + key) for key in ("whole", "slot")}
    bpy.ops.mesh.primitive_cube_add(size=1)
    mesh = bpy.context.object
    mesh["deepblend_part_id"] = "/mesh"
    curve_data = bpy.data.curves.new("mixed-curve-data", "CURVE")
    curve_data.dimensions = "3D"
    curve_data.bevel_depth = .05
    spline = curve_data.splines.new("POLY")
    spline.points.add(2)
    for point, coordinate in zip(spline.points, ((0, 0, 0, 1), (1, 0, 0, 1), (1, 1, 0, 1))):
        point.co = coordinate
    curve = bpy.data.objects.new("mixed-curve", curve_data)
    bpy.context.scene.collection.objects.link(curve)
    curve["deepblend_part_id"] = "/curve"
    for obj in (mesh, curve):
        for material in source:
            obj.data.materials.append(material)
    for face in mesh.data.polygons:
        face.material_index = face.index % 2
    face_indices = [face.material_index for face in mesh.data.polygons]
    entity = {"id": "mixed", "materialId": "whole", "materialBindings": [
        {"partId": "/mesh", "slotIndex": 1, "materialId": "slot"}]}
    apply_material_bindings(entity, [mesh, curve], materials)
    assert len(curve.material_slots) == 2, "global curve override changed its slot count"
    assert all(slot.material == materials["whole"] for slot in curve.material_slots), "curve missed global override"
    assert [slot.material for slot in mesh.material_slots] == [materials["whole"], materials["slot"]]
    assert all(slot.link == "OBJECT" for obj in (mesh, curve) for slot in obj.material_slots)
    assert [face.material_index for face in mesh.data.polygons] == face_indices
    assert list(mesh.data.materials) == source and list(curve.data.materials) == source

    invalid = {"id": "mixed", "materialId": "whole", "materialBindings": [
        {"partId": "/curve", "materialId": "slot"}]}
    try:
        apply_material_bindings(invalid, [mesh, curve], materials)
    except ActionError as error:
        assert error.code == "SCENE_VALIDATION_FAILED", error
    else:
        raise AssertionError("local binding accepted a non-mesh curve")
    assert all(slot.material == materials["whole"] for slot in curve.material_slots)
    assert [slot.material for slot in mesh.material_slots] == [materials["whole"], materials["slot"]]


with tempfile.TemporaryDirectory(prefix="deepblend-bindings-") as temporary:
    root = Path(temporary)
    reset_scene()
    assembly = bpy.data.objects.new("assembly", None)
    bpy.context.scene.collection.objects.link(assembly)
    group = bpy.data.objects.new("group/with~chars", None)
    bpy.context.scene.collection.objects.link(group)
    group.parent = assembly
    group.location.z = .5
    image = bpy.data.images.new("source-label", width=2, height=2)
    image.pixels[:] = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1]
    image.pack()
    source_materials = []
    for name, color, metallic in [("source-paint", (.8, .04, .02, 1), 0),
                                   ("source-metal", (.7, .7, .75, 1), 1)]:
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Metallic"].default_value = metallic
        if not metallic:
            texture = material.node_tree.nodes.new("ShaderNodeTexImage")
            texture.image = image
            material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
        source_materials.append(material)

    bpy.ops.mesh.primitive_cube_add(size=1)
    body = bpy.context.object
    body.name = "body"
    body.data.name = "shared-surface"
    body.parent = group
    for material in source_materials:
        body.data.materials.append(material)
    for polygon in body.data.polygons:
        polygon.material_index = polygon.index % 2
    sibling = bpy.data.objects.new("body.001", body.data)
    bpy.context.scene.collection.objects.link(sibling)
    sibling.parent = group
    sibling.location.x = 2
    bpy.ops.mesh.primitive_cube_add(size=.5)
    unnamed = bpy.context.object
    unnamed.name = "remove-this-node-name"
    unnamed.data.name = "fallbackMesh"
    unnamed.parent = group
    unnamed.location.x = -2
    # This unbound part deliberately has no UVs. A local image material on body
    # must not require UVs on every other mesh in the imported asset.
    for layer in list(unnamed.data.uv_layers):
        unnamed.data.uv_layers.remove(layer)
    unnamed.data.materials.append(source_materials[1])
    path = root / "parts.glb"
    assert bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB") == {"FINISHED"}

    def remove_node_name(document):
        nodes = {node.get("name"): node for node in document["nodes"]}
        assert nodes["body"]["mesh"] == nodes["body.001"]["mesh"], "fixture lost shared mesh during export"
        node = nodes["remove-this-node-name"]
        assert document["meshes"][node["mesh"]]["name"] == "fallbackMesh"
        node.pop("name")

    edit_glb_json(path, remove_node_name)
    spec = json.loads((ROOT / "deepblend/fixtures/product-turntable/scene-spec.json").read_text())
    spec["assets"] = [{"id": "parts", "type": "glb", "path": path.name,
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]
    spec["materials"] = [
        {"id": "whole", "shader": "principled", "parameters": {"baseColor": [.1, .15, .2, 1]}},
        {"id": "part", "shader": "principled", "parameters": {"baseColor": [.1, .8, .1, 1]}},
        {"id": "slot", "shader": "principled", "parameters": {"baseColor": [.1, .1, .8, 1]}},
    ]
    spec["entities"] = [{"id": "first", "type": "asset-instance", "assetId": "parts"}]
    spec["animationTracks"] = []
    for camera in spec["cameras"]:
        camera.pop("targetEntityId", None)
        camera["targetPoint"] = [0, 0, .5]

    report = build_scene(spec, {"project_root": str(root)}, Guard())
    prefix = "/assembly/group~1with~0chars"
    body_id, sibling_id, fallback_id = [prefix + "/" + name for name in ("body", "body.001", "fallbackMesh")]
    parts = mesh_parts(report, "first")
    assert set(parts) == {body_id, sibling_id, fallback_id}, set(parts)
    assert all(entry["parentPartId"] == prefix for _, entry in parts.values())
    assert parts[body_id][0].data == parts[sibling_id][0].data, "fixture is not an imported shared mesh"
    original_source_slots = {part: copy.deepcopy(entry["sourceMaterialSlots"])
                             for part, (_, entry) in parts.items()}
    original = snapshots(report, "first")
    assert len(original[body_id]["materials"]) == 2
    assert set(original[body_id]["faceMaterials"]) == {0, 1}
    assert original[body_id]["uv"] and original[body_id]["materials"][0]["textures"]
    assert original[fallback_id]["uv"] == [], "fixture unexpectedly acquired a UV map"

    # One slot on one shared-mesh object: keep every other material and all mesh data.
    partial = copy.deepcopy(spec)
    partial["entities"][0]["materialBindings"] = [
        {"partId": body_id, "slotIndex": 1, "materialId": "slot"}]
    report = build_scene(partial, {"project_root": str(root)}, Guard())
    parts = mesh_parts(report, "first")
    actual = snapshots(report, "first")
    assert_geometry_unchanged(original, actual)
    assert parts[body_id][0].data == parts[sibling_id][0].data
    assert parts[body_id][0].material_slots[1].link == "OBJECT"
    assert parts[body_id][0].material_slots[1].material == bpy.data.materials["db_mat__slot"]
    assert parts[body_id][1]["materialSlots"][1]["materialId"] == "slot"
    assert actual[body_id]["materials"][0] == original[body_id]["materials"][0]
    assert actual[sibling_id] == original[sibling_id], "shared mesh propagated a local override"
    assert actual[fallback_id] == original[fallback_id]

    # Reopening the artifact must keep object-local overrides, UVs and face indices.
    checkpoint = root / "bound.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint))
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
    reopened = {"objects": describe_objects()}
    assert snapshots(reopened, "first") == actual
    assert mesh_parts(reopened, "first")[body_id][0].material_slots[1].link == "OBJECT"

    # Bindings target the same source paths even after another instance imported
    # the same mesh/data names. This exercises the unnamed-node fallback too.
    repeated = copy.deepcopy(partial)
    repeated["entities"].append({"id": "second", "type": "asset-instance", "assetId": "parts"})
    report = build_scene(repeated, {"project_root": str(root)}, Guard())
    assert snapshots(report, "first") == actual
    assert snapshots(report, "second") == original
    repeated["entities"].reverse()
    report = build_scene(repeated, {"project_root": str(root)}, Guard())
    assert snapshots(report, "first") == actual
    assert snapshots(report, "second") == original

    # Whole entity < whole part < named slot, independent of the binding order.
    combined = copy.deepcopy(spec)
    combined["entities"][0]["materialId"] = "whole"
    combined["entities"][0]["materialBindings"] = [
        {"partId": body_id, "slotIndex": 1, "materialId": "slot"},
        {"partId": body_id, "materialId": "part"},
    ]
    report = build_scene(combined, {"project_root": str(root)}, Guard())
    parts = mesh_parts(report, "first")
    combined_state = snapshots(report, "first")
    assert_geometry_unchanged(original, combined_state)
    assert [slot["materialId"] for slot in parts[body_id][1]["materialSlots"]] == ["part", "slot"]
    assert [slot["materialId"] for slot in parts[sibling_id][1]["materialSlots"]] == ["whole", "whole"]
    combined["entities"][0]["materialBindings"].reverse()
    report = build_scene(combined, {"project_root": str(root)}, Guard())
    assert snapshots(report, "first") == combined_state

    # A literal .001 source name addresses its own part, never the unsuffixed one.
    suffixed = copy.deepcopy(spec)
    suffixed["entities"][0]["materialBindings"] = [{"partId": sibling_id, "materialId": "part"}]
    report = build_scene(suffixed, {"project_root": str(root)}, Guard())
    parts = mesh_parts(report, "first")
    assert mesh_state(parts[body_id][0]) == original[body_id]
    assert [slot["materialId"] for slot in parts[sibling_id][1]["materialSlots"]] == ["part", "part"]

    assert_rejected(spec, root, [{"partId": "/missing", "materialId": "slot"}], "missing part")
    assert_rejected(spec, root, [{"partId": body_id, "slotIndex": 2, "materialId": "slot"}], "slot past end")
    assert_rejected(spec, root, [{"partId": body_id, "slotIndex": -1, "materialId": "slot"}], "negative slot")
    assert_rejected(spec, root, [{"partId": "/assembly", "materialId": "slot"}], "non-mesh part")
    assert_rejected(spec, root, [{"partId": body_id, "materialId": "undeclared"}], "unknown material")
    assert_rejected(spec, root, [
        {"partId": body_id, "slotIndex": 1, "materialId": "part"},
        {"partId": body_id, "slotIndex": 1, "materialId": "slot"}], "duplicate slot selector")
    assert_rejected(spec, root, [
        {"partId": body_id, "materialId": "part"},
        {"partId": body_id, "materialId": "slot"}], "duplicate part selector")

    # Removing bindings restores the asset. Existing whole-entity behavior is
    # deliberately retained when there are no bindings.
    report = build_scene(spec, {"project_root": str(root)}, Guard())
    assert snapshots(report, "first") == original
    global_only = copy.deepcopy(spec)
    global_only["entities"][0]["materialId"] = "whole"
    report = build_scene(global_only, {"project_root": str(root)}, Guard())
    for part_id, (obj, entry) in mesh_parts(report, "first").items():
        assert len(obj.material_slots) == 1
        assert obj.material_slots[0].material == bpy.data.materials["db_mat__whole"]
        assert all(face.material_index == 0 for face in obj.data.polygons)
        assert entry["sourceMaterialSlots"] == original_source_slots[part_id], "whole override erased source slots"
    source_slot = mesh_parts(report, "first")[body_id][1]["sourceMaterialSlots"][1]["index"]
    assert source_slot == 1
    # The inventory after a global single-slot override still supplies a valid
    # source selector. A later revision reimports the asset and can target it.
    global_then_local = copy.deepcopy(global_only)
    global_then_local["entities"][0]["materialBindings"] = [
        {"partId": body_id, "slotIndex": source_slot, "materialId": "slot"}]
    report = build_scene(global_then_local, {"project_root": str(root)}, Guard())
    restored_slots = mesh_parts(report, "first")[body_id][1]
    assert [slot["materialId"] for slot in restored_slots["materialSlots"]] == ["whole", "slot"]
    assert restored_slots["sourceMaterialSlots"] == original_source_slots[body_id]
    assert_geometry_unchanged(original, snapshots(report, "first"))

    # A declared image material may be applied to just one slot. Its UV check
    # follows the effective OBJECT slot, not the entity's global materialId or
    # the underlying shared Mesh material table.
    image = bpy.data.images.new("local-pbr-map", width=16, height=16)
    image.pixels[:] = [component for y in range(16) for x in range(16)
                      for component in ((.9, .02, .6, 1) if (x // 4 + y // 4) % 2 else (.02, .9, .1, 1))]
    image.filepath_raw = str(root / "local-pbr.png")
    image.file_format = "PNG"
    image.save()
    pbr_spec = copy.deepcopy(spec)
    pbr_spec["assets"].append({"id": "local-pbr", "type": "png", "path": "local-pbr.png",
                               "sha256": hashlib.sha256((root / "local-pbr.png").read_bytes()).hexdigest()})
    uv_name = original[body_id]["uv"][0][0]
    pbr_spec["materials"].append({
        "id": "image-pbr", "shader": "principled",
        "parameters": {"roughness": .45, "emissionStrength": .5},
        "images": {"baseColor": {"assetId": "local-pbr", "uvMap": uv_name},
                   "emissionColor": {"assetId": "local-pbr", "uvMap": uv_name}},
    })
    pbr_spec["cameras"] = [{
        "id": "camera-main", "lens": 50, "sensorWidth": 36, "clipping": [.01, 100],
        "transform": {"location": [5, -8, 5]}, "targetPoint": [0, 0, .5],
    }]
    pbr_spec["shots"] = [{"id": "shot-01", "cameraId": "camera-main", "frameRange": [1, 90]}]
    pbr_spec["lights"] = [{
        "id": "key", "type": "area", "energy": 800, "size": 4,
        "transform": {"location": [2, -2, 6]},
    }]
    pbr_spec["renderProfiles"]["preview"]["resolution"] = [256, 192]
    pbr_spec["renderProfiles"]["preview"]["samples"] = 8
    report = build_scene(pbr_spec, {"project_root": str(root)}, Guard())
    before_pbr = snapshots(report, "first")
    plain_pixels = render_pixels(root / "plain.png")
    pbr_spec["entities"][0]["materialBindings"] = [
        {"partId": body_id, "slotIndex": 1, "materialId": "image-pbr"}]
    report = build_scene(pbr_spec, {"project_root": str(root)}, Guard())
    mapped_pbr = snapshots(report, "first")
    assert_geometry_unchanged(before_pbr, mapped_pbr)
    assert mapped_pbr[body_id]["materials"][0] == before_pbr[body_id]["materials"][0]
    assert mapped_pbr[body_id]["materials"][1] != before_pbr[body_id]["materials"][1]
    for part_id in (sibling_id, fallback_id):
        assert mapped_pbr[part_id] == before_pbr[part_id], "image binding affected another part: " + part_id
    assert mapped_pbr[fallback_id]["uv"] == [], "unbound no-UV part was changed"
    parts = mesh_parts(report, "first")
    bound_material = parts[body_id][0].material_slots[1].material
    assert bound_material == bpy.data.materials["db_mat__image-pbr"]
    assert parts[body_id][0].material_slots[1].link == "OBJECT"
    shader = next(node for node in bound_material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    assert shader.inputs["Base Color"].is_linked
    assert bound_material.node_tree.nodes["db_image_baseColor"].image.packed_file is not None
    mapped_pixels = render_pixels(root / "mapped.png")
    difference = sum(abs(a - b) for a, b in zip(plain_pixels, mapped_pixels)) / len(mapped_pixels)
    assert difference > .001, "slot image has no visible effect: %s" % difference

    missing_uv = copy.deepcopy(pbr_spec)
    missing_uv["materials"][-1]["images"]["baseColor"]["uvMap"] = "missing-uv"
    try:
        build_scene(missing_uv, {"project_root": str(root)}, Guard())
    except ActionError as error:
        assert error.code == "SCENE_VALIDATION_FAILED" and "UV" in str(error), error
    else:
        raise AssertionError("local image material accepted a missing UV map")

    # A slot created by a part-wide override is not an authored source slot.
    # Otherwise the inventory would advertise a selector that cannot be used
    # when the next revision rebuilds this originally material-free asset.
    reset_scene()
    bpy.ops.mesh.primitive_cube_add(size=1)
    bpy.context.object.name = "zero-slots"
    assert len(bpy.context.object.material_slots) == 0
    zero_path = root / "zero-slots.glb"
    assert bpy.ops.export_scene.gltf(filepath=str(zero_path), export_format="GLB") == {"FINISHED"}
    zero_spec = copy.deepcopy(spec)
    zero_spec["assets"] = [{"id": "parts", "type": "glb", "path": zero_path.name,
                            "sha256": hashlib.sha256(zero_path.read_bytes()).hexdigest()}]
    report = build_scene(zero_spec, {"project_root": str(root)}, Guard())
    zero_parts = mesh_parts(report, "first")
    assert set(zero_parts) == {"/zero-slots"}, zero_parts
    zero_part = "/zero-slots"
    assert zero_parts[zero_part][1]["materialSlots"] == []
    assert zero_parts[zero_part][1]["sourceMaterialSlots"] == []
    zero_spec["entities"][0]["materialBindings"] = [{"partId": zero_part, "materialId": "part"}]
    report = build_scene(zero_spec, {"project_root": str(root)}, Guard())
    zero_entry = mesh_parts(report, "first")[zero_part][1]
    assert [slot["materialId"] for slot in zero_entry["materialSlots"]] == ["part"]
    assert zero_entry["sourceMaterialSlots"] == [], "generated slot leaked into the source selector inventory"
    assert_rejected(zero_spec, root, [
        {"partId": zero_part, "materialId": "part"},
        {"partId": zero_part, "slotIndex": 0, "materialId": "slot"}], "generated slot selected as source")

    assert_mixed_material_targets()
    assert_import_names_restored()

    artifacts = ROOT / ".deepblend/quality/material-bindings"
    artifacts.mkdir(parents=True, exist_ok=True)
    for source, destination in (("plain.png", "before.png"), ("mapped.png", "after.png")):
        (artifacts / destination).write_bytes((root / source).read_bytes())
    print("MATERIAL_BINDINGS_IMAGES: %s %s" % (artifacts / "before.png", artifacts / "after.png"))

    print("MATERIAL_BINDINGS_PASSED: shared mesh isolation, effective slots, UV/faces, escaped paths, "
          "literal .001, unnamed-node repeat, precedence, rejection, saved reopen, restore, "
          "local PBR/no-UV isolation, source slot inventory, mixed mesh/curve override, "
          "import exception cleanup; pixel difference=%s" % difference)
