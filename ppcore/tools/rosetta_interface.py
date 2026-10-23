"""Rosetta interface analysis: InterfaceAnalyzerMover plus what IAM only counts.

Configured the way ~/projetos/rocio/2_giovanna/scripts/process_one_interface.py
does it (interface by string, pack_separated, Sc, hbond SASA energy, CMS), plus:
  - every cross-interface H-bond with its energy and atoms (HBondSet)
  - buried unsatisfied polar atoms, atom by atom, interface-created vs pre-existing
  - IAM per-residue ΔG and ΔSASA, and per-residue total energy (hotspot colouring)
  - residue–residue interaction energies across the interface
  - optional alanine scan (ΔΔG per interface residue)

packstat is off by default: on the 7Q15 complex IAM takes 2.9 s without it and
61 s with oversample 30 (195 s with 100), for the same value to 3 decimals.
"""

from __future__ import annotations

import time
from typing import Dict, List

from .. import protocol, structure
from . import rosetta_common as rc

DEFAULTS = {
    "side_a": [],
    "side_b": [],
    "scorefxn": "ref2015",
    # IAM
    "pack_separated": True,
    "pack_input": False,
    "pack_rounds": 1,
    "compute_sc": True,
    "calc_hbond_sasaE": True,
    "compute_packstat": False,
    "packstat_oversample": 30,
    # Contact molecular surface
    "cms": True,
    "cms_distance_weight": 0.5,
    "cms_filtered_area": 0.0,
    "cms_quick": False,
    "cms_use_rosetta_radii": False,
    # H-bonds
    "hbonds": True,
    "hbond_energy_cutoff": -0.25,
    "hbond_include_bb": True,
    # Buried unsatisfied polars
    "unsats": True,
    "unsat_probe": 1.0,
    "unsat_burial_sasa": 0.5,
    "unsat_hbond_cutoff": -0.25,
    "unsat_include_preexisting": False,
    # Per-residue data
    "per_residue": True,
    "pair_energies": True,
    "pair_energy_cutoff": -1.0,
    "pair_neighbor_distance": 10.0,
    # Alanine scan
    "alanine_scan": False,
    "ala_side": "A",
    "ala_min_dsasa": 10.0,
    "ala_repack_radius": 8.0,
    # Input cleaning
    "remove_hetero": True,
    "remove_waters": True,
    "extra_flags": "",
}


def _params(p: Dict) -> Dict:
    out = dict(DEFAULTS)
    out.update({k: v for k, v in p.items() if v is not None})
    if not out["side_a"] or not out["side_b"]:
        raise ValueError("Escolha as cadeias dos dois lados da interface.")
    if set(out["side_a"]) & set(out["side_b"]):
        raise ValueError("Uma cadeia não pode estar nos dois lados.")
    return out


def _iam(pose, p: Dict, sfxn, full: bool):
    from pyrosetta.rosetta.protocols.analysis import InterfaceAnalyzerMover

    iam = InterfaceAnalyzerMover(rc.interface_string(p["side_a"], p["side_b"]))
    iam.set_scorefunction(sfxn)
    iam.set_pack_separated(bool(p["pack_separated"]))
    iam.set_pack_input(bool(p["pack_input"]))
    iam.set_pack_rounds(int(p["pack_rounds"]))
    iam.set_compute_packstat(bool(full and p["compute_packstat"]))
    iam.set_compute_interface_sc(bool(full and p["compute_sc"]))
    iam.set_calc_hbond_sasaE(bool(full and p["calc_hbond_sasaE"]))
    iam.set_calc_dSASA(True)
    iam.set_compute_interface_energy(True)
    iam.apply(pose)
    return iam


