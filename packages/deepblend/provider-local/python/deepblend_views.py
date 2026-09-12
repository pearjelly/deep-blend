#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend multi-view preview renderer.

Renders a **plan** of views — each one a (camera, frame) pair — out of an
already-compiled ``.blend`` checkpoint, in a single Blender process, and returns
one measurement record per view.

WHY ONE PROCESS FOR N VIEWS
---------------------------
Every Blender launch costs roughly 0.4 s of cold start on top of the render
itself, and the M2 visual loop renders four views per round for up to five
rounds. Launching once per view would spend about two minutes on startup alone.
Rendering them all from one opened checkpoint also guarantees the views really do
describe ONE scene state: four separate launches could in principle open four
different files if something changed in between.

WHAT IS MEASURED, AND WHY IT IS MEASURED HERE
---------------------------------------------
Pixel facts are computed in this process rather than in Node because the decoder
is already here (``bpy.data.images`` + numpy) and because the alternative is a
second PNG decoder in a second language — the exact kind of duplicate that drifts.
The measurements are the *evidence* half of a visual review: the model may judge,
but it may not invent numbers (decision D30).

Tracked objects are measured by **isolation**: with every object except the
target hidden, the number of non-black pixels in the frame is exactly that
object's full silhouette area, and the count in the normal render is exactly how
much of it survives occlusion. That difference is the only occlusion evidence in
this system that is *definitional* rather than heuristic — a luminance threshold
cannot tell "the subject is dark" from "the subject is behind something".

