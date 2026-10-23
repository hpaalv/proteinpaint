# Revisão do usuário — 2026-10-22

Lista do que ele pediu depois de testar as Fases 1–4, com o estado de cada item.
Ordem de prioridade dada por ele: **"a parte de visualização de interface é a mais importante,
deve estar tudo perfeitamente certo"**.

## Feito (lote 1)

- [x] Átomos do backbone somem ao tirar a fita
- [x] Transparência para átomos e fitas, não só superfície
- [x] Controles de transparência só aparecem no contexto certo
- [x] Clique fora (sem arrastar) desseleciona
- [x] Ctrl+Z / Ctrl+Y
- [x] Corte de profundidade ("parede transparente") explícito e removível num clique

## Feito (lote 2 — interface)

- [x] Átomos das ligações aparecem junto com as linhas (componente próprio, etiquetado,
      que não briga com as camadas de átomos do usuário)
- [x] Desmarcar um tipo de ligação tira também os átomos que só ele sustentava
- [x] PyRosetta no painel Interface: FastRelax (5× por padrão) + InterfaceAnalyzer no modelo
      relaxado, com barra de progresso por estrutura e estado ("relaxando 5×", "medindo interface")
- [x] Roda em uma estrutura ou em todas as carregadas; quando as letras de cadeia não existem
      no arquivo, as cadeias são resolvidas pelos papéis e a linha avisa
- [x] Cache por estrutura + assinatura do protocolo: repetir não recalcula
- [x] Razões por cadeia, com barra de participação e o número peptídeo ÷ MHC
- [x] O painel Interface não tem comparação (só otimização e visualização); aponta para a aba Comparar

## Feito (lote 3 — comparação)

- [x] Rosetta na comparação, reaproveitando o cache do protocolo
- [x] Tabela numérica por estrutura (ΔG, ΔSASA, Sc, insatisfeitos, RMSD do relax), melhor destacado
- [x] Alinhar por uma cadeia e medir o RMSD de outra, nas coordenadas da tela
- [x] Rodar o protocolo em todas as estruturas de uma vez
- [x] Abrir mais estruturas direto do painel (e tela inicial explicando, com uma só carregada)
- [ ] Comparação **visual** ainda é a superposição + a faixa de desvio por resíduo; falta colorir
      por desvio e ver as métricas lado a lado em gráfico (vai junto com o bloco de Dados)

## Feito (lote 2 — rótulos)

- [x] Submenu próprio: botão **Rotular** com seta, que abre conteúdo, guia, tracejado,
      distância, tamanho, cores, contorno, placa e limpar
- [x] Estilo base: guia tracejada diagonal + reta até o nome, com o texto fora da estrutura
- [ ] Rótulos de medidas e do modo Explorar ainda usam o rótulo padrão do Mol* (pendente)

## Feito (lote 4 — integração e medidas)

- [x] Mudar o estilo encerra o modo Explorar
- [x] Cores da vizinhança seguem o esquema do app (e acompanham trocas de paleta/cor)
- [x] Medidas entre duas seleções (mais curta, centros, contatos), valores numéricos e CSV
- [x] "Limpar" nas medidas remove também os rótulos (defeito aberto desde a Fase 1)
- [ ] Ainda falta: desfazer mútuo entre outras ações (ex.: interface × estilo × dados calculados)

## Feito (lote 5 — estúdio)

- [x] Emitir luz a partir da seleção (emissivo + bloom), com apagar e desfazer
- [x] Desempenho medido: 60 qps em regime (teto do vsync); a queda era só na transição entre
      presets, agora com envio só do que mudou e meia taxa quando o quadro custa caro

## Feito (lote 6 — análises)

- [x] Colorir por métrica: resíduos sem sinal saem do conjunto, faixa de cor robusta (96%),
      corte sinalizado e alternância 96% ↔ mín–máx na legenda
- [ ] Se houver outro item das Análises sem efeito, preciso saber **qual** — o caminho de
      dataset → cor está coberto por teste agora

## Pendente — dados e painéis

- [ ] Modo de posicionamento livre, além da grade atual
- [ ] Largura de coluna e altura de linha ajustáveis à mão + botão "voltar ao canônico"
- [ ] Selecionar várias células (Ctrl) e exportar só elas
- [ ] Pré-visualização com edição antes de salvar
- [ ] Exportar gráficos individualmente (existe, mas melhorar) e salvar uma seleção deles
- [ ] Heatmap com métricas de escalas diferentes: normalizar por métrica (cor = mín/máx de cada
      uma), com a legenda deixando isso explícito
- [ ] Acessar os resultados do Rosetta vindos do modo Estrutura
- [ ] Rodar Rosetta no modo Dados: nas estruturas abertas, em todas, ou numa seleção
- [ ] Gráficos específicos do Rosetta
- [ ] Salvar sessão (tipo ChimeraX) que reabre exatamente onde parou

## Lote 7 — 2026-10-23 (segunda rodada de testes do usuário)

- [x] Fechar uma molécula remove distâncias, rótulos, linhas e tudo relacionado
- [x] ↑/↓ sobe/desce o nível de seleção (ChimeraX)
- [x] Adicionar hidrogênios + caixinha de hidrogênios onde há ligações de H
- [x] Cadeias laterais da interface na cor da cadeia (só heteroátomos por elemento)
- [x] Escolher se a trilha de sequência fica fixa, recolhida ou desligada
- [ ] Rótulos de CDR na renumeração IMGT — **pendente de resposta**: a numeração IMGT do MHC
      (domínio G) não tem CDRs; perguntei ao usuário se é para rotular as regiões do MHC (fitas e
      hélices do domínio G) ou CDRs de um binder anticorpo/TCR
- [x] Estrutura secundária da interface, comparando estruturas (gráfico próprio)
- [x] Explorar deixava uma "parede invisível" (corte da câmera preso ao raio do foco)
- [~] Clicar num ponto para abrir a estrutura: funciona no teste com clique real; acrescentado
      duplo clique → modo Estrutura. Falta o cenário em que falhou para o usuário
- [x] Célula 3D do modo Dados no modo interface mostra as cadeias laterais
