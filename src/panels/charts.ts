/**
 * ChartSpec → ECharts option.
 *
 * One builder per chart type, all sharing the same axes, tooltip and legend styling,
 * so a panel of six different charts still reads as one figure. The vocabulary
 * follows the user's Bokeh figures (analysis_part1.py): quiet axes, white-outlined
 * markers, dotted reference lines, KDE violins with a quartile bar and a median dot,
 * value labels over bars, sequential ramps with a colour bar.
 *
 * Every point carries its row id, so clicking a mark selects that design and the 3D
 * cells follow it.
 */

import type { EChartsOption } from 'echarts';
import type { Dataset, DatasetRow } from '@/dataset/types';
import { column, numberOf, stringOf } from '@/dataset/types';
import {
    binCount,
    finite,
    histogram,
    kde,
    linearFit,
    mean,
    pearson,
    quantileSorted,
    quartiles,
    sem,
    spearman,
    swarmOffsets,
} from './stats';
import { alpha, FONT, MONO, ramp, rampColors, seriesColor, THEMES, type ChartTheme } from './theme';
import { CHART_TYPES, DEFAULT_CHART, type Aggregate, type ChartSpec, type Gate } from './types';

export interface ChartContext {
    dataset: Dataset;
    /** Rows after the global filters. */
    rows: DatasetRow[];
    /** Selected row ids; non-empty dims everything else. */
    selection: Set<string>;
    /** Row under the cursor anywhere in the app. */
    hovered: string | null;
    theme: ChartTheme;
    /** Scales every font size — small cells need smaller type. */
    fontScale: number;
    /** Hides legends and axis names in a very small cell. */
    compact: boolean;
    /** The panel letters the cell's top-left corner, so the title starts further right. */
    lettered?: boolean;
}

export interface BuiltChart {
    option: EChartsOption;
    /** Why the chart is empty, when it is. */
    empty: string | null;
}

const labelOf = (d: Dataset, key: string | undefined, fallback = ''): string => {
    const c = column(d, key);
    return c ? (c.unit ? `${c.label} (${c.unit})` : c.label) : fallback;
};

const fmt = (v: number, digits = 3): string => {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    if (a >= 10) return v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    if (a === 0) return '0';
    return v.toLocaleString('pt-BR', { maximumSignificantDigits: digits });
};

// ---------------------------------------------------------------------------
// Shared styling
// ---------------------------------------------------------------------------

function textStyle(t: ChartTheme, size: number, muted = false) {
    return { fontFamily: FONT, fontSize: size, color: muted ? t.textMuted : t.text };
}

function axis(t: ChartTheme, s: number, name: string | undefined, options: { grid?: boolean; category?: boolean; rotated?: boolean } = {}) {
    return {
        name: name || undefined,
        nameLocation: 'middle' as const,
        // Rotated category labels need the axis name pushed further out or they collide.
        nameGap: (options.rotated ? 62 : 30) * s,
        nameTextStyle: { ...textStyle(t, 11 * s, true), fontWeight: 500 as const },
        axisLine: { show: true, lineStyle: { color: t.axis, width: 1 } },
        axisTick: { show: !options.category, lineStyle: { color: t.axis }, length: 4 * s },
        axisLabel: { ...textStyle(t, 10.5 * s, true), hideOverlap: true, margin: 7 * s },
        splitLine: { show: options.grid !== false, lineStyle: { color: t.grid, width: 1 } },
        axisPointer: { show: false },
    };
}

function tooltipBase(t: ChartTheme, s: number) {
    return {
        backgroundColor: t.tooltipBg,
        borderColor: t.tooltipBorder,
        borderWidth: 1,
        padding: [7, 10] as [number, number],
        extraCssText: 'box-shadow: 0 10px 30px -8px rgba(0,0,0,0.45); border-radius: 8px; backdrop-filter: blur(8px);',
        textStyle: textStyle(t, 11.5 * s),
        confine: true,
        appendToBody: true,
        transitionDuration: 0.18,
    };
}

function legend(t: ChartTheme, s: number, show: boolean, data?: string[]) {
    return {
        show,
        type: 'scroll' as const,
        top: 2 * s,
        right: 4 * s,
        itemWidth: 10 * s,
        itemHeight: 10 * s,
        itemGap: 10 * s,
        icon: 'roundRect',
        textStyle: textStyle(t, 11 * s, true),
        pageTextStyle: textStyle(t, 10 * s, true),
        pageIconColor: t.textMuted,
        pageIconInactiveColor: t.axis,
        pageIconSize: 9 * s,
        ...(data ? { data } : {}),
    };
}

function titleBlock(spec: ChartSpec, t: ChartTheme, s: number, lettered = false) {
    if (!spec.title && !spec.subtitle) return undefined;
    return {
        text: spec.title || undefined,
        subtext: spec.subtitle || undefined,
        left: lettered ? 20 * s : 0,
        top: 0,
        textStyle: { ...textStyle(t, 13 * s), fontWeight: 600 as const },
        subtextStyle: textStyle(t, 11 * s, true),
    };
}

function gridFor(spec: ChartSpec, s: number, extra: { left?: number; right?: number; top?: number; bottom?: number } = {}) {
    const hasTitle = Boolean(spec.title || spec.subtitle);
    return {
        left: extra.left ?? 8,
        right: extra.right ?? 14,
        top: (extra.top ?? 8) + (hasTitle ? 26 * s : 0) + (spec.showLegend === false ? 0 : 14 * s),
        bottom: extra.bottom ?? 8,
        containLabel: true,
    };
}

/** Dotted reference lines, as `markLine` data. */
function referenceLines(spec: ChartSpec, t: ChartTheme, s: number) {
    if (!spec.reference?.length) return undefined;
    return {
        silent: true,
        symbol: 'none',
        animation: false,
        label: {
            show: true,
            position: 'insideEndTop' as const,
            formatter: (p: { data: { label?: string; value?: number } }) => p.data.label ?? fmt(p.data.value ?? 0),
            ...textStyle(t, 10 * s, true),
        },
        lineStyle: { color: t.reference, type: 'dotted' as const, width: 1.5 },
        data: spec.reference.map((r) => ({ [r.axis === 'x' ? 'xAxis' : 'yAxis']: r.value, label: r.label, lineStyle: r.color ? { color: r.color } : undefined })),
    };
}

/** Marker opacity: dim everything outside the selection, lift the hovered row. */
function itemOpacity(ctx: ChartContext, rowId: string, base: number): number {
    if (ctx.hovered === rowId) return 1;
    if (ctx.selection.size === 0) return base;
    return ctx.selection.has(rowId) ? 1 : base * 0.18;
}

/** Rows grouped by a categorical column, in a stable order. */
function groupRows(rows: DatasetRow[], key: string | undefined, dataset: Dataset): { name: string; rows: DatasetRow[] }[] {
    if (!key) return [{ name: '', rows }];
    const col = column(dataset, key);
    const map = new Map<string, DatasetRow[]>();
    for (const r of rows) {
        const v = stringOf(r, key) || '—';
        const list = map.get(v);
        if (list) list.push(r);
        else map.set(v, [r]);
    }
    const order = col?.categories ?? [...map.keys()].sort();
    const out = order.filter((c) => map.has(c)).map((name) => ({ name, rows: map.get(name)! }));
    for (const [name, rs] of map) if (!order.includes(name)) out.push({ name, rows: rs });
    return out;
}

