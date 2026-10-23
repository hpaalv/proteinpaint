/**
 * KVFinder cavities in the scene.
 *
 * The cavity grid comes from ppcore/tools/kvfinder.py as a PDB of points: one
 * residue per cavity (KAA, KAB…), atom name CS = surface point / CI = interior,
 * B-factor = depth, occupancy = hydropathy. It is loaded as its own structure,
 * outside the structure tree, with one component per cavity so each can be shown,
 * hidden or recoloured independently — the way the KVFinder PyMOL plugin lists them.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { StateObjectSelector } from 'molstar/lib/mol-state';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { createStructureColorThemeParams, createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Color } from 'molstar/lib/mol-util/color';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra/3d/mat4';
import { UUID } from 'molstar/lib/mol-util/uuid';
import { CONTINUOUS_RAMPS, hexToInt } from '@/data/palettes';
import { displayedStructureRef } from './compare';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type RampId, type Result, type StructureId } from './types';

export type CavityRepr = 'points' | 'spheres' | 'surface' | 'mesh';
export type CavityColorMode = 'cavity' | 'depth' | 'hydropathy' | 'uniform';

export interface CavityStyle {
    repr: CavityRepr;
    /** Draw only the cavity-surface points (CS), the KVFinder "surface" export. */
    surfaceOnly: boolean;
    color: CavityColorMode;
    uniform: number;
    depthRamp: RampId;
    depthMax: number;
    hydropathyRamp: RampId;
    hydropathyRange: [number, number];
    opacity: number;
    /** Point / sphere size relative to the grid step. */
    size: number;
}

export const DEFAULT_CAVITY_STYLE: CavityStyle = {
    repr: 'surface',
    surfaceOnly: false,
    color: 'cavity',
    uniform: 0x4cc9f0,
    depthRamp: 'viridis',
    depthMax: 8,
    hydropathyRamp: 'blue-white-red',
    hydropathyRange: [-1.42, 2.6],
    opacity: 0.85,
    size: 1,
};

/** KVFinder-like categorical colours, one per cavity. */
export const CAVITY_PALETTE = ['#4CC9F0', '#F72585', '#FFB454', '#38D9A9', '#7C6CFF', '#E69F00', '#56B4E9', '#CC79A7', '#A3E635', '#FF6B6B'];

interface CavitySet {
    id: string;
    sourceId: StructureId;
    label: string;
    tags: string[];
    dataRef: string;
    structure: StateObjectSelector;
    components: Map<string, string>;
    hidden: Set<string>;
    style: CavityStyle;
}

const sets = new WeakMap<Viewer, Map<string, CavitySet>>();
function setsOf(viewer: Viewer): Map<string, CavitySet> {
    let m = sets.get(viewer);
    if (!m) sets.set(viewer, (m = new Map()));
    return m;
}

function cavityColors(tags: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    tags.forEach((t, i) => (out[t] = hexToInt(CAVITY_PALETTE[i % CAVITY_PALETTE.length]!)));
    return out;
}

function reprParams(plugin: PluginContext, data: unknown, set: CavitySet) {
    const s = set.style;
    const type = s.repr === 'surface' || s.repr === 'mesh' ? 'gaussian-surface' : 'spacefill';
    // Grid step 0.6 Å → points are 0.3 Å apart from their neighbours' surfaces. Carbon
    // vdW is 1.7 Å, so these factors give touching spheres / small points.
    const typeParams: Record<string, unknown> =
        type === 'spacefill'
            ? { sizeFactor: (s.repr === 'points' ? 0.07 : 0.18) * s.size, alpha: s.opacity, ignoreHydrogens: false }
            : {
                  sizeFactor: 0.35 * s.size,
                  smoothness: 1.5,
                  resolution: 0.4,
                  alpha: s.opacity,
                  tryUseGpu: true,
                  visuals: s.repr === 'mesh' ? ['gaussian-surface-wireframe'] : ['gaussian-surface-mesh'],
              };
    let color: string;
    let colorParams: Record<string, unknown> = {};
    switch (s.color) {
        case 'cavity':
            color = 'pp-residue-class';
            colorParams = { colors: cavityColors(set.tags) };
            break;
        case 'depth':
            color = 'uncertainty';
            colorParams = { domain: [0, s.depthMax], list: { kind: 'interpolate', colors: [...CONTINUOUS_RAMPS[s.depthRamp]].reverse().map((h) => Color(hexToInt(h))) } };
            break;
        case 'hydropathy':
            color = 'occupancy';
            colorParams = { domain: s.hydropathyRange, list: { kind: 'interpolate', colors: CONTINUOUS_RAMPS[s.hydropathyRamp].map((h) => Color(hexToInt(h))) } };
            break;
        default:
            color = 'uniform';
            colorParams = { value: Color(s.uniform) };
    }
    return {
        ...createStructureRepresentationParams(plugin, data as never, { type, typeParams }),
        colorTheme: createStructureColorThemeParams(plugin, data as never, type, color, colorParams),
    };
}

function cavityQuery(tag: string, surfaceOnly: boolean): StructureSelectionQuery {
    const tests: Record<string, ReturnType<typeof MS.core.rel.eq>> = { 'residue-test': MS.core.rel.eq([MS.ammp('label_comp_id'), tag]) };
    if (surfaceOnly) tests['atom-test'] = MS.core.rel.eq([MS.ammp('label_atom_id'), 'CS']);
    return StructureSelectionQuery(`cavity ${tag}`, MS.struct.generator.atomGroups(tests));
}

