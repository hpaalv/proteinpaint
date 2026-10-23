# ProteinPaint — Plano de execução

Visualizador molecular de desktop (Linux primeiro) para **quem faz design de proteínas**:
binders, interfaces proteína–proteína, triagem de designs e figuras de publicação, com
gráficos de métricas (AF2 initial guess, Rosetta, MPNN) ligados à estrutura 3D e montagem
de painéis direto no software.

> Herdeiro do **Helix** (`../helix`, app Android). O motor Mol\* do Helix já foi validado
> contra o Mol\* 5.13.1 (modelo de 3 camadas do ChimeraX, superposição matchmaker +
> TM-align, presets de luz, export) e é portado para cá como ponto de partida, mas
> reescrito como **instâncias** (um visualizador por painel) em vez de singleton.

---

## 1. O que o levantamento mostrou

**Fluxo real do usuário** (scripts em `~/Downloads`):

| Script / artefato | O que revela que o app precisa ter |
|---|---|
| `cdr_panels.py`, `make_movie_v2.py` (ChimeraX) | `lighting soft`, `material dull`, silhuetas 2 px `#303030`, fundo branco, transparência em **gradiente contínuo por distância à interface**, footprint do binder projetado na superfície do alvo, vistas derivadas da geometria de docking (não `view orient`), turntable com binders aparecendo em sequência, export 3000 px ×4 supersample, APNG transparente |
| `assemble_panel.py` | Painéis A/B/C a 300 dpi, fonte Arial 8 pt, PDF com fonttype 42, largura em mm — o compositor de painéis tem que sair nesse padrão |
| `2_count_contacts.py`, `pmhc_figures_final.py`, `pmhc_cutoff_sensitivity.py` | Contagem de contatos átomo pesado × átomo pesado com cutoff variável, por posição do peptídeo (P1–PΩ), por lado (binder/alvo), normalizada por tamanho |
| `README_rosetta.md` | Pipeline PyRosetta já estabelecido: FastRelax ref2015 ×5, `InterfaceAnalyzerMover` com `pack_separated`, Sc, packstat, hbonds, `delta_unsat_hbonds`, CMS; interface definida como string `AC_DE`; falhas conhecidas (ligantes HETATM → segfault) |
| `make_secstruc_adj.py` | Matrizes de adjacência de SSE (RFdiffusion fold conditioning) |
| `eletrostatico.png`, `contatos*.png`, `INTERFACE.png` | Figuras de eletrostática de superfície, contatos e interface que hoje saem do ChimeraX |
| `visualize-v3.py`, notebooks `pmhc_summary_4panels`, `rosetta_graficos_pub` | Gráficos (scatter, violino, heatmap) com paletas Okabe–Ito e estilo de publicação |

**Projeto `~/projetos/rocio`** (análise de 450+ complexos MHC–binder):

| Fonte | Decisão para o app |
|---|---|
| `2_giovanna/README_contacts.md` | Contato de interface = resíduo com **≥ 2 átomos a ≤ 4 Å** do parceiro (todos os átomos). É o padrão do app; cutoff e mínimo de átomos ajustáveis |
| `2_giovanna/README_electrostatics.md`, `electrostatics_pipeline.py` | Receita padrão de eletrostática: PDB2PQR 3.6 (PARSE, pH 7,4, PROPKA 3.5) → APBS `mg-auto`, focalização em 2 etapas, 0,15 M NaCl, εp 2 / εs 78,54, grade 2ⁿ+1 com ≤ 0,5 Å, `smol`, `spl2`; superfície colorida red:white:blue ±10 kT/e |
| `scripts/interface_analysis.py` + `process_one_pdb.py` | Rosetta roda **um subprocesso por estrutura** para sobreviver a segfault do C++ → o `ppcore` faz igual, com registro de crash e retomada |
| `scripts/script_chimera*.py`, `bfactor_by_gene_binder_class.py` | B-factor usado como portador de dados (frequência de contato %) com `palette` + `range` explícitos; ligantes em esferas semitransparentes; cartoon sem cadeias laterais |
| `video_traj/record_diffusion.py` | Trajetória de difusão: alinhar ao MHC de referência (matchmaker), esconder o MHC da trajetória, animar só o binder, gravar MP4/GIF |
| `plot_gabriel/heatmaps` (TM-score/RMSD por classe, medoide por TM-score médio) | Fase 4/5: matriz TM-score de um conjunto + escolha automática do medoide |

