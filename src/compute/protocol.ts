/**
 * The interface protocol: FastRelax then InterfaceAnalyzer, on one or many loaded
 * structures.
 *
 * This is the recipe a binder designer runs over and over, so it is one button
 * rather than two jobs wired by hand: relax the complex (5 repeats by default),
 * then measure the interface of the *relaxed* model, which is the number worth
 * comparing between designs.
 *
 * Results are cached per structure and protocol signature — asking again for a
 * complex already relaxed with the same settings returns what is on disk instead of
 * spending another minute of Rosetta.
 */

import { create } from 'zustand';
import * as E from '@/engine';
import { toast, viewer } from '@/store/app';
import { inputFor, submit, useCompute, type ResultEntry } from './store';
import { RELAX_DEFAULTS, ROSETTA_INTERFACE_DEFAULTS, type RelaxResult, type RosettaInterfaceResult } from './types';

export interface ProtocolOptions {
    /** FastRelax repeats — "relax 5×". */
    repeats: number;
    /** Independent models; the best scoring one is kept. */
    nstruct: number;
    /** 'all' | 'interface' | 'chains' (engine-side naming of the relax region). */
    region: string;
    scorefxn: string;
    sideA: string[];
    sideB: string[];
    /** Skip the relax and measure the structure as it is. */
    skipRelax: boolean;
}

export const PROTOCOL_DEFAULTS: ProtocolOptions = {
    repeats: 5,
    nstruct: 1,
    region: 'interface',
    scorefxn: 'ref2015',
    sideA: [],
    sideB: [],
    skipRelax: false,
};

export type Stage = 'queued' | 'relaxing' | 'analyzing' | 'done' | 'error' | 'cached';

export interface RunState {
    structureId: E.StructureId;
    name: string;
    stage: Stage;
    /** 0–1 within the current stage, when the job reports it. */
    progress: number;
    message: string;
    relax: RelaxResult | null;
    analysis: RosettaInterfaceResult | null;
    error: string | null;
    seconds: number;
}

interface ProtocolState {
    runs: Record<string, RunState>;
    running: boolean;
}

export const useProtocol = create<ProtocolState>(() => ({ runs: {}, running: false }));

/** What makes two runs comparable; a change here invalidates the cache. */
function signature(o: ProtocolOptions): string {
    return JSON.stringify([o.repeats, o.nstruct, o.region, o.scorefxn, o.sideA, o.sideB, o.skipRelax]);
}

const cache = new Map<string, { relax: RelaxResult | null; analysis: RosettaInterfaceResult }>();

const cacheKey = (id: E.StructureId, o: ProtocolOptions) => `${id}|${signature(o)}`;

export function cachedRun(id: E.StructureId, o: ProtocolOptions): { relax: RelaxResult | null; analysis: RosettaInterfaceResult } | undefined {
    return cache.get(cacheKey(id, o));
}

export function clearProtocolCache(): void {
    cache.clear();
}

function patch(id: string, p: Partial<RunState>): void {
    useProtocol.setState((s) => ({ runs: { ...s.runs, [id]: { ...s.runs[id]!, ...p } } }));
}

/** A job that stops reporting must not hold the panel open forever. */
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

/** Resolves when a job finishes, with its result or an error. */
function awaitJob(jobId: string, onProgress: (progress: number, message: string) => void): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (r: { ok: true; value: unknown } | { ok: false; error: string }) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            unsubscribe();
            resolve(r);
        };
        const timer = window.setTimeout(() => {
            const job = useCompute.getState().jobs[jobId];
            finish({ ok: false, error: `O job não respondeu em ${JOB_TIMEOUT_MS / 60000} min (estado: ${job?.state ?? 'desconhecido'}).` });
        }, JOB_TIMEOUT_MS);
        const unsubscribe = useCompute.subscribe((state) => {
            const job = state.jobs[jobId];
            if (!job) return;
            onProgress(job.progress ?? 0, job.message ?? '');
            if (job.state === 'done') finish({ ok: true, value: job.result });
            else if (job.state === 'error' || job.state === 'canceled') finish({ ok: false, error: job.error ?? 'Cancelado.' });
        });
        // The job may already be finished by the time we subscribe.
        const now = useCompute.getState().jobs[jobId];
        if (now && (now.state === 'done' || now.state === 'error')) {
            finish(now.state === 'done' ? { ok: true, value: now.result } : { ok: false, error: now.error ?? 'Erro.' });
        }
    });
}

/**
 * The chains to use in one structure. Designs from the same campaign usually share
 * the chain letters, but not always — when the asked-for letters are not in this
 * file, the sides are rebuilt from the chain roles, and the run says so.
 */
