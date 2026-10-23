/**
 * Interface between two sides of a complex (binder × target).
 *
 * Interactions come from Mol*'s computed Interactions property (H-bonds, salt
 * bridges, π-stacking, cation–π, halogen, hydrophobic, metal); this module keeps only
 * those crossing the two sides — the inter-chain contacts the designer cares about —
 * and draws them as one overlay mesh of dashed cylinders, colour and dash count per kind.
 * Interfacial residues follow the contact criterion of README_contacts.md (≥ 2 atoms
 * within 4 Å), with the cutoff and atom minimum adjustable.
 *
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { Structure, StructureElement, StructureProperties as P, Unit } from 'molstar/lib/mol-model/structure';
import { InteractionsProvider } from 'molstar/lib/mol-model-props/computed/interactions';
import { Features } from 'molstar/lib/mol-model-props/computed/interactions/features';
import { InteractionFlag, InteractionType } from 'molstar/lib/mol-model-props/computed/interactions/common';
import { Task } from 'molstar/lib/mol-task';
import { SecondaryStructureProvider } from 'molstar/lib/mol-model-props/computed/secondary-structure';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra/3d/vec3';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import type { Expression } from 'molstar/lib/mol-script/language/expression';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { StructureSelectionQueries as Q } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { UUID } from 'molstar/lib/mol-util/uuid';
import { INTERACTION_STYLES, hexToInt } from '@/data/palettes';
import { displayedStructureRef } from './compare';
import { chainCarbonTheme } from './coloring';
import { replayPaint } from './style';
import { getInteriorParam } from 'molstar/lib/mol-geo/geometry/interior';
import { clearOverlay, setOverlay, type OverlayLine } from './overlay';
import { hydrogenParams, type Viewer } from './viewer';
import {
    ok,
    err,
    errorMessage,
    type InteractionKind,
    type InteractionRecord,
    type InterfaceReport,
    residueKey,
    type InterfaceResidue,
    type InterfaceSide,
    type ResidueRef,
    type Result,
    type StructureId,
} from './types';

const KIND_OF: Partial<Record<InteractionType, InteractionKind>> = {
    [InteractionType.HydrogenBond]: 'hydrogen-bond',
    [InteractionType.WeakHydrogenBond]: 'weak-hydrogen-bond',
    [InteractionType.Ionic]: 'salt-bridge',
    [InteractionType.PiStacking]: 'pi-stacking',
    [InteractionType.CationPi]: 'cation-pi',
    [InteractionType.HalogenBond]: 'halogen-bond',
    [InteractionType.Hydrophobic]: 'hydrophobic',
    [InteractionType.MetalCoordination]: 'metal',
};

/** The structure object currently drawn (after any superposition). */
function displayedStructure(viewer: Viewer, id: StructureId): Structure | undefined {
    const entry = viewer.entry(id);
    if (!entry) return undefined;
    const ref = displayedStructureRef(viewer.plugin, entry);
    return viewer.plugin.state.data.cells.get(ref)?.obj?.data as Structure | undefined;
}

function chainOfUnit(structure: Structure, unit: Unit): string {
    const l = StructureElement.Location.create(structure, unit, unit.elements[0]!);
    return P.chain.auth_asym_id(l);
}

function residueRef(id: StructureId, structure: Structure, unit: Unit, unitIndices: ArrayLike<number>): ResidueRef {
    const l = StructureElement.Location.create(structure, unit, unit.elements[unitIndices[0]!]!);
    const atoms: string[] = [];
    for (let i = 0; i < unitIndices.length; i++) {
        l.element = unit.elements[unitIndices[i]!]!;
        atoms.push(P.atom.label_atom_id(l));
    }
    l.element = unit.elements[unitIndices[0]!]!;
    return {
        structureId: id,
        chain: P.chain.auth_asym_id(l),
        seq: P.residue.auth_seq_id(l),
        insCode: P.residue.pdbx_PDB_ins_code(l) || '',
        name: P.atom.label_comp_id(l),
        atoms,
    };
}

async function ensureInteractions(plugin: PluginContext, structure: Structure) {
    await plugin.runTask(
        Task.create('Interações', async (runtime) => {
            await InteractionsProvider.attach({ runtime, assetManager: plugin.managers.asset, errorContext: plugin.errorContext }, structure, undefined, true);
        }),
    );
    return InteractionsProvider.get(structure).value;
}

const tuple = (v: Vec3): [number, number, number] => [v[0]!, v[1]!, v[2]!];