Runs inside Blender's embedded interpreter.
"""

import os
import tempfile

import bpy
import numpy as np

from deepblend_render import (
    apply_render_overrides,
    checkpoint_profile,
    find_camera,
    open_checkpoint,
    png_dimensions,
)
from deepblend_scene import describe_objects
from deepblend_util import ActionError, error_text, report_progress


#: A pixel counts as "belonging to the subject" in a mask render when it is at
#: least this bright. The mask render composites a solid white silhouette with no
#: lighting, so its interior is exactly 1.0 and its background exactly 0.0; the
#: threshold only has to absorb PNG quantisation and a possible view transform.
MASK_THRESHOLD = 0.5

#: Cap on ray-cast samples per tracked object per view; see `_visible_samples`.
MAX_RAY_CASTS = 4000

#: Histogram bucket count for the luminance distribution. 64 buckets is enough to
#: see a clipped shadow or a blown highlight and small enough to carry in JSON.
HISTOGRAM_BUCKETS = 64

#: Luminance weights (Rec. 709). The renderer writes display-referred sRGB values,
#: which is what a viewer — and the model — actually sees.
_LUMA_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def render_views(options, guard):
    """Render a plan of views and measure each one.

    ``options['views']`` is a JSON document::

        {
          "checkpoint": "<path.blend>",
          "engine": "cycles",              # optional override
          "samples": 16,                   # optional override
          "width": 640, "height": 360,     # optional override
          "track": ["watch-body", ...],    # object ids to measure by isolation
          "views": [
            {"id": "main", "role": "active-camera", "cameraId": "camera-main",
             "frame": 22, "output": "/abs/path/main.png"},
            ...
          ]
        }

    Returns ``{"views": [...], "checkpoint": ..., "renderConfig": {...},
    "objects": [...]}`` where every view entry carries its artifact facts AND its
    measurements.
    """
    plan = options.get("views")
    if not isinstance(plan, dict):
        raise ActionError("BLENDER_SCRIPT_ERROR", "render_views requires a view plan document")

    checkpoint = plan.get("checkpoint")
    if not checkpoint:
        raise ActionError("REVISION_CHECKPOINT_MISSING", "the view plan names no checkpoint .blend")

    entries = plan.get("views")
    if not isinstance(entries, list) or len(entries) == 0:
        raise ActionError("BLENDER_SCRIPT_ERROR", "the view plan contains no views")

    tracked = plan.get("track")
    tracked = [str(entry) for entry in tracked] if isinstance(tracked, list) else []

    report_progress("open_checkpoint", 5)
    scene = open_checkpoint(checkpoint)

    overrides = apply_render_overrides(
        scene,
        {
            "engine": plan.get("engine"),
            "width": plan.get("width"),
            "height": plan.get("height"),
            "samples": plan.get("samples"),
        },
        guard,
    )

    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_percentage = 100

    object_index = _object_index(scene)
    measurements = []
    total = len(entries)

    # Isolation masks are scratch: they are read into numpy and deleted in the
    # same breath, so they live in a private directory that this action removes
    # before returning. Nothing about them is an artifact.
    scratch = tempfile.mkdtemp(prefix="deepblend-masks-")
    try:
        for position, entry in enumerate(entries):
            base = 8.0 + (position / float(total)) * 84.0
            measurements.append(
                _render_one(scene, entry, tracked, object_index, guard, base, scratch)
            )
    finally:
        _remove_tree(scratch)

    report_progress("render_views_done", 95)
    return {
        "checkpoint": checkpoint,
        "views": measurements,
        "overrides": overrides,
        "renderConfig": _render_config(scene),
        "objects": describe_objects(),
        "tracked": tracked,
    }


def _render_one(scene, entry, tracked, object_index, guard, base_percent, scratch):
    """Render one view, then measure it. Returns the view's report entry."""
    if not isinstance(entry, dict):
        raise ActionError("BLENDER_SCRIPT_ERROR", "every view in the plan must be an object")

    view_id = str(entry.get("id") or entry.get("cameraId") or "view")
    output = entry.get("output")
    if not output:
        raise ActionError("BLENDER_SCRIPT_ERROR", 'view "%s" names no output path' % (view_id,))
    # Resolve against this process's working directory. Blender resolves a RELATIVE
    # `render.filepath` against the .blend file's directory (or its own default),
    # NOT against the process cwd — so a plan that names bare file names, which is
    # what keeps it from escaping the invocation directory, is made absolute here.
    output = os.path.abspath(output)

    report_progress("select_camera", base_percent, {"view": view_id})
    camera, _ = find_camera(scene, entry.get("cameraId"))
    scene.camera = camera

    frame = entry.get("frame")
    if frame is None:
        frame = int((scene.frame_start + scene.frame_end) / 2)
    frame = int(frame)
    scene.frame_set(frame)

    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    scene.render.filepath = output

    report_progress("render", base_percent + 2.0, {"view": view_id, "frame": frame})
    try:
        bpy.ops.render.render(write_still=True)
    except Exception as exc:
        raise ActionError(
            "BLENDER_ENGINE_UNAVAILABLE",
            'rendering view "%s" with engine %s failed: %s'
            % (view_id, scene.render.engine, error_text(exc)),
            {"view": view_id, "engine": scene.render.engine, "frame": frame},
        )

    if not os.path.isfile(output):
        raise ActionError(
            "RENDER_NO_OUTPUT",
            'engine %s reported success but wrote no file for view "%s" at "%s"'
            % (scene.render.engine, view_id, output),
            {"view": view_id, "output": output},
        )

    report_progress("measure", base_percent + 5.0, {"view": view_id})
    width, height = png_dimensions(output) or (
        int(scene.render.resolution_x),
        int(scene.render.resolution_y),
    )

    entry_report = {
        "viewId": view_id,
        "role": entry.get("role"),
        "outputPath": output,
        "bytes": os.path.getsize(output),
        "width": width,
        "height": height,
        "frame": frame,
        "cameraId": camera.get("deepblend_id") or camera.name,
        "cameraName": camera.name,
        "lens": round(float(camera.data.lens), 6),
        "engine": scene.render.engine,
        "metrics": measure_view(scene, output, tracked, object_index, guard, view_id, scratch),
    }
    return entry_report