function resolveChains(info: E.StructureInfo | undefined, options: ProtocolOptions): { sideA: string[]; sideB: string[]; note: string } {
    if (!info) return { sideA: options.sideA, sideB: options.sideB, note: '' };
    const present = new Set(info.chains.filter((c) => c.isPolymer).map((c) => c.authAsymId));
    const asked = [...options.sideA, ...options.sideB];
    if (asked.every((c) => present.has(c))) return { sideA: options.sideA, sideB: options.sideB, note: '' };

    const polymer = info.chains.filter((c) => c.isPolymer);
    const binders = polymer.filter((c) => c.role === 'binder').map((c) => c.authAsymId);
    const others = polymer.filter((c) => c.role !== 'binder').map((c) => c.authAsymId);
    if (binders.length && others.length) return { sideA: binders, sideB: others, note: 'cadeias pelos papéis (as letras pedidas não existem aqui)' };
    if (polymer.length >= 2) return { sideA: [polymer[0]!.authAsymId], sideB: polymer.slice(1).map((c) => c.authAsymId), note: 'cadeias pela ordem do arquivo' };
    return { sideA: options.sideA, sideB: options.sideB, note: '' };
}

async function runOne(id: E.StructureId, name: string, baseOptions: ProtocolOptions, info?: E.StructureInfo): Promise<void> {
    const resolved = resolveChains(info, baseOptions);
    const options = { ...baseOptions, sideA: resolved.sideA, sideB: resolved.sideB };
    if (resolved.note) patch(id, { message: resolved.note });
    const hit = cache.get(cacheKey(id, options));
    if (hit) {
        patch(id, { stage: 'cached', progress: 1, relax: hit.relax, analysis: hit.analysis, message: 'já calculado com este protocolo' });
        return;
    }
    const started = performance.now();
    const input = await inputFor(id);
    if (!input) {
        patch(id, { stage: 'error', error: 'Não foi possível preparar o arquivo da estrutura.' });
        return;
    }

    let analysisInput = input;
    let relax: RelaxResult | null = null;

    if (!options.skipRelax) {
        patch(id, { stage: 'relaxing', progress: 0, message: `FastRelax ${options.repeats}×` });
        const jobId = await submit(
            'rosetta_relax',
            {
                ...RELAX_DEFAULTS,
                input,
                side_a: options.sideA,
                side_b: options.sideB,
                repeats: options.repeats,
                nstruct: options.nstruct,
                region: options.region,
                scorefxn: options.scorefxn,
                analyze_interface: true,
            },
            `Relax · ${name}`,
            { structureIds: [id], extra: { protocol: true } },
        );
        if (!jobId) {
            patch(id, { stage: 'error', error: 'O servidor de cálculo não aceitou o job.' });
            return;
        }
        const r = await awaitJob(jobId, (progress, message) => patch(id, { progress, message: message || `FastRelax ${options.repeats}×` }));
        if (!r.ok) {
            patch(id, { stage: 'error', error: r.error });
            return;
        }
        relax = r.value as RelaxResult;
        analysisInput = relax.relaxed_path || input;
    }

    patch(id, { stage: 'analyzing', progress: 0, message: 'InterfaceAnalyzer', relax });
    const jobId = await submit(
        'rosetta_interface',
        { ...ROSETTA_INTERFACE_DEFAULTS, input: analysisInput, side_a: options.sideA, side_b: options.sideB, scorefxn: options.scorefxn },
        `Interface · ${name}`,
        { structureIds: [id], extra: { protocol: true } },
    );
    if (!jobId) {
        patch(id, { stage: 'error', error: 'O servidor de cálculo não aceitou o job.' });
        return;
    }
    const r = await awaitJob(jobId, (progress, message) => patch(id, { progress, message: message || 'InterfaceAnalyzer' }));
    if (!r.ok) {
        patch(id, { stage: 'error', error: r.error });
        return;
    }
    const analysis = r.value as RosettaInterfaceResult;
    cache.set(cacheKey(id, options), { relax, analysis });
    patch(id, { stage: 'done', progress: 1, analysis, seconds: (performance.now() - started) / 1000, message: resolved.note });
}

/**
 * Runs the protocol on the given structures, one Rosetta job at a time per structure
 * but all structures in parallel — the scheduler in ppcore caps how many actually run.
 */
export async function runInterfaceProtocol(ids: E.StructureId[], options: ProtocolOptions): Promise<void> {
    const v = viewer();
    if (!v) return;
    if (ids.length === 0) return;
    const infos = v.infos();
    useProtocol.setState({
        running: true,
        runs: Object.fromEntries(
            ids.map((id) => [
                id,
                { structureId: id, name: infos.find((s) => s.id === id)?.alias || infos.find((s) => s.id === id)?.name || '—', stage: 'queued', progress: 0, message: '', relax: null, analysis: null, error: null, seconds: 0 } as RunState,
            ]),
        ),
    });
    try {
        await Promise.all(ids.map((id) => runOne(id, useProtocol.getState().runs[id]?.name ?? '—', options, infos.find((s) => s.id === id))));
        const runs = useProtocol.getState().runs;
        const failed = Object.values(runs).filter((r) => r.stage === 'error');
        if (failed.length) toast(`${failed.length} de ${ids.length} falharam: ${failed[0]!.error}`, 'error');
        else toast(`Protocolo concluído em ${ids.length} estrutura${ids.length > 1 ? 's' : ''}.`, 'ok');
    } finally {
        useProtocol.setState({ running: false });
    }
}

/** The dock entry a finished run corresponds to, for "abrir no painel de resultados". */
export function resultOf(run: RunState): ResultEntry | undefined {
    return useCompute.getState().results.find((r) => r.meta.structureIds?.includes(run.structureId) && r.tool === 'rosetta_interface');
}
