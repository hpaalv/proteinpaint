/**
 * Adding hydrogens (PDB2PQR + PROPKA in ppcore/tools/hydrogens.py).
 *
 * The protonated copy *replaces* the structure, as ChimeraX's addh does: the user
 * asked for hydrogens on what is on screen, not for a second model. Names, chain
 * roles and colours carry over so nothing else on screen changes.
 */

import * as E from '@/engine';
import { asBytes, platform, type CoreJob } from '@/platform/bridge';
import { run, toast, useApp, viewer } from '@/store/app';
import { closeStructure } from '@/store/actions';
import { inputFor, submit, type JobMeta } from './store';
import type { HydrogensResult } from './types';

export async function addHydrogens(id: E.StructureId, ph = 7): Promise<void> {
    const s = useApp.getState().structures.find((x) => x.id === id);
    if (!s) return;
    const input = await inputFor(id);
    if (!input) return;
    const job = await submit('hydrogens', { input, ph, propka: true }, `Hidrogênios · ${s.alias || s.name}`, { structureIds: [id] });
    if (job) toast(`Adicionando hidrogênios a ${s.alias || s.name} (pH ${ph}, PROPKA)…`, 'info', 2500);
}

export async function applyHydrogens(job: CoreJob, meta: JobMeta): Promise<void> {
    const v = viewer();
    const r = job.result as HydrogensResult;
    const oldId = meta.structureIds[0]!;
    const old = v?.entry(oldId);
    if (!v || !old) return;
    const [file] = await platform.readFiles([r.output]);
    if (!file?.ok || !file.bytes) return toast(`Não foi possível ler ${r.output}`, 'error');
    const info = await run(E.loadBytes(v, asBytes(file.bytes), { name: `${old.info.name} +H`, source: 'file', path: r.output }));
    if (!info) return;
    E.renameStructure(v, info.id, old.info.alias ? `${old.info.alias} +H` : '');
    for (const c of old.info.chains) {
        if (!info.chains.some((x) => x.authAsymId === c.authAsymId)) continue;
        if (c.alias) E.renameChain(v, info.id, c.authAsymId, c.alias);
        await E.setChainRole(v, info.id, c.authAsymId, c.role);
    }
    for (const [chain, color] of Object.entries(old.chainColors)) await E.setChainColor(v, info.id, chain, color);
    await E.setColorSettings(v, info.id, { ...old.color, dataset: null, scheme: old.color.scheme === 'data' ? 'chain' : old.color.scheme });
    await closeStructure(oldId);
    useApp.setState({ activeId: info.id });
    const extra = [r.ligands_kept.length ? `${r.ligands_kept.length} ligante(s) mantido(s)` : '', r.residues_dropped.length ? `${r.residues_dropped.length} resíduo(s) não reconhecido(s) ficaram de fora` : '']
        .filter(Boolean)
        .join(' · ');
    toast(`${r.hydrogens} hidrogênios adicionados (pH ${r.ph}${r.propka ? ', PROPKA' : ''}).${extra ? ` ${extra}.` : ''}`, r.residues_dropped.length ? 'info' : 'ok', 6000);
}
