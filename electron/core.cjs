/**
 * Bridge to the Python compute core (ppcore/server.py).
 *
 * The server runs on the app's own venv (.pyenv, Python 3.11: MHCXGraph,
 * pyKVFinder); it launches per-job workers on that venv or on the PyRosetta env
 * (SE3nv). One server per app instance, started on first use and killed with the
 * app, so no stray Rosetta process outlives the window.
 */

const { app, ipcMain, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PP_APP_PYTHON || path.join(ROOT, '.pyenv', 'bin', 'python');

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
let nextId = 1;
/** @type {Map<number, {resolve: (v: unknown) => void, reject: (e: Error) => void}>} */
const pending = new Map();
/** @type {() => import('electron').BrowserWindow | null} */
let getWindow = () => null;
let serverError = null;

function broadcast(channel, payload) {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function start() {
    if (server) return;
    serverError = null;
    server = spawn(PYTHON, ['-u', '-m', 'ppcore.server'], {
        cwd: ROOT,
        env: { ...process.env, PYTHONPATH: ROOT, PYTHONUNBUFFERED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: server.stdout });
    rl.on('line', (line) => {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error));
            else p.resolve(msg.result);
        } else if (msg.event === 'job') {
            broadcast('core:job', msg.job);
        } else if (msg.event === 'ready') {
            broadcast('core:ready', msg.limits);
        }
    });
    let stderr = '';
    server.stderr.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-4000);
    });
    server.on('exit', (code) => {
        serverError = code ? `O núcleo de cálculo saiu com código ${code}.\n${stderr}` : null;
        for (const p of pending.values()) p.reject(new Error(serverError || 'Núcleo de cálculo encerrado.'));
        pending.clear();
        server = null;
        broadcast('core:down', serverError);
    });
    server.on('error', (e) => {
        serverError = `Não foi possível iniciar o Python do app (${PYTHON}): ${e.message}`;
    });
}

function call(method, params) {
    start();
    return new Promise((resolve, reject) => {
        if (!server || !server.stdin.writable) return reject(new Error(serverError || 'Núcleo de cálculo indisponível.'));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        server.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
}

/** @param {() => import('electron').BrowserWindow | null} win */
function registerCore(win) {
    getWindow = win;

    ipcMain.handle('core:call', async (_e, { method, params }) => {
        try {
            return { ok: true, value: await call(method, params) };
        } catch (e) {
            return { ok: false, error: String(e && e.message ? e.message : e) };
        }
    });

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

    // Structures that exist only in memory (fetched from RCSB) are written here so the
    // Python tools can read them.
    ipcMain.handle('files:writeTemp', async (_e, { name, text }) => {
        const dir = path.join(app.getPath('temp'), 'proteinpaint');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, name.replace(/[^A-Za-z0-9_.-]/g, '_'));
        await fs.writeFile(file, text, 'utf8');
        return file;
    });

    app.on('before-quit', () => {
        if (server) server.kill('SIGTERM');
    });
}

module.exports = { registerCore };
