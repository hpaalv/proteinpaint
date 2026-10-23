/**
 * Structure loading.
 *
 * Format is detected from content, not extension: RFdiffusion and ColabFold outputs
 * routinely arrive with the wrong one. Files from disk reach here already gunzipped
 * by the main process (native zlib, off the UI thread); fetched data is gunzipped
 * here only when needed.
 */

import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { Structure } from 'molstar/lib/mol-model/structure';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { describeStructure } from './describe';
import { applyDefaultPreset, refreshColors } from './style';
import { DEFAULT_COLOR, type StructureEntry, type Viewer } from './viewer';
import { ok, err, errorMessage, asStructureId, type ChainRole, type Result, type StructureFormat, type StructureId, type StructureInfo } from './types';

/** Mol*'s rawData rejects SharedArrayBuffer-backed views. */
type Bytes = Uint8Array<ArrayBuffer>;

function isGzip(bytes: Uint8Array): boolean {
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Bytes): Promise<Bytes> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * BinaryCIF is MessagePack (starts with a map marker ≥ 0x80) and never valid text,
 * so anything non-textual is treated as bcif.
 */
export function detectFormat(bytes: Uint8Array, fileName?: string): Result<StructureFormat> {
    if (bytes.length === 0) return err('Arquivo vazio.');
    const head = bytes.subarray(0, 4096);
    if ((head[0] ?? 0) >= 0x80 || head.includes(0x00)) return ok('bcif');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(head);
    if (/^\s*data_/m.test(text) || text.includes('_atom_site.')) return ok('mmcif');
    if (/^(ATOM  |HETATM|HEADER|MODEL |CRYST1|REMARK|TITLE |EXPDTA|SEQRES|COMPND)/m.test(text)) return ok('pdb');
    const ext = fileName?.toLowerCase().replace(/\.gz$/, '').split('.').pop();
    if (ext === 'cif' || ext === 'mmcif') return ok('mmcif');
    if (ext === 'pdb' || ext === 'ent' || ext === 'pdbqt') return ok('pdb');
    if (ext === 'bcif') return ok('bcif');
    return err('Formato não reconhecido. Esperado PDB, mmCIF ou BinaryCIF.');
}

export interface LoadOptions {
    name: string;
    source: StructureInfo['source'];
    path?: string | null;
    /** Skip the default cartoon preset (the caller styles it). */
    bare?: boolean;
}

async function buildStructure(plugin: PluginContext, data: Bytes, format: StructureFormat, label: string) {
    const raw = await plugin.builders.data.rawData({ data: format === 'bcif' ? data : new TextDecoder().decode(data), label });
    const trajectory = await plugin.builders.structure.parseTrajectory(raw, format === 'pdb' ? 'pdb' : 'mmcif');
    const model = await plugin.builders.structure.createModel(trajectory, { modelIndex: 0 });
    const structure = await plugin.builders.structure.createStructure(model);
    return { trajectory, model, structure };
}

export async function loadBytes(viewer: Viewer, data: Bytes, options: LoadOptions): Promise<Result<StructureInfo>> {
    const plugin = viewer.plugin;
    try {
        const bytes = isGzip(data) ? await gunzip(data) : data;
        const format = detectFormat(bytes, options.name);
        if (!format.ok) return format;

        const { trajectory, model, structure } = await buildStructure(plugin, bytes, format.value, options.name);
        const data3d = structure.cell?.obj?.data as Structure | undefined;
        if (!data3d) return err('A estrutura foi criada mas está vazia.');

        const id = asStructureId(structure.ref);
        const info = describeStructure(id, data3d, {
            name: options.name,
            source: options.source,
            path: options.path ?? null,
            format: format.value,
            modelCount: trajectory.cell?.obj?.data?.frameCount ?? 1,
        });

        const entry: StructureEntry = {
            info,
            trajectory,
            model,
            structure,
            // AF/ColabFold models open coloured by confidence: that is what one looks at first.
            color: { ...DEFAULT_COLOR, scheme: info.looksLikePlddt && info.chains.filter((c) => c.isPolymer).length === 1 ? 'plddt' : 'chain' },
            chainColors: {},
            paint: [],
            datasets: new Map(),
        };
        viewer.entries.set(id, entry);
        if (!options.bare) {
            const preset = await applyDefaultPreset(viewer, id);
            if (!preset.ok) return preset;
        }
        viewer.notify();
        return ok(info);
    } catch (e) {
        return err(`Falha ao carregar ${options.name}: ${errorMessage(e)}`);
    }
}

