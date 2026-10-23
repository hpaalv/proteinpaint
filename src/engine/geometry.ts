/**
 * Atom coordinates as flat arrays, a uniform grid for nearest-atom queries and the
 * small bits of linear algebra the figure tools need (centroids, principal axes).
 *
 * Coordinates are read from the displayed structure (superposed, if it was), while
 * atoms are identified by their model ElementIndex — the same index the root
 * structure uses — so a paint bundle built from the root lands on the right atoms.
 */

import { Structure, StructureElement, StructureProperties as P, Unit } from 'molstar/lib/mol-model/structure';
import { OrderedSet, SortedArray } from 'molstar/lib/mol-data/int';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { displayedStructure } from './atoms';
import { structureRefFor } from './style';
import type { Viewer } from './viewer';
import type { StructureId } from './types';

export type V3 = [number, number, number];

export interface AtomTable {
    count: number;
    /** x0 y0 z0 x1 … */
    xyz: Float64Array;
    /** Model ElementIndex of each atom. */
    element: Int32Array;
    /** Model residue index of each atom (for per-residue grouping). */
    residue: Int32Array;
    chain: string[];
    /** True for Cα atoms of polymer residues. */
    isCA: Uint8Array;
}

/**
 * Heavy atoms of a structure as displayed, optionally restricted to chains or to
 * an explicit set of ElementIndex values.
 */
export function atomTable(viewer: Viewer, id: StructureId, options: { chains?: ReadonlySet<string>; elements?: ReadonlySet<number> } = {}): AtomTable {
    const structure = displayedStructure(viewer, id);
    const xyz: number[] = [];
    const element: number[] = [];
    const residue: number[] = [];
    const chain: string[] = [];
    const isCA: number[] = [];
    if (structure) {
        const loc = StructureElement.Location.create(structure);
        const v = Vec3();
        for (const unit of structure.units) {
            if (!Unit.isAtomic(unit)) continue;
            loc.unit = unit;
            loc.element = unit.elements[0]!;
            const c = P.chain.auth_asym_id(loc);
            if (options.chains && !options.chains.has(c)) continue;
            const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
            for (let i = 0; i < unit.elements.length; i++) {
                const e = unit.elements[i]!;
                if (options.elements && !options.elements.has(e)) continue;
                loc.element = e;
                const symbol = P.atom.type_symbol(loc);
                if (symbol === 'H' || symbol === 'D') continue;
                unit.conformation.position(e, v);
                xyz.push(v[0]!, v[1]!, v[2]!);
                element.push(e);
                residue.push(residueOf[e]!);
                chain.push(c);
                isCA.push(P.atom.label_atom_id(loc) === 'CA' ? 1 : 0);
            }
        }
    }
    return {
        count: element.length,
        xyz: Float64Array.from(xyz),
        element: Int32Array.from(element),
        residue: Int32Array.from(residue),
        chain,
        isCA: Uint8Array.from(isCA),
    };
}

/** ElementIndex values of the current Mol* selection in one structure. */
export function selectedElements(viewer: Viewer, id: StructureId): Set<number> {
    const out = new Set<number>();
    const entry = viewer.entry(id);
    const root = entry && structureRefFor(viewer.plugin, entry)?.cell.obj?.data;
    if (!root) return out;
    const loci = viewer.plugin.managers.structure.selection.getLoci(root);
    if (!StructureElement.Loci.is(loci)) return out;
    for (const { unit, indices } of loci.elements) {
        OrderedSet.forEach(indices, (i) => {
            out.add(unit.elements[i]!);
        });
    }
    return out;
}

/**
 * A bundle over the root structure covering the given ElementIndex values — the form
 * paint ops are stored in (style.ts), valid as long as the structure is loaded.
 */
export function bundleOf(viewer: Viewer, id: StructureId, elements: ReadonlySet<number>): StructureElement.Bundle | null {
    const entry = viewer.entry(id);
    const root = entry && (structureRefFor(viewer.plugin, entry)?.cell.obj?.data as Structure | undefined);
    if (!root || elements.size === 0) return null;
    const parts: StructureElement.Loci['elements'][number][] = [];
    for (const unit of root.units) {
        const picked: number[] = [];
        for (let i = 0; i < unit.elements.length; i++) if (elements.has(unit.elements[i]!)) picked.push(i);
        if (picked.length) parts.push({ unit, indices: SortedArray.ofSortedArray(picked) as unknown as StructureElement.UnitIndex[] & OrderedSet<StructureElement.UnitIndex> });
    }
    if (parts.length === 0) return null;
    return StructureElement.Bundle.fromLoci(StructureElement.Loci(root, parts));
}

// ---------------------------------------------------------------------------
// Nearest-point queries
// ---------------------------------------------------------------------------

/**
 * Uniform grid over a point set. `nearest` searches outward shell by shell and stops
 * once no unvisited cell can hold anything closer, so a query costs a few cells
 * near the set and is capped at `maxDistance` far from it.
 */
export class PointGrid {
    private readonly cells = new Map<number, number[]>();
    private readonly min: V3;
    private readonly dims: V3;

