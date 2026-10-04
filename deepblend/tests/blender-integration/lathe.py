"""Real mesh, saved artifact and render checks for lathe geometry."""
import json
import math
import os
import sys
import tempfile
from pathlib import Path

import bpy
import bmesh

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/deepblend/provider-local/python"))
from deepblend_scene import create_generator, reset_scene, build_scene
from deepblend_util import Guard


def inspect(obj):
    mesh = bmesh.new()
    try:
        mesh.from_mesh(obj.data)
        return {"boundary": sum(edge.is_boundary for edge in mesh.edges),
                "manifold": all(edge.is_manifold for edge in mesh.edges),
                "volume": mesh.calc_volume(signed=True),
                "minimumArea": min(face.calc_area() for face in mesh.faces)}
    finally:
        mesh.free()


segments = 96
unit_area = segments * math.sin(math.tau / segments) / 2
for profile, closed, caps, volume in [
    ([[0, 0], [1, 0], [1, 2], [0, 2]], True, True, unit_area * 2),
    ([[1, 0], [1, 2]], False, True, unit_area * 2),
    ([[1, 2], [1, 0]], False, True, unit_area * 2),
    ([[1, 0], [2, 0], [2, 2], [1, 2]], True, True, unit_area * 6),
    ([[1, 0], [1, 2]], False, False, None),
]:
    reset_scene()
    obj = create_generator("test", {"shape": "lathe", "profile": profile,
                                    "closedProfile": closed, "capEnds": caps, "segments": segments})
    measured = inspect(obj)
    assert measured["minimumArea"] > 1e-8, measured
    if volume is None:
        assert measured["boundary"] == segments * 2, measured
    else:
        assert measured["manifold"] and measured["boundary"] == 0, measured
        assert abs(measured["volume"] - volume) < 0.0001, measured
    assert len(obj.data.uv_layers.active.data) == len(obj.data.loops)
    assert all(0 <= value <= 1 for loop in obj.data.uv_layers.active.data for value in loop.uv)

with tempfile.TemporaryDirectory(prefix="deepblend-lathe-") as temporary:
    output = Path(os.environ.get("DEEPBLEND_MODELING_OUTPUT", temporary))
    output.mkdir(parents=True, exist_ok=True)
    spec = json.loads((ROOT / "deepblend/fixtures/ceramic-vessel/scene-spec.json").read_text())
    build_scene(spec, {}, Guard())
    scene = bpy.context.scene
    scene.cycles.device = "CPU"
    before = inspect(bpy.data.objects["db_entity__vessel"])
    assert before["manifold"] and before["volume"] > 0
    checkpoint = output / "ceramic-vessel.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(checkpoint))
    bpy.ops.wm.open_mainfile(filepath=str(checkpoint))
    assert inspect(bpy.data.objects["db_entity__vessel"]) == before
    image = output / "ceramic-vessel.png"
    bpy.context.scene.render.filepath = str(image)
    bpy.ops.render.render(write_still=True)
    assert image.stat().st_size > 2000
    print("LATHE_PASSED: volume, manifold edges, open ends, poles, normals, UV, saved artifact, render")
