import { useEffect, useMemo, useState } from 'react';
import * as E from '@/engine';
import { addResult, cancelJob, groupId, initCompute, inputFor, refreshCapabilities, submit, useCompute } from '@/compute/store';
import { toolLabel } from '@/compute/apply';
import {
    DSSP_DEFAULTS,
    ELECTROSTATICS_DEFAULTS,
    KVFINDER_DEFAULTS,
    MHCX_SETTINGS_DEFAULTS,
    RELAX_DEFAULTS,
    ROSETTA_INTERFACE_DEFAULTS,
    TMALIGN_DEFAULTS,
    type ToolId,
} from '@/compute/types';
import { platform } from '@/platform/bridge';
import { toast, useApp } from '@/store/app';
import { Icon } from '../components/Icon';
import { Button, Section, Select, cx } from '../components/Primitives';
import { ParamForm, type Values } from './ParamForm';
import {
    DSSP_SPECS,
    ELECTROSTATICS_SPECS,
    HYDROGENS_SPECS,
    KVFINDER_SPECS,
    MHCX_SPECS,
    RELAX_SPECS,
    RESIDUE_CLASS_PRESETS,
    ROSETTA_INTERFACE_SPECS,
    TMALIGN_SPECS,
} from './specs';

const TOOLS: { id: ToolId; label: string; sub: string; needs: (keyof NonNullable<ReturnType<typeof useCompute.getState>['caps']>)[] }[] = [
    { id: 'rosetta_interface', label: 'Interface (Rosetta)', sub: 'dG, Sc, CMS, H-bonds, insatisfeitos, ΔΔG', needs: ['pyrosetta'] },
    { id: 'rosetta_relax', label: 'FastRelax', sub: 'nstruct em paralelo na CPU', needs: ['pyrosetta'] },
    { id: 'kvfinder', label: 'Cavidades (KVFinder)', sub: 'volume, profundidade, hidropatia', needs: ['pykvfinder'] },
    { id: 'mhcxgraph', label: 'MHCXGraph', sub: 'superfície conservada entre pMHC', needs: ['mhcxgraph'] },
    { id: 'electrostatics', label: 'Eletrostática', sub: 'PDB2PQR + APBS', needs: ['apbs', 'pdb2pqr'] },
    { id: 'dssp', label: 'pydssp', sub: 'estrutura secundária na GPU', needs: ['pydssp'] },
    { id: 'tmalign', label: 'TM-align', sub: 'superposição estrutural', needs: ['tmalign'] },
    { id: 'mhcx_renumber', label: 'Renumeração IMGT', sub: 'MHC I / II (MHCXGraph)', needs: ['mhcxgraph'] },
    { id: 'hydrogens', label: 'Adicionar hidrogênios', sub: 'PDB2PQR + PROPKA, substitui a estrutura', needs: ['pdb2pqr'] },
];

const DEFAULTS: Record<ToolId, Values> = {
    rosetta_interface: { ...ROSETTA_INTERFACE_DEFAULTS },
    rosetta_relax: { ...RELAX_DEFAULTS },
    dssp: { ...DSSP_DEFAULTS },
    tmalign: { ...TMALIGN_DEFAULTS },
    electrostatics: { ...ELECTROSTATICS_DEFAULTS },
    kvfinder: { ...KVFINDER_DEFAULTS },
    mhcxgraph: { ...MHCX_SETTINGS_DEFAULTS },
    mhcx_renumber: { mhc_class: 'MHCI', warn_score: 50, suffix: '_imgt', load: true },
    hydrogens: { ph: 7, propka: true },
};

// ---------------------------------------------------------------------------

