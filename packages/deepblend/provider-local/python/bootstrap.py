#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepBlend Blender Local Provider -- headless capability probe (bootstrap script).

CONTRACT
--------
This script is executed by the Blender binary itself, headlessly, as::

    Blender --background --factory-startup --python bootstrap.py -- \
        --request <path/to/request.json> --result <path/to/result.json>

``--factory-startup`` guarantees the probe sees a pristine Blender configuration, so the
capability report describes the *binary*, not whatever state a user happened to leave
behind. ``--background`` means there is no UI, no window and no GPU display context; anything
reported here must work in that mode.

The result is communicated **only** by writing a single JSON document to the ``--result``
path. Nothing is ever printed to stdout as a result channel, because Blender writes its own
unstructured noise to stdout and the Node.js caller must not have to parse around it. Short
diagnostics may go to stderr prefixed with ``[deepblend]``, but they are informational only
and are never the contract.

The result file is written **atomically** (``<result>.tmp`` + ``os.replace``) and is written
on *every* exit path: success, protocol failure, bad request, and unexpected internal
exception. A caller may therefore always expect a parseable envelope, though it must still
check the process exit code, which is non-zero whenever ``status != "success"``.

WHAT THIS SCRIPT MAY DO (security boundary)
-------------------------------------------
This file is a trust boundary between the Node.js host process and an embedded CPython
interpreter with full Blender API access. It deliberately limits itself to:

* reading static capability/identity metadata out of the live ``bpy`` runtime,
* *behaviorally* assigning render engine identifiers and reading them back,
* enumerating Cycles compute devices,
* writing one tiny 64x36 probe PNG inside a private ``tempfile`` directory (deleted again
  before exit), and one JSON document at the caller-supplied result path.

It never evaluates or imports user-supplied code, never loads a file from a user-supplied
path, never touches the network, and never writes outside the temp directory and the result
path it was given. It also never calls ``save_userpref()``: enabling the Cycles addon mutates
in-memory state for this process only, so no on-disk user configuration is modified.

