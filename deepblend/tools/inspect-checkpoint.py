#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Measure a compiled checkpoint's real geometry, in millimetres.

WHY THIS EXISTS
---------------
Run it inside Blender against a revision's `scene.blend`:

    Blender --background --factory-startup \
        .deepblend/projects/<project>/revisions/<rev>/scene.blend \
        --python deepblend/tools/inspect-checkpoint.py

Every object's world-space bounding box, dimensions, location, rotation and scale are
printed as one JSON document, in millimetres.

It exists because two separate review sessions each wrote it from scratch, and both
times it was the thing that found the defect:

  - a 36 mm dial cylinder sitting entirely INSIDE its case (y -5.7..-1.7 mm against a
    case front at y = -6.0 mm), so every camera measured it at zero visible pixels
    while the review scored the scene 100;
  - a dial "thinned" with `scale: [1, 0.0556, 1]`, which does not thin a cylinder: a
    cylinder takes its radius along local X and Y, and the dial's +90 degree X rotation
    maps local Y onto world Z, so the disc became a 36 x 2 mm sliver standing on edge.

The lesson both times was the same: a ScenePatch reports what was ASKED FOR, and the
only way to know what was BUILT is to measure the checkpoint. That measurement is what
this file is for, so the next session does not write it a third time.

Note the `depsgraph.update()`: `bound_box` is stale unless the dependency graph is
evaluated, and reading it before that update reports the PREVIOUS transform — which is
exactly the kind of wrong answer that looks like a real measurement.
"""

import json
import sys

import bpy
from mathutils import Vector

# Millimetres. SceneSpec works in metres; every geometry error found so far was a
# factor-of-1000 or a sub-millimetre relationship, and mm is the unit those read in.
MM = 1000.0
DEGREES = 57.29577951308232


def main():
    bpy.context.view_layer.update()
    bpy.context.evaluated_depsgraph_get().update()

    report = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        low = [min(corner[i] for corner in corners) * MM for i in range(3)]
        high = [max(corner[i] for corner in corners) * MM for i in range(3)]
        report[obj.name] = {
            "deepblend_id": obj.get("deepblend_id") or None,
            "min_mm": [round(value, 2) for value in low],
            "max_mm": [round(value, 2) for value in high],
            "dims_mm": [round(high[i] - low[i], 2) for i in range(3)],
            "loc_mm": [round(value * MM, 2) for value in obj.matrix_world.translation],
            "rot_deg": [round(value * DEGREES, 2) for value in obj.rotation_euler],
            "scale": [round(value, 5) for value in obj.scale],
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
        }

    # stdout, because this is a diagnostic a human reads, not a protocol result. The
    # Blender-side runtime's own rule (result documents go to a file) applies to
    # bootstrap actions; this is not one.
    print(json.dumps({"objects": report, "objectCount": len(report)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
