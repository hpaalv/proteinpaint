/**
 * What happens in the scene when a job finishes. One handler per tool.
 */

import { applyHydrogens, inheritLook } from './hydrogens';
import * as E from '@/engine';
import { hexToInt } from '@/data/palettes';
import { asBytes, platform, type CoreJob } from '@/platform/bridge';
import { run, toast, useApp, viewer } from '@/store/app';
import { addResult, metaByJob, setJobHandler, updateResult, useCompute, type JobMeta, type ResultEntry } from './store';
import type {
    DsspResult,
    ElectrostaticsResult,
    KvfinderResult,
    MhcxResult,
    RelaxResult,
    RenumberResult,
    RosettaInterfaceResult,
    TmalignResult,
} from './types';

// ---------------------------------------------------------------------------
// Rosetta interface: datasets and overlays
// ---------------------------------------------------------------------------

const HBOND_COLOR = 0x3fc7f5;
const UNSAT_INTERFACE = 0xff3b3b;
const UNSAT_PREEXISTING = 0xffb454;

/**
 * Residues that actually take part. The InterfaceAnalyzer reports every residue of
 * the pose, and the ones away from the interface are exactly zero; keeping them would
 * make the colour range (and the chart) be about a cloud of zeros, leaving the
 * interface itself a pale smear. Dropped residues fall back to the neutral colour,
 * which reads as "not at the interface".
 */
function nonZero(values: Record<string, number> | undefined): Record<string, number> | null {
    if (!values) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(values)) if (Number.isFinite(v) && Math.abs(v) > 1e-6) out[k] = v;
    return Object.keys(out).length ? out : null;
}

export function rosettaDatasets(r: RosettaInterfaceResult): E.ResidueDataset[] {
    const src = `Rosetta · ${r.scorefxn}`;
    const out: E.ResidueDataset[] = [];
    const dG = nonZero(r.per_residue.dG);
    const dSASA = nonZero(r.per_residue.dSASA);
    const energy = r.per_residue.total_energy;
    if (dG) out.push({ id: 'rosetta:dG', label: 'ΔG por resíduo (interface)', source: src, kind: 'continuous', values: dG, ramp: 'blue-white-red', unit: 'REU' });
    if (dSASA) out.push({ id: 'rosetta:dSASA', label: 'ΔSASA por resíduo', source: src, kind: 'continuous', values: dSASA, ramp: 'white-blue', domain: null, unit: 'Å²' });
    if (energy) out.push({ id: 'rosetta:energy', label: 'Energia total por resíduo', source: src, kind: 'continuous', values: energy, ramp: 'blue-white-red', unit: 'REU' });
    if (r.alanine_scan.length) {
        const values: Record<string, number> = {};
        for (const a of r.alanine_scan) values[a.key] = a.ddG;
        out.push({ id: 'rosetta:ddG', label: 'ΔΔG alanine scan', source: src, kind: 'continuous', values, ramp: 'white-red', domain: [0, Math.max(2, ...r.alanine_scan.map((a) => a.ddG))], unit: 'REU' });
    }
    return out;
}

export interface RosettaOverlayOptions {
    hbonds: boolean;
    unsats: boolean;
    preexisting: boolean;
}

/** H-bonds as dashed cylinders, thicker for stronger bonds; unsatisfied polars as spheres. */
export async function drawRosettaOverlays(id: E.StructureId, r: RosettaInterfaceResult, o: RosettaOverlayOptions): Promise<void> {
    const v = viewer();
    if (!v) return;
    const specs: E.AtomSpec[] = [];
    for (const h of r.hbonds) {
        specs.push({ residue: h.donor.key, atom: h.donor.atom }, { residue: h.acceptor.key, atom: h.acceptor.atom });
    }
    for (const u of r.unsats) specs.push({ residue: u.key, atom: u.atom });
    const pos = E.atomPositions(v, id, specs);
    const at = (residue: string, atom: string) => pos.get(`${residue}|${atom}`);

    const lines: E.OverlayLine[] = [];
    if (o.hbonds) {
        for (const h of r.hbonds) {
            const a = at(h.donor.key, h.donor.atom);
            const b = at(h.acceptor.key, h.acceptor.atom);
            if (!a || !b) continue;
            const strength = Math.min(1, Math.abs(h.energy) / 2);
            lines.push({
                a,
                b,
                color: HBOND_COLOR,
                radius: 0.05 + 0.1 * strength,
                dashes: 6,
                label: `${h.donor.key} ${h.donor.name} ${h.donor.atom} → ${h.acceptor.key} ${h.acceptor.name} ${h.acceptor.atom} · ${h.energy.toFixed(2)} REU · ${h.distance_DA.toFixed(2)} Å`,
            });
        }
    }
    await E.setOverlay(v, 'rosetta-hbonds', { lines, owners: [id] }, 'H-bonds Rosetta');

    const spheres: E.OverlaySphere[] = [];
    if (o.unsats) {
        for (const u of r.unsats) {
            if (u.origin === 'preexisting' && !o.preexisting) continue;
            const p = at(u.key, u.atom);
            if (!p) continue;
            spheres.push({
                at: p,
                color: u.origin === 'interface' ? UNSAT_INTERFACE : UNSAT_PREEXISTING,
                radius: 0.55,
                label: `Insatisfeito ${u.kind} · ${u.key} ${u.name} ${u.atom} · SASA ${u.sasa_complex.toFixed(1)} → ${u.sasa_separated.toFixed(1)} Å²`,
            });
        }
    }
    await E.setOverlay(v, 'rosetta-unsats', { spheres, alpha: 0.85, owners: [id] }, 'Polares insatisfeitos');
}

