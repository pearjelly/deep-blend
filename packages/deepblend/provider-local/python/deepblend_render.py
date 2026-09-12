#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend preview renderer.

Renders exactly one frame from one camera out of an already-compiled ``.blend``
checkpoint. It never modifies the scene's geometry — a preview must show the
revision that was committed, not a new variant of it — with the single exception
of engine and sample overrides, which are render settings rather than scene
content and are always reported.

WHY ONE FRAME
-------------
M1's acceptance criterion is "可渲染主相机预览": a single camera preview plus a
checkpoint. Multi-view contact sheets and the visual-review loop are M2, and they
are a different feature, not a loop over this one. Keeping the render strictly
single-frame means a preview always costs one Blender launch and one image, which
is what makes it safe for the model to call on every iteration.

Runs inside Blender's embedded interpreter.
"""

import json
import os

import bpy

from deepblend_scene import describe_objects, resolve_engine
from deepblend_util import ActionError, error_text, report_progress


def open_checkpoint(path):
    """Open a ``.blend`` checkpoint and return its scene.

    ``check_existing=False`` keeps the operator from silently doing nothing when
    the path is already open, which would make a re-render of the same file
    report the PREVIOUS frame's settings.
    """
    if not os.path.isfile(path):
        raise ActionError(
            "REVISION_CHECKPOINT_MISSING",
            'no .blend checkpoint exists at "%s"' % (path,),
            {"checkpoint": path},
        )
    try:
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, check_existing=False)
    except Exception as exc:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'could not open the checkpoint "%s": %s' % (path, error_text(exc)),
            {"checkpoint": path},
        )
    scene = bpy.context.scene
    if scene is None:
        raise ActionError("BLENDER_SCRIPT_ERROR", 'the checkpoint "%s" opened without a scene' % (path,))
    return scene


def find_camera(scene, camera_id):
    """Find a camera object by its DeepBlend id, falling back to the scene camera.

    Resolution order is explicit rather than "whatever Blender considers active":
    a named camera that does not exist is an error (the caller asked for
    something specific), while an unnamed request falls back to the scene's own
    camera and then to the only camera present.
    """
    for obj in scene.objects:
        if obj.type != "CAMERA":
            continue
        if camera_id is not None and obj.get("deepblend_id") == camera_id:
            return obj, None

    if camera_id is not None:
        available = sorted(
            obj.get("deepblend_id") or obj.name for obj in scene.objects if obj.type == "CAMERA"
        )
        raise ActionError(
            "SCENE_CAMERA_MISSING",
            'the scene has no camera with id "%s"' % (camera_id,),
            {"requested": camera_id, "available": available},
        )

    if scene.camera is not None and scene.camera.type == "CAMERA":
        return scene.camera, None
    cameras = [obj for obj in scene.objects if obj.type == "CAMERA"]
    if len(cameras) == 1:
        return cameras[0], None
    if len(cameras) == 0:
        raise ActionError("SCENE_CAMERA_MISSING", "the scene contains no camera to render from")
    raise ActionError(
        "SCENE_CAMERA_MISSING",
        "the scene contains %d cameras and none is active; name one explicitly" % (len(cameras),),
        {"available": sorted(obj.get("deepblend_id") or obj.name for obj in cameras)},
    )


def apply_render_overrides(scene, options, guard):
    """Apply engine, resolution, sample and frame overrides for this one render.

    Overrides are reported as notices, always: a preview whose settings differ
    from the profile that produced it is a difference the caller must be able to
    see, even when the difference was requested.
    """
    applied = {}

    engine_key = options.get("engine")
    if engine_key:
        engine, downgrade = resolve_engine(engine_key, guard)
        if downgrade is not None:
            guard.warnings.append(downgrade)
        if scene.render.engine != engine:
            scene.render.engine = engine
            applied["engine"] = engine
            guard.note(
                "SCENE_COMPILER_DECISION",
                "preview rendered with engine override %s (checkpoint was compiled for %s)"
                % (engine, checkpoint_profile(scene).get("engine", "<unknown>")),
                {"engine": engine},
            )

    width = options.get("width")
    height = options.get("height")
    if width is not None or height is not None:
        new_width = int(width) if width is not None else scene.render.resolution_x
        new_height = int(height) if height is not None else scene.render.resolution_y
        if (new_width, new_height) != (scene.render.resolution_x, scene.render.resolution_y):
            scene.render.resolution_x = new_width
            scene.render.resolution_y = new_height
            applied["resolution"] = [new_width, new_height]
            guard.note(
                "SCENE_COMPILER_DECISION",
                "preview rendered at an override resolution %dx%d" % (new_width, new_height),
                {"resolution": [new_width, new_height]},
            )

    samples = options.get("samples")
    if samples is not None:
        samples = int(samples)
        if scene.render.engine == "CYCLES":
            scene.cycles.samples = samples
        elif scene.render.engine == "BLENDER_EEVEE":
            scene.eevee.taa_render_samples = samples
        applied["samples"] = samples

    if scene.render.resolution_percentage != 100:
        guard.note(
            "SCENE_COMPILER_DECISION",
            "checkpoint had resolution_percentage=%d; preview forces 100%% so the image matches the profile"
            % (scene.render.resolution_percentage,),
        )
        scene.render.resolution_percentage = 100

    return applied


def checkpoint_profile(scene):
    """The render profile the checkpoint was compiled with, from its audit record.

    Read out of the ``deepblend_render_config`` custom property that
    ``compile_scene`` stored on the scene. This is why that property exists: an
    override can then be reported as a DIFFERENCE ("compiled for BLENDER_EEVEE,
    rendered with CYCLES") instead of restating the value it just set.
    """
    try:
        config = scene.get("deepblend_render_config")
        if config:
            return json.loads(config)
    except Exception:
        pass
    return {}


def render_preview(options=None, guard=None, checkpoint=None, output=None, camera_id=None):
    """Render one preview frame and return a report describing the artifact.

    ``options`` carries optional overrides; ``checkpoint`` is the ``.blend`` to
    open; ``output`` is where the PNG must land.
    """
    options = options or {}
    if checkpoint is None:
        raise ActionError("REVISION_CHECKPOINT_MISSING", "a preview render needs a checkpoint .blend to open")
    if output is None:
        raise ActionError("BLENDER_SCRIPT_ERROR", "a preview render needs an output path")

    report_progress("open_checkpoint", 10)
    scene = open_checkpoint(checkpoint)

    report_progress("select_camera", 25)
    camera, _ = find_camera(scene, camera_id)
    scene.camera = camera

    report_progress("configure_render", 40)
    overrides = apply_render_overrides(scene, options, guard)

    frame = options.get("frame")
    if frame is None:
        # The middle of the project's range, not the first frame: a turntable's
        # first frame is the least informative angle of the whole revolution, and
        # a preview exists to show what the scene looks like.
        frame = int((scene.frame_start + scene.frame_end) / 2)
    frame = int(frame)
    scene.frame_set(frame)

    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = output

    report_progress("render", 55, {"engine": scene.render.engine, "frame": frame})
    try:
        bpy.ops.render.render(write_still=True)
    except Exception as exc:
        # EEVEE historically needs a GPU/GL context and can fail under
        # --background. That is a known environmental limitation, so it is
        # reported as an engine problem rather than as a corrupt scene, and the
        # caller can decide to retry with Cycles.
        raise ActionError(
            "BLENDER_ENGINE_UNAVAILABLE",
            'rendering with engine %s failed: %s' % (scene.render.engine, error_text(exc)),
            {"engine": scene.render.engine, "frame": frame},
        )

    if not os.path.isfile(output):
        raise ActionError(
            "RENDER_NO_OUTPUT",
            'engine %s reported success but wrote no file at "%s"' % (scene.render.engine, output),
            {"engine": scene.render.engine, "output": output},
        )

    width, height = png_dimensions(output) or (scene.render.resolution_x, scene.render.resolution_y)

    report_progress("render_done", 95)
    return {
        "outputPath": output,
        "bytes": os.path.getsize(output),
        "width": width,
        "height": height,
        "frame": frame,
        "fps": int(scene.render.fps),
        "frameStart": int(scene.frame_start),
        "frameEnd": int(scene.frame_end),
        "engine": scene.render.engine,
        "cameraId": camera.get("deepblend_id") or camera.name,
        "cameraName": camera.name,
        "lens": round(float(camera.data.lens), 6),
        "overrides": overrides,
        "renderConfig": _render_config(scene),
        "objects": describe_objects(),
    }


def png_dimensions(path):
    """Read width and height straight out of a PNG's IHDR chunk.

    Blender's in-memory "Render Result" is NOT readable in ``--background``: it
    reports ``size (0,0)`` and ``has_data=False``, and ``scale()`` raises "failed
    to load image buffer". Reading the file that was actually written is both
    simpler and more truthful — the artifact on disk is the thing being
    described, and if it disagrees with the requested resolution the caller should
    see the disagreement rather than the request echoed back.
    """
    try:
        with open(path, "rb") as stream:
            header = stream.read(33)
    except Exception:
        return None
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    try:
        width = int.from_bytes(header[16:20], "big")
        height = int.from_bytes(header[20:24], "big")
    except Exception:
        return None
    if width <= 0 or height <= 0:
        return None
    return width, height


def _render_config(scene):
    """The render settings actually in force when the frame was written."""
    samples = None
    try:
        if scene.render.engine == "CYCLES":
            samples = int(scene.cycles.samples)
        elif scene.render.engine == "BLENDER_EEVEE":
            samples = int(scene.eevee.taa_render_samples)
    except Exception:
        samples = None
    return {
        "engine": scene.render.engine,
        "resolution": [int(scene.render.resolution_x), int(scene.render.resolution_y)],
        "resolutionPercentage": int(scene.render.resolution_percentage),
        "samples": samples,
        "filmTransparent": bool(scene.render.film_transparent),
        "viewTransform": scene.view_settings.view_transform,
        "look": scene.view_settings.look,
        "exposure": round(float(scene.view_settings.exposure), 6),
        "fps": int(scene.render.fps),
        "frameStart": int(scene.frame_start),
        "frameEnd": int(scene.frame_end),
    }