    constructor(
        private readonly xyz: Float64Array,
        private readonly cell = 4,
    ) {
        const n = xyz.length / 3;
        const lo: V3 = [Infinity, Infinity, Infinity];
        const hi: V3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 3; k++) {
                const x = xyz[i * 3 + k]!;
                if (x < lo[k]!) lo[k] = x;
                if (x > hi[k]!) hi[k] = x;
            }
        }
        this.min = n ? lo : [0, 0, 0];
        this.dims = n ? [0, 1, 2].map((k) => Math.floor((hi[k]! - lo[k]!) / cell) + 1) as V3 : [0, 0, 0];
        for (let i = 0; i < n; i++) {
            const key = this.key(this.index(xyz[i * 3]!, 0), this.index(xyz[i * 3 + 1]!, 1), this.index(xyz[i * 3 + 2]!, 2));
            const list = this.cells.get(key);
            if (list) list.push(i);
            else this.cells.set(key, [i]);
        }
    }

    get size(): number {
        return this.xyz.length / 3;
    }

    private index(x: number, axis: 0 | 1 | 2): number {
        return Math.floor((x - this.min[axis]) / this.cell);
    }

    private key(i: number, j: number, k: number): number {
        return (i * this.dims[1] + j) * this.dims[2] + k;
    }

    /** Distance from (x, y, z) to the nearest point and its index; Infinity / -1 beyond maxDistance. */
    nearest(x: number, y: number, z: number, maxDistance: number): { distance: number; index: number } {
        if (this.size === 0) return { distance: Infinity, index: -1 };
        const ci = this.index(x, 0);
        const cj = this.index(y, 1);
        const ck = this.index(z, 2);
        let best = maxDistance * maxDistance;
        let bestIndex = -1;
        const maxShell = Math.ceil(maxDistance / this.cell) + 1;
        for (let shell = 0; shell <= maxShell; shell++) {
            // Every point in this shell is at least (shell − 1) cells away.
            const floor = Math.max(0, shell - 1) * this.cell;
            if (floor * floor > best) break;
            for (let i = ci - shell; i <= ci + shell; i++) {
                if (i < 0 || i >= this.dims[0]) continue;
                for (let j = cj - shell; j <= cj + shell; j++) {
                    if (j < 0 || j >= this.dims[1]) continue;
                    for (let k = ck - shell; k <= ck + shell; k++) {
                        if (k < 0 || k >= this.dims[2]) continue;
                        // Only the surface of the cube: inner cells were visited in earlier shells.
                        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== shell) continue;
                        const list = this.cells.get(this.key(i, j, k));
                        if (!list) continue;
                        for (const p of list) {
                            const dx = this.xyz[p * 3]! - x;
                            const dy = this.xyz[p * 3 + 1]! - y;
                            const dz = this.xyz[p * 3 + 2]! - z;
                            const d = dx * dx + dy * dy + dz * dz;
                            if (d < best) {
                                best = d;
                                bestIndex = p;
                            }
                        }
                    }
                }
            }
        }
        return bestIndex < 0 ? { distance: Infinity, index: -1 } : { distance: Math.sqrt(best), index: bestIndex };
    }
}

/** Indices of atoms in `a` with any atom of `b` within `cutoff`. */
export function atomsNear(a: AtomTable, b: AtomTable, cutoff: number): number[] {
    const grid = new PointGrid(b.xyz, Math.max(2, cutoff));
    const out: number[] = [];
    for (let i = 0; i < a.count; i++) {
        if (grid.nearest(a.xyz[i * 3]!, a.xyz[i * 3 + 1]!, a.xyz[i * 3 + 2]!, cutoff).index >= 0) out.push(i);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Small vector algebra
// ---------------------------------------------------------------------------

export function centroid(xyz: Float64Array, indices?: ArrayLike<number>): V3 | null {
    const n = indices ? indices.length : xyz.length / 3;
    if (n === 0) return null;
    const c: V3 = [0, 0, 0];
    for (let m = 0; m < n; m++) {
        const i = indices ? indices[m]! : m;
        c[0] += xyz[i * 3]!;
        c[1] += xyz[i * 3 + 1]!;
        c[2] += xyz[i * 3 + 2]!;
    }
    return [c[0] / n, c[1] / n, c[2] / n];
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export function unit(a: V3): V3 {
    const n = Math.hypot(a[0], a[1], a[2]);
    return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
}

/** Rodrigues' rotation of v about a unit axis. */
export function rotate(v: V3, axis: V3, degrees: number): V3 {
    const t = (degrees * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const k = cross(axis, v);
    const d = dot(axis, v) * (1 - c);
    return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

/** Dominant principal axis (largest-variance direction) by power iteration on the covariance. */
export function principalAxis(xyz: Float64Array, indices: ArrayLike<number>): V3 | null {
    const c = centroid(xyz, indices);
    if (!c || indices.length < 2) return null;
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let n = 0; n < indices.length; n++) {
        const i = indices[n]!;
        const d = [xyz[i * 3]! - c[0], xyz[i * 3 + 1]! - c[1], xyz[i * 3 + 2]! - c[2]];
        for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) m[r * 3 + q]! += d[r]! * d[q]!;
    }
    let v: V3 = [1, 0.5, 0.25];
    for (let it = 0; it < 64; it++) {
        v = unit([m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]]);
    }
    return v;
}
