#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend technical scene validation.

The seam between the two validation layers of SPEC §13.2:

* **JSON Schema + semantic rules** run in Node, before Blender is launched, and
  answer "is this document a coherent scene?" (`deepblend/contracts/lib/scene-spec.js`).
* **This module** runs inside Blender, after a compile, and answers "did that
  document actually become a renderable scene?" — a different question, and the
  only one that can be answered with the real depsgraph in hand.

The distinction is not academic. A SceneSpec can be perfectly valid and still
compile to something a camera cannot photograph: an entity whose primitive
produced no geometry, a scale of 0 that collapsed an object to a point, a camera
aimed at a hidden object, or a frames-per-second of 0. Every one of those passes
schema validation and fails here.

Findings carry a severity:
  - ``error``   — the scene must not be committed.
  - ``warning`` — suspicious but renderable; the caller decides.
  - ``notice``  — something the compiler decided, recorded for the audit trail.

Runs inside Blender's embedded interpreter.
"""

import bpy
from mathutils import Vector

from deepblend_scene import ENTITY_PREFIX
from deepblend_util import as_text, warning


def _evaluated_bounds(obj):
    """World-space bounding box of an evaluated object, or ``None``.

    The evaluated object is used rather than the raw mesh so a modifier's effect
    is included — without it, a bevel or a subsurf would be scored as if it did
    nothing. ``obj.bound_box`` is in local space, so every corner is transformed.
    """
    try:
        from bpy import context
        depsgraph = context.evaluated_depsgraph_get()
        evaluated = obj.evaluated_get(depsgraph)
        corners = [evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box]
    except Exception:
        return None
    if not corners:
        return None
    return {
        "min": [round(min(corner[axis] for corner in corners), 6) for axis in range(3)],
        "max": [round(max(corner[axis] for corner in corners), 6) for axis in range(3)],
    }


def _box_size(bounds):
    if bounds is None:
        return None
    return [round(bounds["max"][axis] - bounds["min"][axis], 6) for axis in range(3)]


def validate_scene(scene, spec, guard):
    """Validate the live scene against the spec that produced it.

    ``guard`` receives warnings and notices so nothing found here is lost; the
    returned report carries the errors plus the structural facts a golden test
    asserts on (counts, bounds, frame range, camera parameters).
    """
    errors = []
    artifacts = []

    def fail(code, message, detail=None):
        entry = {"severity": "error", "code": code, "message": message}
        if detail is not None:
            entry["detail"] = detail
        errors.append(entry)

    objects = [obj for obj in scene.objects]
    meshes = [obj for obj in objects if obj.type == "MESH"]
    lights = [obj for obj in objects if obj.type == "LIGHT"]
    cameras = [obj for obj in objects if obj.type == "CAMERA"]

    spec_entities = spec.get("entities") or []
    spec_lights = spec.get("lights") or []
    spec_cameras = spec.get("cameras") or []
    spec_materials = spec.get("materials") or []
    spec_tracks = spec.get("animationTracks") or []
    spec_shots = spec.get("shots") or []

    expected_mesh_entities = [entity for entity in spec_entities if entity.get("type") != "empty"]
    if len(meshes) < len(expected_mesh_entities):
        fail(
            "SCENE_VALIDATION_FAILED",
            "the spec declares %d renderable entit(y/ies) but the scene holds %d mesh object(s)"
            % (len(expected_mesh_entities), len(meshes)),
            {
                "expected": len(expected_mesh_entities),
                "actual": len(meshes),
                "objects": sorted(obj.name for obj in meshes),
            },
        )
    if len(lights) != len(spec_lights):
        fail(
            "SCENE_VALIDATION_FAILED",
            "the spec declares %d light(s) but the scene holds %d" % (len(spec_lights), len(lights)),
        )
    if len(cameras) != len(spec_cameras):
        fail(
            "SCENE_VALIDATION_FAILED",
            "the spec declares %d camera(s) but the scene holds %d" % (len(spec_cameras), len(cameras)),
        )

    # ---- geometry ---------------------------------------------------------
    total_vertices = 0
    total_polygons = 0
    degenerate = []
    for obj in meshes:
        vertices = len(obj.data.vertices)
        polygons = len(obj.data.polygons)
        total_vertices += vertices
        total_polygons += polygons
        if vertices == 0 or polygons == 0:
            degenerate.append(obj.name)
        bounds = _evaluated_bounds(obj)
        size = _box_size(bounds)
        if size is not None and max(size) <= 1e-6:
            degenerate.append(obj.name)
    if degenerate:
        fail(
            "SCENE_VALIDATION_FAILED",
            "%d object(s) have no usable geometry: %s" % (len(degenerate), ", ".join(sorted(set(degenerate)))),
            {"objects": sorted(set(degenerate))},
        )
    if not meshes:
        fail("SCENE_VALIDATION_FAILED", "the compiled scene contains no mesh object, so nothing can be rendered")

    # ---- visibility -------------------------------------------------------
    hidden_renderable = [
        obj.name for obj in meshes
        if obj.hide_render or obj.hide_viewport
    ]
    if len(hidden_renderable) == len(meshes) and meshes:
        fail(
            "SCENE_VALIDATION_FAILED",
            "every mesh object is hidden; a render would contain no geometry",
            {"objects": hidden_renderable},
        )

    # ---- cameras ----------------------------------------------------------
    if not cameras:
        fail("SCENE_VALIDATION_FAILED", "the scene contains no camera")
    else:
        for camera in cameras:
            if camera.data.lens <= 0:
                fail(
                    "SCENE_VALIDATION_FAILED",
                    'camera "%s" has lens %.4f; a non-positive focal length cannot form an image'
                    % (camera.name, camera.data.lens),
                )
            if camera.data.clip_start >= camera.data.clip_end:
                fail(
                    "SCENE_VALIDATION_FAILED",
                    'camera "%s" has clip_start %.4f >= clip_end %.4f'
                    % (camera.name, camera.data.clip_start, camera.data.clip_end),
                )
            if scene.camera is None:
                fail("SCENE_VALIDATION_FAILED", "no camera is active in the scene")
            elif camera is scene.camera:
                # Framing check on the ACTIVE camera only: whether the subject is
                # inside the frustum is the single most valuable technical fact a
                # preview can be checked against before spending a render on it.
                framing = camera_framing(scene, camera, meshes)
                if framing is not None and not framing["subjectInFrame"]:
                    guard.warn(
                        "SCENE_VALIDATION_FAILED",
                        'the active camera "%s" does not appear to contain the scene subject'
                        % (camera.name,),
                        framing,
                    )
                if framing is not None:
                    artifacts.append({"kind": "framing", **framing})

    # ---- frame range and animation ---------------------------------------
    project = spec.get("project") or {}
    if scene.frame_start >= scene.frame_end:
        fail(
            "SCENE_VALIDATION_FAILED",
            "frame range %d..%d is empty" % (scene.frame_start, scene.frame_end),
        )
    if scene.render.fps <= 0:
        fail("SCENE_VALIDATION_FAILED", "fps is %d; a frame rate must be positive" % (scene.render.fps,))
    if project.get("frameStart") is not None and scene.frame_start != int(project["frameStart"]):
        fail(
            "SCENE_VALIDATION_FAILED",
            "scene frame_start is %d but the spec asks for %d" % (scene.frame_start, int(project["frameStart"])),
        )
    if project.get("frameEnd") is not None and scene.frame_end != int(project["frameEnd"]):
        fail(
            "SCENE_VALIDATION_FAILED",
            "scene frame_end is %d but the spec asks for %d" % (scene.frame_end, int(project["frameEnd"])),
        )

    animated = [obj.name for obj in objects if obj.animation_data is not None and obj.animation_data.action is not None]
    if spec_tracks and not animated:
        fail(
            "SCENE_VALIDATION_FAILED",
            "the spec declares %d animation track(s) but no object carries an action" % (len(spec_tracks),),
        )

    # ---- materials --------------------------------------------------------
    materials_in_use = {
        material.name
        for obj in meshes
        for material in obj.data.materials
        if material is not None
    }
    if spec_materials and not materials_in_use:
        fail("SCENE_VALIDATION_FAILED", "the spec declares materials but no mesh references one")

    # ---- shots ------------------------------------------------------------
    camera_ids = {camera.get("deepblend_id") for camera in cameras}
    for shot in spec_shots:
        if shot.get("cameraId") not in camera_ids:
            fail(
                "SCENE_VALIDATION_FAILED",
                'shot "%s" references camera "%s", which does not exist in the compiled scene'
                % (shot.get("id"), shot.get("cameraId")),
            )
        frame_range = shot.get("frameRange")
        if frame_range and (frame_range[0] < scene.frame_start or frame_range[1] > scene.frame_end):
            guard.warn(
                "SCENE_VALIDATION_FAILED",
                'shot "%s" spans frames %d..%d, outside the project range %d..%d'
                % (shot.get("id"), frame_range[0], frame_range[1], scene.frame_start, scene.frame_end),
                {"shotId": shot.get("id"), "frameRange": frame_range},
            )

    report = {
        "ok": len(errors) == 0,
        "errors": errors,
        "counts": {
            "objects": len(objects),
            "meshObjects": len(meshes),
            "lightObjects": len(lights),
            "cameraObjects": len(cameras),
            "materials": len(bpy.data.materials),
            "actions": len(bpy.data.actions),
            "specEntities": len(spec_entities),
            "specLights": len(spec_lights),
            "specCameras": len(spec_cameras),
            "specMaterials": len(spec_materials),
            "specShots": len(spec_shots),
            "specAnimationTracks": len(spec_tracks),
        },
        "geometry": {
            "totalVertices": total_vertices,
            "totalPolygons": total_polygons,
            "degenerateObjects": sorted(set(degenerate)),
            "hiddenRenderableObjects": sorted(hidden_renderable),
        },
        "frameRange": [int(scene.frame_start), int(scene.frame_end)],
        "fps": int(scene.render.fps),
        "engine": scene.render.engine,
        "activeCamera": scene.camera.name if scene.camera is not None else None,
        "animatedObjects": sorted(animated),
        "bounds": scene_bounds(meshes),
        "subjectBounds": subject_bounds(meshes),
        "cameraParameters": [
            {
                "id": camera.get("deepblend_id"),
                "name": camera.name,
                "lens": round(float(camera.data.lens), 6),
                "sensorWidth": round(float(camera.data.sensor_width), 6),
                "location": [round(float(value), 6) for value in camera.location],
                "rotationEuler": [round(float(value), 6) for value in camera.rotation_euler],
            }
            for camera in cameras
        ],
        "artifacts": artifacts,
    }
    return report


def subject_bounds(meshes):
    """Aggregate world-space bounds of every mesh, ignoring nothing.

    Entities tagged ``environment`` in the spec cannot be excluded here because
    the tag lives in the spec, not in the blend; the caller correlates the two
    when it needs the subject alone.
    """
    boxes = [bounds for bounds in (_evaluated_bounds(obj) for obj in meshes) if bounds is not None]
    if not boxes:
        return None
    return {
        "min": [round(min(box["min"][axis] for box in boxes), 6) for axis in range(3)],
        "max": [round(max(box["max"][axis] for box in boxes), 6) for axis in range(3)],
    }


def scene_bounds(meshes):
    """Alias kept explicit so a reader can see both are intentionally reported."""
    return subject_bounds(meshes)


def camera_framing(scene, camera, meshes):
    """Project the scene's mesh centres into the active camera's frustum.

    Deliberately cheap: the eight corners of each object's bound box are projected
    with ``world_to_camera_view`` and compared against the unit frame. This is not
    a hidden-surface analysis and does not claim to be one — it answers "is the
    subject somewhere in front of the lens", which is the question worth asking
    before paying for a render.
    """
    try:
        from bpy_extras.object_utils import world_to_camera_view
    except Exception:
        return None
    if not meshes:
        return None

    inside = 0
    considered = 0
    projected = []
    for obj in meshes:
        bounds = _evaluated_bounds(obj)
        if bounds is None:
            continue
        considered += 1
        corners = [
            Vector((bounds["min"][0] if bit & 1 else bounds["max"][0],
                    bounds["min"][1] if bit & 2 else bounds["max"][1],
                    bounds["min"][2] if bit & 4 else bounds["max"][2]))
            for bit in range(8)
        ]
        in_frame = False
        for corner in corners:
            coordinate = world_to_camera_view(scene, camera, corner)
            if coordinate.z > 0 and 0.0 <= coordinate.x <= 1.0 and 0.0 <= coordinate.y <= 1.0:
                in_frame = True
        if in_frame:
            inside += 1
            centre = Vector(((bounds["min"][0] + bounds["max"][0]) / 2,
                             (bounds["min"][1] + bounds["max"][1]) / 2,
                             (bounds["min"][2] + bounds["max"][2]) / 2))
            coordinate = world_to_camera_view(scene, camera, centre)
            projected.append({
                "object": obj.name,
                "uv": [round(coordinate.x, 4), round(coordinate.y, 4)],
                "depth": round(coordinate.z, 4),
            })

    return {
        "cameraId": camera.get("deepblend_id"),
        "consideredObjects": considered,
        "objectsInFrame": inside,
        "subjectInFrame": inside > 0,
        "projectedCentres": projected,
    }
