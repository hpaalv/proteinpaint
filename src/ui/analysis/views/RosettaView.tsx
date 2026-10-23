import { useMemo, useState } from 'react';
import { drawRosettaOverlays, rosettaDatasets } from '@/compute/apply';
import { updateResult, type ResultEntry } from '@/compute/store';
import type { RelaxResult, RosettaInterfaceResult } from '@/compute/types';
import * as E from '@/engine';
import { asBytes, platform } from '@/platform/bridge';
import { useApp, viewer } from '@/store/app';
import { HydrogenControl } from '../../panels/shared';
import { AXIS, Chart, TOOLTIP, type ChartOption } from '../../components/Chart';
import { Button, Toggle } from '../../components/Primitives';
import { Card, DatasetButtons, fmt, focusResidues, Pane, Table, toCsv } from './common';

export function RosettaInterfaceView({ entry }: { entry: ResultEntry }) {
    const r = entry.data as RosettaInterfaceResult;
    const id = entry.structureIds[0]!;
    const structure = useApp((s) => s.structures.find((x) => x.id === id) ?? null);
    const m = r.metrics;
    const overlays = (entry.meta.extra?.overlays as { hbonds: boolean; unsats: boolean; preexisting: boolean }) ?? { hbonds: true, unsats: true, preexisting: false };
    const [perResKey, setPerResKey] = useState<'dG' | 'dSASA' | 'ddG'>('dG');

    const setOverlays = async (o: typeof overlays) => {
        updateResult(entry.id, { meta: { ...entry.meta, extra: { ...entry.meta.extra, overlays: o } } });
        await drawRosettaOverlays(id, r, o);
    };

    const perRes = useMemo(() => {
        const src = perResKey === 'ddG' ? {} : (r.per_residue[perResKey] ?? {});
        const sideA = new Set(r.side_a);
        return Object.entries(src)
            .map(([k, val]) => ({ key: k, value: val, side: sideA.has(k.split(':')[0]!) ? 'A' : 'B' }))
            .sort((a, b) => (a.side === b.side ? a.key.localeCompare(b.key, undefined, { numeric: true }) : a.side < b.side ? -1 : 1));
    }, [r, perResKey]);

    const perResOption: ChartOption = {
        grid: { left: 44, right: 8, top: 14, bottom: 48 },
        tooltip: { ...TOOLTIP, trigger: 'axis' },
        xAxis: { type: 'category', data: perRes.map((p) => p.key), ...AXIS, axisLabel: { ...AXIS.axisLabel, rotate: 60, fontSize: 9 } },
        yAxis: { type: 'value', name: perResKey === 'dG' ? 'ΔG (REU)' : 'ΔSASA (Å²)', ...AXIS },
        series: [
            {
                type: 'bar',
                data: perRes.map((p) => ({ value: Number(p.value.toFixed(2)), itemStyle: { color: p.side === 'A' ? '#4CC9F0' : '#F72585', borderRadius: 2 } })),
                barMaxWidth: 14,
            },
        ],
    };

    const alaOption: ChartOption = {
        grid: { left: 44, right: 8, top: 14, bottom: 40 },
        tooltip: { ...TOOLTIP, trigger: 'axis' },
        xAxis: { type: 'category', data: r.alanine_scan.map((a) => `${a.key} ${a.name}`), ...AXIS, axisLabel: { ...AXIS.axisLabel, rotate: 50, fontSize: 9 } },
        yAxis: { type: 'value', name: 'ΔΔG (REU)', ...AXIS },
        series: [
            {
                type: 'bar',
                data: r.alanine_scan.map((a) => ({ value: Number(a.ddG.toFixed(2)), itemStyle: { color: a.ddG >= 1 ? '#FF6B6B' : a.ddG >= 0 ? '#FFB454' : '#38D9A9', borderRadius: 2 } })),
                barMaxWidth: 18,
                markLine: { silent: true, symbol: 'none', lineStyle: { color: '#6b7891', type: 'dashed' }, data: [{ yAxis: 1 }] },
            },
        ],
    };

    return (
        <div className="flex h-full min-h-0 gap-2">
            <div className="scroll-themed flex w-[290px] shrink-0 flex-col gap-2 overflow-y-auto pr-1">
                <div className="grid grid-cols-3 gap-1.5">
                    <Card label="ΔG separado" value={fmt(m.dG_separated, 1)} unit="REU" tone={m.dG_separated !== null && m.dG_separated !== undefined && m.dG_separated < 0 ? '#38D9A9' : '#FF6B6B'} />
                    <Card label="ΔSASA" value={fmt(m.dSASA, 0)} unit="Å²" />
                    <Card label="ΔG/ΔSASA ×100" value={fmt(m.dG_dSASA_ratio, 2)} />
                    <Card label="Sc" value={fmt(m.sc_value, 3)} hint="Complementaridade de forma; interfaces nativas ~0.6–0.8" />
                    <Card label="CMS" value={fmt(m.contact_molecular_surface, 0)} hint="Contact molecular surface" />
                    <Card label="packstat" value={fmt(m.packstat, 3)} />
                    <Card label="H-bonds" value={m.interface_hbonds} tone="#3FC7F5" />
                    <Card label="ΔUnsat (IAM)" value={m.delta_unsat_hbonds} tone="#FF6B6B" />
                    <Card label="Resíduos A / B" value={`${m.nres_side_a ?? '—'} / ${m.nres_side_b ?? '—'}`} />
                </div>
                {m.dG_separated !== null && m.dG_separated !== undefined && m.dG_separated > 0 && (
                    <p className="rounded border border-warn/40 bg-warn/5 p-1.5 text-[10.5px] text-warn">ΔG positivo: típico de estrutura não relaxada (choques). Rode o FastRelax e analise o modelo relaxado.</p>
                )}
                <div className="flex flex-col gap-1 rounded-md border border-stroke p-2">
                    <Toggle checked={overlays.hbonds} onChange={(x) => void setOverlays({ ...overlays, hbonds: x })} label={`H-bonds (${r.hbonds.length}), espessura ∝ energia`} />
                    <Toggle checked={overlays.unsats} onChange={(x) => void setOverlays({ ...overlays, unsats: x })} label={`Insatisfeitos (${r.unsats.filter((u) => u.origin === 'interface').length}) em vermelho`} />
                    {r.unsats.some((u) => u.origin === 'preexisting') && <Toggle checked={overlays.preexisting} onChange={(x) => void setOverlays({ ...overlays, preexisting: x })} label="Incluir pré-existentes (laranja)" />}
                </div>
                <HydrogenControl structure={structure} />
                <DatasetButtons id={id} ids={rosettaDatasets(r).map((d) => d.id)} />
                <div className="mt-auto flex gap-1">
                    <Button
                        onClick={() =>
                            void platform.saveText(
                                toCsv([{ interface: r.interface, scorefxn: r.scorefxn, ...m }]),
                                `interface_${r.interface}.csv`,
                            )
                        }
                    >
                        CSV
                    </Button>
                    <Button onClick={() => entry.workdir && void platform.showFolder(entry.workdir)}>Pasta do job</Button>
                    <span className="self-center text-[10.5px] text-text-2">{r.seconds.toFixed(1)} s</span>
                </div>
            </div>

            <Pane
                title={perResKey === 'dG' ? 'ΔG por resíduo (azul = lado A, rosa = lado B)' : perResKey === 'dSASA' ? 'ΔSASA por resíduo' : 'Alanine scan · ΔΔG (vermelho ≥ 1 REU = hotspot)'}
                className="min-w-[320px] flex-1"
                actions={
                    <span className="flex gap-1">
                        {(['dG', 'dSASA', 'ddG'] as const)
                            .filter((k) => k !== 'ddG' || r.alanine_scan.length > 0)
                            .map((k) => (
                                <button key={k} type="button" onClick={() => setPerResKey(k)} className={`rounded px-1.5 text-[10.5px] ${perResKey === k ? 'bg-accent/15 text-accent' : 'text-text-2'}`}>
                                    {k === 'dG' ? 'ΔG' : k === 'dSASA' ? 'ΔSASA' : 'ΔΔG'}
                                </button>
                            ))}
                    </span>
                }
            >
                {perResKey === 'ddG' ? (
                    <Chart option={alaOption} height="100%" onClick={(p) => void focusResidues(id, [String(p.name).split(' ')[0]!])} />
                ) : (
                    <Chart option={perResOption} height="100%" onClick={(p) => void focusResidues(id, [String(p.name)])} />
                )}
            </Pane>

            <div className="flex w-[360px] shrink-0 flex-col gap-2">
                <Pane title={`H-bonds (${r.hbonds.length})`} className="max-h-[50%] min-h-[90px] flex-1">
                    <Table
                        rows={r.hbonds}
                        onRow={(h) => void focusResidues(id, [h.donor.key, h.acceptor.key])}
                        columns={[
                            { key: 'd', label: 'Doador', render: (h) => <span className="mono">{`${h.donor.key} ${h.donor.name} ${h.donor.atom}`}</span> },
                            { key: 'a', label: 'Aceptor', render: (h) => <span className="mono">{`${h.acceptor.key} ${h.acceptor.name} ${h.acceptor.atom}`}</span> },
                            { key: 'e', label: 'E', align: 'right', render: (h) => h.energy.toFixed(2) },
                            { key: 'da', label: 'D–A', align: 'right', render: (h) => h.distance_DA.toFixed(2) },
                            { key: 't', label: 'tipo', render: (h) => h.type },
                        ]}
                    />
                </Pane>
                <Pane title={`Insatisfeitos (${r.unsats.length}) · pares mais fortes (${r.pair_energies.length})`} className="min-h-[90px] flex-1">
                    <Table
                        rows={r.unsats}
                        onRow={(u) => void focusResidues(id, [u.key])}
                        columns={[
                            { key: 'r', label: 'Átomo', render: (u) => <span className="mono">{`${u.key} ${u.name} ${u.atom}`}</span> },
                            { key: 'k', label: 'tipo', render: (u) => u.kind },
                            { key: 'o', label: 'origem', render: (u) => (u.origin === 'interface' ? <span className="text-err">interface</span> : 'pré-existente') },
                            { key: 's', label: 'SASA c→s', align: 'right', render: (u) => `${u.sasa_complex.toFixed(1)}→${u.sasa_separated.toFixed(1)}` },
                        ]}
                    />
                    <div className="mt-2" />
                    <Table
                        rows={r.pair_energies.slice(0, 40)}
                        onRow={(p) => void focusResidues(id, [p.a, p.b])}
                        columns={[
                            { key: 'a', label: 'Lado A', render: (p) => <span className="mono">{`${p.a} ${p.a_name}`}</span> },
                            { key: 'b', label: 'Lado B', render: (p) => <span className="mono">{`${p.b} ${p.b_name}`}</span> },
                            { key: 'e', label: 'E (REU)', align: 'right', render: (p) => p.energy.toFixed(2) },
                        ]}
                    />
                </Pane>
            </div>
        </div>
    );
}

