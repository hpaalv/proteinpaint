/**
 * Reading a dataset folder: parse the table, infer what each column is, and attach
 * each row to its structure file.
 *
 * The pilot layout (pmhc_pkg) is the shape this targets — a table beside
 * `structures/<group>/<design>.cif` — but nothing here requires those names: the
 * table is whichever CSV/TSV has the most rows, and rows find structures by
 * matching the file stem against the id column.
 */

import { platform, type DatasetScan } from '@/platform/bridge';
import type { Column, ColumnKind, Dataset, DatasetRow, LooseStructure } from './types';

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

/** RFC 4180 rows: quoted fields may hold the delimiter, newlines and "" escapes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let i = 0;
    const push = () => {
        row.push(field);
        field = '';
    };
    const endRow = () => {
        push();
        // A trailing newline must not produce a phantom row.
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
    };
    while (i < text.length) {
        const c = text[i]!;
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
                i++;
                continue;
            }
            field += c;
            i++;
            continue;
        }
        if (c === '"' && field === '') {
            quoted = true;
            i++;
            continue;
        }
        if (c === delimiter) {
            push();
            i++;
            continue;
        }
        if (c === '\r') {
            i++;
            continue;
        }
        if (c === '\n') {
            endRow();
            i++;
            continue;
        }
        field += c;
        i++;
    }
    if (field !== '' || row.length) endRow();
    return rows;
}

/** Delimiter that splits the header into the most fields. */
function sniffDelimiter(firstLine: string): string {
    let best = ',';
    let bestCount = 0;
    for (const d of [',', '\t', ';']) {
        const n = parseDelimited(firstLine, d)[0]?.length ?? 0;
        if (n > bestCount) {
            best = d;
            bestCount = n;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Column inference
// ---------------------------------------------------------------------------

const MISSING = new Set(['', 'na', 'nan', 'null', 'none', '-', '--', 'n/a']);

const isMissing = (v: string) => MISSING.has(v.trim().toLowerCase());

/** Accepts 1.5, -2, 1e-3 and the comma decimals of a pt-BR export. */
function toNumber(raw: string): number | null {
    const t = raw.trim();
    if (!t || isMissing(t)) return null;
    const normalized = /^-?\d{1,3}(\.\d{3})+,\d+$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : /^-?\d+,\d+$/.test(t) ? t.replace(',', '.') : t;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

const AMINO = /^[ACDEFGHIKLMNPQRSTVWY]+$/i;

function inferKind(key: string, raw: string[]): ColumnKind {
    const present = raw.filter((v) => !isMissing(v));
    if (present.length === 0) return 'text';
    if (present.every((v) => toNumber(v) !== null)) return 'number';
    // A sequence column: long single-letter amino-acid strings.
    if (present.every((v) => v.length > 20 && AMINO.test(v))) return 'sequence';
    const distinct = new Set(present.map((v) => v.trim()));
    // Comma-separated residue lists ("T4,A5,G6") — shown as chips, not as categories.
    if (present.every((v) => v.includes(',')) && present.some((v) => v.split(',').length > 2)) return 'list';
    if (distinct.size <= Math.max(2, Math.min(64, present.length * 0.5)) && distinct.size <= 64) return 'category';
    return /name|id|design|file|path|seq/i.test(key) ? 'text' : 'category';
}

/** "rp_i_pTM" → group "rp", label "i pTM". Prefix groups are how these tables are organised. */
const GROUP_LABELS: Record<string, string> = {
    rp: 'Reprevisto',
    camp: 'Campanha',
    ret: 'Retenção',
    ctrl: 'Controle',
};

function describe(key: string): { group: string; label: string; unit?: string } {
    const m = /^([a-z]{2,5})_(.+)$/.exec(key);
    const prefix = m?.[1] ?? '';
    const group = GROUP_LABELS[prefix] ?? (m ? prefix : 'Geral');
    const rest = m && GROUP_LABELS[prefix] ? m[2]! : key;
    const label = rest.replace(/_/g, ' ');
    const unit = /area/i.test(key) ? 'Å²' : /rmsd|dist/i.test(key) ? 'Å' : /angle/i.test(key) ? '°' : undefined;
    return { group, label, unit };
}

function buildColumn(key: string, raw: string[]): Column {
    const kind = inferKind(key, raw);
    const { group, label, unit } = describe(key);
    const present = raw.filter((v) => !isMissing(v));
    const col: Column = {
        key,
        label,
        kind,
        count: present.length,
        missing: raw.length ? 1 - present.length / raw.length : 1,
        group,
        ...(kind === 'number' && unit ? { unit } : {}),
    };
    if (kind === 'number') {
        const nums = present.map(toNumber).filter((n): n is number => n !== null);
        if (nums.length) col.range = [Math.min(...nums), Math.max(...nums)];
    }
    if (kind === 'category') {
        const counts = new Map<string, number>();
        for (const v of present) counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
        col.categories = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 64).map(([v]) => v);
    }
    return col;
}

// ---------------------------------------------------------------------------
// Matching rows to structure files
// ---------------------------------------------------------------------------

const stem = (p: string) => p.split('/').pop()!.replace(/\.(pdb|ent|cif|mmcif|bcif|pdbqt)(\.gz)?$/i, '');

/**
 * The id column: the text column whose values match the most structure file names,
 * falling back to the first column with unique values.
 */
function pickIdKey(header: string[], columns: Column[], rows: string[][], stems: Set<string>): string {
    let best = header[0]!;
    let bestScore = -1;
    for (let c = 0; c < header.length; c++) {
        const col = columns[c]!;
        if (col.kind === 'number' || col.kind === 'sequence') continue;
        let matches = 0;
        const seen = new Set<string>();
        for (const r of rows) {
            const v = (r[c] ?? '').trim();
            if (!v) continue;
            seen.add(v);
            if (stems.has(v)) matches++;
        }
        // Uniqueness breaks ties when no file matches at all.
        const score = matches * 1000 + (seen.size === rows.length ? 100 : 0) + seen.size;
        if (score > bestScore) {
            bestScore = score;
            best = header[c]!;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadResult {
    dataset: Dataset;
    /** Other tables found in the folder, for the "trocar tabela" menu. */
    otherTables: string[];
}

/** Reads the dataset of a scanned folder; `tablePath` picks a table other than the default. */
export async function loadDataset(scan: DatasetScan, tablePath?: string): Promise<LoadResult> {
    if (!scan.folder) throw new Error('Nenhuma pasta aberta.');
    if (scan.tables.length === 0) throw new Error('A pasta não tem nenhuma tabela (.csv/.tsv) com os metadados.');

    // Default table: prefer a file named like metrics/metadata, else the largest.
    const preferred = scan.tables.find((t) => /metric|metadata|designs?|summary|table/i.test(t.path));
    const chosen = tablePath ?? (preferred ?? [...scan.tables].sort((a, b) => b.size - a.size)[0]!).path;

    const text = await platform.readText(chosen);
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const table = parseDelimited(text, sniffDelimiter(firstLine));
    if (table.length < 2) throw new Error(`"${chosen.split('/').pop()}" não tem linhas de dados.`);

    const header = table[0]!.map((h, i) => h.trim() || `coluna_${i + 1}`);
    const body = table.slice(1).filter((r) => r.some((v) => v.trim() !== ''));
    const columns = header.map((key, c) => buildColumn(key, body.map((r) => r[c] ?? '')));

    const byStem = new Map<string, string>();
    for (const p of scan.structures) byStem.set(stem(p), p);
    const idKey = pickIdKey(header, columns, body, new Set(byStem.keys()));
    const idIndex = header.indexOf(idKey);

    const rows: DatasetRow[] = body.map((r, index) => {
        const values: Record<string, string | number | null> = {};
        for (let c = 0; c < header.length; c++) {
            const col = columns[c]!;
            const raw = (r[c] ?? '').trim();
            values[col.key] = col.kind === 'number' ? toNumber(raw) : isMissing(raw) ? null : raw;
        }
        const id = (r[idIndex] ?? '').trim() || `linha ${index + 1}`;
        return { id, values, structurePath: byStem.get(id) ?? null, index };
    });

    const claimed = new Set(rows.map((r) => r.structurePath).filter((p): p is string => p !== null));
    const root = scan.folder.replace(/\/$/, '');
    const loose: LooseStructure[] = scan.structures
        .filter((p) => !claimed.has(p))
        .map((path) => {
            const relative = path.startsWith(root) ? path.slice(root.length + 1) : path;
            const parts = relative.split('/');
            return { path, name: stem(path), group: parts.length > 1 ? parts[parts.length - 2]! : 'raiz' };
        });

    const notesPath = scan.docs.find((p) => /notes|readme/i.test(p)) ?? scan.docs[0];
    const notes = notesPath ? await platform.readText(notesPath).catch(() => null) : null;

    return {
        dataset: {
            folder: scan.folder,
            name: scan.folder.split('/').filter(Boolean).pop() ?? 'dados',
            tablePath: chosen,
            columns,
            rows,
            idKey,
            loose,
            matched: claimed.size,
            notes,
        },
        otherTables: scan.tables.map((t) => t.path).filter((p) => p !== chosen),
    };
}
