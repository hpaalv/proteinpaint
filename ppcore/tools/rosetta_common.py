"""PyRosetta helpers shared by the interface and relax tools."""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

from .. import protocol

SCOREFXNS = ("ref2015", "ref2015_cart", "beta_nov16", "beta_nov16_cart")


def init(extra: str = "", packstat_oversample: int = 0, seed: int = 0) -> None:
    import pyrosetta

    flags = [
        "-mute all",
        "-ignore_unrecognized_res true",
        "-ignore_zero_occupancy false",
        "-load_PDB_components true",
    ]
    if packstat_oversample:
        flags.append("-packstat::oversample {}".format(int(packstat_oversample)))
    if seed:
        flags.append("-constant_seed -jran {}".format(int(seed)))
    if extra:
        flags.append(extra)
    protocol.log("pyrosetta.init(" + " ".join(flags) + ")")
    pyrosetta.init(" ".join(flags), silent=True)


def scorefxn(name: str):
    import pyrosetta

    if name not in SCOREFXNS:
        raise ValueError("Função de energia desconhecida: " + name)
    return pyrosetta.create_score_function(name)


def init_flags_for(scorefxn_name: str) -> str:
    """beta_nov16 needs its init flag, otherwise Rosetta refuses to build it."""
    return "-beta_nov16" if scorefxn_name.startswith("beta_nov16") else ""


def pdb_id(pose, i: int) -> Tuple[str, int, str]:
    info = pose.pdb_info()
    return info.chain(i), info.number(i), info.icode(i).strip()


def key(pose, i: int) -> str:
    c, n, ic = pdb_id(pose, i)
    return "{}:{}{}".format(c, n, ic)


def residues_of_chains(pose, chains: Sequence[str]) -> List[int]:
    info = pose.pdb_info()
    wanted = set(chains)
    return [i for i in range(1, pose.total_residue() + 1) if info.chain(i) in wanted]


def interface_string(side_a: Sequence[str], side_b: Sequence[str]) -> str:
    return "".join(side_a) + "_" + "".join(side_b)


def separated_copy(pose, n_chains_side_a: int, distance: float = 500.0):
    """The complex with side B pulled 500 Å away along the jump between the blocks."""
    from pyrosetta.rosetta.protocols.rigid import RigidBodyTransMover

    sep = pose.clone()
    mover = RigidBodyTransMover(sep, n_chains_side_a)
    mover.step_size(distance)
    mover.apply(sep)
    return sep


def atom_sasa(pose, probe: float) -> Dict[Tuple[int, int], float]:
    from pyrosetta.rosetta.core.id import AtomID, AtomID_Map_double_t
    from pyrosetta.rosetta.core.scoring import calc_per_atom_sasa
    from pyrosetta.rosetta.utility import vector1_double

    amap = AtomID_Map_double_t()
    rsd = vector1_double()
    calc_per_atom_sasa(pose, amap, rsd, probe)
    out = {}
    for i in range(1, pose.total_residue() + 1):
        for a in range(1, pose.residue(i).natoms() + 1):
            out[(i, a)] = amap.get(AtomID(a, i))
    return out


def ca_rmsd(a, b) -> float:
    from pyrosetta.rosetta.core.scoring import CA_rmsd

    return float(CA_rmsd(a, b))


def all_atom_rmsd(a, b) -> float:
    from pyrosetta.rosetta.core.scoring import all_atom_rmsd as aar

    return float(aar(a, b))
