import { useEffect, useMemo, useState } from 'react';
import * as E from '@/engine';
import { platform } from '@/platform/bridge';
import { useApp, viewer } from '@/store/app';
import { AXIS, Chart, TOOLTIP, type ChartOption } from '../../components/Chart';
import { Button, Segmented, Spinner, cx } from '../../components/Primitives';
import { defaultSides } from '../../panels/shared';
import { focusResidues, Pane, toCsv } from './common';

const SS_ORDER: E.SsClass[] = ['helix', 'strand', 'loop'];
const SS_LABEL: Record<E.SsClass, string> = { helix: 'Hélice', strand: 'Fita β', loop: 'Alça' };
/** Same hues as the pydssp strip and the secondary-structure colour scheme. */
const SS_COLOR: Record<E.SsClass, string> = { helix: '#E8607A', strand: '#F3C04F', loop: '#7D8799' };

type Breakdown = 'sides' | 'chains';
type Scale = 'percent' | 'count';

interface Group {
    /** Panel title: "Binder", "Alvo", or a chain with its role. */
    key: string;
    title: string;
}

interface Row {
    id: E.StructureId;
    name: string;
    /** group key → residues of that group. */
    groups: Map<string, E.InterfaceSsResidue[]>;
    source: E.InterfaceSsReport['source'];
}

/** Splits a report into the panels shown: binder vs target, or binder vs each target chain role. */
function groupsOf(s: E.StructureInfo, r: E.InterfaceSsReport, breakdown: Breakdown): Map<string, E.InterfaceSsResidue[]> {
    const out = new Map<string, E.InterfaceSsResidue[]>([['A', r.sideA.residues]]);
    if (breakdown === 'sides') {
        out.set('B', r.sideB.residues);
        return out;
    }
    // By role, not by chain letter: designs label chains differently, roles line them up.
    for (const res of r.sideB.residues) {
        const role = s.chains.find((c) => c.authAsymId === res.chain)?.role ?? 'unassigned';
        const list = out.get(`role:${role}`) ?? [];
        list.push(res);
        out.set(`role:${role}`, list);
    }
    return out;
}

const count = (list: E.InterfaceSsResidue[], ss: E.SsClass) => list.reduce((n, r) => n + (r.ss === ss ? 1 : 0), 0);

/**
 * Secondary structure at the interface, compared across structures: for every loaded
 * design, how much of what each side puts into the interface is helix, strand or loop.
 * One small panel per side (or per target chain role), structures as rows, so a
 * helical binder and a loop-driven one read apart at a glance.
 */
