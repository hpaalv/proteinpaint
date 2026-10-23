import { useEffect, useMemo, useState } from 'react';
import * as E from '@/engine';
import { run, toast, useApp, viewer } from '@/store/app';
import { openFiles } from '@/store/actions';
import { act } from '@/store/history';
import { cachedRun, PROTOCOL_DEFAULTS, runInterfaceProtocol, useProtocol, type ProtocolOptions } from '@/compute/protocol';
import { Button, Field, Section, Segmented, Select, Slider, Spinner, Toggle, cx } from '../components/Primitives';
import { Icon } from '../components/Icon';

/** The chain of `s` that best matches `refChain`: same role first, then closest length. */
function matchChain(s: E.StructureInfo, refChain: E.ChainInfo): E.ChainInfo | undefined {
    const candidates = s.chains.filter((c) => c.isPolymer);
    const sameRole = candidates.filter((c) => c.role === refChain.role && c.role !== 'unassigned');
    const pool = sameRole.length ? sameRole : candidates;
    return [...pool].sort((a, b) => Math.abs(a.residueCount - refChain.residueCount) - Math.abs(b.residueCount - refChain.residueCount))[0];
}

function chainOf(s: E.StructureInfo | undefined, chain: string): E.ChainInfo | undefined {
    return s?.chains.find((c) => c.authAsymId === chain);
}

function Metric({ label, value, unit, tone, best }: { label: string; value: number | null | undefined; unit?: string; tone?: string; best?: boolean }) {
    return (
        <div className={cx('rounded border px-1.5 py-1', best ? 'border-ok/50 bg-ok/8' : 'border-transparent')}>
            <div className="tnum text-[13px] leading-tight font-semibold" style={tone ? { color: tone } : undefined}>
                {value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(Math.abs(value) >= 100 ? 0 : 2)}
                {unit && <span className="ml-0.5 text-[9px] font-normal text-text-2">{unit}</span>}
            </div>
            <div className="text-[9.5px] text-text-2">{label}</div>
        </div>
    );
}

