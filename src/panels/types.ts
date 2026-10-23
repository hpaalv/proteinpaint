/**
 * The figure model: a panel is a grid of cells, each holding a chart, a 3D structure
 * or a block of text (docs/PLAN.md, Fase 5 is the composer; this is its data model).
 *
 * A chart is a `ChartSpec`: the type, which columns feed which encoding, and the
 * presentation choices the user edits in the menus (titles, axis names, palettes,
 * reference lines). Specs are plain JSON so a panel can be saved, duplicated and
 * reapplied to another dataset.
 */

import type { RampId, SeriesPaletteId, ThemeId } from './theme';

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type ChartType =
    | 'scatter'
    | 'histogram'
    | 'violin'
    | 'box'
    | 'bar'
    | 'stacked'
    | 'line'
    | 'heatmap'
    | 'correlation'
    | 'dumbbell'
    | 'parallel'
    | 'funnel';

export type Aggregate = 'mean' | 'median' | 'max' | 'min' | 'count' | 'sum';

export type SortOrder = 'value-desc' | 'value-asc' | 'label' | 'natural';

/** One cutoff of a funnel ("rp_i_pTM ≥ 0.85"). */
export interface Gate {
    key: string;
    op: '>=' | '<=' | '>' | '<' | '==' | '!=';
    value: number;
    /** Shown on the step; defaults to the column label plus the operator. */
    label?: string;
}

export interface ReferenceLine {
    axis: 'x' | 'y';
    value: number;
    label?: string;
    /** Defaults to the theme's reference colour. */
    color?: string;
}

export interface ChartSpec {
    type: ChartType;
    /** Cell heading; empty hides it. */
    title: string;
    subtitle?: string;

    // Encodings — column keys of the dataset.
    /** scatter/line: x axis · histogram: the distribution · bar/violin/box: the category. */
    x?: string;
    /** scatter/line/bar/violin/box/dumbbell: the value. */
    y?: string;
    /** dumbbell: the second value; scatter: optional second series. */
    y2?: string;
    /** Splits into series / groups (a categorical column). */
    group?: string;
    /** Colours points by this column (categorical or numeric). */
    color?: string;
    /** Scales marker area by this numeric column. */
    size?: string;
    /** heatmap/parallel/correlation: several numeric columns at once. */
    columns?: string[];
    /** heatmap: rows are grouped by this categorical column (else one row per design). */
    rowKey?: string;

    // Axes
    xLabel?: string;
    yLabel?: string;
    xLog?: boolean;
    yLog?: boolean;
    /** Fixed axis range; null entries fall back to the data's range. */
    xRange?: [number | null, number | null];
    yRange?: [number | null, number | null];

    // Presentation
    palette?: SeriesPaletteId;
    ramp?: RampId;
    /** Centre a diverging ramp here (retention around 1, Δ around 0). */
    rampCenter?: number | null;
    rampRange?: [number | null, number | null];
    markerSize?: number;
    opacity?: number;
    lineWidth?: number;
    showLegend?: boolean;
    showGrid?: boolean;
    showValues?: boolean;
    /** Label the n most extreme points (scatter) or every bar. */
    labelTop?: number;
    trend?: boolean;
    /** violin: draw the quartile box · box: draw the points as a beeswarm. */
    showBox?: boolean;
    showPoints?: boolean;
    /** line: shade ± standard error around the mean. */
    showBand?: boolean;
    /** bar/line: how repeated category values are reduced. */
    aggregate?: Aggregate;
    sort?: SortOrder;
    /** Draw as percentages of each column's total (stacked). */
    normalize?: boolean;
    /** histogram: bin count; 0 = automatic (Freedman–Diaconis). */
    bins?: number;
    /** Keep only the first n categories/rows (after sorting). */
    limit?: number;
    reference?: ReferenceLine[];
    gates?: Gate[];
    /** Show the correlation coefficient in a corner (scatter/correlation). */
    showStats?: boolean;
    /** correlation: which coefficient. */
    method?: 'pearson' | 'spearman';
}

