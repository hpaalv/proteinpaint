import type { ReactNode } from 'react';
import * as E from '@/engine';
import { intToHex } from '@/data/palettes';
import { run, useApp, viewer } from '@/store/app';
import { cx } from '../../components/Primitives';

export function Card({ label, value, unit, tone, hint }: { label: string; value: string | number | null | undefined; unit?: string; tone?: string; hint?: string }) {
    const shown = value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value)) ? '—' : value;
    return (
        <div className="min-w-[96px] rounded-md border border-stroke bg-bg-0 px-2 py-1.5" title={hint}>
            <div className="tnum text-[16px] leading-tight font-semibold" style={tone ? { color: tone } : undefined}>
                {shown}
                {unit && shown !== '—' && <span className="ml-0.5 text-[10px] font-normal text-text-2">{unit}</span>}
            </div>
            <div className="text-[10px] leading-tight text-text-2">{label}</div>
        </div>
    );
}

export const fmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

export function Pane({ title, children, actions, className }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
    return (
        <div className={cx('flex min-h-0 flex-col rounded-md border border-stroke bg-bg-1', className)}>
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-stroke px-2">
                <span className="flex-1 truncate text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">{title}</span>
                {actions}
            </div>
            <div className="scroll-themed min-h-0 flex-1 overflow-auto p-2">{children}</div>
        </div>
    );
}

/** Selects one or more residues ('A:45') of a structure and frames them. */
export async function focusResidues(id: E.StructureId, keys: string[]): Promise<void> {
    const v = viewer();
    if (!v || keys.length === 0) return;
    E.clearSelection(v);
    const perChain = new Map<string, string[]>();
    for (const k of keys) {
        const [c, r] = k.split(':') as [string, string];
        perChain.set(c, [...(perChain.get(c) ?? []), r]);
    }
    for (const [c, rs] of perChain) await E.selectResidues(v, id, c, rs, 'add');
    E.focusSelection(v, keys.length === 1);
}

/** Buttons to colour a structure by each of its datasets. */
export function DatasetButtons({ id, ids }: { id: E.StructureId; ids: string[] }) {
    const structures = useApp((s) => s.structures);
    const v = viewer();
    const entry = v?.entry(id);
    if (!v || !entry || !structures.some((s) => s.id === id)) return null;
    const active = entry.color.scheme === 'data' ? entry.color.dataset : null;
    const list = ids.map((x) => entry.datasets.get(x)).filter((d): d is E.ResidueDataset => Boolean(d));
    return (
        <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10.5px] text-text-2">Colorir por</span>
            {list.map((d) => (
                <button
                    key={d.id}
                    type="button"
                    onClick={() => void run(E.showDataset(v, id, d.id))}
                    className={cx('h-6 rounded border px-2 text-[11px]', active === d.id ? 'border-accent bg-accent/12 text-accent' : 'border-stroke-2 text-text-0 hover:bg-bg-3')}
                >
                    {d.label}
                </button>
            ))}
            <button type="button" onClick={() => void run(E.setColorSettings(v, id, { scheme: 'chain' }))} className="h-6 rounded border border-stroke-2 px-2 text-[11px] text-text-1 hover:bg-bg-3">
                Voltar à cadeia
            </button>
            {active && <DatasetLegend dataset={entry.datasets.get(active)!} id={id} />}
        </div>
    );
}

export function DatasetLegend({ dataset, id }: { dataset: E.ResidueDataset; id?: E.StructureId }) {
    if (dataset.kind === 'categorical') {
        return (
            <span className="ml-2 flex items-center gap-2 text-[10.5px] text-text-1">
                {Object.entries(dataset.colors ?? {}).map(([k, c]) => (
                    <span key={k} className="flex items-center gap-1">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: intToHex(c) }} />
                        {k === '-' ? 'loop' : k === 'H' ? 'hélice' : k === 'E' ? 'fita' : k}
                    </span>
                ))}
            </span>
        );
    }
    if (dataset.kind !== 'continuous') return null;
    const [lo, hi] = E.datasetDomain(dataset);
    const stops = Array.from({ length: 9 }, (_, i) => intToHex(E.rampColor(dataset.ramp ?? 'viridis', i / 8)));
    const v = viewer();
    const full = Object.values(dataset.values).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    const robust = dataset.domain === null || dataset.domain === undefined;
    // The scale is a choice, and which one is in use has to be visible: a long-tailed
    // metric looks like "nothing happened" on a min–max scale.
    const toggleScale = () => {
        if (!v || !id || full.length === 0) return;
        void run(E.updateDataset(v, id, dataset.id, { domain: robust ? [Math.min(...full), Math.max(...full)] : null }));
    };
    return (
        <span className="ml-2 flex items-center gap-1.5 text-[10.5px] text-text-1">
            <span className="tnum">{E.datasetClipped(dataset) ? `≤ ${lo.toFixed(1)}` : lo.toFixed(1)}</span>
            <span className="h-2.5 w-24 rounded-sm" style={{ background: `linear-gradient(to right, ${stops.join(',')})` }} />
            <span className="tnum">{E.datasetClipped(dataset) ? `≥ ${hi.toFixed(1)}` : hi.toFixed(1)}</span>
            {dataset.unit && <span className="text-text-2">{dataset.unit}</span>}
            {id && (
                <button
                    type="button"
                    onClick={toggleScale}
                    title={robust ? 'A escala cobre os 96% centrais dos valores; o que passa disso fica na cor da ponta. Clique para usar mínimo–máximo.' : 'Escala do mínimo ao máximo. Clique para voltar aos 96% centrais.'}
                    className="rounded border border-stroke-2 px-1 text-[9.5px] text-text-2 hover:text-text-0"
                >
                    {robust ? '96%' : 'mín–máx'}
                </button>
            )}
        </span>
    );
}

/** Sortable compact table. */
export function Table<T>({
    rows,
    columns,
    onRow,
    maxHeight,
}: {
    rows: T[];
    columns: { key: string; label: string; render: (r: T) => ReactNode; sort?: (r: T) => number | string; align?: 'right' }[];
    onRow?: (r: T) => void;
    maxHeight?: number;
}) {
    return (
        <div className="scroll-themed overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
            <table className="w-full border-collapse text-[11px]">
                <thead className="sticky top-0 bg-bg-1">
                    <tr>
                        {columns.map((c) => (
                            <th key={c.key} className={cx('border-b border-stroke px-1.5 py-1 font-medium whitespace-nowrap text-text-2', c.align === 'right' ? 'text-right' : 'text-left')}>
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i} onClick={() => onRow?.(r)} className={cx('border-b border-stroke/50', onRow && 'cursor-pointer hover:bg-bg-3')}>
                            {columns.map((c) => (
                                <td key={c.key} className={cx('px-1.5 py-0.5 whitespace-nowrap', c.align === 'right' && 'tnum text-right')}>
                                    {c.render(r)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return '';
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const esc = (v: unknown) => {
        const s = v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [keys.join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n');
}
