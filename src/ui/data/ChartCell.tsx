import { useEffect, useMemo, useRef } from 'react';
import type { ECharts } from 'echarts';
import { buildChart, type ChartContext } from '@/panels/charts';
import type { ChartSpec } from '@/panels/types';
import { THEMES, type ThemeId } from '@/panels/theme';
import { rowById, selectBrushed, setHovered, toggleSelected, useData } from '@/store/data';
import { loadPaths } from '@/store/actions';
import { toast, useApp } from '@/store/app';
import { useFilteredRows } from './hooks';
import { Chart } from '../components/Chart';
import { Icon } from '../components/Icon';

/** Chart instances by cell id, so the panel export can ask each one for its pixels. */
export const chartInstances = new Map<string, ECharts>();

interface BrushParams {
    batch?: { selected?: { dataIndex: number[]; seriesIndex: number }[] }[];
}

/**
 * One chart in a panel cell.
 *
 * The chart is rebuilt whenever the spec, the rows or the selection change — ECharts
 * diffs the option internally, so a hover that only changes opacity still animates
 * smoothly instead of redrawing from scratch.
 */
export function ChartCell({ cellId, spec, theme, fontScale, compact, lettered }: { cellId: string; spec: ChartSpec; theme: ThemeId; fontScale: number; compact: boolean; lettered?: boolean }) {
    const dataset = useData((s) => s.dataset);
    const selection = useData((s) => s.selection);
    const hovered = useData((s) => s.hovered);
    const instance = useRef<ECharts | null>(null);

    const rows = useFilteredRows();

    const built = useMemo(() => {
        if (!dataset) return { option: {}, empty: 'Abra uma pasta de análise.' };
        const ctx: ChartContext = { dataset, rows, selection, hovered, theme: THEMES[theme], fontScale, compact, lettered };
        return buildChart(spec, ctx);
    }, [dataset, rows, selection, hovered, spec, theme, fontScale, compact, lettered]);

    // Series data holds the row ids; a brush gives back data indices per series.
    const events = useMemo(
        () => ({
            mouseover: (p: unknown) => {
                const id = (p as { data?: { rowId?: string } }).data?.rowId;
                if (id) setHovered(id);
            },
            globalout: () => setHovered(null),
            // Double click: the design opens in the structure workspace, next to whatever is there.
            dblclick: (p: unknown) => {
                const id = (p as { data?: { rowId?: string } }).data?.rowId;
                const path = id ? rowById(id)?.structurePath : null;
                if (!id) return;
                if (!path) return toast('Este design não tem estrutura na pasta.', 'info');
                void loadPaths([path]).then(() => useApp.setState({ workspace: 'structure' }));
            },
            brushSelected: (p: unknown) => {
                const chart = instance.current;
                if (!chart) return;
                const option = chart.getOption() as { series?: { data?: { rowId?: string }[] }[] };
                const ids = new Set<string>();
                for (const batch of (p as BrushParams).batch ?? []) {
                    for (const sel of batch.selected ?? []) {
                        const data = option.series?.[sel.seriesIndex]?.data ?? [];
                        for (const i of sel.dataIndex) {
                            const id = data[i]?.rowId;
                            if (id) ids.add(id);
                        }
                    }
                }
                // An empty brush is the user clearing it, not selecting nothing.
                if (ids.size > 0) selectBrushed(ids);
            },
        }),
        [],
    );

    useEffect(() => () => void chartInstances.delete(cellId), [cellId]);

    if (built.empty) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                <Icon name="chart" size={20} className="opacity-40" />
                <p className="text-[11.5px] leading-relaxed text-text-2">{built.empty}</p>
            </div>
        );
    }

    return (
        <Chart
            option={built.option}
            height="100%"
            renderer="canvas"
            events={events}
            onReady={(c) => {
                instance.current = c;
                if (c) chartInstances.set(cellId, c);
                else chartInstances.delete(cellId);
            }}
            onClick={(p) => {
                const id = (p as { data?: { rowId?: string } }).data?.rowId;
                if (id) toggleSelected(id, (p.event?.event as MouseEvent | undefined)?.shiftKey ?? false);
            }}
        />
    );
}
