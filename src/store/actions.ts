/**
 * App-level actions: everything that combines the platform bridge, the engine and
 * the store. Components call these; they never talk to the bridge directly.
 */

import * as E from '@/engine';
import { asBytes, platform, readBrowserFile, type MovieFormat, type ReadFileResult } from '@/platform/bridge';
import { run, toast, useApp, viewer, type PointerTool } from './app';
import { record } from './history';

const STRUCTURE_FILE = /\.(pdb|ent|cif|mmcif|bcif|pdbqt)(\.gz)?$/i;

/** Copies viewer state into the store; StructureInfo objects are cloned so React sees new references. */
export function syncStructures(): void {
    const v = viewer();
    if (!v) return;
    const structures = v.infos().map((i) => ({ ...i, chains: i.chains.map((c) => ({ ...c })) }));
    const { activeId } = useApp.getState();
    useApp.setState({
        structures,
        measurements: [...v.measurements],
        activeId: activeId && structures.some((s) => s.id === activeId) ? activeId : (structures[structures.length - 1]?.id ?? null),
    });
}

export function syncSelection(): void {
    const v = viewer();
    if (!v) return;
    useApp.setState({ selection: E.selectionSummary(v), selectedResidues: E.selectedResidues(v) });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadResults(results: ReadFileResult[]): Promise<E.StructureId[]> {
    const v = viewer();
    if (!v) return [];
    const loaded: E.StructureId[] = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (!r.ok || !r.bytes) {
            toast(`${r.name}: ${r.error ?? 'não foi possível ler'}`, 'error');
            continue;
        }
        useApp.setState({ busy: results.length > 1 ? `Carregando ${i + 1}/${results.length} · ${r.name}` : `Carregando ${r.name}` });
        const info = await run(E.loadBytes(v, asBytes(r.bytes), { name: r.name, source: 'file', path: r.path }));
        if (info) loaded.push(info.id);
    }
    useApp.setState({ busy: null });
    // No camera reset here: Mol* frames the first structure itself once its geometry
    // reaches the canvas, and a reset racing that auto-framing leaves a NaN camera.
    if (loaded.length) useApp.setState({ activeId: loaded[loaded.length - 1]! });
    if (v.entries.size > 40) toast(`${v.entries.size} estruturas na cena. Use a Biblioteca para navegar por pastas grandes.`, 'info');
    return loaded;
}

export async function openFiles(): Promise<void> {
    const results = await platform.openFiles();
    await loadResults(results);
}

/** Opens a folder of designs into the Library (not all into the scene). */
export async function openFolder(): Promise<void> {
    const { folder, files } = await platform.openFolder();
    if (!folder) return;
    setLibrary(folder, files);
}

function setLibrary(folder: string, files: string[]): void {
    useApp.setState((s) => ({ library: { ...s.library, folder, files, current: null } }));
    if (files.length === 0) toast('Nenhum arquivo de estrutura nessa pasta.', 'info');
    else toast(`${files.length} estruturas na biblioteca. PgUp/PgDn (ou ↑/↓ sem seleção) para navegar.`, 'ok');
}

/**
 * Drag-and-drop: in Electron the real paths are resolved and folders expand into the
 * Library; loose files load directly.
 */
export async function dropFiles(files: File[]): Promise<void> {
    const paths = files.map((f) => platform.pathForFile(f)).filter((p): p is string => Boolean(p));
    if (paths.length === files.length && paths.length > 0) {
        const expanded = await platform.expandPaths(paths);
        const fromFolder = expanded.length !== paths.length || expanded.some((p) => !paths.includes(p));
        if (fromFolder && expanded.length > 12) {
            setLibrary(paths.length === 1 ? paths[0]! : `${paths.length} itens`, expanded);
            return;
        }
        await loadResults(await platform.readFiles(expanded.filter((p) => STRUCTURE_FILE.test(p))));
        return;
    }
    await loadResults(await Promise.all(files.map(readBrowserFile)));
}

export async function loadPaths(paths: string[]): Promise<void> {
    record('abrir estrutura');
    await loadResults(await platform.readFiles(paths));
}

/**
 * Library browsing: shows one design at a time. The new design loads before the
 * previous one is removed, so the scene is never empty and the camera stays put —
 * stepping through designs keeps the same view of the interface.
 */
export async function browseTo(path: string): Promise<void> {
    const v = viewer();
    if (!v) return;
    const previous = useApp.getState().library.browseId;
    const previousEntry = previous ? v.entry(previous) : undefined;
    const results = await platform.readFiles([path]);
    const r = results[0];
    if (!r?.ok || !r.bytes) {
        toast(`${r?.name ?? path}: ${r?.error ?? 'não foi possível ler'}`, 'error');
        return;
    }
    const info = await run(E.loadBytes(v, asBytes(r.bytes), { name: r.name, source: 'file', path: r.path }));
    if (!info) return;
    // Carry the colour scheme over, so the comparison between designs is like for like.
    if (previousEntry) await E.setColorSettings(v, info.id, { ...previousEntry.color });
    if (previous && v.entry(previous)) await E.removeStructure(v, previous);
    useApp.setState((s) => ({ library: { ...s.library, current: path, browseId: info.id }, activeId: info.id }));
}

/**
 * Closes a structure and everything that only made sense with it on screen: the
 * engine drops its measurements, labels and overlays; here the panels forget the
 * reports that point at it.
 */
