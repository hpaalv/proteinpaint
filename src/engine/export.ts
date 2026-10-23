/**
 * Structure text for the compute core. Files opened from disk are passed by path;
 * anything that only exists in memory (RCSB/AFDB fetches, BinaryCIF) is written out
 * as mmCIF by Mol* itself. Coordinates are the file's, not the superposed ones:
 * results come back keyed by residue and atom names, and are placed on screen
 * through atoms.ts.
 */

import { to_mmCIF } from 'molstar/lib/mol-model/structure/export/mmcif';
import type { Structure } from 'molstar/lib/mol-model/structure';
import type { Viewer } from './viewer';
import { ok, err, errorMessage, type Result, type StructureId } from './types';

export type ComputeInput = { kind: 'path'; path: string } | { kind: 'text'; name: string; text: string };

export function computeInput(viewer: Viewer, id: StructureId): Result<ComputeInput> {
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    const { path, format, name } = entry.info;
    // Multi-model files: the tools read model 1, so a different model must be exported.
    if (path && format !== 'bcif' && entry.info.modelIndex === 0) return ok({ kind: 'path', path });
    try {
        const structure = entry.structure.cell?.obj?.data as Structure | undefined;
        if (!structure) return err('A estrutura ainda não está pronta.');
        const text = to_mmCIF(name.replace(/[^A-Za-z0-9_]/g, '_'), structure, false) as string;
        return ok({ kind: 'text', name: `${name.replace(/\.[^.]+$/, '')}_m${entry.info.modelIndex + 1}.cif`, text });
    } catch (e) {
        return err(`Falha ao exportar a estrutura: ${errorMessage(e)}`);
    }
}
