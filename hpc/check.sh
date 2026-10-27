#!/usr/bin/env bash
#SBATCH --job-name=pp-check
#SBATCH --partition=debug-cpu
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --time=00:10:00
#SBATCH --output=pp-check-%j.log
#
# Asks ppcore itself what it finds (tools, versions, CUDA, scheduling limits), so the
# check sees the environment exactly as the app will. Inside a job the limits must
# follow the job's allocation, not the node's.
#   bash hpc/check.sh  |  sbatch hpc/check.sh
#   sbatch --partition=short-gpu-big --gres=gpu:a100:1 hpc/check.sh   (CUDA)
set -euo pipefail

ROOT="$(git -C "${SLURM_SUBMIT_DIR:-$(dirname "${BASH_SOURCE[0]}")}" rev-parse --show-toplevel)"
# shellcheck source=hpc/env.sh
source "$ROOT/hpc/env.sh"
cd "$ROOT"

echo "node $(node --version) · npm $(npm --version) · $(python --version)"

echo '{"id": 1, "method": "capabilities"}' | PYTHONPATH="$ROOT" python -u -m ppcore.server | python -c '
import json, sys
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("id") != 1:
        continue
    if "error" in msg:
        sys.exit("ppcore: " + msg["error"])
    caps = msg["result"]
    for key, value in caps.items():
        print("{:16} {}".format(key, value))
    required = ("pyrosetta", "pydssp", "apbs", "pdb2pqr", "tmalign", "mhcxgraph", "pykvfinder")
    missing = [k for k in required if not caps.get(k)]
    if missing:
        sys.exit("FALTANDO: " + ", ".join(missing))
    print("OK")
    break
'
