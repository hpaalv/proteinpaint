#!/usr/bin/env bash
#SBATCH --job-name=proteinpaint
#SBATCH --partition=short-cpu
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=08:00:00
#
# The Slurm job behind `hpc/pp-hpc start`: runs the web server (server/main.cjs) on
# the allocated node until the time limit or `hpc/pp-hpc stop`. The compute core it
# starts schedules within this job's CPUs and memory (ppcore/server.py).
set -euo pipefail

ROOT="$(git -C "${SLURM_SUBMIT_DIR:-$(dirname "${BASH_SOURCE[0]}")}" rev-parse --show-toplevel)"
# shellcheck source=hpc/env.sh
source "$ROOT/hpc/env.sh"
cd "$ROOT"

STATE="$HOME/.cache/proteinpaint/server"
mkdir -p "$STATE" && chmod 700 "$STATE"

# After a `git pull` the bundle may be older than the sources: rebuild before serving.
if [ ! -f dist/index.html ] || [ -n "$(find src index.html package.json vite.config.ts -newer dist/index.html -print -quit)" ]; then
    echo "Código mais novo que dist/: recompilando..."
    npm run build
fi

PP_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export PP_TOKEN
export PP_HOST=0.0.0.0           # reached from the login node through the SSH tunnel
export PP_PORT=0                 # any free port: the node is shared
export PP_INFO_FILE="$STATE/${SLURM_JOB_ID:-local}.json"
export PP_TEMP_DIR="$HOME/.cache/proteinpaint/tmp"

# Not exec: the info file holds the token and must go when the job ends. On scancel the
# TERM is passed on so the server can take the compute core and its workers down.
node server/main.cjs &
pid=$!
trap 'kill -TERM $pid 2>/dev/null; wait $pid; rm -f "$PP_INFO_FILE"; exit 0' TERM INT
trap 'rm -f "$PP_INFO_FILE"' EXIT
wait $pid
