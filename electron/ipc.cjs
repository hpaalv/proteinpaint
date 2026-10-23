/**
 * IPC handlers of the main process: file access (read + native gunzip off the UI
 * thread, folder scans), save dialogs and GPU info. Shared by main.cjs and the
 * end-to-end harness (scripts/selftest.cjs).
 */

const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');

const gunzip = promisify(zlib.gunzip);
const STRUCTURE_EXT = /\.(pdb|ent|cif|mmcif|bcif|pdbqt)(\.gz)?$/i;

/** @param {() => import('electron').BrowserWindow | null} getWin */
function registerIpc(getWin) {
/**
 * Reads one structure file and gunzips it here, so the renderer receives plain
 * bytes. Returns a transferable record; failures are reported per file so one bad
 * file in a folder of 500 designs does not abort the rest.
 */
async function readStructure(filePath) {
    try {
        let bytes = await fs.readFile(filePath);
        let name = path.basename(filePath);
        if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            bytes = await gunzip(bytes);
            name = name.replace(/\.gz$/i, '');
        }
        const stat = await fs.stat(filePath);
        return { ok: true, name, path: filePath, size: stat.size, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    } catch (e) {
        return { ok: false, name: path.basename(filePath), path: filePath, error: String(e && e.message ? e.message : e) };
    }
}

async function scanFolder(root, maxDepth = 4) {
    const out = [];
    async function walk(dir, depth) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth) await walk(full, depth + 1);
            } else if (STRUCTURE_EXT.test(entry.name)) {
                out.push(full);
            }
        }
    }
    await walk(root, 0);
    // Natural sort, so design_2 comes before design_10.
    return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Reads many files concurrently, capped so a huge folder does not exhaust file handles. */
