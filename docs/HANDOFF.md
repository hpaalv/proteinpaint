# Como continuar daqui — ProteinPaint

Escrito em 2026-10-22, no fim de uma sessão longa. Leia isto antes de `PLAN.md` e `STATUS.md`:
este documento diz **onde o trabalho parou, o que vem a seguir e quais armadilhas já custaram caro**.

---

## 1. Em uma frase

Fases 1 a 4 do `PLAN.md` estão entregues e verificadas; depois disso o usuário testou o app e
mandou uma lista grande de correções (`REVIEW.md`), da qual **seis lotes foram feitos** e falta
essencialmente **o bloco de Dados/painéis**. Nada está pela metade: o app compila, roda e passa
em todos os testes de ponta a ponta.

## 2. Rodar e testar

Repositório: **github.com/hpaalv/proteinpaint** (privado, branch `main`). O `gh` está em
`~/.local/bin/gh`, logado como `hpaalv`; autor dos commits com o e-mail noreply do GitHub.


```bash
cd ~/Downloads/app/protein_paint
source ../.toolchain/env.sh          # node/npm portáteis — sem isto, nada funciona
npm run typecheck                    # tsc -b --noEmit
npm run build                        # vite build → dist/
```

Abrir o app **sem prender o terminal** (foi assim que o usuário conseguiu, depois de duas
tentativas frustradas com `npm start`):

```bash
(setsid ./scripts/launch.sh >/tmp/proteinpaint.log 2>&1 &)
```

Testes de ponta a ponta (janela real, GPU real). Sempre com o prefixo de GPU:

```bash
export PP_GPU=nvidia __NV_PRIME_RENDER_OFFLOAD=1 \
  __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json
node_modules/electron/dist/electron scripts/selftestN.cjs <pasta-de-saída>
```

| script | cobre | duração |
|---|---|---|
| `selftest.cjs` | Fase 1: carga, seleção, estilo, cores, interface geométrica, export | ~1 min |
| `selftest2.cjs` | Fase 2: PyRosetta, APBS, KVFinder, MHCXGraph, pydssp, **colorir por métrica** | ~8 min |
| `selftest3.cjs` | Fase 3: 10 presets de visual, vistas canônicas, fade, footprint, PNG, vídeo | ~3 min |
| `selftest4.cjs` | Fase 4: modo Dados, 12 tipos de gráfico, painéis, exportação | ~2 min |
| `selftest5.cjs` | Correções: átomos/transparência, desfazer, rótulos, medidas, brilho, corte | ~1 min |
| `selftest6.cjs` | Interface: átomos das ligações, razões, protocolo Rosetta, cache | ~5 min |
| `selftest7.cjs` | Comparação: superpor por cadeia, medir outra, restaurar | ~1 min |
| `selftest8.cjs` | Lote 7: fechar, ↑/↓, hidrogênios, Explorar, SS da interface, clique no gráfico | ~1 min |

Os `.cjs` leem o `dist/`, então **rebuilde antes de rodar**. Os hooks de teste ficam em
`src/main.tsx`, sob `window.__pp` (só com `?selftest=1`).

## 3. Armadilhas do ambiente (já pagas)

- **O monitor externo é o primário** e recebe imagem pela NVIDIA via PRIME. O Electron centraliza
  janelas no primário, e abrir/fechar muitas janelas com WebGL nessa saída **congelou a imagem do
  monitor do usuário**. Por isso todos os `selftest*.cjs` criam a janela em `x: 0, y: 0`.
  Se travar: `DISPLAY=:0 xrandr --output HDMI-1-0 --off` e religar com
  `--mode 1920x1080 --rate 60 --pos 1920x0 --primary --right-of eDP-2` (atenção: `--pos` usa
  `1920x0`, não `1920+0`).
- **Nunca** capture a tela inteira ou a "janela em foco" para conferir o app: numa tentativa assim
  eu fotografei o navegador pessoal do usuário. Use `wmctrl -i -a <id>` para focar a janela do
  ProteinPaint e só então `gnome-screenshot -w`, ou melhor, use `capturePage()` dentro do próprio
  teste. `xdotool` **não** está instalado nesta máquina.
- GPU: só funciona via `scripts/launch.sh` (PRIME + EGL da NVIDIA + `--use-angle=gl-egl`).
  Avisos de `MESA-LOADER` e `No suitable EGL configs` no log são normais.

## 4. Mapa do código

```
src/engine/      tudo que toca Mol* (nenhum import de molstar fora daqui)
  viewer.ts      instância: canvas + estruturas + o Look atual
  style.ts       camadas (fita/átomos/superfície), pintura com replay, emissivo
  look.ts        visual como um valor só, com interpolação; gradientes via CSS
  labels.ts      rótulos com guia tracejada (texto em overlay 3D próprio)
  interface.ts   interações, átomos das ligações, razões por cadeia
  compare.ts     superposição e measureChains (RMSD de outra cadeia)
  history.ts     snapshot/restore para desfazer
  overlay.ts     malhas (linhas/esferas) e texto 3D
src/compute/     ponte com ppcore; protocol.ts = FastRelax + InterfaceAnalyzer com cache
src/dataset/     leitura da pasta de análise (CSV + estruturas)
src/panels/      modelo de figura: specs, tema, estatística, gráficos, exportação
src/ui/          painéis; src/ui/data/ é o modo Dados
ppcore/          servidor de jobs em Python (ver CLAUDE.md)
```

## 5. Convenções que não dá para violar

