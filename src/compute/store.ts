/**
 * Compute state: the job list mirrored from ppcore, the results the dock shows, and
 * submission. Results are applied to the scene by apply.ts when a job finishes.
 */

import { create } from 'zustand';
import * as E from '@/engine';
import { platform, type CoreJob } from '@/platform/bridge';
import { toast, viewer } from '@/store/app';
import type { ToolId } from './types';

export interface Capabilities {
    pyrosetta: string | null;
    pydssp: string | null;
    torch_cuda: string | null;
    apbs: string | null;
    pdb2pqr: string | null;
    tmalign: string | null;
    usalign: string | null;
    mhcxgraph: string | null;
    pykvfinder: string | null;
    limits: { rosetta: number; apbs: number; cpu: number; light: number; gpu: number; threads: number; cores: number; ram_gb: number };
    jobs_dir: string;
}

/** What the renderer remembers about a job beyond what the core knows. */
export interface JobMeta {
    tool: ToolId;
    /** Structures the result attaches to, in the order the tool sees them. */
    structureIds: E.StructureId[];
    /** Batch / nstruct group id. */
    group?: string;
    /** Library file path for batch jobs. */
    file?: string;
    extra?: Record<string, unknown>;
}

export interface ResultEntry {
    id: string;
    tool: ToolId;
    label: string;
    created: number;
    structureIds: E.StructureId[];
    /** Tool result, or for groups the list of member results. */
    data: unknown;
    meta: JobMeta;
    jobIds: string[];
    workdir?: string;
}

export interface ComputeState {
    caps: Capabilities | null;
    capsError: string | null;
    jobs: Record<string, CoreJob>;
    results: ResultEntry[];
    activeResult: string | null;
    dockOpen: boolean;
    dockHeight: number;
}

export const useCompute = create<ComputeState>(() => ({
    caps: null,
    capsError: null,
    jobs: {},
    results: [],
    activeResult: null,
    dockOpen: false,
    dockHeight: 340,
}));

export const metaByJob = new Map<string, JobMeta>();

type JobHandler = (job: CoreJob, meta: JobMeta) => void | Promise<void>;
let handler: JobHandler = () => {};

export function setJobHandler(h: JobHandler): void {
    handler = h;
}

let started = false;

/** Subscribes to job events and loads capabilities (starts the core lazily). */
export function initCompute(): void {
    if (started) return;
    started = true;
    platform.onJob((job) => {
        const prev = useCompute.getState().jobs[job.id];
        useCompute.setState((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
        const finished = job.state === 'done' || job.state === 'error' || job.state === 'canceled';
        const wasFinished = prev && (prev.state === 'done' || prev.state === 'error' || prev.state === 'canceled');
        if (finished && !wasFinished) {
            const meta = metaByJob.get(job.id);
            if (job.state === 'error') toast(`${job.label}: ${job.error ?? 'falhou'}`, 'error');
            if (meta) void Promise.resolve(handler(job, meta)).catch((e) => toast(`${job.label}: ${String(e)}`, 'error'));
        }
    });
    platform.onCoreDown((e) => {
        if (e) useCompute.setState({ capsError: e });
    });
    void refreshCapabilities();
}

export async function refreshCapabilities(): Promise<void> {
    const r = await platform.core<Capabilities>('capabilities');
    if (r.ok) useCompute.setState({ caps: r.value, capsError: null });
    else useCompute.setState({ capsError: r.error });
}

/** A path the Python tools can read for a loaded structure. */
export async function inputFor(id: E.StructureId): Promise<string | null> {
    const v = viewer();
    if (!v) return null;
    const r = E.computeInput(v, id);
    if (!r.ok) {
        toast(r.error, 'error');
        return null;
    }
    if (r.value.kind === 'path') return r.value.path;
    return platform.writeTemp(r.value.name, r.value.text);
}

export async function submit(tool: ToolId, params: Record<string, unknown>, label: string, meta: Omit<JobMeta, 'tool'>): Promise<string | null> {
    const r = await platform.core<{ jobId: string }>('submit', { tool, params, label, group: meta.group ?? null });
    if (!r.ok) {
        toast(r.error, 'error');
        return null;
    }
    metaByJob.set(r.value.jobId, { ...meta, tool });
    return r.value.jobId;
}

export async function cancelJob(id: string): Promise<void> {
    const r = await platform.core('cancel', { jobId: id });
    if (!r.ok) toast(r.error, 'error');
}

export function addResult(entry: ResultEntry): void {
    useCompute.setState((s) => ({
        results: [entry, ...s.results.filter((r) => r.id !== entry.id)],
        activeResult: entry.id,
        dockOpen: true,
    }));
}

export function updateResult(id: string, patch: Partial<ResultEntry>): void {
    useCompute.setState((s) => ({ results: s.results.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
}

export function closeResult(id: string): void {
    useCompute.setState((s) => {
        const results = s.results.filter((r) => r.id !== id);
        return { results, activeResult: s.activeResult === id ? (results[0]?.id ?? null) : s.activeResult };
    });
}

export function groupId(): string {
    return Math.random().toString(36).slice(2, 10);
}