async function readMany(paths, concurrency = 16) {
    const results = new Array(paths.length);
    let next = 0;
    async function worker() {
        while (next < paths.length) {
            const i = next++;
            results[i] = await readStructure(paths[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
    return results;
}

ipcMain.handle('files:open', async () => {
    if (!getWin()) return [];
    const res = await dialog.showOpenDialog(getWin(), {
        title: 'Abrir estruturas',
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Estruturas', extensions: ['pdb', 'ent', 'cif', 'mmcif', 'bcif', 'gz'] },
            { name: 'Todos', extensions: ['*'] },
        ],
    });
    if (res.canceled) return [];
    return readMany(res.filePaths);
});

ipcMain.handle('files:openFolder', async () => {
    if (!getWin()) return { folder: null, files: [] };
    const res = await dialog.showOpenDialog(getWin(), { title: 'Abrir pasta de designs', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { folder: null, files: [] };
    const folder = res.filePaths[0];
    return { folder, files: await scanFolder(folder) };
});

/** Paths dropped onto the window: folders are expanded, files read as-is. */
ipcMain.handle('files:expandPaths', async (_e, paths) => {
    const files = [];
    for (const p of paths) {
        try {
            const stat = await fs.stat(p);
            if (stat.isDirectory()) files.push(...(await scanFolder(p)));
            else files.push(p);
        } catch {
            files.push(p);
        }
    }
    return files;
});

ipcMain.handle('files:read', async (_e, paths) => readMany(paths));

ipcMain.handle('files:savePng', async (_e, { dataUrl, suggestedName }) => {
    if (!getWin()) return { ok: false, error: 'Sem janela.' };
    const res = await dialog.showSaveDialog(getWin(), {
        title: 'Salvar imagem',
        defaultPath: path.join(app.getPath('pictures'), suggestedName || 'proteinpaint.png'),
        filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    await fs.writeFile(res.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, path: res.filePath };
});

ipcMain.handle('app:gpuInfo', async () => {
    try {
        const info = await app.getGPUInfo('basic');
        const devices = (info && info.gpuDevice) || [];
        const active = devices.find((d) => d.active) || devices[0];
        return { status: app.getGPUFeatureStatus(), active: active || null, devices };
    } catch (e) {
        return { status: app.getGPUFeatureStatus(), active: null, devices: [], error: String(e) };
    }
});

// ---------------------------------------------------------------------------
// Movies: raw RGBA frames from the renderer are piped into ffmpeg's stdin, so no
// intermediate PNG is encoded per frame and memory holds one frame at a time.
// ---------------------------------------------------------------------------

const MOVIE_FORMATS = {
    mp4: { ext: 'mp4', name: 'Vídeo MP4 (H.264)' },
    webm: { ext: 'webm', name: 'Vídeo WebM (VP9, com transparência)' },
    gif: { ext: 'gif', name: 'GIF animado' },
    apng: { ext: 'png', name: 'PNG animado (APNG)' },
    frames: { ext: '', name: 'Sequência de PNG' },
};

function ffmpegArgs(format, output, { width, height, fps }) {
    const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0'];
    switch (format) {
        case 'mp4':
            // yuv420p + faststart: plays in PowerPoint, browsers and on phones.
            return [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output];
        case 'webm':
            return [...input, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '24', '-row-mt', '1', '-auto-alt-ref', '0', output];
        case 'gif':
            // Palette from the whole clip, error diffusion, transparent where alpha is.
            return [
                ...input,
                '-filter_complex',
                'split[a][b];[a]palettegen=stats_mode=diff:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=128',
                '-loop', '0', output,
            ];
        case 'apng':
            return [...input, '-c:v', 'apng', '-pix_fmt', 'rgba', '-plays', '0', '-f', 'apng', output];
        case 'frames':
            return [...input, '-c:v', 'png', '-pix_fmt', 'rgba', '-start_number', '0', path.join(output, 'frame_%04d.png')];
        default:
            throw new Error(`Formato desconhecido: ${format}`);
    }
}

const movies = new Map();
let movieSeq = 0;

ipcMain.handle('movie:choose', async (_e, { format, suggestedName }) => {
    const win = getWin();
    if (!win) return null;
    const spec = MOVIE_FORMATS[format];
    if (!spec) return null;
    if (format === 'frames') {
        const res = await dialog.showOpenDialog(win, { title: 'Pasta para os quadros', properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('videos') });
        return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    }
    const res = await dialog.showSaveDialog(win, {
        title: 'Salvar animação',
        defaultPath: path.join(app.getPath('videos'), `${suggestedName}.${spec.ext}`),
        filters: [{ name: spec.name, extensions: [spec.ext] }],
    });
    return res.canceled || !res.filePath ? null : res.filePath;
});

ipcMain.handle('movie:start', async (_e, { format, output, width, height, fps }) => {
    const id = ++movieSeq;
    let proc;
    try {
        proc = spawn('ffmpeg', ffmpegArgs(format, output, { width, height, fps }), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
        return { ok: false, error: `ffmpeg não pôde ser iniciado: ${e.message || e}` };
    }
    const movie = { proc, stderr: '', exited: null, output };
    movie.exited = new Promise((resolve) => {
        proc.on('error', (e) => {
            movie.stderr += String(e.message || e);
            resolve(-1);
        });
        proc.on('close', (code) => resolve(code));
    });
    proc.stderr.on('data', (d) => (movie.stderr = (movie.stderr + d).slice(-4000)));
    // A closed pipe (ffmpeg died) must not crash the main process.
    proc.stdin.on('error', () => {});
    movies.set(id, movie);
    return { ok: true, value: id };
});

ipcMain.handle('movie:frame', async (_e, { id, rgba }) => {
    const movie = movies.get(id);
    if (!movie) return { ok: false, error: 'Vídeo não iniciado.' };
    const buffer = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    if (!movie.proc.stdin.writable) return { ok: false, error: movie.stderr || 'O ffmpeg encerrou.' };
    // Backpressure: wait for ffmpeg to drain before accepting the next frame.
    if (!movie.proc.stdin.write(buffer)) await new Promise((resolve) => movie.proc.stdin.once('drain', resolve));
    return { ok: true, value: true };
});

ipcMain.handle('movie:finish', async (_e, { id, cancel }) => {
    const movie = movies.get(id);
    if (!movie) return { ok: false, error: 'Vídeo não iniciado.' };
    movies.delete(id);
    if (cancel) movie.proc.kill('SIGKILL');
    else movie.proc.stdin.end();
    const code = await movie.exited;
    if (cancel) {
        await fs.rm(movie.output, { force: true }).catch(() => {});
        return { ok: true, value: null };
    }
    return code === 0 ? { ok: true, value: movie.output } : { ok: false, error: movie.stderr.trim() || `ffmpeg saiu com código ${code}` };
});

ipcMain.handle('files:openDataset', async () => {
    const win = getWin();
    if (!win) return { folder: null, structures: [], tables: [], docs: [] };
    const res = await dialog.showOpenDialog(win, { title: 'Abrir pasta de análise (estruturas + metadados)', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { folder: null, structures: [], tables: [], docs: [] };
    return scanDataset(res.filePaths[0]);
});

/** Same scan for a folder already known (drag and drop, reopen). */
ipcMain.handle('files:scanDataset', async (_e, folder) => scanDataset(folder));

const TABLE_EXT = /\.(csv|tsv|txt)$/i;
const DOC_EXT = /\.(md|rst)$/i;

/** Structures and tables of a dataset folder, in one walk. */
async function scanDataset(root) {
    const structures = [];
    const tables = [];
    const docs = [];
    async function walk(dir, depth) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < 4) await walk(full, depth + 1);
            } else if (STRUCTURE_EXT.test(entry.name)) {
                structures.push(full);
            } else if (TABLE_EXT.test(entry.name)) {
                const stat = await fs.stat(full).catch(() => null);
                // A 200 MB text file is not a metadata table; keep the dialog responsive.
                if (stat && stat.size < 64 * 1024 * 1024) tables.push({ path: full, size: stat.size });
            } else if (DOC_EXT.test(entry.name)) {
                docs.push(full);
            }
        }
    }
    await walk(root, 0);
    structures.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { folder: root, structures, tables, docs };
}

}

module.exports = { registerIpc, STRUCTURE_EXT };
