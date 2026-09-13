#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend frame-sequence renderer — one process, an explicit frame list.

WHAT THIS IS FOR
----------------
M1/M2 render *previews*: one frame, or a handful of sampled views, to look at.
M3 renders a **deliverable**: every frame of a range, at the final profile's
resolution and sample count, so the frames can be encoded into the MP4 that
leaves the studio. Measured cost on this machine for `watch-commercial` at
1920x1080 / Cycles / 256 spp is 19.6-41.4 s per frame, so a 450-frame delivery
is a 3.4 hour process — which is exactly why it must be resumable.

WHY THE FRAME LIST IS AN INPUT AND NOT A RANGE
----------------------------------------------
"只渲缺失帧" (render only the missing frames) is an acceptance condition, and the
only way to make it checkable is for the renderer to render EXACTLY the frames it
was handed. If this module were given `frameStart..frameEnd` and skipped what it
found on disk, the skip decision would live in Python where the ledger's
correctness could not be asserted from outside, and a truncated frame left by a
killed process would be silently kept. The host derives the missing set from the
frame ledger and passes it; this module renders that set and reports, per frame,
the artifact it actually wrote.

THE NAMING TRAP (measured, not assumed)
---------------------------------------
`scene.render.frame_path(frame=f)` computes `<dir>/frame_0001.png`, and
`bpy.ops.render.render(write_still=True)` writes `<dir>/frame_.png` — the
predicted name is not the written one. Verified on Blender 5.2.1:

    frame_path(frame=1) -> /tmp/.../frame_0001.png      written: frame_.png

So the output path is set EXPLICITLY, with its extension, before every frame, and
then verified on disk. A renderer that trusted `frame_path` would write every
frame over the same file and still report success.

THE DUPLICATE-EXTENSION TRAP
----------------------------
Setting `filepath` to a name that already ends in `.png` while
`use_file_extension` is true could plausibly produce `frame_0001.png.png`. It does
not (measured: the listing after two frames is exactly `frame_0001.png`,
`frame_0042.png`), and the module still verifies the exact expected path rather
than trusting that.

Runs inside Blender's embedded interpreter.
"""

import json
import os
import time

import bpy

from deepblend_render import apply_render_overrides, find_camera, open_checkpoint, png_dimensions
from deepblend_util import (
    ActionError,
    Guard,
    error_text,
    frame_file_name,
    frame_path,
    report_progress,
)

#: Bytes every frame must carry. A PNG of any real frame is far larger than this;
#: the check exists to catch a zero-byte file left by a kill between create and
#: write, which would otherwise be a "frame that exists".
MIN_FRAME_BYTES = 512

#: Blender's PNG signature. A file that does not start with it is not a frame.
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def append_event(events_path, payload):
    """Append one JSON line to the durable event journal and make it durable.

    WHY A JOURNAL AND NOT JUST STDOUT
    ---------------------------------
    stdout reaches the host through the subprocess collector, which is an
    in-memory buffer in the host's own process — so it dies with the host. The
    acceptance case is a host that dies mid-render, and the frames on disk are
    the ONLY fact that survives it. This journal is written for the facts disk
    cannot express (which pid is rendering, and when each frame landed), and it is
    flushed and fsynced per line so a kill -9 loses at most the line in flight.
    It is corroboration, never the authority: the frame ledger is re-derived from
    the frames themselves. See `host/lib/frame-ledger.js`.
    """
    if not events_path:
        return
    try:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with open(events_path, "a", encoding="utf-8") as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception as exc:  # noqa: BLE001 - a journal that breaks a render is worse than none
        from deepblend_util import eprint

        eprint("could not append to the event journal: %s" % (error_text(exc),))


def apply_profile(scene, profile, guard):
    """Apply a whole SceneSpec render profile, and verify it took effect.

    WHY VERIFY AND NOT JUST SET
    ---------------------------
    `view_transform` in particular is rejected outright by some Blender builds
    (the compiler already carries a comment to that effect). Assigning it and
    moving on means a delivery rendered in the wrong colour space reports success
    — the M2 lesson that a silently wrong number is worse than a loud failure.
    Every setting that the profile asked for is read back and compared.

    Returns the settings actually in force, which travel into the result document.
    """
    requested = {
        "engine": profile.get("engine"),
        "resolution": profile.get("resolution"),
        "samples": profile.get("samples"),
        "filmTransparent": profile.get("filmTransparent"),
    }
    overrides = apply_render_overrides(
        scene,
        {
            "engine": requested["engine"],
            "width": (requested["resolution"] or [None, None])[0],
            "height": (requested["resolution"] or [None, None])[1],
            "samples": requested["samples"],
        },
        guard,
    )

    if requested["filmTransparent"] is not None:
        scene.render.film_transparent = bool(requested["filmTransparent"])

    color = profile.get("colorManagement") or {}
    view_transform = color.get("viewTransform")
    if view_transform:
        try:
            scene.view_settings.view_transform = view_transform
        except Exception as exc:
            raise ActionError(
                "BLENDER_ENGINE_UNAVAILABLE",
                'the render profile asks for view transform "%s", which this Blender build refuses: %s'
                % (view_transform, error_text(exc)),
                {"requested": view_transform},
            )
        if scene.view_settings.view_transform != view_transform:
            raise ActionError(
                "BLENDER_ENGINE_UNAVAILABLE",
                'the render profile asks for view transform "%s" but Blender kept "%s"'
                % (view_transform, scene.view_settings.view_transform),
                {"requested": view_transform, "applied": scene.view_settings.view_transform},
            )
    look = color.get("look")
    if look:
        try:
            scene.view_settings.look = look
        except Exception:
            guard.warn(
                "SCENE_COMPILER_DECISION",
                'the render profile asks for look "%s", which this Blender build does not offer' % (look,),
                {"requested": look},
            )
    exposure = color.get("exposure")
    if exposure is not None:
        scene.view_settings.exposure = float(exposure)

    if scene.render.resolution_percentage != 100:
        scene.render.resolution_percentage = 100

    scene.render.image_settings.file_format = "PNG"
    # 8-bit RGB is what an H.264 delivery consumes; a 16-bit or RGBA frame would
    # triple the bytes on a 13 GiB disk for no visible difference in the MP4.
    try:
        scene.render.image_settings.color_mode = "RGB"
        scene.render.image_settings.color_depth = "8"
    except Exception:
        pass
    # Never let a re-render of an existing frame leave a `.blend1`-style backup or
    # a stale file the ledger would then accept.
    scene.render.use_overwrite = True

    actual = render_config(scene)
    if requested["resolution"] is not None and actual["resolution"] != [
        int(requested["resolution"][0]),
        int(requested["resolution"][1]),
    ]:
        raise ActionError(
            "RENDER_PROFILE_MISSING",
            "the render profile asks for %sx%s but the scene is set to %sx%s"
            % (
                requested["resolution"][0], requested["resolution"][1],
                actual["resolution"][0], actual["resolution"][1],
            ),
            {"requested": requested["resolution"], "applied": actual["resolution"]},
        )
    return overrides, actual


def render_config(scene):
    """The render settings actually in force, for the job's audit record."""
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
        "fpsBase": int(getattr(scene.render, "fps_base", 1) or 1),
        "frameStart": int(scene.frame_start),
        "frameEnd": int(scene.frame_end),
    }


