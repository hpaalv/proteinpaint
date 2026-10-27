/**
 * The platform bridge over HTTP, for the app served by server/main.cjs on an HPC node
 * and opened through an SSH tunnel. It installs the same `window.pp` as Electron's
 * preload, so the rest of the app does not know the difference: files and the compute
 * core live on the server, native dialogs become <FileDialogHost>, and saving offers
 * "download to this computer" next to "save on the server".
 */

import type { Bridge, CoreJob, CoreReply, DatasetScan, GpuInfo, MovieFormat, ReadFileResult } from './bridge';
import { readBrowserFile } from './bridge';
import { askFile, lastDir } from './fileDialog';

/** server/main.cjs marks the page it serves; Vite's dev server and Electron do not. */
export function isWebServer(): boolean {
    return Boolean(document.querySelector('meta[name="pp-web"]'));
}

export interface ServerInfo {
    home: string;
    roots: string[];
    temp: string;
    user: string;
    host: string;
}

export interface DirListing {
    dir: string;
    parent: string | null;
    entries: { name: string; dir: boolean; size: number; mtime: number }[];
}

export async function call<T>(method: string, ...args: unknown[]): Promise<T> {
    const res = await fetch('/api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PP': '1' },
        body: JSON.stringify({ method, args }),
    });
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { value?: T; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.value as T;
}

let infoPromise: Promise<ServerInfo> | null = null;
export const serverInfo = (): Promise<ServerInfo> => (infoPromise ??= call<ServerInfo>('info'));

export const listDir = (dir: string, showHidden = false): Promise<DirListing> => call<DirListing>('list', dir, showHidden);

export const rawUrl = (path: string, download = false): string => `/api/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;

async function startDir(): Promise<string> {
    return lastDir() ?? (await serverInfo()).home;
}

const parentOf = (p: string): string => p.replace(/\/[^/]*\/?$/, '') || '/';

async function readOne(path: string): Promise<ReadFileResult> {
    const name = path.split('/').pop() ?? path;
    try {
        const res = await fetch(`/api/read?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            return { ok: false, name, path, error: body.error ?? `HTTP ${res.status}` };
        }
        return {
            ok: true,
            name: decodeURIComponent(res.headers.get('X-PP-Name') ?? name),
            path,
            size: Number(res.headers.get('X-PP-Size') ?? 0),
            bytes: new Uint8Array(await res.arrayBuffer()),
        };
    } catch (e) {
        return { ok: false, name, path, error: String(e) };
    }
}

