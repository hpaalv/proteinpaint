/**
 * Colour schemes → Mol* colour themes.
 *
 * Every scheme resolves to one theme name + params. The atoms layer wraps it in
 * pp-hetero so carbons follow the scheme and heteroatoms show their element, which
 * is how side chains read in ChimeraX figures.
 */

import { Color } from 'molstar/lib/mol-util/color';
import {
    CHAIN_PALETTES,
    CONTINUOUS_RAMPS,
    HYDROPHOBICITY_RAMP,
    RAINBOW_RAMP,
    ROLE_COLORS,
    hexToInt,
} from '@/data/palettes';
import type { StructureEntry, Viewer } from './viewer';
import type { ColorScheme, Layer, RampId, ResidueDataset } from './types';

/** Linear interpolation over a ramp's stops; t in [0, 1]. */
export function rampColor(ramp: RampId, t: number): number {
    const stops = CONTINUOUS_RAMPS[ramp].map(hexToInt);
    const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const ch = (v: number, s: number) => (v >> s) & 0xff;
    const mix = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * f);
    return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * Colour range of a dataset.
 *
 * The range covers the central 96% of the values, not their extremes. Per-residue
 * Rosetta energies are long-tailed — one clashing residue at +90 REU against a
 * cloud around zero — and a min/max range mapped every other residue to the middle
 * of the ramp, which is why colouring by a metric looked like it did nothing.
 */
export function datasetDomain(d: ResidueDataset): [number, number] {
    if (d.domain) return d.domain;
    const nums = Object.values(d.values).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (nums.length === 0) return [0, 1];
    const sorted = [...nums].sort((a, b) => a - b);
    const at = (p: number) => {
        const h = (sorted.length - 1) * p;
        const i = Math.floor(h);
        const j = Math.min(sorted.length - 1, i + 1);
        return sorted[i]! + (sorted[j]! - sorted[i]!) * (h - i);
    };
    let lo = at(0.02);
    let hi = at(0.98);
    // Diverging ramps read as signed: centre them on zero.
    if (d.ramp === 'blue-white-red' || d.ramp === 'red-white-blue') {
        const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
        lo = -m;
        hi = m;
    }
    return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
}

/** True when the colour range leaves values outside it (the legend says so). */
export function datasetClipped(d: ResidueDataset): boolean {
    const [lo, hi] = datasetDomain(d);
    return Object.values(d.values).some((v) => typeof v === 'number' && Number.isFinite(v) && (v < lo - 1e-9 || v > hi + 1e-9));
}