function ChainChips({ s, value, onChange, tone = 'accent' }: { s: E.StructureInfo; value: string[]; onChange: (v: string[]) => void; tone?: 'accent' | 'accent-2' | 'ok' }) {
    const on = tone === 'accent' ? 'border-accent bg-accent/12 text-accent' : tone === 'accent-2' ? 'border-accent-2 bg-accent-2/12 text-accent-2' : 'border-ok bg-ok/12 text-ok';
    return (
        <div className="flex flex-wrap gap-1">
            {s.chains
                .filter((c) => c.isPolymer)
                .map((c) => {
                    const sel = value.includes(c.authAsymId);
                    return (
                        <button
                            key={c.authAsymId}
                            type="button"
                            title={`${E.CHAIN_ROLE_LABELS[c.role]} · ${c.residueCount} res`}
                            onClick={() => onChange(sel ? value.filter((x) => x !== c.authAsymId) : [...value, c.authAsymId])}
                            className={cx('mono h-6 rounded border px-1.5 text-[11px]', sel ? on : 'border-stroke-2 text-text-2 hover:text-text-0')}
                        >
                            {c.authAsymId}
                            {c.alias ? ` ${c.alias}` : ''}
                        </button>
                    );
                })}
        </div>
    );
}

function StructureSelect({ value, onChange, structures }: { value: string; onChange: (v: string) => void; structures: E.StructureInfo[] }) {
    return (
        <Select
            value={value}
            onChange={onChange}
            options={structures.map((s, i) => ({ value: s.id, label: `#${i + 1} ${s.alias || s.name}` }))}
            className="w-full"
        />
    );
}

function sidesFromRoles(s: E.StructureInfo): { a: string[]; b: string[] } {
    const poly = s.chains.filter((c) => c.isPolymer);
    const binders = poly.filter((c) => c.role === 'binder').map((c) => c.authAsymId);
    if (binders.length) return { a: binders, b: poly.filter((c) => c.role !== 'binder').map((c) => c.authAsymId) };
    return { a: poly.slice(0, 1).map((c) => c.authAsymId), b: poly.slice(1).map((c) => c.authAsymId) };
}

const parseChains = (t: string) => t.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------------------

