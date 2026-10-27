/**
 * IPC handlers of the main process: native dialogs around the shared file and movie
 * code (backend/), and GPU info. Shared by main.cjs and the end-to-end harness
 * (scripts/selftest.cjs).
 */

const { app, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const files = require('../backend/files.cjs');
const movie = require('../backend/movie.cjs');

/** @param {() => import('electron').BrowserWindow | null} getWin */
function registerIpc(getWin) {
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
        return files.readMany(res.filePaths);
    });

    ipcMain.handle('files:openFolder', async () => {
        if (!getWin()) return { folder: null, files: [] };
        const res = await dialog.showOpenDialog(getWin(), { title: 'Abrir pasta de designs', properties: ['openDirectory'] });
        if (res.canceled || !res.filePaths[0]) return { folder: null, files: [] };
        const folder = res.filePaths[0];
        return { folder, files: await files.scanFolder(folder) };
    });

    ipcMain.handle('files:expandPaths', (_e, paths) => files.expandPaths(paths));

    ipcMain.handle('files:read', (_e, paths) => files.readMany(paths));

    ipcMain.handle('files:savePng', async (_e, { dataUrl, suggestedName }) => {
        if (!getWin()) return { ok: false, error: 'Sem janela.' };
        const res = await dialog.showSaveDialog(getWin(), {
            title: 'Salvar imagem',
            defaultPath: path.join(app.getPath('pictures'), suggestedName || 'proteinpaint.png'),
            filters: [{ name: 'PNG', extensions: ['png'] }],
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        await fs.writeFile(res.filePath, files.pngBytes(dataUrl));
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

    ipcMain.handle('movie:choose', async (_e, { format, suggestedName }) => {
        const win = getWin();
        if (!win) return null;
        const spec = movie.MOVIE_FORMATS[format];
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

    ipcMain.handle('movie:start', (_e, opts) => movie.movieStart(opts));

    ipcMain.handle('movie:frame', (_e, { id, rgba }) => movie.movieFrame(id, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)));

    ipcMain.handle('movie:finish', (_e, { id, cancel }) => movie.movieFinish(id, cancel));

    ipcMain.handle('files:openDataset', async () => {
        const win = getWin();
        if (!win) return { folder: null, structures: [], tables: [], docs: [] };
        const res = await dialog.showOpenDialog(win, { title: 'Abrir pasta de análise (estruturas + metadados)', properties: ['openDirectory'] });
        if (res.canceled || !res.filePaths[0]) return { folder: null, structures: [], tables: [], docs: [] };
        return files.scanDataset(res.filePaths[0]);
    });

    /** Same scan for a folder already known (drag and drop, reopen). */
    ipcMain.handle('files:scanDataset', (_e, folder) => files.scanDataset(folder));
}

module.exports = { registerIpc, STRUCTURE_EXT: files.STRUCTURE_EXT };
