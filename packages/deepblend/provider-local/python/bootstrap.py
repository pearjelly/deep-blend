#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend Blender bootstrap -- the batch action dispatcher.

CONTRACT
--------
Executed by the Blender binary itself, headlessly, as::

    Blender --background --factory-startup --python bootstrap.py -- \\
        --request <path/to/request.json> --result <path/to/result.json> \\
        [--scene-spec <spec.json>] [--blend <in.blend>] [--output-blend <out.blend>] \\
        [--output <image.png>]

``--factory-startup`` guarantees a pristine configuration, so a compiled scene
describes the SceneSpec rather than whatever state a user left behind.
``--background`` means no UI and no window.

The result is communicated **only** by writing one JSON document to ``--result``.
Nothing is ever printed to stdout as a result channel: Blender writes its own
unstructured banners and add-on chatter there, and a caller that scrapes stdout
is parsing around noise. Progress lines ARE emitted on stdout as one JSON object
per line (``{"type":"progress",...}``) because SPEC §9.3 asks for JSONL progress;
they are advisory and never authoritative.

The result file is written **atomically** and on *every* exit path — success,
protocol failure, bad arguments, a refused action, and an unexpected internal
exception. A caller may therefore always expect a parseable envelope, and must
still check the exit code, which is non-zero whenever ``status != "success"``.

ACTIONS (M3)
------------
``render_frames``     an explicit LIST of frames of one camera out of one checkpoint,
                      at a named SceneSpec render profile, into a persistent
                      directory. Long-running and resumable: the host passes only
                      the frames the frame ledger says are missing.

ACTIONS (M2)
------------
``render_preview``    one frame from one camera out of a checkpoint ``.blend``.
``render_views``      a PLAN of (camera, frame) views out of one checkpoint, in one
                      process, each carrying its deterministic measurements.

ACTIONS (M0)
------------
``get_capabilities``  behavioral capability probe (M0; moved to its own module).
``compile_scene``     SceneSpec -> real Blender scene -> ``.blend`` checkpoint,
                      with technical validation of the result.

WHY ONE DISPATCHER AND NOT THREE SCRIPTS
----------------------------------------
Blender's startup cost dominates every one of these actions, and the three share
the same argument parsing, error classification and result-writing rules. Three
scripts would mean three copies of the contract, and the copy that drifts is
always the error path — which is the one nobody exercises until it matters.

SECURITY BOUNDARY
-----------------
This file is a trust boundary between the Node.js host process and an embedded
CPython interpreter with full Blender API access. It reads only the paths it is
given, launches no other process, touches no network, and writes only to the
paths the caller supplied. It never evaluates caller-supplied Python: the
``request.json`` document names an ACTION, and every action's behaviour is fixed
in this repository. The SceneSpec is data, and the compiler treats it as data —
there is no path by which a spec value becomes code.

