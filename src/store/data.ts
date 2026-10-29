/**
 * State of the data workspace: the open dataset, the filters applied to it, the
 * selection shared by every chart and 3D cell, and the panels being composed.
 *
 * Selection is by row id and lives here rather than in a chart, which is what makes
 * clicking a point in one chart highlight the same design everywhere and load its
 * structure in the panel's 3D cells.
 */

import { create } from 'zustand';
import type { Dataset, DatasetRow, Filter } from '@/dataset/types';
import { applyFilters } from '@/dataset/types';
import { loadDataset } from '@/dataset/load';
import { platform, type DatasetScan } from '@/platform/bridge';
import { emptyPanel, findSlot, newId, type Cell, type CellContent, type ChartSpec, type Panel, type StructureCellSpec } from '@/panels/types';
import { DEFAULT_STRUCTURE_CELL } from '@/panels/types';
import { toast, useApp } from './app';

export interface DataState {
    dataset: Dataset | null;
    /** Scan of the folder, kept so another table can be loaded without re-picking. */
    scan: DatasetScan | null;
    otherTables: string[];
    loading: boolean;
    error: string | null;

    filters: Filter[];
    /** Row ids selected; empty means "all", and charts stop dimming. */
    selection: Set<string>;
    /** Row under the cursor, for cross-chart highlight. */
    hovered: string | null;
    /** Row whose structure the 3D cells follow (the last one clicked). */
    focused: string | null;
    /**
     * Design each "follows the selection" 3D cell shows, by cell id. With two or more
     * such cells a click goes to one of them (`structureTarget`), so each can hold a
     * different design; a cell absent here shows `focused`.
     */
    cellRows: Record<string, string>;
    /** The 3D cell the next clicked design opens in: the last one the user picked. */
    structureTarget: string | null;
    /** What a click in each 3D cell does — browsing state, not part of the figure. */
    cellPointer: Record<string, 'select' | 'explore'>;

    panels: Panel[];
    activePanelId: string | null;
    /** Cell being edited in the inspector. */
    activeCellId: string | null;
    /** Table drawer under the panel. */
    tableOpen: boolean;
    tableHeight: number;
    /** Column shown in the table's extra numeric column list. */
    tableSort: { key: string; dir: 'asc' | 'desc' } | null;
    /** An export is rendering; the button shows a spinner. */
    exporting: boolean;
}

export const useData = create<DataState>(() => ({
    dataset: null,
    scan: null,
    otherTables: [],
    loading: false,
    error: null,
    filters: [],
    selection: new Set(),
    hovered: null,
    focused: null,
    cellRows: {},
    structureTarget: null,
    cellPointer: {},
    panels: [],
    activePanelId: null,
    activeCellId: null,
    tableOpen: true,
    tableHeight: 240,
    tableSort: null,
    exporting: false,
}));

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

/** Rows after the global filters — what every chart draws. */
export function filteredRows(state: DataState = useData.getState()): DatasetRow[] {
    if (!state.dataset) return [];
    return applyFilters(state.dataset.rows, state.filters, state.dataset.idKey);
}

export function activePanel(state: DataState = useData.getState()): Panel | null {
    return state.panels.find((p) => p.id === state.activePanelId) ?? null;
}

export function activeCell(state: DataState = useData.getState()): Cell | null {
    const panel = activePanel(state);
    return panel?.cells.find((c) => c.id === state.activeCellId) ?? null;
}

