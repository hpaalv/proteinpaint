/**
 * Per-residue datasets attached to a structure, shown through the 'data' scheme.
 */

import { refreshColors } from './style';
import type { Viewer } from './viewer';
import { ok, err, type ResidueDataset, type Result, type StructureId } from './types';

export function setDataset(viewer: Viewer, id: StructureId, dataset: ResidueDataset): void {
    const entry = viewer.entry(id);
    if (!entry) return;
    entry.datasets.set(dataset.id, dataset);
    viewer.notify();
}

export function datasetsOf(viewer: Viewer, id: StructureId): ResidueDataset[] {
    return [...(viewer.entry(id)?.datasets.values() ?? [])];
}

/** Colours the structure by a dataset (and remembers the choice in its colour settings). */
export async function showDataset(viewer: Viewer, id: StructureId, datasetId: string, fallback: 'neutral' | 'chain' = 'neutral'): Promise<Result<true>> {
    const entry = viewer.entry(id);
    if (!entry) return err('Estrutura não encontrada.');
    if (!entry.datasets.has(datasetId)) return err('Conjunto de dados não encontrado.');
    entry.color = { ...entry.color, scheme: 'data', dataset: datasetId, dataFallback: fallback };
    const r = await refreshColors(viewer, id);
    viewer.notify();
    return r.ok ? ok(true) : r;
}

export async function updateDataset(viewer: Viewer, id: StructureId, datasetId: string, patch: Partial<ResidueDataset>): Promise<Result<true>> {
    const entry = viewer.entry(id);
    const d = entry?.datasets.get(datasetId);
    if (!entry || !d) return err('Conjunto de dados não encontrado.');
    entry.datasets.set(datasetId, { ...d, ...patch });
    if (entry.color.scheme === 'data' && entry.color.dataset === datasetId) await refreshColors(viewer, id);
    viewer.notify();
    return ok(true);
}