def _metrics(data, p: Dict) -> Dict:
    m = {
        "dG_separated": data.dG[1],
        "dSASA": data.dSASA[1],
        "dSASA_side_a": data.dSASA[2],
        "dSASA_side_b": data.dSASA[3],
        "dSASA_sc": data.dSASA_sc[1],
        "dG_dSASA_ratio": (data.dG[1] / data.dSASA[1] * 100.0) if data.dSASA[1] else None,
        "sc_value": data.sc_value if p["compute_sc"] else None,
        "packstat": data.packstat if p["compute_packstat"] else None,
        "interface_hbonds": data.interface_hbonds,
        "delta_unsat_hbonds": data.delta_unsat_hbonds,
        "hbond_E_fraction": data.hbond_E_fraction,
        "nres_interface": data.interface_nres[1],
        "nres_side_a": data.interface_nres[2],
        "nres_side_b": data.interface_nres[3],
        "complexed_SASA": data.complexed_SASA,
        "separated_SASA": data.separated_SASA,
        "complex_energy": data.complex_total_energy[1],
        "crossterm_interface_energy": data.crossterm_interface_energy,
    }
    for field in ("aromatic_dG_fraction", "aromatic_dSASA_fraction", "aromatic_nres", "gly_dG", "centroid_dG"):
        try:
            v = getattr(data, field)
            m[field] = v[1] if hasattr(v, "__len__") else v
        except (AttributeError, IndexError, TypeError):
            m[field] = None
    return m


def _hbonds(pose, sfxn, p: Dict, side_a: set) -> List[Dict]:
    from pyrosetta.rosetta.core.scoring.hbonds import HBondSet, fill_hbond_set

    sfxn(pose)
    pose.update_residue_neighbors()
    hs = HBondSet()
    fill_hbond_set(pose, False, hs)
    out = []
    for k in range(1, hs.nhbonds() + 1):
        hb = hs.hbond(k)
        d, a = hb.don_res(), hb.acc_res()
        cd, _, _ = rc.pdb_id(pose, d)
        ca, _, _ = rc.pdb_id(pose, a)
        if (cd in side_a) == (ca in side_a):
            continue
        e = hb.energy() * hb.weight()
        if e > p["hbond_energy_cutoff"]:
            continue
        don_bb = hb.don_hatm_is_protein_backbone()
        acc_bb = hb.acc_atm_is_protein_backbone()
        if not p["hbond_include_bb"] and (don_bb or acc_bb):
            continue
        rd, ra = pose.residue(d), pose.residue(a)
        heavy = rd.atom_base(hb.don_hatm())
        out.append({
            "donor": {"key": rc.key(pose, d), "chain": cd, "seq": rc.pdb_id(pose, d)[1], "icode": rc.pdb_id(pose, d)[2], "name": rd.name3(), "atom": rd.atom_name(heavy).strip(), "hydrogen": rd.atom_name(hb.don_hatm()).strip()},
            "acceptor": {"key": rc.key(pose, a), "chain": ca, "seq": rc.pdb_id(pose, a)[1], "icode": rc.pdb_id(pose, a)[2], "name": ra.name3(), "atom": ra.atom_name(hb.acc_atm()).strip()},
            "energy": e,
            "distance_HA": rd.xyz(hb.don_hatm()).distance(ra.xyz(hb.acc_atm())),
            "distance_DA": rd.xyz(heavy).distance(ra.xyz(hb.acc_atm())),
            "type": ("bb" if don_bb else "sc") + "-" + ("bb" if acc_bb else "sc"),
        })
    out.sort(key=lambda h: h["energy"])
    return out


def _unsats(pose, sfxn, p: Dict, n_chains_a: int) -> List[Dict]:
    """Polar atoms buried in the complex with no H-bond.

    'interface': exposed when the two sides are separated, so the burial is created
    by binding — the ones a designer must fix. 'preexisting': already buried in the
    separated partner (reported only on request).
    """
    from pyrosetta.rosetta.core.scoring.hbonds import HBondSet, fill_hbond_set

    sfxn(pose)
    pose.update_residue_neighbors()
    hs = HBondSet()
    fill_hbond_set(pose, False, hs)
    satisfied = set()
    for k in range(1, hs.nhbonds() + 1):
        hb = hs.hbond(k)
        if hb.energy() * hb.weight() > p["unsat_hbond_cutoff"]:
            continue
        d = hb.don_res()
        satisfied.add((d, pose.residue(d).atom_base(hb.don_hatm())))
        satisfied.add((hb.acc_res(), hb.acc_atm()))

    probe = float(p["unsat_probe"])
    cut = float(p["unsat_burial_sasa"])
    sasa_complex = rc.atom_sasa(pose, probe)
    sasa_sep = rc.atom_sasa(rc.separated_copy(pose, n_chains_a), probe)

    out = []
    for i in range(1, pose.total_residue() + 1):
        r = pose.residue(i)
        if not r.is_protein():
            continue
        polar = []
        for a in r.accpt_pos():
            polar.append((a, "aceptor"))
        for h in r.Hpos_polar():
            polar.append((r.atom_base(h), "doador"))
        seen = set()
        for a, kind in polar:
            if (a, kind) in seen:
                continue
            seen.add((a, kind))
            name = r.atom_name(a).strip()
            # Backbone N of proline has no H; the C-terminal oxygens are solvent-facing by construction.
            if name in ("OXT",):
                continue
            if (i, a) in satisfied:
                continue
            if sasa_complex[(i, a)] > cut:
                continue
            created = sasa_sep[(i, a)] > cut
            if not created and not p["unsat_include_preexisting"]:
                continue
            c, n, ic = rc.pdb_id(pose, i)
            out.append({
                "key": rc.key(pose, i), "chain": c, "seq": n, "icode": ic, "name": r.name3(),
                "atom": name, "kind": kind, "origin": "interface" if created else "preexisting",
                "sasa_complex": sasa_complex[(i, a)], "sasa_separated": sasa_sep[(i, a)],
                "backbone": r.atom_is_backbone(a),
            })
    return out


