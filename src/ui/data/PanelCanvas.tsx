import { useEffect, useRef, useState } from 'react';
import { THEMES } from '@/panels/theme';
import { cellLetter, type Cell, type Panel } from '@/panels/types';
import { addChartCell, addStructureCell, addCell, duplicateCell, followingCount, moveCell, receivingCell, removeCell, selectCell, useData } from '@/store/data';
import { Icon } from '../components/Icon';
import { cx, IconButton } from '../components/Primitives';
import { ChartCell } from './ChartCell';
import { StructureCell } from './StructureCell';

/** Cell being dragged or resized, in grid units. */
interface DragState {
    cellId: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    origin: Cell;
    /** Where it would land, previewed under the cursor. */
    target: { x: number; y: number; w: number; h: number };
}

function CellChrome({ panel, cell, active, children }: { panel: Panel; cell: Cell; active: boolean; children: React.ReactNode }) {
    const theme = THEMES[panel.theme];
    const title = cell.content.kind === 'chart' ? cell.content.chart.title : cell.content.kind === 'structure' ? cell.content.structure.title : '';
    // With several 3D cells following the clicks, say which one the next design opens in.
    const follows = cell.content.kind === 'structure' && cell.content.structure.source.kind === 'selected';
    const receiving = useData((s) => (follows && followingCount(s) > 1 ? receivingCell(s) === cell.id : null));
    return (
        <div
            onPointerDown={() => selectCell(cell.id)}
            className={cx(
                'group/cell relative flex h-full w-full flex-col overflow-hidden rounded-lg border transition-[border-color,box-shadow] duration-200',
                active ? 'border-accent/70 shadow-[0_0_0_1px_var(--accent)]' : 'border-transparent hover:border-stroke-2',
            )}
            style={{ background: theme.background === 'transparent' ? undefined : theme.surface }}
        >
            {panel.letters && (
                <span className="pointer-events-none absolute top-1.5 left-2 z-10 text-[13px] font-bold" style={{ color: theme.text }}>
                    {cellLetter(panel, cell.id)}
                </span>
            )}
            {cell.content.kind === 'structure' && title && (
                <span className="pointer-events-none absolute top-1.5 left-0 z-10 w-full text-center text-[12px] font-semibold" style={{ color: theme.text }}>
                    {title}
                </span>
            )}
            <div className="min-h-0 flex-1">{children}</div>

            {/* Chrome that only exists while composing — never exported. */}
            {receiving !== null && (
                <span
                    className={cx(
                        'pointer-events-none absolute bottom-1.5 left-1.5 z-20 rounded-md px-1.5 py-0.5 text-[10.5px] transition-opacity duration-150',
                        receiving ? 'bg-accent/90 text-bg-0' : 'glass text-text-1 opacity-0 group-hover/cell:opacity-100',
                    )}
                >
                    {receiving ? 'O próximo design clicado abre aqui' : 'Clique nesta célula para abrir o próximo design nela'}
                </span>
            )}
            <div className="absolute top-1 right-1 z-20 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100">
                <IconButton icon="layers" size={20} title="Duplicar célula" onClick={() => duplicateCell(cell.id)} />
                <IconButton icon="trash" size={20} title="Remover célula" onClick={() => removeCell(cell.id)} />
            </div>
            <div
                data-resize={cell.id}
                title="Arrastar para redimensionar"
                className="absolute right-0 bottom-0 z-20 h-4 w-4 cursor-nwse-resize opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100"
            >
                <svg viewBox="0 0 16 16" className="h-full w-full text-text-2">
                    <path d="M15 7L7 15M15 12l-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                </svg>
            </div>
            <div data-move={cell.id} title="Arrastar para mover" className="absolute top-1 left-1 z-20 cursor-grab opacity-0 transition-opacity duration-150 group-hover/cell:opacity-100 active:cursor-grabbing">
                <Icon name="layers" size={13} className="text-text-2" />
            </div>
        </div>
    );
}

