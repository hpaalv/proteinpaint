/**
 * Chain superposition, modelled on ChimeraX `matchmaker`.
 *
 * Every numerical piece is Mol*'s own: Needleman–Wunsch with BLOSUM62
 * (AlignSequences), Kabsch (MinimizeRmsd) and TM-align. What this file adds is the
 * part matchmaker has and Mol* does not — iterative pruning of far pairs — plus the
 * per-residue report the UI needs.
 *
 * Frames: alignment always runs on the untransformed (root) coordinates of both
 * chains. The mobile chain's final matrix is then `referenceMatrix · fit`, so
 * superposing onto a structure that was itself moved earlier still lands correctly,
 * and re-running a superposition replaces the previous one instead of stacking on it.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { StateObjectSelector } from 'molstar/lib/mol-state';
import { StructureElement, StructureProperties, Unit, type ElementIndex, type Structure } from 'molstar/lib/mol-model/structure';
import { AlignSequences } from 'molstar/lib/mol-model/sequence/alignment/sequence';
import { getProteinOneLetterCode } from 'molstar/lib/mol-model/sequence/constants';
import { MinimizeRmsd } from 'molstar/lib/mol-math/linear-algebra/3d/minimize-rmsd';
import { TMAlign } from 'molstar/lib/mol-math/linear-algebra/3d/tm-align';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra/3d/mat4';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { OrderedSet, SortedArray } from 'molstar/lib/mol-data/int';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import type { StructureEntry, Viewer } from './viewer';
import {
    ok,
    err,
    errorMessage,
    type ChainDeviation,
    type ChainRef,
    type ResiduePair,
    type Result,
    type StructureId,
    type SuperposeMethod,
    type SuperposeReport,
} from './types';

/** ChimeraX matchmaker defaults: prune until every pair is within 2.0 Å. */
const PRUNE_CUTOFF = 2.0;
/** Below this many pairs a rigid fit is meaningless. */
const MIN_PAIRS = 3;

const SUPERPOSITION_TAG = 'pp-superposition';

interface ChainTrace {
    unit: Unit.Atomic;
    /** One Cα (or P) per residue, as indices into unit.elements. */
    element: StructureElement.Loci.Element;
}

/** Aligned residue pairs as element indices into each chain's unit. */
interface Alignment {
    ref: ElementIndex[];
    mob: ElementIndex[];
    /** Present only when the method computes its own fit (TM-align). */
    transform?: Mat4;
    tmScore?: number;
}

// ---------------------------------------------------------------------------
// State-tree access
// ---------------------------------------------------------------------------

function rootStructure(entry: StructureEntry): Structure | undefined {
    return entry.structure.cell?.obj?.data as Structure | undefined;
}

function transformNode(plugin: PluginContext, entry: StructureEntry) {
    return plugin.state.data.selectQ((q) =>
        q.byRef(entry.structure.ref).subtree().withTransformer(StateTransforms.Model.TransformStructureConformation),
    )[0];
}

/** The matrix currently applied to a structure, identity when it has never been moved. */
function currentMatrix(plugin: PluginContext, entry: StructureEntry): Mat4 {
    const params = transformNode(plugin, entry)?.transform.params;
    if (params?.transform.name === 'matrix') {
        const { data, transpose } = params.transform.params;
        return transpose ? Mat4.transpose(Mat4(), data) : Mat4.copy(Mat4(), data);
    }
    return Mat4.identity();
}

async function applyMatrix(plugin: PluginContext, entry: StructureEntry, matrix: Mat4): Promise<void> {
    const params = { transform: { name: 'matrix' as const, params: { data: matrix, transpose: false } } };
    const existing = transformNode(plugin, entry);
    // insert() adopts the structure's children, so components and representations
    // follow the transform without being rebuilt.
    const builder = existing
        ? plugin.state.data.build().to(existing).update(params)
        : plugin.state.data
              .build()
              .to(entry.structure as StateObjectSelector)
              .insert(StateTransforms.Model.TransformStructureConformation, params, { tags: SUPERPOSITION_TAG });
    await plugin.runTask(plugin.state.data.updateTree(builder));
}

