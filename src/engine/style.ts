/**
 * Display styles on ChimeraX's model of three independent layers per residue —
 * ribbon, atoms, surface.
 *
 * Every layer is a Mol* StructureComponent carrying one representation; the layer
 * and its style live in the component's state-tree tags, so the state tree is the
 * single source of truth.
 *
 * Restyling part of a structure subtracts those atoms from the components of the same
 * layer and creates one component for them with the new style. Painted colours and
 * transparency are a per-structure log replayed onto every component created later,
 * so a style change never loses a colour the user gave.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { StateObjectSelector } from 'molstar/lib/mol-state';
import { Structure, StructureElement, StructureSelection } from 'molstar/lib/mol-model/structure';
import type { StructureComponentRef, StructureRef } from 'molstar/lib/mol-plugin-state/manager/structure/hierarchy-state';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import {
    createStructureColorThemeParams,
    createStructureRepresentationParams,
} from 'molstar/lib/mol-plugin-state/helpers/structure-representation-params';
import {
    StructureSelectionQueries as Q,
    StructureSelectionQuery,
} from 'molstar/lib/mol-plugin-state/helpers/structure-selection-query';
import { clearStructureOverpaint, setStructureOverpaint } from 'molstar/lib/mol-plugin-state/helpers/structure-overpaint';
import { clearStructureTransparency, setStructureTransparency } from 'molstar/lib/mol-plugin-state/helpers/structure-transparency';
import { clearStructureEmissive, setStructureEmissive } from 'molstar/lib/mol-plugin-state/helpers/structure-emissive';
import { structureAreIntersecting, structureSubtract } from 'molstar/lib/mol-model/structure/query/utils/structure-set';
import { MolScriptBuilder as MS } from 'molstar/lib/mol-script/language/builder';
import type { Expression } from 'molstar/lib/mol-script/language/expression';
import { Script } from 'molstar/lib/mol-script/script';
import { Color } from 'molstar/lib/mol-util/color';
import { getInteriorParam } from 'molstar/lib/mol-geo/geometry/interior';
import { Overpaint } from 'molstar/lib/mol-theme/overpaint';
import { Transparency } from 'molstar/lib/mol-theme/transparency';
import { StateSelection } from 'molstar/lib/mol-state';
import { dropMeasurementsOf } from './measure';
import { pruneOverlays } from './overlay';
import { removeCavitiesOf } from './cavities';
import { removePotential } from './potential';
import { UUID } from 'molstar/lib/mol-util/uuid';
import { chainCarbonTheme, colorThemeFor } from './coloring';
import { clearFocus, refreshFocusView, styleFocusView } from './selection';
import type { ChainPaletteId } from '@/data/palettes';
import { hydrogenParams, type HydrogenDisplay, type PaintOp, type StructureEntry, type Viewer } from './viewer';
import {
    ok,
    err,
    errorMessage,
    type ColorSettings,
    type Layer,
    type LayerStyle,
    type Result,
    type StructureId,
    type StyleTarget,
} from './types';

// ---------------------------------------------------------------------------
// Layer ↔ Mol* representation
// ---------------------------------------------------------------------------

const TAG = 'pp-layer';

function layerTags(style: LayerStyle): string[] {
    return [TAG, `${TAG}:${JSON.stringify(style)}`];
}

export function layerStyleOf(component: StructureComponentRef): LayerStyle | null {
    const tag = component.cell.transform.tags?.find((t) => t.startsWith(`${TAG}:`));
    if (!tag) return null;
    try {
        return JSON.parse(tag.slice(TAG.length + 1)) as LayerStyle;
    } catch {
        return null;
    }
}

type ReprType = 'cartoon' | 'backbone' | 'putty' | 'ball-and-stick' | 'spacefill' | 'line' | 'molecular-surface' | 'gaussian-surface';

/**
 * Ribbons and atoms turn off Mol*'s interior colour: their double-sided meshes
 * showed the back faces of strand arrows and helix caps in flat dark grey. Surfaces
 * keep it — there the dark interior is what makes a clipped surface read as a cut.
 */
const SEAMLESS_INTERIOR = { interior: { ...getInteriorParam().defaultValue, colorStrength: 0, substanceStrength: 0 } };

interface ReprSpec {
    type: ReprType;
    typeParams: Record<string, unknown>;
    size?: { name: string; params: Record<string, unknown> };
}

