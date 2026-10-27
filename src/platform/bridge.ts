/**
 * Typed access to the platform bridge: the Electron preload (electron/preload.cjs) or,
 * when the app is served by server/main.cjs (HPC), the HTTP bridge of web.ts. Both
 * install the same `window.pp`.
 *
 * In a plain browser (`vite` alone) the bridge is missing; file opening then falls
 * back to an <input type=file>, and saving to a download link.
 */

export interface ReadFileResult {
    ok: boolean;
    name: string;
    path: string;
    size?: number;
    bytes?: Uint8Array;
    error?: string;
}

export interface GpuInfo {
    status: Record<string, string>;
    active: { vendorId: number; deviceId: number; driverVendor?: string; driverVersion?: string } | null;
    devices: { vendorId: number; deviceId: number; active?: boolean }[];
}

export interface CoreJob {
    id: string;
    tool: string;
    label: string;
    group: string | null;
    state: 'queued' | 'running' | 'done' | 'error' | 'canceled';
    progress: number;
    message: string;
    result: unknown;
    error: string | null;
    created: number;
    started: number | null;
    finished: number | null;
    workdir: string;
    params: Record<string, unknown>;
}

export interface DatasetScan {
    folder: string | null;
    structures: string[];
    tables: { path: string; size: number }[];
    /** NOTES.md / README.md found in the folder. */
    docs: string[];
}

export type MovieFormat = 'mp4' | 'webm' | 'gif' | 'apng' | 'frames';

export type CoreReply<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Bridge {
    core<T = unknown>(method: string, params?: Record<string, unknown>): Promise<CoreReply<T>>;
    onJob(cb: (job: CoreJob) => void): () => void;
    onCoreDown(cb: (error: string | null) => void): () => void;
    openHtml(file: string, title?: string): Promise<boolean>;
    showFolder(folder: string): Promise<boolean>;
    saveText(text: string, suggestedName: string, filters?: { name: string; extensions: string[] }[]): Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
    writeTemp(name: string, text: string): Promise<string>;
    openFiles(): Promise<ReadFileResult[]>;
    openFolder(): Promise<{ folder: string | null; files: string[] }>;
    openDataset(): Promise<DatasetScan>;
    scanDataset(folder: string): Promise<DatasetScan>;
    expandPaths(paths: string[]): Promise<string[]>;
    readFiles(paths: string[]): Promise<ReadFileResult[]>;
    savePng(dataUrl: string, suggestedName: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    gpuInfo(): Promise<GpuInfo>;
    movieChoose(format: MovieFormat, suggestedName: string): Promise<string | null>;
    movieStart(opts: { format: MovieFormat; output: string; width: number; height: number; fps: number }): Promise<CoreReply<number>>;
    movieFrame(id: number, rgba: Uint8ClampedArray): Promise<CoreReply<true>>;
    movieFinish(id: number, cancel: boolean): Promise<CoreReply<string | null>>;
    pathForFile(file: File): string;
}

declare global {
    interface Window {
        pp?: Bridge;
    }
}

export const isElectron = (): boolean => Boolean(window.pp);

/** Main-process results arrive as Uint8Array views; Mol* wants an ArrayBuffer-backed copy. */
export function asBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}

function pickWithInput(): Promise<ReadFileResult[]> {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async () => {
            const files = [...(input.files ?? [])];
            resolve(await Promise.all(files.map(readBrowserFile)));
        };
        input.click();
    });
}

export async function readBrowserFile(file: File): Promise<ReadFileResult> {
    try {
        return { ok: true, name: file.name, path: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    } catch (e) {
        return { ok: false, name: file.name, path: file.name, error: String(e) };
    }
}

export const platform = {
    openFiles: (): Promise<ReadFileResult[]> => (window.pp ? window.pp.openFiles() : pickWithInput()),
    openFolder: async () => (window.pp ? window.pp.openFolder() : { folder: null, files: [] }),
    openDataset: async (): Promise<DatasetScan> => (window.pp ? window.pp.openDataset() : { folder: null, structures: [], tables: [], docs: [] }),
    scanDataset: async (folder: string): Promise<DatasetScan> => (window.pp ? window.pp.scanDataset(folder) : { folder: null, structures: [], tables: [], docs: [] }),
    expandPaths: async (paths: string[]) => (window.pp ? window.pp.expandPaths(paths) : paths),
    readFiles: async (paths: string[]) => (window.pp ? window.pp.readFiles(paths) : []),
    pathForFile: (file: File): string | null => (window.pp ? window.pp.pathForFile(file) || null : null),
    gpuInfo: async (): Promise<GpuInfo | null> => (window.pp ? window.pp.gpuInfo() : null),
    /** Animation export needs ffmpeg in the main process: desktop app only. */
    movie: () => window.pp ?? null,
    async core<T = unknown>(method: string, params?: Record<string, unknown>): Promise<CoreReply<T>> {
        if (!window.pp) return { ok: false, error: 'Os cálculos precisam do app desktop (Electron).' };
        return window.pp.core<T>(method, params);
    },
    onJob: (cb: (job: CoreJob) => void) => (window.pp ? window.pp.onJob(cb) : () => {}),
    onCoreDown: (cb: (e: string | null) => void) => (window.pp ? window.pp.onCoreDown(cb) : () => {}),
    openHtml: async (file: string, title?: string) => (window.pp ? window.pp.openHtml(file, title) : false),
    showFolder: async (folder: string) => (window.pp ? window.pp.showFolder(folder) : false),
    async saveText(text: string, suggestedName: string) {
        if (window.pp) return window.pp.saveText(text, suggestedName);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
        a.download = suggestedName;
        a.click();
        return { ok: true, path: suggestedName };
    },
    writeTemp: async (name: string, text: string) => {
        if (!window.pp) throw new Error('Sem acesso a arquivos fora do app desktop.');
        return window.pp.writeTemp(name, text);
    },
    /** Reads a text file written by a job (dx maps, cavity points). */
    async readText(path: string): Promise<string> {
        const [r] = await this.readFiles([path]);
        if (!r?.ok || !r.bytes) throw new Error(r?.error ?? `Não foi possível ler ${path}`);
        return new TextDecoder().decode(r.bytes);
    },
    async savePng(dataUrl: string, suggestedName: string) {
        if (window.pp) return window.pp.savePng(dataUrl, suggestedName);
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = suggestedName;
        a.click();
        return { ok: true, path: suggestedName };
    },
};

const GPU_VENDORS: Record<number, string> = { 0x10de: 'NVIDIA', 0x8086: 'Intel', 0x1002: 'AMD' };

/**
 * "NVIDIA GeForce …" / "Intel …" for the status bar, from the renderer string of the
 * viewer's own WebGL context. A separate probe context must not be created: losing it
 * on purpose briefly took the viewer's context down too (ANGLE on EGL, PRIME offload),
 * and a 0×0 drawing buffer at that moment poisoned the camera with NaN.
 */
export function describeGpu(info: GpuInfo | null, renderer: string): string {
    if (renderer) {
        const m = /(NVIDIA[^,)]*|GeForce[^,)]*|Intel[^,)]*|AMD[^,)]*|Radeon[^,)]*)/i.exec(renderer);
        return (m?.[1] ?? renderer).replace(/\s+\(.*$/, '').trim();
    }
    const vendor = info?.active ? GPU_VENDORS[info.active.vendorId] : undefined;
    return vendor ?? 'GPU desconhecida';
}