def _pair_energies(pose, sfxn, p: Dict, side_a: set) -> List[Dict]:
    from pyrosetta.rosetta.core.scoring import EMapVector

    sfxn(pose)
    weights = sfxn.weights()
    a_res = [i for i in range(1, pose.total_residue() + 1) if rc.pdb_id(pose, i)[0] in side_a]
    b_res = [i for i in range(1, pose.total_residue() + 1) if rc.pdb_id(pose, i)[0] not in side_a]
    cutoff = float(p["pair_neighbor_distance"])
    out = []
    for i in a_res:
        ri = pose.residue(i)
        ci = ri.nbr_atom_xyz()
        for j in b_res:
            rj = pose.residue(j)
            if ci.distance(rj.nbr_atom_xyz()) > cutoff + ri.nbr_radius() + rj.nbr_radius():
                continue
            emap = EMapVector()
            sfxn.eval_ci_2b(ri, rj, pose, emap)
            sfxn.eval_cd_2b(ri, rj, pose, emap)
            e = emap.dot(weights)
            if e <= p["pair_energy_cutoff"]:
                out.append({"a": rc.key(pose, i), "a_name": ri.name3(), "b": rc.key(pose, j), "b_name": rj.name3(), "energy": e})
    out.sort(key=lambda x: x["energy"])
    return out


def _alanine_scan(pose, sfxn, p: Dict, per_res_dsasa: Dict[str, float], side_a: set) -> List[Dict]:
    """ΔΔG = dG(X→A) − dG(WT), both after the same local repack, so packing noise cancels."""
    from pyrosetta.rosetta.core.pack.task import TaskFactory, operation
    from pyrosetta.rosetta.core.select.residue_selector import NeighborhoodResidueSelector, ResidueIndexSelector, NotResidueSelector
    from pyrosetta.rosetta.protocols.minimization_packing import PackRotamersMover
    from pyrosetta.rosetta.protocols.simple_moves import MutateResidue

    side = p["ala_side"]
    targets = []
    for i in range(1, pose.total_residue() + 1):
        c = rc.pdb_id(pose, i)[0]
        on_a = c in side_a
        if side == "A" and not on_a or side == "B" and on_a:
            continue
        r = pose.residue(i)
        if not r.is_protein() or r.name3() in ("ALA", "GLY", "PRO"):
            continue
        if per_res_dsasa.get(rc.key(pose, i), 0.0) < float(p["ala_min_dsasa"]):
            continue
        targets.append(i)

    def repacked(start, center):
        tf = TaskFactory()
        tf.push_back(operation.RestrictToRepacking())
        near = NeighborhoodResidueSelector(ResidueIndexSelector(str(center)), float(p["ala_repack_radius"]), True)
        tf.push_back(operation.OperateOnResidueSubset(operation.PreventRepackingRLT(), NotResidueSelector(near)))
        pk = PackRotamersMover(sfxn)
        pk.task_factory(tf)
        pk.apply(start)
        return start

    def dG(x):
        return _iam(x, p, sfxn, full=False).get_all_data().dG[1]

    out = []
    for n, i in enumerate(targets):
        protocol.progress(0.75 + 0.2 * n / max(1, len(targets)), "Alanine scan {}/{} · {}".format(n + 1, len(targets), rc.key(pose, i)))
        wt = repacked(pose.clone(), i)
        mut = pose.clone()
        MutateResidue(i, "ALA").apply(mut)
        mut = repacked(mut, i)
        g_wt, g_mut = dG(wt), dG(mut)
        out.append({"key": rc.key(pose, i), "name": pose.residue(i).name3(), "ddG": g_mut - g_wt, "dG_wt": g_wt, "dG_mut": g_mut})
    out.sort(key=lambda x: -x["ddG"])
    return out


