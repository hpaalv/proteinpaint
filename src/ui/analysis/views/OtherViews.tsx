import { useMemo, useState } from 'react';
import type { ResultEntry } from '@/compute/store';
import type { DsspResult, ElectrostaticsResult, KvfinderResult, RenumberResult, RosettaInterfaceResult, TmalignResult } from '@/compute/types';
import * as E from '@/engine';
import { CONTINUOUS_RAMPS, RAMP_LABELS } from '@/data/palettes';
import { asBytes, platform, type CoreJob } from '@/platform/bridge';
import { run, viewer } from '@/store/app';
import { AXIS, Chart, TOOLTIP, type ChartOption } from '../../components/Chart';
import { Button, Segmented, Select, Slider, Toggle } from '../../components/Primitives';
import { InterfaceSsView } from './InterfaceSsView';
import { Card, DatasetButtons, fmt, Pane, Table, toCsv } from './common';

// ---------------------------------------------------------------------------

export function ElectrostaticsView({ entry }: { entry: ResultEntry }) {
    const r = entry.data as ElectrostaticsResult;
    const id = entry.structureIds[0]!;
    const v = viewer();
    const [style, setStyle] = useState<E.PotentialStyle>(() => (v && E.hasPotential(v, id)) || E.DEFAULT_POTENTIAL_STYLE);
    const [visible, setVisible] = useState(true);
    const apply = (patch: Partial<E.PotentialStyle>) => {
        const next = { ...style, ...patch };
        setStyle(next);
        if (v) void run(E.stylePotential(v, id, next));
    };
    const ramp = CONTINUOUS_RAMPS[style.ramp];
    return (
        <div className="flex h-full min-h-0 gap-2">
            <div className="flex w-[300px] shrink-0 flex-col gap-2">
                <div className="grid grid-cols-3 gap-1.5">
                    <Card label="carga líquida" value={fmt(r.net_charge, 1)} unit="e" tone={r.net_charge < 0 ? '#ff6b6b' : '#4c8df0'} />
                    <Card label="campo de força" value={r.forcefield} />
                    <Card label="pH · I" value={`${r.ph} · ${r.ionic_strength} M`} />
                </div>
                <div className="text-[10.5px] text-text-2">
                    Grade {r.grid.dime.join('×')} · espaçamento {r.grid.spacing.map((s) => s.toFixed(2)).join('/')} Å
                </div>
                <div className="flex flex-col gap-0.5">
                    <div className="h-3 rounded-sm" style={{ background: `linear-gradient(to right, ${ramp.join(',')})` }} />
                    <div className="tnum flex justify-between text-[10.5px] text-text-1">
                        <span>−{style.range} kT/e</span>
                        <span>0</span>
                        <span>+{style.range} kT/e</span>
                    </div>
                </div>
                <div className="flex gap-1">
                    <Button onClick={() => void platform.showFolder(r.dx_path)}>Abrir .dx</Button>
                    <Button onClick={() => entry.workdir && void platform.showFolder(entry.workdir)}>Pasta do job</Button>
                </div>
            </div>
            <Pane title="Superfície" className="w-[360px] shrink-0">
                <div className="flex flex-col gap-2">
                    <Slider label="Faixa (±)" value={style.range} min={1} max={30} step={0.5} onChange={(x) => apply({ range: x })} format={(x) => `${x.toFixed(1)} kT/e`} />
                    <Select<E.RampId> value={style.ramp} onChange={(x) => apply({ ramp: x })} options={Object.entries(RAMP_LABELS).map(([value, label]) => ({ value: value as E.RampId, label }))} />
                    <Slider label="Opacidade" value={style.opacity} min={0.1} max={1} onChange={(x) => apply({ opacity: x })} format={(x) => `${Math.round(x * 100)}%`} />
                    <Slider label="Offset de amostragem" value={style.normalOffset} min={0} max={4} step={0.1} onChange={(x) => apply({ normalOffset: x })} format={(x) => `${x.toFixed(1)} Å`} />
                    <Toggle checked={visible} onChange={(x) => { setVisible(x); if (v) E.setPotentialVisible(v, id, x); }} label="Mostrar superfície" />
                    <Button variant="ghost" onClick={() => v && void E.removePotential(v, id)}>Remover da cena</Button>
                </div>
            </Pane>
            <p className="max-w-sm self-start text-[11px] leading-relaxed text-text-2">
                Vermelho = negativo, azul = positivo (convenção do ChimeraX com <span className="mono">palette red:white:blue</span>). O offset amostra o mapa um pouco fora da superfície,
                onde o potencial é o que um parceiro de ligação sente.
            </p>
        </div>
    );
}

// ---------------------------------------------------------------------------