function featureMembers(features: Features, index: number): number[] {
    const out: number[] = [];
    for (let k = features.offsets[index]!; k < features.offsets[index + 1]!; k++) out.push(features.members[k]!);
    return out;
}

export interface ContactOptions {
    /** Atom–atom distance, Å. */
    cutoff: number;
    /** A residue is interfacial when at least this many of its atoms are in contact (≥2 discards single-atom grazes). */
    minAtoms: number;
    /** Count hydrogens present in the file (README_contacts.md uses all atoms). */
    includeHydrogens: boolean;
}

/** The criterion of ~/projetos/rocio/2_giovanna/README_contacts.md: ≥ 2 atoms within 4 Å, all atoms. */
export const DEFAULT_CONTACTS: ContactOptions = { cutoff: 4, minAtoms: 2, includeHydrogens: true };

/** Atom contacts across the two sides: atom pairs and the interfacial residues of each side. */
function residueContacts(id: StructureId, structure: Structure, chainsA: Set<string>, chainsB: Set<string>, options: ContactOptions) {
    const lookup = structure.lookup3d;
    const p = Vec3();
    let pairs = 0;

    const sideOfUnit = new Map<number, 'A' | 'B' | null>();
    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit)) continue;
        const c = chainOfUnit(structure, unit);
        sideOfUnit.set(unit.id, chainsA.has(c) ? 'A' : chainsB.has(c) ? 'B' : null);
    }
    const counts = (unit: Unit.Atomic, e: number) => options.includeHydrogens || unit.model.atomicHierarchy.atoms.type_symbol.value(e as never) !== 'H';
    const residueOf = (unit: Unit.Atomic, e: number) => unit.model.atomicHierarchy.residueAtomSegments.index[e]!;

    // residue key → { unit, first unit index, atoms in contact }
    type Acc = { unit: Unit.Atomic; first: number; atoms: Set<number> };
    const accA = new Map<string, Acc>();
    const accB = new Map<string, Acc>();
    const touch = (acc: Map<string, Acc>, unit: Unit.Atomic, unitIndex: number) => {
        const e = unit.elements[unitIndex]!;
        const key = `${unit.id}:${residueOf(unit, e)}`;
        let a = acc.get(key);
        if (!a) acc.set(key, (a = { unit, first: unitIndex, atoms: new Set() }));
        a.atoms.add(unitIndex);
    };

    for (const unit of structure.units) {
        if (!Unit.isAtomic(unit) || sideOfUnit.get(unit.id) !== 'A') continue;
        const { elements } = unit;
        for (let i = 0; i < elements.length; i++) {
            const e = elements[i]!;
            if (!counts(unit, e)) continue;
            unit.conformation.position(e, p);
            const hits = lookup.find(p[0]!, p[1]!, p[2]!, options.cutoff);
            let touched = false;
            for (let h = 0; h < hits.count; h++) {
                const other = hits.units[h]!;
                if (!Unit.isAtomic(other) || sideOfUnit.get(other.id) !== 'B') continue;
                const oi = hits.indices[h]!;
                if (!counts(other, other.elements[oi]!)) continue;
                pairs++;
                touched = true;
                touch(accB, other, oi);
            }
            if (touched) touch(accA, unit, i);
        }
    }

    const finish = (acc: Map<string, Acc>) =>
        [...acc.values()]
            .filter((a) => a.atoms.size >= options.minAtoms)
            .map((a) => ({ ...residueRef(id, structure, a.unit, [a.first]), atoms: [] as string[], contactAtoms: a.atoms.size }))
            .sort((x, y) => x.chain.localeCompare(y.chain) || x.seq - y.seq);
    return { pairs, residuesA: finish(accA), residuesB: finish(accB) };
}

/**
 * Interactions and contacts between side A and side B of one structure.
 * Contacts follow `contacts` (default: the README_contacts.md criterion).
 */
