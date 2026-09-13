#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for the DeepBlend Blender-side bootstrap actions.

Everything in this module runs inside Blender's embedded CPython interpreter. It
is deliberately free of ``bpy`` imports: it is the part of the runtime that can
be read, reasoned about and reviewed as plain Python.

CONTRACT DISCIPLINE
-------------------
Two rules run through the whole Blender-side runtime and are worth stating once:

1. **The result is a JSON document written to a caller-supplied path.** stdout is
   never a result channel: Blender writes banners, add-on chatter and progress
   lines to stdout, so anything that parses stdout is parsing around noise. Short
   diagnostics go to stderr prefixed with ``[deepblend]`` and are informational.

2. **The SceneSpec is the authority, not the .blend.** The compiler applies every
   transform, visibility flag and animation TRACK, but it never treats a
   pre-existing object as something to preserve. That is what makes a rebuild
   reproducible and what makes "the spec changed" and "the scene changed" the
   same statement (SPEC §8.1).

Standard library only, plus whatever the caller's action module needs.
"""

import json
import os
import sys
import tempfile
import traceback

#: Protocol version for the request/result envelope. Bumped only on a breaking
#: wire change; ``bootstrap.py`` refuses a request that disagrees.
PROTOCOL_VERSION = "deepblend.blender/v1"


def eprint(message):
    """Emit an informational diagnostic on stderr. Never part of the contract."""
    try:
        sys.stderr.write("[deepblend] %s\n" % (message,))
        sys.stderr.flush()
    except Exception:
        # Diagnostics must never be able to break a run.
        pass


def as_text(value):
    """Coerce a bpy value into plain JSON-safe text.

    ``bpy.app.build_hash`` is ``bytes`` (``b'9e2066aef7ef'``) and blindly
    JSON-encoding that fails, so every leaf scalar that reaches JSON passes
    through here.
    """
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "replace")
        except Exception:
            return repr(value)
    if isinstance(value, (str, int, float, bool)):
        return value
    try:
        return str(value)
    except Exception:
        return None


def error_text(exc):
    """Render an exception as a compact, JSON-safe ``"Type: message"`` string."""
    try:
        return "%s: %s" % (type(exc).__name__, exc)
    except Exception:
        return "unprintable exception"


#: Frame-sequence file naming. The host computes expected paths from the same
#: rule (`frameFileName` in @deepblend/dsh-blender-contracts) to build the frame
#: ledger, so the two must agree byte for byte — a disagreement makes every frame
#: read as missing. These live here, in the bpy-free module, so the contract test
#: can compare the two implementations WITHOUT launching Blender; a naming rule
#: that can only be checked by a 1-second process launch is a rule that gets
#: checked by nobody.
FRAME_FILE_PREFIX = "frame_"
FRAME_FILE_PADDING = 4


def frame_file_name(frame, prefix=FRAME_FILE_PREFIX, padding=FRAME_FILE_PADDING):
    """The exact file name one frame is written to.

    MEASURED, and the reason the renderer sets its own output path: on Blender
    5.2.1, `scene.render.frame_path(frame=f)` PREDICTS `<dir>/frame_0001.png`
    while `bpy.ops.render.render(write_still=True)` writes `<dir>/frame_.png`.
    """
    return "%s%0*d.png" % (prefix, int(padding), int(frame))


def frame_path(directory, frame, prefix=FRAME_FILE_PREFIX, padding=FRAME_FILE_PADDING):
    """The absolute path one frame is written to."""
    return os.path.join(directory, frame_file_name(frame, prefix, padding))


def write_json_atomic(path, document):
    """Write ``document`` as pretty JSON, atomically.

    The temp file is a sibling so the final ``os.replace`` stays on one
    filesystem, where it is atomic. A reader therefore sees either the previous
    file or the complete new one, never a half-written document.
    """
    directory = os.path.dirname(os.path.abspath(path))
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    handle, temporary = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp", dir=directory or None
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(document, stream, indent=2, ensure_ascii=False, sort_keys=False)
            stream.write("\n")
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except Exception:
            pass
        raise


def read_json(path):
    """Read a JSON document, raising a message that names the file."""
    with open(path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def parse_args(argv, known_options):
    """Parse ``--opt value`` / ``--opt=value`` tokens after a bare ``--``.

    Blender consumes its own arguments before the separator; everything after it
    belongs to the bootstrap script. Returns ``(options, unknown)`` where
    ``options`` is a dict of the recognised keys (absent when not supplied) and
    ``unknown`` lists anything unexpected, so the caller can fail loudly on a
    typo instead of silently running with a default.
    """
    options = {}
    unknown = []

    try:
        separator = argv.index("--")
    except ValueError:
        return options, unknown

    tokens = list(argv[separator + 1:])
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1

        inline_value = None
        name = token
        if token.startswith("--") and "=" in token:
            name, inline_value = token.split("=", 1)

        if name in known_options:
            if inline_value is not None:
                value = inline_value
            elif index < len(tokens):
                value = tokens[index]
                index += 1
            else:
                unknown.append("%s (missing value)" % (name,))
                continue
            options[name.lstrip("-").replace("-", "_")] = value
        elif token.startswith("--"):
            unknown.append(token)

    return options, unknown


def report_progress(stage, percent, detail=None):
    """Report progress on stdout as one JSON object per line (SPEC §9.3).

    This is the ONE thing that legitimately goes to stdout, and it is
    distinguishable by construction: each line is a complete JSON document with a
    ``type`` key, so a consumer can filter Blender's own output by parsing rather
    than by pattern-matching prose. It is advisory only — the contract is still
    the result file.
    """
    payload = {"type": "progress", "stage": stage, "percent": percent}
    if detail is not None:
        payload["detail"] = detail
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def warning(code, message, detail=None):
    """Build one warning entry. Warnings degrade a success; they never throw."""
    entry = {"code": code, "message": message}
    if detail is not None:
        entry["detail"] = detail
    return entry


class Guard:
    """Collects warnings, notices and per-item decisions for one action.

    One collector per action run, passed down rather than returned up, so a
    decision made five call levels deep still reaches the caller's envelope. A
    decision that is only visible in a log — or worse, only in the render — is the
    most expensive kind of bug to find, so nothing is allowed to decide silently.
    """

    def __init__(self):
        self.warnings = []
        self.notices = []

    def warn(self, code, message, detail=None):
        self.warnings.append(warning(code, message, detail))

    def note(self, code, message, detail=None):
        self.notices.append(warning(code, message, detail))


class ActionError(Exception):
    """A classified failure that must reach the caller as a stable code.

    ``code`` is a ``BlenderErrorCode`` value from the contracts package. The
    ``bootstrap.py`` dispatcher converts this into an error envelope and a
    non-zero exit code, so an unsupported or refused action is never mistaken for
    a success with empty output.
    """

    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def guard(handler):
    """Run ``handler`` and return ``(result, error)``.

    Used by the dispatcher so that a single action cannot take the process down
    with an unhandled exception: every failure becomes a classified error
    envelope, and a genuinely unexpected one still carries its traceback in the
    detail for post-mortem.
    """

    def wrapped(*args, **kwargs):
        try:
            return handler(*args, **kwargs), None
        except ActionError as exc:
            return None, {"code": exc.code, "message": exc.message, "detail": exc.detail}
        except Exception as exc:  # noqa: BLE001 - the boundary must catch everything
            return None, {
                "code": "BLENDER_SCRIPT_ERROR",
                "message": error_text(exc),
                "detail": {"traceback": traceback.format_exc()},
            }

    return wrapped
