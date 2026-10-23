"""Adds hydrogens with PDB2PQR, protonating titratable residues at a chosen pH with
PROPKA — the same preparation the user's APBS pipeline uses, so the H-bond network
drawn in the app is the one the electrostatics saw.

PDB2PQR writes zero B-factors and drops ligands. Both are put back: B-factors (where
AlphaFold keeps pLDDT) are copied from the input atom by atom — a new hydrogen takes
its residue's Cα value — and hetero residues other than water are appended unchanged.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Dict, List, Tuple

import gemmi

from .. import protocol, structure

DEFAULTS = {"ph": 7.0, "propka": True, "forcefield": "PARSE"}


def _residue_id(chain: str, res: gemmi.Residue) -> Tuple[str, int, str]:
    return (chain, res.seqid.num, res.seqid.icode.strip())


def run(params: Dict, workdir: str) -> Dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    pdb2pqr = shutil.which("pdb2pqr30") or shutil.which("pdb2pqr")
    if not pdb2pqr:
        raise RuntimeError("pdb2pqr não encontrado (esperado no env do PyRosetta).")

    protocol.progress(0.05, "Preparando estrutura")
    clean = os.path.join(workdir, "input_clean.pdb")
    structure.prepare(params["input"], clean, remove_waters=True, remove_hetero=True, remove_hydrogens=True, keep_residues=("MSE",))

    raw = os.path.join(workdir, "with_h_raw.pdb")
    pqr = os.path.join(workdir, "with_h.pqr")
    cmd = [pdb2pqr, "--ff={}".format(p["forcefield"]), "--keep-chain", "--with-ph={}".format(float(p["ph"])), "--pdb-output", raw]
    if p["propka"]:
        cmd.append("--titration-state-method=propka")
    cmd += [clean, pqr]
    protocol.progress(0.2, "PDB2PQR{} · pH {}".format(" + PROPKA" if p["propka"] else "", p["ph"]))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=workdir)
    if r.returncode != 0 or not os.path.exists(raw):
        raise RuntimeError("pdb2pqr falhou:\n" + (r.stderr or r.stdout)[-3000:])

    protocol.progress(0.8, "Restaurando B-factors e ligantes")
    original = structure.read(params["input"])
    added = gemmi.read_structure(raw)
    added.setup_entities()

    # B-factors from the input, per atom; hydrogens inherit their residue's Cα.
    bfac: Dict[Tuple[str, int, str], Dict[str, float]] = {}
    for ch in original[0]:
        for res in ch:
            bfac[_residue_id(ch.name, res)] = {a.name: a.b_iso for a in res}
    heavy = hydrogens = 0
    present = set()
    for ch in added[0]:
        for res in ch:
            key = _residue_id(ch.name, res)
            present.add(key)
            src = bfac.get(key, {})
            fallback = src.get("CA", next(iter(src.values()), 0.0))
            for a in res:
                a.b_iso = src.get(a.name, fallback)
                if a.element.name in ("H", "D"):
                    hydrogens += 1
                else:
                    heavy += 1

    # Ligands and modified residues PDB2PQR does not know come back unchanged.
    ligands: List[str] = []
    dropped: List[str] = []
    for ch in original[0]:
        for res in ch:
            key = _residue_id(ch.name, res)
            if key in present or res.is_water():
                continue
            if res.het_flag == "H":
                target = added[0].find_chain(ch.name)
                if target is None:
                    added[0].add_chain(gemmi.Chain(ch.name))
                    target = added[0].find_chain(ch.name)
                target.add_residue(res)
                ligands.append("{}:{}{}".format(ch.name, res.name, res.seqid.num))
            else:
                dropped.append("{}:{}{}".format(ch.name, res.name, res.seqid.num))

    base = os.path.splitext(os.path.basename(params["input"]).replace(".gz", ""))[0]
    out = os.path.join(workdir, base + "_H.pdb")
    added.write_pdb(out)
    protocol.progress(1.0, "Pronto")
    return {
        "output": out,
        "hydrogens": hydrogens,
        "heavy_atoms": heavy,
        "ph": float(p["ph"]),
        "propka": bool(p["propka"]),
        "ligands_kept": ligands,
        "residues_dropped": dropped,
    }
