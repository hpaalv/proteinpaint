/**
 * Selection, on Mol*'s own selection manager — highlighting, the selection outline
 * and picking granularity are native.
 *
 * Pointer modes:
 *   select  — click toggles the residue (atom/chain by pick level), shift-click extends along the chain
 *   explore — click focuses the residue and shows its 5 Å neighbourhood with interactions
 * Everything else is the equivalent of ChimeraX `select …`, plus the typed spec.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { Structure, StructureElement, StructureProperties as P, StructureSelection } from 'molstar/lib/mol-model/structure';
import type { Loci } from 'molstar/lib/mol-model/loci';
import { OrderedSet } from 'molstar/lib/mol-data/int';
import { Task } from 'molstar/lib/mol-task';
import { SecondaryStructureProvider } from 'molstar/lib/mol-model-props/computed/secondary-structure';
import { StructureSelectionQueries as Q, StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import type { Expression } from 'molstar/lib/mol-script/language/expression';
import { structureElementStatsLabel } from 'molstar/lib/mol-theme/label';
import { StructureFocusRepresentation } from 'molstar/lib/mol-plugin/behavior/dynamic/selection/structure-focus-representation';
import { createStructureColorThemeParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { getInteriorParam } from 'molstar/lib/mol-geo/geometry/interior';
import { Color } from 'molstar/lib/mol-util/color';
import { chainMap } from './coloring';
import { compileSpec, parseSpec } from './spec';
import { chainExpression, heteroExpression } from './style';
import { hydrogenParams, type Viewer } from './viewer';
import {
    ok,
    err,
    errorMessage,
    residueKey,
    type PickLevel,
    type ResidueClass,
    type Result,
    type SelectModifier,
    type SelectedResidues,
    type SelectionSummary,
    type StructureId,
} from './types';

const FOCUS_MS = 350;

export type PointerMode = 'select' | 'explore';

export function setPointerMode(viewer: Viewer, mode: PointerMode): void {
    viewer.plugin.selectionMode = mode === 'select';
    if (mode === 'select') viewer.plugin.managers.structure.focus.clear();
}

export function setPickLevel(viewer: Viewer, level: PickLevel): void {
    viewer.plugin.managers.interactivity.setProps({ granularity: level === 'atom' ? 'element' : level });
}

/**
 * The explore-mode focus view: Mol*'s StructureFocusRepresentation, with carbons
 * in the chain colour and heteroatoms by element, hydrogens and interior faces as in style.ts.
 *
 * The carbons follow **the app's** chain colours (`pp-chain-map`), not Mol*'s own
 * chain-id palette: with the built-in one the neighbourhood came out in colours that
 * matched nothing else on screen. Pass the structure whose colours should be used —
 * normally the one being explored.
 */
export async function styleFocusView(viewer: Viewer, id?: StructureId): Promise<void> {
    const plugin = viewer.plugin;
    const entry = id ? viewer.entry(id) : [...viewer.entries.values()][0];
    focusStyleKey.set(viewer, focusKey(viewer, entry?.info.id ?? null));
    const base = entry
        ? { name: 'pp-chain-map' as const, params: { colors: chainMap(viewer, entry), fallback: Color(0x8a8f98) } }
        : { name: 'chain-id' as const, params: {} };
    const colorTheme = createStructureColorThemeParams(plugin, undefined, 'ball-and-stick', 'pp-hetero', { base } as never);
    await plugin.state.updateBehavior(StructureFocusRepresentation, (p) => {
        p.targetParams = { ...p.targetParams, colorTheme };
        p.surroundingsParams = { ...p.surroundingsParams, colorTheme };
        const h = hydrogenParams(viewer.hydrogens) as { ignoreHydrogens: boolean; ignoreHydrogensVariant?: 'all' | 'non-polar' };
        p.ignoreHydrogens = h.ignoreHydrogens;
        if (h.ignoreHydrogensVariant) p.ignoreHydrogensVariant = h.ignoreHydrogensVariant;
        p.interior = { ...getInteriorParam().defaultValue, colorStrength: 0, substanceStrength: 0 };
    });
}

/** What the focus view was last themed for, per viewer — restyling only when it changes. */
const focusStyleKey = new WeakMap<Viewer, string>();

