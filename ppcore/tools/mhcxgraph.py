"""MHCXGraph (CNPEM/LNBio, v1.0): conserved exposed-surface regions across pMHC
structures by triad-based graph association.

Runs MHCXGraph's own pipeline (load_manifest → create_graphs → run_*_mode), with
emit_output patched so every run writes both the JSON payload (which the app turns
into 3D colouring, graph views and tables) and MHCXGraph's own dashboard HTML
(opened inside the app). Every manifest setting is exposed; see
https://cnpem.github.io/MHCXGraph/configuration/.
"""

from __future__ import annotations

import csv
import json
import logging
import os
import re
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, List

from .. import protocol

SETTINGS_DEFAULTS = {
    "run_mode": "multiple",               # multiple | pairwise | screening
    "reference_structure": None,          # name, for screening
    "node_granularity": "all_atoms",      # all_atoms | backbone | side_chain | ca_only
    "edge_threshold": 8.5,
    "include_ligands": True,
    "include_noncanonical_residues": True,
    "include_waters": True,
    "filter_triads_by_chain": None,
    "max_gap_helix": 0,
    "distance_bin_width": 2.0,
    "local_distance_diff_threshold": 1.0,
    "global_distance_diff_threshold": 2.0,
    "close_tolerance": 0.1,
    "rsa_filter": 0.1,
    "asa_filter": 5,
    "triad_rsa": False,
    "rsa_bin_width": 0.3,
    "rsa_diff_threshold": 0.3,
    "close_tolerance_rsa": 0.01,
    "max_chunks": 5,
    "show_std_edges": False,
    "output_structures": False,
    "watch_residues": None,
    "debug_logs": False,
}


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("_") or "structure"