def measure_view(scene, image_path, tracked, object_index, guard, view_id, scratch):
    """Compute the deterministic measurements for one rendered frame.

    Split out from ``_render_one`` because it is the part that must be *testable
    and stable*: the scorer consumes exactly this document, and a change here is a
    change in what the product calls a problem.
    """
    rgb = _load_rgb(image_path)
    if rgb is None:
        guard.warn(
            "RENDER_NO_OUTPUT",
            'view "%s" was rendered but its pixels could not be read back for measurement' % (view_id,),
            {"output": image_path},
        )
        return None

    luminance = rgb @ _LUMA_WEIGHTS
    height, width = luminance.shape

    clipped_dark = float(np.count_nonzero(luminance <= 0.02)) / float(luminance.size)
    clipped_bright = float(np.count_nonzero(luminance >= 0.98)) / float(luminance.size)
    histogram, _ = np.histogram(luminance, bins=HISTOGRAM_BUCKETS, range=(0.0, 1.0))

    metrics = {
        "width": int(width),
        "height": int(height),
        "luminance": {
            "mean": round(float(luminance.mean()), 6),
            "median": round(float(np.median(luminance)), 6),
            "p05": round(float(np.percentile(luminance, 5)), 6),
            "p95": round(float(np.percentile(luminance, 95)), 6),
            "stdDev": round(float(luminance.std()), 6),
            "clippedDarkFraction": round(clipped_dark, 6),
            "clippedBrightFraction": round(clipped_bright, 6),
            "histogram": [int(value) for value in histogram],
        },
        "objects": [],
    }

    for object_id in tracked:
        metrics["objects"].append(
            _measure_object(scene, luminance, object_id, tracked, object_index, guard, view_id, scratch)
        )

    return metrics


def _measure_object(scene, luminance, object_id, tracked, index, guard, view_id, scratch_dir):
    """Measure one tracked object's visibility in this view.

    ``silhouettePixels`` is how large the object would be with nothing in the way;
    ``visiblePixels`` is how much of that it actually owns in the composed frame.
    The ratio between them is the occlusion evidence.
    """
    entry = {
        "id": object_id,
        "viewId": view_id,
        "visiblePixels": 0,
        "silhouettePixels": 0,
        "visibleFraction": 0.0,
        "occludedFraction": 0.0,
        "frameCoverage": 0.0,
        "silhouetteCoverage": 0.0,
        "bbox": None,
        "centroid": None,
        "inFrame": False,
    }

    target = index.get(object_id)
    if target is None:
        # A tracked object that is not in the scene is a real finding, not an
        # error: the scene may have been legitimately edited away from it, and the
        # caller must be able to see that rather than receive a silent zero.
        guard.note(
            "SCENE_COMPILER_DECISION",
            'view "%s" tracks object "%s", which is not present in this scene' % (view_id, object_id),
            {"object": object_id, "view": view_id},
        )
        return entry

    # An object the scene HIDES is not "occluded": it is not there. Reporting it as
    # fully occluded would send the reviewer looking for a blocker that does not
    # exist, and the fix for a hidden object is `entity.visibility.set`, which is a
    # different finding with a different code.
    if target.hide_render:
        guard.note(
            "SCENE_COMPILER_DECISION",
            'view "%s" tracks object "%s", which this scene hides; it is measured as absent, not as occluded'
            % (view_id, object_id),
            {"object": object_id, "view": view_id},
        )
        return entry

    mask = _isolation_mask(scene, target, scratch_dir)
    if mask is None:
        return entry

    mask = mask[: luminance.shape[0], : luminance.shape[1]]
    silhouette = int(np.count_nonzero(mask))
    entry["silhouettePixels"] = silhouette
    entry["silhouetteCoverage"] = round(float(silhouette) / float(luminance.size), 6)

    visible_pixels, agrees = _visibility(scene, target, mask, tracked, index)
    entry["visiblePixels"] = visible_pixels

    if silhouette > 0:
        entry["frameCoverage"] = round(float(visible_pixels) / float(luminance.size), 6)
        rows = np.nonzero(mask.any(axis=1))[0]
        columns = np.nonzero(mask.any(axis=0))[0]
        if rows.size > 0 and columns.size > 0:
            height, width = mask.shape
            entry["bbox"] = [
                round(float(columns[0]) / width, 6),
                round(float(rows[0]) / height, 6),
                round(float(columns[-1] + 1) / width, 6),
                round(float(rows[-1] + 1) / height, 6),
            ]
            coordinates = np.argwhere(mask)
            entry["centroid"] = [
                round(float(coordinates[:, 1].mean()) / width, 6),
                round(float(coordinates[:, 0].mean()) / height, 6),
            ]
            entry["inFrame"] = bool(
                columns[0] > 0 and rows[0] > 0 and columns[-1] < width - 1 and rows[-1] < height - 1
            )

    entry["visibleFraction"] = round(min(1.0, agrees), 6)
    entry["occludedFraction"] = round(max(0.0, 1.0 - min(1.0, agrees)), 6)
    return entry