function focusKey(viewer: Viewer, id: StructureId | null): string {
    const entry = id ? viewer.entry(id) : undefined;
    return JSON.stringify([id, entry ? chainMap(viewer, entry) : null, viewer.hydrogens]);
}

/**
 * Keeps the explore neighbourhood in the colours of the structure being explored.
 * Theming it once at start-up was not enough: with no structure loaded yet it fell back
 * to Mol*'s own chain palette, so the side chains came out in colours that matched
 * nothing on screen until some colour setting happened to be changed.
 */
export function trackFocusColors(viewer: Viewer): () => void {
    const sub = viewer.plugin.managers.structure.focus.behaviors.current.subscribe((focus) => {
        if (!focus) return;
        const id = viewer.idOf(focus.loci.structure);
        if (id && focusStyleKey.get(viewer) !== focusKey(viewer, id)) void styleFocusView(viewer, id);
    });
    return () => sub.unsubscribe();
}

// ---------------------------------------------------------------------------
// Reading the selection
// ---------------------------------------------------------------------------

interface Root {
    id: StructureId;
    name: string;
    index: number;
    root: Structure;
}

/** Loaded structures as the selection manager sees them (the displayed, possibly transformed, object). */
function roots(viewer: Viewer): Root[] {
    const plugin = viewer.plugin;
    const out: Root[] = [];
    let index = 0;
    for (const e of viewer.entries.values()) {
        const ref = plugin.managers.structure.hierarchy.current.structures.find((s) => s.cell.transform.ref === e.structure.ref);
        const root = ref?.cell.obj?.data;
        if (root) out.push({ id: e.info.id, name: e.info.alias || e.info.name, index, root });
        index++;
    }
    return out;
}

/** The current selection, per structure. Shared with labels.ts. */
export function selectedLoci(viewer: Viewer): StructureElement.Loci[] {
    return roots(viewer).flatMap(({ root }) => {
        const loci = viewer.plugin.managers.structure.selection.getLoci(root);
        return StructureElement.Loci.is(loci) && !StructureElement.Loci.isEmpty(loci) ? [loci] : [];
    });
}

/** Counts directly: Mol*'s Stats reports a whole chain as one chain and zero residues. */
export function selectionSummary(viewer: Viewer): SelectionSummary | null {
    let residues = 0;
    let atoms = 0;
    const chains: string[] = [];
    let label = '';
    let parts = 0;

    for (const { name, root } of roots(viewer)) {
        const loci = viewer.plugin.managers.structure.selection.getLoci(root);
        if (!StructureElement.Loci.is(loci) || StructureElement.Loci.isEmpty(loci)) continue;
        parts++;
        const stats = StructureElement.Stats.ofLoci(loci);
        label = structureElementStatsLabel(stats, { hidePrefix: true, htmlStyling: false });
        if (stats.residueCount === 1) {
            const l = stats.firstResidueLoc;
            label = `${P.atom.label_comp_id(l)} ${P.residue.auth_seq_id(l)}${P.residue.pdbx_PDB_ins_code(l)} · ${P.chain.auth_asym_id(l)}`;
        }
        const seen = new Set<string>();
        const location = StructureElement.Location.create(root);
        for (const { unit, indices } of loci.elements) {
            const n = OrderedSet.size(indices);
            if (n === 0) continue;
            atoms += n;
            const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
            let last = -1;
            for (let i = 0; i < n; i++) {
                const r = residueOf[unit.elements[OrderedSet.getAt(indices, i)]!]!;
                if (r !== last) residues++;
                last = r;
            }
            location.unit = unit;
            location.element = unit.elements[OrderedSet.getAt(indices, 0)]!;
            seen.add(P.chain.auth_asym_id(location));
        }
        for (const c of seen) chains.push(`${name}:${c}`);
    }
    if (parts === 0) return null;
    if (parts > 1 || residues > 1) label = `${residues} resíduos · ${atoms} átomos`;
    return { residues, atoms, chains, label };
}

