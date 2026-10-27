# Source this to use ProteinPaint's HPC toolchain (installed by hpc/setup.sh into .hpc/):
#   source hpc/env.sh
# Plain PATH setup, no `conda activate`: it works the same in a login shell, in an
# sbatch script and in processes spawned by the app.

PP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PP_ROOT
export PATH="$PP_ROOT/.hpc/node/bin:$PP_ROOT/.hpc/env/bin:$PATH"

# ppcore: one interpreter for both worker kinds (see hpc/environment.yml).
export PP_APP_PYTHON="$PP_ROOT/.hpc/env/bin/python"
export PP_ROSETTA_PYTHON="$PP_APP_PYTHON"
export PP_JOBS_DIR="${PP_JOBS_DIR:-$HOME/.cache/proteinpaint/jobs}"
