/**
 * The statistics the figures need, computed in the renderer: quantiles and KDE for
 * violins, histogram bins, correlation, a least-squares fit for trend lines and the
 * cumulative gate counts a funnel draws.
 *
 * Everything takes plain number arrays and returns plain data, so the chart builders
 * stay about drawing.
 */

export interface Quartiles {
    min: number;
    q1: number;
    median: number;
    q3: number;
    max: number;
    /** Tukey whiskers: furthest point within 1.5 IQR. */
    lower: number;
    upper: number;
    outliers: number[];
    mean: number;
    n: number;
}

export const finite = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null && Number.isFinite(x));

/** Linear-interpolated quantile of a sorted array (the "type 7" of R and numpy). */
export function quantileSorted(sorted: number[], p: number): number {
    if (sorted.length === 0) return NaN;
    if (sorted.length === 1) return sorted[0]!;
    const h = (sorted.length - 1) * Math.max(0, Math.min(1, p));
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (h - lo);
}

export function quartiles(values: number[]): Quartiles | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const q1 = quantileSorted(s, 0.25);
    const median = quantileSorted(s, 0.5);
    const q3 = quantileSorted(s, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    const inside = s.filter((v) => v >= lowFence && v <= highFence);
    return {
        min: s[0]!,
        q1,
        median,
        q3,
        max: s[s.length - 1]!,
        lower: inside.length ? inside[0]! : s[0]!,
        upper: inside.length ? inside[inside.length - 1]! : s[s.length - 1]!,
        outliers: s.filter((v) => v < lowFence || v > highFence),
        mean: s.reduce((a, b) => a + b, 0) / s.length,
        n: s.length,
    };
}

