/**
 * Distance, angle and dihedral by clicking atoms — Mol*'s measurement manager draws
 * them (dashed line + label in the scene); this module runs the click workflow and
 * keeps a readable list.
 */

import { StructureElement, StructureProperties as P } from 'molstar/lib/mol-model/structure';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { clearOverlay, setOverlay } from './overlay';
import { selectedLoci } from './selection';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type MeasureKind, type Result } from './types';

const ATOMS_NEEDED: Record<MeasureKind, number> = { distance: 2, angle: 3, dihedral: 4 };

interface Pick {
    loci: StructureElement.Loci;
    label: string;
    position: Vec3;
}

function firstAtom(loci: StructureElement.Loci): Pick | null {
    const first = loci.elements[0];
    if (!first || OrderedSet.size(first.indices) === 0) return null;
    const element = first.unit.elements[OrderedSet.getAt(first.indices, 0)]!;
    const location = StructureElement.Location.create(loci.structure, first.unit, element);
    const position = first.unit.conformation.position(element, Vec3());
    const label = `${P.chain.auth_asym_id(location)}:${P.atom.label_comp_id(location)}${P.residue.auth_seq_id(location)} ${P.atom.label_atom_id(location)}`;
    const single = StructureElement.Loci(loci.structure, [{ unit: first.unit, indices: OrderedSet.ofSingleton(OrderedSet.getAt(first.indices, 0)) }]);
    return { loci: single, label, position };
}

function angleDeg(a: Vec3, b: Vec3, c: Vec3): number {
    return (Vec3.angle(Vec3.sub(Vec3(), a, b), Vec3.sub(Vec3(), c, b)) * 180) / Math.PI;
}

function dihedralDeg(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
    return (Vec3.dihedralAngle(a, b, c, d) * 180) / Math.PI;
}

function requireRef(ref: string | undefined): string {
    if (!ref) throw new Error('o Mol* não criou a medida');
    return ref;
}

async function create(viewer: Viewer, kind: MeasureKind, picks: Pick[]): Promise<Result<true>> {
    const m = viewer.plugin.managers.structure.measurement;
    const [a, b, c, d] = picks;
    try {
        let value: string;
        let numeric: number;
        let ref: string;
        if (kind === 'distance') {
            numeric = Vec3.distance(a!.position, b!.position);
            value = `${numeric.toFixed(2)} Å`;
            ref = requireRef((await m.addDistance(a!.loci, b!.loci))?.selection?.ref);
        } else if (kind === 'angle') {
            numeric = angleDeg(a!.position, b!.position, c!.position);
            value = `${numeric.toFixed(1)}°`;
            ref = requireRef((await m.addAngle(a!.loci, b!.loci, c!.loci))?.selection?.ref);
        } else {
            numeric = dihedralDeg(a!.position, b!.position, c!.position, d!.position);
            value = `${numeric.toFixed(1)}°`;
            ref = requireRef((await m.addDihedral(a!.loci, b!.loci, c!.loci, d!.loci))?.selection?.ref);
        }
        viewer.measurements.push({ ref, kind, label: `${picks.map((p) => p.label).join(' — ')} · ${value}`, atoms: picks.map((p) => p.label), value: numeric, unit: kind === 'distance' ? 'Å' : '°' });
        viewer.notify();
        return ok(true);
    } catch (e) {
        return err(`Falha ao medir: ${errorMessage(e)}`);
    }
}

/**
 * Enters measure mode: clicks pick atoms (granularity forced to atom), and every N
 * picks become one measurement. Returns the function that leaves the mode.
 */