/** Selected residues per structure and chain, for the sequence track. */
export function selectedResidues(viewer: Viewer): SelectedResidues {
    const out: SelectedResidues = new Map();
    for (const { id, root } of roots(viewer)) {
        const loci = viewer.plugin.managers.structure.selection.getLoci(root);
        if (!StructureElement.Loci.is(loci) || StructureElement.Loci.isEmpty(loci)) continue;
        const perChain = new Map<string, Set<string>>();
        const location = StructureElement.Location.create(root);
        for (const { unit, indices } of loci.elements) {
            location.unit = unit;
            const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
            let last = -1;
            for (let i = 0, n = OrderedSet.size(indices); i < n; i++) {
                const e = unit.elements[OrderedSet.getAt(indices, i)]!;
                const r = residueOf[e]!;
                if (r === last) continue;
                last = r;
                location.element = e;
                const chain = P.chain.auth_asym_id(location);
                let set = perChain.get(chain);
                if (!set) perChain.set(chain, (set = new Set()));
                set.add(residueKey(P.residue.auth_seq_id(location), P.residue.pdbx_PDB_ins_code(location) || ''));
            }
        }
        out.set(id, perChain);
    }
    return out;
}

export function onSelectionChange(viewer: Viewer, callback: () => void): () => void {
    const sub = viewer.plugin.managers.structure.selection.events.changed.subscribe(callback);
    return () => sub.unsubscribe();
}

// ---------------------------------------------------------------------------
// Building selections
// ---------------------------------------------------------------------------

/**
 * Evaluates a per-structure query on every loaded structure and applies it, resolving
 * once the selection has changed (Mol*'s fromSelectionQuery fires and forgets).
 */
async function applyPerStructure(
    viewer: Viewer,
    modifier: SelectModifier,
    queryFor: (r: Root) => StructureSelectionQuery | null,
    only?: StructureId,
): Promise<number> {
    const plugin = viewer.plugin;
    const targets = roots(viewer).filter((r) => !only || r.id === only);
    const results = await plugin.runTask(
        Task.create('Select', async (runtime) => {
            const out: Loci[] = [];
            for (const r of targets) {
                const q = queryFor(r);
                if (q) out.push(StructureSelection.toLociWithSourceUnits(await q.getSelection(plugin, runtime, r.root)));
            }
            return out;
        }),
    );
    const manager = plugin.managers.structure.selection;
    if (modifier === 'set') plugin.managers.interactivity.lociSelects.deselectAll();
    let atoms = 0;
    for (const loci of results) {
        if (StructureElement.Loci.is(loci)) atoms += StructureElement.Loci.size(loci);
        manager.fromLoci(modifier === 'set' ? 'add' : modifier, loci);
    }
    return atoms;
}

async function guarded(fn: () => Promise<void> | void): Promise<Result<true>> {
    try {
        await fn();
        return ok(true);
    } catch (e) {
        return err(errorMessage(e));
    }
}

/** Typed ChimeraX-style spec. Returns the number of atoms matched. */
export async function selectBySpec(viewer: Viewer, text: string, modifier: SelectModifier = 'set'): Promise<Result<number>> {
    const parsed = parseSpec(text);
    if (!parsed.ok) return err(parsed.error);
    if (parsed.usesSelection && selectedLoci(viewer).length === 0) return err('A especificação usa "sel", mas nada está selecionado.');
    try {
        const atoms = await applyPerStructure(viewer, modifier, (r) =>
            StructureSelectionQuery(text, compileSpec(parsed.node, r.index), { referencesCurrent: parsed.usesSelection }),
        );
        if (atoms === 0 && modifier === 'set') return err('Nenhum átomo corresponde.');
        return ok(atoms);
    } catch (e) {
        return err(`Falha na seleção: ${errorMessage(e)}`);
    }
}

export function selectChain(viewer: Viewer, id: StructureId, chain: string, modifier: SelectModifier = 'set'): Promise<Result<true>> {
    return guarded(async () => {
        await applyPerStructure(viewer, modifier, () => StructureSelectionQuery(`/${chain}`, chainExpression(chain)), id);
    });
}

/** Residues of one chain by key (seq + insertion code) — the sequence track drives this. */
export function selectResidues(viewer: Viewer, id: StructureId, chain: string, keys: string[], modifier: SelectModifier = 'set'): Promise<Result<true>> {
    return guarded(async () => {
        const seqs = new Set<number>();
        for (const k of keys) {
            const n = parseInt(k, 10);
            if (Number.isFinite(n)) seqs.add(n);
        }
        if (seqs.size === 0) return;
        const expression = MS.struct.generator.atomGroups({
            'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chain]),
            'residue-test': MS.core.set.has([MS.set(...seqs), MS.ammp('auth_seq_id')]),
        });
        await applyPerStructure(viewer, modifier, () => StructureSelectionQuery('residues', expression), id);
    });
}