function aggregateOf(values: number[], how: Aggregate): number {
    if (how === 'count') return values.length;
    if (values.length === 0) return NaN;
    switch (how) {
        case 'mean':
            return mean(values);
        case 'median':
            return quantileSorted([...values].sort((a, b) => a - b), 0.5);
        case 'max':
            return Math.max(...values);
        case 'min':
            return Math.min(...values);
        case 'sum':
            return values.reduce((a, b) => a + b, 0);
    }
}

const AGGREGATE_LABELS: Record<Aggregate, string> = { mean: 'média', median: 'mediana', max: 'máximo', min: 'mínimo', count: 'contagem', sum: 'soma' };

/** The tooltip body for one design: its name plus the columns the chart uses. */
function rowTooltip(ctx: ChartContext, row: DatasetRow, keys: (string | undefined)[]): string {
    const t = ctx.theme;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const k of keys) {
        if (!k || seen.has(k)) continue;
        seen.add(k);
        const col = column(ctx.dataset, k);
        if (!col) continue;
        const v = row.values[k];
        const text = typeof v === 'number' ? `${fmt(v)}${col.unit ? ` ${col.unit}` : ''}` : v === null ? '—' : String(v);
        lines.push(
            `<div style="display:flex;gap:10px;justify-content:space-between"><span style="color:${t.textMuted}">${col.label}</span><span style="font-family:${MONO}">${text}</span></div>`,
        );
    }
    const name = row.id;
    const file = row.structurePath ? `<div style="color:${t.textMuted};font-size:10px;margin-top:3px">clique para abrir a estrutura</div>` : '';
    return `<div style="font-weight:600;margin-bottom:4px;max-width:320px;word-break:break-all">${name}</div>${lines.join('')}${file}`;
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

interface Point {
    value: [number, number];
    rowId: string;
    row: DatasetRow;
}

function buildScatter(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, rows, theme: t } = ctx;
    const s = ctx.fontScale;
    const xKey = spec.x!;
    const yKey = spec.y!;
    const sizeKey = spec.size;
    const colorKey = spec.color;
    const colorCol = column(dataset, colorKey);
    const numericColor = colorCol?.kind === 'number';
    const base = spec.opacity ?? DEFAULT_CHART.opacity;
    const markerSize = spec.markerSize ?? DEFAULT_CHART.markerSize;

    const points: Point[] = [];
    for (const r of rows) {
        const x = numberOf(r, xKey);
        const y = numberOf(r, yKey);
        if (x === null || y === null) continue;
        points.push({ value: [x, y], rowId: r.id, row: r });
    }
    if (points.length === 0) return { option: {}, empty: 'Nenhuma linha tem as duas métricas.' };

    const sizeRange = sizeKey ? column(dataset, sizeKey)?.range : undefined;
    const symbolSize = (p: Point) => {
        if (!sizeKey || !sizeRange) return markerSize;
        const v = numberOf(p.row, sizeKey);
        if (v === null) return markerSize * 0.5;
        const t01 = sizeRange[1] > sizeRange[0] ? (v - sizeRange[0]) / (sizeRange[1] - sizeRange[0]) : 0.5;
        // Area-proportional, so a value twice as large looks twice as heavy.
        return markerSize * (0.55 + Math.sqrt(t01) * 1.15);
    };

    const groupKey = numericColor ? spec.group : (colorKey ?? spec.group);
    const groups = groupRows(points.map((p) => p.row), groupKey, dataset);
    const byId = new Map(points.map((p) => [p.rowId, p]));

    const series: Record<string, unknown>[] = [];
    const labelTop = spec.labelTop ?? 0;
    const labelled = new Set(
        labelTop > 0
            ? [...points]
                  .sort((a, b) => b.value[1] - a.value[1])
                  .slice(0, labelTop)
                  .map((p) => p.rowId)
            : [],
    );

    const mkItem = (p: Point, color: string) => ({
        value: p.value,
        rowId: p.rowId,
        name: p.rowId,
        symbolSize: symbolSize(p),
        itemStyle: {
            color,
            opacity: itemOpacity(ctx, p.rowId, base),
            borderColor: t.markerStroke,
            borderWidth: ctx.selection.has(p.rowId) || ctx.hovered === p.rowId ? 1.8 : 1,
            ...(ctx.hovered === p.rowId ? { shadowBlur: 10, shadowColor: color } : {}),
        },
        label: labelled.has(p.rowId)
            ? { show: true, formatter: shortName(p.rowId), position: 'right' as const, ...textStyle(t, 9.5 * s, true), distance: 4 }
            : { show: false },
    });

    if (numericColor && colorKey) {
        const range = colorCol?.range ?? [0, 1];
        // 'ocean' starts at white, which disappears on the dark theme: pick a ramp
        // that stays visible unless the user chose one.
        const colorRamp = spec.ramp ?? (t.id === 'dark' ? 'viridis' : DEFAULT_CHART.ramp);
        series.push({
            type: 'scatter',
            name: colorCol?.label,
            data: points.map((p) => {
                const v = numberOf(p.row, colorKey);
                const t01 = range[1] > range[0] && v !== null ? (v - range[0]) / (range[1] - range[0]) : 0.5;
                return mkItem(p, v === null ? t.axis : ramp(colorRamp, t01));
            }),
            emphasis: { scale: 1.25, focus: 'none' },
            animationDuration: 320,
        });
    } else {
        groups.forEach((g, i) => {
            const color = seriesColor(spec.palette ?? DEFAULT_CHART.palette, i);
            series.push({
                type: 'scatter',
                name: g.name || labelOf(dataset, yKey),
                data: g.rows.map((r) => byId.get(r.id)).filter((p): p is Point => Boolean(p)).map((p) => mkItem(p, color)),
                emphasis: { scale: 1.25, focus: 'none' },
                animationDuration: 320,
            });
        });
    }

    if (spec.trend) {
        const fit = linearFit(points.map((p) => p.value[0]), points.map((p) => p.value[1]));
        if (fit) {
            series.push({
                type: 'line',
                name: 'tendência',
                data: fit.line,
                showSymbol: false,
                silent: true,
                lineStyle: { color: t.reference, width: 1.5, type: 'dashed' },
                tooltip: { show: false },
                z: 1,
            });
        }
    }
    if (spec.reference?.length) {
        series.push({ type: 'line', data: [], markLine: referenceLines(spec, t, s), silent: true, tooltip: { show: false } });
    }

    const r = spec.showStats ? pearson(points.map((p) => p.value[0]), points.map((p) => p.value[1])) : NaN;

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s, { right: numericColor ? 58 * s : 14, bottom: 6 }),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'item',
                formatter: (p: { data?: { rowId?: string } }) => {
                    const row = rows.find((x) => x.id === p.data?.rowId);
                    return row ? rowTooltip(ctx, row, [xKey, yKey, colorKey, sizeKey, spec.group]) : '';
                },
            },
            legend: { ...legend(t, s, spec.showLegend !== false && !ctx.compact && groups.length > 1 && !numericColor) },
            xAxis: { type: spec.xLog ? 'log' : 'value', scale: true, ...axis(t, s, ctx.compact ? undefined : (spec.xLabel ?? labelOf(dataset, xKey)), { grid: spec.showGrid !== false }), ...rangeOf(spec.xRange) },
            yAxis: { type: spec.yLog ? 'log' : 'value', scale: true, ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? labelOf(dataset, yKey)), { grid: spec.showGrid !== false }), ...rangeOf(spec.yRange) },
            ...(numericColor && colorCol?.range
                ? {
                      visualMap: {
                          type: 'continuous',
                          min: colorCol.range[0],
                          max: colorCol.range[1],
                          calculable: true,
                          orient: 'vertical',
                          right: 4 * s,
                          top: 'middle',
                          itemWidth: 10 * s,
                          itemHeight: 90 * s,
                          text: [fmt(colorCol.range[1]), fmt(colorCol.range[0])],
                          textStyle: textStyle(t, 10 * s, true),
                          inRange: { color: rampColors(spec.ramp ?? (t.id === 'dark' ? 'viridis' : DEFAULT_CHART.ramp)) },
                          // Colours are already baked per item; this is the colour bar.
                          seriesIndex: [],
                      },
                  }
                : {}),
            brush: ctx.compact ? undefined : { toolbox: ['rect', 'polygon', 'keep', 'clear'], xAxisIndex: 0, yAxisIndex: 0, throttleType: 'debounce', throttleDelay: 120, brushStyle: { borderColor: '#4CC9F0', borderWidth: 1, color: 'rgba(76,201,240,0.10)' } },
            toolbox: { show: false },
            labelLayout: { hideOverlap: true },
            series: series as EChartsOption['series'],
            graphic: spec.showStats && Number.isFinite(r) ? statBadge(`r = ${r.toFixed(2)} · n = ${points.length}`, t, s, (spec.title ? 28 : 4) * s) : undefined,
        } as unknown as EChartsOption,
    };
}

