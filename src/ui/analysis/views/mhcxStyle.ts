/**
 * MHCXGraph's dashboard look, ported from its assets (assets/dashboard/js/data.js,
 * graph.js, viewer.js in MHCXGraph 1.0.0): the same palettes, the same HSL family
 * extension for many groups, residue-class colours, chain colours and the std-based
 * edge colouring — so figures match what the MHCXGraph dashboard shows.
 */

export const GRAPH_PALETTES: Record<string, string[]> = {
    standard: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
    colorblind: ['#E69F00', '#56B4E9', '#009E73', '#0072B2', '#CC79A7', '#999999', '#000000'],
    high_contrast: ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe'],
};

export const PALETTE_LABELS: Record<string, string> = { standard: 'Padrão', colorblind: 'Daltonismo (padrão do MHCXGraph)', high_contrast: 'Alto contraste' };

export const RESIDUE_CLASSES: Record<string, string> = {
    ALA: 'Hydrophobic', VAL: 'Hydrophobic', ILE: 'Hydrophobic', LEU: 'Hydrophobic', MET: 'Hydrophobic', PHE: 'Hydrophobic', TYR: 'Hydrophobic', TRP: 'Hydrophobic',
    SER: 'Polar', THR: 'Polar', ASN: 'Polar', GLN: 'Polar', CYS: 'Polar',
    ARG: 'Charged (+)', HIS: 'Charged (+)', LYS: 'Charged (+)',
    ASP: 'Charged (-)', GLU: 'Charged (-)',
    GLY: 'Special', PRO: 'Special',
};

export const CLASS_COLORS: Record<string, string> = {
    Hydrophobic: '#4CAF50', Polar: '#2196F3', 'Charged (+)': '#3F51B5', 'Charged (-)': '#F44336', Special: '#FF9800', Unknown: '#9E9E9E',
};

export const CLASS_LABELS_PT: Record<string, string> = {
    Hydrophobic: 'Hidrofóbico', Polar: 'Polar', 'Charged (+)': 'Carga +', 'Charged (-)': 'Carga −', Special: 'Especial (G/P)', Unknown: 'Outro',
};

/** Chain colours of the 3D panels, dark theme. */
export const MOL_DEFAULTS_DARK = ['#FFC107', '#4FC3F7', '#69F0AE', '#FF8A65', '#E040FB', '#CDDC39', '#448AFF', '#18FFFF'];
export const MOL_DEFAULTS_LIGHT = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#17becf'];

export const WATER_COLOR = '#e53935';
export const EDGE_DEFAULT = '#9ca3af';

function hexToHsl(hex: string): { h: number; s: number; l: number } {
    let x = hex.replace('#', '');
    if (x.length === 3) x = x.split('').map((c) => c + c).join('');
    const r = parseInt(x.slice(0, 2), 16) / 255;
    const g = parseInt(x.slice(2, 4), 16) / 255;
    const b = parseInt(x.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let [r, g, b] = [0, 0, 0];
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function variants(hex: string): string[] {
    const { h, s, l } = hexToHsl(hex);
    const vs = [
        { dh: 0, ds: 0, dl: 0 },
        { dh: 0, ds: 0, dl: -18 },
        { dh: 0, ds: 0, dl: 18 },
        { dh: 8, ds: -5, dl: -10 },
        { dh: -8, ds: -5, dl: 10 },
    ];
    return vs.map((v) => hslToHex((h + v.dh + 360) % 360, clamp(s + v.ds, 35, 90), clamp(l + v.dl, 25, 80)));
}

/** MHCXGraph's buildExtendedPalette: cycle families, then their lighter/darker variants. */
export function extendedPalette(name: string, needed: number): string[] {
    const base = GRAPH_PALETTES[name] ?? GRAPH_PALETTES.colorblind!;
    const families = base.map(variants);
    const out: string[] = [];
    const seen = new Set<string>();
    for (let layer = 0; out.length < needed && layer < 5; layer++) {
        for (const fam of families) {
            if (out.length >= needed) break;
            const c = fam[layer];
            if (c && !seen.has(c)) {
                seen.add(c);
                out.push(c);
            }
        }
    }
    while (out.length < needed) out.push(base[out.length % base.length]!);
    return out;
}

/** Group → colour, groups sorted as the dashboard does. */
export function groupColors(groups: string[], palette: string): Record<string, string> {
    const unique = [...new Set(groups)].sort();
    const pal = extendedPalette(palette, unique.length);
    const out: Record<string, string> = {};
    unique.forEach((g, i) => (out[g] = pal[i % pal.length]!));
    return out;
}

/** The dashboard's std edge colour: green (consistent) → red (variable). */
export function stdColor(std: number | null, threshold: number): string {
    if (std === null || std === undefined || Number.isNaN(std)) return '#d1d5db';
    const ratio = clamp(std / (threshold + 0.0001), 0, 1);
    return `hsl(${120 * (1 - ratio)}, 100%, 45%)`;
}

export function residueClass(resn: string): string {
    return RESIDUE_CLASSES[resn.toUpperCase()] ?? 'Unknown';
}
