"""JSON-lines job server, spawned by the Electron main process.

    stdin   {"id": 1, "method": "submit", "params": {...}}
    stdout  {"id": 1, "result": ...} | {"id": 1, "error": "..."} | {"event": "job", "job": {...}}

Scheduling is per resource class, because the bottleneck differs by tool:
  rosetta  one process per job (~0.7 GB each): capped by free RAM and physical cores
  apbs     1–2 GB per process; the user's pipeline OOM-killed Xorg above 3 at once
  cpu      multithreaded tools (pyKVFinder, MHCXGraph): few at a time, many threads each
  light    TM-align and friends: one per core
  gpu      CUDA work (pydssp on torch): one at a time
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent
APP_PY = sys.executable
ROSETTA_PY = os.environ.get("PP_ROSETTA_PYTHON", "/home/paulo/anaconda3/envs/SE3nv/bin/python")
JOBS_DIR = Path(os.environ.get("PP_JOBS_DIR", str(Path.home() / ".cache" / "proteinpaint" / "jobs")))

# tool -> (interpreter, resource class)
TOOLS: Dict[str, tuple] = {
    "rosetta_interface": ("rosetta", "rosetta"),
    "rosetta_relax": ("rosetta", "rosetta"),
    "dssp": ("rosetta", "gpu"),
    "electrostatics": ("rosetta", "apbs"),
    "tmalign": ("app", "light"),
    "kvfinder": ("app", "cpu"),
    "mhcxgraph": ("app", "cpu"),
    "mhcx_renumber": ("app", "light"),
    "hydrogens": ("rosetta", "light"),
}

_out_lock = threading.Lock()


def send(msg: Dict) -> None:
    line = json.dumps(msg, default=str)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# ---------------------------------------------------------------------------
# Machine limits
# ---------------------------------------------------------------------------

def mem_available_gb() -> float:
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1024 / 1024
    except OSError:
        pass
    return 8.0


def physical_cores() -> int:
    try:
        cores = set()
        phys = core = None
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("physical id"):
                    phys = line.split(":")[1].strip()
                elif line.startswith("core id"):
                    core = line.split(":")[1].strip()
                    cores.add((phys, core))
        if cores:
            return len(cores)
    except OSError:
        pass
    return max(1, (os.cpu_count() or 2) // 2)


def compute_limits() -> Dict[str, int]:
    cores = physical_cores()
    threads = os.cpu_count() or cores
    ram = mem_available_gb()
    return {
        "rosetta": max(1, min(cores - 2, int(ram / 1.2))),
        "apbs": max(1, min(3, int(ram / 2.5))),
        "cpu": 2,
        "light": max(1, cores),
        "gpu": 1,
        "threads": threads,
        "cores": cores,
        "ram_gb": round(ram, 1),
    }


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------

def _probe(python: str, code: str) -> Optional[str]:
    try:
        out = subprocess.run([python, "-c", code], capture_output=True, text=True, timeout=120)
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def rosetta_bin_dir() -> str:
    return str(Path(ROSETTA_PY).parent)


def which(name: str) -> Optional[str]:
    return shutil.which(name, path=rosetta_bin_dir() + os.pathsep + os.environ.get("PATH", ""))


def capabilities() -> Dict:
    rosetta_ok = Path(ROSETTA_PY).exists()
    caps = {
        "app_python": APP_PY,
        "rosetta_python": ROSETTA_PY if rosetta_ok else None,
        "pyrosetta": _probe(ROSETTA_PY, "import pyrosetta,re;v=pyrosetta._version_string() if hasattr(pyrosetta,'_version_string') else '';m=re.search(r'(20\\d\\d\\.\\d+)', v);print(m.group(1) if m else 'ok')") if rosetta_ok else None,
        "pydssp": _probe(ROSETTA_PY, "import pydssp;print('ok')") if rosetta_ok else None,
        "torch_cuda": _probe(ROSETTA_PY, "import torch;print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')") if rosetta_ok else None,
        "apbs": which("apbs"),
        "pdb2pqr": which("pdb2pqr30") or which("pdb2pqr"),
        "tmalign": which("TMalign") or which("tmalign"),
        "usalign": which("USalign"),
        "mhcxgraph": _probe(APP_PY, "import importlib.metadata as m;print(m.version('MHCXGraph'))"),
        "pykvfinder": _probe(APP_PY, "import pyKVFinder;print(pyKVFinder.__version__)"),
        "limits": LIMITS,
        "jobs_dir": str(JOBS_DIR),
    }
    return caps


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

class Job:
    def __init__(self, tool: str, params: Dict, label: str, group: Optional[str]):
        self.id = uuid.uuid4().hex[:12]
        self.tool = tool
        self.params = params
        self.label = label or tool
        self.group = group
        self.state = "queued"
        self.progress = 0.0
        self.message = ""
        self.result = None
        self.error = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self.workdir = str(JOBS_DIR / self.id)
        self.proc: Optional[subprocess.Popen] = None
        self._last_emit = 0.0

    def public(self) -> Dict:
        return {
            "id": self.id,
            "tool": self.tool,
            "label": self.label,
            "group": self.group,
            "state": self.state,
            "progress": self.progress,
            "message": self.message,
            "result": self.result,
            "error": self.error,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "workdir": self.workdir,
            "params": self.params,
        }

    def emit(self, force: bool = True) -> None:
        now = time.time()
        if not force and now - self._last_emit < 0.2:
            return
        self._last_emit = now
        send({"event": "job", "job": self.public()})


class Scheduler:
    def __init__(self) -> None:
        self.jobs: Dict[str, Job] = {}
        self.queue: List[Job] = []
        self.running: Dict[str, int] = {k: 0 for k in ("rosetta", "apbs", "cpu", "light", "gpu")}
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.spare: Optional[subprocess.Popen] = None
        threading.Thread(target=self._loop, daemon=True).start()

    # -- worker processes -------------------------------------------------

    def _env(self, interpreter: str, threads: Optional[int]) -> Dict[str, str]:
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        env["PYTHONUNBUFFERED"] = "1"
        if interpreter == "rosetta":
            env["PATH"] = rosetta_bin_dir() + os.pathsep + env.get("PATH", "")
        if threads:
            for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
                env[k] = str(threads)
        return env

    def _spawn(self, interpreter: str, preload: bool, threads: Optional[int]) -> subprocess.Popen:
        python = ROSETTA_PY if interpreter == "rosetta" else APP_PY
        args = [python, "-u", "-m", "ppcore.worker"] + (["--preload", "rosetta"] if preload else [])
        return subprocess.Popen(
            args,
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env(interpreter, threads),
            text=True,
            bufsize=1,
            start_new_session=True,
        )

    def _ensure_spare(self) -> None:
        """Keeps one PyRosetta worker with the import already done (~1.5 s saved per job)."""
        if self.spare is None or self.spare.poll() is not None:
            try:
                self.spare = self._spawn("rosetta", True, 1)
            except OSError:
                self.spare = None

    # -- API ----------------------------------------------------------------

    def submit(self, tool: str, params: Dict, label: str, group: Optional[str]) -> Dict:
        if tool not in TOOLS:
            raise ValueError("Ferramenta desconhecida: " + tool)
        job = Job(tool, params, label, group)
        with self.lock:
            self.jobs[job.id] = job
            self.queue.append(job)
        job.emit()
        self.wake.set()
        return {"jobId": job.id}

    def cancel(self, job_id: str) -> Dict:
        job = self.jobs.get(job_id)
        if not job:
            raise ValueError("Job não encontrado")
        with self.lock:
            if job.state == "queued":
                self.queue.remove(job)
                job.state = "canceled"
                job.finished = time.time()
                job.emit()
                return {"ok": True}
        if job.state == "running" and job.proc:
            job.message = "Cancelado"
            job.state = "canceled"
            self._kill(job.proc)
        return {"ok": True}

    def _kill(self, proc: subprocess.Popen) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    # -- loop -----------------------------------------------------------------

    def _loop(self) -> None:
        if Path(ROSETTA_PY).exists():
            self._ensure_spare()
        while True:
            self.wake.wait(0.5)
            self.wake.clear()
            with self.lock:
                for job in list(self.queue):
                    resource = TOOLS[job.tool][1]
                    if self.running[resource] < LIMITS[resource]:
                        self.queue.remove(job)
                        self.running[resource] += 1
                        threading.Thread(target=self._run, args=(job, resource), daemon=True).start()

    def _run(self, job: Job, resource: str) -> None:
        interpreter = TOOLS[job.tool][0]
        threads = None
        if resource == "cpu":
            threads = max(1, LIMITS["threads"] // LIMITS["cpu"])
        elif resource in ("rosetta", "apbs", "light"):
            threads = 1
        job.params.setdefault("_threads", threads or LIMITS["threads"])
        try:
            if interpreter == "rosetta" and resource == "rosetta" and self.spare is not None and self.spare.poll() is None:
                proc, self.spare = self.spare, None
                self._ensure_spare()
            else:
                proc = self._spawn(interpreter, False, threads)
        except OSError as e:
            job.state = "error"
            job.error = "Não foi possível iniciar o worker: {}".format(e)
            job.finished = time.time()
            job.emit()
            self._release(resource)
            return

        job.proc = proc
        job.state = "running"
        job.started = time.time()
        job.emit()
        os.makedirs(job.workdir, exist_ok=True)
        with open(os.path.join(job.workdir, "params.json"), "w") as f:
            json.dump({"tool": job.tool, "params": job.params}, f, indent=2)

        log_path = os.path.join(job.workdir, "log.txt")
        log_file = open(log_path, "a", encoding="utf-8")

        def pump_stderr() -> None:
            for line in proc.stderr:  # type: ignore[union-attr]
                log_file.write(line)
            log_file.flush()

        threading.Thread(target=pump_stderr, daemon=True).start()

        timeout_min = float(job.params.get("timeout_min") or 0)
        if timeout_min > 0:
            timer = threading.Timer(timeout_min * 60, lambda: self._timeout(job))
            timer.daemon = True
            timer.start()
        else:
            timer = None

        try:
            proc.stdin.write(json.dumps({"tool": job.tool, "params": job.params, "workdir": job.workdir}) + "\n")  # type: ignore[union-attr]
            proc.stdin.flush()  # type: ignore[union-attr]
        except (BrokenPipeError, OSError):
            pass

        for line in proc.stdout:  # type: ignore[union-attr]
            try:
                ev = json.loads(line)
            except ValueError:
                log_file.write(line)
                continue
            kind = ev.get("type")
            if kind == "progress":
                job.progress = ev.get("value", job.progress)
                job.message = ev.get("message") or job.message
                job.emit(force=False)
            elif kind == "log":
                log_file.write("[log] " + str(ev.get("message")) + "\n")
                job.message = str(ev.get("message"))
                job.emit(force=False)
            elif kind == "result":
                job.result = ev.get("data")
            elif kind == "error":
                job.error = ev.get("message")
                log_file.write(ev.get("traceback") or "")

        code = proc.wait()
        if timer:
            timer.cancel()
        log_file.close()
        job.finished = time.time()
        job.proc = None
        if job.state == "canceled":
            pass
        elif job.result is not None and code == 0:
            job.state = "done"
            job.progress = 1.0
        else:
            job.state = "error"
            if not job.error:
                if code < 0:
                    job.error = "O processo morreu com o sinal {} (crash nativo, ex.: segfault do Rosetta).".format(signal.Signals(-code).name)
                else:
                    job.error = "O worker terminou com código {}. Veja o log.".format(code)
        job.emit()
        self._release(resource)

    def _timeout(self, job: Job) -> None:
        if job.state == "running" and job.proc:
            job.error = "Tempo limite de {} min excedido.".format(job.params.get("timeout_min"))
            job.state = "error"
            self._kill(job.proc)

    def _release(self, resource: str) -> None:
        with self.lock:
            self.running[resource] -= 1
        self.wake.set()

    def shutdown(self) -> None:
        for job in self.jobs.values():
            if job.proc:
                self._kill(job.proc)
        if self.spare:
            self._kill(self.spare)


LIMITS = compute_limits()


def main() -> int:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    sched = Scheduler()

    def on_term(_sig, _frame):
        # Workers run in their own sessions (so cancel can kill a whole group); take
        # them down with us or a Rosetta job would outlive the app.
        sched.shutdown()
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    send({"event": "ready", "limits": LIMITS})
    caps_cache: Dict = {}
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        try:
            if method == "capabilities":
                if not caps_cache:
                    caps_cache.update(capabilities())
                result = caps_cache
            elif method == "submit":
                result = sched.submit(params["tool"], params.get("params") or {}, params.get("label") or "", params.get("group"))
            elif method == "cancel":
                result = sched.cancel(params["jobId"])
            elif method == "jobs":
                result = [j.public() for j in sched.jobs.values()]
            elif method == "ping":
                result = "pong"
            else:
                raise ValueError("Método desconhecido: " + str(method))
            send({"id": rid, "result": result})
        except Exception as e:  # noqa: BLE001
            send({"id": rid, "error": str(e)})
    sched.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