function AddMenu({ onClose }: { onClose: () => void }) {
    const dataset = useData((s) => s.dataset);
    const numeric = dataset?.columns.filter((c) => c.kind === 'number') ?? [];
    const category = dataset?.columns.filter((c) => c.kind === 'category') ?? [];
    const items: { label: string; icon: Parameters<typeof Icon>[0]['name']; run: () => void }[] = [
        { label: 'Dispersão', icon: 'chart', run: () => addChartCell({ type: 'scatter', x: numeric[0]?.key, y: numeric[1]?.key }) },
        { label: 'Histograma', icon: 'chart', run: () => addChartCell({ type: 'histogram', x: numeric[0]?.key }) },
        { label: 'Violino', icon: 'chart', run: () => addChartCell({ type: 'violin', x: category[0]?.key, y: numeric[0]?.key, showPoints: true }) },
        { label: 'Caixa', icon: 'chart', run: () => addChartCell({ type: 'box', x: category[0]?.key, y: numeric[0]?.key }) },
        { label: 'Barras', icon: 'chart', run: () => addChartCell({ type: 'bar', x: category[0]?.key, y: numeric[0]?.key, showValues: true }) },
        { label: 'Empilhadas', icon: 'chart', run: () => addChartCell({ type: 'stacked', x: category[0]?.key, group: category[1]?.key ?? category[0]?.key }) },
        { label: 'Linha', icon: 'chart', run: () => addChartCell({ type: 'line', x: numeric[0]?.key, y: numeric[1]?.key, showBand: true }) },
        { label: 'Heatmap', icon: 'chart', run: () => addChartCell({ type: 'heatmap', columns: numeric.slice(0, 6).map((c) => c.key), limit: 30 }) },
        { label: 'Correlação', icon: 'chart', run: () => addChartCell({ type: 'correlation', columns: numeric.slice(0, 8).map((c) => c.key), showValues: true }) },
        { label: 'Dumbbell', icon: 'chart', run: () => addChartCell({ type: 'dumbbell', x: category[0]?.key, y: numeric[0]?.key, y2: numeric[1]?.key }) },
        { label: 'Paralelas', icon: 'chart', run: () => addChartCell({ type: 'parallel', columns: numeric.slice(0, 5).map((c) => c.key) }) },
        { label: 'Funil', icon: 'chart', run: () => addChartCell({ type: 'funnel', gates: [] }) },
        { label: 'Estrutura 3D', icon: 'target', run: () => addStructureCell() },
        { label: 'Texto / legenda', icon: 'edit', run: () => addCell({ kind: 'text', text: { text: 'Legenda do painel.', size: 12, align: 'left', caption: true } }) },
    ];
    return (
        <>
            <div className="fixed inset-0 z-30" onClick={onClose} />
            <div className="glass scale-in absolute top-9 right-2 z-40 grid w-[320px] grid-cols-2 gap-1 rounded-xl p-2 shadow-[var(--shadow-pop)]">
                {items.map((it) => (
                    <button
                        key={it.label}
                        type="button"
                        onClick={() => {
                            it.run();
                            onClose();
                        }}
                        className="press flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-text-1 hover:bg-bg-3 hover:text-text-0"
                    >
                        <Icon name={it.icon} size={13} className="shrink-0 text-accent" />
                        {it.label}
                    </button>
                ))}
            </div>
        </>
    );
}

/**
 * The panel being composed: a CSS grid of cells that can be dragged and resized in
 * grid units. The preview of a drag is drawn as an overlay rectangle, so nothing in
 * the grid reflows (and no chart re-renders) until the pointer is released.
 */
