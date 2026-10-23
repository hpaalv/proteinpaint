"""Cavity detection and characterisation with pyKVFinder (0.9.x).

Region modes:
  all     the whole receptor
  ligand  cavities within `ligand_cutoff` Å of "ligand" chains, which are removed
          from the receptor first — e.g. the peptide, to measure the empty groove it
          occupies, or a binder, to see the pocket it covers
  box     a box around chosen residues plus padding (pyKVFinder's box TOML)

Characterisation: volume/area, depth (max/avg, per point), hydropathy (per surface
point and average, choice of scale), lining residues and their class frequencies,
and openings (mouths) with their areas.

Cavity points are re-written for the viewer: pyKVFinder names them H/HA, which a
molecular viewer treats as hydrogens. Here interior points are 'CI', surface points
'CS', element C, residue name = cavity tag (KAA, KAB…), B-factor = depth,
occupancy = hydropathy.
"""

from __future__ import annotations

import os
from typing import Dict, List

from .. import protocol, structure

SCALES = ("EisenbergWeiss", "HessaHeijne", "KyteDoolittle", "MoonFleming", "RadzickaWolfenden", "WimleyWhite", "ZhaoLondon")

DEFAULTS = {
    "chains": [],               # receptor chains; empty = all (minus ligand chains)
    "region": "all",            # all | ligand | box
    "ligand_chains": [],
    "ligand_cutoff": 5.0,
    "box_residues": [],         # ["A:45", "A:63", …]
    "box_padding": 3.5,
    "step": 0.6,
    "probe_in": 1.4,
    "probe_out": 4.0,
    "removal_distance": 2.4,
    "volume_cutoff": 5.0,
    "surface": "SES",           # SES | SAS
    "ignore_backbone": False,
    "include_depth": True,
    "include_hydropathy": True,
    "hydrophobicity_scale": "EisenbergWeiss",
    "openings": True,
    "openings_cutoff": 1,
    "remove_waters": True,
    "remove_hetero": True,
}


def _rewrite_points(src: str, dst: str) -> int:
    n = 0
    with open(src) as f, open(dst, "w") as out:
        for line in f:
            if not line.startswith(("ATOM", "HETATM")):
                out.write(line)
                continue
            line = line.rstrip("\r\n")
            name = line[12:16].strip()
            atom = " CS " if name == "HA" else " CI "
            line = line.ljust(80)
            # Columns: 13-16 atom name, 22 chain, 77-78 element.
            line = "HETATM" + line[6:12] + atom + line[16:21] + "K" + line[22:76] + " C" + line[78:]
            out.write(line.rstrip() + "\n")
            n += 1
    return n