const shortName = (id: string): string => (id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-9)}` : id);

function rangeOf(r: [number | null, number | null] | undefined) {
    if (!r) return {};
    return { ...(r[0] !== null ? { min: r[0] } : {}), ...(r[1] !== null ? { max: r[1] } : {}) };
}

/** Top-left, under the title: the bottom right belongs to the x axis and the legend. */
function statBadge(text: string, t: ChartTheme, s: number, top: number) {
    return [
        {
            type: 'text' as const,
            left: 2,
            top,
            silent: true,
            style: { text, fontFamily: MONO, fontSize: 10.5 * s, fill: t.textMuted },
        },
    ];
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

function buildHistogram(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, rows, theme: t } = ctx;
    const s = ctx.fontScale;
    const key = spec.x!;
    const all = finite(rows.map((r) => numberOf(r, key)));
    if (all.length === 0) return { option: {}, empty: 'Sem valores numéricos nessa coluna.' };

    const domain: [number, number] = [Math.min(...all), Math.max(...all)];
    const bins = spec.bins && spec.bins > 0 ? spec.bins : binCount(all);
    const groups = groupRows(rows, spec.group, dataset);
    const series = groups.map((g, i) => {
        const values = finite(g.rows.map((r) => numberOf(r, key)));
        const h = histogram(values, bins, domain);
        const color = seriesColor(spec.palette ?? DEFAULT_CHART.palette, i);
        return {
            type: 'bar' as const,
            name: g.name || 'designs',
            data: h.centers.map((c, j) => [c, h.counts[j]!]),
            barWidth: `${Math.max(40, 92 / Math.max(1, groups.length))}%`,
            barGap: groups.length > 1 ? '-60%' : undefined,
            itemStyle: { color: alpha(color, groups.length > 1 ? 0.62 : 0.88), borderColor: color, borderWidth: groups.length > 1 ? 1 : 0, borderRadius: [3, 3, 0, 0] },
            emphasis: { itemStyle: { color } },
            markLine: i === 0 ? referenceLines(spec, t, s) : undefined,
            animationDuration: 320,
        };
    });

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'axis',
                axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.textMuted, 0.08) } },
                formatter: (ps: { seriesName: string; value: [number, number]; color: string }[]) => {
                    const head = `<div style="font-weight:600;margin-bottom:3px">${labelOf(dataset, key)} ≈ ${fmt(ps[0]?.value[0] ?? 0)}</div>`;
                    return head + ps.map((p) => `<div style="display:flex;gap:10px;justify-content:space-between"><span style="color:${p.color}">${p.seriesName}</span><span style="font-family:${MONO}">${p.value[1]}</span></div>`).join('');
                },
            },
            legend: legend(t, s, spec.showLegend !== false && !ctx.compact && groups.length > 1),
            xAxis: { type: 'value', scale: true, ...axis(t, s, ctx.compact ? undefined : (spec.xLabel ?? labelOf(dataset, key)), { grid: false }), ...rangeOf(spec.xRange) },
            yAxis: { type: 'value', ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? 'designs'), { grid: spec.showGrid !== false }), ...rangeOf(spec.yRange) },
            series: series as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Violin and box
// ---------------------------------------------------------------------------

interface GroupStats {
    name: string;
    rows: DatasetRow[];
    values: number[];
    q: ReturnType<typeof quartiles>;
    density: ReturnType<typeof kde>;
}

function groupStats(spec: ChartSpec, ctx: ChartContext): GroupStats[] {
    const yKey = spec.y!;
    return groupRows(ctx.rows, spec.x, ctx.dataset)
        .map((g) => {
            const values = finite(g.rows.map((r) => numberOf(r, yKey)));
            return { name: g.name || labelOf(ctx.dataset, yKey), rows: g.rows, values, q: quartiles(values), density: kde(values) };
        })
        .filter((g) => g.values.length > 0);
}

function buildDistribution(spec: ChartSpec, ctx: ChartContext, violin: boolean): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const groups = groupStats(spec, ctx);
    if (groups.length === 0) return { option: {}, empty: 'Sem valores para distribuir.' };
    const yKey = spec.y!;
    const palette = spec.palette ?? DEFAULT_CHART.palette;
    const showPoints = spec.showPoints ?? !violin;
    const showBox = spec.showBox ?? true;

    const all = groups.flatMap((g) => g.values);
    const lo = Math.min(...all);
    const hi = Math.max(...all);

    const series: Record<string, unknown>[] = [];
    const rotateX = groups.length > 4 || groups.some((g) => g.name.length > 7);

    if (violin) {
        // Custom polygons: one mirrored KDE per group, drawn in pixel space so the
        // width is independent of the value scale (as the Bokeh _violin does).
        series.push({
            type: 'custom',
            name: 'densidade',
            silent: true,
            z: 1,
            renderItem: (params: { dataIndex: number }, api: { coord: (v: number[]) => number[]; size: (v: number[]) => number[] }) => {
                const g = groups[params.dataIndex];
                if (!g?.density) return { type: 'group', children: [] };
                const half = (api.size([1, 0])[0] ?? 40) * 0.42;
                const right: number[][] = [];
                const left: number[][] = [];
                for (let i = 0; i < g.density.grid.length; i++) {
                    const [cx, cy] = api.coord([params.dataIndex, g.density.grid[i]!]);
                    const d = g.density.values[i]! * half;
                    right.push([cx! + d, cy!]);
                    left.push([cx! - d, cy!]);
                }
                const color = seriesColor(palette, params.dataIndex);
                return {
                    type: 'polygon',
                    shape: { points: [...right, ...left.reverse()] },
                    style: { fill: alpha(color, 0.5), stroke: color, lineWidth: 1.2 },
                };
            },
            data: groups.map((g) => [0, g.q?.median ?? 0, g.name]),
            animationDuration: 320,
        });
    }

    if (showBox) {
        series.push({
            type: 'custom',
            name: 'quartis',
            silent: true,
            z: 3,
            renderItem: (params: { dataIndex: number }, api: { coord: (v: number[]) => number[]; size: (v: number[]) => number[] }) => {
                const g = groups[params.dataIndex];
                if (!g?.q) return { type: 'group', children: [] };
                const slot = api.size([1, 0])[0] ?? 40;
                const color = seriesColor(palette, params.dataIndex);
                const [cx] = api.coord([params.dataIndex, 0]);
                const y = (v: number) => api.coord([params.dataIndex, v])[1]!;
                const boxW = violin ? slot * 0.1 : slot * 0.34;
                const children: Record<string, unknown>[] = [
                    // Whiskers.
                    { type: 'line', shape: { x1: cx, y1: y(g.q.lower), x2: cx, y2: y(g.q.upper) }, style: { stroke: violin ? t.text : color, lineWidth: 1.2, opacity: 0.8 } },
                    // Interquartile body.
                    {
                        type: 'rect',
                        shape: { x: cx! - boxW / 2, y: y(g.q.q3), width: boxW, height: Math.max(1, y(g.q.q1) - y(g.q.q3)) },
                        style: violin ? { fill: t.text, opacity: 0.85 } : { fill: alpha(color, 0.35), stroke: color, lineWidth: 1.4 },
                    },
                    // Median dot — the white circle of the reference violins.
                    { type: 'circle', shape: { cx, cy: y(g.q.median), r: Math.max(2.5, 3.2 * s) }, style: { fill: ctx.theme.background === 'transparent' ? '#fff' : t.background, stroke: violin ? t.text : color, lineWidth: 1.6 } },
                ];
                return { type: 'group', children };
            },
            data: groups.map((g) => [0, g.q?.median ?? 0]),
            animationDuration: 320,
        });
    }

    if (showPoints) {
        groups.forEach((g, i) => {
            const color = seriesColor(palette, i);
            const span = 0.3;
            const offs = swarmOffsets(g.values, span, Math.max(0.012, (hi - lo) / 90));
            const rows = g.rows.filter((r) => numberOf(r, yKey) !== null);
            series.push({
                type: 'scatter',
                name: g.name,
                z: 4,
                symbolSize: (spec.markerSize ?? DEFAULT_CHART.markerSize) * 0.62,
                data: rows.map((r, j) => ({
                    value: [i + (offs[j] ?? 0), numberOf(r, yKey)!],
                    rowId: r.id,
                    itemStyle: {
                        color: violin ? t.text : color,
                        opacity: itemOpacity(ctx, r.id, violin ? 0.45 : 0.75),
                        borderColor: t.markerStroke,
                        borderWidth: 0.6,
                    },
                })),
                emphasis: { scale: 1.6 },
                animationDuration: 320,
            });
        });
    }

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s, { bottom: 10 }),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'item',
                formatter: (p: { data?: { rowId?: string }; dataIndex: number; seriesType: string }) => {
                    if (p.data?.rowId) {
                        const row = ctx.rows.find((x) => x.id === p.data!.rowId);
                        return row ? rowTooltip(ctx, row, [spec.x, yKey, spec.color]) : '';
                    }
                    const g = groups[p.dataIndex];
                    if (!g?.q) return '';
                    const line = (k: string, v: number) => `<div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${t.textMuted}">${k}</span><span style="font-family:${MONO}">${fmt(v)}</span></div>`;
                    return `<div style="font-weight:600;margin-bottom:4px">${g.name}</div>${line('n', g.q.n)}${line('mediana', g.q.median)}${line('q1–q3', g.q.q1)}${line('', g.q.q3)}${line('média', g.q.mean)}`;
                },
            },
            legend: legend(t, s, false),
            xAxis: {
                type: 'value',
                min: -0.5,
                max: groups.length - 0.5,
                interval: 1,
                ...axis(t, s, ctx.compact ? undefined : (spec.xLabel ?? labelOf(dataset, spec.x)), { grid: false, category: true, rotated: rotateX }),
                axisLabel: {
                    ...textStyle(t, 10.5 * s, true),
                    margin: 9 * s,
                    hideOverlap: true,
                    formatter: (v: number) => groups[Math.round(v)]?.name ?? '',
                    rotate: rotateX ? 35 : 0,
                },
                axisTick: { show: false },
            },
            yAxis: {
                type: 'value',
                scale: true,
                // Padding as a percentage keeps round tick values (a raw min of
                // 0.68399999 is what an explicit min produces).
                boundaryGap: ['7%', '7%'],
                ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? labelOf(dataset, yKey)), { grid: spec.showGrid !== false }),
                ...rangeOf(spec.yRange),
            },
            series: series as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

