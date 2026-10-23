"""Structure preparation shared by every tool (gemmi, available in both envs).

Tools never read the user's file directly: they get a cleaned PDB written into the
job directory, with only the chains asked for, in the order asked for. Rosetta in
particular is happier when each side of an interface is a contiguous block of
chains (README_rosetta.md, section 4).
"""

from __future__ import annotations

import math
import os
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import gemmi


def read(path: str) -> gemmi.Structure:
    st = gemmi.read_structure(path)
    st.setup_entities()
    if len(st) > 1:
        # Keep the first model: ensembles are handled one model at a time.
        for i in range(len(st) - 1, 0, -1):
            del st[i]
    return st


def chain_ids(st: gemmi.Structure) -> List[str]:
    return [c.name for c in st[0]]


def prepare(
    src: str,
    dst: str,
    chains: Optional[Sequence[str]] = None,
    remove_waters: bool = True,
    remove_hetero: bool = True,
    remove_hydrogens: bool = False,
    keep_residues: Iterable[str] = (),
) -> Dict:
    """Writes a cleaned copy of `src` to `dst` (PDB).

    `chains` both filters and orders the chains. `keep_residues` names hetero
    residues to keep even when `remove_hetero` is on (e.g. MSE, CGU).
    Returns a small report the tools pass back to the UI.
    """
    st = read(src)
    model = st[0]
    present = [c.name for c in model]
    if chains:
        missing = [c for c in chains if c not in present]
        if missing:
            raise ValueError("Cadeias não encontradas no arquivo: " + ", ".join(missing))

    st.remove_alternative_conformations()
    if remove_waters:
        st.remove_waters()
    if remove_hetero:
        keep = set(keep_residues)
        for ch in model:
            for i in range(len(ch) - 1, -1, -1):
                r = ch[i]
                if r.het_flag == "H" and r.name not in keep:
                    del ch[i]
    if remove_hydrogens:
        st.remove_hydrogens()

    if chains:
        # Version-agnostic reorder (gemmi's Model constructor changed across releases):
        # copy the wanted chains, empty the model, add them back in order.
        copies = [model[name].clone() for name in chains]
        for name in present:
            model.remove_chain(name)
        for ch in copies:
            model.add_chain(ch)
    st.remove_empty_chains()
    st.setup_entities()

    # PDB format needs one-character chain names.
    if any(len(c.name) > 1 for c in st[0]):
        st.shorten_chain_names()

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    st.write_pdb(dst)
    return {
        "chains": [c.name for c in st[0]],
        "residues": sum(len(c) for c in st[0]),
        "atoms": sum(len(r) for c in st[0] for r in c),
    }


def residue_key(chain: str, seq: int, icode: str = "") -> str:
    """The key the app uses for per-residue data: 'A:45' or 'A:45A'."""
    icode = (icode or "").strip()
    return "{}:{}{}".format(chain, seq, icode)


def backbone_coords(st: gemmi.Structure, chain: str) -> Tuple[List[Tuple[int, str, str]], List[List[List[float]]]]:
    """(residue ids, N/CA/C/O coordinates) for residues with a complete backbone."""
    ids = []
    coords = []
    for r in st[0][chain]:
        atoms = {}
        for a in r:
            if a.name in ("N", "CA", "C", "O") and a.name not in atoms:
                atoms[a.name] = [a.pos.x, a.pos.y, a.pos.z]
        if len(atoms) == 4:
            ids.append((r.seqid.num, r.seqid.icode.strip(), r.name))
            coords.append([atoms["N"], atoms["CA"], atoms["C"], atoms["O"]])
    return ids, coords


def bounding_box(path: str) -> Tuple[List[float], List[float]]:
    st = read(path)
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for ch in st[0]:
        for r in ch:
            for a in r:
                p = (a.pos.x, a.pos.y, a.pos.z)
                for i in range(3):
                    lo[i] = min(lo[i], p[i])
                    hi[i] = max(hi[i], p[i])
    return lo, hi