export function rowById(id: string | null): DatasetRow | null {
    if (!id) return null;
    return useData.getState().dataset?.rows.find((r) => r.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Opening a dataset
// ---------------------------------------------------------------------------

export async function openDatasetFolder(): Promise<void> {
    const scan = await platform.openDataset();
    if (!scan.folder) return;
    await adoptScan(scan);
}

/** Opens a folder already known (drag and drop, or the structure mode's folder). */
export async function openDatasetPath(folder: string): Promise<void> {
    const scan = await platform.scanDataset(folder);
    if (!scan.folder) return;
    await adoptScan(scan);
}

async function adoptScan(scan: DatasetScan, tablePath?: string): Promise<void> {
    useData.setState({ loading: true, error: null });
    try {
        const { dataset, otherTables } = await loadDataset(scan, tablePath);
        const panel = starterPanel(dataset);
        useData.setState({
            dataset,
            scan,
            otherTables,
            loading: false,
            filters: [],
            selection: new Set(),
            hovered: null,
            focused: dataset.rows[0]?.id ?? null,
            cellRows: {},
            structureTarget: null,
            panels: [panel],
            activePanelId: panel.id,
            activeCellId: panel.cells[0]?.id ?? null,
        });
        toast(`${dataset.rows.length} designs · ${dataset.columns.length} colunas · ${dataset.matched} com estrutura`, 'ok', 3500);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        useData.setState({ loading: false, error: message });
        toast(message, 'error');
    }
}

/** Switches to another table in the same folder. */
export async function useTable(path: string): Promise<void> {
    const scan = useData.getState().scan;
    if (scan) await adoptScan(scan, path);
}

export function closeDataset(): void {
    useData.setState({ dataset: null, scan: null, otherTables: [], filters: [], selection: new Set(), panels: [], activePanelId: null, activeCellId: null, focused: null, cellRows: {}, structureTarget: null });
}

// ---------------------------------------------------------------------------
// A first panel that already says something about the data
// ---------------------------------------------------------------------------

/** Picks the most promising numeric columns: well populated, with spread. */
function interestingNumeric(dataset: Dataset, n: number): string[] {
    return dataset.columns
        .filter((c) => c.kind === 'number' && c.missing < 0.3 && c.range && c.range[1] > c.range[0])
        .sort((a, b) => a.missing - b.missing)
        .slice(0, n)
        .map((c) => c.key);
}

function pick(dataset: Dataset, ...patterns: RegExp[]): string | undefined {
    for (const p of patterns) {
        const hit = dataset.columns.find((c) => c.kind === 'number' && p.test(c.key));
        if (hit) return hit.key;
    }
    return undefined;
}

/**
 * The opening figure: a scatter of the two headline metrics, the distribution of a
 * third by arm, and the design itself in 3D. It is a starting point to edit, not a
 * fixed report.
 */
export function starterPanel(dataset: Dataset): Panel {
    const panel = emptyPanel('Visão geral');
    panel.cols = 2;
    panel.rows = 2;
    const numeric = interestingNumeric(dataset, 6);
    const x = pick(dataset, /area/i, /ires|contact/i) ?? numeric[0];
    const y = pick(dataset, /i_ptm|iptm|ptm/i, /score|plddt/i) ?? numeric[1] ?? numeric[0];
    const color = pick(dataset, /i_pae|pae/i) ?? numeric[2];
    const category = dataset.columns.find((c) => c.kind === 'category' && (c.categories?.length ?? 0) > 1 && (c.categories?.length ?? 0) <= 12);

    const cells: Cell[] = [];
    if (x && y) {
        cells.push({
            id: newId('cell'),
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            content: {
                kind: 'chart',
                chart: {
                    type: 'scatter',
                    title: 'Panorama',
                    x,
                    y,
                    color,
                    showLegend: true,
                    showStats: true,
                    trend: false,
                    labelTop: 0,
                } as ChartSpec,
            },
        });
    }
    if (y) {
        cells.push({
            id: newId('cell'),
            x: 1,
            y: 0,
            w: 1,
            h: 1,
            content: {
                kind: 'chart',
                chart: category
                    ? ({ type: 'violin', title: `${dataset.columns.find((c) => c.key === y)?.label ?? y} por ${category.label}`, x: category.key, y, showPoints: true, showBox: true } as ChartSpec)
                    : ({ type: 'histogram', title: 'Distribuição', x: y } as ChartSpec),
            },
        });
    }
    cells.push({
        id: newId('cell'),
        x: 0,
        y: 1,
        w: 1,
        h: 1,
        content: { kind: 'structure', structure: { ...DEFAULT_STRUCTURE_CELL, title: 'Design selecionado', look: 'soft' } },
    });
    const ret = dataset.columns.filter((c) => c.kind === 'number' && /^ret_/.test(c.key)).map((c) => c.key);
    cells.push({
        id: newId('cell'),
        x: 1,
        y: 1,
        w: 1,
        h: 1,
        content: {
            kind: 'chart',
            chart:
                ret.length >= 2
                    ? ({ type: 'heatmap', title: 'Retenção por alvo', columns: ret, ramp: 'blue-red', rampCenter: 1, limit: 30 } as ChartSpec)
                    : ({ type: 'correlation', title: 'Correlação entre métricas', columns: numeric.slice(0, 6), showValues: true } as ChartSpec),
        },
    });
    panel.cells = cells;
    return panel;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function setSelection(ids: Iterable<string>): void {
    const set = new Set(ids);
    useData.setState({ selection: set });
}

export function toggleSelected(id: string, additive: boolean): void {
    useData.setState((s) => {
        const next = new Set(additive ? s.selection : []);
        if (additive && s.selection.has(id)) next.delete(id);
        else next.add(id);
        return { selection: next, ...routeFocus(s, id) };
    });
}

/** The 3D cells of the active panel that follow the clicked design. */
function followingCells(s: DataState): Cell[] {
    return activePanel(s)?.cells.filter((c) => c.content.kind === 'structure' && c.content.structure.source.kind === 'selected') ?? [];
}

export function followingCount(s: DataState = useData.getState()): number {
    return followingCells(s).length;
}

/** The 3D cell a clicked design opens in, when there is more than one to choose from. */
export function receivingCell(s: DataState = useData.getState()): string | null {
    const cells = followingCells(s);
    if (cells.length === 0) return null;
    return cells.find((c) => c.id === s.structureTarget)?.id ?? cells[0]!.id;
}

/** State change for "this design was clicked": it becomes focused and opens in one 3D cell. */
function routeFocus(s: DataState, id: string): Pick<DataState, 'focused' | 'cellRows'> {
    const target = receivingCell(s);
    if (!target) return { focused: id, cellRows: s.cellRows };
    // The other cells keep what they show now; one that only followed the focus so far
    // would otherwise change along with the target.
    const cellRows = { ...s.cellRows };
    for (const c of followingCells(s)) if (!(c.id in cellRows) && s.focused) cellRows[c.id] = s.focused;
    cellRows[target] = id;
    return { focused: id, cellRows };
}

export function clearSelection(): void {
    useData.setState({ selection: new Set() });
}

export function setHovered(id: string | null): void {
    if (useData.getState().hovered !== id) useData.setState({ hovered: id });
}

/** The design a 3D cell shows, or null for a loose file / nothing. */
export function cellRowId(s: DataState, cellId: string, spec: StructureCellSpec): string | null {
    if (spec.source.kind === 'row') return spec.source.rowId;
    if (spec.source.kind === 'selected') return s.cellRows[cellId] ?? s.focused;
    return null;
}

export function setCellPointer(cellId: string, mode: 'select' | 'explore'): void {
    useData.setState((s) => ({ cellPointer: { ...s.cellPointer, [cellId]: mode } }));
}

export function focusRow(id: string): void {
    useData.setState((s) => routeFocus(s, id));
}

/** Focuses the first of a brushed set of designs. */
export function selectBrushed(ids: Set<string>): void {
    const first = [...ids][0];
    useData.setState((s) => ({ selection: ids, ...(first ? routeFocus(s, first) : {}) }));
}

/** Keeps only the selected designs, as a filter, and clears the selection. */
export function keepSelection(): void {
    const { selection, dataset } = useData.getState();
    if (!dataset || selection.size === 0) return;
    const ids = [...selection];
    useData.setState((s) => ({
        filters: [...s.filters, { kind: 'categories', key: dataset.idKey, values: ids }],
        selection: new Set(),
    }));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export function addFilter(filter: Filter): void {
    useData.setState((s) => ({ filters: [...s.filters.filter((f) => !(f.kind === filter.kind && 'key' in f && 'key' in filter && f.key === filter.key)), filter] }));
}

export function removeFilter(index: number): void {
    useData.setState((s) => ({ filters: s.filters.filter((_, i) => i !== index) }));
}

export function clearFilters(): void {
    useData.setState({ filters: [] });
}

// ---------------------------------------------------------------------------
// Panels and cells
// ---------------------------------------------------------------------------

function updatePanel(id: string, fn: (p: Panel) => Panel): void {
    useData.setState((s) => ({ panels: s.panels.map((p) => (p.id === id ? fn(p) : p)) }));
}

export function patchPanel(patch: Partial<Panel>): void {
    const id = useData.getState().activePanelId;
    if (!id) return;
    updatePanel(id, (p) => {
        const next = { ...p, ...patch };
        // A 3D cell still on a theme's default look follows the theme; an explicit
        // choice (Glossy, Goodsell…) is never overwritten.
        if (patch.theme && patch.theme !== p.theme) {
            const from = p.theme === 'dark' ? 'soft' : 'white-figure';
            const to = patch.theme === 'dark' ? 'soft' : 'white-figure';
            next.cells = p.cells.map((c) => (c.content.kind === 'structure' && c.content.structure.look === from ? { ...c, content: { kind: 'structure', structure: { ...c.content.structure, look: to } } } : c));
        }
        return next;
    });
}

export function addPanel(): void {
    const dataset = useData.getState().dataset;
    const panel = emptyPanel(`Painel ${useData.getState().panels.length + 1}`);
    if (dataset) panel.theme = activePanel()?.theme ?? 'dark';
    useData.setState((s) => ({ panels: [...s.panels, panel], activePanelId: panel.id, activeCellId: null }));
}

export function duplicatePanel(): void {
    const panel = activePanel();
    if (!panel) return;
    const copy: Panel = {
        ...panel,
        id: newId('panel'),
        title: `${panel.title} (cópia)`,
        created: Date.now(),
        cells: panel.cells.map((c) => ({ ...c, id: newId('cell') })),
    };
    useData.setState((s) => ({ panels: [...s.panels, copy], activePanelId: copy.id }));
}

export function removePanel(id: string): void {
    useData.setState((s) => {
        const panels = s.panels.filter((p) => p.id !== id);
        return { panels, activePanelId: s.activePanelId === id ? (panels[0]?.id ?? null) : s.activePanelId };
    });
}

export function selectPanel(id: string): void {
    useData.setState({ activePanelId: id, activeCellId: null });
}

export function addCell(content: CellContent, size: { w: number; h: number } = { w: 1, h: 1 }): void {
    const panel = activePanel();
    if (!panel) return;
    let next = panel;
    let slot = findSlot(next, size.w, size.h);
    // Grow downwards rather than refusing: a panel is never "full".
    if (!slot) {
        next = { ...next, rows: next.rows + size.h };
        slot = findSlot(next, size.w, size.h) ?? { x: 0, y: next.rows - size.h };
    }
    const cell: Cell = { id: newId('cell'), x: slot.x, y: slot.y, w: size.w, h: size.h, content };
    updatePanel(panel.id, (p) => ({ ...next, cells: [...p.cells, cell] }));
    useData.setState({ activeCellId: cell.id });
}

export function addChartCell(spec: Partial<ChartSpec> & { type: ChartSpec['type'] }): void {
    addCell({ kind: 'chart', chart: { title: '', ...spec } as ChartSpec });
}

export function addStructureCell(patch: Partial<StructureCellSpec> = {}): void {
    // A 3D cell keeps its own background, so start it from the look that matches the panel.
    const look = activePanel()?.theme === 'dark' ? 'soft' : 'white-figure';
    addCell({ kind: 'structure', structure: { ...DEFAULT_STRUCTURE_CELL, look, ...patch } });
}

export function updateCell(cellId: string, fn: (c: Cell) => Cell): void {
    const panel = activePanel();
    if (!panel) return;
    updatePanel(panel.id, (p) => ({ ...p, cells: p.cells.map((c) => (c.id === cellId ? fn(c) : c)) }));
}

/** Patches the chart spec of a cell — what every control in the inspector calls. */
export function patchChart(cellId: string, patch: Partial<ChartSpec>): void {
    updateCell(cellId, (c) => (c.content.kind === 'chart' ? { ...c, content: { kind: 'chart', chart: { ...c.content.chart, ...patch } } } : c));
}

export function patchStructure(cellId: string, patch: Partial<StructureCellSpec>): void {
    updateCell(cellId, (c) => (c.content.kind === 'structure' ? { ...c, content: { kind: 'structure', structure: { ...c.content.structure, ...patch } } } : c));
}

export function patchText(cellId: string, patch: Partial<{ text: string; size: number; align: 'left' | 'center'; caption: boolean }>): void {
    updateCell(cellId, (c) => (c.content.kind === 'text' ? { ...c, content: { kind: 'text', text: { ...c.content.text, ...patch } } } : c));
}

export function removeCell(cellId: string): void {
    const panel = activePanel();
    if (!panel) return;
    updatePanel(panel.id, (p) => ({ ...p, cells: p.cells.filter((c) => c.id !== cellId) }));
    useData.setState((s) => ({ activeCellId: s.activeCellId === cellId ? null : s.activeCellId }));
}

export function duplicateCell(cellId: string): void {
    const panel = activePanel();
    const cell = panel?.cells.find((c) => c.id === cellId);
    if (!panel || !cell) return;
    const slot = findSlot(panel, cell.w, cell.h);
    const copy: Cell = { ...cell, id: newId('cell'), ...(slot ?? { x: cell.x, y: panel.rows }) };
    const rows = slot ? panel.rows : panel.rows + cell.h;
    updatePanel(panel.id, (p) => ({ ...p, rows, cells: [...p.cells, copy] }));
    useData.setState({ activeCellId: copy.id });
}

export function moveCell(cellId: string, to: { x: number; y: number; w?: number; h?: number }): void {
    const panel = activePanel();
    if (!panel) return;
    const cell = panel.cells.find((c) => c.id === cellId);
    if (!cell) return;
    const w = to.w ?? cell.w;
    const h = to.h ?? cell.h;
    const x = Math.max(0, Math.min(panel.cols - w, to.x));
    const y = Math.max(0, Math.min(panel.rows - h, to.y));
    // Cells swap rather than overlap: dropping onto an occupied slot moves the other one here.
    const occupant = panel.cells.find((c) => c.id !== cellId && x < c.x + c.w && x + w > c.x && y < c.y + c.h && y + h > c.y);
    updatePanel(panel.id, (p) => ({
        ...p,
        cells: p.cells.map((c) => (c.id === cellId ? { ...c, x, y, w, h } : occupant && c.id === occupant.id ? { ...c, x: cell.x, y: cell.y, w: Math.min(cell.w, p.cols - cell.x), h: Math.min(cell.h, p.rows - cell.y) } : c)),
    }));
}

export function selectCell(cellId: string | null): void {
    useData.setState((s) => {
        const cell = activePanel(s)?.cells.find((c) => c.id === cellId);
        const follows = cell?.content.kind === 'structure' && cell.content.structure.source.kind === 'selected';
        return { activeCellId: cellId, ...(follows && { structureTarget: cellId }) };
    });
}

// ---------------------------------------------------------------------------
// Workspace switch
// ---------------------------------------------------------------------------

/** The data workspace needs its own chrome; the structure one keeps the viewport. */
export function setWorkspace(workspace: 'structure' | 'data'): void {
    useApp.setState({ workspace });
}