export interface ChartTypeInfo {
    id: ChartType;
    label: string;
    hint: string;
    /** Encodings the menus should offer, in order. */
    encodings: ('x' | 'y' | 'y2' | 'group' | 'color' | 'size' | 'columns' | 'rowKey')[];
    /** Which encodings must be filled for the chart to draw. */
    required: ('x' | 'y' | 'columns' | 'gates')[];
    /** Kind expected per encoding, to filter the column menus. */
    numeric?: ('x' | 'y' | 'y2')[];
    categorical?: ('x' | 'group' | 'rowKey')[];
}

export const CHART_TYPES: Record<ChartType, ChartTypeInfo> = {
    scatter: {
        id: 'scatter',
        label: 'Dispersão',
        hint: 'Duas métricas por design; cor, tamanho e rótulos opcionais. Arraste para selecionar.',
        encodings: ['x', 'y', 'color', 'size', 'group'],
        required: ['x', 'y'],
        numeric: ['x', 'y'],
    },
    histogram: {
        id: 'histogram',
        label: 'Histograma',
        hint: 'Distribuição de uma métrica, com séries sobrepostas por grupo.',
        encodings: ['x', 'group'],
        required: ['x'],
        numeric: ['x'],
        categorical: ['group'],
    },
    violin: {
        id: 'violin',
        label: 'Violino',
        hint: 'Densidade por grupo com quartis — o violino dos seus painéis.',
        encodings: ['x', 'y'],
        required: ['y'],
        numeric: ['y'],
        categorical: ['x'],
    },
    box: {
        id: 'box',
        label: 'Caixa',
        hint: 'Quartis e bigodes de Tukey por grupo, com os pontos ao lado.',
        encodings: ['x', 'y'],
        required: ['y'],
        numeric: ['y'],
        categorical: ['x'],
    },
    bar: {
        id: 'bar',
        label: 'Barras',
        hint: 'Um valor agregado por categoria, com rótulos e linha de referência.',
        encodings: ['x', 'y', 'group'],
        required: ['x'],
        categorical: ['x', 'group'],
        numeric: ['y'],
    },
    stacked: {
        id: 'stacked',
        label: 'Barras empilhadas',
        hint: 'Composição de cada categoria, em contagem ou porcentagem.',
        encodings: ['x', 'group'],
        required: ['x'],
        categorical: ['x', 'group'],
    },
    line: {
        id: 'line',
        label: 'Linha',
        hint: 'Curva por grupo com marcadores e banda de erro — como a sensibilidade ao cutoff.',
        encodings: ['x', 'y', 'group'],
        required: ['x', 'y'],
        numeric: ['y'],
    },
    heatmap: {
        id: 'heatmap',
        label: 'Heatmap',
        hint: 'Matriz de várias métricas por design ou por grupo (ex.: retenção nos alvos).',
        encodings: ['columns', 'rowKey'],
        required: ['columns'],
        categorical: ['rowKey'],
    },
    correlation: {
        id: 'correlation',
        label: 'Correlação',
        hint: 'Matriz de correlação entre métricas (Pearson ou Spearman).',
        encodings: ['columns'],
        required: ['columns'],
    },
    dumbbell: {
        id: 'dumbbell',
        label: 'Dumbbell',
        hint: 'Duas medidas ligadas por linha — campanha vs reprevisto, antes vs depois.',
        encodings: ['x', 'y', 'y2'],
        required: ['y'],
        numeric: ['y', 'y2'],
        categorical: ['x'],
    },
    parallel: {
        id: 'parallel',
        label: 'Coordenadas paralelas',
        hint: 'Um eixo por métrica, uma linha por design; arraste num eixo para filtrar.',
        encodings: ['columns', 'color'],
        required: ['columns'],
    },
    funnel: {
        id: 'funnel',
        label: 'Funil',
        hint: 'Cortes cumulativos sobre o conjunto — quantos designs sobram a cada critério.',
        encodings: [],
        required: ['gates'],
    },
};

export const DEFAULT_CHART: Required<Pick<ChartSpec, 'palette' | 'ramp' | 'markerSize' | 'opacity' | 'lineWidth' | 'showLegend' | 'showGrid' | 'aggregate' | 'sort'>> = {
    palette: 'okabe-ito',
    ramp: 'ocean',
    markerSize: 9,
    opacity: 0.9,
    lineWidth: 2,
    showLegend: true,
    showGrid: true,
    aggregate: 'mean',
    sort: 'value-desc',
};