function reprSpec(style: LayerStyle, hydrogenMode: HydrogenDisplay): ReprSpec {
    const hydrogens = { ...hydrogenParams(hydrogenMode), ...SEAMLESS_INTERIOR };
    switch (style.layer) {
        case 'ribbon':
            switch (style.style) {
                case 'cartoon':
                    return { type: 'cartoon', typeParams: { ...SEAMLESS_INTERIOR } };
                case 'tube':
                    return { type: 'cartoon', typeParams: { ...SEAMLESS_INTERIOR, tubularHelices: true } };
                case 'backbone':
                    return { type: 'backbone', typeParams: { ...SEAMLESS_INTERIOR } };
                case 'putty':
                    // Thickness follows B-factor / pLDDT: Mol*'s putty default size theme.
                    return { type: 'putty', typeParams: { ...SEAMLESS_INTERIOR } };
            }
            break;
        case 'atoms':
            switch (style.style) {
                // ChimeraX "licorice": a uniform size theme makes every atom the radius of its bonds.
                case 'sticks':
                    return {
                        type: 'ball-and-stick',
                        typeParams: { ...hydrogens, sizeFactor: 0.2 * style.size, sizeAspectRatio: 1 },
                        size: { name: 'uniform', params: { value: 1 } },
                    };
                case 'ball-and-stick':
                    return { type: 'ball-and-stick', typeParams: { ...hydrogens, sizeFactor: 0.2 * style.size, sizeAspectRatio: 0.5 } };
                case 'spheres':
                    return { type: 'spacefill', typeParams: { ...hydrogens, sizeFactor: style.size } };
                case 'lines':
                    return { type: 'line', typeParams: { ...hydrogenParams(hydrogenMode), sizeFactor: 2 * style.size } };
            }
            break;
        case 'surface':
            return style.style === 'molecular'
                ? { type: 'molecular-surface', typeParams: { alpha: style.opacity, ignoreHydrogens: true } }
                : { type: 'gaussian-surface', typeParams: { alpha: style.opacity, ignoreHydrogens: true, tryUseGpu: true } };
    }
}

/** Material and shading from the viewer's look (look.ts), for a layer's representation. */
function lookTypeParams(viewer: Viewer, layer: Layer, type: string): Record<string, unknown> {
    const look = viewer.look;
    if (!look) return {};
    // Lines have no lit surface: neither material nor cel shading applies.
    if (type === 'line') return {};
    return { material: { ...look.material[layer] }, celShaded: look.celShaded };
}

/**
 * Pushes the look's materials onto every existing layer in one state update; layers
 * created later pick them up in representationParams. Unchanged representations are
 * skipped so a look change never rebuilds anything it does not have to.
 */
export async function applyRepresentationLook(viewer: Viewer): Promise<void> {
    const plugin = viewer.plugin;
    const builder = plugin.build();
    let touched = 0;
    for (const entry of viewer.entries.values()) {
        const structure = structureRefFor(plugin, entry);
        if (!structure) continue;
        for (const component of componentsIn(structure)) {
            const layer = layerStyleOf(component)!.layer;
            for (const repr of component.representations) {
                const params = repr.cell.transform.params as { type: { name: string; params: Record<string, unknown> } } | undefined;
                if (!params) continue;
                const wanted = lookTypeParams(viewer, layer, params.type.name);
                if (Object.keys(wanted).length === 0) continue;
                const current = { material: params.type.params.material, celShaded: params.type.params.celShaded };
                if (JSON.stringify(current) === JSON.stringify(wanted)) continue;
                builder.to(repr.cell).update(StateTransforms.Representation.StructureRepresentation3D, (old) => ({
                    ...old,
                    type: { ...old.type, params: { ...old.type.params, ...wanted } },
                }));
                touched++;
            }
        }
    }
    try {
        if (touched) await builder.commit();
    } catch {
        // A structure removed mid-update: the next look change catches up.
    }
}