async function buildComponents(viewer: Viewer, set: CavitySet): Promise<void> {
    const plugin = viewer.plugin;
    if (set.components.size) {
        const b = plugin.build();
        for (const ref of set.components.values()) b.delete(ref);
        await b.commit();
        set.components.clear();
    }
    const cell = set.structure.cell;
    if (!cell) return;
    for (const tag of set.tags) {
        const component = await plugin.builders.structure.tryCreateComponentFromSelection(cell, cavityQuery(tag, set.style.surfaceOnly), UUID.create22(), {
            label: tag,
            tags: ['pp-cavity', `pp-cavity:${tag}`],
        });
        if (!component) continue;
        await plugin.build().to(component).apply(StateTransforms.Representation.StructureRepresentation3D, reprParams(plugin, component.cell?.obj?.data, set) as never).commit();
        set.components.set(tag, component.ref);
        if (set.hidden.has(tag)) viewer.setHidden(component.ref, true);
    }
}

/**
 * Loads a cavity set over `sourceId`. If the source has been superposed, the same
 * transform is applied to the cavities so they stay inside the protein.
 */
export async function showCavities(viewer: Viewer, sourceId: StructureId, pdbText: string, tags: string[], label: string, style: CavityStyle = DEFAULT_CAVITY_STYLE): Promise<Result<string>> {
    const plugin = viewer.plugin;
    const source = viewer.entry(sourceId);
    if (!source) return err('Estrutura de origem não encontrada.');
    try {
        const data = await plugin.builders.data.rawData({ data: pdbText, label });
        const trajectory = await plugin.builders.structure.parseTrajectory(data, 'pdb');
        const model = await plugin.builders.structure.createModel(trajectory);
        let structure = await plugin.builders.structure.createStructure(model);

        const transformRef = displayedStructureRef(plugin, source);
        if (transformRef !== source.structure.ref) {
            const node = plugin.state.data.cells.get(transformRef);
            const params = node?.transform.params as { transform?: { name: string; params: { data: Mat4; transpose: boolean } } } | undefined;
            if (params?.transform?.name === 'matrix') {
                structure = await plugin
                    .build()
                    .to(structure)
                    .apply(StateTransforms.Model.TransformStructureConformation, { transform: { name: 'matrix', params: params.transform.params } })
                    .commit();
            }
        }

        const id = UUID.create22();
        const set: CavitySet = { id, sourceId, label, tags, dataRef: data.ref, structure, components: new Map(), hidden: new Set(), style: { ...style } };
        setsOf(viewer).set(id, set);
        await buildComponents(viewer, set);
        return ok(id);
    } catch (e) {
        return err(`Falha ao mostrar as cavidades: ${errorMessage(e)}`);
    }
}

/** Re-styles a set. Representation and surface-only rebuild components; colour/opacity update in place. */
export async function styleCavities(viewer: Viewer, setId: string, patch: Partial<CavityStyle>): Promise<Result<true>> {
    const set = setsOf(viewer).get(setId);
    if (!set) return err('Conjunto de cavidades não encontrado.');
    const plugin = viewer.plugin;
    const rebuild = (patch.surfaceOnly !== undefined && patch.surfaceOnly !== set.style.surfaceOnly);
    set.style = { ...set.style, ...patch };
    try {
        if (rebuild) {
            await buildComponents(viewer, set);
            return ok(true);
        }
        const b = plugin.build();
        for (const ref of set.components.values()) {
            const cell = plugin.state.data.cells.get(ref);
            const repr = plugin.state.data.tree.children.get(ref).first();
            if (!repr) continue;
            b.to(repr).update(StateTransforms.Representation.StructureRepresentation3D, () => reprParams(plugin, cell?.obj?.data, set) as never);
        }
        await b.commit();
        return ok(true);
    } catch (e) {
        return err(`Falha ao estilizar as cavidades: ${errorMessage(e)}`);
    }
}

export function setCavityVisible(viewer: Viewer, setId: string, tag: string, visible: boolean): void {
    const set = setsOf(viewer).get(setId);
    if (!set) return;
    if (visible) set.hidden.delete(tag);
    else set.hidden.add(tag);
    const ref = set.components.get(tag);
    if (ref) viewer.setHidden(ref, !visible);
}

export function soloCavity(viewer: Viewer, setId: string, tag: string | null): void {
    const set = setsOf(viewer).get(setId);
    if (!set) return;
    for (const t of set.tags) setCavityVisible(viewer, setId, t, tag === null || t === tag);
}

export function focusCavity(viewer: Viewer, setId: string, tag: string): void {
    const set = setsOf(viewer).get(setId);
    const ref = set?.components.get(tag);
    if (ref) viewer.plugin.managers.camera.focusObject({ targets: [{ targetRef: ref }], durationMs: 350 });
}

export function cavityColor(setId: string | null, viewer: Viewer, tag: string): string {
    const set = setId ? setsOf(viewer).get(setId) : undefined;
    const i = set ? set.tags.indexOf(tag) : 0;
    return CAVITY_PALETTE[Math.max(0, i) % CAVITY_PALETTE.length]!;
}

export async function removeCavities(viewer: Viewer, setId: string): Promise<void> {
    const set = setsOf(viewer).get(setId);
    if (!set) return;
    await viewer.plugin.build().delete(set.dataRef).commit();
    setsOf(viewer).delete(setId);
}

/** Cavity sets computed on a structure that is being closed. */
export async function removeCavitiesOf(viewer: Viewer, sourceId: StructureId): Promise<void> {
    for (const set of [...setsOf(viewer).values()]) if (set.sourceId === sourceId) await removeCavities(viewer, set.id);
}

export function cavitySetStyle(viewer: Viewer, setId: string): CavityStyle | null {
    return setsOf(viewer).get(setId)?.style ?? null;
}