Standard library plus ``bpy``/``addon_utils`` (both shipped inside Blender) only.
"""

import json
import os
import sys
import time
import traceback

# --------------------------------------------------------------------------------------
# Make the sibling modules importable
# --------------------------------------------------------------------------------------
# Blender executes this file by path, so its own directory is not automatically on
# sys.path. Adding it explicitly is what lets the runtime be split across modules
# instead of one file that has to be read top to bottom.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from deepblend_util import (  # noqa: E402  (path set up above)
    PROTOCOL_VERSION,
    ActionError,
    eprint,
    error_text,
    parse_args,
    read_json,
    report_progress,
    write_json_atomic,
)

#: Actions this dispatcher accepts. Anything else is refused with a stable code
#: rather than silently doing nothing — a silently no-op action is indistinguishable
#: from a successful one that produced no output.
SUPPORTED_ACTIONS = (
    "get_capabilities",
    "compile_scene",
    "render_preview",
    "render_views",
    "render_frames",
)

# Process exit codes. 0 is reserved for a successfully written success envelope.
EXIT_OK = 0
EXIT_BAD_ARGS = 2
EXIT_REQUEST_UNREADABLE = 3
EXIT_REQUEST_INVALID = 4
EXIT_PROTOCOL_MISMATCH = 5
EXIT_UNSUPPORTED_ACTION = 6
EXIT_ACTION_FAILED = 7

#: Action failure code -> process exit code, so a caller shelling out can branch
#: without parsing the envelope.
EXIT_CODE_BY_ERROR = {
    "BLENDER_UNSUPPORTED_ACTION": EXIT_UNSUPPORTED_ACTION,
}


# --------------------------------------------------------------------------------------
# Envelope
# --------------------------------------------------------------------------------------


def build_envelope(job_id, action, result, error, warnings, notices):
    """Assemble the result document written to the caller's ``--result`` path.

    ``capabilities`` keeps its M0 name and meaning for ``get_capabilities`` so the
    existing provider code and tests keep working unchanged; new actions carry
    their payload under ``result``.
    """
    envelope = {
        "protocolVersion": PROTOCOL_VERSION,
        "jobId": job_id,
        "action": action,
    }

    if error is not None:
        envelope["status"] = "error"
        envelope["error"] = {
            "code": error.get("code", "BLENDER_SCRIPT_ERROR"),
            "message": error.get("message", "unspecified failure"),
        }
        if error.get("detail") is not None:
            envelope["error"]["detail"] = error["detail"]
        envelope["capabilities"] = None
        envelope["result"] = None
        envelope["warnings"] = list(warnings)
        envelope["notices"] = list(notices)
        return envelope

    envelope["status"] = "success"
    envelope["error"] = None
    # `capabilities` is non-null ONLY for the action that produces it. A stub
    # empty report here would be worse than null: it would look like a probe that
    # found nothing.
    capabilities = result.get("capabilities") if isinstance(result, dict) else None
    envelope["capabilities"] = capabilities
    envelope["result"] = None if capabilities is not None else result
    envelope["warnings"] = list(warnings)
    envelope["notices"] = list(notices)
    return envelope


# --------------------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------------------


def action_get_capabilities(request, options):
    """Behavioral capability probe (M0)."""
    from deepblend_capabilities import collect_capabilities

    report_progress("probe", 5)
    capabilities, warnings = collect_capabilities()
    report_progress("probe_done", 95)
    return {"capabilities": capabilities}, warnings, []


def action_compile_scene(request, options):
    """Compile a SceneSpec into a Blender scene and save a checkpoint."""
    from deepblend_scene import build_scene, describe_objects
    from deepblend_util import Guard
    from deepblend_validate import validate_scene
    import bpy

    spec_path = options.get("scene_spec")
    output_blend = options.get("output_blend")
    if not spec_path:
        raise ActionError("BLENDER_SCRIPT_ERROR", "compile_scene requires --scene-spec <path>")
    if not output_blend:
        raise ActionError("BLENDER_SCRIPT_ERROR", "compile_scene requires --output-blend <path>")

    if not os.path.isfile(spec_path):
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'the SceneSpec document does not exist at "%s"' % (spec_path,),
            {"sceneSpec": spec_path},
        )
    try:
        spec = read_json(spec_path)
    except Exception as exc:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'could not read the SceneSpec at "%s": %s' % (spec_path, error_text(exc)),
            {"sceneSpec": spec_path},
        )

    guard = Guard()
    build_options = {
        "profile": options.get("profile"),
        "project_root": options.get("project_root"),
    }
    report = build_scene(spec, build_options, guard)

    report_progress("validate", 92)
    validation = validate_scene(bpy.context.scene, spec, guard)

    payload = {
        "sceneSpec": spec_path,
        "objects": describe_objects(),
        "actions": report["actions"],
        "renderConfig": report["renderConfig"],
        "engine": report["engine"],
        "requestedEngine": report["requestedEngine"],
        "profileName": report["profileName"],
        "validation": validation,
        "sceneFingerprint": scene_fingerprint(spec, describe_objects()),
    }

    # The checkpoint is written even when validation reported errors: the caller
    # decides whether to publish, and a diagnostic blend is far more useful than
    # no blend at all when a compile went wrong. Nothing is published by THIS
    # process either way — publication is the host's atomic rename.
    if validation["ok"] or options.get("save_on_failure") == "true":
        report_progress("save_checkpoint", 96)
        write_checkpoint(output_blend)
        payload["outputBlend"] = output_blend
        payload["outputBytes"] = os.path.getsize(output_blend)
    else:
        payload["outputBlend"] = None
        payload["checkpointSkipped"] = "validation reported errors"
        guard.note(
            "SCENE_VALIDATION_FAILED",
            "checkpoint not written because technical validation reported %d error(s)"
            % (len(validation["errors"]),),
        )

    if not validation["ok"]:
        raise ActionError(
            "SCENE_VALIDATION_FAILED",
            "the compiled scene failed technical validation: %s"
            % ("; ".join(entry["message"] for entry in validation["errors"][:3]),),
            {"validation": validation},
        )

    return payload, guard.warnings, guard.notices


def action_render_preview(request, options):
    """Render one preview frame out of a checkpoint ``.blend``."""
    from deepblend_render import render_preview
    from deepblend_util import Guard

    checkpoint = options.get("blend")
    output = options.get("output")
    if not checkpoint:
        raise ActionError("REVISION_CHECKPOINT_MISSING", "render_preview requires --blend <checkpoint.blend>")
    if not output:
        raise ActionError("BLENDER_SCRIPT_ERROR", "render_preview requires --output <image.png>")

    guard = Guard()
    overrides = {
        "engine": options.get("engine"),
        "width": _as_int(options.get("width")),
        "height": _as_int(options.get("height")),
        "samples": _as_int(options.get("samples")),
        "frame": _as_int(options.get("frame")),
    }
    payload = render_preview(
        options=overrides,
        guard=guard,
        checkpoint=checkpoint,
        output=output,
        camera_id=options.get("camera"),
    )
    return payload, guard.warnings, guard.notices


def action_render_views(request, options):
    """Render a plan of views out of one checkpoint, measuring each one.

    The plan travels as a FILE rather than as many ``--flag`` pairs because a plan
    is a list of records, and a list of records is the one shape a flat argument
    list expresses badly: an N-view plan would need N parallel arrays that can
    disagree in length. As a document it is validated once, at the top, and a
    malformed plan is one error rather than a partially-rendered result.
    """
    from deepblend_util import Guard
    from deepblend_views import render_views

    plan_path = options.get("views")
    if not plan_path:
        raise ActionError("BLENDER_SCRIPT_ERROR", "render_views requires --views <plan.json>")
    if not os.path.isfile(plan_path):
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'the view plan does not exist at "%s"' % (plan_path,),
            {"views": plan_path},
        )
    try:
        plan = read_json(plan_path)
    except Exception as exc:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'could not read the view plan at "%s": %s' % (plan_path, error_text(exc)),
            {"views": plan_path},
        )

    guard = Guard()
    payload = render_views({"views": plan}, guard)
    return payload, guard.warnings, guard.notices


def action_render_frames(request, options):
    """Render an explicit frame list at a named render profile (M3).

    The plan travels as a FILE for the same reason the view plan does, and the
    event journal is a SECOND file because of a fact about the runtime that only
    shows up after a crash: the host's subprocess collector is an in-memory buffer
    inside the host process, so every progress line this process printed is gone
    the moment the host dies. The journal is flushed and fsynced per line so the
    frames that landed before a kill -9 are still knowable.
    """
    from deepblend_frames import render_frames
    from deepblend_util import Guard

    plan_path = options.get("frames")
    if not plan_path:
        raise ActionError("BLENDER_SCRIPT_ERROR", "render_frames requires --frames <plan.json>")
    if not os.path.isfile(plan_path):
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'the frame plan does not exist at "%s"' % (plan_path,),
            {"frames": plan_path},
        )
    try:
        plan = read_json(plan_path)
    except Exception as exc:
        raise ActionError(
            "BLENDER_SCRIPT_ERROR",
            'could not read the frame plan at "%s": %s' % (plan_path, error_text(exc)),
            {"frames": plan_path},
        )
    if not isinstance(plan, dict):
        raise ActionError("BLENDER_SCRIPT_ERROR", "the frame plan must be a JSON object")
    # The journal path is a bootstrap argument, not a plan field: it identifies
    # where THIS invocation reports, and a plan is a durable document that a
    # resumed attempt rewrites with a new one.
    plan["events"] = options.get("events") or plan.get("events")

    guard = Guard()
    payload = render_frames(plan, guard)
    return payload, guard.warnings, guard.notices


def write_process_identity(path, job_id, action, attempt_token=None):
    """Record this process's own pid, atomically, before any Blender work.

    WHY A FILE AND WHY FROM THE CHILD
    ---------------------------------
    `ctx.subprocess.spawn` returns a handle of `{stdin, stdout, stderr, collected,
    done, terminate, waitForExit}` — measured against the installed runtime, it
    exposes no pid. So the only way the HOST can learn which process is rendering
    is for the process to say so, and the only way that fact survives a crash of
    the host is for it to be on disk.

    It is written first, before bpy is touched, so a render killed during scene
    load is still attributable to a pid. On macOS the deepest subprocess
    containment available is a process GROUP (`detached: true` makes the child its
    own group leader, so pgid == pid), which is why the recovery path signals
    `-pid` rather than `pid`: an orphaned Blender may have children of its own.
    """
    if not path:
        return
    try:
        write_json_atomic(path, {
            "schemaVersion": "deepblend.process/v1",
            "jobId": job_id,
            "action": action,
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "processGroupId": os.getpgid(0),
            "startedAt": time.time(),
            "attemptToken": attempt_token,
        })
    except Exception as exc:  # noqa: BLE001
        eprint("could not write the process identity document: %s" % (error_text(exc),))


def _attempt_token_from_plan(action, options):
    """The attempt token, when the action's input document carries one.

    Only `render_frames` has a plan file; every other action answers None, and the
    identity document simply records no token. Read here rather than threaded
    through every action because the token belongs to the PROCESS, not to the work.
    """
    if action != "render_frames":
        return None
    plan_path = options.get("frames")
    if not plan_path or not os.path.isfile(plan_path):
        return None
    try:
        return read_json(plan_path).get("attemptToken")
    except Exception:
        return None


def _as_int(value):
    """Parse an optional integer argument, or return ``None``."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ActionError("BLENDER_SCRIPT_ERROR", '"%s" is not an integer' % (value,))


