"""FastRelax, configured like ~/projetos/rocio/2_giovanna/scripts/relax_one_pdb.py
(ref2015, 5 repeats, bb/chi/jump free) with the options a designer reaches for:
coordinate constraints, Cartesian relax, and relaxing only the interface region.

nstruct is handled by the app: N independent jobs with different seeds run in
parallel on the CPU pool, and the best-scoring model is kept.
"""

from __future__ import annotations

import time
from typing import Dict

from .. import protocol, structure
from . import rosetta_common as rc

DEFAULTS = {
    "scorefxn": "ref2015",
    "repeats": 5,
    "cartesian": False,
    "constrain_to_start": False,
    "cst_stdev": 0.5,
    "ramp_constraints": True,
    "bb": True,
    "chi": True,
    "jump": True,
    "region": "all",           # all | interface | chains
    "side_a": [],
    "side_b": [],
    "interface_radius": 8.0,
    "chains": [],               # for region == chains, and to restrict the input
    "seed": 0,
    "analyze_interface": True,  # quick IAM (no packstat) on the relaxed model
    "remove_hetero": True,
    "remove_waters": True,
    "extra_flags": "",
}


def run(params: Dict, workdir: str) -> Dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    t0 = time.time()
    if p["cartesian"] and not p["scorefxn"].endswith("_cart"):
        p["scorefxn"] = p["scorefxn"] + "_cart"

    keep_chains = list(p["side_a"]) + list(p["side_b"]) if p["side_a"] and p["side_b"] else (p["chains"] or None)
    protocol.progress(0.02, "Preparando estrutura")
    clean = workdir + "/input_clean.pdb"
    prep = structure.prepare(params["input"], clean, chains=keep_chains, remove_waters=p["remove_waters"], remove_hetero=p["remove_hetero"],
                             keep_residues=("MSE", "CGU", "SEP", "TPO", "PTR"))

    rc.init(" ".join(x for x in (rc.init_flags_for(p["scorefxn"]), p["extra_flags"]) if x), seed=int(p["seed"] or 0))
    import pyrosetta
    from pyrosetta.rosetta.core.kinematics import MoveMap
    from pyrosetta.rosetta.protocols.relax import FastRelax

    pose = pyrosetta.pose_from_pdb(clean)
    start = pose.clone()
    sfxn = rc.scorefxn(p["scorefxn"])
    score_before = sfxn(pose)

    mm = MoveMap()
    movable = set(range(1, pose.total_residue() + 1))
    if p["region"] == "interface":
        if not (p["side_a"] and p["side_b"]):
            raise ValueError("Relax só na interface precisa dos dois lados.")
        from pyrosetta.rosetta.core.select.residue_selector import ChainSelector, InterGroupInterfaceByVectorSelector

        sel = InterGroupInterfaceByVectorSelector(ChainSelector(",".join(p["side_a"])), ChainSelector(",".join(p["side_b"])))
        sel.cb_dist_cut(float(p["interface_radius"]))
        mask = sel.apply(pose)
        movable = {i for i in range(1, pose.total_residue() + 1) if mask[i]}
    elif p["region"] == "chains" and p["chains"]:
        movable = set(rc.residues_of_chains(pose, p["chains"]))
    for i in range(1, pose.total_residue() + 1):
        mm.set_bb(i, bool(p["bb"]) and i in movable)
        mm.set_chi(i, bool(p["chi"]) and i in movable)
    mm.set_jump(bool(p["jump"]))

    fr = FastRelax(sfxn, int(p["repeats"]))
    fr.set_movemap(mm)
    if p["cartesian"]:
        fr.cartesian(True)
        fr.minimize_bond_angles(True)
        fr.minimize_bond_lengths(True)
    if p["constrain_to_start"]:
        fr.constrain_relax_to_start_coords(True)
        fr.ramp_down_constraints(bool(p["ramp_constraints"]))
        fr.coord_constrain_sidechains(False)
        from pyrosetta.rosetta.core.scoring import ScoreType

        if sfxn.get_weight(ScoreType.coordinate_constraint) == 0:
            sfxn.set_weight(ScoreType.coordinate_constraint, 1.0)
        fr.set_scorefxn(sfxn)

    protocol.progress(0.1, "FastRelax · {} repetições · {} resíduos móveis".format(p["repeats"], len(movable)))
    fr.apply(pose)
    score_after = sfxn(pose)

    out_pdb = workdir + "/relaxed.pdb"
    pose.dump_pdb(out_pdb)

    result = {
        "input": params["input"],
        "prepared": prep,
        "relaxed_path": out_pdb,
        "scorefxn": p["scorefxn"],
        "score_before": score_before,
        "score_after": score_after,
        "ca_rmsd": rc.ca_rmsd(start, pose),
        "all_atom_rmsd": rc.all_atom_rmsd(start, pose),
        "movable_residues": len(movable),
        "seed": p["seed"],
        "interface": None,
    }
    if p["analyze_interface"] and p["side_a"] and p["side_b"]:
        protocol.progress(0.92, "Interface do modelo relaxado")
        from pyrosetta.rosetta.protocols.analysis import InterfaceAnalyzerMover

        # Empty constructor + set_interface: the string constructor is gone in PyRosetta
        # 2026.3x, and this form works on older releases too (BindCraft uses it).
        iam = InterfaceAnalyzerMover()
        iam.set_interface(rc.interface_string(p["side_a"], p["side_b"]))
        iam.set_scorefunction(rc.scorefxn(p["scorefxn"].replace("_cart", "")))
        iam.set_pack_separated(True)
        iam.set_compute_interface_sc(True)
        iam.set_calc_dSASA(True)
        iam.apply(pose.clone())
        d = iam.get_all_data()
        result["interface"] = {"dG_separated": d.dG[1], "dSASA": d.dSASA[1], "sc_value": d.sc_value,
                               "interface_hbonds": d.interface_hbonds, "delta_unsat_hbonds": d.delta_unsat_hbonds}
    result["seconds"] = time.time() - t0
    protocol.progress(1.0, "Pronto")
    return result