function representationParams(viewer: Viewer, component: StateObjectSelector, style: LayerStyle, entry: StructureEntry) {
    const plugin = viewer.plugin;
    const structure = component.cell?.obj?.data as Structure | undefined;
    const spec = reprSpec(style, viewer.hydrogens);
    const theme = colorThemeFor(viewer, entry, style.layer);
    const base = createStructureRepresentationParams(plugin, structure, { type: spec.type, typeParams: { ...spec.typeParams, ...lookTypeParams(viewer, style.layer, spec.type) } });
    return {
        ...base,
        colorTheme: createStructureColorThemeParams(plugin, structure, spec.type, theme.color, theme.colorParams),
        ...(spec.size && { sizeTheme: { name: spec.size.name, params: spec.size.params } }),
    } as typeof base;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const current = (): Expression => MS.internal.generator.current();
const intersect = (a: Expression, b: Expression): Expression => MS.struct.modifier.intersectBy({ 0: a, by: b });
const merge = (...xs: Expression[]): Expression => MS.struct.combinator.merge(xs);

/** Ligands and ions — neither polymer nor water. */
export const heteroExpression = (): Expression =>
    MS.struct.generator.atomGroups({
        'entity-test': MS.core.logic.and([
            MS.core.rel.neq([MS.ammp('entityType'), 'polymer']),
            MS.core.rel.neq([MS.ammp('entityType'), 'water']),
        ]),
    });

export const chainExpression = (chain: string): Expression =>
    MS.struct.generator.atomGroups({ 'chain-test': MS.core.rel.eq([MS.ammp('auth_asym_id'), chain]) });

/**
 * With a ribbon present the backbone is already drawn by it, so the atoms layer adds
 * only side chains plus the Cα they hang from — as ChimeraX does, half the geometry.
 */
function atomsExpression(scope: Expression, hasRibbon: boolean): Expression {
    if (!hasRibbon) return intersect(scope, merge(Q.polymer.expression, heteroExpression()));
    return intersect(scope, merge(Q.sidechainWithTrace.expression, heteroExpression()));
}

function scopeExpression(target: StyleTarget): Expression {
    switch (target.kind) {
        case 'selection':
            return current();
        case 'structure':
            return MS.struct.generator.all();
        case 'chain':
            return chainExpression(target.chain);
    }
}

function layerQuery(layer: Layer, target: StyleTarget, hasRibbon: boolean): StructureSelectionQuery {
    const usesCurrent = target.kind === 'selection';
    const scope = scopeExpression(target);
    const expression = layer === 'atoms' ? atomsExpression(scope, hasRibbon) : intersect(scope, Q.polymer.expression);
    return StructureSelectionQuery(`pp ${layer}`, expression, { referencesCurrent: usesCurrent });
}

// ---------------------------------------------------------------------------
// Hierarchy access
// ---------------------------------------------------------------------------

export function structureRefFor(plugin: PluginContext, entry: StructureEntry): StructureRef | undefined {
    return plugin.managers.structure.hierarchy.current.structures.find((s) => s.cell.transform.ref === entry.structure.ref);
}

function entryFor(viewer: Viewer, structure: StructureRef): StructureEntry | undefined {
    for (const e of viewer.entries.values()) if (e.structure.ref === structure.cell.transform.ref) return e;
    return undefined;
}

function targetStructures(viewer: Viewer, target: StyleTarget): StructureRef[] {
    const plugin = viewer.plugin;
    if (target.kind !== 'selection') {
        const entry = viewer.entry(target.id);
        const ref = entry && structureRefFor(plugin, entry);
        return ref ? [ref] : [];
    }
    return plugin.managers.structure.hierarchy.current.structures.filter((s) => plugin.managers.structure.selection.structureHasSelection(s));
}

/** The target's atoms in a given structure object (root or a transformed copy). */
function targetLoci(plugin: PluginContext, target: StyleTarget, structure: Structure): StructureElement.Loci | null {
    let loci;
    switch (target.kind) {
        case 'selection':
            loci = plugin.managers.structure.selection.getLoci(structure);
            break;
        case 'structure':
            loci = Structure.toStructureElementLoci(structure);
            break;
        case 'chain':
            loci = StructureSelection.toLociWithSourceUnits(Script.getStructureSelection(chainExpression(target.chain), structure));
            break;
    }
    if (!StructureElement.Loci.is(loci) || StructureElement.Loci.isEmpty(loci)) return null;
    return loci;
}

function targetBundle(plugin: PluginContext, target: StyleTarget, structure: StructureRef): StructureElement.Bundle | null {
    const root = structure.cell.obj?.data;
    if (!root) return null;
    const loci = targetLoci(plugin, target, root);
    return loci ? StructureElement.Bundle.fromLoci(loci) : null;
}

export function componentsIn(structure: StructureRef, layer?: Layer): StructureComponentRef[] {
    return structure.components.filter((c) => {
        const style = layerStyleOf(c);
        return style !== null && (layer === undefined || style.layer === layer);
    });
}

/**
 * Removes the target's atoms from each component — Mol*'s modifyByCurrentSelection,
 * generalised to any target (a chain, not only the current selection).
 */
async function subtractTarget(plugin: PluginContext, components: StructureComponentRef[], target: StyleTarget): Promise<void> {
    const builder = plugin.build();
    let changed = false;
    for (const c of components) {
        const structure = c.cell.obj?.data;
        const parent = c.structure.cell.obj?.data;
        if (!structure || !parent) continue;
        const loci = targetLoci(plugin, target, parent);
        if (!loci) continue;
        const by = StructureElement.Loci.toStructure(loci);
        if (!structureAreIntersecting(structure, by)) continue;
        const remaining = structureSubtract(structure, by);
        changed = true;
        if (remaining.elementCount === 0) {
            builder.delete(c.cell.transform.ref);
        } else {
            builder.to(c.cell).update(StateTransforms.Model.StructureComponent, (old) => ({
                ...old,
                type: { name: 'bundle' as const, params: StructureElement.Bundle.fromSubStructure(parent, remaining) },
                nullIfEmpty: true,
            }));
        }
    }
    if (changed) await builder.commit();
}

// ---------------------------------------------------------------------------
// Painting with replay
// ---------------------------------------------------------------------------

async function applyPaint(plugin: PluginContext, components: StructureComponentRef[], op: PaintOp): Promise<void> {
    if (components.length === 0) return;
    switch (op.kind) {
        case 'color': {
            const getLoci = async (root: Structure) => StructureElement.Bundle.toLoci(op.bundle, root);
            return setStructureOverpaint(plugin, components, op.color === null ? -1 : Color(op.color), getLoci);
        }
        case 'transparency': {
            const getLoci = async (root: Structure) => StructureElement.Bundle.toLoci(op.bundle, root);
            return setStructureTransparency(plugin, components, op.value, getLoci);
        }
        case 'emissive': {
            const getLoci = async (root: Structure) => StructureElement.Bundle.toLoci(op.bundle, root);
            return setStructureEmissive(plugin, components, op.value, getLoci);
        }
        case 'color-layers':
            return paintLayers(plugin, components, 'color', op.layers.map((l) => ({ bundle: l.bundle, color: Color(l.color), clear: false })));
        case 'transparency-layers':
            return paintLayers(plugin, components, 'transparency', op.layers);
    }
}

const OVERPAINT_TAG = 'overpaint-controls';
const TRANSPARENCY_TAG = 'transparency-controls';

/**
 * Mol*'s overpaint/transparency helpers add one layer per state update; a distance
 * fade has dozens of levels. This appends them all to each representation's existing
 * node (the same node and tag the helpers use, so clearing works for both) at once.
 */
async function paintLayers(
    plugin: PluginContext,
    components: StructureComponentRef[],
    kind: 'color' | 'transparency',
    layers: ({ bundle: StructureElement.Bundle; color: Color; clear: boolean } | { bundle: StructureElement.Bundle; value: number })[],
): Promise<void> {
    if (layers.length === 0) return;
    const state = plugin.state.data;
    const update = state.build();
    const transformer =
        kind === 'color' ? StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle : StateTransforms.Representation.TransparencyStructureRepresentation3DFromBundle;
    const tag = kind === 'color' ? OVERPAINT_TAG : TRANSPARENCY_TAG;
    for (const c of components) {
        for (const r of c.representations) {
            const structure = (r.cell.obj?.data as { sourceData?: Structure } | undefined)?.sourceData;
            if (!structure) continue;
            const existing = state.select(StateSelection.Generators.ofTransformer(transformer, r.cell.transform.ref).withTag(tag))[0];
            const previous = (existing?.params?.values as { layers?: typeof layers } | undefined)?.layers ?? [];
            const all = [...previous, ...layers];
            const bundle =
                kind === 'color'
                    ? Overpaint.toBundle(Overpaint.filter(Overpaint.merge(Overpaint.ofBundle(all as Overpaint.BundleLayer[], structure.root)), structure) as Overpaint<StructureElement.Loci>)
                    : Transparency.toBundle(Transparency.filter(Transparency.merge(Transparency.ofBundle(all as Transparency.BundleLayer[], structure.root)), structure) as Transparency<StructureElement.Loci>);
            if (existing) update.to(existing).update(bundle as never);
            else update.to(r.cell.transform.ref).apply(transformer as never, bundle as never, { tags: tag });
        }
    }
    await update.commit({ doNotUpdateCurrent: true });
}

export async function replayPaint(plugin: PluginContext, entry: StructureEntry, componentRef: string): Promise<void> {
    if (entry.paint.length === 0) return;
    const structure = structureRefFor(plugin, entry);
    const component = structure?.components.find((c) => c.cell.transform.ref === componentRef);
    if (!component) return;
    for (const op of entry.paint) await applyPaint(plugin, [component], op);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

async function createLayer(viewer: Viewer, structure: StructureRef, entry: StructureEntry, query: StructureSelectionQuery, style: LayerStyle): Promise<void> {
    const plugin = viewer.plugin;
    const component = await plugin.builders.structure.tryCreateComponentFromSelection(structure.cell, query, UUID.create22(), {
        label: `${style.layer} · ${style.style}`,
        tags: layerTags(style),
    });
    if (!component) return;
    const params = representationParams(viewer, component, style, entry);
    await plugin.build().to(component).apply(StateTransforms.Representation.StructureRepresentation3D, params).commit();
    await replayPaint(plugin, entry, component.ref);
}

/** Rebuilds every atoms layer of a structure over the full polymer, keeping its style. */
async function expandAtomsToBackbone(viewer: Viewer, entry: StructureEntry): Promise<void> {
    const plugin = viewer.plugin;
    const structure = structureRefFor(plugin, entry);
    if (!structure || componentsIn(structure, 'ribbon').length > 0) return;
    const atoms = componentsIn(structure, 'atoms');
    if (atoms.length === 0) return;
    // One rebuild per distinct style, over the atoms those components covered.
    const styles = new Map<string, LayerStyle>();
    for (const c of atoms) {
        const style = layerStyleOf(c);
        if (style) styles.set(JSON.stringify(style), style);
    }
    await removeComponents(plugin, atoms);
    for (const style of styles.values()) {
        const fresh = structureRefFor(plugin, entry);
        if (!fresh) return;
        await createLayer(viewer, fresh, entry, layerQuery('atoms', { kind: 'structure', id: entry.info.id }, false), style);
    }
}

async function removeComponents(plugin: PluginContext, components: StructureComponentRef[]): Promise<void> {
    if (components.length === 0) return;
    const builder = plugin.build();
    for (const c of components) builder.delete(c.cell.transform.ref);
    await builder.commit();
}

/** Sets one layer for a target; `null` hides it there (ChimeraX `hide … cartoons|atoms|surfaces`). */
export async function setLayer(viewer: Viewer, target: StyleTarget, layer: Layer, style: LayerStyle | null): Promise<Result<true>> {
    const plugin = viewer.plugin;
    // Changing a layer undoes the explore view: its neighbourhood sticks around as a
    // separate copy of the atoms, which then disagrees with what was just applied.
    clearFocus(viewer);
    if (style && style.layer !== layer) return err('Estilo incompatível com a camada.');
    const structures = targetStructures(viewer, target);
    if (structures.length === 0) return err(target.kind === 'selection' ? 'Nada selecionado.' : 'Estrutura não encontrada.');

    try {
        for (const structure of structures) {
            const entry = entryFor(viewer, structure);
            if (!entry) continue;
            const sameLayer = componentsIn(structure, layer);
            const hasRibbon = componentsIn(structure, 'ribbon').length > 0 || (layer === 'ribbon' && style !== null);
            if (target.kind === 'structure') await removeComponents(plugin, sameLayer);
            else await subtractTarget(plugin, sameLayer, target);
            if (style) {
                const fresh = structureRefFor(plugin, entry) ?? structure;
                await createLayer(viewer, fresh, entry, layerQuery(layer, target, hasRibbon), style);
            }
            // The atoms layer only draws side chains while a ribbon covers the backbone.
            // Hiding the ribbon would otherwise leave the backbone invisible, so the atoms
            // layers are rebuilt over the whole polymer. (Never the other way round: adding
            // a ribbon must not take away atoms the user asked for.)
            if (layer === 'ribbon' && style === null) await expandAtomsToBackbone(viewer, entry);
        }
        return ok(true);
    } catch (e) {
        return err(`Falha ao aplicar o estilo: ${errorMessage(e)}`);
    }
}

/**
 * Opacity of one layer in place — no geometry rebuild, so a slider can drive it.
 * `alpha` is a base geometry parameter, so it works for ribbons and atoms too.
 */
export async function setLayerOpacity(viewer: Viewer, target: StyleTarget, layer: Layer, opacity: number): Promise<Result<true>> {
    const plugin = viewer.plugin;
    try {
        const builder = plugin.build();
        let touched = 0;
        for (const structure of targetStructures(viewer, target)) {
            for (const component of componentsIn(structure, layer)) {
                for (const repr of component.representations) {
                    builder.to(repr.cell).update(StateTransforms.Representation.StructureRepresentation3D, (old) => ({
                        ...old,
                        type: { ...old.type, params: { ...old.type.params, alpha: opacity } },
                    }));
                    touched++;
                }
            }
        }
        if (touched) await builder.commit();
        return ok(true);
    } catch (e) {
        return err(`Falha ao mudar a opacidade: ${errorMessage(e)}`);
    }
}

/** Current opacity of each layer of a structure; a layer that is not shown is absent. */
export function layerOpacities(viewer: Viewer, id: StructureId): Partial<Record<Layer, number>> {
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(viewer.plugin, entry);
    const out: Partial<Record<Layer, number>> = {};
    if (!structure) return out;
    for (const component of componentsIn(structure)) {
        const layer = layerStyleOf(component)!.layer;
        for (const repr of component.representations) {
            const params = repr.cell.transform.params as { type?: { params?: { alpha?: number } } } | undefined;
            const alpha = params?.type?.params?.alpha;
            if (typeof alpha === 'number') out[layer] = Math.min(out[layer] ?? 1, alpha);
        }
    }
    return out;
}

/** Opening look: cartoon for the polymer, sticks for ligands and ions. */
export async function applyDefaultPreset(viewer: Viewer, id: StructureId): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        await createLayer(viewer, structure, entry, layerQuery('ribbon', { kind: 'structure', id }, true), { layer: 'ribbon', style: 'cartoon' });
        const afterRibbon = structureRefFor(plugin, entry) ?? structure;
        await createLayer(viewer, afterRibbon, entry, StructureSelectionQuery('pp ligands', heteroExpression()), { layer: 'atoms', style: 'sticks', size: 1 });
        const created = structureRefFor(plugin, entry);
        if (!created || componentsIn(created).length === 0) return err('A estrutura não contém polímero nem ligante reconhecíveis.');
        return ok(true);
    } catch (e) {
        return err(`Falha ao aplicar a representação inicial: ${errorMessage(e)}`);
    }
}

