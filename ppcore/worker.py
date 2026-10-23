"""Runs exactly one job, then exits.

    python -m ppcore.worker [--preload rosetta]

Reads one JSON line {"tool", "params", "workdir"} from stdin. One process per job
isolates native crashes (Rosetta segfaults on some ligands — see
~/projetos/rocio/2_giovanna/scripts/interface_analysis.py) and lets each job pass
its own init flags. With --preload the heavy import happens before the job
arrives, so a warm spare worker starts instantly.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import traceback

from . import protocol


def main() -> int:
    protocol.open_channel()
    if "--preload" in sys.argv:
        what = sys.argv[sys.argv.index("--preload") + 1]
        if what == "rosetta":
            import pyrosetta  # noqa: F401 — warm import only
    protocol.emit("ready")

    line = sys.stdin.readline()
    if not line:
        return 0
    job = json.loads(line)
    tool = job["tool"]
    workdir = job["workdir"]
    os.makedirs(workdir, exist_ok=True)
    os.chdir(workdir)
    try:
        module = importlib.import_module("ppcore.tools." + tool)
        result = module.run(job.get("params") or {}, workdir)
        protocol.emit("result", data=result)
        return 0
    except Exception as e:  # noqa: BLE001 — every failure must reach the UI as text
        protocol.emit("error", message=str(e) or e.__class__.__name__, traceback=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