const RESIDUE_SETS: Partial<Record<ResidueClass, string[]>> = {
    hydrophobic: ['ALA', 'VAL', 'LEU', 'ILE', 'MET', 'PHE', 'TRP', 'PRO'],
    charged: ['ASP', 'GLU', 'LYS', 'ARG', 'HIS'],
    positive: ['LYS', 'ARG', 'HIS'],
    negative: ['ASP', 'GLU'],
    polar: ['SER', 'THR', 'ASN', 'GLN', 'TYR', 'CYS'],
    aromatic: ['PHE', 'TYR', 'TRP', 'HIS'],
    'gly-pro': ['GLY', 'PRO'],
};

function classQuery(cls: ResidueClass): StructureSelectionQuery {
    const names = RESIDUE_SETS[cls];
    if (names) {
        return StructureSelectionQuery(cls, MS.struct.generator.atomGroups({ 'residue-test': MS.core.set.has([MS.set(...names), MS.ammp('label_comp_id')]) }));
    }
    switch (cls) {
        case 'helix':
            return Q.helix;
        case 'sheet':
            return Q.beta;
        case 'loop':
            return StructureSelectionQuery('loop', MS.struct.modifier.exceptBy({ 0: Q.protein.expression, by: MS.struct.combinator.merge([Q.helix.expression, Q.beta.expression]) }));
        case 'ligand':
            return Q.ligand;
        case 'water':
            return Q.water;
        case 'backbone':
            return Q.backbone;
        case 'sidechain':
            return Q.sidechain;
        default:
            return Q.disulfideBridges;
    }
}

export function selectClass(viewer: Viewer, cls: ResidueClass, modifier: SelectModifier = 'set'): Promise<Result<true>> {
    return guarded(async () => {
        await applyPerStructure(viewer, modifier, () => classQuery(cls));
    });
}

/** ChimeraX `select sel :<N` — whole residues within `radius` Å, selection included. */
export function selectAround(viewer: Viewer, radius: number, modifier: SelectModifier = 'set', wholeResidues = true): Promise<Result<true>> {
    return guarded(async () => {
        if (selectedLoci(viewer).length === 0) throw new Error('Nada selecionado.');
        const query = StructureSelectionQuery(
            `within ${radius} Å`,
            MS.struct.modifier.includeSurroundings({ 0: MS.internal.generator.current(), radius, 'as-whole-residues': wholeResidues }),
            { referencesCurrent: true },
        );
        await applyPerStructure(viewer, modifier, () => query);
    });
}

/** Residues of `chainsA` within `cutoff` Å of `chainsB` and vice versa — the interface. */
export function selectInterface(viewer: Viewer, id: StructureId, chainsA: string[], chainsB: string[], cutoff: number): Promise<Result<true>> {
    return guarded(async () => {
        const side = (chains: string[]) => MS.struct.generator.atomGroups({ 'chain-test': MS.core.set.has([MS.set(...chains), MS.ammp('auth_asym_id')]) });
        const near = (a: Expression, b: Expression) =>
            MS.struct.modifier.intersectBy({
                0: a,
                by: MS.struct.modifier.includeSurroundings({ 0: b, radius: cutoff, 'as-whole-residues': true }),
            });
        const wholeA = MS.struct.modifier.wholeResidues({ 0: near(side(chainsA), side(chainsB)) });
        const wholeB = MS.struct.modifier.wholeResidues({ 0: near(side(chainsB), side(chainsA)) });
        await applyPerStructure(viewer, 'set', () => StructureSelectionQuery('interface', MS.struct.combinator.merge([wholeA, wholeB])), id);
    });
}

/**
 * Every non-polymer, non-water group of one structure — ligands, ions, lipids, sugars:
 * what the opening preset draws as sticks. Mol*'s `ligand` query leaves ions, lipids
 * and sugars out, so a "ligands as spheres" built on it left those as sticks.
 */
export async function selectHetero(viewer: Viewer, id: StructureId): Promise<Result<number>> {
    try {
        const atoms = await applyPerStructure(viewer, 'set', () => StructureSelectionQuery('hetero', heteroExpression()), id);
        return ok(atoms);
    } catch (e) {
        return err(errorMessage(e));
    }
}

