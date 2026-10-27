# ProteinPaint

Visualizador molecular de desktop para design de proteínas — binders, interfaces pMHC e figuras.
Electron + React + Mol* (5.13.1), com cálculos em Python (PyRosetta, APBS/PDB2PQR, pydssp,
TM-align, MHCXGraph, pyKVFinder) num servidor de jobs local (`ppcore/`).

## Rodar

```bash
source ../.toolchain/env.sh     # node/npm portáteis (ou um Node 22+ do sistema)
npm install
npm run build
(setsid ./scripts/launch.sh >/tmp/proteinpaint.log 2>&1 &)   # GPU NVIDIA via PRIME + EGL
```

Desenvolvimento: `npm run dev` (Vite na porta 5273). Venv dos cálculos: ver `CLAUDE.md`.

## HPC (Slurm)

Tudo o que o app precisa (Node 22, um env conda com PyRosetta, APBS, PDB2PQR, TM-align,
MHCXGraph, pyKVFinder, pydssp/torch e ffmpeg) é instalado em `.hpc/` (fora do git), com
versões fixas em `hpc/environment.yml`. Da raiz do repositório:

```bash
sbatch hpc/setup.sh             # instala/atualiza (ou: bash hpc/setup.sh); log em pp-setup-<id>.log
sbatch hpc/check.sh             # confere ferramentas e limites dentro de um job
source hpc/env.sh               # node/npm/python do app na shell atual
```

Para recomeçar do zero: `rm -rf .hpc && sbatch hpc/setup.sh`.

## Onde ler

- `docs/HANDOFF.md` — onde o trabalho parou e o que vem a seguir
- `docs/PLAN.md` — fases · `docs/STATUS.md` — o que foi feito e verificado · `docs/REVIEW.md` — correções pedidas
- `CLAUDE.md` — regras do código

## Dados

`data/pilot/pmhc_pkg/` — dados piloto do modo Dados (152 designs pMHC NRAS Q61K, 11 estruturas,
3 alvos), usados por `scripts/selftest4.cjs` e `selftest8.cjs`. `data/reference/analysis_part1.py`
— os gráficos Bokeh de referência visual.