/** Which layer styles a structure currently shows — the inspector reads it. */
export function layerSummary(viewer: Viewer, id: StructureId): LayerStyle[] {
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(viewer.plugin, entry);
    if (!structure) return [];
    return componentsIn(structure).map((c) => layerStyleOf(c)!);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Re-themes every layer of a structure in one state update. */
export async function refreshColors(viewer: Viewer, id: StructureId): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        const builder = plugin.build();
        for (const component of componentsIn(structure)) {
            const layer = layerStyleOf(component)!.layer;
            const theme = colorThemeFor(viewer, entry, layer);
            const data = component.cell.obj?.data;
            for (const repr of component.representations) {
                builder.to(repr.cell).update(StateTransforms.Representation.StructureRepresentation3D, (old) => ({
                    ...old,
                    colorTheme: createStructureColorThemeParams(plugin, data, old.type.name, theme.color, theme.colorParams),
                }));
            }
        }
        // Tool-drawn atoms (interface side chains) follow the chain colours too.
        const toolTheme = chainCarbonTheme(viewer, entry);
        for (const component of structure.components) {
            if (!component.cell.transform.tags?.includes('pp-interaction-atoms')) continue;
            const data = component.cell.obj?.data;
            for (const repr of component.representations) {
                builder.to(repr.cell).update(StateTransforms.Representation.StructureRepresentation3D, (old) => ({
                    ...old,
                    colorTheme: createStructureColorThemeParams(plugin, data, old.type.name, toolTheme.color, toolTheme.colorParams),
                }));
            }
        }
        await builder.commit();
        return ok(true);
    } catch (e) {
        return err(`Falha ao mudar o esquema de cor: ${errorMessage(e)}`);
    }
}