export function expandToChains(viewer: Viewer): Result<true> {
    for (const loci of selectedLoci(viewer)) viewer.plugin.managers.structure.selection.fromLoci('add', StructureElement.Loci.extendToWholeChains(loci));
    return ok(true);
}

export function expandToResidues(viewer: Viewer): Result<true> {
    for (const loci of selectedLoci(viewer)) viewer.plugin.managers.structure.selection.fromLoci('add', StructureElement.Loci.extendToWholeResidues(loci));
    return ok(true);
}

// ---------------------------------------------------------------------------
// Selection levels (ChimeraX ↑ / ↓)
// ---------------------------------------------------------------------------

export type SelectionLevel = 'residue' | 'secondary' | 'chain' | 'structure' | 'all';

export const SELECTION_LEVEL_NAMES: Record<SelectionLevel, string> = {
    residue: 'resíduos',
    secondary: 'elemento de estrutura secundária',
    chain: 'cadeias',
    structure: 'estrutura inteira',
    all: 'todas as estruturas',
};

interface LevelStep {
    /** Selection before the promotion, restored by ↓. */
    before: StructureElement.Loci[];
    /** Size right after the promotion: if the selection changed since, ↓ has nothing to undo. */
    after: number;
}

const levelHistory = new WeakMap<Viewer, LevelStep[]>();

const totalSize = (loci: StructureElement.Loci[]) => loci.reduce((n, l) => n + StructureElement.Loci.size(l), 0);

async function ensureSecondaryStructure(plugin: PluginContext, structure: Structure): Promise<void> {
    await plugin.runTask(
        Task.create('Estrutura secundária', async (runtime) => {
            await SecondaryStructureProvider.attach({ runtime, assetManager: plugin.managers.asset, errorContext: plugin.errorContext }, structure, undefined, true);
        }),
    );
}

/**
 * Grows each partly selected run of residues to the helix, strand or loop it sits in.
 * The walk is along the chain while the element key stays the same, so two loops
 * that happen to share a key are not merged.
 */
function extendToSecondaryElements(loci: StructureElement.Loci): StructureElement.Loci {
    const value = SecondaryStructureProvider.get(loci.structure).value;
    if (!value) return StructureElement.Loci.extendToWholeResidues(loci);
    const elements = loci.elements.map(({ unit, indices }) => {
        const ss = value.get(unit.invariantId);
        const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
        const n = unit.elements.length;
        if (!ss || n === 0) return { unit, indices };
        const res = new Int32Array(n);
        for (let i = 0; i < n; i++) res[i] = residueOf[unit.elements[i]!]!;
        const keyAt = (i: number) => ss.key[ss.getIndex(res[i]! as never)]!;
        const keep = new Uint8Array(n);
        OrderedSet.forEach(indices, (i) => {
            if (keep[i]) return;
            const key = keyAt(i);
            let lo = i;
            while (lo > 0 && keyAt(lo - 1) === key && res[lo - 1]! >= res[lo]! - 1) lo--;
            let hi = i;
            while (hi < n - 1 && keyAt(hi + 1) === key && res[hi + 1]! <= res[hi]! + 1) hi++;
            for (let k = lo; k <= hi; k++) keep[k] = 1;
        });
        const out: number[] = [];
        for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
        return { unit, indices: OrderedSet.ofSortedArray(out as never) };
    });
    return StructureElement.Loci(loci.structure, elements as never);
}

function extendTo(level: SelectionLevel, loci: StructureElement.Loci): StructureElement.Loci {
    switch (level) {
        case 'residue':
            return StructureElement.Loci.extendToWholeResidues(loci);
        case 'secondary':
            return extendToSecondaryElements(StructureElement.Loci.extendToWholeResidues(loci));
        case 'chain':
            return StructureElement.Loci.extendToWholeChains(loci);
        case 'structure':
        case 'all':
            return Structure.toStructureElementLoci(loci.structure);
    }
}

function setSelection(viewer: Viewer, loci: StructureElement.Loci[]): void {
    const manager = viewer.plugin.managers.structure.selection;
    viewer.plugin.managers.interactivity.lociSelects.deselectAll();
    for (const l of loci) manager.fromLoci('add', l);
}

/**
 * ↑ in ChimeraX: the selection grows to the next level that actually adds atoms —
 * a residue that is already whole goes straight to its helix, a whole chain to the
 * structure. Returns the level reached, or null when there is nowhere to go.
 */