export function mean(values: number[]): number {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

export function stdev(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** Standard error of the mean — the band the reference figures draw around a curve. */
export function sem(values: number[]): number {
    return values.length ? stdev(values) / Math.sqrt(values.length) : 0;
}

// ---------------------------------------------------------------------------
// Density
// ---------------------------------------------------------------------------

/** Silverman's rule of thumb, the bandwidth scipy's gaussian_kde defaults to. */
function bandwidth(values: number[]): number {
    const n = values.length;
    const s = stdev(values);
    const sorted = [...values].sort((a, b) => a - b);
    const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
    const spread = Math.min(s || Infinity, (iqr || Infinity) / 1.349);
    const h = 0.9 * (Number.isFinite(spread) ? spread : s) * Math.pow(n, -0.2);
    return h > 0 ? h : 1e-6;
}

export interface Density {
    grid: number[];
    /** Density at each grid point, normalised so the maximum is 1. */
    values: number[];
    bandwidth: number;
}

/**
 * Gaussian KDE on a regular grid over the data's own range, as the violins in
 * analysis_part1.py do. Returns null when there is too little to smooth.
 */
export function kde(values: number[], points = 96, clamp?: [number, number]): Density | null {
    if (values.length < 3) return null;
    const lo0 = Math.min(...values);
    const hi0 = Math.max(...values);
    if (!(hi0 > lo0)) return null;
    const h = bandwidth(values);
    // Extend a little past the data so the violin closes instead of being cut flat.
    const lo = Math.max(clamp?.[0] ?? -Infinity, lo0 - h);
    const hi = Math.min(clamp?.[1] ?? Infinity, hi0 + h);
    const grid: number[] = [];
    const dens: number[] = [];
    const norm = 1 / (values.length * h * Math.sqrt(2 * Math.PI));
    for (let i = 0; i < points; i++) {
        const x = lo + ((hi - lo) * i) / (points - 1);
        let sum = 0;
        for (const v of values) {
            const z = (x - v) / h;
            sum += Math.exp(-0.5 * z * z);
        }
        grid.push(x);
        dens.push(sum * norm);
    }
    const peak = Math.max(...dens);
    return peak > 0 ? { grid, values: dens.map((d) => d / peak), bandwidth: h } : null;
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export interface Bins {
    /** Bin centres. */
    centers: number[];
    counts: number[];
    width: number;
    edges: number[];
}

/** Freedman–Diaconis bin count, capped — what looks right for a few hundred designs. */
export function binCount(values: number[]): number {
    if (values.length < 4) return Math.max(1, values.length);
    const s = [...values].sort((a, b) => a - b);
    const iqr = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
    const width = iqr > 0 ? (2 * iqr) / Math.cbrt(values.length) : 0;
    const span = s[s.length - 1]! - s[0]!;
    const n = width > 0 && span > 0 ? Math.ceil(span / width) : Math.ceil(Math.sqrt(values.length));
    return Math.max(5, Math.min(40, n));
}

export function histogram(values: number[], bins?: number, domain?: [number, number]): Bins {
    const n = bins && bins > 0 ? bins : binCount(values);
    const lo = domain?.[0] ?? Math.min(...values);
    const hi = domain?.[1] ?? Math.max(...values);
    const span = hi > lo ? hi - lo : 1;
    const width = span / n;
    const counts = new Array<number>(n).fill(0);
    for (const v of values) {
        // The last bin is closed on the right, so the maximum is counted.
        const i = Math.min(n - 1, Math.max(0, Math.floor((v - lo) / width)));
        counts[i]!++;
    }
    const edges = Array.from({ length: n + 1 }, (_, i) => lo + i * width);
    return { centers: Array.from({ length: n }, (_, i) => lo + (i + 0.5) * width), counts, width, edges };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export function pearson(xs: number[], ys: number[]): number {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return NaN;
    const mx = mean(xs.slice(0, n));
    const my = mean(ys.slice(0, n));
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i]! - mx;
        const dy = ys[i]! - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** Spearman: Pearson on ranks, with ties averaged. */
export function spearman(xs: number[], ys: number[]): number {
    const rank = (v: number[]) => {
        const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
        const r = new Array<number>(v.length);
        let i = 0;
        while (i < order.length) {
            let j = i;
            while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
            const avg = (i + j) / 2 + 1;
            for (let k = i; k <= j; k++) r[order[k]![1]] = avg;
            i = j + 1;
        }
        return r;
    };
    const n = Math.min(xs.length, ys.length);
    return n < 3 ? NaN : pearson(rank(xs.slice(0, n)), rank(ys.slice(0, n)));
}

export interface Fit {
    slope: number;
    intercept: number;
    r: number;
    /** Two endpoints spanning the data, ready to draw. */
    line: [[number, number], [number, number]];
}

export function linearFit(xs: number[], ys: number[]): Fit | null {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return null;
    const mx = mean(xs.slice(0, n));
    const my = mean(ys.slice(0, n));
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i]! - mx) * (ys[i]! - my);
        sxx += (xs[i]! - mx) ** 2;
    }
    if (sxx <= 0) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const lo = Math.min(...xs.slice(0, n));
    const hi = Math.max(...xs.slice(0, n));
    return { slope, intercept, r: pearson(xs.slice(0, n), ys.slice(0, n)), line: [[lo, slope * lo + intercept], [hi, slope * hi + intercept]] };
}

// ---------------------------------------------------------------------------
// Jitter
// ---------------------------------------------------------------------------

/**
 * Deterministic jitter in [-1, 1] from a string key: strip plots and categorical
 * scatters must not reshuffle on every render.
 */
export function hashJitter(key: string): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * Beeswarm offsets: points at a similar value are pushed sideways just enough not to
 * overlap, which reads far better than random jitter for a few hundred designs.
 */
export function swarmOffsets(values: number[], span: number, markerSpan: number): number[] {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const offsets = new Array<number>(values.length).fill(0);
    const placed: { v: number; o: number }[] = [];
    for (const [v, i] of order) {
        // Only neighbours within one marker height can collide.
        const near = placed.filter((p) => Math.abs(p.v - v) < markerSpan);
        let o = 0;
        for (let step = 0; step < 64; step++) {
            const candidate = step === 0 ? 0 : (step % 2 ? 1 : -1) * Math.ceil(step / 2) * markerSpan;
            if (Math.abs(candidate) > span) break;
            if (!near.some((p) => Math.abs(p.o - candidate) < markerSpan * 0.92)) {
                o = candidate;
                break;
            }
        }
        offsets[i] = o;
        placed.push({ v, o });
    }
    return offsets;
}