export async function setColorSettings(viewer: Viewer, id: StructureId, patch: Partial<ColorSettings>): Promise<Result<true>> {
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    entry.color = { ...entry.color, ...patch };
    const result = await refreshColors(viewer, id);
    // The explore view holds its own copy of the atoms: re-theme it too, or the
    // neighbourhood keeps the colours the scene just left behind.
    await refreshFocusView(viewer, id);
    viewer.notify();
    return result;
}

export async function setChainColor(viewer: Viewer, id: StructureId, chain: string, color: number | null): Promise<Result<true>> {
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    if (color === null) delete entry.chainColors[chain];
    else entry.chainColors[chain] = color;
    const result = await refreshColors(viewer, id);
    await refreshFocusView(viewer, id);
    viewer.notify();
    return result;
}

async function paint(viewer: Viewer, target: StyleTarget, make: (bundle: StructureElement.Bundle) => PaintOp): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const structures = targetStructures(viewer, target);
    if (structures.length === 0) return err(target.kind === 'selection' ? 'Nada selecionado.' : 'Estrutura não encontrada.');
    try {
        for (const structure of structures) {
            const entry = entryFor(viewer, structure);
            const bundle = targetBundle(plugin, target, structure);
            if (!entry || !bundle) continue;
            const op = make(bundle);
            entry.paint.push(op);
            await applyPaint(plugin, componentsIn(structure), op);
        }
        return ok(true);
    } catch (e) {
        return err(`Falha ao colorir: ${errorMessage(e)}`);
    }
}

