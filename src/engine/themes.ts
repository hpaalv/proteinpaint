/**
 * Colour themes Mol* does not ship.
 *
 * - pp-chain-map: colour by auth_asym_id from an explicit map. Mol*'s chain-id theme
 *   orders chains by its internal asym map, which need not match the chain list the
 *   UI shows; an explicit map makes the scene and the chain chips agree by
 *   construction, and carries per-chain overrides and role colours.
 * - pp-residue-class: categorical colour by residue name (charge classes).
 * - pp-hetero: ChimeraX's atom colouring — carbons take any base theme, heteroatoms
 *   are coloured by element. Mol*'s element-symbol only accepts a fixed list of
 *   carbon themes, so this wraps whatever theme the scheme uses.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { ColorTheme, LocationColor } from 'molstar/lib/mol-theme/color';
import type { ThemeDataContext } from 'molstar/lib/mol-theme/theme';
import { Bond, StructureElement, StructureProperties as P, Unit } from 'molstar/lib/mol-model/structure';
import type { Location } from 'molstar/lib/mol-model/location';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition';
import { Color } from 'molstar/lib/mol-util/color';
import { ElementSymbolColors, elementSymbolColor } from 'molstar/lib/mol-theme/color/element-symbol';
import type { ElementSymbol } from 'molstar/lib/mol-model/structure/model/types';

const FALLBACK = Color(0x8a8f98);

/** Element location of either an atom or the first atom of a bond. */
function atomOf(location: Location): StructureElement.Location | null {
    if (StructureElement.Location.is(location)) return location;
    if (Bond.isLocation(location)) {
        return StructureElement.Location.create(location.aStructure, location.aUnit, location.aUnit.elements[location.aIndex]);
    }
    return null;
}

// ---------------------------------------------------------------------------

export const ChainMapParams = {
    colors: PD.Value<Record<string, number>>({}, { isHidden: true }),
    fallback: PD.Color(FALLBACK),
};
type ChainMapParams = typeof ChainMapParams;

function ChainMapTheme(_ctx: ThemeDataContext, props: PD.Values<ChainMapParams>): ColorTheme<ChainMapParams> {
    const map = props.colors;
    const color: LocationColor = (location) => {
        const l = atomOf(location);
        if (!l) return props.fallback;
        const c = map[P.chain.auth_asym_id(l)];
        return c === undefined ? props.fallback : Color(c);
    };
    return { factory: ChainMapTheme, granularity: 'group', color, props, description: 'Cor por cadeia (mapa explícito).' };
}

const ChainMapProvider: ColorTheme.Provider<ChainMapParams, 'pp-chain-map'> = {
    name: 'pp-chain-map',
    label: 'Cadeia (ProteinPaint)',
    category: 'Chain Property',
    factory: ChainMapTheme,
    getParams: () => ChainMapParams,
    defaultValues: PD.getDefaultValues(ChainMapParams),
    isApplicable: () => true,
};

// ---------------------------------------------------------------------------

export const ResidueClassParams = {
    colors: PD.Value<Record<string, number>>({}, { isHidden: true }),
    fallback: PD.Color(FALLBACK),
};
type ResidueClassParams = typeof ResidueClassParams;

function ResidueClassTheme(_ctx: ThemeDataContext, props: PD.Values<ResidueClassParams>): ColorTheme<ResidueClassParams> {
    const map = props.colors;
    const color: LocationColor = (location) => {
        const l = atomOf(location);
        if (!l || !Unit.isAtomic(l.unit)) return props.fallback;
        const c = map[P.atom.label_comp_id(l)];
        return c === undefined ? props.fallback : Color(c);
    };
    return { factory: ResidueClassTheme, granularity: 'group', color, props, description: 'Cor por classe de resíduo.' };
}

const ResidueClassProvider: ColorTheme.Provider<ResidueClassParams, 'pp-residue-class'> = {
    name: 'pp-residue-class',
    label: 'Classe de resíduo',
    category: 'Residue Property',
    factory: ResidueClassTheme,
    getParams: () => ResidueClassParams,
    defaultValues: PD.getDefaultValues(ResidueClassParams),
    isApplicable: () => true,
};

