/**
 * Molecule colours — kept separate from UI chrome colours (src/ui/theme).
 *
 * Categorical palettes are colourblind-safe; continuous ramps are perceptually
 * uniform. No jet/rainbow for data, by policy (the N→C "rainbow" scheme is a
 * positional guide, not a data ramp, and uses a uniform-lightness palette).
 */

import type { InteractionKind, RampId } from '@/engine/types';

export type ChainPaletteId = 'okabe-ito' | 'tol-bright' | 'tol-muted' | 'chimerax' | 'pastel-figure' | 'mono-accent';

export interface ChainPalette {
    id: ChainPaletteId;
    label: string;
    note: string;
    colors: readonly string[];
}

export const CHAIN_PALETTES: Record<ChainPaletteId, ChainPalette> = {
    'okabe-ito': {
        id: 'okabe-ito',
        label: 'Okabe–Ito',
        note: 'Seguro para daltonismo, 7 cores.',
        // The palette's eighth colour is black, which vanishes on dark backgrounds.
        colors: ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'],
    },
    'tol-bright': {
        id: 'tol-bright',
        label: 'Tol Bright',
        note: 'Seguro para daltonismo, saturado.',
        colors: ['#4477AA', '#EE6677', '#228833', '#CCBB44', '#66CCEE', '#AA3377', '#BBBBBB'],
    },
    'tol-muted': {
        id: 'tol-muted',
        label: 'Tol Muted',
        note: 'Dessaturado — combina com superfícies transparentes.',
        colors: ['#332288', '#88CCEE', '#44AA99', '#117733', '#999933', '#DDCC77', '#CC6677', '#882255', '#AA4499'],
    },
    chimerax: {
        id: 'chimerax',
        label: 'ChimeraX',
        note: 'As cores de cadeia que quem vem do ChimeraX já conhece.',
        colors: ['#D2B48C', '#87CEEB', '#F08080', '#90EE90', '#DDA0DD', '#F0E68C', '#B0C4DE', '#FFA07A'],
    },
    'pastel-figure': {
        id: 'pastel-figure',
        label: 'Figura (cdr_panels)',
        note: 'Tons de papel e cinzas quentes dos seus painéis de pMHC.',
        colors: ['#D8D2C6', '#56B4E9', '#C4C4C4', '#E69F00', '#9FAAB4', '#CC79A7', '#B4AA9F'],
    },
    'mono-accent': {
        id: 'mono-accent',
        label: 'Mono + destaque',
        note: 'Alvo em cinza, binder na cor de destaque. O preset mais útil para figuras de design.',
        colors: ['#4CC9F0', '#A7AFB9'],
    },
};

export const DEFAULT_CHAIN_PALETTE: ChainPaletteId = 'okabe-ito';

/** Colours for the chain-role scheme: what a design figure usually wants. */
export const ROLE_COLORS = {
    binder: '#4CC9F0',
    target: '#B8BEC6',
    mhc: '#D8D2C6',
    b2m: '#9AA3AE',
    peptide: '#F72585',
    ligand: '#FFB454',
    unassigned: '#8A8F98',
} as const;

/** AlphaFold DB confidence bands — the published scale, do not substitute. */
export const PLDDT_BANDS = [
    { min: 90, max: 100, color: '#0053D6', label: 'Muito alto (≥90)' },
    { min: 70, max: 90, color: '#65CBF3', label: 'Alto (70–90)' },
    { min: 50, max: 70, color: '#FFDB13', label: 'Baixo (50–70)' },
    { min: 0, max: 50, color: '#FF7D45', label: 'Muito baixo (<50)' },
] as const;

