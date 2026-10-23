/**
 * Interface block: atoms of the interactions, per-chain ratios and the Rosetta
 * protocol (FastRelax + InterfaceAnalyzer) on one and on two structures.
 *   electron scripts/selftest6.cjs <out-dir>
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
const DESIGN = '/home/paulo/Downloads/analises/na1_binder_9_model_7.cif';
const HLA = '/home/paulo/Downloads/1a1m_mhc_all.pdb';

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
    const pre = `const { E, useApp, viewer, actions, protocol } = window.__pp; const v = viewer();
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const S = () => useApp.getState().structures;
        const design = () => S().find((s) => s.name.startsWith('na1'));
        const ixAtoms = () => { let n = 0; v.plugin.state.data.cells.forEach((c) => {
            if (c.transform.tags && c.transform.tags.includes('pp-interaction-atoms') && c.obj && c.obj.data && c.obj.data.elementCount) n += c.obj.data.elementCount; }); return n; };`;

    await step('ready', `for (let i = 0; i < 100 && !window.__pp.useApp.getState().ready; i++) await new Promise(r => setTimeout(r, 100)); return window.__pp.useApp.getState().gpu;`);
    await step('load design', `${pre} await actions.loadPaths([${JSON.stringify(DESIGN)}]); await wait(800); return design().chains.map((c) => c.authAsymId + ':' + c.role).join(' ');`);
    await step('analyse interface', `${pre}
        const s = design();
        const r = await E.analyzeInterface(v, { structureId: s.id, chains: ['A'] }, { structureId: s.id, chains: ['B', 'C'] }, E.DEFAULT_CONTACTS);
        if (!r.ok) throw new Error(r.error);
        useApp.setState({ interfaceReport: r.value });
        window.__report = r.value;
        return { resA: r.value.residuesA.length, resB: r.value.residuesB.length, interactions: r.value.interactions.length };`);
    await step('interaction atoms appear', `${pre}
        const kinds = new Set(useApp.getState().interactionKinds);
        await E.showInteractions(v, window.__report, kinds);
        const r = await E.showInteractionAtoms(v, window.__report, kinds); if (!r.ok) throw new Error(r.error);
        await wait(600); return { atoms: ixAtoms(), kinds: [...kinds].length };`);
    await shot('00-interaction-atoms');
    await step('untick H-bonds → fewer atoms', `${pre}
        const kinds = new Set(useApp.getState().interactionKinds.filter((k) => k !== 'hydrogen-bond'));
        await E.showInteractions(v, window.__report, kinds);
        await E.showInteractionAtoms(v, window.__report, kinds); await wait(500);
        return { atoms: ixAtoms() };`);
    await step('hide interactions clears the atoms', `${pre} await E.hideInteractions(v); await wait(400); return { atoms: ixAtoms() };`);
    await step('per-chain ratios', `${pre}
        const per = E.contactsPerChain(window.__report, 'B');
        const pep = per.find((c) => c.chain === 'C'); const mhc = per.find((c) => c.chain === 'B');
        return { chains: per.map((c) => c.chain + ':' + c.atoms), ratio: pep && mhc ? +(pep.atoms / mhc.atoms).toFixed(3) : null };`);

    await step('Rosetta protocol on one structure', `${pre}
        const s = design();
        const t0 = performance.now();
        await protocol.runInterfaceProtocol([s.id], { ...protocol.PROTOCOL_DEFAULTS, repeats: 5, region: 'interface', sideA: ['A'], sideB: ['B', 'C'] });
        const run = protocol.useProtocol.getState().runs[s.id];
        return { stage: run.stage, error: run.error, seconds: Math.round((performance.now() - t0) / 1000),
                 dG: run.analysis && run.analysis.metrics ? run.analysis.metrics.dG_separated : null,
                 sc: run.analysis && run.analysis.metrics ? run.analysis.metrics.sc_value : null,
                 rmsd: run.relax ? run.relax.ca_rmsd : null, hbonds: run.analysis ? run.analysis.hbonds.length : null };`);
    await shot('01-protocol-done', 1500);
    await step('second run hits the cache', `${pre}
        const s = design(); const t0 = performance.now();
        await protocol.runInterfaceProtocol([s.id], { ...protocol.PROTOCOL_DEFAULTS, repeats: 5, region: 'interface', sideA: ['A'], sideB: ['B', 'C'] });
        return { stage: protocol.useProtocol.getState().runs[s.id].stage, ms: Math.round(performance.now() - t0) };`);

    await step('two structures, same chains', `${pre}
        await actions.loadPaths([${JSON.stringify(HLA)}]); await wait(900);
        const ids = S().map((s) => s.id);
        await protocol.runInterfaceProtocol(ids, { ...protocol.PROTOCOL_DEFAULTS, repeats: 1, region: 'interface', skipRelax: true, sideA: ['A'], sideB: ['B', 'C'] });
        const runs = protocol.useProtocol.getState().runs;
        return Object.values(runs).map((r) => ({ name: r.name.slice(0, 24), stage: r.stage, dG: r.analysis && r.analysis.metrics ? Math.round(r.analysis.metrics.dG_separated) : null, err: r.error && r.error.slice(0, 60) }));`);
    await shot('02-two-structures', 1500);

    fs.writeFileSync(path.join(outDir, 'log.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
    app.exit(failed ? 1 : 0);
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(2); });