function JobQueue() {
    const jobs = useCompute((s) => s.jobs);
    const list = Object.values(jobs).sort((a, b) => b.created - a.created).slice(0, 40);
    if (list.length === 0) return <p className="text-[11.5px] text-text-2">Nenhum cálculo ainda.</p>;
    return (
        <div className="flex flex-col gap-1">
            {list.map((j) => {
                const running = j.state === 'running';
                const color = j.state === 'done' ? 'text-ok' : j.state === 'error' ? 'text-err' : j.state === 'canceled' ? 'text-text-2' : 'text-accent';
                const secs = j.started ? ((j.finished ?? Date.now() / 1000) - j.started).toFixed(1) : null;
                return (
                    <div key={j.id} className="rounded-md border border-stroke bg-bg-0 px-2 py-1.5">
                        <div className="flex items-center gap-1.5 text-[11.5px]">
                            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', running ? 'animate-pulse bg-accent' : j.state === 'done' ? 'bg-ok' : j.state === 'error' ? 'bg-err' : 'bg-text-2')} />
                            <span className="min-w-0 flex-1 truncate" title={j.label}>
                                {j.label}
                            </span>
                            <span className={cx('text-[10.5px]', color)}>
                                {{ queued: 'na fila', running: `${Math.round(j.progress * 100)}%`, done: 'pronto', error: 'erro', canceled: 'cancelado' }[j.state]}
                                {secs && j.state !== 'queued' ? ` · ${secs}s` : ''}
                            </span>
                            {(running || j.state === 'queued') && (
                                <button type="button" title="Cancelar" onClick={() => void cancelJob(j.id)} className="text-text-2 hover:text-err">
                                    <Icon name="close" size={12} />
                                </button>
                            )}
                            <button type="button" title="Abrir pasta do job (logs, arquivos)" onClick={() => void platform.showFolder(j.workdir)} className="text-text-2 hover:text-text-0">
                                <Icon name="open" size={12} />
                            </button>
                        </div>
                        {running && (
                            <div className="mt-1 h-1 overflow-hidden rounded bg-bg-3">
                                <div className="h-full bg-accent transition-transform duration-200" style={{ width: '100%', transform: `translateX(${(j.progress - 1) * 100}%)` }} />
                            </div>
                        )}
                        {(running || j.state === 'error') && (j.message || j.error) && (
                            <div className={cx('mt-0.5 truncate text-[10.5px]', j.state === 'error' ? 'text-err' : 'text-text-2')} title={j.error ?? j.message}>
                                {j.state === 'error' ? j.error : j.message}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function CoreStatus() {
    const caps = useCompute((s) => s.caps);
    const err = useCompute((s) => s.capsError);
    if (err) {
        return (
            <div className="rounded-md border border-err/40 bg-err/5 p-2 text-[11px] text-err">
                {err}
                <Button className="mt-1" onClick={() => void refreshCapabilities()}>
                    Tentar de novo
                </Button>
            </div>
        );
    }
    if (!caps) return <p className="text-[11.5px] text-text-2">Iniciando o núcleo de cálculo…</p>;
    const item = (ok: unknown, label: string) => (
        <span className={cx('rounded px-1.5 py-0.5 text-[10.5px]', ok ? 'bg-ok/10 text-ok' : 'bg-bg-3 text-text-2 line-through')}>{label}</span>
    );
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-1">
                {item(caps.pyrosetta, `PyRosetta ${caps.pyrosetta ?? ''}`)}
                {item(caps.pydssp, 'pydssp')}
                {item(caps.apbs && caps.pdb2pqr, 'APBS')}
                {item(caps.tmalign, 'TM-align')}
                {item(caps.mhcxgraph, `MHCXGraph ${caps.mhcxgraph ?? ''}`)}
                {item(caps.pykvfinder, `pyKVFinder ${caps.pykvfinder ?? ''}`)}
            </div>
            <div className="text-[10.5px] text-text-2">
                {caps.limits.cores} núcleos · {caps.limits.ram_gb} GB livres · até {caps.limits.rosetta} Rosetta, {caps.limits.apbs} APBS em paralelo
                {caps.torch_cuda ? ` · GPU: ${caps.torch_cuda}` : ''}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

export function AnalysisPanel() {
    const structures = useApp((s) => s.structures);
    const activeId = useApp((s) => s.activeId);
    const library = useApp((s) => s.library);
    const selected = useApp((s) => s.selectedResidues);
    const caps = useCompute((s) => s.caps);
    const [tool, setTool] = useState<ToolId>('rosetta_interface');
    const [values, setValues] = useState<Record<ToolId, Values>>(DEFAULTS);
    const [targetId, setTargetId] = useState<string>('');
    const [sideA, setSideA] = useState<string[]>([]);
    const [sideB, setSideB] = useState<string[]>([]);
    const [chains, setChains] = useState<string[]>([]);
    const [ligandChains, setLigandChains] = useState<string[]>([]);
    const [boxResidues, setBoxResidues] = useState<string[]>([]);
    const [refId, setRefId] = useState('');
    const [refChains, setRefChains] = useState<string[]>([]);
    const [mobChains, setMobChains] = useState<string[]>([]);
    const [mhcxIds, setMhcxIds] = useState<string[]>([]);
    const [mhcxSelector, setMhcxSelector] = useState({ chains: 'A, C', residues: '', helix: false, sheet: false, logic: '' });
    const [mhcxClasses, setMhcxClasses] = useState('identity');
    const [mhcxHeatmap, setMhcxHeatmap] = useState(true);
    const [mhcxRef, setMhcxRef] = useState(0);
    const [batchA, setBatchA] = useState('A');
    const [batchB, setBatchB] = useState('B, C');

    useEffect(() => initCompute(), []);

    const target = structures.find((s) => s.id === (targetId || activeId)) ?? structures[structures.length - 1] ?? null;
    const reference = structures.find((s) => s.id === refId) ?? structures.find((s) => s.id !== target?.id) ?? null;

    // Re-seed chain choices when the target structure or its roles change.
    const roleKey = target ? `${target.id}|${target.chains.map((c) => c.role).join(',')}` : '';
    useEffect(() => {
        if (!target) return;
        const d = sidesFromRoles(target);
        setSideA(d.a);
        setSideB(d.b);
        const mhcLike = target.chains.filter((c) => c.isPolymer && (c.role === 'mhc' || c.role === 'target')).map((c) => c.authAsymId);
        setChains(mhcLike.length ? mhcLike : target.chains.filter((c) => c.isPolymer).map((c) => c.authAsymId));
        setLigandChains(target.chains.filter((c) => c.role === 'peptide' || c.role === 'binder').map((c) => c.authAsymId).slice(0, 1));
        setMobChains(target.chains.filter((c) => c.isPolymer).slice(0, 1).map((c) => c.authAsymId));
    }, [roleKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (reference) setRefChains(reference.chains.filter((c) => c.isPolymer).slice(0, 1).map((c) => c.authAsymId));
    }, [reference?.id]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => setMhcxIds(structures.map((s) => s.id)), [structures.length]); // eslint-disable-line react-hooks/exhaustive-deps

    const selectionKeys = useMemo(() => {
        if (!target) return [];
        const per = selected.get(target.id);
        if (!per) return [];
        return [...per.entries()].flatMap(([c, set]) => [...set].map((k) => `${c}:${k}`));
    }, [selected, target]);

    const v = values[tool];
    const setV = (nv: Values) => setValues({ ...values, [tool]: nv });
    const available = (id: ToolId) => !caps || TOOLS.find((t) => t.id === id)!.needs.every((k) => Boolean(caps[k]));

    // -- submission ---------------------------------------------------------------

    const runOne = async () => {
        if (!target && tool !== 'mhcxgraph' && tool !== 'mhcx_renumber') return toast('Carregue uma estrutura.', 'error');
        const name = target ? target.alias || target.name : '';
        const ids = target ? [target.id] : [];
        switch (tool) {
            case 'rosetta_interface': {
                if (!sideA.length || !sideB.length) return toast('Escolha as cadeias dos dois lados.', 'error');
                const input = await inputFor(target!.id);
                if (!input) return;
                await submit(tool, { ...v, input, side_a: sideA, side_b: sideB }, `Interface ${sideA.join('')}_${sideB.join('')} · ${name}`, { structureIds: ids });
                break;
            }
            case 'rosetta_relax': {
                const input = await inputFor(target!.id);
                if (!input) return;
                const n = Math.max(1, Math.round(Number(v.nstruct)));
                const group = groupId();
                for (let k = 0; k < n; k++) {
                    const seed = 1000 + Math.floor(Math.random() * 1e6);
                    await submit(
                        tool,
                        { ...v, input, side_a: sideA, side_b: sideB, chains: v.region === 'chains' ? chains : [], seed },
                        `Relax ${k + 1}/${n} · ${name}`,
                        { structureIds: ids, group, extra: { load: v.load } },
                    );
                }
                break;
            }
            case 'dssp': {
                const input = await inputFor(target!.id);
                if (!input) return;
                await submit(tool, { ...v, input, chains: [] }, `pydssp · ${name}`, { structureIds: ids });
                break;
            }
            case 'tmalign': {
                if (!reference || reference.id === target!.id) return toast('Escolha uma referência diferente da estrutura móvel.', 'error');
                const [ri, mi] = [await inputFor(reference.id), await inputFor(target!.id)];
                if (!ri || !mi) return;
                await submit(tool, { ...v, reference: { input: ri, chains: refChains }, mobile: { input: mi, chains: mobChains } }, `TM-align · ${name} → ${reference.alias || reference.name}`, {
                    structureIds: [reference.id, target!.id],
                    extra: { apply: v.apply },
                });
                break;
            }
            case 'electrostatics': {
                const input = await inputFor(target!.id);
                if (!input) return;
                await submit(tool, { ...v, input, chains }, `Eletrostática · ${name} /${chains.join('')}`, { structureIds: ids, extra: { chains } });
                break;
            }
            case 'kvfinder': {
                const input = await inputFor(target!.id);
                if (!input) return;
                if (v.region === 'box' && boxResidues.length === 0) return toast('Use "Seleção atual" para definir a caixa.', 'error');
                if (v.region === 'ligand' && ligandChains.length === 0) return toast('Escolha a(s) cadeia(s) ligante(s).', 'error');
                await submit(tool, { ...v, input, chains, ligand_chains: ligandChains, box_residues: boxResidues }, `Cavidades · ${name}`, { structureIds: ids });
                break;
            }
            case 'mhcxgraph': {
                const chosen = structures.filter((s) => mhcxIds.includes(s.id));
                if (chosen.length < 2) return toast('Marque ao menos duas estruturas.', 'error');
                const inputs = [];
                for (const s of chosen) {
                    const p = await inputFor(s.id);
                    if (!p) return;
                    inputs.push({ input: p, name: s.alias || s.name.replace(/\.[^.]+$/, '') });
                }
                const residues: Record<string, number[]> = {};
                for (const part of mhcxSelector.residues.split(/[;\s]+/).filter(Boolean)) {
                    const m = /^([A-Za-z0-9]):(.+)$/.exec(part);
                    if (!m) continue;
                    const list: number[] = [];
                    for (const r of m[2]!.split(',')) {
                        const [a, b] = r.split('-').map(Number);
                        if (a === undefined || !Number.isFinite(a)) continue;
                        for (let x = a; x <= (b !== undefined && Number.isFinite(b) ? b : a); x++) list.push(x);
                    }
                    residues[m[1]!] = list;
                }
                const structuresSel = [mhcxSelector.helix && 'helix', mhcxSelector.sheet && 'sheet'].filter(Boolean);
                const preset = RESIDUE_CLASS_PRESETS[mhcxClasses]!;
                await submit(
                    tool,
                    {
                        structures: inputs,
                        settings: { ...v, reference_structure: v.run_mode === 'screening' ? mhcxRef : null },
                        selector: {
                            chains: parseChains(mhcxSelector.chains),
                            residues: Object.keys(residues).length ? residues : undefined,
                            structures: structuresSel.length ? structuresSel : undefined,
                            logic: mhcxSelector.logic || undefined,
                        },
                        classes: preset.classes ? { residues: preset.classes } : undefined,
                        heatmap: mhcxHeatmap,
                    },
                    `MHCXGraph · ${v.run_mode} · ${chosen.length} estruturas`,
                    { structureIds: chosen.map((s) => s.id) },
                );
                break;
            }
            case 'hydrogens': {
                const input = await inputFor(target!.id);
                if (!input) return;
                await submit(tool, { input, ph: v.ph, propka: v.propka }, `Hidrogênios · ${name}`, { structureIds: ids });
                break;
            }
            case 'mhcx_renumber': {
                const chosen = structures.filter((s) => mhcxIds.includes(s.id));
                const inputs = [];
                for (const s of chosen) {
                    const p = await inputFor(s.id);
                    if (p) inputs.push(p);
                }
                if (!inputs.length) return toast('Marque as estruturas a renumerar.', 'error');
                await submit(tool, { inputs, mhc_class: v.mhc_class, warn_score: v.warn_score, suffix: v.suffix }, `IMGT ${v.mhc_class} · ${inputs.length} arquivo(s)`, {
                    structureIds: chosen.map((s) => s.id),
                    extra: { load: v.load },
                });
                break;
            }
        }
        useCompute.setState({ dockOpen: true });
    };

    /** The same analysis over every file of the library, in parallel on the job pool. */
    const runBatch = async () => {
        if (!library.files.length) return toast('Abra uma pasta na biblioteca primeiro.', 'error');
        const group = groupId();
        const a = parseChains(batchA);
        const b = parseChains(batchB);
        for (const file of library.files) {
            const short = file.split('/').pop()!;
            const base = { file, group, structureIds: [] as E.StructureId[], extra: { batch: true } };
            if (tool === 'rosetta_interface') await submit(tool, { ...v, input: file, side_a: a, side_b: b }, short, base);
            else if (tool === 'dssp') await submit(tool, { ...v, input: file, chains: [] }, short, base);
            else if (tool === 'kvfinder') await submit(tool, { ...v, input: file, chains: [], ligand_chains: a, box_residues: [] }, short, base);
            else if (tool === 'electrostatics') await submit(tool, { ...v, input: file, chains: a }, short, base);
        }
        toast(`${library.files.length} jobs na fila.`, 'ok');
        useCompute.setState({ dockOpen: true });
    };

    const batchable = tool === 'rosetta_interface' || tool === 'dssp' || tool === 'kvfinder' || tool === 'electrostatics';
    const specs =
        tool === 'rosetta_interface' ? ROSETTA_INTERFACE_SPECS
        : tool === 'rosetta_relax' ? RELAX_SPECS
        : tool === 'dssp' ? DSSP_SPECS
        : tool === 'tmalign' ? TMALIGN_SPECS
        : tool === 'electrostatics' ? ELECTROSTATICS_SPECS
        : tool === 'hydrogens' ? HYDROGENS_SPECS
        : tool === 'kvfinder' ? KVFINDER_SPECS
        : tool === 'mhcxgraph' ? MHCX_SPECS
        : [];

    return (
        <div>
            <Section title="Núcleo de cálculo">
                <CoreStatus />
            </Section>
            <Section title="Ferramenta">
                <div className="grid grid-cols-2 gap-1">
                    {TOOLS.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            disabled={!available(t.id)}
                            onClick={() => setTool(t.id)}
                            title={available(t.id) ? t.sub : 'Indisponível neste ambiente'}
                            className={cx(
                                'flex flex-col items-start rounded-md border px-2 py-1.5 text-left transition-colors duration-100 disabled:opacity-40',
                                tool === t.id ? 'border-accent bg-accent/12' : 'border-stroke-2 bg-bg-2 hover:bg-bg-3',
                            )}
                        >
                            <span className={cx('text-[12px] font-medium', tool === t.id ? 'text-accent' : 'text-text-0')}>{t.label}</span>
                            <span className="text-[10px] leading-tight text-text-2">{t.sub}</span>
                        </button>
                    ))}
                </div>
            </Section>

            <Section title={toolLabel(tool)}>
                {/* Targets */}
                {tool !== 'mhcxgraph' && tool !== 'mhcx_renumber' && structures.length > 0 && (
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-1">{tool === 'tmalign' ? 'Estrutura móvel' : 'Estrutura'}</span>
                        <StructureSelect value={target?.id ?? ''} onChange={setTargetId} structures={structures} />
                    </div>
                )}
                {target && (tool === 'rosetta_interface' || tool === 'rosetta_relax') && (
                    <>
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-1">Lado A (binder){tool === 'rosetta_relax' ? ' · para interface e análise' : ''}</span>
                            <ChainChips s={target} value={sideA} onChange={setSideA} />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-1">Lado B (alvo)</span>
                            <ChainChips s={target} value={sideB} onChange={setSideB} tone="accent-2" />
                        </div>
                    </>
                )}
                {target && tool === 'rosetta_relax' && v.region === 'chains' && (
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-1">Cadeias móveis</span>
                        <ChainChips s={target} value={chains} onChange={setChains} tone="ok" />
                    </div>
                )}
                {target && (tool === 'electrostatics' || tool === 'kvfinder') && (
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-1">{tool === 'electrostatics' ? 'Cadeias no cálculo (o seu README usou só o MHC)' : 'Cadeias do receptor'}</span>
                        <ChainChips s={target} value={chains} onChange={setChains} tone="ok" />
                    </div>
                )}
                {target && tool === 'kvfinder' && v.region === 'ligand' && (
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-1">Cadeias usadas como ligante (saem do receptor)</span>
                        <ChainChips s={target} value={ligandChains} onChange={setLigandChains} tone="accent-2" />
                    </div>
                )}
                {target && tool === 'kvfinder' && v.region === 'box' && (
                    <div className="flex items-center gap-2">
                        <Button onClick={() => setBoxResidues(selectionKeys)} disabled={selectionKeys.length === 0}>
                            Seleção atual
                        </Button>
                        <span className="text-[11px] text-text-2">{boxResidues.length ? `${boxResidues.length} resíduos definem a caixa` : 'Selecione os resíduos do bolso (ex.: sulco)'}</span>
                    </div>
                )}
                {target && tool === 'tmalign' && (
                    <>
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-1">Cadeias da móvel</span>
                            <ChainChips s={target} value={mobChains} onChange={setMobChains} />
                        </div>
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] text-text-1">Referência (fica parada)</span>
                            <StructureSelect value={reference?.id ?? ''} onChange={setRefId} structures={structures.filter((s) => s.id !== target.id)} />
                            {reference && <ChainChips s={reference} value={refChains} onChange={setRefChains} tone="accent-2" />}
                        </div>
                    </>
                )}
                {(tool === 'mhcxgraph' || tool === 'mhcx_renumber') && (
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] text-text-1">Estruturas</span>
                        <div className="flex max-h-36 flex-col gap-0.5 overflow-y-auto rounded-md border border-stroke bg-bg-0 p-1.5">
                            {structures.map((s, i) => (
                                <label key={s.id} className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                                    <input type="checkbox" className="accent-[var(--accent)]" checked={mhcxIds.includes(s.id)} onChange={(e) => setMhcxIds(e.target.checked ? [...mhcxIds, s.id] : mhcxIds.filter((x) => x !== s.id))} />
                                    <span className="mono text-text-2">#{i + 1}</span>
                                    <span className="truncate">{s.alias || s.name}</span>
                                </label>
                            ))}
                            {structures.length === 0 && <span className="text-[11px] text-text-2">Carregue as estruturas a comparar.</span>}
                        </div>
                    </div>
                )}
                {tool === 'mhcxgraph' && (
                    <div className="flex flex-col gap-1.5 rounded-md border border-stroke p-2">
                        <span className="text-[10.5px] font-semibold tracking-wider text-text-2 uppercase">Seletor de superfície</span>
                        <label className="flex items-center justify-between gap-2 text-[11.5px] text-text-1">
                            Cadeias
                            <input value={mhcxSelector.chains} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setMhcxSelector({ ...mhcxSelector, chains: e.target.value })} className="mono h-6 w-28 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] outline-none focus:border-accent" />
                        </label>
                        <label className="flex flex-col gap-1 text-[11.5px] text-text-1">
                            Resíduos por cadeia (opcional)
                            <input placeholder="A:58-80,140-170 C:1-9" value={mhcxSelector.residues} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setMhcxSelector({ ...mhcxSelector, residues: e.target.value })} className="mono h-6 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] outline-none focus:border-accent" />
                        </label>
                        <div className="flex gap-3 text-[11.5px] text-text-1">
                            <label className="flex items-center gap-1"><input type="checkbox" className="accent-[var(--accent)]" checked={mhcxSelector.helix} onChange={(e) => setMhcxSelector({ ...mhcxSelector, helix: e.target.checked })} />hélices</label>
                            <label className="flex items-center gap-1"><input type="checkbox" className="accent-[var(--accent)]" checked={mhcxSelector.sheet} onChange={(e) => setMhcxSelector({ ...mhcxSelector, sheet: e.target.checked })} />fitas</label>
                        </div>
                        <label className="flex flex-col gap-1 text-[11.5px] text-text-1">
                            Lógica (opcional)
                            <input placeholder="(chains | residues) & exposed" value={mhcxSelector.logic} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setMhcxSelector({ ...mhcxSelector, logic: e.target.value })} className="mono h-6 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] outline-none focus:border-accent" />
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[11.5px] text-text-1">
                            Classes de resíduo
                            <Select value={mhcxClasses} onChange={setMhcxClasses} options={Object.entries(RESIDUE_CLASS_PRESETS).map(([value, p]) => ({ value, label: p.label }))} className="h-6 text-[11px]" />
                        </label>
                        {v.run_mode === 'screening' && (
                            <label className="flex items-center justify-between gap-2 text-[11.5px] text-text-1">
                                Referência
                                <Select
                                    value={String(mhcxRef)}
                                    onChange={(x) => setMhcxRef(Number(x))}
                                    options={structures.filter((s) => mhcxIds.includes(s.id)).map((s, i) => ({ value: String(i), label: s.alias || s.name }))}
                                    className="h-6 text-[11px]"
                                />
                            </label>
                        )}
                        {v.run_mode !== 'multiple' && (
                            <label className="flex items-center gap-2 text-[11.5px] text-text-1">
                                <input type="checkbox" className="accent-[var(--accent)]" checked={mhcxHeatmap} onChange={(e) => setMhcxHeatmap(e.target.checked)} />
                                Heatmap de componentes entre pares
                            </label>
                        )}
                    </div>
                )}
                {tool === 'mhcx_renumber' && (
                    <div className="flex flex-col gap-1.5">
                        <label className="flex items-center justify-between text-[11.5px] text-text-1">
                            Classe
                            <Select value={String(v.mhc_class)} onChange={(x) => setV({ ...v, mhc_class: x })} options={[{ value: 'MHCI', label: 'MHC classe I' }, { value: 'MHCII', label: 'MHC classe II' }]} className="h-6 text-[11px]" />
                        </label>
                        <ParamForm
                            specs={[
                                { key: 'warn_score', label: 'Avisar se o score do alinhamento <', type: 'number', min: 0, step: 1 },
                                { key: 'suffix', label: 'Sufixo dos arquivos', type: 'text' },
                                { key: 'load', label: 'Abrir os renumerados', type: 'bool' },
                            ]}
                            values={v}
                            onChange={setV}
                        />
                    </div>
                )}

                {specs.length > 0 && <ParamForm specs={specs} values={v} onChange={setV} />}

                <div className="mt-1 flex flex-col gap-1.5">
                    <Button variant="primary" icon="spin" onClick={() => void runOne()}>
                        {tool === 'rosetta_relax' && Number(v.nstruct) > 1 ? `Rodar ${v.nstruct} modelos em paralelo` : 'Rodar'}
                    </Button>
                    {tool === 'dssp' && structures.length > 0 && (
                        <Button
                            title="Hélice, fita e alça dos resíduos da interface, comparando as estruturas carregadas (usa o pydssp onde já rodou, e o DSSP do Mol* nas demais)"
                            onClick={() =>
                                addResult({ id: 'interface-ss', tool: 'dssp', label: 'Estrutura secundária da interface', created: Date.now(), structureIds: [], data: null, meta: { tool: 'dssp', structureIds: [] }, jobIds: [] })
                            }
                        >
                            Estrutura secundária da interface
                        </Button>
                    )}
                    {batchable && library.files.length > 0 && (
                        <div className="flex flex-col gap-1.5 rounded-md border border-stroke p-2">
                            <span className="text-[11px] text-text-1">Lote · {library.files.length} arquivos da biblioteca</span>
                            {(tool === 'rosetta_interface' || tool === 'kvfinder' || tool === 'electrostatics') && (
                                <div className="grid grid-cols-2 gap-1.5">
                                    <label className="flex flex-col gap-0.5 text-[10.5px] text-text-2">
                                        {tool === 'rosetta_interface' ? 'Lado A' : tool === 'kvfinder' ? 'Ligante' : 'Cadeias'}
                                        <input value={batchA} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setBatchA(e.target.value)} className="mono h-6 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] text-text-0 outline-none" />
                                    </label>
                                    {tool === 'rosetta_interface' && (
                                        <label className="flex flex-col gap-0.5 text-[10.5px] text-text-2">
                                            Lado B
                                            <input value={batchB} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setBatchB(e.target.value)} className="mono h-6 rounded border border-stroke-2 bg-bg-1 px-1.5 text-[11.5px] text-text-0 outline-none" />
                                        </label>
                                    )}
                                </div>
                            )}
                            <Button onClick={() => void runBatch()}>Rodar em todos (paralelo)</Button>
                        </div>
                    )}
                </div>
            </Section>

            <Section title="Fila">
                <JobQueue />
            </Section>
        </div>
    );
}