function buildBar(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const how = spec.aggregate ?? DEFAULT_CHART.aggregate;
    const yKey = spec.y;
    const groups = groupRows(ctx.rows, spec.x, dataset).map((g) => ({
        name: g.name || '—',
        rows: g.rows,
        value: yKey ? aggregateOf(finite(g.rows.map((r) => numberOf(r, yKey))), how) : g.rows.length,
    }));
    const usable = groups.filter((g) => Number.isFinite(g.value));
    if (usable.length === 0) return { option: {}, empty: 'Nada para agregar.' };

    const sort = spec.sort ?? DEFAULT_CHART.sort;
    const sorted =
        sort === 'natural'
            ? usable
            : [...usable].sort((a, b) => (sort === 'label' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : sort === 'value-asc' ? a.value - b.value : b.value - a.value));
    const limited = spec.limit && spec.limit > 0 ? sorted.slice(0, spec.limit) : sorted;
    const palette = spec.palette ?? DEFAULT_CHART.palette;
    const valueLabel = yKey ? `${labelOf(dataset, yKey)} (${AGGREGATE_LABELS[how]})` : 'designs';
    const rotateBarX = limited.length > 6 || limited.some((g) => g.name.length > 8);

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s, { bottom: 10 }),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'axis',
                axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.textMuted, 0.08) } },
                formatter: (ps: { name: string; value: number; dataIndex: number }[]) => {
                    const g = limited[ps[0]?.dataIndex ?? 0];
                    if (!g) return '';
                    return `<div style="font-weight:600;margin-bottom:3px">${g.name}</div><div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${t.textMuted}">${valueLabel}</span><span style="font-family:${MONO}">${fmt(g.value)}</span></div><div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${t.textMuted}">designs</span><span style="font-family:${MONO}">${g.rows.length}</span></div>`;
                },
            },
            legend: legend(t, s, false),
            xAxis: {
                type: 'category',
                data: limited.map((g) => g.name),
                ...axis(t, s, ctx.compact ? undefined : spec.xLabel ?? labelOf(dataset, spec.x), { grid: false, category: true, rotated: rotateBarX }),
                axisLabel: { ...textStyle(t, 10.5 * s, true), hideOverlap: true, margin: 8 * s, rotate: rotateBarX ? 38 : 0, interval: 0 },
            },
            yAxis: { type: 'value', ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? valueLabel), { grid: spec.showGrid !== false }), ...rangeOf(spec.yRange) },
            series: [
                {
                    type: 'bar',
                    data: limited.map((g, i) => ({
                        value: g.value,
                        itemStyle: { color: seriesColor(palette, spec.x ? i : 0), borderRadius: [4, 4, 0, 0], opacity: 0.92 },
                    })),
                    barMaxWidth: 48,
                    label: {
                        show: spec.showValues ?? false,
                        position: 'top',
                        formatter: (p: { value: number }) => fmt(p.value),
                        ...textStyle(t, 10 * s, true),
                    },
                    labelLayout: { hideOverlap: true },
                    emphasis: { itemStyle: { opacity: 1 } },
                    markLine: referenceLines(spec, t, s),
                    animationDuration: 320,
                },
            ] as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

