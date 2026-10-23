"""TM-align (Zhang lab binary, Version 20220412 on this machine), with the options it
exposes. Each side is extracted to a single-chain PDB first: TM-align aligns one
chain per file, and the user picks which.

The rotation matrix (-m) superposes the mobile structure onto the reference; the
app applies it to the loaded structure.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Dict, List, Optional

import gemmi

from .. import protocol, structure

DEFAULTS = {
    "program": "TMalign",        # TMalign | USalign (when installed)
    "normalize": "reference",     # reference | mobile | average | custom
    "custom_length": 0,           # -L when normalize == custom
    "d0": 0.0,                    # -d scale; 0 = default
    "circular_permutation": False,  # -cp
    "fast": False,                # -fast
    "mirror": False,              # -mirror 1
    "byresi": False,              # -byresi 1: residue-number correspondence (same protein, other conformation)
    "merge_chains": False,        # several chains per side → one pseudo-chain
}


def _single_chain(src: str, chains: List[str], dst: str, merge: bool) -> int:
    st = structure.read(src)
    st.remove_ligands_and_waters()
    model = st[0]
    names = chains or [model[0].name]
    if len(names) > 1 and not merge:
        names = names[:1]
    merged = gemmi.Chain("A")
    for name in names:
        for r in model[name]:
            merged.add_residue(r)
    out = gemmi.Structure()
    m = gemmi.Model(1) if hasattr(gemmi.Model, "num") else gemmi.Model("1")
    m.add_chain(merged)
    out.add_model(m)
    out.setup_entities()
    out.write_pdb(dst)
    return sum(1 for _ in merged)


def _num(pattern: str, text: str) -> Optional[float]:
    m = re.search(pattern, text)
    return float(m.group(1)) if m else None


def run(params: Dict, workdir: str) -> Dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    exe = shutil.which(p["program"]) or shutil.which(p["program"].lower())
    if not exe:
        raise RuntimeError("{} não encontrado no PATH.".format(p["program"]))

    ref = params["reference"]
    mob = params["mobile"]
    ref_pdb = os.path.join(workdir, "reference.pdb")
    mob_pdb = os.path.join(workdir, "mobile.pdb")
    n_ref = _single_chain(ref["input"], ref.get("chains") or [], ref_pdb, p["merge_chains"])
    n_mob = _single_chain(mob["input"], mob.get("chains") or [], mob_pdb, p["merge_chains"])

    matrix_file = os.path.join(workdir, "matrix.txt")
    # Chain_1 = mobile, Chain_2 = reference: -m then rotates the mobile onto the reference.
    cmd = [exe, mob_pdb, ref_pdb, "-m", matrix_file]
    if p["normalize"] == "average":
        cmd += ["-a", "T"]
    elif p["normalize"] == "custom" and p["custom_length"]:
        cmd += ["-L", str(int(p["custom_length"]))]
    if p["d0"]:
        cmd += ["-d", str(float(p["d0"]))]
    if p["circular_permutation"]:
        cmd += ["-cp"]
    if p["fast"]:
        cmd += ["-fast"]
    if p["mirror"]:
        cmd += ["-mirror", "1"]
    if p["byresi"]:
        cmd += ["-byresi", "1"]
    protocol.progress(0.2, " ".join(os.path.basename(c) for c in cmd))
    run_ = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=workdir)
    out = run_.stdout
    if run_.returncode != 0 or "TM-score=" not in out:
        raise RuntimeError("TM-align falhou:\n" + (run_.stderr or out)[-2000:])

    tm_scores = re.findall(r"TM-score=\s*([\d.]+)\s*\(if normalized by length of Chain_(\d)", out)
    tm_by_chain = {int(c): float(v) for v, c in tm_scores}
    avg = _num(r"TM-score=\s*([\d.]+)\s*\(if normalized by average", out)
    custom = _num(r"TM-score=\s*([\d.]+)\s*\(if normalized by user-specified", out)

    lines = out.split("\n")
    # The three alignment lines (mobile, markers, reference) follow the legend line.
    aln: List[str] = []
    for i, l in enumerate(lines):
        if l.startswith('(":" denotes'):
            aln = lines[i + 1:i + 4]
            break

    rot: List[List[float]] = []
    trans: List[float] = []
    with open(matrix_file) as f:
        for line in f:
            m = re.match(r"\s*([0-2])\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)", line)
            if m:
                trans.append(float(m.group(2)))
                rot.append([float(m.group(3)), float(m.group(4)), float(m.group(5))])

    protocol.progress(1.0, "Pronto")
    return {
        "reference": ref,
        "mobile": mob,
        "length_reference": n_ref,
        "length_mobile": n_mob,
        "aligned_length": int(_num(r"Aligned length=\s*(\d+)", out) or 0),
        "rmsd": _num(r"RMSD=\s*([\d.]+)", out),
        "seq_identity": _num(r"Seq_ID=n_identical/n_aligned=\s*([\d.]+)", out),
        "tm_reference": tm_by_chain.get(2),
        "tm_mobile": tm_by_chain.get(1),
        "tm_average": avg,
        "tm_custom": custom,
        "alignment": {"mobile": aln[0] if len(aln) == 3 else "", "markers": aln[1] if len(aln) == 3 else "", "reference": aln[2] if len(aln) == 3 else ""},
        # x_ref = t + U · x_mobile
        "rotation": rot,
        "translation": trans,
        "raw": out[-4000:],
    }