**Ambiente da máquina:** RTX 5060 (8 GB) + Intel UHD (híbrido), 24 threads, 15 GB RAM,
X11. `SE3nv` (Python 3.9) tem **PyRosetta 2026.05, pydssp, gemmi**. `TMalign` em
`/usr/local/bin`, ChimeraX instalado, Rust e Node 24 (em `../.toolchain`).

---

## 2. Arquitetura

```
┌──────────────────────────── Electron (Chromium) ─────────────────────────────┐
│ Renderer: React 18 + TS + Tailwind + Zustand                                 │
│   ├── ui/        layout desktop (árvore · viewport · inspetor · trilha seq.) │
│   ├── engine/    ÚNICA camada que importa molstar/*  — classe Viewer         │
│   ├── charts/    (Fase 4) gráficos ligados à seleção 3D                      │
│   └── compose/   (Fase 5) compositor de painéis                              │
│ Main process: janelas, diálogos nativos, FS, gerência do sidecar Python      │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ JSON-RPC (stdio), jobs com progresso e cancelamento
┌──────────────▼────────────── ppcore (Python, env SE3nv) ─────────────────────┐
│ PyRosetta · pydssp · TM-align/US-align · gemmi · APBS/PDB2PQR · numpy        │
│ resultados = anotações por resíduo/par → viram temas de cor e linhas no 3D   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Decisões

| Camada | Escolha | Por quê |
|---|---|---|
| Shell | **Electron 44** | Chromium tem o melhor WebGL2 do Linux e funciona bem com NVIDIA. Tauri usa WebKitGTK, que é bem mais lento em WebGL e tem problemas conhecidos com NVIDIA/DMABUF. Peso não é restrição. |
| GPU | Lançar com PRIME offload (`__NV_PRIME_RENDER_OFFLOAD=1`) | Notebook híbrido: sem isso o Chromium cai na Intel UHD. |
| Motor 3D | **Mol\* 5.13.1** headless | Mesmo motor validado no Helix. SSAO, sombras, outline, DOF, superfícies, interações, SASA, TM-align, medidas, trajetórias (DCD/XTC/TRR/NCTRAJ), PAE do ModelCIF. |
| UI | React 18 + TS strict + Tailwind 4 + Zustand | Igual ao Helix: reaproveita paletas, tokens e padrões. Layout trocado para desktop (mouse + teclado, painéis densos). |
| Cálculo | **Sidecar Python** no `SE3nv` via JSON-RPC por stdio | PyRosetta só existe em Python. Stdio evita porta de rede, morre junto com o app, e o processo é reaproveitado (o `init()` do PyRosetta custa ~5 s). Pool de workers para lote. |
| Gráficos | **Apache ECharts 6** (canvas para interação, SVG para export) | Milhares de pontos com brushing, heatmap de PAE 1000×1000, temas customizáveis, export vetorial. |
| Painéis | Um `Viewer` (PluginContext) por painel 3D | Chromium suporta ~16 contextos WebGL; painéis congelados viram imagem para passar disso. Câmeras sincronizáveis. |

### Regras herdadas do Helix que continuam valendo

1. **Nenhum import de `molstar/*` fora de `src/engine/`.** A UI fala vocabulário de proteína.
2. Funções do engine retornam `Result<T>`, nunca lançam.
3. Cores de molécula só em `src/data/palettes.ts`; cores de UI só em `src/ui/theme/`.
4. Nada de stub/placeholder: o que não existe aparece como "chega na fase N".
5. Verificar a API do Mol\* no `node_modules` antes de escrever a chamada.

### Onde cada coisa roda (GPU × CPU)

O critério é simples: o que é paralelo por pixel ou por vértice vai pra GPU; o que é
paralelo por estrutura ou por job vai pros 24 threads da CPU; a thread de UI só orquestra.

| Trabalho | Onde | Como |
|---|---|---|
| Renderização, SSAO, sombras, outline, DOF, transparência | **GPU NVIDIA** | Chromium com `ignore-gpu-blocklist`, ANGLE/GL, rasterização na GPU; PRIME offload no lançamento; contexto WebGL2 com `powerPreference: 'high-performance'`; multisample temporal (qualidade cheia quando a câmera para) |
| Superfície gaussiana, marching cubes | **GPU** | Caminho `useGpu` do Mol\* (WebGL compute via render-to-texture) ligado por padrão |
| Superfície molecular (SES), SASA, interações, DSSP do Mol\* | CPU, fora do caminho do render | Tasks assíncronas do Mol\* com progresso, sem travar a UI; cache por estrutura |
| Ler arquivo, gunzip, varrer pasta de designs | **CPU, processo main (Node)** | `fs` + `zlib` nativos, em paralelo, nunca na thread de UI |
| PyRosetta (relax, IAM, energia por resíduo) | **CPU, pool de processos** | `ppcore` com N workers = núcleos físicos − 2; um job por estrutura; PyRosetta não usa GPU |
| TM-align / US-align, contatos, pydssp em lote | **CPU, pool** | Binários e numpy vetorizado em paralelo por par/estrutura |
| pydssp em lote grande, futuras redes (ESM, AF2, ProteinMPNN) | **GPU via PyTorch/CUDA** quando disponível | `torch.cuda` detectado no env; cai para CPU com aviso |
| APBS | CPU (multithread) | Um job por estrutura no pool |
| Gráficos com milhares de pontos | GPU (canvas/WebGL do ECharts) | SVG só no export |
| Painéis com muitas estruturas | GPU, contextos compartilhados com teto | Painéis inativos congelados em imagem |

---

## 3. Fases

Ordem pedida: **visualização bruta → cálculos (PyRosetta, TM-align…) → estética**,
seguida de dados/gráficos, painéis e trajetórias.

### Fase 1 — Núcleo de visualização molecular ✅ (2026-10-21)

**Fundação**
- Projeto Electron + Vite + React + TS em `protein_paint/`; `npm run dev` (hot reload) e `npm start`.
- Script de lançamento com offload NVIDIA; flags de GPU do Chromium.
- Engine como classe `Viewer` (vários por janela no futuro), porta do engine do Helix.

**Carregamento**
- Abrir arquivos (diálogo nativo, multi), **pasta inteira de designs**, arrastar e soltar.
- PDB/mmCIF/BinaryCIF, `.gz`, detecção por conteúdo; fetch RCSB e AlphaFold DB.
- Sem o limite de 5 do celular (aviso só acima de ~50).
- Multi-modelo: seletor de modelo/frame (ensembles RFdiffusion, NMR).

**Árvore de estruturas (painel esquerdo)**
- Estrutura → cadeias, com papel (binder/alvo/MHC/β2m/peptídeo, heurística do Helix, editável).
- **Renomear** estrutura e cadeia (alias de exibição), visibilidade, foco, remover, cor da cadeia.

**Representações** (modelo de 3 camadas do ChimeraX, por estrutura/cadeia/seleção)
- Fita: cartoon, tubo, backbone, putty (espessura por B-factor/pLDDT).
- Átomos: sticks, bola-vareta, esferas, linhas; só cadeias laterais quando há fita.
- Superfície: molecular / gaussiana, opacidade por seleção.

**Cor**
- Cadeia, estrutura, uniforme, estrutura secundária, elemento, **B-factor** (rampa
  viridis/cividis/magma/divergente, min/max ajustáveis, barra de escala), **pLDDT** (AFDB),
  hidrofobicidade, carga do resíduo, arco-íris N→C, nome do resíduo.
- Pintar seleção com swatch/color picker; transparência por seleção.

**Seleção**
- Clique (resíduo/átomo/cadeia), Shift = adicionar, Ctrl = alternar; clique duplo foca.
- **Linha de comando de seleção estilo ChimeraX** (`/B:30-45`, `/A,C`, `:TYR,PHE`, `@CA`,
  `sel @<5`), porque quem vem do ChimeraX pensa assim.
- Por cadeia, faixa, tipo, ao redor de N Å, inverter, expandir, booleanos.
- **Trilha de sequência** inferior, uma linha por cadeia, colorida pelo esquema ativo,
  clique/arraste seleciona, sincronizada com o 3D nos dois sentidos.

**Medidas e rótulos**
- Distância, ângulo, diedro (modo de medida: clicar átomos), lista removível.
- Rótulos de resíduo na seleção.

**Interface (visual, cálculo nativo do Mol\*)**
- Interações não-covalentes entre cadeias (H-bond, ponte salina, hidrofóbico, π–π,
  cátion–π, halogênio, metal) como tracejados, **filtradas para a interface** entre os
  papéis escolhidos; "mostrar só interface" em um clique.

**Comparação**
- Superposição por sequência (matchmaker com poda) e por estrutura (TM-align nativo),
  relatório RMSD/TM-score, restaurar coordenadas.

**Cena (o básico — o estúdio completo é a Fase 3)**
- Presets Flat/Simple/Soft/Full/Studio/Cinematic, ajuste fino de luz/AO/contorno/névoa,
  fundo sólido/gradiente/transparente, orto/perspectiva, clipping, spin/rock.
- Export PNG em alta resolução (300 dpi por largura em mm), transparente, recorte.

**Aceite:** abrir a pasta `analises/` + um complexo pMHC-binder, renomear as estruturas,
superpor, mostrar sticks + H-bonds só na interface com o alvo em superfície
semitransparente, medir uma distância e exportar um PNG de 300 dpi — sem tocar no ChimeraX.

### Fase 2 — Cálculos integrados (`ppcore`) + MHCXGraph + KVFinder ✅ (2026-10-22)

| Módulo | Ferramenta | Saída no app |
|---|---|---|
| Interface Rosetta | `InterfaceAnalyzerMover` (pack_separated, Sc, packstat, hbonds) | Cartões dG, dSASA, Sc, dG/dSASA, packstat, ΔUnsat, nº H-bonds |
| H-bonds Rosetta | `HBondSet` da pose (energia por ligação) | Tracejados com espessura ∝ energia; lista ordenável; tipo bb–bb/bb–sc/sc–sc |
| Unsats enterrados | `BuriedUnsatHbonds` | Esferas vermelhas nos polares insatisfeitos |
| Energia por resíduo | `per_residue_energies`, decomposição de pares na interface | Cor por energia, hotspots (ΔΔG por alanine scan opcional) |
| CMS | `ContactMolecularSurface` | Métrica + coloração da área de contato |
| Relax | `FastRelax` ref2015 (com/sem constraints), em fila com progresso | Estrutura relaxada carregada ao lado da original, RMSD |
| Estrutura secundária | **pydssp** (e DSSP do Mol\* como fallback) | Atribuição consistente com os pipelines de design |
| Alinhamento | **TM-align / US-align** (binário), multi-cadeia | TM-score normalizado pelos dois lados, superposição aplicada |
| Contatos | numpy/gemmi, cutoff variável, átomos pesados (como `2_count_contacts.py`) | Mapa de contatos resíduo×resíduo, contagem por posição do peptídeo |
| SASA / BSA | Mol\* (rápido) e Rosetta (consistente com IAM) | ΔSASA por resíduo, cor por enterramento |
| Eletrostática | **PDB2PQR + APBS** | Potencial projetado na superfície (escala ±5 kT/e) |
| Lote | pool de processos | Rodar tudo numa pasta de designs → tabela |

Robustez: limpeza automática de HETATM problemáticos (ABA etc., aprendido no README_rosetta),
timeout por job, mensagens de erro do Rosetta legíveis, cache por hash do arquivo.

### Fase 3 — Estúdio estético ✅ (2026-10-22)

- Presets por intenção: *ChimeraX soft* (o seu padrão: soft + dull + silhueta 2 px),
  *Goodsell/ilustrativo* (tema `illustrative` + outline forte), *Glossy*, *Clay*,
  *Pôster escuro*, *Figura branca*.
- Luzes: múltiplas direcionais com cor/ângulo, ambiente, especular; materiais por
  representação (metalness/roughness/bumpiness do Mol\*).
- SSAO multi-escala, sombras, **DOF**, névoa, contorno com cor e espessura, interior de
  superfície cortada.
- **Transparência em gradiente por distância** a uma seleção (o efeito do `cdr_panels.py`).
- Footprint de um binder projetado na superfície do alvo (color zone).
- Vistas canônicas derivadas da geometria (eixo de docking, eixo do peptídeo).
- Export: PNG até o limite da GPU com supersampling, **turntable em MP4/APNG/GIF**,
  sequência de frames transparente.
- Biblioteca de estilos salvos ("meu estilo de figura") aplicável a qualquer estrutura.

### Fase 4 — Dados de design integrados ✅ (2026-10-22)

- Leitura de saídas: **AF2 initial guess** (`.sc`/`.json`: pLDDT, i_pae, pae_interaction,
  binder_aligned_rmsd, ipTM), ColabFold/AF3 JSON (PAE, pLDDT), RFdiffusion (`.trb`,
  contigs, hotspots), ProteinMPNN/LigandMPNN (`.fa` com scores), Rosetta score files,
  CSVs arbitrários.
- **Tabela de designs** (milhares de linhas, filtros, ordenação) ligada a scatter,
  histograma, violino; clicar num ponto abre o design; brushing filtra a tabela.
- **Matriz PAE** interativa: célula → destaca o par no 3D; bloco inter-cadeia marcado.
- Gráficos por resíduo sincronizados com a trilha de sequência (pLDDT, energia, SASA, contatos).
- Funis de filtragem (ex.: pae_interaction < 10 ∧ pLDDT > 85 ∧ dG < −40).

### Fase 5 — Painéis e figuras

- Compositor em grade: painéis 3D (cada um um `Viewer`), gráficos e texto.
- Estruturas **lado a lado alinhadas**, câmeras ligadas, mesmo estilo replicado.
- Letras de painel (A, B, C), legendas automáticas (barra de cor, chaves de interação).
- Export PNG/SVG/PDF com largura em mm e dpi (padrão do `assemble_panel.py`: Arial 8 pt).

### Fase 6 — Trajetórias

- Ensembles multi-modelo e trajetórias do RFdiffusion (pX0) com player.
- MD: DCD/XTC/TRR/NCTRAJ sobre topologia (nativo do Mol\*), RMSD/RMSF por frame,
  interface ao longo do tempo (nº de H-bonds × frame).
- Morph entre dois estados.

### Fase 7 — Projeto, sessões e empacotamento

- Projeto = pasta com sessão (estado Mol\* + metadados), anotações, resultados de cálculo.
- Recentes com miniatura, autosave, restauração.
- AppImage/deb; checagem do env Python no primeiro boot.

---

## 4. Riscos

| Risco | Mitigação |
|---|---|
| Chromium usar a iGPU | Script de lançamento com PRIME offload; mostrar a GPU ativa na barra de status |
| PyRosetta lento/crashando em ligantes | Worker isolado por job, timeout, limpeza de HETATM, reportar o erro |
| SE3nv é Python 3.9 | `ppcore` escrito compatível com 3.9 |
| Muitos contextos WebGL nos painéis | Congelar painéis inativos em imagem |
| API do Mol\* mudar | Fixar 5.13.1; tudo isolado em `engine/` |
