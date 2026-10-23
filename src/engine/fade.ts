/**
 * Figure effects from cdr_panels.py, done on the GPU instead of per-residue ChimeraX
 * colour writes:
 *
 * - **Distance fade** — every residue's opacity follows a smoothstep of its distance
 *   to a reference set (the interface, the selection, some chains): opaque within
 *   `near`, down to `minOpacity` beyond `far`. ChimeraX's `transparency` only steps,
 *   which is why the script wrote alpha per residue; Mol* transparency is per atom,
 *   so the gradient is quantised finely enough (48 levels) to read as continuous.
 * - **Footprint** (`color zone`) — target atoms within `distance` of the source take
 *   the colour of the nearest source atom, so CDR or binder colours are projected
 *   onto the target's surface.
 *
 * Both are tagged paint ops (style.ts): re-running replaces the previous result and
 * clearing leaves the user's own colours alone.
 */

import { StructureElement } from 'molstar/lib/mol-model/structure';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { chainColor } from './coloring';
import { atomTable, atomsNear, bundleOf, PointGrid, selectedElements, type AtomTable } from './geometry';
import { addPaint, removePaint, structureRefFor } from './style';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type Result, type StructureId } from './types';

export const FADE_TAG = 'fade';
export const FOOTPRINT_TAG = 'footprint';

/** What distances are measured to. */
export type FigureReference =
    | { kind: 'selection' }
    /** Atoms of binder chains within `cutoff` of the other polymer chains, and vice versa (per structure, from chain roles). */
    | { kind: 'interface'; cutoff: number }
    | { kind: 'chains'; structureId: StructureId; chains: string[] };

export interface FadeOptions {
    reference: FigureReference;
    /** Fully opaque up to this distance (Å). */
    near: number;
    /** Minimum opacity from this distance on (Å). */
    far: number;
    /** 0–1; cdr_panels.py uses 45/255 ≈ 0.18. */
    minOpacity: number;
    /** One value per residue (as the script) instead of per atom. */
    perResidue: boolean;
    /** Structures to fade; default every visible one. */
    structures?: StructureId[];
}

export const DEFAULT_FADE: Omit<FadeOptions, 'reference'> = { near: 5, far: 28, minOpacity: 0.18, perResidue: true };

function polymerChains(viewer: Viewer, id: StructureId, predicate: (role: string) => boolean): Set<string> {
    const info = viewer.entry(id)?.info;
    return new Set(info?.chains.filter((c) => c.isPolymer && predicate(c.role)).map((c) => c.authAsymId) ?? []);
}

/** Reference atoms from every structure involved, in displayed coordinates, as one table. */
interface OwnedAtoms {
    id: StructureId;
    table: AtomTable;
}

function referenceAtoms(viewer: Viewer, reference: FigureReference, structures: StructureId[]): Result<OwnedAtoms[]> {
    const tables: OwnedAtoms[] = [];
    if (reference.kind === 'chains') {
        tables.push({ id: reference.structureId, table: atomTable(viewer, reference.structureId, { chains: new Set(reference.chains) }) });
    } else if (reference.kind === 'selection') {
        for (const id of structures) {
            const elements = selectedElements(viewer, id);
            if (elements.size) tables.push({ id, table: atomTable(viewer, id, { elements }) });
        }
        if (tables.length === 0) return err('Nada selecionado.');
    } else {
        for (const id of structures) {
            const binder = polymerChains(viewer, id, (r) => r === 'binder');
            const other = polymerChains(viewer, id, (r) => r !== 'binder');
            if (binder.size === 0 || other.size === 0) continue;
            const a = atomTable(viewer, id, { chains: binder });
            const b = atomTable(viewer, id, { chains: other });
            const pick = (t: AtomTable, idx: number[]): OwnedAtoms => ({ id, table: atomTable(viewer, id, { elements: new Set(idx.map((i) => t.element[i]!)) }) });
            tables.push(pick(a, atomsNear(a, b, reference.cutoff)), pick(b, atomsNear(b, a, reference.cutoff)));
        }
        if (tables.length === 0) return err('Nenhuma estrutura com cadeia de papel "binder" e outra cadeia. Ajuste os papéis na árvore.');
    }
    const nonEmpty = tables.filter((t) => t.table.count > 0);
    return nonEmpty.length ? ok(nonEmpty) : err('A referência não tem átomos.');
}

