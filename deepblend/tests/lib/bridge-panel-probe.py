"""Draw the bridge's panel HEADLESSLY, and print what it wrote.

WHY THIS EXISTS
---------------
The Live Bridge family has criteria for its transport, its protocol, its failure modes and its
attachment — and none for the PANEL, which is the only part a user actually looks at. "It looks
nice" needs a screen and a person; "it says the truth" does not. So this runs inside Blender in
background mode, registers the add-on for real, and calls the panel's own `draw()` with a layout
that RECORDS instead of painting.

What it proves is the part that can be wrong without anyone noticing: a panel that shows a stale
count, a wrong socket, or nothing at all when the bridge is down. What it does NOT prove — and the
record says so rather than implying otherwise — is that the panel is laid out well.

Run (the suite does this):
  DEEPBLEND_BOOTSTRAP_DIR=<provider-local/python> blender --background --factory-startup \
    --python deepblend/tests/lib/bridge-panel-probe.py -- --socket <path>

Prints one JSON document on the last line.

Owner: DeepBlend Studio — SPEC §20 M6 (Blender Add-on)
"""

import json
import os
import socket
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROVIDER_PYTHON = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'packages', 'deepblend', 'provider-local', 'python'))
os.environ.setdefault('DEEPBLEND_BOOTSTRAP_DIR', PROVIDER_PYTHON)

sys.path.insert(0, PROVIDER_PYTHON)
import deepblend_bridge as bridge  # noqa: E402


class RecordingLayout:
    """A layout that writes down what it was asked to show, instead of showing it."""

    def __init__(self):
        self.lines = []

    def label(self, text='', icon='NONE'):
        self.lines.append({'call': 'label', 'text': text, 'icon': icon})

    def prop(self, owner, name):
        self.lines.append({'call': 'prop', 'name': name})

    def row(self):
        return self


class FakePanel:
    """The panel's `draw` only ever touches `self.layout`, so this is the whole of what it needs."""

    def __init__(self, layout):
        self.layout = layout


def draw_panel():
    layout = RecordingLayout()
    # Blender's own context, not a stub: in background mode it exists and is what the panel would
    # receive, so the call is the same one the UI makes.
    import bpy
    bridge.DEEPBLEND_PT_bridge.draw(FakePanel(layout), bpy.context)
    return layout.lines


def ask(socket_path, document):
    """One request over the bridge's own socket, so the panel's count comes from real work."""
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(socket_path)
    connection.sendall((json.dumps(document) + '\n').encode('utf-8'))
    # THE FIRST LINE IS THE HANDSHAKE, not the answer: a connection opens with `{"kind": "ready"}` and
    # the envelope follows. Reading line zero returned the handshake and reported the request as
    # unanswered — the same off-by-one a caller of this protocol would hit.
    answer = b''
    while b'\n' not in answer or b'"kind": "result"' not in answer:
        chunk = connection.recv(65536)
        if not chunk:
            break
        answer += chunk
        if answer.count(b'\n') >= 2:
            break
    connection.close()
    for line in answer.split(b'\n'):
        if not line.strip():
            continue
        document = json.loads(line.decode('utf-8'))
        if document.get('kind') == 'result':
            return document
    return {}


def main():
    argv = sys.argv
    socket_path = bridge.DEFAULT_SOCKET
    if '--' in argv:
        tokens = argv[argv.index('--') + 1:]
        if '--socket' in tokens:
            socket_path = tokens[tokens.index('--socket') + 1]

    # THE ADD-ON READS THE ENVIRONMENT, not a command line: that is how a user's own Blender is told
    # where to listen, so the probe tells it the same way rather than reaching past it.
    os.environ['DEEPBLEND_BRIDGE_SOCKET'] = socket_path
    readings = {'bootstrapFound': bridge.bootstrap is not None, 'socket': socket_path}

    # BEFORE registration: the state a user sees if the add-on is enabled but the bridge is not up.
    bridge._BRIDGE = None
    readings['beforeRegister'] = draw_panel()

    bridge.register()
    readings['afterRegister'] = draw_panel()
    readings['registeredClasses'] = {
        'panel': hasattr(bridge, 'DEEPBLEND_PT_bridge'),
        'preferences': hasattr(bridge, 'DeepBlendBridgePreferences'),
        # Blender stores a property declared with an annotation in `__annotations__`, not in `dir()`
        # of the class — MEASURED: asking `dir()` said the property did not exist on a class that has it.
        'preferencesHasBootstrapDir': 'bootstrap_dir' in getattr(bridge.DeepBlendBridgePreferences, '__annotations__', {}),
    }

    # AFTER REAL WORK: the panel's count and last action must come from what actually happened.
    answer = ask(socket_path, {'protocolVersion': 'deepblend.blender/v1', 'jobId': 'panel-probe', 'action': 'get_capabilities'})
    readings['served'] = answer.get('status')
    readings['afterWork'] = draw_panel()

    bridge.unregister()
    readings['afterUnregister'] = draw_panel()
    readings['socketRemovedOnUnregister'] = not os.path.exists(socket_path)

    print(json.dumps(readings))
    return 0


if __name__ == '__main__':
    sys.exit(main())
