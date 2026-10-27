/**
 * Electron side of the compute core (backend/core.cjs): IPC for calls, job events
 * pushed to the window, the MHCXGraph dashboard window and a few file dialogs.
 */

const { app, ipcMain, BrowserWindow, shell, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createCore } = require('../backend/core.cjs');
const files = require('../backend/files.cjs');

/** @param {() => import('electron').BrowserWindow | null} getWindow */
function registerCore(getWindow) {
    function broadcast(channel, payload) {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }

    const core = createCore({
        onJob: (job) => broadcast('core:job', job),
        onReady: (limits) => broadcast('core:ready', limits),
        onDown: (error) => broadcast('core:down', error),
    });

    ipcMain.handle('core:call', (_e, { method, params }) => core.reply(method, params));

    // MHCXGraph's own dashboard (vis-network + 3Dmol + plotly), self-contained HTML.
    ipcMain.handle('core:openHtml', async (_e, { file, title }) => {
        const w = new BrowserWindow({
            width: 1500,
            height: 950,
            title: title || 'MHCXGraph',
            autoHideMenuBar: true,
            backgroundColor: '#050507',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        w.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/.test(url)) void shell.openExternal(url);
            return { action: 'deny' };
        });
        await w.loadFile(file);
        return true;
    });

    ipcMain.handle('core:showFolder', async (_e, folder) => {
        await shell.openPath(folder);
        return true;
    });

    ipcMain.handle('files:saveText', async (_e, { text, suggestedName, filters }) => {
        const res = await dialog.showSaveDialog(getWindow(), {
            defaultPath: path.join(app.getPath('documents'), suggestedName || 'tabela.csv'),
            filters: filters || [{ name: 'CSV', extensions: ['csv'] }],
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        await fs.writeFile(res.filePath, text, 'utf8');
        return { ok: true, path: res.filePath };
    });

    ipcMain.handle('files:writeTemp', (_e, { name, text }) => files.writeTemp(path.join(app.getPath('temp'), 'proteinpaint'), name, text));

    app.on('before-quit', () => core.stop());
}

module.exports = { registerCore };