function merge(owned: OwnedAtoms[]): Float64Array {
    const tables = owned.map((o) => o.table);
    const out = new Float64Array(tables.reduce((n, t) => n + t.xyz.length, 0));
    let o = 0;
    for (const t of tables) {
        out.set(t.xyz, o);
        o += t.xyz.length;
    }
    return out;
}

function visibleStructures(viewer: Viewer): StructureId[] {
    return [...viewer.entries.values()].filter((e) => e.info.visible).map((e) => e.info.id);
}

const smoothstep = (t: number) => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
};

const LEVELS = 48;

/**
 * Applies the distance fade, replacing a previous one. Returns how many residues ended
 * up partly transparent.
 */
export async function fadeByDistance(viewer: Viewer, options: FadeOptions): Promise<Result<{ faded: number; structures: number }>> {
    try {
        const structures = options.structures ?? visibleStructures(viewer);
        if (structures.length === 0) return err('Nenhuma estrutura visível.');
        const refs = referenceAtoms(viewer, options.reference, structures);
        if (!refs.ok) return refs;
        const grid = new PointGrid(merge(refs.value), 4);
        const near = Math.max(0, options.near);
        const far = Math.max(near + 0.1, options.far);
        let faded = 0;
        let touched = 0;

        for (const id of structures) {
            await removePaint(viewer, id, FADE_TAG);
            const atoms = atomTable(viewer, id);
            if (atoms.count === 0) continue;
            // Distance per atom, capped at `far` (beyond it the value no longer changes).
            const dist = new Float64Array(atoms.count);
            for (let i = 0; i < atoms.count; i++) {
                dist[i] = Math.min(far, grid.nearest(atoms.xyz[i * 3]!, atoms.xyz[i * 3 + 1]!, atoms.xyz[i * 3 + 2]!, far).distance);
            }
            if (options.perResidue) {
                const minByResidue = new Map<number, number>();
                for (let i = 0; i < atoms.count; i++) {
                    const r = atoms.residue[i]!;
                    minByResidue.set(r, Math.min(minByResidue.get(r) ?? Infinity, dist[i]!));
                }
                for (let i = 0; i < atoms.count; i++) dist[i] = minByResidue.get(atoms.residue[i]!)!;
            }
            // Quantise transparency into levels; level 0 (opaque) needs no layer.
            const byLevel = new Map<number, Set<number>>();
            const fadedResidues = new Set<number>();
            for (let i = 0; i < atoms.count; i++) {
                const opacity = 1 + smoothstep((dist[i]! - near) / (far - near)) * (options.minOpacity - 1);
                const level = Math.round((1 - opacity) * LEVELS);
                if (level <= 0) continue;
                fadedResidues.add(atoms.residue[i]!);
                let set = byLevel.get(level);
                if (!set) byLevel.set(level, (set = new Set()));
                set.add(atoms.element[i]!);
            }
            const layers: { value: number; bundle: StructureElement.Bundle }[] = [];
            for (const [level, elements] of [...byLevel].sort((a, b) => a[0] - b[0])) {
                const bundle = bundleOf(viewer, id, elements);
                if (bundle) layers.push({ value: level / LEVELS, bundle });
            }
            if (layers.length === 0) continue;
            const r = await addPaint(viewer, id, { kind: 'transparency-layers', layers, tag: FADE_TAG });
            if (!r.ok) return r;
            faded += fadedResidues.size;
            touched++;
        }
        return ok({ faded, structures: touched });
    } catch (e) {
        return err(`Falha no gradiente de transparência: ${errorMessage(e)}`);
    }
}

export async function clearFade(viewer: Viewer): Promise<Result<true>> {
    for (const id of viewer.entries.keys()) {
        const r = await removePaint(viewer, id, FADE_TAG);
        if (!r.ok) return r;
    }
    return ok(true);
}

// ---------------------------------------------------------------------------
// Footprint
// ---------------------------------------------------------------------------

export interface FootprintOptions {
    /** Structure and chains coloured (usually the target / pMHC). */
    target: { structureId: StructureId; chains: string[] };
    /** What is projected (usually the binder or the CDRs). */
    source: FigureReference;
    /** Radius of the zone, Å (cdr_panels.py: 7). */
    distance: number;
    /** 'nearest': colour of the nearest source atom (ChimeraX color zone). 'uniform': one colour. */
    mode: 'nearest' | 'uniform';
    color: number;
}