export async function analyzeInterface(
    viewer: Viewer,
    sideA: InterfaceSide,
    sideB: InterfaceSide,
    contacts: ContactOptions = DEFAULT_CONTACTS,
): Promise<Result<InterfaceReport>> {
    if (sideA.structureId !== sideB.structureId) return err('Os dois lados precisam estar na mesma estrutura (o complexo).');
    if (sideA.chains.length === 0 || sideB.chains.length === 0) return err('Escolha ao menos uma cadeia de cada lado.');
    const id = sideA.structureId;
    const structure = displayedStructure(viewer, id);
    if (!structure) return err('Estrutura não encontrada.');

    try {
        const interactions = await ensureInteractions(viewer.plugin, structure);
        if (!interactions) return err('O Mol* não conseguiu calcular as interações desta estrutura.');

        const chainsA = new Set(sideA.chains);
        const chainsB = new Set(sideB.chains);
        const records: InteractionRecord[] = [];
        const seen = new Set<string>();
        const pa = Vec3();
        const pb = Vec3();

        for (const edge of interactions.contacts.edges) {
            if (edge.props.flag === InteractionFlag.Filtered) continue;
            const kind = KIND_OF[edge.props.type as InteractionType];
            if (!kind) continue;
            const unitA = structure.unitMap.get(edge.unitA);
            const unitB = structure.unitMap.get(edge.unitB);
            if (!unitA || !unitB) continue;
            const cA = chainOfUnit(structure, unitA);
            const cB = chainOfUnit(structure, unitB);
            let flip: boolean;
            if (chainsA.has(cA) && chainsB.has(cB)) flip = false;
            else if (chainsB.has(cA) && chainsA.has(cB)) flip = true;
            else continue;

            // The graph stores both directions of every edge.
            const key = edge.unitA < edge.unitB || (edge.unitA === edge.unitB && edge.indexA < edge.indexB)
                ? `${edge.unitA}:${edge.indexA}|${edge.unitB}:${edge.indexB}|${edge.props.type}`
                : `${edge.unitB}:${edge.indexB}|${edge.unitA}:${edge.indexA}|${edge.props.type}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const fA = interactions.unitsFeatures.get(edge.unitA);
            const fB = interactions.unitsFeatures.get(edge.unitB);
            Features.setPosition(pa, unitA, edge.indexA, fA);
            Features.setPosition(pb, unitB, edge.indexB, fB);
            const resA = residueRef(id, structure, unitA, featureMembers(fA, edge.indexA));
            const resB = residueRef(id, structure, unitB, featureMembers(fB, edge.indexB));
            const record: InteractionRecord = {
                kind,
                a: flip ? resB : resA,
                b: flip ? resA : resB,
                distance: Vec3.distance(pa, pb),
                posA: flip ? tuple(pb) : tuple(pa),
                posB: flip ? tuple(pa) : tuple(pb),
            };
            records.push(record);
        }

        records.sort((x, y) => x.a.chain.localeCompare(y.a.chain) || x.a.seq - y.a.seq || x.distance - y.distance);
        const found = residueContacts(id, structure, chainsA, chainsB, contacts);
        return ok({
            sideA,
            sideB,
            contacts,
            interactions: records,
            residuesA: found.residuesA,
            residuesB: found.residuesB,
            atomContacts: found.pairs,
        });
    } catch (e) {
        return err(`Falha na análise de interface: ${errorMessage(e)}`);
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export function residueLabel(r: ResidueRef): string {
    return `${r.chain}:${r.name}${r.seq}${r.insCode}`;
}

/** Draws the interactions of a report, filtered by kind. */
export async function showInteractions(viewer: Viewer, report: InterfaceReport, kinds: ReadonlySet<InteractionKind>): Promise<Result<true>> {
    try {
        const lines: OverlayLine[] = report.interactions
            .filter((r) => kinds.has(r.kind))
            .map((r) => {
                const style = INTERACTION_STYLES[r.kind];
                return {
                    a: r.posA,
                    b: r.posB,
                    color: hexToInt(style.color),
                    radius: style.radius,
                    dashes: style.dashes,
                    label: `${residueLabel(r.a)} — ${residueLabel(r.b)} · ${style.label} · ${r.distance.toFixed(2)} Å`,
                    owners: [r.a.structureId, r.b.structureId],
                };
            });
        await setOverlay(viewer, 'interactions', { lines }, 'Interações');
        return ok(true);
    } catch (e) {
        return err(`Falha ao desenhar as interações: ${errorMessage(e)}`);
    }
}

export async function hideInteractions(viewer: Viewer): Promise<void> {
    await clearOverlay(viewer, 'interactions');
    await hideInteractionAtoms(viewer);
}

// ---------------------------------------------------------------------------
// The atoms that make the interactions
// ---------------------------------------------------------------------------

const IX_ATOMS_TAG = 'pp-interaction-atoms';

/** Interior colour off, as in the atom layers (style.ts): no dark back faces on sticks. */
const SEAMLESS = { interior: { ...getInteriorParam().defaultValue, colorStrength: 0, substanceStrength: 0 } };

/**
 * Side chains of the residues taking part in the interactions currently drawn.
 *
 * A dashed line between two residues only reads if the chemistry behind it is on
 * screen, so showing an interaction shows its atoms; unticking a kind takes away the
 * atoms that only that kind was holding up. These live in their own component,
 * tagged, so they never interfere with the user's own atom layers (style.ts).
 */
export async function showInteractionAtoms(viewer: Viewer, report: InterfaceReport, kinds: ReadonlySet<InteractionKind>): Promise<Result<true>> {
    const plugin = viewer.plugin;
    try {
        await hideInteractionAtoms(viewer);
        const residues = new Map<string, Set<number>>();
        for (const r of report.interactions) {
            if (!kinds.has(r.kind)) continue;
            for (const side of [r.a, r.b]) {
                const set = residues.get(side.chain) ?? new Set<number>();
                set.add(side.seq);
                residues.set(side.chain, set);
            }
        }
        if (residues.size === 0) return ok(true);

        const entry = viewer.entry(report.sideA.structureId);
        const structureRef = entry && plugin.managers.structure.hierarchy.current.structures.find((s) => s.cell.transform.ref === entry.structure.ref);
        if (!entry || !structureRef) return err('Estrutura não encontrada.');

        const perChain: Expression[] = [...residues.entries()].map(([chain, seqs]) =>
            MS.struct.generator.atomGroups({
                'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chain]),
                'residue-test': MS.core.set.has([MS.set(...[...seqs]), MS.ammp('auth_seq_id')]),
            }),
        );
        // Side chain plus the Cα it hangs from: the same geometry the atoms layer uses.
        const expression = MS.struct.modifier.intersectBy({
            0: MS.struct.combinator.merge(perChain),
            by: MS.struct.combinator.merge([Q.sidechainWithTrace.expression, Q.ligand.expression]),
        });

        const component = await plugin.builders.structure.tryCreateComponentFromSelection(
            structureRef.cell,
            StructureSelectionQuery('pp interaction atoms', expression),
            UUID.create22(),
            { label: 'Átomos das interações', tags: [IX_ATOMS_TAG] },
        );
        if (!component) return ok(true);
        const data = component.cell?.obj?.data as Structure | undefined;
        // Carbons in the chain's own colour (what the ribbon shows), heteroatoms by
        // element. Mol*'s chain-id palette here gave side chains colours that matched
        // nothing else on screen.
        const theme = chainCarbonTheme(viewer, entry);
        const params = createStructureRepresentationParams(plugin, data, {
            type: 'ball-and-stick',
            typeParams: { sizeFactor: 0.22, sizeAspectRatio: 1, ...hydrogenParams(viewer.hydrogens), ...SEAMLESS },
            color: theme.color,
            colorParams: theme.colorParams,
        } as never);
        await plugin.build().to(component).apply(StateTransforms.Representation.StructureRepresentation3D, params, { tags: [IX_ATOMS_TAG] }).commit();
        // User paint on the chain (a recoloured residue) shows on its side chain too.
        await replayPaint(plugin, entry, component.ref);
        return ok(true);
    } catch (e) {
        return err(`Falha ao mostrar os átomos das interações: ${errorMessage(e)}`);
    }
}

export async function hideInteractionAtoms(viewer: Viewer): Promise<void> {
    const plugin = viewer.plugin;
    const builder = plugin.build();
    let found = false;
    plugin.state.data.cells.forEach((cell) => {
        if (cell.transform.tags?.includes(IX_ATOMS_TAG) && cell.transform.transformer.id === StateTransforms.Model.StructureComponent.id) {
            builder.delete(cell.transform.ref);
            found = true;
        }
    });
    if (found) await builder.commit();
}

// ---------------------------------------------------------------------------
// Ratios
// ---------------------------------------------------------------------------

export interface ChainContacts {
    chain: string;
    /** Residues of that chain in contact. */
    residues: number;
    /** Sum of their contact atoms. */
    atoms: number;
    /** Interactions (of any kind) touching that chain. */
    interactions: number;
}

/**
 * Contacts broken down per chain of the target side, which is what answers
 * "estou maximizando o peptídeo e minimizando o MHC?".
 */
export function contactsPerChain(report: InterfaceReport, side: 'A' | 'B'): ChainContacts[] {
    const residues = side === 'A' ? report.residuesA : report.residuesB;
    const out = new Map<string, ChainContacts>();
    for (const r of residues) {
        const c = out.get(r.chain) ?? { chain: r.chain, residues: 0, atoms: 0, interactions: 0 };
        c.residues++;
        c.atoms += r.contactAtoms;
        out.set(r.chain, c);
    }
    for (const ix of report.interactions) {
        for (const ref of [ix.a, ix.b]) {
            const c = out.get(ref.chain);
            if (c) c.interactions++;
        }
    }
    return [...out.values()].sort((a, b) => b.atoms - a.atoms);
}

// ---------------------------------------------------------------------------
// Secondary structure of the interface
// ---------------------------------------------------------------------------

export type SsClass = 'helix' | 'strand' | 'loop';

export interface InterfaceSsResidue {
    chain: string;
    seq: number;
    insCode: string;
    name: string;
    ss: SsClass;
    contactAtoms: number;
}

export interface InterfaceSsReport {
    structureId: StructureId;
    /** pydssp when that job ran on the structure, otherwise Mol*'s DSSP. */
    source: 'pydssp' | 'dssp';
    contacts: ContactOptions;
    sideA: { chains: string[]; residues: InterfaceSsResidue[] };
    sideB: { chains: string[]; residues: InterfaceSsResidue[] };
}

const SS_HELIX = 0x2;
const SS_BETA = 0x4;

const fromPydssp = (code: string): SsClass => (code === 'H' || code === 'G' || code === 'I' ? 'helix' : code === 'E' || code === 'B' ? 'strand' : 'loop');

/**
 * Which secondary structure the interface is made of: the interfacial residues of
 * each side (same contact criterion as the interface analysis) with their helix /
 * strand / loop assignment. Answers "does this binder engage with a helix or with
 * loops?", and lets designs be compared on it.
 */
export async function interfaceSecondaryStructure(
    viewer: Viewer,
    id: StructureId,
    chainsA: string[],
    chainsB: string[],
    contacts: ContactOptions = DEFAULT_CONTACTS,
): Promise<Result<InterfaceSsReport>> {
    const entry = viewer.entry(id);
    const structure = displayedStructure(viewer, id);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        const { residuesA, residuesB } = residueContacts(id, structure, new Set(chainsA), new Set(chainsB), contacts);
        const pydssp = entry.datasets.get('pydssp');
        const ssOf = new Map<string, SsClass>();
        if (pydssp) {
            for (const [k, v] of Object.entries(pydssp.values)) ssOf.set(k, fromPydssp(String(v)));
        } else {
            const plugin = viewer.plugin;
            await plugin.runTask(
                Task.create('Estrutura secundária', async (runtime) => {
                    await SecondaryStructureProvider.attach({ runtime, assetManager: plugin.managers.asset, errorContext: plugin.errorContext }, structure, undefined, true);
                }),
            );
            const value = SecondaryStructureProvider.get(structure).value;
            const l = StructureElement.Location.create(structure);
            for (const unit of structure.units) {
                if (!Unit.isAtomic(unit)) continue;
                const ss = value?.get(unit.invariantId);
                if (!ss) continue;
                const segments = unit.model.atomicHierarchy.residueAtomSegments;
                l.unit = unit;
                let last = -1;
                for (let i = 0; i < unit.elements.length; i++) {
                    const e = unit.elements[i]!;
                    const r = segments.index[e]!;
                    if (r === last) continue;
                    last = r;
                    l.element = e;
                    const flags = ss.type[ss.getIndex(r)] as number;
                    // Flag values from mol-model/structure/model/types (a const enum, not importable here).
                    const cls: SsClass = flags & SS_HELIX ? 'helix' : flags & SS_BETA ? 'strand' : 'loop';
                    ssOf.set(`${P.chain.auth_asym_id(l)}:${residueKey(P.residue.auth_seq_id(l), P.residue.pdbx_PDB_ins_code(l) || '')}`, cls);
                }
            }
        }
        const tag = (list: InterfaceResidue[]): InterfaceSsResidue[] =>
            list.map((r) => ({ chain: r.chain, seq: r.seq, insCode: r.insCode, name: r.name, contactAtoms: r.contactAtoms, ss: ssOf.get(`${r.chain}:${residueKey(r.seq, r.insCode)}`) ?? 'loop' }));
        return ok({
            structureId: id,
            source: pydssp ? 'pydssp' : 'dssp',
            contacts,
            sideA: { chains: chainsA, residues: tag(residuesA) },
            sideB: { chains: chainsB, residues: tag(residuesB) },
        });
    } catch (e) {
        return err(`Falha na estrutura secundária da interface: ${errorMessage(e)}`);
    }
}