/** ChimeraX `color sel <color>`; `null` returns the target to its scheme colour. */
export function colorTarget(viewer: Viewer, target: StyleTarget, color: number | null): Promise<Result<true>> {
    return paint(viewer, target, (bundle) => ({ kind: 'color', color, bundle }));
}

/** ChimeraX `transparency sel <percent>`, as 0 (opaque) … 1 (invisible). */
export function setTransparency(viewer: Viewer, target: StyleTarget, value: number): Promise<Result<true>> {
    return paint(viewer, target, (bundle) => ({ kind: 'transparency', value, bundle }));
}

/**
 * Makes a target emit light, 0–1. On its own it brightens the atoms; with the bloom
 * pass in emissive mode (look.ts) it glows into the scene, which is what makes a
 * hotspot or an epitope read as "lit from inside".
 */
export function setEmissive(viewer: Viewer, target: StyleTarget, value: number): Promise<Result<true>> {
    return paint(viewer, target, (bundle) => ({ kind: 'emissive', value, bundle, tag: 'emissive' }));
}

/** Removes every glow without touching colours. */
export async function clearEmissive(viewer: Viewer, id: StructureId): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        entry.paint = entry.paint.filter((op) => op.kind !== 'emissive');
        await clearStructureEmissive(plugin, componentsIn(structure));
        return ok(true);
    } catch (e) {
        return err(`Falha ao limpar o brilho: ${errorMessage(e)}`);
    }
}

