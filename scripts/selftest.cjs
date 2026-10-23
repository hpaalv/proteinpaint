/**
 * End-to-end check of the built app in a real Electron window (real GPU):
 *   electron scripts/selftest.cjs <out-dir> <structure-file>...
 * Loads each file, exercises the engine through the UI's own action layer and saves
 * screenshots + a JSON log to <out-dir>. Exit code 1 on any failed step.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('../electron/ipc.cjs');
const { registerCore } = require('../electron/core.cjs');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
// ANGLE on EGL: the only backend on which PRIME offload to NVIDIA works (see scripts/launch.sh).
if (process.env.PP_GPU === 'nvidia') app.commandLine.appendSwitch('use-angle', 'gl-egl');
app.commandLine.appendSwitch('force_high_performance_gpu');

const [outDir, ...files] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
fs.mkdirSync(outDir, { recursive: true });
const log = [];
let failed = false;

async function main() {
    const win = new BrowserWindow({
        // Pinned to the built-in panel: this machine's primary display is an
        // external monitor driven through PRIME, and cycling GPU windows on that
        // output froze its image (docs/STATUS.md).
        x: 0, y: 0, width: 1600, height: 1000, show: true,
        webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    registerIpc(() => win);
    registerCore(() => win);
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !/Security|CONTEXT_LOST/.test(message)) log.push({ console: message }); });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { selftest: '1', transparency: process.env.PP_TRANSPARENCY || '', ...(process.env.PP_ENGINE_DEBUG ? { engineDebug: '1' } : {}) } });
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const shot = async (name) => {
        await new Promise((r) => setTimeout(r, 900));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
        // The canvas's own drawing buffer (Mol* keeps preserveDrawingBuffer on): tells a
        // scene problem apart from a window-capture problem.
        log.push({ shot: name, state: await js('const c = window.__pp.viewer().canvas3d; const s = c.camera.state; return { pos: Array.from(s.position), target: Array.from(s.target), radius: s.radius, vp: c.camera.viewport, drs: c.webgl.getDrawingBufferSize(), reprs: c.reprCount.value, bs: c.boundingSphereVisible.radius, lost: c.webgl.isContextLost }') });
        const url = await js('return document.querySelector("canvas").toDataURL("image/png")');
        fs.writeFileSync(path.join(outDir, `${name}-canvas.png`), Buffer.from(url.split(',')[1], 'base64'));
    };
    const step = async (name, code) => {
        const t0 = Date.now();
        try {
            const value = await js(code);
            log.push({ step: name, ok: true, ms: Date.now() - t0, value });
        } catch (e) {
            failed = true;
            log.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e) });
        }
    };

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); const s = window.__pp.useApp.getState(); if (!s.ready) throw new Error(s.initError || 'not ready'); return s.gpu;`);

    for (const f of files) {
        const b64 = fs.readFileSync(f).toString('base64');
        await step(`load ${path.basename(f)}`, `
            const { E, viewer, useApp } = window.__pp;
            const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
            const r = await E.loadBytes(viewer(), bytes, { name: ${JSON.stringify(path.basename(f))}, source: 'file', path: ${JSON.stringify(f)} });
            if (!r.ok) throw new Error(r.error);
            return { chains: r.value.chains.filter(c => c.isPolymer).map(c => c.authAsymId + ':' + c.role + ':' + c.residueCount), plddt: r.value.looksLikePlddt, models: r.value.modelCount };
        `);
    }
    await shot('01-loaded');

    const first = `const { E, viewer, useApp } = window.__pp; const v = viewer(); const s = useApp.getState().structures[0];`;
    await step('spec /B:30-45', `${first} const r = await E.selectBySpec(v, ':1-20'); if (!r.ok) throw new Error(r.error); return { atoms: r.value, summary: E.selectionSummary(v) };`);
    await step('sticks on selection', `${first} const r = await E.setLayer(v, { kind: 'selection' }, 'atoms', { layer: 'atoms', style: 'sticks', size: 1 }); if (!r.ok) throw new Error(r.error); return E.layerSummary(v, s.id);`);
    await step('paint selection', `${first} const r = await E.colorTarget(v, { kind: 'selection' }, 0xF72585); if (!r.ok) throw new Error(r.error); E.clearSelection(v); return true;`);
    await step('interface', `${first}
        const poly = s.chains.filter(c => c.isPolymer);
        const a = poly.filter(c => c.role === 'binder').map(c => c.authAsymId);
        const A = a.length ? a : [poly[0].authAsymId];
        const B = poly.map(c => c.authAsymId).filter(c => !A.includes(c));
        const r = await E.analyzeInterface(v, { structureId: s.id, chains: A }, { structureId: s.id, chains: B });
        if (!r.ok) throw new Error(r.error);
        const d = await E.showInteractions(v, r.value, new Set(['hydrogen-bond','salt-bridge','pi-stacking','cation-pi','halogen-bond','metal']));
        if (!d.ok) throw new Error(d.error);
        const kinds = {}; for (const x of r.value.interactions) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
        return { A, B, resA: r.value.residuesA.length, resB: r.value.residuesB.length, atomPairs: r.value.atomContacts, kinds };`);
    await step('target surface', `${first}
        const targets = s.chains.filter(c => c.isPolymer && c.role !== 'binder');
        for (const c of targets) { const r = await E.setLayer(v, { kind: 'chain', id: s.id, chain: c.authAsymId }, 'surface', { layer: 'surface', style: 'molecular', opacity: 0.5 }); if (!r.ok) throw new Error(r.error); }
        return E.layerSummary(v, s.id);`);
    await shot('02-interface-surface');
    await step('look chimerax-soft (white)', `${first} await E.applyLookPreset(v, 'chimerax-soft', 0); const l = E.getLook(v); return { outline: l.outline, bg: l.background.a };`);
    await shot('03-chimerax-figure');
    await step('b-factor scheme', `${first} const r = await E.setColorSettings(v, s.id, { scheme: 'b-factor', ramp: 'viridis' }); if (!r.ok) throw new Error(r.error); return true;`);
    await step('role scheme', `${first} const r = await E.setColorSettings(v, s.id, { scheme: 'role' }); if (!r.ok) throw new Error(r.error); return true;`);
    await shot('04-role');
    await step('export png', `${first} const r = await E.renderImage(v, { width: 2000, transparent: true, cropToMolecule: true }); if (!r.ok) throw new Error(r.error); window.__lastExport = r.value.dataUrl; return { w: r.value.width, h: r.value.height, kb: Math.round(r.value.dataUrl.length * 0.75 / 1024) };`);
    {
        const url = await js('return window.__lastExport || ""');
        if (url) fs.writeFileSync(path.join(outDir, 'export.png'), Buffer.from(url.split(',')[1], 'base64'));
    }
    if (files.length > 1) {
        await step('superpose', `${first}
            const all = useApp.getState().structures;
            const ref = { structureId: all[0].id, chain: all[0].chains.find(c => c.isPolymer).authAsymId };
            const mob = all.slice(1).map(x => ({ structureId: x.id, chain: x.chains.find(c => c.isPolymer).authAsymId }));
            const r = await E.superposeChains(v, ref, mob, 'structure');
            if (!r.ok) throw new Error(r.error);
            return r.value.map(x => x.ok ? { rmsd: x.value.rmsd.toFixed(2), tm: x.value.tmScore?.toFixed(3), n: x.value.alignedPairs } : x.error);`);
        await shot('05-superposed');
    }
    const folder = process.env.PP_TEST_FOLDER;
    if (folder) {
        await step('library browse', `
            const { actions, useApp } = window.__pp;
            const files = await window.pp.expandPaths([${JSON.stringify(folder)}]);
            useApp.setState({ library: { folder: ${JSON.stringify(folder)}, files, current: null, browseId: null } });
            const before = useApp.getState().structures.length;
            const t0 = performance.now();
            await actions.browseTo(files[0]);
            await actions.browseStep(1);
            await actions.browseStep(1);
            const s = useApp.getState();
            return { files: files.length, before, after: s.structures.length, current: s.library.current.split('/').pop(), msPerStep: Math.round((performance.now() - t0) / 3) };`);
        await shot('06-browse');
    }
    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
