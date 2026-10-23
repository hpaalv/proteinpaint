/**
 * A dataset is one table of designs plus the structure files that belong to its rows
 * (docs/PLAN.md, Fase 4). The table is the source of truth for everything the charts
 * draw; structures are attached per row so clicking a point can open the design.
 *
 * Nothing here knows about ECharts or Mol*: panels/ turns a dataset into figures,
 * the engine opens the files.
 */

export type ColumnKind = 'number' | 'category' | 'text' | 'sequence' | 'list';

export interface Column {
    /** Name as it appears in the file header. */
    key: string;
    /** Shown in menus and as the default axis title. */
    label: string;
    kind: ColumnKind;
    /** Distinct values, for categorical columns (sorted, at most 64 kept). */
    categories?: string[];
    /** [min, max] over finite values, for numeric columns. */
    range?: [number, number];
    /** Rows with a usable value. */
    count: number;
    /** Fraction of rows that are missing. */
    missing: number;
    /** Column groups by prefix convention ("rp_", "ret_", "camp_"…), for the column list. */
    group: string;
    /** Unit or hint shown next to the label, when one can be inferred. */
    unit?: string;
}

export interface DatasetRow {
    /** Stable id — the first text column (design name) when unique, else the row index. */
    id: string;
    /** Raw values, by column key. Numbers are already parsed. */
    values: Record<string, string | number | null>;
    /** Structure file for this row, when one matched. */
    structurePath: string | null;
    /** Position in the file, for stable ordering. */
    index: number;
}

/** A structure file in the folder that no row claims — targets, references. */
export interface LooseStructure {
    path: string;
    name: string;
    /** Folder name under the dataset root ("targets", "binders"…). */
    group: string;
}

export interface Dataset {
    /** Folder opened. */
    folder: string;
    name: string;
    /** Table file the rows came from. */
    tablePath: string;
    columns: Column[];
    rows: DatasetRow[];
    /** Column holding the row id / design name. */
    idKey: string;
    /** Structures not matched to a row (targets, references), by file. */
    loose: LooseStructure[];
    /** Rows that matched a structure file. */
    matched: number;
    /** Notes file found next to the table (NOTES.md / README.md), as text. */
    notes: string | null;
}

export const numericColumns = (d: Dataset): Column[] => d.columns.filter((c) => c.kind === 'number');
export const categoricalColumns = (d: Dataset): Column[] => d.columns.filter((c) => c.kind === 'category');

export function column(d: Dataset, key: string | null | undefined): Column | undefined {
    return key ? d.columns.find((c) => c.key === key) : undefined;
}

/** Numeric value of a cell, or null when missing / not numeric. */
export function numberOf(row: DatasetRow, key: string): number | null {
    const v = row.values[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function stringOf(row: DatasetRow, key: string): string {
    const v = row.values[key];
    return v === null || v === undefined ? '' : String(v);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type Filter =
    | { kind: 'range'; key: string; min: number; max: number }
    | { kind: 'categories'; key: string; values: string[] }
    | { kind: 'search'; text: string };

export function filterLabel(d: Dataset, f: Filter): string {
    if (f.kind === 'search') return `texto "${f.text}"`;
    const label = column(d, f.key)?.label ?? f.key;
    if (f.kind === 'range') return `${label} ${f.min.toLocaleString('pt-BR')} – ${f.max.toLocaleString('pt-BR')}`;
    return `${label}: ${f.values.length > 3 ? `${f.values.length} valores` : f.values.join(', ')}`;
}

export function passes(row: DatasetRow, f: Filter, idKey: string): boolean {
    switch (f.kind) {
        case 'range': {
            const v = numberOf(row, f.key);
            return v !== null && v >= f.min && v <= f.max;
        }
        case 'categories':
            return f.values.length === 0 || f.values.includes(stringOf(row, f.key));
        case 'search': {
            const needle = f.text.trim().toLowerCase();
            if (!needle) return true;
            if (stringOf(row, idKey).toLowerCase().includes(needle)) return true;
            return Object.values(row.values).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
        }
    }
}

export function applyFilters(rows: DatasetRow[], filters: Filter[], idKey: string): DatasetRow[] {
    if (filters.length === 0) return rows;
    return rows.filter((r) => filters.every((f) => passes(r, f, idKey)));
}