// ---------------------------------------------------------------------------

/**
 * Explicit colour per residue ('A:45' → colour) with a per-chain fallback: the
 * scheme behind every per-residue dataset (Rosetta energies, pydssp, MHCXGraph
 * correspondences). Colours are computed in coloring.ts, so the theme stays dumb.
 */
export const ResidueColorsParams = {
    colors: PD.Value<Record<string, number>>({}, { isHidden: true }),
    chainColors: PD.Value<Record<string, number>>({}, { isHidden: true }),
    fallback: PD.Color(Color(0xd0d4da)),
};
type ResidueColorsParams = typeof ResidueColorsParams;

function ResidueColorsTheme(_ctx: ThemeDataContext, props: PD.Values<ResidueColorsParams>): ColorTheme<ResidueColorsParams> {
    const { colors, chainColors } = props;
    const color: LocationColor = (location) => {
        const l = atomOf(location);
        if (!l) return props.fallback;
        const chain = P.chain.auth_asym_id(l);
        const ins = P.residue.pdbx_PDB_ins_code(l);
        const c = colors[`${chain}:${P.residue.auth_seq_id(l)}${ins || ''}`];
        if (c !== undefined) return Color(c);
        const cc = chainColors[chain];
        return cc === undefined ? props.fallback : Color(cc);
    };
    return { factory: ResidueColorsTheme, granularity: 'group', color, props, description: 'Cor por resíduo (dados).' };
}

const ResidueColorsProvider: ColorTheme.Provider<ResidueColorsParams, 'pp-residue-colors'> = {
    name: 'pp-residue-colors',
    label: 'Dados por resíduo',
    category: 'Residue Property',
    factory: ResidueColorsTheme,
    getParams: () => ResidueColorsParams,
    defaultValues: PD.getDefaultValues(ResidueColorsParams),
    isApplicable: () => true,
};

// ---------------------------------------------------------------------------

export const HeteroParams = {
    base: PD.Value<{ name: string; params: Record<string, unknown> }>({ name: 'uniform', params: {} }, { isHidden: true }),
};
type HeteroParams = typeof HeteroParams;

/** Lighter element colours, as Mol*'s element-symbol default (lightness 0.2), read better next to pastel carbons. */
const ELEMENT_COLORS = ElementSymbolColors;

function createHeteroProvider(plugin: PluginContext): ColorTheme.Provider<HeteroParams, 'pp-hetero'> {
    function HeteroTheme(ctx: ThemeDataContext, props: PD.Values<HeteroParams>): ColorTheme<HeteroParams> {
        const registry = plugin.representation.structure.themes.colorThemeRegistry;
        const base = registry.create(props.base.name, ctx, props.base.params);
        const baseColor: LocationColor = 'color' in base ? base.color : () => FALLBACK;
        const color: LocationColor = (location, isSecondary) => {
            const l = atomOf(location);
            if (l && Unit.isAtomic(l.unit)) {
                const element = l.unit.model.atomicHierarchy.atoms.type_symbol.value(l.element) as ElementSymbol;
                if (element !== 'C') return elementSymbolColor(ELEMENT_COLORS, element);
            }
            return baseColor(location, isSecondary);
        };
        return {
            factory: HeteroTheme,
            granularity: 'group',
            color,
            props,
            description: 'Carbonos pelo esquema, heteroátomos por elemento.',
            contextHash: base.contextHash,
        };
    }
    return {
        name: 'pp-hetero',
        label: 'Carbono pelo esquema',
        category: 'Atom Property',
        factory: HeteroTheme,
        getParams: () => HeteroParams,
        defaultValues: PD.getDefaultValues(HeteroParams),
        isApplicable: () => true,
    };
}

export function registerThemes(plugin: PluginContext): void {
    const registry = plugin.representation.structure.themes.colorThemeRegistry;
    registry.add(ChainMapProvider);
    registry.add(ResidueClassProvider);
    registry.add(ResidueColorsProvider);
    registry.add(createHeteroProvider(plugin));
}
