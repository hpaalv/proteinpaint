# Estado do projeto

## 2026-10-27 — Modo HPC (Slurm): servidor web + túnel SSH

### O que entrou

1. **Instalação reprodutível** (`hpc/environment.yml`, `hpc/setup.sh`): Node 22 + um env conda
   só (Python 3.11) com PyRosetta 2026.39 fixado por URL, APBS, PDB2PQR, TM-align, MHCXGraph,
   pyKVFinder, pydssp/torch e ffmpeg, tudo em `.hpc/`. `hpc/check.sh` pergunta ao ppcore.
2. **Limites do Slurm no ppcore**: dentro de um job, CPUs/RAM vêm da alocação
   (`slurm_allocation`), não do nó (256 threads, 1–2 TB): sem isso o agendador abriria dezenas de
   workers Rosetta num job de 8 CPUs e o Slurm o mataria por memória.
3. **`backend/`**: arquivos, ffmpeg e cliente do ppcore saíram de `electron/` para módulos sem
   Electron; `electron/ipc.cjs` e `core.cjs` só embrulham os diálogos nativos.
4. **`server/main.cjs`**: serve `dist/` e a mesma superfície do preload em `/api` (JSON, bytes de
   estrutura, SSE para jobs, quadros de vídeo). Token → cookie HttpOnly/SameSite=Strict; POST
   exige `X-PP`; caminhos confinados a `PP_ROOTS` depois de `realpath`; HTML gerado com CSP sandbox.