/**
 * Colour of each source atom as drawn: the last explicit colour painted on it, else
 * its chain colour. Scheme colours other than chain-based ones fall back to chain.
 */
function displayedColors(viewer: Viewer, id: StructureId, atoms: AtomTable): Uint32Array {
    const entry = viewer.entry(id)!;
    const out = new Uint32Array(atoms.count);
    const chainCache = new Map<string, number>();
    for (let i = 0; i < atoms.count; i++) {
        const c = atoms.chain[i]!;
        let color = chainCache.get(c);
        if (color === undefined) chainCache.set(c, (color = chainColor(viewer, entry, c)));
        out[i] = color;
    }
    const root = structureRefFor(viewer.plugin, entry)?.cell.obj?.data;
    if (!root) return out;
    const painted = new Map<number, number>();
    const record = (bundle: StructureElement.Bundle, color: number) => {
        const loci = StructureElement.Bundle.toLoci(bundle, root);
        for (const { unit, indices } of loci.elements) OrderedSet.forEach(indices, (k) => void painted.set(unit.elements[k]!, color));
    };
    for (const op of entry.paint) {
        if (op.kind === 'color' && op.color !== null) record(op.bundle, op.color);
        if (op.kind === 'color-layers' && op.tag !== FOOTPRINT_TAG) for (const l of op.layers) record(l.bundle, l.color);
    }
    for (let i = 0; i < atoms.count; i++) {
        const p = painted.get(atoms.element[i]!);
        if (p !== undefined) out[i] = p;
    }
    return out;
}

export async function paintFootprint(viewer: Viewer, options: FootprintOptions): Promise<Result<{ atoms: number }>> {
    try {
        const targetId = options.target.structureId;
        if (!viewer.entry(targetId)) return err('Estrutura não encontrada.');
        await removePaint(viewer, targetId, FOOTPRINT_TAG);
        const refs = referenceAtoms(viewer, options.source, visibleStructures(viewer));
        if (!refs.ok) return refs;
        // Source atoms on the target chains themselves would paint the target with its own colour.
        const targetChains = new Set(options.target.chains);
        const sources = refs.value
            .map((o) => (o.id !== targetId ? o : { id: o.id, table: atomTable(viewer, o.id, { elements: new Set([...o.table.element].filter((_, i) => !targetChains.has(o.table.chain[i]!))) }) }))
            .filter((o) => o.table.count > 0);
        if (sources.length === 0) return err('A fonte do footprint está toda dentro do alvo.');
        const xyz = merge(sources);
        const colors = new Uint32Array(xyz.length / 3);
        if (options.mode === 'nearest') {
            let o = 0;
            for (const { id, table } of sources) {
                colors.set(displayedColors(viewer, id, table), o);
                o += table.count;
            }
        } else colors.fill(options.color);

        const target = atomTable(viewer, targetId, { chains: new Set(options.target.chains) });
        const grid = new PointGrid(xyz, Math.max(2, options.distance));
        const byColor = new Map<number, Set<number>>();
        let count = 0;
        for (let i = 0; i < target.count; i++) {
            const hit = grid.nearest(target.xyz[i * 3]!, target.xyz[i * 3 + 1]!, target.xyz[i * 3 + 2]!, options.distance);
            if (hit.index < 0) continue;
            const color = colors[hit.index]!;
            let set = byColor.get(color);
            if (!set) byColor.set(color, (set = new Set()));
            set.add(target.element[i]!);
            count++;
        }
        if (count === 0) return err(`Nenhum átomo do alvo a menos de ${options.distance} Å da fonte.`);
        const layers: { color: number; bundle: StructureElement.Bundle }[] = [];
        for (const [color, elements] of byColor) {
            const bundle = bundleOf(viewer, targetId, elements);
            if (bundle) layers.push({ color, bundle });
        }
        const r = await addPaint(viewer, targetId, { kind: 'color-layers', layers, tag: FOOTPRINT_TAG });
        return r.ok ? ok({ atoms: count }) : r;
    } catch (e) {
        return err(`Falha no footprint: ${errorMessage(e)}`);
    }
}

export async function clearFootprint(viewer: Viewer): Promise<Result<true>> {
    for (const id of viewer.entries.keys()) {
        const r = await removePaint(viewer, id, FOOTPRINT_TAG);
        if (!r.ok) return r;
    }
    return ok(true);
}
