/**
 * Application state (Zustand). The Viewer itself is not reactive state — it lives in
 * a module reference and the store keeps snapshots of what the UI renders, refreshed
 * from the viewer's change and selection events.
 */

import { create } from 'zustand';
import type {
    HydrogenDisplay,
    InteractionKind,
    InterfaceReport,
    LookPreset,
    MeasureKind,
    MeasurementInfo,
    SelectedResidues,
    SelectionSummary,
    StructureId,
    StructureInfo,
    SuperposeReport,
    Viewer,
} from '@/engine';

export type InspectorTab = 'style' | 'color' | 'select' | 'interface' | 'compare' | 'scene' | 'figure' | 'measure' | 'analysis';
export type PointerTool = 'select' | 'explore' | 'measure';

export interface Toast {
    id: number;
    kind: 'info' | 'error' | 'ok';
    text: string;
    /** Lifetime in ms (drives the shrinking bar). */
    ms: number;
    /** Playing its exit animation; removed right after. */
    leaving?: boolean;
}

export interface Library {
    folder: string | null;
    files: string[];
    /** Path currently shown in "browse" mode, and the structure it loaded. */
    current: string | null;
    browseId: StructureId | null;
}

export type Workspace = 'structure' | 'data';

export type SequenceMode = 'fixed' | 'auto' | 'off';

const SEQUENCE_KEY = 'pp.sequenceMode';

function initialSequenceMode(): SequenceMode {
    try {
        const v = localStorage.getItem(SEQUENCE_KEY);
        if (v === 'fixed' || v === 'auto' || v === 'off') return v;
    } catch {
        // Storage unavailable: fall back to the default.
    }
    return 'fixed';
}

export function setSequenceMode(mode: SequenceMode): void {
    useApp.setState({ sequenceMode: mode });
    try {
        localStorage.setItem(SEQUENCE_KEY, mode);
    } catch {
        // Not remembered across sessions; still applied now.
    }
}

/** Which side panels are shown; hiding them all leaves only the scene (or the data panel). */
export interface PanelsShown {
    left: boolean;
    right: boolean;
    bottom: boolean;
}

const PANELS_KEY = 'pp.panels';
const ALL_PANELS: PanelsShown = { left: true, right: true, bottom: true };

function initialPanels(): PanelsShown {
    try {
        const v = JSON.parse(localStorage.getItem(PANELS_KEY) ?? 'null') as Partial<PanelsShown> | null;
        if (v && typeof v === 'object') return { ...ALL_PANELS, ...v };
    } catch {
        // Storage unavailable or corrupt: everything shown.
    }
    return ALL_PANELS;
}

export function setPanels(patch: Partial<PanelsShown>): void {
    const panels = { ...useApp.getState().panels, ...patch };
    useApp.setState({ panels });
    try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
    } catch {
        // Not remembered across sessions; still applied now.
    }
}

/** Hides every side panel, or brings them all back when they are already hidden. */
export function toggleAllPanels(): void {
    const p = useApp.getState().panels;
    const anyShown = p.left || p.right || p.bottom;
    setPanels(anyShown ? { left: false, right: false, bottom: false } : ALL_PANELS);
}

export interface AppState {
    /** Which workspace the window shows: the 3D viewer or the data/panel composer. */
    workspace: Workspace;
    ready: boolean;
    initError: string | null;
    gpu: string;

    structures: StructureInfo[];
    activeId: StructureId | null;
    measurements: MeasurementInfo[];

    selection: SelectionSummary | null;
    selectedResidues: SelectedResidues;
    hover: string;

    tool: PointerTool;
    /** Depth-clipping slab, 0–95 %. Shown in the viewport while it cuts the scene. */
    clip: number;
    measureKind: MeasureKind;
    measureProgress: { picked: number; needed: number } | null;

    tab: InspectorTab;
    /** Preset the look came from; 'custom' once tuned by hand or loaded from a saved style. */
    look: LookPreset | 'custom';
    /** Bumped when the look is replaced from outside the studio sliders (saved style, harness). */
    lookRev: number;
    /**
     * Sequence track: always below the viewer, tucked away until the pointer reaches the
     * bottom edge (over the scene, so the canvas never resizes), or off. Remembered.
     */
    sequenceMode: SequenceMode;
    panels: PanelsShown;

    library: Library;
    busy: string | null;
    /** 0–1 while an animation is being rendered. */
    movieProgress: number | null;
    toasts: Toast[];

    interfaceReport: InterfaceReport | null;
    interactionKinds: InteractionKind[];
    hydrogens: HydrogenDisplay;
    superposeReports: SuperposeReport[];
}

export const useApp = create<AppState>(() => ({
    workspace: 'structure',
    ready: false,
    initError: null,
    gpu: '',
    structures: [],
    activeId: null,
    measurements: [],
    selection: null,
    selectedResidues: new Map(),
    hover: '',
    tool: 'select',
    clip: 0,
    measureKind: 'distance',
    measureProgress: null,
    tab: 'style',
    look: 'soft',
    lookRev: 0,
    sequenceMode: initialSequenceMode(),
    panels: initialPanels(),
    library: { folder: null, files: [], current: null, browseId: null },
    busy: null,
    movieProgress: null,
    toasts: [],
    interfaceReport: null,
    interactionKinds: ['hydrogen-bond', 'salt-bridge', 'pi-stacking', 'cation-pi', 'halogen-bond', 'metal'],
    hydrogens: 'polar',
    superposeReports: [],
}));

// ---------------------------------------------------------------------------
// The viewer reference
// ---------------------------------------------------------------------------

let viewerRef: Viewer | null = null;

export function setViewer(v: Viewer | null): void {
    viewerRef = v;
}

export function viewer(): Viewer | null {
    return viewerRef;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastSeq = 0;

const TOAST_EXIT_MS = 200;

/** Starts a toast's exit animation and removes it when the animation is done. */
export function dismissToast(id: number): void {
    useApp.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
    window.setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_EXIT_MS);
}

export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
    const id = ++toastSeq;
    const life = kind === 'error' ? ms * 2 : ms;
    // At most 4 on screen: the oldest leaves first.
    useApp.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, ms: life }] }));
    window.setTimeout(() => dismissToast(id), life);
}

/** Runs an engine call that returns a Result and toasts its error. */
export async function run<T>(promise: Promise<{ ok: true; value: T } | { ok: false; error: string }> | { ok: true; value: T } | { ok: false; error: string }): Promise<T | null> {
    const r = await promise;
    if (!r.ok) {
        toast(r.error, 'error');
        return null;
    }
    return r.value;
}