// ---------------------------------------------------------------------------
// Loading files produced by jobs
// ---------------------------------------------------------------------------

async function loadFile(path: string, name: string): Promise<E.StructureId | null> {
    const v = viewer();
    if (!v) return null;
    const [r] = await platform.readFiles([path]);
    if (!r?.ok || !r.bytes) {
        toast(`Não foi possível ler ${path}`, 'error');
        return null;
    }
    const info = await run(E.loadBytes(v, asBytes(r.bytes), { name, source: 'file', path }));
    return info?.id ?? null;
}

/**
 * Opens a relaxed model in place of its input: same chain names, roles and colours,
 * and the input hidden — two overlapping copies made it unclear which one was on screen.
 */
export async function openRelaxed(originalId: E.StructureId, r: RelaxResult): Promise<E.StructureId | null> {
    const v = viewer();
    const sid = await loadFile(r.relaxed_path, `${nameOf(originalId)} · relax s${r.seed} (${r.score_after.toFixed(0)})`);
    if (!v || !sid || !v.entry(originalId)) return sid;
    await inheritLook(originalId, sid);
    E.setVisible(v, originalId, false);
    return sid;
}

function nameOf(id: E.StructureId): string {
    const s = useApp.getState().structures.find((x) => x.id === id);
    return s ? s.alias || s.name : '?';
}

function entry(job: CoreJob, meta: JobMeta, data: unknown, label: string): ResultEntry {
    return { id: job.id, tool: meta.tool, label, created: Date.now(), structureIds: meta.structureIds, data, meta, jobIds: [job.id], workdir: job.workdir };
}

// ---------------------------------------------------------------------------
// Groups (nstruct relax, library batches)
// ---------------------------------------------------------------------------

function groupJobs(group: string): CoreJob[] {
    return Object.values(useCompute.getState().jobs).filter((j) => j.group === group);
}

function groupDone(group: string): boolean {
    return groupJobs(group).every((j) => j.state === 'done' || j.state === 'error' || j.state === 'canceled');
}

/** Batch over a library: one result entry per group, rows filled in as jobs finish. */
function upsertBatch(job: CoreJob, meta: JobMeta): void {
    const group = meta.group!;
    const jobs = groupJobs(group);
    const rows = jobs.map((j) => ({ file: metaByJob.get(j.id)?.file ?? j.label, state: j.state, error: j.error, result: j.result }));
    const id = `batch:${group}`;
    const existing = useCompute.getState().results.find((r) => r.id === id);
    const label = `${toolLabel(meta.tool)} · lote (${jobs.filter((j) => j.state === 'done').length}/${jobs.length})`;
    if (existing) updateResult(id, { data: rows, label, jobIds: jobs.map((j) => j.id) });
    else addResult({ id, tool: meta.tool, label, created: Date.now(), structureIds: [], data: rows, meta: { ...meta, extra: { ...(meta.extra ?? {}), batch: true } }, jobIds: jobs.map((j) => j.id) });
    void job;
}