/**
 * The node whose data is what is on screen: the transform when one exists, otherwise
 * the structure itself. Camera framing must use this, not the root.
 */
export function displayedStructureRef(plugin: PluginContext, entry: StructureEntry): string {
    return transformNode(plugin, entry)?.transform.ref ?? entry.structure.ref;
}

// ---------------------------------------------------------------------------
// Chain traces and labels
// ---------------------------------------------------------------------------

function chainTrace(structure: Structure, chain: string): ChainTrace | null {
    const location = StructureElement.Location.create(structure);
    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit) || unit.polymerElements.length === 0) continue;
        location.unit = unit;
        location.element = unit.elements[0]!;
        if (StructureProperties.chain.auth_asym_id(location) !== chain) continue;

        // polymerElements is a sorted subset of unit.elements; one merge pass turns
        // element indices into the unit indices a Loci expects.
        const { elements, polymerElements } = unit;
        const indices = new Array<StructureElement.UnitIndex>(polymerElements.length);
        for (let i = 0, j = 0; i < polymerElements.length; i++) {
            while (elements[j] !== polymerElements[i]) j++;
            indices[i] = j as StructureElement.UnitIndex;
        }
        return { unit, element: { unit, indices: SortedArray.ofSortedArray(indices) } };
    }
    return null;
}

function residueCode(location: StructureElement.Location): string {
    return getProteinOneLetterCode(StructureProperties.atom.label_comp_id(location));
}

function residueLabel(location: StructureElement.Location): string {
    const insCode = StructureProperties.residue.pdbx_PDB_ins_code(location);
    return `${residueCode(location)}${StructureProperties.residue.auth_seq_id(location)}${insCode}`;
}

// ---------------------------------------------------------------------------
// Alignment methods
// ---------------------------------------------------------------------------

function alignBySequence(ref: ChainTrace, mob: ChainTrace): Alignment {
    const { a, b } = AlignSequences.compute({ a: ref.element, b: mob.element }, { substMatrix: 'blosum62' });
    // Both index sets are sorted and the alignment is monotonic, so position i in one
    // pairs with position i in the other.
    const n = Math.min(OrderedSet.size(a.indices), OrderedSet.size(b.indices));
    const refEls: ElementIndex[] = new Array(n);
    const mobEls: ElementIndex[] = new Array(n);
    for (let i = 0; i < n; i++) {
        refEls[i] = ref.unit.elements[OrderedSet.getAt(a.indices, i)]!;
        mobEls[i] = mob.unit.elements[OrderedSet.getAt(b.indices, i)]!;
    }
    return { ref: refEls, mob: mobEls };
}

function tracePositions(trace: ChainTrace): { positions: MinimizeRmsd.Positions; elements: ElementIndex[]; sequence: string } {
    const { unit } = trace;
    const n = OrderedSet.size(trace.element.indices);
    const positions = MinimizeRmsd.Positions.empty(n);
    const elements: ElementIndex[] = new Array(n);
    const location = StructureElement.Location.create(undefined, unit);
    let sequence = '';
    for (let i = 0; i < n; i++) {
        const e = unit.elements[OrderedSet.getAt(trace.element.indices, i)]!;
        elements[i] = e;
        positions.x[i] = unit.conformation.x(e);
        positions.y[i] = unit.conformation.y(e);
        positions.z[i] = unit.conformation.z(e);
        location.element = e;
        sequence += residueCode(location);
    }
    return { positions, elements, sequence };
}