/** Removes the ops with `tag` and replays the rest — undoing a fade keeps the user's own paint. */
export async function removePaint(viewer: Viewer, id: StructureId, tag: string): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    if (!entry.paint.some((op) => op.tag === tag)) return ok(true);
    try {
        entry.paint = entry.paint.filter((op) => op.tag !== tag);
        const components = componentsIn(structure);
        await clearStructureOverpaint(plugin, components);
        await clearStructureTransparency(plugin, components);
        for (const op of entry.paint) await applyPaint(plugin, components, op);
        return ok(true);
    } catch (e) {
        return err(`Falha ao limpar: ${errorMessage(e)}`);
    }
}

/** Appends a prepared op (built by fade.ts) to a structure's paint log and applies it. */
export async function addPaint(viewer: Viewer, id: StructureId, op: PaintOp): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        entry.paint.push(op);
        await applyPaint(plugin, componentsIn(structure), op);
        return ok(true);
    } catch (e) {
        return err(`Falha ao colorir: ${errorMessage(e)}`);
    }
}

export async function clearPaint(viewer: Viewer, id: StructureId): Promise<Result<true>> {
    const plugin = viewer.plugin;
    const entry = viewer.entry(id);
    const structure = entry && structureRefFor(plugin, entry);
    if (!entry || !structure) return err('Estrutura não encontrada.');
    try {
        entry.paint = [];
        const components = componentsIn(structure);
        await clearStructureOverpaint(plugin, components);
        await clearStructureTransparency(plugin, components);
        await clearStructureEmissive(plugin, components);
        return ok(true);
    } catch (e) {
        return err(`Falha ao limpar as cores: ${errorMessage(e)}`);
    }
}