export function InterfaceSsView() {
    const structures = useApp((s) => s.structures);
    const [chosen, setChosen] = useState<E.StructureId[] | null>(null);
    const [breakdown, setBreakdown] = useState<Breakdown>('chains');
    const [scale, setScale] = useState<Scale>('percent');
    const [reports, setReports] = useState<Map<E.StructureId, E.InterfaceSsReport>>(new Map());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ids = chosen ?? structures.map((s) => s.id);
    // Recompute when the set of structures, their roles or their datasets (pydssp) change.
    const signature = structures
        .filter((s) => ids.includes(s.id))
        .map((s) => `${s.id}|${s.chains.map((c) => c.role).join(',')}|${s.modelIndex}`)
        .join(';');

    useEffect(() => {
        const v = viewer();
        if (!v) return;
        let cancelled = false;
        setBusy(true);
        void (async () => {
            const next = new Map<E.StructureId, E.InterfaceSsReport>();
            const failures: string[] = [];
            for (const s of structures.filter((x) => ids.includes(x.id))) {
                const sides = defaultSides(s);
                if (!sides.a.length || !sides.b.length) continue;
                const r = await E.interfaceSecondaryStructure(v, s.id, sides.a, sides.b);
                if (r.ok) next.set(s.id, r.value);
                else failures.push(`${s.alias || s.name}: ${r.error}`);
            }
            if (cancelled) return;
            setReports(next);
            setError(failures.length ? failures.join(' · ') : null);
            setBusy(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

    const { rows, groups } = useMemo(() => {
        const rows: Row[] = [];
        const groupTitles = new Map<string, string>();
        for (const s of structures) {
            const r = reports.get(s.id);
            if (!r || !ids.includes(s.id)) continue;
            const g = groupsOf(s, r, breakdown);
            for (const key of g.keys()) {
                if (groupTitles.has(key)) continue;
                if (key === 'A') groupTitles.set(key, 'Binder');
                else if (key === 'B') groupTitles.set(key, 'Alvo');
                else groupTitles.set(key, E.CHAIN_ROLE_LABELS[key.slice(5) as E.ChainRole] ?? key.slice(5));
            }
            rows.push({ id: s.id, name: s.alias || s.name, groups: g, source: r.source });
        }
        // Binder first, then the target panels in a stable order (peptide before MHC reads naturally).
        const order = ['A', 'B', 'role:peptide', 'role:mhc', 'role:b2m', 'role:target', 'role:ligand', 'role:unassigned', 'role:binder'];
        const groups: Group[] = [...groupTitles.entries()]
            .sort((a, b) => (order.indexOf(a[0]) + 100 * Number(order.indexOf(a[0]) < 0)) - (order.indexOf(b[0]) + 100 * Number(order.indexOf(b[0]) < 0)))
            .map(([key, title]) => ({ key, title }));
        return { rows, groups };
    }, [reports, breakdown, structures, signature]); // eslint-disable-line react-hooks/exhaustive-deps

    const option = useMemo<ChartOption>(() => {
        const n = Math.max(1, groups.length);
        const gap = 3;
        const left = 18;
        const width = (100 - left - 2 - gap * (n - 1)) / n;
        const names = rows.map((r) => r.name);
        const grids = groups.map((_, i) => ({ left: `${left + i * (width + gap)}%`, width: `${width}%`, top: 28, bottom: 40, containLabel: false }));
        const xAxes = groups.map((_, i) => ({
            type: 'value' as const,
            gridIndex: i,
            max: scale === 'percent' ? 100 : undefined,
            ...AXIS,
            axisLabel: { ...AXIS.axisLabel, formatter: scale === 'percent' ? '{value}%' : '{value}' },
            splitNumber: 2,
        }));
        // One title per panel, over its own grid.
        const titles = groups.map((g, i) => ({
            text: g.title,
            left: `${left + i * (width + gap)}%`,
            top: 4,
            textStyle: { color: '#e6ecf5', fontSize: 11.5, fontWeight: 600 as const },
        }));
        const yAxes = groups.map((_, i) => ({
            type: 'category' as const,
            gridIndex: i,
            data: names,
            inverse: true,
            ...AXIS,
            axisLabel: { ...AXIS.axisLabel, show: i === 0, width: 150, overflow: 'truncate' as const, color: '#c9d2e0' },
            axisTick: { show: false },
        }));
        const series = groups.flatMap((g, i) =>
            SS_ORDER.map((ss) => ({
                type: 'bar' as const,
                name: SS_LABEL[ss],
                stack: g.key,
                xAxisIndex: i,
                yAxisIndex: i,
                barMaxWidth: 22,
                itemStyle: { color: SS_COLOR[ss], borderRadius: 0, borderColor: '#0b0e14', borderWidth: 0.5 },
                emphasis: { focus: 'series' as const },
                label: {
                    show: true,
                    color: ss === 'strand' ? '#1a1406' : '#fff',
                    fontSize: 10,
                    formatter: (p: { value: number }) => (scale === 'percent' ? (p.value >= 9 ? `${Math.round(p.value)}%` : '') : p.value >= 2 ? String(p.value) : ''),
                },
                data: rows.map((r) => {
                    const list = r.groups.get(g.key) ?? [];
                    const c = count(list, ss);
                    const value = scale === 'percent' ? (list.length ? (c / list.length) * 100 : 0) : c;
                    return { value, meta: { id: r.id, name: r.name, group: g.title, ss, count: c, total: list.length, keys: list.filter((x) => x.ss === ss).map((x) => `${x.chain}:${E.residueKey(x.seq, x.insCode)}`), residues: list.filter((x) => x.ss === ss).map((x) => `${x.name}${x.seq}`) } };
                }),
            })),
        );
        return {
            title: titles,
            grid: grids,
            xAxis: xAxes,
            yAxis: yAxes,
            legend: { bottom: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: '#9aa8bf', fontSize: 10.5 }, data: SS_ORDER.map((s) => SS_LABEL[s]) },
            tooltip: {
                ...TOOLTIP,
                trigger: 'item',
                formatter: (p: unknown) => {
                    const m = (p as { data: { meta: { name: string; group: string; ss: E.SsClass; count: number; total: number; residues: string[] } } }).data.meta;
                    const pct = m.total ? ((m.count / m.total) * 100).toFixed(0) : '0';
                    const list = m.residues.slice(0, 18).join(' ') + (m.residues.length > 18 ? ' …' : '');
                    return `<b>${m.name}</b> · ${m.group}<br/>${SS_LABEL[m.ss]}: <b>${m.count}</b> de ${m.total} resíduos (${pct}%)${list ? `<br/><span style="color:#9aa8bf">${list}</span>` : ''}<br/><span style="color:#6f7d95">clique para selecionar na cena</span>`;
                },
            },
            series,
        } as ChartOption;
    }, [rows, groups, scale]);

    const exportCsv = () => {
        const out: Record<string, unknown>[] = [];
        for (const r of rows) {
            for (const g of groups) {
                const list = r.groups.get(g.key) ?? [];
                const row: Record<string, unknown> = { estrutura: r.name, painel: g.title, residuos: list.length, fonte: r.source };
                for (const ss of SS_ORDER) {
                    row[`${ss}_n`] = count(list, ss);
                    row[`${ss}_pct`] = list.length ? Number(((count(list, ss) / list.length) * 100).toFixed(1)) : 0;
                }
                row.residuos_lista = list.map((x) => `${x.chain}:${x.name}${x.seq}${x.insCode}:${x.ss}`).join(' ');
                out.push(row);
            }
        }
        void platform.saveText(toCsv(out), 'estrutura_secundaria_interface.csv');
    };

    const sources = new Set(rows.map((r) => r.source));
    const height = Math.max(150, 64 + rows.length * 30);

    return (
        <div className="flex min-h-0 flex-1 gap-2">
            <div className="flex w-[210px] shrink-0 flex-col gap-2">
                <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] text-text-2">Estruturas comparadas</span>
                    <div className="scroll-themed flex max-h-[120px] flex-col gap-0.5 overflow-auto">
                        {structures.map((s) => {
                            const on = ids.includes(s.id);
                            return (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => setChosen(on ? ids.filter((x) => x !== s.id) : [...ids, s.id])}
                                    className={cx('truncate rounded border px-1.5 py-0.5 text-left text-[11px] transition-colors duration-100', on ? 'border-accent/60 bg-accent/10 text-text-0' : 'border-stroke text-text-2 hover:text-text-0')}
                                >
                                    {s.alias || s.name}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <Segmented<Breakdown>
                    value={breakdown}
                    onChange={setBreakdown}
                    options={[
                        { value: 'chains', label: 'Por papel', title: 'Binder, peptídeo e MHC separados' },
                        { value: 'sides', label: 'Binder × alvo' },
                    ]}
                />
                <Segmented<Scale>
                    value={scale}
                    onChange={setScale}
                    options={[
                        { value: 'percent', label: '%' },
                        { value: 'count', label: 'Resíduos' },
                    ]}
                />
                <Button onClick={exportCsv} disabled={rows.length === 0}>
                    Exportar CSV
                </Button>
                <p className="text-[10.5px] leading-snug text-text-2">
                    Resíduos da interface: ≥ 2 átomos a ≤ 4 Å do outro lado (lados pelos papéis das cadeias). Estrutura secundária:{' '}
                    {sources.has('pydssp') && sources.has('dssp') ? 'pydssp onde foi rodado, DSSP do Mol* nas demais' : sources.has('pydssp') ? 'pydssp' : 'DSSP do Mol*'}.
                </p>
            </div>
            <Pane title="Estrutura secundária da interface" className="min-w-0 flex-1" actions={busy ? <Spinner size={12} /> : null}>
                {error && <p className="mb-1 text-[10.5px] text-warn">{error}</p>}
                {rows.length === 0 ? (
                    <p className="py-6 text-center text-[11.5px] text-text-2">{busy ? 'Calculando…' : 'Nenhuma estrutura com binder e alvo definidos. Ajuste os papéis das cadeias na árvore.'}</p>
                ) : (
                    <Chart
                        option={option}
                        height={height}
                        onClick={(p) => {
                            const m = (p.data as { meta?: { id: E.StructureId; keys: string[] } } | undefined)?.meta;
                            if (m && m.keys.length) void focusResidues(m.id, m.keys);
                        }}
                    />
                )}
            </Pane>
        </div>
    );
}
