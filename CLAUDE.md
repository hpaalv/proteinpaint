# ProteinPaint

Visualizador molecular de desktop para design de proteínas (binders, interfaces, figuras).

**Começando uma sessão nova? Leia `docs/HANDOFF.md` primeiro** — diz onde o trabalho parou, o que
fazer a seguir e quais armadilhas já custaram caro. Depois: `docs/PLAN.md` (fases),
`docs/STATUS.md` (o que foi feito e verificado) e `docs/REVIEW.md` (lista de correções do usuário,
com o que falta).

## Regras

- Nenhum import de `molstar/*` fora de `src/engine/`. A UI importa só de `@/engine`.
- Funções do engine recebem o `Viewer` e retornam `Result<T>`; não lançam.
- Verifique a API do Mol* em `node_modules/molstar/lib` antes de escrever a chamada (versão fixa 5.13.1).
- Cores de molécula em `src/data/palettes.ts`; tokens de UI em `src/styles.css`.
- Sem stubs: o que não existe aparece como "Fase N".
- Diagnostique a causa raiz antes de corrigir; registre em `docs/STATUS.md`.
- Textos de UI em português; código e comentários em inglês, comentários explicam o porquê.

## Comandos

```bash
source ../.toolchain/env.sh
npm run typecheck
npm run build
npm run dev        # porta 5273 (a 5199 é do Helix)
```

Teste de ponta a ponta com GPU real: ver `docs/STATUS.md` (`scripts/selftest.cjs`, `selftest2.cjs`, `selftest3.cjs`).

## GPU

Rodar sempre via `scripts/launch.sh` (PRIME offload + EGL da NVIDIA + `--use-angle=gl-egl`).
O offload por GLX quebra o WebGL do Chromium nesta máquina.

## Visual e UI

- O visual da cena é um `Look` (`src/engine/look.ts`); mude-o por `applyLook`/`tuneLook`, nunca com
  `canvas3d.setProps` direto, senão a transição e os presets saem de sincronia.
- Gradientes de fundo são CSS atrás do canvas transparente (o passe de fundo do Mol* falha neste driver).
- Animações de UI: só `transform`/`opacity`; nada que mude o tamanho do canvas durante a animação.
- Tokens de movimento em `src/styles.css` (`--ease`, `--ease-spring`, `--dur*`). Não use a classe
  `collapse` (é utilitário do Tailwind 4); o componente é `Collapse` / `.pp-collapse`.

## Dados e painéis (Fase 4)

- `src/dataset/` lê a pasta (CSV + estruturas); `src/panels/` é o modelo de figura (specs, tema,
  estatística, construtores de gráfico, exportação); `src/ui/data/` é a interface do modo Dados.
- Novo tipo de gráfico: adicionar em `ChartType` + `CHART_TYPES` (`src/panels/types.ts`), um
  `buildX` em `src/panels/charts.ts` e os controles em `ChartMenus` (`DataInspector.tsx`).
- **Nunca** use `useData(seletor)` com seletor que cria array/objeto novo (laço de render, React
  #185): derive com os hooks de `src/ui/data/hooks.ts`.
- Testes: `scripts/selftest4.cjs` (dados piloto em `data/pilot/pmhc_pkg`).

## Janelas de teste e monitor

As janelas dos `selftest*.cjs` abrem fixas em `x: 0, y: 0` (tela do notebook). O monitor externo é
o primário e recebe imagem por PRIME; ciclar janelas de GPU nele congelou a saída. Ver `docs/STATUS.md`.

## Cálculos (ppcore)

- `ppcore/server.py` roda no venv do app (`.pyenv`, Python 3.11: MHCXGraph 1.0, pyKVFinder 0.9.5,
  gemmi). Cada job é um **processo próprio** (`ppcore/worker.py`), no interpretador da ferramenta:
  `SE3nv` (Python 3.9: PyRosetta 2026.05, pydssp+torch CUDA, APBS, pdb2pqr) ou o venv.
  Código em `ppcore/` precisa ser compatível com Python 3.9.
- Agendamento por classe de recurso (`TOOLS` em server.py): rosetta (limitado por RAM livre),
  apbs (≤ 3: o OOM-killer derrubou o Xorg no pipeline do usuário), cpu, light, gpu.
- Nova ferramenta: `ppcore/tools/<nome>.py` com `run(params, workdir) -> dict`, registrar em
  `TOOLS`, tipos e padrões em `src/compute/types.ts`, parâmetros em `src/ui/analysis/specs.ts`,
  aplicação na cena em `src/compute/apply.ts`, visualização em `src/ui/analysis/views/`.
- Testar uma ferramenta isolada: `echo '{"tool":…,"workdir":…,"params":…}' | PYTHONPATH=. <python> -m ppcore.worker`.
- Testes de ponta a ponta: `scripts/selftest.cjs` (visualização) e `scripts/selftest2.cjs` (cálculos).
- No HPC (Slurm) um env conda só (`hpc/environment.yml`, em `.hpc/env`) faz os dois papéis;
  `source hpc/env.sh` aponta `PP_APP_PYTHON`/`PP_ROSETTA_PYTHON` para ele. Dentro de um job os
  limites do agendador vêm da alocação do Slurm, não do nó (`slurm_allocation` em server.py).
  Mudou dependência? Fixe a versão em `hpc/environment.yml` e rode `sbatch hpc/setup.sh`.
- Recriar o venv: `/home/paulo/anaconda3/bin/python3 -m venv .pyenv && .pyenv/bin/pip install MHCXGraph==1.0.0 pyKVFinder==0.9.5 gemmi`.