function buildStacked(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const xGroups = groupRows(ctx.rows, spec.x, dataset);
    const stackKey = spec.group;
    if (!stackKey) return { option: {}, empty: 'Escolha a coluna que empilha as barras.' };
    const stacks = groupRows(ctx.rows, stackKey, dataset).map((g) => g.name);
    if (xGroups.length === 0) return { option: {}, empty: 'Nada para empilhar.' };
    const normalize = spec.normalize ?? true;
    const palette = spec.palette ?? DEFAULT_CHART.palette;

    const counts = xGroups.map((g) => {
        const total = g.rows.length || 1;
        const per = new Map<string, number>();
        for (const r of g.rows) {
            const k = stringOf(r, stackKey) || '—';
            per.set(k, (per.get(k) ?? 0) + 1);
        }
        return { name: g.name || '—', total: g.rows.length, per, fraction: (k: string) => ((per.get(k) ?? 0) / total) * (normalize ? 100 : 1) };
    });

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s, { bottom: 10 }),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'axis',
                axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.textMuted, 0.08) } },
                formatter: (ps: { dataIndex: number; seriesName: string; color: string }[]) => {
                    const c = counts[ps[0]?.dataIndex ?? 0];
                    if (!c) return '';
                    const lines = ps
                        .filter((p) => (c.per.get(p.seriesName) ?? 0) > 0)
                        .map((p) => {
                            const n = c.per.get(p.seriesName) ?? 0;
                            const pct = ((n / (c.total || 1)) * 100).toFixed(0);
                            return `<div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${p.color}">${p.seriesName}</span><span style="font-family:${MONO}">${n} · ${pct}%</span></div>`;
                        });
                    return `<div style="font-weight:600;margin-bottom:3px">${c.name} · ${c.total} designs</div>${lines.join('')}`;
                },
            },
            legend: legend(t, s, spec.showLegend !== false && !ctx.compact),
            xAxis: {
                type: 'category',
                data: counts.map((c) => c.name),
                ...axis(t, s, ctx.compact ? undefined : spec.xLabel ?? labelOf(dataset, spec.x), { grid: false, category: true, rotated: counts.length > 4 }),
                axisLabel: { ...textStyle(t, 10.5 * s, true), hideOverlap: true, margin: 8 * s, rotate: counts.length > 4 ? 38 : 0, interval: 0 },
            },
            yAxis: {
                type: 'value',
                max: normalize ? 100 : undefined,
                ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? (normalize ? 'designs (%)' : 'designs')), { grid: spec.showGrid !== false }),
                axisLabel: { ...textStyle(t, 10.5 * s, true), formatter: normalize ? '{value}%' : '{value}' },
            },
            series: stacks.map((name, i) => ({
                type: 'bar' as const,
                name,
                stack: 'total',
                barMaxWidth: 54,
                data: counts.map((c) => c.fraction(name)),
                itemStyle: { color: seriesColor(palette, i), borderColor: t.background, borderWidth: 1 },
                label: {
                    // Inside labels only while the bars are wide enough to hold them:
                    // ECharts' hideOverlap does not apply to labels inside bars.
                    show: (spec.showValues ?? false) && normalize && counts.length <= 8,
                    position: 'inside',
                    formatter: (p: { value: number }) => (p.value >= 9 ? `${p.value.toFixed(0)}%` : ''),
                    ...textStyle(t, 10 * s),
                    color: '#fff',
                    fontWeight: 600,
                },
                labelLayout: { hideOverlap: true },
                emphasis: { focus: 'series' },
                animationDuration: 320,
            })) as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Line
// ---------------------------------------------------------------------------

function buildLine(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const xKey = spec.x!;
    const yKey = spec.y!;
    const xCol = column(dataset, xKey);
    const numericX = xCol?.kind === 'number';
    const groups = groupRows(ctx.rows, spec.group, dataset);
    const palette = spec.palette ?? DEFAULT_CHART.palette;
    const series: Record<string, unknown>[] = [];

    const categories = numericX ? [] : [...new Set(ctx.rows.map((r) => stringOf(r, xKey)).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    groups.forEach((g, i) => {
        const color = seriesColor(palette, i);
        // One point per distinct x: repeated x values are aggregated, which is what
        // makes a "metric vs cutoff" curve out of a long table.
        const byX = new Map<string | number, number[]>();
        for (const r of g.rows) {
            const xv = numericX ? numberOf(r, xKey) : stringOf(r, xKey);
            const yv = numberOf(r, yKey);
            if (xv === null || xv === '' || yv === null) continue;
            const list = byX.get(xv);
            if (list) list.push(yv);
            else byX.set(xv, [yv]);
        }
        const points = [...byX.entries()]
            .map(([xv, ys]) => ({ x: xv, mean: aggregateOf(ys, spec.aggregate ?? 'mean'), sem: sem(ys), n: ys.length }))
            .sort((a, b) => (numericX ? (a.x as number) - (b.x as number) : categories.indexOf(a.x as string) - categories.indexOf(b.x as string)));
        if (points.length === 0) return;

        if (spec.showBand && points.some((p) => p.sem > 0)) {
            // Lower bound invisible, band stacked on top — the standard ECharts band.
            series.push(
                {
                    type: 'line',
                    name: `${g.name}-base`,
                    stack: `band-${i}`,
                    data: points.map((p) => [numericX ? p.x : categories.indexOf(p.x as string), p.mean - p.sem]),
                    lineStyle: { opacity: 0 },
                    showSymbol: false,
                    silent: true,
                    tooltip: { show: false },
                    legendHoverLink: false,
                    z: 1,
                },
                {
                    type: 'line',
                    name: `${g.name}-band`,
                    stack: `band-${i}`,
                    data: points.map((p) => [numericX ? p.x : categories.indexOf(p.x as string), 2 * p.sem]),
                    lineStyle: { opacity: 0 },
                    areaStyle: { color: alpha(color, 0.16) },
                    showSymbol: false,
                    silent: true,
                    tooltip: { show: false },
                    legendHoverLink: false,
                    z: 1,
                },
            );
        }
        series.push({
            type: 'line',
            name: g.name || labelOf(dataset, yKey),
            data: points.map((p) => ({ value: [numericX ? p.x : categories.indexOf(p.x as string), p.mean], n: p.n, sem: p.sem })),
            smooth: 0.18,
            symbol: 'circle',
            symbolSize: (spec.markerSize ?? DEFAULT_CHART.markerSize) * 0.78,
            itemStyle: { color, borderColor: t.markerStroke, borderWidth: 1 },
            lineStyle: { color, width: spec.lineWidth ?? DEFAULT_CHART.lineWidth },
            emphasis: { scale: 1.4, focus: 'series' },
            markLine: i === 0 ? referenceLines(spec, t, s) : undefined,
            z: 3,
            animationDuration: 320,
        });
    });

    if (series.length === 0) return { option: {}, empty: 'Sem pares (x, y) para traçar.' };

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'axis',
                axisPointer: { type: 'line', lineStyle: { color: t.axis, type: 'dotted' } },
                formatter: (ps: { seriesName: string; value: [number, number]; color: string; data?: { n?: number } }[]) => {
                    const visible = ps.filter((p) => !p.seriesName.endsWith('-base') && !p.seriesName.endsWith('-band'));
                    if (visible.length === 0) return '';
                    const x = visible[0]!.value[0];
                    const head = numericX ? `${labelOf(dataset, xKey)} = ${fmt(x)}` : (categories[x] ?? '');
                    return (
                        `<div style="font-weight:600;margin-bottom:3px">${head}</div>` +
                        visible
                            .map(
                                (p) =>
                                    `<div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${p.color}">${p.seriesName}</span><span style="font-family:${MONO}">${fmt(p.value[1])}${p.data?.n ? ` (n=${p.data.n})` : ''}</span></div>`,
                            )
                            .join('')
                    );
                },
            },
            legend: legend(t, s, spec.showLegend !== false && !ctx.compact && groups.length > 1, groups.map((g) => g.name).filter(Boolean)),
            xAxis: {
                type: numericX ? 'value' : 'category',
                ...(numericX ? { scale: true } : { data: categories }),
                ...axis(t, s, ctx.compact ? undefined : (spec.xLabel ?? labelOf(dataset, xKey)), { grid: false, category: !numericX }),
                ...rangeOf(spec.xRange),
            },
            yAxis: { type: spec.yLog ? 'log' : 'value', scale: true, ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? labelOf(dataset, yKey)), { grid: spec.showGrid !== false }), ...rangeOf(spec.yRange) },
            series: series as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Heatmap and correlation
