"""DeepBlend Studio — the Blender-side bridge (SPEC §20 M6 "Blender Add-on" / "Live Bridge").

WHAT THIS IS
------------
One file with two entry points, and that is deliberate:

* **As a Blender add-on** (the GUI case): the user installs it, enables it, and their own Blender
  opens a local socket and shows a panel saying whether DeepBlend is attached. Every operation then
  runs in the Blender they are LOOKING AT, which is the whole point of the M6 item — the batch round
  trip stops being the only shape.
* **As a headless server** (the case a test can drive): `blender --background --python
  deepblend_bridge.py -- --socket <path>` serves exactly the same protocol with no GUI at all.

Two entry points rather than two files, because the protocol and the dispatch are one thing: a second
copy for the headless case would be a second answer to "what does compile_scene do", and it would rot
first because nothing runs it.

WHAT IT REUSES
--------------
`bootstrap.py`'s dispatch, unchanged: the same `ACTIONS` table, the same protocol-version check, the
same envelope builder, the same per-request process identity. This file adds a TRANSPORT (a socket)
and a GUI (a panel), not a second implementation.

THE PROTOCOL is the session protocol, one JSON document per line: the product sends
`{protocolVersion, jobId, action, payload?}`, this answers with the envelope bootstrap.py builds.
`{"action": "shutdown"}` closes the connection.

Owner: DeepBlend Studio — SPEC §20 M6
"""

import json
import os
import socket
import sys
import threading

import bpy  # noqa: F401  — present in Blender; the import is what makes this an add-on module

def _find_bootstrap():
    """Import `bootstrap` from wherever it actually is, or say what to set.

    MEASURED PROBLEM, and it is the user's case rather than the test's: Blender COPIES an add-on into
    its own add-ons directory, so the file that lands there is this one ALONE — `bootstrap.py` is not
    beside it, and `import bootstrap` fails. The headless entry point never sees this, because there
    the file still sits in the package.

    So the search is: beside me (headless), then the directory an operator points at, then the one a
    user can paste into the add-on's preferences. When all three miss, the failure names the setting
    instead of raising an ImportError into a panel that shows nothing.
    """
    candidates = [os.path.dirname(os.path.abspath(__file__))]
    configured = os.environ.get("DEEPBLEND_BOOTSTRAP_DIR", "")
    if configured:
        candidates.append(configured)
    try:
        preferences = bpy.context.preferences.addons[__name__].preferences
        if getattr(preferences, "bootstrap_dir", ""):
            candidates.insert(0, preferences.bootstrap_dir)
    except Exception:
        # No preferences yet (headless, or before registration): the other two are enough.
        pass

    for candidate in candidates:
        if candidate and os.path.exists(os.path.join(candidate, "bootstrap.py")):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
            import bootstrap  # noqa: F401
            return sys.modules["bootstrap"]
    return None


bootstrap = _find_bootstrap()
BOOTSTRAP_PROBLEM = None if bootstrap is not None else (
    "bootstrap.py was not found. Set DEEPBLEND_BOOTSTRAP_DIR to the provider package's python "
    "directory (…/provider-local/python), or paste it into this add-on's preferences."
)

bl_info = {
    "name": "DeepBlend Studio Bridge",
    "author": "DeepBlend Studio",
    "version": (0, 2, 4),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > DeepBlend",
    "description": "Serve DeepBlend operations inside this Blender, so the product drives the window you are looking at",
    "category": "Scene",
}

# The default socket path. One per workspace, so two stores on one machine do not collide — and the
# product passes its own path when it starts the headless server, so this default is only what the
# add-on uses when a user enables it with no configuration.
DEFAULT_SOCKET = os.path.join(os.path.expanduser("~"), ".deepblend-bridge.sock")