# The options a REQUEST may carry, which is the batch path's own list: a session request that names a
# flag the batch path knows must work, and one it does not must fail the same way.
KNOWN_SESSION_OPTIONS = (
    "--request", "--result", "--scene-spec", "--blend", "--output-blend",
    "--output", "--camera", "--engine", "--width", "--height", "--samples",
    "--frame", "--profile", "--project-root", "--save-on-failure", "--views",
    "--frames", "--events", "--proc",
)

ACTIONS = {
    "get_capabilities": action_get_capabilities,
    "compile_scene": action_compile_scene,
    "render_preview": action_render_preview,
    "render_views": action_render_views,
    "render_frames": action_render_frames,
}


def write_checkpoint(path):
    """Save the current file as the compiled checkpoint.

    ``compress=False`` trades size for speed, which is the right way round for a
    checkpoint that is about to be re-opened by the renderer in the next process.
    The ``.blend1`` backup is suppressed because a checkpoint is an immutable
    published artifact: a stray previous version beside it would make "the
    checkpoint" ambiguous.
    """
    import bpy

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:
        pass
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=False, copy=False)
    # `save_as_mainfile` can still emit a backup when the preference is read-only;
    # removing it is cheaper than trusting the preference to have taken effect.
    backup = path + "1"
    if os.path.isfile(backup):
        try:
            os.unlink(backup)
        except Exception:
            pass