def run(params: Dict, workdir: str) -> Dict:
    p = _params(params)
    t0 = time.time()
    protocol.progress(0.02, "Preparando estrutura")
    clean = workdir + "/input_clean.pdb"
    prep = structure.prepare(
        params["input"], clean, chains=list(p["side_a"]) + list(p["side_b"]),
        remove_waters=p["remove_waters"], remove_hetero=p["remove_hetero"], keep_residues=("MSE", "CGU", "SEP", "TPO", "PTR"),
    )

    protocol.progress(0.06, "Iniciando PyRosetta")
    rc.init(" ".join(x for x in (rc.init_flags_for(p["scorefxn"]), p["extra_flags"]) if x),
            packstat_oversample=int(p["packstat_oversample"]) if p["compute_packstat"] else 0)
    import pyrosetta

    pose = pyrosetta.pose_from_pdb(clean)
    sfxn = rc.scorefxn(p["scorefxn"])
    side_a = set(p["side_a"])
    n_chains_a = len(p["side_a"])

    protocol.progress(0.15, "InterfaceAnalyzer" + (" + packstat (lento)" if p["compute_packstat"] else ""))
    work = pose.clone()
    iam = _iam(work, p, sfxn, full=True)
    data = iam.get_all_data()
    if data.dG[1] == 0.0 and data.dSASA[1] == 0.0 and data.interface_nres[1] == 0:
        raise RuntimeError("O InterfaceAnalyzer não detectou interface entre {} e {} (falha silenciosa do Rosetta).".format(
            "".join(p["side_a"]), "".join(p["side_b"])))
    metrics = _metrics(data, p)

    if p["cms"]:
        protocol.progress(0.4, "Contact molecular surface")
        from pyrosetta.rosetta.core.select.residue_selector import ChainSelector
        from pyrosetta.rosetta.protocols.simple_filters import ContactMolecularSurfaceFilter

        cms = ContactMolecularSurfaceFilter(
            float(p["cms_filtered_area"]), float(p["cms_distance_weight"]), bool(p["cms_quick"]), False,
            ChainSelector(",".join(p["side_a"])), ChainSelector(",".join(p["side_b"])), bool(p["cms_use_rosetta_radii"]),
        )
        metrics["contact_molecular_surface"] = cms.compute(pose)

    per_residue = {}
    if p["per_residue"]:
        protocol.progress(0.5, "Dados por resíduo")
        pr = iam.get_all_per_residue_data()
        sfxn(pose)
        dG_map, dSASA_map, energy_map = {}, {}, {}
        for i in range(1, pose.total_residue() + 1):
            k = rc.key(pose, i)
            energy_map[k] = pose.energies().residue_total_energy(i)
            if pr.interface_residues[i]:
                dG_map[k] = pr.dG[i]
                dSASA_map[k] = pr.dSASA[i]
        per_residue = {"dG": dG_map, "dSASA": dSASA_map, "total_energy": energy_map}

    hbonds = _hbonds(pose.clone(), sfxn, p, side_a) if p["hbonds"] else []
    protocol.progress(0.6, "Polares insatisfeitos")
    unsats = _unsats(pose.clone(), sfxn, p, n_chains_a) if p["unsats"] else []
    protocol.progress(0.7, "Energias resíduo–resíduo")
    pairs = _pair_energies(pose.clone(), sfxn, p, side_a) if p["pair_energies"] else []
    ala = []
    if p["alanine_scan"]:
        ala = _alanine_scan(pose, sfxn, p, per_residue.get("dSASA", {}), side_a)

    protocol.progress(1.0, "Pronto")
    return {
        "input": params["input"],
        "prepared": prep,
        "interface": rc.interface_string(p["side_a"], p["side_b"]),
        "side_a": p["side_a"],
        "side_b": p["side_b"],
        "scorefxn": p["scorefxn"],
        "metrics": metrics,
        "hbonds": hbonds,
        "unsats": unsats,
        "per_residue": per_residue,
        "pair_energies": pairs,
        "alanine_scan": ala,
        "seconds": time.time() - t0,
    }