def _visibility(scene, target, mask, tracked, index):
    """How much of the target's silhouette is actually VISIBLE in the frame, and the ratio.

    WHY A RAY CAST AND NOT A MASK COMPARISON
    ----------------------------------------
    The first two attempts compared the subject's isolation mask against another
    render. Both were wrong, and the second one was wrong in an instructive way:

    * "everything except the subject" made the floor — a plane covering the entire
      frame and lying under everything — occupy every subject pixel, so every subject
      measured 100% occluded. A backdrop is not an occluder.
    * "the other tracked actors" only fixed that because the floor happened not to be
      tracked. A coffee table tracked alongside a sofa measures as occluded by the
      sofa whenever their screen rectangles overlap, even though the table is in
      front. Screen overlap is not occlusion, and no amount of choosing the right
      object set fixes a comparison that ignores distance.

    A ray from the camera through one pixel answers the actual question: what is the
    nearest thing along this line of sight? If the subject is nearest, that pixel
    shows the subject; if a tracked actor is nearer, it is occluded. That is the
    definition, it costs no render, and it is exactly reproducible.

    Rays are cast on a stride grid inside the silhouette and scaled back up. The
    stride is chosen so the total cast count stays bounded regardless of subject size,
    because this runs once per tracked object per view and a full-resolution cast over
    a subject filling a third of a 640x360 frame would be tens of thousands of BVH
    queries in Python.

    @returns {[number, number]} visible pixel count and the visible fraction.
    """
    silhouette = int(np.count_nonzero(mask))
    if silhouette == 0:
        return 0, 1.0

    actors = [
        candidate for candidate in (_tracked_objects(target, tracked, index))
        if candidate is not target and not candidate.hide_render
    ]
    if not actors:
        return silhouette, 1.0

    sample = _visible_samples(scene, target, mask, actors)
    if sample is None:
        # No camera or no usable grid: report full visibility. That is the optimistic
        # direction and it is deliberate — an unavailable comparison must not
        # manufacture an occlusion finding that the loop would then "fix".
        return silhouette, 1.0

    sampled, visible = sample
    if sampled == 0:
        return silhouette, 1.0
    fraction = float(visible) / float(sampled)
    return int(round(fraction * silhouette)), fraction


def _tracked_objects(target, tracked, index):
    """The tracked objects, by object, never by name."""
    wanted = set(tracked)
    wanted.add(target.get("deepblend_id"))
    found = []
    for object_id, obj in index.items():
        if object_id in wanted:
            found.append(obj)
    return found


