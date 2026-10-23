"""IMGT renumbering of MHC class I / II structures with MHCXGraph's templates
(`MHCXGraph renumber`). Renumbered copies make positions comparable across alleles
and species before an MHCXGraph run or any per-position analysis.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Dict, List

from .. import protocol


def run(params: Dict, workdir: str) -> Dict:
    from MHCXGraph.scripts.renumber_MHCI_imgt import load_mhci_templates, process_structure_file_mhci
    from MHCXGraph.scripts.renumber_MHCII_imgt import load_mhcii_templates, process_structure_file_mhcii
    import MHCXGraph

    mhc_class = (params.get("mhc_class") or "MHCI").upper()
    if mhc_class == "MHCI":
        load, process = load_mhci_templates, process_structure_file_mhci
    elif mhc_class == "MHCII":
        load, process = load_mhcii_templates, process_structure_file_mhcii
    else:
        raise ValueError("Classe deve ser MHCI ou MHCII.")
    warn = float(params.get("warn_score", 50.0))
    suffix = params.get("suffix", "_imgt")

    assets = Path(MHCXGraph.__file__).resolve().parent / "assets"
    templates = load(assets / "imgt_display_all.csv", assets / "imgt_numbering_mapping_all.csv")

    out_dir = Path(workdir) / "renumbered"
    out_dir.mkdir(parents=True, exist_ok=True)
    results: List[Dict] = []
    inputs = params.get("inputs") or []
    for n, src in enumerate(inputs):
        protocol.progress(n / max(1, len(inputs)), "IMGT · " + os.path.basename(src))
        stem = Path(src).name
        for ext in (".gz",):
            if stem.endswith(ext):
                stem = stem[: -len(ext)]
        base, ext = os.path.splitext(stem)
        local = Path(workdir) / ("in_" + stem)
        if src.endswith(".gz"):
            import gzip

            with gzip.open(src, "rb") as fi, open(local, "wb") as fo:
                shutil.copyfileobj(fi, fo)
        else:
            shutil.copy(src, local)
        dst = out_dir / (base + suffix + ext)
        try:
            process(input_path=str(local), output_path=str(dst), templates=templates, debug=False, warn_score=warn)
            results.append({"input": src, "output": str(dst), "ok": True})
        except Exception as e:  # noqa: BLE001 — one failing file must not stop the batch
            results.append({"input": src, "output": None, "ok": False, "error": str(e)})
    protocol.progress(1.0, "Pronto")
    return {"mhc_class": mhc_class, "results": results, "output_dir": str(out_dir)}
