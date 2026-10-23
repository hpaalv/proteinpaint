#!/usr/bin/env python3
"""
analysis_part1.py -- Analises gerais, parte 1 (contatos binder-pMHC).

Figuras principais (figures/<modo>/main/):
    contact_sensitivity_mean   contatos com o peptideo vs cutoff (media por grupo)
    contact_sensitivity_max    idem, melhor estrutura de cada grupo
    selectivity_ratio          razao de seletividade ao peptideo (best structures)
    best_candidates            MHC vs max contatos com o peptideo (equivale ao fig4_best)
    peptide_contact_best       max contatos com o peptideo + razao de seletividade
    panel_part1                A = sensibilidade (media) | B = best candidates
                               C = peptide contact best structures
    binder_hotspot             frequencia de contato ao longo do binder (+ SS)
    terminal_direction         % de estruturas com terminais N/C apontando para longe do
                               MHC (angulo < TERM_AWAY_ANGLE, a partir do centroide do binder)

Extras (figures/<modo>/extras/): hotspot em heatmap, dumbbell media vs melhor,
violinos dos angulos dos terminais, altura normalizada dos terminais, painel alternativo.

Grupos: scaffolds gerados (str_val), familias SynBip docadas (str_val
padronizado por prep/prepare_val_references.py) e TCR nativo (mesmo padrao).

Configuracao: TUDO vem de variaveis de ambiente (ver run_analysis_part1.sh);
`--set CHAVE=valor` na linha de comando sobrescreve. Chaves de estilo vazias
usam o preset do OUTPUT_MODE (slide | a4).

Cache: features por grupo em <out>/cache/, chaveadas por hash de
(arquivos de entrada + cadeias + pep_len + versao do codigo). O cutoff nao
entra na chave (as features sao distancias), entao mudar cutoff, estilo ou
modo so refaz as figuras.
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import bokeh_kit as bk                           # noqa: E402
from common.cache import cached, files_signature              # noqa: E402
from common.groups import build_groups, Group, TCR_COLOR     # noqa: E402
from common.structure_features import FEATURE_VERSION, extract_many  # noqa: E402

warnings.filterwarnings("ignore")

BASE = Path("/home/paulo.alves/pd/benchmarking")

# ==========================================================================
# Configuracao
# ==========================================================================
ANALYSIS_DEFAULTS = dict(
    MHC="8YIV",
    RUN_KEY="",                       # vazio -> <MHC>_part1
    OUT_ROOT=str(BASE / "processed_results" / "general_analysis_final"),
    STR_VAL_DIR="",                   # vazio -> data/<MHC>/str_val
    DOCKED_DIR="",                    # vazio -> data/<MHC>/synbip_docking/str_val
    TCR_PDB=str(BASE / "inputs/main_mhc_str/reference_tcr_val_repacked.pdb"),
    TCR_CHAINS="D,E",
    PEP_LEN="10",
    CUTOFF="5.0",
    CUTOFF_MIN="2.0", CUTOFF_MAX="10.0", CUTOFF_STEP="0.5",
    MHC_STAT="min",                   # min | median  (MHC nas estruturas de max pep)
    HOTSPOT_BINS="20",
    MAX_PER_GROUP="0",                # 0 = todas; N = subamostra aleatoria por grupo
    SEED="42",
    INCLUDE_DOCKED="1", INCLUDE_TCR="1",
    EXCLUDE_GROUPS="",                # ex. "BG_ems,thio_ems,dock_nanobody"
    COLOR_SPREAD="0.30",              # amplitude de tons dentro da familia
    FAMILY_COLORS="",                 # ex. "HHH=#1f5fa8,EHEE=#2e8b3e"
    SHOW_SEM="0", SHOW_VALUE_LABELS="1", SHOW_REF_LINES="1", SHOW_CUTOFF_LINE="1",
    HOT_SHARED_Y="1",
    BEST_LABELS="1",
    HOT_PEAK="1",                     # hotspot: linha + posicao (%) do pico                  # B: rotulos dos grupos (posicionados sem colisao)
    TERM_ORIGIN="binder",             # binder | peptide -- origem do vetor do angulo dos terminais
    TERM_AWAY_ANGLE="90",             # terminal "away from MHC" = angulo < isto
    MAKE_EXTRAS="1",
    OUTPUT_MODE="slide",              # slide | a4
    FORMATS="svg,pdf,png,html",
    N_WORKERS="0",                    # 0 = SLURM_CPUS_PER_TASK-1
    FORCE_RECOMPUTE="0",
)


def load_config():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    a = ap.parse_args()
    cli = dict(s.split("=", 1) for s in a.set)
    C = {k: cli.get(k, os.environ.get(k, v)) or v for k, v in ANALYSIS_DEFAULTS.items()}
    style_over = {k: cli.get(k, os.environ.get(k, "")) for k in bk.STYLE_KEYS}
    S = bk.build_style(C["OUTPUT_MODE"], style_over)

    b = lambda k: str(C[k]).lower() not in ("0", "false", "no", "")
    cfg = dict(
        mhc=C["MHC"], pep_len=int(C["PEP_LEN"]), cutoff=float(C["CUTOFF"]),
        cutoffs=np.round(np.arange(float(C["CUTOFF_MIN"]),
                                   float(C["CUTOFF_MAX"]) + float(C["CUTOFF_STEP"]) / 2,
                                   float(C["CUTOFF_STEP"])), 4),
        mhc_stat=C["MHC_STAT"], bins=int(C["HOTSPOT_BINS"]),
        max_per_group=int(C["MAX_PER_GROUP"]), seed=int(C["SEED"]),
        include_docked=b("INCLUDE_DOCKED"), include_tcr=b("INCLUDE_TCR"),
        exclude={x.strip() for x in C["EXCLUDE_GROUPS"].split(",") if x.strip()},
        color_spread=float(C["COLOR_SPREAD"]),
        family_colors=dict(x.split("=") for x in C["FAMILY_COLORS"].split(",") if "=" in x),
        show_sem=b("SHOW_SEM"), show_values=b("SHOW_VALUE_LABELS"),
        show_ref=b("SHOW_REF_LINES"), show_cutoff=b("SHOW_CUTOFF_LINE"),
        hot_shared_y=b("HOT_SHARED_Y"), extras=b("MAKE_EXTRAS"),
        term_away=float(C["TERM_AWAY_ANGLE"]), term_origin=C["TERM_ORIGIN"],
        best_labels=b("BEST_LABELS"),
        hot_peak=b("HOT_PEAK"),
        formats=tuple(x.strip() for x in C["FORMATS"].split(",")),
        n_workers=int(C["N_WORKERS"]) or None, force=b("FORCE_RECOMPUTE"),
        tcr_pdb=Path(C["TCR_PDB"]), tcr_chains=C["TCR_CHAINS"].split(","),
    )
    cfg["str_val"] = Path(C["STR_VAL_DIR"] or BASE / "data" / cfg["mhc"] / "str_val")
    cfg["docked"] = Path(C["DOCKED_DIR"] or BASE / "data" / cfg["mhc"] / "synbip_docking" / "str_val")
    run = C["RUN_KEY"] or f"{cfg['mhc']}_part1"
    cfg["out"] = Path(C["OUT_ROOT"]) / run
    cfg["fig_main"] = cfg["out"] / "figures" / S["MODE"] / "main"
    cfg["fig_extra"] = cfg["out"] / "figures" / S["MODE"] / "extras"
    cfg["csv"] = cfg["out"] / "csv"
    cfg["cache"] = cfg["out"] / "cache"
    return cfg, S


# ==========================================================================
# Dados
# ==========================================================================
def load_group(cfg, source, name, pdbs, binder_chains):
    params = dict(kind="features", version=FEATURE_VERSION, source=source, group=name,
                  binder_chains=list(binder_chains), target_chain="B",
                  pep_len=cfg["pep_len"], files=files_signature(pdbs))
    return cached(cfg["cache"] / "features", f"{source}__{name}", params,
                  lambda: extract_many(pdbs, binder_chains, "B", cfg["pep_len"], cfg["n_workers"]),
                  force=cfg["force"])


def load_all(cfg):
    recs, gen, dock = {}, [], []
    for d in sorted(p for p in cfg["str_val"].iterdir() if p.is_dir()):
        if d.name in cfg["exclude"]:
            continue
        pdbs = sorted(d.glob("*.pdb"))
        if pdbs:
            recs[d.name] = load_group(cfg, "generated", d.name, pdbs, ["A"])
            gen.append(d.name)
    if cfg["include_docked"]:
        if cfg["docked"].exists():
            for d in sorted(p for p in cfg["docked"].iterdir() if p.is_dir()):
                key = f"dock_{d.name}"
                pdbs = sorted(d.glob("*.pdb"))
                if key in cfg["exclude"] or not pdbs:
                    continue
                recs[key] = load_group(cfg, "docked", d.name, pdbs, ["A"])
                dock.append(d.name)
        else:
            print(f"[WARN] docados padronizados nao encontrados: {cfg['docked']}\n"
                  f"       rode prep/run_prepare_val_references.sh (seguindo sem docados)")
    has_tcr = False
    if cfg["include_tcr"]:
        if cfg["tcr_pdb"].exists():
            recs["TCR"] = load_group(cfg, "tcr", "TCR", [cfg["tcr_pdb"]], cfg["tcr_chains"])
            has_tcr = bool(recs["TCR"])
        else:
            print(f"[WARN] TCR padronizado nao encontrado: {cfg['tcr_pdb']} (seguindo sem TCR)")

    groups = build_groups(gen, dock, has_tcr, cfg["color_spread"], cfg["family_colors"])
    groups = [g for g in groups if recs.get(g.key)]

    if cfg["max_per_group"] > 0:
        rng = np.random.default_rng(cfg["seed"])
        for k, r in recs.items():
            if len(r) > cfg["max_per_group"]:
                idx = np.sort(rng.choice(len(r), cfg["max_per_group"], replace=False))
                recs[k] = [r[i] for i in idx]
    for g in groups:
        print(f"  {g.key:<16s} n={len(recs[g.key]):>5d}")
    return groups, recs


def contact_table(groups, recs, cutoff):
    rows = []
    for g in groups:
        for r in recs[g.key]:
            rows.append(dict(group=g.key, pdb=r["pdb"], binder_len=r["binder_len"],
                             n_pep=int((r["pep_mind"] <= cutoff).sum()),
                             n_mhc=int((r["mhc_mind"] <= cutoff).sum())))
    return pd.DataFrame(rows)


def sensitivity(groups, recs, cutoffs):
    out = {}
    for g in groups:
        pep = np.stack([r["pep_mind"] for r in recs[g.key]])
        cnt = (pep[:, :, None] <= cutoffs[None, None, :]).sum(1).astype(float)
        n = len(cnt)
        out[g.key] = dict(mean=cnt.mean(0), max=cnt.max(0), median=np.median(cnt, 0),
                          sem=cnt.std(0, ddof=1) / np.sqrt(n) if n > 1 else np.zeros(len(cutoffs)))
    return out


def best_stats(groups, df, mhc_stat):
    rows = []
    for g in groups:
        s = df[df.group == g.key]
        mx = s.n_pep.max()
        at = s[s.n_pep == mx]
        m = at.n_mhc.min() if mhc_stat == "min" else at.n_mhc.median()
        raw = m <= 0
        rows.append(dict(group=g.key, label=g.label, n=len(s), mean_pep=s.n_pep.mean(),
                         max_pep=mx, n_at_max=len(at), mhc_at_max=m,
                         ratio=float(mx) if raw else mx / m, ratio_raw=bool(raw)))
    return pd.DataFrame(rows).set_index("group")


def hotspot(groups, recs, cutoff, bins):
    """freq[g] (bins,) e ss[g] (str) -- TCR vira TCR_a / TCR_b (uma cadeia cada).

    A SS consenso e calculada em resolucao de residuo, independente dos bins de
    contato: n = comprimento mediano da cadeia no grupo; em cada posicao relativa
    (j+0.5)/n cada estrutura vota com o residuo correspondente. Votar por bin
    (~3 residuos) apagava loops curtos (1-3 res.) entre helices."""
    out = []
    for g in groups:
        rs = recs[g.key]
        n_ch = int(rs[0]["bind_chain"].max()) + 1
        for ch in range(n_ch):
            hit = np.zeros((len(rs), bins))
            n_ss = int(np.median([(r["bind_chain"] == ch).sum() for r in rs]))
            t = (np.arange(n_ss) + 0.5) / n_ss
            ssc = np.zeros((n_ss, 3))
            for i, r in enumerate(rs):
                m = r["bind_chain"] == ch
                d = r["bind_mind"][m]
                ss = np.array(list(r["ss"]))[m]
                b = np.minimum((np.arange(len(d)) / len(d) * bins).astype(int), bins - 1)
                np.maximum.at(hit[i], b, (d <= cutoff).astype(float))
                s = ss[np.minimum((t * len(ss)).astype(int), len(ss) - 1)]
                for k, c in enumerate("HEC"):
                    ssc[:, k] += s == c
            if n_ch == 1:
                key, label = g.key, g.label
            else:
                suf = "αβγδ"[ch] if ch < 4 else str(ch)
                key, label = f"{g.key}_{suf}", f"{g.label}{suf}"
            out.append(dict(key=key, label=label, group=g, freq=hit.mean(0) * 100,
                            ss="".join(np.array(list("HEC"))[ssc.argmax(1)])))
    return out


def ss_segments(ss):
    """[(inicio, fim, tipo)] dos trechos continuos de mesma SS (fim exclusivo)."""
    segs, i0 = [], 0
    for i in range(1, len(ss) + 1):
        if i == len(ss) or ss[i] != ss[i0]:
            segs.append((i0, i, ss[i0]))
            i0 = i
    return segs


def ss_for_bin(ss, b, bins):
    """Trecho da SS (resolucao de residuo) que cai no bin b."""
    n = len(ss)
    return ss[int(round(b * n / bins)):int(round((b + 1) * n / bins))]


def terminals(groups, recs, origin="binder"):
    """Uma linha por (estrutura, cadeia do binder). origin=peptide usa as colunas
    *_pep (vetor a partir do centroide do peptideo, definicao antiga)."""
    rows = []
    for g in groups:
        for r in recs[g.key]:
            for t in r["term"]:
                rows.append(dict(group=g.key, pdb=r["pdb"], **t))
    df = pd.DataFrame(rows)
    if origin == "peptide":
        for c in [c for c in df.columns if c.endswith("_pep")]:
            df[c[:-4]] = df[c]
    elif origin != "binder":
        raise SystemExit(f"TERM_ORIGIN invalido: {origin!r} (binder | peptide)")
    return df


# ==========================================================================
# Helpers de plot
# ==========================================================================
def _figure(S, w, h, **kw):
    from bokeh.plotting import figure
    return figure(width=int(w), height=int(h), **kw)


def _factors(groups):
    # (familia, rotulo): o nivel de familia so separa (texto oculto) e os
    # rotulos completos ficam no eixo, inclinados -- evita sobreposicao de
    # nomes de familias com 1 so membro.
    return [(g.family, g.label) for g in groups]


def _cat_x_range(groups):
    from bokeh.models import FactorRange
    return FactorRange(*_factors(groups), group_padding=0.9, factor_padding=0.12,
                       range_padding=0.02)


def _auto_angle(S, groups, width):
    """45 graus se houver folga entre barras; senao vertical (sem sobrepor)."""
    n_fam = len({g.family for g in groups})
    slot = width * 0.85 / (len(groups) + 0.9 * (n_fam - 1))
    return math.pi / 4 if slot * 0.707 > S["CAT_TICK_SIZE"] * 1.25 else math.pi / 2


def _style_cat_xaxis(p, S, angle=math.pi / 4):
    ax = p.xaxis[0]
    ax.group_text_font_size = "0px"
    ax.group_text_color = None
    ax.major_label_orientation = angle
    ax.major_label_text_font_size = bk.px(S["CAT_TICK_SIZE"])
    ax.major_tick_line_color = None
    ax.separator_line_color = None


def _row_positions(groups, gap=0.6):
    """Posicoes y (de cima para baixo) com espaco extra entre familias."""
    ys, y, prev = {}, 0.0, None
    for g in groups:
        if prev is not None and g.family != prev:
            y -= gap
        ys[g.key] = y
        y -= 1.0
        prev = g.family
    return ys


def _row_axis(p, S, groups, ys):
    p.yaxis.ticker = [ys[g.key] for g in groups]
    p.yaxis.major_label_overrides = {ys[g.key]: g.label for g in groups}
    p.yaxis.major_tick_line_color = None
    p.ygrid.grid_line_color = None


def _legend_items_groups(p, groups, S, with_markers=True):
    """Renderers invisiveis so para compor legendas de grupos."""
    from bokeh.models import LegendItem
    items = []
    for g in groups:
        is_ref = g.source == "tcr"
        lw = S["REF_LINE_WIDTH"] if is_ref else S["LINE_WIDTH"]
        rs = [p.line([np.nan], [np.nan], line_color=g.color, line_width=lw, line_dash=g.dash)]
        if with_markers:
            rs.append(p.scatter([np.nan], [np.nan], marker=g.marker, fill_color=g.color,
                                line_color="white",
                                size=S["REF_MARKER_SIZE"] * 0.75 if is_ref else S["MARKER_SIZE"] * 1.3))
        items.append(LegendItem(label=g.label, renderers=rs))
    return items


def legend_strip(groups, S, width, height, ncols):
    """Figura so com a legenda de grupos (para paineis)."""
    from bokeh.models import Legend, Range1d
    p = _figure(S, width, height, x_range=Range1d(0, 1), y_range=Range1d(0, 1))
    bk.style_figure(p, S)
    p.axis.visible = False
    p.grid.grid_line_color = None
    p.min_border = 0
    leg = Legend(items=_legend_items_groups(p, groups, S), location="center",
                 orientation="horizontal")
    bk.style_legend(leg, S, ncols=ncols)
    p.add_layout(leg, "center")
    return p


# ==========================================================================
# Figuras principais
# ==========================================================================
def fig_sensitivity(cfg, S, groups, sens, stat, w, h, title, legend="right"):
    from bokeh.models import Legend, Span, ColumnDataSource, HoverTool
    cut = cfg["cutoffs"]
    p = _figure(S, w, h, x_range=(cut[0] - 0.25, cut[-1] + 0.25),
                y_range=(0, cfg["pep_len"] + 0.5))
    bk.style_figure(p, S, title=title, xlabel="Distance cutoff (Å)",
                    ylabel=("Peptide residues in contact" if stat == "mean"
                            else "Peptide residues in contact (best)"))
    p.xaxis.ticker = list(range(int(math.ceil(cut[0])), int(cut[-1]) + 1))
    p.yaxis.ticker = list(range(0, cfg["pep_len"] + 1, 2))
    if cfg["show_cutoff"]:
        p.add_layout(Span(location=cfg["cutoff"], dimension="height", line_color="#9a9a9a",
                          line_dash="dotted", line_width=S["AXIS_LINE_WIDTH"]))
    items = []
    from bokeh.models import LegendItem
    order = sorted(groups, key=lambda g: {"docked": 0, "generated": 1, "tcr": 2}[g.source])
    for g in order:
        y = sens[g.key][stat]
        src = ColumnDataSource(dict(x=cut, y=y, grp=[g.label] * len(cut)))
        is_ref = g.source == "tcr"
        if cfg["show_sem"] and stat == "mean" and not is_ref:
            e = sens[g.key]["sem"]
            p.varea(x=cut, y1=y - e, y2=y + e, fill_color=g.color, fill_alpha=S["BAND_ALPHA"])
        r1 = p.line("x", "y", source=src, line_color=g.color, line_dash=g.dash,
                    line_width=S["REF_LINE_WIDTH"] if is_ref else S["LINE_WIDTH"])
        r2 = p.scatter("x", "y", source=src, marker=g.marker, fill_color=g.color,
                       line_color="white", line_width=1,
                       size=S["REF_MARKER_SIZE"] if is_ref else S["MARKER_SIZE"])
        items.append((g, LegendItem(label=g.label, renderers=[r1, r2])))
    p.add_tools(HoverTool(tooltips=[("", "@grp"), ("cutoff", "@x Å"), ("contacts", "@y{0.00}")]))
    if legend == "right":
        leg = Legend(items=[it for g in groups for gg, it in items if gg is g],
                     location="top_left")
        bk.style_legend(leg, S, ncols=max(1, math.ceil(len(groups) / S["LEGEND_ROWS_RIGHT"])))
        p.add_layout(leg, "right")
    return p


def fig_selectivity(cfg, S, groups, stats, w, h, title, values=None):
    from bokeh.models import ColumnDataSource, LabelSet, Span, Legend, LegendItem, HoverTool
    fac = _factors(groups)
    st = stats.loc[[g.key for g in groups]]
    values = cfg["show_values"] if values is None else values
    ymax = st.ratio.max() * (1.16 if values else 1.06)
    p = _figure(S, w, h, x_range=_cat_x_range(groups), y_range=(0, ymax))
    bk.style_figure(p, S, title=title, ylabel="Selectivity ratio", xgrid=False)
    _style_cat_xaxis(p, S, _auto_angle(S, groups, w))
    src = ColumnDataSource(dict(
        x=fac, top=st.ratio.values, color=[g.color for g in groups],
        hatch=["/" if r else " " for r in st.ratio_raw],
        txt=[f"{v:.1f}" for v in st.ratio.values], grp=[g.label for g in groups],
        mx=st.max_pep.values, mhc=st.mhc_at_max.values, nat=st.n_at_max.values))
    p.vbar(x="x", top="top", width=S["BAR_WIDTH"], source=src, fill_color="color",
           line_color=None, hatch_pattern="hatch", hatch_color="white",
           hatch_weight=S["AXIS_LINE_WIDTH"], hatch_scale=S["TICK_SIZE"] * 0.55)
    if values:
        p.add_layout(LabelSet(x="x", y="top", text="txt", source=src, text_align="center",
                              y_offset=4, text_font=S["FONT"],
                              text_font_size=bk.px(S["VALUE_SIZE"]), text_color="#555555"))
    tcr = next((g for g in groups if g.source == "tcr"), None)
    if cfg["show_ref"] and tcr is not None:
        p.add_layout(Span(location=float(st.loc[tcr.key, "ratio"]), dimension="width",
                          line_color=TCR_COLOR, line_dash="dashed",
                          line_width=S["AXIS_LINE_WIDTH"]))
    if st.ratio_raw.any():
        dummy = p.vbar(x=[fac[0]], top=[np.nan], width=0.1, fill_color="#9a9a9a",
                       line_color=None, hatch_pattern="/", hatch_color="white")
        leg = Legend(items=[LegendItem(label="no MHC contact (ratio = peptide contacts)",
                                       renderers=[dummy])], location="top_right")
        bk.style_legend(leg, S)
        leg.click_policy = "none"
        p.add_layout(leg)
    p.add_tools(HoverTool(tooltips=[("", "@grp"), ("ratio", "@top{0.00}"),
                                    ("max peptide", "@mx"), ("MHC at max", "@mhc"),
                                    ("n at max", "@nat")]))
    return p


def fig_best_contacts(cfg, S, groups, stats, w, h, title):
    from bokeh.models import (ColumnDataSource, Range1d, LinearAxis, Legend, LegendItem,
                              Span, HoverTool, LabelSet)
    from bokeh.transform import dodge
    fac = _factors(groups)
    st = stats.loc[[g.key for g in groups]]
    p = _figure(S, w, h, x_range=_cat_x_range(groups), y_range=(0, cfg["pep_len"] + 0.6))
    bk.style_figure(p, S, title=title, ylabel="Max. peptide contacts", xgrid=False)
    p.yaxis.ticker = list(range(0, cfg["pep_len"] + 1, 2))
    rmax = st.ratio.max() * 1.06
    p.extra_y_ranges = {"ratio": Range1d(0, rmax)}
    ax2 = LinearAxis(y_range_name="ratio", axis_label="Selectivity ratio")
    p.add_layout(ax2, "right")
    bk.style_figure(p, S)                      # re-aplica estilo ao eixo novo
    _style_cat_xaxis(p, S, _auto_angle(S, groups, w))

    bw = S["BAR_WIDTH"] / 2 - 0.02
    src = ColumnDataSource(dict(
        x=fac, mx=st.max_pep.values, ratio=st.ratio.values,
        color=[g.color for g in groups], grp=[g.label for g in groups],
        hatch=["/" if r else " " for r in st.ratio_raw], mhc=st.mhc_at_max.values,
        mxt=[str(int(v)) for v in st.max_pep.values]))
    r1 = p.vbar(x=dodge("x", -S["BAR_DODGE"], range=p.x_range), top="mx", width=bw,
                source=src, fill_color="color", line_color=None)
    r2 = p.vbar(x=dodge("x", S["BAR_DODGE"], range=p.x_range), top="ratio", width=bw,
                source=src, y_range_name="ratio", fill_color="color", fill_alpha=0.33,
                line_color="color", line_width=S["AXIS_LINE_WIDTH"] * 0.8,
                hatch_pattern="hatch", hatch_color="color", hatch_alpha=0.8,
                hatch_scale=S["TICK_SIZE"] * 0.45)
    tcr = next((g for g in groups if g.source == "tcr"), None)
    if cfg["show_ref"] and tcr is not None:
        p.add_layout(Span(location=float(st.loc[tcr.key, "max_pep"]), dimension="width",
                          line_color=TCR_COLOR, line_dash="dashed",
                          line_width=S["AXIS_LINE_WIDTH"]))
    d1 = p.vbar(x=[fac[0]], top=[np.nan], width=0.1, fill_color="#6f6f6f", line_color=None)
    d2 = p.vbar(x=[fac[0]], top=[np.nan], width=0.1, fill_color="#6f6f6f", fill_alpha=0.33,
                line_color="#6f6f6f", line_width=S["AXIS_LINE_WIDTH"] * 0.8)
    leg = Legend(items=[LegendItem(label="Max. peptide contacts (left)", renderers=[d1]),
                        LegendItem(label="Selectivity ratio (right)", renderers=[d2])],
                 orientation="horizontal", location="top_left")
    bk.style_legend(leg, S)
    leg.click_policy = "none"
    p.add_layout(leg, "above")
    p.add_tools(HoverTool(renderers=[r1, r2], tooltips=[
        ("", "@grp"), ("max peptide", "@mx"), ("ratio", "@ratio{0.00}"), ("MHC at max", "@mhc")]))
    return p


def fig_hotspot(cfg, S, hs, title="Binder contact hotspot"):
    from bokeh.layouts import gridplot
    from bokeh.models import Legend, LegendItem, Range1d, Title, Span, Label
    bins = cfg["bins"]
    ncols = S["HOT_NCOLS"]
    ymax_all = max(max(h["freq"].max() for h in hs) * 1.18, 5)   # folga p/ rotulo do pico
    ss_col = {"H": bk.COLORS["ss_H"], "E": bk.COLORS["ss_E"], "C": bk.COLORS["ss_C"]}
    figs = []
    for i, h in enumerate(hs):
        ymax = ymax_all if cfg["hot_shared_y"] else max(h["freq"].max() * 1.22, 5)
        first_col, last_row = i % ncols == 0, i >= len(hs) - ncols
        p = _figure(S, S["HOT_CELL_W"], S["HOT_CELL_H"],
                    x_range=Range1d(-0.5, bins - 0.5), y_range=Range1d(0, ymax))
        bk.style_figure(p, S, xgrid=False)
        p.title = Title(text=h["label"], text_font=S["FONT"], align="left",
                        text_font_size=bk.px(S["SMALL_TITLE_SIZE"]), text_font_style="bold",
                        text_color=h["group"].color if h["group"].source != "tcr" else TCR_COLOR)
        x = np.arange(bins)
        # SS em resolucao de residuo, no mesmo eixo relativo dos bins (-0.5 .. bins-0.5)
        segs = ss_segments(h["ss"])
        sc = bins / len(h["ss"])
        p.quad(left=[a * sc - 0.5 for a, _, _ in segs], right=[e * sc - 0.5 for _, e, _ in segs],
               bottom=0, top=ymax, fill_color=[ss_col[s] for _, _, s in segs], line_color=None)
        col = h["group"].color
        p.varea(x=x, y1=0, y2=h["freq"], fill_color=col, fill_alpha=0.35)
        p.line(x, h["freq"], line_color=col, line_width=S["LINE_WIDTH"] * 0.8)
        if cfg["hot_peak"] and h["freq"].max() > 0:
            # pico: linha tracejada + posicao relativa no binder (como no original)
            pk = int(np.argmax(h["freq"]))
            pos = pk / (bins - 1) * 100
            p.add_layout(Span(location=pk, dimension="height", line_color=col, line_alpha=0.6,
                              line_dash="dashed", line_width=S["AXIS_LINE_WIDTH"] * 0.8))
            right = pk > bins * 0.7
            p.add_layout(Label(x=pk, y=h["freq"][pk], text=f"{pos:.0f}%",
                               text_align="right" if right else "left", text_baseline="bottom",
                               x_offset=-4 if right else 4, y_offset=2, text_font=S["FONT"],
                               text_font_size=bk.px(S["VALUE_SIZE"]), text_font_style="bold",
                               text_color=col if h["group"].source != "tcr" else TCR_COLOR))
        p.xaxis.ticker = [0, bins - 1]
        p.xaxis.major_label_overrides = {0: "N", bins - 1: "C"}
        p.yaxis.ticker.desired_num_ticks = 3
        if not first_col:
            p.yaxis.major_label_text_font_size = "0px"
        if first_col:
            p.yaxis.axis_label = "Contact (%)"
            p.yaxis.axis_label_text_font_size = bk.px(S["TICK_SIZE"])
        figs.append(p)
    # celula de legenda (SS)
    lp = _figure(S, S["HOT_CELL_W"] * max(1, ncols * math.ceil(len(hs) / ncols) - len(hs)),
                 S["HOT_CELL_H"], x_range=Range1d(0, 1), y_range=Range1d(0, 1))
    bk.style_figure(lp, S)
    lp.axis.visible = False
    lp.grid.grid_line_color = None
    its = [LegendItem(label=l, renderers=[lp.quad(left=[np.nan], right=[np.nan], bottom=[np.nan],
                                                  top=[np.nan], fill_color=ss_col[k],
                                                  line_color="#bbbbbb")])
           for k, l in (("H", "Helix"), ("E", "Strand"), ("C", "Loop"))]
    leg = Legend(items=its, location="center")
    bk.style_legend(leg, S)
    leg.click_policy = "none"
    lp.add_layout(leg, "center")
    cells = figs + [lp]
    rows = [cells[i:i + ncols] for i in range(0, len(cells), ncols)]
    return gridplot(rows, toolbar_location=None, merge_tools=True)


def _violin(p, vals, y, color, S, width, lo=0, hi=180):
    from scipy.stats import gaussian_kde
    vals = vals[np.isfinite(vals)]
    if len(vals) < 3 or np.ptp(vals) < 1e-6:
        return
    grid = np.linspace(max(lo, vals.min()), min(hi, vals.max()), 256)
    dens = gaussian_kde(vals)(grid)
    dens = dens / dens.max() * width / 2
    p.patch(np.concatenate([grid, grid[::-1]]), np.concatenate([y + dens, (y - dens)[::-1]]),
            fill_color=color, fill_alpha=0.75, line_color=color, line_width=1)
    q1, q2, q3 = np.percentile(vals, [25, 50, 75])
    p.segment(q1, y, q3, y, line_color="#2a2a2a", line_width=S["LINE_WIDTH"] * 1.3)
    p.scatter([q2], [y], marker="circle", size=S["MARKER_SIZE"] * 1.1, fill_color="white",
              line_color="#2a2a2a", line_width=1.5)


def fig_terminal(cfg, S, groups, term, metric="angle"):
    """metric: angle (0-180) | height_norm (altura / Rg)."""
    from bokeh.layouts import row
    from bokeh.models import Span, Label, Range1d
    ys = _row_positions(groups)
    ylo, yhi = min(ys.values()) - 0.7, max(ys.values()) + (1.5 if metric == "angle" else 0.7)
    h = S["TERM_ROW_H"] * (yhi - ylo) + 6 * S["AXIS_LABEL_SIZE"]
    col = {"angle": ("n_angle", "c_angle"), "height_norm": ("n_height_norm", "c_height_norm")}[metric]
    if metric == "angle":
        lo, hi = 0.0, 180.0
    else:
        v = term[list(col)].values
        lo, hi = np.nanpercentile(v, 0.5), np.nanpercentile(v, 99.5)
        pad = (hi - lo) * 0.05
        lo, hi = lo - pad, hi + pad
    figs = []
    for j, (c, name) in enumerate(zip(col, ("N-terminus", "C-terminus"))):
        p = _figure(S, S["TERM_W"] + (S["AXIS_LABEL_SIZE"] * 7 if j == 0 else 0), h,
                    x_range=Range1d(lo, hi), y_range=Range1d(ylo, yhi))
        bk.style_figure(p, S, title=name,
                        xlabel="Angle (°)" if metric == "angle" else "Height / Rg")
        _row_axis(p, S, groups, ys)
        if j > 0:
            p.yaxis.major_label_text_font_size = "0px"
        if metric == "angle":
            p.xaxis.ticker = [0, 45, 90, 135, 180]
            p.add_layout(Span(location=90, dimension="height", line_color="#9a9a9a",
                              line_dash="dotted", line_width=S["AXIS_LINE_WIDTH"]))
            for x, t, al in ((2, "away from MHC", "left"), (178, "toward MHC", "right")):
                p.add_layout(Label(x=x, y=yhi, text=t, text_align=al, text_baseline="top",
                                   text_font=S["FONT"], text_font_size=bk.px(S["VALUE_SIZE"]),
                                   text_color=bk.COLORS["muted"], y_offset=-2))
        else:
            p.add_layout(Span(location=0, dimension="height", line_color="#9a9a9a",
                              line_dash="dotted", line_width=S["AXIS_LINE_WIDTH"]))
        for g in groups:
            vals = term.loc[term.group == g.key, c].values.astype(float)
            if g.source == "tcr":
                p.scatter(vals, [ys[g.key]] * len(vals), marker="star", fill_color=TCR_COLOR,
                          line_color="white", size=S["REF_MARKER_SIZE"])
                continue
            _violin(p, vals, ys[g.key], g.color, S, S["VIOLIN_WIDTH"], lo, hi)
        figs.append(p)
    return row(*figs, spacing=S["PANEL_HGAP"] // 2)


def _text_w(t, fs):
    return len(t) * fs * 0.56 + 4


def _overlaps(b, boxes):
    return any(not (b[2] <= o[0] or b[0] >= o[2] or b[3] <= o[1] or b[1] >= o[3]) for o in boxes)


def _place_labels(pts, labels, fs, frame_w, frame_h, r0):
    """Posicionamento guloso de rotulos em pixels, sem colisao.
    pts: (n,2) px (origem embaixo-esquerda). Retorna [(lx, ly, align, leader)]."""
    def tw(t):
        return _text_w(t, fs)
    th = fs * 1.2
    boxes = [(x - r0, y - r0, x + r0, y + r0) for x, y in pts]      # pontos sao obstaculos
    placed = []
    angles = [0, 180, 35, -35, 145, -145, 90, -90, 60, -60, 120, -120]
    for (x, y), t in zip(pts, labels):
        w = tw(t)
        best = None
        for dist in (1.0, 1.7, 2.5, 3.4, 4.5, 6.0):
            for a in angles:
                ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
                ax_, ay_ = x + ca * r0 * dist * 1.25, y + sa * r0 * dist * 1.25
                if ca > 0.3:
                    b = (ax_, ay_ - th / 2, ax_ + w, ay_ + th / 2); al = "left"
                elif ca < -0.3:
                    b = (ax_ - w, ay_ - th / 2, ax_, ay_ + th / 2); al = "right"
                else:
                    b = (ax_ - w / 2, ay_ - th / 2, ax_ + w / 2, ay_ + th / 2); al = "center"
                if b[0] < 0 or b[2] > frame_w or b[1] < 0 or b[3] > frame_h:
                    continue
                if _overlaps(b, boxes):
                    continue
                best = (ax_, ay_, al, dist > 1.0, b)
                break
            if best:
                break
        if best is None:                                            # sem espaco: ao lado
            best = (x + r0 * 1.25, y, "left", False, (x, y, x, y))
        boxes.append(best[4])
        placed.append(best[:4])
    return placed


def fig_best_candidates(cfg, S, groups, stats, w, h, title):
    """Equivalente ao fig4_best: x = contatos com o MHC nas estruturas de max
    peptideo (MHC_STAT), y = max contatos com o peptideo. Pontos coincidentes
    (eixos inteiros) sao espalhados numa grade compacta ao redor do valor real."""
    from bokeh.models import Range1d, Label, ColumnDataSource, HoverTool
    st = stats.loc[[g.key for g in groups]]
    X, Y = st.mhc_at_max.values.astype(float), st.max_pep.values.astype(float)
    xlo, xhi = X.min() - 1.6, X.max() + 1.6
    ylo, yhi = Y.min() - 0.75, Y.max() + 0.75
    p = _figure(S, w, h, x_range=Range1d(xlo, xhi), y_range=Range1d(ylo, yhi))
    xlab = "MHC contacts at max. peptide" + (" (min)" if cfg["mhc_stat"] == "min" else " (median)")
    bk.style_figure(p, S, title=title, xlabel=xlab, ylabel="Max. peptide contacts")
    p.yaxis.ticker = list(range(int(ylo) + 1, int(yhi) + 1))
    p.xaxis.ticker.desired_num_ticks = 6

    # tamanho aproximado do frame em px -> conversao dado<->px
    fw = w - (S["AXIS_LABEL_SIZE"] + S["TICK_SIZE"] * 2.2 + S["MIN_BORDER"] * 2)
    fh = h - (S["TITLE_SIZE"] * 1.6 + S["AXIS_LABEL_SIZE"] + S["TICK_SIZE"] * 1.6 + S["MIN_BORDER"] * 2)
    ux, uy = fw / (xhi - xlo), fh / (yhi - ylo)

    # espalha pontos coincidentes numa grade (em px) centrada no valor real
    ms = S["MARKER_SIZE"] * 2.0
    step = ms * 1.15
    px_ = np.zeros((len(groups), 2))
    for key in set(zip(X, Y)):
        idx = [i for i in range(len(groups)) if (X[i], Y[i]) == key]
        k = len(idx)
        nc = int(math.ceil(math.sqrt(k)))
        nr = int(math.ceil(k / nc))
        for j, i in enumerate(idx):
            r, c = divmod(j, nc)
            cols_in_row = nc if r < nr - 1 else k - nc * (nr - 1)
            px_[i] = ((X[i] - xlo) * ux + (c - (cols_in_row - 1) / 2) * step,
                      (Y[i] - ylo) * uy - (r - (nr - 1) / 2) * step)

    src = ColumnDataSource(dict(
        x=xlo + px_[:, 0] / ux, y=ylo + px_[:, 1] / uy, color=[g.color for g in groups],
        marker=[g.marker for g in groups], grp=[g.label for g in groups],
        size=[S["REF_MARKER_SIZE"] * 1.1 if g.source == "tcr" else ms for g in groups],
        mhc=X, pep=Y, nat=st.n_at_max.values))
    r = p.scatter("x", "y", source=src, marker="marker", size="size", fill_color="color",
                  line_color="white", line_width=1.2)
    p.add_tools(HoverTool(renderers=[r], tooltips=[("", "@grp"), ("max peptide", "@pep"),
                                                   ("MHC", "@mhc"), ("n at max", "@nat")]))

    if cfg["best_labels"]:
        fs = S["VALUE_SIZE"] * 1.05
        lab = _place_labels(px_, [g.label for g in groups], fs, fw, fh, ms * 0.6)
        for g, (lx, ly, al, leader), (x0, y0) in zip(groups, lab, px_):
            if leader:
                p.segment(xlo + x0 / ux, ylo + y0 / uy, xlo + lx / ux, ylo + ly / uy,
                          line_color="#b5b5b5", line_width=1)
            p.add_layout(Label(x=xlo + lx / ux, y=ylo + ly / uy, text=g.label, text_align=al,
                               text_baseline="middle", text_font=S["FONT"],
                               text_font_size=bk.px(fs),
                               text_font_style="bold" if g.source == "tcr" else "normal",
                               text_color=g.color if g.source != "docked" else "#4a5561"))
    return p


def build_panel(cfg, S, groups, sens, stats):
    from bokeh.layouts import column, row
    W = S["PANEL_W"]
    wa = int((W - S["PANEL_HGAP"]) * S["PANEL_TOP_SPLIT"])
    wb = W - S["PANEL_HGAP"] - wa
    a = fig_sensitivity(cfg, S, groups, sens, "mean", wa, S["PANEL_TOP_H"],
                        "A  Contact sensitivity", legend=None)
    b = fig_best_candidates(cfg, S, groups, stats, wb, S["PANEL_TOP_H"], "B  Best candidates")
    c = fig_best_contacts(cfg, S, groups, stats, W, S["PANEL_BOTTOM_H"],
                          "C  Peptide contacts · best structures")
    leg = legend_strip(groups, S, W, S["PANEL_LEGEND_H"], S["LEGEND_NCOLS"])
    return column(row(a, b, spacing=S["PANEL_HGAP"]), c, leg, spacing=S["PANEL_VGAP"])


# ==========================================================================
# Extras
# ==========================================================================
def fig_hotspot_heatmap(cfg, S, hs, transpose=False, w=None, h=None, title="Binder contact hotspot"):
    from bokeh.models import LinearColorMapper, ColorBar, Range1d, ColumnDataSource, HoverTool
    bins = cfg["bins"]
    pal = _seq_palette()
    vmax = max(h_["freq"].max() for h_ in hs)
    mapper = LinearColorMapper(palette=pal, low=0, high=vmax)
    xs, ys_, vs, labs = [], [], [], []
    for i, h_ in enumerate(hs):
        for b in range(bins):
            if transpose:
                xs.append(i); ys_.append(b)
            else:
                xs.append(b); ys_.append(-i)
            vs.append(h_["freq"][b]); labs.append(h_["label"])
    src = ColumnDataSource(dict(x=xs, y=ys_, v=vs, lab=labs))
    if transpose:
        w = w or S["HEAT_CELL_W"] * len(hs) * 1.6 + 200
        h = h or S["HEAT_ROW_H"] * bins + 220
        p = _figure(S, w, h, x_range=Range1d(-0.5, len(hs) - 0.5), y_range=Range1d(-0.5, bins - 0.5))
        bk.style_figure(p, S, title=title, ylabel="Binder position", xgrid=False, ygrid=False)
        p.xaxis.ticker = list(range(len(hs)))
        p.xaxis.major_label_overrides = {i: h_["label"] for i, h_ in enumerate(hs)}
        p.xaxis.major_label_orientation = math.pi / 4
        p.yaxis.ticker = [0, bins - 1]
        p.yaxis.major_label_overrides = {0: "N", bins - 1: "C"}
        p.rect("x", "y", 0.94, 0.94, source=src, fill_color={"field": "v", "transform": mapper},
               line_color=None)
    else:
        w = w or S["HEAT_CELL_W"] * bins + 460
        h = h or S["HEAT_ROW_H"] * len(hs) + 200
        p = _figure(S, w, h, x_range=Range1d(-0.5, bins - 0.5), y_range=Range1d(-len(hs) + 0.5, 0.5))
        bk.style_figure(p, S, title=title, xlabel="Binder position", xgrid=False, ygrid=False)
        p.yaxis.ticker = [-i for i in range(len(hs))]
        p.yaxis.major_label_overrides = {-i: h_["label"] for i, h_ in enumerate(hs)}
        p.xaxis.ticker = [0, bins - 1]
        p.xaxis.major_label_overrides = {0: "N", bins - 1: "C"}
        p.rect("x", "y", 0.94, 0.94, source=src, fill_color={"field": "v", "transform": mapper},
               line_color=None)
    p.axis.major_tick_line_color = None
    cb = ColorBar(color_mapper=mapper, title="Contact (%)", title_text_font=S["FONT"],
                  title_text_font_size=bk.px(S["TICK_SIZE"]), title_text_font_style="normal",
                  major_label_text_font=S["FONT"], major_label_text_font_size=bk.px(S["TICK_SIZE"]),
                  bar_line_color=None, major_tick_line_color=None, width=int(S["TICK_SIZE"] * 0.9),
                  padding=int(S["TICK_SIZE"] * 0.5))
    p.add_layout(cb, "right")
    p.add_tools(HoverTool(tooltips=[("", "@lab"), ("contact", "@v{0.0}%")]))
    return p


def _seq_palette(n=256):
    # branco -> azul-petroleo -> quase preto (perceptualmente suave)
    stops = [(0.0, (255, 255, 255)), (0.25, (198, 219, 239)), (0.55, (66, 146, 198)),
             (0.8, (8, 81, 156)), (1.0, (8, 36, 70))]
    out = []
    for i in range(n):
        t = i / (n - 1)
        for (t0, c0), (t1, c1) in zip(stops[:-1], stops[1:]):
            if t0 <= t <= t1:
                f = (t - t0) / (t1 - t0)
                out.append("#%02x%02x%02x" % tuple(round(a + (b - a) * f) for a, b in zip(c0, c1)))
                break
    return out


def fig_dumbbell(cfg, S, groups, stats, w, h, title="Typical vs best structure"):
    """Media (circulo vazado) -> melhor estrutura (cheio), eixo categorico como as barras."""
    from bokeh.models import Span, Legend, LegendItem
    fac = _factors(groups)
    p = _figure(S, w, h, x_range=_cat_x_range(groups), y_range=(0, cfg["pep_len"] + 0.6))
    bk.style_figure(p, S, title=title, ylabel="Peptide residues in contact", xgrid=False)
    _style_cat_xaxis(p, S, _auto_angle(S, groups, w))
    p.yaxis.ticker = list(range(0, cfg["pep_len"] + 1, 2))
    tcr = next((g for g in groups if g.source == "tcr"), None)
    if cfg["show_ref"] and tcr is not None:
        p.add_layout(Span(location=float(stats.loc[tcr.key, "max_pep"]), dimension="width",
                          line_color=TCR_COLOR, line_dash="dashed", line_width=S["AXIS_LINE_WIDTH"]))
    ms = S["MARKER_SIZE"] * 1.6
    for g, x in zip(groups, fac):
        s = stats.loc[g.key]
        if g.source == "tcr":
            p.scatter([x], [s.max_pep], marker="star", size=S["REF_MARKER_SIZE"],
                      fill_color=TCR_COLOR, line_color="white")
            continue
        p.segment([x], [s.mean_pep], [x], [s.max_pep], line_color=g.color,
                  line_width=S["LINE_WIDTH"] * 1.4, line_alpha=0.7)
        p.scatter([x], [s.mean_pep], size=ms, fill_color="white", line_color=g.color,
                  line_width=S["LINE_WIDTH"] * 0.8)
        p.scatter([x], [s.max_pep], size=ms, fill_color=g.color, line_color="white")
    d1 = p.scatter([fac[0]], [np.nan], size=ms, fill_color="white", line_color="#555555",
                   line_width=S["LINE_WIDTH"] * 0.8)
    d2 = p.scatter([fac[0]], [np.nan], size=ms, fill_color="#555555", line_color="white")
    leg = Legend(items=[LegendItem(label="mean", renderers=[d1]),
                        LegendItem(label="best structure", renderers=[d2])],
                 orientation="horizontal", location="top_left")
    bk.style_legend(leg, S)
    leg.click_policy = "none"
    p.add_layout(leg, "above")
    return p


def fig_terminal_categories(cfg, S, groups, term, w, h, title=None):
    """% de estruturas por categoria: N e C apontando para longe do MHC
    (angulo < TERM_AWAY_ANGLE), so N, so C, nenhum. TCR: fracao sobre as cadeias."""
    from bokeh.models import Range1d, Legend, LegendItem, Label
    thr = cfg["term_away"]
    ys = _row_positions(groups)
    ylo, yhi = min(ys.values()) - 0.7, max(ys.values()) + 0.7
    cats = [("both", "N and C", "#1b7837"), ("n", "N only", "#7fbf7b"),
            ("c", "C only", "#c2a5cf"), ("none", "neither", "#dedede")]
    p = _figure(S, w, h, x_range=Range1d(0, 100), y_range=Range1d(ylo, yhi))
    bk.style_figure(p, S, title=title or "Termini pointing away from MHC",
                    xlabel=f"Structures (%) · away = angle < {thr:g}°")
    _row_axis(p, S, groups, ys)
    p.xaxis.ticker = [0, 25, 50, 75, 100]
    rend, rows = {}, []
    for g in groups:
        t = term[term.group == g.key]
        if t.empty:
            continue
        n_away, c_away = t.n_angle < thr, t.c_angle < thr
        fr = {"both": (n_away & c_away).mean(), "n": (n_away & ~c_away).mean(),
              "c": (~n_away & c_away).mean(), "none": (~n_away & ~c_away).mean()}
        left = 0
        for k, lab, col in cats:
            v = fr[k] * 100
            rend[k] = p.hbar(y=ys[g.key], left=left, right=left + v, height=S["BAR_WIDTH"],
                             fill_color=col, line_color="white", line_width=1)
            left += v
        both = fr["both"] * 100
        inside = both >= 12                       # % de "N e C": dentro da barra, ou logo apos
        p.add_layout(Label(x=both, y=ys[g.key], text=f"{both:.0f}%",
                           text_align="right" if inside else "left", text_baseline="middle",
                           x_offset=-6 if inside else 4, text_font=S["FONT"],
                           text_font_size=bk.px(S["VALUE_SIZE"]), text_font_style="bold",
                           text_color="white" if inside else "#1b5e2e"))
        rows.append(dict(group=g.key, n_rows=len(t), **{k: fr[k] for k in fr}))
    leg = Legend(items=[LegendItem(label=lab, renderers=[rend[k]]) for k, lab, _ in cats if k in rend],
                 orientation="horizontal", location="top_left")
    bk.style_legend(leg, S)
    leg.click_policy = "none"
    p.add_layout(leg, "above")
    p.xgrid.grid_line_color = None
    return p, pd.DataFrame(rows)


def build_alt_panel(cfg, S, groups, sens, stats, hs):
    from bokeh.layouts import column, row
    W = S["PANEL_W"]
    wa = int((W - S["PANEL_HGAP"]) * S["PANEL_TOP_SPLIT"])
    wb = W - S["PANEL_HGAP"] - wa
    top_h = S["PANEL_TOP_H"] + S["PANEL_LEGEND_H"] // 2
    a = fig_sensitivity(cfg, S, groups, sens, "mean", wa, top_h, "A  Contact sensitivity",
                        legend=None)
    b = fig_dumbbell(cfg, S, groups, stats, wb, top_h, "B  Typical vs best structure")
    c = fig_hotspot_heatmap(cfg, S, hs, transpose=True, w=W,
                            h=S["PANEL_BOTTOM_H"] + S["PANEL_LEGEND_H"] // 2,
                            title="C  Binder contact hotspot")
    return column(row(a, b, spacing=S["PANEL_HGAP"]), c, spacing=S["PANEL_VGAP"])


# ==========================================================================
# Main
# ==========================================================================
def main():
    cfg, S = load_config()
    for k in ("fig_main", "fig_extra", "csv", "cache"):
        cfg[k].mkdir(parents=True, exist_ok=True)
    print(f"[PART1] MHC={cfg['mhc']}  modo={S['MODE']}  cutoff={cfg['cutoff']} Å")
    print(f"        saida: {cfg['out']}")

    print("[DADOS] features por grupo")
    groups, recs = load_all(cfg)
    if not groups:
        raise SystemExit("[ERRO] nenhum grupo carregado")

    df = contact_table(groups, recs, cfg["cutoff"])
    sens = sensitivity(groups, recs, cfg["cutoffs"])
    stats = best_stats(groups, df, cfg["mhc_stat"])
    hs = hotspot(groups, recs, cfg["cutoff"], cfg["bins"])
    term = terminals(groups, recs, cfg["term_origin"])

    # ---- CSVs --------------------------------------------------------------
    tag = f"c{cfg['cutoff']:g}"
    df.to_csv(cfg["csv"] / f"contacts_per_structure_{tag}.csv", index=False)
    stats.to_csv(cfg["csv"] / f"best_structures_{tag}.csv")
    pd.DataFrame([dict(group=k, cutoff=c, **{s: v[s][i] for s in ("mean", "sem", "max", "median")})
                  for k, v in sens.items() for i, c in enumerate(cfg["cutoffs"])]
                 ).to_csv(cfg["csv"] / "contact_sensitivity.csv", index=False)
    pd.DataFrame([dict(key=h["key"], bin=b, freq_pct=h["freq"][b],
                       ss=ss_for_bin(h["ss"], b, cfg["bins"]))
                  for h in hs for b in range(cfg["bins"])]
                 ).to_csv(cfg["csv"] / f"binder_hotspot_{tag}.csv", index=False)
    term.to_csv(cfg["csv"] / "terminal_geometry.csv", index=False)
    print(f"[CSV] {cfg['csv']}")

    # ---- Figuras principais -------------------------------------------------
    F, E, fm = cfg["fig_main"], cfg["fig_extra"], cfg["formats"]
    print("[FIG] principais")
    bk.save(fig_sensitivity(cfg, S, groups, sens, "mean", S["FIG_W"], S["FIG_H"],
                            "Contact sensitivity"), F, "contact_sensitivity_mean", S, fm)
    bk.save(fig_sensitivity(cfg, S, groups, sens, "max", S["FIG_W"], S["FIG_H"],
                            "Contact sensitivity · best structure"), F, "contact_sensitivity_max", S, fm)
    bk.save(fig_selectivity(cfg, S, groups, stats, S["BAR_FIG_W"], S["BAR_FIG_H"],
                            "Peptide selectivity"), F, "selectivity_ratio", S, fm)
    bk.save(fig_best_candidates(cfg, S, groups, stats, S["FIG_W"], S["FIG_H"],
                                "Best candidates"), F, "best_candidates", S, fm)
    bk.save(fig_best_contacts(cfg, S, groups, stats, S["BAR_FIG_W"], S["BAR_FIG_H"],
                              "Peptide contacts · best structures"), F, "peptide_contact_best", S, fm)
    bk.save(build_panel(cfg, S, groups, sens, stats), F, "panel_part1", S, fm)
    bk.save(fig_hotspot(cfg, S, hs), F, "binder_hotspot", S, fm)
    term_w = S["TERM_W"] + S["AXIS_LABEL_SIZE"] * 7
    term_h = S["TERM_ROW_H"] * (len(groups) + 6) + 6 * S["AXIS_LABEL_SIZE"]
    p, cat = fig_terminal_categories(cfg, S, groups, term, term_w, term_h)
    cat.to_csv(cfg["csv"] / "terminal_categories.csv", index=False)
    bk.save(p, F, "terminal_direction", S, fm)

    if cfg["extras"]:
        print("[FIG] extras")
        bk.save(fig_hotspot_heatmap(cfg, S, hs), E, "binder_hotspot_heatmap", S, fm)
        bk.save(fig_dumbbell(cfg, S, groups, stats, S["BAR_FIG_W"], S["BAR_FIG_H"]),
                E, "typical_vs_best", S, fm)
        bk.save(fig_terminal(cfg, S, groups, term, "angle"), E, "terminal_angles", S, fm)
        bk.save(fig_terminal(cfg, S, groups, term, "height_norm"), E, "terminal_height_norm", S, fm)
        bk.save(build_alt_panel(cfg, S, groups, sens, stats, hs), E, "panel_part1_alt", S, fm)

    bk.close_driver()
    print(f"[FIM] {cfg['out'] / 'figures' / S['MODE']}")


if __name__ == "__main__":
    main()