class _Bridge:
    """The serving state: one socket, one thread, and the last thing that happened."""

    def __init__(self, socket_path, options=None):
        self.socket_path = socket_path
        self.options = options or {}
        # WHICH WORKSPACE THIS BLENDER SERVES, when it was told. Empty means "not stated", which is
        # what every deployment did before this existed — and the product treats "not stated" as
        # "serves anything" rather than as a mismatch, so nothing that worked before stops working.
        #
        # WHY IT MATTERS: the socket path has a global default, so two workspaces on one machine can
        # point the product at the SAME Blender. Without this, the product in workspace B would drive
        # the Blender that workspace A's user is looking at, and the operations would land in a scene
        # nobody intended — silently, because both sides are behaving correctly.
        self.workspace = self.options.get("workspace") or ""
        self.server = None
        self.thread = None
        self.requests = 0
        self.last_action = None
        self.last_error = None
        self.connected = False

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        # THREE STATES, NOT TWO. A socket path that exists is either a LIVE bridge or the file a dead
        # one left behind, and the difference decides everything.
        #
        # MEASURED, and this is why: two workspaces on one machine both enabled the add-on, and the
        # SECOND bridge unlinked the first's socket file, bound its own, and announced `ready` — so the
        # first Blender became unreachable while still believing it was listening, and the second
        # reported success. That is the failure this repository keeps paying for: something other than
        # what was asked, reported as fine.
        if os.path.exists(self.socket_path):
            if self._someone_is_listening():
                raise RuntimeError(
                    "another Blender is already serving %s. Give this one its own path with "
                    "DEEPBLEND_BRIDGE_SOCKET (or the add-on's preferences), or stop the other bridge."
                    % (self.socket_path,)
                )
            # Nothing answers, so it is the file a process that died left behind. Refusing here would
            # leave the user with no way forward except deleting a file they cannot see.
            os.unlink(self.socket_path)
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.socket_path)
        self.server.listen(4)
        self.thread = threading.Thread(target=self._serve, name="deepblend-bridge", daemon=True)
        self.thread.start()

    def _someone_is_listening(self):
        """Whether a live bridge is behind this path, rather than a file left by a dead one."""
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(1.0)
        try:
            probe.connect(self.socket_path)
            return True
        except Exception:
            return False
        finally:
            try:
                probe.close()
            except Exception:
                pass

    def stop(self):
        try:
            if self.server is not None:
                self.server.close()
        except Exception:
            pass
        self.server = None
        try:
            if os.path.exists(self.socket_path):
                os.unlink(self.socket_path)
        except Exception:
            pass

    # -- serving -----------------------------------------------------------

    def _serve(self):
        while self.server is not None:
            try:
                connection, _ = self.server.accept()
            except Exception:
                return
            self.connected = True
            try:
                self._converse(connection)
            except Exception as exc:
                self.last_error = bootstrap.error_text(exc)
            finally:
                self.connected = False
                try:
                    connection.close()
                except Exception:
                    pass

    def _converse(self, connection):
        """One connection: a handshake, then a line in and an envelope out, until the peer stops.

        THE HANDSHAKE IS THE SESSION PROTOCOL'S OWN, and it took a hang to notice it was missing: the
        headless entry point printed `{"kind": "ready"}` to stdout at startup, and a CONNECTION got
        nothing — so the product's `BlenderSession.ready()` waited forever on a peer that was already
        serving. A transport that answers the same conversation has to open it the same way.
        """
        connection.sendall((json.dumps({
            "kind": "ready",
            "pid": os.getpid(),
            "socket": self.socket_path,
            "workspace": self.workspace,
        }) + "\n").encode("utf-8"))
        buffer = b""
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                text = line.decode("utf-8", "replace").strip()
                if text == "":
                    continue
                try:
                    request = json.loads(text)
                except Exception as exc:
                    answer = bootstrap.build_envelope(None, None, None, {
                        "code": "BLENDER_SCRIPT_ERROR",
                        "message": "the request line is not valid JSON: %s" % (bootstrap.error_text(exc),),
                    }, [], [])
                else:
                    if isinstance(request, dict) and request.get("action") == "shutdown":
                        connection.sendall((json.dumps({"kind": "bye", "pid": os.getpid()}) + "\n").encode("utf-8"))
                        return
                    self.requests += 1
                    self.last_action = request.get("action") if isinstance(request, dict) else None
                    answer = bootstrap._session_dispatch(request, self.options)
                answer["kind"] = "result"
                connection.sendall((json.dumps(answer, ensure_ascii=False) + "\n").encode("utf-8"))

    # -- what the panel shows ----------------------------------------------

    def status(self):
        if self.server is None:
            return "off"
        return "attached" if self.connected else "listening on %s" % (self.socket_path,)


_BRIDGE = None


class DeepBlendBridgePreferences(bpy.types.AddonPreferences):
    """Where the user points the add-on at the package, because Blender copies add-ons alone."""

    bl_idname = __name__

    bootstrap_dir: bpy.props.StringProperty(  # type: ignore[valid-type]
        name="bootstrap.py directory",
        description="The provider package's python directory (…/provider-local/python)",
        default="",
        subtype="DIR_PATH",
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "bootstrap_dir")
        if BOOTSTRAP_PROBLEM is not None:
            layout.label(text=BOOTSTRAP_PROBLEM, icon="ERROR")