- Mol* só dentro de `src/engine/`; funções do engine recebem o `Viewer` e retornam `Result<T>`.
- **Nunca** use `useData(seletor)` com seletor que cria array/objeto novo — laço infinito de
  render (React #185). Derive com os hooks de `src/ui/data/hooks.ts`.
- Mude o visual por `applyLook`/`tuneLook`, nunca `canvas3d.setProps` direto.
- Antes de uma mutação que o usuário possa querer desfazer, chame `act(label, fn)` de
  `src/store/history.ts` (ele grava o estado e roda).
- Textos de UI em português; código e comentários em inglês, explicando o **porquê**.
- Verifique a API do Mol* em `node_modules/molstar/lib` antes de escrever a chamada (5.13.1 fixo).

## 6. Lições que custaram tempo (não repetir)

1. **Enquadrar antes da geometria existir** deixa a cena vazia ou a molécula do tamanho de um
   ponto. `resetView` e `canonicalView` esperam `reprCount > 0` e raio > 0 — mantenha isso em
   qualquer caminho novo de câmera.
2. **O rótulo do Mol* desloca o texto em espaço de tela**, então guia e texto nunca batem; por
   isso existe `pp-text-overlay` em `overlay.ts`.
3. **O passe de fundo do Mol* falha neste driver**: gradiente vira um triângulo preto. Gradientes
   são CSS atrás do canvas transparente, e compostos em 2D na exportação.
4. **Job que não responde trava o painel**: `awaitJob` tem limite de 20 min. Qualquer espera nova
   por job precisa de limite.
5. **Faixas de cor por mínimo/máximo mentem** em métricas de cauda longa. Use percentis (96%) e
   deixe a escolha visível (foi exatamente o "colorir por métrica não funciona").
6. **Zeros estruturais poluem a escala**: o InterfaceAnalyzer devolve zero para resíduos fora da
   interface; eles são filtrados antes de virar dataset.
7. Não use a classe CSS `collapse` (é utilitário do Tailwind 4): o componente é `Collapse` /
   `.pp-collapse`.

## 7. O que fazer a seguir

> 2026-10-23: lote 7 da revisão feito (ver STATUS). Pendentes dele: CDRs na renumeração IMGT
> (pergunta aberta) e o cenário em que o clique no gráfico falhou para o usuário. **Depois de cada
> bateria de testes rode `scripts/reset-monitor.sh`** (o monitor externo ainda congela às vezes).

A lista completa está em `REVIEW.md`. Ordem pedida pelo usuário, com o que sobrou:

### 7.1 Bloco de Dados e painéis (é o próximo, e o maior)

- Modo de **posicionamento livre** além da grade atual (manter as duas opções).
- **Largura de coluna e altura de linha** ajustáveis à mão, com um botão "voltar ao canônico".
- Selecionar **várias células com Ctrl** e exportar só elas, com **pré-visualização e edição**
  antes de salvar.
- **Heatmap com métricas de escalas diferentes**: cor = mínimo/máximo **por métrica** (normalizar
  por coluna), com a legenda deixando isso explícito. Quando tudo for da mesma unidade, manter
  como está. O `rampCenter` já existe; falta o modo por-coluna.
- **Rosetta no modo Dados**: acessar os resultados vindos do modo Estrutura, rodar nas estruturas
  abertas / em todas / numa seleção, e gráficos próprios do Rosetta.
- **Salvar sessão** tipo ChimeraX, que reabre exatamente onde parou (estruturas, visual, painéis,
  filtros). Isto conversa com a Fase 7 do `PLAN.md`.

### 7.2 Depois

- Comparação **visual**: colorir a estrutura pelo desvio e métricas lado a lado em gráfico
  (reaproveitar o motor de gráficos de `src/panels/`).
- Desfazer mútuo entre as demais ações (interface × estilo × dados calculados).
- Rótulos de medidas e do modo Explorar ainda usam o rótulo padrão do Mol*.

### 7.3 Pergunta aberta para o usuário

Ele disse que "muita coisa não funciona" nas Análises. Achei e consertei o **colorir por métrica**
(lote 6). Se ele apontar outro item específico, vá direto nele — caçar no escuro custa caro.
Essa pergunta está pendente de resposta.

## 8. Dados de teste

| caminho | o que é |
|---|---|
| `~/Downloads/analises/na1_binder_9_model_7.cif` | design pMHC-binder (A binder, B MHC, C peptídeo) |
| `~/Downloads/1a1m_mhc_all.pdb` | HLA-A2 — **só tem cadeias A e C** |
| `~/Downloads/7q15_mhc_complex.pdb` | complexo FcRn-like (a cadeia A sai como "binder" no fallback de papéis) |
| `data/pilot/pmhc_pkg/` (no repositório) | **dados piloto do modo Dados**: 152 designs, 34 colunas, 11 estruturas, 3 alvos |
| `data/reference/analysis_part1.py` | os gráficos Bokeh que servem de referência visual |

O funil do `NOTES.md` do pacote piloto (152 → 33 → 31 → 17 → 14 → 12 → 11) é reproduzido pelo app
e serve como teste de sanidade da leitura dos dados.

## 9. Como o usuário gosta de trabalhar

- Quer **ver funcionando**: entregue com captura de tela ou números de teste, não com promessas.
- Valoriza estética e fluidez tanto quanto a função; "bonito" é requisito, não enfeite.
- Prefere diagnóstico honesto a conserto apressado — quando medi o desempenho e descobri que já
  estava no teto do vsync, dizer isso foi melhor do que inventar uma otimização.
- Fala português; o app é em português.
