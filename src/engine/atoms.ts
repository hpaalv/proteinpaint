/**
 * Atom lookup by name in the coordinates currently drawn.
 *
 * Results from Python name atoms ('A:45', 'OE1'); the viewer must place overlays at
 * the positions on screen, which differ from the file once a structure has been
 * superposed. Looking atoms up in the displayed structure keeps them in register.
 */

import { Structure, StructureElement, StructureProperties as P, Unit } from 'molstar/lib/mol-model/structure';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { displayedStructureRef } from './compare';
import type { Point } from './overlay';
import type { Viewer } from './viewer';
import type { StructureId } from './types';

export interface AtomSpec {
    /** Residue key 'A:45' / 'A:45A'. */
    residue: string;
    atom: string;
}

export function displayedStructure(viewer: Viewer, id: StructureId): Structure | undefined {
    const entry = viewer.entry(id);
    if (!entry) return undefined;
    return viewer.plugin.state.data.cells.get(displayedStructureRef(viewer.plugin, entry))?.obj?.data as Structure | undefined;
}

/** Positions for the requested atoms; missing ones are absent from the map. */
export function atomPositions(viewer: Viewer, id: StructureId, specs: AtomSpec[]): Map<string, Point> {
    const out = new Map<string, Point>();
    const structure = displayedStructure(viewer, id);
    if (!structure || specs.length === 0) return out;
    const wanted = new Set(specs.map((s) => `${s.residue}|${s.atom}`));
    const residues = new Set(specs.map((s) => s.residue));
    const loc = StructureElement.Location.create(structure);
    const v = Vec3();
    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit)) continue;
        loc.unit = unit;
        const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
        let lastResidue = -1;
        let residueWanted = false;
        let key = '';
        for (let i = 0; i < unit.elements.length; i++) {
            const e = unit.elements[i]!;
            loc.element = e;
            const r = residueOf[e]!;
            if (r !== lastResidue) {
                lastResidue = r;
                key = `${P.chain.auth_asym_id(loc)}:${P.residue.auth_seq_id(loc)}${P.residue.pdbx_PDB_ins_code(loc) || ''}`;
                residueWanted = residues.has(key);
            }
            if (!residueWanted) continue;
            const k = `${key}|${P.atom.label_atom_id(loc)}`;
            if (wanted.has(k) && !out.has(k)) {
                unit.conformation.position(e, v);
                out.set(k, [v[0]!, v[1]!, v[2]!]);
            }
        }
    }
    return out;
}

/** Residue centroid (all atoms), for residue-level overlays. */
export function residueCentroids(viewer: Viewer, id: StructureId, keys: string[]): Map<string, Point> {
    const out = new Map<string, Point>();
    const structure = displayedStructure(viewer, id);
    if (!structure) return out;
    const wanted = new Set(keys);
    const acc = new Map<string, [number, number, number, number]>();
    const loc = StructureElement.Location.create(structure);
    const v = Vec3();
    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit)) continue;
        loc.unit = unit;
        for (let i = 0; i < unit.elements.length; i++) {
            const e = unit.elements[i]!;
            loc.element = e;
            const key = `${P.chain.auth_asym_id(loc)}:${P.residue.auth_seq_id(loc)}${P.residue.pdbx_PDB_ins_code(loc) || ''}`;
            if (!wanted.has(key)) continue;
            unit.conformation.position(e, v);
            const a = acc.get(key) ?? [0, 0, 0, 0];
            a[0] += v[0]!;
            a[1] += v[1]!;
            a[2] += v[2]!;
            a[3] += 1;
            acc.set(key, a);
        }
    }
    for (const [k, a] of acc) out.set(k, [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
    return out;
}
