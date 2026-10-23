# pMHC NRAS Q61K — binders BindCraft2 — handoff técnico

Alvo: HLA-A\*01:01 + `ILDTAGKEEY` (NRAS Q61K), do cristal 8YIV com o TCR removido.
Gerado 2026-10-22. Campanha encerrada; nada rodando.

## Conteúdo

```
metrics.csv                 152 designs distintos, 34 colunas
structures/binders/         11 cif: os que passam o funil de ligação
structures/targets/         3 pdb: alvo, selvagem, original não-lisinado
```

## Convenção de cadeia (crítico)

- **cif de design (BC2):** `A` = alvo/plataforma, `B` = peptídeo, `C` = binder.
- **pdb de alvo:** `A` = plataforma, `C` = peptídeo.

Não é a numeração do PDB de entrada. Identificar por conteúdo, nunca por letra.
B-factor dos cif = pLDDT por átomo.

## Alvos

| arquivo | peptídeo | Lys na cadeia A |
| --- | --- | --- |
| `mhc_lysinated.pdb` | `ILDTAGKEEY` (Q61K) | 50 (6 nativas + 44 forçadas) |
| `mhc_lysinated_wt_q61.pdb` | `ILDTAGQEEY` (WT) | 50 |
| `mhc_no_tcr.pdb` | `ILDTAGKEEY` | 6 (input original) |

O alvo é a **plataforma α1/α2 truncada** (resíduos 1-180). β2m e α3 saíram com o TCR
no PDB, o que expõe a face inferior da folha β do piso. Os braços A-G (≈1.770
trajetórias, 0 aceitos) morreram ali: os binders pousavam embaixo. A correção foi
**lisinar 44 resíduos da face inferior** (`analysis/lysinate_underside.py`, por SASA),
tornando-a eletrostaticamente hostil. Tudo a partir do braço H usa esse alvo.

**Consequência a carregar:** as 44 lisinas artificiais criam pressão por binder
poliácido. Os 152 têm carga líquida −6 a −15, pI 4,1-4,8, Glu em ~20% dos resíduos.
Parte dessa complementaridade é artefato do alvo, não do MHC real.

## Protocolos

Base comum desde o braço H: sem `forced_targeting`, alvo lisinado gravado em PDB,
`interface_contacts` como única perda de contato, ProteinMPNN (SolubleMPNN) 10 seq/backbone.

| braço | hotspots | cutoff | validação | filtros extras | aceitos/backbones |
| --- | --- | --- | --- | --- | --- |
| H | `C4-7,C9` | 12 Å | **monomer** | — | 5 / 4 |
| I | `C4-7,C9` | 12 Å | **monomer** | + 49 coldspots na plataforma | 3 / 1 |
| K | `C4,C7,C9` | **8 Å** | multimer | `All_Atom_Clashes ≤ 8` | 20 / 11 |
| S | `C4,C7,C9` | 8 Å | multimer | K + relax dos aceitos, área ≥ 700, cos. termini −0,15 | 20 / 10 |
| R | idem S | 8 Å | multimer | + contra-alvo WT peso 0,25 (`detarget`) | 0 |
| J, Q | variantes intermediárias | — | — | — | 0 |

**K é o salto de qualidade** e produz 8 dos 11 melhores ligantes. H e I não entregam
nenhum: validados em monomer, a área e o i_pAE não sustentam quando remedidos em multimer.
R não produziu nada em ~50 h de GPU; cancelado 2026-10-21.

### Hotspots — o que foi aprendido

`targets[].hotspots` é **gradiente**, não só filtro (`loss.py:547-551`): havendo hotspots,
`interface_contacts` para de medir a superfície e mede a média não-ponderada sobre a lista.

- Peptídeo inteiro (`C1-10`) **não funciona**: com sonda SASA 5 Å só 5 dos 10 resíduos têm
  área alcançável (C4 26%, C5 15%, C6 100%, C7 18%, C9 40%; C1,C2,C3,C8,C10 em 0% — âncoras
  dos bolsões A/B/F). Braço D (`C1-10`, cutoff 8) deu **0 candidatos em 283 trajetórias**:
  diluiu o gradiente com metade de alvos impossíveis.
- Melhor configuração testada: **`C4,C7,C9` com cutoff 8 Å**.
- O cutoff da perda é configurável; o filtro `Hotspot_Contact_Fraction` usa **4,0 Å fixo**
  (`filters.py:209`). Cutoff 12 satura a perda a ~6 Å (gradiente zero) e o filtro depois
  cobra 4 Å. Alinhar o cutoff; não afrouxar o filtro.
- Com 3 hotspots usar `min_hotspot_contact_final` **0,6**, nunca 0,67: a comparação é float
  cru e 2/3 = 0,6666… reprova.

## Métricas — duas réguas, não misturar

- `camp_*` — da campanha. **Não comparáveis entre braços** (H/I em monomer).
- `rp_*` — reprevistas 2026-10-21 para os 152 no mesmo protocolo: multimer v3 modelos 2+3,
  6 reciclagens, binder entra com flag `DESIGN` (redobra da sequência, não do template).
  **Usar estas.**

`ctrl_div_i_pTM` = `camp_i_pTM − rp_i_pTM`. Divergência > 0,08 ⇒ design dependente do
template, comparação inválida. 4 dos 152 (`ctrl_valid=0`).

## Funil de ligação (as 11 estruturas incluídas)

Portões cumulativos sobre os 152:

| critério | sobram |
| --- | --- |
| — | 152 |
| `rp_i_pTM ≥ 0,85` | 33 |
| `rp_i_pAE ≤ 0,18` | 31 |
| `rp_area ≥ 1000` | 17 |
| `rp_ires ≥ 18` | 14 |
| `unbound_pLDDT ≥ 0,85` | 12 |
| `rp_rmsd ≤ 1,0` | 12 |
| `rp_offepitope ≤ 0,20` | **11** |

Em 8 backbones. Melhor: **`arm_k_cutoff8_denovo_l119_3405b2ef399189f1_seq1`** —
i_pTM 0,90 · i_pAE 0,14 · 1.414 Å² · 27 res. interface · hotspot 1,0 · 119 aa · 82% hélice.
Três sequências MPNN independentes do mesmo backbone (`3405b2ef399189f1`) entram no top 11,
o que é o sinal de robustez mais forte do conjunto.

Corte mais severo: área ≥ 1.000 Å² (31→17). Muito design com i_pTM alto e interface rasa.

## Seletividade — **nenhum design serve**

Testado por redobramento contra 7 alvos alternativos (o selvagem Q61 + 6 pMHC reais do
PDB do mesmo alelo, preparados idênticos: plataforma 1-180, **mesmas 44 lisinas impostas
por número**, nunca redecididas pela geometria). Colunas `ret_*` = fração da área de
interface retida vs. o alvo Q61K. Ler **área**, nunca i_pTM sozinho.

| alvo | peptídeo | mediana retida | nº < 0,70 |
| --- | --- | --- | --- |
| WT_Q61 | `ILDTAGQEEY` | 0,98 | 24 |
| 8YJ2 | `ILDTAGREEY` Q61R | 1,00 | 6 |
| 9Z50 | `ILDTAGHEEY` Q61H | 0,95 | 21 |
| 3BO8 | `EADPTGHSY` 9mer | 0,93 | 40 |
| 6AT9 | `AQDIYRASYY` 10mer | 0,99 | 27 |
| 4NQX | `CTELKLNDY` 9mer | 0,92 | 58 |
| 8XKE | `EVDNATRFASVY` 12mer | 0,80 | 64 |

16 de 193 soltam do selvagem; **zero soltam dos sete** (`ret_max < 0,80` não ocorre).
O melhor ligante (`l119_3405b2ef…_seq1`) retém 0,97 no selvagem e 1,00 no Q61R: liga
HLA-A\*01:01, não o neoepítopo. Casos instrutivos:

- `l112_45703e39…_seq0` — solta de Q (0,43) e R (0,44), liga em K e H: lê o **tamanho** da
  posição 7, exclusão estérica, não reconhecimento de lisina.
- `candidate8` (braço R, retratado) — lê **comprimento**: solta dos 9mer e do 12mer, retém
  97-102% nos três 10mer de NRAS incluindo o selvagem.
- `l107_624d2bf3…_seq0` — único com a forma certa: 0,93-1,03 nos seis chamarizes, 0,68 no
  selvagem. Magnitude fraca, mas é o ponto de partida mais defensável.

**Contato com o K7 não prediz discriminação**: ρ = +0,43 (p = 0,11) entre área enterrada
do K7 e área retida no selvagem, sinal **positivo**. Lys e Gln são polares de tamanho
parecido e o AlphaFold acomoda a troca. Não ranquear por isso.

## Se for retomar o desenho

A especificidade tem de entrar no **gradiente**, e o contra-alvo precisa punir **Q61R e
Q61H**, não o selvagem. Contra-alvo só-selvagem ensina "evite glutamina", que qualquer
cadeia lateral volumosa satisfaz — foi o que o braço R produziu (0 aceitos) e o que o
`l112` demonstra. Com 8YJ2 e 9Z50 como contra-alvos a única saída química é ler a amina
da lisina.

## Armadilhas do BC2 já pagas

- `forced_targeting` troca o alvo no `harden` (repõe o nativo depois de otimizar contra
  poli-lisina). Custou ~1.790 trajetórias. Manter desligado.
- Limiar `≥ 0,67` sobre 3 hotspots reprova 2/3 (float cru). Causa de 116 dos 149 resgates.
- Limiar de mínimo `0,0` **não é inerte** para métrica com sinal (cosseno de termini): 25 resgates.
- `relax_accepted_designs` roda **depois** do filtro: design marginal nunca vê relax.
  Relaxar offline leva a mediana de clash binder↔alvo de 10 → 0 (147/149 melhoraram).
- `kept_sequences=1` descarta redesenhos aprovados; alinhar com `enough_passing_sequences`.
- `failed_filters` não é a lista completa: métrica de confiança que falha curto-circuita as
  geométricas.
- Validação em monomer numa interface rasa reprovou 187 de 274 candidatos bons. Validar em
  multimer.
- `losses.params` **substitui** em vez de mesclar.
- Doc completa do BC2 dentro da imagem: `/opt/bindcraft/docs/source`.

## Infra (SDumont)

`bin/bc2` embrulha o Apptainer com o plugin CUDA 12 (a imagem traz CUDA 13, as V100 têm
driver 12.6). Pedir **1 GPU por job, nunca 4** — 4 jobs de 1 GPU entram em segundos onde um
de 4 espera horas (o backfill só pega pequeno e curto). Cotas: `sequana_gpu` 4 jobs/4d ·
`sequana_gpu_dev` 1/20min · `sequana_gpu_long` 3/31d · `gdl` 1/2d · `sequana_cpu` 4/4d.
