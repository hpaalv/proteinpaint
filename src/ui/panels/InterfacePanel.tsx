import { useEffect, useMemo, useState } from 'react';
import * as E from '@/engine';
import { INTERACTION_STYLES } from '@/data/palettes';
import { run, useApp, viewer } from '@/store/app';
import { Button, Field, Section, Segmented, Select, Slider, Spinner, Toggle, cx } from '../components/Primitives';
import { PROTOCOL_DEFAULTS, runInterfaceProtocol, useProtocol, type ProtocolOptions } from '@/compute/protocol';
import { defaultSides, HydrogenControl, NoStructure, useActive } from './shared';

const KIND_ORDER: E.InteractionKind[] = ['hydrogen-bond', 'salt-bridge', 'pi-stacking', 'cation-pi', 'halogen-bond', 'metal', 'hydrophobic', 'weak-hydrogen-bond'];

function ChainChips({ s, value, onChange, accent }: { s: E.StructureInfo; value: string[]; onChange: (v: string[]) => void; accent: string }) {
    return (
        <div className="flex flex-wrap gap-1">
            {s.chains
                .filter((c) => c.isPolymer)
                .map((c) => {
                    const on = value.includes(c.authAsymId);
                    return (
                        <button
                            key={c.authAsymId}
                            type="button"
                            onClick={() => onChange(on ? value.filter((x) => x !== c.authAsymId) : [...value, c.authAsymId])}
                            className={cx('mono h-6 rounded border px-2 text-[11.5px] transition-colors duration-100', on ? accent : 'border-stroke-2 text-text-2 hover:text-text-0')}
                            title={`${E.CHAIN_ROLE_LABELS[c.role]} · ${c.residueCount} res`}
                        >
                            {c.authAsymId}
                            {c.alias ? ` ${c.alias}` : ''}
                        </button>
                    );
                })}
        </div>
    );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
    return (
        <div className="rounded-md border border-stroke bg-bg-0 px-2 py-1.5">
            <div className="tnum text-[17px] leading-tight font-semibold" style={tone ? { color: tone } : undefined}>
                {value}
            </div>
            <div className="text-[10.5px] text-text-2">{label}</div>
        </div>
    );
}

