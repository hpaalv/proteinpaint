import { useState } from 'react';
import { updateResult, type ResultEntry } from '@/compute/store';
import type { Cavity, KvfinderResult } from '@/compute/types';
import * as E from '@/engine';
import { RAMP_LABELS, hexToInt, intToHex } from '@/data/palettes';
import { platform } from '@/platform/bridge';
import { run, viewer } from '@/store/app';
import { AXIS, Chart, TOOLTIP, type ChartOption } from '../../components/Chart';
import { Icon } from '../../components/Icon';
import { Button, Segmented, Select, Slider, Toggle, cx } from '../../components/Primitives';
import { Card, fmt, focusResidues, Pane, Table, toCsv } from './common';

/** pyKVFinder residue classes (calculate_frequencies). */
const CLASS_LABELS: Record<string, { label: string; color: string }> = {
    R1: { label: 'Alifático apolar', color: '#E3C178' },
    R2: { label: 'Aromático', color: '#B07CF7' },
    R3: { label: 'Polar sem carga', color: '#7FD8A4' },
    R4: { label: 'Carga negativa', color: '#FF6B6B' },
    R5: { label: 'Carga positiva', color: '#4C8DF0' },
    RX: { label: 'Não padrão', color: '#8A8F98' },
};

const METRICS: { key: keyof Cavity; label: string; unit: string }[] = [
    { key: 'volume', label: 'Volume', unit: 'Å³' },
    { key: 'area', label: 'Área', unit: 'Å²' },
    { key: 'max_depth', label: 'Prof. máx.', unit: 'Å' },
    { key: 'avg_depth', label: 'Prof. média', unit: 'Å' },
    { key: 'avg_hydropathy', label: 'Hidropatia', unit: '' },
];