export function DsspView({ entry }: { entry: ResultEntry }) {
    const [tab, setTab] = useState<'interface' | 'chains'>('interface');
    // Opened from the form without a pydssp run: only the interface comparison exists.
    if (!entry.data) return <div className="flex h-full min-h-0 flex-col"><InterfaceSsView /></div>;
    return (
        <div className="flex h-full min-h-0 flex-col gap-2">
            <Segmented<'interface' | 'chains'>
                className="w-[280px] shrink-0"
                value={tab}
                onChange={setTab}
                options={[
                    { value: 'interface', label: 'Interface (comparar)' },
                    { value: 'chains', label: 'Cadeias desta estrutura' },
                ]}
            />
            {tab === 'interface' ? <InterfaceSsView /> : <DsspChains entry={entry} />}
        </div>
    );
}

function DsspChains({ entry }: { entry: ResultEntry }) {
    const r = entry.data as DsspResult;
    const id = entry.structureIds[0]!;
    const color = (c: string) => (c === 'H' ? '#E8607A' : c === 'E' ? '#F3C04F' : '#5b6474');
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-3">
                <DatasetButtons id={id} ids={['pydssp']} />
                <span className="text-[10.5px] text-text-2">calculado em {r.device === 'cuda' ? 'GPU (CUDA)' : 'CPU'}</span>
            </div>
            <div className="scroll-themed flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
                {r.chains.map((c) => (
                    <div key={c.chain} className="flex flex-col gap-1">
                        <div className="text-[11px] text-text-1">
                            Cadeia {c.chain} · {c.length} res · hélice {(c.helix * 100).toFixed(0)}% · fita {(c.strand * 100).toFixed(0)}% · loop {(c.loop * 100).toFixed(0)}%
                        </div>
                        <div className="flex h-3 overflow-hidden rounded-sm">
                            {c.string.split('').map((s, i) => (
                                <span key={i} className="h-full flex-1" style={{ background: color(s) }} />
                            ))}
                        </div>
                        <div className="mono text-[10px] break-all text-text-2">{c.string}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

export function TmalignView({ entry }: { entry: ResultEntry }) {
    const r = entry.data as TmalignResult;
    const a = r.alignment;
    const block = 60;
    const blocks = [];
    for (let i = 0; i < a.mobile.length; i += block) blocks.push(i);
    return (
        <div className="flex h-full min-h-0 gap-2">
            <div className="grid w-[300px] shrink-0 grid-cols-2 content-start gap-1.5">
                <Card label="TM-score (ref.)" value={fmt(r.tm_reference, 3)} tone="#4CC9F0" hint="Normalizado pelo comprimento da referência" />
                <Card label="TM-score (móvel)" value={fmt(r.tm_mobile, 3)} />
                {r.tm_average !== null && <Card label="TM-score (média)" value={fmt(r.tm_average, 3)} />}
                {r.tm_custom !== null && <Card label="TM-score (-L)" value={fmt(r.tm_custom, 3)} />}
                <Card label="RMSD" value={fmt(r.rmsd, 2)} unit="Å" />
                <Card label="alinhados" value={`${r.aligned_length}`} hint={`ref ${r.length_reference} · móvel ${r.length_mobile}`} />
                <Card label="identidade" value={fmt(r.seq_identity * 100, 1)} unit="%" />
            </div>
            <Pane title="Alinhamento estrutural (: < 5 Å, . demais pares)" className="min-w-0 flex-1">
                <div className="mono flex flex-col gap-2 text-[11px] leading-tight">
                    {blocks.map((i) => (
                        <div key={i}>
                            <div className="text-text-2">{i + 1}</div>
                            <div className="text-accent whitespace-pre">{a.mobile.slice(i, i + block)}</div>
                            <div className="whitespace-pre text-text-1">{a.markers.slice(i, i + block)}</div>
                            <div className="text-accent-2 whitespace-pre">{a.reference.slice(i, i + block)}</div>
                        </div>
                    ))}
                </div>
            </Pane>
        </div>
    );
}

// ---------------------------------------------------------------------------

export function RenumberView({ entry }: { entry: ResultEntry }) {
    const r = entry.data as RenumberResult;
    const load = async (path: string) => {
        const v = viewer();
        const [f] = await platform.readFiles([path]);
        if (v && f?.ok && f.bytes) await run(E.loadBytes(v, asBytes(f.bytes), { name: path.split('/').pop()!, source: 'file', path }));
    };
    return (
        <Pane title={`Renumeração IMGT · ${r.mhc_class}`} className="h-full">
            <Table
                rows={r.results}
                columns={[
                    { key: 'i', label: 'Entrada', render: (x) => x.input.split('/').pop() },
                    { key: 's', label: '', render: (x) => (x.ok ? <span className="text-ok">ok</span> : <span className="text-err">{x.error}</span>) },
                    { key: 'o', label: 'Saída', render: (x) => (x.output ? <button type="button" className="text-accent" onClick={() => void load(x.output!)}>{x.output.split('/').pop()}</button> : '—') },
                ]}
            />
            <div className="mt-2"><Button onClick={() => void platform.showFolder(r.output_dir)}>Abrir pasta</Button></div>
        </Pane>
    );
}

// ---------------------------------------------------------------------------

interface BatchRow {
    file: string;
    state: CoreJob['state'];
    error: string | null;
    result: unknown;
}

/** One flat record per design, for the table, the scatter and the CSV. */
function flatten(tool: string, row: BatchRow): Record<string, unknown> {
    const name = row.file.split('/').pop();
    if (row.state !== 'done' || !row.result) return { design: name, status: row.state, error: row.error ?? '' };
    if (tool === 'rosetta_interface') {
        const r = row.result as RosettaInterfaceResult;
        return { design: name, status: 'ok', ...r.metrics, n_hbonds_listed: r.hbonds.length, n_unsats_interface: r.unsats.filter((u) => u.origin === 'interface').length };
    }
    if (tool === 'kvfinder') {
        const r = row.result as KvfinderResult;
        const top = r.cavities[0];
        return { design: name, status: 'ok', n_cavities: r.n, total_volume: r.total_volume, largest_volume: top?.volume ?? null, largest_max_depth: top?.max_depth ?? null, largest_avg_depth: top?.avg_depth ?? null, largest_hydropathy: top?.avg_hydropathy ?? null };
    }
    if (tool === 'dssp') {
        const r = row.result as DsspResult;
        const out: Record<string, unknown> = { design: name, status: 'ok' };
        for (const c of r.chains) {
            out[`${c.chain}_helix`] = c.helix;
            out[`${c.chain}_strand`] = c.strand;
            out[`${c.chain}_loop`] = c.loop;
        }
        return out;
    }
    if (tool === 'electrostatics') {
        const r = row.result as ElectrostaticsResult;
        return { design: name, status: 'ok', net_charge: r.net_charge, dx: r.dx_path };
    }
    return { design: name, status: 'ok' };
}

export function BatchView({ entry }: { entry: ResultEntry }) {
    const rows = entry.data as BatchRow[];
    const flat = useMemo(() => rows.map((r) => flatten(entry.tool, r)), [rows, entry.tool]);
    const numericKeys = useMemo(() => {
        const ok = flat.filter((f) => f.status === 'ok');
        const keys = [...new Set(ok.flatMap((f) => Object.keys(f)))].filter((k) => ok.some((f) => typeof f[k] === 'number'));
        return keys;
    }, [flat]);
    const [xKey, setX] = useState(numericKeys.includes('dSASA') ? 'dSASA' : numericKeys[0] ?? '');
    const [yKey, setY] = useState(numericKeys.includes('dG_separated') ? 'dG_separated' : numericKeys[1] ?? '');
    const done = rows.filter((r) => r.state === 'done').length;
    const failed = rows.filter((r) => r.state === 'error').length;
    const scatter: ChartOption = {
        grid: { left: 54, right: 12, top: 14, bottom: 40 },
        tooltip: { ...TOOLTIP, formatter: (p: unknown) => String((p as { data: [number, number, string] }).data[2]) },
        xAxis: { type: 'value', name: xKey, nameLocation: 'middle', nameGap: 24, scale: true, ...AXIS },
        yAxis: { type: 'value', name: yKey, scale: true, ...AXIS },
        series: [
            {
                type: 'scatter',
                symbolSize: 7,
                itemStyle: { color: '#4CC9F0', opacity: 0.85 },
                data: flat.filter((f) => typeof f[xKey] === 'number' && typeof f[yKey] === 'number').map((f) => [f[xKey] as number, f[yKey] as number, String(f.design)]),
            },
        ],
    };
    const cols = ['design', 'status', ...numericKeys.slice(0, 10)];
    return (
        <div className="flex h-full min-h-0 gap-2">
            <Pane title={`${done}/${rows.length} prontos${failed ? ` · ${failed} com erro` : ''}`} className="min-w-0 flex-1" actions={<Button onClick={() => void platform.saveText(toCsv(flat), `lote_${entry.tool}.csv`)}>CSV</Button>}>
                <Table
                    rows={flat}
                    columns={cols.map((k) => ({
                        key: k,
                        label: k,
                        align: k === 'design' || k === 'status' ? undefined : ('right' as const),
                        render: (f: Record<string, unknown>) => {
                            const x = f[k];
                            if (k === 'status') return x === 'ok' ? <span className="text-ok">ok</span> : <span className="text-err" title={String(f.error ?? '')}>{String(x)}</span>;
                            return typeof x === 'number' ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(3)) : String(x ?? '');
                        },
                    }))}
                />
            </Pane>
            {numericKeys.length >= 2 && (
                <Pane
                    title="Dispersão"
                    className="w-[420px] shrink-0"
                    actions={
                        <span className="flex gap-1">
                            <Select value={xKey} onChange={setX} options={numericKeys.map((k) => ({ value: k, label: `x: ${k}` }))} className="h-6 text-[10.5px]" />
                            <Select value={yKey} onChange={setY} options={numericKeys.map((k) => ({ value: k, label: `y: ${k}` }))} className="h-6 text-[10.5px]" />
                        </span>
                    }
                >
                    <Chart option={scatter} height="100%" />
                </Pane>
            )}
        </div>
    );
}
