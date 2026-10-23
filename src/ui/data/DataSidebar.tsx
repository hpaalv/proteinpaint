import { useMemo, useRef, useState } from 'react';
import type { Column, Dataset, Filter } from '@/dataset/types';
import { filterLabel, numberOf } from '@/dataset/types';
import { histogram } from '@/panels/stats';
import { addFilter, addStructureCell, clearFilters, clearSelection, keepSelection, openDatasetFolder, removeFilter, setHovered, useData, useTable } from '@/store/data';
import { useFilteredRows } from './hooks';
import { Icon, type IconName } from '../components/Icon';
import { Button, Collapse, Empty, IconButton, Spinner, TextInput, cx } from '../components/Primitives';

const KIND_ICON: Record<Column['kind'], IconName> = { number: 'chart', category: 'tag', text: 'edit', sequence: 'seq', list: 'layers' };

/**
 * A column's distribution as a small histogram, draggable to set a range filter.
 * Bars in range keep the accent colour, the rest fade — the filter is visible in the
 * same place it is made.
 */
function MiniHistogram({ dataset, column, range, onRange }: { dataset: Dataset; column: Column; range: [number, number] | null; onRange: (r: [number, number] | null) => void }) {
    const ref = useRef<SVGSVGElement>(null);
    const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
    const bins = useMemo(() => {
        const values: number[] = [];
        for (const r of dataset.rows) {
            const v = numberOf(r, column.key);
            if (v !== null) values.push(v);
        }
        return values.length ? histogram(values, 28) : null;
    }, [dataset, column.key]);
    if (!bins || !column.range) return null;

    const [lo, hi] = column.range;
    const span = hi - lo || 1;
    const max = Math.max(...bins.counts, 1);
    const toValue = (fraction: number) => lo + Math.max(0, Math.min(1, fraction)) * span;

    const pointer = (e: React.PointerEvent) => {
        const box = ref.current?.getBoundingClientRect();
        return box ? (e.clientX - box.left) / box.width : 0;
    };
    const active = drag ? ([Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)] as [number, number]) : range;

    return (
        <div className="flex flex-col gap-1">
            <svg
                ref={ref}
                viewBox="0 0 100 28"
                preserveAspectRatio="none"
                className="h-8 w-full cursor-ew-resize touch-none select-none"
                onPointerDown={(e) => {
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                    const v = toValue(pointer(e));
                    setDrag({ from: v, to: v });
                }}
                onPointerMove={(e) => drag && setDrag({ ...drag, to: toValue(pointer(e)) })}
                onPointerUp={() => {
                    if (drag) {
                        const a = Math.min(drag.from, drag.to);
                        const b = Math.max(drag.from, drag.to);
                        // A click (no drag) clears the filter instead of selecting a sliver.
                        onRange(b - a < span * 0.01 ? null : [a, b]);
                    }
                    setDrag(null);
                }}
            >
                {bins.counts.map((count, i) => {
                    const x = ((bins.edges[i]! - lo) / span) * 100;
                    const w = (bins.width / span) * 100;
                    const h = (count / max) * 26;
                    const center = bins.centers[i]!;
                    const inRange = !active || (center >= active[0] && center <= active[1]);
                    return <rect key={i} x={x} y={28 - h} width={Math.max(0.6, w - 0.4)} height={h} rx={0.6} className={inRange ? 'fill-accent/80' : 'fill-stroke-2'} />;
                })}
            </svg>
            <div className="tnum flex justify-between text-[9.5px] text-text-2">
                <span>{active ? active[0].toLocaleString('pt-BR', { maximumSignificantDigits: 3 }) : lo.toLocaleString('pt-BR', { maximumSignificantDigits: 3 })}</span>
                <span className="text-text-1">{active ? 'arraste para refazer · clique limpa' : 'arraste para filtrar'}</span>
                <span>{active ? active[1].toLocaleString('pt-BR', { maximumSignificantDigits: 3 }) : hi.toLocaleString('pt-BR', { maximumSignificantDigits: 3 })}</span>
            </div>
        </div>
    );
}

function CategoryChips({ column, selected, onChange }: { column: Column; selected: string[]; onChange: (values: string[]) => void }) {
    const categories = column.categories ?? [];
    return (
        <div className="flex flex-wrap gap-1">
            {categories.map((c) => {
                const on = selected.includes(c);
                return (
                    <button
                        key={c}
                        type="button"
                        onClick={() => onChange(on ? selected.filter((v) => v !== c) : [...selected, c])}
                        className={cx('press h-5 rounded-full border px-2 text-[10.5px]', on ? 'border-accent bg-accent/15 text-accent' : 'border-stroke-2 text-text-2 hover:text-text-0')}
                    >
                        {c}
                    </button>
                );
            })}
        </div>
    );
}