export function startMeasuring(
    viewer: Viewer,
    kind: MeasureKind,
    onProgress: (picked: number, needed: number, error?: string) => void,
): () => void {
    const plugin = viewer.plugin;
    const previous = plugin.managers.interactivity.props.granularity;
    plugin.managers.interactivity.setProps({ granularity: 'element' });
    const needed = ATOMS_NEEDED[kind];
    let picks: Pick[] = [];
    onProgress(0, needed);

    const sub = plugin.behaviors.interaction.click.subscribe(async ({ current }) => {
        if (!StructureElement.Loci.is(current.loci)) return;
        const pick = firstAtom(current.loci);
        if (!pick) return;
        picks.push(pick);
        onProgress(picks.length, needed);
        if (picks.length < needed) return;
        const done = picks;
        picks = [];
        // The clicks also toggled the atoms into the selection; take them back out.
        for (const p of done) plugin.managers.structure.selection.fromLoci('remove', p.loci);
        const result = await create(viewer, kind, done);
        onProgress(0, needed, result.ok ? undefined : result.error);
    });

    return () => {
        sub.unsubscribe();
        plugin.managers.interactivity.setProps({ granularity: previous });
    };
}

export async function removeMeasurement(viewer: Viewer, ref: string): Promise<void> {
    await viewer.plugin.build().delete(ref).commit();
    viewer.measurements = viewer.measurements.filter((m) => m.ref !== ref);
    viewer.notify();
}

export async function clearMeasurements(viewer: Viewer): Promise<void> {
    const builder = viewer.plugin.build();
    for (const m of viewer.measurements) builder.delete(m.ref);
    await builder.commit();
    viewer.measurements = [];
    viewer.notify();
}

// ---------------------------------------------------------------------------
// Between two selections
// ---------------------------------------------------------------------------

interface Stashed {
    /** Displayed positions, flat x,y,z. */
    xyz: Float64Array;
    labels: string[];
    summary: string;
    /** Structures the atoms came from. */
    owners: string[];
}

const stash = new WeakMap<Viewer, { a?: Stashed; b?: Stashed }>();

function collect(viewer: Viewer): Stashed | null {
    const loci = selectedLoci(viewer);
    const xyz: number[] = [];
    const labels: string[] = [];
    const chains = new Set<string>();
    const owners = new Set<string>();
    for (const l of loci) {
        const owner = viewer.idOf(l.structure);
        if (owner) owners.add(owner);
        for (const { unit, indices } of l.elements) {
            const location = StructureElement.Location.create(l.structure, unit);
            OrderedSet.forEach(indices, (k) => {
                const element = unit.elements[k]!;
                location.element = element;
                const p = unit.conformation.position(element, Vec3());
                xyz.push(p[0]!, p[1]!, p[2]!);
                labels.push(`${P.chain.auth_asym_id(location)}:${P.atom.label_comp_id(location)}${P.residue.auth_seq_id(location)} ${P.atom.label_atom_id(location)}`);
                chains.add(P.chain.auth_asym_id(location));
            });
        }
    }
    if (xyz.length === 0) return null;
    return { xyz: Float64Array.from(xyz), labels, summary: `${labels.length} átomos · ${[...chains].join(', ')}`, owners: [...owners] };
}

/** Remembers the current selection as side A or B of a pair measurement. */
export function captureSelection(viewer: Viewer, slot: 'a' | 'b'): Result<string> {
    const captured = collect(viewer);
    if (!captured) return err('Nada selecionado.');
    const current = stash.get(viewer) ?? {};
    current[slot] = captured;
    stash.set(viewer, current);
    return ok(captured.summary);
}

export function capturedSides(viewer: Viewer): { a: string | null; b: string | null } {
    const current = stash.get(viewer);
    return { a: current?.a?.summary ?? null, b: current?.b?.summary ?? null };
}

export interface PairMeasure {
    /** Closest approach between the two sets, Å, and the atoms that make it. */
    minDistance: number;
    minPair: [string, string];
    /** Distance between the centres of the two sets. */
    centroidDistance: number;
    /** Atom pairs within the cutoff. */
    contacts: number;
    cutoff: number;
    atomsA: number;
    atomsB: number;
}

/**
 * The numbers that matter between two groups of atoms: how close they come, how far
 * apart their centres sit, and how many pairs are in contact. The closest pair is
 * drawn in the scene so the number has a place.
 */
