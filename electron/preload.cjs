/**
 * The only bridge between the sandboxed renderer and the main process. Keep this
 * surface small and typed in src/platform/bridge.ts.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pp', {
    openFiles: () => ipcRenderer.invoke('files:open'),
    openFolder: () => ipcRenderer.invoke('files:openFolder'),
    openDataset: () => ipcRenderer.invoke('files:openDataset'),
    scanDataset: (folder) => ipcRenderer.invoke('files:scanDataset', folder),
    expandPaths: (paths) => ipcRenderer.invoke('files:expandPaths', paths),
    readFiles: (paths) => ipcRenderer.invoke('files:read', paths),
    savePng: (dataUrl, suggestedName) => ipcRenderer.invoke('files:savePng', { dataUrl, suggestedName }),
    gpuInfo: () => ipcRenderer.invoke('app:gpuInfo'),
    // Movies: frames are piped to ffmpeg in the main process.
    movieChoose: (format, suggestedName) => ipcRenderer.invoke('movie:choose', { format, suggestedName }),
    movieStart: (opts) => ipcRenderer.invoke('movie:start', opts),
    movieFrame: (id, rgba) => ipcRenderer.invoke('movie:frame', { id, rgba }),
    movieFinish: (id, cancel) => ipcRenderer.invoke('movie:finish', { id, cancel }),
    // Compute core (ppcore): calls, job events, MHCXGraph dashboard window.
    core: (method, params) => ipcRenderer.invoke('core:call', { method, params }),
    onJob: (cb) => {
        const h = (_e, job) => cb(job);
        ipcRenderer.on('core:job', h);
        return () => ipcRenderer.removeListener('core:job', h);
    },
    onCoreDown: (cb) => {
        const h = (_e, err) => cb(err);
        ipcRenderer.on('core:down', h);
        return () => ipcRenderer.removeListener('core:down', h);
    },
    openHtml: (file, title) => ipcRenderer.invoke('core:openHtml', { file, title }),
    showFolder: (folder) => ipcRenderer.invoke('core:showFolder', folder),
    saveText: (text, suggestedName, filters) => ipcRenderer.invoke('files:saveText', { text, suggestedName, filters }),
    writeTemp: (name, text) => ipcRenderer.invoke('files:writeTemp', { name, text }),
    /** Drag-and-drop gives File objects; Electron resolves their real paths here. */
    pathForFile: (file) => webUtils.getPathForFile(file),
});