5. **`src/platform/web.ts`** instala um `window.pp` sobre HTTP quando a página vem do servidor
   (marca `<meta name="pp-web">`), então o resto do app não muda. Diálogos nativos viram
   `src/ui/files/FileDialog.tsx` (abrir/pasta/salvar/navegar; salvar oferece "baixar no meu
   computador"; abrir aceita arquivos locais).
6. **`hpc/pp-hpc start|status|stop`** submete `hpc/serve.sh` (recompila se `src/` mudou), espera
   o nó e imprime o túnel `ssh -N -L 5273:<nó>:<porta>` e a URL com token.

### Corrigido no caminho

- **PyRosetta 2026.3x removeu `InterfaceAnalyzerMover(str)`**: interface e FastRelax com análise
  falhavam com "incompatible constructor arguments". Agora `InterfaceAnalyzerMover()` +
  `set_interface(str)` (forma do BindCraft, vale para versões antigas).

### Verificado

- 9/9 ferramentas pelo worker dentro de um job `short-cpu` (TM-align, IMGT, MHCXGraph, FastRelax,
  KVFinder, DSSP, hidrogênios, APBS, interface Rosetta).
- Servidor: 401 sem token, 403 para `/etc`, `..`, symlink para fora, escrita fora do home, POST sem
  `X-PP`; leitura de estrutura byte a byte; job TM-align por HTTP com eventos SSE; MP4 via ffmpeg;
  `kill` do servidor leva o ppcore junto.
- `pp-hpc start` real (job no `c001marvin`) + Chromium headless (SwiftShader) pelo nó: abrir
  estrutura pelo diálogo, 3D, diálogo de salvar, KVFinder disparado do navegador (14 cavidades
  via SSE), modo Dados com o piloto (152 designs). Zero erros de console.
- Electron: os 17 handlers de IPC registram e respondem com um `electron` simulado (o binário não
  existe no HPC). **Falta rodar os `selftest*.cjs` no notebook.**

### Conhecido, não resolvido

- Vídeo no modo web manda RGBA cru pelo túnel (≈8 MB por quadro em 1080p): funciona, mas é lento.
- `torch_cuda` só foi conferido na CPU; o job de GPU esperava fila de A100.

## 2026-10-23 — Revisão, lote 7: fechar, níveis de seleção, hidrogênios, Explorar, SS da interface

### O que entrou

1. **Fechar uma estrutura leva tudo o que é dela.** Overlays (guias e textos dos rótulos, linhas
   de interação, H-bonds/insatisfeitos do Rosetta, medida entre seleções) moram na raiz do estado,
   não sob a estrutura, e as medidas do Mol* num grupo próprio com `dependsOn`. Agora cada item de
   overlay carrega `owners` (ids das estruturas) e `removeStructure` poda overlays, medidas,
   rótulos do Mol*, cavidades e potencial antes de apagar a trajetória; `closeStructure` (store)
   ainda esquece o relatório de interface e as superposições que apontam para ela.
2. **↑/↓ como no ChimeraX** (`promoteSelection`/`demoteSelection`): resíduo → hélice/fita/alça
   (DSSP do Mol*, andando ao longo da cadeia enquanto a chave do elemento é a mesma) → cadeia →
   estrutura → todas. Pula o nível que não acrescenta átomos. ↓ volta pelo histórico; um clique
   no meio zera o histórico. Sem seleção, ↑/↓ continuam navegando a biblioteca; PgUp/PgDn sempre
   navegam.
3. **Adicionar hidrogênios** (`ppcore/tools/hydrogens.py`): PDB2PQR + PROPKA no pH escolhido (o
   pipeline do APBS do usuário). B-factors (pLDDT) copiados átomo a átomo, H herda o Cα; ligantes
   devolvidos. A versão com H **substitui** a estrutura (como o `addh`), com nomes, papéis e cores
   de cadeia. Caixinha "Mostrar hidrogênios / incluir apolares" nos painéis Interface e Rosetta
   (`setHydrogenDisplay`, vale para camadas de átomos, átomos da interface e vizinhança).
   Medido: 2016 H no design em ~1 s.
4. **Cadeias laterais da interface na cor da cadeia** (`chainCarbonTheme`): carbono pelo esquema
   da estrutura (o que a fita mostra), heteroátomos por elemento; repinta quando a cor muda.
5. **Trilha de sequência**: fixa / recolhida (flutua sobre a cena e sobe ao passar o mouse na
   borda; só `transform`, o canvas não muda de tamanho) / desligada, lembrada entre sessões.
6. **Explorar sem "parede invisível"** — causa raiz: o foco do Mol* grava o raio do resíduo focado
   em `camera.state.radius`, e os planos near/far saem desse raio (`updateClip` em
   `mol-canvas3d/camera.js`): tudo na frente do resíduo e além da vizinhança era cortado, e só
   "resetar vista" desfazia. `unclipFocus` envolve `getFocus/getInvariantFocus/getCenter` da
   câmera: o foco aproxima, mas o raio de corte é o da cena (ou o do corte de profundidade do
   usuário). Sair do Explorar ou Esc também restauram o raio.
7. **Estrutura secundária da interface** (`interfaceSecondaryStructure` + `InterfaceSsView`):
   resíduos da interface (≥ 2 átomos a ≤ 4 Å) com hélice/fita/alça (pydssp quando rodou, senão
   DSSP do Mol*), comparando todas as estruturas carregadas: painéis Binder | Peptídeo | MHC (ou
   binder × alvo), barras 100% ou contagem, clique seleciona os resíduos, CSV. Abre pelo botão na
   ferramenta pydssp, sem precisar rodar nada.
8. **Modo Dados**: a célula 3D com "interface" mostra também as cadeias laterais; duplo clique num
   ponto abre o design no modo Estrutura. O clique simples **já funcionava** no teste com clique de
   mouse real (abre na célula 3D "design selecionado") — falta saber o cenário do usuário.

### Verificado

`scripts/selftest8.cjs` (novo, janela real, RTX 5060) — 22/22, zero erros: fechar o HLA leva 6
overlays e a medida (0 sobram); ↑ de 1 resíduo → 25 (hélice) → 93 (cadeia) → 283 (estrutura), ↓×2
volta a 25; tema `pp-hetero/pp-chain-map` nos átomos da interface; raio da câmera após foco =
raio da cena (34,3 Å) com a câmera a 40 Å; SS da interface do design: binder 12 res todos hélice,
alvo 9 hélice + 4 alça; hidrogênios substituem a estrutura mantendo papéis e cor; clique e duplo
clique reais num ponto do gráfico. Regressões: selftest (14/14), 4 (26/26), 5 (12/12), 6 (10/10),
7 (6/6). A primeira rodada depois do build mostra "program not linked" (cache de shader frio, já
conhecido); a segunda sai limpa.

### Atenção

- Com hidrogênios no arquivo, "Contar hidrogênios presentes no arquivo" (ligado por padrão) faz a
  contagem de contatos subir muito (12/13 → 29/24 resíduos no design) e o Mol* passa a exigir a
  geometria do H nas ligações de H (4 → 2). Para comparar com designs sem H, desligue a caixinha.
- Monitor externo: `scripts/reset-monitor.sh` desliga e religa o HDMI-1-0; rodar depois de cada
  bateria de testes.

## 2026-10-22 — Revisão, lote 6: colorir por métrica

### O diagnóstico

Colorir por métrica **aplicava** (o esquema virava `data`, o tema recebia as cores), mas a cena
ficava quase toda branca — por isso parecia não funcionar. Duas causas, as duas de escala:

1. O InterfaceAnalyzer devolve **todos** os resíduos da pose, e os que estão longe da interface
   vêm exatamente zero. De 283 resíduos, 169 eram zero: a faixa de cor passava a ser sobre uma
   nuvem de zeros e a interface — a parte que interessa — virava um borrão pálido.
2. A faixa ia do mínimo ao máximo. Energias por resíduo têm cauda longa (um resíduo em choque a
   +90 REU contra uma nuvem perto de zero), então todo o resto caía no meio da rampa.

### O que mudou

- Os conjuntos do Rosetta guardam só os resíduos **com sinal**; quem não participa fica na cor
  neutra, que é a leitura certa ("cinza = fora da interface").
- `datasetDomain` passa a cobrir os **96% centrais** dos valores, e o que passa disso recebe a
  cor da ponta em vez de sumir.
- A legenda mostra quando a escala está cortada (`≤`, `≥`) e tem um botão para alternar entre
  **96%** e **mín–máx** — a escala virou uma escolha visível, não um palpite escondido.

### Verificado (`scripts/selftest2.cjs`) — 19/19, zero erros

No design não relaxado: 114 resíduos com ΔG diferente de zero, 42 cores distintas, faixa
±44,5 REU, com corte sinalizado. Também entram `rosetta:dSASA` (63), `rosetta:energy` (283) e
`rosetta:ddG` (10, quando o alanine scan roda).

## 2026-10-22 — Revisão, lote 5: luz a partir da seleção e desempenho do Estúdio

### Luz da seleção

Os átomos selecionados passam a **emitir luz** (parâmetro `emissive` da geometria do Mol*), e o
passe de bloom em modo emissivo espalha esse brilho pela cena. Serve para um hotspot, um epítopo
ou um ligante ficarem "acesos por dentro", o que nenhuma luz externa faz. O brilho entra como uma
operação de pintura etiquetada (`emissive`), então acompanha novas camadas, entra no desfazer e
sai com "Apagar o brilho" sem mexer nas cores.

Ao subir o brilho com o bloom desligado, o bloom é ligado sozinho em 0,8 — emissivo sem bloom
quase não aparece, e descobrir isso sozinho seria frustrante.

### Desempenho: o que foi medido

Medição com duas estruturas carregadas (283 + 381 resíduos), forçando redesenho contínuo:

| cenário | qps |
|---|---|
| Figura branca (2 luzes + oclusão) | 60 |
| sem oclusão de ambiente | 60 |
| oclusão a 0,5 de resolução | 60 |
| oclusão com 16 amostras | 60 |
| uma luz só | 60 |
| sem antialiasing | 60 |
| multiSample desligado | 60 |

Ou seja: **em regime o app está no teto do vsync (60 Hz)**, e nenhum dos suspeitos (oclusão,
luzes, antialiasing) é gargalo nesta GPU. O que caía para ~30 qps eram os 450 ms da **transição**
entre presets, onde cada quadro reenviava o conjunto inteiro de propriedades.

Duas mudanças na transição:
1. Só os blocos que realmente mudaram são enviados a cada quadro (antes ia tudo, inclusive
   iluminação e fundo, que ficam parados durante a mistura).
2. Se um quadro da mistura custa mais de 12 ms, a transição passa a meia taxa — 30 qps estáveis
   em vez de 60 engasgados.

### Verificado (`scripts/selftest5.cjs`) — 12/12, e `selftest3.cjs` 28/28

Brilho aplicado à cadeia do binder e apagado em seguida (brilho médio da cena 32,7 → 38,0 com o
glow ligado). Os 10 presets continuam aplicando sem erro.

## 2026-10-22 — Revisão, lote 4: integração estilo/seleção e medidas

### Cores da vizinhança (modo Explorar)

A vista de foco do Mol* pintava os carbonos com a paleta de cadeias **dele**, que nunca coincide
com a do app: a vizinhança saía em cores que não batiam com nada na tela. Agora ela usa os temas
próprios (`pp-hetero` sobre `pp-chain-map`), com o mapa de cores da estrutura explorada, e é
re-tematizada quando o esquema, a cor de uma cadeia ou a paleta mudam.

### Funções que se desfazem entre si

Mudar uma camada no painel Estilo **encerra o modo Explorar** (`clearFocus` dentro de `setLayer`):
a vizinhança é uma cópia separada dos átomos e ficava disputando a cena com o estilo recém‑aplicado.

### Medidas

- **Entre duas seleções**: guarde um conjunto como A, outro como B e meça — aproximação mais
  curta (com o par de átomos que a faz), distância entre os centros e número de pares em contato
  até um corte ajustável. O par mais próximo é desenhado em azul e a ligação entre centros em rosa.
- Cada medida guarda **o número** (não só o texto), então a lista mostra o valor destacado e há
  **exportar CSV** com tipo, átomos, valor e unidade.
- **"Limpar" agora remove também os rótulos** — o defeito registrado na Fase 1 ("Limpar nas
  medidas não remove os rótulos de resíduo").

### Verificado (`scripts/selftest5.cjs`, janela real, RTX 5060) — 12/12, zero erros

Entre o peptídeo e o binder do design: aproximação 1,81 Å entre `C:LYS7 NZ` e `A:GLY14 O`
(a lisina do neoepítopo contra o esqueleto do binder), centros a 10,9 Å, 48 pares a ≤ 4 Å.
Vizinhança conferida em captura antes e depois de trocar a paleta: as duas acompanham o app.

## 2026-10-22 — Revisão, lote 3: comparação

### O que entrou

- **Alinhar por uma cadeia e medir outra** (`measureChains`, em `compare.ts`): depois de superpor
  pela cadeia escolhida, mede o RMSD de **outra** cadeia nas coordenadas que estão na tela, sem
  reajustar nada. A matriz relativa (inversa da referência × a da móvel) leva a cadeia móvel ao
  referencial da referência, então o número é o desvio que se vê. É o que responde "o binder
  pousa no mesmo lugar?", em vez de "o binder encaixaria sozinho?".
- **Painel reescrito**: referência e **cadeia de ajuste** escolhidas à mão (antes só dava para
  escolher uma cadeia e o resto era automático), método, medir outra cadeia, e a lista de desvios
  com RMSD, desvio máximo, nº de resíduos e identidade por estrutura.
- **Rosetta na comparação**: o mesmo protocolo da aba Interface rodado em todas as estruturas
  carregadas, **reaproveitando o cache** — o que já foi calculado com os mesmos parâmetros não
  roda de novo. Tabela por estrutura com ΔG, ΔSASA, Sc, insatisfeitos e RMSD do relax, com o
  melhor ΔG destacado.
- **Abrir mais estruturas** direto do painel, e uma tela inicial explicando isso quando só há uma
  carregada — era difícil chegar a duas estruturas sobrepostas.

### Verificado (`scripts/selftest7.cjs`, janela real, RTX 5060) — 6/6, zero erros

Dois complexos (design pMHC + 7q15). Superposição pela cadeia do alvo por TM-align: RMSD 3,22 Å,
TM 0,757, 169 pares. Medir a **mesma** cadeia reproduz 3,22 (o caminho de medição bate com o do
ajuste). Medir a cadeia do binder depois desse ajuste: 42,2 Å, máximo 66,5 — os dois binders
pousam em lugares diferentes, que é exatamente o que esse número existe para mostrar. Restaurar
as coordenadas devolve 25,3 Å (posição de arquivo).

Fase 1 (14/14) e o teste dos ajustes (10/10) rodados de novo, limpos.

### Conhecido

- Em `7q15` a cadeia A (FcRn) é detectada como "binder" pelo fallback de papéis — limitação já
  registrada na Fase 1; afeta quem é "lado A" nos protocolos, não a superposição.

## 2026-10-22 — Revisão, lote 2: interface com Rosetta, e rótulos com guia

### Interface (a parte que o usuário marcou como mais importante)

- **Átomos das ligações** (`showInteractionAtoms`): os resíduos que participam das interações
  desenhadas entram como um componente próprio, etiquetado `pp-interaction-atoms`, em
  ball-and-stick com carbono pela cadeia. Não encosta nas camadas de átomos do usuário.
  Desmarcar um tipo no menu redesenha linhas **e** átomos: some a ligação, somem os átomos que
  só ela sustentava. "Esconder linhas" limpa os dois.
- **Razões por cadeia** (`contactsPerChain`): resíduos, átomos em contato e nº de interações por
  cadeia do alvo, com barra de participação e, quando há peptídeo e MHC, o número
  **contatos peptídeo ÷ MHC** — a pergunta "estou ganhando peptídeo e perdendo MHC?" respondida
  direto no painel.
- **Protocolo Rosetta no próprio painel** (`src/compute/protocol.ts`): FastRelax (5× por padrão,
  região móvel escolhível) seguido de InterfaceAnalyzer **no modelo relaxado**, que é o número
  comparável entre designs. Barra de progresso por estrutura, com o estado em texto
  ("relaxando 5×", "medindo interface"), e o resumo (ΔG, ΔSASA, Sc, insatisfeitos, RMSD) na linha.
- **Várias estruturas**: roda na ativa ou em todas as carregadas. Quando as letras de cadeia
  pedidas não existem num arquivo, as cadeias são resolvidas **pelos papéis** e a linha avisa
  ("cadeias pelos papéis"); designs da mesma campanha normalmente compartilham as letras, mas o
  app não conta com isso.
- **Cache** por estrutura + assinatura do protocolo (repetições, nstruct, região, função de
  energia, cadeias): pedir de novo o mesmo protocolo volta instantâneo em vez de gastar Rosetta.
- O painel **não** tem comparação: aponta para a aba Comparar, como pedido.

### Rótulos (`src/engine/labels.ts`)

Rótulo por resíduo afastado da estrutura e ligado a ela por uma **guia tracejada em dois
trechos** — diagonal até um cotovelo, depois um trecho reto até o texto. O texto é posto
**fora da esfera que envolve a estrutura**, então um resíduo enterrado no sulco também recebe o
rótulo em área livre; vizinhos alternam para cima e para baixo para não empilhar, e a densidade
do tracejado acompanha o comprimento de cada trecho.

O texto **não** usa o rótulo do Mol*: lá o deslocamento é aplicado em espaço de tela, então a
ponta da guia e o texto nunca batiam. Foi preciso um segundo tipo de sobreposição,
`pp-text-overlay` (geometria `Text` do Mol*, em `overlay.ts`), que desenha texto em posição de
mundo — com contorno nos glifos e placa opcional.

No painel Seleção o botão **Rotular** virou um botão com seta: o clique rotula com o estilo
atual, a seta abre o submenu (conteúdo do texto, guia e tracejado, distância, tamanho, cores,
contorno, placa atrás do texto, limpar). Mexer num controle com rótulos na tela re-rotula na hora.

### Verificado (`scripts/selftest6.cjs`, janela real, RTX 5060)

| Passo | Resultado |
|---|---|
| Interface do design (A × B,C) | 12 + 13 resíduos, 4 interações |
| Átomos das ligações | 27 átomos aparecem; desmarcar H-bond leva a 0 (as 4 eram H-bonds); esconder limpa |
| Razões por cadeia | B 35 contatos, C 12 → peptídeo/MHC = 0,34 |
| Protocolo numa estrutura | 42 s · ΔG −27,7 REU · Sc 0,48 · RMSD 0,42 Å · 3 H-bonds do Rosetta |
| Repetir o protocolo | cache: 0 ms |
| Duas estruturas | a segunda sem a cadeia pedida é resolvida pelos papéis (antes falhava com "Cadeias não encontradas") |

Mais dois defeitos corrigidos no caminho:

1. **Job preso travava o painel** — `awaitJob` esperava para sempre; uma rodada de teste ficou
   900 s pendurada. Agora tem limite de 20 min e o erro aparece na linha da estrutura.
2. **Vista canônica antes da geometria** — `canonicalView` enquadrava com a esfera ainda vazia e
   a molécula virava um ponto no fundo. Ganhou a mesma espera por `reprCount` que o `resetView`
   já tinha desde a Fase 2.

## 2026-10-22 — Rodada de correções pedidas na revisão (lote 1 de N)

Lista completa do usuário em `docs/REVIEW.md`. Este lote fecha os defeitos de visualização
mais básicos e o desfazer; os itens maiores (interface + Rosetta, comparação, rótulos, painéis
livres, sessão) estão pendentes e priorizados lá.

| Pedido | Como ficou |
|---|---|
| Átomos do backbone somem ao ocultar a fita | A camada de átomos só desenha cadeias laterais **enquanto** há fita. Ao ocultar a fita, as camadas de átomos são reconstruídas sobre o polímero inteiro (1.247 → 2.089 átomos no design de teste). O caminho inverso não mexe nos átomos: adicionar fita nunca tira átomos que o usuário pediu. |
| Transparência para átomos e fitas | `setLayerOpacity(viewer, alvo, camada, opacidade)` — `alpha` é parâmetro de geometria base, então vale para cartoon e sticks também. Sliders por camada no painel Estilo. |
| Barra de transparência sem contexto | Cada slider só aparece quando aquela camada existe no alvo; sem superfície, o lugar explica isso em vez de mostrar um controle inerte. |
| Clique fora deve desselecionar | A ligação `clickDeselectAllOnEmpty` do Mol* estava desativada de propósito (clique errado numa fita fina apagava a seleção). Reativada, como pedido. |
| Ctrl+Z / Ctrl+Y | Histórico de até 40 passos (`src/engine/history.ts` + `src/store/history.ts`): snapshot da árvore de estado do Mol* + seleção + os dados que o engine mantém fora da árvore (cores, paleta por cadeia, log de pintura, datasets). Câmera e iluminação **não** entram: desfazer não deve jogar a câmera. Arrastos de slider viram um passo só (coalescência de 600 ms). Botões na barra de cima. |
| "Parede transparente" cortando a estrutura | É o corte de profundidade. Agora, enquanto está ativo, aparece um aviso no canto da área 3D com a porcentagem e um clique para remover. |

### Verificado (`scripts/selftest5.cjs`, janela real, RTX 5060) — 8/8, zero erros

Átomos do backbone ao ocultar a fita, transparência simultânea de fita (0,35) e átomos (0,50),
desfazer e refazer de uma superfície (camadas: com → sem → com), ligação de desselecionar ativa,
e o indicador de corte de profundidade. Fase 1 (13/13) e Fase 3 (28/28) rodadas de novo, limpas.

## 2026-10-22 — Fase 4 (análise de dados): tabela, gráficos e painéis

### Como abrir

**Dados** na barra de cima (ou o botão "Pasta de análise") → escolher a pasta com as estruturas
e a tabela. O formato dos dados piloto (`pilot/pmhc_pkg`) é o alvo, mas nada é exigido pelo nome:
a tabela é o `.csv`/`.tsv` com mais linhas (ou a que tiver "metric/metadata/designs" no nome), a
coluna de id é a que mais casa com os nomes dos arquivos de estrutura, e o resto da pasta vira
"estruturas de referência" (os alvos).

### O que entrou

- **Leitura da pasta** (`src/dataset/`): parser CSV/TSV próprio (campos entre aspas, vírgula
  decimal), inferência de tipo por coluna (número, categoria, texto, **sequência** de aminoácidos,
  lista tipo `T4,A5,G6`), agrupamento por prefixo (`rp_`, `camp_`, `ret_`, `ctrl_` → Reprevisto,
  Campanha, Retenção, Controle) e ligação linha ↔ arquivo de estrutura pelo nome.
- **12 tipos de gráfico** (`src/panels/charts.ts`), com o vocabulário visual do `analysis_part1.py`:
  dispersão (cor/tamanho por métrica, rótulos dos maiores, tendência, r), histograma, **violino com
  KDE + quartis e mediana** (o `_violin` do script, em polígonos desenhados em pixels), caixa com
  bigodes de Tukey e enxame de pontos, barras com rótulos, barras empilhadas em %, linha com banda
  de erro padrão, heatmap, matriz de correlação (Pearson/Spearman), dumbbell, coordenadas paralelas
  e funil de cortes cumulativos.
- **Tudo interativo e ligado**: tooltip com o nome do design e as métricas daquele ponto; passar o
  mouse destaca o mesmo design em todos os gráficos e na tabela; clicar seleciona (Shift soma);
  arrastar na dispersão seleciona em área; "manter só" vira filtro. Fora da seleção tudo esmaece.
- **Painéis** (`src/panels/types.ts`, `PanelCanvas`): grade configurável, células arrastáveis e
  redimensionáveis, vários painéis por sessão, letras A/B/C, tema escuro/claro/papel.
- **Células 3D dentro do painel**: cada uma é um `Viewer` próprio (o engine já era instanciável)
  que segue a seleção dos gráficos, carrega o alvo junto se pedido, aplica preset de visual, vista
  canônica, esquema de cor, superfície e interações.
- **Menus de cada análise**: título e subtítulo, nome de cada eixo, escala log, paleta, escala de
  cor (com centro para escalas divergentes), tamanho/opacidade dos pontos, legenda, grade, valores,
  agregação, ordenação, limite, faixas do histograma, linhas de referência e os critérios do funil.
- **Filtros** na barra lateral: histograma por coluna onde **arrastar define a faixa**, chips para
  categorias, busca por texto. Tabela de designs virtualizada, ordenável, em sincronia com a seleção.
- **Exportação**: painel inteiro em PNG (largura em mm × dpi) com fundo do tema, branco ou
  **transparente**; gráfico isolado; CSV do que está filtrado. Cada gráfico é redesenhado no tamanho
  final e as células 3D passam pelo render off-screen com supersampling 2×.

### Verificado (`scripts/selftest4.cjs`, janela real, RTX 5060) — 26/26, zero erros de console

| Passo | Resultado |
|---|---|
| Abrir `pilot/pmhc_pkg` | 152 designs, 34 colunas, id = `design`, 11 com estrutura, 3 alvos, NOTES.md lido |
| Inferência de tipos | `arm` categoria, `sequence` sequência, `rp_area` número 636–1.414 Å², `peptide_contacts` lista |
| 12 tipos de gráfico | todos renderizam (dispersão 152 pontos, violino 11 grupos, heatmap 175 células, paralelas 152 linhas) |
| **Funil de ligação** | **152 → 33 → 31 → 17 → 14 → 12 → 11**, igual ao funil do NOTES.md do pacote |
| Seleção → célula 3D | clicar no melhor design carrega o `.cif` com A:mhc, B:peptídeo, C:binder |
| Filtros | faixa de área + braços K/S → 26 de 152; "manter só" 11 e limpar volta a 152 |
| Exportar painel | 1417×1549 em 250 ms; versão transparente com célula 3D também transparente |

### Defeitos encontrados e corrigidos

1. **Laço infinito de render** (React #185): seletores do Zustand que montavam um array novo a cada
   leitura (`useData(() => filteredRows())`) re-renderizavam para sempre e derrubavam a área de
   dados inteira. Agora a derivação é memoizada em `src/ui/data/hooks.ts`.
2. **Célula 3D não carregava**: o efeito de carga rodava antes de o viewer terminar de ser criado
   (criação assíncrona), saía cedo e nunca era repetido. Agora um contador de "viewer pronto" entra
   nas dependências.
3. Escala de cor `ocean` começa no branco e sumia no tema escuro — a dispersão passa a usar
   `viridis` quando o tema é escuro, a menos que o usuário escolha outra.
4. Heatmap de retenção saía lavado (quase tudo perto de 1): a faixa de cor agora cobre os 96%
   centrais dos valores, não os extremos.
5. Eixo com números quebrados (`0,68399999…`) e rótulos girados colidindo com o nome do eixo.
6. Letra do painel (A, B, C) por cima do título do gráfico; rótulos "100%" sobrepostos em barras
   estreitas.

### Monitor externo congelado durante os testes (ambiente, não o app)

O monitor externo desta máquina é o **primário** e recebe imagem pela NVIDIA via PRIME. O Electron
centraliza a janela no monitor primário, então todas as janelas de teste abriam e fechavam
justamente nessa saída; depois de várias rodadas a imagem dela congelou (o X continuava listando a
saída com modo ativo). Resolvido com `xrandr --output HDMI-1-0 --off` seguido de religar com
`--mode 1920x1080 --rate 60 --pos 1920x0 --primary --right-of eDP-2`. **Os `selftest*.cjs` agora
abrem a janela em `x: 0, y: 0`**, na tela do notebook, para não ciclar contextos de GPU na saída
PRIME.

### Conhecido, não resolvido

- Rótulos de categorias longas (`arm_i_lysinated_coldspots`) só cabem em células grandes; em células
  pequenas o ECharts esconde parte deles.
- O heatmap mostra no máximo 400 linhas (e rotula até 40); acima disso use um agrupamento em
  "Linhas" ou um filtro.
- Painéis ainda não são salvos em disco: vivem na sessão (a biblioteca de estilos da Fase 3 é que
  persiste). Sessões de projeto são a Fase 7.

## 2026-10-22 — Fase 3 (estúdio estético) + polimento da interface

### O que entrou

- **Visual como um valor só** (`src/engine/look.ts`): luzes (até 4, cor/ângulo/intensidade), ambiente,
  exposição, materiais por camada (fita/átomos/superfície: rugosidade, metalicidade), cel shading,
  oclusão (força, alcance, multiescala), sombras, contorno (largura, cor, sensibilidade), névoa,
  profundidade de campo, bloom, nitidez, ray tracing (iluminação global do Mol*) e fundo.
  Trocar de preset **interpola** luzes, cores e efeitos em 450 ms (easing cúbico, cores em luz
  linear); efeitos ligados/desligados entram no primeiro quadro e saem no último.
- **10 presets por intenção:** Trabalho, ChimeraX soft (o `graphics_setup()` do cdr_panels.py),
  Figura branca, Goodsell, Glossy, Argila, Pôster escuro, Cinema, Chapado, Ray tracing.
  Prévias desenhadas em SVG a partir dos próprios valores (sem render extra).
- **Transparência por distância** (`fade.ts`): smoothstep entre "opaco até" e "mínimo a partir de",
  referência = interface (por papel das cadeias), binder ou seleção; por resíduo ou por átomo;
  48 níveis numa única atualização de estado. Reaplica sozinho ao mexer nos sliders.
- **Footprint** (`color zone`): átomos do alvo a ≤ R Å da fonte ganham a cor do átomo mais próximo
  da fonte (ou uma cor única). Ambos são pintura com etiqueta: limpar não apaga as cores do usuário.
- **Vistas canônicas** (`views.ts`): lateral, topo, ¾, sulco, verso — eixos de docking e do
  peptídeo (N→C) como no cdr_panels.py; reprodutíveis entre designs.
- **Exportação:** supersampling 1–4× (limitado pela GPU), contorno escalado com o tamanho
  ("igual à tela"), recorte pela caixa do canal alfa. **Animação:** turntable 360° (laço sem
  quadro repetido) ou balanço, MP4 (H.264), WebM com alfa, GIF (paleta global), APNG ou sequência
  de PNG — quadros RGBA crus direto para o stdin do ffmpeg, um quadro em memória por vez.
- **Meus estilos:** visual + paleta de cadeias salvos (localStorage), aplicáveis a qualquer estrutura.
- **Interface:** abas Estúdio (Alt+7) e Figura (Alt+8; Análises passou a Alt+9). Indicador que desliza
  no trilho de abas, troca de painel com entrada em cascata, segmentados com marcador deslizante,
  seções que recolhem animadas (grid 0fr↔1fr, sem medir em JS), toasts com entrada/saída e barra de
  vida, spinner nos botões, barra de progresso no topo do 3D, dock deslizando, canvas com fade-in.
  Só `transform`/`opacity` animam (nada que redimensione o canvas e realoque buffers do Mol*);
  `prefers-reduced-motion` desliga tudo.

### Defeitos encontrados e corrigidos

1. **Gradiente de fundo do Mol*** — neste driver (ANGLE/EGL, PRIME) o passe de fundo cobria o quadro
   de preto e desenhava o gradiente num único triângulo no canto inferior esquerdo; molécula,
   bloom com fundo sólido e fundo transparente renderizam certo. A causa exata no driver não foi
   isolada (o Mol* recria VAO e programa ao trocar a variante; muda nada desligar SSAO,
   multisampling, AA ou névoa). Contorno: gradientes são desenhados pela página atrás do canvas
   transparente (CSS), e na exportação compostos num canvas 2D. Custa zero de GPU e a névoa
   desvanece para o gradiente.
2. **"Recortar à molécula" não recortava** — o `autocrop` do Mol* depende de uma prévia que esse
   caminho nunca gera, então a imagem saía com o quadro inteiro (a tabela da Fase 1 registrou
   "recortado ok" sem conferir o tamanho). Agora: render transparente, caixa pelo alfa + 5 %,
   fundo aplicado depois.
3. Classe `collapse` própria colidia com o utilitário `collapse` do Tailwind 4
   (`visibility: collapse`): o conteúdo das seções sumia. Renomeada para `pp-collapse`.
4. A raiz usa fonte de 13 px, então `rem` = 13 px: o indicador do trilho calculado em px andava
   menos que os botões. Agora em `rem`.

### Verificado (`scripts/selftest3.cjs`, janela real, RTX 5060) — 28/28, zero erros de console

| Passo | Resultado |
|---|---|
| 10 presets pelo botão da galeria | todos aplicados; transição a 50–62 qps (30 qps nos com 2–3 luzes + especular; 10 qps no ray tracing, que refina parado) |
| Luz de recorte + material metálico na fita | 3 luzes, metalness 0,65 aplicado nas representações |
| Vistas canônicas no design | eixo do sulco pelo peptídeo, dock ⟂ sulco (|dot| = 0,0000) |
| Footprint 7 Å (binder → MHC + peptídeo, superfície) | 265 átomos, 54 ms |
| Transparência por distância (interface) | 150 resíduos, 20 ms; limpar remove só a etiqueta "fade" |
| PNG 2000 px, 2× supersampling, contorno proporcional, recortado | 1238×1225, 3,3 s |
| PNG sobre gradiente radial (Glossy) | gradiente composto no arquivo |
| Turntable MP4 640×360 × 24 quadros / balanço GIF | 0,95 s cada, ffprobe: h264 yuv420p 24 quadros; gif 24 quadros |

Testes das fases anteriores rodados de novo no mesmo build (`selftest.cjs`, `selftest2.cjs`).

### Conhecido, não resolvido

- Cliques de UI automatizados: galeria de presets e troca de abas; dial de luz e sliders do
  Estúdio exercitados pela mesma função (`tuneLook`) que eles chamam.
- O gradiente na exportação recortada cobre o quadro inteiro antes do recorte (como na tela),
  então um recorte pequeno mostra só um trecho do gradiente.
- Sem ffmpeg no PATH a exportação de animação avisa e não roda (aqui: /usr/bin/ffmpeg com libx264).

## 2026-10-22 — Fase 2 (cálculos integrados) + MHCXGraph e KVFinder

### Arquitetura de cálculo

`ppcore/` é um servidor de jobs em Python ligado ao Electron por JSON-lines (stdio). Cada job é
um processo próprio (isola segfault do Rosetta, como o seu `interface_analysis.py`), no
interpretador da ferramenta:

| Interpretador | Ferramentas |
|---|---|
| `SE3nv` (Python 3.9) | PyRosetta 2026.05 (IAM, H-bonds, insatisfeitos, ΔΔG, FastRelax), pydssp (torch CUDA na RTX), PDB2PQR + APBS |
| `.pyenv` do app (Python 3.11) | MHCXGraph 1.0.0, pyKVFinder 0.9.5, TM-align |

MHCXGraph e pyKVFinder exigem Python ≥ 3.10/3.11 e NumPy 2; não rodam no `SE3nv`.

Limites calculados na hora (16 núcleos físicos, ~10 GB livres): até 8 jobs Rosetta, 3 APBS
(o pipeline de eletrostática do usuário já tinha mostrado que mais que isso leva o OOM-killer
a derrubar o Xorg), 2 multithread (KVFinder/MHCXGraph), 1 GPU. Um worker PyRosetta fica
pré-aquecido (import já feito).

### Medidas que definiram padrões

- IAM no 7Q15: **2,9 s sem packstat, 61 s com oversample 30, 195 s com 100**, mesmo valor
  (0,593 vs 0,594). Packstat é opcional e desligado por padrão.
- FastRelax só na interface, 1 repetição: 24 s; `nstruct` roda em paralelo (2 modelos em 31 s).
- APBS no HLA-A2 cadeia A: 12,7 s, ~1 GB de pico, grade 257×129×129 (a mesma do README).
- KVFinder no sulco do 1A1M com o peptídeo como ligante: 0,8 s, 2 cavidades (204 e 164 Å³).
- MHCXGraph múltiplo 1A1M × 1AO7 (Cα): 6 s, 168 nós, 10 componentes.

### Integrações e desvios dos defaults das ferramentas

- **MHCXGraph**: o wrapper roda o pipeline interno e escreve JSON **e** dashboard (o CLI só
  escreve um dos dois). O `heatmap` deles pega o JSON mestre como uma proteína fantasma
  (`graph_data_*.json` casa com `graph_*.json`); o wrapper passa só os grafos por par.
- **KVFinder**: pontos reescritos com elemento C (o export usa nomes H/HA, que um visualizador
  trata como hidrogênio). Uma cavidade = um resíduo (`KAA`…), B = profundidade, Q = hidropatia.
- **APBS**: `.in` escrito inteiro (o template do PDB2PQR 3 não tem linhas `ion`; sem elas o APBS
  resolve a 0 M sem avisar). A energia q·φ total não é mostrada (inclui autoenergia).
- **Insatisfeitos**: o IAM só conta; aqui são listados átomo a átomo (polar enterrado no
  complexo, exposto separado, sem H-bond), para desenhar na cena.

### Renderização: quatro defeitos encontrados nos testes desta fase (todos corrigidos)

As capturas da Fase 2 mostraram a área 3D vazia. Diagnóstico por etapas, com o estado
interno do Mol* registrado em cada captura:

1. **Câmera NaN** — o auto-enquadramento do Mol* rodava com o viewport da câmera em 0×0
   (`getFocus` divide pela altura). Também afetava a Fase 1: o primeiro quadro após abrir um
   arquivo saía vazio, o que eu tinha atribuído errado à compilação de shaders.
2. **Contexto WebGL de sondagem** — o `describeGpu` criava um segundo contexto e o descartava
   (`loseContext`); com ANGLE/EGL + PRIME isso derrubava momentaneamente o contexto do Mol*. O
   nome da GPU agora vem do contexto do próprio visualizador.
3. **Compilação paralela de shaders** — com `KHR_parallel_shader_compile`, o Mol* lê uniforms
   antes do link terminar; esse driver responde "program not linked" em vez de esperar, e a
   cena fica vazia em toda primeira execução com cache frio. A extensão é escondida do Mol*.
4. **Transparência `dpoit`** — o depth peeling não desenhava nada transparente neste driver
   (cavidades e superfícies semitransparentes sumiam, sem erro). Padrão agora é `wboit`.
5. (lógica) `setVisible` só marcava o nó da estrutura; as representações filhas continuavam na
   tela. Agora esconde a subárvore (`setSubtreeVisibility`), também nas cavidades, potencial e overlays.

### Verificado (`scripts/selftest2.cjs`, janela real, RTX 5060) — 17/17, zero erros de console

Carga de 3 estruturas, picking, Interface Rosetta com alanine scan (46 s), KVFinder com o
peptídeo como ligante + reestilização + cavidades isoladas e dentro do sulco, APBS (18 s),
TM-align aplicado (TM 0,981), MHCXGraph + clique em "Projetar" no dock (100 resíduos
coloridos nas duas estruturas), pydssp em CUDA, FastRelax 2 modelos em paralelo (32 s,
ΔG da interface do design de +453 → −26 REU). Todas as capturas do 3D com conteúdo.

### Conhecido, não resolvido

- Os cliques nos formulários da aba Análises não são automatizados (o teste usa a mesma camada
  `submit`/`inputFor` que os botões); o clique em "Projetar" do dock é.
- Grafo do MHCXGraph com muitos nós abre com zoom alto (layout de forças); use a roda do mouse.
- Lote na biblioteca: as cadeias de cada lado são digitadas (mesmas letras para todos os designs).
- O `dpoit` frio ainda emite avisos de link do WebGL no primeiro uso; como não é mais o padrão,
  só aparece se for escolhido manualmente.

## 2026-10-21 — Fase 1 (visualização molecular) entregue e verificada

### Como rodar

```bash
cd ~/Downloads/app/protein_paint
source ../.toolchain/env.sh      # node/npm portáteis
npm install                      # só na primeira vez
npm run dev                      # Vite (porta 5273) + Electron com hot reload, na NVIDIA
npm start                        # build de produção + Electron
```

`scripts/launch.sh` põe o Chromium na RTX via PRIME offload. Na barra de status, canto
inferior direito, aparece a GPU em uso (fica laranja se cair na Intel).

### GPU: causa raiz e correção

Com o offload "clássico" (`__GLX_VENDOR_LIBRARY_NAME=nvidia`) o processo de GPU do Chromium
morria (`ANGLE Display::initialize: Invalid visual ID requested`) e caía para software:
**sem WebGL**. O ANGLE no backend GLX pede um visual X11 da tela da Intel, e o driver da
NVIDIA recusa. A configuração que funciona é PRIME offload + vendor EGL da NVIDIA
(`__EGL_VENDOR_LIBRARY_FILENAMES=…/10_nvidia.json`) + `--use-angle=gl-egl`. Resultado:
`ANGLE (NVIDIA GeForce RTX 5060 Laptop GPU, OpenGL ES 3.2)`.

O stderr mostra `No suitable EGL configs found` e um erro do Mesa `dri_gbm.so`: é o
Chromium sondando displays, aparece também nas rodadas em que tudo renderiza na NVIDIA.

### Verificado de ponta a ponta (`scripts/selftest.cjs`, janela real, RTX 5060)

```bash
PP_TEST_FOLDER=~/Downloads/ChimeraX/PDB PP_GPU=nvidia __NV_PRIME_RENDER_OFFLOAD=1 \
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json \
node_modules/electron/dist/electron scripts/selftest.cjs <saida> <arquivos…>
```

| Passo | Resultado |
|---|---|
| Carregar `na1_binder_9_model_7.cif` / `7q15_mhc_complex.pdb` / `1a1m_mhc_all.pdb` | 0,1–0,2 s cada (1 s no primeiro, compilação de shaders) |
| Papéis por sequência no design | A binder (93), B MHC (180), C peptídeo (10), pLDDT detectado |
| Seleção por spec `:1-20` | ok |
| Sticks na seleção, pintura, superfície molecular do alvo a 50 % | ok, sem perder camadas |
| Interface binder × MHC+peptídeo (≥ 2 átomos a ≤ 4 Å) | 12 + 13 resíduos, 128 pares de átomos, 4 H-bonds, linhas desenhadas |
| Interface 7q15 (A × C) | 10 + 7 resíduos, 98 pares, 5 H-bonds, 1 π-stacking, 1 cátion–π |
| Preset "Figura ChimeraX" + fundo branco, esquemas B-factor e papel | ok |
| Export PNG 2000 px transparente recortado | ok (≈1 s) |
| Superposição TM-align (Mol*) | ok |
| Biblioteca: pasta com 26 estruturas, navegar 3 designs | substitui o design anterior, mantém o fixado, ~180 ms por passo |

O harness exercita o engine e as ações da UI (`store/actions.ts`); os cliques nos
painéis em si não foram automatizados — foram conferidos nas capturas de tela.

### Feito nesta fase

- Electron 44 + Vite + React + TS strict; engine Mol* 5.13.1 como instâncias (`Viewer`),
  pronto para vários painéis 3D.
- Leitura e gunzip no processo main; pasta de designs → biblioteca com ↑/↓.
- Árvore: renomear estrutura/cadeia (clique duplo), papel editável, cor por cadeia, modelo
  (multi-modelo), visibilidade, foco.
- Camadas fita/átomos/superfície por seleção, cadeia ou estrutura; atalhos de design.
- Cores: cadeia, papel, estrutura, única, SS, pLDDT, B-factor (rampa + min/max), hidrofobicidade,
  carga, arco-íris, elemento, tipo; heteroátomos por elemento; pintura e transparência.
- Seleção: clique, linha de comando estilo ChimeraX, por tipo com booleanos, vizinhança,
  trilha de sequência (clique/arraste, sincronizada).
- Interface: interações do Mol* filtradas entre os dois lados, desenhadas como malha única na
  GPU (cor + nº de traços por tipo); lista clicável; sticks da interface.
- Medidas (distância/ângulo/diedro), rótulos, superposição (matchmaker e TM-align),
  7 presets de luz + ajuste fino, fundos, câmera, export PNG por mm/dpi.

### Conhecido, ainda não resolvido

- O painel Estilo não mostra qual estilo está ativo (os botões aplicam, não refletem estado).
- A trilha de sequência tinge as letras por classe química, não pelo esquema de cor do 3D.
- "Limpar" nas medidas não remove os rótulos de resíduo.
- Papéis em alvos MHC-like (FcRn, MR1, CD1…) caem no fallback por comprimento: no 7q15 a
  cadeia A (FcRn) sai como binder. Ajuste na árvore; uma sonda por sequência para MHC-like
  entra junto com a Fase 2.
- O teste de interface não usa energias: as interações são o modelo geométrico do Mol*.
  H-bonds com energia (PyRosetta) são a Fase 2.
