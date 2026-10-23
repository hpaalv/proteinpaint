/**
 * Comparison block: superpose by one chain, measure another, and the Rosetta table.
 *   electron scripts/selftest7.cjs <out-dir>
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('../electron/ipc.cjs');
const { registerCore } = require('../electron/core.cjs');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
if (process.env.PP_GPU === 'nvidia') app.commandLine.appendSwitch('use-angle', 'gl-egl');

const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')));
fs.mkdirSync(outDir, { recursive: true });
const log = [];
let failed = false;
// Two designs on the same target: the case the compare tab exists for.
const A = '/home/paulo/Downloads/analises/na1_binder_9_model_7.cif';
const B = '/home/paulo/Downloads/7q15_mhc_complex.pdb';

async function main() {
    let win = null;
    registerIpc(() => win);
    registerCore(() => win);
    win = new BrowserWindow({
        x: 0, y: 0, width: 1700, height: 1050, show: true,
        webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !/Security|CONTEXT_LOST/.test(message)) log.push({ console: message.slice(0, 300) }); });
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { selftest: '1' } });
    const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    const shot = async (name, wait = 1200) => {
        await new Promise((r) => setTimeout(r, wait));
        fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    const step = async (name, code) => {
        const t0 = Date.now();
        try { log.push({ step: name, ok: true, ms: Date.now() - t0, value: await js(code) }); }
        catch (e) { failed = true; log.push({ step: name, ok: false, ms: Date.now() - t0, error: String(e) }); }
    };
    const pre = `const { E, useApp, viewer, actions } = window.__pp; const v = viewer();
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const S = () => useApp.getState().structures;`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    await step('load two complexes', `${pre} await actions.loadPaths([${JSON.stringify(A)}, ${JSON.stringify(B)}]); await wait(1200);
        return S().map((s) => s.name.slice(0, 22) + ': ' + s.chains.filter((c) => c.isPolymer).map((c) => c.authAsymId + '/' + c.role).join(','));`);
    await step('superpose by the target chain', `${pre}
        useApp.setState({ tab: 'compare' }); await wait(300);
        const ref = S()[0]; const other = S()[1];
        const r = await E.superposeChains(v, { structureId: ref.id, chain: 'B' }, [{ structureId: other.id, chain: 'A' }], 'structure');
        if (!r.ok) throw new Error(r.error);
        const rep = r.value[0];
        if (!rep.ok) throw new Error(rep.error);
        useApp.setState({ superposeReports: [rep.value] });
        return { rmsd: +rep.value.rmsd.toFixed(2), tm: rep.value.tmScore, pairs: rep.value.alignedPairs };`);
    await shot('00-superposed');
    await step('measure the binder chain after that fit', `${pre}
        const ref = S()[0]; const other = S()[1];
        const r = await E.measureChains(v, { structureId: ref.id, chain: 'A' }, [{ structureId: other.id, chain: 'C' }], 'structure');
        if (!r.ok) throw new Error(r.error);
        const d = r.value[0];
        return { rmsd: d.rmsd === null ? null : +d.rmsd.toFixed(2), max: d.maxDeviation === null ? null : +d.maxDeviation.toFixed(1), pairs: d.alignedPairs, note: d.note };`);
    await step('measuring the fit chain reproduces the fit RMSD', `${pre}
        const ref = S()[0]; const other = S()[1];
        const r = await E.measureChains(v, { structureId: ref.id, chain: 'B' }, [{ structureId: other.id, chain: 'A' }], 'structure');
        const d = r.ok ? r.value[0] : null;
        return { rmsd: d && d.rmsd !== null ? +d.rmsd.toFixed(2) : null };`);
    await step('reset puts the coordinates back', `${pre}
        for (const s of S()) await E.resetSuperposition(v, s.id); await wait(500);
        const ref = S()[0]; const other = S()[1];
        const r = await E.measureChains(v, { structureId: ref.id, chain: 'B' }, [{ structureId: other.id, chain: 'A' }], 'structure');
        return { rmsdAfterReset: r.ok && r.value[0].rmsd !== null ? +r.value[0].rmsd.toFixed(1) : null };`);
    await shot('01-reset');

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