// ---------------------------------------------------------------------------

function buildHeatmap(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const cols = (spec.columns ?? []).filter((k) => column(dataset, k)?.kind === 'number');
    if (cols.length === 0) return { option: {}, empty: 'Escolha ao menos uma métrica para a matriz.' };

    const rowGroups = spec.rowKey
        ? groupRows(ctx.rows, spec.rowKey, dataset).map((g) => ({ name: g.name || '—', rows: g.rows }))
        : ctx.rows.map((r) => ({ name: r.id, rows: [r] }));
    const limited = spec.limit && spec.limit > 0 ? rowGroups.slice(0, spec.limit) : rowGroups.slice(0, 400);
    const how = spec.aggregate ?? 'mean';

    const data: { value: [number, number, number]; rowId?: string }[] = [];
    let lo = Infinity;
    let hi = -Infinity;
    limited.forEach((g, yi) => {
        cols.forEach((key, xi) => {
            const v = aggregateOf(finite(g.rows.map((r) => numberOf(r, key))), how);
            if (!Number.isFinite(v)) return;
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
            data.push({ value: [xi, yi, v], rowId: g.rows.length === 1 ? g.rows[0]!.id : undefined });
        });
    });
    if (data.length === 0) return { option: {}, empty: 'Sem valores para a matriz.' };

    // The colour range covers the central 96% of the values: a handful of outliers
    // would otherwise flatten every other cell to the middle of the ramp.
    const sorted = data.map((d) => d.value[2]).sort((a, b) => a - b);
    const p02 = quantileSorted(sorted, 0.02);
    const p98 = quantileSorted(sorted, 0.98);
    const center = spec.rampCenter ?? null;
    const reach = center !== null ? Math.max(Math.abs(p98 - center), Math.abs(center - p02)) || Math.max(Math.abs(hi - center), Math.abs(center - lo)) : 0;
    const min = spec.rampRange?.[0] ?? (center !== null ? center - reach : p02);
    const max = spec.rampRange?.[1] ?? (center !== null ? center + reach : p98);
    const showRowLabels = limited.length <= 40;

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: { left: showRowLabels ? 8 : 4, right: 70 * s, top: 8 + (spec.title ? 26 * s : 0), bottom: 8, containLabel: true },
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'item',
                formatter: (p: { value: [number, number, number] }) => {
                    const [xi, yi, v] = p.value;
                    const col = column(dataset, cols[xi]!);
                    const g = limited[yi];
                    return `<div style="font-weight:600;margin-bottom:3px;max-width:300px;word-break:break-all">${g?.name ?? ''}</div><div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${t.textMuted}">${col?.label ?? ''}</span><span style="font-family:${MONO}">${fmt(v)}${col?.unit ? ` ${col.unit}` : ''}</span></div>${g && g.rows.length > 1 ? `<div style="color:${t.textMuted};font-size:10px">${g.rows.length} designs · ${AGGREGATE_LABELS[how]}</div>` : ''}`;
                },
            },
            xAxis: {
                type: 'category',
                data: cols.map((k) => column(dataset, k)?.label ?? k),
                ...axis(t, s, undefined, { grid: false, category: true }),
                splitArea: { show: false },
                axisLabel: { ...textStyle(t, 10.5 * s, true), rotate: cols.length > 5 ? 40 : 0, hideOverlap: true, margin: 7 * s },
            },
            yAxis: {
                type: 'category',
                data: limited.map((g) => (showRowLabels ? shortName(g.name) : '')),
                inverse: true,
                ...axis(t, s, undefined, { grid: false, category: true }),
                axisLabel: { ...textStyle(t, 10 * s, true), hideOverlap: true, width: 130 * s, overflow: 'truncate' },
            },
            visualMap: {
                type: 'continuous',
                min,
                max,
                calculable: true,
                orient: 'vertical',
                right: 6 * s,
                top: 'middle',
                itemWidth: 11 * s,
                itemHeight: 110 * s,
                precision: 2,
                textStyle: textStyle(t, 10 * s, true),
                inRange: { color: rampColors(spec.ramp ?? DEFAULT_CHART.ramp) },
            },
            series: [
                {
                    type: 'heatmap',
                    data: data.map((d) => ({ value: d.value, rowId: d.rowId })),
                    label: {
                        show: (spec.showValues ?? false) && limited.length * cols.length <= 200,
                        formatter: (p: { value: [number, number, number] }) => fmt(p.value[2], 2),
                        ...textStyle(t, 9.5 * s),
                        color: t.background,
                    },
                    itemStyle: { borderColor: t.background, borderWidth: 1 },
                    emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1.5 } },
                    progressive: 2000,
                    animation: false,
                },
            ] as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

