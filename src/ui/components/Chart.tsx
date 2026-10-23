import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export type ChartOption = echarts.EChartsOption;

/** App-matched defaults: transparent background, UI font, muted axes. */
const BASE: ChartOption = {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: '#9aa8bf', fontSize: 11 },
    animationDuration: 250,
};

export const AXIS = {
    axisLine: { lineStyle: { color: '#2e3a52' } },
    axisTick: { lineStyle: { color: '#2e3a52' } },
    axisLabel: { color: '#9aa8bf', fontSize: 10 },
    splitLine: { lineStyle: { color: '#1d2636' } },
    nameTextStyle: { color: '#9aa8bf', fontSize: 10 },
};

export const TOOLTIP = {
    backgroundColor: 'rgba(16,21,31,0.95)',
    borderColor: '#2e3a52',
    textStyle: { color: '#e6ecf5', fontSize: 11 },
};

/**
 * ECharts on canvas (GPU-composited); `renderer: 'svg'` only for export. Resizes with
 * its container and forwards clicks with the clicked datum.
 */
export type ChartEvents = Record<string, (params: unknown) => void>;

export function Chart({
    option,
    height = 220,
    onClick,
    className,
    renderer = 'canvas',
    events,
    onReady,
    group,
}: {
    option: ChartOption;
    height?: number | string;
    onClick?: (params: echarts.ECElementEvent) => void;
    className?: string;
    renderer?: 'canvas' | 'svg';
    /** Extra ECharts events ('mouseover', 'brushSelected', 'globalout'…). */
    events?: ChartEvents;
    /** Hands the instance out for export (getDataURL) and imperative calls. */
    onReady?: (chart: echarts.ECharts | null) => void;
    /** Connects charts so an axis pointer in one shows in the others. */
    group?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const chart = useRef<echarts.ECharts | null>(null);
    const clickRef = useRef(onClick);
    clickRef.current = onClick;
    // Handlers are read through a ref so changing them never re-creates the chart.
    const eventsRef = useRef(events);
    eventsRef.current = events;
    const readyRef = useRef(onReady);
    readyRef.current = onReady;

    useEffect(() => {
        if (!ref.current) return;
        const c = echarts.init(ref.current, undefined, { renderer });
        chart.current = c;
        c.on('click', (p) => clickRef.current?.(p as echarts.ECElementEvent));
        const names = new Set(Object.keys(eventsRef.current ?? {}));
        for (const name of names) c.on(name, (p: unknown) => eventsRef.current?.[name]?.(p));
        if (group) {
            c.group = group;
            echarts.connect(group);
        }
        const ro = new ResizeObserver(() => c.resize());
        ro.observe(ref.current);
        readyRef.current?.(c);
        return () => {
            ro.disconnect();
            readyRef.current?.(null);
            c.dispose();
            chart.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderer, group]);

    useEffect(() => {
        chart.current?.setOption({ ...BASE, ...option }, { notMerge: true });
    }, [option]);

    return <div ref={ref} className={className} style={{ height, width: '100%' }} />;
}

export function chartInstance(el: HTMLElement | null): echarts.ECharts | undefined {
    return el ? echarts.getInstanceByDom(el) : undefined;
}
