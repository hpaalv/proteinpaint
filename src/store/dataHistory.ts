/**
 * Undo / redo for the data workspace (Ctrl+Z, Ctrl+Y while it is shown).
 *
 * The data store is immutable, so a snapshot is just the references to the panels and
 * filters as they were — no copying. Every change to them is recorded by a store
 * subscription, so no action has to remember to call `record`. The selection is left
 * out: clicking through designs is browsing, and undo stepping back through clicks
 * would bury the edit the user actually wants to take back.
 */

import { create } from 'zustand';
import { toast } from './app';
import { useData, type DataState } from './data';

type Doc = Pick<DataState, 'panels' | 'filters' | 'activePanelId' | 'activeCellId'>;

interface DataHistoryState {
    past: Doc[];
    future: Doc[];
}

const LIMIT = 60;
/** Changes closer together than this are one step (a slider drag, typing a title). */
const COALESCE_MS = 600;

export const useDataHistory = create<DataHistoryState>(() => ({ past: [], future: [] }));

const docOf = (s: DataState): Doc => ({ panels: s.panels, filters: s.filters, activePanelId: s.activePanelId, activeCellId: s.activeCellId });

let applying = false;
let lastRecord = 0;

useData.subscribe((state, prev) => {
    if (applying) return;
    // A new dataset is a new document: undo across it would mix two folders.
    if (state.dataset !== prev.dataset) {
        useDataHistory.setState({ past: [], future: [] });
        return;
    }
    if (state.panels === prev.panels && state.filters === prev.filters) return;
    const now = performance.now();
    const burst = now - lastRecord < COALESCE_MS;
    lastRecord = now;
    if (burst) return;
    useDataHistory.setState((h) => ({ past: [...h.past, docOf(prev)].slice(-LIMIT), future: [] }));
});

function restore(doc: Doc): void {
    applying = true;
    try {
        useData.setState(doc);
    } finally {
        applying = false;
        lastRecord = 0;
    }
}

export function dataUndo(): void {
    const { past, future } = useDataHistory.getState();
    const doc = past[past.length - 1];
    if (!doc) return toast('Nada para desfazer.', 'info', 1200);
    useDataHistory.setState({ past: past.slice(0, -1), future: [...future, docOf(useData.getState())] });
    restore(doc);
}

export function dataRedo(): void {
    const { past, future } = useDataHistory.getState();
    const doc = future[future.length - 1];
    if (!doc) return;
    useDataHistory.setState({ future: future.slice(0, -1), past: [...past, docOf(useData.getState())] });
    restore(doc);
}
