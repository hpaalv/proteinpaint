/**
 * Exporting a panel as one image.
 *
 * Each cell is rendered at the output resolution — charts through ECharts'
 * `getDataURL`, 3D cells through the engine's off-screen pass (the same one the
 * figure tab uses, with supersampling), text drawn with the 2D context — and the
 * pieces are composed on a canvas laid out exactly like the grid on screen.
 *
 * Everything is drawn on a transparent canvas first and the background is painted
 * underneath, so "fundo transparente" needs no second code path.
 */

import type { ECharts } from 'echarts';
import * as E from '@/engine';
import { THEMES } from './theme';
import { cellLetter, type Cell, type Panel } from './types';
import { FONT } from './theme';

export interface PanelExportOptions {
    /** Figure width in millimetres. */
    widthMm: number;
    dpi: number;
    /** Overrides the panel's own background choice. */
    background?: 'theme' | 'white' | 'transparent';
    /** Heading drawn above the grid. */
    includeTitle: boolean;
}

export interface CellRenderers {
    /** ECharts instance of a chart cell. */
    chart: (cellId: string) => ECharts | undefined;
    /** Viewer of a 3D cell. */
    structure: (cellId: string) => E.Viewer | undefined;
}

const mmToPx = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);

/** Aspect ratio of the panel as composed on screen (grid rows × cell aspect). */
function panelHeightPx(panel: Panel, widthPx: number): number {
    // Cells are laid out on a uniform grid, so the panel's aspect follows the grid's.
    const cellW = (widthPx - panel.gap * (panel.cols + 1)) / panel.cols;
    const cellH = cellW * 0.78;
    return Math.round(cellH * panel.rows + panel.gap * (panel.rows + 1));
}

async function drawChart(ctx: CanvasRenderingContext2D, chart: ECharts, x: number, y: number, w: number, h: number, scale: number): Promise<void> {
    // Re-render the chart at the export size so text and lines are crisp rather than
    // an upscaled screenshot of the cell.
    const previous = { width: chart.getWidth(), height: chart.getHeight() };
    try {
        chart.resize({ width: Math.round(w / scale), height: Math.round(h / scale), silent: true });
        const url = chart.getDataURL({ type: 'png', pixelRatio: scale, backgroundColor: 'transparent', excludeComponents: ['toolbox', 'brush'] });
        const img = await loadImage(url);
        ctx.drawImage(img, x, y, w, h);
    } finally {
        chart.resize({ width: previous.width, height: previous.height, silent: true });
    }
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Falha ao ler a imagem do gráfico.'));
        img.src = url;
    });
}

async function drawStructure(ctx: CanvasRenderingContext2D, viewer: E.Viewer, x: number, y: number, w: number, h: number, forceTransparent: boolean): Promise<void> {
    const look = E.getLook(viewer);
    // On a transparent panel the 3D cell drops its own background too, otherwise a
    // dark card sits in the middle of an otherwise transparent figure.
    const transparent = forceTransparent || look.background.kind === 'transparent';
    const result = await E.renderImage(viewer, { width: Math.round(w), transparent, cropToMolecule: false, supersample: 2, matchScreen: true });
    if (!result.ok) return;
    const img = await loadImage(result.value.dataUrl);
    // The off-screen render keeps the viewport's aspect; cover the cell and centre it.
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(/\s+/)) {
            const candidate = line ? `${line} ${word}` : word;
            if (ctx.measureText(candidate).width > maxWidth && line) {
                lines.push(line);
                line = word;
            } else line = candidate;
        }
        lines.push(line);
    }
    return lines;
}

export interface ExportResult {
    dataUrl: string;
    width: number;
    height: number;
}