def scene_fingerprint(spec, objects):
    """A cheap structural fingerprint of the compiled scene.

    Used by the revision manifest so a recompile that produced a structurally
    different scene is visible even when the SceneSpec digest is unchanged, which
    is exactly the case a compiler regression would show up in.
    """
    counts = {"MESH": 0, "LIGHT": 0, "CAMERA": 0, "EMPTY": 0}
    vertices = 0
    polygons = 0
    for obj in objects:
        counts[obj["type"]] = counts.get(obj["type"], 0) + 1
        vertices += obj.get("vertexCount", 0) or 0
        polygons += obj.get("polygonCount", 0) or 0
    return {
        "specSchemaVersion": spec.get("schemaVersion"),
        "objectCounts": counts,
        "totalVertices": vertices,
        "totalPolygons": polygons,
    }


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Session mode (SPEC §20 M6 "Blender Live Bridge")
#
# WHY THIS EXISTS. Every operation in this product is one process: `blender --background
# --factory-startup --python bootstrap.py -- --request … --result …`, which loads the scene,
# does the thing, and exits. That is the right shape for a render and the wrong one for a
# CONVERSATION: opening a scene costs seconds, and a caller that compiles, then previews, then
# compiles again pays it every time.
#
# Session mode is the same dispatch with the process kept open: one JSON request per line on
# stdin, one JSON envelope per line on stdout, until EOF or an explicit shutdown. Nothing about
# an individual action changes — `ACTIONS`, the protocol check and the envelope are the same
# ones the batch path uses, because a second implementation of "what does compile_scene do"
# would be a second answer to that question.
#
# WHAT IT IS NOT (yet). This is the TRANSPORT half of the M6 item, not the whole item: the
# GUI attach — the user's own Blender, with the add-on, so they can watch it work — is the
# next item on that list. What this proves is the part everything else rests on: one Blender,
# many operations, each one attributable to a pid and each one able to fail on its own.
# ---------------------------------------------------------------------------