export function ComparePanel() {
    const structures = useApp((s) => s.structures);
    const reports = useApp((s) => s.superposeReports);
    const runs = useProtocol((s) => s.runs);
    const running = useProtocol((s) => s.running);
    const [referenceId, setReferenceId] = useState('');
    const [fitChain, setFitChain] = useState('');
    const [method, setMethod] = useState<E.SuperposeMethod>('sequence');
    const [measureChain, setMeasureChain] = useState('');
    const [deviations, setDeviations] = useState<E.ChainDeviation[]>([]);
    const [protocol, setProtocol] = useState<ProtocolOptions>(PROTOCOL_DEFAULTS);
    const [busy, setBusy] = useState(false);
    const v = viewer();

    const reference = structures.find((s) => s.id === referenceId) ?? structures[0];
    const polymer = reference?.chains.filter((c) => c.isPolymer) ?? [];
    const fit = fitChain && polymer.some((c) => c.authAsymId === fitChain) ? fitChain : (polymer.find((c) => c.role !== 'binder')?.authAsymId ?? polymer[0]?.authAsymId ?? '');
    const measure = measureChain && polymer.some((c) => c.authAsymId === measureChain) ? measureChain : (polymer.find((c) => c.role === 'binder')?.authAsymId ?? polymer[1]?.authAsymId ?? '');
    const others = useMemo(() => structures.filter((s) => s.id !== reference?.id), [structures, reference?.id]);

    // A structure list change invalidates measurements made against the old scene.
    useEffect(() => setDeviations([]), [structures.length, reference?.id, fit]);

    if (!v) return null;
    if (structures.length < 2) {
        return (
            <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
                <Icon name="align" size={20} className="text-text-2" />
                <p className="text-[12px] leading-relaxed text-text-1">
                    Comparar precisa de duas ou mais estruturas. Abra os designs que quer sobrepor — eles entram na cena juntos.
                </p>
                <Button variant="primary" icon="file" onClick={() => void openFiles()}>
                    Abrir mais estruturas
                </Button>
                <p className="text-[10.5px] text-text-2">Também dá para arrastar vários arquivos para a área 3D de uma vez.</p>
            </div>
        );
    }

    const superpose = async () => {
        if (!reference) return;
        const refChain = chainOf(reference, fit);
        if (!refChain) return toast('Escolha a cadeia de ajuste.', 'error');
        const mobiles = others.flatMap((s) => {
            const m = matchChain(s, refChain);
            return m ? [{ structureId: s.id, chain: m.authAsymId }] : [];
        });
        if (mobiles.length === 0) return toast('Nenhuma cadeia correspondente nas outras estruturas.', 'error');
        setBusy(true);
        const results = await act('superpor estruturas', () => E.superposeChains(v, { structureId: reference.id, chain: fit }, mobiles, method));
        setBusy(false);
        if (!results) return;
        for (const r of results) if (!r.ok) toast(r.error, 'error');
        useApp.setState({ superposeReports: results.flatMap((r) => (r.ok ? [r.value] : [])) });
    };

    /** RMSD of another chain, measured in the coordinates currently on screen. */
    const measureOther = async () => {
        if (!reference || !measure) return;
        const refChain = chainOf(reference, measure);
        if (!refChain) return;
        const mobiles = others.flatMap((s) => {
            const m = matchChain(s, refChain);
            return m ? [{ structureId: s.id, chain: m.authAsymId }] : [];
        });
        const r = await run(E.measureChains(v, { structureId: reference.id, chain: measure }, mobiles, method));
        if (r) setDeviations(r);
    };

    const nameOf = (id: E.StructureId) => {
        const i = structures.findIndex((s) => s.id === id);
        return `#${i + 1} ${structures[i]?.alias || structures[i]?.name}`;
    };

    // Rosetta numbers per structure: whatever the protocol has, from this run or the cache.
    const rosetta = structures.map((s) => {
        const live = runs[s.id];
        const hit = cachedRun(s.id, { ...protocol, sideA: [], sideB: [] });
        const analysis = live?.analysis ?? hit?.analysis ?? null;
        return { id: s.id, name: nameOf(s.id), stage: live?.stage, metrics: analysis?.metrics ?? null, relax: live?.relax ?? hit?.relax ?? null };
    });
    const withMetrics = rosetta.filter((r) => r.metrics);
    const bestDG = withMetrics.length ? Math.min(...withMetrics.map((r) => (r.metrics!.dG_separated as number) ?? Infinity)) : null;

    return (
        <div>
            <Section title="Superposição">
                <Field label="Referência (fica parada)">
                    <Select value={reference?.id ?? ''} onChange={setReferenceId} options={structures.map((s, i) => ({ value: s.id, label: `#${i + 1} ${s.alias || s.name}` }))} />
                </Field>
                <Field label="Alinhar pela cadeia">
                    <Select
                        value={fit}
                        onChange={setFitChain}
                        options={polymer.map((c) => ({ value: c.authAsymId, label: `${c.authAsymId} · ${E.CHAIN_ROLE_LABELS[c.role]} · ${c.residueCount} res` }))}
                    />
                </Field>
                <Field label="Método">
                    <Segmented<E.SuperposeMethod>
                        value={method}
                        onChange={setMethod}
                        options={[
                            { value: 'sequence', label: 'Sequência', title: 'Needleman–Wunsch/BLOSUM62 + Kabsch com poda a 2 Å, como o matchmaker do ChimeraX' },
                            { value: 'structure', label: 'Estrutura', title: 'TM-align: independente de sequência, para designs diferentes do mesmo fold' },
                        ]}
                    />
                </Field>
                <p className="text-[10.5px] leading-snug text-text-2">
                    Cada outra estrutura é movida pela cadeia de mesmo papel (ou de comprimento mais próximo) da escolhida acima.
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                    <Button variant="primary" icon="align" loading={busy} onClick={() => void superpose()}>
                        Superpor todas
                    </Button>
                    <Button
                        onClick={async () => {
                            for (const s of structures) await E.resetSuperposition(v, s.id);
                            useApp.setState({ superposeReports: [] });
                            setDeviations([]);
                        }}
                    >
                        Restaurar
                    </Button>
                </div>
                <Button icon="file" variant="ghost" onClick={() => void openFiles()}>
                    Abrir mais estruturas na cena
                </Button>
            </Section>

            <Section title="Desvio de outra cadeia">
                <p className="text-[10.5px] leading-snug text-text-2">
                    Depois de alinhar por <span className="mono text-text-1">{fit || '—'}</span>, mede o quanto outra cadeia ficou longe — nas coordenadas que estão na tela, sem reajustar nada. É assim que se vê se o binder pousa no mesmo lugar.
                </p>
                <Field label="Medir a cadeia">
                    <Select
                        value={measure}
                        onChange={setMeasureChain}
                        options={polymer.map((c) => ({ value: c.authAsymId, label: `${c.authAsymId} · ${E.CHAIN_ROLE_LABELS[c.role]} · ${c.residueCount} res` }))}
                    />
                </Field>
                <Button icon="ruler" onClick={() => void measureOther()} disabled={!measure || measure === fit && polymer.length > 1}>
                    Medir nas {others.length} outra{others.length > 1 ? 's' : ''}
                </Button>
                {measure === fit && <p className="text-[10.5px] text-warn">A cadeia medida é a mesma do ajuste: o RMSD vai ser o do próprio alinhamento.</p>}
                {deviations.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {deviations.map((d, i) => (
                            <div key={i} className="scale-in flex items-center gap-2 rounded-md border border-stroke bg-bg-0 px-2 py-1">
                                <span className="mono min-w-0 flex-1 truncate text-[11px]" title={nameOf(d.mobile.structureId)}>
                                    {nameOf(d.mobile.structureId)} /{d.mobile.chain}
                                </span>
                                {d.rmsd === null ? (
                                    <span className="text-[10.5px] text-warn">{d.note}</span>
                                ) : (
                                    <>
                                        <span className="tnum text-[13px] font-semibold text-accent">{d.rmsd.toFixed(2)}</span>
                                        <span className="text-[9.5px] text-text-2">Å RMSD</span>
                                        <span className="tnum text-[10.5px] text-text-2">máx {d.maxDeviation?.toFixed(1)} · {d.alignedPairs} res · {Math.round(d.identity * 100)}% id</span>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            <Section title="Rosetta nas estruturas">
                <p className="text-[10.5px] leading-snug text-text-2">
                    O mesmo protocolo da aba Interface (FastRelax + InterfaceAnalyzer), rodado em todas as estruturas carregadas. O que já foi calculado com estes mesmos parâmetros não roda de novo.
                </p>
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Repetições">
                        <Slider label="" value={protocol.repeats} min={1} max={15} step={1} defaultValue={5} onChange={(repeats) => setProtocol({ ...protocol, repeats })} format={(x) => `${x.toFixed(0)}×`} />
                    </Field>
                    <Field label="Região">
                        <Select
                            value={protocol.region}
                            onChange={(region) => setProtocol({ ...protocol, region })}
                            options={[
                                { value: 'interface', label: 'Interface' },
                                { value: 'all', label: 'Tudo' },
                            ]}
                        />
                    </Field>
                </div>
                <Toggle checked={protocol.skipRelax} onChange={(skipRelax) => setProtocol({ ...protocol, skipRelax })} label="Pular o relax (medir como está)" />
                <Button
                    variant="primary"
                    icon="flask"
                    loading={running}
                    onClick={() => {
                        const ref = reference;
                        if (!ref) return;
                        // Sides from the reference's roles; each structure resolves its own
                        // chains when the letters differ (compute/protocol.ts).
                        const binders = ref.chains.filter((c) => c.isPolymer && c.role === 'binder').map((c) => c.authAsymId);
                        const rest = ref.chains.filter((c) => c.isPolymer && c.role !== 'binder').map((c) => c.authAsymId);
                        if (!binders.length || !rest.length) return toast('Marque uma cadeia como binder na árvore para definir os lados.', 'error');
                        void runInterfaceProtocol(structures.map((s) => s.id), { ...protocol, sideA: binders, sideB: rest });
                    }}
                >
                    {running ? 'Rodando…' : `Rodar nas ${structures.length} estruturas`}
                </Button>

                {rosetta.some((r) => r.metrics || r.stage) && (
                    <div className="flex flex-col gap-1.5">
                        {rosetta.map((r) => {
                            const live = runs[r.id];
                            const dG = r.metrics?.dG_separated as number | undefined;
                            return (
                                <div key={r.id} className="rounded-md border border-stroke bg-bg-0 px-2 py-1.5">
                                    <div className="flex items-center gap-1.5">
                                        {(live?.stage === 'relaxing' || live?.stage === 'analyzing') && <Spinner size={11} className="text-accent" />}
                                        <span className="min-w-0 flex-1 truncate text-[11.5px]" title={r.name}>
                                            {r.name}
                                        </span>
                                        {live?.stage === 'error' && <span className="text-[10px] text-err">erro</span>}
                                        {live?.stage === 'cached' && <span className="text-[10px] text-text-2">do cache</span>}
                                    </div>
                                    {live?.error && <p className="text-[10px] leading-snug text-err">{live.error}</p>}
                                    {r.metrics && (
                                        <div className="mt-1 grid grid-cols-5 gap-1">
                                            <Metric label="ΔG" value={dG} unit="REU" tone="var(--accent)" best={bestDG !== null && dG === bestDG} />
                                            <Metric label="ΔSASA" value={r.metrics.dSASA_int as number} unit="Å²" />
                                            <Metric label="Sc" value={r.metrics.sc_value as number} />
                                            <Metric label="insat." value={r.metrics.delta_unsatHbonds as number} />
                                            <Metric label="RMSD relax" value={r.relax?.ca_rmsd ?? null} unit="Å" />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </Section>

            {reports.length > 0 && (
                <Section title="Alinhamento, resíduo a resíduo" defaultOpen={false}>
                    {reports.map((r, i) => {
                        const worst = [...r.pairs].sort((a, b) => b.distance - a.distance).slice(0, 5);
                        const maxD = Math.max(1, ...r.pairs.map((p) => p.distance));
                        return (
                            <div key={i} className="rounded-md border border-stroke bg-bg-0 p-2">
                                <div className="mono truncate text-[11.5px] text-text-0">
                                    {nameOf(r.mobile.structureId)} /{r.mobile.chain} → {nameOf(r.reference.structureId)} /{r.reference.chain}
                                </div>
                                <div className="mt-1.5 grid grid-cols-3 gap-1 text-center">
                                    <div>
                                        <div className="tnum text-[15px] font-semibold text-accent">{r.rmsd.toFixed(2)}</div>
                                        <div className="text-[10px] text-text-2">RMSD Å ({r.fitPairs} pares)</div>
                                    </div>
                                    <div>
                                        <div className="tnum text-[15px] font-semibold">{r.rmsdAllPairs.toFixed(2)}</div>
                                        <div className="text-[10px] text-text-2">todos ({r.alignedPairs})</div>
                                    </div>
                                    <div>
                                        <div className="tnum text-[15px] font-semibold">{r.tmScore !== null ? r.tmScore.toFixed(3) : `${Math.round(r.sequenceIdentity * 100)}%`}</div>
                                        <div className="text-[10px] text-text-2">{r.tmScore !== null ? 'TM-score' : 'identidade'}</div>
                                    </div>
                                </div>
                                <div className="mt-2 flex h-6 items-end gap-px" title="Desvio Cα por resíduo alinhado">
                                    {r.pairs.map((p, k) => (
                                        <div key={k} className={cx('flex-1 rounded-t-[1px]', p.usedInFit ? 'bg-accent/70' : 'bg-warn/70')} style={{ height: `${Math.max(4, (p.distance / maxD) * 100)}%` }} />
                                    ))}
                                </div>
                                <div className="mono mt-1 text-[10.5px] text-text-2">maiores desvios: {worst.map((p) => `${p.mobile} ${p.distance.toFixed(1)}`).join(' · ')}</div>
                            </div>
                        );
                    })}
                </Section>
            )}
        </div>
    );
}