export async function renderPanel(panel: Panel, options: PanelExportOptions, renderers: CellRenderers): Promise<ExportResult> {
    const theme = THEMES[panel.theme];
    const background = options.background ?? panel.background;
    const width = Math.min(12000, Math.max(300, mmToPx(options.widthMm, options.dpi)));
    const scale = width / 1000;
    const gap = Math.round(panel.gap * scale * 1.6);
    const titleHeight = options.includeTitle && (panel.title || panel.subtitle) ? Math.round(46 * scale) : 0;
    const gridHeight = panelHeightPx(panel, width);
    const height = gridHeight + titleHeight;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    if (background !== 'transparent') {
        ctx.fillStyle = background === 'white' ? '#ffffff' : theme.background;
        ctx.fillRect(0, 0, width, height);
    }

    if (titleHeight) {
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = background === 'white' ? '#1d232e' : theme.text;
        ctx.font = `600 ${Math.round(22 * scale)}px ${FONT}`;
        ctx.fillText(panel.title, gap, Math.round(26 * scale));
        if (panel.subtitle) {
            ctx.fillStyle = background === 'white' ? '#5b6675' : theme.textMuted;
            ctx.font = `400 ${Math.round(15 * scale)}px ${FONT}`;
            ctx.fillText(panel.subtitle, gap, Math.round(44 * scale));
        }
    }

    const cellW = (width - gap * (panel.cols + 1)) / panel.cols;
    const cellH = (gridHeight - gap * (panel.rows + 1)) / panel.rows;
    const place = (c: Cell) => ({
        x: gap + c.x * (cellW + gap),
        y: titleHeight + gap + c.y * (cellH + gap),
        w: c.w * cellW + (c.w - 1) * gap,
        h: c.h * cellH + (c.h - 1) * gap,
    });

    // Cell surfaces, so a chart on a themed panel keeps its card background.
    if (background !== 'transparent' && theme.surface !== theme.background) {
        for (const cell of panel.cells) {
            if (cell.content.kind === 'structure') continue;
            const r = place(cell);
            ctx.fillStyle = background === 'white' ? '#ffffff' : theme.surface;
            ctx.fillRect(r.x, r.y, r.w, r.h);
        }
    }

    for (const cell of panel.cells) {
        const r = place(cell);
        if (cell.content.kind === 'chart') {
            const chart = renderers.chart(cell.id);
            if (chart) await drawChart(ctx, chart, r.x, r.y, r.w, r.h, Math.max(1, scale * 1.6));
        } else if (cell.content.kind === 'structure') {
            const viewer = renderers.structure(cell.id);
            if (viewer) await drawStructure(ctx, viewer, r.x, r.y, r.w, r.h, background === 'transparent');
            const title = cell.content.structure.title;
            if (title) {
                ctx.fillStyle = background === 'white' ? '#1d232e' : theme.text;
                ctx.font = `600 ${Math.round(15 * scale)}px ${FONT}`;
                ctx.textAlign = 'center';
                ctx.fillText(title, r.x + r.w / 2, r.y + Math.round(20 * scale));
                ctx.textAlign = 'left';
            }
        } else if (cell.content.kind === 'text') {
            const spec = cell.content.text;
            const size = Math.round(spec.size * scale * 1.35);
            ctx.font = `${spec.caption ? 400 : 500} ${size}px ${FONT}`;
            ctx.fillStyle = spec.caption ? (background === 'white' ? '#5b6675' : theme.textMuted) : background === 'white' ? '#1d232e' : theme.text;
            ctx.textAlign = spec.align === 'center' ? 'center' : 'left';
            const pad = Math.round(10 * scale);
            const lines = wrapText(ctx, spec.text, r.w - pad * 2);
            const lineHeight = size * 1.5;
            let y = r.y + r.h / 2 - ((lines.length - 1) * lineHeight) / 2;
            for (const line of lines) {
                ctx.fillText(line, spec.align === 'center' ? r.x + r.w / 2 : r.x + pad, y);
                y += lineHeight;
            }
            ctx.textAlign = 'left';
        }

        if (panel.letters) {
            ctx.fillStyle = background === 'white' ? '#1d232e' : theme.text;
            ctx.font = `700 ${Math.round(19 * scale)}px ${FONT}`;
            ctx.fillText(cellLetter(panel, cell.id), r.x + Math.round(6 * scale), r.y + Math.round(22 * scale));
        }
    }

    return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/** One chart cell on its own, at figure resolution. */
export async function renderChartCell(chart: ECharts, widthMm: number, dpi: number, transparent: boolean, background: string): Promise<ExportResult> {
    const width = Math.min(12000, Math.max(300, mmToPx(widthMm, dpi)));
    const scale = Math.max(1, width / chart.getWidth());
    const previous = { width: chart.getWidth(), height: chart.getHeight() };
    try {
        const url = chart.getDataURL({ type: 'png', pixelRatio: scale, backgroundColor: transparent ? 'transparent' : background, excludeComponents: ['toolbox', 'brush'] });
        const img = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        if (!transparent) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0);
        return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    } finally {
        chart.resize({ width: previous.width, height: previous.height, silent: true });
    }
}

/** The panel's rows as CSV — the numbers behind the figure. */
export function panelCsv(headers: string[], rows: (string | number | null)[][]): string {
    const escape = (v: string | number | null) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
}