export function toolLabel(tool: string): string {
    return (
        {
            rosetta_interface: 'Interface Rosetta',
            rosetta_relax: 'FastRelax',
            dssp: 'pydssp',
            tmalign: 'TM-align',
            electrostatics: 'Eletrostática',
            kvfinder: 'Cavidades (KVFinder)',
            mhcxgraph: 'MHCXGraph',
            mhcx_renumber: 'Renumeração IMGT',
            hydrogens: 'Hidrogênios',
        } as Record<string, string>
    )[tool] ?? tool;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

async function handle(job: CoreJob, meta: JobMeta): Promise<void> {
    const v = viewer();
    if (!v) return;
    if (meta.extra?.batch) {
        upsertBatch(job, meta);
        return;
    }
    if (job.state !== 'done' && !(meta.tool === 'rosetta_relax' && meta.group)) return;
    const id = meta.structureIds[0]!;

    switch (meta.tool) {
        case 'rosetta_interface': {
            const r = job.result as RosettaInterfaceResult;
            for (const d of rosettaDatasets(r)) E.setDataset(v, id, d);
            await drawRosettaOverlays(id, r, { hbonds: true, unsats: true, preexisting: false });
            addResult({ ...entry(job, meta, r, `Interface ${r.interface} · ${nameOf(id)}`), meta: { ...meta, extra: { ...meta.extra, overlays: { hbonds: true, unsats: true, preexisting: false } } } });
            toast(`Interface ${r.interface}: ΔG ${r.metrics.dG_separated?.toFixed(1)} REU · ${r.hbonds.length} H-bonds · ${r.unsats.length} insatisfeitos`, 'ok');
            break;
        }
        case 'rosetta_relax': {
            const group = meta.group;
            if (!group || !groupDone(group)) return;
            const runs = groupJobs(group)
                .filter((j) => j.state === 'done')
                .map((j) => ({ job: j.id, result: j.result as RelaxResult }));
            if (runs.length === 0) return;
            runs.sort((a, b) => a.result.score_after - b.result.score_after);
            const load = (meta.extra?.load as string) ?? 'best';
            const toLoad = load === 'all' ? runs : load === 'none' ? [] : runs.slice(0, 1);
            const base = nameOf(id);
            const loaded: Record<string, E.StructureId> = {};
            for (const r of toLoad) {
                const sid = await openRelaxed(id, r.result);
                if (sid) loaded[r.job] = sid;
            }
            const best = toLoad[0] && loaded[toLoad[0].job];
            if (best) {
                useApp.setState({ activeId: best });
                toast(`Na tela: o modelo relaxado (seed ${toLoad[0]!.result.seed}). O original foi ocultado; o olho na lista de estruturas o mostra de novo.`, 'ok', 7000);
            }
            addResult({
                id: `relax:${group}`,
                tool: 'rosetta_relax',
                label: `FastRelax · ${base} · ${runs.length} modelo(s)`,
                created: Date.now(),
                structureIds: meta.structureIds,
                data: { runs, loaded },
                meta,
                jobIds: groupJobs(group).map((j) => j.id),
            });
            break;
        }
        case 'dssp': {
            const r = job.result as DsspResult;
            E.setDataset(v, id, {
                id: 'pydssp',
                label: 'Estrutura secundária (pydssp)',
                source: `pydssp · ${r.device}`,
                kind: 'categorical',
                values: r.ss,
                colors: { H: hexToInt('#E8607A'), E: hexToInt('#F3C04F'), '-': hexToInt('#C9CED6') },
            });
            addResult(entry(job, meta, r, `pydssp · ${nameOf(id)}`));
            break;
        }
        case 'tmalign': {
            const r = job.result as TmalignResult;
            const [refId, mobId] = meta.structureIds as [E.StructureId, E.StructureId];
            if (meta.extra?.apply !== false) await run(E.applyRigidTransform(v, mobId, refId, r.rotation, r.translation));
            addResult(entry(job, meta, r, `TM-align · ${nameOf(mobId)} → ${nameOf(refId)}`));
            break;
        }
        case 'electrostatics': {
            const r = job.result as ElectrostaticsResult;
            useApp.setState({ busy: 'Carregando mapa de potencial' });
            try {
                const dx = await platform.readText(r.dx_path);
                await run(E.showPotential(v, id, dx, (meta.extra?.chains as string[]) ?? [], { ...E.DEFAULT_POTENTIAL_STYLE }));
            } finally {
                useApp.setState({ busy: null });
            }
            addResult(entry(job, meta, r, `Eletrostática · ${nameOf(id)}`));
            break;
        }
        case 'kvfinder': {
            const r = job.result as KvfinderResult;
            let setId: string | null = null;
            if (r.points_path && r.cavities.length) {
                const text = await platform.readText(r.points_path);
                const style = { ...E.DEFAULT_CAVITY_STYLE, depthMax: Math.max(1, ...r.cavities.map((c) => c.max_depth ?? 0)) };
                if (r.hydropathy_range) style.hydropathyRange = r.hydropathy_range;
                setId = await run(E.showCavities(v, id, text, r.cavities.map((c) => c.tag), `Cavidades · ${nameOf(id)}`, style));
            }
            addResult({ ...entry(job, meta, r, `Cavidades · ${nameOf(id)} (${r.n})`), meta: { ...meta, extra: { ...meta.extra, setId } } });
            if (r.n === 0) toast('Nenhuma cavidade com esses parâmetros.', 'info');
            break;
        }
        case 'mhcxgraph': {
            const r = job.result as MhcxResult;
            addResult(entry(job, meta, r, `MHCXGraph · ${r.mode} · ${r.proteins.length} estruturas`));
            break;
        }
        case 'hydrogens':
            await applyHydrogens(job, meta);
            break;
        case 'mhcx_renumber': {
            const r = job.result as RenumberResult;
            if (meta.extra?.load) {
                for (const x of r.results) if (x.ok && x.output) await loadFile(x.output, x.output.split('/').pop()!);
            }
            addResult(entry(job, meta, r, `IMGT ${r.mhc_class} · ${r.results.length} arquivo(s)`));
            break;
        }
    }
}

setJobHandler(handle);
