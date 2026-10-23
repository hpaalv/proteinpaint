/**
 * Chart look. Two themes — the app's dark chrome and the light one figures are
 * printed on — from one set of tokens, so a panel can be designed on screen and
 * exported on white without re-tuning anything.
 *
 * The vocabulary follows the user's Bokeh figures: quiet axes, no chart junk, white
 * outlines on markers, dotted reference lines, colourblind-safe categorical colours
 * and perceptually smooth sequential ramps.
 */

import { CHAIN_PALETTES } from '@/data/palettes';

export type ThemeId = 'dark' | 'light' | 'paper';

export interface ChartTheme {
    id: ThemeId;
    label: string;
    /** Panel background; 'transparent' exports without a backdrop. */
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    axis: string;
    grid: string;
    /** Outline drawn around markers so overlapping points stay readable. */
    markerStroke: string;
    tooltipBg: string;
    tooltipBorder: string;
    reference: string;
}

export const THEMES: Record<ThemeId, ChartTheme> = {
    dark: {
        id: 'dark',
        label: 'Escuro',
        background: '#10151f',
        surface: '#161d2a',
        text: '#e6ecf5',
        textMuted: '#9aa8bf',
        axis: '#2e3a52',
        grid: '#1d2636',
        markerStroke: '#10151f',
        tooltipBg: 'rgba(11,14,20,0.96)',
        tooltipBorder: '#2e3a52',
        reference: '#8c97ad',
    },
    light: {
        id: 'light',
        label: 'Claro',
        background: '#ffffff',
        surface: '#f6f7f9',
        text: '#1d232e',
        textMuted: '#5b6675',
        axis: '#c7cdd6',
        grid: '#e8ebef',
        markerStroke: '#ffffff',
        tooltipBg: 'rgba(255,255,255,0.97)',
        tooltipBorder: '#c7cdd6',
        reference: '#8a93a0',
    },
    paper: {
        id: 'paper',
        label: 'Papel',
        background: '#f6f1e7',
        surface: '#efe8da',
        text: '#2b2a26',
        textMuted: '#6a645a',
        axis: '#cfc6b4',
        grid: '#e5ddcd',
        markerStroke: '#f6f1e7',
        tooltipBg: 'rgba(246,241,231,0.97)',
        tooltipBorder: '#cfc6b4',
        reference: '#8a8275',
    },
};

export const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** Categorical palettes for series, reusing the molecule palettes so a figure reads as one. */
export const SERIES_PALETTES = {
    'okabe-ito': CHAIN_PALETTES['okabe-ito'].colors,
    'tol-bright': CHAIN_PALETTES['tol-bright'].colors,
    'tol-muted': CHAIN_PALETTES['tol-muted'].colors,
    vivid: ['#4CC9F0', '#F72585', '#38D9A9', '#FFB454', '#B197FC', '#FF6B6B', '#63E6BE', '#FFD43B'],
    earth: ['#D8D2C6', '#56B4E9', '#C4C4C4', '#E69F00', '#9FAAB4', '#CC79A7', '#B4AA9F'],
} as const;

export type SeriesPaletteId = keyof typeof SERIES_PALETTES;

/** Sequential and diverging ramps as colour stops; sampled by `ramp()`. */
export const RAMPS = {
    // The user's Bokeh sequential ramp: white → teal-blue → near black.
    ocean: ['#ffffff', '#c6dbef', '#4292c6', '#08519c', '#082446'],
    viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
    magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
    cividis: ['#00224e', '#35456c', '#666970', '#a08f65', '#fdea45'],
    warm: ['#fff7ec', '#fdd49e', '#fc8d59', '#d7301f', '#7f0000'],
    // Diverging, for signed quantities (Δ, correlation, retention around 1).
    'blue-red': ['#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b'],
    'teal-brown': ['#01665e', '#80cdc1', '#f5f5f5', '#dfc27d', '#8c510a'],
} as const;

export type RampId = keyof typeof RAMPS;

export const DIVERGING: RampId[] = ['blue-red', 'teal-brown'];

const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** Colour at t ∈ [0,1] along a ramp, interpolated in sRGB (matches the Bokeh version). */
export function ramp(id: RampId, t: number): string {
    const stops = RAMPS[id];
    const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const a = hex(stops[i]!);
    const b = hex(stops[i + 1]!);
    const to = (k: number) => Math.round(a[k]! + (b[k]! - a[k]!) * f);
    return `#${[0, 1, 2].map((k) => to(k).toString(16).padStart(2, '0')).join('')}`;
}

/** ECharts `visualMap`/`heatmap` want a list of colours. */
export function rampColors(id: RampId, n = 32): string[] {
    return Array.from({ length: n }, (_, i) => ramp(id, i / (n - 1)));
}

export function seriesColor(palette: SeriesPaletteId, index: number): string {
    const colors = SERIES_PALETTES[palette];
    return colors[((index % colors.length) + colors.length) % colors.length]!;
}

/** Translucent version of a colour, for bands and unselected points. */
export function alpha(color: string, a: number): string {
    const [r, g, b] = hex(color);
    return `rgba(${r},${g},${b},${a})`;
}