/** Same cap as the desktop's readMany: a folder of 500 designs must not open 500 sockets. */
async function readFiles(paths: string[], concurrency = 8): Promise<ReadFileResult[]> {
    const out = new Array<ReadFileResult>(paths.length);
    let next = 0;
    const worker = async () => {
        while (next < paths.length) {
            const i = next++;
            out[i] = await readOne(paths[i]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
    return out;
}

function download(href: string, name: string): void {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
}

// ---------------------------------------------------------------------------
// Job events: one EventSource for the whole page.
// ---------------------------------------------------------------------------

const jobListeners = new Set<(job: CoreJob) => void>();
const downListeners = new Set<(e: string | null) => void>();
let events: EventSource | null = null;

function ensureEvents(): void {
    if (events) return;
    events = new EventSource('/api/events');
    events.addEventListener('job', (e) => {
        const job = JSON.parse((e as MessageEvent<string>).data) as CoreJob;
        for (const cb of jobListeners) cb(job);
    });
    events.addEventListener('down', (e) => {
        const err = JSON.parse((e as MessageEvent<string>).data) as string | null;
        for (const cb of downListeners) cb(err);
    });
}

function subscribe<T>(set: Set<T>, cb: T): () => void {
    ensureEvents();
    set.add(cb);
    return () => set.delete(cb);
}

// ---------------------------------------------------------------------------
// Saving: on the server, or downloaded to this computer.
// ---------------------------------------------------------------------------

async function save(title: string, suggestedName: string, onServer: (path: string) => Promise<{ ok: boolean; path?: string }>, href: () => string) {
    const r = await askFile({ kind: 'save', title, suggestedName, start: await startDir() });
    if (!r) return { ok: false, canceled: true };
    if (r.kind === 'download') {
        const url = href();
        download(url, suggestedName);
        if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return { ok: true, path: `${suggestedName} (download)` };
    }
    if (r.kind !== 'paths' || !r.paths[0]) return { ok: false, canceled: true };
    try {
        return await onServer(r.paths[0]);
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

const MOVIE_EXT: Record<MovieFormat, string> = { mp4: 'mp4', webm: 'webm', gif: 'gif', apng: 'png', frames: '' };

const webBridge: Bridge = {
    async core<T>(method: string, params?: Record<string, unknown>): Promise<CoreReply<T>> {
        try {
            return await call<CoreReply<T>>('core', method, params ?? null);
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    },
    onJob: (cb) => subscribe(jobListeners, cb),
    onCoreDown: (cb) => subscribe(downListeners, cb),

    async openHtml(file) {
        window.open(rawUrl(file), '_blank', 'noopener');
        return true;
    },
    async showFolder(target) {
        // Jobs point at a folder or at one of its files (a .dx map, a PNG).
        const isFile = /\.[A-Za-z0-9]{1,6}$/.test(target);
        await askFile({ kind: 'browse', title: 'Arquivos no servidor', start: isFile ? parentOf(target) : target, highlight: isFile ? target : undefined });
        return true;
    },
    saveText: (text, suggestedName) =>
        save('Salvar tabela', suggestedName, (path) => call('writeText', path, text), () => URL.createObjectURL(new Blob([text], { type: 'text/csv' }))),
    savePng: (dataUrl, suggestedName) => save('Salvar imagem', suggestedName, (path) => call('writePng', path, dataUrl), () => dataUrl),
    writeTemp: (name, text) => call<string>('writeTemp', name, text),

    async openFiles() {
        const r = await askFile({ kind: 'open', title: 'Abrir estruturas', start: await startDir() });
        if (!r) return [];
        if (r.kind === 'local') return Promise.all(r.files.map(readBrowserFile));
        return r.kind === 'paths' ? readFiles(r.paths) : [];
    },
    async openFolder() {
        const r = await askFile({ kind: 'folder', title: 'Abrir pasta de designs', start: await startDir() });
        const folder = r?.kind === 'paths' ? r.paths[0] : undefined;
        if (!folder) return { folder: null, files: [] };
        return { folder, files: await call<string[]>('scanFolder', folder) };
    },
    async openDataset(): Promise<DatasetScan> {
        const r = await askFile({ kind: 'folder', title: 'Abrir pasta de análise (estruturas + metadados)', start: await startDir() });
        const folder = r?.kind === 'paths' ? r.paths[0] : undefined;
        if (!folder) return { folder: null, structures: [], tables: [], docs: [] };
        return call<DatasetScan>('scanDataset', folder);
    },
    scanDataset: (folder) => call<DatasetScan>('scanDataset', folder),
    expandPaths: (paths) => call<string[]>('expandPaths', paths),
    readFiles: (paths) => readFiles(paths),
    // The status bar reads the GPU from the viewer's own WebGL renderer string instead.
    gpuInfo: async (): Promise<GpuInfo> => ({ status: {}, active: null, devices: [] }),

    async movieChoose(format, suggestedName) {
        if (format === 'frames') {
            const r = await askFile({ kind: 'folder', title: 'Pasta para os quadros (no servidor)', start: await startDir() });
            return r?.kind === 'paths' ? r.paths[0] ?? null : null;
        }
        const r = await askFile({ kind: 'save', title: 'Salvar animação (no servidor)', suggestedName: `${suggestedName}.${MOVIE_EXT[format]}`, start: await startDir() });
        return r?.kind === 'paths' ? r.paths[0] ?? null : null;
    },
    movieStart: (opts) => call('movieStart', opts),
    async movieFrame(id, rgba) {
        try {
            // Frames come from readPixels into a plain ArrayBuffer, never a shared one.
            const frame = rgba as Uint8ClampedArray<ArrayBuffer>;
            const res = await fetch(`/api/movie/frame?id=${id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-PP': '1' }, body: frame });
            const body = (await res.json()) as { value?: CoreReply<true>; error?: string };
            return body.value ?? { ok: false, error: body.error ?? `HTTP ${res.status}` };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    },
    movieFinish: (id, cancel) => call('movieFinish', id, cancel),

    // Files dropped from this computer have no path on the server: they are read in the browser.
    pathForFile: () => '',
};

export function installWebBridge(): void {
    if (!window.pp && isWebServer()) window.pp = webBridge;
}