export function RelaxView({ entry }: { entry: ResultEntry }) {
    const data = entry.data as { runs: { job: string; result: RelaxResult }[]; loaded: Record<string, E.StructureId> };
    const runs = data.runs;
    const scatter: ChartOption = {
        grid: { left: 52, right: 12, top: 14, bottom: 36 },
        tooltip: { ...TOOLTIP, formatter: (p: unknown) => {
            const d = (p as { data: [number, number, number] }).data;
            return `seed ${d[2]}<br/>score ${d[1].toFixed(1)} REU<br/>RMSD Cα ${d[0].toFixed(2)} Å`;
        } },
        xAxis: { type: 'value', name: 'RMSD Cα (Å)', nameLocation: 'middle', nameGap: 22, ...AXIS },
        yAxis: { type: 'value', name: 'score (REU)', scale: true, ...AXIS },
        series: [{ type: 'scatter', symbolSize: 9, data: runs.map((r) => [r.result.ca_rmsd, r.result.score_after, r.result.seed]), itemStyle: { color: '#4CC9F0' } }],
    };
    const load = async (r: RelaxResult) => {
        const v = viewer();
        if (!v) return;
        const [f] = await platform.readFiles([r.relaxed_path]);
        if (f?.ok && f.bytes) await E.loadBytes(v, asBytes(f.bytes), { name: `relax s${r.seed} (${r.score_after.toFixed(0)})`, source: 'file', path: r.relaxed_path });
    };
    return (
        <div className="flex h-full min-h-0 gap-2">
            <Pane title="Score × RMSD (cada ponto = um modelo)" className="w-[360px] shrink-0">
                <Chart option={scatter} height="100%" />
            </Pane>
            <Pane title={`Modelos (${runs.length}), do menor score`} className="min-w-0 flex-1">
                <Table
                    rows={runs}
                    columns={[
                        { key: 's', label: 'seed', render: (r) => r.result.seed },
                        { key: 'b', label: 'score antes', align: 'right', render: (r) => r.result.score_before.toFixed(1) },
                        { key: 'a', label: 'score depois', align: 'right', render: (r) => r.result.score_after.toFixed(1) },
                        { key: 'ca', label: 'RMSD Cα', align: 'right', render: (r) => r.result.ca_rmsd.toFixed(2) },
                        { key: 'aa', label: 'RMSD átomos', align: 'right', render: (r) => r.result.all_atom_rmsd.toFixed(2) },
                        { key: 'dg', label: 'ΔG interface', align: 'right', render: (r) => r.result.interface?.dG_separated.toFixed(1) ?? '—' },
                        { key: 'sc', label: 'Sc', align: 'right', render: (r) => r.result.interface?.sc_value.toFixed(3) ?? '—' },
                        { key: 'hb', label: 'H-bonds', align: 'right', render: (r) => r.result.interface?.interface_hbonds ?? '—' },
                        { key: 't', label: 's', align: 'right', render: (r) => r.result.seconds.toFixed(0) },
                        { key: 'l', label: '', render: (r) => (data.loaded[r.job] ? <span className="text-ok">na cena</span> : <button type="button" className="text-accent" onClick={() => void load(r.result)}>abrir</button>) },
                    ]}
                />
                <div className="mt-2">
                    <Button onClick={() => void platform.saveText(toCsv(runs.map((r) => ({ ...r.result, interface: undefined, ...(r.result.interface ?? {}) }))), 'relax.csv')}>CSV</Button>
                </div>
            </Pane>
        </div>
    );
}
