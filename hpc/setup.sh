#!/usr/bin/env bash
#SBATCH --job-name=pp-setup
#SBATCH --partition=short-cpu
#SBATCH --cpus-per-task=8
#SBATCH --mem=16G
#SBATCH --time=02:00:00
#SBATCH --output=pp-setup-%j.log
#
# Installs everything ProteinPaint needs on the HPC into .hpc/ (ignored by git):
# Node 22, the conda env of hpc/environment.yml, npm packages and the build.
# Safe to rerun: each step updates what changed. From the repository root:
#   bash hpc/setup.sh        (on the login node)
#   sbatch hpc/setup.sh      (as a job; log in pp-setup-<id>.log)
# To start from scratch: rm -rf .hpc && bash hpc/setup.sh
set -euo pipefail

NODE_VERSION=v22.23.4
CONDA_MODULE=conda/25.3.0

# Under sbatch the script runs from a spooled copy, so locate the repo from the submit dir.
ROOT="$(git -C "${SLURM_SUBMIT_DIR:-$(dirname "${BASH_SOURCE[0]}")}" rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .hpc

step() { printf '\n== %s\n' "$*"; }

step "Node $NODE_VERSION"
if [ "$(.hpc/node/bin/node --version 2>/dev/null)" != "$NODE_VERSION" ]; then
    tarball="node-$NODE_VERSION-linux-x64.tar.xz"
    url="https://nodejs.org/dist/$NODE_VERSION"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/$tarball" "$url/$tarball"
    curl -fsSL "$url/SHASUMS256.txt" | grep " $tarball\$" | (cd "$tmp" && sha256sum -c -)
    rm -rf .hpc/node && mkdir .hpc/node
    tar -xJf "$tmp/$tarball" -C .hpc/node --strip-components=1
    rm -rf "$tmp"
fi
.hpc/node/bin/node --version

step "Conda env (hpc/environment.yml)"
if ! command -v conda >/dev/null 2>&1; then
    # shellcheck disable=SC1091
    type module >/dev/null 2>&1 || source /etc/profile.d/modules.sh 2>/dev/null || source /etc/profile.d/lmod.sh
    module load "$CONDA_MODULE"
fi
if [ -x .hpc/env/bin/python ]; then
    conda env update --prefix .hpc/env --file hpc/environment.yml --prune
else
    conda env create --prefix .hpc/env --file hpc/environment.yml
fi

# shellcheck source=hpc/env.sh
source hpc/env.sh

step "npm packages + build"
# The Electron binary is useless here (no display): the HPC runs the web build only.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run build

step "Check"
bash hpc/check.sh