class DEEPBLEND_PT_bridge(bpy.types.Panel):
    """The panel, because an add-on a user cannot see is an add-on they will not trust."""

    bl_label = "DeepBlend Studio"
    bl_idname = "DEEPBLEND_PT_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "DeepBlend"

    def draw(self, context):
        layout = self.layout
        if BOOTSTRAP_PROBLEM is not None:
            layout.label(text="bootstrap.py not found", icon="ERROR")
            layout.label(text="Set it in this add-on's preferences")
            return
        if _BRIDGE is None:
            layout.label(text="Bridge is not running", icon="ERROR")
            return
        layout.label(text="Status: %s" % (_BRIDGE.status(),))
        layout.label(text="Socket: %s" % (os.path.basename(_BRIDGE.socket_path),))
        layout.label(text="Operations served: %d" % (_BRIDGE.requests,))
        if _BRIDGE.workspace:
            layout.label(text="Workspace: %s" % (os.path.basename(_BRIDGE.workspace),))
        if _BRIDGE.last_action is not None:
            layout.label(text="Last: %s" % (_BRIDGE.last_action,))
        if _BRIDGE.last_error is not None:
            layout.label(text="Last error: %s" % (_BRIDGE.last_error[:60],), icon="ERROR")


def register():
    global _BRIDGE
    socket_path = os.environ.get("DEEPBLEND_BRIDGE_SOCKET", DEFAULT_SOCKET)
    _BRIDGE = _Bridge(socket_path, {"workspace": os.environ.get("DEEPBLEND_BRIDGE_WORKSPACE", "")})
    try:
        _BRIDGE.start()
    except Exception as exc:
        # A bridge that cannot listen must not stop Blender from starting: the user's session is more
        # important than this panel, and the panel says what went wrong.
        _BRIDGE.last_error = bootstrap.error_text(exc)
    bpy.utils.register_class(DeepBlendBridgePreferences)
    bpy.utils.register_class(DEEPBLEND_PT_bridge)


def unregister():
    global _BRIDGE
    bpy.utils.unregister_class(DEEPBLEND_PT_bridge)
    bpy.utils.unregister_class(DeepBlendBridgePreferences)
    if _BRIDGE is not None:
        _BRIDGE.stop()
    _BRIDGE = None


def main():
    """Headless entry point: serve until the process is asked to stop."""
    argv = sys.argv
    options = {}
    workspace = os.environ.get("DEEPBLEND_BRIDGE_WORKSPACE", "")
    if "--" in argv:
        tokens = argv[argv.index("--") + 1:]
        index = 0
        while index < len(tokens):
            if tokens[index] == "--socket" and index + 1 < len(tokens):
                options["socket"] = tokens[index + 1]
                index += 2
                continue
            if tokens[index] == "--workspace" and index + 1 < len(tokens):
                workspace = tokens[index + 1]
                index += 2
                continue
            index += 1
    socket_path = options.get("socket", DEFAULT_SOCKET)

    if bootstrap is None:
        print(json.dumps({"kind": "error", "message": BOOTSTRAP_PROBLEM}), flush=True)
        return 2

    global _BRIDGE
    _BRIDGE = _Bridge(socket_path, {"proc": None, "workspace": workspace})
    try:
        _BRIDGE.start()
    except Exception as exc:
        # A REFUSAL IS A RESULT, NOT A TRACEBACK. The one thing that can go wrong here is a named,
        # actionable condition — another bridge on the same path — and a caller parsing stdout should
        # get a document it can read rather than a stack it has to scrape. The add-on path already
        # reports this in its panel; this is the same sentence for the headless one.
        print(json.dumps({"kind": "error", "message": bootstrap.error_text(exc)}), flush=True)
        return 2
    print(json.dumps({"kind": "ready", "pid": os.getpid(), "socket": socket_path, "workspace": workspace}), flush=True)
    try:
        # The serve thread is a daemon, so this loop is what keeps the process alive. A SIGTERM (or
        # the product closing the socket and asking for shutdown) ends it.
        _BRIDGE.thread.join()
    except KeyboardInterrupt:
        pass
    finally:
        _BRIDGE.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