/** Fetches a PDB entry as BinaryCIF — roughly 10× smaller than the text formats. */
export async function loadFromPdbId(viewer: Viewer, rawId: string): Promise<Result<StructureInfo>> {
    const id = rawId.trim().toLowerCase();
    if (!/^[0-9][a-z0-9]{3}$/.test(id)) return err('Código PDB inválido. Use 4 caracteres, por exemplo 1AO7.');
    try {
        const response = await fetch(`https://models.rcsb.org/${id}.bcif`);
        if (!response.ok) return err(`PDB ${id.toUpperCase()} não encontrado (HTTP ${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return await loadBytes(viewer, bytes, { name: id.toUpperCase(), source: 'pdb' });
    } catch (e) {
        return err(`Falha de rede ao buscar ${id.toUpperCase()}: ${errorMessage(e)}`);
    }
}

/** The AFDB filename version moves as the database is rebuilt; try newest first. */
const AFDB_VERSIONS = [6, 5, 4, 3] as const;

export async function loadFromUniProt(viewer: Viewer, rawId: string): Promise<Result<StructureInfo>> {
    const id = rawId.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,10}$/.test(id)) return err('Acesso UniProt inválido, por exemplo P26717.');
    for (const version of AFDB_VERSIONS) {
        try {
            const response = await fetch(`https://alphafold.ebi.ac.uk/files/AF-${id}-F1-model_v${version}.cif`);
            if (!response.ok) continue;
            const bytes = new Uint8Array(await response.arrayBuffer());
            return await loadBytes(viewer, bytes, { name: `AF-${id}`, source: 'alphafold' });
        } catch {
            // Try the next version before reporting failure.
        }
    }
    return err(`Nenhum modelo do AlphaFold DB encontrado para ${id}.`);
}

/** Shows another model of a multi-model file; components and styles rebuild downstream. */
export async function setModelIndex(viewer: Viewer, id: StructureId, index: number): Promise<Result<true>> {
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    const clamped = Math.max(0, Math.min(entry.info.modelCount - 1, Math.round(index)));
    try {
        await viewer.plugin
            .build()
            .to(entry.model)
            .update(StateTransforms.Model.ModelFromTrajectory, (old) => ({ ...old, modelIndex: clamped }))
            .commit();
        entry.info.modelIndex = clamped;
        viewer.notify();
        return ok(true);
    } catch (e) {
        return err(`Falha ao trocar de modelo: ${errorMessage(e)}`);
    }
}

export function renameStructure(viewer: Viewer, id: StructureId, alias: string): void {
    const entry = viewer.entry(id);
    if (!entry) return;
    entry.info.alias = alias.trim();
    viewer.notify();
}

export function renameChain(viewer: Viewer, id: StructureId, chain: string, alias: string): void {
    const c = viewer.entry(id)?.info.chains.find((x) => x.authAsymId === chain);
    if (!c) return;
    c.alias = alias.trim();
    viewer.notify();
}

/** Overrides the heuristic role of a chain; the role scheme and interface defaults follow it. */
export async function setChainRole(viewer: Viewer, id: StructureId, chain: string, role: ChainRole): Promise<Result<true>> {
    const entry = viewer.entry(id);
    const c = entry?.info.chains.find((x) => x.authAsymId === chain);
    if (!entry || !c) return err('Cadeia não encontrada.');
    c.role = role;
    // Chain colours depend on roles under the role scheme and the mono-accent palette.
    const result = await refreshColors(viewer, id);
    viewer.notify();
    return result;
}
