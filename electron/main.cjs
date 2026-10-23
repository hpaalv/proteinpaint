/**
 * Electron main process.
 *
 * Owns everything the renderer should not block on: file-system access, gunzip and
 * folder scans run here (Node's native zlib, off the UI thread), and later the
 * Python compute sidecar (docs/PLAN.md, Fase 2). The renderer only renders.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const { registerIpc } = require('./ipc.cjs');
const { registerCore } = require('./core.cjs');

// ---------------------------------------------------------------------------
// GPU: the molecular renderer is the hot path. Chromium blocklists some Linux
// driver combinations and would silently fall back to SwiftShader (CPU); we always
// want the real GPU. Discrete-GPU selection on hybrid laptops is done by the launch
// script (PRIME offload env), which has to be set before the process starts.
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// ANGLE on EGL: the only backend on which PRIME offload to NVIDIA works (see scripts/launch.sh).
if (process.env.PP_GPU === 'nvidia') app.commandLine.appendSwitch('use-angle', 'gl-egl');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');
// A molecule viewer left in the background (e.g. rendering a figure) must not be throttled.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const DEV_URL = process.env.PP_DEV_URL;

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
    win = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#0B0E14',
        title: 'ProteinPaint',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });

    win.once('ready-to-show', () => win?.show());

    // External links open in the browser; the app window never navigates away.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (DEV_URL && url.startsWith(DEV_URL)) return;
        event.preventDefault();
    });

    if (DEV_URL) void win.loadURL(DEV_URL);
    else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

    if (process.env.PP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

registerIpc(() => win);
registerCore(() => win);

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
