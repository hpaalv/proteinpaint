/**
 * Undo / redo for the 3D workspace (Ctrl+Z, Ctrl+Y).
 *
 * The scene is snapshotted *before* each change, so undo restores what was on screen
 * a moment ago. Snapshots taken in quick succession — a slider being dragged — are
 * coalesced: only the state before the first one of the burst is kept, which is what
 * "undo" means to someone dragging a slider.
 */

import * as E from '@/engine';
import { create } from 'zustand';
import { run, toast, useApp, viewer } from './app';
import { syncSelection, syncStructures } from './actions';

interface Entry {
    label: string;
    snapshot: E.SceneSnapshot;
}

interface HistoryState {
    past: Entry[];
    future: Entry[];
    /** Set while an undo/redo is being applied, so it is not recorded as a new change. */
    applying: boolean;
}

const LIMIT = 40;
/** Changes closer together than this join the previous entry (slider drags). */
const COALESCE_MS = 600;

export const useHistory = create<HistoryState>(() => ({ past: [], future: [], applying: false }));

let lastRecord = 0;
let lastLabel = '';

/**
 * Records the scene as it is now, before `label` changes it. Call it immediately
 * before a mutation.
 */
export function record(label: string): void {
    const v = viewer();
    if (!v || useHistory.getState().applying) return;
    const now = performance.now();
    // A burst of the same action (a slider) is one undo step.
    if (label === lastLabel && now - lastRecord < COALESCE_MS) {
        lastRecord = now;
        return;
    }
    const snapshot = E.captureScene(v);
    if (!snapshot) return;
    lastRecord = now;
    lastLabel = label;
    useHistory.setState((s) => ({ past: [...s.past, { label, snapshot }].slice(-LIMIT), future: [] }));
}

/**
 * Records the scene, then runs an engine call — the one line a UI action needs to
 * become undoable. Everything the user can change goes through here.
 */
export async function act<T>(label: string, fn: () => Promise<{ ok: true; value: T } | { ok: false; error: string }> | { ok: true; value: T } | { ok: false; error: string }): Promise<T | null> {
    record(label);
    return run(fn());
}

/** Clears the history — after loading a different scene, undo across it means nothing. */
export function resetHistory(): void {
    useHistory.setState({ past: [], future: [] });
    lastLabel = '';
}

async function apply(entry: Entry, counterpart: 'past' | 'future'): Promise<void> {
    const v = viewer();
    if (!v) return;
    useHistory.setState({ applying: true });
    try {
        const current = E.captureScene(v);
        const r = await E.restoreScene(v, entry.snapshot);
        if (!r.ok) {
            toast(r.error, 'error');
            return;
        }
        if (current) {
            useHistory.setState((s) => ({ [counterpart]: [...s[counterpart], { label: entry.label, snapshot: current }].slice(-LIMIT) }) as Partial<HistoryState>);
        }
        syncStructures();
        syncSelection();
        useApp.setState({ interfaceReport: null });
    } finally {
        useHistory.setState({ applying: false });
        lastLabel = '';
    }
}

export async function undo(): Promise<void> {
    const { past } = useHistory.getState();
    const entry = past[past.length - 1];
    if (!entry) return;
    useHistory.setState({ past: past.slice(0, -1) });
    await apply(entry, 'future');
    toast(`Desfeito: ${entry.label}`, 'info', 1600);
}

export async function redo(): Promise<void> {
    const { future } = useHistory.getState();
    const entry = future[future.length - 1];
    if (!entry) return;
    useHistory.setState({ future: future.slice(0, -1) });
    await apply(entry, 'past');
    toast(`Refeito: ${entry.label}`, 'info', 1600);
}