def run(params: Dict, workdir: str) -> Dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    import numpy as np
    import pyKVFinder as kv

    if p["hydrophobicity_scale"] not in SCALES:
        raise ValueError("Escala de hidrofobicidade desconhecida: " + str(p["hydrophobicity_scale"]))
    threads = int(params.get("_threads") or os.cpu_count() or 4)
    step = float(p["step"])

    st = structure.read(params["input"])
    all_chains = [c.name for c in st[0]]
    ligand_chains = list(p["ligand_chains"]) if p["region"] == "ligand" else []
    receptor_chains = [c for c in (p["chains"] or all_chains) if c not in ligand_chains]
    if not receptor_chains:
        raise ValueError("Nenhuma cadeia sobrou para o receptor.")

    protocol.progress(0.05, "Preparando receptor")
    receptor = os.path.join(workdir, "receptor.pdb")
    prep = structure.prepare(params["input"], receptor, chains=receptor_chains, remove_waters=p["remove_waters"], remove_hetero=p["remove_hetero"])
    atomic = kv.read_pdb(receptor)

    latomic = None
    if p["region"] == "ligand":
        if not ligand_chains:
            raise ValueError("Escolha a(s) cadeia(s) usada(s) como ligante.")
        lig = os.path.join(workdir, "ligand.pdb")
        structure.prepare(params["input"], lig, chains=ligand_chains, remove_waters=True, remove_hetero=False)
        latomic = kv.read_pdb(lig)

    if p["region"] == "box":
        if not p["box_residues"]:
            raise ValueError("Escolha os resíduos que definem a caixa.")
        names = {}
        for ch in st[0]:
            for r in ch:
                names["{}:{}".format(ch.name, r.seqid.num)] = r.name
        rows = []
        for k in p["box_residues"]:
            chain, num = k.split(":")
            num = "".join(c for c in num if c.isdigit() or c == "-")
            rows.append('["{}", "{}", "{}"]'.format(num, chain, names.get("{}:{}".format(chain, num), "UNK")))
        box = os.path.join(workdir, "box.toml")
        with open(box, "w") as f:
            f.write("[box]\nresidues = [{}]\npadding = {}\n".format(", ".join(rows), float(p["box_padding"])))
        vertices, atomic = kv.get_vertices_from_file(box, atomic, step=step, probe_in=float(p["probe_in"]), probe_out=float(p["probe_out"]), nthreads=threads)
        box_adjustment = True
    else:
        vertices = kv.get_vertices(atomic, probe_out=float(p["probe_out"]), step=step)
        box_adjustment = False

    protocol.progress(0.2, "Detectando cavidades")
    ncav, cavities = kv.detect(
        atomic, vertices, step=step, probe_in=float(p["probe_in"]), probe_out=float(p["probe_out"]),
        removal_distance=float(p["removal_distance"]), volume_cutoff=float(p["volume_cutoff"]),
        latomic=latomic, ligand_cutoff=float(p["ligand_cutoff"]), box_adjustment=box_adjustment,
        surface=p["surface"], nthreads=threads,
    )
    if ncav == 0:
        protocol.progress(1.0, "Nenhuma cavidade")
        return {"input": params["input"], "prepared": prep, "cavities": [], "points_path": None, "n": 0}

    protocol.progress(0.45, "Volume e área")
    surface, volume, area = kv.spatial(cavities, step=step, nthreads=threads)
    depths = None
    max_depth: Dict[str, float] = {}
    avg_depth: Dict[str, float] = {}
    if p["include_depth"]:
        protocol.progress(0.55, "Profundidade")
        depths, max_depth, avg_depth = kv.depth(cavities, step=step, nthreads=threads)
    protocol.progress(0.65, "Resíduos de revestimento")
    residues = kv.constitutional(cavities, atomic, vertices, step=step, probe_in=float(p["probe_in"]), ignore_backbone=bool(p["ignore_backbone"]), nthreads=threads)
    frequencies = kv.calculate_frequencies(residues)
    scales = None
    avg_hyd: Dict = {}
    if p["include_hydropathy"]:
        protocol.progress(0.75, "Hidropatia · " + p["hydrophobicity_scale"])
        scales, avg_hyd = kv.hydropathy(surface, atomic, vertices, step=step, probe_in=float(p["probe_in"]),
                                        hydrophobicity_scale=p["hydrophobicity_scale"], ignore_backbone=bool(p["ignore_backbone"]), nthreads=threads)
    openings: Dict = {}
    if p["openings"] and depths is not None:
        protocol.progress(0.85, "Aberturas")
        _n, _arr, openings = kv.openings(cavities, depths=depths, step=step, openings_cutoff=int(p["openings_cutoff"]), nthreads=threads)

    protocol.progress(0.92, "Exportando pontos")
    raw = os.path.join(workdir, "cavities_raw.pdb")
    kv.export(raw, cavities, surface, vertices, step=step, B=depths, Q=scales, nthreads=threads)
    points = os.path.join(workdir, "cavities.pdb")
    n_points = _rewrite_points(raw, points)

    cav_list: List[Dict] = []
    for tag in sorted(volume):
        lining = residues.get(tag, [])
        cav_list.append({
            "tag": tag,
            "volume": volume.get(tag),
            "area": area.get(tag),
            "max_depth": max_depth.get(tag),
            "avg_depth": avg_depth.get(tag),
            "avg_hydropathy": avg_hyd.get(tag),
            "residues": [{"key": "{}:{}".format(r[1], r[0]), "chain": r[1], "seq": r[0], "name": r[2]} for r in lining],
            "frequencies": frequencies.get(tag, {}),
            "openings": openings.get(tag, {}),
        })
    cav_list.sort(key=lambda c: -(c["volume"] or 0))
    protocol.progress(1.0, "Pronto")
    return {
        "input": params["input"],
        "prepared": prep,
        "region": p["region"],
        "receptor_chains": receptor_chains,
        "ligand_chains": ligand_chains,
        "n": int(ncav),
        "cavities": cav_list,
        "points_path": points,
        "n_points": n_points,
        "hydropathy_range": avg_hyd.get(p["hydrophobicity_scale"]) if p["include_hydropathy"] else None,
        "scale": p["hydrophobicity_scale"],
        "step": step,
        "total_volume": float(np.sum(list(volume.values()))),
    }
