import { useMemo, useRef, useState } from 'react';
import { numberOf, stringOf } from '@/dataset/types';
import { focusRow, setHovered, toggleSelected, useData } from '@/store/data';
import { useFilteredRows } from './hooks';
import { Icon } from '../components/Icon';
import { cx } from '../components/Primitives';

const ROW_HEIGHT = 24;

/**
 * The designs as a table under the panel: every row of the filtered dataset, sorted
 * by any column, selected in sync with the charts.
 *
 * Only the visible window of rows is mounted, so a few thousand designs scroll
 * without the DOM growing with them.
 */
export function DataTable() {
    const dataset = useData((s) => s.dataset);
    const selection = useData((s) => s.selection);
    const focused = useData((s) => s.focused);
    const hovered = useData((s) => s.hovered);
    const height = useData((s) => s.tableHeight);
    const sort = useData((s) => s.tableSort);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewport, setViewport] = useState(400);

    const base = useFilteredRows();
    const rows = useMemo(() => {
        if (!sort) return base;
        const dir = sort.dir === 'asc' ? 1 : -1;
        return [...base].sort((a, b) => {
            const av = numberOf(a, sort.key);
            const bv = numberOf(b, sort.key);
            if (av !== null && bv !== null) return (av - bv) * dir;
            return stringOf(a, sort.key).localeCompare(stringOf(b, sort.key), undefined, { numeric: true }) * dir;
        });
    }, [base, sort]);

    // The id column plus the numeric columns that are actually populated.
    const columns = useMemo(() => {
        if (!dataset) return [];
        return dataset.columns.filter((c) => c.key !== dataset.idKey && c.kind !== 'sequence' && c.missing < 0.8).slice(0, 24);
    }, [dataset]);

    if (!dataset) return null;

    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
    const visible = rows.slice(start, start + Math.ceil(viewport / ROW_HEIGHT) + 12);

    const toggleSort = (key: string) =>
        useData.setState((s) => ({ tableSort: s.tableSort?.key === key ? (s.tableSort.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' } }));

    return (
        <div className="flex shrink-0 flex-col border-t border-stroke bg-bg-1" style={{ height }}>
            <div
                onPointerDown={(e) => {
                    const startY = e.clientY;
                    const start = height;
                    const move = (ev: PointerEvent) => useData.setState({ tableHeight: Math.max(120, Math.min(window.innerHeight - 260, start + startY - ev.clientY)) });
                    const up = () => {
                        window.removeEventListener('pointermove', move);
                        window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up);
                }}
                className="group flex h-1.5 cursor-ns-resize items-center justify-center"
            >
                <span className="h-[3px] w-10 rounded-full bg-stroke-2 transition-all duration-200 group-hover:w-16 group-hover:bg-accent/70" />
            </div>

            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-stroke px-3">
                <Icon name="seq" size={12} className="text-text-2" />
                <span className="text-[11px] font-semibold tracking-wider text-text-1 uppercase">Designs</span>
                <span className="tnum text-[11px] text-text-2">{rows.length}</span>
                <span className="flex-1" />
                <button type="button" onClick={() => useData.setState({ tableOpen: false })} className="text-text-2 transition-colors hover:text-text-0" title="Recolher">
                    <Icon name="chevronDown" size={14} />
                </button>
            </div>

            <div
                ref={scrollRef}
                onScroll={(e) => {
                    setScrollTop(e.currentTarget.scrollTop);
                    setViewport(e.currentTarget.clientHeight);
                }}
                className="scroll-themed min-h-0 flex-1 overflow-auto"
            >
                <table className="w-full border-collapse text-[11px]" style={{ tableLayout: 'fixed' }}>
                    <thead className="sticky top-0 z-10 bg-bg-1">
                        <tr>
                            <th className="w-[230px] border-b border-stroke px-2 py-1 text-left font-medium text-text-2">
                                <button type="button" onClick={() => toggleSort(dataset.idKey)} className="flex items-center gap-1 hover:text-text-0">
                                    design {sort?.key === dataset.idKey && <Icon name={sort.dir === 'asc' ? 'up' : 'down'} size={9} />}
                                </button>
                            </th>
                            {columns.map((c) => (
                                <th key={c.key} className="w-[86px] border-b border-stroke px-2 py-1 text-right font-medium text-text-2" title={c.key}>
                                    <button type="button" onClick={() => toggleSort(c.key)} className="flex w-full items-center justify-end gap-1 truncate hover:text-text-0">
                                        <span className="truncate">{c.label}</span>
                                        {sort?.key === c.key && <Icon name={sort.dir === 'asc' ? 'up' : 'down'} size={9} className="shrink-0" />}
                                    </button>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {start > 0 && <tr style={{ height: start * ROW_HEIGHT }} />}
                        {visible.map((row) => {
                            const selected = selection.has(row.id);
                            return (
                                <tr
                                    key={row.id}
                                    onMouseEnter={() => setHovered(row.id)}
                                    onMouseLeave={() => setHovered(null)}
                                    onClick={(e) => {
                                        toggleSelected(row.id, e.shiftKey || e.ctrlKey || e.metaKey);
                                        focusRow(row.id);
                                    }}
                                    style={{ height: ROW_HEIGHT }}
                                    className={cx(
                                        'cursor-pointer transition-colors duration-100',
                                        selected ? 'bg-accent/12 text-text-0' : hovered === row.id ? 'bg-bg-3' : 'text-text-1 hover:bg-bg-2',
                                        focused === row.id && 'ring-1 ring-accent/40 ring-inset',
                                    )}
                                >
                                    <td className="mono truncate px-2" title={row.id}>
                                        <span className="flex items-center gap-1">
                                            {row.structurePath && <Icon name="target" size={9} className="shrink-0 text-accent/70" />}
                                            <span className="truncate">{row.id}</span>
                                        </span>
                                    </td>
                                    {columns.map((c) => {
                                        const v = row.values[c.key];
                                        return (
                                            <td key={c.key} className="tnum truncate px-2 text-right">
                                                {typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumSignificantDigits: 4 }) : (v ?? '')}
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                        {start + visible.length < rows.length && <tr style={{ height: (rows.length - start - visible.length) * ROW_HEIGHT }} />}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
