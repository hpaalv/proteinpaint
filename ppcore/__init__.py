"""ProteinPaint compute core: a JSON-lines job server and isolated per-job workers.

Code here must run on two interpreters: the PyRosetta env (Python 3.9) and the app
venv (Python 3.11, MHCXGraph / pyKVFinder). Keep it 3.9-compatible.
"""
