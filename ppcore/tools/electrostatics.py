"""Poisson–Boltzmann electrostatics: PDB2PQR → APBS, the recipe of
~/projetos/rocio/2_giovanna/README_electrostatics.md and electrostatics_pipeline.py:

  PDB2PQR (PARSE, pH 7.4, PROPKA) → APBS mg-auto with two-step focusing,
  0.15 M NaCl (Na⁺ 2.0 Å, Cl⁻ 1.8 Å), εp 2.0, εs 78.54, smol surface, spl2 charges,
  fine grid = bounding box + 20 % per axis, coarse = 1.7 × fine,
  dime = smallest 2ⁿ+1 giving ≤ 0.5 Å spacing.

The .in is written whole rather than by editing PDB2PQR's template: that template
carries no ion lines, so the pipeline above had to patch them in, and an unpatched
run silently solves at 0 M.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
from typing import Dict, List, Tuple

from .. import protocol, structure

DEFAULTS = {
    "chains": [],               # empty = all chains; the README used only the MHC heavy chain
    "forcefield": "PARSE",      # PARSE | AMBER | CHARMM | PEOEPB | SWANSON | TYL06
    "ph": 7.4,
    "titration": "propka",      # propka | none
    "pdb2pqr_debump": True,
    "pdb2pqr_optimize_hbonds": True,
    "ionic_strength": 0.15,     # M
    "cation_radius": 2.0,
    "anion_radius": 1.8,
    "pdie": 2.0,
    "sdie": 78.54,
    "equation": "lpbe",         # lpbe | npbe
    "boundary": "sdh",          # sdh | mdh | zero
    "surface": "smol",          # smol | mol | spl2 | spl4
    "charge_discretization": "spl2",  # spl0 | spl2 | spl4
    "srad": 1.4,
    "swin": 0.3,
    "sdens": 10.0,
    "temperature": 298.15,
    "grid_spacing": 0.5,        # Å per point on the fine grid (upper bound)
    "grid_margin": 0.2,         # fraction of the box added per axis
    "coarse_factor": 1.7,
    "min_dime": 33,
    "timeout_min": 30,
}


def _pow2_plus1_at_least(n: int) -> int:
    k = 1
    while (2 ** k) + 1 < n:
        k += 1
    return (2 ** k) + 1


def _pqr_box_and_charge(path: str) -> Tuple[List[float], List[float], float]:
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    charge = 0.0
    with open(path) as f:
        for line in f:
            if not line.startswith(("ATOM", "HETATM")):
                continue
            parts = line[30:].split()
            x, y, z, q = float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])
            for i, v in enumerate((x, y, z)):
                lo[i] = min(lo[i], v)
                hi[i] = max(hi[i], v)
            charge += q
    return lo, hi, charge


def _apbs_input(p: Dict, pqr: str, dx_base: str, lo: List[float], hi: List[float]) -> Tuple[str, Dict]:
    size = [hi[i] - lo[i] for i in range(3)]
    fglen = [s * (1.0 + float(p["grid_margin"])) for s in size]
    cglen = [f * float(p["coarse_factor"]) for f in fglen]
    dime = [_pow2_plus1_at_least(max(int(p["min_dime"]), math.ceil(f / float(p["grid_spacing"])) + 1)) for f in fglen]
    fmt = lambda v: " ".join("{:.3f}".format(x) for x in v)  # noqa: E731
    ions = ""
    if float(p["ionic_strength"]) > 0:
        ions = (
            "    ion charge +1 conc {c:.4f} radius {r1:.2f}\n"
            "    ion charge -1 conc {c:.4f} radius {r2:.2f}\n"
        ).format(c=float(p["ionic_strength"]), r1=float(p["cation_radius"]), r2=float(p["anion_radius"]))
    text = (
        "read\n    mol pqr {pqr}\nend\n"
        "elec name pot\n"
        "    mg-auto\n"
        "    dime {dime}\n"
        "    cglen {cglen}\n"
        "    fglen {fglen}\n"
        "    cgcent mol 1\n    fgcent mol 1\n    mol 1\n"
        "    {eq}\n"
        "    bcfl {bcfl}\n"
        "{ions}"
        "    pdie {pdie:.4f}\n    sdie {sdie:.4f}\n"
        "    srfm {srfm}\n    chgm {chgm}\n"
        "    sdens {sdens:.2f}\n    srad {srad:.2f}\n    swin {swin:.2f}\n"
        "    temp {temp:.2f}\n"
        "    calcenergy total\n    calcforce no\n"
        "    write pot dx {dx}\n"
        "end\nquit\n"
    ).format(
        pqr=os.path.basename(pqr), dime=" ".join(str(d) for d in dime), cglen=fmt(cglen), fglen=fmt(fglen),
        eq=p["equation"], bcfl=p["boundary"], ions=ions, pdie=float(p["pdie"]), sdie=float(p["sdie"]),
        srfm=p["surface"], chgm=p["charge_discretization"], sdens=float(p["sdens"]), srad=float(p["srad"]),
        swin=float(p["swin"]), temp=float(p["temperature"]), dx=dx_base,
    )
    grid = {"dime": dime, "fglen": fglen, "cglen": cglen, "spacing": [fglen[i] / (dime[i] - 1) for i in range(3)]}
    return text, grid


def run(params: Dict, workdir: str) -> Dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    pdb2pqr = shutil.which("pdb2pqr30") or shutil.which("pdb2pqr")
    apbs = shutil.which("apbs")
    if not pdb2pqr or not apbs:
        raise RuntimeError("pdb2pqr/apbs não encontrados (esperados no env do PyRosetta).")
    timeout = float(p["timeout_min"]) * 60

    protocol.progress(0.05, "Preparando estrutura")
    clean = os.path.join(workdir, "input_clean.pdb")
    prep = structure.prepare(params["input"], clean, chains=p["chains"] or None, remove_waters=True, remove_hetero=True,
                             keep_residues=("MSE", "CGU"))

    pqr = os.path.join(workdir, "structure.pqr")
    cmd = [pdb2pqr, "--ff={}".format(p["forcefield"]), "--with-ph={}".format(float(p["ph"]))]
    if p["titration"] == "propka":
        cmd.append("--titration-state-method=propka")
    if not p["pdb2pqr_debump"]:
        cmd.append("--nodebump")
    if not p["pdb2pqr_optimize_hbonds"]:
        cmd.append("--noopt")
    cmd += [clean, pqr]
    protocol.progress(0.15, "PDB2PQR · {} · pH {}".format(p["forcefield"], p["ph"]))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=workdir)
    if r.returncode != 0 or not os.path.exists(pqr):
        raise RuntimeError("pdb2pqr falhou:\n" + (r.stderr or r.stdout)[-3000:])

    lo, hi, charge = _pqr_box_and_charge(pqr)
    text, grid = _apbs_input(p, pqr, "potential", lo, hi)
    with open(os.path.join(workdir, "apbs.in"), "w") as f:
        f.write(text)
    protocol.progress(0.35, "APBS · grade {}".format("×".join(str(d) for d in grid["dime"])))
    r = subprocess.run([apbs, "apbs.in"], capture_output=True, text=True, timeout=timeout, cwd=workdir)
    dx = os.path.join(workdir, "potential.dx")
    if r.returncode != 0 or not os.path.exists(dx):
        raise RuntimeError("APBS falhou:\n" + (r.stderr or r.stdout)[-3000:])

    protocol.progress(1.0, "Pronto")
    return {
        "input": params["input"],
        "prepared": prep,
        "dx_path": dx,
        "pqr_path": pqr,
        "net_charge": round(charge, 3),
        "grid": grid,
        "forcefield": p["forcefield"],
        "ph": p["ph"],
        "ionic_strength": p["ionic_strength"],
    }