export function PanelCanvas({ panel }: { panel: Panel }) {
    const activeCellId = useData((s) => s.activeCellId);
    const gridRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    const [adding, setAdding] = useState(false);
    const theme = THEMES[panel.theme];

    useEffect(() => {
        if (!drag) return;
        const onMove = (e: PointerEvent) => {
            const grid = gridRef.current;
            if (!grid) return;
            const box = grid.getBoundingClientRect();
            const cw = (box.width + panel.gap) / panel.cols;
            const ch = (box.height + panel.gap) / panel.rows;
            const dx = Math.round((e.clientX - drag.startX) / cw);
            const dy = Math.round((e.clientY - drag.startY) / ch);
            setDrag((d) => {
                if (!d) return d;
                const target =
                    d.mode === 'move'
                        ? { x: Math.max(0, Math.min(panel.cols - d.origin.w, d.origin.x + dx)), y: Math.max(0, Math.min(panel.rows - d.origin.h, d.origin.y + dy)), w: d.origin.w, h: d.origin.h }
                        : {
                              x: d.origin.x,
                              y: d.origin.y,
                              w: Math.max(1, Math.min(panel.cols - d.origin.x, d.origin.w + dx)),
                              h: Math.max(1, Math.min(panel.rows - d.origin.y, d.origin.h + dy)),
                          };
                return { ...d, target };
            });
        };
        const onUp = () => {
            setDrag((d) => {
                if (d) moveCell(d.cellId, d.target);
                return null;
            });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [drag, panel.cols, panel.rows, panel.gap]);

    const startDrag = (e: React.PointerEvent) => {
        const el = (e.target as HTMLElement).closest('[data-move],[data-resize]') as HTMLElement | null;
        if (!el) return;
        const mode = el.dataset.move ? 'move' : 'resize';
        const cellId = el.dataset.move ?? el.dataset.resize!;
        const cell = panel.cells.find((c) => c.id === cellId);
        if (!cell) return;
        e.preventDefault();
        selectCell(cellId);
        setDrag({ cellId, mode, startX: e.clientX, startY: e.clientY, origin: cell, target: { x: cell.x, y: cell.y, w: cell.w, h: cell.h } });
    };

    const cellSpan = (c: Cell) => ({ gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}` });
    // Small cells get smaller type, so a 4×4 panel stays legible instead of cramped.
    const fontScale = (c: Cell) => Math.max(0.78, Math.min(1.08, Math.sqrt((c.w / panel.cols) * (c.h / panel.rows)) * 1.5));

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-stroke px-3">
                <span className="truncate text-[12px] font-semibold">{panel.title || 'Painel'}</span>
                {panel.subtitle && <span className="truncate text-[11px] text-text-2">{panel.subtitle}</span>}
                <span className="flex-1" />
                <span className="tnum text-[10.5px] text-text-2">
                    {panel.cols}×{panel.rows} · {panel.cells.length} célula{panel.cells.length === 1 ? '' : 's'}
                </span>
                <button type="button" onClick={() => setAdding((v) => !v)} className="press flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-[11.5px] font-medium text-bg-0 hover:brightness-110">
                    <Icon name="plus" size={12} /> Adicionar
                </button>
            </div>
            {adding && <AddMenu onClose={() => setAdding(false)} />}

            <div className="scroll-themed min-h-0 flex-1 overflow-auto p-4" onPointerDown={startDrag}>
                <div
                    ref={gridRef}
                    className={cx('relative mx-auto grid h-full w-full rounded-xl p-3 transition-colors duration-300', panel.background === 'transparent' && 'checker')}
                    style={{
                        gridTemplateColumns: `repeat(${panel.cols}, minmax(0, 1fr))`,
                        gridTemplateRows: `repeat(${panel.rows}, minmax(140px, 1fr))`,
                        gap: panel.gap,
                        background: panel.background === 'transparent' ? undefined : panel.background === 'white' ? '#ffffff' : theme.background,
                        minHeight: panel.rows * 170,
                    }}
                >
                    {panel.cells.map((cell) => (
                        <div key={cell.id} style={cellSpan(cell)} className={cx('min-h-0 min-w-0', drag?.cellId === cell.id && 'opacity-40')}>
                            <CellChrome panel={panel} cell={cell} active={cell.id === activeCellId}>
                                {cell.content.kind === 'chart' && (
                                    <ChartCell cellId={cell.id} spec={cell.content.chart} theme={panel.theme} fontScale={fontScale(cell)} compact={cell.w * cell.h === 1 && panel.cols > 2} lettered={panel.letters} />
                                )}
                                {cell.content.kind === 'structure' && <StructureCell cellId={cell.id} spec={cell.content.structure} theme={panel.theme} />}
                                {cell.content.kind === 'text' && (
                                    <div
                                        className="flex h-full w-full flex-col justify-center px-3 py-2 whitespace-pre-wrap"
                                        style={{
                                            color: cell.content.text.caption ? theme.textMuted : theme.text,
                                            fontSize: cell.content.text.size,
                                            textAlign: cell.content.text.align,
                                            lineHeight: 1.5,
                                        }}
                                    >
                                        {cell.content.text.text}
                                    </div>
                                )}
                            </CellChrome>
                        </div>
                    ))}

                    {/* Drag preview. */}
                    {drag && (
                        <div
                            className="pointer-events-none rounded-lg border-2 border-dashed border-accent bg-accent/10"
                            style={{ gridColumn: `${drag.target.x + 1} / span ${drag.target.w}`, gridRow: `${drag.target.y + 1} / span ${drag.target.h}` }}
                        />
                    )}

                    {panel.cells.length === 0 && (
                        <div className="pointer-events-none col-span-full row-span-full flex flex-col items-center justify-center gap-2 text-center">
                            <Icon name="chart" size={22} className="text-text-2" />
                            <p className="text-[12px] text-text-2">
                                Painel vazio. Use <span className="text-text-1">Adicionar</span> para colocar gráficos, estruturas e texto.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
