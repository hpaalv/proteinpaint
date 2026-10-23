/**
 * Scene snapshots for undo/redo.
 *
 * A snapshot is Mol*'s own state-tree snapshot (every component, representation,
 * overpaint and transparency node) plus the selection and the per-structure
 * bookkeeping the engine keeps outside the tree (colour settings, chain overrides,
 * the paint log, computed datasets).
 *
 * Deliberately *not* captured: the camera and the look. Undo should put the scene
 * back, not fling the camera somewhere the user did not ask for, and lighting has
 * its own presets.
 */

import type { PluginState } from 'molstar/lib/mol-plugin/state';
import type { StructureEntry, Viewer } from './viewer';
import { ok, err, errorMessage, type Result } from './types';

const SNAPSHOT_PARAMS = {
    data: true,
    behavior: false,
    structureSelection: true,
    componentManager: true,
    animation: false,
    startAnimation: false,
    canvas3d: false,
    canvas3dContext: false,
    interactivity: false,
    camera: false,
    image: false,
    durationInMs: 0,
} as const;

export interface SceneSnapshot {
    readonly state: PluginState.Snapshot;
    /** Per-structure data the engine keeps beside the state tree. */
    readonly entries: { id: string; entry: StructureEntry }[];
    readonly measurements: Viewer['measurements'];
}

function cloneEntry(entry: StructureEntry): StructureEntry {
    return {
        ...entry,
        // The info object is handed to React; copying it keeps the snapshot immutable.
        info: { ...entry.info, chains: entry.info.chains.map((c) => ({ ...c })) },
        color: { ...entry.color },
        chainColors: { ...entry.chainColors },
        paint: [...entry.paint],
        datasets: new Map(entry.datasets),
    };
}

export function captureScene(viewer: Viewer): SceneSnapshot | null {
    try {
        return {
            state: viewer.plugin.state.getSnapshot(SNAPSHOT_PARAMS as unknown as PluginState.SnapshotParams),
            entries: [...viewer.entries.entries()].map(([id, entry]) => ({ id, entry: cloneEntry(entry) })),
            measurements: viewer.measurements.map((m) => ({ ...m })),
        };
    } catch {
        return null;
    }
}

export async function restoreScene(viewer: Viewer, snapshot: SceneSnapshot): Promise<Result<true>> {
    try {
        await viewer.plugin.state.setSnapshot(snapshot.state);
        viewer.entries.clear();
        for (const { id, entry } of snapshot.entries) viewer.entries.set(id as never, cloneEntry(entry));
        viewer.measurements = snapshot.measurements.map((m) => ({ ...m }));
        viewer.notify();
        return ok(true);
    } catch (e) {
        return err(`Não foi possível desfazer: ${errorMessage(e)}`);
    }
}