/** Residue key → colour for a dataset. */
export function datasetColors(d: ResidueDataset): Record<string, number> {
    if (d.kind === 'explicit') return { ...(d.colors ?? {}) };
    const out: Record<string, number> = {};
    if (d.kind === 'categorical') {
        for (const [k, v] of Object.entries(d.values)) {
            const c = d.colors?.[String(v)];
            if (c !== undefined) out[k] = c;
        }
        return out;
    }
    const [lo, hi] = datasetDomain(d);
    const ramp = d.ramp ?? 'viridis';
    for (const [k, v] of Object.entries(d.values)) {
        // Values past the ends take the end colour instead of disappearing.
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = rampColor(ramp, Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
    }
    return out;
}

export interface ColorThemeSpec {
    color: string;
    colorParams?: Record<string, unknown>;
}

const toColors = (hexes: readonly string[]) => hexes.map((h) => Color(hexToInt(h)));

/** Chain colour actually used for one chain — the UI swatches read the same function. */
export function chainColor(viewer: Viewer, entry: StructureEntry, chain: string): number {
    const override = entry.chainColors[chain];
    if (override !== undefined) return override;
    if (entry.color.scheme === 'role') {
        const role = entry.info.chains.find((c) => c.authAsymId === chain)?.role ?? 'unassigned';
        return hexToInt(ROLE_COLORS[role]);
    }
    const palette = CHAIN_PALETTES[viewer.chainPalette].colors;
    const index = entry.info.chains.findIndex((c) => c.authAsymId === chain);
    // mono-accent: the binder (or first chain) gets the accent, everything else grey.
    if (viewer.chainPalette === 'mono-accent') {
        const hasBinder = entry.info.chains.some((c) => c.role === 'binder');
        const isAccent = hasBinder
            ? entry.info.chains[index]?.role === 'binder'
            : index === 0;
        return hexToInt(palette[isAccent ? 0 : 1]!);
    }
    return hexToInt(palette[Math.max(0, index) % palette.length]!);
}

/** auth_asym_id → colour, as the scene and the chain chips show it. */
export function chainMap(viewer: Viewer, entry: StructureEntry): Record<string, number> {
    const map: Record<string, number> = {};
    for (const c of entry.info.chains) map[c.authAsymId] = chainColor(viewer, entry, c.authAsymId);
    return map;
}

/** Charge classes: acidic red, basic blue, polar green, apolar near-white. */
const CHARGE_CLASSES: Record<string, string> = {
    ASP: '#E8505B', GLU: '#E8505B',
    LYS: '#3D7DD8', ARG: '#3D7DD8', HIS: '#8FB3E8',
    SER: '#B9D9A6', THR: '#B9D9A6', ASN: '#B9D9A6', GLN: '#B9D9A6', TYR: '#B9D9A6', CYS: '#E9D98B',
    ALA: '#E3E3E3', VAL: '#E3E3E3', LEU: '#E3E3E3', ILE: '#E3E3E3', MET: '#E3E3E3',
    PHE: '#D0D0D0', TRP: '#D0D0D0', PRO: '#E3E3E3', GLY: '#F5F5F5',
};

const SECONDARY_COLORS = {
    alphaHelix: Color(0xe8607a),
    threeTenHelix: Color(0xf29bab),
    piHelix: Color(0xe8607a),
    betaTurn: Color(0xc9ced6),
    betaStrand: Color(0xf3c04f),
    coil: Color(0xc9ced6),
    bend: Color(0xc9ced6),
    turn: Color(0xc9ced6),
    dna: Color(0xae81ff),
    rna: Color(0xfd971f),
    carbohydrate: Color(0xa6e22e),
};

function schemeTheme(viewer: Viewer, entry: StructureEntry, scheme: ColorScheme): ColorThemeSpec {
    const settings = entry.color;
    switch (scheme) {
        case 'chain':
        case 'role':
            return { color: 'pp-chain-map', colorParams: { colors: chainMap(viewer, entry) } };
        case 'entity': {
            const palette = CHAIN_PALETTES[viewer.chainPalette].colors;
            return { color: 'uniform', colorParams: { value: Color(hexToInt(palette[viewer.entityIndex(entry.info.id) % palette.length]!)) } };
        }
        case 'uniform':
            return { color: 'uniform', colorParams: { value: Color(settings.uniform) } };
        case 'secondary-structure':
            return { color: 'secondary-structure', colorParams: { colors: { name: 'custom', params: SECONDARY_COLORS } } };
        case 'element':
            return { color: 'element-symbol', colorParams: { carbonColor: { name: 'element-symbol', params: {} } } };
        case 'b-factor': {
            // Mol*'s uncertainty theme reverses the list; feed it backwards so low = first stop.
            const list = toColors(CONTINUOUS_RAMPS[settings.ramp]).reverse();
            return {
                color: 'uncertainty',
                colorParams: { domain: settings.domain ?? entry.info.bfactorRange, list: { kind: 'interpolate', colors: list } },
            };
        }
        case 'plddt':
            return { color: 'plddt-confidence' };
        case 'hydrophobicity':
            return {
                color: 'hydrophobicity',
                colorParams: { scale: 'DGwif', list: { kind: 'interpolate', colors: toColors(HYDROPHOBICITY_RAMP) } },
            };
        case 'residue-charge': {
            const colors: Record<string, number> = {};
            for (const [k, v] of Object.entries(CHARGE_CLASSES)) colors[k] = hexToInt(v);
            return { color: 'pp-residue-class', colorParams: { colors } };
        }
        case 'rainbow':
            return { color: 'sequence-id', colorParams: { list: { kind: 'interpolate', colors: toColors(RAINBOW_RAMP) } } };
        case 'residue-name':
            return { color: 'residue-name' };
        case 'data': {
            const d = settings.dataset ? entry.datasets.get(settings.dataset) : undefined;
            return {
                color: 'pp-residue-colors',
                colorParams: {
                    colors: d ? datasetColors(d) : {},
                    chainColors: settings.dataFallback === 'chain' ? chainMap(viewer, entry) : {},
                },
            };
        }
    }
}

/** Schemes that are already per-atom; wrapping them would hide their meaning on carbons only. */
const ATOMIC_SCHEMES: ReadonlySet<ColorScheme> = new Set(['element', 'b-factor', 'plddt']);

export function colorThemeFor(viewer: Viewer, entry: StructureEntry, layer: Layer): ColorThemeSpec {
    const base = schemeTheme(viewer, entry, entry.color.scheme);
    if (layer !== 'atoms' || !entry.color.heteroatomsByElement || ATOMIC_SCHEMES.has(entry.color.scheme)) return base;
    return { color: 'pp-hetero', colorParams: { base: { name: base.color, params: base.colorParams ?? {} } } };
}

/**
 * Atoms drawn by a tool rather than by a layer (interface side chains): carbons in
 * whatever colour the structure's ribbon has, heteroatoms by element — always, so a
 * side chain reads as part of its chain whatever the user set for atom layers.
 */
export function chainCarbonTheme(viewer: Viewer, entry: StructureEntry): ColorThemeSpec {
    const base = schemeTheme(viewer, entry, entry.color.scheme);
    if (ATOMIC_SCHEMES.has(entry.color.scheme)) return base;
    return { color: 'pp-hetero', colorParams: { base: { name: base.color, params: base.colorParams ?? {} } } };
}

export const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
    chain: 'Cadeia',
    role: 'Papel (binder/alvo)',
    entity: 'Estrutura',
    uniform: 'Cor única',
    'secondary-structure': 'Estrutura secundária',
    element: 'Elemento',
    'b-factor': 'B-factor',
    plddt: 'pLDDT',
    hydrophobicity: 'Hidrofobicidade',
    'residue-charge': 'Carga do resíduo',
    rainbow: 'Arco-íris N→C',
    'residue-name': 'Tipo de resíduo',
    data: 'Dados calculados',
};
