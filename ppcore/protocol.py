"""Worker → server event channel.

PyRosetta, APBS and friends print banners and logs to stdout, including from C++.
The worker therefore duplicates the original stdout into a private file descriptor
for protocol messages and points fd 1 at stderr, so nothing a library prints can
corrupt the JSON stream.
"""

from __future__ import annotations

import json
import os
import sys
import time

_channel = None


def open_channel() -> None:
    global _channel
    if _channel is not None:
        return
    sys.stdout.flush()
    fd = os.dup(1)
    os.dup2(2, 1)
    _channel = os.fdopen(fd, "w", buffering=1, encoding="utf-8")
    sys.stdout = sys.stderr


def emit(kind: str, **payload) -> None:
    msg = {"type": kind, "t": time.time()}
    msg.update(payload)
    line = json.dumps(msg, default=_default)
    if _channel is None:
        print(line, flush=True)
    else:
        _channel.write(line + "\n")
        _channel.flush()


def progress(value: float, message: str = "") -> None:
    emit("progress", value=max(0.0, min(1.0, float(value))), message=message)


def log(message: str) -> None:
    emit("log", message=message)


def _default(o):
    try:
        import numpy as np  # noqa: WPS433 — optional dependency

        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    if isinstance(o, (set, tuple)):
        return list(o)
    return str(o)