// ---------------------------------------------------------------------------
// Structure cells
// ---------------------------------------------------------------------------

export type StructureSource =
    /** Follows the selection: shows the design picked in a chart or the table. */
    | { kind: 'selected' }
    /** A fixed row of the dataset. */
    | { kind: 'row'; rowId: string }
    /** A file from the folder that no row claims (the target, a reference). */
    | { kind: 'file'; path: string };

export interface StructureCellSpec {
    title: string;
    source: StructureSource;
    /** Also load these loose files (targets) behind the design. */
    withFiles: string[];
    /** Look preset applied when the cell loads (engine look.ts). */
    look: string;
    /** Camera from the complex's geometry (engine views.ts), when it can be computed. */
    view: 'side' | 'top' | 'threequarter' | 'groove' | 'back' | 'auto';
    /** Colour scheme for the design's chains. */
    colorBy: 'chain' | 'role' | 'plddt' | 'secondary-structure' | 'uniform';
    /** Surface on the target chains. */
    surface: boolean;
    /** Draw the interface contacts. */
    interface: boolean;
    spin: boolean;
}

export const DEFAULT_STRUCTURE_CELL: StructureCellSpec = {
    title: '',
    source: { kind: 'selected' },
    withFiles: [],
    look: 'white-figure',
    view: 'auto',
    colorBy: 'role',
    surface: false,
    interface: false,
    spin: false,
};

// ---------------------------------------------------------------------------
// Cells and panels
// ---------------------------------------------------------------------------

export interface TextCellSpec {
    text: string;
    size: number;
    align: 'left' | 'center';
    /** Renders the text as the panel's caption style (muted, smaller). */
    caption: boolean;
}

export type CellContent =
    | { kind: 'chart'; chart: ChartSpec }
    | { kind: 'structure'; structure: StructureCellSpec }
    | { kind: 'text'; text: TextCellSpec }
    | { kind: 'empty' };

export interface Cell {
    id: string;
    /** Grid placement, in columns/rows of the panel grid (0-based). */
    x: number;
    y: number;
    w: number;
    h: number;
    content: CellContent;
}

export interface Panel {
    id: string;
    title: string;
    subtitle: string;
    /** Grid size; cells are placed inside it. */
    cols: number;
    rows: number;
    gap: number;
    theme: ThemeId;
    /** Export background: the theme's colour, white or transparent. */
    background: 'theme' | 'white' | 'transparent';
    /** Letter each cell (A, B, C…) as figure panels do. */
    letters: boolean;
    cells: Cell[];
    /** Figure width in mm, for export at a chosen dpi. */
    widthMm: number;
    created: number;
}

export function newId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyPanel(title = 'Painel 1'): Panel {
    return {
        id: newId('panel'),
        title,
        subtitle: '',
        cols: 2,
        rows: 2,
        gap: 12,
        theme: 'dark',
        background: 'theme',
        letters: false,
        cells: [],
        widthMm: 180,
        created: Date.now(),
    };
}

/** The first free rectangle of `w`×`h` in the grid, or null when the panel is full. */
export function findSlot(panel: Panel, w = 1, h = 1): { x: number; y: number } | null {
    const taken = (x: number, y: number) => panel.cells.some((c) => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h);
    for (let y = 0; y + h <= panel.rows; y++) {
        for (let x = 0; x + w <= panel.cols; x++) {
            let free = true;
            for (let dy = 0; dy < h && free; dy++) for (let dx = 0; dx < w && free; dx++) if (taken(x + dx, y + dy)) free = false;
            if (free) return { x, y };
        }
    }
    return null;
}

export function cellLetter(panel: Panel, cellId: string): string {
    // Reading order, so the letters follow how the figure is read.
    const ordered = [...panel.cells].sort((a, b) => a.y - b.y || a.x - b.x);
    const i = ordered.findIndex((c) => c.id === cellId);
    return i < 0 ? '' : String.fromCharCode(65 + i);
}