export async function measureBetweenSelections(viewer: Viewer, cutoff = 4): Promise<Result<PairMeasure>> {
    const current = stash.get(viewer);
    if (!current?.a || !current.b) return err('Guarde uma seleção como A e outra como B.');
    const { a, b } = current;
    const na = a.labels.length;
    const nb = b.labels.length;
    let best = Infinity;
    let bi = 0;
    let bj = 0;
    let contacts = 0;
    const cutoff2 = cutoff * cutoff;
    for (let i = 0; i < na; i++) {
        const ax = a.xyz[i * 3]!;
        const ay = a.xyz[i * 3 + 1]!;
        const az = a.xyz[i * 3 + 2]!;
        for (let j = 0; j < nb; j++) {
            const dx = ax - b.xyz[j * 3]!;
            const dy = ay - b.xyz[j * 3 + 1]!;
            const dz = az - b.xyz[j * 3 + 2]!;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < cutoff2) contacts++;
            if (d2 < best) {
                best = d2;
                bi = i;
                bj = j;
            }
        }
    }
    const centre = (s: Stashed, n: number) => {
        const c = Vec3();
        for (let i = 0; i < n; i++) Vec3.add(c, c, Vec3.create(s.xyz[i * 3]!, s.xyz[i * 3 + 1]!, s.xyz[i * 3 + 2]!));
        return Vec3.scale(c, c, 1 / n);
    };
    const ca = centre(a, na);
    const cb = centre(b, nb);
    const minDistance = Math.sqrt(best);
    const pa: [number, number, number] = [a.xyz[bi * 3]!, a.xyz[bi * 3 + 1]!, a.xyz[bi * 3 + 2]!];
    const pb: [number, number, number] = [b.xyz[bj * 3]!, b.xyz[bj * 3 + 1]!, b.xyz[bj * 3 + 2]!];
    await setOverlay(
        viewer,
        'pair-measure',
        {
            lines: [
                { a: pa, b: pb, color: 0x4cc9f0, radius: 0.07, dashes: 6, label: `${a.labels[bi]} — ${b.labels[bj]} · ${minDistance.toFixed(2)} Å` },
                { a: [ca[0]!, ca[1]!, ca[2]!], b: [cb[0]!, cb[1]!, cb[2]!], color: 0xf72585, radius: 0.05, dashes: 10, label: `centros · ${Vec3.distance(ca, cb).toFixed(2)} Å` },
            ],
            owners: [...a.owners, ...b.owners],
        },
        'Medida entre seleções',
    );
    return ok({
        minDistance,
        minPair: [a.labels[bi]!, b.labels[bj]!],
        centroidDistance: Vec3.distance(ca, cb),
        contacts,
        cutoff,
        atomsA: na,
        atomsB: nb,
    });
}

export async function clearPairMeasure(viewer: Viewer): Promise<void> {
    stash.delete(viewer);
    await clearOverlay(viewer, 'pair-measure');
}

/**
 * Measurements touching a structure that is about to go. Mol* measurement nodes sit
 * in their own group with cross-edges (`dependsOn`) to the structures they measure.
 */
function measurementsOf(viewer: Viewer, structureRefs: Set<string>): string[] {
    const cells = viewer.plugin.state.data.cells;
    const touches = (ref: string) => {
        const deps = cells.get(ref)?.transform.dependsOn ?? [];
        return deps.some((d) => structureRefs.has(d));
    };
    const refs = viewer.measurements.filter((m) => touches(m.ref)).map((m) => m.ref);
    for (const l of viewer.plugin.managers.structure.measurement.state.labels) {
        if (touches(l.transform.ref)) refs.push(l.transform.ref);
    }
    return refs;
}

/** Removes the measurements, Mol* labels and pair measure tied to a structure. */
export async function dropMeasurementsOf(viewer: Viewer, structureRefs: Set<string>, id: string): Promise<void> {
    const refs = measurementsOf(viewer, structureRefs);
    if (refs.length) {
        const builder = viewer.plugin.build();
        for (const r of refs) builder.delete(r);
        await builder.commit();
        const gone = new Set(refs);
        viewer.measurements = viewer.measurements.filter((m) => !gone.has(m.ref));
    }
    const current = stash.get(viewer);
    if (current?.a?.owners.includes(id)) delete current.a;
    if (current?.b?.owners.includes(id)) delete current.b;
}