def _visible_samples(scene, target, mask, actors):
    """Cast one ray per sampled silhouette pixel and count how many hit the target.

    @returns {[number, number]|null} (sampled, visible) or null when there is no
      usable camera or the silhouette is empty.
    """
    camera = scene.camera
    if camera is None or camera.type != "CAMERA":
        return None

    rows, columns = np.nonzero(mask)
    total = int(rows.size)
    if total == 0:
        return None

    # Bound the number of Python-side BVH queries. Small subjects are exact; large
    # ones are sampled on a grid, which is a fine trade for a fraction whose
    # thresholds are 15 percentage points apart.
    stride = 1 if total <= MAX_RAY_CASTS else int(np.ceil(np.sqrt(total / float(MAX_RAY_CASTS))))

    height, width = mask.shape
    depsgraph = bpy.context.evaluated_depsgraph_get()
    origin = camera.matrix_world.translation.copy()
    frame = camera.data.view_frame(scene=scene)
    # `view_frame` returns the frame corners in camera space, ordered
    # (top-right, bottom-right, bottom-left, top-left). Linear interpolation between
    # opposite corners is exact under perspective projection because the projection is
    # linear in normalized device coordinates.
    top_right, bottom_right, bottom_left, top_left = frame

    sampled = 0
    visible = 0
    for index in range(0, total, stride):
        row = int(rows[index])
        column = int(columns[index])
        u = (column + 0.5) / float(width)
        v = (row + 0.5) / float(height)
        # Screen rows run downward; the camera frame's vertical axis runs upward.
        local = _bilinear(top_left, bottom_left, bottom_right, top_right, u, 1.0 - v)
        direction = (camera.matrix_world @ local) - origin
        if direction.length < 1e-9:
            continue
        sampled += 1
        # Blender 5.x returns SIX values here (hit, location, normal, face index,
        # object, matrix); 4.x returned five. Unpacking with a length check keeps both
        # working, and the hit object is the only field this measurement uses.
        cast = scene.ray_cast(depsgraph, origin, direction.normalized(), distance=direction.length * 1.5)
        hit = bool(cast[0])
        hit_object = cast[4] if len(cast) >= 6 else cast[3]
        if hit and hit_object is target:
            visible += 1
        elif not hit:
            # Nothing along the line of sight: the pixel is background, which for a
            # silhouette pixel cannot happen unless the mask and the geometry disagree
            # (a moving object, a modifier). Counting it as visible keeps the reading
            # optimistic rather than inventing an occluder from a mismatch.
            visible += 1

    return sampled, visible


def _bilinear(top_left, bottom_left, bottom_right, top_right, u, v):
    """Interpolate a point inside the camera's view frame, corner order given."""
    top = top_left.lerp(top_right, u)
    bottom = bottom_left.lerp(bottom_right, u)
    return top.lerp(bottom, v)


def _object_index(scene):
    """Map every object's ``deepblend_id`` to the OBJECT, not just its name."""
    mapping = {}
    for obj in scene.objects:
        object_id = obj.get("deepblend_id")
        if object_id:
            mapping[str(object_id)] = obj
    return mapping


def _isolation_mask(scene, target, scratch):
    """Render ``target`` alone and return its silhouette as a boolean array."""
    values = _isolation_render_of(scene, [target], scratch, "solo")
    if values is None:
        return None
    return values > MASK_THRESHOLD


def _isolation_render_of(scene, targets, scratch_dir, label):
    """Render exactly ``targets`` as a flat white silhouette, and read it back.

    Returns a float silhouette array, or ``None`` when the render could not be read
    back. Every object that is ALREADY hidden by the scene stays hidden, and every
    other object is hidden for the duration and restored afterwards — so a hidden
    object can never be reported as an occluder.

    Workbench renders a flat unlit silhouette, which is exactly the mask needed and
    far cheaper than re-running Cycles for it. Three settings make it exact rather
    than approximate: a transparent film (so the alpha channel carries the silhouette
    even for a white object against a white background), the ``Standard`` view
    transform (so a fully lit surface is not re-graded), and flat single-colour
    shading with anti-aliasing off (so every pixel is decisively in or out).

    The mask goes through a scratch PNG rather than the in-memory ``Render Result``.
    M1 already learned that Blender's render result is not readable under
    ``--background`` (it reports size 0 and ``has_data=False``); a file that was
    actually written is both readable and the thing being described.
    """
    wanted = set(id(obj) for obj in targets)
    if not wanted:
        return None

    hidden = []
    previous = {
        "engine": scene.render.engine,
        "view_transform": scene.view_settings.view_transform,
        "film_transparent": scene.render.film_transparent,
        "use_nodes": scene.use_nodes,
        "filepath": scene.render.filepath,
        "color_mode": scene.render.image_settings.color_mode,
    }
    scratch = os.path.join(scratch_dir, "mask-%s.png" % (label,))

    for obj in scene.objects:
        if obj.type in ("CAMERA", "LIGHT", "EMPTY"):
            continue
        if id(obj) not in wanted and not obj.hide_render:
            obj.hide_render = True
            hidden.append(obj)

    try:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.light = "FLAT"
        scene.display.shading.color_type = "SINGLE"
        scene.display.shading.single_color = (1.0, 1.0, 1.0)
        scene.display.shading.show_specular_highlight = False
        scene.display.shading.show_shadows = False
        scene.display.shading.show_cavity = False
        scene.display.render_aa = "OFF"
        scene.render.film_transparent = True
        scene.render.image_settings.color_mode = "RGBA"
        scene.view_settings.view_transform = "Standard"
        scene.use_nodes = False
        scene.render.filepath = scratch

        os.makedirs(os.path.dirname(scratch), exist_ok=True)
        try:
            bpy.ops.render.render(write_still=True)
        except Exception as exc:
            raise ActionError(
                "BLENDER_ENGINE_UNAVAILABLE",
                "the isolation render failed: %s" % (error_text(exc),),
            )

        return _load_mask(scratch)
    finally:
        for obj in hidden:
            obj.hide_render = False
        scene.render.engine = previous["engine"]
        scene.view_settings.view_transform = previous["view_transform"]
        scene.render.film_transparent = previous["film_transparent"]
        scene.use_nodes = previous["use_nodes"]
        scene.render.filepath = previous["filepath"]
        scene.render.image_settings.color_mode = previous["color_mode"]
        try:
            if os.path.isfile(scratch):
                os.unlink(scratch)
        except Exception:
            pass