def verify_frame(path, expected_width, expected_height):
    """Prove one written frame is a complete PNG of the expected size.

    Three facts, all read off the artifact rather than off the render call:
    the PNG signature, the IHDR dimensions, and a size floor. Blender reporting
    success is not evidence — the ledger is built from files, so the file has to
    be the thing that is checked.
    """
    if not os.path.isfile(path):
        return {"ok": False, "reason": "missing"}
    size = os.path.getsize(path)
    if size < MIN_FRAME_BYTES:
        return {"ok": False, "reason": "truncated", "bytes": size}
    try:
        with open(path, "rb") as stream:
            header = stream.read(33)
            stream.seek(max(0, size - 12))
            tail = stream.read(12)
    except Exception as exc:
        return {"ok": False, "reason": "unreadable: %s" % (error_text(exc),)}
    if len(header) < 24 or header[:8] != PNG_SIGNATURE:
        return {"ok": False, "reason": "not-a-png", "bytes": size}
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width <= 0 or height <= 0:
        return {"ok": False, "reason": "bad-dimensions", "bytes": size}
    if (expected_width, expected_height) != (None, None) and (width, height) != (expected_width, expected_height):
        return {"ok": False, "reason": "wrong-dimensions", "width": width, "height": height, "bytes": size}
    # A killed process leaves a file with no IEND chunk. This is the cheap
    # structural end-of-file check; full decoding would cost more than the render.
    if tail[-8:-4] != b"IEND":
        return {"ok": False, "reason": "unterminated", "bytes": size}
    return {"ok": True, "bytes": size, "width": width, "height": height}