Standard library plus ``bpy``/``addon_utils`` (both shipped inside Blender) only.
"""

import json
import os
import platform
import shutil
import sys
import tempfile
import traceback

import bpy  # noqa: F401  (only available inside Blender's embedded interpreter)
import addon_utils

# --------------------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------------------

PROTOCOL_VERSION = "deepblend.blender/v1"
SUPPORTED_ACTION = "get_capabilities"

#: Render engines we probe behaviorally. NOTE: we deliberately do NOT trust
#: ``bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items`` for availability --
#: in this Blender build that enum misleadingly reports only ``['BLENDER_EEVEE']`` while
#: Cycles demonstrably assigns and renders. The enum is reported as an informational
#: diagnostic only; availability is decided by actually assigning and reading back.
CANDIDATE_ENGINES = ["BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"]

#: Preference order for choosing the engine used by the smoke render (best first).
ENGINE_PREFERENCE = ["CYCLES", "BLENDER_EEVEE", "BLENDER_WORKBENCH"]

#: Cycles compute backends we probe. Most are compiled out on any given platform, in which
#: case assigning the enum raises rather than returning an empty device list.
CANDIDATE_GPU_BACKENDS = ["OPTIX", "METAL", "CUDA", "HIP", "ONEAPI"]

#: Probe render size -- large enough to prove the whole pipeline, small enough to be free.
PROBE_WIDTH = 64
PROBE_HEIGHT = 36

# Process exit codes. 0 is reserved for a successfully written success envelope.
EXIT_OK = 0
EXIT_BAD_ARGS = 2
EXIT_REQUEST_UNREADABLE = 3
EXIT_REQUEST_INVALID = 4
EXIT_PROTOCOL_MISMATCH = 5
EXIT_UNSUPPORTED_ACTION = 6
EXIT_PROBE_FAILED = 7


def _eprint(message):
    """Emit an informational diagnostic on stderr. Never part of the JSON contract."""
    try:
        sys.stderr.write("[deepblend] %s\n" % (message,))
        sys.stderr.flush()
    except Exception:
        # Diagnostics must never be able to break the probe.
        pass


def _as_text(value):
    """Coerce a bpy value into plain JSON-safe text.

    ``bpy.app.build_hash`` for example is ``bytes`` (``b'9e2066aef7ef'``), and blindly
    JSON-encoding that would fail. Only leaf scalars are ever passed through here.
    """
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace")
        except Exception:
            return repr(value)
    try:
        return str(value)
    except Exception:
        return None


def _error_text(exc):
    """Render an exception as a compact, JSON-safe ``"Type: message"`` string."""
    try:
        return "%s: %s" % (type(exc).__name__, exc)
    except Exception:
        return "unprintable exception"


# --------------------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------------------


def parse_args(argv):
    """Parse ``--request`` / ``--result`` from the argument list after a bare ``--``.

    Blender consumes its own arguments before the separator (``--background``,
    ``--factory-startup``, ``--python <file>``); everything after ``--`` belongs to this
    script. Both options are accepted in any order and in both ``--opt value`` and
    ``--opt=value`` spellings.

    Returns ``(request_path, result_path, unknown_tokens)``. Missing values are ``None``;
    the caller decides how to fail.
    """
    request_path = None
    result_path = None
    unknown = []

    try:
        separator = argv.index("--")
    except ValueError:
        # No separator: there is nothing we are allowed to interpret.
        return None, None, unknown

    tokens = list(argv[separator + 1:])
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1

        # Split the "--opt=value" spelling into name and inline value.
        inline_value = None
        name = token
        if token.startswith("--") and "=" in token:
            name, inline_value = token.split("=", 1)

        if name in ("--request", "--result"):
            if inline_value is not None:
                value = inline_value
            elif index < len(tokens):
                value = tokens[index]
                index += 1
            else:
                unknown.append("%s (missing value)" % (name,))
                continue
            if name == "--request":
                request_path = value
            else:
                result_path = value
        else:
            unknown.append(token)

    return request_path, result_path, unknown


# --------------------------------------------------------------------------------------
# Result envelope writing
# --------------------------------------------------------------------------------------


def build_envelope(job_id, blender, capabilities, warnings, error):
    """Build the top-level envelope. Exactly the shape the Node.js caller expects."""
    return {
        "status": "error" if error else "success",
        "protocolVersion": PROTOCOL_VERSION,
        "jobId": job_id,
        "blender": blender,
        "capabilities": capabilities,
        "warnings": list(warnings or []),
        "error": error,
    }


def write_result(result_path, envelope):
    """Atomically write the envelope to ``result_path``. Returns True on success.

    Writes ``<result>.tmp`` alongside the target and then ``os.replace``s it into place, so
    a reader can never observe a half-written document. The temporary file lives next to the
    result file (same filesystem, so the replace is atomic) and is removed on failure.
    """
    if not result_path:
        _eprint("no --result path supplied; cannot write an envelope")
        return False

    tmp_path = "%s.tmp" % (result_path,)
    try:
        parent = os.path.dirname(os.path.abspath(result_path))
        # The caller designated this path, so materialising its directory is part of
        # honouring the write contract rather than writing somewhere unasked.
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)

        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(envelope, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())

        os.replace(tmp_path, result_path)
        return True
    except Exception as exc:
        _eprint("failed to write result file %r: %s" % (result_path, _error_text(exc)))
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return False


# --------------------------------------------------------------------------------------
# Capability collectors -- every collector is independently guarded
# --------------------------------------------------------------------------------------


def collect_identity():
    """Static identity of this Blender/Python build. Pure reads, no state changes."""
    identity = {
        "blenderVersion": None,
        "blenderVersionTuple": None,
        "pythonVersion": None,
        "buildHash": None,
        "binaryPath": None,
    }

    try:
        identity["blenderVersion"] = _as_text(bpy.app.version_string)
    except Exception as exc:
        _eprint("blenderVersion unavailable: %s" % (_error_text(exc),))

    try:
        version = tuple(int(part) for part in bpy.app.version[:3])
        identity["blenderVersionTuple"] = [version[0], version[1], version[2]]
    except Exception as exc:
        _eprint("blenderVersionTuple unavailable: %s" % (_error_text(exc),))

    try:
        # platform.python_version() gives the clean "3.13.13" form.
        identity["pythonVersion"] = platform.python_version()
    except Exception:
        try:
            identity["pythonVersion"] = _as_text(sys.version.split()[0])
        except Exception as exc:
            _eprint("pythonVersion unavailable: %s" % (_error_text(exc),))

    try:
        identity["buildHash"] = _as_text(bpy.app.build_hash)
    except Exception as exc:
        _eprint("buildHash unavailable: %s" % (_error_text(exc),))

    try:
        identity["binaryPath"] = _as_text(bpy.app.binary_path)
    except Exception as exc:
        _eprint("binaryPath unavailable: %s" % (_error_text(exc),))

    return identity


def collect_host_platform():
    """Host platform facts -- useful for confirming the macOS/arm64 assumption."""
    host = {"system": None, "machine": None, "processor": None, "platform": None}
    try:
        host["system"] = platform.system()
        host["machine"] = platform.machine()
        host["processor"] = platform.processor() or None
        host["platform"] = platform.platform()
    except Exception as exc:
        _eprint("platform info unavailable: %s" % (_error_text(exc),))
    return host


def resolve_scene():
    """Return the active scene, falling back to the first datablock if necessary."""
    scene = getattr(bpy.context, "scene", None)
    if scene is not None:
        return scene
    try:
        if len(bpy.data.scenes) > 0:
            return bpy.data.scenes[0]
    except Exception:
        pass
    return None


def probe_engine_assignability(scene):
    """Behaviorally probe each candidate engine.

    For every candidate we save nothing but the *original* engine once, then for each
    candidate: assign it, read the property back, and treat "assignment took effect"
    (readback equals the requested identifier) as the definition of available. Any raised
    exception is captured per candidate. The original engine is restored at the end.

    Returns ``(results, original_engine, restored_ok)``.
    """
    results = {}
    original_engine = None
    restored_ok = False

    try:
        original_engine = _as_text(scene.render.engine)
    except Exception as exc:
        _eprint("could not read original render engine: %s" % (_error_text(exc),))

    for candidate in CANDIDATE_ENGINES:
        entry = {"assignable": False, "readback": None, "error": None}
        try:
            scene.render.engine = candidate
            readback = _as_text(scene.render.engine)
            entry["readback"] = readback
            entry["assignable"] = readback == candidate
        except Exception as exc:
            entry["error"] = _error_text(exc)
            # A failed assignment can still leave a readable current value; report it.
            try:
                entry["readback"] = _as_text(scene.render.engine)
            except Exception:
                entry["readback"] = None
        results[candidate] = entry

    # Always try to hand the scene back exactly as we found it.
    if original_engine is not None:
        try:
            scene.render.engine = original_engine
            restored_ok = _as_text(scene.render.engine) == original_engine
        except Exception as exc:
            _eprint("could not restore render engine %r: %s" % (original_engine, _error_text(exc)))

    return results, original_engine, restored_ok


def collect_engine_enum_items_informational():
    """Raw ``engine`` enum identifiers -- INFORMATIONAL ONLY, never used for availability.

    In Blender 5.2.1 LTS this returns ``['BLENDER_EEVEE']`` even though Cycles assigns and
    renders correctly, which is exactly why engine availability is probed behaviorally.
    """
    diagnostic = {"identifiers": [], "staticIdentifiers": [], "error": None}
    try:
        prop = bpy.types.RenderSettings.bl_rna.properties["engine"]
        diagnostic["identifiers"] = [str(item.identifier) for item in prop.enum_items]
    except Exception as exc:
        diagnostic["error"] = _error_text(exc)
    try:
        prop = bpy.types.RenderSettings.bl_rna.properties["engine"]
        diagnostic["staticIdentifiers"] = [str(item.identifier) for item in prop.enum_items_static]
    except Exception:
        # enum_items_static does not exist in every build; absence is not an error.
        diagnostic["staticIdentifiers"] = []
    return diagnostic


def enable_cycles_addon():
    """Enable the bundled Cycles addon inside this process.

    ``default_set=True`` only marks the addon as enabled for the current session; we never
    call ``bpy.ops.wm.save_userpref()``, so nothing is persisted to the user's config and
    the caller-visible filesystem stays untouched.
    """
    report = {"name": "cycles", "attempted": True, "enabled": False, "modulePath": None, "error": None}
    try:
        module = addon_utils.enable("cycles", default_set=True)
        report["enabled"] = module is not None
        report["modulePath"] = _as_text(getattr(module, "__file__", None))
    except Exception as exc:
        report["error"] = _error_text(exc)
    return report


def probe_gpu_devices():
    """Probe Cycles compute backends and enumerate devices for each.

    Most backends are compiled out on a given platform, and assigning an unavailable enum
    value raises ``TypeError`` instead of yielding an empty list -- so every candidate gets
    its own try/except and its own error string. The original ``compute_device_type`` is
    restored afterwards.
    """
    result = {
        "backendSupport": {},
        "availableBackends": [],
        "gpuDeviceNames": [],
        "cpuDeviceNames": [],
        "preferredBackend": None,
        "error": None,
    }

    prefs = None
    original_backend = None

    try:
        addon = bpy.context.preferences.addons.get("cycles")
        if addon is None:
            result["error"] = "Cycles addon preferences unavailable (addon not enabled?)"
            return result
        prefs = addon.preferences
        if prefs is None:
            result["error"] = "Cycles preferences object unavailable"
            return result
    except Exception as exc:
        result["error"] = _error_text(exc)
        return result

    try:
        original_backend = _as_text(prefs.compute_device_type)
    except Exception:
        original_backend = None

    for backend in CANDIDATE_GPU_BACKENDS:
        entry = {"supported": False, "gpuDevices": [], "cpuDevices": [], "error": None}
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            gpu_names = []
            cpu_names = []
            for device in prefs.devices:
                name = _as_text(getattr(device, "name", None))
                device_type = _as_text(getattr(device, "type", None))
                if name is None:
                    continue
                if device_type == "CPU":
                    cpu_names.append(name)
                else:
                    gpu_names.append(name)
            entry["gpuDevices"] = gpu_names
            entry["cpuDevices"] = cpu_names
            entry["supported"] = True
            if gpu_names:
                result["availableBackends"].append(backend)
                # First backend that actually exposes a GPU wins as the preferred one.
                if result["preferredBackend"] is None:
                    result["preferredBackend"] = backend
                    result["gpuDeviceNames"] = gpu_names
            if cpu_names and not result["cpuDeviceNames"]:
                result["cpuDeviceNames"] = cpu_names
        except Exception as exc:
            entry["error"] = _error_text(exc)
        result["backendSupport"][backend] = entry

    # Restore whatever backend selection was in force when we arrived.
    if original_backend is not None:
        try:
            prefs.compute_device_type = original_backend
            prefs.get_devices()
        except Exception as exc:
            _eprint("could not restore compute_device_type %r: %s" % (original_backend, _error_text(exc)))

    return result


def collect_operator_formats():
    """List registered ``bpy.ops.export_scene.*`` / ``bpy.ops.import_scene.*`` operators.

    ``dir()`` on the ops namespace reflects *registered* operators only, which is what
    "available" should mean; ``hasattr`` is misleadingly True for unregistered ones (for
    example ``bpy.ops.export_scene.obj`` exists as an attribute in this build but is absent
    from ``dir()`` and cannot be invoked). Names are validated once more against the RNA
    registry, and any attribute-present-but-unregistered name is reported as a diagnostic.
    """
    formats = {
        "exportFormats": [],
        "importFormats": [],
        "exportUnregistered": [],
        "importUnregistered": [],
        "errors": [],
    }

    for label, namespace, target in (
        ("export", bpy.ops.export_scene, "exportFormats"),
        ("import", bpy.ops.import_scene, "importFormats"),
    ):
        registered = set()
        try:
            candidates = sorted(name for name in dir(namespace) if not name.startswith("_"))
        except Exception as exc:
            formats["errors"].append("%s: %s" % (label, _error_text(exc)))
            candidates = []

        for name in candidates:
            try:
                getattr(namespace, name).get_rna_type()
                registered.add(name)
            except Exception as exc:
                formats["errors"].append("%s.%s: %s" % (label, name, _error_text(exc)))

        formats[target] = sorted(registered)

        # Informational: names reachable as attributes but not registered as operators.
        unregistered = []
        for name in ("obj", "fbx", "gltf", "stl", "ply", "usd", "abc", "dae", "x3d"):
            if name in registered:
                continue
            try:
                if hasattr(namespace, name):
                    unregistered.append(name)
            except Exception:
                pass
        formats["%sUnregistered" % (label,)] = sorted(unregistered)

    return formats


def smoke_render(scene, engine):
    """Render one tiny image headlessly and report the outcome.

    This is the only action in the whole script that produces a file, and it stays inside a
    private ``tempfile`` directory that is removed again before returning. Render settings
    the probe perturbs are saved and restored so the scene is left as found.
    """
    entry = {"attempted": True, "engine": engine, "ok": False, "bytes": 0, "error": None}

    work_dir = None
    saved = {}
    try:
        render = scene.render

        # --- save state -----------------------------------------------------------------
        saved["engine"] = render.engine
        saved["filepath"] = render.filepath
        saved["resolution_x"] = render.resolution_x
        saved["resolution_y"] = render.resolution_y
        saved["resolution_percentage"] = render.resolution_percentage
        saved["file_format"] = render.image_settings.file_format
        saved["cycles_samples"] = getattr(scene.cycles, "samples", None)
        saved["cycles_use_denoising"] = getattr(scene.cycles, "use_denoising", None)
        saved["eevee_samples"] = getattr(scene.eevee, "taa_render_samples", None)

        # --- configure a minimal, fast render -------------------------------------------
        render.engine = engine
        render.resolution_x = PROBE_WIDTH
        render.resolution_y = PROBE_HEIGHT
        render.resolution_percentage = 100
        render.image_settings.file_format = "PNG"
        if engine == "CYCLES":
            # 1 sample and no denoise keeps the probe effectively instantaneous.
            try:
                scene.cycles.samples = 1
            except Exception:
                pass
            try:
                scene.cycles.use_denoising = False
            except Exception:
                pass
        elif engine == "BLENDER_EEVEE":
            try:
                scene.eevee.taa_render_samples = 1
            except Exception:
                pass

        # Private scratch directory inside the system temp dir; removed in `finally`.
        work_dir = tempfile.mkdtemp(prefix="deepblend-probe-", dir=tempfile.gettempdir())
        output_path = os.path.join(work_dir, "probe.png")
        render.filepath = output_path

        # --- render ---------------------------------------------------------------------
        bpy.ops.render.render(write_still=True)

        # Blender may or may not append the extension depending on settings; check both.
        written = None
        for candidate_path in (output_path, output_path + ".png"):
            if os.path.exists(candidate_path):
                written = candidate_path
                break
        entry["bytes"] = int(os.path.getsize(written)) if written else 0
        entry["ok"] = entry["bytes"] > 0
        if not entry["ok"]:
            entry["error"] = "render completed but produced no image data"
    except Exception as exc:
        entry["error"] = _error_text(exc)
    finally:
        # --- restore state --------------------------------------------------------------
        try:
            render = scene.render
            if saved.get("engine") is not None:
                render.engine = saved["engine"]
            if saved.get("filepath") is not None:
                render.filepath = saved["filepath"]
            if saved.get("resolution_x") is not None:
                render.resolution_x = saved["resolution_x"]
            if saved.get("resolution_y") is not None:
                render.resolution_y = saved["resolution_y"]
            if saved.get("resolution_percentage") is not None:
                render.resolution_percentage = saved["resolution_percentage"]
            if saved.get("file_format") is not None:
                render.image_settings.file_format = saved["file_format"]
            if saved.get("cycles_samples") is not None:
                scene.cycles.samples = saved["cycles_samples"]
            if saved.get("cycles_use_denoising") is not None:
                scene.cycles.use_denoising = saved["cycles_use_denoising"]
            if saved.get("eevee_samples") is not None:
                scene.eevee.taa_render_samples = saved["eevee_samples"]
        except Exception as exc:
            _eprint("could not fully restore render settings: %s" % (_error_text(exc),))

        # --- clean up the probe image ---------------------------------------------------
        if work_dir:
            try:
                shutil.rmtree(work_dir, ignore_errors=True)
            except Exception:
                pass

    return entry


def collect_capabilities():
    """Run every probe and assemble ``(capabilities, warnings)``.

    Raises only if the scene itself is unreachable; every individual probe is guarded so one
    missing feature degrades into a warning instead of losing the whole report.
    """
    warnings = []

    identity = collect_identity()
    host_platform = collect_host_platform()

    scene = resolve_scene()
    if scene is None:
        raise RuntimeError("no scene available to probe in this Blender session")

    # Pass 1: behavioral engine probe *before* the Cycles addon is enabled.
    pre_enable_results, original_engine, _ = probe_engine_assignability(scene)

    # Enable Cycles, then re-run the probes -- this second pass is authoritative.
    cycles_addon = enable_cycles_addon()
    if not cycles_addon["enabled"]:
        warnings.append(
            "Cycles addon could not be enabled: %s" % (cycles_addon["error"] or "unknown reason",)
        )

    render_engines, original_engine_after, restored_ok = probe_engine_assignability(scene)
    if not restored_ok:
        warnings.append("Original render engine %r could not be restored" % (original_engine_after,))
    if original_engine is not None and original_engine_after is None:
        original_engine_after = original_engine

    engine_enum_diagnostic = collect_engine_enum_items_informational()
    diagnostics_enum = engine_enum_diagnostic["identifiers"]

    for candidate in CANDIDATE_ENGINES:
        entry = render_engines.get(candidate, {})
        if not entry.get("assignable"):
            warnings.append(
                "Render engine %s is not assignable (%s)"
                % (candidate, entry.get("error") or "assignment did not take effect")
            )
    if render_engines.get("CYCLES", {}).get("assignable") is not True:
        warnings.append("Cycles not assignable")

    # The enum's own view disagrees with behaviour in this build; surface that loudly.
    behaviorally_available = sorted(
        name for name, entry in render_engines.items() if entry.get("assignable")
    )
    if behaviorally_available != sorted(diagnostics_enum):
        warnings.append(
            "engine enum_items %r disagrees with behavioral probe %r; behavioral result is authoritative"
            % (diagnostics_enum, behaviorally_available)
        )

    best_available = None
    for preferred in ENGINE_PREFERENCE:
        if render_engines.get(preferred, {}).get("assignable"):
            best_available = preferred
            break
    if best_available is None:
        warnings.append("No candidate render engine is assignable; smoke render will be skipped")

    gpu_devices = probe_gpu_devices()
    if gpu_devices.get("error"):
        warnings.append("GPU device probe failed: %s" % (gpu_devices["error"],))
    elif not gpu_devices["availableBackends"]:
        warnings.append("No Cycles GPU compute backend exposed a GPU device")
    else:
        _eprint(
            "GPU backend(s) available: %s; devices: %s"
            % (", ".join(gpu_devices["availableBackends"]), ", ".join(gpu_devices["gpuDeviceNames"]))
        )

    formats = collect_operator_formats()
    for collection, label in (("exportFormats", "export"), ("importFormats", "import")):
        names = formats[collection]
        if not names:
            warnings.append("No %s operators are registered" % (label,))
        for expected, pretty in (("obj", "OBJ"), ("fbx", "FBX"), ("gltf", "glTF")):
            if expected not in names:
                warnings.append("%s %s not available" % (pretty, label))

    # --- render smoke tests -------------------------------------------------------------
    if best_available is None:
        render_smoke_test = {
            "attempted": False,
            "engine": None,
            "ok": False,
            "bytes": 0,
            "error": "no assignable render engine",
        }
    else:
        render_smoke_test = smoke_render(scene, best_available)
        if not render_smoke_test["ok"]:
            warnings.append(
                "Headless render smoke test failed on %s: %s"
                % (best_available, render_smoke_test["error"] or "unknown error")
            )

    # Cycles gets its own smoke render, but only when the behavioral probe says it is there.
    cycles_smoke_test = None
    if render_engines.get("CYCLES", {}).get("assignable"):
        if best_available == "CYCLES":
            # The primary probe already proved Cycles renders; do not render twice.
            cycles_smoke_test = dict(render_smoke_test)
            cycles_smoke_test["reusedFromPrimary"] = True
        else:
            cycles_smoke_test = smoke_render(scene, "CYCLES")
            cycles_smoke_test["reusedFromPrimary"] = False
            if not cycles_smoke_test["ok"]:
                warnings.append(
                    "Cycles smoke render failed: %s" % (cycles_smoke_test["error"] or "unknown error",)
                )

    text_block_api = False
    try:
        text_block_api = bool(hasattr(bpy.data, "texts"))
    except Exception as exc:
        warnings.append("Text datablock API probe failed: %s" % (_error_text(exc),))
    if not text_block_api:
        warnings.append("bpy.data.texts is unavailable (text block API missing)")

    frame_api = False
    frame_api_error = None
    try:
        frame_api = bool(hasattr(scene, "frame_start"))
        if frame_api:
            # Touch the value so a property that exists but cannot be read still shows up.
            _ = int(scene.frame_start)
    except Exception as exc:
        frame_api = False
        frame_api_error = _error_text(exc)
        warnings.append("Scene frame API probe failed: %s" % (frame_api_error,))
    if not frame_api and frame_api_error is None:
        warnings.append("scene.frame_start is unavailable (frame API missing)")

    capabilities = {
        # --- identity -------------------------------------------------------------------
        "blenderVersion": identity["blenderVersion"],
        "blenderVersionTuple": identity["blenderVersionTuple"],
        "pythonVersion": identity["pythonVersion"],
        "buildHash": identity["buildHash"],
        "binaryPath": identity["binaryPath"],
        "hostPlatform": host_platform,
        # --- render engines (behavioral, authoritative) ---------------------------------
        "renderEngines": render_engines,
        "bestAvailableEngine": best_available,
        "renderEngineDiagnostics": {
            # Informational ONLY -- must never be used to decide engine availability.
            "engineEnumItemsInformational": engine_enum_diagnostic,
            "note": (
                "engineEnumItemsInformational is not authoritative: in this build the enum "
                "reports fewer engines than are actually assignable. Use renderEngines."
            ),
            "preAddonEnableProbe": pre_enable_results,
            "cyclesAddon": cycles_addon,
            "originalEngine": original_engine_after,
            "originalEngineRestored": restored_ok,
            "behaviorallyAvailable": behaviorally_available,
        },
        # --- GPU ------------------------------------------------------------------------
        "gpuDevices": gpu_devices,
        # --- operators ------------------------------------------------------------------
        "exportFormats": formats["exportFormats"],
        "importFormats": formats["importFormats"],
        "formatDiagnostics": {
            "exportUnregisteredButPresent": formats["exportUnregistered"],
            "importUnregisteredButPresent": formats["importUnregistered"],
            "errors": formats["errors"],
        },
        # --- render proof ---------------------------------------------------------------
        "renderSmokeTest": render_smoke_test,
        "cyclesSmokeTest": cycles_smoke_test,
        "renderProbeSize": {"width": PROBE_WIDTH, "height": PROBE_HEIGHT},
        # --- lightweight APIs -----------------------------------------------------------
        "textBlockApi": text_block_api,
        "frameApi": frame_api,
    }

    return capabilities, warnings


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def main():
    argv = list(sys.argv)
    request_path, result_path, unknown_tokens = parse_args(argv)

    for token in unknown_tokens:
        _eprint("ignoring unrecognised argument %r" % (token,))

    # Identity is best-effort at every stage, including failures: a caller debugging a
    # protocol mismatch still benefits from knowing which binary answered.
    def safe_identity():
        try:
            return collect_identity()
        except Exception:
            return None

    # --- arguments ----------------------------------------------------------------------
    if not result_path:
        # No result path means there is no contract to honour; stderr is all that is left.
        _eprint("missing --result path after '--'; nothing can be written")
        return EXIT_BAD_ARGS

    if not request_path:
        envelope = build_envelope(
            None,
            safe_identity(),
            None,
            [],
            {"code": "REQUEST_NOT_FOUND", "message": "no --request path supplied after '--'"},
        )
        write_result(result_path, envelope)
        return EXIT_REQUEST_UNREADABLE

    # --- read the request ---------------------------------------------------------------
    try:
        with open(request_path, "r", encoding="utf-8") as handle:
            raw_request = handle.read()
    except Exception as exc:
        envelope = build_envelope(
            None,
            safe_identity(),
            None,
            [],
            {
                "code": "REQUEST_NOT_FOUND",
                "message": "could not read request file %r: %s" % (request_path, _error_text(exc)),
            },
        )
        write_result(result_path, envelope)
        return EXIT_REQUEST_UNREADABLE

    try:
        request = json.loads(raw_request)
    except Exception as exc:
        envelope = build_envelope(
            None,
            safe_identity(),
            None,
            [],
            {
                "code": "REQUEST_INVALID",
                "message": "request file %r is not valid JSON: %s" % (request_path, _error_text(exc)),
            },
        )
        write_result(result_path, envelope)
        return EXIT_REQUEST_INVALID

    if not isinstance(request, dict):
        envelope = build_envelope(
            None,
            safe_identity(),
            None,
            [],
            {
                "code": "REQUEST_INVALID",
                "message": "request JSON must be an object, got %s" % (type(request).__name__,),
            },
        )
        write_result(result_path, envelope)
        return EXIT_REQUEST_INVALID

    job_id = request.get("jobId")
    if not isinstance(job_id, str):
        # A non-string jobId is echoed back as null rather than coerced, so the caller never
        # mistakes a fabricated value for its own.
        job_id = None

    # --- protocol gate ------------------------------------------------------------------
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        envelope = build_envelope(
            job_id,
            safe_identity(),
            None,
            [],
            {
                "code": "PROTOCOL_VERSION_MISMATCH",
                "message": "expected protocolVersion %r, got %r"
                % (PROTOCOL_VERSION, request.get("protocolVersion")),
            },
        )
        write_result(result_path, envelope)
        return EXIT_PROTOCOL_MISMATCH

    # --- action gate --------------------------------------------------------------------
    action = request.get("action")
    if action != SUPPORTED_ACTION:
        envelope = build_envelope(
            job_id,
            safe_identity(),
            None,
            [],
            {
                "code": "UNSUPPORTED_ACTION",
                "message": "unsupported action %r; this probe only supports %r"
                % (action, SUPPORTED_ACTION),
            },
        )
        write_result(result_path, envelope)
        return EXIT_UNSUPPORTED_ACTION

    # --- capability probe ---------------------------------------------------------------
    try:
        capabilities, warnings = collect_capabilities()
        envelope = build_envelope(job_id, safe_identity(), capabilities, warnings, None)
        write_result(result_path, envelope)
        return EXIT_OK
    except Exception as exc:
        # An unexpected failure must still leave a parseable envelope behind.
        _eprint("capability probe failed: %s" % (_error_text(exc),))
        _eprint(traceback.format_exc())
        envelope = build_envelope(
            job_id,
            safe_identity(),
            None,
            [],
            {
                "code": "CAPABILITY_PROBE_FAILED",
                "message": _error_text(exc),
                "traceback": traceback.format_exc(),
            },
        )
        write_result(result_path, envelope)
        return EXIT_PROBE_FAILED


if __name__ == "__main__":
    exit_code = EXIT_PROBE_FAILED
    try:
        exit_code = main()
    except SystemExit:
        raise
    except BaseException as fatal:  # noqa: BLE001 - last-resort safety net
        _eprint("fatal error before an envelope could be written: %s" % (_error_text(fatal),))
        _eprint(traceback.format_exc())
        exit_code = EXIT_PROBE_FAILED

    # Flush both streams explicitly: sys.exit inside Blender's --python handler terminates
    # the process immediately, and buffered diagnostics would otherwise be lost.
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    sys.exit(exit_code)