function alignByStructure(ref: ChainTrace, mob: ChainTrace): Alignment {
    const a = tracePositions(ref);
    const b = tracePositions(mob);
    const result = TMAlign.compute({ a: a.positions, b: b.positions, seqA: a.sequence, seqB: b.sequence });
    const n = result.alignmentA.length;
    const refEls: ElementIndex[] = new Array(n);
    const mobEls: ElementIndex[] = new Array(n);
    for (let i = 0; i < n; i++) {
        refEls[i] = a.elements[result.alignmentA[i]!]!;
        mobEls[i] = b.elements[result.alignmentB[i]!]!;
    }
    return { ref: refEls, mob: mobEls, transform: result.bTransform, tmScore: result.tmScoreA };
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

interface PairCoordinates {
    ref: MinimizeRmsd.Positions & { x: Float64Array; y: Float64Array; z: Float64Array };
    mob: MinimizeRmsd.Positions & { x: Float64Array; y: Float64Array; z: Float64Array };
}

function pairCoordinates(ref: ChainTrace, mob: ChainTrace, alignment: Alignment): PairCoordinates {
    const n = alignment.ref.length;
    const r = MinimizeRmsd.Positions.empty(n);
    const m = MinimizeRmsd.Positions.empty(n);
    for (let i = 0; i < n; i++) {
        const er = alignment.ref[i]!;
        const em = alignment.mob[i]!;
        r.x[i] = ref.unit.conformation.x(er);
        r.y[i] = ref.unit.conformation.y(er);
        r.z[i] = ref.unit.conformation.z(er);
        m.x[i] = mob.unit.conformation.x(em);
        m.y[i] = mob.unit.conformation.y(em);
        m.z[i] = mob.unit.conformation.z(em);
    }
    return { ref: r, mob: m };
}

function pairDistances(coords: PairCoordinates, transform: Mat4): Float64Array {
    const n = coords.ref.x.length;
    const out = new Float64Array(n);
    const p = Vec3();
    for (let i = 0; i < n; i++) {
        Vec3.set(p, coords.mob.x[i]!, coords.mob.y[i]!, coords.mob.z[i]!);
        Vec3.transformMat4(p, p, transform);
        const dx = p[0]! - coords.ref.x[i]!;
        const dy = p[1]! - coords.ref.y[i]!;
        const dz = p[2]! - coords.ref.z[i]!;
        out[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return out;
}

function rmsdOf(distances: Float64Array, use?: Uint8Array): number {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < distances.length; i++) {
        if (use && !use[i]) continue;
        sum += distances[i]! * distances[i]!;
        count++;
    }
    return count ? Math.sqrt(sum / count) : 0;
}

/**
 * ChimeraX matchmaker's iteration: fit, then drop the farthest pairs — the lower of
 * 10% of the pairs still in the fit or half of those beyond the cutoff — and refit,
 * until no pair in the fit is farther than the cutoff.
 */
function fitWithPruning(coords: PairCoordinates): { transform: Mat4; used: Uint8Array } {
    const n = coords.ref.x.length;
    const used = new Uint8Array(n).fill(1);
    const subRef = MinimizeRmsd.Positions.empty(n);
    const subMob = MinimizeRmsd.Positions.empty(n);
    let active = n;
    let transform = Mat4.identity();

    for (;;) {
        let k = 0;
        for (let i = 0; i < n; i++) {
            if (!used[i]) continue;
            subRef.x[k] = coords.ref.x[i]!; subRef.y[k] = coords.ref.y[i]!; subRef.z[k] = coords.ref.z[i]!;
            subMob.x[k] = coords.mob.x[i]!; subMob.y[k] = coords.mob.y[i]!; subMob.z[k] = coords.mob.z[i]!;
            k++;
        }
        transform = Mat4.copy(Mat4(), MinimizeRmsd.compute({ a: subRef, b: subMob, length: active }).bTransform);

        const distances = pairDistances(coords, transform);
        const far: number[] = [];
        for (let i = 0; i < n; i++) if (used[i] && distances[i]! > PRUNE_CUTOFF) far.push(i);
        if (far.length === 0) break;

        const drop = Math.max(1, Math.min(Math.floor(active * 0.1), Math.floor(far.length * 0.5)));
        if (active - drop < MIN_PAIRS) break;
        far.sort((a, b) => distances[b]! - distances[a]!);
        for (let i = 0; i < drop; i++) used[far[i]!] = 0;
        active -= drop;
    }
    return { transform, used };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function superposeOne(
    viewer: Viewer,
    reference: ChainRef,
    mobile: ChainRef,
    method: SuperposeMethod,
): Promise<Result<SuperposeReport>> {
    const plugin = viewer.plugin;
    const refEntry = viewer.entry(reference.structureId);
    const mobEntry = viewer.entry(mobile.structureId);
    if (!refEntry || !mobEntry) return err('Estrutura não encontrada.');
    if (reference.structureId === mobile.structureId) {
        return err('Referência e cadeia móvel precisam estar em estruturas diferentes.');
    }

    const refRoot = rootStructure(refEntry);
    const mobRoot = rootStructure(mobEntry);
    if (!refRoot || !mobRoot) return err('Estrutura ainda não está pronta.');

    const refTrace = chainTrace(refRoot, reference.chain);
    const mobTrace = chainTrace(mobRoot, mobile.chain);
    if (!refTrace) return err(`Cadeia ${reference.chain} não tem polímero em ${refEntry.info.name}.`);
    if (!mobTrace) return err(`Cadeia ${mobile.chain} não tem polímero em ${mobEntry.info.name}.`);

    const alignment = method === 'sequence' ? alignBySequence(refTrace, mobTrace) : alignByStructure(refTrace, mobTrace);
    if (alignment.ref.length < MIN_PAIRS) {
        return err(
            method === 'sequence'
                ? `Só ${alignment.ref.length} resíduos alinhados por sequência. Tente o alinhamento estrutural.`
                : 'O alinhamento estrutural não encontrou resíduos equivalentes.',
        );
    }

    const coords = pairCoordinates(refTrace, mobTrace, alignment);
    let fit: Mat4;
    let used: Uint8Array;
    if (alignment.transform) {
        fit = alignment.transform;
        used = new Uint8Array(alignment.ref.length).fill(1);
    } else {
        ({ transform: fit, used } = fitWithPruning(coords));
    }
    const distances = pairDistances(coords, fit);

    const refLoc = StructureElement.Location.create(refRoot, refTrace.unit);
    const mobLoc = StructureElement.Location.create(mobRoot, mobTrace.unit);
    const pairs: ResiduePair[] = new Array(alignment.ref.length);
    let identical = 0;
    let fitPairs = 0;
    for (let i = 0; i < alignment.ref.length; i++) {
        refLoc.element = alignment.ref[i]!;
        mobLoc.element = alignment.mob[i]!;
        if (residueCode(refLoc) === residueCode(mobLoc)) identical++;
        if (used[i]) fitPairs++;
        pairs[i] = {
            reference: residueLabel(refLoc),
            mobile: residueLabel(mobLoc),
            distance: distances[i]!,
            usedInFit: used[i] === 1,
        };
    }

    await applyMatrix(plugin, mobEntry, Mat4.mul(Mat4(), currentMatrix(plugin, refEntry), fit));

    return ok({
        method,
        reference,
        mobile,
        rmsd: rmsdOf(distances, used),
        rmsdAllPairs: rmsdOf(distances),
        fitPairs,
        alignedPairs: alignment.ref.length,
        sequenceIdentity: identical / alignment.ref.length,
        tmScore: alignment.tmScore ?? null,
        pairs,
    });
}

/**
 * Superposes each mobile chain onto the reference chain, moving the whole structure
 * that contains it. Fails as a whole only when the plugin is missing; per-chain
 * problems come back as individual errors so one bad pick does not hide the others.
 */
export async function superposeChains(
    viewer: Viewer,
    reference: ChainRef,
    mobiles: ChainRef[],
    method: SuperposeMethod,
): Promise<Result<Result<SuperposeReport>[]>> {
    const reports: Result<SuperposeReport>[] = [];
    for (const mobile of mobiles) {
        try {
            reports.push(await superposeOne(viewer, reference, mobile, method));
        } catch (e) {
            reports.push(err(`Falha ao superpor ${mobile.chain}: ${errorMessage(e)}`));
        }
    }
    viewer.notify();
    return ok(reports);
}

/**
 * Deviation of a chain pair **as currently displayed**, without fitting anything.
 *
 * This is the measurement a designer wants after superposing: align by chain A, then
 * ask how far chain B ended up — the number that says whether the binder sits the
 * same way, rather than how well B could be fitted on its own.
 */
export async function measureChains(
    viewer: Viewer,
    reference: ChainRef,
    mobiles: ChainRef[],
    method: SuperposeMethod,
): Promise<Result<ChainDeviation[]>> {
    const plugin = viewer.plugin;
    const refEntry = viewer.entry(reference.structureId);
    const refRoot = refEntry && rootStructure(refEntry);
    if (!refEntry || !refRoot) return err('Estrutura de referência não encontrada.');
    const refTrace = chainTrace(refRoot, reference.chain);
    if (!refTrace) return err(`Cadeia ${reference.chain} não tem polímero em ${refEntry.info.name}.`);

    const out: ChainDeviation[] = [];
    for (const mobile of mobiles) {
        const mobEntry = viewer.entry(mobile.structureId);
        const mobRoot = mobEntry && rootStructure(mobEntry);
        if (!mobEntry || !mobRoot) continue;
        const mobTrace = chainTrace(mobRoot, mobile.chain);
        if (!mobTrace) {
            out.push({ reference, mobile, rmsd: null, alignedPairs: 0, identity: 0, maxDeviation: null, note: `sem cadeia ${mobile.chain}` });
            continue;
        }
        try {
            const alignment = method === 'sequence' ? alignBySequence(refTrace, mobTrace) : alignByStructure(refTrace, mobTrace);
            if (alignment.ref.length < MIN_PAIRS) {
                out.push({ reference, mobile, rmsd: null, alignedPairs: alignment.ref.length, identity: 0, maxDeviation: null, note: 'poucos resíduos equivalentes' });
                continue;
            }
            const coords = pairCoordinates(refTrace, mobTrace, alignment);
            // Both structures may carry a superposition matrix; the relative one maps the
            // mobile chain into the reference's frame, which is what is on screen.
            const relative = Mat4.mul(Mat4(), Mat4.invert(Mat4(), currentMatrix(plugin, refEntry)), currentMatrix(plugin, mobEntry));
            const distances = pairDistances(coords, relative);
            const refLoc = StructureElement.Location.create(refRoot, refTrace.unit);
            const mobLoc = StructureElement.Location.create(mobRoot, mobTrace.unit);
            let identical = 0;
            for (let i = 0; i < alignment.ref.length; i++) {
                refLoc.element = alignment.ref[i]!;
                mobLoc.element = alignment.mob[i]!;
                if (residueCode(refLoc) === residueCode(mobLoc)) identical++;
            }
            out.push({
                reference,
                mobile,
                rmsd: rmsdOf(distances),
                alignedPairs: alignment.ref.length,
                identity: identical / alignment.ref.length,
                maxDeviation: Math.max(...distances),
                note: '',
            });
        } catch (e) {
            out.push({ reference, mobile, rmsd: null, alignedPairs: 0, identity: 0, maxDeviation: null, note: errorMessage(e) });
        }
    }
    return ok(out);
}

/** Returns a structure to its file coordinates. The transform node stays, set to identity. */
export async function resetSuperposition(viewer: Viewer, id: StructureId): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    if (!transformNode(plugin, entry)) return ok(true);

    try {
        await applyMatrix(plugin, entry, Mat4.identity());
        return ok(true);
    } catch (e) {
        return err(`Falha ao restaurar as coordenadas: ${errorMessage(e)}`);
    }
}

/**
 * Applies an external rigid fit (TM-align's x_ref = t + U · x_mobile, computed on the
 * file coordinates of both) so the mobile lands on the reference as currently drawn.
 */
export async function applyRigidTransform(
    viewer: Viewer,
    mobileId: StructureId,
    referenceId: StructureId,
    rotation: number[][],
    translation: number[],
): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const mob = viewer.entry(mobileId);
    const ref = viewer.entry(referenceId);
    if (!mob || !ref) return err('Estrutura não encontrada.');
    if (rotation.length !== 3 || translation.length !== 3) return err('Matriz de superposição inválida.');
    try {
        const fit = Mat4.identity();
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) Mat4.setValue(fit, r, c, rotation[r]![c]!);
            Mat4.setValue(fit, r, 3, translation[r]!);
        }
        await applyMatrix(plugin, mob, Mat4.mul(Mat4(), currentMatrix(plugin, ref), fit));
        viewer.notify();
        return ok(true);
    } catch (e) {
        return err(`Falha ao aplicar a superposição: ${errorMessage(e)}`);
    }
}