export function InterfacePanel() {
    const active = useActive();
    const report = useApp((s) => s.interfaceReport);
    const kinds = useApp((s) => s.interactionKinds);
    const [sideA, setSideA] = useState<string[]>([]);
    const [sideB, setSideB] = useState<string[]>([]);
    const [cutoff, setCutoff] = useState(E.DEFAULT_CONTACTS.cutoff);
    const [minAtoms, setMinAtoms] = useState(E.DEFAULT_CONTACTS.minAtoms);
    const [withH, setWithH] = useState(E.DEFAULT_CONTACTS.includeHydrogens);
    const [busy, setBusy] = useState(false);
    const [showAtoms, setShowAtoms] = useState(true);
    const [protocol, setProtocol] = useState<ProtocolOptions>(PROTOCOL_DEFAULTS);
    const [scope, setScope] = useState<'active' | 'all'>('active');
    const runs = useProtocol((s) => s.runs);
    const running = useProtocol((s) => s.running);
    const structures = useApp((s) => s.structures);

    // Re-seed the sides from the chain roles whenever the structure or its roles change.
    const roleKey = active ? `${active.id}|${active.chains.map((c) => c.role).join(',')}` : '';
    useEffect(() => {
        if (!active) return;
        const d = defaultSides(active);
        setSideA(d.a);
        setSideB(d.b);
    }, [roleKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const counts = useMemo(() => {
        const m = new Map<E.InteractionKind, number>();
        for (const r of report?.interactions ?? []) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
        return m;
    }, [report]);

    if (!active) return <NoStructure />;
    const v = viewer();
    if (!v) return null;
    const kindSet = new Set(kinds);
    const reportIsForActive = report?.sideA.structureId === active.id;

    const analyze = async () => {
        setBusy(true);
        useApp.setState({ busy: 'Calculando interações da interface' });
        const r = await run(
            E.analyzeInterface(v, { structureId: active.id, chains: sideA }, { structureId: active.id, chains: sideB }, { cutoff, minAtoms, includeHydrogens: withH }),
        );
        useApp.setState({ busy: null });
        setBusy(false);
        if (!r) return;
        useApp.setState({ interfaceReport: r });
        await run(E.showInteractions(v, r, kindSet));
        if (showAtoms) await run(E.showInteractionAtoms(v, r, kindSet));
    };

    const setKinds = async (next: E.InteractionKind[]) => {
        useApp.setState({ interactionKinds: next });
        if (!report) return;
        const set = new Set(next);
        await run(E.showInteractions(v, report, set));
        // The atoms follow the lines: unticking a kind takes away the chemistry only
        // that kind was showing.
        if (showAtoms) await run(E.showInteractionAtoms(v, report, set));
    };

    const showSticks = async () => {
        if (!report) return;
        const bySide = [...report.residuesA, ...report.residuesB];
        const perChain = new Map<string, string[]>();
        for (const r of bySide) perChain.set(r.chain, [...(perChain.get(r.chain) ?? []), E.residueKey(r.seq, r.insCode)]);
        E.clearSelection(v);
        for (const [chain, keys] of perChain) await E.selectResidues(v, active.id, chain, keys, 'add');
        await run(E.setLayer(v, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'sticks', size: 1 }));
    };

    const focusPair = async (r: E.InteractionRecord) => {
        E.clearSelection(v);
        await E.selectResidues(v, active.id, r.a.chain, [E.residueKey(r.a.seq, r.a.insCode)], 'add');
        await E.selectResidues(v, active.id, r.b.chain, [E.residueKey(r.b.seq, r.b.insCode)], 'add');
        E.focusSelection(v);
    };

    const shown = (report?.interactions ?? []).filter((r) => kindSet.has(r.kind));

    return (
        <div>
            <Section title="Lados da interface">
                <div className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-1">Lado A (binder)</span>
                    <ChainChips s={active} value={sideA} onChange={setSideA} accent="border-accent bg-accent/12 text-accent" />
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-1">Lado B (alvo)</span>
                    <ChainChips s={active} value={sideB} onChange={setSideB} accent="border-accent-2 bg-accent-2/12 text-accent-2" />
                </div>
                <Slider label="Cutoff de contato" value={cutoff} min={3} max={8} step={0.1} onChange={setCutoff} format={(x) => `${x.toFixed(1)} Å`} />
                <Slider label="Mínimo de átomos por resíduo" value={minAtoms} min={1} max={5} step={1} onChange={setMinAtoms} format={(x) => `≥ ${x}`} />
                <Toggle checked={withH} onChange={setWithH} label="Contar hidrogênios presentes no arquivo" />
                <Button variant="primary" onClick={() => void analyze()} disabled={busy || sideA.length === 0 || sideB.length === 0}>
                    Analisar interface
                </Button>
                <p className="text-[11px] leading-relaxed text-text-2">
                    Interações: modelo de features do Mol* (geometria). Energias e H-bonds do Rosetta chegam na Fase 2.
                </p>
            </Section>

            {report && reportIsForActive && (
                <>
                    <Section title="Resumo">
                        <div className="grid grid-cols-3 gap-1.5">
                            <Stat label={`resíduos lado A`} value={report.residuesA.length} tone="var(--accent)" />
                            <Stat label={`resíduos lado B`} value={report.residuesB.length} tone="var(--accent-2)" />
                            <Stat label={`pares de átomos ≤ ${report.contacts.cutoff} Å`} value={report.atomContacts} />
                            <Stat label="ligações de H" value={counts.get('hydrogen-bond') ?? 0} tone={INTERACTION_STYLES['hydrogen-bond'].color} />
                            <Stat label="pontes salinas" value={counts.get('salt-bridge') ?? 0} tone={INTERACTION_STYLES['salt-bridge'].color} />
                            <Stat label="π (stack + cátion)" value={(counts.get('pi-stacking') ?? 0) + (counts.get('cation-pi') ?? 0)} tone={INTERACTION_STYLES['pi-stacking'].color} />
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                            <Button onClick={() => void showSticks()}>Sticks da interface</Button>
                            <Button onClick={() => void E.hideInteractions(v)} variant="ghost">
                                Esconder linhas
                            </Button>
                        </div>
                        <Toggle
                            checked={showAtoms}
                            onChange={(x) => {
                                setShowAtoms(x);
                                if (x) void run(E.showInteractionAtoms(v, report, kindSet));
                                else void E.hideInteractionAtoms(v);
                            }}
                            label="Mostrar os átomos das ligações"
                        />
                        <HydrogenControl structure={active} />
                    </Section>

                    <Section title="Razões por cadeia">
                        <p className="text-[10.5px] leading-snug text-text-2">
                            Quanto da interface cada cadeia do alvo carrega — o número que responde "estou ganhando peptídeo e perdendo MHC?".
                        </p>
                        {(() => {
                            const perChain = E.contactsPerChain(report, 'B');
                            const total = perChain.reduce((n, c) => n + c.atoms, 0) || 1;
                            const roleOf = (chain: string) => active.chains.find((c) => c.authAsymId === chain);
                            return (
                                <div className="flex flex-col gap-1.5">
                                    {perChain.map((c) => {
                                        const share = (c.atoms / total) * 100;
                                        const info = roleOf(c.chain);
                                        return (
                                            <div key={c.chain} className="flex flex-col gap-0.5">
                                                <div className="flex items-baseline gap-1.5 text-[11px]">
                                                    <span className="mono text-text-0">{c.chain}</span>
                                                    <span className="text-text-2">{info ? E.CHAIN_ROLE_LABELS[info.role] : ''}</span>
                                                    <span className="tnum ml-auto text-text-1">
                                                        {c.residues} res · {c.atoms} contatos · {c.interactions} lig.
                                                    </span>
                                                    <span className="tnum w-10 text-right font-semibold text-accent">{share.toFixed(0)}%</span>
                                                </div>
                                                <div className="h-1.5 overflow-hidden rounded-full bg-bg-3">
                                                    <div className="h-full origin-left rounded-full bg-accent transition-transform duration-300" style={{ transform: `scaleX(${share / 100})` }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {(() => {
                                        const pep = perChain.find((c) => roleOf(c.chain)?.role === 'peptide');
                                        const mhc = perChain.filter((c) => roleOf(c.chain)?.role === 'mhc' || roleOf(c.chain)?.role === 'target');
                                        const mhcAtoms = mhc.reduce((n, c) => n + c.atoms, 0);
                                        if (!pep || mhcAtoms === 0) return null;
                                        return (
                                            <div className="mt-1 rounded-md border border-stroke bg-bg-0 px-2 py-1.5">
                                                <div className="tnum text-[15px] font-semibold text-accent">{(pep.atoms / mhcAtoms).toFixed(2)}</div>
                                                <div className="text-[10.5px] text-text-2">contatos peptídeo ÷ MHC (quanto maior, mais específico do peptídeo)</div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            );
                        })()}
                    </Section>

                    <Section title="Tipos mostrados">
                        <div className="flex flex-col gap-1">
                            {KIND_ORDER.map((k) => {
                                const style = INTERACTION_STYLES[k];
                                const on = kindSet.has(k);
                                return (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => void setKinds(on ? kinds.filter((x) => x !== k) : [...kinds, k])}
                                        className={cx('flex h-6 items-center gap-2 rounded px-1 text-[12px] hover:bg-bg-3', !on && 'opacity-45')}
                                    >
                                        <svg width="28" height="6" aria-hidden="true">
                                            <line x1="1" y1="3" x2="27" y2="3" stroke={style.color} strokeWidth="2.5" strokeDasharray={style.dashes > 1 ? `${26 / style.dashes / 1.6} ${26 / style.dashes / 2.6}` : undefined} />
                                        </svg>
                                        <span className="flex-1 text-left">{style.label}</span>
                                        <span className="tnum text-text-1">{counts.get(k) ?? 0}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </Section>

                    <Section title={`Interações (${shown.length})`}>
                        <div className="scroll-themed max-h-72 overflow-y-auto rounded-md border border-stroke">
                            {shown.length === 0 && <p className="p-2 text-[11.5px] text-text-2">Nenhuma interação dos tipos marcados.</p>}
                            {shown.map((r, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => void focusPair(r)}
                                    className="mono flex h-6 w-full items-center gap-1.5 border-b border-stroke/60 px-2 text-left text-[11px] last:border-b-0 hover:bg-bg-3"
                                >
                                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: INTERACTION_STYLES[r.kind].color }} />
                                    <span className="text-accent">{E.residueLabel(r.a)}</span>
                                    <span className="text-text-2">—</span>
                                    <span className="text-accent-2">{E.residueLabel(r.b)}</span>
                                    <span className="ml-auto text-text-1">{r.distance.toFixed(2)} Å</span>
                                </button>
                            ))}
                        </div>
                    </Section>

                    <Section title="Resíduos de interface" defaultOpen={false}>
                        {(['A', 'B'] as const).map((side) => {
                            const list = side === 'A' ? report.residuesA : report.residuesB;
                            return (
                                <div key={side}>
                                    <div className="mb-1 text-[11px] text-text-1">
                                        Lado {side} · {list.length} resíduos (átomos em contato)
                                    </div>
                                    <div className="mono flex flex-wrap gap-1 text-[11px]">
                                        {list.map((r) => (
                                            <span key={`${r.chain}${r.seq}${r.insCode}`} className="rounded bg-bg-0 px-1.5 py-0.5 text-text-0">
                                                {E.residueLabel(r)}
                                                <span className="text-text-2"> {r.contactAtoms}</span>
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </Section>
                </>
            )}

            <Section title="Rosetta: relax + interface">
                <p className="text-[10.5px] leading-snug text-text-2">
                    FastRelax no complexo e, em seguida, o InterfaceAnalyzer no modelo relaxado — ΔG, ΔSASA, Sc, H-bonds e insatisfeitos do Rosetta, que é o número comparável entre designs.
                </p>
                <div className="grid grid-cols-2 gap-2">
                    <Field label="Repetições do relax">
                        <Slider label="" value={protocol.repeats} min={1} max={15} step={1} defaultValue={5} onChange={(repeats) => setProtocol({ ...protocol, repeats })} format={(x) => `${x.toFixed(0)}×`} />
                    </Field>
                    <Field label="Modelos (o melhor fica)">
                        <Slider label="" value={protocol.nstruct} min={1} max={8} step={1} defaultValue={1} onChange={(nstruct) => setProtocol({ ...protocol, nstruct })} format={(x) => x.toFixed(0)} />
                    </Field>
                </div>
                <Field label="Região móvel">
                    <Select
                        value={protocol.region}
                        onChange={(region) => setProtocol({ ...protocol, region })}
                        options={[
                            { value: 'interface', label: 'Só a interface (rápido)' },
                            { value: 'all', label: 'Estrutura inteira' },
                            { value: 'chains', label: 'As cadeias escolhidas' },
                        ]}
                    />
                </Field>
                <Toggle checked={protocol.skipRelax} onChange={(skipRelax) => setProtocol({ ...protocol, skipRelax })} label="Pular o relax (medir como está)" />
                <Field label="Rodar em">
                    <Segmented<'active' | 'all'>
                        value={scope}
                        onChange={setScope}
                        options={[
                            { value: 'active', label: 'Estrutura ativa' },
                            { value: 'all', label: `Todas (${structures.length})`, title: 'Supõe a mesma arquitetura de cadeias em todas' },
                        ]}
                    />
                </Field>
                <Button
                    variant="primary"
                    icon="flask"
                    loading={running}
                    disabled={sideA.length === 0 || sideB.length === 0}
                    onClick={() =>
                        void runInterfaceProtocol(scope === 'active' ? [active.id] : structures.map((s) => s.id), { ...protocol, sideA, sideB })
                    }
                >
                    {running ? 'Rodando…' : 'Rodar protocolo'}
                </Button>
                {scope === 'all' && structures.length > 1 && (
                    <p className="text-[10.5px] leading-snug text-warn">
                        Usa as mesmas cadeias ({sideA.join(', ')} × {sideB.join(', ')}) em todas. Confira se a arquitetura é igual.
                    </p>
                )}

                {Object.values(runs).length > 0 && (
                    <div className="flex flex-col gap-1.5">
                        {Object.values(runs).map((r) => {
                            const dG = r.analysis?.metrics?.dG_separated;
                            const tone = r.stage === 'error' ? 'text-err' : r.stage === 'done' || r.stage === 'cached' ? 'text-ok' : 'text-accent';
                            return (
                                <div key={r.structureId} className="scale-in rounded-md border border-stroke bg-bg-0 px-2 py-1.5">
                                    <div className="flex items-center gap-1.5">
                                        {(r.stage === 'relaxing' || r.stage === 'analyzing') && <Spinner size={11} className="text-accent" />}
                                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-0" title={r.name}>
                                            {r.name}
                                        </span>
                                        <span className={cx('text-[10.5px]', tone)}>
                                            {r.stage === 'relaxing' ? `relaxando ${protocol.repeats}×` : r.stage === 'analyzing' ? 'medindo interface' : r.stage === 'cached' ? 'já calculado' : r.stage === 'done' ? `${r.seconds.toFixed(0)} s` : r.stage === 'error' ? 'erro' : 'na fila'}
                                        </span>
                                    </div>
                                    {(r.stage === 'relaxing' || r.stage === 'analyzing') && (
                                        <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-3">
                                            <div className={cx('h-full rounded-full bg-accent', r.progress > 0 ? 'origin-left transition-transform duration-300' : 'progress-indeterminate w-full')} style={r.progress > 0 ? { transform: `scaleX(${r.progress})` } : undefined} />
                                        </div>
                                    )}
                                    {r.error && <p className="mt-1 text-[10.5px] leading-snug text-err">{r.error}</p>}
                                    {!r.error && r.message && (r.stage === 'done' || r.stage === 'cached') && <p className="mt-0.5 text-[10px] leading-snug text-warn">{r.message}</p>}
                                    {(r.stage === 'done' || r.stage === 'cached') && r.analysis && (
                                        <div className="tnum mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-text-1">
                                            {typeof dG === 'number' && <span>ΔG <span className="text-text-0">{dG.toFixed(1)}</span> REU</span>}
                                            {typeof r.analysis.metrics?.dSASA_int === 'number' && <span>ΔSASA <span className="text-text-0">{Math.round(r.analysis.metrics.dSASA_int)}</span> Å²</span>}
                                            {typeof r.analysis.metrics?.sc_value === 'number' && <span>Sc <span className="text-text-0">{r.analysis.metrics.sc_value.toFixed(2)}</span></span>}
                                            {typeof r.analysis.metrics?.delta_unsatHbonds === 'number' && <span>insat. <span className="text-text-0">{r.analysis.metrics.delta_unsatHbonds}</span></span>}
                                            {r.relax && <span>RMSD <span className="text-text-0">{r.relax.ca_rmsd.toFixed(2)}</span> Å</span>}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                <p className="text-[10.5px] leading-snug text-text-2">
                    Comparar várias estruturas, lado a lado: aba <span className="text-text-1">Comparar</span>.
                </p>
            </Section>
        </div>
    );
}