def _read_csv(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        clean = {}
        for k, v in r.items():
            try:
                clean[k] = float(v) if v not in ("", None) and re.match(r"^-?[\d.eE+-]+$", v) else v
            except ValueError:
                clean[k] = v
        out.append(clean)
    return out


class _ForwardHandler(logging.Handler):
    """MHCXGraph logs its steps; forward them to the UI as progress messages."""

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if len(msg) > 160:
            msg = msg[:157] + "…"
        protocol.log(msg)


def run(params: Dict, workdir: str) -> Dict:
    import MHCXGraph.app as mx
    from MHCXGraph.utils.logging_utils import setup_logging
    from MHCXGraph.utils.preprocessing import create_graphs
    from MHCXGraph.workflow.manifest import build_association_config, load_manifest

    structures = params.get("structures") or []
    if len(structures) < 2:
        raise ValueError("O MHCXGraph precisa de pelo menos duas estruturas.")

    settings = dict(SETTINGS_DEFAULTS)
    settings.update({k: v for k, v in (params.get("settings") or {}).items() if k in SETTINGS_DEFAULTS})
    mode = settings["run_mode"]
    if mode not in ("multiple", "pairwise", "screening"):
        raise ValueError("Modo inválido: " + str(mode))

    # Inputs are copied under the names the user sees, because MHCXGraph names
    # proteins after their file stems.
    in_dir = Path(workdir) / "inputs"
    in_dir.mkdir(parents=True, exist_ok=True)
    names: List[str] = []
    for s in structures:
        src = s["input"]
        ext = ".cif" if src.lower().endswith((".cif", ".mmcif", ".cif.gz")) else ".pdb"
        base = _safe(s.get("name") or Path(src).stem)
        while base in names:
            base += "_"
        names.append(base)
        if src.endswith(".gz"):
            import gzip

            with gzip.open(src, "rb") as fi, open(in_dir / (base + ext), "wb") as fo:
                shutil.copyfileobj(fi, fo)
        else:
            shutil.copy(src, in_dir / (base + ext))

    if mode == "screening":
        ref = settings.get("reference_structure")
        ref_name = names[int(ref)] if isinstance(ref, int) else (_safe(ref) if ref else names[0])
        settings["reference_structure"] = ref_name

    selector = params.get("selector") or {}
    sel = {}
    for k in ("chains", "residues", "structures", "logic"):
        v = selector.get(k)
        if v:
            sel[k] = v
    manifest = {
        "settings": dict(settings, run_name="pp", output_path=str(Path(workdir) / "out"), generate_dashboard=True, verbose=False, debug_tracking=False),
        "inputs": [{"path": str(in_dir), "extensions": [".pdb", ".cif"], "enable_tui": False, "selectors": [{"name": "pp"}]}],
        "selectors": {"pp": sel},
    }
    if params.get("classes"):
        manifest["settings"]["classes"] = params["classes"]
        manifest["classes"] = params["classes"]
    manifest_path = Path(workdir) / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    protocol.progress(0.05, "Lendo manifesto")
    data = load_manifest(str(manifest_path))
    st = data["settings"]
    base_output = Path(st["output_path"])
    log = setup_logging(outdir=base_output / "pp", debug=bool(st.get("debug_logs")), verbose=False)
    logging.getLogger("MHCXGraph").addHandler(_ForwardHandler())
    tracker = mx.setup_trackers(output_dir=base_output / "pp", settings=st)
    config = build_association_config(st, mode, tracker)

    def emit_both(export_data, output_dir, _generate_dashboard, lg):
        mx.create_master_dashboard(export_data, output_dir, lg)
        mx.write_master_json(export_data, output_dir, lg)

    mx.emit_output = emit_both

    protocol.progress(0.15, "Construindo grafos de superfície")
    specs = create_graphs(data)
    protocol.progress(0.35, "Associação de tríades · modo " + mode)
    if mode == "multiple":
        mx.run_multiple_mode(specs, base_output, "pp", config, log, True)
        target = base_output / "MULTIPLE"
    elif mode == "pairwise":
        mx.run_pairwise_mode(specs, base_output, "pp", config, log, True)
        target = base_output / "PAIRWISE"
    else:
        ref_spec = next((s for s in specs if mx.clean_graph_name(s) == st["reference_structure"]), None)
        if ref_spec is None:
            raise ValueError("Estrutura de referência não encontrada: " + str(st["reference_structure"]))
        targets = [s for s in specs if mx.clean_graph_name(s) != st["reference_structure"]]
        mx.run_screening_mode(ref_spec, targets, base_output, "pp", config, log, True)
        target = base_output / "SCREENING"

    json_files = sorted(target.glob("graph_data_*.json"))
    if not json_files:
        raise RuntimeError("O MHCXGraph não produziu associação (nenhuma região conservada com estes parâmetros).")
    payload = json.loads(json_files[0].read_text())
    dashboards = sorted(target.glob("Dashboard_*.html"))

    # Normalise the three modes into a list of comparisons.
    comparisons: List[Dict] = []
    if "pairs" in payload:
        for key, pdata in payload["pairs"].items():
            pair_dir = target / key
            comparisons.append({
                "key": key,
                "nodes": pdata.get("nodes", []),
                "edges": pdata.get("edges", []),
                "components": pdata.get("components", []),
                "summary": _read_csv(pair_dir / "nodes_summary_weighted.csv"),
                "per_protein": _read_csv(pair_dir / "nodes_per_protein.csv"),
            })
        filtered = payload.get("filtered_graphs", {})
    else:
        comparisons.append({
            "key": "multiple",
            "nodes": payload.get("nodes", []),
            "edges": payload.get("edges", []),
            "components": payload.get("components", []),
            "summary": _read_csv(target / "nodes_summary_weighted.csv"),
            "per_protein": _read_csv(target / "nodes_per_protein.csv"),
        })
        filtered = {g["name"]: g for g in payload.get("filtered_graphs", [])}

    heatmap = None
    if params.get("heatmap") and mode in ("pairwise", "screening"):
        protocol.progress(0.9, "Heatmap de componentes")
        from MHCXGraph.scripts.create_heatmaps import create_heatmap

        hm_dir = Path(workdir) / "heatmap"
        # create_heatmap globs graph_*.json recursively; the master graph_data_*.json
        # written above would match and show up as a phantom protein, so feed it a
        # folder with only the per-pair graphs.
        hm_in = Path(workdir) / "heatmap_inputs"
        hm_in.mkdir(exist_ok=True)
        for f in target.rglob("graph_*.json"):
            if not f.name.startswith("graph_data_"):
                shutil.copy(f, hm_in / f.name)
        try:
            png = create_heatmap(SimpleNamespace(input_dir=str(hm_in), output_dir=str(hm_dir), name="heatmap.png"))
            heatmap = {
                "png": str(png),
                "distance": _read_matrix(hm_dir / "distance_matrix.csv"),
                "components": _read_csv(hm_dir / "component_count_matrix.csv"),
            }
        except Exception as e:  # noqa: BLE001 — the run itself succeeded; report and go on
            protocol.log("Heatmap falhou: {}".format(e))

    protocol.progress(1.0, "Pronto")
    return {
        "mode": payload.get("actual_mode") or payload.get("mode"),
        "proteins": payload.get("proteins", names),
        "inputs": [s["input"] for s in structures],
        # names[i] is the protein name MHCXGraph uses for structures[i].
        "names": names,
        "reference": payload.get("reference_structure"),
        "comparisons": comparisons,
        "filtered_graphs": filtered,
        "dashboard": str(dashboards[0]) if dashboards else None,
        "output_dir": str(target),
        "heatmap": heatmap,
        "settings": settings,
    }


def _read_matrix(path: Path) -> Dict:
    if not path.exists():
        return {}
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    labels = rows[0][1:]
    values = [[float(x) for x in r[1:]] for r in rows[1:]]
    return {"labels": labels, "values": values}
