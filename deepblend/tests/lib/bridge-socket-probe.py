"""Where a bridge listens, given what it knows — printed for the suite to assert on.

A separate file because the question is a pure function of the bridge's own rules, and asking it does
not need a socket, a server or a workspace on disk. What it must NOT do is re-derive the answer: it
calls the bridge's own `default_socket_for`, so a change to the convention changes this reading.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', '..', 'packages', 'deepblend', 'provider-local', 'python')))

import deepblend_bridge as bridge  # noqa: E402

print(json.dumps({
    "withWorkspace": bridge.default_socket_for(os.environ.get("DEEPBLEND_PROBE_WORKSPACE", "/w")),
    "withoutWorkspace": bridge.default_socket_for(""),
    "machineDefault": bridge.DEFAULT_SOCKET,
    "relative": bridge.WORKSPACE_SOCKET_RELATIVE,
}))
