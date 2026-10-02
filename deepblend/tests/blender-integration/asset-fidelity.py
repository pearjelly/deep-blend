"""Real Blender regression: imported GLB materials, UVs and hierarchy survive compilation.

Run with Blender --background --factory-startup --python-exit-code 1 --python <this file>.
Creates its own textured, multi-material, nested GLB; no downloaded asset is required.
"""
import json
import hashlib
import os
import sys
import tempfile
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/deepblend/provider-local/python"))
from deepblend_scene import build_scene, create_generator, reset_scene
from deepblend_util import ActionError, Guard


def material_snapshot(material):
    shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    values = {}
    for name in ("Base Color", "Metallic", "Roughness", "IOR", "Alpha"):
        value = shader.inputs[name].default_value
        values[name] = tuple(round(v, 5) for v in value) if hasattr(value, "__len__") else round(value, 5)
    return {"name": material.name, "values": values,
            "links": sorted((link.from_node.type, link.from_socket.name,
                             link.to_node.type, link.to_socket.name)
                            for link in material.node_tree.links)}


def mesh_snapshot():
    bpy.context.view_layer.update()
    return {
        obj.name: {
            "vertices": sorted(tuple(round(v, 4) for v in obj.matrix_world @ vertex.co)
                               for vertex in obj.data.vertices),
            "materials": [material_snapshot(slot) for slot in obj.data.materials],
            "faceMaterials": [face.material_index for face in obj.data.polygons],
            "uv": [tuple(round(v, 5) for v in loop.uv) for loop in obj.data.uv_layers.active.data],
            "textures": sorted(node.image.name for material in obj.data.materials
                               for node in material.node_tree.nodes
                               if node.type == "TEX_IMAGE" and node.image is not None),
        }
        for obj in bpy.context.scene.objects if obj.type == "MESH"
    }


