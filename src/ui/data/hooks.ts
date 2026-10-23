/**
 * Shared selectors of the data workspace.
 *
 * `filteredRows` builds a new array, so it must never be used as a Zustand selector
 * directly: a fresh reference on every store read makes the component re-render,
 * which reads again — React stops that with "maximum update depth exceeded". These
 * hooks subscribe to the inputs and memoise the derived value instead.
 */

import { useMemo } from 'react';
import type { DatasetRow } from '@/dataset/types';
import { applyFilters } from '@/dataset/types';
import type { Cell, Panel } from '@/panels/types';
import { useData } from '@/store/data';

export function useFilteredRows(): DatasetRow[] {
    const dataset = useData((s) => s.dataset);
    const filters = useData((s) => s.filters);
    return useMemo(() => (dataset ? applyFilters(dataset.rows, filters, dataset.idKey) : []), [dataset, filters]);
}

export function useActivePanel(): Panel | null {
    const panels = useData((s) => s.panels);
    const id = useData((s) => s.activePanelId);
    return useMemo(() => panels.find((p) => p.id === id) ?? null, [panels, id]);
}

export function useActiveCell(): Cell | null {
    const panel = useActivePanel();
    const cellId = useData((s) => s.activeCellId);
    return useMemo(() => panel?.cells.find((c) => c.id === cellId) ?? null, [panel, cellId]);
}