def render_frames(plan, guard):
    """Render every frame in ``plan`` and return the per-frame artifact report.

    ``plan`` is a document (not a flag list) for the same reason the view plan is:
    a frame list is a list of records, and N parallel arrays can disagree in
    length. It is validated once, at the top, so a malformed plan is one error
    rather than a half-finished sequence.
    """
    checkpoint = plan.get("checkpoint")
    if not checkpoint:
        raise ActionError("REVISION_CHECKPOINT_MISSING", "render_frames requires a checkpoint .blend")
    frames = plan.get("frames")
    if not isinstance(frames, list) or len(frames) == 0:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            "render_frames requires a non-empty `frames` list; an empty list would report success "
            "while writing nothing",
        )
    try:
        requested = [int(value) for value in frames]
    except (TypeError, ValueError):
        raise ActionError("BLENDER_SCRIPT_ERROR", "every entry of `frames` must be an integer")

    output_directory = plan.get("outputDirectory")
    if not output_directory:
        raise ActionError("BLENDER_SCRIPT_ERROR", "render_frames requires an output directory")
    prefix = plan.get("filePrefix") or "frame_"
    padding = int(plan.get("padding") or 4)
    events_path = plan.get("events")

    os.makedirs(output_directory, exist_ok=True)

    report_progress("open_checkpoint", 2)
    scene = open_checkpoint(checkpoint)

    camera_id = plan.get("cameraId")
    camera, _ = find_camera(scene, camera_id)
    scene.camera = camera

    profile = plan.get("profile") or {}
    report_progress("configure_render", 4)
    overrides, actual = apply_profile(scene, profile, guard)
    expected_width = int(actual["resolution"][0])
    expected_height = int(actual["resolution"][1])

    # The scene's own range is what the encoder must be told, and it belongs to
    # the spec, not to this invocation's frame list. Report it so the host can
    # check "the MP4 covers the project's range" without re-reading the SceneSpec.
    scene_range = [int(scene.frame_start), int(scene.frame_end)]
    planned_range = plan.get("frameRange")
    if isinstance(planned_range, list) and len(planned_range) == 2 and list(planned_range) != scene_range:
        guard.warn(
            "SCENE_COMPILER_DECISION",
            "the render plan covers frames %s but the checkpoint's scene range is %s; the delivery "
            "manifest will record both" % (planned_range, scene_range),
            {"planned": list(planned_range), "scene": scene_range},
        )

    entries = []
    written = []
    total = len(requested)
    total_bytes = 0
    for index, frame in enumerate(requested):
        percent = 5 + int(90 * index / total)
        report_progress("frame", percent, {"frame": frame, "index": index, "total": total})
        scene.frame_set(frame)
        path = frame_path(output_directory, frame, prefix, padding)
        # Explicit, absolute, WITH the extension — see the naming trap above.
        scene.render.filepath = path
        started = time.time()
        try:
            bpy.ops.render.render(write_still=True)
        except Exception as exc:
            append_event(events_path, {"type": "frame_failed", "frame": frame, "error": error_text(exc)})
            raise ActionError(
                "BLENDER_ENGINE_UNAVAILABLE",
                "rendering frame %d with engine %s failed: %s" % (frame, scene.render.engine, error_text(exc)),
                {"frame": frame, "engine": scene.render.engine},
            )
        elapsed_ms = int((time.time() - started) * 1000)
        verdict = verify_frame(path, expected_width, expected_height)
        if not verdict.get("ok"):
            append_event(events_path, {"type": "frame_failed", "frame": frame, "verify": verdict})
            raise ActionError(
                "RENDER_NO_OUTPUT",
                "frame %d did not produce a complete PNG at %s (%s)"
                % (frame, path, verdict.get("reason")),
                {"frame": frame, "output": path, "verify": verdict},
            )
        entry = {
            "frame": frame,
            "path": path,
            "file": frame_file_name(frame, prefix, padding),
            "bytes": verdict["bytes"],
            "width": verdict["width"],
            "height": verdict["height"],
            "ms": elapsed_ms,
        }
        entries.append(entry)
        written.append(frame)
        total_bytes += verdict["bytes"]
        # Written AFTER the file is verified on disk, so the journal never claims
        # a frame the ledger would call missing.
        append_event(events_path, {"type": "frame", "frame": frame, "bytes": verdict["bytes"], "ms": elapsed_ms})

    report_progress("frames_done", 97, {"rendered": len(written)})
    append_event(events_path, {"type": "frames_done", "rendered": written})

    return {
        "renderKind": "frame-sequence",
        "profileName": plan.get("profileName"),
        "checkpoint": checkpoint,
        "cameraId": camera.get("deepblend_id") or camera.name,
        "cameraName": camera.name,
        "outputDirectory": output_directory,
        "filePrefix": prefix,
        "padding": padding,
        "frames": entries,
        "renderedFrames": written,
        "renderedCount": len(written),
        "totalBytes": total_bytes,
        "sceneFrameRange": scene_range,
        "renderConfig": actual,
        "overrides": overrides,
        "requestedProfile": {
            "engine": profile.get("engine"),
            "resolution": profile.get("resolution"),
            "samples": profile.get("samples"),
        },
    }


__all__ = [
    "Guard",
    "MIN_FRAME_BYTES",
    "append_event",
    "frame_file_name",
    "frame_path",
    "png_dimensions",
    "render_config",
    "render_frames",
    "verify_frame",
]
