/**
 * Electrostatic surfaces: an APBS .dx potential sampled on a molecular surface
 * (ChimeraX `color sample … map … palette red:white:blue range -10,10`).
 *
 * The map is loaded as a Mol* volume; a dedicated surface component (not one of the
 * style layers, so restyling never drops it) uses the external-volume colour theme.
 * That theme samples on the CPU, so the surface is the SES mesh, not the GPU
 * gaussian surface.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { StructureSelectionQuery } from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { createStructureColorThemeParams, createStructureRepresentationParams } from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import { Color } from 'molstar/lib/mol-util/color';
import { UUID } from 'molstar/lib/mol-util/uuid';
import { CONTINUOUS_RAMPS, hexToInt } from '@/data/palettes';
import { structureRefFor } from './style';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type RampId, type Result, type StructureId } from './types';

export interface PotentialStyle {
    /** ± kT/e at the ends of the ramp. */
    range: number;
    ramp: RampId;
    opacity: number;
    /** Sample slightly off the surface, as `color sample` does with an offset. */
    normalOffset: number;
}

export const DEFAULT_POTENTIAL_STYLE: PotentialStyle = { range: 10, ramp: 'red-white-blue', opacity: 1, normalOffset: 1.4 };

interface PotentialRecord {
    structureId: StructureId;
    volumeRef: string;
    dataRef: string;
    componentRef: string;
    reprRef: string;
    chains: string[];
    style: PotentialStyle;
}

const records = new WeakMap<Viewer, Map<StructureId, PotentialRecord>>();
function recordsOf(viewer: Viewer): Map<StructureId, PotentialRecord> {
    let m = records.get(viewer);
    if (!m) records.set(viewer, (m = new Map()));
    return m;
}

function colorTheme(plugin: PluginContext, data: unknown, volumeRef: string, style: PotentialStyle) {
    const colors = CONTINUOUS_RAMPS[style.ramp].map((h) => Color(hexToInt(h)));
    return createStructureColorThemeParams(plugin, data as never, 'molecular-surface', 'external-volume', {
        volume: { ref: volumeRef },
        coloring: {
            name: 'absolute-value',
            params: { domain: { name: 'custom', params: [-style.range, style.range] }, list: { kind: 'interpolate', colors } },
        },
        defaultColor: Color(0xffffff),
        normalOffset: style.normalOffset,
        usePalette: false,
    });
}

export async function showPotential(
    viewer: Viewer,
    id: StructureId,
    dxText: string,
    chains: string[],
    style: PotentialStyle = DEFAULT_POTENTIAL_STYLE,
): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        await removePotential(viewer, id);
        const data = await plugin.builders.data.rawData({ data: dxText, label: `Potencial · ${entry.info.alias || entry.info.name}` });
        const parsed = await plugin.dataFormats.get('dx')!.parse(plugin, data);
        const volumeRef = parsed.volume.ref;

        const expression = chains.length
            ? MS.struct.generator.atomGroups({ 'chain-test': MS.core.set.has([MS.set(...chains), MS.ammp('auth_asym_id')]) })
            : MS.struct.generator.all();
        const component = await plugin.builders.structure.tryCreateComponentFromSelection(
            structure.cell,
            StructureSelectionQuery('pp potential', MS.struct.modifier.intersectBy({ 0: expression, by: MS.struct.generator.atomGroups({ 'entity-test': MS.core.rel.eq([MS.ammp('entityType'), 'polymer']) }) })),
            UUID.create22(),
            { label: 'Potencial eletrostático', tags: ['pp-potential'] },
        );
        if (!component) return err('Nenhum átomo de polímero nas cadeias escolhidas.');
        const sdata = component.cell?.obj?.data;
        const params = {
            ...createStructureRepresentationParams(plugin, sdata, { type: 'molecular-surface', typeParams: { alpha: style.opacity, ignoreHydrogens: true } }),
            colorTheme: colorTheme(plugin, sdata, volumeRef, style),
        };
        const repr = await plugin.build().to(component).apply(StateTransforms.Representation.StructureRepresentation3D, params as never).commit();
        recordsOf(viewer).set(id, { structureId: id, volumeRef, dataRef: data.ref, componentRef: component.ref, reprRef: repr.ref, chains, style });
        return ok(true);
    } catch (e) {
        return err(`Falha ao mostrar o potencial: ${errorMessage(e)}`);
    }
}

export async function stylePotential(viewer: Viewer, id: StructureId, style: PotentialStyle): Promise<Result<true>> {
    const rec = recordsOf(viewer).get(id);
    if (!rec) return err('Nenhum potencial carregado para esta estrutura.');
    const plugin = viewer.plugin;
    try {
        const cell = plugin.state.data.cells.get(rec.componentRef);
        await plugin
            .build()
            .to(rec.reprRef)
            .update(StateTransforms.Representation.StructureRepresentation3D, (old) => ({
                ...old,
                type: { ...old.type, params: { ...old.type.params, alpha: style.opacity } },
                colorTheme: colorTheme(plugin, cell?.obj?.data, rec.volumeRef, style),
            }))
            .commit();
        rec.style = style;
        return ok(true);
    } catch (e) {
        return err(`Falha ao atualizar o potencial: ${errorMessage(e)}`);
    }
}

export function hasPotential(viewer: Viewer, id: StructureId): PotentialStyle | null {
    return recordsOf(viewer).get(id)?.style ?? null;
}

export async function removePotential(viewer: Viewer, id: StructureId): Promise<void> {
    const rec = recordsOf(viewer).get(id);
    if (!rec) return;
    const builder = viewer.plugin.build();
    builder.delete(rec.componentRef);
    builder.delete(rec.dataRef);
    await builder.commit();
    recordsOf(viewer).delete(id);
}

export function setPotentialVisible(viewer: Viewer, id: StructureId, visible: boolean): void {
    const rec = recordsOf(viewer).get(id);
    if (rec) viewer.setHidden(rec.componentRef, !visible);
}