/** Perceptually uniform ramps, 9 stops, low → high. */
export const CONTINUOUS_RAMPS: Record<RampId, readonly string[]> = {
    viridis: ['#440154', '#472D7B', '#3B528B', '#2C728E', '#21918C', '#28AE80', '#5EC962', '#ADDC30', '#FDE725'],
    cividis: ['#00204D', '#00336F', '#39486B', '#575D6D', '#707173', '#8A8779', '#A69D75', '#C4B56C', '#FFEA46'],
    magma: ['#000004', '#1C1044', '#4F127B', '#812581', '#B5367A', '#E55064', '#FB8761', '#FEC287', '#FCFDBF'],
    inferno: ['#000004', '#1F0C48', '#550F6D', '#88226A', '#BA3655', '#E35933', '#F98C0A', '#F9C932', '#FCFFA4'],
    'blue-white-red': ['#2166AC', '#4393C3', '#92C5DE', '#D1E5F0', '#F7F7F7', '#FDDBC7', '#F4A582', '#D6604D', '#B2182B'],
    /** ChimeraX `palette red:white:blue` — electrostatics and contact-frequency figures. */
    'red-white-blue': ['#B2182B', '#D6604D', '#F4A582', '#FDDBC7', '#F7F7F7', '#D1E5F0', '#92C5DE', '#4393C3', '#2166AC'],
    'white-blue': ['#F7FBFF', '#DEEBF7', '#C6DBEF', '#9ECAE1', '#6BAED6', '#4292C6', '#2171B5', '#08519C', '#08306B'],
    'white-red': ['#FFF5F0', '#FEE0D2', '#FCBBA1', '#FC9272', '#FB6A4A', '#EF3B2C', '#CB181D', '#A50F15', '#67000D'],
};

export const RAMP_LABELS: Record<RampId, string> = {
    viridis: 'Viridis',
    cividis: 'Cividis',
    magma: 'Magma',
    inferno: 'Inferno',
    'blue-white-red': 'Azul–branco–vermelho',
    'red-white-blue': 'Vermelho–branco–azul',
    'white-red': 'Branco–vermelho',
    'white-blue': 'Branco–azul',
};

/** Kyte–Doolittle ramp, hydrophilic → hydrophobic (white → orange, as in ChimeraX mlp-ish figures). */
export const HYDROPHOBICITY_RAMP = ['#3B6FB6', '#8FB3DE', '#F2F2F2', '#F4B678', '#D9631E'] as const;

/** Positional N→C guide: lightness-balanced, not a data ramp. */
export const RAINBOW_RAMP = ['#3B4CC0', '#4F9BD9', '#3CBFA0', '#9BCB5A', '#F2C14E', '#EE7D3B', '#D0453A'] as const;

/**
 * Interaction styling, fixed across the app. Dash count carries the same information
 * as colour, so the display stays readable without colour discrimination.
 */
export const INTERACTION_STYLES: Record<InteractionKind, { color: string; dashes: number; radius: number; label: string }> = {
    'hydrogen-bond': { color: '#3FC7F5', dashes: 6, radius: 0.07, label: 'Ligação de H' },
    'weak-hydrogen-bond': { color: '#9ED9EE', dashes: 8, radius: 0.04, label: 'Ligação de H fraca' },
    'salt-bridge': { color: '#F72585', dashes: 4, radius: 0.1, label: 'Ponte salina' },
    hydrophobic: { color: '#A3A86B', dashes: 10, radius: 0.05, label: 'Hidrofóbico' },
    'pi-stacking': { color: '#3DDC84', dashes: 5, radius: 0.09, label: 'Empilhamento π' },
    'cation-pi': { color: '#FF9F1C', dashes: 5, radius: 0.09, label: 'Cátion–π' },
    'halogen-bond': { color: '#B07CF7', dashes: 6, radius: 0.07, label: 'Halogênio' },
    metal: { color: '#C0C0C0', dashes: 1, radius: 0.08, label: 'Metal' },
};

/** Swatches for painting a selection (ChimeraX `color sel …`). */
export const PAINT_SWATCHES = [
    '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#F72585',
    '#4CC9F0', '#7C6CFF', '#FFFFFF', '#D8D2C6', '#B8BEC6', '#6B7280', '#303030',
] as const;

export function hexToInt(hex: string): number {
    return parseInt(hex.replace('#', ''), 16);
}

export function intToHex(n: number): string {
    return `#${n.toString(16).padStart(6, '0').toUpperCase()}`;
}