// ---------------------------------------------------------------------------
// Visibility and removal
// ---------------------------------------------------------------------------

export function setVisible(viewer: Viewer, id: StructureId, visible: boolean): Result<true> {
    const entry = viewer.entry(id);
    if (!entry?.structure.cell) return err('Estrutura não encontrada.');
    try {
        viewer.setHidden(entry.structure.cell.transform.ref, !visible);
        entry.info.visible = visible;
        viewer.notify();
        return ok(true);
    } catch (e) {
        return err(`Falha ao alterar a visibilidade: ${errorMessage(e)}`);
    }
}

export async function removeStructure(viewer: Viewer, id: StructureId): Promise<Result<true>> {
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    try {
        // Everything drawn *about* this structure goes with it. Measurements, overlays and
        // cavity sets live outside its subtree (root, measurement group, own trajectory),
        // so they are collected before the structure's refs disappear.
        const refs = new Set<string>();
        viewer.plugin.state.data.selectQ((q) => q.byRef(entry.trajectory.ref).subtree()).forEach((c) => refs.add(c.transform.ref));
        await dropMeasurementsOf(viewer, refs, id);
        await pruneOverlays(viewer, id);
        await removeCavitiesOf(viewer, id);
        await removePotential(viewer, id);
        // Deleting the trajectory drops everything beneath it in one transaction.
        await viewer.plugin.build().delete(entry.trajectory.ref).commit();
        viewer.entries.delete(id);
        viewer.notify();
        return ok(true);
    } catch (e) {
        return err(`Falha ao remover a estrutura: ${errorMessage(e)}`);
    }
}

const ATOM_REPRS: ReadonlySet<string> = new Set(['ball-and-stick', 'spacefill', 'line']);

/**
 * Shows polar, all or no hydrogens in every atom representation — the user's layers
 * and the interface side chains — and in the explore neighbourhood.
 */
export async function setHydrogenDisplay(viewer: Viewer, mode: HydrogenDisplay): Promise<Result<true>> {
    viewer.hydrogens = mode;
    const plugin = viewer.plugin;
    try {
        const builder = plugin.build();
        for (const entry of viewer.entries.values()) {
            const structure = structureRefFor(plugin, entry);
            for (const component of structure?.components ?? []) {
                for (const repr of component.representations) {
                    const params = repr.cell.transform.params as { type?: { name: string } } | undefined;
                    if (!params?.type || !ATOM_REPRS.has(params.type.name)) continue;
                    builder.to(repr.cell).update(StateTransforms.Representation.StructureRepresentation3D, (old) => ({
                        ...old,
                        type: { ...old.type, params: { ...old.type.params, ignoreHydrogens: undefined, ignoreHydrogensVariant: undefined, ...hydrogenParams(mode) } },
                    }));
                }
            }
        }
        await builder.commit();
        // Keep the neighbourhood in the colours of the structure being explored.
        const focused = plugin.managers.structure.focus.current?.loci.structure;
        await styleFocusView(viewer, (focused && viewer.idOf(focused)) || undefined);
        return ok(true);
    } catch (e) {
        return err(`Falha ao mudar os hidrogênios: ${errorMessage(e)}`);
    }
}

/** Switches the chain palette for the whole viewer and re-themes every structure. */
export async function setChainPalette(viewer: Viewer, palette: ChainPaletteId): Promise<Result<true>> {
    viewer.chainPalette = palette;
    for (const id of viewer.entries.keys()) {
        const r = await refreshColors(viewer, id);
        if (!r.ok) return r;
        await refreshFocusView(viewer, id);
    }
    viewer.notify();
    return ok(true);
}