def _load_mask(path):
    """Read a silhouette mask PNG as a 0.0/1.0 float array in image order."""
    image = None
    try:
        image = bpy.data.images.load(path, check_existing=False)
        width, height = image.size
        if width == 0 or height == 0:
            return None
        buffer = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(buffer)
        rgba = buffer.reshape(height, width, 4)
        # Alpha is the silhouette when the film is transparent. The RGB fallback
        # covers a build that composites the film onto black instead.
        alpha = rgba[:, :, 3]
        if float(alpha.max()) > MASK_THRESHOLD:
            silhouette = alpha > MASK_THRESHOLD
        else:
            silhouette = rgba[:, :, :3].max(axis=2) > MASK_THRESHOLD
        values = np.zeros_like(alpha)
        values[silhouette] = 1.0
        return np.ascontiguousarray(np.flipud(values))
    except Exception:
        return None
    finally:
        if image is not None:
            try:
                bpy.data.images.remove(image)
            except Exception:
                pass


def _load_rgb(path):
    """Load a rendered PNG as a float RGB array in row-major image order."""
    image = None
    try:
        image = bpy.data.images.load(path, check_existing=False)
        width, height = image.size
        if width == 0 or height == 0:
            return None
        buffer = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(buffer)
        rgba = buffer.reshape(height, width, 4)
        # Blender stores images bottom-up; the measurements below do not care, but
        # the bbox and centroid do, so flip once here and let every consumer work
        # in ordinary top-down image coordinates.
        return np.ascontiguousarray(np.flipud(rgba[:, :, :3]))
    except Exception:
        return None
    finally:
        if image is not None:
            try:
                bpy.data.images.remove(image)
            except Exception:
                pass


def _render_config(scene):
    """The render settings in force for this plan, for the manifest."""
    samples = None
    try:
        if scene.render.engine == "CYCLES":
            samples = int(scene.cycles.samples)
    except Exception:
        samples = None
    return {
        "engine": scene.render.engine,
        "resolution": [int(scene.render.resolution_x), int(scene.render.resolution_y)],
        "samples": samples,
        "viewTransform": scene.view_settings.view_transform,
        "frameStart": int(scene.frame_start),
        "frameEnd": int(scene.frame_end),
        "fps": int(scene.render.fps),
        "checkpointProfile": checkpoint_profile(scene),
    }


def _remove_tree(path):
    """Delete a scratch directory tree, ignoring anything that resists."""
    import shutil

    try:
        shutil.rmtree(path, ignore_errors=True)
    except Exception:
        pass