def _session_line(payload):
    """One compact JSON line, flushed, because the caller is waiting on it."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _session_dispatch(request, options):
    """The batch dispatch, applied to one line of a session.

    Deliberately the same checks in the same order as `main()`: a session request that names an
    unknown action must fail exactly as a batch request would, or the two paths would disagree
    about the protocol and only one of them would be tested.
    """
    if not isinstance(request, dict):
        return build_envelope(None, None, None, {
            "code": "BLENDER_SCRIPT_ERROR",
            "message": "the request document must be a JSON object",
        }, [], [])

    job_id = request.get("jobId")
    action = request.get("action")

    if request.get("protocolVersion") != PROTOCOL_VERSION:
        return build_envelope(job_id, action, None, {
            "code": "BLENDER_PROTOCOL_VERSION_MISMATCH",
            "message": 'request declares protocolVersion "%s", expected "%s"'
            % (request.get("protocolVersion"), PROTOCOL_VERSION),
        }, [], [])

    handler = ACTIONS.get(action)
    if handler is None:
        return build_envelope(job_id, action, None, {
            "code": "BLENDER_UNSUPPORTED_ACTION",
            "message": 'bootstrap.py does not implement action "%s"; supported actions are %s'
            % (action, ", ".join(SUPPORTED_ACTIONS)),
            "detail": {"action": action, "supported": list(SUPPORTED_ACTIONS)},
        }, [], [])

    # PER-REQUEST ARGUMENTS, merged over the process's own.
    #
    # MEASURED, and it made sessions useless for the actions that matter: `compile_scene` needs
    # `--scene-spec`, `render_preview` needs `--output`, and the batch path passes those as extra
    # argv — but a session's argv is fixed when the process starts, so the first attempt at reusing a
    # process dropped every one of them and every real action failed with "requires --scene-spec".
    #
    # The fix is not to restart the process with new flags (that is the batch path) but to let a
    # request carry its own, parsed by the SAME parser the process used: one parser, so a flag that
    # works in batch mode works here, including the failure for an unknown one.
    options = options
    if isinstance(request.get("args"), list):
        extra, unknown = parse_args(["--"] + [str(token) for token in request["args"]], KNOWN_SESSION_OPTIONS)
        if unknown:
            return build_envelope(job_id, action, None, {
                "code": "BLENDER_SCRIPT_ERROR",
                "message": "unrecognised arguments: %s" % (", ".join(unknown),),
            }, [], [])
        options = dict(options)
        options.update(extra)

    eprint("session action=%s job=%s" % (action, job_id))
    # Same claim as the batch path: every request is attributable to this pid, so a session that
    # dies mid-action leaves the same evidence an interrupted render does.
    write_process_identity(
        options.get("proc"),
        job_id,
        action,
        attempt_token=_attempt_token_from_plan(action, options),
    )
    try:
        payload, warnings, notices = handler(request, options)
        return build_envelope(job_id, action, payload, None, warnings, notices)
    except Exception as exc:
        return build_envelope(job_id, action, None, {
            "code": getattr(exc, "code", "BLENDER_SCRIPT_ERROR"),
            "message": error_text(exc),
        }, [], [])


def run_session(options):
    """Serve requests until stdin ends or a caller asks to stop.

    EXIT CODE IS ABOUT THE SESSION, NOT THE ACTIONS: an action that fails is reported in its own
    envelope and the session carries on, because a caller that wanted the process to stop would
    have closed the pipe. Only the session's own health can end it non-zero.
    """
    _session_line({"kind": "ready", "protocolVersion": PROTOCOL_VERSION, "pid": os.getpid()})
    for line in sys.stdin:
        text = line.strip()
        if text == "":
            continue
        try:
            request = json.loads(text)
        except Exception as exc:
            _session_line(build_envelope(None, None, None, {
                "code": "BLENDER_SCRIPT_ERROR",
                "message": "the request line is not valid JSON: %s" % (error_text(exc),),
            }, [], []))
            continue
        if isinstance(request, dict) and request.get("action") == "shutdown":
            _session_line({"kind": "bye", "pid": os.getpid()})
            return 0
        envelope = _session_dispatch(request, options)
        envelope["kind"] = "result"
        _session_line(envelope)
    return 0


def main():
    argv = sys.argv
    options, unknown = parse_args(
        argv,
        (
            "--request", "--result", "--scene-spec", "--blend", "--output-blend",
            "--output", "--camera", "--engine", "--width", "--height", "--samples",
            "--frame", "--profile", "--project-root", "--save-on-failure", "--views",
            "--frames", "--events", "--proc", "--session",
        ),
    )

    # SESSION MODE FIRST: it shares every check below, so it must not fall through to the batch
    # path's `--result` requirement (a session has no result file; its answers go to stdout).
    if options.get("session") is not None:
        return run_session(options)

    request_path = options.get("request")
    result_path = options.get("result")
    if result_path is None:
        eprint("no --result path was supplied; nothing to write")
        return EXIT_BAD_ARGS

    job_id = None
    action = None

    def finish(envelope, exit_code):
        try:
            write_json_atomic(result_path, envelope)
        except Exception as exc:
            eprint("could not write the result document: %s" % (error_text(exc),))
            return EXIT_BAD_ARGS
        return exit_code

    if request_path is None:
        envelope = build_envelope(
            None, None, None,
            {"code": "BLENDER_SCRIPT_ERROR", "message": "no --request path was supplied"},
            [], [],
        )
        return finish(envelope, EXIT_BAD_ARGS)

    if unknown:
        envelope = build_envelope(
            None, None, None,
            {"code": "BLENDER_SCRIPT_ERROR", "message": "unrecognised arguments: %s" % (", ".join(unknown),)},
            [], [],
        )
        return finish(envelope, EXIT_BAD_ARGS)

    try:
        request = read_json(request_path)
    except Exception as exc:
        envelope = build_envelope(
            None, None, None,
            {"code": "BLENDER_SCRIPT_ERROR", "message": 'could not read the request at "%s": %s' % (request_path, error_text(exc))},
            [], [],
        )
        return finish(envelope, EXIT_REQUEST_UNREADABLE)

    if not isinstance(request, dict):
        envelope = build_envelope(
            None, None, None,
            {"code": "BLENDER_SCRIPT_ERROR", "message": "the request document must be a JSON object"},
            [], [],
        )
        return finish(envelope, EXIT_REQUEST_INVALID)

    job_id = request.get("jobId")
    action = request.get("action")

    if request.get("protocolVersion") != PROTOCOL_VERSION:
        envelope = build_envelope(
            job_id, action, None,
            {
                "code": "BLENDER_PROTOCOL_VERSION_MISMATCH",
                "message": 'request declares protocolVersion "%s", expected "%s"'
                % (request.get("protocolVersion"), PROTOCOL_VERSION),
            },
            [], [],
        )
        return finish(envelope, EXIT_PROTOCOL_MISMATCH)

    handler = ACTIONS.get(action)
    if handler is None:
        envelope = build_envelope(
            job_id, action, None,
            {
                "code": "BLENDER_UNSUPPORTED_ACTION",
                "message": 'bootstrap.py does not implement action "%s"; supported actions are %s'
                % (action, ", ".join(SUPPORTED_ACTIONS)),
                "detail": {"action": action, "supported": list(SUPPORTED_ACTIONS)},
            },
            [], [],
        )
        return finish(envelope, EXIT_UNSUPPORTED_ACTION)

    eprint("action=%s job=%s" % (action, job_id))
    # Claim this process on disk BEFORE the action runs. A render killed during
    # scene load must still be attributable to a pid, because the recovery path's
    # only way to stop an orphan is the pid this line recorded (see the docstring
    # on `write_process_identity`).
    write_process_identity(
        options.get("proc"),
        job_id,
        action,
        attempt_token=_attempt_token_from_plan(action, options),
    )
    try:
        payload, warnings, notices = handler(request, options)
        envelope = build_envelope(job_id, action, payload, None, warnings, notices)
        return finish(envelope, EXIT_OK)
    except ActionError as exc:
        envelope = build_envelope(
            job_id, action, None,
            {"code": exc.code, "message": exc.message, "detail": exc.detail},
            [], [],
        )
        return finish(envelope, EXIT_CODE_BY_ERROR.get(exc.code, EXIT_ACTION_FAILED))
    except Exception as exc:  # noqa: BLE001 - the boundary must catch everything
        trace = traceback.format_exc()
        eprint(trace)
        envelope = build_envelope(
            job_id, action, None,
            {
                "code": "BLENDER_SCRIPT_ERROR",
                "message": error_text(exc),
                "detail": {"traceback": trace},
            },
            [], [],
        )
        return finish(envelope, EXIT_ACTION_FAILED)


if __name__ == "__main__":
    sys.exit(main())