with tempfile.TemporaryDirectory(prefix="deepblend-fidelity-") as directory:
    root = Path(directory)
    reset_scene()
    assembly = bpy.data.objects.new("assembly", None)
    bpy.context.scene.collection.objects.link(assembly)
    assembly.location = (1.0, -0.5, 0.0)
    assembly.rotation_euler.z = 0.3
    group = bpy.data.objects.new("nested", None)
    bpy.context.scene.collection.objects.link(group)
    group.parent = assembly
    group.location = (0.0, 0.0, 1.0)
    image = bpy.data.images.new("label-texture", width=2, height=2)
    image.pixels = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1]
    image.pack()
    for name, color, metallic in [("paint", (0.7, 0.1, 0.02, 1), 0.0),
                                   ("metal", (0.8, 0.8, 0.8, 1), 1.0)]:
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = color
        shader.inputs["Metallic"].default_value = metallic
        if name == "paint":
            texture = material.node_tree.nodes.new("ShaderNodeTexImage")
            texture.image = image
            material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
    for index, name in enumerate(["body", "cap"]):
        bpy.ops.mesh.primitive_cube_add(size=1)
        obj = bpy.context.object
        obj.name = name
        obj.parent = group
        obj.location = (index * 1.25, 0.2, index * 0.5)
        obj.data.materials.append(bpy.data.materials["paint"])
        obj.data.materials.append(bpy.data.materials["metal"])
        for polygon in obj.data.polygons:
            polygon.material_index = polygon.index % 2
    path = root / "product.glb"
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB")
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    expected = mesh_snapshot()
    expected_parents = {obj.name: obj.parent.name if obj.parent else None
                        for obj in bpy.context.scene.objects}

    spec = json.loads((ROOT / "deepblend/fixtures/product-turntable/scene-spec.json").read_text())
    spec["assets"] = [{"id": "product", "type": "glb", "path": "product.glb",
                       "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]
    spec["entities"] = [{"id": "product", "type": "asset-instance", "assetId": "product"}]
    spec["animationTracks"] = []
    for camera in spec["cameras"]:
        camera.pop("targetEntityId", None)
        camera["targetPoint"] = [0, 0, 1]
    build_scene(spec, {"project_root": str(root)}, Guard())
    # Read the saved artifact, not only the compiler's in-memory result.
    checkpoint = root / "compiled.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint))
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
    actual = mesh_snapshot()
    assert actual == expected, "imported GLB geometry/materials/UV/texture changed: %s" % json.dumps(
        {"expected": expected, "actual": actual}, sort_keys=True)
    for name, parent in expected_parents.items():
        obj = bpy.data.objects[name]
        if parent is not None:
            assert obj.parent.name == parent, "imported parent relationship changed"
    assert bpy.data.objects["assembly"].parent.name == "db_entity__product"

    # A SceneSpec transform affects the whole assembly without replacing any
    # authored child transform. Keep the material and UV assertions as well.
    spec["entities"][0]["transform"] = {"location": [2, 3, 4], "scale": [2, 2, 2]}
    build_scene(spec, {"project_root": str(root)}, Guard())
    transformed = mesh_snapshot()
    for name, original in expected.items():
        wanted = sorted(tuple(2 * value + offset for value, offset in zip(vertex, (2, 3, 4)))
                        for vertex in original["vertices"])
        assert all(abs(a - b) < 0.001 for actual_vertex, wanted_vertex
                   in zip(transformed[name]["vertices"], wanted)
                   for a, b in zip(actual_vertex, wanted_vertex)), "instance transform changed assembly geometry"
        assert transformed[name]["materials"] == original["materials"]
        assert transformed[name]["uv"] == original["uv"]
    spec["entities"][0].pop("transform")

    # A multi-mesh asset cannot silently simulate an arbitrary first object.
    spec["entities"][0]["rigidBody"] = {"kind": "passive"}
    try:
        build_scene(spec, {"project_root": str(root)}, Guard())
        raise AssertionError("ambiguous multi-mesh physics was accepted")
    except ActionError as error:
        assert "exactly one mesh" in str(error)
    spec["entities"][0].pop("rigidBody")

    # An explicit materialId remains an intentional whole-asset override.
    spec["entities"][0]["materialId"] = spec["materials"][0]["id"]
    build_scene(spec, {"project_root": str(root)}, Guard())
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            assert len(obj.data.materials) == 1, "explicit material override was ignored"
            assert all(face.material_index == 0 for face in obj.data.polygons), "override left invalid slots"
    # Physics attaches to the mesh, never to the instance container.
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(path))
    bpy.data.objects.remove(bpy.data.objects["cap"], do_unlink=True)
    single_path = root / "single.glb"
    bpy.ops.export_scene.gltf(filepath=str(single_path), export_format="GLB")
    spec["assets"][0]["path"] = "single.glb"
    spec["assets"][0]["sha256"] = hashlib.sha256(single_path.read_bytes()).hexdigest()
    spec["entities"][0]["rigidBody"] = {"kind": "passive"}
    report = build_scene(spec, {"project_root": str(root)}, Guard())
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    assert mesh.rigid_body is not None and mesh.rigid_body.type == "PASSIVE"
    assert report["simulation"]["product"]["kind"] == "passive"

    # A stored revision can be rebuilt from its pinned bytes, but changing those
    # bytes must fail before resetting the currently open scene.
    pinned = single_path.read_bytes()
    before_tamper = mesh_snapshot()
    single_path.write_bytes(pinned + b"tampered")
    try:
        build_scene(spec, {"project_root": str(root)}, Guard())
        raise AssertionError("changed pinned asset compiled successfully")
    except ActionError as error:
        assert error.code == "ASSET_HASH_MISMATCH", error
    assert mesh_snapshot() == before_tamper, "hash refusal changed the open scene"
    single_path.write_bytes(pinned)
    build_scene(spec, {"project_root": str(root)}, Guard())
    assert mesh_snapshot() == before_tamper, "restored pinned bytes did not rebuild the same asset"

    export_directory = os.environ.get("DEEPBLEND_ASSET_EXPORT_DIR")
    if export_directory:
        exported = Path(export_directory)
        exported.mkdir(parents=True, exist_ok=True)
        (exported / "product.glb").write_bytes(path.read_bytes())
        (exported / "single.glb").write_bytes(single_path.read_bytes())

    # Bevel is a generator option, so it must work beyond rounded_box.
    for shape in ("cube", "rounded_box", "cylinder", "cone"):
        reset_scene()
        plain = create_generator("plain", {"shape": shape})
        beveled = create_generator("beveled", {"shape": shape, "bevel": {"width": 0.04, "segments": 3}})
        assert len(beveled.data.polygons) > len(plain.data.polygons), "%s ignored its bevel" % shape
    print("ASSET_FIDELITY_PASSED: geometry, hierarchy, materials, textures, UV, transforms, explicit override, bevel")