export async function closeStructure(id: E.StructureId): Promise<void> {
    const v = viewer();
    if (!v) return;
    const removed = await run(E.removeStructure(v, id));
    if (!removed) return;
    const { interfaceReport, superposeReports, library } = useApp.getState();
    const involves = (ids: E.StructureId[]) => ids.includes(id);
    useApp.setState({
        interfaceReport: interfaceReport && involves([interfaceReport.sideA.structureId, interfaceReport.sideB.structureId]) ? null : interfaceReport,
        superposeReports: superposeReports.filter((r) => !involves([r.reference.structureId, r.mobile.structureId])),
        library: library.browseId === id ? { ...library, browseId: null, current: null } : library,
    });
    syncStructures();
    syncSelection();
}

/** Keeps the browsed design in the scene; the next step loads alongside it. */
export function pinBrowsed(): void {
    useApp.setState((s) => ({ library: { ...s.library, browseId: null } }));
}

export async function browseStep(delta: number): Promise<void> {
    const { library } = useApp.getState();
    if (library.files.length === 0) return;
    const index = library.current ? library.files.indexOf(library.current) : -1;
    const next = library.files[Math.max(0, Math.min(library.files.length - 1, index + delta))];
    if (next && next !== library.current) await browseTo(next);
}

export async function fetchId(raw: string): Promise<void> {
    const v = viewer();
    if (!v) return;
    const id = raw.trim();
    if (!id) return;
    useApp.setState({ busy: `Baixando ${id.toUpperCase()}` });
    const isPdb = /^[0-9][A-Za-z0-9]{3}$/.test(id);
    const info = await run(isPdb ? E.loadFromPdbId(v, id) : E.loadFromUniProt(v, id));
    useApp.setState({ busy: null });
    if (info) useApp.setState({ activeId: info.id });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

let stopMeasuring: (() => void) | null = null;

export function setTool(tool: PointerTool): void {
    const v = viewer();
    if (!v) return;
    stopMeasuring?.();
    stopMeasuring = null;
    useApp.setState({ tool, measureProgress: null });
    if (tool === 'measure') {
        E.setPointerMode(v, 'select');
        stopMeasuring = E.startMeasuring(v, useApp.getState().measureKind, (picked, needed, error) => {
            useApp.setState({ measureProgress: { picked, needed } });
            if (error) toast(error, 'error');
        });
    } else {
        E.setPointerMode(v, tool);
    }
    // Leaving explore never strands the view in a clipped slab.
    if (tool !== 'explore') E.restoreClipRadius(v);
}

export function setMeasureKind(kind: E.MeasureKind): void {
    useApp.setState({ measureKind: kind });
    if (useApp.getState().tool === 'measure') setTool('measure');
}

export async function exportImage(request: E.ImageRequest, name: string): Promise<void> {
    const v = viewer();
    if (!v) return;
    useApp.setState({ busy: 'Renderizando imagem' });
    const image = await run(E.renderImage(v, request));
    useApp.setState({ busy: null });
    if (!image) return;
    const saved = await platform.savePng(image.dataUrl, name);
    if (saved.ok) toast(`Imagem ${image.width}×${image.height}${image.supersample > 1 ? ` (${image.supersample}× supersampling)` : ''} salva${saved.path ? ` em ${saved.path}` : ''}.`, 'ok');
    else if (!saved.canceled) toast(saved.error ?? 'Falha ao salvar.', 'error');
}

export interface MovieExport {
    request: E.MovieRequest;
    format: MovieFormat;
    fps: number;
    name: string;
}

let movieCancel = false;

export function cancelMovie(): void {
    movieCancel = true;
}

/**
 * Renders a turntable/rock frame by frame and streams it to ffmpeg in the main process.
 * Progress lives in the store so the button, the status bar and the viewport pill agree.
 */
export async function exportMovie({ request, format, fps, name }: MovieExport): Promise<void> {
    const v = viewer();
    const bridge = platform.movie();
    if (!v) return;
    if (!bridge) return toast('A exportação de animação precisa do app desktop (ffmpeg).', 'error');
    const output = await bridge.movieChoose(format, name);
    if (!output) return;

    movieCancel = false;
    useApp.setState({ movieProgress: 0, busy: 'Renderizando animação' });
    let id: number | null = null;
    try {
        const result = await E.renderMovie(
            v,
            request,
            async (frame) => {
                if (id === null) {
                    const started = await bridge.movieStart({ format, output, width: frame.width, height: frame.height, fps });
                    if (!started.ok) throw new Error(started.error);
                    id = started.value;
                }
                const written = await bridge.movieFrame(id, frame.rgba);
                if (!written.ok) throw new Error(written.error);
            },
            (done, total) => useApp.setState({ movieProgress: done / total, busy: `Renderizando animação · ${done}/${total}` }),
            () => movieCancel,
        );
        if (!result.ok) {
            if (id !== null) await bridge.movieFinish(id, true);
            if (!movieCancel) toast(result.error, 'error');
            else toast('Animação cancelada.', 'info', 2000);
            return;
        }
        useApp.setState({ busy: 'Codificando animação' });
        const finished = await bridge.movieFinish(id!, false);
        if (finished.ok) toast(`Animação ${result.value.width}×${result.value.height}, ${result.value.frames} quadros salva em ${finished.value}.`, 'ok', 6000);
        else toast(`ffmpeg: ${finished.error}`, 'error');
    } catch (e) {
        if (id !== null) await bridge.movieFinish(id, true);
        toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
        useApp.setState({ movieProgress: null, busy: null });
    }
}
