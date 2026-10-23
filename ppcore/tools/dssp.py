"""Secondary structure with pydssp (the DSSP re-implementation the RFdiffusion / MPNN
ecosystem uses), on the GPU when torch sees CUDA.

Also returns the backbone H-bond map pydssp computes (residue i donor → j acceptor),
which the app can draw as a contact matrix.
"""

from __future__ import annotations

from typing import Dict, List

from .. import protocol, structure

DEFAULTS = {
    "chains": [],          # empty = all polymer chains
    "device": "auto",      # auto | cuda | cpu
    "hbond_map": False,    # return the backbone H-bond map (large for big chains)
    "hbond_cutoff": 0.5,   # map value above which a pair counts as H-bonded
}


def run(params: Dict, workdir: str) -> Dict:
    p = dict(DEFAULTS)
    p.update({k: v for k, v in params.items() if v is not None})
    import numpy as np
    import pydssp

    try:
        import torch

        cuda = torch.cuda.is_available()
    except ImportError:
        torch = None
        cuda = False
    device = "cuda" if (p["device"] in ("auto", "cuda") and cuda) else "cpu"
    if p["device"] == "cuda" and not cuda:
        protocol.log("CUDA indisponível; usando CPU")

    st = structure.read(params["input"])
    chains = p["chains"] or [c.name for c in st[0]]
    ss: Dict[str, str] = {}
    per_chain: List[Dict] = []
    hb_maps = {}
    for n, ch in enumerate(chains):
        protocol.progress(n / max(1, len(chains)), "pydssp · cadeia " + ch)
        ids, coords = structure.backbone_coords(st, ch)
        if len(ids) < 3:
            continue
        coord = np.asarray(coords, dtype=np.float32)
        if torch is not None:
            coord_t = torch.tensor(coord, device=device)
            hb = pydssp.get_hbond_map(coord_t)
            labels = pydssp.assign(coord_t, out_type="c3")
            hb_np = hb.detach().cpu().numpy()
        else:
            hb_np = pydssp.get_hbond_map(coord)
            labels = pydssp.assign(coord, out_type="c3")
        labels = [str(x) for x in list(labels)]
        counts = {"H": 0, "E": 0, "-": 0}
        for (num, icode, _name), lab in zip(ids, labels):
            ss[structure.residue_key(ch, num, icode)] = lab
            counts[lab] = counts.get(lab, 0) + 1
        total = max(1, len(labels))
        per_chain.append({"chain": ch, "length": len(labels), "helix": counts["H"] / total, "strand": counts["E"] / total,
                          "loop": counts["-"] / total, "string": "".join(labels)})
        if p["hbond_map"]:
            pairs = np.argwhere(hb_np > float(p["hbond_cutoff"]))
            hb_maps[ch] = [[structure.residue_key(ch, ids[i][0], ids[i][1]), structure.residue_key(ch, ids[j][0], ids[j][1]), float(hb_np[i, j])]
                           for i, j in pairs.tolist()]
    protocol.progress(1.0, "Pronto")
    return {"input": params["input"], "device": device, "ss": ss, "chains": per_chain, "hbond_map": hb_maps}