function buildCorrelation(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const cols = (spec.columns ?? []).filter((k) => column(dataset, k)?.kind === 'number');
    if (cols.length < 2) return { option: {}, empty: 'Escolha pelo menos duas métricas.' };
    const method = spec.method ?? 'pearson';

    const series: { value: [number, number, number] }[] = [];
    const vectors = cols.map((k) => ctx.rows.map((r) => numberOf(r, k)));
    for (let i = 0; i < cols.length; i++) {
        for (let j = 0; j < cols.length; j++) {
            // Only rows where both metrics exist take part in a pair's coefficient.
            const xs: number[] = [];
            const ys: number[] = [];
            for (let n = 0; n < ctx.rows.length; n++) {
                const a = vectors[i]![n];
                const b = vectors[j]![n];
                if (a === null || b === null || a === undefined || b === undefined) continue;
                xs.push(a);
                ys.push(b);
            }
            const r = method === 'spearman' ? spearman(xs, ys) : pearson(xs, ys);
            if (Number.isFinite(r)) series.push({ value: [j, i, r] });
        }
    }

    const labels = cols.map((k) => column(dataset, k)?.label ?? k);
    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: { left: 8, right: 70 * s, top: 8 + (spec.title ? 26 * s : 0), bottom: 8, containLabel: true },
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'item',
                formatter: (p: { value: [number, number, number] }) =>
                    `<div style="font-weight:600;margin-bottom:3px">${labels[p.value[1]]} × ${labels[p.value[0]]}</div><div style="font-family:${MONO}">${method === 'spearman' ? 'ρ' : 'r'} = ${p.value[2].toFixed(3)}</div>`,
            },
            xAxis: { type: 'category', data: labels, ...axis(t, s, undefined, { grid: false, category: true }), axisLabel: { ...textStyle(t, 10 * s, true), rotate: 40, hideOverlap: true } },
            yAxis: { type: 'category', data: labels, inverse: true, ...axis(t, s, undefined, { grid: false, category: true }), axisLabel: { ...textStyle(t, 10 * s, true), hideOverlap: true } },
            visualMap: {
                type: 'continuous',
                min: -1,
                max: 1,
                calculable: true,
                orient: 'vertical',
                right: 6 * s,
                top: 'middle',
                itemWidth: 11 * s,
                itemHeight: 110 * s,
                textStyle: textStyle(t, 10 * s, true),
                inRange: { color: rampColors(spec.ramp && (DIVERGING_SAFE as readonly string[]).includes(spec.ramp) ? spec.ramp : 'blue-red') },
            },
            series: [
                {
                    type: 'heatmap',
                    data: series,
                    label: {
                        show: spec.showValues ?? cols.length <= 10,
                        formatter: (p: { value: [number, number, number] }) => (Math.abs(p.value[2]) >= 0.995 ? '1' : p.value[2].toFixed(2).replace('0.', '.')),
                        ...textStyle(t, 9.5 * s),
                        color: t.text,
                    },
                    itemStyle: { borderColor: t.background, borderWidth: 1 },
                    emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1.5 } },
                    labelLayout: { hideOverlap: true },
                    animation: false,
                },
            ] as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

const DIVERGING_SAFE = ['blue-red', 'teal-brown'] as const;

// ---------------------------------------------------------------------------
// Dumbbell
// ---------------------------------------------------------------------------

function buildDumbbell(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const aKey = spec.y!;
    const bKey = spec.y2;
    if (!bKey) return { option: {}, empty: 'Escolha a segunda métrica.' };
    const how = spec.aggregate ?? 'mean';

    const groups = (spec.x ? groupRows(ctx.rows, spec.x, dataset).map((g) => ({ name: g.name || '—', rows: g.rows })) : ctx.rows.map((r) => ({ name: r.id, rows: [r] })))
        .map((g) => ({
            name: g.name,
            rowId: g.rows.length === 1 ? g.rows[0]!.id : undefined,
            a: aggregateOf(finite(g.rows.map((r) => numberOf(r, aKey))), how),
            b: aggregateOf(finite(g.rows.map((r) => numberOf(r, bKey))), how),
            n: g.rows.length,
        }))
        .filter((g) => Number.isFinite(g.a) && Number.isFinite(g.b));
    if (groups.length === 0) return { option: {}, empty: 'Sem pares de valores.' };

    const sort = spec.sort ?? 'value-desc';
    const sorted = sort === 'natural' ? groups : [...groups].sort((x, y) => (sort === 'label' ? x.name.localeCompare(y.name, undefined, { numeric: true }) : sort === 'value-asc' ? x.b - y.b : y.b - x.b));
    const limited = spec.limit && spec.limit > 0 ? sorted.slice(0, spec.limit) : sorted.slice(0, 60);
    const colorA = seriesColor(spec.palette ?? DEFAULT_CHART.palette, 1);
    const colorB = seriesColor(spec.palette ?? DEFAULT_CHART.palette, 0);
    const ms = (spec.markerSize ?? DEFAULT_CHART.markerSize) * 0.95;

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            grid: gridFor(spec, s, { left: 8, bottom: 10 }),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'axis',
                axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.textMuted, 0.08) } },
                formatter: (ps: { dataIndex: number }[]) => {
                    const g = limited[ps[0]?.dataIndex ?? 0];
                    if (!g) return '';
                    const line = (k: string, v: number, c: string) => `<div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${c}">${k}</span><span style="font-family:${MONO}">${fmt(v)}</span></div>`;
                    return `<div style="font-weight:600;margin-bottom:3px;max-width:300px;word-break:break-all">${g.name}</div>${line(labelOf(dataset, aKey), g.a, colorA)}${line(labelOf(dataset, bKey), g.b, colorB)}${line('Δ', g.b - g.a, t.textMuted)}`;
                },
            },
            legend: legend(t, s, spec.showLegend !== false && !ctx.compact, [labelOf(dataset, aKey), labelOf(dataset, bKey)]),
            xAxis: {
                type: 'category',
                data: limited.map((g) => shortName(g.name)),
                ...axis(t, s, ctx.compact ? undefined : spec.xLabel ?? labelOf(dataset, spec.x), { grid: false, category: true }),
                axisLabel: { ...textStyle(t, 10 * s, true), rotate: limited.length > 5 ? 40 : 0, hideOverlap: true, interval: 0 },
            },
            yAxis: { type: 'value', scale: true, ...axis(t, s, ctx.compact ? undefined : (spec.yLabel ?? ''), { grid: spec.showGrid !== false }), ...rangeOf(spec.yRange) },
            series: [
                {
                    type: 'custom',
                    name: 'ligação',
                    silent: true,
                    z: 1,
                    renderItem: (params: { dataIndex: number }, api: { coord: (v: (number | string)[]) => number[] }) => {
                        const g = limited[params.dataIndex];
                        if (!g) return { type: 'group', children: [] };
                        const [x, y1] = api.coord([params.dataIndex, g.a]);
                        const [, y2] = api.coord([params.dataIndex, g.b]);
                        return { type: 'line', shape: { x1: x, y1, x2: x, y2 }, style: { stroke: alpha(colorB, 0.55), lineWidth: 2.2 } };
                    },
                    data: limited.map((g) => [0, g.a]),
                    animationDuration: 320,
                },
                {
                    type: 'scatter',
                    name: labelOf(dataset, aKey),
                    symbolSize: ms,
                    z: 2,
                    data: limited.map((g, i) => ({ value: [i, g.a], rowId: g.rowId, itemStyle: { color: t.background, borderColor: colorA, borderWidth: 2, opacity: 1 } })),
                },
                {
                    type: 'scatter',
                    name: labelOf(dataset, bKey),
                    symbolSize: ms,
                    z: 3,
                    data: limited.map((g, i) => ({ value: [i, g.b], rowId: g.rowId, itemStyle: { color: colorB, borderColor: t.markerStroke, borderWidth: 1 } })),
                },
            ] as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Parallel coordinates
// ---------------------------------------------------------------------------