export function KvfinderView({ entry }: { entry: ResultEntry }) {
    const r = entry.data as KvfinderResult;
    const id = entry.structureIds[0]!;
    const setId = (entry.meta.extra?.setId as string | null) ?? null;
    const v = viewer();
    const [style, setStyleState] = useState<E.CavityStyle>(() => (v && setId ? E.cavitySetStyle(v, setId) : null) ?? E.DEFAULT_CAVITY_STYLE);
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    const [metric, setMetric] = useState<keyof Cavity>('volume');
    const [current, setCurrent] = useState<string | null>(r.cavities[0]?.tag ?? null);

    const restyle = async (patch: Partial<E.CavityStyle>) => {
        if (!v || !setId) return;
        const next = { ...style, ...patch };
        setStyleState(next);
        await run(E.styleCavities(v, setId, patch));
    };
    const toggle = (tag: string) => {
        if (!v || !setId) return;
        const next = new Set(hidden);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        setHidden(next);
        E.setCavityVisible(v, setId, tag, !next.has(tag));
    };
    const solo = (tag: string | null) => {
        if (!v || !setId) return;
        E.soloCavity(v, setId, tag);
        setHidden(new Set(tag ? r.cavities.map((c) => c.tag).filter((t) => t !== tag) : []));
    };
    const colorOf = (tag: string) => (v ? E.cavityColor(setId, v, tag) : '#4CC9F0');
    const lining = (c: Cavity) => c.residues.map((x) => x.key);

    const paintLining = async () => {
        if (!v) return;
        const colors: Record<string, number> = {};
        for (const c of r.cavities) {
            if (hidden.has(c.tag)) continue;
            for (const k of lining(c)) colors[k] = hexToInt(colorOf(c.tag));
        }
        E.setDataset(v, id, { id: 'kvfinder:lining', label: 'Revestimento das cavidades', source: 'pyKVFinder', kind: 'explicit', values: {}, colors });
        await run(E.showDataset(v, id, 'kvfinder:lining', 'chain'));
    };

    const bar: ChartOption = {
        grid: { left: 46, right: 8, top: 14, bottom: 26 },
        tooltip: { ...TOOLTIP, trigger: 'axis' },
        xAxis: { type: 'category', data: r.cavities.map((c) => c.tag), ...AXIS },
        yAxis: { type: 'value', name: METRICS.find((m) => m.key === metric)!.unit, ...AXIS },
        series: [
            {
                type: 'bar',
                barMaxWidth: 26,
                data: r.cavities.map((c) => ({
                    value: Number(((c[metric] as number | null) ?? 0).toFixed(2)),
                    itemStyle: { color: colorOf(c.tag), opacity: hidden.has(c.tag) ? 0.3 : 1, borderRadius: [3, 3, 0, 0] },
                })),
            },
        ],
    };

    const classes = ['R1', 'R2', 'R3', 'R4', 'R5', 'RX'];
    const composition: ChartOption = {
        grid: { left: 36, right: 8, top: 10, bottom: 46 },
        legend: { type: 'scroll', bottom: 0, textStyle: { color: '#9aa8bf', fontSize: 10 }, itemWidth: 10, itemHeight: 8, pageTextStyle: { color: '#9aa8bf' } },
        tooltip: { ...TOOLTIP, trigger: 'axis' },
        xAxis: { type: 'category', data: r.cavities.map((c) => c.tag), ...AXIS },
        yAxis: { type: 'value', name: 'resíduos', ...AXIS },
        series: classes.map((k) => ({
            name: CLASS_LABELS[k]!.label,
            type: 'bar' as const,
            stack: 'cls',
            barMaxWidth: 26,
            itemStyle: { color: CLASS_LABELS[k]!.color },
            data: r.cavities.map((c) => c.frequencies.CLASS?.[k] ?? 0),
        })),
    };

    const cur = r.cavities.find((c) => c.tag === current);
    const residueFreq: ChartOption | null = cur?.frequencies.RESIDUES
        ? {
              grid: { left: 34, right: 8, top: 8, bottom: 22 },
              tooltip: { ...TOOLTIP, trigger: 'axis' },
              xAxis: { type: 'category', data: Object.keys(cur.frequencies.RESIDUES), ...AXIS, axisLabel: { ...AXIS.axisLabel, fontSize: 9 } },
              yAxis: { type: 'value', minInterval: 1, ...AXIS },
              series: [{ type: 'bar', barMaxWidth: 14, data: Object.values(cur.frequencies.RESIDUES), itemStyle: { color: colorOf(cur.tag), borderRadius: [2, 2, 0, 0] } }],
          }
        : null;

    if (r.n === 0) return <p className="p-4 text-[12px] text-text-2">Nenhuma cavidade encontrada com esses parâmetros. Tente uma sonda externa maior ou um volume mínimo menor.</p>;

    return (
        <div className="flex h-full min-h-0 gap-2">
            {/* Representation controls */}
            <div className="scroll-themed flex w-[260px] shrink-0 flex-col gap-2 overflow-y-auto pr-1">
                <div className="grid grid-cols-2 gap-1.5">
                    <Card label="cavidades" value={r.n} />
                    <Card label="volume total" value={fmt(r.total_volume, 0)} unit="Å³" />
                </div>
                <span className="text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Representação</span>
                <Segmented<E.CavityRepr>
                    value={style.repr}
                    onChange={(x) => void restyle({ repr: x })}
                    options={[
                        { value: 'surface', label: 'Superfície' },
                        { value: 'mesh', label: 'Malha' },
                        { value: 'spheres', label: 'Esferas' },
                        { value: 'points', label: 'Pontos' },
                    ]}
                />
                <Toggle checked={style.surfaceOnly} onChange={(x) => void restyle({ surfaceOnly: x })} label="Só a superfície da cavidade" />
                <Slider label="Opacidade" value={style.opacity} min={0.1} max={1} onChange={(x) => void restyle({ opacity: x })} format={(x) => `${Math.round(x * 100)}%`} />
                <Slider label="Tamanho" value={style.size} min={0.3} max={3} step={0.05} onChange={(x) => void restyle({ size: x })} format={(x) => `${x.toFixed(2)}×`} />
                <span className="mt-1 text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Cor</span>
                <Segmented<E.CavityColorMode>
                    value={style.color}
                    onChange={(x) => void restyle({ color: x })}
                    options={[
                        { value: 'cavity', label: 'Cavidade' },
                        { value: 'depth', label: 'Profund.' },
                        { value: 'hydropathy', label: 'Hidrop.' },
                        { value: 'uniform', label: 'Única' },
                    ]}
                />
                {style.color === 'depth' && (
                    <>
                        <Select<E.RampId> value={style.depthRamp} onChange={(x) => void restyle({ depthRamp: x })} options={Object.entries(RAMP_LABELS).map(([value, label]) => ({ value: value as E.RampId, label }))} />
                        <Slider label="Profundidade máxima da escala" value={style.depthMax} min={1} max={20} step={0.5} onChange={(x) => void restyle({ depthMax: x })} format={(x) => `${x.toFixed(1)} Å`} />
                    </>
                )}
                {style.color === 'hydropathy' && (
                    <>
                        <Select<E.RampId> value={style.hydropathyRamp} onChange={(x) => void restyle({ hydropathyRamp: x })} options={Object.entries(RAMP_LABELS).map(([value, label]) => ({ value: value as E.RampId, label }))} />
                        <p className="text-[10.5px] text-text-2">
                            Escala {r.scale}: {style.hydropathyRange[0]} (hidrofílico) a {style.hydropathyRange[1]} (hidrofóbico)
                        </p>
                    </>
                )}
                {style.color === 'uniform' && <input type="color" value={intToHex(style.uniform)} onChange={(e) => void restyle({ uniform: hexToInt(e.target.value) })} className="h-7 w-12" />}
                <span className="mt-1 text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Resíduos de revestimento</span>
                <Button onClick={() => void paintLining()}>Colorir pela cavidade</Button>
                <Button
                    onClick={async () => {
                        const keys = r.cavities.filter((c) => !hidden.has(c.tag)).flatMap(lining);
                        await focusResidues(id, keys);
                        const vv = viewer();
                        if (vv) await run(E.setLayer(vv, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'sticks', size: 1 }));
                    }}
                >
                    Sticks nos visíveis
                </Button>
                <div className="mt-auto flex gap-1 pt-1">
                    <Button onClick={() => void platform.saveText(toCsv(r.cavities.map((c) => ({ tag: c.tag, volume: c.volume, area: c.area, max_depth: c.max_depth, avg_depth: c.avg_depth, avg_hydropathy: c.avg_hydropathy, n_residues: c.residues.length, residues: c.residues.map((x) => `${x.key}${x.name}`).join(' '), openings_area: Object.values(c.openings).reduce((a, b) => a + b, 0) }))), 'cavidades.csv')}>
                        CSV
                    </Button>
                    {setId && (
                        <Button
                            variant="ghost"
                            onClick={async () => {
                                if (!v) return;
                                await E.removeCavities(v, setId);
                                updateResult(entry.id, { meta: { ...entry.meta, extra: { ...entry.meta.extra, setId: null } } });
                            }}
                        >
                            Remover da cena
                        </Button>
                    )}
                </div>
            </div>

            {/* Table */}
            <Pane title="Cavidades" className="w-[400px] shrink-0">
                <Table
                    rows={r.cavities}
                    onRow={(c) => {
                        setCurrent(c.tag);
                        if (v && setId) E.focusCavity(v, setId, c.tag);
                    }}
                    columns={[
                        {
                            key: 'v',
                            label: '',
                            render: (c) => (
                                <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                    <button type="button" title={hidden.has(c.tag) ? 'Mostrar' : 'Esconder'} onClick={() => toggle(c.tag)} className="text-text-1 hover:text-text-0">
                                        <Icon name={hidden.has(c.tag) ? 'eyeOff' : 'eye'} size={12} />
                                    </button>
                                    <button type="button" title="Só esta" onClick={() => solo(hidden.size === r.cavities.length - 1 && !hidden.has(c.tag) ? null : c.tag)} className="text-text-1 hover:text-text-0">
                                        <Icon name="target" size={12} />
                                    </button>
                                </span>
                            ),
                        },
                        { key: 't', label: 'Cavidade', render: (c) => <span className={cx('mono flex items-center gap-1', current === c.tag && 'text-accent')}><span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(c.tag) }} />{c.tag}</span> },
                        { key: 'vol', label: 'Vol Å³', align: 'right', render: (c) => c.volume.toFixed(1) },
                        { key: 'ar', label: 'Área Å²', align: 'right', render: (c) => c.area.toFixed(1) },
                        { key: 'md', label: 'Prof. máx', align: 'right', render: (c) => c.max_depth?.toFixed(2) ?? '—' },
                        { key: 'ad', label: 'média', align: 'right', render: (c) => c.avg_depth?.toFixed(2) ?? '—' },
                        { key: 'h', label: 'Hidrop.', align: 'right', render: (c) => c.avg_hydropathy?.toFixed(2) ?? '—' },
                        { key: 'n', label: 'Res.', align: 'right', render: (c) => c.residues.length },
                        { key: 'o', label: 'Aberturas', align: 'right', render: (c) => Object.keys(c.openings).length || '—' },
                    ]}
                />
                {cur && (
                    <div className="mt-2">
                        <div className="mb-1 text-[10.5px] text-text-2">Revestimento de {cur.tag} — clique para focar</div>
                        <div className="mono flex flex-wrap gap-1 text-[10.5px]">
                            {cur.residues.map((x) => (
                                <button key={x.key} type="button" onClick={() => void focusResidues(id, [x.key])} className="rounded bg-bg-0 px-1 py-0.5 hover:bg-bg-3">
                                    {x.key} {x.name}
                                </button>
                            ))}
                        </div>
                        {Object.keys(cur.openings).length > 0 && (
                            <div className="mt-1 text-[10.5px] text-text-2">Aberturas: {Object.entries(cur.openings).map(([k, a]) => `${k} ${a.toFixed(1)} Å²`).join(' · ')}</div>
                        )}
                    </div>
                )}
            </Pane>

            {/* Charts */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Pane
                    title="Por cavidade"
                    className="min-h-0 flex-1"
                    actions={
                        <span className="flex gap-1">
                            {METRICS.map((m) => (
                                <button key={m.key} type="button" onClick={() => setMetric(m.key)} className={`rounded px-1.5 text-[10.5px] ${metric === m.key ? 'bg-accent/15 text-accent' : 'text-text-2'}`}>
                                    {m.label}
                                </button>
                            ))}
                        </span>
                    }
                >
                    <Chart option={bar} height="100%" onClick={(p) => { setCurrent(String(p.name)); if (v && setId) E.focusCavity(v, setId, String(p.name)); }} />
                </Pane>
                <div className="flex min-h-0 flex-1 gap-2">
                    <Pane title="Composição do revestimento" className="min-w-0 flex-1">
                        <Chart option={composition} height="100%" onClick={(p) => setCurrent(String(p.name))} />
                    </Pane>
                    {residueFreq && (
                        <Pane title={`Resíduos de ${cur!.tag}`} className="min-w-0 flex-1">
                            <Chart option={residueFreq} height="100%" />
                        </Pane>
                    )}
                </div>
            </div>
        </div>
    );
}