export async function promoteSelection(viewer: Viewer): Promise<Result<SelectionLevel | null>> {
    const current = selectedLoci(viewer);
    if (current.length === 0) return ok(null);
    try {
        for (const l of current) await ensureSecondaryStructure(viewer.plugin, l.structure);
        const size = totalSize(current);
        for (const level of ['residue', 'secondary', 'chain', 'structure'] as const) {
            const next = current.map((l) => extendTo(level, l));
            if (totalSize(next) > size) {
                pushLevel(viewer, current, next);
                return ok(level);
            }
        }
        // Every selected structure is whole: the last step takes in the others.
        const all = roots(viewer).map(({ root }) => Structure.toStructureElementLoci(root));
        if (totalSize(all) > size) {
            pushLevel(viewer, current, all);
            return ok('all');
        }
        return ok(null);
    } catch (e) {
        return err(`Falha ao ampliar a seleção: ${errorMessage(e)}`);
    }
}

function pushLevel(viewer: Viewer, before: StructureElement.Loci[], next: StructureElement.Loci[]): void {
    setSelection(viewer, next);
    const stack = levelHistory.get(viewer) ?? [];
    stack.push({ before, after: totalSize(selectedLoci(viewer)) });
    levelHistory.set(viewer, stack);
}

/** ↓: back to what was selected before the last ↑. False when there is no step to undo. */
export function demoteSelection(viewer: Viewer): boolean {
    const stack = levelHistory.get(viewer);
    const step = stack?.pop();
    if (!step) return false;
    // A click or a typed selection since the ↑ makes the history meaningless.
    if (totalSize(selectedLoci(viewer)) !== step.after) {
        levelHistory.delete(viewer);
        return false;
    }
    setSelection(viewer, step.before);
    return true;
}

export function invertSelection(viewer: Viewer): Promise<Result<true>> {
    return guarded(async () => {
        await applyPerStructure(viewer, 'set', () => Q.complement);
    });
}

export function selectAll(viewer: Viewer): Promise<Result<true>> {
    return guarded(async () => {
        await applyPerStructure(viewer, 'set', () => Q.all);
    });
}

export function clearSelection(viewer: Viewer): void {
    viewer.plugin.managers.interactivity.lociSelects.deselectAll();
}

/** Centres the camera on the selection; with `withSurroundings`, shows its neighbourhood like an explore click. */
export function focusSelection(viewer: Viewer, withSurroundings = false): Result<true> {
    const loci = selectedLoci(viewer);
    if (loci.length === 0) return err('Nada selecionado.');
    viewer.plugin.managers.camera.focusLoci(loci, { durationMs: FOCUS_MS });
    if (withSurroundings && loci.length === 1) viewer.plugin.managers.structure.focus.setFromLoci(loci[0]!);
    return ok(true);
}

/** Re-themes the focus view after the structure's colours change. */
export function refreshFocusView(viewer: Viewer, id: StructureId): Promise<void> {
    return styleFocusView(viewer, id);
}

export function clearFocus(viewer: Viewer): void {
    viewer.plugin.managers.structure.focus.clear();
}

/** Labels of the selected residues (Mol* label representation via the measurement manager). */
export async function labelSelection(viewer: Viewer): Promise<Result<true>> {
    const plugin: PluginContext = viewer.plugin;
    const loci = selectedLoci(viewer);
    if (loci.length === 0) return err('Nada selecionado.');
    try {
        for (const l of loci) {
            // One label per residue: split the loci by residue.
            for (const { unit, indices } of l.elements) {
                const residueOf = unit.model.atomicHierarchy.residueAtomSegments.index;
                let last = -1;
                for (let i = 0, n = OrderedSet.size(indices); i < n; i++) {
                    const unitIndex = OrderedSet.getAt(indices, i);
                    const r = residueOf[unit.elements[unitIndex]!]!;
                    if (r === last) continue;
                    last = r;
                    const atom = StructureElement.Loci(l.structure, [{ unit, indices: OrderedSet.ofSingleton(unitIndex) }]);
                    const residueLoci = StructureElement.Loci.extendToWholeResidues(atom);
                    await plugin.managers.structure.measurement.addLabel(residueLoci);
                }
            }
        }
        return ok(true);
    } catch (e) {
        return err(`Falha ao rotular: ${errorMessage(e)}`);
    }
}