function ColumnRow({ dataset, column, filters }: { dataset: Dataset; column: Column; filters: Filter[] }) {
    const [open, setOpen] = useState(false);
    const rangeFilter = filters.find((f): f is Extract<Filter, { kind: 'range' }> => f.kind === 'range' && f.key === column.key);
    const catFilter = filters.find((f): f is Extract<Filter, { kind: 'categories' }> => f.kind === 'categories' && f.key === column.key);
    const filtered = Boolean(rangeFilter || catFilter);
    const expandable = column.kind === 'number' || column.kind === 'category';

    return (
        <div className={cx('rounded-md', open && 'bg-bg-2/60')}>
            <button
                type="button"
                onClick={() => expandable && setOpen(!open)}
                className={cx('flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors duration-150', expandable && 'hover:bg-bg-3', filtered && 'text-accent')}
                title={`${column.key}${column.missing > 0 ? ` · ${Math.round(column.missing * 100)}% vazio` : ''}`}
            >
                <Icon name={KIND_ICON[column.kind]} size={11} className={cx('shrink-0', filtered ? 'text-accent' : 'text-text-2')} />
                <span className={cx('min-w-0 flex-1 truncate text-[11.5px]', filtered ? 'text-accent' : 'text-text-0')}>{column.label}</span>
                {column.unit && <span className="shrink-0 text-[10px] text-text-2">{column.unit}</span>}
                {filtered && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                {expandable && <Icon name="chevron" size={10} className={cx('shrink-0 text-text-2 transition-transform duration-300', open && 'rotate-90')} />}
            </button>
            <Collapse open={open}>
                <div className="flex flex-col gap-1.5 px-2 pt-1 pb-2">
                    {column.kind === 'number' && (
                        <MiniHistogram
                            dataset={dataset}
                            column={column}
                            range={rangeFilter ? [rangeFilter.min, rangeFilter.max] : null}
                            onRange={(r) => {
                                if (!r) {
                                    const i = filters.findIndex((f) => f.kind === 'range' && f.key === column.key);
                                    if (i >= 0) removeFilter(i);
                                } else addFilter({ kind: 'range', key: column.key, min: r[0], max: r[1] });
                            }}
                        />
                    )}
                    {column.kind === 'category' && (
                        <CategoryChips
                            column={column}
                            selected={catFilter?.values ?? []}
                            onChange={(values) => {
                                const i = filters.findIndex((f) => f.kind === 'categories' && f.key === column.key);
                                if (values.length === 0 && i >= 0) removeFilter(i);
                                else addFilter({ kind: 'categories', key: column.key, values });
                            }}
                        />
                    )}
                </div>
            </Collapse>
        </div>
    );
}

export function DataSidebar() {
    const dataset = useData((s) => s.dataset);
    const loading = useData((s) => s.loading);
    const filters = useData((s) => s.filters);
    const selection = useData((s) => s.selection);
    const otherTables = useData((s) => s.otherTables);
    const [search, setSearch] = useState('');
    const [columnQuery, setColumnQuery] = useState('');
    const rows = useFilteredRows();

    if (loading) {
        return (
            <aside className="flex w-[290px] shrink-0 items-center justify-center border-r border-stroke bg-bg-1">
                <Spinner size={20} className="text-accent" />
            </aside>
        );
    }

    if (!dataset) {
        return (
            <aside className="flex w-[290px] shrink-0 flex-col items-center justify-center gap-3 border-r border-stroke bg-bg-1 px-6 text-center">
                <Icon name="chart" size={26} className="text-text-2" />
                <p className="text-[12px] leading-relaxed text-text-1">
                    Abra uma pasta com as estruturas e a tabela de metadados (<span className="mono text-[11px]">.csv</span>).
                </p>
                <Button variant="primary" icon="open" onClick={() => void openDatasetFolder()}>
                    Abrir pasta de análise
                </Button>
            </aside>
        );
    }

    const groups = new Map<string, Column[]>();
    const query = columnQuery.trim().toLowerCase();
    for (const c of dataset.columns) {
        if (query && !c.label.toLowerCase().includes(query) && !c.key.toLowerCase().includes(query)) continue;
        const list = groups.get(c.group);
        if (list) list.push(c);
        else groups.set(c.group, [c]);
    }

    return (
        <aside className="flex w-[290px] shrink-0 flex-col border-r border-stroke bg-bg-1">
            <div className="flex h-8 shrink-0 items-center gap-1 px-3">
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wider text-text-1 uppercase" title={dataset.folder}>
                    {dataset.name}
                </span>
                <IconButton icon="open" size={22} title="Abrir outra pasta" onClick={() => void openDatasetFolder()} />
            </div>

            <div className="flex shrink-0 flex-col gap-2 border-b border-stroke px-3 pb-2.5">
                <div className="flex gap-3 text-[11px] text-text-2">
                    <span className="tnum">
                        <span className="text-text-0">{rows.length}</span>
                        {rows.length !== dataset.rows.length && <span className="text-accent">/{dataset.rows.length}</span>} designs
                    </span>
                    <span className="tnum">
                        <span className="text-text-0">{dataset.matched}</span> com 3D
                    </span>
                </div>
                {otherTables.length > 0 && (
                    <select
                        value={dataset.tablePath}
                        onChange={(e) => void useTable(e.target.value)}
                        className="h-6 w-full rounded border border-stroke-2 bg-bg-0 px-1.5 text-[11px] text-text-1 outline-none focus:border-accent"
                        title="Tabela de metadados usada"
                    >
                        {[dataset.tablePath, ...otherTables].map((p) => (
                            <option key={p} value={p}>
                                {p.split('/').pop()}
                            </option>
                        ))}
                    </select>
                )}
                <TextInput
                    value={search}
                    onChange={(v) => {
                        setSearch(v);
                        const i = filters.findIndex((f) => f.kind === 'search');
                        if (!v.trim() && i >= 0) removeFilter(i);
                        else if (v.trim()) addFilter({ kind: 'search', text: v });
                    }}
                    placeholder="Buscar design…"
                    className="h-6 w-full text-[11.5px]"
                />
            </div>

            {(filters.length > 0 || selection.size > 0) && (
                <div className="flex shrink-0 flex-col gap-1.5 border-b border-stroke px-3 py-2">
                    {selection.size > 0 && (
                        <div className="fade-in flex items-center gap-1.5">
                            <span className="tnum flex-1 text-[11px] text-accent">{selection.size} selecionado{selection.size > 1 ? 's' : ''}</span>
                            <button type="button" onClick={keepSelection} className="press rounded border border-accent/50 px-1.5 text-[10.5px] text-accent hover:bg-accent/10">
                                manter só
                            </button>
                            <button type="button" onClick={clearSelection} className="press rounded px-1.5 text-[10.5px] text-text-2 hover:text-text-0">
                                limpar
                            </button>
                        </div>
                    )}
                    {filters.map((f, i) => (
                        <div key={`${f.kind}-${i}`} className="scale-in flex items-center gap-1 rounded-md bg-bg-2 px-2 py-1">
                            <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-1">{filterLabel(dataset, f)}</span>
                            <button type="button" onClick={() => removeFilter(i)} className="shrink-0 text-text-2 hover:text-err">
                                <Icon name="close" size={10} />
                            </button>
                        </div>
                    ))}
                    {filters.length > 1 && (
                        <button type="button" onClick={clearFilters} className="self-start text-[10.5px] text-text-2 hover:text-text-0">
                            limpar todos
                        </button>
                    )}
                </div>
            )}

            <div className="flex h-7 shrink-0 items-center gap-1 px-3">
                <span className="text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Colunas</span>
                <input
                    value={columnQuery}
                    onChange={(e) => setColumnQuery(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="filtrar…"
                    className="ml-auto h-5 w-24 rounded border border-stroke bg-bg-0 px-1.5 text-[10.5px] outline-none focus:border-accent"
                />
            </div>
            <div className="scroll-themed min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                {[...groups.entries()].map(([group, columns]) => (
                    <div key={group} className="mb-1">
                        <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-text-2 uppercase">{group}</div>
                        {columns.map((c) => (
                            <ColumnRow key={c.key} dataset={dataset} column={c} filters={filters} />
                        ))}
                    </div>
                ))}
                {groups.size === 0 && <Empty>Nenhuma coluna com esse nome.</Empty>}
            </div>

            {dataset.loose.length > 0 && (
                <div className="shrink-0 border-t border-stroke">
                    <div className="px-3 py-1.5 text-[10px] font-semibold tracking-wider text-text-2 uppercase">Estruturas de referência</div>
                    <div className="scroll-themed max-h-28 overflow-y-auto px-1.5 pb-2">
                        {dataset.loose.map((s) => (
                            <button
                                key={s.path}
                                type="button"
                                title={`${s.path}\nClique para abrir numa célula 3D`}
                                onMouseEnter={() => setHovered(null)}
                                onClick={() => addStructureCell({ source: { kind: 'file', path: s.path }, title: s.name })}
                                className="press mono flex h-6 w-full items-center gap-1.5 rounded px-2 text-left text-[10.5px] text-text-1 hover:bg-bg-3 hover:text-text-0"
                            >
                                <Icon name="target" size={10} className="shrink-0 text-text-2" />
                                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                                <span className="shrink-0 text-[9.5px] text-text-2">{s.group}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </aside>
    );
}