function buildParallel(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const cols = (spec.columns ?? []).filter((k) => column(dataset, k)?.kind === 'number');
    if (cols.length < 2) return { option: {}, empty: 'Escolha pelo menos duas métricas.' };

    const colorKey = spec.color;
    const colorCol = column(dataset, colorKey);
    const groups = colorCol && colorCol.kind !== 'number' ? groupRows(ctx.rows, colorKey, dataset) : [{ name: '', rows: ctx.rows }];
    const palette = spec.palette ?? DEFAULT_CHART.palette;
    const numericColor = colorCol?.kind === 'number';

    const axes = cols.map((k, i) => {
        const col = column(dataset, k)!;
        return {
            dim: i,
            name: col.label,
            nameTextStyle: textStyle(t, 10.5 * s, true),
            axisLine: { lineStyle: { color: t.axis } },
            axisTick: { lineStyle: { color: t.axis } },
            axisLabel: textStyle(t, 9.5 * s, true),
            ...(col.range ? { min: col.range[0], max: col.range[1] } : {}),
        };
    });

    const series = groups.map((g, gi) => ({
        type: 'parallel' as const,
        name: g.name || 'designs',
        smooth: 0.1,
        lineStyle: {
            width: 1.3,
            opacity: ctx.selection.size ? 0.1 : Math.min(0.6, 14 / Math.sqrt(Math.max(1, g.rows.length))),
            color: numericColor ? undefined : seriesColor(palette, gi),
        },
        emphasis: { lineStyle: { width: 2.4, opacity: 1 } },
        data: g.rows.map((r) => ({
            value: cols.map((k) => numberOf(r, k) ?? null),
            rowId: r.id,
            name: r.id,
            ...(ctx.selection.has(r.id)
                ? { lineStyle: { opacity: 1, width: 2.2, color: numericColor ? undefined : seriesColor(palette, gi) }, z: 5 }
                : {}),
        })),
        animationDuration: 320,
    }));

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'item',
                formatter: (p: { data?: { rowId?: string } }) => {
                    const row = ctx.rows.find((x) => x.id === p.data?.rowId);
                    return row ? rowTooltip(ctx, row, [...cols, colorKey]) : '';
                },
            },
            legend: legend(t, s, spec.showLegend !== false && !ctx.compact && groups.length > 1),
            parallel: {
                left: 36 * s,
                right: 36 * s,
                top: 30 * s + (spec.title ? 22 * s : 0),
                bottom: 18 * s,
                parallelAxisDefault: { type: 'value', nameLocation: 'end', nameGap: 14 * s },
            },
            parallelAxis: axes,
            series: series as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Funnel
// ---------------------------------------------------------------------------

export function gateLabel(dataset: Dataset, g: Gate): string {
    if (g.label) return g.label;
    const col = column(dataset, g.key);
    const op = g.op === '>=' ? '≥' : g.op === '<=' ? '≤' : g.op === '==' ? '=' : g.op === '!=' ? '≠' : g.op;
    return `${col?.label ?? g.key} ${op} ${fmt(g.value)}`;
}

export function passesGate(row: DatasetRow, g: Gate): boolean {
    const v = numberOf(row, g.key);
    if (v === null) return false;
    switch (g.op) {
        case '>=':
            return v >= g.value;
        case '<=':
            return v <= g.value;
        case '>':
            return v > g.value;
        case '<':
            return v < g.value;
        case '==':
            return v === g.value;
        case '!=':
            return v !== g.value;
    }
}

/** Rows surviving each cumulative gate, in order. */
export function funnelSteps(rows: DatasetRow[], gates: Gate[]): { label: Gate | null; rows: DatasetRow[] }[] {
    const steps: { label: Gate | null; rows: DatasetRow[] }[] = [{ label: null, rows }];
    let current = rows;
    for (const g of gates) {
        current = current.filter((r) => passesGate(r, g));
        steps.push({ label: g, rows: current });
    }
    return steps;
}

function buildFunnel(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    const { dataset, theme: t } = ctx;
    const s = ctx.fontScale;
    const gates = spec.gates ?? [];
    if (gates.length === 0) return { option: {}, empty: 'Adicione um critério para montar o funil.' };
    const steps = funnelSteps(ctx.rows, gates);
    const total = steps[0]!.rows.length || 1;
    const palette = spec.palette ?? DEFAULT_CHART.palette;

    const data = steps.map((st, i) => ({
        name: st.label ? gateLabel(dataset, st.label) : 'todos os designs',
        value: st.rows.length,
        itemStyle: {
            color: i === 0 ? alpha(seriesColor(palette, 0), 0.45) : seriesColor(palette, Math.min(i - 1, 6)),
            borderColor: t.background,
            borderWidth: 2,
            opacity: 0.94,
        },
        dropped: i > 0 ? steps[i - 1]!.rows.length - st.rows.length : 0,
    }));

    return {
        empty: null,
        option: {
            title: titleBlock(spec, t, s, ctx.lettered),
            tooltip: {
                ...tooltipBase(t, s),
                trigger: 'item',
                formatter: (p: { name: string; value: number; data: { dropped: number } }) =>
                    `<div style="font-weight:600;margin-bottom:3px">${p.name}</div><div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${t.textMuted}">sobram</span><span style="font-family:${MONO}">${p.value} · ${((p.value / total) * 100).toFixed(0)}%</span></div>${p.data.dropped ? `<div style="display:flex;gap:12px;justify-content:space-between"><span style="color:${t.textMuted}">reprovados aqui</span><span style="font-family:${MONO}">${p.data.dropped}</span></div>` : ''}`,
            },
            legend: legend(t, s, false),
            series: [
                {
                    type: 'funnel',
                    top: (spec.title ? 30 : 10) * s,
                    bottom: 10 * s,
                    left: '6%',
                    right: '6%',
                    min: 0,
                    max: total,
                    sort: 'none',
                    gap: 3,
                    label: {
                        show: true,
                        position: 'inside',
                        formatter: (p: { name: string; value: number }) => `${p.name}  ·  ${p.value}`,
                        ...textStyle(t, 11 * s),
                        color: '#fff',
                        fontWeight: 500,
                        overflow: 'truncate',
                    },
                    labelLine: { show: false },
                    emphasis: { label: { fontWeight: 700 } },
                    data,
                    animationDuration: 420,
                },
            ] as EChartsOption['series'],
        } as unknown as EChartsOption,
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** True when the spec has everything its type needs. */
export function specReady(spec: ChartSpec): boolean {
    const info = CHART_TYPES[spec.type];
    return info.required.every((r) => (r === 'columns' ? (spec.columns?.length ?? 0) > 0 : r === 'gates' ? (spec.gates?.length ?? 0) > 0 : Boolean(spec[r])));
}

export function buildChart(spec: ChartSpec, ctx: ChartContext): BuiltChart {
    if (!specReady(spec)) {
        const info = CHART_TYPES[spec.type];
        return { option: {}, empty: `Escolha ${info.required.map((r) => (r === 'columns' ? 'as métricas' : r === 'gates' ? 'os critérios' : `o eixo ${r.toUpperCase()}`)).join(' e ')}.` };
    }
    if (ctx.rows.length === 0) return { option: {}, empty: 'Nenhum design passa pelos filtros.' };
    switch (spec.type) {
        case 'scatter':
            return buildScatter(spec, ctx);
        case 'histogram':
            return buildHistogram(spec, ctx);
        case 'violin':
            return buildDistribution(spec, ctx, true);
        case 'box':
            return buildDistribution(spec, ctx, false);
        case 'bar':
            return buildBar(spec, ctx);
        case 'stacked':
            return buildStacked(spec, ctx);
        case 'line':
            return buildLine(spec, ctx);
        case 'heatmap':
            return buildHeatmap(spec, ctx);
        case 'correlation':
            return buildCorrelation(spec, ctx);
        case 'dumbbell':
            return buildDumbbell(spec, ctx);
        case 'parallel':
            return buildParallel(spec, ctx);
        case 'funnel':
            return buildFunnel(spec, ctx);
    }
}

export const chartThemeOf = (id: keyof typeof THEMES): ChartTheme => THEMES[id];
