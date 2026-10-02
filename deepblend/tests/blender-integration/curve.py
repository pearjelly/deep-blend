"""Validate real swept geometry and render a handle on the vessel fixture."""
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


for capped in (True, False):
    reset_scene()
    obj = create_generator("pipe", {"shape": "curve", "path": [[0, 0, 0], [0, 0, 2]],
                                    "radius": 0.1, "capEnds": capped, "bevelResolution": 8})
    assert obj.type == "MESH"
    measured = inspect(obj)
    assert measured["minimumArea"] > 1e-9
    if capped:
        assert measured["manifold"] and measured["boundary"] == 0, measured
        assert abs(measured["volume"] - math.pi * 0.1 ** 2 * 2) < 0.0013, measured
    else:
        assert measured["boundary"] > 0, measured
    assert obj.data.uv_layers.active is not None, "curve conversion lost UVs"

reset_scene()
counts = []
for resolution in (0, 8):
    obj = create_generator("resolution", {"shape": "curve", "path": [[0, 0, 0], [0, 0, 1]],
                                           "bevelResolution": resolution})
    counts.append(len(obj.data.vertices))
assert counts[1] > counts[0], "section resolution was ignored"
reset_scene()
closed = create_generator("loop", {"shape": "curve", "path": [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]],
                                   "radius": 0.05, "pathClosed": True, "pathInterpolation": "bezier"})
assert inspect(closed)["manifold"], "closed curve left boundary edges"

with tempfile.TemporaryDirectory(prefix="deepblend-curve-") as temporary:
    output = Path(os.environ.get("DEEPBLEND_MODELING_OUTPUT", temporary))
    output.mkdir(parents=True, exist_ok=True)
    spec = json.loads((ROOT / "deepblend/fixtures/ceramic-vessel/scene-spec.json").read_text())
    spec["entities"].append({"id": "handle", "type": "generator", "materialId": "glaze",
                             "generator": {"shape": "curve", "radius": 0.006,
                                           "pathInterpolation": "bezier", "curveResolution": 24, "bevelResolution": 6,
                                           "path": [[0.062, 0, 0.147], [0.098, 0, 0.157], [0.127, 0, 0.138],
                                                    [0.13, 0, 0.105], [0.119, 0, 0.073], [0.078, 0, 0.055]]}})
    (output / "handled-vessel.scene-spec.json").write_text(json.dumps(spec, indent=2) + "\n")
    build_scene(spec, {}, Guard())
    bpy.context.scene.cycles.device = "CPU"
    obj = bpy.data.objects["db_entity__handle"]
    before = inspect(obj)
    assert before["manifold"] and before["volume"] > 0 and before["minimumArea"] > 1e-12
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "handled-vessel.blend"))
    bpy.ops.wm.open_mainfile(filepath=str(output / "handled-vessel.blend"))
    assert inspect(bpy.data.objects["db_entity__handle"]) == before
    image = output / "handled-vessel.png"
    bpy.context.scene.render.filepath = str(image)
    bpy.ops.render.render(write_still=True)
    assert image.stat().st_size > 2000
    print("CURVE_PASSED: section radius, volume, caps, closed path, UV, saved artifact, rendered handle")
